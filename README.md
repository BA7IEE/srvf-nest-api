# 深圳公益救援队数字化平台

> **Shenzhen Rescue Volunteers Federation Digital Platform · SRVF-DP**  
> **深圳公益救援队的组织数字化业务底座**  
> 面向深圳公益救援队组织运行与业务协同建设的一体化数字化平台。

**深圳公益救援队数字化平台**不是单一的“考勤系统”或“队员管理后台”，而是围绕公益救援组织真实运行模型建设的 **API-first 组织数字化业务底座**。

平台以组织、人员、身份和权限为统一基础，逐步承载招新入队、活动管理、报名参与、签到考勤、贡献结算、保险资质、内容发布、统一通知及外部平台接入等业务，形成统一的数据基础、业务规则与服务接口。

当前平台首先服务于深圳公益救援队的实际业务需求。未来是否扩展为面向其他公益救援组织的通用平台，以正式业务决策与架构评审为准；README 不把“通用 SaaS / 多租户”描述为当前既成事实。

> **命名说明**：平台正式简称是 `SRVF-DP`（Digital Platform）。`SRVF`（Shenzhen Rescue Volunteers Federation）指组织本身，并继续作为既有工程代号使用，例如 `srvf-api`、仓库名及部分工程标识；单独的 `SRVF` 不再作为平台正式名称，避免与“深圳公益救援队”这一组织本身混淆。

---

## 1. 平台解决什么问题

公益救援组织的数字化并不只是“记录谁来过、谁参加过活动”。随着组织规模和业务复杂度增加，真正需要统一管理的是一整套相互关联的运行事实：

- **谁是谁**：账号身份、队员身份、手机号、微信、企业微信等身份如何关联；
- **人属于哪里**：队、部门、小组、主归属、兼任、临时归属等组织关系；
- **谁能做什么**：角色、权限、组织范围、职务与具体资源之间的授权关系；
- **一个人如何进入组织**：报名、身份核验、证书申报、审核、入队与正式队员身份建立；
- **一次活动如何完整闭环**：创建、审核、发布、报名、候补、岗位、责任、签到签退、考勤、结算与贡献记录；
- **关键业务如何留下证据**：审计日志、活动修订、考勤证据、保险资格证据、对象存储账本等；
- **系统如何可靠触达人员**：站内通知、微信、企业微信、短信，以及失败重试与幂等；
- **系统如何长期演进**：API 契约、数据库迁移、权限边界、测试、CI 和 AI Coding 如何避免长期漂移。

因此，深圳公益救援队数字化平台的核心价值不是某一个业务页面，而是建立一套可以持续承载公益救援组织业务的**统一数字化底座**。

---

## 2. 能力地图

```text
                 深圳公益救援队数字化平台
                   组织数字化业务底座

┌──────────────────────── 组织与身份底座 ────────────────────────┐
│ 组织树 · 队员 · 用户账号 · 归属 · 职务 · 任职 · 角色 · 权限 │
└─────────────────────────────┬──────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
     招新与入队          活动与参与          内容与触达
     公开报名            活动创建/审核        CMS 内容
     手机身份链          岗位与责任            站内通知
     实名核验            报名/候补/邀请        微信通知
     证书申报            QR/GPS/现场履约       企业微信
     综合评估            考勤审核              SMS
     入队转正式          结算与贡献
          │                   │                   │
          └───────────────────┼───────────────────┘
                              ▼
                     通用平台与工程基础设施
        Audit · Storage · Outbox · Security · OpenAPI · CI · Harness
```

### 2.1 组织、人员与身份

- 组织树与上下级关系；
- 队员主数据与账号数据分离，`Member` 表达组织成员身份，`User` 表达系统账号身份；
- 主归属、兼任、临时 / 支援等组织关系；
- 职务定义、任职历史、分管关系；
- 手机号、微信小程序、企业微信等身份绑定与换绑；
- 队员账号开通、关闭及生命周期联动。

### 2.2 权限与数据范围

- RBAC 角色与权限码；
- 带 scope 的 RoleBinding；
- GLOBAL 权限与组织 / 资源范围授权分层处理；
- 统一 `AuthzService` 负责需要资源上下文的授权判断；
- 关键权限事实以 PostgreSQL 为真值，不依赖跨请求权限缓存；
- 管理面、队员端、认证、系统配置、公开访问按独立 API Surface 隔离。

### 2.3 招新与入队

- 招新轮次；
- 公开报名与进度查询；
- 手机身份链；
- 实名核验通道；
- 证件 / 图片附件与 OCR 流程；
- 证书标准库与证书申报审核；
- 临时编号；
- 入队轮次、综合评估、贡献汇总；
- 最终建立正式队员身份与组织归属。

