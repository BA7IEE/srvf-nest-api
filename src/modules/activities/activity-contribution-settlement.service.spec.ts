import {
  Prisma,
  type ActivitySettlementContributionRevision,
  type ActivitySettlementTimeRevision,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppConfig } from '../../config/app.config';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  ActivityContributionSettlementService,
  contributionSettlementError,
  frozenContributionRegime,
} from './activity-contribution-settlement.service';
import { ActivityContributionSettlementQueryService } from './activity-contribution-settlement-query.service';
import {
  ContributionSettlementPolicyError,
  evaluateSettlementContributions,
} from './activity-contribution-settlement-policy';
import { fingerprintContributionPolicyVersion } from './activity-contribution-policy-definition';

const FIRST_REVIEW_TEST_GUARD = {
  valid: true,
  tableOid: '1',
  constraintOid: '2',
  triggerOid: '3',
  guardFunctionOid: '4',
  completeFunctionOid: '5',
};

function firstReviewProof() {
  return { ...root(), kindCode: 'submitted', sourceDraftContributionRevisionId: 'draft-proof' };
}
function firstReviewAnchor() {
  const proof = firstReviewProof();
  return {
    activityId: proof.activityId,
    settlementRunId: proof.settlementRunId,
    settlementVersionId: proof.settlementVersionId,
    evidenceSealId: proof.evidenceSealId,
    evidenceRevision: proof.evidenceRevision,
    populationRevision: proof.populationRevision,
    workflowRevision: proof.workflowRevision,
  };
}

