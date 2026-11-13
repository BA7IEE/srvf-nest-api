import { Prisma, Role, UserStatus } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { computeCappedContribution, computeCappedContributionBatch } from './team-join-progress';
import { TeamJoinApplicationsService } from './team-join-applications.service';
import type { ContributionLedgerReader } from './contribution-ledger-reader';

const enabledGate = { participationReadSource: () => 'committed-ledger' } as never;
const disabledGate = { participationReadSource: () => 'approved-attendance' } as never;
const client = {} as never;

function reader() {
  return {
    sumCommittedCreditedPointsForMemberInTx: jest.fn<
      ReturnType<ContributionLedgerReader['sumCommittedCreditedPointsForMemberInTx']>,
      Parameters<ContributionLedgerReader['sumCommittedCreditedPointsForMemberInTx']>
    >(),
    sumCommittedCreditedPointsForMembersInTx: jest.fn<
      ReturnType<ContributionLedgerReader['sumCommittedCreditedPointsForMembersInTx']>,
      Parameters<ContributionLedgerReader['sumCommittedCreditedPointsForMembersInTx']>
    >(),
  };
}

describe('contribution ledger reader integrity', () => {
  it.each(['NaN', 'Infinity', '-Infinity'])(
    'rejects a non-finite single-member total %s',
    async (value) => {
      const ledger = reader();
      ledger.sumCommittedCreditedPointsForMemberInTx.mockResolvedValue(new Prisma.Decimal(value));
      await expect(
        computeCappedContribution(client, 'member-1', null, enabledGate, ledger),
      ).rejects.toThrow('Contribution ledger snapshot is incomplete or contains non-finite totals');
    },
  );

  it('rejects a value that is not a Decimal', async () => {
    const ledger = reader();
    ledger.sumCommittedCreditedPointsForMemberInTx.mockResolvedValue(
      '5' as unknown as Prisma.Decimal,
    );
    await expect(
      computeCappedContribution(client, 'member-1', null, enabledGate, ledger),
    ).rejects.toThrow('Contribution ledger snapshot is incomplete or contains non-finite totals');
  });

  it('rejects a batch missing one requested member instead of silently omitting them', async () => {
    const ledger = reader();
    ledger.sumCommittedCreditedPointsForMembersInTx.mockResolvedValue(
      new Map([['member-1', new Prisma.Decimal('5')]]),
    );
    await expect(
      computeCappedContributionBatch(client, ['member-1', 'member-2'], null, enabledGate, ledger),
    ).rejects.toThrow('Contribution ledger snapshot is incomplete or contains non-finite totals');
  });

  it('rejects an unrequested member instead of leaking it into the batch result', async () => {
    const ledger = reader();
    ledger.sumCommittedCreditedPointsForMembersInTx.mockResolvedValue(
      new Map([
        ['member-1', new Prisma.Decimal(0)],
        ['other-member', new Prisma.Decimal(7)],
      ]),
    );
    await expect(
      computeCappedContributionBatch(client, ['member-1'], null, enabledGate, ledger),
    ).rejects.toThrow('Contribution ledger snapshot is incomplete or contains non-finite totals');
  });

  it('rejects a same-size batch that substitutes an unrequested member', async () => {
    const ledger = reader();
    ledger.sumCommittedCreditedPointsForMembersInTx.mockResolvedValue(
      new Map([['other-member', new Prisma.Decimal(7)]]),
    );
    await expect(
      computeCappedContributionBatch(client, ['member-1'], null, enabledGate, ledger),
    ).rejects.toThrow('Contribution ledger snapshot is incomplete or contains non-finite totals');
  });

  it('propagates a reader permission error without converting it into an unmet gate', async () => {
    const ledger = reader();
    const failure = new Error('permission denied');
    ledger.sumCommittedCreditedPointsForMemberInTx.mockRejectedValue(failure);
    await expect(
      computeCappedContribution(client, 'member-1', null, enabledGate, ledger),
    ).rejects.toBe(failure);
  });

  it.each(['NaN', 'Infinity', '-Infinity'])(
    'rejects a non-finite batch value %s even when every member is present',
    async (value) => {
      const ledger = reader();
      ledger.sumCommittedCreditedPointsForMembersInTx.mockResolvedValue(
        new Map([['member-1', new Prisma.Decimal(value)]]),
      );
      await expect(
        computeCappedContributionBatch(client, ['member-1'], null, enabledGate, ledger),
      ).rejects.toThrow('Contribution ledger snapshot is incomplete or contains non-finite totals');
    },
  );

  it('preserves finite zero and negative totals and deduplicates requested members', async () => {
    const ledger = reader();
    const values = new Map([
      ['zero', new Prisma.Decimal(0)],
      ['negative', new Prisma.Decimal(-2)],
    ]);
    ledger.sumCommittedCreditedPointsForMembersInTx.mockResolvedValue(values);
    await expect(
      computeCappedContributionBatch(
        client,
        ['zero', 'negative', 'zero'],
        null,
        enabledGate,
        ledger,
      ),
    ).resolves.toBe(values);
    expect(ledger.sumCommittedCreditedPointsForMembersInTx).toHaveBeenCalledWith(
      client,
      ['zero', 'negative'],
      null,
    );
  });

  it('retains gate and empty-batch behavior without calling the reader', async () => {
    const ledger = reader();
    await expect(
      computeCappedContributionBatch(client, [], null, enabledGate, ledger),
    ).resolves.toEqual(new Map());
    await expect(
      computeCappedContributionBatch(client, [], null, disabledGate, ledger),
    ).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED,
    });
    expect(ledger.sumCommittedCreditedPointsForMembersInTx).not.toHaveBeenCalled();
  });

  it('does not update a joining application or audit when the locked single-member total is non-finite', async () => {
    const ledger = reader();
    ledger.sumCommittedCreditedPointsForMemberInTx.mockResolvedValue(new Prisma.Decimal('NaN'));
    const tx = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ locked: '1' }])
        .mockResolvedValueOnce([{ id: 'application-1', memberId: 'member-1' }]),
      teamJoinApplication: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({ memberId: 'member-1' })
          .mockResolvedValueOnce({
            id: 'application-1',
            memberId: 'member-1',
            statusCode: 'joining',
            gateMarks: null,
            cycle: { year: 2026, openedAt: null },
          }),
        update: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn((body: (client: typeof tx) => Promise<unknown>) => body(tx)),
    };
    const audit = { log: jest.fn() };
    const service = new TeamJoinApplicationsService(
      prisma as never,
      { can: jest.fn().mockResolvedValue(true) } as never,
      audit as never,
      enabledGate,
      ledger,
    );
    const actor = {
      id: 'actor-1',
      username: 'actor',
      role: Role.ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
    await expect(
      service.markGate(
        'application-1',
        { gateCode: 'fitness', passed: true, completionDate: '2026-11-01' },
        actor,
        { requestId: 'integrity-test', ip: null, ua: null },
        new Date('2026-11-13T00:00:00Z'),
      ),
    ).rejects.toThrow('Contribution ledger snapshot is incomplete or contains non-finite totals');
    expect(tx.teamJoinApplication.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });
});
