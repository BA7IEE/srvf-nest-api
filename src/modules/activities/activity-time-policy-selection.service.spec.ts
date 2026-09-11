import { Role, UserStatus, type Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { PrismaService } from '../../database/prisma.service';
import { fingerprintTimePolicyVersion } from './activity-time-policy-definition';
import {
  activityTimePolicySelectionHash,
  createActivityTimePolicySelectionDocument,
  emptyActivityTimePolicySelectionDocument,
} from './activity-time-policy-selection';
import type { ActivityTimePolicySelectionAccess } from './activity-time-policy-selection-access';
import type { ActivityTimePolicySelectionAuditRecorder } from './activity-time-policy-selection-audit-recorder';
import { ActivityTimePolicySelectionService } from './activity-time-policy-selection.service';

const actor: CurrentUserPayload = {
  id: 'actor-one',
  username: 'actor-one',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  memberId: 'member-one',
};
const pointer = {
  policyId: 'policy-one',
  versionId: 'version-one',
  definitionHash: 'a'.repeat(64),
};
const activityScope = { layerCode: 'activity' as const, sessionId: null, positionId: null };
const command = {
  operationKey: 'selection-operation-one',
  expectedRevision: 0,
  changes: [{ scope: activityScope, selection: { mode: 'explicit' as const, pointer } }],
};

type RevisionCreateCall = {
  data: {
    activityId: string;
    revision: number;
    originCode: string;
    createdByUserId: string;
  };
};

type ItemCreateCall = {
  data: Array<{
    selectionRevisionId: string;
    activityId: string;
    layerCode: string;
    mode: string;
  }>;
};

type ReceiptCreateCall = {
  data: {
    activityId: string;
    selectionRevisionId: string;
    operationCode: string;
    operationKey: string;
    requestHash: string;
    resultJson: unknown;
  };
};

function activePolicyVersion() {
  const effectiveFrom = new Date('2026-01-01T00:00:00.000Z');
  const definition = {
    defaultCategory: 'volunteer_service',
    roleMappings: [],
    allowSplit: false,
    specialIntervals: {
      preparation: { mode: 'exclude' },
      duty: { mode: 'exclude' },
      travel: { mode: 'exclude' },
    },
    rounding: { mode: 'floor', quantumSeconds: 1 },
    evidence: { requiredSources: [], requireManualRecognition: false },
    manualAdjustment: { enabled: false },
  };
  const fingerprint = fingerprintTimePolicyVersion({
    schemaVersion: 1,
    evaluatorVersion: 1,
    definition,
    effectiveFrom: effectiveFrom.toISOString(),
    effectiveUntil: null,
  });
  return {
    id: pointer.versionId,
    policyId: pointer.policyId,
    version: 1,
    schemaVersion: 1,
    evaluatorVersion: 1,
    definitionHash: pointer.definitionHash,
    definitionJson: definition,
    effectiveFrom,
    effectiveUntil: null,
    statusCode: 'active',
    activatedAt: effectiveFrom,
    retiredAt: null,
    createdAt: effectiveFrom,
    updatedAt: effectiveFrom,
    fingerprint,
  };
}

function patchFixture() {
  const version = activePolicyVersion();
  // The pointer hash is part of the public command grammar.  Build the version with its matching
  // persisted hash rather than bypassing the production verifier in this test.
  const matchingVersion = { ...version, definitionHash: version.fingerprint.definitionHash };
  const matchingPointer = { ...pointer, definitionHash: matchingVersion.definitionHash };
  const matchingCommand = {
    ...command,
    changes: [
      {
        scope: activityScope,
        selection: { mode: 'explicit' as const, pointer: matchingPointer },
      },
    ],
  };
  const nextDocument = createActivityTimePolicySelectionDocument([
    {
      scope: activityScope,
      selection: { mode: 'explicit', pointer: matchingPointer },
    },
  ]);
  const createdAt = new Date('2026-09-11T00:00:00.000Z');
  const revision = {
    id: 'selection-revision-one',
    revision: 1,
    selectionHash: activityTimePolicySelectionHash(nextDocument),
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    activityTimePolicySelectionCommandReceipt: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(undefined),
    },
    activity: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'activity-one',
        startAt: new Date('2099-10-01T00:00:00.000Z'),
        endAt: new Date('2099-10-01T01:00:00.000Z'),
        timePolicySelectionRevision: 0,
        currentTimePolicySelectionRevisionId: null,
      }),
      update: jest.fn().mockResolvedValue(undefined),
    },
    activitySession: { findMany: jest.fn().mockResolvedValue([]) },
    activitySessionPosition: { findMany: jest.fn().mockResolvedValue([]) },
    timePolicyVersion: { findMany: jest.fn().mockResolvedValue([matchingVersion]) },
    activityTimePolicySelectionRevision: { create: jest.fn().mockResolvedValue(revision) },
    activityTimePolicySelectionItem: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const transaction = jest.fn(
    async (callback: (client: Prisma.TransactionClient) => Promise<unknown>) =>
      callback(tx as unknown as Prisma.TransactionClient),
  );
  const authorize = jest.fn().mockResolvedValue({ actor, activity: { id: 'activity-one' } });
  const assertStandaloneWritable = jest.fn().mockResolvedValue(undefined);
  const auditLog = jest.fn().mockResolvedValue(undefined);
  const service = new ActivityTimePolicySelectionService(
    { $transaction: transaction } as unknown as PrismaService,
    { authorize, assertStandaloneWritable } as unknown as ActivityTimePolicySelectionAccess,
    { log: auditLog } as unknown as ActivityTimePolicySelectionAuditRecorder,
  );
  return {
    service,
    tx,
    transaction,
    authorize,
    assertStandaloneWritable,
    auditLog,
    revision,
    createdAt,
    command: matchingCommand,
  };
}

