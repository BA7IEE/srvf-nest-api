import type {
  ActivitySettlementTimeRevision,
  ParticipantSettlementTimeBucket,
  ParticipantSettlementTimeBucketSource,
  TimePolicyVersion,
} from '@prisma/client';
import {
  presentParticipantTimeAllocationDetail,
  type ParticipantTimeAllocationDetailRow,
} from './activity-time-allocation.presenter';
import { timePolicyVersionDocument } from './activity-time-policy-presenter';

export function presentTimeSettlementRevision(row: ActivitySettlementTimeRevision) {
  return {
    timeRevisionId: row.id,
    activityId: row.activityId,
    settlementRunId: row.settlementRunId,
    settlementVersionId: row.settlementVersionId,
    revision: row.revision,
    kindCode: row.kindCode,
    sourceDraftTimeRevisionId: row.sourceDraftTimeRevisionId,
    evidenceSealId: row.evidenceSealId,
    evidenceRevision: row.evidenceRevision,
    populationRevision: row.populationRevision,
    workflowRevision: row.workflowRevision,
    bucketContentHash: row.bucketContentHash,
    bucketCount: row.bucketCount,
    sourceCount: row.sourceCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Paged lists deliberately omit reasons, request credentials, full definitions and actor data. */
export function presentTimeSettlementBucket(row: ParticipantSettlementTimeBucket) {
  return {
    bucketId: row.id,
    timeRevisionId: row.timeRevisionId,
    participationIdentityId: row.participationIdentityId,
    categoryCode: row.categoryCode,
    calculatedSeconds: row.calculatedSeconds,
    recognizedSeconds: row.recognizedSeconds,
    rawCalculatedMilliseconds: row.rawCalculatedMilliseconds?.toString() ?? null,
    rawRecognizedMilliseconds: row.rawRecognizedMilliseconds.toString(),
    timePolicyVersionId: row.timePolicyVersionId,
    definitionHash: row.definitionHash,
    evaluatorVersion: row.evaluatorVersion,
    quantumSeconds: row.quantumSeconds,
    hasAdjustment: row.adjustmentReason !== null,
    emptyReasonCode: row.timePolicyVersionId === null ? 'no_valid_segment' : null,
  };
}

export function presentTimeSettlementBucketSource(row: ParticipantSettlementTimeBucketSource) {
  return {
    sourceId: row.id,
    bucketId: row.bucketId,
    timeRevisionId: row.timeRevisionId,
    allocationRevisionId: row.allocationRevisionId,
    sourceSegmentId: row.sourceSegmentId,
    sourceSegmentRevision: row.sourceSegmentRevision,
    rawCalculatedMilliseconds: row.rawCalculatedMilliseconds?.toString() ?? null,
    rawRecognizedMilliseconds: row.rawRecognizedMilliseconds.toString(),
  };
}

/** Authorized single-source drilldown; no attachment URLs, storage keys or personal labels. */
export function presentTimeSettlementAllocation(
  row: ParticipantTimeAllocationDetailRow & { policyVersion: TimePolicyVersion },
) {
  const detail = presentParticipantTimeAllocationDetail(row);
  const policy = timePolicyVersionDocument(row.policyVersion);
  if (
    policy.definitionHash !== row.definitionHash ||
    policy.evaluatorVersion !== row.evaluatorVersion
  )
    throw new TypeError('time settlement frozen policy mismatch');
  return {
    allocationRevisionId: detail.allocationRevisionId,
    activityId: detail.activityId,
    sourceSegmentId: detail.sourceSegmentId,
    sourceSegmentRevision: detail.sourceSegmentRevision,
    revision: detail.revision,
    recognitionModeCode: detail.recognitionModeCode,
    allocationHash: detail.allocationHash,
    sliceCount: detail.sliceCount,
    createdAt: detail.createdAt,
    slices: detail.slices,
    evidence: detail.evidence,
    participationIdentityId: row.participationIdentityId,
    manualReason: row.manualReason,
    settlementDraftVersionId: row.settlementDraftVersionId,
    settlementEvidenceSealId: row.settlementEvidenceSealId,
    policyVersionId: row.policyVersionId,
    definitionHash: row.definitionHash,
    evaluatorVersion: row.evaluatorVersion,
    policy: policy.definition,
    effectiveFrom: policy.effectiveFrom,
    effectiveUntil: policy.effectiveUntil,
  };
}
