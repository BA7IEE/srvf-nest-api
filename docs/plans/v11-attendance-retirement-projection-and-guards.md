# 新版参与投影与守卫迁移草案

本稿描述本地候选和下一步，不代表通知已迁移，不代表维护者签署。旧 Sheet/GPS 控制器及旧写 provider 已从运行时移除；旧服务源码、历史迁移和旧数据仍在，负责人工作流、退队保护及遗留资源解析仍有旧依赖。活动对账、参与汇总及月度总览已接当前 posted 结果的共享投影，列表统计和工作台已改查新版，具体字段和待定语义见[前端交接](../handoff/v11-participation-projection.md)；报名取消、重提及活动软删保护改查新版参与证据。真实 PG／HTTP 尚未验证。不得据此部署。

## 尚未退休的运行时读面

- `MetaService.dashboardSummary` 已通过活动域端口读取新版结算流程；原 `attendanceSheets` 字段已移除，新字段及旧 E2E 差异须审查。组织内状态数量并不表示本人能审核。
- `ActivitiesService.attachStats` 的 `includeStats` 已改为报名头及授权后的新版版本统计；`ActivityWorkflowQueryService` 的负责活动列表、详情及 `ActivityClosurePolicy` 仍用旧 Sheet 状态和旧完成声明计算待办。新版的身份、结算版本、活跃 closure 与活动完成状态各自不同，须先定义新字段和状态映射，不可把 run 数伪装成 Sheet 数或以零代替。
- `ActivityMemberOffboardImpactService` 仍用旧打卡、记录和 Sheet 计算报名证据及负责人关闭状态；其结果被成员退出检查和写事务使用，迁移时须与新版报名证据、活动根锁和实际 closure 一致，不能放宽退出保护。一个报名头可有多场次，任一场次有证据不能掩盖其他未决场次；更正可涉及多个身份。现退出锁序先成员 advisory/行锁，其他写方先活动锁，事后补活动锁会形成死锁；活动新建也有并发插入幻影。须完整设计锁序及并发实测，不能简单以 active closure 或零值代替。
- `AuthzService` 的旧资源解析和旧 Sheet 状态机仍被 explain、action-state 诊断入口接受；SUPER_ADMIN 在资源解析不到时也可能提前放行，因此只返回 null 不能停用。`me/capabilities` 仍投影旧考勤权限。须在红区授权下明确诊断行为并覆盖超级管理员、普通用户及新版资源，不能按前缀批量关闭仍供新版复用的 `attendance.read.sheet`。旧转换服务是独立维护路径，不能与运行时入口混为一谈。

以上读面本轮未完成迁移，不代表旧版真正退休。历史迁移与原始数据不应删除；对用户所述零真实数据不能以未连接的数据库检查冒充确认。相关旧 E2E 断言仍待维护者按新合同审查，不能直接删除以消除失败。

## 活动列表统计的第五轮约定

`includeStats` 仅改变展示，不参与授权、删除或退队保护。`registrationCount` 保持未软删报名头的全部状态计数；它既不是已到场人数，也不会把一人的多个场次身份重复计算为多条报名。旧 `attendanceSheetCount` 无新版等价含义，应移除并明确告知前端，不将身份数或账本数装进旧字段。

新版补充 `settlementStats`：它只在调用者同时满足现有审核工作台 `attendance.read.sheet` 全局入口码及对应组织可见范围时出现。现有 RBAC 入口需要 GLOBAL 绑定（或 SUPER_ADMIN），不是把 scoped-only 用户提升为审核台用户。闸关闭时返回 `available: false`，不读旧表或新版结算；闸开启（含只读维护）返回 `available: true` 和 `submittedVersionCount`，只计曾提交且当前非 draft 的版本行，包含已退回或作废的历史提交版本，不含从未提交即作废的草稿；它不是人数、考勤单数或可操作待办数。无 run 时为合法零，无权活动省略整个对象。查询须同时约束本页活动 ID、授权组织、未软删活动；判权与计数在同一 Repeatable Read 快照；scope 非 GLOBAL 的 mock 用于防御性测试，并非声称当前 GLOBAL RBAC 能产生该组合。原不请求统计的列表和纯报名计数不受新版闸关闭影响。原 E2E 断言 `attendanceSheetCount` 待审，不在本轮直接修改。

## 工作台新版结算状态口径

