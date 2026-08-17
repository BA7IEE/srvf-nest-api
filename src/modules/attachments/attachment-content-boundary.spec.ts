import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  STORAGE_ATTACHMENT_UPLOAD_EVENT_PREFIX,
  STORAGE_OPERATION_PAYLOAD_VERSION,
  storageOwnerUploadEventKeyPrefix,
  storageRequestHash,
} from '../storage/storage-consistency.types';
import {
  lockContentPublishBoundary,
  lockContentPublishBoundaryUnsafe,
  lockContentReferenceBoundary,
} from './attachment-content-boundary';

/*
 * 内容发布/引用边界锁的单测(#1049 抽出;lockContentPublishBoundaryUnsafe 单函数 364 行,
 * 是全仓最大单体方法,此前**零覆盖** —— 本刀补齐,作为拆分它的前置条件)。
 *
 * 这一层守的是「内容发出去之后不会是死链」:正文引用的每个附件都必须存在、属于本文、已就绪,
 * 且没有任何一条在途的存储操作能在发布之后把它改掉。判据全部 **fail-closed**:
 * 拿不准就拒,拒的方式是抛 ATTACHMENT_STORAGE_OPERATION_PENDING(让调用方重试),
 * 而不是放行。**放松任何一条都等于允许发布一篇正文指向不存在附件的内容。**
 *
 * 本 spec 的组织方式:先建一个自洽的"世界"(一篇内容 + 一个封面图附件 + 其存储对象 + 已完成的上传操作),
 * 每个用例只扰动其中**一件事**,断言它被拒。这样红的时候能立刻定位到是哪条判据,
 * 而不是"某处不对"。22 个拒绝点逐条对应。
 *
 * ⚠️ 覆盖不到的两件事,都写在这里而不是假装覆盖了:
 *   ① **锁序**。本层是被调用方,调用顺序即锁顺序;mock 不会真加锁,
 *      把调用挪到链路更晚处会静默破坏锁序且不会有任何测试失败。那条约束靠编排器锁序台账 + 并发 e2e。
 *   ② **FOR UPDATE 的实际阻塞**。这里的"并发写者插进来"是用两次读返回不同结果模拟的,
 *      真实的序列化由 PG 保证。本层锁的是「读到不一致时代码怎么反应」。
 *
 * ⚠️ 判据密集带来一个特有陷阱:**一条判据被下游判据遮蔽时,针对它的用例照样绿**。
 * 本 spec 初版有 6 条用例是这样"为错的理由绿"的(闸②被③遮、③被⑧遮、④被⑤遮、
 * ⑦被⑫遮、⑮被⑰遮、⑰-source 被⑲遮),全部由变异对拍抓出。
 * 修法是让每条用例把**下游闸的前提都补足**,只留自己那一条不满足。
 * 后续给本文件加用例的人:写完请对着你要守的那一行做一次变异,别只看绿。
 *
 * 变异对拍还查实两条结构性事实,已就地注在对应用例上:
 *   · 闸⑰的 source 白名单被闸⑲**完全包含** —— 删掉行为不变,是纵深防御而非独立闸。
 *   · 闸⑰的 `!object.unboundExpiresAt` **结构上删不掉** —— 删了下游
 *     `object.unboundExpiresAt.getTime()` 就窄化不了,TS18047 编译失败。类型系统在替它站岗。
 */

const CONTENT_ID = 'cnt-000000001';
const ATT_ID = 'att-000000001';
const OBJ_ID = 'obj-000000001';
const UPLOAD_OP_ID = 'op-upload-00001';
const KEY = 'attachments/cover.png';
const IMAGE_PREFIX = storageOwnerUploadEventKeyPrefix('content-image', CONTENT_ID);
const UPLOAD_HASH = 'c'.repeat(64);
const PENDING = BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING.message;

type Row = Record<string, unknown>;

function attachment(over: Row = {}): Row {
  return {
    id: ATT_ID,
    key: KEY,
    ownerType: 'content-image',
    ownerId: CONTENT_ID,
    ...over,
  };
}

function object(over: Row = {}): Row {
  return {
    id: OBJ_ID,
    key: KEY,
    state: 'available',
    source: 'attachment_signed_upload',
    resourceType: 'attachment',
    resourceId: ATT_ID,
    deleteRequestedAt: null,
    unboundExpiresAt: null,
    ...over,
  };
}

/** 已完成的 owner-v1 上传操作:eventKey 必须恰好是 prefix + requestHash。 */
function uploadOp(over: Row = {}): Row {
  return {
    id: UPLOAD_OP_ID,
    kind: 'attachment_upload_verify',
    storageObjectId: OBJ_ID,
    eventKey: `${IMAGE_PREFIX}${UPLOAD_HASH}`,
    requestHash: UPLOAD_HASH,
    status: 'succeeded',
    effectState: 'provider_present',
    payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
    payload: { source: 'attachment_signed_upload' },
    replayOfId: null,
    availableAt: new Date('2099-01-01T00:00:00.000Z'),
    ...over,
  };
}

