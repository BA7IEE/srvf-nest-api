import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { SettlementReviewAuditRecorder } from '../../src/modules/activities/settlement-review-audit-recorder';
import {
  SettlementReviewService,
  type SettlementReviewInput,
} from '../../src/modules/activities/settlement-review.service';
import { SettlementSubmitService } from '../../src/modules/activities/settlement-submit.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// ===== 活动改造 v1.1 第 2 批第四刀:一审 / 终审(合同 §5.11 + §3.19)=====
//
// 🔴 **这一刀守的是"谁说了算"。** 隔离漏一条,自提自审就成立;并发漏一条,
//    同一版本会有两个互相矛盾的生效决定。本 spec 的每条判据都写成
//    「**只由它对应的那一处实现触发**」:卸掉哪一处,就只有那一段红(红集不重叠)。
//
// ⭐ 全 spec 最重要的三段:
//    ① §3.19 三方分离(三条各一码,红集互不重叠);
//    ② 🔴 终审通过**没有**把 run 标 `posted`(本刀红线);
//    ③ §5.11 四项比对各自的失配。
//    「入口通过、锁后才不合法」与 approve/return 真并发在姊妹 spec
//    `activity-settlement-review-concurrency.e2e-spec.ts`(两套 Nest/Prisma pool)。
//
// 时间口径:全部用 2020 年的固定过去时刻(沿前三刀 spec;不耦合墙钟,无定时炸弹)。

const SESSION_START = new Date('2020-03-01T00:00:00.000Z');
const SESSION_END = new Date('2020-03-01T04:00:00.000Z');
const SEAL_AT = new Date('2020-03-01T09:00:00.000Z');

interface ReviewFixture {
  activityId: string;
  sessionId: string;
  runId: string;
  versionId: string;
  sealId: string;
  contentHash: string;
  ownerMemberId: string;
  identityIds: string[];
}

