import { Prisma, Role } from '@prisma/client';

import type { PrismaService } from '../../database/prisma.service';
import type { RbacService } from '../permissions/rbac.service';
import type { AppIdentityResolver } from '../users/app-identity.resolver';
import { NotificationReadService } from './notification-read.service';

const USER = {
  id: 'user-1',
  username: 'reader',
  role: Role.USER,
  status: 'ACTIVE',
  memberId: 'member-1',
} as never;

function p2002(target: string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

function makeService(options?: { transactionError?: Error }) {
  const notificationReadCreate = jest.fn().mockResolvedValue({ id: 'read-1' });
  const notificationUpdate = jest.fn().mockResolvedValue({ id: 'notification-1', readCount: 1 });
  const tx = {
    notificationRead: { create: notificationReadCreate },
    notification: { update: notificationUpdate },
  };
  const transaction = options?.transactionError
    ? jest.fn().mockRejectedValue(options.transactionError)
    : jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));
  const prisma = {
    $transaction: transaction,
    memberOrganizationMembership: { findMany: jest.fn().mockResolvedValue([]) },
    notification: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'notification-1',
        audienceType: 'broadcast',
        statusCode: 'published',
        visibilityCode: 'member',
        visibleOrganizationIds: [],
        deletedAt: null,
      }),
      // 兼容红测前的旧实现；绿测后写操作必须只命中 transaction client。
      update: notificationUpdate,
    },
    notificationRead: { create: notificationReadCreate },
  } as unknown as PrismaService;
  const rbac = { can: jest.fn().mockResolvedValue(false) } as unknown as RbacService;
  const appIdentity = {
    resolve: jest.fn().mockResolvedValue({
      canUseApp: true,
      reason: null,
      member: { id: 'member-1', gradeCode: 'level-1' },
    }),
  } as unknown as AppIdentityResolver;
  return {
    service: new NotificationReadService(prisma, rbac, appIdentity),
    transaction,
    notificationReadCreate,
    notificationUpdate,
  };
}

describe('NotificationReadService.markRead 原子幂等', () => {
  it('首次已读在同一 transaction client 内 create read + increment count', async () => {
    const { service, transaction, notificationReadCreate, notificationUpdate } = makeService();

    await expect(service.markRead(USER, 'notification-1')).resolves.toEqual({ read: true });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(notificationReadCreate).toHaveBeenCalledWith({
      data: { notificationId: 'notification-1', memberId: 'member-1' },
    });
    expect(notificationUpdate).toHaveBeenCalledWith({
      where: { id: 'notification-1' },
      data: { readCount: { increment: 1 } },
    });
  });

  it('只吞 notificationId+memberId 唯一冲突，其他 P2002 原样上抛', async () => {
    const duplicate = makeService({
      transactionError: p2002(['notificationId', 'memberId']),
    });
    await expect(duplicate.service.markRead(USER, 'notification-1')).resolves.toEqual({
      read: true,
    });

    const unrelated = p2002(['otherUniqueField']);
    const other = makeService({ transactionError: unrelated });
    await expect(other.service.markRead(USER, 'notification-1')).rejects.toBe(unrelated);
  });
});
