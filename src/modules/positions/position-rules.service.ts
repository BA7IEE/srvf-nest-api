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
// PositionAssignmentPolicy 在新任命时执行 ACTIVE rule 的上限/兼任/归属约束;
// required/minCount 无合规补位流程前仅 advisory。AuthzService 不直读本表。

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

  // required 是“建议至少 1 人”的简写，minCount 是更精确的建议下限；两者不得互相矛盾。
  // 下限当前只做配置一致性校验，不阻断撤销/offboard；maxCount 由任命 policy 硬执行。
  private assertCardinalityConfigValid(
    required: boolean,
    minCount: number | null,
    maxCount: number | null,
  ): void {
    const invalidNumber = (value: number | null): boolean =>
      value !== null && (!Number.isInteger(value) || value < 0);
    if (invalidNumber(minCount) || invalidNumber(maxCount)) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    if (minCount !== null) {
      if ((required && minCount < 1) || (!required && minCount > 0)) {
        throw new BizException(BizCode.BAD_REQUEST);
      }
    }
    const effectiveMin = minCount ?? (required ? 1 : 0);
    if (maxCount !== null && effectiveMin > maxCount) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
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

      const required = dto.required ?? false;
      const minCount = dto.minCount ?? null;
      const maxCount = dto.maxCount ?? null;
      this.assertCardinalityConfigValid(required, minCount, maxCount);

      const data: Prisma.OrganizationPositionRuleUncheckedCreateInput = {
        nodeTypeCode: dto.nodeTypeCode,
        positionId: dto.positionId,
        required,
        minCount,
        maxCount,
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
      // 先锁行再合并局部 DTO,防止两个并发 PATCH 各自用旧值校验通过,
      // 最终却组合成 required/min/max 非法状态。
      const locked = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          SELECT "id"
          FROM "organization_position_rules"
          WHERE "id" = ${id} AND "deletedAt" IS NULL
          FOR UPDATE
        `,
      );
      if (locked.length === 0) throw new BizException(BizCode.POSITION_RULE_NOT_FOUND);
      const existing = await tx.organizationPositionRule.findFirst({
        where: notDeletedWhere({ id }),
        select: { id: true, required: true, minCount: true, maxCount: true },
      });
      if (!existing) throw new BizException(BizCode.POSITION_RULE_NOT_FOUND);

      const required = dto.required ?? existing.required;
      const minCount = dto.minCount !== undefined ? dto.minCount : existing.minCount;
      const maxCount = dto.maxCount !== undefined ? dto.maxCount : existing.maxCount;
      this.assertCardinalityConfigValid(required, minCount, maxCount);

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

  // 软删仅写 deletedAt(schema §3.3 无 deletedByUserId);新任命随即失去 ACTIVE 匹配而被拒绝,
  // 不追溯撤销已有 assignment。
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
