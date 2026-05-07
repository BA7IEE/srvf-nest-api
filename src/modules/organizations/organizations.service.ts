import { Injectable } from '@nestjs/common';
import { DictItemStatus, DictTypeStatus, OrganizationStatus, Prisma } from '@prisma/client';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import {
  CreateOrganizationDto,
  ListOrganizationsQueryDto,
  OrganizationResponseDto,
  OrganizationTreeNodeDto,
  OrganizationTreeQueryDto,
  UpdateOrganizationDto,
  UpdateOrganizationStatusDto,
} from './organizations.dto';

// 节点类别 dict_type code(seed neutral-demo 实际值;详见 prisma/seed.ts V2_DICT_SEED)。
// 模块内常量化:Step 5 members 自有 'member_grade';如未来需要跨模块复用再抽 common。
const NODE_TYPE_DICT_CODE = 'node_type';

// 集中定义对外 select。永不包含 deletedAt(软删除内部状态)。
const organizationSelect = {
  id: true,
  name: true,
  parentId: true,
  nodeTypeCode: true,
  sortOrder: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.OrganizationSelect;

type SafeOrganization = Prisma.OrganizationGetPayload<{ select: typeof organizationSelect }>;
type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  // ============ helpers ============

  private async findOrganizationOrThrow(id: string, tx?: PrismaTx): Promise<SafeOrganization> {
    const client = tx ?? this.prisma;
    const found = await client.organization.findFirst({
      where: notDeletedWhere({ id }),
      select: organizationSelect,
    });
    if (!found) throw new BizException(BizCode.ORGANIZATION_NOT_FOUND);
    return found;
  }

  // nodeTypeCode 校验:6 项 AND 检查(对应 docs/v2-data-model.md §4.5):
  //   dict_type.code = NODE_TYPE_DICT_CODE
  //   dict_type.status = ACTIVE
  //   dict_type.deletedAt = null
  //   dict_item.code = nodeTypeCode
  //   dict_item.status = ACTIVE
  //   dict_item.deletedAt = null
  // 通过 Prisma N:1 关系 filter 一次查询完成。
  private async assertNodeTypeCodeValid(nodeTypeCode: string, tx?: PrismaTx): Promise<void> {
    const client = tx ?? this.prisma;
    const item = await client.dictItem.findFirst({
      where: {
        code: nodeTypeCode,
        status: DictItemStatus.ACTIVE,
        deletedAt: null,
        type: {
          code: NODE_TYPE_DICT_CODE,
          status: DictTypeStatus.ACTIVE,
          deletedAt: null,
        },
      },
      select: { id: true },
    });
    if (!item) throw new BizException(BizCode.ORGANIZATION_NODE_TYPE_INVALID);
  }

  // 单根上限(决策 3 修订):创建根节点(parentId=null)前检查 parentId IS NULL +
  // deletedAt IS NULL 的记录数。**不区分 status**:停用根仍占位,新建第二个根直接拒绝。
  // 想替换根节点必须先软删旧根(但旧根的 last-root 保护可能拦下,需运营按"先建临时
  // 子节点 → 业务上让 last-root 不再唯一" 这类高风险操作进行,V2.x 评估 batch 重构能力)。
  private async assertNoExistingRoot(tx: PrismaTx): Promise<void> {
    const count = await tx.organization.count({
      where: { parentId: null, deletedAt: null },
    });
    if (count > 0) throw new BizException(BizCode.ORGANIZATION_ROOT_ALREADY_EXISTS);
  }

  // last-root 下限:删/停根节点时,排除目标后剩余 ACTIVE 根 ≥ 1。
  // 对应 docs/v2-api-contract.md §3.5 LAST_ROOT_ORGANIZATION_PROTECTED。
  private async assertNotLastActiveRoot(tx: PrismaTx, idAffected: string): Promise<void> {
    const remaining = await tx.organization.count({
      where: {
        parentId: null,
        deletedAt: null,
        status: OrganizationStatus.ACTIVE,
        id: { not: idAffected },
      },
    });
    if (remaining === 0) {
      throw new BizException(BizCode.LAST_ROOT_ORGANIZATION_PROTECTED);
    }
  }

  // ============ list ============

  async list(query: ListOrganizationsQueryDto): Promise<PageResultDto<OrganizationResponseDto>> {
    const { page, pageSize, parentId, nodeTypeCode, status } = query;

    const filters: Prisma.OrganizationWhereInput = {};
    if (parentId !== undefined) {
      // 字面值 'null' → parentId IS NULL(根节点过滤)
      filters.parentId = parentId === 'null' ? null : parentId;
    }
    if (nodeTypeCode !== undefined) filters.nodeTypeCode = nodeTypeCode;
    if (status !== undefined) filters.status = status;

    const where = notDeletedWhere(filters);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.organization.findMany({
        where,
        select: organizationSelect,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.organization.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  // ============ tree ============

  async getTree(query: OrganizationTreeQueryDto): Promise<OrganizationTreeNodeDto[]> {
    const items = await this.prisma.organization.findMany({
      where: notDeletedWhere(query.status !== undefined ? { status: query.status } : {}),
      select: organizationSelect,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });

    // 内存拼父子树(沿用 dictionaries getDictItemTree 算法):
    // 单次 findMany + O(N) map + O(N) 二次扫描;无 N+1。决策 4:深度无限制。
    const byId = new Map<string, OrganizationTreeNodeDto>();
    for (const item of items) {
      byId.set(item.id, { ...item, children: [] });
    }

    const roots: OrganizationTreeNodeDto[] = [];
    for (const node of byId.values()) {
      if (node.parentId === null) {
        roots.push(node);
      } else {
        const parent = byId.get(node.parentId);
        if (parent) {
          parent.children.push(node);
        } else {
          // parent 不在结果集(被 status 过滤排除)→ 作为孤立根输出
          roots.push(node);
        }
      }
    }
    return roots;
  }

  // ============ create ============

  async create(dto: CreateOrganizationDto): Promise<OrganizationResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      // 1. nodeTypeCode 必须有效(6 项 AND 校验)
      await this.assertNodeTypeCodeValid(dto.nodeTypeCode, tx);

      // 2. parentId 校验:存在 + 未软删(允许在 INACTIVE 父下建子,与 v2-data-model §4.6 一致)
      if (dto.parentId !== undefined) {
        const parent = await tx.organization.findFirst({
          where: notDeletedWhere({ id: dto.parentId }),
          select: { id: true },
        });
        if (!parent) throw new BizException(BizCode.ORGANIZATION_PARENT_NOT_FOUND);
      } else {
        // 创建根 → 单根上限检查
        await this.assertNoExistingRoot(tx);
      }

      return tx.organization.create({
        data: {
          name: dto.name,
          parentId: dto.parentId,
          nodeTypeCode: dto.nodeTypeCode,
          sortOrder: dto.sortOrder ?? 0,
        },
        select: organizationSelect,
      });
    });
  }

  // ============ findOne ============

  findOne(id: string): Promise<OrganizationResponseDto> {
    return this.findOrganizationOrThrow(id);
  }

  // ============ update ============

  async update(id: string, dto: UpdateOrganizationDto): Promise<OrganizationResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      await this.findOrganizationOrThrow(id, tx);

      if (dto.nodeTypeCode !== undefined) {
        await this.assertNodeTypeCodeValid(dto.nodeTypeCode, tx);
      }

      const data: Prisma.OrganizationUpdateInput = {};
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
      if (dto.nodeTypeCode !== undefined) data.nodeTypeCode = dto.nodeTypeCode;

      return tx.organization.update({
        where: { id },
        data,
        select: organizationSelect,
      });
    });
  }

  // ============ updateStatus ============

  async updateStatus(
    id: string,
    dto: UpdateOrganizationStatusDto,
  ): Promise<OrganizationResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const target = await this.findOrganizationOrThrow(id, tx);

      // last-root 保护:目标是根节点 + 改成 INACTIVE
      if (target.parentId === null && dto.status === OrganizationStatus.INACTIVE) {
        await this.assertNotLastActiveRoot(tx, id);
      }

      return tx.organization.update({
        where: { id },
        data: { status: dto.status },
        select: organizationSelect,
      });
    });
  }

  // ============ softDelete ============

  // 决策 5:事务原子。决策 3=A:同时查 dict 范围外的 member_departments(Step 6 落地后无需补)。
  async softDelete(id: string): Promise<OrganizationResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const target = await this.findOrganizationOrThrow(id, tx);

      const [childCount, memberCount] = await Promise.all([
        tx.organization.count({ where: { parentId: id, deletedAt: null } }),
        tx.memberDepartment.count({ where: { organizationId: id, deletedAt: null } }),
      ]);
      if (childCount > 0) throw new BizException(BizCode.ORGANIZATION_HAS_CHILDREN);
      if (memberCount > 0) throw new BizException(BizCode.ORGANIZATION_HAS_MEMBERS);

      // last-root 保护:目标是根节点
      if (target.parentId === null) {
        await this.assertNotLastActiveRoot(tx, id);
      }

      return tx.organization.update({
        where: { id },
        data: { deletedAt: new Date(), status: OrganizationStatus.INACTIVE },
        select: organizationSelect,
      });
    });
  }
}
