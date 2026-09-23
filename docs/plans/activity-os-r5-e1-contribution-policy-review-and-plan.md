# Activity OS Release 5 / E1：贡献政策评审与精确实施计划

> 2026-09-23，E1-2 implementation 基点为 `main@801e097735227b5cb7c577dea97e31141d0d7640`。Release 4 的
> D1–D8 仓内实现已完成，D8-OPS 仍是未获执行授权的独立生产动作。本稿只启动下一条仓库开发轴
> Release 5 / E1；E1-1 与 E1-2 计划已合入 main，当前按第 11–15 节实施 E1-2，不部署、不切 Gate、
> 不执行 D8-OPS，也不把蓝图正文当作命令或跨阶段授权。

## 1. 结论先说

E1 要解决的不是“马上重算贡献值”，而是先建立一套可以被模板、活动和岗位明确引用的贡献政策版本。
当前 `ContributionRule` 仍按 `activityTypeCode × attendanceRoleCode` 给考勤记录预填分值；正式贡献账本、
每日全局上限和历史已入账分数都已经有自己的事实链。E1 若直接替换它们，会把建目录、迁移旧规则、shadow、
结算接线和正式切换五件事挤进一刀，既无法证明兼容，也违反冻结顺序。

**推荐方案 A：完整政策层，按 E1-1／E1-2／E1-3 三刀交付。**

1. **E1-1 数据与定义地基。** 新增稳定 `ContributionPolicy`、不可变
   `ContributionPolicyVersion`、命令收据和强类型 V1 definition／fingerprint／纯 evaluator；不接任何现有 writer。
2. **E1-2 System 目录控制面。** 由 Human System surface 集中创建政策和版本、激活／退役、查询历史；
   显式 GLOBAL 权限，不给内建角色默认授码，不开放 App／Integration 写入口。
3. **E1-3 选择与发布冻结。** 模板／Activity／SessionPosition 只引用已批准版本，新提案和快照冻结精确
   policy/version/hash/evaluator，Readiness 只在真实闭环后解除贡献政策 blocker。

E2 再转换旧 `ContributionRule`，E3 才做新旧并算和差异清单，E4 才接现有结算链，E5 才在独立窗口正式切换并把旧规则只读化。
E1 任一子刀通过都不能冒充 Release 5 完成。

方案 B 是只建两张空表，把收据、管理、选择和发布冻结都留到后面。改动较少，但会再次出现“schema 已有、
业务仍不可用”的半成品，也不能为 E2 的可追溯转换提供稳定锚点，因此不推荐。

## 2. 当前权威基线

| 现场事实     | 证据与结论                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 仓库基线     | `pnpm docs:counts:check`：43 模块、124 Controller、645 Endpoint、130 migration、565 BizCode、265 权限、170 AuditLogEvent；schema 实测 179 个 model。                            |
| 旧规则真相   | `prisma/schema.prisma` 的 `ContributionRule` 仍以活动类型、考勤角色、单阈值和上下档分值表达；`dailyCap` 已废弃但保留。                                                          |
| 当前预填     | `src/modules/attendances/contribution-calculator.ts` 只按 `(activityTypeCode, attendanceRoleCode)` 批量查 ACTIVE 规则；无匹配保守为 0，数据库漂移出现重复 pair 时 fail-closed。 |
| 正式贡献事实 | `ParticipationLedgerEntry`、`MemberContributionDayState` 已保存 recognized／credited／cappedOut 和每日物化状态；全局日上限仍是既有 `GLOBAL_DAILY_CONTRIBUTION_CAP=3`。          |
| 发布合同     | V6–V8 提案和快照中的 `contributionPolicyPointers` 仍固定为 `null`；不得回改这些历史 schema/hash。                                                                               |
| Readiness    | `ActivityPublishReadinessService` 当前始终登记 `CONTRIBUTION_POLICY_UNREPRESENTABLE`；只有 E1-3 的真实选择、解析和冻结闭环才有资格改变它。                                      |
| 迁移联动     | E1-1 已把当前完整回放推进到 130；E1-2 不改 schema/migration，不刷新 migration 计数，也不继承 E1-1 的 3b。                                                                       |
| 并行状态     | 唯一 open PR #1324 只修改流程文件，与本稿六份文档零交叉；维护者已对本 lane 豁免唯一 open PR 要求，E 档 release 的 global 0 open PR 规则不变。                                   |

蓝图是需求来源，不是执行指令。它明确要求贡献与时长解耦、System 集中管理、强类型 evaluator、旧规则先 shadow
再切换，并禁止一个窗口同时切 v1.1、分类时长和贡献政策。本稿把这些要求翻译为当前仓库可验证的分刀。

## 3. E1 必须守住的不变量

1. `contributionPoints > 0` 不能推出志愿服务时长，反向也不成立；E1 不用分值改写时长分类。
2. 旧 `ContributionRule`、考勤预填、人工终审调整、现有账本、每日全局上限和历史已入账分数在 E1 全程零行为变化。
3. 政策由 System surface 集中治理；发布人只能选择已批准版本，不能在单场活动中输入公式或自由 JSON。
4. 版本语义从创建起不可原地修改；退役只禁止新选择，历史引用仍可按原 hash/evaluator 解释。
5. 不按“最新版”隐式解析，不按标题、活动名称或 AI 猜政策。所有正式引用都固定 policyId、versionId、definitionHash 和 evaluatorVersion。
6. 现有每日上限、credited/cappedOut、PostingBatch 和 correction 语义保留；E1 V1 definition 不另造 per-policy daily cap。
7. 历史不回填、不重算、不删除。E2–E5 的转换、shadow、接线与切换分别立项，贡献切换不得与 D8-OPS 或 v1.1 Gate 同窗。
8. Release 1–5 的核心链必须在无 AI 条件下完整运行；definition 不允许 JavaScript、动态 SQL、表达式引擎或 AI 解释。

