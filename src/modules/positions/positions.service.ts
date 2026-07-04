import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import {
  CreatePositionDto,
  PositionOptionItemDto,
  PositionOptionsQueryDto,
  PositionOptionsResponseDto,
  PositionQueryDto,
  PositionResponseDto,
  UpdatePositionDto,
} from './positions.dto';
import { positionSafeSelect, type SafePosition } from './positions.select';

// 终态 scoped-authz PR3(2026-07-01;冻结稿 §3.2 / §7.2):职务定义(positions)管理面 service。
// 判权单轨 service 层 rbac.can(0 @Roles;沿 contribution-rules / memberships 范式)。配置面不落 audit
// (沿 dictionaries / memberships 配置面范式)。**本表纯配置定义,绝不被任何判权路径读**(AuthzService 是 PR8)。

@Injectable()
export class PositionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  private toResponseDto(row: SafePosition): PositionResponseDto {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      categoryCode: row.categoryCode,
      rank: row.rank,
      isLeadership: row.isLeadership,
      allowMultiple: row.allowMultiple,
      allowConcurrent: row.allowConcurrent,
      sortOrder: row.sortOrder,
      status: row.status,
      description: row.description,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ============ list ============

  async list(
    user: CurrentUserPayload,
    query: PositionQueryDto,
  ): Promise<PageResultDto<PositionResponseDto>> {
    await this.assertCanOrThrow(user, 'position.read.definition');
    const { page, pageSize, categoryCode, status } = query;
    const filters: Prisma.OrganizationPositionWhereInput = {};
    if (categoryCode !== undefined) filters.categoryCode = categoryCode;
    if (status !== undefined) filters.status = status;
    const where = notDeletedWhere(filters);

    const orderBy: Prisma.OrganizationPositionOrderByWithRelationInput[] = [
      { sortOrder: 'asc' },
      { rank: 'asc' },
      { createdAt: 'asc' },
    ];

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.organizationPosition.findMany({
        where,
        select: positionSafeSelect,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.organizationPosition.count({ where }),
    ]);

    return { items: rows.map((r) => this.toResponseDto(r)), total, page, pageSize };
  }

  // ============ F1/A5 选择器(路线图 §4;D2/D3 拍板)============

  // options = list 的轻量投影;复用 position.read.definition(D2,不新增权限码)。
  // 未抽 QueryService(架构映射 §7:options 是窄投影,内联主 service 即可)。
  async options(
    user: CurrentUserPayload,
    query: PositionOptionsQueryDto,
  ): Promise<PositionOptionsResponseDto> {
    await this.assertCanOrThrow(user, 'position.read.definition');
    const { categoryCode, status, q, limit } = query;
    const filters: Prisma.OrganizationPositionWhereInput = {};
    if (categoryCode !== undefined) filters.categoryCode = categoryCode;
    if (status !== undefined) filters.status = status;
    if (q !== undefined) {
      filters.name = { contains: q, mode: 'insensitive' };
    }
    const where = notDeletedWhere(filters);

    const rows = await this.prisma.organizationPosition.findMany({
      where,
      select: { id: true, name: true, categoryCode: true },
      orderBy: [{ sortOrder: 'asc' }, { rank: 'asc' }, { createdAt: 'asc' }],
      take: limit ?? 20,
    });

    const items: PositionOptionItemDto[] = rows.map((r) => ({
      id: r.id,
      label: r.name,
      categoryCode: r.categoryCode,
    }));
    return { items };
  }

  // ============ findOne ============

  async findOne(user: CurrentUserPayload, id: string): Promise<PositionResponseDto> {
    await this.assertCanOrThrow(user, 'position.read.definition');
    const row = await this.prisma.organizationPosition.findFirst({
      where: notDeletedWhere({ id }),
      select: positionSafeSelect,
    });
    if (!row) throw new BizException(BizCode.POSITION_NOT_FOUND);
    return this.toResponseDto(row);
  }

  // ============ create ============

  async create(user: CurrentUserPayload, dto: CreatePositionDto): Promise<PositionResponseDto> {
    await this.assertCanOrThrow(user, 'position.create.definition');
    // code @unique;含软删历史占用(沿 Organization.code 范式,软删行仍占 code)。P2002 → CODE_DUPLICATE。
    const data: Prisma.OrganizationPositionUncheckedCreateInput = {
      code: dto.code,
      name: dto.name,
      categoryCode: dto.categoryCode,
      rank: dto.rank, // undefined → 列默认 0
      isLeadership: dto.isLeadership, // undefined → 列默认 false
      allowMultiple: dto.allowMultiple, // undefined → 列默认 false
      allowConcurrent: dto.allowConcurrent, // undefined → 列默认 true
      sortOrder: dto.sortOrder, // undefined → 列默认 0
      status: dto.status, // undefined → 列默认 ACTIVE
      description: dto.description ?? null,
    };
    try {
      const created = await this.prisma.organizationPosition.create({
        data,
        select: positionSafeSelect,
      });
      return this.toResponseDto(created);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BizException(BizCode.POSITION_CODE_DUPLICATE);
      }
      throw err;
    }
  }

  // ============ update ============

  async update(
    user: CurrentUserPayload,
    id: string,
    dto: UpdatePositionDto,
  ): Promise<PositionResponseDto> {
    await this.assertCanOrThrow(user, 'position.update.definition');
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.organizationPosition.findFirst({
        where: notDeletedWhere({ id }),
        select: { id: true },
      });
      if (!existing) throw new BizException(BizCode.POSITION_NOT_FOUND);

      // 白名单不含 code → 无 @unique 字段可改 → 无 P2002 路径。
      const data: Prisma.OrganizationPositionUncheckedUpdateInput = {};
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.categoryCode !== undefined) data.categoryCode = dto.categoryCode;
      if (dto.rank !== undefined) data.rank = dto.rank;
      if (dto.isLeadership !== undefined) data.isLeadership = dto.isLeadership;
      if (dto.allowMultiple !== undefined) data.allowMultiple = dto.allowMultiple;
      if (dto.allowConcurrent !== undefined) data.allowConcurrent = dto.allowConcurrent;
      if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
      if (dto.status !== undefined) data.status = dto.status;
      if (dto.description !== undefined) data.description = dto.description;

      const updated = await tx.organizationPosition.update({
        where: { id },
        data,
        select: positionSafeSelect,
      });
      return this.toResponseDto(updated);
    });
  }

  // ============ softDelete ============

  // 删除守卫(冻结稿 §7.2;沿 ORGANIZATION_HAS_CHILDREN 范式):职务被任一未软删的职务规则引用时禁删。
  async softDelete(user: CurrentUserPayload, id: string): Promise<void> {
    await this.assertCanOrThrow(user, 'position.delete.definition');
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.organizationPosition.findFirst({
        where: notDeletedWhere({ id }),
        select: { id: true },
      });
      if (!existing) throw new BizException(BizCode.POSITION_NOT_FOUND);

      const ruleRefs = await tx.organizationPositionRule.count({
        where: { positionId: id, deletedAt: null },
      });
      if (ruleRefs > 0) throw new BizException(BizCode.POSITION_IN_USE);

      // schema §3.2 无 deletedByUserId 字段:软删仅写 deletedAt。
      await tx.organizationPosition.update({ where: { id }, data: { deletedAt: new Date() } });
    });
  }
}
