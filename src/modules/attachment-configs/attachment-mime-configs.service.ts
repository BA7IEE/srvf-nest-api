import { Injectable } from '@nestjs/common';
import { AttachmentMimeConfigStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  AttachmentMimeConfigResponseDto,
  CreateAttachmentMimeConfigDto,
  ListAttachmentMimeConfigsQueryDto,
  UpdateAttachmentMimeConfigDto,
  UpdateAttachmentMimeConfigStatusDto,
} from './attachment-mime-configs.dto';
import { attachmentMimeConfigSelect } from './attachment-mime-configs.select';

// V2.x C-7 attachments 实施 PR #4 / PR #6d(2026-05-15):AttachmentMimeConfig 业务逻辑。
// 沿 D7 v1.0 §4.3 + 用户 Step 1 拍板 Q1-Q8 + PR #6d Q1-Q8 audit 接入。
//
// **MIME 格式正则**(Q1 v1.0;Service 层显式校验):
// - 形如 `type/subtype` 或 `type/*` wildcard
// - 主类型:首字母小写,后续 [a-z0-9-]
// - 子类型:[a-z0-9.+-]+ 或 `*`(wildcard)
// - 允许 `image/jpeg` / `image/png` / `application/pdf` / `image/*` / `video/*` 等
// - 失败抛 BizException(BizCode.INVALID_ATTACHMENT_MIME_FORMAT)(13025)
const MIME_PATTERN = /^[a-z][a-z0-9-]*\/(\*|[a-z0-9.+-]+)$/;

// PR #6d:audit resourceType 按表区分(Q2 拍板)
const AUDIT_RESOURCE_TYPE = 'attachment_mime_config';

type SafeMimeConfig = Prisma.AttachmentMimeConfigGetPayload<{
  select: typeof attachmentMimeConfigSelect;
}>;

