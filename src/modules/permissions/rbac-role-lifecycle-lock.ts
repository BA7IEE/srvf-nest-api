import { Prisma } from '@prisma/client';

/**
 * Role 生命周期写协议的共同线性化点。
 *
 * RolePermission 整集替换与 Service Principal RoleBinding 的创建/恢复都必须先取这把锁。
 * 锁 `roles` 行而不是 `role_permissions` 行：临界区是「该 Role 的最终权限集及其机器绑定资格」。
 */
export async function lockRbacRoleLifecycle(
  tx: Prisma.TransactionClient,
  roleId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "roles" WHERE id = ${roleId} FOR UPDATE`;
}
