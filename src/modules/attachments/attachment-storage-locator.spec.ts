import type { StorageObject } from '@prisma/client';

import { StoragePinnedLocatorError, type StorageProvider } from '../storage/storage.interface';
import type { StorageObjectLedgerService } from '../storage/storage-object-ledger.service';
import type { StorageObjectLocator } from '../storage/storage.types';
import {
  canUseCurrentLocatorAsBackfillCandidate,
  hasUnpinnedBackfillCandidateShape,
  locatorForObject,
  locatorMatchesOrCompletesBackfill,
  pinnedProviderOf,
  storageLocatorData,
} from './attachment-storage-locator';

/*
 * 存储定位器解析层的单测(#1041 抽出,此前零覆盖 —— 本刀补齐)。
 *
 * 这一层回答两个问题:「这个对象该去哪个 locator 找」「当前 locator 能不能当未固定对象的回填候选」。
 * 它被 upload / delete / backfill / reconcile 四族共用,任何一条判定放松都会**同时**影响四条链路。
 *
 * ⚠️ 本 spec 的核心是 locatorForObject 的 fallback 边界。那条 fallback 允许在非严格模式下
 * 用「供应商当前 locator」去探测一个尚未固定的对象,这是**唯一一处**返回值不来自对象自身字段的路径。
 * 它有四道闸(严格模式 / 候选形状 / 当前 locator 自身合法 / 候选与当前相容),
 * 少任何一道都意味着「拿着 A 机房的 locator 去认领 B 机房的对象」。四道闸本 spec 逐条钉住。
 *
 * ⚠️ 覆盖不到的:fallback 返回值**不写回**这一约束。它是调用方的义务
 * (locator 保持 unpinned,直到 finalizeBackfillAvailable / promoteBackfillAvailable 在锁内确认),
 * 纯函数这一层看不见调用方拿它做了什么。那条约束由对账族的 CAS 兜底,见
 * attachment-reconciliation.service.spec.ts 中 promoteBackfillAvailable 的用例。
 */

const COS: StorageObjectLocator = {
  providerType: 'COS',
  bucket: 'bkt-1',
  region: 'ap-guangzhou',
  localNamespace: null,
};
const LOCAL: StorageObjectLocator = {
  providerType: 'LOCAL',
  bucket: null,
  region: null,
  localNamespace: 'ns-a',
};

/** 未固定的回填候选形状:source=backfill + state=provider_unknown + 三个位置字段全 null。 */
function unpinnedCandidate(over: Partial<StorageObject> = {}): StorageObject {
  return {
    source: 'backfill',
    state: 'provider_unknown',
    providerType: null,
    bucket: null,
    region: null,
    localNamespace: null,
    ...over,
  } as unknown as StorageObject;
}

function pinnedObject(locator: StorageObjectLocator): StorageObject {
  return {
    source: 'attachment_signed_upload',
    state: 'available',
    ...locator,
  } as unknown as StorageObject;
}

describe('storageLocatorData —— 只搬四个位置字段', () => {
  it('COS:逐字返回 providerType / bucket / region / localNamespace', () => {
    expect(storageLocatorData(COS)).toEqual({
      providerType: 'COS',
      bucket: 'bkt-1',
      region: 'ap-guangzhou',
      localNamespace: null,
    });
  });

  it('LOCAL:同样四个键,值互补(bucket/region 为 null)', () => {
    expect(storageLocatorData(LOCAL)).toEqual({
      providerType: 'LOCAL',
      bucket: null,
      region: null,
      localNamespace: 'ns-a',
    });
  });

  it('恰好四个键 —— 多返回一个键会被当作 update data 写进 storage_objects', () => {
    // 返回值直接展开进 updateMany 的 data,多一个键就是多写一列。
    expect(Object.keys(storageLocatorData(COS)).sort()).toEqual([
      'bucket',
      'localNamespace',
      'providerType',
      'region',
    ]);
  });
});

