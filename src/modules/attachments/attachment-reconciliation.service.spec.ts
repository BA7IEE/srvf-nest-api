import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { StorageProvider } from '../storage/storage.interface';
import type { StorageObjectLedgerService } from '../storage/storage-object-ledger.service';
import type { AttachmentContentValidator } from './attachment-content-validator';
import { AttachmentReconciliationService } from './attachment-reconciliation.service';

/*
 * 存储对账与回填的单测(#1041 抽出,此前零覆盖 —— 本刀补齐)。
 *
 * 这一族让**事实与账目对齐**:回填给历史对象固定 locator,悬挂态(unbound / orphan)向 absent 收敛。
 *
 * ⚠️ 本 spec 的主轴是 `count !== 1 → throw` 这一族不变量。它们不是防御性代码:
 * `updateMany({ where: { …当时读到的态 } })` 的 count 为 0,意味着状态在「读」与「写」之间被别人改过。
 * 此时**必须放弃**而不是重试写入 —— 重试会把别人已经写下的终态覆盖掉。
 * 六个 finalize / transition 方法各有两个 CAS 点(对象 + 操作),本 spec 逐个钉住两侧各自失守的后果,
 * 并区分两种异常:对象 CAS 丢 → InvariantError;操作租约丢 → LeaseLostError(两者重试语义不同)。
 *
 * ⚠️ 覆盖不到的:CAS 的**真实原子性**。mock 里 updateMany 返回什么就是什么,
 * 真正的「读写之间被人插队」只有并发 e2e 能构造。本层锁的是「count 不为 1 时代码怎么反应」,
 * 不是「count 会不会不为 1」。前者是本族的核心判断,后者由 PG 保证。
 */

const OP_ID = 'op-0000000001';
const OBJECT_ID = 'obj-000000001';
const ATTACHMENT_ID = 'att-000000001';
const KEY = 'attachments/a.bin';

type Row = Record<string, unknown>;

/** *At 系列方法在 PinnedStorageProvider 上而非基接口 StorageProvider —— 用例要断言它们的调用。 */
type MockedPinnedProvider = Record<
  | 'getCurrentLocator'
  | 'putObjectAt'
  | 'deleteObjectAt'
  | 'generateUploadUrlAt'
  | 'generateDownloadUrlAt'
  | 'headObjectAt'
  | 'readObjectPrefixAt'
  | 'hashObjectSha256At',
  jest.Mock
>;

const COS = {
  providerType: 'COS' as const,
  bucket: 'bkt-1',
  region: 'ap-guangzhou',
  localNamespace: null,
};

function object(over: Row = {}): Row {
  return {
    id: OBJECT_ID,
    key: KEY,
    source: 'attachment_signed_upload',
    state: 'present_unbound',
    resourceType: null,
    resourceId: null,
    expectedMime: 'image/png',
    expectedSize: BigInt(1024),
    etag: null,
    deleteRequestedAt: null,
    unboundExpiresAt: new Date(Date.now() - 60_000),
    ...COS,
    ...over,
  };
}

function claimed(over: Row = {}, objectOver: Row = {}): Row {
  return {
    id: OP_ID,
    kind: 'attachment_upload_verify',
    storageObjectId: OBJECT_ID,
    leaseGeneration: 3,
    storageObject: object(objectOver),
    ...over,
  };
}

function head(over: Row = {}): Row {
  return { exists: true, size: 1024, etag: undefined, contentType: 'image/png', ...over };
}

