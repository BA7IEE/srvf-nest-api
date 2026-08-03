import { Prisma } from '@prisma/client';

import { BizCode } from '../exceptions/biz-code.constant';
import { BizException } from '../exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';

type PrismaTx = Prisma.TransactionClient;
type InteractiveClient = Pick<PrismaService, '$transaction'>;

/**
 * **单次**锁等待的预算(毫秒)。注意是「单次」:`lock_timeout` 是 PostgreSQL 的
 * per-acquisition 语义,不是整段事务的累计上限(见 MEMBER_TX_TIMEOUT_MS 的注释)。
 */
export const MEMBER_LOCK_WAIT_BUDGET_MS = 4_000;

/**
 * 事务体内**业务工作**的预算(毫秒)—— 不含任何锁等待。
 *
 * 实测基数(2026-08-01,本机 + 本地 Postgres):本仓单张考勤单的规模上限 200 人,
 * 批量化后一次终审 **14 次 SQL / 222 ms**,且与人数无关(M3 已把 N+1 砍掉)。
 * 取 3000ms ≈ 13× 余量,给托管库的网络往返、冷缓存与并发负载留空间。
 *
 * ⚠️ 它**不是**给 N+1 兜底的额度。批量化的判据仍然是 **SQL 次数**
 * (`test/e2e/attendance-final-approve-scale-isolation.e2e-spec.ts` 的 `MAX_TX_QUERIES < 40`),
 * 而本常量同时是那条 spec 的耗时上限 —— 谁想靠「调大预算」顶过一次退化,
 * 先要过 SQL 次数那一关,而次数关调不了。
 */
export const MEMBER_TX_WORK_BUDGET_MS = 3_000;

/**
 * 交互事务的**显式**总预算 = 一次完整锁等待 + 业务工作预算(M3 遗留 P2,2026-08-01)。
 *
 * 修的是什么:上一版没写 timeout,于是吃 Prisma 默认的 **5s**。而 `lock_timeout` 已经
 * 先占了 4s —— 真正排过一次队的事务,留给业务的只剩 1s,而 200 人终审实测就要 222ms,
 * 慢一个数量级的库(托管实例、冷缓存、并发高峰)当场跑穿。跑穿的结果是 P2028 → 50000
 * 「服务器内部错误」:既不是事实(它只是排过队),也不可重试 —— 正是 M3 花力气从
 * 500 改成 40901 的那一类失败,从另一条路又回来了。两个预算必须一起写,不能一个显式
 * 一个继承默认值。
 *
 * ⚠️ **已知残留,刻意不在本条里解**:`lock_timeout` 是 per-acquisition 的,
 * 而 finalApprove 这条路径上有**多个**会阻塞的取锁点(`claimAtStatus` 的
 * `FOR NO KEY UPDATE` → `lockMembersForWrite` 的 advisory 键 → 写侧 FK 的
 * `FOR KEY SHARE`)。串行等待会**相加**,极端情况仍可能越过本预算 → P2028。
 * 本条把「等一次 + 干完活」钉进预算(实测把 3.0s + 5.8s 两段串行等待的场景从
 * P2028 救成业务码),但没有把「等 N 次」也纳入 —— 那需要改成累计 deadline
 * 或 NOWAIT + 重试,是一次独立的设计变更,不夹带在这条里。
 * 执行位:`attendance-final-approve-scale-isolation.e2e-spec.ts` 的 ④ 两例。
 */
export const MEMBER_TX_TIMEOUT_MS = MEMBER_LOCK_WAIT_BUDGET_MS + MEMBER_TX_WORK_BUDGET_MS;

/** PostgreSQL 55P03 = lock_not_available(等锁超过 lock_timeout)。 */
function isLockWaitTimeout(err: unknown): boolean {
  if (err instanceof BizException) return false;
  const meta = (err as { meta?: { code?: unknown; message?: unknown } } | null)?.meta;
  if (meta && String(meta.code) === '55P03') return true;
  const text = err instanceof Error ? `${err.message}` : String(err);
  return text.includes('55P03') || text.includes('canceling statement due to lock timeout');
}

