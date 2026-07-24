import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, BindingStatus, MemberStatus, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

type LocalActor = {
  memberId: string;
  userId: string;
  auth: string;
};

const PUBLISH_REVIEWER_PERMISSIONS = [
  'activity-review.read.request',
  'activity.publish.record',
  'activity-review.return.request',
] as const;
const FIRST_REVIEWER_PERMISSIONS = [
  'attendance.read.sheet',
  'attendance.approve.sheet',
  'attendance.reject.sheet',
  'attendance.return.sheet',
] as const;
const FINAL_REVIEWER_PERMISSIONS = [
  'attendance.read.sheet',
  'attendance.final-approve.sheet',
  'attendance.final-reject.sheet',
  'attendance.reopen.sheet',
  'attendance.final-return.sheet',
] as const;

describe('activity responsibility workflow local acceptance', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let organizationAId: string;
  let organizationBId: string;
  let activityTypeCode: string;
  let attendanceRoleCode: string;
  let bizAdminRoleId: string;
  let publishReviewerRoleId: string;
  let firstReviewerRoleId: string;
  let finalReviewerRoleId: string;
  let crossOrgInitiatorRoleId: string;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await seedActivityResponsibilitySystemRoles(app);
    bizAdminRoleId = (await seedBizAdminPermissionsAndRole(app)).bizAdminRoleId;
    await prisma.permission.createMany({
      data: [
        {
          code: 'activity-review.read.request',
          module: 'activity-review',
          action: 'read',
          resourceType: 'request',
        },
        {
          code: 'activity-review.return.request',
          module: 'activity-review',
          action: 'return',
          resourceType: 'request',
        },
        {
          code: 'activity.create.cross-org',
          module: 'activity',
          action: 'create-cross-org',
          resourceType: 'organization',
        },
      ],
      skipDuplicates: true,
    });

    const root = await prisma.organization.create({
      data: {
        name: 'Local Activity Root',
        nodeTypeCode: 'local-activity-root',
      },
      select: { id: true },
    });
    organizationAId = (
      await prisma.organization.create({
        data: {
          name: 'Local Organization A',
          nodeTypeCode: 'local-activity-team',
          parentId: root.id,
        },
        select: { id: true },
      })
    ).id;
    organizationBId = (
      await prisma.organization.create({
        data: {
          name: 'Local Organization B',
          nodeTypeCode: 'local-activity-team',
          parentId: root.id,
        },
        select: { id: true },
      })
    ).id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: root.id, descendantId: root.id, depth: 0 },
        { ancestorId: root.id, descendantId: organizationAId, depth: 1 },
        { ancestorId: root.id, descendantId: organizationBId, depth: 1 },
        { ancestorId: organizationAId, descendantId: organizationAId, depth: 0 },
        { ancestorId: organizationBId, descendantId: organizationBId, depth: 0 },
      ],
    });

    const activityType = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    activityTypeCode = 'local-activity-acceptance';
    await prisma.dictItem.create({
      data: {
        typeId: activityType.id,
        code: activityTypeCode,
        label: 'Local Activity Acceptance',
      },
    });
    const attendanceRole = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    attendanceRoleCode = 'local-participant';
    await prisma.dictItem.create({
      data: {
        typeId: attendanceRole.id,
        code: attendanceRoleCode,
        label: 'Local Participant',
      },
    });
    const attendanceStatus = await prisma.dictType.create({
      data: { code: 'attendance_status', label: '考勤状态' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: {
        typeId: attendanceStatus.id,
        code: 'present',
        label: '出席',
      },
    });

    publishReviewerRoleId = await ensureRole(
      'activity-publish-reviewer',
      'Local Publish Reviewer',
      PUBLISH_REVIEWER_PERMISSIONS,
    );
    firstReviewerRoleId = await ensureRole(
      'attendance-first-reviewer',
      'Local First Reviewer',
      FIRST_REVIEWER_PERMISSIONS,
    );
    finalReviewerRoleId = await ensureRole(
      'attendance-final-reviewer',
      'Local Final Reviewer',
      FINAL_REVIEWER_PERMISSIONS,
    );
    crossOrgInitiatorRoleId = await ensureRole(
      'activity-cross-org-initiator',
      'Local Cross Organization Initiator',
      ['activity.create.cross-org'],
    );
  });

  afterAll(async () => {
    await app.close();
    if (previousGate === undefined) {
      delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousGate;
    }
  });

  async function ensureRole(
    code: string,
    displayName: string,
    permissionCodes: readonly string[],
  ): Promise<string> {
    const permissions = await prisma.permission.findMany({
      where: { code: { in: [...permissionCodes] } },
      select: { id: true, code: true },
    });
    expect(permissions.map((permission) => permission.code).sort()).toEqual(
      [...permissionCodes].sort(),
    );
    const role = await prisma.rbacRole.upsert({
      where: { code },
      update: { deletedAt: null },
      create: { code, displayName },
      select: { id: true },
    });
    await prisma.rolePermission.createMany({
      data: permissions.map((permission) => ({
        roleId: role.id,
        permissionId: permission.id,
      })),
      skipDuplicates: true,
    });
    return role.id;
  }

  async function createActor(
    displayName: string,
    organizationId = organizationAId,
    role: Role = Role.USER,
  ): Promise<LocalActor> {
    sequence += 1;
    const member = await prisma.member.create({
      data: {
        memberNo: `LOCAL-ACTIVITY-${sequence}`,
        displayName,
        gradeCode: 'level-3',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    const user = await createTestUser(app, {
      username: `local-activity-${sequence}`,
      role,
    });
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
      auth: (await loginAs(app, user.username)).authHeader,
    };
  }

  async function bindUserRole(
    actor: LocalActor,
    roleId: string,
    organizationId: string,
  ): Promise<void> {
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: actor.userId,
        roleId,
        scopeType: BindingScopeType.ORGANIZATION,
        scopeOrgId: organizationId,
        status: BindingStatus.ACTIVE,
      },
    });
  }

  async function bindCrossOrgRole(actor: LocalActor, organizationId: string): Promise<void> {
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.MEMBER,
        principalId: actor.memberId,
        roleId: crossOrgInitiatorRoleId,
        scopeType: BindingScopeType.ORGANIZATION,
        scopeOrgId: organizationId,
        status: BindingStatus.ACTIVE,
      },
    });
  }

  function activityPayload(title: string, organizationId: string) {
    return {
      title,
      activityTypeCode,
      organizationId,
      startAt: '2099-08-01T01:00:00.000Z',
      endAt: '2099-08-01T05:00:00.000Z',
      registrationDeadline: '2099-07-31T12:00:00.000Z',
      location: 'Local Activity Location',
      capacity: 20,
      isPublicRegistration: true,
    };
  }

  async function createManagedDraft(
    actor: LocalActor,
    title: string,
    organizationId = organizationAId,
  ): Promise<string> {
    const response = await request(httpServer(app))
      .post('/api/app/v1/my/managed-activities')
      .set('Authorization', actor.auth)
      .send(activityPayload(title, organizationId));
    if (response.status !== 201) throw new Error(JSON.stringify(response.body));
    return response.body.data.activity.id as string;
  }

  async function addPosition(actor: LocalActor, activityId: string): Promise<string> {
    const created = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/positions`)
      .set('Authorization', actor.auth)
      .send({
        name: 'Local Activity Position',
        attendanceRoleCode,
        capacity: 20,
      })
      .expect(201);
    return created.body.data.activityPositionId as string;
  }

  async function selfRegister(
    actor: LocalActor,
    activityId: string,
    activityPositionId: string,
  ): Promise<string> {
    const response = await request(httpServer(app))
      .post('/api/app/v1/my/registrations')
      .set('Authorization', actor.auth)
      .send({ activityId, activityPositionId })
      .expect(201);
    expect(response.body.data.statusCode).toBe('pending');
    return response.body.data.id as string;
  }

  async function addCollaborator(
    owner: LocalActor,
    activityId: string,
    collaborator: LocalActor,
    capabilities: {
      canManageRegistrations: boolean;
      canManageAttendance: boolean;
    },
  ): Promise<void> {
    await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/collaborators`)
      .set('Authorization', owner.auth)
      .send({
        memberId: collaborator.memberId,
        ...capabilities,
        reason: 'Local acceptance delegation',
      })
      .expect(201);
  }

  it('runs ordinary App submission through an independent publish reviewer and projects one owner', async () => {
    const owner = await createActor('Local Activity Owner');
    const reviewer = await createActor('Local Publish Reviewer');
    await bindUserRole(reviewer, publishReviewerRoleId, organizationAId);

    const activityId = await createManagedDraft(owner, 'Local Ordinary Publish Review Activity');
    const updated = await request(httpServer(app))
      .patch(`/api/app/v1/my/managed-activities/${activityId}`)
      .set('Authorization', owner.auth)
      .send({
        title: 'Local Ordinary Publish Review Activity Updated',
        description: 'Local-only acceptance fixture',
        organizationId: organizationAId,
      })
      .expect(200);
    expect(updated.body.data.activity.title).toBe('Local Ordinary Publish Review Activity Updated');

    const activityPositionId = await addPosition(owner, activityId);
    const updatedPosition = await request(httpServer(app))
      .patch(`/api/app/v1/my/managed-activities/${activityId}/positions/${activityPositionId}`)
      .set('Authorization', owner.auth)
      .send({ name: 'Local Activity Position Updated' })
      .expect(200);
    expect(updatedPosition.body.data.name).toBe('Local Activity Position Updated');

    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/submit-publish-review`)
      .set('Authorization', owner.auth)
      .send({})
      .expect(200);
    expect(submitted.body.data).toMatchObject({
      activityId,
      status: 'pending',
      directPublish: false,
      submittedByUserId: owner.userId,
    });
    const reviewId = submitted.body.data.id as string;

    await expect(
      prisma.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: { statusCode: true },
      }),
    ).resolves.toEqual({ statusCode: 'draft' });
    expectBizError(
      await request(httpServer(app))
        .get(`/api/app/v1/activities/${activityId}`)
        .set('Authorization', owner.auth),
      BizCode.ACTIVITY_NOT_FOUND,
    );

    const worklist = await request(httpServer(app))
      .get('/api/admin/v1/activity-publish-reviews?status=pending')
      .set('Authorization', reviewer.auth)
      .expect(200);
    expect(worklist.body.data.items).toContainEqual(
      expect.objectContaining({ id: reviewId, activityId, status: 'pending' }),
    );
    await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${reviewId}/approve`)
      .set('Authorization', reviewer.auth)
      .send({
        requiresInsuranceConfirmed: true,
        reviewNote: 'Local publish review approved',
      })
      .expect(200);

    const published = await request(httpServer(app))
      .get(`/api/app/v1/activities/${activityId}`)
      .set('Authorization', owner.auth)
      .expect(200);
    expect(published.body.data.statusCode).toBe('published');

    const owners = await prisma.activityResponsibilityAssignment.findMany({
      where: {
        activityId,
        responsibilityType: 'owner',
        status: 'active',
      },
      select: { id: true, memberId: true },
    });
    expect(owners).toEqual([{ id: expect.any(String), memberId: owner.memberId }]);
    await expect(
      prisma.roleBinding.count({
        where: {
          principalType: PrincipalType.MEMBER,
          principalId: owner.memberId,
          scopeType: BindingScopeType.ACTIVITY,
          scopeActivityId: activityId,
          role: { code: 'activity-owner' },
          status: BindingStatus.ACTIVE,
          deletedAt: null,
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.activityResponsibilityAssignment.count({
        where: { activityId, memberId: reviewer.memberId },
      }),
    ).resolves.toBe(0);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: {
        event: 'activity.publish',
        resourceId: activityId,
        actorUserId: reviewer.userId,
      },
      orderBy: { createdAt: 'desc' },
      select: { context: true },
    });
    expect(audit.context).toMatchObject({
      extra: { operation: 'publish-review-approve' },
    });
  });

  it('runs registration, delegated attendance, two returns, owner transfer, and closure through HTTP', async () => {
    const owner = await createActor('Local Direct Publish Owner');
    const registrationCollaborator = await createActor('Local Registration Collaborator');
    const attendanceCollaborator = await createActor('Local Attendance Collaborator');
    const participant = await createActor('Local Participant');
    const secondParticipant = await createActor('Local Participant Two');
    const unrelatedAdmin = await createActor(
      'Local Unrelated Administrator',
      organizationAId,
      Role.ADMIN,
    );
    const firstReviewerA = await createActor('Local First Reviewer A');
    const firstReviewerB = await createActor('Local First Reviewer B');
    const finalReviewerA = await createActor('Local Final Reviewer A');
    const finalReviewerB = await createActor('Local Final Reviewer B');
    const newOwner = await createActor('Local New Activity Owner');

    await bindUserRole(owner, publishReviewerRoleId, organizationAId);
    await bindUserRole(firstReviewerA, firstReviewerRoleId, organizationAId);
    await bindUserRole(firstReviewerB, firstReviewerRoleId, organizationAId);
    await bindUserRole(finalReviewerA, finalReviewerRoleId, organizationAId);
    await bindUserRole(finalReviewerB, finalReviewerRoleId, organizationAId);
    await grantBizAdminToUser(app, unrelatedAdmin.userId, bizAdminRoleId, {
      includeLegacyActivityActions: false,
    });
    await expect(
      prisma.roleBinding.count({
        where: {
          principalId: unrelatedAdmin.userId,
          role: { code: 'test-legacy-activity-actions' },
          status: BindingStatus.ACTIVE,
          deletedAt: null,
        },
      }),
    ).resolves.toBe(0);

    const activityId = await createManagedDraft(owner, 'Local Complete Workflow Activity');
    const activityPositionId = await addPosition(owner, activityId);
    await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/direct-publish`)
      .set('Authorization', owner.auth)
      .send({})
      .expect(200);

    const directReview = await prisma.activityPublishReview.findFirstOrThrow({
      where: { activityId },
      select: {
        directPublish: true,
        status: true,
        submittedByUserId: true,
        reviewedByUserId: true,
      },
    });
    expect(directReview).toEqual({
      directPublish: true,
      status: 'approved',
      submittedByUserId: owner.userId,
      reviewedByUserId: owner.userId,
    });
    const directAudit = await prisma.auditLog.findFirstOrThrow({
      where: {
        event: 'activity.publish',
        resourceId: activityId,
        actorUserId: owner.userId,
      },
      orderBy: { createdAt: 'desc' },
      select: { context: true },
    });
    expect(directAudit.context).toMatchObject({
      extra: { operation: 'publish-review-direct', directPublish: true },
    });

    await addCollaborator(owner, activityId, registrationCollaborator, {
      canManageRegistrations: true,
      canManageAttendance: false,
    });
    await addCollaborator(owner, activityId, attendanceCollaborator, {
      canManageRegistrations: false,
      canManageAttendance: true,
    });

    const registrationId = await selfRegister(participant, activityId, activityPositionId);
    const secondRegistrationId = await selfRegister(
      secondParticipant,
      activityId,
      activityPositionId,
    );
    expectBizError(
      await request(httpServer(app))
        .patch(
          `/api/app/v1/my/managed-activities/${activityId}/registrations/${registrationId}/approve`,
        )
        .set('Authorization', unrelatedAdmin.auth)
        .send({ reviewNote: 'must not pass' }),
      BizCode.RBAC_FORBIDDEN,
    );
    await request(httpServer(app))
      .patch(
        `/api/app/v1/my/managed-activities/${activityId}/registrations/${registrationId}/approve`,
      )
      .set('Authorization', owner.auth)
      .send({ reviewNote: 'Local owner approved registration' })
      .expect(200);
    await request(httpServer(app))
      .patch(
        `/api/app/v1/my/managed-activities/${activityId}/registrations/${secondRegistrationId}/approve`,
      )
      .set('Authorization', registrationCollaborator.auth)
      .send({ reviewNote: 'Local collaborator approved registration' })
      .expect(200);

    for (const auth of [registrationCollaborator.auth, unrelatedAdmin.auth]) {
      expectBizError(
        await request(httpServer(app))
          .get(`/api/app/v1/my/managed-activities/${activityId}/attendance-sheets`)
          .set('Authorization', auth),
        BizCode.RBAC_FORBIDDEN,
      );
    }

    // Local fixture-only clock advance: business statuses and reviews still move only through HTTP.
    const localStartAt = new Date('2026-07-20T01:00:00.000Z');
    const localEndAt = new Date('2026-07-20T05:00:00.000Z');
    await prisma.activity.update({
      where: { id: activityId },
      data: {
        startAt: localStartAt,
        endAt: localEndAt,
        registrationDeadline: new Date('2026-07-19T12:00:00.000Z'),
      },
    });
    for (const registration of [
      { id: registrationId, memberId: participant.memberId },
      { id: secondRegistrationId, memberId: secondParticipant.memberId },
    ]) {
      await prisma.activityCheckIn.create({
        data: {
          activityId,
          memberId: registration.memberId,
          registrationId: registration.id,
          checkInAt: new Date('2026-07-20T01:00:00.000Z'),
          checkOutAt: new Date('2026-07-20T03:00:00.000Z'),
          geoVerified: true,
          outOfRange: false,
          checkInDistance: 10,
          checkOutDistance: 12,
        },
      });
    }

    const draft = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${activityId}/attendance-sheet-draft`)
      .set('Authorization', attendanceCollaborator.auth)
      .expect(200);
    expect(draft.body.data.records).toHaveLength(2);
    const draftRecords = draft.body.data.records as Array<Record<string, unknown>>;
    const submittedSheet = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/attendance-sheets`)
      .set('Authorization', attendanceCollaborator.auth)
      .send({ records: draftRecords })
      .expect(201);
    const sheetId = submittedSheet.body.data.id as string;
    expect(submittedSheet.body.data).toMatchObject({
      statusCode: 'pending',
      submitterUserId: attendanceCollaborator.userId,
      lastSubmittedByUserId: attendanceCollaborator.userId,
    });

    for (const auth of [registrationCollaborator.auth, unrelatedAdmin.auth]) {
      expectBizError(
        await request(httpServer(app))
          .post(`/api/app/v1/my/managed-activities/${activityId}/attendance-sheets`)
          .set('Authorization', auth)
          .send({ records: draftRecords }),
        BizCode.RBAC_FORBIDDEN,
      );
    }
    expectBizError(
      await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${sheetId}/approve`)
        .set('Authorization', attendanceCollaborator.auth)
        .send({ reviewNote: 'submitter must not gain reviewer rights' }),
      BizCode.RBAC_FORBIDDEN,
    );

    const transferred = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/transfer-owner`)
      .set('Authorization', owner.auth)
      .send({
        newOwnerMemberId: newOwner.memberId,
        reason: 'Local acceptance owner transfer',
        retainPreviousOwnerAsCollaborator: true,
      })
      .expect(200);
    expect(transferred.body.data.initiator.id).toBe(owner.memberId);
    expect(transferred.body.data.owner.memberId).toBe(newOwner.memberId);
    expect(transferred.body.data.collaborators).toContainEqual(
      expect.objectContaining({
        memberId: owner.memberId,
        canManageRegistrations: true,
        canManageAttendance: true,
      }),
    );

    await expect(
      prisma.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: { initiatorMemberId: true },
      }),
    ).resolves.toEqual({ initiatorMemberId: owner.memberId });
    await expect(
      prisma.activityResponsibilityAssignment.count({
        where: {
          activityId,
          memberId: owner.memberId,
          responsibilityType: 'owner',
          status: 'ended',
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.activityResponsibilityAssignment.count({
        where: {
          activityId,
          memberId: owner.memberId,
          responsibilityType: 'collaborator',
          status: 'active',
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.roleBinding.count({
        where: {
          principalId: owner.memberId,
          scopeActivityId: activityId,
          status: BindingStatus.ENDED,
          role: { code: 'activity-owner' },
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.roleBinding.count({
        where: {
          principalId: owner.memberId,
          scopeActivityId: activityId,
          status: BindingStatus.ACTIVE,
          role: {
            code: {
              in: ['activity-registration-collaborator', 'activity-attendance-collaborator'],
            },
          },
        },
      }),
    ).resolves.toBe(2);
    await expect(
      prisma.roleBinding.count({
        where: {
          principalId: newOwner.memberId,
          scopeActivityId: activityId,
          status: BindingStatus.ACTIVE,
          role: { code: 'activity-owner' },
        },
      }),
    ).resolves.toBe(1);
    const transferAudit = await prisma.auditLog.findFirstOrThrow({
      where: {
        event: 'activity.publish',
        resourceId: activityId,
        actorUserId: owner.userId,
      },
      orderBy: { createdAt: 'desc' },
      select: { context: true },
    });
    expect(transferAudit.context).toMatchObject({
      extra: { operation: 'responsibility-transfer' },
    });

    await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activityId}/complete`)
      .set('Authorization', newOwner.auth)
      .send({})
      .expect(200);
    expectBizError(
      await request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${activityId}/declare-attendance-complete`)
        .set('Authorization', owner.auth)
        .send({}),
      BizCode.ACTIVITY_NOT_FOUND,
    );
    const declared = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/declare-attendance-complete`)
      .set('Authorization', newOwner.auth)
      .send({})
      .expect(200);
    expect(declared.body.data.closure).toEqual(
      expect.objectContaining({
        status: 'attendance-first-review',
        nextAction: '等待考勤一审',
      }),
    );

    const firstReturned = await request(httpServer(app))
      .post(`/api/admin/v1/attendance-sheets/${sheetId}/return`)
      .set('Authorization', firstReviewerA.auth)
      .send({ returnNote: 'Local first review return' })
      .expect(200);
    expect(firstReturned.body.data).toMatchObject({
      statusCode: 'returned',
      returnedFromStageCode: 'first',
      returnNote: 'Local first review return',
    });
    const firstReturnedDetail = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${activityId}/attendance-sheets/${sheetId}`)
      .set('Authorization', attendanceCollaborator.auth)
      .expect(200);
    expect(firstReturnedDetail.body.data.records).toHaveLength(2);

    const firstEditedRecords = draftRecords.map((record, index) =>
      index === 0 ? { ...record, serviceHours: 1.5 } : record,
    );
    const firstEdited = await request(httpServer(app))
      .patch(`/api/app/v1/my/managed-activities/${activityId}/attendance-sheets/${sheetId}`)
      .set('Authorization', attendanceCollaborator.auth)
      .send({ records: firstEditedRecords })
      .expect(200);
    expect(firstEdited.body.data.statusCode).toBe('returned');
    const firstResubmitted = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/attendance-sheets/${sheetId}/resubmit`)
      .set('Authorization', attendanceCollaborator.auth)
      .send({})
      .expect(200);
    expect(firstResubmitted.body.data).toMatchObject({
      statusCode: 'pending',
      reviewerUserId: null,
      finalReviewerUserId: null,
      returnedByUserId: null,
      returnNote: null,
      returnedFromStageCode: null,
      lastSubmittedByUserId: attendanceCollaborator.userId,
    });

    await request(httpServer(app))
      .patch(`/api/admin/v1/attendance-sheets/${sheetId}/approve`)
      .set('Authorization', firstReviewerB.auth)
      .send({ reviewNote: 'Local first review approved after resubmit' })
      .expect(200);
    const finalReturned = await request(httpServer(app))
      .post(`/api/admin/v1/attendance-sheets/${sheetId}/final-return`)
      .set('Authorization', finalReviewerA.auth)
      .send({ returnNote: 'Local final review return' })
      .expect(200);
    expect(finalReturned.body.data).toMatchObject({
      statusCode: 'returned',
      returnedFromStageCode: 'final',
      returnNote: 'Local final review return',
    });
    const finalReturnedDetail = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${activityId}/attendance-sheets/${sheetId}`)
      .set('Authorization', attendanceCollaborator.auth)
      .expect(200);
    expect(finalReturnedDetail.body.data.records).toHaveLength(2);

    const finalEditedRecords = draftRecords.map((record, index) =>
      index === 0 ? { ...record, serviceHours: 1.25 } : record,
    );
    await request(httpServer(app))
      .patch(`/api/app/v1/my/managed-activities/${activityId}/attendance-sheets/${sheetId}`)
      .set('Authorization', owner.auth)
      .send({ records: finalEditedRecords })
      .expect(200);
    const finalResubmitted = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/attendance-sheets/${sheetId}/resubmit`)
      .set('Authorization', owner.auth)
      .send({})
      .expect(200);
    expect(finalResubmitted.body.data).toMatchObject({
      statusCode: 'pending',
      reviewerUserId: null,
      finalReviewerUserId: null,
      returnedByUserId: null,
      returnNote: null,
      returnedFromStageCode: null,
      lastSubmittedByUserId: owner.userId,
    });

    const beforeFinalApproval = await request(httpServer(app))
      .get('/api/app/v1/my/participation-summary')
      .set('Authorization', participant.auth)
      .expect(200);
    expect(beforeFinalApproval.body.data).toMatchObject({
      totalServiceHours: '0',
      recordCount: 0,
      contributionPoints: '0',
    });

    await request(httpServer(app))
      .patch(`/api/admin/v1/attendance-sheets/${sheetId}/approve`)
      .set('Authorization', firstReviewerA.auth)
      .send({ reviewNote: 'Local second first review approved' })
      .expect(200);
    const approved = await request(httpServer(app))
      .patch(`/api/admin/v1/attendance-sheets/${sheetId}/final-approve`)
      .set('Authorization', finalReviewerB.auth)
      .send({ finalReviewNote: 'Local final review approved' })
      .expect(200);
    expect(approved.body.data).toMatchObject({
      statusCode: 'approved',
      reviewerUserId: firstReviewerA.userId,
      finalReviewerUserId: finalReviewerB.userId,
    });

    const afterFinalApproval = await request(httpServer(app))
      .get('/api/app/v1/my/participation-summary')
      .set('Authorization', participant.auth)
      .expect(200);
    expect(afterFinalApproval.body.data).toMatchObject({
      totalServiceHours: '1.25',
      recordCount: 1,
      contributionPoints: '0',
    });

    const closed = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${activityId}`)
      .set('Authorization', newOwner.auth)
      .expect(200);
    expect(closed.body.data.activity.statusCode).toBe('completed');
    expect(closed.body.data.closure).toEqual(
      expect.objectContaining({ status: 'closed', nextAction: null }),
    );
    expect(closed.body.data.counts).toEqual(
      expect.objectContaining({ unresolvedAttendanceSheets: 0 }),
    );
    await expect(
      prisma.attendanceSheet.count({
        where: {
          activityId,
          statusCode: { in: ['pending', 'pending_final_review', 'returned'] },
          deletedAt: null,
        },
      }),
    ).resolves.toBe(0);
  });

  it('does not let a cross-organization initiation grant spill into management rights', async () => {
    const crossOrgInitiator = await createActor('Local Cross Organization Initiator');
    const organizationBOwner = await createActor('Local Organization B Owner', organizationBId);
    await bindCrossOrgRole(crossOrgInitiator, organizationBId);
    await bindUserRole(organizationBOwner, publishReviewerRoleId, organizationBId);

    const crossOrgDraftId = await createManagedDraft(
      crossOrgInitiator,
      'Local Cross Organization Draft',
      organizationBId,
    );
    await expect(
      prisma.activity.findUniqueOrThrow({
        where: { id: crossOrgDraftId },
        select: { organizationId: true, initiatorMemberId: true, statusCode: true },
      }),
    ).resolves.toEqual({
      organizationId: organizationBId,
      initiatorMemberId: crossOrgInitiator.memberId,
      statusCode: 'draft',
    });

    const otherActivityId = await createManagedDraft(
      organizationBOwner,
      'Local Organization B Owned Activity',
      organizationBId,
    );
    await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${otherActivityId}/direct-publish`)
      .set('Authorization', organizationBOwner.auth)
      .send({})
      .expect(200);

    expectBizError(
      await request(httpServer(app))
        .get(`/api/app/v1/my/managed-activities/${otherActivityId}/registrations`)
        .set('Authorization', crossOrgInitiator.auth),
      BizCode.RBAC_FORBIDDEN,
    );
    expectBizError(
      await request(httpServer(app))
        .get(`/api/app/v1/my/managed-activities/${otherActivityId}/attendance-sheets`)
        .set('Authorization', crossOrgInitiator.auth),
      BizCode.RBAC_FORBIDDEN,
    );
    expectBizError(
      await request(httpServer(app))
        .post(`/api/admin/v1/activities/${otherActivityId}/complete`)
        .set('Authorization', crossOrgInitiator.auth)
        .send({}),
      BizCode.RBAC_FORBIDDEN,
    );

    const crossOrgRolePermissions = await prisma.rolePermission.findMany({
      where: { roleId: crossOrgInitiatorRoleId },
      select: { permission: { select: { code: true } } },
    });
    expect(crossOrgRolePermissions.map((item) => item.permission.code)).toEqual([
      'activity.create.cross-org',
    ]);
  });
});
