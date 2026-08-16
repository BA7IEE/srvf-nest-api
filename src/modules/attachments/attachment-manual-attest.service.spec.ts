import type { PrismaService } from '../../database/prisma.service';
import type { StorageObjectLedgerService } from '../storage/storage-object-ledger.service';
import { AttachmentManualAttestService } from './attachment-manual-attest.service';
import type { AttachmentAuditRecorder } from './attachment-audit-recorder';

/*
 * 人工缺失认定执行侧的单测(#1039 抽出,此前零覆盖)。
 *
 * ⚠️ 这是**不可逆补偿路径**:确认对象在供应商侧确实不存在后,物理删除 Attachment 行、
 * 对象置 absent、原始 delete 与本 manual 操作双双置终态。删错了没有软删墓碑可回滚。
 * 因此它的围栏极密(10 个判定点),本 spec 逐条钉住 —— 任何一条被放松,
 * 都意味着「在不该删的时候删了一条附件记录」。
 *
 * 本层错误消息各不相同,故用例直接断言消息。
 *
 * ⚠️ 覆盖不到的:四段锁序(内容根 → Attachment → 对象+操作 → 落库)的**先后**。
 * 那是跨调用的次序,mock 不会真的加锁。锁序仍靠编排器台账与人工评审。
 */

const MANUAL_ID = 'op-manual-0001';
const ORIGINAL_ID = 'op-original-001';
const OBJECT_ID = 'obj-00000001';
const ATTACHMENT_ID = 'att-00000001';
const KEY = 'attachments/x.bin';

type Row = Record<string, unknown>;

function claimed(over: Row = {}): Row {
  return {
    id: MANUAL_ID,
    kind: 'manual_attest_absent',
    replayOfId: ORIGINAL_ID,
    storageObjectId: OBJECT_ID,
    leaseGeneration: 1,
    storageObject: {
      id: OBJECT_ID,
      state: 'delete_failed',
      resourceType: 'attachment',
      resourceId: ATTACHMENT_ID,
      key: KEY,
    },
    ...over,
  };
}

/** 原始 attachment_delete 操作的 payload:审计上下文 + 可选的 replay response。 */
// ⚠️ payload 结构由 storage-operation-payload.ts 的 exactKeys 严格校验,少一个键或多一个键都会
// 在解析阶段就抛 —— 用例根本走不到被测的判定分支。实测约束:
//   顶层 exactKeys ['response','audit'](response 可为 null,但**键必须在**)
//   audit exactKeys ['actorUserId','actorRoleSnap','scope','deletedByPath','requestId','ip','ua']
//   actorRoleSnap 必须是 Prisma Role 枚举值(SUPER_ADMIN / ADMIN / USER),不是权限码数组
//   scope 只能是 null | 'self' | 'other';deletedByPath 只能是 'owner' | 'admin'
function deletePayload(): Row {
  return {
    response: null,
    audit: {
      actorUserId: 'actor0000001',
      actorRoleSnap: 'ADMIN',
      scope: null,
      deletedByPath: 'admin',
      requestId: 'req000000001',
      ip: '10.0.0.1',
      ua: 'jest',
    },
  };
}

