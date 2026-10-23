import * as historicalRolePolicy from './activity-time-allocation-policy';
import * as timeSettlementPolicy from './activity-time-settlement-policy';
import { Prisma, Role, UserStatus, type ParticipantTimeAllocationRevision } from '@prisma/client';
import type { PrismaService } from '../../database/prisma.service';
import type { ParticipationSegmentFacade } from '../attendances/participation-segment.facade';
import type { ActivityTimeSettlementAccessService } from './activity-time-settlement-access.service';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { CurrentParticipationSegment } from '../attendances/participation-segment.facade';
import type { ActivityContributionSettlementQueryService } from './activity-contribution-settlement-query.service';
import type { ContributionProofSummary } from './activity-contribution-settlement-presenter';
import {
  allocationMatchesTimeSettlementSource,
  ActivityTimeSettlementQueryService,
  requireTimeSettlementDraft,
  timeSettlementError,
  timeSettlementReadinessBlockers,
  type TimeSettlementDraftContext,
  type TimeSettlementSourceSet,
} from './activity-time-settlement-query.service';
import {
  TimeSettlementPolicyError,
  TIME_SETTLEMENT_LIMITS,
  TIME_SETTLEMENT_CATEGORIES,
  timeSettlementSourceSetHash,
} from './activity-time-settlement-policy';

const context: TimeSettlementDraftContext = {
  runId: 'run',
  runStatusCode: 'drafting',
  currentDraftVersion: 1,
  currentSubmittedVersion: null,
  draftId: 'draft',
  draftVersion: 1,
  evidenceSealId: 'seal',
  evidenceRevision: 0,
  populationRevision: 0,
  workflowRevision: 0,
  draftContentHash: 'a'.repeat(64),
  sealCurrent: true,
};
const proof = requireTimeSettlementDraft('activity', context);

function segment(id = 'segment', identity = 'identity'): CurrentParticipationSegment {
  return {
    id,
    activityId: 'activity',
    sessionId: 'session',
    participationIdentityId: identity,
    memberId: 'member',
    sourcePositionId: null,
    segmentKey: id,
    revision: 1,
    sourceCheckInEventId: 'check-in',
    sourceCloseEventId: 'check-out',
    resultCode: 'valid',
    statusCode: 'draft',
    checkInAt: new Date('2020-01-01T10:00:00.000Z'),
    checkOutAt: new Date('2020-01-01T11:00:00.000Z'),
    lateFlag: false,
    earlyLeaveFlag: false,
    exceptionFlagsJson: null,
  };
}

function allocation(source = segment()): Omit<ParticipantTimeAllocationRevision, 'allocationJson'> {
  return {
    id: 'allocation-' + source.id,
    activityId: 'activity',
    sessionId: 'session',
    memberId: source.memberId,
    participationIdentityId: source.participationIdentityId,
    segmentKey: source.segmentKey,
    revision: 1,
    previousAllocationRevisionId: null,
    correctionPendingAllocationId: null,
    sourceSegmentId: source.id,
    sourceSegmentRevision: source.revision,
    sourcePositionId: null,
    ruleSnapshotId: 'snapshot',
    ruleSnapshotHash: 'b'.repeat(64),
    timePolicySelectionRevisionId: 'selection',
    selectionHash: 'b'.repeat(64),
    policyId: 'policy',
    policyVersionId: 'policy-version',
    definitionHash: 'b'.repeat(64),
    evaluatorVersion: 1,
    recognitionModeCode: 'automatic',
    manualReason: null,
    allocationHash: 'c'.repeat(64),
    sliceCount: 1,
    createdAt: new Date('2020-01-01T12:00:00.000Z'),
    createdByUserId: 'actor',
    settlementDraftVersionId: proof.settlementDraftVersionId,
    settlementEvidenceSealId: proof.evidenceSealId,
    settlementEvidenceRevision: proof.evidenceRevision,
    settlementPopulationRevision: proof.populationRevision,
    settlementWorkflowRevision: proof.workflowRevision,
    settlementDraftContentHash: proof.draftContentHash,
  };
}

function sourceSet(overrides: Partial<TimeSettlementSourceSet> = {}): TimeSettlementSourceSet {
  return {
    proof,
    population: [{ participationIdentityId: 'identity', memberId: 'member', pending: false }],
    segments: [segment()],
    latest: [allocation()],
    sourceSetHash: 'd'.repeat(64),
    ...overrides,
  };
}

