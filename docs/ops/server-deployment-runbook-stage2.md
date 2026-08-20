# 真机部署 runbook —— 第二阶段:seed + COS + 生产态 + 域名

> **状态**:**PASS**(2026-08-20,维护者在自有服务器实测,按 §0「内部验证轮」执行)。
> 十项验收全部通过;实测中查出本文一处缺陷(§2.1 的 `--user 0:0`)与一处代码缺陷,均已回填。
>
> **前置**:[第一阶段](./server-deployment-runbook.md) 已 PASS(空库冒烟通过)。
> 本文**接着它写**,不重复第一阶段已验证的内容。

## 实测环境(2026-08-20 通过)

| 项 | 实测值 |
|---|---|
| 轮次 | **内部验证轮**(§0),不对真实队员开放 |
| 域名 | `https://srvf-dp.23cc.cn`(HTTPS + 强制跳转) |
| `APP_ENV` | `production`(已在运行容器内 `printenv` 复核,非仅改 env 文件) |
| API 端口 | `127.0.0.1:3000`(未暴露公网) |
| PostgreSQL | `16.15`,库 `app`,**不映射宿主机端口** |
| migration | `89 / 89` — `Database schema is up to date!` |
| COS | bucket `srvf-attachments-1433783892` · region `ap-guangzhou` · envPrefix **`staging`** |
| `APP_TRUSTED_PROXY_CIDRS` | **`172.20.0.1/32`**(最小信任,见 §2.F) |
| 健康检查 | `/health/live` 与 `/health/ready` 公网 HTTPS 均 `200`,`db:up` |
| SUPER_ADMIN | **真实公网 HTTPS 登录成功**(非仅查库有行) |

### 本轮没有证明的事 —— ✅ 已于同日补测闭合

本文原版在此保留了一条边界(实测方主动划的):

> 本轮证明的是「COS 配置已写入 + 凭据已加密 + production 能解密 + fail-fast 通过」。
> **尚未执行真实的 COS PUT / HEAD / signed download / DELETE。**

**该边界已于 2026-08-20 同日补测闭合** —— 见
[`cos-closed-loop-test.md`](./cos-closed-loop-test.md) §6:PUT 200 · 服务端 HEAD 通过 ·
signed GET 下载 70 字节**逐字节一致** · DELETE 后旧短链 **404**,9 项判据全通过。

⇒ 现在**可以**声称「对象存储真实可用」。issue #935 的 **COS 那一半已闭合**
(企业微信 / 短信 / OCR 仍未验)。

⚠️ 但 §1.3 那条判断依然成立、依然要守:**bootstrap 全程不连 COS**,
值能写进库**不等于**云端可用 —— 所以每次换桶 / 换地域 / 换环境,
都要重跑一次闭环测试,不能拿这一次的 PASS 当永久结论。

## 0. 目标与边界

**目标**:把第一阶段那套「能启动的空壳」变成「真人能用的后端」——
灌入基础数据、建管理员、接通对象存储、从 `smoke` 切到 `production`、挂上域名与 HTTPS。

**不做**:前端部署 · 企业微信 · 短信 · OCR · 规模测试(留给第三阶段)。

**本阶段结束时应达到**:公网 HTTPS 域名可访问 `/health/ready`,
以 SUPER_ADMIN 登录成功,`APP_ENV=production` 稳定运行。

### ⚠️ 先决定:这一轮是「内部验证轮」还是「最终部署」

两者步骤完全相同,但**取值不同**,而且决定了 §1.4 那条「首次 seed 定终身」有多要命:

| | 内部验证轮 | 最终部署 |
|---|---|---|
| 目的 | 踩坑、验链路,**不对队员开放** | 真人开始用 |
| 字典取值 | 现状即可(含占位值) | **必须已定稿** |
| `envPrefix` | `staging` | `prod` |
| 之后清库 | ✅ 会清,所以数据不值钱 | ❌ 不能清 |