function time(): ActivitySettlementTimeRevision {
  return {
    id: 'time-one',
    activityId: 'activity-one',
    settlementRunId: 'run-one',
    settlementVersionId: 'draft-one',
    revision: 1,
    previousTimeRevisionId: null,
    sourceDraftTimeRevisionId: null,
    kindCode: 'draft',
    evidenceSealId: 'seal-one',
    evidenceRevision: 1,
    populationRevision: 1,
    workflowRevision: 1,
    draftContentHash: 'a'.repeat(64),
    sourceSetHash: 'b'.repeat(64),
    bucketContentHash: 'c'.repeat(64),
    bucketCount: 4,
    sourceCount: 4,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    createdByUserId: 'actor-one',
  };
}
function evaluation() {
  const effectiveFrom = new Date('2026-01-01T00:00:00.000Z');
  const envelope = fingerprintContributionPolicyVersion({
    schemaVersion: 1,
    evaluatorVersion: 1,
    effectiveFrom: effectiveFrom.toISOString(),
    effectiveUntil: null,
    definition: {
      defaultResult: { recognizedPoints: '0.00', explanationCode: 'zero_policy' },
      roleRules: [],
    },
  });
  return {
    ...evaluateSettlementContributions({
      activityId: 'activity-one',
      settlementVersionId: 'draft-one',
      sourceKindCode: 'time_revision',
      sources: [
        {
          participationIdentityId: 'identity-one',
          memberId: 'member-one',
          sessionId: 'session-one',
          ruleSnapshotId: 'snapshot-one',
          attendanceRoleCode: 'member',
          timeCategoryCode: 'training',
          selection: {
            id: 'selection-item-one',
            mode: 'policy',
            policy: {
              policyId: 'policy-one',
              versionId: 'policy-version-one',
              definitionHash: envelope.definitionHash,
              schemaVersion: 1,
              evaluatorVersion: 1,
              definitionJson: envelope.definition,
              effectiveFrom,
              effectiveUntil: null,
            },
          },
          allocationRevisionId: 'allocation-one',
          sliceId: 'slice-one',
          sourceSegmentId: 'segment-one',
          sourceSegmentRevision: 1,
          allocationHash: 'd'.repeat(64),
          durationSeconds: 60,
          startsAt: new Date('2026-10-01T00:00:00.000Z'),
          endsAt: new Date('2026-10-01T00:01:00.000Z'),
        },
      ],
    }),
    ruleSnapshotId: 'snapshot-one',
    ruleSnapshotHash: 'e'.repeat(64),
    selectionRevisionId: 'selection-revision-one',
    selectionRevisionHash: 'f'.repeat(64),
  };
}
function root(): ActivitySettlementContributionRevision {
  const basis = time(),
    evaluated = evaluation();
  return {
    id: 'contribution-one',
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    activityId: basis.activityId,
    settlementRunId: basis.settlementRunId,
    settlementVersionId: basis.settlementVersionId,
    effectiveTimeSettlementVersionId: basis.settlementVersionId,
    revision: 1,
    kindCode: 'draft',
    sourceKindCode: 'time_revision',
    timeRevisionId: basis.id,
    correctionApplicationId: null,
    correctionPostingBatchId: null,
    baseSettlementVersionId: null,
    correctionManifestId: null,
    correctionTimeSourceProofId: null,
    rootTimeManifestId: null,
    correctionSourceSetHash: null,
    previousContributionRevisionId: null,
    sourceDraftContributionRevisionId: null,
    schemaVersion: 1,
    regimeCode: 'policy_v1',
    evidenceSealId: basis.evidenceSealId,
    evidenceRevision: basis.evidenceRevision,
    populationRevision: basis.populationRevision,
    workflowRevision: basis.workflowRevision,
    draftContentHash: basis.draftContentHash,
    ruleSnapshotId: evaluated.ruleSnapshotId,
    ruleSnapshotHash: evaluated.ruleSnapshotHash,
    selectionRevisionId: evaluated.selectionRevisionId,
    selectionRevisionHash: evaluated.selectionRevisionHash,
    sourceSetHash: evaluated.sourceSetHash,
    evaluationSetHash: evaluated.evaluationSetHash,
    recognizedPointsTotal: new Prisma.Decimal(evaluated.recognizedPointsTotal),
    evaluationCount: evaluated.evaluationCount,
    operationKey: 'operation-one',
    requestHash: '0'.repeat(64),
    createdByUserId: 'actor-one',
  };
}
function setup(
  mode: 'off' | 'fixture' = 'fixture',
  env: AppConfig['env'] = 'test',
  workflow = { enabled: true, readonlyMaintenance: false },
) {
  const config = {
    env,
    contributionSettlementMode: mode,
    activityV11Workflow: workflow,
  } as AppConfig;
  const queries = new ActivityContributionSettlementQueryService();
  const read = jest.spyOn(queries, 'readTimeEvaluationInTx').mockResolvedValue(evaluation());
  const service = new ActivityContributionSettlementService(
    config,
    queries,
    new ActivityWorkflowGate(config),
  );
  const tx = {
    activitySettlementContributionRevision: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(root()),
    },
    activitySettlementTimeRevision: { findFirst: jest.fn().mockResolvedValue(time()) },
    $queryRaw: jest.fn().mockResolvedValue([{ complete: true }]),
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const actor = { id: 'actor-one', memberId: 'member-one' } as CurrentUserPayload;
  const reauthorize = jest.fn().mockResolvedValue(actor);
  const command = { operationKey: 'operation-one', requestHash: '0'.repeat(64) };
  return {
    service,
    read,
    tx,
    prismaTx: tx as unknown as Prisma.TransactionClient,
    reauthorize,
    command,
  };
}

