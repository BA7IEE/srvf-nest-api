# T31b 卡 A 候选执行回执

冻结提交 2a0fd5adbaddf01ee9cac5c16d49cfc21790aed7，#1443 当前 head 匹配。GitHub Actions 对同 SHA 的 Red-zone trusted approval 为 completed/success。以该 SHA 的 Contents API 读取 scripts/ops/reconcile-activity-catalog.sql，与独审批次 SQL 逐字节一致，SHA256 为 17b30e8e34d693a84403609b1c6468ea52494a406d445dc12ad75b93812936d9。

SSH 强制主机密钥校验。在候选 PG 容器以 pg_controldata 核定集群标识，再经 SQL 核对 srvf_staging 与同一标识。冻结工具另在事务内核对迁移清单。call.py before、preview、check-preview、apply、after 依次 exit 0。preview 以 ROLLBACK 结束，预演前后快照逐字节相同；apply 以 COMMIT 结束。

三个目标权限、三个预置角色、三个指定映射均为新增，冲突 0。after.log 每条目标行依次记录角色码、权限码、角色 ID、权限 ID、映射 ID、对应 apply 审计 ID。目录审计新增 3 条。前后 8 条既有绑定整行摘要一致，4 个范围外角色整行摘要一致。自动用户绑定 0，PG GRANT 0。此次执行只运行上述冻结 SQL 及只读核验。

撤回凭据为 after.log 的三个 mapping ID 与对应审计。另获撤回指令时使用同一冻结 SQL、target_db=srvf_staging、重新验证的 cluster_id 和 operation=withdraw。工具按审计与映射匹配，仅撤本工具新增的映射；角色已有绑定或职务策略时整笔拒撤。内置角色、权限与审计保留。现场 withdraw 为 NOT_RUN。

T30 首发路径、控制面装配条件、共享绑定和通知意图退役范围沿用原报告。本次不补创建码，不触发模板、功能或路由变更。
