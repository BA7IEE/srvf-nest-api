import type { Prisma } from '@prisma/client';

/*
 * 活动名额分配的**核心数据形状**(Phase 6-B 第五域第一刀)。
 *
 * 从 activity-allocation.service.ts 迁出:这些 type 描述「锁定后读到的事实」——
 * 批次、候选人、来源身份、已锁定的申请投影。它们既是服务内部流程的载体,
 * 也是判定函数(activity-allocation-policy.ts)的入参形状,故降为两者共享的独立文件,
 * 避免 policy 反向 import service(即使 type-only 也语义不清)。
 *
 * 纯类型文件:无运行时导出,不进 DI 图。
 */

export const RESPONSE_SCHEMA_VERSION = 'allocation-command-response-v1';

export type AllocationCommandCode = 'prepare' | 'commit' | 'void';

export type ReceiptBatchStatusCode = 'preparing' | 'committed' | 'voided';

export type AllocationResultCode = 'allocated' | 'waitlisted' | 'not_selected';

export type LockedBatch = {
  id: string;
  activityId: string;
  sessionId: string;
  positionId: string | null;
  modeCode: string;
  candidateSnapshotHash: string;
  algorithmVersionCode: string;
  randomCommitment: string | null;
  randomSeedReveal: string | null;
  statusCode: string;
  operationKey: string;
  requestHash: string | null;
  committedAt: Date | null;
  voidReason: string | null;
  voidedAt: Date | null;
};

export type CandidateSource = {
  id: string;
  activityId: string;
  memberId: string;
  sessionId: string;
  registrationId: string;
  identityRevision: number;
  identityStatusCode: string;
  currentPositionId: string | null;
  capacityReservationId: string | null;
  populationIncluded: boolean;
  identityVersion: number;
  registrationCurrentRevision: number;
  registrationRevisionId: string;
  participationRevisionId: string;
  participationRevisionStatusCode: string;
  participationRevisionPositionId: string | null;
  participationRevisionWaitlistRank: number | null;
  participationRevisionAllocationBatchId: string | null;
  acceptedAt: Date;
  preferenceSnapshot: Prisma.JsonValue | null;
};

export type PersistedCandidate = {
  allocationCandidateId: string;
  activityId: string;
  sessionId: string;
  waitlistPositionId: string | null;
  participationIdentityId: string;
  registrationId: string;
  registrationRevisionId: string;
  acceptedAt: Date;
  qualificationSnapshotHash: string;
  qualificationScore: Prisma.Decimal | null;
  tieBreakKey: string;
  lotteryOrder: number | null;
  resultCode: string | null;
  waitlistRank: number | null;
  explanation: Prisma.JsonValue;
};

export type LockedApplicationProjection = {
  id: string;
  allocationCandidateId: string;
  participationIdentityId: string;
  memberId: string;
  appliedParticipationRevisionId: string;
  appliedResultCode: AllocationResultCode;
  appliedStatusCode: 'pass' | 'waitlisted' | 'not_selected';
  positionId: string | null;
  populationIncluded: boolean;
  expectedIdentityCapacityReservationId: string | null;
  activityPersonReservationId: string | null;
  activityPersonBucketId: string | null;
  sessionReservationId: string | null;
  sessionBucketId: string | null;
  positionReservationId: string | null;
  positionBucketId: string | null;
};
