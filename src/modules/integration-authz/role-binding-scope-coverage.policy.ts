import { BindingScopeType } from '@prisma/client';
import { Injectable } from '@nestjs/common';

import type { DirectPrincipalGrant } from './direct-principal-authz.service';

/**
 * Integration Foundation v1 PR4(规格书 §17):scope coverage 共享 Policy。
 *
 * 「某个 grant 的 scope 是否覆盖目标资源」的判定 —— 与 User direct binding 语义一致
 * (规格书 §17 末段:「scope coverage 与 User direct binding 语义一致」)。
 *
 * ⭐ 纯函数判定矩阵在本体;**需要查库的组织 closure 与 scope 根组织有效性均以回调注入**
 * (lint 铁律:Policy 不碰 DB)。回调由 module factory 组装时绑定 PrismaService —— 判定
 * 语义本身零依赖,防两处各写一份后漂移(§68 风险表「Scope 逻辑复制漂移 P1」)。
 *
 * 判定矩阵(沿 AuthzService 对 User direct binding 的既有语义,不改任何现有行为):
 *   GLOBAL        → 恒覆盖
 *   ORGANIZATION  → 目标组织 === scopeOrgId ∩ scope 根组织 ACTIVE/live
 *   ORGANIZATION_TREE → 目标组织 ∈ closure(scopeOrgId)(含根;closure 由回调查)
 *                       ∩ scope 根组织 ACTIVE/live
 *   ACTIVITY      → 目标活动 === scopeActivityId
 *   RESOURCE      → resourceType+resourceId 双匹配
 *   SELF          → 恒不覆盖(调用侧应已过滤;这里再兜一道,纵深)
 */
export type OrganizationDescendantLookup = (
  ancestorId: string,
  descendantId: string,
) => Promise<boolean>;

export type OrganizationActiveLookup = (organizationId: string) => Promise<boolean>;

@Injectable()
export class RoleBindingScopeCoveragePolicy {
  constructor(
    private readonly isDescendant: OrganizationDescendantLookup,
    private readonly isOrganizationActive: OrganizationActiveLookup,
  ) {}

  async covers(
    grant: Pick<
      DirectPrincipalGrant,
      'scopeType' | 'scopeOrgId' | 'scopeActivityId' | 'scopeResourceType' | 'scopeResourceId'
    >,
    target: {
      organizationId?: string | null;
      activityId?: string | null;
      resourceType?: string | null;
      resourceId?: string | null;
    },
  ): Promise<boolean> {
    switch (grant.scopeType) {
      case BindingScopeType.GLOBAL:
        return true;
      case BindingScopeType.SELF:
        return false;
      case BindingScopeType.ORGANIZATION:
        if (grant.scopeOrgId === null || grant.scopeOrgId !== target.organizationId) return false;
        return this.isOrganizationActive(grant.scopeOrgId);
      case BindingScopeType.ORGANIZATION_TREE: {
        if (grant.scopeOrgId === null || target.organizationId == null) return false;
        if (
          grant.scopeOrgId !== target.organizationId &&
          !(await this.isDescendant(grant.scopeOrgId, target.organizationId))
        ) {
          return false;
        }
        return this.isOrganizationActive(grant.scopeOrgId);
      }
      case BindingScopeType.ACTIVITY:
        return grant.scopeActivityId !== null && grant.scopeActivityId === target.activityId;
      case BindingScopeType.RESOURCE:
        return (
          grant.scopeResourceType === target.resourceType &&
          grant.scopeResourceId === target.resourceId
        );
      default:
        return false;
    }
  }

  /** 批量:任一 grant 覆盖即 true(短路)。 */
  async anyCovers(
    grants: readonly Pick<
      DirectPrincipalGrant,
      'scopeType' | 'scopeOrgId' | 'scopeActivityId' | 'scopeResourceType' | 'scopeResourceId'
    >[],
    target: Parameters<RoleBindingScopeCoveragePolicy['covers']>[1],
  ): Promise<boolean> {
    for (const grant of grants) {
      if (await this.covers(grant, target)) return true;
    }
    return false;
  }
}
