import type { INestApplication } from '@nestjs/common';
import { Prisma, Role, UserStatus, MemberStatus, OrganizationStatus } from '@prisma/client';
import request from 'supertest';
import { ActivityWorkflowGate } from '../../src/common/activity-workflow/activity-workflow.gate';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { AttendanceSegmentProjectorService } from '../../src/modules/activities/attendance-segment-projector.service';
import { parseMetricReceipt } from '../../src/modules/activities/activity-metric-command';
import { createTestUser } from '../fixtures/users.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { httpServer } from '../helpers/http-server';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { waitFor } from '../helpers/wait-for';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertConnectedTestDatabase } from '../setup/test-db';

describe('C3-1 candidate database lock races', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: string;
  let actorId: string;
  let memberId: string;
  let organizationId: string;
  let definitionId: string;
  let definitionHash: string;
  let setId: string;
  let setHash: string;
  let bindingId: string;
  let sequence = 0;
  const key = () => `candidate_race_${++sequence}`;
  const bindings = '/api/admin/v1/activity-metric-rule-bindings';
  const base = (activityId: string) =>
    `/api/app/v1/my/managed-activities/${activityId}/metric-candidates`;
  const post = (path: string, body: object) =>
    request(httpServer(app)).post(path).set('Authorization', auth).send(body);
  const bindingCommand = () => ({
    schemaVersion: 1,
    operationKey: key(),
    metricDefinitionId: definitionId,
    definitionHash,
    ruleCode: 'actual_participant_count_v1',
    evaluatorVersion: 1,
  });
  const command = (expectedCandidateRevision = 0) => ({
    schemaVersion: 1,
    operationKey: key(),
    expectedCandidateRevision,
    expectedOutcomeRevision: 0,
    metricSetVersionId: setId,
    metricSetDefinitionHash: setHash,
    bindingIds: [bindingId],
  });
  const activity = () =>
    prisma.activity.create({
      data: {
        title: key(),
        activityTypeCode: 'training',
        allocationModeCode: 'first_come',
        organizationId,
        initiatorMemberId: memberId,
        statusCode: 'draft',
        startAt: new Date('2025-01-01'),
        endAt: new Date('2025-01-02'),
        location: '测试',
        metricRequirementCode: 'required',
        selectedMetricSetVersionId: setId,
        selectedMetricSetDefinitionHash: setHash,
        metricSelectionRevision: 1,
      },
    });
  async function grant(codes: string[]) {
    const role = await prisma.rbacRole.create({
      data: { code: key(), displayName: '候选测试显式授权' },
    });
    for (const code of codes) {
      const permission = await prisma.permission.upsert({
        where: { code },
        update: {},
        create: {
          code,
          module: 'activity',
          action: 'test',
          resourceType: 'test',
          description: 'test',
          servicePrincipalAllowed: false,
          delegatedAccessAllowed: false,
        },
      });
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
    }
    await prisma.roleBinding.create({
      data: { principalType: 'USER', principalId: actorId, roleId: role.id, scopeType: 'GLOBAL' },
    });
  }
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await assertConnectedTestDatabase(prisma);
    await resetDb(app);
    // Catalogs do not cascade from User; clear only this worker's prior test fixtures.
    await prisma.$executeRaw`TRUNCATE "ActivityMetricCommandReceipt", "ActivityMetricSetItem", "ActivityMetricSetVersion", "ActivityMetricDefinition" CASCADE`;
    const actor = await createTestUser(app, { username: key(), role: Role.SUPER_ADMIN });
    actorId = actor.id;
    const member = await prisma.member.create({
      data: { memberNo: key(), ...memberIdentityData('候选测试'), gradeCode: 'level-3' },
    });
    memberId = member.id;
    await prisma.user.update({ where: { id: actorId }, data: { memberId } });
    auth = (await loginAs(app, actor.username)).authHeader;
    const root = await prisma.organization.create({ data: { name: key(), nodeTypeCode: 'root' } });
    organizationId = (
      await prisma.organization.create({
        data: { name: key(), nodeTypeCode: 'team', parentId: root.id },
      })
    ).id;
    const definition = parseMetricReceipt(
      (
        await post('/api/admin/v1/activity-metric-definitions', {
          operationKey: key(),
          definition: {
            schemaVersion: 1,
            code: key(),
            version: 1,
            name: '人数',
            configuration: {
              kindCode: 'non_negative_integer',
              unit: '人',
              minimum: 0,
              maximum: 2000,
            },
          },
        }).expect(201)
      ).body.data,
    );
    definitionId = definition.id;
    definitionHash = definition.definitionHash;
    await post(`/api/admin/v1/activity-metric-definitions/${definitionId}/activate`, {
      operationKey: key(),
      expectedDefinitionHash: definitionHash,
    }).expect(200);
    const set = parseMetricReceipt(
      (
        await post('/api/admin/v1/activity-metric-sets', {
          operationKey: key(),
          definition: {
            schemaVersion: 1,
            code: key(),
            version: 1,
            name: '候选集',
            items: [
              {
                key: 'people',
                sortOrder: 0,
                required: true,
                metricDefinitionId: definitionId,
                definitionHash,
              },
            ],
          },
        }).expect(201)
      ).body.data,
    );
    setId = set.id;
    setHash = set.definitionHash;
    await post(`/api/admin/v1/activity-metric-sets/${setId}/activate`, {
      operationKey: key(),
      expectedDefinitionHash: setHash,
    }).expect(200);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await app?.close();
  });

  beforeAll(async () => {
    await grant([
      'activity-metric.manage.rule-binding',
      'activity.outcome.calculate',
      'activity.outcome.read',
    ]);
    const response = await post(bindings, bindingCommand()).expect(201);
    bindingId = (response.body.data as { bindingId: string }).bindingId;
  });
  beforeEach(() => {
    jest.spyOn(app.get(ActivityWorkflowGate), 'isV11Enabled').mockReturnValue(true);
  });
  async function barrier(
    lock: Prisma.Sql,
    mutate?: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) {
    let notify!: (pid: number) => void;
    let unlock!: () => void;
    const ready = new Promise<number>((resolve) => {
      notify = resolve;
    });
    const released = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const held = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(lock);
        const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        notify(backend.pid);
        await released;
        if (mutate) await mutate(tx);
      },
      { timeout: 15000 },
    );
    const pid = await Promise.race([
      ready,
      held.then(() => {
        throw new Error('holder exited before readiness');
      }),
    ]);
    return {
      pid,
      release: async () => {
        unlock();
        await held;
      },
    };
  }
  async function waiting(pid: number) {
    await waitFor(
      async () => {
        const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) FROM pg_stat_activity
        WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))`;
        return row.count > 0n;
      },
      { timeoutMs: 5000, message: 'candidate did not wait on the intended real database lock' },
    );
  }
  async function addCompletedSourceInTx(tx: Prisma.TransactionClient, activityId: string) {
    const startAt = new Date('2025-01-01T00:00:00.000Z');
    const endAt = new Date('2025-01-01T02:00:00.000Z');
    const session = await tx.activitySession.create({
      data: {
        activityId,
        code: key(),
        name: key(),
        startAt,
        endAt,
        locationText: '测试',
        checkInOpenAt: startAt,
        checkInCloseAt: endAt,
        checkOutOpenAt: startAt,
        checkOutCloseAt: endAt,
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
    });
    const registration = await tx.activityRegistration.upsert({
      where: { activityId_memberId: { activityId, memberId } },
      update: {},
      create: { activityId, memberId, statusCode: 'pass' },
    });
    const identity = await tx.activityParticipationIdentity.create({
      data: {
        activityId,
        sessionId: session.id,
        registrationId: registration.id,
        memberId,
        currentStatusCode: 'pass',
        populationIncluded: true,
      },
    });
    const events = [];
    for (const [eventTypeCode, occurredAt] of [
      ['check_in', startAt],
      ['check_out', new Date(startAt.getTime() + 3600000)],
    ] as const) {
      events.push(
        await tx.attendancePunchEvent.create({
          data: {
            activityId,
            sessionId: session.id,
            participationIdentityId: identity.id,
            memberId,
            operatorUserId: actorId,
            eventTypeCode,
            sourceCode: 'proxy',
            occurredAt,
            receivedAt: occurredAt,
            eventKey: key(),
            requestHash: key(),
            evidenceRevision: 0,
            reason: 'C3-1 锁交错夹具',
          },
        }),
      );
    }
    const projected = app.get(AttendanceSegmentProjectorService).rebuild(events, {
      sessionStartAt: startAt,
      sessionEndAt: endAt,
      lateGraceMinutes: session.lateGraceMinutes,
      earlyLeaveThresholdMinutes: session.earlyLeaveThresholdMinutes,
    });
    expect(projected.chainAnomalies).toEqual([]);
    for (const segment of projected.segments) {
      const { exceptionFlags, ...fields } = segment;
      await tx.participantServiceSegmentRevision.create({
        data: {
          ...fields,
          exceptionFlagsJson: exceptionFlags,
          participationIdentityId: identity.id,
          revision: 1,
          statusCode: 'draft',
        },
      });
    }
  }
  it('serializes two identical requests to one original receipt', async () => {
    const row = await activity();
    const body = command();
    const results = await Promise.all([post(base(row.id), body), post(base(row.id), body)]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results[0].body).toEqual(results[1].body);
    expect(await prisma.activityMetricCandidate.count({ where: { activityId: row.id } })).toBe(1);
    expect(
      await prisma.activityMetricCandidateCommandReceipt.count({ where: { activityId: row.id } }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { resourceId: row.id, event: 'activity.metric-candidate.command' },
      }),
    ).toBe(1);
  });
  it('allows only one different-key expected-revision contender to commit', async () => {
    const row = await activity();
    const results = await Promise.all([
      post(base(row.id), command()),
      post(base(row.id), command()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)?.body.code).toBe(
      BizCode.ACTIVITY_METRIC_CANDIDATE_STALE.code,
    );
    expect(await prisma.activityMetricCandidate.count({ where: { activityId: row.id } })).toBe(1);
    expect(
      await prisma.activityMetricCandidateCommandReceipt.count({ where: { activityId: row.id } }),
    ).toBe(1);
  });
  it('sees one complete post-commit source after waiting for the activity writer lock', async () => {
    const row = await activity();
    const held = await barrier(
      Prisma.sql`SELECT "id" FROM "Activity" WHERE "id" = ${row.id} FOR UPDATE`,
      (tx) => addCompletedSourceInTx(tx, row.id),
    );
    const pending = post(base(row.id), command()).then((response) => response);
    try {
      await waiting(held.pid);
    } finally {
      await held.release();
    }
    const response = await pending;
    expect(response.status).toBe(201);
    const candidateId = (response.body.data as { candidateId: string }).candidateId;
    expect(response.body.data).toMatchObject({ sourceCount: 1, valueCount: 1 });
    expect(
      await prisma.activityMetricCandidateSource.count({
        where: { candidateId, activityId: row.id },
      }),
    ).toBe(1);
  });
  it.each(['operation', 'activity', 'definition'])(
    'rechecks the user after waiting for %s lock',
    async (kind) => {
      const row = await activity();
      const body = command();
      const identity = JSON.stringify([
        'activity-metric-candidate',
        actorId,
        'calculate_metric_candidate',
        body.operationKey,
      ]);
      const lock =
        kind === 'operation'
          ? Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))::text`
          : kind === 'activity'
            ? Prisma.sql`SELECT "id" FROM "Activity" WHERE "id" = ${row.id} FOR UPDATE`
            : Prisma.sql`SELECT "id" FROM "ActivityMetricDefinition" WHERE "id" = ${definitionId} FOR UPDATE`;
      const held = await barrier(lock, (tx) =>
        tx.user.update({ where: { id: actorId }, data: { status: UserStatus.DISABLED } }),
      );
      const pending = post(base(row.id), body).then((response) => response);
      try {
        await waiting(held.pid);
      } finally {
        await held.release();
      }
      try {
        const response = await pending;
        expect(response.status).toBe(401);
        expect(await prisma.activityMetricCandidate.count({ where: { activityId: row.id } })).toBe(
          0,
        );
        expect(
          await prisma.activityMetricCandidateCommandReceipt.count({
            where: { activityId: row.id },
          }),
        ).toBe(0);
      } finally {
        await prisma.user.update({ where: { id: actorId }, data: { status: UserStatus.ACTIVE } });
      }
    },
  );
  it.each(['member', 'organization', 'initiator'])(
    'rejects changed %s eligibility after activity lock wait, including replay',
    async (kind) => {
      const row = await activity();
      const body = command();
      await post(base(row.id), body).expect(201);
      const held = await barrier(
        Prisma.sql`SELECT "id" FROM "Activity" WHERE "id" = ${row.id} FOR UPDATE`,
        async (tx) => {
          if (kind === 'member')
            await tx.member.update({
              where: { id: memberId },
              data: { status: MemberStatus.INACTIVE },
            });
          if (kind === 'organization')
            await tx.organization.update({
              where: { id: organizationId },
              data: { status: OrganizationStatus.INACTIVE },
            });
          if (kind === 'initiator')
            await tx.activity.update({ where: { id: row.id }, data: { initiatorMemberId: null } });
        },
      );
      const pending = post(base(row.id), body).then((response) => response);
      try {
        await waiting(held.pid);
      } finally {
        await held.release();
      }
      try {
        const response = await pending;
        expect([403, 404]).toContain(response.status);
        expect(await prisma.activityMetricCandidate.count({ where: { activityId: row.id } })).toBe(
          1,
        );
        expect(
          await prisma.activityMetricCandidateCommandReceipt.count({
            where: { activityId: row.id },
          }),
        ).toBe(1);
      } finally {
        await prisma.member.update({
          where: { id: memberId },
          data: { status: MemberStatus.ACTIVE },
        });
        await prisma.organization.update({
          where: { id: organizationId },
          data: { status: OrganizationStatus.ACTIVE },
        });
      }
    },
  );
});