describe('settlement review —— 一审 / 终审 (合同 §5.11 + §3.19)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: SettlementReviewService;
  let submitService: SettlementSubmitService;
  let auditRecorder: SettlementReviewAuditRecorder;

  /** 三方分离要三个真人:提交人 / 一审人 / 终审人。第四个人用于"三方各不相同"的正路。 */
  let submitter: CurrentUserPayload;
  let firstReviewer: CurrentUserPayload;
  let finalReviewer: CurrentUserPayload;

  let organizationId: string;
  let sequence = 0;

  const auditMeta = { requestId: 'settlement-review-e2e', ip: null, ua: null };

  beforeAll(async () => {
    // 第 7 批第 ③ 刀 —— 活动 v1.1 单一 cutover gate(合同 §16.2)。本 spec 驱动的是
    // **结算真相链**(打卡 / 封场 / 结算 / 账本 / 关账 / 更正),那条链按定义只在闸开时存在;
    // 闸关(默认 = 今天的行为)时这些写入口一律回 20153。故此处显式置真,
    // **断言一字未改** —— 改的只是这个 spec 声明自己跑在哪一侧闸。
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    service = app.get(SettlementReviewService);
    submitService = app.get(SettlementSubmitService);
    auditRecorder = app.get(SettlementReviewAuditRecorder);

    submitter = await makeActor('settlement-review-submitter');
    firstReviewer = await makeActor('settlement-review-first');
    finalReviewer = await makeActor('settlement-review-final');

    const organization = await prisma.organization.create({
      data: { name: '结算审核测试组织', nodeTypeCode: 'settlement-review-team' },
      select: { id: true },
    });
    organizationId = organization.id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    await app.close();
  });

  async function makeActor(username: string): Promise<CurrentUserPayload> {
    const user = await createTestUser(app, { username, role: Role.SUPER_ADMIN });
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
  }

  // =========================================================================
  // 夹具:一个"随时可一审"的活动 —— 已封场、run=pending_first_review、
  // 有一条 submitted 版本(提交人 = submitter)。
  //
  // 直接构造而不是每次跑第三刀的提交器:本刀的判据要造的形态里有一半是提交器
  // **永远不会产出**的(seal 被换掉、workflowRevision 前进、版本状态异常),只能直接写。
  // 与第三刀的真实衔接另有一条端到端用例(见文末「与第三刀端到端」)。
  // =========================================================================
  async function createReviewable(
    options: {
      populationSize?: number;
      runStatusCode?: string;
      versionStatusCode?: string;
      /** 版本的提交人;默认 submitter。传 null 造"提交人为空"的可空侧形态。 */
      submittedByUserId?: string | null;
      /** 不建 run 的 currentSubmittedVersion 指针。 */
      withoutSubmittedPointer?: boolean;
    } = {},
  ): Promise<ReviewFixture> {
    const populationSize = options.populationSize ?? 2;
    sequence += 1;
    const tag = `review-${sequence}`;

    const activity = await prisma.activity.create({
      data: {
        title: `结算审核活动 ${sequence}`,
        activityTypeCode: `settlement-review-type-${sequence}`,
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
        code: `${tag}-s1`,
        name: `${tag} 场次一`,
        startAt: SESSION_START,
        endAt: SESSION_END,
        locationText: '深圳',
        checkInOpenAt: new Date(SESSION_START.getTime() - 3600_000),
        checkInCloseAt: new Date(SESSION_START.getTime() + 3600_000),
        checkOutOpenAt: new Date(SESSION_START.getTime() + 2 * 3600_000),
        checkOutCloseAt: new Date('2020-03-01T08:00:00.000Z'),
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });

    const identityIds = await createIdentities(activity.id, session.id, tag, populationSize);

    const ownerMember = await prisma.member.create({
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
        memberId: ownerMember.id,
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
        allWindowsClosedAt: new Date('2020-03-01T08:00:00.000Z'),
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: populationSize,
        populationCountBySession: {},
        contentHash: `seal-hash-${tag}`,
        statusCode: 'active',
        sealedByUserId: submitter.id,
        sealedAt: SEAL_AT,
      },
      select: { id: true },
    });

    const run = await prisma.attendanceSettlementRun.create({
      data: {
        activityId: activity.id,
        statusCode: options.runStatusCode ?? 'pending_first_review',
        currentDraftVersion: 1,
        currentSubmittedVersion: options.withoutSubmittedPointer === true ? null : 1,
      },
      select: { id: true },
    });

    const contentHash = `content-hash-${tag}`;
    const version = await prisma.attendanceSettlementVersion.create({
      data: {
        settlementRunId: run.id,
        version: 1,
        evidenceSealId: seal.id,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash,
        personCount: populationSize,
        sessionParticipationCount: populationSize,
        serviceSegmentCount: 0,
        createdByUserId:
          options.submittedByUserId === undefined ? submitter.id : options.submittedByUserId,
        submittedAt: SEAL_AT,
        statusCode: options.versionStatusCode ?? 'submitted',
        operationKey: `${tag}-submit-key`,
        requestHash: `${tag}-submit-hash`,
      },
      select: { id: true },
    });

    return {
      activityId: activity.id,
      sessionId: session.id,
      runId: run.id,
      versionId: version.id,
      sealId: seal.id,
      contentHash,
      ownerMemberId: ownerMember.id,
      identityIds,
    };
  }

  async function createIdentities(
    activityId: string,
    sessionId: string,
    tag: string,
    count: number,
  ): Promise<string[]> {
    const memberIds = Array.from({ length: count }, () => randomUUID());
    const registrationIds = Array.from({ length: count }, () => randomUUID());
    const identityIds = Array.from({ length: count }, () => randomUUID());
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
        activityId,
        memberId: memberIds[index],
        statusCode: 'approved',
      })),
    });
    await prisma.activityParticipationIdentity.createMany({
      data: identityIds.map((id, index) => ({
        id,
        activityId,
        sessionId,
        registrationId: registrationIds[index],
        memberId: memberIds[index],
        currentStatusCode: 'pass',
        populationIncluded: true,
      })),
    });
    return identityIds;
  }

  /** 与夹具完全吻合的审核入参。每条用例只在这上面**动一处**,红集才可能不重叠。 */
  function reviewInput(
    fixture: ReviewFixture,
    overrides: Partial<SettlementReviewInput> = {},
  ): SettlementReviewInput {
    sequence += 1;
    return {
      activityId: fixture.activityId,
      actionCode: 'approve',
      operationKey: `review-op-${sequence}`,
      requestHash: `review-hash-${sequence}`,
      expectation: {
        evidenceSealId: fixture.sealId,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: fixture.contentHash,
      },
      ...overrides,
    };
  }

  async function expectBiz(
    promise: Promise<unknown>,
    code: (typeof BizCode)[keyof typeof BizCode],
  ) {
    await expect(promise).rejects.toBeInstanceOf(BizException);
    await promise.catch((error: unknown) => {
      expect((error as BizException).biz).toBe(code);
    });
  }

  /** 走完一审通过,让夹具停在"可终审"状态。返回一审人。 */
  async function advanceToFinalReview(fixture: ReviewFixture): Promise<void> {
    await service.firstReview(reviewInput(fixture), firstReviewer, auditMeta);
  }

  // =========================================================================
  // ⭐ ① §3.19 三方分离(锁后复判)—— 三条各一码,红集互不重叠
  // =========================================================================
  describe('⭐ 三方分离(§3.19)', () => {
    it('① 提交人不可一审自己提交的版本 → 20062', async () => {
      const fixture = await createReviewable();
      await expectBiz(
        service.firstReview(reviewInput(fixture), submitter, auditMeta),
        BizCode.SETTLEMENT_SELF_FIRST_REVIEW_FORBIDDEN,
      );
      // 干净拒绝:不留半条动作行,run 状态不动。
      await expect(
        prisma.settlementReviewAction.count({ where: { settlementVersionId: fixture.versionId } }),
      ).resolves.toBe(0);
      await expect(
        prisma.attendanceSettlementRun.findUniqueOrThrow({
          where: { id: fixture.runId },
          select: { statusCode: true },
        }),
      ).resolves.toStrictEqual({ statusCode: 'pending_first_review' });
    });

    it('② 提交人不可终审自己提交的版本 → 20063', async () => {
      const fixture = await createReviewable();
      await advanceToFinalReview(fixture);
      await expectBiz(
        service.finalReview(reviewInput(fixture), submitter, auditMeta),
        BizCode.SETTLEMENT_SELF_FINAL_REVIEW_FORBIDDEN,
      );
      // 终审被拒 ⇒ **一条批次都不许有**(否则账本准备已经被启动了)。
      await expect(
        prisma.ledgerPostingBatch.count({ where: { settlementVersionId: fixture.versionId } }),
      ).resolves.toBe(0);
    });

    it('③ 一审人不可再终审同一版本 → 20064', async () => {
      const fixture = await createReviewable();
      await advanceToFinalReview(fixture);
      await expectBiz(
        service.finalReview(reviewInput(fixture), firstReviewer, auditMeta),
        BizCode.SETTLEMENT_SAME_REVIEWER_FORBIDDEN,
      );
      await expect(
        prisma.ledgerPostingBatch.count({ where: { settlementVersionId: fixture.versionId } }),
      ).resolves.toBe(0);
    });

    it('三方各不相同 ⇒ 一审、终审都放行', async () => {
      const fixture = await createReviewable();
      await advanceToFinalReview(fixture);
      const result = await service.finalReview(reviewInput(fixture), finalReviewer, auditMeta);
      expect(result.actionCode).toBe('approve');
      expect(result.stageCode).toBe('final');

      const actions = await prisma.settlementReviewAction.findMany({
        where: { settlementVersionId: fixture.versionId },
        orderBy: { actedAt: 'asc' },
        select: { stageCode: true, actionCode: true, actorUserId: true },
      });
      expect(actions).toStrictEqual([
        { stageCode: 'first', actionCode: 'approve', actorUserId: firstReviewer.id },
        { stageCode: 'final', actionCode: 'approve', actorUserId: finalReviewer.id },
      ]);
    });
  });

  // =========================================================================
  // ⭐ ② 🔴 本刀红线:终审 approve **不把 run 标 posted**
  // =========================================================================
  describe('⭐ 🔴 终审通过只准备账本批次,不入账(§5.11)', () => {
    it('正面:run → posting(不是 posted)、batch → preparing、零 LedgerEntry', async () => {
      const fixture = await createReviewable({ populationSize: 3 });
      await advanceToFinalReview(fixture);
      const result = await service.finalReview(reviewInput(fixture), finalReviewer, auditMeta);

      const run = await prisma.attendanceSettlementRun.findUniqueOrThrow({
        where: { id: fixture.runId },
        select: { statusCode: true, currentPostedVersion: true, currentSubmittedVersion: true },
      });
      // 🔴 三条一起断言,任何一条被改成"提前入账"都会红。
      expect(run.statusCode).toBe('posting');
      expect(run.statusCode).not.toBe('posted');
      expect(run.currentPostedVersion).toBeNull();
      expect(run.currentSubmittedVersion).toBe(1);

      const batch = await prisma.ledgerPostingBatch.findUniqueOrThrow({
        where: { id: result.ledgerPostingBatchId ?? '' },
        select: {
          statusCode: true,
          committedAt: true,
          committedByUserId: true,
          preparedByUserId: true,
          totalCount: true,
          preparedCount: true,
          batchRevision: true,
          settlementVersionId: true,
        },
      });
      expect(batch).toStrictEqual({
        statusCode: 'preparing',
        committedAt: null,
        committedByUserId: null,
        preparedByUserId: finalReviewer.id,
        totalCount: 3,
        preparedCount: 0,
        batchRevision: 1,
        settlementVersionId: fixture.versionId,
      });

      // 账还没记:一条分录都不许有。
      await expect(
        prisma.participationLedgerEntry.count({
          where: { postingBatchId: result.ledgerPostingBatchId ?? '' },
        }),
      ).resolves.toBe(0);

      // 版本转 approved(§3.19 五值闭集)。
      await expect(
        prisma.attendanceSettlementVersion.findUniqueOrThrow({
          where: { id: fixture.versionId },
          select: { statusCode: true, returnFromStage: true, returnReason: true },
        }),
      ).resolves.toStrictEqual({
        statusCode: 'approved',
        returnFromStage: null,
        returnReason: null,
      });
    });

    it('反面:断言确实分得清 posting 与 posted —— 把 run 手改成 posted 后同一组断言会红', async () => {
      const fixture = await createReviewable();
      await advanceToFinalReview(fixture);
      await service.finalReview(reviewInput(fixture), finalReviewer, auditMeta);

      // 模拟"实现提前把 run 标 posted"这一变异的**可观测后果**,
      // 证明上一条用例的断言不是空绿(它真的会被 posted 触发)。
      await prisma.attendanceSettlementRun.update({
        where: { id: fixture.runId },
        data: { statusCode: 'posted', currentPostedVersion: 1 },
      });
      const mutated = await prisma.attendanceSettlementRun.findUniqueOrThrow({
        where: { id: fixture.runId },
        select: { statusCode: true, currentPostedVersion: true },
      });
      expect(() => {
        expect(mutated.statusCode).toBe('posting');
      }).toThrow();
      expect(() => {
        expect(mutated.currentPostedVersion).toBeNull();
      }).toThrow();
    });

    it('「恢复」:同一版本已有未 committed 批次时复用,不开第二条', async () => {
      const fixture = await createReviewable();
      await advanceToFinalReview(fixture);
      const existing = await prisma.ledgerPostingBatch.create({
        data: {
          settlementRunId: fixture.runId,
          settlementVersionId: fixture.versionId,
          batchRevision: 1,
          statusCode: 'preparing',
          requestKey: `pre-existing-${fixture.versionId}`,
          totalCount: 2,
        },
        select: { id: true },
      });

      const result = await service.finalReview(reviewInput(fixture), finalReviewer, auditMeta);
      expect(result.ledgerPostingBatchId).toBe(existing.id);
      await expect(
        prisma.ledgerPostingBatch.count({ where: { settlementVersionId: fixture.versionId } }),
      ).resolves.toBe(1);
    });
  });

  // =========================================================================
  // ③ §5.11 只允许 approve / return
  // =========================================================================
  describe('只允许 approve 或 return(§5.11)', () => {
    it('第三种动作 → 20074', async () => {
      const fixture = await createReviewable();
      await expectBiz(
        service.firstReview(
          reviewInput(fixture, { actionCode: 'reject' as never }),
          firstReviewer,
          auditMeta,
        ),
        BizCode.SETTLEMENT_REVIEW_ACTION_INVALID,
      );
    });

    it('一审 approve ⇒ 写 ReviewAction 并推进 pending_final_review', async () => {
      const fixture = await createReviewable();
      const result = await service.firstReview(reviewInput(fixture), firstReviewer, auditMeta);
      expect(result.runStatusBefore).toBe('pending_first_review');
      expect(result.runStatusAfter).toBe('pending_final_review');
      // 一审通过**不改**版本状态:它还是那个待终审的 submitted 版本。
      expect(result.versionStatusAfter).toBe('submitted');
      expect(result.ledgerPostingBatchId).toBeNull();

      await expect(
        prisma.settlementReviewAction.findUniqueOrThrow({
          where: { id: result.reviewActionId },
          select: { stageCode: true, actionCode: true, actorUserId: true, note: true },
        }),
      ).resolves.toStrictEqual({
        stageCode: 'first',
        actionCode: 'approve',
        actorUserId: firstReviewer.id,
        note: null,
      });
    });

    it('一审 return ⇒ 写原因、版本转 returned、run 退回 drafting', async () => {
      const fixture = await createReviewable();
      const result = await service.firstReview(
        reviewInput(fixture, { actionCode: 'return', returnReason: '第 3 个人的时长对不上' }),
        firstReviewer,
        auditMeta,
      );
      expect(result.runStatusAfter).toBe('drafting');
      expect(result.versionStatusAfter).toBe('returned');

      await expect(
        prisma.attendanceSettlementVersion.findUniqueOrThrow({
          where: { id: fixture.versionId },
          select: { statusCode: true, returnFromStage: true, returnReason: true },
        }),
      ).resolves.toStrictEqual({
        statusCode: 'returned',
        returnFromStage: 'first',
        returnReason: '第 3 个人的时长对不上',
      });
      // ⚠️ 指针**不清空**(§3.19「快速指针,不是真相源」)。挡住"拿已退回的版本
      //    再审一次"的是 run 状态与版本状态两道闸,不是这个指针 —— 清空它反而会让
      //    并发败者的错误码随交错顺序变化(见 service 里那段注释与并发 spec)。
      await expect(
        prisma.attendanceSettlementRun.findUniqueOrThrow({
          where: { id: fixture.runId },
          select: { currentSubmittedVersion: true, statusCode: true },
        }),
      ).resolves.toStrictEqual({ currentSubmittedVersion: 1, statusCode: 'drafting' });
      // 退回原因也落进 append-only 的动作行。
      await expect(
        prisma.settlementReviewAction.findUniqueOrThrow({
          where: { id: result.reviewActionId },
          select: { note: true },
        }),
      ).resolves.toStrictEqual({ note: '第 3 个人的时长对不上' });
    });

    it.each([
      ['缺省', undefined],
      ['空串', ''],
      ['纯空白', '   '],
    ])('return 没写原因(%s)→ 20075', async (_label, reason) => {
      const fixture = await createReviewable();
      await expectBiz(
        service.firstReview(
          reviewInput(fixture, { actionCode: 'return', returnReason: reason }),
          firstReviewer,
          auditMeta,
        ),
        BizCode.SETTLEMENT_REVIEW_RETURN_REASON_REQUIRED,
      );
    });

    it('终审 return ⇒ 版本转 returned + returnFromStage=final,并作废未 committed 批次', async () => {
      const fixture = await createReviewable();
      await advanceToFinalReview(fixture);
      const stray = await prisma.ledgerPostingBatch.create({
        data: {
          settlementRunId: fixture.runId,
          settlementVersionId: fixture.versionId,
          batchRevision: 1,
          statusCode: 'preparing',
          requestKey: `stray-${fixture.versionId}`,
          totalCount: 2,
        },
        select: { id: true },
      });

      const result = await service.finalReview(
        reviewInput(fixture, { actionCode: 'return', returnReason: '账目与现场不符' }),
        finalReviewer,
        auditMeta,
      );
      expect(result.runStatusAfter).toBe('drafting');
      expect(result.versionStatusAfter).toBe('returned');

      await expect(
        prisma.attendanceSettlementVersion.findUniqueOrThrow({
          where: { id: fixture.versionId },
          select: { returnFromStage: true, returnReason: true },
        }),
      ).resolves.toStrictEqual({ returnFromStage: 'final', returnReason: '账目与现场不符' });

      // 已退回的版本上不能留着可入账的批次。
      const voided = await prisma.ledgerPostingBatch.findUniqueOrThrow({
        where: { id: stray.id },
        select: { statusCode: true, voidedAt: true },
      });
      expect(voided.statusCode).toBe('voided');
      expect(voided.voidedAt).not.toBeNull();
    });

    it('终审 return:批次已 committed ⇒ 20076(§5.11「只能在 batch 未 committed 前」)', async () => {
      const fixture = await createReviewable();
      await advanceToFinalReview(fixture);
      await prisma.ledgerPostingBatch.create({
        data: {
          settlementRunId: fixture.runId,
          settlementVersionId: fixture.versionId,
          batchRevision: 1,
          statusCode: 'committed',
          requestKey: `committed-${fixture.versionId}`,
          totalCount: 2,
          committedAt: SEAL_AT,
        },
      });
      await expectBiz(
        service.finalReview(
          reviewInput(fixture, { actionCode: 'return', returnReason: '晚了' }),
          finalReviewer,
          auditMeta,
        ),
        BizCode.SETTLEMENT_REVIEW_BATCH_ALREADY_COMMITTED,
      );
    });
  });

  // =========================================================================
  // ⭐ ④ §5.11 四项比对 —— 每条只动一处,红集互不重叠
  // =========================================================================
  describe('⭐ 四项比对(§5.11)', () => {
    it('① seal 已不是当前 active 的那一张 → 20068', async () => {
      const fixture = await createReviewable();
      await prisma.evidenceSeal.update({
        where: { id: fixture.sealId },
        data: { statusCode: 'superseded' },
      });
      await expectBiz(
        service.firstReview(reviewInput(fixture), firstReviewer, auditMeta),
        BizCode.SETTLEMENT_REVIEW_EVIDENCE_SEAL_STALE,
      );
    });

    it('① 审核人看的是另一张 seal → 20068', async () => {
      const fixture = await createReviewable();
      await expectBiz(
        service.firstReview(
          reviewInput(fixture, {
            expectation: {
              evidenceSealId: 'some-other-seal',
              evidenceRevision: 0,
              populationRevision: 0,
              workflowRevision: 0,
              contentHash: fixture.contentHash,
            },
          }),
          firstReviewer,
          auditMeta,
        ),
        BizCode.SETTLEMENT_REVIEW_EVIDENCE_SEAL_STALE,
      );
    });

    it('② 证据 / 人口版本在送审后前进 → 20069', async () => {
      const fixture = await createReviewable();
      await prisma.activityEvidenceState.create({
        data: { activityId: fixture.activityId, evidenceRevision: 1, populationRevision: 0 },
      });
      await expectBiz(
        service.firstReview(reviewInput(fixture), firstReviewer, auditMeta),
        BizCode.SETTLEMENT_REVIEW_EVIDENCE_REVISION_CHANGED,
      );
    });

    it('③ 活动流程版本在送审后前进 → 20070', async () => {
      const fixture = await createReviewable();
      await prisma.activity.update({
        where: { id: fixture.activityId },
        data: { workflowRevision: 1 },
      });
      await expectBiz(
        service.firstReview(reviewInput(fixture), firstReviewer, auditMeta),
        BizCode.SETTLEMENT_REVIEW_WORKFLOW_REVISION_CHANGED,
      );
    });

    it('④ 审核人看到的 contentHash 与版本行不一致 → 20071', async () => {
      const fixture = await createReviewable();
      await expectBiz(
        service.firstReview(
          reviewInput(fixture, {
            expectation: {
              evidenceSealId: fixture.sealId,
              evidenceRevision: 0,
              populationRevision: 0,
              workflowRevision: 0,
              contentHash: 'hash-审核人看的是别的版本',
            },
          }),
          firstReviewer,
          auditMeta,
        ),
        BizCode.SETTLEMENT_REVIEW_CONTENT_HASH_CHANGED,
      );
    });

    // 🔴 只比对不重算的**正面证据**:把结果行改到面目全非,只要版本行上的 hash 没动,
    //    审核照样通过 —— 因为本刀根本不去读结果行重算。
    //    (重算派的实现会在这里红:它算出来的 hash 与版本行对不上。)
    it('🔴 结果行被改动但版本行 hash 未变 ⇒ 审核仍通过(证明本刀不重算)', async () => {
      const fixture = await createReviewable();
      await prisma.participantSettlementResultRevision.create({
        data: {
          settlementVersionId: fixture.versionId,
          participationIdentityId: fixture.identityIds[0],
          revision: 1,
          resultCode: 'present',
          lateFlag: false,
          earlyLeaveFlag: false,
          recognizedServiceHours: 99,
          recognizedContributionPoints: 99,
          calculatedServiceHours: 99,
          calculatedContributionPoints: 99,
          statusCode: 'draft',
        },
      });
      const result = await service.firstReview(reviewInput(fixture), firstReviewer, auditMeta);
      expect(result.replayed).toBe(false);
      expect(result.runStatusAfter).toBe('pending_final_review');
    });
  });

  // =========================================================================
  // ⑤ §3.19 一版本一阶段一个生效决定 + 幂等
  // =========================================================================
  describe('一版本一阶段一个生效决定(§3.19)', () => {
    it('同阶段第二次 approve(不同 operationKey)→ 20072', async () => {
      const fixture = await createReviewable();
      await service.firstReview(reviewInput(fixture), firstReviewer, auditMeta);
      await expectBiz(
        service.firstReview(reviewInput(fixture), finalReviewer, auditMeta),
        BizCode.SETTLEMENT_REVIEW_ALREADY_DECIDED,
      );
      await expect(
        prisma.settlementReviewAction.count({
          where: { settlementVersionId: fixture.versionId, stageCode: 'first' },
        }),
      ).resolves.toBe(1);
    });

    it('同阶段 approve 之后再 return(不同 operationKey)→ 20072', async () => {
      const fixture = await createReviewable();
      await service.firstReview(reviewInput(fixture), firstReviewer, auditMeta);
      await expectBiz(
        service.firstReview(
          reviewInput(fixture, { actionCode: 'return', returnReason: '反悔了' }),
          finalReviewer,
          auditMeta,
        ),
        BizCode.SETTLEMENT_REVIEW_ALREADY_DECIDED,
      );
    });

    it('同 key 同 payload 重放 ⇒ 返回同一条决定,不产生第二条', async () => {
      const fixture = await createReviewable();
      const input = reviewInput(fixture);
      const first = await service.firstReview(input, firstReviewer, auditMeta);
      const replay = await service.firstReview(input, firstReviewer, auditMeta);

      expect(replay.replayed).toBe(true);
      expect(replay.reviewActionId).toBe(first.reviewActionId);
      await expect(
        prisma.settlementReviewAction.count({ where: { settlementVersionId: fixture.versionId } }),
      ).resolves.toBe(1);
      // 重放路径也留一条 audit(谁又点了一次是运维要能查到的事实)。
      await expect(
        prisma.auditLog.count({ where: { resourceId: fixture.activityId } }),
      ).resolves.toBe(2);
    });

    it('同 key 不同 payload → 20073', async () => {
      const fixture = await createReviewable();
      const input = reviewInput(fixture);
      await service.firstReview(input, firstReviewer, auditMeta);
      await expectBiz(
        service.firstReview({ ...input, requestHash: 'another-hash' }, firstReviewer, auditMeta),
        BizCode.SETTLEMENT_REVIEW_OPERATION_KEY_CONFLICT,
      );
    });

    it('同 key 被用到另一个版本上 → 20073(不按版本收窄)', async () => {
      const fixtureA = await createReviewable();
      const fixtureB = await createReviewable();
      const input = reviewInput(fixtureA);
      await service.firstReview(input, firstReviewer, auditMeta);
      await expectBiz(
        service.firstReview(
          { ...reviewInput(fixtureB), operationKey: input.operationKey },
          firstReviewer,
          auditMeta,
        ),
        BizCode.SETTLEMENT_REVIEW_OPERATION_KEY_CONFLICT,
      );
    });
  });

  // =========================================================================
  // ⑥ 状态闸
  // =========================================================================
  describe('状态闸', () => {
    it.each([
      ['drafting', 'drafting'],
      ['pending_final_review 上做一审', 'pending_final_review'],
      ['posted', 'posted'],
    ])('run 状态 %s ⇒ 一审拒 20065', async (_label, runStatusCode) => {
      const fixture = await createReviewable({ runStatusCode });
      await expectBiz(
        service.firstReview(reviewInput(fixture), firstReviewer, auditMeta),
        BizCode.SETTLEMENT_REVIEW_RUN_STATUS_INVALID,
      );
    });

    it('run 在 pending_first_review ⇒ 终审拒 20065', async () => {
      const fixture = await createReviewable();
      await expectBiz(
        service.finalReview(reviewInput(fixture), finalReviewer, auditMeta),
        BizCode.SETTLEMENT_REVIEW_RUN_STATUS_INVALID,
      );
    });

    it.each([['returned'], ['approved'], ['voided'], ['draft']])(
      '版本状态 %s ⇒ 拒 20066',
      async (versionStatusCode) => {
        const fixture = await createReviewable({ versionStatusCode });
        await expectBiz(
          service.firstReview(reviewInput(fixture), firstReviewer, auditMeta),
          BizCode.SETTLEMENT_REVIEW_VERSION_STATUS_INVALID,
        );
      },
    );

    it('run 没有 currentSubmittedVersion 指针 ⇒ 拒 20067', async () => {
      const fixture = await createReviewable({ withoutSubmittedPointer: true });
      await expectBiz(
        service.firstReview(reviewInput(fixture), firstReviewer, auditMeta),
        BizCode.SETTLEMENT_REVIEW_VERSION_MISSING,
      );
    });

    it('活动不存在 ⇒ ACTIVITY_NOT_FOUND', async () => {
      const fixture = await createReviewable();
      await expectBiz(
        service.firstReview(
          reviewInput(fixture, { activityId: randomUUID() }),
          firstReviewer,
          auditMeta,
        ),
        BizCode.ACTIVITY_NOT_FOUND,
      );
    });
  });

  // =========================================================================
  // ⑦ append-only / 审计 / 通知
  // =========================================================================
  describe('append-only、审计与通知', () => {
    it('SettlementReviewAction 永不被 update —— 退回后重来是新版本,不是改旧动作', async () => {
      const fixture = await createReviewable();
      const returned = await service.firstReview(
        reviewInput(fixture, { actionCode: 'return', returnReason: '重来' }),
        firstReviewer,
        auditMeta,
      );
      const before = await prisma.settlementReviewAction.findUniqueOrThrow({
        where: { id: returned.reviewActionId },
        select: { stageCode: true, actionCode: true, actorUserId: true, actedAt: true },
      });

      // 退回后另开一版(第三刀的语义),再走一次一审。
      const v2 = await prisma.attendanceSettlementVersion.create({
        data: {
          settlementRunId: fixture.runId,
          version: 2,
          evidenceSealId: fixture.sealId,
          evidenceRevision: 0,
          populationRevision: 0,
          workflowRevision: 0,
          contentHash: `${fixture.contentHash}-v2`,
          personCount: 2,
          sessionParticipationCount: 2,
          serviceSegmentCount: 0,
          createdByUserId: submitter.id,
          submittedAt: SEAL_AT,
          statusCode: 'submitted',
          priorVersionId: fixture.versionId,
        },
        select: { id: true },
      });
      await prisma.attendanceSettlementRun.update({
        where: { id: fixture.runId },
        data: { statusCode: 'pending_first_review', currentSubmittedVersion: 2 },
      });
      await service.firstReview(
        reviewInput(fixture, {
          expectation: {
            evidenceSealId: fixture.sealId,
            evidenceRevision: 0,
            populationRevision: 0,
            workflowRevision: 0,
            contentHash: `${fixture.contentHash}-v2`,
          },
        }),
        firstReviewer,
        auditMeta,
      );

      // 旧动作行**逐字未变**,新决定是**另一条行**挂在**另一个版本**上。
      await expect(
        prisma.settlementReviewAction.findUniqueOrThrow({
          where: { id: returned.reviewActionId },
          select: { stageCode: true, actionCode: true, actorUserId: true, actedAt: true },
        }),
      ).resolves.toStrictEqual(before);
      await expect(
        prisma.settlementReviewAction.count({ where: { settlementVersionId: fixture.versionId } }),
      ).resolves.toBe(1);
      await expect(
        prisma.settlementReviewAction.count({ where: { settlementVersionId: v2.id } }),
      ).resolves.toBe(1);
    });

    it('audit 复用 activity.publish 伞事件 + extra.operation,并留下"没有标 posted"的正面证据', async () => {
      const fixture = await createReviewable();
      await advanceToFinalReview(fixture);
      await service.finalReview(reviewInput(fixture), finalReviewer, auditMeta);

      const logs = await prisma.auditLog.findMany({
        where: { resourceId: fixture.activityId },
        orderBy: { createdAt: 'asc' },
        select: { event: true, context: true },
      });
      expect(logs).toHaveLength(2);
      expect(logs.map((log) => log.event)).toStrictEqual(['activity.publish', 'activity.publish']);
      const extras = logs.map((log) => (log.context as { extra: Record<string, unknown> }).extra);
      expect(extras[0]['operation']).toBe('settlement-first-review');
      expect(extras[1]['operation']).toBe('settlement-final-review');
      // 🔴 运维可查的正面证据:终审那条日志里 run 的落点是 posting,批次是 preparing。
      expect(extras[1]['runStatusAfter']).toBe('posting');
      expect(extras[1]['ledgerPostingBatchStatus']).toBe('preparing');
      expect(extras[1]['firstReviewerUserId']).toBe(firstReviewer.id);
    });

    it('通知 intent 在同一事务内:enqueue 之后抛错 ⇒ intent 与动作行一起回滚', async () => {
      const fixture = await createReviewable();
      // audit 排在 enqueue **之后**,所以让它抛错就能证明 enqueue 已经发生过、
      // 却随事务一起消失了。
      jest.spyOn(auditRecorder, 'log').mockRejectedValueOnce(new Error('boom'));

      await expect(
        service.firstReview(reviewInput(fixture), firstReviewer, auditMeta),
      ).rejects.toThrow('boom');

      await expect(
        prisma.notificationOutboxIntent.count({
          where: { eventKey: `settlement-review:${fixture.versionId}:first` },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.settlementReviewAction.count({ where: { settlementVersionId: fixture.versionId } }),
      ).resolves.toBe(0);
      await expect(
        prisma.attendanceSettlementRun.findUniqueOrThrow({
          where: { id: fixture.runId },
          select: { statusCode: true },
        }),
      ).resolves.toStrictEqual({ statusCode: 'pending_first_review' });
    });

    it('通知 intent 的稳定键按 版本 + 阶段 分粒度 —— 一审与终审各一条', async () => {
      const fixture = await createReviewable();
      await advanceToFinalReview(fixture);
      await service.finalReview(reviewInput(fixture), finalReviewer, auditMeta);

      const intents = await prisma.notificationOutboxIntent.findMany({
        where: { aggregateId: fixture.activityId },
        orderBy: { eventKey: 'asc' },
        select: { eventKey: true, destinationRef: true },
      });
      expect(intents).toStrictEqual([
        {
          eventKey: `settlement-review:${fixture.versionId}:final`,
          destinationRef: fixture.ownerMemberId,
        },
        {
          eventKey: `settlement-review:${fixture.versionId}:first`,
          destinationRef: fixture.ownerMemberId,
        },
      ]);
    });
  });

  // =========================================================================
  // ⑧ 与第三刀端到端:真提交 → 真一审 → 真终审
  // =========================================================================
  describe('与第三刀端到端', () => {
    it('第三刀提交出来的版本可以被本刀一审 + 终审,全程无手改状态', async () => {
      const fixture = await createReviewable({ runStatusCode: 'drafting' });
      // 把夹具那条版本改回 draft,让第三刀真的去固化它。
      await prisma.attendanceSettlementVersion.update({
        where: { id: fixture.versionId },
        data: { statusCode: 'draft', submittedAt: null, operationKey: null, requestHash: null },
      });
      await prisma.attendanceSettlementRun.update({
        where: { id: fixture.runId },
        data: { currentSubmittedVersion: null },
      });
      await prisma.participantSettlementResultRevision.createMany({
        data: fixture.identityIds.map((identityId) => ({
          settlementVersionId: fixture.versionId,
          participationIdentityId: identityId,
          revision: 0,
          resultCode: 'present',
          lateFlag: false,
          earlyLeaveFlag: false,
          recognizedServiceHours: 4,
          recognizedContributionPoints: 1.5,
          calculatedServiceHours: 4,
          calculatedContributionPoints: 1.5,
          statusCode: 'draft',
        })),
      });

      const submitted = await submitService.submit(
        {
          activityId: fixture.activityId,
          operationKey: `e2e-submit-${fixture.versionId}`,
          requestHash: 'e2e-submit-hash',
        },
        submitter,
        auditMeta,
      );

      // 审核入参的 expectation 完全取自第三刀的返回值 —— 不手抄、不猜。
      const expectation = {
        evidenceSealId: submitted.evidenceSealId,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: submitted.contentHash,
      };

      const first = await service.firstReview(
        { ...reviewInput(fixture, { expectation }) },
        firstReviewer,
        auditMeta,
      );
      expect(first.settlementVersionId).toBe(submitted.settlementVersionId);
      expect(first.runStatusAfter).toBe('pending_final_review');

      const final = await service.finalReview(
        { ...reviewInput(fixture, { expectation }) },
        finalReviewer,
        auditMeta,
      );
      expect(final.runStatusAfter).toBe('posting');
      expect(final.ledgerPostingBatchStatus).toBe('preparing');
      expect(final.ledgerPostingBatchId).not.toBeNull();
    });
  });
});
