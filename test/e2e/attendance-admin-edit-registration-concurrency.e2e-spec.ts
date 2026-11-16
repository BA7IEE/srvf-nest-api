import type { INestApplication } from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityRegistrationsService } from '../../src/modules/activity-registrations/activity-registrations.service';
import { RegistrationCommandService } from '../../src/modules/activity-registrations/registration-command.service';
import {
  AttendancePunchCommandService,
  type ManagedOnlinePunchInput,
} from '../../src/modules/attendances/attendance-punch-command.service';
import { createTestUser } from '../fixtures/users.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// The retired Admin Sheet edit/delete writers have no compatibility aliases.
// Preserve their actual concurrency obligations on the managed punch writer:
// Activity root locking, cancellation rechecks, and immutable correction facts.
// All barriers below hold real PostgreSQL rows, without mocking business reads.
const META = { requestId: 'managed-punch-registration-race', ip: null, ua: null };
const WAIT_TIMEOUT_MS = 1_200;
const CASE_TIMEOUT_MS = 60_000;
interface Fixture {
  activityId: string;
  sessionId: string;
  registrationId: string;
  identityId: string;
  input: ManagedOnlinePunchInput;
}
interface Barrier {
  ready: Promise<number>;
  release: () => void;
  done: Promise<void>;
}

