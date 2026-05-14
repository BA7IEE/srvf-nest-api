import { Injectable } from '@nestjs/common';
import { AttachmentMimeConfigStatus, Prisma } from '@prisma/client';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import {
  AttachmentMimeConfigResponseDto,
  CreateAttachmentMimeConfigDto,
  ListAttachmentMimeConfigsQueryDto,
  UpdateAttachmentMimeConfigDto,
  UpdateAttachmentMimeConfigStatusDto,
} from './attachment-mime-configs.dto';
import { attachmentMimeConfigSelect } from './attachment-mime-configs.select';

// V2.x C-7 attachments 实施 PR #4(2026-05-15):AttachmentMimeConfig 业务逻辑。
// 沿 D7 v1.0 §4.3 + 用户 Step 1 拍板 Q1-Q8 + PR #3 AttachmentTypeConfigsService 范式。
//
// **MIME 格式正则**(Q1 v1.0;Service 层显式校验):
// - 形如 `type/subtype` 或 `type/*` wildcard
// - 主类型:首字母小写,后续 [a-z0-9-]
// - 子类型:[a-z0-9.+-]+ 或 `*`(wildcard)
// - 允许 `image/jpeg` / `image/png` / `application/pdf` / `image/*` / `video/*` 等
// - 失败抛 BizException(BizCode.INVALID_ATTACHMENT_MIME_FORMAT)(13025)
const MIME_PATTERN = /^[a-z][a-z0-9-]*\/(\*|[a-z0-9.+-]+)$/;

type SafeMimeConfig = Prisma.AttachmentMimeConfigGetPayload<{
  select: typeof attachmentMimeConfigSelect;
}>;

@Injectable()
export class AttachmentMimeConfigsService {
  constructor(private readonly prisma: PrismaService) {}

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

  async create(dto: CreateAttachmentMimeConfigDto): Promise<AttachmentMimeConfigResponseDto> {
    // 1. typeConfigId FK 真实性校验(Q5 v1.0:不存在或软删 → 13020)
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

    // 4. 写入(P2002 兜底处理并发)
    return this.runDuplicateGuard(() =>
      this.prisma.attachmentMimeConfig.create({
        data: {
          typeConfigId: dto.typeConfigId,
          mime: dto.mime,
          remark: dto.remark,
          // status default ACTIVE(由 Prisma schema 兜底;沿 Q5 v1.0 type config 范式)
        },
        select: attachmentMimeConfigSelect,
      }),
    );
  }

  async update(
    id: string,
    dto: UpdateAttachmentMimeConfigDto,
  ): Promise<AttachmentMimeConfigResponseDto> {
    // 1. 先确认活跃(不存在或已软删统一返 13022)
    await this.findActiveByIdOrThrow(id);

    // 2. 仅更新 remark(Q3 / Q4 v1.0:mime / typeConfigId 不可改;
    //    DTO 已白名单;ValidationPipe forbidNonWhitelisted 兜底其他字段)
    return this.prisma.attachmentMimeConfig.update({
      where: { id },
      data: { remark: dto.remark },
      select: attachmentMimeConfigSelect,
    });
  }

  async updateStatus(
    id: string,
    dto: UpdateAttachmentMimeConfigStatusDto,
  ): Promise<AttachmentMimeConfigResponseDto> {
    // 1. 先确认活跃(沿 PR #3 type config status 范式)
    await this.findActiveByIdOrThrow(id);

    // 2. 仅改 status
    return this.prisma.attachmentMimeConfig.update({
      where: { id },
      data: { status: dto.status },
      select: attachmentMimeConfigSelect,
    });
  }

  async softDelete(id: string): Promise<AttachmentMimeConfigResponseDto> {
    // 1. 先确认活跃(沿 PR #3 type config softDelete 范式;沿 v1 §10 信息泄漏防御)
    const existing = await this.findActiveByIdOrThrow(id);

    // 2. 软删 + 同步置 INACTIVE(沿 PR #3 dictionaries 双置范式)
    //    Q6 v1.0:本 PR 不查 attachments 主表跨表引用;留主模块 PR 触发时再加 IN_USE 检查
    await this.prisma.attachmentMimeConfig.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        status: AttachmentMimeConfigStatus.INACTIVE,
      },
    });
    return existing;
  }
}
