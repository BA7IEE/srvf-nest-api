# 真机部署 runbook —— 第一阶段:空库冒烟(已实战验证)

> **状态**:第一阶段 **PASS**(2026-08-20,维护者在自有服务器实测)。
> **本文只写实测为真的东西**;凡是没在真机上跑过的,标注「未验证」。
>
> ⚠️ **`docs/archive/plans/first-release-bootstrap-sop.md` 已漂移**,不要机械沿用 ——
> 那份写于 89 个 migration、企微、活动 v1.1 之前。本文取代它作为**真机部署**的当前事实。

## 0. 第一阶段的目标与边界

**目标**:证明「服务器 Docker → PostgreSQL 16 → 全部 migration → 正式构建镜像 → API 启动 → API 连得上库」整条链路真实可用。

**不做**:域名 / HTTPS / 反向代理 / 公网端口 / seed / SUPER_ADMIN 初始化 / storage_settings bootstrap / 企业微信。

## 1. 实测环境(2026-08-20 通过)

| 项 | 实测值 |
|---|---|
| 系统 | OpenCloudOS 9 |
| Docker / Compose / Buildx | `26.1.4` / `2.32.1` / `0.19.3` |
| PostgreSQL | `16.15` |
| Node(镜像内) | `22.23.2` · Prisma `6.19.3` |
| migration | **89 个全部成功** |
| 健康检查 | `/health/live` → `{"status":"ok"}` · `/health/ready` → `{"status":"ok","db":"up"}` |
| 端口暴露 | API 仅 `127.0.0.1:3000`;PostgreSQL `5432` **不映射宿主机** |
| 部署目录 | **`/www/srvf`**(compose 文件与 env 文件都在这里;本文原版漏记,维护者因此白跑过命令) |
| 容器名 | **`srvf-api`** / **`srvf-postgres`** |
| compose 文件 | `/www/srvf/docker-compose.server.yml`(**服务器侧文件,不在仓库里**,见 2.1) |

## 2. 🔴 六处必须知道的事实(每条都是实战踩出来的)

### 2.1 仓库的 `docker-compose.yml` **不能直接用于服务器**

实测:它**只有 `postgres` 一个服务,没有 `api`** ⇒ `docker compose build api` / `up api` 不成立。
且它 `POSTGRES_PASSWORD: postgres` 写死、`- '5432:5432'` 会绑宿主机网卡。

⇒ **服务器上另建 `docker-compose.server.yml`**,不改仓库那份(那份是本地开发用的)。

### 2.2 正式镜像里**没有 Prisma CLI**

`Dockerfile` 的 runner 阶段只带 `dist` + 生产依赖 + `prisma/`(schema 与 migrations),**刻意不带 CLI**
⇒ `docker compose run --rm api npx prisma migrate deploy` **跑不通**。

⇒ 正确做法:**用 `deps` 阶段单独构建一个迁移镜像**执行 `prisma migrate deploy`。
(设计意图见 `Dockerfile:191-196`:生产只允许已审查、已提交的 `migrate deploy`,且必须在应用副本启动**之前**独立执行。)

### 2.3 构建需要 **BuildKit / Buildx**

`Dockerfile` 用了 2 处 `RUN --mount=type=cache` ⇒ 只装了 Docker 而没有 buildx 的机器会构建失败。
⇒ 先装 `docker-buildx-plugin`。

### 2.4 `APP_CORS_ORIGIN` **不能为空**

`app.config.ts:694`:production / smoke 下空值直接抛错拒启;`:697` 还禁止 `*`。
⇒ 第一阶段可临时填 `http://127.0.0.1:3000`;**接域名时必须换成真实前端域名**。

### 2.5 ⭐ 空库**不能**直接以 `APP_ENV=production` 启动

会撞 **`storage_settings` production fail-fast**(「storage_settings 未初始化」)。

**这不是缺陷,是设计**。正式上线顺序是:
`migration → seed → storage-settings 离线 bootstrap → production boot`。

⇒ **第一阶段用 `APP_ENV=smoke`**。依据在代码注释里(`app.config.ts:4-5`):
> `'smoke'` 是 CI Docker smoke job 专用 AppEnv;**除 storage_settings fail-fast 外**,与 production 同等。

**⇒ 用 smoke 做空库冒烟不是绕过生产规则,是代码本来就为此留的档位。**
⚠️ **但 smoke ≠ 生产就绪**:切 `production` 前必须先完成上面那条 bootstrap 顺序。

### 2.6 必填环境变量清单(缺任一项**直接拒启**)

`app.config.ts` 在启动期对下列变量 fail-fast。**`smoke` 与 `production` 同等对待**
(`isProductionLike()`,`app.config.ts:16-18`)⇒ 第一阶段虽然用 smoke,下表 11 条
**一条都不能少**;另有 2 条只在 `production` 生效,见
[第二阶段 §1.5](./server-deployment-runbook-stage2.md)。

