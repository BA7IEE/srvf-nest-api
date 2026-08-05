import { Prisma } from '@prisma/client';

// ===== 活动改造 v1.1 第 2 批第五刀:「万人统一生效恒串行」的执行位 =====
//
// 🔴 **这不是一条注释,是一道会变红的闸。**
//
// ## 它守的是什么
//
// `lockMembersForWrite` 每个队员取一把 `pg_advisory_xact_lock`,而 advisory 锁占用
// PostgreSQL 的**共享**锁表 —— 全库一份,不是每连接一份。第 0 批锁原型
// ([`lock-probe`](../../../docs/archive/reviews/activity-business-overhaul-v1.1-lock-probe.md) §6)
// 实测:
//
//   - 公式保底 = `max_locks_per_transaction × (max_connections + max_prepared_transactions)`
//               = 64 × 200 = **12800**(本仓实际配置,查 `pg_settings` 核实);
//   - 一场万人生效实占 **10000 把**(在 10000 规模上数 `pg_locks` 证实)= 保底的 78%;
//   - 单事务实测上限 ~22000(空载,**不是保证**,会随其它 backend 用量缩水)。
//
// ⇒ **两场万人并发即越过文档保证线,三场必然 `out of shared memory`**。
//    而它是**硬 ERROR**:不走 `lock_timeout` → 55P03 → 40901 那条可重试路径,
//    PostgreSQL 直接中止事务。也就是说,缺了这道闸,第二场统一生效不会"排队",
//    而是在半路炸掉 —— 炸掉的那一刻,第一场可能已经改了一半的 day-state。
//
// ## 维护者 2026-08-04 的拍板
//
// 三条候选(①提高 `max_locks_per_transaction` ②接受「同一时刻只允许一场万人生效」
// ③重新设计锁粒度)中**取 ②**,理由:本队真实规模远低于万人(合同 §13 规模门里
// 30 人是真人档,500/2000/10000 全是模拟),① 要动生产库配置并重启、③ 要动合同,
// ② 零成本且可逆。逐字记录在 `docs/current-state.md`。
//
// ⚠️ 拍板同时写死了一条**设计约束**:
//    > 简单的人数阈值 T 并不严格成立 —— 4999 + 8000 两场都在阈值下却合计
//    > 12999 > 12800,判据得按**并发总量**而不是单场人数。
//
//    本模块因此**不做人数阈值**,做的是**锁槽预算信号量**:预算是全局的、按
//    并发总量扣减的。`requiredSlots(4999) + requiredSlots(8000) = 5 + 8 = 13 > 10`
//    ⇒ 那两场**一定**有一场进不来。执行位见 `ledger-commit-lock-budget.spec.ts` ③。
//
// ## 形态:全局 advisory 槽位 + `pg_try_advisory_xact_lock`
//
// - **双参数** advisory 空间(`(LOCK_BUDGET_NAMESPACE, slotIndex)`)。PostgreSQL 的
//   单参数与双参数 advisory 锁**互不冲突**,而 `lockMembersForWrite` 用的是单参数
//   (`hashtext(memberId)`)⇒ 两个锁域在结构上不可能互相占用。
//   ❌ 这**不是**新建 member+date advisory lock(合同 §0.4 死线):槽位与队员、
//      与日期都无关,它是一个**全局**的并发预算,粒度是"整场生效"。
// - **try**(非阻塞)而不是阻塞取锁:非阻塞的取锁边不可能出现在死锁环上,
//   所以这道闸自己绝不会制造 40P01。代价是败者立刻收码而不是排队 —— 这正是想要的:
//   429 + "稍后重试" 比"排 4 秒队再收 40901"对调用方更清楚。
// - **事务级**(`_xact_`):随事务提交/回滚自动释放,没有手工解锁的漏放路径。
//   中途失败(拿了 5 槽发现第 6 槽拿不到)时事务立刻回滚,已拿的槽同时释放。
//
// ## 预算数字怎么来的
//
//   `TOTAL_SLOTS × MEMBERS_PER_SLOT = 10 × 1000 = 10000` 把 advisory 锁,
//   相对公式保底 12800 留 **2800 把余量**给同时在跑的其它 backend(每个 backend
//   的普通查询也要占表级锁槽)。
//
// 由此得到两条硬性质,`ledger-commit-lock-budget.spec.ts` 逐条钉住:
//   (a) 任意并发组合下,本闸放行的队员锁总数 ≤ 10000 < 12800 —— 因为
//       `requiredSlots(m) ≥ m / MEMBERS_PER_SLOT`,槽位总量又只有 10;
//   (b) 单场超过 10000 人时 `requiredSlots > TOTAL_SLOTS` ⇒ **恒不可能通过**。
//       这是刻意的:那种规模在当前 PG 配置下本来就没有保证,与其让它在
//       `out of shared memory` 上炸(不可重试、可能已改了一半 day-state),
//       不如在动任何数据之前就用具名码拒掉,把决定权交回维护者(合同 §5.13 末段
//       原话:「不允许扩大超时掩盖;需要升级仓库锁框架或重新拍板」)。

