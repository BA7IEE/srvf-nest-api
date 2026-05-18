import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import {
  AttachmentSizeLimitConfigResponseDto,
  CreateAttachmentSizeLimitConfigDto,
  ListAttachmentSizeLimitConfigsQueryDto,
  UpdateAttachmentSizeLimitConfigDto,
} from './attachment-size-limit-configs.dto';
import { attachmentSizeLimitConfigSelect } from './attachment-size-limit-configs.select';

// V2.x C-7 attachments 实施 PR #5 / PR #6d(2026-05-15):AttachmentSizeLimitConfig 业务逻辑。
// 沿 D7 v1.0 §4.4 + 用户 Step 1 拍板 Q1-Q8 + PR #6d Q1-Q8 audit 接入。
//
// **关键差异**(沿 D7 v1.0 §4.4 schema 现状):
// - **本表无 status 字段**(Q1 v1.0:不加)→ 5 端点(无 status 端点);软删只置 deletedAt = now()
// - 1:1 关系:typeConfigId UNIQUE(每 type 至多一条 override)
// - 无 mime 格式校验(本表只存 size 数值);DTO @Min/@Max 兜底 1 ~ 10 GiB
//
// **PR #6d audit 接入**:3 个写端点(create / update / softDelete);**无 updateStatus**
//(本表无 status 字段);extra.configType='sizeLimit'。

// PR #6d:audit resourceType 按表区分(Q2 拍板)
const AUDIT_RESOURCE_TYPE = 'attachment_size_limit_config';

type SafeSizeLimitConfig = Prisma.AttachmentSizeLimitConfigGetPayload<{
  select: typeof attachmentSizeLimitConfigSelect;
}>;

