import type {
  ActivitySettlementTimeRevision,
  ParticipantSettlementTimeBucket,
  ParticipantSettlementTimeBucketSource,
  TimePolicyVersion,
} from '@prisma/client';
import { buildActivityTimeAllocationManifest } from './activity-time-allocation-command';
import type { ParticipantTimeAllocationDetailRow } from './activity-time-allocation.presenter';
import { fingerprintTimePolicyVersion } from './activity-time-policy-definition';
import {
  presentTimeSettlementAllocation,
  presentTimeSettlementBucket,
  presentTimeSettlementBucketSource,
  presentTimeSettlementRevision,
} from './activity-time-settlement.presenter';

const now = new Date('2020-01-01T12:00:00.000Z');
const hash = 'a'.repeat(64);

function revision(): ActivitySettlementTimeRevision {
  return {
    id: 'time-revision',
    activityId: 'activity',
    settlementRunId: 'run',
    settlementVersionId: 'version',
    revision: 2,
    previousTimeRevisionId: 'previous',
    kindCode: 'submitted',
    sourceDraftTimeRevisionId: 'prepare',
    evidenceSealId: 'seal',
    evidenceRevision: 3,
    populationRevision: 4,
    workflowRevision: 5,
    draftContentHash: hash,
    sourceSetHash: hash,
    bucketContentHash: hash,
    bucketCount: 4,
    sourceCount: 4,
    createdAt: now,
    createdByUserId: 'private-actor',
  };
}

function bucket(): ParticipantSettlementTimeBucket {
  return {
    id: 'bucket',
    timeRevisionId: 'time-revision',
    activityId: 'activity',
    participationIdentityId: 'identity',
    categoryCode: 'training',
    calculatedSeconds: null,
    recognizedSeconds: 60,
    adjustmentReason: [{ allocationRevisionId: 'allocation', manualReason: '不在列表展示的理由' }],
    timePolicyVersionId: 'policy-version',
    definitionHash: hash,
    evaluatorVersion: 1,
    quantumSeconds: 60,
    rawCalculatedMilliseconds: null,
    rawRecognizedMilliseconds: 60000n,
  };
}

function detail(): ParticipantTimeAllocationDetailRow & { policyVersion: TimePolicyVersion } {
  const policy = fingerprintTimePolicyVersion({
    schemaVersion: 1,
    evaluatorVersion: 1,
    definition: {
      defaultCategory: 'volunteer_service',
      roleMappings: [],
      allowSplit: true,
      specialIntervals: {
        preparation: { mode: 'exclude' },
        duty: { mode: 'exclude' },
        travel: { mode: 'exclude' },
      },
      rounding: { mode: 'floor', quantumSeconds: 60 },
      evidence: { requiredSources: ['service_segment'], requireManualRecognition: false },
      manualAdjustment: { enabled: true, reasonRequired: true, evidenceRequired: false },
    },
    effectiveFrom: '2019-01-01T00:00:00.000Z',
    effectiveUntil: null,
  });
  const manifest = buildActivityTimeAllocationManifest([
    {
      categoryCode: 'training',
      intervalKindCode: 'service_segment',
      startAt: '2020-01-01T10:00:00.000Z',
      endAt: '2020-01-01T11:00:00.000Z',
    },
  ]);
  return {
    id: 'allocation',
    activityId: 'activity',
    sessionId: 'session',
    memberId: 'private-member',
    participationIdentityId: 'identity',
    segmentKey: 'segment-key',
    revision: 1,
    previousAllocationRevisionId: null,
    sourceSegmentId: 'segment',
    sourceSegmentRevision: 2,
    sourcePositionId: 'position',
    ruleSnapshotId: 'snapshot',
    ruleSnapshotHash: hash,
    timePolicySelectionRevisionId: 'selection',
    selectionHash: hash,
    policyId: 'policy',
    policyVersionId: 'policy-version',
    definitionHash: policy.definitionHash,
    evaluatorVersion: 1,
    settlementDraftVersionId: 'draft',
    settlementEvidenceSealId: 'seal',
    settlementEvidenceRevision: 1,
    settlementPopulationRevision: 2,
    settlementWorkflowRevision: 3,
    settlementDraftContentHash: hash,
    recognitionModeCode: 'manual',
    manualReason: '现场证据确认培训',
    allocationJson: {
      schemaVersion: manifest.manifest.schemaVersion,
      slices: Object.fromEntries(
        Object.entries(manifest.manifest.slices).map(([key, slice]) => [key, { ...slice }]),
      ),
    },
    allocationHash: manifest.allocationHash,
    sliceCount: 1,
    createdAt: now,
    createdByUserId: 'private-actor',
    slices: [
      {
        id: 'slice',
        allocationRevisionId: 'allocation',
        activityId: 'activity',
        ordinal: 0,
        categoryCode: 'training',
        intervalKindCode: 'service_segment',
        startAt: new Date('2020-01-01T10:00:00.000Z'),
        endAt: new Date('2020-01-01T11:00:00.000Z'),
      },
    ],
    evidence: [
      {
        id: 'evidence',
        allocationRevisionId: 'allocation',
        activityId: 'activity',
        attachmentId: 'attachment',
        ordinal: 0,
      },
    ],
    policyVersion: {
      id: 'policy-version',
      policyId: 'policy',
      version: 1,
      schemaVersion: 1,
      definitionJson: {
        ...policy.definition,
        roleMappings: policy.definition.roleMappings.map((mapping) => ({ ...mapping })),
        specialIntervals: {
          preparation: { ...policy.definition.specialIntervals.preparation },
          duty: { ...policy.definition.specialIntervals.duty },
          travel: { ...policy.definition.specialIntervals.travel },
        },
        rounding: { ...policy.definition.rounding },
        evidence: { ...policy.definition.evidence },
        manualAdjustment: { ...policy.definition.manualAdjustment },
      },
      definitionHash: policy.definitionHash,
      evaluatorVersion: 1,
      effectiveFrom: new Date(policy.effectiveFrom),
      effectiveUntil: null,
      statusCode: 'retired',
      activatedAt: now,
      retiredAt: now,
      createdAt: now,
      updatedAt: now,
    },
  };
}

