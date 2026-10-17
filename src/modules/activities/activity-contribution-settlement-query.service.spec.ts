import type {
  ActivitySettlementContributionRevision,
  ActivitySettlementTimeRevision,
  CorrectionTimeSourceProof,
  ContributionPolicyVersion,
  Prisma,
} from '@prisma/client';
import { fingerprintMetricEnvelope } from './activity-metric-definition';
import { fingerprintContributionPolicyVersion } from './activity-contribution-policy-definition';
import * as historicalTimePolicy from './activity-time-allocation-policy';
import {
  activityContributionPolicySelectionHash,
  activityContributionPolicySelectionScopeKey,
  createActivityContributionPolicySelectionDocument,
} from './activity-contribution-policy-selection';
import {
  ActivityContributionSettlementQueryService,
  buildFrozenContributionSources,
  contributionFrozenSelection,
  type ContributionTimeSliceRow,
} from './activity-contribution-settlement-query.service';

const rootScope = { layerCode: 'activity' as const, sessionId: null, positionId: null };
const positionScope = {
  layerCode: 'position' as const,
  sessionId: 'session-one',
  positionId: 'position-one',
};

function fixture() {
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
  const policy: ContributionPolicyVersion = {
    id: 'policy-version-one',
    policyId: 'policy-one',
    version: 1,
    schemaVersion: 1,
    definitionJson: envelope.definition as unknown as Prisma.JsonValue,
    definitionHash: envelope.definitionHash,
    evaluatorVersion: 1,
    effectiveFrom,
    effectiveUntil: null,
    statusCode: 'active',
    createdByUserId: 'actor-one',
    activatedByUserId: 'approver-one',
    activatedAt: effectiveFrom,
    retiredByUserId: null,
    retiredAt: null,
    createdAt: effectiveFrom,
    updatedAt: effectiveFrom,
  };
  const pointer = {
    policyId: policy.policyId,
    versionId: policy.id,
    definitionHash: policy.definitionHash,
    evaluatorVersion: 1,
  };
  const document = createActivityContributionPolicySelectionDocument([
    { scope: rootScope, selection: { mode: 'explicit', pointer } },
  ]);
  const selectionHash = activityContributionPolicySelectionHash(document);
  const pointers = {
    schemaVersion: 1,
    selectionRevision: 1,
    proposalSelectionHash: selectionHash,
    selection: document,
    selectionRevisionId: 'selection-revision-one',
    selectionHash,
    resolved: [rootScope, positionScope].map((scope) => ({
      scope,
      pointer,
      sourceLayerCode: 'activity',
      effectiveFrom: effectiveFrom.toISOString(),
      effectiveUntil: null,
    })),
    referenceKinds: {
      [activityContributionPolicySelectionScopeKey(rootScope)]: {
        sessionRefKind: null,
        positionRefKind: null,
      },
      [activityContributionPolicySelectionScopeKey(positionScope)]: {
        sessionRefKind: 'id',
        positionRefKind: 'id',
      },
    },
  };
  const snapshot = {
    id: 'snapshot-one',
    activityId: 'activity-one',
    workflowRevision: 2,
    snapshotHash: 'a'.repeat(64),
    contributionPolicySelectionRevisionId: 'selection-revision-one',
    resolvedConfig: {
      sessions: [
        {
          sessionId: 'session-one',
          positions: [{ positionId: 'position-one', attendanceRoleCode: 'participant' }],
        },
      ],
      contributionPolicyPointers: pointers,
    } as unknown as Prisma.JsonValue,
  };
  const selection = {
    id: 'selection-revision-one',
    activityId: 'activity-one',
    revision: 1,
    selectionHash,
    selectionJson: document as unknown as Prisma.JsonValue,
    itemCount: 1,
  };
  const items = [
    {
      id: 'selection-item-one',
      selectionRevisionId: selection.id,
      activityId: snapshot.activityId,
      layerCode: 'activity',
      sessionId: null,
      positionId: null,
      mode: 'explicit',
      ...pointer,
    },
  ];
  const buckets = [
    {
      id: 'bucket-one',
      participationIdentityId: 'identity-one',
      categoryCode: 'training',
      recognizedSeconds: 60,
      rawRecognizedMilliseconds: 61_000n,
    },
  ];
  const slices: ContributionTimeSliceRow[] = [
    {
      bucketId: 'bucket-one',
      participationIdentityId: 'identity-one',
      memberId: 'member-one',
      sessionId: 'session-one',
      resultCode: 'present',
      allocationRevisionId: 'allocation-one',
      allocationHash: 'b'.repeat(64),
      ruleSnapshotId: snapshot.id,
      ruleSnapshotHash: snapshot.snapshotHash,
      sourcePositionId: 'position-one',
      sourceSegmentId: 'segment-one',
      sourceSegmentRevision: 1,
      sliceId: 'slice-one',
      categoryCode: 'training',
      startsAt: new Date('2026-10-01T01:00:00.000Z'),
      endsAt: new Date('2026-10-01T01:01:01.000Z'),
    },
  ];
  return { snapshot, selection, items, buckets, slices, policies: [policy] };
}

