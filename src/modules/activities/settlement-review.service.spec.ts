import { Prisma, Role, UserStatus } from '@prisma/client';
import type { AppConfig } from '../../config/app.config';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { PrismaService } from '../../database/prisma.service';
import { ActivityContributionSettlementService } from './activity-contribution-settlement.service';
import { ActivityContributionSettlementQueryService } from './activity-contribution-settlement-query.service';
import type { SettlementNotificationProducer } from './settlement-notification-producer';
import type { SettlementReviewAuditRecorder } from './settlement-review-audit-recorder';
import {
  SettlementReviewService,
  SETTLEMENT_REVIEW_TX_TIMEOUT_MS,
  type SettlementReviewInput,
} from './settlement-review.service';
import type { SettlementReviewStage } from './settlement-review-separation';

const REVIEW_META = { requestId: 'review-characterization', ip: null, ua: null };

// Characterizes the original owner and fallbacks before §12.26 changes orchestration.
// These mocks prove calls and ordering, not database integrity or actual rollback.
function reviewFixture(stage: SettlementReviewStage = 'first', regime = 'legacy') {
  const events: string[] = [];
  const version = {
    id: 'version',
    version: 1,
    statusCode: 'submitted',
    createdByUserId: 'submitter',
    evidenceSealId: 'seal',
    evidenceRevision: 2,
    populationRevision: 3,
    workflowRevision: 4,
    contentHash: 'a'.repeat(64),
    personCount: 2,
    contributionRegimeCode: regime,
  };
  const run = {
    id: 'run',
    statusCode: stage === 'first' ? 'pending_first_review' : 'pending_final_review',
    currentSubmittedVersion: 1 as number | null,
  };
  const config = {
    env: 'test',
    contributionSettlementMode: 'fixture',
    activityV11Workflow: { enabled: true, readonlyMaintenance: false },
  } as AppConfig;
  const gate = new ActivityWorkflowGate(config);
  const tx = {
    $queryRaw: jest.fn(async (parts: TemplateStringsArray) => {
      await Promise.resolve();
      const sql = parts.join('');
      if (sql === '') {
        events.push('catalog:before');
        return [
          {
            valid: true,
            tableOid: '1',
            constraintOid: '2',
            triggerOid: '3',
            guardFunctionOid: '4',
            completeFunctionOid: '5',
          },
        ];
      }
      if (sql.includes('WITH latest AS')) {
        events.push('catalog:after');
        return [
          {
            valid: true,
            anchorValid: true,
            tableOid: '1',
            constraintOid: '2',
            triggerOid: '3',
            guardFunctionOid: '4',
            completeFunctionOid: '5',
          },
        ];
      }
      if (sql.includes('FROM "Activity"')) {
        events.push('lock:activity');
        return [{ title: 'Synthetic activity', workflowRevision: 4 }];
      }
      if (sql.includes('FROM "AttendanceSettlementRun"')) {
        events.push('lock:run');
        return [run];
      }
      if (sql.includes('FROM "AttendanceSettlementVersion"')) {
        events.push('lock:version');
        return [version];
      }
      if (sql.includes('e4_assert_complete')) {
        events.push('full');
        return [{ complete: null }];
      }
      throw new Error('Unexpected characterization query');
    }),
    $executeRaw: jest.fn(() => {
      events.push('barrier');
      return Promise.resolve(0);
    }),
    settlementReviewAction: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn((args: { orderBy?: unknown }) =>
        Promise.resolve(
          args.orderBy && stage === 'final' ? { actorUserId: 'first-reviewer' } : null,
        ),
      ),
      create: jest.fn(() => {
        events.push('action');
        return Promise.resolve({ id: 'decision' });
      }),
    },
    attendanceSettlementVersion: {
      update: jest.fn(() => {
        events.push('version');
        return Promise.resolve(version);
      }),
    },
    attendanceSettlementRun: {
      update: jest.fn(() => {
        events.push('run');
        return Promise.resolve(run);
      }),
    },
    evidenceSeal: { findFirst: jest.fn().mockResolvedValue({ id: 'seal' }) },
    activityEvidenceState: {
      findUnique: jest.fn().mockResolvedValue({ evidenceRevision: 2, populationRevision: 3 }),
    },
    activityResponsibilityAssignment: {
      findFirst: jest.fn().mockResolvedValue({ memberId: 'owner' }),
    },
    notificationOutboxIntent: { findMany: jest.fn().mockResolvedValue([]) },
    activitySettlementContributionRevision: {
      // Explicit historical/noncandidate proof: the general full path remains authoritative.
      findFirst: jest.fn().mockResolvedValue({ id: 'historical-proof', schemaVersion: 0 }),
    },
    ledgerPostingBatch: {
      findFirst: jest.fn().mockResolvedValue(null),
      aggregate: jest.fn().mockResolvedValue({ _max: { batchRevision: 2 } }),
      create: jest.fn(() => {
        events.push('batch');
        return Promise.resolve({ id: 'batch', statusCode: 'preparing' });
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const prismaTx = tx as unknown as Prisma.TransactionClient;
  const transaction = jest.fn(
    async (callback: (client: Prisma.TransactionClient) => Promise<unknown>) => {
      events.push('tx:start');
      const result = await callback(prismaTx);
      events.push('tx:end');
      return result;
    },
  );
  const audit = {
    log: jest.fn(() => {
      events.push('audit');
      return Promise.resolve();
    }),
  };
  const notifications = {
    enqueueReviewed: jest.fn(() => {
      events.push('notification');
      return Promise.resolve();
    }),
  };
  const contributions = new ActivityContributionSettlementService(
    config,
    new ActivityContributionSettlementQueryService(),
    gate,
  );
  const full = jest.spyOn(contributions, 'assertVersionInTx');
  const service = new SettlementReviewService(
    { $transaction: transaction } as unknown as PrismaService,
    audit as unknown as SettlementReviewAuditRecorder,
    notifications as unknown as SettlementNotificationProducer,
    gate,
    contributions,
  );
  const actor = {
    id: 'reviewer',
    memberId: 'reviewer-member',
    username: 'reviewer',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  };
  const input: SettlementReviewInput = {
    activityId: 'activity',
    actionCode: 'approve',
    operationKey: 'operation',
    requestHash: 'b'.repeat(64),
    expectation: {
      evidenceSealId: 'seal',
      evidenceRevision: 2,
      populationRevision: 3,
      workflowRevision: 4,
      contentHash: version.contentHash,
    },
  };
  const invoke = () =>
    stage === 'first'
      ? service.firstReview(input, actor, REVIEW_META)
      : service.finalReview(input, actor, REVIEW_META);
  return {
    service,
    contributions,
    full,
    tx,
    prismaTx,
    transaction,
    audit,
    notifications,
    actor,
    input,
    invoke,
    events,
    version,
    run,
    gate,
  };
}

describe('SettlementReviewService original transaction characterization', () => {
  it.each(['legacy', 'policy_v1'])(
    'preserves four decision combinations and collaborators for %s',
    async (regime) => {
      for (const stage of ['first', 'final'] as const) {
        for (const action of ['approve', 'return'] as const) {
          const f = reviewFixture(stage, regime);
          f.input.actionCode = action;
          f.input.returnReason = '  documented reason  ';
          const result = await f.invoke();
          const runAfter =
            action === 'return'
              ? 'drafting'
              : stage === 'first'
                ? 'pending_final_review'
                : 'posting';
          const versionAfter =
            action === 'return' ? 'returned' : stage === 'first' ? 'submitted' : 'approved';
          expect(result).toMatchObject({
            stageCode: stage,
            actionCode: action,
            runStatusAfter: runAfter,
            versionStatusAfter: versionAfter,
            replayed: false,
          });
          expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 15_000 });
          expect(SETTLEMENT_REVIEW_TX_TIMEOUT_MS).toBe(15_000);
          expect(f.events.slice(0, 4)).toEqual([
            'tx:start',
            'lock:activity',
            'lock:run',
            'lock:version',
          ]);
          expect(f.events.slice(-6)).toEqual([
            'action',
            'version',
            'run',
            'notification',
            'audit',
            'tx:end',
          ]);
          expect(f.tx.attendanceSettlementVersion.update).toHaveBeenCalledTimes(1);
          expect(f.tx.attendanceSettlementVersion.update).toHaveBeenCalledWith({
            where: { id: 'version' },
            data: {
              statusCode: versionAfter,
              returnFromStage: action === 'return' ? stage : null,
              returnReason: action === 'return' ? 'documented reason' : null,
            },
          });
          expect(f.tx.attendanceSettlementRun.update).toHaveBeenCalledWith({
            where: { id: 'run' },
            data: { statusCode: runAfter, version: { increment: 1 } },
          });
          const actionData = f.tx.settlementReviewAction.create.mock.calls[0];
          expect(actionData).toBeDefined();
          expect(f.notifications.enqueueReviewed).toHaveBeenCalledWith(
            f.prismaTx,
            expect.objectContaining({
              activityId: 'activity',
              settlementVersionId: 'version',
              stageCode: stage,
              actionCode: action,
              cohort: expect.objectContaining({
                memberIds: ['owner'],
                stamp: expect.objectContaining({ cohortSize: 1 }) as unknown,
              }) as unknown,
            }),
          );
          expect(f.audit.log).toHaveBeenCalledWith(
            expect.objectContaining({
              ...result,
              tx: f.prismaTx,
              operationKey: f.input.operationKey,
              requestHash: f.input.requestHash,
              actorUserId: f.actor.id,
              actorRoleSnap: Role.USER,
              contentHash: f.version.contentHash,
            }),
          );
          if (regime === 'policy_v1') {
            expect(f.full).toHaveBeenCalledWith(f.prismaTx, 'version');
            expect(f.events.indexOf('full')).toBeLessThan(f.events.indexOf('action'));
          } else expect(f.full).not.toHaveBeenCalled();
          if (stage === 'final' && action === 'approve') {
            expect(result).toMatchObject({
              ledgerPostingBatchId: 'batch',
              ledgerPostingBatchStatus: 'preparing',
            });
            expect(f.tx.ledgerPostingBatch.create).toHaveBeenCalledWith(
              expect.objectContaining({
                data: expect.objectContaining({
                  batchRevision: 3,
                  statusCode: 'preparing',
                  preparedByUserId: f.actor.id,
                }) as unknown,
              }),
            );
          }
          if (stage === 'final' && action === 'return')
            expect(f.tx.ledgerPostingBatch.updateMany).toHaveBeenCalled();
        }
      }
    },
  );

  it('preserves legal replay before run/version state checks, with audit but no new action/notification/update', async () => {
    const f = reviewFixture('first', 'policy_v1');
    f.run.statusCode = 'posting';
    f.version.statusCode = 'approved';
    f.tx.settlementReviewAction.findUnique.mockResolvedValue({
      id: 'original-action',
      actedAt: new Date(0),
      settlementVersionId: 'version',
      stageCode: 'first',
      actionCode: 'approve',
      requestHash: f.input.requestHash,
    });
    await expect(f.invoke()).resolves.toMatchObject({
      replayed: true,
      reviewActionId: 'original-action',
      runStatusBefore: 'posting',
      runStatusAfter: 'posting',
    });
    expect(f.full).not.toHaveBeenCalled();
    expect(f.tx.settlementReviewAction.create).not.toHaveBeenCalled();
    expect(f.tx.attendanceSettlementVersion.update).not.toHaveBeenCalled();
    expect(f.tx.attendanceSettlementRun.update).not.toHaveBeenCalled();
    expect(f.notifications.enqueueReviewed).not.toHaveBeenCalled();
    expect(f.audit.log).toHaveBeenCalledTimes(1);
  });

  it.each(['settlementVersionId', 'stageCode', 'actionCode', 'requestHash'] as const)(
    'rejects globally colliding operationKey when %s differs',
    async (field) => {
      const f = reviewFixture();
      f.tx.settlementReviewAction.findUnique.mockResolvedValue({
        id: 'old',
        actedAt: new Date(0),
        settlementVersionId: 'version',
        stageCode: 'first',
        actionCode: 'approve',
        requestHash: f.input.requestHash,
        [field]: 'different',
      });
      await expect(f.invoke()).rejects.toMatchObject({
        biz: BizCode.SETTLEMENT_REVIEW_OPERATION_KEY_CONFLICT,
      });
      expect(f.tx.settlementReviewAction.create).not.toHaveBeenCalled();
    },
  );

  it('checks the locked HTTP version anchor before replay and before all writes', async () => {
    const f = reviewFixture();
    f.input.expectedSettlementVersionId = 'old-version';
    await expect(f.invoke()).rejects.toMatchObject({
      biz: BizCode.SETTLEMENT_REVIEW_EXPECTED_VERSION_MISMATCH,
    });
    expect(f.tx.settlementReviewAction.findUnique).not.toHaveBeenCalled();
    expect(f.tx.attendanceSettlementVersion.update).not.toHaveBeenCalled();
  });

  it('reports the stage winner before an already changed run state', async () => {
    const f = reviewFixture();
    f.run.statusCode = 'drafting';
    f.tx.settlementReviewAction.findFirst.mockResolvedValue({ actorUserId: 'winner' });
    await expect(f.invoke()).rejects.toMatchObject({
      biz: BizCode.SETTLEMENT_REVIEW_ALREADY_DECIDED,
    });
    expect(f.tx.settlementReviewAction.create).not.toHaveBeenCalled();
  });

  it.each([
    ['first', 'submitter', BizCode.SETTLEMENT_SELF_FIRST_REVIEW_FORBIDDEN],
    ['final', 'submitter', BizCode.SETTLEMENT_SELF_FINAL_REVIEW_FORBIDDEN],
    ['final', 'first-reviewer', BizCode.SETTLEMENT_SAME_REVIEWER_FORBIDDEN],
  ] as const)('keeps locked separation for %s / %s', async (stage, actorId, biz) => {
    const f = reviewFixture(stage, 'policy_v1');
    f.actor.id = actorId;
    await expect(f.invoke()).rejects.toMatchObject({ biz });
    expect(f.full).not.toHaveBeenCalled();
    expect(f.tx.settlementReviewAction.create).not.toHaveBeenCalled();
  });

  it.each([
    ['evidenceSealId', 'other-seal', BizCode.SETTLEMENT_REVIEW_EVIDENCE_SEAL_STALE],
    ['evidenceRevision', 9, BizCode.SETTLEMENT_REVIEW_EVIDENCE_REVISION_CHANGED],
    ['populationRevision', 9, BizCode.SETTLEMENT_REVIEW_EVIDENCE_REVISION_CHANGED],
    ['workflowRevision', 9, BizCode.SETTLEMENT_REVIEW_WORKFLOW_REVISION_CHANGED],
    ['contentHash', 'c'.repeat(64), BizCode.SETTLEMENT_REVIEW_CONTENT_HASH_CHANGED],
  ] as const)(
    'preserves the original %s error before contribution checks',
    async (field, value, biz) => {
      const f = reviewFixture('first', 'policy_v1');
      const expectation = { ...f.input.expectation, [field]: value };
      await expect(
        f.service.firstReview({ ...f.input, expectation }, f.actor, REVIEW_META),
      ).rejects.toMatchObject({ biz });
      expect(f.full).not.toHaveBeenCalled();
      expect(f.tx.attendanceSettlementVersion.update).not.toHaveBeenCalled();
    },
  );

  it.each(['notification', 'audit'] as const)(
    'propagates %s failure through the original transaction owner',
    async (point) => {
      const f = reviewFixture();
      const failure = new Error('synthetic collaborator failure');
      if (point === 'notification') f.notifications.enqueueReviewed.mockRejectedValue(failure);
      else f.audit.log.mockRejectedValue(failure);
      await expect(f.invoke()).rejects.toBe(failure);
      expect(f.events).not.toContain('tx:end');
      if (point === 'notification') expect(f.audit.log).not.toHaveBeenCalled();
    },
  );
});

function enableFreshFirstReviewProof(f: ReturnType<typeof reviewFixture>) {
  f.tx.activitySettlementContributionRevision.findFirst.mockResolvedValue({
    id: 'native-proof',
    revision: 2,
    schemaVersion: 1,
    regimeCode: 'policy_v1',
    kindCode: 'submitted',
    sourceKindCode: 'time_revision',
    activityId: 'activity',
    settlementRunId: 'run',
    settlementVersionId: 'version',
    effectiveTimeSettlementVersionId: 'version',
    evidenceSealId: 'seal',
    evidenceRevision: 2,
    populationRevision: 3,
    workflowRevision: 4,
    timeRevisionId: 'time',
    sourceDraftContributionRevisionId: 'draft-proof',
    correctionApplicationId: null,
    correctionPostingBatchId: null,
    baseSettlementVersionId: null,
    correctionManifestId: null,
    correctionTimeSourceProofId: null,
    rootTimeManifestId: null,
    correctionSourceSetHash: null,
    previousContributionRevisionId: null,
  });
}

describe('§12.26 exact first/approve owner orchestration', () => {
  it('keeps one original Prisma UPDATE, consumes the real guard before actedAt/action, and never performs the explicit duplicate full check', async () => {
    const f = reviewFixture('first', 'policy_v1');
    enableFreshFirstReviewProof(f);
    jest.useFakeTimers();
    const before = new Date('2026-10-05T00:00:00Z');
    const afterGuard = new Date('2026-10-05T00:00:01Z');
    jest.setSystemTime(before);
    f.tx.$executeRaw.mockImplementation(() => {
      f.events.push('barrier');
      jest.setSystemTime(afterGuard);
      return Promise.resolve(0);
    });
    try {
      await expect(f.invoke()).resolves.toMatchObject({
        runStatusAfter: 'pending_final_review',
        replayed: false,
      });
      expect(f.events).toEqual([
        'tx:start',
        'lock:activity',
        'lock:run',
        'lock:version',
        'catalog:before',
        'version',
        'catalog:after',
        'barrier',
        'action',
        'run',
        'notification',
        'audit',
        'tx:end',
      ]);
      expect(f.tx.attendanceSettlementVersion.update).toHaveBeenCalledTimes(1);
      expect(f.tx.attendanceSettlementVersion.update).toHaveBeenCalledWith({
        where: { id: 'version' },
        data: { statusCode: 'submitted', returnFromStage: null, returnReason: null },
      });
      expect(f.tx.settlementReviewAction.create).toHaveBeenCalledWith({
        data: {
          settlementVersionId: 'version',
          stageCode: 'first',
          actionCode: 'approve',
          actorUserId: f.actor.id,
          actedAt: afterGuard,
          note: null,
          operationKey: f.input.operationKey,
          requestHash: f.input.requestHash,
        },
        select: { id: true },
      });
      expect(f.full).not.toHaveBeenCalled();
      expect(f.tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 15_000 });
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['first-return', 'final-approve', 'final-return'] as const)(
    'never selects the fresh narrow path for %s',
    async (combination) => {
      const f = reviewFixture(combination.startsWith('first') ? 'first' : 'final', 'policy_v1');
      f.input.actionCode = combination.endsWith('return') ? 'return' : 'approve';
      f.input.returnReason = 'reason';
      enableFreshFirstReviewProof(f);
      const candidate = jest.spyOn(f.contributions, 'readFirstReviewBarrierCandidateInTx');
      await f.invoke();
      expect(candidate).not.toHaveBeenCalled();
      expect(f.full).toHaveBeenCalledTimes(1);
      expect(f.tx.$executeRaw).not.toHaveBeenCalled();
      expect(f.events.indexOf('full')).toBeLessThan(f.events.indexOf('action'));
      expect(f.events.indexOf('action')).toBeLessThan(f.events.indexOf('version'));
    },
  );

  it.each(['precheck', 'update', 'barrier'] as const)(
    'does not write a decision/run/outbox/audit after %s fails',
    async (point) => {
      const f = reviewFixture('first', 'policy_v1');
      enableFreshFirstReviewProof(f);
      const failure = new Error('synthetic exact first-review failure');
      if (point === 'precheck')
        jest
          .spyOn(f.contributions, 'readFirstReviewBarrierCandidateInTx')
          .mockRejectedValueOnce(failure);
      else if (point === 'update')
        f.tx.attendanceSettlementVersion.update.mockRejectedValueOnce(failure);
      else f.tx.$executeRaw.mockRejectedValueOnce(failure);
      await expect(f.invoke()).rejects.toBe(failure);
      expect(f.tx.settlementReviewAction.create).not.toHaveBeenCalled();
      expect(f.tx.attendanceSettlementRun.update).not.toHaveBeenCalled();
      expect(f.notifications.enqueueReviewed).not.toHaveBeenCalled();
      expect(f.audit.log).not.toHaveBeenCalled();
      expect(f.full).not.toHaveBeenCalled();
      if (point === 'precheck')
        expect(f.tx.attendanceSettlementVersion.update).not.toHaveBeenCalled();
    },
  );
});
