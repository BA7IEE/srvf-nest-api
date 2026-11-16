import type { Prisma } from '@prisma/client';

import { nonDeletedMemberExists } from './member-existence-query';

describe('nonDeletedMemberExists', () => {
  it.each([
    [{ id: 'member-1' }, true],
    [null, false],
  ])('uses only the non-deleted identity lookup for %s', async (row, expected) => {
    const findFirst = jest.fn().mockResolvedValue(row);
    const client = { member: { findFirst } } as unknown as Pick<Prisma.TransactionClient, 'member'>;

    await expect(nonDeletedMemberExists(client, 'member-1')).resolves.toBe(expected);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'member-1', deletedAt: null },
      select: { id: true },
    });
  });
});
