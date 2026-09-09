import type { Prisma } from '@prisma/client';
import { readCurrentConfirmedOutcomeInTx } from './activity-outcome-confirmed-query.service';

describe('C3-2 current formal selector', () => {
  function fixture(
    rows: { id: string; activityId: string; statusCode: string; revision: number }[],
  ) {
    const findMany = jest.fn(
      (query: { where: { activityId: string; statusCode: string }; take: number }) =>
        Promise.resolve(
          rows
            .filter(
              (row) =>
                row.activityId === query.where.activityId &&
                row.statusCode === query.where.statusCode,
            )
            .slice(0, query.take),
        ),
    );
    const tx = { activityOutcomeRevision: { findMany } } as unknown as Prisma.TransactionClient;
    return { tx, findMany };
  }
  it('selects the existing formal revision while a newer correction draft exists', async () => {
    const formal = { id: 'formal', activityId: 'activity', statusCode: 'confirmed', revision: 2 };
    const f = fixture([
      { id: 'draft', activityId: 'activity', statusCode: 'draft', revision: 3 },
      formal,
      { ...formal, id: 'foreign', activityId: 'other', revision: 9 },
    ]);
    await expect(readCurrentConfirmedOutcomeInTx(f.tx, 'activity')).resolves.toEqual(formal);
    expect(f.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { activityId: 'activity', statusCode: 'confirmed' },
        take: 2,
      }),
    );
  });
  it('returns null instead of substituting a draft', async () => {
    const f = fixture([{ id: 'draft', activityId: 'activity', statusCode: 'draft', revision: 1 }]);
    await expect(readCurrentConfirmedOutcomeInTx(f.tx, 'activity')).resolves.toBeNull();
  });
  it('fails closed on two formal heads instead of choosing one', async () => {
    const f = fixture(
      [1, 2].map((revision) => ({
        id: `formal-${revision}`,
        activityId: 'activity',
        statusCode: 'confirmed',
        revision,
      })),
    );
    await expect(readCurrentConfirmedOutcomeInTx(f.tx, 'activity')).rejects.toThrow();
  });
});
