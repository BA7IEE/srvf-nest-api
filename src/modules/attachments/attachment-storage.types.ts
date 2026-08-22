import type { Prisma, Role } from '@prisma/client';

import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type {
  AttachmentDeleteReplayResponse,
  AttachmentDeleteAuditEnvelope,
} from '../storage/storage-operation-payload';
import type { StorageObjectLocator } from '../storage/storage.types';
import type { AttachmentOwnerType } from './attachment-validation';

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

/**
 * A Content writer already holds the aggregate root and is about to persist new attachment
 * references. Missing/foreign ids retain the Content module's existing placeholder semantics;
 * matching owned attachments must not be in a delete lifecycle.
 */
export interface ContentAttachmentReferenceBoundaryInput {
  contentId: string;
  referencedAttachmentIds: readonly string[];
}

/**
 * Ownership lookup input for the owner-scoped facade (P2-14). Callers outside the attachments
 * module must never query `Attachment` themselves — ownership is this module's fact.
 */
export interface OwnerAttachmentLookupInput {
  ownerId: string;
  ownerTypes: readonly AttachmentOwnerType[];
  attachmentIds: readonly string[];
}

/**
 * Owner-generic form of the Content writer fence (P2-14). Content passes its two owner types; the
 * Activity cover/gallery writer passes `['activity']`. Both reach the same implementation on
 * purpose — a second copy of "what counts as a legal reference" drifts silently.
 */
export interface OwnerAttachmentReferenceBoundaryInput {
  ownerId: string;
  ownerTypes: readonly AttachmentOwnerType[];
  referencedAttachmentIds: readonly string[];
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

// Registration upload-session uses a separate opaque capability family. These handles never
// expose the token, session binding, storage key/locator, Provider evidence or audit envelope.
declare const registrationUploadValidatedBrand: unique symbol;
declare const registrationUploadPreparedBrand: unique symbol;
declare const registrationUploadVerifiedBrand: unique symbol;
declare const registrationUploadFinalizedBrand: unique symbol;

export type RegistrationUploadValidated = Readonly<{
  [registrationUploadValidatedBrand]: never;
}>;

export type RegistrationUploadPrepared = Readonly<{
  [registrationUploadPreparedBrand]: never;
}>;

export type RegistrationUploadVerified = Readonly<{
  [registrationUploadVerifiedBrand]: never;
}>;

export type RegistrationUploadFinalized = Readonly<{
  [registrationUploadFinalizedBrand]: never;
}>;

// issue #1055 T2:视觉身份(账号头像 / 队员标准照)的可信 facade 句柄族。
// 与 registration-upload-session 同构:四个阶段各一个不可伪造的不透明句柄,
// 内部的 storage key / locator / Provider 证据 / 审计信封一律不外泄。
//
// **两个 owner type 共用同一族句柄**,因为它们的存储机制逐字相同 ——
// 差别只在图片规格与落库时的领域不变量,而后者归调用方(T3 users / T4 members)的事务管。
// kind 记在句柄背后的 state 里,由 facade 在每一阶段自行读取,调用方无从中途改写。
declare const visualIdentityUploadValidatedBrand: unique symbol;
declare const visualIdentityUploadPreparedBrand: unique symbol;
declare const visualIdentityUploadVerifiedBrand: unique symbol;
declare const visualIdentityUploadFinalizedBrand: unique symbol;

export type VisualIdentityUploadValidated = Readonly<{
  [visualIdentityUploadValidatedBrand]: never;
}>;

export type VisualIdentityUploadPrepared = Readonly<{
  [visualIdentityUploadPreparedBrand]: never;
}>;

export type VisualIdentityUploadVerified = Readonly<{
  [visualIdentityUploadVerifiedBrand]: never;
}>;

export type VisualIdentityUploadFinalized = Readonly<{
  [visualIdentityUploadFinalizedBrand]: never;
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
