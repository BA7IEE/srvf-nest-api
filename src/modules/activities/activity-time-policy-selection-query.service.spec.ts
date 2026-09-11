import { Role, UserStatus, type Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import {
  activityTimePolicySelectionHash,
  emptyActivityTimePolicySelectionDocument,
} from './activity-time-policy-selection';
import type { ActivityTimePolicySelectionAccess } from './activity-time-policy-selection-access';
import { ActivityTimePolicySelectionQueryService } from './activity-time-policy-selection-query.service';

const actor: CurrentUserPayload = {
  id: 'reader-one',
  username: 'reader-one',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: 'member-one',
};

function selectionFixture() {
  const document = emptyActivityTimePolicySelectionDocument();
  const stored = {
    id: 'selection-revision-one',
    revision: 1,
    selectionHash: activityTimePolicySelectionHash(document),
    selectionJson: document,
    itemCount: 1,
    createdAt: new Date('2026-09-11T00:00:00.000Z'),
  };
  const tx = {
    activity: {
      findFirst: jest.fn().mockResolvedValue({
        timePolicySelectionRevision: 1,
        currentTimePolicySelectionRevisionId: stored.id,
      }),
    },
    activityTimePolicySelectionRevision: { findFirst: jest.fn().mockResolvedValue(stored) },
    activityTimePolicySelectionItem: {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([
        {
          layerCode: 'activity',
          sessionId: null,
          positionId: null,
          mode: 'inherit',
          policyId: null,
          versionId: null,
          definitionHash: null,
        },
      ]),
    },
    activitySession: { findMany: jest.fn().mockResolvedValue([]) },
    activitySessionPosition: { findMany: jest.fn().mockResolvedValue([]) },
    timePolicyVersion: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const transaction = jest.fn(
    async (callback: (client: Prisma.TransactionClient) => Promise<unknown>) =>
      callback(tx as unknown as Prisma.TransactionClient),
  );
  const authorize = jest.fn().mockResolvedValue({ activity: { id: 'activity-one' }, actor });
  const authorizeOptions = jest.fn().mockResolvedValue(actor);
  const service = new ActivityTimePolicySelectionQueryService(
    { $transaction: transaction } as unknown as PrismaService,
    { authorize, authorizeOptions } as unknown as ActivityTimePolicySelectionAccess,
  );
  return { tx, transaction, authorize, authorizeOptions, service };
}

describe('D1-3 time policy selection query', () => {
  it('rejects impossible pagination and historical revision input before beginning a transaction', async () => {
    const f = selectionFixture();
    await expect(
      f.service.get('activity-one', { page: 0, pageSize: 20 }, actor, 'admin'),
    ).rejects.toMatchObject({ biz: BizCode.BAD_REQUEST });
    await expect(
      f.service.get('activity-one', { page: 1, pageSize: 101 }, actor, 'admin'),
    ).rejects.toMatchObject({ biz: BizCode.BAD_REQUEST });
    await expect(
      f.service.get('activity-one', { page: 1, pageSize: 20, revision: 0 }, actor, 'admin'),
    ).rejects.toMatchObject({ biz: BizCode.BAD_REQUEST });
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it('presents only manifest-backed historical state and reauthorizes before returning it', async () => {
    const f = selectionFixture();
    await expect(
      f.service.get('activity-one', { page: 1, pageSize: 20, revision: 1 }, actor, 'app'),
    ).resolves.toEqual({
      activityId: 'activity-one',
      selectionRevisionId: 'selection-revision-one',
      revision: 1,
      selectionHash: activityTimePolicySelectionHash(emptyActivityTimePolicySelectionDocument()),
      createdAt: '2026-09-11T00:00:00.000Z',
      items: [
        {
          scope: { layerCode: 'activity', sessionId: null, positionId: null },
          selection: { mode: 'inherit', pointer: null },
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      resolutionSummary: { targetCount: 1, resolvedTargetCount: 0, unresolvedTargetCount: 1 },
    });
    expect(f.authorize).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      actor,
      'app',
      'activity-one',
      'activity.time-policy.read',
    );
    expect(f.authorize).toHaveBeenCalledTimes(2);
    expect(f.tx.activityTimePolicySelectionItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { selectionRevisionId: 'selection-revision-one', activityId: 'activity-one' },
        orderBy: [{ layerCode: 'asc' }, { sessionId: 'asc' }, { positionId: 'asc' }],
        skip: 0,
        take: 20,
      }),
    );
  });

  it('does not return a stale query when authorization changes during the read', async () => {
    const f = selectionFixture();
    f.authorize
      .mockResolvedValueOnce({ activity: { id: 'activity-one' }, actor })
      .mockRejectedValueOnce(new BizException(BizCode.FORBIDDEN));
    await expect(
      f.service.get('activity-one', { page: 1, pageSize: 20 }, actor, 'admin'),
    ).rejects.toMatchObject({ biz: BizCode.FORBIDDEN });
    expect(f.tx.activityTimePolicySelectionItem.findMany).toHaveBeenCalledTimes(1);
  });

  it('keeps no-selection distinct and does not read immutable rows for revision zero', async () => {
    const f = selectionFixture();
    f.tx.activity.findFirst.mockResolvedValue({
      timePolicySelectionRevision: 0,
      currentTimePolicySelectionRevisionId: null,
    });
    await expect(
      f.service.get('activity-one', { page: 2, pageSize: 5 }, actor, 'admin'),
    ).resolves.toEqual({
      activityId: 'activity-one',
      selectionRevisionId: null,
      revision: 0,
      selectionHash: null,
      createdAt: null,
      items: [],
      total: 0,
      page: 2,
      pageSize: 5,
      resolutionSummary: { targetCount: 0, resolvedTargetCount: 0, unresolvedTargetCount: 0 },
    });
    expect(f.tx.activityTimePolicySelectionRevision.findFirst).not.toHaveBeenCalled();
    expect(f.authorize).toHaveBeenCalledTimes(2);
  });

  it('fails closed when an immutable item count no longer matches the revision', async () => {
    const f = selectionFixture();
    f.tx.activityTimePolicySelectionItem.count.mockResolvedValue(2);
    await expect(
      f.service.get('activity-one', { page: 1, pageSize: 20 }, actor, 'admin'),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE });
    expect(f.authorize).toHaveBeenCalledTimes(1);
  });

  it('keeps options organization-scoped, time-bounded and reauthorized at completion', async () => {
    const f = selectionFixture();
    const query = {
      organizationId: 'organization-one',
      plannedFrom: new Date('2099-10-01T00:00:00.000Z'),
      plannedUntil: new Date('2099-10-01T01:00:00.000Z'),
      page: 2,
      pageSize: 10,
    };
    await expect(f.service.options(query, actor)).resolves.toEqual({
      items: [],
      total: 0,
      page: 2,
      pageSize: 10,
    });
    expect(f.authorizeOptions).toHaveBeenCalledTimes(2);
    expect(f.authorizeOptions).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      actor,
      'organization-one',
    );
    expect(f.tx.timePolicyVersion.findMany).toHaveBeenCalledWith({
      where: {
        statusCode: 'active',
        schemaVersion: 1,
        evaluatorVersion: 1,
        effectiveFrom: { lte: query.plannedFrom },
        OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: query.plannedUntil } }],
      },
      include: { policy: { select: { code: true, name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 10,
      take: 10,
    });
  });

  it('rejects invalid planning windows before touching the catalogue', async () => {
    const f = selectionFixture();
    await expect(
      f.service.options(
        {
          organizationId: 'organization-one',
          plannedFrom: new Date('2099-10-01T01:00:00.000Z'),
          plannedUntil: new Date('2099-10-01T01:00:00.000Z'),
          page: 1,
          pageSize: 20,
        },
        actor,
      ),
    ).rejects.toMatchObject({ biz: BizCode.BAD_REQUEST });
    expect(f.transaction).not.toHaveBeenCalled();
  });
});
