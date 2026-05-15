import { Injectable } from '@nestjs/common';
import { AttachmentTypeConfigStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  AttachmentTypeConfigResponseDto,
  CreateAttachmentTypeConfigDto,
  ListAttachmentTypeConfigsQueryDto,
  UpdateAttachmentTypeConfigDto,
  UpdateAttachmentTypeConfigStatusDto,
} from './attachment-type-configs.dto';
import { attachmentTypeConfigSelect } from './attachment-type-configs.select';

// V2.x C-7 attachments 实施 PR #3 / PR #6d(2026-05-15):AttachmentTypeConfig 业务逻辑。
// 沿 D7 v1.0 §4.2 / §16 决议表 + 用户 Step 1 拍板 Q1-Q7 + PR #6d Q1-Q8 audit 接入。
//
// **code 格式正则**(沿 RbacRole.code 范式;Q3 候选 A;kebab-case 业务标识 3-32):
// - 首字母小写,后续允许 [a-z0-9-];总长 3-32
// - 失败抛 BizException(BizCode.INVALID_ATTACHMENT_TYPE_CONFIG_CODE_FORMAT)(13023)
const CODE_PATTERN = /^[a-z][a-z0-9-]{2,32}$/;

// PR #6d:audit resourceType 按表区分(Q2 拍板:沿 emergency_contact / certificate 范式)
const AUDIT_RESOURCE_TYPE = 'attachment_type_config';

type SafeTypeConfig = Prisma.AttachmentTypeConfigGetPayload<{
  select: typeof attachmentTypeConfigSelect;
}>;

