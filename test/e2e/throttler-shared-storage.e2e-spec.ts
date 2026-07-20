import type { INestApplication } from '@nestjs/common';
import {
  getOptionsToken,
  getStorageToken,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import request from 'supertest';
import { CONTENT_PUBLIC_THROTTLER_NAME } from '../../src/common/decorators/content-public-throttle.decorator';
import { LOGIN_SMS_THROTTLER_NAME } from '../../src/common/decorators/login-sms-throttle.decorator';
import { LOGIN_WECHAT_THROTTLER_NAME } from '../../src/common/decorators/login-wechat-throttle.decorator';
import { PASSWORD_CHANGE_THROTTLER_NAME } from '../../src/common/decorators/password-change-throttle.decorator';
import { PASSWORD_RESET_THROTTLER_NAME } from '../../src/common/decorators/password-reset-throttle.decorator';
import { RECRUITMENT_THROTTLER_NAME } from '../../src/common/decorators/recruitment-throttle.decorator';
import { REFRESH_THROTTLER_NAME } from '../../src/common/decorators/refresh-throttle.decorator';
import { SMS_SEND_THROTTLER_NAME } from '../../src/common/decorators/sms-send-throttle.decorator';
import { SMS_VERIFY_THROTTLER_NAME } from '../../src/common/decorators/sms-verify-throttle.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PostgresqlThrottlerStorage } from '../../src/bootstrap/postgresql-throttler-storage';
import { PrismaService } from '../../src/database/prisma.service';
import { AuthService } from '../../src/modules/auth/auth.service';
import { TEST_PASSWORD, createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { deriveTestDbName } from '../setup/worktree-db';

const THROTTLER_NAMES = [
  'default',
  PASSWORD_CHANGE_THROTTLER_NAME,
  REFRESH_THROTTLER_NAME,
  SMS_SEND_THROTTLER_NAME,
  SMS_VERIFY_THROTTLER_NAME,
  PASSWORD_RESET_THROTTLER_NAME,
  LOGIN_SMS_THROTTLER_NAME,
  LOGIN_WECHAT_THROTTLER_NAME,
  RECRUITMENT_THROTTLER_NAME,
  CONTENT_PUBLIC_THROTTLER_NAME,
] as const;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function createRoundedFutureBucket(
  prisma: PrismaService,
  key: string,
  overrides: { hitExpiresAt?: Date[]; blockedUntil?: Date | null } = {},
) {
  const [rounding] = await prisma.$queryRaw<
    Array<{
      storedAt: Date;
      rawMicros: number;
      storedMicros: number;
      storedLeadsCaptured: boolean;
      syntheticTimeToExpire: number;
    }>
  >`
    WITH raw AS (
      SELECT date_trunc('second', clock_timestamp())
        + INTERVAL '30 seconds'
        + INTERVAL '0.6 milliseconds' AS "rawAt"
    ),
    fixture AS (
      SELECT
        raw."rawAt",
        raw."rawAt" + INTERVAL '0.1 milliseconds' AS "capturedAt",
        raw."rawAt"::timestamptz(3) AS "storedAt"
      FROM raw
    )
    SELECT
      fixture."storedAt",
      MOD(EXTRACT(MICROSECONDS FROM fixture."rawAt")::integer, 1000000) AS "rawMicros",
      MOD(
        EXTRACT(MICROSECONDS FROM fixture."storedAt")::integer,
        1000000
      ) AS "storedMicros",
      fixture."storedAt" > fixture."capturedAt" AS "storedLeadsCaptured",
      CEIL(EXTRACT(EPOCH FROM (
        fixture."storedAt" - fixture."capturedAt"
      )))::integer AS "syntheticTimeToExpire"
    FROM fixture
  `;
  if (!rounding) throw new Error('failed to build deterministic TIMESTAMPTZ(3) fixture');
  expect(rounding).toMatchObject({
    rawMicros: 600,
    storedMicros: 1_000,
    storedLeadsCaptured: true,
    syntheticTimeToExpire: 1,
  });

  // The assertions above independently prove the 600us -> 1ms rounding and the resulting
  // 1-second report. The 30-second offset only keeps that future-empty state stable while the
  // production branch is exercised; it does not represent the duration of production drift.
  return prisma.throttlerBucket.create({
    data: {
      throttlerName: 'default',
      key,
      hitExpiresAt: overrides.hitExpiresAt ?? [],
      windowExpiresAt: rounding.storedAt,
      blockedUntil: overrides.blockedUntil ?? null,
    },
  });
}

async function waitForTwoBlockedThrottlerWaiters(
  observer: PrismaService,
  blockerPid: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  const queryPattern = '%FROM "throttler_buckets" AS bucket%FOR UPDATE%';
  while (Date.now() < deadline) {
    const [observed] = await observer.$queryRaw<Array<{ count: number }>>`
      WITH RECURSIVE "matchingWaiters" AS (
        SELECT
          activity.pid,
          pg_blocking_pids(activity.pid) AS blockers
        FROM pg_stat_activity AS activity
        WHERE activity.datname = current_database()
          AND activity.query LIKE ${queryPattern}
      ),
      "blockingChain" AS (
        SELECT waiter.pid
        FROM "matchingWaiters" AS waiter
        WHERE ${blockerPid} = ANY(waiter.blockers)
        UNION
        SELECT waiter.pid
        FROM "matchingWaiters" AS waiter
        INNER JOIN "blockingChain" AS upstream
          ON upstream.pid = ANY(waiter.blockers)
      )
      SELECT COUNT(DISTINCT chain.pid)::integer AS "count"
      FROM "blockingChain" AS chain
    `;
    if (observed?.count === 2) return;
    await delay(25);
  }
  throw new Error('did not observe two throttler row-lock waiters');
}

describe('PostgreSQL shared throttler storage', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let storageA: ThrottlerStorage;
  let storageB: ThrottlerStorage;

  const originalLoginLimit = process.env.LOGIN_THROTTLE_LIMIT;
  const originalLoginTtl = process.env.LOGIN_THROTTLE_TTL_SECONDS;

  beforeAll(async () => {
    process.env.LOGIN_THROTTLE_LIMIT = '5';
    process.env.LOGIN_THROTTLE_TTL_SECONDS = '60';

    // Two independently compiled and listening Nest applications. Each owns a distinct
    // Prisma pool/storage object, while worktree DB derivation points both at one physical DB.
    appA = await createTestApp();
    appB = await createTestApp();
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    storageA = appA.get<ThrottlerStorage>(getStorageToken());
    storageB = appB.get<ThrottlerStorage>(getStorageToken());
  });

  beforeEach(async () => {
    await resetDb(appA);
  });

  afterAll(async () => {
    await appB.close();
    await appA.close();

    if (originalLoginLimit === undefined) delete process.env.LOGIN_THROTTLE_LIMIT;
    else process.env.LOGIN_THROTTLE_LIMIT = originalLoginLimit;
    if (originalLoginTtl === undefined) delete process.env.LOGIN_THROTTLE_TTL_SECONDS;
    else process.env.LOGIN_THROTTLE_TTL_SECONDS = originalLoginTtl;
  });

  it('wires 10 names to one PostgreSQL storage contract without changing tracker/key/headers', async () => {
    const options = appA.get<ThrottlerModuleOptions>(getOptionsToken());
    expect(Array.isArray(options)).toBe(false);
    if (Array.isArray(options)) throw new Error('production throttler options unexpectedly array');

    expect(options.storage).toBeInstanceOf(PostgresqlThrottlerStorage);
    expect(options.setHeaders).toBe(false);
    expect(options).not.toHaveProperty('getTracker');
    expect(options).not.toHaveProperty('generateKey');
    expect(options.throttlers.map(({ name }) => name).sort()).toEqual([...THROTTLER_NAMES].sort());
    for (const throttler of options.throttlers) {
      expect(throttler).not.toHaveProperty('getTracker');
      expect(throttler).not.toHaveProperty('generateKey');
      expect(throttler).not.toHaveProperty('setHeaders');
    }

    expect(prismaA).not.toBe(prismaB);
    expect(storageA).not.toBe(storageB);
    const [databaseA] = await prismaA.$queryRaw<Array<{ name: string }>>`
      SELECT current_database() AS name
    `;
    const [databaseB] = await prismaB.$queryRaw<Array<{ name: string }>>`
      SELECT current_database() AS name
    `;
    expect(databaseA?.name).toBe(deriveTestDbName());
    expect(databaseB?.name).toBe(databaseA?.name);
  });

  it('shares one HTTP quota across two real apps and keeps handler/header behavior frozen', async () => {
    await createTestUser(appA, { username: 'shared-quota-user' });

    for (let index = 0; index < 5; index += 1) {
      const target = index % 2 === 0 ? appA : appB;
      const response = await request(httpServer(target))
        .post('/api/auth/v1/login')
        .send({ username: 'shared-quota-user', password: 'WrongPwd1!' });
      expectBizError(response, BizCode.LOGIN_FAILED);
    }

    // A per-process Map would allow this sixth aggregate request because appB has only
    // consumed two local hits. PostgreSQL shared state must block it globally.
    const blocked = await request(httpServer(appB))
      .post('/api/auth/v1/login')
      .send({ username: 'shared-quota-user', password: TEST_PASSWORD });
    expectBizError(blocked, BizCode.TOO_MANY_REQUESTS);
    expect(blocked.headers).not.toHaveProperty('retry-after');
    expect(Object.keys(blocked.headers).join(',')).not.toMatch(/x-ratelimit/i);
  });

  it('normalizes a rounded future empty bucket to one full first-hit TTL', async () => {
    const key = 'rounded-future-empty';
    const seeded = await createRoundedFutureBucket(prismaA, key);

    const result = await storageA.increment(key, 5_000, 100, 5_000, 'default');
    const bucket = await prismaA.throttlerBucket.findUniqueOrThrow({
      where: { throttlerName_key: { throttlerName: 'default', key } },
    });

    expect(result).toMatchObject({ totalHits: 1, timeToExpire: 5, isBlocked: false });
    expect(bucket.windowExpiresAt.getTime()).toBe(bucket.hitExpiresAt[0]?.getTime());
    expect(bucket.windowExpiresAt.getTime() - bucket.updatedAt.getTime()).toBe(5_000);
    expect(bucket.windowExpiresAt.getTime()).toBeLessThan(seeded.windowExpiresAt.getTime());
    expect(bucket.retentionAt.getTime()).toBeGreaterThanOrEqual(bucket.windowExpiresAt.getTime());
  });

  it('normalizes a rounded future empty bucket after an expired block', async () => {
    const key = 'rounded-future-expired-block-empty';
    const seeded = await createRoundedFutureBucket(prismaA, key, {
      blockedUntil: new Date(Date.now() - 5_000),
    });

    const result = await storageA.increment(key, 5_000, 100, 5_000, 'default');
    const bucket = await prismaA.throttlerBucket.findUniqueOrThrow({
      where: { throttlerName_key: { throttlerName: 'default', key } },
    });

    expect(result).toMatchObject({ totalHits: 1, timeToExpire: 5, isBlocked: false });
    expect(result.timeToBlockExpire).toBeLessThanOrEqual(0);
    expect(bucket.windowExpiresAt.getTime()).toBe(bucket.hitExpiresAt[0]?.getTime());
    expect(bucket.windowExpiresAt.getTime() - bucket.updatedAt.getTime()).toBe(5_000);
    expect(bucket.windowExpiresAt.getTime()).toBeLessThan(seeded.windowExpiresAt.getTime());
  });

  it('keeps an active block unchanged even when its rounded future bucket is empty', async () => {
    const key = 'rounded-future-active-block-empty';
    const blockedUntil = new Date(Date.now() + 20_000);
    const seeded = await createRoundedFutureBucket(prismaA, key, { blockedUntil });

    const result = await storageA.increment(key, 5_000, 100, 5_000, 'default');
    const bucket = await prismaA.throttlerBucket.findUniqueOrThrow({
      where: { throttlerName_key: { throttlerName: 'default', key } },
    });

    expect(result).toMatchObject({ totalHits: 0, isBlocked: true });
    expect(bucket.hitExpiresAt).toEqual([]);
    expect(bucket.windowExpiresAt.getTime()).toBe(seeded.windowExpiresAt.getTime());
    expect(bucket.blockedUntil?.getTime()).toBe(seeded.blockedUntil?.getTime());
    expect(bucket.retentionAt.getTime()).toBeGreaterThanOrEqual(bucket.windowExpiresAt.getTime());
  });

  it('preserves an expired-block window when raw hits are nonempty but all filtered hits expired', async () => {
    const key = 'rounded-future-expired-block-raw-hit';
    const seeded = await createRoundedFutureBucket(prismaA, key, {
      hitExpiresAt: [new Date(Date.now() - 10_000)],
      blockedUntil: new Date(Date.now() - 5_000),
    });

    const result = await storageA.increment(key, 5_000, 100, 5_000, 'default');
    const bucket = await prismaA.throttlerBucket.findUniqueOrThrow({
      where: { throttlerName_key: { throttlerName: 'default', key } },
    });

    expect(result.totalHits).toBe(1);
    expect(result.isBlocked).toBe(false);
    expect(result.timeToExpire).toBeGreaterThan(5);
    expect(result.timeToBlockExpire).toBeLessThanOrEqual(0);
    expect(bucket.hitExpiresAt).toHaveLength(1);
    expect(bucket.windowExpiresAt.getTime()).toBe(seeded.windowExpiresAt.getTime());
    expect(bucket.retentionAt.getTime()).toBe(bucket.windowExpiresAt.getTime());
  });

  it('serializes two-app first hits after normalizing one rounded future empty bucket', async () => {
    const key = 'rounded-future-first-hit-race';
    const seeded = await createRoundedFutureBucket(prismaA, key);
    const blockerPrisma = new PrismaService({ transactionOptions: { timeout: 15_000 } });
    const observerPrisma = new PrismaService({ transactionOptions: { timeout: 15_000 } });
    const pending: Array<Promise<unknown>> = [];
    let publishBlockerPid!: (pid: number) => void;
    let releaseBlocker!: () => void;
    const blockerPidReady = new Promise<number>((resolve) => {
      publishBlockerPid = resolve;
    });
    const waitForRelease = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });

    try {
      await Promise.all([blockerPrisma.$connect(), observerPrisma.$connect()]);
      const blocker = blockerPrisma.$transaction(
        async (tx) => {
          const [locked] = await tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pg_backend_pid() AS pid
            FROM "throttler_buckets" AS bucket
            WHERE bucket."throttlerName" = 'default'
              AND bucket."key" = ${key}
            FOR UPDATE
          `;
          if (!locked) throw new Error('failed to lock seeded throttler bucket');
          publishBlockerPid(locked.pid);
          await waitForRelease;
        },
        { timeout: 15_000 },
      );
      pending.push(blocker);
      const blockerPid = await Promise.race([
        blockerPidReady,
        blocker.then(() => {
          throw new Error('throttler blocker ended before publishing its backend pid');
        }),
      ]);

      const incrementA = storageA.increment(key, 5_000, 100, 5_000, 'default');
      const incrementB = storageB.increment(key, 5_000, 100, 5_000, 'default');
      pending.push(incrementA, incrementB);
      await waitForTwoBlockedThrottlerWaiters(observerPrisma, blockerPid);

      releaseBlocker();
      const [, resultA, resultB] = await Promise.all([blocker, incrementA, incrementB]);
      const results = [resultA, resultB];
      const first = results.find(({ totalHits }) => totalHits === 1);
      const bucket = await prismaA.throttlerBucket.findUniqueOrThrow({
        where: { throttlerName_key: { throttlerName: 'default', key } },
      });

      expect(results.map(({ totalHits }) => totalHits).sort((a, b) => a - b)).toEqual([1, 2]);
      expect(first?.timeToExpire).toBe(5);
      expect(bucket.hitExpiresAt).toHaveLength(2);
      expect(bucket.windowExpiresAt.getTime()).toBe(bucket.hitExpiresAt[0]?.getTime());
      expect(bucket.windowExpiresAt.getTime()).toBeLessThan(seeded.windowExpiresAt.getTime());
      expect(bucket.retentionAt.getTime()).toBeGreaterThanOrEqual(
        bucket.hitExpiresAt[1]?.getTime() ?? 0,
      );
    } finally {
      releaseBlocker();
      await Promise.allSettled(pending);
      await Promise.allSettled([blockerPrisma.$disconnect(), observerPrisma.$disconnect()]);
    }
  });

  it('serializes first-hit and hot-key races without lost updates', async () => {
    const firstHitResults = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? storageA : storageB).increment(
          'first-hit-race',
          5_000,
          100,
          5_000,
          'default',
        ),
      ),
    );
    expect(firstHitResults.map(({ totalHits }) => totalHits).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    const firstBucket = await prismaA.throttlerBucket.findUniqueOrThrow({
      where: { throttlerName_key: { throttlerName: 'default', key: 'first-hit-race' } },
    });
    expect(firstBucket.hitExpiresAt).toHaveLength(20);

    const hotKeyResults = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? storageA : storageB).increment(
          'blocked-hot-key',
          5_000,
          5,
          5_000,
          'default',
        ),
      ),
    );
    expect(hotKeyResults.filter(({ isBlocked }) => !isBlocked)).toHaveLength(5);
    expect(hotKeyResults.filter(({ isBlocked }) => isBlocked)).toHaveLength(15);
    expect(Math.max(...hotKeyResults.map(({ totalHits }) => totalHits))).toBe(6);
    const hotBucket = await prismaA.throttlerBucket.findUniqueOrThrow({
      where: { throttlerName_key: { throttlerName: 'default', key: 'blocked-hot-key' } },
    });
    // The limit+1 request creates the block; the next 14 blocked requests add no hits.
    expect(hotBucket.hitExpiresAt).toHaveLength(6);
  });

  it('captures DB time only after a contended bucket row lock is acquired', async () => {
    const key = 'clock-after-row-lock';
    await storageA.increment(key, 5_000, 100, 5_000, 'default');
    const waiterPrisma = new PrismaService({ transactionOptions: { timeout: 15_000 } });
    await waiterPrisma.$connect();
    const waiterStorage = new PostgresqlThrottlerStorage(waiterPrisma);

    let markLockAcquired!: () => void;
    let releaseLock!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      markLockAcquired = resolve;
    });
    const waitForRelease = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    try {
      const blocker = prismaA.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT bucket."id"
            FROM "throttler_buckets" AS bucket
            WHERE bucket."throttlerName" = 'default'
              AND bucket."key" = ${key}
            FOR UPDATE
          `;
          markLockAcquired();
          await waitForRelease;
        },
        { timeout: 15_000 },
      );
      await lockAcquired;

      const waitingIncrement = waiterStorage.increment(key, 5_000, 100, 5_000, 'default');
      // Hold longer than the TTL. A pre-lock captured clock would write an already-expired hit.
      await delay(6_000);
      releaseLock();
      const [, result] = await Promise.all([blocker, waitingIncrement]);

      expect(result).toMatchObject({ totalHits: 1, timeToExpire: 5, isBlocked: false });
      const bucket = await waiterPrisma.throttlerBucket.findUniqueOrThrow({
        where: { throttlerName_key: { throttlerName: 'default', key } },
      });
      expect(bucket.hitExpiresAt).toHaveLength(1);
      expect(bucket.hitExpiresAt[0].getTime() - Date.now()).toBeGreaterThan(3_000);
    } finally {
      releaseLock();
      await waiterPrisma.$disconnect();
    }
  });

  it('keeps 10 names and IP-derived keys physically isolated', async () => {
    const sameKeyResults = await Promise.all(
      THROTTLER_NAMES.map((name, index) =>
        (index % 2 === 0 ? storageA : storageB).increment(
          'same-package-key',
          5_000,
          1,
          5_000,
          name,
        ),
      ),
    );
    expect(sameKeyResults.every(({ totalHits, isBlocked }) => totalHits === 1 && !isBlocked)).toBe(
      true,
    );
    expect(await prismaA.throttlerBucket.count({ where: { key: 'same-package-key' } })).toBe(10);

    const blockedDefault = await storageB.increment('same-package-key', 5_000, 1, 5_000, 'default');
    expect(blockedDefault).toMatchObject({ totalHits: 2, isBlocked: true });
    const unaffectedName = await storageA.increment(
      'same-package-key',
      5_000,
      2,
      5_000,
      PASSWORD_CHANGE_THROTTLER_NAME,
    );
    expect(unaffectedName).toMatchObject({ totalHits: 2, isBlocked: false });

    // ThrottlerGuard's unchanged package key includes req.ip. Distinct resulting keys must
    // remain independent even under the same name.
    const ipA = await storageA.increment('route-hash-ip-a', 5_000, 1, 5_000, 'default');
    const ipB = await storageB.increment('route-hash-ip-b', 5_000, 1, 5_000, 'default');
    expect(ipA).toMatchObject({ totalHits: 1, isBlocked: false });
    expect(ipB).toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it('uses rolling individual hit expiry rather than a fixed window', async () => {
    const first = await storageA.increment('rolling-expiry', 10_000, 10, 10_000, 'default');
    expect(first).toMatchObject({ totalHits: 1, timeToExpire: 10, isBlocked: false });

    await delay(5_000);
    const second = await storageB.increment('rolling-expiry', 10_000, 10, 10_000, 'default');
    expect(second.totalHits).toBe(2);

    await delay(6_000);
    const third = await storageA.increment('rolling-expiry', 10_000, 10, 10_000, 'default');
    // The first hit expired, the second remains, and the current request is the new second
    // hit with about 4s safety margin. A fixed-window reset at t=10s would incorrectly
    // return 1 here.
    expect(third).toMatchObject({ totalHits: 2, timeToExpire: 10, isBlocked: false });
  });

  it('keeps TTL correct under a non-UTC PostgreSQL session timezone', async () => {
    const zonedUrl = new URL(process.env.DATABASE_URL ?? '');
    zonedUrl.searchParams.set('options', '-c TimeZone=Asia/Shanghai');
    const zonedPrisma = new PrismaService({ datasourceUrl: zonedUrl.toString() });

    await zonedPrisma.$connect();
    try {
      const [session] = await zonedPrisma.$queryRaw<Array<{ timezone: string }>>`
        SELECT current_setting('TimeZone') AS "timezone"
      `;
      expect(session?.timezone).toBe('Asia/Shanghai');

      const before = Date.now();
      const zonedStorage = new PostgresqlThrottlerStorage(zonedPrisma);
      const first = await zonedStorage.increment(
        'asia-shanghai-first-hit',
        1_000,
        2,
        1_000,
        'default',
      );
      const bucket = await zonedPrisma.throttlerBucket.findUniqueOrThrow({
        where: {
          throttlerName_key: { throttlerName: 'default', key: 'asia-shanghai-first-hit' },
        },
      });

      expect(first).toMatchObject({ totalHits: 1, timeToExpire: 1, isBlocked: false });
      expect(bucket.windowExpiresAt.getTime() - before).toBeGreaterThanOrEqual(800);
      expect(bucket.windowExpiresAt.getTime() - before).toBeLessThanOrEqual(2_000);
      expect(bucket.retentionAt.getTime()).toBeGreaterThanOrEqual(bucket.windowExpiresAt.getTime());
    } finally {
      await zonedPrisma.$disconnect();
    }
  });

  it('does not add blocked hits and resets block expiry with the current request as hit 1', async () => {
    await storageA.increment('block-expiry', 5_000, 2, 800, 'default');
    await storageB.increment('block-expiry', 5_000, 2, 800, 'default');
    const limitPlusOne = await storageA.increment('block-expiry', 5_000, 2, 800, 'default');
    expect(limitPlusOne).toMatchObject({ totalHits: 3, isBlocked: true, timeToBlockExpire: 1 });

    const whileBlocked = await storageB.increment('block-expiry', 5_000, 2, 800, 'default');
    expect(whileBlocked).toMatchObject({ totalHits: 3, isBlocked: true });

    await delay(900);
    const afterBlock = await storageA.increment('block-expiry', 5_000, 2, 800, 'default');
    expect(afterBlock.totalHits).toBe(1);
    expect(afterBlock.isBlocked).toBe(false);
    expect(afterBlock.timeToBlockExpire).toBeLessThanOrEqual(0);
  });

  it('fails closed on storage errors and never invokes the business handler', async () => {
    const transactionFailure = jest
      .spyOn(prismaA, '$transaction')
      .mockRejectedValueOnce(new Error('injected throttler storage failure'));
    const loginHandler = jest.spyOn(appA.get(AuthService), 'login');

    const response = await request(httpServer(appA))
      .post('/api/auth/v1/login')
      .send({ username: 'not-reached', password: 'WrongPwd1!' });

    expectBizError(response, BizCode.INTERNAL_ERROR, { strictMessage: false });
    expect(loginHandler).not.toHaveBeenCalled();
    expect(transactionFailure).toHaveBeenCalledTimes(1);

    loginHandler.mockRestore();
    transactionFailure.mockRestore();
  });
});