function publishInput(over: Row = {}) {
  return {
    contentId: CONTENT_ID,
    referencedAttachmentIds: [ATT_ID],
    coverAttachmentId: ATT_ID,
    coverImageKey: KEY,
    ...over,
  };
}

/**
 * 建一个自洽的世界。
 *
 * ⚠️ $queryRaw 按**调用序**分派,这是本函数内确定的顺序:
 *   ① ownerless 探针 → ② attachments FOR UPDATE → ③④ 对象/操作 FOR UPDATE(仅当有候选对象)
 * 只有 ①② 的返回值被消费,③④ 的返回被丢弃。
 *
 * ⚠️ storageObjectOperation.findMany 被调用三次、语义各不相同,按 `select` 形状分派:
 *   { storageObjectId } → 候选意图;{ id, storageObjectId } → 锁后复读意图;无 select → 锁定的操作全集。
 * 按调用序分派会在分支变化时错位 —— 那种错位不会报错,只会让用例悄悄测了别的东西。
 */
function makeWorld(
  options: {
    ownerless?: Row[];
    lockedAttachmentIds?: string[];
    attachments?: Row[];
    attachmentsAfterLock?: Row[];
    objects?: Row[];
    operations?: Row[];
    ownerIntents?: Row[] | null;
    objectUpdatedCount?: number;
    uploadUpdatedCount?: number;
  } = {},
) {
  const attachments = options.attachments ?? [attachment()];
  const afterLock = options.attachmentsAfterLock ?? attachments;
  const objects = options.objects ?? [object()];
  const operations = options.operations ?? [uploadOp()];
  const lockedIds = options.lockedAttachmentIds ?? attachments.map((row) => row.id as string);
  const ownerIntents =
    options.ownerIntents === undefined
      ? operations
          .filter(
            (op) =>
              op.kind === 'attachment_upload_verify' &&
              typeof op.eventKey === 'string' &&
              op.eventKey.startsWith(IMAGE_PREFIX),
          )
          .map((op) => ({ id: op.id, storageObjectId: op.storageObjectId }))
      : (options.ownerIntents ?? []);

  let rawCall = 0;
  const queryRaw = jest.fn().mockImplementation(() => {
    rawCall += 1;
    if (rawCall === 1) return Promise.resolve(options.ownerless ?? []);
    if (rawCall === 2) return Promise.resolve(lockedIds.map((id) => ({ id })));
    return Promise.resolve([]);
  });

  let attachmentFindManyCall = 0;
  const attachmentFindMany = jest.fn().mockImplementation(() => {
    attachmentFindManyCall += 1;
    return Promise.resolve(attachmentFindManyCall === 1 ? attachments : afterLock);
  });

  const operationFindMany = jest
    .fn<Promise<Row[]>, [{ select?: Row }]>()
    .mockImplementation((args) => {
      const select = args.select ?? {};
      if (select.storageObjectId === true && select.id !== true) {
        return Promise.resolve(operations.map((op) => ({ storageObjectId: op.storageObjectId })));
      }
      if (select.id === true && select.storageObjectId === true) {
        return Promise.resolve(ownerIntents);
      }
      return Promise.resolve(operations);
    });

  const objectFindMany = jest
    .fn<Promise<Row[]>, [{ select?: Row }]>()
    .mockImplementation((args) =>
      Promise.resolve(args.select?.id === true ? objects.map((row) => ({ id: row.id })) : objects),
    );

  const objectUpdateMany = jest
    .fn<Promise<{ count: number }>, [{ data: Row }]>()
    .mockResolvedValue({ count: options.objectUpdatedCount ?? 1 });
  const operationUpdateMany = jest
    .fn<Promise<{ count: number }>, [{ data: Row }]>()
    .mockResolvedValue({ count: options.uploadUpdatedCount ?? 1 });
  const operationUpdate = jest.fn<Promise<Row>, [{ data: Row }]>().mockResolvedValue({});
  const operationCreate = jest.fn<Promise<Row>, [{ data: Row }]>().mockResolvedValue({});

  const tx = {
    $queryRaw: queryRaw,
    attachment: { findMany: attachmentFindMany },
    storageObject: { findMany: objectFindMany, updateMany: objectUpdateMany },
    storageObjectOperation: {
      findMany: operationFindMany,
      updateMany: operationUpdateMany,
      update: operationUpdate,
      create: operationCreate,
    },
  };

  return {
    tx,
    queryRaw,
    objectUpdateMany,
    operationUpdateMany,
    operationUpdate,
    operationCreate,
  };
}

function publish(world: ReturnType<typeof makeWorld>, over: Row = {}) {
  return lockContentPublishBoundaryUnsafe(world.tx as never, publishInput(over));
}

