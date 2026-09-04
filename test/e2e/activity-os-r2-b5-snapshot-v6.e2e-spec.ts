import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, Prisma, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

describe('Activity OS R2 B5 publish-review snapshot V6', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let creatorAuth: string;
  let reviewerAuth: string;
  let organizationId: string;
  let fallbackTemplateId: string;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;

  const unique = (label: string): string => `activity-os-r2-b5-${label}-${(sequence += 1)}`;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const creator = await createTestUser(app, {
      username: unique('creator'),
      role: Role.SUPER_ADMIN,
    });
    const reviewer = await createTestUser(app, {
      username: unique('reviewer'),
      role: Role.USER,
    });
    const creatorMember = await prisma.member.create({
      data: {
        memberNo: unique('creator-member'),
        ...memberIdentityData('B5 发布提案发起人'),
        gradeCode: 'level-3',
      },
      select: { id: true },
    });
    const reviewerMember = await prisma.member.create({
      data: {
        memberNo: unique('reviewer-member'),
        ...memberIdentityData('B5 发布提案审核人'),
        gradeCode: 'level-3',
      },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: creator.id }, data: { memberId: creatorMember.id } });
    await prisma.user.update({ where: { id: reviewer.id }, data: { memberId: reviewerMember.id } });

    const bizAdmin = await seedBizAdminPermissionsAndRole(app);
    await seedActivityResponsibilitySystemRoles(app);
    await grantBizAdminToUser(app, creator.id, bizAdmin.bizAdminRoleId);

    const root = await prisma.organization.create({
      data: { name: unique('root'), nodeTypeCode: unique('root-type') },
      select: { id: true },
    });
    const organization = await prisma.organization.create({
      data: { name: unique('organization'), nodeTypeCode: unique('team-type'), parentId: root.id },
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
      data: { code: 'activity_type', label: 'B5 活动类型' },
      select: { id: true },
    });
    await prisma.dictItem.createMany({
      data: [
        { typeId: activityType.id, code: 'event_support', label: '活动保障' },
        { typeId: activityType.id, code: 'assistance', label: '待分类协助' },
      ],
    });
    fallbackTemplateId = (
      await prisma.activityTemplate.create({
        data: {
          code: unique('fallback-template'),
          name: 'B5 legacy fallback template',
          activityTypeCode: 'event_support',
          statusCode: 'active',
          version: 1,
        },
        select: { id: true },
      })
    ).id;

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
      data: { code: unique('reviewer-role'), displayName: 'B5 发布审核人' },
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

  async function createDraft(activityTypeCode: 'event_support' | 'assistance' = 'event_support') {
    const created = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', creatorAuth)
      .send({
        title: unique('activity'),
        activityTypeCode,
        allocationModeCode: 'first_come',
        organizationId,
        startAt: '2099-09-01T01:00:00.000Z',
        endAt: '2099-09-01T05:00:00.000Z',
        registrationDeadline: '2099-08-31T12:00:00.000Z',
        location: '旧地点投影不得进入 B5',
        visibilityCode: 'internal',
        isPublicRegistration: true,
      });
    expect(created.status).toBe(201);
    const activityId = created.body.data.id as string;
    const session = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions`)
      .set('Authorization', creatorAuth)
      .send({
        code: unique('session'),
        name: 'B5 冻结场次',
        startAt: '2099-09-01T01:00:00.000Z',
        endAt: '2099-09-01T05:00:00.000Z',
        locationText: '旧场次地点投影不得进入 B5',
        checkInOpenAt: '2099-09-01T00:30:00.000Z',
        checkInCloseAt: '2099-09-01T02:00:00.000Z',
        checkOutOpenAt: '2099-09-01T03:00:00.000Z',
        checkOutCloseAt: '2099-09-01T05:00:00.000Z',
        locationRequired: false,
      });
    expect(session.status).toBe(201);
    return { activityId, sessionId: session.body.data.sessionId as string };
  }

  async function createLocalPlaces(
    activityId: string,
    sessionId: string,
  ): Promise<{ presetId: string }> {
    const preset = await prisma.placePreset.create({
      data: {
        name: '原始预设不应污染快照',
        addressText: '原始预设地址',
        instruction: '原始预设说明',
        longitude: new Prisma.Decimal('113.1000000'),
        latitude: new Prisma.Decimal('22.1000000'),
        coordinateSystemCode: 'wgs84',
        providerCode: 'preset-provider',
        providerPlaceId: 'preset-provider-place',
        checkInEligible: true,
        radiusMeters: 300,
      },
      select: { id: true },
    });
    await prisma.activityPlace.createMany({
      data: [
        {
          id: unique('place-null-z'),
          activityId,
          sessionId: null,
          roleCode: 'primary',
          name: '活动级地点 Z',
          addressText: '活动级地址 Z',
          instruction: '活动级说明 Z',
          longitude: null,
          latitude: null,
          coordinateSystemCode: null,
          providerCode: null,
          providerPlaceId: null,
          visibilityCode: 'staff',
          checkInEligible: false,
          radiusMeters: null,
          sourcePresetId: null,
        },
        {
          id: unique('place-session'),
          activityId,
          sessionId,
          roleCode: 'meeting',
          name: '场次地点',
          addressText: 'B5 地址不得进安全摘要',
          instruction: 'B5 指引不得进安全摘要',
          longitude: new Prisma.Decimal('113.1234567'),
          latitude: new Prisma.Decimal('22.1234567'),
          coordinateSystemCode: 'wgs84',
          providerCode: 'b5-provider',
          providerPlaceId: 'b5-provider-place',
          visibilityCode: 'staff',
          checkInEligible: true,
          radiusMeters: 500,
          sourcePresetId: preset.id,
        },
        {
          id: unique('place-null-a'),
          activityId,
          sessionId: null,
          roleCode: 'execution',
          name: '活动级地点 A',
          addressText: '活动级地址 A',
          instruction: null,
          longitude: null,
          latitude: null,
          coordinateSystemCode: null,
          providerCode: null,
          providerPlaceId: null,
          visibilityCode: 'public',
          checkInEligible: false,
          radiusMeters: null,
          sourcePresetId: null,
        },
      ],
    });
    return { presetId: preset.id };
  }

  async function submitInitial(activityId: string, operationKey: string) {
    const response = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/publish-reviews`)
      .set('Authorization', creatorAuth)
      .send({ operationKey, confirmation: true });
    expect(response.status).toBe(200);
    return response;
  }

  async function approve(reviewId: string, operationKey: string) {
    return request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${reviewId}/approve`)
      .set('Authorization', reviewerAuth)
      .send({ requiresInsuranceConfirmed: true, operationKey });
  }

  it('freezes canonical V6 local places and ignores later PlacePreset edits when approving', async () => {
    const { activityId, sessionId } = await createDraft();
    const { presetId } = await createLocalPlaces(activityId, sessionId);
    const submitted = await submitInitial(activityId, unique('initial'));
    const snapshot = submitted.body.data.snapshot as Record<string, unknown>;

    expect(snapshot).toMatchObject({
      schemaVersion: 6,
      categoryCode: 'event_support',
      plannedSemanticAssignments: [{ dimensionCode: 'format', optionCode: 'event_support' }],
      selectedTemplateVersionId: null,
      templateVersionId: fallbackTemplateId,
      timePolicyPointers: null,
      contributionPolicyPointers: null,
      metricSetPointer: null,
      contentVisibilitySummary: { visibilityCode: 'internal', isPublicRegistration: true },
    });
    expect(
      (snapshot.activityPlaces as Array<Record<string, unknown>>).map((place) => place.name),
    ).toEqual(['活动级地点 A', '活动级地点 Z', '场次地点']);
    expect(snapshot.base).toMatchObject({
      categoryCode: 'event_support',
      selectedTemplateVersionId: null,
      timePolicyPointers: null,
      contributionPolicyPointers: null,
      metricSetPointer: null,
    });
    expect(JSON.stringify(snapshot.activityPlaces)).not.toMatch(/activityId|createdAt|updatedAt/u);

    await prisma.placePreset.update({
      where: { id: presetId },
      data: { name: '审批前被改的预设', addressText: '预设新地址不得污染本地快照' },
    });
    const approved = await approve(submitted.body.data.id as string, unique('approve'));
    expect(approved.status).toBe(200);

    const ruleSnapshot = await prisma.activityRuleSnapshot.findFirstOrThrow({
      where: { activityId },
      orderBy: { workflowRevision: 'desc' },
      select: { resolvedConfig: true },
    });
    const resolvedConfig = ruleSnapshot.resolvedConfig as Record<string, unknown>;
    expect(resolvedConfig).toMatchObject({
      categoryCode: 'event_support',
      selectedTemplateVersionId: null,
      timePolicyPointers: null,
      contributionPolicyPointers: null,
      metricSetPointer: null,
      contentVisibilitySummary: { visibilityCode: 'internal', isPublicRegistration: true },
    });
    expect((resolvedConfig.activityPlaces as Array<Record<string, unknown>>)[2]).toMatchObject({
      name: '场次地点',
      addressText: 'B5 地址不得进安全摘要',
      longitude: '113.1234567',
      latitude: '22.1234567',
      providerPlaceId: 'b5-provider-place',
      sourcePresetId: presetId,
    });

    const change = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/change-reviews`)
      .set('Authorization', creatorAuth)
      .send({
        operationKey: unique('change'),
        confirmation: true,
        activityPatch: { activityTypeCode: 'assistance', isPublicRegistration: false },
        sessions: { create: [], update: [], cancel: [] },
        positions: { create: [], update: [], cancel: [] },
      });
    expect(change.status).toBe(200);
    const detail = await request(httpServer(app))
      .get(`/api/admin/v1/activity-publish-reviews/${change.body.data.id as string}`)
      .set('Authorization', reviewerAuth)
      .expect(200);
    expect(detail.body.data.changeDiff).toMatchObject({
      kind: 'proposal-v6',
      v6Fields: {
        changedFields: ['categoryCode', 'contentVisibilitySummary', 'plannedSemanticAssignments'],
      },
    });
    const safeDiff = JSON.stringify(detail.body.data.changeDiff);
    expect(safeDiff).not.toContain('B5 地址不得进安全摘要');
    expect(safeDiff).not.toContain('113.1234567');
    expect(safeDiff).not.toContain('b5-provider-place');
    expect(safeDiff).not.toContain('registrationForm');
  });

  it('rejects approval when an ActivityPlace local fact changes after a V6 proposal is submitted', async () => {
    const { activityId, sessionId } = await createDraft();
    await createLocalPlaces(activityId, sessionId);
    const submitted = await submitInitial(activityId, unique('stale-initial'));
    const place = await prisma.activityPlace.findFirstOrThrow({
      where: { activityId, sessionId: null },
      orderBy: { roleCode: 'asc' },
      select: { id: true },
    });
    await prisma.activityPlace.update({
      where: { id: place.id },
      data: { addressText: '本地地点在审批前变化' },
    });

    const rejected = await approve(submitted.body.data.id as string, unique('stale-approve'));
    expectBizError(rejected, BizCode.ACTIVITY_PUBLISH_REVIEW_EXPECTED_SNAPSHOT_MISMATCH);
  });
});
