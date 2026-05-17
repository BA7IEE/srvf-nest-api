# 第一版上线 / 联调 zero-to-login bootstrap SOP

> **用途**:把"从空仓库 / 空数据库 → 第一个真实账号可登录 → 前端联调前置条件可核验"的全部步骤,**按串行执行顺序**梳理成一份导航文档,服务于 [`first-release-readiness-plan.md §3.1 P0-C`](first-release-readiness-plan.md)。
>
> **定位**:**导航 + 串行清单 + 检查点**;不引入新事实、不修改 schema / src / seed / env 字段、不复制权威源原文。
>
> **冲突优先级**(沿 [`process.md §6`](process.md)):`ARCHITECTURE.md` > `CLAUDE.md` / `AGENTS.md` > `docs/srvf-foundation-baseline.md` > `docs/V2红线与复活路径.md` > 单批次评审稿 > handoff > `current-state.md` > `process.md` > 本文。冲突时本文让步。
>
> **不在本文范围**:接口契约字段(回 [`v2-api-contract.md`](v2-api-contract.md))、数据模型(回 [`prisma/schema.prisma`](../prisma/schema.prisma))、COS 全套运维(回 [`ops/cos-production-rollout-checklist.md`](ops/cos-production-rollout-checklist.md))、部署平台具体形态(K8s / nginx / Caddy / Helm)、BizCode 翻译(回 [`first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md))。

---

## §0 文档定位 / 用法 / 占位符约定

### 0.1 谁在读

- **首次部署本仓库的开发 / 运维**:从 §1 顺序读到 §10
- **前端联调发起方**:重点 §6 / §9 / §10 / §12
- **维护者复盘**:任一节均可单独入口

### 0.2 怎么读

- 按 §1 → §10 顺序执行;每节末尾的"失败排查"指向 §13 或外部文档
- 命令模板中 `<your-...>` 占位符在**本文档 / 任何 PR / Issue / Slack / 日志**中**永不替换为真实值**(沿 [`ops §11.13`](ops/cos-production-rollout-checklist.md))
- 节内出现 **"待运维 / 业务方确认"** 标注 = 本仓库无法权威给出该数据,必须线下确认后再继续

### 0.3 占位符约定

| 占位符 | 含义 |
|---|---|
| `<your-admin-username>` / `<your-admin-password>` | seed 创建的 SUPER_ADMIN 账号(`.env` 中 `SUPER_ADMIN_USERNAME` / `SUPER_ADMIN_PASSWORD`) |
| `<your-admin-jwt>` | SUPER_ADMIN 登录后拿到的 JWT(用于后续 admin API 调用) |
| `<your-member-username>` | 维护者创建的"队员级"测试账号 username |
| `<your-member-id>` | `POST /api/v2/members` 创建后取回的 member.id |
| `<api-base-url>` | API 基址(如 `http://localhost:3000`;生产为真实域名) |
| `<your-frontend-domain>` | 前端生产域名(`https://app.example.com` 类) |
| `<your-bucket>` / `<your-region>` / `<your-appid>` | 腾讯云 COS 相关(详见 [`ops §0.3`](ops/cos-production-rollout-checklist.md)) |

**铁律**:占位符**永不**替换为真实值后入仓 / 入 PR / 入聊天工具 / 入文档协作平台。

### 0.4 本文档不做的事

- ❌ 不复制 [`README.md`](../README.md) / [`.env.example`](../.env.example) / [`deployment.md`](deployment.md) / [`security.md`](security.md) / [`ops/cos-production-rollout-checklist.md`](ops/cos-production-rollout-checklist.md) 等权威源原文
- ❌ 不写任何真实密钥 / 密码 / 域名 / bucket / APPID / SecretId / SecretKey / JWT 内容
- ❌ 不写 nginx / Caddy / K8s manifests / Helm chart / Docker compose 生产形态
- ❌ 不新增 seed 数据 / dict_item 真实取值 / 测试账号具体凭据 / 组织节点
- ❌ 不修改 schema / src / env 字段 / Provider 实现
- ❌ 不解决 P0-E(refresh token)/ P0-F(RBAC 收紧)的评审议题(P0-D 修改密码已落地于 #115 / #116 / #117;入口见 §9.1)

---

## §1 环境前置

### 1.1 运行时版本

| 项 | 要求 | 验证 |
|---|---|---|
| Node.js | ≥ 22 LTS(沿 [`README §环境要求`](../README.md)) | `node -v` |
| pnpm | 10.14.0(`package.json#packageManager` 已钉死) | `pnpm -v` |
| Docker(dev 必须;staging / prod 视部署平台) | 任意支持 compose v2 的版本 | `docker --version` && `docker compose version` |
| OpenSSL(生成密钥) | 任意 | `openssl version` |

**禁止**使用 `npm` / `yarn` / `bun`(沿 [`CLAUDE.md §0`](../CLAUDE.md))。

### 1.2 仓库 / 分支 / commit 校验

```bash
git rev-parse --short HEAD                       # 期望:与目标 release 对应(如 v0.12.0 → 231958b)
grep '"version"' package.json                    # 期望:与 git tag 一致
grep 'setVersion' src/bootstrap/apply-swagger.ts # 期望:与 package.json 一致
gh release list --limit 1                        # 期望:Latest 与本次部署目标版本一致
git status --short                               # 期望:空
```

四方版本不一致 → **暂停部署**,先与维护者对齐(沿 [`process.md §2`](process.md))。

### 1.3 必读文档入口

部署前必须扫一遍以下文档(只读;不必逐字读完):

| 文档 | 关注点 |
|---|---|
| [`docs/current-state.md`](current-state.md) | 当前版本 / open PR / 风险账单 |
| [`README.md`](../README.md) | 项目快速概览 / 路由总览 |
| [`docs/deployment.md`](deployment.md) | Docker 镜像 / 生产 env / migration 触发原则 |
| [`docs/security.md`](security.md) | 已落地安全策略 / 密码 / 软删除 |
| [`docs/first-release-readiness-plan.md`](first-release-readiness-plan.md) | 第一版剩余账本(P0-A..I) |
| [`docs/first-release-frontend-scope.md`](first-release-frontend-scope.md) | 前端联调起步包 51 接口(P0-D PR-3 #117 后)|
| [`docs/first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md) | BizCode 124 条翻译(含 P0-D 新增 10005 / 10006)|
| [`docs/ops/cos-production-rollout-checklist.md`](ops/cos-production-rollout-checklist.md) | 仅 staging / prod 走 COS 时必读 |

---

## §2 环境变量装机

### 2.1 一次性密钥 vs 会变配置

按"装机几次"分类(完整字段定义见 [`.env.example`](../.env.example),本文不复制):

| 类别 | 字段 | 说明 |
|---|---|---|
| **一次性 / 装机后不轻易换** | `JWT_SECRET` / `STORAGE_ENCRYPTION_KEY` / `SUPER_ADMIN_USERNAME` / `SUPER_ADMIN_PASSWORD` | 密钥 / 默认账号;换 = 等同密钥轮换(沿 [`ops §6.4`](ops/cos-production-rollout-checklist.md))|
| **会变 / 部署后可改** | `APP_CORS_ORIGIN` / `DATABASE_URL` / `LOG_LEVEL` / `LOGIN_THROTTLE_*` / `RBAC_CACHE_TTL_SECONDS` | 前端域名变更 / DB 切换 / 日志调档需更新 |
| **运行时可改(不在 env)** | Storage Settings(`providerType` / `bucket` / `region` / `keyPrefix` / TTL / 凭证)| 经 `PATCH /api/v2/storage-settings` + `POST /api/v2/storage-settings/reset-credentials`,详见 §8 / [`ops §7-§8`](ops/cos-production-rollout-checklist.md) |

### 2.2 production 启动强校验红线

`APP_ENV=production` 启动时,以下任一不满足 = **立即抛错退出,不 fallback**(沿 [`CLAUDE.md §14`](../CLAUDE.md)):

- `JWT_SECRET` 长度 < 32 或等于 `.env.example` 默认占位
- `APP_CORS_ORIGIN` 为空或 `*`
- `ENABLE_SWAGGER` 误写为 `'TRUE'` / `'1'`(必须严格 `=== 'true'`)
- `STORAGE_ENCRYPTION_KEY` 缺失或长度 < 32
- seed 阶段:`SUPER_ADMIN_USERNAME` = `admin` 或 `SUPER_ADMIN_PASSWORD` 等于 `.env.example` 默认占位

完整列表见 [`.env.example`](../.env.example) 注释 + [`CLAUDE.md §14`](../CLAUDE.md);本文不复制。

### 2.3 .env 生成防留痕(production)

```bash
# 1. 生成 JWT_SECRET(不要回显)
openssl rand -base64 48 > /tmp/jwt_secret.txt && chmod 600 /tmp/jwt_secret.txt

# 2. 生成 STORAGE_ENCRYPTION_KEY(不要回显)
openssl rand -base64 32 > /tmp/storage_key.txt && chmod 600 /tmp/storage_key.txt

# 3. 用编辑器拼装 .env(禁止 echo / printf 把密钥写入 shell 命令)
$EDITOR /path/to/.env

# 4. 销毁临时文件
shred -u /tmp/jwt_secret.txt /tmp/storage_key.txt
```

`STORAGE_ENCRYPTION_KEY` 与 COS 凭证**禁止同存**(沿 [`ops §11.10`](ops/cos-production-rollout-checklist.md));生成 + 注入 + history 防留痕的完整流程见 [`ops §6`](ops/cos-production-rollout-checklist.md) / [`ops §8.2`](ops/cos-production-rollout-checklist.md)。

---

## §3 数据库初始化

### 3.1 dev:本地容器化 PostgreSQL

```bash
cp .env.example .env                    # 仅 dev 允许使用 .env.example 默认值
docker compose up -d postgres           # 起 u-nest-api-postgres(沿 docker-compose.yml)
pnpm install
pnpm prisma:migrate                     # 应用 migration + 自动 generate Prisma Client
```

`docker compose ps` 中 `u-nest-api-postgres` 显示 `healthy` 才继续下一步。

### 3.2 staging / prod:外置 PostgreSQL

- **不**使用仓库内 `docker-compose.yml`(`docker-compose.yml` 仅供本地 dev;沿 [`deployment.md §V1.1 已落地`](deployment.md))
- DB 由部署平台 / DBA 提供;`DATABASE_URL` 写入部署平台 env(不要写进镜像)
- **只允许** `pnpm prisma:deploy`(应用已审查、已提交的 migration)
- **禁止** `pnpm prisma:migrate`(`prisma migrate dev` 在生产可能生成新 migration / drift 修复,沿 [`CLAUDE.md §0`](../CLAUDE.md))

### 3.3 migration 触发方式

应用 runner 镜像**不会**在启动时自动执行 migration(详见 [`deployment.md §生产数据库迁移原则`](deployment.md))。可选触发方式:

- CI/CD pipeline 在应用副本启动**前**独立步骤跑 `pnpm prisma:deploy`
- K8s `Job` / `initContainer` / Helm pre-upgrade hook(本仓库不提供具体 manifest)
- 平台一次性 migration job

**铁律**:多副本启动时 migration 必须串行完成在前;Prisma `migration_lock.toml` 不保证并发安全。

### 3.4 失败排查入口

| 现象 | 入口 |
|---|---|
| 连接错误 / `ECONNREFUSED` | [`development.md §排错`](development.md) |
| migration 报 drift / lock | 暂停;先与维护者对齐;不擅自 `prisma migrate resolve` |
| 启动 fail-fast(env 不全)| [`CLAUDE.md §14`](../CLAUDE.md) 启动强校验项 |

---

## §4 seed 执行

### 4.1 一行命令

```bash
pnpm prisma:seed
```

### 4.2 seed 落地内容(只读说明;详细见 [`prisma/seed.ts`](../prisma/seed.ts) 文件头注释)

| 阶段 | 内容 | 是否覆盖既有 |
|---|---|---|
| SUPER_ADMIN | 按 `.env` `SUPER_ADMIN_USERNAME` / `_PASSWORD` / `_EMAIL` 创建 1 个 SUPER_ADMIN 用户 | ❌ 已存在不覆盖密码 / 角色 / 邮箱(仅打印提示)|
| V2 字典 16 个 type + demo items | 通过 `V2_DICT_SEED` upsert + `update: {}` 幂等 | ❌ 不覆盖 label / sortOrder / status(防回退运营手动调整)|
| `activity_type` 父子树 | 独立函数 `seedActivityTypeHierarchy`;3 父项 + 4 子项 demo | ❌ 同上 |
| RBAC 14 条 `rbac.*` permission + `ops-admin` 角色 + role-permission 映射 | upsert 幂等 | ❌ 同上 |
| RBAC bootstrap user_role | env `RBAC_INITIAL_OPS_ADMIN_USER_ID` 优先;否则 fallback 到首个活跃 SUPER_ADMIN(按 createdAt asc) | ❌ upsert 复合唯一键 |
| Attachment 20 条 `attachment.*` permission + `member` 角色 + 9 条 role-permission(`.self` ×8 + `activity.view`)| upsert 幂等 | ❌ 同上 |

**seed 不创建**:任何组织节点 / 队员 / 队员档案 / 紧急联系人 / 证书 / 活动 / 报名 / 考勤 / 附件 / Storage Settings / 任何真实业务字典 item。

### 4.3 RBAC_INITIAL_OPS_ADMIN_USER_ID 用法

- 留空(推荐):seed 自动用刚创建的 SUPER_ADMIN 作为首个 ops-admin 持有者
- 显式指定:已存在 User.id;seed 校验该用户存在 + ACTIVE + 未软删,否则 throw 退出
- **强校验**:seed 完成时必须 ≥ 1 个活跃用户持有 `ops-admin`,否则抛错

### 4.4 seed 失败排查

| 错误 | 含义 | 处置 |
|---|---|---|
| `[seed] SUPER_ADMIN_USERNAME 格式无效` | username 不符合 `^[a-z0-9_-]{3,32}$` | 改 `.env`,归一化后重跑 |
| `[seed] APP_ENV=production 时禁止 SUPER_ADMIN_USERNAME=admin` | 生产用默认值 | 改 `.env` |
| `[seed] RBAC bootstrap 强校验失败:活跃 ops-admin 持有者数 = 0` | env + SUPER_ADMIN fallback 都没命中 | 检查 SUPER_ADMIN 是否成功创建 / `RBAC_INITIAL_OPS_ADMIN_USER_ID` 是否指向有效 user |
| `[seed] attachment seed 强校验失败:期望找到 N 条...实际查到 M` | code-side 改动后未同步 seed 常量 | 暂停;反馈维护者(D 档,不在本 SOP 范围处理)|

---

## §5 RBAC 初始状态(只读说明)

### 5.1 seed 后立刻可见的状态

- **Permissions**:14 条 `rbac.*` + 20 条 `attachment.*` = 34 条
- **Roles**:`ops-admin`(RBAC 自身 CRUD)+ `member`(USER 内置占位)
- **Role-Permissions**:`ops-admin` ↔ 14 条 `rbac.*` / `member` ↔ 9 条(8 条 `.self` + 1 条 `activity.view`)
- **User-Roles**:1 条 — 首个 SUPER_ADMIN 持有 `ops-admin`

### 5.2 v1 `Role` 与 RBAC 双轨边界

当前(v0.12.0)状态(沿 [`current-state.md §4 P0`](current-state.md)):

- 业务模块绝大多数仍走 `@Roles(Role.SUPER_ADMIN, Role.ADMIN)`(Guard 入口)
- **只有 `attachments` 一个业务模块真正接入 `rbac.can()`**(Service 层判权)
- 双轨并存是当前事实;**不在 P0-C 范围内推动整体迁移**(那是 P0-F 评审 + Slow-4 79 接口工作量)

### 5.3 `ops-admin` / `member` 内置角色的运营路径

- `ops-admin`:RBAC 自身配置 + 用户角色分配的 meta 角色;新增持有者经 `POST /api/v2/users/:userId/roles`(v1 前端**不接**;管理员后台 / 运维直调)
- `member`:USER 内置 placeholder;**seed 不自动给任何 user 绑定**;需要时显式调 `POST /api/v2/users/:userId/roles`(沿 [`prisma/seed.ts`](../prisma/seed.ts) §C-7 注释)

### 5.4 ADMIN 边界未拍板

当前 `@Roles(Role.SUPER_ADMIN, Role.ADMIN)` 给 ADMIN 全权管理(包括敏感字段读 / 凭证录入)。**这是已知风险**,留 P0-F 评审 + Slow-3 业务方拍板。

P0-C SOP **不解决** ADMIN 边界;只如实标注现状。

---

## §6 字典 `dict_type` 依赖清单

### 6.1 前端联调起步包必须先在 dict_items 录入的 14 个 type code

清单为 [`first-release-frontend-scope.md §9`](first-release-frontend-scope.md) 的开放数据(可复制以便本文自包含查阅):

| # | `dict_type.code` | 引用字段 | 用途模块 | seed 是否预置 demo items |
|---|---|---|---|---|
| 1 | `node_type` | `nodeTypeCode` | organizations | ✅ |
| 2 | `member_grade` | `gradeCode` | members | ✅ |
| 3 | `gender` | `genderCode` | member-profiles | ✅ |
| 4 | `document_type` | `documentTypeCode` | member-profiles | ✅ |
| 5 | `political_status` | `politicalStatusCode` | member-profiles | ✅ |
| 6 | `blood_type` | `bloodTypeCode` | member-profiles | ✅ |
| 7 | `work_nature` | `workNatureCode` | member-profiles | ✅ |
| 8 | `emergency_relation` | `relationCode` | emergency-contacts | ✅ |
| 9 | `cert_type` | `certTypeCode` | certificates | ✅ |
| 10 | `cert_sub_type` | `certSubTypeCode` | certificates | ✅ |
| 11 | `activity_type` | `activityTypeCode` | activities(二级树) | ✅ |
| 12 | `gender_requirement` | `genderRequirementCode` | activities | ⓘ seed 未预置(bootstrap 前置项;详见下方说明) |
| 13 | `attendance_role` | `attendanceRoleCode` | attendances | ✅ |
| 14 | `attendance_status` | `attendanceStatusCode` | attendances | ✅ |

> **#12 `gender_requirement` bootstrap 前置项**:`activities` 业务代码引用了该 dict_type(`activities.service.ts` / `activities.dto.ts`),但 `prisma/seed.ts` `V2_DICT_SEED` 未预置(seed 范围只覆盖 §4.2 列出的 16 个 type)。这是一个已知的 bootstrap 前置项,**不要求本 PR 修 seed**;处理方式:
>
> - 若第一版联调**涉及**活动报名性别限制字段:运营经 admin 接口先补录,即 `POST /api/v2/dict-types`(创建 type)+ `POST /api/v2/dict-items`(录入真实 items),再进入 §10 前端联调
> - 若第一版联调**不涉及**该字段:直接在 `POST /api/v2/activities` 时省略 `genderRequirementCode`(字段可选)
>
> 真实 items 取值由业务方线下提供,**不进 git history**(沿 §6.2 / R13)。

seed 额外创建的 3 个闭集 status 字典(`cert_status` / `activity_status` / `registration_status` / `attendance_sheet_status`)是**后端状态机闭集**,前端只读不写,不在本表。

### 6.2 demo items 与真实运营 items 的关系

- **seed 中 demo items 为 placeholder**(`demo-*` 前缀英文 code + `Demo *` label / 部分批次为中文 demo);**不代表任何真实业务取值**
- seed 用 `upsert + update: {}` 幂等,**不会覆盖运营运行时手动调整**;真实业务取值由运营经 admin 接口(`POST /api/v2/dict-items`)线上录入
- 真实业务取值(部门 / 等级 / 证书名 / 活动类型等)**禁止入 git history**(沿 [`CLAUDE.md §18.2`](../CLAUDE.md) / R13);**禁止在本 SOP 中列举或示例**

### 6.3 录入流程(运营侧;P0-C 仅给入口)

1. 维护者登录拿 `<your-admin-jwt>`(详见 §9.6)
2. 视需要 `POST /api/v2/dict-types`(若 type code 缺失,如 §6.1 #12)
3. `POST /api/v2/dict-items`(批量录入真实取值;字段 code / label / parentId 由业务方提供)
4. 校验:`GET /api/v2/dict-items?dictTypeCode=<code>` 应返回包含新录入的 items

**禁止**:在本 SOP 内或仓库 PR 中粘贴真实业务字典取值。

---

## §7 组织树初始状态

### 7.1 seed 不创建任何组织节点

`prisma/seed.ts` 不写 `Organization` 表;初始数据库内 `organization` 表为空,组织树为空。

### 7.2 第一个组织节点创建路径

- **前置**:`node_type` dict_type 必须已有 ≥ 1 条 active `dict_item`(seed 提供 demo items;真实节点类型由业务方录入)
- **权限**:`@Roles(Role.SUPER_ADMIN, Role.ADMIN)`(沿当前 controller 标注)
- **接口**:`POST /api/v2/organizations`,入参 `nodeTypeCode` 必须在 `node_type` dict 白名单内
- **单根上限 + last-root 保护**:第一个节点可作为根节点(`parentId = null`);只允许 1 个根(沿 [`current-state.md §2`](current-state.md));删除最后一个根会触发保护

### 7.3 失败排查

| 现象 | 入口 |
|---|---|
| `ORGANIZATION_NODE_TYPE_INVALID`(11011)| §6 dict_items 是否录入 `node_type` 真实取值 |
| `ORGANIZATION_ROOT_ALREADY_EXISTS`(11032)| 单根上限触发;已存在根节点 |
| 其它 11xxx | 回 [`first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md) 翻译表 |

---

## §8 附件配置初始状态

### 8.1 三张附件配置表初始状态

| 表 | seed 是否预置 | 初始状态 |
|---|---|---|
| `attachment_type_configs`(ownerType 白名单)| ❌ | 空表;**前端联调前必须录入**(详见 §8.2)|
| `attachment_mime_configs`(MIME 白名单)| ❌ | 空表;**前端联调前必须录入** |
| `attachment_size_limit_configs`(size 上限按 ownerType)| ❌ | 空表;**前端联调前必须录入** |

三表为空时,`POST /api/v2/attachments/upload-url` 会直接返 13010 / 13012 / 13013(对应 owner type / MIME / size 校验失败)。

### 8.2 前端联调前最小录入内容

- **`attachment_type_configs.code`**:至少录入 `member` / `certificate` / `activity` 三个 ownerType(沿 [`first-release-frontend-scope.md §7.2`](first-release-frontend-scope.md) 引用场景);真实清单**待业务方确认**
- **`attachment_mime_configs`**:至少录入起步包要用的 MIME(图片 / PDF 等;具体清单**待业务方确认**)
- **`attachment_size_limit_configs`**:按 ownerType 设上限(具体数值**待业务方 / 运维确认**)
- 三表 CRUD 接口归属:[`first-release-frontend-scope.md §6 不接清单`](first-release-frontend-scope.md)(运维 / 后台维护,**前端第一版不接**)

### 8.3 Storage Provider 选型

| 环境 | 默认推荐 | 备注 |
|---|---|---|
| dev | `LocalProvider`(`STORAGE_LOCAL_ROOT` 留空 = `./tmp/storage`)| 本地无需 COS;`.gitignore` 已排除 `tmp/` |
| staging | **不强制**;两种路径并存(运维侧择一) | A. `LocalProvider`:与 dev 一致,简单<br>B. 独立 COS staging bucket:更接近 prod,需走 [`ops §1-§8`](ops/cos-production-rollout-checklist.md) 全套 |
| prod | `CosProvider` | 必须走 [`ops/cos-production-rollout-checklist.md`](ops/cos-production-rollout-checklist.md) §1-§9 全套(bucket / IAM / CORS / lifecycle / SSE / Storage Settings 初始化 + reset-credentials + 闭环验收)|

### 8.4 Storage Settings 初始化(staging / prod 必做)

- 详见 [`ops §7 后台 Storage Settings 初始化`](ops/cos-production-rollout-checklist.md)
- 详见 [`ops §8 reset-credentials 凭证录入`](ops/cos-production-rollout-checklist.md)
- 详见 [`ops §9 闭环验收 5 步`](ops/cos-production-rollout-checklist.md)
- **本 SOP 不复制**;直接顺序执行 ops 文档

---

## §9 测试账号矩阵创建

> 最小依赖矩阵沿 [`first-release-frontend-scope.md §10`](first-release-frontend-scope.md):≥ 3 个账号(SUPER_ADMIN / ADMIN / USER+memberId)+ 1 个可选(USER 不绑 member)。
>
> 本节**只给创建路径**;**永不**列出真实 username / password / email / memberNo。

### 9.1 SUPER_ADMIN(来源:seed)

由 `pnpm prisma:seed` 创建;用 `.env` 中 `SUPER_ADMIN_USERNAME` / `SUPER_ADMIN_PASSWORD` 登录。

**建议**(P0-D PR-3 #117 起):SUPER_ADMIN 登录后立即调 `PUT /api/users/me/password`(入参 `{ oldPassword, newPassword }`),改掉 `.env` 中的默认占位密码(production 启动校验已拒绝 `ChangeMe123456`,但仍建议在线轮换为新强口令)。接口特性:

- 鉴权:任意登录用户均可改自己的密码
- 限流:独立 throttler `password-change`,IP 维度 5 次 / 60 秒(`PASSWORD_CHANGE_THROTTLE_LIMIT` / `PASSWORD_CHANGE_THROTTLE_TTL_SECONDS` 可配)
- audit:成功写 `password.change.self` 事件(不含 `oldPassword` / `newPassword` / `passwordHash` 任何明文或 hash)
- token 行为:**改密后旧 token 仍有效**(沿 [`security.md` Token 吊销升级路径](security.md));如需立即阻断,沿用管理员把目标用户 `status` 改 `DISABLED` 的现有机制;`tokenVersion` / refresh token / token revoke 仍归 **P0-E** 统一评审,本接口**不**预实现

### 9.2 ADMIN 创建(SUPER_ADMIN 登录后调 API)

```bash
# Step 1:SUPER_ADMIN 登录拿 JWT(凭据从安全位置取,不要 echo 到 shell history)
curl -X POST '<api-base-url>/api/auth/login' \
  -H 'Content-Type: application/json' \
  --data-binary @/path/to/super-admin-login.json
# 期望:{ "code": 0, "data": { "accessToken": "<your-admin-jwt>" } }

# Step 2:创建 ADMIN 账号(凭据写入临时文件,不要命令行直传)
TMPBODY=$(mktemp) && chmod 600 "$TMPBODY"
$EDITOR "$TMPBODY"
# 文件内容(占位符示意,真实值线下填):
# {
#   "username": "<your-admin-username>",
#   "password": "<your-admin-password>",
#   "email": "<optional-email>",
#   "role": "ADMIN"
# }

curl -X POST '<api-base-url>/api/users' \
  -H "Authorization: Bearer <your-admin-jwt>" \
  -H 'Content-Type: application/json' \
  --data-binary @"$TMPBODY"

shred -u "$TMPBODY"
```

校验:返回 `UserResponseDto`(含 `id` / `role: "ADMIN"` / `status: "ACTIVE"`);响应**永不**含 `passwordHash`。

### 9.3 USER + 绑定 memberId(接口缺口,联调前必须确认)

队员侧本人接口(`GET /api/v2/users/me/registrations` / `attendance-records` 等)需要 user 与 member 关联,体现在 `User.memberId` 字段(沿 [`prisma/schema.prisma`](../prisma/schema.prisma):字段存在,`@unique`,可空,`onDelete: SetNull`)。

**当前事实**(只读核查 v0.12.0 代码):

- `User.memberId` 是 schema 字段,但 `CreateUserDto`(`POST /api/users`)与 `UpdateUserDto`(`PATCH /api/users/:id`)**均不接受** `memberId`(沿 [`src/modules/users/users.dto.ts`](../src/modules/users/users.dto.ts);全局 `forbidNonWhitelisted: true` 会直接拒绝额外字段并返 `BAD_REQUEST`)
- 仓库内**尚无**业务 API 暴露"把 user 绑定到 member"的写入路径;`members` / `member-departments` / `auth` / `jwt.strategy` 等模块只读取 `users.memberId`,不提供写入入口
- `members.service.ts` 软删队员前会反查 `users.memberId` 防悬空外键(只读保护,不能用于绑定)

**SOP 第一版联调铁律**:

- **不得**假设可以通过 `POST /api/users` 携带 `memberId` 完成绑定
- **不得**假设可以通过 `PATCH /api/users/:id` 修改 `memberId`
- 第一版联调如确需 user ↔ member 绑定(队员侧本人接口的完整闭环),**绑定路径属于已识别接口缺口,需另行 D 档评审**(候选形态:`members` 模块新增子资源端点 / `users` 模块新增专属绑定端点 / 仅维护者经 DB 直改;选型不在 P0-C 范围)
- 在接口缺口未填补前,**测试账号侧最小可走路径**:走 §9.4 创建独立 USER,不绑 member;此账号可登录、可调 `/api/users/me`,但**队员侧本人接口(`/api/v2/users/me/registrations` / `attendance-records` 等)的可用性以代码实际行为为准**

**创建 Member 自身的入口(用于 admin 视角接口验证,不直接绑定到任何 user)**:

```bash
# 入参 memberNo 全局唯一不复用;真实编号由业务方提供;不要编造
curl -X POST '<api-base-url>/api/v2/members' \
  -H "Authorization: Bearer <your-admin-jwt>" \
  -H 'Content-Type: application/json' \
  --data-binary @/path/to/member-body.json
# 期望:{ "code": 0, "data": { "id": "<your-member-id>", "memberNo": "...", ... } }
```

### 9.4 USER(不绑 member;当前 `POST /api/users` 唯一可走路径)

同 §9.2 创建路径,`role=USER`,**不传** `memberId`(`CreateUserDto` 不接受,传了会被全局 `forbidNonWhitelisted` 拒绝)。

这是当前仓库内 `POST /api/users` 创建队员级账号的唯一可走路径;**真正的 user ↔ member 绑定能力需 §9.3 接口缺口拍板后另行立项**,不在本 SOP 解决范围。

### 9.5 不要做的事

- ❌ **不**给 seed 加测试账号(沿 [`CLAUDE.md §0`](../CLAUDE.md) seed 改动 = D 档;P0-C 不在范围)
- ❌ **不**在仓库内任何位置写真实 username / password / email
- ❌ **不**用弱口令(沿 [`CLAUDE.md §3`](../CLAUDE.md) 字段校验:密码 ≥ 8 位 + 含数字 + 字母;真实账号建议更强)
- ❌ **不**在创建 ADMIN 后忘记轮换 / 隔离凭据存储

### 9.6 校验账号生效

```bash
# 1. 用新账号登录
curl -X POST '<api-base-url>/api/auth/login' \
  -H 'Content-Type: application/json' \
  --data-binary @/path/to/new-account-login.json
# 期望:{ "code": 0, "data": { "accessToken": "..." } }

# 2. 调本人接口
curl -X GET '<api-base-url>/api/users/me' \
  -H "Authorization: Bearer <token>"
# 期望:{ "code": 0, "data": { "id": "...", "username": "...", "role": "...", ... } }
```

登录失败统一返 `LOGIN_FAILED`(10004,HTTP 401);四场景(用户不存在 / 密码错 / DISABLED / 已软删)响应体完全相同(沿 [`CLAUDE.md §8`](../CLAUDE.md) 防账号枚举)——前端**不能**据响应区分原因。

---

## §10 前端联调前置检查 checklist

> 沿 [`first-release-frontend-scope.md §11 联调包齐备判定`](first-release-frontend-scope.md) + 本 SOP §1-§9 完成情况。

### 10.1 服务自检(后端 + DB)

```bash
curl '<api-base-url>/api/health/live'
# 期望:HTTP 200 + { "code": 0, "message": "ok", "data": { "status": "ok" } }

curl '<api-base-url>/api/health/ready'
# 期望:HTTP 200 + { "code": 0, ..., "data": { "status": "ok", "db": "up" } }
# 失败(DB 不可达):HTTP 500 + { "code": 50000, "message": "服务器内部错误", "data": null }
```

### 10.2 登录链路

```bash
# 用 §9 任一测试账号登录
curl -X POST '<api-base-url>/api/auth/login' \
  -H 'Content-Type: application/json' \
  --data-binary @/path/to/login.json
# 期望:HTTP 200 + accessToken
```

### 10.3 本人接口

```bash
curl '<api-base-url>/api/users/me' \
  -H "Authorization: Bearer <token>"
# 期望:HTTP 200 + UserResponseDto
```

### 10.4 字典只读

```bash
curl '<api-base-url>/api/v2/dict-items?dictTypeCode=node_type' \
  -H "Authorization: Bearer <token>"
# 期望:HTTP 200 + 非空 items(seed demo 已写入)

curl '<api-base-url>/api/v2/dict-items?dictTypeCode=gender_requirement' \
  -H "Authorization: Bearer <token>"
# 期望(seed 未预置):HTTP 200 + 空 items;运营录入后非空(详见 §6.1 #12)
```

### 10.5 组织树初始

```bash
curl '<api-base-url>/api/v2/organizations' \
  -H "Authorization: Bearer <token>"
# 期望(seed 后,未建任何节点):HTTP 200 + { items: [], total: 0, page: 1, pageSize: 20 }
```

### 10.6 附件上传链路最小验

```bash
# 前置:§8.2 三表已录入最小配置;§9.3 创建测试 member 拿到 <your-member-id>
curl -X POST '<api-base-url>/api/v2/attachments/upload-url' \
  -H "Authorization: Bearer <token>" \
  -H 'Content-Type: application/json' \
  -d '{
    "ownerType": "member",
    "ownerId": "<your-member-id>",
    "originalName": "test.png",
    "mime": "image/png",
    "sizeBytes": 1024
  }'
# 期望:HTTP 200 + 6 字段(key / uploadUrl / uploadHeaders / uploadMethod / expiresAt / uploadToken)
# 失败 13010 → §8.2 ownerType=member 是否录入
# 失败 13011 → ownerId 是否存在
# 失败 13012 → MIME 是否在白名单
# 失败 13013 → size 是否超限
# 完整 5 步闭环验收回 [`ops §9`](ops/cos-production-rollout-checklist.md)
```

### 10.7 CORS / 域名

- `APP_CORS_ORIGIN` 必须显式列出**前端实际访问域名**(含协议;production 禁用 `*`)
- 前端使用 `Authorization: Bearer <token>` 时,后端必须放行 `Authorization` 头(helmet + CORS 已配,沿 [`deployment.md §V1.1 已落地`](deployment.md))
- 反向代理 / HTTPS 终止 / 域名解析:**待运维确认**;具体形态见 [`deployment.md`](deployment.md);**本 SOP 不写 nginx / Caddy 范例**

---

## §11 dev / staging / prod 三环境差异表

> 只列与 dev 不同处;dev 走 §1-§4 基础流程即可。

| 维度 | dev | staging | prod |
|---|---|---|---|
| `APP_ENV` | `development` | **`production`**(staging 应用按 production 模式启动;详见本节下方说明)| **`production`** |
| `ENABLE_SWAGGER` | 留空 / `true` | 默认关;运维评审后可显式开 | **禁止默认开**;评审后显式 `true` |
| `JWT_SECRET` | 可用 `.env.example` 默认 | **必须** ≥ 32 + 非默认 | **必须** ≥ 32 + 非默认 |
| `APP_CORS_ORIGIN` | `http://localhost:5173` 类 | staging 前端域名(HTTPS) | 真实生产域名(HTTPS;禁用 `*`)|
| `STORAGE_ENCRYPTION_KEY` | 可留空(走 Local 无凭证)| 视 Provider 选型:Local 可空 / COS **必填** ≥ 32 | **必填** ≥ 32 |
| `SUPER_ADMIN_USERNAME` | `admin` | 自定义(非 `admin`)| 自定义(强制 ≠ `admin`)|
| `SUPER_ADMIN_PASSWORD` | `ChangeMe123456` | 强口令 | 强口令(强制 ≠ `.env.example` 默认值)|
| DB | docker compose | 外置 PG | 外置 PG |
| migration 命令 | `pnpm prisma:migrate` | `pnpm prisma:deploy` | `pnpm prisma:deploy` |
| migration 触发 | 本地手动 | CI/CD job(应用启动前)| CI/CD job(应用启动前)|
| Storage Provider | `LOCAL` | **不强制**(运维择 Local / COS,详见 §8.3)| `COS`(走 ops 全套) |
| Storage Settings 凭证录入 | 不必 | 视 Provider | **必做**(走 [`ops §7-§8`](ops/cos-production-rollout-checklist.md))|
| 日志 | `pino-pretty`(自动)| JSON | JSON;敏感字段 `[REDACTED]`(沿 [`security.md`](security.md))|
| 登录限流(`LOGIN_THROTTLE_*`)| 默认 5/60s | 视真实流量;留空走默认 | 视真实流量;留空走默认 |

> **关于 staging 环境的明确规则**:`APP_ENV` 受支持值为 `{ development, test, production, smoke }`(沿 [`.env.example`](../.env.example) 注释),**没有 `staging` 取值,本仓库也不计划新增**。
>
> "staging"在本文中**仅是部署环境名称**(对应一台独立机器 / 一套独立 DB / 一个独立前端域名),应用本身按 `APP_ENV=production` 启动,享有完整启动强校验。dev / staging / prod 三档的实质差异通过以下运行时参数区分,而非 `APP_ENV`:
>
> - `DATABASE_URL`(指向不同 PG 实例 / schema)
> - `APP_CORS_ORIGIN`(staging 前端域名 vs 生产前端域名)
> - `JWT_SECRET` / `STORAGE_ENCRYPTION_KEY`(每环境独立生成,**禁止跨环境复用**)
> - Storage Settings(运行时凭证 + bucket + region;sta / prod 各自独立)
> - COS bucket(staging bucket 与 prod bucket 物理隔离;若 staging 走 LocalProvider 则无此项)
> - 前端域名 / 反代 / HTTPS 终止

---

## §12 5 分钟 dry-run(快速自检)

> 浓缩版:从空机器到"第一个账号能登录、附件链路可走"的最短路径(假定 §1 / §2 已就绪)。

```bash
# 1. 拉代码 + 对齐版本
git rev-parse --short HEAD                              # 与目标 release 一致

# 2. 起 DB(dev)/ 连外置 DB(staging/prod)
docker compose up -d postgres                            # dev 专用
# staging/prod:确保 DATABASE_URL 已注入

# 3. 依赖 + migration
pnpm install
pnpm prisma:migrate                                      # dev
# pnpm prisma:deploy                                     # staging/prod

# 4. seed
pnpm prisma:seed                                         # 日志应包含:[seed] RBAC bootstrap done

# 5. 启动应用
pnpm start:dev                                           # dev
# 或生产镜像启动:见 deployment.md

# 6. 健康检查
curl '<api-base-url>/api/health/live'                   # 期望 HTTP 200 + status:ok
curl '<api-base-url>/api/health/ready'                  # 期望 HTTP 200 + db:up

# 7. SUPER_ADMIN 登录
curl -X POST '<api-base-url>/api/auth/login' \
  -H 'Content-Type: application/json' \
  --data-binary @/path/to/super-admin-login.json        # 期望 accessToken

# 8. 调本人接口
curl '<api-base-url>/api/users/me' -H "Authorization: Bearer <token>"
                                                          # 期望 UserResponseDto

# 9. 字典只读
curl '<api-base-url>/api/v2/dict-items?dictTypeCode=node_type' \
  -H "Authorization: Bearer <token>"                    # 期望非空 items(seed demo)

# 10. 组织树为空
curl '<api-base-url>/api/v2/organizations' \
  -H "Authorization: Bearer <token>"                    # 期望 total: 0
```

10 步全部 ✅ → 后端启动 + DB + seed + 鉴权 + 字典 + 列表查询 链路通。**完整前端联调前置条件**还需 §6.1 #12 / §8.2 / §9 / §10 全部满足。

---

## §13 常见失败 + 排查入口

| 现象 | 入口 |
|---|---|
| 启动 fail-fast(`JWT_SECRET 长度不足` / `APP_CORS_ORIGIN 不能为空` 等)| `.env` 字段是否符合 [`CLAUDE.md §14`](../CLAUDE.md) 启动强校验项 |
| `pnpm prisma:migrate` 报连接错误 | [`development.md §排错`](development.md) |
| `seed` 报 `RBAC bootstrap 强校验失败` | §4.4 |
| `/api/docs` 返 404 | `APP_ENV` + `ENABLE_SWAGGER` 组合(沿 [`development.md §排错`](development.md))|
| 登录返 `LOGIN_FAILED`(10004)| 防账号枚举四场景统一(沿 [`first-release-frontend-scope.md §3.2`](first-release-frontend-scope.md));前端不能据响应区分原因 |
| 登录返 `TOO_MANY_REQUESTS`(42900)| IP 维度限流命中(默认 5/60s);等过 TTL 或换 IP;**不**会暴露阈值 / 剩余配额 / `Retry-After` |
| 已登录后续请求返 `UNAUTHORIZED`(40100)| token 失效 / 用户被禁 / 已软删;**与 10004 区分**,管理员重置密码与本人自助改密(`PUT /api/users/me/password`)**均不主动吊销旧 token**(沿 [`security.md §Token 吊销升级路径`](security.md);改密后立即阻断需把目标 `status` 改 `DISABLED`,tokenVersion / revoke 归 P0-E)|
| 本人改密返 `OLD_PASSWORD_INVALID`(10005)| `PUT /api/users/me/password` 时 `oldPassword` 与当前 `passwordHash` 不匹配;**不要**当成 10004 LOGIN_FAILED 错误重登(已登录态,沿 [`first-release-bizcode-mapping.md §4.2`](first-release-bizcode-mapping.md))|
| 本人改密返 `NEW_PASSWORD_SAME_AS_OLD`(10006)| `newPassword === oldPassword`(严格 === 比较;不 trim/toLowerCase);要求新密码与当前密码不同 |
| `POST /api/v2/attachments/upload-url` 返 13010 | §8.2 `attachment_type_configs` 未录入对应 ownerType |
| 返 13012 | `attachment_mime_configs` 未录入对应 MIME |
| 返 13013 | size 超 `attachment_size_limit_configs` 上限 |
| PUT 直传 COS 返 403 | [`ops §10 #1`](ops/cos-production-rollout-checklist.md)(凭证错 / CORS 错 / signed URL 过期)|
| `reset-credentials` 返 50000 | `STORAGE_ENCRYPTION_KEY` 未注入或长度 < 32(沿 [`ops §6`](ops/cos-production-rollout-checklist.md))|
| 业务字典字段返 invalid(如 11011 / 15010 等)| §6 dict_items 真实取值是否录入 |
| 任何 5xx | 用 `x-request-id` 串日志(沿 [`deployment.md §V1.1 已落地`](deployment.md));详细排错 SOP 留 P0-I |

---

## §14 不在本文范围 / 引用来源 / 文档元信息

### 14.1 不在本文范围

| 类别 | 权威源 |
|---|---|
| 接口字段 / OpenAPI / 完整入参出参 | [`docs/v2-api-contract.md`](v2-api-contract.md) + Swagger `/api/docs` |
| 数据模型 / 字段约束 / 索引 | [`prisma/schema.prisma`](../prisma/schema.prisma) + [`docs/v2-data-model.md`](v2-data-model.md) |
| 完整 BizCode 翻译(124 条;含 P0-D 新增 10005 / 10006)| [`docs/first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md) |
| 前端联调起步包 51 接口(P0-D PR-3 #117 后)| [`docs/first-release-frontend-scope.md`](first-release-frontend-scope.md) |
| 第一版剩余账本 P0/P1/P2 | [`docs/first-release-readiness-plan.md`](first-release-readiness-plan.md) |
| COS 生产链路 12 节运维清单 | [`docs/ops/cos-production-rollout-checklist.md`](ops/cos-production-rollout-checklist.md) |
| 部署 / Docker 镜像 / migration 触发 | [`docs/deployment.md`](deployment.md) |
| 安全策略 / 密码 / 软删除 / Token 吊销 | [`docs/security.md`](security.md) |
| 开发日常 / 环境变量字段 / 排错 | [`docs/development.md`](development.md) |
| 当前事实 / 风险账单 | [`docs/current-state.md`](current-state.md) |
| 协作流程 / PR 分级 / D 档降速 | [`docs/process.md`](process.md) |
| 字典 / RBAC / Attachment seed 行为 | [`prisma/seed.ts`](../prisma/seed.ts) 文件头注释 |
| K8s manifests / Helm / nginx / Caddy / docker-compose.prod | **本仓库不持有**;由部署平台另行维护 |
| Refresh token / logout / RBAC 收紧 | 留 P0-E / P0-F 评审(沿 [`readiness-plan §3.1`](first-release-readiness-plan.md));P0-D 本人改密已落地(见 §9.1)|

### 14.2 引用来源(完整列表)

- [`README.md`](../README.md)
- [`.env.example`](../.env.example)
- [`CLAUDE.md`](../CLAUDE.md) §0 / §3 / §4 / §5 / §8 / §14 / §17 / §18
- [`AGENTS.md`](../AGENTS.md)(与 CLAUDE.md 同步)
- [`docs/deployment.md`](deployment.md)
- [`docs/development.md`](development.md)
- [`docs/security.md`](security.md)
- [`docs/process.md`](process.md)
- [`docs/current-state.md`](current-state.md)
- [`docs/first-release-readiness-plan.md`](first-release-readiness-plan.md)
- [`docs/first-release-frontend-scope.md`](first-release-frontend-scope.md)
- [`docs/first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md)
- [`docs/ops/cos-production-rollout-checklist.md`](ops/cos-production-rollout-checklist.md)
- [`prisma/seed.ts`](../prisma/seed.ts)(只读;不改)
- [`prisma/schema.prisma`](../prisma/schema.prisma)(只读;不改)
- [`docker-compose.yml`](../docker-compose.yml)(只读;不改)

### 14.3 文档元信息

- **状态**:v0.1 草稿(撰写完成,等待维护者确认后入库)
- **PR 标题建议**:`docs(first-release): add zero-to-login bootstrap sop`
- **档位**:**A 档 docs-only**(沿 [`process.md §3`](process.md))
- **本 PR 不夹带**:`README.md` / `docs/current-state.md` / `docs/first-release-readiness-plan.md` / `docs/first-release-frontend-scope.md` 索引更新 / `CHANGELOG.md` / `prisma/seed.ts` / `src/*` / `.env.example` / 任何 schema / migration
- **待运营 / 业务方录入项**(联调前的 bootstrap 前置数据):
  1. §6.1 #12 `gender_requirement` dict_type:当前 seed 未预置;若第一版联调涉及活动报名性别限制字段,由运营经 admin 接口(`POST /api/v2/dict-types` + `POST /api/v2/dict-items`)先补录;**不要求本 PR 修 seed**
  2. §8.2 三张附件配置表(`attachment_type_configs` / `attachment_mime_configs` / `attachment_size_limit_configs`)的 ownerType / MIME / size 真实清单

- **待运维 / 部署平台确认项**(基础设施层面):
  1. §10.7 反向代理 / HTTPS 终止 / 域名解析 / 真实 CORS 域名

- **已识别接口缺口**(需另行 D 档评审,不在 P0-C 范围;沿 [`process.md §3`](process.md)):
  1. §9.3 user ↔ member 绑定路径:`CreateUserDto` / `UpdateUserDto` 均不接受 `memberId`;仓库内无业务 API 暴露绑定能力;`User.memberId` schema 字段存在但运行时无写入入口。第一版联调如需依赖队员侧本人接口的完整闭环,需先评审绑定接口形态(候选:`members` 子资源 / `users` 专属端点 / DB 直改)再立项实施

### 14.4 撰写边界声明

- 本文档**不引入新事实**;所有数据 / 命令 / 字段名均来自已合入 main 的代码与文档
- 本文档**不调和**已存在的双源描述差异(发现差异原样标注,不擅自统一)
- 本文档**不替代** [`first-release-readiness-plan.md`](first-release-readiness-plan.md) 中其他 P0 项(P0-B / P0-D / P0-E / P0-F / P0-H / P0-I)的独立产物
