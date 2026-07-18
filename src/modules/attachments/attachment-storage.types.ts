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
