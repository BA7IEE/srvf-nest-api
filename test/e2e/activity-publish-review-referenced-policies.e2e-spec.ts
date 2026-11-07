import { writeFileSync } from 'node:fs';
import { hashCanonical } from '../../src/modules/activities/activity-publish-review-idempotency';
import { ActivityPublishReviewPolicyQueryService } from '../../src/modules/activities/activity-publish-review-policy-query.service';
import { ActivityPublishProposalV2Service } from '../../src/modules/activities/activity-publish-proposal-v2.service';
import type { INestApplication } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { computeActivityTemplateDefinitionHash } from '../../src/modules/activities/activity-template-definition';
import { fingerprintTimePolicyVersion } from '../../src/modules/activities/activity-time-policy-definition';
import { fingerprintContributionPolicyVersion } from '../../src/modules/activities/activity-contribution-policy-definition';
import { createTestUser } from '../fixtures/users.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const ROOT = '/api/admin/v1/activities';
const baseDefinition = {
  activity: { allocationModeCode: 'first_come', capacity: 2, requiresInsurance: true },
  sessions: [
    {
      code: 'main',
      name: '唯一场次',
      startOffsetMinutes: 0,
      endOffsetMinutes: 120,
      locationText: '集合点',
      capacity: 2,
      checkInOpenOffsetMinutes: 0,
      checkInCloseOffsetMinutes: 20,
      checkOutOpenOffsetMinutes: -20,
      checkOutCloseOffsetMinutes: 0,
      locationRequired: false,
      lateGraceMinutes: 5,
      earlyLeaveThresholdMinutes: 5,
      sortOrder: 0,
      positions: [
        {
          code: 'participant',
          name: '默认参与',
          attendanceRoleCode: 'volunteer',
          capacity: 2,
          sortOrder: 0,
        },
      ],
    },
  ],
};

