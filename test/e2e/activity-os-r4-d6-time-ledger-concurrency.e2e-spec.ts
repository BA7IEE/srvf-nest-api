import { BindingScopeType, PrincipalType, Role, UserStatus, Prisma } from '@prisma/client';
import request from 'supertest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { EvidenceSealService } from '../../src/modules/activities/evidence-seal.service';
import {
  SettlementDraftService,
  type SettlementDraftResult,
} from '../../src/modules/activities/settlement-draft.service';
import { ActivityBatchWorker } from '../../src/modules/activities/activity-batch.worker';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { ActivityTimeSettlementService } from '../../src/modules/activities/activity-time-settlement.service';
import type { TimePolicyDefinition } from '../../src/modules/activities/activity-time-policy-definition';
import {
  D13_APP,
  createD13Fixture,
  closeD13Fixture,
  createD13Draft,
  createD13ActivePolicy,
  explicitTimePolicyChange,
  type D13Fixture,
} from '../helpers/activity-time-policy.fixture';
import { httpServer } from '../helpers/http-server';

const CHILD_SOURCE = String.raw`
require('reflect-metadata');
const { loadTestEnv } = require('./test/setup/load-env');
loadTestEnv();
const { assertConnectedTestDatabase } = require('./test/setup/test-db');
const { PrismaService } = require('./src/database/prisma.service');
const { ActivityWorkflowGate } = require('./src/common/activity-workflow/activity-workflow.gate');
const { ParticipationTimeLedgerService } = require('./src/modules/activities/participation-time-ledger.service');
const { LedgerPreparationService } = require('./src/modules/activities/ledger-preparation.service');
const { ActivityBatchWorker } = require('./src/modules/activities/activity-batch.worker');
const db = new PrismaService();
(async () => {
  try {
    if (process.env.JEST_WORKER_ID !== '98') throw new Error('isolated worker required');
    await assertConnectedTestDatabase(db);
    const start = new Promise(resolve => process.once('message', resolve));
    process.send({ kind: 'ready' });
    const command = await start;
    if (!command || command.kind !== 'start') throw new Error('invalid worker command');
    const gate = new ActivityWorkflowGate({ activityV11Workflow: { enabled: true, readonlyMaintenance: false } });
    const preparation = new LedgerPreparationService(db, gate, new ParticipationTimeLedgerService());
    const prepareChunk = preparation.prepareChunk.bind(preparation);
    preparation.prepareChunk = async (...args) => {
      if (command.pauseBeforeChunk) {
        const resumed = new Promise(resolve => process.once('message', resolve));
        process.send({ kind: 'claimed' });
        const next = await resumed;
        if (!next || next.kind !== 'continue') throw new Error('invalid resume command');
      }
      const result = await prepareChunk(...args);
      if (command.pauseAfterChunk) {
        // A pending Promise alone does not keep Node alive after idle DB handles close.
        // Hold the existing IPC channel until the parent performs the real SIGKILL.
        if (!process.channel) throw new Error('worker IPC is unavailable');
        process.channel.ref();
        process.send({ kind: 'chunk_committed' });
        await new Promise(() => {});
      }
      return result;
    };
    const committer = { commitReadyBatch: async () => { throw new Error('unexpected automatic commit'); } };
    const worker = new ActivityBatchWorker(db, preparation, committer, false);
    const result = await worker.drainOnce();
    await worker.onModuleDestroy();
    process.send({ kind: 'result', result });
  } catch (error) {
    process.send({ kind: 'failed', errorName: error instanceof Error ? error.name : 'unknown' });
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
    process.disconnect();
  }
})();
`;

interface WorkerMessage {
  kind: string;
  errorName?: string;
  result?: {
    jobClaimed: boolean;
    jobId: string | null;
    itemsProcessed: number;
    batchStatus: string | null;
    commitAttempted: boolean;
  };
}

