/**
 * 只能由活动责任投影器维护的内置角色。
 *
 * 通用 RoleBinding / legacy user-role 入口必须拒绝这些角色的人工授予、恢复、
 * 扩任期与撤销；业务事务内由 ActivityResponsibilityGrantProjector 直写绑定。
 */
export const SYSTEM_MANAGED_ROLE_CODES = [
  'activity-owner',
  'activity-registration-collaborator',
  'activity-attendance-collaborator',
] as const;

export const SYSTEM_MANAGED_ROLE_CODE_SET: ReadonlySet<string> = new Set(SYSTEM_MANAGED_ROLE_CODES);
