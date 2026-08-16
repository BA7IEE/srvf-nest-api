import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import { AttachmentManualIntakeService } from './attachment-manual-intake.service';
import type { PrepareManualStorageRelocateInput } from './attachment-storage.types';

/*
 * 人工运维受理侧的单测(#1036 抽出,此前零覆盖)。
 *
 * 受理侧把一次人工重定位 / 人工缺失认定登记成待执行操作。它是**幂等入口**:
 * 同一份请求重复提交必须复用既有 eventKey 而不是再建一条 —— 否则同一个存储对象上
 * 会并存两条 manual 操作,执行侧的「活跃操作唯一」前提立刻失效。
 *
 * 本层七个抛出点的**错误消息各不相同**,故用例直接断言消息(与 policy 层不同,
 * 那里 10 个抛出点共用一个码、只能靠输入构造定位)。
 *
 * ⚠️ 本 spec 覆盖不到的:两条 FOR UPDATE 的**先后次序**与 ORDER BY 的死锁防线作用 ——
 * 那是并发行为,mock 的 $queryRaw 不会真的加锁。锁序仍靠编排器台账与 e2e 并发用例。
 */

const REPLAY_ID = 'op-original';
const OBJECT_ID = 'obj-1';

type OperationRow = {
  id: string;
  kind: string;
  status: string;
  storageObjectId: string;
  eventKey?: string;
  requestHash?: string;
};

type ObjectRow = { id: string; state: string; deleteRequestedAt: Date | null };