**推荐先跑一轮内部验证轮** —— 在数据不值钱的时候把 tools 镜像、bootstrap、反代这些坑踩完。
`envPrefix` 分开填,测试期上传的对象与正式期在桶里天然隔离,清库时不必去 COS 里辨认哪些是测试残留。
(`envPrefix` 是附件 key 的命名空间**兼安全边界**,防止对命名空间外对象签 signed URL;
见 `biz-code.constant.ts:3228`。它**可以后改**——在 PATCH 白名单内,`storage-settings.service.ts:392`,
与 §1.3 锁死的 bucket/region 不同。)

🔴 **清库的窗口只在「真人开始用之前」**。一旦队员开始报名、打卡、传证书,数据就清不得了 ——
最终部署之前必须先完成字典定稿(§1.4)。

---

## 1. 🔴 动手前必须知道的六件事

### 1.1 ⭐ seed **不能**在正式镜像里跑,而且比 migration 更麻烦

第一阶段已经踩过「正式镜像没有 Prisma CLI」。**seed 踩的是同一个坑,但多两层**:

| 需要什么 | 正式镜像(runner)有吗 |
|---|---|
| Prisma CLI | ❌ 没有(第一阶段已证) |
| `prisma.config.ts`(seed 命令的定义处) | ❌ **没被 COPY**(`Dockerfile:170-173` 只拷 `node_modules` / `dist` / `prisma` / `package.json`) |
| `tsx`(seed 用它执行 TS) | ❌ 生产依赖里没有 |
| `src/`(`prisma/seed.ts:6-7` import 了 `../src/modules/permissions/...`) | ❌ 只有编译后的 `dist` |

⇒ **必须另建一个 tools 镜像**。注意 `builder` 阶段也不行 —— 它 `:41` 有 `rm -rf node_modules`
后只重装生产依赖,且同样没拷 `prisma.config.ts`。

### 1.2 storage bootstrap **可以**在正式镜像里跑

`storage-settings:bootstrap` = `node dist/storage-settings-bootstrap`,
而 runner 带了完整 `dist` ⇒ **这一步不需要 tools 镜像**。

### 1.3 ⭐⭐ 桶名和地域**填错救不回来**;密钥填错能救

`storage-settings-bootstrap.ts` 对 `bucket` / `region` **只校验「非空字符串 + 长度上限」,
不校验格式**(`:330-342`),而且**全程不连 COS**(无任何网络探测)——
所以 `--dry-run` 通过**不代表值是对的**,它只证明「JSON 合法 + 加密密钥可用 + 表是空的」。

| 填错什么 | 能不能救 | 怎么救 |
|---|---|---|
| `secretId` / `secretKey` | ✅ 能 | 以 SUPER_ADMIN 调凭据重置口(upsert,事务提交后各实例下次调用直读新值,**不用重启**) |
| **`bucket` / `region`** | ❌ **不能** | 普通 PATCH 锁死;`cos-production-rollout-checklist.md:411` 要求另立评审 |

且 bootstrap **只接受空表**(`:134`「只允许初始化空表,拒绝覆盖」)⇒ 写错了不能重跑。

**⇒ 桶名与地域必须一次填对。** 本次取值(维护者 2026-08-20 提供,已与请求域名交叉核对):

```
bucket = srvf-attachments-1433783892
region = ap-guangzhou
请求域名 = srvf-attachments-1433783892.cos.ap-guangzhou.myqcloud.com
```

两值直接透传给 COS SDK(`providers/cos.provider.ts:97-98` `Bucket:` / `Region:`),
带 APPID 后缀的桶名写法与 SDK 要求一致。

### 1.4 字典的**名称在第一次 seed 时定终身**

`prisma/seed.ts:471-497` 用的是 `upsert` + **`update: {}`**,注释写明
「已存在则不覆盖 label / sortOrder / status,防止运营运行时调整被 seed 回退」。

