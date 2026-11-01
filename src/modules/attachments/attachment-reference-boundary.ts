import { findOwnedAttachments, lockOwnerReferenceBoundary } from './attachment-content-boundary';

/** The existing transaction-only content checks, without Storage lifecycle or
 * provider effects. Keep both methods and their original SQL/lock semantics. */
export const attachmentReferenceBoundary = Object.freeze({
  findOwnedAttachmentsTrusted: findOwnedAttachments,
  lockOwnerReferenceStorageBoundaryTrusted: lockOwnerReferenceBoundary,
});