## 4. 方案 A 的数据合同

### 4.1 `ContributionPolicy`

稳定政策身份，建议字段：`id`、不可复用 `code`、展示 `name`／`description`、`createdAt`／`updatedAt`。
`code` 只表示治理身份，不承载计算公式；展示字段变化不得改变历史版本 hash。政策永久保留，不提供硬删或复用 code。

### 4.2 `ContributionPolicyVersion`

建议字段：

- `policyId`、正整数 `version`，二者唯一；
- `schemaVersion`、`evaluatorVersion`、`definitionJson`、`definitionHash`；
- `effectiveFrom`、可空 `effectiveUntil`，采用 UTC 左闭右开；
- `statusCode = draft | active | retired`；
- 创建、激活、退役的时间与 actor 审计锚。

引用侧至少具备 `(id, policyId, definitionHash, evaluatorVersion)` 的精确复合锚。版本内容和生效区间从插入起不可原地改；
状态只允许 `draft → active → retired`，不回退、不复活、不硬删。多个版本可有重叠生效区间，因为调用方固定精确版本，
不提供“按当前时间猜最新 active”的解析器。

fingerprint 输入只含 `schemaVersion`、`evaluatorVersion`、规范化 definition 和生效区间；使用仓内既有 canonical/hash 原语，
禁止再造 JSON 排序、浮点或日期序列化算法。未知 schema/evaluator 一律 fail-closed。

### 4.3 `ContributionPolicyCommandReceipt`

为 E1-2 的创建版本和生命周期命令预留同一套幂等事实：稳定 `operationKey`、`requestHash`、命令类型、policy/version 锚、
结果状态、actor 与 `createdAt`。相同 key+payload 返回原结果，不同 payload 拒绝；收据不可更新、删除或截断。
E1-1 只落数据库合同，不注册 HTTP writer，也不伪造业务审计事件。

### 4.4 V1 强类型 definition

V1 只采用终态所需的闭合输入，不做万能表达式：

```text
defaultResult:
  recognizedPoints: canonical decimal string
  explanationCode: stable code

roleRules[]:
  attendanceRoleCode
  categoryRules[]:
    timeCategoryCode
    durationBands[]:
      maxSecondsInclusive: integer | null
      recognizedPoints: canonical decimal string
      explanationCode: stable code
```

确定性约束：

- `attendanceRoleCode` 在一个版本内唯一；每个 role 下四类
  `volunteer_service | training | organization | non_creditable` 各至多一条；不存在的 pair 使用显式 `defaultResult`。
- 每组 band 按 `maxSecondsInclusive` 严格递增，最后一段必须为 `null`，区间无洞、无重叠；计算输入是非负整数秒，
  不读取计划时长，也不从 Decimal 小时反推边界。
- `recognizedPoints` 是 `0.00..999.99` 的规范两位小数字符串；输出不在这里执行每日封顶，既有日上限仍只在正式账本分配处生效。
- `explanationCode` 是 1–64 字符稳定码，不存自由文本、个人资料或附件；展示文案不参与 hash。
- 建议上限为 64 个 role、每个 role 最多 4 个 category、每组最多 16 个 band；重复键、未知键、错类型、超限、
  非规范小数、负秒、缺失终止 band 全部拒绝。
- 模板、Activity 与 Position 的差异通过 E1-3 选择不同政策版本表达，不把对象 ID、组织 ID 或活动标题写进 definition。
  未来确有业务属性或特殊组织规则时，以新 schemaVersion 明确扩展，不能借 `extra` 或任意条件树偷渡。

纯 evaluator 的输出只有 `{ recognizedPoints, explanationCode }`；调用方若需要正式事实锚，必须把已解析的
`policyVersionId` 与这份结果一并保存，不能让纯函数自行查库或猜版本。E1-1 的 evaluator 仅供单元验证和后续
E2/E3 复用，不被现有考勤或结算调用。

## 5. 三刀交付与 DoD

### 5.1 E1-1：数据与定义地基

DoD：

1. 第 130 条纯 additive migration 新增三表、复合锚、生命周期、不可变、hash、生效区间和收据约束；零 DML、回填、删除或旧表修改。
2. 129 条历史 migration checksum 逐条不变；130 冷回放与含现有 `ContributionRule`、账本、D8 收据的 129→130 非空升级通过。
3. V1 parser/fingerprint/evaluator 覆盖所有合法组合和未知键、重复项、边界秒、非规范小数、超限、未知 evaluator 负例。
4. DB 独立拒绝版本语义 UPDATE、DELETE、TRUNCATE、非法状态跳转、hash/区间/复合锚漂移；事务回滚不留半张收据。
5. 旧 ContributionRule 预填、账本、Readiness 和 V2–V8 快照 characterization 零变化；无新 API、DTO、权限、审计或角色授权。
6. schema owner、状态机 inventory、时钟字段、生成文档、migration 计数与 3b 实际 SQL 摘要登记完整。

### 5.2 E1-2：System 目录控制面

精确计划见第 11–16 节：固定 8 个 Human System 接口、两个显式 GLOBAL 权限、两类独立审计事件、四种命令收据、
锁后身份复核和真实 HTTP／并发验收。SUPER_ADMIN 也不能绕过权限码；内建角色零默认授权；查询历史不泄露 actor
个人资料。E1-2 不改 schema/migration，不接旧贡献规则、考勤、账本、Readiness 或 Gate；E1-1 的批准和 grant
不继承到 E1-2。

