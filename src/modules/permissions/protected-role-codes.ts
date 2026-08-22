/**
 * seed 内置 RbacRole 的 **API 运行时只读**保护单一真相。
 *
 * 角色仍由 prisma/seed.ts 分批 upsert；seed-rbac e2e 漂移哨兵保证这里的每一项都真实存在。
 *
 * 保护面(P1-32 PR 3a,2026-08-23 起为下列全部四项;此前只有第一项):
 *   - `rbac.role.delete`            软删角色            → 30104
 *   - `rbac.role.update`            改名 / 改描述        → 30107
 *   - `rbac.role-permission.create` 给角色加权限         → 30108
 *   - `rbac.role-permission.delete` 从角色撤权限         → 30108
 *
 * 🔴 **对 SUPER_ADMIN 同样关闭**,理由不是「权限过宽」而是「运行时可改本身就是设计错误」:
 *    org-readonly / group-readonly 的码集是从正职角色**过滤派生**的(见 permission-catalog
 *    的 isReadonlyProjectionCode),手改必被下次 seed 覆盖,或造出与派生链打架的第二份真相。
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

/**
 * 「这是不是系统内置角色」的**共享谓词** —— 上述四道闸一律锚在它身上。
 *
 * 刻意做成函数而不是让各处自己 `PROTECTED_ROLE_CODE_SET.has(...)`:
 * 机器判据(role-permissions-control-plane-gate.spec.ts)要认「某个写方法到底过没过闸」,
 * 锚点必须是一个**可被 AST 认出、且换掉它就等于另造判定**的单一符号。
 */
export function isProtectedRoleCode(code: string): boolean {
  return PROTECTED_ROLE_CODE_SET.has(code);
}
