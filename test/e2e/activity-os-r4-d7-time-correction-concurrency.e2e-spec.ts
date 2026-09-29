import { BindingScopeType, PrincipalType, Role, UserStatus, Prisma } from '@prisma/client';
import request from 'supertest';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { ActivityTimeSettlementService } from '../../src/modules/activities/activity-time-settlement.service';
import { CorrectionApplicationService } from '../../src/modules/activities/correction-application.service';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { EvidenceSealService } from '../../src/modules/activities/evidence-seal.service';
import {
  SettlementDraftService,
  type SettlementDraftResult,
} from '../../src/modules/activities/settlement-draft.service';
import { ActivityBatchWorker } from '../../src/modules/activities/activity-batch.worker';
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

describe('D7-1 real PostgreSQL lock contention', () => {
  let f: D13Fixture;
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

  it.each(['replay', 'member-revoked'] as const)(
    'two connections recheck the actual activity lock: %s',
    async (mode) => {
      const p = await prepareSource();
      await recognize(p);
      const preparedTime = await post(p.url + '/prepare', prepareCommand(p));
      const submittedTime = await post(p.url + '/submit', {
        operationKey: f.key('submit_time'),
        expectedDraftVersion: p.proof.expectedDraftVersion,
        expectedEvidenceSealId: p.proof.expectedEvidenceSealId,
        timeRevisionId: preparedTime.timeRevisionId,
        expectedBucketContentHash: preparedTime.bucketContentHash,
      });
      const { timeRevision, finalActor, finalRole, batch } = await createClassifiedPostingFixture(
        submittedTime.timeRevisionId as string,
        1,
      );
      const preparation = f.app.get(LedgerPreparationService);
      const job = await preparation.ensurePrepareJob(batch.id);
      const items = await f.db.activityBatchJobItem.findMany({ where: { jobId: job.jobId } });
      for (const item of items) await preparation.prepareChunk(job.jobId, item.id);
      await preparation.finalize(job.jobId);
      await f.app
        .get(LedgerPostingService)
        .commitBatch(
          { postingBatchId: batch.id, operationKey: f.key('initial_commit') },
          finalActor,
          meta,
        );
      await f.db.roleBinding.create({
        data: {
          principalType: PrincipalType.USER,
          principalId: finalActor.id,
          roleId: finalRole.id,
          scopeType: BindingScopeType.GLOBAL,
        },
      });
      const root = await f.db.participationTimeLedgerManifest.findUniqueOrThrow({
        where: { postingBatchId: batch.id },
      });
      const roots = await f.db.participationTimeLedgerEntry.findMany({
        where: { manifestId: root.id },
        orderBy: { id: 'asc' },
      });
      const buckets = await f.db.participantSettlementTimeBucket.findMany({
        where: { timeRevisionId: timeRevision.id },
        orderBy: { id: 'asc' },
      });
      const correction = f.app.get(CorrectionApplicationService);

      const submitted = await correction.submit(
        {
          activityId: p.activityId,
          participationIdentityId: null,
          requestTypeCode: 'time',
          requestedChangeJson: {
            schemaVersion: 2,
            results: [],
            segments: [],
            timeCorrection: {
              baseSettlementVersionId: timeRevision.settlementVersionId,
              baseTimeLedgerHash: root.contentHash,
              reason: 'concurrency fixture',
              items: roots.map((entry) => ({ rootEntryId: entry.id, recognizedSeconds: 0 })),
            },
          },
          reason: 'concurrency fixture',
          operationKey: f.key('submit'),
          requestHash: 'caller',
        },
        actor,
        meta,
      );
      await correction.review(
        { correctionRequestId: submitted.correctionRequestId, actionCode: 'approve' },
        finalActor,
        meta,
      );
      const input = {
        correctionRequestId: submitted.correctionRequestId,
        operationKey: f.key('apply'),
        requestHash: 'apply',
      };
      const prepared = await correction.prepare(input, finalActor, meta);
      let unlock!: () => void;
      let signal!: (pid: number) => void;
      const release = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const ready = new Promise<number>((resolve) => {
        signal = resolve;
      });
      const holder = f.db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${p.activityId} FOR UPDATE`;
          const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          signal(row.pid);
          await release;
          if (mode === 'member-revoked') {
            await tx.member.update({
              where: { id: f.reviewer.memberId },
              data: { status: 'INACTIVE' },
            });
          }
        },
        { timeout: 10000 },
      );
      const pid = await Promise.race([
        ready,
        holder.then(() => {
          throw new Error('holder exited');
        }),
      ]);
      const attempts = [
        correction.commit(input, finalActor, meta),
        correction.commit(input, finalActor, meta),
      ];
      const racing = Promise.all(attempts);
      void racing.catch(() => undefined);
      try {
        let waiters = 0;
        for (let attempt = 0; attempt < 100; attempt++) {
          const [row] = await f.db.$queryRaw<{ count: number }[]>`
          SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
            AND pid <> ${pid} AND query LIKE '%Activity%'
        `;
          waiters = row.count;
          if (waiters >= 2) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiters).toBeGreaterThanOrEqual(2);
      } finally {
        unlock();
        await holder;
      }
      if (mode === 'member-revoked') {
        await expect(racing).rejects.toMatchObject({ biz: { code: 40300 } });
        const settled = await Promise.allSettled(attempts);
        expect(settled).toEqual([
          expect.objectContaining({
            status: 'rejected',
            reason: expect.objectContaining({ biz: expect.objectContaining({ code: 40300 }) }),
          }),
          expect.objectContaining({
            status: 'rejected',
            reason: expect.objectContaining({ biz: expect.objectContaining({ code: 40300 }) }),
          }),
        ]);
        expect(await f.db.participationTimeCorrectionCommitReceipt.count()).toBe(0);
        expect(
          await f.db.ledgerPostingBatch.findUniqueOrThrow({
            where: { id: prepared.newPostingBatchId },
          }),
        ).toMatchObject({ statusCode: 'ready' });
      } else {
        const results = await racing;
        expect(results.map((row) => row.replayed).sort()).toEqual([false, true]);
      }
      expect(await f.db.participationTimeCorrectionCommitReceipt.count()).toBe(
        mode === 'replay' ? 1 : 0,
      );
      expect(
        await f.db.participationTimeCorrectionEntry.count({
          where: { postingBatchId: prepared.newPostingBatchId },
        }),
      ).toBe(roots.length * 2);
      expect(
        await f.db.participationTimeLedgerEntry.findMany({
          where: { manifestId: root.id },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(roots);
      expect(
        await f.db.participantSettlementTimeBucket.findMany({
          where: { timeRevisionId: timeRevision.id },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(buckets);
    },
    120000,
  );
});
