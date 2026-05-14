import { Injectable } from '@nestjs/common';
import { AttachmentTypeConfigStatus, Prisma } from '@prisma/client';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import {
  AttachmentTypeConfigResponseDto,
  CreateAttachmentTypeConfigDto,
  ListAttachmentTypeConfigsQueryDto,
  UpdateAttachmentTypeConfigDto,
  UpdateAttachmentTypeConfigStatusDto,
} from './attachment-type-configs.dto';
import { attachmentTypeConfigSelect } from './attachment-type-configs.select';

// V2.x C-7 attachments 实施 PR #3(2026-05-15):AttachmentTypeConfig 业务逻辑。
// 沿 D7 v1.0 §4.2 / §16 决议表 + 用户 Step 1 拍板 Q1-Q7。
//
// **code 格式正则**(沿 RbacRole.code 范式;Q3 候选 A;kebab-case 业务标识 3-32):
// - 首字母小写,后续允许 [a-z0-9-];总长 3-32
// - 失败抛 BizException(BizCode.INVALID_ATTACHMENT_TYPE_CONFIG_CODE_FORMAT)(13023)
const CODE_PATTERN = /^[a-z][a-z0-9-]{2,32}$/;

type SafeTypeConfig = Prisma.AttachmentTypeConfigGetPayload<{
  select: typeof attachmentTypeConfigSelect;
}>;

@Injectable()
export class AttachmentTypeConfigsService {
  constructor(private readonly prisma: PrismaService) {}

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

  async create(dto: CreateAttachmentTypeConfigDto): Promise<AttachmentTypeConfigResponseDto> {
    // 1. 显式格式校验(13023)
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

    // 3. 写入(P2002 兜底处理并发)
    return this.runCodeUniqueGuard(() =>
      this.prisma.attachmentTypeConfig.create({
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
      }),
    );
  }

  async update(
    id: string,
    dto: UpdateAttachmentTypeConfigDto,
  ): Promise<AttachmentTypeConfigResponseDto> {
    // 1. 先确认活跃(不存在或已软删统一返 13020)
    await this.findActiveByIdOrThrow(id);

    // 2. 更新(DTO 层已白名单 displayName / description / ownerTable / defaultMaxSizeBytes /
    //    defaultMimeWhitelist;ValidationPipe forbidNonWhitelisted 兜底拦截 code / status / id 等)
    return this.prisma.attachmentTypeConfig.update({
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
  }

  async updateStatus(
    id: string,
    dto: UpdateAttachmentTypeConfigStatusDto,
  ): Promise<AttachmentTypeConfigResponseDto> {
    // 1. 先确认活跃(沿 dictionaries `PATCH /:id/status` 范式)
    await this.findActiveByIdOrThrow(id);

    // 2. 仅改 status 字段
    return this.prisma.attachmentTypeConfig.update({
      where: { id },
      data: { status: dto.status },
      select: attachmentTypeConfigSelect,
    });
  }

  async softDelete(id: string): Promise<AttachmentTypeConfigResponseDto> {
    // 1. 先确认活跃(沿 RbacRole.softDelete 范式;沿 v1 §10 信息泄漏防御:
    //    第二次软删撞 findActiveByIdOrThrow,统一返 13020,不开 13024)
    const existing = await this.findActiveByIdOrThrow(id);

    // 2. 软删 + 同步置 INACTIVE(沿 dictionaries 软删双置;避免"软删但 status=ACTIVE"语义不一致)
    //    Q7 v1.0:本 PR 不查跨表引用;mime / size override 引用与 attachments 主表 ownerType
    //    引用的检查由后续 PR 触发时再加(13030 ATTACHMENT_TYPE_CONFIG_IN_USE 暂不实装)。
    await this.prisma.attachmentTypeConfig.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        status: AttachmentTypeConfigStatus.INACTIVE,
      },
    });
    return existing;
  }
}
