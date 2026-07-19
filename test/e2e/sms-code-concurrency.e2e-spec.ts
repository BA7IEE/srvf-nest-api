import type { INestApplication } from '@nestjs/common';
import { SmsPurpose } from '@prisma/client';

import type { BizCodeEntry } from '../../src/common/exceptions/biz-code.constant';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { DevStubSmsProvider } from '../../src/modules/sms/providers/dev-stub.provider';
import { acquireSmsIssueLocks } from '../../src/modules/sms/sms-issue-lock';
import { SmsCodeService } from '../../src/modules/sms/sms-code.service';
import { SMS_DEV_STUB_FIXED_CODE } from '../../src/modules/sms/sms.constants';
import { SmsProviderRouter } from '../../src/modules/sms/sms-provider.router';
import { SmsSettingsService } from '../../src/modules/sms/sms-settings.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// D-SMS：真实 PostgreSQL transaction advisory-lock / 行锁 / CAS 并发证据。
// 两套 Nest app / Prisma pool 直驱模拟多个已通过 controller/Guard 的请求共享同一数据库；
// provider 使用 DEV_STUB，因此不触达外部通道。所有 phone 均为合成值，不含真实 PII。

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function expectOneSuccessOneBizError(
  results: PromiseSettledResult<unknown>[],
  biz: BizCodeEntry,
): void {
  expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  expect(rejected).toHaveLength(1);
  expect(rejected[0].reason).toEqual(new BizException(biz));
}

function expectBizErrorResult(result: PromiseSettledResult<unknown>, biz: BizCodeEntry): void {
  expect(result.status).toBe('rejected');
  if (result.status !== 'rejected') return;
  expect(result.reason).toEqual(new BizException(biz));
}

interface SmsCodeLockWaiter {
  pid: number;
  query: string;
  blockingPids: number[];
}

async function waitForSmsCodeLockWaiters(
  prisma: PrismaService,
  expected: number,
): Promise<SmsCodeLockWaiter[]> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const waiters = await prisma.$queryRaw<SmsCodeLockWaiter[]>`
      SELECT
        pid,
        query,
        pg_blocking_pids(pid) AS "blockingPids"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state = 'active'
        AND wait_event_type = 'Lock'
        AND cardinality(pg_blocking_pids(pid)) > 0
        AND query LIKE '%sms_verification_codes%'
      ORDER BY pid
    `;
    if (waiters.length >= expected) return waiters;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected ${expected} blocked sms_verification_codes query(s)`);
}

async function holdSmsCodeRow(
  prisma: PrismaService,
  codeId: string,
): Promise<{ blockerPid: number; release: () => void; done: Promise<void> }> {
  const ready = deferred<number>();
  const release = deferred<void>();
  const done = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id"
      FROM "sms_verification_codes"
      WHERE "id" = ${codeId}
      FOR UPDATE
    `;
    const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`
      SELECT pg_backend_pid()::integer AS pid
    `;
    if (backend === undefined) throw new Error('SMS row-lock backend pid missing');
    ready.resolve(backend.pid);
    await release.promise;
  });
  void done.catch((error: unknown) => {
    ready.reject(error);
  });
  return {
    blockerPid: await ready.promise,
    release: () => release.resolve(),
    done,
  };
}

async function waitForDatabaseClockAfter(prisma: PrismaService, instant: Date): Promise<void> {
  const deadline = performance.now() + 4_000;
  while (performance.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ passed: boolean }>>`
      SELECT
        (clock_timestamp() AT TIME ZONE 'UTC') > CAST(${instant} AS timestamp) AS passed
    `;
    if (row?.passed === true) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('database clock did not pass SMS expiry before barrier timeout');
}