describe('§12.26 first-review candidate and actual constraint barrier', () => {
  it('reads the same latest proof predicate without prefiltering good rows', async () => {
    const { service, prismaTx, tx } = setup();
    tx.activitySettlementContributionRevision.findFirst.mockResolvedValue(firstReviewProof());
    tx.$queryRaw.mockResolvedValue([FIRST_REVIEW_TEST_GUARD]);
    await expect(
      service.readFirstReviewBarrierCandidateInTx(prismaTx, firstReviewAnchor()),
    ).resolves.toEqual({ proof: firstReviewProof(), guard: FIRST_REVIEW_TEST_GUARD });
    expect(tx.activitySettlementContributionRevision.findFirst).toHaveBeenCalledWith({
      where: {
        settlementVersionId: firstReviewProof().settlementVersionId,
        kindCode: { in: ['submitted', 'correction'] },
        regimeCode: 'policy_v1',
      },
      orderBy: { revision: 'desc' },
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['schemaVersion', 2],
    ['regimeCode', 'legacy'],
    ['kindCode', 'correction'],
    ['sourceKindCode', 'unchanged_time'],
    ['activityId', 'other'],
    ['settlementRunId', 'other'],
    ['settlementVersionId', 'other'],
    ['effectiveTimeSettlementVersionId', 'other'],
    ['evidenceSealId', 'other'],
    ['evidenceRevision', 9],
    ['populationRevision', 9],
    ['workflowRevision', 9],
    ['timeRevisionId', null],
    ['sourceDraftContributionRevisionId', null],
    ['correctionApplicationId', 'unexpected'],
    ['correctionPostingBatchId', 'unexpected'],
    ['baseSettlementVersionId', 'unexpected'],
    ['correctionManifestId', 'unexpected'],
    ['correctionTimeSourceProofId', 'unexpected'],
    ['rootTimeManifestId', 'unexpected'],
    ['correctionSourceSetHash', 'unexpected'],
    ['previousContributionRevisionId', 'unexpected'],
  ] as const)('leaves latest %s mismatch to the original full path', async (field, value) => {
    const { service, prismaTx, tx } = setup();
    tx.activitySettlementContributionRevision.findFirst.mockResolvedValue({
      ...firstReviewProof(),
      [field]: value,
    });
    await expect(
      service.readFirstReviewBarrierCandidateInTx(prismaTx, firstReviewAnchor()),
    ).resolves.toBeNull();
    expect(tx.activitySettlementContributionRevision.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('does not accept absent proof or hunt for an earlier valid revision', async () => {
    const { service, prismaTx, tx } = setup();
    await expect(
      service.readFirstReviewBarrierCandidateInTx(prismaTx, firstReviewAnchor()),
    ).resolves.toBeNull();
    expect(tx.activitySettlementContributionRevision.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it.each([
    { rows: [] },
    { rows: [{ ...FIRST_REVIEW_TEST_GUARD, valid: false }] },
    { rows: [FIRST_REVIEW_TEST_GUARD, FIRST_REVIEW_TEST_GUARD] },
  ])('rejects absent/invalid/nonunique guard before a version write: %j', async ({ rows }) => {
    const { service, prismaTx, tx } = setup();
    tx.activitySettlementContributionRevision.findFirst.mockResolvedValue(firstReviewProof());
    tx.$queryRaw.mockResolvedValue(rows);
    await expect(
      service.readFirstReviewBarrierCandidateInTx(prismaTx, firstReviewAnchor()),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('pins both real function bodies independently and checks exact catalog properties', async () => {
    const { service, prismaTx, tx } = setup();
    tx.activitySettlementContributionRevision.findFirst.mockResolvedValue(firstReviewProof());
    tx.$queryRaw.mockResolvedValue([FIRST_REVIEW_TEST_GUARD]);
    await service.readFirstReviewBarrierCandidateInTx(prismaTx, firstReviewAnchor());
    const call = tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, Prisma.Sql];
    const sql = call[1].text;
    const migration = readFileSync(
      resolve(
        __dirname,
        '../../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',
      ),
      'utf8',
    );
    for (const name of ['e4_native_version_complete_guard', 'e4_assert_complete']) {
      const matches = [
        ...migration.matchAll(
          new RegExp(`CREATE FUNCTION ${name}\\([^]*? AS \\$\\$([^]*?)\\$\\$;`, 'gu'),
        ),
      ];
      expect(matches).toHaveLength(1);
      const pin = createHash('md5').update(matches[0][1]).digest('hex');
      expect(sql).toContain(pin);
    }
    for (const predicate of [
      "current_setting('session_replication_role') = 'origin'",
      'trigger_row.tgtype=21',
      "trigger_row.tgenabled::text='O'",
      'trigger_row.tgdeferrable',
      'trigger_row.tginitdeferred',
      'trigger_row.tgqual IS NULL',
      "trigger_row.tgattr::text=''",
      'trigger_row.tgnargs=0',
      'NOT guard_proc.prosecdef',
      'NOT complete_proc.prosecdef',
      "constraint_row.contype='t'",
      'complete_proc.pronargdefaults=1',
      "pg_get_expr(complete_proc.proargdefaults,0)='true'",
    ])
      expect(sql).toContain(predicate);
  });

  it('accepts only the finalized S13 whole-body pin and never the superseded opening body', async () => {
    const { service, prismaTx, tx } = setup();
    tx.activitySettlementContributionRevision.findFirst.mockResolvedValue(firstReviewProof());
    tx.$queryRaw.mockResolvedValue([FIRST_REVIEW_TEST_GUARD]);
    await service.readFirstReviewBarrierCandidateInTx(prismaTx, firstReviewAnchor());
    const call = tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, Prisma.Sql];
    expect(call[1].text).toContain("md5(complete_proc.prosrc)='21fe9ecf6df989a3f8fa5878df40b93c'");
    expect(call[1].text).not.toContain('edd162a44264b0d073d0009d3e592d0e');
    expect(call[1].text).not.toContain('7e56ad35c5266706ab7cf12757c8f1b2');
    expect(call[1].text).toContain('fa428e2eb3e733f770cbb31c15dd4720');
  });

  it('rechecks the latest whole anchor and identical catalog identities after UPDATE, then consumes only the named constraint', async () => {
    const { service, prismaTx, tx } = setup();
    tx.$queryRaw.mockResolvedValue([{ ...FIRST_REVIEW_TEST_GUARD, anchorValid: true }]);
    const candidate = { proof: firstReviewProof(), guard: FIRST_REVIEW_TEST_GUARD };
    await service.assertFirstReviewBarrierInTx(prismaTx, firstReviewAnchor(), candidate);
    const call = tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, string, string, Prisma.Sql];
    const expected = JSON.parse(call[2]) as Record<string, unknown>;
    expect(expected).toMatchObject({
      ...firstReviewAnchor(),
      id: candidate.proof.id,
      revision: candidate.proof.revision,
      sourceDraftContributionRevisionId: 'draft-proof',
      correctionApplicationId: null,
      previousContributionRevisionId: null,
      schemaVersion: 1,
      kindCode: 'submitted',
    });
    expect(call[0].join('')).toContain('ORDER BY revision DESC LIMIT 1');
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw.mock.calls[0]).toEqual([
      ['SET CONSTRAINTS public.e4_native_version_complete_guard IMMEDIATE'],
    ]);
  });

  it.each([
    'tableOid',
    'constraintOid',
    'triggerOid',
    'guardFunctionOid',
    'completeFunctionOid',
  ] as const)('fails closed when %s changes after UPDATE', async (field) => {
    const { service, prismaTx, tx } = setup();
    tx.$queryRaw.mockResolvedValue([
      { ...FIRST_REVIEW_TEST_GUARD, [field]: 'changed', anchorValid: true },
    ]);
    await expect(
      service.assertFirstReviewBarrierInTx(prismaTx, firstReviewAnchor(), {
        proof: firstReviewProof(),
        guard: FIRST_REVIEW_TEST_GUARD,
      }),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it.each([
    { valid: false, anchorValid: true },
    { valid: true, anchorValid: false },
  ])(
    'rejects stale/invalid post-UPDATE evidence rather than guessing a fallback: %j',
    async (state) => {
      const { service, prismaTx, tx } = setup();
      tx.$queryRaw.mockResolvedValue([{ ...FIRST_REVIEW_TEST_GUARD, ...state }]);
      await expect(
        service.assertFirstReviewBarrierInTx(prismaTx, firstReviewAnchor(), {
          proof: firstReviewProof(),
          guard: FIRST_REVIEW_TEST_GUARD,
        }),
      ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY });
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    },
  );

  it('propagates catalog and actual barrier errors unchanged', async () => {
    const { service, prismaTx, tx } = setup();
    const failure = new Error('synthetic DB error');
    tx.activitySettlementContributionRevision.findFirst.mockResolvedValue(firstReviewProof());
    tx.$queryRaw.mockRejectedValueOnce(failure);
    await expect(
      service.readFirstReviewBarrierCandidateInTx(prismaTx, firstReviewAnchor()),
    ).rejects.toBe(failure);
    tx.$queryRaw.mockResolvedValue([{ ...FIRST_REVIEW_TEST_GUARD, anchorValid: true }]);
    tx.$executeRaw.mockRejectedValueOnce(failure);
    await expect(
      service.assertFirstReviewBarrierInTx(prismaTx, firstReviewAnchor(), {
        proof: firstReviewProof(),
        guard: FIRST_REVIEW_TEST_GUARD,
      }),
    ).rejects.toBe(failure);
  });
});

describe('E4 transaction-owned contribution orchestration', () => {
  it('sets one transaction-local planner mode before the unchanged native bulk INSERT', async () => {
    const { service, prismaTx, tx, command, reauthorize } = setup();
    tx.$queryRaw.mockResolvedValue([{ set_config: 'force_custom_plan' }]);
    await service.prepareTimeInTx(prismaTx, time(), 'policy_v1', command, reauthorize);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect((tx.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('').trim()).toBe(
      "SELECT pg_catalog.set_config('plan_cache_mode', 'force_custom_plan', true)",
    );
    expect(
      tx.activitySettlementContributionRevision.create.mock.invocationCallOrder[0],
    ).toBeLessThan(tx.$queryRaw.mock.invocationCallOrder[0]);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$executeRaw.mock.invocationCallOrder[0],
    );
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(reauthorize).toHaveBeenCalledTimes(2);
  });
  it('propagates planner configuration failure before inserting any evaluation', async () => {
    const { service, prismaTx, tx, command, reauthorize } = setup();
    const failure = new Error('native planner setting unavailable');
    tx.$queryRaw.mockRejectedValue(failure);
    await expect(
      service.prepareTimeInTx(prismaTx, time(), 'policy_v1', command, reauthorize),
    ).rejects.toBe(failure);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(reauthorize).toHaveBeenCalledTimes(1);
  });
  it.each(['legacy', 'reuse', 'off'] as const)(
    'does not configure planner mode for %s preparation',
    async (entry) => {
      const { service, prismaTx, tx, command, reauthorize } = setup(
        entry === 'off' ? 'off' : 'fixture',
      );
      if (entry === 'reuse')
        tx.activitySettlementContributionRevision.findFirst.mockResolvedValue(root());
      const action = service.prepareTimeInTx(
        prismaTx,
        time(),
        entry === 'legacy' ? 'legacy' : 'policy_v1',
        command,
        reauthorize,
      );
      if (entry === 'off') await expect(action).rejects.toThrow();
      else await action;
      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    },
  );
  it('does not configure planner mode when copying a submitted contribution proof', async () => {
    const { service, prismaTx, tx, command, reauthorize } = setup();
    tx.activitySettlementContributionRevision.findFirst.mockResolvedValue({ revision: 3 });
    await service.copySubmittedTimeInTx(
      prismaTx,
      root(),
      {
        ...time(),
        id: 'submitted-time',
        settlementVersionId: 'submitted-one',
        kindCode: 'submitted',
      },
      command,
      reauthorize,
    );
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
  it.each([
    { enabled: false, readonlyMaintenance: false },
    { enabled: true, readonlyMaintenance: true },
    { enabled: false, readonlyMaintenance: true },
  ])('keeps the existing workflow gate mandatory for every native write: %j', (workflow) => {
    const { service, tx, read } = setup('fixture', 'test', workflow);
    expect(() => service.assertNativeWriteAllowed()).toThrow();
    expect(tx.activitySettlementContributionRevision.create).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
  it('defaults only absent test-fixture fields to historical legacy, and rejects unknown regimes', () => {
    expect(frozenContributionRegime(undefined)).toBe('legacy');
    expect(frozenContributionRegime('legacy')).toBe('legacy');
    expect(frozenContributionRegime('policy_v1')).toBe('policy_v1');
    expect(() => frozenContributionRegime('active')).toThrow();
  });
  it('freezes new test runs to native without converting an existing legacy run', () => {
    const { service } = setup();
    expect(service.draftRegime(null)).toBe('policy_v1');
    expect(service.draftRegime('legacy')).toBe('legacy');
    expect(service.draftRegime('policy_v1')).toBe('policy_v1');
    expect(setup('off').service.draftRegime(null)).toBe('legacy');
    expect(() => setup('off').service.draftRegime('policy_v1')).toThrow();
  });
  it.each(['development', 'smoke', 'production'] as const)(
    'cannot produce native writes in %s even with a misconstructed fixture config',
    (env) => {
      expect(() => setup('fixture', env).service.assertNativeWriteAllowed()).toThrow();
    },
  );
  it('keeps off/legacy preparation and proof reads query-free', async () => {
    const { service, read, prismaTx, tx, command, reauthorize } = setup('off');
    await expect(
      service.prepareTimeInTx(prismaTx, time(), 'legacy', command, reauthorize),
    ).resolves.toBeNull();
    await expect(service.loadPreparedTimeInTx(prismaTx, time(), 'legacy')).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(tx.activitySettlementContributionRevision.findFirst).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
  it('blocks an existing native new write while off instead of silently returning legacy', async () => {
    const { service, prismaTx, command, reauthorize, read } = setup('off');
    await expect(
      service.prepareTimeInTx(prismaTx, time(), 'policy_v1', command, reauthorize),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it('writes all evaluations in one parameterized statement, with DB-created timestamps and lock-after read authorization', async () => {
    const { service, prismaTx, tx, command, reauthorize, read } = setup();
    await service.prepareTimeInTx(prismaTx, time(), 'policy_v1', command, reauthorize);
    expect(read).toHaveBeenCalledWith(prismaTx, time());
    expect(tx.activitySettlementContributionRevision.create.mock.calls[0]).toMatchObject([
      {
        data: {
          timeRevisionId: time().id,
          kindCode: 'draft',
          createdByUserId: 'actor-one',
          evaluationCount: 1,
        },
      },
    ]);
    const create = tx.activitySettlementContributionRevision.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(create[0].data).not.toHaveProperty('createdAt');
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(reauthorize).toHaveBeenCalledTimes(2);
    expect(reauthorize.mock.invocationCallOrder[0]).toBeLessThan(
      tx.activitySettlementContributionRevision.create.mock.invocationCallOrder[0],
    );
  });
  it('sends every frozen evaluation field and reference as the original JSON bytes', async () => {
    const { service, prismaTx, tx, command, reauthorize, read } = setup();
    const expected = evaluation();
    for (const row of expected.evaluations) {
      Object.freeze(row.sourceRefsJson);
      Object.freeze(row.beijingDayPointsJson);
      Object.freeze(row);
    }
    Object.freeze(expected.evaluations);
    read.mockResolvedValue(expected);
    await service.prepareTimeInTx(prismaTx, time(), 'policy_v1', command, reauthorize);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const call = tx.$executeRaw.mock.calls[0] as unknown[];
    const payload = call[call.length - 1];
    expect(payload).toBe(JSON.stringify(expected.evaluations));
    expect(JSON.parse(payload as string)).toEqual(expected.evaluations);
  });

  it('reuses exact content without minting a second evaluation, but still rechecks the current actor', async () => {
    const { service, prismaTx, tx, command, reauthorize } = setup();
    tx.activitySettlementContributionRevision.findFirst.mockResolvedValue(root());
    await expect(
      service.prepareTimeInTx(
        prismaTx,
        { ...time(), id: 'equivalent-time-two' },
        'policy_v1',
        { ...command, operationKey: 'other-request' },
        reauthorize,
      ),
    ).resolves.toEqual(root());
    expect(tx.activitySettlementContributionRevision.create).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(reauthorize).toHaveBeenCalledTimes(1);
  });
  it('does not reuse a content-equal proof from a different frozen seal or source snapshot', async () => {
    const { service, prismaTx, tx, command, reauthorize } = setup();
    tx.activitySettlementContributionRevision.findFirst.mockResolvedValue({
      ...root(),
      evidenceSealId: 'old-seal',
    });
    await service.prepareTimeInTx(prismaTx, time(), 'policy_v1', command, reauthorize);
    expect(tx.activitySettlementContributionRevision.create).toHaveBeenCalled();
  });
  it('propagates insertion-count failure to the outer owner transaction, never fabricates success', async () => {
    const { service, prismaTx, tx, command, reauthorize } = setup();
    tx.$executeRaw.mockResolvedValue(0);
    await expect(
      service.prepareTimeInTx(prismaTx, time(), 'policy_v1', command, reauthorize),
    ).rejects.toThrow();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
  it('requires authorization again after the source collection before the immutable write', async () => {
    const { service, prismaTx, tx, command, reauthorize } = setup();
    reauthorize.mockRejectedValue(new Error('qualification revoked'));
    await expect(
      service.prepareTimeInTx(prismaTx, time(), 'policy_v1', command, reauthorize),
    ).rejects.toThrow('qualification revoked');
    expect(tx.activitySettlementContributionRevision.create).not.toHaveBeenCalled();
  });
  it('requests the real database full-set check for a prepared proof', async () => {
    const { service, prismaTx, tx } = setup();
    tx.activitySettlementContributionRevision.findFirst.mockResolvedValue(root());
    await expect(service.loadPreparedTimeInTx(prismaTx, time(), 'policy_v1')).resolves.toEqual(
      root(),
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.activitySettlementTimeRevision.findFirst).not.toHaveBeenCalled();
  });
  it('checks both actual D4 content hashes before accepting an equivalent older D4 revision', async () => {
    const { service, prismaTx, tx } = setup();
    tx.activitySettlementContributionRevision.findFirst.mockResolvedValue({
      ...root(),
      timeRevisionId: 'previous-time',
    });
    tx.activitySettlementTimeRevision.findFirst.mockResolvedValue({
      ...time(),
      sourceSetHash: 'f'.repeat(64),
    });
    await expect(service.loadPreparedTimeInTx(prismaTx, time(), 'policy_v1')).rejects.toThrow();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
  it.each([
    { activityId: 'other-activity' },
    { sourceKindCode: 'unchanged_time' },
    { regimeCode: 'legacy' },
    { evidenceSealId: 'other-seal' },
    { workflowRevision: 9 },
    { draftContentHash: 'f'.repeat(64) },
    { timeRevisionId: null },
  ])('rejects a missing or mismatched native prepared anchor %p', async (override) => {
    const { service, prismaTx, tx } = setup();
    tx.activitySettlementContributionRevision.findFirst.mockResolvedValue({
      ...root(),
      ...override,
    });
    await expect(service.loadPreparedTimeInTx(prismaTx, time(), 'policy_v1')).rejects.toThrow();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
  it('copies proof details to the real newly submitted D4/version chain in one collection query', async () => {
    const { service, prismaTx, tx, command, reauthorize } = setup();
    const submittedTime = {
      ...time(),
      id: 'submitted-time',
      settlementVersionId: 'submitted-one',
      kindCode: 'submitted',
    };
    tx.activitySettlementContributionRevision.findFirst.mockResolvedValue({ revision: 3 });
    await service.copySubmittedTimeInTx(prismaTx, root(), submittedTime, command, reauthorize);
    expect(tx.activitySettlementContributionRevision.create.mock.calls[0]).toMatchObject([
      {
        data: {
          kindCode: 'submitted',
          revision: 4,
          timeRevisionId: submittedTime.id,
          settlementVersionId: submittedTime.settlementVersionId,
          sourceDraftContributionRevisionId: root().id,
        },
      },
    ]);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
  it('rejects a partial submitted copy or a cross-run/foreign time revision', async () => {
    const { service, prismaTx, tx, command, reauthorize } = setup();
    const submittedTime = {
      ...time(),
      id: 'submitted-time',
      settlementVersionId: 'submitted-one',
      kindCode: 'submitted',
    };
    tx.activitySettlementContributionRevision.findFirst.mockResolvedValue({ revision: 1 });
    tx.$executeRaw.mockResolvedValue(0);
    await expect(
      service.copySubmittedTimeInTx(prismaTx, root(), submittedTime, command, reauthorize),
    ).rejects.toThrow();
    tx.$executeRaw.mockClear();
    await expect(
      service.copySubmittedTimeInTx(
        prismaTx,
        root(),
        { ...submittedTime, settlementRunId: 'other-run' },
        command,
        reauthorize,
      ),
    ).rejects.toThrow();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
  it('translates a missing explicit policy to the existing not-ready code without adding a default score', () => {
    try {
      contributionSettlementError(new ContributionSettlementPolicyError('source_not_ready'));
    } catch (error) {
      expect(error).toMatchObject({ biz: BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY });
      return;
    }
    throw new Error('missing policy was not rejected');
  });
});
