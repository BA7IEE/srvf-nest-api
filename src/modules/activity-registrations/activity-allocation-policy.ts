import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type {
  ActivityQualificationEvaluation,
  QualificationProjection,
} from './activity-qualification-evaluator.service';
import {
  createAllocationResponseHash,
  createCandidateSnapshotHash,
  type AllocationModeCode,
} from './activity-allocation-request-hash';
import type {
  AllocationCommandCode,
  CandidateSource,
  LockedApplicationProjection,
  LockedBatch,
  PersistedCandidate,
  ReceiptBatchStatusCode,
} from './activity-allocation.types';

import { RESPONSE_SCHEMA_VERSION } from './activity-allocation.types';

/*
 * 活动名额分配的**纯判定层**(Phase 6-B 第五域第一刀)。
 *
 * 从 `activity-allocation.service.ts` 迁出的六个函数,共同特征:**零 IO、零事务、零注入** ——
 * 只吃已经锁定并读出的事实,返回结论或抛 BizException。故为模块级纯函数而非 @Injectable:
 * 不进 DI 图、两个 module 都无需改注册,也就没有「漏注册导致 Nest 起不来」那类失败面。
 *
 * ⚠️ 一处必须知道的判定形状:`assertVoidLiveFacts` 有约 43 个判定条件,
 * **全部抛同一个 `ACTIVITY_CAPACITY_RECONCILIATION_FAILED`**。
 * 后果:任何单条条件失效时,测试只能看到「抛了这个码」,**无法区分是哪一条**。
 * 因此本层的单测采用「每个用例只破坏一个字段、其余全部合法」的构造 ——
 * 用例名与输入构造承担定位职责,错误码本身不具备鉴别力。
 * 若将来要让失败自带定位,应拆分错误码或附 detail,那是行为变更,不属于本次纯迁移。
 */

export function decimalString(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toFixed(4);
}

export function asObject(value: Prisma.JsonValue): Record<string, Prisma.JsonValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : null;
}

export function assertVoidLiveFacts(input: {
  batch: LockedBatch;
  candidates: readonly PersistedCandidate[];
  projections: readonly LockedApplicationProjection[];
  sources: readonly CandidateSource[];
}): void {
  if (
    input.candidates.length !== input.projections.length ||
    input.candidates.length !== input.sources.length
  ) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  const candidateById = new Map(
    input.candidates.map((candidate) => [candidate.allocationCandidateId, candidate]),
  );
  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  const seenIdentities = new Set<string>();
  for (const projection of input.projections) {
    const candidate = candidateById.get(projection.allocationCandidateId);
    const source = sourceById.get(projection.participationIdentityId);
    const candidateWaitlisted = candidate?.resultCode === 'waitlisted';
    const candidateClosedShape = candidateWaitlisted
      ? candidate.waitlistRank !== null &&
        candidate.waitlistRank >= 1 &&
        candidate.waitlistPositionId !== null
      : candidate?.resultCode === 'allocated' || candidate?.resultCode === 'not_selected'
        ? candidate.waitlistRank === null && candidate.waitlistPositionId === null
        : false;
    const expectedRevisionPosition = candidateWaitlisted
      ? (candidate?.waitlistPositionId ?? null)
      : projection.positionId;
    const expectedRevisionWaitlistRank = candidateWaitlisted
      ? (candidate?.waitlistRank ?? null)
      : null;
    if (
      !candidate ||
      !source ||
      !candidateClosedShape ||
      seenIdentities.has(projection.participationIdentityId) ||
      candidate.activityId !== input.batch.activityId ||
      candidate.sessionId !== input.batch.sessionId ||
      candidate.participationIdentityId !== projection.participationIdentityId ||
      candidate.resultCode !== projection.appliedResultCode ||
      source.id !== projection.participationIdentityId ||
      source.activityId !== input.batch.activityId ||
      source.sessionId !== input.batch.sessionId ||
      source.memberId !== projection.memberId ||
      source.participationRevisionId !== projection.appliedParticipationRevisionId ||
      source.participationRevisionStatusCode !== projection.appliedStatusCode ||
      source.participationRevisionPositionId !== expectedRevisionPosition ||
      source.participationRevisionWaitlistRank !== expectedRevisionWaitlistRank ||
      source.participationRevisionAllocationBatchId !== input.batch.id ||
      source.identityStatusCode !== projection.appliedStatusCode ||
      source.currentPositionId !== projection.positionId ||
      source.capacityReservationId !== projection.expectedIdentityCapacityReservationId ||
      source.populationIncluded !== projection.populationIncluded
    ) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
    seenIdentities.add(projection.participationIdentityId);
    if (projection.appliedResultCode === 'allocated') {
      if (
        projection.appliedStatusCode !== 'pass' ||
        !projection.populationIncluded ||
        (input.batch.positionId !== null && projection.positionId !== input.batch.positionId) ||
        projection.expectedIdentityCapacityReservationId === null ||
        projection.activityPersonReservationId === null ||
        projection.activityPersonBucketId === null ||
        projection.sessionReservationId === null ||
        projection.sessionBucketId === null ||
        projection.expectedIdentityCapacityReservationId !== projection.sessionReservationId ||
        (projection.positionId === null
          ? projection.positionReservationId !== null || projection.positionBucketId !== null
          : projection.positionReservationId === null || projection.positionBucketId === null)
      ) {
        throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
      }
      continue;
    }
    if (
      projection.positionId !== null ||
      projection.populationIncluded ||
      projection.expectedIdentityCapacityReservationId !== null ||
      projection.activityPersonReservationId !== null ||
      projection.activityPersonBucketId !== null ||
      projection.sessionReservationId !== null ||
      projection.sessionBucketId !== null ||
      projection.positionReservationId !== null ||
      projection.positionBucketId !== null
    ) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    }
  }
}

