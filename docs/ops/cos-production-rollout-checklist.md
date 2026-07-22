# SRVF API — 腾讯云 COS 生产上线 SOP

> **性质**：新系统首次生产接入的可执行运维清单。当前事实以代码、运行时 `/api/docs-json`、[`storage/CLAUDE.md`](../../src/modules/storage/CLAUDE.md) 为准。
> **安全边界**：真实 bucket、域名、数据库 URL、SecretId、SecretKey 和 encryption key 永不写入仓库、PR、Issue、日志或截图。
> **验收边界**：仓库内自动化只能证明 DTO、权限、空库 bootstrap 和 test-app 行为；真实 COS PUT/HEAD/下载/删除必须在最终冻结镜像和真实私有桶上留现场证据，不能用 mock 或 LocalProvider 冒充。

---

## 0. 最终顺序（不得交换）

```text
migration
→ seed
→ 离线 storage-settings bootstrap（先 dry-run，后 create）
→ 用同一 STORAGE_ENCRYPTION_KEY 启动 APP_ENV=production
→ SUPER_ADMIN 登录
→ GET storage-settings
→ upload-url
→ COS PUT
→ confirm-upload（服务端内部 HEAD + 文件签名校验）
→ signed download
→ DELETE
```

production 启动会强制要求 `COS + bucket/region + 可解密凭证`。因此空库不能先启动应用再靠 HTTP PATCH 初始化；必须先走离线 bootstrap。`enabled=false` 是允许启动的紧急恢复态，但普通 Storage Effect 仍全部拒绝。

---

## 1. 角色、工具与占位符

### 1.1 角色

- `SUPER_ADMIN`：首次 seed、读取/更新 settings、同 key 下替换 COS 凭证。
- `ADMIN + ops-admin`：可 GET/PATCH 非凭证配置；不能调用 reset-credentials。
- 运维人员：准备私有 bucket、CAM 最小权限、CORS、versioning、lifecycle、SSE-COS、production env 和最终镜像。

### 1.2 工具

- `openssl`、`curl`、`jq`、PostgreSQL 客户端。
- 已构建的最终应用制品；制品内须包含 `dist/storage-settings-bootstrap.js`。
- 权限为 `0600` 或 `0400` 的临时 bootstrap JSON；用后安全销毁。

### 1.3 占位符

| 占位符                   | 含义                                          |
| ------------------------ | --------------------------------------------- |
| `<api-base-url>`         | 生产 API 基址，例如 `https://api.example.com` |
| `<your-production-db>`   | 明确确认的生产数据库名                        |
| `<your-bucket>`          | COS bucket 全名                               |
| `<your-region>`          | COS region，例如 `ap-shanghai`                |
| `<your-frontend-domain>` | 精确 HTTPS 前端 origin                        |
| `<super-admin-jwt>`      | SUPER_ADMIN access token                      |
| `<existing-member-id>`   | 专用测试 Member.id，不使用真实队员文件        |

---

## 2. COS 与 CAM 前置配置

### 2.1 Bucket

- ACL 必须为 private，禁止 public-read/public-read-write。
- region 与应用 settings 完全一致。
- 启用 versioning。
- 启用 SSE-COS / AES256；本版本不启用 SSE-KMS 或 SSE-C。
- lifecycle：非当前版本保留 30 天、不完整 multipart 7 天清理、过期 DeleteMarker 清理。
- key namespace 固定由服务端生成：
  `attachments/<envPrefix>/<yyyy>/<mm>/<dd>/<base64url-random>.<ext>`。

### 2.2 CAM 最小权限

子账号只允许目标 bucket 所需对象动作，资源限定到：

```text
qcs::cos:<your-region>:uid/<your-appid>:<your-bucket>/*
```

至少验证：

- 允许目标 bucket 的 PutObject/GetObject/DeleteObject/HeadObject。
- 拒绝其他 bucket。
- 拒绝 PutBucketAcl、全局 Resource `*` 与预设全权策略。

腾讯云 CAM 语法与 action 名必须在上线当天通过官方控制台/策略模拟器复核；仓库模板不是云侧事实证明。