function build(input = fixture()) {
  return buildFrozenContributionSources({ ...input, frozen: contributionFrozenSelection(input) });
}

describe('E4 current D7 source proof query', () => {
  function correctionFixture() {
    const input = fixture(),
      slice = input.slices[0];
    const snapshots = [
      {
        participationIdentityId: slice.participationIdentityId,
        baseAllocationRevisionId: slice.allocationRevisionId,
        allocationRevisionId: 'new-allocation',
        allocationHash: 'c'.repeat(64),
        sourceSegmentId: 'new-segment',
        sourceSegmentRevision: 2,
        sourceHash: 'd'.repeat(64),
        pendingAllocationId: 'pending-one',
        sliceCount: 1,
        slices: [
          {
            ordinal: 0,
            categoryCode: 'training',
            startAt: slice.startsAt.toISOString(),
            endAt: slice.endsAt.toISOString(),
          },
        ],
      },
    ];
    const buckets = [
      {
        rootEntryId: 'root-entry-one',
        participationIdentityId: slice.participationIdentityId,
        categoryCode: 'training',
        recognizedSeconds: 60,
      },
    ];
    const proof = {
      id: 'd7-proof',
      applicationId: 'application-one',
      activityId: input.snapshot.activityId,
      settlementRunId: 'run-one',
      baseSettlementVersionId: 'base-one',
      settlementVersionId: 'new-one',
      sourceSnapshotJson: snapshots,
      calculatedBucketsJson: buckets,
      expectedSegmentCount: 1,
      expectedSliceCount: 1,
      sourceSetHash: fingerprintMetricEnvelope('correction-time-source-set-v1', snapshots)
        .definitionHash,
      calculationHash: fingerprintMetricEnvelope('correction-time-calculation-buckets-v1', buckets)
        .definitionHash,
    } as unknown as CorrectionTimeSourceProof;
    const previous = {
      activityId: input.snapshot.activityId,
      settlementRunId: 'run-one',
      settlementVersionId: 'base-one',
      ruleSnapshotId: input.snapshot.id,
      ruleSnapshotHash: input.snapshot.snapshotHash,
      selectionRevisionId: input.selection.id,
      selectionRevisionHash: input.selection.selectionHash,
    } as ActivitySettlementContributionRevision;
    const tx = {
      activityRuleSnapshot: { findFirst: jest.fn().mockResolvedValue(input.snapshot) },
      activityContributionPolicySelectionRevision: {
        findFirst: jest.fn().mockResolvedValue(input.selection),
      },
      activityContributionPolicySelectionItem: {
        findMany: jest.fn().mockResolvedValue(input.items),
      },
      contributionPolicyVersion: { findMany: jest.fn().mockResolvedValue(input.policies) },
      participantTimeAllocationRevision: {
        findMany: jest.fn().mockResolvedValue([{ id: slice.allocationRevisionId, ...slice }]),
      },
      participantSettlementResultRevision: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { participationIdentityId: slice.participationIdentityId, resultCode: 'present' },
          ]),
      },
    };
    return { input, proof, previous, tx, prismaTx: tx as unknown as Prisma.TransactionClient };
  }
  it('reads current frozen proof sources with the actual target allocation/ordinal and pending binding', async () => {
    const { proof, previous, prismaTx } = correctionFixture();
    const result =
      await new ActivityContributionSettlementQueryService().readCorrectionEvaluationInTx(
        prismaTx,
        proof,
        previous,
      );
    expect(result.evaluations[0].sourceRefsJson[0]).toMatchObject({
      allocationRevisionId: 'new-allocation',
      sliceId: 'new-allocation:0',
      durationSeconds: 60,
      correctionSource: {
        proofId: 'd7-proof',
        pendingAllocationId: 'pending-one',
        sourceHash: 'd'.repeat(64),
        sliceOrdinal: 0,
      },
    });
    expect(result.evaluations[0].recognizedPoints).toBe('0.00');
  });

  it('rejects oversized correction source JSON before fingerprinting or reading a frozen policy', async () => {
    const f = correctionFixture();
    f.proof.sourceSnapshotJson = Array.from({ length: 501 }, () => ({ slices: [] }));
    await expect(
      new ActivityContributionSettlementQueryService().readCorrectionEvaluationInTx(
        f.prismaTx,
        f.proof,
        f.previous,
        true,
      ),
    ).rejects.toThrow('scale_limit');
    expect(f.tx.activityRuleSnapshot.findFirst).not.toHaveBeenCalled();
  });
  it.each([
    'activityId',
    'settlementRunId',
    'baseSettlementVersionId',
    'sourceSetHash',
    'calculationHash',
  ] as const)('rejects wrong %s before any policy read', async (field) => {
    const { proof, previous, tx, prismaTx } = correctionFixture();
    Reflect.set(proof, field, 'other');
    await expect(
      new ActivityContributionSettlementQueryService().readCorrectionEvaluationInTx(
        prismaTx,
        proof,
        previous,
      ),
    ).rejects.toThrow();
    expect(tx.contributionPolicyVersion.findMany).not.toHaveBeenCalled();
  });
  it('rejects a frozen row whose real base allocation belongs to another identity', async () => {
    const { proof, previous, tx, prismaTx } = correctionFixture();
    tx.participantTimeAllocationRevision.findMany.mockResolvedValue([]);
    await expect(
      new ActivityContributionSettlementQueryService().readCorrectionEvaluationInTx(
        prismaTx,
        proof,
        previous,
      ),
    ).rejects.toThrow();
  });
});

