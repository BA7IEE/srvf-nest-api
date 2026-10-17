import { Role, UserStatus } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import appConfig from '../../config/app.config';
import { ActivityContributionSettlementService } from './activity-contribution-settlement.service';
import { ActivityContributionSettlementQueryService } from './activity-contribution-settlement-query.service';
import { SettlementDraftDispatchService } from './settlement-draft-dispatch.service';
import { SettlementDraftService } from './settlement-draft.service';

function partial(value: Record<string, unknown>): unknown {
  return expect.objectContaining(value);
}

/**
 * 活动 v1.1 cutover gate 的测试替身。**显式传 true** = 本 spec 断言的是
 * 「闸开」下的行为;闸关时新结算真相链改为拒绝,由专属用例覆盖。
 */
function gateStub(enabled: boolean): ActivityWorkflowGate {
  return new ActivityWorkflowGate({ activityV11Workflow: { enabled } } as never);
}

describe('SettlementDraftDispatchService', () => {
  const actor = {
    id: 'actor-1',
    username: 'actor-1',
    role: Role.SUPER_ADMIN,
    status: UserStatus.ACTIVE,
    memberId: null,
  };
  const auditMeta = { requestId: 'draft-dispatch-unit', ip: null, ua: null };

  function harness(populationSize: number, native = false) {
    const createdJob = {
      id: 'job-1',
      statusCode: populationSize > 500 ? 'pending' : 'processing',
      total: 1,
    };
    const createJob = jest
      .fn<Promise<typeof createdJob>, [{ data: { jobTypeCode: string } }]>()
      .mockResolvedValue(createdJob);
    const updateJob = jest
      .fn<
        Promise<void>,
        [{ where: { id: string }; data: { statusCode: string; succeeded?: number } }]
      >()
      .mockResolvedValue(undefined);
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ workflowRevision: 0 }]),
      activityBatchJob: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: createJob,
        update: updateJob,
      },
      activityBatchJobItem: {
        create: jest.fn().mockResolvedValue(undefined),
        findFirst: jest.fn().mockResolvedValue({ resultReference: 'version-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      evidenceSeal: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'seal-1',
          evidenceRevision: 0,
          populationRevision: 0,
          workflowRevision: 0,
        }),
        count: jest.fn().mockResolvedValue(1),
      },
      activityEvidenceState: { findUnique: jest.fn().mockResolvedValue(null) },
      attendanceSettlementRun: { findUnique: jest.fn().mockResolvedValue(null) },
      attendanceSettlementVersion: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue({
          id: 'version-1',
          settlementRunId: 'run-1',
          personCount: 1,
          sessionParticipationCount: 1,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      activityParticipationIdentity: {
        findMany: jest.fn().mockResolvedValue(
          Array.from({ length: populationSize }, (_unused, index) => ({
            memberId: `member-${index}`,
          })),
        ),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => await callback(tx)),
    };
    const drafts = {
      generate: jest.fn().mockResolvedValue({
        activityId: 'activity-1',
        settlementRunId: 'run-1',
        settlementVersionId: 'version-1',
        personCount: 1,
        sessionParticipationCount: 1,
      }),
    };
    const contributions = {
      usesLaunchAdmission: native,
      draftRegime: jest.fn((previous: 'legacy' | 'policy_v1' | null) => previous ?? 'policy_v1'),
      assertNewNativeActivityInTx: jest
        .fn<Promise<void>, [unknown, string, number]>()
        .mockResolvedValue(undefined),
    };
    return {
      service: new SettlementDraftDispatchService(
        prisma as never,
        drafts as never,
        gateStub(true),
        contributions as never,
      ),
      contributions,
      prisma,
      tx,
      drafts,
    };
  }

  it('refuses to assemble the dispatcher when its admission dependency is absent', async () => {
    await expect(
      Test.createTestingModule({
        providers: [
          SettlementDraftDispatchService,
          { provide: PrismaService, useValue: {} },
          { provide: SettlementDraftService, useValue: {} },
          { provide: ActivityWorkflowGate, useValue: gateStub(true) },
        ],
      }).compile(),
    ).rejects.toThrow('ActivityContributionSettlementService');
  });

  it('injects the real active admission service and rejects before reserving a receipt', async () => {
    const { prisma, tx, drafts } = harness(1);
    const error = new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT);
    const frozenPolicy = jest.fn().mockRejectedValue(error);
    const module = await Test.createTestingModule({
      providers: [
        SettlementDraftDispatchService,
        ActivityContributionSettlementService,
        { provide: PrismaService, useValue: prisma },
        { provide: SettlementDraftService, useValue: drafts },
        { provide: ActivityWorkflowGate, useValue: gateStub(true) },
        { provide: appConfig.KEY, useValue: { contributionSettlementMode: 'active', env: 'test' } },
        {
          provide: ActivityContributionSettlementQueryService,
          useValue: {
            assertLaunchActivityInTx: jest.fn().mockResolvedValue(undefined),
            assertLaunchFrozenPolicyInTx: frozenPolicy,
          },
        },
      ],
    }).compile();
    try {
      expect(module.get(ActivityContributionSettlementService).usesLaunchAdmission).toBe(true);
      await expect(
        module
          .get(SettlementDraftDispatchService)
          .generate(
            { activityId: 'activity-1', operationKey: 'di-native', requestHash: 'hash-1' },
            actor,
            auditMeta,
          ),
      ).rejects.toBe(error);
      expect(frozenPolicy).toHaveBeenCalledWith(tx, 'activity-1', 0);
      expect(tx.activityBatchJob.create).not.toHaveBeenCalled();
      expect(tx.activityBatchJobItem.create).not.toHaveBeenCalled();
    } finally {
      await module.close();
    }
  });

  it.each(['policy shape', 'policy bytes'])(
    'rejects a new native %s before any operation job/item persists',
    async () => {
      const { service, tx, drafts, contributions } = harness(1, true);
      const error = new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT);
      contributions.assertNewNativeActivityInTx.mockRejectedValueOnce(error);
      await expect(
        service.generate(
          { activityId: 'activity-1', operationKey: 'native-invalid', requestHash: 'hash-1' },
          actor,
          auditMeta,
        ),
      ).rejects.toBe(error);
      expect(contributions.assertNewNativeActivityInTx).toHaveBeenCalledWith(tx, 'activity-1', 0);
      expect(tx.activityBatchJob.create).not.toHaveBeenCalled();
      expect(tx.activityBatchJobItem.create).not.toHaveBeenCalled();
      expect(tx.activityBatchJob.update).not.toHaveBeenCalled();
      expect(drafts.generate).not.toHaveBeenCalled();
    },
  );

  it('admits a valid native source before reserving its operation receipt', async () => {
    const { service, tx, drafts, contributions } = harness(1, true);
    await service.generate(
      { activityId: 'activity-1', operationKey: 'native-valid', requestHash: 'hash-1' },
      actor,
      auditMeta,
    );
    expect(contributions.draftRegime).toHaveBeenCalledWith(null);
    expect(contributions.assertNewNativeActivityInTx).toHaveBeenCalledWith(tx, 'activity-1', 0);
    expect(contributions.assertNewNativeActivityInTx.mock.invocationCallOrder[0]).toBeLessThan(
      tx.activityBatchJob.create.mock.invocationCallOrder[0],
    );
    expect(drafts.generate).toHaveBeenCalledTimes(1);
  });

  it('preserves an inherited legacy regime while active launch admission is configured', async () => {
    const { service, tx, drafts, contributions } = harness(1, true);
    tx.attendanceSettlementRun.findUnique.mockResolvedValueOnce({
      id: 'run-1',
      statusCode: 'drafting',
    });
    tx.attendanceSettlementVersion.findFirst.mockResolvedValueOnce({
      contributionRegimeCode: 'legacy',
    });
    await service.generate(
      { activityId: 'activity-1', operationKey: 'legacy-existing', requestHash: 'hash-1' },
      actor,
      auditMeta,
    );
    expect(contributions.draftRegime).toHaveBeenCalledWith('legacy');
    expect(contributions.assertNewNativeActivityInTx).not.toHaveBeenCalled();
    expect(drafts.generate).toHaveBeenCalledTimes(1);
  });

  it('treats an existing version without a regime as frozen legacy', async () => {
    const { service, tx, contributions } = harness(1, true);
    tx.attendanceSettlementRun.findUnique.mockResolvedValueOnce({
      id: 'run-1',
      statusCode: 'drafting',
    });
    tx.attendanceSettlementVersion.findFirst.mockResolvedValueOnce({});
    await service.generate(
      { activityId: 'activity-1', operationKey: 'old-version', requestHash: 'hash-1' },
      actor,
      auditMeta,
    );
    expect(contributions.draftRegime).toHaveBeenCalledWith('legacy');
    expect(contributions.assertNewNativeActivityInTx).not.toHaveBeenCalled();
  });

  it('inherits the latest history only when no draft exists', async () => {
    const { service, tx, contributions } = harness(1, true);
    tx.attendanceSettlementRun.findUnique.mockResolvedValueOnce({
      id: 'run-1',
      statusCode: 'drafting',
    });
    tx.attendanceSettlementVersion.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ contributionRegimeCode: 'policy_v1' });
    await service.generate(
      { activityId: 'activity-1', operationKey: 'native-history', requestHash: 'hash-1' },
      actor,
      auditMeta,
    );
    expect(tx.attendanceSettlementVersion.findFirst).toHaveBeenNthCalledWith(2, {
      where: { settlementRunId: 'run-1' },
      orderBy: { version: 'desc' },
      select: { contributionRegimeCode: true },
    });
    expect(contributions.assertNewNativeActivityInTx).toHaveBeenCalledWith(tx, 'activity-1', 0);
  });

  it('leaves fixture and off modes on their existing generation path', async () => {
    const { service, tx, contributions } = harness(1, true);
    contributions.usesLaunchAdmission = false;
    await service.generate(
      { activityId: 'activity-1', operationKey: 'not-active', requestHash: 'hash-1' },
      actor,
      auditMeta,
    );
    expect(contributions.draftRegime).not.toHaveBeenCalled();
    expect(contributions.assertNewNativeActivityInTx).not.toHaveBeenCalled();
    expect(tx.activityBatchJob.create).toHaveBeenCalledTimes(1);
  });

  it('uses the existing draft regime before later history and rejects without a receipt', async () => {
    const { service, tx, contributions } = harness(1, true);
    tx.attendanceSettlementRun.findUnique.mockResolvedValueOnce({
      id: 'run-1',
      statusCode: 'drafting',
    });
    tx.attendanceSettlementVersion.findFirst
      .mockResolvedValueOnce({ contributionRegimeCode: 'policy_v1' })
      .mockResolvedValueOnce({ contributionRegimeCode: 'legacy' });
    const error = new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT);
    contributions.assertNewNativeActivityInTx.mockRejectedValueOnce(error);
    await expect(
      service.generate(
        { activityId: 'activity-1', operationKey: 'draft-native', requestHash: 'hash-1' },
        actor,
        auditMeta,
      ),
    ).rejects.toBe(error);
    expect(contributions.draftRegime).toHaveBeenCalledWith('policy_v1');
    expect(tx.attendanceSettlementVersion.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.activityBatchJob.create).not.toHaveBeenCalled();
  });

  it('replays an existing receipt before new native admission even if the new gate would reject', async () => {
    const { service, tx, contributions } = harness(1, true);
    contributions.assertNewNativeActivityInTx.mockRejectedValueOnce(
      new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT),
    );
    tx.activityBatchJob.findUnique.mockResolvedValueOnce({
      id: 'job-1',
      activityId: 'activity-1',
      jobTypeCode: 'bulk_proxy',
      statusCode: 'succeeded',
      requestHash: 'hash-1',
      total: 1,
      payload: { action: 'settlement_draft_generate', executionMode: 'sync' },
    });
    const replayed = await service.generate(
      { activityId: 'activity-1', operationKey: 'existing-receipt', requestHash: 'hash-1' },
      actor,
      auditMeta,
    );
    expect(replayed.replayed).toBe(true);
    expect(contributions.assertNewNativeActivityInTx).not.toHaveBeenCalled();
    expect(tx.activityBatchJob.create).not.toHaveBeenCalled();
  });

  it('>500 使用具名阈值创建 bulk job 并返回 job,不调用同步生成器', async () => {
    const { service, tx, drafts } = harness(501);

    await expect(
      service.generate(
        { activityId: 'activity-1', operationKey: 'generate-1', requestHash: 'hash-1' },
        actor,
        auditMeta,
      ),
    ).resolves.toEqual({
      outcome: 'job',
      activityId: 'activity-1',
      jobId: 'job-1',
      statusCode: 'pending',
      total: 1,
      replayed: false,
    });
    expect(tx.activityBatchJob.create.mock.calls[0]?.[0].data.jobTypeCode).toBe('bulk_proxy');
    expect(drafts.generate).not.toHaveBeenCalled();
  });

  it('async payload v2 binds the server seal and original actor without token or profile data', async () => {
    const { service, tx } = harness(501);
    await service.generate(
      { activityId: 'activity-1', operationKey: 'v2', requestHash: 'hash-1' },
      { ...actor, memberId: 'member-1' },
      auditMeta,
    );
    expect(tx.activityBatchJob.create).toHaveBeenCalledWith({
      data: partial({
        payloadVersion: 2,
        payload: {
          action: 'settlement_draft_generate',
          executionMode: 'async',
          activityId: 'activity-1',
          populationSize: 501,
          actorUserId: 'actor-1',
          actorMemberId: 'member-1',
          evidenceSealId: 'seal-1',
          evidenceRevision: 0,
          populationRevision: 0,
          workflowRevision: 0,
        },
      }),
      select: { id: true, statusCode: true, total: true },
    });
  });

  it('500 remains synchronous and retains the original payload version', async () => {
    const { service, tx, drafts } = harness(500);
    await service.generate(
      { activityId: 'activity-1', operationKey: 'sync-500', requestHash: 'hash-1' },
      actor,
      auditMeta,
    );
    expect(drafts.generate).toHaveBeenCalledTimes(1);
    expect(tx.activityBatchJob.create).toHaveBeenCalledWith({
      data: partial({
        payloadVersion: 1,
        payload: {
          action: 'settlement_draft_generate',
          executionMode: 'sync',
          activityId: 'activity-1',
          populationSize: 500,
        },
      }),
      select: { id: true, statusCode: true, total: true },
    });
  });

  it('同 key 不同 requestHash 用具名 BizCode 拒绝', async () => {
    const { service, tx } = harness(501);
    tx.activityBatchJob.findUnique.mockResolvedValueOnce({
      id: 'existing-job',
      activityId: 'activity-1',
      jobTypeCode: 'bulk_proxy',
      statusCode: 'pending',
      requestHash: 'hash-original',
      total: 1,
      payload: { action: 'settlement_draft_generate' },
    });

    const error = await service
      .generate(
        { activityId: 'activity-1', operationKey: 'generate-1', requestHash: 'hash-changed' },
        actor,
        auditMeta,
      )
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(BizException);
    expect((error as BizException).biz).toBe(BizCode.SETTLEMENT_DRAFT_OPERATION_KEY_CONFLICT);
  });

  it('并发 operationKey 唯一冲突后重读 winner,仍以具名 BizCode 拒绝不同 payload', async () => {
    const { service, prisma, tx } = harness(501);
    prisma.$transaction.mockRejectedValueOnce({ code: 'P2002' });
    tx.activityBatchJob.findUnique.mockResolvedValueOnce({
      id: 'winner-job',
      activityId: 'activity-other',
      jobTypeCode: 'bulk_proxy',
      statusCode: 'pending',
      requestHash: 'hash-other',
      total: 1,
      payload: { action: 'settlement_draft_generate', executionMode: 'async' },
    });

    const error = await service
      .generate(
        { activityId: 'activity-1', operationKey: 'generate-race', requestHash: 'hash-1' },
        actor,
        auditMeta,
      )
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(BizException);
    expect((error as BizException).biz).toBe(BizCode.SETTLEMENT_DRAFT_OPERATION_KEY_CONFLICT);
  });

  it('>500 同 key 同 payload 重放返回同一 job,不建第二条', async () => {
    const { service, tx } = harness(501);
    tx.activityBatchJob.findUnique.mockResolvedValueOnce({
      id: 'existing-job',
      activityId: 'activity-1',
      jobTypeCode: 'bulk_proxy',
      statusCode: 'pending',
      requestHash: 'hash-1',
      total: 1,
      payload: { action: 'settlement_draft_generate', executionMode: 'async' },
    });

    await expect(
      service.generate(
        { activityId: 'activity-1', operationKey: 'generate-1', requestHash: 'hash-1' },
        actor,
        auditMeta,
      ),
    ).resolves.toMatchObject({ outcome: 'job', jobId: 'existing-job', replayed: true });
    expect(tx.activityBatchJob.create).not.toHaveBeenCalled();
  });

  it('同步成功 receipt 重放直接返回原 version,不再调用草稿生成器', async () => {
    const { service, tx, drafts } = harness(1);
    tx.activityBatchJob.findUnique.mockResolvedValueOnce({
      id: 'existing-job',
      activityId: 'activity-1',
      jobTypeCode: 'bulk_proxy',
      statusCode: 'succeeded',
      requestHash: 'hash-sync',
      total: 1,
      payload: { action: 'settlement_draft_generate', executionMode: 'sync' },
    });

    await expect(
      service.generate(
        { activityId: 'activity-1', operationKey: 'generate-sync', requestHash: 'hash-sync' },
        actor,
        auditMeta,
      ),
    ).resolves.toMatchObject({
      outcome: 'draft',
      settlementVersionId: 'version-1',
      replayed: true,
    });
    expect(drafts.generate).not.toHaveBeenCalled();
  });

  it('<=500 同步生成,把 operationKey 落到版本并把幂等 receipt 收成 succeeded', async () => {
    const { service, tx, drafts } = harness(500);

    await expect(
      service.generate(
        { activityId: 'activity-1', operationKey: 'generate-sync', requestHash: 'hash-sync' },
        actor,
        auditMeta,
      ),
    ).resolves.toMatchObject({
      outcome: 'draft',
      settlementVersionId: 'version-1',
      replayed: false,
    });
    expect(drafts.generate).toHaveBeenCalledWith('activity-1', actor, auditMeta);
    expect(tx.attendanceSettlementVersion.updateMany).toHaveBeenCalledWith({
      where: { id: 'version-1', operationKey: null },
      data: { operationKey: 'generate-sync', requestHash: 'hash-sync' },
    });
    expect(tx.activityBatchJob.update.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'job-1' },
      data: { statusCode: 'succeeded', succeeded: 1 },
    });
  });
});
