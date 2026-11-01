import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import {
  Prisma,
  type ParticipantTimeAllocationRevision,
  type ParticipantContributionEvaluation,
} from '@prisma/client';
import {
  buildActivityTimeAllocationManifest,
  buildCorrectionTimeAllocationManifest,
} from '../../src/modules/activities/activity-time-allocation-command';
import type { TimePolicyDefinition } from '../../src/modules/activities/activity-time-policy-definition';
import type { ContributionPolicyDefinition } from '../../src/modules/activities/activity-contribution-policy-definition';
import { fingerprintTimePolicyVersion } from '../../src/modules/activities/activity-time-policy-definition';
import { fingerprintContributionPolicyVersion } from '../../src/modules/activities/activity-contribution-policy-definition';
import type { ContributionSource } from '../../src/modules/activities/activity-contribution-settlement-policy';
import { evaluateSettlementContributions } from '../../src/modules/activities/activity-contribution-settlement-policy';
import {
  buildTimeSettlementBuckets,
  timeSettlementSourceSetHash,
  TIME_SETTLEMENT_CATEGORIES,
} from '../../src/modules/activities/activity-time-settlement-policy';
import type { CurrentParticipationSegment } from '../../src/modules/attendances/participation-segment.facade';
import { distributeByWeight } from '../../src/modules/activities/ledger-day-allocation';
import { CorrectionTimeAllocationService } from '../../src/modules/activities/correction-time-allocation.service';
import { parseCorrectionChangeSet } from '../../src/modules/activities/correction-change-set';
import {
  assertNativeContributionLaunchJson,
  NATIVE_CONTRIBUTION_LAUNCH_LIMITS,
} from '../../src/modules/activities/activity-contribution-launch-policy';
import { nativeLaunchSlices } from './activity-native-launch.fixture';
import { nativeLaunchV3Allocation } from './native-launch-live.fixture';

export const NATIVE_CAPACITY_SHAPE = Object.freeze({
  identities: 2000,
  segmentsPerIdentity: 5,
  slicesPerAllocation: 5,
});
export const NATIVE_CAPACITY_SOURCE_WINDOW_MS = 112000;
export const NATIVE_CAPACITY_POLICY: ContributionPolicyDefinition = {
  defaultResult: { recognizedPoints: '0.00', explanationCode: 'zero' },
  roleRules: [
    {
      attendanceRoleCode: 'service',
      categoryRules: [
        {
          timeCategoryCode: 'volunteer_service',
          durationBands: [
            { maxSecondsInclusive: null, recognizedPoints: '0.50', explanationCode: 'fixed' },
          ],
        },
      ],
    },
  ],
};
export const NATIVE_CAPACITY_TIME_POLICY: TimePolicyDefinition = {
  defaultCategory: 'volunteer_service',
  roleMappings: [],
  allowSplit: true,
  specialIntervals: {
    preparation: { mode: 'exclude' },
    duty: { mode: 'exclude' },
    travel: { mode: 'exclude' },
  },
  rounding: { mode: 'floor', quantumSeconds: 1 },
  evidence: { requiredSources: [], requireManualRecognition: false },
  manualAdjustment: { enabled: true, reasonRequired: true, evidenceRequired: false },
};
export function capacitySlices(startsAt: Date, endsAt: Date) {
  return nativeLaunchSlices(startsAt, endsAt).map((row) => {
    const categoryCode = TIME_SETTLEMENT_CATEGORIES.find((code) => code === row.categoryCode);
    assert(categoryCode);
    return { ...row, categoryCode, intervalKindCode: 'service_segment' as const };
  });
}
const cuid = (kind: string, n = 0) =>
  'c' + kind.padEnd(8, '0').slice(0, 8) + n.toString(36).padStart(16, '0');
