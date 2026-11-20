# 部署准备与决定边界

推荐先在无公网入口的独立目标验配三仓合并后的固定制品。当前 dp 由旧 API 和后台提供服务，H5 没有独立入口，可信代理为 none，共享账本分录列为 0/13。直接更换 H5 会影响登录恢复和本人账本，单独开放读权也不能补齐过账和关账。生产部署、数据角色扩权、外部投递和公网发布分别另决策。本轮对服务器只读取证。

## 版本、制品及目标

| 组件 | 准备输入 | 收货凭据 |
|---|---|---|
| API / Worker | 后端 `65bad1ccb7e6a4bb7a3cda46b49512f092d04779`，源码树与受审 `65d1d6ea…` 相同。共用不可变构建，分别标明 API 与消费者入口。 | **正式发布 digest 未取得。** main CI 在 runner 完成镜像构建检查，没有可部署的 registry digest 回执。现场 API 是 `sha256:1eb4e3ca…`，不能拿旧镜像或 CI 测试附件充当新制品。出库时记录 OCI revision、RepoDigest、运行时 dist 清单及生产启动命令类别。 |
| H5 | `ae2e3b0ad5202a214d4dcfdc54342e52f9f270a1`，树等同受审 `529ee3a3…`。 | 本批发布包未产。T48 隔离参照 h5 压缩包 `26690daa8419e46af89c3a04de3cab452bd18dc8ecb31b46bbcc75a40c149672`，index `58ccd7a4a11710099de5dfa013adcd12665102b0353cf4f9388abad279ce8a5b`；正式打包需生成并核全部文件摘要，包括 base path。 |
| 管理端 | `2626116889affe3bda3758f7ed1ce006272503bf`，与受审 `104e524c…` 的差异仅 README。 | 本批发布包未产。T48 隔离构建清单 `9f44857d0e930bf2cda08703f31c9a2c1a57a6c66e8659c2aabf171fc1b10d1b` 可作对照。绑定实际挂载目录，对 index、配置和引用的 JS/CSS 按同一算法复核。 |

环境选择为独立内网栈、普通非所有者 API 登录、单独可审的 Worker 登录、外发关闭、合成组织与两名普通主体。固定 HTTPS 域名，同源代理明确覆盖来源头，应用只信实际代理的最小地址范围。此轮没有调换当前共享候选的连接、模式或开关。[T58 配对](github.json) · [T48 隔离制品清单](../t48/build-inputs.json)

## 数据库角色和已知差额

全部 T58 数据库查询在 `srvf_staging` 的显式只读事务运行，采样 SQL 使用短超时。观察连接为 postgres。从 PG 活动会话看到来自目标 API 容器的两条 `srvf_dp_acceptance_runtime` 连接。此应用登录有 CONNECT、public USAGE，无 schema CREATE、SUPERUSER 或 BYPASSRLS。现行 API 对更正申请的 id/newPostingBatchId 可 SELECT，不能读私有证明表任何列或执行受保护更正函数。两只触发校验函数均为 invoker。

| 主体与操作 | T58 现场 | 部署前须满足 |
|---|---|---|
| 普通 API 读本人账本 | 批次 id、statusCode 的 SELECT 2/2；分录 13 列 **0/13**。 | 业务 API 本人过滤及数据库角色的直接权限分别验证。若决定开放共享 13 列，须由数据负责人评估范围和按本次新增精确撤权。 |
| 普通 API 关账 | 对 T54 隔离差额集合，关账收据 SELECT 0/11、INSERT 0/21；活动、结算运行的 currentClosureRevision UPDATE 各 0/1。 | 先在隔离栈复测一项活动的终审、过账、结案与新增分录。该清单相对 T54 基线，不能从中推导全局最小授权。 |
| 过账 Worker | 无实际在线 Worker 登录可提取；T54 隔离登录在共享库不存在。用 **API 登录作为对照**，ParticipationTimeLedgerManifest 的 SELECT 0/13、ActivityBatchJob 指定两列 INSERT 0/2。 | 确认独立非所有者 Worker 的数据库身份及可见队列，再核它自己的权限、领取、失败重试、租约和提交，不能借 API 或迁移身份证明。现有队列空闲不证明消费者能工作。 |
| 迁移主体 | 旧专用 migration 容器用 tools 镜像，11-18 完成并退出 0。迁移表及两只需替换的函数均归 postgres；未取得历史执行连接的独立用户名回执。 | 新部署须指定可替换这两只函数的受控迁移主体，分别记录 session_user、current_user、目标库和对象属主，仅在批准窗口执行。普通 API/Worker 不承担 DDL。 |

