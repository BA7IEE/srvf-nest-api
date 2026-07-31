import { Prisma } from '@prisma/client';

type PrismaTx = Prisma.TransactionClient;

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
