import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
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

describe('App managed native attendance and settlement responsibilities', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let organizationId: string;
  let bizAdminRoleId: string;
  let reviewerAuth: string;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
  const previousV11 = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    const roles = await seedActivityResponsibilitySystemRoles(app);
    // The shared legacy fixture predates native settlement permissions. Match
    // prisma/seed.ts's existing owner/collaborator grants for this native suite;
    // do not grant native actions to the ordinary global biz-admin.
    const actions = [
      'activity.settlement-generate.record',
      'activity.settlement-update-draft.record',
      'activity.settlement-submit.record',
      'activity.settlement-close.record',
    ];
    await prisma.permission.createMany({
      data: ACTIVITY_RESPONSIBILITY_WORKFLOW_PERMISSION_SEED.filter((row) =>
        actions.includes(row.code),
      ).map((row) => ({ ...row })),
      skipDuplicates: true,
    });
    const nativePermissions = await prisma.permission.findMany({
      where: { code: { in: actions } },
    });
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
    const reviewer = await createTestUser(app, {
      username: 'managed-attendance-reviewer',
      role: Role.SUPER_ADMIN,
    });
    reviewerAuth = (await loginAs(app, reviewer.username)).authHeader;

    const nodeType = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeType.id, code: 'managed-attendance-team', label: '考勤团队' },
    });
    const rootId = (
      await prisma.organization.create({
        data: { name: 'Managed Attendance Root', nodeTypeCode: 'managed-attendance-team' },
        select: { id: true },
      })
    ).id;
    organizationId = (
      await prisma.organization.create({
        data: {
          name: 'Managed Attendance Team',
          nodeTypeCode: 'managed-attendance-team',
          parentId: rootId,
        },
        select: { id: true },
      })
    ).id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: rootId, descendantId: rootId, depth: 0 },
        { ancestorId: rootId, descendantId: organizationId, depth: 1 },
        { ancestorId: organizationId, descendantId: organizationId, depth: 0 },
      ],
    });
    for (const [typeCode, code, label] of [
      ['activity_type', 'managed-attendance-training', '考勤训练'],
      ['attendance_role', 'member', '队员'],
      ['attendance_status', 'present', '出席'],
    ] as const) {
      const type = await prisma.dictType.create({
        data: { code: typeCode, label: typeCode },
        select: { id: true },
      });
      await prisma.dictItem.create({ data: { typeId: type.id, code, label } });
    }
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (previousGate === undefined) delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousGate;
      if (previousV11 === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousV11;
    }
  });

  async function memberUser(label: string, globalAdmin = false) {
    const n = ++sequence;
    const member = await prisma.member.create({
      data: {
        memberNo: `managed-att-${label}-${n}`,
        ...memberIdentityData(`Managed Attendance ${label} ${n}`),
        gradeCode: 'level-3',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    const user = await createTestUser(app, { username: `mat-${n}`, role: Role.USER });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    await prisma.memberOrganizationMembership.create({
      data: { memberId: member.id, organizationId },
    });
    if (globalAdmin) await grantBizAdminToUser(app, user.id, bizAdminRoleId);
    return {
      memberId: member.id,
      userId: user.id,
      auth: (await loginAs(app, user.username)).authHeader,
    };
  }

  it('native reads/writes follow active attendance responsibility; removal revokes every tested surface immediately', async () => {
    const owner = await memberUser('owner', true);
    const attendanceCollaborator = await memberUser('attendance');
    const registrationCollaborator = await memberUser('registration');
    const globalAdmin = await memberUser('global-admin', true);
    const participant = await memberUser('participant');

    const created = await request(httpServer(app))
      .post('/api/app/v1/my/managed-activities')
      .set('Authorization', owner.auth)
      .send({
        title: 'Managed attendance activity',
        activityTypeCode: 'managed-attendance-training',
        organizationId,
        startAt: '2099-11-01T01:00:00.000Z',
        endAt: '2099-11-01T05:00:00.000Z',
        registrationDeadline: '2099-10-31T12:00:00.000Z',
        location: '深圳',
        capacity: 50,
        allocationModeCode: 'first_come',
      });
    if (created.status !== 201) throw new Error(JSON.stringify(created.body));
    const activityId = created.body.data.activity.id as string;
    await prisma.activity.update({
      where: { id: activityId },
      data: {
        metricRequirementCode: 'not_required',
        selectedMetricSetVersionId: null,
        selectedMetricSetDefinitionHash: null,
        metricSelectionRevision: 1,
      },
    });
    const createdSession = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions`)
      .set('Authorization', owner.auth)
      .send({
        code: `attendance-session-${sequence}`,
        name: '发布审核主场次',
        startAt: '2099-11-01T01:00:00.000Z',
        endAt: '2099-11-01T05:00:00.000Z',
        locationText: '深圳会场',
        checkInOpenAt: '2099-11-01T00:30:00.000Z',
        checkInCloseAt: '2099-11-01T02:00:00.000Z',
        checkOutOpenAt: '2099-11-01T03:00:00.000Z',
        checkOutCloseAt: '2099-11-01T05:00:00.000Z',
        locationRequired: false,
      })
      .expect(201);
    const submittedForPublish = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/publish-reviews`)
      .set('Authorization', owner.auth)
      .send({ operationKey: `attendance-initial-submit-${sequence}`, confirmation: true })
      .expect(200);
    await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${submittedForPublish.body.data.id}/approve`)
      .set('Authorization', reviewerAuth)
      .send({
        requiresInsuranceConfirmed: true,
        operationKey: `attendance-initial-approve-${sequence}`,
      })
      .expect(200);
    await prisma.activity.update({
      where: { id: activityId },
      data: {
        startAt: new Date('2020-07-20T01:00:00.000Z'),
        endAt: new Date('2020-07-20T05:00:00.000Z'),
        registrationDeadline: new Date('2020-07-19T12:00:00.000Z'),
      },
    });
    const sessionId = createdSession.body.data.sessionId as string;
    await prisma.activitySession.update({
      where: { id: sessionId },
      data: {
        startAt: new Date('2020-07-20T01:00:00Z'),
        endAt: new Date('2020-07-20T05:00:00Z'),
        checkInOpenAt: new Date('2020-07-20T00:30:00Z'),
        checkInCloseAt: new Date('2020-07-20T02:00:00Z'),
        checkOutOpenAt: new Date('2020-07-20T03:00:00Z'),
        checkOutCloseAt: new Date('2020-07-20T05:00:00Z'),
      },
    });

    const attendanceAssignment = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/collaborators`)
      .set('Authorization', owner.auth)
      .send({
        memberId: attendanceCollaborator.memberId,
        canManageRegistrations: false,
        canManageAttendance: true,
        reason: '负责考勤',
      })
      .expect(201);
    const attendanceAssignmentId = attendanceAssignment.body.data.id as string;
    await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/collaborators`)
      .set('Authorization', owner.auth)
      .send({
        memberId: registrationCollaborator.memberId,
        canManageRegistrations: true,
        canManageAttendance: false,
        reason: '只负责报名',
      })
      .expect(201);

    const registration = await prisma.activityRegistration.create({
      data: {
        activityId,
        memberId: participant.memberId,
        statusCode: 'pass',
        reviewedBy: owner.userId,
        reviewedAt: new Date(),
      },
      select: { id: true },
    });
    const identity = await prisma.activityParticipationIdentity.create({
      data: {
        activityId,
        sessionId,
        memberId: participant.memberId,
        registrationId: registration.id,
        currentRevision: 1,
        currentStatusCode: 'pass',
        populationIncluded: true,
      },
    });
    await prisma.activityParticipationRevision.create({
      data: {
        identityId: identity.id,
        revision: 1,
        statusCode: 'pass',
        sourceCode: 'self',
        effectiveAt: new Date('2020-07-19T01:00:00Z'),
        createdByUserId: participant.userId,
      },
    });
    const evidence = await prisma.activityEvidenceState.findUnique({
      where: { activityId },
    });
    const activity = await prisma.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: { workflowRevision: true },
    });
    await prisma.attendancePunchEvent.createMany({
      data: [
        { eventTypeCode: 'check_in', occurredAt: new Date('2020-07-20T01:00:00Z') },
        { eventTypeCode: 'check_out', occurredAt: new Date('2020-07-20T03:00:00Z') },
      ].map((event) => ({
        ...event,
        activityId,
        sessionId,
        participationIdentityId: identity.id,
        memberId: participant.memberId,
        sourceCode: 'staff_scan',
        receivedAt: event.occurredAt,
        operatorUserId: owner.userId,
        eventKey: `managed-native-${event.eventTypeCode}`,
        requestHash: `managed-native-${event.eventTypeCode}`,
        evidenceRevision: evidence?.evidenceRevision ?? 0,
      })),
    });
    await prisma.contributionRule.create({
      data: {
        activityTypeCode: 'managed-attendance-training',
        attendanceRoleCode: 'member',
        status: 'ACTIVE',
        pointsBelow: 1,
      },
    });
    const seal = await prisma.evidenceSeal.create({
      data: {
        activityId,
        sealRevision: 1,
        evidenceRevision: evidence?.evidenceRevision ?? 0,
        populationRevision: evidence?.populationRevision ?? 0,
        workflowRevision: activity.workflowRevision,
        allWindowsClosedAt: new Date('2020-07-20T06:00:00Z'),
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: 1,
        populationCountBySession: { [sessionId]: 1 },
        contentHash: 'managed-native-sealed-input',
        statusCode: 'active',
        sealedAt: new Date('2020-07-20T06:00:00Z'),
        sealedByUserId: owner.userId,
      },
    });
    const base = `/api/app/v1/my/managed-activities/${activityId}/settlement`;
    const generated = await request(httpServer(app))
      .post(`${base}/generate`)
      .set('Authorization', attendanceCollaborator.auth)
      .send({ operationKey: 'managed-native-generate' })
      .expect((res) => {
        expect({ status: res.status, code: res.body.code, message: res.body.message }).toEqual({
          status: 200,
          code: 0,
          message: 'ok',
        });
      });
    expect(generated.body.data).toMatchObject({ outcome: 'draft', personCount: 1 });

    const list = await request(httpServer(app))
      .get(`${base}/items`)
      .set('Authorization', owner.auth)
      .expect(200);
    expect(list.body.data.total).toBe(1);
    expect(list.body.data.items[0]).toMatchObject({
      identityId: identity.id,
      calculatedServiceHours: 2,
      calculatedContributionPoints: 1,
    });
    for (const field of [
      'checkInLongitude',
      'checkInLatitude',
      'longitude',
      'latitude',
      'qrToken',
    ]) {
      expect(list.body.data.items[0]).not.toHaveProperty(field);
    }
    await request(httpServer(app))
      .get(base)
      .set('Authorization', attendanceCollaborator.auth)
      .expect(200);

    const edited = await request(httpServer(app))
      .patch(`${base}/items/${identity.id}`)
      .set('Authorization', owner.auth)
      .send({
        expectedDraftVersion: generated.body.data.settlementVersion,
        resultCode: 'present',
        recognizedServiceHours: 2,
        recognizedContributionPoints: 1,
        reason: '负责人复核',
      })
      .expect(200);
    expect(edited.body.data.identityId).toBe(identity.id);

    const submitted = await request(httpServer(app))
      .post(`${base}/submit`)
      .set('Authorization', attendanceCollaborator.auth)
      .send({
        operationKey: 'managed-native-submit',
        expectedDraftVersion: edited.body.data.settlementVersion,
        evidenceSealId: seal.id,
        confirmation: true,
      })
      .expect(200);
    const versionId = submitted.body.data.settlementVersionId as string;
    const version = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    expect(version.createdByUserId).toBe(attendanceCollaborator.userId);
    const detail = await request(httpServer(app))
      .get(`${base}/versions/${versionId}`)
      .set('Authorization', owner.auth)
      .expect(200);
    expect(detail.body.data.version).toMatchObject({
      id: versionId,
      personCount: 1,
      sessionParticipationCount: 1,
    });
    expect(detail.body.data).not.toHaveProperty('activity');
    await request(httpServer(app))
      .post(`/api/admin/v1/attendance-settlements/${versionId}/first-return`)
      .set('Authorization', reviewerAuth)
      .send({
        operationKey: 'managed-native-return',
        note: '补充说明',
        evidenceSealId: version.evidenceSealId,
        evidenceRevision: version.evidenceRevision,
        populationRevision: version.populationRevision,
        workflowRevision: version.workflowRevision,
        contentHash: version.contentHash,
      })
      .expect(200);
    const returned = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    const working = await prisma.attendanceSettlementRun.findUniqueOrThrow({
      where: { activityId },
    });
    const resubmitted = await request(httpServer(app))
      .post(`${base}/versions/${versionId}/resubmit`)
      .set('Authorization', owner.auth)
      .send({
        operationKey: 'managed-native-resubmit',
        expectedDraftVersion: working.currentDraftVersion,
        evidenceSealId: seal.id,
        confirmation: true,
      })
      .expect(200);
    expect(resubmitted.body.data.settlementVersionId).not.toBe(versionId);
    const latest = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: resubmitted.body.data.settlementVersionId },
    });
    expect(latest).toMatchObject({
      statusCode: 'submitted',
      createdByUserId: owner.userId,
      priorVersionId: versionId,
    });
    expect(
      await prisma.attendanceSettlementVersion.findUniqueOrThrow({ where: { id: versionId } }),
    ).toEqual(returned);

    const historicalSheet = await prisma.attendanceSheet.create({
      data: {
        activityId,
        submitterUserId: owner.userId,
        lastSubmittedByUserId: owner.userId,
        statusCode: 'pending',
      },
    });
    for (const retiredId of [historicalSheet.id, latest.id]) {
      await request(httpServer(app))
        .delete(`/api/app/v1/my/managed-activities/${activityId}/attendance-sheets/${retiredId}`)
        .set('Authorization', owner.auth)
        .expect(404);
    }
    expect(
      await prisma.attendanceSheet.findUniqueOrThrow({ where: { id: historicalSheet.id } }),
    ).toEqual(historicalSheet);

    async function protectedState() {
      return {
        run: await prisma.attendanceSettlementRun.findUniqueOrThrow({ where: { activityId } }),
        versions: await prisma.attendanceSettlementVersion.findMany({
          where: { settlementRun: { activityId } },
          orderBy: { id: 'asc' },
        }),
        results: await prisma.participantSettlementResultRevision.findMany({
          where: { participationIdentityId: identity.id },
          orderBy: { id: 'asc' },
        }),
        auditCount: await prisma.auditLog.count(),
        intentCount: await prisma.notificationOutboxIntent.count(),
      };
    }
    async function expectNoNativeAccess(auth: string) {
      const before = await protectedState();
      const common = {
        expectedDraftVersion: working.currentDraftVersion,
        evidenceSealId: seal.id,
        confirmation: true,
      };
      const probes = [
        request(httpServer(app)).get(base),
        request(httpServer(app)).get(`${base}/items`),
        request(httpServer(app)).get(`${base}/versions/${versionId}`),
        request(httpServer(app))
          .post(`${base}/generate`)
          .send({ operationKey: 'managed-native-generate' }),
        request(httpServer(app)).patch(`${base}/items/${identity.id}`).send({
          expectedDraftVersion: working.currentDraftVersion,
          resultCode: 'present',
          recognizedServiceHours: 2,
          recognizedContributionPoints: 1,
          reason: '拒绝验收',
        }),
        request(httpServer(app))
          .post(`${base}/submit`)
          .send({ ...common, operationKey: 'managed-native-submit' }),
        request(httpServer(app))
          .post(`${base}/versions/${versionId}/resubmit`)
          .send({ ...common, operationKey: 'managed-native-resubmit' }),
      ];
      for (const probe of probes) {
        expectBizError(await probe.set('Authorization', auth), BizCode.RBAC_FORBIDDEN);
      }
      expect(await protectedState()).toEqual(before);
    }
    for (const auth of [registrationCollaborator.auth, globalAdmin.auth, participant.auth])
      await expectNoNativeAccess(auth);

    await request(httpServer(app))
      .get(base)
      .set('Authorization', attendanceCollaborator.auth)
      .expect(200);
    await request(httpServer(app))
      .delete(
        `/api/app/v1/my/managed-activities/${activityId}/collaborators/${attendanceAssignmentId}`,
      )
      .set('Authorization', owner.auth)
      .expect(200);
    await expectNoNativeAccess(attendanceCollaborator.auth);
    await request(httpServer(app)).get(base).set('Authorization', owner.auth).expect(200);
  }, 60_000);
});
