# TASKS.md — SRVF 任务卡入口

> 本文件是 SRVF 当前 / 后续任务卡的入口。
> **V1.1 工程加固任务卡**(原 §0-§4,任务 15.1-15.9)与 **V2 设计期任务卡**(原 §5,V2-D1~D8 + A 档快车道)已收口归档,见 §0 历史归档索引;原文不再作为当前执行约束。
>
> - **当前事实**:见 [`docs/current-state.md`](docs/current-state.md)(版本 / open PR / 已发能力 / 当前债务)
> - **流程制度**:见 [`docs/process.md`](docs/process.md)(开工 checklist / PR 五档分级 / release 收口)
> - **长期 AI 协作铁律**:见 [`AGENTS.md`](AGENTS.md)(命名 / 错误码 / Guard / 软删除 / App API 边界 / §19.7 D-series 决策锁)
> - **架构蓝图与升级路径**:见 [`ARCHITECTURE.md`](ARCHITECTURE.md)(请先读顶部"当前阶段说明")
>
> 任务编号沿用仓库历史"阶段.子任务"风格;**章节编号保留原值**(§6 / §7 / §8 / §9),§1-§5 留作历史归档占位以避免破坏外部文档对 `TASKS.md §X.X` 的现有引用(详见 §0.3)。

---

## 0. 历史归档索引

> 以下任务卡阶段已收口,原文移至归档目录,**仅作历史证据**,不再作为当前执行约束。
> 当前事实以 [`docs/current-state.md`](docs/current-state.md) 为准;冲突时归档让步。

### 0.1 V1.1 工程加固任务卡(原 §0-§4)

- **归档位置**:[`docs/archive/legacy/tasks-v1-1-historical.md`](docs/archive/legacy/tasks-v1-1-historical.md)
- **覆盖任务**:V1.1 任务 15.1-15.9(GitHub Actions CI / `nestjs-pino` 结构化日志 / `x-request-id` 贯通 / 优雅关闭 / `@nestjs/terminus` 健康检查分层 / `helmet` / `@nestjs/throttler` 登录限流 / Dockerfile 多阶段 / README + 验收收尾)
- **收口于**:v0.1.5 / v0.1.6
- **承接当前事实**:
  - 已落地能力清单 → [`docs/current-state.md §2`](docs/current-state.md) "V1.1 工程加固"段
  - 架构蓝图 → [`ARCHITECTURE.md §11`](ARCHITECTURE.md) "V1.1 Engineering Hardening"
  - 长期铁律承接 → [`AGENTS.md §17`](AGENTS.md)(原 V1.1 规则细节已自承归档至 `docs/archive/legacy/agents-historical-design-period.md`)

### 0.2 V2 设计期任务卡(原 §5,含 V2-D1~D8 + A 档快车道 §5.5)

- **归档位置**:[`docs/archive/plans/v2-design-phase/tasks.md`](docs/archive/plans/v2-design-phase/tasks.md)
- **覆盖任务**:V2-D1(研究文档)/ V2-D2(`ARCHITECTURE.md §12`)/ V2-D3(`CLAUDE.md §18` / `AGENTS.md §18`)/ V2-D4(`TASKS.md §5`)/ V2-D5(调研访谈)/ V2-D6(数据模型草案)/ V2-D7(模型评审 D7-min)/ V2-D8(开发立项)+ A1 / A2(✅ 已完成)+ A3(⏸️ 暂缓)+ A4 / A5(❌ 不做)
- **收口于**:V2-D8 立项完成 2026-05-08;V2 第一阶段开发任务卡(本文件 §6)已 ✅ 全部交付
- **承接当前事实**:
  - V2 第一阶段已交付能力 → [`docs/current-state.md §2`](docs/current-state.md) "V2 数据底座" / "V2 批次"段
  - 完整数据模型 → [`docs/v2-data-model.md`](docs/v2-data-model.md)
  - 完整接口契约 → [`docs/v2-api-contract.md`](docs/v2-api-contract.md)
  - 长期铁律承接 → [`AGENTS.md §18`](AGENTS.md)(原 V2 设计纪律细节已自承归档,仅保留 §18.4 / §18.4.1 当前仍生效部分)

#### 0.2.1 重要 redirect — V2.x 复活触发条件

原 `§5.5.4.3` "V2.x 复活触发条件(D7-min 延后模型)"已迁入归档。**当前事实**以以下 active 文档为准:

| 维度 | 权威源(active) |
|---|---|
| **V2.x 复活触发条件 / 延后模型当前清单** | [`docs/V2红线与复活路径.md §4.3`](docs/V2红线与复活路径.md)(滚动维护) |
| **延后模型的红线分类**(C-7 / C-8 / C-9 / C-10) | 同上 §4 |
| **`audit_logs` 当前状态**(v0.7.0 局部启动 + 剩余 22 处迁移) | 同上 §4.1 C-1 |
| **D7-min 决议时刻历史快照**(2026-05-07,commit `4333c31`) | [归档:`v2-design-phase/tasks.md`](docs/archive/plans/v2-design-phase/tasks.md) §5.5.4.3 |

**当前延后模型清单**(沿 V2 红线 §4.3):`member_profiles` / `attachments` / `events` / `event_participants` 共 **4 个**;`audit_logs` 已不再延后(v0.7.0 后已局部启动)。

### 0.3 章节编号说明

为保留以下 active 文档对 `TASKS.md §6 / §7 / §8 / §9` 的现有引用,**本 PR 不重新编号本文件章节**;§1-§5 留作历史归档占位:

- [`ARCHITECTURE.md`](ARCHITECTURE.md):引用 `TASKS.md §6` / `§6.10`(原 `§5.5.4.3` 引用已在 PR-2 刷新至 `docs/V2红线与复活路径.md §4.3`;原 `§6.4` 引用为 pre-existing bug,PR-2 已修正为 `§6.10`)
- [`docs/V2红线与复活路径.md`](docs/V2红线与复活路径.md):引用 `§6.0` / `§6.9` / `§6.10` / `§6.11`(原 `§5.5.4.3` 引用已在 PR-2 刷新为指向本文件 §4.3 或归档快照;原 `§6.4` 引用为 pre-existing bug,PR-2 已修正为 `§6.9`)
- [`docs/v2-plan.md`](docs/v2-plan.md):引用 `§6`(原 `§5.5.4.3` 引用已在 PR-2 刷新至 `V2红线 §4.3`)
- [`docs/v2-data-model.md`](docs/v2-data-model.md):引用 `§6`(原 `§5.5.4.3` 引用已在 PR-2 刷新至 `V2红线 §4.3`)
- [`docs/v2-api-contract.md`](docs/v2-api-contract.md):引用 `§6`
- [`docs/srvf-foundation-research.md`](docs/srvf-foundation-research.md) / [`docs/srvf-foundation-data-model-draft.md`](docs/srvf-foundation-data-model-draft.md):引用 V2 设计任务卡(已在 PR-2 标注归档指针)
- [`docs/archive/handoff/v0.9.0.md`](docs/archive/handoff/v0.9.0.md) / `v0.10.0.md` / `v0.11.0.md` / `v0.12.0.md`:引用 `§7` / `§8` / `§9`(frozen handoff,沿铁律不回改)

**外部引用刷新已在 PR-2 完成**;读者遇到指向 `§1-§5` 的旧引用时,以本 §0 归档索引 + redirect 提示为准。

---

## 6. V2 — srvf-nest-api 第一阶段开发任务卡

> **状态**:V2-D8 立项已完成(5/5 产出物就位)+ memberNo 决议已纳入(2026-05-08;Q1=A / Q2=B-1 / Q3-Q9 全部锁定);**等待用户最后拍板**进入 Step 1 开发。
> **范围**:V2 第一阶段 4 模型 + `users.memberId` 可空外键追加 + `Member.memberNo` 业务唯一编号 + v1 `auth.service.ts` 登录查找扩展支持 memberNo 回退(D7-min + memberNo 决议锁定)。
> **依据**:`ARCHITECTURE.md §12.8-§12.11`(memberNo 决议后修订)/ `docs/v2-plan.md` v0.2 / `docs/v2-data-model.md` v0.2 / `docs/v2-api-contract.md` v0.2(含 §6.6 v1 登录路径 memberNo 回退查找)/ baseline(commit `16876fe`)。
> **解除条件**:Step 1-7 全部 ✅ 后,V2 第一阶段开发闭环;V2.x 启动需用户单独拍板(对应 §6.11)。

### 6.0 范围速读

> **V2 第一阶段 Step 1-7 已全部完成**(2026-05-08),进入维护者复核 / release 决策前状态。详细完成情况见 §6.2-§6.8 各 Step 的"完成情况"事实块。

本区块是 V2 第一阶段开发任务卡,**仅含 7 步开发任务**;**不含**:

- ❌ V2 设计阶段任务(已锁定在 §5)
- ❌ V2.x 后续阶段任务(待用户单独拍板)
- ❌ 任何延后模型(`member_profiles` / `attachments` / `audit_logs` / `events` / `event_participants`)的开发任务

> **范围说明**:上述"延后模型"清单是 D7-min 决议时刻(2026-05-07)的快照;`audit_logs` 已于 v0.7.0 作为 V2.x 第一个增量局部启动(经业务确认稿 + D6 评审 + 用户拍板),沿 `ARCHITECTURE.md §12.11.2`;当前仍延后的是 `member_profiles` / `attachments` / `events` / `event_participants` 共 4 个;`audit_logs` 剩余 22 处迁移见 [`docs/V2红线与复活路径.md`](../docs/V2红线与复活路径.md) §4.1 C-1。

**任何"看起来该顺手做"的事项**(包括延后模型、暂不做项、未登记新依赖等),按 §6.10 范围外统一处理流程,**禁止**未经用户确认就动作。

### 6.1 任务总览

| Step | 任务 | 状态 | 主要文件范围 | 前置 |
|---|---|---|---|---|
| **Step 1** | Prisma schema + migration | ✅ 已完成 (commit `36c0837`) | `prisma/schema.prisma` / `prisma/migrations/20260507181930_v2_foundation/` | **D8 用户最终拍板** |
| **Step 2** | seed neutral-demo | ✅ 已完成 (commit `53c9a03`) | `prisma/seed.ts` | Step 1 |
| **Step 3** | dictionaries 模块 | ✅ 已完成 (commit `33dbd69`) | `src/modules/dictionaries/` | Step 1-2 |
| **Step 4** | organizations 模块 | ✅ 已完成 (commit `da54cf3`) | `src/modules/organizations/` | Step 3 |
| **Step 5** | members 模块 + v1 users.memberId hook + v1 auth.service.ts 登录回退 | ✅ 已完成 (commits `1baa6c6` + `c8bc4fd`) | `src/modules/members/` + `src/modules/auth/auth.service.ts`(**唯一受限放开**;memberNo 登录回退查找;v1 users.service / dto 经评估**未改动**)| Step 3 |
| **Step 6** | member_departments 归属能力 | ✅ 已完成 (commit `54a14e0`) | `src/modules/member-departments/`(独立模块) | Step 4 + Step 5 |
| **Step 7** | E2E + contract + 文档收口 | ✅ 已完成 (commit `9f42a9a`) | `README.md` + `CHANGELOG.md`(snapshot Step 6 已锁定;TASKS.md §6 收尾走本 G commit) | Step 1-6 全部完成 |

**总览铁律**:Step 1 启动需用户**单独拍板**触发;**不得**因 V2-D8 ✅ 就跳进 Step 1。

### 6.2 Step 1 — Prisma schema + migration

- **状态**:✅ 已完成(commit `36c0837`,2026-05-08)
- **前置条件**:
  - V2-D8 ✅(已满足)
  - **用户单独拍板"启动 Step 1"**(待满足)
  - 工作树干净(无未 commit 改动)
- **允许改动**:
  - 新增 5 个 Prisma model:`DictType` / `DictItem` / `Organization` / `Member` / `MemberDepartment`
  - `Member` model 必含 `memberNo` 字段:String / 必填 / **普通全局唯一约束**(不用部分唯一索引;**包含软删记录全表唯一**,软删后不释放)/ 字段长度 1-32 / 字符集 `[A-Za-z0-9-]`(详见 `docs/v2-data-model.md §5.2-§5.3`)
  - 修改 v1 `User` model:**仅**追加可空 `memberId` 字段 + 关系到 `Member`(其他字段 / 索引 / 外键全部不动)
  - 生成 migration 文件(命名 `<timestamp>_v2_foundation` 或拆多个)
  - 跑 `pnpm prisma:generate` / `pnpm prisma:migrate dev`(本地)/ `pnpm prisma:deploy`(CI)
