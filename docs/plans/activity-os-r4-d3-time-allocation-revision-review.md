# Activity OS Release 4 / D3：时长分配修订评审与授权清单

> **当前阶段（2026-09-12）**：D3 已随 [#1323](https://github.com/BA7IEE/srvf-nest-api/pull/1323) 合入 main `921a6bf3fac66067e5232768d5c5d32bf92765fc`；批准 HEAD 为 `c3a969a22b4f59b2e2ca51a46660c04d10d53b41`，18 项 PR 检查及可信审批通过，[合并后 main CI](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34677507039) 在该合并 SHA 上 completed/success。仓内基线为 161 模型／120 migration／625 端点／263 权限／168 审计总计（163 活跃），3b/4b 已重签；零内建角色默认授码。维护者本轮只授权 D3 台账更正及 D4 [评审](../plans/activity-os-r4-d4-time-bucket-settlement-workbench-review.md)／[精确计划](../plans/activity-os-r4-d4-time-bucket-settlement-workbench-implementation-plan.md)合并起草、验证后提交推送并创建 docs-only PR；D4 方案和实施仍待确认。本轮不合并、不实施、不操作数据库、不启用 Gate；整体跨模型复审、前端发布与生产验收尚未完成。下方较早阶段描述保留为历史，以本条为当前状态。

## 1. 人话简报与推荐

D1 已回答“某个活动、场次或岗位应适用哪一版时长政策”，D2 已给出“当前参与事实是什么”。D3 要补的是两者之间可追溯的认定层：把一个已闭合、当前的参与段按已冻结的政策解释为分类时长，并把自动计算或人工调整保存在不可变 revision 链中。

推荐方案 A：D3 建立独立的、以源服务段和冻结政策为锚的 allocation revision 合同。每次认定产生完整新 revision；其内分类区间必须位于源参与段内、互不重叠且总量不超过源段。自动结果与人工调整均保留来源、政策版本、理由和必要证据，但 D3 不写正式账本、证明、旧 `serviceHours` 或既有结算。

不做 D3，D4 以后只能临时从段、政策和旧时长各自推算，无法回答“哪一版政策在何时把哪段时间认定为何类别”。做错 D3 的最大风险是把旧 `serviceHours` 或贡献分数当作新时长真相，或者允许已变更的政策回写历史认定；两种情况都会污染后续账本与证明。回退只能停止新 D3 调用，保留不可变候选／修订历史，不能删除业务数据。

## 2. 已核验依据

| 依据 | 当前事实 | D3 必须遵守的结论 |
| --- | --- | --- |
| [T0 合同 §7.1](../archive/reviews/activity-os-t0-terminal-review.md#71-单一参与事实与-timepolicy) | `AttendancePunchEvent → ParticipantServiceSegmentRevision` 是唯一参与段事实；`ParticipantTimeAllocationRevision` 属认定层。 | D3 消费段，绝不新建或双写第二套参与事实。 |
| [T0 Release 4 顺序](../archive/reviews/activity-os-t0-terminal-review.md#11-release-1-至-7-的最终-pr-边界) | D3 位于 D1 TimePolicy、D2 Facade 之后，D4 Bucket/工作台与 D5 shadow 之前。 | 本批不偷跑工作台、对账、账本、更正、证明或切换。 |
| `src/modules/attendances/participation-segment.facade.ts` | D2 仅返回活动当前非 `superseded` 服务段，并带 identity、场次、历史 check-in 岗位、来源锚、结果态、时间区间和 flags；调用方自带 tx 与锁。 | D3 只从 Facade 读段，写命令在锁后重读，不能深引考勤私有 writer 或读取 `serviceHours`。 |
| `prisma/schema.prisma:5905-5961` | 服务段数据库只保证同 identity/segmentKey 的 current 点唯一，不保证时间区间天然不重叠。 | allocation 的区间关系和总量必须由 D3 事务内校验；不能把现有 partial unique 误说成全局时段保护。 |
| `src/modules/activities/activity-time-policy-definition.ts` | 已冻结定义含四分类、`allowSplit`、特殊区间、向下取整、证据与人工调整开关。 | D3 只能解释已验证的 definition/hash/evaluator，不自行发明类别或绕过人工调整条件。 |
| `ActivityTimePolicySelectionRevision` / Item | 活动当前选择是不可变 revision，指针锚定 policy/version/definitionHash；发布快照另固定已发布解释。 | D3 必须记录实际消费的选择 revision 与 policy version/hash；不得拿现行目录默认值重算历史。 |
| `AttendanceAccessService.lockActivityForAttendanceWrite` 与 D1 选择写链 | 既有写链均以活动聚合锁序列化，并在锁后复验当前资格／引用。 | D3 不能先读段再晚取锁；具体锁序、超时和重读范围必须在精确计划中实测定案。 |

## 3. 方案 A 的认定合同

### 3.1 事实、版本与来源

1. allocation 以 D2 返回的当前服务段 revision 为唯一输入锚，同时记录活动、参与身份、场次、历史 sourcePosition、源段 ID／revision、时间政策选择 revision、policy/version/definitionHash/evaluatorVersion。
2. 每次创建、重算或人工调整都追加完整 revision；已存在 revision、源段和政策引用都不可原地修改或删除。D3 不把“当前”存在可变列或缓存中。
3. 只有已闭合、可解释且未被 D2 判为错误链的段才可进入自动认定。`voided`、开放段、无法解释的 `replaced`／`early_departure_zero` 形态如何处置必须在精确计划中逐态写明并以失败探针约束，不能静默当零或有效时长。
4. `legacy_unclassified` 只属于历史治理口径，不能在 D3 伪装为可开具志愿服务证明的正式分类。贡献分数、成果、旧结算和 legacy `serviceHours` 均不得充当输入或兜底。

### 3.2 分配不变量

1. 每一分类片段采用 `[start, end)` 时间区间，必须完全落在源段 `[checkInAt, checkOutAt)` 内；无效或零长区间拒绝。
2. 同一 allocation revision 的分类片段不能重叠；所有片段的总秒数不得超过源段实际秒数。是否允许多片及何时可拆分，严格遵从该版本的 `allowSplit`，不以 UI 便利覆盖政策。
3. 分类仅允许 `volunteer_service`、`training`、`organization`、`non_creditable` 四态；特殊区间与证据要求按已经冻结的 TimePolicy definition 解析。D3 只校验并保存精确原始区间，向下取整只在后续 D4 对同参与身份/类别聚合后执行，不能逐片截断后凭空损失或增加时长。
4. 自动值与人工值不同时，人工路径必须受 policy 的 `manualAdjustment`、理由必填和证据要求约束；AI 最多产生候选，绝不能直接产生正式 allocation revision。
5. 同一源段、活动、身份或政策在锁内变化时，整笔命令回滚；不得返回部分 allocation、半条收据或半份审计。

### 3.3 访问、事务与后续边界

1. D3 首先提供内部 application command；D4 才讨论人工工作台／HTTP。D3 不先占 Admin、App、Integration 或 AI 对外访问面，也不假设现有时长目录 read/select 码天然等于认定权限。
2. 未来写命令须先取得既有活动聚合锁，再重读当前调用人资格、责任、活动状态、D2 当前段、当前选择 revision 与被引用 policy/version；任何一步失效都拒绝。
3. D3 需要独立幂等收据和最小审计，但具体权限码、AuditLogEvent、错误码、DTO、路由、模块归属与模型名均留给下一份精确计划，不能借本评审稿抢占号码或写入 schema。
4. D4 Bucket／工作台、D5 shadow 对账、D6 Time Ledger、D7 reversal/correction、D8 proof/cutover 各自独立立项。D3 不让新结果进入正式结算、贡献、证明、画像或旧考勤读面。

## 4. 方案比较

| 方案 | 内容 | 判断 |
| --- | --- | --- |
| A（推荐） | 独立不可变 allocation revision 合同；显式锚定源段与冻结政策；D3 只做认定层，D4–D8 串行后置。 | 满足 T0 的可追溯、不可回写与分层要求；代价是 D 档 schema/事务/测试工作，必须另出精确计划。 |
| B | 直接改写服务段 `serviceHours` 或借旧结算行保存分类。 | 拒绝：把参与事实、认定与旧兼容投影混在一起，无法保留 policy 与人工调整历史。 |
| C | 只做纯计算函数，不持久化 revision。 | 拒绝：不能回答历史认定依据，也无法为后续 shadow、ledger 与 correction 提供稳定锚。 |

## 5. 已由精确计划收敛的问题

1. allocation 的数据库形状：一个 source segment 的完整 revision 与其多个分类片段如何建模、唯一性／复合外键／append-only guard／deferred total 校验分别由数据库还是服务层承担。
2. 自动认定的逐态输入矩阵：`valid`、`early_departure_zero`、`voided`、`replaced`、开放段、replace/correction 来源锚和 policy special interval 的合法／拒绝／待人工处理结论。
3. 具体锁序与并发对拍：Activity、服务段 current、选择 revision、policy/version、身份／责任与未来 allocation revision 的排序、锁后重读和超时预算；不得只画单链图而缺反向交错。
4. 人工认定权限、组织范围、审计事件、收据 operation、错误码、最小安全 DTO 与是否在 D3 暂不开放 HTTP。上述每一项都必须从当前权威码表与访问面取证，不能复用 D1/D2 的授权令牌。
5. 迁移策略、旧 migration replay、隔离测试库、3b/4b 签字、受保护路径和派生文档的精确写集。D3 预期为 D 档，当前不授权任何 schema 或测试库动作。

上述五项已在 [精确实施计划](activity-os-r4-d3-time-allocation-revision-implementation-plan.md) 中分别固定并在当前工作树兑现为四表合同、逐态矩阵、固定锁序、独立权限／收据／审计和第 120 条 migration。隔离 E2E、定向单测、typecheck、build、contract 与 lint 已通过；Harness inventory 已按补充授权完成；本地结果不替代签字、可信审批、PR CI 或 main CI。

## 6. 实施验收探针（当前分支已定向执行）

- 源段同链、当前语义、开放／作废／替换／早退零值和跨活动／成员／场次错配逐项 fail-closed；D3 不读取或写入 `serviceHours`。
- 自动 policy 解释、special interval、rounding、`allowSplit`、类别闭集、片段互斥与总量上限各有独立正反向探针；不得把多个不变量塞进一个首错即停断言。
- 同键同 payload 重放、异 payload 冲突、活动锁并发、政策退役／选择变更／段重建／资格撤回交错均无半写，并保留历史 revision。
- 旧考勤、结算、贡献、成果、证明、D1 选择和 D2 Facade 回归不变；D3 阶段不产生外部 contract、客户端、Gate 或生产行为漂移。
- 当前分支已完成 migration 冷回放、隔离 PostgreSQL E2E 和定向回归；3b/4b 已按维护者确认重签并通过对拍。可信红区审批、PR CI 与合并后 main CI 仍须分别完成，定向结果不能替代它们。

## 7. 本次写集与后续授权

D3 在 #1323 按维护者确认写集实现 schema／migration、内部 command、权限／审计／错误码、附件删除保护、D2 窄桥和测试。验证及一次测试初始化范围偏差详见[实施计划 §9.1](activity-os-r4-d3-time-allocation-revision-implementation-plan.md#91-本地补验证据2026-09-12)，不将偏差抹成“全部只在获批库执行”。D3 没有新增外部接口、DTO、客户端、Gate、生产操作或业务数据删除；`prisma/seed.ts` 仅纳入新码 seed 闭包，未改变内建角色默认授权。本轮只是台账更正及 D4 候选文档起草，没有实施 D4。

方案 A 与原 implementation、seed、inventory 精确扩展均已确认；两份 Harness 登记及 3b/4b 重签已完成，#1323 已创建。维护者 2026-09-12 已批准五份旧 E2E 精确适配及计划、台账、changelog 更新，仅在 app_test_w98 串行验证，保留历史升级与业务断言，不改生产代码或门禁；验证后提交推送更新 #1323，检查通过后允许 Ready。可信审批仍须维护者完成，不合并、不操作生产、不启用 Gate、不删除业务数据。逐路径边界见实施计划 §8。
