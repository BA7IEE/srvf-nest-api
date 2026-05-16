# SRVF API — 腾讯云 COS 生产上线运维清单(C-7.5 Provider)

> **定位**:**运维 SOP**(操作清单 + 命令模板 + 验收锚点),用于 v0.11.0(C-7.5 Provider 全栈实施收口)之后,**队组织运维侧 + 维护者**协作把腾讯云 COS 真实接入生产链路。
> **本文件不是设计文档**:决议细节见 [`docs/批次7_provider选型_API前评审.md §6.4-§6.6`](../批次7_provider选型_API前评审.md);版本现状见 [`docs/handoff/v0.11.0.md §4-§7`](../handoff/v0.11.0.md)。本文件不重复决议背景,只给可执行步骤。
> **冲突优先级**:`ARCHITECTURE.md` > `CLAUDE.md` > `docs/V2红线与复活路径.md` > C-7.5 评审稿 > 本文件。本文件不覆盖任何铁律;若发现冲突,以上层为准并暂停。

---

## 0. 用法说明

### 0.1 谁在读

- **队组织运维侧**(主):腾讯云 COS bucket / IAM 子账号 / CORS / lifecycle / versioning / SSE-COS / 部署平台 env 注入(§2-§6)
- **系统维护者**(辅):后台 Storage Settings 初始化 + 凭证录入 + 闭环验收(§7-§9)

### 0.2 怎么读

- **按 § 顺序执行**(§1 → §9);不要跳步
- 每步含:**命令模板**(占位符标 `<your-...>`)+ **期望输出**(摘要)+ **失败回退**(指向 §10)
- **§11 安全禁止项**:**每一步执行前都必读**;违反任一项 = 红线破口

### 0.3 占位符约定

| 占位符 | 含义 | 示例(**仅说明,非真实**)|
|---|---|---|
| `<your-bucket>` | COS bucket 名(全局唯一)| `srvf-attachments-1234567890` |
| `<your-appid>` | 腾讯云 APPID(10-12 位数字)| `1234567890` |
| `<your-region>` | COS 区域代码 | `ap-shanghai` |
| `<your-frontend-domain>` | 前端域名(生产)| `https://app.example.com` |
| `<your-secret-id>` / `<your-secret-key>` | COS IAM 子账号 SecretId / SecretKey | — |
| `<base64-32-bytes>` | `STORAGE_ENCRYPTION_KEY` 值 | — |
| `<api-base-url>` | API 基址 | `https://api.example.com` |
| `<admin-jwt>` | 管理员 JWT(`SUPER_ADMIN` / `ADMIN`)| — |

**铁律**:**本文档 + 所有 PR / Issue / Slack / 日志中,占位符永不替换为真实值**(沿 §11)。

---

## 1. 前置门槛

### 1.1 系统侧已就位(必读)

| 项 | 实证命令 | 期望 |
|---|---|---|
| v0.11.0 已发布 | `gh release list --limit 3` | `v0.11.0 (Latest)` |
| 5 端点已就位 | `gh api repos/<owner>/<repo>/contents/test/contract/__snapshots__` | snapshot 含 `/api/v2/attachments/upload-url` + `/api/v2/attachments/confirm-upload` + `/api/v2/storage-settings` × 3 |
| `STORAGE_ENCRYPTION_KEY` 已支持 | `grep STORAGE_ENCRYPTION_KEY .env.example` | 存在 |
| Provider 路由 | `grep StorageProviderRouter src/common/storage/storage.module.ts` | 存在 |

### 1.2 运维侧准备

- 腾讯云账号(组织主账号 / 子账号管理权限)
- 腾讯云 CAM 访问权限(创建 IAM 子账号 + 编辑 Policy)
- 腾讯云 COS 访问权限(创建 bucket + 配置 versioning / lifecycle / CORS / SSE-COS)
- 部署平台访问权限(K8s / Docker / Systemd;注入 `STORAGE_ENCRYPTION_KEY`)
- 本地工具:`openssl`(生成加密 key)+ `curl` + `jq`(可选;美化输出)+ `gh` CLI(可选)

### 1.3 维护者准备

- 系统管理员账号(`SUPER_ADMIN` 或 `ADMIN`;用于调 storage-settings API)
- 管理员 JWT(通过 `POST /api/v2/auth/login` 获取)
- 本地 shell history 防留痕设置(沿 §8.2)

---

## 2. 腾讯云 COS bucket 创建

### 2.1 命名建议(沿 [评审稿 §6.4.3](../批次7_provider选型_API前评审.md))

| 维度 | 推荐 | 备注 |
|---|---|---|
| bucket 名 | `srvf-attachments-<your-appid>` | 腾讯云 COS 强制规则:bucket 名后缀含 APPID;**全局唯一** |
| region | `ap-shanghai` / `ap-guangzhou` / `ap-beijing` | 国内合规优先(沿 F3);**选距离队组织主要使用区域最近** |
| 数量 | **单 bucket + key 前缀环境隔离**(沿 Q18)| dev / test / prod 全部走 `attachments/<env>/...` 前缀 |
| 访问 | **私有桶**(`Bucket ACL = private`;沿 Q16)| **永不开放公有读** ⚠️ |
| 版本控制 | 启用(§5 配置)| 误删 30 天兜底 |

