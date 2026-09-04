import { isActivityOrganizationResolvable } from './organization-publish-readiness.primitive';

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
