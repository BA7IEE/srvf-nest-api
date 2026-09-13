import { Prisma, Role, UserStatus, type ParticipantTimeAllocationRevision } from '@prisma/client';
import type { PrismaService } from '../../database/prisma.service';
import type { ParticipationSegmentFacade } from '../attendances/participation-segment.facade';
import type { ActivityTimeSettlementAccessService } from './activity-time-settlement-access.service';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { CurrentParticipationSegment } from '../attendances/participation-segment.facade';
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