### 2.2 创建步骤(腾讯云 COS 控制台)

1. 登录腾讯云控制台 → 对象存储 COS → 存储桶列表 → 创建存储桶
2. **名称**:`srvf-attachments-<your-appid>`(自动追加 `-<APPID>` 后缀)
3. **地域**:选 `<your-region>`(建议 `ap-shanghai`)
4. **访问权限**:**私有读写**(强制;**禁止**选公有读)
5. **请求域名**:默认 `<your-bucket>.cos.<your-region>.myqcloud.com`
6. **服务端加密**:**SSE-COS / AES256**(详见 §5)
7. **版本控制**:**启用**(详见 §5)
8. 创建后:**复制 bucket 名 + region**,用于 §7 后台 Storage Settings 初始化

### 2.3 创建后校验

```bash
# 期望:bucket 存在 + ACL = private + versioning = Enabled + SSE = AES256
# (用腾讯云 CLI 或 COS Browser 工具验;此处不提供 SDK 命令)
```

**失败回退**:若 bucket 名冲突(全局唯一) → 改 APPID 后缀或换名 → 重新创建。

---

## 3. IAM 子账号 + 最小权限策略

> ⚠️ **本节 IAM Policy 是模板,不是绝对可直接生产使用**。腾讯云 CAM 策略语法、Resource 路径格式、action 命名会随时间演进;**生产前必须在腾讯云 CAM 控制台手动校验该 Policy 的语法 + 实际权限边界**(用 CAM 策略模拟器 + 子账号实测 + 跨 bucket 越权测试)。**禁止**直接复制本模板到生产环境而不二次校验。

### 3.1 创建 IAM 子账号

1. 腾讯云控制台 → 访问管理 CAM → 用户列表 → 新建用户 → 自定义创建
2. **用户名**:`srvf-api-cos-prod`(或类似可识别名)
3. **访问方式**:**仅 API 密钥**(SecretId + SecretKey);**禁止启用** "控制台登录" / "微信关联"
4. **不分配任何预设策略**;先创建空账号,§3.2 再绑定最小 Policy
5. 创建后下载 CSV(含 SecretId + SecretKey);**立即用密码管理器保存**,**永不**:
   - commit 进 git ⚠️
   - 贴入 PR / Issue / 任何文档 ⚠️
   - 贴入 Slack / 邮件 / 文档协作工具 ⚠️
   - 写入 shell history(沿 §8.2 防留痕)⚠️

### 3.2 最小权限 Policy 模板

**预期权限边界**:仅本 bucket 的 5 个 action(`PutObject` / `GetObject` / `DeleteObject` / `HeadObject` / `AbortMultipartUpload`)。

```json
{
  "version": "2.0",
  "statement": [
    {
      "effect": "allow",
      "action": [
        "cos:PutObject",
        "cos:GetObject",
        "cos:DeleteObject",
        "cos:HeadObject",
        "cos:AbortMultipartUpload"
      ],
      "resource": [
        "qcs::cos:<your-region>:uid/<your-appid>:<your-bucket>/*"
      ]
    }
  ]
}
```

**字段释义**:

| 字段 | 含义 | 注意 |
|---|---|---|
| `version` | CAM 策略语法版本(当前 `2.0`)| **生产前在 CAM 控制台校验语法是否仍为 2.0** |
| `effect: allow` | 允许 | **禁止 `*` 通配 effect** |
| `action` | 5 个 COS API 动作 | `AbortMultipartUpload` 见 §3.3 说明 |
| `resource` | `qcs::cos:<region>:uid/<APPID>:<bucket>/*` | **`/*` 限定 bucket 内对象;不要写 `*` 全局** |

### 3.3 关于 `cos:AbortMultipartUpload`

**当前系统(v1.0)不主动使用 multipart upload**(沿 C-7.5 v1.0 Q13 锁:单文件 ≤ 5GB 走 PUT signed URL;multipart 留 v1.1+ 评估)。

但本 Policy 仍包含 `cos:AbortMultipartUpload`,原因是 **§5 lifecycle 第 3 条规则**(`AbortIncompleteMultipartUpload`)需要此权限作**未来预留 / 防御性兜底**:

- **未来预留**:若未来启用 multipart,无需再次扩 Policy
- **防御性兜底**:即使当前不主动 multipart,若客户端被攻击者注入异常 multipart 请求,lifecycle 7 天 abort 能自动清理孤儿分片
- **本 Policy 包含此项 = 安全冗余**,不增加攻击面(`AbortMultipartUpload` 只能撤销分片,不能上传 / 读取)

### 3.4 绑定 Policy 到子账号

1. CAM 控制台 → 策略 → 新建自定义策略 → 按策略语法创建 → 粘贴上述 JSON
2. **生产前用 CAM 策略模拟器测试**:
   - ✅ 允许:本 bucket `PutObject` / `GetObject` / `DeleteObject` / `HeadObject`
   - ❌ 拒绝:其他 bucket 任意操作 / 本 bucket `ListObjects` / 本 bucket `PutBucketAcl`(防越权改桶 ACL)
3. 模拟器通过 → 策略关联到 §3.1 创建的子账号
4. 用子账号 SecretId / SecretKey 跑一次 §9.1 闭环验收的 PUT 测试,确认权限边界生效