- **禁止改动**:
  - ❌ 不写任何业务代码(`src/modules/<v2-business>/` 不创建)
  - ❌ 不写 seed 业务数据(留 Step 2)
  - ❌ 不修改 `users.service.ts` / `users.dto.ts` / `users.controller.ts`(留 Step 5)
  - ❌ 不实装 5 个延后模型的 schema
  - ❌ 不修改 `docker-compose.yml` / 任何 config / env
  - ❌ 不修改 v1 14 接口契约
- **交付物**:
  - `prisma/schema.prisma` 改动(5 model 新增 + User 加 memberId)
  - `prisma/migrations/<timestamp>_*/migration.sql` 文件
  - Prisma client 重新生成
  - 本地 + CI 测试库迁移成功
- **验收命令**(对齐 baseline §13):
  - A 档:`pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm test:e2e`(v1 既有零退化)/ `pnpm test:contract`(OpenAPI 不变)
  - B 档:`pnpm start:dev` 服务启动 / `curl /api/health/live` / `curl /api/health/ready` / SIGTERM 优雅关闭
- **回滚风险**:
  - migration 反向需 `prisma migrate reset`(用户授权 Prisma 安全机制)
  - v1 表结构破坏:**风险极低**,因仅 ADD COLUMN(`users.memberId`)+ 新表,无 ALTER 既有字段
  - 回滚:`git revert <commit>` + `pnpm prisma migrate reset --force --skip-seed`(需用户授权)+ `pnpm prisma:deploy`
- **建议 commit message**:`chore(prisma): add V2 foundation schema (4 models + users.memberId)`
- **完成情况**(2026-05-08):
  - commit `36c0837` `chore(prisma): add V2 foundation schema (4 models + users.memberId)`
  - 交付:`prisma/schema.prisma` 改动 + `prisma/migrations/20260507181930_v2_foundation/migration.sql` 新增
  - 决策点 D-1 落地:migration 末尾手动追加 `MemberDepartment_memberId_active_key` partial unique index(`memberId` 在 `deletedAt IS NULL` 范围内唯一)
  - A 档全过:`pnpm lint` / `pnpm typecheck` / `pnpm test`(177 passed)/ `pnpm test:e2e`(19 suites / 162 tests v1 零退化)/ `pnpm test:contract`(29 tests / 2 snapshots OpenAPI 零漂移)
  - B 档全过:`pnpm start:dev` 启动成功 / `GET /api/health/live` 200 / `GET /api/health/ready` 200(`db: up`)/ `GET /api/health` v1 兼容 200 / SIGTERM 优雅关闭
  - 范围合规:仅触碰 `prisma/`,v1 `src/**` / `seed.ts` / `package.json` / Docker / CI / config 全部零改动
  - Step 2 仍 ⏳ 待启动,等用户单独拍板触发

### 6.3 Step 2 — seed neutral-demo

- **状态**:✅ 已完成(commit `53c9a03`,2026-05-08)
- **前置条件**:Step 1 完成
- **允许改动**:
  - 修改 `prisma/seed.ts`,**追加** 2 类字典类型 neutral-demo seed(节点类别 / 队员等级)
  - 占位 items(neutral-demo 抽象值,如 `demo-type-1` / `demo-grade-1`)
  - seed 必须**幂等**(跑两次结果一致)
- **禁止改动**:
  - ❌ 不写真实部门类别名(具体业务上的部门 / 小组 / 编组类别取值)
  - ❌ 不写真实等级名(具体业务上的等级 / 资质取值)
  - ❌ 不预填业务数据(无 organizations / members / member_departments seed)
  - ❌ 不修改 SUPER_ADMIN seed 逻辑
  - ❌ 不写 5 延后模型的 seed
  - ❌ seed 不强制 SUPER_ADMIN 绑 member(`memberId` 默认 null)
- **交付物**:
  - `prisma/seed.ts` 改动(neutral-demo 字典 seed 追加)
  - 跑两次 `pnpm prisma:seed` 幂等校验通过
- **验收命令**:
  - A 档:`pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm test:e2e` / `pnpm test:contract`
  - B 档:`pnpm prisma:seed` 跑两次幂等 + `pnpm start:dev` 启动
- **回滚风险**:`git revert <commit>` + `pnpm prisma:seed`(回到上一版 seed 状态);风险**极低**
- **建议 commit message**:`chore(seed): add V2 foundation neutral-demo dict seed`
- **完成情况**(2026-05-08):
  - commit `53c9a03` `chore(seed): add V2 neutral demo dictionary seeds`
  - 交付:`prisma/seed.ts` 改动(+88/-21);新增 `V2_DICT_SEED` 常量 + `seedV2Dictionaries()` 函数;SUPER_ADMIN 控制流 `return` → `if/else`,确保 SUPER_ADMIN 已存在时仍续跑字典 seed(创建逻辑代码零改动)
  - type code 决议(B-2):`node_type` + `member_grade`(snake_case 命名风格对齐);Step 2 commit 时 `docs/v2-plan.md §2.2` 草案与实施 dict_type code 的差异已通过 housekeeping 同步至 `member_grade`
  - 数据清单:dict_types = 2(`node_type` / `member_grade`)+ dict_items = 4(每类 2 个 `demo-*` 抽象占位,全部 `parentId = null` 顶层、`status = ACTIVE`、`sortOrder` 0/1)
  - 幂等策略:`upsert` + `update: {}` 不覆盖运营运行时手动调整;两次 `pnpm prisma:seed` 后 dict_types / dict_items 行数不变
  - A 档全过:`pnpm lint` / `pnpm typecheck` / `pnpm test`(177 passed)/ `pnpm test:e2e`(19 suites / 162 tests v1 零退化)/ `pnpm test:contract`(29 tests / 2 snapshots OpenAPI 零漂移)
  - B 档全过:`pnpm prisma:seed` 跑两次幂等(输出一致 + SQL 验证 dict_types = 2 / dict_items = 4)/ `pnpm start:dev` 启动成功 / `GET /api/health/live` 200 / `GET /api/health/ready` 200(`db: up`)/ SIGTERM 优雅关闭
  - 范围合规:仅触碰 `prisma/seed.ts`,schema / migration / `src/**` / `package.json` / Docker / CI / config / env 全部零改动
  - Step 3 仍 ⏳ 待启动,等用户单独拍板触发

### 6.4 Step 3 — dictionaries 模块

- **状态**:✅ 已完成(commit `33dbd69`,2026-05-08)
- **前置条件**:Step 1-2 完成
- **允许改动**:
  - 新建 `src/modules/dictionaries/` 4 文件(`module.ts` / `controller.ts` / `service.ts` / `dto.ts`)
  - 实施 dict_types + dict_items 双表 CRUD(对照 `docs/v2-api-contract.md §2`,13 接口)
  - dict_items 父子树形查询能力
  - 启停 / 软删显式封装(用 `notDeletedWhere` helper)
  - BizCode 段位 `120xx + 121xx`(对齐 baseline §1.1)
  - Swagger 100% 覆盖 + DTO 白名单
  - e2e 测试覆盖(`test/e2e/dictionaries.e2e-spec.ts`)
  - OpenAPI 契约快照更新(`pnpm test:contract -u`)
- **禁止改动**:
  - ❌ 不写真实字典内容(seed 真实取值)
  - ❌ 不开发 organizations / members / member_departments(留 Step 4-6)
  - ❌ 不开发 5 延后模型
  - ❌ 不接入 audit_logs(audit_logs 已延后)
  - ❌ 不实现字典缓存(沿用 v1 §1 不主动加缓存)
  - ❌ 不实现复杂查询(全文搜索 / 多语言 / metadata 高级查询等)— 仅基础 CRUD
  - ❌ RBAC / permission 表 / casl 等权限框架(沿用 v1 §1)
  - ❌ 批量导入导出
- **交付物**:
  - 4 文件模块就位
  - 13 接口契约一致(对照 v2-api-contract.md §2)
  - Swagger 100% 覆盖 / DTO 白名单 / 软删显式封装
  - BizCode 新增条目按段位 `120xx + 121xx`
  - e2e 覆盖典型成功 / 错误路径
  - OpenAPI 契约快照更新
- **验收命令**:
  - A 档:`pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm test:e2e`(v1 + V2 dictionaries)/ `pnpm test:contract -u`(快照更新后通过)
  - B 档(必跑):`pnpm start:dev` / `curl /api/docs` Swagger UI / `curl /api/docs-json` / dict_types 列表接口 spot check / 错误路径 spot check / SIGTERM
- **回滚风险**:`git revert <commit>` 模块整体撤回;schema 不动(Step 1 已固化)
- **建议 commit message**:`feat(dictionaries): add V2 foundation dictionaries module`
- **完成情况**(2026-05-08):
  - commit `33dbd69` `feat(dictionaries): add V2 foundation dictionaries module`
  - 交付:5 新文件(`dictionaries.module.ts` / `dictionaries.dto.ts` / `dictionaries.service.ts` / `dictionaries.controller.ts` + `test/e2e/dictionaries.e2e-spec.ts`)+ 5 改动(`app.module.ts` 注册 / `biz-code.constant.ts` +9 / `test/contract/openapi.contract-spec.ts` + snapshot / `test/setup/reset-db.ts` 扩 TRUNCATE);共 10 files / +4528 / -2
  - 4 文件铁律:`dictionaries.controller.ts` 单文件双 @Controller 类(DictTypesController + DictItemsController),严格符合 CLAUDE.md §2 / baseline §5.1
  - 13 接口落地:`/api/v2/dict-types` 6 + `/api/v2/dict-items` 7(含 `/tree` 在 `/:id` 之前定义防 first-match 冲突)
  - 5 决策点落地:① DELETE 引用查 dict_items + organizations.nodeTypeCode + members.gradeCode(Step 4-5 后无需补)/ ② 不登记 121xx FORBIDDEN_MANAGE_DICTIONARY / ③ DictItemTreeNodeDto 独立类 / ④ tree 深度无限制 / ⑤ 引用检查 + 软删事务原子性
  - 9 条新 BizCode(120xx + 121xx 段;dict_type=12001-12002/12030,dict_item=12010-12014/12031)
  - 软删显式封装:`notDeletedWhere` helper / 唯一性预检查 `findUnique` 包含软删 / P2002 兜底转 BizCode
  - A 档全过:`pnpm lint` / `pnpm typecheck` / `pnpm test`(4 suites / 222 tests,v1 177 + 新增 45 = BizCode 9 × 5 断言)/ `pnpm test:e2e`(20 suites / 197 tests,v1 162 零退化 + V2 35)/ `pnpm test:contract`(51 tests / 2 snapshots,v1 29 + V2 22)
  - B 档全过:`pnpm start:dev` / `GET /api/docs` 200 / `/api/health/live` 200 / `/api/health/ready` 200(`db: up`)/ `/api/v2/dict-types` 未登录 401(UNAUTHORIZED)/ `/api/docs-json` 含 v1 10 paths + V2 7 paths / SIGTERM 优雅关闭
  - v1 14 接口 OpenAPI schema + paths **零漂移**:用 inline node 脚本逐个 schema(11 项)/ path(10 项)严格字符串相等比对,全部 OK
  - 范围合规:仅触碰 `src/modules/dictionaries/` + `src/app.module.ts` + `src/common/exceptions/biz-code.constant.ts` + `test/`(基建 + e2e + contract);schema / migrations / seed / users / auth / health / database / bootstrap / config / package / Docker / CI 全部零改动
  - Step 4 仍 ⏳ 待启动,等用户单独拍板触发

### 6.5 Step 4 — organizations 模块

- **状态**:✅ 已完成(commit `da54cf3`,2026-05-08)
- **前置条件**:Step 1-3 完成(依赖字典 nodeTypeCode)
- **允许改动**:
  - 新建 `src/modules/organizations/` 4 文件
  - 实施树形 CRUD(对照 `docs/v2-api-contract.md §3`,7 接口)
  - 树形查询(按 parentId 拼接子树)
  - 新增 / 编辑 / 停用 / 软删
  - parentId 创建时设置(可空 = 根节点)
  - **PATCH 严禁改 parentId**:DTO 白名单不含;业务码 `ORGANIZATION_PARENT_CHANGE_FORBIDDEN`
  - nodeTypeCode 走字典(联动 §6.4 字典模式;创建 / 更新时 service 层校验存在性 + status=ACTIVE)
  - 节点撤销:启停 status + 防御性 deletedAt
  - BizCode 段位 `110xx + 111xx`
  - Swagger 100% 覆盖 + DTO 白名单 + 软删显式封装
  - e2e 测试覆盖
