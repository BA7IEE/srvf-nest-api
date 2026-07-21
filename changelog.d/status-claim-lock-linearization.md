### Fixed

- 将六类状态写的 no-op `UPDATE` 认领统一替换为静态、参数化的 PostgreSQL 条件行锁；需要继续消费可变、非 predicate 字段的路径在锁后重读权威行，避免并发软阻塞者与随后真实更新形成死锁或使用陈旧快照。
- 收紧 Team Join 管理评估和 App 候选部门更新：评估资格/时间以获锁后的权威时刻计算，候选部门只允许仍处 `joining` 的锁后当前行更新。
- 招新自助撤销在获锁并重读后重新核对本次微信或手机身份；等待期间发生换绑时沿既有泛化未找到错误失败关闭，且不写撤销、审计或通知副作用。
- 对抗性数据库探针为 ActivityRegistration review、Waitlist promotion、Attendance、Recruitment manual/withdraw、Team Join admin/App 七条锁后重读路径分别加入独立 mutation-kill，均复用既有业务或审计字段；Certificate verify/reject 仅消费 claim 已固定的 id/status，保留 root/direct/soft 锁线性化证明，不额外重读整行或宣称 safe-reread mutation-kill。