### 3.5 子账号其他配置

- ✅ **启用 MFA**(多因素认证;CAM 控制台主账号操作)
- ✅ **启用登录保护**(异地登录告警)
- ❌ **禁止**绑定除本 Policy 外的任何预设策略(如 `QcloudCOSFullAccess` / `AdministratorAccess`)
- ❌ **禁止**给子账号开启 "控制台登录" 入口

---

## 4. CORS 规则

### 4.1 CORS JSON 模板(沿 [评审稿 §6.4.6](../批次7_provider选型_API前评审.md))

**生产 CORS**:

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

### 4.2 字段说明

| 字段 | 值 | 为什么 |
|---|---|---|
| `AllowedOrigins` | **生产域名白名单**(`https://app.example.com` 类) | ⚠️ **禁止 `*` 通配**;**禁止** `http://` 非 HTTPS 源 |
| `AllowedMethods` | `PUT`(上传)+ `GET`(下载)+ `HEAD`(headObject 校验)| **禁止开放 `POST` / `DELETE`**(沿 §6.4.1 私有桶 + signed URL) |
| `AllowedHeaders` | `Content-Type` 必填 + `Content-MD5` 可选 + COS 私有 `x-cos-*` | 客户端 PUT 时携带 |
| `ExposeHeaders` | `ETag`(confirm-upload 校验)+ `x-cos-request-id`(排障) | 让 JS fetch 能读到 |
| `MaxAgeSeconds` | `3600`(1 小时 preflight 缓存)| 减少 OPTIONS 请求 |

### 4.3 dev / test 环境 CORS(可选)

```json
{
  "AllowedOrigins": ["http://localhost:3000", "http://127.0.0.1:3000"],
  "AllowedMethods": ["PUT", "GET", "HEAD"],
  "AllowedHeaders": ["Content-Type", "Content-MD5", "x-cos-*"],
  "ExposeHeaders": ["ETag", "x-cos-request-id"],
  "MaxAgeSeconds": 60
}
```

**注**:dev / test bucket(若与 prod 不同 bucket)单独配置;若沿 Q18 单 bucket + key 前缀,**CORS 必须按生产严格度配置**,dev 走 LocalProvider 而非 COS(沿 [handoff §4.4](../handoff/v0.11.0.md))。

### 4.4 配置步骤

1. 腾讯云 COS 控制台 → 存储桶 → 跨域访问 CORS 设置 → 添加规则
2. 按 §4.1 模板填入(替换 `<your-frontend-domain>` 为真实生产域名)
3. 保存 → 立即生效
4. **校验**:浏览器 DevTools Network 标签发起 PUT preflight(OPTIONS)请求,确认响应头含 `Access-Control-Allow-Origin: <your-frontend-domain>`

### 4.5 多前端域名场景

若有多个前端(如 `app.example.com` + `admin.example.com`):
- `AllowedOrigins` 列出多个,**全部 HTTPS**;**永远不要**用 `*`
- 每个域名独立行;**禁止**通配 `https://*.example.com`(部分代理 / CDN 不识别;改用显式枚举)

---

## 5. lifecycle / versioning / SSE-COS

### 5.1 versioning(沿 [评审稿 §6.4.5](../批次7_provider选型_API前评审.md))

- **启用**:腾讯云 COS 控制台 → 存储桶 → 版本控制 → 开启
- **作用**:DELETE 操作只生成 DeleteMarker;真实对象保留 30 天(配合 §5.2 lifecycle 规则 1)
- **核验**:控制台显示 "版本控制:已开启";API `GET <bucket>?versioning` 返 `Status: Enabled`

### 5.2 lifecycle 3 规则

| # | 规则 | 配置值 | 用途 |
|---|---|---|---|
| 1 | 旧版本 30 天 expire | `NoncurrentVersionExpiration.NoncurrentDays = 30` | 误删 30 天内可恢复;30 天后 COS 自动清理 |
| 2 | DeleteMarker 即清除 | `Expiration.ExpiredObjectDeleteMarker = true` | 防"已删但 DeleteMarker 占用 list 结果" |
| 3 | incomplete multipart 7 天 abort | `AbortIncompleteMultipartUpload.DaysAfterInitiation = 7` | **当前系统 v1.0 不主动使用 multipart;该项为未来预留 / 防御性兜底**(防客户端被攻击者注入异常分片留下孤儿)|

### 5.3 lifecycle XML 模板

```xml
<LifecycleConfiguration>
  <Rule>
    <ID>cleanup-noncurrent-versions</ID>
    <Status>Enabled</Status>
    <Filter><Prefix>attachments/</Prefix></Filter>
    <NoncurrentVersionExpiration>
      <NoncurrentDays>30</NoncurrentDays>
    </NoncurrentVersionExpiration>
  </Rule>
  <Rule>
    <ID>cleanup-expired-delete-markers</ID>
    <Status>Enabled</Status>
    <Filter><Prefix>attachments/</Prefix></Filter>
    <Expiration>
      <ExpiredObjectDeleteMarker>true</ExpiredObjectDeleteMarker>
    </Expiration>
  </Rule>
  <Rule>
    <ID>abort-incomplete-multipart</ID>
    <Status>Enabled</Status>
    <Filter><Prefix>attachments/</Prefix></Filter>
    <AbortIncompleteMultipartUpload>
      <DaysAfterInitiation>7</DaysAfterInitiation>
    </AbortIncompleteMultipartUpload>
  </Rule>
</LifecycleConfiguration>
```

