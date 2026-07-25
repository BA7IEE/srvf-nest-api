import { BindingScopeType, BindingStatus, PrincipalType } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  LAST_OPS_ADMIN_LOCK_KEY,
  LAST_SUPER_ADMIN_LOCK_KEY,
  LastAdminProtectionPolicy,
} from './last-admin-protection.policy';

interface OpsAdminValidityWhere {
  principalType: PrincipalType;
  scopeType: BindingScopeType;
  status: BindingStatus;
  startedAt: { lte: Date };
  OR: Array<{ endedAt: null } | { endedAt: { gte: Date } }>;
  deletedAt: null;
  role: { code: string; deletedAt: null };
}

function makeTx() {
  const $queryRaw = jest
    .fn<Promise<unknown>, [TemplateStringsArray, string]>()
    .mockResolvedValue([{ locked: '' }]);
  return {
    $queryRaw,
    roleBinding: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest
        .fn<
          Promise<Array<{ principalId: string | null; endedAt: Date | null }>>,
          [{ where: OpsAdminValidityWhere }]
        >()
        .mockResolvedValue([]),
    },
    user: {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

function activeOpsBinding(userId = 'ops-1') {
  const now = new Date();
  return {
    id: `binding-${userId}`,
    principalType: PrincipalType.USER,
    principalId: userId,
    scopeType: BindingScopeType.GLOBAL,
    status: BindingStatus.ACTIVE,
    startedAt: new Date(now.getTime() - 60_000),
    endedAt: null,
    deletedAt: null,
    role: { code: 'ops-admin', deletedAt: null },
  };
}

describe('LastAdminProtectionPolicy', () => {
  const policy = new LastAdminProtectionPolicy();

  it('last-SUPER_ADMIN：先取稳定 advisory lock，再计数并拒绝归零', async () => {
    const tx = makeTx();
    tx.user.count.mockResolvedValue(0);

    await expect(policy.assertCanRemoveSuperAdmin(tx as never, 'super-admin-1')).rejects.toEqual(
      new BizException(BizCode.LAST_SUPER_ADMIN_PROTECTED),
    );

    expect(tx.$queryRaw.mock.calls[0][1]).toBe(LAST_SUPER_ADMIN_LOCK_KEY);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.user.count.mock.invocationCallOrder[0],
    );
  });

  it('last-ops-admin 绑定撤销：锁后重读并按当前有效 + 常驻两集合拒绝归零', async () => {
    const tx = makeTx();
    tx.roleBinding.findFirst.mockResolvedValue(activeOpsBinding('ops-1'));
    tx.roleBinding.findMany.mockResolvedValue([
      { principalId: 'ops-1', endedAt: null },
      { principalId: 'ops-disabled', endedAt: null },
    ]);
    tx.user.findMany.mockResolvedValue([{ id: 'ops-1' }]);

    await expect(
      policy.assertCanRemoveOpsAdminBinding(tx as never, activeOpsBinding('ops-1')),
    ).rejects.toEqual(new BizException(BizCode.LAST_OPS_ADMIN_PROTECTED));

    expect(tx.$queryRaw.mock.calls[0][1]).toBe(LAST_OPS_ADMIN_LOCK_KEY);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.roleBinding.findFirst.mock.invocationCallOrder[0],
    );
    const where = tx.roleBinding.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      principalType: PrincipalType.USER,
      scopeType: BindingScopeType.GLOBAL,
      status: BindingStatus.ACTIVE,
      deletedAt: null,
      role: { code: 'ops-admin', deletedAt: null },
    });
    expect(where.startedAt.lte).toBeInstanceOf(Date);
    expect(where.OR[0]).toEqual({ endedAt: null });
    const endRange = where.OR.find(({ endedAt }) => endedAt !== null);
    expect(endRange?.endedAt).not.toBeNull();
    if (endRange?.endedAt === null || endRange === undefined) {
      throw new Error('expected endedAt current-term range');
    }
    expect(endRange.endedAt.gte).toBeInstanceOf(Date);
  });

  it.each([
    [
      'future',
      {
        ...activeOpsBinding('ops-future'),
        startedAt: new Date(Date.now() + 60_000),
      },
    ],
    [
      'expired',
      {
        ...activeOpsBinding('ops-expired'),
        endedAt: new Date(Date.now() - 60_000),
      },
    ],
  ])('移除 %s target：锁后确认其不在 holder 集合则允许清理', async (_label, target) => {
    const tx = makeTx();
    tx.roleBinding.findFirst.mockResolvedValue(target);

    await expect(
      policy.assertCanRemoveOpsAdminBinding(tx as never, target),
    ).resolves.toBeUndefined();
  });

  it('禁用 ops-admin 用户：与绑定撤销取同一锁；仍有另一 ACTIVE 持有人则允许', async () => {
    const tx = makeTx();
    tx.roleBinding.findMany.mockResolvedValue([
      { principalId: 'ops-1', endedAt: null },
      { principalId: 'ops-2', endedAt: null },
    ]);
    tx.user.findMany.mockResolvedValue([{ id: 'ops-1' }, { id: 'ops-2' }]);

    await expect(
      policy.assertCanDeactivateOpsAdminUser(tx as never, 'ops-1'),
    ).resolves.toBeUndefined();
    expect(tx.$queryRaw.mock.calls[0][1]).toBe(LAST_OPS_ADMIN_LOCK_KEY);
  });

  it('禁用唯一常驻 holder：即使还有有效临时 holder，也因 permanent 归零而拒绝', async () => {
    const tx = makeTx();
    tx.roleBinding.findMany.mockResolvedValue([
      { principalId: 'ops-permanent', endedAt: null },
      { principalId: 'ops-temporary', endedAt: new Date(Date.now() + 60_000) },
    ]);
    tx.user.findMany.mockResolvedValue([{ id: 'ops-permanent' }, { id: 'ops-temporary' }]);

    await expect(
      policy.assertCanDeactivateOpsAdminUser(tx as never, 'ops-permanent'),
    ).rejects.toEqual(new BizException(BizCode.LAST_OPS_ADMIN_PROTECTED));
  });

  it('把唯一常驻 binding 改为有限 endedAt：当前仍有效也因 permanent 归零而拒绝', async () => {
    const tx = makeTx();
    const target = activeOpsBinding('ops-permanent');
    tx.roleBinding.findFirst.mockResolvedValue(target);
    tx.roleBinding.findMany.mockResolvedValue([{ principalId: 'ops-permanent', endedAt: null }]);
    tx.user.findMany.mockResolvedValue([{ id: 'ops-permanent' }]);

    await expect(
      policy.assertCanUpdateOpsAdminBinding(tx as never, target, {
        endedAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toEqual(new BizException(BizCode.LAST_OPS_ADMIN_PROTECTED));
  });

  it('存在另一常驻 holder 时：当前 binding 改有限 endedAt 允许', async () => {
    const tx = makeTx();
    const target = activeOpsBinding('ops-1');
    tx.roleBinding.findFirst.mockResolvedValue(target);
    tx.roleBinding.findMany.mockResolvedValue([
      { principalId: 'ops-1', endedAt: null },
      { principalId: 'ops-2', endedAt: null },
    ]);
    tx.user.findMany.mockResolvedValue([{ id: 'ops-1' }, { id: 'ops-2' }]);

    await expect(
      policy.assertCanUpdateOpsAdminBinding(tx as never, target, {
        endedAt: new Date(Date.now() + 60_000),
      }),
    ).resolves.toBeUndefined();
  });

  it('禁用非 ops-admin 用户：仍先取同一锁，锁后确认不影响持有人', async () => {
    const tx = makeTx();

    await expect(
      policy.assertCanDeactivateOpsAdminUser(tx as never, 'plain-user'),
    ).resolves.toBeUndefined();
    expect(tx.$queryRaw.mock.calls[0][1]).toBe(LAST_OPS_ADMIN_LOCK_KEY);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.roleBinding.findMany.mock.invocationCallOrder[0],
    );
  });
});
