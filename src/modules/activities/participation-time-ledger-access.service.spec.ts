import { Test, type TestingModule } from '@nestjs/testing';
import { Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import * as activeIdentity from '../users/user-active-identity.query';
import * as organizationEligibility from '../organizations/organization-publish-readiness.primitive';
import { ParticipationTimeLedgerAccessService } from './participation-time-ledger-access.service';

describe('D6 classified ledger exact-version current access', () => {
  const actor = {
    id: 'reviewer',
    username: 'reviewer',
    memberId: 'member',
    role: Role.USER,
    status: UserStatus.ACTIVE,
  };
  const resolve = jest.fn<
    ReturnType<AppIdentityResolver['resolve']>,
    Parameters<AppIdentityResolver['resolve']>
  >();
  const scope = jest.fn<
    ReturnType<AuthzService['getExplicitVisibleOrganizationScope']>,
    Parameters<AuthzService['getExplicitVisibleOrganizationScope']>
  >();
  const can = jest.fn<ReturnType<AuthzService['can']>, Parameters<AuthzService['can']>>();
  const decisions = jest.fn<
    Promise<Array<{ actorUserId: string; actionCode: string }>>,
    [unknown]
  >();
  const activity = jest.fn<Promise<{ organizationId: string } | null>, [unknown]>();
  let module: TestingModule;
  let service: ParticipationTimeLedgerAccessService;
  let tx: PrismaService;
  const authorize = () => service.authorize(tx, actor.id, 'activity', 'historical-version');

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [
        ParticipationTimeLedgerAccessService,
        { provide: AppIdentityResolver, useValue: { resolve } },
        { provide: AuthzService, useValue: { getExplicitVisibleOrganizationScope: scope, can } },
        {
          provide: PrismaService,
          useValue: {
            settlementReviewAction: { findMany: decisions },
            activity: { findFirst: activity },
          },
        },
      ],
    }).compile();
    service = module.get(ParticipationTimeLedgerAccessService);
    tx = module.get(PrismaService);
  });
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.resetAllMocks();
    jest.spyOn(activeIdentity, 'loadActiveUserIdentityInTx').mockResolvedValue(actor);
    jest
      .spyOn(organizationEligibility, 'getActivityOrganizationEligibility')
      .mockResolvedValue('eligible');
    resolve.mockResolvedValue({ canUseApp: true, reason: null, member: null });
    decisions.mockResolvedValue([{ actorUserId: actor.id, actionCode: 'approve' }]);
    activity.mockResolvedValue({ organizationId: 'org' });
    scope.mockResolvedValue({ hasPermission: true, global: false, organizationIds: ['org'] });
    can.mockResolvedValue(true);
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await module.close();
  });

  it('uses the supplied transaction and historical version for every ownership and permission check', async () => {
    await expect(authorize()).resolves.toBeUndefined();
    expect(activeIdentity.loadActiveUserIdentityInTx).toHaveBeenCalledWith(tx, actor.id);
    expect(resolve).toHaveBeenCalledWith(actor, tx);
    expect(decisions).toHaveBeenCalledWith({
      where: { settlementVersionId: 'historical-version', stageCode: 'final' },
      select: { actorUserId: true, actionCode: true },
      take: 2,
    });
    expect(activity).toHaveBeenCalledWith({
      where: { id: 'activity', deletedAt: null },
      select: { organizationId: true },
    });
    expect(organizationEligibility.getActivityOrganizationEligibility).toHaveBeenCalledWith(
      tx,
      'org',
    );
    expect(scope).toHaveBeenCalledWith(actor, 'activity.settlement-final-review.record', tx);
    expect(can).toHaveBeenCalledWith(
      actor,
      'activity.settlement-final-review.record',
      { type: 'attendance_settlement_version', id: 'historical-version' },
      tx,
    );
  });

  it('does not reuse a previous successful identity check', async () => {
    await authorize();
    jest.spyOn(activeIdentity, 'loadActiveUserIdentityInTx').mockResolvedValue(null);
    await expect(authorize()).rejects.toMatchObject({ biz: { code: 40100, httpStatus: 401 } });
    expect(activeIdentity.loadActiveUserIdentityInTx).toHaveBeenCalledTimes(2);
    expect(can).toHaveBeenCalledTimes(1);
  });

  it('rejects a currently ineligible App member before reading review decisions', async () => {
    resolve.mockResolvedValue({ canUseApp: false, reason: 'MEMBER_INACTIVE', member: null });
    await expect(authorize()).rejects.toMatchObject({ biz: { code: 40300, httpStatus: 403 } });
    expect(decisions).not.toHaveBeenCalled();
  });

  it.each(
    [
      [],
      [{ actorUserId: 'other-reviewer', actionCode: 'approve' }],
      [{ actorUserId: actor.id, actionCode: 'return' }],
      [
        { actorUserId: actor.id, actionCode: 'approve' },
        { actorUserId: actor.id, actionCode: 'approve' },
      ],
    ].map((rows) => ({ rows })),
  )('rejects absent, replaced, returned or ambiguous final decisions %#', async ({ rows }) => {
    decisions.mockResolvedValue(rows);
    await expect(authorize()).rejects.toMatchObject({ biz: { code: 40300, httpStatus: 403 } });
    expect(scope).not.toHaveBeenCalled();
  });

  it.each(['missing', 'inactive', 'root'] as const)(
    'rejects organization eligibility %s',
    async (eligibility) => {
      jest
        .spyOn(organizationEligibility, 'getActivityOrganizationEligibility')
        .mockResolvedValue(eligibility);
      await expect(authorize()).rejects.toMatchObject({ biz: { code: 40300, httpStatus: 403 } });
      expect(scope).not.toHaveBeenCalled();
    },
  );

  it('rejects a missing or soft-deleted activity', async () => {
    activity.mockResolvedValue(null);
    await expect(authorize()).rejects.toMatchObject({ biz: { code: 40300, httpStatus: 403 } });
    expect(scope).not.toHaveBeenCalled();
  });

  it.each([
    { hasPermission: false, global: false, organizationIds: ['org'] },
    { hasPermission: true, global: false, organizationIds: ['other-org'] },
  ])('does not substitute another organization or absent permission %#', async (value) => {
    scope.mockResolvedValue(value);
    await expect(authorize()).rejects.toMatchObject({ biz: { code: 40300, httpStatus: 403 } });
    expect(can).not.toHaveBeenCalled();
  });

  it('still checks historical-version ownership under explicit GLOBAL permission', async () => {
    scope.mockResolvedValue({ hasPermission: true, global: true, organizationIds: [] });
    can.mockResolvedValue(false);
    await expect(authorize()).rejects.toMatchObject({ biz: { code: 40300, httpStatus: 403 } });
    expect(can).toHaveBeenCalledTimes(1);
  });
});