- **禁止改动**:
  - ❌ 改父级(D7-min O-1 锁定)
  - ❌ 临时编组(D7-min O-4 锁定延后)
  - ❌ 节点负责人 / 简介 / 联系方式 / 内部编号 等扩展属性(D7-min O-5 锁定延后)
  - ❌ 跨部门小组(D7-min O-4 锁定延后)
  - ❌ 真实部门名(seed neutral-demo,真实取值由运营录入;R13 红线)
  - ❌ 不接入 audit_logs(已延后)
- **交付物**:
  - 4 文件模块就位
  - 7 接口契约一致
  - 树形查询能力
  - nodeTypeCode 字典 code 校验
  - 启停 + 软删 + BizCode 段位 + Swagger / e2e / OpenAPI 快照
- **验收命令**:
  - A 档:同 §6.4
  - B 档(必跑):`pnpm start:dev` + Swagger + 树形查询 spot check + 不可改父级 spot check + SIGTERM
- **回滚风险**:同 §6.4(模块整体可 revert)
- **建议 commit message**:`feat(organizations): add V2 foundation organizations module`
- **完成情况**(2026-05-08):
  - commit `da54cf3` `feat(organizations): add V2 foundation organizations module`
  - 交付:5 新文件(`organizations.module.ts` / `organizations.dto.ts` / `organizations.service.ts` / `organizations.controller.ts` + `test/e2e/organizations.e2e-spec.ts`)+ 5 改动(`app.module.ts` 注册 / `biz-code.constant.ts` +9 / `test/contract/openapi.contract-spec.ts` + snapshot / `test/setup/reset-db.ts` 扩 TRUNCATE);共 10 files / +2738 / -1
  - 4 文件铁律严格符合 CLAUDE.md §2 / baseline §5.1
  - 7 接口落地:`GET /api/v2/organizations`(列表;`?parentId=null` 字面值过滤根)/ `GET /tree`(在 `:id` 之前定义;深度无限制)/ `POST` / `GET/PATCH/DELETE /:id` / `PATCH /:id/status`
  - 8 决策点全部按修订执行:① CYCLE/PARENT_CHANGE_FORBIDDEN 登记备用 ② 不登记 FORBIDDEN_MANAGE_ORGANIZATION ③ 引用查 organizations.parentId + member_departments.organizationId(Step 6 后无需补) ④ **单根上限不区分 status**(`deletedAt=null` 即占位) ⑤ last-root 保护两场景(DELETE 根 + PATCH status=INACTIVE 根)⑥ `'node_type'` 模块内常量化 ⑦ OrganizationTreeNodeDto 独立类(沿用 dictionaries) ⑧ DTO @IsString + service 转换字面值
  - 9 条新 BizCode(110xx + 111xx 段位):11001 NOT_FOUND / 11010 PARENT_NOT_FOUND / 11011 NODE_TYPE_INVALID / 11012 PARENT_CYCLE / 11013 PARENT_CHANGE_FORBIDDEN(后两条 DTO 兜底登记备用)/ 11030 HAS_CHILDREN / 11031 HAS_MEMBERS / 11032 ROOT_ALREADY_EXISTS / 11103 LAST_ROOT_PROTECTED
  - nodeTypeCode 6 项 AND 校验:`dict_type.code='node_type'` + `status=ACTIVE` + `deletedAt=null` + `dict_item.code=nodeTypeCode` + `status=ACTIVE` + `deletedAt=null`(N:1 关系 filter 一次查询完成)
  - 软删显式封装:`findFirst + notDeletedWhere`(详情查询禁 `findUnique`);引用检查 + 软删全部包在 `prisma.$transaction`(决策 5 修订)
  - PATCH 严格白名单:`UpdateOrganizationDto` 仅 `name / sortOrder / nodeTypeCode`,**绝对不含** `parentId`(D7-min O-1 红线);e2e `PATCH 拒绝 parentId(forbidNonWhitelisted)` 测试覆盖
  - A 档全过:`pnpm lint` / `pnpm typecheck` / `pnpm test`(4 suites / 267 tests,222 + 新增 45 = 9 BizCode × 5 断言)/ `pnpm test:e2e`(21 suites / 225 tests,v1 162 零退化 + dict 35 零退化 + org 28)/ `pnpm test:contract`(63 tests / 2 snapshots)
  - B 档全过:`pnpm start:dev` / `GET /api/docs` 200 / `/api/health/live` 200 / `/api/health/ready` 200(`db: up`)/ `/api/v2/organizations` 未登录 401(UNAUTHORIZED)/ `/api/docs-json` v1 10 paths + V2 11 paths(dict 7 + org 4) / SIGTERM 优雅关闭
  - v1 14 接口 + Step 3 dictionaries OpenAPI schema + paths **零漂移**:用 inline node 脚本逐个 schema(v1 11 + dict 9 = 20 项)/ path(v1 10 + dict 7 = 17 项)严格字符串相等比对,全部 OK
  - 范围合规:仅触碰 `src/modules/organizations/` + `src/app.module.ts` + `src/common/exceptions/biz-code.constant.ts` + `test/`(基建 + e2e + contract);schema / migrations / seed / users / auth / health / dictionaries / database / bootstrap / config / package / Docker / CI 全部零改动
  - **后续 housekeeping(不阻塞 Step 4)**:
    - `ORGANIZATION_ROOT_ALREADY_EXISTS` message 措辞后续可优化为"系统已存在根节点"或"系统已存在未软删除根节点"(当前措辞"活跃根节点"与实现 `deletedAt=null` 不区分 status 略有歧义)
    - Step 6 落地 `MemberDepartment` 真实归属数据后,统一检查 `test/setup/reset-db.ts` TRUNCATE 顺序(当前依赖 PostgreSQL CASCADE 自动级联,Step 6 后建议显式列入)
  - Step 5 仍 ⏳ 待启动,等用户单独拍板触发

### 6.6 Step 5 — members 模块

- **状态**:✅ 已完成(commits `1baa6c6` + `c8bc4fd`,2026-05-08)
- **前置条件**:Step 1-3 完成(依赖字典 gradeCode)
- **允许改动**:
  - 新建 `src/modules/members/` 4 文件
  - 实施 members CRUD(对照 `docs/v2-api-contract.md §4`,6 接口);含 `memberNo` 全生命周期:
    - POST 创建 memberNo 必填 + 弱约束校验(`@MinLength(1)` / `@MaxLength(32)` / `@Matches(/^[A-Za-z0-9-]+$/)`)
    - 入库前 `trim()` 保留原大小写
    - 唯一性预检查走 `findUnique` 包含软删记录;撞约束抛 `MEMBER_NO_ALREADY_EXISTS`(150xx,409)
    - GET 列表支持 `?memberNo=<exact>` 精确查询
    - GET 详情 + POST/PATCH 响应 MemberResponseDto 必返 memberNo
    - **UpdateMemberDto 白名单不含 memberNo**(forbidNonWhitelisted 自动拒绝 PATCH 改编号)
  - **修改 v1 `src/modules/users/users.service.ts`** 追加 `memberId` 字段处理逻辑(仅服务侧;v1 接口出参不变)
  - **修改 v1 `src/modules/users/users.dto.ts`**(若 Step 5 决定 v1 接口可选返回 `memberId`,需显式说明 + 更新 OpenAPI 快照;**默认不改**)
  - ⚠️ **受限放开** 修改 v1 `src/modules/auth/auth.service.ts`:**唯一**允许的扩展是登录查找路径加 `memberNo` 回退查找(对应 ARCHITECTURE.md §12.8.2.4 + `docs/v2-api-contract.md §6.6` 全部硬约束):
    - 账号枚举相关失败场景防护(响应体 / HTTP status / Timing 完全一致;详见 `docs/v2-api-contract.md §6.6.3`)
    - 强制扩展 dummy bcrypt 到新路径
    - 通过 `PrismaService` 直读 `member` 表
    - 禁止 import `MembersModule` / `MembersService` / V2 BizCode
    - 复用 `LOGIN_FAILED = 10004`,**禁止**自创新业务码
  - gradeCode 走字典(联动 §6.4)
  - status 切换:`ACTIVE` ↔ `INACTIVE`(独立接口 `PATCH /:id/status`)
  - BizCode 段位 `150xx + 151xx`(新增 `MEMBER_NO_ALREADY_EXISTS` 等)
  - `assertCanManageMember` Service 层显式校验(沿用 v1 §13)
  - Swagger 100% 覆盖 + DTO 白名单 + 软删显式封装
  - e2e 覆盖管理员路径 + 角色边界 + memberNo CRUD + memberNo 登录回退账号枚举相关失败场景(详见 `docs/v2-api-contract.md §6.6.3`)+ Timing 抽样 + **v1 接口零退化** + **v1 LoginDto schema 零漂移**
- **禁止改动**:
  - ❌ **任何敏感字段**(身份证 / 紧急联系人 / 医疗 / 出生日期 / 住址 / 性别 / 联系方式 等)— DTO 白名单严格拒绝
  - ❌ 不在 members 主表挂 `organizationId`(完全走 §6.7 member_departments)
  - ❌ 不在 v1 `UserResponseDto` 出参中**新增必返**字段(`memberId` / `memberNo` 默认不返回);**禁止**默认改成可选返回 memberNo(对齐 memberNo 决议 Q7;前端展示 memberNo 走 V2 members 接口)
  - ❌ **不**修改 v1 `auth.controller.ts` / `auth.dto.ts`(LoginDto 字段名 / 类型 / 校验装饰器 / 路径全保留;HTTP 契约零漂移)
  - ❌ **不**修改 v1 `auth/strategies/*`(JwtStrategy 等)
  - ❌ 不修改 v1 `health/` / `bootstrap/` / `database/prisma.service.ts`
  - ❌ 不实现 member_profiles(已延后)
  - ❌ 不实现资质维度(D5 未触及,延后)
  - ❌ 不实现"用户绑定/解绑 member"接口(留 V2.x)
  - ❌ 不开发"改 memberNo"独立接口(留 V2.x 评估)
  - ❌ 不为 memberNo 登录路径自创业务码(必须复用 v1 `LOGIN_FAILED`)
  - ❌ auth.service **禁止** import `MembersModule` / `MembersService` / V2 BizCode 段位常量
- **交付物**:
  - 4 文件模块就位
  - v1 `users.service.ts` 追加 memberId 处理(v1 接口契约不变)
  - v1 `auth.service.ts` 登录查找扩展(memberNo 回退 + dummy bcrypt 扩展;HTTP 契约 / OpenAPI schema 零漂移)
  - 6 接口契约一致(含 memberNo 入参 / 出参 / 查询 / 错误码)
  - gradeCode 字典 code 校验
  - status 切换 + 软删显式封装
  - `assertCanManageMember` Service 层校验
  - Swagger / e2e / OpenAPI 快照(V2 新接口加入;v1 14 接口含 LoginDto schema 全部不漂移)
- **验收命令**:
  - A 档:同 §6.4,**重点验证 v1 14 接口零退化 + v1 LoginDto schema 零漂移**
  - B 档(必跑):
    - `pnpm start:dev`
    - v1 `POST /api/auth/login`(username 登录)→ 200,响应不含 memberId / memberNo
    - v1 `POST /api/auth/login`(memberNo 登录,新功能)→ 200,响应 schema 与 username 登录完全一致
    - v1 `POST /api/auth/login` 账号枚举相关失败场景防护(输入值两路径均未命中 / member 未绑 user / 账号禁用或软删 / 密码错)→ 401 + LOGIN_FAILED 10004,响应体 / 耗时一致
    - v1 `GET /api/users/me` → 200,响应不含 memberNo
    - V2 `GET /api/v2/members` → 200(管理员)+ 详情含 memberNo / 403(USER)
    - V2 `GET /api/v2/members?memberNo=<value>` → 200 + 精确匹配
    - V2 `POST /api/v2/members`(无 memberNo / 撞唯一)→ 400 / 409
    - V2 `PATCH /api/v2/members/:id { memberNo: '...' }` → 400(forbidNonWhitelisted)
    - `pnpm test:contract` 严格证明 v1 LoginDto schema diff = 0
    - SIGTERM 关停
