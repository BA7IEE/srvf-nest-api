import { Prisma } from '@prisma/client';

import { extractAttachmentPlaceholderIds } from '../content/content.constants';
import { StorageConsistencyInvariantError } from '../storage/storage-consistency.types';
import type { AttachmentDeleteReplayResponse } from '../storage/storage-operation-payload';

/*
 * 内容根(Content)在附件删除终态化时的**边界锁**(Phase 6-B 第四域第三刀)。
 *
 * 为什么单独成文件:该原语被**两个族共用** ——
 *   - delete 族  `finalizeAttachmentDelete`
 *   - manual 族  `finalizeManualAttestedDelete`
 * 按族继续拆分编排器时,若它留在编排器里,被抽出的族就得 import 回编排器(循环依赖);
 * 若把它跟着某一族搬走,另一族就要反向依赖那一族(例如「删除逻辑依赖手工运维服务」,语义歪)。
 * 唯一不歪的位置是**独立的共享件**。
 *
 * 做成纯函数而非 @Injectable:它实测**零 `this.` 引用** —— 只吃传入的 `tx`,
 * 不需要 prisma/ledger/provider 任何注入。纯函数不进 DI 图,两个 module 都无需改注册。
 *
 * ⚠️ 锁序(编排器文件头的锁序台账是全局单点,此处不复制、只引用):
 * 本函数实现的是台账中「(Content root for content owners) -> Attachment -> ...」的**第一段**。
 * 调用方必须在**尚未持有 Attachment / StorageObject 行锁之前**调用它 ——
 * 台账原文:「A path involving an existing Attachment must never acquire Attachment after
 * Object/Operation.」把它挪到调用链更晚的位置会静默破坏全局锁序,而不会有任何编译或测试报错。
 */
export async function lockContentDeleteFinalizationBoundary(
  tx: Prisma.TransactionClient,
  response: AttachmentDeleteReplayResponse | null,
  attachmentId: string,
): Promise<void> {
  let owner =
    response && (response.ownerType === 'content-image' || response.ownerType === 'content-file')
      ? { ownerId: response.ownerId, key: response.key }
      : null;
  if (!response) {
    // The replay response is purged after its bounded retry window, while a dead delete may still
    // require manual attestation later. Resolve the immutable owner link without taking an
    // Attachment row lock, then preserve the global Content -> Attachment lock order below.
    const attachment = await tx.attachment.findUnique({
      where: { id: attachmentId },
      select: { ownerType: true, ownerId: true, key: true },
    });
    if (
      attachment &&
      (attachment.ownerType === 'content-image' || attachment.ownerType === 'content-file')
    ) {
      owner = { ownerId: attachment.ownerId, key: attachment.key };
    }
  }
  if (!owner) {
    return;
  }
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "contents" WHERE "id" = ${owner.ownerId} FOR UPDATE
  `);
  if (locked.length !== 1) {
    throw new StorageConsistencyInvariantError('content delete root disappeared');
  }
  const content = await tx.content.findUnique({
    where: { id: owner.ownerId },
    select: {
      statusCode: true,
      body: true,
      coverAttachmentId: true,
      coverImageKey: true,
      deletedAt: true,
    },
  });
  if (!content) {
    throw new StorageConsistencyInvariantError('content delete root reread failed');
  }
  if (content.deletedAt !== null) return;
  if (content.statusCode !== 'draft') {
    throw new StorageConsistencyInvariantError('content changed state during attachment delete');
  }
  if (
    content.coverAttachmentId === attachmentId ||
    content.coverImageKey === owner.key ||
    extractAttachmentPlaceholderIds(content.body).includes(attachmentId)
  ) {
    throw new StorageConsistencyInvariantError(
      'content attachment became referenced during delete',
    );
  }
}