| 场景 | 重跑 seed 有用吗 |
|---|---|
| **新增**字典项(seed 里加了新 code) | ✅ 会建出来 |
| **修改**已有项的 label / 排序 | ❌ **完全无效**,只能走管理接口改 |

⇒ **字典取值要在第一次 seed 之前定好**。当前内置 **27 个码表**:

```
activity_status · attendance_role · attendance_sheet_status · attendance_status
blood_type · cert_status · cert_sub_type · cert_type · content_type · document_type
education · emergency_relation · ethnicity · gender · gender_requirement
group_function · join_source · marital_status · member_audience_tag · member_grade
node_type · notification_type · org_establishment_status · political_status
recruitment · registration_status · work_nature
```

⚠️ `prisma/seed.ts:28` 注明 **`work_nature` 仍是占位**,未填真实取值。

### 1.5 切 `production` 会**新增两个必填环境变量**

第一阶段用的 `smoke` 不要求它们,切 `production` 后缺任一项**直接启动失败**:

| 变量 | 出处 | 语义 | 首次上线建议 |
|---|---|---|---|
| `INSURANCE_ENFORCEMENT_ENABLED` | `app.config.ts:322-329` | 开启后参加活动**要求有效保险记录** | **`false`** —— 空库没有保险数据,开了没人能报名 |
| `STORAGE_CONSISTENCY_MODE` | `app.config.ts:538-543` | `STRICT` 只认 `available`;`JIT` 还接受 `legacy_unverified` / `provider_unknown` | **`JIT`** —— 与非生产默认一致,先不引入新失败面 |

两者都是纯 env,**改了重启即可生效**,与 1.3 的不可逆完全不同。

### 1.6 `APP_CORS_ORIGIN` 要换成真实域名

第一阶段临时填的是 `http://127.0.0.1:3000`。
`app.config.ts:694` 禁止空值、`:697` 禁止 `*` ⇒ 必须填真实域名。

本阶段只部署后端 ⇒ 先填**后端自己的域名**;前端上线后再追加。

---

## 2. 步骤

### A. 建 tools 镜像(承载 migration 与 seed)

服务器上新建 `Dockerfile.tools`(**不进仓库**,与 `docker-compose.server.yml` 同属服务器侧):

```dockerfile
FROM node:22-alpine AS tools
RUN apk add --no-cache libc6-compat openssl
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
COPY src ./src
RUN pnpm prisma:generate
```

版本参数取自 `Dockerfile:29-30`(`NODE_VERSION=22` / `PNPM_VERSION=10.14.0`),
升级时须同步。构建:

```
docker build -f Dockerfile.tools -t srvf-tools:0.66.0 .
```

### B. 增量 migration

第一阶段已 apply 89 个。若镜像未换代码则本步无操作;换了新版本时:

```
docker run --rm --network <compose 网络> -e DATABASE_URL='<生产库>' \
  srvf-tools:0.66.0 pnpm prisma migrate deploy
```

⚠️ 报错**不要重跑、不要跳过**,停下取证(同第一阶段 §3)。

### C. seed + 建 SUPER_ADMIN

`prisma/seed.ts:9` 是 **v1 唯一允许创建 SUPER_ADMIN 的入口**。它直接读 `process.env`
(`:4364-4371`),刻意不走 ConfigService:

| 变量 | 约束 |
|---|---|
| `SUPER_ADMIN_USERNAME` | 必须符合 username 格式(归一化后小写);`production` 下**禁止**用默认值 `admin` |
| `SUPER_ADMIN_PASSWORD` | 必填;`production` 下**禁止**用默认值 `ChangeMe123456` |
| `SUPER_ADMIN_EMAIL` | 可选 |

```
docker run --rm --network <compose 网络> \
  -e DATABASE_URL='<生产库>' \
  -e APP_ENV=production \
  -e SUPER_ADMIN_USERNAME='<自定义,非 admin>' \
  -e SUPER_ADMIN_PASSWORD='<强密码,非默认>' \
  srvf-tools:0.66.0 pnpm prisma db seed
```