### 2.3 CORS

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["<your-frontend-domain>"],
      "AllowedMethods": ["PUT", "GET", "HEAD"],
      "AllowedHeaders": ["Content-Type", "Content-MD5", "x-cos-*"],
      "ExposeHeaders": ["ETag", "x-cos-request-id"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

`AllowedOrigins` 必须是明确 HTTPS origin，禁止 `*`。浏览器端需实际验证 OPTIONS 与 PUT。

---

## 3. Encryption key 冻结

1. 在 secret manager 中生成并保存最终 `STORAGE_ENCRYPTION_KEY`（至少 32 字符，推荐 `openssl rand -base64 32`）。
2. 它必须与 JWT/SMS/WECHAT/REALNAME key 不同，且不能与数据库备份或 COS 凭证密文同存。
3. bootstrap、production API、worker、蓝绿新旧实例必须使用**同一值**。
4. 一旦任何密文写入数据库，禁止直接修改该 key。
5. 当前版本没有 key version、双 key 或离线重加密工具；reset-credentials 只会使用当前进程启动时缓存的 key，不能完成 key 轮换。

完整四-key 冻结与事故处置见 [`encryption-key-freeze.md`](encryption-key-freeze.md)。

---

## 4. 空库 migration、seed 与离线 bootstrap

### 4.1 Migration 与 seed

在已确认的生产数据库上由部署流程执行：

```bash
APP_ENV=production DATABASE_URL='<production-database-url>' pnpm prisma:deploy
APP_ENV=production DATABASE_URL='<production-database-url>' pnpm prisma:seed
```

seed 前必须提供非默认 `SUPER_ADMIN_USERNAME` / `SUPER_ADMIN_PASSWORD`；禁止 `admin` / `ChangeMe123456`。

### 4.2 创建 bootstrap 配置

用不会记录 history 的编辑器创建临时文件：

```bash
BOOTSTRAP_FILE=$(mktemp)
chmod 600 "$BOOTSTRAP_FILE"
$EDITOR "$BOOTSTRAP_FILE"
```

文件字段必须恰好来自下列白名单：

```json
{
  "databaseUrl": "<production-database-url>",
  "bucket": "<your-bucket>",
  "region": "<your-region>",
  "envPrefix": "prod",
  "secretId": "<your-secret-id>",
  "secretKey": "<your-secret-key>"
}
```

安全约束：

- 顶层未知字段直接拒绝。
- 仅 PostgreSQL、单一明确数据库、`public` schema。
- 文件不能有 group/other 权限。
- 命令只允许空 `storage_settings` 表，拒绝覆盖。
- stdout/stderr 不得出现 URL、凭证明文、密文。

### 4.3 先 dry-run（零写入）

```bash
APP_ENV=production \
STORAGE_ENCRYPTION_KEY='<from-secret-manager>' \
node dist/storage-settings-bootstrap \
  --config-file="$BOOTSTRAP_FILE" \
  --confirm-database='<your-production-db>' \
  --dry-run
```

期望摘要：

```json
{
  "mode": "dry-run",
  "rowCountBefore": 0,
  "created": false,
  "verified": true,
  "providerType": "COS",
  "enabled": true,
  "credentialConfigured": true
}
```

### 4.4 正式写入一次

确认 dry-run 的 database/host/schema 与发布票一致后，去掉 `--dry-run`：

```bash
APP_ENV=production \
STORAGE_ENCRYPTION_KEY='<from-secret-manager>' \
node dist/storage-settings-bootstrap \
  --config-file="$BOOTSTRAP_FILE" \
  --confirm-database='<your-production-db>'
```

期望：`mode=create`、`created=true`、`verified=true`。随后立即销毁临时文件，并清理本次 shell history；不得把命令输出连同真实目标信息贴到公共渠道。

### 4.5 SQL 只读复核

```sql
SELECT
  count(*) AS row_count,
  bool_and("enabled") AS all_enabled,
  min("providerType"::text) AS provider_type,
  min("bucket") AS bucket,
  min("region") AS region,
  bool_and("credentialConfigured") AS credentials_marked
FROM "storage_settings";
```

期望：恰好 1 行、enabled、COS、bucket/region 正确、`credentials_marked=true`。这只证明 DB 标记；真正可解密仍由下一步 production boot 证明。

---

## 5. Production boot、登录与 settings 验收

### 5.1 启动

最终 API 与所有 storage worker 必须注入 bootstrap 时的同一 `STORAGE_ENCRYPTION_KEY`，并以 `APP_ENV=production` 启动。不得用 `smoke` 或 `development` 连接生产库绕过 fail-fast。

验收锚点：

- 进程启动成功并通过 `/api/system/v1/health/ready`。
- 若 settings 缺失、非 COS、bucket/region 缺失或凭证无法解密，进程必须退出；不得临时放宽。disabled 时进程应 WARN 后启动控制面，普通 Effect 继续 fail-closed。
- 不依赖不存在的 crypto 初始化日志。

### 5.2 登录与 GET

```bash
curl -fsS -X POST '<api-base-url>/api/auth/v1/login' \
  -H 'Content-Type: application/json' \
  --data-binary @'<0600-login-body-file>'
```

取得 SUPER_ADMIN access token 后：

```bash
curl -fsS '<api-base-url>/api/system/v1/storage-settings' \
  -H 'Authorization: Bearer <super-admin-jwt>'
```

期望响应形状：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "providerType": "COS",
    "enabled": true,
    "bucket": "<your-bucket>",
    "region": "<your-region>",
    "envPrefix": "prod",
    "allowedMimePolicyMode": "INHERIT",
    "credentialStatus": "configured",
    "credentialConfigured": true
  }
}
```

响应绝不能出现 secret、encrypted credential 或完整 signed URL。

### 5.3 后续 PATCH 的当前字段

非凭证更新 fixture 在 [`fixtures/cos-production-storage-settings.json`](fixtures/cos-production-storage-settings.json)，并由真实 DTO/ValidationPipe 与 test app 自动验证。当前字段名是 `envPrefix` 与 `allowedMimePolicyMode`。

```bash
curl -fsS -X PATCH '<api-base-url>/api/system/v1/storage-settings' \
  -H 'Authorization: Bearer <super-admin-jwt>' \
  -H 'Content-Type: application/json' \
  --data-binary @docs/ops/fixtures/cos-production-storage-settings.json