function makeService(
  options: {
    objectCount?: number;
    operationCount?: number;
    locked?: Row;
    strict?: boolean;
    headExists?: boolean;
    currentObject?: Row | null;
    activeOperations?: Array<{ id: string; kind: string }>;
    promoteCount?: number;
    completeCount?: number;
    rawRows?: Row[];
  } = {},
) {
  const storageObjectUpdateMany = jest
    .fn<Promise<{ count: number }>, [{ data: Row }]>()
    .mockResolvedValue({ count: options.objectCount ?? 1 });
  const operationUpdateMany = jest
    .fn<Promise<{ count: number }>, [{ data: Row }]>()
    .mockResolvedValue({ count: options.operationCount ?? 1 });
  const operationCreate = jest.fn().mockResolvedValue({});

  // promoteBackfillAvailable 走 updateMany 两次(promote + complete),用调用序区分。
  const promoteUpdateMany = jest
    .fn<Promise<{ count: number }>, [{ data: Row }]>()
    .mockResolvedValue({ count: options.promoteCount ?? 1 });

  const tx = {
    $queryRaw: jest
      .fn()
      .mockResolvedValueOnce([{ id: OBJECT_ID }])
      .mockResolvedValue(options.activeOperations ?? []),
    storageObject: {
      updateMany: options.currentObject === undefined ? storageObjectUpdateMany : promoteUpdateMany,
      findUnique: jest
        .fn()
        .mockResolvedValue(options.currentObject === undefined ? null : options.currentObject),
    },
    storageObjectOperation: {
      updateMany:
        options.currentObject === undefined
          ? operationUpdateMany
          : jest.fn().mockResolvedValue({ count: options.completeCount ?? 1 }),
      create: operationCreate,
    },
  };

  const prisma = {
    $transaction: jest.fn().mockImplementation((fn: (t: unknown) => unknown) => fn(tx)),
    $queryRaw: jest.fn().mockResolvedValue(options.rawRows ?? []),
    attachment: {
      findUnique: jest.fn().mockResolvedValue({ id: ATTACHMENT_ID, key: KEY }),
    },
  } as unknown as PrismaService;

  const ledger = {
    isStrictMode: jest.fn().mockReturnValue(options.strict ?? false),
    lockClaimedForUpdate: jest.fn().mockResolvedValue(options.locked ?? claimed()),
    renewLease: jest.fn().mockImplementation((op: Row) => Promise.resolve(op)),
    markEffectState: jest.fn().mockResolvedValue(undefined),
    ensureRuntimeBackfill: jest.fn().mockResolvedValue(undefined),
    noteBackfillCandidateAbsentClaimed: jest.fn().mockResolvedValue(undefined),
    noteBackfillReadFailureClaimed: jest.fn().mockResolvedValue(undefined),
  } as unknown as StorageObjectLedgerService;

  const contentValidator = {
    validateFromObjectAt: jest.fn().mockResolvedValue(head()),
  } as unknown as AttachmentContentValidator;

  const provider = {
    getCurrentLocator: jest.fn().mockResolvedValue(COS),
    putObjectAt: jest.fn(),
    deleteObjectAt: jest.fn().mockResolvedValue(undefined),
    generateUploadUrlAt: jest.fn(),
    generateDownloadUrlAt: jest.fn(),
    headObjectAt: jest.fn().mockResolvedValue(head({ exists: options.headExists ?? false })),
    readObjectPrefixAt: jest.fn(),
    hashObjectSha256At: jest.fn(),
  } as unknown as MockedPinnedProvider;

  return {
    service: new AttachmentReconciliationService(
      prisma,
      ledger,
      contentValidator,
      provider as unknown as StorageProvider,
    ),
    prisma,
    ledger,
    contentValidator,
    provider,
    tx,
    storageObjectUpdateMany,
    operationUpdateMany,
    operationCreate,
    promoteUpdateMany,
  };
}

