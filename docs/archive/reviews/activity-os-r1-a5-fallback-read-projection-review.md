# Activity OS R1 / A5 显式 Template Version fallback / 只读投影评审记录

> **状态：已拍板，实施中（2026-09-02）。** 维护者已确认“确认 A5 方案 A；已执行”，并在本工作树发放本稿的归档授权。本稿就此冻结；实施证据、PR 审批与合并状态另行登记。
>
> **上游合同**：[Activity OS T0-A 终态合同](activity-os-t0-terminal-review.md) §1、§4、§5、§10.2、§10.3、§11、§12；[A4 显式指针评审](activity-os-r1-a4-explicit-template-version-review.md) §1–§5。A1、A2、A3、A4 已分别合入 [#1237](https://github.com/BA7IEE/srvf-nest-api/pull/1237)、[#1239](https://github.com/BA7IEE/srvf-nest-api/pull/1239)、[#1241](https://github.com/BA7IEE/srvf-nest-api/pull/1241)、[#1244](https://github.com/BA7IEE/srvf-nest-api/pull/1244)，本刀不重开其决策。

## 1. 结论

采用方案 A：将既有模板解析改为“显式指针优先、legacy fallback 保持”。

- `Activity.selectedTemplateVersionId != null` 时，只按该 `ActivityTemplate.id` 精确读取；不追加
  `statusCode='active'`、`familyId` 或 `activityTypeCode` 条件。已选 future Version 后来变为
  `retired` 仍必须可读；无目标行时 fail-closed，绝不悄悄退回最新模板。
- `selectedTemplateVersionId == null` 时，逐字保留现有
  `activityTypeCode + statusCode='active' + version desc + code asc + id asc` 的 legacy 查询。
- `CurrentProposalState` 同时保留原始指针和最终解析出的 `templateVersionId`：二者不能混为一谈，
  否则 change proposal 会把 legacy fallback 的当前结果误当成显式选择。
- 不增加 API 字段、DTO、Controller、错误码或 `resolution.source` 枚举；既有
  `templateVersionId` 字段仅在已存显式指针的 Activity 上反映新的、预期的解析结果。

## 2. 影响面与兼容口径

`ActivityPublishProposalV2Service` 是唯一模板默认值解析入口。A5 必须令下列既有路径得到同一
选择结果：

1. App `GET :activityId/template-resolution` 的只读投影；
2. initial proposal、change proposal 与 `rebuildCurrent` 的快照构造 / stale hash；
3. 历史 schemaVersion=2 的 approval 后解析，以及 v3–v5 已冻结提案的 RuleSnapshot 写入。

快照 schema、canonical hash 算法和 v2–v5 parser 一律不变。空指针 Activity 的现有输出与 hash
必须保持不变；非空指针 Activity 的 `templateVersionId` / resolvedConfig 因本刀切到明确选择而变化，
仍由现有 canonical hash 绑定，绝不引入 v6 或回改已持久化快照。

`Activity_selectedTemplateVersionId_fkey` 已保证正常数据库中非空指针不会成为孤儿；读取时仍用
精确查询的 fail-closed 形状，防止数据完整性异常被“最新 active 模板”掩盖。

## 3. 允许写集与禁止域

**允许写集**：

- `src/modules/activities/activity-publish-proposal-v2.service.ts`：读取 Activity 指针，并在解析处
  实施精确优先 / legacy fallback；
- `src/modules/activities/activity-publish-proposal-v2.service.spec.ts`：ORM 查询形状的单元回归；
- `test/e2e/activity-batch3-2-publish-review.e2e-spec.ts`：真实 App 读面、initial/change proposal 和
  RuleSnapshot 的端到端回归；
- 本评审稿、`docs/ai-harness/FROZEN_DRAFTS.md`、`docs/ai-harness/NEXT_TASKS.md` 与必要派生文档。

**明确不做**：

- 不改 `prisma/schema.prisma`、migration、seed、Family / Version 生命周期约束或任何 DB trigger；
- 不新增模板选择 writer、from-template 创建入口、Activity 指针 DTO / API、回填、dual-write、
  模板选择 UI 或生产数据；
- 不以 A5 补“必须 active”或“必须 future Family Version”校验；该选择资格由 A6 writer 在事务内
  单独处理，数据库级 guard 如需新增另立 D 档；
- 不改权限、Gate、审计事件、Controller、响应包装、OpenAPI 形状、Snapshot v6 或 v2–v5 hash 算法；
- 不执行 `prisma migrate dev`、`prisma migrate reset`、`prisma db push`、生产部署或数据删除。

## 4. 方案比较与已拍板项

| 方案 | 内容 | 风险 / 结论 |
| --- | --- | --- |
| **A（已批准）** | 非空指针按 id 精确读；空指针保持原 fallback；所有现有投影共用该选择。 | 恰好落实 A4 留下的读切换边界，保留历史可追溯和旧记录兼容。 |
| B | 对非空指针仍加 active / Family 条件，或查不到时回退到最新模板。 | 会把历史选择悄悄改写为当前模板，违背 A4 和 T0-A；不采用。 |
| C | 同时增加模板选择 writer、回填或新的 API。 | 越过 A6 边界；不采用。 |

维护者的精确确认：**“确认 A5 方案 A；已执行”**。

## 5. 验收与回退

1. 单元测试分别钉住：非空指针只发 `id` 精确查询、无指针保留既有 `findFirst` 的 where / 排序；
2. PostgreSQL E2E 建立一个 `draft → active → retired` 的 future Family Version 和一个更新的
   legacy active 模板；同一 Activity 显式指向前者后，App 解析、initial snapshot、RuleSnapshot 和
   change snapshot 都必须返回前者；
3. 既有空指针 template-resolution 回归仍解析 legacy active 模板；
4. `pnpm agent:check:quick`、定向 unit / E2E、`pnpm test:contract` 与 PR CI 冷跑通过；
   OpenAPI snapshot 零漂移；
5. 部署前可撤回本 PR。已应用的 A4 结构不回退、不删数据；A5 本身不产生 migration，故无 migration
   重签步骤。PR required checks 全绿后仍须维护者确认合并。

## 6. 授权记录

维护者已在以下工作树执行归档授权：

```bash
cd /Users/dengwang/Documents/coding/srvf-nest-api-activity-os-r1-a5-fallback-read-projection
pnpm harness:grant 'docs/archive/reviews/activity-os-r1-a5-fallback-read-projection-review.md' --reason "Activity OS R1/A5：维护者批准显式模板指针的 fallback/只读投影方案 A；仅改既有解析路径与回归测试，不改 schema、API 形状、writer、权限或迁移"
```

本刀没有 schema、权限、路由或执法层的**业务写集**。但统一派生文档刷新会按既有生成器
机械重写 `docs/ai-harness/ROUTE_AUTHZ.md` 与
`harness/authz-assertion-patterns.json`；维护者已为本工作树分别发放这两项最小令牌，且它们只
承载本刀源码指纹更新，不改变路由、权限或断言语义。完成后撤销本工作树令牌。
