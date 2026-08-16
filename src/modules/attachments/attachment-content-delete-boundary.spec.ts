import { Prisma } from '@prisma/client';

import type { AttachmentDeleteReplayResponse } from '../storage/storage-operation-payload';
import { lockContentDeleteFinalizationBoundary } from './attachment-content-delete-boundary';

/*
 * 内容根边界锁的单测(Phase 6-B 第四域第三刀 #1035 抽出,此前零覆盖)。
 *
 * 这个函数守的是:附件删除终态化时,若该附件属于某篇内容,必须先锁住内容根并复核
 * 「它确实已不再引用该附件」。放过一个仍被引用的附件 ⇒ 内容里留下死链,且删除不可逆。
 *
 * ⚠️ 它是**被调用方**而非事务起点 —— 调用方必须在尚未持有 Attachment / StorageObject
 * 行锁之前调用它(全局锁序第一段)。那条约束**无法用单测表达**(锁序是跨方法的调用次序),
 * 本 spec 只覆盖它自身的判定分支;锁序仍靠编排器文件头的台账与人工评审。
 */

type ContentRow = {
  statusCode: string;
  body: string;
  coverAttachmentId: string | null;
  coverImageKey: string | null;
  deletedAt: Date | null;
};

type AttachmentRow = { ownerType: string; ownerId: string; key: string } | null;

function makeTx(options: {
  lockedRows?: Array<{ id: string }>;
  content?: ContentRow | null;
  attachment?: AttachmentRow;
}) {
  const queryRaw = jest
    .fn<Promise<Array<{ id: string }>>, [Prisma.Sql]>()
    .mockResolvedValue(options.lockedRows ?? [{ id: 'content-1' }]);
  const contentFindUnique = jest.fn().mockResolvedValue(options.content ?? null);
  const attachmentFindUnique = jest.fn().mockResolvedValue(options.attachment ?? null);
  return {
    tx: {
      $queryRaw: queryRaw,
      content: { findUnique: contentFindUnique },
      attachment: { findUnique: attachmentFindUnique },
    } as unknown as Prisma.TransactionClient,
    queryRaw,
    contentFindUnique,
    attachmentFindUnique,
  };
}

function draftContent(over: Partial<ContentRow> = {}): ContentRow {
  return {
    statusCode: 'draft',
    body: '正文没有引用任何附件占位符',
    coverAttachmentId: null,
    coverImageKey: null,
    deletedAt: null,
    ...over,
  };
}

// ⚠️ 夹具 ID 必须是**纯字母数字**:正文占位符的提取正则是 /attachment:([a-z0-9]+)/gi,
// 而本仓 Attachment.id 是 cuid(如 vhdva6fphxl195ef2v73fu6t)——同样纯字母数字。
// 若这里图省事写成 'att-1',正则只会提取到 'att',与 attachmentId 不等 ⇒
// 「正文仍引用该附件」那条用例会**永远通过**,变成一条假测试。
const ATTACHMENT_ID = 'vhdva6fphxl195ef2v73fu6t';
const OTHER_ATTACHMENT_ID = 'nrllh3ucef84zybgze05rwq1';
const ATTACHMENT_KEY = 'attachments/a.png';

const contentResponse = {
  ownerType: 'content-image',
  ownerId: 'content-1',
  key: ATTACHMENT_KEY,
} as unknown as AttachmentDeleteReplayResponse;