describe('reconcileRolloutAttachments —— 灰度期补账', () => {
  it('⚠️ 严格模式直接返回 0,一行都不查 —— 严格模式下不存在「还没建账的附件」', async () => {
    const { service, prisma } = makeService({ strict: true });
    await expect(service.reconcileRolloutAttachments()).resolves.toBe(0);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('没有缺账行:返回 0,不调 ensureRuntimeBackfill', async () => {
    const { service, ledger } = makeService({ rawRows: [] });
    await expect(service.reconcileRolloutAttachments()).resolves.toBe(0);
    expect(ledger.ensureRuntimeBackfill).not.toHaveBeenCalled();
  });

  it('每一行都建账,返回行数', async () => {
    const rows = [
      { id: 'a1', key: 'k1', size: 1, mime: 'image/png', etag: null, checksum: null, createdAt: new Date() },
      { id: 'a2', key: 'k2', size: 2, mime: 'image/png', etag: null, checksum: null, createdAt: new Date() },
    ];
    const { service, ledger } = makeService({ rawRows: rows });
    await expect(service.reconcileRolloutAttachments()).resolves.toBe(2);
    expect(ledger.ensureRuntimeBackfill).toHaveBeenCalledTimes(2);
  });
});

describe('executeBackfillVerify —— 回填探测', () => {
  function backfillClaim(objectOver: Row = {}) {
    return claimed(
      { kind: 'backfill_verify' },
      {
        source: 'backfill',
        state: 'provider_unknown',
        resourceType: 'attachment',
        resourceId: ATTACHMENT_ID,
        ...objectOver,
      },
    );
  }

  it('拒绝:对象没有 attachment 关联', async () => {
    const { service } = makeService();
    await expect(
      service.executeBackfillVerify(backfillClaim({ resourceType: null }) as never),
    ).rejects.toThrow('backfill object has no Attachment link');
  });

  it('拒绝:resourceId 为空', async () => {
    const { service } = makeService();
    await expect(
      service.executeBackfillVerify(backfillClaim({ resourceId: null }) as never),
    ).rejects.toThrow('backfill object has no Attachment link');
  });

  it('⚠️ 拒绝:Attachment 的 key 与对象的 key 不一致 —— 关联已过期,探到的实体不是这条账', async () => {
    const { service, prisma } = makeService();
    (prisma.attachment.findUnique as jest.Mock).mockResolvedValue({
      id: ATTACHMENT_ID,
      key: 'attachments/OTHER.bin',
    });
    await expect(service.executeBackfillVerify(backfillClaim() as never)).rejects.toThrow(
      'backfill Attachment link is stale',
    );
  });

  it('拒绝:Attachment 行已不存在', async () => {
    const { service, prisma } = makeService();
    (prisma.attachment.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(service.executeBackfillVerify(backfillClaim() as never)).rejects.toThrow(
      'backfill Attachment link is stale',
    );
  });

  it('⚠️ 校验抛 ATTACHMENT_NOT_FOUND:记「候选缺失」,不记「读失败」——两者的后续处置不同', async () => {
    const { service, contentValidator, ledger } = makeService({
      locked: backfillClaim(),
    });
    // ⚠️ 必须是**真的** BizException:分流判据是 `instanceof BizException && error.biz === BizCode.X`,
    // 而 `.biz` 比的是 BizCode 条目对象的**引用**,不是字符串。手搓一个带同名字符串的假异常会静默走进
    // 「读失败」分支,用例照样绿 —— 那就等于没测。
    const notFound = new BizException(BizCode.ATTACHMENT_NOT_FOUND);
    (contentValidator.validateFromObjectAt as jest.Mock).mockRejectedValue(notFound);
    await expect(service.executeBackfillVerify(backfillClaim() as never)).rejects.toBe(notFound);
    expect(ledger.noteBackfillCandidateAbsentClaimed).toHaveBeenCalledTimes(1);
    expect(ledger.noteBackfillReadFailureClaimed).not.toHaveBeenCalled();
  });

  it('⚠️ 校验抛其它错误:记「读失败」,不记「候选缺失」——网络抖动不能被当成对象不存在', async () => {
    const { service, contentValidator, ledger } = makeService({ locked: backfillClaim() });
    (contentValidator.validateFromObjectAt as jest.Mock).mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(service.executeBackfillVerify(backfillClaim() as never)).rejects.toThrow(
      'ETIMEDOUT',
    );
    expect(ledger.noteBackfillReadFailureClaimed).toHaveBeenCalledTimes(1);
    expect(ledger.noteBackfillCandidateAbsentClaimed).not.toHaveBeenCalled();
  });

  it('探到实体:续租后走 finalizeBackfillAvailable,对象置 available', async () => {
    const { service, storageObjectUpdateMany, ledger } = makeService({
      locked: backfillClaim({ state: 'provider_unknown' }),
    });
    await expect(service.executeBackfillVerify(backfillClaim() as never)).resolves.toBeUndefined();
    expect(ledger.renewLease).toHaveBeenCalled();
    expect(storageObjectUpdateMany.mock.calls[0]?.[0].data).toMatchObject({ state: 'available' });
  });
});

describe('finalizeBackfillAvailable —— 锁内复核 + 双 CAS', () => {
  function backfillLocked(over: Row = {}) {
    return claimed(
      { kind: 'backfill_verify' },
      {
        source: 'backfill',
        state: 'provider_unknown',
        resourceType: 'attachment',
        resourceId: ATTACHMENT_ID,
        ...over,
      },
    );
  }

  it.each([
    ['kind 不是 backfill_verify', { kind: 'attachment_upload_verify' }, {}],
    ['source 不是 backfill', {}, { source: 'attachment_legacy' }],
    ['resourceType 不是 attachment', {}, { resourceType: 'content' }],
    ['resourceId 为空', {}, { resourceId: null }],
    ['state 是 available(已收敛,不该再写)', {}, { state: 'available' }],
    ['已请求删除', {}, { deleteRequestedAt: new Date() }],
  ])('锁内复核拒绝:%s', async (_label, opOver, objOver) => {
    const locked = claimed(
      { kind: 'backfill_verify', ...opOver },
      {
        source: 'backfill',
        state: 'provider_unknown',
        resourceType: 'attachment',
        resourceId: ATTACHMENT_ID,
        ...objOver,
      },
    );
    const { service } = makeService({ locked });
    await expect(
      service.finalizeBackfillAvailable(locked as never, COS, head() as never),
    ).rejects.toThrow('backfill available locked state rejected');
  });

  it('⚠️ 锁内复核拒绝:locator 与锁内对象不匹配 —— 认领期间对象已被固定到别处', async () => {
    const locked = backfillLocked({ state: 'legacy_unverified', bucket: 'bkt-OTHER' });
    const { service } = makeService({ locked });
    await expect(
      service.finalizeBackfillAvailable(locked as never, COS, head() as never),
    ).rejects.toThrow('backfill available locked state rejected');
  });

  it('⚠️ HEAD 的 etag 与账上不符:抛完整性不符,不写 available', async () => {
    const locked = backfillLocked({ etag: 'W/"expected"' });
    const { service, storageObjectUpdateMany } = makeService({ locked });
    await expect(
      service.finalizeBackfillAvailable(locked as never, COS, head({ etag: 'W/"other"' }) as never),
    ).rejects.toThrow('provider HEAD etag mismatch');
    expect(storageObjectUpdateMany).not.toHaveBeenCalled();
  });

  it('⚠️ 对象 CAS 丢(count=0):抛 Invariant,**不重试** —— 重试会覆盖别人写下的终态', async () => {
    const locked = backfillLocked();
    const { service, operationUpdateMany } = makeService({ locked, objectCount: 0 });
    await expect(
      service.finalizeBackfillAvailable(locked as never, COS, head() as never),
    ).rejects.toThrow('backfill available object CAS lost');
    expect(operationUpdateMany).not.toHaveBeenCalled();
  });

  it('⚠️ 操作租约丢(count=0):抛 LeaseLost 而非 Invariant —— 两者重试语义不同', async () => {
    const locked = backfillLocked();
    const { service } = makeService({ locked, operationCount: 0 });
    await expect(
      service.finalizeBackfillAvailable(locked as never, COS, head() as never),
    ).rejects.toThrow(/lease/i);
  });

  it('两侧 CAS 都拿到:对象写入 locator 四字段 + available + 清空错误码', async () => {
    const locked = backfillLocked();
    const { service, storageObjectUpdateMany } = makeService({ locked });
    await service.finalizeBackfillAvailable(locked as never, COS, head({ etag: 'W/"e"' }) as never);
    expect(storageObjectUpdateMany.mock.calls[0]?.[0].data).toMatchObject({
      state: 'available',
      providerType: 'COS',
      bucket: 'bkt-1',
      region: 'ap-guangzhou',
      localNamespace: null,
      actualMime: 'image/png',
      etag: 'W/"e"',
      lastErrorCode: null,
      lastErrorClass: null,
    });
  });

  it('⚠️ HEAD 没给 size:在写库之前就被拒,不会带着「大小未知」落 available', async () => {
    // 注:源码里 actualSize 写的是 `head.size === undefined ? undefined : bigintSize(head.size)`,
    // 但那个 undefined 分支在本方法里**不可达** —— 前一行 assertHeadMatchesObject 已经要求
    // expectedSize 非空且 head.size 有值(见 attachment-storage-invariants 的 requireHeadSize)。
    // 所以这里钉的是真实保证「缺 size 证据 ⇒ 一个字都不写」,而不是那个够不着的三元分支。
    const locked = backfillLocked();
    const { service, storageObjectUpdateMany } = makeService({ locked });
    await expect(
      service.finalizeBackfillAvailable(locked as never, COS, head({ size: undefined }) as never),
    ).rejects.toThrow('provider HEAD lacks expected size evidence');
    expect(storageObjectUpdateMany).not.toHaveBeenCalled();
  });

  it('⚠️ 账上没有 expectedSize:同样在写库之前被拒 —— 无从核对的大小不能当已核验', async () => {
    const locked = backfillLocked({ expectedSize: null });
    const { service, storageObjectUpdateMany } = makeService({ locked });
    await expect(
      service.finalizeBackfillAvailable(locked as never, COS, head() as never),
    ).rejects.toThrow('storage object lacks expected size evidence');
    expect(storageObjectUpdateMany).not.toHaveBeenCalled();
  });

  it('⚠️ HEAD 的 size 与账上不符:抛完整性不符,不写 available', async () => {
    const locked = backfillLocked();
    const { service, storageObjectUpdateMany } = makeService({ locked });
    await expect(
      service.finalizeBackfillAvailable(locked as never, COS, head({ size: 999 }) as never),
    ).rejects.toThrow('provider HEAD size mismatch');
    expect(storageObjectUpdateMany).not.toHaveBeenCalled();
  });
});

describe('executeOrphanDelete —— 悬挂对象的物理删除', () => {
  function orphanClaim(over: Row = {}) {
    return claimed(
      { kind: 'orphan_delete' },
      {
        state: 'delete_pending',
        resourceId: null,
        unboundExpiresAt: new Date(Date.now() - 60_000),
        ...over,
      },
    );
  }

  it.each([
    ['source 不在允许集内', { source: 'backfill' }],
    ['仍绑着资源', { resourceId: ATTACHMENT_ID }],
    ['state 不是 delete_pending', { state: 'present_unbound' }],
    ['没有 unboundExpiresAt', { unboundExpiresAt: null }],
  ])('安全闸拒绝:%s', async (_label, over) => {
    const { service } = makeService();
    await expect(service.executeOrphanDelete(orphanClaim(over) as never)).rejects.toThrow(
      'orphan delete safety gate rejected',
    );
  });

  it('⚠️ 安全闸拒绝:unboundExpiresAt 尚未到期 —— 还在等客户端确认的对象不能删', async () => {
    const { service } = makeService();
    const notYet = orphanClaim({ unboundExpiresAt: new Date(Date.now() + 3_600_000) });
    await expect(service.executeOrphanDelete(notYet as never)).rejects.toThrow(
      'orphan delete safety gate rejected',
    );
  });

  it('实体本就不存在(首次 HEAD 即 exists=false):直接置 absent,不调 delete', async () => {
    const locked = orphanClaim();
    const { service, provider } = makeService({ locked, headExists: false });
    await service.executeOrphanDelete(locked as never);
    expect(provider.deleteObjectAt).not.toHaveBeenCalled();
  });

  it('⚠️ delete 抛错但复核 HEAD 显示已消失:按成功收敛 —— 删除是幂等的,错误可能发生在响应途中', async () => {
    const locked = orphanClaim();
    const { service, provider, storageObjectUpdateMany } = makeService({ locked });
    provider.headObjectAt
      .mockResolvedValueOnce(head({ exists: true }))
      .mockResolvedValueOnce(head({ exists: false }));
    provider.deleteObjectAt.mockRejectedValue(new Error('ECONNRESET'));
    await expect(service.executeOrphanDelete(locked as never)).resolves.toBeUndefined();
    expect(storageObjectUpdateMany.mock.calls[0]?.[0].data).toMatchObject({ state: 'absent' });
  });

  it('⚠️ delete 抛错且复核 HEAD 仍在:抛原始错误 —— 保留诊断,不改写成通用错误', async () => {
    const locked = orphanClaim();
    const { service, provider } = makeService({ locked });
    provider.headObjectAt.mockResolvedValue(head({ exists: true }));
    provider.deleteObjectAt.mockRejectedValue(new Error('AccessDenied'));
    await expect(service.executeOrphanDelete(locked as never)).rejects.toThrow('AccessDenied');
  });

  it('⚠️ delete 没抛错但复核 HEAD 仍在:抛 StillPresent —— 供应商「成功」了但字节还在', async () => {
    const locked = orphanClaim();
    const { service, provider } = makeService({ locked });
    provider.headObjectAt.mockResolvedValue(head({ exists: true }));
    await expect(service.executeOrphanDelete(locked as never)).rejects.toThrow(
      'STORAGE_PROVIDER_DELETE_STILL_PRESENT',
    );
  });

  it('删除前标记 effect_started —— 崩溃后能看出「已经发出过删除」', async () => {
    const locked = orphanClaim();
    const { service, provider, ledger } = makeService({ locked });
    provider.headObjectAt
      .mockResolvedValueOnce(head({ exists: true }))
      .mockResolvedValueOnce(head({ exists: false }));
    await service.executeOrphanDelete(locked as never);
    expect(ledger.markEffectState).toHaveBeenCalledWith(expect.anything(), 'effect_started');
  });
});

describe('transitionUploadVerifyToOrphan —— 上传超时转孤儿', () => {
  function uploadClaim(over: Row = {}) {
    return claimed(
      {},
      {
        state: 'present_unbound',
        resourceId: null,
        unboundExpiresAt: new Date(Date.now() - 60_000),
        ...over,
      },
    );
  }

  it.each([
    ['state 不是 present_unbound', {}, { state: 'pending_upload' }],
    ['已绑定资源', {}, { resourceId: ATTACHMENT_ID }],
    ['kind 不是 upload_verify', { kind: 'orphan_delete' }, {}],
    ['尚未到期', {}, { unboundExpiresAt: new Date(Date.now() + 3_600_000) }],
  ])('锁内复核拒绝:%s', async (_label, opOver, objOver) => {
    const locked = claimed(opOver, {
      state: 'present_unbound',
      resourceId: null,
      unboundExpiresAt: new Date(Date.now() - 60_000),
      ...objOver,
    });
    const { service } = makeService({ locked });
    await expect(service.transitionUploadVerifyToOrphan(locked as never)).rejects.toThrow(
      'orphan transition locked state rejected',
    );
  });

  it('对象 CAS 丢:抛 Invariant,不建后继 orphan_delete 操作', async () => {
    const locked = uploadClaim();
    const { service, operationCreate } = makeService({ locked, objectCount: 0 });
    await expect(service.transitionUploadVerifyToOrphan(locked as never)).rejects.toThrow(
      'orphan object transition lost',
    );
    expect(operationCreate).not.toHaveBeenCalled();
  });

  it('操作租约丢:抛 LeaseLost,不建后继操作', async () => {
    const locked = uploadClaim();
    const { service, operationCreate } = makeService({ locked, operationCount: 0 });
    await expect(service.transitionUploadVerifyToOrphan(locked as never)).rejects.toThrow(/lease/i);
    expect(operationCreate).not.toHaveBeenCalled();
  });

  it('⚠️ 全过:对象转 delete_pending,并建一条 eventKey 与对象绑定的 orphan_delete —— 幂等靠它', async () => {
    const locked = uploadClaim();
    const { service, storageObjectUpdateMany, operationCreate } = makeService({ locked });
    await service.transitionUploadVerifyToOrphan(locked as never);
    expect(storageObjectUpdateMany.mock.calls[0]?.[0].data).toMatchObject({
      state: 'delete_pending',
    });
    expect(operationCreate.mock.calls[0]?.[0].data).toMatchObject({
      eventKey: `storage.orphan-delete:${OBJECT_ID}`,
      kind: 'orphan_delete',
      status: 'pending',
      effectState: 'not_started',
      replayOfId: OP_ID,
    });
  });
});

describe('finalizeUnboundAbsent —— 上传从未落地', () => {
  function unboundClaim(state = 'present_unbound') {
    return claimed({}, { state, resourceId: null, unboundExpiresAt: new Date(Date.now() - 1000) });
  }

  it.each([['pending_upload'], ['present_unbound'], ['provider_unknown']])(
    '接受 state=%s(三种「还没绑上」的形态)',
    async (state) => {
      const locked = unboundClaim(state);
      const { service, storageObjectUpdateMany } = makeService({ locked });
      await service.finalizeUnboundAbsent(locked as never);
      expect(storageObjectUpdateMany.mock.calls[0]?.[0].data).toMatchObject({ state: 'absent' });
    },
  );

  it.each([['available'], ['delete_pending'], ['absent']])('拒绝 state=%s', async (state) => {
    const locked = unboundClaim(state);
    const { service } = makeService({ locked });
    await expect(service.finalizeUnboundAbsent(locked as never)).rejects.toThrow(
      'unbound absent locked state rejected',
    );
  });

  it('⚠️ CAS 的 where 用**锁内读到的** state,不是硬编码 —— 三种入态各自 CAS 自己那一种', async () => {
    const locked = unboundClaim('provider_unknown');
    const { service, storageObjectUpdateMany } = makeService({ locked });
    await service.finalizeUnboundAbsent(locked as never);
    expect(storageObjectUpdateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { state: 'provider_unknown', resourceId: null },
    });
  });

  it('对象 CAS 丢:抛 Invariant', async () => {
    const locked = unboundClaim();
    const { service } = makeService({ locked, objectCount: 0 });
    await expect(service.finalizeUnboundAbsent(locked as never)).rejects.toThrow(
      'unbound absent object CAS lost',
    );
  });

  it('操作租约丢:抛 LeaseLost', async () => {
    const locked = unboundClaim();
    const { service } = makeService({ locked, operationCount: 0 });
    await expect(service.finalizeUnboundAbsent(locked as never)).rejects.toThrow(/lease/i);
  });
});

describe('finalizeOrphanAbsent —— 孤儿删除完成', () => {
  function orphanLocked(over: Row = {}) {
    return claimed(
      { kind: 'orphan_delete' },
      {
        state: 'delete_pending',
        resourceId: null,
        unboundExpiresAt: new Date(Date.now() - 1000),
        ...over,
      },
    );
  }

  it.each([
    ['kind 不是 orphan_delete', { kind: 'attachment_upload_verify' }, {}],
    ['仍绑着资源', {}, { resourceId: ATTACHMENT_ID }],
    ['state 不是 delete_pending', {}, { state: 'absent' }],
    ['尚未到期', {}, { unboundExpiresAt: new Date(Date.now() + 3_600_000) }],
  ])('锁内复核拒绝:%s', async (_label, opOver, objOver) => {
    const locked = claimed({ kind: 'orphan_delete', ...opOver }, {
      state: 'delete_pending',
      resourceId: null,
      unboundExpiresAt: new Date(Date.now() - 1000),
      ...objOver,
    });
    const { service } = makeService({ locked });
    await expect(service.finalizeOrphanAbsent(locked as never)).rejects.toThrow(
      'orphan absent locked state rejected',
    );
  });

  it('全过:对象置 absent 并清空错误码', async () => {
    const locked = orphanLocked();
    const { service, storageObjectUpdateMany } = makeService({ locked });
    await service.finalizeOrphanAbsent(locked as never);
    expect(storageObjectUpdateMany.mock.calls[0]?.[0].data).toMatchObject({
      state: 'absent',
      lastErrorCode: null,
      lastErrorClass: null,
    });
  });

  it('对象 CAS 丢:抛 Invariant', async () => {
    const locked = orphanLocked();
    const { service } = makeService({ locked, objectCount: 0 });
    await expect(service.finalizeOrphanAbsent(locked as never)).rejects.toThrow(
      'orphan absent object CAS lost',
    );
  });
});

describe('promoteBackfillAvailable —— 顺带提升(返回 false 而非抛)', () => {
  function current(over: Row = {}) {
    return object({
      source: 'backfill',
      state: 'provider_unknown',
      resourceType: 'attachment',
      resourceId: ATTACHMENT_ID,
      ...over,
    });
  }

  const candidate = () =>
    object({
      source: 'backfill',
      state: 'provider_unknown',
      resourceType: 'attachment',
      resourceId: ATTACHMENT_ID,
    });

  it('入参对象没有 attachment 关联:抛(这是调用方的编程错误,不是竞态)', async () => {
    const { service } = makeService({ currentObject: current() });
    await expect(
      service.promoteBackfillAvailable(object({ resourceType: null }) as never, COS, head() as never),
    ).rejects.toThrow('candidate object has no Attachment resource');
  });

  it.each([
    ['锁内已查不到该行', null],
    ['resourceId 变了(被重新绑定)', { resourceId: 'att-OTHER' }],
    ['已请求删除', { deleteRequestedAt: new Date() }],
    ['state 已进终态 absent', { state: 'absent' }],
  ])('⚠️ 锁内复核不通过:返回 false 而非抛 —— 顺带提升失败不该拖垮调用方', async (_label, over) => {
    const { service, promoteUpdateMany } = makeService({
      currentObject: over === null ? null : current(over),
    });
    await expect(
      service.promoteBackfillAvailable(candidate() as never, COS, head() as never),
    ).resolves.toBe(false);
    expect(promoteUpdateMany).not.toHaveBeenCalled();
  });

  it('⚠️ 该对象上有多条活跃操作:抛 —— 这是账本自身坏了,不是竞态', async () => {
    const { service } = makeService({
      currentObject: current(),
      activeOperations: [
        { id: 'op-1', kind: 'backfill_verify' },
        { id: 'op-2', kind: 'orphan_delete' },
      ],
    });
    await expect(
      service.promoteBackfillAvailable(candidate() as never, COS, head() as never),
    ).rejects.toThrow('multiple active storage operations');
  });

  it('⚠️ 活跃操作不是 backfill_verify(例如正在删):返回 false,不抢别人的对象', async () => {
    const { service } = makeService({
      currentObject: current(),
      activeOperations: [{ id: 'op-1', kind: 'orphan_delete' }],
    });
    await expect(
      service.promoteBackfillAvailable(candidate() as never, COS, head() as never),
    ).resolves.toBe(false);
  });

  it('无活跃操作:提升对象,不去改任何操作行', async () => {
    const { service, promoteUpdateMany, tx } = makeService({
      currentObject: current(),
      activeOperations: [],
    });
    await expect(
      service.promoteBackfillAvailable(candidate() as never, COS, head() as never),
    ).resolves.toBe(true);
    expect(promoteUpdateMany).toHaveBeenCalledTimes(1);
    expect(tx.storageObjectOperation.updateMany).not.toHaveBeenCalled();
  });

  it('⚠️ 对象已是 available:跳过提升但仍要收尾那条 backfill_verify —— 否则操作永远悬着', async () => {
    const { service, promoteUpdateMany, tx } = makeService({
      currentObject: current({ state: 'available' }),
      activeOperations: [{ id: 'op-1', kind: 'backfill_verify' }],
    });
    await expect(
      service.promoteBackfillAvailable(candidate() as never, COS, head() as never),
    ).resolves.toBe(true);
    expect(promoteUpdateMany).not.toHaveBeenCalled();
    expect(tx.storageObjectOperation.updateMany).toHaveBeenCalledTimes(1);
  });

  it('提升 CAS 丢:返回 false(有人抢先了,不是错误)', async () => {
    const { service } = makeService({
      currentObject: current(),
      activeOperations: [],
      promoteCount: 0,
    });
    await expect(
      service.promoteBackfillAvailable(candidate() as never, COS, head() as never),
    ).resolves.toBe(false);
  });

  it('⚠️ 收尾操作 CAS 丢:抛 —— 对象已提升却收不掉操作,是必须暴露的不一致', async () => {
    const { service } = makeService({
      currentObject: current(),
      activeOperations: [{ id: 'op-1', kind: 'backfill_verify' }],
      completeCount: 0,
    });
    await expect(
      service.promoteBackfillAvailable(candidate() as never, COS, head() as never),
    ).rejects.toThrow('active backfill completion lost');
  });

  it('HEAD etag 与账上不符:抛完整性不符,不提升', async () => {
    const { service, promoteUpdateMany } = makeService({
      currentObject: current({ etag: 'W/"expected"' }),
      activeOperations: [],
    });
    await expect(
      service.promoteBackfillAvailable(candidate() as never, COS, head({ etag: 'W/"x"' }) as never),
    ).rejects.toThrow('provider HEAD etag mismatch');
    expect(promoteUpdateMany).not.toHaveBeenCalled();
  });
});
