# Activity OS Release 4 / D2：中性参与服务段 Facade 评审与授权清单

> **评审与计划均已合并，实施已获授权（2026-09-11）**：本稿已随 [#1317](https://github.com/BA7IEE/srvf-nest-api/pull/1317) 合入；后续 [D2 精确实施计划](activity-os-r4-d2-participation-segment-facade-implementation-plan.md) 已随 [#1318](https://github.com/BA7IEE/srvf-nest-api/pull/1318) squash 合入 main `c2a687bf2e9e81d1199329021f06abca40d8f8aa`，合并后 [main CI 34597888732](https://github.com/BA7IEE/srvf-nest-api/actions/runs/34597888732) completed/success。维护者已按该计划的 10 个精确路径授权 implementation；代码与本地隔离验证已完成，并已创建 [implementation PR #1319](https://github.com/BA7IEE/srvf-nest-api/pull/1319)。两份受保护派生治理文件已获单独授权并仅刷新 inputDigest；当前 PR CI 运行中，D2 仍未合入、未部署或启用 Gate。

> **评审形成时的基点**：2026-09-11，main `60414050b99fe661afbf0c87669597ad081a3b43`。本稿当时只起草 D2 的方向、边界和后续授权清单；不实施、不操作数据库、不启用 Gate、不删除业务数据、不提交推送或创建 PR。文中“推荐”是待维护者确认的方案，不是现有新能力。

## 1. 人话简报与推荐

D1 已把“某活动应按哪一版时长政策解释”固定下来；D2 要补的是另一半事实：给后续 D3 分配、D4 工作台和 D5 对账一条稳定的、只读的“这个参与身份当前有哪些服务段”读取边界。

推荐方案 A：以现有 `ParticipantServiceSegmentRevision` 为唯一事实源，在考勤所属边界提供一个内部、显式传入事务的 `ParticipationSegmentFacade`（名称为本稿暂称）。它只返回当前有效修订及其来源锚；不创建第二张 ParticipationSegment 表，不重投影、不写入、不计算分类时长，也不改变现有结算和证明。

不做 D2，后续时间分配会继续各自直查服务段表，容易把已 superseded 的旧修订、`serviceHours` 投影或不同活动身份混成输入。做错 D2 的最大风险是新增一条长期双写链，导致同一人同一活动出现两份参与事实；回退只能停止新 facade 的使用并保留原始修订历史，不能删改业务数据。

## 2. 已核验依据

| 依据                                                                                                       | 当前事实                                                                                              | D2 必须遵守的结论                                                                    |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [T0 冻结合同 §7.1](../archive/reviews/activity-os-t0-terminal-review.md#71-单一参与事实与-timepolicy)      | `AttendancePunchEvent → ParticipantServiceSegmentRevision` 是唯一参与段事实。                         | 先建中性 facade，再让政策消费；禁止长期双写第二套 ParticipationSegment。             |
| [T0 Release 4 顺序](../archive/reviews/activity-os-t0-terminal-review.md#11-release-1-至-7-的最终-pr-边界) | D2 位于 D1 TimePolicy 之后、D3 Allocation revision 之前。                                             | D2 不偷跑 allocation、bucket、ledger、correction 或 proof。                          |
| `prisma/schema.prisma` 的 `ParticipantServiceSegmentRevision`                                              | 已保存参与身份、segmentKey、revision、来源事件、结果码、状态码、入/离场时间及 legacy `serviceHours`。 | 段、版本、来源和状态必须原样可解释；`serviceHours` 不是新的分类时长真相。            |
| `src/modules/attendances/attendance-punch-segment-revision.service.ts:41-132`                              | 当前写链在调用方事务内重建投影，先把同 key 的旧修订标为 `superseded`，再 append 新修订。              | 新 facade 只能读当前修订，不能绕开这条写链或把旧修订重新视作 current。               |
| `src/modules/activities/attendance-segment-projector.service.ts:11-17`                                     | `AttendanceSegmentProjectorService` 已是公开的纯投影包装。                                            | D2 不把这个纯 projector 冒充为持久参与事实读取接口，也不深引其实现。                 |
| `src/modules/activities/activities.module.ts:398-429`                                                      | ActivitiesModule 已导出 `AttendanceSegmentProjectorService`；考勤与活动模块已有受控模块关系。         | D2 必须在精确计划中按真实 import/export 链定落点，不能凭同名服务新增深层跨模块引用。 |

## 3. 方案 A 的数据与读取合同

### 3.1 唯一事实与“当前”语义

1. 唯一事实仍是 `AttendancePunchEvent → ParticipantServiceSegmentRevision`；D2 不新建同义实体、镜像表、缓存表或后台同步任务。
2. “当前”仅指同一 `participationIdentityId + segmentKey` 下未 `superseded` 的持久修订。返回的每条记录必须带稳定段键、修订、参与身份、来源事件锚、结果码、状态码和原始时间区间；不得只返回一个裸 `serviceHours` 数字。
3. `valid`、`early_departure_zero`、`voided`、`replaced` 与未完成区间均须保留可辨别状态。D2 不把零结果、作废或待补事实静默过滤成“没有发生”，也不把它们认定为可分配时间；可否分配由 D3 另行决定。
4. D2 的读取结果不得从活动名称、贡献分数、旧结算、TimePolicy 默认类别或历史 `serviceHours` 推断、补齐或重算时间。D1 只提供政策锚，D2 不在本阶段消费它做分类。

### 3.2 调用与事务边界

1. facade 是内部 application/read contract，不新增 HTTP endpoint、DTO、OpenAPI、客户端、权限码或审计事件。
2. 调用方须先按现有身份、组织和活动关系完成资格/范围判断，再把同一事务 `tx` 与已解析的活动传入；精确计划收敛为活动级 reader，由持久段关系带出 identity，facade 不接收自由拼装的跨活动 identity / member / 岗位 ID 组合。
3. facade 必须使用调用方传入的事务，保证后续 D3 写链能够读到同事务中的当前事实；它自身不写、不独立开启事务、不建立跨请求缓存，也不在内存保存“当前段”。
4. 未来涉及“先读段、再分配/认定”的写命令必须由写命令持有其既有锁并在锁后重读；D2 只定义读取入口，不能在这一阶段凭空调整既有考勤写链的锁序或超时。

### 3.3 兼容与归属

1. 现有考勤重建、结算、成果、证明和服务段消费者维持原行为。D2 实施时先列出引用链并为新调用替换建立 characterization，不能批量改表查询后宣称兼容。
2. facade 的实际 Nest 落点、公开导出项、查询选择字段和错误表达须在下一份精确计划通过引用链决定。推荐由拥有持久事实的考勤边界提供；若现有模块循环使此方案不成立，必须先报告冲突，不能把 D2 塞进 ActivitiesModule 或新建共享模块来规避边界。
3. 任何新 reader 只能消费 facade，不得深引 `attendance-punch-segment-revision.service.ts`、Prisma row 或 projector 私有实现。既有 reader 是否迁移不属于本稿授权。

## 4. 明确不做

| 不做项                                                                 | 原因与后续归属                                     |
| ---------------------------------------------------------------------- | -------------------------------------------------- |
| 新服务段表、双写、回填、清库或物理删除                                 | 违反单一参与事实；历史资产永久保留。               |
| `ParticipantTimeAllocationRevision`、类别桶或人工认定                  | 属于 D3 / D4，且需要另行确认互斥、总量和证据合同。 |
| shadow、独立 Time Ledger、冲回/更正、证明或正式切换                    | 分别属于 D5–D8。                                   |
| 更改既有 `serviceHours`、结算、贡献、成果、证明读数或 Gate             | D2 只是中性读取，不改变既有业务结果。              |
| 新 HTTP、Admin/App/Integration/AI 访问面、权限、审计、DTO 或生成客户端 | 当前没有对外业务命令，不能先占用访问面。           |
| Redis、队列、缓存、定时同步或通用 Command Bus                          | 不需要，且不符合当前基础设施冻结和 facade 原则。   |

## 5. 后续精确计划必须先回答的问题

1. 现有所有直接读取 `ParticipantServiceSegmentRevision` 的生产消费者分别是什么语义；哪些必须保持直读，哪些仅为新 D3 路径改为 facade。
2. 写链对同一 identity/segment 的唯一约束、并发锁、重放与 `superseded` 语义是否足以保证 facade 不出现两个 current；若发现数据合同冲突，停止并先报，不在 D2 临时修 schema。
3. facade 的最小输入/返回强类型、排序、分页/上限（若需要）、空结果和错误码；不能暴露 Member/User、附件或完整打卡原文等不必要敏感字段。
4. 考勤与活动模块的真实依赖图能否安全导出该 facade；若需要新 export、模块调整或 Prisma 查询辅助，逐条写进下一份精确写集并单独跑 `harness:needs`。
5. D3 如何在同一事务中锁后重读并验证段归属、状态和区间；本稿只要求留下接口条件，不预先选择 D3 的 allocation schema 或锁策略。

## 6. 未来实施的验收探针（现在不执行）

- 同一 identity 多段、多次替换、缺失段、零结果、作废、已 superseded 与未完成区间均按合同区分，返回稳定排序且不误把历史修订当 current。
- 活动、场次、岗位、组织或参与身份不匹配时，调用方不能借 facade 越界读取；当前用户禁用、退队或组织失效的未来业务入口仍须逐请求重验。
- 同一事务内的考勤重建后读取能看到刚写入的 current；失败回滚后不留下半条事实，不形成缓存或镜像漂移。
- 既有考勤、结算、成果、证明和 D1 时间政策选择的 HTTP / contract / E2E 行为保持不变；新 facade 自身没有 HTTP 合同漂移。
- 若未来实现涉及数据库迁移、模块 export 或受保护路径，隔离测试库、rebuild、migration 复现、红区授权、3b/4b 重签、PR CI 与合并后 main CI 分别留证，不以 docs 检查替代。

## 7. 评审阶段写集与下一次授权（历史记录）

本轮精确写集仅为：本稿（新增）、`docs/ai-harness/NEXT_TASKS.md`、`docs/ai-harness/FROZEN_DRAFTS.md`、`docs/plans/activity-os-r4-d1-3-implementation-plan.md`、`docs/plans/activity-os-r4-d1-time-policy-review.md`、`docs/handoff/admin-web.md`、`docs/handoff/miniapp.md`。`pnpm harness:needs` 已核验 7/7 不需授权。

下一步建议分两次确认，避免把设计方向误当成代码授权：

1. **确认 D2 方案 A；允许补充 changelog、提交、推送并创建 D2 文档评审 PR；不合并、不实施、不操作数据库、不启用 Gate。**
2. 文档 PR 合并后，再起草 D2 精确实施计划和授权清单；届时才列出真实写集、是否需要 migration、隔离库、红区授权、测试与签字。该步骤不自动授予任何实现权限。

## 8. 本次未做（评审阶段）

未实现 D2，没有连接、迁移或重建数据库，没有修改 schema、生产代码、测试、权限、审计、OpenAPI、客户端、Gate 或部署，没有删除业务数据，也没有提交、推送、创建或合并 PR。D3–D8 与整体跨模型复审仍未完成。当前精确计划的实际状态以本文顶部和精确计划正文为准。
