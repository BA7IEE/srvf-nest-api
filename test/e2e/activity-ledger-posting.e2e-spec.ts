import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityBatchWorker } from '../../src/modules/activities/activity-batch.worker';
import {
  LEDGER_BASELINE_PAYLOAD_KEY,
  LEDGER_PREPARE_JOB_TYPE,
  LedgerPreparationService,
  ledgerBaselineDigest,
  ledgerBaselineKey,
  ledgerBaselineValue,
} from '../../src/modules/activities/ledger-preparation.service';
import { LedgerPostingAuditRecorder } from '../../src/modules/activities/ledger-posting-audit-recorder';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { LedgerQueryService } from '../../src/modules/activities/ledger-query.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// ===== 活动改造 v1.1 第 2 批第五刀:账本分块准备 + 短事务统一生效 =====
// (合同 §5.12 + §5.13 + §3.22 / §3.23 / §3.24)
//
// 🔴🔴 **这一刀的失败模式是"账悄悄错了",不是"报错"。** 部分生效、日合计超限、
//    基线漂移未察觉 —— 每一种都会产出一个看起来正常的账本。
//    因此本 spec 的每条判据都写成「**只由它对应的那一处实现触发**」:
//    卸掉哪一处,就只有那一段红(红集不重叠,读数见 PR 报告的判据绑定矩阵)。
//
// ⭐ 全 spec 最重要的五段:
//    ③ commit 前后可见性各一次读数(§3.22 / §5.13 ⑧);
//    ⑤ ⭐ baseline 漂移 ⇒ 拒绝,且**零部分生效**(§5.13 ⑤⑥)—— 本刀最核心的判据;
//    ⑥ ⭐ 日合计 0..3(§3.24 末句)—— 全仓唯一执行位;
//    ⑦ ⭐ 原子切换:最后一步抛错 ⇒ 全部回滚(§5.13 ⑦);
//    ⑨ 结构断言:准备路径零 `pg_advisory`(§5.12 末句)。
//
// 时间口径:全部用 2020 年的固定过去时刻(沿前四刀 spec;不耦合墙钟,无定时炸弹)。
// 北京日界 = UTC 16:00,下面的样本刻意分别落在界内与跨界两侧。

/** 北京 2020-03-01 09:00 → 13:00(= UTC 01:00 → 05:00),整块落在北京 03-01。 */
const SESSION_START = new Date('2020-03-01T01:00:00.000Z');
const SESSION_END = new Date('2020-03-01T05:00:00.000Z');
const SEAL_AT = new Date('2020-03-01T09:00:00.000Z');
const LEDGER_DATE = '2020-03-01';

interface PostingFixture {
  activityId: string;
  sessionIds: string[];
  runId: string;
  versionId: string;
  batchId: string;
  ownerMemberId: string;
  memberIds: string[];
  /** 与 `memberIds` 同序,每人一条(单场次夹具)或两条(双场次夹具)。 */
  identityIds: string[];
  resultRevisionIds: string[];
  /** 每条 result revision 对应的 memberId。 */
  memberIdByRevision: string[];
}

