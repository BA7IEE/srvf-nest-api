import { createHash } from 'node:crypto';

import type { StorageObject, StorageObjectOperation } from '@prisma/client';

import type { StorageObjectLocator } from './storage.types';

export const STORAGE_OBJECT_STATES = [
  'pending_upload',
  'present_unbound',
  'available',
  'delete_pending',
  'delete_failed',
  'absent',
  'missing',
  'integrity_mismatch',
  'legacy_unverified',
  'provider_unknown',
] as const;
export type StorageObjectState = (typeof STORAGE_OBJECT_STATES)[number];

export const STORAGE_OBJECT_SOURCES = [
  'attachment_signed_upload',
  'attachment_legacy',
  'backfill',
] as const;
export type StorageObjectSource = (typeof STORAGE_OBJECT_SOURCES)[number];

export const STORAGE_OPERATION_KINDS = [
  'attachment_upload_verify',
  'attachment_delete',
  'orphan_delete',
  'backfill_verify',
  'manual_relocate',
  'manual_attest_absent',
] as const;
export type StorageOperationKind = (typeof STORAGE_OPERATION_KINDS)[number];

export const STORAGE_OPERATION_STATUSES = ['pending', 'processing', 'succeeded', 'dead'] as const;
export type StorageOperationStatus = (typeof STORAGE_OPERATION_STATUSES)[number];

export const STORAGE_EFFECT_STATES = [
  'not_started',
  'provider_unknown',
  'provider_present',
  'provider_absent',
  'effect_started',
  'effect_succeeded',
] as const;
export type StorageEffectState = (typeof STORAGE_EFFECT_STATES)[number];

export const STORAGE_STRICT_METADATA_STATES = ['available'] as const;
export const STORAGE_JIT_METADATA_STATES = [
  'available',
  'legacy_unverified',
  'provider_unknown',
] as const;

export const STORAGE_OPERATION_PAYLOAD_VERSION = 1;
export const STORAGE_OPERATION_MAX_ATTEMPTS = 20;
export const STORAGE_OPERATION_LEASE_MS = 30_000;
export const STORAGE_OPERATION_CLAIM_BATCH = 20;
export const STORAGE_OPERATION_BACKOFF_BASE_MS = 1_000;
export const STORAGE_OPERATION_BACKOFF_MAX_MS = 300_000;
export const STORAGE_UNBOUND_GRACE_MS = 15 * 60 * 1000;
export const STORAGE_DELETE_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
export const STORAGE_DELETE_REPLAY_PHYSICAL_LIMIT_MS = 48 * 60 * 60 * 1000;

export type ClaimedStorageObjectOperation = StorageObjectOperation & {
  status: 'processing';
  leaseOwner: string;
  leaseGeneration: number;
  leaseAcquiredAt: Date;
  leaseExpiresAt: Date;
};

export type ClaimedStorageOperationWithObject = ClaimedStorageObjectOperation & {
  storageObject: StorageObject;
};

export interface NormalizedStorageError {
  code: string;
  errorClass: string;
}

export class StorageConsistencyInvariantError extends Error {
  constructor(message: string) {
    super(`STORAGE_CONSISTENCY_INVARIANT: ${message}`);
    this.name = 'StorageConsistencyInvariantError';
  }
}

export class StorageConsistencyLeaseLostError extends Error {
  constructor(id: string, generation: number) {
    super(`STORAGE_CONSISTENCY_LEASE_LOST: ${id}@${generation}`);
    this.name = 'StorageConsistencyLeaseLostError';
  }
}

export function bigintSize(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StorageConsistencyInvariantError(`invalid storage size=${value}`);
  }
  return BigInt(value);
}

export function storageRequestHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function storageRetryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(Math.trunc(attempts) - 1, 20));
  return Math.min(
    STORAGE_OPERATION_BACKOFF_BASE_MS * 2 ** exponent,
    STORAGE_OPERATION_BACKOFF_MAX_MS,
  );
}

export function normalizeStorageError(error: unknown): NormalizedStorageError {
  if (error instanceof Error) {
    return {
      code: errorCode(error),
      errorClass: boundedErrorLabel(error.name, 'Error'),
    };
  }
  if (isRecord(error)) {
    return {
      code: errorCode(error),
      errorClass: boundedErrorLabel(error.name, 'UnknownStorageError'),
    };
  }
  return {
    code: 'STORAGE_OPERATION_ERROR',
    errorClass: 'UnknownStorageError',
  };
}

export function sameStorageLocator(
  left: StorageObjectLocator,
  right: StorageObjectLocator,
): boolean {
  return (
    left.providerType === right.providerType &&
    left.bucket === right.bucket &&
    left.region === right.region &&
    left.localNamespace === right.localNamespace
  );
}

export function storageLocatorFromObject(value: {
  providerType: 'LOCAL' | 'COS' | null;
  bucket: string | null;
  region: string | null;
  localNamespace: string | null;
}): StorageObjectLocator {
  if (value.providerType !== 'LOCAL' && value.providerType !== 'COS') {
    throw new StorageConsistencyInvariantError('storage object has no pinned providerType');
  }
  const locator: StorageObjectLocator = {
    providerType: value.providerType,
    bucket: value.bucket,
    region: value.region,
    localNamespace: value.localNamespace,
  };
  assertStorageLocator(locator);
  return locator;
}

function assertStorageLocator(locator: StorageObjectLocator): void {
  if (locator.providerType === 'COS') {
    if (!locator.bucket || !locator.region || locator.localNamespace !== null) {
      throw new StorageConsistencyInvariantError('incomplete COS locator');
    }
    return;
  }
  if (locator.bucket !== null || locator.region !== null || !locator.localNamespace) {
    throw new StorageConsistencyInvariantError('incomplete LOCAL locator');
  }
}

function errorCode(error: Error | Record<string, unknown>): string {
  if ('code' in error && (typeof error.code === 'string' || typeof error.code === 'number')) {
    return boundedErrorLabel(String(error.code), 'STORAGE_OPERATION_ERROR');
  }
  return 'STORAGE_OPERATION_ERROR';
}

function boundedErrorLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  return value.slice(0, 160);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new StorageConsistencyInvariantError('request hash contains unsupported value');
  }
  return encoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
