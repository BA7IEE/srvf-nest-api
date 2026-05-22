# Architecture V2 First-Stage Blueprint (Historical)

> **Status**: archived historical material.
> **Source**: `ARCHITECTURE.md §12` (including §12.1-§12.11) moved verbatim from [`ARCHITECTURE.md`](../../../ARCHITECTURE.md) at commit `d81c2ab` (PR-6 `docs: rewrite ARCHITECTURE.md as top-level entrypoint`, archived 2026-05-22).
> These sections are retained for traceability only and **are not the current execution authority**.
>
> **V2 第一阶段开发(Step 1-7)已于 v0.2.0 全部完成**;本归档原文是 D8 立项时刻的开发蓝图快照,**不再作为当前执行约束**。
>
> **Active authorities承接 from this section** (read these instead of the archived body):
> - **V2.x 复活触发条件 / 延后模型当前清单 / A/B/C/D/E 五档红线**: [`docs/V2红线与复活路径.md`](../../V2红线与复活路径.md)(滚动维护)
> - **V2 基线规范** (BizCode 段位 / 命名 / DTO 白名单 / 软删 / v1 兼容性 / 时区 / 验收门槛 13 项 A 档): [`docs/srvf-foundation-baseline.md`](../../srvf-foundation-baseline.md)
> - **V2 数据模型** (4 模型 + users.memberId): [`docs/v2-data-model.md`](../../v2-data-model.md)
> - **V2 第一阶段接口契约** (含 §6.6 memberNo 登录回退): [`docs/v2-api-contract.md`](../../v2-api-contract.md)
> - **V2 第一阶段执行计划历史快照** (原 `docs/v2-plan.md`): [`docs/archive/plans/v2-first-stage-plan.md`](./v2-first-stage-plan.md)
> - **V2 设计期产物归档** (research / data-model-draft / interview-brief / tasks): [`docs/archive/plans/v2-design-phase/`](./v2-design-phase/)
> - **当前 V2 / V2.x 已落地能力清单**: [`docs/current-state.md §2`](../../current-state.md) "V2 数据底座" / "V2 批次" / "V2.x C-6/C-7/C-7.5" 段
>
> **External references redirected here by PR-6**:
> 以下原 `ARCHITECTURE.md §12.X` 章节锚点的引用,自 PR-6 起从顶层 ARCHITECTURE.md 移入本归档文件,锚点路径变为 `docs/archive/plans/architecture-v2-first-stage-blueprint.md §12.X`:
> - §12.6 / §12.8 / §12.8.1 / §12.8.2 / §12.8.2.1 / §12.8.2.2 / §12.8.2.3 / §12.8.2.4 / §12.8.2.5 / §12.8.3 / §12.8.4
> - §12.9 / §12.9.1 / §12.9.2 / §12.9.3 / §12.10 / §12.10.1 / §12.10.2 / §12.11 / §12.11.1 / §12.11.2 / §12.11.3
>
> 新文档建议引用顶部"Active authorities承接"列出的 active 单一权威源,而非本归档文件。
>
> **Paths**: original section used repo-root-relative paths (e.g. `docs/V2红线与复活路径.md`, `TASKS.md`, `src/...`). Those strings are preserved verbatim below — they no longer resolve as Markdown links from this nested archive location, but the textual references are still meaningful when read from repo root.

---

## 12. V2 派生项目方向(srvf-nest-api 基础数据底座)

> **适用范围**:本节**仅适用于派生项目 `srvf-nest-api`(深圳公益救援队内部系统)**,不是 `u-nest-api-starter` 模板仓的强制升级。
> **不破坏** `u-nest-api-starter` v0.1.6 起的 main 分支 template-freeze 约束(只允许 docs / CI 触发路径变更)。
> **状态**:**调研与设计阶段**,**未进入开发**。
> **本节定位**:**仅引用边界**,不锁 schema、不锁字段、不锁 API 路径、不锁实施顺序。具体边界以 [`docs/archive/plans/v2-design-phase/srvf-foundation-research.md`](./docs/archive/plans/v2-design-phase/srvf-foundation-research.md)(原 `docs/srvf-foundation-research.md`,PR-4 已归档)为准。

