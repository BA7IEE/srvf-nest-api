# T26 正式队员活动发起验收

运行镜像 revision 108feebb84b85c7e4955c5af8bbfc016702e4529。通过 StrictHostKeyChecking=yes 的 SSH 在候选端调用公网 HTTPS，凭据在进程内使用。候选 srvf_staging 中 Organization 和 Activity 各有 13 行（含各状态），不能根据个人组织选项为空推断全库没有组织。

| 实测 | HTTP / 业务码 | 判定 |
|---|---|---|
| 创建 node_type/group 与 activity_type/training | 四次 201/0 | PASS。按该 revision 的 seed 取码和值，库内验证 ACTIVE 各一项。全库可选，退役先盘点引用，正常停用项，再按需停用空类型。 |
| 标记 level-1 成员、普通账号、绑定、临时编入已有活跃非根组织 | 201/0、201/0、200/0、201/0 | PASS。仅夹具工厂使用管理员。 |
| 普通账号读回活动发起范围 | 200/0 | PASS。返回组织与临时归属一致，来源 membership。 |
| 普通账号发起训练草稿 | 503/20036 | BLOCKED。期望 201，断言 exit 1。运行版本的 managed create 在写入前检查 activityResponsibilityWorkflow.enabled；该请求没有进入 Activity INSERT。 |
| 退役临时归属、禁用测试账号及登出 | 均 200/0 | PASS。保留标记成员及审计。 |
| #1416 已发布活动变更、#1417 结算更正任务 | NOT_RUN | 本次对象未创建，不能据此判断两个 issue 已修复。不存在 ID 的历史 500 复现、跨对象尝试也未执行。 |
| 普通有权绑定 | BLOCKED | seed 已声明 ops-admin 包含 member.bind.account；T25 现场目录缺行。未发现需要改 seed 的证据，恢复部署目录需走审查。 |
| 页面、Worker、恢复、后续报名考勤结算 | NOT_RUN | 本轮无这些分支的新验证。 |

复跑记录见 result.log（执行 probe.py，exit 0）及 chain.log（执行 chain.py，exit 1，finally 正常退役）。本次有证据的直接阻塞为责任制工作流未开启。既有组织可复用，临时归属流程已通过，因此没有理由为此授 Organization INSERT。Activity INSERT 当前无任何有效列；本次没有触达该语句，不能断言开启开关即可完成活动链。当前可签出的新增共享 ACL 为零。隔离 PG 的活动链增权正负与撤权验证未执行，没有可批准的列集。所有候选 API 连接共享角色，正式授权须由部署契约维护者按实际 SQL 和回滚差额单独审查。启用责任制流程需要维护者的启用决定。
