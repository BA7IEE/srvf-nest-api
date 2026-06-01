import { Role } from '@prisma/client';

// V1.2:用户管理权限策略集中文件。
// UsersService 内不得再散落角色判断,所有"谁能操作谁"的决策都走本文件的纯函数。
//
// 设计要点(对齐 ARCHITECTURE.md §7.11 / CLAUDE.md §13):
//   - 三层 Role:SUPER_ADMIN > ADMIN > USER,不是 RBAC,不扩展 permission 表
//   - 业务 API 永远不能创建 / 提升至 SUPER_ADMIN(只有 prisma/seed.ts 能)
//   - SUPER_ADMIN 可管理任何角色(含其他 SUPER_ADMIN);自我保护与最后一个保护
//     不在本文件,由 service 在事务内单独校验
//   - 函数全部为无副作用的纯布尔判定,便于单测与未来策略扩展

// 谁能"看到"谁:列表与详情可见性
//   - SUPER_ADMIN:可看全部角色
//   - ADMIN:仅能看到 USER
//   - USER:不能进入管理可见范围
export function canViewUser(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === Role.SUPER_ADMIN) return true;
  if (actorRole === Role.ADMIN) return targetRole === Role.USER;
  return false;
}

// 谁能"管理"谁:改资料 / 重置密码 / 改角色 / 改状态 / 软删除
//   - SUPER_ADMIN:可管理任何角色
//   - ADMIN:仅能管理 USER
//   - 其他:不能
// 与 canViewUser 完全一致,但语义不同——管理是"修改类"操作,
// 拆开两个函数让调用点自解释、未来若策略分化也无需重写调用点。
export function canManageUser(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === Role.SUPER_ADMIN) return true;
  if (actorRole === Role.ADMIN) return targetRole === Role.USER;
  return false;
}

// 创建用户时,actorRole 是否允许把 role 字段设置为 targetRole
//   - 业务 API 永远不能创建 SUPER_ADMIN
//   - SUPER_ADMIN:可创建 ADMIN / USER
//   - ADMIN:只能创建 USER
export function canCreateRole(actorRole: Role, targetRole: Role): boolean {
  if (targetRole === Role.SUPER_ADMIN) return false;
  if (actorRole === Role.SUPER_ADMIN) return true;
  if (actorRole === Role.ADMIN) return targetRole === Role.USER;
  return false;
}

// 改角色接口 PATCH /api/admin/v1/users/:id/role:actorRole 是否允许把别人改成 newRole
//   - 业务 API 禁止把任何人设成 SUPER_ADMIN(包括 SUPER_ADMIN 自己也不能再签发新 SUPER_ADMIN)
//   - 仅 SUPER_ADMIN 可改角色;controller 已经 @Roles(SUPER_ADMIN),本函数提供纵深防御
export function canChangeRole(actorRole: Role, newRole: Role): boolean {
  if (newRole === Role.SUPER_ADMIN) return false;
  return actorRole === Role.SUPER_ADMIN;
}
