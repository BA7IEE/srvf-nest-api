import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { PUBLISHED_ACTIVITY_DISPLAY_FIELDS } from '../../src/modules/activities/activities.service';
import { computeActivityTemplateDefinitionHash } from '../../src/modules/activities/activity-template-definition';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

describe('batch3 slice2 activity publish proposal workflow', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let creatorAuth: string;
  let reviewerAuth: string;
  let organizationId: string;
  let activityTypeCode: string;
  let attendanceRoleCode: string;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const creator = await createTestUser(app, {
      username: 'batch3-slice2-creator',
      role: Role.SUPER_ADMIN,
    });
    const reviewer = await createTestUser(app, {
      username: 'batch3-slice2-reviewer',
      role: Role.USER,
    });
    const creatorMember = await prisma.member.create({
      data: {
        memberNo: 'batch3-slice2-creator-member',
        ...memberIdentityData('发布提案发起人'),
        gradeCode: 'level-3',
      },
      select: { id: true },
    });
    const reviewerMember = await prisma.member.create({
      data: {
        memberNo: 'batch3-slice2-reviewer-member',
        ...memberIdentityData('发布提案审核人'),
        gradeCode: 'level-3',
      },
      select: { id: true },
    });
    await prisma.user.update({
      where: { id: creator.id },
      data: { memberId: creatorMember.id },
    });
    await prisma.user.update({
      where: { id: reviewer.id },
      data: { memberId: reviewerMember.id },
    });

    const bizAdmin = await seedBizAdminPermissionsAndRole(app);
    await seedActivityResponsibilitySystemRoles(app);
    await grantBizAdminToUser(app, creator.id, bizAdmin.bizAdminRoleId);

    const root = await prisma.organization.create({
      data: { name: '第 3 批发布链根组织', nodeTypeCode: 'batch3-slice2-root' },
      select: { id: true },
    });
    const organization = await prisma.organization.create({
      data: {
        name: '第 3 批发布链执行组织',
        nodeTypeCode: 'batch3-slice2-team',
        parentId: root.id,
      },
      select: { id: true },
    });
    organizationId = organization.id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: root.id, descendantId: root.id, depth: 0 },
        { ancestorId: root.id, descendantId: organization.id, depth: 1 },
        { ancestorId: organization.id, descendantId: organization.id, depth: 0 },
      ],
    });
    await prisma.memberOrganizationMembership.create({
      data: { memberId: creatorMember.id, organizationId },
    });

    const activityType = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    activityTypeCode = 'batch3-slice2-type';
    await prisma.dictItem.create({
      data: { typeId: activityType.id, code: activityTypeCode, label: '发布链测试活动' },
    });
    const attendanceRole = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    attendanceRoleCode = 'batch3-slice2-attendee';
    await prisma.dictItem.create({
      data: { typeId: attendanceRole.id, code: attendanceRoleCode, label: '活动参与者' },
    });

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
      ],
      skipDuplicates: true,
    });
    const reviewerRole = await prisma.rbacRole.create({
      data: { code: 'batch3-slice2-reviewer', displayName: '第 3 批发布链审核人' },
      select: { id: true },
    });
    const reviewerPermissions = await prisma.permission.findMany({
      where: {
        code: {
          in: [
            'activity-review.read.request',
            'activity-review.return.request',
            'activity.publish.record',
          ],
        },
      },
      select: { id: true },
    });
    await prisma.rolePermission.createMany({
      data: reviewerPermissions.map((permission) => ({
        roleId: reviewerRole.id,
        permissionId: permission.id,
      })),
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: reviewer.id,
        roleId: reviewerRole.id,
        scopeType: BindingScopeType.ORGANIZATION,
        scopeOrgId: organizationId,
      },
    });

    creatorAuth = (await loginAs(app, creator.username)).authHeader;
    reviewerAuth = (await loginAs(app, reviewer.username)).authHeader;
  });

  afterAll(async () => {
    await app.close();
    if (previousGate === undefined) {
      delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousGate;
    }
  });

  async function createDraftWithLiveSession(): Promise<{ activityId: string; sessionId: string }> {
    sequence += 1;
    const activity = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', creatorAuth)
      .send({
        title: `第 3 批发布提案活动 ${sequence}`,
        activityTypeCode,
        organizationId,
        startAt: '2099-08-01T01:00:00.000Z',
        endAt: '2099-08-01T05:00:00.000Z',
        registrationDeadline: '2099-07-31T12:00:00.000Z',
        location: '深圳',
        allocationModeCode: 'first_come',
      });
    expect(activity.status).toBe(201);
    const activityId = activity.body.data.id as string;
    const sessionId = await createLiveSession(activityId, 'main');
    return { activityId, sessionId };
  }

  async function createLiveSession(activityId: string, suffix: string): Promise<string> {
    const session = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions`)
      .set('Authorization', creatorAuth)
      .send({
        code: `s-${sequence}-${suffix}`,
        name: `场次 ${suffix}`,
        startAt: '2099-08-01T01:00:00.000Z',
        endAt: '2099-08-01T05:00:00.000Z',
        locationText: '深圳会场',
        checkInOpenAt: '2099-08-01T00:30:00.000Z',
        checkInCloseAt: '2099-08-01T02:00:00.000Z',
        checkOutOpenAt: '2099-08-01T03:00:00.000Z',
        checkOutCloseAt: '2099-08-01T05:00:00.000Z',
        locationRequired: false,
      });
    expect(session.status).toBe(201);
    return session.body.data.sessionId as string;
  }

  async function createSessionPosition(
    activityId: string,
    sessionId: string,
    suffix: string,
  ): Promise<string> {
    const position = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}/positions`)
      .set('Authorization', creatorAuth)
      .send({
        code: `p-${sequence}-${suffix}`,
        name: `岗位 ${suffix}`,
        attendanceRoleCode,
        capacity: 3,
        startAt: '2099-08-01T01:30:00.000Z',
        endAt: '2099-08-01T04:30:00.000Z',
      });
    expect(position.status).toBe(201);
    return position.body.data.positionId as string;
  }

  it('hides a draft activity from a non-owner attempting a change proposal', async () => {
    const { activityId } = await createDraftWithLiveSession();
    const hidden = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/change-reviews`)
      .set('Authorization', reviewerAuth)
      .send({
        operationKey: 'batch3-2-hidden-change-0001',
        confirmation: true,
        activityPatch: { title: '非负责人不应看见 draft 状态' },
        sessions: { create: [], update: [], cancel: [] },
        positions: { create: [], update: [], cancel: [] },
      });
    expectBizError(hidden, BizCode.ACTIVITY_NOT_FOUND);
  });

  it('rejects a proposal whose live session-position capacities exceed the finite parent capacity', async () => {
    const { activityId, sessionId } = await createDraftWithLiveSession();
    await prisma.activity.update({ where: { id: activityId }, data: { capacity: 1 } });
    await createSessionPosition(activityId, sessionId, 'over-parent-capacity');

    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/publish-reviews`)
      .set('Authorization', creatorAuth)
      .send({ operationKey: 'batch3-2-parent-capacity-0001', confirmation: true });
    expectBizError(submitted, BizCode.ACTIVITY_SESSION_POSITION_CAPACITY_INVALID);
  });

  it('submits a canonical initial proposal idempotently and requires review before publish', async () => {
    const { activityId, sessionId } = await createDraftWithLiveSession();
    const positionId = await createSessionPosition(activityId, sessionId, 'resolution');
    const payload = { operationKey: 'batch3-2-initial-0001', confirmation: true };

    const hiddenFromOtherMember = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/publish-reviews`)
      .set('Authorization', reviewerAuth)
      .send({ operationKey: 'batch3-2-hidden-0001', confirmation: true });
    expectBizError(hiddenFromOtherMember, BizCode.ACTIVITY_NOT_FOUND);

    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/publish-reviews`)
      .set('Authorization', creatorAuth)
      .send(payload);
    expect(submitted.status).toBe(200);
    expect(submitted.body.data).toMatchObject({
      activityId,
      requestType: 'initial',
      status: 'pending',
      directPublish: false,
      snapshot: expect.objectContaining({ schemaVersion: 6, snapshotHash: expect.any(String) }),
    });

    const replay = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/publish-reviews`)
      .set('Authorization', creatorAuth)
      .send(payload);
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(submitted.body.data.id);

    const withdrawn = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/reviews/withdraw`)
      .set('Authorization', creatorAuth)
      .send({});
    expect(withdrawn.body.data).toMatchObject({ id: submitted.body.data.id, status: 'withdrawn' });
    await prisma.activity.update({
      where: { id: activityId },
      data: { updatedAt: new Date('2099-01-01T00:00:00.000Z') },
    });
    const rebuilt = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/publish-reviews`)
      .set('Authorization', creatorAuth)
      .send({ operationKey: 'batch3-2-initial-0001-rebuilt', confirmation: true });
    expect(rebuilt.status).toBe(200);
    // A DB-managed timestamp is intentionally not canonical input: serializing it would make this red.
    expect(rebuilt.body.data.snapshot.snapshotHash).toBe(submitted.body.data.snapshot.snapshotHash);
    const resolution = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${activityId}/template-resolution`)
      .set('Authorization', creatorAuth);
    expect(resolution.status).toBe(200);
    expect(resolution.body.data).toMatchObject({
      templateVersionId: null,
      activity: expect.objectContaining({
        registrationModeCode: expect.objectContaining({ source: 'system-default' }),
      }),
      sessions: [
        expect.objectContaining({
          sessionId,
          resolution: expect.objectContaining({
            locationRequired: expect.objectContaining({ source: 'activity' }),
          }),
          positions: [
            expect.objectContaining({
              positionId,
              resolution: expect.objectContaining({
                locationRequired: expect.objectContaining({ source: 'activity' }),
              }),
            }),
          ],
        }),
      ],
    });

    const direct = await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityId}/publish`)
      .set('Authorization', creatorAuth)
      .send({ requiresInsuranceConfirmed: true });
    expectBizError(direct, BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING);

    const approved = await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${rebuilt.body.data.id}/approve`)
      .set('Authorization', reviewerAuth)
      .send({
        requiresInsuranceConfirmed: true,
        operationKey: 'batch3-2-approve-0001',
      });
    expect(approved.status).toBe(200);
    const approveReplay = await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${rebuilt.body.data.id}/approve`)
      .set('Authorization', reviewerAuth)
      .send({
        requiresInsuranceConfirmed: true,
        operationKey: 'batch3-2-approve-0001',
      });
    expect(approveReplay.body.data.id).toBe(rebuilt.body.data.id);
    const approveConflict = await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${rebuilt.body.data.id}/approve`)
      .set('Authorization', reviewerAuth)
      .send({
        requiresInsuranceConfirmed: true,
        operationKey: 'batch3-2-approve-0001',
        reviewNote: '同 key 的另一审核内容',
      });
    expect(approveConflict.status).toBe(409);
    await expect(
      prisma.activityRuleSnapshot.findMany({
        where: { activityId },
        select: { workflowRevision: true, templateVersionId: true, createdByReviewId: true },
      }),
    ).resolves.toEqual([
      {
        workflowRevision: 1,
        templateVersionId: null,
        createdByReviewId: rebuilt.body.data.id,
      },
    ]);
  });

  it('rejects stale change proposals and leaves critical published fields behind review', async () => {
    // P2-14 刀 A:coverImageUrl / galleryImageUrls 从本闭集移出。
    // ⚠️ 这**不是**「已发布活动不能再改封面」——它们已不是 UpdateActivityDto 的字段,
    // 改封面走 PUT :id/cover(该端点刻意不加状态闸,逐字保留原先的可直改行为)。
    expect(PUBLISHED_ACTIVITY_DISPLAY_FIELDS).toEqual([
      'description',
      'registrationNotes',
      'content',
    ]);
    for (const criticalField of [
      'title',
      'startAt',
      'endAt',
      'capacity',
      'statusCode',
      'organizationId',
      'templateVersionId',
    ]) {
      expect(PUBLISHED_ACTIVITY_DISPLAY_FIELDS as readonly string[]).not.toContain(criticalField);
    }
    const { activityId, sessionId } = await createDraftWithLiveSession();
    const initial = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/publish-reviews`)
      .set('Authorization', creatorAuth)
      .send({ operationKey: 'batch3-2-initial-0002', confirmation: true });
    expect(initial.status).toBe(200);
    await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${initial.body.data.id}/approve`)
      .set('Authorization', reviewerAuth)
      .send({ requiresInsuranceConfirmed: true, operationKey: 'batch3-2-approve-0002' })
      .expect(200);

    const display = await request(httpServer(app))
      .patch(`/api/app/v1/my/managed-activities/${activityId}`)
      .set('Authorization', creatorAuth)
      .send({ description: '已发布活动的展示说明' });
    expect(display.status).toBe(200);
    const title = await request(httpServer(app))
      .patch(`/api/app/v1/my/managed-activities/${activityId}`)
      .set('Authorization', creatorAuth)
      .send({ title: '已发布活动的展示标题' });
    expectBizError(title, BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED);
    const critical = await request(httpServer(app))
      .patch(`/api/app/v1/my/managed-activities/${activityId}`)
      .set('Authorization', creatorAuth)
      .send({ capacity: 99 });
    expectBizError(critical, BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED);

    const crossOrganization = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/change-reviews`)
      .set('Authorization', creatorAuth)
      .send({
        operationKey: 'batch3-2-change-cross-organization-0001',
        confirmation: true,
        activityPatch: { organizationId: 'another-organization-id' },
        sessions: { create: [], update: [], cancel: [] },
        positions: { create: [], update: [], cancel: [] },
      });
    expectBizError(crossOrganization, BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);

    const proposal = {
      operationKey: 'batch3-2-change-0001',
      confirmation: true,
      activityPatch: { title: '提案内标题' },
      sessions: {
        create: [],
        update: [{ sessionId, locationText: '提案内会场' }],
        cancel: [],
      },
      positions: { create: [], update: [], cancel: [] },
    };
    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/change-reviews`)
      .set('Authorization', creatorAuth)
      .send(proposal);
    expect(submitted.status).toBe(200);
    const replay = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/change-reviews`)
      .set('Authorization', creatorAuth)
      .send(proposal);
    expect(replay.body.data.id).toBe(submitted.body.data.id);
    const conflict = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/change-reviews`)
      .set('Authorization', creatorAuth)
      .send({ ...proposal, activityPatch: { title: '相同 key 的另一份提案' } });
    expect(conflict.status).toBe(409);

    await prisma.activity.update({
      where: { id: activityId },
      data: { description: '审批前的越带修改' },
    });
    const stale = await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${submitted.body.data.id}/approve`)
      .set('Authorization', reviewerAuth)
      .send({ requiresInsuranceConfirmed: true, operationKey: 'batch3-2-approve-stale' });
    expectBizError(stale, BizCode.ACTIVITY_PUBLISH_REVIEW_EXPECTED_SNAPSHOT_MISMATCH);
  });

  it('applies one complete session/position collection proposal and exposes its full review detail', async () => {
    const { activityId, sessionId } = await createDraftWithLiveSession();
    const updatedPositionId = await createSessionPosition(activityId, sessionId, 'update');
    const cancelledPositionId = await createSessionPosition(activityId, sessionId, 'cancel');
    const cancelledSessionId = await createLiveSession(activityId, 'cancel');

    const initial = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/publish-reviews`)
      .set('Authorization', creatorAuth)
      .send({ operationKey: 'batch3-2-initial-0003', confirmation: true })
      .expect(200);
    await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${initial.body.data.id}/approve`)
      .set('Authorization', reviewerAuth)
      .send({ requiresInsuranceConfirmed: true, operationKey: 'batch3-2-approve-0003' })
      .expect(200);

    const ambiguousSessionRef = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/change-reviews`)
      .set('Authorization', creatorAuth)
      .send({
        operationKey: 'batch3-2-change-ambiguous-session-ref-0003',
        confirmation: true,
        activityPatch: { title: '不得把 clientRef 撞到既有 sessionId' },
        sessions: {
          create: [
            {
              clientRef: sessionId,
              code: 'ambiguous-session-0003',
              name: '不应接受的歧义新场次',
              startAt: '2099-08-01T01:00:00.000Z',
              endAt: '2099-08-01T05:00:00.000Z',
              locationText: '歧义会场',
              checkInOpenAt: '2099-08-01T00:30:00.000Z',
              checkInCloseAt: '2099-08-01T02:00:00.000Z',
              checkOutOpenAt: '2099-08-01T03:00:00.000Z',
              checkOutCloseAt: '2099-08-01T05:00:00.000Z',
              locationRequired: false,
            },
          ],
          update: [],
          cancel: [],
        },
        positions: {
          create: [
            {
              sessionId,
              code: 'ambiguous-position-0003',
              name: '不应挂到旧场次',
              attendanceRoleCode,
              capacity: 1,
              startAt: '2099-08-01T01:30:00.000Z',
              endAt: '2099-08-01T04:30:00.000Z',
            },
          ],
          update: [],
          cancel: [],
        },
      });
    expectBizError(ambiguousSessionRef, BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);

    const createdSessionRef = 'batch3-new-session-0003';
    const change = {
      operationKey: 'batch3-2-change-0003',
      confirmation: true,
      activityPatch: { title: '完整集合提案后的活动标题' },
      sessions: {
        create: [
          {
            clientRef: createdSessionRef,
            code: 'new-session-0003',
            name: '提案新增场次',
            startAt: '2099-08-01T01:00:00.000Z',
            endAt: '2099-08-01T05:00:00.000Z',
            locationText: '提案新增会场',
            checkInOpenAt: '2099-08-01T00:30:00.000Z',
            checkInCloseAt: '2099-08-01T02:00:00.000Z',
            checkOutOpenAt: '2099-08-01T03:00:00.000Z',
            checkOutCloseAt: '2099-08-01T05:00:00.000Z',
            locationRequired: false,
          },
        ],
        update: [{ sessionId, name: '提案更新主场次' }],
        cancel: [{ sessionId: cancelledSessionId }],
      },
      positions: {
        create: [
          {
            sessionId: createdSessionRef,
            code: 'new-position-0003',
            name: '提案新增岗位',
            attendanceRoleCode,
            capacity: 2,
            startAt: '2099-08-01T01:30:00.000Z',
            endAt: '2099-08-01T04:30:00.000Z',
          },
        ],
        update: [{ sessionId, positionId: updatedPositionId, name: '提案更新岗位' }],
        cancel: [{ sessionId, positionId: cancelledPositionId }],
      },
    };
    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/change-reviews`)
      .set('Authorization', creatorAuth)
      .send(change)
      .expect(200);

    const detail = await request(httpServer(app))
      .get(`/api/admin/v1/activity-publish-reviews/${submitted.body.data.id}`)
      .set('Authorization', reviewerAuth)
      .expect(200);
    expect(detail.body.data).toMatchObject({
      id: submitted.body.data.id,
      snapshot: expect.objectContaining({ schemaVersion: 6 }),
      changeDiff: expect.objectContaining({
        kind: 'proposal-v6',
        activityFields: expect.arrayContaining(['title']),
        sessions: expect.objectContaining({
          create: expect.arrayContaining([expect.objectContaining({ code: 'new-session-0003' })]),
        }),
      }),
      affectedMemberCount: 0,
    });

    await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${submitted.body.data.id}/approve`)
      .set('Authorization', reviewerAuth)
      .send({ requiresInsuranceConfirmed: true, operationKey: 'batch3-2-approve-0003-change' })
      .expect(200);

    const [
      activity,
      updatedSession,
      cancelledSession,
      createdSession,
      updatedPosition,
      cancelledPosition,
    ] = await Promise.all([
      prisma.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: { title: true, workflowRevision: true },
      }),
      prisma.activitySession.findUniqueOrThrow({
        where: { id: sessionId },
        select: { name: true },
      }),
      prisma.activitySession.findUniqueOrThrow({
        where: { id: cancelledSessionId },
        select: { statusCode: true },
      }),
      prisma.activitySession.findFirstOrThrow({
        where: { activityId, code: 'new-session-0003', deletedAt: null },
        select: { id: true, statusCode: true },
      }),
      prisma.activitySessionPosition.findUniqueOrThrow({
        where: { id: updatedPositionId },
        select: { name: true },
      }),
      prisma.activitySessionPosition.findUniqueOrThrow({
        where: { id: cancelledPositionId },
        select: { deletedAt: true },
      }),
    ]);
    expect(activity).toEqual({ title: '完整集合提案后的活动标题', workflowRevision: 2 });
    expect(updatedSession).toEqual({ name: '提案更新主场次' });
    expect(cancelledSession).toEqual({ statusCode: 'cancelled' });
    expect(createdSession.statusCode).toBe('scheduled');
    expect(updatedPosition).toEqual({ name: '提案更新岗位' });
    expect(cancelledPosition.deletedAt).toEqual(expect.any(Date));
    await expect(
      prisma.activitySessionPosition.findFirst({
        where: { sessionId: createdSession.id, code: 'new-position-0003', deletedAt: null },
        select: { name: true },
      }),
    ).resolves.toEqual({ name: '提案新增岗位' });
    await expect(
      prisma.activityRuleSnapshot.findMany({
        where: { activityId },
        orderBy: { workflowRevision: 'asc' },
        select: { workflowRevision: true, createdByReviewId: true },
      }),
    ).resolves.toEqual([
      { workflowRevision: 1, createdByReviewId: initial.body.data.id },
      { workflowRevision: 2, createdByReviewId: submitted.body.data.id },
    ]);
  });

  it('makes return idempotent and rejects a SUPER_ADMIN reviewing their own proposal', async () => {
    const { activityId } = await createDraftWithLiveSession();
    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/publish-reviews`)
      .set('Authorization', creatorAuth)
      .send({ operationKey: 'batch3-2-initial-0004', confirmation: true })
      .expect(200);

    const selfApprove = await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${submitted.body.data.id}/approve`)
      .set('Authorization', creatorAuth)
      .send({ requiresInsuranceConfirmed: true, operationKey: 'batch3-2-self-approve-0004' });
    expectBizError(selfApprove, BizCode.ACTIVITY_PUBLISH_REVIEW_SELF_REVIEW_FORBIDDEN);

    const returnPayload = {
      reviewNote: '请补充发布说明',
      operationKey: 'batch3-2-return-0004',
    };
    const returned = await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${submitted.body.data.id}/return`)
      .set('Authorization', reviewerAuth)
      .send(returnPayload)
      .expect(200);
    expect(returned.body.data).toMatchObject({ id: submitted.body.data.id, status: 'returned' });
    const replay = await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${submitted.body.data.id}/return`)
      .set('Authorization', reviewerAuth)
      .send(returnPayload)
      .expect(200);
    expect(replay.body.data.id).toBe(submitted.body.data.id);
    const conflict = await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${submitted.body.data.id}/return`)
      .set('Authorization', reviewerAuth)
      .send({ ...returnPayload, reviewNote: '同 key 的另一条打回说明' });
    expectBizError(conflict, BizCode.ACTIVITY_PUBLISH_REVIEW_OPERATION_KEY_CONFLICT);
  });

  it('reports template as a distinct resolution source', async () => {
    const legacyTemplate = await prisma.activityTemplate.create({
      data: {
        code: 'batch3-slice2-template-source',
        name: '第 3 批模板来源',
        activityTypeCode,
        statusCode: 'active',
        version: 1,
        defaultRegistrationModeCode: 'template_registration',
      },
    });
    const { activityId } = await createDraftWithLiveSession();

    const resolution = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${activityId}/template-resolution`)
      .set('Authorization', creatorAuth)
      .expect(200);
    expect(resolution.body.data).toMatchObject({
      templateVersionId: legacyTemplate.id,
      activity: {
        registrationModeCode: {
          value: 'template_registration',
          source: 'template',
        },
      },
    });
  });

  it('keeps an explicitly selected retired future Version across the read and proposal projections', async () => {
    sequence += 1;
    const fixture = `batch3-slice2-a5-${sequence}`;
    const selectedDefinition = { kind: 'a5-selected-template', revision: sequence };
    const { selectedTemplate, newerLegacyTemplate } = await prisma.$transaction(async (tx) => {
      const family = await tx.activityTemplateFamily.create({
        data: {
          code: `${fixture}-family`,
          name: 'A5 显式选择模板族',
          categoryCode: 'volunteer',
          scopeTypeCode: 'organization',
          statusCode: 'active',
        },
      });
      const draft = await tx.activityTemplate.create({
        data: {
          code: `${fixture}-selected`,
          name: 'A5 已选 future Version',
          activityTypeCode,
          statusCode: 'draft',
          version: 1,
          familyId: family.id,
          schemaVersion: 1,
          definitionJson: selectedDefinition,
          definitionHash: computeActivityTemplateDefinitionHash({
            schemaVersion: 1,
            definition: selectedDefinition,
          }),
          effectiveFrom: new Date('2099-07-01T00:00:00.000Z'),
          defaultRegistrationModeCode: 'a5_selected_registration',
          defaultArchiveWaitingDays: 19,
        },
      });
      await tx.activityTemplate.update({
        where: { id: draft.id },
        data: { statusCode: 'active' },
      });
      const selectedTemplate = await tx.activityTemplate.update({
        where: { id: draft.id },
        data: { statusCode: 'retired' },
      });
      const newerLegacyTemplate = await tx.activityTemplate.create({
        data: {
          code: `${fixture}-newer-legacy`,
          name: 'A5 更新的 legacy active 模板',
          activityTypeCode,
          statusCode: 'active',
          version: 100_000 + sequence,
          defaultRegistrationModeCode: 'a5_newer_legacy_registration',
          defaultArchiveWaitingDays: 31,
        },
      });
      return { selectedTemplate, newerLegacyTemplate };
    });
    const { activityId } = await createDraftWithLiveSession();
    await prisma.activity.update({
      where: { id: activityId },
      data: { selectedTemplateVersionId: selectedTemplate.id },
    });

    const resolution = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${activityId}/template-resolution`)
      .set('Authorization', creatorAuth)
      .expect(200);
    expect(resolution.body.data).toMatchObject({
      templateVersionId: selectedTemplate.id,
      activity: {
        registrationModeCode: { value: 'a5_selected_registration', source: 'template' },
      },
    });
    expect(resolution.body.data.templateVersionId).not.toBe(newerLegacyTemplate.id);

    const initial = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/publish-reviews`)
      .set('Authorization', creatorAuth)
      .send({ operationKey: 'batch3-2-a5-initial-0001', confirmation: true })
      .expect(200);
    expect(initial.body.data.snapshot).toMatchObject({
      templateVersionId: selectedTemplate.id,
      resolvedConfig: {
        templateVersionId: selectedTemplate.id,
        activity: {
          registrationModeCode: { value: 'a5_selected_registration', source: 'template' },
        },
      },
    });

    await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${initial.body.data.id}/approve`)
      .set('Authorization', reviewerAuth)
      .send({ requiresInsuranceConfirmed: true, operationKey: 'batch3-2-a5-approve-0001' })
      .expect(200);
    const ruleSnapshot = await prisma.activityRuleSnapshot.findFirstOrThrow({
      where: { activityId, createdByReviewId: initial.body.data.id },
      select: { templateVersionId: true, resolvedConfig: true },
    });
    expect(ruleSnapshot.templateVersionId).toBe(selectedTemplate.id);
    expect(ruleSnapshot.resolvedConfig).toMatchObject({
      templateVersionId: selectedTemplate.id,
      activity: {
        registrationModeCode: { value: 'a5_selected_registration', source: 'template' },
      },
    });

    const change = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/change-reviews`)
      .set('Authorization', creatorAuth)
      .send({
        operationKey: 'batch3-2-a5-change-0001',
        confirmation: true,
        activityPatch: { registrationNotes: 'A5 显式模板只读投影回归' },
        sessions: { create: [], update: [], cancel: [] },
        positions: { create: [], update: [], cancel: [] },
      })
      .expect(200);
    expect(change.body.data.snapshot).toMatchObject({
      templateVersionId: selectedTemplate.id,
      resolvedConfig: {
        templateVersionId: selectedTemplate.id,
        activity: {
          registrationModeCode: { value: 'a5_selected_registration', source: 'template' },
        },
      },
    });
  });
});
