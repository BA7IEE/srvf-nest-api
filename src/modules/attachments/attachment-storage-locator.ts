import { type StorageObject } from '@prisma/client';

import {
  isPinnedStorageProvider,
  StoragePinnedLocatorError,
  type PinnedStorageProvider,
  type StorageProvider,
} from '../storage/storage.interface';
import { StorageObjectLedgerService } from '../storage/storage-object-ledger.service';
import { sameStorageLocator, storageLocatorFromObject } from '../storage/storage-consistency.types';
import type { StorageObjectLocator } from '../storage/storage.types';

/*
 * 存储定位器的解析与判定(Phase 6-B 第四域第六刀)。
 *
 * 从编排器迁出:这一层回答「这个存储对象该去哪个 locator 找」以及
 * 「当前 locator 能否作为未固定对象的回填候选」。它被 upload / delete / backfill /
 * reconcile 多族共用,按族拆分编排器时必须先降为共享底座,否则被抽出的族要 import 回编排器
 * (循环依赖)—— 与 #1033 抽 invariants、#1035 抽内容根边界锁同一理由。
 *
 * 做成模块级纯函数而非 @Injectable:所需的 ledger / provider 全部由调用方作参数传入,
 * 不进 DI 图、两个 module 都无需改注册。
 *
 * ⚠️ locatorForObject 的 fallback 只是**本次 HEAD 的证据**:它在非严格模式下允许用
 * 当前 locator 去探测一个尚未固定的回填候选,但**不写回**任何字段 ——
 * locator 保持 unpinned,直到 finalizeBackfillAvailable / promoteBackfillAvailable
 * 在锁内确认同一对象后才真正固定。把这里的返回值当成「已固定」用会跳过那道锁。
 */

export function storageLocatorData(locator: StorageObjectLocator): {
  providerType: 'LOCAL' | 'COS';
  bucket: string | null;
  region: string | null;
  localNamespace: string | null;
} {
  return {
    providerType: locator.providerType,
    bucket: locator.bucket,
    region: locator.region,
    localNamespace: locator.localNamespace,
  };
}

export function locatorMatchesOrCompletesBackfill(
  object: StorageObject,
  locator: StorageObjectLocator,
): boolean {
  try {
    return sameStorageLocator(storageLocatorFromObject(object), locator);
  } catch {
    return canUseCurrentLocatorAsBackfillCandidate(object, locator);
  }
}

export function hasUnpinnedBackfillCandidateShape(
  object: Pick<
    StorageObject,
    'source' | 'state' | 'providerType' | 'bucket' | 'region' | 'localNamespace'
  >,
): boolean {
  return (
    object.source === 'backfill' &&
    object.state === 'provider_unknown' &&
    object.bucket === null &&
    object.region === null &&
    object.localNamespace === null &&
    (object.providerType === null || object.providerType === 'LOCAL')
  );
}

export function canUseCurrentLocatorAsBackfillCandidate(
  object: Pick<
    StorageObject,
    'source' | 'state' | 'providerType' | 'bucket' | 'region' | 'localNamespace'
  >,
  locator: StorageObjectLocator,
): boolean {
  if (!hasUnpinnedBackfillCandidateShape(object)) return false;
  if (object.providerType === null) return true;
  return object.providerType === 'LOCAL' && locator.providerType === 'LOCAL';
}

export function pinnedProviderOf(provider: StorageProvider): PinnedStorageProvider {
  if (!isPinnedStorageProvider(provider)) {
    throw new StoragePinnedLocatorError('STORAGE_PROVIDER 未实现 pinned locator methods');
  }
  return provider;
}

export async function locatorForObject(
  ledger: StorageObjectLedgerService,
  provider: StorageProvider,
  object: StorageObject,
): Promise<StorageObjectLocator> {
  try {
    return storageLocatorFromObject(object);
  } catch (error) {
    if (ledger.isStrictMode() || !hasUnpinnedBackfillCandidateShape(object)) throw error;
    const current = await pinnedProviderOf(provider).getCurrentLocator();
    storageLocatorFromObject(current);
    if (!canUseCurrentLocatorAsBackfillCandidate(object, current)) throw error;
    // A rollout candidate is evidence for this HEAD only. The locator remains unpinned until
    // finalizeBackfillAvailable/promoteBackfillAvailable locks and promotes the same object.
    return current;
  }
}