@Injectable()
export class AttachmentMimeConfigsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  // PR #6d Q3 拍板:audit snapshot 不含 id / 时间戳 / deletedAt;沿 cert / emergency 范式。
  // mime 字段全部非敏感,不打码;无 Date 字段,不需 toISOString。
  // attachmentMimeConfigSelect 包含 typeConfig 嵌套对象(Q2 v1.0 mime 出参摘要),audit
  // snapshot 只取扁平字段;typeConfigId 进 extra 便于跨表关联追溯。
  private toMimeConfigAuditSnapshot(c: SafeMimeConfig): Record<string, unknown> {
    return {
      typeConfigId: c.typeConfigId,
      mime: c.mime,
      status: c.status,
      remark: c.remark,
    };
  }

  // ============ helpers ============

  // 业务详情查询:findFirst + notDeletedWhere(沿 PR #3 type config 范式)。
  // 不存在或已软删统一抛 13022(沿 v1 §10 信息泄漏防御;Q2 v1.0 锁)。
  private async findActiveByIdOrThrow(id: string): Promise<SafeMimeConfig> {
    const found = await this.prisma.attachmentMimeConfig.findFirst({
      where: notDeletedWhere({ id }),
      select: attachmentMimeConfigSelect,
    });
    if (!found) throw new BizException(BizCode.ATTACHMENT_MIME_CONFIG_NOT_FOUND);
    return found;
  }

  // typeConfigId FK 真实性校验:不存在或已软删返 13020(Q5 v1.0 拍板:复用既有码,不开镜像)。
  private async assertTypeConfigActive(typeConfigId: string): Promise<void> {
    const typeConfig = await this.prisma.attachmentTypeConfig.findFirst({
      where: notDeletedWhere({ id: typeConfigId }),
      select: { id: true },
    });
    if (!typeConfig) {
      throw new BizException(BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND);
    }
  }

  // MIME 格式校验(Q1 v1.0;Service 层显式 regex);失败抛 13025。
  // 允许标准 MIME(image/jpeg)+ wildcard(image/*);防明显脏数据。
  private assertMimeFormatValid(mime: string): void {
    if (!MIME_PATTERN.test(mime)) {
      throw new BizException(BizCode.INVALID_ATTACHMENT_MIME_FORMAT);
    }
  }

  // P2002 兜底 —(typeConfigId, mime)复合 unique;DTO 校验 + Service 预检查应已拦绝大多数,
  // 这层处理并发场景(两个 create 同时撞 (typeConfigId, mime) unique)。
  private async runDuplicateGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = (err.meta?.target as string[] | undefined) ?? [];
        if (target.includes('typeConfigId') && target.includes('mime')) {
          throw new BizException(BizCode.ATTACHMENT_MIME_CONFIG_DUPLICATE);
        }
      }
      throw err;
    }
  }

  // ============ 6 端点业务逻辑 ============

  async list(
    query: ListAttachmentMimeConfigsQueryDto,
  ): Promise<PageResultDto<AttachmentMimeConfigResponseDto>> {
    const { page, pageSize, typeConfigId, status, mime } = query;
    const where: Prisma.AttachmentMimeConfigWhereInput = notDeletedWhere({
      ...(typeConfigId !== undefined ? { typeConfigId } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(mime !== undefined ? { mime } : {}),
    });

    const [items, total] = await this.prisma.$transaction([
      this.prisma.attachmentMimeConfig.findMany({
        where,
        select: attachmentMimeConfigSelect,
        // 默认排序:createdAt DESC(沿 baseline §3.2)
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.attachmentMimeConfig.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async getById(id: string): Promise<AttachmentMimeConfigResponseDto> {
    return this.findActiveByIdOrThrow(id);
  }

  async create(
    dto: CreateAttachmentMimeConfigDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttachmentMimeConfigResponseDto> {
    // 1. typeConfigId FK 真实性校验(Q5 v1.0:不存在或软删 → 13020;校验链留事务外)
    await this.assertTypeConfigActive(dto.typeConfigId);

    // 2. MIME 格式校验(Q1 v1.0;失败抛 13025)
    this.assertMimeFormatValid(dto.mime);

    // 3. (typeConfigId, mime) UNIQUE 预检查(含软删历史;Q8 v1.0:软删后不可复用;沿 CLAUDE.md §10)
    const existing = await this.prisma.attachmentMimeConfig.findUnique({
      where: {
        typeConfigId_mime: {
          typeConfigId: dto.typeConfigId,
          mime: dto.mime,
        },
      },
      select: { id: true },
    });
    if (existing) {
      throw new BizException(BizCode.ATTACHMENT_MIME_CONFIG_DUPLICATE);
    }

    // 4. 同事务:写主表 + audit;P2002 兜底外层包(沿 PR #6d Q8 拍板)。
    return this.runDuplicateGuard(() =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.attachmentMimeConfig.create({
          data: {
            typeConfigId: dto.typeConfigId,
            mime: dto.mime,
            remark: dto.remark,
            // status default ACTIVE(由 Prisma schema 兜底;沿 Q5 v1.0 type config 范式)
          },
          select: attachmentMimeConfigSelect,
        });

        await this.auditLogs.log({
          event: 'attachment.config.change',
          actorUserId: currentUser.id,
          actorRoleSnap: currentUser.role,
          resourceType: AUDIT_RESOURCE_TYPE,
          resourceId: created.id,
          meta: auditMeta,
          after: this.toMimeConfigAuditSnapshot(created),
          extra: {
            configType: 'mime',
            operation: 'create',
            typeConfigId: created.typeConfigId,
            mime: created.mime,
          },
          tx,
        });

        return created;
      }),
    );
  }

  async update(
    id: string,
    dto: UpdateAttachmentMimeConfigDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttachmentMimeConfigResponseDto> {
    // 1. 先确认活跃(不存在或已软删统一返 13022;校验链留事务外)
    const before = await this.findActiveByIdOrThrow(id);

    // 2. 事务内:仅更新 remark + audit(Q3 / Q4 v1.0:mime / typeConfigId 不可改;
    //    DTO 已白名单;ValidationPipe forbidNonWhitelisted 兜底其他字段)
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.attachmentMimeConfig.update({
        where: { id },
        data: { remark: dto.remark },
        select: attachmentMimeConfigSelect,
      });

      await this.auditLogs.log({
        event: 'attachment.config.change',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: updated.id,
        meta: auditMeta,
        before: this.toMimeConfigAuditSnapshot(before),
        after: this.toMimeConfigAuditSnapshot(updated),
        extra: {
          configType: 'mime',
          operation: 'update',
          typeConfigId: updated.typeConfigId,
          mime: updated.mime,
        },
        tx,
      });

      return updated;
    });
  }

  async updateStatus(
    id: string,
    dto: UpdateAttachmentMimeConfigStatusDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttachmentMimeConfigResponseDto> {
    // 1. 先确认活跃(沿 PR #3 type config status 范式;校验链留事务外)
    const before = await this.findActiveByIdOrThrow(id);

    // 2. V2.x Slow-6:仅 ACTIVE → INACTIVE 触发跨表引用检查(沿 Q-cross-3 A 对称防绕过)
    if (
      dto.status === AttachmentMimeConfigStatus.INACTIVE &&
      before.status === AttachmentMimeConfigStatus.ACTIVE
    ) {
      await this.assertMimeNotInUse(before.typeConfigId, before.mime);
    }

    // 3. 事务内:仅改 status + audit
    //    PR #6d Q4 拍板:before/after 仅 status 字段
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.attachmentMimeConfig.update({
        where: { id },
        data: { status: dto.status },
        select: attachmentMimeConfigSelect,
      });

      await this.auditLogs.log({
        event: 'attachment.config.change',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: updated.id,
        meta: auditMeta,
        before: { status: before.status },
        after: { status: updated.status },
        extra: {
          configType: 'mime',
          operation: 'update-status',
          typeConfigId: updated.typeConfigId,
          mime: updated.mime,
        },
        tx,
      });

      return updated;
    });
  }

  async softDelete(
    id: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttachmentMimeConfigResponseDto> {
    // 1. 先确认活跃(沿 PR #3 type config softDelete 范式;沿 v1 §10 信息泄漏防御)
    const existing = await this.findActiveByIdOrThrow(id);

    // 2. V2.x Slow-6:跨表引用检查(对称在 updateStatus 也加;沿 Q-cross-3 A)
    //    校验链留事务外:减小事务体积,失败回滚廉价
    await this.assertMimeNotInUse(existing.typeConfigId, existing.mime);

    // 3. 事务内:软删 + 同步置 INACTIVE + audit(沿 PR #3 dictionaries 双置范式)
    //    Q6 v1.0 + V2.x Slow-6:跨表引用检查已在事务外完成(assertMimeNotInUse;沿评审 §8.1)
    //    PR #6d Q5:resourceId=existing.id(软删 id 不变;沿 cert / emergency softDelete 范式)
    await this.prisma.$transaction(async (tx) => {
      await tx.attachmentMimeConfig.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          status: AttachmentMimeConfigStatus.INACTIVE,
        },
      });

      await this.auditLogs.log({
        event: 'attachment.config.change',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: existing.id,
        meta: auditMeta,
        before: this.toMimeConfigAuditSnapshot(existing),
        extra: {
          configType: 'mime',
          operation: 'delete',
          typeConfigId: existing.typeConfigId,
          mime: existing.mime,
        },
        tx,
      });
    });
    return existing;
  }

  /**
   * V2.x Slow-6 跨表引用检查:mime config 是否仍被 attachment 引用。
   *
   * 检查路径:typeConfigId → typeConfig.code → count attachments where ownerType+mime。
   * 注意 mime 字段比较精确到字符串级别,同 type 不同 mime 不视为引用。
   * 信息泄漏防御:不在异常 message / extra 暴露引用数(沿 Q-cross-impl-4 A + v1 §10)。
   */
  private async assertMimeNotInUse(typeConfigId: string, mime: string): Promise<void> {
    const typeConfig = await this.prisma.attachmentTypeConfig.findUnique({
      where: { id: typeConfigId },
      select: { code: true },
    });
    // 极端边界:typeConfig 不存在(FK Restrict 应保证不发生);fail-safe 跳过引用检查
    if (!typeConfig) return;

    const refCount = await this.prisma.attachment.count({
      where: {
        ownerType: typeConfig.code,
        mime,
      },
    });
    if (refCount > 0) {
      throw new BizException(BizCode.ATTACHMENT_MIME_CONFIG_IN_USE);
    }
  }
}
