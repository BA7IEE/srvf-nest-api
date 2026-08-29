import { Prisma, BindingScopeType, BindingStatus, PrincipalType } from '@prisma/client';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';

type PrismaTx = Prisma.TransactionClient;

/**
 * Integration Foundation v1 PR4(规格书 §17;T0 冻结稿 §10.3):Principal-neutral 授权核。
 *
 * 职责(§17):
 *   - 根据 `{ principalType, principalId }` 查询**显式 RoleBinding**;
 *   - 过滤任期、状态、软删;
 *   - 过滤角色是否含指定 Permission;
 *   - 返回可解释 decision 和 matched binding。
 *
 * 🔴 **结构性不做**(SP 不享有的三样,规格书 §15.3 第 5/6 条):
 *   - SUPER_ADMIN 短路(机器身份无 User 角色);
 *   - Member / Position / Supervision 虚拟 grant(三源推导只服务真人);
 *   - SELF scope(创建时已拒;运行时再过滤一道是纵深)。
 *
 * ⭐ **资格门运行时执法**(§15.3 末段):每次判权都过滤 `servicePrincipalAllowed=true`
 *   —— 不能只在 RoleBinding 创建时校验;向已被绑定的 Role 后续扩权时,新增的不合格码
 *   在这里被结构性看不见。
 */
export interface DirectPrincipalGrant {
  bindingId: string;
  roleId: string;
  roleCode: string;
  scopeType: BindingScopeType;
  scopeOrgId: string | null;
  scopeActivityId: string | null;
  scopeResourceType: string | null;
  scopeResourceId: string | null;
}

export interface DirectPrincipalDecision {
  /** 该 principal 对该 action 是否有直接授权(任一有效 grant 的角色含该码且资格门开)。 */
  allowed: boolean;
  /** 命中的有效 grants(含 scope,供上层做 coverage 判定)。 */
  matched: readonly DirectPrincipalGrant[];
  /** 拒绝原因(可解释;empty when allowed)。 */
  reason: 'no-bindings' | 'no-eligible-permission' | 'eligibility-blocked' | 'allowed' | null;
}

@Injectable()
export class DirectPrincipalAuthzService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 判「principal 是否通过 direct RoleBinding 持有某权限码」。
   * 事务内原语:调用方可传 tx 以嵌入更大的授权事务(如 Delegated 三腿交集,PR5)。
   */
  async explainDirect(
    input: { principalType: PrincipalType; principalId: string },
    action: string,
    now: Date = new Date(),
    client?: PrismaTx,
  ): Promise<DirectPrincipalDecision> {
    const db = client ?? this.prisma;
    const { principalType, principalId } = input;
    const bindings = await db.roleBinding.findMany({
      where: {
        principalType: principalType,
        principalId: principalId,
        deletedAt: null,
      },
      select: {
        id: true,
        roleId: true,
        role: { select: { code: true } },
        scopeType: true,
        scopeOrgId: true,
        scopeActivityId: true,
        scopeResourceType: true,
        scopeResourceId: true,
        status: true,
        startedAt: true,
        endedAt: true,
      },
    });

    // role 软删过滤(JS 层;where 里的 relation 过滤会触发 domain scanner 的 dynamic 判定,
    // 而 select 已带回 role 数据 —— 语义等价,判据友好)。
    const activeBindings = bindings.filter((b) => b.role !== null);

    // 权限链单独查(nested select 三层以上触发 dynamic 判定;拆成顶层调用语义等价)。
    const roleIds = [...new Set(activeBindings.map((b) => b.roleId))];
    const relevantPermissions = await db.rolePermission.findMany({
      where: { roleId: { in: roleIds } },
      select: {
        roleId: true,
        permission: { select: { code: true, servicePrincipalAllowed: true } },
      },
    });
    const permsByRoleId = new Map<
      string,
      Array<{ code: string; servicePrincipalAllowed: boolean }>
    >();
    for (const rp of relevantPermissions) {
      const list = permsByRoleId.get(rp.roleId) ?? [];
      list.push(rp.permission);
      permsByRoleId.set(rp.roleId, list);
    }

    if (activeBindings.length === 0) {
      return { allowed: false, matched: [], reason: 'no-bindings' };
    }

    // 任期 + 状态 + SELF 过滤(§15.3 第 4 条:SELF 对机器身份无语义,运行时纵深再滤一道)。
    const effective = activeBindings.filter(
      (b) =>
        b.status === BindingStatus.ACTIVE &&
        b.startedAt.getTime() <= now.getTime() &&
        (b.endedAt === null || b.endedAt.getTime() > now.getTime()) &&
        b.scopeType !== BindingScopeType.SELF,
    );

    // 角色含该码 + 资格门开(§15.3 第 3 条运行时)。
    const withPermission = effective.filter(
      (b) =>
        (permsByRoleId.get(b.roleId) ?? []).filter((p) => p.code === action).length > 0 &&
        (permsByRoleId.get(b.roleId) ?? [])
          .filter((p) => p.code === action)
          .every((p) => p.servicePrincipalAllowed === true),
    );

    if (withPermission.length === 0) {
      // 区分两种拒绝:有绑定但角色不含码 vs 含码但资格门关。
      const hasCodeButBlocked = effective.some((b) =>
        (permsByRoleId.get(b.roleId) ?? []).some((p) => p.code === action),
      );
      return {
        allowed: false,
        matched: [],
        reason: hasCodeButBlocked ? 'eligibility-blocked' : 'no-eligible-permission',
      };
    }

    return {
      allowed: true,
      matched: withPermission.map((b) => ({
        bindingId: b.id,
        roleId: b.roleId,
        roleCode: b.role.code,
        scopeType: b.scopeType,
        scopeOrgId: b.scopeOrgId,
        scopeActivityId: b.scopeActivityId,
        scopeResourceType: b.scopeResourceType,
        scopeResourceId: b.scopeResourceId,
      })),
      reason: 'allowed',
    };
  }

  /** can 直通(不走 explain 时用;内部零额外查询)。 */
  async canDirect(
    input: { principalType: PrincipalType; principalId: string },
    action: string,
    now?: Date,
    client?: PrismaTx,
  ): Promise<boolean> {
    return (await this.explainDirect(input, action, now, client)).allowed;
  }
}