describe('D4 pre-lock source validation', () => {
  function fixture() {
    const current = segment();
    const rows = [allocation(current)];
    const tx = {
      activityParticipationIdentity: {
        findMany: jest.fn().mockResolvedValue([{ id: 'identity', memberId: 'member' }]),
      },
      participantSettlementResultRevision: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ participationIdentityId: 'identity', exceptionFlagsJson: null }]),
      },
      $queryRaw: jest.fn().mockResolvedValue(rows),
    };
    const segments = {
      readActivityCurrentSegmentsTrusted: jest.fn().mockResolvedValue([current]),
    };
    const service = new ActivityTimeSettlementQueryService(
      {} as PrismaService,
      {} as ActivityTimeSettlementAccessService,
      segments as unknown as ParticipationSegmentFacade,
    );
    const read = (forLocking: boolean) =>
      forLocking
        ? service.readSourceSetInTx(tx as unknown as Prisma.TransactionClient, proof, true)
        : service.readSourceSetInTx(tx as unknown as Prisma.TransactionClient, proof);
    return { current, rows, tx, segments, read };
  }

  it('preserves the full source fingerprint when reading only lock and hash allocation fields', async () => {
    const f = fixture();
    const full = await f.read(false);
    const fields = [
      'id',
      'participationIdentityId',
      'segmentKey',
      'allocationHash',
      'ruleSnapshotId',
      'policyVersionId',
      'sliceCount',
    ] as const;
    f.tx.$queryRaw.mockResolvedValue([
      Object.fromEntries(fields.map((field) => [field, f.rows[0][field]])),
    ]);
    const beforeLocks = await f.read(true);
    expect(beforeLocks.sourceSetHash).toBe(full.sourceSetHash);
    expect(beforeLocks.population).toEqual(full.population);
    expect(beforeLocks.segments).toEqual(full.segments);
    expect(beforeLocks.latest).toEqual([
      Object.fromEntries(fields.map((field) => [field, f.rows[0][field]])),
    ]);
    expect(full.latest[0]).toHaveProperty('createdAt', f.rows[0].createdAt);
  });

  it.each([false, true])(
    'rejects duplicate source keys before returning (forLocking=%s)',
    async (mode) => {
      const f = fixture();
      f.tx.$queryRaw.mockResolvedValue([f.rows[0], { ...f.rows[0], id: 'duplicate' }]);
      await expect(f.read(mode)).rejects.toMatchObject({ reason: 'invalid' });
    },
  );

  it.each([false, true])('retains first-read date validation (forLocking=%s)', async (mode) => {
    const f = fixture();
    f.segments.readActivityCurrentSegmentsTrusted.mockResolvedValue([
      { ...f.current, checkInAt: new Date(Number.NaN) },
    ]);
    await expect(f.read(mode)).rejects.toBeInstanceOf(RangeError);
  });

  it.each([false, true])(
    'rejects slice overflow before invalid-date hashing (forLocking=%s)',
    async (mode) => {
      const f = fixture();
      f.segments.readActivityCurrentSegmentsTrusted.mockResolvedValue([
        { ...f.current, checkInAt: new Date(Number.NaN) },
      ]);
      f.rows[0].sliceCount = TIME_SETTLEMENT_LIMITS.slices + 1;
      await expect(f.read(mode)).rejects.toMatchObject({ reason: 'scale_limit' });
    },
  );

  it.each([false, true])(
    'preserves a source SQL failure identity (forLocking=%s)',
    async (mode) => {
      const f = fixture();
      const failure = new Error('fixed source read failure');
      f.tx.$queryRaw.mockRejectedValue(failure);
      await expect(f.read(mode)).rejects.toBe(failure);
    },
  );
});

