import type { INestApplication } from '@nestjs/common';
import { SmsPurpose } from '@prisma/client';

import type { BizCodeEntry } from '../../src/common/exceptions/biz-code.constant';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { acquireSmsIssueLocks } from '../../src/modules/sms/sms-issue-lock';
import { SmsCodeService } from '../../src/modules/sms/sms-code.service';
import { SMS_DEV_STUB_FIXED_CODE } from '../../src/modules/sms/sms.constants';
import { SmsProviderRouter } from '../../src/modules/sms/sms-provider.router';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// D-SMS：真实 PostgreSQL transaction advisory-lock / CAS 并发证据。
// service 直驱模拟多个已通过 controller/Guard 的请求共享同一数据库；provider 使用 DEV_STUB，
// 因此不触达外部通道。所有 phone 均为合成值，不含真实 PII。

interface VerifyHooks {
  loadValidActiveCodeOrThrow: (
    input: { phone: string; purpose: SmsPurpose; code: string; userId: string | null },
    now: Date,
  ) => Promise<{ id: string }>;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
  let app: INestApplication;
  let prisma: PrismaService;
  let smsCode: SmsCodeService;
  let router: SmsProviderRouter;
  let sendSpy: jest.SpiedFunction<SmsProviderRouter['sendVerifyCode']>;

  beforeAll(async () => {
    process.env.SMS_SEND_THROTTLE_LIMIT = '100';
    process.env.SMS_VERIFY_THROTTLE_LIMIT = '100';
    app = await createTestApp();
    prisma = app.get(PrismaService);
    smsCode = app.get(SmsCodeService);
    router = app.get(SmsProviderRouter);
    sendSpy = jest.spyOn(router, 'sendVerifyCode');
  });

  beforeEach(async () => {
    await resetDb(app);
    await prisma.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    sendSpy.mockClear();
  });

  afterAll(async () => {
    sendSpy.mockRestore();
    await app.close();
    delete process.env.SMS_SEND_THROTTLE_LIMIT;
    delete process.env.SMS_VERIFY_THROTTLE_LIMIT;
  });

  function issue(
    phone: string,
    purpose: SmsPurpose,
    userId = 'sms-concurrency-user',
  ): Promise<{ expiresInSeconds: number }> {
    return smsCode.issue({ phone, purpose, userId, ip: '127.0.0.1' });
  }