function makeService(options: {
  original?: (OperationRow & { storageObject: ObjectRow }) | null;
  existing?: OperationRow | null;
  currentOriginal?: OperationRow | null;
  object?: ObjectRow | null;
  activeOperations?: OperationRow[];
}) {
  const object: ObjectRow = options.object ?? {
    id: OBJECT_ID,
    state: 'missing',
    deleteRequestedAt: null,
  };
  const original =
    options.original === undefined
      ? {
          id: REPLAY_ID,
          kind: 'backfill_verify',
          status: 'succeeded',
          storageObjectId: OBJECT_ID,
          storageObject: object,
        }
      : options.original;
  const currentOriginal =
    options.currentOriginal === undefined
      ? original === null
        ? null
        : {
            id: original.id,
            kind: original.kind,
            status: original.status,
            storageObjectId: OBJECT_ID,
          }
      : options.currentOriginal;

  const create = jest
    .fn<Promise<unknown>, [{ data: Record<string, unknown> }]>()
    .mockResolvedValue({});
  // tx 上的 findUnique 按 where 区分:带 eventKey 的问「这份请求是否已受理」,
  // 带 id 的问「原始操作是否还在」。用同一个 mock 会让两类查询互相污染。
  const txOperationFindUnique = jest
    .fn()
    .mockImplementation((args: { where: Record<string, unknown> }) => {
      if ('eventKey' in args.where) return Promise.resolve(options.existing ?? null);
      return Promise.resolve(currentOriginal);
    });
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    storageObjectOperation: {
      findUnique: txOperationFindUnique,
      findMany: jest.fn().mockResolvedValue(options.activeOperations ?? []),
      create,
    },
    storageObject: { findUnique: jest.fn().mockResolvedValue(options.object ?? object) },
  };
  const prisma = {
    storageObjectOperation: { findUnique: jest.fn().mockResolvedValue(original) },
    $transaction: jest.fn().mockImplementation((fn: (t: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;

  return { service: new AttachmentManualIntakeService(prisma), tx, create };
}

// ⚠️ 夹具必须满足 payload 校验的真实格式约束(见 storage-operation-payload.ts):
//   internalId   /^[A-Za-z0-9_-]{8,80}$/   —— **至少 8 字符**('user-op' 只有 7,会被拒)
//   reasonCode   /^[a-z][a-z0-9_-]{2,63}$/
//   evidenceRef  /^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,11}$/ —— 大写开头的工单号
// 用不满足约束的假值会让所有用例卡在 payload 解析,而不是走到被测的判定分支。

function relocateInput(): PrepareManualStorageRelocateInput {
  return {
    replayOperationId: REPLAY_ID,
    operatorUserId: 'operator0001',
    reviewerUserId: 'reviewer0001',
    reasonCode: 'provider_migration',
    evidenceRef: 'OPS-1001',
    verifiedAt: new Date('2026-08-17T00:00:00.000Z'),
    targetLocator: { providerType: 'COS', bucket: 'b', region: 'r', localNamespace: null },
  };
}

function attestInput() {
  return {
    replayOperationId: REPLAY_ID,
    operatorUserId: 'operator0001',
    reviewerUserId: 'reviewer0001',
    reasonCode: 'provider_confirmed_absent',
    evidenceRef: 'OPS-1002',
    verifiedAt: new Date('2026-08-17T00:00:00.000Z'),
  };
}

describe('prepareRelocate —— 受理人工重定位', () => {
  it('来源态合法时建一条 pending 操作并返回 eventKey', async () => {
    const { service, create } = makeService({});
    const eventKey = await service.prepareRelocate(relocateInput());
    expect(eventKey).toMatch(/^storage\.manual-relocate:[0-9a-f]{64}$/);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data).toMatchObject({
      kind: 'manual_relocate',
      status: 'pending',
      effectState: 'not_started',
      replayOfId: REPLAY_ID,
    });
  });

  it('拒绝:重放目标不存在', async () => {
    const { service } = makeService({ original: null });
    await expect(service.prepareRelocate(relocateInput())).rejects.toThrow(
      'manual replay target not found',
    );
  });

  // 幂等:同一份请求重复提交必须复用既有 eventKey,而不是再建一条。
  it('幂等:已受理过同一请求 ⇒ 复用既有 eventKey 且不再建操作', async () => {
    const first = await makeService({}).service.prepareRelocate(relocateInput());
    const { service, create } = makeService({
      existing: {
        id: 'op-existing',
        kind: 'manual_relocate',
        status: 'pending',
        storageObjectId: OBJECT_ID,
        eventKey: first,
        requestHash: first.split(':')[1],
      },
    });
    await expect(service.prepareRelocate(relocateInput())).resolves.toBe(first);
    expect(create).not.toHaveBeenCalled();
  });

  it('拒绝:eventKey 撞上了但身份对不上(同 key 不同 kind ⇒ 哈希空间被污染)', async () => {
    const first = await makeService({}).service.prepareRelocate(relocateInput());
    const { service } = makeService({
      existing: {
        id: 'op-existing',
        kind: 'manual_attest_absent',
        status: 'pending',
        storageObjectId: OBJECT_ID,
        eventKey: first,
        requestHash: first.split(':')[1],
      },
    });
    await expect(service.prepareRelocate(relocateInput())).rejects.toThrow(
      'manual eventKey identity mismatch',
    );
  });

  it('拒绝:锁后重读发现原始操作已消失', async () => {
    const { service } = makeService({ currentOriginal: null });
    await expect(service.prepareRelocate(relocateInput())).rejects.toThrow(
      'manual replay target disappeared',
    );
  });

  it('拒绝:该对象上已有活跃操作(业务码 20xxx,不是不变量错误)', async () => {
    const { service } = makeService({
      activeOperations: [
        {
          id: 'op-active',
          kind: 'attachment_delete',
          status: 'pending',
          storageObjectId: OBJECT_ID,
        },
      ],
    });
    await expect(service.prepareRelocate(relocateInput())).rejects.toThrow(BizException);
    await expect(service.prepareRelocate(relocateInput())).rejects.toMatchObject({
      biz: BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING,
    });
  });

  it('拒绝:同一对象上并存多条活跃操作(此前的互斥已被破坏)', async () => {
    const { service } = makeService({
      activeOperations: [
        { id: 'a', kind: 'attachment_delete', status: 'pending', storageObjectId: OBJECT_ID },
        { id: 'b', kind: 'backfill_verify', status: 'processing', storageObjectId: OBJECT_ID },
      ],
    });
    await expect(service.prepareRelocate(relocateInput())).rejects.toThrow(
      'multiple active manual operations',
    );
  });

  const rejectedRelocateSources: ReadonlyArray<
    [string, Partial<ObjectRow> & Partial<OperationRow>]
  > = [
    ['对象状态不在可重定位集合内', { state: 'available' }],
    ['对象已被请求删除(不可跨越活跃删除)', { deleteRequestedAt: new Date() }],
  ];

  it.each(rejectedRelocateSources)('拒绝:%s', async (_label, breakage) => {
    const { service } = makeService({
      object: { id: OBJECT_ID, state: 'missing', deleteRequestedAt: null, ...breakage },
    });
    await expect(service.prepareRelocate(relocateInput())).rejects.toThrow(
      'manual relocate target rejected',
    );
  });

  it('拒绝:原始操作的 kind 不在允许重放的集合内', async () => {
    const { service } = makeService({
      currentOriginal: {
        id: REPLAY_ID,
        kind: 'attachment_delete',
        status: 'succeeded',
        storageObjectId: OBJECT_ID,
      },
    });
    await expect(service.prepareRelocate(relocateInput())).rejects.toThrow(
      'manual relocate target rejected',
    );
  });

  it('拒绝:原始操作尚未进入终态(succeeded/dead 之外)', async () => {
    const { service } = makeService({
      currentOriginal: {
        id: REPLAY_ID,
        kind: 'backfill_verify',
        status: 'processing',
        storageObjectId: OBJECT_ID,
      },
    });
    await expect(service.prepareRelocate(relocateInput())).rejects.toThrow(
      'manual relocate target rejected',
    );
  });
});

describe('prepareAttestAbsent —— 受理人工缺失认定(判据与重定位完全不同)', () => {
  function attestService(over: Parameters<typeof makeService>[0] = {}) {
    return makeService({
      original: {
        id: REPLAY_ID,
        kind: 'attachment_delete',
        status: 'dead',
        storageObjectId: OBJECT_ID,
        storageObject: { id: OBJECT_ID, state: 'delete_failed', deleteRequestedAt: new Date() },
      },
      currentOriginal: {
        id: REPLAY_ID,
        kind: 'attachment_delete',
        status: 'dead',
        storageObjectId: OBJECT_ID,
      },
      object: { id: OBJECT_ID, state: 'delete_failed', deleteRequestedAt: new Date() },
      ...over,
    });
  }

  it('原始删除已 dead 且对象处于删除失败态 ⇒ 受理', async () => {
    const { service, create } = attestService();
    const eventKey = await service.prepareAttestAbsent(attestInput());
    expect(eventKey).toMatch(/^storage\.manual-attest-absent:[0-9a-f]{64}$/);
    expect(create.mock.calls[0][0].data).toMatchObject({ kind: 'manual_attest_absent' });
  });

  it('拒绝:原始操作不是 attachment_delete', async () => {
    const { service } = attestService({
      currentOriginal: {
        id: REPLAY_ID,
        kind: 'backfill_verify',
        status: 'dead',
        storageObjectId: OBJECT_ID,
      },
    });
    await expect(service.prepareAttestAbsent(attestInput())).rejects.toThrow(
      'manual attest target rejected',
    );
  });

  it('拒绝:原始删除尚未 dead(还有自动重试机会,不该人工介入)', async () => {
    const { service } = attestService({
      currentOriginal: {
        id: REPLAY_ID,
        kind: 'attachment_delete',
        status: 'processing',
        storageObjectId: OBJECT_ID,
      },
    });
    await expect(service.prepareAttestAbsent(attestInput())).rejects.toThrow(
      'manual attest target rejected',
    );
  });

  it('拒绝:对象不处于删除中/删除失败态', async () => {
    const { service } = attestService({
      object: { id: OBJECT_ID, state: 'available', deleteRequestedAt: null },
    });
    await expect(service.prepareAttestAbsent(attestInput())).rejects.toThrow(
      'manual attest target rejected',
    );
  });

  // 两种 kind 的受理判据互不相同 —— 若将来把两条分支合并成一条,这条会红。
  it('重定位允许的来源态,对缺失认定是非法的(判据不可互换)', async () => {
    const { service } = attestService({
      currentOriginal: {
        id: REPLAY_ID,
        kind: 'backfill_verify',
        status: 'succeeded',
        storageObjectId: OBJECT_ID,
      },
      object: { id: OBJECT_ID, state: 'missing', deleteRequestedAt: null },
    });
    await expect(service.prepareAttestAbsent(attestInput())).rejects.toThrow(
      'manual attest target rejected',
    );
  });
});
