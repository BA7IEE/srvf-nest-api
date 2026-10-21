import { Test, type TestingModule } from '@nestjs/testing';
import { Prisma, Role, UserStatus, type ActivitySettlementTimeRevision } from '@prisma/client';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import appConfig from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import { ParticipationSegmentFacade } from '../attendances/participation-segment.facade';
import { ActivityTimeAllocationService } from './activity-time-allocation.service';
import { ActivityTimeSettlementAccessService } from './activity-time-settlement-access.service';
import { ActivityTimeSettlementAuditRecorder } from './activity-time-settlement-audit-recorder';
import {
  TIME_SETTLEMENT_PREPARE_OPERATION,
  TIME_SETTLEMENT_SUBMIT_OPERATION,
  parseTimeSettlementPrepareCommand,
  parseTimeSettlementSubmitCommand,
  timeSettlementPrepareRequestHash,
  timeSettlementSubmitRequestHash,
  type TimeSettlementReceiptResult,
} from './activity-time-settlement-command';
import { ActivityTimeSettlementQueryService } from './activity-time-settlement-query.service';
import { ActivityTimeSettlementService } from './activity-time-settlement.service';
import { ActivityContributionSettlementService } from './activity-contribution-settlement.service';
import type { TimeSettlementBucket } from './activity-time-settlement-policy';
import {
  SettlementSubmitService,
  SETTLEMENT_SUBMIT_TX_TIMEOUT_MS,
} from './settlement-submit.service';

const activityId = 'activity';
const actor: CurrentUserPayload = {
  id: 'actor',
  memberId: 'member',
  username: 'fixture',
  role: Role.USER,
  status: UserStatus.ACTIVE,
};
const meta = { requestId: 'd4-unit', ip: null, ua: null };
const prepare = {
  operationKey: 'prepare-key',
  expectedDraftVersion: 1,
  expectedEvidenceSealId: 'seal',
  expectedTimeRevision: 0,
};
const submit = {
  operationKey: 'submit-key',
  expectedDraftVersion: 1,
  expectedEvidenceSealId: 'seal',
  timeRevisionId: 'time-revision',
  expectedBucketContentHash: 'b'.repeat(64),
};
const allocate = {
  operationKey: 'allocate-key',
  expectedDraftVersion: 1,
  expectedEvidenceSealId: 'seal',
  expectedEvidenceRevision: 0,
  expectedPopulationRevision: 0,
  expectedWorkflowRevision: 0,
  sourceSegmentId: 'source',
  expectedRevision: 0,
  recognitionModeCode: 'automatic',
  evidenceAttachmentIds: [],
};
const parent: ActivitySettlementTimeRevision = {
  id: 'time-revision',
  activityId,
  settlementRunId: 'run',
  settlementVersionId: 'version',
  revision: 1,
  previousTimeRevisionId: null,
  kindCode: 'draft',
  sourceDraftTimeRevisionId: null,
  evidenceSealId: 'seal',
  evidenceRevision: 0,
  populationRevision: 0,
  workflowRevision: 0,
  draftContentHash: 'a'.repeat(64),
  sourceSetHash: 'c'.repeat(64),
  bucketContentHash: 'b'.repeat(64),
  bucketCount: 4,
  sourceCount: 0,
  createdAt: new Date('2020-01-01T00:00:00.000Z'),
  createdByUserId: actor.id,
};
const result: TimeSettlementReceiptResult = {
  schemaVersion: 1,
  activityId,
  timeRevisionId: parent.id,
  revision: 1,
  kindCode: 'draft',
  settlementRunId: 'run',
  settlementVersionId: 'version',
  settlementVersion: 1,
  contentHash: parent.draftContentHash,
  bucketContentHash: parent.bucketContentHash,
  bucketCount: 4,
  sourceCount: 0,
  createdAt: parent.createdAt.toISOString(),
};

