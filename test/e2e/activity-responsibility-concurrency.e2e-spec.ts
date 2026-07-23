import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityResponsibilityService } from '../../src/modules/activities/activity-responsibility.service';
import { MembersService } from '../../src/modules/members/members.service';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const META = { requestId: 'responsibility-concurrency', ip: null, ua: null };

async function waitForMemberLockWaiters(prisma: PrismaService, expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ waitingCount: number }>>`
      SELECT count(*)::int AS "waitingCount"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query LIKE '%FROM "Member"%FOR UPDATE%'
    `;
    if ((row?.waitingCount ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected at least ${expected} Member row-lock waiter(s)`);
}

describe('activity responsibility transfer × member offboard concurrency', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let responsibilities: ActivityResponsibilityService;
  let members: MembersService;
  let actor: CurrentUserPayload;
  let organizationId: string;
  const previousGate = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    responsibilities = appA.get(ActivityResponsibilityService);
    members = appB.get(MembersService);
    await seedActivityResponsibilitySystemRoles(appA);
    const admin = await createTestUser(appA, {
      username: 'responsibility-race-admin',
      role: Role.SUPER_ADMIN,
    });
    actor = {
      id: admin.id,
      username: admin.username,
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
    const root = await prismaA.organization.create({
      data: { name: '责任并发根组织', nodeTypeCode: 'responsibility-race-root' },
      select: { id: true },
    });
    const organization = await prismaA.organization.create({
      data: {
        name: '责任并发执行组织',
        nodeTypeCode: 'responsibility-race-team',
        parentId: root.id,
      },
      select: { id: true },
    });
    organizationId = organization.id;
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close()]);
    if (previousGate === undefined) {
      delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousGate;
    }
  });

  async function createFormalTarget(label: string): Promise<{
    memberId: string;
    userId: string;
  }> {
    const member = await prismaA.member.create({
      data: {
        memberNo: `responsibility-race-${label}`,
        displayName: `责任并发 ${label}`,
        gradeCode: 'level-2',
      },
      select: { id: true },
    });
    const user = await createTestUser(appA, {
      username: `resp-race-${label}`,
      role: Role.USER,
    });
    await prismaA.user.update({
      where: { id: user.id },
      data: { memberId: member.id },
    });
    await prismaA.memberOrganizationMembership.create({
      data: { memberId: member.id, organizationId },
    });
    return { memberId: member.id, userId: user.id };
  }

  it('offboard queued first wins; transfer cannot restore responsibility or RoleBinding', async () => {
    const owner = await createFormalTarget('owner');
    const target = await createFormalTarget('target');
    const activity = await prismaA.activity.create({
      data: {
        title: '责任移交与离队并发',
        activityTypeCode: 'responsibility-race',
        organizationId,
        startAt: new Date('2099-12-01T01:00:00.000Z'),
        endAt: new Date('2099-12-01T05:00:00.000Z'),
        location: '深圳',
        statusCode: 'published',
      },
      select: { id: true },
    });
    await responsibilities.claimLegacy(
      activity.id,
      { ownerMemberId: owner.memberId, reason: '建立并发基线' },
      actor,
      META,
    );

    let signalReady!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = prismaA.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM "Member" WHERE id = ${target.memberId} FOR UPDATE
      `;
      signalReady();
      await released;
    });
    await ready;
    const offboard = members.offboard(target.memberId, actor, META);
    await waitForMemberLockWaiters(prismaA, 1);
    const transfer = responsibilities.transferOwner(
      activity.id,
      {
        newOwnerMemberId: target.memberId,
        reason: '并发移交',
        retainPreviousOwnerAsCollaborator: false,
      },
      actor,
      META,
    );
    let barrierError: unknown;
    try {
      await waitForMemberLockWaiters(prismaA, 2);
    } catch (error) {
      barrierError = error;
    } finally {
      release();
      await blocker;
    }
    const [offboardResult, transferResult] = await Promise.allSettled([offboard, transfer]);
    if (barrierError instanceof Error) throw barrierError;
    if (barrierError !== undefined) {
      throw new Error('non-Error value thrown while forcing responsibility interleaving');
    }
    expect(offboardResult.status).toBe('fulfilled');
    expect(transferResult.status).toBe('rejected');
    const reason = transferResult.status === 'rejected' ? transferResult.reason : undefined;
    expect(reason).toBeInstanceOf(BizException);
    expect((reason as BizException).biz).toBe(BizCode.ACTIVITY_RESPONSIBILITY_TARGET_INVALID);
    await expect(
      prismaA.activityResponsibilityAssignment.findMany({
        where: { activityId: activity.id, status: 'active' },
        select: { memberId: true, responsibilityType: true },
      }),
    ).resolves.toEqual([{ memberId: owner.memberId, responsibilityType: 'owner' }]);
    await expect(
      prismaA.roleBinding.count({
        where: {
          principalId: target.memberId,
          scopeActivityId: activity.id,
          status: 'ACTIVE',
          deletedAt: null,
        },
      }),
    ).resolves.toBe(0);
  });
});
