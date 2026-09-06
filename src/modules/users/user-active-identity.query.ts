import { Prisma, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';

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