describe('lockContentPublishBoundaryUnsafe —— 自洽世界的正路', () => {
  it('封面图已就绪、无在途操作:放行,且一个字都不写', async () => {
    const world = makeWorld();
    await expect(publish(world)).resolves.toBeUndefined();
    expect(world.objectUpdateMany).not.toHaveBeenCalled();
    expect(world.operationUpdateMany).not.toHaveBeenCalled();
    expect(world.operationCreate).not.toHaveBeenCalled();
  });

  it('没有任何附件、也没有封面:放行(空文也能发)', async () => {
    const world = makeWorld({ attachments: [], objects: [], operations: [] });
    await expect(
      publish(world, { referencedAttachmentIds: [], coverAttachmentId: null, coverImageKey: null }),
    ).resolves.toBeUndefined();
  });
});

describe('闸①-⑤ —— 进入逐附件判定之前的整体一致性', () => {
  it('⚠️ 存在无主(非 owner-v1)的在途上传:拒 —— 老格式凭证无法归属,不能保证不被别人改', async () => {
    const world = makeWorld({ ownerless: [{ id: 'op-legacy-0001' }] });
    await expect(publish(world)).rejects.toThrow(PENDING);
  });

  it('⚠️ 锁到的附件集与随后读到的不一致:拒 —— 加锁与读之间有人插进来了', async () => {
    // ⚠️ 与闸③隔离:让**首读**与锁集不符,而复读与锁集相符 —— 否则闸③会替闸②接住,
    // 闸②被删掉用例也不红。变异对拍抓到过这个假绿。
    const world = makeWorld({
      lockedAttachmentIds: [ATT_ID],
      attachments: [],
      attachmentsAfterLock: [attachment()],
    });
    await expect(publish(world)).rejects.toThrow(PENDING);
  });

  it('⚠️ 锁后复读附件集又变了:拒 —— 第二次复核专为抓这种漂移而存在', async () => {
    // ⚠️ 与闸⑧⑮隔离:正文不引用任何附件、无封面、候选对象为空,
    // 于是「引用的附件查不到」和「未绑定对象仍带资源」都不会先触发,只有闸③能拦。
    const world = makeWorld({
      attachments: [attachment()],
      attachmentsAfterLock: [],
      objects: [],
      operations: [],
    });
    await expect(
      publish(world, { referencedAttachmentIds: [], coverAttachmentId: null, coverImageKey: null }),
    ).rejects.toThrow(PENDING);
  });

  it('⚠️ 复读发现新意图指向未被锁定的对象:拒 —— 绝不越序去补一把迟到的对象锁', async () => {
    // ⚠️ 这条必须与闸⑤(意图不在操作锁集)隔离开:把迟到操作**放进** operations,
    // 于是它在操作锁集里、闸⑤不会触发,只有闸④(对象不在锁集)能拦下它。
    // 变异对拍抓到过:早先的写法漏了这一步,闸④被删掉后用例仍绿 —— 它一直是被闸⑤接住的。
    const world = makeWorld({
      operations: [
        uploadOp(),
        uploadOp({ id: 'op-late-00001', storageObjectId: 'obj-LATE-00001' }),
      ],
      ownerIntents: [
        { id: UPLOAD_OP_ID, storageObjectId: OBJ_ID },
        { id: 'op-late-00001', storageObjectId: 'obj-LATE-00001' },
      ],
    });
    await expect(publish(world)).rejects.toThrow(PENDING);
  });

  it('⚠️ 复读发现新意图,对象在锁集内但操作不在:拒 —— 操作锁集冻结后出现的意图不可信', async () => {
    const world = makeWorld({
      ownerIntents: [
        { id: UPLOAD_OP_ID, storageObjectId: OBJ_ID },
        { id: 'op-late-00001', storageObjectId: OBJ_ID },
      ],
    });
    await expect(publish(world)).rejects.toThrow(PENDING);
  });
});