### 12.1 一句话目标

为 `srvf-nest-api` 沉淀**人员主数据 / 组织 / 字典 / 附件元数据 / 审计**五大基建,**不预先实现**任何具体救援业务流程。

### 12.2 与 v1 / V1.1 / 模板 freeze 的关系

- **v1**(本文 §1-§10):全部保留生效
- **V1.1**(本文 §11):全部保留生效
- **模板 freeze**(`u-nest-api-starter` v0.1.6):派生项目的 V2 工作**不回流**到模板仓 main 分支
- **本节(§12)**:派生项目侧的扩张登记,与模板仓解耦

### 12.3 V2 解锁项(相对 v1 §1)

以下四项在 v1 §1 的"v1 不做的事"中被冻结,V2 在派生项目侧**有限解锁**(具体边界见研究文档对应章节):

- **字典管理**(参考 [`docs/archive/plans/v2-design-phase/srvf-foundation-research.md`](./docs/archive/plans/v2-design-phase/srvf-foundation-research.md) §2.3 / §5.1)
- **操作日志的"基础设施"**(表与写入入口,**不**强制全模块覆盖,参考研究文档 §2.5)
- **组织树**(单一层级根,**不**做多租户;参考研究文档 §2.2)
- **通用附件元数据表**(**仅元数据**,**不**实装 Provider;参考研究文档 §2.4 / §3.10)

### 12.4 V2 仍不做项(继承 v1 §1,完整清单见研究文档 §3)

V2 第一阶段的"暂不做清单"由 [`docs/archive/plans/v2-design-phase/srvf-foundation-research.md`](./docs/archive/plans/v2-design-phase/srvf-foundation-research.md)(原 `docs/srvf-foundation-research.md`,PR-4 已归档)§3.1 - §3.16 共 16 条统一锁定,本节不重复罗列。任何与该清单冲突的诉求,必须先回到研究文档评审,再决定是否调整。

> **适用范围说明**(2026-05-16 Fast-1 段头补充):本节(§12.4 + 下方要点提示)锁定的是 **V2 第一阶段 Step 1-7 开发期硬约束**(已于 v0.2.0 全部完成);本节作为开发期硬约束历史快照保留。**当前 V2.x 段已通过独立评审 + 立项 PR 解锁部分项**:`audit_logs`(批次 6,v0.7.0)/ RBAC(批次 8 C-6,v0.9.0)/ `attachments` 元数据(批次 7 C-7,v0.10.0)/ 文件上传 Provider 实装(批次 7.5 C-7.5,v0.11.0)。本节 **不删原文**(沿 [`docs/V2红线与复活路径.md`](./docs/V2红线与复活路径.md) §5.4 最小修订原则)。当前红线以 `docs/V2红线与复活路径.md` §4 为权威源;v0.11.0 阶段交接见 [`docs/handoff/v0.11.0.md`](./docs/handoff/v0.11.0.md)。

要点提示(完整清单以研究文档为准):

- 不做装备 / 仓库 / 车辆 / 船艇管理(§3.1)
- 不做财务 / 报销 / 捐赠(§3.2)
- 不做救援任务调度 / 实时定位(§3.3)
- 不做大屏 / BI / 复杂报表(§3.4)
- 不做积分 / 评优 / 奖惩(§3.5)
- 不做通用审批流引擎(§3.6)
- 不做微信 / 公众号 / 企业微信深度集成(§3.7)
- 不做短信 / 邮件 / 站内消息(§3.8)
- 不做证件 / 保险自动校验与到期提醒(§3.9)
- 不做文件上传 Provider 实装(§3.10)
- 不做 RBAC / 通用数据范围权限引擎(§3.11)
- 不做 Redis / 队列 / 定时任务(§3.12)
- 不做 LLM / 向量检索(§3.13)
- 不做多租户(§3.14)
- 不做历史数据导入工具(§3.15)
- 考勤业务流程 / 训练业务模块**业务实现**暂不做(§3.16),但允许研究 events / event_participants 是否能作为底座承载

