import { Injectable } from '@nestjs/common';
import { parseDateOnlyStrict, splitSpanByBeijingDay } from '../../common/datetime/date-only.util';
import type {
  ActivityContributionPolicySelectionItem,
  ActivityContributionPolicySelectionRevision,
  ActivityRuleSnapshot,
  ActivitySettlementTimeRevision,
  ActivitySettlementContributionRevision,
  CorrectionTimeSourceProof,
  ContributionPolicyVersion,
  ParticipantSettlementTimeBucket,
  Prisma,
} from '@prisma/client';
import { historicalAttendanceRoleFromRuleSnapshot } from './activity-time-allocation-policy';
import {
  activityContributionPolicySelectionHash,
  activityContributionPolicySelectionScopeKey,
  createActivityContributionPolicySelectionDocument,
  parseActivityContributionPolicySelectionItem,
  parseActivityContributionPolicySelectionDocument,
} from './activity-contribution-policy-selection';
import {
  prepareContributionPolicyVersion,
  CONTRIBUTION_TIME_CATEGORY_CODES,
} from './activity-contribution-policy-definition';
import { parseActivityRuleSnapshotV9ContributionPolicyPointers } from './activity-publish-proposal-v9';
import {
  ContributionSettlementPolicyError,
  evaluateSettlementContributions,
  type ContributionFrozenPolicy,
  type ContributionSource,
} from './activity-contribution-settlement-policy';
import { TIME_SETTLEMENT_LIMITS } from './activity-time-settlement-policy';
import { fingerprintMetricEnvelope } from './activity-metric-definition';
import { presentContributionProof } from './activity-contribution-settlement-presenter';
import {
  decimalToHundredths,
  distributeByWeight,
  type NativeContributionDay,
} from './ledger-day-allocation';

type Snapshot = Pick<
  ActivityRuleSnapshot,
  | 'id'
  | 'activityId'
  | 'workflowRevision'
  | 'snapshotHash'
  | 'resolvedConfig'
  | 'contributionPolicySelectionRevisionId'
>;
type Selection = Pick<
  ActivityContributionPolicySelectionRevision,
  'id' | 'activityId' | 'revision' | 'selectionHash' | 'selectionJson' | 'itemCount'
>;
type Bucket = Pick<
  ParticipantSettlementTimeBucket,
  | 'id'
  | 'participationIdentityId'
  | 'categoryCode'
  | 'recognizedSeconds'
  | 'rawRecognizedMilliseconds'
>;

/** One actual D4 source slice, read through the frozen bucket/allocation composite chain. */
export interface ContributionTimeSliceRow {
  bucketId: string;
  participationIdentityId: string;
  memberId: string;
  sessionId: string;
  resultCode: string;
  allocationRevisionId: string;
  allocationHash: string;
  ruleSnapshotId: string;
  ruleSnapshotHash: string;
  sourcePositionId: string | null;
  sourceSegmentId: string;
  sourceSegmentRevision: number;
  sliceId: string;
  categoryCode: string;
  startsAt: Date;
  endsAt: Date;
  correctionSource?: ContributionSource['correctionSource'];
}

function unavailable(): never {
  throw new ContributionSettlementPolicyError('source_not_ready');
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return unavailable();
  return value as Record<string, unknown>;
}

/**
 * Freeze only published V9 resolution, never the Activity current pointer or a fresh resolver.
 * These checks deliberately include zero-source cases: missing configuration is not zero policy.
 */
