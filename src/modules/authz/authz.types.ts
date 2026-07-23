import type { BindingScopeType } from '@prisma/client';

// 终态 scoped-authz PR8(2026-07-02;冻结稿 §5.1 / §5.2):authz 模块公共类型。
// 本文件只声明形状,不含任何判权逻辑;全部落在本模块目录内(architecture-boundary §7,不进 common/)。

// ============ ResourceRef(§5.2 入参)============

// 业务侧引用一个资源的最小形状:type ∈ ResourceResolver 支持的 13 类(见 resource-resolver.service.ts),
// id = 该资源主键。消费者(PR9 起)在调用 authz.can/explain 时构造。
export interface ResourceRef {
  type: string;
  id: string;
}

// ============ ResolvedResource(§5.1 统一输出结构)============

export type ResourceSensitivityLevel = 'public' | 'internal' | 'sensitive';

// ResourceResolver 的统一输出:资源归属组织 / 属主 / 活动 / 状态 / 敏感级 hint。
// 解析失败(资源不存在 / 已软删 / 未知类型)→ resolve() 返 null,授权侧 fail-close(deny resource_not_found)。
export interface ResolvedResource {
  resourceType: string;
  resourceId: string;
  // 资源归属组织(授权 scope 主键);无组织归属的资源(如 recruitment_application)恒 null → 仅 GLOBAL 可覆盖
  organizationId: string | null;
  // 祖先链(closure 反查,root 在前、含自身;tree 判定 + 可解释性用);organizationId 为 null 时为 null
  organizationPath: string[] | null;
  // 资源属主 member(SELF scope / legacy `.self` ownership 判定)
  ownerMemberId: string | null;
  ownerUserId: string | null;
  // activity scope 判定
  activityId: string | null;
  // 业务状态(部分 ActionConstraint / 展示用;不参与 scope 判定)
  statusCode: string | null;
  // 敏感分级 hint(权限码粒度仍是权威,§4.2;此处仅 hint)
  sensitivityLevel: ResourceSensitivityLevel | null;
  // 域特定附加(自审等约束用,不污染主结构):如 attendance_sheet 的
  // { submitterUserId, lastSubmittedByUserId, reviewerUserId }
  extra?: Record<string, unknown>;
}

// ============ AuthzDecision(§5.2 返回结构)============

export type AuthzAllowReason = 'super_admin_pass' | 'matched';

export type AuthzDenyReason =
  | 'no_permission'
  | 'out_of_scope'
  | 'out_of_supervised_scope'
  | 'expired_grant'
  | 'inactive_org'
  | 'self_approval_forbidden'
  | 'same_reviewer_forbidden'
  | 'sensitive_denied'
  | 'resource_not_found';

export type AuthzReason = AuthzAllowReason | AuthzDenyReason;

export type GrantSource = 'super_admin' | 'role_binding' | 'position' | 'supervision';

// 命中时:谁因哪条授权、在什么范围被允许(可解释性核心;§5.2 matchedGrant)。
// source=role_binding → bindingId;position → positionAssignmentId;supervision → supervisionAssignmentId;
// super_admin → 仅 source + scopeType=GLOBAL。scopeId 按 scopeType 取 org / activity / resource 主键。
export interface MatchedGrant {
  source: GrantSource;
  bindingId?: string;
  positionAssignmentId?: string;
  supervisionAssignmentId?: string;
  roleCode?: string;
  scopeType: BindingScopeType;
  scopeId?: string;
}

export interface AuthzDecision {
  allow: boolean;
  reason: AuthzReason;
  matchedGrant?: MatchedGrant;
  resource?: ResolvedResource;
}
