import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import request from 'supertest';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import {
  SettlementReviewService,
  type SettlementReviewInput,
} from '../../src/modules/activities/settlement-review.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// ===== 第 2 批第 ⑩ 刀:结算审核 ActionConstraint 双层闸 =====
//
// 🔴 两道闸都守三方分离，但本 spec 不接受“锁后层替入口层擦屁股”的假绿：
//
// - 入口层两例把 SettlementReviewService 设为会抛错的哨兵。HTTP 仍须在调用 service
//   前返回领域码；摘掉 ACTION_CONSTRAINTS 时，这两例必红。
// - 锁后层一例直接调用 SettlementReviewService，根本不经过 Authz。把
//   evaluateSettlementReviewSeparation 短路时，这一例必红。
//
// 因而两次变异的红集不重叠：入口注册缺席只红“入口层独立”，锁后复判缺席只红“锁后层独立”。

const PAST_START = new Date('2020-03-01T01:00:00.000Z');
const PAST_END = new Date('2020-03-01T05:00:00.000Z');
const SEALED_AT = new Date('2020-03-01T09:00:00.000Z');

interface HttpActor extends CurrentUserPayload {
  authHeader: string;
}

interface SubmittedFixture {
  activityId: string;
  settlementVersionId: string;
  expectation: {
    evidenceSealId: string;
    evidenceRevision: number;
    populationRevision: number;
    workflowRevision: number;
    contentHash: string;
  };
}

