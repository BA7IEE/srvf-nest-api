import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { AppIdentityResolver } from '../users/app-identity.resolver';
import { NotificationSubscriptionService } from './notification-subscription.service';

// 统一通知 S2:ack quota 封顶 +1 分支 + canUseApp 准入 unit(mock prisma;-1 原子 / 并发由 e2e 实库证)。

const USER = { id: 'u1', username: 'm', role: 'USER', status: 'ACTIVE', memberId: 'mem1' } as never;

function makeService(quota: {
  updateMany?: jest.Mock;
  create?: jest.Mock;
  findUnique?: jest.Mock;
  findMany?: jest.Mock;
}): { service: NotificationSubscriptionService; quotaMock: Record<string, jest.Mock> } {
  const quotaMock = {
    updateMany: quota.updateMany ?? jest.fn().mockResolvedValue({ count: 1 }),
    create: quota.create ?? jest.fn().mockResolvedValue({}),
    findUnique: quota.findUnique ?? jest.fn().mockResolvedValue({ availableCount: 1 }),
    findMany: quota.findMany ?? jest.fn().mockResolvedValue([]),
  };
  const prisma = { wechatSubscriptionQuota: quotaMock } as unknown as PrismaService;
  const appIdentity = {
    resolve: jest.fn().mockResolvedValue({ canUseApp: true, member: { id: 'mem1' } }),
  } as unknown as AppIdentityResolver;
  return { service: new NotificationSubscriptionService(prisma, appIdentity), quotaMock };
}

describe('NotificationSubscriptionService.ack (封顶 +1)', () => {
  it('已有行未达上限:条件 increment 命中(count=1),不 create', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const create = jest.fn();
    const findUnique = jest.fn().mockResolvedValue({ availableCount: 3 });
    const { service } = makeService({ updateMany, create, findUnique });
    const res = await service.ack(USER, ['t1']);
    expect(res.quotas).toEqual([{ templateId: 't1', availableCount: 3 }]);
    const [callArg] = updateMany.mock.calls[0] as [
      { where: { availableCount: { lt: number } }; data: unknown },
    ];
    expect(callArg.where.availableCount).toEqual({ lt: 5 }); // 条件封顶
    expect(callArg.data).toEqual({ availableCount: { increment: 1 } });
    expect(create).not.toHaveBeenCalled();
  });

  it('无行:首次 ack → create count=1', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const create = jest.fn().mockResolvedValue({});
    const findUnique = jest.fn().mockResolvedValue({ availableCount: 1 });
    const { service } = makeService({ updateMany, create, findUnique });
    const res = await service.ack(USER, ['t1']);
    expect(create).toHaveBeenCalledWith({
      data: { memberId: 'mem1', templateId: 't1', availableCount: 1 },
    });
    expect(res.quotas[0].availableCount).toBe(1);
  });

  it('达上限:updateMany 0 行 + create P2002 兜底再试 → 封顶不超(读回 cap)', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const create = jest.fn().mockRejectedValue(p2002);
    const findUnique = jest.fn().mockResolvedValue({ availableCount: 5 });
    const { service } = makeService({ updateMany, create, findUnique });
    const res = await service.ack(USER, ['t1']);
    expect(res.quotas[0].availableCount).toBe(5);
    expect(updateMany).toHaveBeenCalledTimes(2); // 首条件 increment + P2002 后重试条件 increment
  });

  it('多模板各算一次配额', async () => {
    const findUnique = jest
      .fn()
      .mockResolvedValueOnce({ availableCount: 2 })
      .mockResolvedValueOnce({ availableCount: 1 });
    const { service } = makeService({ findUnique });
    const res = await service.ack(USER, ['a', 'b']);
    expect(res.quotas).toEqual([
      { templateId: 'a', availableCount: 2 },
      { templateId: 'b', availableCount: 1 },
    ]);
  });

  it('canUseApp=false → 403 FORBIDDEN', async () => {
    const prisma = {
      wechatSubscriptionQuota: { updateMany: jest.fn(), create: jest.fn(), findUnique: jest.fn() },
    } as unknown as PrismaService;
    const appIdentity = {
      resolve: jest.fn().mockResolvedValue({ canUseApp: false, member: null }),
    } as unknown as AppIdentityResolver;
    const service = new NotificationSubscriptionService(prisma, appIdentity);
    await expect(service.ack(USER, ['t1'])).rejects.toEqual(new BizException(BizCode.FORBIDDEN));
  });
});

describe('NotificationSubscriptionService.status', () => {
  it('返各模板配额(无行=0)', async () => {
    const findMany = jest.fn().mockResolvedValue([{ templateId: 'a', availableCount: 4 }]);
    const { service } = makeService({ findMany });
    const res = await service.status(USER, ['a', 'b']);
    expect(res.quotas).toEqual([
      { templateId: 'a', availableCount: 4 },
      { templateId: 'b', availableCount: 0 },
    ]);
  });
});