> 🤖 本表由 `pnpm ops:required:check` 机器核对(CI Fast checks 里跑)——
> 判据从 `app.config.ts` **动态解析**必填项,漏登记一条当场红。
> 它核的是「**有没有条目**」,核不了「**填得对不对**」,后者仍然要人读。

| 变量 | smoke | production | 出处 | 取值 |
|---|:--:|:--:|---|---|
| `APP_CORS_ORIGIN` | ✅ | ✅ | `:694` | 真实前端域名;禁空、禁 `*`(见 2.4) |
| `APP_TRUSTED_PROXY_CIDRS` | ✅ | ✅ | `:167` | 无反代时填 `none`;挂反代后**必须回头改**(第二阶段 §2.F) |
| `STORAGE_ENCRYPTION_KEY` | ✅ | ✅ | `:557` | 🔑 见下方密钥纪律 |
| `SMS_ENCRYPTION_KEY` | ✅ | ✅ | `:577` | 🔑 |
| `WECHAT_ENCRYPTION_KEY` | ✅ | ✅ | `:597` | 🔑 |
| `WECOM_ENCRYPTION_KEY` | ✅ | ✅ | `:618` | 🔑 |
| `REALNAME_ENCRYPTION_KEY` | ✅ | ✅ | `:638` | 🔑 |
| `ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED` | ✅ | ✅ | `:481` | 严格 `true` / `false`;首次上线填 `false` |
| `ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED` | ✅ | ✅ | `:499` | 同上,首次上线填 `false` |
| `ACTIVITY_V11_WORKFLOW_ENABLED` | ✅ | ✅ | `:517` | 同上,首次上线填 `false`(切换闸,见 `docs/ops/activity-batch-worker-runbook.md`) |
| `ACTIVITY_OS_CONTROL_PLANE_MODE` | ✅ | ✅ | `src/config/app.config.ts` 的 `parseActivityControlPlaneMode` | 严格 `off` / `shadow` / `active`，首次填 `off`；`active` 且 v1.1 未开时拒启 |
| `INSURANCE_ENFORCEMENT_ENABLED` | — | ✅ | `:326` | 第二阶段 §1.5 |
| `STORAGE_CONSISTENCY_MODE` | — | ✅ | `:542` | 第二阶段 §1.5 |

另需 `JWT_SECRET`(`openssl rand -base64 48`)—— 它不在上表(不是启动期 fail-fast 项),
但换掉会让所有已签发 token 失效。

⚠️ 三个 `ACTIVITY_*` 开关在 2026-07-24 / 08-18 / 08-19 就已是必填,**早于本文 08-20 的实测**
⇒ 那次 PASS 时它们必然已被赋值,只是**本文原版没记下来**。重建服务器前先去
`/www/srvf` 把 env 文件里的实际取值抄下来。

#### 🔑 五把加密密钥的纪律(比三个开关更要命)

`STORAGE_ENCRYPTION_KEY` · `SMS_ENCRYPTION_KEY` · `WECHAT_ENCRYPTION_KEY` ·
`WECOM_ENCRYPTION_KEY` · `REALNAME_ENCRYPTION_KEY`,各 ≥32 字符,
用 `openssl rand -base64 32` 逐把单独生成(**不要五把用同一个值**)。

它们做的是**静态加密**:实名信息等 PII、短信 / 微信 / 企微的第三方凭证,都是用它们加密后落库的。

🔴 **一经启用,不得更换。** 缺失只是启动失败(还好,当场就知道);
**换掉或填错则是用旧 key 加密的数据再也解不开** —— 而且不会当场报错,
要等到某次读取实名信息或调第三方接口时才炸,那时已经分不清是哪一批数据受影响。

⇒ 必须**离线备份**(密码管理器 / 纸质保险箱),与数据库备份**分开存放**;
**不得入库、不得写进本文或任何文档、不得贴进任何对话或工单**。
真要轮换,必须先设计存量数据的解密—重加密迁移,那是单独一次评审,不是改个 env。

## 3. 第一阶段验收判据(照此自查)

```
docker compose -f docker-compose.server.yml ps        # postgres healthy + api Up
psql -c "select version()"                            # 必须 PostgreSQL 16.x
prisma migrate deploy                                 # 全部 migration applied,零报错
curl 127.0.0.1:3000/api/system/v1/health/live         # {"status":"ok"}
curl 127.0.0.1:3000/api/system/v1/health/ready        # {"status":"ok","db":"up"}
docker port <api 容器>                                 # 只应有 127.0.0.1:3000
```

⚠️ **migration 报错时不要重跑、不要跳过** —— 顺序与完整性是正确性地基,停下取证。

## 4. 第二阶段的前置(未验证,留给下一份)

接域名 / HTTPS / 反向代理 · seed 与 SUPER_ADMIN 初始化 · storage_settings 离线 bootstrap ·
真实 `APP_CORS_ORIGIN` · 切 `APP_ENV=production` · 前后端**同源**部署(2026-08-03 拍板的拓扑)。

**第二阶段必须基于届时的仓库实况重新制定,不得机械沿用本文。**