### 5.4 SSE-COS 加密(沿 [评审稿 §6.4.4](../批次7_provider选型_API前评审.md))

- **算法**:`AES256`(SSE-COS 默认;等价 AWS SSE-S3)
- **配置**:腾讯云 COS 控制台 → 存储桶 → 加密 → 服务端加密 SSE-COS
- **客户端透明**:无需 PUT 时携带加密 header;COS 自动加密落盘
- ❌ **禁止启用 SSE-KMS**(复杂度 + 成本;沿 D6 决议 4 最低合规版)
- ❌ **禁止启用 SSE-C**(客户端管理密钥;复杂度过高)

### 5.5 配置后校验

```bash
# 用腾讯云 COS Browser 工具或控制台校验:
# - versioning 状态 = Enabled
# - lifecycle 3 条规则全部 Enabled
# - 默认加密 = SSE-COS / AES256
```

---

## 6. `STORAGE_ENCRYPTION_KEY` 生成与注入

### 6.1 生成命令

```bash
openssl rand -base64 32
# 输出形如:<base64-32-bytes>(43-44 字符;**不要回显 / 复制到剪贴板共享 / 截图**)
```

**铁律**:

- **长度 ≥ 32 字节**(沿 `.env.example` 注释 + handoff §4.6)
- ⚠️ **禁止用 `.env.example` 默认值**(任何 `please-change-me` / `your-key-here` 占位字符串)
- ⚠️ **永不**与 `<your-secret-id>` / `<your-secret-key>` 同存(沿 [handoff §8.2](../handoff/v0.11.0.md):加密 key 与凭证密文分离)
- 生成后立即注入部署平台(§6.2);**不要本地长期保存**

### 6.2 部署平台注入路径

#### 6.2.1 Kubernetes Secret

```bash
# 创建 Secret(--from-literal 防 history 留痕需 shell history 设置;见 §8.2)
kubectl create secret generic srvf-api-storage \
  --from-literal=STORAGE_ENCRYPTION_KEY='<base64-32-bytes>' \
  -n <your-namespace>

# Deployment 引用(片段)
spec:
  containers:
  - name: srvf-api
    envFrom:
    - secretRef:
        name: srvf-api-storage
```

#### 6.2.2 Docker

```bash
docker run -d \
  -e STORAGE_ENCRYPTION_KEY='<base64-32-bytes>' \
  -e APP_ENV=production \
  --name srvf-api \
  <your-image>
```

**注**:`-e` 传入会留在 `docker inspect` 输出;**生产改用 Docker Secret 或 `--env-file` + 临时文件 + 立即销毁**:

```bash
# 临时文件方式(推荐;命令结束即删)
TMPENV=$(mktemp) && chmod 600 "$TMPENV"
printf 'STORAGE_ENCRYPTION_KEY=%s\n' '<base64-32-bytes>' > "$TMPENV"
docker run -d --env-file "$TMPENV" --name srvf-api <your-image>
shred -u "$TMPENV"
```

#### 6.2.3 Systemd

```ini
# /etc/systemd/system/srvf-api.service.d/storage.conf
[Service]
EnvironmentFile=/etc/srvf-api/storage.env
```

```bash
# /etc/srvf-api/storage.env(权限 600,owner=root)
sudo install -m 600 /dev/null /etc/srvf-api/storage.env
sudo sh -c 'printf "STORAGE_ENCRYPTION_KEY=%s\n" "<base64-32-bytes>" > /etc/srvf-api/storage.env'
sudo systemctl restart srvf-api
```

### 6.3 注入后校验

应用启动日志应出现(沿 [handoff §4.6](../handoff/v0.11.0.md) 启动 fail-fast):

```
INFO StorageCryptoService initialized (algorithm=aes-256-gcm)
```

若出现 `STORAGE_ENCRYPTION_KEY is required in production`(fail-fast 抛错) → 注入失败;按 §6.2 检查环境变量是否生效。

### 6.4 Key 轮换(留 v1.1+)

**当前 v0.11.0 不支持在线轮换**;轮换 = 重新加密所有现存凭证密文。流程:

1. 准备新 key
2. **用 §8 reset-credentials API 重新录入凭证**(自动用新 key 加密落库)
3. 部署平台切换 `STORAGE_ENCRYPTION_KEY` 至新值
4. 重启应用

**未实现**:在线无 downtime 轮换 / 多 key 兼容 / 自动重加密。留 v1.1+ 专项 PR。

---

## 7. 后台 Storage Settings 初始化

### 7.1 端点(沿 [handoff §4.9](../handoff/v0.11.0.md))

- `GET /api/v2/storage-settings`:读当前配置(凭证字段返 `credentialStatus`,**永不返明文**)
- `PATCH /api/v2/storage-settings`:改非凭证字段(PATCH upsert;首次自动创建 default row)
- `POST /api/v2/storage-settings/reset-credentials`:重置凭证(详见 §8)

