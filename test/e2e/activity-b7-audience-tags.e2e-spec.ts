import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

describe('activity B7 audience tags over real Admin/System HTTP', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let memberId: string;
  let tagCode: string;
  let audienceTagTypeId: string;
  let organizationId: string;
  let activityTypeCode: string;
  const previousHttpEnabled = process.env.ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED = 'true';
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);

    const superAdmin = await createTestUser(app, {
      username: 'b7-audience-tags-sa',
      role: Role.SUPER_ADMIN,
    });
    superAdminAuth = (await loginAs(app, superAdmin.username)).authHeader;
    memberId = (
      await prisma.member.create({
        data: {
          memberNo: 'activity-b7-audience-tags-member',
          ...memberIdentityData('B7 audience tag member'),
        },
        select: { id: true },
      })
    ).id;

    const root = await prisma.organization.create({
      data: { name: 'B7 受众标签根组织', nodeTypeCode: 'b7-audience-root' },
      select: { id: true },
    });
    const organization = await prisma.organization.create({
      data: {
        name: 'B7 受众标签执行组织',
        nodeTypeCode: 'b7-audience-team',
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

    const activityType = await request(httpServer(app))
      .post('/api/system/v1/dict-types')
      .set('Authorization', superAdminAuth)
      .send({ code: 'activity_type', label: '活动类型', sortOrder: 0 });
    expect(activityType.status).toBe(201);
    activityTypeCode = 'b7-audience-activity';
    const activityTypeItem = await request(httpServer(app))
      .post('/api/system/v1/dict-items')
      .set('Authorization', superAdminAuth)
      .send({
        typeId: activityType.body.data.id,
        code: activityTypeCode,
        label: 'B7 受众标签活动',
        sortOrder: 0,
      });
    expect(activityTypeItem.status).toBe(201);
  });

  afterAll(async () => {
    await app.close();
    if (previousHttpEnabled === undefined) {
      delete process.env.ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED;
    } else {
      process.env.ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED = previousHttpEnabled;
    }
  });

  it('creates a tag through System HTTP, then replaces and reads member tags through Admin HTTP', async () => {
    const type = await request(httpServer(app))
      .post('/api/system/v1/dict-types')
      .set('Authorization', superAdminAuth)
      .send({ code: 'member_audience_tag', label: '会员受众标签', sortOrder: 0 });
    expect(type.status).toBe(201);
    audienceTagTypeId = type.body.data.id as string;

    tagCode = 'b7-rescue';
    const tag = await request(httpServer(app))
      .post('/api/system/v1/dict-items')
      .set('Authorization', superAdminAuth)
      .send({ typeId: audienceTagTypeId, code: tagCode, label: '救援通知', sortOrder: 3 });
    expect(tag.status).toBe(201);

    const replaced = await request(httpServer(app))
      .put(`/api/admin/v1/members/${memberId}/audience-tags`)
      .set('Authorization', superAdminAuth)
      .send({ tagCodes: [tagCode] });
    expect(replaced.status).toBe(200);
    expect(replaced.body.data).toEqual({
      memberId,
      tags: [
        {
          code: tagCode,
          label: '救援通知',
          status: 'ACTIVE',
          sortOrder: 3,
        },
      ],
    });

    const read = await request(httpServer(app))
      .get(`/api/admin/v1/members/${memberId}/audience-tags`)
      .set('Authorization', superAdminAuth);
    expect(read.status).toBe(200);
    expect(read.body.data).toEqual(replaced.body.data);
  });

  it('publishes through the new B7 action with an empty tag set', async () => {
    const activity = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', superAdminAuth)
      .send({
        title: 'B7 空标签发布活动',
        activityTypeCode,
        organizationId,
        startAt: '2099-08-01T01:00:00.000Z',
        endAt: '2099-08-01T05:00:00.000Z',
        registrationDeadline: '2099-07-31T12:00:00.000Z',
        location: '深圳',
        allocationModeCode: 'first_come',
        isPublicRegistration: true,
      });
    expect(activity.status).toBe(201);

    const published = await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activity.body.data.id}/publish-with-audience-tags`)
      .set('Authorization', superAdminAuth)
      .send({ requiresInsuranceConfirmed: true, audienceTagCodes: [] });
    expect(published.status).toBe(200);
  });

  it('rejects a non-public activity before changing state or creating an intent', async () => {
    const activity = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', superAdminAuth)
      .send({
        title: 'B7 非公开活动',
        activityTypeCode,
        organizationId,
        startAt: '2099-08-01T06:00:00.000Z',
        endAt: '2099-08-01T10:00:00.000Z',
        registrationDeadline: '2099-07-31T17:00:00.000Z',
        location: '深圳',
        allocationModeCode: 'first_come',
        isPublicRegistration: false,
      });
    expect(activity.status).toBe(201);
    const activityId = activity.body.data.id as string;

    const rejected = await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityId}/publish-with-audience-tags`)
      .set('Authorization', superAdminAuth)
      .send({ requiresInsuranceConfirmed: true, audienceTagCodes: [] });
    expectBizError(rejected, BizCode.BAD_REQUEST);
    await expect(
      prisma.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: { statusCode: true, publishedAt: true },
      }),
    ).resolves.toEqual({ statusCode: 'draft', publishedAt: null });
    await expect(
      prisma.notificationOutboxIntent.count({
        where: { aggregateType: 'activity', aggregateId: activityId },
      }),
    ).resolves.toBe(0);
  });

  it('matches tag A OR tag B once, excludes inactive/soft-deleted members, and fixes the recipient snapshot', async () => {
    const tagBCode = 'b7-medical';
    const tagB = await request(httpServer(app))
      .post('/api/system/v1/dict-items')
      .set('Authorization', superAdminAuth)
      .send({ typeId: audienceTagTypeId, code: tagBCode, label: '医疗保障', sortOrder: 4 });
    expect(tagB.status).toBe(201);

    // 会员档案本身是测试基础数据；B7 的标签字典与每次赋标均必须经过真实 HTTP。
    const [tagBMember, bothTagsMember, inactiveMember, softDeletedMember] = await Promise.all([
      prisma.member.create({
        data: { memberNo: 'activity-b7-tag-b', ...memberIdentityData('B7 tag B member') },
        select: { id: true },
      }),
      prisma.member.create({
        data: { memberNo: 'activity-b7-tag-both', ...memberIdentityData('B7 both tags member') },
        select: { id: true },
      }),
      prisma.member.create({
        data: { memberNo: 'activity-b7-tag-inactive', ...memberIdentityData('B7 inactive member') },
        select: { id: true },
      }),
      prisma.member.create({
        data: { memberNo: 'activity-b7-tag-deleted', ...memberIdentityData('B7 deleted member') },
        select: { id: true },
      }),
    ]);
    const assignments = [
      [tagBMember.id, [tagBCode]],
      [bothTagsMember.id, [tagCode, tagBCode]],
      [inactiveMember.id, [tagCode]],
      [softDeletedMember.id, [tagCode]],
    ] as const;
    for (const [targetMemberId, tagCodes] of assignments) {
      const assigned = await request(httpServer(app))
        .put(`/api/admin/v1/members/${targetMemberId}/audience-tags`)
        .set('Authorization', superAdminAuth)
        .send({ tagCodes });
      expect(assigned.status).toBe(200);
    }
    await prisma.member.update({
      where: { id: inactiveMember.id },
      data: { status: 'INACTIVE' },
    });
    await prisma.member.update({
      where: { id: softDeletedMember.id },
      data: { deletedAt: new Date() },
    });

    const activity = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', superAdminAuth)
      .send({
        title: 'B7 双标签定向发布活动',
        activityTypeCode,
        organizationId,
        startAt: '2099-08-02T01:00:00.000Z',
        endAt: '2099-08-02T05:00:00.000Z',
        registrationDeadline: '2099-08-01T12:00:00.000Z',
        location: '深圳',
        allocationModeCode: 'first_come',
        isPublicRegistration: true,
      });
    expect(activity.status).toBe(201);
    const activityId = activity.body.data.id as string;

    const published = await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityId}/publish-with-audience-tags`)
      .set('Authorization', superAdminAuth)
      .send({ requiresInsuranceConfirmed: true, audienceTagCodes: [tagCode, tagBCode] });
    expect(published.status).toBe(200);
    const publishedAt = published.body.data.publishedAt as string;

    const intents = await prisma.notificationOutboxIntent.findMany({
      where: { aggregateType: 'activity', aggregateId: activityId },
      select: { eventKey: true, eventType: true, destinationRef: true, payload: true },
      orderBy: { destinationRef: 'asc' },
    });
    const expectedMemberIds = [memberId, tagBMember.id, bothTagsMember.id].sort();
    expect(intents).toHaveLength(3);
    expect(intents.map((intent) => intent.eventType)).toEqual([
      'notification.targeted',
      'notification.targeted',
      'notification.targeted',
    ]);
    expect(intents.map((intent) => intent.destinationRef)).toEqual(expectedMemberIds);
    expect(intents.map((intent) => intent.eventKey)).toEqual(
      expectedMemberIds.map(
        (targetMemberId) =>
          `activity-publish-audience:${activityId}:${publishedAt}:${targetMemberId}`,
      ),
    );
    expect(intents.map((intent) => intent.payload)).toEqual(
      expectedMemberIds.map((targetMemberId) =>
        expect.objectContaining({
          recipientMemberId: targetMemberId,
          notificationTypeCode: 'activity-published',
          title: '新活动已发布',
          channels: ['in-app'],
        }),
      ),
    );

    const audit = await prisma.auditLog.findFirst({
      where: { event: 'activity.publish', resourceId: activityId },
      orderBy: { createdAt: 'desc' },
      select: { context: true },
    });
    expect((audit?.context as { extra?: unknown } | undefined)?.extra).toEqual({
      operation: 'publish-with-audience-tags',
      priorStatusCode: 'draft',
      nextStatusCode: 'published',
      audienceTagCodes: [tagBCode, tagCode],
      recipientCount: 3,
    });

    const changedTags = await request(httpServer(app))
      .put(`/api/admin/v1/members/${memberId}/audience-tags`)
      .set('Authorization', superAdminAuth)
      .send({ tagCodes: [] });
    expect(changedTags.status).toBe(200);
    const snapshotAfterTagChange = await prisma.notificationOutboxIntent.findMany({
      where: { aggregateType: 'activity', aggregateId: activityId },
      select: { destinationRef: true },
      orderBy: { destinationRef: 'asc' },
    });
    expect(snapshotAfterTagChange.map((intent) => intent.destinationRef)).toEqual(
      expectedMemberIds,
    );
  });

  it('workflow stores string[] audience tags, rejects a later-inactive tag atomically, then targets on approval', async () => {
    const previousWorkflowEnabled = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    const previousAudienceTagsHttpEnabled = process.env.ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED;
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    process.env.ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED = 'true';
    let workflowApp: INestApplication | undefined;
    try {
      workflowApp = await createTestApp();
      await resetDb(workflowApp);
      let workflowPrisma = workflowApp.get(PrismaService);
      await seedActivityResponsibilitySystemRoles(workflowApp);
      const bizAdmin = await seedBizAdminPermissionsAndRole(workflowApp);

      const creator = await createTestUser(workflowApp, {
        username: 'b7-workflow-creator',
        role: Role.SUPER_ADMIN,
      });
      const reviewer = await createTestUser(workflowApp, {
        username: 'b7-workflow-reviewer',
        role: Role.SUPER_ADMIN,
      });
      const viewer = await createTestUser(workflowApp, {
        username: 'b7-workflow-viewer',
        role: Role.USER,
      });
      const creatorMember = await workflowPrisma.member.create({
        data: {
          memberNo: 'b7-workflow-creator-member',
          ...memberIdentityData('B7 工作流发起人'),
          gradeCode: 'level-3',
        },
        select: { id: true },
      });
      const audienceMember = await workflowPrisma.member.create({
        data: { memberNo: 'b7-workflow-audience-member', ...memberIdentityData('B7 工作流受众') },
        select: { id: true },
      });
      await workflowPrisma.user.update({
        where: { id: creator.id },
        data: { memberId: creatorMember.id },
      });
      await grantBizAdminToUser(workflowApp, creator.id, bizAdmin.bizAdminRoleId);
      await grantBizAdminToUser(workflowApp, reviewer.id, bizAdmin.bizAdminRoleId);
      const creatorAuth = (await loginAs(workflowApp, creator.username)).authHeader;
      const reviewerAuth = (await loginAs(workflowApp, reviewer.username)).authHeader;
      const viewerAuth = (await loginAs(workflowApp, viewer.username)).authHeader;

      const root = await workflowPrisma.organization.create({
        data: { name: 'B7 工作流根组织', nodeTypeCode: 'b7-workflow-root' },
        select: { id: true },
      });
      const organization = await workflowPrisma.organization.create({
        data: {
          name: 'B7 工作流执行组织',
          nodeTypeCode: 'b7-workflow-team',
          parentId: root.id,
        },
        select: { id: true },
      });
      await workflowPrisma.organizationClosure.createMany({
        data: [
          { ancestorId: root.id, descendantId: root.id, depth: 0 },
          { ancestorId: root.id, descendantId: organization.id, depth: 1 },
          { ancestorId: organization.id, descendantId: organization.id, depth: 0 },
        ],
      });
      await workflowPrisma.memberOrganizationMembership.create({
        data: { memberId: creatorMember.id, organizationId: organization.id },
      });

      const activityType = await request(httpServer(workflowApp))
        .post('/api/system/v1/dict-types')
        .set('Authorization', creatorAuth)
        .send({ code: 'activity_type', label: '活动类型', sortOrder: 0 });
      expect(activityType.status).toBe(201);
      const activityTypeCode = 'b7-workflow-activity';
      const activityTypeItem = await request(httpServer(workflowApp))
        .post('/api/system/v1/dict-items')
        .set('Authorization', creatorAuth)
        .send({
          typeId: activityType.body.data.id,
          code: activityTypeCode,
          label: 'B7 工作流活动',
          sortOrder: 0,
        });
      expect(activityTypeItem.status).toBe(201);
      const audienceType = await request(httpServer(workflowApp))
        .post('/api/system/v1/dict-types')
        .set('Authorization', creatorAuth)
        .send({ code: 'member_audience_tag', label: '会员受众标签', sortOrder: 0 });
      expect(audienceType.status).toBe(201);
      const workflowTagCode = 'b7-workflow-tag';
      const workflowTag = await request(httpServer(workflowApp))
        .post('/api/system/v1/dict-items')
        .set('Authorization', creatorAuth)
        .send({
          typeId: audienceType.body.data.id,
          code: workflowTagCode,
          label: '工作流受众标签',
          sortOrder: 0,
        });
      expect(workflowTag.status).toBe(201);
      const assigned = await request(httpServer(workflowApp))
        .put(`/api/admin/v1/members/${audienceMember.id}/audience-tags`)
        .set('Authorization', creatorAuth)
        .send({ tagCodes: [workflowTagCode] });
      expect(assigned.status).toBe(200);

      const activity = await request(httpServer(workflowApp))
        .post('/api/admin/v1/activities')
        .set('Authorization', creatorAuth)
        .send({
          title: 'B7 工作流定向发布活动',
          activityTypeCode,
          organizationId: organization.id,
          startAt: '2099-08-03T01:00:00.000Z',
          endAt: '2099-08-03T05:00:00.000Z',
          registrationDeadline: '2099-08-02T12:00:00.000Z',
          location: '深圳',
          allocationModeCode: 'first_come',
          isPublicRegistration: true,
        });
      expect(activity.status).toBe(201);
      const activityId = activity.body.data.id as string;
      const session = await request(httpServer(workflowApp))
        .post(`/api/app/v1/my/managed-activities/${activityId}/sessions`)
        .set('Authorization', creatorAuth)
        .send({
          code: 'b7-workflow-main',
          name: 'B7 工作流主场次',
          startAt: '2099-08-03T01:00:00.000Z',
          endAt: '2099-08-03T05:00:00.000Z',
          locationText: '深圳会场',
          checkInOpenAt: '2099-08-03T00:30:00.000Z',
          checkInCloseAt: '2099-08-03T02:00:00.000Z',
          checkOutOpenAt: '2099-08-03T03:00:00.000Z',
          checkOutCloseAt: '2099-08-03T05:00:00.000Z',
          locationRequired: false,
        });
      expect(session.status).toBe(201);

      const submitted = await request(httpServer(workflowApp))
        .patch(`/api/admin/v1/activities/${activityId}/publish-with-audience-tags`)
        .set('Authorization', creatorAuth)
        .send({ requiresInsuranceConfirmed: true, audienceTagCodes: [workflowTagCode] });
      expect(submitted.status).toBe(200);
      expect(submitted.body.data.statusCode).toBe('draft');
      const review = await workflowPrisma.activityPublishReview.findFirstOrThrow({
        where: { activityId, requestType: 'initial', status: 'pending' },
        select: { id: true, audienceTagCodes: true },
      });
      expect(review.audienceTagCodes).toEqual([workflowTagCode]);

      // JSONB 可承载任意 JSON；故意腐化已经由真实 HTTP 创建的审核单，证明运行时拒绝非 string[]，
      // 且不把它误当成 legacy NULL 或继续推进审批。
      await workflowPrisma.activityPublishReview.update({
        where: { id: review.id },
        data: { audienceTagCodes: { malformed: true } },
      });
      const malformedAudienceTags = await request(httpServer(workflowApp))
        .post(`/api/admin/v1/activity-publish-reviews/${review.id}/approve`)
        .set('Authorization', reviewerAuth)
        .send({
          requiresInsuranceConfirmed: true,
          operationKey: 'b7-workflow-malformed-audience-tags',
        });
      expectBizError(malformedAudienceTags, BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
      await expect(
        workflowPrisma.activityPublishReview.findUniqueOrThrow({
          where: { id: review.id },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: 'pending' });
      await workflowPrisma.activityPublishReview.update({
        where: { id: review.id },
        data: { audienceTagCodes: [workflowTagCode] },
      });

      await workflowApp.close();
      workflowApp = undefined;
      process.env.ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED = 'false';
      const disabledApp = await createTestApp();
      try {
        const unauthenticated = await request(httpServer(disabledApp)).get(
          `/api/admin/v1/members/${audienceMember.id}/audience-tags`,
        );
        expectBizError(unauthenticated, BizCode.UNAUTHORIZED);
        const forbidden = await request(httpServer(disabledApp))
          .get(`/api/admin/v1/members/${audienceMember.id}/audience-tags`)
          .set('Authorization', viewerAuth);
        expectBizError(forbidden, BizCode.RBAC_FORBIDDEN);

        const memberReadOff = await request(httpServer(disabledApp))
          .get(`/api/admin/v1/members/${audienceMember.id}/audience-tags`)
          .set('Authorization', creatorAuth);
        expectBizError(memberReadOff, BizCode.SERVICE_UNAVAILABLE);
        const memberWriteOff = await request(httpServer(disabledApp))
          .put(`/api/admin/v1/members/${audienceMember.id}/audience-tags`)
          .set('Authorization', creatorAuth)
          .send({ tagCodes: [] });
        expectBizError(memberWriteOff, BizCode.SERVICE_UNAVAILABLE);
        const publishOff = await request(httpServer(disabledApp))
          .patch(`/api/admin/v1/activities/${activityId}/publish-with-audience-tags`)
          .set('Authorization', creatorAuth)
          .send({ requiresInsuranceConfirmed: true, audienceTagCodes: [workflowTagCode] });
        expectBizError(publishOff, BizCode.SERVICE_UNAVAILABLE);
        const approveOff = await request(httpServer(disabledApp))
          .post(`/api/admin/v1/activity-publish-reviews/${review.id}/approve`)
          .set('Authorization', reviewerAuth)
          .send({ requiresInsuranceConfirmed: true, operationKey: 'b7-workflow-approve-01' });
        expectBizError(approveOff, BizCode.SERVICE_UNAVAILABLE);
        const genericDictionary = await request(httpServer(disabledApp))
          .get('/api/system/v1/dict-types')
          .set('Authorization', creatorAuth);
        expect(genericDictionary.status).toBe(200);
        await expect(
          disabledApp.get(PrismaService).activityPublishReview.findUniqueOrThrow({
            where: { id: review.id },
            select: { status: true },
          }),
        ).resolves.toEqual({ status: 'pending' });
      } finally {
        await disabledApp.close();
      }

      process.env.ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED = 'true';
      workflowApp = await createTestApp();
      workflowPrisma = workflowApp.get(PrismaService);

      const disabledTag = await request(httpServer(workflowApp))
        .patch(`/api/system/v1/dict-items/${workflowTag.body.data.id}/status`)
        .set('Authorization', creatorAuth)
        .send({ status: 'INACTIVE' });
      expect(disabledTag.status).toBe(200);
      const rejected = await request(httpServer(workflowApp))
        .post(`/api/admin/v1/activity-publish-reviews/${review.id}/approve`)
        .set('Authorization', reviewerAuth)
        .send({ requiresInsuranceConfirmed: true, operationKey: 'b7-workflow-approve-01' });
      expectBizError(rejected, BizCode.BAD_REQUEST);
      await expect(
        workflowPrisma.activityPublishReview.findUniqueOrThrow({
          where: { id: review.id },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: 'pending' });
      await expect(
        workflowPrisma.activity.findUniqueOrThrow({
          where: { id: activityId },
          select: { statusCode: true },
        }),
      ).resolves.toEqual({ statusCode: 'draft' });

      const reenabledTag = await request(httpServer(workflowApp))
        .patch(`/api/system/v1/dict-items/${workflowTag.body.data.id}/status`)
        .set('Authorization', creatorAuth)
        .send({ status: 'ACTIVE' });
      expect(reenabledTag.status).toBe(200);
      const approved = await request(httpServer(workflowApp))
        .post(`/api/admin/v1/activity-publish-reviews/${review.id}/approve`)
        .set('Authorization', reviewerAuth)
        .send({ requiresInsuranceConfirmed: true, operationKey: 'b7-workflow-approve-01' });
      expect(approved.status).toBe(200);
      expect(approved.body.data.audienceTagCodes).toEqual([workflowTagCode]);

      const publishIntents = await workflowPrisma.notificationOutboxIntent.findMany({
        where: { aggregateType: 'activity', aggregateId: activityId },
        select: { destinationRef: true, eventType: true },
      });
      expect(publishIntents).toEqual([
        { destinationRef: audienceMember.id, eventType: 'notification.targeted' },
      ]);
      const approvalAudit = await workflowPrisma.auditLog.findFirstOrThrow({
        where: { event: 'activity.publish', resourceId: activityId },
        orderBy: { createdAt: 'desc' },
        select: { context: true },
      });
      expect((approvalAudit.context as { extra?: unknown }).extra).toEqual({
        operation: 'publish-review-approve-with-audience-tags',
        reviewId: review.id,
        requestVersion: 1,
        requestType: 'initial',
        directPublish: false,
        audienceTagCodes: [workflowTagCode],
        recipientCount: 1,
      });
    } finally {
      await workflowApp?.close();
      if (previousWorkflowEnabled === undefined) {
        delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
      } else {
        process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousWorkflowEnabled;
      }
      if (previousAudienceTagsHttpEnabled === undefined) {
        delete process.env.ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED;
      } else {
        process.env.ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED = previousAudienceTagsHttpEnabled;
      }
    }
  });
});
