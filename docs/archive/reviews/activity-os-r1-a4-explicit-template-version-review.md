# Activity OS R1 / A4 Activity 显式 templateVersion 指针评审记录

> **状态：已拍板，实施中（2026-09-02）。** 维护者已确认 §4 的方案 A，且已发放本刀所需的 schema / migration 与派生 `domain-map` 授权。本稿就此冻结；实施证据、重签、PR 审批和合并状态另行登记。
>
> **上游合同**：[Activity OS T0-A 终态合同](activity-os-t0-terminal-review.md) §4、§5、§10.2、§10.3、§11；原始蓝图《SRVF 活动域终态蓝图与分阶段落地方案》§7.3、§23.3。A1、A2、A3 已分别合入 [#1237](https://github.com/BA7IEE/srvf-nest-api/pull/1237)、[#1239](https://github.com/BA7IEE/srvf-nest-api/pull/1239)、[#1241](https://github.com/BA7IEE/srvf-nest-api/pull/1241)，本刀不重开它们的决策。

## 1. 结论

推荐方案 A：只为 `Activity` 增加可空的 `selectedTemplateVersionId`，以明确、稳定的外键
指向既有 `ActivityTemplate` 版本行。

本刀只落以下结构：

- `Activity.selectedTemplateVersionId String?`，无默认值；
- 指向 `ActivityTemplate.id` 的 `onDelete: Restrict` 外键，以及查询 / 删除保护所需的单列索引；
- `ActivityTemplate` 的反向关系，仅作为 Prisma 关系映射；
- 第 103 条纯 forward expand migration：只加可空列、索引和外键，零 `UPDATE`、零回填、零 seed；
- 独立 PostgreSQL E2E，证明 legacy 空指针保持空、合法引用可写、孤儿引用与删除被拒、冷库和非空库迁移均可复现。

这个指针是**选择事实**，不是本刀的解析切换或创建入口。它为后续 A5 的 fallback / 只读投影、A6
的 from-template 事务留下唯一锚点；在这两刀之前，现有 resolver 继续按
`activityTypeCode + statusCode='active' + version desc` 取 legacy 模板。

## 2. 事实、兼容性与风险

| 事实 / 风险                                                                                                       | 证据                                                                          | A4 处置                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 现有 `Activity` 没有模板版本指针                                                                                  | `prisma/schema.prisma:1385-1612`                                              | 只添加 nullable 列；历史行无需变更，`NULL` 继续代表走 legacy fallback。                                                                                           |
| 当前解析路径会按类型取最新 active 模板                                                                            | `src/modules/activities/activity-publish-proposal-v2.service.ts:934-960`      | A4 不改此 service、DTO、Controller 或快照；A5 才处理 `selectedTemplateVersionId != null` 的读路径。                                                               |
| `ActivityTemplate` 已是 Version 的物理存储行，Family Version 由 A2/A3 奠基                                        | `prisma/schema.prisma:1698-1744`；A2/A3 冻结评审稿                            | 外键直接锚定 `ActivityTemplate.id`，不复制 version、code、hash 或 definition。                                                                                    |
| 已选版本可能在后来被 retired，但历史 Activity 仍须可追溯                                                          | T0-A §5 的不可变 Version 合同                                                 | 仅禁止物理删除引用目标；**不**以 status `active` 作外键条件，也不让状态改变清空指针。                                                                             |
| 单纯 FK 无法表达“目标必须是 Family Version”这一跨表条件                                                           | PostgreSQL FK 只能引用唯一键；`ActivityTemplate.familyId` 是可空兼容列        | 本刀不添加额外 trigger，也不在无 writer 时伪造选择规则。未来 A6 writer 必须在事务内验证目标是可选的 future Version；若要先落数据库级选择资格 guard，须另立 D 档。 |
| 旧 Activity 的 `activityTypeCode` 仍是兼容事实                                                                    | T0-A §4、§10.2                                                                | 不删除、不改写、不将其与新指针强制绑定；无指针记录继续只读 fallback。                                                                                             |
| `resetDb` 先清 Activity、但不清 ActivityTemplate；三个既有 schema spec 自行 `TRUNCATE ActivityTemplate … CASCADE` | `test/setup/reset-db.ts:193-204`；三个 A2/A3/历史 schema spec 的 `beforeEach` | A4 后该 TRUNCATE 具备到 Activity 的反向 FK；保留当前 worker-local 清理方式，修正历史测试中“尚无反向引用”的过时注释，不改既有断言或 `test/setup`。                 |

## 3. 允许写集与禁止域

**允许写集（仅在 §4 获批后）**：

- `prisma/schema.prisma`：`Activity` 的 nullable FK / index 与 `ActivityTemplate` 反向关系；
- `prisma/migrations/20260901120000_activity_os_r1_a4_explicit_template_version/migration.sql`：第 103 条纯 expand migration；
- `test/e2e/activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts`：真实 PostgreSQL 的结构、约束、冷库和非空库证明；
- 七份现有 migration replay spec 的 `CURRENT_MIGRATION_COUNT`：`102 → 103`，仅更新“当前总数”，不改历史世代基线；
- `test/e2e/activity-batch3-1p5-schema-constraints.e2e-spec.ts`：只纠正 A4 使其过时的 cleanup 注释；不改任何断言或测试 setup；
- `harness/domain-map.json` 的派生输入摘要、冻结稿 / 滚动台账 / change fragment 与派生文档。

**明确不做**：

- 不改 legacy resolver、template-resolution、发布审核、Snapshot v2–v5、snapshot v6、ActivityRuleSnapshot 或现有快照 hash；
- 不新增 Controller、DTO、API、权限码、审计事件、Gate、业务 writer、模板选择 UI、seed 或真实模板数据；
- 不回填任何 Activity，不把现有 `activityTypeCode` 改为新指针，不执行 dual-read / dual-write；
- 不加入“只允许 active / 只允许 Family Version”的 trigger，不猜测未来选择资格、错误码或审计口径；
- 不执行 `prisma migrate dev`、`prisma migrate reset`、`prisma db push`，不部署生产 migration，不做生产 rollback。

## 4. 方案比较与待拍板项

| 方案          | 内容                                                                                  | 风险 / 回退                                                                                 | 结论                                                     |
| ------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **A（推荐）** | 可空 `selectedTemplateVersionId` + Restrict FK + index；零 writer / resolver / 回填。 | 未部署前可撤回本 PR；任何已应用 migration 的结构撤回必须按当时数据状态另立 D 档。           | 推荐。它先建立不可歧义的选择锚点，不提前改变旧活动解释。 |
| B             | 指针落库后立即切换 resolver，或强制非空并回填历史活动。                               | 在同一 PR 同时改存储、运行时真相和历史解释，越过 A5/A6 串行边界；回退与在途快照风险不可控。 | 不采用。                                                 |

**维护者确认（2026-09-02）的精确口径**：采用方案 A，允许第 103 条 migration 只增加上述 nullable FK / index，
并明确“不改 resolver、writer、API、DTO、快照、权限、Gate、seed、回填或生产部署”。

## 5. 验收、rehearsal 与回退

1. `prisma format`、`prisma validate`、`prisma generate`；
2. 真实 PostgreSQL E2E：
   - 旧形状 Activity 在 migration 后指针仍为 `NULL`，其原始字段逐字不变；
   - 可让多个 Activity 合法引用同一 Template Version；
   - 不存在的 Version id 被 FK 拒绝；被 Activity 引用的 Template 物理删除被 Restrict 拒绝；
   - 从空库 replay 全部 103 条 migration；从 A3 世代的非空库执行 A4 migration，已有 Activity / Template 数据不被改写；
3. characterization：当前 `activity-publish-proposal-v2.service.ts` 的 legacy resolver 行为和既有
   template-resolution 契约保持不变；OpenAPI snapshot 零漂移；
4. 七份全仓冷库 replay 用例的当前 migration 总数统一从 `102` 更新为 `103`，历史基线数字不动；
5. 运行 A2/A3 历史 schema spec，确认 `resetDb` 已先清 Activity 后的 worker-local Template 清理仍可用；仅更新其过时说明，原有断言不放宽；
6. `pnpm agent:check:quick`、A4 定向 E2E、`pnpm test:contract`、文档派生检查和 PR CI 冷跑；
7. 迁移一旦在任一环境应用，不以“回退”为名删除已被引用的数据或结构；任何反向 migration 另立 D 档。

## 6. 实施授权清单（已发放，保留为审计记录）

本评审稿的起草授权已经单独发放；维护者确认方案 A 后，以下两项实施授权也已在本 worktree 发放：

```bash
cd /Users/dengwang/Documents/coding/srvf-nest-api-activity-os-r1-a4-explicit-template-version
pnpm harness:grant 'prisma/**' --reason "Activity OS R1/A4：维护者批准方案 A，新增 Activity 显式 templateVersion nullable FK/index 的第 103 条纯 expand migration"
pnpm harness:grant 'harness/domain-map.json' --reason "Activity OS R1/A4：schema metadata 输入变化后同步派生 domain-map digest"
```

不需要授权 `harness/state-machines.json`、`docs/ai-harness/ROUTE_AUTHZ.md`、API contract 或生产入口，
因为 A4 不改变状态机、路由、运行时或部署。`FROZEN_DRAFTS.md`、`NEXT_TASKS.md`、
`CUTOVER_SIGNOFF.md` 和测试文件不在本刀的红区授权集合中。

实施后仍需维护者本人完成两次外部确认：

1. PostgreSQL migration 证据通过后确认“重签 3b（A4，第 103 条 migration）”；
2. PR 的 required checks 全绿且红区环境审批通过后确认合并。

全部授权仅限本工作树，A4 合并、状态登记完成后立刻撤销。
