# Release 5 后端续推（2026-10-18）

基点：PR1380 / `906c78d0b8e834d35303c697d6d127124379918b`，main 为 `5c296d62`。
本次任务由维护者“帮我继续推进”继续既有后端目标。当前挂载工作区起初在 main 且 clean；
这不证明原任务工作区没有未提交内容。仅在 srvf-nest-api 云环境执行。

## 终态与探针队列

1. 在真实 PostgreSQL 复现或排除 correction source hash 的 NULL 疑点，区分约束语义与完整写链。
2. 新增 preparing/pending 的 API 与实际 worker 进程重启恢复证据；同一批次只能入账一次。
3. 新增真实 native guard 成功后，实际授权 callback 拒绝时的事务回滚证据。
4. 对137–147逐份核对完整SQL及摘要，记录技术审查发现；不替维护者签3b、不只改计数。
5. 最终候选执行相应检查并推送同一Draft PR；CI按实际SHA记录。原最大规模独立记未验收。

实现写集：147唯一新migration；30份E2E及1份prefix单测的当前迁移计数；
`test/helpers/e4-migration-prefix{,.spec}.ts`、`activity-contribution-policy.fixture.ts`、
新增`activity-r5-correction-hash.fixture.ts`；新增正式147回归、active matrix及worker child；
历史146部署入口与对应生命周期单测；必要CODEMAP、current-state、prisma说明、changelog及本轮证据。
本轮开发测试使用本checkout的`app_test`模板及`app_test_w1`一次性worker，按标准globalSetup
迁移、克隆与teardown回收，不触生产或其他工作区；无新500或原满额手动性能实验。
禁止域：前端、生产、默认开关、既有迁移字节、guard/预算放宽、既有业务断言放宽、
Trusted/3b代签、Ready/合并/部署。

## 当前证据

- pnpm 10.14.0 frozen安装与Prisma 6.19.3生成成功；未修改依赖或锁文件。
- `pnpm agent:preflight --lane r5-continuation`退出0；唯一open PR为本任务1380，落后main为0。
- 现有受限500证据仍仅覆盖其原SHA，不倒签本次修改；原满额未验收。
- NULL疑点现已在PG16完整更正prepare事务复现：只在测试写者处注入NULL，真实事务提交后
  `e4_assert_complete(root.id)`仍通过。普通应用写者保持正确hash；不据此宣称外部接口可直接触发。
- 候选147新增validated CHECK后，同样NULL注入被具名约束拒绝，196表完整指纹相等；
  有效V3实际返回applied/committed，独立查询批次committedAt一致、4条分录，重放通过。
- 已有NULL行时执行同一候选得到23514，新约束未留下，196表指纹相等；不自动清理历史行。
- preparing/pending新增测试通过：独立worker进程reserve后退出，API重启，另一个PID的实际
  worker领取同一个job/item，原批次committed、2条分录；重放不改变分录、日状态、通知及贡献证明。
- guard后授权callback新增测试通过：实际first-review native guard已执行成功，callback看到
  事务内真实UPDATE、独立连接仍见旧版本后拒绝；外层事务结束后196张表逐表及根指纹完全恢复。
- 首次重启测试child启动失败，原stderr未保留，具体错误UNKNOWN；改用已有生产完整
  `NotificationOutboxWorkerModule`入口并严格选择活动worker provider后通过，不改生产代码。
- 147上的完整active matrix 6/6通过（89.49秒）；正式147升级/回滚/V3 1项及固定历史146升级1项通过。
- quick两轮均因cached lint堆OOM退出1；第二轮typecheck、461套/10,266单元/8快照及Harness退出0，保留5个todo。
  不把wrapper说成通过；停止cached入口后，正式pnpm lint在原300秒/6144MiB内覆盖2015文件，0诊断、139.115秒通过。
- counts/readtax/authz/codemap/migcount及3b机器核对通过。元数据快照和失败历史见[本轮机器回执](activity-os-r5-continuation-evidence-20261018.json)。
- 新SHA CI以推送后PR checks为准；本记录为推送前验证，不用旧906回执倒签。