### 2.4 活动、参与与履约

活动域已经不是简单的“活动 CRUD”，而是一套持续演进的参与与履约业务上下文，覆盖：

- 活动草稿、发布审核、变更与取消；
- 活动岗位、责任人与管理职责；
- 报名、审核、候补、递补；
- 邀请、访客、现场临时参加；
- first-come / rank / lottery 等分配模式；
- 资格规则、容量与参与修订；
- GPS、QR、现场签到签退及相关证据；
- 工作人员代办、批量与离线履约能力的受控扩展；
- 考勤表、记录、复核与终审；
- 结算版本、贡献账本与更正链路；
- 活动评价与参与汇总。

### 2.5 保障、内容与触达

- 队员证书与证书标准；
- 自购保险、团队保险覆盖与资格证据；
- 成员资料、紧急联系人；
- CMS 内容发布与公开 / 队员可见性；
- 站内通知；
- 微信小程序通知；
- 企业微信应用消息；
- SMS 紧急触达；
- PostgreSQL Durable Outbox + Worker 驱动外部副作用。

### 2.6 文件、审计与可追溯性

- Local / COS Storage Provider；
- Storage Settings 与凭证加密；
- 附件类型、MIME、大小限制；
- Attachment Storage Ledger 与独立一致性 Worker；
- 关键写操作和敏感读取审计；
- 状态修订、Evidence、Ledger 等业务证据链；
- 重要流程优先采用可追踪、可重放、可审计的持久化事实，而不是只依赖进程内状态。

---

## 3. 架构概览

深圳公益救援队数字化平台采用 **API-only / 前后端分离** 的后端架构。NestJS 应用负责 HTTP API 与业务编排，PostgreSQL 是核心业务真值存储；Prisma 负责数据访问与迁移模型；通知和 Storage 等需要异步收敛的副作用由独立 Worker 处理。

```text
 Admin Web / App / H5 / Mini Program / External Client
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                  Digital Platform API                       │
│                                                              │
│  Admin     App      Auth      System      Open               │
│    │        │         │          │          │                 │
│    └────────┴─────────┴──────────┴──────────┘                 │
│                         │                                    │
│            Global Guards / Validation / Logging              │
│                         │                                    │
│               Application / Domain Services                  │
│        Policy · StateMachine · Query · Presenter · Audit      │
│                         │                                    │
│          RBAC / Authz / Audit / Notification / Storage       │
└─────────────────────────┬────────────────────────────────────┘
                          │
                          ▼
                    PostgreSQL + Prisma
                          │
             ┌────────────┴────────────┐
             ▼                         ▼
     Notification / Batch Worker   Storage Worker
             │                         │
             ▼                         ▼
   WeChat / WeCom / SMS               COS
```

### 架构原则

- **业务真值优先落数据库**：身份、权限、业务状态、Outbox、Storage Ledger 等关键正确性不依赖进程内缓存；
- **强约定优先**：统一响应、统一错误码、统一 DTO 校验、统一 API Surface；
- **事务边界明确**：核心业务 Service 保持事务 owner，跨表写入、状态变化、审计和 Outbox 尽量在同一业务事务闭合；
- **外部副作用后置**：外部消息和 Storage Provider 操作不占用核心业务事务；
- **状态机与策略显式化**：复杂模块逐步将状态判断、策略、查询、序列化和审计职责从大 Service 中拆出；
- **契约可机器验证**：OpenAPI、权限地图、模块地图、边界规则和历史事故均有自动化检查；
- **不为未来假设提前堆复杂度**：Redis、通用消息队列、多租户、LLM / Vector 等能力没有业务触发前不默认引入。

---

## 4. API Surface

所有 HTTP API 按客户端和职责划分为 5 个 canonical surface：

| Surface | 前缀 | 用途 |
|---|---|---|
| **Admin** | `/api/admin/v1/*` | PC 管理后台与业务管理面 |
| **App** | `/api/app/v1/*` | 队员端 / 小程序 / Mobile Web |
| **Auth** | `/api/auth/v1/*` | 登录、刷新、登出与身份认证 |
| **System** | `/api/system/v1/*` | 健康检查、系统配置、RBAC、Storage 等平台能力 |
| **Open** | `/api/open/v1/*` | 无账号公开业务，例如招新报名和公开内容 |

完整 endpoint、DTO、错误码与实时契约不在 README 重复维护：

- Swagger UI：`/api/docs`
- OpenAPI JSON：`/api/docs-json`
- 当前状态：[`docs/current-state.md`](./docs/current-state.md)
- Surface 规则：[`docs/api-surface-policy.md`](./docs/api-surface-policy.md)

