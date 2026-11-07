import { hashCanonical } from '../../src/modules/activities/activity-publish-review-idempotency';
import type { INestApplication } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityDraftAuditRecorder } from '../../src/modules/activities/activity-draft-audit-recorder';
import { ActivityPublishProposalV2Service } from '../../src/modules/activities/activity-publish-proposal-v2.service';
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
describe('ActivityOS V1 simple draft ordinary HTTP chain', () => {
  let app: INestApplication, db: PrismaService;
  let publisher: { id: string; auth: string },
    reviewer: { id: string; auth: string },
    outsider: { id: string; auth: string };
  let organizationId: string, templateId: string, publisherBindingId: string;
  let sequence = 0;
  const key = (label: string) => `routine_v1_${label}_${++sequence}`;
  const priorWorkflow = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
  const priorControl = process.env.ACTIVITY_OS_CONTROL_PLANE_MODE;
  const evidence: Record<string, unknown> = {
    ordinaryRoles: ['USER', 'USER', 'USER'],
    databaseSqlIdentity: 'isolated fixture owner; not production least-privilege evidence',
    endingAndSettlement: 'existing independent formal journey evidence; not rerun here',
  };

  async function grant(userId: string, codes: string[]) {
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
        scopeOrgId: organizationId,
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
    publisherBindingId = (
      await grant(publisher.id, [
        'activity.create.record',
        'activity.update.record',
        'activity.time-policy.read',
        'activity.time-policy.select',
        'activity.contribution-policy.read',
        'activity.contribution-policy.select',
        ...reviewCodes,
      ])
    ).id;
    await grant(reviewer.id, reviewCodes);
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
  }, 30000);

  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (priorWorkflow === undefined) delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = priorWorkflow;
      if (priorControl === undefined) delete process.env.ACTIVITY_OS_CONTROL_PLANE_MODE;
      else process.env.ACTIVITY_OS_CONTROL_PLANE_MODE = priorControl;
      console.log('ACTIVITYOS_L2_EVIDENCE ' + JSON.stringify(evidence));
    }
  });

  it('runs one real ordinary-account create → atomic save → independent approval chain, with required rejects and rollback', async () => {
    const server = httpServer(app);
    const options = await request(server)
      .get(`${ROOT}/organization-options`)
      .set('Authorization', publisher.auth)
      .expect(200);
    expect(options.body.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ organizationId })]),
    );
    const templates = await request(server)
      .get(`${ROOT}/template-version-options`)
      .query({ organizationId })
      .set('Authorization', publisher.auth)
      .expect(200);
    expect(templates.body.data.items).toEqual([
      expect.objectContaining({ id: templateId, schemaVersion: 5 }),
    ]);
    expect(Object.keys(templates.body.data.items[0] as Record<string, unknown>).sort()).toEqual(
      [
        'id',
        'code',
        'name',
        'version',
        'schemaVersion',
        'definitionHash',
        'statusCode',
        'activityTypeCode',
        'family',
        'effectiveFrom',
        'effectiveTo',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    const body = {
      operationKey: key('create'),
      templateVersionId: templateId,
      title: '合成常规活动',
      organizationId,
      startAt: '2099-09-01T00:00:00.000Z',
      endAt: '2099-09-01T03:00:00.000Z',
      location: '原集合点',
      defaultPlaceVisibilityCode: 'staff',
      confirmedCapacity: 2,
      instance: {
        capacity: 4,
        registrationDeadline: '2099-08-31T23:00:00.000Z',
        description: '本次活动说明',
        registrationNotes: '参与准备',
      },
    };
    const created = await request(server)
      .post(`${ROOT}/from-template`)
      .set('Authorization', publisher.auth)
      .send(body)
      .expect(201);
    expect(created.body).toMatchObject({
      code: 0,
      data: { replayed: false, createdStatusCode: 'draft' },
    });
    const id = created.body.data.activityId as string;
    evidence.activityId = id;
    const replay = await request(server)
      .post(`${ROOT}/from-template`)
      .set('Authorization', publisher.auth)
      .send(body)
      .expect(201);
    expect(replay.body.data).toMatchObject({ activityId: id, replayed: true });
    expectBizError(
      await request(server)
        .post(`${ROOT}/from-template`)
        .set('Authorization', publisher.auth)
        .send({ ...body, instance: { ...body.instance, capacity: 5 } }),
      BizCode.ACTIVITY_CREATE_FROM_TEMPLATE_OPERATION_KEY_CONFLICT,
    );
    expect(await db.activity.count()).toBe(1);
    expectBizError(
      await request(server).get(`${ROOT}/${id}/simple-draft`).set('Authorization', outsider.auth),
      BizCode.ACTIVITY_NOT_FOUND,
    );
    let draft = (
      await request(server)
        .get(`${ROOT}/${id}/simple-draft`)
        .set('Authorization', publisher.auth)
        .expect(200)
    ).body.data as {
      draftHash: string;
      places: object[];
      instance: { capacity: number | null };
      session: { endAt: string };
      review: unknown;
      editable: boolean;
    };
    expect(draft.instance.capacity).toBe(4);
    expect(draft.session.endAt).toBe(body.endAt);
    const save = {
      title: '修改后的本次安排',
      organizationId,
      startAt: '2099-09-02T00:00:00.000Z',
      endAt: '2099-09-02T04:00:00.000Z',
      location: '新集合点',
      expectedDraftHash: draft.draftHash,
      instance: {
        capacity: 6,
        registrationDeadline: null,
        description: '修改后的说明',
        registrationNotes: null,
      },
      places: [
        {
          roleCode: 'primary',
          visibilityCode: 'staff',
          inline: { name: '新集合点', addressText: '新集合点', checkInEligible: false },
        },
      ],
    };
    const saved = await request(server)
      .put(`${ROOT}/${id}/simple-draft`)
      .set('Authorization', publisher.auth)
      .send(save)
      .expect(200);
    expect(saved.body.data).toMatchObject({
      title: save.title,
      location: save.location,
      instance: save.instance,
      session: {
        startAt: save.startAt,
        endAt: save.endAt,
        capacity: 6,
        checkInCloseAt: '2099-09-02T00:20:00.000Z',
        checkOutOpenAt: '2099-09-02T03:40:00.000Z',
      },
      position: { capacity: 6, startAt: null, endAt: null },
    });
    const xids = await db.$queryRaw<
      Array<{ relation: string; xid: string }>
    >`SELECT 'activity' AS relation, xmin::text AS xid FROM "Activity" WHERE id=${id} UNION ALL SELECT 'session', xmin::text FROM "ActivitySession" WHERE "activityId"=${id} UNION ALL SELECT 'position', xmin::text FROM "ActivitySessionPosition" WHERE "activityId"=${id} UNION ALL SELECT 'place', xmin::text FROM "ActivityPlace" WHERE "activityId"=${id} UNION ALL SELECT 'audit', xmin::text FROM audit_logs WHERE "resourceId"=${id} AND context->'extra'->>'operation'='simple-draft-update'`;
    expect(xids).toHaveLength(6);
    expect(new Set(xids.map((x) => x.xid)).size).toBe(1);
    evidence.atomicSave = {
      xid: xids[0].xid,
      relations: xids.map((x) => x.relation),
      status: 'committed',
    };
    expectBizError(
      await request(server)
        .put(`${ROOT}/${id}/simple-draft`)
        .set('Authorization', publisher.auth)
        .send(save),
      BizCode.ACTIVITY_SIMPLE_DRAFT_STALE,
    );
    draft = saved.body.data;
    const ids = saved.body.data as { session: { id: string }; position: { id: string } };
    const professionalSession = `/api/app/v1/my/managed-activities/${id}/sessions/${ids.session.id}`;
    const professionalPosition = `${professionalSession}/positions/${ids.position.id}`;
    const configuration = async () =>
      JSON.stringify(
        await db.activity.findUniqueOrThrow({
          where: { id },
          include: {
            sessions: { orderBy: { id: 'asc' } },
            sessionPositions: { orderBy: { id: 'asc' } },
            activityPlaces: { orderBy: { id: 'asc' } },
          },
        }),
      );
    const guardedShapes: string[] = [];
    for (const shape of [
      {
        label: 'shortened position',
        path: professionalPosition,
        change: { startAt: '2099-09-02T00:30:00.000Z', endAt: '2099-09-02T03:30:00.000Z' },
        restore: { startAt: null, endAt: null },
      },
      {
        label: 'different check-in window',
        path: professionalSession,
        change: { checkInCloseAt: '2099-09-02T00:25:00.000Z' },
        restore: { checkInCloseAt: '2099-09-02T00:20:00.000Z' },
      },
    ]) {
      await request(server)
        .patch(shape.path)
        .set('Authorization', publisher.auth)
        .send(shape.change)
        .expect(200);
      const beforeReject = await configuration();
      expectBizError(
        await request(server)
          .get(`${ROOT}/${id}/simple-draft`)
          .set('Authorization', publisher.auth),
        BizCode.BAD_REQUEST,
      );
      expectBizError(
        await request(server)
          .put(`${ROOT}/${id}/simple-draft`)
          .set('Authorization', publisher.auth)
          .send({ ...save, expectedDraftHash: draft.draftHash }),
        BizCode.BAD_REQUEST,
      );
      expect(await configuration()).toBe(beforeReject);
      guardedShapes.push(shape.label);
      // Restore explicitly through the same existing business API; the simple route never repairs it.
      await request(server)
        .patch(shape.path)
        .set('Authorization', publisher.auth)
        .send(shape.restore)
        .expect(200);
    }
    evidence.currentShapeGuard = {
      professionalApi: 'ordinary owner, real existing PATCH',
      rejectedWithoutOverwrite: guardedShapes,
    };
    draft = (
      await request(server)
        .get(`${ROOT}/${id}/simple-draft`)
        .set('Authorization', publisher.auth)
        .expect(200)
    ).body.data;
    const beforeFailure = JSON.stringify(
      await db.activity.findUniqueOrThrow({
        where: { id },
        include: {
          sessions: { orderBy: { id: 'asc' } },
          sessionPositions: { orderBy: { id: 'asc' } },
          activityPlaces: { orderBy: { id: 'asc' } },
        },
      }),
    );
    let failedXid = '';
    const auditFailure = jest
      .spyOn(app.get(ActivityDraftAuditRecorder), 'log')
      .mockImplementationOnce(async ({ tx }) => {
        failedXid = (
          await tx.$queryRaw<{ xid: string }[]>`SELECT pg_current_xact_id()::text AS xid`
        )[0].xid;
        throw new BizException(BizCode.INTERNAL_ERROR);
      });
    expectBizError(
      await request(server)
        .put(`${ROOT}/${id}/simple-draft`)
        .set('Authorization', publisher.auth)
        .send({ ...save, title: '必须回滚', expectedDraftHash: draft.draftHash }),
      BizCode.INTERNAL_ERROR,
    );
    auditFailure.mockRestore();
    expect(
      JSON.stringify(
        await db.activity.findUniqueOrThrow({
          where: { id },
          include: {
            sessions: { orderBy: { id: 'asc' } },
            sessionPositions: { orderBy: { id: 'asc' } },
            activityPlaces: { orderBy: { id: 'asc' } },
          },
        }),
      ),
    ).toBe(beforeFailure);
    const status = await db.$queryRaw<
      { state: string }[]
    >`SELECT pg_xact_status(${failedXid}::xid8)::text AS state`;
    expect(status[0].state).toBe('aborted');
    evidence.auditFailureRollback = { xid: failedXid, status: status[0].state };
    expectBizError(
      await request(server)
        .put(`${ROOT}/${id}/simple-draft`)
        .set('Authorization', publisher.auth)
        .send({
          ...save,
          startAt: '2102-09-01T00:00:00Z',
          endAt: '2102-09-01T03:00:00Z',
          expectedDraftHash: draft.draftHash,
        }),
      BizCode.ACTIVITY_TIME_POLICY_SELECTION_POLICY_UNAVAILABLE,
    );
    expect(
      JSON.stringify(
        await db.activity.findUniqueOrThrow({
          where: { id },
          include: {
            sessions: { orderBy: { id: 'asc' } },
            sessionPositions: { orderBy: { id: 'asc' } },
            activityPlaces: { orderBy: { id: 'asc' } },
          },
        }),
      ),
    ).toBe(beforeFailure);

    let pending: Promise<request.Response> | undefined;
    try {
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Activity" WHERE id=${id} FOR UPDATE`;
        pending = request(server)
          .put(`${ROOT}/${id}/simple-draft`)
          .set('Authorization', publisher.auth)
          .send({ ...save, expectedDraftHash: draft.draftHash })
          .then((r) => {
            evidence.waiterResponse = {
              status: r.status,
              code: (r.body as { code?: number }).code,
            };
            return r;
          });
        const deadline = Date.now() + 1500;
        let waiting = false;
        while (Date.now() < deadline) {
          // An autocommit sample uses the same bounded pool and does not retain the blocker's stats snapshot.
          const rows = await db.$queryRaw<
            { pid: number; wait_event_type: string | null; query: string }[]
          >`SELECT pid, wait_event_type, query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' AND wait_event_type='Lock' AND query LIKE '%FROM "Activity"%'`;
          evidence.waiterObservation = rows;
          if (rows.length > 0) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waiting).toBe(true);
        await tx.roleBinding.update({
          where: { id: publisherBindingId },
          data: { deletedAt: new Date() },
        });
      });
      expectBizError(await pending!, BizCode.RBAC_FORBIDDEN);
      evidence.lockedRevocation =
        'real lock wait observed; permission revoked before waiter acquired root; denied without business change';
    } finally {
      await db.roleBinding.update({ where: { id: publisherBindingId }, data: { deletedAt: null } });
    }
    expect(
      JSON.stringify(
        await db.activity.findUniqueOrThrow({
          where: { id },
          include: {
            sessions: { orderBy: { id: 'asc' } },
            sessionPositions: { orderBy: { id: 'asc' } },
            activityPlaces: { orderBy: { id: 'asc' } },
          },
        }),
      ),
    ).toBe(beforeFailure);

    const reviewBody = { operationKey: key('submit'), confirmation: true };
    const submitted = await request(server)
      .post(`${ROOT}/${id}/publish-reviews`)
      .set('Authorization', publisher.auth)
      .send(reviewBody)
      .expect(200);
    const reviewId = submitted.body.data.id as string;
    evidence.reviewId = reviewId;
    expect(submitted.body.data).toMatchObject({
      activityId: id,
      status: 'pending',
      requestType: 'initial',
    });
    const submitReplay = await request(server)
      .post(`${ROOT}/${id}/publish-reviews`)
      .set('Authorization', publisher.auth)
      .send(reviewBody)
      .expect(200);
    expect(submitReplay.body.data.id).toBe(reviewId);
    expect(
      (
        await request(server)
          .get(`${ROOT}/${id}/simple-draft`)
          .set('Authorization', publisher.auth)
          .expect(200)
      ).body.data,
    ).toMatchObject({
      editable: false,
      statusCode: 'draft',
      review: { id: reviewId, status: 'pending' },
    });
    expectBizError(
      await request(server)
        .put(`${ROOT}/${id}/simple-draft`)
        .set('Authorization', publisher.auth)
        .send({ ...save, expectedDraftHash: draft.draftHash }),
      BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING,
    );
    expectBizError(
      await request(server)
        .post(`/api/admin/v1/activity-publish-reviews/${reviewId}/approve`)
        .set('Authorization', publisher.auth)
        .send({ operationKey: key('self_review'), requiresInsuranceConfirmed: true }),
      BizCode.ACTIVITY_PUBLISH_REVIEW_SELF_REVIEW_FORBIDDEN,
    );
    await request(server)
      .get(`/api/admin/v1/activity-publish-reviews/${reviewId}`)
      .set('Authorization', reviewer.auth)
      .expect(200);
    const approved = await request(server)
      .post(`/api/admin/v1/activity-publish-reviews/${reviewId}/approve`)
      .set('Authorization', reviewer.auth)
      .send({ operationKey: key('approve'), requiresInsuranceConfirmed: true })
      .expect(200);
    expect(approved.body.data.status).toBe('approved');
    const final = await request(server)
      .get(`${ROOT}/${id}/simple-draft`)
      .set('Authorization', publisher.auth)
      .expect(200);
    expect(final.body.data).toMatchObject({
      statusCode: 'published',
      editable: false,
      review: { status: 'approved' },
    });
    evidence.final = {
      activityId: id,
      statusCode: final.body.data.statusCode,
      reviewStatus: approved.body.data.status,
      templateId: final.body.data.selectedTemplateVersionId,
      definitionHash: final.body.data.definitionHash,
    };
    evidence.outcome = 'PASS';
  }, 30000);

  async function confirmationDraft(auth = publisher.auth, templateVersionId = templateId) {
    const created = await request(httpServer(app))
      .post(`${ROOT}/from-template`)
      .set('Authorization', auth)
      .send({
        operationKey: key('confirm_create'),
        templateVersionId,
        title: '合成确认版本',
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
    const id = created.body.data.activityId as string;
    const read = () =>
      request(httpServer(app))
        .get(`${ROOT}/${id}/simple-draft`)
        .set('Authorization', auth)
        .expect(200);
    const draft = (await read()).body.data;
    return { id, draft, read };
  }

  it('confirmation: preserves legacy submission and its exact request fingerprint after an intervening edit', async () => {
    const { id } = await confirmationDraft();
    await db.activity.update({ where: { id }, data: { title: '旧客户端最新提交' } });
    const body = { operationKey: key('confirm_legacy'), confirmation: true };
    const first = await request(httpServer(app))
      .post(`${ROOT}/${id}/publish-reviews`)
      .set('Authorization', publisher.auth)
      .send(body)
      .expect(200);
    const stored = await db.activityPublishReview.findUniqueOrThrow({
      where: { operationKey: body.operationKey },
    });
    expect(stored.requestHash).toBe(
      hashCanonical({ action: 'publish-review-submit:initial', activityId: id, payload: body }),
    );
    const retry = await request(httpServer(app))
      .post(`${ROOT}/${id}/publish-reviews`)
      .set('Authorization', publisher.auth)
      .send(body)
      .expect(200);
    expect(retry.body.data).toEqual(first.body.data);
  });

  it('confirmation: replays the full versioned request before checking the changed review hash and rejects key reuse', async () => {
    const { id, draft, read } = await confirmationDraft();
    const body = {
      operationKey: key('confirm_once'),
      confirmation: true,
      expectedDraftHash: draft.draftHash,
    };
    const post = (payload: object, auth = publisher.auth) =>
      request(httpServer(app))
        .post(`${ROOT}/${id}/publish-reviews`)
        .set('Authorization', auth)
        .send(payload);
    const first = await post(body).expect(200);
    const after = (await read()).body.data;
    expect(after.draftHash).not.toBe(draft.draftHash);
    const effects = await db.auditLog.count({ where: { resourceId: id } });
    expect((await post(body).expect(200)).body.data).toEqual(first.body.data);
    expect(await db.auditLog.count({ where: { resourceId: id } })).toBe(effects);
    expect(await db.activityPublishReview.count({ where: { activityId: id } })).toBe(1);
    expectBizError(
      await post({ ...body, expectedDraftHash: after.draftHash }),
      BizCode.ACTIVITY_PUBLISH_REVIEW_OPERATION_KEY_CONFLICT,
    );
    expectBizError(
      await post({ operationKey: body.operationKey, confirmation: true }),
      BizCode.ACTIVITY_PUBLISH_REVIEW_OPERATION_KEY_CONFLICT,
    );
    expectBizError(await post(body, outsider.auth), BizCode.ACTIVITY_NOT_FOUND);
    expectBizError(
      await post({ ...body, operationKey: key('confirm_stale_new') }),
      BizCode.ACTIVITY_SIMPLE_DRAFT_STALE,
    );
  });

  it.each([false, true])(
    'confirmation: real simple-save lock race, versioned=%s',
    async (versioned) => {
      const { id, draft, read } = await confirmationDraft();
      let release!: () => void, reached!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const saved = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const audit = app.get(ActivityDraftAuditRecorder);
      const original = audit.log.bind(audit);
      let blockerPid = 0;
      const spy = jest.spyOn(audit, 'log').mockImplementation(async (input) => {
        await original(input);
        if (input.activityId === id && input.operation === 'simple-draft-update') {
          blockerPid = (
            await input.tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
          )[0].pid;
          reached();
          await gate;
        }
      });
      const body = {
        operationKey: key('confirm_race'),
        confirmation: true,
        ...(versioned ? { expectedDraftHash: draft.draftHash } : {}),
      };
      let submit: Promise<request.Response> | undefined;
      const save = request(httpServer(app))
        .put(`${ROOT}/${id}/simple-draft`)
        .set('Authorization', publisher.auth)
        .send({
          title: '确认后另一次保存',
          organizationId,
          startAt: draft.startAt,
          endAt: draft.endAt,
          location: draft.location,
          instance: draft.instance,
          expectedDraftHash: draft.draftHash,
          places: [
            {
              roleCode: 'primary',
              visibilityCode: 'staff',
              inline: { name: '合成会场', addressText: '合成会场', checkInEligible: false },
            },
          ],
        })
        .then((response) => response);
      try {
        let barrierTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            saved,
            save.then(() => {
              throw new Error('save did not reach the in-transaction barrier');
            }),
            new Promise<never>((_resolve, reject) => {
              barrierTimer = setTimeout(() => reject(new Error('save barrier timeout')), 3000);
            }),
          ]);
        } finally {
          clearTimeout(barrierTimer);
        }
        submit = request(httpServer(app))
          .post(`${ROOT}/${id}/publish-reviews`)
          .set('Authorization', publisher.auth)
          .send(body)
          .then((response) => response);
        let waiterPid = 0;
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          const rows = await db.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND ${blockerPid} = ANY(pg_blocking_pids(pid))
          AND query LIKE '%FROM "Activity"%FOR UPDATE%'`;
          if (rows.length === 1) {
            waiterPid = rows[0].pid;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiterPid).toBeGreaterThan(0);
        expect(waiterPid).not.toBe(blockerPid);
      } finally {
        release();
        await Promise.allSettled([save, ...(submit ? [submit] : [])]);
        spy.mockRestore();
      }
      expect((await save).status).toBe(200);
      if (!versioned) {
        expect((await submit).status).toBe(200);
        expect((await read()).body.data.title).toBe('确认后另一次保存');
        return;
      }
      expectBizError(await submit, BizCode.ACTIVITY_SIMPLE_DRAFT_STALE);
      expect(await db.activityPublishReview.count({ where: { activityId: id } })).toBe(0);
      expect(
        await db.auditLog.count({
          where: {
            resourceId: id,
            context: { path: ['extra', 'operation'], equals: 'publish-review-submit' },
          },
        }),
      ).toBe(0);
      const refreshed = (await read()).body.data;
      expect(refreshed.title).toBe('确认后另一次保存');
      await request(httpServer(app))
        .post(`${ROOT}/${id}/publish-reviews`)
        .set('Authorization', publisher.auth)
        .send({ ...body, expectedDraftHash: refreshed.draftHash })
        .expect(200);
    },
  );

  it.each([null, '', 'invalid', 'A'.repeat(64), 1])(
    'confirmation: rejects malformed version %p',
    async (expectedDraftHash) => {
      const { id } = await confirmationDraft();
      expectBizError(
        await request(httpServer(app))
          .post(`${ROOT}/${id}/publish-reviews`)
          .set('Authorization', publisher.auth)
          .send({ operationKey: key('confirm_bad'), confirmation: true, expectedDraftHash }),
        BizCode.BAD_REQUEST,
        { strictMessage: false },
      );
      expect(await db.activityPublishReview.count({ where: { activityId: id } })).toBe(0);
    },
  );

  async function configureQualification(
    id: string,
    level: 'activity' | 'session' | 'position',
    auth = publisher.auth,
  ) {
    const session = await db.activitySession.findFirstOrThrow({ where: { activityId: id } });
    const position = await db.activitySessionPosition.findFirstOrThrow({
      where: { activityId: id },
    });
    return await request(httpServer(app))
      .put(`/api/app/v1/my/managed-activities/${id}/qualification-rules`)
      .set('Authorization', auth)
      .send({
        ruleSets: [
          {
            scope: {
              sessionId: level === 'activity' ? null : session.id,
              positionId: level === 'position' ? position.id : null,
            },
            rules: [
              {
                ruleTypeCode: 'age',
                enforcementCode: 'block',
                operator: 'between',
                minYears: 18,
                sortOrder: 10,
              },
            ],
          },
        ],
      })
      .expect(200);
  }

  it.each(['activity', 'session', 'position'] as const)(
    'qualification guard: rejects invisible %s rules without changing them, while preserving legacy submit',
    async (level) => {
      const { id, draft, read } = await confirmationDraft();
      await configureQualification(id, level);
      expect((await read()).body.data).toEqual(draft);
      const rules = await db.activityQualificationRuleSet.findMany({
        where: { activityId: id },
        include: { rules: true },
      });
      expect(rules).toHaveLength(1);
      const post = (body: object) =>
        request(httpServer(app))
          .post(`${ROOT}/${id}/publish-reviews`)
          .set('Authorization', publisher.auth)
          .send(body);
      const beforeAudit = await db.auditLog.count({ where: { resourceId: id } });
      const body = {
        operationKey: key('qual_block'),
        confirmation: true,
        expectedDraftHash: draft.draftHash,
      };
      expectBizError(await post(body), BizCode.ACTIVITY_SIMPLE_REVIEW_REQUIRES_PROFESSIONAL_FLOW);
      expect(await db.activityPublishReview.count({ where: { activityId: id } })).toBe(0);
      expect(await db.auditLog.count({ where: { resourceId: id } })).toBe(beforeAudit);
      expect(
        await db.activityQualificationRuleSet.findMany({
          where: { activityId: id },
          include: { rules: true },
        }),
      ).toEqual(rules);
      // A rejected versioned request did not reserve its key; the legacy contract stays unchanged.
      const legacy = { operationKey: body.operationKey, confirmation: true };
      const first = await post(legacy).expect(200);
      expect((await post(legacy).expect(200)).body.data).toEqual(first.body.data);
      const stored = await db.activityPublishReview.findUniqueOrThrow({
        where: { id: first.body.data.id },
      });
      expect(stored.requestHash).toBe(
        hashCanonical({ action: 'publish-review-submit:initial', activityId: id, payload: legacy }),
      );
      expect(
        (stored.snapshot as { qualificationRuleSets: { ruleSets: unknown[] } })
          .qualificationRuleSets.ruleSets,
      ).toHaveLength(1);
    },
  );

  it('qualification guard: a normal explicit removal permits submission and keeps retired rule history', async () => {
    const { id, draft, read } = await confirmationDraft();
    await configureQualification(id, 'activity');
    await request(httpServer(app))
      .put(`/api/app/v1/my/managed-activities/${id}/qualification-rules`)
      .set('Authorization', publisher.auth)
      .send({ ruleSets: [] })
      .expect(200);
    expect((await read()).body.data).toEqual(draft);
    const rows = await db.activityQualificationRuleSet.findMany({ where: { activityId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].statusCode).toBe('retired');
    await request(httpServer(app))
      .post(`${ROOT}/${id}/publish-reviews`)
      .set('Authorization', publisher.auth)
      .send({
        operationKey: key('qual_removed'),
        confirmation: true,
        expectedDraftHash: draft.draftHash,
      })
      .expect(200);
  });

  it('qualification guard: conservatively rejects an active rule set attached to a draft', async () => {
    const { id, draft } = await confirmationDraft();
    await configureQualification(id, 'position');
    // A defensive persisted-state fixture; ordinary draft editing creates draft rule sets.
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${id} FOR UPDATE`;
      const row = await tx.activityQualificationRuleSet.findFirstOrThrow({
        where: { activityId: id },
      });
      await tx.activityQualificationRuleSet.update({
        where: { id: row.id },
        data: { statusCode: 'active' },
      });
    });
    expectBizError(
      await request(httpServer(app))
        .post(`${ROOT}/${id}/publish-reviews`)
        .set('Authorization', publisher.auth)
        .send({
          operationKey: key('qual_active'),
          confirmation: true,
          expectedDraftHash: draft.draftHash,
        }),
      BizCode.ACTIVITY_SIMPLE_REVIEW_REQUIRES_PROFESSIONAL_FLOW,
    );
    expect(await db.activityPublishReview.count({ where: { activityId: id } })).toBe(0);
    expect(
      await db.activityQualificationRuleSet.count({
        where: { activityId: id, statusCode: 'active' },
      }),
    ).toBe(1);
  });

  it('qualification guard: rejects a real rule-addition transaction that wins the Activity lock after confirmation', async () => {
    const { id, draft, read } = await confirmationDraft();
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const changed = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const audit = app.get(ActivityDraftAuditRecorder);
    const original = audit.log.bind(audit);
    let blockerPid = 0;
    const spy = jest.spyOn(audit, 'log').mockImplementation(async (input) => {
      await original(input);
      if (input.activityId === id && input.changedFields?.includes('qualificationRuleSets')) {
        blockerPid = (
          await input.tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
        )[0].pid;
        reached();
        await gate;
      }
    });
    const save = configureQualification(id, 'position');
    let submit: Promise<request.Response> | undefined;
    try {
      let barrierTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          changed,
          save.then(() => {
            throw new Error('rule update did not reach its transaction barrier');
          }),
          new Promise<never>((_resolve, reject) => {
            barrierTimer = setTimeout(() => reject(new Error('rule barrier timeout')), 3000);
          }),
        ]);
      } finally {
        clearTimeout(barrierTimer);
      }
      submit = request(httpServer(app))
        .post(`${ROOT}/${id}/publish-reviews`)
        .set('Authorization', publisher.auth)
        .send({
          operationKey: key('qual_race'),
          confirmation: true,
          expectedDraftHash: draft.draftHash,
        })
        .then((response) => response);
      let waiterPid = 0;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const rows = await db.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND ${blockerPid} = ANY(pg_blocking_pids(pid))
          AND query LIKE '%FROM "Activity"%FOR UPDATE%'`;
        if (rows.length === 1) {
          waiterPid = rows[0].pid;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiterPid).toBeGreaterThan(0);
      expect(waiterPid).not.toBe(blockerPid);
    } finally {
      release();
      await Promise.allSettled([save, ...(submit ? [submit] : [])]);
      spy.mockRestore();
    }
    await save;
    expectBizError(await submit, BizCode.ACTIVITY_SIMPLE_REVIEW_REQUIRES_PROFESSIONAL_FLOW);
    expect((await read()).body.data).toEqual(draft);
    expect(await db.activityPublishReview.count({ where: { activityId: id } })).toBe(0);
    expect(
      await db.activityQualificationRuleSet.count({
        where: { activityId: id, statusCode: 'draft' },
      }),
    ).toBe(1);
    expect(
      await db.auditLog.count({
        where: {
          resourceId: id,
          context: { path: ['extra', 'operation'], equals: 'publish-review-submit' },
        },
      }),
    ).toBe(0);
  });

  it('qualification guard: authorizes before exact replay but checks new rules only after replay', async () => {
    const actor = await user('confirm_owner');
    const binding = await grant(actor.id, [
      'activity.create.record',
      'activity.update.record',
      'activity.time-policy.read',
      'activity.time-policy.select',
      'activity.contribution-policy.read',
      'activity.contribution-policy.select',
    ]);
    const { id, draft } = await confirmationDraft(actor.auth);
    const body = {
      operationKey: key('qual_replay'),
      confirmation: true,
      expectedDraftHash: draft.draftHash,
    };
    const post = (payload: object, auth = actor.auth) =>
      request(httpServer(app))
        .post(`${ROOT}/${id}/publish-reviews`)
        .set('Authorization', auth)
        .send(payload);
    const first = await post(body).expect(200);
    await configureQualification(id, 'activity', actor.auth);
    const effects = await db.auditLog.count({ where: { resourceId: id } });
    expect((await post(body).expect(200)).body.data).toEqual(first.body.data);
    expectBizError(
      await post({ ...body, expectedDraftHash: '0'.repeat(64) }),
      BizCode.ACTIVITY_PUBLISH_REVIEW_OPERATION_KEY_CONFLICT,
    );
    expectBizError(
      await post({ ...body, operationKey: key('qual_new') }),
      BizCode.ACTIVITY_SIMPLE_REVIEW_REQUIRES_PROFESSIONAL_FLOW,
    );
    expectBizError(await post(body, outsider.auth), BizCode.ACTIVITY_NOT_FOUND);
    const revoker = await grant(publisher.id, ['role-binding.delete.record']);
    await db.roleBinding.update({
      where: { id: revoker.id },
      data: { scopeType: 'GLOBAL', scopeOrgId: null },
    });
    await request(httpServer(app))
      .delete(`/api/admin/v1/role-bindings/${binding.id}`)
      .set('Authorization', publisher.auth)
      .expect(200);
    expectBizError(await post(body), BizCode.FORBIDDEN);
    expectBizError(
      await post({ ...body, operationKey: key('qual_revoked_new') }),
      BizCode.FORBIDDEN,
    );
    expect(await db.auditLog.count({ where: { resourceId: id } })).toBe(effects);
    expect(await db.activityPublishReview.count({ where: { activityId: id } })).toBe(1);
    expect(
      await db.activityQualificationRuleSet.count({
        where: { activityId: id, statusCode: 'draft' },
      }),
    ).toBe(1);
  });

  it.each(['activity', 'session'] as const)(
    'confirmation coverage: hidden %s values change the hash but are still absent from the simple response',
    async (scope) => {
      const { id, draft, read } = await confirmationDraft();
      const preview = () =>
        db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${id} FOR UPDATE`;
          return app.get(ActivityPublishProposalV2Service).buildInitial(tx, id);
        });
      const before = await preview();
      // Synthetic persisted-state control, not a claim that this exercises a UI editing route.
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${id} FOR UPDATE`;
        if (scope === 'activity') {
          await tx.activity.update({ where: { id }, data: { archiveWaitingDays: 13 } });
        } else {
          const session = await tx.activitySession.findFirstOrThrow({ where: { activityId: id } });
          await tx.activitySession.update({
            where: { id: session.id },
            data: { evacuationPoint: '合成撤离点' },
          });
        }
      });
      const after = await preview();
      if (scope === 'activity') {
        expect(before.activity.archiveWaitingDays).not.toBe(13);
        expect(after.activity.archiveWaitingDays).toBe(13);
      } else {
        expect(before.sessions[0].evacuationPoint).not.toBe('合成撤离点');
        expect(after.sessions[0].evacuationPoint).toBe('合成撤离点');
      }
      const current = (await read()).body.data;
      expect(current.draftHash).not.toBe(draft.draftHash);
      expect({ ...current, draftHash: null }).toEqual({ ...draft, draftHash: null });
      expectBizError(
        await request(httpServer(app))
          .post(`${ROOT}/${id}/publish-reviews`)
          .set('Authorization', publisher.auth)
          .send({
            operationKey: key('hidden_stale'),
            confirmation: true,
            expectedDraftHash: draft.draftHash,
          }),
        BizCode.ACTIVITY_SIMPLE_DRAFT_STALE,
      );
      expect(await db.activityPublishReview.count({ where: { activityId: id } })).toBe(0);
    },
  );

  it.each(['activity', 'session', 'position', 'form'] as const)(
    'simple whitelist: rejects refreshed hidden %s configuration, preserves it for professional approval',
    async (kind) => {
      const { id, draft, read } = await confirmationDraft();
      const sessionId = draft.session.id as string;
      const positionId = draft.position.id as string;
      const managed = `/api/app/v1/my/managed-activities/${id}`;
      const preview = () =>
        db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${id} FOR UPDATE`;
          return app.get(ActivityPublishProposalV2Service).buildInitial(tx, id);
        });
      const before = await preview();
      const genderType = await db.dictType.upsert({
        where: { code: 'gender_requirement' },
        update: {},
        create: { code: 'gender_requirement', label: '合成资格字典' },
      });
      await db.dictItem.upsert({
        where: { typeId_code: { typeId: genderType.id, code: 'synthetic_requirement' } },
        update: {},
        create: { typeId: genderType.id, code: 'synthetic_requirement', label: '合成限定' },
      });
      let path = managed;
      let payload: Record<string, unknown>;
      if (kind === 'activity') {
        payload = {
          genderRequirementCode: 'synthetic_requirement',
          isPublicRegistration: !before.activity.isPublicRegistration,
          requiresInsurance: !before.activity.requiresInsurance,
          registrationModeCode: 'invitation_only',
          visibilityCode: 'invitation',
          defaultLocationRequired: true,
          defaultCheckInRadiusMeters: 250,
          archiveWaitingDays: 13,
          content: { text: '合成新增正文' },
          registrationSchema: { syntheticNote: { type: 'string' } },
          locationLongitude: 120.25,
          locationLatitude: 30.25,
        };
      } else if (kind === 'session') {
        path += `/sessions/${sessionId}`;
        payload = {
          locationText: '合成另一集合地文字',
          meetingPoint: '合成集合点',
          executionPoint: '合成执行点',
          evacuationPoint: '合成撤离点',
          longitude: 120.25,
          latitude: 30.25,
          locationRequired: true,
          radiusMeters: 250,
          lateGraceMinutes: 12,
          earlyLeaveThresholdMinutes: 13,
          sortOrder: 9,
        };
      } else if (kind === 'position') {
        // A normal prerequisite for the position's real location policy, also hidden by simple GET.
        await request(httpServer(app))
          .patch(`${managed}/sessions/${sessionId}`)
          .set('Authorization', publisher.auth)
          .send({ longitude: 120.25, latitude: 30.25, locationRequired: true, radiusMeters: 300 })
          .expect(200);
        const actor = await db.user.findUniqueOrThrow({
          where: { id: publisher.id },
          select: { memberId: true },
        });
        path += `/sessions/${sessionId}/positions/${positionId}`;
        payload = {
          genderRequirementCode: 'synthetic_requirement',
          locationRequired: true,
          radiusMeters: 250,
          leaderMemberId: actor.memberId,
          description: '合成岗位职责',
          equipmentNotes: '合成必需装备',
          sortOrder: 9,
        };
      } else {
        path += '/registration-form';
        payload = {
          form: {
            fields: [
              {
                fieldCode: 'synthetic_note',
                typeCode: 'short_text',
                label: '合成必填说明',
                required: true,
                visibilityCode: 'self_only',
                exportable: false,
                sortOrder: 1,
                minLength: 1,
                maxLength: 100,
              },
            ],
          },
        };
      }
      const edit =
        kind === 'form' ? request(httpServer(app)).put(path) : request(httpServer(app)).patch(path);
      await edit.set('Authorization', publisher.auth).send(payload).expect(200);
      const current = (await read()).body.data;
      expect(current.draftHash).not.toBe(draft.draftHash);
      expect({ ...current, draftHash: null }).toEqual({ ...draft, draftHash: null });
      const after = await preview();
      expect(hashCanonical(after)).not.toBe(hashCanonical(before));
      const project = (snapshot: typeof after): Record<string, unknown> =>
        kind === 'activity'
          ? { ...snapshot.activity }
          : kind === 'session'
            ? { ...snapshot.sessions[0] }
            : kind === 'position'
              ? { ...snapshot.sessions[0].positions[0] }
              : { registrationForm: snapshot.registrationForm };
      const oldFields = project(before),
        newFields = project(after);
      const changedFields = Object.keys(newFields).filter(
        (key) => JSON.stringify(newFields[key]) !== JSON.stringify(oldFields[key]),
      );
      expect(changedFields.length).toBeGreaterThan(0);
      if (kind !== 'form') {
        for (const [field, value] of Object.entries(payload)) {
          // Proposal decimals have their established canonical string representation.
          expect(newFields[field]).toEqual(
            ['longitude', 'latitude', 'locationLongitude', 'locationLatitude'].includes(field)
              ? String(value)
              : value,
          );
          expect(changedFields).toContain(field);
        }
      } else {
        expect(after.registrationForm?.definition.fields[0]).toMatchObject({
          fieldCode: 'synthetic_note',
          required: true,
        });
      }
      const body = {
        operationKey: key('hidden_http_submit'),
        confirmation: true,
        expectedDraftHash: draft.draftHash,
      };
      const post = (payload: object) =>
        request(httpServer(app))
          .post(`${ROOT}/${id}/publish-reviews`)
          .set('Authorization', publisher.auth)
          .send(payload);
      expectBizError(await post(body), BizCode.ACTIVITY_SIMPLE_DRAFT_STALE);
      expect(await db.activityPublishReview.count({ where: { activityId: id } })).toBe(0);
      expectBizError(
        await post({ ...body, expectedDraftHash: current.draftHash }),
        BizCode.ACTIVITY_SIMPLE_REVIEW_REQUIRES_PROFESSIONAL_FLOW,
      );
      expect(await db.activityPublishReview.count({ where: { activityId: id } })).toBe(0);
      expect(await preview()).toEqual(after);
      const submitted = await request(httpServer(app))
        .post(`${managed}/publish-reviews`)
        .set('Authorization', publisher.auth)
        .send({ operationKey: body.operationKey, confirmation: true })
        .expect(200);
      const reviewId = submitted.body.data.id;
      const stored = await db.activityPublishReview.findUniqueOrThrow({ where: { id: reviewId } });
      expect(stored.snapshot).toEqual(JSON.parse(JSON.stringify(after)));
      await request(httpServer(app))
        .get(`/api/admin/v1/activity-publish-reviews/${reviewId}`)
        .set('Authorization', reviewer.auth)
        .expect(200);
      await request(httpServer(app))
        .post(`/api/admin/v1/activity-publish-reviews/${reviewId}/approve`)
        .set('Authorization', reviewer.auth)
        .send({ operationKey: key('hidden_http_approve'), requiresInsuranceConfirmed: true })
        .expect(200);
      expect(
        (await db.activity.findUniqueOrThrow({ where: { id }, select: { statusCode: true } }))
          .statusCode,
      ).toBe('published');
      expect(
        (await db.activityPublishReview.findUniqueOrThrow({ where: { id: reviewId } })).status,
      ).toBe('approved');
      const applied =
        kind === 'activity'
          ? await db.activity.findUniqueOrThrow({ where: { id } })
          : kind === 'session'
            ? await db.activitySession.findUniqueOrThrow({ where: { id: sessionId } })
            : kind === 'position'
              ? await db.activitySessionPosition.findUniqueOrThrow({ where: { id: positionId } })
              : null;
      if (applied) {
        for (const [field, value] of Object.entries(payload)) {
          const actual = (applied as unknown as Record<string, unknown>)[field];
          expect(
            ['longitude', 'latitude', 'locationLongitude', 'locationLatitude'].includes(field)
              ? String(actual)
              : actual,
          ).toEqual(
            ['longitude', 'latitude', 'locationLongitude', 'locationLatitude'].includes(field)
              ? String(value)
              : value,
          );
        }
      } else {
        const form = await db.registrationFormVersion.findFirstOrThrow({
          where: { activityId: id, statusCode: 'active' },
          include: { fields: true },
        });
        expect(form.fields[0]).toMatchObject({ fieldCode: 'synthetic_note', required: true });
      }
      expect(changedFields).toHaveLength(
        kind === 'activity' ? 12 : kind === 'session' ? 11 : kind === 'position' ? 7 : 1,
      );
    },
  );

  it('simple whitelist: retains explicit normal template defaults and its governed form through approval', async () => {
    const source = await db.activityTemplate.findUniqueOrThrow({ where: { id: templateId } });
    const definition = JSON.parse(JSON.stringify(source.definitionJson));
    Object.assign(definition.activity, {
      isPublicRegistration: false,
      requiresInsurance: true,
      registrationModeCode: 'invitation_only',
      visibilityCode: 'invitation',
      defaultLocationRequired: false,
      defaultCheckInRadiusMeters: 250,
      archiveWaitingDays: 0,
    });
    Object.assign(definition.sessions[0], {
      lateGraceMinutes: 12,
      earlyLeaveThresholdMinutes: 13,
      sortOrder: 9,
    });
    Object.assign(definition.sessions[0].positions[0], {
      locationRequired: false,
      description: '模板固定职责',
      equipmentNotes: '模板固定装备',
      sortOrder: 8,
    });
    definition.registrationForm = {
      fields: [
        {
          fieldCode: 'travel_note',
          typeCode: 'short_text',
          label: '模板固定说明',
          required: false,
          visibilityCode: 'self_only',
          exportable: false,
          sortOrder: 0,
          governance: {
            purposeCode: 'transport_logistics',
            dataClassCode: 'ordinary',
            retentionPolicyCode: 'activity_lifecycle',
            maskingPolicyCode: 'none',
            prefillSourceCode: null,
          },
        },
      ],
    };
    const selected = await db.activityTemplate.create({
      data: {
        code: key('whitelist_template'),
        name: '合成固定默认模板',
        activityTypeCode: 'training',
        version: source.version + 1,
        familyId: source.familyId,
        statusCode: 'draft',
        schemaVersion: 5,
        definitionJson: definition,
        definitionHash: computeActivityTemplateDefinitionHash({ schemaVersion: 5, definition }),
        effectiveFrom: source.effectiveFrom,
      },
    });
    await db.activityTemplate.update({
      where: { id: selected.id },
      data: { statusCode: 'active' },
    });
    const { id, draft } = await confirmationDraft(publisher.auth, selected.id);
    const submitted = await request(httpServer(app))
      .post(`${ROOT}/${id}/publish-reviews`)
      .set('Authorization', publisher.auth)
      .send({
        operationKey: key('whitelist_normal'),
        confirmation: true,
        expectedDraftHash: draft.draftHash,
      })
      .expect(200);
    await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${submitted.body.data.id}/approve`)
      .set('Authorization', reviewer.auth)
      .send({ operationKey: key('whitelist_normal_approve'), requiresInsuranceConfirmed: true })
      .expect(200);
    const row = await db.activity.findUniqueOrThrow({
      where: { id },
      include: { sessions: { include: { positions: true } } },
    });
    expect(row).toMatchObject({
      statusCode: 'published',
      isPublicRegistration: false,
      requiresInsurance: true,
      registrationModeCode: 'invitation_only',
      visibilityCode: 'invitation',
      defaultLocationRequired: false,
      defaultCheckInRadiusMeters: 250,
      archiveWaitingDays: 0,
    });
    expect(row.sessions[0]).toMatchObject({
      lateGraceMinutes: 12,
      earlyLeaveThresholdMinutes: 13,
      sortOrder: 9,
    });
    expect(row.sessions[0].positions[0]).toMatchObject({
      locationRequired: false,
      description: '模板固定职责',
      equipmentNotes: '模板固定装备',
      sortOrder: 8,
    });
    const form = await db.registrationFormVersion.findFirstOrThrow({
      where: { activityId: id, statusCode: 'active' },
      include: { fields: true },
    });
    expect(form.fields[0]).toMatchObject({
      fieldCode: 'travel_note',
      label: '模板固定说明',
      required: false,
      purposeCode: 'transport_logistics',
    });
  });

  it('simple whitelist: observes concurrent professional edit, rejects stale and then rejects refreshed unsupported configuration', async () => {
    const { id, draft, read } = await confirmationDraft();
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const changed = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const audit = app.get(ActivityDraftAuditRecorder);
    const original = audit.log.bind(audit);
    let blockerPid = 0;
    const spy = jest.spyOn(audit, 'log').mockImplementation(async (input) => {
      await original(input);
      if (input.activityId === id && input.operation === 'draft-session-update') {
        blockerPid = (
          await input.tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
        )[0].pid;
        reached();
        await gate;
      }
    });
    const save = request(httpServer(app))
      .patch(`/api/app/v1/my/managed-activities/${id}/sessions/${draft.session.id}`)
      .set('Authorization', publisher.auth)
      .send({ evacuationPoint: '确认后新增撤离点' })
      .expect(200)
      .then((response) => response);
    let submit: Promise<request.Response> | undefined;
    try {
      let barrierTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          changed,
          save.then(() => {
            throw new Error('rule update did not reach its transaction barrier');
          }),
          new Promise<never>((_resolve, reject) => {
            barrierTimer = setTimeout(() => reject(new Error('rule barrier timeout')), 3000);
          }),
        ]);
      } finally {
        clearTimeout(barrierTimer);
      }
      submit = request(httpServer(app))
        .post(`${ROOT}/${id}/publish-reviews`)
        .set('Authorization', publisher.auth)
        .send({
          operationKey: key('qual_race'),
          confirmation: true,
          expectedDraftHash: draft.draftHash,
        })
        .then((response) => response);
      let waiterPid = 0;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const rows = await db.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND ${blockerPid} = ANY(pg_blocking_pids(pid))
          AND query LIKE '%FROM "Activity"%FOR UPDATE%'`;
        if (rows.length === 1) {
          waiterPid = rows[0].pid;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiterPid).toBeGreaterThan(0);
      expect(waiterPid).not.toBe(blockerPid);
    } finally {
      release();
      await Promise.allSettled([save, ...(submit ? [submit] : [])]);
      spy.mockRestore();
    }
    await save;
    expectBizError(await submit, BizCode.ACTIVITY_SIMPLE_DRAFT_STALE);
    const current = (await read()).body.data;
    expect({ ...current, draftHash: null }).toEqual({ ...draft, draftHash: null });
    expect(current.draftHash).not.toBe(draft.draftHash);
    expectBizError(
      await request(httpServer(app))
        .post(`${ROOT}/${id}/publish-reviews`)
        .set('Authorization', publisher.auth)
        .send({
          operationKey: key('whitelist_race_retry'),
          confirmation: true,
          expectedDraftHash: current.draftHash,
        }),
      BizCode.ACTIVITY_SIMPLE_REVIEW_REQUIRES_PROFESSIONAL_FLOW,
    );
    expect(await db.activityPublishReview.count({ where: { activityId: id } })).toBe(0);
    expect(
      (await db.activitySession.findUniqueOrThrow({ where: { id: draft.session.id } }))
        .evacuationPoint,
    ).toBe('确认后新增撤离点');
    expect(
      await db.auditLog.count({
        where: {
          resourceId: id,
          context: { path: ['extra', 'operation'], equals: 'publish-review-submit' },
        },
      }),
    ).toBe(0);
  });

  it('simple whitelist: exact replay survives later custom form, with authorization still before replay', async () => {
    const actor = await user('confirm_owner');
    const binding = await grant(actor.id, [
      'activity.create.record',
      'activity.update.record',
      'activity.time-policy.read',
      'activity.time-policy.select',
      'activity.contribution-policy.read',
      'activity.contribution-policy.select',
    ]);
    const { id, draft } = await confirmationDraft(actor.auth);
    const body = {
      operationKey: key('qual_replay'),
      confirmation: true,
      expectedDraftHash: draft.draftHash,
    };
    const post = (payload: object, auth = actor.auth) =>
      request(httpServer(app))
        .post(`${ROOT}/${id}/publish-reviews`)
        .set('Authorization', auth)
        .send(payload);
    const first = await post(body).expect(200);
    await request(httpServer(app))
      .put(`/api/app/v1/my/managed-activities/${id}/registration-form`)
      .set('Authorization', actor.auth)
      .send({
        form: {
          fields: [
            {
              fieldCode: 'extra',
              typeCode: 'short_text',
              label: '新增字段',
              required: true,
              visibilityCode: 'self_only',
              exportable: false,
              sortOrder: 0,
            },
          ],
        },
      })
      .expect(200);
    const effects = await db.auditLog.count({ where: { resourceId: id } });
    expect((await post(body).expect(200)).body.data).toEqual(first.body.data);
    expectBizError(
      await post({ ...body, expectedDraftHash: '0'.repeat(64) }),
      BizCode.ACTIVITY_PUBLISH_REVIEW_OPERATION_KEY_CONFLICT,
    );
    expectBizError(
      await post({ ...body, operationKey: key('qual_new') }),
      BizCode.ACTIVITY_SIMPLE_DRAFT_STALE,
    );
    expectBizError(await post(body, outsider.auth), BizCode.ACTIVITY_NOT_FOUND);
    const revoker = await grant(publisher.id, ['role-binding.delete.record']);
    await db.roleBinding.update({
      where: { id: revoker.id },
      data: { scopeType: 'GLOBAL', scopeOrgId: null },
    });
    await request(httpServer(app))
      .delete(`/api/admin/v1/role-bindings/${binding.id}`)
      .set('Authorization', publisher.auth)
      .expect(200);
    expectBizError(await post(body), BizCode.FORBIDDEN);
    expectBizError(
      await post({ ...body, operationKey: key('qual_revoked_new') }),
      BizCode.FORBIDDEN,
    );
    expect(await db.auditLog.count({ where: { resourceId: id } })).toBe(effects);
    expect(await db.activityPublishReview.count({ where: { activityId: id } })).toBe(1);
    expect(
      await db.registrationFormVersion.count({ where: { activityId: id, statusCode: 'draft' } }),
    ).toBe(1);
  });

  async function pendingReturnReview() {
    const created = await request(httpServer(app))
      .post(`${ROOT}/from-template`)
      .set('Authorization', publisher.auth)
      .send({
        operationKey: key('return_create'),
        templateVersionId: templateId,
        title: '合成退回授权复核',
        organizationId,
        startAt: '2099-09-01T00:00:00.000Z',
        endAt: '2099-09-01T03:00:00.000Z',
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
    const activityId = created.body.data.activityId as string;
    const submitted = await request(httpServer(app))
      .post(`${ROOT}/${activityId}/publish-reviews`)
      .set('Authorization', publisher.auth)
      .send({ operationKey: key('return_submit'), confirmation: true })
      .expect(200);
    expect(submitted.body.data.status).toBe('pending');
    return { activityId, reviewId: submitted.body.data.id as string };
  }

  async function returnOnlyActor() {
    const actor = await user('return_only');
    const binding = await grant(actor.id, ['activity-review.return.request']);
    // Initial RBAC fixture: the ordinary publisher may end a custom, non-system role binding.
    const revoker = await grant(publisher.id, ['role-binding.delete.record']);
    await db.roleBinding.update({
      where: { id: revoker.id },
      data: { scopeType: 'GLOBAL', scopeOrgId: null },
    });
    expect(
      await db.roleBinding.count({
        where: { principalId: actor.id, status: 'ACTIVE', deletedAt: null },
      }),
    ).toBe(1);
    return { ...actor, bindingId: binding.id };
  }

  async function returnEffects(activityId: string, reviewId: string) {
    return db.$queryRaw<Array<{ kind: string; xid: string }>>`
      SELECT 'review' AS kind, xmin::text AS xid FROM activity_publish_reviews WHERE id = ${reviewId}
      UNION ALL SELECT 'audit', xmin::text FROM audit_logs
        WHERE "resourceId" = ${activityId} AND context->'extra'->>'operation' = 'publish-review-return'
      UNION ALL SELECT 'outbox', xmin::text FROM notification_outbox_intents
        WHERE "aggregateType" = 'activity_publish_review' AND "aggregateId" = ${reviewId}`;
  }

  it('returns and replays with only the return permission, but rejects replay after normal revocation', async () => {
    const actor = await returnOnlyActor();
    const { activityId, reviewId } = await pendingReturnReview();
    const path = `/api/admin/v1/activity-publish-reviews/${reviewId}/return`;
    const body = { operationKey: key('return_once'), reviewNote: '合成退回说明' };
    const first = await request(httpServer(app))
      .post(path)
      .set('Authorization', actor.auth)
      .send(body)
      .expect(200);
    expect(first.body.data.status).toBe('returned');
    const effects = await returnEffects(activityId, reviewId);
    expect(effects.map((row) => row.kind).sort()).toEqual(['audit', 'outbox', 'review']);
    expect(new Set(effects.map((row) => row.xid)).size).toBe(1);
    const xid = effects[0].xid;
    expect(
      (
        await db.$queryRaw<Array<{ state: string }>>`SELECT pg_xact_status(${xid}::xid8) AS state`
      )[0].state,
    ).toBe('committed');
    const replay = await request(httpServer(app))
      .post(path)
      .set('Authorization', actor.auth)
      .send(body)
      .expect(200);
    expect(replay.body.data).toEqual(first.body.data);
    expect(await returnEffects(activityId, reviewId)).toEqual(effects);
    await request(httpServer(app))
      .delete(`/api/admin/v1/role-bindings/${actor.bindingId}`)
      .set('Authorization', publisher.auth)
      .expect(200);
    expectBizError(
      await request(httpServer(app)).post(path).set('Authorization', actor.auth).send(body),
      BizCode.RBAC_FORBIDDEN,
    );
    expect(await returnEffects(activityId, reviewId)).toEqual(effects);
    evidence.returnOnlyReplay = { activityId, reviewId, xid, effects, revokedReplay: 'DENIED' };
  });

  it('rejects an already waiting return after normal revocation commits, with no return audit or outbox', async () => {
    const actor = await returnOnlyActor();
    const { activityId, reviewId } = await pendingReturnReview();
    const beforeEffects = await returnEffects(activityId, reviewId);
    expect(beforeEffects.map((row) => row.kind)).toEqual(['review']);
    let pending: Promise<request.Response> | undefined;
    let finished = false;
    let waiterPid = 0;
    let blockerPid = 0;
    let revocationXid = '';
    const times: Record<string, string> = {};
    try {
      await db.$transaction(async (tx) => {
        blockerPid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]
          .pid;
        await tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${activityId} FOR UPDATE`;
        times.rootLocked = new Date().toISOString();
        pending = request(httpServer(app))
          .post(`/api/admin/v1/activity-publish-reviews/${reviewId}/return`)
          .set('Authorization', actor.auth)
          .send({ operationKey: key('return_waiting'), reviewNote: '合成锁等待后的撤权复核' })
          .then((response) => {
            finished = true;
            times.httpFinished = new Date().toISOString();
            return response;
          });
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          const waiting = await db.$queryRaw<Array<{ pid: number }>>`
            SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND backend_type = 'client backend'
              AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
              AND ${blockerPid} = ANY(pg_blocking_pids(pid))
              AND query LIKE '%FROM "Activity"%FOR UPDATE%'`;
          if (waiting.length === 1) {
            waiterPid = waiting[0].pid;
            times.waitObserved = new Date().toISOString();
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiterPid).toBeGreaterThan(0);
        expect(finished).toBe(false);
        await request(httpServer(app))
          .delete(`/api/admin/v1/role-bindings/${actor.bindingId}`)
          .set('Authorization', publisher.auth)
          .expect(200);
        times.revocationFinished = new Date().toISOString();
        const binding = await db.$queryRaw<
          Array<{ status: string; deleted: boolean; xid: string }>
        >`
          SELECT status::text AS status, "deletedAt" IS NOT NULL AS deleted, xmin::text AS xid
          FROM role_bindings WHERE id = ${actor.bindingId}`;
        expect(binding[0]).toMatchObject({ status: 'ENDED', deleted: true });
        revocationXid = binding[0].xid;
        expect(
          (
            await db.$queryRaw<
              Array<{ state: string }>
            >`SELECT pg_xact_status(${revocationXid}::xid8) AS state`
          )[0].state,
        ).toBe('committed');
        expect(
          await db.roleBinding.count({
            where: { principalId: actor.id, status: 'ACTIVE', deletedAt: null },
          }),
        ).toBe(0);
        expectBizError(
          await request(httpServer(app))
            .post(`/api/admin/v1/activity-publish-reviews/${reviewId}/return`)
            .set('Authorization', actor.auth)
            .send({ operationKey: key('return_fresh'), reviewNote: '合成新请求立即拒绝' }),
          BizCode.RBAC_FORBIDDEN,
        );
        expect(finished).toBe(false);
        const stillWaiting = await db.$queryRaw<Array<{ waiting: boolean }>>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
            AND pid = ${waiterPid} AND wait_event_type = 'Lock'
            AND ${blockerPid} = ANY(pg_blocking_pids(pid))) AS waiting`;
        expect(stillWaiting[0].waiting).toBe(true);
        times.beforeRootRelease = new Date().toISOString();
      });
      times.rootReleased = new Date().toISOString();
    } finally {
      if (pending) await pending;
    }
    expect(pending).toBeDefined();
    expectBizError(await pending!, BizCode.RBAC_FORBIDDEN);
    expect(await returnEffects(activityId, reviewId)).toEqual(beforeEffects);
    expect(
      await db.activityPublishReview.findUniqueOrThrow({
        where: { id: reviewId },
        select: { status: true, reviewedByUserId: true, reviewOperationKey: true },
      }),
    ).toEqual({ status: 'pending', reviewedByUserId: null, reviewOperationKey: null });
    evidence.revokedWaitingReturn = {
      activityId,
      reviewId,
      blockerPid,
      waiterPid,
      revocationXid,
      times,
      outcome: 'DENIED_WITH_NO_RETURN_WRITES',
    };
  });
});
