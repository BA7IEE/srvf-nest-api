import { Injectable } from '@nestjs/common';
import {
  AssignmentStatus,
  BindingScopeType,
  BindingStatus,
  OrganizationStatus,
  PolicyScopeMode,
  PolicyStatus,
  PrincipalType,
  Role,
  SupervisionScopeMode,
  SupervisionStatus,
} from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import { getConstraintsForAction } from './action-constraints';
import type { AuthzDecision, MatchedGrant, ResolvedResource, ResourceRef } from './authz.types';
import { ResourceResolverService } from './resource-resolver.service';

// 终态 scoped-authz PR8(2026-07-02;冻结稿 §5.2 + §2.4 BD-1/BD-2/BD-3 + 🔴 R5):AuthzService(统一鉴权)。
//
// **本刀性质(goal)**:只建大脑、零消费者 —— 本 service 在本刀无任何业务调用点(第一个消费者是
// PR9 考勤终审;逐面迁移是 PR12),现网行为零变化。explain 端点(/authz/explain)是 PR10,不在此建。
//
// **判权主流程(§5.2 伪代码逐行)**:
//   1. SUPER_ADMIN 全局短路(但不豁免 ActionConstraint 域不变量,§5.3 —— 自审禁止对 SA 也成立)
//   2. 解析资源:有 ref 而解析失败(不存在/软删/未知类型)→ deny(resource_not_found)
//   3. 三源归集候选 grant(全部带 scope + 有效期 + 状态过滤;详 collectGrants)
//      3a. 直接 RoleBinding:principalType=USER(user.id)∪ MEMBER(user.memberId)∪
//          POSITION_ASSIGNMENT(该 member 全部任职 id;BD-2 终审中枢绑定走此,绝不 hardcode 部门)
//      3b. 职务推导:active PositionAssignment × active PositionRolePolicy(positionId→roleId),
//          scope = 任职组织 + policy.scopeMode。🔴 R5 由数据保证:副职零 policy 行 → 本步对副职天然零产出
//      3c. 分管推导:active SupervisionAssignment → `org-supervisor` 只读角色 @ 被分管组织 + scopeMode(BD-3)
//   4. 过滤「角色含 action 码」的 grant(RbacService.getRoleIdsWithPermission,批量;RolePermission 有 roleId 索引)
//   5. scope 覆盖判定 covers()(命中即 allow,带 matchedGrant 可解释性)
//   6. applyConstraints:ActionConstraint 注册表否决(对 SA 也生效)
//
// **🔴 无 ref 退化路径 = 行为锁(goal 决断①)**:authz.can(user, action)〔无 resourceRef〕逐字复用
// `RbacService.judge(user, action)` —— SUPER_ADMIN 短路 / GLOBAL 码集(getUserPermissionCodes,带缓存)/
// `.self` 后缀无 resource fail-close 三者与 rbac.can **逐项一致**;scoped grant(资源未知)一律不 covers,
// 只有 GLOBAL 能 allow =「无 resource 退化等旧」。等价矩阵 characterization 见
// test/e2e/authz-rbac-equivalence.e2e-spec.ts。注意:MEMBER / POSITION_ASSIGNMENT 主体的 GLOBAL 绑定
// 仅在**带 ref** 的完整三源路径生效 —— 无 ref 路径只认 USER 主体(= rbac 现语义),这是行为锁的刻意收窄。
//
// **🔴 安全默认(冻结稿 §5.2 红线,R5)**:副职不自动推导管理角色(3b 只对有 policy 行的正职产出);
// 全局/全树管辖只能来自显式 RoleBinding(3a)或分管(3c),绝不来自头衔;默认拒绝 —— 无命中 grant 即 deny。
//
// **legacy `.self` 不搬(goal 决断①)**:attachments 等现网 `.self` 判权继续走 rbac.can(RbacResource
// ownerType/ownerId)直到 PR12;本 service 对 `.self` 后缀码的带 ref 判定用 ResolvedResource 的
// ownerMemberId/ownerUserId 做同语义 ownership 硬门(命中码后仍须属主匹配,fail-close 镜像 rbac.judge)。
//
// **性能口径(goal 决断④)**:三源推导每 decision 现查、不建缓存层(当前数据量小;RolePermission
// 已有 roleId 索引,closure 判定复用 resolver 的 organizationPath 单查)。若未来 QPS 需要,优化留口:
// 角色→码集合可预热进 RbacCacheService 同款 TTL 缓存(失效链沿 role_permissions 写路径),本刀不做。