### 12.5 V2 设计阶段产物

- [`docs/archive/plans/v2-design-phase/srvf-foundation-research.md`](./docs/archive/plans/v2-design-phase/srvf-foundation-research.md) — 边界文档(已通过评审,V2 设计阶段冻结;原 `docs/srvf-foundation-research.md`,PR-4 已归档)
- [`docs/srvf-foundation-baseline.md`](./docs/srvf-foundation-baseline.md) — **V2 通用基线规范**(BizCode 段位 / 命名 / DTO / 软删除 / 验收门槛等 13 项 A 档约定);所有 V2 草案与开发的**隐含约束**,**不是数据模型草案**
- `ARCHITECTURE.md §12` — 本节,蓝图侧的轻量登记
- `CLAUDE.md §18` / `AGENTS.md §18` — V2 调研 / 设计阶段约束(非执行约束)
- `TASKS.md` V2 设计任务卡 — 调研 / 建模 / 评审任务,**不含**开发任务(已归档至 [`docs/archive/plans/v2-design-phase/tasks.md`](docs/archive/plans/v2-design-phase/tasks.md))
- [`docs/archive/plans/v2-design-phase/srvf-foundation-data-model-draft.md`](./docs/archive/plans/v2-design-phase/srvf-foundation-data-model-draft.md) — **候选模型草案**(待第二步通过后,作为第三步产出;原 `docs/srvf-foundation-data-model-draft.md`,PR-4 已归档)

### 12.6 进入开发的前置条件(硬约束)

V2 任何 Prisma schema 变更、migration、新建 `src/modules/<业务>` 之前,**必须**完成:

1. `docs/archive/plans/v2-design-phase/srvf-foundation-research.md` 评审通过 ✅(已通过;原 `docs/srvf-foundation-research.md`,PR-4 已归档)
2. `ARCHITECTURE.md §12` 追加(本节)+ `CLAUDE.md §18` + `AGENTS.md §18` + `TASKS.md` V2 设计任务卡 同步追加(第二步产物;现归档于 [`docs/archive/plans/v2-design-phase/tasks.md`](docs/archive/plans/v2-design-phase/tasks.md))
3. `docs/archive/plans/v2-design-phase/srvf-foundation-data-model-draft.md` 候选模型草案完成并评审通过(第三步产物;原 `docs/srvf-foundation-data-model-draft.md`,PR-4 已归档)
4. 本节(§12)升级为带 schema 锁定的开发蓝图(届时另起 §12.7+ 子节,**不破坏** §12.1-§12.6 的边界声明)

未走完上述四步 → **禁止**任何 schema / migration / 业务模块代码 / 新依赖动作。

### 12.7 与 v1 §6 接口清单的关系

V2 **不修改** v1 §6 已交付的 14 个接口的路径 / HTTP 方法 / 入参 / 出参 / 权限标注。V2 仅**追加**新模块的接口;具体接口清单在本节**不锁定**,留给未来开发蓝图与 v2-api-contract.md。

兼容性红线见研究文档 §5.6:不删 / 不改 / 不重命名 v1 `users` 已有字段,不破坏 `UserResponseDto`,不在 v1 接口响应中新增"必返"字段。

### 12.8 V2 第一阶段开发蓝图(自 D8 决议起锁定)

> **状态**:**V2-D8 立项中**(2026-05-07);本节自 D8 决议起锁定 V2 第一阶段开发范围与红线。
> **依据**:`docs/archive/plans/v2-design-phase/srvf-foundation-data-model-draft.md` v0.3 D7-min 决议版(commit `4333c31`;原 `docs/srvf-foundation-data-model-draft.md`,PR-4 已归档)+ `TASKS.md` D7-min 同步(commit `281abc0`)+ baseline(commit `16876fe`)。
> **本节性质**:开发蓝图,**仅锁范围与红线**;具体计划 / 模型 / 接口契约由 `docs/archive/plans/v2-first-stage-plan.md`(原 `docs/v2-plan.md`,PR-5 已归档)/ `docs/v2-data-model.md` / `docs/v2-api-contract.md` 承载,本节不重抄。