describe('hasUnpinnedBackfillCandidateShape —— 六个条件全中才算候选', () => {
  it('接受:三个位置字段全 null 且 providerType 为 null', () => {
    expect(hasUnpinnedBackfillCandidateShape(unpinnedCandidate())).toBe(true);
  });

  it('接受:providerType 已是 LOCAL 但位置字段仍全 null(半固定的历史行)', () => {
    expect(hasUnpinnedBackfillCandidateShape(unpinnedCandidate({ providerType: 'LOCAL' }))).toBe(
      true,
    );
  });

  it('拒绝:providerType 是 COS —— COS 对象必须自带 bucket/region,不存在半固定形态', () => {
    expect(hasUnpinnedBackfillCandidateShape(unpinnedCandidate({ providerType: 'COS' }))).toBe(
      false,
    );
  });

  it.each([
    ['bucket', { bucket: 'bkt-1' }],
    ['region', { region: 'ap-guangzhou' }],
    ['localNamespace', { localNamespace: 'ns-a' }],
  ])('拒绝:%s 已有值(位置已固定,不该再被当候选覆盖)', (_field, over) => {
    expect(hasUnpinnedBackfillCandidateShape(unpinnedCandidate(over))).toBe(false);
  });

  it.each([['attachment_signed_upload'], ['attachment_legacy']])(
    '拒绝:source 是 %s(只有 backfill 来源允许后补 locator)',
    (source) => {
      expect(hasUnpinnedBackfillCandidateShape(unpinnedCandidate({ source }))).toBe(false);
    },
  );

  it.each([['available'], ['legacy_unverified'], ['pending_upload'], ['absent']])(
    '拒绝:state 是 %s(只有 provider_unknown 是「还没探到实体」)',
    (state) => {
      expect(hasUnpinnedBackfillCandidateShape(unpinnedCandidate({ state }))).toBe(false);
    },
  );
});

describe('canUseCurrentLocatorAsBackfillCandidate —— 候选形状之上再加相容判定', () => {
  it('providerType 为 null:任何 locator 都相容(完全未固定)', () => {
    expect(canUseCurrentLocatorAsBackfillCandidate(unpinnedCandidate(), COS)).toBe(true);
    expect(canUseCurrentLocatorAsBackfillCandidate(unpinnedCandidate(), LOCAL)).toBe(true);
  });

  it('providerType 已是 LOCAL:只与 LOCAL locator 相容', () => {
    const half = unpinnedCandidate({ providerType: 'LOCAL' });
    expect(canUseCurrentLocatorAsBackfillCandidate(half, LOCAL)).toBe(true);
  });

  it('⚠️ providerType 已是 LOCAL 但当前是 COS:拒绝 —— 否则本地对象会被认领进对象存储', () => {
    const half = unpinnedCandidate({ providerType: 'LOCAL' });
    expect(canUseCurrentLocatorAsBackfillCandidate(half, COS)).toBe(false);
  });

  it('形状不合格时直接拒绝,不再看 locator', () => {
    expect(
      canUseCurrentLocatorAsBackfillCandidate(unpinnedCandidate({ state: 'available' }), COS),
    ).toBe(false);
  });
});

describe('locatorMatchesOrCompletesBackfill —— 已固定则比对,未固定则看能否补全', () => {
  it('已固定且一致:true', () => {
    expect(locatorMatchesOrCompletesBackfill(pinnedObject(COS), COS)).toBe(true);
  });

  it('已固定但 region 不同:false —— 同 bucket 跨地域也是两个位置', () => {
    const other = { ...COS, region: 'ap-shanghai' };
    expect(locatorMatchesOrCompletesBackfill(pinnedObject(COS), other)).toBe(false);
  });

  it('已固定但 providerType 不同:false', () => {
    expect(locatorMatchesOrCompletesBackfill(pinnedObject(LOCAL), COS)).toBe(false);
  });

  it('⚠️ 未固定(storageLocatorFromObject 抛)时落到候选判定,而不是把异常抛给调用方', () => {
    // 这是 try/catch 的存在理由:对象没有 providerType 时 storageLocatorFromObject 会抛,
    // 但「没有 providerType」恰恰是回填候选的正常形态,不是错误。
    expect(locatorMatchesOrCompletesBackfill(unpinnedCandidate(), COS)).toBe(true);
  });

  it('未固定但形状不合格(source 不是 backfill):false 而非抛', () => {
    expect(
      locatorMatchesOrCompletesBackfill(unpinnedCandidate({ source: 'attachment_legacy' }), COS),
    ).toBe(false);
  });
});

describe('pinnedProviderOf —— 供应商能力闸', () => {
  it('八个 *At 方法齐全:原样返回同一个引用', () => {
    const provider = pinnedProvider();
    expect(pinnedProviderOf(provider)).toBe(provider);
  });

  it.each([
    ['getCurrentLocator'],
    ['putObjectAt'],
    ['deleteObjectAt'],
    ['generateUploadUrlAt'],
    ['generateDownloadUrlAt'],
    ['headObjectAt'],
    ['readObjectPrefixAt'],
    ['hashObjectSha256At'],
  ])('缺 %s 一个方法即抛 StoragePinnedLocatorError', (missing) => {
    const provider = pinnedProvider();
    delete (provider as unknown as Record<string, unknown>)[missing];
    expect(() => pinnedProviderOf(provider)).toThrow(StoragePinnedLocatorError);
  });
});

