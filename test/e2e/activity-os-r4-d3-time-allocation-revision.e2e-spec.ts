import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { ActivityTimeAllocationAuditRecorder } from '../../src/modules/activities/activity-time-allocation-audit-recorder';
import { ActivityTimeAllocationService } from '../../src/modules/activities/activity-time-allocation.service';
import { ActivityTimePolicySelectionAuditRecorder } from '../../src/modules/activities/activity-time-policy-selection-audit-recorder';
import { AttachmentStorageOrchestrator } from '../../src/modules/attachments/attachment-storage-orchestrator';
import type { TimePolicyDefinition } from '../../src/modules/activities/activity-time-policy-definition';
import {
  D13_APP,
  closeD13Fixture,
  createD13ActivePolicy,
  createD13Draft,
  createD13Fixture,
  explicitTimePolicyChange,
  type D13Fixture,
} from '../helpers/activity-time-policy.fixture';
import { httpServer } from '../helpers/http-server';
import { waitFor } from '../helpers/wait-for';
import { loadTestEnv } from '../setup/load-env';
import { assertTestDatabaseUrl, dropWorkerDatabase } from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';
import { BindingScopeType, PrincipalType, Prisma, Role, UserStatus } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import request from 'supertest';

const PERMISSION = 'activity.time-allocation.recognize';
const WORKER = 98;
const USE_DEDICATED_W98 = process.env.SRVF_D3_W98 === '1';
const CHECK_IN_AT = new Date('2099-09-01T08:45:00.000Z');
const CHECK_OUT_AT = new Date('2099-09-01T09:45:00.000Z');
const SNAPSHOT_AT = new Date('2099-08-01T00:00:00.000Z');

const automaticDefinition: TimePolicyDefinition = {
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
};

interface D3PreparedFixture {
  readonly activityId: string;
  readonly sourceSegmentId: string;
  readonly snapshotId: string | null;
  readonly selectionRevisionId: string;
  readonly policyId: string;
  readonly policyVersionId: string;
  readonly actor: CurrentUserPayload;
  readonly service: ActivityTimeAllocationService;
}

