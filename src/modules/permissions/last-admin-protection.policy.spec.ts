import { BindingScopeType, BindingStatus, PrincipalType } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  LAST_OPS_ADMIN_LOCK_KEY,
  LAST_SUPER_ADMIN_LOCK_KEY,
  LastAdminProtectionPolicy,
} from './last-admin-protection.policy';

function makeTx() {
  const $queryRaw = jest
    .fn<Promise<unknown>, [TemplateStringsArray, string]>()
    .mockResolvedValue([{ locked: '' }]);
  return {
    $queryRaw,
    roleBinding: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

function activeOpsBinding(userId = 'ops-1') {
  return {
    id: `binding-${userId}`,
    principalType: PrincipalType.USER,
    principalId: userId,
    scopeType: BindingScopeType.GLOBAL,
    status: BindingStatus.ACTIVE,
    role: { code: 'ops-admin' },
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

  it('last-ops-admin 绑定撤销：复用既有锁键，锁后只认 ACTIVE 用户持有人', async () => {
    const tx = makeTx();
    tx.roleBinding.findMany.mockResolvedValue([
      { principalId: 'ops-1' },
      { principalId: 'ops-disabled' },
    ]);
    tx.user.findMany.mockResolvedValue([{ id: 'ops-1' }]);

    await expect(
      policy.assertCanRemoveOpsAdminBinding(tx as never, activeOpsBinding('ops-1')),
    ).rejects.toEqual(new BizException(BizCode.LAST_OPS_ADMIN_PROTECTED));

    expect(tx.$queryRaw.mock.calls[0][1]).toBe(LAST_OPS_ADMIN_LOCK_KEY);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.roleBinding.findMany.mock.invocationCallOrder[0],
    );
  });

  it('禁用 ops-admin 用户：与绑定撤销取同一锁；仍有另一 ACTIVE 持有人则允许', async () => {
    const tx = makeTx();
    tx.roleBinding.findMany.mockResolvedValue([{ principalId: 'ops-1' }, { principalId: 'ops-2' }]);
    tx.user.findMany.mockResolvedValue([{ id: 'ops-1' }, { id: 'ops-2' }]);

    await expect(
      policy.assertCanDeactivateOpsAdminUser(tx as never, 'ops-1'),
    ).resolves.toBeUndefined();
    expect(tx.$queryRaw.mock.calls[0][1]).toBe(LAST_OPS_ADMIN_LOCK_KEY);
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