/**
 * 双参数 advisory 锁的**第一个**参数(命名空间)。
 *
 * 取一个固定的、不与任何业务 id 派生值碰撞的常量。本仓当前只有这一处用双参数
 * advisory 锁;日后若有第二处,必须另取命名空间并在此处登记 —— 两处共用一个命名空间
 * 等于把两个不相干的并发预算搅在一起。
 */
export const LEDGER_COMMIT_LOCK_NAMESPACE = 20250805;

/** 一个槽位代表多少把队员 advisory 锁。 */
export const LEDGER_COMMIT_MEMBERS_PER_SLOT = 1_000;

/** 全局槽位总数。`TOTAL × MEMBERS_PER_SLOT` 即并发队员锁预算上限。 */
export const LEDGER_COMMIT_LOCK_SLOT_COUNT = 10;

/**
 * PostgreSQL 共享锁表的**公式保底**(第 0 批实测本仓配置:64 × 200)。
 *
 * 只用于自证:本模块的预算必须严格小于它,且要留出余量。它不是运行期读取的配置 ——
 * 生产库若改了 `max_locks_per_transaction`,这里也要跟着改并重新拍板。
 */
export const POSTGRES_SHARED_LOCK_TABLE_FLOOR = 12_800;

/**
 * 一次生效需要占用的槽位数。
 *
 * `ceil(memberCount / MEMBERS_PER_SLOT)`,且**至少 1** —— 零人的批次不该存在,
 * 但真出现时也不能让它"零成本"地绕过闸(那会让"同时可以有无限多个空批次在跑"成立,
 * 而每个空批次仍然会去拿 Activity / Run / Version / Batch 四把行锁)。
 */
export function ledgerCommitRequiredSlots(memberCount: number): number {
  if (!Number.isInteger(memberCount) || memberCount < 0) {
    throw new RangeError(`ledgerCommitRequiredSlots 收到非法人数:${memberCount}`);
  }
  return Math.max(1, Math.ceil(memberCount / LEDGER_COMMIT_MEMBERS_PER_SLOT));
}

/** 这一场自己就装不下 ⇒ 重试无用,须运维/合同处置(与"此刻并发满了"分开)。 */
export function ledgerCommitExceedsTotalBudget(memberCount: number): boolean {
  return ledgerCommitRequiredSlots(memberCount) > LEDGER_COMMIT_LOCK_SLOT_COUNT;
}

/**
 * 在当前事务里**尝试**占下 `requiredSlots` 个槽位,返回实际占到的个数。
 *
 * 🔴 关键性质:**只占需要的那么多,不贪**。`LIMIT` 让执行器在拿够行之后停止向下拉取,
 *    于是 `pg_try_advisory_xact_lock`(VOLATILE,不会被下推或重排)只被调用到够为止 ——
 *    一次 2 槽的生效不会把 10 个槽全锁上。
 *    ⚠️ 这条依赖 executor 的短路行为,不是推理出来的:
 *    `test/e2e/activity-ledger-posting-concurrency.e2e-spec.ts` ① 用 `pg_locks` 数
 *    本 backend 实际持有的 advisory 锁个数,**正面**证明它恰好等于 requiredSlots。
 *
 * 占不满时调用方必须让事务回滚 —— 事务级 advisory 锁没有"手工解锁"这条路,
 * 回滚就是唯一的释放方式(也因此不存在漏放)。
 */
export async function tryAcquireLedgerCommitSlots(
  tx: Prisma.TransactionClient,
  requiredSlots: number,
): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ slot: number }>>(Prisma.sql`
    SELECT s AS slot
    FROM generate_series(0, ${LEDGER_COMMIT_LOCK_SLOT_COUNT - 1}) AS s
    WHERE pg_try_advisory_xact_lock(${LEDGER_COMMIT_LOCK_NAMESPACE}::int, s::int)
    LIMIT ${requiredSlots}
  `);
  return rows.length;
}