**幂等**:用户已存在时不覆盖密码 / 角色 / 邮箱,只打印提示(`:18`)。
🔴 密码不要写进 shell history,也不要贴进任何对话。

**做完这一步再回头确认 1.4 的字典取值** —— 此后改 label 只能走管理接口。

### D. COS bootstrap(先 dry-run,再落库)

**D-1 写配置文件**(临时,用完即删):

```
umask 077   # 文件不能有 group/other 权限,否则拒读
cat > /root/cos-bootstrap.json <<'EOF'
{
  "databaseUrl": "<生产库连接串>",
  "bucket": "srvf-attachments-1433783892",
  "region": "ap-guangzhou",
  "envPrefix": "prod",          <-- 内部验证轮填 "staging",见 §0
  "secretId": "<COS SecretId>",
  "secretKey": "<COS SecretKey>"
}
EOF
```

顶层未知字段直接拒绝;仅接受 PostgreSQL、单一明确数据库、`public` schema。

**D-2 dry-run**:

```
docker run --rm --network <compose 网络> --user 0:0 \
  -e APP_ENV=production -e STORAGE_ENCRYPTION_KEY='<第一阶段那把,必须同一把>' \
  -v /root/cos-bootstrap.json:/tmp/cos.json:ro \
  <正式镜像> node dist/storage-settings-bootstrap \
  --config-file=/tmp/cos.json --confirm-database='<生产库名>' --dry-run
```

### 🔴 `--user 0:0` 不能省(2026-08-20 实战踩出,本文原版漏了)

`Dockerfile:176` 是 `USER node`(uid 1000),而 D-1 的配置文件按安全要求是 `600 root:root`
⇒ **容器内的 node 用户读不了它**。

更坑的是报错信息**指错方向**:`storage-settings-bootstrap.ts:215-217` 把
`readFileSync` 与 `JSON.parse` 放在同一个 try、共用一个 catch,统一抛
「**config-file 不是合法 JSON**」。⇒ 权限错误被报成 JSON 语法错误,
在服务器上 `python3 -m json.tool` 验 JSON 又完全合法,于是白查一轮。

| 现象 | 真因 |
|---|---|
| 报「config-file 不是合法 JSON」,但 `json.tool` 说合法 | **权限**问题,不是 JSON 问题。加 `--user 0:0` |

⇒ bootstrap 是**一次性离线运维动作**,用 `--user 0:0` 跑它是正确解法 ——
不要为了迁就它去降低配置文件权限或改 owner(那会真的削弱安全)。

> 📌 代码侧改进已登记(拆开两种失败的报错文案),见 `docs/ai-harness/NEXT_TASKS.md`。

⚠️ **再说一遍**:dry-run 不连 COS,通过**不代表密钥或桶名是对的**。
它只证明 JSON 合法、加密密钥可用、表是空的。

**D-3 正式写入**:去掉 `--dry-run` 重跑一次(**同样带 `--user 0:0`**)。
写完用只读 SQL 复核一行:`row_count=1` · `enabled=true` · `provider_type=COS` · bucket/region/env_prefix 与配置一致。

**D-4 删除配置文件**:`shred -u /root/cos-bootstrap.json`(含明文密钥)。

### E. 切 `APP_ENV=production`

在 `docker-compose.server.yml` 的 api 服务环境里:

```
APP_ENV=production
APP_CORS_ORIGIN=https://<后端域名>
INSURANCE_ENFORCEMENT_ENABLED=false
STORAGE_CONSISTENCY_MODE=JIT
```

五把 `*_ENCRYPTION_KEY` 与 `JWT_SECRET` **必须与第一阶段完全一致** ——
换了任何一把,已加密数据永久解不开。

重启后先看日志有没有 fail-fast 报错,再验健康检查。

