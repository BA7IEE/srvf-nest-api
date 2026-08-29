import { Injectable } from '@nestjs/common';
import {
  DelegationGrantStatus,
  Prisma,
  PrincipalType,
  Role,
  ServicePrincipalStatus,
  UserStatus,
} from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import type { ResourceRef } from '../authz/authz.types';
import { DirectPrincipalAuthzService } from '../integration-authz/direct-principal-authz.service';
import { RoleBindingScopeCoveragePolicy } from '../integration-authz/role-binding-scope-coverage.policy';
import { DelegationPermissionEligibilityService } from '../permissions/delegation-permission-eligibility.service';

type PrismaTx = Prisma.TransactionClient;

export interface DelegationScopeTarget {
  organizationId?: string | null;
  activityId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
}

/** Delegated Token 签发所需的、已锁定为数据库事实的最小身份快照。 */
export interface IssuableDelegationGrant {
  subjectUserId: string;
  subjectUserRole: Role;
  credentialExpiresAt: Date | null;
  grantEndsAt: Date | null;
}

/**
 * Integration Foundation v1 PR5(规格书 §19/§20/§61;T0 冻结稿 §11):
 * DelegationGrant runtime validity + Delegated Token 三腿交集。
 *
 * User 一腿必须调用既有 AuthzService；不能退化为 RbacService 的 GLOBAL-only 旧读面。
 * resourceRef 存在时，Grant/SP 的 scope 目标一律从 AuthzService 已解析的资源派生，
 * 不信任调用方手填的 target。
 */
export interface DelegatedPermissionsResult {
  allowed: boolean;
  reason:
    | 'sp-not-found'
    | 'sp-suspended'
    | 'credential-invalid'
    | 'grant-not-found'
    | 'grant-expired'
    | 'grant-revoked'
    | 'grant-wrong-sp'
    | 'permission-not-in-grant'
    | 'permission-not-delegatable'
    | 'grant-scope-not-covering'
    | 'user-inactive'
    | 'sp-no-permission'
    | 'user-no-permission'
    | 'allowed'
    | null;
}