function makeService(
  options: {
    original?: Row | null;
    locked?: Row;
    currentOriginal?: Row | null;
    attachment?: Row | null;
    objectUpdatedCount?: number;
    originalUpdatedCount?: number;
    manualUpdatedCount?: number;
  } = {},
) {
  const original =
    options.original === undefined
      ? { id: ORIGINAL_ID, kind: 'attachment_delete', payloadVersion: 1, payload: deletePayload() }
      : options.original;
  const currentOriginal =
    options.currentOriginal === undefined
      ? {
          id: ORIGINAL_ID,
          kind: 'attachment_delete',
          status: 'dead',
          storageObjectId: OBJECT_ID,
          payloadVersion: 1,
          payload: deletePayload(),
        }
      : options.currentOriginal;

  const attachmentDelete = jest.fn().mockResolvedValue({});
  const logDelete = jest
    .fn<Promise<void>, [Record<string, unknown>]>()
    .mockResolvedValue(undefined);
  const storageObjectUpdateMany = jest
    .fn<Promise<{ count: number }>, [{ data: Record<string, unknown> }]>()
    .mockResolvedValue({ count: options.objectUpdatedCount ?? 1 });
  const operationUpdateMany = jest
    .fn()
    .mockResolvedValueOnce({ count: options.originalUpdatedCount ?? 1 })
    .mockResolvedValueOnce({ count: options.manualUpdatedCount ?? 1 });

  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: ATTACHMENT_ID }]),
    attachment: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          options.attachment === undefined
            ? { id: ATTACHMENT_ID, key: KEY, ownerType: 'member-doc', ownerId: 'm-1' }
            : options.attachment,
        ),
      delete: attachmentDelete,
    },
    storageObject: { updateMany: storageObjectUpdateMany },
    storageObjectOperation: {
      findUnique: jest.fn().mockResolvedValue(currentOriginal),
      updateMany: operationUpdateMany,
    },
    content: { findUnique: jest.fn().mockResolvedValue(null) },
  };

  const prisma = {
    storageObjectOperation: { findUnique: jest.fn().mockResolvedValue(original) },
    $transaction: jest.fn().mockImplementation((fn: (t: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;

  const ledger = {
    lockClaimedForUpdate: jest.fn().mockResolvedValue(options.locked ?? claimed()),
  } as unknown as StorageObjectLedgerService;

  const auditRecorder = { logDelete } as unknown as AttachmentAuditRecorder;

  return {
    service: new AttachmentManualAttestService(prisma, ledger, auditRecorder),
    attachmentDelete,
    logDelete,
    storageObjectUpdateMany,
    operationUpdateMany,
  };
}

describe('execute —— 进入事务前的安全闸', () => {
  it('拒绝:没有 replayOfId(不是重放操作)', async () => {
    const { service } = makeService();
    await expect(service.execute(claimed({ replayOfId: null }) as never)).rejects.toThrow(
      'manual attest absent safety gate rejected',
    );
  });

  it.each([['available'], ['absent'], ['pending_upload']])(
    '拒绝:对象状态是 %s(只有 delete_pending / delete_failed 可认定缺失)',
    async (state) => {
      const { service } = makeService();
      const op = claimed({
        storageObject: { ...(claimed().storageObject as Row), state },
      });
      await expect(service.execute(op as never)).rejects.toThrow(
        'manual attest absent safety gate rejected',
      );
    },
  );

  it('拒绝:原始操作不存在', async () => {
    const { service } = makeService({ original: null });
    await expect(service.execute(claimed() as never)).rejects.toThrow(
      'manual attest replay target rejected',
    );
  });

  it('拒绝:原始操作不是 attachment_delete', async () => {
    const { service } = makeService({
      original: { id: ORIGINAL_ID, kind: 'backfill_verify', payloadVersion: 1, payload: {} },
    });
    await expect(service.execute(claimed() as never)).rejects.toThrow(
      'manual attest replay target rejected',
    );
  });

  it('拒绝:对象没有关联 Attachment 资源(无从删起)', async () => {
    const { service } = makeService();
    const op = claimed({
      storageObject: {
        ...(claimed().storageObject as Row),
        resourceId: null,
        resourceType: 'other',
      },
    });
    await expect(service.execute(op as never)).rejects.toThrow(
      'manual attest object has no Attachment resource',
    );
  });
});

describe('execute —— 事务内锁定后的复核(每条都拦着一次误删)', () => {
  it('全部围栏通过 ⇒ 物理删附件、写审计、对象置 absent、两条操作置终态', async () => {
    const { service, attachmentDelete, logDelete, storageObjectUpdateMany, operationUpdateMany } =
      makeService();
    await expect(service.execute(claimed() as never)).resolves.toBeUndefined();
    expect(attachmentDelete).toHaveBeenCalledWith({ where: { id: ATTACHMENT_ID } });
    expect(logDelete).toHaveBeenCalledTimes(1);
    expect(storageObjectUpdateMany.mock.calls[0][0].data).toMatchObject({ state: 'absent' });
    expect(operationUpdateMany).toHaveBeenCalledTimes(2); // 原始 delete + 本 manual
  });

  // 审计必须在物理删之前记录 before 快照 —— 删完再记就没有 before 可记了。
  it('审计带上被删附件的 before 快照,且删除与审计都发生在同一事务内', async () => {
    const { service, logDelete } = makeService();
    await service.execute(claimed() as never);
    const logged = logDelete.mock.calls[0][0];
    expect(logged).toMatchObject({
      attachmentId: ATTACHMENT_ID,
      before: expect.objectContaining({ id: ATTACHMENT_ID }) as unknown,
      actorUserId: 'actor0000001',
    });
    // tx 必须透传 —— 审计与物理删除同事务,否则删成功而审计回滚会留下无迹可查的删除
    expect(logged.tx).toBeDefined();
  });

  const lockedStateBreakages: ReadonlyArray<[string, Row]> = [
    ['锁后 kind 变了', { kind: 'manual_relocate' }],
    ['锁后 replayOfId 指向了别的操作', { replayOfId: 'op-other-0001' }],
    [
      '锁后对象已不是 attachment 资源',
      { storageObject: { ...(claimed().storageObject as Row), resourceType: 'other' } },
    ],
    [
      '锁后对象状态已离开删除中/删除失败',
      { storageObject: { ...(claimed().storageObject as Row), state: 'available' } },
    ],
  ];

  it.each(lockedStateBreakages)('拒绝:%s', async (_label, over) => {
    const { service, attachmentDelete } = makeService({ locked: claimed(over) });
    await expect(service.execute(claimed() as never)).rejects.toThrow(
      'manual attest locked state rejected',
    );
    expect(attachmentDelete).not.toHaveBeenCalled(); // 关键:拒绝时绝不能已经删了
  });

  it('拒绝:锁后原始操作消失', async () => {
    const { service, attachmentDelete } = makeService({ currentOriginal: null });
    await expect(service.execute(claimed() as never)).rejects.toThrow(
      'manual attest original operation disappeared',
    );
    expect(attachmentDelete).not.toHaveBeenCalled();
  });

  it('拒绝:锁后原始操作已不是 dead(自动重试仍在进行)', async () => {
    const { service } = makeService({
      currentOriginal: {
        id: ORIGINAL_ID,
        kind: 'attachment_delete',
        status: 'processing',
        storageObjectId: OBJECT_ID,
        payloadVersion: 1,
        payload: deletePayload(),
      },
    });
    await expect(service.execute(claimed() as never)).rejects.toThrow(
      'manual attest original operation disappeared',
    );
  });

  it('拒绝:Attachment 行已不存在', async () => {
    const { service } = makeService({ attachment: null });
    await expect(service.execute(claimed() as never)).rejects.toThrow(
      'manual attest Attachment link rejected',
    );
  });

  // key 不一致 ⇒ 对象与附件的绑定关系已经漂移,此时删除会删错行。
  it('拒绝:Attachment 的 key 与存储对象的 key 不一致(绑定漂移)', async () => {
    const { service, attachmentDelete } = makeService({
      attachment: { id: ATTACHMENT_ID, key: 'attachments/OTHER.bin' },
    });
    await expect(service.execute(claimed() as never)).rejects.toThrow(
      'manual attest Attachment link rejected',
    );
    expect(attachmentDelete).not.toHaveBeenCalled();
  });
});

describe('execute —— 落库阶段的 CAS 与租约围栏', () => {
  it('拒绝:对象 CAS 未命中(状态在本事务期间被别人改了)', async () => {
    const { service } = makeService({ objectUpdatedCount: 0 });
    await expect(service.execute(claimed() as never)).rejects.toThrow(
      'manual attest object CAS lost',
    );
  });

  it('拒绝:原始操作终态化未命中', async () => {
    const { service } = makeService({ originalUpdatedCount: 0 });
    await expect(service.execute(claimed() as never)).rejects.toThrow(
      'manual attest original completion lost',
    );
  });

  // 租约已被别的 worker 抢走时必须抛专用错误,而非普通不变量错误 ——
  // 上层据此判定「可安全重试」而不是「数据坏了」。
  it('拒绝:本 manual 操作的租约围栏未命中 ⇒ 抛租约丢失(可重试),不是不变量错误', async () => {
    const { service } = makeService({ manualUpdatedCount: 0 });
    await expect(service.execute(claimed() as never)).rejects.toThrow(
      /lease|Lease|STORAGE_CONSISTENCY_LEASE/,
    );
  });
});
