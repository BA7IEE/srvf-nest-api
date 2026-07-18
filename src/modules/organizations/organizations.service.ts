import { Injectable } from '@nestjs/common';
import {
  DictItemStatus,
  DictTypeStatus,
  MembershipStatus,
  OrganizationStatus,
  Prisma,
} from '@prisma/client';
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
  buildCreateClosureEdges,
  buildReparentEdgesToInsert,
  isReparentCycle,
} from './organization-closure.util';
import {
  lockOrganizationTopology,
  runOrganizationTopologyTransaction,
} from './organization-topology-transaction';
import {
  CreateOrganizationDto,
  ListOrganizationsQueryDto,
  MoveOrganizationDto,
  OrganizationOptionItemDto,
  OrganizationOptionsQueryDto,
  OrganizationOptionsResponseDto,
  OrganizationResponseDto,
  OrganizationTreeNodeDto,
  OrganizationTreeOptionItemDto,
  OrganizationTreeQueryDto,
  OrganizationTreeWithSummaryNodeDto,
  UpdateOrganizationDto,
  UpdateOrganizationStatusDto,
} from './organizations.dto';

// 节点类别 dict_type code(seed neutral-demo 实际值;详见 prisma/seed.ts V2_DICT_SEED)。
// 模块内常量化:Step 5 members 自有 'member_grade';如未来需要跨模块复用再抽 common。
const NODE_TYPE_DICT_CODE = 'node_type';

// 审计留痕批(2026-07-03;review #484 G18 → NEXT_TASKS P1-16)。沿 position-assignments /
// supervision-assignments 范式:resourceType 模块内常量化,不抽共享类。
const AUDIT_RESOURCE_TYPE = 'organization';

