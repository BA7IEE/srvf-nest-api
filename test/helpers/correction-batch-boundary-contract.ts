/** Test specification, not an authorization decision or a substitute for PG.
 * Every database case must use the same candidate and report its real outcome.
 */
export const CORRECTION_BOUNDARY_WRITERS = [
  {
    table: 'CorrectionApplication',
    writer: 'AttendanceCorrectionWriteService.createApplication/markApplicationCommitted',
    phase: 'parent',
  },
  {
    table: 'AttendanceCorrectionRequest',
    writer: 'AttendanceCorrectionWriteService.markRequestApplying/markRequestApplied',
    phase: 'parent',
  },
  {
    table: 'CorrectionPendingSegmentRevision',
    writer: 'CorrectionApplicationService.prepareV3PendingSegments',
    phase: 'prepare',
  },
  {
    table: 'CorrectionSegmentPreparationReceipt',
    writer: 'CorrectionApplicationService.prepareV3PendingSegments',
    phase: 'prepare',
  },
  {
    table: 'CorrectionSegmentCleanupReceipt',
    writer: 'cleanup_correction_pending_segment',
    phase: 'legacy-cleanup',
  },
  {
    table: 'CorrectionPendingTimeAllocation',
    writer: 'CorrectionTimeAllocationService.prepare',
    phase: 'prepare',
  },
  {
    table: 'CorrectionPendingTimeAllocationEvidence',
    writer: 'CorrectionTimeAllocationService.prepare',
    phase: 'prepare',
  },
  {
    table: 'CorrectionTimeSourceProof',
    writer: 'CorrectionTimeAllocationService.createProof',
    phase: 'prepare',
  },
  {
    table: 'CorrectionTimeAllocationBinding',
    writer: 'CorrectionTimeAllocationService.materialize',
    phase: 'commit',
  },
  {
    table: 'ParticipationTimeCorrectionManifest',
    writer: 'ParticipationTimeCorrectionService.prepare',
    phase: 'prepare',
  },
  {
    table: 'LedgerPostingBatch',
    writer: 'CorrectionApplicationService.prepare/LedgerPostingService.commitBatchWithin',
    phase: 'parent',
  },
] as const;

export const CORRECTION_BOUNDARY_NAMED_CONSTRAINTS = [
  'correction_application_preparation_receipt_required',
  'correction_pending_lifecycle_check',
  'correction_preparation_lifecycle_check',
  'correction_cleanup_lifecycle_check',
  'cpta_lifecycle_guard',
  'cptae_lifecycle_guard',
  'ctsp_lifecycle_proof_guard',
  'ctsp_lifecycle_batch_guard',
] as const;

export const CORRECTION_BOUNDARY_REQUIRED_CASES = [
  'valid prepare then commit',
  'prepare failure restores pre-prepare state',
  'commit failure retains committed prepared state',
  'missing begin rejects pending write',
  'missing seal rejects COMMIT',
  'write after seal rejects',
  'immediate constraint while OPEN rejects',
  'immediate constraint after SEALED fully checks',
  'invalid ON CONFLICT ignored attempt rejects',
  'duplicate approved items preserve matcher semantics',
  'NULL missing and invalid casts preserve rejection',
  'source revision cannot be supplied by caller',
  'approved source change does not re-authorize old application',
  'savepoint rollback restores phase and facts',
  'nested statement cannot escape phase',
  'two sessions cannot share or reopen phase',
  'caller cannot own source or maintenance objects',
  'caller cannot write derived approved items',
  'source SELECT and RLS visibility remain authoritative',
  'direct SQL cannot omit phase',
  'V1 V2 and non-correction batch keep original rules',
  'operator cleanup keeps receipt and original limit',
  'replay does not write or duplicate audit/outbox',
] as const;

export const CORRECTION_BOUNDARY_FULL_SHAPES = [
  { identities: 2000, sources: 10000, changedSegments: 1, bindings: 10000 },
  { identities: 2000, sources: 10000, changedSegments: 1000, bindings: 10000 },
  { identities: 2000, sources: 10000, changedSegments: 10000, bindings: 10000 },
] as const;

/** Independent reference for assertions; production still owns actual budgets. */
export const CORRECTION_BOUNDARY_BUDGETS_MS = {
  prepare: 120000,
  humanCommit: 15000,
  standardCommit: 7000,
  nativeE4Commit: 60000,
  memberLock: 4000,
} as const;
