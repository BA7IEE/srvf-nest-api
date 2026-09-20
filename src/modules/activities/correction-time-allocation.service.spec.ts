import { Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AttachmentsService } from '../attachments/attachments.service';
import { fingerprintMetricEnvelope } from './activity-metric-definition';
import { fingerprintTimePolicyVersion } from './activity-time-policy-definition';
import {
  activityTimePolicySelectionHash,
  createActivityTimePolicySelectionDocument,
} from './activity-time-policy-selection';
import type { CorrectionChangeSet } from './correction-change-set';
import { CorrectionTimeAllocationService } from './correction-time-allocation.service';

const activityId = 'activity-one';
const hash = (letter: string) => letter.repeat(64);
const baseStart = new Date('2026-09-16T08:00:00.000Z');
const baseEnd = new Date('2026-09-16T09:00:00.000Z');
const correctedAt = new Date('2026-09-16T10:00:00.000Z');

function fixture() {
  const definition = {
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
  const policy = fingerprintTimePolicyVersion({
    schemaVersion: 1,
    evaluatorVersion: 1,
    definition,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveUntil: null,
  });
  const pointer = {
    policyId: 'policy-one',
    versionId: 'policy-version-one',
    definitionHash: policy.definitionHash,
  };
  const selectionJson = createActivityTimePolicySelectionDocument([
    {
      scope: { layerCode: 'template', sessionId: null, positionId: null },
      selection: { mode: 'explicit', pointer },
    },
    {
      scope: { layerCode: 'activity', sessionId: null, positionId: null },
      selection: { mode: 'inherit', pointer: null },
    },
  ]);
  const selectionHash = activityTimePolicySelectionHash(selectionJson);
  const ruleSnapshot = {
    timePolicySelectionRevisionId: 'selection-one',
    snapshotHash: hash('b'),
    resolvedConfig: {
      sessions: [
        {
          sessionId: 'session-one',
          positions: [{ positionId: 'position-one', attendanceRoleCode: 'volunteer' }],
        },
      ],
    },
  };
  const policyVersion = {
    id: pointer.versionId,
    policyId: pointer.policyId,
    version: 1,
    schemaVersion: 1,
    evaluatorVersion: 1,
    definitionHash: policy.definitionHash,
    definitionJson: policy.definition,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveUntil: null,
    statusCode: 'active',
    activatedAt: new Date('2026-01-01T00:00:00.000Z'),
    retiredAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  const sourceChanged = {
    id: 'source-changed',
    participationIdentityId: 'identity-a',
    segmentKey: 'segment-a',
    revision: 1,
    checkInAt: baseStart,
    checkOutAt: baseEnd,
  };
  const sourceUnchanged = {
    id: 'source-unchanged',
    participationIdentityId: 'identity-b',
    segmentKey: 'segment-b',
    revision: 1,
    checkInAt: baseStart,
    checkOutAt: baseEnd,
  };
  const baseAllocation = (source: typeof sourceChanged, allocationId: string) => ({
    id: allocationId,
    activityId,
    sessionId: 'session-one',
    memberId: `member-${source.participationIdentityId}`,
    participationIdentityId: source.participationIdentityId,
    segmentKey: source.segmentKey,
    revision: 1,
    sourceSegmentId: source.id,
    sourceSegmentRevision: source.revision,
    sourcePositionId: 'position-one',
    settlementDraftVersionId: null,
    ruleSnapshotId: 'snapshot-one',
    ruleSnapshotHash: ruleSnapshot.snapshotHash,
    timePolicySelectionRevisionId: ruleSnapshot.timePolicySelectionRevisionId,
    selectionHash,
    policyId: pointer.policyId,
    policyVersionId: pointer.versionId,
    definitionHash: policy.definitionHash,
    evaluatorVersion: 1,
    recognitionModeCode: 'automatic',
    manualReason: null,
    allocationHash: hash('c'),
    sliceCount: 1,
    sourceSegment: { id: source.id, revision: source.revision, statusCode: 'committed' },
    ruleSnapshot,
    timePolicySelectionRevision: { selectionHash, selectionJson },
    policyVersion,
    slices: [
      {
        ordinal: 0,
        categoryCode: 'volunteer_service',
        intervalKindCode: 'service_segment',
        startAt: baseStart,
        endAt: baseEnd,
      },
    ],
  });
  const changedAllocation = baseAllocation(sourceChanged, 'allocation-changed');
  const unchangedAllocation = baseAllocation(sourceUnchanged, 'allocation-unchanged');
  const pendingSegment = {
    id: 'pending-segment-one',
    participationIdentityId: sourceChanged.participationIdentityId,
    segmentKey: sourceChanged.segmentKey,
    baseRevisionId: sourceChanged.id,
    baseRevisionNumber: sourceChanged.revision,
    targetRevisionNumber: 2,
    checkInAt: correctedAt,
    checkOutAt: correctedAt,
    resultCode: 'early_departure_zero',
    serviceHours: new Prisma.Decimal(0),
  };
  const changeSet: CorrectionChangeSet = {
    schemaVersion: 3,
    results: [],
    segments: [
      {
        participationIdentityId: sourceChanged.participationIdentityId,
        segmentKey: sourceChanged.segmentKey,
        checkInAt: correctedAt,
        checkOutAt: correctedAt,
        resultCode: 'early_departure_zero',
        serviceHours: 0,
      },
    ],
    allocations: [
      {
        participationIdentityId: sourceChanged.participationIdentityId,
        segmentKey: sourceChanged.segmentKey,
        baseSegmentRevisionId: sourceChanged.id,
        baseAllocationRevisionId: changedAllocation.id,
        recognitionModeCode: 'automatic',
        manualReason: null,
        slices: [],
        evidenceAttachmentIds: [],
      },
    ],
  };
  let pendingCreateData: unknown[] | undefined;
  let allocationCreateData: unknown[] | undefined;
  let bindingCreateData: unknown[] | undefined;
  const bindingStatementPayloads: unknown[][] = [];
  const tx = {
    $queryRaw: jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: changedAllocation.id }, { id: unchangedAllocation.id }])
      .mockResolvedValueOnce([]),
    $executeRaw: jest.fn((_strings: TemplateStringsArray, serializedRows: string) => {
      const rows: unknown = JSON.parse(serializedRows);
      if (!Array.isArray(rows)) throw new Error('binding recordset must be an array');
      bindingCreateData = rows;
      bindingStatementPayloads.push(rows);
      return rows.length;
    }),
    correctionPendingSegmentRevision: { findMany: jest.fn().mockResolvedValue([pendingSegment]) },
    participantServiceSegmentRevision: {
      findMany: jest.fn().mockResolvedValue([sourceChanged, sourceUnchanged]),
    },
    participantTimeAllocationRevision: {
      findMany: jest.fn().mockResolvedValue([changedAllocation, unchangedAllocation]),
      createMany: jest.fn(({ data }: { data: unknown[] }) => {
        allocationCreateData = data;
        return { count: data.length };
      }),
    },
    correctionPendingTimeAllocation: {
      createMany: jest.fn(({ data }: { data: unknown[] }) => {
        pendingCreateData = data;
        return { count: data.length };
      }),
      findMany: jest.fn(),
    },
    correctionPendingTimeAllocationEvidence: { createMany: jest.fn() },
    correctionApplication: { findFirst: jest.fn() },
    correctionTimeSourceProof: { findUnique: jest.fn() },
    participantTimeAllocationSlice: { createMany: jest.fn() },
    participantTimeAllocationEvidence: { createMany: jest.fn() },
    participantTimeAllocationCommandReceipt: {
      createMany: jest.fn(({ data }: { data: unknown[] }) => ({ count: data.length })),
    },
  };
  const attachments = {
    lockOwnerReferenceStorageBoundaryTrusted: jest.fn(),
    findOwnedAttachmentsTrusted: jest.fn(),
  };
  const service = new CorrectionTimeAllocationService(attachments as unknown as AttachmentsService);
  return {
    tx,
    service,
    changeSet,
    changedAllocation,
    unchangedAllocation,
    pendingCreateData: () => pendingCreateData,
    allocationCreateData: () => allocationCreateData,
    bindingCreateData: () => bindingCreateData,
    bindingStatementPayloads: () => bindingStatementPayloads,
  };
}

