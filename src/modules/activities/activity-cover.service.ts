import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import appConfig from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AttachmentsService } from '../attachments/attachments.service';
import type { ActivityResponseDto } from './activities.dto';
import { ActivityAccessService, type ActivityFullRow } from './activity-access.service';
import { ActivityAuditRecorder } from './activity-audit-recorder';
import { ActivityImageSigningService } from './activity-image-signing.service';
import { toResponseDto } from './activity-presenter';

/*
 * 活动封面 / 图集的**唯一写入口**(P2-14 刀 A)。
 *
 * 修的缺陷:此前封面是 `Activity.coverImageUrl String?`,把关的只有 `@IsString() @MaxLength(512)`
 * —— 即「任何字符串都能当封面」。后果:能填任意外站地址(外站换图/删图后封面变裂图或
 * **变成别的内容**)、图不在本仓存储里(备份 / 迁移 / 清理 / 配额全都管不到)、
 * 也可能填站内签名链接而签名链接会过期(封面一张一张慢慢坏掉且无告警)、
 * 且该 URL 谁拿到谁能看、永不失效。图集 `galleryImageUrls Json?` 同病且更松
 * (旧 DTO 连 `ArrayMaxSize` 和每项 `MaxLength` 都没有 = 无界数组 + 无界字符串)。
 *
 * ⭐ **校验链是复用而不是另写一份**。三步与 `ContentService.setCover` 逐字同型:
 *   ① 附件必须属于本活动(`ownerType='activity'` 且 `ownerId=<本活动 id>`),否则 404
 *   ② 走存储边界锁 —— 与内容模块**同一个实现**
 *      (`lockOwnerReferenceStorageBoundaryTrusted`,内容模块那条只是它的包装)
 *   ③ 反范式落 key + 落 attachment id
 * 另写一份的代价不是重复代码,是**两份对「什么算合法封面」的理解会各自漂移,而漂移时没有症状**。
 *
 * ⚠️ 为什么封面不做成 create/update 的一个字段(它此前就是):
 * ①式要求附件已归属本活动,而**创建活动那一刻活动还不存在**,附件不可能已归属它 ——
 * create 上的封面字段在结构上不可能被正确校验。对照组 Content 也正是因此把封面
 * 单独做成端点 12。顺序:建活动(draft)→ 以 ownerType='activity' 上传附件 → 设封面。
 *
 * ⚠️ **状态口径刻意保持与改造前一致**:改造前 `coverImageUrl` / `galleryImageUrls` 同时在
 * `PUBLISHED_ACTIVITY_DISPLAY_FIELD_SET`(已发布活动可直改、不必走变更审核)与
 * `TERMINAL_ACTIVITY_UPDATE_FIELDS`(终态活动仍可改展示字段)里。故本服务
 * **不加任何状态闸** —— 只要活动未软删就能设封面。加状态闸会是本刀夹带的行为收窄。
 *
 * ⚠️ 本服务**不进发布变更审核链**:封面本就是可直改的展示字段(见上),
 * 且 change-review 快照的 schemaVersion 2–5 是逐字冻结的契约,往里加字段要 v6,不在本刀范围。
 */
