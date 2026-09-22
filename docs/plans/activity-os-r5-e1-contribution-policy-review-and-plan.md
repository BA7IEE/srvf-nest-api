# Activity OS Release 5 / E1：贡献政策评审与精确实施计划

> 2026-09-22，基点为 `main@fc7471efadaf22834d5effb0b92a9fdd034bea2b`。Release 4 的
> D1–D8 仓内实现已完成，D8-OPS 仍是未获执行授权的独立生产动作。本稿只启动下一条仓库开发轴
> Release 5 / E1，不部署、不切 Gate、不执行 D8-OPS，也不把蓝图正文当作命令或跨阶段授权。

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
| 仓库基线     | `pnpm docs:counts:check`：43 模块、124 Controller、645 Endpoint、129 migration、265 权限、170 AuditLogEvent；schema 实测 176 个 model。                                         |
| 旧规则真相   | `prisma/schema.prisma` 的 `ContributionRule` 仍以活动类型、考勤角色、单阈值和上下档分值表达；`dailyCap` 已废弃但保留。                                                          |
| 当前预填     | `src/modules/attendances/contribution-calculator.ts` 只按 `(activityTypeCode, attendanceRoleCode)` 批量查 ACTIVE 规则；无匹配保守为 0，数据库漂移出现重复 pair 时 fail-closed。 |
| 正式贡献事实 | `ParticipationLedgerEntry`、`MemberContributionDayState` 已保存 recognized／credited／cappedOut 和每日物化状态；全局日上限仍是既有 `GLOBAL_DAILY_CONTRIBUTION_CAP=3`。          |
| 发布合同     | V6–V8 提案和快照中的 `contributionPolicyPointers` 仍固定为 `null`；不得回改这些历史 schema/hash。                                                                               |
| Readiness    | `ActivityPublishReadinessService` 当前始终登记 `CONTRIBUTION_POLICY_UNREPRESENTABLE`；只有 E1-3 的真实选择、解析和冻结闭环才有资格改变它。                                      |
| 迁移联动     | `pnpm docs:migcount:check` 证明 17 份 spec 持有 `CURRENT_MIGRATION_COUNT=129`；另有 7 份历史迁移测试直接锁定当前 129，总计 24 份既有计数联动。                                  |
| 并行状态     | 唯一 open PR #1324 只修改流程文件，与本稿四份文档零交叉；E 档 release 仍须 global 0 open PR，本 E1 文档 lane 只按 lane preflight 推进。                                         |

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

未来单独精确计划，至少包含 policy/version 的 create、list/detail、activate、retire，Human System surface、显式 GLOBAL
读写权限、两条独立审计事件、命令收据、锁后身份复核和真实 HTTP／并发验收。SUPER_ADMIN 也不能绕过权限码；
内建角色零默认授权；查询历史不泄露 actor 个人资料。E1-1 的批准和 grant 不继承到 E1-2。

### 5.3 E1-3：选择与发布冻结

未来单独精确计划。模板、Activity、SessionPosition 采用完整版本引用，最近层级的显式完整引用覆盖上层，不做 JSON 字段合并；
需独立不可变选择 revision、同链复合 FK 和 command receipt。建议新模板 schema V5、新发布提案 V9，仅新稿使用；
V1–V4 模板、V2–V8 提案／快照及其 hash 不回改。批准时冻结最终 policy/version/hash/evaluator 和覆盖来源，
退役或撤权竞态必须锁后重验。只有该闭环完成后，Readiness 才按真实选择消除 `CONTRIBUTION_POLICY_UNREPRESENTABLE`；
仍不接正式贡献结算。

## 6. E1-1 精确候选写集（46 路径）

### 6.1 数据、实现与新增测试（9 路径）

1. `prisma/schema.prisma`
2. `prisma/migrations/<第130条_activity_os_r5_e1_contribution_policy_foundation>/migration.sql`
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

若实际生成器证明某个派生文件零 diff，则不伪造改动；若实现产生本清单外必需路径，必须先上报扩写，不能靠通配授权夹带。
E1-1 不修改 `ContributionRule` 模型／模块、`contribution-calculator.ts`、考勤、账本、settlement、proposal、Readiness、
contract snapshot、客户端、seed、权限或审计目录。

## 7. 验证、签字与授权边界

实施后的本地验证只允许维护者当轮明确批准的隔离库，建议沿用 `app_test_w98`：

1. 先运行定义／状态机单测、lint、typecheck、build 和治理自证。
2. 再在 w98 做第 130 条冷回放、129→130 非空升级、DB 约束／不可变／并发与旧行为 characterization；
   只允许重建测试夹具，不运行 `migrate dev|reset|db push`。
3. `pnpm docs:migcount:check` 必须证明 17 处具名常量全部为 130；另逐行核验 7 份直接当前总数文件，不能用自动替换改历史目标。
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

## 9. 本轮 docs-only 写集与 DoD

本轮只修改四份文档：本稿、`NEXT_TASKS.md`、`FROZEN_DRAFTS.md` 和
`changelog.d/activity-os-r5-e1-contribution-policy-review.md`。DoD 是把 E1 方案、V1 数据合同、三刀边界、
46 路径候选写集、验证和未来授权语句一次列齐；通过 docs 守卫后可提交、推送并创建 Draft PR。

本轮不实施 E1，不修改 schema/migration/TypeScript/测试/派生生成物，不操作数据库，不 Ready、不合并；
不执行 D8-OPS，不部署，不启用任何 Gate，不删除、回填、重分类或重算业务数据。整体跨模型复审、前端发布、
真实业务验收和生产仍未完成。