@Injectable()
export class AttachmentSizeLimitConfigsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly rbac: RbacService,
  ) {}

  // P0-F PR-2B(2026-05-18):RBAC 判权(沿 PR-2A dict / org / contrib-rule 范本)。
  // 失败统一抛 BizException(BizCode.RBAC_FORBIDDEN)(30100);RbacService.can 内部
  // 已实现 SUPER_ADMIN 短路 + cache + ownership(.self);本模块无 .self 后缀。
  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  // PR #6d Q3 拍板:audit snapshot 不含 id / 时间戳 / deletedAt;沿 cert / emergency 范式。
  // size limit 字段全部非敏感,不打码;无 Date 字段,不需 toISOString。
  // attachmentSizeLimitConfigSelect 包含 typeConfig 嵌套(Q4 v1.0 size 出参摘要),audit
  // snapshot 只取扁平字段;typeConfigId 进 extra 便于跨表关联追溯。
  private toSizeLimitConfigAuditSnapshot(c: SafeSizeLimitConfig): Record<string, unknown> {
    return {
      typeConfigId: c.typeConfigId,
      maxSizeBytes: c.maxSizeBytes,
      remark: c.remark,
    };
  }

  // ============ helpers ============

  // 业务详情查询:findFirst + notDeletedWhere(沿 PR #3 / PR #4 范式)。
  // 不存在或已软删统一抛 13026(沿 v1 §10 信息泄漏防御;Q2 PR #3/#4 沿用)。
  private async findActiveByIdOrThrow(id: string): Promise<SafeSizeLimitConfig> {
    const found = await this.prisma.attachmentSizeLimitConfig.findFirst({
      where: notDeletedWhere({ id }),
      select: attachmentSizeLimitConfigSelect,
    });
    if (!found) throw new BizException(BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_NOT_FOUND);
    return found;
  }

  // typeConfigId FK 真实性校验:不存在或已软删返 13020(沿 Q5 PR #4 复用既有码)。
  private async assertTypeConfigActive(typeConfigId: string): Promise<void> {
    const typeConfig = await this.prisma.attachmentTypeConfig.findFirst({
      where: notDeletedWhere({ id: typeConfigId }),
      select: { id: true },
    });
    if (!typeConfig) {
      throw new BizException(BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND);
    }
  }

  // P2002 兜底 — typeConfigId 1:1 UNIQUE;预检查 + 兜底双层防护(Q3 v1.0:含软删历史)。
  private async runUniqueGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = (err.meta?.target as string[] | undefined) ?? [];
        if (target.includes('typeConfigId')) {
          throw new BizException(BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_ALREADY_EXISTS);
        }
      }
      throw err;
    }
  }

  // ============ 5 端点业务逻辑 ============

  async list(
    user: CurrentUserPayload,
    query: ListAttachmentSizeLimitConfigsQueryDto,
  ): Promise<PageResultDto<AttachmentSizeLimitConfigResponseDto>> {
    await this.assertCanOrThrow(user, 'attachment-config.read.size-limit');
    const { page, pageSize, typeConfigId } = query;
    const where: Prisma.AttachmentSizeLimitConfigWhereInput = notDeletedWhere({
      ...(typeConfigId !== undefined ? { typeConfigId } : {}),
    });

    const [items, total] = await this.prisma.$transaction([
      this.prisma.attachmentSizeLimitConfig.findMany({
        where,
        select: attachmentSizeLimitConfigSelect,
        // 默认排序:createdAt DESC(沿 baseline §3.2)
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.attachmentSizeLimitConfig.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async getById(
    user: CurrentUserPayload,
    id: string,
  ): Promise<AttachmentSizeLimitConfigResponseDto> {
    await this.assertCanOrThrow(user, 'attachment-config.read.size-limit');
    return this.findActiveByIdOrThrow(id);
  }

  async create(
    dto: CreateAttachmentSizeLimitConfigDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttachmentSizeLimitConfigResponseDto> {
    await this.assertCanOrThrow(currentUser, 'attachment-config.create.size-limit');
    // 1. typeConfigId FK 真实性校验(Q5 PR #4 复用:不存在或软删 → 13020;校验链留事务外)
    await this.assertTypeConfigActive(dto.typeConfigId);

    // 2. typeConfigId 1:1 UNIQUE 预检查(含软删历史;Q3 v1.0:软删后不可复用;沿 CLAUDE.md §10)
    const existing = await this.prisma.attachmentSizeLimitConfig.findUnique({
      where: { typeConfigId: dto.typeConfigId },
      select: { id: true },
    });
    if (existing) {
      throw new BizException(BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_ALREADY_EXISTS);
    }

    // 3. 同事务:写主表 + audit;P2002 兜底外层包(沿 PR #6d Q8 拍板)。
    return this.runUniqueGuard(() =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.attachmentSizeLimitConfig.create({
          data: {
            typeConfigId: dto.typeConfigId,
            maxSizeBytes: dto.maxSizeBytes,
            remark: dto.remark,
            // 本表无 status 字段(Q1 v1.0);Prisma schema 无此列
          },
          select: attachmentSizeLimitConfigSelect,
        });

        await this.auditLogs.log({
          event: 'attachment.config.change',
          actorUserId: currentUser.id,
          actorRoleSnap: currentUser.role,
          resourceType: AUDIT_RESOURCE_TYPE,
          resourceId: created.id,
          meta: auditMeta,
          after: this.toSizeLimitConfigAuditSnapshot(created),
          extra: {
            configType: 'sizeLimit',
            operation: 'create',
            typeConfigId: created.typeConfigId,
            maxSizeBytes: created.maxSizeBytes,
          },
          tx,
        });

        return created;
      }),
    );
  }

  async update(
    id: string,
    dto: UpdateAttachmentSizeLimitConfigDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttachmentSizeLimitConfigResponseDto> {
    await this.assertCanOrThrow(currentUser, 'attachment-config.update.size-limit');
    // 1. 先确认活跃(不存在或已软删统一返 13026;校验链留事务外)
    const before = await this.findActiveByIdOrThrow(id);

    // 2. Q5 v1.0 显式拒绝 maxSizeBytes = null(class-validator @IsOptional 不拒 null;
    //    Prisma 收到 null 撞 NOT NULL 约束会走 500;在 service 入口提前拒)
    //    清除 size limit 的语义是 DELETE 这条配置,而不是 PATCH null。
    if (dto.maxSizeBytes === null) {
      throw new BizException(BizCode.BAD_REQUEST);
    }

    // 3. 事务内:更新 + audit(Q4 PR #4 范式:typeConfigId 不可改;
    //    forbidNonWhitelisted 兜底其他字段(包括不存在的 status))
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.attachmentSizeLimitConfig.update({
        where: { id },
        data: {
          maxSizeBytes: dto.maxSizeBytes,
          remark: dto.remark,
        },
        select: attachmentSizeLimitConfigSelect,
      });

      await this.auditLogs.log({
        event: 'attachment.config.change',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: updated.id,
        meta: auditMeta,
        before: this.toSizeLimitConfigAuditSnapshot(before),
        after: this.toSizeLimitConfigAuditSnapshot(updated),
        extra: {
          configType: 'sizeLimit',
          operation: 'update',
          typeConfigId: updated.typeConfigId,
          maxSizeBytes: updated.maxSizeBytes,
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
  ): Promise<AttachmentSizeLimitConfigResponseDto> {
    await this.assertCanOrThrow(currentUser, 'attachment-config.delete.size-limit');
    // 1. 先确认活跃(沿 PR #4 mime softDelete 范式;沿 v1 §10 信息泄漏防御)
    const existing = await this.findActiveByIdOrThrow(id);

    // 2. V2.x Slow-6:跨表引用检查(沿 Q-cross-4 A:size 1:1 with type;
    //    通过 typeConfig.code 反查 attachments;同 type 有引用即视为 size config IN_USE)
    //    校验链留事务外:减小事务体积,失败回滚廉价
    await this.assertSizeNotInUse(existing.typeConfigId);

    // 3. 事务内:软删 + audit(Q7 v1.0:本表无 status 字段,只置 deletedAt = now();
    //    不同步置任何其他字段)。
    //    Q2 v1.0 + V2.x Slow-6:跨表引用检查已在事务外完成(assertSizeNotInUse;沿评审 §8.1)。
    //    PR #6d Q5:resourceId=existing.id(软删 id 不变;沿 cert / emergency softDelete 范式)
    await this.prisma.$transaction(async (tx) => {
      await tx.attachmentSizeLimitConfig.update({
        where: { id },
        data: { deletedAt: new Date() },
      });

      await this.auditLogs.log({
        event: 'attachment.config.change',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: existing.id,
        meta: auditMeta,
        before: this.toSizeLimitConfigAuditSnapshot(existing),
        extra: {
          configType: 'sizeLimit',
          operation: 'delete',
          typeConfigId: existing.typeConfigId,
          maxSizeBytes: existing.maxSizeBytes,
        },
        tx,
      });
    });
    return existing;
  }

  /**
   * V2.x Slow-6 跨表引用检查:size config 是否仍被 attachment 引用(通过 typeConfig.code)。
   *
   * 检查路径:typeConfigId → typeConfig.code → count attachments where ownerType。
   * 沿 Q-cross-4 A:size 是 type 的 1:1 覆盖;删除 size 会让既有 type 的 attachment 走兜底,
   * 视作"语义破坏",故同 type 任意 attachment 即视为 size config IN_USE。
   * 信息泄漏防御:不在异常 message / extra 暴露引用数(沿 Q-cross-impl-4 A + v1 §10)。
   */
  private async assertSizeNotInUse(typeConfigId: string): Promise<void> {
    const typeConfig = await this.prisma.attachmentTypeConfig.findUnique({
      where: { id: typeConfigId },
      select: { code: true },
    });
    // 极端边界:typeConfig 不存在(FK Restrict 应保证不发生);fail-safe 跳过引用检查
    if (!typeConfig) return;

    const refCount = await this.prisma.attachment.count({
      where: { ownerType: typeConfig.code },
    });
    if (refCount > 0) {
      throw new BizException(BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_IN_USE);
    }
  }
}
