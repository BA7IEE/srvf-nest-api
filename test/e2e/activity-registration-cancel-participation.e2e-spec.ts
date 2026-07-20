import type { INestApplication } from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityRegistrationAuditRecorder } from '../../src/modules/activity-registrations/activity-registration-audit-recorder';
import { ActivityRegistrationsService } from '../../src/modules/activity-registrations/activity-registrations.service';
import { AppActivityCheckInsService } from '../../src/modules/attendances/app-activity-check-ins.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const AUDIT_META: AuditMeta = {
  requestId: 'cancel-participation-e2e-000001',
  ip: '127.0.0.1',
  ua: 'jest/activity-registration-cancel-participation',
};

interface BackendIdentity {
  pid: number;
  databaseName: string;
}

interface BlockedBackend extends BackendIdentity {
  blockingPids: number[];
  waitEventType: string | null;
}

interface CheckInLockHook {
  lockAndLoadWriteContext: (
    tx: Prisma.TransactionClient,
    activityId: string,
    memberId: string,
    action: string,
  ) => Promise<unknown>;
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readBackendIdentity(
  client: Pick<PrismaService, '$queryRaw'> | Prisma.TransactionClient,
): Promise<BackendIdentity> {
  const rows = await client.$queryRaw<BackendIdentity[]>(Prisma.sql`
    SELECT pg_backend_pid() AS pid, current_database() AS "databaseName"
  `);
  const identity = rows[0];
  if (identity === undefined) throw new Error('PostgreSQL backend identity missing');
  return identity;
}

async function waitForPausedTransaction(prisma: PrismaService, blockerPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<Array<{ state: string; waitEventType: string | null }>>(
      Prisma.sql`
        SELECT state, wait_event_type AS "waitEventType"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid = CAST(${blockerPid} AS integer)
      `,
    );
    if (rows[0]?.state === 'idle in transaction' && rows[0].waitEventType === 'Client') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`backend ${blockerPid} did not pause inside its transaction`);
}

