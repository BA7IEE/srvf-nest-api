import { Prisma } from '@prisma/client';

import { BizCode } from '../exceptions/biz-code.constant';
import { BizException } from '../exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';

type PrismaTx = Prisma.TransactionClient;
type InteractiveClient = Pick<PrismaService, '$transaction'>;

/**
 * 单次锁等待的预算(毫秒)。必须**明显小于** Prisma 默认 5s 交互事务预算 ——
 * 否则先撞的仍是事务超时(P2028 → 50000),这条闸等于没设。
 */
export const MEMBER_LOCK_WAIT_BUDGET_MS = 4_000;

/** PostgreSQL 55P03 = lock_not_available(等锁超过 lock_timeout)。 */
function isLockWaitTimeout(err: unknown): boolean {
  if (err instanceof BizException) return false;
  const meta = (err as { meta?: { code?: unknown; message?: unknown } } | null)?.meta;
  if (meta && String(meta.code) === '55P03') return true;
  const text = err instanceof Error ? `${err.message}` : String(err);
  return text.includes('55P03') || text.includes('canceling statement due to lock timeout');
}

/**
 * 给一段事务体设**有界**锁等待,并把超时翻译成可重试的业务错误(M3;并发复审 P1)。
 *
 * 修的是什么:本仓所有跨行不变量都靠 `lockMembersForWrite` 的队员键串行化。键上排队本身
 * 是对的,但排队时长此前**无界** —— 一直等到 Prisma 5s 交互事务预算耗尽,抛 P2028,
 * 被全局过滤器映射成 50000「服务器内部错误」。对调用方而言那是不可重试的 500,
 * 对排障而言它看起来像服务坏了,而真相只是「有人在你前面」。
 *
 * 做法:`SET LOCAL lock_timeout` —— 随事务结束自动复原,不污染连接池里的会话。
 * 它作用于**本事务此后的全部锁等待**(advisory 键、`FOR UPDATE` 行锁都算),
 * 所以必须包住整个事务体,而不是只包住取键那一行;只包取键的话,后面的行锁超时
 * 会以未映射的 P2010 冒出来,反而更糟。
 *
 * ⚠️ 与显式 `ReadCommitted` 是一对:两者都只在「先取键、再读聚合」这个模式下才有意义。
 * 缺 RC 时快照停在取键之前,排到队也读不到前一个事务刚提交的事实(write skew 复活);
 * 缺本闸时排队会以 500 收场。
 */
export async function withBoundedMemberLockWait<T>(
  tx: PrismaTx,
  body: () => Promise<T>,
): Promise<T> {
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${MEMBER_LOCK_WAIT_BUDGET_MS}`);
  try {
    return await body();
  } catch (err) {
    if (isLockWaitTimeout(err)) throw new BizException(BizCode.CONCURRENT_WRITE_LOCK_TIMEOUT);
    throw err;
  }
}

/**
 * 队员维度的**唯一**事务级 advisory 锁键(并发审计 K2 / K3 收口)。
 *
 * 存在的理由:有几类不变量既不属于某一行,也不属于某一个聚合根 ——
 * 「同一队员的考勤时间不重叠」「同一队员的贡献值跨 Sheet 汇总是否跨过入队门槛」
 * 「同一队员同时只能有一条入队通路」。它们的判定依据横跨多行,任何单行锁都锁不住;
 * 缺共同锁时两个事务各读各的、各写各的,合起来违反不变量(write skew)。
 *
 * 口径(不得各写各的):
 * - 键固定为 `hashtext(memberId)` 的**单参数** advisory 空间。PostgreSQL 的单参数与
 *   双参数 advisory 锁互不冲突,混用等于悄悄分裂成两把锁,所以这里只留一种写法。
 * - 一条 SQL 批量取,查询次数不随人数增长;`ORDER BY member_id` 固定取锁顺序。
 *   锁函数在 Sort **之上**的 Result 节点求值(PostgreSQL 刻意不把 volatile 函数下推),
 *   因此取锁顺序确实跟随 ORDER BY;JS 侧 `[...new Set()].sort()` 是第二层确定性排序。
 *   两层同向 ⇒ 不同批次之间不会反向取锁。
 * - `::text` 是必需的:`pg_advisory_xact_lock` 返回 `void`,Prisma 反序列化不了 void 列。
 * - 事务级(`_xact_`):随事务提交/回滚自动释放,调用方不需要也不允许手工解锁。
 *
 * ⚠️ 取锁位置必须与既有路径同向。当前全仓约定:
 * 「Activity / AttendanceSheet 等**聚合行锁**在前,member advisory 键在后」。
 * team-join 是唯一例外且必须如此 —— 它在任何 Application 行锁之前取,
 * 否则同一队员的两条 final join 会各持一条 Application 行再反向争 Member,形成 40P01。
 */
/**
 * 「队员维度线性化」事务的**唯一**开启方式(M3;并发复审 P1)。
 *
 * 凡是事务体内会调用 `lockMembersForWrite` 的写路径,都必须经这里开事务。它一次钉死两件
 * 分开就不成立的事:
 *
 * ① **显式 ReadCommitted**。取到键之后要重读跨行聚合(贡献值、归属、live 申请),
 *    而 PostgreSQL 的 REPEATABLE READ 在事务的第一条语句就固定了快照 —— 排队排到了,
 *    读到的仍是排队之前的世界,write skew 原封不动地复活。测试库默认 RC 会把这个前提
 *    完全掩盖:同一份代码在默认 RR 的库上跑就是错的,而没有任何用例会红。
 *    所以隔离级别必须**写在代码里**,不能继承库默认值。
 * ② **有界锁等待**(见 withBoundedMemberLockWait):排队超时以 40901 收场,不是 500。
 */
export async function runMemberLinearizedTransaction<T>(
  prisma: InteractiveClient,
  body: (tx: PrismaTx) => Promise<T>,
): Promise<T> {
  return prisma.$transaction((tx) => withBoundedMemberLockWait(tx, () => body(tx)), {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  });
}

export async function lockMembersForWrite(
  tx: PrismaTx,
  memberIds: readonly string[],
): Promise<void> {
  const orderedIds = [...new Set(memberIds)].sort();
  if (orderedIds.length === 0) return;
  await tx.$queryRaw<Array<{ locked: string }>>(
    Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtext(member_id))::text AS locked
      FROM (VALUES ${Prisma.join(orderedIds.map((memberId) => Prisma.sql`(${memberId})`))})
        AS member_ids(member_id)
      ORDER BY member_id
    `,
  );
}