describe('D3 immutable participant time-allocation revision', () => {
  let fixture: D13Fixture;
  const recognizeBindingIds: string[] = [];
  const originalEnvironment = {
    worker: process.env.JEST_WORKER_ID,
    databaseUrl: process.env.DATABASE_URL,
    storageRoot: process.env.STORAGE_LOCAL_ROOT,
  };

  beforeAll(async () => {
    // Direct maintenance validation uses only the approved w98 clone. CI keeps
    // its assigned database because migration replays own that clone independently.
    if (USE_DEDICATED_W98) {
      process.env.JEST_WORKER_ID = String(WORKER);
      loadTestEnv();
      process.env.STORAGE_LOCAL_ROOT = `./tmp/storage-w${WORKER}`;
      assertTestDatabaseUrl(process.env.DATABASE_URL);
      // Build only w98 from the current migration files; a template clone can carry
      // an earlier, uncommitted version of this branch's new migration.
      dropWorkerDatabase(WORKER);
      execFileSync(
        'docker',
        ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', deriveTestDbName()],
        { stdio: 'pipe' },
      );
      execFileSync(
        'pnpm',
        [
          'exec',
          'prisma',
          'migrate',
          'deploy',
          '--schema',
          resolve(__dirname, '../../prisma/schema.prisma'),
        ],
        { env: process.env, stdio: 'pipe' },
      );
    }
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    fixture = await createD13Fixture();
  }, 120000);

  afterAll(async () => {
    try {
      await closeD13Fixture(fixture);
    } finally {
      if (USE_DEDICATED_W98) {
        try {
          dropWorkerDatabase(WORKER);
        } finally {
          restoreEnvironment('JEST_WORKER_ID', originalEnvironment.worker);
          restoreEnvironment('DATABASE_URL', originalEnvironment.databaseUrl);
          restoreEnvironment('STORAGE_LOCAL_ROOT', originalEnvironment.storageRoot);
        }
      }
    }
  });

  function restoreEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  function actor(): CurrentUserPayload {
    return {
      id: fixture.creator.id,
      username: 'd3-time-allocation-actor',
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: fixture.creator.memberId,
    };
  }

  async function grantRecognizePermission(): Promise<void> {
    const permission = await fixture.db.permission.upsert({
      where: { code: PERMISSION },
      create: {
        code: PERMISSION,
        module: 'activity',
        action: 'time-allocation',
        resourceType: 'recognize',
        description: 'D3 隔离测试显式授权',
      },
      update: {},
      select: { id: true },
    });
    const role = await fixture.db.rbacRole.create({
      data: {
        code: fixture.key('d3_time_allocation_role'),
        displayName: 'D3 时长认定隔离测试角色',
      },
      select: { id: true },
    });
    await fixture.db.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id },
    });
    const binding = await fixture.db.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: fixture.creator.id,
        roleId: role.id,
        scopeType: BindingScopeType.ORGANIZATION,
        scopeOrgId: fixture.organizationId,
      },
    });
    recognizeBindingIds.push(binding.id);
  }

  async function prepare(
    definition: TimePolicyDefinition = automaticDefinition,
    options: { withV8Snapshot?: boolean } = {},
  ): Promise<D3PreparedFixture> {
    const draft = await createD13Draft(fixture, { withPosition: true });
    if (!draft.positionId) throw new Error('D3 fixture requires a source position');
    await grantRecognizePermission();
    const pointer = await createD13ActivePolicy(fixture, definition);
    const selection = await request(httpServer(fixture.app))
      .patch(`${D13_APP}/${draft.activityId}/time-policy-selection`)
      .set('Authorization', fixture.creator.auth)
      .send({
        operationKey: fixture.key('d3_selection'),
        expectedRevision: 0,
        changes: [
          explicitTimePolicyChange(pointer, {
            layerCode: 'activity',
            sessionId: null,
            positionId: null,
          }),
        ],
      })
      .expect(200);
    const selectionRevisionId = selection.body.data.selectionRevisionId as string;
    const selectionRevision =
      await fixture.db.activityTimePolicySelectionRevision.findUniqueOrThrow({
        where: { id: selectionRevisionId },
        select: { id: true, revision: true, selectionHash: true, selectionJson: true },
      });

    let snapshotId: string | null = null;
    if (options.withV8Snapshot !== false) {
      const review = await fixture.db.activityPublishReview.create({
        data: {
          activityId: draft.activityId,
          requestType: 'initial',
          requestVersion: 1,
          baseRevision: 0,
          status: 'approved',
          snapshot: {},
          directPublish: true,
          submittedByUserId: fixture.creator.id,
          submittedAt: SNAPSHOT_AT,
          reviewedByUserId: fixture.creator.id,
          reviewedAt: SNAPSHOT_AT,
        },
        select: { id: true },
      });
      const snapshot = await fixture.db.activityRuleSnapshot.create({
        data: {
          activityId: draft.activityId,
          workflowRevision: 0,
          timePolicySelectionRevisionId: selectionRevisionId,
          resolvedConfig: {
            sessions: [
              {
                sessionId: draft.sessionId,
                positions: [{ positionId: draft.positionId, attendanceRoleCode: 'service' }],
              },
            ],
            timePolicyPointers: {
              selectionRevisionId: selectionRevision.id,
              selectionRevision: selectionRevision.revision,
              selectionHash: selectionRevision.selectionHash,
              selection: selectionRevision.selectionJson,
            },
          },
          snapshotHash: 'a'.repeat(64),
          createdByReviewId: review.id,
          createdAt: SNAPSHOT_AT,
        },
      });
      snapshotId = snapshot.id;
    }

    const registration = await fixture.db.activityRegistration.create({
      data: {
        activityId: draft.activityId,
        memberId: fixture.creator.memberId,
        statusCode: 'pass',
      },
      select: { id: true },
    });
    const participation = await fixture.db.activityParticipationIdentity.create({
      data: {
        activityId: draft.activityId,
        sessionId: draft.sessionId,
        registrationId: registration.id,
        memberId: fixture.creator.memberId,
        currentStatusCode: 'pass',
        currentPositionId: draft.positionId,
      },
      select: { id: true },
    });
    const checkIn = await fixture.db.attendancePunchEvent.create({
      data: {
        activityId: draft.activityId,
        sessionId: draft.sessionId,
        positionId: draft.positionId,
        participationIdentityId: participation.id,
        memberId: fixture.creator.memberId,
        eventTypeCode: 'check_in',
        sourceCode: 'self_qr',
        occurredAt: CHECK_IN_AT,
        receivedAt: CHECK_IN_AT,
        operatorUserId: fixture.creator.id,
        eventKey: fixture.key('d3_check_in'),
        requestHash: 'b'.repeat(64),
        evidenceRevision: 0,
      },
      select: { id: true },
    });
    const checkOut = await fixture.db.attendancePunchEvent.create({
      data: {
        activityId: draft.activityId,
        sessionId: draft.sessionId,
        positionId: null,
        participationIdentityId: participation.id,
        memberId: fixture.creator.memberId,
        eventTypeCode: 'check_out',
        sourceCode: 'self_qr',
        occurredAt: CHECK_OUT_AT,
        receivedAt: CHECK_OUT_AT,
        operatorUserId: fixture.creator.id,
        eventKey: fixture.key('d3_check_out'),
        requestHash: 'c'.repeat(64),
        evidenceRevision: 0,
      },
      select: { id: true },
    });
    const segment = await fixture.db.participantServiceSegmentRevision.create({
      data: {
        participationIdentityId: participation.id,
        segmentKey: fixture.key('d3_segment'),
        revision: 1,
        sourceCheckInEventId: checkIn.id,
        sourceCloseEventId: checkOut.id,
        resultCode: 'valid',
        statusCode: 'committed',
        checkInAt: CHECK_IN_AT,
        checkOutAt: CHECK_OUT_AT,
        serviceHours: 1,
        lateFlag: false,
        earlyLeaveFlag: false,
      },
      select: { id: true },
    });
    expect(selectionRevision.selectionHash).toHaveLength(64);
    return {
      activityId: draft.activityId,
      sourceSegmentId: segment.id,
      snapshotId,
      selectionRevisionId,
      policyId: pointer.policyId,
      policyVersionId: pointer.versionId,
      actor: actor(),
      service: fixture.app.get(ActivityTimeAllocationService),
    };
  }

  function automaticCommand(prepared: D3PreparedFixture) {
    return {
      operationKey: fixture.key('d3_concurrent'),
      sourceSegmentId: prepared.sourceSegmentId,
      expectedRevision: 0,
      recognitionModeCode: 'automatic',
      evidenceAttachmentIds: [] as string[],
    };
  }

  function recognize(prepared: D3PreparedFixture, command = automaticCommand(prepared)) {
    return prepared.service.recognize(prepared.activityId, command, prepared.actor, {
      requestId: fixture.key('d3_probe'),
      ip: null,
      ua: null,
    });
  }

  async function expectAllocationCounts(activityId: string, expected: number, evidence = 0) {
    const where = { activityId };
    expect(await fixture.db.participantTimeAllocationRevision.count({ where })).toBe(expected);
    expect(await fixture.db.participantTimeAllocationSlice.count({ where })).toBe(expected);
    expect(await fixture.db.participantTimeAllocationEvidence.count({ where })).toBe(evidence);
    expect(await fixture.db.participantTimeAllocationCommandReceipt.count({ where })).toBe(
      expected,
    );
    expect(
      await fixture.db.auditLog.count({
        where: { resourceId: activityId, event: 'activity.time-allocation.command' },
      }),
    ).toBe(expected);
  }

  async function waitForHolder(holderPid: number) {
    await waitFor(
      async () => {
        const [row] = await fixture.db.$queryRaw<{ blocked: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database()
            AND ${holderPid} = ANY(pg_blocking_pids(pid))
        ) AS blocked
      `;
        return row.blocked;
      },
      { timeoutMs: 3500, message: 'D3 command did not wait on the expected lock holder' },
    );
  }

  async function attachmentFixture(prepared: D3PreparedFixture) {
    const attachment = await fixture.db.attachment.create({
      data: {
        key: `attachments/d3-race/${fixture.key('evidence')}.txt`,
        originalName: 'evidence.txt',
        mime: 'text/plain',
        size: 7,
        uploadedBy: prepared.actor.id,
        ownerType: 'activity',
        ownerId: prepared.activityId,
      },
    });
    const object = await fixture.db.storageObject.create({
      data: {
        key: attachment.key,
        state: 'available',
        source: 'attachment_signed_upload',
        providerType: 'LOCAL',
        localNamespace: 'd3-allocation-race-test',
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
    return {
      attachment,
      object,
      deletion: {
        attachmentId: attachment.id,
        actorUserId: prepared.actor.id,
        actorRoleSnap: prepared.actor.role,
        allowAuthorizedJoin: false,
        scope: 'self' as const,
        deletedByPath: 'owner' as const,
        auditMeta: { requestId: fixture.key('d3_delete_fixture'), ip: null, ua: null },
      },
    };
  }

  /** Prove a real PostgreSQL wait on this exact holder before changing a fixture. */
  async function duringLockWait(
    lock: (tx: Prisma.TransactionClient) => Promise<unknown>,
    run: () => ReturnType<typeof recognize>,
    change: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) {
    let locked!: () => void;
    let failed!: (error: unknown) => void;
    let unlock!: () => void;
    let holderPid = 0;
    let holderTx!: Prisma.TransactionClient;
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      locked = resolveReady;
      failed = rejectReady;
    });
    const release = new Promise<void>((resolveRelease) => {
      unlock = resolveRelease;
    });
    const holder = fixture.db.$transaction(
      async (tx) => {
        await lock(tx);
        const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        holderPid = row.pid;
        holderTx = tx;
        locked();
        await release;
      },
      { timeout: 15000 },
    );
    void holder.catch(failed);
    await ready;
    const pending = Promise.allSettled([run()]);
    try {
      await waitFor(
        async () => {
          const [row] = await fixture.db.$queryRaw<{ blocked: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND ${holderPid} = ANY(pg_blocking_pids(pid))
          ) AS blocked
        `;
          return row.blocked;
        },
        { timeoutMs: 3500, message: 'D3 command did not wait on the expected lock holder' },
      );
      await change(holderTx);
    } finally {
      unlock();
      await holder;
    }
    return (await pending)[0];
  }

  it('serializes simultaneous identical commands into one receipt and audit', async () => {
    const prepared = await prepare();
    const command = automaticCommand(prepared);
    const results = await Promise.all([recognize(prepared, command), recognize(prepared, command)]);
    expect(results[1]).toEqual(results[0]);
    await expectAllocationCounts(prepared.activityId, 1);
  });

  it('rejects the losing distinct command at the same expected revision without half writes', async () => {
    const prepared = await prepare();
    const results = await Promise.allSettled([recognize(prepared), recognize(prepared)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { biz: BizCode.ACTIVITY_TIME_ALLOCATION_STALE },
    });
    await expectAllocationCounts(prepared.activityId, 1);
  });

  it.each(['command', 'activity', 'snapshot', 'selection', 'policy', 'version'] as const)(
    'rejects a disabled actor after a real %s lock wait with no partial state',
    async (point) => {
      const prepared = await prepare();
      const command = automaticCommand(prepared);
      const key = JSON.stringify([
        'activity-time-allocation',
        prepared.actor.id,
        'recognize_time_allocation',
        command.operationKey,
      ]);
      try {
        const result = await duringLockWait(
          async (tx) => {
            switch (point) {
              case 'command':
                return tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
              case 'activity':
                return tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${prepared.activityId} FOR UPDATE`;
              case 'snapshot':
                return tx.$queryRaw`SELECT id FROM "ActivityRuleSnapshot" WHERE id = ${prepared.snapshotId} FOR UPDATE`;
              case 'selection':
                return tx.$queryRaw`SELECT id FROM "ActivityTimePolicySelectionRevision" WHERE id = ${prepared.selectionRevisionId} FOR UPDATE`;
              case 'policy':
                return tx.$queryRaw`SELECT id FROM "TimePolicy" WHERE id = ${prepared.policyId} FOR UPDATE`;
              case 'version':
                return tx.$queryRaw`SELECT id FROM "TimePolicyVersion" WHERE id = ${prepared.policyVersionId} FOR UPDATE`;
            }
          },
          () => recognize(prepared, command),
          (tx) =>
            tx.user.update({
              where: { id: prepared.actor.id },
              data: { status: UserStatus.DISABLED },
            }),
        );
        expect(result).toMatchObject({ status: 'rejected', reason: { biz: BizCode.UNAUTHORIZED } });
        await expectAllocationCounts(prepared.activityId, 0);
      } finally {
        await fixture.db.user.update({
          where: { id: prepared.actor.id },
          data: { status: UserStatus.ACTIVE },
        });
      }
    },
  );

  it('rechecks explicit organization permission after the activity lock wait', async () => {
    const prepared = await prepare();
    const result = await duringLockWait(
      (tx) => tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${prepared.activityId} FOR UPDATE`,
      () => recognize(prepared),
      (tx) =>
        tx.roleBinding.updateMany({
          where: { id: { in: recognizeBindingIds } },
          data: { endedAt: new Date(0) },
        }),
    );
    expect(result).toMatchObject({
      status: 'rejected',
      reason: {
        biz: BizCode.ACTIVITY_TIME_ALLOCATION_REFERENCE_UNAVAILABLE,
      },
    });
    await expectAllocationCounts(prepared.activityId, 0);
  });

  it('rechecks a replaced D2 source after the activity lock and leaves its historical facts intact', async () => {
    const prepared = await prepare();
    const original = await fixture.db.participantServiceSegmentRevision.findUniqueOrThrow({
      where: { id: prepared.sourceSegmentId },
    });
    const result = await duringLockWait(
      (tx) => tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${prepared.activityId} FOR UPDATE`,
      () => recognize(prepared),
      async (tx) => {
        await tx.participantServiceSegmentRevision.update({
          where: { id: original.id },
          data: { statusCode: 'superseded' },
        });
        await tx.participantServiceSegmentRevision.create({
          data: {
            participationIdentityId: original.participationIdentityId,
            segmentKey: original.segmentKey,
            revision: 2,
            sourceCheckInEventId: original.sourceCheckInEventId,
            sourceCloseEventId: original.sourceCloseEventId,
            resultCode: original.resultCode,
            statusCode: 'committed',
            checkInAt: original.checkInAt,
            checkOutAt: original.checkOutAt,
            serviceHours: original.serviceHours,
            lateFlag: original.lateFlag,
            earlyLeaveFlag: original.earlyLeaveFlag,
            baseRevisionId: original.id,
          },
        });
      },
    );
    expect(result).toMatchObject({
      status: 'rejected',
      reason: {
        biz: BizCode.ACTIVITY_TIME_ALLOCATION_REFERENCE_UNAVAILABLE,
      },
    });
    await expectAllocationCounts(prepared.activityId, 0);
    expect(
      await fixture.db.participantServiceSegmentRevision.findUniqueOrThrow({
        where: { id: original.id },
        select: { serviceHours: true, checkInAt: true, checkOutAt: true },
      }),
    ).toEqual({
      serviceHours: original.serviceHours,
      checkInAt: original.checkInAt,
      checkOutAt: original.checkOutAt,
    });
  });

  it('rolls back all allocation writes when the final audit fails and allows a clean retry', async () => {
    const prepared = await prepare();
    const command = automaticCommand(prepared);
    const recorder = fixture.app.get(ActivityTimeAllocationAuditRecorder);
    const failure = new Error('D3 isolated audit rollback probe');
    const audit = jest.spyOn(recorder, 'log').mockRejectedValueOnce(failure);
    try {
      await expect(recognize(prepared, command)).rejects.toBe(failure);
      expect(audit).toHaveBeenCalledTimes(1);
      await expectAllocationCounts(prepared.activityId, 0);
    } finally {
      audit.mockRestore();
    }
    await recognize(prepared, command);
    await expectAllocationCounts(prepared.activityId, 1);
  });

  it('keeps the frozen policy when its version retires during a real lock wait', async () => {
    const prepared = await prepare();
    const result = await duringLockWait(
      (tx) =>
        tx.$queryRaw`SELECT id FROM "TimePolicyVersion" WHERE id = ${prepared.policyVersionId} FOR UPDATE`,
      () => recognize(prepared),
      (tx) =>
        tx.timePolicyVersion.update({
          where: { id: prepared.policyVersionId },
          data: { statusCode: 'retired', retiredAt: new Date() },
        }),
    );
    expect(result.status).toBe('fulfilled');
    await expectAllocationCounts(prepared.activityId, 1);
    expect(
      await fixture.db.participantTimeAllocationRevision.findFirstOrThrow({
        where: { activityId: prepared.activityId },
        select: { policyVersionId: true },
      }),
    ).toEqual({ policyVersionId: prepared.policyVersionId });
  });

  it('uses the historical snapshot after a concurrent live selection change commits', async () => {
    const prepared = await prepare();
    const nextPolicy = await createD13ActivePolicy(fixture, {
      ...automaticDefinition,
      defaultCategory: 'training',
    });
    const audit = fixture.app.get(ActivityTimePolicySelectionAuditRecorder);
    const original = audit.log.bind(audit);
    let notify!: (pid: number) => void;
    let release!: () => void;
    const ready = new Promise<number>((resolveReady) => {
      notify = resolveReady;
    });
    const released = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    const spy = jest.spyOn(audit, 'log').mockImplementationOnce(async (...args) => {
      const [row] = await args[0].$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      notify(row.pid);
      await released;
      await original(...args);
    });
    const changing = request(httpServer(fixture.app))
      .patch(`${D13_APP}/${prepared.activityId}/time-policy-selection`)
      .set('Authorization', fixture.creator.auth)
      .send({
        operationKey: fixture.key('d3_replace_selection'),
        expectedRevision: 1,
        changes: [
          explicitTimePolicyChange(nextPolicy, {
            layerCode: 'activity',
            sessionId: null,
            positionId: null,
          }),
        ],
      })
      .then((response) => response);
    let pending: Promise<PromiseSettledResult<Awaited<ReturnType<typeof recognize>>>[]> | undefined;
    try {
      const pid = await Promise.race([
        ready,
        changing.then(() => {
          throw new Error('Selection command ended before its audit barrier');
        }),
      ]);
      pending = Promise.allSettled([recognize(prepared)]);
      await waitForHolder(pid);
    } finally {
      release();
      spy.mockRestore();
    }
    expect((await changing).status).toBe(200);
    expect(await pending).toMatchObject([{ status: 'fulfilled' }]);
    const stored = await fixture.db.participantTimeAllocationRevision.findFirstOrThrow({
      where: { activityId: prepared.activityId },
      select: {
        timePolicySelectionRevisionId: true,
        policyVersionId: true,
        slices: { select: { categoryCode: true } },
      },
    });
    expect(stored).toEqual({
      timePolicySelectionRevisionId: prepared.selectionRevisionId,
      policyVersionId: prepared.policyVersionId,
      slices: [{ categoryCode: 'volunteer_service' }],
    });
    await expectAllocationCounts(prepared.activityId, 1);
  });

  it('rejects recognition if attachment delete intent wins its lock, without half writes', async () => {
    const prepared = await prepare();
    const { attachment, object, deletion } = await attachmentFixture(prepared);
    const storage = fixture.app.get(AttachmentStorageOrchestrator);
    const command = automaticCommand(prepared);
    command.evidenceAttachmentIds.push(attachment.id);
    const result = await duringLockWait(
      (tx) => tx.$queryRaw`SELECT id FROM "attachments" WHERE id = ${attachment.id} FOR UPDATE`,
      () => recognize(prepared, command),
      (tx) => storage.prepareDeleteInTransaction(tx, deletion),
    );
    expect(result).toMatchObject({
      status: 'rejected',
      reason: {
        biz: BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING,
      },
    });
    await expectAllocationCounts(prepared.activityId, 0);
    expect(
      await fixture.db.storageObjectOperation.count({
        where: { storageObjectId: object.id, kind: 'attachment_delete' },
      }),
    ).toBe(1);
    expect(await fixture.db.attachment.findUnique({ where: { id: attachment.id } })).not.toBeNull();
  });

  it('blocks delete intent until recognition commits and then protects its evidence', async () => {
    const prepared = await prepare();
    const { attachment, object, deletion } = await attachmentFixture(prepared);
    const command = automaticCommand(prepared);
    command.evidenceAttachmentIds.push(attachment.id);
    const audit = fixture.app.get(ActivityTimeAllocationAuditRecorder);
    const original = audit.log.bind(audit);
    let notify!: (pid: number) => void;
    let release!: () => void;
    const ready = new Promise<number>((resolveReady) => {
      notify = resolveReady;
    });
    const released = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    const spy = jest.spyOn(audit, 'log').mockImplementationOnce(async (...args) => {
      const [row] = await args[0].$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      notify(row.pid);
      await released;
      await original(...args);
    });
    const written = recognize(prepared, command);
    let pending: Promise<PromiseSettledResult<string>[]> | undefined;
    try {
      const pid = await Promise.race([
        ready,
        written.then(() => {
          throw new Error('Allocation command ended before its audit barrier');
        }),
      ]);
      pending = Promise.allSettled([
        fixture.app.get(AttachmentStorageOrchestrator).prepareDelete(deletion),
      ]);
      await waitForHolder(pid);
    } finally {
      release();
      spy.mockRestore();
    }
    await written;
    expect(await pending).toMatchObject([
      {
        status: 'rejected',
        reason: {
          biz: BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING,
        },
      },
    ]);
    await expectAllocationCounts(prepared.activityId, 1, 1);
    expect(
      await fixture.db.storageObjectOperation.count({
        where: { storageObjectId: object.id },
      }),
    ).toBe(0);
    expect(
      await fixture.db.storageObject.findUniqueOrThrow({
        where: { id: object.id },
        select: { state: true, deleteRequestedAt: true },
      }),
    ).toEqual({ state: 'available', deleteRequestedAt: null });
  });

  it('writes one complete automatic revision, exactly replays its receipt, and rejects changed reuse', async () => {
    const prepared = await prepare();
    const command = {
      operationKey: fixture.key('d3_automatic'),
      sourceSegmentId: prepared.sourceSegmentId,
      expectedRevision: 0,
      recognitionModeCode: 'automatic',
      evidenceAttachmentIds: [],
    };
    const meta = { requestId: fixture.key('d3_request'), ip: null, ua: null };

    const written = await prepared.service.recognize(
      prepared.activityId,
      command,
      prepared.actor,
      meta,
    );
    expect(written).toMatchObject({
      activityId: prepared.activityId,
      sourceSegmentId: prepared.sourceSegmentId,
      sourceSegmentRevision: 1,
      recognitionModeCode: 'automatic',
      revision: 1,
      sliceCount: 1,
      evidenceCount: 0,
    });
    expect(written).not.toHaveProperty('operationKey');
    expect(written).not.toHaveProperty('requestHash');

    const stored = await fixture.db.participantTimeAllocationRevision.findUniqueOrThrow({
      where: { id: written.allocationRevisionId },
      include: { slices: { orderBy: { ordinal: 'asc' } }, evidence: true, commandReceipt: true },
    });
    expect(stored).toMatchObject({
      activityId: prepared.activityId,
      sourceSegmentId: prepared.sourceSegmentId,
      revision: 1,
      recognitionModeCode: 'automatic',
      manualReason: null,
      sliceCount: 1,
    });
    expect(stored.slices).toEqual([
      expect.objectContaining({
        ordinal: 0,
        categoryCode: 'volunteer_service',
        intervalKindCode: 'service_segment',
        startAt: CHECK_IN_AT,
        endAt: CHECK_OUT_AT,
      }),
    ]);
    expect(stored.evidence).toEqual([]);
    expect(stored.commandReceipt?.resultJson).toEqual(written);
    await expect(
      fixture.db.auditLog.count({
        where: { resourceId: prepared.activityId, event: 'activity.time-allocation.command' },
      }),
    ).resolves.toBe(1);

    await expect(
      prepared.service.recognize(prepared.activityId, command, prepared.actor, meta),
    ).resolves.toEqual(written);
    await expect(
      prepared.service.recognize(
        prepared.activityId,
        { ...command, expectedRevision: 1 },
        prepared.actor,
        meta,
      ),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_ALLOCATION_COMMAND_CONFLICT });
    await expect(
      fixture.db.participantTimeAllocationRevision.count({
        where: { activityId: prepared.activityId },
      }),
    ).resolves.toBe(1);
    await expect(
      fixture.db.auditLog.count({
        where: { resourceId: prepared.activityId, event: 'activity.time-allocation.command' },
      }),
    ).resolves.toBe(1);
  });

  it('permits a manually justified full interval only when the frozen policy permits manual recognition', async () => {
    const prepared = await prepare({
      ...automaticDefinition,
      manualAdjustment: { enabled: true, reasonRequired: true, evidenceRequired: false },
    });
    const command = {
      operationKey: fixture.key('d3_manual'),
      sourceSegmentId: prepared.sourceSegmentId,
      expectedRevision: 0,
      recognitionModeCode: 'manual',
      manualReason: '现场确认实际服务时段',
      slices: [
        {
          categoryCode: 'training',
          startAt: CHECK_IN_AT.toISOString(),
          endAt: CHECK_OUT_AT.toISOString(),
        },
      ],
      evidenceAttachmentIds: [],
    };

    const written = await prepared.service.recognize(prepared.activityId, command, prepared.actor, {
      requestId: fixture.key('d3_manual_request'),
      ip: null,
      ua: null,
    });
    expect(written).toMatchObject({ recognitionModeCode: 'manual', sliceCount: 1 });
    await expect(
      fixture.db.participantTimeAllocationRevision.findUniqueOrThrow({
        where: { id: written.allocationRevisionId },
        select: { manualReason: true, slices: { select: { categoryCode: true } } },
      }),
    ).resolves.toEqual({
      manualReason: command.manualReason,
      slices: [{ categoryCode: 'training' }],
    });
  });

  it('fails closed for a legacy snapshot with no frozen selection and leaves no allocation state', async () => {
    const prepared = await prepare(automaticDefinition, { withV8Snapshot: false });

    await expect(
      prepared.service.recognize(
        prepared.activityId,
        {
          operationKey: fixture.key('d3_legacy'),
          sourceSegmentId: prepared.sourceSegmentId,
          expectedRevision: 0,
          recognitionModeCode: 'automatic',
          evidenceAttachmentIds: [],
        },
        prepared.actor,
        { requestId: fixture.key('d3_legacy_request'), ip: null, ua: null },
      ),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_ALLOCATION_POLICY_UNAVAILABLE });
    await expect(
      fixture.db.participantTimeAllocationRevision.count({
        where: { activityId: prepared.activityId },
      }),
    ).resolves.toBe(0);
    await expect(
      fixture.db.participantTimeAllocationCommandReceipt.count({
        where: { activityId: prepared.activityId },
      }),
    ).resolves.toBe(0);
  });
});
