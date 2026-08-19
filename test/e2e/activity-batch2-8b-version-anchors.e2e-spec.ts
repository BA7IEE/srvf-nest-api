import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode, type BizCodeEntry } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityClosureService } from '../../src/modules/activities/activity-closure.service';
import type { SettlementReviewExpectation } from '../../src/modules/activities/settlement-review-comparison';
import { SettlementReviewService } from '../../src/modules/activities/settlement-review.service';
import { SettlementSubmitService } from '../../src/modules/activities/settlement-submit.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// ===== 第 2 批第 ⑧b 刀:§6.14 HTTP 版本锚点 =====
//
// 这不是“在 Controller 里先 GET 一遍”的测试。每个 case 都先读取客户端会看到的锚点,
// 由 blocker 事务攥住 Activity 行锁，再启动 service 并用 pg_stat_activity 正面证明它
// 真在等既有第一把锁；只有**此后**才切 run 指针。只有 service 在既有事务、既有锁之后
// 重读并比对，才能拒绝“预查时对、取得锁时已不对”的请求。
//
// 初次加入时三条均应 RED：服务仅收 operationKey/requestHash，因而会忽略可选锚点。
// 后续实现不得把检查搬回锁外，否则这条真实竞争仍会让服务处理另一版本，无法证明
// TOCTOU 已被堵住。

const PAST_START = new Date('2020-03-01T01:00:00.000Z');
const PAST_END = new Date('2020-03-01T05:00:00.000Z');
const SEALED_AT = new Date('2020-03-01T09:00:00.000Z');

/**
 * `workflowRevision` 是三项 service 的 `lockActivity*` 查询共同携带的列。只统计既在
 * 当前测试库、又实际等锁的 FOR UPDATE 查询，避免把“Promise 已发出”误当作拿到锁。
 */
