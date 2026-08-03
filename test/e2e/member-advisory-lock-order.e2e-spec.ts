import { Prisma, PrismaClient } from '@prisma/client';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import {
  MEMBER_LOCK_WAIT_BUDGET_MS,
  lockMembersForWrite,
  runMemberLinearizedTransaction,
} from '../../src/common/prisma/member-advisory-lock.util';
import { assertTestDatabaseUrl } from '../setup/test-db';

// ─────────────────────────────────────────────────────────────────────────────
// `lockMembersForWrite` 的**取锁顺序**行为锁(万人锁原型 #906 §5.1 的收口)。
//
// 修的是什么:上一版用 `ORDER BY member_id` 固定取锁顺序,但真正的锁键是
// `hashtext(member_id)` —— **排序键与锁键不是同一个东西**。一旦出现 hashtext 碰撞
// (a ≠ b 而 key(a) == key(b)),再有第三个 c 满足 a < c < b:
//   批次甲 {a, c} 的取锁序 = key(a), key(c)
//   批次乙 {c, b} 的取锁序 = key(c), key(b) == key(a)
// 两者**反序**,构成死锁边。#906 实测碰撞率:万人规模每场 0.90%。
//
// 本 spec 是那条边的执行位。三例分工不同,一条都不能删:
//   ① **护栏**:显式闸门把两个批次钉在「各持一把、各等一把」的位置,放闸后必成环。
//      判据 = 两个事务都要成功。把 `ORDER BY hashtext(member_id), member_id` 改回
//      `ORDER BY member_id`,本例立刻红(见 §DoD 3 自证)。
//   ② **反向对照**:同一套闸门构造,只把碰撞对里的 b 换成不碰撞的 id ——
//      修复前也绿。它排除「是闸门构造本身在造死锁」这种解释:①的红必须来自碰撞。
//   ③ **残留 40P01 的归宿**:取锁顺序只约束**单次批量调用内部**。调用方若分两段
//      交叉取锁(先 [m1] 后 [m1,m2],对面先 [m2] 后 [m2,m1]),任何批内定序都救不了 ——
//      那是真实残留。它必须以**可重试业务码**收场,而不是未映射错误 → 50000。
//
// 为什么不建任何 fixture:advisory 键是 member id 字符串的纯函数,不查表、无外键。
// 本 spec 因此只碰 advisory 锁空间,不碰任何业务表,也不需要 resetDb。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * #906 §5.1 在 40 万个 cuid 形状 id 里找到的**真实** hashtext 碰撞对。
 * 两者 `hashtext` 同为 `-1901144566`。用例 ① 的成环完全依赖这一条,
 * 所以「碰撞仍然成立」是前提断言,不是注释里的承诺(见 ⓪)。
 */
const COLLIDING_LOW = 'c841bb8f66366ad0ab58eda83';
const COLLIDING_HIGH = 'c86b3e165b8154656a71ffe8a';

/**
 * 夹在碰撞对之间的第三个 id —— 它提供两个批次共享的**第二把**锁。
 * `~` 是排在十六进制字符之后的 ASCII 字符,所以 `low < low~ < low~~ < … < high`;
 * 但顺序判据不靠 JS 的 UTF-16 序推断,由 ⓪ 用**库的 collation** 亲自判。
 */
const MIDDLE = `${COLLIDING_LOW}~~`;

/** 闸门 id:排在 low 与 middle 之间 —— 让批次甲拿到 key(low) 之后**必然**停住。 */
const GATE_LOW = `${COLLIDING_LOW}~`;
/** 闸门 id:排在 middle 与 high 之间 —— 让批次乙拿到 key(middle) 之后**必然**停住。 */
const GATE_HIGH = `${MIDDLE}~`;
/** ② 用:排在 GATE_HIGH 之后、且**不与** low 碰撞的 id。 */
const NON_COLLIDING_HIGH = `${MIDDLE}~~`;

/** ③ 用:两个普通 id,不需要碰撞 —— 交叉两段取锁与碰撞无关。 */
const CROSS_ONE = 'clock-order-cross-one';
const CROSS_TWO = 'clock-order-cross-two';