describe('D4 draft proof and source readiness', () => {
  it('accepts zero revision counters and returns the complete proof without run metadata', () => {
    expect(proof).toEqual({
      activityId: 'activity',
      settlementRunId: 'run',
      settlementDraftVersionId: 'draft',
      evidenceSealId: 'seal',
      evidenceRevision: 0,
      populationRevision: 0,
      workflowRevision: 0,
      draftContentHash: 'a'.repeat(64),
    });
    expect(timeSettlementReadinessBlockers(sourceSet())).toEqual([]);
  });

  it.each<Partial<TimeSettlementDraftContext>>([
    { draftId: null },
    { draftContentHash: null },
    { evidenceSealId: null },
    { evidenceRevision: null },
    { populationRevision: null },
    { workflowRevision: null },
  ])('rejects incomplete draft evidence: %j', (patch) => {
    expect(() => requireTimeSettlementDraft('activity', { ...context, ...patch })).toThrow(
      new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY),
    );
  });

  it('rejects missing, stale and non-drafting contexts using distinct declared errors', () => {
    expect(() => requireTimeSettlementDraft('activity', null)).toThrow(
      new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY),
    );
    for (const patch of [{ sealCurrent: false }, { runStatusCode: 'submitted' }]) {
      expect(() => requireTimeSettlementDraft('activity', { ...context, ...patch })).toThrow(
        new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_STALE),
      );
    }
  });

  it.each<Partial<ParticipantTimeAllocationRevision>>([
    { sourceSegmentId: 'other' },
    { sourceSegmentRevision: 2 },
    { settlementDraftVersionId: 'other' },
    { settlementEvidenceSealId: 'other' },
    { settlementEvidenceRevision: 1 },
    { settlementPopulationRevision: 1 },
    { settlementWorkflowRevision: 1 },
    { settlementDraftContentHash: 'f'.repeat(64) },
  ])('does not reuse a stale allocation proof: %j', (patch) => {
    const stale = { ...allocation(), ...patch };
    expect(allocationMatchesTimeSettlementSource(stale, segment(), proof)).toBe(false);
    expect(timeSettlementReadinessBlockers(sourceSet({ latest: [stale] }))).toEqual([
      { code: 'allocation_required', count: 1 },
    ]);
  });

  it('keeps committed-only D3 allocations valid without granting arbitrary draft eligibility', () => {
    const old = {
      ...allocation(),
      settlementDraftVersionId: null,
      settlementEvidenceSealId: null,
      settlementEvidenceRevision: null,
      settlementPopulationRevision: null,
      settlementWorkflowRevision: null,
      settlementDraftContentHash: null,
    };
    expect(
      allocationMatchesTimeSettlementSource(old, { ...segment(), statusCode: 'committed' }, proof),
    ).toBe(true);
    expect(allocationMatchesTimeSettlementSource(old, segment(), proof)).toBe(false);
    expect(
      allocationMatchesTimeSettlementSource(
        allocation(),
        { ...segment(), statusCode: 'committed' },
        proof,
      ),
    ).toBe(false);
    expect(allocationMatchesTimeSettlementSource(undefined, segment(), proof)).toBe(false);
  });

  it('counts actual pending identities and open sources, ignoring excluded population', () => {
    const result = timeSettlementReadinessBlockers(
      sourceSet({
        population: [
          { participationIdentityId: 'identity', memberId: 'member', pending: true },
          { participationIdentityId: 'identity-2', memberId: 'member-2', pending: true },
        ],
        segments: [
          { ...segment(), checkOutAt: null },
          { ...segment('second', 'identity-2'), checkOutAt: null },
          { ...segment('excluded', 'excluded'), checkOutAt: null },
        ],
        latest: [],
      }),
    );
    expect(result).toEqual([
      { code: 'open_segment', count: 2 },
      { code: 'pending_result', count: 2 },
    ]);
  });

  it('counts missing recognition per valid closed source, not invalid or excluded sources', () => {
    const rows: CurrentParticipationSegment[] = [
      segment(),
      segment('second'),
      { ...segment('voided'), resultCode: 'voided' },
      segment('excluded', 'excluded'),
    ];
    expect(timeSettlementReadinessBlockers(sourceSet({ segments: rows, latest: [] }))).toEqual([
      { code: 'allocation_required', count: 2 },
      { code: 'overlap', count: 1 },
    ]);
  });

  it.each(['policyVersionId', 'definitionHash', 'evaluatorVersion'] as const)(
    'counts a mixed %s once per identity, not once per source',
    (field) => {
      const sources = [
        segment(),
        {
          ...segment('second'),
          checkInAt: new Date('2020-01-01T11:00:00.000Z'),
          checkOutAt: new Date('2020-01-01T12:00:00.000Z'),
        },
      ];
      const second = allocation(sources[1]);
      if (field === 'evaluatorVersion') second.evaluatorVersion = 2;
      else second[field] = 'e'.repeat(64);
      expect(
        timeSettlementReadinessBlockers(
          sourceSet({ segments: sources, latest: [allocation(), second] }),
        ),
      ).toEqual([{ code: 'policy_mixed', count: 1 }]);
    },
  );

  it('detects nested overlap across identities of the same member but permits half-open adjacency', () => {
    const a = segment();
    const b = {
      ...segment('nested', 'second'),
      checkInAt: new Date('2020-01-01T10:01:00.000Z'),
      checkOutAt: new Date('2020-01-01T10:02:00.000Z'),
    };
    const c = {
      ...segment('later'),
      checkInAt: new Date('2020-01-01T10:03:00.000Z'),
      checkOutAt: new Date('2020-01-01T10:04:00.000Z'),
    };
    const d = {
      ...segment('adjacent'),
      checkInAt: new Date('2020-01-01T11:00:00.000Z'),
      checkOutAt: new Date('2020-01-01T12:00:00.000Z'),
    };
    const sources = [d, c, b, a];
    expect(
      timeSettlementReadinessBlockers(
        sourceSet({
          population: [
            ...sourceSet().population,
            { participationIdentityId: 'second', memberId: 'member', pending: false },
          ],
          segments: sources,
          latest: sources.map(allocation),
        }),
      ),
    ).toEqual([{ code: 'overlap', count: 2 }]);
  });

  it('does not confuse the same wall-clock interval for two different members with overlap', () => {
    const sources = [segment(), { ...segment('other', 'second'), memberId: 'other-member' }];
    expect(
      timeSettlementReadinessBlockers(
        sourceSet({
          population: [
            ...sourceSet().population,
            { participationIdentityId: 'second', memberId: 'other-member', pending: false },
          ],
          segments: sources,
          latest: sources.map(allocation),
        }),
      ),
    ).toEqual([]);
  });
});

describe('D4 source-set fence', () => {
  function hash(set: TimeSettlementSourceSet): string {
    return timeSettlementSourceSetHash(set.proof, set.population, set.segments, set.latest);
  }

  it('ignores collection order but binds every current source including excluded facts', () => {
    const set = sourceSet({
      segments: [segment('z'), { ...segment('A', 'excluded'), resultCode: 'voided' }],
    });
    expect(hash(set)).toBe(hash({ ...set, segments: [...set.segments].reverse() }));
    expect(hash(set)).not.toBe(hash({ ...set, segments: set.segments.slice(0, 1) }));
  });

  it.each<Partial<TimeSettlementSourceSet>>([
    { proof: { ...proof, evidenceRevision: 1 } },
    { proof: { ...proof, populationRevision: 1 } },
    { proof: { ...proof, workflowRevision: 1 } },
    { proof: { ...proof, settlementDraftVersionId: 'new-draft' } },
    { population: [{ participationIdentityId: 'identity', memberId: 'member', pending: true }] },
    { segments: [{ ...segment(), revision: 2 }] },
    { segments: [{ ...segment(), checkOutAt: null }] },
    { latest: [{ ...allocation(), id: 'new-allocation' }] },
    { latest: [{ ...allocation(), allocationHash: 'f'.repeat(64) }] },
  ])('changes for a proof, result, segment or latest-allocation revision change', (patch) => {
    expect(hash(sourceSet(patch))).not.toBe(hash(sourceSet()));
  });

  it('rejects ambiguous duplicate latest allocation keys', () => {
    expect(() =>
      hash(sourceSet({ latest: [allocation(), { ...allocation(), id: 'duplicate' }] })),
    ).toThrow(new TimeSettlementPolicyError('invalid'));
  });
});

