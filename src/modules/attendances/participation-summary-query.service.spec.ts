import { Prisma, Role, UserStatus } from '@prisma/client';

import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { AppConfig } from '../../config/app.config';
import type { PrismaService } from '../../database/prisma.service';
import type { LedgerQueryService } from '../activities/ledger-query.service';
import type { ParticipationTimeTruthQueryService } from '../activities/participation-time-truth-query.service';
import type { AuthzService } from '../authz/authz.service';
import type { RbacService } from '../permissions/rbac.service';
import type { AppIdentityResolver } from '../users/app-identity.resolver';
import { ParticipationSummaryQueryService } from './participation-summary-query.service';

const user: CurrentUserPayload = {
  id: 'user-1',
  username: 'user-1',
  role: Role.SUPER_ADMIN,
  status: UserStatus.ACTIVE,
  memberId: 'member-1',
};

const ledgerTotals = {
  committedServiceHours: '2.5',
  committedContributionPoints: '5.25',
  inFlightServiceHours: '0.5',
  inFlightContributionPoints: '0.75',
};

function setup(readonlyMaintenance: boolean, withOfficialTime: boolean) {
  const legacyRead = jest.fn().mockRejectedValue(new Error('legacy attendance must not be read'));
  const prisma = {
    attendanceRecord: { findMany: legacyRead },
    participationLedgerEntry: {
      aggregate: jest.fn().mockResolvedValue({
        _sum: { creditedPointsDelta: new Prisma.Decimal('5.25') },
      }),
    },
    member: { findFirst: jest.fn().mockResolvedValue({ id: 'member-1' }) },
    $transaction: jest.fn(async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn({} as Prisma.TransactionClient),
    ),
  } as unknown as PrismaService;
  const countCommittedParticipationForMember = jest
    .fn()
    .mockResolvedValue({ activityCount: 2, recordCount: 3 });
  const ledger = {
    loadMemberLedgerTotals: jest.fn().mockResolvedValue(ledgerTotals),
    countCommittedParticipationForMember,
  } as unknown as LedgerQueryService;
  const officialTime = {
    readOfficialTotalsInTx: jest
      .fn()
      .mockResolvedValue(withOfficialTime ? { totals: [{ eligibleSeconds: 4500 }] } : null),
  } as unknown as ParticipationTimeTruthQueryService;
  const authz = {
    explain: jest.fn().mockResolvedValue({ allow: true }),
  } as unknown as AuthzService;
  const identity = {
    resolve: jest.fn().mockResolvedValue({ canUseApp: true, member: { id: 'member-1' } }),
  } as unknown as AppIdentityResolver;
  const gate = new ActivityWorkflowGate({
    activityV11Workflow: { enabled: true, readonlyMaintenance },
  } as AppConfig);
  const service = new ParticipationSummaryQueryService(
    prisma,
    authz,
    {} as RbacService,
    identity,
    ledger,
    officialTime,
    gate,
  );
  return { service, legacyRead, countCommittedParticipationForMember };
}

describe('participation summary in the ledger workflow', () => {
  it.each([false, true])(
    'does not read legacy attendance for an admin when maintenance is %s',
    async (readonlyMaintenance) => {
      const { service, legacyRead, countCommittedParticipationForMember } = setup(
        readonlyMaintenance,
        false,
      );
      await expect(service.forMemberAdmin('member-1', user)).resolves.toEqual({
        memberId: 'member-1',
        totalServiceHours: '2.5',
        activityCount: 2,
        recordCount: 3,
        contributionPoints: '5.25',
        ledgerTotals,
      });
      expect(legacyRead).not.toHaveBeenCalled();
      expect(countCommittedParticipationForMember).toHaveBeenCalledWith('member-1');
    },
  );

  it('keeps official-time precedence for the current member without reading legacy attendance', async () => {
    const { service, legacyRead } = setup(false, true);
    await expect(service.forCurrentMember(user)).resolves.toEqual({
      totalServiceHours: '1.25',
      activityCount: 2,
      recordCount: 3,
      contributionPoints: '5.25',
      ledgerTotals,
    });
    expect(legacyRead).not.toHaveBeenCalled();
  });
});
