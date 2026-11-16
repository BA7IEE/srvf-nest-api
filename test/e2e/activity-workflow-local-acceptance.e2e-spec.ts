import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, BindingStatus, MemberStatus, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { ACTIVITY_RESPONSIBILITY_WORKFLOW_PERMISSION_SEED } from '../../src/modules/permissions/permission-catalog';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

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
  'activity.settlement-first-review.record',
] as const;
const FINAL_REVIEWER_PERMISSIONS = [
  'attendance.read.sheet',
  'activity.settlement-final-review.record',
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
  let sessionSequence = 0;
  const previousGate = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
  const previousV11 = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const roles = await seedActivityResponsibilitySystemRoles(app);
    await prisma.permission.createMany({
      data: ACTIVITY_RESPONSIBILITY_WORKFLOW_PERMISSION_SEED.filter((row) =>
        row.code.startsWith('activity.settlement-'),
      ).map((row) => ({ ...row })),
      skipDuplicates: true,
    });
    const nativePermissions = await prisma.permission.findMany({
      where: {
        code: {
          in: [
            'activity.settlement-generate.record',
            'activity.settlement-update-draft.record',
            'activity.settlement-submit.record',
            'activity.settlement-close.record',
          ],
        },
      },
    });
    // Match the production owner/collaborator grants without granting
    // native writes or review rights to the unrelated global biz-admin.
    for (const code of ['activity-owner', 'activity-attendance-collaborator']) {
      await prisma.rolePermission.createMany({
        data: nativePermissions
          .filter(
            (permission) =>
              code === 'activity-owner' || permission.code !== 'activity.settlement-close.record',
          )
          .map((permission) => ({ roleId: roles[code], permissionId: permission.id })),
        skipDuplicates: true,
      });
    }
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
    try {
      await app?.close();
    } finally {
      if (previousGate === undefined) {
        delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
      } else {
        process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousGate;
      }
      if (previousV11 === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousV11;
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
    realName: string,
    organizationId = organizationAId,
    role: Role = Role.USER,
  ): Promise<LocalActor> {
    sequence += 1;
    const member = await prisma.member.create({
      data: {
        memberNo: `LOCAL-ACTIVITY-${sequence}`,
        ...memberIdentityData(realName),
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
      allocationModeCode: 'first_come',
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
    const activityId = response.body.data.activity.id as string;
    await prisma.activity.update({
      where: { id: activityId },
      data: {
        metricRequirementCode: 'not_required',
        selectedMetricSetVersionId: null,
        selectedMetricSetDefinitionHash: null,
        metricSelectionRevision: 1,
      },
    });
    return activityId;
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

  async function addLiveSession(actor: LocalActor, activityId: string): Promise<string> {
    sessionSequence += 1;
    const created = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions`)
      .set('Authorization', actor.auth)
      .send({
        code: `local-session-${sessionSequence}`,
        name: `Local Session ${sessionSequence}`,
        startAt: '2099-08-01T01:00:00.000Z',
        endAt: '2099-08-01T05:00:00.000Z',
        locationText: 'Local Session Location',
        checkInOpenAt: '2099-08-01T00:30:00.000Z',
        checkInCloseAt: '2099-08-01T02:00:00.000Z',
        checkOutOpenAt: '2099-08-01T03:00:00.000Z',
        checkOutCloseAt: '2099-08-01T05:00:00.000Z',
        locationRequired: false,
      })
      .expect(201);
    return created.body.data.sessionId as string;
  }

  async function selfRegister(
    actor: LocalActor,
    activityId: string,
    sessionId: string,
    positionId: string,
  ): Promise<string> {
    expect(typeof sessionId).toBe('string');
    expect(typeof positionId).toBe('string');
    expect(
      await prisma.activitySession.findUnique({
        where: { id: sessionId },
        select: { activityId: true, statusCode: true, deletedAt: true },
      }),
    ).toEqual({ activityId, statusCode: 'scheduled', deletedAt: null });
    expect(
      await prisma.activitySessionPosition.findUnique({
        where: { id: positionId },
        select: { activityId: true, sessionId: true, deletedAt: true },
      }),
    ).toEqual({ activityId, sessionId, deletedAt: null });
    const response = await request(httpServer(app))
      .post(`/api/app/v1/activities/${activityId}/registrations`)
      .set('Authorization', actor.auth)
      .send({
        operationKey: `local-register-${actor.userId}`,
        formVersion: null,
        answers: [],
        preferences: [{ sessionId, positionIds: [positionId] }],
      })
      .expect((res) => {
        expect({ status: res.status, code: res.body.code, message: res.body.message }).toEqual({
          status: 201,
          code: 0,
          message: 'ok',
        });
      });
    const registrationId = response.body.data.registrationId as string;
    expect(
      (await prisma.activityRegistration.findUniqueOrThrow({ where: { id: registrationId } }))
        .statusCode,
    ).toBe('pending');
    return registrationId;
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
    await addLiveSession(owner, activityId);
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

  it('runs registration, delegated attendance, two returns, owner transfer and closure through HTTP plus the real ledger preparation/commit core', async () => {
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
    const publishReviewer = await createActor('Local Publish Reviewer');

    await bindUserRole(publishReviewer, publishReviewerRoleId, organizationAId);
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
    const sessionId = await addLiveSession(owner, activityId);
    await request(httpServer(app))
      .patch(`/api/app/v1/my/managed-activities/${activityId}`)
      .set('Authorization', owner.auth)
      .send({ allocationModeCode: 'qualification_rank' })
      .expect(200);
    const nativePosition = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}/positions`)
      .set('Authorization', owner.auth)
      .send({
        code: 'local-native-position',
        name: 'Local Native Position',
        attendanceRoleCode,
        capacity: 20,
      })
      .expect(201);
    const positionId = nativePosition.body.data.positionId as string;
    const directResponse = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/direct-publish`)
      .set('Authorization', owner.auth)
      .send({})
      .expect(200);
    expect(directResponse.body.data.activity.statusCode).toBe('draft');

    const directReview = await prisma.activityPublishReview.findFirstOrThrow({
      where: { activityId },
      select: {
        id: true,
        directPublish: true,
        status: true,
        submittedByUserId: true,
        reviewedByUserId: true,
      },
    });
    expect(directReview).toMatchObject({
      directPublish: false,
      status: 'pending',
      submittedByUserId: owner.userId,
      reviewedByUserId: null,
    });
    await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${directReview.id}/approve`)
      .set('Authorization', publishReviewer.auth)
      .send({ requiresInsuranceConfirmed: true, operationKey: 'local-complete-approve-0001' })
      .expect(200);
    const directAudit = await prisma.auditLog.findFirstOrThrow({
      where: {
        event: 'activity.publish',
        resourceId: activityId,
        actorUserId: publishReviewer.userId,
      },
      orderBy: { createdAt: 'desc' },
      select: { context: true },
    });
    expect(directAudit.context).toMatchObject({
      extra: { operation: 'publish-review-approve', directPublish: false },
    });

    await addCollaborator(owner, activityId, registrationCollaborator, {
      canManageRegistrations: true,
      canManageAttendance: false,
    });
    await addCollaborator(owner, activityId, attendanceCollaborator, {
      canManageRegistrations: false,
      canManageAttendance: true,
    });

    const registrationId = await selfRegister(participant, activityId, sessionId, positionId);
    const secondRegistrationId = await selfRegister(
      secondParticipant,
      activityId,
      sessionId,
      positionId,
    );
    // Ranking allocation replaces legacy per-header approve: the owner freezes
    // candidates and the registration collaborator commits the same batch.
    await prisma.activity.update({
      where: { id: activityId },
      data: { registrationDeadline: new Date('2020-07-19T12:00:00Z') },
    });
    const allocationBase = `/api/app/v1/my/managed-activities/${activityId}/allocation-batches`;
    const prepareCommand = { operationKey: 'local-native-allocate', sessionId, positionId };
    expectBizError(
      await request(httpServer(app))
        .post(allocationBase)
        .set('Authorization', unrelatedAdmin.auth)
        .send(prepareCommand),
      BizCode.RBAC_FORBIDDEN,
    );
    expect(await prisma.activityAllocationBatch.count({ where: { activityId } })).toBe(0);
    const prepared = await request(httpServer(app))
      .post(allocationBase)
      .set('Authorization', owner.auth)
      .send(prepareCommand)
      .expect(201);
    await request(httpServer(app))
      .post(`${allocationBase}/${prepared.body.data.batch.batchId}/commit`)
      .set('Authorization', registrationCollaborator.auth)
      .send({ operationKey: 'local-native-allocate-commit' })
      .expect(200);
    expect(
      await prisma.activityRegistration.count({
        where: { id: { in: [registrationId, secondRegistrationId] }, statusCode: 'pass' },
      }),
    ).toBe(2);
    const settlementBase = `/api/app/v1/my/managed-activities/${activityId}/settlement`;

    for (const auth of [registrationCollaborator.auth, unrelatedAdmin.auth]) {
      expectBizError(
        await request(httpServer(app)).get(settlementBase).set('Authorization', auth),
        BizCode.RBAC_FORBIDDEN,
      );
    }

    // Local fixture-only clock advance: business statuses and reviews still move only through HTTP.
    const localStartAt = new Date('2020-07-20T01:00:00.000Z');
    const localEndAt = new Date('2020-07-20T05:00:00.000Z');
    await prisma.activity.update({
      where: { id: activityId },
      data: {
        startAt: localStartAt,
        endAt: localEndAt,
        registrationDeadline: new Date('2020-07-19T12:00:00.000Z'),
      },
    });
    await prisma.activitySession.update({
      where: { id: sessionId },
      data: {
        startAt: localStartAt,
        endAt: localEndAt,
        checkInOpenAt: new Date('2020-07-20T00:30:00Z'),
        checkInCloseAt: new Date('2020-07-20T02:00:00Z'),
        checkOutOpenAt: new Date('2020-07-20T03:00:00Z'),
        checkOutCloseAt: localEndAt,
      },
    });
    const identities = await prisma.activityParticipationIdentity.findMany({
      where: { activityId, memberId: { in: [participant.memberId, secondParticipant.memberId] } },
    });
    expect(identities).toHaveLength(2);
    const participantIdentityId = identities.find(
      (identity) => identity.memberId === participant.memberId,
    )!.id;
    try {
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
      for (const [actionCode, now] of [
        ['check_in', localStartAt],
        ['check_out', new Date('2020-07-20T03:00:00Z')],
      ] as const) {
        jest.setSystemTime(now);
        for (const identity of identities) {
          await request(httpServer(app))
            .post(
              `/api/app/v1/my/managed-activities/${activityId}/onsite/sessions/${sessionId}/proxy-punch`,
            )
            .set('Authorization', attendanceCollaborator.auth)
            .send({
              participationIdentityId: identity.id,
              actionCode,
              eventKey: `local-${identity.id}-${actionCode}`,
              reason: '现场确认',
            })
            .expect(201);
        }
      }
    } finally {
      jest.useRealTimers();
    }
    const sealed = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/evidence-seals`)
      .set('Authorization', owner.auth)
      .send({})
      .expect(200);
    const sealId = sealed.body.data.sealId as string;
    await prisma.contributionRule.create({
      data: { activityTypeCode, attendanceRoleCode, pointsBelow: 1, status: 'ACTIVE' },
    });
    const generated = await request(httpServer(app))
      .post(`${settlementBase}/generate`)
      .set('Authorization', attendanceCollaborator.auth)
      .send({ operationKey: 'local-generate' })
      .expect(200);
    expect(generated.body.data.personCount).toBe(2);
    const draftItems = await request(httpServer(app))
      .get(`${settlementBase}/items`)
      .set('Authorization', attendanceCollaborator.auth)
      .expect(200);
    expect(draftItems.body.data.total).toBe(2);
    // Keep this journey's zero-credit outcome explicit. Native drafts correctly
    // block a missing rule; a real rule supplies the machine baseline and the
    // responsible person records the zero-credit adjudication with a reason.
    async function editItem(actor: LocalActor, identityId: string, hours: number) {
      const run = await prisma.attendanceSettlementRun.findUniqueOrThrow({ where: { activityId } });
      return request(httpServer(app))
        .patch(`${settlementBase}/items/${identityId}`)
        .set('Authorization', actor.auth)
        .send({
          expectedDraftVersion: run.currentDraftVersion,
          resultCode: 'present',
          recognizedServiceHours: hours,
          recognizedContributionPoints: 0,
          reason: '核定服务时长，本次不计贡献',
        })
        .expect(200);
    }
    async function reviewCommand(versionId: string, operationKey: string) {
      const version = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: versionId },
      });
      return {
        operationKey,
        note: operationKey,
        evidenceSealId: version.evidenceSealId,
        evidenceRevision: version.evidenceRevision,
        populationRevision: version.populationRevision,
        workflowRevision: version.workflowRevision,
        contentHash: version.contentHash,
      };
    }
    async function review(versionId: string, action: string, actor: LocalActor) {
      return request(httpServer(app))
        .post(`/api/admin/v1/attendance-settlements/${versionId}/${action}`)
        .set('Authorization', actor.auth)
        .send(await reviewCommand(versionId, `${versionId}:${action}`))
        .expect(200);
    }
    async function resubmit(versionId: string, actor: LocalActor) {
      const run = await prisma.attendanceSettlementRun.findUniqueOrThrow({ where: { activityId } });
      const response = await request(httpServer(app))
        .post(`${settlementBase}/versions/${versionId}/resubmit`)
        .set('Authorization', actor.auth)
        .send({
          operationKey: `resubmit:${versionId}`,
          expectedDraftVersion: run.currentDraftVersion,
          evidenceSealId: sealId,
          confirmation: true,
        })
        .expect(200);
      const newVersionId = response.body.data.settlementVersionId as string;
      expect(newVersionId).not.toBe(versionId);
      expect(
        await prisma.attendanceSettlementVersion.findUniqueOrThrow({ where: { id: newVersionId } }),
      ).toMatchObject({
        priorVersionId: versionId,
        statusCode: 'submitted',
        createdByUserId: actor.userId,
        returnFromStage: null,
        returnReason: null,
      });
      expect(
        await prisma.settlementReviewAction.count({ where: { settlementVersionId: newVersionId } }),
      ).toBe(0);
      return newVersionId;
    }
    for (const identity of identities) await editItem(attendanceCollaborator, identity.id, 2);
    const submitCommand = {
      operationKey: 'local-submit',
      expectedDraftVersion: generated.body.data.settlementVersion,
      evidenceSealId: sealId,
      confirmation: true,
    };
    const submitted = await request(httpServer(app))
      .post(`${settlementBase}/submit`)
      .set('Authorization', attendanceCollaborator.auth)
      .send(submitCommand)
      .expect(200);
    const firstVersionId = submitted.body.data.settlementVersionId as string;
    expect(
      await prisma.attendanceSettlementVersion.findUniqueOrThrow({ where: { id: firstVersionId } }),
    ).toMatchObject({
      statusCode: 'submitted',
      createdByUserId: attendanceCollaborator.userId,
    });

    for (const auth of [registrationCollaborator.auth, unrelatedAdmin.auth]) {
      expectBizError(
        await request(httpServer(app))
          .post(`${settlementBase}/submit`)
          .set('Authorization', auth)
          .send(submitCommand),
        BizCode.RBAC_FORBIDDEN,
      );
    }
    expectBizError(
      await request(httpServer(app))
        .post(`/api/admin/v1/attendance-settlements/${firstVersionId}/first-approve`)
        .set('Authorization', attendanceCollaborator.auth)
        .send(await reviewCommand(firstVersionId, 'no-review-rights')),
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
        .post(`${settlementBase}/close`)
        .set('Authorization', owner.auth)
        .send({
          operationKey: 'old-owner-close',
          expectedSettlementVersionId: firstVersionId,
          expectedPostingBatchId: 'local-not-yet-posted-batch',
        }),
      BizCode.RBAC_FORBIDDEN,
    );
    const prematureClose = await request(httpServer(app))
      .post(`${settlementBase}/close`)
      .set('Authorization', newOwner.auth)
      .send({
        operationKey: 'new-owner-premature-close',
        expectedSettlementVersionId: firstVersionId,
        expectedPostingBatchId: 'local-not-yet-posted-batch',
      });
    expectBizError(prematureClose, BizCode.ACTIVITY_CLOSURE_EXPECTED_SETTLEMENT_VERSION_MISMATCH);
    expect(await prisma.activitySettlementClosureRevision.count({ where: { activityId } })).toBe(0);

    await review(firstVersionId, 'first-return', firstReviewerA);
    const firstReturned = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: firstVersionId },
    });
    expect(firstReturned).toMatchObject({
      statusCode: 'returned',
      returnFromStage: 'first',
      returnReason: `${firstVersionId}:first-return`,
    });
    const firstReturnedDetail = await request(httpServer(app))
      .get(`${settlementBase}/versions/${firstVersionId}`)
      .set('Authorization', attendanceCollaborator.auth)
      .expect(200);
    expect(firstReturnedDetail.body.data.version).toMatchObject({
      id: firstVersionId,
      personCount: 2,
      statusCode: 'returned',
      returnFromStage: 'first',
    });
    expect(
      await prisma.participantSettlementResultRevision.count({
        where: { settlementVersionId: firstVersionId },
      }),
    ).toBe(2);
    await editItem(attendanceCollaborator, participantIdentityId, 1.5);
    const secondVersionId = await resubmit(firstVersionId, attendanceCollaborator);
    expect(
      await prisma.attendanceSettlementVersion.findUniqueOrThrow({ where: { id: firstVersionId } }),
    ).toEqual(firstReturned);
    await review(secondVersionId, 'first-approve', firstReviewerB);
    await review(secondVersionId, 'final-return', finalReviewerA);
    const finalReturned = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: secondVersionId },
    });
    expect(finalReturned).toMatchObject({
      statusCode: 'returned',
      returnFromStage: 'final',
      returnReason: `${secondVersionId}:final-return`,
    });
    const finalReturnedDetail = await request(httpServer(app))
      .get(`${settlementBase}/versions/${secondVersionId}`)
      .set('Authorization', attendanceCollaborator.auth)
      .expect(200);
    expect(finalReturnedDetail.body.data.version).toMatchObject({
      id: secondVersionId,
      personCount: 2,
      statusCode: 'returned',
      returnFromStage: 'final',
    });
    expect(
      await prisma.participantSettlementResultRevision.count({
        where: { settlementVersionId: secondVersionId },
      }),
    ).toBe(2);
    await editItem(owner, participantIdentityId, 1.25);
    const finalVersionId = await resubmit(secondVersionId, owner);
    expect(
      await prisma.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: secondVersionId },
      }),
    ).toEqual(finalReturned);

    const beforeFinalApproval = await request(httpServer(app))
      .get('/api/app/v1/my/participation-summary')
      .set('Authorization', participant.auth)
      .expect(200);
    expect(beforeFinalApproval.body.data).toMatchObject({
      totalServiceHours: '0',
      recordCount: 0,
      contributionPoints: '0',
    });

    await review(finalVersionId, 'first-approve', firstReviewerA);
    const approved = await review(finalVersionId, 'final-approve', finalReviewerB);
    expect(approved.body.data).toMatchObject({
      versionStatusAfter: 'approved',
      runStatusAfter: 'posting',
    });
    expect(
      await prisma.settlementReviewAction.findMany({
        where: { settlementVersionId: finalVersionId },
        orderBy: { stageCode: 'asc' },
        select: { stageCode: true, actorUserId: true, actionCode: true },
      }),
    ).toEqual([
      { stageCode: 'final', actorUserId: finalReviewerB.userId, actionCode: 'approve' },
      { stageCode: 'first', actorUserId: firstReviewerA.userId, actionCode: 'approve' },
    ]);
    const beforePosting = await request(httpServer(app))
      .get('/api/app/v1/my/participation-summary')
      .set('Authorization', participant.auth)
      .expect(200);
    expect(beforePosting.body.data).toMatchObject({
      totalServiceHours: '0',
      recordCount: 0,
      contributionPoints: '0',
    });
    const batch = await prisma.ledgerPostingBatch.findFirstOrThrow({
      where: { settlementVersionId: finalVersionId },
    });
    // Run the production background preparation/commit primitives. Review HTTP
    // alone must never publish credit, and no fixture writes ledger outcomes.
    const preparation = app.get(LedgerPreparationService);
    const job = await preparation.ensurePrepareJob(batch.id);
    for (const item of await prisma.activityBatchJobItem.findMany({
      where: { jobId: job.jobId },
    })) {
      await preparation.prepareChunk(job.jobId, item.id);
    }
    expect((await preparation.finalize(job.jobId)).batchStatus).toBe('ready');
    const postingActor = await prisma.user.findUniqueOrThrow({
      where: { id: finalReviewerB.userId },
      select: { id: true, username: true, memberId: true, role: true, status: true },
    });
    await app
      .get(LedgerPostingService)
      .commitBatch({ postingBatchId: batch.id, operationKey: 'local-post' }, postingActor, {
        requestId: 'local-workflow-post',
        ip: null,
        ua: null,
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

    const closure = await request(httpServer(app))
      .post(`${settlementBase}/close`)
      .set('Authorization', newOwner.auth)
      .send({
        operationKey: 'new-owner-close',
        expectedSettlementVersionId: finalVersionId,
        expectedPostingBatchId: batch.id,
      })
      .expect(200);
    expect(closure.body.data.outcome).toBe('closed');
    const closed = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${activityId}`)
      .set('Authorization', newOwner.auth)
      .expect(200);
    expect(closed.body.data.activity.statusCode).toBe('completed');
    expect(closed.body.data.settlement).toMatchObject({
      availability: 'available',
      runStatus: 'closed',
      activeClosure: { revision: 1 },
    });
    expect(closed.body.data).not.toHaveProperty('closure');
    expect(
      await prisma.attendanceSettlementVersion.count({
        where: { settlementRun: { activityId }, statusCode: 'submitted' },
      }),
    ).toBe(0);
    expect(
      await prisma.attendanceSettlementVersion.findUniqueOrThrow({ where: { id: firstVersionId } }),
    ).toEqual(firstReturned);
    expect(
      await prisma.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: secondVersionId },
      }),
    ).toEqual(finalReturned);
    expect(await prisma.attendanceSheet.count({ where: { activityId } })).toBe(0);
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
    const compatibilityPublish = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${otherActivityId}/direct-publish`)
      .set('Authorization', organizationBOwner.auth)
      .send({})
      .expect(200);
    expect(compatibilityPublish.body.data.activity.statusCode).toBe('draft');
    await expect(
      prisma.activityPublishReview.findFirstOrThrow({
        where: { activityId: otherActivityId },
        select: { status: true, directPublish: true },
      }),
    ).resolves.toEqual({ status: 'pending', directPublish: false });

    expectBizError(
      await request(httpServer(app))
        .get(`/api/app/v1/my/managed-activities/${otherActivityId}/registrations`)
        .set('Authorization', crossOrgInitiator.auth),
      BizCode.RBAC_FORBIDDEN,
    );
    expectBizError(
      await request(httpServer(app))
        .get(`/api/app/v1/my/managed-activities/${otherActivityId}/settlement`)
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
