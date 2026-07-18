import { Role, type Prisma } from '@prisma/client';

import type { StorageObjectLocator } from './storage.types';
import {
  STORAGE_OPERATION_PAYLOAD_VERSION,
  type StorageOperationKind,
  StorageConsistencyInvariantError,
} from './storage-consistency.types';

export interface AttachmentDeleteReplayResponse {
  id: string;
  key: string;
  originalName: string;
  mime: string;
  size: number;
  uploadedBy: string;
  uploadedAt: string;
  ownerType: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  description: null;
  accessLevel: null;
  tags: [];
  originalUploaderName: null;
  expireAt: null;
  accessUrl: null;
}

export interface AttachmentDeleteAuditEnvelope {
  actorUserId: string;
  actorRoleSnap: Role;
  scope: 'self' | 'other' | null;
  deletedByPath: 'owner' | 'admin';
  requestId: string;
  ip: string | null;
  ua: string | null;
}

export interface AttachmentDeleteOperationPayload {
  response: AttachmentDeleteReplayResponse | null;
  audit: AttachmentDeleteAuditEnvelope;
}

export interface ManualStorageOperationPayload {
  operatorUserId: string;
  reviewerUserId: string;
  reasonCode: string;
  evidenceRef: string;
  verifiedAt: string;
  targetLocator?: StorageObjectLocator;
}

export type KnownStorageOperationPayload =
  | { source: 'attachment_signed_upload' | 'attachment_legacy' }
  | AttachmentDeleteOperationPayload
  | Record<string, never>
  | { attachmentId: string }
  | ManualStorageOperationPayload;

const INTERNAL_ID = /^[A-Za-z0-9_-]{8,80}$/;
const REASON_CODE = /^[a-z][a-z0-9_-]{2,63}$/;
const EVIDENCE_REF = /^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,11}$/;
const FORBIDDEN_KEY = /(token|secret|credential|signed.?url|upload.?url|download.?url)/i;

export function parseStorageOperationPayload(
  kind: StorageOperationKind,
  payloadVersion: number,
  value: unknown,
): KnownStorageOperationPayload {
  if (payloadVersion !== STORAGE_OPERATION_PAYLOAD_VERSION || !isRecord(value)) {
    throw payloadError(kind, 'invalid version or root shape');
  }
  rejectForbiddenKeys(value, '$');
  switch (kind) {
    case 'attachment_upload_verify': {
      exactKeys(value, ['source'], kind);
      if (value.source !== 'attachment_signed_upload' && value.source !== 'attachment_legacy') {
        throw payloadError(kind, 'invalid source');
      }
      return { source: value.source };
    }
    case 'attachment_delete':
      return parseDeletePayload(value, kind);
    case 'orphan_delete':
      exactKeys(value, [], kind);
      return {};
    case 'backfill_verify':
      exactKeys(value, ['attachmentId'], kind);
      return { attachmentId: internalId(value.attachmentId, kind) };
    case 'manual_relocate':
      return parseManualPayload(value, kind, true);
    case 'manual_attest_absent':
      return parseManualPayload(value, kind, false);
  }
}

export function toStorageJson(value: KnownStorageOperationPayload): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

export function sanitizeDeletePayloadAfterTerminal(
  payload: AttachmentDeleteOperationPayload,
): AttachmentDeleteOperationPayload {
  return { ...payload, audit: { ...payload.audit, ip: null, ua: null } };
}

export function purgeDeletePayload(
  payload: AttachmentDeleteOperationPayload,
): AttachmentDeleteOperationPayload {
  return {
    response: null,
    audit: { ...payload.audit, ip: null, ua: null },
  };
}

function parseDeletePayload(
  value: Record<string, unknown>,
  kind: StorageOperationKind,
): AttachmentDeleteOperationPayload {
  exactKeys(value, ['response', 'audit'], kind);
  if (!isRecord(value.audit)) throw payloadError(kind, 'invalid audit envelope');
  exactKeys(
    value.audit,
    ['actorUserId', 'actorRoleSnap', 'scope', 'deletedByPath', 'requestId', 'ip', 'ua'],
    kind,
  );
  const role = value.audit.actorRoleSnap;
  if (!isRole(role)) {
    throw payloadError(kind, 'invalid actor role');
  }
  const scope = value.audit.scope;
  if (scope !== null && scope !== 'self' && scope !== 'other') {
    throw payloadError(kind, 'invalid scope');
  }
  const deletedByPath = value.audit.deletedByPath;
  if (deletedByPath !== 'owner' && deletedByPath !== 'admin') {
    throw payloadError(kind, 'invalid deletedByPath');
  }
  const audit: AttachmentDeleteAuditEnvelope = {
    actorUserId: internalId(value.audit.actorUserId, kind),
    actorRoleSnap: role,
    scope,
    deletedByPath,
    requestId: boundedString(value.audit.requestId, 1, 160, kind),
    ip: nullableString(value.audit.ip, 160, kind),
    ua: nullableString(value.audit.ua, 1000, kind),
  };
  if (value.response === null) return { response: null, audit };
  if (!isRecord(value.response)) throw payloadError(kind, 'invalid response');
  const responseKeys = [
    'id',
    'key',
    'originalName',
    'mime',
    'size',
    'uploadedBy',
    'uploadedAt',
    'ownerType',
    'ownerId',
    'createdAt',
    'updatedAt',
    'description',
    'accessLevel',
    'tags',
    'originalUploaderName',
    'expireAt',
    'accessUrl',
  ];
  exactKeys(value.response, responseKeys, kind);
  if (
    value.response.description !== null ||
    value.response.accessLevel !== null ||
    !Array.isArray(value.response.tags) ||
    value.response.tags.length !== 0 ||
    value.response.originalUploaderName !== null ||
    value.response.expireAt !== null ||
    value.response.accessUrl !== null
  ) {
    throw payloadError(kind, 'optional response fields must be minimized');
  }
  const size = value.response.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    throw payloadError(kind, 'invalid response size');
  }
  const response: AttachmentDeleteReplayResponse = {
    id: internalId(value.response.id, kind),
    key: boundedString(value.response.key, 1, 256, kind),
    originalName: boundedString(value.response.originalName, 1, 255, kind),
    mime: boundedString(value.response.mime, 1, 128, kind),
    size,
    uploadedBy: internalId(value.response.uploadedBy, kind),
    uploadedAt: isoDate(value.response.uploadedAt, kind),
    ownerType: boundedString(value.response.ownerType, 1, 64, kind),
    ownerId: internalId(value.response.ownerId, kind),
    createdAt: isoDate(value.response.createdAt, kind),
    updatedAt: isoDate(value.response.updatedAt, kind),
    description: null,
    accessLevel: null,
    tags: [],
    originalUploaderName: null,
    expireAt: null,
    accessUrl: null,
  };
  return { response, audit };
}

