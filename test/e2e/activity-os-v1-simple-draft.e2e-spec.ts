import type { INestApplication } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityDraftAuditRecorder } from '../../src/modules/activities/activity-draft-audit-recorder';
import { computeActivityTemplateDefinitionHash } from '../../src/modules/activities/activity-template-definition';
import { fingerprintTimePolicyVersion } from '../../src/modules/activities/activity-time-policy-definition';
import { fingerprintContributionPolicyVersion } from '../../src/modules/activities/activity-contribution-policy-definition';
import { createTestUser } from '../fixtures/users.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
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

/** A fresh ordinary-account API chain. It never resets, reuses or connects to a retained R5 database. */
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
});
