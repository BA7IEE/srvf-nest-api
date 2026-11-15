import { Prisma, Role, UserStatus } from '@prisma/client';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import type { AppConfig } from '../../config/app.config';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PrismaService } from '../../database/prisma.service';
import type { AuthzService } from '../authz/authz.service';
import type { RbacService } from '../permissions/rbac.service';
import { ActivityFeedbacksQueryService } from './activity-feedbacks-query.service';

describe('v1.1 feedback rate source', () => {
  const user: CurrentUserPayload = {
    id: 'admin',
    username: 'admin',
    role: Role.ADMIN,
    status: UserStatus.ACTIVE,
    memberId: null,
  };

  it('uses eligible members in the active closure plus live feedback members, from one snapshot', async () => {
    const activityFindFirst = jest.fn().mockResolvedValue({ id: 'activity' });
    const closureFindFirst = jest
      .fn()
      .mockResolvedValue({ settlementVersionId: 'version', postingBatchId: 'batch' });
    const aggregate = jest.fn().mockResolvedValue({ _count: { _all: 1 }, _avg: { rating: 5 } });
    const groupBy = jest.fn().mockResolvedValue([{ rating: 5, _count: { _all: 1 } }]);
    const queryRaw = jest.fn().mockResolvedValue([{ total: 2 }]);
    const tx = {
      activitySettlementClosureRevision: { findFirst: closureFindFirst },
      activityFeedback: { aggregate, groupBy },
      $queryRaw: queryRaw,
    };
    const transaction = jest
      .fn()
      .mockImplementation((fn: (client: typeof tx) => unknown) => Promise.resolve(fn(tx)));
    const prisma = {
      activity: { findFirst: activityFindFirst },
      activityFeedback: { aggregate, groupBy },
      $transaction: transaction,
    } as unknown as PrismaService;
    const authz = {
      explain: jest.fn().mockResolvedValue({ allow: true }),
    } as unknown as AuthzService;
    const service = new ActivityFeedbacksQueryService(
      prisma,
      authz,
      {} as RbacService,
      { participationReadSource: () => 'committed-ledger' } as ActivityWorkflowGate,
    );

    await expect(service.summary('activity', user)).resolves.toMatchObject({
      count: 1,
      feedbackRate: 0.5,
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    expect(closureFindFirst).toHaveBeenCalledWith({
      where: { activityId: 'activity', statusCode: 'active' },
      select: { settlementVersionId: true, postingBatchId: true },
      orderBy: { revision: 'desc' },
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [sql] = queryRaw.mock.calls[0] as [Prisma.Sql];
    expect(sql.sql).toContain('FROM "ActivityParticipationIdentity" i');
    expect(sql.sql).toContain('JOIN "ParticipantSettlementResultRevision" rr');
    expect(sql.sql).toContain('FROM "ParticipationLedgerEntry" e');
    expect(sql.sql).toContain('SELECT DISTINCT f."memberId" FROM "activity_feedbacks" f');
    expect(sql.sql).toContain('UNION');
    expect(sql.sql).toContain('e."serviceHoursDelta" > 0');
    expect(sql.sql).not.toContain('FROM "Member"');
    expect(sql.values).toEqual([
      'activity',
      'version',
      'committed',
      'present',
      'batch',
      'service_credit',
      'activity',
    ]);
  });

  it.each([
    { enabled: false, readonlyMaintenance: false, expectedRate: 1 },
    { enabled: false, readonlyMaintenance: true, expectedRate: 1 },
    { enabled: true, readonlyMaintenance: false, expectedRate: 0.5 },
    { enabled: true, readonlyMaintenance: true, expectedRate: 0.5 },
  ])(
    'chooses the correct denominator when enabled=$enabled and readonly=$readonlyMaintenance',
    async ({ enabled, readonlyMaintenance, expectedRate }) => {
      const aggregate = jest.fn().mockResolvedValue({ _count: { _all: 1 }, _avg: { rating: 5 } });
      const groupBy = jest.fn().mockResolvedValue([{ rating: 5, _count: { _all: 1 } }]);
      const legacyCount = jest.fn().mockResolvedValue(1);
      const queryRaw = jest.fn().mockResolvedValue([{ total: 2 }]);
      const tx = {
        activitySettlementClosureRevision: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ settlementVersionId: 'version', postingBatchId: 'batch' }),
        },
        activityFeedback: { aggregate, groupBy },
        $queryRaw: queryRaw,
      };
      const transaction = jest
        .fn()
        .mockImplementation((fn: (client: typeof tx) => unknown) => Promise.resolve(fn(tx)));
      const prisma = {
        activity: { findFirst: jest.fn().mockResolvedValue({ id: 'activity' }) },
        activityFeedback: { aggregate, groupBy },
        member: { count: legacyCount },
        $transaction: transaction,
      } as unknown as PrismaService;
      const authz = {
        explain: jest.fn().mockResolvedValue({ allow: true }),
      } as unknown as AuthzService;
      const gate = new ActivityWorkflowGate({
        activityV11Workflow: { enabled, readonlyMaintenance },
      } as AppConfig);
      const sourceSpy = jest.spyOn(gate, 'participationReadSource');
      const service = new ActivityFeedbacksQueryService(prisma, authz, {} as RbacService, gate);

      // Identical feedback numerator but deliberately different eligible populations.
      await expect(service.summary('activity', user)).resolves.toMatchObject({
        feedbackRate: expectedRate,
      });
      expect(sourceSpy).toHaveBeenCalledTimes(1);
      expect(legacyCount).toHaveBeenCalledTimes(enabled ? 0 : 1);
      expect(transaction).toHaveBeenCalledTimes(enabled ? 1 : 0);
      expect(queryRaw).toHaveBeenCalledTimes(enabled ? 1 : 0);
    },
  );

  it('without an active closure keeps historical feedback in the denominator', async () => {
    const aggregate = jest.fn().mockResolvedValue({ _count: { _all: 2 }, _avg: { rating: 4 } });
    const groupBy = jest.fn().mockResolvedValue([]);
    const queryRaw = jest.fn().mockResolvedValue([{ total: 2 }]);
    const tx = {
      activitySettlementClosureRevision: { findFirst: jest.fn().mockResolvedValue(null) },
      activityFeedback: { aggregate, groupBy },
      $queryRaw: queryRaw,
    };
    const prisma = {
      activity: { findFirst: jest.fn().mockResolvedValue({ id: 'activity' }) },
      $transaction: jest
        .fn()
        .mockImplementation((fn: (client: typeof tx) => unknown) => Promise.resolve(fn(tx))),
    } as unknown as PrismaService;
    const authz = {
      explain: jest.fn().mockResolvedValue({ allow: true }),
    } as unknown as AuthzService;
    const service = new ActivityFeedbacksQueryService(
      prisma,
      authz,
      {} as RbacService,
      { participationReadSource: () => 'committed-ledger' } as ActivityWorkflowGate,
    );

    await expect(service.summary('activity', user)).resolves.toMatchObject({
      count: 2,
      feedbackRate: 1,
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [sql] = queryRaw.mock.calls[0] as [Prisma.Sql];
    expect(sql.sql).not.toContain('ActivityParticipationIdentity');
    expect(sql.sql).not.toContain('UNION');
    expect(sql.sql).toContain('SELECT DISTINCT f."memberId" FROM "activity_feedbacks" f');
    expect(sql.values).toEqual(['activity']);
  });
});
