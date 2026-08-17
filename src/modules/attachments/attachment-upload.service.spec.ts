import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { StorageProvider } from '../storage/storage.interface';
import type { StorageObjectLedgerService } from '../storage/storage-object-ledger.service';
import {
  StorageUploadIdentityConflictError,
  storageOwnerUploadEventKey,
  storageOwnerlessUploadEventKey,
  storageRequestHash,
} from '../storage/storage-consistency.types';
import type { AttachmentAuditRecorder } from './attachment-audit-recorder';
import type { AttachmentContentValidator } from './attachment-content-validator';
import type { AttachmentReconciliationService } from './attachment-reconciliation.service';
import { AttachmentUploadService } from './attachment-upload.service';

/*
 * 附件上传建账链路的单测(#1047 抽出,此前零覆盖 —— 本刀补齐)。
 *
 * 一次上传跨三个阶段,阶段之间隔着 HTTP 往返与供应商 IO,客户端可能在任意一处断线重试:
 *   受理 prepareUpload  → 取证 verifyUploadEvidence → 落账 finalizeUpload
 * 所以这条链的骨架是**幂等与所有权**,不是可选加固。本 spec 的三条主轴:
 *
 *   ① eventKey / requestHash 的归属校验 —— 一条上传凭证只能被它的 owner 用掉。
 *      requestHash 已经绑定 owner,额外那道 eventKey 明检是为了挡住「畸形的 owner-v1 操作
 *      被算到别的 Content 头上」。两道都钉。
 *   ② finalizeUploadInTransaction 的十余道闸 —— 它是唯一会**创建 Attachment 行**的地方,
 *      任何一道放松都等于「在不该建账的时候建了账」。
 *   ③ 错误分型 —— ATTACHMENT_NOT_FOUND(这条凭证不对)与 STORAGE_OPERATION_PENDING
 *      (对不对不知道,再来一次)语义相反:前者让客户端放弃,后者让它重试。混淆会造成
 *      「本该重试的被放弃」或「本该放弃的死循环重试」。
 *
 * ⚠️ fixture 约束:requestHash 必须是 64 位 sha256 hex(storageOwnerUploadEventKey 会校验),
 * payload 必须恰好是 { source } 一个键(exactKeys 严格校验)。这两条不满足时用例根本走不到被测分支,
 * 却仍可能因为「抛了个别的错」而误绿 —— 故用例一律断言**具体**错误,不用宽松匹配。
 *
 * ⚠️ 覆盖不到的:四段锁序(owner → 对象 → 全部操作 → 落库)的**先后**。mock 不会真加锁,
 * 次序仍靠编排器锁序台账与并发 e2e。
 */

const OBJECT_ID = 'obj-000000001';
const OPERATION_ID = 'op-0000000001';
const ATTACHMENT_ID = 'att-000000001';
const USER_ID = 'usr-000000001';
const KEY = 'attachments/a.png';

type Row = Record<string, unknown>;

const COS = {
  providerType: 'COS' as const,
  bucket: 'bkt-1',
  region: 'ap-guangzhou',
  localNamespace: null,
};

function identity(over: Row = {}) {
  return {
    key: KEY,
    ownerType: 'member',
    ownerId: 'mem-000000001',
    originalName: 'a.png',
    mime: 'image/png',
    size: 1024,
    uploadedByUserId: USER_ID,
    ...over,
  };
}

/*
 * ⚠️ requestHash 必须由**身份真算**,不能用一个随手写的 64 位常量。
 * verifyUploadEvidence 在方法内部自己算 hash 再拼 eventKey,与传入的操作行比对;
 * fixture 若拿常量拼 eventKey,比对必然不等 —— 用例会一路撞到 NOT_FOUND,
 * 看起来"红得有理由",实际连被测分支的门都没进。
 */
function hashFor(
  source: 'attachment_signed_upload' | 'attachment_legacy' = 'attachment_signed_upload',
  over: Row = {},
): string {
  return storageRequestHash({ source, ...identity(over) });
}

function eventKeyFor(
  source: 'attachment_signed_upload' | 'attachment_legacy' = 'attachment_signed_upload',
  over: Row = {},
): string {
  const id = identity(over);
  return storageOwnerUploadEventKey(id.ownerType, id.ownerId, hashFor(source, over));
}

const HASH = hashFor();

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
    actualSize: null,
    actualMime: null,
    etag: null,
    checksum: null,
    presentAt: null,
    unboundExpiresAt: new Date(Date.now() + 3_600_000),
    ...COS,
    ...over,
  };
}

function operation(over: Row = {}): Row {
  return {
    id: OPERATION_ID,
    kind: 'attachment_upload_verify',
    storageObjectId: OBJECT_ID,
    requestHash: HASH,
    eventKey: eventKeyFor(),
    payloadVersion: 1,
    payload: { source: 'attachment_signed_upload' },
    status: 'processing',
    effectState: 'not_started',
    ...over,
  };
}

function head(over: Row = {}) {
  return { exists: true, size: 1024, etag: 'W/"e"', contentType: 'image/png', ...over };
}

function attachmentRow(over: Row = {}) {
  return {
    id: ATTACHMENT_ID,
    key: KEY,
    ownerType: 'member',
    ownerId: 'mem-000000001',
    originalName: 'a.png',
    mime: 'image/png',
    size: 1024,
    uploadedBy: USER_ID,
    ...over,
  };
}