describe('D1-3 time policy selection mutation', () => {
  it('creates an immutable revision, manifest, receipt and audit record in one transaction', async () => {
    const f = patchFixture();
    const result = await f.service.patch('activity-one', f.command, actor, 'admin', {
      requestId: 'request-one',
      ip: null,
      ua: null,
    });
    expect(result).toMatchObject({
      activityId: 'activity-one',
      selectionRevisionId: f.revision.id,
      revision: 1,
      selectionHash: f.revision.selectionHash,
    });
    expect(typeof result.createdAt).toBe('string');
    const revisionCreateCalls = f.tx.activityTimePolicySelectionRevision.create.mock
      .calls as unknown as ReadonlyArray<readonly [RevisionCreateCall]>;
    const revisionCreate = revisionCreateCalls[0][0];
    expect(revisionCreate.data).toMatchObject({
      activityId: 'activity-one',
      revision: 1,
      originCode: 'select',
      createdByUserId: actor.id,
    });
    const itemCreateCalls = f.tx.activityTimePolicySelectionItem.createMany.mock
      .calls as unknown as ReadonlyArray<readonly [ItemCreateCall]>;
    const itemCreate = itemCreateCalls[0][0];
    expect(itemCreate.data).toHaveLength(1);
    expect(itemCreate.data[0]).toMatchObject({
      selectionRevisionId: f.revision.id,
      activityId: 'activity-one',
      layerCode: 'activity',
      mode: 'explicit',
    });
    expect(f.tx.activity.update).toHaveBeenCalledWith({
      where: { id: 'activity-one' },
      data: { timePolicySelectionRevision: 1, currentTimePolicySelectionRevisionId: f.revision.id },
    });
    const receiptCreateCalls = f.tx.activityTimePolicySelectionCommandReceipt.create.mock
      .calls as unknown as ReadonlyArray<readonly [ReceiptCreateCall]>;
    const receiptCreate = receiptCreateCalls[0][0];
    expect(receiptCreate.data).toMatchObject({
      activityId: 'activity-one',
      selectionRevisionId: f.revision.id,
      operationCode: 'patch_time_policy_selection',
      operationKey: f.command.operationKey,
    });
    expect(f.auditLog).toHaveBeenCalledWith(
      expect.anything(),
      actor,
      expect.anything(),
      expect.objectContaining({ selectionRevisionId: f.revision.id }),
      1,
    );
    // Initial authorization, advisory-lock recheck, Activity-lock recheck, then policy/version
    // lock rechecks: a current grant cannot be carried across any lock boundary.
    expect(f.authorize).toHaveBeenCalledTimes(5);
    expect(f.assertStandaloneWritable).toHaveBeenCalledTimes(3);
  });

  it('replays the original receipt without appending another immutable revision', async () => {
    const f = patchFixture();
    const first = await f.service.patch('activity-one', f.command, actor, 'admin', {
      requestId: 'request-one',
      ip: null,
      ua: null,
    });
    const createdReceiptCalls = f.tx.activityTimePolicySelectionCommandReceipt.create.mock
      .calls as unknown as ReadonlyArray<readonly [ReceiptCreateCall]>;
    const createdReceipt = createdReceiptCalls[0][0];
    f.tx.activityTimePolicySelectionCommandReceipt.findUnique.mockResolvedValue({
      requestHash: createdReceipt.data.requestHash,
      activityId: 'activity-one',
      selectionRevisionId: f.revision.id,
      resultJson: createdReceipt.data.resultJson,
      revision: {
        activityId: 'activity-one',
        id: f.revision.id,
        createdByUserId: actor.id,
      },
    });
    await expect(
      f.service.patch('activity-one', f.command, actor, 'admin', {
        requestId: 'request-two',
        ip: null,
        ua: null,
      }),
    ).resolves.toEqual(first);
    expect(f.tx.activityTimePolicySelectionRevision.create).toHaveBeenCalledTimes(1);
    expect(f.tx.activityTimePolicySelectionItem.createMany).toHaveBeenCalledTimes(1);
    expect(f.tx.activity.update).toHaveBeenCalledTimes(1);
  });

  it('rejects stale expected revisions before a manifest write', async () => {
    const f = patchFixture();
    f.tx.activity.findFirst.mockResolvedValue({
      id: 'activity-one',
      startAt: new Date('2099-10-01T00:00:00.000Z'),
      endAt: new Date('2099-10-01T01:00:00.000Z'),
      timePolicySelectionRevision: 2,
      currentTimePolicySelectionRevisionId: 'selection-revision-two',
    });
    await expect(
      f.service.patch('activity-one', f.command, actor, 'admin', {
        requestId: 'request-one',
        ip: null,
        ua: null,
      }),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_POLICY_SELECTION_STALE });
    expect(f.tx.activityTimePolicySelectionRevision.create).not.toHaveBeenCalled();
    expect(f.tx.activityTimePolicySelectionItem.createMany).not.toHaveBeenCalled();
  });

  it('retains the exact current publish-review revision without duplicating it', async () => {
    const document = emptyActivityTimePolicySelectionDocument();
    const hash = activityTimePolicySelectionHash(document);
    const tx = {
      activity: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'activity-one',
          startAt: new Date('2099-10-01T00:00:00.000Z'),
          endAt: new Date('2099-10-01T01:00:00.000Z'),
          timePolicySelectionRevision: 1,
          currentTimePolicySelectionRevisionId: 'selection-revision-one',
        }),
      },
      activityTimePolicySelectionRevision: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'selection-revision-one',
          revision: 1,
          selectionHash: hash,
          selectionJson: document,
          itemCount: 1,
          templateId: null,
          templateDefinitionHash: null,
        }),
        create: jest.fn(),
      },
    };
    const service = new ActivityTimePolicySelectionService(
      {} as PrismaService,
      {} as ActivityTimePolicySelectionAccess,
      {} as ActivityTimePolicySelectionAuditRecorder,
    );
    await expect(
      service.applyPublishReviewSelectionWithinTransaction({
        tx: tx as unknown as Prisma.TransactionClient,
        activityId: 'activity-one',
        selection: document,
        expectedSelectionRevision: 1,
        actor,
        meta: { requestId: 'request-one', ip: null, ua: null },
        publishReviewId: 'review-one',
        proposalSelectionHash: hash,
        revalidate: jest.fn(),
      }),
    ).resolves.toEqual({
      selectionRevisionId: 'selection-revision-one',
      revision: 1,
      selectionHash: hash,
      selection: document,
    });
    expect(tx.activityTimePolicySelectionRevision.create).not.toHaveBeenCalled();
  });

  it('fails closed when a publish-review selection does not match the current immutable hash', async () => {
    const document = emptyActivityTimePolicySelectionDocument();
    const tx = {
      activity: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'activity-one',
          startAt: new Date('2099-10-01T00:00:00.000Z'),
          endAt: new Date('2099-10-01T01:00:00.000Z'),
          timePolicySelectionRevision: 1,
          currentTimePolicySelectionRevisionId: 'selection-revision-one',
        }),
      },
      activityTimePolicySelectionRevision: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'selection-revision-one',
          revision: 1,
          selectionHash: 'b'.repeat(64),
          selectionJson: document,
          itemCount: 1,
          templateId: null,
          templateDefinitionHash: null,
        }),
      },
    };
    const service = new ActivityTimePolicySelectionService(
      {} as PrismaService,
      {} as ActivityTimePolicySelectionAccess,
      {} as ActivityTimePolicySelectionAuditRecorder,
    );
    await expect(
      service.applyPublishReviewSelectionWithinTransaction({
        tx: tx as unknown as Prisma.TransactionClient,
        activityId: 'activity-one',
        selection: document,
        expectedSelectionRevision: 1,
        actor,
        meta: { requestId: 'request-one', ip: null, ua: null },
        publishReviewId: 'review-one',
        proposalSelectionHash: activityTimePolicySelectionHash(document),
        revalidate: jest.fn(),
      }),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE });
  });
});