describe('lockContentDeleteFinalizationBoundary —— 非内容附件直接放行', () => {
  it('response 的 ownerType 不是内容类 ⇒ 不加任何锁、不读任何表', async () => {
    const { tx, queryRaw, contentFindUnique, attachmentFindUnique } = makeTx({});
    const response = { ownerType: 'member-avatar' } as unknown as AttachmentDeleteReplayResponse;
    await expect(
      lockContentDeleteFinalizationBoundary(tx, response, ATTACHMENT_ID),
    ).resolves.toBeUndefined();
    expect(queryRaw).not.toHaveBeenCalled();
    expect(contentFindUnique).not.toHaveBeenCalled();
    expect(attachmentFindUnique).not.toHaveBeenCalled();
  });

  it('response 为 null 且 Attachment 也不是内容类 ⇒ 放行(读了 attachment 但不加锁)', async () => {
    const { tx, queryRaw, attachmentFindUnique } = makeTx({
      attachment: { ownerType: 'member-avatar', ownerId: 'm-1', key: 'k' },
    });
    await expect(
      lockContentDeleteFinalizationBoundary(tx, null, ATTACHMENT_ID),
    ).resolves.toBeUndefined();
    expect(attachmentFindUnique).toHaveBeenCalledTimes(1);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('response 为 null 且 Attachment 行已不存在 ⇒ 放行(删除本就要抹掉它)', async () => {
    const { tx, queryRaw } = makeTx({ attachment: null });
    await expect(
      lockContentDeleteFinalizationBoundary(tx, null, ATTACHMENT_ID),
    ).resolves.toBeUndefined();
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe('lockContentDeleteFinalizationBoundary —— 内容附件必须锁根并复核', () => {
  it('内容为草稿且确实不再引用 ⇒ 放行(正对照)', async () => {
    const { tx, queryRaw, contentFindUnique } = makeTx({ content: draftContent() });
    await expect(
      lockContentDeleteFinalizationBoundary(tx, contentResponse, ATTACHMENT_ID),
    ).resolves.toBeUndefined();
    expect(queryRaw).toHaveBeenCalledTimes(1); // 内容根被锁过
    expect(contentFindUnique).toHaveBeenCalledTimes(1); // 锁后重读
  });

  it('response 为 null 时从 Attachment 行解析属主,同样走锁根路径', async () => {
    const { tx, queryRaw } = makeTx({
      attachment: { ownerType: 'content-file', ownerId: 'content-1', key: 'k' },
      content: draftContent(),
    });
    await expect(
      lockContentDeleteFinalizationBoundary(tx, null, ATTACHMENT_ID),
    ).resolves.toBeUndefined();
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('拒绝:FOR UPDATE 没锁到行 ⇒ 内容根在本事务前已消失', async () => {
    const { tx } = makeTx({ lockedRows: [], content: draftContent() });
    await expect(
      lockContentDeleteFinalizationBoundary(tx, contentResponse, ATTACHMENT_ID),
    ).rejects.toThrow('content delete root disappeared');
  });

  it('拒绝:锁到了行但重读为空 ⇒ 读写视图不一致', async () => {
    const { tx } = makeTx({ content: null });
    await expect(
      lockContentDeleteFinalizationBoundary(tx, contentResponse, ATTACHMENT_ID),
    ).rejects.toThrow('content delete root reread failed');
  });

  it('内容已软删 ⇒ 放行(整篇都没了,不必再看引用)', async () => {
    const { tx } = makeTx({
      content: draftContent({ deletedAt: new Date(), statusCode: 'published' }),
    });
    await expect(
      lockContentDeleteFinalizationBoundary(tx, contentResponse, ATTACHMENT_ID),
    ).resolves.toBeUndefined();
  });

  it('拒绝:内容已不是草稿(删除期间被发布)', async () => {
    const { tx } = makeTx({ content: draftContent({ statusCode: 'published' }) });
    await expect(
      lockContentDeleteFinalizationBoundary(tx, contentResponse, ATTACHMENT_ID),
    ).rejects.toThrow('content changed state during attachment delete');
  });
});

describe('lockContentDeleteFinalizationBoundary —— 三条「重新被引用」的通道各自独立', () => {
  // 三个字段任一命中都必须拒绝。逐条钉:只让一个字段命中,其余保持不引用,
  // 这样某条通道被误删时只有对应用例变红,不会被另外两条掩盖。
  it('拒绝:被设为封面附件(coverAttachmentId)', async () => {
    const { tx } = makeTx({ content: draftContent({ coverAttachmentId: ATTACHMENT_ID }) });
    await expect(
      lockContentDeleteFinalizationBoundary(tx, contentResponse, ATTACHMENT_ID),
    ).rejects.toThrow('content attachment became referenced during delete');
  });

  it('拒绝:被设为封面图 key(coverImageKey)', async () => {
    const { tx } = makeTx({ content: draftContent({ coverImageKey: ATTACHMENT_KEY }) });
    await expect(
      lockContentDeleteFinalizationBoundary(tx, contentResponse, ATTACHMENT_ID),
    ).rejects.toThrow('content attachment became referenced during delete');
  });

  it('拒绝:正文里出现了该附件的占位符(body)', async () => {
    const { tx } = makeTx({
      content: draftContent({ body: `前文 attachment:${ATTACHMENT_ID} 后文` }),
    });
    await expect(
      lockContentDeleteFinalizationBoundary(tx, contentResponse, ATTACHMENT_ID),
    ).rejects.toThrow('content attachment became referenced during delete');
  });

  it('正文含别的附件占位符不影响本次删除(避免过度拒绝)', async () => {
    const { tx } = makeTx({
      content: draftContent({ body: `前文 attachment:${OTHER_ATTACHMENT_ID} 后文` }),
    });
    await expect(
      lockContentDeleteFinalizationBoundary(tx, contentResponse, ATTACHMENT_ID),
    ).resolves.toBeUndefined();
  });
});