describe('D4 write orchestration and replay safety', () => {
  let module: TestingModule;
  let tx: PrismaService;
  let service: ActivityTimeSettlementService;
  let receiptLookup: jest.SpyInstance;
  const config = { activityV11Workflow: { enabled: true, readonlyMaintenance: false } };
  const access = {
    authorize: jest.fn<
      Promise<{ actor: CurrentUserPayload }>,
      [Prisma.TransactionClient, CurrentUserPayload, string, string]
    >(),
  };
  const queries = {
    readDraftContextInTx: jest.fn(),
    readSourceSetInTx: jest.fn(),
    evaluateInTx: jest.fn(),
  };
  const segments = { lockActivityForTimeAllocationWrite: jest.fn() };
  const allocations = { recognizeSealedDraftInTx: jest.fn() };
  const settlements = { submitTimeSettlementInTx: jest.fn() };
  const audit = { log: jest.fn() };
  const contributions = {
    assertNativeWriteAllowed: jest.fn(),
    prepareTimeInTx: jest.fn(),
    assertNewNativeActivityInTx: jest.fn(),
    usesLaunchAdmission: false,
  };
  const transaction = jest.fn(
    async (work: (client: Prisma.TransactionClient) => Promise<unknown>) => work(tx),
  );

  beforeEach(async () => {
    jest.resetAllMocks();
    contributions.usesLaunchAdmission = false;
    config.activityV11Workflow.enabled = true;
    config.activityV11Workflow.readonlyMaintenance = false;
    // No connection is opened. All reachable delegates are mocked; the actual generated client
    // supplies the transaction type so incomplete object casts cannot conceal a schema drift.
    tx = new PrismaService();
    jest.spyOn(tx, '$queryRaw').mockResolvedValue([{ id: 'run' }]);
    receiptLookup = jest
      .spyOn(tx.activitySettlementTimeCommandReceipt, 'findUnique')
      .mockResolvedValue(null);
    transaction.mockImplementation(async (work) => work(tx));
    access.authorize.mockResolvedValue({ actor });
    audit.log.mockResolvedValue(undefined);
    module = await Test.createTestingModule({
      providers: [
        ActivityTimeSettlementService,
        ActivityWorkflowGate,
        { provide: appConfig.KEY, useValue: config },
        { provide: PrismaService, useValue: { $transaction: transaction } },
        { provide: ActivityTimeSettlementAccessService, useValue: access },
        { provide: ActivityTimeSettlementQueryService, useValue: queries },
        { provide: ParticipationSegmentFacade, useValue: segments },
        { provide: ActivityTimeAllocationService, useValue: allocations },
        { provide: SettlementSubmitService, useValue: settlements },
        { provide: ActivityTimeSettlementAuditRecorder, useValue: audit },
        { provide: ActivityContributionSettlementService, useValue: contributions },
      ],
    }).compile();
    service = module.get(ActivityTimeSettlementService);
  });
  afterEach(async () => {
    await module.close();
    await tx.$disconnect();
    jest.restoreAllMocks();
  });

  const commands = { allocate, prepare, submit };
  const methods = ['allocate', 'prepare', 'submit'] as const;
  const blockedStates = [
    { enabled: false, readonlyMaintenance: false, biz: BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED },
    {
      enabled: false,
      readonlyMaintenance: true,
      biz: BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE,
    },
    {
      enabled: true,
      readonlyMaintenance: true,
      biz: BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE,
    },
  ];
  it.each(methods)(
    '%s rejects all three forbidden Gate states before parsing or database access',
    async (method) => {
      for (const state of blockedStates) {
        config.activityV11Workflow.enabled = state.enabled;
        config.activityV11Workflow.readonlyMaintenance = state.readonlyMaintenance;
        // A malformed payload must not bypass the Gate or change error precedence.
        await expect(service[method](activityId, null, actor, meta)).rejects.toThrow(
          new BizException(state.biz),
        );
      }
      expect(transaction).not.toHaveBeenCalled();
      expect(access.authorize).not.toHaveBeenCalled();
    },
  );

  it.each(methods)(
    '%s rejects malformed input before opening a transaction in the allowed Gate state',
    async (method) => {
      await expect(
        service[method](activityId, { ...commands[method], unexpected: true }, actor, meta),
      ).rejects.toThrow(new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_INVALID));
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  function receipt(method: 'prepare' | 'submit' = 'prepare') {
    const operationCode =
      method === 'prepare' ? TIME_SETTLEMENT_PREPARE_OPERATION : TIME_SETTLEMENT_SUBMIT_OPERATION;
    const requestHash =
      method === 'prepare'
        ? timeSettlementPrepareRequestHash(
            activityId,
            actor.id,
            parseTimeSettlementPrepareCommand(prepare),
          )
        : timeSettlementSubmitRequestHash(
            activityId,
            actor.id,
            parseTimeSettlementSubmitCommand(submit),
          );
    const kindCode = method === 'prepare' ? 'draft' : 'submitted';
    const row = {
      id: 'receipt',
      actorUserId: actor.id,
      activityId,
      operationCode,
      operationKey: commands[method].operationKey,
      requestHash,
      timeRevisionId: parent.id,
      resultJson: { ...result, kindCode },
      createdAt: parent.createdAt,
      timeRevision: { ...parent, kindCode },
    };
    jest.spyOn(tx.activitySettlementTimeCommandReceipt, 'findUnique').mockResolvedValue(row);
    return row;
  }

  it.each(['prepare', 'submit'] as const)(
    '%s replays from its own namespace under one transaction without recalculating sources',
    async (method) => {
      const saved = receipt(method);
      await expect(service[method](activityId, commands[method], actor, meta)).resolves.toEqual(
        saved.resultJson,
      );
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 2000,
        timeout: method === 'prepare' ? 60000 : SETTLEMENT_SUBMIT_TX_TIMEOUT_MS,
      });
      expect(receiptLookup).toHaveBeenCalledWith({
        where: {
          actorUserId_operationCode_operationKey: {
            actorUserId: actor.id,
            operationCode: saved.operationCode,
            operationKey: commands[method].operationKey,
          },
        },
        include: { timeRevision: true },
      });
      expect(segments.lockActivityForTimeAllocationWrite).toHaveBeenCalledWith(tx, activityId);
      expect(access.authorize).toHaveBeenCalledTimes(7);
      expect(
        access.authorize.mock.calls.every((args) => args[0] === tx && args[3] === method),
      ).toBe(true);
      expect(audit.log).toHaveBeenCalledWith(
        tx,
        actor,
        meta,
        saved.operationCode,
        saved.resultJson,
        true,
      );
      expect(queries.readDraftContextInTx).not.toHaveBeenCalled();
      expect(queries.readSourceSetInTx).not.toHaveBeenCalled();
      expect(settlements.submitTimeSettlementInTx).not.toHaveBeenCalled();
    },
  );

  it.each([1, 2, 3, 4, 5, 6, 7])(
    'rejects replay when current qualification disappears at authorization point %s',
    async (point) => {
      receipt();
      let call = 0;
      access.authorize.mockImplementation(() => {
        if (++call === point) throw new BizException(BizCode.FORBIDDEN);
        return Promise.resolve({ actor });
      });
      await expect(service.prepare(activityId, prepare, actor, meta)).rejects.toThrow(
        new BizException(BizCode.FORBIDDEN),
      );
      expect(access.authorize).toHaveBeenCalledTimes(point);
      expect(queries.evaluateInTx).not.toHaveBeenCalled();
    },
  );

  it.each(['activity', 'hash', 'parent-activity', 'parent-id', 'parent-actor', 'result-extra'])(
    'rejects an incompatible receipt: %s',
    async (change) => {
      const row = receipt();
      if (change === 'activity') row.activityId = 'other';
      if (change === 'hash') row.requestHash = 'f'.repeat(64);
      if (change === 'parent-activity') row.timeRevision.activityId = 'other';
      if (change === 'parent-id') row.timeRevision.id = 'other';
      if (change === 'parent-actor') row.timeRevision.createdByUserId = 'other';
      if (change === 'result-extra') Object.assign(row.resultJson, { extra: 'reject' });
      const code =
        change === 'activity' || change === 'hash'
          ? BizCode.ACTIVITY_TIME_SETTLEMENT_COMMAND_CONFLICT
          : BizCode.ACTIVITY_TIME_SETTLEMENT_INVALID;
      await expect(service.prepare(activityId, prepare, actor, meta)).rejects.toThrow(
        new BizException(code),
      );
      expect(audit.log).not.toHaveBeenCalled();
    },
  );

  it('does not turn failed replay audit into a successful receipt response', async () => {
    receipt();
    audit.log.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(service.prepare(activityId, prepare, actor, meta)).rejects.toThrow(
      'audit unavailable',
    );
  });

  it('requires an existing settlement run before touching any source writer', async () => {
    jest.spyOn(tx, '$queryRaw').mockResolvedValue([]);
    await expect(service.allocate(activityId, allocate, actor, meta)).rejects.toThrow(
      new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY),
    );
    expect(allocations.recognizeSealedDraftInTx).not.toHaveBeenCalled();
    expect(access.authorize).toHaveBeenCalledTimes(4);
  });

  it('passes the same transaction and a fresh proof callback to the existing D3 writer', async () => {
    queries.readDraftContextInTx.mockResolvedValue({
      runId: 'run',
      runStatusCode: 'drafting',
      currentDraftVersion: 1,
      currentSubmittedVersion: null,
      draftId: 'draft',
      draftVersion: 1,
      evidenceSealId: 'seal',
      evidenceRevision: 0,
      populationRevision: 0,
      workflowRevision: 0,
      draftContentHash: 'a'.repeat(64),
      sealCurrent: true,
    });
    allocations.recognizeSealedDraftInTx.mockImplementation(
      async (
        client: Prisma.TransactionClient,
        _id: string,
        _command: unknown,
        _hash: string,
        _meta: unknown,
        reauthorize: () => Promise<CurrentUserPayload>,
        proof: () => Promise<unknown>,
      ) => {
        expect(client).toBe(tx);
        expect(await reauthorize()).toEqual(actor);
        expect(await proof()).toEqual({
          settlementDraftVersionId: 'draft',
          settlementEvidenceSealId: 'seal',
          settlementEvidenceRevision: 0,
          settlementPopulationRevision: 0,
          settlementWorkflowRevision: 0,
          settlementDraftContentHash: 'a'.repeat(64),
        });
        return { allocationRevisionId: 'allocation' };
      },
    );
    await expect(service.allocate(activityId, allocate, actor, meta)).resolves.toEqual({
      allocationRevisionId: 'allocation',
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 2000,
      timeout: 30000,
    });
    expect(queries.readDraftContextInTx).toHaveBeenCalledTimes(2);
    expect(queries.readDraftContextInTx).toHaveBeenCalledWith(tx, activityId);
  });

  it('maps unique command collisions without swallowing unrelated infrastructure failures', async () => {
    transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }),
    );
    await expect(service.prepare(activityId, prepare, actor, meta)).rejects.toThrow(
      new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_COMMAND_CONFLICT),
    );
    const failure = new Error('connection unavailable');
    transaction.mockRejectedValueOnce(failure);
    await expect(service.prepare(activityId, prepare, actor, meta)).rejects.toBe(failure);
  });

  it('preserves the original transaction-expiry error under the scoped prepare budget', async () => {
    const failure = new Prisma.PrismaClientKnownRequestError('transaction expired', {
      code: 'P2028',
      clientVersion: 'test',
    });
    transaction.mockRejectedValueOnce(failure);
    await expect(service.prepare(activityId, prepare, actor, meta)).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 2000,
      timeout: 60000,
    });
    expect(audit.log).not.toHaveBeenCalled();
  });

  function freshPrepare(regime = 'policy_v1') {
    const revision = { ...parent, bucketCount: 0 };
    const response = { ...result, bucketCount: 0 };
    queries.readDraftContextInTx.mockResolvedValue({
      runId: 'run',
      runStatusCode: 'drafting',
      currentDraftVersion: 1,
      currentSubmittedVersion: null,
      draftId: 'version',
      draftVersion: 1,
      evidenceSealId: 'seal',
      evidenceRevision: 0,
      populationRevision: 0,
      workflowRevision: 0,
      draftContentHash: 'a'.repeat(64),
      sealCurrent: true,
      contributionRegimeCode: regime,
    });
    queries.readSourceSetInTx.mockResolvedValue({
      population: [],
      segments: [],
      latest: [],
      sourceSetHash: 'c'.repeat(64),
    });
    queries.evaluateInTx.mockResolvedValue({
      bucketContentHash: 'b'.repeat(64),
      bucketCount: 0,
      sourceCount: 0,
      buckets: [],
    });
    jest.spyOn(tx.activitySettlementTimeRevision, 'findFirst').mockResolvedValue(null);
    const createRevision = jest
      .spyOn(tx.activitySettlementTimeRevision, 'create')
      .mockResolvedValue(revision);
    const createReceipt = jest
      .spyOn(tx.activitySettlementTimeCommandReceipt, 'create')
      .mockResolvedValue({
        id: 'fresh-receipt',
        actorUserId: actor.id,
        activityId,
        operationCode: TIME_SETTLEMENT_PREPARE_OPERATION,
        operationKey: prepare.operationKey,
        requestHash: timeSettlementPrepareRequestHash(
          activityId,
          actor.id,
          parseTimeSettlementPrepareCommand(prepare),
        ),
        timeRevisionId: revision.id,
        resultJson: response,
        createdAt: revision.createdAt,
      });
    const executeRaw = jest.spyOn(tx, '$executeRaw').mockResolvedValue(0);
    const proof = { id: 'contribution-revision' };
    contributions.prepareTimeInTx.mockResolvedValue(regime === 'policy_v1' ? proof : null);
    return { response, revision, createRevision, createReceipt, executeRaw, proof };
  }

  it('locks pre-wait references and evaluates only the subsequent complete source read', async () => {
    const f = freshPrepare('legacy');
    const raw = jest.spyOn(tx, '$queryRaw');
    const beforeWait = {
      population: [],
      segments: [{ id: 'before-wait-segment' }],
      latest: [
        {
          id: 'before-wait-allocation',
          participationIdentityId: 'identity',
          segmentKey: 'key',
          allocationHash: 'd'.repeat(64),
          ruleSnapshotId: 'before-wait-snapshot',
          policyVersionId: 'before-wait-policy',
          sliceCount: 0,
        },
      ],
      sourceSetHash: 'd'.repeat(64),
    };
    const afterWait = {
      population: [],
      segments: [],
      latest: [],
      sourceSetHash: 'e'.repeat(64),
    };
    queries.readSourceSetInTx.mockResolvedValueOnce(beforeWait).mockResolvedValueOnce(afterWait);
    await expect(service.prepare(activityId, prepare, actor, meta)).resolves.toEqual(f.response);
    expect(queries.readSourceSetInTx).toHaveBeenNthCalledWith(1, tx, expect.any(Object), true);
    expect(queries.readSourceSetInTx).toHaveBeenNthCalledWith(2, tx, expect.any(Object));
    expect(queries.evaluateInTx).toHaveBeenCalledWith(tx, afterWait, false);
    expect(f.createRevision).toHaveBeenCalledTimes(1);
    expect(f.createRevision.mock.calls[0]?.[0].data.sourceSetHash).toBe(afterWait.sourceSetHash);
    const callFor = (table: string) =>
      raw.mock.calls.find((call) => statement(call[0]).includes('FROM "' + table + '"'));
    expect(callFor('ParticipantServiceSegmentRevision')?.[1]).toEqual(['before-wait-segment']);
    expect(callFor('ActivityRuleSnapshot')?.[1]).toEqual(['before-wait-snapshot']);
    expect(callFor('TimePolicyVersion')?.[1]).toEqual(['before-wait-policy']);
  });

  it('preserves first-source rejection before acquiring identity locks or evaluating', async () => {
    const f = freshPrepare('legacy');
    const raw = jest.spyOn(tx, '$queryRaw');
    const failure = new Error('fixed first-source validation failure');
    queries.readSourceSetInTx.mockRejectedValue(failure);
    await expect(service.prepare(activityId, prepare, actor, meta)).rejects.toBe(failure);
    expect(queries.readSourceSetInTx).toHaveBeenCalledTimes(1);
    expect(
      raw.mock.calls.some((call) =>
        statement(call[0]).includes('FROM "ActivityParticipationIdentity"'),
      ),
    ).toBe(false);
    expect(queries.evaluateInTx).not.toHaveBeenCalled();
    expect(f.createRevision).not.toHaveBeenCalled();
    expect(f.createReceipt).not.toHaveBeenCalled();
  });

  const nativeBarrier =
    'SET CONSTRAINTS public.astr_parent_complete_guard, public.e4_revision_complete_guard IMMEDIATE';
  function statement(query: TemplateStringsArray | Prisma.Sql) {
    return ('sql' in query ? query.sql : query.join('')).replace(/\s+/gu, ' ').trim();
  }

  it('keeps all SQL-selected bucket/source values and shared IDs while projecting each JSON payload', async () => {
    const sources = [
      {
        allocationRevisionId: 'allocation-a',
        sourceSegmentId: 'segment-a',
        sourceSegmentRevision: 2,
        rawCalculatedMilliseconds: null,
        rawRecognizedMilliseconds: 9007199254740993n,
      },
      {
        allocationRevisionId: 'allocation-b',
        sourceSegmentId: 'segment-b',
        sourceSegmentRevision: 1,
        rawCalculatedMilliseconds: 3000n,
        rawRecognizedMilliseconds: 2000n,
      },
    ];
    const buckets: TimeSettlementBucket[] = [
      {
        participationIdentityId: 'identity-a',
        categoryCode: 'volunteer_service',
        calculatedSeconds: null,
        recognizedSeconds: 3,
        rawCalculatedMilliseconds: null,
        rawRecognizedMilliseconds: 9007199254742993n,
        timePolicyVersionId: 'policy',
        definitionHash: 'd'.repeat(64),
        evaluatorVersion: 1,
        quantumSeconds: 1,
        adjustmentReason: [{ allocationRevisionId: 'allocation-a', manualReason: 'approved' }],
        emptyReasonCode: null,
        sources,
      },
      {
        participationIdentityId: 'identity-b',
        categoryCode: 'training',
        calculatedSeconds: 0,
        recognizedSeconds: 0,
        rawCalculatedMilliseconds: 0n,
        rawRecognizedMilliseconds: 0n,
        timePolicyVersionId: null,
        definitionHash: null,
        evaluatorVersion: null,
        quantumSeconds: null,
        adjustmentReason: null,
        emptyReasonCode: 'no_valid_segment',
        sources: [],
      },
    ];
    const execute = jest.spyOn(tx, '$executeRaw').mockResolvedValueOnce(2).mockResolvedValueOnce(2);
    const insert = Reflect.get(service, 'insertBuckets') as (
      client: Prisma.TransactionClient,
      revision: ActivitySettlementTimeRevision,
      rows: readonly TimeSettlementBucket[],
    ) => Promise<void>;
    await insert.call(service, tx, { ...parent, bucketCount: 2, sourceCount: 2 }, buckets);
    expect(execute).toHaveBeenCalledTimes(2);
    const keys = [
      'id',
      'participationIdentityId',
      'categoryCode',
      'calculatedSeconds',
      'recognizedSeconds',
      'adjustmentReason',
      'timePolicyVersionId',
      'definitionHash',
      'evaluatorVersion',
      'quantumSeconds',
      'rawCalculatedMilliseconds',
      'rawRecognizedMilliseconds',
      'emptyReasonCode',
    ];
    const sourceKeys = [
      'allocationRevisionId',
      'sourceSegmentId',
      'sourceSegmentRevision',
      'rawCalculatedMilliseconds',
      'rawRecognizedMilliseconds',
    ];
    const firstWire = JSON.parse(
      (execute.mock.calls[0][0] as Prisma.Sql).values.at(-1) as string,
    ) as unknown[][];
    const adjustmentDictionary = JSON.parse(
      (execute.mock.calls[0][0] as Prisma.Sql).values.at(-2) as string,
    ) as unknown[];
    const secondWire = JSON.parse(
      (execute.mock.calls[1][0] as Prisma.Sql).values.at(-1) as string,
    ) as [string, unknown[][]][];
    const first = firstWire.map((row) =>
      Object.fromEntries(
        keys.map((key, index) => [
          key,
          key === 'adjustmentReason' ? adjustmentDictionary[row[index] as number] : row[index],
        ]),
      ),
    );
    const second = secondWire.map(([id, sources]) => ({
      id,
      sources: sources.map((row) =>
        Object.fromEntries(sourceKeys.map((key, index) => [key, row[index]])),
      ),
    }));
    expect(new Set(first.map((row) => row.id)).size).toBe(2);
    expect(first).toEqual(
      buckets.map(({ sources: _sources, ...row }, index) => {
        void _sources;
        return {
          ...row,
          id: first[index].id,
          rawCalculatedMilliseconds: row.rawCalculatedMilliseconds?.toString() ?? null,
          rawRecognizedMilliseconds: row.rawRecognizedMilliseconds.toString(),
        };
      }),
    );
    expect(second).toEqual(
      buckets.map((row, index) => ({
        id: first[index].id,
        sources: row.sources.map((source) => ({
          ...source,
          rawCalculatedMilliseconds: source.rawCalculatedMilliseconds?.toString() ?? null,
          rawRecognizedMilliseconds: source.rawRecognizedMilliseconds.toString(),
        })),
      })),
    );
    expect(statement(execute.mock.calls[0][0])).toContain(
      'INSERT INTO "ParticipantSettlementTimeBucket"',
    );
    expect(statement(execute.mock.calls[1][0])).toContain(
      'INSERT INTO "ParticipantSettlementTimeBucketSource"',
    );
    expect(buckets[0].sources).toBe(sources);
    expect(sources[0].rawRecognizedMilliseconds).toBe(9007199254740993n);
  });

  function emptyWireBucket(overrides: Partial<TimeSettlementBucket> = {}): TimeSettlementBucket {
    return {
      participationIdentityId: 'identity',
      categoryCode: 'training',
      calculatedSeconds: 0,
      recognizedSeconds: 0,
      rawCalculatedMilliseconds: 0n,
      rawRecognizedMilliseconds: 0n,
      timePolicyVersionId: null,
      definitionHash: null,
      evaluatorVersion: null,
      quantumSeconds: null,
      adjustmentReason: null,
      emptyReasonCode: 'no_valid_segment',
      sources: [],
      ...overrides,
    };
  }

  it('retains null, empty, duplicate, ordered and escaped reasons while sharing equal ordinary wire values', async () => {
    const manual = [
      { allocationRevisionId: 'allocation-a', manualReason: '中文 "quoted" \\ line\nnext' },
      { allocationRevisionId: 'allocation-b', manualReason: 'another' },
    ];
    const reasons = [
      null,
      [],
      manual,
      manual.map((row) => ({ ...row })),
      [...manual].reverse(),
      [manual[0], manual[0]],
    ];
    const buckets = reasons.map((adjustmentReason) => emptyWireBucket({ adjustmentReason }));
    const execute = jest.spyOn(tx, '$executeRaw').mockResolvedValueOnce(6).mockResolvedValueOnce(0);
    const insert = Reflect.get(service, 'insertBuckets') as (
      client: Prisma.TransactionClient,
      revision: ActivitySettlementTimeRevision,
      rows: readonly TimeSettlementBucket[],
    ) => Promise<void>;
    await insert.call(service, tx, { ...parent, bucketCount: 6, sourceCount: 0 }, buckets);
    expect(execute).toHaveBeenCalledTimes(2);
    const query = execute.mock.calls[0][0] as Prisma.Sql;
    const dictionary = JSON.parse(query.values.at(-2) as string) as unknown[];
    const wire = JSON.parse(query.values.at(-1) as string) as unknown[][];
    expect(wire.map((row) => dictionary[row[5] as number])).toEqual(reasons);
    expect(dictionary).toHaveLength(5);
    expect(wire[2][5]).toBe(wire[3][5]);
    expect(wire[4][5]).not.toBe(wire[2][5]);
    expect(wire[5][5]).not.toBe(wire[2][5]);
    // Parsing the dictionary once must also hold when PostgreSQL uses a generic plan.
    expect(statement(query)).toContain('WITH adjustment_wire AS MATERIALIZED');
    expect(statement(query)).toContain('nullif(adjustment_wire.reasons -> ((item->>5)::INTEGER),');
  });

  it('removes repeated wire keys at the full 8000/40000 scale while retaining two writes and parent links', async () => {
    const buckets = Array.from({ length: 8000 }, (_, index) =>
      emptyWireBucket({
        participationIdentityId: 'identity-' + Math.floor(index / 4),
        sources: Array.from({ length: 5 }, (_, source) => ({
          allocationRevisionId: 'allocation-' + index + '-' + source,
          sourceSegmentId: 'segment-' + index + '-' + source,
          sourceSegmentRevision: 1,
          rawCalculatedMilliseconds: null,
          rawRecognizedMilliseconds: 9007199254740993n,
        })),
      }),
    );
    const execute = jest
      .spyOn(tx, '$executeRaw')
      .mockResolvedValueOnce(8000)
      .mockResolvedValueOnce(40000);
    const insert = Reflect.get(service, 'insertBuckets') as (
      client: Prisma.TransactionClient,
      revision: ActivitySettlementTimeRevision,
      rows: readonly TimeSettlementBucket[],
    ) => Promise<void>;
    await insert.call(service, tx, { ...parent, bucketCount: 8000, sourceCount: 40000 }, buckets);
    expect(execute).toHaveBeenCalledTimes(2);
    const bucketJson = (execute.mock.calls[0][0] as Prisma.Sql).values.at(-1) as string;
    const sourceJson = (execute.mock.calls[1][0] as Prisma.Sql).values.at(-1) as string;
    const wire = JSON.parse(bucketJson) as unknown[][];
    const sourceWire = JSON.parse(sourceJson) as [string, unknown[][]][];
    expect(wire).toHaveLength(8000);
    expect(new Set(wire.map((row) => row[0])).size).toBe(8000);
    expect(sourceWire.map((row) => row[0])).toEqual(wire.map((row) => row[0]));
    expect(sourceWire.reduce((sum, row) => sum + row[1].length, 0)).toBe(40000);
    expect(sourceWire[0][1][0][4]).toBe('9007199254740993');
    const legacySourceJson = JSON.stringify(
      buckets.map((row, index) => ({
        id: wire[index][0],
        sources: row.sources.map((source) => ({
          ...source,
          rawCalculatedMilliseconds: null,
          rawRecognizedMilliseconds: source.rawRecognizedMilliseconds.toString(),
        })),
      })),
    );
    expect(Buffer.byteLength(sourceJson)).toBeLessThan(Buffer.byteLength(legacySourceJson));
    expect(sourceJson).not.toContain('rawRecognizedMilliseconds');
  });

  it('retains key-dependent reason serialization through the original record path', async () => {
    const reason = [{ allocationRevisionId: 'allocation', manualReason: 'approved' }];
    const serialize = jest.fn((key: string) => [
      { allocationRevisionId: 'allocation', manualReason: key },
    ]);
    Object.defineProperty(reason, 'toJSON', { value: serialize });
    const execute = jest.spyOn(tx, '$executeRaw').mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const insert = Reflect.get(service, 'insertBuckets') as (
      client: Prisma.TransactionClient,
      revision: ActivitySettlementTimeRevision,
      rows: readonly TimeSettlementBucket[],
    ) => Promise<void>;
    await insert.call(service, tx, { ...parent, bucketCount: 1, sourceCount: 0 }, [
      emptyWireBucket({ adjustmentReason: reason }),
    ]);
    const payload = JSON.parse(
      (execute.mock.calls[0][0] as Prisma.Sql).values.at(-1) as string,
    ) as { adjustmentReason: unknown }[];
    expect(payload[0].adjustmentReason).toEqual([
      { allocationRevisionId: 'allocation', manualReason: 'adjustmentReason' },
    ]);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(serialize).toHaveBeenCalledWith('adjustmentReason');
  });

  it('does not invoke reason accessors while deciding whether the compact wire path is safe', async () => {
    const readReason = jest.fn(() => 'approved');
    const reason = {
      allocationRevisionId: 'allocation',
      get manualReason() {
        return readReason();
      },
    };
    const execute = jest.spyOn(tx, '$executeRaw').mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const insert = Reflect.get(service, 'insertBuckets') as (
      client: Prisma.TransactionClient,
      revision: ActivitySettlementTimeRevision,
      rows: readonly TimeSettlementBucket[],
    ) => Promise<void>;
    await insert.call(service, tx, { ...parent, bucketCount: 1, sourceCount: 0 }, [
      emptyWireBucket({ adjustmentReason: [reason] }),
    ]);
    const payload = JSON.parse(
      (execute.mock.calls[0][0] as Prisma.Sql).values.at(-1) as string,
    ) as { adjustmentReason: unknown }[];
    expect(payload[0].adjustmentReason).toEqual([
      { allocationRevisionId: 'allocation', manualReason: 'approved' },
    ]);
    expect(readReason).toHaveBeenCalledTimes(1);
  });

  it.each(['array', 'reason'] as const)(
    'falls back before invoking a Proxy %s reflection trap that original JSON serialization does not use',
    async (target) => {
      const sentinel = new Error('reflection must not run');
      const reflect = jest.fn(() => {
        throw sentinel;
      });
      const record = { allocationRevisionId: 'allocation', manualReason: 'approved' };
      const reason =
        target === 'array'
          ? new Proxy([record], { getPrototypeOf: reflect })
          : [new Proxy(record, { getPrototypeOf: reflect })];
      const execute = jest
        .spyOn(tx, '$executeRaw')
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);
      const insert = Reflect.get(service, 'insertBuckets') as (
        client: Prisma.TransactionClient,
        revision: ActivitySettlementTimeRevision,
        rows: readonly TimeSettlementBucket[],
      ) => Promise<void>;
      await insert.call(service, tx, { ...parent, bucketCount: 1, sourceCount: 0 }, [
        emptyWireBucket({ adjustmentReason: reason }),
      ]);
      const payload = JSON.parse(
        (execute.mock.calls[0][0] as Prisma.Sql).values.at(-1) as string,
      ) as { adjustmentReason: unknown }[];
      expect(payload[0].adjustmentReason).toEqual([record]);
      expect(reflect).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(2);
    },
  );

  it('still rejects inconsistent inserted bucket/source counts after both original statements', async () => {
    const execute = jest.spyOn(tx, '$executeRaw').mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    const insert = Reflect.get(service, 'insertBuckets') as (
      client: Prisma.TransactionClient,
      revision: ActivitySettlementTimeRevision,
      rows: readonly TimeSettlementBucket[],
    ) => Promise<void>;
    await expect(
      insert.call(service, tx, { ...parent, bucketCount: 1, sourceCount: 0 }, []),
    ).rejects.toThrow(new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_INVALID));
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('still completes serialization before any write when a source cannot be encoded', async () => {
    const source = {
      allocationRevisionId: 'allocation',
      sourceSegmentId: 'segment',
      sourceSegmentRevision: 1,
      rawCalculatedMilliseconds: 1n,
      rawRecognizedMilliseconds: 1n,
      unsupported: 1n,
    };
    const bucket: TimeSettlementBucket = {
      participationIdentityId: 'identity',
      categoryCode: 'training',
      calculatedSeconds: 0,
      recognizedSeconds: 0,
      rawCalculatedMilliseconds: 1n,
      rawRecognizedMilliseconds: 1n,
      timePolicyVersionId: null,
      definitionHash: null,
      evaluatorVersion: null,
      quantumSeconds: null,
      adjustmentReason: null,
      emptyReasonCode: null,
      sources: [source],
    };
    const execute = jest.spyOn(tx, '$executeRaw').mockResolvedValue(1);
    const insert = Reflect.get(service, 'insertBuckets') as (
      client: Prisma.TransactionClient,
      revision: ActivitySettlementTimeRevision,
      rows: readonly TimeSettlementBucket[],
    ) => Promise<void>;
    await expect(
      insert.call(service, tx, { ...parent, bucketCount: 1, sourceCount: 1 }, [bucket]),
    ).rejects.toThrow(TypeError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('fresh native prepare writes facts, current receipt and audit before its two-name barrier and final authorization', async () => {
    const f = freshPrepare();
    await expect(service.prepare(activityId, prepare, actor, meta)).resolves.toEqual(f.response);
    expect(f.executeRaw).toHaveBeenCalledTimes(3);
    expect(statement(f.executeRaw.mock.calls[2][0])).toBe(nativeBarrier);
    const barrierOrder = f.executeRaw.mock.invocationCallOrder[2];
    expect(f.createRevision.mock.invocationCallOrder[0]).toBeLessThan(barrierOrder);
    expect(contributions.prepareTimeInTx.mock.invocationCallOrder[0]).toBeLessThan(barrierOrder);
    expect(contributions.prepareTimeInTx).toHaveBeenCalledWith(
      tx,
      f.revision,
      'policy_v1',
      expect.objectContaining({ operationKey: prepare.operationKey }),
      expect.any(Function),
    );
    expect(f.createReceipt.mock.invocationCallOrder[0]).toBeLessThan(barrierOrder);
    expect(audit.log).toHaveBeenCalledWith(
      tx,
      actor,
      meta,
      TIME_SETTLEMENT_PREPARE_OPERATION,
      f.response,
      false,
      f.proof,
    );
    expect(audit.log.mock.invocationCallOrder[0]).toBeLessThan(barrierOrder);
    expect(access.authorize.mock.invocationCallOrder.at(-1)).toBeGreaterThan(barrierOrder);
    expect(access.authorize.mock.calls.every((args) => args[0] === tx)).toBe(true);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 2000,
      timeout: 60000,
    });
  });

  it('legacy fresh prepare preserves its existing writes without a native barrier', async () => {
    const f = freshPrepare('legacy');
    await expect(service.prepare(activityId, prepare, actor, meta)).resolves.toEqual(f.response);
    expect(f.executeRaw).toHaveBeenCalledTimes(2);
    expect(
      f.executeRaw.mock.calls.some((args) => statement(args[0]).startsWith('SET CONSTRAINTS')),
    ).toBe(false);
    expect(contributions.assertNativeWriteAllowed).not.toHaveBeenCalled();
  });

  it('replay returns early without a barrier, contribution recalculation or new receipt', async () => {
    const f = freshPrepare();
    const saved = receipt();
    await expect(service.prepare(activityId, prepare, actor, meta)).resolves.toEqual(
      saved.resultJson,
    );
    expect(f.executeRaw).not.toHaveBeenCalled();
    expect(f.createReceipt).not.toHaveBeenCalled();
    expect(contributions.prepareTimeInTx).not.toHaveBeenCalled();
  });

  it('equal contribution proof reuse still writes this request receipt and audit before the barrier', async () => {
    const f = freshPrepare();
    const reused = { id: 'existing-equivalent-contribution-root' };
    contributions.prepareTimeInTx.mockResolvedValue(reused);
    await expect(service.prepare(activityId, prepare, actor, meta)).resolves.toEqual(f.response);
    expect(f.createReceipt).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      tx,
      actor,
      meta,
      TIME_SETTLEMENT_PREPARE_OPERATION,
      f.response,
      false,
      reused,
    );
    expect(statement(f.executeRaw.mock.calls[2][0])).toBe(nativeBarrier);
  });

  it('propagates the original barrier failure without authorizing or returning success afterwards', async () => {
    const f = freshPrepare();
    const failure = new Error('fixed native barrier rejection');
    f.executeRaw.mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockRejectedValueOnce(failure);
    await expect(service.prepare(activityId, prepare, actor, meta)).rejects.toBe(failure);
    expect(access.authorize.mock.invocationCallOrder.at(-1)).toBeLessThan(
      f.executeRaw.mock.invocationCallOrder[2],
    );
    expect(f.executeRaw).toHaveBeenCalledTimes(3);
  });

  it('retains the final qualification check after the native barrier', async () => {
    const f = freshPrepare();
    let crossed = false;
    f.executeRaw.mockImplementation((query) => {
      if (statement(query) === nativeBarrier) crossed = true;
      return Promise.resolve(0) as Prisma.PrismaPromise<number>;
    });
    access.authorize.mockImplementation(() => {
      if (crossed) return Promise.reject(new BizException(BizCode.FORBIDDEN));
      return Promise.resolve({ actor });
    });
    await expect(service.prepare(activityId, prepare, actor, meta)).rejects.toThrow(
      new BizException(BizCode.FORBIDDEN),
    );
    expect(crossed).toBe(true);
    expect(access.authorize.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      f.executeRaw.mock.invocationCallOrder[2],
    );
    expect(f.createReceipt).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it('does not resolve prepare until the transaction owner has completed its actual commit await', async () => {
    const f = freshPrepare();
    let callbackFinished = () => {};
    let finishCommit = () => {};
    const callbackReady = new Promise<void>((resolve) => {
      callbackFinished = resolve;
    });
    const commitReady = new Promise<void>((resolve) => {
      finishCommit = resolve;
    });
    transaction.mockImplementation(async (work) => {
      const response = await work(tx);
      callbackFinished();
      await commitReady;
      return response;
    });
    const pending = service.prepare(activityId, prepare, actor, meta);
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });
    await callbackReady;
    try {
      expect(resolved).toBe(false);
      expect(statement(f.executeRaw.mock.calls[2][0])).toBe(nativeBarrier);
    } finally {
      finishCommit();
    }
    await expect(pending).resolves.toEqual(f.response);
  });

  it('does not convert an error from transaction commit into a saved receipt success', async () => {
    const f = freshPrepare();
    const failure = new Error('fixed commit acknowledgement failure');
    transaction.mockImplementation(async (work) => {
      await work(tx);
      throw failure;
    });
    await expect(service.prepare(activityId, prepare, actor, meta)).rejects.toBe(failure);
    expect(f.createReceipt).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(f.executeRaw).toHaveBeenCalledTimes(3);
  });

  it('rejects a new active operation before source evaluation, facts, receipt or audit', async () => {
    const f = freshPrepare();
    contributions.usesLaunchAdmission = true;
    contributions.assertNewNativeActivityInTx.mockRejectedValue(
      new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT),
    );
    await expect(service.prepare(activityId, prepare, actor, meta)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT,
    });
    expect(queries.readSourceSetInTx).not.toHaveBeenCalled();
    expect(queries.evaluateInTx).not.toHaveBeenCalled();
    expect(f.createRevision).not.toHaveBeenCalled();
    expect(f.createReceipt).not.toHaveBeenCalled();
    expect(f.executeRaw).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('counts all locked identities even when the included population and sources are empty', async () => {
    const f = freshPrepare();
    contributions.usesLaunchAdmission = true;
    const raw = jest.spyOn(tx, '$queryRaw');
    for (let index = 0; index < 5; index++) raw.mockResolvedValueOnce([{ id: 'run' }]);
    raw.mockResolvedValueOnce(
      Array.from({ length: 501 }, (_, index) => ({ id: `excluded-${index}` })),
    );
    await expect(service.prepare(activityId, prepare, actor, meta)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT,
    });
    expect(queries.evaluateInTx).not.toHaveBeenCalled();
    expect(f.createRevision).not.toHaveBeenCalled();
    expect(f.createReceipt).not.toHaveBeenCalled();
    expect(statement(raw.mock.calls[5][0])).toContain('FROM "ActivityParticipationIdentity"');
  });

  it('passes active admission to the full source evaluator while preserving the two complete guards', async () => {
    const f = freshPrepare();
    contributions.usesLaunchAdmission = true;
    await expect(service.prepare(activityId, prepare, actor, meta)).resolves.toEqual(f.response);
    expect(contributions.assertNewNativeActivityInTx).toHaveBeenCalledWith(tx, activityId, 0);
    expect(queries.evaluateInTx).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ population: [], segments: [], latest: [] }),
      true,
    );
    expect(statement(f.executeRaw.mock.calls[2][0])).toBe(nativeBarrier);
  });

  it('replays an existing authorized receipt before new capacity admission', async () => {
    contributions.usesLaunchAdmission = true;
    contributions.assertNewNativeActivityInTx.mockRejectedValue(
      new Error('must not re-admit replay'),
    );
    const saved = receipt();
    await expect(service.prepare(activityId, prepare, actor, meta)).resolves.toEqual(
      saved.resultJson,
    );
    expect(contributions.assertNewNativeActivityInTx).not.toHaveBeenCalled();
    expect(queries.evaluateInTx).not.toHaveBeenCalled();
    expect(access.authorize).toHaveBeenCalledTimes(7);
  });
});
