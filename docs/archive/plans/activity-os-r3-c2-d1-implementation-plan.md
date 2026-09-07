# C2 D1 实施清单草稿

基点：main d3675c93；#1287 已合入，main CI 34074014865 通过。本文件为已获路径授权的实施计划草稿，非实施授权。

## 已确认的决策

C2 方案 A 已批准：D1 数据地基；D2 人工草稿/修订另行实施；confirmed/system/AI 归 C3，import 独立立项。

维护者已确认解析职责更正：C1 负责指标定义与配置，C2 新增成果值校验，复用既有 canonical/hash 工具。原评审第 114 行的“C1 五类值解析”不能作为现有能力使用；历史冻结稿保留，在本计划及当前台账登记订正。

## 交付与边界

新增 ActivityOutcomeRevision、ActivityMetricValueRevision、ActivityMetricValueEvidence 三个模型及一条 additive migration。建立活动、成果修订、指标集及指标项的同链约束、唯一约束与不可变内容保护；保留前序修订，禁止原地改值。迁移文件名在正式开工时确定，不预占编号。

新增纯函数成果值校验与对应单元测试。调用 parseActivityMetricDefinition 校验配置，按类型检查实际值；小数使用规范字符串和整数缩放比较，不用浮点。复用 fingerprintMetricEnvelope，成果值采用独立 domain，校验后才计算 hash。短文本数据形状测试不代表开放敏感信息采集。

不接 HTTP、DTO、writer、权限、审计事件、seed、附件 owner、Readiness 或 Gate。D1 表结构不等于成果可用；confirmed 的跨行证据完整性仍由 C3 确认事务负责。

## 实施候选路径

### 已核验的数据库接缝

ActivityMetricSetVersion 已有 (id, definitionHash) 唯一键，ActivityMetricSetItem 已有 (setVersionId, metricDefinitionId) 唯一键，成果侧可以引用既有锚点，无需为了该引用改变 C1 业务列。

**2026-09-07 已确认的附件验收分层**：Attachment.ownerType/ownerId 当前是多态归属，仅有普通索引，没有可供成果侧复合外键引用的唯一锚点。附件 id 的 Restrict 外键只能证明附件存在、限制物理删除，不能证明附件归属本 Activity。原 C2 评审 §6.2 的跨活动附件验收按维护者本次确认分层，历史冻结稿保留。

维护者确认：“D1 验证成果同链与附件存在；D2 在事务内验证活动归属。”D1 数据库测试覆盖成果头/值/证据同链、附件不存在时拒绝、引用后物理删除受限；D2 在 Activity 根锁与附件 trusted facade 下验证跨活动附件拒绝及事务回滚。该验收责任延至 D2，未取消；D2 验证通过前不得声称成果证据归属已闭环。此确认不授权修改附件 schema、启用成果 writer 或执行数据库操作。

- prisma/schema.prisma：三个模型及必要反向 relation；既有 C1 业务字段与行为不变。
- prisma/migrations/（正式开工时确定的单个新目录）/migration.sql。
- prisma/CLAUDE.md：仅当前 migration 摘要。
- src/modules/activities/activity-outcome-value.ts（新）。
- src/modules/activities/activity-outcome-value.spec.ts（新）。
- test/e2e/activity-os-r3-c2-outcome-value-revision.e2e-spec.ts（新）。
- src/modules/activities/CLAUDE.md：模块当前事实。
- harness/domain-map.json、harness/state-machines.json：仅实际新增模型及状态登记。
- docs/current-state.md：仅 docs:counts 生成计数块。
- CODEMAP.md：仓库根目录文件，由 scripts/generate-codemap.ts 生成；不是 docs/CODEMAP.md。
- docs/ai-harness/STATE_MACHINE_INVENTORY.md：仅当前 §10 实际计数联动。该文件是治理报告，不是自动再生产物；§0–§9 历史取证正文不改。
- docs/ai-harness/FROZEN_DRAFTS.md、docs/ai-harness/NEXT_TASKS.md：C2 当前状态及解析职责订正。
- changelog.d/activity-os-r3-c2-d1-outcome-value.md（新）。

以上仍须核验生成器实际输出与模块下级规则，不能作为最终通配写授权。C1 解析器本体不在修改范围。

## 已核验的迁移计数联动

pnpm docs:migcount:check 扫描 393 份测试文件，确认实际 112 条 migration 与下列 15 处声明一致。新增一条 migration 后只同步 CURRENT_MIGRATION_COUNT 和直接描述当前总数的测试标题，不改变历史升级基点或行为断言：

1. test/e2e/activity-os-r1-a3-template-definition-lifecycle-guards.e2e-spec.ts
2. test/e2e/activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts
3. test/e2e/activity-os-r2-b1-place-schema-constraints.e2e-spec.ts
4. test/e2e/activity-os-r2-b2-coordinate-projection-schema-constraints.e2e-spec.ts
5. test/e2e/activity-os-r2-b3-form-blueprint-governance.e2e-spec.ts
6. test/e2e/activity-os-r2-b6-creation-data-foundation.e2e-spec.ts
7. test/e2e/activity-os-r3-c1-d2a-metric-command-receipt-migration.e2e-spec.ts
8. test/e2e/activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts
9. test/e2e/activity-os-r3-c1-metric-definition-set.e2e-spec.ts
10. test/e2e/activity-v11-batch4-allocation-candidate-position-anchor-migration.e2e-spec.ts
11. test/e2e/activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts
12. test/e2e/activity-v11-batch4-allocation-determinism-migration.e2e-spec.ts
13. test/e2e/activity-v11-batch4-allocation-mode-migration.e2e-spec.ts
14. test/e2e/activity-v11-batch4-qualification-contract-migration.e2e-spec.ts
15. test/e2e/insurance-evidence-registration-revision-migration.e2e-spec.ts

## 验收计划

单元验证整数边界、小数精度、布尔、选项、文本形状、未知字段、配置/hash 漂移和确定性。数据库测试验证重复修订/指标、跨活动 prior、跨集项、错误 hash、非法状态及不可变内容拒绝；有效同链记录可写作为正对照。

附件验收按已确认分层执行：D1 验证成果同链和附件存在性约束，D2 验证事务内活动归属；不得用 D1 的存在性测试代替 D2 的归属测试。

迁移验证须覆盖空库重放与非空旧库升级，不以 SQL 字符串检查代替 PostgreSQL 真实约束。建议独立批准 app_test 的 migrate deploy 核验以及 app_test_w1、app_test_w98 的隔离测试生命周期；正式执行前确认无其他作业占用。不得自动 migrate dev/reset/db push。

运行迁移计数、派生文档、lint、typecheck、单元和定向数据库测试；依赖枢纽受影响时按仓库规则扩大验证。C1/B5/B6/B7 兼容回归保持旧断言。最终提交进入 PR CI，3b 按实际新计数重签，合并和生产分别确认。

## 本次未做

仅新增本计划草稿；未实施代码、创建 migration、连接测试库、提交推送或创建新 PR；未改变 Gate。
