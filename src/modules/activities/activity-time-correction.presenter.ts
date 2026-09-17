import type {
  CorrectionCommitResult,
  CorrectionPrepareResult,
  CorrectionResubmitOutcome,
  CorrectionReviewOutcome,
  CorrectionSubmitResult,
} from './correction-application.service';

type CorrectionListRow = {
  id: string;
  version: number;
  baseSettlementVersionId: string;
  statusCode: string;
  submittedAt: Date;
  reviewedAt: Date | null;
};

/**
 * The App correction surface is deliberately an allow-list presenter.  The
 * immutable domain records carry actor, operation and internal linkage facts;
 * none of those are returned merely because an HTTP handler happens to have
 * the record in memory.
 */
export function presentActivityTimeCorrectionListItem(row: CorrectionListRow) {
  return {
    requestId: row.id,
    requestVersion: row.version,
    baseSettlementVersionId: row.baseSettlementVersionId,
    statusCode: row.statusCode,
    submittedAt: row.submittedAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
  };
}

export function presentActivityTimeCorrectionSubmit(result: CorrectionSubmitResult) {
  return {
    requestId: result.correctionRequestId,
    requestVersion: result.requestVersion,
    activityId: result.activityId,
    settlementRunId: result.settlementRunId,
    baseSettlementVersionId: result.baseSettlementVersionId,
    baseResultRevisionId: result.baseResultRevisionId,
    baseClosureRevision: result.baseClosureRevision,
    statusCode: result.statusCode,
    replayed: result.replayed,
  };
}

export function presentActivityTimeCorrectionResubmit(outcome: CorrectionResubmitOutcome) {
  if (outcome.outcome === 'voided') {
    return {
      outcome: outcome.outcome,
      requestId: outcome.correctionRequestId,
      currentSettlementVersionId: outcome.currentSettlementVersionId,
    };
  }
  return { outcome: outcome.outcome, ...presentActivityTimeCorrectionSubmit(outcome) };
}

export function presentActivityTimeCorrectionReview(outcome: CorrectionReviewOutcome) {
  if (outcome.outcome === 'voided') {
    return {
      outcome: outcome.outcome,
      requestId: outcome.correctionRequestId,
      currentSettlementVersionId: outcome.currentSettlementVersionId,
    };
  }
  return {
    outcome: outcome.outcome,
    requestId: outcome.correctionRequestId,
    statusCode: outcome.statusCode,
    runStatus: outcome.runStatus,
    reviewedByUserId: outcome.reviewedByUserId,
    replayed: outcome.replayed,
  };
}

export function presentActivityTimeCorrectionPrepare(
  result: CorrectionPrepareResult,
  frozen: { requestHash: string; sourceProofHash: string | null },
) {
  return {
    requestId: result.correctionRequestId,
    applicationId: result.correctionApplicationId,
    postingBatchId: result.newPostingBatchId,
    settlementVersionId: result.newSettlementVersionId,
    requestHash: frozen.requestHash,
    sourceProofHash: frozen.sourceProofHash,
    replayed: result.replayed,
  };
}

export function presentActivityTimeCorrectionCommit(result: CorrectionCommitResult) {
  return {
    requestId: result.correctionRequestId,
    applicationId: result.correctionApplicationId,
    postingBatchId: result.ledger.postingBatchId,
    settlementVersionId: result.ledger.settlementVersionId,
    settlementVersion: result.ledger.settlementVersion,
    correctionStatus: result.correctionStatus,
    applicationStatus: result.applicationStatus,
    replayed: result.replayed,
  };
}

export function presentActivityTimeCorrectionDetail(
  row: CorrectionListRow & {
    requestTypeCode: string;
    requestedChangeJson: Record<string, unknown> | null;
    reason: string | null;
    attachmentIds: string[] | null;
    reviewNote: string | null;
    resubmittedFromRequestId: string | null;
    resubmittedSuccessorRequestId: string | null;
    sourceProofHash: string | null;
    evidenceStatusCode: 'not_frozen' | 'frozen';
    sourcePage: {
      items: Record<string, unknown>[];
      total: number;
      page: number;
      pageSize: number;
    } | null;
  },
) {
  return {
    ...presentActivityTimeCorrectionListItem(row),
    requestTypeCode: row.requestTypeCode,
    requestedChangeJson: row.requestedChangeJson,
    reason: row.reason,
    attachmentIds: row.attachmentIds,
    reviewNote: row.reviewNote,
    resubmittedFromRequestId: row.resubmittedFromRequestId,
    resubmittedSuccessorRequestId: row.resubmittedSuccessorRequestId,
    sourceProofHash: row.sourceProofHash,
    evidenceStatusCode: row.evidenceStatusCode,
    sourcePage: row.sourcePage,
  };
}