@Injectable()
export class AttachmentTypeConfigsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  // PR #6d Q3 拍板:audit snapshot 不含 id / 时间戳 / deletedAt;沿 cert / emergency 范式。
  // 配置三表字段全部非敏感,不打码;无 Date 字段(创建/更新时间已剔除),不需 toISOString。
  private toTypeConfigAuditSnapshot(c: SafeTypeConfig): Record<string, unknown> {
    return {
      code: c.code,
      displayName: c.displayName,
      description: c.description,
      ownerTable: c.ownerTable,
      defaultMaxSizeBytes: c.defaultMaxSizeBytes,
      defaultMimeWhitelist: c.defaultMimeWhitelist,
      status: c.status,
    };
  }

  // ============ helpers ============

  // 业务详情查询:findFirst + notDeletedWhere(沿 v1 §10 / batch6 / RBAC roles 范式)。
  // 不存在或已软删统一抛 13020(沿 v1 §10 信息泄漏防御:不区分 NOT_FOUND vs DELETED;Q2 v1.0 锁)。
  private async findActiveByIdOrThrow(id: string): Promise<SafeTypeConfig> {
    const found = await this.prisma.attachmentTypeConfig.findFirst({
      where: notDeletedWhere({ id }),
      select: attachmentTypeConfigSelect,
    });
    if (!found) throw new BizException(BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND);
    return found;
  }

  // P2002 兜底 — DTO @MinLength + Service findUnique 预检查应已拦绝大多数,
  // 这层处理并发场景(两个 create 同时撞 code unique)。
  private async runCodeUniqueGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = (err.meta?.target as string[] | undefined) ?? [];
        if (target.includes('code')) {
          throw new BizException(BizCode.ATTACHMENT_TYPE_CONFIG_CODE_ALREADY_EXISTS);
        }
      }
      throw err;
    }
  }

  // code 格式校验(沿 RBAC permissions 范式):Service 层显式 regex 检查 + 抛 13023。
  // **不放在 DTO @Matches**:让本 BizCode 真正可触发并被 e2e 覆盖。
  private assertCodeFormatValid(code: string): void {
    if (!CODE_PATTERN.test(code)) {
      throw new BizException(BizCode.INVALID_ATTACHMENT_TYPE_CONFIG_CODE_FORMAT);
    }
  }

  // ============ 6 端点业务逻辑 ============

  async list(
    query: ListAttachmentTypeConfigsQueryDto,
  ): Promise<PageResultDto<AttachmentTypeConfigResponseDto>> {
    const { page, pageSize, status, ownerTable } = query;
    const where: Prisma.AttachmentTypeConfigWhereInput = notDeletedWhere({
      ...(status !== undefined ? { status } : {}),
      ...(ownerTable !== undefined ? { ownerTable } : {}),
    });

    const [items, total] = await this.prisma.$transaction([
      this.prisma.attachmentTypeConfig.findMany({
        where,
        select: attachmentTypeConfigSelect,
        // 默认排序:createdAt DESC(沿 baseline §3.2 + CLAUDE.md §4 分页默认)
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.attachmentTypeConfig.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async getById(id: string): Promise<AttachmentTypeConfigResponseDto> {
    return this.findActiveByIdOrThrow(id);
  }

  async create(
    dto: CreateAttachmentTypeConfigDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttachmentTypeConfigResponseDto> {
    // 1. 显式格式校验(13023;校验链留事务外)
    this.assertCodeFormatValid(dto.code);

    // 2. 预检查 code 唯一性(含软删历史;沿 CLAUDE.md §10 软删 unique 预检查铁律:
    //    软删后 code 不可复用;预检查必须用 findUnique 含全部记录,否则软删占用会通过预检查后撞 P2002)
    const existing = await this.prisma.attachmentTypeConfig.findUnique({
      where: { code: dto.code },
      select: { id: true },
    });
    if (existing) {
      throw new BizException(BizCode.ATTACHMENT_TYPE_CONFIG_CODE_ALREADY_EXISTS);
    }

    // 3. 同事务:写主表 + audit;P2002 兜底外层包(沿 PR #6d Q8 拍板)。
    //    P2002 失败 → 抛 BizException;事务自动回滚(write + audit 都不提交)。
    //    audit 失败 → 抛错;事务回滚;主表写入也不提交。
    return this.runCodeUniqueGuard(() =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.attachmentTypeConfig.create({
          data: {
            code: dto.code,
            displayName: dto.displayName,
            description: dto.description,
            ownerTable: dto.ownerTable,
            defaultMaxSizeBytes: dto.defaultMaxSizeBytes,
            // Q3 v1.0:未传默认 [];避免 Prisma 输入 undefined 导致字段缺失
            defaultMimeWhitelist: dto.defaultMimeWhitelist ?? [],
            // status default ACTIVE(由 Prisma schema 兜底;不在 dto 中接受;沿 Q5 v1.0)
          },
          select: attachmentTypeConfigSelect,
        });

        await this.auditLogs.log({
          event: 'attachment.config.change',
          actorUserId: currentUser.id,
          actorRoleSnap: currentUser.role,
          resourceType: AUDIT_RESOURCE_TYPE,
          resourceId: created.id,
          meta: auditMeta,
          after: this.toTypeConfigAuditSnapshot(created),
          extra: {
            configType: 'type',
            operation: 'create',
            code: created.code,
            ownerTable: created.ownerTable,
          },
          tx,
        });

        return created;
      }),
    );
  }

  async update(
    id: string,
    dto: UpdateAttachmentTypeConfigDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttachmentTypeConfigResponseDto> {
    // 1. 先确认活跃(不存在或已软删统一返 13020;校验链留事务外)
    const before = await this.findActiveByIdOrThrow(id);

    // 2. 事务内:更新 + audit(沿 D7 §7.2 同事务 fail-fast)
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.attachmentTypeConfig.update({
        where: { id },
        data: {
          displayName: dto.displayName,
          description: dto.description,
          ownerTable: dto.ownerTable,
          defaultMaxSizeBytes: dto.defaultMaxSizeBytes,
          defaultMimeWhitelist: dto.defaultMimeWhitelist,
        },
        select: attachmentTypeConfigSelect,
      });

      await this.auditLogs.log({
        event: 'attachment.config.change',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: updated.id,
        meta: auditMeta,
        before: this.toTypeConfigAuditSnapshot(before),
        after: this.toTypeConfigAuditSnapshot(updated),
        extra: {
          configType: 'type',
          operation: 'update',
          code: updated.code,
          ownerTable: updated.ownerTable,
        },
        tx,
      });

      return updated;
    });
  }

  async updateStatus(
    id: string,
    dto: UpdateAttachmentTypeConfigStatusDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttachmentTypeConfigResponseDto> {
    // 1. 先确认活跃(沿 dictionaries `PATCH /:id/status` 范式;校验链留事务外)
    const before = await this.findActiveByIdOrThrow(id);

    // 2. 事务内:改 status + audit
    //    PR #6d Q4 拍板:before/after 仅 status 字段(状态机审计范式;沿 cert.verify/reject)
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.attachmentTypeConfig.update({
        where: { id },
        data: { status: dto.status },
        select: attachmentTypeConfigSelect,
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
          configType: 'type',
          operation: 'update-status',
          code: updated.code,
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
  ): Promise<AttachmentTypeConfigResponseDto> {
    // 1. 先确认活跃(沿 RbacRole.softDelete 范式;沿 v1 §10 信息泄漏防御:
    //    第二次软删撞 findActiveByIdOrThrow,统一返 13020,不开 13024)
    const existing = await this.findActiveByIdOrThrow(id);

    // 2. 事务内:软删 + 同步置 INACTIVE + audit
    //    Q7 v1.0:本 PR 不查跨表引用;mime / size override 引用与 attachments 主表 ownerType
    //    引用的检查由后续 PR 触发时再加(13030 ATTACHMENT_TYPE_CONFIG_IN_USE 暂不实装)。
    //    PR #6d Q5:resourceId=existing.id(软删 id 不变;沿 cert/emergency softDelete 范式)
    await this.prisma.$transaction(async (tx) => {
      await tx.attachmentTypeConfig.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          status: AttachmentTypeConfigStatus.INACTIVE,
        },
      });

      await this.auditLogs.log({
        event: 'attachment.config.change',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: existing.id,
        meta: auditMeta,
        before: this.toTypeConfigAuditSnapshot(existing),
        extra: {
          configType: 'type',
          operation: 'delete',
          code: existing.code,
          ownerTable: existing.ownerTable,
        },
        tx,
      });
    });
    return existing;
  }
}