**权限**:全部 `@Roles(SUPER_ADMIN, ADMIN)` 入口。

### 7.2 首次初始化:PATCH 非凭证字段

```bash
# 1. 维护者登录拿 JWT
curl -X POST '<api-base-url>/api/v2/auth/login' \
  -H 'Content-Type: application/json' \
  -d '{"username":"<admin-username>","password":"<admin-password>"}'
# → { "code": 0, "data": { "accessToken": "<admin-jwt>" } }

# 2. PATCH 非凭证字段(upsert;首次自动建 default row)
curl -X PATCH '<api-base-url>/api/v2/storage-settings' \
  -H 'Authorization: Bearer <admin-jwt>' \
  -H 'Content-Type: application/json' \
  -d '{
    "providerType": "COS",
    "bucket": "<your-bucket>",
    "region": "<your-region>",
    "keyPrefix": "attachments",
    "uploadUrlTtlSeconds": 600,
    "downloadUrlTtlSeconds": 300,
    "mimePolicyMode": "INHERIT"
  }'
# 期望:
# { "code": 0, "data": { "providerType": "COS", "bucket": "...", "credentialStatus": "MISSING", ... } }
# 注意:此时 credentialStatus = MISSING(凭证未录入)
```

### 7.3 字段填充顺序建议

| 顺序 | 字段 | 注意 |
|---|---|---|
| 1 | `providerType` | `COS`(生产)/ `LOCAL`(dev/test) |
| 2 | `bucket` | 沿 §2.1 创建的 bucket 全名 |
| 3 | `region` | 沿 §2.2 选定 region |
| 4 | `keyPrefix` | default `attachments`(沿 Q17 key 命名);除非有特殊运维诉求否则不改 |
| 5 | `uploadUrlTtlSeconds` | default `600`(沿 Q8;范围 60-3600)|
| 6 | `downloadUrlTtlSeconds` | default `300`(沿 Q8;范围 60-1800)|
| 7 | `mimePolicyMode` | `INHERIT`(沿用 `attachment_mime_configs`;default)/ `OVERRIDE`(以 settings 为准;v1.0 暂不主动使用)|

⚠️ **禁止 PATCH 凭证字段**:`secretIdEncrypted` / `secretKeyEncrypted` / `secretId` / `secretKey` 任何形式都会被 `forbidNonWhitelisted` 拒绝(沿 Q-11-X);凭证只能走 §8 reset-credentials 独立端点。

### 7.4 校验初始化结果

```bash
curl -X GET '<api-base-url>/api/v2/storage-settings' \
  -H 'Authorization: Bearer <admin-jwt>'
# 期望(凭证未录入):
# {
#   "code": 0,
#   "data": {
#     "providerType": "COS",
#     "bucket": "<your-bucket>",
#     "region": "<your-region>",
#     "keyPrefix": "attachments",
#     "uploadUrlTtlSeconds": 600,
#     "downloadUrlTtlSeconds": 300,
#     "credentialStatus": "MISSING",  ← 凭证未录入
#     ...
#   }
# }
```

**注意**:response 中 **永不**含 `secretIdEncrypted` / `secretKeyEncrypted` / `secretId` / `secretKey` 任何字段;若发现这类字段出现 → **立即停止并报安全事件**(沿 §11)。

---

## 8. reset-credentials 凭证录入

### 8.1 端点

`POST /api/v2/storage-settings/reset-credentials`

### 8.2 防 shell history 留痕(必读)

凭证录入命令含 SecretId / SecretKey 明文;若进入 shell history → 攻击者读 history = 凭证泄漏。**录入前必须**:

```bash
# 方案 A:本次 shell session 关闭 history
unset HISTFILE
# 或 zsh:
unset HISTFILE && setopt no_history

# 方案 B:命令前加空格(需 HISTCONTROL=ignorespace)
export HISTCONTROL=ignorespace
 curl ...  # 注意命令前有空格
```

录入完成后:

```bash
# 立即清当前 session history
history -c  # bash
# 或 zsh:
fc -p && fc -P
```

### 8.3 录入命令(用临时文件,**禁止**命令行直接传 `-d`)

```bash
# 1. 创建临时 body 文件(权限 600;不进 history)
TMPBODY=$(mktemp) && chmod 600 "$TMPBODY"

# 2. 用编辑器手填凭证(不在 shell 中 echo / printf)
$EDITOR "$TMPBODY"
# 文件内容:
# {
#   "secretId": "<your-secret-id>",
#   "secretKey": "<your-secret-key>"
# }

# 3. 调 API
curl -X POST '<api-base-url>/api/v2/storage-settings/reset-credentials' \
  -H 'Authorization: Bearer <admin-jwt>' \
  -H 'Content-Type: application/json' \
  --data-binary @"$TMPBODY"
# 期望:
# {
#   "code": 0,
#   "data": {
#     "credentialStatus": "CONFIGURED",  ← 凭证已加密落库
#     "providerType": "COS",
#     "bucket": "<your-bucket>",
#     ...
#   }
# }
# 注意:response 中 永不 含 secretId / secretKey / secretIdEncrypted / secretKeyEncrypted 任何字段

# 4. 立即销毁临时文件
shred -u "$TMPBODY"
unset TMPBODY
```

### 8.4 失败处理