function createData(over: Row = {}) {
  return {
    key: KEY,
    ownerType: 'member',
    ownerId: 'mem-000000001',
    originalName: 'a.png',
    mime: 'image/png',
    size: 1024,
    uploadedBy: USER_ID,
    ...over,
  };
}

function finalizeInput(over: Row = {}) {
  return {
    identity: identity(),
    requestHash: HASH,
    data: createData(),
    auditKind: 'legacy' as const,
    actorRoleSnap: 'ADMIN',
    scope: null,
    ownerTable: 'member',
    auditMeta: { requestId: 'req000000001', ip: '10.0.0.1', ua: 'jest' },
    ...over,
  };
}

function makeService(
  options: {
    storageObject?: Row | null;
    currentOperation?: Row | null;
    activeOrphans?: Array<{ id: string }>;
    existingAttachment?: Row | null;
    ownerRows?: Row[];
    findObjectByKey?: Row | null;
    findObjectThrows?: boolean;
    uploadContext?: { object: Row; operation: Row };
    findUploadContextThrows?: boolean;
    strict?: boolean;
  } = {},
) {
  const attachmentCreate = jest
    .fn<Promise<Row>, [{ data: Row }]>()
    .mockResolvedValue(attachmentRow());
  const storageObjectUpdate = jest.fn<Promise<Row>, [{ data: Row }]>().mockResolvedValue({});
  const operationUpdate = jest.fn<Promise<Row>, [{ data: Row }]>().mockResolvedValue({});

  const tx = {
    $queryRaw: jest
      .fn()
      .mockResolvedValue(options.ownerRows ?? [{ id: 'mem-000000001', deletedAt: null }]),
    storageObject: {
      findUnique: jest
        .fn()
        .mockResolvedValue(options.storageObject === undefined ? object() : options.storageObject),
      update: storageObjectUpdate,
    },
    storageObjectOperation: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          options.currentOperation === undefined ? operation() : options.currentOperation,
        ),
      findMany: jest.fn().mockResolvedValue(options.activeOrphans ?? []),
      update: operationUpdate,
    },
    attachment: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          options.existingAttachment === undefined ? attachmentRow() : options.existingAttachment,
        ),
      create: attachmentCreate,
    },
  };

  const prisma = {
    $transaction: jest.fn().mockImplementation((fn: (t: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;

  const prepareUploadInTransaction = jest
    .fn<Promise<Row>, [unknown, { locator: unknown }]>()
    .mockResolvedValue({ object: object(), operation: operation() });
  // ⚠️ 每个 mock 都提成具名 const 再返回:直接 expect(ledger.foo) 会被 unbound-method 判红,
  // 且那样断言的是「从对象上摘下来的方法」,与被测代码实际调用的不一定是同一个引用。
  const findObjectByKey = options.findObjectThrows
    ? jest.fn().mockRejectedValue(new Error('db down'))
    : jest.fn().mockResolvedValue(options.findObjectByKey ?? null);
  const findUploadContext = options.findUploadContextThrows
    ? jest.fn().mockRejectedValue(new Error('missing'))
    : jest
        .fn()
        .mockResolvedValue(options.uploadContext ?? { object: object(), operation: operation() });
  const noteProviderUnknown = jest.fn().mockResolvedValue(undefined);
  const ack = jest.fn().mockResolvedValue(undefined);
  const nack = jest.fn().mockResolvedValue(undefined);
  const recordPresentUnboundClaimed = jest.fn().mockResolvedValue(undefined);
  const ledger = {
    isStrictMode: jest.fn().mockReturnValue(options.strict ?? false),
    prepareUploadInTransaction,
    findObjectByKey,
    findUploadContext,
    noteProviderUnknown,
    ack,
    nack,
    renewLease: jest.fn().mockImplementation((op: Row) => Promise.resolve(op)),
    recordPresentUnboundClaimed,
  } as unknown as StorageObjectLedgerService;

  const validateFromBuffer = jest.fn();
  const validateFromObjectAt = jest.fn().mockResolvedValue(head());
  const contentValidator = {
    validateFromBuffer,
    validateFromObjectAt,
  } as unknown as AttachmentContentValidator;

  const logUpload = jest.fn().mockResolvedValue(undefined);
  const logUploadConfirmed = jest.fn().mockResolvedValue(undefined);
  const auditRecorder = { logUpload, logUploadConfirmed } as unknown as AttachmentAuditRecorder;

  const transitionUploadVerifyToOrphan = jest.fn().mockResolvedValue(undefined);
  const finalizeUnboundAbsent = jest.fn().mockResolvedValue(undefined);
  const reconciliation = {
    transitionUploadVerifyToOrphan,
    finalizeUnboundAbsent,
  } as unknown as AttachmentReconciliationService;

  const provider = {
    getCurrentLocator: jest.fn().mockResolvedValue(COS),
    putObjectAt: jest.fn().mockResolvedValue(undefined),
    deleteObjectAt: jest.fn(),
    generateUploadUrlAt: jest
      .fn<Promise<Row>, [unknown, unknown]>()
      .mockResolvedValue({ url: 'https://x/y', headers: {} }),
    generateDownloadUrlAt: jest.fn(),
    headObjectAt: jest.fn().mockResolvedValue(head()),
    readObjectPrefixAt: jest.fn(),
    hashObjectSha256At: jest.fn(),
  };

  return {
    service: new AttachmentUploadService(
      prisma,
      ledger,
      contentValidator,
      auditRecorder,
      reconciliation,
      provider as unknown as StorageProvider,
    ),
    prisma,
    ledger,
    contentValidator,
    auditRecorder,
    reconciliation,
    provider,
    tx,
    attachmentCreate,
    storageObjectUpdate,
    operationUpdate,
    prepareUploadInTransaction,
    findObjectByKey,
    findUploadContext,
    noteProviderUnknown,
    ack,
    nack,
    recordPresentUnboundClaimed,
    validateFromBuffer,
    validateFromObjectAt,
    logUpload,
    logUploadConfirmed,
    transitionUploadVerifyToOrphan,
    finalizeUnboundAbsent,
  };
}

describe('resolveUploadLocatorForTransaction —— 事务外解析 locator', () => {
  it('已有对象:用它自身的 locator,不问供应商', async () => {
    const { service, provider } = makeService({ findObjectByKey: object() });
    await expect(service.resolveUploadLocatorForTransaction(KEY)).resolves.toEqual(COS);
    expect(provider.getCurrentLocator).not.toHaveBeenCalled();
  });

  it('没有对象:落到供应商当前 locator(这是新建账的正常路径)', async () => {
    const { service, provider } = makeService({ findObjectByKey: null });
    await expect(service.resolveUploadLocatorForTransaction(KEY)).resolves.toEqual(COS);
    expect(provider.getCurrentLocator).toHaveBeenCalledTimes(1);
  });

  it('⚠️ 查询抛错:映射成 PENDING 而非 NOT_FOUND —— 查不动 ≠ 不存在,客户端该重试', async () => {
    const { service } = makeService({ findObjectThrows: true });
    await expect(service.resolveUploadLocatorForTransaction(KEY)).rejects.toThrow(
      BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING.message,
    );
  });

  it('⚠️ 对象存在但 locator 残缺:同样 PENDING —— 半固定的行不该被当成「没有」', async () => {
    const { service } = makeService({
      findObjectByKey: object({ providerType: null, bucket: null, region: null }),
    });
    await expect(service.resolveUploadLocatorForTransaction(KEY)).rejects.toThrow(
      BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING.message,
    );
  });
});

describe('prepareUploadInTransaction —— 根事务内绝不碰供应商', () => {
  it('⚠️ 未给 locator 且对象不存在:抛 NOT_FOUND,**不**去问供应商建新账', async () => {
    // 调用方持有根事务时,不能在事务里发起供应商 IO(会把事务时长拖到不可控)。
    // 已发出的上传凭证必然对应一条已存在的对象;查不到就是凭证无效,不能在第二条侧路里补建。
    const { service, provider, tx } = makeService({ findObjectByKey: null });
    await expect(
      service.prepareUploadInTransaction(
        tx as never,
        identity() as never,
        'attachment_signed_upload',
        new Date(),
      ),
    ).rejects.toThrow(BizCode.ATTACHMENT_NOT_FOUND.message);
    expect(provider.getCurrentLocator).not.toHaveBeenCalled();
  });

  it('未给 locator 但对象存在:用对象自身 locator 继续', async () => {
    const { service, tx, prepareUploadInTransaction } = makeService({
      findObjectByKey: object(),
    });
    await service.prepareUploadInTransaction(
      tx as never,
      identity(),
      'attachment_signed_upload',
      new Date(),
    );
    expect(prepareUploadInTransaction.mock.calls[0]?.[1]).toMatchObject({ locator: COS });
  });

  it('查询抛错:PENDING(可重试)', async () => {
    const { service, tx } = makeService({ findObjectThrows: true });
    await expect(
      service.prepareUploadInTransaction(
        tx as never,
        identity() as never,
        'attachment_signed_upload',
        new Date(),
      ),
    ).rejects.toThrow(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING.message);
  });

  it('已给 locator:直接用,连查都不查', async () => {
    const { service, tx, findObjectByKey } = makeService();
    await service.prepareUploadInTransaction(
      tx as never,
      identity(),
      'attachment_signed_upload',
      new Date(),
      COS,
    );
    expect(findObjectByKey).not.toHaveBeenCalled();
  });
});

describe('prepareUploadWithLocatorInTransaction —— 身份冲突的映射', () => {
  it('⚠️ 账本抛身份冲突:映射成 NOT_FOUND —— 同 key 不同身份等于这条凭证不属于你', async () => {
    const { service, tx, prepareUploadInTransaction } = makeService();
    prepareUploadInTransaction.mockRejectedValue(new StorageUploadIdentityConflictError());
    await expect(
      service.prepareUploadWithLocatorInTransaction(
        tx as never,
        identity() as never,
        'attachment_signed_upload',
        new Date(),
        COS,
      ),
    ).rejects.toThrow(BizCode.ATTACHMENT_NOT_FOUND.message);
  });

  it('⚠️ 账本抛其它错误:原样上抛,不吞成 NOT_FOUND', async () => {
    const { service, tx, prepareUploadInTransaction } = makeService();
    prepareUploadInTransaction.mockRejectedValue(new Error('deadlock detected'));
    await expect(
      service.prepareUploadWithLocatorInTransaction(
        tx as never,
        identity() as never,
        'attachment_signed_upload',
        new Date(),
        COS,
      ),
    ).rejects.toThrow('deadlock detected');
  });

  it('成功:回执带 objectId / operationId / eventKey / requestHash / locator 五件', async () => {
    const { service, tx } = makeService();
    const prepared = await service.prepareUploadWithLocatorInTransaction(
      tx as never,
      identity(),
      'attachment_signed_upload',
      new Date(),
      COS,
    );
    // requestHash 单独断言:内嵌 expect.stringMatching 会让整个字面量退化成 any,
    // 那样 toEqual 的其余四个键实际上不再受类型检查保护。
    expect(prepared.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared).toEqual({
      objectId: OBJECT_ID,
      operationId: OPERATION_ID,
      eventKey: storageOwnerUploadEventKey('member', 'mem-000000001', HASH),
      requestHash: prepared.requestHash,
      locator: COS,
    });
  });
});

describe('prepareUploadUrl —— 签名 URL', () => {
  it('⚠️ 生成 URL 抛错:PENDING —— 账已经建好了,失败的只是发 URL 这一步', async () => {
    const { service, provider } = makeService({ findObjectByKey: object() });
    provider.generateUploadUrlAt.mockRejectedValue(new Error('SignatureDoesNotMatch'));
    await expect(service.prepareUploadUrl(identity() as never, new Date(), 900)).rejects.toThrow(
      BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING.message,
    );
  });

  it('成功:用受理阶段定下的 locator 发 URL,不是重新问供应商', async () => {
    const { service, provider } = makeService({ findObjectByKey: object() });
    await service.prepareUploadUrl(identity(), new Date(), 900);
    expect(provider.generateUploadUrlAt.mock.calls[0]?.[0]).toEqual(COS);
  });
});

describe('verifyUploadEvidence —— 取证阶段的归属校验', () => {
  it('查不到上传上下文:NOT_FOUND', async () => {
    const { service } = makeService({ findUploadContextThrows: true });
    await expect(
      service.verifyUploadEvidence(identity() as never, 'attachment_signed_upload'),
    ).rejects.toThrow(BizCode.ATTACHMENT_NOT_FOUND.message);
  });

  it('⚠️ 对象 source 与请求 source 不符:NOT_FOUND —— 签名上传的凭证不能拿去走 legacy 路径', async () => {
    const { service } = makeService({
      uploadContext: { object: object({ source: 'attachment_legacy' }), operation: operation() },
    });
    await expect(
      service.verifyUploadEvidence(identity() as never, 'attachment_signed_upload'),
    ).rejects.toThrow(BizCode.ATTACHMENT_NOT_FOUND.message);
  });

  it('⚠️ eventKey 既不是本 owner 的也不是 ownerless 的:NOT_FOUND', async () => {
    const { service } = makeService({
      uploadContext: {
        object: object(),
        operation: operation({
          eventKey: eventKeyFor('attachment_signed_upload', { ownerId: 'OTHER-owner' }),
        }),
      },
    });
    await expect(
      service.verifyUploadEvidence(identity() as never, 'attachment_signed_upload'),
    ).rejects.toThrow(BizCode.ATTACHMENT_NOT_FOUND.message);
  });

  it('ownerless(历史 v1)eventKey:放行 —— 老凭证仍要能验完', async () => {
    const { service } = makeService({
      uploadContext: {
        object: object(),
        operation: operation({ eventKey: storageOwnerlessUploadEventKey(hashFor()) }),
      },
    });
    await expect(
      service.verifyUploadEvidence(identity() as never, 'attachment_signed_upload'),
    ).resolves.toMatchObject({ exists: true });
  });

  it('⚠️ 对象已 available 且已绑定:直接用账上的数据回执,不再打供应商', async () => {
    const { service, validateFromObjectAt } = makeService({
      uploadContext: {
        object: object({
          state: 'available',
          resourceId: ATTACHMENT_ID,
          actualSize: BigInt(2048),
          actualMime: 'image/jpeg',
          etag: 'W/"stored"',
        }),
        operation: operation(),
      },
    });
    await expect(
      service.verifyUploadEvidence(identity() as never, 'attachment_signed_upload'),
    ).resolves.toEqual({
      exists: true,
      size: 2048,
      etag: 'W/"stored"',
      contentType: 'image/jpeg',
    });
    expect(validateFromObjectAt).not.toHaveBeenCalled();
  });

  it.each([['available'], ['absent'], ['delete_failed'], ['integrity_mismatch']])(
    '状态 %s 且未绑定:NOT_FOUND(不在可取证的三态内)',
    async (state) => {
      const { service } = makeService({
        uploadContext: { object: object({ state }), operation: operation() },
      });
      await expect(
        service.verifyUploadEvidence(identity() as never, 'attachment_signed_upload'),
      ).rejects.toThrow(BizCode.ATTACHMENT_NOT_FOUND.message);
    },
  );

  it('⚠️ 内容附件 + delete_pending:破例放行 —— 发布被取消后仍要能取证(否则重发无路可走)', async () => {
    const { service } = makeService({
      uploadContext: {
        object: object({ state: 'delete_pending' }),
        operation: operation({
          requestHash: hashFor('attachment_signed_upload', { ownerType: 'content-image' }),
          eventKey: eventKeyFor('attachment_signed_upload', { ownerType: 'content-image' }),
        }),
      },
    });
    await expect(
      service.verifyUploadEvidence(
        identity({ ownerType: 'content-image' }) as never,
        'attachment_signed_upload',
      ),
    ).resolves.toMatchObject({ exists: true });
  });

  it('⚠️ 非内容附件 + delete_pending:不破例,NOT_FOUND', async () => {
    const { service } = makeService({
      uploadContext: { object: object({ state: 'delete_pending' }), operation: operation() },
    });
    await expect(
      service.verifyUploadEvidence(identity() as never, 'attachment_signed_upload'),
    ).rejects.toThrow(BizCode.ATTACHMENT_NOT_FOUND.message);
  });

  it('⚠️ 校验抛非 Biz 错误:记 providerUnknown 并转 PENDING —— 网络不确定是可留痕的证据', async () => {
    const { service, validateFromObjectAt, noteProviderUnknown } = makeService();
    validateFromObjectAt.mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(
      service.verifyUploadEvidence(identity() as never, 'attachment_signed_upload'),
    ).rejects.toThrow(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING.message);
    expect(noteProviderUnknown).toHaveBeenCalledTimes(1);
  });

  it('⚠️ 校验抛 Biz 错误:原样上抛,**不**记 providerUnknown —— 业务判定不是供应商不确定', async () => {
    const { service, validateFromObjectAt, noteProviderUnknown } = makeService();
    validateFromObjectAt.mockRejectedValue(new BizException(BizCode.ATTACHMENT_MIME_NOT_ALLOWED));
    await expect(
      service.verifyUploadEvidence(identity() as never, 'attachment_signed_upload'),
    ).rejects.toThrow(BizCode.ATTACHMENT_MIME_NOT_ALLOWED.message);
    expect(noteProviderUnknown).not.toHaveBeenCalled();
  });
});

describe('putUploadObjectAtAndVerifyOutsideTransaction —— legacy 直传', () => {
  it('⚠️ put 抛错:PENDING(字节可能已经上去了,不能让客户端当失败处理)', async () => {
    const { service, provider } = makeService();
    provider.putObjectAt.mockRejectedValue(new Error('ECONNRESET'));
    await expect(
      service.putUploadObjectAtAndVerifyOutsideTransaction(
        identity() as never,
        'attachment_legacy',
        COS,
        Buffer.from('x'),
      ),
    ).rejects.toThrow(BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING.message);
  });

  it('put 成功后立刻取证(同一条链,不额外往返)', async () => {
    const { service, validateFromObjectAt } = makeService({
      uploadContext: {
        object: object({ source: 'attachment_legacy' }),
        operation: operation({
          payload: { source: 'attachment_legacy' },
          requestHash: hashFor('attachment_legacy'),
          eventKey: eventKeyFor('attachment_legacy'),
        }),
      },
    });
    await service.putUploadObjectAtAndVerifyOutsideTransaction(
      identity(),
      'attachment_legacy',
      COS,
      Buffer.from('x'),
    );
    expect(validateFromObjectAt).toHaveBeenCalledTimes(1);
  });
});

describe('finalizeUploadInTransaction —— 唯一会建 Attachment 行的地方', () => {
  async function finalize(svc: ReturnType<typeof makeService>, over: Row = {}, h = head()) {
    return svc.service.finalizeUploadInTransaction(
      svc.tx as never,
      finalizeInput(over) as never,
      h,
    );
  }

  it('对象不存在:NOT_FOUND', async () => {
    const svc = makeService({ storageObject: null });
    await expect(finalize(svc)).rejects.toThrow(BizCode.ATTACHMENT_NOT_FOUND.message);
  });

  it('找不到匹配 requestHash 的上传操作:NOT_FOUND', async () => {
    const svc = makeService({ currentOperation: null });
    await expect(finalize(svc)).rejects.toThrow(BizCode.ATTACHMENT_NOT_FOUND.message);
  });

  it('⚠️ 操作的 eventKey 不属于本 owner:NOT_FOUND —— requestHash 之外的第二道归属闸', async () => {
    const svc = makeService({
      currentOperation: operation({
        eventKey: storageOwnerUploadEventKey('member', 'OTHER-owner', HASH),
      }), // finalize 用的是传入的 input.requestHash,故此处仍以 HASH 拼,只换 owner
    });
    await expect(finalize(svc)).rejects.toThrow(BizCode.ATTACHMENT_NOT_FOUND.message);
  });

  it('⚠️ payload 的 source 与对象的 source 漂移:抛 Invariant —— 账本自身不一致,不是客户端问题', async () => {
    const svc = makeService({
      currentOperation: operation({ payload: { source: 'attachment_legacy' } }),
    });
    await expect(finalize(svc)).rejects.toThrow('upload operation source drifted');
  });

  it('⚠️ 该对象上有活跃的 orphan_delete:PENDING —— 正在被回收的对象不能同时落账', async () => {
    const svc = makeService({ activeOrphans: [{ id: 'op-orphan-01' }] });
    await expect(finalize(svc)).rejects.toThrow(
      BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING.message,
    );
  });

  it.each([['delete_pending'], ['delete_failed'], ['integrity_mismatch']])(
    '对象状态 %s:PENDING(可重试,不是凭证错)',
    async (state) => {
      const svc = makeService({ storageObject: object({ state }) });
      await expect(finalize(svc)).rejects.toThrow(
        BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING.message,
      );
    },
  );

  it('操作已 dead:PENDING', async () => {
    const svc = makeService({ currentOperation: operation({ status: 'dead' }) });
    await expect(finalize(svc)).rejects.toThrow(
      BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING.message,
    );
  });

  it('对象已绑定别的资源:NOT_FOUND', async () => {
    const svc = makeService({ storageObject: object({ resourceId: 'att-OTHER' }) });
    await expect(finalize(svc)).rejects.toThrow(BizCode.ATTACHMENT_NOT_FOUND.message);
  });

  it('⚠️ HEAD 显示实体不存在:NOT_FOUND —— 绝不为不存在的字节建账', async () => {
    const svc = makeService();
    await expect(finalize(svc, {}, head({ exists: false }))).rejects.toThrow(
      BizCode.ATTACHMENT_NOT_FOUND.message,
    );
    expect(svc.attachmentCreate).not.toHaveBeenCalled();
  });

  it('⚠️ HEAD 大小与账上不符:抛完整性不符,不建账', async () => {
    const svc = makeService();
    await expect(finalize(svc, {}, head({ size: 999 }))).rejects.toThrow(
      'provider HEAD size mismatch',
    );
    expect(svc.attachmentCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['key', { key: 'attachments/OTHER.png' }],
    ['ownerType', { ownerType: 'certificate' }],
    ['ownerId', { ownerId: 'other-owner' }],
    ['originalName', { originalName: 'other.png' }],
    ['mime', { mime: 'image/jpeg' }],
    ['size', { size: 2048 }],
    ['uploadedBy', { uploadedBy: 'usr-OTHER' }],
  ])(
    '⚠️ 待建行的 %s 与凭证身份不符:抛 Invariant —— 建账数据必须逐字来自被验证过的身份',
    async (_field, over) => {
      const svc = makeService();
      await expect(finalize(svc, { data: createData(over) })).rejects.toThrow(
        'Attachment create identity drifted',
      );
      expect(svc.attachmentCreate).not.toHaveBeenCalled();
    },
  );

  it('全过:建行 + 对象转 available 并回填 HEAD 证据 + 操作置终态', async () => {
    const svc = makeService();
    await expect(finalize(svc)).resolves.toMatchObject({ id: ATTACHMENT_ID });
    expect(svc.storageObjectUpdate.mock.calls[0]?.[0].data).toMatchObject({
      state: 'available',
      resourceType: 'attachment',
      resourceId: ATTACHMENT_ID,
      actualMime: 'image/png',
      etag: 'W/"e"',
      lastErrorCode: null,
      lastErrorClass: null,
    });
    expect(svc.operationUpdate.mock.calls[0]?.[0].data).toMatchObject({
      status: 'succeeded',
      effectState: 'provider_present',
      deadAt: null,
      leaseOwner: null,
    });
  });

  it('⚠️ presentAt 已有值时保留原值,不被本次覆盖(首次落地时间不该被改写)', async () => {
    const first = new Date('2099-01-01T00:00:00.000Z');
    const svc = makeService({ storageObject: object({ presentAt: first }) });
    await finalize(svc);
    expect(svc.storageObjectUpdate.mock.calls[0]?.[0].data.presentAt).toBe(first);
  });

  it('auditKind=confirmed 走 logUploadConfirmed;legacy 走 logUpload', async () => {
    const a = makeService();
    await finalize(a, { auditKind: 'confirmed' });
    expect(a.logUploadConfirmed).toHaveBeenCalledTimes(1);
    expect(a.logUpload).not.toHaveBeenCalled();

    const b = makeService();
    await finalize(b, { auditKind: 'legacy' });
    expect(b.logUpload).toHaveBeenCalledTimes(1);
    expect(b.logUploadConfirmed).not.toHaveBeenCalled();
  });

  describe('重入路径:对象已 available 且已绑定', () => {
    const bound = () =>
      object({ state: 'available', resourceType: 'attachment', resourceId: ATTACHMENT_ID });
    const done = () => operation({ status: 'succeeded', effectState: 'provider_present' });

    it('⚠️ 幂等返回既有行,不重复建账', async () => {
      const svc = makeService({ storageObject: bound(), currentOperation: done() });
      await expect(finalize(svc)).resolves.toMatchObject({ id: ATTACHMENT_ID });
      expect(svc.attachmentCreate).not.toHaveBeenCalled();
    });

    it('⚠️ 操作尚未置终态:NOT_FOUND —— 对象说完成了但操作没有,这条链没走完', async () => {
      const svc = makeService({
        storageObject: bound(),
        currentOperation: operation({ status: 'processing' }),
      });
      await expect(finalize(svc)).rejects.toThrow(BizCode.ATTACHMENT_NOT_FOUND.message);
    });

    it('⚠️ 既有 Attachment 行的身份与本次凭证不符:NOT_FOUND,不把别人的行返给你', async () => {
      const svc = makeService({
        storageObject: bound(),
        currentOperation: done(),
        existingAttachment: attachmentRow({ ownerId: 'OTHER-owner' }),
      });
      await expect(finalize(svc)).rejects.toThrow(BizCode.ATTACHMENT_NOT_FOUND.message);
    });

    it('既有行已被删:NOT_FOUND', async () => {
      const svc = makeService({
        storageObject: bound(),
        currentOperation: done(),
        existingAttachment: null,
      });
      await expect(finalize(svc)).rejects.toThrow(BizCode.ATTACHMENT_NOT_FOUND.message);
    });
  });
});

describe('executeUploadVerify —— worker 侧驱动', () => {
  function claim(objectOver: Row = {}) {
    return {
      id: OPERATION_ID,
      kind: 'attachment_upload_verify',
      storageObjectId: OBJECT_ID,
      leaseGeneration: 2,
      storageObject: object(objectOver),
    };
  }

  it('对象已绑定:直接 ack,不再取证', async () => {
    const { service, ack, validateFromObjectAt } = makeService();
    await service.executeUploadVerify(claim({ resourceId: ATTACHMENT_ID }) as never);
    expect(ack).toHaveBeenCalledWith(expect.anything(), 'provider_present');
    expect(validateFromObjectAt).not.toHaveBeenCalled();
  });

  it('对象已 available:直接 ack', async () => {
    const { service, ack } = makeService();
    await service.executeUploadVerify(claim({ state: 'available' }) as never);
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('⚠️ 取证成功但未到期:nack 成 AwaitingConfirm —— 等客户端确认,不是失败', async () => {
    const { service, recordPresentUnboundClaimed, nack, transitionUploadVerifyToOrphan } =
      makeService();
    await service.executeUploadVerify(claim() as never);
    expect(recordPresentUnboundClaimed).toHaveBeenCalledTimes(1);
    expect(nack).toHaveBeenCalledTimes(1);
    expect(transitionUploadVerifyToOrphan).not.toHaveBeenCalled();
  });

  it('⚠️ 取证成功但已过期:转孤儿(客户端再没来确认过)', async () => {
    const { service, transitionUploadVerifyToOrphan, nack } = makeService();
    await service.executeUploadVerify(
      claim({ unboundExpiresAt: new Date(Date.now() - 1000) }) as never,
    );
    expect(transitionUploadVerifyToOrphan).toHaveBeenCalledTimes(1);
    expect(nack).not.toHaveBeenCalled();
  });

  it('⚠️ 取证发现不存在且已过期:收敛成 absent', async () => {
    const { service, validateFromObjectAt, finalizeUnboundAbsent } = makeService();
    validateFromObjectAt.mockRejectedValue(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
    await service.executeUploadVerify(
      claim({ unboundExpiresAt: new Date(Date.now() - 1000) }) as never,
    );
    expect(finalizeUnboundAbsent).toHaveBeenCalledTimes(1);
  });

  it('⚠️ 取证发现不存在但**未**过期:上抛让 worker 重试 —— 字节可能还在路上', async () => {
    const { service, validateFromObjectAt, finalizeUnboundAbsent } = makeService();
    validateFromObjectAt.mockRejectedValue(new BizException(BizCode.ATTACHMENT_NOT_FOUND));
    await expect(service.executeUploadVerify(claim() as never)).rejects.toThrow(
      BizCode.ATTACHMENT_NOT_FOUND.message,
    );
    expect(finalizeUnboundAbsent).not.toHaveBeenCalled();
  });

  it('⚠️ 取证抛非 NOT_FOUND 错误且已过期:仍然上抛,不当作「确实不存在」收敛', async () => {
    const { service, validateFromObjectAt, finalizeUnboundAbsent } = makeService();
    validateFromObjectAt.mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(
      service.executeUploadVerify(
        claim({ unboundExpiresAt: new Date(Date.now() - 1000) }) as never,
      ),
    ).rejects.toThrow('ETIMEDOUT');
    expect(finalizeUnboundAbsent).not.toHaveBeenCalled();
  });
});

describe('lockActiveUploadOwner —— 多态属主的锁与状态闸', () => {
  function lock(svc: ReturnType<typeof makeService>, ownerType: string, ownerTable: string) {
    return svc.service.lockActiveUploadOwner(svc.tx as never, ownerType, ownerTable, 'owner-1');
  }

  it.each([['content-image'], ['content-file']])('%s:草稿态放行', async (ownerType) => {
    const svc = makeService({
      ownerRows: [{ id: 'owner-1', deletedAt: null, statusCode: 'draft', publishedAt: null }],
    });
    await expect(lock(svc, ownerType, 'contents')).resolves.toBeUndefined();
  });

  it('⚠️ 内容已发布:抛状态不可转换 —— 已发布的内容不能再挂新附件', async () => {
    const svc = makeService({
      ownerRows: [
        { id: 'owner-1', deletedAt: null, statusCode: 'published', publishedAt: new Date() },
      ],
    });
    await expect(lock(svc, 'content-image', 'contents')).rejects.toThrow(
      BizCode.CONTENT_INVALID_STATUS_TRANSITION.message,
    );
  });

  it('⚠️ 状态仍是 draft 但 publishedAt 有值:同样拒绝 —— 两个字段都要干净', async () => {
    const svc = makeService({
      ownerRows: [{ id: 'owner-1', deletedAt: null, statusCode: 'draft', publishedAt: new Date() }],
    });
    await expect(lock(svc, 'content-image', 'contents')).rejects.toThrow(
      BizCode.CONTENT_INVALID_STATUS_TRANSITION.message,
    );
  });

  it('内容已软删:抛属主不存在', async () => {
    const svc = makeService({
      ownerRows: [{ id: 'owner-1', deletedAt: new Date(), statusCode: 'draft', publishedAt: null }],
    });
    await expect(lock(svc, 'content-image', 'contents')).rejects.toThrow(
      BizCode.ATTACHMENT_OWNER_NOT_FOUND.message,
    );
  });

  it('报名上传会话:active 放行,非 active 抛 NOT_FOUND', async () => {
    const ok = makeService({ ownerRows: [{ id: 'owner-1', statusCode: 'active' }] });
    await expect(
      lock(ok, 'registration-upload-session', 'registration_upload_sessions'),
    ).resolves.toBeUndefined();

    const bad = makeService({ ownerRows: [{ id: 'owner-1', statusCode: 'closed' }] });
    await expect(
      lock(bad, 'registration-upload-session', 'registration_upload_sessions'),
    ).rejects.toThrow(BizCode.ATTACHMENT_NOT_FOUND.message);
  });

  it('⚠️ 考勤导入预览:三个字段同时对上才放行', async () => {
    const ok = makeService({
      ownerRows: [
        {
          id: 'owner-1',
          jobTypeCode: 'import_preview',
          statusCode: 'pending',
          action: 'onsite_import_preview',
        },
      ],
    });
    await expect(
      lock(ok, 'attendance-import-preview', 'activity_batch_jobs'),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['jobTypeCode 不对', { jobTypeCode: 'export' }],
    ['statusCode 不对', { statusCode: 'running' }],
    ['payload.action 不对', { action: 'other_action' }],
    ['payload.action 缺失', { action: null }],
  ])('考勤导入预览拒绝:%s', async (_label, over) => {
    const svc = makeService({
      ownerRows: [
        {
          id: 'owner-1',
          jobTypeCode: 'import_preview',
          statusCode: 'pending',
          action: 'onsite_import_preview',
          ...over,
        },
      ],
    });
    await expect(lock(svc, 'attendance-import-preview', 'activity_batch_jobs')).rejects.toThrow(
      BizCode.ATTACHMENT_NOT_FOUND.message,
    );
  });

  it.each([
    ['member', 'member'],
    ['certificate', 'certificate'],
    ['activity', 'activity'],
  ])('%s:未软删放行', async (ownerType, ownerTable) => {
    const svc = makeService({ ownerRows: [{ id: 'owner-1', deletedAt: null }] });
    await expect(lock(svc, ownerType, ownerTable)).resolves.toBeUndefined();
  });

  it.each([
    ['member', 'member'],
    ['certificate', 'certificate'],
    ['activity', 'activity'],
  ])('%s:已软删抛属主不存在', async (ownerType, ownerTable) => {
    const svc = makeService({ ownerRows: [{ id: 'owner-1', deletedAt: new Date() }] });
    await expect(lock(svc, ownerType, ownerTable)).rejects.toThrow(
      BizCode.ATTACHMENT_OWNER_NOT_FOUND.message,
    );
  });

  it('行不存在:抛属主不存在', async () => {
    const svc = makeService({ ownerRows: [] });
    await expect(lock(svc, 'member', 'member')).rejects.toThrow(
      BizCode.ATTACHMENT_OWNER_NOT_FOUND.message,
    );
  });

  it('⚠️ ownerType 与 ownerTable 搭配不在白名单内:default 分支抛 —— 未登记的属主一律拒绝', async () => {
    const svc = makeService();
    await expect(lock(svc, 'member', 'certificate')).rejects.toThrow(
      BizCode.ATTACHMENT_OWNER_NOT_FOUND.message,
    );
    await expect(lock(svc, 'unknown-owner', 'whatever')).rejects.toThrow(
      BizCode.ATTACHMENT_OWNER_NOT_FOUND.message,
    );
  });
});

describe('薄封装', () => {
  it('uploadRequestHash 是 64 位 sha256 hex,且随 source 变化', () => {
    const { service } = makeService();
    const signed = service.uploadRequestHash(identity(), 'attachment_signed_upload');
    const legacy = service.uploadRequestHash(identity(), 'attachment_legacy');
    expect(signed).toMatch(/^[0-9a-f]{64}$/);
    expect(signed).not.toBe(legacy);
  });

  it('⚠️ uploadRequestHash 随身份任一字段变化 —— 否则两次不同上传会共用一条操作', () => {
    const { service } = makeService();
    const base = service.uploadRequestHash(identity(), 'attachment_signed_upload');
    for (const over of [
      { key: 'attachments/other.png' },
      { ownerId: 'other' },
      { size: 2048 },
      { mime: 'image/jpeg' },
      { uploadedByUserId: 'usr-OTHER' },
    ]) {
      expect(
        service.uploadRequestHash(identity(over) as never, 'attachment_signed_upload'),
      ).not.toBe(base);
    }
  });

  it('validateUploadBufferOutsideTransaction 转交内容校验器', () => {
    const { service, validateFromBuffer } = makeService();
    const buffer = Buffer.from('x');
    service.validateUploadBufferOutsideTransaction('image/png', buffer);
    expect(validateFromBuffer).toHaveBeenCalledWith({ mime: 'image/png', buffer });
  });
});
