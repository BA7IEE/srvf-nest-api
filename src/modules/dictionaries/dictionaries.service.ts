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
  CreateDictItemDto,
  CreateDictTypeDto,
  DictItemResponseDto,
  DictItemTreeNodeDto,
  DictTypeResponseDto,
  ListDictItemsQueryDto,
  ListDictTypesQueryDto,
  UpdateDictItemDto,
  UpdateDictItemStatusDto,
  UpdateDictTypeDto,
  UpdateDictTypeStatusDto,
} from './dictionaries.dto';

// 集中定义对外 select。详见 ARCHITECTURE.md §7.9 / docs/v2-data-model.md §2-§3。
// 任何对外返回必须使用以下两个常量,禁止散写不同 select。
// 永不包含 deletedAt(软删除内部状态;查询接口已通过 notDeletedWhere 过滤)。
const dictTypeSelect = {
  id: true,
  code: true,
  label: true,
  status: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.DictTypeSelect;

const dictItemSelect = {
  id: true,
  typeId: true,
  code: true,
  label: true,
  parentId: true,
  sortOrder: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.DictItemSelect;

type SafeDictType = Prisma.DictTypeGetPayload<{ select: typeof dictTypeSelect }>;
type SafeDictItem = Prisma.DictItemGetPayload<{ select: typeof dictItemSelect }>;
type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class DictionariesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  // ============ helpers ============

  // P0-F PR-2A(2026-05-18):RBAC 判权(沿 PR-1 attachments F5 v1.0 范本)。
  // 失败统一抛 BizException(BizCode.RBAC_FORBIDDEN)(30100);RbacService.can 内部
  // 已实现 SUPER_ADMIN 短路 + cache + ownership(.self);本模块无 .self 后缀。
  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  // 业务详情查询:findFirst + notDeletedWhere(softDelete.util.ts);找不到 / 已软删
  // 统一抛 NOT_FOUND。tx 可选,事务内调用方可传入 tx。
  private async findDictTypeOrThrow(id: string, tx?: PrismaTx): Promise<SafeDictType> {
    const client = tx ?? this.prisma;
    const found = await client.dictType.findFirst({
      where: notDeletedWhere({ id }),
      select: dictTypeSelect,
    });
    if (!found) throw new BizException(BizCode.DICT_TYPE_NOT_FOUND);
    return found;
  }

  private async findDictItemOrThrow(id: string, tx?: PrismaTx): Promise<SafeDictItem> {
    const client = tx ?? this.prisma;
    const found = await client.dictItem.findFirst({
      where: notDeletedWhere({ id }),
      select: dictItemSelect,
    });
    if (!found) throw new BizException(BizCode.DICT_ITEM_NOT_FOUND);
    return found;
  }

  // P2002 兜底 — 预检查应该已经拦住绝大多数,这层处理并发场景。
  // dict_type.code 唯一索引;dict_item @@unique([typeId, code])。
  private async runDictTypeUniqueGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = (err.meta?.target as string[] | undefined) ?? [];
        if (target.includes('code')) {
          throw new BizException(BizCode.DICT_TYPE_CODE_ALREADY_EXISTS);
        }
      }
      throw err;
    }
  }

  private async runDictItemUniqueGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = (err.meta?.target as string[] | undefined) ?? [];
        if (target.includes('typeId') && target.includes('code')) {
          throw new BizException(BizCode.DICT_ITEM_CODE_ALREADY_EXISTS);
        }
      }
      throw err;
    }
  }

  // ============ dict_types ============

  async listDictTypes(
    user: CurrentUserPayload,
    query: ListDictTypesQueryDto,
  ): Promise<PageResultDto<DictTypeResponseDto>> {
    await this.assertCanOrThrow(user, 'dict.read.type');
    const { page, pageSize, status } = query;
    const where: Prisma.DictTypeWhereInput = notDeletedWhere(
      status !== undefined ? { status } : {},
    );

    const [items, total] = await this.prisma.$transaction([
      this.prisma.dictType.findMany({
        where,
        select: dictTypeSelect,
        // 排序:sortOrder ASC, createdAt DESC(对齐 baseline §8.5)
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.dictType.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async createDictType(
    user: CurrentUserPayload,
    dto: CreateDictTypeDto,
  ): Promise<DictTypeResponseDto> {
    await this.assertCanOrThrow(user, 'dict.create.type');
    // 唯一性预检查(包含软删):findUnique;沿用 v1 §10 / baseline §10。
    // dict_type.code 是普通 @unique(全表唯一不复用,与 memberNo 同语义),
    // 软删后 code 仍占位,新建撞 code 直接拒绝。
    const existing = await this.prisma.dictType.findUnique({
      where: { code: dto.code },
      select: { id: true },
    });
    if (existing) throw new BizException(BizCode.DICT_TYPE_CODE_ALREADY_EXISTS);

    return this.runDictTypeUniqueGuard(() =>
      this.prisma.dictType.create({
        data: {
          code: dto.code,
          label: dto.label,
          sortOrder: dto.sortOrder ?? 0,
        },
        select: dictTypeSelect,
      }),
    );
  }

  async findDictTypeById(user: CurrentUserPayload, id: string): Promise<DictTypeResponseDto> {
    await this.assertCanOrThrow(user, 'dict.read.type');
    return this.findDictTypeOrThrow(id);
  }

  async updateDictType(
    user: CurrentUserPayload,
    id: string,
    dto: UpdateDictTypeDto,
  ): Promise<DictTypeResponseDto> {
    await this.assertCanOrThrow(user, 'dict.update.type');
    await this.findDictTypeOrThrow(id);

    const data: Prisma.DictTypeUpdateInput = {};
    if (dto.label !== undefined) data.label = dto.label;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

    return this.prisma.dictType.update({
      where: { id },
      data,
      select: dictTypeSelect,
    });
  }

  async updateDictTypeStatus(
    user: CurrentUserPayload,
    id: string,
    dto: UpdateDictTypeStatusDto,
  ): Promise<DictTypeResponseDto> {
    await this.assertCanOrThrow(user, 'dict.update.type');
    await this.findDictTypeOrThrow(id);
    return this.prisma.dictType.update({
      where: { id },
      data: { status: dto.status },
      select: dictTypeSelect,
    });
  }

  // 软删 dict_type:决策 1=A,引用检查 dict_items + organizations.nodeTypeCode +
  // members.gradeCode;决策 5,事务内完成检查 + 软删,避免并发新建撞约束。
  // P0-F PR-2A D3=A:从 v1 @Roles(SUPER_ADMIN) 单角色放宽至 ops-admin 可调
  // (sub-protection 仍由本方法事务内 IN_USE 引用检查兜底)。
  async softDeleteDictType(user: CurrentUserPayload, id: string): Promise<DictTypeResponseDto> {
    await this.assertCanOrThrow(user, 'dict.delete.type');
    return this.prisma.$transaction(async (tx) => {
      const target = await this.findDictTypeOrThrow(id, tx);

      const [itemsCount, orgCount, memberCount] = await Promise.all([
        tx.dictItem.count({ where: { typeId: id, deletedAt: null } }),
        tx.organization.count({ where: { nodeTypeCode: target.code, deletedAt: null } }),
        tx.member.count({ where: { gradeCode: target.code, deletedAt: null } }),
      ]);
      if (itemsCount + orgCount + memberCount > 0) {
        throw new BizException(BizCode.DICT_TYPE_IN_USE);
      }

      return tx.dictType.update({
        where: { id },
        data: { deletedAt: new Date(), status: DictTypeStatus.INACTIVE },
        select: dictTypeSelect,
      });
    });
  }

  // ============ dict_items ============

  async listDictItems(
    user: CurrentUserPayload,
    query: ListDictItemsQueryDto,
  ): Promise<PageResultDto<DictItemResponseDto>> {
    await this.assertCanOrThrow(user, 'dict.read.item');
    const { page, pageSize, typeId, parentId, status } = query;

    // typeId 必填且必须存在(不存在 → DICT_TYPE_NOT_FOUND)
    await this.findDictTypeOrThrow(typeId);

    const where: Prisma.DictItemWhereInput = notDeletedWhere({
      typeId,
      ...(parentId !== undefined ? { parentId } : {}),
      ...(status !== undefined ? { status } : {}),
    });

    const [items, total] = await this.prisma.$transaction([
      this.prisma.dictItem.findMany({
        where,
        select: dictItemSelect,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.dictItem.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async createDictItem(
    user: CurrentUserPayload,
    dto: CreateDictItemDto,
  ): Promise<DictItemResponseDto> {
    await this.assertCanOrThrow(user, 'dict.create.item');
    return this.prisma.$transaction(async (tx) => {
      // 1. typeId 必须存在
      await this.findDictTypeOrThrow(dto.typeId, tx);

      // 2. parentId 校验:存在 + 同 typeId(创建时不会自环 — 自身 id 还没生成)
      if (dto.parentId !== undefined) {
        const parent = await tx.dictItem.findFirst({
          where: notDeletedWhere({ id: dto.parentId }),
          select: { id: true, typeId: true },
        });
        if (!parent) throw new BizException(BizCode.DICT_ITEM_NOT_FOUND);
        if (parent.typeId !== dto.typeId) {
          throw new BizException(BizCode.DICT_ITEM_PARENT_TYPE_MISMATCH);
        }
      }

      // 3. (typeId, code) 唯一性预检查(包含软删,沿用 v1 §10 + memberNo 决议同语义)
      const existing = await tx.dictItem.findUnique({
        where: { typeId_code: { typeId: dto.typeId, code: dto.code } },
        select: { id: true },
      });
      if (existing) throw new BizException(BizCode.DICT_ITEM_CODE_ALREADY_EXISTS);

      return this.runDictItemUniqueGuard(() =>
        tx.dictItem.create({
          data: {
            typeId: dto.typeId,
            code: dto.code,
            label: dto.label,
            parentId: dto.parentId,
            sortOrder: dto.sortOrder ?? 0,
          },
          select: dictItemSelect,
        }),
      );
    });
  }

  async findDictItemById(user: CurrentUserPayload, id: string): Promise<DictItemResponseDto> {
    await this.assertCanOrThrow(user, 'dict.read.item');
    return this.findDictItemOrThrow(id);
  }

  async updateDictItem(
    user: CurrentUserPayload,
    id: string,
    dto: UpdateDictItemDto,
  ): Promise<DictItemResponseDto> {
    await this.assertCanOrThrow(user, 'dict.update.item');
    await this.findDictItemOrThrow(id);

    const data: Prisma.DictItemUpdateInput = {};
    if (dto.label !== undefined) data.label = dto.label;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

    return this.prisma.dictItem.update({
      where: { id },
      data,
      select: dictItemSelect,
    });
  }

  async updateDictItemStatus(
    user: CurrentUserPayload,
    id: string,
    dto: UpdateDictItemStatusDto,
  ): Promise<DictItemResponseDto> {
    await this.assertCanOrThrow(user, 'dict.update.item');
    await this.findDictItemOrThrow(id);
    return this.prisma.dictItem.update({
      where: { id },
      data: { status: dto.status },
      select: dictItemSelect,
    });
  }

  // 软删 dict_item:决策 1=A,引用检查 子 items + organizations.nodeTypeCode +
  // members.gradeCode;决策 5,事务内完成检查 + 软删。
  // P0-F PR-2A D3=A:从 v1 @Roles(SUPER_ADMIN) 单角色放宽至 ops-admin 可调
  // (sub-protection 仍由本方法事务内 IN_USE 引用检查兜底)。
  async softDeleteDictItem(user: CurrentUserPayload, id: string): Promise<DictItemResponseDto> {
    await this.assertCanOrThrow(user, 'dict.delete.item');
    return this.prisma.$transaction(async (tx) => {
      const target = await this.findDictItemOrThrow(id, tx);

      const [childCount, orgCount, memberCount] = await Promise.all([
        tx.dictItem.count({ where: { parentId: id, deletedAt: null } }),
        tx.organization.count({ where: { nodeTypeCode: target.code, deletedAt: null } }),
        tx.member.count({ where: { gradeCode: target.code, deletedAt: null } }),
      ]);
      if (childCount + orgCount + memberCount > 0) {
        throw new BizException(BizCode.DICT_ITEM_IN_USE);
      }

      return tx.dictItem.update({
        where: { id },
        data: { deletedAt: new Date(), status: DictItemStatus.INACTIVE },
        select: dictItemSelect,
      });
    });
  }

  // ============ tree ============

  async getDictItemTree(
    user: CurrentUserPayload,
    typeId: string,
    statusFilter?: DictItemStatus,
  ): Promise<DictItemTreeNodeDto[]> {
    await this.assertCanOrThrow(user, 'dict.read.item');
    await this.findDictTypeOrThrow(typeId);

    const items = await this.prisma.dictItem.findMany({
      where: notDeletedWhere({
        typeId,
        ...(statusFilter !== undefined ? { status: statusFilter } : {}),
      }),
      select: dictItemSelect,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });

    // 内存拼父子树:N 次拉取后 O(N) 拼接,无 N+1。
    // 决策 4:深度无限制(实现一次性可承载多层),业务侧自行约束。
    const byId = new Map<string, DictItemTreeNodeDto>();
    for (const item of items) {
      byId.set(item.id, { ...item, children: [] });
    }

    const roots: DictItemTreeNodeDto[] = [];
    for (const node of byId.values()) {
      if (node.parentId === null) {
        roots.push(node);
      } else {
        const parent = byId.get(node.parentId);
        if (parent) {
          parent.children.push(node);
        } else {
          // parent 不在结果集(可能被 status 过滤排除 / 已软删)→ 作为孤立根输出,
          // 避免节点丢失;运营在 UI 看到孤儿节点能自行处理。
          roots.push(node);
        }
      }
    }
    return roots;
  }
}