### F. 域名 + HTTPS(宝塔反向代理)

后端容器仍只监听 `127.0.0.1:3000`(第一阶段已验),**不要**改成 `0.0.0.0`。
在宝塔里:

1. 添加站点,绑定已备案域名
2. 申请并部署 SSL 证书,开启强制 HTTPS
3. 反向代理指向 `http://127.0.0.1:3000`
4. 确认代理转发了 `X-Forwarded-For` / `X-Forwarded-Proto`

⚠️ **接反代后必须回头核 `APP_TRUSTED_PROXY_CIDRS`**。
`app.config.ts:167` 要求 production / smoke 显式设置它 ⇒ 第一阶段**必然设过**
(否则起不来),但第一阶段 runbook **没记录填的什么值** —— 动手前先去服务器上查实际值。

若它是 `none`,挂上反代后应用看到的客户端 IP 会是代理的 IP ——
限流、审计、安全日志**全部记错人**,而且五条验收判据全绿也发现不了。
填宝塔反代的来源网段,并把实际值补记进第一阶段 runbook。

---

## 3. 验收判据

```
# 1) 容器与库
docker compose -f docker-compose.server.yml ps          # postgres healthy + api Up
docker port <api 容器>                                   # 仍只应有 127.0.0.1:3000

# 2) 生产态真的生效了(不是悄悄退回 smoke)
docker compose logs api | grep -i "APP_ENV\|production"

# 3) 公网 HTTPS
curl https://<域名>/api/system/v1/health/live           # {"status":"ok"}
curl https://<域名>/api/system/v1/health/ready          # {"status":"ok","db":"up"}

# 4) 证书与跳转
curl -I http://<域名>                                    # 应 301/302 → https

# 5) 管理员能登录(自己在浏览器或 curl 试,别只看库里有行)
```

**判据说明**:第 5 条必须真的登录成功。库里有 SUPER_ADMIN 行**不等于**能登录 ——
密码哈希、角色绑定、JWT 密钥任一环节错了都会卡在这里,而且前四条全绿。

---

## 4. 出错了怎么办

| 症状 | 处置 |
|---|---|
| 启动报 `storage_settings 未初始化` | D 步没做或没成功;**不要**改回 smoke 绕过,回去做 D |
| 启动报某个 env「不能为空」 | 照 1.5 / 1.6 补齐;都是纯 env,补完重启 |
| COS 上传失败、但应用能启动 | 多半是密钥错(密钥能解密 ≠ 密钥正确)⇒ 走凭据重置口,**可救** |
| COS 报桶不存在 / 地域不对 | ⚠️ 走不了普通 PATCH,停下报告,按 `cos-production-rollout-checklist.md:411` 另立评审 |
| migration 报错 | 停下取证,不重跑不跳过 |
| 需要紧急停掉存储功能 | 管理面设 `enabled=false`(显式 kill switch),storage effect 全部 fail-closed,API/worker 可重启 |

🔴 **生产回退禁止切到 LOCAL 或 smoke**(`cos-production-rollout-checklist.md:411`):
settings 丢失、LOCAL、未知 provider 一律 fail-closed。

---

## 5. 第三阶段的前置(未验证)

**🔴 真实 COS 文件闭环测试**(PUT / HEAD / signed download / DELETE)—— 见本文开头
「本轮没有证明的事」;这是 issue #935「完成真实外部供应商链路验证」的 COS 那一半,
也是 `docs/current-state.md` 列的 production GO 硬门,**第二阶段 PASS 不覆盖它**。

规模测试(500 / 2000 / 10000)· 企业微信(等备案)· 短信 · OCR ·
前端部署与同源拓扑 · 备份恢复演练 · `STORAGE_CONSISTENCY_MODE` 收紧到 `STRICT` 的评估。

**同第一阶段的纪律:第三阶段必须基于届时的仓库实况重新制定,不得机械沿用本文。**