// 集中定义对外 select。永不包含 deletedAt(软删除内部状态)。
const organizationSelect = {
  id: true,
  name: true,
  code: true,
  parentId: true,
  nodeTypeCode: true,
  sortOrder: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.OrganizationSelect;

type SafeOrganization = Prisma.OrganizationGetPayload<{ select: typeof organizationSelect }>;
type PrismaTx = Prisma.TransactionClient;
type CreateOrganizationOptions =
  | { dryRun?: boolean; transaction?: never }
  | { transaction: PrismaTx; dryRun?: never };

// 终态 scoped-authz PR11(2026-07-02;冻结稿 §8.4 / §11 PR11):dry-run 沙箱哨兵,镜像
// position-assignments/supervision-assignments 同名类(不共享,沿模块自包含范式)。create() 走满全部
// 校验 + 真实 insert(+ closure 维护)后,若 options.dryRun,在事务提交前抛本类型强制整个事务一并回滚,
// catch 后原样返回"本应创建"的响应体。announcement-import 的批量 preview/execute 改用互斥
// transaction option 复用 request-wide 外层事务,同时仍在首条 topology SQL 前取得同一把 xact lock。
class DryRunAbort<T> extends Error {
  constructor(public readonly value: T) {
    super('DRY_RUN_ABORT');
  }
}

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  // ============ helpers ============

  // P0-F PR-2A(2026-05-18):RBAC 判权(沿 PR-1 attachments F5 v1.0 范本)。
  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

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

  // code 唯一性预检查(含软删历史占用)。`code String? @unique` 是**全局**约束(含 deletedAt
  // 非空行),预检查必须用 findUnique 含全部记录,否则软删占用会通过预检查后撞 P2002
  //(沿 attachment-type-configs 范式 + prisma/CLAUDE.md 软删 unique 铁律)。update 传 excludeId
  // 排除自身(把 code 设回当前值不算冲突)。
  private async assertCodeAvailableOrThrow(
    code: string,
    tx: PrismaTx,
    excludeId?: string,
  ): Promise<void> {
    const existing = await tx.organization.findUnique({
      where: { code },
      select: { id: true },
    });
    if (existing && existing.id !== excludeId) {
      throw new BizException(BizCode.ORGANIZATION_CODE_ALREADY_EXISTS);
    }
  }

  private async runCreateTransaction<T>(
    transaction: PrismaTx | undefined,
    operation: (tx: PrismaTx) => Promise<T>,
  ): Promise<T> {
    if (transaction) {
      await lockOrganizationTopology(transaction);
      return operation(transaction);
    }
    return runOrganizationTopologyTransaction(this.prisma, operation);
  }

  // P2002 兜底 — 预检查应已拦绝大多数,这层处理并发(两个写同时撞 code unique)。
  // Organization 唯一业务约束只有 code @unique(id 是 cuid PK 不会撞);Prisma 6.x P2002
  // meta.target 形态不稳(数组 ['code'] 或约束名 'Organization_code_key'),两者均含 'code'。
  private async runCodeUniqueGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = err.meta?.target;
        const targetStr = Array.isArray(target)
          ? target.join(',')
          : typeof target === 'string'
            ? target
            : '';
        if (targetStr.includes('code')) {
          throw new BizException(BizCode.ORGANIZATION_CODE_ALREADY_EXISTS);
        }
      }
      throw err;
    }
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

  // F1/A3(D1):q 跨字段模糊命中 name+code;list/options 共用同一份 OR 子句构造。
  private buildNameCodeSearchOr(q: string): Prisma.OrganizationWhereInput['OR'] {
    return [
      { name: { contains: q, mode: 'insensitive' } },
      { code: { contains: q, mode: 'insensitive' } },
    ];
  }

  async list(
    user: CurrentUserPayload,
    query: ListOrganizationsQueryDto,
  ): Promise<PageResultDto<OrganizationResponseDto>> {
    await this.assertCanOrThrow(user, 'org.read.node');
    const { page, pageSize, parentId, nodeTypeCode, status, q, nameContains, codeContains } = query;

    const filters: Prisma.OrganizationWhereInput = {};
    if (parentId !== undefined) {
      // 字面值 'null' → parentId IS NULL(根节点过滤)
      filters.parentId = parentId === 'null' ? null : parentId;
    }
    if (nodeTypeCode !== undefined) filters.nodeTypeCode = nodeTypeCode;
    if (status !== undefined) filters.status = status;
    // nameContains/codeContains 精确子串备用(D1)。
    if (q !== undefined) filters.OR = this.buildNameCodeSearchOr(q);
    if (nameContains !== undefined) {
      filters.name = { contains: nameContains, mode: 'insensitive' };
    }
    if (codeContains !== undefined) {
      filters.code = { contains: codeContains, mode: 'insensitive' };
    }

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

  async getTree(
    user: CurrentUserPayload,
    query: OrganizationTreeQueryDto,
  ): Promise<OrganizationTreeNodeDto[]> {
    await this.assertCanOrThrow(user, 'org.read.node');
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

  async create(
    user: CurrentUserPayload,
    dto: CreateOrganizationDto,
    meta: AuditMeta,
    options?: CreateOrganizationOptions,
  ): Promise<OrganizationResponseDto> {
    await this.assertCanOrThrow(user, 'org.create.node');
    try {
      return await this.runCodeUniqueGuard(() =>
        this.runCreateTransaction(options?.transaction, async (tx) => {
          // 1. nodeTypeCode 必须有效(6 项 AND 校验)
          await this.assertNodeTypeCodeValid(dto.nodeTypeCode, tx);

          // 2. code 唯一性(可选;传了才校验,含软删历史占用)
          if (dto.code !== undefined) {
            await this.assertCodeAvailableOrThrow(dto.code, tx);
          }

          // 3. parentId 校验:存在 + 未软删(允许在 INACTIVE 父下建子,与 v2-data-model §4.6 一致)
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

          const created = await tx.organization.create({
            data: {
              name: dto.name,
              // code 未传 → undefined → Prisma 省略该列 → 落 NULL(可空)
              code: dto.code,
              parentId: dto.parentId,
              nodeTypeCode: dto.nodeTypeCode,
              sortOrder: dto.sortOrder ?? 0,
              // PR11(2026-07-02):两 additive 可空列透传(PR1 schema-only 留口本刀首次接入 Create DTO)。
              establishmentStatusCode: dto.establishmentStatusCode ?? null,
              groupFunctionCode: dto.groupFunctionCode ?? null,
            },
            select: organizationSelect,
          });

          // closure 维护(冻结稿 §3.8/§8.3):自身 depth-0 + 继承父全部祖先各 +1;建根 → 仅自身行。
          const parentAncestors = dto.parentId
            ? await tx.organizationClosure.findMany({
                where: { descendantId: dto.parentId },
                select: { ancestorId: true, depth: true },
              })
            : [];
          await tx.organizationClosure.createMany({
            data: buildCreateClosureEdges(created.id, parentAncestors),
          });

          await this.auditLogs.log({
            event: 'organization.create',
            actorUserId: user.id,
            actorRoleSnap: user.role,
            resourceType: AUDIT_RESOURCE_TYPE,
            resourceId: created.id,
            meta,
            after: {
              name: created.name,
              code: created.code,
              parentId: created.parentId,
              nodeTypeCode: created.nodeTypeCode,
              sortOrder: created.sortOrder,
              status: created.status,
            },
            extra: { operation: 'create' },
            tx,
          });

          if (options?.dryRun) throw new DryRunAbort(created);
          return created;
        }),
      );
    } catch (err) {
      if (err instanceof DryRunAbort) return err.value as OrganizationResponseDto;
      throw err;
    }
  }

  // ============ findOne ============

  async findOne(user: CurrentUserPayload, id: string): Promise<OrganizationResponseDto> {
    await this.assertCanOrThrow(user, 'org.read.node');
    return this.findOrganizationOrThrow(id);
  }

  // ============ update ============

  async update(
    user: CurrentUserPayload,
    id: string,
    dto: UpdateOrganizationDto,
  ): Promise<OrganizationResponseDto> {
    await this.assertCanOrThrow(user, 'org.update.node');
    return this.runCodeUniqueGuard(() =>
      runOrganizationTopologyTransaction(this.prisma, async (tx) => {
        await this.findOrganizationOrThrow(id, tx);

        if (dto.nodeTypeCode !== undefined) {
          await this.assertNodeTypeCodeValid(dto.nodeTypeCode, tx);
        }

        // code 唯一性(可选;排除自身 → 把 code 设回当前值不算冲突;含软删历史占用)
        if (dto.code !== undefined) {
          await this.assertCodeAvailableOrThrow(dto.code, tx, id);
        }

        const data: Prisma.OrganizationUpdateInput = {};
        if (dto.name !== undefined) data.name = dto.name;
        if (dto.code !== undefined) data.code = dto.code;
        if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
        if (dto.nodeTypeCode !== undefined) data.nodeTypeCode = dto.nodeTypeCode;

        return tx.organization.update({
          where: { id },
          data,
          select: organizationSelect,
        });
      }),
    );
  }

  // ============ updateStatus ============

  async updateStatus(
    user: CurrentUserPayload,
    id: string,
    dto: UpdateOrganizationStatusDto,
    meta: AuditMeta,
  ): Promise<OrganizationResponseDto> {
    await this.assertCanOrThrow(user, 'org.update.node');
    return runOrganizationTopologyTransaction(this.prisma, async (tx) => {
      const target = await this.findOrganizationOrThrow(id, tx);

      // last-root 保护:目标是根节点 + 改成 INACTIVE
      if (target.parentId === null && dto.status === OrganizationStatus.INACTIVE) {
        await this.assertNotLastActiveRoot(tx, id);
      }

      const updated = await tx.organization.update({
        where: { id },
        data: { status: dto.status },
        select: organizationSelect,
      });

      await this.auditLogs.log({
        event: 'organization.status-change',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: updated.id,
        meta,
        before: { status: target.status },
        after: { status: updated.status },
        extra: { operation: 'status-change' },
        tx,
      });

      return updated;
    });
  }

  // ============ move (reparent) ============

  // 终态 scoped-authz PR1(2026-07-01 goal「组织基座」;冻结稿 §8.3/§11 PR1):重挂父级 + closure 重算。
  // 复活两死码:改根节点父级 → PARENT_CHANGE_FORBIDDEN(守单根上限;受限位置);
  // 目标父=自身/自身后代 → PARENT_CYCLE(closure 子树集判定)。事务内重算受影响子树 closure
  //(删旧祖先→子树边、按新父插入),无悬挂、PK 兜底防重。行为锁:不触碰现有 CRUD / getTree / 单根 / 软删护栏。
  async move(
    user: CurrentUserPayload,
    id: string,
    dto: MoveOrganizationDto,
    meta: AuditMeta,
  ): Promise<OrganizationResponseDto> {
    await this.assertCanOrThrow(user, 'org.move.node');
    return runOrganizationTopologyTransaction(this.prisma, async (tx) => {
      const target = await this.findOrganizationOrThrow(id, tx);

      // 受限位置:根节点父级不可改(移根 = 破坏单根结构)。
      if (target.parentId === null) {
        throw new BizException(BizCode.ORGANIZATION_PARENT_CHANGE_FORBIDDEN);
      }

      // 目标父必须存在且未软删(允许挂到 INACTIVE 父下,与 create 一致)。
      const newParent = await tx.organization.findFirst({
        where: notDeletedWhere({ id: dto.parentId }),
        select: { id: true },
      });
      if (!newParent) throw new BizException(BizCode.ORGANIZATION_PARENT_NOT_FOUND);

      // 同父 → 幂等 no-op(避免重算撞 PK;直接返回当前态)。
      if (target.parentId === dto.parentId) {
        return this.findOrganizationOrThrow(id, tx);
      }

      // 被移动子树(closure 查 ancestorId=id,含自身 depth-0)。
      const subtree = await tx.organizationClosure.findMany({
        where: { ancestorId: id },
        select: { descendantId: true, depth: true },
      });

      // 环判定:目标父 = 自身或自身后代 → 拒。
      if (
        isReparentCycle(
          dto.parentId,
          subtree.map((s) => s.descendantId),
        )
      ) {
        throw new BizException(BizCode.ORGANIZATION_PARENT_CYCLE);
      }

      // 删旧边:旧祖先(不含自身)× 子树全部后代。两个 in 即笛卡尔积;子树内部边 / 自身行不受影响
      //(其 ancestorId 属子树、不在旧祖先集)。
      const oldAncestors = await tx.organizationClosure.findMany({
        where: { descendantId: id, depth: { gt: 0 } },
        select: { ancestorId: true },
      });
      if (oldAncestors.length > 0) {
        await tx.organizationClosure.deleteMany({
          where: {
            ancestorId: { in: oldAncestors.map((a) => a.ancestorId) },
            descendantId: { in: subtree.map((s) => s.descendantId) },
          },
        });
      }

      // 插新边:新父全部祖先(含新父自身)× 子树全部后代,depth = sup+sub+1。
      const newParentAncestors = await tx.organizationClosure.findMany({
        where: { descendantId: dto.parentId },
        select: { ancestorId: true, depth: true },
      });
      await tx.organizationClosure.createMany({
        data: buildReparentEdgesToInsert(newParentAncestors, subtree),
      });

      const updated = await tx.organization.update({
        where: { id },
        data: { parentId: dto.parentId },
        select: organizationSelect,
      });

      await this.auditLogs.log({
        event: 'organization.move',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: updated.id,
        meta,
        before: { parentId: target.parentId },
        after: { parentId: updated.parentId },
        extra: { operation: 'move' },
        tx,
      });

      return updated;
    });
  }

  // ============ softDelete ============

  // 决策 5:事务原子。决策 3=A:同时查 dict 范围外的 member_departments(Step 6 落地后无需补)。
  // P0-F PR-2A D3=A:从 v1 @Roles(SUPER_ADMIN) 单角色放宽至 ops-admin 可调
  // (sub-protection 仍由本方法事务内 HAS_CHILDREN / HAS_MEMBERS / LAST_ROOT_PROTECTED 兜底)。
  async softDelete(
    user: CurrentUserPayload,
    id: string,
    meta: AuditMeta,
  ): Promise<OrganizationResponseDto> {
    await this.assertCanOrThrow(user, 'org.delete.node');
    return runOrganizationTopologyTransaction(this.prisma, async (tx) => {
      const target = await this.findOrganizationOrThrow(id, tx);

      const [childCount, memberCount] = await Promise.all([
        tx.organization.count({ where: { parentId: id, deletedAt: null } }),
        // 终态 scoped-authz PR2:HAS_MEMBERS 护栏重指向 active PRIMARY membership(= 旧单部门语义,行为逐字保持;
        // 收紧到"任意类型归属阻止删组织"是独立语义决策,非本刀)。
        tx.memberOrganizationMembership.count({
          where: {
            organizationId: id,
            deletedAt: null,
            membershipType: 'PRIMARY',
            status: 'ACTIVE',
          },
        }),
      ]);
      if (childCount > 0) throw new BizException(BizCode.ORGANIZATION_HAS_CHILDREN);
      if (memberCount > 0) throw new BizException(BizCode.ORGANIZATION_HAS_MEMBERS);

      // last-root 保护:目标是根节点
      if (target.parentId === null) {
        await this.assertNotLastActiveRoot(tx, id);
      }

      const updated = await tx.organization.update({
        where: { id },
        data: { deletedAt: new Date(), status: OrganizationStatus.INACTIVE },
        select: organizationSelect,
      });

      await this.auditLogs.log({
        event: 'organization.delete',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: updated.id,
        meta,
        before: { status: target.status, parentId: target.parentId },
        extra: { operation: 'delete' },
        tx,
      });

      return updated;
    });
  }

  // ============ F1/A3 选择器(路线图 §4;D2/D3 拍板)============

  // options = list 的轻量投影;复用 org.read.node(D2,不新增权限码)。
  async options(
    user: CurrentUserPayload,
    query: OrganizationOptionsQueryDto,
  ): Promise<OrganizationOptionsResponseDto> {
    await this.assertCanOrThrow(user, 'org.read.node');
    const { q, nodeTypeCode, status, limit } = query;

    const filters: Prisma.OrganizationWhereInput = {};
    if (nodeTypeCode !== undefined) filters.nodeTypeCode = nodeTypeCode;
    if (status !== undefined) filters.status = status;
    if (q !== undefined) filters.OR = this.buildNameCodeSearchOr(q);

    const rows = await this.prisma.organization.findMany({
      where: notDeletedWhere(filters),
      select: organizationSelect,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      take: limit ?? 20,
    });

    const items: OrganizationOptionItemDto[] = rows.map((r) => ({
      id: r.id,
      label: r.name,
      code: r.code,
      nodeTypeCode: r.nodeTypeCode,
      parentId: r.parentId,
    }));
    return { items };
  }

  // 整树极简投影(表单级联选择器用);复用 getTree() 的 O(N) 拼装,仅重塑输出字段。
  // 同码 org.read.node(D2)。
  async treeOptions(
    user: CurrentUserPayload,
    query: OrganizationTreeQueryDto,
  ): Promise<OrganizationTreeOptionItemDto[]> {
    const tree = await this.getTree(user, query);
    const project = (nodes: OrganizationTreeNodeDto[]): OrganizationTreeOptionItemDto[] =>
      nodes.map((n) => ({
        id: n.id,
        label: n.name,
        code: n.code,
        children: project(n.children),
      }));
    return project(tree);
  }

  // F4/D 组(2026-07-04;路线图 §4):整树 + 每节点 membership 计数(组织管理页概览)。
  // 复用 getTree() 的 O(N) 拼装 + **一次** groupBy 批量聚合 ACTIVE 归属条数(禁 N+1);
  // subtree 合计在树上后序折叠,零额外查询。计数是展示读,memberships 表绝不被读作授权(PR2 铁律不变)。
  // 同码 org.read.node(D2;getTree 内判)。
  async treeWithSummary(
    user: CurrentUserPayload,
    query: OrganizationTreeQueryDto,
  ): Promise<OrganizationTreeWithSummaryNodeDto[]> {
    const tree = await this.getTree(user, query);
    const counts = await this.prisma.memberOrganizationMembership.groupBy({
      by: ['organizationId'],
      where: { deletedAt: null, status: MembershipStatus.ACTIVE },
      _count: { _all: true },
    });
    const directById = new Map(counts.map((c) => [c.organizationId, c._count._all]));
    const project = (nodes: OrganizationTreeNodeDto[]): OrganizationTreeWithSummaryNodeDto[] =>
      nodes.map((n) => {
        const children = project(n.children);
        const direct = directById.get(n.id) ?? 0;
        return {
          id: n.id,
          name: n.name,
          code: n.code,
          nodeTypeCode: n.nodeTypeCode,
          status: n.status,
          directMembershipCount: direct,
          subtreeMembershipCount:
            direct + children.reduce((sum, c) => sum + c.subtreeMembershipCount, 0),
          children,
        };
      });
    return project(tree);
  }

  // ============ D7 只读 helper(路线图 §3 D7;冻结 §4 契约)============

  // 给定 orgId,展开该组织及其全部后代组织 id(含自身)。读 organization_closure
  // WHERE ancestorId = orgId。**纯读、零 schema、仅供列表数据过滤展开,绝不进任何判权路径**
  // (closure 非 judge;判权路径见 authz/ 模块三源推导,本 helper 与之无关)。
  async queryDescendantOrgIds(orgId: string): Promise<string[]> {
    const rows = await this.prisma.organizationClosure.findMany({
      where: { ancestorId: orgId },
      select: { descendantId: true },
    });
    return rows.map((r) => r.descendantId);
  }
}