export function contributionFrozenSelection(input: {
  snapshot: Snapshot;
  selection: Selection;
  items: readonly ActivityContributionPolicySelectionItem[];
}) {
  const { snapshot, selection, items } = input;
  const pointers = parseActivityRuleSnapshotV9ContributionPolicyPointers(
    record(snapshot.resolvedConfig).contributionPolicyPointers,
  );
  if (
    !pointers ||
    snapshot.contributionPolicySelectionRevisionId !== selection.id ||
    pointers.selectionRevisionId !== selection.id ||
    pointers.selectionRevision !== selection.revision ||
    pointers.selectionHash !== selection.selectionHash ||
    selection.activityId !== snapshot.activityId ||
    items.length !== selection.itemCount ||
    new Set(items.map((item) => item.id)).size !== items.length
  )
    return unavailable();
  const stored = parseActivityContributionPolicySelectionDocument(selection.selectionJson);
  if (activityContributionPolicySelectionHash(stored) !== selection.selectionHash)
    return unavailable();
  const byScope = new Map<string, ActivityContributionPolicySelectionItem>();
  const document = createActivityContributionPolicySelectionDocument(
    items.map((item) => {
      if (item.activityId !== snapshot.activityId || item.selectionRevisionId !== selection.id)
        return unavailable();
      const parsed = parseActivityContributionPolicySelectionItem({
        scope: {
          layerCode: item.layerCode,
          sessionId: item.sessionId,
          positionId: item.positionId,
        },
        selection: {
          mode: item.mode,
          pointer:
            item.mode === 'inherit'
              ? null
              : {
                  policyId: item.policyId,
                  versionId: item.versionId,
                  definitionHash: item.definitionHash,
                  evaluatorVersion: item.evaluatorVersion,
                },
        },
      });
      if (
        item.mode === 'inherit' &&
        [item.policyId, item.versionId, item.definitionHash, item.evaluatorVersion].some(
          (value) => value !== null,
        )
      )
        return unavailable();
      byScope.set(activityContributionPolicySelectionScopeKey(parsed.scope), item);
      return parsed;
    }),
  );
  if (activityContributionPolicySelectionHash(document) !== selection.selectionHash)
    return unavailable();
  const resolved = new Map(
    pointers.resolved.map((item) => [
      activityContributionPolicySelectionScopeKey(item.scope),
      item,
    ]),
  );
  const rootKey = activityContributionPolicySelectionScopeKey({
    layerCode: 'activity',
    sessionId: null,
    positionId: null,
  });
  if (!resolved.has(rootKey) || !byScope.has(rootKey)) return unavailable();
  return { pointers, resolved, byScope, rootKey };
}

/**
 * D4 has already applied its quantum/rounding once per identity/category. Distribute those
 * recognized integer seconds over actual matching slices; never infer them from legacy hours.
 */
