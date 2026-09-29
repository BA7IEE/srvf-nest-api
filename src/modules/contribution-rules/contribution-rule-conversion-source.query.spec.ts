import { Prisma } from '@prisma/client';
import { ContributionRuleConversionSourceQuery } from './contribution-rule-conversion-source.query';

describe('ContributionRuleConversionSourceQuery', () => {
  it('reads the active, non-deleted source set through the caller transaction in stable order', async () => {
    const row = {
      id: 'source-1',
      activityTypeCode: 'e2_fixture_example',
      attendanceRoleCode: 'volunteer',
      durationThreshold: new Prisma.Decimal('4.00'),
      pointsBelow: new Prisma.Decimal('1.00'),
      pointsAbove: null,
      status: 'ACTIVE',
      deletedAt: null,
      updatedAt: new Date('2026-09-25T00:00:00.000Z'),
    };
    const tx = { contributionRule: { findMany: jest.fn().mockResolvedValue([row]) } };

    await expect(
      new ContributionRuleConversionSourceQuery().readActiveSources(
        tx as unknown as Prisma.TransactionClient,
        'e2_fixture_example',
      ),
    ).resolves.toEqual([
      {
        id: 'source-1',
        activityTypeCode: 'e2_fixture_example',
        attendanceRoleCode: 'volunteer',
        durationThreshold: '4',
        pointsBelow: '1',
        pointsAbove: null,
        status: 'ACTIVE',
        deletedAt: null,
        updatedAt: '2026-09-25T00:00:00.000Z',
      },
    ]);
    expect(tx.contributionRule.findMany).toHaveBeenCalledWith({
      where: {
        activityTypeCode: 'e2_fixture_example',
        status: 'ACTIVE',
        deletedAt: null,
      },
      orderBy: [{ attendanceRoleCode: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        activityTypeCode: true,
        attendanceRoleCode: true,
        durationThreshold: true,
        pointsBelow: true,
        pointsAbove: true,
        status: true,
        deletedAt: true,
        updatedAt: true,
      },
    });
  });

  it('preserves an empty result without synthesizing a rule', async () => {
    const tx = { contributionRule: { findMany: jest.fn().mockResolvedValue([]) } };
    await expect(
      new ContributionRuleConversionSourceQuery().readActiveSources(
        tx as unknown as Prisma.TransactionClient,
        'e2_fixture_empty',
      ),
    ).resolves.toEqual([]);
  });
});
