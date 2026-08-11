import { RBAC_SEED_FACTS } from './rbac-seed-facts';

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
// SA-only 能力(#399 F1 授权洞)。2026-07-13 起由 `isControlPlanePermissionCode()` 引用
// 本 SoT,与 `rbac.*` / `role-binding.*` 前缀合并后统一在授码与角色委派入口拦截。
//
// **单一事实来源**:`rbac-seed-facts.ts`。`prisma/seed.ts` 消费该事实生成 seed 目录；控制面
// 保留码与四个 seed e2e 也消费同一事实，方向恒为 seed → src，禁止 src → prisma。
// 漂移哨兵继续断言每条码都存在为 Permission 且未绑 ops-admin / biz-admin。
export const RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES: readonly string[] =
  RBAC_SEED_FACTS.contract.reservedSuperAdminOnlyPermissionCodes;

export const RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET: ReadonlySet<string> = new Set(
  RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES,
);