describe('ledger posting —— 分块准备 + 统一生效 (合同 §5.12 / §5.13)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: ActivityBatchWorker;
  let preparation: LedgerPreparationService;
  let posting: LedgerPostingService;
  let ledgerQuery: LedgerQueryService;
  let auditRecorder: LedgerPostingAuditRecorder;

  let actor: CurrentUserPayload;
  let organizationId: string;
  let sequence = 0;

  const auditMeta = { requestId: 'ledger-posting-e2e', ip: null, ua: null };

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    worker = app.get(ActivityBatchWorker);
    preparation = app.get(LedgerPreparationService);
    posting = app.get(LedgerPostingService);
    ledgerQuery = app.get(LedgerQueryService);
    auditRecorder = app.get(LedgerPostingAuditRecorder);

    const user = await createTestUser(app, {
      username: 'ledger-posting-actor',
      role: Role.SUPER_ADMIN,
    });
    actor = {
      id: user.id,
      username: user.username,
      role: user.role,
      status: UserStatus.ACTIVE,
      memberId: null,
    };

    const organization = await prisma.organization.create({
      data: { name: '账本入账测试组织', nodeTypeCode: 'ledger-posting-team' },
      select: { id: true },
    });
    organizationId = organization.id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  // =========================================================================
  // 夹具:一个"终审已通过、批次 preparing"的活动 —— 正是第四刀交出来的形态。
  //
  // 直接构造而不是跑完前四刀:本刀的判据要造的形态里有一半是前四刀**永远不会产出**的
  // (基线被改、日合计超限、准备结果被动过),只能直接写。与第四刀的真实衔接
  // 由第四刀自己的 spec 覆盖(它断言终审后 run=posting / batch=preparing / 零分录)。
  // =========================================================================
  async function createPostingFixture(
    options: {
      memberCount?: number;
      /** 复用既有队员，专用于跨活动 member-lock / overlap 判据。 */
      memberIds?: readonly string[];
      /** 每人在同一天参加几场(用于造"同一人同一日多条服务")。 */
      sessionsPerMember?: number;
      /** 每条 result revision 的认定贡献值。 */
      recognizedPoints?: number;
      recognizedHours?: number;
    } = {},
  ): Promise<PostingFixture> {
    const memberCount = options.memberIds?.length ?? options.memberCount ?? 2;
    const sessionCount = options.sessionsPerMember ?? 1;
    const recognizedPoints = options.recognizedPoints ?? 1.2;
    const recognizedHours = options.recognizedHours ?? 4;
    sequence += 1;
    const tag = `posting-${sequence}`;

    const activity = await prisma.activity.create({
      data: {
        title: `账本入账活动 ${sequence}`,
        activityTypeCode: `ledger-posting-type-${sequence}`,
        organizationId,
        startAt: SESSION_START,
        endAt: SESSION_END,
        location: '深圳',
        statusCode: 'published',
      },
      select: { id: true },
    });

    const sessionIds: string[] = [];
    for (let index = 0; index < sessionCount; index += 1) {
      // 同一北京日内的多场次:第二场往后挪 2 小时,仍在 UTC 16:00 日界之前。
      const startAt = new Date(SESSION_START.getTime() + index * 2 * 3600_000);
      const endAt = new Date(startAt.getTime() + 2 * 3600_000);
      const session = await prisma.activitySession.create({
        data: {
          activityId: activity.id,
          code: `${tag}-s${index}`,
          name: `${tag} 场次 ${index}`,
          startAt,
          endAt,
          locationText: '深圳',
          checkInOpenAt: new Date(startAt.getTime() - 3600_000),
          checkInCloseAt: new Date(startAt.getTime() + 3600_000),
          checkOutOpenAt: startAt,
          checkOutCloseAt: new Date(endAt.getTime() + 3600_000),
          locationRequired: false,
          locationPolicySourceCode: 'session',
          statusCode: 'scheduled',
        },
        select: { id: true },
      });
      sessionIds.push(session.id);
    }

    const memberIds = options.memberIds
      ? [...options.memberIds]
      : Array.from({ length: memberCount }, () => randomUUID());
    if (options.memberIds === undefined) {
      await prisma.member.createMany({
        data: memberIds.map((id, index) => ({
          id,
          memberNo: `${tag}-m${index}`,
          displayName: `${tag} 队员 ${index}`,
          gradeCode: 'level-2',
        })),
      });
    }
    const registrationIds = memberIds.map(() => randomUUID());
    await prisma.activityRegistration.createMany({
      data: registrationIds.map((id, index) => ({
        id,
        activityId: activity.id,
        memberId: memberIds[index],
        statusCode: 'approved',
      })),
    });

    const ownerMember = await prisma.member.create({
      data: { memberNo: `${tag}-owner`, displayName: `${tag} 负责人`, gradeCode: 'level-2' },
      select: { id: true },
    });
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: activity.id,
        memberId: ownerMember.id,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: actor.id,
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
        populationCountDistinct: memberCount,
        populationCountBySession: {},
        contentHash: `seal-hash-${tag}`,
        statusCode: 'active',
        sealedByUserId: actor.id,
        sealedAt: SEAL_AT,
      },
      select: { id: true },
    });

    const run = await prisma.attendanceSettlementRun.create({
      data: {
        activityId: activity.id,
        // 第四刀终审通过之后的形态:run 已在 `posting`,账还没记。
        statusCode: 'posting',
        currentDraftVersion: 1,
        currentSubmittedVersion: 1,
      },
      select: { id: true },
    });

    const version = await prisma.attendanceSettlementVersion.create({
      data: {
        settlementRunId: run.id,
        version: 1,
        evidenceSealId: seal.id,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: `content-hash-${tag}`,
        personCount: memberCount,
        sessionParticipationCount: memberCount * sessionCount,
        serviceSegmentCount: memberCount * sessionCount,
        createdByUserId: actor.id,
        submittedAt: SEAL_AT,
        statusCode: 'approved',
        operationKey: `${tag}-submit-key`,
        requestHash: `${tag}-submit-hash`,
      },
      select: { id: true },
    });

    const identityIds: string[] = [];
    const resultRevisionIds: string[] = [];
    const memberIdByRevision: string[] = [];
    for (let memberIndex = 0; memberIndex < memberCount; memberIndex += 1) {
      for (let sessionIndex = 0; sessionIndex < sessionCount; sessionIndex += 1) {
        const identity = await prisma.activityParticipationIdentity.create({
          data: {
            activityId: activity.id,
            sessionId: sessionIds[sessionIndex],
            registrationId: registrationIds[memberIndex],
            memberId: memberIds[memberIndex],
            currentStatusCode: 'pass',
            populationIncluded: true,
          },
          select: { id: true },
        });
        identityIds.push(identity.id);

        const sessionStart = new Date(SESSION_START.getTime() + sessionIndex * 2 * 3600_000);
        const checkIn = await prisma.attendancePunchEvent.create({
          data: {
            activityId: activity.id,
            sessionId: sessionIds[sessionIndex],
            participationIdentityId: identity.id,
            memberId: memberIds[memberIndex],
            eventTypeCode: 'check_in',
            sourceCode: 'self_qr',
            occurredAt: sessionStart,
            receivedAt: sessionStart,
            operatorUserId: actor.id,
            eventKey: `${tag}-in-${memberIndex}-${sessionIndex}`,
            requestHash: `${tag}-in-hash-${memberIndex}-${sessionIndex}`,
            evidenceRevision: 0,
          },
          select: { id: true },
        });
        await prisma.participantServiceSegmentRevision.create({
          data: {
            participationIdentityId: identity.id,
            segmentKey: 'seg-0',
            revision: 0,
            sourceCheckInEventId: checkIn.id,
            resultCode: 'valid',
            statusCode: 'draft',
            checkInAt: sessionStart,
            checkOutAt: new Date(sessionStart.getTime() + 2 * 3600_000),
            serviceHours: 2,
          },
        });

        const revision = await prisma.participantSettlementResultRevision.create({
          data: {
            settlementVersionId: version.id,
            participationIdentityId: identity.id,
            revision: 0,
            resultCode: 'present',
            recognizedServiceHours: recognizedHours,
            recognizedContributionPoints: recognizedPoints,
            calculatedServiceHours: recognizedHours,
            calculatedContributionPoints: recognizedPoints,
            statusCode: 'draft',
          },
          select: { id: true },
        });
        resultRevisionIds.push(revision.id);
        memberIdByRevision.push(memberIds[memberIndex]);
      }
    }

    const batch = await prisma.ledgerPostingBatch.create({
      data: {
        settlementRunId: run.id,
        settlementVersionId: version.id,
        batchRevision: 1,
        statusCode: 'preparing',
        requestKey: `settlement-final-approve:${version.id}:${tag}`,
        requestHash: `${tag}-approve-hash`,
        totalCount: memberCount,
        preparedByUserId: actor.id,
      },
      select: { id: true },
    });

    return {
      activityId: activity.id,
      sessionIds,
      runId: run.id,
      versionId: version.id,
      batchId: batch.id,
      ownerMemberId: ownerMember.id,
      memberIds,
      identityIds,
      resultRevisionIds,
      memberIdByRevision,
    };
  }

  /** 走真实准备路径(建任务 → 逐块 → 收口),不经 worker 的取活层。 */
  async function prepareBatch(fixture: PostingFixture): Promise<void> {
    const { jobId } = await preparation.ensurePrepareJob(fixture.batchId);
    const items = await prisma.activityBatchJobItem.findMany({
      where: { jobId },
      select: { id: true },
      orderBy: { itemKey: 'asc' },
    });
    for (const item of items) {
      await preparation.prepareChunk(jobId, item.id);
    }
    await preparation.finalize(jobId);
  }

  /**
   * **手工**造一个 `ready` 批次(绕过准备器的算术)。
   *
   * 为什么需要它:日上限判定(⑥)在**准备器正确**时是够不到的 —— 准备器已经先把
   * 超额的部分截成 cappedOut 了。要让"生效时的日上限复判"这道闸自己变红,
   * 就必须造出一个"基线自洽、但 credited 合计超过 3"的批次,即准备器**出错时**
   * 会产出的那种批次。这与第四刀 spec 直接构造 submitted 版本是同一手法。
   */
  async function craftReadyBatch(
    fixture: PostingFixture,
    rows: ReadonlyArray<{
      revisionIndex: number;
      ledgerDate: string;
      serviceHours: number;
      recognizedPoints: number;
      creditedPoints: number;
      cappedOutPoints: number;
    }>,
  ): Promise<void> {
    for (const row of rows) {
      const resultRevisionId = fixture.resultRevisionIds[row.revisionIndex];
      const memberId = fixture.memberIdByRevision[row.revisionIndex];
      const identityId = fixture.identityIds[row.revisionIndex];
      const sessionId = (
        await prisma.activityParticipationIdentity.findUniqueOrThrow({
          where: { id: identityId },
          select: { sessionId: true },
        })
      ).sessionId;

      await prisma.participantSettlementDay.create({
        data: {
          resultRevisionId,
          memberId,
          ledgerDate: new Date(`${row.ledgerDate}T00:00:00.000Z`),
          serviceHours: row.serviceHours,
          recognizedPoints: row.recognizedPoints,
          creditedPoints: row.creditedPoints,
          cappedOutPoints: row.cappedOutPoints,
          sequenceStartAt: SESSION_START,
          stableOrderKey: `${sessionId}:${identityId}`,
        },
      });

      for (const entry of [
        {
          entryTypeCode: 'service_credit',
          serviceHoursDelta: row.serviceHours,
          recognizedPointsDelta: 0,
          creditedPointsDelta: 0,
          cappedOutPointsDelta: 0,
        },
        {
          entryTypeCode: 'contribution_credit',
          serviceHoursDelta: 0,
          recognizedPointsDelta: row.recognizedPoints,
          creditedPointsDelta: row.creditedPoints,
          cappedOutPointsDelta: row.cappedOutPoints,
        },
      ]) {
        const entryKey = `${fixture.batchId}:${resultRevisionId}:${row.ledgerDate}:${entry.entryTypeCode}`;
        await prisma.participationLedgerEntry.create({
          data: {
            postingBatchId: fixture.batchId,
            entryKey,
            operationKey: `ledger-prepare:${entryKey}`,
            memberId,
            activityId: fixture.activityId,
            sessionId,
            participationIdentityId: identityId,
            resultRevisionId,
            ledgerDate: new Date(`${row.ledgerDate}T00:00:00.000Z`),
            ...entry,
          },
        });
      }
    }

    // 基线:按当前 day-state 真值算(⇒ ⑤ 的基线比对必然通过,只留 ⑥ 那一条会红)。
    const baseline: Record<string, string> = {};
    for (const key of new Set(
      rows.map((row) =>
        ledgerBaselineKey(fixture.memberIdByRevision[row.revisionIndex], row.ledgerDate),
      ),
    )) {
      const [memberId, ledgerDate] = key.split('|');
      const state = await prisma.memberContributionDayState.findUnique({
        where: {
          memberId_ledgerDate: { memberId, ledgerDate: new Date(`${ledgerDate}T00:00:00.000Z`) },
        },
        select: { version: true, committedCreditedPoints: true },
      });
      baseline[key] = ledgerBaselineValue(
        state?.version ?? 0,
        Math.round(Number(state?.committedCreditedPoints ?? 0) * 100),
      );
    }

    await prisma.activityBatchJob.create({
      data: {
        jobTypeCode: LEDGER_PREPARE_JOB_TYPE,
        activityId: fixture.activityId,
        settlementVersionId: fixture.versionId,
        postingBatchId: fixture.batchId,
        statusCode: 'succeeded',
        operationKey: `${LEDGER_PREPARE_JOB_TYPE}:${fixture.batchId}`,
        payloadVersion: 1,
        payload: { postingBatchId: fixture.batchId, [LEDGER_BASELINE_PAYLOAD_KEY]: baseline },
        total: 1,
        succeeded: 1,
      },
    });
    await prisma.ledgerPostingBatch.update({
      where: { id: fixture.batchId },
      data: {
        statusCode: 'ready',
        preparedAt: SEAL_AT,
        preparedCount: fixture.memberIds.length,
        baselineJsonHash: ledgerBaselineDigest(baseline),
      },
    });
  }

  function commitInput(fixture: PostingFixture) {
    sequence += 1;
    return { postingBatchId: fixture.batchId, operationKey: `ledger-commit-${sequence}` };
  }

  async function expectBiz(
    promise: Promise<unknown>,
    code: (typeof BizCode)[keyof typeof BizCode],
  ): Promise<void> {
    await expect(promise).rejects.toBeInstanceOf(BizException);
    await promise.catch((error: unknown) => {
      expect((error as BizException).biz).toBe(code);
    });
  }

  /** 🔴 「零部分生效」的完整取证:七件事**一件都不许**发生。 */
  async function expectNothingTookEffect(fixture: PostingFixture): Promise<void> {
    const batch = await prisma.ledgerPostingBatch.findUniqueOrThrow({
      where: { id: fixture.batchId },
      select: { statusCode: true, committedAt: true, committedByUserId: true },
    });
    expect(batch).toStrictEqual({
      statusCode: 'ready',
      committedAt: null,
      committedByUserId: null,
    });
    await expect(
      prisma.attendanceSettlementRun.findUniqueOrThrow({
        where: { id: fixture.runId },
        select: { statusCode: true, currentPostedVersion: true },
      }),
    ).resolves.toStrictEqual({ statusCode: 'posting', currentPostedVersion: null });
    // 读面一行都看不到(§3.22)。
    await expect(
      ledgerQuery.listCommittedEntriesForActivity(fixture.activityId),
    ).resolves.toStrictEqual([]);
    // 结果修订 / 服务段仍是 draft。
    await expect(
      prisma.participantSettlementResultRevision.count({
        where: { settlementVersionId: fixture.versionId, statusCode: { not: 'draft' } },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.participantServiceSegmentRevision.count({
        where: {
          participationIdentityId: { in: fixture.identityIds },
          OR: [{ statusCode: { not: 'draft' } }, { effectiveBatchId: { not: null } }],
        },
      }),
    ).resolves.toBe(0);
    // day-state 没有被本批次动过。
    await expect(
      prisma.memberContributionDayState.count({
        where: { latestBatchId: fixture.batchId },
      }),
    ).resolves.toBe(0);
    // 通知 intent 没有产生。
    await expect(
      prisma.notificationOutboxIntent.count({
        where: { eventKey: `settlement-ledger-commit:${fixture.batchId}` },
      }),
    ).resolves.toBe(0);
  }

  // =========================================================================
  // ① §5.12 分块准备:worker 建任务 → 逐块 → 批次进 ready
  // =========================================================================
  describe('① 分块准备(§5.12)', () => {
    it('worker 用 SKIP LOCKED + lease 领活,准备完成后批次进 ready', async () => {
      const fixture = await createPostingFixture({ memberCount: 3 });

      const rounds = await worker.drainUntilIdle(10);
      expect(rounds[0].jobsEnqueued).toBeGreaterThanOrEqual(1);

      const batch = await prisma.ledgerPostingBatch.findUniqueOrThrow({
        where: { id: fixture.batchId },
        select: {
          statusCode: true,
          preparedCount: true,
          totalCount: true,
          preparedAt: true,
          baselineJsonHash: true,
          committedAt: true,
        },
      });
      expect(batch.statusCode).toBe('ready');
      // §5.12 ⑧「数量一致」。
      expect(batch.preparedCount).toBe(3);
      expect(batch.totalCount).toBe(3);
      expect(batch.preparedAt).not.toBeNull();
      expect(batch.baselineJsonHash).not.toBeNull();
      // 🔴 准备完成 ≠ 入账:committedAt 恒空。
      expect(batch.committedAt).toBeNull();

      // 任务与逐项进度都落了库(§3.27)。
      const job = await prisma.activityBatchJob.findUniqueOrThrow({
        where: { operationKey: `${LEDGER_PREPARE_JOB_TYPE}:${fixture.batchId}` },
        select: { statusCode: true, total: true, succeeded: true, leaseGeneration: true },
      });
      expect(job.statusCode).toBe('succeeded');
      expect(job.total).toBe(1);
      expect(job.succeeded).toBe(1);
      // 租约代际递增过 ⇒ 确实走了取活层,不是被谁直接调进去的。
      expect(job.leaseGeneration).toBeGreaterThanOrEqual(1);
    });

    it('§3.21 day rows 按北京日拆出,并写出 preparing 分录(每对两条)', async () => {
      const fixture = await createPostingFixture({ memberCount: 2 });
      await prepareBatch(fixture);

      const days = await prisma.participantSettlementDay.findMany({
        where: { resultRevisionId: { in: fixture.resultRevisionIds } },
        select: {
          memberId: true,
          ledgerDate: true,
          serviceHours: true,
          recognizedPoints: true,
          creditedPoints: true,
          cappedOutPoints: true,
        },
        orderBy: { memberId: 'asc' },
      });
      expect(days).toHaveLength(2);
      for (const day of days) {
        expect(day.ledgerDate.toISOString().slice(0, 10)).toBe(LEDGER_DATE);
        expect(Number(day.serviceHours)).toBe(4);
        expect(Number(day.recognizedPoints)).toBe(1.2);
        // 额度充足 ⇒ 全额计入,零截断。
        expect(Number(day.creditedPoints)).toBe(1.2);
        expect(Number(day.cappedOutPoints)).toBe(0);
      }

      const entries = await prisma.participationLedgerEntry.findMany({
        where: { postingBatchId: fixture.batchId },
        select: { entryTypeCode: true },
      });
      expect(entries).toHaveLength(4);
      expect(entries.filter((e) => e.entryTypeCode === 'service_credit')).toHaveLength(2);
      expect(entries.filter((e) => e.entryTypeCode === 'contribution_credit')).toHaveLength(2);
    });

    it('结果修订不是 draft ⇒ 拒绝准备(20079),不照着已入账的版本再记一遍', async () => {
      const fixture = await createPostingFixture({ memberCount: 1 });
      await prisma.participantSettlementResultRevision.updateMany({
        where: { settlementVersionId: fixture.versionId },
        data: { statusCode: 'committed' },
      });

      const { jobId } = await preparation.ensurePrepareJob(fixture.batchId);
      const item = await prisma.activityBatchJobItem.findFirstOrThrow({
        where: { jobId },
        select: { id: true },
      });
      await expectBiz(
        preparation.prepareChunk(jobId, item.id),
        BizCode.LEDGER_PREPARE_RESULT_REVISION_STATUS_INVALID,
      );
    });

    it('有认定值却一天都归不上 ⇒ 拒绝准备(20078),不猜一个日期', async () => {
      const fixture = await createPostingFixture({ memberCount: 1 });
      // 把唯一那条服务段作废 ⇒ 权重清零,而认定值仍是 1.2 分。
      await prisma.participantServiceSegmentRevision.updateMany({
        where: { participationIdentityId: { in: fixture.identityIds } },
        data: { resultCode: 'voided' },
      });

      const { jobId } = await preparation.ensurePrepareJob(fixture.batchId);
      const item = await prisma.activityBatchJobItem.findFirstOrThrow({
        where: { jobId },
        select: { id: true },
      });
      await expectBiz(
        preparation.prepareChunk(jobId, item.id),
        BizCode.LEDGER_PREPARE_DAY_SPLIT_UNRESOLVED,
      );
      await expect(
        prisma.participationLedgerEntry.count({ where: { postingBatchId: fixture.batchId } }),
      ).resolves.toBe(0);
    });
  });

  // =========================================================================
  // ② ⭐ §3.22 可见性:preparing 分录对读面不可见(**而库里确实有行**)
  // =========================================================================
  describe('⭐ ② preparing 分录不可见(§3.22)', () => {
    it('读面查不到,但直查表能查到 —— 证明"看不见"不是"没写"', async () => {
      const fixture = await createPostingFixture({ memberCount: 2 });
      await prepareBatch(fixture);

      // 直查:分录**真的在库里**。
      await expect(
        prisma.participationLedgerEntry.count({ where: { postingBatchId: fixture.batchId } }),
      ).resolves.toBe(4);
      // 读面:一行都看不到。
      await expect(
        ledgerQuery.listCommittedEntriesForActivity(fixture.activityId),
      ).resolves.toStrictEqual([]);
      await expect(
        ledgerQuery.listCommittedEntriesForMember(fixture.memberIds[0]),
      ).resolves.toStrictEqual([]);
      await expect(
        ledgerQuery.sumCommittedByDayForMember(fixture.memberIds[0]),
      ).resolves.toStrictEqual([]);
    });
  });

  // =========================================================================
  // ③ ⭐ §5.13 统一生效 + §5.13 ⑧ commit 前后各一次可见性读数
  // =========================================================================
  describe('⭐ ③ 统一生效(§5.13)', () => {
    it('commit 前不可见、commit 后可见;八项状态一次切换到位', async () => {
      const fixture = await createPostingFixture({ memberCount: 2 });
      await prepareBatch(fixture);

      // —— commit 前的读数 ——
      const before = await ledgerQuery.listCommittedEntriesForActivity(fixture.activityId);
      expect(before).toHaveLength(0);

      const result = await posting.commitBatch(commitInput(fixture), actor, auditMeta);

      // —— commit 后的读数 ——
      const after = await ledgerQuery.listCommittedEntriesForActivity(fixture.activityId);
      expect(after).toHaveLength(4);

      expect(result.batchStatus).toBe('committed');
      expect(result.runStatus).toBe('posted');
      expect(result.memberCount).toBe(2);
      expect(result.dayStateCount).toBe(2);
      expect(result.entryCount).toBe(4);
      expect(result.replayed).toBe(false);

      // ① 批次 committed
      const batch = await prisma.ledgerPostingBatch.findUniqueOrThrow({
        where: { id: fixture.batchId },
        select: { statusCode: true, committedAt: true, committedByUserId: true },
      });
      expect(batch.statusCode).toBe('committed');
      expect(batch.committedAt).not.toBeNull();
      expect(batch.committedByUserId).toBe(actor.id);
      // ② run posted
      await expect(
        prisma.attendanceSettlementRun.findUniqueOrThrow({
          where: { id: fixture.runId },
          select: { statusCode: true, currentPostedVersion: true },
        }),
      ).resolves.toStrictEqual({ statusCode: 'posted', currentPostedVersion: 1 });
      // ③ result revisions committed
      await expect(
        prisma.participantSettlementResultRevision.count({
          where: { settlementVersionId: fixture.versionId, statusCode: 'committed' },
        }),
      ).resolves.toBe(2);
      // ④ segment revisions committed + 指回本批次
      const segments = await prisma.participantServiceSegmentRevision.findMany({
        where: { participationIdentityId: { in: fixture.identityIds } },
        select: { statusCode: true, effectiveBatchId: true },
      });
      expect(segments).toHaveLength(2);
      for (const segment of segments) {
        expect(segment.statusCode).toBe('committed');
        expect(segment.effectiveBatchId).toBe(fixture.batchId);
      }
      // ⑤ day-state 版本递增 + 日合计更新
      const dayStates = await prisma.memberContributionDayState.findMany({
        where: { memberId: { in: fixture.memberIds } },
        select: { version: true, committedCreditedPoints: true, latestBatchId: true },
      });
      expect(dayStates).toHaveLength(2);
      for (const state of dayStates) {
        expect(state.version).toBe(1);
        expect(Number(state.committedCreditedPoints)).toBe(1.2);
        expect(state.latestBatchId).toBe(fixture.batchId);
      }
      // ⑥ audit
      const audits = await prisma.auditLog.findMany({
        where: { resourceType: 'activity', resourceId: fixture.activityId },
        select: { context: true },
      });
      const commitAudit = audits.filter(
        (row) =>
          (row.context as { extra?: { operation?: string } } | null)?.extra?.operation ===
          'settlement-ledger-commit',
      );
      expect(commitAudit).toHaveLength(1);
      // ⑦ 通知 intent(同事务内)
      await expect(
        prisma.notificationOutboxIntent.count({
          where: { eventKey: `settlement-ledger-commit:${fixture.batchId}` },
        }),
      ).resolves.toBe(1);
      // ⑧ 🔴 本刀不产生 reversal(§3.23.5;goal DoD 15)
      await expect(prisma.ledgerEntryReversalClaim.count()).resolves.toBe(0);
      await expect(
        prisma.participationLedgerEntry.count({
          where: { entryTypeCode: { in: ['service_reversal', 'contribution_reversal'] } },
        }),
      ).resolves.toBe(0);
    });

    it('物化的日合计与"从分录求和"逐分相等 —— 两条路互为对拍', async () => {
      const fixture = await createPostingFixture({ memberCount: 2 });
      await prepareBatch(fixture);
      await posting.commitBatch(commitInput(fixture), actor, auditMeta);

      for (const memberId of fixture.memberIds) {
        const fromEntries = await ledgerQuery.sumCommittedByDayForMember(memberId);
        expect(fromEntries).toHaveLength(1);
        const state = await prisma.memberContributionDayState.findUniqueOrThrow({
          where: {
            memberId_ledgerDate: {
              memberId,
              ledgerDate: new Date(`${LEDGER_DATE}T00:00:00.000Z`),
            },
          },
          select: { committedCreditedPoints: true },
        });
        expect(Number(state.committedCreditedPoints)).toBe(fromEntries[0].creditedPoints);
      }
    });

    it('重放:批次已 committed ⇒ 原样返回上一次的结论,不写第二遍', async () => {
      const fixture = await createPostingFixture({ memberCount: 2 });
      await prepareBatch(fixture);
      const first = await posting.commitBatch(commitInput(fixture), actor, auditMeta);
      const replay = await posting.commitBatch(commitInput(fixture), actor, auditMeta);

      expect(replay.replayed).toBe(true);
      expect(replay.batchStatus).toBe('committed');
      expect(replay.committedAt).toStrictEqual(first.committedAt);
      // day-state 只递增过一次。
      const states = await prisma.memberContributionDayState.findMany({
        where: { memberId: { in: fixture.memberIds } },
        select: { version: true, committedCreditedPoints: true },
      });
      for (const state of states) {
        expect(state.version).toBe(1);
        expect(Number(state.committedCreditedPoints)).toBe(1.2);
      }
    });

    it('AC-058 rejects a cross-activity service-time overlap inside the member commit lock', async () => {
      const first = await createPostingFixture({ memberCount: 1 });
      await prepareBatch(first);
      await posting.commitBatch(commitInput(first), actor, auditMeta);

      const overlapping = await createPostingFixture({
        memberIds: first.memberIds,
        recognizedPoints: 1,
      });
      await prepareBatch(overlapping);
      await expectBiz(
        posting.commitBatch(commitInput(overlapping), actor, auditMeta),
        BizCode.ATTENDANCE_TIME_OVERLAP,
      );
      await expectNothingTookEffect(overlapping);
    });
  });

  // =========================================================================
  // ④ ⭐ §5.12 ⑦ 崩溃可重入:同一 item 重放两次,分录不翻倍
  // =========================================================================
  describe('⭐ ④ 崩溃可重入(§5.12 ⑦)', () => {
    it('把 item 打回 pending 再跑一次 ⇒ 分录、day rows 都不翻倍', async () => {
      const fixture = await createPostingFixture({ memberCount: 2 });
      const { jobId } = await preparation.ensurePrepareJob(fixture.batchId);
      const item = await prisma.activityBatchJobItem.findFirstOrThrow({
        where: { jobId },
        select: { id: true },
      });

      const first = await preparation.prepareChunk(jobId, item.id);
      expect(first.skipped).toBe(false);
      expect(first.entriesInserted).toBe(4);

      // 同一 item 直接重放(item 仍是 succeeded)⇒ 走跳过分支。
      const replaySkipped = await preparation.prepareChunk(jobId, item.id);
      expect(replaySkipped.skipped).toBe(true);

      // 更狠的一次:把 item 打回 pending —— 模拟"业务写成功但 item 状态没落地"。
      // 这时整块会**重新算一遍并重新写一遍**,靠 entryKey/operationKey 的单列 unique
      // + ON CONFLICT DO NOTHING 兜住。
      await prisma.activityBatchJobItem.update({
        where: { id: item.id },
        data: { statusCode: 'pending' },
      });
      const replayReRun = await preparation.prepareChunk(jobId, item.id);
      expect(replayReRun.skipped).toBe(false);
      expect(replayReRun.entriesInserted).toBe(0);

      await expect(
        prisma.participationLedgerEntry.count({ where: { postingBatchId: fixture.batchId } }),
      ).resolves.toBe(4);
      await expect(
        prisma.participantSettlementDay.count({
          where: { resultRevisionId: { in: fixture.resultRevisionIds } },
        }),
      ).resolves.toBe(2);
    });
  });

  // =========================================================================
  // ⑤ ⭐⭐ §5.13 ⑤⑥ baseline 比对 —— 本刀最核心的判据
  // =========================================================================
  describe('⭐⭐ ⑤ baseline 比对(§5.13 ⑤⑥)', () => {
    it('准备完成后有人动了某个 member/date 的 day-state ⇒ 20084,且**零部分生效**', async () => {
      const fixture = await createPostingFixture({ memberCount: 3 });
      await prepareBatch(fixture);

      // 从**另一条连接**(本事务之外)动一个人的 day-state:模拟另一场活动的批次
      // 在这中间生效过。三个人里**只动一个** —— 判据必须是"一条都没生效",
      // 而不是"大部分没生效"。
      await prisma.memberContributionDayState.upsert({
        where: {
          memberId_ledgerDate: {
            memberId: fixture.memberIds[1],
            ledgerDate: new Date(`${LEDGER_DATE}T00:00:00.000Z`),
          },
        },
        create: {
          memberId: fixture.memberIds[1],
          ledgerDate: new Date(`${LEDGER_DATE}T00:00:00.000Z`),
          version: 1,
          committedCreditedPoints: 0.5,
        },
        update: { version: { increment: 1 }, committedCreditedPoints: 0.5 },
      });

      await expectBiz(
        posting.commitBatch(commitInput(fixture), actor, auditMeta),
        BizCode.LEDGER_COMMIT_BASELINE_CHANGED,
      );

      // 🔴 零部分生效:七项逐条。
      await expectNothingTookEffect(fixture);
      // 未被漂移的那两个人也**一分钱都没记**(这才是"零部分生效"而不是"大部分")。
      for (const memberId of [fixture.memberIds[0], fixture.memberIds[2]]) {
        const state = await prisma.memberContributionDayState.findUnique({
          where: {
            memberId_ledgerDate: {
              memberId,
              ledgerDate: new Date(`${LEDGER_DATE}T00:00:00.000Z`),
            },
          },
          select: { version: true, committedCreditedPoints: true },
        });
        // 生效路径会为缺失的 day-state 建行 —— 回滚之后连那一行都不该留下。
        expect(state).toBeNull();
      }
    });

    it('基线明细被动过(摘要对不上)⇒ 20085,与"世界变了"分码', async () => {
      const fixture = await createPostingFixture({ memberCount: 2 });
      await prepareBatch(fixture);

      const job = await prisma.activityBatchJob.findUniqueOrThrow({
        where: { operationKey: `${LEDGER_PREPARE_JOB_TYPE}:${fixture.batchId}` },
        select: { id: true, payload: true },
      });
      const payload = job.payload as Record<string, unknown>;
      const baseline = { ...(payload[LEDGER_BASELINE_PAYLOAD_KEY] as Record<string, string>) };
      const firstKey = Object.keys(baseline)[0];
      baseline[firstKey] = ledgerBaselineValue(7, 250);
      await prisma.activityBatchJob.update({
        where: { id: job.id },
        data: { payload: { ...payload, [LEDGER_BASELINE_PAYLOAD_KEY]: baseline } },
      });

      await expectBiz(
        posting.commitBatch(commitInput(fixture), actor, auditMeta),
        BizCode.LEDGER_COMMIT_BASELINE_DIGEST_MISMATCH,
      );
      await expectNothingTookEffect(fixture);
    });
  });

  // =========================================================================
  // ⑥ ⭐⭐ §3.24 日合计 0..3 —— 全仓唯一执行位
  // =========================================================================
  describe('⭐⭐ ⑥ 日合计 0..3(§3.24 末句)', () => {
    it('准备器**正确**时:同一人同一日两场共 4.0 分会被截成 3.0(正对照)', async () => {
      const fixture = await createPostingFixture({
        memberCount: 1,
        sessionsPerMember: 2,
        recognizedPoints: 2,
        recognizedHours: 2,
      });
      await prepareBatch(fixture);
      await posting.commitBatch(commitInput(fixture), actor, auditMeta);

      const state = await prisma.memberContributionDayState.findUniqueOrThrow({
        where: {
          memberId_ledgerDate: {
            memberId: fixture.memberIds[0],
            ledgerDate: new Date(`${LEDGER_DATE}T00:00:00.000Z`),
          },
        },
        select: { committedCreditedPoints: true },
      });
      expect(Number(state.committedCreditedPoints)).toBe(3);

      const days = await prisma.participantSettlementDay.findMany({
        where: { resultRevisionId: { in: fixture.resultRevisionIds } },
        select: { creditedPoints: true, cappedOutPoints: true },
        orderBy: { sequenceStartAt: 'asc' },
      });
      // 先到的服务先拿额度:2.0 全额 + 1.0 计入 / 1.0 截掉。
      expect(days.map((row) => Number(row.creditedPoints)).sort()).toStrictEqual([1, 2]);
      expect(days.map((row) => Number(row.cappedOutPoints)).sort()).toStrictEqual([0, 1]);
    });

    it('⭐ 手工造一个"合计将超 3"的 ready 批次 ⇒ commit 被拒 20086,且零部分生效', async () => {
      const fixture = await createPostingFixture({
        memberCount: 1,
        sessionsPerMember: 2,
        recognizedPoints: 2,
        recognizedHours: 2,
      });
      // 两条都按"全额计入"造(= 准备器漏做日上限时会产出的形态):2.0 + 2.0 = 4.0 > 3。
      await craftReadyBatch(fixture, [
        {
          revisionIndex: 0,
          ledgerDate: LEDGER_DATE,
          serviceHours: 2,
          recognizedPoints: 2,
          creditedPoints: 2,
          cappedOutPoints: 0,
        },
        {
          revisionIndex: 1,
          ledgerDate: LEDGER_DATE,
          serviceHours: 2,
          recognizedPoints: 2,
          creditedPoints: 2,
          cappedOutPoints: 0,
        },
      ]);

      await expectBiz(
        posting.commitBatch(commitInput(fixture), actor, auditMeta),
        BizCode.LEDGER_COMMIT_DAILY_CAP_EXCEEDED,
      );
      await expectNothingTookEffect(fixture);
    });

    it('⭐ 基线里已有 2.5 分、本批再来 1.0 分 ⇒ 合计 3.5 被拒(跨活动的那一半)', async () => {
      const fixture = await createPostingFixture({ memberCount: 1, recognizedPoints: 1 });
      // 先让这一天已经有 2.5 分(别的活动记的),再按"基线自洽"造批次。
      await prisma.memberContributionDayState.create({
        data: {
          memberId: fixture.memberIds[0],
          ledgerDate: new Date(`${LEDGER_DATE}T00:00:00.000Z`),
          version: 3,
          committedCreditedPoints: 2.5,
        },
      });
      await craftReadyBatch(fixture, [
        {
          revisionIndex: 0,
          ledgerDate: LEDGER_DATE,
          serviceHours: 2,
          recognizedPoints: 1,
          creditedPoints: 1,
          cappedOutPoints: 0,
        },
      ]);

      await expectBiz(
        posting.commitBatch(commitInput(fixture), actor, auditMeta),
        BizCode.LEDGER_COMMIT_DAILY_CAP_EXCEEDED,
      );
      await expectNothingTookEffect(fixture);
      // 既有的那 2.5 分一分没动。
      await expect(
        prisma.memberContributionDayState.findUniqueOrThrow({
          where: {
            memberId_ledgerDate: {
              memberId: fixture.memberIds[0],
              ledgerDate: new Date(`${LEDGER_DATE}T00:00:00.000Z`),
            },
          },
          select: { version: true, committedCreditedPoints: true },
        }),
      ).resolves.toStrictEqual({ version: 3, committedCreditedPoints: expect.anything() });
    });
  });

  // =========================================================================
  // ⑦ ⭐⭐ §5.13 ⑦ 原子切换:最后一步抛错 ⇒ 全部回滚
  // =========================================================================
  describe('⭐⭐ ⑦ 原子切换(§5.13 ⑦)', () => {
    it('让 audit 抛错 ⇒ 批次仍 ready、run 仍 posting、分录仍不可见、day-state 一行未动', async () => {
      const fixture = await createPostingFixture({ memberCount: 2 });
      await prepareBatch(fixture);

      jest.spyOn(auditRecorder, 'log').mockRejectedValueOnce(new Error('audit down'));

      await expect(posting.commitBatch(commitInput(fixture), actor, auditMeta)).rejects.toThrow(
        'audit down',
      );

      await expectNothingTookEffect(fixture);
      // 连"生效路径会补建的 day-state 行"都不该留下。
      await expect(
        prisma.memberContributionDayState.count({ where: { memberId: { in: fixture.memberIds } } }),
      ).resolves.toBe(0);
    });
  });

  // =========================================================================
  // ⑧ 状态闸:三条各判各的 + 一版本至多一个 committed 批次
  // =========================================================================
  describe('⑧ 状态闸(§5.13 前置)', () => {
    it('批次还在 preparing ⇒ 20080', async () => {
      const fixture = await createPostingFixture({ memberCount: 1 });
      await expectBiz(
        posting.commitBatch(commitInput(fixture), actor, auditMeta),
        BizCode.LEDGER_COMMIT_BATCH_STATUS_INVALID,
      );
    });

    it('run 不在 posting ⇒ 20081', async () => {
      const fixture = await createPostingFixture({ memberCount: 1 });
      await prepareBatch(fixture);
      await prisma.attendanceSettlementRun.update({
        where: { id: fixture.runId },
        data: { statusCode: 'drafting' },
      });
      await expectBiz(
        posting.commitBatch(commitInput(fixture), actor, auditMeta),
        BizCode.LEDGER_COMMIT_RUN_STATUS_INVALID,
      );
    });

    it('版本不是 approved ⇒ 20082', async () => {
      const fixture = await createPostingFixture({ memberCount: 1 });
      await prepareBatch(fixture);
      await prisma.attendanceSettlementVersion.update({
        where: { id: fixture.versionId },
        data: { statusCode: 'returned' },
      });
      await expectBiz(
        posting.commitBatch(commitInput(fixture), actor, auditMeta),
        BizCode.LEDGER_COMMIT_VERSION_STATUS_INVALID,
      );
    });

    it('同一版本已有另一条 committed 批次 ⇒ 20083', async () => {
      const fixture = await createPostingFixture({ memberCount: 1 });
      await prepareBatch(fixture);
      await prisma.ledgerPostingBatch.create({
        data: {
          settlementRunId: fixture.runId,
          settlementVersionId: fixture.versionId,
          batchRevision: 99,
          statusCode: 'committed',
          requestKey: `other-committed-${fixture.batchId}`,
          totalCount: 1,
          committedAt: SEAL_AT,
        },
      });
      await expectBiz(
        posting.commitBatch(commitInput(fixture), actor, auditMeta),
        BizCode.LEDGER_COMMIT_VERSION_ALREADY_POSTED,
      );
    });

    it('批次里混进 reversal 分录 ⇒ 20089(第六刀写 reversal 时这条会当场变红)', async () => {
      const fixture = await createPostingFixture({ memberCount: 1 });
      await prepareBatch(fixture);
      const existing = await prisma.participationLedgerEntry.findFirstOrThrow({
        where: { postingBatchId: fixture.batchId, entryTypeCode: 'contribution_credit' },
      });
      await prisma.participationLedgerEntry.create({
        data: {
          postingBatchId: fixture.batchId,
          entryKey: `${existing.entryKey}:reversal`,
          operationKey: `${existing.operationKey}:reversal`,
          memberId: existing.memberId,
          activityId: existing.activityId,
          sessionId: existing.sessionId,
          participationIdentityId: existing.participationIdentityId,
          resultRevisionId: existing.resultRevisionId,
          ledgerDate: existing.ledgerDate,
          entryTypeCode: 'contribution_reversal',
          serviceHoursDelta: 0,
          recognizedPointsDelta: -1.2,
          creditedPointsDelta: -1.2,
          cappedOutPointsDelta: 0,
          reversesEntryId: existing.id,
        },
      });
      await expectBiz(
        posting.commitBatch(commitInput(fixture), actor, auditMeta),
        BizCode.LEDGER_COMMIT_ENTRY_SET_MISMATCH,
      );
    });
  });

  // =========================================================================
  // ⑨ ⭐ 结构断言:§5.12 末句「准备阶段不持有一万人 member locks 长事务」
  // =========================================================================
  describe('⭐ ⑨ 准备路径零 advisory lock(§5.12 末句)', () => {
    it('准备侧源码里 `pg_advisory` 命中数 = 0;生效侧恰恰必须有', () => {
      const read = (relative: string): string =>
        readFileSync(join(__dirname, '..', '..', 'src', 'modules', 'activities', relative), 'utf8');

      // ⚠️ 必须**先剥注释再判**。初版直接 grep 全文,被这两个文件自己的文件头
      //    (逐字写着「零 `pg_advisory`」)打红 —— 那不是发现了违规,是仪器在读散文。
      //    剥掉块注释与整行 `//` 注释之后,剩下的才是"代码里有没有真的取锁"。
      const codeOnly = (source: string): string =>
        source
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n')
          .filter((line) => !/^\s*(\/\/|\*)/.test(line))
          .join('\n');

      // 正对照:仪器本身是好的 —— 这两个文件的**散文里**确实提到过这个词。
      expect(read('ledger-preparation.service.ts')).toMatch(/pg_advisory/);

      // 准备路径的两个文件:代码里一处 advisory 锁都不许有。
      expect(codeOnly(read('ledger-preparation.service.ts'))).not.toMatch(/pg_advisory/);
      expect(codeOnly(read('activity-batch.worker.ts'))).not.toMatch(/pg_advisory/);

      // 反向对照:生效路径**必须**取队员锁,否则这条断言就只是"两个文件恰好没写"。
      expect(codeOnly(read('ledger-posting.service.ts'))).toMatch(/lockMembersForWrite/);
      // 🔴 死线:不得新建 member+date advisory lock —— 全刀只允许经既有 util 取键。
      expect(codeOnly(read('ledger-posting.service.ts'))).not.toMatch(
        /pg_advisory_xact_lock\(hashtext/,
      );
      // 恒串行闸用的是**双参数**空间且与队员无关 —— 它在生效侧,不在准备侧。
      expect(codeOnly(read('ledger-commit-lock-budget.ts'))).toMatch(/pg_try_advisory_xact_lock/);
    });

    it('准备过程中数据库里确实没有本进程持有的队员 advisory 锁', async () => {
      const fixture = await createPostingFixture({ memberCount: 2 });
      await prepareBatch(fixture);
      // 准备已结束,任何事务级 advisory 锁都应随事务结束释放;这里只是正面确认
      // 没有遗留(若准备路径改成持锁长事务且忘了释放,这条会红)。
      const [row] = await prisma.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count
        FROM pg_locks
        WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      `;
      expect(row?.count ?? 0).toBe(0);
    });
  });
});
