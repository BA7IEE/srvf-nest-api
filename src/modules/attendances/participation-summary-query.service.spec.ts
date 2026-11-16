import { Prisma, Role, UserStatus } from '@prisma/client';

import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
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

function setup(readonlyMaintenance: boolean, withOfficialTime: boolean, enabled = true) {
  const legacyRead = jest.fn().mockRejectedValue(new Error('legacy attendance must not be read'));
  const aggregate = jest.fn().mockResolvedValue({
    _sum: { creditedPointsDelta: new Prisma.Decimal('5.25') },
  });
  const findMember = jest.fn().mockResolvedValue({ id: 'member-1' });
  const prisma = {
    attendanceRecord: { findMany: legacyRead },
    participationLedgerEntry: { aggregate },
    member: { findFirst: findMember },
    $transaction: jest.fn(async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      fn({} as Prisma.TransactionClient),
    ),
  } as unknown as PrismaService;
  const countCommittedParticipationForMember = jest
    .fn()
    .mockResolvedValue({ activityCount: 2, recordCount: 3 });
  const loadMemberLedgerTotals = jest.fn().mockResolvedValue(ledgerTotals);
  const ledger = {
    loadMemberLedgerTotals,
    countCommittedParticipationForMember,
  } as unknown as LedgerQueryService;
  const officialTime = {
    readOfficialTotalsInTx: jest
      .fn()
      .mockResolvedValue(withOfficialTime ? { totals: [{ eligibleSeconds: 4500 }] } : null),
  } as unknown as ParticipationTimeTruthQueryService;
  const explain = jest.fn().mockResolvedValue({ allow: true });
  const authz = { explain } as unknown as AuthzService;
  const rbacCan = jest.fn().mockResolvedValue(false);
  const rbac = { can: rbacCan } as unknown as RbacService;
  const resolveIdentity = jest
    .fn()
    .mockResolvedValue({ canUseApp: true, member: { id: 'member-1' } });
  const identity = {
    resolve: resolveIdentity,
  } as unknown as AppIdentityResolver;
  const gate = new ActivityWorkflowGate({
    activityV11Workflow: { enabled, readonlyMaintenance },
  } as AppConfig);
  const service = new ParticipationSummaryQueryService(
    prisma,
    authz,
    rbac,
    identity,
    ledger,
    officialTime,
    gate,
  );
  return {
    service,
    legacyRead,
    aggregate,
    findMember,
    explain,
    rbacCan,
    resolveIdentity,
    loadMemberLedgerTotals,
    countCommittedParticipationForMember,
  };
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

  it.each([null, '0', '-1.25'])(
    'keeps a committed net contribution of %s without falling back to legacy attendance',
    async (net) => {
      const {
        service,
        legacyRead,
        aggregate,
        loadMemberLedgerTotals,
        countCommittedParticipationForMember,
      } = setup(false, false);
      const value = net === null ? '0' : net;
      aggregate.mockResolvedValue({
        _sum: { creditedPointsDelta: net === null ? null : new Prisma.Decimal(net) },
      });
      loadMemberLedgerTotals.mockResolvedValue({
        committedServiceHours: '0',
        committedContributionPoints: value,
        inFlightServiceHours: '0',
        inFlightContributionPoints: '0',
      });
      countCommittedParticipationForMember.mockResolvedValue({ activityCount: 0, recordCount: 0 });

      await expect(service.forCurrentMember(user)).resolves.toMatchObject({
        totalServiceHours: '0',
        activityCount: 0,
        recordCount: 0,
        contributionPoints: value,
      });
      expect(legacyRead).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'rejects an absent member before any participation read with enabled=%s',
    async (enabled) => {
      const { service, findMember, legacyRead, aggregate, loadMemberLedgerTotals } = setup(
        false,
        false,
        enabled,
      );
      findMember.mockResolvedValue(null);
      await expect(service.forMemberAdmin('missing-member', user)).rejects.toMatchObject({
        biz: BizCode.MEMBER_NOT_FOUND,
      });
      expect(legacyRead).not.toHaveBeenCalled();
      expect(aggregate).not.toHaveBeenCalled();
      expect(loadMemberLedgerTotals).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'rejects an unauthorized admin before data lookup with enabled=%s',
    async (enabled) => {
      const { service, explain, findMember, legacyRead, aggregate, loadMemberLedgerTotals } = setup(
        false,
        false,
        enabled,
      );
      explain.mockResolvedValue({ allow: false, reason: 'scope_denied' });
      await expect(service.forMemberAdmin('member-1', user)).rejects.toMatchObject({
        biz: BizCode.RBAC_FORBIDDEN,
      });
      expect(findMember).not.toHaveBeenCalled();
      expect(legacyRead).not.toHaveBeenCalled();
      expect(aggregate).not.toHaveBeenCalled();
      expect(loadMemberLedgerTotals).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'rejects an ineligible app identity before any participation read with enabled=%s',
    async (enabled) => {
      const { service, resolveIdentity, legacyRead, aggregate, loadMemberLedgerTotals } = setup(
        false,
        false,
        enabled,
      );
      resolveIdentity.mockResolvedValue({ canUseApp: false, member: null });
      await expect(service.forCurrentMember(user)).rejects.toMatchObject({
        biz: BizCode.FORBIDDEN,
      });
      expect(legacyRead).not.toHaveBeenCalled();
      expect(aggregate).not.toHaveBeenCalled();
      expect(loadMemberLedgerTotals).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'when the new workflow is disabled, rejects without reading either source in maintenance=%s',
    async (readonlyMaintenance) => {
      const { service, legacyRead, aggregate, loadMemberLedgerTotals } = setup(
        readonlyMaintenance,
        false,
        false,
      );
      await expect(service.forCurrentMember(user)).rejects.toMatchObject({
        biz: BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED,
      });
      expect(legacyRead).not.toHaveBeenCalled();
      expect(aggregate).not.toHaveBeenCalled();
      expect(loadMemberLedgerTotals).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'member contribution is ledger-only with readonly=%s',
    async (readonlyMaintenance) => {
      const {
        service,
        legacyRead,
        aggregate,
        loadMemberLedgerTotals,
        countCommittedParticipationForMember,
      } = setup(readonlyMaintenance, false);
      // A legacy row is available, but the new total must not be mixed with it.
      legacyRead.mockResolvedValue([{ serviceHours: new Prisma.Decimal('99') }]);
      await expect(service.contributionForMemberAdmin('member-1', user)).resolves.toEqual({
        memberId: 'member-1',
        contributionPoints: '5.25',
        ledgerTotals,
      });
      expect(legacyRead).not.toHaveBeenCalled();
      expect(aggregate).toHaveBeenCalledTimes(1);
      expect(loadMemberLedgerTotals).toHaveBeenCalledTimes(1);
      expect(countCommittedParticipationForMember).not.toHaveBeenCalled();
    },
  );

  it.each([null, '0', '-1.25'])(
    'member contribution preserves committed net %s when old rows exist',
    async (net) => {
      const { service, legacyRead, aggregate } = setup(false, false);
      legacyRead.mockResolvedValue([{ contributionPoints: new Prisma.Decimal('99') }]);
      aggregate.mockResolvedValue({
        _sum: { creditedPointsDelta: net === null ? null : new Prisma.Decimal(net) },
      });
      await expect(service.contributionForMemberAdmin('member-1', user)).resolves.toMatchObject({
        contributionPoints: net ?? '0',
      });
      expect(legacyRead).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'disabled member contribution rejects before either data source with readonly=%s',
    async (readonlyMaintenance) => {
      const { service, legacyRead, aggregate, loadMemberLedgerTotals } = setup(
        readonlyMaintenance,
        false,
        false,
      );
      await expect(service.contributionForMemberAdmin('member-1', user)).rejects.toMatchObject({
        biz: BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED,
      });
      expect(legacyRead).not.toHaveBeenCalled();
      expect(aggregate).not.toHaveBeenCalled();
      expect(loadMemberLedgerTotals).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'member contribution checks permission and scope before existence with enabled=%s',
    async (enabled) => {
      const { service, explain, findMember, aggregate, loadMemberLedgerTotals } = setup(
        false,
        false,
        enabled,
      );
      explain.mockResolvedValue({ allow: false, reason: 'out_of_scope' });
      await expect(service.contributionForMemberAdmin('member-1', user)).rejects.toMatchObject({
        biz: BizCode.RBAC_FORBIDDEN,
      });
      expect(explain).toHaveBeenCalledWith(user, 'attendance.read.sheet', {
        type: 'member',
        id: 'member-1',
      });
      expect(findMember).not.toHaveBeenCalled();
      expect(aggregate).not.toHaveBeenCalled();
      expect(loadMemberLedgerTotals).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'member contribution preserves not-found after a global permission fallback with enabled=%s',
    async (enabled) => {
      const { service, explain, rbacCan, findMember, aggregate, loadMemberLedgerTotals } = setup(
        false,
        false,
        enabled,
      );
      explain.mockResolvedValue({ allow: false, reason: 'resource_not_found' });
      rbacCan.mockResolvedValue(true);
      findMember.mockResolvedValue(null);
      await expect(service.contributionForMemberAdmin('missing', user)).rejects.toMatchObject({
        biz: BizCode.MEMBER_NOT_FOUND,
      });
      expect(rbacCan).toHaveBeenCalledWith(user, 'attendance.read.sheet');
      expect(aggregate).not.toHaveBeenCalled();
      expect(loadMemberLedgerTotals).not.toHaveBeenCalled();
    },
  );

  it('does not accept an app identity with a missing member even when canUseApp is true', async () => {
    const { service, resolveIdentity, legacyRead, aggregate } = setup(false, false);
    resolveIdentity.mockResolvedValue({ canUseApp: true, member: null });
    await expect(service.forCurrentMember(user)).rejects.toMatchObject({ biz: BizCode.FORBIDDEN });
    expect(legacyRead).not.toHaveBeenCalled();
    expect(aggregate).not.toHaveBeenCalled();
  });
});