async function observeBlockedByBackend(
  prisma: PrismaService,
  blockerPid: number,
  mutation: Promise<unknown>,
): Promise<'blocked' | 'settled'> {
  let settled = false;
  void mutation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (settled) return 'settled';
    const waiting = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND CAST(${blockerPid} AS integer) = ANY(pg_blocking_pids(pid))
      LIMIT 1
    `;
    if (waiting.length > 0) return 'blocked';
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for SMS issue advisory-lock contention');
}

const ISSUE_LOCK_GOLDEN = {
  phone: '13600000006',
  purpose: SmsPurpose.PHONE_BIND,
  pgLockPairs: ['3987168973:3412456034', '115422025:3791586783'],
} as const;

describe('SMS issue / consume PostgreSQL concurrency', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let smsCodeA: SmsCodeService;
  let smsCodeB: SmsCodeService;
  let routerA: SmsProviderRouter;
  let routerB: SmsProviderRouter;
  let settingsA: SmsSettingsService;
  let settingsB: SmsSettingsService;
  let devSendSpyA: jest.SpiedFunction<DevStubSmsProvider['sendVerifyCode']>;
  let devSendSpyB: jest.SpiedFunction<DevStubSmsProvider['sendVerifyCode']>;

  beforeAll(async () => {
    process.env.SMS_SEND_THROTTLE_LIMIT = '100';
    process.env.SMS_VERIFY_THROTTLE_LIMIT = '100';
    appA = await createTestApp();
    appB = await createTestApp();
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    smsCodeA = appA.get(SmsCodeService);
    smsCodeB = appB.get(SmsCodeService);
    routerA = appA.get(SmsProviderRouter);
    routerB = appB.get(SmsProviderRouter);
    settingsA = appA.get(SmsSettingsService);
    settingsB = appB.get(SmsSettingsService);
    devSendSpyA = jest.spyOn(appA.get(DevStubSmsProvider), 'sendVerifyCode');
    devSendSpyB = jest.spyOn(appB.get(DevStubSmsProvider), 'sendVerifyCode');
  });

  beforeEach(async () => {
    await resetDb(appA);
    await prismaA.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    settingsA.invalidate();
    settingsB.invalidate();
    devSendSpyA.mockClear();
    devSendSpyB.mockClear();
  });

  afterAll(async () => {
    devSendSpyA.mockRestore();
    devSendSpyB.mockRestore();
    await Promise.all([appA.close(), appB.close()]);
    delete process.env.SMS_SEND_THROTTLE_LIMIT;
    delete process.env.SMS_VERIFY_THROTTLE_LIMIT;
  });

  function issue(
    phone: string,
    purpose: SmsPurpose,
    userId = 'sms-concurrency-user',
  ): Promise<{ expiresInSeconds: number }> {
    return smsCodeA.issue({ phone, purpose, userId, ip: '127.0.0.1' });
  }

  async function issueTogether(
    first: { phone: string; purpose: SmsPurpose },
    second: { phone: string; purpose: SmsPurpose },
  ): Promise<PromiseSettledResult<unknown>[]> {
    const bothResolved = deferred<void>();
    const originalResolve = routerA.resolveRoute.bind(routerA);
    let resolvedCount = 0;
    const resolveSpy = jest.spyOn(routerA, 'resolveRoute').mockImplementation(async () => {
      const route = await originalResolve();
      resolvedCount += 1;
      if (resolvedCount === 2) bothResolved.resolve();
      await bothResolved.promise;
      return route;
    });
    try {
      return await Promise.allSettled([
        issue(first.phone, first.purpose),
        issue(second.phone, second.purpose),
      ]);
    } finally {
      bothResolved.resolve();
      resolveSpy.mockRestore();
    }
  }

  function verify(
    service: SmsCodeService,
    phone: string,
    userId: string,
    code = SMS_DEV_STUB_FIXED_CODE,
  ): Promise<{ codeId: string }> {
    return service.verifyAndConsume({
      phone,
      purpose: SmsPurpose.PHONE_BIND,
      code,
      userId,
    });
  }

  async function issueActiveCode(phone: string, userId: string): Promise<string> {
    await issue(phone, SmsPurpose.PHONE_BIND, userId);
    const row = await prismaA.smsVerificationCode.findFirstOrThrow({
      where: { phone, purpose: SmsPurpose.PHONE_BIND },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return row.id;
  }

  async function makeCodeReissuable(codeId: string): Promise<void> {
    await prismaA.smsVerificationCode.update({
      where: { id: codeId },
      data: { createdAt: new Date(Date.now() - 61_000) },
    });
  }

  it('同 phone 同 purpose 双并发：恰一成功 / 一方 24120 / 一条 active / 一次 send', async () => {
    const phone = '13600000001';
    const results = await issueTogether(
      { phone, purpose: SmsPurpose.PHONE_BIND },
      { phone, purpose: SmsPurpose.PHONE_BIND },
    );

    // 杀死「检查移出事务」：若两边在锁外共同读到空快照，会双成功并产生两次发送。
    expectOneSuccessOneBizError(results, BizCode.SMS_SEND_INTERVAL_LIMIT);
    expect(
      await prismaA.smsVerificationCode.count({
        where: { phone, purpose: SmsPurpose.PHONE_BIND, consumedAt: null, supersededAt: null },
      }),
    ).toBe(1);
    expect(await prismaA.smsVerificationCode.count({ where: { phone } })).toBe(1);
    expect(devSendSpyA).toHaveBeenCalledTimes(1);
    expect(await prismaA.smsSendLog.count({ where: { phone, status: 'SENT' } })).toBe(1);
  });

  it('同 phone 不同 purpose 双并发：phone 锁阻止跨 purpose 穿透', async () => {
    const phone = '13600000002';
    const results = await issueTogether(
      { phone, purpose: SmsPurpose.PHONE_BIND },
      { phone, purpose: SmsPurpose.LOGIN },
    );

    // 杀死「删除 phone 锁、只留 purpose 锁」：两种 purpose 会各拿一把不同锁并双成功。
    expectOneSuccessOneBizError(results, BizCode.SMS_SEND_INTERVAL_LIMIT);
    expect(await prismaA.smsVerificationCode.count({ where: { phone } })).toBe(1);
    expect(devSendSpyA).toHaveBeenCalledTimes(1);
  });

  it('自然日 9 条 → 双并发：最终恰 10 条，后到者 24121，只发送一次', async () => {
    const phone = '13600000003';
    const nowMs = Date.now();
    const offsetMs = 8 * 3600 * 1000;
    const dayStartMs = Math.floor((nowMs + offsetMs) / 86_400_000) * 86_400_000 - offsetMs;
    await prismaA.smsVerificationCode.createMany({
      data: Array.from({ length: 9 }, (_, index) => {
        const createdAt = new Date(Math.max(dayStartMs, nowMs - 61_000 - index * 10));
        return {
          phone,
          purpose: SmsPurpose.PHONE_BIND,
          codeHash: 'f'.repeat(64),
          userId: 'daily-seed',
          expiresAt: new Date(createdAt.getTime() + 300_000),
          supersededAt: createdAt,
          createdAt,
        };
      }),
    });

    // 北京日界后的前 60 秒，真实世界不可能已经存在 9 条「当日且已过间隔」记录；只在该
    // 极窄窗口把 Date 推到日界 +61s，其他计时器/Prisma I/O 保持真实，消除午夜 flake。
    const elapsedInDay = nowMs - dayStartMs;
    const fakeDateOnly = elapsedInDay < 61_000;
    if (fakeDateOnly) {
      jest.useFakeTimers({
        doNotFake: [
          'hrtime',
          'nextTick',
          'performance',
          'queueMicrotask',
          'setImmediate',
          'clearImmediate',
          'setInterval',
          'clearInterval',
          'setTimeout',
          'clearTimeout',
        ],
      });
      jest.setSystemTime(new Date(dayStartMs + 61_000));
    }
    let results: PromiseSettledResult<unknown>[];
    try {
      results = await issueTogether(
        { phone, purpose: SmsPurpose.PHONE_BIND },
        { phone, purpose: SmsPurpose.LOGIN },
      );
    } finally {
      if (fakeDateOnly) jest.useRealTimers();
    }

    // 杀死「日计数锁外读」：两边若共同读到 9，会双插到 11；锁后重读让第二方见 10。
    expectOneSuccessOneBizError(results, BizCode.SMS_PHONE_DAILY_LIMIT);
    expect(await prismaA.smsVerificationCode.count({ where: { phone } })).toBe(10);
    expect(devSendSpyA).toHaveBeenCalledTimes(1);
  });

  it('不同 phone 不互阻：phone A 被真实 advisory lock 挡住时，phone B 仍先完成', async () => {
    const phoneA = '13600000004';
    const phoneB = '13600000005';
    const blockerReady = deferred<number>();
    const releaseBlocker = deferred<void>();
    const blocker = prismaA.$transaction(async (tx) => {
      await acquireSmsIssueLocks(tx, phoneA, SmsPurpose.PHONE_BIND);
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid() AS pid
      `;
      blockerReady.resolve(backend.pid);
      await releaseBlocker.promise;
    });

    let blockedIssue: ReturnType<typeof issue> | undefined;
    try {
      const blockerPid = await blockerReady.promise;
      blockedIssue = issue(phoneA, SmsPurpose.PHONE_BIND);
      expect(await observeBlockedByBackend(prismaA, blockerPid, blockedIssue)).toBe('blocked');

      let timeout: NodeJS.Timeout | undefined;
      const independent = await Promise.race([
        issue(phoneB, SmsPurpose.PHONE_BIND),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('different phone unexpectedly blocked')),
            2_000,
          );
        }),
      ]).finally(() => {
        if (timeout !== undefined) clearTimeout(timeout);
      });
      expect(independent).toEqual({ expiresInSeconds: 300 });
      expect(devSendSpyA).toHaveBeenCalledTimes(1);
    } finally {
      releaseBlocker.resolve();
      await blocker;
      if (blockedIssue !== undefined) await blockedIssue;
    }
    expect(devSendSpyA).toHaveBeenCalledTimes(2);
  });

  it('单 route 快照：issue 取到 DEV 后阻塞，配置禁用仍以 888888 / DEV 发送记账；下一 route 24030', async () => {
    const phone = '13600000014';
    const nextPhone = '13600000015';
    const userId = 'route-snapshot-user';
    const blockerReady = deferred<number>();
    const releaseBlocker = deferred<void>();
    const blocker = prismaA.$transaction(async (tx) => {
      await acquireSmsIssueLocks(tx, phone, SmsPurpose.PHONE_BIND);
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid()::integer AS pid
      `;
      if (backend === undefined) throw new Error('SMS issue blocker backend pid missing');
      blockerReady.resolve(backend.pid);
      await releaseBlocker.promise;
    });
    void blocker.catch((error: unknown) => {
      blockerReady.reject(error);
    });
    const routeResolved = deferred<'DEV_STUB' | 'TENCENT_SMS'>();
    const originalResolve = routerB.resolveRoute.bind(routerB);
    const resolveSpy = jest.spyOn(routerB, 'resolveRoute').mockImplementation(async () => {
      try {
        const route = await originalResolve();
        routeResolved.resolve(route.providerType);
        return route;
      } catch (error) {
        routeResolved.reject(error);
        throw error;
      }
    });
    const blockerPid = await blockerReady.promise;
    const issueAttempt = smsCodeB.issue({
      phone,
      purpose: SmsPurpose.PHONE_BIND,
      userId,
      ip: '127.0.0.1',
    });
    void issueAttempt.catch(() => undefined);

    try {
      expect(await routeResolved.promise).toBe('DEV_STUB');
      expect(await observeBlockedByBackend(prismaA, blockerPid, issueAttempt)).toBe('blocked');

      // 真实 DB 配置改变并显式失效发起 app 的 60s cache；不触碰已取得的在途 route。
      await prismaA.smsSettings.updateMany({ data: { enabled: false } });
      settingsB.invalidate();
      releaseBlocker.resolve();
      await blocker;

      await expect(issueAttempt).resolves.toEqual({ expiresInSeconds: 300 });
    } finally {
      releaseBlocker.resolve();
      await blocker;
      await issueAttempt.catch(() => undefined);
      resolveSpy.mockRestore();
    }

    expect(devSendSpyB).toHaveBeenCalledTimes(1);
    expect(devSendSpyB).toHaveBeenCalledWith({
      phone,
      code: SMS_DEV_STUB_FIXED_CODE,
      ttlMinutes: 5,
    });
    const codeRow = await prismaA.smsVerificationCode.findFirstOrThrow({
      where: { phone, purpose: SmsPurpose.PHONE_BIND },
      select: { id: true },
    });
    const sendLog = await prismaA.smsSendLog.findFirstOrThrow({
      where: { codeId: codeRow.id },
      select: { providerType: true, status: true, providerMsgId: true },
    });
    expect(sendLog).toEqual({ providerType: 'DEV_STUB', status: 'SENT', providerMsgId: null });
    await expect(verify(smsCodeA, phone, userId)).resolves.toEqual({ codeId: codeRow.id });

    await expect(
      smsCodeB.issue({
        phone: nextPhone,
        purpose: SmsPurpose.PHONE_BIND,
        userId,
        ip: '127.0.0.1',
      }),
    ).rejects.toEqual(new BizException(BizCode.SMS_CHANNEL_NOT_CONFIGURED));
    expect(await prismaA.smsVerificationCode.count({ where: { phone: nextPhone } })).toBe(0);
    expect(devSendSpyB).toHaveBeenCalledTimes(1);
  });

  it('pg_locks 锁定独立 golden pair，且 transaction advisory lock 随 commit 释放', async () => {
    const { holderPid, held } = await prismaA.$transaction(async (tx) => {
      await acquireSmsIssueLocks(tx, ISSUE_LOCK_GOLDEN.phone, ISSUE_LOCK_GOLDEN.purpose);
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid() AS pid
      `;
      const locks = await tx.$queryRaw<Array<{ classId: bigint; objectId: bigint }>>`
        SELECT classid::bigint AS "classId", objid::bigint AS "objectId"
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND pid = pg_backend_pid()
          AND granted = true
      `;
      return { holderPid: backend.pid, held: locks };
    });

    // expected 不调用 production derive：杀死 namespace / hash / key 漂移与删任一锁变异。
    expect(held.map(({ classId, objectId }) => `${classId}:${objectId}`).sort()).toEqual(
      [...ISSUE_LOCK_GOLDEN.pgLockPairs].sort(),
    );

    const [postCommit] = await prismaA.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::integer AS count
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND pid = CAST(${holderPid} AS integer)
        AND granted = true
        AND (
          (classid::bigint = 3987168973 AND objid::bigint = 3412456034)
          OR (classid::bigint = 115422025 AND objid::bigint = 3791586783)
        )
    `;
    // 杀死 pg_advisory_xact_lock -> pg_advisory_lock：session lock 在 commit 后仍会残留。
    expect(postCommit.count).toBe(0);
  });

  it('双 consumer 旧证明：双 app 最终 UPDATE 都进入行锁等待，释放后仍仅一赢家', async () => {
    const phone = '13600000007';
    const userId = 'consume-user';
    const codeId = await issueActiveCode(phone, userId);
    const barrier = await holdSmsCodeRow(prismaA, codeId);
    const attempts: Promise<unknown>[] = [];
    let results: PromiseSettledResult<unknown>[] = [];
    try {
      const first = verify(smsCodeA, phone, userId);
      attempts.push(first);
      void first.catch(() => undefined);
      const firstWaiters = await waitForSmsCodeLockWaiters(prismaB, 1);
      expect(firstWaiters).toHaveLength(1);
      expect(firstWaiters[0].query).toContain('clock_timestamp()');
      expect(firstWaiters[0].blockingPids).toContain(barrier.blockerPid);

      const second = verify(smsCodeB, phone, userId);
      attempts.push(second);
      void second.catch(() => undefined);
      const bothWaiters = await waitForSmsCodeLockWaiters(prismaA, 2);
      expect(bothWaiters).toHaveLength(2);
      expect(bothWaiters.filter(({ query }) => query.includes('clock_timestamp()'))).toHaveLength(
        2,
      );
    } finally {
      barrier.release();
      await barrier.done;
      results = await Promise.allSettled(attempts);
    }

    // 两边均已越过只读预检并在同一行最终 UPDATE 等待；杀死 consumedAt CAS 会双成功。
    expectOneSuccessOneBizError(results, BizCode.SMS_CODE_INVALID);
    const row = await prismaA.smsVerificationCode.findUniqueOrThrow({
      where: { id: codeId },
      select: { consumedAt: true, attempts: true },
    });
    expect(row.consumedAt).not.toBeNull();
    expect(row.attempts).toBe(0);
  });

  it('issue-first：签发写先入行锁队列，旧码作废提交后 verify 统一 24010', async () => {
    const phone = '13600000008';
    const userId = 'issue-first-user';
    const oldCodeId = await issueActiveCode(phone, userId);
    await makeCodeReissuable(oldCodeId);
    const barrier = await holdSmsCodeRow(prismaA, oldCodeId);
    const attempts: Promise<unknown>[] = [];
    let results: PromiseSettledResult<unknown>[] = [];
    try {
      const issueAttempt = issue(phone, SmsPurpose.PHONE_BIND, userId);
      attempts.push(issueAttempt);
      void issueAttempt.catch(() => undefined);
      const issueWaiters = await waitForSmsCodeLockWaiters(prismaB, 1);
      expect(issueWaiters).toHaveLength(1);
      expect(issueWaiters[0].query).toContain('"supersededAt"');
      expect(issueWaiters[0].query).not.toContain('clock_timestamp()');
      expect(issueWaiters[0].blockingPids).toContain(barrier.blockerPid);

      const verifyAttempt = verify(smsCodeB, phone, userId);
      attempts.push(verifyAttempt);
      void verifyAttempt.catch(() => undefined);
      const bothWaiters = await waitForSmsCodeLockWaiters(prismaA, 2);
      expect(bothWaiters).toHaveLength(2);
      expect(bothWaiters.filter(({ query }) => query.includes('clock_timestamp()'))).toHaveLength(
        1,
      );
    } finally {
      barrier.release();
      await barrier.done;
      results = await Promise.allSettled(attempts);
    }

    expect(results[0]).toEqual({ status: 'fulfilled', value: { expiresInSeconds: 300 } });
    expectBizErrorResult(results[1], BizCode.SMS_CODE_INVALID);
    const rows = await prismaA.smsVerificationCode.findMany({
      where: { phone, purpose: SmsPurpose.PHONE_BIND },
      orderBy: { createdAt: 'asc' },
      select: { id: true, consumedAt: true, supersededAt: true },
    });
    expect(rows).toHaveLength(2);
    const oldRow = rows.find(({ id }) => id === oldCodeId);
    expect(oldRow).toMatchObject({ id: oldCodeId, consumedAt: null });
    expect(oldRow?.supersededAt).not.toBeNull();
    expect(
      rows.filter(({ consumedAt, supersededAt }) => !consumedAt && !supersededAt),
    ).toHaveLength(1);
  });

  it('verify-first：消费写先入行锁队列，verify 成功后 issue 仍签发新活码', async () => {
    const phone = '13600000009';
    const userId = 'verify-first-user';
    const oldCodeId = await issueActiveCode(phone, userId);
    await makeCodeReissuable(oldCodeId);
    const barrier = await holdSmsCodeRow(prismaA, oldCodeId);
    const attempts: Promise<unknown>[] = [];
    let results: PromiseSettledResult<unknown>[] = [];
    try {
      const verifyAttempt = verify(smsCodeB, phone, userId);
      attempts.push(verifyAttempt);
      void verifyAttempt.catch(() => undefined);
      const verifyWaiters = await waitForSmsCodeLockWaiters(prismaA, 1);
      expect(verifyWaiters).toHaveLength(1);
      expect(verifyWaiters[0].query).toContain('clock_timestamp()');
      expect(verifyWaiters[0].blockingPids).toContain(barrier.blockerPid);

      const issueAttempt = issue(phone, SmsPurpose.PHONE_BIND, userId);
      attempts.push(issueAttempt);
      void issueAttempt.catch(() => undefined);
      const bothWaiters = await waitForSmsCodeLockWaiters(prismaB, 2);
      expect(bothWaiters).toHaveLength(2);
      expect(bothWaiters.some(({ query }) => query.includes('"supersededAt"'))).toBe(true);
    } finally {
      barrier.release();
      await barrier.done;
      results = await Promise.allSettled(attempts);
    }

    expect(results[0]).toEqual({ status: 'fulfilled', value: { codeId: oldCodeId } });
    expect(results[1]).toEqual({ status: 'fulfilled', value: { expiresInSeconds: 300 } });
    const rows = await prismaA.smsVerificationCode.findMany({
      where: { phone, purpose: SmsPurpose.PHONE_BIND },
      orderBy: { createdAt: 'asc' },
      select: { id: true, consumedAt: true, supersededAt: true },
    });
    expect(rows).toHaveLength(2);
    const oldRow = rows.find(({ id }) => id === oldCodeId);
    expect(oldRow?.consumedAt).not.toBeNull();
    expect(oldRow?.supersededAt).toBeNull();
    expect(
      rows.filter(({ consumedAt, supersededAt }) => !consumedAt && !supersededAt),
    ).toHaveLength(1);
  });

  it('attempts 4→5 先提交：正确 verify 的最终 UPDATE 重查上限并统一 24010', async () => {
    const phone = '13600000010';
    const userId = 'attempt-race-user';
    const codeId = await issueActiveCode(phone, userId);
    await prismaA.smsVerificationCode.update({ where: { id: codeId }, data: { attempts: 4 } });
    const barrier = await holdSmsCodeRow(prismaA, codeId);
    const attempts: Promise<unknown>[] = [];
    let results: PromiseSettledResult<unknown>[] = [];
    try {
      const wrongAttempt = verify(smsCodeA, phone, userId, '000000');
      attempts.push(wrongAttempt);
      void wrongAttempt.catch(() => undefined);
      const attemptWaiters = await waitForSmsCodeLockWaiters(prismaB, 1);
      expect(attemptWaiters).toHaveLength(1);
      expect(attemptWaiters[0].query).toContain('SET "attempts"');
      expect(attemptWaiters[0].query).toContain('clock_timestamp()');
      expect(attemptWaiters[0].blockingPids).toContain(barrier.blockerPid);

      const correctAttempt = verify(smsCodeB, phone, userId);
      attempts.push(correctAttempt);
      void correctAttempt.catch(() => undefined);
      const bothWaiters = await waitForSmsCodeLockWaiters(prismaA, 2);
      expect(bothWaiters).toHaveLength(2);
      expect(bothWaiters.filter(({ query }) => query.includes('clock_timestamp()'))).toHaveLength(
        2,
      );
    } finally {
      barrier.release();
      await barrier.done;
      results = await Promise.allSettled(attempts);
    }

    expect(results).toHaveLength(2);
    for (const result of results) expectBizErrorResult(result, BizCode.SMS_CODE_INVALID);
    const row = await prismaA.smsVerificationCode.findUniqueOrThrow({
      where: { id: codeId },
      select: { attempts: true, consumedAt: true, supersededAt: true },
    });
    expect(row).toEqual({ attempts: 5, consumedAt: null, supersededAt: null });
  });

  it('slow app clock + 排队自然过期：拿到行锁后才捕获 DB clock，最终统一 24010', async () => {
    const phone = '13600000011';
    const userId = 'db-clock-user';
    const codeId = await issueActiveCode(phone, userId);
    const [timing] = await prismaA.$queryRaw<Array<{ expiresAt: Date }>>`
      UPDATE "sms_verification_codes"
      SET "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '2 seconds'
      WHERE "id" = ${codeId}
      RETURNING "expiresAt" AS "expiresAt"
    `;
    if (timing === undefined) throw new Error('failed to set near-future SMS expiry');
    const staleApplicationNow = new Date(timing.expiresAt.getTime() - 2 * 60 * 60 * 1000);
    const barrier = await holdSmsCodeRow(prismaA, codeId);
    const attempts: Promise<unknown>[] = [];
    let results: PromiseSettledResult<unknown>[] = [];
    jest.useFakeTimers({
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    jest.setSystemTime(staleApplicationNow);
    try {
      const verifyAttempt = verify(smsCodeB, phone, userId);
      attempts.push(verifyAttempt);
      void verifyAttempt.catch(() => undefined);
      const waiters = await waitForSmsCodeLockWaiters(prismaA, 1);
      expect(waiters).toHaveLength(1);
      expect(waiters[0].query).toContain('clock_timestamp()');
      expect(waiters[0].query).toContain('FOR UPDATE');
      expect(waiters[0].blockingPids).toContain(barrier.blockerPid);
      // 不改 expiresAt：保持 waiter 真实排队，直到 PostgreSQL 自身时钟自然越过近未来 expiry。
      await waitForDatabaseClockAfter(prismaA, timing.expiresAt);
    } finally {
      barrier.release();
      await barrier.done;
      results = await Promise.allSettled(attempts);
      jest.useRealTimers();
    }

    expect(results).toHaveLength(1);
    expectBizErrorResult(results[0], BizCode.SMS_CODE_INVALID);
    const row = await prismaA.smsVerificationCode.findUniqueOrThrow({
      where: { id: codeId },
      select: { consumedAt: true, attempts: true, supersededAt: true },
    });
    expect(row).toEqual({ consumedAt: null, attempts: 0, supersededAt: null });
  });

  it('fast app clock：DB 尚有效的正确码不被应用 Date 误拒，仍成功消费', async () => {
    const phone = '13600000012';
    const userId = 'fast-clock-correct-user';
    const codeId = await issueActiveCode(phone, userId);
    const [timing] = await prismaA.$queryRaw<Array<{ expiresAt: Date }>>`
      UPDATE "sms_verification_codes"
      SET "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '1 hour'
      WHERE "id" = ${codeId}
      RETURNING "expiresAt" AS "expiresAt"
    `;
    if (timing === undefined) throw new Error('failed to extend SMS expiry');
    jest.useFakeTimers({
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    jest.setSystemTime(new Date(timing.expiresAt.getTime() + 60 * 60 * 1000));
    try {
      await expect(verify(smsCodeB, phone, userId)).resolves.toEqual({ codeId });
    } finally {
      jest.useRealTimers();
    }

    const row = await prismaA.smsVerificationCode.findUniqueOrThrow({
      where: { id: codeId },
      select: { consumedAt: true, attempts: true },
    });
    expect(row.consumedAt).not.toBeNull();
    expect(row.attempts).toBe(0);
  });

  it('fast app clock：DB 尚有效的错码仍从 attempts 4→5，并锁定后续正确码', async () => {
    const phone = '13600000013';
    const userId = 'fast-clock-wrong-user';
    const codeId = await issueActiveCode(phone, userId);
    const [timing] = await prismaA.$queryRaw<Array<{ expiresAt: Date }>>`
      UPDATE "sms_verification_codes"
      SET
        "attempts" = 4,
        "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '1 hour'
      WHERE "id" = ${codeId}
      RETURNING "expiresAt" AS "expiresAt"
    `;
    if (timing === undefined) throw new Error('failed to prepare fast-clock attempt proof');
    jest.useFakeTimers({
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    jest.setSystemTime(new Date(timing.expiresAt.getTime() + 60 * 60 * 1000));
    try {
      await expect(verify(smsCodeB, phone, userId, '000000')).rejects.toEqual(
        new BizException(BizCode.SMS_CODE_INVALID),
      );
      await expect(verify(smsCodeA, phone, userId)).rejects.toEqual(
        new BizException(BizCode.SMS_CODE_INVALID),
      );
    } finally {
      jest.useRealTimers();
    }

    const row = await prismaA.smsVerificationCode.findUniqueOrThrow({
      where: { id: codeId },
      select: { attempts: true, consumedAt: true, supersededAt: true },
    });
    expect(row).toEqual({ attempts: 5, consumedAt: null, supersededAt: null });
  });
});