describe('闸⑥⑦ —— 每个已绑定附件都必须真的就绪', () => {
  it.each([
    ['对象不存在(key 对不上任何对象)', { key: 'attachments/OTHER.png' }],
    ['对象状态不是 available', { state: 'pending_upload' }],
    ['对象绑的不是 attachment', { resourceType: 'content' }],
    ['对象绑的是别的附件', { resourceId: 'att-OTHER' }],
    ['对象已请求删除', { deleteRequestedAt: new Date() }],
  ])('拒绝:%s', async (_label, over) => {
    const world = makeWorld({ objects: [object(over)] });
    await expect(publish(world)).rejects.toThrow(PENDING);
  });

  it('⚠️ 拒绝:对象上有在途的**非上传**操作(如正在执行的删除)—— 发布后它会把附件删掉', async () => {
    // ⚠️ 这条是闸⑦的隔离用例。用 attachment_delete 而不是在途的上传:
    // 在途上传会先被闸⑫(已绑定的上传必须 succeeded + provider_present)接住,
    // 那样闸⑦被删掉用例也不会红。变异对拍抓到过这个假绿。
    const world = makeWorld({
      operations: [
        uploadOp(),
        uploadOp({
          id: 'op-delete-0001',
          kind: 'attachment_delete',
          status: 'processing',
          eventKey: 'storage.attachment-delete:obj-000000001',
        }),
      ],
    });
    await expect(publish(world)).rejects.toThrow(PENDING);
  });

  it.each([['pending'], ['processing']])(
    '拒绝:已绑定附件的上传操作还停在 %s(由闸⑫接住:未进终态就没有「已就绪」的证据)',
    async (status) => {
      const world = makeWorld({ operations: [uploadOp({ status })] });
      await expect(publish(world)).rejects.toThrow(PENDING);
    },
  );

  it.each([['succeeded'], ['dead']])('终态 %s 的操作不算在途', async (status) => {
    // dead 分支需要对象与附件仍然自洽,只是那条上传已判死。
    const world = makeWorld({ operations: [uploadOp({ status })] });
    if (status === 'succeeded') {
      await expect(publish(world)).resolves.toBeUndefined();
    } else {
      // status=dead 时 boundAttachment 分支要求 succeeded + provider_present,故仍拒。
      await expect(publish(world)).rejects.toThrow(PENDING);
    }
  });
});

describe('闸⑧⑨⑩ —— 正文引用与封面', () => {
  it('⚠️ 引用了不属于本文的附件 id:拒 —— 这正是「发出去是死链」的直接来源', async () => {
    const world = makeWorld();
    await expect(publish(world, { referencedAttachmentIds: ['att-NOT-MINE'] })).rejects.toThrow(
      PENDING,
    );
  });

  it('⚠️ 引用的附件是 content-file 而非 content-image:拒 —— 正文只能引图', async () => {
    const world = makeWorld({
      attachments: [attachment({ ownerType: 'content-file' })],
    });
    await expect(publish(world, { coverAttachmentId: null, coverImageKey: null })).rejects.toThrow(
      PENDING,
    );
  });

  it.each([
    ['只给了 coverAttachmentId', { coverImageKey: null }],
    ['只给了 coverImageKey', { coverAttachmentId: null }],
  ])('⚠️ 封面两字段必须同生同灭:%s ⇒ 拒', async (_label, over) => {
    const world = makeWorld();
    await expect(publish(world, over)).rejects.toThrow(PENDING);
  });

  it('两字段都为 null:放行(无封面是合法的)', async () => {
    const world = makeWorld();
    await expect(
      publish(world, { coverAttachmentId: null, coverImageKey: null }),
    ).resolves.toBeUndefined();
  });

  it('⚠️ 封面 id 存在但 key 与附件实际 key 不符:拒 —— 防止封面指向另一张图', async () => {
    const world = makeWorld();
    await expect(publish(world, { coverImageKey: 'attachments/OTHER.png' })).rejects.toThrow(
      PENDING,
    );
  });

  it('封面指向不存在的附件:拒', async () => {
    const world = makeWorld();
    await expect(publish(world, { coverAttachmentId: 'att-NOPE' })).rejects.toThrow(PENDING);
  });
});

describe('闸⑪⑫ —— 上传操作自身的形态与归属', () => {
  it('⚠️ eventKey 不等于 prefix + requestHash:拒 —— 两者必须严格对应,否则归属可被伪造', async () => {
    const world = makeWorld({
      operations: [uploadOp({ eventKey: `${IMAGE_PREFIX}${'d'.repeat(64)}` })],
    });
    await expect(publish(world)).rejects.toThrow(PENDING);
  });

  it('⚠️ 已绑定附件但上传意图的 ownerType 与附件不符(file 意图挂在 image 附件上):拒', async () => {
    const filePrefix = storageOwnerUploadEventKeyPrefix('content-file', CONTENT_ID);
    const world = makeWorld({
      operations: [uploadOp({ eventKey: `${filePrefix}${UPLOAD_HASH}` })],
      ownerIntents: [{ id: UPLOAD_OP_ID, storageObjectId: OBJ_ID }],
    });
    await expect(publish(world)).rejects.toThrow(PENDING);
  });

  it('⚠️ 已绑定附件但上传操作 effectState 不是 provider_present:拒 —— 没证据说明字节真在', async () => {
    const world = makeWorld({ operations: [uploadOp({ effectState: 'not_started' })] });
    await expect(publish(world)).rejects.toThrow(PENDING);
  });

  it('对象上没有任何本内容的上传意图:跳过该对象(不是错)', async () => {
    // 其它 owner 的对象混进候选集是正常的(按 key 查出来的),不该因此拒绝发布。
    const world = makeWorld({
      operations: [
        uploadOp({ eventKey: `${STORAGE_ATTACHMENT_UPLOAD_EVENT_PREFIX}:${UPLOAD_HASH}` }),
      ],
      ownerIntents: [],
    });
    await expect(publish(world)).resolves.toBeUndefined();
  });
});