| response | 含义 | 处置 |
|---|---|---|
| `code: 0, credentialStatus: CONFIGURED` | ✅ 成功 | 继续 §9 闭环验收 |
| `code: 40100`(UNAUTHORIZED) | JWT 失效 | 重新登录拿新 JWT |
| `code: 40300`(FORBIDDEN) | JWT 不是 SUPER_ADMIN / ADMIN | 用正确账号 |
| `code: 50000`(INTERNAL_ERROR) | `STORAGE_ENCRYPTION_KEY` 未注入或太短 | 检查 §6.2 部署平台 env;应用启动日志查 fail-fast |
| `code: 40000`(BAD_REQUEST) | 入参 DTO 校验失败(secretId / secretKey 空 / 格式错) | 检查 body JSON 字段 |

### 8.5 重新录入(凭证轮换)

同 §8.3 流程;再次 POST 即覆盖旧密文。**`StorageSettingsService.invalidate()` 自动主动失效缓存**;**下一次 Provider 调用 ≤ 60s 内自动用新凭证**(沿 [handoff §4.4 Router 动态路由](../handoff/v0.11.0.md))。

---

## 9. 闭环验收(端到端):upload-url → PUT → confirm-upload → accessUrl 下载 → DELETE

> 用真实凭证 + 真实 bucket 跑一次小文件(< 1MB)端到端验收。若任一步失败 → §10 回滚。

### 9.1 准备测试文件

```bash
# 生成 100KB 测试文件(随机数据;避免使用真实业务数据)
head -c 100000 /dev/urandom > /tmp/test-upload.bin
file /tmp/test-upload.bin
# 期望:/tmp/test-upload.bin: data
```

### 9.2 Step 1:`POST /upload-url`(取 signed URL + uploadToken)

```bash
curl -X POST '<api-base-url>/api/v2/attachments/upload-url' \
  -H 'Authorization: Bearer <admin-jwt>' \
  -H 'Content-Type: application/json' \
  -d '{
    "ownerType": "member",
    "ownerId": "<existing-member-id>",
    "originalName": "test-upload.bin",
    "mime": "application/octet-stream",
    "sizeBytes": 100000
  }'
# 期望:
# {
#   "code": 0,
#   "data": {
#     "key": "attachments/prod/2026/05/16/<cuid>.bin",
#     "uploadUrl": "https://<your-bucket>.cos.<your-region>.myqcloud.com/...?<signed>",
#     "uploadHeaders": { "Content-Type": "application/octet-stream", ... },
#     "uploadMethod": "PUT",
#     "expiresAt": "2026-05-16T...Z",
#     "uploadToken": "<base64url>.<base64url>"
#   }
# }
```

**失败回退**:
- `code: 13010`(ATTACHMENT_OWNER_TYPE_INVALID) → 检查 ownerType / attachment_type_configs 是否 ACTIVE
- `code: 13011`(ATTACHMENT_OWNER_NOT_FOUND) → 提供真实存在的 member 主键 cuid
- `code: 13012` → MIME 不在白名单
- `code: 13013` → size 超限
- `code: 50000` → Provider 不可用(检查 §7 / §8 配置)

### 9.3 Step 2:PUT 文件到 signed URL

```bash
# 将 Step 1 输出存入变量(实际运维操作中复制相应字段)
UPLOAD_URL='<step1-uploadUrl>'
UPLOAD_TOKEN='<step1-uploadToken>'

curl -X PUT "$UPLOAD_URL" \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @/tmp/test-upload.bin \
  -w 'HTTP %{http_code}\n'
# 期望:HTTP 200(COS 返空 body)
# 失败:
# - HTTP 403 → CORS 配置错(§4)/ signed URL 过期 / 凭证错(§8)
# - HTTP 400 → Content-Type 不符 / Content-Length 不符
```

### 9.4 Step 3:`POST /confirm-upload`(落库)

```bash
curl -X POST '<api-base-url>/api/v2/attachments/confirm-upload' \
  -H 'Authorization: Bearer <admin-jwt>' \
  -H 'Content-Type: application/json' \
  -d "{ \"uploadToken\": \"$UPLOAD_TOKEN\" }"
# 期望:
# {
#   "code": 0,
#   "data": {
#     "id": "<cuid>",
#     "key": "attachments/prod/2026/05/16/<cuid>.bin",
#     "ownerType": "member",
#     "ownerId": "<existing-member-id>",
#     "mime": "application/octet-stream",
#     "size": 100000,
#     "accessUrl": "https://<your-bucket>.cos.<your-region>.myqcloud.com/...?<signed>",  ← 真实化
#     "createdAt": "...",
#     ...
#   }
# }
```

**失败回退**:
- `code: 13001`(ATTACHMENT_NOT_FOUND;反 replay 命中)→ 重做 Step 1 + 2 + 3(每次必须新生成 uploadToken)
- `code: 13013` → headObject 返回 size 与 uploadToken claims 不一致(中间被改动)
- `code: 50000` → headObject 失败(凭证错 / bucket 不可达)

### 9.5 Step 4:验 accessUrl 真实可下载

