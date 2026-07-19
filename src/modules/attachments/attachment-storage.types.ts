import type { Prisma, Role } from '@prisma/client';

import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type {
  AttachmentDeleteReplayResponse,
  AttachmentDeleteAuditEnvelope,
} from '../storage/storage-operation-payload';
import type { StorageObjectLocator } from '../storage/storage.types';

export interface AttachmentUploadStorageIdentity {
  key: string;
  ownerType: string;
  ownerId: string;
  originalName: string;
  mime: string;
  size: number;
  uploadedByUserId: string;
  iat?: number;
  exp?: number;
}

export interface PreparedAttachmentStorageUpload {
  objectId: string;
  operationId: string;
  eventKey: string;
  requestHash: string;
  locator: StorageObjectLocator;
}

export interface FinalizeAttachmentStorageUploadInput {
  identity: AttachmentUploadStorageIdentity;
  requestHash: string;
  data: Prisma.AttachmentUncheckedCreateInput;
  auditKind: 'legacy' | 'confirmed';
  actorRoleSnap: Role;
  scope: 'self' | 'other' | null;
  ownerTable: string;
  auditMeta: AuditMeta;
}

/**
 * Trusted input from Content after coarse authorization and while its root row is already locked.
 * The facade validates every current binding plus body/cover references without reading Content.
 */
export interface ContentPublishStorageBoundaryInput {
  contentId: string;
  referencedAttachmentIds: readonly string[];
  coverAttachmentId: string | null;
  coverImageKey: string | null;
}

export type ContentAttachmentOwnerType = 'content-image' | 'content-file';

/**
 * Expected route owner supplied before Content is read. A Content wrapper that accepts either
 * attachment kind passes both allowlisted owner types; a kind-specific caller passes one.
 */
export interface ContentUploadConfirmExpectedOwner {
  ownerType: ContentAttachmentOwnerType | readonly ContentAttachmentOwnerType[];
  ownerId: string;
}

// These handles intentionally expose no claims, key, owner id, Provider evidence, or audit data.
// Only the AttachmentsService instance that issued a handle can advance it exactly once; runtime
// WeakMap checks reject consumed/forged/cross-instance handles in addition to these compile-time
// brands. A failed transition also consumes its input, so callers must restart from the guard.
declare const contentUploadConfirmGuardBrand: unique symbol;
declare const contentUploadConfirmPreparedBrand: unique symbol;
declare const contentUploadConfirmVerifiedBrand: unique symbol;
declare const contentUploadConfirmFinalizedBrand: unique symbol;

export type ContentUploadConfirmGuard = Readonly<{
  [contentUploadConfirmGuardBrand]: never;
}>;

export type ContentUploadConfirmPrepared = Readonly<{
  [contentUploadConfirmPreparedBrand]: never;
}>;

export type ContentUploadConfirmVerified = Readonly<{
  [contentUploadConfirmVerifiedBrand]: never;
}>;

export type ContentUploadConfirmFinalized = Readonly<{
  [contentUploadConfirmFinalizedBrand]: never;
}>;

export interface PrepareAttachmentDeleteInput {
  attachmentId: string;
  actorUserId: string;
  actorRoleSnap: Role;
  // Only the already-authorized HTTP path may join another actor's still-active delete.
  // Missing-row replay must never set this flag, preserving the anti-enumeration boundary.
  allowAuthorizedJoin: boolean;
  scope: 'self' | 'other' | null;
  deletedByPath: 'owner' | 'admin';
  auditMeta: AuditMeta;
}

export interface AttachmentDeleteReplay {
  state: 'pending' | 'succeeded' | 'dead';
  eventKey: string;
  response: AttachmentDeleteReplayResponse | null;
}

export interface ManualStorageEvidenceInput {
  replayOperationId: string;
  operatorUserId: string;
  reviewerUserId: string;
  reasonCode: string;
  evidenceRef: string;
  verifiedAt: Date;
}

export interface PrepareManualStorageRelocateInput extends ManualStorageEvidenceInput {
  targetLocator: StorageObjectLocator;
}

export type PrepareManualStorageAttestAbsentInput = ManualStorageEvidenceInput;

export function deleteAuditEnvelope(
  input: PrepareAttachmentDeleteInput,
): AttachmentDeleteAuditEnvelope {
  return {
    actorUserId: input.actorUserId,
    actorRoleSnap: input.actorRoleSnap,
    scope: input.scope,
    deletedByPath: input.deletedByPath,
    requestId: input.auditMeta.requestId,
    ip: input.auditMeta.ip,
    ua: input.auditMeta.ua,
  };
}