function spawnProbe() {
  const child = spawn(
    process.execPath,
    [
      '-r',
      join(process.cwd(), 'node_modules/ts-node/register/transpile-only.js'),
      '-r',
      join(process.cwd(), 'node_modules/tsconfig-paths/register.js'),
      '-e',
      CHILD_SOURCE,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, TS_NODE_PROJECT: join(process.cwd(), 'test/tsconfig.test.json') },
      // Never relay a child's raw error/SQL/environment output.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  const messages: WorkerMessage[] = [];
  let failed: Error | undefined;
  let closed = false;
  child.on('message', (message: unknown) => {
    if (
      typeof message !== 'object' ||
      message === null ||
      !('kind' in message) ||
      typeof message.kind !== 'string'
    )
      return;
    const event = message as WorkerMessage;
    messages.push(event);
    if (event.kind === 'failed')
      failed = new Error('isolated ledger worker failed: ' + event.errorName);
  });
  child.on('error', () => {
    failed = new Error('isolated ledger worker could not start');
  });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => {
      closed = true;
      resolve({ code, signal });
    });
  });
  const waitFor = (kind: string): Promise<WorkerMessage> =>
    new Promise((resolve, reject) => {
      const existing = messages.find((message) => message.kind === kind);
      if (existing) {
        resolve(existing);
        return;
      }
      if (failed || closed) {
        reject(failed ?? new Error('worker closed before ' + kind));
        return;
      }
      const timeout = setTimeout(() => {
        clean();
        reject(new Error('worker event timeout: ' + kind));
      }, 30000);
      const clean = () => {
        clearTimeout(timeout);
        child.off('message', inspect);
        child.off('error', inspect);
        child.off('close', inspect);
      };
      const inspect = () => {
        const event = messages.find((message) => message.kind === kind);
        if (event) {
          clean();
          resolve(event);
        } else if (failed || closed) {
          clean();
          reject(failed ?? new Error('worker closed before ' + kind));
        }
      };
      child.on('message', inspect);
      child.on('error', inspect);
      child.on('close', inspect);
    });
  return {
    child,
    done,
    waitFor,
    start(options: { pauseAfterChunk?: boolean; pauseBeforeChunk?: boolean } = {}) {
      if (!child.connected || !child.send) throw new Error('worker IPC is unavailable');
      child.send({ kind: 'start', ...options });
    },
    resume() {
      if (!child.connected || !child.send) throw new Error('worker IPC is unavailable');
      child.send({ kind: 'continue' });
    },
    async stop() {
      if (!closed) child.kill('SIGTERM');
      await done;
    },
  };
}
type WorkerProbe = ReturnType<typeof spawnProbe>;
const START = new Date('2020-03-01T08:00:00.000Z');
const END = new Date('2020-03-01T09:00:00.000Z');
const DEFINITION: TimePolicyDefinition = {
  defaultCategory: 'volunteer_service',
  roleMappings: [],
  allowSplit: true,
  specialIntervals: {
    preparation: { mode: 'exclude' },
    duty: { mode: 'exclude' },
    travel: { mode: 'exclude' },
  },
  rounding: { mode: 'floor', quantumSeconds: 60 },
  evidence: { requiredSources: [], requireManualRecognition: false },
  manualAdjustment: { enabled: true, reasonRequired: true, evidenceRequired: false },
};

