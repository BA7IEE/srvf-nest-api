import { Prisma } from '@prisma/client';
import * as progress from '../team-join/team-join-progress';
import { ContributionMilestoneRecorder } from './contribution-milestone-recorder';

const application = {
  id: 'cm00000000000000000000001',
  memberId: 'cm00000000000000000000002',
  cycleId: 'cm00000000000000000000003',
  contributionNoticeProtocol: 1,
  cycle: { year: 2026 },
};
const snapshot = { ...application, beforePoints: new Prisma.Decimal(4) };

describe('contribution milestone corruption boundaries', () => {
  afterEach(() => jest.restoreAllMocks());
  function setup() {
    const enqueueMany = jest.fn();
    const createMany = jest.fn();
    const findMany = jest.fn().mockResolvedValue([]);
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: application.id }]),
      teamJoinApplication: { findMany: jest.fn().mockResolvedValue([application]) },
      teamJoinContributionMilestone: { findMany, createMany },
      participationLedgerEntry: { groupBy: jest.fn().mockResolvedValue([]) },
    } as unknown as Prisma.TransactionClient;
    const kernel = jest
      .spyOn(progress, 'computeContributionBatch')
      .mockResolvedValue(
        new Map([[application.memberId, { points: new Prisma.Decimal(5), satisfied: true }]]),
      );
    const service = new ContributionMilestoneRecorder(
      { enqueueMany } as never,
      { participationReadSource: () => 'committed-ledger' } as never,
    );
    return { tx, kernel, service, enqueueMany, createMany, findMany };
  }

  it('missing before/after kernel results abort; missing is not zero', async () => {
    const f = setup();
    f.kernel.mockResolvedValue(new Map());
    await expect(f.service.captureBefore(f.tx, [application.memberId])).rejects.toThrow(
      'CONTRIBUTION_MILESTONE_INVARIANT',
    );
    await expect(f.service.recordAfter(f.tx, 'batch', [snapshot])).rejects.toThrow(
      'CONTRIBUTION_MILESTONE_INVARIANT',
    );
    expect(f.enqueueMany).not.toHaveBeenCalled();
    expect(f.createMany).not.toHaveBeenCalled();
  });

  it.each(['NaN', 'Infinity'])(
    'invalid before score %s never registers an intent',
    async (value) => {
      const f = setup();
      await expect(
        f.service.recordAfter(f.tx, 'batch', [
          {
            ...snapshot,
            beforePoints: new Prisma.Decimal(value),
          },
        ]),
      ).rejects.toThrow('CONTRIBUTION_MILESTONE_INVARIANT');
      expect(f.kernel).not.toHaveBeenCalled();
      expect(f.enqueueMany).not.toHaveBeenCalled();
    },
  );

  it('a recrossing cannot silently accept a receipt with another semantic payload', async () => {
    const f = setup();
    f.findMany.mockResolvedValue([
      {
        applicationId: application.id,
        memberId: application.memberId,
        cycleId: application.cycleId,
        threshold: 5,
        beforePoints: new Prisma.Decimal(4),
        afterPoints: new Prisma.Decimal(5),
        outcomeCode: 'notice_registered',
        payloadVersion: 1,
        intentId: 'cm00000000000000000000004',
        payloadHash: '0'.repeat(64),
      },
    ]);
    await expect(f.service.recordAfter(f.tx, 'batch', [snapshot])).rejects.toThrow(
      'CONTRIBUTION_MILESTONE_INVARIANT',
    );
    expect(f.enqueueMany).not.toHaveBeenCalled();
    expect(f.createMany).not.toHaveBeenCalled();
  });

  it('a crossing without an entry belonging to its batch/member aborts', async () => {
    const f = setup();
    await expect(f.service.recordAfter(f.tx, 'batch', [snapshot])).rejects.toThrow(
      'CONTRIBUTION_MILESTONE_INVARIANT',
    );
    expect(f.enqueueMany).not.toHaveBeenCalled();
    expect(f.createMany).not.toHaveBeenCalled();
  });
});
