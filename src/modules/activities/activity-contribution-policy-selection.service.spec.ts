import { Role, UserStatus, type Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { PrismaService } from '../../database/prisma.service';
import { fingerprintContributionPolicyVersion } from './activity-contribution-policy-definition';
import {
  activityContributionPolicySelectionHash,
  createActivityContributionPolicySelectionDocument,
} from './activity-contribution-policy-selection';
import type { ActivityContributionPolicySelectionAccess } from './activity-contribution-policy-selection-access';
import type { ActivityContributionPolicySelectionAuditRecorder } from './activity-contribution-policy-selection-audit-recorder';
import { ActivityContributionPolicySelectionService } from './activity-contribution-policy-selection.service';

const actor: CurrentUserPayload = {
  id: 'actor-one',
  username: 'actor-one',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: 'member-one',
};
const activityScope = {
  layerCode: 'activity' as const,
  sessionId: null,
  positionId: null,
};

function fixture() {
  const effectiveFrom = new Date('2099-01-01T00:00:00.000Z');
  const definition = {
    defaultResult: { recognizedPoints: '0.00', explanationCode: 'default_zero' },
    roleRules: [],
  };
  const fingerprint = fingerprintContributionPolicyVersion({
    schemaVersion: 1,
    evaluatorVersion: 1,
    definition,
    effectiveFrom: effectiveFrom.toISOString(),
    effectiveUntil: null,
  });
  const pointer = {
    policyId: 'policy-one',
    versionId: 'version-one',
    definitionHash: fingerprint.definitionHash,
    evaluatorVersion: 1,
  };
  const document = createActivityContributionPolicySelectionDocument([
    { scope: activityScope, selection: { mode: 'explicit', pointer } },
  ]);
  const revision = {
    id: 'revision-one',
    revision: 1,
    selectionHash: activityContributionPolicySelectionHash(document),
  };
  const version = {
    id: pointer.versionId,
    policyId: pointer.policyId,
    version: 1,
    schemaVersion: 1,
    definitionJson: definition,
    definitionHash: pointer.definitionHash,
    evaluatorVersion: 1,
    effectiveFrom,
    effectiveUntil: null,
    statusCode: 'active',
    createdByUserId: actor.id,
    activatedByUserId: actor.id,
    retiredByUserId: null,
    activatedAt: effectiveFrom,
    retiredAt: null,
    createdAt: effectiveFrom,
    updatedAt: effectiveFrom,
  };
  const queryRaw = jest
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: pointer.policyId }])
    .mockResolvedValueOnce([{ id: pointer.versionId }]);
  const receiptFindUnique = jest
    .fn<
      Promise<unknown>,
      [Prisma.ActivityContributionPolicySelectionCommandReceiptFindUniqueArgs]
    >()
    .mockResolvedValue(null);
  const receiptCreate = jest
    .fn<Promise<unknown>, [Prisma.ActivityContributionPolicySelectionCommandReceiptCreateArgs]>()
    .mockResolvedValue(undefined);
  const revisionCreate = jest
    .fn<Promise<typeof revision>, [Prisma.ActivityContributionPolicySelectionRevisionCreateArgs]>()
    .mockResolvedValue(revision);
  const tx = {
    $queryRaw: queryRaw,
    activityContributionPolicySelectionCommandReceipt: {
      findUnique: receiptFindUnique,
      create: receiptCreate,
    },
    activity: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'activity-one',
        startAt: new Date('2099-05-01T00:00:00.000Z'),
        endAt: new Date('2099-05-01T01:00:00.000Z'),
        contributionPolicySelectionRevision: 0,
        currentContributionPolicySelectionRevisionId: null,
      }),
      update: jest.fn().mockResolvedValue(undefined),
    },
    activitySessionPosition: { findMany: jest.fn().mockResolvedValue([]) },
    contributionPolicyVersion: { findMany: jest.fn().mockResolvedValue([version]) },
    activityContributionPolicySelectionRevision: {
      create: revisionCreate,
    },
    activityContributionPolicySelectionItem: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const transaction = jest.fn(
    async (callback: (client: Prisma.TransactionClient) => Promise<unknown>) =>
      callback(tx as unknown as Prisma.TransactionClient),
  );
  const authorize = jest.fn().mockResolvedValue({ actor, activity: { id: 'activity-one' } });
  const assertStandaloneWritable = jest.fn().mockResolvedValue(undefined);
  const audit = jest.fn().mockResolvedValue(undefined);
  const service = new ActivityContributionPolicySelectionService(
    { $transaction: transaction } as unknown as PrismaService,
    { authorize, assertStandaloneWritable } as unknown as ActivityContributionPolicySelectionAccess,
    { log: audit } as unknown as ActivityContributionPolicySelectionAuditRecorder,
  );
  const command = {
    operationKey: 'contribution-selection-operation-one',
    expectedRevision: 0,
    changes: [{ scope: activityScope, selection: { mode: 'explicit' as const, pointer } }],
  };
  return {
    service,
    tx,
    transaction,
    authorize,
    assertStandaloneWritable,
    audit,
    command,
    revision,
  };
}