```bash
ATTACHMENT_ID='<step3-id>'
ACCESS_URL='<step3-accessUrl>'

curl -X GET "$ACCESS_URL" -o /tmp/test-download.bin -w 'HTTP %{http_code}\n'
# 期望:HTTP 200 + /tmp/test-download.bin 大小 = 100000 字节

# 校验下载内容与原文件一致
diff /tmp/test-upload.bin /tmp/test-download.bin && echo 'content match'
# 期望:content match
```

**失败回退**:
- HTTP 403 → signed URL 过期(超 300s TTL)/ CORS 配置错
- HTTP 404 → COS 端文件不存在(PUT 阶段失败了但 confirm-upload 误成功)

### 9.6 Step 5:DELETE 验删除链路

```bash
curl -X DELETE "<api-base-url>/api/v2/attachments/$ATTACHMENT_ID" \
  -H 'Authorization: Bearer <admin-jwt>' \
  -w 'HTTP %{http_code}\n'
# 期望:HTTP 200 + { "code": 0, "data": null }
```

**校验 COS 端**:

- 启用 versioning 后,DELETE = 生成 DeleteMarker;**真实对象仍保留 30 天**
- 用 COS 控制台查 bucket → 对象 → 找 `attachments/prod/2026/05/16/<cuid>.bin` → 显示"已删除"或"无对象"
- 用控制台显示"所有版本" → 应能看到 DeleteMarker + 原版本(可恢复 30 天)
- ACCESS_URL 再次 GET → 期望 HTTP 404(沿信息泄漏防御)

### 9.7 闭环验收成功标志

| Step | 期望 |
|---|---|
| 1 | upload-url 返完整 6 字段 + bucket 域名 |
| 2 | PUT 返 HTTP 200 |
| 3 | confirm-upload 返完整 AttachmentResponseDto + accessUrl 真实 URL(非 null) |
| 4 | accessUrl GET 返 HTTP 200 + 内容字节完全一致 |
| 5 | DELETE 返 HTTP 200 + COS 端 versioning 留 DeleteMarker + 原版本(可恢复) |

**5 步全部 ✅** → C-7.5 Provider 生产链路验收通过。

### 9.8 清理测试数据

```bash
# 删除本地测试文件
shred -u /tmp/test-upload.bin /tmp/test-download.bin
unset UPLOAD_URL UPLOAD_TOKEN ATTACHMENT_ID ACCESS_URL
```

---

## 10. 回滚方案

| # | 场景 | 影响 | 处置 |
|---|---|---|---|
| 1 | **凭证误录**(SecretId / SecretKey 输错)| §9 闭环验收 PUT 403 / confirm-upload 50000 | 重做 §8 reset-credentials(覆盖密文);`StorageSettingsService.invalidate()` 自动主动失效缓存;≤ 60s 内自动用新凭证 |
| 2 | **Provider 切换错位**(误选 COS 但凭证未录入)| 全部 attachments 5 端点 500 | `PATCH /storage-settings { providerType: "LOCAL" }` 临时降级到 LocalProvider(dev / test 用;**生产 LocalProvider 无意义,仅短暂兜底**);≤ 60s 自动切换;然后 §8 补凭证 |
| 3 | **bucket 误删**(运维误操作)| 全部历史附件不可读 + 新 upload 失败 | 启用 versioning 30 天兜底(沿 §5.1);腾讯云控制台恢复 bucket;或新建 bucket + `PATCH /storage-settings { bucket: <new-bucket> }`(历史附件 key 失效,**不可挽回**) |
| 4 | **`STORAGE_ENCRYPTION_KEY` 丢失**(部署平台 env 误删 / 替换)| 应用启动 fail-fast / 现存凭证密文不可解(`credentialStatus: INVALID`)| **致命**;无法恢复旧凭证密文;必须 §6 重新生成 key + §8 重新录入凭证 |
| 5 | **DB `storage_settings` row 误删** | 全部 attachments 5 端点 500(Service 找不到配置)| `PATCH /storage-settings { providerType: ..., bucket: ..., ... }` upsert 自动建新 row(沿 Q-11-1);然后 §8 补凭证 |

**铁律**:任何回滚操作前,先**在测试环境(test bucket + test 凭证)演练一次**,确认无副作用。生产回滚必须**有维护者 + 运维双人 review**。

---

## 11. 安全禁止项(集中红线)

> ⚠️ **执行任何 § 章节前必读**。违反任一项 = 红线破口,可能造成凭证泄漏 / 数据全量泄漏 / 不可逆数据丢失。