export function assertPreparingCandidates(
  batch: LockedBatch,
  candidates: readonly PersistedCandidate[],
): void {
  if (
    candidates.some(
      (candidate) =>
        candidate.activityId !== batch.activityId ||
        candidate.sessionId !== batch.sessionId ||
        candidate.waitlistPositionId !== null ||
        candidate.resultCode !== null ||
        candidate.waitlistRank !== null ||
        candidate.lotteryOrder !== null ||
        candidate.tieBreakKey !== candidate.participationIdentityId,
    )
  ) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  const snapshotHash = createCandidateSnapshotHash({
    activityId: batch.activityId,
    sessionId: batch.sessionId,
    positionId: batch.positionId,
    modeCode: batch.modeCode as AllocationModeCode,
    algorithmVersionCode: batch.algorithmVersionCode,
    candidates: candidates.map((candidate) => ({
      participationIdentityId: candidate.participationIdentityId,
      registrationId: candidate.registrationId,
      registrationRevisionId: candidate.registrationRevisionId,
      acceptedAt: candidate.acceptedAt,
      qualificationSnapshotHash: candidate.qualificationSnapshotHash,
      qualificationScore: decimalString(candidate.qualificationScore),
      tieBreakKey: candidate.tieBreakKey,
    })),
  });
  if (snapshotHash !== batch.candidateSnapshotHash) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
}

export function readReceiptBatchStatusCode(input: {
  activityId: string;
  allocationBatchId: string;
  commandCode: AllocationCommandCode;
  responseSchemaVersion: string;
  responseHash: string;
  responseReceipt: Prisma.JsonValue;
}): ReceiptBatchStatusCode {
  const receipt = asObject(input.responseReceipt);
  const expectedStatusCode: ReceiptBatchStatusCode =
    input.commandCode === 'prepare'
      ? 'preparing'
      : input.commandCode === 'commit'
        ? 'committed'
        : 'voided';
  const expectedResponseHash = createAllocationResponseHash({
    activityId: input.activityId,
    allocationBatchId: input.allocationBatchId,
    commandCode: input.commandCode,
    batchStatusCode: expectedStatusCode,
  });
  if (
    receipt === null ||
    input.responseSchemaVersion !== RESPONSE_SCHEMA_VERSION ||
    input.responseHash !== expectedResponseHash ||
    Object.keys(receipt).length !== 6 ||
    receipt.activityId !== input.activityId ||
    receipt.allocationBatchId !== input.allocationBatchId ||
    receipt.commandCode !== input.commandCode ||
    receipt.batchStatusCode !== expectedStatusCode ||
    receipt.responseSchemaVersion !== RESPONSE_SCHEMA_VERSION ||
    receipt.responseHash !== input.responseHash
  ) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  return expectedStatusCode;
}

export function initialPreferencePositions(
  preferenceSnapshot: Prisma.JsonValue | null,
  batchPositionId: string | null,
): Array<string | null> {
  if (batchPositionId !== null) return [batchPositionId];
  const snapshot = preferenceSnapshot === null ? null : asObject(preferenceSnapshot);
  const positions = snapshot?.positionIds;
  if (!Array.isArray(positions)) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  if (positions.length === 0) return [null];
  if (
    positions.some((position) => typeof position !== 'string' || position.length === 0) ||
    new Set(positions).size !== positions.length
  ) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  return positions as string[];
}

export function assertPendingSource(source: CandidateSource): void {
  if (
    source.identityRevision < 1 ||
    source.registrationCurrentRevision < 1 ||
    source.identityStatusCode !== 'pending' ||
    source.participationRevisionStatusCode !== 'pending' ||
    source.participationRevisionPositionId !== null ||
    source.participationRevisionWaitlistRank !== null ||
    source.participationRevisionAllocationBatchId !== null ||
    source.currentPositionId !== null ||
    source.capacityReservationId !== null ||
    source.populationIncluded
  ) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
}

export function targetProjection(
  evaluation: ActivityQualificationEvaluation,
  sessionId: string,
  positionId: string | null,
): QualificationProjection {
  const projection =
    positionId === null ? evaluation.sessions.get(sessionId) : evaluation.positions.get(positionId);
  if (!projection) throw new BizException(BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID);
  return projection;
}
