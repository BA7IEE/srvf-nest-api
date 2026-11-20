# T44 队员报名页、报名权限与考勤结算

队员 H5 的正式构建主动关闭真实网络。恢复报名页需要维护者决定真实凭证的存储方式。隔离 API 已用两个普通队员完成报名、本人读回、跨人拒绝和取消。本轮把组织关系表的行锁与直接修改分开验证，并查出报名后两个独立的 500。共享候选新增授权 0，公网验收 NOT_RUN。

## 队员 H5

| 检查 | 实际结果 | 证据 |
|---|---|---|
| 正式构建路由 | T43 相同 SHA 的 Chromium 实测落到 `#/system/not-configured`，显示“服务尚未接通”，业务 API 请求 0。T44 复用该次页面观察 | [原始回执](https://github.com/BA7IEE/srvf-nest-api/blob/5b4079884fdf67c23215f842aa72805748063764/docs/ops/runtime-acl/t43/mobile-page.log) |
| 构建入口 | `pnpm build` 显式选择 unconfigured；T44 尝试 `VITE_DATA_SOURCE=api pnpm build`，以“外部环境与显式构建模式冲突”拒绝，exit 1。Vite 也拒绝 api 模式，正式 CSP 为 `connect-src 'none'` | [运行记录](h5-build-rejection.log) · [构建脚本](https://github.com/BA7IEE/SRVFMobileWeb/blob/ce14f84b5add85de11816136a0ef975a28ff7b7e/scripts/build.mjs#L4) · [Vite](https://github.com/BA7IEE/SRVFMobileWeb/blob/ce14f84b5add85de11816136a0ef975a28ff7b7e/vite.config.ts#L6) |
| 页面与数据适配 | 非 mock 时路由重定向；运行时只有 mock 和 unconfigured 两组数据端口。现有同源适配器覆盖五个身份接口，页面还要读取活动、本人保险资格及报名结果。定向运行 auth-transport 和 activity-form-bridge 共 4/4 通过，exit 0；真实 H5 报名 BLOCKED | [路由](https://github.com/BA7IEE/SRVFMobileWeb/blob/ce14f84b5add85de11816136a0ef975a28ff7b7e/src/app/router/index.ts#L119) · [数据入口](https://github.com/BA7IEE/SRVFMobileWeb/blob/ce14f84b5add85de11816136a0ef975a28ff7b7e/src/data/index.ts#L4) · [报名页](https://github.com/BA7IEE/SRVFMobileWeb/blob/ce14f84b5add85de11816136a0ef975a28ff7b7e/src/features/registrations/pages/RegisterPage.vue#L35) · [定向测试](h5-contract.log) |

**需维护者决定的事项只有凭证方案。** 建议首版使用同源 HTTPS、每个标签页独立的内存会话。刷新页面、关闭后重开或复制标签页均重新认证，同一页并发刷新只执行一次。ADR 001 明确将真实接线置于审批后。本轮未新建 H5 业务提交。批准后可在正式仓接入真实数据端口、放通同源请求，验证报名页使用的保险与报名读回字段；两项属于工程合同核对。不得将未拿到的保险资格或报名状态当作通过或失败。[凭证 ADR](https://github.com/BA7IEE/SRVFMobileWeb/blob/ce14f84b5add85de11816136a0ef975a28ff7b7e/docs/adr-001-credentials.md#L3) · [读面 G04、G05](https://github.com/BA7IEE/SRVFMobileWeb/blob/ce14f84b5add85de11816136a0ef975a28ff7b7e/docs/api-gap-register.md)

## 三表列权限

试验使用 PG 16、156 个迁移、独立 tmpfs、内部网络和非所有者应用角色。以正常页面创建和独立审核发布的活动作为夹具；报名者是两个无直接角色绑定的 USER，保险为合成数据。通过 pg_stat_statements 只提取实际 DML 的表名、列和调用次数。在同一角色下先校验投影，再逐列撤权，以相同目标列、不影响数据的 SQL 验证 PG 权限，事务均回滚。32 项全部得到允许时 00000、撤回该项时 42501。完整 HTTP 重测针对整套装配，逐列测试针对 SQL 权限。[权限清单与脚本](assemble.py) · [实际投影](shapes.jsonl) · [逐列回执](minimum.jsonl)

| 表 | 此次路径用到的增量 | 实测结论 |
|---|---|---|
| ActivityParticipationIdentity | INSERT 12、UPDATE 7 | 当前 Prisma 的身份创建与状态、容量指针写入需要这些列 |
| ActivityEvidenceState | INSERT 8、UPDATE 4 | 当前 Prisma 的人口修订与首次状态创建需要这些列 |
| organization_closure | UPDATE(depth) 1 | PG 的 SELECT FOR SHARE 需要对表中至少一列拥有 UPDATE。depth 是目前选用的列，两列组织 ID 均构成主键。具体列可替换，所需权限项数仍为一项 |

在保持相同 ORM 写入投影、行锁语义及角色基线时，未发现可直接再删的权限项。隔离库加装语句级写保护，运行角色能锁到真实存在的一行，但执行 UPDATE 命中行或零行均被拒绝，SQLSTATE 42501。隔离库原闭包表为空，首次真实行断言如实失败；随后仅在回滚事务内为本活动组织加入一行自反关系，验证锁和深度完整性，回滚后再次确认为空。表所有者的零行维护语句可执行。该保护对使用相同运行身份的所有流程生效，也会阻止该身份正常维护组织深度。部署契约维护者需核实组织维护写入身份及锁边界；本轮没有将触发器或权限部署到共享库。[实测](closure-matrix.jsonl) · [试验 SQL](closure-check.sql) · [可重复装配与撤回](PAIR.md)

## 报名后的真实链路

| 身份与场景 | 判定 | HTTP / 业务码或 DB 证据 |
|---|---|---|
| 两普通队员报名、精确重放、本人读回 | PASS | 各 201/0、201/0、200/0；改载荷重用同一键 409/21003；两次报名请求 ID 均对应建档审计。[HTTP](enroll.log) · [DB](after-withdraw.jsonl) |
| 跨人读取及取消、一人正常取消 | PASS | 跨人 404/21001；本人取消 200/0，重试 409/21030；同伴仍通过且三层容量预留保留。[回执](cancel.log) |
| 普通队员查本人考勤、尝试管理二维码 | PASS | 本人状态与空考勤清单各 200/0；无管理职责查码 403/30100。正常投影的活动负责人签发 201/0，渲染 201 且 no-store，退役作废 200/0。[前置与权限](downstream.log) · [读回复核](post.log) |
| 普通队员在有效窗扫码签到 | BLOCKED，关闸行为已验证 | 在真实时钟窗口用 Chromium 解码实际签发的 SVG，正常 HTTP 自助签到 503/20153，正向断言 exit 1。服务端在验码前执行 V1.1 单轨写入门禁。读回未签到，DB 事件 0、时段 0。此覆盖不含 H5 页面或手机摄像头。后续签退、生成服务时长、结算写入 NOT_RUN。[请求](scan-in.log) · [库内计数](downstream-db.jsonl) · [冻结后端](https://github.com/BA7IEE/srvf-nest-api/blob/713d3416830d897852929731ff7f9b638038ab7c/src/modules/attendances/attendance-punch-command.service.ts#L155) |
| 本人参与汇总 | FAIL | 正常 API 500/50000。相同镜像、相同运行角色的诊断复测，用同一 reqId `cmwntdhpb80abf991a3e405b75dd725a8` 对应到拒读 ActivityTimeCutoverReceipt。同窗 PG 另报 ParticipationLedgerEntry 拒读，其单条请求归属未证。[诊断](summary-diag.log) |
| 负责人结算工作台、普通队员越权 | FAIL / PASS | 负责人 GET settlement 为 500/50000；同 reqId `cmwntitqt25986f4041c6ca7aaf20f44a` 的诊断复测指向拒读 ActivitySettlementClosureRevision。普通队员 403/30100。两张直接关联表在隔离运行角色下均无 SELECT 列。[原镜像回执](post.log) · [诊断](workbench-diag.log) · [有效权限](downstream-db.jsonl) |
| 单独的时长结算读面 | 已测负响应；正向 NOT_RUN | 两主体 GET time-settlement 均 404/20219。该响应无法区分资源缺失与不可见。[回执](downstream.log) |
| Worker 内部处理与退役 | PASS | 同镜像 Worker 处理 5 条意图，其中 3 条关联报名；待处理 0，进程退出 0。隔离网络无公网出口，短信、企微及微信路由关闭。供应商投递和公网验收 NOT_RUN。[开关](outbound.json) · [Worker](worker.log) · [退役](retired.log) |

两条 500 的诊断观察器仅记录同请求 ID 与错误涉及的表名，随后交还原异常处理器。生产配对、外部渠道与共享 ACL 均无改动。后续工程可在隔离库集中核对两个读取路径的实际查询投影与运行角色契约。确认凭证方案即可继续正式 H5 接线。[复算入口](verify.py) · [发版判断](GATE.md)

## 固定版本与命令

| 业务仓 | HEAD | 原生 CI |
|---|---|---|
| SRVFMobileWeb #3 | `ce14f84b5add85de11816136a0ef975a28ff7b7e` | [check SUCCESS](https://github.com/BA7IEE/SRVFMobileWeb/actions/runs/44326274888/job/134878276339) |
| srvf-admin-web #172 | `104e524c0b76826a79b1d48fad37fb07dcdfb8e8` | [verify SUCCESS](https://github.com/BA7IEE/srvf-admin-web/actions/runs/44565714648/job/135706747311) |
| srvf-nest-api #1444 | `713d3416830d897852929731ff7f9b638038ab7c` | [必需 CI SUCCESS](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44548708050) · [trusted REQUIRED=false](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44548698125/job/135646405756) |

本轮可复算命令为 `python3 verify.py`。现场装配、逐列测试、报名、取消、Worker、两次撤权、ACL 比对和退役检查 exit 0。真实签到正向断言 exit 1；两个下游 500 的诊断断言以稳定复现失败为目标，脚本 exit 0。完整活动五类交叉沿用 T42，此次只做报名后续所需的活动发布。[命令与回退](PAIR.md) · [原生 CI 明细](ci.json)