@Injectable()
export class DelegationGrantRuntimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly directAuthz: DirectPrincipalAuthzService,
    private readonly coverage: RoleBindingScopeCoveragePolicy,
    private readonly authz: AuthzService,
    private readonly delegationPermissions: DelegationPermissionEligibilityService,
  ) {}

  /**
   * 签发 Delegated Token 前的身份链复查（§14/§19）。
   * 此时尚未有具体业务 action/resource，因此只验证 SP、Credential、Grant、User 的即时有效性；
   * 每个真实请求仍须由 judgeDelegated() 完成三腿权限与范围交集。
   */
  async findIssuableGrant(
    input: {
      servicePrincipalId: string;
      credentialId: string;
      delegationGrantId: string;
    },
    now: Date = new Date(),
    client?: PrismaTx,
  ): Promise<IssuableDelegationGrant | null> {
    const db = client ?? this.prisma;
    const servicePrincipal = await db.servicePrincipal.findFirst({
      where: { id: input.servicePrincipalId, deletedAt: null },
      select: { status: true },
    });
    if (servicePrincipal?.status !== ServicePrincipalStatus.ACTIVE) return null;

    const credential = await db.servicePrincipalCredential.findFirst({
      where: {
        id: input.credentialId,
        servicePrincipalId: input.servicePrincipalId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { expiresAt: true },
    });
    if (credential === null) return null;

    const grant = await db.delegationGrant.findFirst({
      where: { id: input.delegationGrantId },
      select: {
        servicePrincipalId: true,
        subjectUserId: true,
        status: true,
        startedAt: true,
        endedAt: true,
        revokedAt: true,
      },
    });
    if (
      grant === null ||
      grant.servicePrincipalId !== input.servicePrincipalId ||
      grant.status !== DelegationGrantStatus.ACTIVE ||
      grant.revokedAt !== null ||
      grant.startedAt.getTime() > now.getTime() ||
      (grant.endedAt !== null && grant.endedAt.getTime() <= now.getTime())
    ) {
      return null;
    }

    const subjectUser = await db.user.findFirst({
      where: { id: grant.subjectUserId, deletedAt: null, status: UserStatus.ACTIVE },
      select: { id: true, role: true },
    });
    if (subjectUser === null) return null;

    return {
      subjectUserId: subjectUser.id,
      subjectUserRole: subjectUser.role,
      credentialExpiresAt: credential.expiresAt,
      grantEndsAt: grant.endedAt,
    };
  }

  /**
   * 判「SP 通过某 Grant 代表某 User 执行某 action」是否放行。
   * 三腿交集(§16.2):SP 权限/范围 ∩ User 当前 Authz 权限/范围 ∩ Grant 权限/范围，全过才 allowed。
   */
  async judgeDelegated(
    input: {
      servicePrincipalId: string;
      credentialId: string;
      delegationGrantId: string;
      action: string;
      /** PR6 业务面必须传入；有它时 target 仅为兼容旧探针，永不参与最终 scope 判定。 */
      resourceRef?: ResourceRef;
      target?: DelegationScopeTarget;
    },
    now: Date = new Date(),
    client?: PrismaTx,
  ): Promise<DelegatedPermissionsResult> {
    const db = client ?? this.prisma;

    // ① SP ACTIVE 且未软删。
    const servicePrincipal = await db.servicePrincipal.findFirst({
      where: { id: input.servicePrincipalId, deletedAt: null },
      select: { status: true },
    });
    if (servicePrincipal === null) return { allowed: false, reason: 'sp-not-found' };
    if (servicePrincipal.status !== ServicePrincipalStatus.ACTIVE) {
      return { allowed: false, reason: 'sp-suspended' };
    }

    // ② Credential ACTIVE 且未过期。
    const credential = await db.servicePrincipalCredential.findFirst({
      where: {
        id: input.credentialId,
        servicePrincipalId: input.servicePrincipalId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { id: true },
    });
    if (credential === null) return { allowed: false, reason: 'credential-invalid' };

    // ③ Grant ACTIVE、未撤销、在期、属于当前 SP。
    const grant = await db.delegationGrant.findFirst({
      where: { id: input.delegationGrantId },
      select: {
        id: true,
        servicePrincipalId: true,
        subjectUserId: true,
        status: true,
        startedAt: true,
        endedAt: true,
        revokedAt: true,
        scopeType: true,
        scopeOrgId: true,
        scopeActivityId: true,
        scopeResourceType: true,
        scopeResourceId: true,
      },
    });
    if (grant === null) return { allowed: false, reason: 'grant-not-found' };
    if (grant.revokedAt !== null || grant.status !== DelegationGrantStatus.ACTIVE) {
      return { allowed: false, reason: 'grant-revoked' };
    }
    if (grant.servicePrincipalId !== input.servicePrincipalId) {
      return { allowed: false, reason: 'grant-wrong-sp' };
    }
    if (
      grant.startedAt.getTime() > now.getTime() ||
      (grant.endedAt !== null && grant.endedAt.getTime() <= now.getTime())
    ) {
      return { allowed: false, reason: 'grant-expired' };
    }

    // ④ Permission 必须在 Grant allowlist。刻意拆成顶层查询，避免跨域 nested relation 读被动态判据吞掉。
    const grantPermissions = await db.delegationGrantPermission.findMany({
      where: { grantId: grant.id },
      select: { permissionId: true },
    });
    const permissionIds = grantPermissions.map((row) => row.permissionId);
    const permission = await this.delegationPermissions.findFlagsForGrant(
      permissionIds,
      input.action,
      client,
    );
    if (permission === null) return { allowed: false, reason: 'permission-not-in-grant' };

    // ⑤ delegatedAccessAllowed（同时显式确认 SP eligibility，不能只依赖 migration CHECK）。
    if (!permission.delegatedAccessAllowed) {
      return { allowed: false, reason: 'permission-not-delegatable' };
    }
    if (!permission.servicePrincipalAllowed) return { allowed: false, reason: 'sp-no-permission' };

    // ⑥ Subject User ACTIVE 且未软删，并构成当前 Authz 的唯一输入身份。
    const subjectUser = await db.user.findFirst({
      where: { id: grant.subjectUserId, deletedAt: null, status: UserStatus.ACTIVE },
      select: { id: true, username: true, role: true, status: true, memberId: true },
    });
    if (subjectUser === null) return { allowed: false, reason: 'user-inactive' };
    const subject: CurrentUserPayload = subjectUser;

    // ⑦ User 一腿：现有 AuthzService（含 scoped RoleBinding / 职务 / 分管 / ActionConstraint）。
    const userDecision = await this.authz.explain(subject, input.action, input.resourceRef);
    if (!userDecision.allow) return { allowed: false, reason: 'user-no-permission' };

    // resourceRef 存在时，以 Authz 已解析的真实归属覆盖调用方 target，阻断 scope 注入。
    const target = this.targetFromDecision(userDecision.resource, input.target);

    // ⑧ Grant Scope 覆盖目标。
    const grantCovers = await this.coverage.covers(
      {
        scopeType: grant.scopeType,
        scopeOrgId: grant.scopeOrgId,
        scopeActivityId: grant.scopeActivityId,
        scopeResourceType: grant.scopeResourceType,
        scopeResourceId: grant.scopeResourceId,
      },
      target,
    );
    if (!grantCovers) return { allowed: false, reason: 'grant-scope-not-covering' };

    // ⑨ SP 一腿：direct binding + eligibility，零 SUPER_ADMIN/职务/分管旁路。
    const spDecision = await this.directAuthz.explainDirect(
      { principalType: PrincipalType.SERVICE_PRINCIPAL, principalId: input.servicePrincipalId },
      input.action,
      now,
      db,
    );
    if (!spDecision.allowed) return { allowed: false, reason: 'sp-no-permission' };

    // ⑩ SP scope 覆盖。
    const spCovers = await this.coverage.anyCovers(spDecision.matched, target);
    if (!spCovers) return { allowed: false, reason: 'sp-no-permission' };

    // ⑪ 三腿交集成立。
    return { allowed: true, reason: 'allowed' };
  }

  private targetFromDecision(
    resource:
      | {
          organizationId: string | null;
          activityId: string | null;
          resourceType: string;
          resourceId: string;
        }
      | undefined,
    fallback: DelegationScopeTarget | undefined,
  ): DelegationScopeTarget {
    if (resource !== undefined) {
      return {
        organizationId: resource.organizationId,
        activityId: resource.activityId,
        resourceType: resource.resourceType,
        resourceId: resource.resourceId,
      };
    }
    return fallback ?? {};
  }
}
