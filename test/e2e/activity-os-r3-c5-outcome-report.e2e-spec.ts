import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, PrismaClient, Role } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { PrismaService } from '../../src/database/prisma.service';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { createTestApp } from '../setup/test-app';
import { resetDb } from '../setup/reset-db';
import { assertConnectedTestDatabase } from '../setup/test-db';
import { createTestUser } from '../fixtures/users.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { httpServer } from '../helpers/http-server';
import { expectBizError } from '../helpers/biz-code.assert';
import { parseMetricReceipt } from '../../src/modules/activities/activity-metric-command';
import { waitFor } from '../helpers/wait-for';
import { ActivityOutcomeAccessService } from '../../src/modules/activities/activity-outcome-access.service';
import { ActivityOutcomeReportQueryService } from '../../src/modules/activities/activity-outcome-report-query.service';
import { loadActiveUserIdentityInTx } from '../../src/modules/users/user-active-identity.query';
import { ServiceTokenService } from '../../src/modules/integration-auth/service-token.service';
import { ServicePrincipalsService } from '../../src/modules/service-principals/service-principals.service';
import { IntegrationAuthGate } from '../../src/modules/integration-auth/integration-auth.gate';

// A real, separately observed PostgreSQL connection; no mocks or query rewriting.
class ObservedReportDatabase extends PrismaClient<Prisma.PrismaClientOptions, 'query'> {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}

