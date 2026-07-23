import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityPublishReviewService } from '../../src/modules/activities/activity-publish-review.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

async function waitForActivityLockWaiters(prisma: PrismaService, expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ waitingCount: number }>>`
      SELECT count(*)::int AS "waitingCount"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query LIKE '%SELECT id FROM "Activity"%'
    `;
    if ((row?.waitingCount ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected at least ${expected} Activity row-lock waiter(s)`);
}

describe('activity publish review multi-instance concurrency', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let reviewServiceA: ActivityPublishReviewService;
  let reviewServiceB: ActivityPublishReviewService;
  let reviewer: CurrentUserPayload;
  let creator: CurrentUserPayload;
  let organizationId: string;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    reviewServiceA = appA.get(ActivityPublishReviewService);
    reviewServiceB = appB.get(ActivityPublishReviewService);

    const reviewerUser = await createTestUser(appA, {
      username: 'activity-review-concurrency-reviewer',
      role: Role.SUPER_ADMIN,
    });
    reviewer = {
      id: reviewerUser.id,
      username: reviewerUser.username,
      role: reviewerUser.role,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
    const creatorUser = await createTestUser(appA, {
      username: 'activity-review-concurrency-creator',
      role: Role.ADMIN,
    });
    const creatorMember = await prismaA.member.create({
      data: {
        memberNo: 'activity-review-concurrency-member',
        displayName: '并发发布发起人',
        gradeCode: 'level-2',
      },
      select: { id: true },
    });
    await prismaA.user.update({
      where: { id: creatorUser.id },
      data: { memberId: creatorMember.id },
    });
    creator = {
      id: creatorUser.id,
      username: creatorUser.username,
      role: creatorUser.role,
      status: UserStatus.ACTIVE,
      memberId: creatorMember.id,
    };

    const root = await prismaA.organization.create({
      data: { name: '并发发布根组织', nodeTypeCode: 'activity-review-root' },
      select: { id: true },
    });
    const organization = await prismaA.organization.create({
      data: {
        name: '并发发布执行组织',
        nodeTypeCode: 'activity-review-team',
        parentId: root.id,
      },
      select: { id: true },
    });
    organizationId = organization.id;
    await prismaA.organizationClosure.createMany({
      data: [
        { ancestorId: root.id, descendantId: root.id, depth: 0 },
        { ancestorId: root.id, descendantId: organization.id, depth: 1 },
        { ancestorId: organization.id, descendantId: organization.id, depth: 0 },
      ],
    });
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close()]);
    if (previousGate === undefined) {
      delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousGate;
    }
  });

  async function createPendingReview(): Promise<{ activityId: string; reviewId: string }> {
    sequence += 1;
    const activity = await prismaA.activity.create({
      data: {
        title: `并发发布活动 ${sequence}`,
        activityTypeCode: 'activity-review-concurrency',
        organizationId,
        initiatorMemberId: creator.memberId,
        startAt: new Date('2099-09-01T01:00:00.000Z'),
        endAt: new Date('2099-09-01T05:00:00.000Z'),
        location: '深圳',
        statusCode: 'draft',
      },
      select: { id: true },
    });
    const review = await reviewServiceA.submitInitial(activity.id, creator, {
      requestId: `activity-review-concurrency-${sequence}`,
      ip: null,
      ua: null,
    });
    return { activityId: activity.id, reviewId: review.id };
  }

  it('two Nest apps forced behind one PostgreSQL Activity lock produce exactly one approval', async () => {
    expect(prismaA).not.toBe(prismaB);
    expect(appA.getHttpServer()).not.toBe(appB.getHttpServer());
    const [[backendA], [backendB]] = await Promise.all([
      prismaA.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
      prismaB.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
    ]);
    expect(backendA?.pid).not.toBe(backendB?.pid);

    const { activityId, reviewId } = await createPendingReview();
    let signalBlockerReady!: () => void;
    let releaseBlocker!: () => void;
    const blockerReady = new Promise<void>((resolve) => {
      signalBlockerReady = resolve;
    });
    const blockerRelease = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blocker = prismaA.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM "Activity" WHERE id = ${activityId} FOR UPDATE
      `;
      signalBlockerReady();
      await blockerRelease;
    });

    await blockerReady;
    const approveA = reviewServiceA.approve(
      reviewId,
      { requiresInsuranceConfirmed: true, reviewNote: 'A 通过' },
      reviewer,
      { requestId: 'activity-review-approve-a', ip: null, ua: null },
    );
    const approveB = reviewServiceB.approve(
      reviewId,
      { requiresInsuranceConfirmed: true, reviewNote: 'B 通过' },
      reviewer,
      { requestId: 'activity-review-approve-b', ip: null, ua: null },
    );

    let barrierError: unknown;
    try {
      await waitForActivityLockWaiters(prismaB, 2);
    } catch (error) {
      barrierError = error;
    } finally {
      releaseBlocker();
      await blocker;
    }
    const results = await Promise.allSettled([approveA, approveB]);
    if (barrierError instanceof Error) throw barrierError;
    if (barrierError !== undefined) {
      throw new Error('non-Error value thrown while forcing review interleaving');
    }

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected).toBeDefined();
    expect(rejected?.reason).toBeInstanceOf(BizException);
    expect((rejected?.reason as BizException).biz).toBe(
      BizCode.ACTIVITY_PUBLISH_REVIEW_STATUS_INVALID,
    );

    await expect(
      prismaA.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: { statusCode: true, workflowRevision: true },
      }),
    ).resolves.toEqual({ statusCode: 'published', workflowRevision: 1 });
    await expect(
      prismaA.activityPublishReview.findUniqueOrThrow({
        where: { id: reviewId },
        select: { status: true, reviewedByUserId: true },
      }),
    ).resolves.toEqual({ status: 'approved', reviewedByUserId: reviewer.id });
  });
});