@Injectable()
export class ActivityCoverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityAccessService,
    private readonly attachments: AttachmentsService,
    private readonly auditRecorder: ActivityAuditRecorder,
    private readonly images: ActivityImageSigningService,
    @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
  ) {}

  // ============ Admin 面 ============

  async setCoverAdmin(
    activityId: string,
    attachmentId: string | null,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<ActivityResponseDto> {
    return this.runInActivity(activityId, user, meta, 'admin', (ctx) =>
      this.applyCover(ctx, attachmentId),
    );
  }

  async setGalleryAdmin(
    activityId: string,
    attachmentIds: readonly string[],
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<ActivityResponseDto> {
    return this.runInActivity(activityId, user, meta, 'admin', (ctx) =>
      this.applyGallery(ctx, attachmentIds),
    );
  }

  // ============ App 面(本人 managed 活动)============

  async setCoverManaged(
    activityId: string,
    attachmentId: string | null,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<ActivityResponseDto> {
    return this.runInActivity(activityId, user, meta, 'managed', (ctx) =>
      this.applyCover(ctx, attachmentId),
    );
  }

  async setGalleryManaged(
    activityId: string,
    attachmentIds: readonly string[],
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<ActivityResponseDto> {
    return this.runInActivity(activityId, user, meta, 'managed', (ctx) =>
      this.applyGallery(ctx, attachmentIds),
    );
  }

  // ============ 共用编排 ============

  /**
   * 判权 → 取聚合根锁 → 执行 → 现签 URL 返回。
   *
   * ⚠️ 锁序:Activity 根锁**先于**任何 Attachment / StorageObject 行锁 ——
   * 与编排器文件头的锁序台账一致(`prepareDelete` 那一行也是 owner root → Attachment
   * → StorageObject)。存储边界锁在 `applyCover` / `applyGallery` 内部、根锁之后调用,
   * 顺序不得对调。
   */
  private async runInActivity(
    activityId: string,
    user: CurrentUserPayload,
    meta: AuditMeta,
    surface: 'admin' | 'managed',
    run: (ctx: ImageWriteContext) => Promise<ImageWriteOutcome>,
  ): Promise<ActivityResponseDto> {
    if (surface === 'admin') {
      await this.access.assertCanOrThrow(user, 'activity.update.record', {
        type: 'activity',
        id: activityId,
      });
    } else if (!this.config.activityResponsibilityWorkflow.enabled) {
      // App managed 面的写端点在责任闭环 gate 关闭时一律 fail-closed —— 与
      // ActivityWriteService.update / ActivityPositionsService 的 managed 分支同码同形。
      // 漏掉这一支会让封面成为 gate 关闭时**唯一还能写**的 managed 端点。
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Admin 面锁到活动本身;App managed 面的归属锚是发起人字段,越权一律 404
      // (不暴露成 403 —— 沿 lockAndFindManagedActivityOrThrow 的既有语义)。
      const current =
        surface === 'admin'
          ? await this.access.lockAndFindActivityOrThrow(activityId, tx)
          : await this.access.lockAndFindManagedActivityOrThrow(activityId, user, tx);

      const outcome = await run({ tx, activityId, current });

      const row = await tx.activity.update({
        where: { id: activityId },
        data: outcome.data,
        select: activityImageWriteSelect,
      });

      await this.auditRecorder.logImageReference({
        activityId,
        actorUserId: user.id,
        actorRoleSnap: user.role,
        operation: outcome.operation,
        before: outcome.before,
        after: outcome.after,
        auditMeta: meta,
        tx,
      });

      return row;
    });

    const full = await this.access.findActivityOrThrow(updated.id);
    return toResponseDto(full, await this.images.signImages(full));
  }

  private async applyCover(
    ctx: ImageWriteContext,
    attachmentId: string | null,
  ): Promise<ImageWriteOutcome> {
    let coverImageKey: string | null = null;
    let coverAttachmentId: string | null = null;

    if (attachmentId !== null) {
      const attachment = await this.findOwnedAttachmentsOrThrow(ctx, [attachmentId]);
      const only = attachment[0];
      /* istanbul ignore next -- findOwnedAttachmentsOrThrow 已保证等长且非空 */
      if (only === undefined) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
      await this.attachments.lockOwnerReferenceStorageBoundaryTrusted(ctx.tx, {
        ownerId: ctx.activityId,
        ownerTypes: ACTIVITY_IMAGE_OWNER_TYPES,
        referencedAttachmentIds: [only.id],
      });
      coverImageKey = only.key;
      coverAttachmentId = only.id;
    }

    return {
      operation: 'set-cover',
      data: { coverImageKey, coverAttachmentId },
      before: { coverAttachmentId: ctx.current.coverAttachmentId },
      after: { coverAttachmentId },
    };
  }

  private async applyGallery(
    ctx: ImageWriteContext,
    attachmentIds: readonly string[],
  ): Promise<ImageWriteOutcome> {
    if (attachmentIds.length === 0) {
      return {
        operation: 'set-gallery',
        data: { galleryImageKeys: [], galleryAttachmentIds: [] },
        before: { galleryAttachmentIds: ctx.current.galleryAttachmentIds },
        after: { galleryAttachmentIds: [] },
      };
    }

    const owned = await this.findOwnedAttachmentsOrThrow(ctx, attachmentIds);
    await this.attachments.lockOwnerReferenceStorageBoundaryTrusted(ctx.tx, {
      ownerId: ctx.activityId,
      ownerTypes: ACTIVITY_IMAGE_OWNER_TYPES,
      referencedAttachmentIds: owned.map((row) => row.id),
    });

    // 两列必须**逐位对齐**(DB 侧 activity_gallery_arrays_aligned_check 是执行位)。
    // `findOwnedAttachmentsOrThrow` 已按入参顺序返回,故这里同一次 map 出两条数组,
    // 天然同长同序 —— 不要改成两次独立遍历。
    const galleryAttachmentIds = owned.map((row) => row.id);
    const galleryImageKeys = owned.map((row) => row.key);

    return {
      operation: 'set-gallery',
      data: { galleryImageKeys, galleryAttachmentIds },
      before: { galleryAttachmentIds: ctx.current.galleryAttachmentIds },
      after: { galleryAttachmentIds },
    };
  }

  /**
   * 归属校验:每个 id 都必须是**本活动**的 `activity` 类型附件,否则 404。
   *
   * ⭐ 这条就是越权闸:拿 A 活动的附件 id 去设 B 活动的封面,在这里被判成
   * 「B 活动没有这个附件」→ `ACTIVITY_NOT_FOUND`(沿内容模块 setCover 的
   * 「非本文章的附件 → CONTENT_NOT_FOUND」防越权语义:不回 403,免得确认了
   * 「有这么个附件、只是不属于你」)。
   *
   * ⚠️ 查询本身**委托给 attachments 模块**,不在这里 `tx.attachment.findMany` ——
   * 附件归属是附件域的事实,活动模块直读它是跨域读(架构债棘轮会当场判
   * `cross-domain-fact-read-candidate`),而且会让「什么算本活动的合法附件」
   * 出现第二份定义。本方法只负责把 facade 的 `null` 映射成业务码。
   *
   * 返回顺序与入参一致 —— 图集的顺序就是展示顺序。
   */
  private async findOwnedAttachmentsOrThrow(
    ctx: ImageWriteContext,
    attachmentIds: readonly string[],
  ): Promise<Array<{ id: string; key: string }>> {
    const owned = await this.attachments.findOwnedAttachmentsTrusted(ctx.tx, {
      ownerId: ctx.activityId,
      ownerTypes: ACTIVITY_IMAGE_OWNER_TYPES,
      attachmentIds,
    });
    if (owned === null) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return owned;
  }
}

// 活动图片只有一个 owner type。做成常量数组而不是内联字面量,是为了让
// 边界锁与归属查询**引用同一个值** —— 两处各写一次字面量正是漂移的起点。
const ACTIVITY_IMAGE_OWNER_TYPES = ['activity'] as const;

const activityImageWriteSelect = { id: true } as const satisfies Prisma.ActivitySelect;

interface ImageWriteContext {
  tx: Prisma.TransactionClient;
  activityId: string;
  current: ActivityFullRow;
}

interface ImageWriteOutcome {
  operation: 'set-cover' | 'set-gallery';
  data: Prisma.ActivityUpdateInput;
  before: { coverAttachmentId: string | null } | { galleryAttachmentIds: string[] };
  after: { coverAttachmentId: string | null } | { galleryAttachmentIds: string[] };
}