### 5.3 E1-3：选择与发布冻结

未来单独精确计划。模板、Activity、SessionPosition 采用完整版本引用，最近层级的显式完整引用覆盖上层，不做 JSON 字段合并；
需独立不可变选择 revision、同链复合 FK 和 command receipt。建议新模板 schema V5、新发布提案 V9，仅新稿使用；
V1–V4 模板、V2–V8 提案／快照及其 hash 不回改。批准时冻结最终 policy/version/hash/evaluator 和覆盖来源，
退役或撤权竞态必须锁后重验。只有该闭环完成后，Readiness 才按真实选择消除 `CONTRIBUTION_POLICY_UNREPRESENTABLE`；
仍不接正式贡献结算。

## 6. E1-1 精确候选写集（47 路径）

### 6.1 数据、实现与新增测试（9 路径）

1. `prisma/schema.prisma`
2. `prisma/migrations/20260922194000_activity_os_r5_e1_contribution_policy_foundation/migration.sql`
3. `src/common/datetime/clock-authority.spec.ts`
4. `src/modules/activities/activity-contribution-policy-definition.ts`
5. `src/modules/activities/activity-contribution-policy-definition.spec.ts`
6. `src/modules/activities/activity-contribution-policy-state-machine.ts`
7. `src/modules/activities/activity-contribution-policy-state-machine.spec.ts`
8. `test/e2e/activity-os-r5-e1-contribution-policy-foundation.e2e-spec.ts`
9. `test/e2e/activity-os-r5-e1-contribution-policy-migration.e2e-spec.ts`

### 6.2 既有 migration 当前总数 129→130（24 路径）

以下文件只更新 `CURRENT_MIGRATION_COUNT`、描述“当前完整回放”的标题／长度和新末尾 migration；所有历史索引、
旧升级目标、checksum 基点、夹具行为和业务断言保持：

1. `test/e2e/activity-os-r1-a3-template-definition-lifecycle-guards.e2e-spec.ts`
2. `test/e2e/activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts`
3. `test/e2e/activity-os-r2-b1-place-schema-constraints.e2e-spec.ts`
4. `test/e2e/activity-os-r2-b2-coordinate-projection-schema-constraints.e2e-spec.ts`
5. `test/e2e/activity-os-r2-b3-form-blueprint-governance.e2e-spec.ts`
6. `test/e2e/activity-os-r2-b6-creation-data-foundation.e2e-spec.ts`
7. `test/e2e/activity-os-r3-c1-d2a-metric-command-receipt-migration.e2e-spec.ts`
8. `test/e2e/activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts`
9. `test/e2e/activity-os-r3-c1-metric-definition-set.e2e-spec.ts`
10. `test/e2e/activity-os-r4-d7-2-fact-correction-migration.e2e-spec.ts`
11. `test/e2e/activity-os-r4-d8-proof-cutover-migration.e2e-spec.ts`
12. `test/e2e/activity-v11-batch4-allocation-candidate-position-anchor-migration.e2e-spec.ts`
13. `test/e2e/activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts`
14. `test/e2e/activity-v11-batch4-allocation-determinism-migration.e2e-spec.ts`
15. `test/e2e/activity-v11-batch4-allocation-mode-migration.e2e-spec.ts`
16. `test/e2e/activity-v11-batch4-qualification-contract-migration.e2e-spec.ts`
17. `test/e2e/insurance-evidence-registration-revision-migration.e2e-spec.ts`
18. `test/e2e/activity-os-r4-d1-1-time-policy-migration.e2e-spec.ts`
19. `test/e2e/activity-os-r4-d7-time-correction-migration.e2e-spec.ts`
20. `test/e2e/activity-os-r4-d6-time-ledger-migration.e2e-spec.ts`
21. `test/e2e/activity-os-r3-c2-outcome-value-revision.e2e-spec.ts`
22. `test/e2e/activity-os-r4-d3-time-allocation-revision-migration.e2e-spec.ts`
23. `test/e2e/activity-os-r4-d4-time-bucket-migration.e2e-spec.ts`
24. `test/e2e/activity-os-r4-d1-3-selection-migration.e2e-spec.ts`

### 6.3 治理、计划与派生登记（13 路径）

1. `docs/plans/activity-os-r5-e1-contribution-policy-review-and-plan.md`
2. `docs/ai-harness/NEXT_TASKS.md`
3. `docs/ai-harness/FROZEN_DRAFTS.md`
4. `changelog.d/activity-os-r5-e1-contribution-policy.md`
5. `CODEMAP.md`
6. `docs/current-state.md`
7. `docs/ai-harness/CUTOVER_SIGNOFF.md`
8. `docs/ai-harness/ROUTE_AUTHZ.md`
9. `docs/ai-harness/STATE_MACHINE_INVENTORY.md`
10. `harness/domain-map.json`
11. `harness/state-machines.json`
12. `prisma/CLAUDE.md`
13. `src/modules/activities/CLAUDE.md`

### 6.4 既有测试夹具兼容（1 路径）

1. `test/setup/time-ledger-fixture-cleanup.ts`：仅将三张 E1-1 新表及其 `no-truncate` trigger 纳入既有受控
   清理与原状态恢复；生产守卫、业务断言和业务超时不变。