export function buildFrozenContributionSources(input: {
  snapshot: Snapshot;
  frozen: ReturnType<typeof contributionFrozenSelection>;
  buckets: readonly Bucket[];
  slices: readonly ContributionTimeSliceRow[];
  policies: readonly ContributionPolicyVersion[];
}): ContributionSource[] {
  if (
    input.buckets.length > TIME_SETTLEMENT_LIMITS.buckets ||
    input.slices.length > TIME_SETTLEMENT_LIMITS.slices
  )
    throw new ContributionSettlementPolicyError('scale_limit');
  const byPolicy = new Map<string, ContributionFrozenPolicy>();
  for (const policy of input.policies) {
    if (
      byPolicy.has(policy.id) ||
      (policy.statusCode !== 'active' && policy.statusCode !== 'retired') ||
      !policy.activatedByUserId ||
      !policy.activatedAt
    )
      return unavailable();
    const prepared = prepareContributionPolicyVersion({
      schemaVersion: policy.schemaVersion,
      evaluatorVersion: policy.evaluatorVersion,
      definition: policy.definitionJson,
      effectiveFrom: policy.effectiveFrom.toISOString(),
      effectiveUntil: policy.effectiveUntil?.toISOString() ?? null,
    });
    if (prepared.definitionHash !== policy.definitionHash) return unavailable();
    byPolicy.set(policy.id, { ...policy, versionId: policy.id });
  }
  // A zero population still has a real frozen root selection and approved policy.
  for (const resolved of input.frozen.resolved.values()) {
    const policy = byPolicy.get(resolved.pointer.versionId);
    if (
      !policy ||
      policy.policyId !== resolved.pointer.policyId ||
      policy.definitionHash !== resolved.pointer.definitionHash ||
      policy.evaluatorVersion !== resolved.pointer.evaluatorVersion ||
      policy.effectiveFrom.toISOString() !== resolved.effectiveFrom ||
      (policy.effectiveUntil?.toISOString() ?? null) !== resolved.effectiveUntil
    )
      return unavailable();
  }
  const bucketIds = new Set(input.buckets.map((bucket) => bucket.id));
  if (bucketIds.size !== input.buckets.length) return unavailable();
  const slicesByBucket = new Map<string, ContributionTimeSliceRow[]>();
  const seenSlices = new Set<string>();
  for (const slice of input.slices) {
    if (
      !bucketIds.has(slice.bucketId) ||
      seenSlices.has(slice.sliceId) ||
      slice.ruleSnapshotId !== input.snapshot.id ||
      slice.ruleSnapshotHash !== input.snapshot.snapshotHash ||
      !(slice.startsAt instanceof Date) ||
      !(slice.endsAt instanceof Date) ||
      !Number.isSafeInteger(slice.endsAt.getTime() - slice.startsAt.getTime()) ||
      slice.endsAt < slice.startsAt
    )
      return unavailable();
    seenSlices.add(slice.sliceId);
    const rows = slicesByBucket.get(slice.bucketId) ?? [];
    rows.push(slice);
    slicesByBucket.set(slice.bucketId, rows);
  }
  // Only successful historical parsing is reused, inside this synchronous build and snapshot.
  // Separate session/position maps avoid ambiguous composite keys and never survive a request.
  const historicalRoles = new Map<string, Map<string, string>>();
  const sources: ContributionSource[] = [];
  for (const bucket of input.buckets) {
    if (
      !Number.isSafeInteger(bucket.recognizedSeconds) ||
      bucket.recognizedSeconds < 0 ||
      bucket.rawRecognizedMilliseconds < 0n ||
      !CONTRIBUTION_TIME_CATEGORY_CODES.some((code) => code === bucket.categoryCode)
    )
      return unavailable();
    const slices = (slicesByBucket.get(bucket.id) ?? []).sort((left, right) =>
      left.allocationRevisionId < right.allocationRevisionId
        ? -1
        : left.allocationRevisionId > right.allocationRevisionId
          ? 1
          : left.sliceId < right.sliceId
            ? -1
            : left.sliceId > right.sliceId
              ? 1
              : 0,
    );
    const weights = slices.map((slice) => slice.endsAt.getTime() - slice.startsAt.getTime());
    const rawTotal = weights.reduce((sum, value) => sum + BigInt(value), 0n);
    if (
      slices.some(
        (slice) =>
          slice.participationIdentityId !== bucket.participationIdentityId ||
          slice.categoryCode !== bucket.categoryCode,
      ) ||
      rawTotal !== bucket.rawRecognizedMilliseconds ||
      rawTotal > BigInt(Number.MAX_SAFE_INTEGER) ||
      (slices.length === 0 && bucket.recognizedSeconds !== 0)
    )
      return unavailable();
    const durations = distributeByWeight(bucket.recognizedSeconds, weights);
    for (const [index, slice] of slices.entries()) {
      // Original absence/early_departure_zero never becomes a fixed-policy award.
      if (slice.resultCode !== 'present') {
        if (durations[index] !== 0) return unavailable();
        continue;
      }
      const scopeKey =
        slice.sourcePositionId === null
          ? input.frozen.rootKey
          : activityContributionPolicySelectionScopeKey({
              layerCode: 'position',
              sessionId: slice.sessionId,
              positionId: slice.sourcePositionId,
            });
      const resolved = input.frozen.resolved.get(scopeKey);
      const item =
        input.frozen.byScope.get(scopeKey) ?? input.frozen.byScope.get(input.frozen.rootKey);
      const policy = resolved && byPolicy.get(resolved.pointer.versionId);
      if (!resolved || !item || !policy) return unavailable();
      const category = CONTRIBUTION_TIME_CATEGORY_CODES.find((code) => code === slice.categoryCode);
      if (!category) return unavailable();
      let attendanceRoleCode = 'member';
      if (slice.sourcePositionId !== null) {
        const positions = historicalRoles.get(slice.sessionId) ?? new Map<string, string>();
        attendanceRoleCode =
          positions.get(slice.sourcePositionId) ??
          historicalAttendanceRoleFromRuleSnapshot(
            input.snapshot.resolvedConfig,
            slice.sessionId,
            slice.sourcePositionId,
          ) ??
          'member';
        positions.set(slice.sourcePositionId, attendanceRoleCode);
        historicalRoles.set(slice.sessionId, positions);
      }
      sources.push({
        participationIdentityId: slice.participationIdentityId,
        memberId: slice.memberId,
        sessionId: slice.sessionId,
        ruleSnapshotId: slice.ruleSnapshotId,
        // Unassigned attendance uses the original settlement 'member' role; assigned roles are historical, not live lookups.
        attendanceRoleCode,
        timeCategoryCode: category,
        selection: { id: item.id, mode: 'policy', policy },
        allocationRevisionId: slice.allocationRevisionId,
        sliceId: slice.sliceId,
        sourceSegmentId: slice.sourceSegmentId,
        sourceSegmentRevision: slice.sourceSegmentRevision,
        allocationHash: slice.allocationHash,
        durationSeconds: durations[index],
        startsAt: slice.startsAt,
        endsAt: slice.endsAt,
        ...(slice.correctionSource === undefined
          ? {}
          : { correctionSource: slice.correctionSource }),
      });
    }
  }
  return sources;
}

