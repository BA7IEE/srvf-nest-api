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
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// ===== 活动改造 v1.1 第 2 批第四刀:审核并发(goal DoD 3 / DoD 4)=====
//
// 本 spec 有两条判据,守的是**两件不同的事**:
//
//   ⭐ DoD 3 —— 三方分离必须打在**事务内锁后复判**那一层,不是入口处查一次。
//      构造:一个人 B **先**做一审,**同时**又发起终审。终审请求**发出的那一刻**,
//      一审动作行还不存在(入口处查一次 ⇒ firstReviewer=null ⇒ 放行);
//      等它拿到锁时,B 已经是一审人了 ⇒ 锁后复判必须拒 20064。
//      ⇒ 把分离判据挪到锁之前,这条用例就会**放行一次自审**(变异 A/B 读数见报告)。
//
//   ⭐ DoD 4 —— 一版本一阶段只允许一个生效决定:approve 与 return **真并发**时
//      只能一个成功,败者收具名码 20072。
//
// ⚠️ 两条都**不用** `Promise.all(两个 service 调用)` —— 那是假并发:Node 单线程 +
//    Prisma 交互事务,两条调用极可能先后串行走完,谁都不会真的排队,用例即使在没有
//    任何锁的实现上也会绿(空绿)。
// 真构造 = **两套 Nest / Prisma pool** + 第三个事务当**闸门**:先由 blocker 事务把
// Activity 行锁攥住,让 A、B 双双堵在锁序第一层上(用 `pg_stat_activity` 的
// `wait_event_type='Lock'` **正面证明**它们真的在等锁),再放闸。

const PAST = new Date('2020-03-01T00:00:00.000Z');
const SEAL_AT = new Date('2020-03-01T09:00:00.000Z');

/**
 * 正面证明两条审核事务真的堵在 Activity 行锁上。
 *
 * `query LIKE '%workflowRevision%'` 认的是 `lockActivity` 那条 `FOR UPDATE`
 * (本刀锁序第一层),与第一刀 spec 同一手法。
 */
