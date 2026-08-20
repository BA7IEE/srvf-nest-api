import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AttachmentVisualIdentityUploadService } from '../attachments/attachment-visual-identity-upload.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { AccountAvatarDto } from './dto/app/account-avatar.dto';

/**
 * issue #1055 T3 —— App 账号头像闭环。
 *
 * ## 本类拥有什么、不拥有什么
 *
 * **拥有**:`User` 聚合根的锁与事务、头像指针的领域不变量、旧头像的 durable delete 时机、
 * 以及两个审计事件。
 * **不拥有**:图片规格、storage 编排、签名 URL —— 那些全在
 * `AttachmentVisualIdentityUploadService` 后面,本类只调它的受控出口。
 *
 * 这个分工与 `registration-upload-session` 一致:facade 管存储正确性,调用方管领域正确性。
 *
 * ## 为什么是 multipart 而不是 issue §7.1 的 upload-url + confirm
 *
 * 维护者 2026-08-20 拍板。§7.1 描述的是「客户端拿签名 URL 直传 storage,confirm 时服务端
 * 校验规范化结果」——但**服务端要规范化就必须看见字节**。直传形状下,服务端只能在 confirm
 * 时把字节拉回来、规范化、再传一次:双倍传输,而且**未规范化的原图(带 EXIF/GPS)会先落进
 * storage 并停留一段时间** —— 那正是整套视觉身份设计要防的那个泄露。
 *
 * 10 MB 以内的头像,省下的那点带宽换不来这个代价。形状因此取 multipart 直传服务端,
 * 与仓内既有的 `registration-upload-session` 可信 facade 逐字同形。
 */