/** A fresh ordinary-account API chain using guarded worker cleanup, never a retained R5 database. */
describe('review-referenced policy real HTTP and database boundary', () => {
  let app: INestApplication, db: PrismaService;
  let publisher: { id: string; auth: string },
    reviewer: { id: string; auth: string },
    outsider: { id: string; auth: string },
    readOnly: { id: string; auth: string },
    otherScoped: { id: string; auth: string };
  let organizationId: string, templateId: string;
  let sequence = 0;
  const key = (label: string) => `review_policy_${label}_${++sequence}`;
  const priorWorkflow = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
  const priorControl = process.env.ACTIVITY_OS_CONTROL_PLANE_MODE;
  const evidence: Record<string, unknown> = {
    ordinaryRoles: ['USER', 'USER', 'USER', 'USER', 'USER'],
    databaseSqlIdentity: 'isolated fixture owner; not production least-privilege evidence',
  };

  async function grant(userId: string, codes: string[], scopeOrgId = organizationId) {
    for (const code of codes)
      await db.permission.upsert({
        where: { code },
        update: {},
        create: {
          code,
          module: code.split('.')[0],
          action: code.split('.')[1],
          resourceType: code.split('.').slice(2).join('.'),
        },
      });
    const role = await db.rbacRole.create({
      data: { code: key('role'), displayName: '单场次精确测试授权' },
    });
    const permissions = await db.permission.findMany({
      where: { code: { in: codes } },
      select: { id: true },
    });
    expect(permissions).toHaveLength(codes.length);
    await db.rolePermission.createMany({
      data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })),
    });
    return db.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: userId,
        roleId: role.id,
        scopeType: 'ORGANIZATION',
        scopeOrgId,
      },
    });
  }

  async function user(label: string) {
    const member = await db.member.create({
      data: { memberNo: key(label), gradeCode: 'level-3', ...memberIdentityData(`合成${label}`) },
    });
    const user = await createTestUser(app, { username: key(label), role: Role.USER });
    await db.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    await db.memberOrganizationMembership.create({ data: { memberId: member.id, organizationId } });
    return { id: user.id, auth: (await loginAs(app, user.username)).authHeader };
  }

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    process.env.ACTIVITY_OS_CONTROL_PLANE_MODE = 'active';
    app = await createTestApp();
    db = app.get(PrismaService);
    await resetDb(app);
    expect(await db.activity.count()).toBe(0);
    expect(await db.user.count()).toBe(0);
    const root = await db.organization.create({
      data: { name: '合成根组织', nodeTypeCode: 'root' },
    });
    const org = await db.organization.create({
      data: { name: '合成常规活动组织', nodeTypeCode: 'team', parentId: root.id },
    });
    organizationId = org.id;
    await db.organizationClosure.createMany({
      data: [
        { ancestorId: root.id, descendantId: root.id, depth: 0 },
        { ancestorId: root.id, descendantId: org.id, depth: 1 },
        { ancestorId: org.id, descendantId: org.id, depth: 0 },
      ],
    });
    for (const [code, value] of [
      ['activity_type', 'training'],
      ['attendance_role', 'volunteer'],
    ]) {
      const type = await db.dictType.create({ data: { code, label: code } });
      await db.dictItem.create({ data: { typeId: type.id, code: value, label: value } });
    }
    await seedActivityResponsibilitySystemRoles(app);
    publisher = await user('publisher');
    reviewer = await user('reviewer');
    outsider = await user('participant');
    const reviewCodes = [
      'activity-review.read.request',
      'activity-review.return.request',
      'activity.publish.record',
    ];
    await grant(publisher.id, [
      'activity.create.record',
      'activity.update.record',
      'activity.time-policy.read',
      'activity.time-policy.select',
      'activity.contribution-policy.read',
      'activity.contribution-policy.select',
      ...reviewCodes,
    ]);
    await grant(reviewer.id, reviewCodes);
    readOnly = await user('read_only');
    await grant(readOnly.id, ['activity-review.read.request']);
    otherScoped = await user('other_scope');
    const otherOrganization = await db.organization.create({
      data: { name: '合成其他审核组织', nodeTypeCode: 'team', parentId: root.id },
    });
    await db.organizationClosure.createMany({
      data: [
        { ancestorId: otherOrganization.id, descendantId: otherOrganization.id, depth: 0 },
        { ancestorId: root.id, descendantId: otherOrganization.id, depth: 1 },
      ],
    });
    await grant(otherScoped.id, ['activity-review.read.request'], otherOrganization.id);
    expect(await db.roleBinding.count({ where: { scopeType: 'GLOBAL' } })).toBe(0);

    const time = fingerprintTimePolicyVersion({
      schemaVersion: 1,
      evaluatorVersion: 1,
      effectiveFrom: '2098-01-01T00:00:00.000Z',
      effectiveUntil: '2101-01-01T00:00:00.000Z',
      definition: {
        defaultCategory: 'volunteer_service',
        roleMappings: [],
        allowSplit: false,
        specialIntervals: {
          preparation: { mode: 'exclude' },
          duty: { mode: 'exclude' },
          travel: { mode: 'exclude' },
        },
        rounding: { mode: 'floor', quantumSeconds: 1 },
        evidence: { requiredSources: [], requireManualRecognition: false },
        manualAdjustment: { enabled: false },
      },
    });
    const tp = await db.timePolicy.create({
      data: { code: key('time'), name: '合成批准时长政策' },
    });
    const tv = await db.timePolicyVersion.create({
      data: {
        policyId: tp.id,
        version: 1,
        schemaVersion: 1,
        definitionJson: time.definition as unknown as Prisma.InputJsonValue,
        definitionHash: time.definitionHash,
        evaluatorVersion: 1,
        effectiveFrom: new Date(time.effectiveFrom),
        effectiveUntil: new Date(time.effectiveUntil!),
        statusCode: 'draft',
      },
    });
    await db.timePolicyVersion.update({
      where: { id: tv.id },
      data: { statusCode: 'active', activatedAt: new Date() },
    });
    const contribution = fingerprintContributionPolicyVersion({
      schemaVersion: 1,
      evaluatorVersion: 1,
      effectiveFrom: '2098-01-01T00:00:00.000Z',
      effectiveUntil: '2101-01-01T00:00:00.000Z',
      definition: {
        defaultResult: { recognizedPoints: '0.00', explanationCode: 'test_default_zero' },
        roleRules: [],
      },
    });
    const cp = await db.contributionPolicy.create({
      data: { code: key('contribution'), name: '合成批准贡献政策' },
    });
    const cv = await db.contributionPolicyVersion.create({
      data: {
        policyId: cp.id,
        version: 1,
        schemaVersion: 1,
        definitionJson: contribution.definition as unknown as Prisma.InputJsonValue,
        definitionHash: contribution.definitionHash,
        evaluatorVersion: 1,
        effectiveFrom: new Date(contribution.effectiveFrom),
        effectiveUntil: new Date(contribution.effectiveUntil!),
        statusCode: 'draft',
        createdByUserId: publisher.id,
      },
    });
    await db.contributionPolicyVersion.update({
      where: { id: cv.id },
      data: { statusCode: 'active', activatedAt: new Date(), activatedByUserId: publisher.id },
    });
    const definition = {
      ...baseDefinition,
      registrationForm: null,
      metricSelection: { metricRequirementCode: 'not_required', metricSetPointer: null },
      timePolicySelection: {
        default: {
          mode: 'explicit',
          pointer: { policyId: tp.id, versionId: tv.id, definitionHash: tv.definitionHash },
        },
        sessionOverrides: [],
        positionOverrides: [],
      },
      contributionPolicySelection: {
        activityDefault: {
          mode: 'explicit',
          pointer: {
            policyId: cp.id,
            versionId: cv.id,
            definitionHash: cv.definitionHash,
            evaluatorVersion: 1,
          },
        },
        positionOverrides: [],
      },
    };
    const family = await db.activityTemplateFamily.create({
      data: {
        code: key('family'),
        name: '合成常规活动',
        categoryCode: 'training',
        scopeTypeCode: 'global',
        statusCode: 'active',
      },
    });
    const template = await db.activityTemplate.create({
      data: {
        code: key('template'),
        name: '合成单场次 V5',
        activityTypeCode: 'training',
        version: 1,
        familyId: family.id,
        statusCode: 'draft',
        schemaVersion: 5,
        definitionJson: definition,
        definitionHash: computeActivityTemplateDefinitionHash({ schemaVersion: 5, definition }),
        effectiveFrom: new Date('2098-01-01T00:00:00Z'),
      },
    });
    await db.activityTemplate.update({
      where: { id: template.id },
      data: { statusCode: 'active' },
    });
    templateId = template.id;
    evidence.template = { id: template.id, definitionHash: template.definitionHash };
  }, 60000);

  afterAll(async () => {
    try {
      evidence.noExternalDelivery = {
        wecomSettings: await db.wecomSettings.count(),
        smsSettings: await db.smsSettings.count(),
        deliveries: await db.notificationDelivery.count(),
        sentOutbox: await db.notificationOutboxIntent.count({ where: { sentAt: { not: null } } }),
      };
      evidence.outbox = await db.notificationOutboxIntent.findMany({
        select: {
          id: true,
          eventKey: true,
          eventType: true,
          aggregateId: true,
          status: true,
          attempts: true,
          sentAt: true,
        },
        orderBy: { eventKey: 'asc' },
      });
      expect(await db.notificationDelivery.count()).toBe(0);
      expect(await db.notificationOutboxIntent.count({ where: { attempts: { gt: 0 } } })).toBe(0);
      writeFileSync('/evidence/policy-api-db-evidence.json', JSON.stringify(evidence, null, 2));
    } finally {
      await app?.close();
      if (priorWorkflow === undefined) delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = priorWorkflow;
      if (priorControl === undefined) delete process.env.ACTIVITY_OS_CONTROL_PLANE_MODE;
      else process.env.ACTIVITY_OS_CONTROL_PLANE_MODE = priorControl;
    }
  });

  function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function record(value: unknown): Record<string, unknown> {
    if (!object(value)) throw new Error('Expected a real HTTP object');
    return value;
  }

  async function draft(label: string) {
    const created = await request(httpServer(app))
      .post(`${ROOT}/from-template`)
      .set('Authorization', publisher.auth)
      .send({
        operationKey: key('create'),
        templateVersionId: templateId,
        title: `合成政策审核 ${label}`,
        organizationId,
        startAt: '2099-09-01T00:00:00.000Z',
        endAt: '2099-09-01T02:00:00.000Z',
        location: '合成会场',
        defaultPlaceVisibilityCode: 'staff',
        confirmedCapacity: 2,
        instance: {
          capacity: 2,
          registrationDeadline: null,
          description: null,
          registrationNotes: null,
        },
      })
      .expect(201);
    const activityId = record(record(created.body).data).activityId;
    if (typeof activityId !== 'string') throw new Error('No activity id in genuine response');
    const read = await request(httpServer(app))
      .get(`${ROOT}/${activityId}/simple-draft`)
      .set('Authorization', publisher.auth)
      .expect(200);
    const draftHash = record(record(read.body).data).draftHash;
    if (typeof draftHash !== 'string') throw new Error('No draftHash in genuine response');
    return { activityId, draftHash };
  }

  async function submitted(label: string) {
    const created = await draft(label);
    const response = await request(httpServer(app))
      .post(`${ROOT}/${created.activityId}/publish-reviews`)
      .set('Authorization', publisher.auth)
      .send({
        operationKey: key('submit'),
        confirmation: true,
        expectedDraftHash: created.draftHash,
      })
      .expect(200);
    const id = record(record(response.body).data).id;
    if (typeof id !== 'string') throw new Error('No review id in genuine response');
    const review = await db.activityPublishReview.findUniqueOrThrow({ where: { id } });
    expect(review.status).toBe('pending');
    return review;
  }

  const url = (id: string) => `/api/admin/v1/activity-publish-reviews/${id}/referenced-policies`;
  const reviewUrl = (id: string) => `/api/admin/v1/activity-publish-reviews/${id}`;

  async function rejectCatalogueQuery(id: string, query: Record<string, string>) {
    const response = await request(httpServer(app))
      .get(url(id))
      .query(query)
      .set('Authorization', readOnly.auth);
    expectBizError(response, BizCode.BAD_REQUEST, { strictMessage: false });
    expect(record(response.body).message).toBe(
      `property ${Object.keys(query)[0]} should not exist`,
    );
  }

  it('lets a review-read-only scoped USER inspect complete real V5 policy definitions without catalogue authority', async () => {
    await request(httpServer(app)).get('/api/docs').redirects(1).expect(200);
    const openapi = await request(httpServer(app)).get('/api/docs-json').expect(200);
    const document = record(openapi.body),
      paths = record(document.paths);
    expect(document.code).toBeUndefined();
    const endpoint = record(
      record(paths['/api/admin/v1/activity-publish-reviews/{id}/referenced-policies']).get,
    );
    const parameters = endpoint.parameters;
    if (!Array.isArray(parameters)) throw new Error('Expected documented path parameter');
    expect(parameters.filter((value) => record(value).in === 'query')).toEqual([]);
    const schemas = record(record(document.components).schemas);
    const responseSchema = record(schemas.ActivityPublishReviewReferencedPoliciesResponseDto);
    expect(Object.keys(record(responseSchema.properties)).sort()).toEqual([
      'activityId',
      'contributionPolicies',
      'reviewId',
      'snapshotHash',
      'snapshotSchemaVersion',
      'timePolicies',
    ]);
    const timeSchema = record(schemas.ActivityPublishReviewReferencedTimePolicyDto);
    expect(record(record(timeSchema.properties).definition).allOf).toEqual([
      {
        $ref: '#/components/schemas/TimePolicyDefinitionDto',
      },
    ]);
    const contributionSchema = record(schemas.ActivityPublishReviewReferencedContributionPolicyDto);
    expect(record(record(contributionSchema.properties).definition).allOf).toEqual([
      {
        $ref: '#/components/schemas/ContributionPolicyDefinitionDto',
      },
    ]);
    evidence.liveOpenApi = {
      docsHtml: 200,
      docsJson: 200,
      endpoint: '/api/admin/v1/activity-publish-reviews/{id}/referenced-policies',
      queryParameters: 0,
      responseFields: Object.keys(record(responseSchema.properties)).sort(),
      completeTimeDefinitionSchema: true,
      completeContributionDefinitionSchema: true,
    };
    const review = await submitted('normal');
    const detail = await request(httpServer(app))
      .get(reviewUrl(review.id))
      .set('Authorization', readOnly.auth)
      .expect(200);
    const response = await request(httpServer(app))
      .get(url(review.id))
      .set('Authorization', readOnly.auth);
    if (response.status !== 200) {
      const diagnostics: Record<string, unknown> = {
        httpStatus: response.status,
        response: record(response.body),
        reviewBaseRevision: review.baseRevision,
        frozenSnapshot: review.snapshot,
      };
      try {
        app.get(ActivityPublishProposalV2Service).parseSnapshot(review.snapshot);
        diagnostics.snapshotParser = 'PASS';
      } catch (error) {
        diagnostics.snapshotParser = error instanceof Error ? error.stack : String(error);
      }
      try {
        const principal = await db.user.findUniqueOrThrow({
          where: { id: readOnly.id },
          select: { id: true, username: true, role: true, status: true, memberId: true },
        });
        await app.get(ActivityPublishReviewPolicyQueryService).findOne(review.id, principal);
      } catch (error) {
        diagnostics.readService = error instanceof Error ? error.stack : String(error);
      }
      const versions = [];
      for (const [kind, rows, fingerprint] of [
        ['time', await db.timePolicyVersion.findMany(), fingerprintTimePolicyVersion],
        [
          'contribution',
          await db.contributionPolicyVersion.findMany(),
          fingerprintContributionPolicyVersion,
        ],
      ] as const) {
        for (const row of rows) {
          try {
            const checked = fingerprint({
              schemaVersion: row.schemaVersion,
              evaluatorVersion: row.evaluatorVersion,
              definition: row.definitionJson,
              effectiveFrom: row.effectiveFrom.toISOString(),
              effectiveUntil: row.effectiveUntil?.toISOString() ?? null,
            });
            versions.push({
              kind,
              id: row.id,
              storedHash: row.definitionHash,
              computedHash: checked.definitionHash,
            });
          } catch (error) {
            versions.push({
              kind,
              id: row.id,
              error: error instanceof Error ? error.stack : String(error),
            });
          }
        }
      }
      diagnostics.versions = versions;
      evidence.normalReadFailure = diagnostics;
    }
    expect(response.status).toBe(200);
    const data = record(record(response.body).data),
      snapshot = record(review.snapshot);
    expect(data).toMatchObject({
      reviewId: review.id,
      activityId: review.activityId,
      snapshotSchemaVersion: 9,
      snapshotHash: snapshot.snapshotHash,
    });
    expect(record(record(detail.body).data).snapshot).toEqual(review.snapshot);
    expect(snapshot.timePolicyPointers).not.toBeNull();
    expect(snapshot.contributionPolicyPointers).not.toBeNull();
    const time = data.timePolicies,
      contribution = data.contributionPolicies;
    if (!Array.isArray(time) || !Array.isArray(contribution))
      throw new Error('Missing policy arrays');
    expect(time).toHaveLength(1);
    expect(contribution).toHaveLength(1);
    const tp = record(time[0]),
      cp = record(contribution[0]);
    const expectedTime = await db.timePolicyVersion.findUniqueOrThrow({
      where: { id: String(tp.versionId) },
    });
    const expectedContribution = await db.contributionPolicyVersion.findUniqueOrThrow({
      where: { id: String(cp.versionId) },
    });
    expect(tp.definition).toEqual(expectedTime.definitionJson);
    expect(cp.definition).toEqual(expectedContribution.definitionJson);
    expect(record(tp.definition).rounding).toEqual({ mode: 'floor', quantumSeconds: 1 });
    expect(record(cp.definition).defaultResult).toEqual({
      recognizedPoints: '0.00',
      explanationCode: 'test_default_zero',
    });
    expectBizError(
      await request(httpServer(app))
        .get(
          `/api/admin/v1/activity-time-policies/${expectedTime.policyId}/versions/${expectedTime.id}`,
        )
        .set('Authorization', readOnly.auth),
      BizCode.RBAC_FORBIDDEN,
    );
    expectBizError(
      await request(httpServer(app))
        .get(
          `/api/system/v1/contribution-policies/${expectedContribution.policyId}/versions/${expectedContribution.id}`,
        )
        .set('Authorization', readOnly.auth),
      BizCode.RBAC_FORBIDDEN,
    );
    evidence.normal = {
      reviewId: review.id,
      snapshotHash: snapshot.snapshotHash,
      response: data,
      catalogueAccess: '403/30100 for both domains',
      policyFreeFixture: false,
    };
  });

  it('rejects unauthenticated, missing-code and cross-organization readers without partial policy data', async () => {
    const review = await submitted('authorization');
    expectBizError(await request(httpServer(app)).get(url(review.id)), BizCode.UNAUTHORIZED);
    for (const actor of [outsider, otherScoped]) {
      const response = await request(httpServer(app))
        .get(url(review.id))
        .set('Authorization', actor.auth);
      expectBizError(response, BizCode.RBAC_FORBIDDEN);
      expect(record(response.body).data).toBeNull();
    }
    evidence.authorization = {
      missingIdentity: '401/40100',
      missingCode: '403/30100',
      crossOrganization: '403/30100',
    };
  });

  it('rejects arbitrary policy/version query identifiers and absent review ids', async () => {
    const review = await submitted('query');
    const catalogueQueries: Record<string, string>[] = [
      { policyId: 'unreferenced_policy' },
      { versionId: 'unreferenced_version' },
    ];
    for (const query of catalogueQueries) {
      await rejectCatalogueQuery(review.id, query);
    }
    expectBizError(
      await request(httpServer(app))
        .get(url('missing_review_123'))
        .set('Authorization', readOnly.auth),
      BizCode.ACTIVITY_PUBLISH_REVIEW_NOT_FOUND,
    );
    evidence.queryBoundary = {
      policyId: '400/40000',
      versionId: '400/40000',
      absentReview: '404/20004',
    };
  });

  it('does not return an unreferenced catalogue version even when that version really exists', async () => {
    const review = await submitted('unreferenced');
    const policy = await db.timePolicy.create({
      data: { code: key('unreferenced'), name: '合成未引用政策' },
    });
    const original = await db.timePolicyVersion.findFirstOrThrow({
      where: { statusCode: 'active' },
    });
    const definition = original.definitionJson;
    if (definition === null || typeof definition !== 'object' || Array.isArray(definition))
      throw new Error('Expected complete policy definition');
    const unused = await db.timePolicyVersion.create({
      data: {
        policyId: policy.id,
        version: 1,
        schemaVersion: original.schemaVersion,
        evaluatorVersion: original.evaluatorVersion,
        definitionJson: definition,
        definitionHash: original.definitionHash,
        effectiveFrom: original.effectiveFrom,
        effectiveUntil: original.effectiveUntil,
        statusCode: 'draft',
      },
    });
    await db.timePolicyVersion.update({
      where: { id: unused.id },
      data: { statusCode: 'active', activatedAt: new Date() },
    });
    const response = await request(httpServer(app))
      .get(url(review.id))
      .set('Authorization', readOnly.auth)
      .expect(200);
    expect(JSON.stringify(response.body)).not.toContain(unused.id);
    expect(JSON.stringify(response.body)).not.toContain(policy.id);
    await rejectCatalogueQuery(review.id, { versionId: unused.id });
    evidence.unreferenced = { exists: true, returned: false, queryRejected: '400/40000' };
  });

  it('refuses a corrupt stored snapshot hash without returning any definitions', async () => {
    const source = await submitted('source');
    const created = await draft('corrupt');
    const activity = await db.activity.findUniqueOrThrow({ where: { id: created.activityId } });
    const snapshot = source.snapshot;
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot))
      throw new Error('Expected frozen object');
    const corrupt = await db.activityPublishReview.create({
      data: {
        activityId: activity.id,
        requestType: 'initial',
        requestVersion: 1,
        baseRevision: activity.workflowRevision,
        status: 'pending',
        directPublish: false,
        submittedByUserId: publisher.id,
        snapshot: { ...snapshot, snapshotHash: '0'.repeat(64) },
        operationKey: key('corrupt_storage'),
        requestHash: '0'.repeat(64),
      },
    });
    const response = await request(httpServer(app))
      .get(url(corrupt.id))
      .set('Authorization', readOnly.auth);
    expectBizError(response, BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID);
    expect(record(response.body).data).toBeNull();
    evidence.corruptSnapshot = {
      status: response.status,
      code: record(response.body).code,
      partialDefinitions: false,
    };
  });

  it('has no decision, business-audit or outbox side effects on repeated reads', async () => {
    const review = await submitted('read_only');
    const before = {
      audit: await db.auditLog.count(),
      outbox: await db.notificationOutboxIntent.count(),
      review: await db.activityPublishReview.findUnique({ where: { id: review.id } }),
      activity: await db.activity.findUnique({ where: { id: review.activityId } }),
    };
    for (let i = 0; i < 3; i++)
      await request(httpServer(app))
        .get(url(review.id))
        .set('Authorization', readOnly.auth)
        .expect(200);
    const after = {
      audit: await db.auditLog.count(),
      outbox: await db.notificationOutboxIntent.count(),
      review: await db.activityPublishReview.findUnique({ where: { id: review.id } }),
      activity: await db.activity.findUnique({ where: { id: review.activityId } }),
    };
    expect(after).toEqual(before);
    evidence.readOnly = { reads: 3, businessAuditOutboxAndRowsUnchanged: true };
  });

  it('preserves real approve and exact replay after reading, publishes once and leaves notification intents undelivered', async () => {
    const review = await submitted('existing_approve');
    await request(httpServer(app))
      .get(url(review.id))
      .set('Authorization', reviewer.auth)
      .expect(200);
    const body = {
      operationKey: key('approve'),
      requiresInsuranceConfirmed: true,
      reviewNote: '合成完整政策已核对',
    };
    const first = await request(httpServer(app))
      .post(`${reviewUrl(review.id)}/approve`)
      .set('Authorization', reviewer.auth)
      .send(body)
      .expect(200);
    const replay = await request(httpServer(app))
      .post(`${reviewUrl(review.id)}/approve`)
      .set('Authorization', reviewer.auth)
      .send(body)
      .expect(200);
    expect(record(first.body).data).toEqual(record(replay.body).data);
    const stored = await db.activityPublishReview.findUniqueOrThrow({ where: { id: review.id } });
    const activity = await db.activity.findUniqueOrThrow({ where: { id: review.activityId } });
    expect(stored.status).toBe('approved');
    expect(activity.statusCode).toBe('published');
    expect(stored.reviewRequestHash).toBe(
      hashCanonical({ action: 'publish-review-approve', reviewId: review.id, payload: body }),
    );
    const audits = await db.auditLog.findMany({
      where: { resourceType: 'activity', resourceId: activity.id, event: 'activity.publish' },
    });
    expect(
      audits.filter((row) => JSON.stringify(row.context).includes('publish-review-approve')),
    ).toHaveLength(1);
    expect(await db.notificationOutboxIntent.count({ where: { aggregateId: review.id } })).toBe(1);
    expect(await db.notificationOutboxIntent.count({ where: { aggregateId: activity.id } })).toBe(
      1,
    );
    await request(httpServer(app))
      .get(url(review.id))
      .set('Authorization', readOnly.auth)
      .expect(200);
    evidence.existingApprove = {
      reviewId: review.id,
      status: stored.status,
      activityStatus: activity.statusCode,
      reviewOperationKey: stored.reviewOperationKey,
      reviewRequestHash: stored.reviewRequestHash,
      identicalReplay: true,
      approveAudits: 1,
      outcomeIntents: 1,
      publishIntents: 1,
      delivered: 0,
      evidenceLevel: 'real HTTP and DB; no browser in this stage',
    };
  });
});