分录 13 列为 `activityId, cappedOutPointsDelta, creditedPointsDelta, entryKey, entryTypeCode, ledgerDate, memberId, participationIdentityId, postingBatchId, recognizedPointsDelta, resultRevisionId, serviceHoursDelta, sessionId`。表未启用 RLS，策略为 0。若共享角色获准直接 SELECT，这一身份能跨成员和活动读取相应列，且数据库权限本身不限制为已过账行。普通用户的 API 实测遵守本人筛选；当前证据不支持认定这里发生 API 泄漏。

T54 隔离用受审后端 `65d1d6ea…` 和 Mobile `529ee3a3…`，本人 200/0 两条，他人 200/0 零条、匿名 401/40100；六次业务写均匹配实际 actor 和 reqId 审计。本人/他人请求号摘要分别以 `e705f775…`、`1c5328ff…` 开头。仅撤掉**隔离临时补的六列**后，该账本读取 500/50000，汇总仍 200，数据库分录保留。该负例证明此读取依赖列权，不能推成共享上该次请求已经发生。共享 13 列卡拟议 SQL 与回退哈希分别为 `e356f2f2e24d478f6f7545165f986b9882bea8f09639085905bd550bc7203b78` 和 `e41c091f98f397657fe748c97bb67bc4cf03c5910b5a8c80d68b49a4dd389654`。B130 另案，两者本轮实施量皆为零。[现场逐列 ACL](database.json) · [T54 同活动请求、审计与撤权证据](https://github.com/BA7IEE/srvf-nest-api/blob/416ad53e9c15b7e6f25286e91c268e76ed1c3d4e/docs/ops/runtime-acl/t54/journey.json) · [T53 独立共享风险卡](https://github.com/BA7IEE/srvf-nest-api/tree/5f8f2e4336b4e2d3abdb40c577585fe0dfce9b30/docs/ops/runtime-acl/t53)

## 准入、回退及停止条件

1. **演练前固定基线。** 迁移历史与旧源码 156/156 同摘要；新 main 为 158，仅缺 `20261120073000_settlement_deferred_correction_guard`、`20261120073100_settlement_correction_proof_lookup`。两函数现场摘要同 T54 的旧值。核对系统标识、备份时点、角色 ACL、迁移 checksum、有效应用版本和受信源摘要。有漂移、部分应用或无可验证一致性备份即停。
2. **先验证可恢复性。** 在独立库实际恢复备份并比对活动、账本批次、分录、审计及权限；保存旧镜像 digest、admin/H5 目录和当前代理配置校验和。主机存在早期路由备份，哈希 `81208564…`，与当前 dp 的 `86cacf43…` 不同，只能佐证历史。T48 已演练隔离制品与库恢复，T54 已演练函数 DDL 反向还原；当前共享的可恢复备份尚未实证。
3. **迁移与消费者顺序。** 由获批操作者先停止新任务进入并排空在途租约，核对无外发、无双消费者、无旧会话继续写。按目标世代验证两份增量迁移；检查函数 OID、owner、ACL、invoker 与新摘要，再验证普通终审可 COMMIT、合法受信更正可提交、普通连接仍被拒。Worker 配对后仅用标记任务验证一次领取、一次过账、一次结案、本人新增且他人不可见。不能证明消费者及回退版本兼容时保留停发状态。
4. **同源与 P0-E。** 验证正确 Origin 下登录、刷新恢复、轮换和幂等登出；Access 仅内存，Refresh Cookie 的 HttpOnly/Secure/SameSite=Strict 生效，令牌值不留档。覆盖旧 refresh 重放与 family 撤销、改密/禁用/凭证轮换、绝对期限、并发多标签恢复，以及错误 Origin/CSRF 和伪造代理来源拒绝。核 15 分钟 Access、90 天绝对上限及通用失败码 10007。任何越权读回、旧凭证异常可用、敏感值暴露或 header 信任不明即停。
5. **失败时保留业务事实。** 隔离回退使用匹配的旧 API/Worker/静态和受信源摘要。还原两个函数会恢复旧终审 42501；已经提交的账本、审计、会话撤销及幂等收据须保留，不能用旧备份覆盖后续业务。实际生产回退、启停、迁移、共享扩权、公网切换与真实用户开放分别走其授权。公网 H5、真实手机/微信及外部投递均 **NOT_RUN**。