- **回滚风险**:
  - `git revert <auth-commit>` 单独撤回 auth(因强制拆 2 commit,可独立回滚)
  - `git revert <members-commit>` 单独撤回 members CRUD
  - 两 commit 独立可回滚;e2e 护栏护住回归
- **建议 commit message**(memberNo 决议:**强制拆 2 commit**,见 `docs/v2-plan.md §2.5` commit message 段全文):
  - Commit 1:`feat(members): add memberNo to member lifecycle`(members CRUD + v1 users.memberId hook)
  - Commit 2:`feat(auth): support memberNo login fallback`(auth.service.ts 登录回退;**仅含此一处文件改动 + 配套 e2e + 快照对比**;**严禁**与 members CRUD 揉合)
- **完成情况**(2026-05-08):
  - **强制拆 2 commit**(ARCHITECTURE.md §12.8.2.4 / docs/v2-plan.md §2.5 / CLAUDE.md §17 红线;严禁揉合;独立可 revert):
    - **Commit 1** `1baa6c6` `feat(members): add memberNo to member lifecycle`(10 files / +2299 / -1)
      - 文件范围:`src/app.module.ts` / `src/common/exceptions/biz-code.constant.ts` / `src/modules/members/`(4 文件)/ `test/contract/openapi.contract-spec.ts` + snapshot / `test/e2e/members.e2e-spec.ts` / `test/setup/reset-db.ts`
      - **不含**:`auth.service.ts` / `auth-memberno-login.e2e-spec.ts`
    - **Commit 2** `c8bc4fd` `feat(auth): support memberNo login fallback`(2 files / +273 / -10)
      - 文件范围:`src/modules/auth/auth.service.ts` / `test/e2e/auth-memberno-login.e2e-spec.ts`
      - **不含**:members / contract / biz-code / app.module / reset-db
  - members 6 接口落地:`GET /api/v2/members`(列表 + memberNo 精确查询 + gradeCode/status 过滤)/ `POST`(memberNo 必填全局唯一不复用)/ `GET/:id` / `PATCH/:id`(白名单仅 displayName/gradeCode)/ `PATCH/:id/status` / `DELETE/:id`(SA 专属 + active dept + linked user 引用拒删)
  - memberNo 全生命周期:DTO `@Matches(/^[A-Za-z0-9-]+$/)` + `@MinLength(1)` + `@MaxLength(32)` + service `trim()` 保留大小写 + `findUnique` 包含软删唯一性预检查(不复用)+ P2002 兜底转 `MEMBER_NO_ALREADY_EXISTS` + PATCH 严禁改 memberNo(forbidNonWhitelisted 兜底)
  - gradeCode 6 项 AND 校验:`dict_type.code='member_grade'` + `status=ACTIVE` + `deletedAt=null` + `dict_item.code=gradeCode` + `status=ACTIVE` + `deletedAt=null`(N:1 关系 filter 一次查询);`MEMBER_GRADE_DICT_CODE` 模块内常量化
  - **auth.service.ts memberNo 登录回退**(唯一受限放开):
    - 服务端查找路径扩展(对应 `docs/v2-api-contract.md §6.6.2`):username 未命中 → trim 后(原大小写)按 memberNo 在 member 表 `findUnique` → 含全表手动 `deletedAt === null` 过滤 → 反查 `users.memberId` 找 user
    - 严守红线:`LoginDto` schema 0 改动 / `LoginResponseDto` schema 0 改动 / `LOGIN_FAILED = 10004` 复用(**禁止**自创业务码)/ Timing dummy bcrypt 强制扩展到 memberNo 路径 / `PrismaService` 直读 member,**禁止** import `MembersModule`/`MembersService`/V2 BizCode(防 v1→V2 循环依赖)/ 不改 `auth.controller.ts`/`auth.dto.ts`/`auth/strategies/*`
    - 账号枚举防护 4 场景全部统一抛 `LOGIN_FAILED`(响应体 / HTTP / message 完全一致)
  - **v1 users.memberId hook 评估结果**:本步**未改** `src/modules/users/users.service.ts` / `users.dto.ts` — v1 14 接口契约不需要 memberId 字段(对齐 §12.8.2.1 红线 + memberNo 决议 Q7);`users.memberId` 关联完全由 schema 字段(Step 1 已建)+ V2 members 模块独立维护;用户绑定/解绑接口留 V2.x,运营当前通过 DB 直改(B 档 spot check 已验证)
  - 5 条新 BizCode(150xx 段位;**不登记** `FORBIDDEN_MANAGE_MEMBER`):15001 NOT_FOUND / 15002 MEMBER_NO_ALREADY_EXISTS / 15010 GRADE_CODE_INVALID / 15030 HAS_ACTIVE_DEPARTMENT / 15031 HAS_LINKED_USER
  - 软删显式封装(baseline §10):`findFirst + notDeletedWhere`(详情查询禁 `findUnique`)+ 引用检查 + 软删事务原子(`prisma.$transaction`);软删 = `update({ deletedAt, status: INACTIVE })`,**不**自动解除 user 绑定 / **不**自动解除 active dept
  - **`LoginDto` / `LoginResponseDto` / `UserResponseDto` 严格 zero drift**(memberNo 登录回退是纯 service 层扩展,无 DTO/schema 变化)
  - A 档全过:`pnpm lint` / `pnpm typecheck` / `pnpm test`(4 suites / 292 tests,267 + 新增 25 = 5 BizCode × 5 断言)/ `pnpm test:e2e`(23 suites / 263 tests,v1 162 零退化 + dict 35 + org 28 + members 25 + memberNo login 13)/ `pnpm test:contract`(73 tests / 2 snapshots)
  - B 档全过:`pnpm start:dev` / `GET /api/docs` 200 / `/api/health/live` 200 / `/api/health/ready` 200(`db: up`)/ v1 `POST /api/auth/login`(username/admin)200 / v1 `GET /api/users/me` 出参**不含** memberId/memberNo / `POST /api/v2/members` 含 memberNo 不含 deletedAt / DB 直改绑定 admin.memberId / `POST /api/auth/login`(memberNo `demo-spot-001`)200 + accessToken / 账号枚举 3 场景全部 `LOGIN_FAILED 10004` 同 message / `/api/docs-json` v1 10 + V2 14 paths(dict 7 + org 4 + members 3) / SIGTERM 优雅关闭
  - **v1 + dict + org zero drift**:严格 inline node 比对 v1 11 + dict 9 + org 5 = 25 schemas + v1 10 + dict 7 + org 4 = 21 paths 全部 OK(commit 1 重生成 snap 后即冻结;commit 2 不改 snap)
  - 范围合规:仅触碰 `src/modules/members/` + `src/modules/auth/auth.service.ts`(唯一受限放开)+ `src/app.module.ts` + `src/common/exceptions/biz-code.constant.ts` + `test/`(基建 + e2e + contract);schema / migrations / seed / users.service / users.dto / users.controller / auth.controller / auth.dto / auth/strategies / health / database / bootstrap / config / package / Docker / CI 全部零改动
  - Step 6 仍 ⏳ 待启动,等用户单独拍板触发

### 6.7 Step 6 — member_departments 归属能力

- **状态**:✅ 已完成(commit `54a14e0`,2026-05-08)
- **前置条件**:Step 1-5 完成
- **允许改动**:
  - 部门归属接口(对照 `docs/v2-api-contract.md §5`,3 接口;路径**嵌套**在 `members/:memberId/department/`)
  - 实施位置:`src/modules/member-departments/` **或**作为 `src/modules/members/` 的子能力(由 Step 6 实施时按 NestJS 路由组织决定)
  - 查询当前正式部门 / 设置 / 更换 / 解除
  - **单归属唯一约束**:`(memberId)` 在 `deletedAt = null` 范围内唯一
  - PUT 幂等单事务(已有归属 → 软删旧 + 创建新)
  - BizCode 段位 `170xx + 171xx`
  - 错误码:`MEMBER_DEPARTMENT_NOT_FOUND` / `MEMBER_DEPARTMENT_ALREADY_EXISTS` / `MEMBER_INACTIVE` / `ORGANIZATION_INACTIVE`
  - Swagger / DTO 白名单 / 软删显式封装
  - e2e 覆盖一人一部门约束 / 软删后重新归属 / 跨实体引用
- **禁止改动**:
  - ❌ 一人多部门能力(D7-min MD-6 锁定不做)
  - ❌ 引入 `isPrimary` / `joinedAt` / `endedAt` / 进出原因 字段(D7-min MD-5 锁定不引入)
  - ❌ 跨部门角色 / 等级独立性(默认全队统一)
  - ❌ 部门归属变更历史保留(D5 Q18 ② 锁定不保留)
  - ❌ 不接入 audit_logs(已延后)
- **交付物**:
  - 3 接口契约一致
  - 单归属唯一约束业务规则(部分唯一索引或全局约束 + 业务规则)
  - 软删时旧记录由 deletedAt 区分,新归属不撞约束
  - BizCode 段位 / Swagger / e2e / OpenAPI 快照
- **验收命令**:
  - A 档:同 §6.4
  - B 档:`pnpm start:dev` + 一人一部门约束 spot check(尝试给同一 member 挂两个部门 → 应失败) + SIGTERM
- **回滚风险**:`git revert <commit>`;Prisma 部分唯一索引若不支持需降级路径(详见 `v2-data-model.md §6.3`)
- **建议 commit message**:`feat(member-departments): add V2 foundation member-departments capability`
- **完成情况**(2026-05-08):
  - commit `54a14e0` `feat(member-departments): add V2 foundation member-departments capability`
  - 交付:5 新文件(`member-departments.module.ts` / `member-departments.dto.ts` / `member-departments.service.ts` / `member-departments.controller.ts` + `test/e2e/member-departments.e2e-spec.ts`)+ 5 改动(`app.module.ts` 注册 / `biz-code.constant.ts` +4 / `test/contract/openapi.contract-spec.ts` + snapshot / `test/setup/reset-db.ts` 显式加 MemberDepartment);共 10 files / +1379 / -1
  - 4 文件铁律严格符合 CLAUDE.md §2 / baseline §5.1;**独立模块** `src/modules/member-departments/`(非 members 子能力)
  - 3 接口落地(嵌套在 `members/:memberId/` 下,单数 'department' 表达一人一部门):
    - `GET /api/v2/members/:memberId/department`(无归属返 `data: null`)
    - `PUT /api/v2/members/:memberId/department`(幂等设置;同 org 直接返回不更新;不同 org 软删旧 + 创建新单事务)
    - `DELETE /api/v2/members/:memberId/department`(软删;无归属抛 `MEMBER_DEPARTMENT_NOT_FOUND`)
  - 4 条新 BizCode(170xx 段位;**不登记** `FORBIDDEN_MANAGE_MEMBER_DEPARTMENT`):17001 NOT_FOUND / 17002 ALREADY_EXISTS(并发兜底)/ 17030 MEMBER_INACTIVE / 17031 ORGANIZATION_INACTIVE;复用 `MEMBER_NOT_FOUND` (15001) / `ORGANIZATION_NOT_FOUND` (11001)
  - 8 决策点全部按方案落地:① 独立模块 ② BizCode 17001-17031 ③ 不登记 FORBIDDEN_* ④ GET 无归属返 null ⑤ PUT 同 org 幂等无副作用(直接返回现归属,id / 时间戳不变) ⑥ TRUNCATE 顺序显式 `User, MemberDepartment, Organization, Member, DictItem, DictType` ⑦ DELETE Swagger 复用 `MemberDepartmentResponseDto` ⑧ **P2002 兜底不解析 target,任意 P2002 统一转 `MEMBER_DEPARTMENT_ALREADY_EXISTS`**(因 partial unique index 是 Step 1 migration.sql 末尾手动追加,Prisma client target 不可靠)
  - PUT 不同 org:软删旧 + 创建新在同一 `prisma.$transaction` 原子完成,防撞 partial unique
  - 软删显式封装(baseline §10):`findFirst + notDeletedWhere`(详情查询禁 `findUnique`);引用检查 + 软删事务原子;软删 = `update({ deletedAt })`
  - 单归属约束实施:Step 1 migration 末尾手动追加 partial unique index `MemberDepartment_memberId_active_key ON ("memberId") WHERE "deletedAt" IS NULL` 在 DB 层兜底;e2e 验证直接 DB create 第二条 active → P2002 拒绝,软删后再 PUT 同 org → 创建新归属不撞
  - `test/setup/reset-db.ts` housekeeping 落地(对应 Step 4 完成情况记录的项):TRUNCATE 显式列入 `MemberDepartment`(不再依赖 PostgreSQL CASCADE 自动级联)
  - A 档全过:`pnpm lint` / `pnpm typecheck` / `pnpm test`(4 suites / 312 tests,292 + 新增 20 = 4 BizCode × 5 断言)/ `pnpm test:e2e`(24 suites / 282 tests,v1 162 零退化 + dict 35 + org 28 + members 25 + auth memberNo 13 + member-dept ~22)/ `pnpm test:contract`(78 tests / 2 snapshots)
  - B 档全过:`pnpm start:dev` / `GET /api/docs` 200 / `/api/health/live`/`/ready` 200 + `db: up` / `/api/v2/members/abc/department` 未登录 401 / `/api/docs-json` v1 10 + V2 15 paths(dict 7 + org 4 + members 3 + member-dept 1) / v1 admin login + GET 无归属 null + PUT 设置 200 + GET 有归属 + PUT 同 org 幂等 id 不变 + DELETE 200 + DELETE 再次 → `MEMBER_DEPARTMENT_NOT_FOUND` (17001) / SIGTERM 优雅关闭
  - **v1 + dict + org + members zero drift**:严格 inline node 比对 v1 11 + dict 9 + org 5 + members 4 = 29 schemas + v1 10 + dict 7 + org 4 + members 3 = 24 paths 全部 OK
  - 范围合规:仅触碰 `src/modules/member-departments/` + `src/app.module.ts` + `src/common/exceptions/biz-code.constant.ts` + `test/`(基建 + e2e + contract);schema / migrations / seed / `auth` / `users` / `health` / `dictionaries` / `organizations` / `members` 已有逻辑 / `database` / `bootstrap` / `config` / `package` / Docker / CI 全部零改动;一人多部门 / `isPrimary` / `joinedAt` / `endedAt` / 进出原因 / 部门变更历史 / `audit_logs` / 延后 5 模型 全部不引入
  - **后续 housekeeping(不阻塞 Step 6)**:e2e 间歇性 v1 `auth-login.e2e-spec.ts` `'nonexistentuser'` 收到 HTTP 404 而非 401(LOGIN_FAILED)现象;重跑稳定,与 Step 6 改动无关(未改 auth.service.ts 或全局中间件);可能根因 ThrottlerStorage 跨 spec 累计 / NestJS 路由初始化 race;作为独立 task 跟进
  - Step 7 仍 ⏳ 待启动,等用户单独拍板触发

