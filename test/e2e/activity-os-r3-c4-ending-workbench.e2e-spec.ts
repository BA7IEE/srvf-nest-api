import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
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

describe('C4 ending workbench HTTP', () => {
  let app: INestApplication;
  let peer: INestApplication;
  let prisma: PrismaService;
  let auth: string;
  let userId: string;
  let memberId: string;
  let organizationId: string;
  let bindingId: string;
  const key = () => `c4_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const get = (id: string) =>
    request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${id}/ending-workbench`)
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
  });
  it('does not grant SUPER_ADMIN a role shortcut', async () => {
    const row = await activity();
    expectBizError(await get(row.id), BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
  });
  it('reads unconfigured facts after an explicit permission grant without changing data', async () => {
    const role = await prisma.rbacRole.create({ data: { code: key(), displayName: 'C4只读' } });
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
      selectedMetricSetVersionId: null,
      currentConfirmed: null,
      pendingDraft: null,
      notices: [{ code: 'metric_selection_unconfigured', target: 'metric_selection' }],
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
    expect(result.body.data.notices).toEqual([]);
  });
  it('does not reveal a draft belonging to a different initiator', async () => {
    const other = await prisma.member.create({
      data: { memberNo: key(), ...memberIdentityData('另一成员'), gradeCode: 'level-3' },
    });
    const row = await activity();
    await prisma.activity.update({ where: { id: row.id }, data: { initiatorMemberId: other.id } });
    expectBizError(await get(row.id), BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
    expectBizError(await get(key()), BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
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
          .get(`${root}/ending-workbench`)
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
    expect((await get(row.id).expect(200)).body.data.notices).toEqual([
      { code: 'formal_outcome_missing', target: 'outcome_history' },
    ]);
    const anchors = { metricSetVersionId: set.id, metricSetDefinitionHash: set.definitionHash };
    const draftId = (
      await post(`${root}/outcomes`, {
        ...anchors,
        operationKey: key(),
        expectedRevision: 0,
        values: [{ metricDefinitionId: definition.id, value: true, evidenceAttachmentIds: [] }],
      }).expect(201)
    ).body.data.outcomeRevisionId as string;
    expect((await get(row.id).expect(200)).body.data.pendingDraft).toMatchObject({
      id: draftId,
      kind: 'initial',
      baseConfirmedRevision: null,
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
    const attachment = await prisma.attachment.create({
      data: {
        key: `attachments/c4/${key()}.txt`,
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
        localNamespace: 'c4-test',
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
    expect(initialRead.summary.pendingDraft).toBeNull();
    expect(formal).toMatchObject({ revision: 2, valueCount: 1, metricSetVersionId: set.id });
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
    expect(pending.pendingDraft).toMatchObject({
      id: correction.outcomeRevisionId,
      kind: 'correction',
      baseConfirmedRevision: 2,
    });
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
    expect(cancelled.pendingDraft).toBeNull();
    expect(cancelled.notices).toEqual([]);
    const next = (await prepare(3)).body.data;
    const replacedRead = await interleave(() => confirm(next.outcomeRevisionId as string, 4, 2));
    const replaced = (await get(row.id).expect(200)).body.data;
    expect(replacedRead.summary).toEqual(replaced);
    expect(replaced.currentConfirmed.revision).toBe(5);
    expect(replaced.pendingDraft).toBeNull();
    expect(await prisma.activityOutcomeRevision.count({ where: { activityId: row.id } })).toBe(5);
    expect(
      (
        await prisma.activityOutcomeRevision.findUniqueOrThrow({
          where: { id: formal.id as string },
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

  it('rejects inactive organization and member without deleting their activity', async () => {
    const row = await activity();
    try {
      await prisma.organization.update({
        where: { id: organizationId },
        data: { status: 'INACTIVE' },
      });
      expectBizError(await get(row.id), BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
    } finally {
      await prisma.organization.update({
        where: { id: organizationId },
        data: { status: 'ACTIVE' },
      });
    }
    try {
      await prisma.member.update({ where: { id: memberId }, data: { status: 'INACTIVE' } });
      expectBizError(await get(row.id), BizCode.FORBIDDEN);
    } finally {
      await prisma.member.update({ where: { id: memberId }, data: { status: 'ACTIVE' } });
    }
    expect(
      (await prisma.activity.findUniqueOrThrow({ where: { id: row.id } })).deletedAt,
    ).toBeNull();
  });

  it('enforces current grant revocation', async () => {
    const row = await activity();
    await prisma.roleBinding.update({ where: { id: bindingId }, data: { status: 'SUSPENDED' } });
    expectBizError(await get(row.id), BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE);
  });
});