@Injectable()
export class ActivityContributionSettlementQueryService {
  async readSummaryInTx(
    tx: Prisma.TransactionClient,
    versionId: string,
    expected?: { draftContentHash: string; sourceSetHash?: string },
  ) {
    const root = await tx.activitySettlementContributionRevision.findFirst({
      where: {
        settlementVersionId: versionId,
        ...(expected ? { draftContentHash: expected.draftContentHash } : {}),
      },
      orderBy: { revision: 'desc' },
      include: { timeRevision: { select: { sourceSetHash: true } } },
    });
    const current =
      !expected?.sourceSetHash || root?.timeRevision?.sourceSetHash === expected.sourceSetHash;
    if (!root || !current) return presentContributionProof(root, [], false);
    const evaluations = await tx.participantContributionEvaluation.findMany({
      where: { contributionRevisionId: root.id },
      orderBy: [{ evaluationUnitKey: 'asc' }],
      take: 100,
      select: {
        participationIdentityId: true,
        policyVersionId: true,
        definitionHash: true,
        evaluatorVersion: true,
        attendanceRoleCode: true,
        timeCategoryCode: true,
        durationSeconds: true,
        calculatedPoints: true,
        recognizedPoints: true,
        explanationCode: true,
      },
    });
    return presentContributionProof(root, evaluations);
  }