工作台是展示而非审核许可：旧 `attendanceSheets` 块移除；新版 `settlementReviews` 统计当前结算 run 处于 `pending_first_review`、`pending_final_review` 的活动数，分别由一审与终审全局 action、审核台全局读码以及双方可见组织交集裁剪。数字是组织范围内流程状态，不表示当前调用者可以审批：自审、同人复核、版本指针或其他检查仍由实际审核命令执行。活动已软删的不计，无权阶段省略；无任何阶段权限时整个块省略。开闸含只读维护时提供计数；关闸有权者返回 `available: false`、不读旧 Sheet 或新版 run，报名和活动概况保持可用。scope、授权及计数须在同一 Repeatable Read 快照。旧工作台 E2E 形状是有意合同变化，未直接修改。

运行时由 `MetaService` 注入公共端口 `ACTIVITY_DASHBOARD_QUERY`，`ActivitiesModule` 用 `useExisting` 绑定活动域服务；服务自身在同事务重新判权及判闸，不接受调用方伪造的授权范围。此真实跨域依赖及新公开端口尚须维护者审查并在受保护的 `harness/domain-map.json` 正规登记；当前新增债扫描不解析此 token，不得把它的零 finding 当成依赖已登记或 C3/C8 已覆盖的证明。

## 投影事实和拟定口径

- **权限与快照**：活动对账先按两个原有 action 对 activity ref 判权；月度先取两个 action 的可见组织交集，再与请求组织及后代取交集。无权限仍拒绝，无可见组织的月度结果仍为空。授权活动集合、报名、场次身份、正式结果、账本、正式时长和评价应在一次 `RepeatableRead` 中读取，不能把不同更正版本拼在一起。空组织、无成员、无权限和 gate 关闭的优先级须有反例。
- **身份与去重**：一条 `ActivityParticipationIdentity` 是一人一场次；先按身份保留结果，再按活动和成员合并。相同成员多场次最多计一个活动到场人次，但保留每场次状态供核对。报名头状态统计与场次身份结果分开：现场补录的报名头可能是 `pending`，同一场次身份已是 `pass`，不得把前者当作后者。
- **正式与待定分开**：正式结果锚定当前 posted version 对应的 committed result 和 committed batch。`present` 即使贡献/时长为零仍是正式到场；`absent` 为正式缺席；`leave`、`cancelled`、`early_departure_zero` 等保持独立结果，不伪装成出席或缺席。没有正式结果、开放段或无打卡是待定，不从“零行”推断缺席。多人多场次合并时只要任一正式结果为 present，成员有正式到场；在无 present 且仍有待定场次时，不能把该成员归为最终缺席。其他结果和多场次混合须保留可解释明细。`active closure` 可表示关账，但不是 posted 事实的唯一锚：普通入账可先于关账，更正提交与重新关账之间也可没有 active closure。
- **临时参与**：新版现场参与使用显式 `onsite` 来源；应从不可变报名/参与修订判断身份的来源，不能只看可覆盖的报名头或“是否存在报名”。来源缺失、存量合成头和多场次来源不一致时必须显式标记未知，不能猜成普通报名或临时参与。现有存量转换只覆盖部分 approved 数据，且合成头可写 `admin`；本候选不读取或改写旧表来伪造来源。
- **计数及比例**：原 DTO 的 `recordCount`、`approvedRecordCount` 是旧 Sheet 行数，不能直接改称身份数或账本日行数。新合同应显式区分参与身份、正式结果、已入账身份×北京日和成员人数；率的分子、分母、待定和未知均需单列。缺最终认定时不应返回貌似完整的 no-show 率。旧行为的变化须在合同及前端交接中明确，不可仅删字段或统一填零。
- **时长及直方图**：时长证明 receipt 存在时复用正式时间 selector 的 eligible 秒；没有 receipt 时的已正式入账小时按 committed 正负账本净额，不能回退旧考勤。直方图的统计单位应统一为活动×成员，合法明确零值可进 `[0,2)`；selector 没有来源行不等于零。遇缺来源、负净时长或不完整版本时应明确失败/未定，不能私自夹零。贡献积分始终取 committed credited 正负净额，不二次封顶或与旧分叠加。
- **月份**：沿现有接口以 `Activity.startAt` 的 UTC 月归组；账本按北京自然日分配并不意味着改按账本月分组。月度人数/率从同一活动级投影折叠，不能复制另一套人数口径。