async function waitForReviewLockWaiters(prisma: PrismaService, expected: number): Promise<void> {
  const deadline = Date.now() + 8_000;
  let observed = 0;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ waitingCount: number }>>`
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
    `expected at least ${expected} settlement-review Activity row-lock waiter(s), saw ${observed}`,
  );
}

interface ReviewFixture {
  activityId: string;
  runId: string;
  versionId: string;
  sealId: string;
  contentHash: string;
}

describe('settlement review multi-instance concurrency', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let serviceA: SettlementReviewService;
  let serviceB: SettlementReviewService;

  let submitter: CurrentUserPayload;
  /** 🔴 DoD 3 的主角:同一个人,既想一审又想终审。 */
  let doubleDipper: CurrentUserPayload;
  let reviewerC: CurrentUserPayload;

  let organizationId: string;
  let sequence = 0;

  const auditMeta = { requestId: 'settlement-review-concurrency', ip: null, ua: null };

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    serviceA = appA.get(SettlementReviewService);
    serviceB = appB.get(SettlementReviewService);

    submitter = await makeActor('settlement-review-conc-submitter');
    doubleDipper = await makeActor('settlement-review-conc-double');
    reviewerC = await makeActor('settlement-review-conc-c');

    const organization = await prismaA.organization.create({
      data: { name: '结算审核并发组织', nodeTypeCode: 'settlement-review-conc-team' },
      select: { id: true },
    });
    organizationId = organization.id;
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close()]);
  });

  async function makeActor(username: string): Promise<CurrentUserPayload> {
    const user = await createTestUser(appA, { username, role: Role.SUPER_ADMIN });
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
  }

  async function createReviewable(): Promise<ReviewFixture> {
    sequence += 1;
    const tag = `review-conc-${sequence}`;
    const activity = await prismaA.activity.create({
      data: {
        title: `结算审核并发活动 ${sequence}`,
        activityTypeCode: `settlement-review-conc-type-${sequence}`,
        organizationId,
        startAt: PAST,
        endAt: new Date(PAST.getTime() + 4 * 3600_000),
        location: '深圳',
        statusCode: 'published',
      },
      select: { id: true },
    });
    const session = await prismaA.activitySession.create({
      data: {
        activityId: activity.id,
        code: `${tag}-s1`,
        name: `${tag} 场次一`,
        startAt: PAST,
        endAt: new Date(PAST.getTime() + 4 * 3600_000),
        locationText: '深圳',
        checkInOpenAt: new Date(PAST.getTime() - 3600_000),
        checkInCloseAt: new Date(PAST.getTime() + 3600_000),
        checkOutOpenAt: new Date(PAST.getTime() + 2 * 3600_000),
        checkOutCloseAt: new Date('2020-03-01T08:00:00.000Z'),
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });
    const member = await prismaA.member.create({
      data: { memberNo: `${tag}-m`, displayName: `${tag} 队员`, gradeCode: 'level-2' },
      select: { id: true },
    });
    const registration = await prismaA.activityRegistration.create({
      data: { activityId: activity.id, memberId: member.id, statusCode: 'approved' },
      select: { id: true },
    });
    await prismaA.activityParticipationIdentity.create({
      data: {
        activityId: activity.id,
        sessionId: session.id,
        registrationId: registration.id,
        memberId: member.id,
        currentStatusCode: 'pass',
        populationIncluded: true,
      },
    });
    const seal = await prismaA.evidenceSeal.create({
      data: {
        activityId: activity.id,
        sealRevision: 1,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        allWindowsClosedAt: new Date('2020-03-01T08:00:00.000Z'),
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: 1,
        populationCountBySession: {},
        contentHash: `seal-hash-${tag}`,
        statusCode: 'active',
        sealedByUserId: submitter.id,
        sealedAt: SEAL_AT,
      },
      select: { id: true },
    });
    const run = await prismaA.attendanceSettlementRun.create({
      data: {
        activityId: activity.id,
        statusCode: 'pending_first_review',
        currentDraftVersion: 1,
        currentSubmittedVersion: 1,
      },
      select: { id: true },
    });
    const contentHash = `content-hash-${tag}`;
    const version = await prismaA.attendanceSettlementVersion.create({
      data: {
        settlementRunId: run.id,
        version: 1,
        evidenceSealId: seal.id,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash,
        personCount: 1,
        sessionParticipationCount: 1,
        serviceSegmentCount: 0,
        createdByUserId: submitter.id,
        submittedAt: SEAL_AT,
        statusCode: 'submitted',
      },
      select: { id: true },
    });
    return {
      activityId: activity.id,
      runId: run.id,
      versionId: version.id,
      sealId: seal.id,
      contentHash,
    };
  }

  function reviewInput(
    fixture: ReviewFixture,
    overrides: Partial<SettlementReviewInput> = {},
  ): SettlementReviewInput {
    sequence += 1;
    return {
      activityId: fixture.activityId,
      actionCode: 'approve',
      operationKey: `review-conc-op-${sequence}-${randomUUID()}`,
      requestHash: `review-conc-hash-${sequence}`,
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

  /** 攥住 Activity 行锁的第三个事务;返回「放闸」回调。 */
  async function holdActivityLock(activityId: string): Promise<{
    release: () => void;
    done: Promise<unknown>;
  }> {
    let signalReady!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = prismaA.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${activityId} FOR UPDATE`;
      signalReady();
      await gate;
    });
    await ready;
    return { release, done };
  }

  it('两套 Nest 实例确实是两套 pool(判据的前提)', async () => {
    expect(prismaA).not.toBe(prismaB);
    expect(appA.getHttpServer()).not.toBe(appB.getHttpServer());
    const [[backendA], [backendB]] = await Promise.all([
      prismaA.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
      prismaB.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
    ]);
    expect(backendA?.pid).not.toBe(backendB?.pid);
  });

  // =========================================================================
  // ⭐ DoD 3:分离判据必须在**锁后**复判 —— 入口处查一次是不够的
  // =========================================================================
  it('⭐ 同一人「一审 + 终审」并发:发起时一审人还不存在(入口会放行),锁后复判必须拒 20064', async () => {
    const fixture = await createReviewable();

    // —— 入口时刻的读数(**不在任何事务里**,就是"入口处查一次"会看到的东西)。
    const entryTimeFirstReviewer = await prismaA.settlementReviewAction.findFirst({
      where: { settlementVersionId: fixture.versionId, stageCode: 'first' },
      select: { actorUserId: true },
    });
    // 🔴 判据的前提:此刻**没有**一审人 ⇒ 入口处的分离判据会放行终审。
    expect(entryTimeFirstReviewer).toBeNull();

    const gate = await holdActivityLock(fixture.activityId);

    // A 实例:doubleDipper 做一审。
    const first = serviceA.firstReview(reviewInput(fixture), doubleDipper, {
      ...auditMeta,
      requestId: 'conc-first',
    });
    // B 实例:**同一个人**同时发起终审。两条都会先堵在 Activity 行锁上。
    const final = serviceB.finalReview(reviewInput(fixture), doubleDipper, {
      ...auditMeta,
      requestId: 'conc-final',
    });

    let barrierError: unknown;
    try {
      await waitForReviewLockWaiters(prismaB, 2);
    } catch (error) {
      barrierError = error;
    } finally {
      gate.release();
      await gate.done;
    }
    const [firstResult, finalResult] = await Promise.allSettled([first, final]);
    if (barrierError instanceof Error) throw barrierError;
    if (barrierError !== undefined) {
      throw new Error('non-Error value thrown while forcing review interleaving');
    }

    // 谁先拿到锁不确定,所以两种收场都必须是"终审没成立":
    //   - 一审先跑完 ⇒ 终审锁后读到 firstReviewer=自己 ⇒ 20064(本条判据的正靶);
    //   - 终审先拿到锁 ⇒ run 还在 pending_first_review ⇒ 20065。
    // 两种都不允许终审动作行落地 —— 那才是"自审成立"。
    expect(finalResult.status).toBe('rejected');
    const finalError = (finalResult as PromiseRejectedResult).reason;
    expect(finalError).toBeInstanceOf(BizException);
    expect([
      BizCode.SETTLEMENT_SAME_REVIEWER_FORBIDDEN,
      BizCode.SETTLEMENT_REVIEW_RUN_STATUS_INVALID,
    ]).toContain((finalError as BizException).biz);

    // 🔴 最终不变量:这个版本上**绝不允许**出现同一个人的两条审核动作。
    const actions = await prismaA.settlementReviewAction.findMany({
      where: { settlementVersionId: fixture.versionId },
      select: { stageCode: true, actorUserId: true },
    });
    expect(actions.filter((action) => action.stageCode === 'final')).toHaveLength(0);
    expect(new Set(actions.map((action) => action.actorUserId)).size).toBe(actions.length);
    expect(firstResult.status).toBe('fulfilled');
  });

  // 上一条用例在"终审先拿到锁"时会退化成 20065(仍然安全,但没打到分离那一层)。
  // 这一条把顺序钉死:一审**已经落地**、终审**在等锁**——入口时刻的读数由 blocker
  // 事务保证仍是"还没有一审人"。此时唯一能拒住终审的只有**锁后复判**。
  it('⭐ 一审在终审等锁期间落地 ⇒ 终审锁后复判恒拒 20064(入口读数为"无一审人")', async () => {
    const fixture = await createReviewable();

    // ⚠️ 这里**不能**用 blocker 事务当闸 —— 实测踩过:blocker 一释放,已经在排队的
    //    终审会**立刻**拿到锁,一审根本挤不进去,结果退化成 20065(run 还在
    //    pending_first_review)。判据就没打到分离那一层。
    //    正确的闸是**一审事务自己**:让它写完动作行、还没 commit 时停住 ——
    //    它此刻正握着 Activity 行锁,终审只能排队等它。
    const auditRecorderA = appA.get(SettlementReviewAuditRecorder);
    const passThrough = auditRecorderA.log.bind(auditRecorderA);
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const logSpy = jest
      .spyOn(auditRecorderA, 'log')
      .mockImplementationOnce(async (args: Parameters<typeof passThrough>[0]) => {
        await passThrough(args);
        await firstHeld; // ← 事务停在这里,锁没放
      });

    try {
      const first = serviceA.firstReview(reviewInput(fixture), doubleDipper, {
        ...auditMeta,
        requestId: 'conc-first-held',
      });
      // 等一审真的进到"已写完、未 commit"那一刻(spy 被调用即证明它已经走到最后一步)。
      const deadline = Date.now() + 8_000;
      while (logSpy.mock.calls.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(logSpy).toHaveBeenCalledTimes(1);

      // B 实例发起终审 —— 它会堵在一审握着的 Activity 行锁上。
      const final = serviceB.finalReview(reviewInput(fixture), doubleDipper, {
        ...auditMeta,
        requestId: 'conc-final-blocked',
      });
      await waitForReviewLockWaiters(prismaB, 1);

      // 🔴 判据的核心读数:终审**已经在等锁**,而从事务外看(= 入口处那一次读),
      //    一审动作行**还不存在**(一审事务未 commit)⇒ 入口处的分离判据会放行。
      await expect(
        prismaA.settlementReviewAction.count({
          where: { settlementVersionId: fixture.versionId, stageCode: 'first' },
        }),
      ).resolves.toBe(0);

      // 放行一审 ⇒ commit ⇒ 终审此刻才拿到锁并**锁后复判**。
      releaseFirst();
      await first;

      await expect(final).rejects.toBeInstanceOf(BizException);
      await final.catch((error: unknown) => {
        // 🔴 只有"锁后复判"能给出这个码。把分离判据挪到锁之前,这里会变成一次
        //    成功的自审(变异 A/B 读数见报告)。
        expect((error as BizException).biz).toBe(BizCode.SETTLEMENT_SAME_REVIEWER_FORBIDDEN);
      });
    } finally {
      releaseFirst();
      logSpy.mockRestore();
    }

    await expect(
      prismaA.settlementReviewAction.count({
        where: { settlementVersionId: fixture.versionId, stageCode: 'final' },
      }),
    ).resolves.toBe(0);
    await expect(
      prismaA.ledgerPostingBatch.count({ where: { settlementVersionId: fixture.versionId } }),
    ).resolves.toBe(0);
  });

  // =========================================================================
  // ⭐ DoD 4:approve 与 return 真并发 ⇒ 只能一个成功,败者具名码
  // =========================================================================
  it('⭐ approve 与 return 并发同一版本同一阶段 ⇒ 恰好一个成功,败者 20072', async () => {
    const fixture = await createReviewable();
    const gate = await holdActivityLock(fixture.activityId);

    const approve = serviceA.firstReview(reviewInput(fixture), doubleDipper, {
      ...auditMeta,
      requestId: 'conc-approve',
    });
    const returned = serviceB.firstReview(
      reviewInput(fixture, { actionCode: 'return', returnReason: '并发退回' }),
      reviewerC,
      { ...auditMeta, requestId: 'conc-return' },
    );

    let barrierError: unknown;
    try {
      await waitForReviewLockWaiters(prismaB, 2);
    } catch (error) {
      barrierError = error;
    } finally {
      gate.release();
      await gate.done;
    }
    const results = await Promise.allSettled([approve, returned]);
    if (barrierError instanceof Error) throw barrierError;
    if (barrierError !== undefined) {
      throw new Error('non-Error value thrown while forcing review interleaving');
    }

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected).toBeDefined();
    // 败者必须是**具名业务码**,不是未映射的 500 / P2028。
    expect(rejected?.reason).toBeInstanceOf(BizException);
    expect((rejected?.reason as BizException).biz).toBe(BizCode.SETTLEMENT_REVIEW_ALREADY_DECIDED);

    // 一版本一阶段**恰好一条**生效决定。
    const actions = await prismaA.settlementReviewAction.findMany({
      where: { settlementVersionId: fixture.versionId, stageCode: 'first' },
      select: { actionCode: true },
    });
    expect(actions).toHaveLength(1);

    // run 的落点必须与那条唯一决定一致(不能出现"批准了却回到 drafting"这种分叉)。
    const run = await prismaA.attendanceSettlementRun.findUniqueOrThrow({
      where: { id: fixture.runId },
      select: { statusCode: true },
    });
    expect(run.statusCode).toBe(
      actions[0].actionCode === 'approve' ? 'pending_final_review' : 'drafting',
    );
  });

  it('⭐ 两条 approve 并发同一版本同一阶段 ⇒ 恰好一条动作行,败者 20072', async () => {
    const fixture = await createReviewable();
    const gate = await holdActivityLock(fixture.activityId);

    const a = serviceA.firstReview(reviewInput(fixture), doubleDipper, {
      ...auditMeta,
      requestId: 'conc-approve-a',
    });
    const b = serviceB.firstReview(reviewInput(fixture), reviewerC, {
      ...auditMeta,
      requestId: 'conc-approve-b',
    });

    let barrierError: unknown;
    try {
      await waitForReviewLockWaiters(prismaB, 2);
    } catch (error) {
      barrierError = error;
    } finally {
      gate.release();
      await gate.done;
    }
    const results = await Promise.allSettled([a, b]);
    if (barrierError instanceof Error) throw barrierError;
    if (barrierError !== undefined) {
      throw new Error('non-Error value thrown while forcing review interleaving');
    }

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(BizException);
    expect((rejected?.reason as BizException).biz).toBe(BizCode.SETTLEMENT_REVIEW_ALREADY_DECIDED);
    await expect(
      prismaA.settlementReviewAction.count({
        where: { settlementVersionId: fixture.versionId, stageCode: 'first' },
      }),
    ).resolves.toBe(1);
  });
});