async function waitForSettlementActivityLockWaiters(
  observer: PrismaService,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  let observed = 0;
  while (Date.now() < deadline) {
    const [row] = await observer.$queryRaw<Array<{ waitingCount: number }>>`
      SELECT count(*)::int AS "waitingCount"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query LIKE '%workflowRevision%'
        AND query LIKE '%FOR UPDATE%'
    `;
    observed = row?.waitingCount ?? 0;
    if (observed >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `expected at least ${expected} settlement Activity row-lock waiter(s), saw ${observed}`,
  );
}

describe('第 2 批第 ⑧b 刀 —— 结算 HTTP 版本锚点必须在锁内复核', () => {
  let app: INestApplication;
  let observerApp: INestApplication;
  let prisma: PrismaService;
  let observer: PrismaService;
  let submit: SettlementSubmitService;
  let reviews: SettlementReviewService;
  let closure: ActivityClosureService;
  let actor: CurrentUserPayload;
  let organizationId: string;
  let sequence = 0;

  const auditMeta = { requestId: 'activity-batch2-8b-anchor-e2e', ip: null, ua: null };

  beforeAll(async () => {
    // 第 7 批第 ③ 刀 —— 活动 v1.1 单一 cutover gate(合同 §16.2)。本 spec 驱动的是
    // **结算真相链**(打卡 / 封场 / 结算 / 账本 / 关账 / 更正),那条链按定义只在闸开时存在;
    // 闸关(默认 = 今天的行为)时这些写入口一律回 20153。故此处显式置真,
    // **断言一字未改** —— 改的只是这个 spec 声明自己跑在哪一侧闸。
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    observerApp = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    observer = observerApp.get(PrismaService);
    submit = app.get(SettlementSubmitService);
    reviews = app.get(SettlementReviewService);
    closure = app.get(ActivityClosureService);

    const user = await createTestUser(app, {
      username: 'activity-batch2-8b-anchor-actor',
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
      data: { name: '第 ⑧b 刀锚点测试组织', nodeTypeCode: 'activity-batch2-8b-anchor-team' },
      select: { id: true },
    });
    organizationId = organization.id;
  });

  afterAll(async () => {
    delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    await Promise.all([app.close(), observerApp.close()]);
  });

  async function createActivityAndSeal(label: string) {
    sequence += 1;
    const tag = `batch2-8b-anchor-${label}-${sequence}`;
    const activity = await prisma.activity.create({
      data: {
        title: `第 ⑧b 刀锚点活动 ${sequence}`,
        activityTypeCode: `${tag}-type`,
        organizationId,
        startAt: PAST_START,
        endAt: PAST_END,
        location: '深圳',
        statusCode: 'published',
      },
      select: { id: true },
    });
    const seal = await prisma.evidenceSeal.create({
      data: {
        activityId: activity.id,
        sealRevision: 1,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        allWindowsClosedAt: SEALED_AT,
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: 0,
        populationCountBySession: {},
        contentHash: `${tag}-seal-hash`,
        statusCode: 'active',
        sealedByUserId: actor.id,
        sealedAt: SEALED_AT,
      },
      select: { id: true },
    });
    return { tag, activityId: activity.id, sealId: seal.id };
  }

  async function createVersion(
    settlementRunId: string,
    version: number,
    sealId: string,
    tag: string,
    statusCode: 'draft' | 'submitted' | 'approved',
  ) {
    return await prisma.attendanceSettlementVersion.create({
      data: {
        settlementRunId,
        version,
        evidenceSealId: sealId,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: `${tag}-content-${version}`,
        personCount: 0,
        sessionParticipationCount: 0,
        serviceSegmentCount: 0,
        createdByUserId: null,
        submittedAt: SEALED_AT,
        statusCode,
        operationKey: `${tag}-version-${version}`,
        requestHash: `${tag}-version-${version}-hash`,
      },
      select: { id: true, version: true, contentHash: true },
    });
  }

  async function expectBizReject(promise: Promise<unknown>, expected: BizCodeEntry): Promise<void> {
    const error = await promise.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(BizException);
    expect((error as BizException).biz).toBe(expected);
  }

  /**
   * 让 action 确实卡在 Activity 行锁上之后，才切当前版本指针。
   *
   * 这条时序是判据本体：若把锚点检查挪到 service 事务外／锁前，它会在 v1 时通过，
   * 随后拿锁并处理 v2；这里必须在放闸后从锁内读取到 v2 并拒绝客户端带来的 v1。
   */
  async function runAfterCurrentPointerChanges<T>(
    activityId: string,
    startAction: () => Promise<T>,
    changeCurrentPointer: () => Promise<void>,
  ): Promise<T> {
    let signalReady!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = observer.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${activityId} FOR UPDATE`;
      signalReady();
      await gate;
    });
    await ready;

    let action: Promise<T> | undefined;
    try {
      action = startAction();
      // 失败也留给下面的 await 统一断言，避免在 waiter 的短窗口报 unhandled rejection。
      void action.catch(() => undefined);
      await waitForSettlementActivityLockWaiters(observer, 1);
      await changeCurrentPointer();
      release();
      await blocker;
      return await action;
    } catch (error) {
      release();
      await Promise.allSettled([blocker, action ?? Promise.resolve()]);
      throw error;
    }
  }

  it('提交: 锁外预查看到 draft v1、取得既有锁后变为 v2，必须拒绝 v1 锚点', async () => {
    const fixture = await createActivityAndSeal('submit');
    const run = await prisma.attendanceSettlementRun.create({
      data: { activityId: fixture.activityId, statusCode: 'drafting', currentDraftVersion: 1 },
      select: { id: true },
    });
    const v1 = await createVersion(run.id, 1, fixture.sealId, fixture.tag, 'draft');

    // 模拟客户端在锁外读工作台时得到 v1。
    const precheck = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: v1.id },
      select: { version: true, evidenceSealId: true },
    });
    expect(precheck).toEqual({ version: 1, evidenceSealId: fixture.sealId });

    await expectBizReject(
      runAfterCurrentPointerChanges(
        fixture.activityId,
        () =>
          submit.submit(
            {
              activityId: fixture.activityId,
              operationKey: `${fixture.tag}-submit`,
              requestHash: `${fixture.tag}-submit-hash`,
              expectedDraftVersion: precheck.version,
              expectedEvidenceSealId: precheck.evidenceSealId,
            },
            actor,
            auditMeta,
          ),
        async () => {
          await createVersion(run.id, 2, fixture.sealId, fixture.tag, 'draft');
          await prisma.attendanceSettlementRun.update({
            where: { id: run.id },
            data: { currentDraftVersion: 2 },
          });
        },
      ),
      BizCode.SETTLEMENT_SUBMIT_EXPECTED_DRAFT_VERSION_MISMATCH,
    );
  });

  it('审核: 锁外预查看到 submitted v1、取得 Activity → Run → Version 锁后指针已转 v2，必须拒绝', async () => {
    const fixture = await createActivityAndSeal('review');
    const run = await prisma.attendanceSettlementRun.create({
      data: {
        activityId: fixture.activityId,
        statusCode: 'pending_first_review',
        currentSubmittedVersion: 1,
      },
      select: { id: true },
    });
    const v1 = await createVersion(run.id, 1, fixture.sealId, fixture.tag, 'submitted');
    const precheck = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: v1.id },
      select: { id: true },
    });

    const expectation: SettlementReviewExpectation = {
      evidenceSealId: fixture.sealId,
      evidenceRevision: 0,
      populationRevision: 0,
      workflowRevision: 0,
      // createVersion 的 v2 canonical contentHash；v2 必须等 action 已经卡在 Activity 锁后
      // 才实际插入，不能提前造一行让锁外预查也看得到。
      contentHash: `${fixture.tag}-content-2`,
    };

    await expectBizReject(
      runAfterCurrentPointerChanges(
        fixture.activityId,
        () =>
          reviews.firstReview(
            {
              activityId: fixture.activityId,
              actionCode: 'approve',
              operationKey: `${fixture.tag}-first-review`,
              requestHash: `${fixture.tag}-first-review-hash`,
              expectation,
              expectedSettlementVersionId: precheck.id,
            },
            actor,
            auditMeta,
          ),
        async () => {
          await createVersion(run.id, 2, fixture.sealId, fixture.tag, 'submitted');
          await prisma.attendanceSettlementRun.update({
            where: { id: run.id },
            data: { currentSubmittedVersion: 2 },
          });
        },
      ),
      BizCode.SETTLEMENT_REVIEW_EXPECTED_VERSION_MISMATCH,
    );
  });

  it('关账: 锁外预查看到 posted v1/batch1、取得既有锁后已切 v2/batch2，必须拒绝', async () => {
    const fixture = await createActivityAndSeal('close');
    const run = await prisma.attendanceSettlementRun.create({
      data: { activityId: fixture.activityId, statusCode: 'posted', currentPostedVersion: 1 },
      select: { id: true },
    });
    const v1 = await createVersion(run.id, 1, fixture.sealId, fixture.tag, 'approved');
    const batch1 = await prisma.ledgerPostingBatch.create({
      data: {
        settlementRunId: run.id,
        settlementVersionId: v1.id,
        batchRevision: 1,
        statusCode: 'committed',
        requestKey: `${fixture.tag}-batch-1`,
        requestHash: `${fixture.tag}-batch-1-hash`,
        totalCount: 0,
      },
      select: { id: true },
    });
    const precheck = { settlementVersionId: v1.id, postingBatchId: batch1.id };

    await expectBizReject(
      runAfterCurrentPointerChanges(
        fixture.activityId,
        () =>
          closure.close(
            fixture.activityId,
            {
              operationKey: `${fixture.tag}-close`,
              requestHash: `${fixture.tag}-close-hash`,
              expectedSettlementVersionId: precheck.settlementVersionId,
              expectedPostingBatchId: precheck.postingBatchId,
            },
            actor,
            auditMeta,
          ),
        async () => {
          const v2 = await createVersion(run.id, 2, fixture.sealId, fixture.tag, 'approved');
          await prisma.ledgerPostingBatch.create({
            data: {
              settlementRunId: run.id,
              settlementVersionId: v2.id,
              batchRevision: 1,
              statusCode: 'committed',
              requestKey: `${fixture.tag}-batch-2`,
              requestHash: `${fixture.tag}-batch-2-hash`,
              totalCount: 0,
            },
          });
          await prisma.attendanceSettlementRun.update({
            where: { id: run.id },
            data: { currentPostedVersion: 2 },
          });
        },
      ),
      BizCode.ACTIVITY_CLOSURE_EXPECTED_SETTLEMENT_VERSION_MISMATCH,
    );
  });
});
