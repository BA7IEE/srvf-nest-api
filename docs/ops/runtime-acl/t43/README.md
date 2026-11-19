# T43 普通队员报名验收

**隔离 HTTP 报名链通过。首个 500 已定位为运行角色在参与身份表上无法取得行锁，整条事务还依赖另外两张表的权限。** 在一次性 PG 修正这三张表的装配后，两个无角色绑定的普通队员用原版后端完成了报名。队员移动端的正式构建仍显示“服务尚未接通”。公网报名验收为 NOT_RUN。

## 根因与修复位置

复现用的 HTTP 请求 ID 为 `cmwnsf7cm5b061f8d96d9b4e1f0a806dc`。API 返回 500/50000。诊断在报名事务开始时把业务请求 ID 写入事务级 application_name，同时记录 current_user 和 PG 后端进程号。应用记录 `srvf_dp_acceptance_runtime`、PID 170、Prisma P2010、SQLSTATE 42501。PG 在同一 ID、同一 PID 下记录了相同 SQLSTATE、表名和带 FOR UPDATE 的查询。该角色是预期的非所有者，既无 superuser 也无 BYPASSRLS。此关联适用于 T43 重现实例；T42 的历史请求仍没有同请求 ID 的 PG 回执。[HTTP](baseline-http.log) · [关联记录](state-update-trace.jsonl) · [原服务锁序](https://github.com/BA7IEE/srvf-nest-api/blob/713d3416830d897852929731ff7f9b638038ab7c/src/modules/activity-registrations/registration-command.service.ts#L191)

| 逐段复现 | 隔离现场结果 |
|---|---|
| 基线角色锁参与身份 | 即使尚无参与身份记录，FOR UPDATE 仍须有列 UPDATE，500/50000。 |
| 资格检查读取组织祖先 | 两个查询列已有 SELECT。FOR SHARE 因缺少任何列 UPDATE 返回 42501，继而 500/50000。 |
| 缺有效保险 | 以上锁通过后，保留原模板的保险要求，得到合同预期 409/26030。按仓库 E2E 做法，仅给标记成员准备覆盖活动日期的合成团险记录。 |
| 创建参与身份、维护结算人口版本 | 真实 Prisma INSERT、人口状态表 FOR UPDATE、首次 INSERT 分别触发 42501。各自请求的 ID、表、操作与失败回滚已留存。 |

补齐之后，移除诊断挂载，重新启动同一个镜像，挂载数为 0。两个业务账号均使用正常密码登录；各自只有普通 USER 身份、有效队员绑定与组织成员关系，直接角色绑定数为 0。试验中没有降低保险要求、预写报名或预占容量。共享候选仅执行只读元数据查询。三张表在隔离基线与候选角色上的 SELECT/INSERT/UPDATE 有效列完全一致；候选其余权限以及公网业务结果不能由此推定。[镜像回执](stock.log) · [隔离基线](isolated-base.jsonl) · [候选只读取样](candidate-readonly.jsonl)

**精确修复位置为隔离栈的角色装配。** 共三张表、32 项列权限差额。后端 #1444 使用 `713d3416830d897852929731ff7f9b638038ab7c`，前端 #172 使用 `104e524c0b76826a79b1d48fad37fb07dcdfb8e8`，本轮均无源码修改，原生必需 CI 均为 PASS。[可重用隔离装配脚本](assemble.py) · [前端 CI](https://github.com/BA7IEE/srvf-admin-web/actions/runs/44565714648) · [后端 CI](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44548708050)

| 对象 | INSERT 列 | UPDATE 列 |
|---|---|---|
| ActivityParticipationIdentity | id、createdAt、updatedAt、activityId、sessionId、registrationId、memberId、currentRevision、currentStatusCode、currentPositionId、populationIncluded、version | updatedAt、currentRevision、currentStatusCode、currentPositionId、capacityReservationId、populationIncluded、version |
| organization_closure | 无 | depth |
| ActivityEvidenceState | id、createdAt、updatedAt、activityId、evidenceRevision、populationRevision、version、lastPopulationAt | updatedAt、populationRevision、version、lastPopulationAt |

组织闭包仅有祖先、后代和深度三列。选取 depth 供 PostgreSQL 校验 FOR SHARE，本次报名代码只读该表。此授权在数据库层允许该角色实际写深度，正式配置需要单独评估。其余列对应 Prisma 实际发出的插入、版本比较更新和时间戳。该差额以本次已有活动链装配为前提。[组织资格查询](https://github.com/BA7IEE/srvf-nest-api/blob/713d3416830d897852929731ff7f9b638038ab7c/src/modules/member-profiles/member-qualification-facts.service.ts#L78) · [人口版本维护](https://github.com/BA7IEE/srvf-nest-api/blob/713d3416830d897852929731ff7f9b638038ab7c/src/modules/activity-registrations/activity-registration-lifecycle.service.ts#L379)

## 验收矩阵

| 场景 | 结果 | HTTP、审计与落库 |
|---|---|---|
| 发布报名用活动 | PASS | 发起人和独立审核人使用正式后台页面，仅执行创建、提审、发布。 |
| 两名普通队员分别报名 | PASS | 各 201/0。每人一个永久报名头、一条报名版本，先到先得均录取。每人各占三个不同层级名额。两个请求分别关联 registration.create 与 registration.review 审计。 |
| 本人列表与详情、交叉读取 | PASS | 本人列表和详情均为 200/0，两方向读取对方报名均为 404/21001。 |
| 相同操作键重放 | PASS | 两人各重放一次，均为 201/0，完整回执与第一次相同，无重复版本、占位或审计。 |
| 同键不同内容 | PASS | 两人均为 409/21003，无成功审计。 |
| 跨账号取消 | PASS | 两个方向均为 404/21001，两条原报名持续有效至本人操作。 |
| 本人取消、读回和再次取消 | PASS | A 取消 200/0、读回 cancelled，再次取消 409/21030；B 读回仍为 pass。A 三条有效占位均释放，三个容量桶分别由 2 降至 1，取消结果与同 reqId 审计匹配。 |
| Worker | PASS | 两条录取和一条取消对应三个报名意图，按报名头和意图 ID 读回，均一次成功。另有两条活动发布意图。本地站内队列排空，Worker 退出 0，真实供应商外发 NOT_RUN。 |
| 队员 H5 正式构建的报名页面 | **BLOCKED** | 从真实报名路由进入，Chromium 实测转至 `#/system/not-configured`，页面显示“服务尚未接通”，API 请求数 0。页面提交、页面取消为 NOT_RUN。 |
| 公网新配对及普通队员报名 | NOT_RUN | 共享候选新增 GRANT 为 0；真实用户开放和公网切换均未执行。 |

报名成功 ID 为 `cmwnsoeb407b629168ac9adad1ed9619b` 和 `cmwnsoej09326ce1e6df3651700e2bb3d`，本人取消 ID 为 `cmwnsp367269236da12fafca812189ca4`。[普通账号 HTTP](enroll-stock.log) · [取消与负例](cancel-stock.log) · [报名后 DB](after-enroll.jsonl) · [取消后 DB](after-cancel.jsonl) · [报名头对应的 Worker 结果](registration-intents.jsonl)

移动端业务仓 main 为 `009976a22cce757ee13d48983764c1f5b6c07764`。另核对认证准备 Draft #3 `ce14f84b5add85de11816136a0ef975a28ff7b7e`，该提交有同源认证适配，生产构建仍初始化 unconfigured 数据源，凭证 ADR 尚待批准。已对该较新提交执行 `pnpm build` 并打开实际产物。正式管理后台提供的是管理轴报名功能。移动端仍需按其既有认证决策接入页面、再用这两个普通主体执行同一套验收。[浏览器回执](mobile-page.log) · [移动端接线说明](https://github.com/BA7IEE/SRVFMobileWeb/blob/ce14f84b5add85de11816136a0ef975a28ff7b7e/docs/integration-readiness.md) · [Draft #3](https://github.com/BA7IEE/SRVFMobileWeb/pull/3)

## 命令、撤回与部署边界

| 命令或操作 | exit | 结果 |
|---|---:|---|
| 基线 `sh registration.sh enroll` | 1 | 合法报名期望 201，实得 500。之后每个诊断请求只导出状态、错误分类、SQL 标识符与请求 ID。 |
| `sh member.sh enroll`、`sh member.sh cancel` | 各 0 | 原镜像处理两名无角色绑定普通队员的正反用例。 |
| `python3 verify.py` | 0 | 重算五个数据库拒绝请求、两个普通账号的写入、五笔审计、三个报名站内意图。 |
| `assemble.py` 的 check、rehearse、apply 两次、withdraw 两次、check | 各 0 | 工具仅接受指定版本的内部测试网络和 tmpfs PG，须匹配显式 cluster ID、角色及 156 项迁移。撤回仅限自己的回执和基线原先缺失的列。 |
| 撤权后再用原活动发起报名 | 1 | 再现 500/50000，已提交的报名、取消、审计和 Worker 结果不变。 |
| 退役及资产复核 | 0 | 站内待处理数 0。保留权限 0600 的隔离审计副本，移除本轮容器、临时库、网络与生成的登录文件。 |

修复验证范围为单场次、单岗位、无表单答案、合成保险、先到先得活动。上传、真实保单、抽签、多场次、签到及结算均为 NOT_RUN。活动五类指标的完整交叉沿用 T42。[撤权对照](restored.log) · [装配回执](assembly.log) · [退役回执](retired.log) · [人工决策更新](GATE.md) · [配对准备更新](PAIR.md)