/** PostgreSQL 40P01 = deadlock_detected(数据库主动中止环上的一个事务)。 */
function isDeadlock(err: unknown): boolean {
  if (err instanceof BizException) return false;
  const meta = (err as { meta?: { code?: unknown; message?: unknown } } | null)?.meta;
  if (meta && String(meta.code) === '40P01') return true;
  const text = err instanceof Error ? `${err.message}` : String(err);
  return text.includes('40P01') || text.includes('deadlock detected');
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
 *
 * **40P01 也翻**(万人锁原型收口,#906 §5.1,2026-08-04)。此前这里只翻 55P03,
 * 死锁会以未映射错误冒出去 → 50000。两者的共同点是「重发就会成功」,所以都该给可重试
 * 业务码;不同点是运维语义 —— 55P03 是负载、40P01 是锁序缺陷,因此给**两个**码
 * (40901 / 40902),不归一。
 *
 * ⚠️ 翻译不替代锁序纪律:`lockMembersForWrite` 的批内定序仍由
 * `test/e2e/member-advisory-lock-order.e2e-spec.ts` ① 以「零死锁」为判据硬顶。
 * 本闸只覆盖批内定序**管不到**的那部分(调用方分两段交叉取锁、FK / 审计写入的隐式锁边)。
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
    if (isDeadlock(err)) throw new BizException(BizCode.CONCURRENT_WRITE_DEADLOCK);
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
 * - 一条 SQL 批量取,查询次数不随人数增长;**排序键必须就是锁键** ——
 *   `ORDER BY hashtext(member_id), member_id`。锁函数在 Sort **之上**的 Result 节点求值
 *   (PostgreSQL 刻意不把 volatile 函数下推,`EXPLAIN VERBOSE` 可见 Result → Sort),
 *   因此取锁顺序确实跟随 ORDER BY。`hashtext` 是 IMMUTABLE,可以直接当排序键;
 *   并列的 `member_id` 只是把它补成全序(碰撞时两行其实是同一把锁,先后无所谓)。
 *
 *   ⚠️ 上一版这里写的是 `ORDER BY member_id`,并声称「JS 侧 `.sort()` 与 SQL 侧
 *   ORDER BY 两层同向 ⇒ 不同批次之间不会反向取锁」。**那个论证是错的**:两层同向的是
 *   `member_id`,而锁键是 `hashtext(member_id)` —— 排序键与锁键不是同一个东西。
 *   一旦 a ≠ b 而 key(a) == key(b),再有 c 满足 a < c < b:
 *     批次 {a, c} 取序 = key(a), key(c);批次 {c, b} 取序 = key(c), key(a)
 *   两者反序,构成死锁边。#906 §5.1 用真实碰撞对
 *   `c841bb8f66366ad0ab58eda83` / `c86b3e165b8154656a71ffe8a`(hashtext 同为 -1901144566)
 *   实测触发了 40P01;万人规模每场出现碰撞对的概率实测 **0.90%**。
 *   改按锁键定序之后,任意两个批次对同一组键的取序恒同 ⇒ 批内不可能反序。
 *   执行位:`test/e2e/member-advisory-lock-order.e2e-spec.ts` ①(判据 = 零死锁)。
 *
 *   ⚠️ 定序**只**约束单次批量调用内部。调用方在同一事务里分两段取键、而两段之间
 *   与别人交叉,仍可能成环 —— 那不是本函数能修的,归宿是 40902(见
 *   `withBoundedMemberLockWait`),执行位是同一 spec 的 ③。
 *
 *   JS 侧 `[...new Set()]` 去重是必需的(同 id 重复入参);其后的 `.sort()` **与取锁顺序
 *   无关**(SQL 会重排),只为让同一组入参恒生成同一段 SQL 文本,便于日志比对。
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
 * ③ **显式事务预算**(见 MEMBER_TX_TIMEOUT_MS):Prisma 默认 5s 减去 4s 锁预算只剩 1s,
 *    排过队的事务会以 P2028 → 500 收场 —— ② 的收益在这条路上被原样抵消掉。
 *    三件事必须一起写死在这里:任何一个留给默认值,另外两个就白做。
 */
export async function runMemberLinearizedTransaction<T>(
  prisma: InteractiveClient,
  body: (tx: PrismaTx) => Promise<T>,
): Promise<T> {
  return prisma.$transaction((tx) => withBoundedMemberLockWait(tx, () => body(tx)), {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    timeout: MEMBER_TX_TIMEOUT_MS,
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
      ORDER BY hashtext(member_id), member_id
    `,
  );
}