---

## 5. 核心技术栈

| 层 | 技术 |
|---|---|
| Runtime | Node.js 22+ |
| Framework | NestJS 11 |
| Language | TypeScript |
| Database | PostgreSQL |
| ORM | Prisma 6 |
| Authentication | JWT + Passport |
| Validation | class-validator + class-transformer |
| API Contract | OpenAPI / Swagger |
| Logging | Pino / nestjs-pino |
| Rate Limit | NestJS Throttler + PostgreSQL shared storage |
| Storage | Local / Tencent COS |
| Scheduling | `@nestjs/schedule`（严格受控） |
| Testing | Jest + Supertest + real PostgreSQL E2E |
| Container | Docker multi-stage image |
| Package Manager | pnpm 10.14.0 |

> 具体依赖版本以 [`package.json`](./package.json) 为准，README 不复制所有版本号以避免漂移。

---

## 6. 当前状态与生产边界

深圳公益救援队数字化平台持续高频演进。**代码已经覆盖大量业务能力，不代表所有能力都已完成生产启用或现场验收。**

以下信息必须以 [`docs/current-state.md`](./docs/current-state.md) 为唯一当前事实入口：

- 当前发布 / 生产 GO or NO-GO 边界；
- 已实现但尚未部署的能力；
- Feature Gate 状态；
- 外部通道真实联调状态；
- 当前风险与技术债务；
- 当前模块、Endpoint、Migration、权限码等实时计数。

README 只描述长期稳定的项目定位和架构，不复制这些高频变化数字。

---

## 7. 安全与一致性设计

平台的安全设计不仅是“有 JWT”。当前基础能力包括：

- JWT access / refresh session；
- refresh rotation、family revoke 与绝对过期；
- 密码、短信、微信、企业微信等身份链；
- 身份换绑 step-up proof；
- 账号枚举防护；
- PostgreSQL shared rate limit；
- trusted proxy / client IP 边界；
- Helmet 安全头；
- 请求日志敏感字段脱敏；
- 凭证 AES-256-GCM 加密；
- 敏感 DTO / 响应字段白名单；
- 最后一个高权管理员保护；
- 关键管理写操作与敏感读取审计；
- 生产环境配置 fail-fast；
- 多写操作事务化与关键资源锁序。

完整安全边界见 [`docs/security.md`](./docs/security.md)。

---

## 8. 异步任务与 Worker

平台当前**没有为了“像大系统”而引入 Redis / BullMQ**。

对需要可靠异步处理的业务，当前主要采用 PostgreSQL 持久化任务 / Outbox：

### Notification Outbox Worker

业务事务只写通知 intent；提交成功后由独立 Worker 执行微信、企业微信、SMS 等外部副作用。

```bash
pnpm start:notification-outbox-worker
```

### Storage Consistency Worker

附件对象操作通过 Storage Ledger 记录持久化事实，由独立 Worker 负责一致性收敛、恢复和受控维护。

```bash
pnpm start:storage-consistency-worker
```

具体生产运行方式和切换边界见 [`docs/deployment.md`](./docs/deployment.md) 与 `docs/ops/` 下对应 Runbook。

---

## 9. 工程质量与 AI Coding 治理

平台的工程架构不仅包括运行时代码，还包括一套用于长期演进的机器化治理层。

### 测试层

```bash
pnpm test              # Unit
pnpm test:contract     # OpenAPI contract
pnpm test:e2e          # Real PostgreSQL E2E
pnpm test:journeys     # 跨业务 Golden Journeys
pnpm test:e2e:leaks    # 串行 open-handle 检测
```

E2E 使用独立测试数据库，并支持 per-worker 数据库隔离。详细规则见 [`docs/testing.md`](./docs/testing.md)。

### Harness / Guard

仓库通过 ESLint、自定义脚本、Git hooks 与 CI 对高风险变更做机器守护，包括但不限于：

- API contract drift；
- 权限声明与权限地图；
- 模块 / 架构边界；
- 大 Service 体量棘轮；
- 高风险“红区”文件；
- Prisma 迁移与危险命令；
- 历史事故 replay；
- 自动生成文档的新鲜度；
- AI Coding 授权边界。

常用入口：

```bash
pnpm agent:preflight
pnpm agent:check:quick
pnpm agent:check:api
pnpm agent:check:full
pnpm harness:selftest
pnpm harness:replay
```

长期 AI 协作规则以 [`AGENTS.md`](./AGENTS.md) 为入口；Claude Code 另读 [`CLAUDE.md`](./CLAUDE.md)。

