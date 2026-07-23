/**
 * seed 内置 RbacRole 的 API 删除保护单一真相。
 *
 * 角色仍由 prisma/seed.ts 分批 upsert；seed-rbac e2e 漂移哨兵保证这里的每一项都真实存在。
 */
export const PROTECTED_ROLE_CODES = [
  'ops-admin',
  'member',
  'biz-admin',
  'org-admin',
  'org-readonly',
  'group-manager',
  'group-readonly',
  'org-supervisor',
  'attendance-final-reviewer',
  'activity-publish-reviewer',
  'activity-cross-org-initiator',
  'attendance-first-reviewer',
  'activity-owner',
  'activity-registration-collaborator',
  'activity-attendance-collaborator',
] as const;

export const PROTECTED_ROLE_CODE_SET: ReadonlySet<string> = new Set(PROTECTED_ROLE_CODES);
