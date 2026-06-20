// F1(全仓 review #399):role-permission.assign 分级闸的「SA-only 保留码」集合。
//
// 这 6 条权限点在 `prisma/seed.ts` 中**有意不绑**任何内置 RBAC 角色
// (biz-admin / ops-admin),语义上「仅 SUPER_ADMIN 短路通过」(D1=A / D2=A 范式):
//   - user.update.role                  改用户角色(seed D1=A,不绑 ops-admin)
//   - storage-setting.reset.credentials COS 凭证重置(seed D2=A,不绑 ops-admin)
//   - sms-setting.reset.credentials      SMS 凭证重置(镜像 D2=A,不绑 ops-admin)
//   - wechat-setting.reset.credentials   微信凭证重置(镜像 D2=A,不绑 ops-admin)
//   - realname-setting.reset.credentials 实名核验凭证重置(镜像 D2=A,不绑 ops-admin)
//   - member.delete.record               软删队员(评审稿 §6,不绑 biz-admin)
//
// 但 `RolePermissionsService.assign()` 此前只判 `rbac.role-permission.create`,
// **未阻止**持 ops-admin 的运营者把这些保留码"自授"给任意角色 → 间接获得
// SA-only 能力(#399 F1 授权洞)。`assertNoReservedCodesOrThrow` 在写入前显式拦截。
//
// **单一事实来源**:本集合与 seed「不绑」清单一一对应。改动 seed 的角色绑定矩阵
// (新增/重命名/改绑任一保留码)时**必须同步本集合**;`seed-rbac.e2e-spec.ts` 的
// 漂移哨兵会断言"本集合每一条都存在为 Permission 且未绑 ops-admin / biz-admin",
// 任一不符即红,守住二者不漂移。
export const RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES: readonly string[] = [
  'user.update.role',
  'storage-setting.reset.credentials',
  'sms-setting.reset.credentials',
  'wechat-setting.reset.credentials',
  'realname-setting.reset.credentials',
  'member.delete.record',
] as const;

export const RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET: ReadonlySet<string> = new Set(
  RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES,
);