  /** D7's own immutable pending source snapshots, never an invented D4 time revision. */
  async readCorrectionEvaluationInTx(
    tx: Prisma.TransactionClient,
    proof: CorrectionTimeSourceProof,
    previous: ActivitySettlementContributionRevision,
  ) {
    if (
      proof.activityId !== previous.activityId ||
      proof.settlementRunId !== previous.settlementRunId ||
      proof.baseSettlementVersionId !== previous.settlementVersionId ||
      !Array.isArray(proof.sourceSnapshotJson) ||
      !Array.isArray(proof.calculatedBucketsJson) ||
      proof.sourceSnapshotJson.length !== proof.expectedSegmentCount ||
      proof.expectedSliceCount > TIME_SETTLEMENT_LIMITS.slices ||
      proof.expectedSegmentCount > TIME_SETTLEMENT_LIMITS.segments ||
      fingerprintMetricEnvelope('correction-time-source-set-v1', proof.sourceSnapshotJson)
        .definitionHash !== proof.sourceSetHash ||
      fingerprintMetricEnvelope(
        'correction-time-calculation-buckets-v1',
        proof.calculatedBucketsJson,
      ).definitionHash !== proof.calculationHash
    )
      return unavailable();
    const snapshot = await tx.activityRuleSnapshot.findFirst({
      where: {
        id: previous.ruleSnapshotId,
        activityId: previous.activityId,
        snapshotHash: previous.ruleSnapshotHash,
      },
    });
    const selection = await tx.activityContributionPolicySelectionRevision.findFirst({
      where: {
        id: previous.selectionRevisionId,
        activityId: previous.activityId,
        selectionHash: previous.selectionRevisionHash,
      },
    });
    if (!snapshot || !selection) return unavailable();
    const items = await tx.activityContributionPolicySelectionItem.findMany({
      where: { selectionRevisionId: selection.id, activityId: proof.activityId },
      take: 10_002,
    });
    const frozen = contributionFrozenSelection({ snapshot, selection, items });
    const policies = await tx.contributionPolicyVersion.findMany({
      where: {
        id: { in: [...new Set(frozen.pointers.resolved.map((item) => item.pointer.versionId))] },
      },
    });
    const records = proof.sourceSnapshotJson.map(record);
    const bases = await tx.participantTimeAllocationRevision.findMany({
      where: {
        id: { in: records.map((source) => String(source.baseAllocationRevisionId)) },
        activityId: proof.activityId,
      },
      select: {
        id: true,
        participationIdentityId: true,
        memberId: true,
        sessionId: true,
        ruleSnapshotId: true,
        ruleSnapshotHash: true,
        sourcePositionId: true,
      },
    });
    const baseById = new Map(bases.map((base) => [base.id, base]));
    const results = await tx.participantSettlementResultRevision.findMany({
      where: { settlementVersionId: proof.settlementVersionId },
      select: { participationIdentityId: true, resultCode: true },
      take: TIME_SETTLEMENT_LIMITS.identities + 1,
    });
    if (results.length > TIME_SETTLEMENT_LIMITS.identities)
      throw new ContributionSettlementPolicyError('scale_limit');
    const resultByIdentity = new Map(
      results.map((result) => [result.participationIdentityId, result.resultCode]),
    );
    const slices: ContributionTimeSliceRow[] = [];
    const buckets: Bucket[] = proof.calculatedBucketsJson.map((value) => {
      const row = record(value);
      if (
        typeof row.rootEntryId !== 'string' ||
        typeof row.participationIdentityId !== 'string' ||
        typeof row.categoryCode !== 'string' ||
        !Number.isSafeInteger(row.recognizedSeconds)
      )
        return unavailable();
      return {
        id: row.rootEntryId,
        participationIdentityId: row.participationIdentityId,
        categoryCode: row.categoryCode,
        recognizedSeconds: Number(row.recognizedSeconds),
        rawRecognizedMilliseconds: 0n,
      };
    });
    const bucketByKey = new Map(
      buckets.map((bucket) => [
        JSON.stringify([bucket.participationIdentityId, bucket.categoryCode]),
        bucket,
      ]),
    );
    if (bucketByKey.size !== buckets.length) return unavailable();
    for (const source of records) {
      const base = baseById.get(String(source.baseAllocationRevisionId));
      if (
        !base ||
        base.participationIdentityId !== source.participationIdentityId ||
        !Array.isArray(source.slices) ||
        source.slices.length !== source.sliceCount ||
        typeof source.allocationRevisionId !== 'string' ||
        typeof source.allocationHash !== 'string' ||
        typeof source.sourceSegmentId !== 'string' ||
        typeof source.sourceHash !== 'string' ||
        !Number.isSafeInteger(source.sourceSegmentRevision) ||
        !(source.pendingAllocationId === null || typeof source.pendingAllocationId === 'string')
      )
        return unavailable();
      for (const value of source.slices) {
        const slice = record(value),
          bucket = bucketByKey.get(
            JSON.stringify([base.participationIdentityId, slice.categoryCode]),
          );
        if (
          !bucket ||
          typeof slice.startAt !== 'string' ||
          typeof slice.endAt !== 'string' ||
          !Number.isSafeInteger(slice.ordinal) ||
          Number(slice.ordinal) < 0
        )
          return unavailable();
        const startsAt = new Date(slice.startAt),
          endsAt = new Date(slice.endAt);
        if (
          !Number.isFinite(startsAt.getTime()) ||
          !Number.isFinite(endsAt.getTime()) ||
          startsAt >= endsAt
        )
          return unavailable();
        bucket.rawRecognizedMilliseconds += BigInt(endsAt.getTime() - startsAt.getTime());
        slices.push({
          ...base,
          bucketId: bucket.id,
          resultCode: resultByIdentity.get(base.participationIdentityId) ?? '',
          allocationRevisionId: source.allocationRevisionId,
          allocationHash: source.allocationHash,
          sourceSegmentId: source.sourceSegmentId,
          sourceSegmentRevision: Number(source.sourceSegmentRevision),
          sliceId: `${source.allocationRevisionId}:${Number(slice.ordinal)}`,
          categoryCode: bucket.categoryCode,
          startsAt,
          endsAt,
          correctionSource: {
            proofId: proof.id,
            pendingAllocationId: source.pendingAllocationId,
            sourceHash: source.sourceHash,
            sliceOrdinal: Number(slice.ordinal),
          },
        });
      }
    }
    if (slices.length !== proof.expectedSliceCount) return unavailable();
    const sources = buildFrozenContributionSources({ snapshot, frozen, buckets, slices, policies });
    return evaluateSettlementContributions({
      activityId: proof.activityId,
      settlementVersionId: proof.settlementVersionId,
      sourceKindCode: 'correction_time_proof',
      sources,
    });
  }

