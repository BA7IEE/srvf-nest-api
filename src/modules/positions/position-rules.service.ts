import { Injectable } from '@nestjs/common';
import { DictItemStatus, DictTypeStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import {
  CreatePositionRuleDto,
  PositionRuleQueryDto,
  PositionRuleResponseDto,
  UpdatePositionRuleDto,
} from './position-rules.dto';
import { positionRuleSafeSelect, type SafePositionRule } from './position-rules.select';

// 终态 scoped-authz PR3(2026-07-01;冻结稿 §3.3 / §7.2):职务规则(position-rules)管理面 service。
// 判权单轨 service 层 rbac.can(0 @Roles;沿 contribution-rules / positions 范式)。配置面不落 audit。
// nodeTypeCode 校验 node_type 字典项有效(沿 contribution-rules assertDictItemValid 范式);positionId 校验职务存在。
// **本表纯配置定义,绝不被任何判权路径读**(AuthzService 是 PR8)。

const DICT_TYPE_NODE_TYPE = 'node_type';

type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class PositionRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  // nodeTypeCode 必须为 ACTIVE 的 node_type 字典项(沿 contribution-rules assertDictItemValid 范式)。
  private async assertNodeTypeValid(nodeTypeCode: string, tx?: PrismaTx): Promise<void> {
    const client = tx ?? this.prisma;
    const item = await client.dictItem.findFirst({
      where: {
        code: nodeTypeCode,
        status: DictItemStatus.ACTIVE,
        deletedAt: null,
        type: { code: DICT_TYPE_NODE_TYPE, status: DictTypeStatus.ACTIVE, deletedAt: null },
      },
      select: { id: true },
    });
    if (!item) throw new BizException(BizCode.POSITION_RULE_NODE_TYPE_INVALID);
  }

  // positionId 必须指向未软删的职务定义(不存在 → 复用 POSITION_NOT_FOUND)。
  private async assertPositionExists(positionId: string, tx?: PrismaTx): Promise<void> {
    const client = tx ?? this.prisma;
    const position = await client.organizationPosition.findFirst({
      where: notDeletedWhere({ id: positionId }),
      select: { id: true },
    });
    if (!position) throw new BizException(BizCode.POSITION_NOT_FOUND);
  }

  private toResponseDto(row: SafePositionRule): PositionRuleResponseDto {
    return {
      id: row.id,
      nodeTypeCode: row.nodeTypeCode,
      positionId: row.positionId,
      required: row.required,
      minCount: row.minCount,
      maxCount: row.maxCount,
      requireMembership: row.requireMembership,
      allowConcurrent: row.allowConcurrent,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ============ list ============

  async list(
    user: CurrentUserPayload,
    query: PositionRuleQueryDto,
  ): Promise<PageResultDto<PositionRuleResponseDto>> {
    await this.assertCanOrThrow(user, 'position-rule.read.record');
    const { page, pageSize, nodeTypeCode, positionId, status } = query;
    const filters: Prisma.OrganizationPositionRuleWhereInput = {};
    if (nodeTypeCode !== undefined) filters.nodeTypeCode = nodeTypeCode;
    if (positionId !== undefined) filters.positionId = positionId;
    if (status !== undefined) filters.status = status;
    const where = notDeletedWhere(filters);

    const orderBy: Prisma.OrganizationPositionRuleOrderByWithRelationInput[] = [
      { nodeTypeCode: 'asc' },
      { createdAt: 'asc' },
    ];

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.organizationPositionRule.findMany({
        where,
        select: positionRuleSafeSelect,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.organizationPositionRule.count({ where }),
    ]);

    return { items: rows.map((r) => this.toResponseDto(r)), total, page, pageSize };
  }

  // ============ create ============

  async create(
    user: CurrentUserPayload,
    dto: CreatePositionRuleDto,
  ): Promise<PositionRuleResponseDto> {
    await this.assertCanOrThrow(user, 'position-rule.create.record');
    return this.prisma.$transaction(async (tx) => {
      await this.assertNodeTypeValid(dto.nodeTypeCode, tx);
      await this.assertPositionExists(dto.positionId, tx);

      const data: Prisma.OrganizationPositionRuleUncheckedCreateInput = {
        nodeTypeCode: dto.nodeTypeCode,
        positionId: dto.positionId,
        required: dto.required, // undefined → 列默认 false
        minCount: dto.minCount ?? null,
        maxCount: dto.maxCount ?? null,
        requireMembership: dto.requireMembership, // undefined → 列默认 true
        allowConcurrent: dto.allowConcurrent, // undefined → 列默认 true
        status: dto.status, // undefined → 列默认 ACTIVE
      };
      try {
        const created = await tx.organizationPositionRule.create({
          data,
          select: positionRuleSafeSelect,
        });
        return this.toResponseDto(created);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          // @@unique([nodeTypeCode, positionId]) 撞(含软删历史占用)→ ALREADY_EXISTS。
          throw new BizException(BizCode.POSITION_RULE_ALREADY_EXISTS);
        }
        throw err;
      }
    });
  }

  // ============ update ============

  async update(
    user: CurrentUserPayload,
    id: string,
    dto: UpdatePositionRuleDto,
  ): Promise<PositionRuleResponseDto> {
    await this.assertCanOrThrow(user, 'position-rule.update.record');
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.organizationPositionRule.findFirst({
        where: notDeletedWhere({ id }),
        select: { id: true },
      });
      if (!existing) throw new BizException(BizCode.POSITION_RULE_NOT_FOUND);

      // 白名单不含 nodeTypeCode / positionId → 唯一键不可改 → 无 P2002 路径。
      const data: Prisma.OrganizationPositionRuleUncheckedUpdateInput = {};
      if (dto.required !== undefined) data.required = dto.required;
      if (dto.minCount !== undefined) data.minCount = dto.minCount;
      if (dto.maxCount !== undefined) data.maxCount = dto.maxCount;
      if (dto.requireMembership !== undefined) data.requireMembership = dto.requireMembership;
      if (dto.allowConcurrent !== undefined) data.allowConcurrent = dto.allowConcurrent;
      if (dto.status !== undefined) data.status = dto.status;

      const updated = await tx.organizationPositionRule.update({
        where: { id },
        data,
        select: positionRuleSafeSelect,
      });
      return this.toResponseDto(updated);
    });
  }

  // ============ softDelete ============

  // 职务规则本刀不被任何东西引用(assignment=PR4),软删仅写 deletedAt(schema §3.3 无 deletedByUserId)。
  async softDelete(user: CurrentUserPayload, id: string): Promise<void> {
    await this.assertCanOrThrow(user, 'position-rule.delete.record');
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.organizationPositionRule.findFirst({
        where: notDeletedWhere({ id }),
        select: { id: true },
      });
      if (!existing) throw new BizException(BizCode.POSITION_RULE_NOT_FOUND);
      await tx.organizationPositionRule.update({ where: { id }, data: { deletedAt: new Date() } });
    });
  }
}