## 137–147 SQL技术审查（非维护者3b签字）

原十份完整SQL与[既有摘要目录](activity-os-r5-limited-ci-migrations-137-146.json)逐份重新计算SHA256
和字节数，全部吻合；main中1–136及migration_lock的git树条目逐字未变。
以下是本次Codex技术审阅的检查面与结论，不冒称人类最终审核或跨模型互查。

| 版本                                                                                                              | 实际变更与审查重点                                                                                                                    | 结论／限制                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [137](../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql)                      | 两张不可变贡献表、legacy默认、复合锚点、statement/deferred守卫、来源／评价／账本完整集合、unchanged-time有效基及ptcm_guard_insert接线 | 确认correctionSourceSetHash的CHECK三值逻辑与MATCH SIMPLE可同时跳过NULL；完整写链复现，修正前阻断验收                                             |
| [138](../../prisma/migrations/20261012000000_activity_canonical_json_scalar_fast_path/migration.sql)              | astr_canonical_json标量直出；对象C排序、数组ordinal与递归回退                                                                         | 标量输出保持原ELSE；SQL NULL的STRICT与JSON null区别保留                                                                                          |
| [139](../../prisma/migrations/20261012010000_activity_contribution_reference_canonical_fast_path/migration.sql)   | 仅闭集9字段source reference的规范文本直出                                                                                             | 逐项核对键顺序与JSON渲染；missing/extra/nested仍回退，V3 correctionSource走回退                                                                  |
| [140](../../prisma/migrations/20261012020000_activity_contribution_evaluation_canonical_fast_path/migration.sql)  | 评价unit、envelope hash、metadata标量三处等价替换                                                                                     | 与139全文diff核对：nullable SQL标量coalesce为JSON null，SHA256 envelope与容器回退保留                                                            |
| [141](../../prisma/migrations/20261012030000_activity_time_bucket_canonical_fast_path/migration.sql)              | bucket hash内按bucketId关联来源的LATERAL聚合                                                                                          | revision过滤、来源排序、空数组和adjustmentReason完整规范化保留                                                                                   |
| [142](../../prisma/migrations/20261012040000_activity_canonical_json_unit_fast_path/migration.sql)                | canonicalizer对闭集9字段unit快路                                                                                                      | 全部键／无额外键／无容器条件保留；未知形状继续原递归                                                                                             |
| [143](../../prisma/migrations/20261013000000_activity_contribution_assert_source_reuse/migration.sql)             | e4_assert_complete单次调用内来源复用                                                                                                  | 核对source-invalid优先、FULL JOIN/IS DISTINCT FROM、完整evaluation文档、root/hash/total、独立statement和deferred调用；不把一次调用当其他调用证明 |
| [144](../../prisma/migrations/20261015000000_activity_contribution_source_bucket_lateral/migration.sql)           | e4_source_rows的bucket-only LATERAL/OFFSET 0                                                                                          | 外层activity/revision/identity锚、UNION ALL重复度、原分秒权重及D7分支保留；不宣称原最大规模通过                                                  |
| [145](../../prisma/migrations/20261015010000_activity_contribution_evaluation_join_key/migration.sql)             | 完整validator从metadata携带已有evaluationUnitKey                                                                                      | 与143全文diff仅expected_documents增加key及下游取同一key；FULL JOIN与文档比较保留                                                                 |
| [146](../../prisma/migrations/20261015221000_activity_contribution_policy_band_planning/migration.sql)            | policy_bands改NOT MATERIALIZED                                                                                                        | 与145全文diff除注释仅这一物化选择；函数正文pin40b56bac5a571c56e589cbc549419bfa仍适用，不能由小规模推出满额性能                                   |
| [147](../../prisma/migrations/20261018000000_activity_contribution_correction_source_hash_required/migration.sql) | 新增validated CHECK，要求更正来源hash非NULL                                                                                           | 真实非空146→147及no-op、NULL整笔回滚、有效V3/4分录/重放通过；既有NULL行会拒绝升级，生产未执行                                                    |

