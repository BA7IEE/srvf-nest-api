# 命令与退出状态

| 现场命令或入口 | exit | 核验 |
|---|---:|---|
| sh reads.sh baseline | 0 | 500 / 500 / 403，与 T44 直接关联错误一致 |
| python3 acl.py apply read --expected-cluster "$trial_cluster" | 0 | 22 项列级 SELECT |
| 首次 sh reads.sh success | 1 | 前两项业务响应均为 200；第三步重复登录中断。工具已改为按主体复用同一会话 |
| python3 prove-reads.py "$trial_cluster" read | 0 | 实际 SQL 的 22 项逐列反证 |
| sh gate.sh test-on | 0 | 同镜像测试进程，旧服务已停，新进程 ready |
| 第一次扫码工具登录 | 1 | 429/42900。保持限流参数，等窗口过后继续 |
| sh scan.sh check-in | 0 | 有效窗真实扫码；按装配阶段 500、500、201，状态读回及作废成功 |
| python3 acl.py apply punch --expected-cluster "$trial_cluster" | 0 | 76 项初始包触发 R5 关联读依赖，事务未留下事实；撤回后以最终 78 项装配 |
| python3 acl.py apply ledger-on --expected-cluster "$trial_cluster"；sh reads.sh success | 0 | 新轨本人汇总多两项 SELECT。装配后 200/200/403，三个业务断言均通过 |
| python3 prove-reads.py "$trial_cluster" ledger-on；python3 prove-punch.py "$trial_cluster" | 0 | 分别 2 和 78 项，逐项撤权均 42501 |
| acl.py preview，故意指定错误 cluster | 1 | 身份校验拒绝 |
| 三包重复 apply，各自 withdraw，随后 preview | 0 | 所有现有/缺失列集合与原快照逐项相同 |
| sh reads.sh baseline；运行 punch-state.sql；撤权前后 DB 摘要 cmp | 0 | 500/500/403，成功打卡事实与原审计都保留 |
| sh worker.sh；sh retire.sh；静态和镜像复核 | 0 | 3 条意图完成，排空、封存、退役 5 个试验容器 |
| python3 -B verify.py | 0 | 离线重算列权限、HTTP、同一 reqId 审计、事务结果和退役证据 |

现场连接使用严格主机密钥校验。测试凭证只用于正常登录；二维码在内存里解码。证据只包括测试身份标记、计数、状态、允许的投影、表/列名和哈希。