describe('D4 time-settlement explicit presenters', () => {
  it('returns only the declared revision fields, including the actual submitted version', () => {
    expect(presentTimeSettlementRevision(revision())).toEqual({
      timeRevisionId: 'time-revision',
      activityId: 'activity',
      settlementRunId: 'run',
      settlementVersionId: 'version',
      revision: 2,
      kindCode: 'submitted',
      sourceDraftTimeRevisionId: 'prepare',
      evidenceSealId: 'seal',
      evidenceRevision: 3,
      populationRevision: 4,
      workflowRevision: 5,
      bucketContentHash: hash,
      bucketCount: 4,
      sourceCount: 4,
      createdAt: now.toISOString(),
    });
  });

  it('keeps unknown automatic time null and hides manual reasons in the bucket page', () => {
    expect(presentTimeSettlementBucket(bucket())).toEqual({
      bucketId: 'bucket',
      timeRevisionId: 'time-revision',
      participationIdentityId: 'identity',
      categoryCode: 'training',
      calculatedSeconds: null,
      recognizedSeconds: 60,
      rawCalculatedMilliseconds: null,
      rawRecognizedMilliseconds: '60000',
      timePolicyVersionId: 'policy-version',
      definitionHash: hash,
      evaluatorVersion: 1,
      quantumSeconds: 60,
      hasAdjustment: true,
      emptyReasonCode: null,
    });
  });

  it('distinguishes an explicit empty-source zero bucket from an unknown automatic value', () => {
    const result = presentTimeSettlementBucket({
      ...bucket(),
      calculatedSeconds: 0,
      recognizedSeconds: 0,
      adjustmentReason: null,
      timePolicyVersionId: null,
      definitionHash: null,
      evaluatorVersion: null,
      quantumSeconds: null,
      rawCalculatedMilliseconds: 0n,
      rawRecognizedMilliseconds: 0n,
    });
    expect(result).toMatchObject({
      calculatedSeconds: 0,
      rawCalculatedMilliseconds: '0',
      rawRecognizedMilliseconds: '0',
      hasAdjustment: false,
      emptyReasonCode: 'no_valid_segment',
    });
  });

  it('serializes database BigInt exactly, even above the safe JavaScript integer boundary', () => {
    const large = 9007199254740993n;
    const source: ParticipantSettlementTimeBucketSource = {
      id: 'source',
      bucketId: 'bucket',
      timeRevisionId: 'time-revision',
      activityId: 'activity',
      allocationRevisionId: 'allocation',
      sourceSegmentId: 'segment',
      sourceSegmentRevision: 2,
      rawCalculatedMilliseconds: large,
      rawRecognizedMilliseconds: large + 2n,
    };
    expect(presentTimeSettlementBucketSource(source)).toEqual({
      sourceId: 'source',
      bucketId: 'bucket',
      timeRevisionId: 'time-revision',
      allocationRevisionId: 'allocation',
      sourceSegmentId: 'segment',
      sourceSegmentRevision: 2,
      rawCalculatedMilliseconds: '9007199254740993',
      rawRecognizedMilliseconds: '9007199254740995',
    });
    expect(
      presentTimeSettlementBucket({ ...bucket(), rawRecognizedMilliseconds: large }),
    ).toHaveProperty('rawRecognizedMilliseconds', '9007199254740993');
    expect(() => JSON.stringify(presentTimeSettlementBucketSource(source))).not.toThrow();
    expect(
      presentTimeSettlementBucketSource({ ...source, rawCalculatedMilliseconds: null }),
    ).toHaveProperty('rawCalculatedMilliseconds', null);
  });

  it('exposes reasons and frozen policy only on the single allocation drilldown', () => {
    const row = detail();
    const result = presentTimeSettlementAllocation(row);
    expect(result).toEqual({
      allocationRevisionId: 'allocation',
      activityId: 'activity',
      sourceSegmentId: 'segment',
      sourceSegmentRevision: 2,
      revision: 1,
      recognitionModeCode: 'manual',
      allocationHash: row.allocationHash,
      sliceCount: 1,
      createdAt: now.toISOString(),
      slices: [
        {
          categoryCode: 'training',
          intervalKindCode: 'service_segment',
          startAt: '2020-01-01T10:00:00.000Z',
          endAt: '2020-01-01T11:00:00.000Z',
        },
      ],
      evidence: [{ attachmentId: 'attachment', ordinal: 0 }],
      participationIdentityId: 'identity',
      manualReason: '现场证据确认培训',
      settlementDraftVersionId: 'draft',
      settlementEvidenceSealId: 'seal',
      policyVersionId: 'policy-version',
      definitionHash: row.definitionHash,
      evaluatorVersion: 1,
      policy: row.policyVersion.definitionJson,
      effectiveFrom: '2019-01-01T00:00:00.000Z',
      effectiveUntil: null,
    });
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(result).not.toHaveProperty('allocation');
    expect(result).not.toHaveProperty('allocationJson');
  });

  it.each(['definitionHash', 'evaluatorVersion'] as const)(
    'rejects a frozen allocation/policy %s mismatch',
    (field) => {
      const row = detail();
      if (field === 'definitionHash') row.definitionHash = 'b'.repeat(64);
      else row.evaluatorVersion = 2;
      expect(() => presentTimeSettlementAllocation(row)).toThrow(
        'time settlement frozen policy mismatch',
      );
    },
  );

  it.each([
    'slice-count',
    'slice-ordinal',
    'slice-activity',
    'slice-kind',
    'slice-hash',
    'evidence-activity',
    'evidence-parent',
    'evidence-ordinal',
  ])('fails closed on malformed children: %s', (change) => {
    const row = detail();
    if (change === 'slice-count') row.sliceCount = 2;
    if (change === 'slice-ordinal') row.slices[0].ordinal = 1;
    if (change === 'slice-activity') row.slices[0].activityId = 'other';
    if (change === 'slice-kind') row.slices[0].intervalKindCode = 'travel';
    if (change === 'slice-hash') row.allocationHash = 'b'.repeat(64);
    if (change === 'evidence-activity') row.evidence[0].activityId = 'other';
    if (change === 'evidence-parent') row.evidence[0].allocationRevisionId = 'other';
    if (change === 'evidence-ordinal') row.evidence[0].ordinal = 1;
    expect(() => presentTimeSettlementAllocation(row)).toThrow(TypeError);
  });
});