活动对账、汇总和月度 DTO 已显式表达待定、非到场结果和来源未知，不把未知变零。需要实际隔离 PG/HTTP 覆盖更正准备/生效、无 closure 的 posted 版本、合法零行、冲回重记、同人成员多场次、现场来源、开放/作废/早退段、无组织、跨范围、并发读和 UTC/月及北京日边界。当前这些验证均 NOT_RUN。

## 新版达标通知的事务设计及权限缺口

普通提交、Human 更正及后台更正应共用 `LedgerPostingService.commitBatchProtocol`。在既有 member advisory 锁后、批次 committed 前读取申请轮次和 cutoff 内 credited before；状态切换后同一事务读取 after；仅 `before < 5 <= after` 写同事务幂等 outbox。`applicationId + threshold` 必须复用既有稳定事件键和同一 payload；已 committed 重放不得重复构造，历史转换不发送。候选成员取全部本批次成员，不能按总 delta 过滤：跨 cutoff 的冲回和重记总和为零仍可能跨门槛。不得在代码测试中发送通知。

当前仓内角色迁移未显示 Human C 角色能读取入队申请/轮次；实际 ACL 未连接验证。C 又可由 U `SET ROLE`，直接增加整表或列权限会扩大跨人敏感数据范围。应先由维护者审查最小列或受控只读方案、Human catalog 封存和反向授权测试，再在 HTTP Activities、普通 worker 和 Human scoped 三张 DI 图中安装同一 producer；不能切换管理员连接或吞权限错误。新增查询及 `enqueueMany` 对原 7/15/60 秒、500/2000 等容量的影响及真实 bind 数必须重新测量，旧规模证据不自动适用。

## 可授权的 C3/C8 维护范围

- `scripts/check-activity-workflow-gate.ts` 属红区。C3 应从实际生产代码与注册/导出图发现每个可调用入口，逐个做有效变异并报告身份，不再只变异固定四文件。C8 除旧 `attendanceRecord` 结算字段外，还须识别 committed ledger、official-time、closure、owner 读接口、端口及敏感 raw SQL，并按入口和可达调用路径判断真实 Gate 是否支配读取；无法证明的动态调用/SQL 应明确报告，不当作通过。
- 反向测试应分别覆盖新增无闸读者、从旧源换到每一种新版源、无闸分支、死代码中的闸、假 receiver、丢弃返回值、私有 helper 同时被有闸和无闸入口调用、跨文件及间接绕调。既有 legitimate 写链反对照和真实鉴权顺序必须保留；针对不同读面的精确源、入口、调用链断言应保持，不用固定数量或放宽旧断言凑绿。
- `src/common/activity-workflow/activity-workflow-gate.criteria.spec.ts` 的现有旧形状断言与上述守卫应在获准的一组变更里同步维护，不先改测试掩盖守卫缺失。`scripts/cutover-check.ts` 若改 6b 的读面身份与源码摘要采集，也是独立红区；其签字摘要只能锚定证据，不能代替维护者审阅。
- `src/modules/authz/bd2-department-literal-gate.spec.ts` 属 authz-core 红区；其中已删除控制器的死豁免应按授权缩减，并断言存续两项精确存在。整文件豁免及把字符串内 `//` 误当注释的既有漏报，需 AST 定位 Swagger 文案与 URL 后判权反例共同加固，不能扩大白名单或删自证。
- 维护者可先分别预算精确路径：`pnpm harness:needs scripts/check-activity-workflow-gate.ts` 与 `pnpm harness:needs scripts/cutover-check.ts`；如审查批准，由维护者本人对需要修改的精确路径运行 `pnpm harness:grant '<精确路径>' --reason '<实际批准出处>'`。Codex 不自发 grant。受保护的 `test/contract/openapi.contract-spec.ts` 和其 snapshot 必须一并按真实 30 条退役路由差异审查及授权更新；`ROUTE_AUTHZ.md` 与 `harness/authz-assertion-patterns.json` 也需经授权生成。
- 现有 6b 记录的 C3/C8 为 4/6；活动汇总及月度迁移后机器为 5/1，对账也迁移后为 5/0。C8 只扫旧表，零命中触发非退化检查失败，绝不证明新版读面闭包；不可只改数字。需保留历史签字及差异，待新版发现面、反向用例、真实 PG/HTTP 证据由维护者审阅后真实签署；signoff 通过也不代表完整 cutover 获批。
