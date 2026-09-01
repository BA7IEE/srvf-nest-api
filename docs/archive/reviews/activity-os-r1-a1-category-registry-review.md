# Activity OS R1 / A1 分类、Facet 与 Legacy Registry 评审记录

> **状态：冻结，不回改**（2026-09-01）。这是 D 档 seed 变更的立项、风险与实施边界记录；合入后，进度只更新滚动台账和 PR，不回写本稿。
>
> **维护者拍板**：维护者于 2026-09-01 对本刀推荐方案回复“按推荐，已授权”。授权只覆盖本文 §3 的写集与 §4 的方案 A；任何 schema、migration、运行时行为或 A2 范围都不随之获得授权。
>
> **上游合同**：[Activity OS T0-A 终态合同](activity-os-t0-terminal-review.md) §4、§10.3、§11；原始蓝图《SRVF 活动域终态蓝图与分阶段落地方案》§6、§19.2、§26.3。T0-B 已通过并合入 [#1236](https://github.com/BA7IEE/srvf-nest-api/pull/1236)。

## 1. 结论

本刀采用现有 `DictType / DictItem` 二级树保存受控目录，并新增纯代码
`LEGACY_ACTIVITY_TYPE_MIGRATION_REGISTRY`。它只定义旧 `activityTypeCode` 的未来解释，
不读取、不改写任何 Activity，也不把 Family、Policy、Outcome 或 Facet assignment 提前做成
持久化对象。

冻结的结果：

- `activity_category`：九个正式一级分类和 `pending_classification`；后者只承接证据不足的旧值，未完成治理前不得进入正式统计。
- `activity_semantic_facet`：`environment`、`action`、`capability`、`cooperation`、`target`、`format` 六个维度；只预置 31 条旧映射真正使用的 19 个 option。`environment` 本期保留维度但不凭示例扩张 option。
- 31 条 legacy 子类型各有且只有一条 registry 记录，逐条固定 category、Family 方向、Facet / Outcome、time / contribution selector、原始上下文和人工治理要求。
- CI 直接从 `prisma/seed.ts` 读出旧子类型并对拍 registry；漏映射、重复映射、多映射或 selector / Facet 漂移都会红。

## 2. D 档依据与现状

| 项          | 现状与证据                                                                    | 本刀结论                                               |
| ----------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| 档位        | `prisma/seed.ts` 是 D 档路径，见 `docs/process.md` §3 / §4                    | 按 D 档降速，不把 seed 当普通文案。                    |
| 旧类型基线  | `seedActivityTypeHierarchy` 维护 9 父 + 31 子；T0-A §1 / §4 冻结了 31/31 义务 | 不删、不改旧 code；registry 以 seed 子项为真源对拍。   |
| 字典能力    | 已有 `DictType` / `DictItem` 父子结构、幂等 upsert 和保护性软删守卫           | 复用，不新增表、外键、API 或 DTO。                     |
| 统计与认定  | T0-A §4 规定人工治理完成前不得自动进入正式统计、时长或贡献                    | registry 只记录选择器和治理文字，零 runtime consumer。 |
| 旧 API 兼容 | T0-A §10.2 固定 `activityTypeCode` 历史只读兼容                               | 不接入创建、发布、详情或 Integration 读面。            |

## 3. 允许写集与禁止域

**允许写集**：

- `prisma/seed.ts`：新增两个 additive 字典及其幂等二级树 seed。
- `src/modules/activities/activity-type-migration.registry.ts`：唯一 static registry。
- `src/modules/activities/activity-type-migration-registry.criteria.spec.ts`：31/31、selector、Facet 和 seed 对拍。
- `src/modules/dictionaries/dictionaries.service.ts`：保护两个受控字典及其 item 不被软删。
- `scripts/check-dictionary-seed-registry.ts` 与字典登记表薄运行器：把新增 hierarchy 纳入现有双向对账闸。
- `docs/ai-harness/DICTIONARY_SEED_REGISTRY.md`、滚动台账、模块事实、变更 fragment 与派生文档。

**明确不做**：

- 不修改 `prisma/schema.prisma`、任何 migration、enum、Permission / Role seed、BizCode、AuditLogEvent。
- 不创建 `ActivitySemanticAssignment`、Family / Version、Template、Outcome、TimePolicy、ContributionPolicy、PlacePreset 或任何历史回填。
- 不改变旧 `activityTypeCode`、现有 Activity service、控制器、DTO、Swagger、Integration、权限、Gate、统计、时长和贡献行为。
- 不跑 `prisma migrate dev`、`db push`、`migrate reset`，不对任何真实库执行 seed。
- 不启动 A2 或之后的 Release 1 切片。

## 4. 方案比较与已批准方案

| 方案                  | 内容                                                                           | 风险 / 回退                                                                           | 结论     |
| --------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | -------- |
| **A（推荐，已批准）** | 复用已有字典树；代码 registry 只保存选择器；由静态 CI 对拍 seed 的 31 个子类型 | 无 schema 或运行时消费者；代码回退即撤回未使用 registry，已 seed 的目录不自动物理删除 | 采用。   |
| B                     | 现在新增 Category / Assignment / Family 等 schema，并直接接入 Activity runtime | 引入 migration、数据治理、旧 API 与统计真相切换，超出 A1                              | 不采用。 |

## 5. 风险表与控制

| 风险                                                  | 控制                                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 31 条旧类型漏一条、重复一条或按标题猜分类             | criteria spec 从 seed 读出实际子类型，严格 31/31 双向比较；registry 不读取 title。                             |
| 把 PlacePreset、Incident link、保障上下文伪装成 Facet | 这类内容逐字留在 `legacyFacetOrOutcome`，不创建未经授权的 Facet option 或新对象。                              |
| 被 seed 覆盖运营修改                                  | 全部沿现有 `upsert + update: {}` 语义；不改 label / sort / status 的运营编辑权。                               |
| 受控分类被软删，历史解释失真                          | 新 type 与 item 均进入现有防误删集合；状态停用仍保持既有能力。                                                 |
| 字典登记表与 seed 漂移                                | 现有 D0–D6 双向闸扩展到新增 hierarchy；登记表自报 30 type / 277 item。                                         |
| `src` 新文件导致授权清单过期                          | 按既有生成链刷新 `ROUTE_AUTHZ.md`；断言模式只投影 `authz-context` 的常量，本刀无权限断言变化，产物应逐字不变。 |
| 回退误删已 seed 数据                                  | 本刀不做物理删除；若运营库已 seed，撤回代码不自动清库，任何目录清理另走 D 档批准。                             |

## 6. 红区与验证计划

维护者已授予本次精确红区路径：`prisma/seed.ts`、
`scripts/check-dictionary-seed-registry.ts`、`docs/ai-harness/ROUTE_AUTHZ.md` 和本评审稿。
授权不包含 schema / migration、断言模式裁判、权限或运行时 Gate。

最小验收：

1. registry criteria：31/31 覆盖、无重复、完整 selector / Facet 矩阵与受控目录对拍；
2. 字典登记表：D0–D6 全绿，读数为 30 type / 277 item；
3. lint、typecheck、unit、harness selftest 和 docs guards；
4. `docs:authz:check`、contract 保持可解释的零业务契约变化；
5. PR CI 冷跑负责 build / contract / 全量 e2e；本机不跑全量 e2e。

## 7. 后续边界

A1 合并、CI 全绿和维护者验收完成前，A2 不得开始。A2 若新增 Family / Version
schema，必须重新按 D 档单独调查、风险表、拍板、migration rehearsal 与 PR；不得把本 registry
当作其自动授权。
