import { Injectable } from '@nestjs/common';
import { Prisma, type ParticipantTimeAllocationRevision } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import {
  ParticipationSegmentFacade,
  type CurrentParticipationSegment,
} from '../attendances/participation-segment.facade';
import { historicalAttendanceRoleFromRuleSnapshot } from './activity-time-allocation-policy';
import { ActivityTimeSettlementAccessService } from './activity-time-settlement-access.service';
import {
  buildTimeSettlementBuckets,
  timeSettlementSourceSetHash,
  TIME_SETTLEMENT_LIMITS,
  TimeSettlementPolicyError,
  type TimeSettlementAllocation,
  type TimeSettlementDraftProof,
  type TimeSettlementPopulation,
} from './activity-time-settlement-policy';
import {
  presentTimeSettlementAllocation,
  presentTimeSettlementBucket,
  presentTimeSettlementBucketSource,
  presentTimeSettlementRevision,
} from './activity-time-settlement.presenter';

export interface TimeSettlementDraftContext {
  runId: string;
  runStatusCode: string;
  currentDraftVersion: number | null;
  currentSubmittedVersion: number | null;
  draftId: string | null;
  draftVersion: number | null;
  evidenceSealId: string | null;
  evidenceRevision: number | null;
  populationRevision: number | null;
  workflowRevision: number | null;
  draftContentHash: string | null;
  sealCurrent: boolean;
}

export interface TimeSettlementPage {
  page: number;
  pageSize: number;
  bucketId?: string;
}
type AllocationBasis = Omit<ParticipantTimeAllocationRevision, 'allocationJson'>;
function pageResult<T>(items: T[], total: number, page: TimeSettlementPage): PageResultDto<T> {
  return { items, total, page: page.page, pageSize: page.pageSize };
}
export interface TimeSettlementSourceSet {
  proof: TimeSettlementDraftProof;
  population: readonly TimeSettlementPopulation[];
  segments: readonly CurrentParticipationSegment[];
  latest: readonly AllocationBasis[];
  sourceSetHash: string;
}

export function requireTimeSettlementDraft(
  activityId: string,
  context: TimeSettlementDraftContext | null,
): TimeSettlementDraftProof {
  if (
    !context?.draftId ||
    !context.draftContentHash ||
    !context.evidenceSealId ||
    context.evidenceRevision === null ||
    context.populationRevision === null ||
    context.workflowRevision === null
  )
    throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY);
  if (context.runStatusCode !== 'drafting' || !context.sealCurrent)
    throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_STALE);
  return {
    activityId,
    settlementRunId: context.runId,
    settlementDraftVersionId: context.draftId,
    evidenceSealId: context.evidenceSealId,
    evidenceRevision: context.evidenceRevision,
    populationRevision: context.populationRevision,
    workflowRevision: context.workflowRevision,
    draftContentHash: context.draftContentHash,
  };
}

export function allocationMatchesTimeSettlementSource(
  allocation: AllocationBasis | undefined,
  source: CurrentParticipationSegment,
  proof: TimeSettlementDraftProof,
): boolean {
  if (
    !allocation ||
    allocation.sourceSegmentId !== source.id ||
    allocation.sourceSegmentRevision !== source.revision
  )
    return false;
  if (source.statusCode === 'committed') return allocation.settlementDraftVersionId === null;
  return (
    allocation.settlementDraftVersionId === proof.settlementDraftVersionId &&
    allocation.settlementEvidenceSealId === proof.evidenceSealId &&
    allocation.settlementEvidenceRevision === proof.evidenceRevision &&
    allocation.settlementPopulationRevision === proof.populationRevision &&
    allocation.settlementWorkflowRevision === proof.workflowRevision &&
    allocation.settlementDraftContentHash === proof.draftContentHash
  );
}