---

## 10. 环境要求

- **Node.js** ≥ 22
- **pnpm** 10.14.0
- **Docker**（本地 PostgreSQL / 容器验证）
- **PostgreSQL** 16（当前工程基线）

> 包管理统一使用 pnpm；具体约束以 [`package.json`](./package.json) 与 [`AGENTS.md`](./AGENTS.md) 为准。

---

## 11. 本地快速启动

> 以下步骤用于本地开发。生产部署不要照搬本节；生产迁移、Storage bootstrap、Feature Gate 与 Worker 运行必须按部署文档和 Runbook 执行。

```bash
# 1. 环境变量
cp .env.example .env

# 2. 启动本地 PostgreSQL
docker compose up -d postgres

# 3. 安装依赖
pnpm install --frozen-lockfile

# 4. 生成 Prisma Client
pnpm prisma:generate

# 5. 应用仓库中已经提交、审查过的 migration
pnpm prisma:deploy

# 6. 初始化默认管理员
pnpm prisma:seed

# 7. 启动 API
pnpm start:dev
```

启动后：

```text
Swagger UI: http://localhost:3000/api/docs
Health:     http://localhost:3000/api/system/v1/health
Ready:      http://localhost:3000/api/system/v1/health/ready
```

### 本地默认管理员

| 字段 | 默认值 |
|---|---|
| username | `admin` |
| password | `ChangeMe123456` |
| role | `SUPER_ADMIN` |

仅限本地开发。生产环境会对默认用户名、默认密码、JWT Secret、CORS、Trusted Proxy 等配置执行强校验。

---

## 12. 常用命令

```bash
# 开发 / 构建
pnpm start:dev
pnpm build
pnpm start:prod

# 代码质量
pnpm lint
pnpm typecheck
pnpm format

# Prisma
pnpm prisma:generate
pnpm prisma:deploy      # 应用已提交 migration
pnpm prisma:migrate     # 仅开发者确需生成开发 migration 时显式执行；不要由 AI 自动运行
pnpm prisma:seed
pnpm prisma:studio

# 测试
pnpm test
pnpm test:contract
pnpm test:e2e
pnpm test:journeys
pnpm test:e2e:failed
pnpm test:e2e:leaks

# 测试数据库
pnpm db:test:init
pnpm db:test:reset
pnpm db:test:prune

# Worker
pnpm start:notification-outbox-worker
pnpm start:storage-consistency-worker

# AI / 工程治理
pnpm agent:preflight
pnpm agent:check:quick
pnpm agent:check:api
pnpm agent:check:full
pnpm harness:selftest
pnpm harness:replay

# 文档 / 契约派生检查
pnpm docs:counts:check
pnpm docs:codemap:check
pnpm docs:rbacmap:check
pnpm docs:openapi:check
pnpm docs:feclient:check
```

---

## 13. 文档导航

README 负责回答“深圳公益救援队数字化平台是什么、怎么开始”。具体事实和执行规则由对应权威源维护。

| 我想知道 | 权威入口 |
|---|---|
| 当前生产状态、已落地能力、未部署能力、风险 / 债务 | [`docs/current-state.md`](./docs/current-state.md) |
| 源码模块职责与风险 | [`CODEMAP.md`](./CODEMAP.md) |
| 数据模型 | [`prisma/schema.prisma`](./prisma/schema.prisma) |
| API / DTO 实时契约 | `/api/docs` / `/api/docs-json` |
| API Surface 边界 | [`docs/api-surface-policy.md`](./docs/api-surface-policy.md) |
| 安全设计 | [`docs/security.md`](./docs/security.md) |
| 部署与生产运行 | [`docs/deployment.md`](./docs/deployment.md) |
| 测试体系 | [`docs/testing.md`](./docs/testing.md) |
| 架构职责边界 | [`docs/architecture-boundary.md`](./docs/architecture-boundary.md) |
| Participation 业务上下文 | [`docs/participation-bounded-context.md`](./docs/participation-bounded-context.md) |
| 全部文档索引 | [`docs/README.md`](./docs/README.md) |
| AI Coding 长期规则 | [`AGENTS.md`](./AGENTS.md) |
| 开发流程 / PR 分级 / Release | [`docs/process.md`](./docs/process.md) |
| 顶层架构背景与历史演进入口 | [`ARCHITECTURE.md`](./ARCHITECTURE.md) |

### 文档权威原则

高频变化事实不要回填到 README 形成第二份真相。

