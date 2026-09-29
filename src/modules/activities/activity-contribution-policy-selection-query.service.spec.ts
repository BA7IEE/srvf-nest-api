import { Role, UserStatus, type Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { PrismaService } from '../../database/prisma.service';
import {
  activityContributionPolicySelectionHash,
  emptyActivityContributionPolicySelectionDocument,
} from './activity-contribution-policy-selection';
import type { ActivityContributionPolicySelectionAccess } from './activity-contribution-policy-selection-access';
import { ActivityContributionPolicySelectionQueryService } from './activity-contribution-policy-selection-query.service';

const actor: CurrentUserPayload = {
  id: 'reader-one',
  username: 'reader-one',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: 'member-one',
};

function fixture() {
  const document = emptyActivityContributionPolicySelectionDocument();
  const stored = {
    id: 'revision-one',
    revision: 1,
    selectionHash: activityContributionPolicySelectionHash(document),
    selectionJson: document,
    itemCount: 1,
    templateId: null,
    templateDefinitionHash: null,
    createdAt: new Date('2026-09-23T00:00:00.000Z'),
  };
  const tx = {
    activity: {
      findFirst: jest.fn().mockResolvedValue({
        contributionPolicySelectionRevision: 1,
        currentContributionPolicySelectionRevisionId: stored.id,
      }),
    },
    activityContributionPolicySelectionRevision: {
      findFirst: jest.fn().mockResolvedValue(stored),
    },
    activityContributionPolicySelectionItem: {
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
          evaluatorVersion: null,
        },
      ]),
    },
    activitySessionPosition: { findMany: jest.fn().mockResolvedValue([]) },
    activityTemplate: { findFirst: jest.fn().mockResolvedValue(null) },
    contributionPolicyVersion: {
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
  const service = new ActivityContributionPolicySelectionQueryService(
    { $transaction: transaction } as unknown as PrismaService,
    { authorize, authorizeOptions } as unknown as ActivityContributionPolicySelectionAccess,
  );
  return { tx, transaction, authorize, authorizeOptions, service, stored };
}

describe('E1-3 contribution policy selection query', () => {
  it('rejects invalid pagination before opening a transaction', async () => {
    const f = fixture();
    await expect(
      f.service.get('activity-one', { page: 0, pageSize: 20 }, actor, 'admin'),
    ).rejects.toMatchObject({ biz: BizCode.BAD_REQUEST });
    await expect(
      f.service.get('activity-one', { page: 1, pageSize: 101 }, actor, 'admin'),
    ).rejects.toMatchObject({ biz: BizCode.BAD_REQUEST });
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it('presents only the immutable manifest and reauthorizes before returning', async () => {
    const f = fixture();
    await expect(
      f.service.get('activity-one', { page: 1, pageSize: 20 }, actor, 'app'),
    ).resolves.toMatchObject({
      activityId: 'activity-one',
      selectionRevisionId: 'revision-one',
      revision: 1,
      items: [
        {
          scope: { layerCode: 'activity', sessionId: null, positionId: null },
          selection: { mode: 'inherit', pointer: null },
        },
      ],
      resolutionSummary: {
        targetCount: 1,
        resolvedTargetCount: 0,
        unresolvedTargetCount: 1,
      },
    });
    expect(f.authorize).toHaveBeenCalledTimes(2);
    expect(f.tx.activityContributionPolicySelectionItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { selectionRevisionId: 'revision-one', activityId: 'activity-one' },
        skip: 0,
        take: 20,
      }),
    );
  });

  it('keeps revision zero distinct and never reads immutable revision rows', async () => {
    const f = fixture();
    f.tx.activity.findFirst.mockResolvedValue({
      contributionPolicySelectionRevision: 0,
      currentContributionPolicySelectionRevisionId: null,
    });
    await expect(
      f.service.get('activity-one', { page: 2, pageSize: 5 }, actor, 'admin'),
    ).resolves.toMatchObject({
      selectionRevisionId: null,
      revision: 0,
      items: [],
      total: 0,
      page: 2,
      pageSize: 5,
    });
    expect(f.tx.activityContributionPolicySelectionRevision.findFirst).not.toHaveBeenCalled();
    expect(f.authorize).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the physical item count differs from the revision', async () => {
    const f = fixture();
    f.tx.activityContributionPolicySelectionItem.count.mockResolvedValue(2);
    await expect(
      f.service.get('activity-one', { page: 1, pageSize: 20 }, actor, 'admin'),
    ).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
    });
  });

  it('keeps options organization-scoped, time-bounded and reauthorized', async () => {
    const f = fixture();
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
    expect(f.tx.contributionPolicyVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10 }),
    );
  });
});