/** Counts refer to actual pending identities, source segments or mixed-policy identities. */
export function timeSettlementReadinessBlockers(set: TimeSettlementSourceSet) {
  const counts = new Map<string, number>();
  const increment = (code: string) => counts.set(code, (counts.get(code) ?? 0) + 1);
  const population = new Set(set.population.map((row) => row.participationIdentityId));
  const latest = new Map(
    set.latest.map((row) => [JSON.stringify([row.participationIdentityId, row.segmentKey]), row]),
  );
  const policies = new Map<string, Set<string>>();
  const intervals = new Map<string, { start: number; end: number }[]>();
  for (const identity of set.population) if (identity.pending) increment('pending_result');
  for (const source of set.segments) {
    if (!population.has(source.participationIdentityId)) continue;
    if (source.checkOutAt === null) {
      increment('open_segment');
      continue;
    }
    if (source.resultCode !== 'valid') continue;
    const allocation = latest.get(
      JSON.stringify([source.participationIdentityId, source.segmentKey]),
    );
    if (!allocationMatchesTimeSettlementSource(allocation, source, set.proof))
      increment('allocation_required');
    else if (allocation) {
      const versions = policies.get(source.participationIdentityId) ?? new Set<string>();
      versions.add(
        JSON.stringify([
          allocation.policyVersionId,
          allocation.definitionHash,
          allocation.evaluatorVersion,
        ]),
      );
      policies.set(source.participationIdentityId, versions);
    }
    const rows = intervals.get(source.memberId) ?? [];
    rows.push({ start: source.checkInAt.getTime(), end: source.checkOutAt.getTime() });
    intervals.set(source.memberId, rows);
  }
  for (const versions of policies.values()) if (versions.size > 1) increment('policy_mixed');
  for (const rows of intervals.values()) {
    rows.sort((left, right) => left.start - right.start || left.end - right.end);
    let end = -Infinity;
    for (const row of rows) {
      if (row.start < end) increment('overlap');
      end = Math.max(end, row.end);
    }
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => ({ code, count }));
}

export function timeSettlementError(error: unknown): never {
  if (error instanceof TimeSettlementPolicyError) {
    const codes = {
      invalid: BizCode.ACTIVITY_TIME_SETTLEMENT_INVALID,
      source_not_ready: BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY,
      policy_mixed: BizCode.ACTIVITY_TIME_SETTLEMENT_POLICY_MIXED,
      overlap: BizCode.ACTIVITY_TIME_SETTLEMENT_OVERLAP,
      scale_limit: BizCode.ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT,
    } as const;
    throw new BizException(codes[error.reason]);
  }
  if (error instanceof RangeError)
    throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT);
  if (error instanceof TypeError) throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_INVALID);
  if (error instanceof BizException) {
    const borrowedCodes = new Map<number, (typeof BizCode)[keyof typeof BizCode]>(
      [
        [BizCode.ACTIVITY_TIME_ALLOCATION_INVALID, BizCode.ACTIVITY_TIME_SETTLEMENT_INVALID],
        [
          BizCode.ACTIVITY_TIME_ALLOCATION_REFERENCE_UNAVAILABLE,
          BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE,
        ],
        [BizCode.ACTIVITY_TIME_ALLOCATION_STALE, BizCode.ACTIVITY_TIME_SETTLEMENT_STALE],
        [
          BizCode.ACTIVITY_TIME_ALLOCATION_COMMAND_CONFLICT,
          BizCode.ACTIVITY_TIME_SETTLEMENT_COMMAND_CONFLICT,
        ],
        [
          BizCode.ACTIVITY_TIME_ALLOCATION_POLICY_UNAVAILABLE,
          BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY,
        ],
      ].map(([from, to]) => [from.code, to]),
    );
    const mapped = borrowedCodes.get(error.biz.code);
    if (mapped) throw new BizException(mapped);
  }
  throw error;
}

