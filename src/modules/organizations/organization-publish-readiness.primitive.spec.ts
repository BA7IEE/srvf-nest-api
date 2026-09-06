import { OrganizationStatus, type Prisma } from '@prisma/client';
import {
  getActivityOrganizationEligibility,
  isActivityOrganizationResolvable,
} from './organization-publish-readiness.primitive';

describe('isActivityOrganizationResolvable', () => {
  it('只读取组织属主的最小当前事实', async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValue({ parentId: 'organization-parent', status: 'ACTIVE' });

    await expect(
      isActivityOrganizationResolvable({ organization: { findFirst } } as never, 'organization-a'),
    ).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'organization-a', deletedAt: null },
      select: { parentId: true, status: true },
    });
  });

  it.each([
    [null, false],
    [{ parentId: null, status: 'ACTIVE' }, false],
    [{ parentId: 'organization-parent', status: 'INACTIVE' }, false],
  ])('对缺失、根节点或 inactive 组织返回 %s', async (row, expected) => {
    const findFirst = jest.fn().mockResolvedValue(row);

    await expect(
      isActivityOrganizationResolvable({ organization: { findFirst } } as never, 'organization-a'),
    ).resolves.toBe(expected);
  });
});

describe('getActivityOrganizationEligibility', () => {
  it.each([
    [null, 'missing'],
    [{ parentId: null, status: OrganizationStatus.INACTIVE }, 'inactive'],
    [{ parentId: 'parent', status: OrganizationStatus.INACTIVE }, 'inactive'],
    [{ parentId: null, status: OrganizationStatus.ACTIVE }, 'root'],
    [{ parentId: 'parent', status: OrganizationStatus.ACTIVE }, 'eligible'],
  ] as const)(
    'returns only the eligibility reason and preserves rejection priority %#',
    async (row, expected) => {
      const findFirst = jest.fn().mockResolvedValue(row);
      const tx = { organization: { findFirst } } as unknown as Prisma.TransactionClient;
      await expect(getActivityOrganizationEligibility(tx, 'org')).resolves.toBe(expected);
      expect(findFirst).toHaveBeenCalledTimes(1);
      expect(findFirst).toHaveBeenCalledWith({
        where: { id: 'org', deletedAt: null },
        select: { parentId: true, status: true },
      });
    },
  );
  it('reads current eligibility on each call without retaining a previous result', async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce({ parentId: 'parent', status: OrganizationStatus.ACTIVE })
      .mockResolvedValueOnce({ parentId: 'parent', status: OrganizationStatus.INACTIVE });
    const tx = { organization: { findFirst } } as unknown as Prisma.TransactionClient;
    await expect(getActivityOrganizationEligibility(tx, 'org')).resolves.toBe('eligible');
    await expect(getActivityOrganizationEligibility(tx, 'org')).resolves.toBe('inactive');
    expect(findFirst).toHaveBeenCalledTimes(2);
  });
  it('propagates database failures for both the reason API and the existing boolean API', async () => {
    const failure = new Error('database unavailable');
    const findFirst = jest.fn().mockRejectedValue(failure);
    const tx = { organization: { findFirst } } as unknown as Prisma.TransactionClient;
    await expect(getActivityOrganizationEligibility(tx, 'org')).rejects.toBe(failure);
    await expect(isActivityOrganizationResolvable(tx, 'org')).rejects.toBe(failure);
  });
});
