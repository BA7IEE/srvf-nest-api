import { randomUUID } from 'node:crypto';

import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MemberStatus, Role, UserStatus } from '@prisma/client';
import request from 'supertest';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import {
  ACTIVITY_BATCH_RETRY_BACKOFF_MS,
  ActivityBatchWorker,
} from '../../src/modules/activities/activity-batch.worker';
import { ActivityBatchWorkerModule } from '../../src/modules/activities/activity-batch-worker.module';
import { LedgerReadyBatchCommitter } from '../../src/modules/activities/ledger-ready-batch-committer.service';
import { LedgerQueryService } from '../../src/modules/activities/ledger-query.service';
import { SettlementDraftDispatchService } from '../../src/modules/activities/settlement-draft-dispatch.service';
import type { SettlementReviewExpectation } from '../../src/modules/activities/settlement-review-comparison';
import { StorageConsistencyWorkerModule } from '../../src/modules/attachments/storage-consistency-worker.module';
import { NotificationOutboxWorkerModule } from '../../src/modules/notifications/notification-outbox-worker.module';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

const SESSION_START = new Date('2020-03-01T01:00:00.000Z');
const SESSION_END = new Date('2020-03-01T05:00:00.000Z');
const SEAL_AT = new Date('2020-03-01T09:00:00.000Z');

interface InitialFixture {
  tag: string;
  activityId: string;
  sessionId: string;
  sealId: string;
  ownerMemberId: string;
  memberIds: string[];
  identityIds: string[];
}

interface ReviewedFixture extends InitialFixture {
  settlementVersionId: string;
  batchId: string;
  expectation: SettlementReviewExpectation;
}

interface HttpActor extends CurrentUserPayload {
  authHeader: string;
}