describe('D5 shadow transaction and explicit version query', () => {
  const actor = {
    id: 'actor',
    memberId: 'member',
    username: 'actor',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  };
  function setup() {
    const revision = {
      settlementVersionId: 'submitted',
      settlementRunId: 'run',
      kindCode: 'submitted',
      draftContentHash: 'a'.repeat(64),
      sourceSetHash: 'b'.repeat(64),
      bucketContentHash: 'c'.repeat(64),
    };
    const db = {
      activitySettlementTimeRevision: { findFirst: jest.fn().mockResolvedValue(revision) },
      attendanceSettlementVersion: {
        findFirst: jest.fn().mockResolvedValue({ contentHash: 'd'.repeat(64) }),
      },
      participantSettlementResultRevision: {
        findMany: jest.fn().mockResolvedValue(
          ['A', 'B'].map((id) => ({
            participationIdentityId: id,
            calculatedServiceHours: new Prisma.Decimal('1.00'),
            recognizedServiceHours: new Prisma.Decimal('1.00'),
            adjustmentReason: 'PRIVATE LEGACY REASON',
          })),
        ),
      },
      participantSettlementTimeBucket: {
        findMany: jest.fn().mockResolvedValue(
          ['A', 'B'].flatMap((id) =>
            TIME_SETTLEMENT_CATEGORIES.map((categoryCode) => ({
              id: id + categoryCode,
              participationIdentityId: id,
              categoryCode,
              calculatedSeconds: categoryCode === 'volunteer_service' ? 3600 : 0,
              recognizedSeconds: categoryCode === 'volunteer_service' ? 3600 : 0,
              adjustmentReason: [{ manualReason: 'PRIVATE BUCKET REASON' }],
            })),
          ),
        ),
      },
    };
    const tx = db as unknown as Prisma.TransactionClient;
    const prisma = {
      $transaction: jest.fn(
        async (work: (client: Prisma.TransactionClient) => Promise<unknown>) => await work(tx),
      ),
    };
    const access = { authorize: jest.fn().mockResolvedValue(undefined) };
    const service = new ActivityTimeSettlementQueryService(
      prisma as unknown as PrismaService,
      access as unknown as ActivityTimeSettlementAccessService,
      {} as ParticipationSegmentFacade,
    );
    return { db, tx, prisma, access, service };
  }
  it('uses one same-version bounded collection per side and rechecks authorization before returning', async () => {
    const f = setup();
    const report = await f.service.shadow('activity', 'time', { page: 1, pageSize: 1 }, actor);
    expect(f.db.activitySettlementTimeRevision.findFirst).toHaveBeenNthCalledWith(1, {
      where: { id: 'time', activityId: 'activity' },
      select: { settlementVersionId: true },
    });
    expect(f.db.activitySettlementTimeRevision.findFirst).toHaveBeenNthCalledWith(2, {
      where: { id: 'time', activityId: 'activity', kindCode: 'submitted' },
    });
    expect(f.db.attendanceSettlementVersion.findFirst).toHaveBeenCalledWith({
      where: { id: 'submitted', settlementRunId: 'run', submittedAt: { not: null } },
      select: { contentHash: true },
    });
    expect(f.db.participantSettlementResultRevision.findMany).toHaveBeenCalledTimes(1);
    expect(f.db.participantSettlementResultRevision.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { settlementVersionId: 'submitted' },
        take: 2001,
      }),
    );
    expect(f.db.participantSettlementTimeBucket.findMany).toHaveBeenCalledTimes(1);
    expect(f.db.participantSettlementTimeBucket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { timeRevisionId: 'time', activityId: 'activity' },
        take: 8001,
      }),
    );
    expect(f.access.authorize).toHaveBeenCalledTimes(2);
    expect(f.access.authorize).toHaveBeenNthCalledWith(
      1,
      f.tx,
      actor,
      'activity',
      'read',
      'submitted',
    );
    expect(f.access.authorize).toHaveBeenNthCalledWith(
      2,
      f.tx,
      actor,
      'activity',
      'read',
      'submitted',
    );
    expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 30000,
    });
    expect(report.summary).toEqual({
      total: 2,
      matched: 2,
      different: 0,
      notComparable: 0,
      empty: false,
    });
    expect(report.resultPage).toMatchObject({ total: 2, page: 1, pageSize: 1 });
    expect(report.resultPage.items).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain('PRIVATE');
    const second = await f.service.shadow('activity', 'time', { page: 2, pageSize: 1 }, actor);
    expect(second.inputFingerprint).toBe(report.inputFingerprint);
    expect(second.summary).toEqual(report.summary);
    expect(second.resultPage.items[0].participationIdentityId).toBe('B');
  });
  it('rejects loss of authorization after reading, without returning a cached report', async () => {
    const f = setup();
    f.access.authorize
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new BizException(BizCode.FORBIDDEN));
    await expect(
      f.service.shadow('activity', 'time', { page: 1, pageSize: 20 }, actor),
    ).rejects.toThrow(new BizException(BizCode.FORBIDDEN));
    expect(f.db.participantSettlementTimeBucket.findMany).toHaveBeenCalledTimes(1);
  });
  it('does not load values when initial authorization fails', async () => {
    const f = setup();
    f.access.authorize.mockRejectedValue(new BizException(BizCode.FORBIDDEN));
    await expect(
      f.service.shadow('activity', 'time', { page: 1, pageSize: 20 }, actor),
    ).rejects.toThrow(new BizException(BizCode.FORBIDDEN));
    expect(f.db.participantSettlementResultRevision.findMany).not.toHaveBeenCalled();
  });
  it.each(['revision', 'version'])(
    'rejects a missing same-chain submitted %s without consulting latest',
    async (missing) => {
      const f = setup();
      if (missing === 'revision')
        f.db.activitySettlementTimeRevision.findFirst.mockResolvedValue(null);
      else f.db.attendanceSettlementVersion.findFirst.mockResolvedValue(null);
      await expect(
        f.service.shadow('activity', 'time', { page: 1, pageSize: 20 }, actor),
      ).rejects.toThrow(new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE));
      expect(f.db.participantSettlementResultRevision.findMany).not.toHaveBeenCalled();
    },
  );
});