type CoverOutcome = 'covered' | 'not_covered' | 'inactive_org';

type InternalGrantSource = 'role_binding' | 'position' | 'supervision';

// 归集后的候选 grant(3a 实体绑定 + 3b/3c 虚拟 grant 归一形状;虚拟 grant 不落库,decision 时动态推导)
interface InternalGrant {
  source: InternalGrantSource;
  roleId: string;
  roleCode: string;
  scopeType: BindingScopeType;
  scopeOrgId: string | null;
  scopeActivityId: string | null;
  scopeResourceType: string | null;
  scopeResourceId: string | null;
  bindingId?: string;
  positionAssignmentId?: string;
  supervisionAssignmentId?: string;
  // status=ACTIVE 且 now∈[startedAt,endedAt〔null=不限〕](POSITION_ASSIGNMENT 主体绑定另要求底层任职有效);
  // false 的 grant 不参与 allow,仅用于 deny 归因(expired_grant)
  valid: boolean;
}

// BD-3:分管推导的监督角色(seed PR7 内置,只读 4 码)。角色码是配置锚点:如未来要换监督角色,
// 改此常量即可(deny/allow 逻辑不含任何组织/部门字面量,镜像 BD-2「绝不 hardcode APD」纪律)。
const SUPERVISOR_ROLE_CODE = 'org-supervisor';

// candidates 确定性排序(§5.2「按 source 优先级/确定性排序」):显式绑定 > 职务推导 > 分管推导;
// 同源内 scope 泛化度高者优先(GLOBAL 最先 —— 与无 ref 路径「GLOBAL 即 allow」口径一致);再按实体 id 定序。
const SOURCE_ORDER: Record<InternalGrantSource, number> = {
  role_binding: 0,
  position: 1,
  supervision: 2,
};
const SCOPE_ORDER: Record<BindingScopeType, number> = {
  [BindingScopeType.GLOBAL]: 0,
  [BindingScopeType.ORGANIZATION_TREE]: 1,
  [BindingScopeType.ORGANIZATION]: 2,
  [BindingScopeType.ACTIVITY]: 3,
  [BindingScopeType.RESOURCE]: 4,
  [BindingScopeType.SELF]: 5,
};

function isWithinTerm(startedAt: Date, endedAt: Date | null, now: Date): boolean {
  return (
    startedAt.getTime() <= now.getTime() && (endedAt === null || endedAt.getTime() >= now.getTime())
  );
}