@Injectable()
export class AppAvatarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly visualIdentity: AttachmentVisualIdentityUploadService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /**
   * 上传 / 替换本人头像。
   *
   * 事务边界刻意是「短事务 → 出事务做网络 → 短事务」:Provider 的 put 与 HEAD 是网络调用,
   * 放进事务会让一次 provider 抖动挂住 `User` 行锁(仓内生产事务只有 5s 预算)。
   */
  async replaceMyAvatar(
    user: CurrentUserPayload,
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
    auditMeta: AuditMeta,
  ): Promise<AccountAvatarDto> {
    // ① 事务外:校验 + 规范化。这一步在**任何 storage 副作用之前** ——
    //    不合规的图连一条 intent 都不该留下(留下就要靠对账 worker 去收)。
    const validated =
      await this.visualIdentity.validateVisualIdentityUploadOutsideTransactionTrusted({
        kind: 'user-avatar',
        ownerId: user.id,
        originalName: file.originalname,
        mime: file.mimetype,
        size: file.size,
        body: file.buffer,
        uploadedByUserId: user.id,
        user,
        expiresAt: new Date(Date.now() + AVATAR_UPLOAD_INTENT_TTL_MS),
      });

    // ② 短事务:锁 User 并复核未软删,再备 intent。
    const prepared = await this.prisma.$transaction(async (tx) => {
      await this.lockLiveUser(tx, user.id);
      return this.visualIdentity.prepareVisualIdentityUploadInTransactionTrusted(tx, validated);
    });

    // ③ 事务外:Provider put + HEAD 证据。
    const verified =
      await this.visualIdentity.putVisualIdentityUploadAndVerifyOutsideTransactionTrusted(prepared);

    // ④ 短事务:重新取锁 → 读旧指针 → 落 Attachment → 改指针 → 写审计,一次提交。
    //    重新取锁不是多余的:阶段 ③ 期间锁是放开的,这中间账号可能已被软删。
    const { finalized, previousAttachmentId } = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockLiveUser(tx, user.id);
      const done = await this.visualIdentity.finalizeVisualIdentityUploadInTransactionTrusted(
        tx,
        verified,
        auditMeta,
      );
      const view = this.visualIdentity.visualIdentityUploadResponseTrusted(done);

      await tx.user.update({
        where: { id: user.id },
        data: { avatarAttachmentId: view.attachmentId },
      });

      await this.auditLogs.log({
        event: 'user.avatar.change.self',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: 'user',
        resourceId: user.id,
        meta: auditMeta,
        // ⚠️ extra 是闭集(issue §11.2):**禁** storage key / signed URL / 图片二进制 /
        // 真实文件路径 / Provider locator / EXIF。附件 id 与规格代码不属于那一类,
        // 它们不指向任何可直接取到二进制的位置。
        extra: {
          attachmentId: view.attachmentId,
          specVersion: view.specCode,
          ...(locked.avatarAttachmentId === null
            ? {}
            : { oldAttachmentId: locked.avatarAttachmentId }),
        },
        tx,
      });

      return { finalized: view, previousAttachmentId: locked.avatarAttachmentId };
    });

    // ⑤ 提交之后才清旧的。**不能放进 ④**:durable delete 自己开事务,嵌进去会让
    //    一次清理失败把已经成功的替换整个回滚。提交后失败只留一个孤儿 blob,由对账 worker 收 ——
    //    丢一个孤儿 blob 远好过丢一次用户操作。
    await this.purgeSupersededAvatar(previousAttachmentId, user, auditMeta);

    return this.toDto(finalized.attachmentId);
  }

  /**
   * 清空本人头像。**重复清空幂等**(issue §7.1)。
   *
   * 幂等空转**不写审计** —— 沿 `wecom.clear.by-admin` 的既有口径:
   * 什么都没变就不该在审计里留一条「变更」,否则审计流水会被无意义的空转淹没。
   */
  async clearMyAvatar(user: CurrentUserPayload, auditMeta: AuditMeta): Promise<void> {
    const previousAttachmentId = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockLiveUser(tx, user.id);
      if (locked.avatarAttachmentId === null) return null;

      await tx.user.update({ where: { id: user.id }, data: { avatarAttachmentId: null } });
      await this.auditLogs.log({
        event: 'user.avatar.clear.self',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: 'user',
        resourceId: user.id,
        meta: auditMeta,
        extra: { attachmentId: locked.avatarAttachmentId },
        tx,
      });
      return locked.avatarAttachmentId;
    });

    await this.purgeSupersededAvatar(previousAttachmentId, user, auditMeta);
  }

  /** 读本人当前头像。没有头像、或 URL 签不出来,都返 `null`(调用方一视同仁走默认头像)。 */
  async getMyAvatar(user: CurrentUserPayload): Promise<AccountAvatarDto | null> {
    const row = await this.prisma.user.findFirst({
      where: { id: user.id, deletedAt: null },
      select: { avatarAttachmentId: true },
    });
    if (row?.avatarAttachmentId == null) return null;
    return this.toDto(row.avatarAttachmentId);
  }

  // ===== internals =====

  /**
   * 锁住 `User` 行并复核未软删。
   *
   * `FOR UPDATE` 是承重的:替换是「落 Attachment + 改指针」两步,并发两次替换若不串行,
   * 后写的指针会覆盖先写的,而先写的那张附件从此**没有任何行引用它** —— 变成孤儿,
   * 且因为不在 `previousAttachmentId` 里,连 durable delete 都不会去清它。
   */
  private async lockLiveUser(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<{ avatarAttachmentId: string | null }> {
    const rows = await tx.$queryRaw<Array<{ avatarAttachmentId: string | null }>>(Prisma.sql`
      SELECT "avatarAttachmentId" FROM "User" WHERE "id" = ${userId} AND "deletedAt" IS NULL FOR UPDATE
    `);
    const row = rows[0];
    if (rows.length !== 1 || row === undefined) throw new BizException(BizCode.USER_NOT_FOUND);
    return row;
  }

  private async purgeSupersededAvatar(
    attachmentId: string | null,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<void> {
    if (attachmentId === null) return;
    await this.visualIdentity.deleteVisualIdentityAttachmentAfterCommitTrusted({
      attachmentId,
      actorUserId: user.id,
      actorRoleSnap: user.role,
      auditMeta,
    });
  }

  private async toDto(attachmentId: string): Promise<AccountAvatarDto> {
    const signed = await this.visualIdentity.resolveVisualIdentityAccessUrlTrusted(attachmentId);
    return {
      attachmentId,
      accessUrl: signed?.accessUrl ?? null,
      expiresAt: signed?.expiresAt ?? null,
    };
  }
}

/**
 * upload intent 的存活期。
 *
 * multipart 形状下阶段 ①→④ 全在**同一个 HTTP 请求**内跑完,正常路径根本用不到这个 TTL;
 * 它只在「进程在阶段 ③ 之后崩掉」时决定那条 intent 多久被对账 worker 判定为可回收。
 * 10 分钟足够覆盖一次 provider 重试,又不会让孤儿在账上挂太久。
 */
const AVATAR_UPLOAD_INTENT_TTL_MS = 10 * 60 * 1000;
