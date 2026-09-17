import { Prisma } from '@prisma/client';
import type { AttachmentsService } from '../attachments/attachments.service';
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
  const tx = {
    $queryRaw: jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: changedAllocation.id }, { id: unchangedAllocation.id }])
      .mockResolvedValueOnce([]),
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
    correctionTimeSourceProof: { findUnique: jest.fn() },
    participantTimeAllocationSlice: { createMany: jest.fn() },
    participantTimeAllocationEvidence: { createMany: jest.fn() },
    participantTimeAllocationCommandReceipt: {
      createMany: jest.fn(({ data }: { data: unknown[] }) => ({ count: data.length })),
    },
    correctionTimeAllocationBinding: {
      createMany: jest.fn(({ data }: { data: unknown[] }) => {
        bindingCreateData = data;
        return { count: data.length };
      }),
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
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