describe('第 2 批第 ⑧a 刀 —— generate dispatch → worker auto commit → closure', () => {
  let app: INestApplication;
  let notificationContext: INestApplicationContext;
  let storageContext: INestApplicationContext;
  let prisma: PrismaService;
  let drafts: SettlementDraftDispatchService;
  let notificationActivityWorker: ActivityBatchWorker;
  let storageActivityWorker: ActivityBatchWorker;
  let notificationCommitter: LedgerReadyBatchCommitter;
  let ledgerQuery: LedgerQueryService;

  let submitter: HttpActor;
  let firstReviewer: HttpActor;
  let finalReviewer: HttpActor;
  let organizationId: string;
  let sequence = 0;

  const auditMeta = { requestId: 'activity-batch2-8a-e2e', ip: null, ua: null };

  beforeAll(async () => {
    // 第 7 批第 ③ 刀 —— 活动 v1.1 单一 cutover gate(合同 §16.2)。本 spec 驱动的是
    // **结算真相链**(打卡 / 封场 / 结算 / 账本 / 关账 / 更正),那条链按定义只在闸开时存在;
    // 闸关(默认 = 今天的行为)时这些写入口一律回 20153。故此处显式置真,
    // **断言一字未改** —— 改的只是这个 spec 声明自己跑在哪一侧闸。
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    drafts = app.get(SettlementDraftDispatchService);
    ledgerQuery = app.get(LedgerQueryService);

    submitter = await makeActor('batch2-8a-submitter');
    firstReviewer = await makeActor('batch2-8a-first');
    finalReviewer = await makeActor('batch2-8a-final');
    const organization = await prisma.organization.create({
      data: { name: '第 ⑧a 刀测试组织', nodeTypeCode: 'activity-batch2-8a-team' },
      select: { id: true },
    });
    organizationId = organization.id;

    // 与两个真实进程入口相同的 application context。后面的成功与重试分别从这两个
    // context 取 worker 并真实 claim PostgreSQL job，不只做静态“已注册”断言。
    notificationContext = await NestFactory.createApplicationContext(
      NotificationOutboxWorkerModule,
      { logger: false },
    );
    storageContext = await NestFactory.createApplicationContext(StorageConsistencyWorkerModule, {
      logger: false,
    });
    notificationActivityWorker = notificationContext
      .select(ActivityBatchWorkerModule)
      .get(ActivityBatchWorker, { strict: true });
    storageActivityWorker = storageContext
      .select(ActivityBatchWorkerModule)
      .get(ActivityBatchWorker, { strict: true });
    notificationCommitter = notificationContext
      .select(ActivityBatchWorkerModule)
      .get(LedgerReadyBatchCommitter, { strict: true });
    const databaseNames = await Promise.all(
      [prisma, notificationContext.get(PrismaService), storageContext.get(PrismaService)].map(
        async (client) =>
          await client.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`,
      ),
    );
    expect(databaseNames.map((rows) => rows[0]?.name)).toEqual([
      databaseNames[0][0]?.name,
      databaseNames[0][0]?.name,
      databaseNames[0][0]?.name,
    ]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    await storageContext.close();
    await notificationContext.close();
    await app.close();
  });

  async function makeActor(username: string): Promise<HttpActor> {
    const user = await createTestUser(app, { username, role: Role.SUPER_ADMIN });
    const member = await prisma.member.create({
      data: {
        memberNo: `${username}-member`,
        ...memberIdentityData(`${username} 队员`),
        gradeCode: 'level-2',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      status: UserStatus.ACTIVE,
      memberId: member.id,
      authHeader: (await loginAs(app, username)).authHeader,
    };
  }

  async function createInitialFixture(
    populationSize: number,
    options: { withPunches?: boolean; withCapacity?: boolean } = {},
  ): Promise<InitialFixture> {
    sequence += 1;
    const tag = `batch2-8a-${sequence}`;
    const activity = await prisma.activity.create({
      data: {
        title: `第 ⑧a 刀活动 ${sequence}`,
        activityTypeCode: `${tag}-type`,
        organizationId,
        startAt: SESSION_START,
        endAt: SESSION_END,
        location: '深圳',
        statusCode: 'published',
      },
      select: { id: true },
    });
    const session = await prisma.activitySession.create({
      data: {
        activityId: activity.id,
        code: `${tag}-session`,
        name: `${tag} 场次`,
        startAt: SESSION_START,
        endAt: SESSION_END,
        locationText: '深圳',
        checkInOpenAt: new Date(SESSION_START.getTime() - 3600_000),
        checkInCloseAt: new Date(SESSION_START.getTime() + 3600_000),
        checkOutOpenAt: new Date(SESSION_START.getTime() + 2 * 3600_000),
        checkOutCloseAt: new Date(SESSION_END.getTime() + 3600_000),
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });

    const memberIds = Array.from({ length: populationSize }, () => randomUUID());
    const registrationIds = Array.from({ length: populationSize }, () => randomUUID());
    const identityIds = Array.from({ length: populationSize }, () => randomUUID());
    await prisma.member.createMany({
      data: memberIds.map((id, index) => ({
        id,
        memberNo: `${tag}-m${index}`,
        ...memberIdentityData(`${tag} 队员 ${index}`),
        gradeCode: 'level-2',
      })),
    });
    await prisma.activityRegistration.createMany({
      data: registrationIds.map((id, index) => ({
        id,
        activityId: activity.id,
        memberId: memberIds[index],
        statusCode: 'pass',
      })),
    });
    await prisma.activityParticipationIdentity.createMany({
      data: identityIds.map((id, index) => ({
        id,
        activityId: activity.id,
        sessionId: session.id,
        registrationId: registrationIds[index],
        memberId: memberIds[index],
        currentStatusCode: 'pass',
        populationIncluded: true,
      })),
    });

    const owner = await prisma.member.create({
      data: {
        memberNo: `${tag}-owner`,
        ...memberIdentityData(`${tag} 负责人`),
        gradeCode: 'level-2',
      },
      select: { id: true },
    });
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: activity.id,
        memberId: owner.id,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: submitter.id,
        source: 'publish',
      },
    });
    const seal = await prisma.evidenceSeal.create({
      data: {
        activityId: activity.id,
        sealRevision: 1,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        allWindowsClosedAt: SEAL_AT,
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: populationSize,
        populationCountBySession: { [session.id]: populationSize },
        contentHash: `${tag}-seal-hash`,
        statusCode: 'active',
        sealedByUserId: submitter.id,
        sealedAt: SEAL_AT,
      },
      select: { id: true },
    });

    if (options.withPunches === true) {
      await prisma.contributionRule.create({
        data: {
          activityTypeCode: `${tag}-type`,
          attendanceRoleCode: 'member',
          pointsBelow: 1.5,
          status: 'ACTIVE',
        },
      });
      for (let index = 0; index < populationSize; index += 1) {
        for (const [eventIndex, eventTypeCode] of ['check_in', 'check_out'].entries()) {
          await prisma.attendancePunchEvent.create({
            data: {
              activityId: activity.id,
              sessionId: session.id,
              participationIdentityId: identityIds[index],
              memberId: memberIds[index],
              eventTypeCode,
              sourceCode: 'staff_scan',
              occurredAt: new Date(SESSION_START.getTime() + eventIndex * 4 * 3600_000),
              receivedAt: new Date(SESSION_START.getTime() + eventIndex * 4 * 3600_000),
              operatorUserId: submitter.id,
              eventKey: `${tag}-${index}-${eventTypeCode}`,
              requestHash: `${tag}-${index}-${eventTypeCode}-hash`,
              evidenceRevision: 0,
            },
          });
        }
      }
    }

    if (options.withCapacity === true) {
      const bucket = await prisma.activityCapacityBucket.create({
        data: {
          activityId: activity.id,
          scopeTypeCode: 'session_participation',
          scopeId: `${session.id}:${tag}`,
          capacity: Math.max(populationSize, 1),
          occupied: populationSize,
        },
        select: { id: true },
      });
      await prisma.capacityReservation.createMany({
        data: identityIds.map((identityId) => ({
          identityId,
          bucketId: bucket.id,
          reservationType: 'session_participation',
          status: 'active',
        })),
      });
    }

    return {
      tag,
      activityId: activity.id,
      sessionId: session.id,
      sealId: seal.id,
      ownerMemberId: owner.id,
      memberIds,
      identityIds,
    };
  }

  async function generateSubmitAndReview(fixture: InitialFixture): Promise<ReviewedFixture> {
    // DoD 6:这一条闭环的所有**人发起**动作从 HTTP 进入；worker 自动提交仍在后面的
    // drainOnce，既不伪造请求也不直调 worker 的业务 service。
    const generatedResponse = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${fixture.activityId}/settlement/generate`)
      .set('Authorization', submitter.authHeader)
      .send({ operationKey: `${fixture.tag}-generate` });
    expect(generatedResponse.status).toBe(200);
    const generated = generatedResponse.body.data as {
      outcome: string;
      settlementRunId: string;
      settlementVersionId: string;
      settlementVersion: number;
    };
    expect(generated.outcome).toBe('draft');

    const replayResponse = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${fixture.activityId}/settlement/generate`)
      .set('Authorization', submitter.authHeader)
      .send({ operationKey: `${fixture.tag}-generate` });
    expect(replayResponse.status).toBe(200);
    expect(replayResponse.body.data).toMatchObject({
      outcome: 'draft',
      settlementVersionId: generated.settlementVersionId,
      replayed: true,
    });
    await expect(
      prisma.attendanceSettlementVersion.count({
        where: { settlementRunId: generated.settlementRunId, statusCode: 'draft' },
      }),
    ).resolves.toBe(1);

    const submittedResponse = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${fixture.activityId}/settlement/submit`)
      .set('Authorization', submitter.authHeader)
      .send({
        operationKey: `${fixture.tag}-submit`,
        expectedDraftVersion: generated.settlementVersion,
        evidenceSealId: fixture.sealId,
        confirmation: true,
      });
    expect(submittedResponse.status).toBe(200);
    const submitted = submittedResponse.body.data as {
      settlementVersionId: string;
      evidenceSealId: string;
      evidenceRevision: number;
      populationRevision: number;
      workflowRevision: number;
      contentHash: string;
    };
    const expectation: SettlementReviewExpectation = {
      evidenceSealId: submitted.evidenceSealId,
      evidenceRevision: submitted.evidenceRevision,
      populationRevision: submitted.populationRevision,
      workflowRevision: submitted.workflowRevision,
      contentHash: submitted.contentHash,
    };
    const firstResponse = await request(httpServer(app))
      .post(`/api/admin/v1/attendance-settlements/${submitted.settlementVersionId}/first-approve`)
      .set('Authorization', firstReviewer.authHeader)
      .send({ operationKey: `${fixture.tag}-first-review`, ...expectation });
    expect(firstResponse.status).toBe(200);

    const finalResponse = await request(httpServer(app))
      .post(`/api/admin/v1/attendance-settlements/${submitted.settlementVersionId}/final-approve`)
      .set('Authorization', finalReviewer.authHeader)
      .send({ operationKey: `${fixture.tag}-final-review`, ...expectation });
    expect(finalResponse.status).toBe(200);
    const final = finalResponse.body.data as { ledgerPostingBatchId: string | null };
    if (final.ledgerPostingBatchId === null) throw new Error('终审未创建 posting batch');
    return {
      ...fixture,
      settlementVersionId: submitted.settlementVersionId,
      batchId: final.ledgerPostingBatchId,
      expectation,
    };
  }

  async function drainUntilClaimed(worker: ActivityBatchWorker) {
    const first = await worker.drainOnce();
    if (first.jobClaimed) return { rounds: 1, result: first };
    const second = await worker.drainOnce({ now: new Date(Date.now() + 1_000) });
    return { rounds: 2, result: second };
  }

  it('>500 返回可幂等重放的 job；同 key 不同 payload 用具名码拒绝', async () => {
    const fixture = await createInitialFixture(501);
    const input = {
      activityId: fixture.activityId,
      operationKey: `${fixture.tag}-generate`,
      requestHash: `${fixture.tag}-generate-hash`,
    };

    const first = await drafts.generate(input, submitter, auditMeta);
    expect(first).toMatchObject({ outcome: 'job', statusCode: 'pending', replayed: false });
    const replay = await drafts.generate(input, submitter, auditMeta);
    expect(replay).toMatchObject({
      outcome: 'job',
      jobId: first.outcome === 'job' ? first.jobId : 'wrong-outcome',
      replayed: true,
    });
    await expect(
      prisma.attendanceSettlementVersion.count({
        where: { settlementRun: { activityId: fixture.activityId } },
      }),
    ).resolves.toBe(0);
    const conflict = await drafts
      .generate({ ...input, requestHash: `${input.requestHash}-changed` }, submitter, auditMeta)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(conflict).toBeInstanceOf(BizException);
    expect((conflict as BizException).biz).toBe(BizCode.SETTLEMENT_DRAFT_OPERATION_KEY_CONFLICT);
  });

  it('storage worker 真领 job：含 >500 分流；生成→提交→一审→终审→准备→自动提交→关账', async () => {
    // 同一条 e2e 先走 §5.9 的规模分叉，再走一场可同步活动的完整 HTTP 闭环。
    // 大规模 job 的本刀判据是 durable 创建 + 返回；其消费协议不复制旧草稿算法。
    const large = await createInitialFixture(501);
    const largeGenerated = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${large.activityId}/settlement/generate`)
      .set('Authorization', submitter.authHeader)
      .send({ operationKey: `${large.tag}-generate` });
    expect(largeGenerated.status).toBe(200);
    expect(largeGenerated.body.data).toMatchObject({ outcome: 'job', statusCode: 'pending' });

    const fixture = await createInitialFixture(1, { withPunches: true, withCapacity: true });
    const reviewed = await generateSubmitAndReview(fixture);

    const drained = await drainUntilClaimed(storageActivityWorker);
    expect(drained.rounds).toBe(2);
    expect(drained.result).toMatchObject({
      jobClaimed: true,
      batchStatus: 'committed',
      commitAttempted: true,
      commitErrorCode: null,
    });
    const batch = await prisma.ledgerPostingBatch.findUniqueOrThrow({
      where: { id: reviewed.batchId },
      select: { statusCode: true, committedByUserId: true },
    });
    expect(batch).toEqual({ statusCode: 'committed', committedByUserId: finalReviewer.id });

    const closed = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${reviewed.activityId}/settlement/close`)
      .set('Authorization', submitter.authHeader)
      .send({
        operationKey: `${reviewed.tag}-close`,
        expectedSettlementVersionId: reviewed.settlementVersionId,
        expectedPostingBatchId: reviewed.batchId,
      });
    expect(closed.status).toBe(200);
    expect(closed.body.data).toMatchObject({ outcome: 'closed', postingBatchId: reviewed.batchId });
    expect(closed.body.data.checks.every((check: { passed: boolean }) => check.passed)).toBe(true);
  });

  it('notification worker 真领 job：baseline 漂移后 ready + 零部分生效；修复后同批重试成功', async () => {
    const fixture = await createInitialFixture(1, { withPunches: true });
    const reviewed = await generateSubmitAndReview(fixture);
    const originalCommit = notificationCommitter.commitReadyBatch.bind(notificationCommitter);
    let driftKey: { memberId: string; ledgerDate: Date } | null = null;
    jest
      .spyOn(notificationCommitter, 'commitReadyBatch')
      .mockImplementationOnce(async (batchId) => {
        const entry = await prisma.participationLedgerEntry.findFirstOrThrow({
          where: { postingBatchId: batchId },
          select: { memberId: true, ledgerDate: true },
        });
        driftKey = entry;
        await prisma.memberContributionDayState.create({
          data: {
            memberId: entry.memberId,
            ledgerDate: entry.ledgerDate,
            version: 1,
            committedCreditedPoints: 0.5,
          },
        });
        return await originalCommit(batchId);
      });

    const failedDrain = await drainUntilClaimed(notificationActivityWorker);
    expect(failedDrain.rounds).toBe(2);
    expect(failedDrain.result).toMatchObject({
      jobClaimed: true,
      batchStatus: 'ready',
      commitAttempted: true,
      commitErrorCode: 'BizException:20084',
    });
    await expect(
      prisma.ledgerPostingBatch.findUniqueOrThrow({
        where: { id: reviewed.batchId },
        select: { statusCode: true },
      }),
    ).resolves.toEqual({ statusCode: 'ready' });
    await expect(ledgerQuery.sumCommittedByDayForMember(reviewed.memberIds[0])).resolves.toEqual(
      [],
    );
    await expect(
      prisma.participantSettlementResultRevision.count({
        where: { settlementVersionId: reviewed.settlementVersionId, statusCode: 'committed' },
      }),
    ).resolves.toBe(0);
    const retryJob = await prisma.activityBatchJob.findFirstOrThrow({
      where: { postingBatchId: reviewed.batchId, jobTypeCode: 'settlement_prepare' },
      select: { id: true, statusCode: true },
    });
    expect(retryJob.statusCode).toBe('pending');

    if (driftKey === null) throw new Error('未造出 baseline 漂移键');
    await prisma.memberContributionDayState.delete({
      where: { memberId_ledgerDate: driftKey },
    });
    jest.restoreAllMocks();
    const retried = await notificationActivityWorker.drainOnce({
      now: new Date(Date.now() + ACTIVITY_BATCH_RETRY_BACKOFF_MS + 1_000),
    });
    expect(retried).toMatchObject({ batchStatus: 'committed', commitErrorCode: null });
    await expect(
      prisma.activityBatchJob.findUniqueOrThrow({
        where: { id: retryJob.id },
        select: { statusCode: true },
      }),
    ).resolves.toEqual({ statusCode: 'succeeded' });
    await expect(
      prisma.ledgerPostingBatch.findUniqueOrThrow({
        where: { id: reviewed.batchId },
        select: { statusCode: true, committedByUserId: true },
      }),
    ).resolves.toEqual({ statusCode: 'committed', committedByUserId: finalReviewer.id });
  });
});