  async function issueTogether(
    first: { phone: string; purpose: SmsPurpose },
    second: { phone: string; purpose: SmsPurpose },
  ): Promise<PromiseSettledResult<unknown>[]> {
    const bothResolved = deferred<void>();
    const originalResolve = router.resolveProviderType.bind(router);
    let resolvedCount = 0;
    const resolveSpy = jest.spyOn(router, 'resolveProviderType').mockImplementation(async () => {
      const providerType = await originalResolve();
      resolvedCount += 1;
      if (resolvedCount === 2) bothResolved.resolve();
      await bothResolved.promise;
      return providerType;
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

  it('同 phone 同 purpose 双并发：恰一成功 / 一方 24120 / 一条 active / 一次 send', async () => {
    const phone = '13600000001';
    const results = await issueTogether(
      { phone, purpose: SmsPurpose.PHONE_BIND },
      { phone, purpose: SmsPurpose.PHONE_BIND },
    );

    // 杀死「检查移出事务」：若两边在锁外共同读到空快照，会双成功并产生两次发送。
    expectOneSuccessOneBizError(results, BizCode.SMS_SEND_INTERVAL_LIMIT);
    expect(
      await prisma.smsVerificationCode.count({
        where: { phone, purpose: SmsPurpose.PHONE_BIND, consumedAt: null, supersededAt: null },
      }),
    ).toBe(1);
    expect(await prisma.smsVerificationCode.count({ where: { phone } })).toBe(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(await prisma.smsSendLog.count({ where: { phone, status: 'SENT' } })).toBe(1);
  });

  it('同 phone 不同 purpose 双并发：phone 锁阻止跨 purpose 穿透', async () => {
    const phone = '13600000002';
    const results = await issueTogether(
      { phone, purpose: SmsPurpose.PHONE_BIND },
      { phone, purpose: SmsPurpose.LOGIN },
    );

    // 杀死「删除 phone 锁、只留 purpose 锁」：两种 purpose 会各拿一把不同锁并双成功。
    expectOneSuccessOneBizError(results, BizCode.SMS_SEND_INTERVAL_LIMIT);
    expect(await prisma.smsVerificationCode.count({ where: { phone } })).toBe(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('自然日 9 条 → 双并发：最终恰 10 条，后到者 24121，只发送一次', async () => {
    const phone = '13600000003';
    const nowMs = Date.now();
    const offsetMs = 8 * 3600 * 1000;
    const dayStartMs = Math.floor((nowMs + offsetMs) / 86_400_000) * 86_400_000 - offsetMs;
    await prisma.smsVerificationCode.createMany({
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
    expect(await prisma.smsVerificationCode.count({ where: { phone } })).toBe(10);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('不同 phone 不互阻：phone A 被真实 advisory lock 挡住时，phone B 仍先完成', async () => {
    const phoneA = '13600000004';
    const phoneB = '13600000005';
    const blockerReady = deferred<number>();
    const releaseBlocker = deferred<void>();
    const blocker = prisma.$transaction(async (tx) => {
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
      expect(await observeBlockedByBackend(prisma, blockerPid, blockedIssue)).toBe('blocked');

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
      expect(sendSpy).toHaveBeenCalledTimes(1);
    } finally {
      releaseBlocker.resolve();
      await blocker;
      if (blockedIssue !== undefined) await blockedIssue;
    }
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it('pg_locks 锁定独立 golden pair，且 transaction advisory lock 随 commit 释放', async () => {
    const { holderPid, held } = await prisma.$transaction(async (tx) => {
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

    const [postCommit] = await prisma.$queryRaw<Array<{ count: number }>>`
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

  it('verifyAndConsume 真并发：两边都读到同一 active code，consumedAt CAS 仍仅一赢家', async () => {
    const phone = '13600000007';
    await issue(phone, SmsPurpose.PHONE_BIND, 'consume-user');
    const hooks = smsCode as unknown as VerifyHooks;
    const originalLoad = hooks.loadValidActiveCodeOrThrow.bind(smsCode);
    const bothLoaded = deferred<void>();
    let loadedCount = 0;
    const loadSpy = jest
      .spyOn(hooks, 'loadValidActiveCodeOrThrow')
      .mockImplementation(async (...args) => {
        const active = await originalLoad(...args);
        loadedCount += 1;
        if (loadedCount === 2) bothLoaded.resolve();
        await bothLoaded.promise;
        return active;
      });

    let results: PromiseSettledResult<unknown>[];
    try {
      const input = {
        phone,
        purpose: SmsPurpose.PHONE_BIND,
        code: SMS_DEV_STUB_FIXED_CODE,
        userId: 'consume-user',
      };
      results = await Promise.allSettled([
        smsCode.verifyAndConsume(input),
        smsCode.verifyAndConsume(input),
      ]);
    } finally {
      bothLoaded.resolve();
      loadSpy.mockRestore();
    }

    // 杀死 consumedAt 条件 CAS：若改成无条件 update，两边都会返回成功。
    expectOneSuccessOneBizError(results, BizCode.SMS_CODE_INVALID);
    const row = await prisma.smsVerificationCode.findFirstOrThrow({
      where: { phone, purpose: SmsPurpose.PHONE_BIND },
      select: { consumedAt: true, attempts: true },
    });
    expect(row.consumedAt).not.toBeNull();
    expect(row.attempts).toBe(0);
  });
});