describe('D4 declared error mapping', () => {
  it.each([
    [new TimeSettlementPolicyError('invalid'), BizCode.ACTIVITY_TIME_SETTLEMENT_INVALID],
    [
      new TimeSettlementPolicyError('source_not_ready'),
      BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY,
    ],
    [new TimeSettlementPolicyError('policy_mixed'), BizCode.ACTIVITY_TIME_SETTLEMENT_POLICY_MIXED],
    [new TimeSettlementPolicyError('overlap'), BizCode.ACTIVITY_TIME_SETTLEMENT_OVERLAP],
    [new TimeSettlementPolicyError('scale_limit'), BizCode.ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT],
    [new RangeError('bounded'), BizCode.ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT],
    [new TypeError('invalid'), BizCode.ACTIVITY_TIME_SETTLEMENT_INVALID],
    [
      new BizException(BizCode.ACTIVITY_TIME_ALLOCATION_INVALID),
      BizCode.ACTIVITY_TIME_SETTLEMENT_INVALID,
    ],
    [
      new BizException(BizCode.ACTIVITY_TIME_ALLOCATION_REFERENCE_UNAVAILABLE),
      BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE,
    ],
    [
      new BizException(BizCode.ACTIVITY_TIME_ALLOCATION_STALE),
      BizCode.ACTIVITY_TIME_SETTLEMENT_STALE,
    ],
    [
      new BizException(BizCode.ACTIVITY_TIME_ALLOCATION_COMMAND_CONFLICT),
      BizCode.ACTIVITY_TIME_SETTLEMENT_COMMAND_CONFLICT,
    ],
    [
      new BizException(BizCode.ACTIVITY_TIME_ALLOCATION_POLICY_UNAVAILABLE),
      BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY,
    ],
  ])('maps %p to the D4 declared code', (error, code) => {
    expect(() => timeSettlementError(error)).toThrow(new BizException(code));
  });

  it('does not mask authorization errors or unexpected failures as readiness', () => {
    for (const error of [new BizException(BizCode.FORBIDDEN), new Error('storage failure')]) {
      expect(() => timeSettlementError(error)).toThrow(error);
    }
  });
});