| # | 禁止项 | 为什么 |
|---|---|---|
| 1 | **禁止开启 bucket 公有读**(任何 ACL = public-read / public-read-write) | 沿 [评审稿 §6.4.1 Q16](../批次7_provider选型_API前评审.md);所有访问 100% 走 signed URL;公有读 = 全量数据可被未授权抓取 |
| 2 | **禁止把 SecretId / SecretKey commit 进 git**(`.env` / 源代码 / 配置文件 / 任何 git tracked 文件) | git 历史不可逆;一旦 commit,即使 force-push 删除,GitHub 缓存 / fork / clone 仍可能保留 |
| 3 | **禁止把 SecretId / SecretKey 贴入 PR / Issue / 文档 / Slack / 邮件 / 协作工具** | 同 #2;协作平台日志 / 通知 / 归档不可控 |
| 4 | **禁止把 SecretId / SecretKey 写入日志 / audit_logs / 应用 stdout / stderr** | 沿 [评审稿 §6.6.5 + handoff §8.2](../批次7_provider选型_API前评审.md);日志聚合系统(Loki / Datadog / ES)长期存储 |
| 5 | **禁止 CORS `AllowedOrigins: ["*"]`** | 沿 §4.2 + 评审稿 §6.4.6;任意源都可发起 PUT / GET,signed URL 一旦泄漏可被滥用 |
| 6 | **禁止 IAM Policy 用 wildcard `Resource: "*"`**(必须限定本 bucket `qcs::cos:...:<bucket>/*`)| 子账号一旦泄漏可越权操作其他 bucket / 服务 |
| 7 | **禁止 IAM 子账号绑定预设全权策略**(`QcloudCOSFullAccess` / `AdministratorAccess` 等)| 越权风险 |
| 8 | **禁止启用 SSE-KMS / SSE-C** | 沿 §5.4;复杂度 + 成本不必要 |
| 9 | **禁止跳过 versioning**(误删后无 30 天兜底) | 沿 §5.1 + 评审稿 §6.4.5;v1.0 删除策略依赖 versioning + lifecycle |
| 10 | **禁止把 `STORAGE_ENCRYPTION_KEY` 与凭证密文同存储**(同 DB / 同 env / 同 git) | 沿 [handoff §8.2](../handoff/v0.11.0.md);双因素分离 = DB dump 单泄漏不解密 |
| 11 | **禁止 shell history 留下凭证录入命令** | 沿 §8.2;同机用户 / 攻击者读 `~/.bash_history` 即获凭证 |
| 12 | **禁止用 `.env.example` 默认值作真实 `STORAGE_ENCRYPTION_KEY`** | 沿 §6.1 + [handoff §4.6](../handoff/v0.11.0.md);任何 `please-change-me` / `your-key-here` 占位 = 攻击者已知 key |
| 13 | **禁止本文档替换占位符为真实值并 commit** | `<your-secret-id>` / `<your-bucket>` / `<your-appid>` / `<your-frontend-domain>` 等占位永不替换 |
| 14 | **禁止 AI 在任何 PR / 评论中输出真实凭证 / bucket 名 / 域名** | AI 边界(沿 [handoff §8.3](../handoff/v0.11.0.md)反模式表) |
| 15 | **禁止运维擅自在生产环境跑 §9 闭环验收使用业务真实数据**(用 `/dev/urandom` 生成测试文件) | 测试文件不要含 PII / 敏感数据;沿 [评审稿 §6.5 PII 检测](../批次7_provider选型_API前评审.md) |

---

## 12. 文档元信息

- **状态**:v0.1 草稿(撰写完成;入库待维护者授权 squash merge 本 PR)
- **commit 风格**:`docs(ops): add COS production rollout checklist`
- **不在本文件范围**:
  - 真实 bucket / IAM / 凭证录入(队组织运维侧执行)
  - 实际生产 SOP 流程(`docs/deployment.md` 等运维通用流程)
  - 设计决议背景(见 [`docs/批次7_provider选型_API前评审.md §6`](../批次7_provider选型_API前评审.md))
  - 阶段交接现状(见 [`docs/handoff/v0.11.0.md`](../handoff/v0.11.0.md))
  - Provider v1.1+ 扩展项(bootstrap fallback / test-connection / multipart / STS / 配置变更 audit;沿 handoff §7.7)
- **撰写者签名**:Claude Code(基于 C-7.5 v1.0 评审稿 35 项决议 + v0.11.0 handoff §4-§8 + 用户 Step 1 11 项拍板;**未动任何代码 / schema / 现有文档**)

### 12.1 引用来源

| 引用 | 内容 |
|---|---|
| [`docs/批次7_provider选型_API前评审.md §6.4`](../批次7_provider选型_API前评审.md) | COS 落地技术细节(私有桶 / key 命名 / 环境隔离 / SSE-COS / versioning / lifecycle / CORS / STS) |
| [`docs/批次7_provider选型_API前评审.md §6.5`](../批次7_provider选型_API前评审.md) | Storage Settings 架构设计(15 字段 / Q24 一次设计完整) |
| [`docs/批次7_provider选型_API前评审.md §6.6`](../批次7_provider选型_API前评审.md) | 凭证安全边界(Q21 加密存储 / Q22 永不回显 / 三态化 / DB 泄漏防御) |
| [`docs/handoff/v0.11.0.md §4`](../handoff/v0.11.0.md) | C-7.5 当前能力(11 子节)|
| [`docs/handoff/v0.11.0.md §5.3`](../handoff/v0.11.0.md) | 运维侧落地 8 项清单 |
| [`docs/handoff/v0.11.0.md §7.2`](../handoff/v0.11.0.md) | Slow-2 生产侧 COS 运维配置 |
| [`docs/handoff/v0.11.0.md §8.2`](../handoff/v0.11.0.md) | v0.11.0 段红线(凭证 6 层防护 / AES-256-GCM 参数固定 / 私有桶 + 100% signed URL) |
| [`.env.example`](../../.env.example) | `STORAGE_ENCRYPTION_KEY` + `STORAGE_LOCAL_ROOT` env 文档 |

---