#### 12.8.1 V2 第一阶段开发范围

V2 第一阶段开发范围由 D7-min 决议锁定为 **4 个模型 + 1 项 v1 兼容性追加**:

| # | 模型 | 决议(D7-min,commit `4333c31`)| 草案对应章节 |
|---|---|---|---|
| 1 | `dictionaries`(`dict_types` + `dict_items`)| ✅ 进入 V2 第一阶段 | data-model-draft v0.3 §3.1.10 |
| 2 | `organizations` | ✅ 进入 V2 第一阶段 | §3.2.10 |
| 3 | `members` | ✅ 进入 V2 第一阶段 — 含 `memberNo` 业务唯一标识(非敏感、必填、全局唯一、不允许 PATCH;支持登录回退查找)| §3.3.10 + memberNo 决议(2026-05-08) |
| 4 | `member_departments` | ✅ 进入 V2 第一阶段 | §3.5.10 |
| — | v1 `users` 表追加 `memberId` 可空外键 | M-2 决议的不可避免后果 | §3.3.10 / §4.2.6 |
| — | v1 `auth.service.ts` 登录查找扩展支持 `memberNo` 回退 | memberNo 决议(2026-05-08)| §12.8.2.3 / §12.8.2.4 / `docs/v2-api-contract.md §6.6` |

**第一阶段不开发**(全部延后到 V2.x,无砍掉):

| # | 模型 | 决议(D7-min)| V2.x 复活触发条件 |
|---|---|---|---|
| 5 | `member_profiles` | ⏸️ 延后 | 合规依据补齐(详见 [`docs/V2红线与复活路径.md §4.3`](docs/V2红线与复活路径.md)) |
| 6 | `attachments` | ⏸️ 延后 | profiles / events 解锁 / 用户拍板独立诉求(任一即可)|
| 7 | `audit_logs` | ⏸️ 延后 | V2.x 第一个增量,接入 V2 第一阶段 4 模型关键写操作 |
| 8 | `events` | ⏸️ 延后 | 用户拍板需求 → D7-4 评审 |
| 9 | `event_participants` | ⏸️ 延后(跟随 events)| 跟随 events 复活路径 |

V2.x 复活触发条件清单见 [`docs/V2红线与复活路径.md §4.3`](docs/V2红线与复活路径.md),本节不重抄。

#### 12.8.2 v1 兼容性红线(开发期硬约束)

V2 第一阶段开发**全程**遵守以下兼容性红线(对齐 baseline §11):

##### 12.8.2.1 v1 接口契约

- v1 §6 已交付的 14 个接口的**路径 / HTTP 方法 / 入参 DTO / 出参 DTO / 错误码 / 权限标注 / 响应包装**全部保留不变
- v1 `UserResponseDto` **不**新增必返字段
- `memberId` 是否作为 v1 接口的**可选返回**字段,留到具体开发任务中再评估;**默认不改 v1 出参**

##### 12.8.2.2 v1 表与 Prisma model 兼容性

- v1 `users` 表新增**可空** `memberId` 字段(unique 约束)— 为 M-2 决议的不可避免后果
- v1 `users` 已有字段 / 已有索引 / 已有外键**不动**
- Prisma `User` model 仅追加 `memberId` 可空字段 + 关系到 `Member` model;**不改**已有字段类型 / 命名 / 默认值

##### 12.8.2.3 v1 业务逻辑兼容性