describe('locatorForObject —— fallback 的四道闸', () => {
  it('对象已固定:直接用自身字段,不问供应商', async () => {
    const provider = pinnedProvider();
    const ledger = makeLedger(false);
    await expect(locatorForObject(ledger, provider, pinnedObject(COS))).resolves.toEqual(COS);
    expect(provider.getCurrentLocator).not.toHaveBeenCalled();
  });

  it('闸①严格模式:即使形状合格也不走 fallback,原样抛', async () => {
    const provider = pinnedProvider();
    await expect(locatorForObject(makeLedger(true), provider, unpinnedCandidate())).rejects.toThrow(
      'storage object has no pinned providerType',
    );
    expect(provider.getCurrentLocator).not.toHaveBeenCalled();
  });

  it('闸②形状不合格:不走 fallback,原样抛', async () => {
    const provider = pinnedProvider();
    const bad = unpinnedCandidate({ source: 'attachment_signed_upload' });
    await expect(locatorForObject(makeLedger(false), provider, bad)).rejects.toThrow(
      'storage object has no pinned providerType',
    );
    expect(provider.getCurrentLocator).not.toHaveBeenCalled();
  });

  it('⚠️ 闸③供应商当前 locator 自身不合法:抛「不完整」而不是把它当答案', async () => {
    // 供应商返回一个 COS locator 却没有 bucket —— 这是配置事故。
    // 若不校验,这个残缺 locator 会被写进 storage_objects 的位置字段。
    const provider = pinnedProvider({
      providerType: 'COS',
      bucket: null,
      region: 'ap-guangzhou',
      localNamespace: null,
    });
    await expect(
      locatorForObject(makeLedger(false), provider, unpinnedCandidate()),
    ).rejects.toThrow('incomplete COS locator');
  });

  it('⚠️ 闸④当前 locator 合法但与对象不相容:抛**原始**错误而非当前 locator 的错误', async () => {
    // 对象半固定成 LOCAL,供应商当前在 COS —— 拿 COS locator 认领它就是跨介质错认。
    const provider = pinnedProvider(COS);
    const half = unpinnedCandidate({ providerType: 'LOCAL' });
    // 半固定 LOCAL 的原始错误是「incomplete LOCAL locator」(providerType 已是 LOCAL,
    // 过了第一道 providerType 判定,倒在 localNamespace 为空上),不是「no pinned providerType」。
    // 抛的必须是这条原始错误 —— 它描述的是**对象**的缺陷,fallback 失败不该把诊断改写成供应商的问题。
    await expect(locatorForObject(makeLedger(false), provider, half)).rejects.toThrow(
      'incomplete LOCAL locator',
    );
    expect(provider.getCurrentLocator).toHaveBeenCalledTimes(1);
  });

  it('四道闸全过:返回供应商当前 locator', async () => {
    const provider = pinnedProvider(COS);
    await expect(
      locatorForObject(makeLedger(false), provider, unpinnedCandidate()),
    ).resolves.toEqual(COS);
    expect(provider.getCurrentLocator).toHaveBeenCalledTimes(1);
  });

  it('半固定 LOCAL 对象遇到 LOCAL 供应商:放行', async () => {
    const provider = pinnedProvider(LOCAL);
    const half = unpinnedCandidate({ providerType: 'LOCAL' });
    await expect(locatorForObject(makeLedger(false), provider, half)).resolves.toEqual(LOCAL);
  });

  it('⚠️ 供应商不具备 pinned 能力:抛 StoragePinnedLocatorError,不静默降级', async () => {
    const provider = pinnedProvider();
    delete (provider as unknown as Record<string, unknown>).getCurrentLocator;
    await expect(
      locatorForObject(makeLedger(false), provider, unpinnedCandidate()),
    ).rejects.toThrow(StoragePinnedLocatorError);
  });
});

function makeLedger(strict: boolean): StorageObjectLedgerService {
  return { isStrictMode: () => strict } as unknown as StorageObjectLedgerService;
}

function pinnedProvider(current: StorageObjectLocator = COS): StorageProvider & {
  getCurrentLocator: jest.Mock;
} {
  return {
    getCurrentLocator: jest.fn().mockResolvedValue(current),
    putObjectAt: jest.fn(),
    deleteObjectAt: jest.fn(),
    generateUploadUrlAt: jest.fn(),
    generateDownloadUrlAt: jest.fn(),
    headObjectAt: jest.fn(),
    readObjectPrefixAt: jest.fn(),
    hashObjectSha256At: jest.fn(),
  } as unknown as StorageProvider & { getCurrentLocator: jest.Mock };
}