若实际生成器证明某个派生文件零 diff，则不伪造改动；若实现产生本清单外必需路径，必须先上报扩写，不能靠通配授权夹带。
E1-1 不修改 `ContributionRule` 模型／模块、`contribution-calculator.ts`、考勤、账本、settlement、proposal、Readiness、
contract snapshot、客户端、seed、权限或审计目录。

## 7. 验证、签字与授权边界

实施后的本地验证只允许维护者当轮明确批准的隔离库，建议沿用 `app_test_w98`：

1. 先运行定义／状态机单测、lint、typecheck、build 和治理自证。
2. 再在 w98 做第 130 条冷回放、129→130 非空升级、DB 约束／不可变／并发与旧行为 characterization；
   只允许重建测试夹具，不运行 `migrate dev|reset|db push`。
3. `pnpm docs:migcount:check` 必须证明 18 处具名常量全部为 130；另逐行核验 7 份直接当前总数文件，不能用自动替换改历史目标。
4. migration SQL 定稿后计算完整 SHA-256，再请求 3b 重签；签字前不得写 `CUTOVER_SIGNOFF` 或运行迁移 E2E。
5. E1-1 不新增权限或 AuditLogEvent，4b 应明确“不需要重签”，不能复制旧计数冒充新增审批。
6. 本地不跑全量 E2E；Draft PR CI 冷跑完整 Contract + E2E。Ready、可信红区审批、合并和最终 main CI 分别授权／记录。

建议未来实施授权语句：

> 确认 E1 方案 A；确认 E1-1 implementation 方案 A，按 E1 计划第 3–7 节及 46 个精确路径执行；
> 允许 app_test_w98 隔离验证及测试夹具重建；migration SQL 定稿后另行重签 3b；验证通过后提交、推送并创建 Draft PR。
> 不合并、不操作生产、不启用 Gate、不执行 D8-OPS、不删除或重算业务数据。

该语句生效后仍由维护者在实施 worktree 按机器给出的精确红区逐条运行 `pnpm harness:grant`；AI 不自行发放授权。
E1-2、E1-3、E2–E5、生产部署和任何正式切换均不继承 E1-1 授权。

## 8. 风险与回退

| 风险                         | 防线                                                     | 回退                                                     |
| ---------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| 空目录被误当成正式政策已启用 | E1-1 零 provider／route／writer；旧行为 characterization | 停止后续入口，保留 additive 数据，不删表                 |
| definition 变成任意规则语言  | V1 闭合 grammar、数组和键上限、未知键拒绝                | 新需求另开 schemaVersion，不放宽 V1                      |
| 分值和时长重新耦合           | 输入只认明确分类秒和 role；不从分值推时长                | 不接 E4，旧事实链继续运行                                |
| 每日封顶出现第二份真相       | V1 不含 dailyCap；现有全局日上限保持唯一                 | 新政策只产 recognized，credited/cappedOut 仍由旧账本分配 |
| 历史因版本退役漂移           | 精确 version/hash/evaluator 引用；retired 历史可读       | 停止新选择，不改历史引用                                 |
| 旧规则转换丢语义             | E1 不转换；E2 独立 rehearsal，E3 shadow 差异清单         | E5 前一直保留旧正式路径                                  |
| 与 D8／v1.1 同窗切换         | E1 纯仓内 gate-off；E5 独立实时授权                      | 保持旧贡献真相，不动生产                                 |

## 9. E1 初始 docs-only 记录（历史）