- v1 用户登录路径(`POST /api/auth/login`)**对外契约不动**:HTTP 路径 / 方法 / `LoginDto` schema(`username` + `password` 字段名 / 类型 / 校验装饰器不变)/ 出参 / 错误码(`LOGIN_FAILED = 10004`)/ 响应包装 / Timing 防御机制 全部保留;OpenAPI 快照中 v1 `LoginDto` schema **零漂移**
  - v1 `LoginDto.username` 字段在 V2 第一阶段的**服务端查找语义**允许扩展为"username 或 memberNo"(由 `auth.service.ts` 内部回退查找实现;详见 §12.8.2.4 受限放开条款 + `docs/v2-api-contract.md §6.6`)
  - 扩展**仅在服务端**:不改字段名 / 类型 / 入参 schema;不新增 `/api/v2/auth/login` 路径;前端登录入口仍是单一的 `POST /api/auth/login`
  - 账号枚举防护场景**扩展**:输入值在 `username` 与 `memberNo` 两条查找路径下均未命中 / `memberNo` 命中但未绑定 user / 账号已禁用或已软删除 / 密码错误 — 全部统一抛 `LOGIN_FAILED`,响应包装 / 错误码 / message / HTTP status / Timing 防御机制保持一致;**禁止**暴露"编号存在但无账号"等可区分提示
- v1 用户创建 / 查询 / 更新 / 软删除路径**不动**
- v1 `seed.ts` 创建 SUPER_ADMIN 的逻辑**不动**(SUPER_ADMIN 默认 `memberId = null`,不强制绑 member)
- v1 既有 e2e 用例(19 suites / 162 tests,A4-1 时确认基线)**全部保留**且全部通过

##### 12.8.2.4 v1 已交付 src/ 文件修改限制

按 `CLAUDE.md §18.1` / D7-min 决议授权 + memberNo 登录回退决议(2026-05-08):

- ✅ **可以**修改 `prisma/schema.prisma` 追加 `memberId` 可空外键(M-2 决议授权)+ `Member.memberNo` 全局唯一字段
- ✅ **可以**修改 v1 `users.service.ts` / `users.dto.ts` 追加 `memberId` 字段处理逻辑(若开发任务需要)
- ⚠️ **受限放开** v1 `auth.service.ts`:**唯一**允许的扩展是登录查找路径追加 `memberNo` 回退(`username` 查找失败后,按 `memberNo` 在 `member` 表精确匹配,再通过 `users.memberId` 反查 user,照常走 `bcrypt.compare`)。**严格禁止**修改:
  - 入参 / 出参 DTO 字段集(`LoginDto` / 登录响应 schema 必须零漂移)
  - 错误码常量与文案(`LOGIN_FAILED = 10004` 等)
  - 响应包装链路 / `JwtService.sign` 调用方式 / `lastLoginAt` 顺手更新策略
  - Timing 防御机制 — 现有 dummy `bcrypt.compare` 必须保留,且**强制扩展**到新增 `memberNo` 路径,确保账号枚举相关失败场景(见 §12.8.2.3 + `docs/v2-api-contract.md §6.6.3`)耗时一致
  - 实现层依赖关系 — `auth.service` 必须通过 `PrismaService` 直读 `member` 表(`this.prisma.member.findUnique({ where: { memberNo } })`),**禁止** import `MembersModule` / `MembersService` 或任何 V2 业务层符号(避免 v1 → V2 循环依赖)
- ❌ **禁止**修改 v1 `auth.controller.ts` / `auth.dto.ts`(`LoginDto` 字段名 / 类型 / 校验装饰器 / 路径全保留)
- ❌ **禁止**修改 v1 `health/` 模块
- ❌ **禁止**修改 v1 `bootstrap/` 模块的全局中间件 / 拦截器 / 异常过滤器
- ❌ **禁止**修改 v1 `config/` 模块(除非新增 V2 配置文件)
- ❌ **禁止**修改 v1 `database/prisma.service.ts`

每次修改 v1 已交付 src/ 文件**必须**在 commit message 显式说明涉及哪个 v1 文件 + 跑完整 baseline §13 A 档 + B 档。`auth.service.ts` 受限放开属于**唯一破口**,Step 5 实施时必须独立 commit(`feat(auth): support memberNo login fallback`),单 commit 仅含 `auth.service.ts` 改动 + 配套 e2e + OpenAPI 快照对比证据;**严禁**与 members CRUD 揉进同一 commit。

##### 12.8.2.5 v1 OpenAPI 契约快照

沿用 V1.3 已建立的 `test/contract/openapi.contract-spec.ts` 快照机制:

- V2 4 模块开发后,**新增**接口的 schema 进入快照
- v1 14 接口 schema 在快照中**保持不变**(若发生变化,视作 v1 兼容性破坏,等同于 §12.8.2.1 红线违反)

#### 12.8.3 跨模型形态约束(对齐 baseline + D7-min)

V2 第一阶段 4 模型**全程**遵守以下跨模型形态约束:

| # | 约束 | 来源 |
|---|---|---|
| **X-1** | 字典引用方式**全模块统一**为 `<concept>Code` 字符串字段(如 `gradeCode` / `nodeTypeCode`)| D-2 / O-2 / M-4 决议(data-model-draft v0.3 §3.1.10 / §3.2.10 / §3.3.10) |
| **X-2** | 软删除按 baseline §10:`deletedAt: Date \| null` + `notDeletedWhere` helper(commit `d8fd444` 已就位) | baseline §10 |
| **X-3** | 启停字段命名按 baseline §2.2.3:统一 `status` enum | baseline §2.2.3 |
| **X-4** | 多对多中间表命名按 baseline §2.2.2:`member_departments` 业务序 | baseline §2.2.2 |
| **X-5** | 通用字段全模块一致:`id`(cuid)/ `createdAt` / `updatedAt` / `deletedAt` | baseline §2.1 |
| **X-6** | BizCode 段位:`organizations`=`110xx`/`111xx` / `dictionaries`=`120xx`/`121xx` / `members`=`150xx`/`151xx` / `member_profiles`=`160xx`/`161xx`(本阶段不用,保留)/ `member_departments`=`170xx`/`171xx`| baseline §1.1 |
| **X-7** | 命名遵守 baseline §2.1 / §2.2 全部红线(时间字段 / 主键 / 软删标记 / 文件 key 等)| baseline §2 |
| **X-8** | 响应包装 / 异常 / Swagger 100% 覆盖 / DTO 白名单 / 模块结构 / 错误码命名规范 / 配置归属 / Guard 链 全部沿用 baseline §3-§9 | baseline §3-§9 |
| **X-9** | 时区全栈 UTC,前端转本地;**禁止**后端按"中国时区"提前转换 | baseline §12 |
| **X-10** | 验收按 baseline §13 A 档 + B 档(涉及 HTTP 行为 / 全局中间件 / 拦截器 / Guard / Controller / Swagger 时追加 B 档)| baseline §13 |

#### 12.8.4 第一阶段绝对禁止清单(继承 + 强化)

