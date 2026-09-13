import { Prisma, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';

// 显式锁原执行人的 User/Member 关联；使用调用方事务，保持既有联合 FOR SHARE。
// 不读取或缓存身份，不替代调用方锁后的当前资格与权限检查。
export async function lockUserMemberIdentityInTx(
  tx: Prisma.TransactionClient,
  payload: { actorUserId: string; actorMemberId: string },
): Promise<void> {
  await tx.$queryRaw`SELECT u.id FROM "User" u JOIN "Member" m ON m.id = u."memberId"
      WHERE u.id = ${payload.actorUserId} AND m.id = ${payload.actorMemberId} FOR SHARE OF u, m`;
}

// User 属主的安全身份读取原语；调用者显式传入正在使用的事务。
// 不取隐式锁、不新建事务、不缓存，也不替代调用者的 RBAC 判权。
export function loadActiveUserIdentityInTx(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<CurrentUserPayload | null> {
  return tx.user.findFirst({
    where: notDeletedWhere({ id: userId, status: UserStatus.ACTIVE }),
    select: { id: true, username: true, role: true, status: true, memberId: true },
  });
}