```

生产 PATCH 合并后的配置仍强制 COS、非空 bucket/region 和可解密凭证；既有 singleton 的 providerType/bucket/region 不允许普通 PATCH 改变。`enabled=false` 是显式 kill switch，关闭后普通 storage effect fail-closed，API/worker 可重启并通过管理面恢复。

---

## 6. 同 key 下替换 COS 凭证

`POST /api/system/v1/storage-settings/reset-credentials` 是 **SUPER_ADMIN-only**。ADMIN 即使持有 ops-admin 也返回 HTTP 403 / `30100`。

它只用于在 `STORAGE_ENCRYPTION_KEY` 不变时替换 SecretId/SecretKey，不是 encryption-key 轮换工具。

```bash
CREDENTIAL_FILE=$(mktemp)
chmod 600 "$CREDENTIAL_FILE"
$EDITOR "$CREDENTIAL_FILE"

curl -fsS -X POST '<api-base-url>/api/system/v1/storage-settings/reset-credentials' \
  -H 'Authorization: Bearer <super-admin-jwt>' \
  -H 'Content-Type: application/json' \
  --data-binary @"$CREDENTIAL_FILE"
```

临时文件内容仅允许 `secretId`、`secretKey`。成功为 HTTP 201，响应示例：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "providerType": "COS",
    "credentialStatus": "configured",
    "credentialConfigured": true
  }
}
```

调用结束立即安全销毁临时文件。常见失败：

| HTTP / code   | 含义                                                |
| ------------- | --------------------------------------------------- |
| 401 / `40100` | JWT 无效或过期                                      |
| 403 / `30100` | 非 SUPER_ADMIN 或缺少 read/update 权限              |
| 400 / `40000` | DTO 字段、类型或白名单错误                          |
| 500 / `50000` | 加密/数据库内部失败；不得把底层错误或凭证返回客户端 |

---

## 7. 真实 COS 最小闭环

### 7.1 专用测试文件

使用无 PII 的最小有效 PNG，不使用真实队员资料：

```bash
TEST_FILE=$(mktemp --suffix=.png)
printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' \
  | openssl base64 -d -A > "$TEST_FILE"
TEST_SIZE=$(wc -c < "$TEST_FILE" | tr -d ' ')
```

### 7.2 申请 upload URL

```bash
curl -fsS -X POST '<api-base-url>/api/admin/v1/attachments/upload-url' \
  -H 'Authorization: Bearer <super-admin-jwt>' \
  -H 'Content-Type: application/json' \
  -d "{\"ownerType\":\"member\",\"ownerId\":\"<existing-member-id>\",\"originalName\":\"cos-smoke.png\",\"mime\":\"image/png\",\"sizeBytes\":$TEST_SIZE}"
```

