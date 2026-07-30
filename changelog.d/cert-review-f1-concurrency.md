- **发号 / 申报 / 撤销三条写路径的并发收口(2026-07-30;证书标准库跨模型评审 findings F1,冻结稿 [`certificate-standard-library-t0-review.md`](docs/archive/reviews/certificate-standard-library-t0-review.md) §8.3 / §8.5)**:零新增端点、零新增权限码、零 schema 变更(Endpoint 恒 438 · 权限码恒 222 · Migration 恒 67)。

  被修的是**同一个形状**在四处重复:「锁了行,但判定依据仍是锁**之前**读到的那份快照」。锁本身不刷新快照 —— 等锁期间提交的撤销 / 换绑 / 发号在锁释放后才可见,而代码从不回头看。所以修法不是在四处各补一次复读,而是把范式做成一个只能整体调用的函数:`src/modules/recruitment/recruitment-application-lock.ts`,`锁(稳定顺序) → 锁后复读整行 → 判定状态与归属 → 迁移 → CAS 收尾`。第四步复用既有的 `claimAtStatus`(`WHERE statusCode = ?` 的条件行锁),两者成对使用。

  | 落点 | 修复前 | 修复后 |
  |---|---|---|
  | 公开提交 / 重传 / 撤回 Claim | `lockApplication()` 只 `SELECT id FOR UPDATE` 且返回 void;凭证在事务外解析,锁后既不复核状态也不复核归属 | `lockOwnActiveApplicationOrThrow()`:锁 + 复读 + 归属复核 + 非终态断言 |
  | 批量发号 | 「谁可发号」在事务**外**算完,事务内按 id 无条件写 `promoted` | 与单人共用 `lockPromotableApplicationOrThrow()`:`claimAtStatus` 条件行锁 + 锁后复读 + 锚点/建档字段复核 |
  | 单人发号 | 只在事务外判过一次 `statusCode` | 同上(**同一内核**,不是两份实现) |
  | 发号读 Claim | `findMany(APPROVED)` → 对这批 id `FOR UPDATE` → 循环用**锁前**那份 | 锁全部未软删 Claim(id ASC)→ **锁内重新查询** → 再判定 |
  | 报名终态写入 | `update({ where: { id } })` | `updateMany({ where: { id, statusCode: 'publicity' } })` + 命中数断言 |

  **一条独立于竞态的缺陷**:发号此前只把 `APPROVED` Claim 搬成 `PROMOTED`,`SUBMITTED` / `NEEDS_INFO` / `REJECTED` 原封不动留在一份已经终态的报名下 —— 它们永远不会再变成证书,却仍可被审核、仍可签发证据 URL。现在发号收尾把非 `PROMOTED` 的一并级联成 `WITHDRAWN`,与整份撤销那条路径逐字同口径(审计新增 `cascadedWithdrawnClaimCount`,只记条数)。

  ⚠️ **行为变更**:并发撤销与发号相撞时,发号**整批**以 `28041` 失败而不是跳过该行。号段已按 N 原子自增,事务内少建一个人就会留下永久空洞,而「号段连续无空洞」是本模块的冻结不变量 —— 所以只能整批回滚(seq 随之复位)。

  **真并发 e2e**(`test/e2e/recruitment-certificate-concurrency.e2e-spec.ts`,6 条 + 1 条连接独立性自证):两个 Nest app = 两条真实连接,blocker 事务占住目标行把被测操作逼进锁等待队列,查 `pg_stat_activity` 确认「它真的在等锁」再放行 —— 不用 sleep(不够就是假绿,太长就是慢)。6 条在修复前**全部失败**、修复后全部通过。含一条数据库级全表巡检:终态报名下不得存在非终态 Claim。
