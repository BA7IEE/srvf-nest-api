import { Prisma, type StorageObject } from '@prisma/client';

import { StorageConsistencyInvariantError, bigintSize } from '../storage/storage-consistency.types';
import type { StorageObjectOperation } from '@prisma/client';
import type { HeadObjectResult } from '../storage/storage.types';

/*
 * 存储一致性的**不变量原语**:纯判定 + 判定失败时抛的错误类型。
 *
 * 为什么单独成文件(Phase 6-B 第四域第一刀):这些函数与错误类被
 * `attachment-storage-orchestrator.ts` 里**多族方法共用**(terminalSucceededData 10 处、
 * assertExpectedSizeMatchesHead 5 处…)。按族抽 orchestrator 时,被抽出的族仍要用它们 ——
 * 若继续留在 orchestrator 里 export,新抽出的服务就得 import 回 orchestrator,
 * 形成 orchestrator ↔ 子服务的**循环依赖**。故先把这一层降为共享底座。
 *
 * 边界纪律:本文件**只放纯函数与错误类** —— 不注入任何依赖、不做 IO、不碰 Prisma 客户端
 * (仅用 Prisma 的类型)。任何需要 tx/provider/ledger 的逻辑都不属于这里。
 */

/** 操作进入终态 succeeded 时的统一字段集(含租约字段清空)。*/
export function terminalSucceededData(
  now: Date,
  effectState: 'provider_present' | 'provider_absent' | 'effect_succeeded',
): Prisma.StorageObjectOperationUpdateInput {
  return {
    status: 'succeeded',
    effectState,
    effectCompletedAt: effectState === 'effect_succeeded' ? now : undefined,
    completedAt: now,
    deadAt: null,
    leaseOwner: null,
    leaseAcquiredAt: null,
    leaseRenewedAt: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    lastErrorClass: null,
  };
}

export function requireString(value: string | null, field: string): string {
  if (!value) throw new StorageConsistencyInvariantError(`${field} is missing`);
  return value;
}

export function safeNumber(value: bigint | null): number | undefined {
  if (value === null) return undefined;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new StorageConsistencyInvariantError(`unsafe bigint size=${value.toString()}`);
  }
  return result;
}

export function requireSafeSize(value: bigint | null): number {
  const size = safeNumber(value);
  if (size === undefined) throw new StorageConsistencyInvariantError('expectedSize is missing');
  return size;
}

export function requireHeadSize(head: HeadObjectResult): number {
  if (head.size === undefined) {
    throw new StorageConsistencyInvariantError('provider HEAD lacks expected size evidence');
  }
  return head.size;
}

export function assertExpectedSizeMatchesHead(
  object: Pick<StorageObject, 'expectedSize'>,
  head: HeadObjectResult,
): void {
  if (object.expectedSize === null) {
    throw new StorageConsistencyInvariantError('storage object lacks expected size evidence');
  }
  if (object.expectedSize !== bigintSize(requireHeadSize(head))) {
    throw new StorageObjectIntegrityMismatchError('provider HEAD size mismatch');
  }
}

export function requireSha256Hex(value: string, field: string): string {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new StorageConsistencyInvariantError(`${field} is not SHA-256 hex`);
  }
  return value.toLowerCase();
}

export class StorageAwaitingConfirmError extends Error {
  constructor() {
    super('STORAGE_AWAITING_ATTACHMENT_CONFIRM');
    this.name = 'StorageAwaitingConfirmError';
  }
}

export class StorageCandidateNotFoundError extends Error {
  constructor() {
    super('STORAGE_CANDIDATE_NOT_FOUND');
    this.name = 'StorageCandidateNotFoundError';
  }
}

export class StorageObjectIntegrityMismatchError extends Error {
  readonly code = 'STORAGE_OBJECT_INTEGRITY_MISMATCH';

  constructor(reason: string) {
    super(reason);
    this.name = 'StorageObjectIntegrityMismatchError';
  }
}

export class StorageProviderDeleteStillPresentError extends Error {
  constructor() {
    super('STORAGE_PROVIDER_DELETE_STILL_PRESENT');
    this.name = 'StorageProviderDeleteStillPresentError';
  }
}

export function activeOperations(
  operations: readonly StorageObjectOperation[],
): StorageObjectOperation[] {
  return operations.filter(
    (operation) => operation.status === 'pending' || operation.status === 'processing',
  );
}

export function assertHeadMatchesObject(object: StorageObject, head: HeadObjectResult): void {
  assertExpectedSizeMatchesHead(object, head);
  if (object.etag !== null && head.etag === undefined) {
    throw new StorageConsistencyInvariantError('provider HEAD lacks expected etag evidence');
  }
  if (object.etag !== null && head.etag !== object.etag) {
    throw new StorageObjectIntegrityMismatchError('provider HEAD etag mismatch');
  }
}