期望 HTTP 201，`data` 恰含后端生成的 key、uploadUrl、uploadHeaders、uploadMethod、expiresAt、uploadToken。key 应匹配 `attachments/prod/yyyy/mm/dd/<random>.png`；不得固定具体随机值。

### 7.3 PUT

按 `uploadMethod` 和 `uploadHeaders` 原样上传：

```bash
curl -fsS -X PUT '<step-uploadUrl>' \
  -H 'Content-Type: image/png' \
  --data-binary @"$TEST_FILE" \
  -o /dev/null -w 'HTTP %{http_code}\n'
```

期望 COS HTTP 200，并在 COS 侧记录 request id。signed URL 与 request id 只进入受控 release ticket，不进公共日志。

### 7.4 Confirm（包含服务端 HEAD）

```bash
curl -fsS -X POST '<api-base-url>/api/admin/v1/attachments/confirm-upload' \
  -H 'Authorization: Bearer <super-admin-jwt>' \
  -H 'Content-Type: application/json' \
  -d '{"uploadToken":"<step-uploadToken>"}'
```

期望 HTTP 201。服务端会按 upload intent 的 pinned locator 执行 HEAD、校验 size 与文件签名，然后提交 Attachment/audit/ledger；Provider 不确定时必须返回 `13034`，不能假成功。

### 7.5 Signed download

使用 confirm 响应中的短 TTL `accessUrl` 下载并比对：

```bash
curl -fsS '<step-accessUrl>' -o /tmp/cos-smoke-download.png
cmp "$TEST_FILE" /tmp/cos-smoke-download.png
```

期望字节一致。响应、日志与 audit 不得留完整 signed URL。

### 7.6 DELETE

```bash
curl -fsS -X DELETE '<api-base-url>/api/admin/v1/attachments/<attachment-id>' \
  -H 'Authorization: Bearer <super-admin-jwt>'
```

期望 HTTP 200，并返回该次删除的 terminal Attachment representation。实现会先提交 delete intent，Provider DELETE 后以 HEAD absent 证明，再原子硬删 Attachment、写 audit 并完成 ledger；不确定态返回 `13034`。

随后验证：

- 同一附件普通 GET 返回 `13001`。
- COS 当前版本不可见；启用 versioning 时可见 DeleteMarker 与保留的旧版本。
- 数据库/Provider 任一失败都没有假成功。

清理本地临时文件与 shell 变量。

---

## 8. 失败与回退

| 场景                                 | 正确处置                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------- |
| bootstrap 目标/权限/字段校验失败     | 保持零写入，修正临时文件后重新 dry-run                                    |
| storage_settings 已存在              | 停止；命令拒绝覆盖，先由维护者审查现有行                                  |
| production boot 因 settings/解密失败 | 保持实例不接流；恢复同一冻结 key 或修复配置，不得改用 LOCAL/smoke 绕过    |
| COS 凭证错误                         | 保持 key 不变，由 SUPER_ADMIN 重做 §6                                     |
| encryption key 丢失/疑似泄露         | 按安全事件处理；当前版本没有安全的直接轮换路径，见 key freeze SOP         |
| Provider effect 不确定               | 保留 ledger/intent，按 storage consistency runbook 收敛；不得手工伪造成功 |

生产回退不允许切到容器本地 `./tmp/storage`；settings 丢失、LOCAL 或未知 provider 均 fail-closed。紧急停用使用 `enabled=false`，API/worker 重启后通过同一管理面恢复；bucket/region relocation 必须另立评审，不能使用普通 PATCH。

---

## 9. Release ticket 证据

- [ ] 最终 Git SHA、镜像 tag、镜像 digest。
- [ ] migration/seed 命令成功且目标库复核。
- [ ] bootstrap dry-run 与 create 的去敏摘要。
- [ ] production boot + readiness，证明当前 key 可解密。
- [ ] GET settings 去敏响应。
- [ ] upload-url → PUT → confirm 内部 HEAD → download → DELETE 全链 request/evidence。
- [ ] 私有 ACL、CAM 跨 bucket 拒绝、CORS、versioning、lifecycle、SSE-COS。
- [ ] response/log/audit 无 SecretId、SecretKey、密文和完整 signed URL。
- [ ] `STORAGE_ENCRYPTION_KEY` 已冻结并与所有承流实例一致。

没有真实腾讯云与最终部署环境证据时，只能写“代码/隔离测试已通过，真实 Provider 未验收”，不能标记 GO。
