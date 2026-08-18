import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

type MemberUser = {
  memberId: string;
  authHeader: string;
};

type FeedbackSettlementContext = {
  activityId: string;
  tag: string;
  sessionId: string;
  runId: string;
  sealId: string;
  identities: Array<{ memberId: string; identityId: string }>;
  latestVersionId: string;
  latestBatchId: string;
  latestClosureId: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

// 审计刀 6 F4：App 资格/窗口/本人 scope、Admin 身份/统计、并发唯一与 no-audit 闭环。
describe('activity feedbacks F2-F4', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAuth: string;
  let submitterUserId: string;
  let organizationId: string;
  let mainActivityId: string;
  let mainApprovedSheetId: string;
  let notCompletedActivityId: string;
  let boundaryActivityId: string;
  let closedActivityId: string;
  let concurrentActivityId: string;
  let approvedA: MemberUser;
  let approvedB: MemberUser;
  let approvedWithoutFeedback: MemberUser;
  let passWithoutAttendance: MemberUser;
  let waitlistedWithoutAttendance: MemberUser;
  let unrelatedMember: MemberUser;
  let concurrentMember: MemberUser;
  const nonApprovedSheetMembers: Array<{ statusCode: string; user: MemberUser }> = [];

  const feedbackPath = (activityId: string): string =>
    `/api/app/v1/my/activities/${activityId}/feedback`;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const superAdmin = await createTestUser(app, {
      username: 'feedback-super-admin',
      role: Role.SUPER_ADMIN,
    });
    submitterUserId = superAdmin.id;
    adminAuth = (await loginAs(app, 'feedback-super-admin')).authHeader;

    organizationId = (
      await prisma.organization.create({
        data: { name: 'Activity Feedback E2E Org', nodeTypeCode: 'team' },
        select: { id: true },
      })
    ).id;

    approvedA = await createMemberUser('feedback-approved-a', '评价队员 A');
    approvedB = await createMemberUser('feedback-approved-b', '评价队员 B');
    approvedWithoutFeedback = await createMemberUser(
      'feedback-approved-no-submit',
      '已到场未评价队员',
    );
    passWithoutAttendance = await createMemberUser('feedback-pass-only', '仅报名通过');
    waitlistedWithoutAttendance = await createMemberUser('feedback-waitlisted', '仅候补');
    unrelatedMember = await createMemberUser('feedback-unrelated', '无关队员');
    concurrentMember = await createMemberUser('feedback-concurrent', '并发评价队员');

    for (const [suffix, statusCode] of [
      ['pending', 'pending'],
      ['pending-final', 'pending_final_review'],
      ['rejected', 'rejected'],
      ['final-rejected', 'final_rejected'],
    ] as const) {
      nonApprovedSheetMembers.push({
        statusCode,
        user: await createMemberUser(`feedback-${suffix}`, `非终态-${statusCode}`),
      });
    }

    const now = Date.now();
    mainActivityId = await createActivity('评价主活动', 'completed', now - DAY_MS);
    notCompletedActivityId = await createActivity('未完成活动', 'published', now - DAY_MS);
    // 精确等号由 service fake-clock 单测锁死；E2E 留 60 秒执行裕量验证关闭边界仍可写。
    boundaryActivityId = await createActivity(
      '评价窗口边界内活动',
      'completed',
      now - 30 * DAY_MS + 60_000,
    );
    closedActivityId = await createActivity('评价窗口外活动', 'completed', now - 31 * DAY_MS);
    concurrentActivityId = await createActivity('并发评价活动', 'completed', now - DAY_MS);

    await prisma.activityRegistration.createMany({
      data: [
        { activityId: mainActivityId, memberId: approvedA.memberId, statusCode: 'pass' },
        { activityId: mainActivityId, memberId: approvedB.memberId, statusCode: 'pass' },
        {
          activityId: mainActivityId,
          memberId: passWithoutAttendance.memberId,
          statusCode: 'pass',
        },
        {
          activityId: mainActivityId,
          memberId: waitlistedWithoutAttendance.memberId,
          statusCode: 'waitlisted',
        },
      ],
    });

    mainApprovedSheetId = await createAttendanceSheet(mainActivityId, 'approved', [
      approvedA.memberId,
      approvedB.memberId,
    ]);
    await createAttendanceSheet(boundaryActivityId, 'approved', [approvedA.memberId]);
    for (const { statusCode, user } of nonApprovedSheetMembers) {
      await createAttendanceSheet(mainActivityId, statusCode, [user.memberId]);
    }
    await createAttendanceSheet(concurrentActivityId, 'approved', [concurrentMember.memberId]);

    await createFeedbackSettlement({
      activityId: mainActivityId,
      tag: 'feedback-main',
      members: [
        { memberId: approvedA.memberId, resultCode: 'present' },
        { memberId: approvedB.memberId, resultCode: 'present' },
      ],
      closedAt: new Date(now - DAY_MS),
    });
    await createFeedbackSettlement({
      activityId: boundaryActivityId,
      tag: 'feedback-boundary',
      members: [{ memberId: approvedA.memberId, resultCode: 'present' }],
      closedAt: new Date(now - 30 * DAY_MS + 60_000),
    });
    await createFeedbackSettlement({
      activityId: closedActivityId,
      tag: 'feedback-closed',
      members: [],
      closedAt: new Date(now - 31 * DAY_MS),
    });
    await createFeedbackSettlement({
      activityId: concurrentActivityId,
      tag: 'feedback-concurrent',
      members: [{ memberId: concurrentMember.memberId, resultCode: 'present' }],
      closedAt: new Date(now - DAY_MS),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['pass 但无考勤', () => passWithoutAttendance.authHeader],
    ['waitlisted 且无考勤', () => waitlistedWithoutAttendance.authHeader],
    ['无报名无考勤', () => unrelatedMember.authHeader],
  ])('%s 不能提交评价', async (_label, getAuth) => {
    const res = await request(httpServer(app))
      .put(feedbackPath(mainActivityId))
      .set('Authorization', getAuth())
      .send({ rating: 5 });
    expectBizError(res, BizCode.ACTIVITY_FEEDBACK_ATTENDANCE_REQUIRED);
  });

  it('pending / pending_final_review / rejected / final_rejected 均不构成评价资格', async () => {
    for (const { statusCode, user } of nonApprovedSheetMembers) {
      const res = await request(httpServer(app))
        .put(feedbackPath(mainActivityId))
        .set('Authorization', user.authHeader)
        .send({ rating: 5 });
      expectBizError(res, BizCode.ACTIVITY_FEEDBACK_ATTENDANCE_REQUIRED);
      expect(statusCode).not.toBe('approved');
    }
  });

  it('非 completed 活动优先拒绝，窗口关闭边界内可写，closure.closedAt+30+1 天拒绝', async () => {
    const nonCompleted = await request(httpServer(app))
      .put(feedbackPath(notCompletedActivityId))
      .set('Authorization', approvedA.authHeader)
      .send({ rating: 5 });
    expectBizError(nonCompleted, BizCode.ACTIVITY_FEEDBACK_ACTIVITY_NOT_COMPLETED);

    const boundary = await request(httpServer(app))
      .put(feedbackPath(boundaryActivityId))
      .set('Authorization', approvedA.authHeader)
      .send({ rating: 5, comment: '关闭边界内' });
    expect(boundary.status).toBe(200);
    expect(boundary.body.data).toMatchObject({
      feedback: { rating: 5, comment: '关闭边界内' },
      canSubmit: true,
    });

    const closed = await request(httpServer(app))
      .put(feedbackPath(closedActivityId))
      .set('Authorization', approvedA.authHeader)
      .send({ rating: 5 });
    expectBizError(closed, BizCode.ACTIVITY_FEEDBACK_WINDOW_CLOSED);
  });

  it('AC-065 以最新 active closure 为窗口和资格真相，纠错后新增资格且撤销资格保留历史评价', async () => {
    const originallyEligible = await createMemberUser(
      'feedback-correction-original',
      '纠错前有资格队员',
    );
    const newlyEligible = await createMemberUser('feedback-correction-new', '纠错后新增资格队员');
    const activityId = await createActivity(
      '评价结算纠错活动',
      'completed',
      Date.now() - 45 * DAY_MS,
    );
    const firstClosure = await createFeedbackSettlement({
      activityId,
      tag: 'feedback-correction',
      members: [
        { memberId: originallyEligible.memberId, resultCode: 'present' },
        { memberId: newlyEligible.memberId, resultCode: 'absent' },
      ],
      closedAt: new Date(Date.now() - DAY_MS),
    });

    const originalSubmit = await request(httpServer(app))
      .put(feedbackPath(activityId))
      .set('Authorization', originallyEligible.authHeader)
      .send({ rating: 5, comment: '纠错前评价' });
    expect(originalSubmit.status).toBe(200);
    expect(originalSubmit.body.data).toMatchObject({
      feedback: { rating: 5, comment: '纠错前评价', eligibilityCorrected: false },
      canSubmit: true,
    });

    const beforeCorrection = await request(httpServer(app))
      .put(feedbackPath(activityId))
      .set('Authorization', newlyEligible.authHeader)
      .send({ rating: 4 });
    expectBizError(beforeCorrection, BizCode.ACTIVITY_FEEDBACK_ATTENDANCE_REQUIRED);

    const secondClosure = await createFeedbackSettlement({
      activityId,
      tag: 'feedback-correction',
      revision: 2,
      context: firstClosure,
      members: [
        { memberId: originallyEligible.memberId, resultCode: 'absent' },
        { memberId: newlyEligible.memberId, resultCode: 'present' },
      ],
      closedAt: new Date(),
    });

    const historical = await request(httpServer(app))
      .get(feedbackPath(activityId))
      .set('Authorization', originallyEligible.authHeader);
    expect(historical.status).toBe(200);
    expect(historical.body.data).toMatchObject({
      feedback: { rating: 5, comment: '纠错前评价', eligibilityCorrected: true },
      canSubmit: false,
    });

    const correctedSubmit = await request(httpServer(app))
      .put(feedbackPath(activityId))
      .set('Authorization', newlyEligible.authHeader)
      .send({ rating: 4, comment: '纠错后新增资格' });
    expect(correctedSubmit.status).toBe(200);
    expect(correctedSubmit.body.data).toMatchObject({
      feedback: { rating: 4, comment: '纠错后新增资格', eligibilityCorrected: false },
      canSubmit: true,
    });
    expect(secondClosure.latestClosureId).not.toBe(firstClosure.latestClosureId);
    await expect(
      prisma.activityFeedback.count({
        where: { activityId, memberId: originallyEligible.memberId, deletedAt: null },
      }),
    ).resolves.toBe(1);
  });

  it('rating 0/6 与 comment 501 被 DTO 拒绝，1/5 边界可写且 PUT 二次只更新一行', async () => {
    for (const rating of [0, 6]) {
      const invalid = await request(httpServer(app))
        .put(feedbackPath(mainActivityId))
        .set('Authorization', approvedA.authHeader)
        .send({ rating });
      expectBizError(invalid, BizCode.BAD_REQUEST, { strictMessage: false });
    }

    const longComment = await request(httpServer(app))
      .put(feedbackPath(mainActivityId))
      .set('Authorization', approvedA.authHeader)
      .send({ rating: 5, comment: 'x'.repeat(501) });
    expectBizError(longComment, BizCode.BAD_REQUEST, { strictMessage: false });

    const first = await request(httpServer(app))
      .put(feedbackPath(mainActivityId))
      .set('Authorization', approvedA.authHeader)
      .send({ rating: 1, comment: '首次评价' });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      feedback: { rating: 1, comment: '首次评价' },
      canSubmit: true,
    });

    const second = await request(httpServer(app))
      .put(feedbackPath(mainActivityId))
      .set('Authorization', approvedA.authHeader)
      .send({ rating: 5, comment: '更新后评价' });
    expect(second.status).toBe(200);
    expect(second.body.data.feedback).toMatchObject({ rating: 5, comment: '更新后评价' });
    expect(second.body.data.feedback.createdAt).toBe(first.body.data.feedback.createdAt);
    expect(
      await prisma.activityFeedback.count({
        where: { activityId: mainActivityId, memberId: approvedA.memberId, deletedAt: null },
      }),
    ).toBe(1);
  });

  it('GET 始终 200 且只读本人：本人有值，另一 approved 队员先看到 null', async () => {
    const mine = await request(httpServer(app))
      .get(feedbackPath(mainActivityId))
      .set('Authorization', approvedA.authHeader);
    expect(mine.status).toBe(200);
    expect(mine.body.data).toMatchObject({
      feedback: { rating: 5, comment: '更新后评价' },
      canSubmit: true,
    });
    expect(mine.body.data.windowClosesAt).toEqual(expect.any(String));

    const other = await request(httpServer(app))
      .get(feedbackPath(mainActivityId))
      .set('Authorization', approvedB.authHeader);
    expect(other.status).toBe(200);
    expect(other.body.data).toMatchObject({ feedback: null, canSubmit: true });

    const missing = await request(httpServer(app))
      .get(feedbackPath('clmissingfeedbackactivity'))
      .set('Authorization', approvedA.authHeader);
    expectBizError(missing, BizCode.ACTIVITY_NOT_FOUND);
  });

  it('approved 队员评价不写 AuditLog', async () => {
    const beforeAuditCount = await prisma.auditLog.count();
    const res = await request(httpServer(app))
      .put(feedbackPath(mainActivityId))
      .set('Authorization', approvedB.authHeader)
      .send({ rating: 3, comment: null });
    expect(res.status).toBe(200);
    expect(res.body.data.feedback).toMatchObject({ rating: 3, comment: null });
    expect(await prisma.auditLog.count()).toBe(beforeAuditCount);
  });

  it('Admin 列表返回真实队员身份，汇总均分/五桶/评价率口径正确', async () => {
    const list = await request(httpServer(app))
      .get(`/api/admin/v1/activities/${mainActivityId}/feedbacks`)
      .query({ page: 1, pageSize: 20 })
      .set('Authorization', adminAuth);
    expect(list.status).toBe(200);
    expect(list.body.data).toMatchObject({ total: 2, page: 1, pageSize: 20 });
    const items = list.body.data.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberNo: 'feedback-approved-a',
          displayName: '评价队员 A',
          rating: 5,
          comment: '更新后评价',
        }),
        expect.objectContaining({
          memberNo: 'feedback-approved-b',
          displayName: '评价队员 B',
          rating: 3,
          comment: null,
        }),
      ]),
    );
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(
        ['comment', 'createdAt', 'displayName', 'memberNo', 'rating', 'updatedAt'].sort(),
      );
    }

    const summary = await request(httpServer(app))
      .get(`/api/admin/v1/activities/${mainActivityId}/feedback-summary`)
      .set('Authorization', adminAuth);
    expect(summary.status).toBe(200);
    expect(summary.body.data).toEqual({
      count: 2,
      avgRating: 4,
      ratingDistribution: [
        { rating: 1, count: 0 },
        { rating: 2, count: 0 },
        { rating: 3, count: 1 },
        { rating: 4, count: 0 },
        { rating: 5, count: 1 },
      ],
      feedbackRate: 1,
    });
  });

  it('终审撤回后分母取当前 approved 与历史评价 member 去重并集，feedbackRate 恒不超过 1', async () => {
    await createAttendanceSheet(mainActivityId, 'approved', [approvedWithoutFeedback.memberId]);

    const reopened = await request(httpServer(app))
      .post(`/api/admin/v1/attendance-sheets/${mainApprovedSheetId}/reopen`)
      .set('Authorization', adminAuth)
      .send({ reason: '第四轮 review 评价率口径回归' });
    expect(reopened.status).toBe(200);
    expect(reopened.body.data.statusCode).toBe('pending');

    const currentApprovedMembers = await prisma.attendanceRecord.findMany({
      where: {
        deletedAt: null,
        sheet: { activityId: mainActivityId, statusCode: 'approved', deletedAt: null },
      },
      select: { memberId: true },
      distinct: ['memberId'],
    });
    const submittedFeedbackMembers = await prisma.activityFeedback.findMany({
      where: { activityId: mainActivityId, deletedAt: null },
      select: { memberId: true },
      distinct: ['memberId'],
    });
    expect(currentApprovedMembers.map((row) => row.memberId)).toEqual([
      approvedWithoutFeedback.memberId,
    ]);
    expect(submittedFeedbackMembers).toHaveLength(2);

    const summary = await request(httpServer(app))
      .get(`/api/admin/v1/activities/${mainActivityId}/feedback-summary`)
      .set('Authorization', adminAuth);
    expect(summary.status).toBe(200);
    expect(summary.body.data).toMatchObject({ count: 2, avgRating: 4, feedbackRate: 0.6667 });
    expect(summary.body.data.feedbackRate).toBeLessThanOrEqual(1);
  });

  it('participation-summary.feedback 与 feedback-summary 聚合严格一致', async () => {
    const [participation, feedback] = await Promise.all([
      request(httpServer(app))
        .get(`/api/admin/v1/activities/${mainActivityId}/participation-summary`)
        .set('Authorization', adminAuth),
      request(httpServer(app))
        .get(`/api/admin/v1/activities/${mainActivityId}/feedback-summary`)
        .set('Authorization', adminAuth),
    ]);
    expect(participation.status).toBe(200);
    expect(feedback.status).toBe(200);
    expect(participation.body.data.feedback).toEqual({
      count: feedback.body.data.count,
      avgRating: feedback.body.data.avgRating,
    });
  });

  it('同人同活动并发 PUT 只留一条 live row，竞态失败只映射冻结码 35002', async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        request(httpServer(app))
          .put(feedbackPath(concurrentActivityId))
          .set('Authorization', concurrentMember.authHeader)
          .send({ rating: index % 5 === 0 ? 5 : index % 5, comment: `并发-${index}` }),
      ),
    );

    expect(responses.some((res) => res.status === 200)).toBe(true);
    for (const res of responses) {
      expect([200, 409]).toContain(res.status);
      if (res.status === 409) {
        expectBizError(res, BizCode.ACTIVITY_FEEDBACK_ALREADY_EXISTS);
      }
    }
    expect(
      await prisma.activityFeedback.count({
        where: {
          activityId: concurrentActivityId,
          memberId: concurrentMember.memberId,
          deletedAt: null,
        },
      }),
    ).toBe(1);
  });

  async function createFeedbackSettlement(options: {
    activityId: string;
    tag: string;
    members: Array<{ memberId: string; resultCode: 'present' | 'absent' }>;
    closedAt: Date;
    revision?: number;
    context?: FeedbackSettlementContext;
  }): Promise<FeedbackSettlementContext> {
    const revision = options.revision ?? 1;
    const activity = await prisma.activity.findUniqueOrThrow({
      where: { id: options.activityId },
      select: { startAt: true, endAt: true, location: true },
    });
    let context = options.context;

    if (context === undefined) {
      const session = await prisma.activitySession.create({
        data: {
          activityId: options.activityId,
          code: `${options.tag}-session`,
          name: `${options.tag}-session`,
          startAt: activity.startAt,
          endAt: activity.endAt,
          locationText: activity.location,
          checkInOpenAt: new Date(activity.startAt.getTime() - 60 * 60 * 1000),
          checkInCloseAt: new Date(activity.startAt.getTime() + 60 * 60 * 1000),
          checkOutOpenAt: new Date(activity.endAt.getTime() - 60 * 60 * 1000),
          checkOutCloseAt: new Date(activity.endAt.getTime() + 60 * 60 * 1000),
          locationRequired: false,
          locationPolicySourceCode: 'activity',
          statusCode: 'scheduled',
        },
        select: { id: true },
      });
      const identities: FeedbackSettlementContext['identities'] = [];
      for (const member of options.members) {
        let registration = await prisma.activityRegistration.findFirst({
          where: { activityId: options.activityId, memberId: member.memberId },
          select: { id: true },
        });
        registration ??= await prisma.activityRegistration.create({
          data: {
            activityId: options.activityId,
            memberId: member.memberId,
            statusCode: 'pass',
          },
          select: { id: true },
        });
        const identity = await prisma.activityParticipationIdentity.create({
          data: {
            activityId: options.activityId,
            sessionId: session.id,
            registrationId: registration.id,
            memberId: member.memberId,
            currentStatusCode: 'pass',
            populationIncluded: true,
          },
          select: { id: true },
        });
        identities.push({ memberId: member.memberId, identityId: identity.id });
      }
      const seal = await prisma.evidenceSeal.create({
        data: {
          activityId: options.activityId,
          sealRevision: 1,
          evidenceRevision: 0,
          populationRevision: 0,
          workflowRevision: 0,
          allWindowsClosedAt: activity.endAt,
          openSegmentCount: 0,
          manualReviewPendingCount: 0,
          populationCountDistinct: identities.length,
          populationCountBySession: { [session.id]: identities.length },
          contentHash: `${options.tag}-seal`,
          statusCode: 'active',
          sealedByUserId: submitterUserId,
          sealedAt: activity.endAt,
        },
        select: { id: true },
      });
      const run = await prisma.attendanceSettlementRun.create({
        data: { activityId: options.activityId, statusCode: 'closed' },
        select: { id: true },
      });
      context = {
        activityId: options.activityId,
        tag: options.tag,
        sessionId: session.id,
        runId: run.id,
        sealId: seal.id,
        identities,
        latestVersionId: '',
        latestBatchId: '',
        latestClosureId: '',
      };
    } else {
      await prisma.activitySettlementClosureRevision.update({
        where: { id: context.latestClosureId },
        data: { statusCode: 'superseded', supersededAt: options.closedAt },
      });
    }

    const version = await prisma.attendanceSettlementVersion.create({
      data: {
        settlementRunId: context.runId,
        version: revision,
        evidenceSealId: context.sealId,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: `${options.tag}-version-${revision}`,
        personCount: context.identities.length,
        sessionParticipationCount: context.identities.length,
        serviceSegmentCount: options.members.filter((member) => member.resultCode === 'present')
          .length,
        createdByUserId: submitterUserId,
        submittedAt: options.closedAt,
        statusCode: 'approved',
        priorVersionId: context.latestVersionId || null,
        operationKey: `${options.tag}-version-${revision}`,
        requestHash: `${options.tag}-version-${revision}-hash`,
      },
      select: { id: true },
    });
    const batch = await prisma.ledgerPostingBatch.create({
      data: {
        settlementRunId: context.runId,
        settlementVersionId: version.id,
        batchRevision: revision,
        statusCode: 'committed',
        requestKey: `${options.tag}-batch-${revision}`,
        requestHash: `${options.tag}-batch-${revision}-hash`,
        preparedCount: options.members.length,
        totalCount: options.members.length,
        preparedAt: options.closedAt,
        committedAt: options.closedAt,
        preparedByUserId: submitterUserId,
        committedByUserId: submitterUserId,
      },
      select: { id: true },
    });
    const resultCounts: Record<string, number> = {};
    for (const member of options.members) {
      const identity = context.identities.find((row) => row.memberId === member.memberId);
      if (identity === undefined) throw new Error(`缺少结算身份:${member.memberId}`);
      resultCounts[member.resultCode] = (resultCounts[member.resultCode] ?? 0) + 1;
      const result = await prisma.participantSettlementResultRevision.create({
        data: {
          settlementVersionId: version.id,
          participationIdentityId: identity.identityId,
          revision,
          resultCode: member.resultCode,
          recognizedServiceHours: member.resultCode === 'present' ? 1 : 0,
          recognizedContributionPoints: 0,
          calculatedServiceHours: member.resultCode === 'present' ? 1 : 0,
          calculatedContributionPoints: 0,
          statusCode: 'committed',
        },
        select: { id: true },
      });
      if (member.resultCode === 'present') {
        await prisma.participationLedgerEntry.create({
          data: {
            postingBatchId: batch.id,
            entryKey: `${options.tag}:v${revision}:${member.memberId}:service`,
            operationKey: `${options.tag}:v${revision}:${member.memberId}:service:operation`,
            memberId: member.memberId,
            activityId: options.activityId,
            sessionId: context.sessionId,
            participationIdentityId: identity.identityId,
            resultRevisionId: result.id,
            ledgerDate: new Date(
              Date.UTC(
                activity.endAt.getUTCFullYear(),
                activity.endAt.getUTCMonth(),
                activity.endAt.getUTCDate(),
              ),
            ),
            entryTypeCode: 'service_credit',
            serviceHoursDelta: 1,
            recognizedPointsDelta: 0,
            creditedPointsDelta: 0,
            cappedOutPointsDelta: 0,
          },
        });
      }
    }
    const closure = await prisma.activitySettlementClosureRevision.create({
      data: {
        activityId: options.activityId,
        revision,
        settlementVersionId: version.id,
        postingBatchId: batch.id,
        evidenceSealId: context.sealId,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        personCount: context.identities.length,
        sessionParticipationCount: context.identities.length,
        resultCountsJson: resultCounts,
        serviceHours: options.members.filter((member) => member.resultCode === 'present').length,
        contributionPoints: 0,
        checksHash: `${options.tag}-closure-${revision}`,
        checksJson: { schemaVersion: 1, checks: [] },
        statusCode: 'active',
        closedByUserId: submitterUserId,
        closedAt: options.closedAt,
      },
      select: { id: true },
    });
    await Promise.all([
      prisma.activity.update({
        where: { id: options.activityId },
        data: { currentClosureRevision: revision },
      }),
      prisma.attendanceSettlementRun.update({
        where: { id: context.runId },
        data: {
          statusCode: 'closed',
          currentSubmittedVersion: revision,
          currentPostedVersion: revision,
          currentClosureRevision: revision,
        },
      }),
    ]);
    return {
      ...context,
      latestVersionId: version.id,
      latestBatchId: batch.id,
      latestClosureId: closure.id,
    };
  }

  async function createMemberUser(username: string, displayName: string): Promise<MemberUser> {
    const member = await prisma.member.create({
      data: { memberNo: username, displayName },
      select: { id: true },
    });
    const user = await createTestUser(app, { username, role: Role.USER });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    return { memberId: member.id, authHeader: (await loginAs(app, username)).authHeader };
  }

  async function createActivity(
    title: string,
    statusCode: string,
    endAtMs: number,
  ): Promise<string> {
    return (
      await prisma.activity.create({
        data: {
          title,
          activityTypeCode: 'feedback-e2e-type',
          organizationId,
          startAt: new Date(endAtMs - 2 * 60 * 60 * 1000),
          endAt: new Date(endAtMs),
          location: '评价测试地点',
          statusCode,
        },
        select: { id: true },
      })
    ).id;
  }

  async function createAttendanceSheet(
    activityId: string,
    statusCode: string,
    memberIds: string[],
  ): Promise<string> {
    const sheet = await prisma.attendanceSheet.create({
      data: { activityId, submitterUserId, statusCode },
      select: { id: true },
    });
    await prisma.attendanceRecord.createMany({
      data: memberIds.map((memberId, index) => ({
        sheetId: sheet.id,
        memberId,
        roleCode: 'member',
        checkInAt: new Date(Date.now() - (index + 3) * 60 * 60 * 1000),
        checkOutAt: new Date(Date.now() - (index + 2) * 60 * 60 * 1000),
        serviceHours: '1',
        attendanceStatusCode: 'present',
        contributionPoints: '1',
      })),
    });
    return sheet.id;
  }
});
