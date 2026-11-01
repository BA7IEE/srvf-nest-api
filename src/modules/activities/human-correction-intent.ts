import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { fingerprintMetricEnvelope } from './activity-metric-definition';

export const HUMAN_CORRECTION_JOB_TYPE = 'human_correction_commit';
export interface HumanCorrectionJobPayload {
  action: 'human_correction_commit';
  schemaVersion: 2 | 3;
  activityId: string;
  requestId: string;
  applicationId: string;
  settlementRunId: string;
  newSettlementVersionId: string;
  rootManifestId: string;
  postingBatchId: string;
  baseSettlementVersionId: string;
  actorUserId: string;
  operationKey: string;
  commitRequestHash: string;
  sourceRequestHash: string;
  sourceProofHash: string | null;
  segmentCount: number;
}
export interface HumanCorrectionJobFence {
  jobId: string;
  leaseOwner: string;
  leaseGeneration: number;
  payload: HumanCorrectionJobPayload;
  intentItemId: string;
  intentHash: string;
  itemEpoch: number;
}
export class HumanCorrectionLeaseLostError extends Error {}
export const humanCorrectionJobHash = (payload: HumanCorrectionJobPayload) =>
  fingerprintMetricEnvelope('human-correction-background-v1', payload).definitionHash;

export function parseHumanCorrectionJobPayload(value: unknown): HumanCorrectionJobPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BizException(BizCode.CORRECTION_APPLY_STATUS_INVALID);
  const keys = [
    'activityId',
    'requestId',
    'applicationId',
    'settlementRunId',
    'newSettlementVersionId',
    'rootManifestId',
    'postingBatchId',
    'baseSettlementVersionId',
    'actorUserId',
    'operationKey',
    'commitRequestHash',
    'sourceRequestHash',
  ];
  if (
    Reflect.get(value, 'action') !== HUMAN_CORRECTION_JOB_TYPE ||
    (Reflect.get(value, 'schemaVersion') !== 2 && Reflect.get(value, 'schemaVersion') !== 3) ||
    Object.keys(value).some(
      (key) =>
        ![...keys, 'action', 'schemaVersion', 'sourceProofHash', 'segmentCount'].includes(key),
    ) ||
    keys.some((key) => typeof Reflect.get(value, key) !== 'string' || !Reflect.get(value, key)) ||
    !(
      Reflect.get(value, 'sourceProofHash') === null ||
      typeof Reflect.get(value, 'sourceProofHash') === 'string'
    ) ||
    !Number.isSafeInteger(Reflect.get(value, 'segmentCount')) ||
    (Reflect.get(value, 'schemaVersion') === 2
      ? Reflect.get(value, 'segmentCount') !== 0
      : Reflect.get(value, 'segmentCount') < 1)
  )
    throw new BizException(BizCode.CORRECTION_APPLY_STATUS_INVALID);
  return value as HumanCorrectionJobPayload;
}

export type HumanCorrectionJobClaim = Omit<
  HumanCorrectionJobFence,
  'intentItemId' | 'intentHash' | 'itemEpoch'
>;
export const HUMAN_CORRECTION_ITEM_KEY = 'human-correction-commit:v2';
export const HUMAN_CORRECTION_UNCONFIRMED = 'HUMAN_CORRECTION_OUTCOME_UNCONFIRMED';
export const HUMAN_CORRECTION_UNAPPLIED = 'HUMAN_CORRECTION_CONFIRMED_UNAPPLIED';
export class HumanCorrectionAuthorityUnavailableError extends Error {
  constructor() {
    super('HumanCorrectionAuthorityUnavailable');
  }
}
export function humanCorrectionItemHash(jobId: string, payload: HumanCorrectionJobPayload) {
  return fingerprintMetricEnvelope('human-correction-item-intent-v2', {
    jobId,
    itemKey: HUMAN_CORRECTION_ITEM_KEY,
    resourceType: 'CorrectionApplication',
    resourceId: payload.applicationId,
    payload: parseHumanCorrectionJobPayload(payload),
  }).definitionHash;
}
export interface HumanCorrectionIntent {
  readonly id: string;
  readonly jobId: string;
  readonly intentHash: string;
  readonly itemEpoch: number;
  readonly statusCode: 'pending' | 'processing' | 'failed' | 'succeeded';
  readonly lastErrorCode: string | null;
  readonly resultReference: string | null;
}
export function assertHumanCorrectionFence(fence: HumanCorrectionJobFence) {
  if (
    typeof fence.intentItemId !== 'string' ||
    !fence.intentItemId ||
    !Number.isSafeInteger(fence.itemEpoch) ||
    fence.itemEpoch < 1 ||
    fence.intentHash !== humanCorrectionItemHash(fence.jobId, fence.payload)
  )
    throw new HumanCorrectionLeaseLostError();
}