  async readLedgerDaysInTx(
    tx: Prisma.TransactionClient,
    contributionRevisionId: string,
    identityIds: readonly string[],
  ) {
    const evaluations = await tx.participantContributionEvaluation.findMany({
      where: { contributionRevisionId, participationIdentityId: { in: [...identityIds] } },
      select: { participationIdentityId: true, beijingDayPointsJson: true, sourceRefsJson: true },
      take: TIME_SETTLEMENT_LIMITS.slices + 1,
    });
    if (evaluations.length > TIME_SETTLEMENT_LIMITS.slices)
      throw new ContributionSettlementPolicyError('scale_limit');
    const byIdentity = new Map<string, Map<string, { amount: number; start: Date; date: Date }>>();
    for (const evaluation of evaluations) {
      if (
        !Array.isArray(evaluation.sourceRefsJson) ||
        !Array.isArray(evaluation.beijingDayPointsJson)
      )
        return unavailable();
      const earliest = new Map<string, Date>();
      for (const refValue of evaluation.sourceRefsJson) {
        const ref = record(refValue);
        if (
          !Number.isSafeInteger(ref.durationSeconds) ||
          Number(ref.durationSeconds) < 0 ||
          typeof ref.startsAt !== 'string' ||
          typeof ref.endsAt !== 'string'
        )
          return unavailable();
        if (ref.durationSeconds === 0) continue;
        const start = new Date(ref.startsAt),
          end = new Date(ref.endsAt);
        if (
          !Number.isFinite(start.getTime()) ||
          !Number.isFinite(end.getTime()) ||
          start >= end ||
          start.toISOString() !== ref.startsAt ||
          end.toISOString() !== ref.endsAt
        )
          return unavailable();
        for (const slice of splitSpanByBeijingDay(start, end)) {
          const date = slice.ledgerDate.toISOString().slice(0, 10);
          const old = earliest.get(date);
          if (!old || old > slice.startAt) earliest.set(date, slice.startAt);
        }
      }
      const days =
        byIdentity.get(evaluation.participationIdentityId) ??
        new Map<string, { amount: number; start: Date; date: Date }>();
      const seenDates = new Set<string>();
      for (const dayValue of evaluation.beijingDayPointsJson) {
        const day = record(dayValue);
        if (
          typeof day.ledgerDate !== 'string' ||
          typeof day.recognizedPoints !== 'string' ||
          !/^(?:0|[1-9][0-9]{0,2})\.[0-9]{2}$/u.test(day.recognizedPoints) ||
          seenDates.has(day.ledgerDate)
        )
          return unavailable();
        seenDates.add(day.ledgerDate);
        const date = parseDateOnlyStrict(day.ledgerDate),
          start = earliest.get(day.ledgerDate);
        if (!date || date.toISOString().slice(0, 10) !== day.ledgerDate || !start)
          return unavailable();
        const previous = days.get(day.ledgerDate);
        const amount = (previous?.amount ?? 0) + decimalToHundredths(day.recognizedPoints);
        if (amount > 99_999) throw new ContributionSettlementPolicyError('overflow');
        days.set(day.ledgerDate, {
          amount,
          date,
          start: previous && previous.start < start ? previous.start : start,
        });
      }
      byIdentity.set(evaluation.participationIdentityId, days);
    }
    return new Map(
      [...byIdentity.entries()].map(([identity, days]) => [
        identity,
        [...days.values()]
          .sort((left, right) => left.date.getTime() - right.date.getTime())
          .map(
            (day): NativeContributionDay => ({
              ledgerDate: day.date,
              recognizedPoints: `${Math.floor(day.amount / 100)}.${String(day.amount % 100).padStart(2, '0')}`,
              sequenceStartAt: day.start,
            }),
          ),
      ]),
    );
  }