> **适用范围**:本节锁定的是 **V2 第一阶段 Step 1-7 开发期**(对应 §12.9.1 的 7 步开发)。Step 1-7 已于 v0.2.0 全部完成,本节作为开发期硬约束的历史快照保留。
> **当前状态**(v0.7.0 后):
> - `audit_logs` 已作为 V2.x 第一个增量于 v0.7.0 局部启动(批次 6 PR #29 / PR #30 实施;经业务确认稿 + D6 评审 + 用户拍板;符合 §12.11.2 V2.x 复活路径);剩余 22 处 `auditPlaceholder` 调用按业务诉求渐进迁出。
> - `member_profiles` / `attachments` / `events` / `event_participants` **仍延后**(沿 §12.11.2 / [`docs/V2红线与复活路径.md §4.3`](docs/V2红线与复活路径.md))。
> - 当前阶段红线 / 复活路径以 [`docs/V2红线与复活路径.md`](./docs/V2红线与复活路径.md) 为单一权威源;新批次范围限制以对应批次评审稿为准。

V2 第一阶段开发期间**严禁**:

- ❌ 开发 `member_profiles`(任何敏感字段 — 身份证 / 紧急联系人 / 医疗 / 出生日期 / 住址 / 性别 / 第三方账号 / 凭证标识 等)
- ❌ 开发 `events` / `event_participants`(活动事件 / 参与状态)
- ❌ 开发 `attachments`(附件元数据 / 上传 Provider)
- ❌ 开发 `audit_logs`(审计基础设施 / 任何接入)
- ❌ 实装文件上传 Provider(本地 / OSS / R2 / 其他;沿用 `research.md §3.10`)
- ❌ 引入 RBAC / permission 表 / casl(沿用 v1 §1)
- ❌ 引入 Redis / 队列 / 定时任务(沿用 v1 §1 / V1.1 §11.3)
- ❌ 实现读审计 / 完整状态机 / 流程引擎(沿用 `research.md §3.6` / §3.16)
- ❌ 引入新依赖(除非 v2-plan 任务卡显式登记)
- ❌ 修改 `docker-compose.yml` / `.github/workflows/ci.yml`(除非 D8 立项后单独评估)

---

### 12.9 V2 第一阶段开发顺序

V2 第一阶段开发按 7 步顺序推进,**逐步独立交付,逐步独立 commit**;具体任务卡见 `TASKS.md §6` / 计划详情见 `docs/archive/plans/v2-first-stage-plan.md`(原 `docs/v2-plan.md`,PR-5 已归档)。

#### 12.9.1 7 步开发顺序

| Step | 内容 | 关键依赖 |
|---|---|---|
| **Step 1** | Prisma schema + migration:4 模型 + `users.memberId` 可空外键 | baseline + v1 schema 不破坏 |
| **Step 2** | seed neutral-demo 字典类型(节点类别 / 队员等级 2 类),**仅占位**;真实取值不进 git history(R13)| Step 1 完成 |
| **Step 3** | `dictionaries` 模块(`dict_types` + `dict_items` controller / service / dto / e2e)| Step 1-2 完成 |
| **Step 4** | `organizations` 模块(树形 controller / service / dto / e2e)| Step 1-3 完成(依赖字典) |
| **Step 5** | `members` 模块(controller / service / dto / e2e)+ v1 `users` 服务侧追加 `memberId` 关系处理 | Step 1-4 完成 |
| **Step 6** | `member_departments` 归属能力(嵌套或独立 controller / service / dto / e2e + 单归属约束业务规则)| Step 1-5 完成 |
| **Step 7** | E2E 全量回归 + 契约快照更新 + 文档收口(README / CHANGELOG / TASKS.md 收尾)| Step 1-6 全部完成 |

#### 12.9.2 每步必须交付物

| Step | 交付物清单 |
|---|---|
| Step 1 | Prisma schema 改动 + migration 文件 + `pnpm prisma:generate` 通过 + `pnpm prisma:migrate dev`(本地)/ `pnpm prisma:deploy`(CI)通过 |
| Step 2 | `prisma/seed.ts` 改动 + neutral-demo 字典类型 + 幂等(跑两次结果一致)|
| Step 3-6 | 4 文件结构(`<name>.module.ts` / `.controller.ts` / `.service.ts` / `.dto.ts`)+ `<name>.e2e-spec.ts` + Swagger 100% 覆盖 |
| Step 7 | OpenAPI 契约快照更新 + e2e 全量通过 + README / CHANGELOG 增量 + TASKS.md §6 状态收尾 |

#### 12.9.3 每步验收门槛(对齐 baseline §13)

每步完成前必须跑:

**A 档(必跑)**:

- `pnpm lint`(0 warnings / 0 errors)
- `pnpm typecheck`
- `pnpm test`(unit)
- `pnpm test:e2e`(v1 既有 19 suites / 162 tests **零退化** + V2 新增 e2e 通过)
- `pnpm test:contract`(若涉及 OpenAPI schema 变更,显式更新快照)

**B 档(涉及 HTTP 行为 / 全局中间件 / 拦截器 / Guard / Controller / Swagger 时追加)**:

- 启动服务,确认 `/api/docs` 仍正常打开
- 确认 v1 `GET /api/health` / `/api/health/live` / `/api/health/ready` 三端点向后兼容
- 任意 v1 14 接口典型路径不退化(管理员可手工 spot check)
- V2 新接口典型成功路径 + 典型错误路径

任一未通过 → **不算完成,不能 commit,不能向用户报告"任务完成"**(沿用 V1.1 §17.10 末尾纪律)。

---

### 12.10 V2 第一阶段开发产出物清单

#### 12.10.1 必须产出

| # | 产出物 | 状态 |
|---|---|---|
| 1 | `ARCHITECTURE.md §12.8-§12.11`(本节及后续)| ⏳ 待 D8 立项首批 commit 后落地 |
| 2 | `docs/archive/plans/v2-first-stage-plan.md`(开发执行计划;原 `docs/v2-plan.md`,PR-5 已归档)| ⏳ 待 D8 立项中产出 |
| 3 | `docs/v2-data-model.md`(4 模型 + `users.memberId` 数据模型说明)| ⏳ 待 D8 立项中产出 |
| 4 | `docs/v2-api-contract.md`(接口契约草案)| ⏳ 待 D8 立项中产出 |
| 5 | `TASKS.md §6` V2 第一阶段开发任务卡(7 个 Step 任务卡)| ⏳ 待 D8 立项中产出 |
| 6 | Prisma schema + migration(4 模型 + `users.memberId`)| 由 Step 1 交付,**不在本节范围** |
| 7 | 4 个 NestJS 模块代码 + e2e | 由 Step 3-6 交付,**不在本节范围** |
| 8 | OpenAPI 契约快照更新 | 由 Step 7 交付,**不在本节范围** |

#### 12.10.2 不在产出范围

- ❌ `member_profiles` / `attachments` / `audit_logs` / `events` / `event_participants` 任何代码 / schema / 测试
- ❌ 文件上传 Provider 实装
- ❌ RBAC / permission 表 / casl
- ❌ Redis / 队列 / 定时任务
- ❌ AI / 向量检索
- ❌ 多租户 / 复杂审批流 / 通知系统
- ❌ 任何 v1 §1 / V2 §3 已锁定的"不做"项的破口

---

### 12.11 D8 解除条件与 V2.x 路径

#### 12.11.1 D8 解除条件(进入 V2 第一阶段开发的硬前置)

V2 第一阶段开发(Step 1-7 任一启动)前**必须**完成以下立项产出物:

1. ✅ `ARCHITECTURE.md §12.8-§12.11`(本节)— D8 立项首批 commit
2. ⏳ `docs/archive/plans/v2-first-stage-plan.md`(原 `docs/v2-plan.md`,PR-5 已归档)— D8 立项第 2 批 commit
3. ⏳ `docs/v2-data-model.md` — D8 立项第 3 批 commit
4. ⏳ `docs/v2-api-contract.md` — D8 立项第 4 批 commit
5. ⏳ `TASKS.md §6` — D8 立项第 5 批 commit

5 份产出物**全部就位**后,V2-D8 标记为 ✅ 已完成,V2 第一阶段开发(Step 1-7)进入待启动状态。

每份产出物**单独 commit**;每份完成后**单独审过**;沿用 V2-D5 三阶段拆分模式。

#### 12.11.2 V2.x 复活路径

5 个延后模型(`member_profiles` / `attachments` / `audit_logs` / `events` / `event_participants`)的 V2.x 复活触发条件以 [`docs/V2红线与复活路径.md §4.3`](docs/V2红线与复活路径.md) 为 active 权威源(原 `TASKS.md §5.5.4.3` 现存于 [`docs/archive/plans/v2-design-phase/tasks.md`](docs/archive/plans/v2-design-phase/tasks.md) §5.5.4.3),本节不重抄。

V2.x 启动节奏由用户拍板;**禁止**在 V2 第一阶段开发期间偷偷把延后模型的代码 / schema / 测试塞进 commit。

#### 12.11.3 边界声明

V2 第一阶段开发完成后,**不自动**进入 V2.x;V2.x 启动需用户单独拍板,**等同于 D8 第二轮立项决策**。

V2 第一阶段开发期间发现的任何"看起来该顺手做"事项(包括延后模型 / 暂不做项 / 未登记新依赖等),**全部**走 [`TASKS.md §6.10`](TASKS.md) 范围外统一处理流程,**禁止**未经用户确认就动作。
