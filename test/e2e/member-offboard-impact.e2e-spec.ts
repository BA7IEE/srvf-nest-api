import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role, UserStatus } from '@prisma/client';
import request from 'supertest';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityResponsibilityService } from '../../src/modules/activities/activity-responsibility.service';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

const META = { requestId: 'member-offboard-impact', ip: null, ua: null };

describe('member offboard activity responsibility and participation impact', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let responsibilities: ActivityResponsibilityService;
  let superAdminAuth: string;
  let actor: CurrentUserPayload;
  let organizationId: string;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    responsibilities = app.get(ActivityResponsibilityService);
    await seedActivityResponsibilitySystemRoles(app);
    const admin = await createTestUser(app, {
      username: 'offboard-impact-admin',
      role: Role.SUPER_ADMIN,
    });
    superAdminAuth = (await loginAs(app, admin.username)).authHeader;
    actor = {
      id: admin.id,
      username: admin.username,
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
    const root = await prisma.organization.create({
      data: { name: '离队影响根组织', nodeTypeCode: 'offboard-impact-root' },
      select: { id: true },
    });
    const organization = await prisma.organization.create({
      data: {
        name: '离队影响执行组织',
        nodeTypeCode: 'offboard-impact-team',
        parentId: root.id,
      },
      select: { id: true },
    });
    organizationId = organization.id;
  });

  afterAll(async () => {
    await app.close();
    if (previousGate === undefined) {
      delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousGate;
    }
  });

  async function createFormalMember(label: string): Promise<{
    memberId: string;
    userId: string;
    auth: string;
    memberNo: string;
  }> {
    sequence += 1;
    const shortLabel = label.replace(/[^a-z0-9]/gi, '').slice(0, 10);
    const memberNo = `obi-${shortLabel}-${sequence}`;
    const member = await prisma.member.create({
      data: {
        memberNo,
        ...memberIdentityData(`离队影响 ${label} ${sequence}`),
        gradeCode: 'level-2',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    const username = `obi-${shortLabel}-${sequence}`;
    const user = await createTestUser(app, { username, role: Role.USER });
    await prisma.user.update({
      where: { id: user.id },
      data: { memberId: member.id },
    });
    await prisma.memberOrganizationMembership.create({
      data: { memberId: member.id, organizationId },
    });
    return {
      memberId: member.id,
      userId: user.id,
      auth: (await loginAs(app, username)).authHeader,
      memberNo,
    };
  }

  async function createActivity(args: {
    label: string;
    statusCode?: 'draft' | 'published' | 'cancelled' | 'completed';
    initiatorMemberId?: string;
    closed?: boolean;
  }): Promise<{ id: string; title: string }> {
    sequence += 1;
    const now = Date.now();
    return prisma.activity.create({
      data: {
        title: `离队影响活动 ${args.label} ${sequence}`,
        activityTypeCode: 'member-offboard-impact',
        organizationId,
        startAt: new Date(now + 24 * 60 * 60 * 1000),
        endAt: new Date(now + 48 * 60 * 60 * 1000),
        location: '深圳',
        statusCode: args.statusCode ?? 'published',
        initiatorMemberId: args.initiatorMemberId,
        ...(args.closed
          ? {
              statusCode: 'completed',
              startAt: new Date(now - 48 * 60 * 60 * 1000),
              endAt: new Date(now - 24 * 60 * 60 * 1000),
              attendanceDeclaredCompleteAt: new Date(now - 12 * 60 * 60 * 1000),
            }
          : {}),
      },
      select: { id: true, title: true },
    });
  }

  function impact(memberId: string): request.Test {
    return request(httpServer(app))
      .get(`/api/admin/v1/members/${memberId}/offboard-impact`)
      .set('Authorization', superAdminAuth);
  }

  function offboard(memberId: string): request.Test {
    return request(httpServer(app))
      .post(`/api/admin/v1/members/${memberId}/offboard`)
      .set('Authorization', superAdminAuth);
  }

  it('draft initiator blocks with zero writes; transfer removes the locked blocker and response is safe', async () => {
    const oldInitiator = await createFormalMember('draft-old');
    const newInitiator = await createFormalMember('draft-new');
    const activity = await createActivity({
      label: 'draft-transfer',
      statusCode: 'draft',
      initiatorMemberId: oldInitiator.memberId,
    });

    const preview = await impact(oldInitiator.memberId);
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({
      canOffboard: false,
      blockingReasons: ['draft-initiator-handoff-required'],
      draftInitiatedActivities: [
        {
          activityId: activity.id,
          title: activity.title,
          statusCode: 'draft',
          closure: { status: 'draft' },
          responsibilityType: 'initiator',
        },
      ],
    });
    const serialized = JSON.stringify(preview.body.data);
    expect(serialized).not.toContain(oldInitiator.memberNo);
    expect(serialized).not.toContain(oldInitiator.userId);
    expect(serialized).not.toContain('phone');
    expect(serialized).not.toContain('passwordHash');

    const auditBefore = await prisma.auditLog.count({
      where: {
        event: 'member.offboard',
        resourceType: 'member',
        resourceId: oldInitiator.memberId,
      },
    });
    expectBizError(
      await offboard(oldInitiator.memberId),
      BizCode.MEMBER_OFFBOARD_ACTIVITY_HANDOFF_REQUIRED,
    );
    await expect(
      prisma.member.findUniqueOrThrow({
        where: { id: oldInitiator.memberId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: MemberStatus.ACTIVE });
    await expect(
      prisma.activity.findUniqueOrThrow({
        where: { id: activity.id },
        select: { initiatorMemberId: true },
      }),
    ).resolves.toEqual({ initiatorMemberId: oldInitiator.memberId });
    await expect(
      prisma.auditLog.count({
        where: {
          event: 'member.offboard',
          resourceType: 'member',
          resourceId: oldInitiator.memberId,
        },
      }),
    ).resolves.toBe(auditBefore);

    const transfer = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activity.id}/transfer-initiator`)
      .set('Authorization', oldInitiator.auth)
      .send({
        newInitiatorMemberId: newInitiator.memberId,
        reason: '离队前移交草稿发起责任',
      });
    expect(transfer.status).toBe(200);
    expect(transfer.body.data.initiator.id).toBe(newInitiator.memberId);
    const transferAudit = await prisma.auditLog.findFirstOrThrow({
      where: {
        event: 'activity.publish',
        resourceType: 'activity',
        resourceId: activity.id,
      },
      orderBy: { createdAt: 'desc' },
      select: { context: true },
    });
    expect(transferAudit.context).toMatchObject({
      extra: {
        operation: 'responsibility-transfer-initiator',
        targetMemberId: newInitiator.memberId,
        source: 'transfer',
        reason: '离队前移交草稿发起责任',
      },
    });
    expect((await impact(oldInitiator.memberId)).body.data.canOffboard).toBe(true);
    expect((await offboard(oldInitiator.memberId)).status).toBe(200);
  });

  it('draft initiator transfer refuses a pending publish review without changing initiator', async () => {
    const oldInitiator = await createFormalMember('review-old');
    const newInitiator = await createFormalMember('review-new');
    const activity = await createActivity({
      label: 'pending-review',
      statusCode: 'draft',
      initiatorMemberId: oldInitiator.memberId,
    });
    await prisma.activityPublishReview.create({
      data: {
        activityId: activity.id,
        requestType: 'initial',
        requestVersion: 1,
        baseRevision: 0,
        status: 'pending',
        snapshot: {},
        submittedByUserId: oldInitiator.userId,
      },
    });

    expectBizError(
      await request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${activity.id}/transfer-initiator`)
        .set('Authorization', oldInitiator.auth)
        .send({
          newInitiatorMemberId: newInitiator.memberId,
          reason: '审核期间不得移交',
        }),
      BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING,
    );
    await expect(
      prisma.activity.findUniqueOrThrow({
        where: { id: activity.id },
        select: { initiatorMemberId: true },
      }),
    ).resolves.toEqual({ initiatorMemberId: oldInitiator.memberId });
  });

  it('active owner blocks until the existing owner-transfer action completes', async () => {
    const owner = await createFormalMember('owner-old');
    const nextOwner = await createFormalMember('owner-new');
    const activity = await createActivity({ label: 'owner-transfer' });
    await responsibilities.claimLegacy(
      activity.id,
      { ownerMemberId: owner.memberId, reason: '建立负责人基线' },
      actor,
      META,
    );

    const preview = await impact(owner.memberId);
    expect(preview.body.data.activeOwnerActivities).toHaveLength(1);
    expect(preview.body.data.canOffboard).toBe(false);
    expectBizError(
      await offboard(owner.memberId),
      BizCode.MEMBER_OFFBOARD_ACTIVITY_HANDOFF_REQUIRED,
    );

    const transfer = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activity.id}/responsibilities/transfer`)
      .set('Authorization', superAdminAuth)
      .send({
        newOwnerMemberId: nextOwner.memberId,
        reason: '离队前移交负责人',
        retainPreviousOwnerAsCollaborator: false,
      });
    expect(transfer.status).toBe(200);
    expect(transfer.body.data.owner.memberId).toBe(nextOwner.memberId);
    expect((await impact(owner.memberId)).body.data.canOffboard).toBe(true);
    expect((await offboard(owner.memberId)).status).toBe(200);
  });

  it('collaborator is informational only and offboard revokes it atomically', async () => {
    const owner = await createFormalMember('collab-owner');
    const collaborator = await createFormalMember('collaborator');
    const activity = await createActivity({ label: 'collaborator-nonblocking' });
    await responsibilities.claimLegacy(
      activity.id,
      { ownerMemberId: owner.memberId, reason: '建立负责人基线' },
      actor,
      META,
    );
    const assignment = await responsibilities.addCollaborator(
      activity.id,
      {
        memberId: collaborator.memberId,
        canManageRegistrations: true,
        canManageAttendance: true,
        reason: '协办离队测试',
      },
      actor,
      META,
    );

    const preview = await impact(collaborator.memberId);
    expect(preview.body.data.activeCollaboratorActivities).toHaveLength(1);
    expect(preview.body.data.canOffboard).toBe(true);
    expect((await offboard(collaborator.memberId)).status).toBe(200);
    await expect(
      prisma.activityResponsibilityAssignment.findUniqueOrThrow({
        where: { id: assignment.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: 'revoked' });
  });

  it('future pending, waitlisted and pass without evidence block; existing cancel actions clear them', async () => {
    const member = await createFormalMember('future-registration');
    const registrations: Array<{ activityId: string; registrationId: string }> = [];
    for (const statusCode of ['pending', 'waitlisted', 'pass'] as const) {
      const activity = await createActivity({ label: `future-${statusCode}` });
      const registration = await prisma.activityRegistration.create({
        data: {
          activityId: activity.id,
          memberId: member.memberId,
          statusCode,
        },
        select: { id: true },
      });
      registrations.push({ activityId: activity.id, registrationId: registration.id });
    }

    const preview = await impact(member.memberId);
    expect(preview.body.data.futureRegistrations).toHaveLength(3);
    expect(
      preview.body.data.futureRegistrations
        .map((item: { registrationStatus: string }) => item.registrationStatus)
        .sort(),
    ).toEqual(['pass', 'pending', 'waitlisted']);
    expectBizError(
      await offboard(member.memberId),
      BizCode.MEMBER_OFFBOARD_REGISTRATION_CLEANUP_REQUIRED,
    );

    for (const registration of registrations) {
      const cancelled = await request(httpServer(app))
        .patch(
          `/api/admin/v1/activities/${registration.activityId}/registrations/${registration.registrationId}/cancel`,
        )
        .set('Authorization', superAdminAuth)
        .send({ cancelReason: '离队前清理未来报名' });
      expect(cancelled.status).toBe(200);
    }
    expect((await impact(member.memberId)).body.data.canOffboard).toBe(true);
    expect((await offboard(member.memberId)).status).toBe(200);
  });

  it('pass with real evidence, closed owner and cancelled owner are historical non-blockers', async () => {
    const member = await createFormalMember('historical');
    const evidenceActivity = await createActivity({ label: 'evidence' });
    const registration = await prisma.activityRegistration.create({
      data: {
        activityId: evidenceActivity.id,
        memberId: member.memberId,
        statusCode: 'pass',
      },
      select: { id: true },
    });
    await prisma.activityCheckIn.create({
      data: {
        activityId: evidenceActivity.id,
        memberId: member.memberId,
        registrationId: registration.id,
        checkInAt: new Date(),
        geoVerified: true,
      },
    });
    const closedActivity = await createActivity({ label: 'closed-owner' });
    const cancelledActivity = await createActivity({ label: 'cancelled-owner' });
    await responsibilities.claimLegacy(
      closedActivity.id,
      { ownerMemberId: member.memberId, reason: '闭环历史负责人' },
      actor,
      META,
    );
    await responsibilities.claimLegacy(
      cancelledActivity.id,
      { ownerMemberId: member.memberId, reason: '取消历史负责人' },
      actor,
      META,
    );
    const now = Date.now();
    await prisma.activity.update({
      where: { id: closedActivity.id },
      data: {
        statusCode: 'completed',
        startAt: new Date(now - 48 * 60 * 60 * 1000),
        endAt: new Date(now - 24 * 60 * 60 * 1000),
        attendanceDeclaredCompleteAt: new Date(now - 12 * 60 * 60 * 1000),
      },
    });
    await prisma.activity.update({
      where: { id: cancelledActivity.id },
      data: { statusCode: 'cancelled' },
    });

    const preview = await impact(member.memberId);
    expect(preview.body.data.historicalRegistrationsWithEvidence).toEqual([
      expect.objectContaining({
        registrationId: registration.id,
        hasParticipationEvidence: true,
      }),
    ]);
    expect(preview.body.data.activeOwnerActivities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activityId: closedActivity.id,
          closure: { status: 'closed' },
        }),
        expect.objectContaining({
          activityId: cancelledActivity.id,
          statusCode: 'cancelled',
        }),
      ]),
    );
    expect(preview.body.data.futureRegistrations).toEqual([]);
    expect(preview.body.data.canOffboard).toBe(true);
    expect((await offboard(member.memberId)).status).toBe(200);
  });
});