### 6.8 Step 7 — E2E + contract + 文档收口

- **状态**:✅ 已完成(commit `9f42a9a`,2026-05-08)
- **前置条件**:Step 1-6 全部完成
- **允许改动**:
  - 全量 e2e 跑通(v1 + V2,确认全绿)
  - 契约快照锁定(`__snapshots__/openapi.contract-spec.ts.snap` 一并 commit)
  - 更新 `README.md` "必读文档" / 快速启动 等章节(加 V2 模块说明)
  - 更新 `CHANGELOG.md`:V2 第一阶段开发完成的发布说明
  - 更新 `TASKS.md §6` Step 1-7 标 ✅ 已完成 + V2-D8 二级状态收尾(可选标"已 ship")
  - 同步 `data-model-draft.md` v0.4(可选,标记 4 模型已实施;非必须)
  - **不**更新 `ARCHITECTURE.md §12.7+` 内容(蓝图级,已锁;状态由 TASKS.md 反映)
- **禁止改动**:
  - ❌ 新功能开发(本步纯收口)
  - ❌ schema 改动 / migration 改动
  - ❌ 范围扩张(任何 V2.x 模型 / 任何 v1 接口契约改动)
  - ❌ 修改 baseline / research / interview-brief / research-questions(已锁定)
- **交付物**:
  - 全量 e2e 通过(v1 162 + V2 新增 X 个,全部通过)
  - 契约快照锁定(43 接口 schema 全部稳定)
  - README / CHANGELOG / TASKS.md §6 Step 1-7 标 ✅ + V2-D8 收尾标记
  - V2 第一阶段 ship-readiness audit 通过
- **验收命令**(全跑):
  - A 档:`pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm test:e2e` / `pnpm test:contract` / `pnpm build`
  - B 档:`pnpm start:dev` + Swagger UI 完整含 v1 + V2 接口 + `/api/health/live` + `/api/health/ready` + v1 14 接口典型路径 spot check(全部 200 / 响应契约不变)+ V2 4 模块典型路径 spot check + SIGTERM
- **回滚风险**:本步纯收口;`git revert <commit>` 仅文档 / 快照,无代码运行时影响
- **建议 commit message**:`docs+test: V2 first-stage ship-ready (Step 7 wrap-up)`
- **完成情况**(2026-05-08):
  - F commit:`9f42a9a` `docs: V2 first-stage ship-ready (Step 7 wrap-up)`(2 files / +56)
  - 改动范围:`README.md`(+19;必读文档表追加 v2-plan / v2-data-model / v2-api-contract;路由总览追加 V2 第一阶段摘要表 5 行)+ `CHANGELOG.md`(+37;Unreleased 顶部追加 V2 First Stage 分组,列出 Step 1-6 全部 commit hash + 铁律 + 验收数字 + V2.x 复活路径 + 不在本阶段范围 + 非阻塞 housekeeping)
  - 仅文档收口,**不**改 src / prisma / test / TASKS / docs/v2-* / ARCHITECTURE / baseline / research / data-model-draft / package / Docker / CI / snapshot(Step 6 已锁定)
  - 表述纪律:用"V2 第一阶段开发已完成,等待维护者按需 release / tag",**未**写"全部最终完成 / 正式发布"过满表述
  - **A 档全过**:`pnpm lint` / `pnpm typecheck` / `pnpm test`(312 tests)/ `pnpm test:e2e`(24 suites / 282 tests,**两次连续稳定**,v1 162 零退化)/ `pnpm test:contract`(78 tests / 2 snapshots,**无 -u**,验证 snapshot 文件与 HEAD commit 一致)/ `pnpm build`(**首次跑过**,`dist/main.js` + `dist/app.module.js` 等产物完整生成)
  - **inline node zero drift 全量验证**:`Snapshot 文件与 HEAD 完全一致(无未 commit 漂移)` + 31 schemas + 25 paths 全部 present(v1 11+10 / dict 9+7 / org 5+4 / members 4+3 / member-dept 2+1)
  - **B 档全过**:`pnpm start:dev` / `GET /api/docs` 200 / `/api/health/live` 200 / `/api/health/ready` 200(`db: up`)/ `/api/docs-json` v1 10 + V2 15 paths(dict 7 + org 4 + members 3 + member-dept 1)/ v1 admin 登录 200 + token len=199 / `GET /api/users/me` 出参**不含** memberId / memberNo(zero drift)/ V2 spot check:`GET /api/v2/dict-types` 200 / `GET /api/v2/organizations/tree` 200 / `GET /api/v2/members` 200 / `PUT /api/v2/members/:id/department` 200 / `GET` 归属 200 + orgId 正确 / `DELETE` 归属 200 / SIGTERM 优雅关闭
  - **V2 第一阶段 Step 1-7 全部完成**(F + G commits 全部锁定):
    - Step 1 schema + migration:F=`36c0837` + G=`694a1fa`
    - Step 2 seed neutral-demo:F=`53c9a03` + G=`1189450`
    - Step 3 dictionaries:F=`33dbd69` + G=`411cad6`
    - Step 4 organizations:F=`da54cf3` + G=`88f9c1f`
    - Step 5 members + auth memberNo 回退:F=`1baa6c6` + `c8bc4fd` + G=`2782e82`
    - Step 6 member-departments:F=`54a14e0` + G=`2e7ecb4`
    - Step 7 ship-ready 收口:F=`9f42a9a` + G=本 commit
  - **后续 housekeeping**(已记录 CHANGELOG / 历次完成情况,**非阻塞**;**不在本 commit 处理**):
    - e2e 间歇性 v1 `auth-login.e2e-spec.ts` `'nonexistentuser'` 收到 HTTP 404 而非 401 现象(Step 7 两次连续 282/282 稳定,**未复现**;独立 task 跟进)
    - `ORGANIZATION_ROOT_ALREADY_EXISTS` message 措辞优化候选(当前"活跃根节点" vs 实现 `deletedAt=null` 不区分 status)
  - **不启动 V2.x**(member_profiles / attachments / audit_logs / events / event_participants 全部保留延后);**不启动 housekeeping**;V2.x 启动需用户单独拍板(对应 §6.11)

### 6.9 通用验收 checklist

每个 Step 完成前 / commit 前,**逐项过一遍**(对齐 baseline §13):

#### A 档(必跑)

- [ ] `pnpm lint`(0 warnings / 0 errors,`--max-warnings 0`)
- [ ] `pnpm typecheck`(tsc src + tsc test 双段无错)
- [ ] `pnpm test`(unit)
- [ ] `pnpm test:e2e`(v1 既有 162 tests + V2 新增 e2e;**v1 零退化是硬约束**)
- [ ] `pnpm test:contract`(若涉及 OpenAPI schema 变更,显式 `-u` 更新快照)

#### B 档(涉及全局行为 / v1 兼容性 / schema / API 时追加)

- [ ] `pnpm start:dev` 服务启动无错(关注 redact 解析 / migration apply / 路由注册等)
- [ ] `curl /api/health/live` → 200
- [ ] `curl /api/health/ready` → 200(DB 连通)
- [ ] `curl /api/docs` Swagger UI 完整含 v1 + V2 接口
- [ ] `curl /api/docs-json` OpenAPI JSON
- [ ] **抽查 v1 auth / users 关键接口**(`POST /api/auth/login` / `GET /api/users/me` / `GET /api/users/:id` 等典型路径)— 全部 200 + 响应契约不变
- [ ] **确认 OpenAPI v1 schema 不漂移**(snapshot diff 仅含新增 V2 / 不含 v1 字段变化;**`LoginDto` schema 严格零漂移**)
- [ ] (Step 5 必跑)v1 `POST /api/auth/login` 账号枚举相关失败场景防护(输入值在 username / memberNo 两条路径下均未命中 / memberNo 命中但未绑 user / 账号禁用或软删 / 密码错)— 响应体 / HTTP status / 耗时一致
- [ ] V2 新接口典型成功路径 + 典型错误路径(权限拒绝 / 资源不存在 / 业务校验失败 等)
- [ ] (Step 5 必跑)V2 members 接口 memberNo 校验:必填 / trim / 长度 / 字符集 / 全局唯一(撞软删历史抛 `MEMBER_NO_ALREADY_EXISTS`)/ PATCH 拒绝改 memberNo
- [ ] SIGTERM 优雅关闭

任一未通过 → **不算完成,不能 commit,不能向用户报告"任务完成"**(沿用 V1.1 §17.10 末尾纪律 + V2 §13)。

### 6.10 范围外的统一处理

V2 第一阶段开发期间遇到任何"看起来该顺手做"的事项,**全部**走以下流程:

1. **暂停**,不要先实现
2. 在与用户的对话里声明:这件事属于以下哪一类范围外:
   - `member_profiles` 任何字段 / 接口 / schema(合规未补)
   - `attachments` 任何元数据 / 上传 Provider / 业务挂载
   - `audit_logs` 任何接入 / 表创建(V2.x 第一个增量做)
   - `events` / `event_participants` 任何接口 / schema
   - **RBAC** / permission 表 / casl 任何权限框架
   - **上传 Provider** 实装(本地 / OSS / R2 任一)
   - **真实字典 seed**(部门类别 / 等级 / 活动类型 / 证书类型 任一具体取值)
   - **批量导入导出**(任何模块)
   - **通知系统**(短信 / 邮件 / 微信 / 企业微信 任一)
   - **统计报表 / BI / 数据大屏**
   - **任何敏感字段**(身份证 / 紧急联系人 / 医疗 / 出生 / 住址 / 性别 / 第三方账号 / 凭证 等)
   - **修改 v1 14 接口契约**(任何路径 / DTO / 错误码变化)
   - **修改 docker-compose.yml** / **修改 .github/workflows/**
   - **引入未登记新依赖**
3. 由用户决定:
   - **a. 写入 §6 已有 Step 内**(若属于已立项范围)
   - **b. 写入 §6.11 V2.x 复活触发条件**(若属于延后)
   - **c. 写入 V2.x 后续阶段独立任务卡**(若属于新需求)
   - **d. 直接放弃**(若不需要)

**禁止**未经用户确认就动作。这是 V2 第一阶段开发最容易破口的地方,纪律与 V1.1 §4 / V2 §5.4 一致。

**v1 兼容性红线下唯一已开口子**(自 memberNo 决议 2026-05-08):

- ⚠️ `src/modules/auth/auth.service.ts` 受限放开 — **唯一**允许的扩展是 memberNo 登录回退查找(详见 ARCHITECTURE.md §12.8.2.4 + `docs/v2-api-contract.md §6.6` + 本节 §6.6 Step 5)
- ❌ 任何**其他** v1 auth 文件改动(`auth.controller.ts` / `auth.dto.ts` / `strategies/*`)仍属范围外
- ❌ 任何想"再开第二个口子"的诉求(例如"顺手在 auth.service.ts 加 SSO 登录")必须按本节流程暂停 + 用户拍板,不得援引此唯一已开口子作为先例

### 6.11 V2.x 复活触发条件

V2 第一阶段开发完成 → **不自动**进入 V2.x;V2.x 启动需用户单独拍板。

D7-min 决议时刻锁定 5 个延后模型,V2.x 复活触发条件如下(指向 [`docs/V2红线与复活路径.md §4.3`](docs/V2红线与复活路径.md) 完整版,本节简写):

> **当前状态**(v0.7.0 后):`audit_logs` 已局部启动;**仍延后 4 个**:`member_profiles` / `attachments` / `events` / `event_participants`。

| 模型 | V2.x 复活触发(简写) |
|---|---|
| `member_profiles` | **合规材料补齐**(详见 [`docs/V2红线与复活路径.md §4.3`](docs/V2红线与复活路径.md)) |
| `attachments` | profiles 或 events 解锁 / 用户单独拍板附件需求 |
| `audit_logs` | ✅ **v0.7.0 第一波已实施**;剩余 22 处迁移属可复活项,见 [`docs/V2红线与复活路径.md`](../docs/V2红线与复活路径.md) §4.1 C-1 |
| `events` | 用户拍板需求(救援队需要在系统中记录哪些类型的活动 / 事件成为强诉求) |
| `event_participants` | **跟随 events** 复活路径 |

完整复活流程见 [`docs/V2红线与复活路径.md §4.3`](docs/V2红线与复活路径.md)(active 滚动维护);D7-min 决议时刻历史快照见 [`docs/archive/plans/v2-design-phase/tasks.md`](docs/archive/plans/v2-design-phase/tasks.md) §5.5.4.3。

---

## 7. V2.x C-6 RBAC(批次 8)

> **状态(2026-05-14 PR #9 docs 收口)**:🎯 **设计 + schema + CRUD + service + seed/bootstrap 全部完成**(PR #54-#61 实施 PR #1-#8 + 本 docs 收口 PR #9);docs 收口进行中;**bump version + v0.9.0 handoff 待用户授权启动**。
> **入口文档**:[`docs/批次8_RBAC_V2x立项记录.md`](docs/批次8_RBAC_V2x立项记录.md)
> **D7 v1.1 冻结**:PR #51 v1.0 → PR #53 v1.1 命名修订(squash commit `569771b`)
> **业务模块判权接入仍待后续批次**(0 处 `rbac.can()` 业务调用;14 RBAC CRUD 入口仍 `@Roles(SUPER_ADMIN, ADMIN)`)。

### 7.1 时间线(设计 + 立项 + 实施 + 收口)

| 阶段 | PR | squash commit | 状态 |
|---|---|---|---|
| 业务访谈提纲 | #46 | `1b33c4e` | ✅ |
| D6 业务确认稿 | #47 | `44e1326` | ✅ |
| D7 v0.1 草稿 | #48 | `b892a7e` | ✅ |
| D7 v0.2 局部收口 | #50 | `6d54ec3` | ✅ |
| D7 v1.0 冻结 | #51 | `b301da8` | ✅ |
| V2.x 立项 PR | #52 | `172b684` | ✅ |
| D7 v1.1 命名修订 | #53 | `569771b` | ✅ |
| 实施 PR #1 schema + migration | #54 | `88cb4d1` | ✅ |
| 实施 PR #2 Permission CRUD | #55 | `6ff55b6` | ✅ |
| 实施 PR #3 RbacRole CRUD | #56 | `edcb91e` | ✅ |
| 实施 PR #4 RolePermission + cache skeleton | #57 | `0d50c99` | ✅ |
| 实施 PR #5 UserRole CRUD + Q7 + ops-admin 保护 | #58 | `affc1e8` | ✅ |
| 实施 PR #6 RbacService + me/permissions + memberId | #59 | `46664c7` | ✅ |
| 实施 PR #7 reload endpoint | #60 | `6de6f64` | ✅ |
| 实施 PR #8 seed/bootstrap | #61 | `43db185` | ✅ |
| **PR #9 docs 收口** | 本 PR | — | 🔄 **本 PR** |
| PR #10 bump version 0.8.0 → 0.9.0 | 待启动 | — | ⏳ 等用户授权 |
| PR #11 v0.9.0 handoff | 待启动 | — | ⏳ 等用户授权 |

### 7.2 决议锁定

25 项决议全部 🔒 v1.0 冻结 + v1.1 命名修订(B 3 + D 12 + F 10)。详见 [`docs/批次8_RBAC_API前评审.md §18`](docs/批次8_RBAC_API前评审.md) D7 v1.1 决议表。

### 7.3 实施前置硬约束(沿 §7 立项记录 §三)

- ✅ 不引入 `casl` / Redis / 队列 / 定时任务(已落地;`RbacCacheService` 用 Map + setTimeout 等价进程内 TTL)
- ✅ 不扩 `Role` enum(沿 A-4 红线;`SUPER_ADMIN / ADMIN / USER` 三层永远不变)
- ✅ 不改 v1 14 + 既有 V2 79 接口(沿 A-2 红线 zero drift;contract snapshot 守护)
- ✅ 不动 `users.policy.ts`(沿 D12 永久共存)
- ⏸️ C-7 attachments 仍等 PR #10 / #11 收口完成后才进入 D7-attachments 评审(沿 PR #45 决议 1)

### 7.4 实施 PR 落地(沿 §7 立项记录 §四)

参见 §7.1 时间线表 PR #54-#61 + 本 PR #9。

**累计基础能力**(2026-05-14 实测):
- 4 张 RBAC 表 + 1 个 migration(`add_rbac`)
- 16 个 RBAC 端点(全部 `@ApiBearerAuth()` + Swagger 注册;**contract snapshot 增量 16 路由 + 22 DTO**)
- 14 个 BizCode(`300xx` × 9 + `301xx` × 3 段位实装 + `RBAC_FORBIDDEN=30100` 段位预留 + 30011 `ROLE_PERMISSION_NOT_FOUND`)
- 1 个 `RbacService`(`getUserPermissionCodes` / `can` / `judge` / `checkOwnership` / `getMyPermissions` / `reload`)
- 1 个 `RbacCacheService`(Map + TTL + 3 个 invalidate 入口;`RBAC_CACHE_TTL_SECONDS` env 可调)
- 1 个 seed 拓展(14 条 rbac.* + ops-admin RbacRole + 14 条 RolePermission + bootstrap with env / SUPER_ADMIN fallback + 强校验)
- `CurrentUserPayload.memberId` 扩展(沿 D7 §8.3 owner 判定;v1 14 接口 response zero drift)
- 7 个 e2e spec(`permissions` / `rbac-roles` / `role-permissions` / `user-roles` / `rbac-me-permissions` / `rbac-reload` / `seed-rbac`)+ 1 个 unit spec(`rbac.service.spec.ts`)

### 7.5 本 PR #9 docs 收口边界

仅 docs(4 处):

- ✅ 更新 [`docs/批次8_RBAC_V2x立项记录.md`](docs/批次8_RBAC_V2x立项记录.md):状态头部 + §四 PR 拆分表标记 PR #1-#8 已合入 + §六 合并后下一步重写
- ✅ 更新 [`CHANGELOG.md`](CHANGELOG.md) Unreleased `### Added`:记录 PR #1-#8 累计 + 明确未做项
- ✅ 更新 [`docs/V2红线与复活路径.md`](docs/V2红线与复活路径.md):C-6 行 + Slow-1 行状态修订
- ✅ 更新本 `TASKS.md §7`(本节)

不动:

- ❌ `src/**` / `prisma/**` / `test/**` / `package.json` / `pnpm-lock.yaml`
- ❌ 不新增 migration / 不改 seed.ts
- ❌ 不 bump version / 不 tag / 不 release
- ❌ 不启动 C-7 attachments / 不接业务模块判权 / 不实装 dept-chief / 不 seed `attachment.*` / 不 seed `role-a..role-f` / 不创建 ADMIN 内置角色

### 7.6 合并后下一步

本 PR #9 合并后,**下一步是 PR #10 bump version 0.8.0 → 0.9.0**(SemVer minor;新模块 + 新表 + 16 接口),需用户明确授权。

PR #10 合入后,启动 PR #11 v0.9.0 handoff(13 章节范式;包括下一会话提示词)。

PR #11 release tag v0.9.0 后,**才**启动 C-7 attachments D7 评审稿(沿 PR #45 决议 1)。

**禁止**:未经用户授权,**不**启动 PR #10 / PR #11 / C-7 attachments / 业务模块判权接入。

---

## 8. V2.x C-7 attachments(批次 7)

> **状态(2026-05-15 实施收口)**:✅ **C-7 attachments 实施已完成**;9 个实施 PR 全部 squash merge(#70-#78);主模块 7 端点 + 配置三表 15 端点 + RBAC + audit 全部就位。
> **入口文档**:[`docs/批次7_attachments_V2x立项记录.md`](docs/批次7_attachments_V2x立项记录.md)
> **D7 v1.0 冻结**:PR #68 `5da801f`(27 项锁定 + 1 挂起 + 2 挂起待 Provider + 1 不冻结 + 2 v1.1)
> **文档先决条件**:D7-RBAC v1.2 已合(PR #66 `2b934c5`;Permission code 正则文档 3-4 段)
> **当前不做**:版本号 bump / git tag / GitHub Release / 新版本 handoff(留独立 PR 由维护者拍板)

### 8.1 设计 + 立项 + 实施时间线

| 阶段 | PR | squash commit | 状态 |
|---|---|---|---|
| 业务访谈提纲 | #44 | `08aa4d7` | ✅ |
| D6 业务确认稿 | #45 | `0642d36` | ✅ |
| D7 v0.1 草稿 | #65 | `ebb530e` | ✅ |
| D7-RBAC v1.2 修订(Permission code 正则 3-4 段) | #66 | `2b934c5` | ✅(文档先决条件) |
| D7 v0.2 局部收口 | #67 | `e4ff48f` | ✅ |
| D7 v1.0 冻结 | #68 | `5da801f` | ✅ |
| V2.x 立项 PR | #69 | `e620a2c` | ✅ |
| **collateral 适配**:`feat(permissions): support 4-segment permission codes` | #70 | `4d9332e` | ✅(2026-05-15) |
| **实施 #1**:`chore(prisma): add attachments schema and config tables`(4 model + migration + Certificate.attachmentKey drop column) | #71 | `ce37ffe` | ✅(2026-05-15) |
| **实施 #2**:`feat(attachments): add attachment type config module`(6 端点) | #72 | `663506d` | ✅(2026-05-15) |
| **实施 #3**:`feat(attachments): add attachment mime config module`(6 端点) | #73 | `579429b` | ✅(2026-05-15) |
| **实施 #4**:`feat(attachments): add attachment size limit config module`(5 端点) | #74 | `81c9bff` | ✅(2026-05-15) |
| **实施 #5a**:`feat(permissions): seed attachment permissions and member role` | #75 | `ff34616` | ✅(2026-05-15) |
| **实施 #5b**:`feat(attachments): add attachments main module with RBAC integration`(7 端点;首次业务 `rbac.can()`)| #76 | `308d6d9` | ✅(2026-05-15) |
| **实施 #6**:`feat(attachments): integrate audit logs`(主模块 audit;2 events) | #77 | `abd9b32` | ✅(2026-05-15) |
| **实施 #6+**:`feat(attachments): integrate attachment config audit logs`(配置三表 audit;1 event;11 端点) | #78 | `8ee24e2` | ✅(2026-05-15) |
| **Landing PR**:`docs(v2): record C-7 attachments implementation landing` | 本 PR | — | 🔄 **本 PR** |
| 版本号 bump(SemVer 由维护者拍板) | TBD | — | ⏳ 留独立后续 PR |
| 新版本 handoff(类比 v0.8.0 / v0.8.1 / v0.9.0)| TBD | — | ⏳ 留独立后续 PR |

### 8.2 决议锁定 + 实施状态

**27 项 v1.0 冻结决议**(F 5 + B 9 + Q 13)实施情况:**全部已落地**(F1-F5 / B1-B9 / Q1-Q11 / Q13 全部在 #70-#78 中实装)。

**仍挂起项**:

- 🔄 **Q12 ADMIN 内置角色 / ADMIN 自动持 .other 全集**:沿用挂起;实施期默认按方案 B(沿 v0.9.0 现状;ADMIN 默认无 RBAC 业务角色;需 ops-admin 显式分配);留独立"RBAC 内置角色 / ADMIN 默认附件权限"专项评审 PR
- ✅ **Q14 / Q15 Provider 选型**:已由 C-7.5 PR #82-#93 实装;签名 URL / STS / 中转代理 / 删除策略 / 生命周期全部决议落地;`accessUrl` 已真实化(沿 PR #90;Provider 不可用降级 null + WARN);详见 §9
- 📋 **Q16 PR 拆分**:实施期实际为 9 PR(原建议 9-11)
- ⏳ **B8 同意书正式条款文本**:v1.1 由业务方提供;**不写入本系统仓库**(保存在队组织自有合规文档系统;系统侧仅链接 URL)
- ⏳ **Q8 退队清理 N 具体值**:v1.1 由业务方提供;`Member.status=DISABLED ≥ N` + 后台提示语义已锁,N 不在 schema 硬编码

详见 [`docs/批次7_attachments_API前评审.md §16`](docs/批次7_attachments_API前评审.md) D7 v1.0 决议表 + [`docs/批次7_attachments_V2x立项记录.md §一`](docs/批次7_attachments_V2x立项记录.md)。

### 8.3 实施成果摘要

| 维度 | 数量 |
|---|---|
| Prisma 表 | +4(`attachments` / `attachment_type_configs` / `attachment_mime_configs` / `attachment_size_limit_configs`) |
| API 端点 | +22(主 7 + type 6 + mime 6 + size 5) |
| BizCode(130xx) | +13(13001 / 13010-13013 / 13015 / 13020-13027) |
| Permission seed | +20 条 `attachment.*` |
| RbacRole 内置角色 | +1(`member` + 9 条 RolePermission) |
| AuditLogEvent | +3(`attachment.upload` / `attachment.delete` / `attachment.config.change`) |
| 实施 PR | 9 个(#70-#78) |
| e2e 增量 | +91 用例(主 51 + 主 audit 19 + 配置 audit 21) |

### 8.4 关键里程碑

- **首次业务模块接入 `rbac.can()`**(沿 D7 F3 + F5):attachments 主模块 7 个端点入口仅 `JwtAuthGuard`,Service 层显式调 `rbac.can()`;PermissionsModule `exports: [RbacService]` 首次外露
- **首批主模块 + 配置模块都接入 audit_logs**(沿 D7 F6 + D6 同事务 fail-fast):路线 A 单事件 + extra 区分;校验链留事务外;写入 + audit 同 `$transaction` 提交,失败一起回滚
- **首次接入 RBAC 4 段 code**(`attachment.<action>.<resourceType>.<scope>`):collateral PR #70 把 `CODE_PATTERN` 从 3 段放宽到 3-4 段
- **v1 14 + V2 79 + RBAC 16 接口 zero drift**:Contract snapshot CI 守护

### 8.5 当前不做项(landing 后边界)

- ❌ 版本号 bump(`package.json#version` 仍 `0.9.0` / Swagger 仍 `0.9.0`;SemVer 由维护者评估:`0.9.0 → 0.9.1` patch 或 `0.9.0 → 0.10.0` minor)
- ❌ 打 git tag / 发 GitHub Release
- ❌ 新版本 handoff
- ✅ Provider 实装已完成(C-7.5 PR #86-#93;LocalProvider + CosProvider + 动态 Router + AES-256-GCM 凭证加密 + signed URL 直传 + 后台 Storage Settings 管理;详见 §9 + [`docs/handoff/v0.11.0.md §4`](docs/handoff/v0.11.0.md))
- ❌ ADMIN 内置角色实装(沿 Q12 沿用挂起)
- ❌ B8 / Q8 v1.1 由业务方提供后再触发独立 PR
- ❌ 跨表引用约束(13030 `ATTACHMENT_TYPE_IN_USE` 等;Q2 / Q6 / Q7 v1.0:本 C-7 不查跨表)
- ❌ 业务模块全面接入 `rbac.can()`(超 C-7 范围;留独立"V2 全面 RBAC 接入"评审 PR)

### 8.6 合并后下一步

本 landing PR 合并后,**下一步由维护者拍板**:

1. **SemVer 决策 PR**:`0.9.0 → 0.9.1`(patch)还是 `0.9.0 → 0.10.0`(minor)由维护者评估;`chore: bump version` 独立 PR
2. **新版本 handoff PR**:bump 完成后,类比 v0.8.0 / v0.8.1 / v0.9.0 范式撰写 handoff
3. **git tag + GitHub Release**:维护者手动操作(沿 v0.9.0 终态:tag 由维护者按需打)

**并行可启动**(独立 PR;均需用户明确授权):

- Provider 选型独立评审稿(决议 Q14 / Q15;沿 D6 决议 5)
- "RBAC 内置角色 / ADMIN 默认附件权限"专项评审 PR(决议 Q12)
- D7-attachments v1.1 修订 PR(等业务方提供 B8 同意书正式文本 + Q8 N 具体值)
- 跨表引用约束评审 PR(13030 `ATTACHMENT_TYPE_IN_USE` 等)

**禁止**:未经用户授权,**不**启动 bump / handoff / Provider 选型评审稿 / ADMIN 内置角色专项评审 PR / v1.1 修订 PR / 跨表引用约束评审 PR。

---

## 9. V2.x C-7.5 Provider 选型(批次 7.5)

> **状态(2026-05-16 实施收口)**:✅ **C-7.5 Provider 实施已完成**;8 个实施 PR 全部 squash merge(#86-#93,含 P1 技术债 PR #92);腾讯云 COS Provider + LocalProvider + 动态路由 + AES-256-GCM 凭证加密 + signed URL 直传 + 后台凭证管理全部就位。**待 v0.11.0 bump + handoff + tag/release**(留独立 PR 由维护者拍板)。
> **入口文档**:[`docs/批次7_provider选型_V2x立项记录.md`](docs/批次7_provider选型_V2x立项记录.md)
> **C-7.5 v1.0 冻结**:PR #84 `f8b357d`(35 项决议:F 5 + B 5 + Q 25;Q5 / Q6 / Q7 接口与 DTO 锁 + Q8 TTL 升级锁)
> **承接挂起项已落地**:D7-attachments Q14 / Q15(Provider 上传策略 + 删除策略)由 PR #90 / #91 实装
> **当前不做**:版本号 bump / git tag / GitHub Release / 新版本 handoff(均留独立 PR 由维护者拍板);生产侧 COS bucket / IAM / CORS / lifecycle / versioning / 凭证录入(由队组织运维侧承载)

### 9.1 设计 + 立项 + 实施时间线

| 阶段 | PR | squash commit | 状态 |
|---|---|---|---|
| C-7.5 v0.1 草稿(5 项 F + 5 项 B 锁 + 15 项 Q 待评审) | #82 | `6dbdbed` | ✅ |
| C-7.5 v0.2 局部收口 + 架构修订(锁腾讯 COS Q1/Q4 + 14 项 Q;新增 Q20-Q25;13 PR → 14 PR) | #83 | `8d19a07` | ✅ |
| C-7.5 v1.0 冻结(Q5 / Q6 / Q7 接口与 DTO 锁 + Q8 TTL 升级锁;35 项决议全部就位) | #84 | `f8b357d` | ✅ |
| V2.x 立项 PR | #85 | `5e12511` | ✅(2026-05-16)|
| **实施 PR #5**:`chore(storage): extend StorageProvider interface for C-7.5 v1.0`(+3 方法 + 5 类型;0 实装) | #86 | `fc8241d` | ✅(2026-05-15)|
| **实施 PR #6**:`chore(prisma): add storage_settings schema and config reader for C-7.5 v1.0`(15 字段 + 2 enum + 1 migration + 28 unit) | #87 | `45ae871` | ✅(2026-05-15)|
| **实施 PR #7**:`feat(storage): add LocalStorageProvider for C-7.5 v1.0`(5 方法 + 16 unit + storage.module.ts 装载) | #88 | `bceba0f` | ✅(2026-05-15)|
| **实施 PR #8**:`feat(storage): add CosStorageProvider with dynamic router for C-7.5 v1.0`(5 方法 + Router 动态路由 + 32 unit + 1 新依赖)| #89 | `f44310c` | ✅(2026-05-15)|
| **实施 PR #9**:`feat(attachments): wire storage provider into attachment accessUrl and delete flow`(7 调用点 + delete 事务外 + contract description 微调)| #90 | `119778c` | ✅(2026-05-15)|
| **实施 PR #10**:`feat(attachments): add upload-url and confirm-upload APIs`(2 端点 + 3 DTO + uploadToken HMAC-SHA256 + 28 e2e + 18 upload-token unit) | #91 | `527aa47` | ✅(2026-05-15)|
| **P1 技术债**:`chore(prisma): add unique constraint for attachment key`(承接 PR #91 已知偏差;1 migration;并发 replay 防御)| #92 | `fc08d17` | ✅(2026-05-15)|
| **实施 PR #11**:`feat(storage): add Storage Settings admin APIs and credential reset`(3 端点 + 3 DTO + 30 e2e;0 BizCode / 0 audit;Q-11-1 到 Q-11-19 全落地)| #93 | `85cae45` | ✅(2026-05-16)|
| **Landing PR**:`docs(v2): record C-7.5 provider implementation landing` | 本 PR | — | 🔄 **本 PR** |
| Bump PR(`chore: bump version to v0.11.0`)| TBD | — | ⏳ 留独立后续 PR |
| Handoff PR(`docs(v2): add v0.11.0 handoff`)| TBD | — | ⏳ 留独立后续 PR |
| tag/release(维护者手动) | — | — | ⏳ 沿 v0.10.0 终态范式 |

### 9.2 决议锁定汇总

**35 项 v1.0 冻结决议**(F 5 + B 5 + Q 25):

- **F1-F5**:F1 不回改 D7-attachments / F2 生产 B 模式 + dev D 模式 / F3 国内合规优先 / F4 删除策略同步 + 告警 + 兜底 / F5 `StorageProvider` 6 方法
- **B1-B5**:B1 不新增 schema / B2 新 2 端点不动既有 / B3 不新增 RBAC 权限点 / B4 不新增 audit event / B5 14 PR 节奏建议
- **Q1-Q25**:沿 v0.2 锁 22 项 + v1.0 新锁 3 项(Q5 / Q6 / Q7)+ v0.2 → v1.0 升级 Q8 TTL

详见 [`docs/批次7_provider选型_API前评审.md §19`](docs/批次7_provider选型_API前评审.md) C-7.5 v1.0 决议表 + [`docs/批次7_provider选型_V2x立项记录.md §一`](docs/批次7_provider选型_V2x立项记录.md)。

### 9.3 实施前置硬约束(沿 §9 立项记录 §三)

- ❌ 不引入 STS 临时凭证(Q19)/ 不实施 multipart upload(Q13)/ 不开放公有桶 / 不引入异步删除队列(F4)/ 不引入 Redis / 不长期依赖 env(Q23)/ 不回显凭证(Q22)
- ❌ 不改 v1 14 + V2 117(v0.10.0 终态)+ RBAC 16 既有接口(沿 A-2)
- ❌ 不改 attachments 主模块 7 端点 + 配置三表 15 端点 paths / 入参 / 出参 schema(沿 B2);**仅**`toResponseDto.accessUrl` 字段值变化(由 null → 真实 URL),字段类型保持 `string | null`,**不算 schema drift**
- ⏳ 实施 PR #5 启动前展示 `storage.interface.ts` + `storage.types.ts` 扩展 diff(沿 Q5)
- ⏳ 实施 PR #6 启动前展示 `prisma/schema.prisma` + migration SQL diff + 启动校验代码 diff(沿 Q24 + v1 §14)
- ⏳ 用户明确"破坏性变更已经过评审"后才执行 `prisma migrate dev`(沿 CLAUDE.md §0)

### 9.4 实施 PR 拆分(沿 §9 立项记录 §四)

实施段共 7 PR(沿 §16.1 14 PR 节奏的实施段 PR 5-11):

- **PR #5**:extend StorageProvider interface(+ 3 method + types;0 实装)
- **PR #6**:add `storage_settings` schema + DTO + 配置读取层(15 字段 + AES-256-GCM 加密;不接 COS SDK)
- **PR #7**:LocalStorageProvider 实装(dev / test)
- **PR #8**:COS Provider 实装(引入 `cos-nodejs-sdk-v5`;读 `storage_settings` 不依赖 env;可与 PR #7 并行)
- **PR #9**:wire attachments.service(`accessUrl` 真实化 + delete 同步 Provider 删)
- **PR #10**:add upload-url + confirm-upload API(模式 B)
- **PR #11**:后台 Storage Settings CRUD + credential reset(可与 PR #8-10 并行)

收口段:landing PR #12 + bump PR #13 + handoff PR #14 + tag/release(维护者)。

### 9.5 实际产出统计(实施完成后)

| 维度 | 数量 |
|---|---|
| Prisma 表(新增) | **+1**(`storage_settings` 15 字段;沿 Q24 一次设计完整) |
| Prisma enum(新增)| **+2**(`StorageProviderType` LOCAL/COS / `StorageMimePolicyMode` INHERIT/OVERRIDE) |
| Prisma migrations(新增)| **+2**(`v2_c75_storage_settings` + `attachment_key_unique`)|
| Prisma unique 约束(新增)| **+1**(`attachments.key @unique`;P1 技术债 PR #92)|
| API 端点(新增) | **+5**(主模块 +2:`POST /attachments/upload-url` + `POST /attachments/confirm-upload`;后台 +3:`GET /storage-settings` + `PATCH /storage-settings` + `POST /storage-settings/reset-credentials`)|
| `StorageProvider` 方法(新增)| **+3**(`generateUploadUrl` / `generateDownloadUrl` / `headObject`;沿 F5 6 方法)|
| Provider 实现(新增)| **+2**(`LocalStorageProvider` + `CosStorageProvider`)|
| Provider 路由(新增)| **+1**(`StorageProviderRouter` 动态;沿 Q-89-1)|
| Service / Util 文件(新增)| **+4**(StorageSettingsService + StorageCryptoService + upload-token util + StorageProviderRouter)|
| BizCode | **0 新增**(沿 B3 / Q-10-11 / Q-11-4;复用 13001/13010-13013/13015/30100/40100/INTERNAL_ERROR)|
| RBAC Permission seed | **0 新增**(沿 B3;upload-url / confirm-upload 复用 `attachment.upload.<type>.<scope>`;后台 CRUD 走 `@Roles(SUPER_ADMIN, ADMIN)`)|
| AuditLogEvent union | **0 新增**(沿 B4 + §6.6.5;`attachment.upload` extra 加 `uploadConfirmedAt + uploadVia: 'direct'`;storage_settings 0 audit)|
| 实施 PR | **8 个**(#86-#93;含 P1 技术债 PR #92)|
| 运行时依赖(新增)| **+1**(`cos-nodejs-sdk-v5@^2.15.4`;加密辅助沿 Node 原生 crypto,0 新依赖) |
| env 变量(新增)| **+2**(`STORAGE_ENCRYPTION_KEY` 必填 prod / `STORAGE_LOCAL_ROOT` LocalProvider 根目录) |
| Unit 增量 | **+88**(原 764 → 852;含 storage 22 + LocalProvider 16 + cos+router 32 + upload-token 18) |
| E2E 增量 | **+58**(原 1163 → 1221;含 28 upload + 30 storage-settings) |
| Contract 增量 | **+11**(原 240 → 251;5 paths + 6 DTO schemas + accessUrl description 1 行文案微调) |

### 9.6 仍未做项(实施完成后边界)

#### 留 v1.1+ / 实施期评审

- ❌ uploadToken 重放防御 / 黑名单(沿 §8.4.4;依赖 `attachment.key UNIQUE` + P2002,已由 PR #92 强化)
- ❌ 失败回滚 Provider 文件(沿 §8.4.4;依赖 Provider lifecycle 30 天兜底)
- ❌ multipart upload 支持(沿 Q13;单文件 ≤ 5GB 走 PUT signed URL)
- ❌ STS 临时凭证(沿 Q19;模式 C 不采用)
- ❌ 跨 Provider 迁移路径(沿 Q15;COS 暂不迁移)
- ❌ bootstrap fallback(env 兜底自动创建 row;沿 Q-11-3;留 v1.1+ 专项 PR)
- ❌ test-connection API(沿 Q-11-6;留 COS 真实凭证联调专项 PR)
- ❌ Storage Settings 配置变更 audit_logs(沿 §6.6.5;留独立专项 PR)

#### 运维侧落地(系统侧不承载;由队组织运维侧执行)

- ⏳ 真实腾讯云 COS bucket 创建(`srvf-attachments-<APPID>`)
- ⏳ 真实 IAM 子账号 + Secret 生成
- ⏳ bucket CORS 规则配置(沿 §6.4.6;生产域名白名单 + PUT/GET/HEAD + MaxAge=3600)
- ⏳ bucket lifecycle 规则(沿 §6.4.5;旧版本 30 天 expire + DeleteMarker 即清除 + 7 天 abort multipart)
- ⏳ bucket versioning 启用(沿 §6.4.5)
- ⏳ bucket SSE-COS 加密配置(沿 §6.4.4)
- ⏳ 真实生产凭证录入(通过 `POST /storage-settings/reset-credentials`)
- ⏳ 生产环境 `STORAGE_ENCRYPTION_KEY` 注入(`openssl rand -base64 32`;由部署平台)

### 9.7 合并后下一步

本 landing PR 合并后,**下一步由维护者拍板**:

1. **bump PR**:`chore: bump version to v0.11.0`(SemVer minor 0.10.0 → 0.11.0;+1 表 / +5 API / +2 enum / +1 unique / +2 migrations / +1 runtime 依赖;沿 v0.10.0 PR #80 范式;变更 3 文件:`package.json` + `src/bootstrap/apply-swagger.ts` + 本 CHANGELOG `Unreleased` 段折叠为 `## v0.11.0 - YYYY-MM-DD`)
2. **handoff PR**:`docs(v2): add v0.11.0 handoff`(类比 v0.10.0 / v0.9.0 范式;13 章节;含 PR #82-#93 时间线 + C-7.5 当前能力摘要 + 下次会话启动必读)
3. **git tag + GitHub Release**:维护者手动操作(沿 v0.10.0 终态范式:tag → handoff commit)
4. **生产侧 COS 运维配置**:由队组织运维侧执行(沿 §9.6 运维侧清单)

**并行可启动**(独立 PR;均需用户明确授权):

- "RBAC 内置角色 / ADMIN 默认附件权限"专项评审 PR(决议 D7-attachments Q12;沿 §8.6)
- D7-attachments v1.1 修订 PR(等业务方提供 B8 同意书正式文本 + Q8 N 具体值;沿 §8.6)
- 跨表引用约束评审 PR(13030 `ATTACHMENT_TYPE_IN_USE` 等;沿 §8.6)
- 业务模块全面接入 `rbac.can()` 评审 PR(超 C-7.5 范围)
- bootstrap fallback 专项 PR(沿 Q-11-3;留 v1.1+)
- test-connection API 专项 PR(沿 Q-11-6;COS 真实联调时启动)
- multipart upload 专项 PR(沿 Q13;大文件需求触发时启动)

**禁止**:未经用户授权,**不**启动 bump / handoff / 任何并行评审 PR。

---

## 10. V2.x 后续任务(待启动)

> 当前阶段(v0.15.0 后)已进入"god-service 拆分前补 characterization tests"+"Mixed Controller 物理拆分(P1-C)" 等治理性任务节奏。
> **任何新增任务必须**按 [`docs/process.md §3`](docs/process.md) PR 五档分级走立项流程;**不在本节直接动手**。
>
> 本节作为后续 V2.x / 治理任务的入口占位,具体任务由用户拍板后单独立项。

### 10.1 当前已知方向(沿 [`docs/current-state.md §3`](docs/current-state.md) "当前明确未做 / 暂不启动" + §4 "当前最大风险 / 债务")

- ⏸️ **Slow-3 / Slow-4**:ADMIN 内置角色 + ADMIN 默认附件权限边界 → 14 RBAC CRUD + 79 V2 接口全面 `rbac.can()` 接入(等业务方对"业务管理员边界"补充澄清)
- ⏸️ **Slow-5**:B8 入队同意书正文 / Q8 退队清理 N 值(等业务方提供)
- ⏸️ **Slow-7**:uploadToken 重放黑名单 / 失败回滚 Provider 文件 / test-connection / multipart / STS / 跨 Provider 迁移(等真实使用反馈)
- ⏸️ **L-3**:Storage Settings 配置变更 audit_logs(等用户授权)
- ⏸️ **P0-H**:部署演练(等运维侧)
- ⏸️ **P0-I**:排错 SOP(等运维侧)
- ⏸️ **Phase 1B path alias**(`/api/auth/v1/*` + `/api/public/v1/*`):仍暂缓(等业务方 / 运维侧拍板)
- ⏸️ **Mixed Controller 物理拆分(P1-C)**:第一优先 `users.controller.ts`(沿 [`docs/api-surface-policy.md §7`](docs/api-surface-policy.md));拆分前必须先补 characterization tests(P1-B)
- ⏸️ **god-service 拆分**:[`attendances.service.ts`](src/modules/attendances/attendances.service.ts) (1413 行)/ [`attachments.service.ts`](src/modules/attachments/attachments.service.ts) (885 行)/ [`activity-registrations.service.ts`](src/modules/activity-registrations/activity-registrations.service.ts) (808 行)/ [`activities.service.ts`](src/modules/activities/activities.service.ts) (656 行)— 拆前必须先补 characterization tests
- ⏸️ **service 单测补强**:`src/` 内仅 14 个 `*.spec.ts` / 196 个源文件(≈ 7%)— 建议为 god-service 优先补 spec
- ⏸️ **延后模型复活**(沿 §0.2.1 redirect → [`docs/V2红线与复活路径.md §4.3`](docs/V2红线与复活路径.md)):
  - `member_profiles`(等合规材料)
  - `attachments` 二次扩展(等 profiles / events 解锁 或 独立需求)
  - `events` / `event_participants`(等业务方拍板需求)
- ✅ **docs 治理 PR-2**(已完成):TASKS.md 外部引用刷新(`ARCHITECTURE.md` / `V2红线` / `v2-plan` / `v2-data-model` / `srvf-foundation-research` / `srvf-foundation-data-model-draft` 中指向 `§5.5.4.3` / `§6.4` 等旧引用全部刷新)
- ⏸️ **docs 治理后续 PR**:AGENTS.md 重写 / api-client-boundary.md 归档 / srvf-foundation-* 4 文件归档 等

### 10.2 启动新任务的流程(沿 [`docs/process.md §2-§4`](docs/process.md))

1. **开工前 checklist**:`git status --short` clean / `git branch --show-current` 期望分支 / `gh pr list --state open` 输出空 / 版本三方一致
2. **PR 分级判定**(A / B / C / D / E 档;不混档)
3. **D / E 档降速**:只读调研 → 风险表 → 方案 A/B 对比 → 用户拍板 → 评审稿冻结(必要时)→ 再实施;严禁"顺手做"
4. **收尾报告格式**:沿 process.md §8(修改文件清单 / 本次做了什么 / 本次未做什么 / 验证命令 / 当前 open PR / 建议下一步)

### 10.3 范围外的统一处理

新任务执行中遇到任何"看起来该顺手做"的事项(包括延后模型 / 暂不做项 / 未登记新依赖等),**全部**走以下流程:

1. **暂停**,不要先实现
2. 声明事项属于上节 10.1 哪一类(或属新类)
3. 由用户决定:写入 10.1 待启动表 / 独立立项 / 放弃

**禁止**未经用户确认就动作。这是 V2.x 阶段最容易破口的地方。