function parseManualPayload(
  value: Record<string, unknown>,
  kind: StorageOperationKind,
  requireTarget: boolean,
): ManualStorageOperationPayload {
  exactKeys(
    value,
    requireTarget
      ? [
          'operatorUserId',
          'reviewerUserId',
          'reasonCode',
          'evidenceRef',
          'verifiedAt',
          'targetLocator',
        ]
      : ['operatorUserId', 'reviewerUserId', 'reasonCode', 'evidenceRef', 'verifiedAt'],
    kind,
  );
  const operatorUserId = internalId(value.operatorUserId, kind);
  const reviewerUserId = internalId(value.reviewerUserId, kind);
  if (reviewerUserId === operatorUserId) {
    throw payloadError(kind, 'operator and reviewer must be different users');
  }
  if (typeof value.reasonCode !== 'string' || !REASON_CODE.test(value.reasonCode)) {
    throw payloadError(kind, 'invalid reasonCode');
  }
  if (typeof value.evidenceRef !== 'string' || !EVIDENCE_REF.test(value.evidenceRef)) {
    throw payloadError(kind, 'evidenceRef must be an internal ticket id');
  }
  const parsed: ManualStorageOperationPayload = {
    operatorUserId,
    reviewerUserId,
    reasonCode: value.reasonCode,
    evidenceRef: value.evidenceRef,
    verifiedAt: isoDate(value.verifiedAt, kind),
  };
  if (requireTarget) parsed.targetLocator = parseLocator(value.targetLocator, kind);
  return parsed;
}

function parseLocator(value: unknown, kind: StorageOperationKind): StorageObjectLocator {
  if (!isRecord(value)) throw payloadError(kind, 'invalid targetLocator');
  exactKeys(value, ['providerType', 'bucket', 'region', 'localNamespace'], kind);
  if (value.providerType === 'COS') {
    return {
      providerType: 'COS',
      bucket: boundedString(value.bucket, 1, 255, kind),
      region: boundedString(value.region, 1, 255, kind),
      localNamespace: nullableMustBeNull(value.localNamespace, kind),
    };
  }
  if (value.providerType === 'LOCAL') {
    if (value.bucket !== null || value.region !== null) {
      throw payloadError(kind, 'LOCAL target cannot contain bucket/region');
    }
    return {
      providerType: 'LOCAL',
      bucket: null,
      region: null,
      localNamespace: boundedString(value.localNamespace, 1, 1024, kind),
    };
  }
  throw payloadError(kind, 'invalid target providerType');
}

function rejectForbiddenKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => rejectForbiddenKeys(child, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) {
      throw new StorageConsistencyInvariantError(`operation payload forbidden key ${path}.${key}`);
    }
    rejectForbiddenKeys(child, `${path}.${key}`);
  }
}

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
  kind: StorageOperationKind,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw payloadError(kind, `unexpected keys=${actual.join(',')}`);
  }
}

function internalId(value: unknown, kind: StorageOperationKind): string {
  if (typeof value !== 'string' || !INTERNAL_ID.test(value)) {
    throw payloadError(kind, 'invalid internal id');
  }
  return value;
}

function boundedString(
  value: unknown,
  min: number,
  max: number,
  kind: StorageOperationKind,
): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw payloadError(kind, 'invalid bounded string');
  }
  return value;
}

function nullableString(value: unknown, max: number, kind: StorageOperationKind): string | null {
  if (value === null) return null;
  return boundedString(value, 1, max, kind);
}

function isoDate(value: unknown, kind: StorageOperationKind): string {
  if (typeof value !== 'string') throw payloadError(kind, 'invalid date');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw payloadError(kind, 'invalid ISO date');
  }
  return value;
}

function nullableMustBeNull(value: unknown, kind: StorageOperationKind): null {
  if (value !== null) throw payloadError(kind, 'field must be null');
  return null;
}

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && Object.values(Role).some((candidate) => candidate === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function payloadError(
  kind: StorageOperationKind,
  reason: string,
): StorageConsistencyInvariantError {
  return new StorageConsistencyInvariantError(`invalid ${kind}@1 payload: ${reason}`);
}
