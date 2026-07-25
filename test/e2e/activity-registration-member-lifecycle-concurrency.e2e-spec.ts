import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityRegistrationsService } from '../../src/modules/activity-registrations/activity-registrations.service';
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

async function waitForMemberLockWaiters(observer: PrismaService, expected: number): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const [row] = await observer.$queryRaw<Array<{ waitingCount: number }>>(
      Prisma.sql`
        SELECT count(*)::int AS "waitingCount"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query LIKE '%FROM "Member"%FOR UPDATE%'
      `,
    );
    if ((row?.waitingCount ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected at least ${expected} Member lifecycle lock waiter(s)`);
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
    'approve 与 offboard 争用 Member lifecycle lock，审批先提交后退队必须以 15038 拒绝',
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
      let signalReady!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        signalReady = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = prismaA.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Member" WHERE id = ${target.id} FOR UPDATE`;
        signalReady();
        await released;
      });
      await ready;
      const approve = appB
        .get(ActivityRegistrationsService)
        .approve(activityId, registration.id, { reviewNote: '先完成审批' }, actor, META);
      await waitForMemberLockWaiters(prismaA, 1);
      const offboard = appA.get(MembersService).offboard(target.id, actor, META);
      let barrierError: unknown;
      try {
        await waitForMemberLockWaiters(prismaA, 2);
      } catch (error) {
        barrierError = error;
      } finally {
        release();
        await blocker;
      }
      const [approveResult, offboardResult] = await Promise.allSettled([approve, offboard]);
      if (barrierError instanceof Error) throw barrierError;
      if (barrierError !== undefined) {
        throw new Error('non-Error value thrown while forcing registration/offboard interleaving');
      }
      expect(approveResult.status).toBe('fulfilled');
      expect(offboardResult.status).toBe('rejected');
      const offboardReason =
        offboardResult.status === 'rejected' ? offboardResult.reason : undefined;
      expect(offboardReason).toBeInstanceOf(BizException);
      expect((offboardReason as BizException).biz).toBe(
        BizCode.MEMBER_OFFBOARD_REGISTRATION_CLEANUP_REQUIRED,
      );

      expect(
        await prismaA.member.findUniqueOrThrow({
          where: { id: target.id },
          select: { status: true },
        }),
      ).toEqual({ status: MemberStatus.ACTIVE });
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
        statusCode: 'pass',
        reviewedBy: actor.id,
        reviewedAt: expect.any(Date),
        reviewNote: '先完成审批',
      });
      expect(
        await prismaA.activityRegistration.count({
          where: { activityId, statusCode: 'pass', deletedAt: null },
        }),
      ).toBe(1);
      expect(
        await prismaA.auditLog.count({
          where: { resourceId: registration.id, event: 'registration.review' },
        }),
      ).toBe(1);
      expect(
        await prismaA.auditLog.count({
          where: { resourceId: target.id, event: 'member.offboard' },
        }),
      ).toBe(0);
      expect(
        await prismaA.notification.count({
          where: { recipientMemberId: target.id, notificationTypeCode: 'registration-result' },
        }),
      ).toBe(1);
      expect(
        await prismaA.insuranceEligibilityEvidence.count({
          where: { activityRegistrationId: registration.id },
        }),
      ).toBe(0);
    },
    CASE_TIMEOUT_MS,
  );
});