describe('E1-3 contribution policy selection mutation', () => {
  it('writes revision, manifest, current pointer, receipt and audit in one transaction', async () => {
    const f = fixture();
    await expect(
      f.service.patch('activity-one', f.command, actor, 'admin', {
        requestId: 'request-one',
        ip: null,
        ua: null,
      }),
    ).resolves.toMatchObject({
      activityId: 'activity-one',
      selectionRevisionId: f.revision.id,
      revision: 1,
      selectionHash: f.revision.selectionHash,
    });
    expect(f.tx.activityContributionPolicySelectionRevision.create).toHaveBeenCalledTimes(1);
    expect(
      f.tx.activityContributionPolicySelectionRevision.create.mock.calls[0][0].data,
    ).toMatchObject({
      activityId: 'activity-one',
      revision: 1,
      originCode: 'select',
      createdByUserId: actor.id,
    });
    expect(f.tx.activityContributionPolicySelectionItem.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          selectionRevisionId: f.revision.id,
          activityId: 'activity-one',
          layerCode: 'activity',
          mode: 'explicit',
        }),
      ],
    });
    expect(f.tx.activity.update).toHaveBeenCalledWith({
      where: { id: 'activity-one' },
      data: {
        contributionPolicySelectionRevision: 1,
        currentContributionPolicySelectionRevisionId: f.revision.id,
      },
    });
    expect(f.authorize.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(f.assertStandaloneWritable.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(f.audit).toHaveBeenCalledTimes(1);
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'ReadCommitted',
      maxWait: 2_000,
      timeout: 10_000,
    });
  });

  it('rejects malformed commands before beginning the transaction', async () => {
    const f = fixture();
    await expect(
      f.service.patch('activity-one', { ...f.command, operationKey: 'short' }, actor, 'admin', {
        requestId: 'request-one',
        ip: null,
        ua: null,
      }),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_INVALID });
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it('returns an exact trustworthy replay without writing a second audit event', async () => {
    const f = fixture();
    const result = {
      activityId: 'activity-one',
      selectionRevisionId: f.revision.id,
      revision: 1,
      selectionHash: f.revision.selectionHash,
      createdAt: '2026-09-23T00:00:00.000Z',
    };
    await f.service.patch('activity-one', f.command, actor, 'admin', {
      requestId: 'request-one',
      ip: null,
      ua: null,
    });
    const receiptCall =
      f.tx.activityContributionPolicySelectionCommandReceipt.create.mock.calls[0][0];
    const replay = fixture();
    replay.tx.activityContributionPolicySelectionCommandReceipt.findUnique.mockResolvedValue({
      ...receiptCall.data,
      resultJson: result,
      revision: {
        id: f.revision.id,
        activityId: 'activity-one',
        createdByUserId: actor.id,
      },
    });
    await expect(
      replay.service.patch('activity-one', replay.command, actor, 'admin', {
        requestId: 'request-two',
        ip: null,
        ua: null,
      }),
    ).resolves.toEqual(result);
    expect(replay.tx.activityContributionPolicySelectionRevision.create).not.toHaveBeenCalled();
    expect(replay.audit).not.toHaveBeenCalled();
  });
});
