import { PrismaClient, Role, UserStatus } from '@prisma/client';
import {
  loadActiveUserIdentityInTx,
  lockUserMemberIdentityInTx,
} from './user-active-identity.query';

describe('User 属主显式关联共享锁', () => {
  const payload = { actorUserId: 'original_user', actorMemberId: 'original_member' };

  it('使用调用方事务与原联合 SQL，参数化绑定原执行人及成员，不改变锁类型或顺序', async () => {
    const tx = new PrismaClient();
    const query = jest.fn().mockResolvedValue([]);
    jest.spyOn(tx, '$queryRaw').mockImplementation(query);
    const read = jest.spyOn(tx.user, 'findFirst');
    const transaction = jest.spyOn(tx, '$transaction');
    try {
      await expect(lockUserMemberIdentityInTx(tx, payload)).resolves.toBeUndefined();
      expect(query).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledWith(
        [
          'SELECT u.id FROM "User" u JOIN "Member" m ON m.id = u."memberId"\n      WHERE u.id = ',
          ' AND m.id = ',
          ' FOR SHARE OF u, m',
        ],
        payload.actorUserId,
        payload.actorMemberId,
      );
      expect(read).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      await tx.$disconnect();
    }
  });

  it('每次调用重新取锁，不跨请求缓存；空结果仍由调用方后续身份检查裁决', async () => {
    const tx = new PrismaClient();
    const query = jest.fn().mockResolvedValue([]);
    jest.spyOn(tx, '$queryRaw').mockImplementation(query);
    try {
      await lockUserMemberIdentityInTx(tx, payload);
      await lockUserMemberIdentityInTx(tx, payload);
      expect(query).toHaveBeenCalledTimes(2);
    } finally {
      await tx.$disconnect();
    }
  });

  it('取锁失败原样抛出，不吞错、不回退为未加锁读取', async () => {
    const tx = new PrismaClient();
    const failure = new Error('lock failed');
    const query = jest.fn().mockRejectedValue(failure);
    jest.spyOn(tx, '$queryRaw').mockImplementation(query);
    try {
      await expect(lockUserMemberIdentityInTx(tx, payload)).rejects.toBe(failure);
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      await tx.$disconnect();
    }
  });
});

describe('User 属主事务身份读取', () => {
  const current = {
    id: 'current_user',
    username: 'current',
    role: Role.USER,
    status: UserStatus.ACTIVE,
    memberId: null,
  };

  it('只使用传入 client，精确筛选 ACTIVE 与未软删，仅读取安全身份字段', async () => {
    const tx = new PrismaClient();
    const findFirst = jest.fn().mockResolvedValue(current);
    jest.spyOn(tx.user, 'findFirst').mockImplementation(findFirst);
    try {
      expect(await loadActiveUserIdentityInTx(tx, current.id)).toEqual(current);
      expect(findFirst).toHaveBeenCalledTimes(1);
      expect(findFirst).toHaveBeenCalledWith({
        where: { id: current.id, status: UserStatus.ACTIVE, deletedAt: null },
        select: { id: true, username: true, role: true, status: true, memberId: true },
      });
    } finally {
      await tx.$disconnect();
    }
  });

  it('每次重新查询，当前身份失效时返回 null，不复用旧结果', async () => {
    const tx = new PrismaClient();
    const findFirst = jest.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(null);
    jest.spyOn(tx.user, 'findFirst').mockImplementation(findFirst);
    try {
      expect(await loadActiveUserIdentityInTx(tx, current.id)).toEqual(current);
      expect(await loadActiveUserIdentityInTx(tx, current.id)).toBeNull();
      expect(findFirst).toHaveBeenCalledTimes(2);
    } finally {
      await tx.$disconnect();
    }
  });

  it('数据库异常原样交给调用者，不伪装成无身份', async () => {
    const tx = new PrismaClient();
    const failure = new Error('database unavailable');
    jest.spyOn(tx.user, 'findFirst').mockImplementation(jest.fn().mockRejectedValue(failure));
    try {
      await expect(loadActiveUserIdentityInTx(tx, current.id)).rejects.toBe(failure);
    } finally {
      await tx.$disconnect();
    }
  });
});