describe('第 2 批第 ⑩ 刀 —— 结算审核 ActionConstraint 双层独立性', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reviews: SettlementReviewService;
  let organizationId: string;
  let sequence = 0;

  const auditMeta = { requestId: 'activity-batch2-10', ip: null, ua: null };

  beforeAll(async () => {
    // 第 7 批第 ③ 刀 —— 活动 v1.1 单一 cutover gate(合同 §16.2)。本 spec 驱动的是
    // **结算真相链**(打卡 / 封场 / 结算 / 账本 / 关账 / 更正),那条链按定义只在闸开时存在;
    // 闸关(默认 = 今天的行为)时这些写入口一律回 20153。故此处显式置真,
    // **断言一字未改** —— 改的只是这个 spec 声明自己跑在哪一侧闸。
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    reviews = app.get(SettlementReviewService);
    const organization = await prisma.organization.create({
      data: { name: '第 ⑩ 刀双层闸组织', nodeTypeCode: 'activity-batch2-10-team' },
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

  async function createActor(label: string): Promise<HttpActor> {
    sequence += 1;
    const username = `b10-${label}-${sequence}`;
    const user = await createTestUser(app, { username, role: Role.SUPER_ADMIN });
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      status: UserStatus.ACTIVE,
      memberId: null,
      authHeader: (await loginAs(app, username)).authHeader,
    };
  }

  async function createSubmittedFixture(submittedByUserId: string): Promise<SubmittedFixture> {
    sequence += 1;
    const tag = `batch2-10-${sequence}`;
    const activity = await prisma.activity.create({
      data: {
        title: `第 ⑩ 刀结算审核活动 ${sequence}`,
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
        sealedByUserId: submittedByUserId,
        sealedAt: SEALED_AT,
      },
      select: { id: true },
    });
    const run = await prisma.attendanceSettlementRun.create({
      data: {
        activityId: activity.id,
        statusCode: 'pending_first_review',
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
        contentHash: `${tag}-content-hash`,
        personCount: 0,
        sessionParticipationCount: 0,
        serviceSegmentCount: 0,
        createdByUserId: submittedByUserId,
        submittedAt: SEALED_AT,
        statusCode: 'submitted',
        operationKey: `${tag}-submit`,
        requestHash: `${tag}-submit-hash`,
      },
      select: { id: true, contentHash: true },
    });
    return {
      activityId: activity.id,
      settlementVersionId: version.id,
      expectation: {
        evidenceSealId: seal.id,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: version.contentHash,
      },
    };
  }

  async function httpReview(
    fixture: SubmittedFixture,
    stage: 'first' | 'final',
    action: 'approve' | 'return',
    actor: HttpActor,
    operationKey: string,
  ) {
    return request(httpServer(app))
      .post(
        `/api/admin/v1/attendance-settlements/${fixture.settlementVersionId}/${stage}-${action}`,
      )
      .set('Authorization', actor.authHeader)
      .send({
        operationKey,
        ...fixture.expectation,
        ...(action === 'return' ? { note: '第 ⑩ 刀退回理由' } : {}),
      });
  }

  function reviewInput(
    fixture: SubmittedFixture,
    actionCode: 'approve' | 'return' = 'approve',
  ): SettlementReviewInput {
    sequence += 1;
    return {
      activityId: fixture.activityId,
      actionCode,
      operationKey: `batch2-10-direct-${sequence}`,
      requestHash: `batch2-10-direct-hash-${sequence}`,
      ...(actionCode === 'return' ? { returnReason: '第 ⑩ 刀直接调用退回理由' } : {}),
      expectation: fixture.expectation,
      expectedSettlementVersionId: fixture.settlementVersionId,
    };
  }

  async function expectDirectBiz(
    promise: Promise<unknown>,
    code: (typeof BizCode)[keyof typeof BizCode],
  ): Promise<void> {
    await expect(promise).rejects.toBeInstanceOf(BizException);
    await promise.catch((error: unknown) => {
      expect(error).toBeInstanceOf(BizException);
      expect((error as BizException).biz).toBe(code);
    });
  }

  it('入口层独立：一审 approve / return 共用 action，提交人均在调用锁后 service 前得到 20062', async () => {
    const submitter = await createActor('entry-first-submitter');
    const fixture = await createSubmittedFixture(submitter.id);
    const serviceSentinel = jest
      .spyOn(reviews, 'firstReview')
      .mockRejectedValue(new Error('入口层未拒绝就不应到达锁后 service'));

    const approve = await httpReview(fixture, 'first', 'approve', submitter, 'entry-first-approve');
    expectBizError(approve, BizCode.SETTLEMENT_SELF_FIRST_REVIEW_FORBIDDEN);
    const returned = await httpReview(fixture, 'first', 'return', submitter, 'entry-first-return');
    expectBizError(returned, BizCode.SETTLEMENT_SELF_FIRST_REVIEW_FORBIDDEN);
    expect(serviceSentinel).not.toHaveBeenCalled();
  });

  it('入口层独立：终审 approve / return 共用 action，提交人和一审人均在调用锁后 service 前得到具名码', async () => {
    const submitter = await createActor('entry-final-submitter');
    const firstReviewer = await createActor('entry-final-first-reviewer');
    const selfFixture = await createSubmittedFixture(submitter.id);
    const sameReviewerFixture = await createSubmittedFixture(submitter.id);

    const selfPrepared = await httpReview(
      selfFixture,
      'first',
      'approve',
      firstReviewer,
      'entry-self-final-prepare',
    );
    expect(selfPrepared.status).toBe(200);
    const sameReviewerPrepared = await httpReview(
      sameReviewerFixture,
      'first',
      'approve',
      firstReviewer,
      'entry-same-final-prepare',
    );
    expect(sameReviewerPrepared.status).toBe(200);

    const serviceSentinel = jest
      .spyOn(reviews, 'finalReview')
      .mockRejectedValue(new Error('入口层未拒绝就不应到达锁后 service'));

    const selfApprove = await httpReview(
      selfFixture,
      'final',
      'approve',
      submitter,
      'entry-self-final-approve',
    );
    expectBizError(selfApprove, BizCode.SETTLEMENT_SELF_FINAL_REVIEW_FORBIDDEN);
    const selfReturn = await httpReview(
      selfFixture,
      'final',
      'return',
      submitter,
      'entry-self-final-return',
    );
    expectBizError(selfReturn, BizCode.SETTLEMENT_SELF_FINAL_REVIEW_FORBIDDEN);

    const sameApprove = await httpReview(
      sameReviewerFixture,
      'final',
      'approve',
      firstReviewer,
      'entry-same-final-approve',
    );
    expectBizError(sameApprove, BizCode.SETTLEMENT_SAME_REVIEWER_FORBIDDEN);
    const sameReturn = await httpReview(
      sameReviewerFixture,
      'final',
      'return',
      firstReviewer,
      'entry-same-final-return',
    );
    expectBizError(sameReturn, BizCode.SETTLEMENT_SAME_REVIEWER_FORBIDDEN);
    expect(serviceSentinel).not.toHaveBeenCalled();
  });

  it('锁后层独立：直接调用 service 时，三方分离仍按 20062 / 20063 / 20064 拒绝', async () => {
    const submitter = await createActor('locked-submitter');
    const firstReviewer = await createActor('locked-first-reviewer');
    const selfFirstFixture = await createSubmittedFixture(submitter.id);
    const selfFinalFixture = await createSubmittedFixture(submitter.id);
    const sameReviewerFixture = await createSubmittedFixture(submitter.id);

    await expectDirectBiz(
      reviews.firstReview(reviewInput(selfFirstFixture), submitter, auditMeta),
      BizCode.SETTLEMENT_SELF_FIRST_REVIEW_FORBIDDEN,
    );

    await reviews.firstReview(reviewInput(selfFinalFixture), firstReviewer, auditMeta);
    await expectDirectBiz(
      reviews.finalReview(reviewInput(selfFinalFixture), submitter, auditMeta),
      BizCode.SETTLEMENT_SELF_FINAL_REVIEW_FORBIDDEN,
    );

    await reviews.firstReview(reviewInput(sameReviewerFixture), firstReviewer, auditMeta);
    await expectDirectBiz(
      reviews.finalReview(reviewInput(sameReviewerFixture), firstReviewer, auditMeta),
      BizCode.SETTLEMENT_SAME_REVIEWER_FORBIDDEN,
    );
  });
});