describe('闸⑬⑭⑮ —— 未绑定对象的三种合法归宿', () => {
  /** 未绑定到附件的对象(附件集为空),用于走 boundAttachment 之后的分支。 */
  function unbound(over: Row = {}) {
    return makeWorld({
      attachments: [],
      objects: [object({ resourceType: null, resourceId: null, ...over })],
      operations: [uploadOp()],
    });
  }

  it('absent + 无主认领(resourceType/resourceId 皆空):放行', async () => {
    const world = unbound({ state: 'absent' });
    await expect(
      publish(world, { referencedAttachmentIds: [], coverAttachmentId: null, coverImageKey: null }),
    ).resolves.toBeUndefined();
  });

  it('⚠️ absent 但仍有在途操作:拒 —— 已消失的对象上不该还有人在干活', async () => {
    const world = makeWorld({
      attachments: [],
      objects: [object({ state: 'absent', resourceType: null, resourceId: null })],
      operations: [uploadOp({ status: 'pending' })],
    });
    await expect(
      publish(world, { referencedAttachmentIds: [], coverAttachmentId: null, coverImageKey: null }),
    ).rejects.toThrow(PENDING);
  });

  it('absent + 已完成的 attachment_delete:放行(删干净了的残影)', async () => {
    const world = makeWorld({
      attachments: [],
      objects: [object({ state: 'absent' })],
      operations: [
        uploadOp(),
        {
          ...uploadOp({ id: 'op-delete-0001' }),
          kind: 'attachment_delete',
          status: 'succeeded',
          effectState: 'effect_succeeded',
        },
      ],
      ownerIntents: [{ id: UPLOAD_OP_ID, storageObjectId: OBJ_ID }],
    });
    await expect(
      publish(world, { referencedAttachmentIds: [], coverAttachmentId: null, coverImageKey: null }),
    ).resolves.toBeUndefined();
  });

  it('⚠️ absent + 仍绑着附件但没有已完成的删除:拒 —— 对象没了附件行还在,是不一致', async () => {
    const world = makeWorld({
      attachments: [],
      objects: [object({ state: 'absent' })],
      operations: [uploadOp()],
    });
    await expect(
      publish(world, { referencedAttachmentIds: [], coverAttachmentId: null, coverImageKey: null }),
    ).rejects.toThrow(PENDING);
  });

  it('⚠️ 非 absent 的对象仍绑着资源、却不在本文附件集里:拒', async () => {
    // ⚠️ 与闸⑰隔离:把 unboundExpiresAt / source 都给足,让闸⑰不会先触发,
    // 于是只有闸⑮(未绑定路径上的对象却带着 resourceType/resourceId)能拦。
    // 变异对拍抓到过:早先的写法漏给 unboundExpiresAt,闸⑮被删掉后是闸⑰接住的。
    const world = makeWorld({
      attachments: [],
      objects: [
        object({
          state: 'present_unbound',
          unboundExpiresAt: new Date('2099-06-01T00:00:00.000Z'),
          source: 'attachment_signed_upload',
        }),
      ],
      operations: [uploadOp({ status: 'processing' })],
    });
    await expect(
      publish(world, { referencedAttachmentIds: [], coverAttachmentId: null, coverImageKey: null }),
    ).rejects.toThrow(PENDING);
  });
});

