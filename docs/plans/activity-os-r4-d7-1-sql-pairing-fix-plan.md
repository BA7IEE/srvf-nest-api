# D7-1 SQL 配对检查修复方案 A · 精确实施与授权清单

> 2026-09-15。维护者已确认方案 A，并允许补充 changelog、提交推送本计划及更新 #1335；**保持 Draft，不合并、不实施**。
> 当前代码基线 main `28d74f3d`；文档分支 HEAD `0890f487`，D7-2 Draft PR #1335；#1324 保留。
> 本稿是独立修复计划，不扩大 D7-2 业务范围，不把诊断原型当作完成实现。

## 1. 问题、证据与选择

人话简报：已有唯一索引没有被慢路径按完整键使用，数据库反复扫描同一批分录，把完整性检查拖到十几秒。推荐等价改写三个关联，让每次查找使用完整键，不减少校验、不提高超时。

[脱敏根因与只读原型证据](https://github.com/BA7IEE/srvf-nest-api/pull/1335#issuecomment-5679018979)：

- w98、8000 根分录、16000 更正分录。慢计划预估根分录1行，实际8000行；冲销与替代两层关联各过滤31996000行。
- 完整性检查13896.640ms，配对CTE占13848.031ms。此为带采样结果；此前无内部计划采样也已复现12秒级语句超时。
- 既有唯一索引 `ptce_manifest_root_type_key(manifestId,rootEntryId,entryTypeCode)` 已存在。
- 原 `paired AS MATERIALIZED` 没有阻止其内部关联退化。统计失准的具体时序尚未证明，不宣称已证明是 generic plan 或自动分析故障。
- 只读 LATERAL 原型在会话禁用 hash join 的条件下，每次冲销/替代查找返回1行；配对CTE52.973ms，总239.975ms。只覆盖关联骨架，不是完整函数验收。

方案 A（确认方向）：追加迁移，等价修正函数的三处关联。风险为 SQL 语义或计划边界改错；以完整正反例、非空升级、低估算回归拦截，失败不发布。
方案 B（不采用）：扩大事务预算或仅先 ANALYZE。前者改变预算，后者不能保证新库及新写入时的稳定性，均不作为本修复。
回退：合并前保留原已合入版本并修正候选；合并后若有问题，另审追加修复迁移。不得回写123或已执行124，不自动执行生产回滚。

## 2. 最终 SQL 合同

新增且仅新增 `20260915170000_activity_os_r4_d7_pairing_index_probe`，基线123条下为第124条；路径排在D7-2候选180000之前。实施前重新核验路径、main迁移顺序，不凭本稿强占已变化序号。

迁移只用 `CREATE OR REPLACE FUNCTION ptc_assert_complete(batch_id TEXT) RETURNS VOID LANGUAGE plpgsql` 替换原函数体：

1. 保留函数签名、返回类型、异常文案/SQLSTATE/约束名。
2. 保留 required、manifest、application、approved_items、数量、正负总额、根同链及所有逐项配对条件。
3. 仅把 reversal、credit、prior 三个 LEFT JOIN 改为 LEFT JOIN LATERAL：在子查询内同时绑定 manifestId、rootEntryId、entryTypeCode，以 OFFSET 0 保留优化边界，ON TRUE。
4. 不用 LIMIT、DISTINCT 或额外聚合吞掉行；依赖原唯一键保证0或1行。保留 LEFT JOIN 的缺失可见性及原 NULL/IS DISTINCT FROM 语义。
5. 保留 approved_items 关联、paired MATERIALIZED、全部字段投影与外层不匹配谓词。不以只读原型的 count(\*) 替代完整检查。
6. 不新增表、字段、索引、触发器或权限；原触发器继续调用同名函数。不增删服务层权限/完整性复核，不改锁序。
7. 旧123份SQL逐份checksum不变；无业务数据改写/回填/删除。

迁移数123→124；模型170、权限265、审计169总计/164活跃、接口与错误码不变。SQL完成后以实际摘要重签3b；4b不预设重签，权限目录若意外变化立即停查，不能沿用旧授权解释新增语义。

## 3. Goal / DoD 与探针队列

目标：在不降低安全、完整性和事务预算的前提下消除已定位的重复扫描慢路径，先完成D7-1独立修复，再回到D7-2。

| 顺序 | 未满足才做的工作                                | 通过证据                                                                          |
| ---- | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| P0   | 核验基线、123份checksum、执行worktree、精确授权 | preflight + git/路径/令牌核验，非 harness:needs 代替令牌                          |
| P1   | 新增函数修复迁移                                | 仅三处关联语义差异；旧SQL零变更；未出现数据操作                                   |
| P2   | 补独立回归测试                                  | 完整函数真实调用；缺项、错额、错前驱、批准项不符、跨链、缺收据、未闭合均仍拒绝    |
| P3   | 123→124非空升级及全量冷回放                     | 非空更正/收据/既有账本升级前后内容一致，约束仍有效、124 checksum全部对应文件      |
| P4   | 冷/失准统计慢路径与满额验收                     | 独立新建测试夹具不依赖先ANALYZE；三完整键点查；原满额3轮及重放全部通过            |
| P5   | 旧测试当前计数与派生文档                        | 22文件只改当前回放123→124，历史122→123等不改；docs检查通过                        |
| P6   | quick + 定向E2E + CI                            | 本地受影响定向通过；经另行提交授权创建Draft后，PR CI全量冷跑；红区审批绑定实际SHA |

新增测试自行建立w98夹具，复用现有安全初始化/清理入口，不修改全局setup。只能重建隔离测试夹具，不删除实际业务数据。若现有辅助接口不足，需要新增写集则先报告。

低估算回归：在隔离夹具建立前的空表统计基线上写入满额数据、紧接执行完整函数，并取脱敏计划；另用仅测试会话的禁用hash join验证三处完整键点查。不能只测试简化查询或只凭SQL字符串断言通过。若自动分析让低估算无法稳定复现，报告证据缺口，不能把正常统计结果算作覆盖。
不得为了制造低估算修改系统目录/全局数据库参数。基线旧函数与新函数的对照只在w98临时测试事务/测试连接中进行，不覆盖正式业务数据。

原 `activity-os-r4-d7-time-correction.e2e-spec.ts` **仅运行，文件不修改**。保留独立负例5秒、提交7秒、prepare120秒及原查询预算/全部断言。采样配置不用于最终无采样验收，满额验证至少两轮独立串行，报告每轮而非只选通过轮。

## 4. 完整精确写集（33个去重路径，未来实施）

本轮实际仅新增本稿。以下是未来整包申请，不是当前可写授权。

1. `prisma/migrations/20260915170000_activity_os_r4_d7_pairing_index_probe/migration.sql`
2. `test/e2e/activity-os-r4-d7-pairing-index-probe.e2e-spec.ts`
3. `test/e2e/activity-os-r1-a3-template-definition-lifecycle-guards.e2e-spec.ts`
4. `test/e2e/activity-os-r1-a4-explicit-template-version-pointer.e2e-spec.ts`
5. `test/e2e/activity-os-r2-b1-place-schema-constraints.e2e-spec.ts`
6. `test/e2e/activity-os-r2-b2-coordinate-projection-schema-constraints.e2e-spec.ts`
7. `test/e2e/activity-os-r2-b3-form-blueprint-governance.e2e-spec.ts`
8. `test/e2e/activity-os-r2-b6-creation-data-foundation.e2e-spec.ts`
9. `test/e2e/activity-os-r3-c1-d2a-metric-command-receipt-migration.e2e-spec.ts`
10. `test/e2e/activity-os-r3-c1-d2b-selection-template-migration.e2e-spec.ts`
11. `test/e2e/activity-os-r3-c1-metric-definition-set.e2e-spec.ts`
12. `test/e2e/activity-os-r3-c2-outcome-value-revision.e2e-spec.ts`
13. `test/e2e/activity-os-r4-d1-1-time-policy-migration.e2e-spec.ts`
14. `test/e2e/activity-os-r4-d1-3-selection-migration.e2e-spec.ts`
15. `test/e2e/activity-os-r4-d3-time-allocation-revision-migration.e2e-spec.ts`
16. `test/e2e/activity-os-r4-d4-time-bucket-migration.e2e-spec.ts`
17. `test/e2e/activity-os-r4-d6-time-ledger-migration.e2e-spec.ts`
18. `test/e2e/activity-os-r4-d7-time-correction-migration.e2e-spec.ts`
19. `test/e2e/activity-v11-batch4-allocation-candidate-position-anchor-migration.e2e-spec.ts`
20. `test/e2e/activity-v11-batch4-allocation-command-replay-migration.e2e-spec.ts`
21. `test/e2e/activity-v11-batch4-allocation-determinism-migration.e2e-spec.ts`
22. `test/e2e/activity-v11-batch4-allocation-mode-migration.e2e-spec.ts`
23. `test/e2e/activity-v11-batch4-qualification-contract-migration.e2e-spec.ts`
24. `test/e2e/insurance-evidence-registration-revision-migration.e2e-spec.ts`
25. `CODEMAP.md`
26. `docs/current-state.md`
27. `prisma/CLAUDE.md`
28. `docs/ai-harness/CUTOVER_SIGNOFF.md`
29. `docs/ai-harness/NEXT_TASKS.md`
30. `docs/plans/activity-os-r4-d7-2-fact-correction-review-and-plan.md`
31. `docs/plans/activity-os-r4-d7-1-sql-pairing-fix-plan.md`
32. `changelog.d/activity-os-r4-d7-1-sql-pairing-fix.md`
33. `docs/handoff/README.md`

范围说明：

- 第1项仅函数替换；第2项新增完整函数、非空升级、低估算及负例回归。
- 第3–24项经当前计数常量/回放断言引用核验，仅当前123→124及对应标题。D7-1的names[122]与122→123历史checksum长度123保持；其afterAll恢复current按现有逻辑执行。禁止全文替换123。
- CODEMAP只生成刷新；current-state只由docs:counts刷新计数。
- prisma/CLAUDE仅更正当前摘要及修复状态，保留历史；CUTOVER_SIGNOFF仅在维护者实际确认后登记3b实际摘要。
- NEXT_TASKS只登记独立修复的实际阶段，不把D7-1 main回归提前写成已解决；不改变其他业务轴。
- D7-2计划仅补本修复前置并更正“未来124”为125，当前基线/历史123不机械替换，124路径数量不改。
- handoff/README仅补内部SQL性能修复与部署边界说明，不更改接口合同或生成客户端。
- 新增changelog及本稿只记实际交付/验证。未获实施批准前不改这些未来路径。
- 不列入schema、seed、权限目录、domain/state-machine登记、客户端生成物、ROUTE_AUTHZ或门禁脚本；如检查要求其变化，先查明原因并报告，禁止顺手扩大。

## 5. 精确授权与实施顺序

静态逐路径核验：33个路径中1红区、32非红区。needs不发放令牌。以下命令**只供未来整包实施确认后由维护者执行，本轮不要执行**：

```bash
cd /Users/dengwang/Documents/coding/srvf-nest-api
pnpm harness:grant 'prisma/migrations/20260915170000_activity_os_r4_d7_pairing_index_probe/migration.sql' --reason "确认 D7-1 SQL 修复方案 A；按精确计划第2–5节及33路径实施"
```

若执行worktree变化，先提供真实路径并在那里重新核验授权；不得复用另一worktree令牌。AI不得自行grant。禁止自动prisma migrate dev/reset/db push。

实施批准应一次包含：33路径、w98隔离测试与夹具重建、新迁移验证、22份旧测试的当前计数适配、派生摘要及交接说明。仅诊断授权不覆盖安装修复迁移。提交/推送/创建Draft需明确授权；Ready、合并、生产、Gate均不随之授权。3b在候选SQL完成后单独核对真实摘要签字，不能提前编造。

现有#1335是D7-2文档PR，不混入本SQL修复实现；#1324不动。后续实现分支需从经核验main建立，先核对在飞写集，串行集成。本稿当前不自行开新PR。

## 6. 验证与停止条件

本轮文档：preflight、逐路径needs、路径存在性/去重、Prettier、git diff --check；不运行DB或业务测试。
未来实现：agent:check:quick；按测试帮助器核验worker为app_test_w98后串行跑新回归、原D7-1满额、D7-1迁移及22份计数相关定向测试；全量以PR CI冷跑为准，不用默认globalSetup触碰app_test或其他worker库。
所有数据库重建需先验库名、连接、派生worker规则；精确运行命令在实施时按实际配置生成，不复用带诊断采样的临时配置充当正常验收。

停止条件：语义不等价、任何既有断言失败、实际SQL需改出函数之外、已有迁移路径冲突、生成物超出33路径、非w98库或需全局配置、连续两轮修复仍未通过。保留证据并上报，不自行放宽。

## 7. 本次未做

未创建/执行migration，未修改业务代码/测试/数据库，未登记3b，未Ready/合并，未实施D7-2，未操作生产、启用Gate或删除业务数据。文档提交授权已获准，实际提交与CI结果以 #1335 当前SHA为准；方案方向获准不代表本稿33路径已获实施授权。