describe('E4 time workbench contribution proof wiring', () => {
  const actor = {
    id: 'actor',
    memberId: 'member',
    username: 'actor',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  };

  function summary(pending = false): ContributionProofSummary {
    return {
      regimeCode: 'policy_v1',
      pending,
      revisionId: pending ? null : 'contribution-revision',
      sourceKindCode: pending ? null : 'time_revision',
      selectionHash: pending ? null : 'e'.repeat(64),
      sourceSetHash: pending ? null : 'd'.repeat(64),
      evaluationSetHash: pending ? null : 'f'.repeat(64),
      recognizedPointsTotal: pending ? null : '7.25',
      evaluationCount: pending ? null : 1,
      hasMore: false,
      evaluations: pending
        ? []
        : [
            {
              participationIdentityId: 'identity',
              policyVersionId: 'contribution-policy-version',
              definitionHash: 'b'.repeat(64),
              evaluatorVersion: 1,
              attendanceRoleCode: 'participant',
              timeCategoryCode: 'volunteer_service',
              durationSeconds: 3600,
              calculatedPoints: '7.25',
              recognizedPoints: '7.25',
              explanationCode: 'policy_rate',
            },
          ],
    };
  }

  // This characterizes orchestration only: no real DB, permission implementation or
  // contribution evaluator is replaced by a claim of full-chain acceptance.
  function setup(withContributions = true) {
    const db = { activitySettlementTimeRevision: { findFirst: jest.fn().mockResolvedValue(null) } };
    const tx = db as unknown as Prisma.TransactionClient;
    const prisma = {
      $transaction: jest.fn(
        async (work: (client: Prisma.TransactionClient) => Promise<unknown>) => await work(tx),
      ),
    };
    const access = { authorize: jest.fn().mockResolvedValue(undefined) };
    const contributions = { readSummaryInTx: jest.fn().mockResolvedValue(summary()) };
    const service = new ActivityTimeSettlementQueryService(
      prisma as unknown as PrismaService,
      access as unknown as ActivityTimeSettlementAccessService,
      {} as ParticipationSegmentFacade,
      withContributions
        ? (contributions as unknown as ActivityContributionSettlementQueryService)
        : undefined,
    );
    const draftContext = jest
      .spyOn(service, 'readDraftContextInTx')
      .mockResolvedValue({ ...context, contributionRegimeCode: 'policy_v1' });
    const sources = jest.spyOn(service, 'readSourceSetInTx').mockResolvedValue(sourceSet());
    const evaluate = jest.spyOn(service, 'evaluateInTx').mockResolvedValue({
      buckets: [],
      bucketCount: 0,
      sourceCount: 0,
      bucketContentHash: 'c'.repeat(64),
    });
    return { db, tx, prisma, access, contributions, service, draftContext, sources, evaluate };
  }

  it('preserves the legacy workbench shape without reading native contribution evidence', async () => {
    const f = setup();
    f.draftContext.mockResolvedValue({ ...context, contributionRegimeCode: 'legacy' });
    const result = await f.service.workbench('activity', actor);
    expect(result).toEqual({
      activityId: 'activity',
      run: {
        settlementRunId: 'run',
        statusCode: 'drafting',
        currentDraftVersion: 1,
        currentSubmittedVersion: null,
      },
      draft: {
        settlementVersionId: 'draft',
        version: 1,
        evidenceSealId: 'seal',
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        sealCurrent: true,
      },
      latestRevision: null,
      ready: true,
      blockers: [],
    });
    expect(result).not.toHaveProperty('contributionProof');
    expect(f.contributions.readSummaryInTx).not.toHaveBeenCalled();
  });

  it('passes the current draft and source anchors in the same read transaction', async () => {
    const f = setup();
    const result = await f.service.workbench('activity', actor);
    expect(f.contributions.readSummaryInTx).toHaveBeenCalledTimes(1);
    expect(f.contributions.readSummaryInTx).toHaveBeenCalledWith(f.tx, 'draft', {
      draftContentHash: 'a'.repeat(64),
      sourceSetHash: 'd'.repeat(64),
    });
    expect(result.contributionProof).toEqual(summary());
    expect(result).toMatchObject({ ready: true, blockers: [] });
    expect(f.access.authorize).toHaveBeenCalledTimes(2);
    for (const call of [1, 2])
      expect(f.access.authorize).toHaveBeenNthCalledWith(
        call,
        f.tx,
        actor,
        'activity',
        'read',
        undefined,
      );
    expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 30000,
    });
  });

  it('blocks pending or mismatched contribution evidence without presenting zero points', async () => {
    const f = setup();
    f.contributions.readSummaryInTx.mockResolvedValue(summary(true));
    const result = await f.service.workbench('activity', actor);
    expect(result).toMatchObject({
      ready: false,
      blockers: [{ code: 'contribution_pending', count: 1 }],
      contributionProof: summary(true),
    });
    expect(result.contributionProof?.recognizedPointsTotal).toBeNull();
    expect(result.contributionProof?.evaluationCount).toBeNull();
  });

  it('fails closed when the optional native proof collaborator is absent', async () => {
    const f = setup(false);
    const result = await f.service.workbench('activity', actor);
    expect(result).toMatchObject({
      ready: false,
      blockers: [{ code: 'contribution_pending', count: 1 }],
      contributionProof: summary(true),
    });
    expect(f.contributions.readSummaryInTx).not.toHaveBeenCalled();
  });

  it.each<Partial<TimeSettlementDraftContext>>([{ draftId: null }, { draftContentHash: null }])(
    'does not load an older formal proof when the native draft anchor is incomplete: %j',
    async (patch) => {
      const f = setup();
      f.draftContext.mockResolvedValue({
        ...context,
        contributionRegimeCode: 'policy_v1',
        ...patch,
      });
      const result = await f.service.workbench('activity', actor);
      expect(result).toMatchObject({
        ready: false,
        blockers: [
          { code: 'source_not_ready', count: 1 },
          { code: 'contribution_pending', count: 1 },
        ],
        contributionProof: summary(true),
      });
      expect(f.contributions.readSummaryInTx).not.toHaveBeenCalled();
      expect(f.sources).not.toHaveBeenCalled();
      expect(f.evaluate).not.toHaveBeenCalled();
    },
  );

  it('checks live source anchors for ordinary draft summaries without evaluating new points', async () => {
    const f = setup();
    await f.service.readDraftContributionSummaryInTx(f.tx, 'activity', 'draft', 'a'.repeat(64));
    expect(f.contributions.readSummaryInTx).toHaveBeenCalledWith(f.tx, 'draft', {
      draftContentHash: 'a'.repeat(64),
      sourceSetHash: 'd'.repeat(64),
    });
    expect(f.sources).toHaveBeenCalledTimes(1);
    expect(f.evaluate).not.toHaveBeenCalled();
  });

  it.each<Partial<TimeSettlementDraftContext>>([
    { draftId: 'another-draft' },
    { draftContentHash: 'changed' },
    { sealCurrent: false },
    { draftId: null },
  ])('cannot treat an unavailable current draft as a fresh proof: %j', async (patch) => {
    const f = setup();
    f.draftContext.mockResolvedValue({ ...context, contributionRegimeCode: 'policy_v1', ...patch });
    await f.service.readDraftContributionSummaryInTx(f.tx, 'activity', 'draft', 'a'.repeat(64));
    expect(f.contributions.readSummaryInTx).toHaveBeenCalledWith(f.tx, 'draft', {
      draftContentHash: 'a'.repeat(64),
      sourceSetHash: null,
    });
    expect(f.sources).not.toHaveBeenCalled();
  });

  it('passes an explicit unavailable source when a bounded source read is rejected', async () => {
    const f = setup();
    f.sources.mockRejectedValue(new TimeSettlementPolicyError('scale_limit'));
    await f.service.readDraftContributionSummaryInTx(f.tx, 'activity', 'draft', 'a'.repeat(64));
    expect(f.contributions.readSummaryInTx).toHaveBeenCalledWith(f.tx, 'draft', {
      draftContentHash: 'a'.repeat(64),
      sourceSetHash: null,
    });
    await f.service.workbench('activity', actor);
    expect(f.contributions.readSummaryInTx).toHaveBeenLastCalledWith(f.tx, 'draft', {
      draftContentHash: 'a'.repeat(64),
      sourceSetHash: null,
    });
  });

  it('does not hide an unexpected source failure in the draft summary helper', async () => {
    const f = setup();
    const failure = new Error('source read failed');
    f.sources.mockRejectedValue(failure);
    await expect(
      f.service.readDraftContributionSummaryInTx(f.tx, 'activity', 'draft', 'a'.repeat(64)),
    ).rejects.toThrow(failure);
    expect(f.contributions.readSummaryInTx).not.toHaveBeenCalled();
  });

  it('does not query evidence before the first current-eligibility check succeeds', async () => {
    const f = setup();
    f.access.authorize.mockRejectedValue(new BizException(BizCode.FORBIDDEN));
    await expect(f.service.workbench('activity', actor)).rejects.toThrow(
      new BizException(BizCode.FORBIDDEN),
    );
    expect(f.draftContext).not.toHaveBeenCalled();
    expect(f.db.activitySettlementTimeRevision.findFirst).not.toHaveBeenCalled();
    expect(f.contributions.readSummaryInTx).not.toHaveBeenCalled();
  });

  it('withholds an already loaded proof if current eligibility is lost before return', async () => {
    const f = setup();
    f.access.authorize
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new BizException(BizCode.FORBIDDEN));
    await expect(f.service.workbench('activity', actor)).rejects.toThrow(
      new BizException(BizCode.FORBIDDEN),
    );
    expect(f.contributions.readSummaryInTx).toHaveBeenCalledTimes(1);
    expect(f.access.authorize).toHaveBeenCalledTimes(2);
  });

  it('does not hide a proof query failure as pending readiness or zero points', async () => {
    const f = setup();
    const failure = new Error('bounded proof query failure');
    f.contributions.readSummaryInTx.mockRejectedValue(failure);
    await expect(f.service.workbench('activity', actor)).rejects.toThrow(failure);
    expect(f.access.authorize).toHaveBeenCalledTimes(1);
  });
});

