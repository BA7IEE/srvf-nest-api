# T43 独立只读审查

**T43 报名 500 归因 PASS；隔离原版 API 报名、重放、取消及撤权对照 PASS；队员 H5 报名 BLOCKED；公网报名 NOT_RUN。** 本次只读重算了五个数据库拒绝请求、两名队员的报名与取消、五笔成功业务审计和三个报名通知意图，断言全部通过。[固定证据树](https://github.com/BA7IEE/srvf-nest-api/tree/5b4079884fdf67c23215f842aa72805748063764/docs/ops/runtime-acl/t43) · [重算入口](/private/tmp/srvf-t43/verify.py)

## 1. T43 的 500 已按同一请求定位

基线报名请求 `cmwnsf7cm5b061f8d96d9b4e1f0a806dc` 返回 `500/50000`。应用记录了运行角色 `srvf_dp_acceptance_runtime`、PG 进程 `170`、Prisma `P2010` 和 SQLSTATE `42501`。PG 错误与语句记录使用**同一 reqId、同一进程号**，明确指向 `ActivityParticipationIdentity` 的 `SELECT … FOR UPDATE`。后续逐步装配又定位到 `organization_closure` 的 `FOR SHARE`、参与身份的 INSERT，以及 `ActivityEvidenceState` 的行锁和 INSERT。由此可以把 **T43 复现的首个 500** 归因于隔离运行角色缺少行锁所需权限。T42 历史请求仍只有同时间窗证据。[基线 HTTP](/private/tmp/srvf-t43/baseline-http.log) · [应用与 PG 关联记录](/private/tmp/srvf-t43/state-update-trace.jsonl)

## 2. 三表装配后的报名与撤权对照成立

隔离装配涉及三表、32 项列权限。成功链使用移除诊断挂载后的原版 API 镜像；数据库运行角色非所有者、非超级用户且无 `BYPASSRLS`。两名普通 `USER` 的直接角色绑定均为零。缺保险时先得到 `409/26030`，随后仅为标记队员准备覆盖活动日期的合成保险。成功前的数据库快照未见预写报名或预占容量。[镜像回执](/private/tmp/srvf-t43/stock.log) · [角色属性](/private/tmp/srvf-t43/identity.json) · [装配回执](/private/tmp/srvf-t43/assembly.log)

| 场景 | 独立判定 |
|---|---|
| 报名与读取 | 两人各返回 `201/0`，各有一个报名头、一条版本、三条有效占位。两个首次请求分别匹配本人的 `registration.create` 和 `registration.review` 审计。本人列表、详情均为 `200/0`，双向读取对方记录均为 `404/21001`。 |
| 幂等与取消 | 同键同内容重放均为 `201/0`，完整业务回执相同，无新增版本、占位或审计；同键异内容均为 `409/21003`。跨账号取消均为 `404/21001`。A 本人取消为 `200/0`，再次取消为 `409/21030`，无第二次释放或成功审计。B 保持 `pass`，三个容量桶各由 2 降到 1。 |
| 撤权 | 三表列权限恢复基线后，同一活动上的报名再次返回 `500/50000`。撤权前后已提交的报名、取消、审计和通知状态一致。该次回执证明 HTTP 故障复现；精确的 SQL 归因取自前述带诊断的基线请求。 |

报名成功请求 `cmwnsoeb407b629168ac9adad1ed9619b`、`cmwnsoej09326ce1e6df3651700e2bb3d`，以及本人取消请求 `cmwnsp367269236da12fafca812189ca4`，均可按 reqId、业务主体和报名头核对。[报名回执](/private/tmp/srvf-t43/enroll-stock.log) · [取消回执](/private/tmp/srvf-t43/cancel-stock.log) · [取消后 DB](/private/tmp/srvf-t43/after-cancel.jsonl) · [撤权后 HTTP](/private/tmp/srvf-t43/withdrawn-http.log)

## 3. 共享权限、源码与 GATE

实时核对，前端 #172 HEAD 仍为 `104e524c0b76826a79b1d48fad37fb07dcdfb8e8`，后端 #1444 HEAD 仍为 `713d3416830d897852929731ff7f9b638038ab7c`。两份 PR 均为 Draft，未合并。隔离基线与共享候选的三表权限取样逐字节相同；实施记录支持**共享候选本轮新增 GRANT=0**。三表增量对已测隔离路径充分，尚未证明全部 32 项逐列最小。尤其 `organization_closure.depth` 的 UPDATE 会让共享角色具备改写组织层级深度的能力。GATE 已列明这一影响，并将目标环境权限审查单列。[前端 PR](https://github.com/BA7IEE/srvf-admin-web/pull/172) · [后端 PR](https://github.com/BA7IEE/srvf-nest-api/pull/1444) · [候选只读取样](/private/tmp/srvf-t43/candidate-readonly.jsonl)

**GATE 表述准确。** 后端 trusted 裁判为 `REQUIRED=false`，人工步骤为 `skipped`，该步骤没有待点击审批。维护者的合并决定和公网部署授权仍各自独立。[GATE.md](/private/tmp/srvf-t43/GATE.md)

## 4. 队员 H5 与公网

**H5 入口 BLOCKED，页面提交与取消 `NOT_RUN`。** 实测对象是移动端 Draft #3 提交 `ce14f84b5add85de11816136a0ef975a28ff7b7e` 的生产构建。Chromium 从报名入口跳到 `#/system/not-configured`，显示“服务尚未接通”，API 请求数为 0。普通队员 HTTP 链通过的结论不能延伸到 H5 页面或公网。公网报名、真实用户开放、供应商外发、签到与结算均为 `NOT_RUN`。[H5 浏览器回执](/private/tmp/srvf-t43/mobile-page.log) · [配对与部署边界](/private/tmp/srvf-t43/PAIR.md)

**隔离报名 API PASS；队员 H5 BLOCKED；公网 NOT_RUN。**