初始 E1 评审只修改本稿、`NEXT_TASKS.md`、`FROZEN_DRAFTS.md` 和
`changelog.d/activity-os-r5-e1-contribution-policy-review.md`，已随计划 PR
[#1344](https://github.com/BA7IEE/srvf-nest-api/pull/1344) 合入。该轮只冻结 E1 总方案、V1 数据合同、三刀边界、
E1-1 候选写集和验证方法，不是 E1-2 实施授权。

## 10. E1-1 最终仓内记录（2026-09-23）

- 计划 PR [#1344](https://github.com/BA7IEE/srvf-nest-api/pull/1344) 已 squash 合入
  `db580471f94d94300ff30ef7f8925515fc15c0c6`，对应
  [main CI 35726170176](https://github.com/BA7IEE/srvf-nest-api/actions/runs/35726170176) 成功。
- 实现 PR [#1345](https://github.com/BA7IEE/srvf-nest-api/pull/1345) 最终 head
  `f02065123eca7bea909e9bc4714d1bae71a2eef1` 的所有要求检查均成功，已 squash 合入
  `48596844bbb194f541404b36d74a98dc2aa7ec32`。合并后
  [main CI 35822456365](https://github.com/BA7IEE/srvf-nest-api/actions/runs/35822456365) completed/success，五个
  Contract + E2E 分片均成功。
- 第 130 条纯 additive migration、三模型、复合版本锚、永久留存／不可变／生命周期守卫、V1 parser／fingerprint／
  纯 evaluator 和数据库／migration E2E 已进入 main；没有 provider、route、writer 或旧链接线。当前为
  130 migration／179 model／645 Endpoint／265 权限／170 AuditLogEvent。
- migration SQL 摘要 `a2447e373d8bc08ae58346574fabe0e88b4c25bc919eab7a2c8dd2fed758bb00` 的 3b 已重签；
  E1-1 没有新增权限码或 AuditLogEvent，4b 不需要重签。实际 47 路径均在获批范围内，历史 migration、生产守卫、
  旧贡献规则、考勤、账本、Readiness 和既有业务断言未改变。
- 以上只证明 E1-1 仓内交付；未部署、未执行 D8-OPS、未启用 Gate，E1-2／E1-3 与 E2–E5 仍未实施。

## 11. E1-2 方案 A：System 目录控制面

### 11.1 归属与 API surface

E1-2 复用 E1-1 已落地的三模型和纯定义原语，继续归 `ActivitiesModule` 所有；不另建 contribution-policy 模块，
也不把旧 `contribution-rules` 模块改造成新目录。政策是全系统统一治理对象，不属于单组织 Admin 资源，故固定为
**Human System surface**：控制器前缀 `system/v1/contribution-policies`，外部完整路径如下。

| 方法 | 路径                                                                    | 权限                                 | 返回／语义                                                  |
| ---- | ----------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------- |
| GET  | `/api/system/v1/contribution-policies`                                  | `contribution-policy.read.catalog`   | 按 `createdAt DESC, id DESC` 分页；可按稳定 `code` 精确过滤 |
| GET  | `/api/system/v1/contribution-policies/:id`                              | `contribution-policy.read.catalog`   | 政策详情；不存在为 404                                      |
| GET  | `/api/system/v1/contribution-policies/:id/versions`                     | `contribution-policy.read.catalog`   | 按 `version DESC, id DESC` 分页；可按三态精确过滤           |
| GET  | `/api/system/v1/contribution-policies/:id/versions/:versionId`          | `contribution-policy.read.catalog`   | 版本详情，包含已校验的强类型 V1 definition                  |
| POST | `/api/system/v1/contribution-policies`                                  | `contribution-policy.manage.version` | 创建稳定政策，201，返回命令收据                             |
| POST | `/api/system/v1/contribution-policies/:id/versions`                     | `contribution-policy.manage.version` | 创建下一 draft 版本，201，返回命令收据                      |
| POST | `/api/system/v1/contribution-policies/:id/versions/:versionId/activate` | `contribution-policy.manage.version` | `draft → active`，200，返回命令收据                         |
| POST | `/api/system/v1/contribution-policies/:id/versions/:versionId/retire`   | `contribution-policy.manage.version` | `active → retired`，200，返回命令收据                       |

本刀不提供 PATCH、DELETE、恢复 retired、按时间猜“当前版本”、批量写、App/Admin/Open/Integration 写入口或
ServicePrincipal 入口。政策创建后 `code` 不复用；`name`／`description` 本刀也不开放修改，避免在没有独立收据和审计合同前
引入隐式可变 writer。

### 11.2 请求与响应合同

- 创建政策：`operationKey` 1–128；`code` 固定 `^[a-z][a-z0-9_]{0,63}$`；`name` 1–120；
  `description` 省略时规范化为 `null`，非空时 1–500、首尾无空白、拒绝控制字符。
- 创建版本：`operationKey`、固定 `schemaVersion=1`、固定 `evaluatorVersion=1`、E1-1 强类型 `definition`、
  UTC 毫秒 ISO `effectiveFrom/effectiveUntil`。definition、日期、canonical/hash 和 32 KiB 上限只复用 E1-1 原语，
  不复制一套解析器。
- 激活／退役：都提交 `operationKey`、`expectedDefinitionHash` 和 `expectedStatusCode`；激活只接受 `draft`，
  退役只接受 `active`。这三个期望值全部进入 request hash，不能用最后写入覆盖并发变化。
- 政策读 DTO 只含 `id/code/name/description/createdAt/updatedAt`。版本摘要不含 definition 和 actor ID；版本详情只在摘要上
  增加已解析的强类型 definition。任何读面都不返回 `createdByUserId/activatedByUserId/retiredByUserId`、操作键、request hash
  或原始 `resultJson`。
- 命令收据固定 8 个字段：`schemaVersion`、`operationCode`、`policyId`、`versionId`、`definitionHash`、
  `evaluatorVersion`、`resultStatusCode`、`createdAt`。`create_policy` 的四个版本字段为 `null`；其余命令必须给出
  完整版本锚。响应不暴露 actor、审计元数据或内部 receipt ID。
- 分页沿仓内 `PaginationQueryDto`，默认 20、最大 100；不存在的 policy 与空版本页必须可区分，列表总数和当前页读取
  保持同一只读事务快照，不做逐条查询。

## 12. 授权、幂等、锁序与审计

### 12.1 两项显式权限

新增且只新增：

1. `contribution-policy.read.catalog`：Human GLOBAL 读取目录；
2. `contribution-policy.manage.version`：Human GLOBAL 创建政策／版本并迁移版本状态。

两码均为 `CUSTOM_ROLE_ALLOWED`，`servicePrincipalAllowed=false`、`delegatedAccessAllowed=false`，十五个内建角色零默认授予；
`SUPER_ADMIN` 也必须显式持码。manage 不蕴含 read，不在 implication graph 中造隐藏继承。Controller 的
`@RequiresPermission(..., { require: 'all', engine: 'rbac-global' })` 只是声明；Service／Query 仍须在事务中通过
`loadActiveUserIdentityInTx`、`rbac.can(..., tx)` 与 `getUserPermissionCodes(..., tx)` 三者共同确认当前 Human、ACTIVE 和显式码。
ServicePrincipal 或失效用户统一拒绝，不能靠 JWT 旧角色快照继续写。

### 12.2 命令收据与锁序

- 四个 operation 固定为 `create_policy | create_version | activate_version | retire_version`；唯一幂等范围沿现有数据库键
  `(actorUserId, operationCode, operationKey)`。
- request hash 由 operation、path 中的 policy/version 锚和规范化后的全部业务输入共同计算。相同 key+payload 返回原始收据，
  不重复写事实或审计；相同 key+不同 payload 返回 409。重放前重新验证收据的 policy/version/hash/evaluator 复合锚，
  任一漂移 fail-closed。
- 所有 writer 使用一个 Read Committed 事务。顺序固定为：首次身份／权限检查 → command advisory lock → 再检查 → 查 prior
  receipt。无 prior 时，创建版本按 policy 行 `FOR UPDATE` 后再检查；激活／退役按 policy 行、version 行顺序加锁，
  每次实际等待后都重新读取当前身份和显式权限，再核对 expected hash/status。
- 创建版本号由锁内读取该 policy 的最大 version 后递增；达到 PostgreSQL `INT` 上限明确失败。禁止先查后在事务外写，
  禁止逐条锁、随机锁序或 SUPER_ADMIN 短路。
- 事实写、状态迁移、命令收据和审计必须同事务提交；任何一步失败整体回滚。数据库现有不可变／状态 trigger 是最终防线，
  service 仍必须先以 E1-1 状态机和专属 BizCode 给出可解释拒绝。

### 12.3 两类审计事件与隐私边界

新增两类 active AuditLogEvent：

1. `activity.contribution-policy.command`：只记录 `create_policy`，resource type 为 `contribution-policy`；
2. `activity.contribution-policy-version.command`：记录 create／activate／retire version，resource type 为
   `contribution-policy-version`。

每个不同命令请求各留一条审计；同一命令的成功重放不重复审计。`extra` 只允许 operation、policy/version ID、前后状态、
definition hash 与 evaluator version 等闭合锚，不写 code、name、description、definition、operationKey、requestHash、actor 资料或
自由文本。GET 不写审计。两类事件分开是为了让政策身份创建和版本生命周期可独立筛选，不用一个宽泛事件猜资源语义。

## 13. 错误合同、治理登记与预期读数

### 13.1 八个新 BizCode

沿当前 Activity 尾号连续占用，实施前仍须机器复核未被并行分支占用：

| 常量                                            | code / HTTP | 用途                                                 |
| ----------------------------------------------- | ----------- | ---------------------------------------------------- |
| `ACTIVITY_CONTRIBUTION_POLICY_INVALID`          | 20239 / 400 | DTO 之外的 canonical、definition、日期或闭合对象失败 |
| `ACTIVITY_CONTRIBUTION_POLICY_NOT_FOUND`        | 20240 / 404 | policy 或同 policy 下的 version 不存在               |
| `ACTIVITY_CONTRIBUTION_POLICY_CODE_EXISTS`      | 20241 / 409 | 稳定 code 已存在                                     |
| `ACTIVITY_CONTRIBUTION_POLICY_STALE`            | 20242 / 409 | expected hash/status 与锁后事实不一致                |
| `ACTIVITY_CONTRIBUTION_POLICY_STATUS_INVALID`   | 20243 / 409 | 非 `draft→active→retired` 的迁移                     |
| `ACTIVITY_CONTRIBUTION_POLICY_COMMAND_CONFLICT` | 20244 / 409 | 同 actor/operation/key 已绑定不同请求                |
| `ACTIVITY_CONTRIBUTION_POLICY_RECEIPT_INVALID`  | 20245 / 409 | 收据形状或复合事实锚不可信                           |
| `ACTIVITY_CONTRIBUTION_POLICY_VERSION_LIMIT`    | 20246 / 409 | policy 版本号达到 INT 上限                           |

Controller 还需声明通用 `BAD_REQUEST/UNAUTHORIZED/RBAC_FORBIDDEN/PRINCIPAL_KIND_FORBIDDEN`。不能把不存在、陈旧、状态错误和
幂等冲突合成同一个 409；也不能把数据库错误原样泄露。

### 13.2 治理登记

- `harness/domain-map.json` 只确认三个既有模型继续归 `activities`，不改 owner、不新建 domain。
- `ContributionPolicyVersion.statusCode` 登记专属 wrong-state BizCode 和 runtime writer，blocker 从
  `no-runtime-writer/no-wrong-state-bizcode` 收敛为 `no-governed-evidence`；仍保持 `inventory`，不得凭本刀冒称 governed。
- authz patterns、permission surface、route authz、RBAC map、audit registry、OpenAPI 和前端客户端都由既有生成器刷新；
  零 diff 的生成物不伪造提交，真实 diff 不得遗漏。

### 13.3 实施完成后的预期计数

| 项            |               当前 |          E1-2 预期 | 变化原因               |
| ------------- | -----------------: | -----------------: | ---------------------- |
| 模块          |                 43 |                 43 | 复用 ActivitiesModule  |
| Controller    |                124 |                125 | 一个 System Controller |
| Endpoint      |                645 |                653 | 八个目录端点           |
| Migration     |                130 |                130 | 不改 schema/migration  |
| Model         |                179 |                179 | 复用 E1-1 三模型       |
| BizCode       |                565 |                573 | 八个专属错误码         |
| 权限码        |                265 |                267 | read/manage 两码       |
| AuditLogEvent | 170 总计／165 活跃 | 172 总计／167 活跃 | 两类 active 事件       |

本刀不需要 3b；实现与生成物定稿后，必须以当时实际权限目录摘要完成 4b 重签，不能在 docs-only 计划阶段预签。

## 14. E1-2 implementation 精确候选写集（60 路径）

### 14.1 所有者实现与单元测试（14 路径）

1. `src/modules/activities/activity-contribution-policy-command.ts`
2. `src/modules/activities/activity-contribution-policy-command.spec.ts`
3. `src/modules/activities/activity-contribution-policy.service.ts`
4. `src/modules/activities/activity-contribution-policy.service.spec.ts`
5. `src/modules/activities/activity-contribution-policy-catalogue-query.service.ts`
6. `src/modules/activities/activity-contribution-policy-catalogue-query.service.spec.ts`
7. `src/modules/activities/activity-contribution-policy-presenter.ts`
8. `src/modules/activities/activity-contribution-policy-presenter.spec.ts`
9. `src/modules/activities/activity-contribution-policy-audit-recorder.ts`
10. `src/modules/activities/activity-contribution-policy-audit-recorder.spec.ts`
11. `src/modules/activities/controllers/system-contribution-policies.controller.ts`
12. `src/modules/activities/dto/system/contribution-policy.dto.ts`
13. `src/modules/activities/dto/system/contribution-policy-command.dto.ts`
14. `src/modules/activities/activities.module.ts`

### 14.2 权限、审计、错误码与 seed（7 路径）

15. `src/modules/permissions/permission-catalog.ts`
16. `src/modules/permissions/permission-code-holders.spec.ts`
17. `src/modules/permissions/seed-permission-codes.ts`
18. `prisma/seed.ts`
19. `src/modules/audit-logs/audit-logs.types.ts`
20. `src/common/exceptions/biz-code.constant.ts`
21. `src/common/exceptions/biz-code.constant.spec.ts`

`prisma/seed.ts` 只登记两个新权限到 seed 闭包，十五个内建角色零默认授予；不创建政策、版本或业务数据。

### 14.3 HTTP、并发与契约验收（5 路径）

22. `test/e2e/activity-os-r5-e1-2-contribution-policy-catalogue.e2e-spec.ts`
23. `test/e2e/activity-os-r5-e1-2-contribution-policy-concurrency.e2e-spec.ts`
24. `test/e2e/activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts`
25. `test/contract/openapi.contract-spec.ts`
26. `test/contract/__snapshots__/openapi.contract-spec.ts.snap`

第 24 项只同步当前 seed 权限总数 265→267，保留全部历史升级目标和业务断言；既有 E2E 断言不删除、不放宽。

### 14.4 治理、派生文档与当前摘要（18 路径）

27. `harness/domain-map.json`
28. `harness/state-machines.json`
29. `harness/authz-assertion-patterns.json`
30. `harness/authz-implication-graph.json`
31. `harness/permission-surface-baseline.json`
32. `scripts/harness-guards.selftest.ts`
33. `docs/current-state.md`
34. `CODEMAP.md`
35. `docs/ai-harness/RBAC_MAP.md`
36. `docs/ai-harness/ROUTE_AUTHZ.md`
37. `docs/ai-harness/AUDIT_EVENT_REGISTRY.md`
38. `docs/ai-harness/STATE_MACHINE_INVENTORY.md`
39. `docs/ai-harness/CUTOVER_SIGNOFF.md`
40. `docs/ai-harness/FROZEN_DRAFTS.md`
41. `docs/ai-harness/NEXT_TASKS.md`
42. `src/modules/activities/CLAUDE.md`
43. `prisma/CLAUDE.md`
44. `docs/plans/activity-os-r5-e1-contribution-policy-review-and-plan.md`

第 32 项只同步守护器权限计数／注释并保留全部正反例；第 39 项只在 4b 获维护者重签后登记实际摘要。

### 14.5 前后端交接与生成客户端（15 路径）

45. `docs/handoff/admin-web.md`
46. `docs/handoff/openapi.json`
47. `docs/handoff/clients/system/client.ts`
48. `docs/handoff/clients/system/types.ts`
49. `docs/handoff/clients/admin/client.ts`
50. `docs/handoff/clients/admin/types.ts`
51. `docs/handoff/clients/app/client.ts`
52. `docs/handoff/clients/app/types.ts`
53. `docs/handoff/clients/auth/client.ts`
54. `docs/handoff/clients/auth/types.ts`
55. `docs/handoff/clients/open/client.ts`
56. `docs/handoff/clients/open/types.ts`
57. `docs/handoff/clients/integration/client.ts`
58. `docs/handoff/clients/integration/types.ts`
59. `docs/handoff/clients/shared/types.ts`

只有 System 客户端新增可调用方法；其他客户端若生成器无真实 diff 不伪造改动。交接明确这是后端仓内能力，前端尚未发布，
并列出持码、Human、GLOBAL 和零默认授权前置。

### 14.6 Changelog（1 路径）

60. `changelog.d/activity-os-r5-e1-2-contribution-policy-control-plane.md`

若实施发现清单外必需路径，必须先报告理由和新增路径再扩写；不得借目录 glob 顺手修改 E1-3、旧贡献规则、考勤、账本、
Readiness、Gate、schema/migration、CI 配置或生产脚本。

## 15. E1-2 验收、风险与回退

### 15.1 必过验收

1. 单元：命令 hash／收据解析、四命令重放与冲突、权限双检查、definition 复用、presenter fail-closed、审计白名单及查询分页。
2. HTTP：8 路由的 400/401/403/404/409 和成功响应；无权限 SUPER_ADMIN、ServicePrincipal、失效用户均拒绝；
   显式 Human GLOBAL 持码成功，响应不泄露 actor、operationKey、requestHash 或原始 JSON。
3. 并发：同 key 同载荷只写一份事实／收据／审计；同 key 异载荷冲突；同 policy 并发建版本不重号；activate/retire
   竞态只允许一条合法边；advisory、policy、version 任一锁等待后的撤权／失效都拒绝且零部分写。
4. 数据库：E1-1 不可变、复合 FK、状态 trigger、no-delete/no-truncate 守卫继续由既有测试覆盖；E1-2 不新增 migration，
   130 条 checksum 与当前回放计数不变。
5. 契约：OpenAPI diff 只能新增这 8 个 System 路由和对应 DTO/BizCode；snapshot 逐行解释，System 客户端可生成，
   App/Admin/Auth/Open/Integration 不出现可调用 writer。
6. 治理：lint、typecheck、build、目标单测、两份 E2E、contract、Harness selftest/replay、边界检查和全部 docs guards 通过；
   Draft PR CI 冷跑五个 Contract + E2E 分片。Ready、红区审批、合并和 main CI 仍分别授权／核验。

### 15.2 风险与回退

| 风险                            | 防线                                                             | 回退                                           |
| ------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| 新目录被误当成结算已切换        | 本刀不接旧规则、考勤、账本、Readiness 或 Gate                    | 停止授予两码；保留已创建的永久政策事实，不删除 |
| SUPER_ADMIN／机器身份绕过       | Human identity + `rbac.can` + 显式持码三重检查，锁后复核         | 撤销自定义角色授码；不改业务数据               |
| 同 key 重放重复审计或串 actor   | 唯一键含 actor/operation/key，request hash 含 path 锚和全输入    | 修 writer 后重放原 key；不改原收据             |
| 并发版本重号／越级迁移          | policy→version 固定锁序、expected hash/status、DB unique/trigger | 事务回滚；不人工改版本号或状态                 |
| definition 或个人资料从读面泄露 | summary/detail 分层、强类型 presenter、audit extra 白名单        | 下线路由或收紧投影；不删除历史审计             |
| 权限或审计计数漂移              | 生成器 + 4b 实际摘要 + 旧迁移 seed 计数回归                      | 不 Ready，修正登记后重跑                       |

回退不是删表、删版本、删收据或改历史状态。E1-2 尚未被 E1-3／E4 消费，出现问题时只需停止授码或回退应用二进制；
所有已创建政策事实继续永久留存。

## 16. 本轮 docs-only 范围与后续授权

### 16.1 本轮六路径

1. `docs/plans/activity-os-r5-e1-contribution-policy-review-and-plan.md`
2. `docs/ai-harness/NEXT_TASKS.md`
3. `docs/ai-harness/FROZEN_DRAFTS.md`
4. `changelog.d/activity-os-r5-e1-2-contribution-policy-control-plane-plan.md`
5. `prisma/CLAUDE.md`
6. `src/modules/activities/CLAUDE.md`

后两项只更正“E1-1 尚未提交／待重签／待数据库验证”的过期当前摘要，不改下方历史段落或任何规则。当前
`pnpm harness:needs` 已确认六路径均不需要额外红区 grant。

### 16.2 本轮 DoD 与禁止域

DoD：准确登记 #1345 merge／最终 main CI；冻结 E1-2 的 API、DTO、权限、审计、事务、并发、错误码、预期计数、60 路径写集、
验证和回退；通过 docs 守卫后提交、推送并创建 Draft PR。

本轮不实施 E1-2，不改 TypeScript、schema、migration、seed、权限、审计、OpenAPI 或生成客户端，不操作任何数据库，
不 Ready、不合并、不执行 D8-OPS、不部署、不启用 Gate，不删除、回填、转换、重分类或重算业务数据。

### 16.3 建议的下一轮一次性授权语句

> 确认 E1-2 implementation 方案 A，按 E1 计划第 11–15 节及 60 个精确路径执行；允许 `app_test_w98`
> 隔离验证及测试夹具重建；确认两项新权限仅显式 GLOBAL Human 授予且 SUPER_ADMIN 不短路；验证后提交、推送并创建
> Draft PR。不合并、不操作生产、不启用 Gate、不执行 D8-OPS、不删除或重算业务数据。

该语句若获确认，仍先由机器一次性预算红区 glob，再由维护者本人执行 grant；E1-3、E2–E5、前端发布、生产部署和任何正式切换
均不继承 E1-2 授权。

## 17. E1-2 当前实施记录（2026-09-23）

- 维护者已确认第 11–15 节方案 A、60 路径精确写集、`app_test_w98` 隔离验证及 Draft PR 边界，并已执行红区 grant；
  保留 #1324 仅豁免本 lane 的唯一 open PR 要求。
- 已实现 8 个 Human System 路由、两项零默认授予 GLOBAL 权限、两类闭合审计、8 个 BizCode、四命令事务收据、
  锁后身份／权限复核、Repeatable Read 目录读取及强类型安全投影。E1-1 三表和第 130 条 migration 不变。
- 当前机器读数为 43 module／125 controller／653 endpoint／130 migration／179 model／573 BizCode／267 permission／
  172 AuditLogEvent（167 active）；目标单测、contract 以及目录／并发两份定向 E2E 已通过。
- 治理登记、OpenAPI 和前端客户端已按真实差异刷新；最终 lint、typecheck、build、Harness、docs guards 均通过。
  4b 已按权限267、Audit events 172总计／167活跃、字典30类／277项、seed摘要 `9a62f918affc` 及权限目录完整摘要
  `d2f4b3e450e7c750c0bc2b9375a6fcfb29fb9c93f3a0e6c57ac190d09f120314` 重签；当前待提交、推送并创建 Draft PR，
  不 Ready、不合并、不操作生产、不启用 Gate。

本次未做：E1-3、E2–E5、旧 `ContributionRule` 转换、考勤／账本／Readiness 接线、角色默认授码、前端发布、
D8-OPS、生产部署、Gate、数据删除、回填、转换、重分类或重算。