const uuid = (kind: number, n = 0) =>
  `${kind.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const serialize = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
const json = (value: unknown): Prisma.JsonValue => JSON.parse(serialize(value));
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** Calibration only: the original pure snapshot serializer, no workflow, DB or substituted guard. */
interface SnapshotSerializer {
  snapshotSource(input: {
    segment: Pick<
      CurrentParticipationSegment,
      'id' | 'participationIdentityId' | 'segmentKey' | 'revision'
    >;
    base: ParticipantTimeAllocationRevision;
    sourceSegmentId: string;
    sourceSegmentRevision: number;
    allocationRevisionId: string;
    pendingAllocationId: string | null;
    slices: ReturnType<typeof capacitySlices>;
    allocationRevision: number;
    allocationHash: string;
    recognitionModeCode: 'manual';
    manualReason: string;
  }): Record<string, unknown>;
}

export interface NativeCapacityCalibrationContext {
  activityId: string;
  sessionId: string;
  positionId: string;
  startsAt: string;
  actorId: string;
  creatorMemberId: string;
  sessionThresholds: { lateGraceMinutes: number; earlyLeaveThresholdMinutes: number };
  selectionItemId: string;
  snapshot: {
    id: string;
    snapshotHash: string;
    workflowRevision: number;
    resolvedConfig: Prisma.JsonValue;
  };
  contributionSelection: { id: string; selectionJson: Prisma.JsonValue };
  timeSelection: { id: string; selectionHash: string };
  contribution: { policyId: string; versionId: string; definitionHash: string };
  time: { policyId: string; versionId: string; definitionHash: string };
}

/** One fixed, valid 2000×5×5 input. Values and all dimensions are frozen before measuring. */
export function fixedNativeCapacityArguments(context: NativeCapacityCalibrationContext) {
  const { activityId, sessionId, positionId, actorId } = context;
  const snapshotId = context.snapshot.id;
  const now = new Date(context.startsAt);
  const effectiveFrom = new Date('1900-01-01T00:00:00.000Z'),
    effectiveUntil = new Date('2101-01-01T00:00:00.000Z');
  const time = fingerprintTimePolicyVersion({
    schemaVersion: 1,
    evaluatorVersion: 1,
    definition: NATIVE_CAPACITY_TIME_POLICY,
    effectiveFrom: effectiveFrom.toISOString(),
    effectiveUntil: effectiveUntil.toISOString(),
  });
  const contribution = fingerprintContributionPolicyVersion({
    schemaVersion: 1,
    evaluatorVersion: 1,
    definition: NATIVE_CAPACITY_POLICY,
    effectiveFrom: effectiveFrom.toISOString(),
    effectiveUntil: effectiveUntil.toISOString(),
  });
  const proof = {
    activityId,
    settlementRunId: cuid('run'),
    settlementDraftVersionId: cuid('version'),
    evidenceSealId: cuid('seal'),
    evidenceRevision: 0,
    populationRevision: 0,
    workflowRevision: 1,
    draftContentHash: sha('fixed native draft'),
  };
  const frozenPolicy = {
    policyId: context.contribution.policyId,
    versionId: context.contribution.versionId,
    schemaVersion: 1,
    definitionJson: contribution.definition,
    definitionHash: contribution.definitionHash,
    evaluatorVersion: 1,
    effectiveFrom,
    effectiveUntil,
  };
  const timePolicy = {
    id: context.time.versionId,
    schemaVersion: 1,
    definitionJson: time.definition,
    definitionHash: time.definitionHash,
    evaluatorVersion: 1,
    effectiveFrom,
    effectiveUntil,
  };
  const population = Array.from({ length: 2000 }, (_, i) => ({
    participationIdentityId: uuid(1, i),
    memberId: i === 0 ? context.creatorMemberId : uuid(2, i),
    pending: false,
  }));
  const baseSegments: CurrentParticipationSegment[] = population.flatMap((person, i) =>
    Array.from({ length: 5 }, (_, j) => ({
      participationIdentityId: person.participationIdentityId,
      memberId: person.memberId,
      id: uuid(3, i * 5 + j),
      activityId,
      sessionId,
      sourcePositionId: positionId,
      segmentKey: String(j + 1).padStart(4, '0'),
      revision: 1,
      sourceCheckInEventId: uuid(4, (i * 5 + j) * 2),
      sourceCloseEventId: uuid(4, (i * 5 + j) * 2 + 1),
      resultCode: 'valid' as const,
      statusCode: 'draft' as const,
      checkInAt: new Date(now.getTime() + j * 23000),
      checkOutAt: new Date(now.getTime() + j * 23000 + 20000),
      lateFlag: j * 23000 > context.sessionThresholds.lateGraceMinutes * 60000,
      earlyLeaveFlag:
        j * 23000 + 20000 < 112000 - context.sessionThresholds.earlyLeaveThresholdMinutes * 60000,
      exceptionFlagsJson: { flags: ['short_service_span'] },
    })),
  );
  const serializer = Object.create(CorrectionTimeAllocationService.prototype) as SnapshotSerializer;
  const measurements: {
    dimension: keyof typeof NATIVE_CONTRIBUTION_LAUNCH_LIMITS;
    label: string;
    value: unknown;
  }[] = [];
  const add = (
    dimension: keyof typeof NATIVE_CONTRIBUTION_LAUNCH_LIMITS,
    label: string,
    value: unknown,
  ) => measurements.push({ dimension, label, value });
  add('policyBytes', 'contribution policy definition', contribution.definition);
  add('policyBytes', 'time policy definition', time.definition);
  assert.equal(time.definitionHash, context.time.definitionHash);
  assert.equal(contribution.definitionHash, context.contribution.definitionHash);
  const resolvedConfig = context.snapshot.resolvedConfig;
  add('snapshotBytes', 'resolvedConfig', resolvedConfig);
  add('snapshotBytes', 'snapshot row array', [
    { id: snapshotId, snapshotHash: context.snapshot.snapshotHash, resolvedConfig },
  ]);
  add('selectionBytes', 'frozen selection document', context.contributionSelection.selectionJson);
  let originalAllocations: ParticipantTimeAllocationRevision[] = [];
  let changedEvaluations: ReturnType<typeof evaluateSettlementContributions> | undefined;
  let changedBuckets: ReturnType<typeof buildTimeSettlementBuckets> | undefined;
  for (const changed of [false, true]) {
    const segments = baseSegments.map((row) => ({
      ...row,
      ...(changed
        ? {
            id: uuid(5, Number.parseInt(row.id.slice(-12), 16)),
            revision: 2,
            checkOutAt: new Date(row.checkOutAt!.getTime() - 1000),
          }
        : {}),
    }));
    const allocations: ParticipantTimeAllocationRevision[] = segments.map((segment, index) => {
      const slices = capacitySlices(segment.checkInAt, segment.checkOutAt!);
      const built = changed
        ? buildCorrectionTimeAllocationManifest(slices)
        : buildActivityTimeAllocationManifest(slices);
      return {
        id: uuid(changed ? 7 : 6, index),
        createdAt: now,
        activityId,
        sessionId,
        memberId: segment.memberId,
        participationIdentityId: segment.participationIdentityId,
        segmentKey: segment.segmentKey,
        revision: changed ? 2 : 1,
        previousAllocationRevisionId: changed ? uuid(6, index) : null,
        sourceSegmentId: segment.id,
        sourceSegmentRevision: segment.revision,
        sourcePositionId: positionId,
        ruleSnapshotId: snapshotId,
        ruleSnapshotHash: context.snapshot.snapshotHash,
        timePolicySelectionRevisionId: context.timeSelection.id,
        selectionHash: context.timeSelection.selectionHash,
        policyId: context.time.policyId,
        policyVersionId: timePolicy.id,
        definitionHash: time.definitionHash,
        evaluatorVersion: 1,
        settlementDraftVersionId: changed ? null : proof.settlementDraftVersionId,
        settlementEvidenceSealId: changed ? null : proof.evidenceSealId,
        settlementEvidenceRevision: changed ? null : 0,
        settlementPopulationRevision: changed ? null : 0,
        settlementWorkflowRevision: changed ? null : 1,
        settlementDraftContentHash: changed ? null : proof.draftContentHash,
        correctionPendingAllocationId: changed ? uuid(8, index) : null,
        recognitionModeCode: 'manual',
        manualReason: 'Native capacity complete allocation',
        allocationJson: json(built.manifest),
        allocationHash: built.allocationHash,
        sliceCount: 5,
        createdByUserId: actorId,
      };
    });
    if (!changed) originalAllocations = allocations;
    const slices = allocations.flatMap((allocation, index) =>
      capacitySlices(segments[index].checkInAt, segments[index].checkOutAt!).map(
        (row, ordinal) => ({
          id: uuid(9, index * 5 + ordinal),
          allocationRevisionId: allocation.id,
          activityId,
          ordinal,
          categoryCode: row.categoryCode,
          intervalKindCode: row.intervalKindCode,
          startAt: new Date(row.startAt),
          endAt: new Date(row.endAt),
        }),
      ),
    );
    const latest = allocations.map(
      ({ allocationJson, correctionPendingAllocationId, ...selected }) => {
        // These two stored columns are absent from the production sourceSet SELECT.
        void allocationJson;
        void correctionPendingAllocationId;
        return selected;
      },
    );
    const sourceSet = {
      proof,
      population,
      segments,
      latest,
      sourceSetHash: timeSettlementSourceSetHash(proof, population, segments, latest),
    };
    const timeBuckets = buildTimeSettlementBuckets({
      activityId,
      population,
      segments,
      allocations: allocations.map((row, index) => ({
        ...row,
        // This pure projection obtains the approved duration bucket values. The
        // persisted D7 rows and source snapshots below retain their separate
        // correction hash domain; do not feed that domain to the V1 validator.
        allocationHash: buildActivityTimeAllocationManifest(
          capacitySlices(segments[index].checkInAt, segments[index].checkOutAt!),
        ).allocationHash,
        recognitionModeCode: 'manual' as const,
        attendanceRoleCode: 'service',
        slices: capacitySlices(segments[index].checkInAt, segments[index].checkOutAt!),
      })),
      policies: [timePolicy],
    });
    assert.equal(timeBuckets.bucketCount, 8000);
    assert.equal(timeBuckets.sourceCount, 40000);
    if (!changed) {
      add('sourceBytes', 'time sourceSet', sourceSet);
      add('sourceBytes', 'time sourceSet plus slices', { sourceSet, slices });
      add('sourceBytes', 'evaluated time buckets', timeBuckets.buckets);
    }
    const byBucket = new Map(
      timeBuckets.buckets.map((row, index) => [
        JSON.stringify([row.participationIdentityId, row.categoryCode]),
        { ...row, id: cuid('bucket', index) },
      ]),
    );
    const joined = slices.map((row) => {
      const index = Math.floor(Number.parseInt(row.id.slice(-12), 16) / 5),
        segment = segments[index],
        allocation = allocations[index];
      const bucket = byBucket.get(
        JSON.stringify([segment.participationIdentityId, row.categoryCode]),
      );
      assert(bucket);
      return {
        bucketId: bucket.id,
        participationIdentityId: segment.participationIdentityId,
        memberId: segment.memberId,
        sessionId,
        resultCode: 'present',
        allocationRevisionId: allocation.id,
        allocationHash: allocation.allocationHash,
        ruleSnapshotId: snapshotId,
        ruleSnapshotHash: allocation.ruleSnapshotHash,
        sourcePositionId: positionId,
        sourceSegmentId: segment.id,
        sourceSegmentRevision: segment.revision,
        sliceId: changed ? `${allocation.id}:${row.ordinal}` : row.id,
        categoryCode: row.categoryCode,
        startsAt: row.startAt,
        endsAt: row.endAt,
      };
    });
    if (!changed) add('sourceBytes', 'joined contribution slice rows', joined);
    const sourceRows = changed
      ? segments.map((segment, index) =>
          serializer.snapshotSource({
            segment: baseSegments[index],
            base: originalAllocations[index],
            sourceSegmentId: segment.id,
            sourceSegmentRevision: 2,
            allocationRevisionId: allocations[index].id,
            pendingAllocationId: uuid(8, index),
            slices: capacitySlices(segment.checkInAt, segment.checkOutAt!),
            allocationRevision: 2,
            allocationHash: allocations[index].allocationHash,
            recognitionModeCode: 'manual',
            manualReason: nativeLaunchV3Allocation({
              participationIdentityId: segment.participationIdentityId,
              segmentKey: segment.segmentKey,
              baseSegmentRevisionId: baseSegments[index].id,
              baseAllocationRevisionId: originalAllocations[index].id,
              startsAt: segment.checkInAt,
              endsAt: segment.checkOutAt!,
            }).manualReason,
          }),
        )
      : [];
    if (changed) {
      add('sourceBytes', 'D7 sourceSnapshotJson from original serializer', sourceRows);
      add(
        'sourceBytes',
        'D7 calculatedBucketsJson',
        timeBuckets.buckets.map((row, index) => ({
          rootEntryId: uuid(12, index),
          participationIdentityId: row.participationIdentityId,
          categoryCode: row.categoryCode,
          recognizedSeconds: row.recognizedSeconds,
          calculatedSeconds: null,
          calculationBasis: 'approved_time_correction',
        })),
      );
    }
    const refsByBucket = new Map<string, typeof joined>();
    for (const row of joined) {
      const items = refsByBucket.get(row.bucketId) ?? [];
      items.push(row);
      refsByBucket.set(row.bucketId, items);
    }
    const sources: ContributionSource[] = [];
    for (const bucket of byBucket.values()) {
      const rows = refsByBucket.get(bucket.id) ?? [],
        weights = rows.map((row) => row.endsAt.getTime() - row.startsAt.getTime());
      const seconds = distributeByWeight(bucket.recognizedSeconds, weights);
      rows.forEach((row, index) => {
        const snapshot = changed
          ? sourceRows[Math.floor(Number.parseInt(row.sourceSegmentId.slice(-12), 16))]
          : undefined;
        const sourceHash = snapshot?.sourceHash;
        if (changed) assert(typeof sourceHash === 'string');
        const category = TIME_SETTLEMENT_CATEGORIES.find((code) => code === row.categoryCode);
        assert(category);
        sources.push({
          participationIdentityId: row.participationIdentityId,
          memberId: row.memberId,
          sessionId: row.sessionId,
          ruleSnapshotId: row.ruleSnapshotId,
          allocationRevisionId: row.allocationRevisionId,
          sliceId: row.sliceId,
          sourceSegmentId: row.sourceSegmentId,
          sourceSegmentRevision: row.sourceSegmentRevision,
          allocationHash: row.allocationHash,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          attendanceRoleCode: 'service',
          timeCategoryCode: category,
          selection: { id: context.selectionItemId, mode: 'policy', policy: frozenPolicy },
          durationSeconds: seconds[index],
          ...(changed
            ? {
                correctionSource: {
                  proofId: uuid(10),
                  pendingAllocationId: uuid(8, Number.parseInt(row.sourceSegmentId.slice(-12), 16)),
                  sourceHash: String(sourceHash),
                  sliceOrdinal: Number(row.sliceId.slice(-1)),
                },
              }
            : {}),
        });
      });
    }
    const evaluated = evaluateSettlementContributions({
      activityId,
      settlementVersionId: proof.settlementDraftVersionId,
      sourceKindCode: changed ? 'correction_time_proof' : 'time_revision',
      sources,
    });
    assert.equal(evaluated.evaluations.length, 8000);
    const fullRows: ParticipantContributionEvaluation[] = evaluated.evaluations.map(
      (row, index) => ({
        ...row,
        id: uuid(11, index),
        createdAt: now,
        contributionRevisionId: cuid('contrib'),
        activityId,
        settlementVersionId: proof.settlementDraftVersionId,
        sourceRefsJson: json(row.sourceRefsJson),
        beijingDayPointsJson: json(row.beijingDayPointsJson),
        calculatedPoints: new Prisma.Decimal(row.calculatedPoints),
        recognizedPoints: new Prisma.Decimal(row.recognizedPoints),
      }),
    );
    add(
      'evaluationBytes',
      `${changed ? 'changed' : 'base'} evaluated contribution rows`,
      evaluated.evaluations,
    );
    add('evaluationBytes', `${changed ? 'changed' : 'base'} full persisted copy rows`, fullRows);
    if (changed) {
      changedEvaluations = evaluated;
      changedBuckets = timeBuckets;
    }
  }
  assert(changedEvaluations && changedBuckets);
  const requested = {
    schemaVersion: 3,
    results: population.map((row) => ({
      participationIdentityId: row.participationIdentityId,
      resultCode: 'present',
      lateFlag: false,
      earlyLeaveFlag: false,
      recognizedServiceHours: '0.05',
      recognizedContributionPoints: '0.50',
      adjustmentReason: 'Native capacity approved fact correction',
    })),
    segments: baseSegments.map((row) => ({
      participationIdentityId: row.participationIdentityId,
      segmentKey: row.segmentKey,
      checkInAt: row.checkInAt.toISOString(),
      checkOutAt: new Date(row.checkOutAt!.getTime() - 1000).toISOString(),
      resultCode: 'valid',
      serviceHours: '0.01',
    })),
    allocations: baseSegments.map((row, index) =>
      nativeLaunchV3Allocation({
        participationIdentityId: row.participationIdentityId,
        segmentKey: row.segmentKey,
        baseSegmentRevisionId: row.id,
        baseAllocationRevisionId: originalAllocations[index].id,
        startsAt: row.checkInAt,
        endsAt: new Date(row.checkOutAt!.getTime() - 1000),
      }),
    ),
    timeCorrection: {
      baseSettlementVersionId: proof.settlementDraftVersionId,
      baseTimeLedgerHash: sha('base time ledger'),
      reason: 'Native capacity approved fact correction',
      items: changedBuckets.buckets.map((row, index) => ({
        rootEntryId: uuid(12, index),
        recognizedSeconds: row.recognizedSeconds,
      })),
    },
  };
  add('sourceBytes', 'full parsed V3 changeSet', parseCorrectionChangeSet(requested));
  add(
    'sourceBytes',
    'full parsed unchanged-time changeSet',
    parseCorrectionChangeSet({ schemaVersion: 1, results: requested.results, segments: [] }),
  );
  return {
    measurements,
    counts: {
      identities: 2000,
      segments: 10000,
      allocations: 10000,
      slices: 50000,
      buckets: 8000,
      evaluations: 8000,
    },
    fixedInputHash: sha(
      serialize({
        context,
        shape: NATIVE_CAPACITY_SHAPE,
        now,
        proof,
        policy: NATIVE_CAPACITY_POLICY,
        time: NATIVE_CAPACITY_TIME_POLICY,
        requested,
      }),
    ),
  };
}

export function measureFixedNativeCapacity(context: NativeCapacityCalibrationContext) {
  const fixed = fixedNativeCapacityArguments(context);
  const rows = fixed.measurements.map(({ dimension, label, value }) => {
    const text = serialize(value);
    assert(typeof text === 'string');
    let currentGuardAccepted = true;
    try {
      assertNativeContributionLaunchJson(value, dimension);
    } catch (error) {
      assert(error instanceof Error && error.message.includes('scale_limit'));
      currentGuardAccepted = false;
    }
    return {
      dimension,
      label,
      bytes: Buffer.byteLength(text, 'utf8'),
      sha256: sha(text),
      currentGuardAccepted,
    };
  });
  const sourceMax = Math.max(
    39298397,
    ...rows.filter((row) => row.dimension === 'sourceBytes').map((row) => row.bytes),
  );
  const evaluationMax = Math.max(
    30382573,
    ...rows.filter((row) => row.dimension === 'evaluationBytes').map((row) => row.bytes),
  );
  const padded = (maximum: number) => Math.ceil((maximum * 5) / (4 * 1024 * 1024)) * 1024 * 1024;
  return {
    counts: fixed.counts,
    fixedInputHash: fixed.fixedInputHash,
    rows,
    sourceMax,
    evaluationMax,
    sourceBytes: padded(sourceMax),
    evaluationBytes: padded(evaluationMax),
  };
}
