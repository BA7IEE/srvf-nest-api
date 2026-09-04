import { isActivityInitiatorResolvable } from './member-publish-readiness.primitive';

describe('isActivityInitiatorResolvable', () => {
  it('只读取当前 formal Member 与一个 live User 的最小事实', async () => {
    const findFirst = jest.fn().mockResolvedValue({
      gradeCode: 'level-1',
      users: [{ id: 'user-a' }],
    });

    await expect(
      isActivityInitiatorResolvable({ member: { findFirst } } as never, 'member-a'),
    ).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: 'member-a',
        deletedAt: null,
        status: 'ACTIVE',
      },
      select: {
        gradeCode: true,
        users: {
          where: { deletedAt: null, status: 'ACTIVE' },
          select: { id: true },
          take: 1,
        },
      },
    });
  });

  it('缺少指针时不查询 Member', async () => {
    const findFirst = jest.fn();

    await expect(
      isActivityInitiatorResolvable({ member: { findFirst } } as never, null),
    ).resolves.toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it.each([
    [null, false],
    [{ gradeCode: 'level-0', users: [{ id: 'user-a' }] }, false],
    [{ gradeCode: 'level-1', users: [] }, false],
  ])('对不可用的生命周期事实返回 %s', async (row, expected) => {
    const findFirst = jest.fn().mockResolvedValue(row);

    await expect(
      isActivityInitiatorResolvable({ member: { findFirst } } as never, 'member-a'),
    ).resolves.toBe(expected);
  });
});
