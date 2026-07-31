- **参与域 / 入队域并发写路径收口(2026-07-31;两份独立并发审计的 6 条活 bug + 2 条理论缺陷,冻结稿 [`concurrency-write-path-audit.md`](docs/archive/reviews/concurrency-write-path-audit.md) + [`concurrency-write-path-audit-codex.md`](docs/archive/reviews/concurrency-write-path-audit-codex.md))**:零新增端点、零新增权限码、零 schema 变更(Endpoint 恒 438 · 权限码恒 222 · Migration 恒 67);新增 1 个 AuditLogEvent(`team-join-application.supersede`,129 → 130)。

  这批被修的**不是**「锁用错了」,而是两种「锁本身看不出来」的形状:

  1. **锁的获取被绑在判权分支上,另一条 surface 裸奔**。单读 `attendances.edit` 每一步都对 —— 它老老实实 claim 了 Sheet 又复读了;缺的是**另一个聚合**的锁,而那把锁写在 `if (managedActivityId !== undefined)` 里,Admin 分支没有 else。只有把两条 surface 并排看才发现。
  2. **跨行不变量没有共同线性化键**。每一行都锁了,可判定依据是跨多行的聚合(某队员当年全部考勤单的贡献值总和 / 某队员是否已入队),没有任何单行锁能锁住它 —— 两个事务各读各的、各写各的,合起来违反不变量(write skew)。

  | 落点 | 修复前 | 修复后 |
  |---|---|---|
  | Admin `attendances.edit` / `softDelete` | Admin 面既不取 Activity 聚合锁,也不认领 records 引用的报名 | **两条 surface 都无条件取** Activity 锁;managed 仍先判权再暴露 Sheet 存在性 |
  | `submit` / `edit` 的报名认领 | `submit` 只 claim 不复读;`edit` 连 claim 都没有 | 共用 `claimAndRecheckRegistrations`:排序去重 claim → **按同一批 id 复读** → 重判归属活动/队员/状态/岗位时段 |
  | `finalApprove` 入队里程碑 | 只 claim 当前 Sheet,而阈值判定跨该队员当年全部 approved Sheet | 读贡献快照前取共享 member 键;`reopen` 同键(它是同一聚合的反向写方) |
  | `cancelMy` 通知快照 | 活动标题/发布人在取锁**之前**读,却写进 durable intent | 改到 claim + 证据守卫之后读 |
  | Team Join `submit` | 用普通读判「未入队」,随后建行 | 事务第一步取 member 键,再判、再建行 |
  | Team Join final join | 只终结目标那一条申请 | 同事务按 `id ASC` 终结同队员其它 live 申请为 `rejected` + `eliminationStage='already-enrolled'`,逐条写 `team-join-application.supersede` |

  **共同线性化键做成了一个原语**:`src/common/prisma/member-advisory-lock.util.ts` 的 `lockMembersForWrite` —— 队员维度只允许存在**一把**键(单参数 `hashtext(memberId)` advisory 空间;PostgreSQL 的单参数与双参数 advisory 锁互不冲突,混用等于悄悄分裂成两把)。既有的 `TimeOverlapPolicy.lockMembersForOverlapCheck` 改为委托它,语义与调用位置零变化。

  **锁序**(修完后各族持锁顺序;两族唯一交点是 member 键,故无环):
  考勤写 `Activity 行锁 → Sheet claim → Registration claim → member 键`;考勤终审 `Sheet claim → member 键`;
  入队 `member 键 → Application 行锁 → Cycle → source → Member 行锁 → 同人残留 Application`。
  入队那把键**必须**在任何 Application 行锁之前取:同一队员可同时有两条 approved 申请,两个终审各锁一条再反向争 Member,加上同人终态级联正好凑成 40P01。行锁图本身逐字未动。

  ⚠️ **行为变更**:① 一键入队会把该队员名下其它进行中/已通过的入队申请一并终结(依据是「这个人已经是队员了」,**不是**「轮关闭了」—— 关轮不使 approved 资格失效那条契约不变,已由 e2e 锁住);② Admin 编辑/删除考勤单现在无条件持 Activity `FOR UPDATE`,同活动的并发考勤单写多一层串行。

  **真并发 e2e**(4 个新 spec,均为两个 Nest app = 两条真实连接,含「两条独立连接」元断言;每条都在修复前红):`attendance-admin-edit-registration-concurrency` · `team-join-enrollment-lifecycle-concurrency` · `attendance-final-approve-contribution-milestone-concurrency` · `registration-cancel-my-locked-snapshot-concurrency`。新增两条**全库巡检不变量**:live 考勤记录不得挂在非 pass/已软删报名上;已入队队员名下不得有 live 入队申请。

  **注释与执行位对齐(S5)**:`attendance.recorded`「audit 失败 → 事务回滚 → 业务事件随之回滚」是**错的** —— 它只是一次立即执行的 Logger 输出,数据库回滚撤不回日志;注释已改正并指明可回滚事件的唯一落点是 notification outbox。另 3 组 stale comment(App 报名「容量满拒绝」/「仅 pending|pass 可取消」、final join「消费评估延长期」)按运行时改正。