未发现这些增量中的角色／ACL授予或SECURITY DEFINER切换。137涉及新表、索引、约束和触发器；
138–146仅替换既有函数。147仅新增具名validated CHECK，补齐137的NULL不变量；正式非空升级/回滚/有效V3回归已通过。
137–147完整SQL的最终摘要见[11份SQL目录](activity-os-r5-migrations-137-147.json)。
维护者本轮明确回复“我已审阅并认可3b，授权据此登记137–147”；据此在CUTOVER_SIGNOFF追加3b正式记录，
对拍更新147，保留全部旧签字与完整SQL摘要，不将旧签字套到新SQL。新3b不包含Trusted或发布授权。

## 147已授权落地与剩余决策

147已按[冻结候选](activity-os-r5-source-hash-required.proposed.sql)追加具名CHECK：
`sourceKindCode='correction_time_proof'`时要求`correctionSourceSetHash IS NOT NULL`。
原shape regex负责格式，原复合FK负责精确proof/hash锚；draft/submitted/unchanged-time保留合法NULL。
无需替换validator、修改既有SQL或服务中的函数正文pin，也无需Prisma schema／权限／契约变化。
候选完整SHA256：`2c68710f16c74577e39002ca078a59835e4cc819407b93dcb6188d96dc1c7d2c`。

风险：ALTER TABLE验证既有行并需要表锁；已有NULL脏行会使升级整体拒绝，必须先人工处置，
本迁移无自动回填／删除。生产执行仍为NOT_RUN；如实际目标出现NULL脏行，应停下人工处置，不自动修数据。

实际路径：`prisma/migrations/20261018000000_activity_contribution_correction_source_hash_required/migration.sql`。
维护者本轮明确回复“按候选实施，委托执行该精确grant”。正常CLI的reason记录“用户明确授权、AI代执行”，
唯一新路径grant已正常clear；实际SQL与获批候选SHA逐字相同，无自主授权或手改令牌。
30处E2E加1处prefix单测固定当前计数已同步147；`docs:migcount:check`已核31处一致。
历史升级目标保持不变：145→146现使用新的固定146部署入口；补充metadata快照前在同一短事务
加载PL/pgSQL，仍比较全量pg_settings、不滤任何设置。PG16独立会话实测初载前0个plpgsql.\*、
载入后5个；原失败正缺这5项。修正后历史145→146非空升级、全部目录／业务行／设置不变与no-op通过。
所有旧断言的期望、预算、完整比较与冻结oracle保留。

正式147回归用固定146非空事实作为基线，实际执行最新migration deploy至147；业务196表与函数目录
完全不变、再次deploy无动作；精确迁移checksum通过。NULL写者被新具名约束拒绝，196表回滚；
正常V3返回applied/committed、批次committedAt与返回一致、4分录、重放通过。该结果不是生产部署。

依AGENTS.md与CUTOVER_SIGNOFF，grant不代替3b、Trusted、Ready、合并或部署。
实际目标旧数据盘点、转换/shadow适用性、fleet、worker排空、稳定观察与生产切换均NOT_RUN。
原满额仍未验收，受限500与小夹具生命周期证据分开。前端本轮未处理。

## 收口验证补充

权限生成器只摘要非spec的业务TS及契约，迁移不在输入中；首次stale时未保存摘要，根因UNKNOWN。
正常生成后ROUTE_AUTHZ与原HEAD逐字一致，断言配置亦一致，663声明不变；相关精确grant已clear。
文档全文件格式化曾因表格空格推高readtax，已恢复原格式并保留本轮事实更新、正式重生成counts；
current-state为9479字符，低于9600原预算，未改预算或删既有事实。

## 本次未做

未修改1–146或代签3b/Trusted；未改schema/seed/权限/函数/ACL/业务预算；
未启用生产开关、Ready、合并、部署、盘点或转换实际旧数据，未补跑原最大规模。