describe('E4 frozen source query primitives', () => {
  it('P-Local parses one repeated session/position once per build, never across builds', () => {
    const input = fixture();
    const base = input.slices[0];
    input.slices = Array.from({ length: 5 }, (_, index) => ({
      ...base,
      sliceId: `slice-${index}`,
    }));
    input.buckets[0].recognizedSeconds = 300;
    input.buckets[0].rawRecognizedMilliseconds = 305_000n;
    const role = jest.spyOn(historicalTimePolicy, 'historicalAttendanceRoleFromRuleSnapshot');
    try {
      const original = build(input);
      expect(role).toHaveBeenCalledTimes(1);
      expect(original).toHaveLength(5);
      expect(build(input)).toEqual(original);
      expect(role).toHaveBeenCalledTimes(2);
    } finally {
      role.mockRestore();
    }
  });
  it('P-Local preserves every repeated historical-role source and the original helper result', () => {
    const input = fixture();
    const base = input.slices[0];
    input.slices = Array.from({ length: 5 }, (_, index) => ({
      ...base,
      sliceId: `slice-${index}`,
      sourceSegmentId: `segment-${index}`,
    }));
    input.buckets[0].recognizedSeconds = 300;
    input.buckets[0].rawRecognizedMilliseconds = 305_000n;
    const result = build(input);
    const expected = build(fixture())[0];
    expect(result).toEqual(
      input.slices.map((slice) => ({
        ...expected,
        sliceId: slice.sliceId,
        sourceSegmentId: slice.sourceSegmentId,
        attendanceRoleCode:
          historicalTimePolicy.historicalAttendanceRoleFromRuleSnapshot(
            input.snapshot.resolvedConfig,
            slice.sessionId,
            slice.sourcePositionId,
          ) ?? 'member',
      })),
    );
    expect(build({ ...input, slices: [...input.slices].reverse() })).toEqual(result);
  });
  it('P-Local rechecks a changed snapshot with the same id on the next invocation', () => {
    const input = fixture();
    const original = build(input);
    const config = input.snapshot.resolvedConfig;
    if (!config || typeof config !== 'object' || Array.isArray(config))
      throw new Error('invalid test fixture');
    const sessions = [
      {
        sessionId: 'session-one',
        positions: [{ positionId: 'position-one', attendanceRoleCode: 'organizer' }],
      },
    ];
    Object.assign(config, { sessions });
    expect(build(input)).toEqual([{ ...original[0], attendanceRoleCode: 'organizer' }]);
    sessions[0].positions.length = 0;
    expect(() => build(input)).toThrow();
    sessions[0].positions.push({ positionId: 'position-one', attendanceRoleCode: 'participant' });
    expect(build(input)).toEqual(original);
  });
  it('P-Local keeps null-position short-circuiting even with an invalid unused role snapshot', () => {
    const input = fixture();
    input.slices[0].sourcePositionId = null;
    const config = input.snapshot.resolvedConfig;
    if (!config || typeof config !== 'object' || Array.isArray(config))
      throw new Error('invalid test fixture');
    Object.assign(config, { sessions: null });
    expect(build(input)[0].attendanceRoleCode).toBe('member');
  });
  it('P-Local retains the original malformed-unused-position error for an assigned source', () => {
    const input = fixture();
    const config = input.snapshot.resolvedConfig;
    if (!config || typeof config !== 'object' || Array.isArray(config))
      throw new Error('invalid test fixture');
    Object.assign(config, {
      sessions: [
        {
          sessionId: 'session-one',
          positions: [
            { positionId: 'position-one', attendanceRoleCode: 'participant' },
            { positionId: 'unused-position', attendanceRoleCode: null },
          ],
        },
      ],
    });
    let originalError: unknown;
    try {
      historicalTimePolicy.historicalAttendanceRoleFromRuleSnapshot(
        input.snapshot.resolvedConfig,
        'session-one',
        'position-one',
      );
    } catch (error) {
      originalError = error;
    }
    expect(originalError).toBeInstanceOf(Error);
    if (!(originalError instanceof Error)) throw new Error('original helper must fail closed');
    expect(() => build(input)).toThrow(originalError);
  });
  it('reads published V9 selection and distributes the already rounded D4 seconds', () => {
    const input = fixture();
    const result = build(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      durationSeconds: 60,
      attendanceRoleCode: 'participant',
      timeCategoryCode: 'training',
      selection: {
        id: 'selection-item-one',
        mode: 'policy',
        policy: { versionId: input.policies[0].id },
      },
    });
    expect(result[0].endsAt.getTime() - result[0].startsAt.getTime()).toBe(61_000);
  });
  it('preserves aggregate integer seconds across two real slices instead of rounding each source', () => {
    const input = fixture();
    input.slices[0].endsAt = new Date('2026-10-01T01:00:30.500Z');
    input.slices.push({
      ...input.slices[0],
      allocationRevisionId: 'allocation-two',
      sourceSegmentId: 'segment-two',
      sliceId: 'slice-two',
      startsAt: new Date('2026-10-01T01:00:30.500Z'),
      endsAt: new Date('2026-10-01T01:01:01.000Z'),
    });
    expect(build(input).map((row) => row.durationSeconds)).toEqual([30, 30]);
    expect(build({ ...input, slices: [...input.slices].reverse() })).toEqual(build(input));
  });
  it('keeps retired approved historical policies, never substitutes today active/latest', () => {
    const input = fixture();
    input.policies[0].statusCode = 'retired';
    input.policies[0].retiredAt = new Date('2026-09-01T00:00:00.000Z');
    input.policies[0].retiredByUserId = 'retirer-one';
    expect(build(input)[0].selection.policy?.versionId).toBe(input.policies[0].id);
  });
  it('uses the original unassigned member role without querying current position or role', () => {
    const input = fixture();
    input.slices[0].sourcePositionId = null;
    expect(build(input)[0].attendanceRoleCode).toBe('member');
  });
  it('keeps a template-inherited policy and its physical root intent item', () => {
    const input = fixture();
    const document = createActivityContributionPolicySelectionDocument([
      { scope: rootScope, selection: { mode: 'inherit', pointer: null } },
    ]);
    input.selection.selectionJson = document as unknown as Prisma.JsonValue;
    input.selection.selectionHash = activityContributionPolicySelectionHash(document);
    Reflect.set(input.items[0], 'mode', 'inherit');
    for (const key of ['policyId', 'versionId', 'definitionHash', 'evaluatorVersion'])
      Reflect.set(input.items[0], key, null);
    const config = input.snapshot.resolvedConfig as unknown as {
      contributionPolicyPointers: Record<string, unknown>;
    };
    Object.assign(config.contributionPolicyPointers, {
      selection: document,
      selectionHash: input.selection.selectionHash,
      proposalSelectionHash: input.selection.selectionHash,
    });
    expect(build(input)[0].selection.id).toBe(input.items[0].id);
    expect(build(input)[0].selection.policy?.versionId).toBe(input.policies[0].id);
  });
  it('keeps an explicit zero policy even with an empty real time-source set', () => {
    const input = fixture();
    expect(build({ ...input, buckets: [], slices: [] })).toEqual([]);
    expect(() => build({ ...input, buckets: [], slices: [], policies: [] })).toThrow(
      'source_not_ready',
    );
  });
  it.each([
    [
      'missing snapshot pointer',
      (input: ReturnType<typeof fixture>) => {
        Reflect.set(input.snapshot, 'contributionPolicySelectionRevisionId', null);
      },
    ],
    [
      'null V9 envelope',
      (input: ReturnType<typeof fixture>) => {
        input.snapshot.resolvedConfig = { contributionPolicyPointers: null };
      },
    ],
    [
      'wrong selection revision',
      (input: ReturnType<typeof fixture>) => {
        input.selection.revision++;
      },
    ],
    [
      'wrong selection hash',
      (input: ReturnType<typeof fixture>) => {
        input.selection.selectionHash = 'f'.repeat(64);
      },
    ],
    [
      'cross activity selection',
      (input: ReturnType<typeof fixture>) => {
        input.selection.activityId = 'other-activity';
      },
    ],
    [
      'wrong item count',
      (input: ReturnType<typeof fixture>) => {
        input.selection.itemCount++;
      },
    ],
    [
      'missing materialized intent',
      (input: ReturnType<typeof fixture>) => {
        input.items.length = 0;
      },
    ],
    [
      'cross selection item',
      (input: ReturnType<typeof fixture>) => {
        input.items[0].selectionRevisionId = 'other-selection';
      },
    ],
    [
      'changed intent pointer',
      (input: ReturnType<typeof fixture>) => {
        input.items[0].versionId = 'other-policy';
      },
    ],
    [
      'wrong snapshot id',
      (input: ReturnType<typeof fixture>) => {
        input.slices[0].ruleSnapshotId = 'other-snapshot';
      },
    ],
    [
      'wrong snapshot hash',
      (input: ReturnType<typeof fixture>) => {
        input.slices[0].ruleSnapshotHash = 'f'.repeat(64);
      },
    ],
    [
      'wrong identity',
      (input: ReturnType<typeof fixture>) => {
        input.slices[0].participationIdentityId = 'other-identity';
      },
    ],
    [
      'wrong category',
      (input: ReturnType<typeof fixture>) => {
        input.slices[0].categoryCode = 'organization';
      },
    ],
    [
      'missing slice',
      (input: ReturnType<typeof fixture>) => {
        input.slices.length = 0;
      },
    ],
    [
      'duplicate slice',
      (input: ReturnType<typeof fixture>) => {
        input.slices.push({ ...input.slices[0] });
      },
    ],
    [
      'changed raw recognized time',
      (input: ReturnType<typeof fixture>) => {
        input.buckets[0].rawRecognizedMilliseconds++;
      },
    ],
    [
      'unknown frozen position',
      (input: ReturnType<typeof fixture>) => {
        input.slices[0].sourcePositionId = 'other-position';
      },
    ],
    [
      'unapproved policy',
      (input: ReturnType<typeof fixture>) => {
        input.policies[0].activatedAt = null;
      },
    ],
    [
      'draft policy',
      (input: ReturnType<typeof fixture>) => {
        input.policies[0].statusCode = 'draft';
      },
    ],
    [
      'changed frozen definition',
      (input: ReturnType<typeof fixture>) => {
        input.policies[0].definitionHash = 'f'.repeat(64);
      },
    ],
    [
      'changed effective evidence',
      (input: ReturnType<typeof fixture>) => {
        input.policies[0].effectiveFrom = new Date('2026-02-01T00:00:00.000Z');
      },
    ],
    [
      'duplicate version',
      (input: ReturnType<typeof fixture>) => {
        input.policies.push({ ...input.policies[0] });
      },
    ],
    [
      'absence with nonzero recognized time',
      (input: ReturnType<typeof fixture>) => {
        input.slices[0].resultCode = 'absent';
      },
    ],
  ])('fails closed on %s', (_label, mutate) => {
    const input = fixture();
    mutate(input);
    expect(() => build(input)).toThrow();
  });
  it('does not mint a fixed award for original early_departure_zero', () => {
    const input = fixture();
    input.slices[0].resultCode = 'early_departure_zero';
    input.buckets[0].recognizedSeconds = 0;
    expect(build(input)).toEqual([]);
  });
  it('bounds both actual bucket and actual slice sets before evaluation', () => {
    const input = fixture();
    expect(() =>
      build({ ...input, buckets: Array.from({ length: 8001 }, () => input.buckets[0]) }),
    ).toThrow('scale_limit');
    expect(() =>
      build({ ...input, slices: Array.from({ length: 50001 }, () => input.slices[0]) }),
    ).toThrow('scale_limit');
  });
  it('reads through the caller transaction in six collection queries, with no latest/current policy lookup', async () => {
    const input = fixture();
    const tx = {
      activityRuleSnapshot: { findUnique: jest.fn().mockResolvedValue(input.snapshot) },
      activityContributionPolicySelectionRevision: {
        findFirst: jest.fn().mockResolvedValue(input.selection),
      },
      activityContributionPolicySelectionItem: {
        findMany: jest.fn().mockResolvedValue(input.items),
      },
      participantSettlementTimeBucket: { findMany: jest.fn().mockResolvedValue(input.buckets) },
      contributionPolicyVersion: { findMany: jest.fn().mockResolvedValue(input.policies) },
      $queryRaw: jest.fn().mockResolvedValue(input.slices),
    };
    const time: ActivitySettlementTimeRevision = {
      id: 'time-one',
      activityId: 'activity-one',
      settlementRunId: 'run-one',
      settlementVersionId: 'draft-one',
      revision: 1,
      kindCode: 'draft',
      sourceDraftTimeRevisionId: null,
      previousTimeRevisionId: null,
      evidenceSealId: 'seal-one',
      evidenceRevision: 1,
      populationRevision: 1,
      workflowRevision: 2,
      draftContentHash: 'c'.repeat(64),
      sourceSetHash: 'd'.repeat(64),
      bucketContentHash: 'e'.repeat(64),
      bucketCount: 1,
      sourceCount: 1,
      createdByUserId: 'actor-one',
      createdAt: new Date('2026-10-01T01:00:00.000Z'),
    };
    const result = await new ActivityContributionSettlementQueryService().readTimeEvaluationInTx(
      tx as unknown as Prisma.TransactionClient,
      time,
    );
    expect(result).toMatchObject({
      ruleSnapshotId: input.snapshot.id,
      selectionRevisionId: input.selection.id,
      evaluationCount: 1,
      recognizedPointsTotal: '0.00',
    });
    for (const query of [
      tx.activityRuleSnapshot.findUnique,
      tx.activityContributionPolicySelectionRevision.findFirst,
      tx.activityContributionPolicySelectionItem.findMany,
      tx.participantSettlementTimeBucket.findMany,
      tx.contributionPolicyVersion.findMany,
      tx.$queryRaw,
    ])
      expect(query).toHaveBeenCalledTimes(1);
    expect(tx.contributionPolicyVersion.findMany).toHaveBeenCalledWith({
      where: { id: { in: [input.policies[0].id] } },
    });
    expect(tx.activityRuleSnapshot.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { activityId_workflowRevision: { activityId: 'activity-one', workflowRevision: 2 } },
      }),
    );
  });
});