describe('D6 independent worker ownership and crash recovery', () => {
  let f: D13Fixture;
  let children: WorkerProbe[] = [];
  let actor: CurrentUserPayload;
  let prepareFailure = 'none';
  const meta = { requestId: 'd5-e2e', ip: null, ua: null };
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  beforeEach(async () => {
    // Test-process configuration only. Never changes an application instance or deployment Gate.
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    f = await createD13Fixture();
    prepareFailure = 'none';
    const timeSettlement = f.app.get(ActivityTimeSettlementService);
    const prepare = timeSettlement.prepare.bind(timeSettlement);
    jest.spyOn(timeSettlement, 'prepare').mockImplementation(async (...args) => {
      try {
        return await prepare(...args);
      } catch (error) {
        // Fixed diagnostic fields only; never expose SQL, IDs, URLs or raw error messages.
        prepareFailure = JSON.stringify({
          prismaCode: error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null,
          expiredTransaction:
            error instanceof Error &&
            /expired transaction|Transaction already closed/u.test(error.message),
          transactionTimeoutMs:
            error instanceof Error
              ? Number(error.message.match(/timeout for this transaction was (\d+) ms/u)?.[1]) ||
                null
              : null,
          transactionElapsedMs:
            error instanceof Error
              ? Number(error.message.match(/however (\d+) ms passed/u)?.[1]) || null
              : null,
          knownPrisma: error instanceof Prisma.PrismaClientKnownRequestError,
          unknownPrisma: error instanceof Prisma.PrismaClientUnknownRequestError,
        });
        throw error;
      }
    });
    actor = {
      id: f.creator.id,
      memberId: f.creator.memberId,
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      username: 'd4-fixture',
    };
    const codes = [
      'activity.time-settlement.read',
      'activity.time-settlement.prepare',
      'activity.time-allocation.recognize',
      'activity.settlement-submit.record',
    ];
    const role = await f.db.rbacRole.create({
      data: { code: f.key('d4_role'), displayName: 'D4 explicit fixture' },
    });
    for (const code of codes) {
      const permission = await f.db.permission.upsert({
        where: { code },
        update: {},
        create: {
          code,
          module: 'activity',
          action: code.split('.')[1],
          resourceType: code.split('.')[2],
        },
      });
      await f.db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    }
    await f.db.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: actor.id,
        roleId: role.id,
        scopeType: BindingScopeType.ORGANIZATION,
        scopeOrgId: f.organizationId,
      },
    });
    await f.db.contributionRule.create({
      data: {
        activityTypeCode: 'event_support',
        attendanceRoleCode: 'service',
        pointsBelow: 2,
        status: 'ACTIVE',
      },
    });
  }, 120000);
  afterEach(async () => {
    await Promise.all(children.map((child) => child.stop()));
    children = [];
    jest.restoreAllMocks();
    await closeD13Fixture(f);
    if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
  });

  async function prepareSource(
    options: {
      noEvents?: boolean;
      definition?: TimePolicyDefinition;
      batch?: boolean;
      beforeSeal?: (draft: {
        activityId: string;
        sessionId: string;
        positionId: string;
      }) => Promise<void>;
    } = {},
  ) {
    const draft = await createD13Draft(f, { withPosition: true });
    if (!draft.positionId) throw new Error('source position required');
    const pointer = await createD13ActivePolicy(f, options.definition ?? DEFINITION, {
      effectiveFrom: '1900-01-01T00:00:00.000Z',
      effectiveUntil: '2101-01-01T00:00:00.000Z',
    });
    const selectionResponse = await request(httpServer(f.app))
      .patch(`${D13_APP}/${draft.activityId}/time-policy-selection`)
      .set('Authorization', f.creator.auth)
      .send({
        operationKey: f.key('selection'),
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
    const selection = await f.db.activityTimePolicySelectionRevision.findUniqueOrThrow({
      where: { id: selectionResponse.body.data.selectionRevisionId as string },
    });
    // Keep creation HTTP's future-time checks; afterwards construct a fixed historical event fixture.
    await f.db.activity.update({
      where: { id: draft.activityId },
      data: { startAt: START, endAt: END, statusCode: 'published' },
    });
    await f.db.activitySession.update({
      where: { id: draft.sessionId },
      data: {
        startAt: START,
        endAt: END,
        checkInOpenAt: START,
        checkInCloseAt: END,
        checkOutOpenAt: START,
        checkOutCloseAt: END,
      },
    });
    await f.db.activitySessionPosition.update({
      where: { id: draft.positionId },
      data: { startAt: START, endAt: END },
    });
    await f.db.activityResponsibilityAssignment.create({
      data: {
        activityId: draft.activityId,
        memberId: f.creator.memberId,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: actor.id,
        source: 'publish',
      },
    });
    const review = await f.db.activityPublishReview.create({
      data: {
        activityId: draft.activityId,
        requestType: 'initial',
        requestVersion: 1,
        baseRevision: 0,
        status: 'approved',
        snapshot: {},
        directPublish: true,
        submittedByUserId: actor.id,
        submittedAt: START,
        reviewedByUserId: actor.id,
        reviewedAt: START,
      },
    });
    await f.db.activityRuleSnapshot.create({
      data: {
        activityId: draft.activityId,
        workflowRevision: 0,
        timePolicySelectionRevisionId: selection.id,
        resolvedConfig: {
          sessions: [
            {
              sessionId: draft.sessionId,
              positions: [{ positionId: draft.positionId, attendanceRoleCode: 'service' }],
            },
          ],
          timePolicyPointers: {
            selectionRevisionId: selection.id,
            selectionRevision: selection.revision,
            selectionHash: selection.selectionHash,
            selection: selection.selectionJson,
          },
        },
        snapshotHash: 'a'.repeat(64),
        createdByReviewId: review.id,
        createdAt: new Date('2019-12-01T00:00:00.000Z'),
      },
    });
    const registration = await f.db.activityRegistration.create({
      data: { activityId: draft.activityId, memberId: f.creator.memberId, statusCode: 'pass' },
    });
    const identity = await f.db.activityParticipationIdentity.create({
      data: {
        activityId: draft.activityId,
        sessionId: draft.sessionId,
        registrationId: registration.id,
        memberId: f.creator.memberId,
        currentStatusCode: 'pass',
        currentPositionId: draft.positionId,
        populationIncluded: true,
      },
    });
    if (!options.noEvents) {
      const eventIds: string[] = [];
      for (const [type, at] of [
        ['check_in', START],
        ['check_out', END],
      ] as const) {
        const event = await f.db.attendancePunchEvent.create({
          data: {
            activityId: draft.activityId,
            sessionId: draft.sessionId,
            positionId: draft.positionId,
            participationIdentityId: identity.id,
            memberId: f.creator.memberId,
            eventTypeCode: type,
            sourceCode: 'self_qr',
            occurredAt: at,
            receivedAt: at,
            operatorUserId: actor.id,
            eventKey: f.key(type),
            requestHash: 'b'.repeat(64),
            evidenceRevision: 0,
          },
        });
        eventIds.push(event.id);
      }
      await f.db.participantServiceSegmentRevision.create({
        data: {
          participationIdentityId: identity.id,
          segmentKey: '0001',
          revision: 1,
          sourceCheckInEventId: eventIds[0],
          sourceCloseEventId: eventIds[1],
          resultCode: 'valid',
          statusCode: 'draft',
          checkInAt: START,
          checkOutAt: END,
          serviceHours: 1,
          lateFlag: false,
          earlyLeaveFlag: false,
        },
      });
    }
    await options.beforeSeal?.({ ...draft, positionId: draft.positionId });
    await f.app.get(EvidenceSealService).seal(draft.activityId, actor, meta);
    let generated: Pick<
      SettlementDraftResult,
      | 'settlementRunId'
      | 'settlementVersionId'
      | 'settlementVersion'
      | 'evidenceSealId'
      | 'contentHash'
      | 'blockedItemCount'
    >;
    if (options.batch) {
      const response = await post(`${D13_APP}/${draft.activityId}/settlement/generate`, {
        operationKey: f.key('capacity_generate'),
      });
      expect(response.outcome).toBe('job');
      const processed = await f.app.get(ActivityBatchWorker).drainOnce();
      expect(processed).toMatchObject({ jobId: response.jobId, itemsProcessed: 1, itemsFailed: 0 });
      const job = await f.db.activityBatchJob.findUniqueOrThrow({
        where: { id: response.jobId as string },
      });
      expect({ status: job.statusCode, error: job.lastErrorCode }).toEqual({
        status: 'succeeded',
        error: null,
      });
      if (!job.settlementVersionId) throw new Error('batch draft result required');
      const version = await f.db.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: job.settlementVersionId },
      });
      const resolved = await f.db.participantSettlementResultRevision.count({
        where: { settlementVersionId: version.id, exceptionFlagsJson: { equals: Prisma.DbNull } },
      });
      generated = {
        settlementRunId: version.settlementRunId,
        settlementVersionId: version.id,
        settlementVersion: version.version,
        evidenceSealId: version.evidenceSealId,
        contentHash: version.contentHash,
        blockedItemCount: version.sessionParticipationCount - resolved,
      };
    } else
      generated = await f.app.get(SettlementDraftService).generate(draft.activityId, actor, meta);
    if (options.noEvents) {
      await f.app.get(SettlementDraftService).updateItem({
        activityId: draft.activityId,
        participationIdentityId: identity.id,
        expectedDraftVersion: generated.settlementVersion,
        resultCode: 'absent',
        recognizedServiceHours: 0,
        recognizedContributionPoints: 0,
        reason: '明确无参与证据',
      });
      const version = await f.db.attendanceSettlementVersion.findFirstOrThrow({
        where: { settlementRunId: generated.settlementRunId, statusCode: 'draft' },
        orderBy: { version: 'desc' },
      });
      generated = {
        ...generated,
        settlementVersion: version.version,
        settlementVersionId: version.id,
        contentHash: version.contentHash,
      };
    } else expect(generated.blockedItemCount).toBe(0);
    const seal = await f.db.evidenceSeal.findUniqueOrThrow({
      where: { id: generated.evidenceSealId },
    });
    const source = await f.db.participantServiceSegmentRevision.findFirst({
      where: { participationIdentityId: identity.id, statusCode: 'draft' },
    });
    const proof = {
      expectedDraftVersion: generated.settlementVersion,
      expectedEvidenceSealId: seal.id,
      expectedEvidenceRevision: seal.evidenceRevision,
      expectedPopulationRevision: seal.populationRevision,
      expectedWorkflowRevision: seal.workflowRevision,
    };
    return {
      ...draft,
      identityId: identity.id,
      source,
      generated,
      proof,
      url: `${D13_APP}/${draft.activityId}/time-settlement`,
    };
  }

  async function post(url: string, payload: object) {
    const response = await request(httpServer(f.app))
      .post(url)
      .set('Authorization', f.creator.auth)
      .send(payload);
    expect({
      status: response.status,
      code: response.body.code,
      message: response.body.message,
      prepareFailure,
    }).toEqual({ status: 200, code: 0, message: expect.any(String), prepareFailure: 'none' });
    return response.body.data;
  }
  function prepareCommand(p: Awaited<ReturnType<typeof prepareSource>>, expectedTimeRevision = 0) {
    return {
      operationKey: f.key('prepare'),
      expectedDraftVersion: p.proof.expectedDraftVersion,
      expectedEvidenceSealId: p.proof.expectedEvidenceSealId,
      expectedTimeRevision,
    };
  }
  async function recognize(p: Awaited<ReturnType<typeof prepareSource>>) {
    if (!p.source) throw new Error('expected source');
    return post(`${p.url}/allocations`, {
      ...p.proof,
      operationKey: f.key('recognize'),
      sourceSegmentId: p.source.id,
      expectedRevision: 0,
      recognitionModeCode: 'automatic',
      evidenceAttachmentIds: [],
    });
  }

  async function createClassifiedPostingFixture(timeRevisionId: string, totalCount: number) {
    const timeRevision = await f.db.activitySettlementTimeRevision.findUniqueOrThrow({
      where: { id: timeRevisionId },
    });
    const finalActor: CurrentUserPayload = {
      id: f.reviewer.id,
      memberId: f.reviewer.memberId,
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      username: 'd6-final-reviewer',
    };
    const permission = await f.db.permission.upsert({
      where: { code: 'activity.settlement-final-review.record' },
      update: {},
      create: {
        code: 'activity.settlement-final-review.record',
        module: 'activity',
        action: 'record',
        resourceType: 'settlement-final-review',
      },
    });
    const finalRole = await f.db.rbacRole.create({
      data: { code: f.key('final'), displayName: 'D6 final fixture' },
    });
    await f.db.rolePermission.create({
      data: { roleId: finalRole.id, permissionId: permission.id },
    });
    await f.db.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: finalActor.id,
        roleId: finalRole.id,
        scopeType: BindingScopeType.ORGANIZATION,
        scopeOrgId: f.organizationId,
      },
    });
    // Reviewed source fixture; review commands themselves remain covered by their unchanged suites.
    await f.db.settlementReviewAction.create({
      data: {
        settlementVersionId: timeRevision.settlementVersionId,
        stageCode: 'final',
        actionCode: 'approve',
        actorUserId: finalActor.id,
        actedAt: END,
        operationKey: f.key('final_review'),
      },
    });
    await f.db.attendanceSettlementVersion.update({
      where: { id: timeRevision.settlementVersionId },
      data: { statusCode: 'approved' },
    });
    await f.db.attendanceSettlementRun.update({
      where: { id: timeRevision.settlementRunId },
      data: { statusCode: 'posting' },
    });
    const batch = await f.db.ledgerPostingBatch.create({
      data: {
        settlementRunId: timeRevision.settlementRunId,
        settlementVersionId: timeRevision.settlementVersionId,
        batchRevision: 1,
        statusCode: 'preparing',
        requestKey: f.key('batch'),
        totalCount,
        preparedByUserId: finalActor.id,
      },
    });
    return { timeRevision, finalActor, finalRole, batch };
  }

  it.each(['competing-processes', 'crash-after-committed-chunk'] as const)(
    '%s preserves one classified effect',
    async (mode) => {
      const p = await prepareSource();
      await recognize(p);
      const prepared = await post(p.url + '/prepare', prepareCommand(p));
      const submitted = await post(p.url + '/submit', {
        operationKey: f.key('submit'),
        expectedDraftVersion: p.proof.expectedDraftVersion,
        expectedEvidenceSealId: p.proof.expectedEvidenceSealId,
        timeRevisionId: prepared.timeRevisionId,
        expectedBucketContentHash: prepared.bucketContentHash,
      });
      const { batch } = await createClassifiedPostingFixture(submitted.timeRevisionId as string, 1);
      const preparation = f.app.get(LedgerPreparationService);
      const job = await preparation.ensurePrepareJob(batch.id, {
        now: new Date(Date.now() - 2000),
      });
      const entries = () =>
        f.db.participationTimeLedgerEntry.findMany({
          where: { postingBatchId: batch.id },
          orderBy: { id: 'asc' },
        });
      expect(await entries()).toHaveLength(0);
      const first = spawnProbe();
      children.push(first);
      await first.waitFor('ready');
      if (mode === 'competing-processes') {
        const second = spawnProbe();
        children.push(second);
        await second.waitFor('ready');
        expect(first.child.pid).not.toBe(second.child.pid);
        first.start({ pauseBeforeChunk: true });
        await first.waitFor('claimed');
        expect(first.child.exitCode).toBeNull();
        expect(
          await f.db.activityBatchJob.findUniqueOrThrow({ where: { id: job.jobId } }),
        ).toMatchObject({ statusCode: 'processing' });
        expect(await entries()).toHaveLength(0);
        second.start();
        const competing = await second.waitFor('result');
        expect(competing.result?.jobClaimed).toBe(false);
        expect(first.child.exitCode).toBeNull();
        first.resume();
        const outcomes = [await first.waitFor('result'), competing];
        const winners = outcomes.filter((outcome) => outcome.result?.jobClaimed);
        expect(winners).toHaveLength(1);
        expect(winners[0].result).toMatchObject({
          jobId: job.jobId,
          itemsProcessed: 1,
          batchStatus: 'ready',
          commitAttempted: false,
        });
        expect(outcomes.filter((outcome) => !outcome.result?.jobClaimed)).toHaveLength(1);
        expect(await first.done).toEqual({ code: 0, signal: null });
        expect(await second.done).toEqual({ code: 0, signal: null });
      } else {
        first.start({ pauseAfterChunk: true });
        await first.waitFor('chunk_committed');
        const before = await entries();
        expect(before).toHaveLength(4);
        const held = await f.db.activityBatchJob.findUniqueOrThrow({ where: { id: job.jobId } });
        expect(held.statusCode).toBe('processing');
        expect(held.leaseOwner).not.toBeNull();
        expect(
          await f.db.ledgerPostingBatch.findUniqueOrThrow({ where: { id: batch.id } }),
        ).toMatchObject({ statusCode: 'preparing', preparedCount: 1 });
        expect(first.child.kill('SIGKILL')).toBe(true);
        expect(await first.done).toEqual({ code: null, signal: 'SIGKILL' });
        // Only this owned test job's lease is moved; no real business record is touched.
        await f.db.activityBatchJob.update({
          where: { id: job.jobId },
          data: { leaseExpiresAt: new Date(Date.now() - 1) },
        });
        const successor = spawnProbe();
        children.push(successor);
        await successor.waitFor('ready');
        successor.start();
        expect((await successor.waitFor('result')).result).toMatchObject({
          jobId: job.jobId,
          jobClaimed: true,
          itemsProcessed: 0,
          batchStatus: 'ready',
          commitAttempted: false,
        });
        expect(await successor.done).toEqual({ code: 0, signal: null });
        const recovered = await f.db.activityBatchJob.findUniqueOrThrow({
          where: { id: job.jobId },
        });
        expect(recovered.leaseGeneration).toBeGreaterThan(held.leaseGeneration);
        expect(recovered.statusCode).toBe('succeeded');
        expect(await entries()).toEqual(before);
      }
      expect(await entries()).toHaveLength(4);
      expect(
        await f.db.ledgerPostingBatch.findUniqueOrThrow({ where: { id: batch.id } }),
      ).toMatchObject({ statusCode: 'ready', preparedCount: 1, totalCount: 1 });
      expect(await f.db.memberContributionDayState.count()).toBe(0);
      await request(httpServer(f.app))
        .get(p.url + '/revisions/' + submitted.timeRevisionId + '/ledger')
        .set('Authorization', f.creator.auth)
        .expect(404);
    },
    120000,
  );
});