/**
 * 等两个被测事务**真的**排到闸门上的预算。必须显著小于单次锁等待预算,
 * 否则被测事务会先以 55P03 → 40901 收场,用例就退化成「等超时了」而不是「反序取锁」。
 */
const WAITER_BUDGET_MS = 3_000;
const CASE_TIMEOUT_MS = 60_000;

type Outcome = 'ok' | 'deadlock' | 'lock-timeout' | `other:${string}`;

function brief(err: unknown): string {
  if (err instanceof BizException) return `BizException(${err.biz.code})`;
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** 未经翻译的原始 40P01 形态(与 util 内 `isDeadlock` 同形)。 */
function looksLikeRawDeadlock(err: unknown): boolean {
  const meta = (err as { meta?: { code?: unknown } } | null)?.meta;
  if (meta && String(meta.code) === '40P01') return true;
  const text = err instanceof Error ? err.message : String(err);
  return text.includes('40P01') || text.includes('deadlock detected');
}

/**
 * 把一次事务的结局归成几类。
 *
 * ⚠️ 判据必须**同时**认「未映射的原始 40P01」与「翻译后的业务码」两种形态:
 * 用例 ① 是 red-first 写的 —— 修复前 40P01 以原始 Prisma 错误冒出来,修复后
 * (本刀同时落地的 DoD 6)是 `CONCURRENT_WRITE_DEADLOCK`。两种都必须归成 'deadlock',
 * 否则「红」会从断言退化成异常,而**探针自己崩掉 ≠ 断言变红**。
 *
 * ⚠️ 也正因为它抹平这两种形态,③ 的翻译判据**不能**用它 —— 那条用原始错误对象断言。
 */
function classify(err: unknown): Outcome {
  if (err === undefined) return 'ok';
  if (err instanceof BizException) {
    if (err.biz.code === BizCode.CONCURRENT_WRITE_DEADLOCK.code) return 'deadlock';
    if (err.biz.code === BizCode.CONCURRENT_WRITE_LOCK_TIMEOUT.code) return 'lock-timeout';
    return `other:${brief(err)}`;
  }
  if (looksLikeRawDeadlock(err)) return 'deadlock';
  return `other:${brief(err)}`;
}

describe('lockMembersForWrite 取锁顺序(hashtext 碰撞下不得反序)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /**
   * 占住一组 member 键直到显式放闸 —— 闸门事务是**环境**,不是被测对象,
   * 所以走裸 `$transaction` 并给足预算,不受 `MEMBER_LOCK_WAIT_BUDGET_MS` 约束。
   * 取键仍然走真实的 `lockMembersForWrite`:闸门与被测走同一套 key 计算,
   * 不另写一份手搓 SQL(手搓 SQL 守的是 PostgreSQL 行为,不是本仓代码)。
   */
  function holdMemberKeys(memberIds: readonly string[]): {
    acquired: Promise<void>;
    release: () => void;
    done: Promise<unknown>;
  } {
    let markAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = prisma.$transaction(
      async (tx) => {
        await lockMembersForWrite(tx, memberIds);
        markAcquired();
        await gate;
      },
      { timeout: 120_000, maxWait: 120_000 },
    );
    return { acquired, release, done };
  }

  /** 等到至少 `expected` 个会话卡在**未授予**的 advisory 锁上;等不到就硬失败。 */
  async function waitForAdvisoryWaiters(expected: number): Promise<void> {
    const deadline = Date.now() + WAITER_BUDGET_MS;
    let observed = -1;
    while (Date.now() < deadline) {
      const [row] = await prisma.$queryRaw<Array<{ waiting: number }>>(Prisma.sql`
        SELECT count(*)::int AS waiting
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      `);
      observed = row?.waiting ?? 0;
      if (observed >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`等不到 ${expected} 个 advisory 锁等待者(实际 ${observed})—— 闸门构造失效`);
  }

  /** 跑一个被测批次:走生产入口,只取键,不做别的。结局归类后返回。 */
  async function lockBatch(memberIds: readonly string[]): Promise<Outcome> {
    try {
      await runMemberLinearizedTransaction(prisma, (tx) => lockMembersForWrite(tx, memberIds));
      return 'ok';
    } catch (err) {
      return classify(err);
    }
  }

  it('⓪ 前提自证:碰撞真实存在,且 member_id 序确实是 low < gateLow < middle < gateHigh < high', async () => {
    const [row] = await prisma.$queryRaw<
      Array<{
        keyLow: number;
        keyHigh: number;
        keyMiddle: number;
        keyGateLow: number;
        keyGateHigh: number;
        keyNonColliding: number;
        orderedByCollation: boolean;
      }>
    >(Prisma.sql`
      SELECT hashtext(${COLLIDING_LOW}) AS "keyLow",
             hashtext(${COLLIDING_HIGH}) AS "keyHigh",
             hashtext(${MIDDLE}) AS "keyMiddle",
             hashtext(${GATE_LOW}) AS "keyGateLow",
             hashtext(${GATE_HIGH}) AS "keyGateHigh",
             hashtext(${NON_COLLIDING_HIGH}) AS "keyNonColliding",
             (${COLLIDING_LOW} < ${GATE_LOW}
              AND ${GATE_LOW} < ${MIDDLE}
              AND ${MIDDLE} < ${GATE_HIGH}
              AND ${GATE_HIGH} < ${NON_COLLIDING_HIGH}
              AND ${GATE_HIGH} < ${COLLIDING_HIGH}) AS "orderedByCollation"
    `);

    // 碰撞对仍然碰撞 —— 否则 ① 会变成一个什么都没证明的绿。
    expect(row.keyLow).toBe(row.keyHigh);
    // 顺序由**库的 collation** 判,不由 JS 推断:决定旧实现取锁顺序的正是 SQL 的 ORDER BY。
    expect(row.orderedByCollation).toBe(true);
    // 其余四把键两两不同:闸门必须是独立的第三、第四把锁,不能与被测键重合。
    expect(
      new Set([row.keyLow, row.keyMiddle, row.keyGateLow, row.keyGateHigh, row.keyNonColliding])
        .size,
    ).toBe(5);
    // ② 的对照 id 必须真的不碰撞,否则反向对照会跟 ① 一起红,失去对照意义。
    expect(row.keyNonColliding).not.toBe(row.keyLow);
  });

  it(
    '① 碰撞对 + 中间成员:两个批次并发取键,都必须成功(取锁顺序按锁键定序 ⇒ 不可能反序)',
    async () => {
      // 闸门同时占住 key(GATE_LOW) 与 key(GATE_HIGH)。
      // 旧实现(ORDER BY member_id)下:
      //   批次甲 [low, gateLow, middle] 取序 low → gateLow → middle
      //     ⇒ 先拿到 key(low),再卡在 gateLow 上;
      //   批次乙 [middle, gateHigh, high] 取序 middle → gateHigh → high
      //     ⇒ 先拿到 key(middle),再卡在 gateHigh 上。
      // 放闸后甲要 key(middle)(乙持有)、乙要 key(high) == key(low)(甲持有)⇒ 成环 40P01。
      // 新实现(ORDER BY hashtext(member_id), member_id)下:
      //   两个批次的键集合都含 key(low)==key(high) 与 key(middle),且**按同一把尺子定序**,
      //   谁先谁后一致 ⇒ 不可能成环。
      const gate = holdMemberKeys([GATE_LOW, GATE_HIGH]);
      await gate.acquired;

      const batchA = lockBatch([COLLIDING_LOW, GATE_LOW, MIDDLE]);
      const batchB = lockBatch([MIDDLE, GATE_HIGH, COLLIDING_HIGH]);

      // 自证前提:两个批次**真的**都排上了队。等不到就抛,不会静默退化成「没并发」。
      await waitForAdvisoryWaiters(2);
      gate.release();
      await gate.done;

      const outcomes = await Promise.all([batchA, batchB]);
      expect(outcomes).toEqual(['ok', 'ok']);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    '② 反向对照:同一套闸门构造,去掉碰撞后旧实现也不成环 ⇒ ① 的红只可能来自碰撞',
    async () => {
      const gate = holdMemberKeys([GATE_LOW, GATE_HIGH]);
      await gate.acquired;

      const batchA = lockBatch([COLLIDING_LOW, GATE_LOW, MIDDLE]);
      const batchB = lockBatch([MIDDLE, GATE_HIGH, NON_COLLIDING_HIGH]);

      await waitForAdvisoryWaiters(2);
      gate.release();
      await gate.done;

      expect(await Promise.all([batchA, batchB])).toEqual(['ok', 'ok']);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    `③ 残留:调用方分两段交叉取锁必然成环 —— 归宿是可重试的 ${BizCode.CONCURRENT_WRITE_DEADLOCK.code},不是未映射错误`,
    async () => {
      // 批内定序**只**约束一次批量调用内部。这里两侧各自先持一把、再要对面那把,
      // 任何排序键都救不了 —— 这是真实残留,所以它的判据是「翻译成什么」,
      // 不是「有没有死锁」。同时它也是 40P01 翻译位的执行位:
      // 若把 `isDeadlock` 分支从 `withBoundedMemberLockWait` 删掉,本例立刻红。
      let releaseOne = (): void => {};
      let releaseTwo = (): void => {};
      const heldOne = new Promise<void>((resolve) => {
        releaseOne = resolve;
      });
      const heldTwo = new Promise<void>((resolve) => {
        releaseTwo = resolve;
      });

      // 保留**原始**错误对象而不是先归类:本例的判据是「它是什么类型的异常」,
      // 归类会把「原始 40P01」与「翻译后的 40902」抹平成同一个字面量,判据就没了。
      type Attempt = { ok: true } | { ok: false; error: unknown };
      const settle = (promise: Promise<unknown>): Promise<Attempt> =>
        promise.then(
          (): Attempt => ({ ok: true }),
          (error: unknown): Attempt => ({ ok: false, error }),
        );

      const attemptOne = settle(
        runMemberLinearizedTransaction(prisma, async (tx) => {
          await lockMembersForWrite(tx, [CROSS_ONE]);
          releaseOne();
          await heldTwo;
          await lockMembersForWrite(tx, [CROSS_ONE, CROSS_TWO]);
        }),
      );

      const attemptTwo = settle(
        runMemberLinearizedTransaction(prisma, async (tx) => {
          await heldOne;
          await lockMembersForWrite(tx, [CROSS_TWO]);
          releaseTwo();
          await lockMembersForWrite(tx, [CROSS_TWO, CROSS_ONE]);
        }),
      );

      const attempts = await Promise.all([attemptOne, attemptTwo]);
      const failures = attempts.filter((attempt): attempt is { ok: false; error: unknown } => {
        return !attempt.ok;
      });

      // 自证前提:这一侧**真的**成了环 —— PostgreSQL 中止环上的一个事务,另一个照常提交。
      // 归类只用在这一条上(它只需要区分「死锁」与「别的失败」)。
      expect(failures.map((failure) => classify(failure.error))).toEqual(['deadlock']);

      // 判据的正体:被中止的那一侧拿到的必须是**业务异常**,而不是原始 Prisma 错误
      // (原始错误会被全局过滤器映射成 50000「服务器内部错误」—— 既不是事实也不可重试)。
      const error = failures[0]?.error;
      expect(error).toBeInstanceOf(BizException);
      expect((error as BizException).biz).toBe(BizCode.CONCURRENT_WRITE_DEADLOCK);
      expect((error as BizException).biz.httpStatus).toBe(409);
    },
    CASE_TIMEOUT_MS,
  );

  it('④ 预算未被本刀改动:锁等待预算仍是 4s(死锁检测 1s 恒先于它触发)', () => {
    expect(MEMBER_LOCK_WAIT_BUDGET_MS).toBe(4_000);
    expect(WAITER_BUDGET_MS).toBeLessThan(MEMBER_LOCK_WAIT_BUDGET_MS);
  });
});