@Injectable()
export class ActivityTimeSettlementQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityTimeSettlementAccessService,
    private readonly segments: ParticipationSegmentFacade,
  ) {}

  /** Shared read primitive. Writers must acquire Activity -> Run locks before using the proof. */
  async readDraftContextInTx(
    tx: Prisma.TransactionClient,
    activityId: string,
  ): Promise<TimeSettlementDraftContext | null> {
    const rows = await tx.$queryRaw<TimeSettlementDraftContext[]>`
      SELECT r.id AS "runId", r."statusCode" AS "runStatusCode", r."currentDraftVersion", r."currentSubmittedVersion",
        d.id AS "draftId", d.version AS "draftVersion", d."evidenceSealId", d."evidenceRevision",
        d."populationRevision", d."workflowRevision", d."contentHash" AS "draftContentHash",
        coalesce(s."statusCode" = 'active' AND s."activityId" = a.id
          AND s."evidenceRevision" = d."evidenceRevision" AND s."populationRevision" = d."populationRevision"
          AND s."workflowRevision" = d."workflowRevision" AND s."workflowRevision" = a."workflowRevision"
          AND s."evidenceRevision" = coalesce(e."evidenceRevision", 0)
          AND s."populationRevision" = coalesce(e."populationRevision", 0)
          AND s."openSegmentCount" = 0 AND s."manualReviewPendingCount" = 0, false) AS "sealCurrent"
      FROM "AttendanceSettlementRun" r JOIN "Activity" a ON a.id = r."activityId"
      LEFT JOIN "AttendanceSettlementVersion" d ON d."settlementRunId" = r.id
        AND d.version = r."currentDraftVersion" AND d."statusCode" = 'draft'
      LEFT JOIN "EvidenceSeal" s ON s.id = d."evidenceSealId"
      LEFT JOIN "ActivityEvidenceState" e ON e."activityId" = a.id
      WHERE r."activityId" = ${activityId}
    `;
    return rows[0] ?? null;
  }

  async readSourceSetInTx(
    tx: Prisma.TransactionClient,
    proof: TimeSettlementDraftProof,
  ): Promise<TimeSettlementSourceSet> {
    const identities = await tx.activityParticipationIdentity.findMany({
      where: { activityId: proof.activityId, populationIncluded: true },
      select: { id: true, memberId: true },
      orderBy: { id: 'asc' },
      take: TIME_SETTLEMENT_LIMITS.identities + 1,
    });
    if (identities.length > TIME_SETTLEMENT_LIMITS.identities)
      throw new TimeSettlementPolicyError('scale_limit');
    const results = await tx.participantSettlementResultRevision.findMany({
      where: { settlementVersionId: proof.settlementDraftVersionId },
      select: { participationIdentityId: true, exceptionFlagsJson: true },
      take: TIME_SETTLEMENT_LIMITS.identities + 1,
    });
    if (results.length > TIME_SETTLEMENT_LIMITS.identities)
      throw new TimeSettlementPolicyError('scale_limit');
    const determined = new Set(
      results
        .filter((row) => {
          const flags = row.exceptionFlagsJson;
          return !(
            flags &&
            typeof flags === 'object' &&
            !Array.isArray(flags) &&
            Array.isArray(flags.blockers) &&
            flags.blockers.length > 0
          );
        })
        .map((row) => row.participationIdentityId),
    );
    const population = identities.map((row) => ({
      participationIdentityId: row.id,
      memberId: row.memberId,
      pending: !determined.has(row.id),
    }));
    const segments = await this.segments.readActivityCurrentSegmentsTrusted(tx, proof.activityId);
    const keys = JSON.stringify(
      segments.map((row) => ({ identity: row.participationIdentityId, segment: row.segmentKey })),
    );
    // Bound the allocation manifest before reading any slices/definition JSON. Distinct is done
    // by PostgreSQL, not Prisma's in-memory distinct over an unbounded historical revision chain.
    const latest = await tx.$queryRaw<AllocationBasis[]>`
      SELECT DISTINCT ON (a."participationIdentityId", a."segmentKey")
        a.id, a."activityId", a."sessionId", a."memberId", a."participationIdentityId", a."segmentKey",
        a.revision, a."previousAllocationRevisionId", a."sourceSegmentId", a."sourceSegmentRevision", a."sourcePositionId",
        a."ruleSnapshotId", a."ruleSnapshotHash", a."timePolicySelectionRevisionId", a."selectionHash",
        a."policyId", a."policyVersionId", a."definitionHash", a."evaluatorVersion", a."recognitionModeCode",
        a."manualReason", a."allocationHash", a."sliceCount", a."createdAt", a."createdByUserId",
        a."settlementDraftVersionId", a."settlementEvidenceSealId", a."settlementEvidenceRevision",
        a."settlementPopulationRevision", a."settlementWorkflowRevision", a."settlementDraftContentHash"
      FROM "ParticipantTimeAllocationRevision" a
      JOIN jsonb_to_recordset(${keys}::jsonb) AS k(identity TEXT, segment TEXT)
        ON a."participationIdentityId" = k.identity AND a."segmentKey" = k.segment
      WHERE a."activityId" = ${proof.activityId}
      ORDER BY a."participationIdentityId", a."segmentKey", a.revision DESC
    `;
    if (latest.reduce((sum, row) => sum + row.sliceCount, 0) > TIME_SETTLEMENT_LIMITS.slices)
      throw new TimeSettlementPolicyError('scale_limit');
    return {
      proof,
      population,
      segments,
      latest,
      sourceSetHash: timeSettlementSourceSetHash(proof, population, segments, latest),
    };
  }

  async evaluateInTx(tx: Prisma.TransactionClient, sourceSet: TimeSettlementSourceSet) {
    const { proof, population, latest } = sourceSet;
    const identityIds = new Set(population.map((row) => row.participationIdentityId));
    const segments = sourceSet.segments.filter((row) =>
      identityIds.has(row.participationIdentityId),
    );
    const byKey = new Map(
      latest.map((row) => [JSON.stringify([row.participationIdentityId, row.segmentKey]), row]),
    );
    const applicable: AllocationBasis[] = [];
    for (const source of segments) {
      if (source.checkOutAt === null) throw new TimeSettlementPolicyError('source_not_ready');
      if (source.resultCode !== 'valid') continue;
      const allocation = byKey.get(
        JSON.stringify([source.participationIdentityId, source.segmentKey]),
      );
      if (!allocation || !allocationMatchesTimeSettlementSource(allocation, source, proof))
        throw new TimeSettlementPolicyError('source_not_ready');
      applicable.push(allocation);
    }
    const allocationIds = applicable.map((row) => row.id);
    const slices = await tx.participantTimeAllocationSlice.findMany({
      where: { allocationRevisionId: { in: allocationIds } },
      orderBy: [{ allocationRevisionId: 'asc' }, { ordinal: 'asc' }],
      take: TIME_SETTLEMENT_LIMITS.slices + 1,
    });
    if (slices.length > TIME_SETTLEMENT_LIMITS.slices)
      throw new TimeSettlementPolicyError('scale_limit');
    const policies = await tx.timePolicyVersion.findMany({
      where: { id: { in: [...new Set(applicable.map((row) => row.policyVersionId))] } },
    });
    if (policies.some((row) => row.statusCode !== 'active' && row.statusCode !== 'retired'))
      throw new TimeSettlementPolicyError('source_not_ready');
    const snapshots = await tx.activityRuleSnapshot.findMany({
      where: {
        id: { in: [...new Set(applicable.map((row) => row.ruleSnapshotId))] },
        activityId: proof.activityId,
      },
      select: { id: true, snapshotHash: true, resolvedConfig: true },
    });
    const bySnapshot = new Map(snapshots.map((row) => [row.id, row]));
    const byAllocation = new Map<string, typeof slices>();
    for (const slice of slices) {
      const list = byAllocation.get(slice.allocationRevisionId) ?? [];
      list.push(slice);
      byAllocation.set(slice.allocationRevisionId, list);
    }
    const allocations: TimeSettlementAllocation[] = applicable.map((row) => {
      const snapshot = bySnapshot.get(row.ruleSnapshotId),
        sourceSlices = byAllocation.get(row.id) ?? [];
      if (
        !snapshot ||
        snapshot.snapshotHash !== row.ruleSnapshotHash ||
        sourceSlices.length !== row.sliceCount ||
        sourceSlices.some(
          (slice, ordinal) => slice.ordinal !== ordinal || slice.activityId !== proof.activityId,
        ) ||
        (row.recognitionModeCode !== 'automatic' && row.recognitionModeCode !== 'manual')
      )
        throw new TimeSettlementPolicyError('source_not_ready');
      return {
        ...row,
        recognitionModeCode: row.recognitionModeCode,
        attendanceRoleCode: historicalAttendanceRoleFromRuleSnapshot(
          snapshot.resolvedConfig,
          row.sessionId,
          row.sourcePositionId,
        ),
        slices: sourceSlices.map((slice) => {
          if (
            (slice.categoryCode !== 'volunteer_service' &&
              slice.categoryCode !== 'training' &&
              slice.categoryCode !== 'organization' &&
              slice.categoryCode !== 'non_creditable') ||
            slice.intervalKindCode !== 'service_segment'
          )
            throw new TimeSettlementPolicyError('invalid');
          return {
            categoryCode: slice.categoryCode,
            intervalKindCode: 'service_segment',
            startAt: slice.startAt.toISOString(),
            endAt: slice.endAt.toISOString(),
          };
        }),
      };
    });
    return buildTimeSettlementBuckets({
      activityId: proof.activityId,
      population,
      segments,
      allocations,
      policies,
    });
  }

  private async read<T>(
    activityId: string,
    user: CurrentUserPayload,
    work: (tx: Prisma.TransactionClient, checkVersion: (id: string) => void) => Promise<T>,
    reference?: { kind: 'allocation' | 'time-revision'; id: string },
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          let versionId: string | undefined;
          // Resolve only the same-activity immutable version anchor before authorization.
          // No details leave this transaction until both current-eligibility checks pass.
          // A missing anchor retains the existing authorization-first error behavior.
          if (reference?.kind === 'allocation') {
            const anchor = await tx.participantTimeAllocationRevision.findFirst({
              where: { id: reference.id, activityId },
              select: { settlementDraftVersionId: true },
            });
            versionId = anchor?.settlementDraftVersionId ?? undefined;
          } else if (reference?.kind === 'time-revision') {
            const anchor = await tx.activitySettlementTimeRevision.findFirst({
              where: { id: reference.id, activityId },
              select: { settlementVersionId: true },
            });
            versionId = anchor?.settlementVersionId;
          }
          await this.access.authorize(tx, user, activityId, 'read', versionId);
          const result = await work(tx, (id) => {
            versionId = id;
          });
          await this.access.authorize(tx, user, activityId, 'read', versionId);
          return result;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30000 },
      );
    } catch (error) {
      return timeSettlementError(error);
    }
  }

  async workbench(activityId: string, user: CurrentUserPayload) {
    return await this.read(activityId, user, async (tx) => {
      const context = await this.readDraftContextInTx(tx, activityId);
      const latest = await tx.activitySettlementTimeRevision.findFirst({
        where: { activityId },
        orderBy: { revision: 'desc' },
      });
      const blockers: { code: string; count: number }[] = [];
      try {
        const proof = requireTimeSettlementDraft(activityId, context);
        const sourceSet = await this.readSourceSetInTx(tx, proof);
        blockers.push(...timeSettlementReadinessBlockers(sourceSet));
        if (blockers.length === 0) await this.evaluateInTx(tx, sourceSet);
      } catch (error) {
        if (error instanceof TimeSettlementPolicyError)
          blockers.push({ code: error.reason, count: 1 });
        else if (
          error instanceof BizException &&
          (error.biz === BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY ||
            error.biz === BizCode.ACTIVITY_TIME_SETTLEMENT_STALE)
        )
          blockers.push({
            code:
              error.biz === BizCode.ACTIVITY_TIME_SETTLEMENT_STALE ? 'stale' : 'source_not_ready',
            count: 1,
          });
        else throw error;
      }
      return {
        activityId,
        run: context
          ? {
              settlementRunId: context.runId,
              statusCode: context.runStatusCode,
              currentDraftVersion: context.currentDraftVersion,
              currentSubmittedVersion: context.currentSubmittedVersion,
            }
          : null,
        draft: context?.draftId
          ? {
              settlementVersionId: context.draftId,
              version: context.draftVersion,
              evidenceSealId: context.evidenceSealId,
              evidenceRevision: context.evidenceRevision,
              populationRevision: context.populationRevision,
              workflowRevision: context.workflowRevision,
              sealCurrent: context.sealCurrent,
            }
          : null,
        latestRevision: latest ? presentTimeSettlementRevision(latest) : null,
        ready: blockers.length === 0,
        blockers,
      };
    });
  }

  async currentSources(activityId: string, page: TimeSettlementPage, user: CurrentUserPayload) {
    return await this.read(activityId, user, async (tx) => {
      const proof = requireTimeSettlementDraft(
        activityId,
        await this.readDraftContextInTx(tx, activityId),
      );
      const set = await this.readSourceSetInTx(tx, proof);
      const allocations = new Map(
        set.latest.map((row) => [
          JSON.stringify([row.participationIdentityId, row.segmentKey]),
          row,
        ]),
      );
      const population = new Set(set.population.map((row) => row.participationIdentityId));
      const rows = set.segments
        .slice((page.page - 1) * page.pageSize, page.page * page.pageSize)
        .map((row) => {
          const allocation = allocations.get(
            JSON.stringify([row.participationIdentityId, row.segmentKey]),
          );
          const included = population.has(row.participationIdentityId);
          const excluded = !included || row.resultCode !== 'valid';
          return {
            sourceSegmentId: row.id,
            participationIdentityId: row.participationIdentityId,
            sessionId: row.sessionId,
            sourceSegmentRevision: row.revision,
            statusCode: row.statusCode,
            resultCode: row.resultCode,
            checkInAt: row.checkInAt.toISOString(),
            checkOutAt: row.checkOutAt?.toISOString() ?? null,
            allocationRevisionId: allocation?.id ?? null,
            allocationRevision: allocation?.revision ?? 0,
            exclusionReasonCode: !included ? 'not_in_population' : excluded ? row.resultCode : null,
            blockerCode: !included
              ? null
              : row.checkOutAt === null
                ? 'open_segment'
                : excluded
                  ? null
                  : allocationMatchesTimeSettlementSource(allocation, row, proof)
                    ? null
                    : 'allocation_required',
          };
        });
      return pageResult(rows, set.segments.length, page);
    });
  }

  async allocationDetail(activityId: string, allocationId: string, user: CurrentUserPayload) {
    return await this.read(
      activityId,
      user,
      async (tx, checkVersion) => {
        const row = await tx.participantTimeAllocationRevision.findFirst({
          where: { id: allocationId, activityId },
          include: {
            slices: { orderBy: { ordinal: 'asc' }, take: 501 },
            evidence: { orderBy: { ordinal: 'asc' }, take: 501 },
            policyVersion: true,
          },
        });
        if (!row) throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE);
        if (row.slices.length > 500 || row.evidence.length > 500)
          throw new TimeSettlementPolicyError('scale_limit');
        if (row.settlementDraftVersionId) checkVersion(row.settlementDraftVersionId);
        return presentTimeSettlementAllocation(row);
      },
      { kind: 'allocation', id: allocationId },
    );
  }

  async buckets(
    activityId: string,
    timeRevisionId: string,
    page: TimeSettlementPage,
    user: CurrentUserPayload,
  ) {
    return await this.read(
      activityId,
      user,
      async (tx, checkVersion) => {
        const revision = await tx.activitySettlementTimeRevision.findFirst({
          where: { id: timeRevisionId, activityId },
        });
        if (!revision)
          throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE);
        checkVersion(revision.settlementVersionId);
        const rows = await tx.participantSettlementTimeBucket.findMany({
          where: { timeRevisionId, activityId },
          orderBy: [{ participationIdentityId: 'asc' }, { categoryCode: 'asc' }],
          skip: (page.page - 1) * page.pageSize,
          take: page.pageSize,
        });
        return pageResult(rows.map(presentTimeSettlementBucket), revision.bucketCount, page);
      },
      { kind: 'time-revision', id: timeRevisionId },
    );
  }

  async bucketSources(
    activityId: string,
    timeRevisionId: string,
    page: TimeSettlementPage,
    user: CurrentUserPayload,
  ) {
    return await this.read(
      activityId,
      user,
      async (tx, checkVersion) => {
        const revision = await tx.activitySettlementTimeRevision.findFirst({
          where: { id: timeRevisionId, activityId },
        });
        if (!revision)
          throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE);
        checkVersion(revision.settlementVersionId);
        if (
          page.bucketId &&
          !(await tx.participantSettlementTimeBucket.findFirst({
            where: { id: page.bucketId, timeRevisionId, activityId },
            select: { id: true },
          }))
        )
          throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE);
        const where = {
          timeRevisionId,
          activityId,
          ...(page.bucketId ? { bucketId: page.bucketId } : {}),
        };
        const total = page.bucketId
          ? await tx.participantSettlementTimeBucketSource.count({ where })
          : revision.sourceCount;
        const rows = await tx.participantSettlementTimeBucketSource.findMany({
          where,
          orderBy: [{ bucketId: 'asc' }, { allocationRevisionId: 'asc' }],
          skip: (page.page - 1) * page.pageSize,
          take: page.pageSize,
        });
        return pageResult(rows.map(presentTimeSettlementBucketSource), total, page);
      },
      { kind: 'time-revision', id: timeRevisionId },
    );
  }
}