describe('D4 historical-role reuse stays inside one evaluation', () => {
  function roleFixture() {
    const first = { ...segment('first'), sourcePositionId: 'position' };
    const second = { ...segment('second'), sourcePositionId: 'position' };
    const snapshots = [
      {
        id: 'snapshot',
        snapshotHash: 'b'.repeat(64),
        resolvedConfig: {
          sessions: [
            {
              sessionId: 'session',
              positions: [{ positionId: 'position', attendanceRoleCode: 'service' }],
            },
          ],
        },
      },
    ];
    const rows: Array<Omit<ParticipantTimeAllocationRevision, 'allocationJson'>> = [
      first,
      second,
    ].map((source) => ({ ...allocation(source), sourcePositionId: 'position' }));
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue(
        rows.map((row) => ({
          id: 'slice-' + row.id,
          allocationRevisionId: row.id,
          activityId: 'activity',
          ordinal: 0,
          categoryCode: 'volunteer_service',
          intervalKindCode: 'service_segment',
          startAt: first.checkInAt,
          endAt: first.checkOutAt,
        })),
      ),
      timePolicyVersion: { findMany: jest.fn().mockResolvedValue([]) },
      activityRuleSnapshot: { findMany: jest.fn().mockResolvedValue(snapshots) },
    };
    const access = { authorize: jest.fn() };
    const service = new ActivityTimeSettlementQueryService(
      {} as PrismaService,
      access as unknown as ActivityTimeSettlementAccessService,
      {} as ParticipationSegmentFacade,
    );
    const set = sourceSet({ segments: [first, second], latest: rows });
    return { tx, access, service, set, snapshots, rows };
  }
  it('checks pending/zero-source population before reading any physical slices', async () => {
    const f = roleFixture();
    f.set.population = Array.from({ length: 501 }, (_, i) => ({
      participationIdentityId: String(i),
      memberId: String(i),
      pending: true,
    }));
    await expect(
      f.service.evaluateInTx(f.tx as unknown as Prisma.TransactionClient, f.set, true),
    ).rejects.toThrow('scale_limit');
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  });
  it('rejects a long complete service segment even when its manual allocation slice is short', async () => {
    const f = roleFixture();
    f.set.segments = f.set.segments.map((row, i) =>
      i === 0 ? { ...row, checkOutAt: new Date('2099-01-01T00:00:00.000Z') } : row,
    );
    f.rows[0].recognitionModeCode = 'manual';
    f.rows[0].manualReason = 'split coverage';
    await expect(
      f.service.evaluateInTx(f.tx as unknown as Prisma.TransactionClient, f.set, true),
    ).rejects.toThrow('scale_limit');
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  });
  it('counts manifests belonging to invalid/excluded segments before result filtering', async () => {
    const f = roleFixture();
    f.set.population = [];
    f.rows[0].sliceCount = 2501;
    await expect(
      f.service.evaluateInTx(f.tx as unknown as Prisma.TransactionClient, f.set, true),
    ).rejects.toThrow('scale_limit');
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  });
  it('checks actual physical slices independently of an understated manifest and empty population', async () => {
    const f = roleFixture();
    f.set.population = [];
    f.rows.forEach((row) => {
      row.sliceCount = 1;
    });
    const slice = {
      allocationRevisionId: f.rows[0].id,
      ordinal: 0,
      activityId: 'activity',
      categoryCode: 'training',
      intervalKindCode: 'service_segment',
      startAt: new Date('2026-01-01'),
      endAt: new Date('2026-01-02'),
    };
    f.tx.$queryRaw.mockResolvedValue(Array.from({ length: 2501 }, () => slice));
    await expect(
      f.service.evaluateInTx(f.tx as unknown as Prisma.TransactionClient, f.set, true),
    ).rejects.toThrow('scale_limit');
    expect((f.tx.$queryRaw.mock.calls[0] as unknown[]).slice(1)).toEqual([
      f.rows.map((row) => row.id),
      TIME_SETTLEMENT_LIMITS.slices + 1,
    ]);
    expect(f.tx.timePolicyVersion.findMany).not.toHaveBeenCalled();
  });
  it('binds a single allocation array while retaining every admission field, original order and cap', async () => {
    const f = roleFixture();
    const builder = jest.spyOn(timeSettlementPolicy, 'buildTimeSettlementBuckets').mockReturnValue({
      buckets: [],
      bucketCount: 0,
      sourceCount: 0,
      bucketContentHash: 'f'.repeat(64),
    });
    try {
      await f.service.evaluateInTx(f.tx as unknown as Prisma.TransactionClient, f.set);
      expect(f.tx.$queryRaw).toHaveBeenCalledTimes(1);
      const [query, ids, cap] = f.tx.$queryRaw.mock.calls[0] as [
        TemplateStringsArray,
        string[],
        number,
      ];
      expect(query.join('').replace(/\s+/gu, ' ').trim()).toBe(
        'SELECT id, "allocationRevisionId", "activityId", ordinal, "categoryCode", "intervalKindCode", "startAt", "endAt" FROM "ParticipantTimeAllocationSlice" WHERE "allocationRevisionId" = ANY(::text[]) ORDER BY "allocationRevisionId" ASC, ordinal ASC LIMIT',
      );
      expect(ids).toEqual(f.rows.map((row) => row.id));
      expect(cap).toBe(50001);
    } finally {
      builder.mockRestore();
    }
  });

  it('retains the empty array as a bound predicate without broadening the physical slice read', async () => {
    const f = roleFixture();
    f.set.segments = [];
    f.set.latest = [];
    f.set.population = [];
    f.tx.$queryRaw.mockResolvedValue([]);
    const builder = jest.spyOn(timeSettlementPolicy, 'buildTimeSettlementBuckets').mockReturnValue({
      buckets: [],
      bucketCount: 0,
      sourceCount: 0,
      bucketContentHash: 'f'.repeat(64),
    });
    try {
      await f.service.evaluateInTx(f.tx as unknown as Prisma.TransactionClient, f.set);
      expect((f.tx.$queryRaw.mock.calls[0] as unknown[]).slice(1)).toEqual([[], 50001]);
      expect(builder.mock.calls[0][0].allocations).toEqual([]);
    } finally {
      builder.mockRestore();
    }
  });

  it('reuses a successful role while retaining all reads and full builder input', async () => {
    const f = roleFixture();
    const resolver = jest.spyOn(historicalRolePolicy, 'historicalAttendanceRoleFromRuleSnapshot');
    const builder = jest.spyOn(timeSettlementPolicy, 'buildTimeSettlementBuckets').mockReturnValue({
      buckets: [],
      bucketCount: 0,
      sourceCount: 0,
      bucketContentHash: 'f'.repeat(64),
    });
    try {
      await f.service.evaluateInTx(f.tx as unknown as Prisma.TransactionClient, f.set);
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(builder.mock.calls[0][0].allocations.map((row) => row.attendanceRoleCode)).toEqual([
        'service',
        'service',
      ]);
      expect(f.tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(f.tx.timePolicyVersion.findMany).toHaveBeenCalledTimes(1);
      expect(f.tx.activityRuleSnapshot.findMany).toHaveBeenCalledTimes(1);
      expect(f.access.authorize).not.toHaveBeenCalled();
      await f.service.evaluateInTx(f.tx as unknown as Prisma.TransactionClient, f.set);
      expect(resolver).toHaveBeenCalledTimes(2);
      expect(f.tx.activityRuleSnapshot.findMany).toHaveBeenCalledTimes(2);
    } finally {
      resolver.mockRestore();
      builder.mockRestore();
    }
  });
  it('does not borrow a role from another snapshot or hide a later malformed snapshot', async () => {
    const f = roleFixture();
    f.rows[1].ruleSnapshotId = 'other-snapshot';
    f.snapshots.push({
      id: 'other-snapshot',
      snapshotHash: 'b'.repeat(64),
      resolvedConfig: {
        sessions: [
          {
            sessionId: 'session',
            positions: [{ positionId: 'position', attendanceRoleCode: 'other-role' }],
          },
        ],
      },
    });
    const resolver = jest.spyOn(historicalRolePolicy, 'historicalAttendanceRoleFromRuleSnapshot');
    const builder = jest.spyOn(timeSettlementPolicy, 'buildTimeSettlementBuckets').mockReturnValue({
      buckets: [],
      bucketCount: 0,
      sourceCount: 0,
      bucketContentHash: 'f'.repeat(64),
    });
    try {
      await f.service.evaluateInTx(f.tx as unknown as Prisma.TransactionClient, f.set);
      expect(resolver).toHaveBeenCalledTimes(2);
      expect(builder.mock.calls[0][0].allocations.map((row) => row.attendanceRoleCode)).toEqual([
        'service',
        'other-role',
      ]);
      f.snapshots[0].resolvedConfig.sessions[0].positions = [];
      await expect(
        f.service.evaluateInTx(f.tx as unknown as Prisma.TransactionClient, f.set),
      ).rejects.toBeInstanceOf(BizException);
      expect(builder).toHaveBeenCalledTimes(1);
    } finally {
      resolver.mockRestore();
      builder.mockRestore();
    }
  });
  it('retains the null-position branch without parsing or reusing historical roles', async () => {
    const f = roleFixture();
    f.rows.forEach((row) => {
      row.sourcePositionId = null;
    });
    const resolver = jest.spyOn(historicalRolePolicy, 'historicalAttendanceRoleFromRuleSnapshot');
    const builder = jest.spyOn(timeSettlementPolicy, 'buildTimeSettlementBuckets').mockReturnValue({
      buckets: [],
      bucketCount: 0,
      sourceCount: 0,
      bucketContentHash: 'f'.repeat(64),
    });
    try {
      await f.service.evaluateInTx(f.tx as unknown as Prisma.TransactionClient, f.set);
      expect(resolver).toHaveBeenCalledTimes(2);
      expect(builder.mock.calls[0][0].allocations.map((row) => row.attendanceRoleCode)).toEqual([
        null,
        null,
      ]);
    } finally {
      resolver.mockRestore();
      builder.mockRestore();
    }
  });
});