describe('active launch facts cover the whole activity and frozen copies', () => {
  function launchFixture() {
    const input = fixture();
    const tx = {
      activityParticipationIdentity: { count: jest.fn().mockResolvedValue(500) },
      attendancePunchEvent: { count: jest.fn().mockResolvedValue(1000) },
      participantServiceSegmentRevision: {
        count: jest.fn().mockResolvedValue(500),
        findMany: jest.fn().mockResolvedValue([]),
      },
      participantTimeAllocationRevision: { count: jest.fn().mockResolvedValue(500) },
      activityRuleSnapshot: { findUnique: jest.fn().mockResolvedValue(input.snapshot) },
      activityContributionPolicySelectionRevision: {
        findFirst: jest.fn().mockResolvedValue(input.selection),
      },
      activityContributionPolicySelectionItem: {
        findMany: jest.fn().mockResolvedValue(input.items),
      },
      contributionPolicyVersion: { findMany: jest.fn().mockResolvedValue(input.policies) },
      participantContributionEvaluation: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const previous = {
      id: 'previous',
      activityId: input.snapshot.activityId,
      workflowRevision: input.snapshot.workflowRevision,
      ruleSnapshotId: input.snapshot.id,
      ruleSnapshotHash: input.snapshot.snapshotHash,
      selectionRevisionId: input.selection.id,
      selectionRevisionHash: input.selection.selectionHash,
      evaluationCount: 0,
    } as ActivitySettlementContributionRevision;
    return {
      input,
      tx,
      previous,
      service: new ActivityContributionSettlementQueryService(),
      prismaTx: tx as unknown as Prisma.TransactionClient,
    };
  }

  it('admits the whole 500 boundary and counts excluded/pending identities with no population filter', async () => {
    const f = launchFixture();
    await f.service.assertLaunchActivityInTx(f.prismaTx, 'activity-one');
    expect(f.tx.activityParticipationIdentity.count).toHaveBeenCalledWith({
      where: { activityId: 'activity-one' },
    });
    expect(f.tx.participantServiceSegmentRevision.count).toHaveBeenCalledWith({
      where: { identity: { activityId: 'activity-one' }, statusCode: { not: 'superseded' } },
    });
  });

  it('rejects 501 whole-activity identities before even collecting segment facts', async () => {
    const f = launchFixture();
    f.tx.activityParticipationIdentity.count.mockResolvedValue(501);
    await expect(f.service.assertLaunchActivityInTx(f.prismaTx, 'activity-one')).rejects.toThrow(
      'scale_limit',
    );
    expect(f.tx.participantServiceSegmentRevision.count).not.toHaveBeenCalled();
  });
  it('bounds complete current ledger spans even when they have no contribution refs', async () => {
    const f = launchFixture();
    f.tx.participantServiceSegmentRevision.findMany.mockResolvedValue([
      {
        checkInAt: new Date('2020-01-01T00:00:00.000Z'),
        checkOutAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    ]);
    await expect(f.service.assertLaunchActivityInTx(f.prismaTx, 'activity-one')).rejects.toThrow(
      'scale_limit',
    );
  });

  it('bounds current and historical segment/allocation/event costs independently of people', async () => {
    const f = launchFixture();
    f.tx.participantServiceSegmentRevision.count.mockResolvedValueOnce(501);
    await expect(f.service.assertLaunchActivityInTx(f.prismaTx, 'activity-one')).rejects.toThrow(
      'scale_limit',
    );
    f.tx.attendancePunchEvent.count.mockResolvedValue(2001);
    await expect(f.service.assertLaunchActivityInTx(f.prismaTx, 'activity-one')).rejects.toThrow(
      'scale_limit',
    );
    f.tx.attendancePunchEvent.count.mockResolvedValue(1000);
    f.tx.participantTimeAllocationRevision.count.mockResolvedValue(1001);
    await expect(f.service.assertLaunchActivityInTx(f.prismaTx, 'activity-one')).rejects.toThrow(
      'scale_limit',
    );
  });

  it('counts retained excluded segments alongside the entire regenerated draft, including batch calls', async () => {
    const f = launchFixture();
    f.tx.participantServiceSegmentRevision.count.mockResolvedValue(80);
    const segment = {
      checkInAt: new Date('2020-01-01T01:00:00.000Z'),
      checkOutAt: new Date('2020-01-01T02:00:00.000Z'),
    };
    await expect(
      f.service.assertLaunchDraftInTx(
        f.prismaTx,
        'activity-one',
        ['included'],
        Array.from({ length: 420 }, () => segment),
      ),
    ).resolves.toBeUndefined();
    await expect(
      f.service.assertLaunchDraftInTx(
        f.prismaTx,
        'activity-one',
        ['included'],
        Array.from({ length: 421 }, () => segment),
      ),
    ).rejects.toThrow('scale_limit');
    expect(f.tx.participantServiceSegmentRevision.count).toHaveBeenCalledWith({
      where: {
        identity: { activityId: 'activity-one' },
        participationIdentityId: { notIn: ['included'] },
        statusCode: { not: 'superseded' },
      },
    });
  });

  it('rejects an oversized frozen snapshot before selection parsing, including zero-source activities', async () => {
    const f = launchFixture();
    f.input.snapshot.resolvedConfig = { padding: '中'.repeat(90_000) };
    await expect(
      f.service.assertLaunchFrozenPolicyInTx(f.prismaTx, 'activity-one', 2),
    ).rejects.toThrow('scale_limit');
    expect(f.tx.activityContributionPolicySelectionItem.findMany).not.toHaveBeenCalled();
    expect(f.tx.contributionPolicyVersion.findMany).not.toHaveBeenCalled();
  });

  it('accepts a frozen zero-evaluation copy and rejects a mismatched snapshot anchor', async () => {
    const f = launchFixture();
    await expect(f.service.assertLaunchCopyInTx(f.prismaTx, f.previous)).resolves.toBeUndefined();
    f.previous.ruleSnapshotId = 'different';
    await expect(f.service.assertLaunchCopyInTx(f.prismaTx, f.previous)).rejects.toThrow(
      'source_not_ready',
    );
  });

  it('refuses a new unchanged-time correction with more than 2000 copied evaluations', async () => {
    const f = launchFixture();
    f.previous.evaluationCount = 2001;
    await expect(f.service.assertLaunchCopyInTx(f.prismaTx, f.previous)).rejects.toThrow(
      'scale_limit',
    );
    expect(f.tx.activityRuleSnapshot.findUnique).not.toHaveBeenCalled();
    expect(f.tx.participantContributionEvaluation.findMany).not.toHaveBeenCalled();
  });

  it('counts actual copied refs and long spans without recalculating awards', async () => {
    const f = launchFixture();
    f.previous.evaluationCount = 1;
    const ref = {
      sourceSegmentId: 'segment',
      allocationRevisionId: 'allocation',
      startsAt: '2026-10-01T00:00:00.000Z',
      endsAt: '2026-10-01T01:00:00.000Z',
    };
    f.tx.participantContributionEvaluation.findMany.mockResolvedValue([
      { sourceRefsJson: Array.from({ length: 2501 }, () => ref), beijingDayPointsJson: [] },
    ]);
    await expect(f.service.assertLaunchCopyInTx(f.prismaTx, f.previous)).rejects.toThrow(
      'scale_limit',
    );
    f.tx.participantContributionEvaluation.findMany.mockResolvedValue([
      {
        sourceRefsJson: [{ ...ref, endsAt: '2099-10-01T00:00:00.000Z' }],
        beijingDayPointsJson: [],
      },
    ]);
    await expect(f.service.assertLaunchCopyInTx(f.prismaTx, f.previous)).rejects.toThrow(
      'scale_limit',
    );
  });
});

describe('E4 contribution ledger day collection', () => {
  function ledgerFixture() {
    const row = {
      participationIdentityId: 'identity-one',
      sourceRefsJson: [
        {
          durationSeconds: 120,
          startsAt: '2026-10-01T15:59:00.000Z',
          endsAt: '2026-10-01T16:01:00.000Z',
        },
      ],
      beijingDayPointsJson: [
        { ledgerDate: '2026-10-01', recognizedPoints: '0.51' },
        { ledgerDate: '2026-10-02', recognizedPoints: '0.50' },
      ],
    };
    const findMany = jest.fn().mockResolvedValue([row]);
    const tx = { participantContributionEvaluation: { findMany } };
    return {
      row,
      findMany,
      read: () =>
        new ActivityContributionSettlementQueryService().readLedgerDaysInTx(
          tx as unknown as Prisma.TransactionClient,
          'proof-one',
          ['identity-one'],
        ),
    };
  }

  it('uses actual classified source starts for Beijing dates in one collection query', async () => {
    const input = ledgerFixture();
    expect((await input.read()).get('identity-one')).toEqual([
      {
        ledgerDate: new Date('2026-10-01T00:00:00.000Z'),
        recognizedPoints: '0.51',
        sequenceStartAt: new Date('2026-10-01T15:59:00.000Z'),
      },
      {
        ledgerDate: new Date('2026-10-02T00:00:00.000Z'),
        recognizedPoints: '0.50',
        sequenceStartAt: new Date('2026-10-01T16:00:00.000Z'),
      },
    ]);
    expect(input.findMany).toHaveBeenCalledTimes(1);
    expect(input.findMany.mock.calls[0]).toMatchObject([
      {
        where: {
          contributionRevisionId: 'proof-one',
          participationIdentityId: { in: ['identity-one'] },
        },
      },
    ]);
  });

  it('sums separate evaluation units without repeating service hours', async () => {
    const input = ledgerFixture();
    input.findMany.mockResolvedValue([input.row, input.row]);
    const days = (await input.read()).get('identity-one');
    expect(days?.map((day) => day.recognizedPoints)).toEqual(['1.02', '1.00']);
  });

  it.each(['2026-02-30', '2026-10-03'])(
    'rejects invalid or uncovered date %s',
    async (ledgerDate) => {
      const input = ledgerFixture();
      input.row.beijingDayPointsJson[0].ledgerDate = ledgerDate;
      await expect(input.read()).rejects.toThrow();
    },
  );

  it('rejects duplicate dates within one evaluation', async () => {
    const input = ledgerFixture();
    input.row.beijingDayPointsJson.push(input.row.beijingDayPointsJson[0]);
    await expect(input.read()).rejects.toThrow();
  });

  it('accepts an explicit zero-seconds/zero-points evaluation without inventing a day', async () => {
    const input = ledgerFixture();
    input.row.sourceRefsJson[0].durationSeconds = 0;
    input.row.beijingDayPointsJson = [];
    expect((await input.read()).get('identity-one')).toEqual([]);
  });

  it('rejects identity totals outside the result decimal range', async () => {
    const input = ledgerFixture();
    input.row.beijingDayPointsJson[0].recognizedPoints = '999.99';
    input.findMany.mockResolvedValue([input.row, input.row]);
    await expect(input.read()).rejects.toThrow();
  });
});