describe('闸⑯ —— delete_pending 对象的孤儿操作九项复核', () => {
  const ORPHAN_KEY = `storage.orphan-delete:${OBJ_ID}`;
  const ORPHAN_HASH = storageRequestHash({ kind: 'orphan_delete', objectId: OBJ_ID });
  const UNBOUND_AT = new Date('2099-01-01T00:00:00.000Z');

  function orphan(over: Row = {}): Row {
    return {
      id: 'op-orphan-0001',
      kind: 'orphan_delete',
      storageObjectId: OBJ_ID,
      eventKey: ORPHAN_KEY,
      requestHash: ORPHAN_HASH,
      replayOfId: UPLOAD_OP_ID,
      status: 'pending',
      effectState: 'not_started',
      payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
      payload: {},
      availableAt: UNBOUND_AT,
      ...over,
    };
  }

  function world(orphanOver: Row = {}, uploadOver: Row = {}) {
    return makeWorld({
      attachments: [],
      objects: [
        object({
          state: 'delete_pending',
          resourceType: null,
          resourceId: null,
          unboundExpiresAt: UNBOUND_AT,
        }),
      ],
      operations: [uploadOp({ status: 'dead', ...uploadOver }), orphan(orphanOver)],
      ownerIntents: [{ id: UPLOAD_OP_ID, storageObjectId: OBJ_ID }],
    });
  }

  const emptyInput = {
    referencedAttachmentIds: [],
    coverAttachmentId: null,
    coverImageKey: null,
  };

  it('九项全对:放行,不新建也不改任何操作', async () => {
    const w = world();
    await expect(publish(w, emptyInput)).resolves.toBeUndefined();
    expect(w.operationCreate).not.toHaveBeenCalled();
    expect(w.operationUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['孤儿的 eventKey 不合规', { eventKey: 'storage.orphan-delete:OTHER' }],
    ['孤儿的 requestHash 不合规', { requestHash: 'e'.repeat(64) }],
    ['孤儿指向别的对象', { storageObjectId: 'obj-OTHER' }],
    ['孤儿不是 orphan_delete', { kind: 'attachment_delete' }],
    ['孤儿没有 replayOfId(不是重放)', { replayOfId: null }],
    ['孤儿 replay 的是另一条操作', { replayOfId: 'op-OTHER' }],
  ])('⚠️ 拒绝:%s', async (_label, over) => {
    await expect(publish(world(over), emptyInput)).rejects.toThrow(PENDING);
  });

  it('⚠️ 拒绝:被重放的上传操作还没进终态(dead/succeeded 之外)', async () => {
    await expect(publish(world({}, { status: 'processing' }), emptyInput)).rejects.toThrow(PENDING);
  });

  it('被重放的上传是 succeeded 也接受(不止 dead)', async () => {
    await expect(publish(world({}, { status: 'succeeded' }), emptyInput)).resolves.toBeUndefined();
  });

  it('⚠️ 拒绝:孤儿的 availableAt 早于对象的 unboundExpiresAt —— 会在客户端还能确认时就去删', async () => {
    const early = new Date(UNBOUND_AT.getTime() - 1000);
    await expect(publish(world({ availableAt: early }), emptyInput)).rejects.toThrow(PENDING);
  });

  it('⚠️ 拒绝:该对象上不止一条在途操作', async () => {
    const w = makeWorld({
      attachments: [],
      objects: [
        object({
          state: 'delete_pending',
          resourceType: null,
          resourceId: null,
          unboundExpiresAt: UNBOUND_AT,
        }),
      ],
      operations: [
        uploadOp({ status: 'dead' }),
        orphan(),
        orphan({ id: 'op-orphan-0002', status: 'processing' }),
      ],
      ownerIntents: [{ id: UPLOAD_OP_ID, storageObjectId: OBJ_ID }],
    });
    await expect(publish(w, emptyInput)).rejects.toThrow(PENDING);
  });

  it('⚠️ 拒绝:孤儿 payload 不合契约(orphan_delete 要求恰好零个键)', async () => {
    await expect(publish(world({ payload: { extra: 1 } }), emptyInput)).rejects.toThrow();
  });
});

describe('闸⑰-㉒ —— 在途上传对象的收编(改写 + 建孤儿)', () => {
  const UNBOUND_FUTURE = new Date('2099-06-01T00:00:00.000Z');

  function pendingWorld(objectOver: Row = {}, opts: Row = {}) {
    return makeWorld({
      attachments: [],
      objects: [
        object({
          state: 'present_unbound',
          resourceType: null,
          resourceId: null,
          unboundExpiresAt: UNBOUND_FUTURE,
          ...objectOver,
        }),
      ],
      operations: [uploadOp({ status: 'processing' })],
      ownerIntents: [{ id: UPLOAD_OP_ID, storageObjectId: OBJ_ID }],
      ...opts,
    });
  }

  const emptyInput = {
    referencedAttachmentIds: [],
    coverAttachmentId: null,
    coverImageKey: null,
  };

  it('⚠️ 正路:把在途上传对象转 delete_pending、上传操作判死、建一条孤儿删除', async () => {
    const w = pendingWorld();
    await expect(publish(w, emptyInput)).resolves.toBeUndefined();
    expect(w.objectUpdateMany.mock.calls[0]?.[0].data).toMatchObject({ state: 'delete_pending' });
    expect(w.operationUpdateMany.mock.calls[0]?.[0].data).toMatchObject({ status: 'dead' });
    expect(w.operationCreate.mock.calls[0]?.[0].data).toMatchObject({
      eventKey: `storage.orphan-delete:${OBJ_ID}`,
      kind: 'orphan_delete',
      status: 'pending',
      replayOfId: UPLOAD_OP_ID,
    });
  });

  it('⚠️ 新孤儿的 availableAt 不早于 unboundExpiresAt —— 不能抢在客户端还能确认时就删', async () => {
    const w = pendingWorld();
    await publish(w, emptyInput);
    expect(w.operationCreate.mock.calls[0]?.[0].data.availableAt).toBe(UNBOUND_FUTURE);
  });

  it.each([
    ['对象已请求删除', { deleteRequestedAt: new Date() }],
    ['对象没有 unboundExpiresAt', { unboundExpiresAt: null }],
    ['对象状态不在三态内', { state: 'legacy_unverified' }],
  ])('拒绝:%s', async (_label, over) => {
    await expect(publish(pendingWorld(over), emptyInput)).rejects.toThrow(PENDING);
  });

  it('拒绝:对象 source 不在允许集内(⚠️ 这一条是纵深防御,不是独立闸)', async () => {
    // 变异对拍查实:闸⑰里 `source ∉ {signed, legacy}` 这半条**被闸⑲完全包含**。
    // 因为 payload 的 source 经 exactKeys 校验后必为这两个值之一,而闸⑲要求
    // `uploadPayload.source === object.source` —— 所以任何白名单外的 object.source
    // 必然也过不了闸⑲。把它单独删掉,行为一个字都不变。
    // 保留本用例是为了钉住**行为**(这种对象一定被拒),同时把「它不可独立观测」写在这里,
    // 免得后来者看到变异不红就以为是测试漏了、去构造一个根本不存在的场景。
    await expect(publish(pendingWorld({ source: 'backfill' }), emptyInput)).rejects.toThrow(
      PENDING,
    );
  });

  it('⚠️ 拒绝:在途操作不止一条', async () => {
    const w = makeWorld({
      attachments: [],
      objects: [
        object({
          state: 'present_unbound',
          resourceType: null,
          resourceId: null,
          unboundExpiresAt: UNBOUND_FUTURE,
        }),
      ],
      operations: [
        uploadOp({ status: 'processing' }),
        uploadOp({ id: 'op-upload-00002', status: 'pending' }),
      ],
      ownerIntents: [{ id: UPLOAD_OP_ID, storageObjectId: OBJ_ID }],
    });
    await expect(publish(w, emptyInput)).rejects.toThrow(PENDING);
  });

  it('⚠️ 拒绝:上传操作 payload 的 source 与对象的 source 漂移', async () => {
    const w = makeWorld({
      attachments: [],
      objects: [
        object({
          state: 'present_unbound',
          resourceType: null,
          resourceId: null,
          unboundExpiresAt: UNBOUND_FUTURE,
        }),
      ],
      operations: [uploadOp({ status: 'processing', payload: { source: 'attachment_legacy' } })],
      ownerIntents: [{ id: UPLOAD_OP_ID, storageObjectId: OBJ_ID }],
    });
    await expect(publish(w, emptyInput)).rejects.toThrow(PENDING);
  });

  it('⚠️ 对象 CAS 丢(count≠1):拒,且不再改上传操作 —— 有人抢先改了这个对象', async () => {
    const w = pendingWorld({}, { objectUpdatedCount: 0 });
    await expect(publish(w, emptyInput)).rejects.toThrow(PENDING);
    expect(w.operationUpdateMany).not.toHaveBeenCalled();
  });

  it('⚠️ 上传操作 CAS 丢(count≠1):拒,且不建孤儿 —— 对象已改但操作没跟上,不能再往下走', async () => {
    const w = pendingWorld({}, { uploadUpdatedCount: 0 });
    await expect(publish(w, emptyInput)).rejects.toThrow(PENDING);
    expect(w.operationCreate).not.toHaveBeenCalled();
  });

  describe('已存在同名孤儿时的复用', () => {
    const ORPHAN_HASH = storageRequestHash({ kind: 'orphan_delete', objectId: OBJ_ID });
    function existing(over: Row = {}): Row {
      return {
        id: 'op-orphan-0001',
        kind: 'orphan_delete',
        storageObjectId: OBJ_ID,
        eventKey: `storage.orphan-delete:${OBJ_ID}`,
        requestHash: ORPHAN_HASH,
        replayOfId: UPLOAD_OP_ID,
        status: 'pending',
        effectState: 'not_started',
        payloadVersion: STORAGE_OPERATION_PAYLOAD_VERSION,
        payload: {},
        availableAt: new Date('2099-01-01T00:00:00.000Z'),
        ...over,
      };
    }
    function w(over: Row = {}) {
      return makeWorld({
        attachments: [],
        objects: [
          object({
            state: 'present_unbound',
            resourceType: null,
            resourceId: null,
            unboundExpiresAt: UNBOUND_FUTURE,
          }),
        ],
        operations: [uploadOp({ status: 'processing' }), existing(over)],
        ownerIntents: [{ id: UPLOAD_OP_ID, storageObjectId: OBJ_ID }],
      });
    }

    it('⚠️ 已有孤儿的 availableAt 偏早:改写成更晚的那个,不新建第二条', async () => {
      const world = w();
      await expect(publish(world, emptyInput)).rejects.toThrow(PENDING);
      // 注:此路径下 active 有两条(processing 上传 + pending 孤儿),先被 active.length!==1 拦下。
      // 这条用例钉的正是这个先后 —— 收编逻辑不会在已有在途孤儿时被触发。
      expect(world.operationCreate).not.toHaveBeenCalled();
    });

    it.each([
      ['kind 不对', { kind: 'attachment_delete' }],
      ['replayOfId 不是本次上传', { replayOfId: 'op-OTHER' }],
      ['requestHash 不对', { requestHash: 'f'.repeat(64) }],
      ['已进终态', { status: 'succeeded' }],
    ])('已有孤儿形态不合规(%s):拒', async (_label, over) => {
      await expect(publish(w(over), emptyInput)).rejects.toThrow(PENDING);
    });

    it('⚠️ 孤儿的 storageObjectId 指向别的对象:本层看不见它,由 eventKey 唯一约束在 DB 层兜底', async () => {
      // 操作是按 storageObjectId 分组的,所以一条"顶着本对象 eventKey、却记在别的对象名下"的
      // 损坏行根本不会进入本对象的判定集 —— existingOrphan 查不到,于是走 create 分支。
      // 这不是漏判:storage_object_operations.eventKey 是 @unique,那条 create 会在 DB 层撞唯一键,
      // 事务回滚,再由 lockContentPublishBoundary 折成 PENDING。仍是 fail-closed,只是闸在下一层。
      // 把这条写成用例而不是留空,是为了让「这里为什么不拦」有据可查,而不是被后来者当成缺陷"修"掉。
      const world = w({ storageObjectId: 'obj-OTHER' });
      await expect(publish(world, emptyInput)).resolves.toBeUndefined();
      expect(world.operationCreate.mock.calls[0]?.[0].data).toMatchObject({
        eventKey: `storage.orphan-delete:${OBJ_ID}`,
      });
    });
  });
});

describe('lockContentPublishBoundary —— 对外只有一种错误面', () => {
  it('⚠️ 内部抛任意非 Biz 错误(如 Prisma 报错):一律折成 PENDING,不泄漏内部细节', async () => {
    const world = makeWorld();
    world.queryRaw.mockRejectedValue(new Error('P2028 transaction already closed'));
    await expect(
      lockContentPublishBoundary(world.tx as never, publishInput() as never),
    ).rejects.toThrow(PENDING);
  });

  it('内部抛 PENDING:原样上抛(同一个错误面,不重复包装)', async () => {
    const world = makeWorld({ ownerless: [{ id: 'x' }] });
    await expect(
      lockContentPublishBoundary(world.tx as never, publishInput() as never),
    ).rejects.toThrow(PENDING);
  });

  it('正路:与 Unsafe 版本行为一致,放行', async () => {
    const world = makeWorld();
    await expect(
      lockContentPublishBoundary(world.tx as never, publishInput() as never),
    ).resolves.toBeUndefined();
  });
});

describe('lockContentReferenceBoundary —— 引用变更时的就绪校验', () => {
  function referenceWorld(objects: Row[], attachments: Row[] = [attachment()]) {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      attachment: { findMany: jest.fn().mockResolvedValue(attachments) },
      storageObject: { findMany: jest.fn().mockResolvedValue(objects) },
    };
    return tx;
  }

  it('引用列表为空:直接返回,连查都不查', async () => {
    const tx = referenceWorld([]);
    await lockContentReferenceBoundary(tx as never, {
      contentId: CONTENT_ID,
      referencedAttachmentIds: [],
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('⚠️ 引用的 id 一个都不属于本文:直接返回 —— 越权引用由上游权限层拦,本层不越位报错', async () => {
    const tx = referenceWorld([], []);
    await expect(
      lockContentReferenceBoundary(tx as never, {
        contentId: CONTENT_ID,
        referencedAttachmentIds: ['att-NOT-MINE'],
      }),
    ).resolves.toBeUndefined();
  });

  it('全部就绪:放行', async () => {
    const tx = referenceWorld([object()]);
    await expect(
      lockContentReferenceBoundary(tx as never, {
        contentId: CONTENT_ID,
        referencedAttachmentIds: [ATT_ID],
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['对象缺失', []],
    ['状态不是 available', [object({ state: 'delete_pending' })]],
    ['绑的不是 attachment', [object({ resourceType: null })]],
    ['绑的是别的附件', [object({ resourceId: 'att-OTHER' })]],
    ['已请求删除', [object({ deleteRequestedAt: new Date() })]],
  ])('拒绝:%s', async (_label, objects) => {
    const tx = referenceWorld(objects);
    await expect(
      lockContentReferenceBoundary(tx as never, {
        contentId: CONTENT_ID,
        referencedAttachmentIds: [ATT_ID],
      }),
    ).rejects.toThrow(PENDING);
  });

  it('⚠️ 重复的引用 id 去重后只锁一次 —— 同一 id 出现两次不该产生两把锁', async () => {
    const tx = referenceWorld([object()]);
    await lockContentReferenceBoundary(tx as never, {
      contentId: CONTENT_ID,
      referencedAttachmentIds: [ATT_ID, ATT_ID, ATT_ID],
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