describe('C5 outcome report HTTP', () => {
  const priorIntegrationSecret = process.env.INTEGRATION_JWT_SECRET;
  let app: INestApplication;
  let peer: INestApplication;
  let prisma: PrismaService;
  let auth: string;
  let userId: string;
  let memberId: string;
  let organizationId: string;
  let bindingId: string;
  const key = () => `c5_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const get = (id: string) =>
    request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${id}/outcome-report`)
      .set('Authorization', auth);
  const activity = () =>
    prisma.activity.create({
      data: {
        title: key(),
        activityTypeCode: 'training',
        allocationModeCode: 'first_come',
        organizationId,
        initiatorMemberId: memberId,
        statusCode: 'draft',
        startAt: new Date('2099-09-01'),
        endAt: new Date('2099-09-02'),
        location: '测试',
      },
    });
  beforeAll(async () => {
    // Only supply this test process's separate signing key; the Gate stays off.
    process.env.INTEGRATION_JWT_SECRET = randomUUID() + randomUUID();
    app = await createTestApp();
    peer = await createTestApp();
    prisma = app.get(PrismaService);
    await assertConnectedTestDatabase(prisma);
    await assertConnectedTestDatabase(peer.get(PrismaService));
    await resetDb(app);
    const user = await createTestUser(app, { username: key(), role: Role.SUPER_ADMIN });
    userId = user.id;
    const member = await prisma.member.create({
      data: { memberNo: key(), ...memberIdentityData('工作台测试'), gradeCode: 'level-3' },
    });
    memberId = member.id;
    await prisma.user.update({ where: { id: userId }, data: { memberId } });
    auth = (await loginAs(app, user.username)).authHeader;
    const root = await prisma.organization.create({ data: { name: key(), nodeTypeCode: 'root' } });
    organizationId = (
      await prisma.organization.create({
        data: { name: key(), nodeTypeCode: 'team', parentId: root.id },
      })
    ).id;
  });
  afterAll(async () => {
    await peer?.close();
    await app?.close();
    if (priorIntegrationSecret === undefined) delete process.env.INTEGRATION_JWT_SECRET;
    else process.env.INTEGRATION_JWT_SECRET = priorIntegrationSecret;
  });
  it('does not grant SUPER_ADMIN a role shortcut', async () => {
    const row = await activity();
    expectBizError(await get(row.id), BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
  });
  it('reads unconfigured facts after an explicit permission grant without changing data', async () => {
    const role = await prisma.rbacRole.create({ data: { code: key(), displayName: 'C5只读' } });
    const permission = await prisma.permission.upsert({
      where: { code: 'activity.outcome.read' },
      update: {},
      create: {
        code: 'activity.outcome.read',
        module: 'activity',
        action: 'outcome',
        resourceType: 'read',
        description: '隔离测试显式授权',
        servicePrincipalAllowed: false,
        delegatedAccessAllowed: false,
      },
    });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    bindingId = (
      await prisma.roleBinding.create({
        data: { principalType: 'USER', principalId: userId, roleId: role.id, scopeType: 'GLOBAL' },
      })
    ).id;
    const row = await activity();
    const response = await get(row.id).expect(200);
    expect(response.body.code).toBe(0);
    expect(response.body.data).toEqual({
      activityId: row.id,
      activityStatusCode: 'draft',
      metricRequirementCode: 'unconfigured',
      metricSelectionRevision: 0,
      currentConfirmed: null,
      formalStatus: 'not_confirmed',
    });
    expect(await prisma.activity.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    expect(await prisma.activityOutcomeRevision.count({ where: { activityId: row.id } })).toBe(0);
    expect(
      await prisma.activityOutcomeFinalizationReceipt.count({ where: { activityId: row.id } }),
    ).toBe(0);
  });
  it('keeps explicit not_required distinct from missing configuration', async () => {
    const row = await activity();
    await prisma.activity.update({
      where: { id: row.id },
      data: { metricRequirementCode: 'not_required', metricSelectionRevision: 1 },
    });
    const result = await get(row.id).expect(200);
    expect(result.body.data.metricRequirementCode).toBe('not_required');
    expect(result.body.data.currentConfirmed).toBeNull();
    expect(result.body.data.formalStatus).toBe('not_confirmed');
  });

  it('validates bounded query bodies and refuses unknown query parameters', async () => {
    const a = await activity();
    const b = await activity();
    const batch = (body: object) =>
      request(httpServer(app))
        .post('/api/app/v1/my/managed-activities/outcome-reports/query')
        .set('Authorization', auth)
        .send(body);
    const result = await batch({ activityIds: [b.id, a.id] }).expect(200);
    expect(result.body.code).toBe(0);
    expect(result.body.data.items.map((row: { activityId: string }) => row.activityId)).toEqual(
      [a.id, b.id].sort(),
    );
    for (const body of [
      { activityIds: [] },
      { activityIds: [a.id, a.id] },
      { activityIds: Array.from({ length: 21 }, () => key()) },
      { activityIds: [''] },
      { activityIds: ['a'.repeat(65)] },
      { activityIds: [a.id], unexpected: true },
    ]) {
      const failure = await batch(body);
      expectBizError(failure, BizCode.BAD_REQUEST, { strictMessage: false });
      expect(failure.body.message).toMatch(/activityIds|unexpected/);
    }
    const unknownQuery = await get(a.id).query({ asOf: '2099-01-01' });
    expectBizError(unknownQuery, BizCode.BAD_REQUEST, { strictMessage: false });
    expect(unknownQuery.body.message).toContain('asOf');
    expectBizError(
      await batch({ activityIds: [a.id, key()] }),
      BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE,
    );
  });
  it('follows real initial confirmation, correction, cancellation and replacement without rewriting history', async () => {
    const roleId = (await prisma.roleBinding.findUniqueOrThrow({ where: { id: bindingId } }))
      .roleId;
    for (const action of ['record', 'confirm', 'correct']) {
      const code = `activity.outcome.${action}`;
      const permission = await prisma.permission.upsert({
        where: { code },
        update: {},
        create: {
          code,
          module: 'activity',
          action: 'outcome',
          resourceType: action,
          description: '测试',
          servicePrincipalAllowed: false,
          delegatedAccessAllowed: false,
        },
      });
      await prisma.rolePermission.create({ data: { roleId, permissionId: permission.id } });
    }
    const post = (url: string, body: object) =>
      request(httpServer(app)).post(url).set('Authorization', auth).send(body);
    const definition = parseMetricReceipt(
      (
        await post('/api/admin/v1/activity-metric-definitions', {
          operationKey: key(),
          definition: {
            schemaVersion: 1,
            code: key(),
            version: 1,
            name: '完成',
            configuration: { kindCode: 'boolean', unit: null },
          },
        }).expect(201)
      ).body.data,
    );
    await post(`/api/admin/v1/activity-metric-definitions/${definition.id}/activate`, {
      operationKey: key(),
      expectedDefinitionHash: definition.definitionHash,
    }).expect(200);
    const set = parseMetricReceipt(
      (
        await post('/api/admin/v1/activity-metric-sets', {
          operationKey: key(),
          definition: {
            schemaVersion: 1,
            code: key(),
            version: 1,
            name: '成果集',
            items: [
              {
                key: 'done',
                sortOrder: 0,
                required: true,
                metricDefinitionId: definition.id,
                definitionHash: definition.definitionHash,
              },
            ],
          },
        }).expect(201)
      ).body.data,
    );
    await post(`/api/admin/v1/activity-metric-sets/${set.id}/activate`, {
      operationKey: key(),
      expectedDefinitionHash: set.definitionHash,
    }).expect(200);
    const row = await activity();
    await prisma.activity.update({
      where: { id: row.id },
      data: {
        metricRequirementCode: 'required',
        selectedMetricSetVersionId: set.id,
        selectedMetricSetDefinitionHash: set.definitionHash,
        metricSelectionRevision: 1,
      },
    });
    const root = `/api/app/v1/my/managed-activities/${row.id}`;
    // Queue the real command first, then the read, on the same Activity lock.
    // Both requests use independent application pools; observe actual PostgreSQL waits.
    const interleave = async (command: () => PromiseLike<request.Response>) => {
      let release!: () => void;
      let acquired!: (pid: number) => void;
      const ready = new Promise<number>((resolve) => {
        acquired = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Activity" WHERE "id" = ${row.id} FOR UPDATE`;
          const [connection] = await tx.$queryRaw<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          acquired(connection.pid);
          await gate;
        },
        { timeout: 20000 },
      );
      const pid = await Promise.race([
        ready,
        holder.then(() => {
          throw new Error('holder ended early');
        }),
      ]);
      const writing = Promise.resolve(command());
      let reading: Promise<request.Response> | undefined;
      try {
        const blocked = async () => {
          const [result] = await prisma.$queryRaw<{ count: bigint }[]>`
            SELECT count(*) FROM pg_stat_activity AS a
            WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
              AND (${pid} = ANY(pg_blocking_pids(a.pid)) OR EXISTS (
                SELECT 1 FROM pg_stat_activity AS preceding
                WHERE preceding.datname = current_database()
                  AND preceding.pid = ANY(pg_blocking_pids(a.pid))
                  AND ${pid} = ANY(pg_blocking_pids(preceding.pid))
              ))`;
          return Number(result.count);
        };
        await waitFor(async () => (await blocked()) >= 1, {
          timeoutMs: 5000,
          message: 'command did not wait',
        });
        reading = request(httpServer(peer))
          .get(`${root}/outcome-report`)
          .set('Authorization', auth)
          .expect(200)
          .then((response) => response);
        await waitFor(async () => (await blocked()) >= 2, {
          timeoutMs: 5000,
          message: 'workbench did not wait behind command',
        });
        release();
        await holder;
        return { command: await writing, summary: (await reading).body.data };
      } finally {
        release();
        await holder;
        await writing;
        if (reading) await reading;
      }
    };
    expect((await get(row.id).expect(200)).body.data.currentConfirmed).toBeNull();
    const anchors = { metricSetVersionId: set.id, metricSetDefinitionHash: set.definitionHash };
    const draftId = (
      await post(`${root}/outcomes`, {
        ...anchors,
        operationKey: key(),
        expectedRevision: 0,
        values: [{ metricDefinitionId: definition.id, value: true, evidenceAttachmentIds: [] }],
      }).expect(201)
    ).body.data.outcomeRevisionId as string;
    expect((await get(row.id).expect(200)).body.data.currentConfirmed).toBeNull();
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: row.id,
        memberId,
        responsibilityType: 'owner',
        status: 'active',
        assignedByUserId: userId,
        source: 'publish',
        canManageRegistrations: true,
        canManageAttendance: true,
      },
    });
    await prisma.activity.update({ where: { id: row.id }, data: { statusCode: 'completed' } });
    const attachment = await prisma.attachment.create({
      data: {
        key: `attachments/c5/${key()}.txt`,
        originalName: 'evidence.txt',
        mime: 'text/plain',
        size: 7,
        uploadedBy: userId,
        ownerType: 'activity',
        ownerId: row.id,
      },
    });
    await prisma.storageObject.create({
      data: {
        key: attachment.key,
        state: 'available',
        source: 'attachment_signed_upload',
        providerType: 'LOCAL',
        localNamespace: 'c5-test',
        expectedSize: 7n,
        actualSize: 7n,
        expectedMime: 'text/plain',
        resourceType: 'attachment',
        resourceId: attachment.id,
        verifiedAt: new Date(),
        presentAt: new Date(),
        lastProviderCheckedAt: new Date(),
      },
    });
    const confirm = async (id: string, latest: number, confirmed: number) => {
      const value = await prisma.activityMetricValueRevision.findFirstOrThrow({
        where: { outcomeRevisionId: id },
      });
      return post(`${root}/outcome-confirmations`, {
        ...anchors,
        operationKey: key(),
        expectedLatestRevision: latest,
        expectedConfirmedRevision: confirmed,
        manualDraftId: id,
        values: [
          {
            metricDefinitionId: definition.id,
            sourceKind: 'manual',
            sourceValueId: value.id,
            evidenceAttachmentIds: [attachment.id],
          },
        ],
      }).expect(201);
    };
    const initialRead = await interleave(() => confirm(draftId, 1, 0));
    const formal = (await get(row.id).expect(200)).body.data.currentConfirmed;
    expect(initialRead.summary.currentConfirmed).toEqual(formal);
    expect(initialRead.summary.formalStatus).toBe('confirmed');
    expect(formal).toMatchObject({ revision: 2, metricSetVersionId: set.id });
    expect(formal.metrics).toHaveLength(1);
    expect(formal.metrics[0]).toMatchObject({
      value: true,
      definitionHash: definition.definitionHash,
    });
    expect(formal.metrics[0]).not.toHaveProperty('evidence');
    const prepare = (latest: number) =>
      post(`${root}/outcome-corrections`, {
        ...anchors,
        operationKey: key(),
        expectedLatestRevision: latest,
        expectedConfirmedRevision: 2,
        values: [
          {
            metricDefinitionId: definition.id,
            sourceKind: 'manual',
            value: false,
            evidenceAttachmentIds: [],
          },
        ],
      }).expect(201);
    const preparedRead = await interleave(() => prepare(2));
    const correction = preparedRead.command.body.data;
    const pending = (await get(row.id).expect(200)).body.data;
    expect(preparedRead.summary).toEqual(pending);
    expect(pending.currentConfirmed).toEqual(formal);
    expect(pending.formalStatus).toBe('confirmed');
    const cancelledRead = await interleave(() =>
      post(`${root}/outcome-corrections/${correction.outcomeRevisionId}/cancel`, {
        operationKey: key(),
        expectedLatestRevision: 3,
        expectedConfirmedRevision: 2,
      }).expect(200),
    );
    const cancelled = (await get(row.id).expect(200)).body.data;
    expect(cancelledRead.summary).toEqual(cancelled);
    expect(cancelled.currentConfirmed).toEqual(formal);
    expect(cancelled.formalStatus).toBe('confirmed');
    const next = (await prepare(3)).body.data;
    const replacedRead = await interleave(() => confirm(next.outcomeRevisionId as string, 4, 2));
    const replaced = (await get(row.id).expect(200)).body.data;
    expect(replacedRead.summary).toEqual(replaced);
    expect(replaced.currentConfirmed.revision).toBe(5);
    expect(replaced.currentConfirmed.metrics[0].value).toBe(false);
    expect(await prisma.activityOutcomeRevision.count({ where: { activityId: row.id } })).toBe(5);
    expect(
      (
        await prisma.activityOutcomeRevision.findUniqueOrThrow({
          where: { id: formal.outcomeRevisionId as string },
        })
      ).statusCode,
    ).toBe('superseded');
    await prisma.activity.update({
      where: { id: row.id },
      data: { statusCode: 'archived', archivedFromStatusCode: 'completed' },
    });
    await prisma.activityMetricSetVersion.update({
      where: { id: set.id },
      data: { statusCode: 'retired', retiredAt: new Date() },
    });
    await prisma.activityMetricDefinition.update({
      where: { id: definition.id },
      data: { statusCode: 'retired', retiredAt: new Date() },
    });
    expect((await get(row.id).expect(200)).body.data.currentConfirmed).toEqual(
      replaced.currentConfirmed,
    );
  });

  it('reads the full 20 x 100 x 20 formal fixture within the unchanged query budget', async () => {
    const post = (url: string, body: object) =>
      request(httpServer(app)).post(url).set('Authorization', auth).send(body);
    const definitions: { id: string; definitionHash: string; value: string | number | boolean }[] =
      [];
    for (let i = 0; i < 100; i++) {
      const configuration =
        i % 4 === 0
          ? { kindCode: 'boolean', unit: null }
          : i % 4 === 1
            ? { kindCode: 'non_negative_integer', unit: '人', minimum: 0, maximum: 100 }
            : i % 4 === 2
              ? {
                  kindCode: 'non_negative_decimal',
                  unit: '米',
                  scale: 2,
                  minimum: '0',
                  maximum: '100',
                }
              : {
                  kindCode: 'single_choice',
                  unit: null,
                  options: [
                    { code: 'yes', label: '是' },
                    { code: 'no', label: '否' },
                  ],
                };
      const definition = parseMetricReceipt(
        (
          await post('/api/admin/v1/activity-metric-definitions', {
            operationKey: key(),
            definition: {
              schemaVersion: 1,
              code: key(),
              version: 1,
              name: '满额指标',
              configuration,
            },
          }).expect(201)
        ).body.data,
      );
      await post(`/api/admin/v1/activity-metric-definitions/${definition.id}/activate`, {
        operationKey: key(),
        expectedDefinitionHash: definition.definitionHash,
      }).expect(200);
      definitions.push({
        id: definition.id,
        definitionHash: definition.definitionHash,
        value: i % 4 === 0 ? false : i % 4 === 1 ? 0 : i % 4 === 2 ? '0.25' : 'yes',
      });
    }
    const set = parseMetricReceipt(
      (
        await post('/api/admin/v1/activity-metric-sets', {
          operationKey: key(),
          definition: {
            schemaVersion: 1,
            code: key(),
            version: 1,
            name: '满额集合',
            items: definitions.map((d, i) => ({
              key: `metric_${i}`,
              sortOrder: i,
              required: true,
              metricDefinitionId: d.id,
              definitionHash: d.definitionHash,
            })),
          },
        }).expect(201)
      ).body.data,
    );
    await post(`/api/admin/v1/activity-metric-sets/${set.id}/activate`, {
      operationKey: key(),
      expectedDefinitionHash: set.definitionHash,
    }).expect(200);
    const anchors = { metricSetVersionId: set.id, metricSetDefinitionHash: set.definitionHash };
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const row = await activity();
      ids.push(row.id);
      await prisma.activity.update({
        where: { id: row.id },
        data: {
          metricRequirementCode: 'required',
          selectedMetricSetVersionId: set.id,
          selectedMetricSetDefinitionHash: set.definitionHash,
          metricSelectionRevision: 1,
        },
      });
      const root = `/api/app/v1/my/managed-activities/${row.id}`;
      const draft = (
        await post(`${root}/outcomes`, {
          ...anchors,
          operationKey: key(),
          expectedRevision: 0,
          values: definitions.map((d) => ({
            metricDefinitionId: d.id,
            value: d.value,
            evidenceAttachmentIds: [],
          })),
        }).expect(201)
      ).body.data;
      const draftValues = await prisma.activityMetricValueRevision.findMany({
        where: { outcomeRevisionId: draft.outcomeRevisionId },
      });
      await prisma.activityResponsibilityAssignment.create({
        data: {
          activityId: row.id,
          memberId,
          responsibilityType: 'owner',
          status: 'active',
          assignedByUserId: userId,
          source: 'publish',
          canManageRegistrations: true,
          canManageAttendance: true,
        },
      });
      await prisma.activity.update({ where: { id: row.id }, data: { statusCode: 'completed' } });
      const evidence: string[] = [];
      for (let e = 0; e < 20; e++) {
        const attachment = await prisma.attachment.create({
          data: {
            key: `attachments/c5/${key()}.txt`,
            originalName: 'evidence.txt',
            mime: 'text/plain',
            size: 7,
            uploadedBy: userId,
            ownerType: 'activity',
            ownerId: row.id,
          },
        });
        await prisma.storageObject.create({
          data: {
            key: attachment.key,
            state: 'available',
            source: 'attachment_signed_upload',
            providerType: 'LOCAL',
            localNamespace: 'c5-test',
            expectedSize: 7n,
            actualSize: 7n,
            expectedMime: 'text/plain',
            resourceType: 'attachment',
            resourceId: attachment.id,
            verifiedAt: new Date(),
            presentAt: new Date(),
            lastProviderCheckedAt: new Date(),
          },
        });
        evidence.push(attachment.id);
      }
      await post(`${root}/outcome-confirmations`, {
        ...anchors,
        operationKey: key(),
        expectedLatestRevision: 1,
        expectedConfirmedRevision: 0,
        manualDraftId: draft.outcomeRevisionId,
        values: draftValues.map((v) => ({
          metricDefinitionId: v.metricDefinitionId,
          sourceKind: 'manual',
          sourceValueId: v.id,
          evidenceAttachmentIds: evidence,
        })),
      }).expect(201);
    }
    expect(
      await prisma.activityMetricValueEvidence.count({ where: { activityId: { in: ids } } }),
    ).toBe(40000);
    // Later non-formal revisions must not replace or expand the formal selector.
    await prisma.activityOutcomeRevision.createMany({
      data: ids.flatMap((activityId) =>
        Array.from({ length: 500 }, (_, i) => ({
          activityId,
          revision: i + 3,
          ...anchors,
          statusCode: 'draft',
          createdByUserId: userId,
        })),
      ),
    });
    const readCounts = () =>
      Promise.all([
        prisma.activityOutcomeRevision.count(),
        prisma.activityMetricValueRevision.count(),
        prisma.activityMetricValueEvidence.count(),
        prisma.activityOutcomeCommandReceipt.count(),
        prisma.activityOutcomeFinalizationReceipt.count(),
        prisma.auditLog.count(),
      ]);
    const before = await readCounts();
    const started = performance.now();
    const response = await post('/api/app/v1/my/managed-activities/outcome-reports/query', {
      activityIds: [...ids].reverse(),
    }).expect(200);
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(30000);
    expect(response.body.code).toBe(0);
    const items: {
      activityId: string;
      currentConfirmed: {
        metrics: {
          metricDefinitionId: string;
          definitionHash: string;
          value: string | number | boolean;
        }[];
      };
    }[] = response.body.data.items;
    expect(items.map((r) => r.activityId)).toEqual([...ids].sort());
    for (const report of items) {
      expect(report.currentConfirmed.metrics).toHaveLength(100);
      for (const value of report.currentConfirmed.metrics) {
        const expected = definitions.find((d) => d.id === value.metricDefinitionId);
        expect(value.value).toBe(expected?.value);
        expect(value.definitionHash).toBe(expected?.definitionHash);
        expect(value).not.toHaveProperty('evidence');
      }
    }
    expect(await readCounts()).toEqual(before);
    expect(
      await prisma.activityMetricValueEvidence.count({ where: { activityId: { in: ids } } }),
    ).toBe(40000);
    const observed = new ObservedReportDatabase({ log: [{ emit: 'event', level: 'query' }] });
    const statements: string[] = [];
    observed.$on('query', (event) => {
      statements.push(event.query);
    });
    let sqlCount = 0;
    try {
      await assertConnectedTestDatabase(observed);
      const actor = await loadActiveUserIdentityInTx(observed, userId);
      if (!actor) throw new Error('C5 observed actor missing');
      statements.length = 0;
      const observedResult = await new ActivityOutcomeReportQueryService(
        observed,
        app.get(ActivityOutcomeAccessService),
      ).query([...ids].reverse(), actor);
      expect(observedResult).toEqual(response.body.data);
      sqlCount = statements.length;
      expect(sqlCount).toBeGreaterThan(20);
      expect(sqlCount).toBeLessThan(3000);
      expect(
        statements.filter((sql) => sql.includes('FROM "public"."ActivityOutcomeRevision"')),
      ).toHaveLength(20);
      expect(statements.filter((sql) => /FOR UPDATE/.test(sql))).toHaveLength(20);
      expect(statements.filter((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql))).toEqual([]);
      expect(await readCounts()).toEqual(before);
    } finally {
      await observed.$disconnect();
    }
    console.info('C5 full capacity', {
      activities: 20,
      values: 2000,
      evidence: 40000,
      retainedNonFormalRevisions: 10000,
      sqlCount,
      elapsedMs: Math.round(elapsedMs),
      responseBytes: Buffer.byteLength(JSON.stringify(response.body)),
    });
  }, 240000);

  it('rechecks current organization, member, user and explicit scope without a role shortcut', async () => {
    const row = await activity();
    const other = await prisma.organization.create({
      data: {
        name: key(),
        nodeTypeCode: 'team',
        parentId: (await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }))
          .parentId,
      },
    });
    try {
      await prisma.roleBinding.update({
        where: { id: bindingId },
        data: { scopeType: 'ORGANIZATION', scopeOrgId: other.id },
      });
      expectBizError(await get(row.id), BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
      await prisma.roleBinding.update({
        where: { id: bindingId },
        data: { scopeType: 'GLOBAL', scopeOrgId: null },
      });
      await prisma.organization.update({
        where: { id: organizationId },
        data: { status: 'INACTIVE' },
      });
      expectBizError(await get(row.id), BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
      await prisma.organization.update({
        where: { id: organizationId },
        data: { status: 'ACTIVE' },
      });
      await prisma.member.update({ where: { id: memberId }, data: { status: 'INACTIVE' } });
      expectBizError(await get(row.id), BizCode.FORBIDDEN);
      await prisma.member.update({ where: { id: memberId }, data: { status: 'ACTIVE' } });
      await prisma.user.update({ where: { id: userId }, data: { status: 'DISABLED' } });
      expectBizError(await get(row.id), BizCode.UNAUTHORIZED);
      await prisma.user.update({
        where: { id: userId },
        data: { status: 'ACTIVE', role: Role.USER },
      });
      expect((await get(row.id).expect(200)).body.data.activityId).toBe(row.id);
      await prisma.activity.update({ where: { id: row.id }, data: { statusCode: 'completed' } });
      expectBizError(await get(row.id), BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
    } finally {
      await prisma.roleBinding.update({
        where: { id: bindingId },
        data: { scopeType: 'GLOBAL', scopeOrgId: null },
      });
      await prisma.organization.update({
        where: { id: organizationId },
        data: { status: 'ACTIVE' },
      });
      await prisma.member.update({ where: { id: memberId }, data: { status: 'ACTIVE' } });
      await prisma.user.update({
        where: { id: userId },
        data: { status: 'ACTIVE', role: Role.SUPER_ADMIN },
      });
    }
  });

  it('rejects verified machine tokens on both Human report routes', async () => {
    const row = await activity();
    const actor = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const meta = { requestId: key(), ip: null, ua: null };
    const service = app.get(ServicePrincipalsService);
    const principal = await service.create({ name: 'C5机器边界测试' }, actor, meta);
    const credential = await service.createCredential(principal.id, actor, meta);
    const tokens = app.get(ServiceTokenService);
    const gate = app.get(IntegrationAuthGate);
    // Offline signature fixture: do not enable the Integration Gate to test a Human boundary.
    const token = new JwtService({ secret: gate.jwtSecret }).sign(
      { tokenUse: 'service', credentialId: credential.id },
      {
        algorithm: 'HS256',
        subject: principal.id,
        issuer: gate.issuer,
        audience: gate.audience,
        jwtid: randomUUID(),
        expiresIn: gate.serviceTokenTtlSeconds,
      },
    );
    expect(tokens.verifyToken(token).tokenUse).toBe('service');
    expect(gate.isEnabled()).toBe(false);
    const machine = 'Bearer ' + token;
    expectBizError(
      await request(httpServer(app))
        .get(`/api/app/v1/my/managed-activities/${row.id}/outcome-report`)
        .set('Authorization', machine),
      BizCode.UNAUTHORIZED,
    );
    expectBizError(
      await request(httpServer(app))
        .post('/api/app/v1/my/managed-activities/outcome-reports/query')
        .set('Authorization', machine)
        .send({ activityIds: [row.id] }),
      BizCode.UNAUTHORIZED,
    );
  });

  it('does not treat settlement review permission as outcome read authority', async () => {
    const row = await activity();
    const binding = await prisma.roleBinding.findUniqueOrThrow({ where: { id: bindingId } });
    const role = await prisma.rbacRole.create({ data: { code: key(), displayName: '仅结算' } });
    const permission = await prisma.permission.upsert({
      where: { code: 'activity.settlement-final-review.record' },
      update: {},
      create: {
        code: 'activity.settlement-final-review.record',
        module: 'activity',
        action: 'settlement-final-review',
        resourceType: 'record',
        description: '测试',
        servicePrincipalAllowed: false,
        delegatedAccessAllowed: false,
      },
    });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    try {
      await prisma.roleBinding.update({ where: { id: bindingId }, data: { roleId: role.id } });
      expectBizError(await get(row.id), BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
      expectBizError(
        await request(httpServer(app))
          .post('/api/app/v1/my/managed-activities/outcome-reports/query')
          .set('Authorization', auth)
          .send({ activityIds: [row.id] }),
        BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE,
      );
    } finally {
      await prisma.roleBinding.update({
        where: { id: bindingId },
        data: { roleId: binding.roleId },
      });
    }
  });

  it('refuses cross-initiator access without deleting data', async () => {
    const row = await activity();
    const other = await prisma.member.create({
      data: { memberNo: key(), ...memberIdentityData('另一成员'), gradeCode: 'level-3' },
    });
    await prisma.activity.update({ where: { id: row.id }, data: { initiatorMemberId: other.id } });
    expectBizError(await get(row.id), BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
    expect(await prisma.activity.count({ where: { id: row.id } })).toBe(1);
    expect(await prisma.roleBinding.findUnique({ where: { id: bindingId } })).not.toBeNull();
  });
});