describe('Managed punch/correction × registration cancellation — migrated Admin race acceptance', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let dbA: PrismaService;
  let dbB: PrismaService;
  let punches: AttendancePunchCommandService;
  let registrations: ActivityRegistrationsService;
  let manager: CurrentUserPayload;
  let organizationId: string;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;

  async function memberUser(name: string, role: Role): Promise<CurrentUserPayload> {
    const member = await dbA.member.create({
      data: { memberNo: name, ...memberIdentityData(name), gradeCode: 'level-2' },
    });
    const user = await createTestUser(appA, { username: name, role });
    await dbA.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      status: UserStatus.ACTIVE,
      memberId: member.id,
    };
  }

  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    appA = await createTestApp();
    await resetDb(appA);
    appB = await createTestApp();
    dbA = appA.get(PrismaService);
    dbB = appB.get(PrismaService);
    punches = appB.get(AttendancePunchCommandService);
    registrations = appA.get(ActivityRegistrationsService);
    manager = await memberUser('managed-race-manager', Role.SUPER_ADMIN);
    organizationId = (
      await dbA.organization.create({
        data: { name: 'Managed punch race', nodeTypeCode: 'team' },
      })
    ).id;
  });
  afterAll(async () => {
    try {
      const results = await Promise.allSettled([appA?.close(), appB?.close()]);
      expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    } finally {
      if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    }
  });

  async function fixture(): Promise<Fixture> {
    const tag = `managed-race-${++sequence}`;
    const user = await memberUser(tag, Role.USER);
    const start = new Date(Date.now() - 3_600_000);
    const end = new Date(Date.now() + 3_600_000);
    const activity = await dbA.activity.create({
      data: {
        title: tag,
        activityTypeCode: 'managed-race',
        organizationId,
        startAt: start,
        endAt: end,
        location: 'race',
        statusCode: 'published',
        isPublicRegistration: true,
        allocationModeCode: 'first_come',
        capacity: 1,
        registrationDeadline: end,
      },
    });
    const session = await dbA.activitySession.create({
      data: {
        activityId: activity.id,
        code: tag,
        name: tag,
        startAt: start,
        endAt: end,
        locationText: 'race',
        capacity: 1,
        statusCode: 'scheduled',
        locationRequired: false,
        locationPolicySourceCode: 'session',
        checkInOpenAt: start,
        checkInCloseAt: end,
        checkOutOpenAt: start,
        checkOutCloseAt: end,
      },
    });
    await dbA.activityCapacityBucket.createMany({
      data: [
        {
          activityId: activity.id,
          scopeTypeCode: 'activity_person',
          scopeId: activity.id,
          capacity: 1,
        },
        {
          activityId: activity.id,
          scopeTypeCode: 'session_participation',
          scopeId: session.id,
          capacity: 1,
        },
      ],
    });
    await dbA.activityEvidenceState.create({ data: { activityId: activity.id } });
    await dbA.activityResponsibilityAssignment.create({
      data: {
        activityId: activity.id,
        memberId: manager.memberId!,
        responsibilityType: 'owner',
        canManageAttendance: true,
        canManageRegistrations: true,
        status: 'active',
        source: 'admin',
        assignedByUserId: manager.id,
      },
    });
    // Use the real registration command, including coherent revisions and both
    // reservations; cancellation must exercise the production release path.
    const registered = await appA.get(RegistrationCommandService).submit(
      activity.id,
      {
        operationKey: `${tag}:register`,
        formVersion: null,
        answers: [],
        preferences: [{ sessionId: session.id, positionIds: [] }],
      },
      user,
      META,
    );
    const identity = await dbA.activityParticipationIdentity.findFirstOrThrow({
      where: { registrationId: registered.registrationId },
    });
    expect(identity).toMatchObject({ currentStatusCode: 'pass', populationIncluded: true });
    return {
      activityId: activity.id,
      sessionId: session.id,
      registrationId: registered.registrationId,
      identityId: identity.id,
      input: {
        activityId: activity.id,
        sessionId: session.id,
        participationIdentityId: identity.id,
        memberCredential: null,
        actionCode: 'check_in',
        sourceCode: 'proxy',
        eventKey: `${tag}:punch`,
        reason: '人工现场确认',
        deviceId: null,
        longitude: null,
        latitude: null,
        accuracy: null,
        currentUser: manager,
        auditMeta: META,
      },
    };
  }

  function holdRow(
    table: 'Activity' | 'ActivitySession' | 'ActivityRegistration',
    id: string,
  ): Barrier {
    let acquired!: (pid: number) => void;
    let failed!: (error: unknown) => void;
    let release!: () => void;
    const ready = new Promise<number>((resolve, reject) => {
      acquired = resolve;
      failed = reject;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = dbA.$transaction(
      async (tx) => {
        // table is a closed, test-owned union; the resource id is parameterized.
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE id = ${id} FOR UPDATE`,
        );
        const [row] = await tx.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid()::int AS pid`;
        acquired(row.pid);
        await gate;
      },
      { timeout: 60_000, maxWait: 60_000 },
    );
    void done.catch(failed);
    return { ready, release, done };
  }

  async function waiter(
    blockerPid: number,
    pending: Promise<unknown>,
    table: string,
  ): Promise<number> {
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (settled) throw new Error('Mutation settled before its required row lock wait');
      const rows = await dbA.$queryRaw<Array<{ pid: number; blockers: number[] }>>(Prisma.sql`
        SELECT pid, pg_blocking_pids(pid) AS blockers
        FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND CAST(${blockerPid} AS integer) = ANY(pg_blocking_pids(pid))
          AND query LIKE ${`%FROM "${table}"%FOR ${table === 'ActivityRegistration' ? 'NO KEY ' : ''}UPDATE%`}
      `);
      if (rows.length === 1) {
        expect(rows[0].pid).not.toBe(blockerPid);
        expect(rows[0].blockers).toContain(blockerPid);
        return rows[0].pid;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Required ${table} row lock waiter was not observed`);
  }
  function cancel(input: Fixture) {
    return registrations.cancelAdmin(
      input.activityId,
      input.registrationId,
      { cancelReason: '并发取消' },
      manager,
      META,
    );
  }
  async function expectNoFactUnderCancelledRegistration() {
    expect(
      await dbA.attendancePunchEvent.count({
        where: {
          participationIdentity: {
            registration: { OR: [{ statusCode: { not: 'pass' } }, { deletedAt: { not: null } }] },
          },
        },
      }),
    ).toBe(0);
    expect(await dbA.attendanceRecord.count()).toBe(0);
  }

  it('uses separate application clients and PostgreSQL backends on the same database', async () => {
    expect(dbA).not.toBe(dbB);
    const [[a], [b]] = await Promise.all([
      dbA.$queryRaw<
        Array<{ pid: number; db: string }>
      >`SELECT pg_backend_pid()::int AS pid, current_database() AS db`,
      dbB.$queryRaw<
        Array<{ pid: number; db: string }>
      >`SELECT pg_backend_pid()::int AS pid, current_database() AS db`,
    ]);
    expect(a.db).toBe(b.db);
    expect(a.pid).not.toBe(b.pid);
  });

  it(
    'managed punch first: cancel waits on its Activity lock, then refuses 21033 without cancellation writes',
    async () => {
      const input = await fixture();
      const auditWhere = { event: 'registration.review', resourceId: input.registrationId };
      const audits = await dbA.auditLog.findMany({ where: auditWhere, orderBy: { id: 'asc' } });
      const reservations = await dbA.capacityReservation.findMany({
        where: { identityId: input.identityId },
        orderBy: { id: 'asc' },
      });
      expect(reservations).toHaveLength(2);
      const barrier = holdRow('ActivitySession', input.sessionId);
      const pending: Promise<unknown>[] = [];
      try {
        const blocker = await barrier.ready;
        const writing = punches.managedPunch(input.input);
        pending.push(writing);
        const writerPid = await waiter(blocker, writing, 'ActivitySession');
        const cancelling = cancel(input);
        pending.push(cancelling);
        await waiter(writerPid, cancelling, 'Activity');
        barrier.release();
        await barrier.done;
        await writing;
        await expect(cancelling).rejects.toMatchObject({
          biz: BizCode.ACTIVITY_REGISTRATION_HAS_ATTENDANCE,
        });
        expect(
          await dbA.activityRegistration.findUniqueOrThrow({
            where: { id: input.registrationId },
            select: { statusCode: true, cancelledAt: true },
          }),
        ).toEqual({ statusCode: 'pass', cancelledAt: null });
        expect(
          await dbA.attendancePunchEvent.count({
            where: { participationIdentityId: input.identityId },
          }),
        ).toBe(1);
        expect(await dbA.auditLog.findMany({ where: auditWhere, orderBy: { id: 'asc' } })).toEqual(
          audits,
        );
        expect(
          await dbA.capacityReservation.findMany({
            where: { identityId: input.identityId },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(reservations);
        await expectNoFactUnderCancelledRegistration();
      } finally {
        barrier.release();
        await Promise.allSettled([barrier.done, ...pending]);
      }
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'managed writes always wait for Activity, even with valid responsibility and identity',
    async () => {
      const input = await fixture();
      const barrier = holdRow('Activity', input.activityId);
      const pending: Promise<unknown>[] = [];
      try {
        const blocker = await barrier.ready;
        const writing = punches.managedPunch(input.input);
        pending.push(writing);
        await waiter(blocker, writing, 'Activity');
        expect(
          await dbA.attendancePunchEvent.count({ where: { activityId: input.activityId } }),
        ).toBe(0);
        barrier.release();
        await barrier.done;
        await writing;
        expect(
          await dbA.attendancePunchEvent.count({ where: { activityId: input.activityId } }),
        ).toBe(1);
        await expectNoFactUnderCancelledRegistration();
      } finally {
        barrier.release();
        await Promise.allSettled([barrier.done, ...pending]);
      }
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'native void waits for Activity and appends a correction; it cannot erase evidence to unlock cancellation',
    async () => {
      const input = await fixture();
      await punches.managedPunch(input.input);
      const original = await dbA.attendancePunchEvent.findUniqueOrThrow({
        where: { eventKey: input.input.eventKey },
      });
      const barrier = holdRow('Activity', input.activityId);
      const pending: Promise<unknown>[] = [];
      try {
        const blocker = await barrier.ready;
        const correcting = punches.voidEvent({
          activityId: input.activityId,
          eventId: original.id,
          actionCode: 'void',
          reason: '现场纠错',
          operationKey: `${input.input.eventKey}:void`,
          currentUser: manager,
          auditMeta: META,
        });
        pending.push(correcting);
        await waiter(blocker, correcting, 'Activity');
        expect(
          await dbA.attendancePunchEvent.count({ where: { activityId: input.activityId } }),
        ).toBe(1);
        barrier.release();
        await barrier.done;
        await correcting;
        expect(
          await dbA.attendancePunchEvent.findUniqueOrThrow({ where: { id: original.id } }),
        ).toEqual(original);
        expect(
          await dbA.attendancePunchEvent.findMany({
            where: { supersedesEventId: original.id },
            select: { eventTypeCode: true },
          }),
        ).toEqual([{ eventTypeCode: 'void' }]);
        const auditsBeforeCancel = await dbA.auditLog.count();
        await expect(cancel(input)).rejects.toMatchObject({
          biz: BizCode.ACTIVITY_REGISTRATION_HAS_ATTENDANCE,
        });
        expect(await dbA.auditLog.count()).toBe(auditsBeforeCancel);
        await expectNoFactUnderCancelledRegistration();
      } finally {
        barrier.release();
        await Promise.allSettled([barrier.done, ...pending]);
      }
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'cancel first: managed punch waits then rechecks cancelled identity, with no event or segment',
    async () => {
      const input = await fixture();
      const barrier = holdRow('ActivityRegistration', input.registrationId);
      const pending: Promise<unknown>[] = [];
      try {
        const blocker = await barrier.ready;
        const cancelling = cancel(input);
        pending.push(cancelling);
        const cancellingPid = await waiter(blocker, cancelling, 'ActivityRegistration');
        const writing = punches.managedPunch(input.input);
        pending.push(writing);
        await waiter(cancellingPid, writing, 'Activity');
        barrier.release();
        await barrier.done;
        await expect(cancelling).resolves.toMatchObject({ statusCode: 'cancelled' });
        await expect(writing).rejects.toMatchObject({
          biz: BizCode.ATTENDANCE_REGISTRATION_INVALID,
        });
        expect(
          await dbA.attendancePunchEvent.count({ where: { activityId: input.activityId } }),
        ).toBe(0);
        expect(
          await dbA.participantServiceSegmentRevision.count({
            where: { participationIdentityId: input.identityId },
          }),
        ).toBe(0);
        expect(
          await dbA.activityParticipationIdentity.findUniqueOrThrow({
            where: { id: input.identityId },
            select: { currentStatusCode: true, populationIncluded: true },
          }),
        ).toEqual({ currentStatusCode: 'cancelled', populationIncluded: false });
        await expectNoFactUnderCancelledRegistration();
      } finally {
        barrier.release();
        await Promise.allSettled([barrier.done, ...pending]);
      }
    },
    CASE_TIMEOUT_MS,
  );
});