async function waitForBlockedBackend(
  prisma: PrismaService,
  blocker: BackendIdentity,
  mutation: Promise<unknown>,
  queryPattern: string,
): Promise<BlockedBackend> {
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
    if (settled) throw new Error('mutation settled before the expected PostgreSQL lock wait');
    const rows = await prisma.$queryRaw<BlockedBackend[]>(Prisma.sql`
      SELECT
        pid,
        datname AS "databaseName",
        pg_blocking_pids(pid) AS "blockingPids",
        wait_event_type AS "waitEventType"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> CAST(${blocker.pid} AS integer)
        AND wait_event_type = 'Lock'
        AND CAST(${blocker.pid} AS integer) = ANY(pg_blocking_pids(pid))
        AND query LIKE ${queryPattern}
      LIMIT 1
    `);
    const waiter = rows[0];
    if (waiter !== undefined) {
      expect(waiter.pid).not.toBe(blocker.pid);
      expect(waiter.databaseName).toBe(blocker.databaseName);
      expect(waiter.blockingPids).toContain(blocker.pid);
      expect(waiter.waitEventType).toBe('Lock');
      return waiter;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no PostgreSQL lock waiter observed for ${queryPattern}`);
}

describe('activity registration cancel participation evidence', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let registrationsA: ActivityRegistrationsService;
  let registrationsB: ActivityRegistrationsService;
  let checkInsA: AppActivityCheckInsService;
  let checkInsB: AppActivityCheckInsService;
  let admin: CurrentUserPayload;
  let user: CurrentUserPayload;
  let organizationId: string;
  let sequence = 0;

  beforeAll(async () => {
    appA = await createTestApp();
    await resetDb(appA);
    appB = await createTestApp();
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    registrationsA = appA.get(ActivityRegistrationsService);
    registrationsB = appB.get(ActivityRegistrationsService);
    checkInsA = appA.get(AppActivityCheckInsService);
    checkInsB = appB.get(AppActivityCheckInsService);

    const [backendA, backendB] = await Promise.all([
      readBackendIdentity(prismaA),
      readBackendIdentity(prismaB),
    ]);
    expect(backendA.databaseName).toBe(backendB.databaseName);
    expect(backendA.pid).not.toBe(backendB.pid);

    const adminUser = await createTestUser(appA, {
      username: 'cancel-evidence-admin',
      role: Role.SUPER_ADMIN,
    });
    admin = {
      id: adminUser.id,
      username: adminUser.username,
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };

    organizationId = (
      await prismaA.organization.create({
        data: { name: 'Cancel Evidence Org', nodeTypeCode: 'team' },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close()]);
  });

  async function createMemberUser(label: string): Promise<CurrentUserPayload> {
    sequence += 1;
    const member = await prismaA.member.create({
      data: {
        memberNo: `cancel-evidence-${label}-${sequence}`,
        displayName: `Cancel Evidence ${label} ${sequence}`,
      },
      select: { id: true },
    });
    const linkedUser = await createTestUser(appA, {
      username: `cancel-evidence-${label}-${sequence}`,
      role: Role.USER,
    });
    await prismaA.user.update({ where: { id: linkedUser.id }, data: { memberId: member.id } });
    return {
      id: linkedUser.id,
      username: linkedUser.username,
      role: Role.USER,
      status: UserStatus.ACTIVE,
      memberId: member.id,
    };
  }

  async function seedPassRegistration(label: string): Promise<{
    activityId: string;
    registrationId: string;
    memberId: string;
  }> {
    user = await createMemberUser(label);
    const now = Date.now();
    const activity = await prismaA.activity.create({
      data: {
        title: `Cancel Evidence ${label} ${++sequence}`,
        activityTypeCode: 'cancel-evidence',
        organizationId,
        startAt: new Date(now - 60 * 60_000),
        endAt: new Date(now + 60 * 60_000),
        location: 'Cancel Evidence E2E',
        locationLongitude: '114.0000000',
        locationLatitude: '22.0000000',
        statusCode: 'published',
        publishedAt: new Date(now - 60_000),
      },
      select: { id: true },
    });
    const registration = await prismaA.activityRegistration.create({
      data: {
        activityId: activity.id,
        memberId: user.memberId!,
        statusCode: 'pass',
        reviewedBy: admin.id,
        reviewedAt: new Date(),
      },
      select: { id: true },
    });
    return {
      activityId: activity.id,
      registrationId: registration.id,
      memberId: user.memberId!,
    };
  }

  it('check-in-first:cancel 真实等待后以 21033 失败，零取消审计 / 零递补', async () => {
    const fixture = await seedPassRegistration('check-in-first');
    const waitlistedUser = await createMemberUser('waitlisted');
    const waitlisted = await prismaA.activityRegistration.create({
      data: {
        activityId: fixture.activityId,
        memberId: waitlistedUser.memberId!,
        statusCode: 'waitlisted',
      },
      select: { id: true },
    });
    const hooks = checkInsA as unknown as CheckInLockHook;
    const originalLock = hooks.lockAndLoadWriteContext.bind(checkInsA);
    const reached = deferred<BackendIdentity>();
    const release = deferred();
    const lockSpy = jest
      .spyOn(hooks, 'lockAndLoadWriteContext')
      .mockImplementation(async (tx, activityId, memberId, action) => {
        const context = await originalLock(tx, activityId, memberId, action);
        if (activityId === fixture.activityId) {
          reached.resolve(await readBackendIdentity(tx));
          await release.promise;
        }
        return context;
      });

    let checkInPromise: ReturnType<AppActivityCheckInsService['checkIn']> | undefined;
    let cancelPromise: ReturnType<ActivityRegistrationsService['cancelAdmin']> | undefined;
    try {
      checkInPromise = checkInsA.checkIn(
        fixture.activityId,
        { longitude: 114, latitude: 22, accuracy: 5 },
        user,
      );
      const blocker = await withTimeout(reached.promise, 'check-in transaction barrier');
      await waitForPausedTransaction(prismaB, blocker.pid);

      cancelPromise = registrationsB.cancelAdmin(
        fixture.activityId,
        fixture.registrationId,
        {},
        admin,
        AUDIT_META,
      );
      await waitForBlockedBackend(prismaA, blocker, cancelPromise, '%FROM "Activity"%FOR UPDATE%');
      release.resolve();

      await withTimeout(checkInPromise, 'check-in completion');
      await expect(withTimeout(cancelPromise, 'cancel rejection')).rejects.toMatchObject({
        biz: BizCode.ACTIVITY_REGISTRATION_HAS_ATTENDANCE,
      });

      expect(
        await prismaA.activityCheckIn.count({
          where: { registrationId: fixture.registrationId, deletedAt: null },
        }),
      ).toBe(1);
      expect(
        await prismaA.activityRegistration.findUniqueOrThrow({
          where: { id: fixture.registrationId },
          select: { statusCode: true, cancelledAt: true, cancelledByUserId: true },
        }),
      ).toEqual({ statusCode: 'pass', cancelledAt: null, cancelledByUserId: null });
      expect(
        await prismaA.activityRegistration.findUniqueOrThrow({
          where: { id: waitlisted.id },
          select: { statusCode: true },
        }),
      ).toEqual({ statusCode: 'waitlisted' });
      expect(
        await prismaA.auditLog.count({
          where: {
            event: 'registration.review',
            resourceId: { in: [fixture.registrationId, waitlisted.id] },
          },
        }),
      ).toBe(0);
    } finally {
      release.resolve();
      try {
        await withTimeout(
          Promise.allSettled([checkInPromise, cancelPromise].filter((item) => item !== undefined)),
          'check-in-first cleanup drain',
        );
      } finally {
        lockSpy.mockRestore();
      }
    }
  });

  it('soft-deleted ActivityCheckIn:不阻断 pass 取消，正常递补 waitlisted', async () => {
    const fixture = await seedPassRegistration('soft-deleted-check-in');
    const waitlistedUser = await createMemberUser('soft-deleted-waitlisted');
    const waitlisted = await prismaA.activityRegistration.create({
      data: {
        activityId: fixture.activityId,
        memberId: waitlistedUser.memberId!,
        statusCode: 'waitlisted',
      },
      select: { id: true },
    });
    const checkIn = await checkInsA.checkIn(
      fixture.activityId,
      { longitude: 114, latitude: 22, accuracy: 5 },
      user,
    );
    await prismaA.activityCheckIn.update({
      where: { id: checkIn.id },
      data: { deletedAt: new Date() },
    });

    await expect(
      withTimeout(
        registrationsA.cancelAdmin(
          fixture.activityId,
          fixture.registrationId,
          {},
          admin,
          AUDIT_META,
        ),
        'soft-deleted evidence cancellation',
      ),
    ).resolves.toMatchObject({ statusCode: 'cancelled' });

    expect(
      await prismaA.activityCheckIn.count({
        where: { registrationId: fixture.registrationId, deletedAt: null },
      }),
    ).toBe(0);
    expect(
      await prismaA.activityCheckIn.count({
        where: { registrationId: fixture.registrationId },
      }),
    ).toBe(1);
    expect(
      await prismaA.activityRegistration.findUniqueOrThrow({
        where: { id: fixture.registrationId },
        select: { statusCode: true, cancelledAt: true },
      }),
    ).toEqual({ statusCode: 'cancelled', cancelledAt: expect.any(Date) });
    expect(
      await prismaA.activityRegistration.findUniqueOrThrow({
        where: { id: waitlisted.id },
        select: { statusCode: true },
      }),
    ).toEqual({ statusCode: 'pending' });
  });

  it('cancel-first:check-in 真实等待后以 22076 失败，零 ActivityCheckIn', async () => {
    const fixture = await seedPassRegistration('cancel-first');
    const recorder = appA.get(ActivityRegistrationAuditRecorder);
    const originalLogCancel = recorder.logCancel.bind(recorder);
    const reached = deferred<BackendIdentity>();
    const release = deferred();
    const auditSpy = jest.spyOn(recorder, 'logCancel').mockImplementation(async (args) => {
      await originalLogCancel(args);
      if (args.registrationId === fixture.registrationId) {
        reached.resolve(await readBackendIdentity(args.tx));
        await release.promise;
      }
    });

    let cancelPromise: ReturnType<ActivityRegistrationsService['cancelAdmin']> | undefined;
    let checkInPromise: ReturnType<AppActivityCheckInsService['checkIn']> | undefined;
    try {
      cancelPromise = registrationsA.cancelAdmin(
        fixture.activityId,
        fixture.registrationId,
        {},
        admin,
        AUDIT_META,
      );
      const blocker = await withTimeout(reached.promise, 'cancel transaction barrier');
      await waitForPausedTransaction(prismaB, blocker.pid);

      checkInPromise = checkInsB.checkIn(
        fixture.activityId,
        { longitude: 114, latitude: 22, accuracy: 5 },
        user,
      );
      await waitForBlockedBackend(prismaA, blocker, checkInPromise, '%FROM "Activity"%FOR SHARE%');
      release.resolve();

      await expect(withTimeout(cancelPromise, 'cancel completion')).resolves.toMatchObject({
        statusCode: 'cancelled',
      });
      await expect(withTimeout(checkInPromise, 'check-in rejection')).rejects.toMatchObject({
        biz: BizCode.ATTENDANCE_REGISTRATION_INVALID,
      });
      expect(BizCode.ATTENDANCE_REGISTRATION_INVALID.code).toBe(22076);
      expect(
        await prismaA.activityCheckIn.count({
          where: { registrationId: fixture.registrationId, deletedAt: null },
        }),
      ).toBe(0);
    } finally {
      release.resolve();
      try {
        await withTimeout(
          Promise.allSettled([cancelPromise, checkInPromise].filter((item) => item !== undefined)),
          'cancel-first cleanup drain',
        );
      } finally {
        auditSpy.mockRestore();
      }
    }
  });
});
