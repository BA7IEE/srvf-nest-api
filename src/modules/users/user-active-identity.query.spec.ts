import { PrismaClient, Role, UserStatus } from '@prisma/client';
import { loadActiveUserIdentityInTx } from './user-active-identity.query';

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
