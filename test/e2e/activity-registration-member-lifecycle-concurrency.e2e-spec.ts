import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityRegistrationsService } from '../../src/modules/activity-registrations/activity-registrations.service';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { MembersService } from '../../src/modules/members/members.service';
import { TEST_PASSWORD_HASH } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const META: AuditMeta = {
  requestId: 'registration-member-lifecycle-concurrency',
  ip: '127.0.0.1',
  ua: 'jest/activity-registration-member-lifecycle-concurrency',
};
const WAIT_TIMEOUT_MS = 5_000;
const CASE_TIMEOUT_MS = 30_000;

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForMemberLockWait(
  observer: PrismaService,
  blockerPid: number,
  operation: Promise<unknown>,
): Promise<void> {
  let settled = false;
  void operation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (settled) throw new Error('approve settled before waiting on Member lifecycle lock');
    const rows = await observer.$queryRaw<Array<{ pid: number; blockingPids: number[] }>>(
      Prisma.sql`
        SELECT pid, pg_blocking_pids(pid) AS "blockingPids"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND CAST(${blockerPid} AS integer) = ANY(pg_blocking_pids(pid))
          AND query LIKE '%FROM "Member"%FOR UPDATE%'
        LIMIT 1
      `,
    );
    if (rows[0]?.blockingPids.includes(blockerPid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`approve did not wait on Member lifecycle blocker pid=${blockerPid}`);
}

describe('activity registration Member lifecycle concurrency', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let actor: CurrentUserPayload;
  let activityId: string;

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    expect(prismaA).not.toBe(prismaB);

    const actorRow = await prismaA.user.create({
      data: {
        username: 'registration-lifecycle-super-admin',
        passwordHash: TEST_PASSWORD_HASH,
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true, username: true },
    });
    actor = {
      id: actorRow.id,
      username: actorRow.username,
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
    const organization = await prismaA.organization.create({
      data: { name: 'Registration Lifecycle Concurrency', nodeTypeCode: 'team' },
      select: { id: true },
    });
    activityId = (
      await prismaA.activity.create({
        data: {
          title: 'Registration Lifecycle Concurrency',
          activityTypeCode: 'registration-lifecycle-concurrency',
          organizationId: organization.id,
          startAt: new Date('2099-12-01T01:00:00.000Z'),
          endAt: new Date('2099-12-01T05:00:00.000Z'),
          location: '深圳',
          statusCode: 'published',
          isPublicRegistration: true,
          capacity: 1,
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close()]);
  });

  it(
    'offboard 先持 Member lifecycle lock，approve 必须等待并最终拒 MEMBER_INACTIVE',
    async () => {
      const target = await prismaA.member.create({
        data: {
          memberNo: `registration-lifecycle-${Date.now()}`,
          displayName: 'Lifecycle Target',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      });
      const registration = await prismaA.activityRegistration.create({
        data: { activityId, memberId: target.id, statusCode: 'pending' },
        select: { id: true },
      });
      const offboardAuditReached = deferred<number>();
      const releaseOffboard = deferred();
      const auditLogs = appA.get(AuditLogsService);
      const originalLog = auditLogs.log.bind(auditLogs);
      const barrier = jest.spyOn(auditLogs, 'log').mockImplementation(async (input) => {
        if (input.event === 'member.offboard' && input.resourceId === target.id && input.tx) {
          const rows = await input.tx.$queryRaw<Array<{ pid: number }>>(
            Prisma.sql`SELECT pg_backend_pid() AS pid`,
          );
          offboardAuditReached.resolve(rows[0].pid);
          await releaseOffboard.promise;
        }
        return originalLog(input);
      });
      const offboard = appA.get(MembersService).offboard(target.id, actor, META);
      let approve: Promise<unknown> | undefined;

      try {
        const blockerPid = await offboardAuditReached.promise;
        approve = appB
          .get(ActivityRegistrationsService)
          .approve(activityId, registration.id, { reviewNote: '不得落库' }, actor, META);
        await waitForMemberLockWait(prismaA, blockerPid, approve);
        releaseOffboard.resolve(undefined);

        await expect(offboard).resolves.toMatchObject({
          member: expect.objectContaining({ id: target.id, status: MemberStatus.INACTIVE }),
        });
        await expect(approve).rejects.toMatchObject({ biz: BizCode.MEMBER_INACTIVE });
      } finally {
        releaseOffboard.resolve(undefined);
        await Promise.allSettled([offboard, ...(approve ? [approve] : [])]);
        barrier.mockRestore();
      }

      expect(
        await prismaA.member.findUniqueOrThrow({
          where: { id: target.id },
          select: { status: true },
        }),
      ).toEqual({ status: MemberStatus.INACTIVE });
      expect(
        await prismaA.activityRegistration.findUniqueOrThrow({
          where: { id: registration.id },
          select: {
            statusCode: true,
            reviewedBy: true,
            reviewedAt: true,
            reviewNote: true,
          },
        }),
      ).toEqual({
        statusCode: 'pending',
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null,
      });
      expect(
        await prismaA.activityRegistration.count({
          where: { activityId, statusCode: 'pass', deletedAt: null },
        }),
      ).toBe(0);
      expect(
        await prismaA.auditLog.count({
          where: { resourceId: registration.id, event: 'registration.review' },
        }),
      ).toBe(0);
      expect(
        await prismaA.auditLog.count({
          where: { resourceId: target.id, event: 'member.offboard' },
        }),
      ).toBe(1);
      expect(
        await prismaA.notification.count({
          where: { recipientMemberId: target.id, notificationTypeCode: 'registration-result' },
        }),
      ).toBe(0);
      expect(
        await prismaA.insuranceEligibilityEvidence.count({
          where: { activityRegistrationId: registration.id },
        }),
      ).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );
});
