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
  const transaction = jest.fn(
    async (work: (client: Prisma.TransactionClient) => Promise<unknown>) => work(tx),
  );

  beforeEach(async () => {
    jest.resetAllMocks();
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
        timeout: method === 'prepare' ? 30000 : SETTLEMENT_SUBMIT_TX_TIMEOUT_MS,
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
});