  /** Activity/Run/source locks belong to the caller; every read uses that very transaction. */
  async readTimeEvaluationInTx(tx: Prisma.TransactionClient, time: ActivitySettlementTimeRevision) {
    const snapshot = await tx.activityRuleSnapshot.findUnique({
      where: {
        activityId_workflowRevision: {
          activityId: time.activityId,
          workflowRevision: time.workflowRevision,
        },
      },
      select: {
        id: true,
        activityId: true,
        workflowRevision: true,
        snapshotHash: true,
        resolvedConfig: true,
        contributionPolicySelectionRevisionId: true,
      },
    });
    if (!snapshot?.contributionPolicySelectionRevisionId) return unavailable();
    const selection = await tx.activityContributionPolicySelectionRevision.findFirst({
      where: { id: snapshot.contributionPolicySelectionRevisionId, activityId: time.activityId },
      select: {
        id: true,
        activityId: true,
        revision: true,
        selectionHash: true,
        selectionJson: true,
        itemCount: true,
      },
    });
    if (!selection) return unavailable();
    const items = await tx.activityContributionPolicySelectionItem.findMany({
      where: { selectionRevisionId: selection.id, activityId: time.activityId },
      take: 10_002,
    });
    const frozen = contributionFrozenSelection({ snapshot, selection, items });
    const buckets = await tx.participantSettlementTimeBucket.findMany({
      where: { timeRevisionId: time.id, activityId: time.activityId },
      select: {
        id: true,
        participationIdentityId: true,
        categoryCode: true,
        recognizedSeconds: true,
        rawRecognizedMilliseconds: true,
      },
      take: TIME_SETTLEMENT_LIMITS.buckets + 1,
    });
    const slices = await tx.$queryRaw<ContributionTimeSliceRow[]>`
      SELECT b.id AS "bucketId", b."participationIdentityId", a."memberId", a."sessionId", r."resultCode",
        a.id AS "allocationRevisionId", a."allocationHash", a."ruleSnapshotId", a."ruleSnapshotHash", a."sourcePositionId",
        a."sourceSegmentId", a."sourceSegmentRevision", s.id AS "sliceId", s."categoryCode", s."startAt" AS "startsAt", s."endAt" AS "endsAt"
      FROM "ParticipantSettlementTimeBucket" b
      JOIN "ParticipantSettlementTimeBucketSource" bs ON bs."bucketId" = b.id AND bs."timeRevisionId" = b."timeRevisionId" AND bs."activityId" = b."activityId"
      JOIN "ParticipantTimeAllocationRevision" a ON a.id = bs."allocationRevisionId" AND a."activityId" = bs."activityId"
        AND a."sourceSegmentId" = bs."sourceSegmentId" AND a."sourceSegmentRevision" = bs."sourceSegmentRevision"
        AND a."participationIdentityId" = b."participationIdentityId"
      JOIN "ParticipantTimeAllocationSlice" s ON s."allocationRevisionId" = a.id AND s."activityId" = a."activityId" AND s."categoryCode" = b."categoryCode"
      JOIN "ParticipantSettlementResultRevision" r ON r."settlementVersionId" = ${time.settlementVersionId} AND r."participationIdentityId" = a."participationIdentityId"
      WHERE b."timeRevisionId" = ${time.id} AND b."activityId" = ${time.activityId}
      ORDER BY b.id, a.id, s.ordinal LIMIT ${TIME_SETTLEMENT_LIMITS.slices + 1}
    `;
    const policies = await tx.contributionPolicyVersion.findMany({
      where: {
        id: { in: [...new Set(frozen.pointers.resolved.map((item) => item.pointer.versionId))] },
      },
    });
    const sources = buildFrozenContributionSources({ snapshot, frozen, buckets, slices, policies });
    const evaluated = evaluateSettlementContributions({
      activityId: time.activityId,
      settlementVersionId: time.settlementVersionId,
      sourceKindCode: 'time_revision',
      sources,
    });
    return {
      ...evaluated,
      ruleSnapshotId: snapshot.id,
      ruleSnapshotHash: snapshot.snapshotHash,
      selectionRevisionId: selection.id,
      selectionRevisionHash: selection.selectionHash,
    };
  }
}
