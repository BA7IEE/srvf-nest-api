import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, PrincipalType, Role, UserStatus } from '@prisma/client';
import request from 'supertest';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityPublishReviewService } from '../../src/modules/activities/activity-publish-review.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const AUDIT_META = { requestId: 'activity-review-e2e', ip: null, ua: null };

describe('activity responsibility workflow gate=true publish review', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reviewService: ActivityPublishReviewService;
  let creatorAuth: string;
  let delegatedCreatorAuth: string;
  let reviewerAuth: string;
  let creatorPayload: CurrentUserPayload;
  let organizationId: string;
  let outsideOrganizationId: string;
  let activityTypeCode: string;
  let attendanceRoleCode: string;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    reviewService = app.get(ActivityPublishReviewService);

    const reviewer = await createTestUser(app, {
      username: 'activity-review-super-admin',
      role: Role.USER,
    });
    const creator = await createTestUser(app, {
      username: 'activity-review-creator',
      role: Role.ADMIN,
    });
    const delegatedCreator = await createTestUser(app, {
      username: 'activity-review-delegated-sa',
      role: Role.SUPER_ADMIN,
    });
    const creatorMember = await prisma.member.create({
      data: {
        memberNo: 'activity-review-creator-member',
        displayName: '活动审核发起人',
        gradeCode: 'level-3',
      },
      select: { id: true },
    });
    await prisma.user.update({
      where: { id: creator.id },
      data: { memberId: creatorMember.id },
    });

    const bizAdmin = await seedBizAdminPermissionsAndRole(app);
    await seedActivityResponsibilitySystemRoles(app);
    await grantBizAdminToUser(app, creator.id, bizAdmin.bizAdminRoleId);

    const root = await prisma.organization.create({
      data: { name: '活动审核根组织', nodeTypeCode: 'activity-review-root' },
      select: { id: true },
    });
    const organization = await prisma.organization.create({
      data: {
        name: '活动审核执行组织',
        nodeTypeCode: 'activity-review-team',
        parentId: root.id,
      },
      select: { id: true },
    });
    organizationId = organization.id;
    const outsideOrganization = await prisma.organization.create({
      data: {
        name: '活动审核范围外组织',
        nodeTypeCode: 'activity-review-team',
        parentId: root.id,
      },
      select: { id: true },
    });
    outsideOrganizationId = outsideOrganization.id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: root.id, descendantId: root.id, depth: 0 },
        { ancestorId: root.id, descendantId: organization.id, depth: 1 },
        { ancestorId: root.id, descendantId: outsideOrganization.id, depth: 1 },
        { ancestorId: organization.id, descendantId: organization.id, depth: 0 },
        {
          ancestorId: outsideOrganization.id,
          descendantId: outsideOrganization.id,
          depth: 0,
        },
      ],
    });
    await prisma.memberOrganizationMembership.create({
      data: { memberId: creatorMember.id, organizationId },
    });

    const activityType = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    activityTypeCode = 'activity-review-training';
    await prisma.dictItem.create({
      data: {
        typeId: activityType.id,
        code: activityTypeCode,
        label: '发布审核训练',
      },
    });
    const attendanceRole = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    attendanceRoleCode = 'activity-review-member';
    await prisma.dictItem.create({
      data: {
        typeId: attendanceRole.id,
        code: attendanceRoleCode,
        label: '活动成员',
      },
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
      data: {
        code: 'activity-review-e2e-reviewer',
        displayName: '活动发布审核员测试角色',
      },
      select: { id: true },
    });
    const reviewerPermissions = await prisma.permission.findMany({
      where: {
        code: {
          in: [
            'activity-review.read.request',
            'activity.publish.record',
            'activity-review.return.request',
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
    delegatedCreatorAuth = (await loginAs(app, delegatedCreator.username)).authHeader;
    reviewerAuth = (await loginAs(app, reviewer.username)).authHeader;
    creatorPayload = {
      id: creator.id,
      username: creator.username,
      role: creator.role,
      status: UserStatus.ACTIVE,
      memberId: creatorMember.id,
    };
  });

  afterAll(async () => {
    await app.close();
    if (previousGate === undefined) {
      delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousGate;
    }
  });

  function createPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    sequence += 1;
    return {
      title: `发布审核活动 ${sequence}`,
      activityTypeCode,
      organizationId,
      startAt: '2099-08-01T01:00:00.000Z',
      endAt: '2099-08-01T05:00:00.000Z',
      registrationDeadline: '2099-07-31T12:00:00.000Z',
      location: '深圳',
      ...overrides,
    };
  }

  async function createActivity(): Promise<string> {
    const response = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', creatorAuth)
      .send(createPayload());
    expect(response.status).toBe(201);
    expect(response.body.data.initiatorMemberId).toBe(creatorPayload.memberId);
    expect(response.body.data.workflowRevision).toBe(0);
    return response.body.data.id as string;
  }

  async function workflowWriteCounts() {
    const [activities, publishReviews, responsibilities, roleBindings, audits] = await Promise.all([
      prisma.activity.count(),
      prisma.activityPublishReview.count(),
      prisma.activityResponsibilityAssignment.count(),
      prisma.roleBinding.count(),
      prisma.auditLog.count(),
    ]);
    return { activities, publishReviews, responsibilities, roleBindings, audits };
  }

  it('formal member creates draft; pending review freezes activity/positions; reviewer returns then approves v2', async () => {
    const activityId = await createActivity();
    const position = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activityId}/positions`)
      .set('Authorization', creatorAuth)
      .send({
        name: '后勤',
        attendanceRoleCode,
        capacity: 10,
        sortOrder: 1,
      });
    expect(position.status).toBe(201);

    const first = await reviewService.submitInitial(activityId, creatorPayload, AUDIT_META);
    expect(first).toMatchObject({
      activityId,
      requestType: 'initial',
      requestVersion: 1,
      baseRevision: 0,
      status: 'pending',
      directPublish: false,
    });
    expect(first.snapshot).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        activity: expect.not.objectContaining({ activityPositions: expect.anything() }),
        positions: [
          expect.objectContaining({
            activityPositionId: position.body.data.activityPositionId,
            clientRef: null,
            name: '后勤',
          }),
        ],
      }),
    );

    const frozenActivity = await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityId}`)
      .set('Authorization', creatorAuth)
      .send({ title: '不应直接修改' });
    expectBizError(frozenActivity, BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING);
    const frozenPosition = await request(httpServer(app))
      .patch(
        `/api/admin/v1/activities/${activityId}/positions/${position.body.data.activityPositionId}`,
      )
      .set('Authorization', creatorAuth)
      .send({ name: '不应直接修改岗位' });
    expectBizError(frozenPosition, BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING);
    const frozenDelete = await request(httpServer(app))
      .delete(`/api/admin/v1/activities/${activityId}`)
      .set('Authorization', creatorAuth);
    expectBizError(frozenDelete, BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING);

    const outsideActivity = await prisma.activity.create({
      data: {
        title: '范围外待审核活动',
        activityTypeCode,
        organizationId: outsideOrganizationId,
        initiatorMemberId: creatorPayload.memberId,
        startAt: new Date('2099-08-02T01:00:00.000Z'),
        endAt: new Date('2099-08-02T05:00:00.000Z'),
        location: '深圳',
        statusCode: 'draft',
      },
      select: { id: true },
    });
    const outsideReview = await reviewService.submitInitial(
      outsideActivity.id,
      creatorPayload,
      AUDIT_META,
    );
    const list = await request(httpServer(app))
      .get('/api/admin/v1/activity-publish-reviews?status=pending')
      .set('Authorization', reviewerAuth);
    expect(list.status).toBe(200);
    expect(list.body.data.items).toEqual([
      expect.objectContaining({ id: first.id, activityId, status: 'pending' }),
    ]);
    const outsideDetail = await request(httpServer(app))
      .get(`/api/admin/v1/activity-publish-reviews/${outsideReview.id}`)
      .set('Authorization', reviewerAuth);
    expectBizError(outsideDetail, BizCode.RBAC_FORBIDDEN);
    const detail = await request(httpServer(app))
      .get(`/api/admin/v1/activity-publish-reviews/${first.id}`)
      .set('Authorization', reviewerAuth);
    expect(detail.status).toBe(200);
    expect(detail.body.data.id).toBe(first.id);

    const returned = await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${first.id}/return`)
      .set('Authorization', reviewerAuth)
      .send({ reviewNote: '补充安全说明' });
    expect(returned.status).toBe(200);
    expect(returned.body.data).toMatchObject({
      status: 'returned',
      reviewNote: '补充安全说明',
    });

    const edit = await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityId}`)
      .set('Authorization', creatorAuth)
      .send({ title: '补充说明后的活动', organizationId });
    expect(edit.status).toBe(200);
    const second = await reviewService.submitInitial(activityId, creatorPayload, AUDIT_META);
    expect(second).toMatchObject({ requestVersion: 2, status: 'pending', baseRevision: 0 });

    const approved = await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${second.id}/approve`)
      .set('Authorization', reviewerAuth)
      .send({ requiresInsuranceConfirmed: true, reviewNote: '同意发布' });
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({
      id: second.id,
      status: 'approved',
      reviewNote: '同意发布',
    });
    const activity = await prisma.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: { statusCode: true, workflowRevision: true, publishedBy: true },
    });
    expect(activity).toEqual({
      statusCode: 'published',
      workflowRevision: 1,
      publishedBy: expect.any(String),
    });
    await expect(
      prisma.activityResponsibilityAssignment.findFirstOrThrow({
        where: { activityId, responsibilityType: 'owner', status: 'active' },
        select: { memberId: true, assignedByUserId: true, source: true },
      }),
    ).resolves.toEqual({
      memberId: creatorPayload.memberId,
      assignedByUserId: expect.any(String),
      source: 'publish',
    });

    const publishedEdit = await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityId}`)
      .set('Authorization', creatorAuth)
      .send({ title: '已发布不可直改' });
    expectBizError(publishedEdit, BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED);
    const publishedPositionEdit = await request(httpServer(app))
      .patch(
        `/api/admin/v1/activities/${activityId}/positions/${position.body.data.activityPositionId}`,
      )
      .set('Authorization', creatorAuth)
      .send({ name: '已发布岗位不可直改' });
    expectBizError(publishedPositionEdit, BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED);
  });

  it('legacy publish direct-publishes only the initiator with publish scope', async () => {
    const activityId = await createActivity();
    const response = await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityId}/publish`)
      .set('Authorization', creatorAuth)
      .send({ requiresInsuranceConfirmed: true });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: activityId,
      statusCode: 'published',
      workflowRevision: 1,
    });
    const review = await prisma.activityPublishReview.findFirstOrThrow({
      where: { activityId },
    });
    expect(review).toMatchObject({
      requestType: 'initial',
      requestVersion: 1,
      status: 'approved',
      directPublish: true,
      submittedByUserId: creatorPayload.id,
      reviewedByUserId: creatorPayload.id,
    });
    await expect(
      prisma.activityResponsibilityAssignment.findFirstOrThrow({
        where: { activityId, responsibilityType: 'owner', status: 'active' },
        select: { memberId: true, assignedByUserId: true },
      }),
    ).resolves.toEqual({
      memberId: creatorPayload.memberId,
      assignedByUserId: creatorPayload.id,
    });
  });

  it('legacy publish approves the current pending initial review when actor has review scope', async () => {
    const activityId = await createActivity();
    const review = await reviewService.submitInitial(activityId, creatorPayload, AUDIT_META);
    const response = await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityId}/publish`)
      .set('Authorization', reviewerAuth)
      .send({ requiresInsuranceConfirmed: true });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: activityId,
      statusCode: 'published',
      workflowRevision: 1,
    });
    await expect(
      prisma.activityPublishReview.findUniqueOrThrow({
        where: { id: review.id },
        select: { status: true, reviewNote: true },
      }),
    ).resolves.toEqual({ status: 'approved', reviewNote: null });
  });

  it('revalidates the server snapshot under lock before approval', async () => {
    const activityId = await createActivity();
    const review = await reviewService.submitInitial(activityId, creatorPayload, AUDIT_META);
    await prisma.activity.update({
      where: { id: activityId },
      data: { title: '模拟绕过服务层的快照漂移' },
    });
    const response = await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${review.id}/approve`)
      .set('Authorization', reviewerAuth)
      .send({ requiresInsuranceConfirmed: true });
    expectBizError(response, BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    await expect(
      prisma.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: { statusCode: true, workflowRevision: true },
      }),
    ).resolves.toEqual({ statusCode: 'draft', workflowRevision: 0 });
  });

  it('rejects approval when a pending change snapshot is tampered to another organization', async () => {
    const activityId = await createActivity();
    await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityId}/publish`)
      .set('Authorization', creatorAuth)
      .send({ requiresInsuranceConfirmed: true })
      .expect(200);
    const review = await reviewService.submitChange(
      activityId,
      { title: 'Legitimate same-organization proposal', organizationId },
      undefined,
      creatorPayload,
      AUDIT_META,
    );
    const storedReview = await prisma.activityPublishReview.findUniqueOrThrow({
      where: { id: review.id },
      select: { snapshot: true },
    });
    const tamperedSnapshot = JSON.parse(JSON.stringify(storedReview.snapshot)) as {
      activity: { organizationId: string };
    };
    tamperedSnapshot.activity.organizationId = outsideOrganizationId;
    await prisma.activityPublishReview.update({
      where: { id: review.id },
      data: { snapshot: tamperedSnapshot },
    });

    const response = await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${review.id}/approve`)
      .set('Authorization', reviewerAuth)
      .send({ requiresInsuranceConfirmed: true });

    expectBizError(response, BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    await expect(
      prisma.activityPublishReview.findUniqueOrThrow({
        where: { id: review.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: 'pending' });
    await expect(
      prisma.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: { organizationId: true, workflowRevision: true, title: true },
      }),
    ).resolves.toEqual({
      organizationId,
      workflowRevision: 1,
      title: expect.stringContaining('发布审核活动'),
    });
  });

  it('does not create an initial review for an already ended activity', async () => {
    const response = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', creatorAuth)
      .send(
        createPayload({
          startAt: '2020-01-01T01:00:00.000Z',
          endAt: '2020-01-01T05:00:00.000Z',
          registrationDeadline: '2019-12-31T12:00:00.000Z',
        }),
      );
    expect(response.status).toBe(201);
    const activityId = response.body.data.id as string;
    await expect(
      reviewService.submitInitial(activityId, creatorPayload, AUDIT_META),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_STATUS_INVALID });
    await expect(prisma.activityPublishReview.count({ where: { activityId } })).resolves.toBe(0);
  });

  it('activity cancellation transitions its pending review in the same transaction', async () => {
    const activityId = await createActivity();
    const review = await reviewService.submitInitial(activityId, creatorPayload, AUDIT_META);
    const response = await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityId}/cancel`)
      .set('Authorization', creatorAuth)
      .send({ cancelReason: '计划调整' });
    expect(response.status).toBe(200);
    await expect(
      prisma.activityPublishReview.findUniqueOrThrow({
        where: { id: review.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: 'cancelled' });
  });

  it.each([
    { label: 'missing', status: null, deletedAt: null },
    { label: 'DISABLED', status: UserStatus.DISABLED, deletedAt: null },
    { label: 'soft-deleted', status: UserStatus.ACTIVE, deletedAt: new Date() },
  ])(
    'rejects delegated creation when the formal initiator User is $label with zero workflow writes',
    async ({ label, status, deletedAt }) => {
      sequence += 1;
      const member = await prisma.member.create({
        data: {
          memberNo: `delegated-${label}-${sequence}`,
          displayName: `Delegated ${label} ${sequence}`,
          gradeCode: 'level-3',
        },
        select: { id: true },
      });
      await prisma.memberOrganizationMembership.create({
        data: { memberId: member.id, organizationId },
      });
      if (status !== null) {
        const linkedUser = await createTestUser(app, {
          username: `delegated-${label}-${sequence}`,
          status,
          deletedAt,
        });
        await prisma.user.update({
          where: { id: linkedUser.id },
          data: { memberId: member.id },
        });
      }
      const before = await workflowWriteCounts();

      const response = await request(httpServer(app))
        .post('/api/admin/v1/activities')
        .set('Authorization', delegatedCreatorAuth)
        .send(createPayload({ initiatorMemberId: member.id }));

      expectBizError(response, BizCode.ACTIVITY_INITIATOR_NOT_FORMAL);
      await expect(workflowWriteCounts()).resolves.toEqual(before);
    },
  );

  it('rejects a non-formal initiator and a formal initiator outside own organizations', async () => {
    const nonFormal = await createTestUser(app, {
      username: `activity-review-nonformal-${sequence}`,
      role: Role.ADMIN,
    });
    const bizAdmin = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, nonFormal.id, bizAdmin.bizAdminRoleId);
    const nonFormalAuth = (await loginAs(app, nonFormal.username)).authHeader;
    const noMember = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', nonFormalAuth)
      .send(createPayload());
    expectBizError(noMember, BizCode.ACTIVITY_INITIATOR_NOT_FORMAL);

    const otherRoot = await prisma.organization.create({
      data: { name: `其他根组织 ${sequence}`, nodeTypeCode: 'activity-review-root' },
      select: { id: true },
    });
    const other = await prisma.organization.create({
      data: {
        name: `其他执行组织 ${sequence}`,
        nodeTypeCode: 'activity-review-team',
        parentId: otherRoot.id,
      },
      select: { id: true },
    });
    const crossOrg = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', creatorAuth)
      .send(createPayload({ organizationId: other.id }));
    expectBizError(crossOrg, BizCode.ACTIVITY_INITIATION_ORG_FORBIDDEN);
  });
});
