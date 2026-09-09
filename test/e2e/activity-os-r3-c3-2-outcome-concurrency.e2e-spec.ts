import { ActivityOutcomeFinalizationAuditRecorder } from '../../src/modules/activities/activity-outcome-finalization-audit-recorder';
import { ActivityOutcomeAccessService } from '../../src/modules/activities/activity-outcome-access.service';
import { AttachmentStorageOrchestrator } from '../../src/modules/attachments/attachment-storage-orchestrator';
import { BizException } from '../../src/common/exceptions/biz.exception';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, Role, UserStatus } from '@prisma/client';
import { waitFor } from '../helpers/wait-for';
import request from 'supertest';
import { PrismaService } from '../../src/database/prisma.service';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { parseMetricReceipt } from '../../src/modules/activities/activity-metric-command';
import { createTestUser } from '../fixtures/users.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertConnectedTestDatabase } from '../setup/test-db';

describe('C3-2 independent-pool concurrency and rollback', () => {
  let app: INestApplication;
  let peer: INestApplication;
  let prisma: PrismaService;
  let auth: string;
  let actorId: string;
  let memberId: string;
  let organizationId: string;
  let setId: string;
  let setHash: string;
  let definitionId: string;
  let sequence = 0;
  const runId = randomUUID().replaceAll('-', '').slice(0, 12);
  const key = () => `finalization_${runId}_${++sequence}`;
  const base = (id: string) => `/api/app/v1/my/managed-activities/${id}/outcomes`;
  const post = (path: string, body: object, authorization = auth) =>
    request(httpServer(app)).post(path).set('Authorization', authorization).send(body);
  const get = (path: string, authorization = auth) =>
    request(httpServer(app)).get(path).set('Authorization', authorization);
  const command = (expectedRevision = 0) => ({
    operationKey: key(),
    expectedRevision,
    metricSetVersionId: setId,
    metricSetDefinitionHash: setHash,
    values: [{ metricDefinitionId: definitionId, value: true, evidenceAttachmentIds: [] }],
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
        startAt: new Date('2099-09-01'),
        endAt: new Date('2099-09-02'),
        location: '测试',
        metricRequirementCode: 'required',
        selectedMetricSetVersionId: setId,
        selectedMetricSetDefinitionHash: setHash,
        metricSelectionRevision: 1,
      },
    });
  beforeAll(async () => {
    app = await createTestApp();
    peer = await createTestApp();
    prisma = app.get(PrismaService);
    await assertConnectedTestDatabase(prisma);
    await resetDb(app);
    const actor = await createTestUser(app, { username: key(), role: Role.SUPER_ADMIN });
    actorId = actor.id;
    const member = await prisma.member.create({
      data: { memberNo: key(), ...memberIdentityData('成果测试'), gradeCode: 'level-3' },
    });
    memberId = member.id;
    await prisma.user.update({ where: { id: actorId }, data: { memberId } });
    auth = (await loginAs(app, actor.username)).authHeader;
    const parent = await prisma.organization.create({
      data: { name: key(), nodeTypeCode: 'root' },
    });
    organizationId = (
      await prisma.organization.create({
        data: { name: key(), nodeTypeCode: 'team', parentId: parent.id },
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
            name: '完成',
            configuration: { kindCode: 'boolean', unit: null },
          },
        }).expect(201)
      ).body.data,
    );
    definitionId = definition.id;
    await post(`/api/admin/v1/activity-metric-definitions/${definitionId}/activate`, {
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
                metricDefinitionId: definitionId,
                definitionHash: definition.definitionHash,
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
  afterAll(async () => {
    await peer?.close();
    await app?.close();
  });

  async function grant(userId: string) {
    const role = await prisma.rbacRole.create({
      data: { code: key(), displayName: '成果显式授权' },
    });
    for (const action of ['read', 'record', 'confirm', 'correct']) {
      const code = `activity.outcome.${action}`;
      const permission = await prisma.permission.upsert({
        where: { code },
        update: {},
        create: {
          code,
          module: 'activity',
          action: 'outcome',
          resourceType: action,
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
      data: { principalType: 'USER', principalId: userId, roleId: role.id, scopeType: 'GLOBAL' },
    });
  }

  async function ready() {
    await grant(actorId);
    const row = await activity();
    const root = `/api/app/v1/my/managed-activities/${row.id}`;
    expect((await get(`${root}/outcome-confirmed`).expect(200)).body.data).toBeNull();
    const draft = (await post(base(row.id), command()).expect(201)).body.data as {
      outcomeRevisionId: string;
    };
    const detail = (await get(`${base(row.id)}/${draft.outcomeRevisionId}`).expect(200)).body
      .data as { values: { valueRevisionId: string }[] };
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: row.id,
        memberId,
        responsibilityType: 'owner',
        status: 'active',
        canManageRegistrations: true,
        canManageAttendance: true,
        assignedByUserId: actorId,
        source: 'publish',
      },
    });
    await prisma.activity.update({ where: { id: row.id }, data: { statusCode: 'completed' } });
    const attachment = await prisma.attachment.create({
      data: {
        key: `attachments/c3-finalization/${key()}.txt`,
        originalName: 'evidence.txt',
        mime: 'text/plain',
        size: 7,
        uploadedBy: actorId,
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
        localNamespace: 'c3-finalization-test',
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
    const confirmation = {
      operationKey: key(),
      expectedLatestRevision: 1,
      expectedConfirmedRevision: 0,
      metricSetVersionId: setId,
      metricSetDefinitionHash: setHash,
      manualDraftId: draft.outcomeRevisionId,
      values: [
        {
          metricDefinitionId: definitionId,
          sourceKind: 'manual',
          sourceValueId: detail.values[0].valueRevisionId,
          evidenceAttachmentIds: [attachment.id],
        },
      ],
    };
    const deletion = {
      attachmentId: attachment.id,
      actorUserId: actorId,
      actorRoleSnap: Role.SUPER_ADMIN,
      allowAuthorizedJoin: false,
      scope: 'self' as const,
      deletedByPath: 'owner' as const,
      auditMeta: { requestId: 'c32-evidence-race', ip: null, ua: null },
    };
    return { row, root, confirmation, draft, attachment, deletion };
  }
  async function barrier(
    lock: Prisma.Sql,
    beforeCommit?: (tx: Prisma.TransactionClient) => Promise<unknown>,
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
        if (beforeCommit) await beforeCommit(tx);
      },
      { timeout: 10000 },
    );
    const pid = await Promise.race([
      ready,
      held.then(() => {
        throw new Error('lock holder ended before readiness');
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
  async function waiting(pid: number, count = 1) {
    await waitFor(
      async () => {
        const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
        WITH RECURSIVE waiters AS (
          SELECT a.pid, pg_blocking_pids(a.pid) AS blockers FROM pg_stat_activity AS a
          WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
        ), blocked_chain AS (
          SELECT pid FROM waiters WHERE ${pid} = ANY(blockers)
          UNION SELECT w.pid FROM waiters w JOIN blocked_chain b ON b.pid = ANY(w.blockers)
        ) SELECT count(*) FROM blocked_chain`;
        return row.count >= BigInt(count);
      },
      { timeoutMs: 2500, message: 'outcome writer did not reach the intended database lock' },
    );
  }

  const peerPost = (path: string, body: object) =>
    request(httpServer(peer)).post(path).set('Authorization', auth).send(body);

  async function facts(activityId: string) {
    return {
      heads: await prisma.activityOutcomeRevision.findMany({
        where: { activityId },
        orderBy: { revision: 'asc' },
      }),
      values: await prisma.activityMetricValueRevision.findMany({
        where: { activityId },
        orderBy: { id: 'asc' },
      }),
      evidence: await prisma.activityMetricValueEvidence.findMany({
        where: { activityId },
        orderBy: { id: 'asc' },
      }),
      sources: await prisma.activityOutcomeValueSource.findMany({
        where: { activityId },
        orderBy: { id: 'asc' },
      }),
      receipts: await prisma.activityOutcomeFinalizationReceipt.findMany({
        where: { activityId },
        orderBy: { id: 'asc' },
      }),
      audit: await prisma.auditLog.findMany({
        where: { event: 'activity.outcome.finalization', resourceId: activityId },
        orderBy: { id: 'asc' },
      }),
    };
  }

  it('returns the identical receipt across independent pools for a concurrent same-key request', async () => {
    const { row, root, confirmation } = await ready();
    const [left, right] = await Promise.all([
      post(`${root}/outcome-confirmations`, confirmation).expect(201),
      peerPost(`${root}/outcome-confirmations`, confirmation).expect(201),
    ]);
    expect(left.body).toEqual(right.body);
    const state = await facts(row.id);
    expect(state.heads).toHaveLength(2);
    expect(state.receipts).toHaveLength(1);
    expect(state.audit).toHaveLength(1);
    expectBizError(
      await peerPost(`${root}/outcome-confirmations`, {
        ...confirmation,
        expectedConfirmedRevision: 1,
      }),
      BizCode.ACTIVITY_OUTCOME_COMMAND_CONFLICT,
    );
    expect(await facts(row.id)).toEqual(state);
  });

  it('allows only one distinct command to consume the same two revision anchors', async () => {
    const { row, root, confirmation } = await ready();
    const responses = await Promise.all([
      post(`${root}/outcome-confirmations`, confirmation),
      peerPost(`${root}/outcome-confirmations`, { ...confirmation, operationKey: key() }),
    ]);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    const rejected = responses.find((response) => response.status !== 201);
    expect(rejected).toBeDefined();
    expectBizError(rejected!, BizCode.ACTIVITY_OUTCOME_STALE);
    const state = await facts(row.id);
    expect(state.heads.filter((head) => head.statusCode === 'confirmed')).toHaveLength(1);
    expect(state.receipts).toHaveLength(1);
    expect(state.audit).toHaveLength(1);
  });

  it('serializes confirmation against cancellation without losing the current formal head', async () => {
    const { row, root, confirmation } = await ready();
    const initial = await post(`${root}/outcome-confirmations`, confirmation).expect(201);
    const prepared = await post(`${root}/outcome-corrections`, {
      operationKey: key(),
      expectedLatestRevision: 2,
      expectedConfirmedRevision: 2,
      metricSetVersionId: setId,
      metricSetDefinitionHash: setHash,
      values: [
        {
          metricDefinitionId: definitionId,
          sourceKind: 'manual',
          value: false,
          evidenceAttachmentIds: [],
        },
      ],
    }).expect(201);
    const draftId = prepared.body.data.outcomeRevisionId as string;
    const draftDetail = (await get(`${base(row.id)}/${draftId}`).expect(200)).body.data as {
      values: { valueRevisionId: string }[];
    };
    const [confirmed, cancelled] = await Promise.all([
      post(`${root}/outcome-confirmations`, {
        ...confirmation,
        operationKey: key(),
        expectedLatestRevision: 3,
        expectedConfirmedRevision: 2,
        manualDraftId: draftId,
        values: [
          { ...confirmation.values[0], sourceValueId: draftDetail.values[0].valueRevisionId },
        ],
      }),
      peerPost(`${root}/outcome-corrections/${draftId}/cancel`, {
        operationKey: key(),
        expectedLatestRevision: 3,
        expectedConfirmedRevision: 2,
      }),
    ]);
    expect(Number(confirmed.status === 201) + Number(cancelled.status === 200)).toBe(1);
    expectBizError(
      confirmed.status === 201 ? cancelled : confirmed,
      BizCode.ACTIVITY_OUTCOME_STALE,
    );
    const state = await facts(row.id);
    const formal = state.heads.filter((head) => head.statusCode === 'confirmed');
    expect(formal).toHaveLength(1);
    expect(formal[0].id).toBe(
      confirmed.status === 201
        ? confirmed.body.data.outcomeRevisionId
        : initial.body.data.outcomeRevisionId,
    );
    expect(state.receipts).toHaveLength(3);
    expect(state.audit).toHaveLength(3);
    expect(state.heads.find((head) => head.id === draftId)?.statusCode).toBe('superseded');
    expect(state.values.some((value) => value.outcomeRevisionId === draftId)).toBe(true);
  });

  it.each([
    ['activity', false],
    ['activity', true],
    ['command', false],
    ['command', true],
  ] as const)('rechecks a disabled user after the %s lock, replay=%s', async (kind, replay) => {
    const { row, root, confirmation } = await ready();
    if (replay) await post(`${root}/outcome-confirmations`, confirmation).expect(201);
    const before = await facts(row.id);
    const lockKey = JSON.stringify([
      'activity-outcome-finalization',
      actorId,
      'confirm_outcome',
      confirmation.operationKey,
    ]);
    const holder = await barrier(
      kind === 'activity'
        ? Prisma.sql`SELECT id FROM "Activity" WHERE id = ${row.id} FOR UPDATE`
        : Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`,
      (tx) => tx.user.update({ where: { id: actorId }, data: { status: UserStatus.DISABLED } }),
    );
    const pending = peerPost(`${root}/outcome-confirmations`, confirmation).then(
      (response) => response,
    );
    try {
      try {
        await waiting(holder.pid);
      } finally {
        await holder.release();
      }
      expectBizError(await pending, BizCode.UNAUTHORIZED);
      expect(await facts(row.id)).toEqual(before);
    } finally {
      await prisma.user.update({ where: { id: actorId }, data: { status: UserStatus.ACTIVE } });
    }
  });

  it.each(
    (['user', 'member', 'organization', 'permission', 'owner'] as const).flatMap((loss) =>
      (['activity', 'command', 'set', 'definition', 'attachment'] as const).flatMap((kind) =>
        (kind === 'activity' || kind === 'command' ? [false, true] : [false]).map((replay) => ({
          loss,
          kind,
          replay,
        })),
      ),
    ),
  )('rejects $loss loss after $kind lock, replay=$replay', async ({ loss, kind, replay }) => {
    const { row, root, confirmation, attachment } = await ready();
    if (replay) await post(`${root}/outcome-confirmations`, confirmation).expect(201);
    const before = await facts(row.id);
    const bindings = await prisma.roleBinding.findMany({
      where: { principalType: 'USER', principalId: actorId, deletedAt: null },
      select: { id: true, endedAt: true },
    });
    const expired = new Date('2000-01-01T00:00:00.000Z');
    const loseAccess = async (tx: Prisma.TransactionClient) => {
      if (loss === 'user')
        await tx.user.update({ where: { id: actorId }, data: { status: 'DISABLED' } });
      else if (loss === 'member')
        await tx.member.update({ where: { id: memberId }, data: { status: 'INACTIVE' } });
      else if (loss === 'organization')
        await tx.organization.update({
          where: { id: organizationId },
          data: { status: 'INACTIVE' },
        });
      else if (loss === 'permission')
        await tx.roleBinding.updateMany({
          where: { id: { in: bindings.map((binding) => binding.id) } },
          data: { endedAt: expired },
        });
      else
        await tx.activityResponsibilityAssignment.updateMany({
          where: { activityId: row.id, memberId, responsibilityType: 'owner' },
          data: { status: 'ended', endedAt: new Date(), endedByUserId: actorId },
        });
    };
    const lockKey = JSON.stringify([
      'activity-outcome-finalization',
      actorId,
      'confirm_outcome',
      confirmation.operationKey,
    ]);
    const locks = {
      activity: Prisma.sql`SELECT id FROM "Activity" WHERE id = ${row.id} FOR UPDATE`,
      command: Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`,
      set: Prisma.sql`SELECT id FROM "ActivityMetricSetVersion" WHERE id = ${setId} FOR UPDATE`,
      definition: Prisma.sql`SELECT id FROM "ActivityMetricDefinition" WHERE id = ${definitionId} FOR UPDATE`,
      attachment: Prisma.sql`SELECT id FROM "attachments" WHERE id = ${attachment.id} FOR UPDATE`,
    };
    const holder = await barrier(locks[kind], loseAccess);
    const pending = peerPost(`${root}/outcome-confirmations`, confirmation).then(
      (response) => response,
    );
    try {
      try {
        await waiting(holder.pid);
      } finally {
        await holder.release();
      }
      expectBizError(
        await pending,
        loss === 'user'
          ? BizCode.UNAUTHORIZED
          : loss === 'member'
            ? BizCode.FORBIDDEN
            : BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE,
      );
      expect(await facts(row.id)).toEqual(before);
    } finally {
      if (loss === 'user')
        await prisma.user.update({ where: { id: actorId }, data: { status: 'ACTIVE' } });
      if (loss === 'member')
        await prisma.member.update({ where: { id: memberId }, data: { status: 'ACTIVE' } });
      if (loss === 'organization')
        await prisma.organization.update({
          where: { id: organizationId },
          data: { status: 'ACTIVE' },
        });
      if (loss === 'permission')
        for (const binding of bindings)
          await prisma.roleBinding.update({
            where: { id: binding.id },
            data: { endedAt: binding.endedAt },
          });
    }
  });

  it.each(['unavailable', 'wrong-type', 'wrong-resource', 'delete-intent'] as const)(
    'revalidates storage %s after the actual attachment reference lock without partial writes',
    async (condition) => {
      const { row, root, confirmation, attachment } = await ready();
      const before = await facts(row.id);
      const holder = await barrier(
        Prisma.sql`SELECT id FROM "attachments" WHERE id = ${attachment.id} FOR UPDATE`,
        (tx) =>
          tx.storageObject.update({
            where: { key: attachment.key },
            data:
              condition === 'unavailable'
                ? { state: 'missing', missingAt: new Date() }
                : condition === 'wrong-type'
                  ? { resourceType: 'other' }
                  : condition === 'wrong-resource'
                    ? { resourceId: 'other' }
                    : { deleteRequestedAt: new Date() },
          }),
      );
      const pending = peerPost(`${root}/outcome-confirmations`, confirmation).then(
        (response) => response,
      );
      try {
        await waiting(holder.pid);
      } finally {
        await holder.release();
      }
      expectBizError(await pending, BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
      expect(await facts(row.id)).toEqual(before);
    },
  );

  it('rejects confirmation after a competing attachment delete intent wins the lock', async () => {
    const { row, root, confirmation, attachment, deletion } = await ready();
    const before = await facts(row.id);
    const holder = await barrier(
      Prisma.sql`SELECT id FROM "attachments" WHERE id = ${attachment.id} FOR UPDATE`,
      (tx) => app.get(AttachmentStorageOrchestrator).prepareDeleteInTransaction(tx, deletion),
    );
    const pending = peerPost(`${root}/outcome-confirmations`, confirmation).then(
      (response) => response,
    );
    try {
      await waiting(holder.pid);
    } finally {
      await holder.release();
    }
    expectBizError(await pending, BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING);
    expect(await facts(row.id)).toEqual(before);
    expect(await prisma.attachment.findUnique({ where: { id: attachment.id } })).not.toBeNull();
  });

  it('protects evidence when confirmation commits before the competing delete intent', async () => {
    const { row, root, confirmation, attachment, deletion } = await ready();
    const audit = app.get(ActivityOutcomeFinalizationAuditRecorder);
    const original = audit.log.bind(audit);
    let notify!: (pid: number) => void;
    let release!: () => void;
    const atAudit = new Promise<number>((resolve) => {
      notify = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = jest.spyOn(audit, 'log').mockImplementationOnce(async (...args) => {
      const [backend] = await args[0].$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      notify(backend.pid);
      await released;
      await original(...args);
    });
    const outcome = post(`${root}/outcome-confirmations`, confirmation).then(
      (response) => response,
    );
    let pending: Promise<PromiseSettledResult<string>[]> | undefined;
    try {
      const pid = await Promise.race([
        atAudit,
        outcome.then(() => {
          throw new Error('confirmation ended before audit barrier');
        }),
      ]);
      pending = Promise.allSettled([
        peer.get(AttachmentStorageOrchestrator).prepareDelete(deletion),
      ]);
      await waiting(pid);
    } finally {
      release();
      spy.mockRestore();
    }
    expect((await outcome).status).toBe(201);
    expect(await pending).toMatchObject([
      { status: 'rejected', reason: { biz: BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING } },
    ]);
    expect(
      await prisma.activityMetricValueEvidence.count({ where: { attachmentId: attachment.id } }),
    ).toBe(1);
    expect((await facts(row.id)).receipts).toHaveLength(1);
    expect(await prisma.attachment.findUnique({ where: { id: attachment.id } })).not.toBeNull();
  });

  it.each(
    (['value', 'evidence', 'source', 'receipt'] as const).flatMap(
      (stage) =>
        [
          [stage, false],
          [stage, true],
        ] as const,
    ),
  )(
    'rolls back all prior writes when the %s write fails, correction=%s',
    async (stage, correction) => {
      const { row, root, confirmation } = await ready();
      let input = confirmation;
      if (correction) {
        await post(`${root}/outcome-confirmations`, confirmation).expect(201);
        const prepared = await post(`${root}/outcome-corrections`, {
          operationKey: key(),
          expectedLatestRevision: 2,
          expectedConfirmedRevision: 2,
          metricSetVersionId: setId,
          metricSetDefinitionHash: setHash,
          values: [
            {
              metricDefinitionId: definitionId,
              sourceKind: 'manual',
              value: false,
              evidenceAttachmentIds: [],
            },
          ],
        }).expect(201);
        const draftId = prepared.body.data.outcomeRevisionId as string;
        const value = await prisma.activityMetricValueRevision.findFirstOrThrow({
          where: { outcomeRevisionId: draftId },
        });
        input = {
          ...confirmation,
          operationKey: key(),
          expectedLatestRevision: 3,
          expectedConfirmedRevision: 2,
          manualDraftId: draftId,
          values: [{ ...confirmation.values[0], sourceValueId: value.id }],
        };
      }
      const before = await facts(row.id);
      const access = app.get(ActivityOutcomeAccessService);
      const original = access.authorize.bind(access);
      let injection: jest.SpyInstance | undefined;
      const hook = jest.spyOn(access, 'authorize').mockImplementationOnce(async (...args) => {
        const tx = args[0];
        const fault = new BizException(BizCode.ACTIVITY_OUTCOME_INVALID);
        switch (stage) {
          case 'value':
            injection = jest
              .spyOn(tx.activityMetricValueRevision, 'create')
              .mockRejectedValueOnce(fault);
            break;
          case 'evidence':
            injection = jest
              .spyOn(tx.activityMetricValueEvidence, 'createMany')
              .mockRejectedValueOnce(fault);
            break;
          case 'source':
            injection = jest
              .spyOn(tx.activityOutcomeValueSource, 'create')
              .mockRejectedValueOnce(fault);
            break;
          case 'receipt':
            injection = jest
              .spyOn(tx.activityOutcomeFinalizationReceipt, 'create')
              .mockRejectedValueOnce(fault);
            break;
        }
        return original(...args);
      });
      try {
        expectBizError(
          await post(`${root}/outcome-confirmations`, input),
          BizCode.ACTIVITY_OUTCOME_INVALID,
        );
        expect(injection).toHaveBeenCalledTimes(1);
      } finally {
        injection?.mockRestore();
        hook.mockRestore();
      }
      expect(await facts(row.id)).toEqual(before);
      await peerPost(`${root}/outcome-confirmations`, input).expect(201);
      expect((await facts(row.id)).receipts).toHaveLength(correction ? 3 : 1);
    },
  );

  it.each(['prepare', 'cancel'] as const)(
    'rolls back %s and preserves the formal result when audit fails',
    async (operation) => {
      const { row, root, confirmation } = await ready();
      await post(`${root}/outcome-confirmations`, confirmation).expect(201);
      const prepare = {
        operationKey: key(),
        expectedLatestRevision: 2,
        expectedConfirmedRevision: 2,
        metricSetVersionId: setId,
        metricSetDefinitionHash: setHash,
        values: [
          {
            metricDefinitionId: definitionId,
            sourceKind: 'manual',
            value: false,
            evidenceAttachmentIds: [],
          },
        ],
      };
      let path = `${root}/outcome-corrections`;
      let input: object = prepare;
      if (operation === 'cancel') {
        const draft = await post(path, prepare).expect(201);
        path = `${path}/${draft.body.data.outcomeRevisionId}/cancel`;
        input = { operationKey: key(), expectedLatestRevision: 3, expectedConfirmedRevision: 2 };
      }
      const before = await facts(row.id);
      const formal = (await get(`${root}/outcome-confirmed`).expect(200)).body.data;
      const spy = jest
        .spyOn(app.get(ActivityOutcomeFinalizationAuditRecorder), 'log')
        .mockRejectedValueOnce(new BizException(BizCode.ACTIVITY_OUTCOME_INVALID));
      try {
        expectBizError(await post(path, input), BizCode.ACTIVITY_OUTCOME_INVALID);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
      expect(await facts(row.id)).toEqual(before);
      expect((await get(`${root}/outcome-confirmed`).expect(200)).body.data).toEqual(formal);
      await peerPost(path, input).expect(operation === 'prepare' ? 201 : 200);
      expect((await get(`${root}/outcome-confirmed`).expect(200)).body.data).toEqual(formal);
    },
  );

  it('rolls back the supersede, children and receipt when confirmation audit fails', async () => {
    const { row, root, confirmation } = await ready();
    const before = await facts(row.id);
    const spy = jest
      .spyOn(app.get(ActivityOutcomeFinalizationAuditRecorder), 'log')
      .mockRejectedValueOnce(new BizException(BizCode.ACTIVITY_OUTCOME_INVALID));
    try {
      expectBizError(
        await post(`${root}/outcome-confirmations`, confirmation),
        BizCode.ACTIVITY_OUTCOME_INVALID,
      );
    } finally {
      spy.mockRestore();
    }
    expect(await facts(row.id)).toEqual(before);
    await peerPost(`${root}/outcome-confirmations`, confirmation).expect(201);
    expect((await facts(row.id)).receipts).toHaveLength(1);
  });
});