async function prepare(f: ReturnType<typeof fixture>) {
  return await f.service.prepare(f.tx as unknown as Prisma.TransactionClient, {
    applicationId: 'application-one',
    correctionManifestId: 'manifest-one',
    activityId,
    settlementRunId: 'run-one',
    rootManifestId: 'root-one',
    baseSettlementVersionId: 'base-version-one',
    settlementVersionId: 'settlement-version-two',
    postingBatchId: 'batch-one',
    changeSet: f.changeSet,
    calculatedBuckets: [],
  });
}

function frozenProof(prepared: Awaited<ReturnType<typeof prepare>>) {
  return {
    id: prepared.sourceProofId,
    applicationId: 'application-one',
    activityId,
    sourceSetHash: prepared.sourceProofHash,
    sourceSnapshotJson: prepared.proofData.sourceSnapshotJson,
    expectedSegmentCount: prepared.proofData.expectedSegmentCount,
    expectedPendingCount: prepared.proofData.expectedPendingCount,
    expectedSliceCount: prepared.proofData.expectedSliceCount,
    expectedBindingCount: prepared.proofData.expectedBindingCount,
    formatVersion: 1,
  };
}

describe('D7-2 full correction-time source proof', () => {
  it('freezes every effective source allocation, including unchanged segments', async () => {
    const f = fixture();

    const prepared = await prepare(f);

    expect(prepared.proofData).toMatchObject({
      expectedSegmentCount: 2,
      expectedPendingCount: 1,
      expectedBindingCount: 2,
      expectedSliceCount: 1,
    });
    const snapshots = prepared.proofData.sourceSnapshotJson as Array<Record<string, unknown>>;
    expect(snapshots).toHaveLength(2);
    const changed = snapshots.find((snapshot) => snapshot.participationIdentityId === 'identity-a');
    const unchanged = snapshots.find(
      (snapshot) => snapshot.participationIdentityId === 'identity-b',
    );
    if (!changed || !unchanged)
      throw new Error('both changed and unchanged source facts are required');
    expect(typeof changed.pendingAllocationId).toBe('string');
    expect(changed.sourceSegmentId).not.toBe('source-changed');
    expect(unchanged).toMatchObject({
      pendingAllocationId: null,
      sourceSegmentId: 'source-unchanged',
      allocationRevisionId: f.unchangedAllocation.id,
    });
    expect(f.pendingCreateData()).toEqual([expect.objectContaining({ sliceCount: 0 })]);
  });

  it('materializes the changed allocation once and writes proof bindings for both changed and unchanged sources', async () => {
    const f = fixture();
    const prepared = await prepare(f);
    const [pending] = f.pendingCreateData() ?? [];
    if (!isRecord(pending)) throw new Error('pending allocation row must be a record');
    f.tx.correctionTimeSourceProof.findUnique.mockResolvedValue({
      id: prepared.sourceProofId,
      sourceSnapshotJson: prepared.proofData.sourceSnapshotJson,
      expectedSegmentCount: prepared.proofData.expectedSegmentCount,
      expectedPendingCount: prepared.proofData.expectedPendingCount,
      expectedSliceCount: prepared.proofData.expectedSliceCount,
      expectedBindingCount: prepared.proofData.expectedBindingCount,
    });
    f.tx.correctionPendingTimeAllocation.findMany.mockResolvedValue([
      { ...pending, evidence: [], baseAllocationRevision: f.changedAllocation },
    ]);
    await expect(
      f.service.materialize(f.tx as unknown as Prisma.TransactionClient, {
        applicationId: 'application-one',
        activityId,
        actorUserId: 'reviewer-one',
      }),
    ).resolves.toBe(1);

    expect(f.allocationCreateData()).toEqual([
      expect.objectContaining({ correctionPendingAllocationId: pending.id }),
    ]);
    const bindings = f.bindingCreateData();
    if (!bindings) throw new Error('time allocation bindings were not written');
    expect(bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participationIdentityId: 'identity-a',
          pendingAllocationId: pending.id,
        }),
        expect.objectContaining({
          participationIdentityId: 'identity-b',
          pendingAllocationId: null,
          allocationRevisionId: f.unchangedAllocation.id,
          sourceSegmentId: 'source-unchanged',
        }),
      ]),
    );
  });

  it('reuses a matching frozen-proof prevalidation after the transaction re-reads its anchor', async () => {
    const f = fixture();
    const prepared = await prepare(f);
    const proof = frozenProof(prepared);
    const [pending] = f.pendingCreateData() ?? [];
    if (!isRecord(pending)) throw new Error('pending allocation row must be a record');
    f.tx.correctionApplication.findFirst.mockResolvedValue({
      id: 'application-one',
      timeSourceProof: proof,
    });

    const prevalidatedProof = await f.service.prevalidateFrozenSourceProof(
      f.tx as unknown as Prisma.TransactionClient,
      { correctionRequestId: 'request-one', activityId },
    );
    expect(prevalidatedProof).toEqual(
      expect.objectContaining({
        proofId: prepared.sourceProofId,
        sourceSetHash: prepared.sourceProofHash,
        expectedSegmentCount: 2,
      }),
    );
    if (!prevalidatedProof) throw new Error('matching proof must be prevalidated');

    const { sourceSnapshotJson, ...anchor } = proof;
    expect(sourceSnapshotJson).toBeDefined();
    f.tx.correctionTimeSourceProof.findUnique.mockResolvedValue(anchor);
    f.tx.correctionPendingTimeAllocation.findMany.mockResolvedValue([
      { ...pending, evidence: [], baseAllocationRevision: f.changedAllocation },
    ]);

    await expect(
      f.service.materialize(f.tx as unknown as Prisma.TransactionClient, {
        applicationId: 'application-one',
        activityId,
        actorUserId: 'reviewer-one',
        prevalidatedProof,
      }),
    ).resolves.toBe(1);

    expect(f.tx.correctionTimeSourceProof.findUnique).toHaveBeenCalledTimes(1);
    const [anchorRead] = f.tx.correctionTimeSourceProof.findUnique.mock.calls[0] as [
      { select: Record<string, unknown> },
    ];
    expect(anchorRead.select.sourceSnapshotJson).toBeUndefined();
  });

  it('falls back to the original full proof validation when the transaction anchor differs', async () => {
    const f = fixture();
    const prepared = await prepare(f);
    const proof = frozenProof(prepared);
    const [pending] = f.pendingCreateData() ?? [];
    if (!isRecord(pending)) throw new Error('pending allocation row must be a record');
    f.tx.correctionApplication.findFirst.mockResolvedValue({
      id: 'application-one',
      timeSourceProof: proof,
    });
    const prevalidatedProof = await f.service.prevalidateFrozenSourceProof(
      f.tx as unknown as Prisma.TransactionClient,
      { correctionRequestId: 'request-one', activityId },
    );
    if (!prevalidatedProof) throw new Error('matching proof must be prevalidated');

    const { sourceSnapshotJson, ...staleAnchor } = proof;
    expect(sourceSnapshotJson).toBeDefined();
    f.tx.correctionTimeSourceProof.findUnique
      .mockResolvedValueOnce({ ...staleAnchor, sourceSetHash: hash('d') })
      .mockResolvedValueOnce(proof);
    f.tx.correctionPendingTimeAllocation.findMany.mockResolvedValue([
      { ...pending, evidence: [], baseAllocationRevision: f.changedAllocation },
    ]);

    await expect(
      f.service.materialize(f.tx as unknown as Prisma.TransactionClient, {
        applicationId: 'application-one',
        activityId,
        actorUserId: 'reviewer-one',
        prevalidatedProof,
      }),
    ).resolves.toBe(1);

    expect(f.tx.correctionTimeSourceProof.findUnique).toHaveBeenCalledTimes(2);
    const [fullRead] = f.tx.correctionTimeSourceProof.findUnique.mock.calls[1] as [
      { select: Record<string, unknown> },
    ];
    expect(fullRead.select.sourceSnapshotJson).toBe(true);
  });

  it('leaves historical replay on its original path when the future proof table is absent', async () => {
    const f = fixture();
    f.tx.correctionApplication.findFirst.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('missing future proof table', {
        code: 'P2021',
        clientVersion: 'test',
      }),
    );

    await expect(
      f.service.prevalidateFrozenSourceProof(f.tx as unknown as Prisma.TransactionClient, {
        correctionRequestId: 'request-one',
        activityId,
      }),
    ).resolves.toBeUndefined();
  });

  it('fails closed when the one-statement binding write reports an incomplete count', async () => {
    const f = fixture();
    const prepared = await prepare(f);
    const [pending] = f.pendingCreateData() ?? [];
    if (!isRecord(pending)) throw new Error('pending allocation row must be a record');
    f.tx.correctionTimeSourceProof.findUnique.mockResolvedValue({
      id: prepared.sourceProofId,
      sourceSnapshotJson: prepared.proofData.sourceSnapshotJson,
      expectedSegmentCount: prepared.proofData.expectedSegmentCount,
      expectedPendingCount: prepared.proofData.expectedPendingCount,
      expectedSliceCount: prepared.proofData.expectedSliceCount,
      expectedBindingCount: prepared.proofData.expectedBindingCount,
    });
    f.tx.correctionPendingTimeAllocation.findMany.mockResolvedValue([
      { ...pending, evidence: [], baseAllocationRevision: f.changedAllocation },
    ]);
    f.tx.$executeRaw.mockReturnValueOnce(1);

    await expect(
      f.service.materialize(f.tx as unknown as Prisma.TransactionClient, {
        applicationId: 'application-one',
        activityId,
        actorUserId: 'reviewer-one',
      }),
    ).rejects.toThrow(new BizException(BizCode.CORRECTION_CHANGE_SET_INVALID));
  });

  it('materializes all 10,000 immutable source bindings in one parameterized statement without dropping facts', async () => {
    const f = fixture();
    const prepared = await prepare(f);
    const [pending] = f.pendingCreateData() ?? [];
    if (!isRecord(pending)) throw new Error('pending allocation row must be a record');
    const snapshots = prepared.proofData.sourceSnapshotJson as Array<Record<string, unknown>>;
    const unchanged = snapshots.find(
      (snapshot) => snapshot.participationIdentityId === 'identity-b',
    );
    if (!unchanged) throw new Error('unchanged source fact is required');
    const additions = Array.from({ length: 9998 }, (_, index) => {
      const suffix = String(index).padStart(4, '0');
      const sourceWithoutHash = { ...unchanged };
      delete sourceWithoutHash.sourceHash;
      const source = {
        ...sourceWithoutHash,
        participationIdentityId: `identity-c-${suffix}`,
        segmentKey: `segment-c-${suffix}`,
        baseSegmentRevisionId: `base-c-${suffix}`,
        sourceSegmentId: `source-c-${suffix}`,
        baseAllocationRevisionId: `allocation-base-c-${suffix}`,
        allocationRevisionId: `allocation-target-c-${suffix}`,
        pendingAllocationId: null,
        sliceCount: 0,
        slices: [],
      };
      return {
        ...source,
        sourceHash: fingerprintMetricEnvelope('correction-time-source-row-v1', source)
          .definitionHash,
      };
    });
    const expandedSnapshots = [...snapshots, ...additions];
    f.tx.correctionTimeSourceProof.findUnique.mockResolvedValue({
      id: prepared.sourceProofId,
      sourceSnapshotJson: expandedSnapshots,
      expectedSegmentCount: expandedSnapshots.length,
      expectedPendingCount: prepared.proofData.expectedPendingCount,
      expectedSliceCount: prepared.proofData.expectedSliceCount,
      expectedBindingCount: expandedSnapshots.length,
    });
    f.tx.correctionPendingTimeAllocation.findMany.mockResolvedValue([
      { ...pending, evidence: [], baseAllocationRevision: f.changedAllocation },
    ]);

    await expect(
      f.service.materialize(f.tx as unknown as Prisma.TransactionClient, {
        applicationId: 'application-one',
        activityId,
        actorUserId: 'reviewer-one',
      }),
    ).resolves.toBe(1);

    const statements = f.bindingStatementPayloads();
    expect(expandedSnapshots).toHaveLength(10_000);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toHaveLength(expandedSnapshots.length);
    expect(f.tx.$executeRaw).toHaveBeenCalledTimes(1);
    const [template, serializedRows] = f.tx.$executeRaw.mock.calls[0];
    expect(template.join(' ')).toContain('jsonb_to_recordset');
    expect(typeof serializedRows).toBe('string');
    const identityIds = statements[0].map((row) => {
      if (!isRecord(row) || typeof row.participationIdentityId !== 'string') {
        throw new Error('binding identity must be materialized');
      }
      return row.participationIdentityId;
    });
    expect(identityIds).toHaveLength(expandedSnapshots.length);
    expect(new Set(identityIds).size).toBe(expandedSnapshots.length);
    expect(identityIds).toContain('identity-c-0999');
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