**恒读**（每会话开工必读）：[`AGENTS.md`](./AGENTS.md) → [`docs/current-state.md`](./docs/current-state.md)（权威见 AGENTS §0；Claude Code 加读 [`CLAUDE.md`](./CLAUDE.md)）。[`docs/process.md`](./docs/process.md)（开工 / 分级 / 降速 / 收口）等其余文档**触碰才读**。

**冲突处理**：当前事实 > 长期铁律 > 流程 > 设计背景 > 历史证据。`docs/archive/` 中的设计稿、评审稿和历史批次仅作为历史证据，**不再作为当前执行约束**。

---

## 14. 项目结构

```text
.
├── src/
│   ├── main.ts                 # 应用入口
│   ├── app.module.ts           # 模块与全局 Guard 装配
│   ├── bootstrap/              # 全局启动配置
│   ├── common/                 # 跨模块基础设施
│   ├── config/                 # 配置与启动校验
│   ├── database/               # Prisma / Database Module
│   └── modules/                # 业务模块（平铺）
├── prisma/
│   ├── schema.prisma           # 数据模型唯一权威源
│   ├── migrations/             # 已审查迁移历史
│   └── seed.ts
├── test/
│   ├── contract/               # OpenAPI 契约
│   ├── e2e/                    # 真实数据库 E2E
│   └── ...
├── docs/                       # 当前规范、Runbook、历史档案
├── scripts/                    # Harness / 文档生成 / 工程守卫
├── Dockerfile                  # 生产多阶段镜像
├── docker-compose.yml          # 本地 PostgreSQL
├── AGENTS.md                   # AI Coding 长期规则入口
├── CODEMAP.md                  # 模块地图
└── ARCHITECTURE.md             # 顶层架构背景入口
```

业务模块统一位于 `src/modules/` 下。模块数量、Controller 数、Endpoint 数等高频指标由生成脚本维护，不在 README 手工固化。

---

## 15. 生产部署原则

生产环境与本地开发严格区分：

- 生产只执行已经审查并提交的 migration；
- migration 不在应用容器启动时隐式执行；
- 应用使用多阶段 Docker 镜像并以非 root 用户运行；
- 生产配置执行 fail-fast；
- Storage / 外部通道 / Feature Gate 按各自 Runbook 上线；
- Worker 与 HTTP API 的部署、排空和切换需要显式管理；
- 真实 Ingress / Trusted Proxy / HTTPS / 外部 Provider 验收不能被本地 E2E 或 Docker Smoke 替代；
- “代码已合并 / Release 已发布”不自动等于“允许生产启用”。

详见 [`docs/deployment.md`](./docs/deployment.md) 与 [`docs/current-state.md`](./docs/current-state.md)。

---

## 16. 系统名称、工程代号与项目来源

为避免“组织名称”和“软件系统名称”混淆，本项目统一采用以下命名关系：

| 层级 | 名称 | 说明 |
|---|---|---|
| 组织 | **深圳公益救援队**<br>Shenzhen Rescue Volunteers Federation（`SRVF`） | 系统当前服务的公益救援组织 |
| 系统 | **深圳公益救援队数字化平台**<br>Shenzhen Rescue Volunteers Federation Digital Platform（`SRVF-DP`） | 对内正式系统名称与正式简称 |
| 技术定位 | **组织数字化业务底座** | 描述系统承担的长期技术与业务角色 |
| 工程代号 | `SRVF` / `srvf-*` | 既有仓库、包名、模块及工程标识，可继续保留 |

因此，平台正式简称恒为 `SRVF-DP`；文档中单独出现的 `SRVF` 不再作为系统正式名称使用 —— 当它出现在 `srvf-api`、`srvf-*`、环境标识或既有代码命名中时，应理解为**组织缩写或工程代号**，而不是平台品牌名称。

当前后端工程最初派生自 [`u-nest-api-starter`](https://github.com/BA7IEE/u-nest-api-starter) `v0.1.6`（2026-05-04），在其认证、用户、日志、错误处理、限流、测试和容器化基础上持续演进为深圳公益救援队数字化平台的后端业务底座。

部分底层工程命名仍保留 `u-nest-api-*`，例如 Docker 容器名和测试数据库相关脚本。这些名称目前属于既有工程契约，**不要仅为了品牌一致性进行机械改名**；如需调整，应按实际依赖影响单独评审。

项目派生历史不再作为 README 第一屏的系统定位。当前平台是什么，以实际业务架构和当前代码事实为准。

---

## 17. License / Copyright

本项目当前 `package.json` 标记为 `UNLICENSED`。

版权与知识产权说明见 [`COPYRIGHT.md`](./COPYRIGHT.md)。未经明确授权，不应将“代码仓库可访问”理解为获得复制、分发、商用或再许可权利。
