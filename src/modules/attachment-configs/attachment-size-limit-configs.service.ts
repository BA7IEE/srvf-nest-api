import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import {
  AttachmentSizeLimitConfigResponseDto,
  CreateAttachmentSizeLimitConfigDto,
  ListAttachmentSizeLimitConfigsQueryDto,
  UpdateAttachmentSizeLimitConfigDto,
} from './attachment-size-limit-configs.dto';
import { attachmentSizeLimitConfigSelect } from './attachment-size-limit-configs.select';

// V2.x C-7 attachments 实施 PR #5(2026-05-15):AttachmentSizeLimitConfig 业务逻辑。
// 沿 D7 v1.0 §4.4 + 用户 Step 1 拍板 Q1-Q8 + PR #3 / PR #4 范式。
//
// **关键差异**(沿 D7 v1.0 §4.4 schema 现状):
// - **本表无 status 字段**(Q1 v1.0:不加)→ 5 端点(无 status 端点);软删只置 deletedAt = now()
// - 1:1 关系:typeConfigId UNIQUE(每 type 至多一条 override)
// - 无 mime 格式校验(本表只存 size 数值);DTO @Min/@Max 兜底 1 ~ 10 GiB

type SafeSizeLimitConfig = Prisma.AttachmentSizeLimitConfigGetPayload<{
  select: typeof attachmentSizeLimitConfigSelect;
}>;

@Injectable()
export class AttachmentSizeLimitConfigsService {
  constructor(private readonly prisma: PrismaService) {}

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
    query: ListAttachmentSizeLimitConfigsQueryDto,
  ): Promise<PageResultDto<AttachmentSizeLimitConfigResponseDto>> {
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

  async getById(id: string): Promise<AttachmentSizeLimitConfigResponseDto> {
    return this.findActiveByIdOrThrow(id);
  }

  async create(
    dto: CreateAttachmentSizeLimitConfigDto,
  ): Promise<AttachmentSizeLimitConfigResponseDto> {
    // 1. typeConfigId FK 真实性校验(Q5 PR #4 复用:不存在或软删 → 13020)
    await this.assertTypeConfigActive(dto.typeConfigId);

    // 2. typeConfigId 1:1 UNIQUE 预检查(含软删历史;Q3 v1.0:软删后不可复用;沿 CLAUDE.md §10)
    const existing = await this.prisma.attachmentSizeLimitConfig.findUnique({
      where: { typeConfigId: dto.typeConfigId },
      select: { id: true },
    });
    if (existing) {
      throw new BizException(BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_ALREADY_EXISTS);
    }

    // 3. 写入(P2002 兜底处理并发)
    return this.runUniqueGuard(() =>
      this.prisma.attachmentSizeLimitConfig.create({
        data: {
          typeConfigId: dto.typeConfigId,
          maxSizeBytes: dto.maxSizeBytes,
          remark: dto.remark,
          // 本表无 status 字段(Q1 v1.0);Prisma schema 无此列
        },
        select: attachmentSizeLimitConfigSelect,
      }),
    );
  }

  async update(
    id: string,
    dto: UpdateAttachmentSizeLimitConfigDto,
  ): Promise<AttachmentSizeLimitConfigResponseDto> {
    // 1. 先确认活跃(不存在或已软删统一返 13026)
    await this.findActiveByIdOrThrow(id);

    // 2. Q5 v1.0 显式拒绝 maxSizeBytes = null(class-validator @IsOptional 不拒 null;
    //    Prisma 收到 null 撞 NOT NULL 约束会走 500;在 service 入口提前拒)
    //    清除 size limit 的语义是 DELETE 这条配置,而不是 PATCH null。
    if (dto.maxSizeBytes === null) {
      throw new BizException(BizCode.BAD_REQUEST);
    }

    // 3. 仅更新 maxSizeBytes / remark
    //    Q4 PR #4 范式:typeConfigId 不可改(DTO 已白名单);
    //    forbidNonWhitelisted 兜底其他字段(包括不存在的 status)
    return this.prisma.attachmentSizeLimitConfig.update({
      where: { id },
      data: {
        maxSizeBytes: dto.maxSizeBytes,
        remark: dto.remark,
      },
      select: attachmentSizeLimitConfigSelect,
    });
  }

  async softDelete(id: string): Promise<AttachmentSizeLimitConfigResponseDto> {
    // 1. 先确认活跃(沿 PR #4 mime softDelete 范式;沿 v1 §10 信息泄漏防御)
    const existing = await this.findActiveByIdOrThrow(id);

    // 2. 软删(Q7 v1.0:本表无 status 字段,只置 deletedAt = now();不同步置任何其他字段)
    //    Q2 v1.0:本 PR 不查 attachments 主表跨表引用;留主模块 PR 触发时再加 IN_USE 检查
    await this.prisma.attachmentSizeLimitConfig.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return existing;
  }
}