@Injectable()
export class AuthzService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly resolver: ResourceResolverService,
  ) {}

  // ============ 公开 API(§5.2 签名)============

  // 薄包装:终判布尔。
  async can(user: CurrentUserPayload, action: string, ref?: ResourceRef): Promise<boolean> {
    const decision = await this.explain(user, action, ref);
    return decision.allow;
  }

  // 全解释:allow/deny + reason + matchedGrant(可解释性总纲 —— 每个 allow 必能指出命中的授权行)。
  async explain(
    user: CurrentUserPayload,
    action: string,
    ref?: ResourceRef,
  ): Promise<AuthzDecision> {
    // 0. 身份有效性(ACTIVE + 未软删)已由 JwtStrategy 每请求保证,此处不再查(§5.2 step 0)

    // 1. SUPER_ADMIN 全局短路;资源仅为 ActionConstraint 解析(解析失败不掀翻短路,约束判不了则不判)
    if (user.role === Role.SUPER_ADMIN) {
      const resource = ref ? await this.resolver.resolve(ref) : null;
      return this.applyConstraints(
        {
          allow: true,
          reason: 'super_admin_pass',
          matchedGrant: { source: 'super_admin', scopeType: BindingScopeType.GLOBAL },
          resource: resource ?? undefined,
        },
        user,
        action,
        resource,
      );
    }

    // 2. 🔴 无 ref 退化路径:逐字复用 rbac.judge(行为锁;见文件头)。现有约束均依赖 resource 字段,
    //    无 ref 时恒不否决 —— 仍统一过 applyConstraints,保证未来新增无资源约束时两条路径不分叉。
    if (!ref) {
      const legacy = await this.rbac.judge(user, action);
      if (!legacy.allowed) {
        return { allow: false, reason: 'no_permission' };
      }
      return this.applyConstraints(
        {
          allow: true,
          reason: 'matched',
          matchedGrant: { source: 'role_binding', scopeType: BindingScopeType.GLOBAL },
        },
        user,
        action,
        null,
      );
    }

    // 3. 解析资源:失败即 fail-close(§5.1 表末;含防枚举语义,统一 resource_not_found)
    const resource = await this.resolver.resolve(ref);
    if (!resource) {
      return { allow: false, reason: 'resource_not_found' };
    }

    // 4. 三源归集 + 「角色含码」过滤
    const grants = await this.collectGrants(user);
    const roleIds = [...new Set(grants.map((g) => g.roleId))];
    const rolesWithCode = await this.rbac.getRoleIdsWithPermission(roleIds, action);
    const withCode = grants.filter((g) => rolesWithCode.has(g.roleId));
    if (withCode.length === 0) {
      return { allow: false, reason: 'no_permission', resource };
    }

    // 5. legacy `.self` 后缀:命中码后属主硬门(镜像 rbac.judge fail-close;reason 同用 no_permission)。
    //    属主匹配 = resource.ownerMemberId==user.memberId 或 resource.ownerUserId==user.id。
    if (action.endsWith('.self') && !this.ownsResource(user, resource)) {
      return { allow: false, reason: 'no_permission', resource };
    }

    // 6. scope 覆盖判定(仅 valid 候选可 allow;首个命中即返,顺序确定性见 SOURCE_ORDER/SCOPE_ORDER)
    const candidates = withCode.filter((g) => g.valid).sort(compareGrants);
    const orgStates = await this.loadOrgActiveStates(withCode);
    let sawInactiveScopeOrg = false;
    for (const g of candidates) {
      const outcome = this.covers(g, resource, user, orgStates);
      if (outcome === 'covered') {
        return this.applyConstraints(
          { allow: true, reason: 'matched', matchedGrant: toMatchedGrant(g), resource },
          user,
          action,
          resource,
        );
      }
      if (outcome === 'inactive_org') {
        sawInactiveScopeOrg = true;
      }
    }

    // 7. deny 归因(拒绝结论一致,reason 求最可解释;优先级:scope org 失效 > 授权行过期 > 范围外 > 无码)
    if (sawInactiveScopeOrg) {
      return { allow: false, reason: 'inactive_org', resource };
    }
    const expiredWouldCover = withCode.some(
      (g) => !g.valid && this.coversGeometrically(g, resource, user),
    );
    if (expiredWouldCover) {
      return { allow: false, reason: 'expired_grant', resource };
    }
    if (candidates.length > 0) {
      const allSupervision = candidates.every((g) => g.source === 'supervision');
      return {
        allow: false,
        reason: allSupervision ? 'out_of_supervised_scope' : 'out_of_scope',
        resource,
      };
    }
    return { allow: false, reason: 'no_permission', resource };
  }

  // ============ 三源归集(§5.2 step 3)============

  // 归集口径:软删行(deletedAt≠null)与软删角色一律不出现;状态/任期失效行保留为 valid=false,
  // 仅用于 deny 归因(expired_grant),绝不参与 allow。全部现查不缓存(文件头性能口径)。
  private async collectGrants(user: CurrentUserPayload): Promise<InternalGrant[]> {
    const now = new Date();
    const grants: InternalGrant[] = [];
    const memberId = user.memberId;

    // 任职先取(3a 的 POSITION_ASSIGNMENT 主体 + 3b 职务推导共用);任意 status,软删除外
    const assignments = memberId
      ? await this.prisma.organizationPositionAssignment.findMany({
          where: { memberId, deletedAt: null },
          select: {
            id: true,
            organizationId: true,
            positionId: true,
            status: true,
            startedAt: true,
            endedAt: true,
          },
        })
      : [];
    const assignmentValid = new Map(
      assignments.map((a) => [
        a.id,
        a.status === AssignmentStatus.ACTIVE && isWithinTerm(a.startedAt, a.endedAt, now),
      ]),
    );

    // 3a. 直接 RoleBinding:USER ∪ MEMBER ∪ POSITION_ASSIGNMENT(仅该 member 的任职 id 集)
    const principalOr: Array<{
      principalType: PrincipalType;
      principalId: string | { in: string[] };
    }> = [{ principalType: PrincipalType.USER, principalId: user.id }];
    if (memberId) {
      principalOr.push({ principalType: PrincipalType.MEMBER, principalId: memberId });
    }
    if (assignments.length > 0) {
      principalOr.push({
        principalType: PrincipalType.POSITION_ASSIGNMENT,
        principalId: { in: assignments.map((a) => a.id) },
      });
    }
    const bindings = await this.prisma.roleBinding.findMany({
      where: { OR: principalOr, deletedAt: null, role: { deletedAt: null } },
      select: {
        id: true,
        roleId: true,
        role: { select: { code: true } },
        principalType: true,
        principalId: true,
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
    for (const b of bindings) {
      let valid = b.status === BindingStatus.ACTIVE && isWithinTerm(b.startedAt, b.endedAt, now);
      // POSITION_ASSIGNMENT 主体的绑定随底层任职失效(任职撤销/到期 → 绑定不再产权;BD-2 终审换届即此语义)
      if (b.principalType === PrincipalType.POSITION_ASSIGNMENT) {
        valid = valid && b.principalId !== null && (assignmentValid.get(b.principalId) ?? false);
      }
      grants.push({
        source: 'role_binding',
        roleId: b.roleId,
        roleCode: b.role.code,
        scopeType: b.scopeType,
        scopeOrgId: b.scopeOrgId,
        scopeActivityId: b.scopeActivityId,
        scopeResourceType: b.scopeResourceType,
        scopeResourceId: b.scopeResourceId,
        bindingId: b.id,
        valid,
      });
    }

    // 3b. 职务推导:任职 × policy(🔴 R5:副职零 policy 行 → 对副职天然零产出;
    //     conditionJson 非 null 的行保守跳过 —— seed 全 null,评估器待首个真实条件需求时再落,fail-close 不越权)
    if (assignments.length > 0) {
      const policies = await this.prisma.organizationPositionRolePolicy.findMany({
        where: {
          positionId: { in: [...new Set(assignments.map((a) => a.positionId))] },
          deletedAt: null,
          role: { deletedAt: null },
        },
        select: {
          positionId: true,
          roleId: true,
          role: { select: { code: true } },
          scopeMode: true,
          conditionJson: true,
          status: true,
        },
      });
      for (const a of assignments) {
        for (const p of policies) {
          if (p.positionId !== a.positionId) continue;
          if (p.conditionJson !== null) continue;
          grants.push({
            source: 'position',
            roleId: p.roleId,
            roleCode: p.role.code,
            scopeType:
              p.scopeMode === PolicyScopeMode.TREE
                ? BindingScopeType.ORGANIZATION_TREE
                : BindingScopeType.ORGANIZATION,
            scopeOrgId: a.organizationId,
            scopeActivityId: null,
            scopeResourceType: null,
            scopeResourceId: null,
            positionAssignmentId: a.id,
            valid: (assignmentValid.get(a.id) ?? false) && p.status === PolicyStatus.ACTIVE,
          });
        }
      }
    }

    // 3c. 分管推导:SupervisionAssignment → org-supervisor(BD-3 只读;与职务正交,不校验持职务 —— R5)
    if (memberId) {
      const supervisions = await this.prisma.organizationSupervisionAssignment.findMany({
        where: { supervisorMemberId: memberId, deletedAt: null },
        select: {
          id: true,
          organizationId: true,
          scopeMode: true,
          status: true,
          startedAt: true,
          endedAt: true,
        },
      });
      if (supervisions.length > 0) {
        const supervisorRole = await this.prisma.rbacRole.findFirst({
          where: { code: SUPERVISOR_ROLE_CODE, deletedAt: null },
          select: { id: true, code: true },
        });
        // 监督角色缺席(seed 异常)→ 分管源零产出(fail-close;分管人失去只读可见性但绝不越权)
        if (supervisorRole) {
          for (const s of supervisions) {
            grants.push({
              source: 'supervision',
              roleId: supervisorRole.id,
              roleCode: supervisorRole.code,
              scopeType:
                s.scopeMode === SupervisionScopeMode.TREE
                  ? BindingScopeType.ORGANIZATION_TREE
                  : BindingScopeType.ORGANIZATION,
              scopeOrgId: s.organizationId,
              scopeActivityId: null,
              scopeResourceType: null,
              scopeResourceId: null,
              supervisionAssignmentId: s.id,
              valid:
                s.status === SupervisionStatus.ACTIVE && isWithinTerm(s.startedAt, s.endedAt, now),
            });
          }
        }
      }
    }

    return grants;
  }

  // ============ covers(§5.2)============

  // scope 覆盖判定。ORGANIZATION / ORGANIZATION_TREE 要求 scope org ACTIVE 且未软删(失效 → inactive_org,
  // 不覆盖);TREE 判定 = scopeOrgId ∈ resource.organizationPath(closure 反查祖先链,含自身,与
  // EXISTS closure(ancestor,descendant) 等价)。资源无组织归属(organizationId=null)时 org 型 scope 恒不覆盖。
  private covers(
    grant: InternalGrant,
    resource: ResolvedResource,
    user: CurrentUserPayload,
    orgActiveById: ReadonlyMap<string, boolean>,
  ): CoverOutcome {
    switch (grant.scopeType) {
      case BindingScopeType.GLOBAL:
        return 'covered';
      case BindingScopeType.ORGANIZATION: {
        if (!grant.scopeOrgId || resource.organizationId !== grant.scopeOrgId) return 'not_covered';
        return orgActiveById.get(grant.scopeOrgId) ? 'covered' : 'inactive_org';
      }
      case BindingScopeType.ORGANIZATION_TREE: {
        if (!grant.scopeOrgId || !resource.organizationId) return 'not_covered';
        if (!(resource.organizationPath ?? []).includes(grant.scopeOrgId)) return 'not_covered';
        return orgActiveById.get(grant.scopeOrgId) ? 'covered' : 'inactive_org';
      }
      case BindingScopeType.ACTIVITY:
        return resource.activityId !== null && resource.activityId === grant.scopeActivityId
          ? 'covered'
          : 'not_covered';
      case BindingScopeType.RESOURCE:
        return resource.resourceType === grant.scopeResourceType &&
          resource.resourceId === grant.scopeResourceId
          ? 'covered'
          : 'not_covered';
      case BindingScopeType.SELF:
        return user.memberId !== null &&
          resource.ownerMemberId !== null &&
          resource.ownerMemberId === user.memberId
          ? 'covered'
          : 'not_covered';
      default:
        return 'not_covered';
    }
  }

  // 纯几何覆盖(不看 scope org 状态):仅用于 deny 归因 —— 判断某条**失效** grant「若在期是否本可覆盖」
  // (expired_grant reason)。绝不用于 allow。
  private coversGeometrically(
    grant: InternalGrant,
    resource: ResolvedResource,
    user: CurrentUserPayload,
  ): boolean {
    switch (grant.scopeType) {
      case BindingScopeType.GLOBAL:
        return true;
      case BindingScopeType.ORGANIZATION:
        return grant.scopeOrgId !== null && resource.organizationId === grant.scopeOrgId;
      case BindingScopeType.ORGANIZATION_TREE:
        return (
          grant.scopeOrgId !== null &&
          resource.organizationId !== null &&
          (resource.organizationPath ?? []).includes(grant.scopeOrgId)
        );
      case BindingScopeType.ACTIVITY:
        return resource.activityId !== null && resource.activityId === grant.scopeActivityId;
      case BindingScopeType.RESOURCE:
        return (
          resource.resourceType === grant.scopeResourceType &&
          resource.resourceId === grant.scopeResourceId
        );
      case BindingScopeType.SELF:
        return (
          user.memberId !== null &&
          resource.ownerMemberId !== null &&
          resource.ownerMemberId === user.memberId
        );
      default:
        return false;
    }
  }

  // scope org 的 ACTIVE/软删状态批量读(covers 用;一次 IN 查询)。
  private async loadOrgActiveStates(
    grants: readonly InternalGrant[],
  ): Promise<ReadonlyMap<string, boolean>> {
    const orgIds = [
      ...new Set(grants.map((g) => g.scopeOrgId).filter((id): id is string => id !== null)),
    ];
    if (orgIds.length === 0) return new Map();
    const rows = await this.prisma.organization.findMany({
      where: { id: { in: orgIds } },
      select: { id: true, status: true, deletedAt: true },
    });
    return new Map(
      rows.map((o) => [o.id, o.status === OrganizationStatus.ACTIVE && o.deletedAt === null]),
    );
  }

  // ============ ActionConstraint(§5.3)============

  // scope 命中后、返回前执行;对 SUPER_ADMIN 也生效(域不变量,非权限)。首个否决即 deny。
  private applyConstraints(
    decision: AuthzDecision,
    user: CurrentUserPayload,
    action: string,
    resource: ResolvedResource | null,
  ): AuthzDecision {
    for (const constraint of getConstraintsForAction(action)) {
      if (constraint.vetoes(user, resource)) {
        return { allow: false, reason: constraint.reason, resource: decision.resource };
      }
    }
    return decision;
  }

  // legacy `.self` 属主判定(authz 侧口径:ResolvedResource 的 owner 字段;镜像 rbac.checkOwnership 语义)。
  private ownsResource(user: CurrentUserPayload, resource: ResolvedResource): boolean {
    if (user.memberId !== null && resource.ownerMemberId === user.memberId) return true;
    return resource.ownerUserId !== null && resource.ownerUserId === user.id;
  }
}

// ============ 模块内纯函数 ============

function compareGrants(a: InternalGrant, b: InternalGrant): number {
  if (SOURCE_ORDER[a.source] !== SOURCE_ORDER[b.source]) {
    return SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
  }
  if (SCOPE_ORDER[a.scopeType] !== SCOPE_ORDER[b.scopeType]) {
    return SCOPE_ORDER[a.scopeType] - SCOPE_ORDER[b.scopeType];
  }
  return grantEntityId(a).localeCompare(grantEntityId(b));
}

function grantEntityId(g: InternalGrant): string {
  return g.bindingId ?? g.positionAssignmentId ?? g.supervisionAssignmentId ?? '';
}

function toMatchedGrant(g: InternalGrant): MatchedGrant {
  return {
    source: g.source,
    bindingId: g.bindingId,
    positionAssignmentId: g.positionAssignmentId,
    supervisionAssignmentId: g.supervisionAssignmentId,
    roleCode: g.roleCode,
    scopeType: g.scopeType,
    scopeId: g.scopeOrgId ?? g.scopeActivityId ?? g.scopeResourceId ?? undefined,
  };
}
