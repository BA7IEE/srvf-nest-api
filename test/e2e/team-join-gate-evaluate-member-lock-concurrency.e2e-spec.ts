import { LedgerQueryService } from '../../src/modules/activities/ledger-query.service';
import { ActivityWorkflowGate } from '../../src/common/activity-workflow/activity-workflow.gate';
import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { CorrectionApplicationService } from '../../src/modules/activities/correction-application.service';
import { CORRECTION_CHANGE_SCHEMA_VERSION } from '../../src/modules/activities/correction-change-set';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { TeamJoinApplicationsService } from '../../src/modules/team-join/team-join-applications.service';
import { TeamJoinEnrollmentService } from '../../src/modules/team-join/team-join-enrollment.service';
import { computeContribution } from '../../src/modules/team-join/team-join-progress';
import { TEST_PASSWORD_HASH } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// markGate/evaluate 与正式账本提交、更正提交共享 member 线性化键。
// 用真实准备/提交/更正命令与 PG audit 屏障验证等待后读数，不能用手改批次状态代替写方。
// member 键必须早于 Application 行锁，避免 final join 终结 sibling 申请时形成死锁。

const META: AuditMeta = {
  requestId: 'team-join-gate-evaluate-member-lock-concurrency',
  ip: '127.0.0.1',
  ua: 'jest/team-join-gate-evaluate-member-lock-concurrency',
};
// ⚠️ 被 barrier 钉住的是**生产事务**,它用 Prisma 默认 5s 交互事务预算。
// 观测窗必须远小于 5s:waiter 正常 20-40ms 就出现,等不到就是「锁没取」(那正是我们要的红)。
// 窗开大了会在并行负载下先撞 P2028(事务过期),用例以超时红、真判据被盖住。
const LOCK_WAIT_TIMEOUT_MS = 1_200;
const CASE_TIMEOUT_MS = 60_000;
const CYCLE_YEAR = 2026;
// cutoff = 2026-04-01 00:00 +08:00；贡献只计截止日前 committed credited delta。
// 三个独立北京日；真实账本准备器执行每日封顶，入队读取不二次封顶。
const DAY_A = new Date('2026-01-10T02:00:00.000Z');
const DAY_B = new Date('2026-01-11T02:00:00.000Z');
const DAY_C = new Date('2026-01-12T02:00:00.000Z');

const GENERAL_GATES = [
  'fitness',
  'first-aid-training',
  'military',
  'psych',
  'interview',
  'dept-assessment',
  'entry-exam',
  'intermediate-outdoor',
] as const;
/** 用例 ④ 用它做「末次 gate」—— 前 7 条预置,第 8 条经 markGate 真实落地。 */
const LAST_GATE = GENERAL_GATES[GENERAL_GATES.length - 1];

const LIVE_APPLICATION_STATUSES = ['joining', 'pending_evaluation', 'approved'];

describe('markGate / evaluate × 贡献值写方并发(M1 · member-first 锁序)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let applicationsB: TeamJoinApplicationsService;
  let postingA: LedgerPostingService;
  let preparationA: LedgerPreparationService;
  let correctionA: CorrectionApplicationService;
  let enrollmentA: TeamJoinEnrollmentService;
  let admin: CurrentUserPayload;
  let correctionReviewer: CurrentUserPayload;
  let adminUserId: string;
  let organizationId: string;
  let ownerMemberId: string;
  let seq = 0;
  const previousWorkflowGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;

  async function countAdvisoryWaiters(): Promise<number> {
    const [row] = await prismaB.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT count(*)::int AS n
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory'
    `);
    return row?.n ?? 0;
  }

  async function countAnyLockWaiters(): Promise<number> {
    const [row] = await prismaB.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT count(*)::int AS n
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
    `);
    return row?.n ?? 0;
  }

  interface Barrier {
    ready: Promise<void>;
    release: () => void;
    done: Promise<void>;
  }

  function holdInOwnTransaction(hold: (tx: Prisma.TransactionClient) => Promise<void>): Barrier {
    let signalReady!: () => void;
    let doRelease!: () => void;
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      doRelease = resolve;
    });
    const done = prismaA.$transaction(
      async (tx) => {
        await hold(tx);
        signalReady();
        await gate;
      },
      { timeout: 60_000, maxWait: 60_000 },
    );
    return { ready, release: () => doRelease(), done };
  }

  function holdMemberAdvisoryLock(memberId: string): Barrier {
    return holdInOwnTransaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${memberId}))::text AS locked`;
    });
  }

  function holdMemberRowLock(memberId: string): Barrier {
    return holdInOwnTransaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Member" WHERE "id" = ${memberId} FOR UPDATE`;
    });
  }

  /**
   * `audit_logs` 表级 SHARE 锁 —— 与 INSERT 需要的 RowExclusiveLock 冲突。
   * 账本 commit 的最后一步写 audit，所以按住该表可将普通/更正提交钉在
   * **已持 member 键、已切换批次，但尚未提交**的位置。prepare 必须在屏障之前完成。
   * 没有它,用例 ③④ 的红只是概率:谁先提交是时序决定的,先提交的那一方会让另一方
   * 读到正确的新事实,bug 自己藏起来(K3 首版用例就这样在修复前意外通过过)。
   */
  function holdAuditLogInserts(): Barrier {
    return holdInOwnTransaction(async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE "audit_logs" IN SHARE MODE');
    });
  }

  /** 等被测事务进入锁等待;它若直接跑完也放行(那是另一条合法交错,由结果断言兜底)。 */
  async function untilParkedOrSettled(
    pending: Promise<unknown>,
    countWaiters: () => Promise<number>,
    threshold: number,
  ): Promise<number> {
    let settled = false;
    const mark = (): void => {
      settled = true;
    };
    pending.then(mark, mark);
    const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
    let observed = 0;
    while (Date.now() < deadline) {
      if (settled) return observed;
      observed = await countWaiters();
      if (observed >= threshold) return observed;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return observed;
  }

  function passedGates(codes: readonly string[]): Prisma.InputJsonValue {
    const nowIso = new Date().toISOString();
    return Object.fromEntries(
      codes.map((gate) => [
        gate,
        { at: nowIso, by: adminUserId, passed: true, completionDate: nowIso },
      ]),
    );
  }

  async function makeCycle(): Promise<string> {
    seq += 1;
    const cycle = await prismaA.teamJoinCycle.create({
      data: {
        year: CYCLE_YEAR,
        name: `M1 轮 ${seq}`,
        statusCode: 'closed',
        openedAt: new Date(),
      },
      select: { id: true },
    });
    return cycle.id;
  }

  async function makeMember(): Promise<string> {
    seq += 1;
    const member = await prismaA.member.create({
      data: {
        memberNo: `M1L${String(seq).padStart(3, '0')}`,
        ...memberIdentityData(`锁序${seq}`),
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    return member.id;
  }

  /**
   * 接收已审核结算输入，走真实账本准备器。与 activity-ledger-posting 套件相同的
   * legacy-regime 新链输入：不造旧 Sheet、不手写账本或 day-state、不切换 committed。
   */
  async function createReadyContribution(memberId: string, points: string, checkInAt: Date) {
    const tag = `m1-posting-${++seq}`;
    const endAt = new Date(checkInAt.getTime() + 3600_000);
    const activity = await prismaA.activity.create({
      data: {
        title: tag,
        activityTypeCode: 'm1-act',
        organizationId,
        startAt: checkInAt,
        endAt,
        location: 'M1',
        statusCode: 'published',
      },
    });
    await prismaA.activityResponsibilityAssignment.create({
      data: {
        activityId: activity.id,
        memberId: ownerMemberId,
        responsibilityType: 'owner',
        status: 'active',
        canManageRegistrations: true,
        canManageAttendance: true,
        assignedByUserId: adminUserId,
        source: 'publish',
      },
    });
    const session = await prismaA.activitySession.create({
      data: {
        activityId: activity.id,
        code: tag,
        name: tag,
        startAt: checkInAt,
        endAt,
        locationText: 'M1',
        checkInOpenAt: checkInAt,
        checkInCloseAt: endAt,
        checkOutOpenAt: checkInAt,
        checkOutCloseAt: endAt,
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
    });
    const registration = await prismaA.activityRegistration.create({
      data: { activityId: activity.id, memberId, statusCode: 'pass' },
    });
    const identity = await prismaA.activityParticipationIdentity.create({
      data: {
        activityId: activity.id,
        sessionId: session.id,
        registrationId: registration.id,
        memberId,
        currentStatusCode: 'pass',
        populationIncluded: true,
      },
    });
    const punch = await prismaA.attendancePunchEvent.create({
      data: {
        activityId: activity.id,
        sessionId: session.id,
        participationIdentityId: identity.id,
        memberId,
        eventTypeCode: 'check_in',
        sourceCode: 'self_qr',
        occurredAt: checkInAt,
        receivedAt: checkInAt,
        operatorUserId: adminUserId,
        eventKey: `${tag}-in`,
        requestHash: `${tag}-in-hash`,
        evidenceRevision: 0,
      },
    });
    await prismaA.participantServiceSegmentRevision.create({
      data: {
        participationIdentityId: identity.id,
        segmentKey: 'seg-0',
        revision: 0,
        sourceCheckInEventId: punch.id,
        resultCode: 'valid',
        statusCode: 'draft',
        checkInAt,
        checkOutAt: endAt,
        serviceHours: '1',
      },
    });
    const seal = await prismaA.evidenceSeal.create({
      data: {
        activityId: activity.id,
        sealRevision: 1,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        allWindowsClosedAt: endAt,
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: 1,
        populationCountBySession: {},
        contentHash: `${tag}-seal`,
        statusCode: 'active',
        sealedByUserId: adminUserId,
        sealedAt: endAt,
      },
    });
    const run = await prismaA.attendanceSettlementRun.create({
      data: {
        activityId: activity.id,
        statusCode: 'posting',
        currentDraftVersion: 1,
        currentSubmittedVersion: 1,
      },
    });
    const version = await prismaA.attendanceSettlementVersion.create({
      data: {
        settlementRunId: run.id,
        version: 1,
        evidenceSealId: seal.id,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: `${tag}-version`,
        personCount: 1,
        sessionParticipationCount: 1,
        serviceSegmentCount: 1,
        createdByUserId: adminUserId,
        submittedAt: endAt,
        statusCode: 'approved',
        operationKey: `${tag}-submit`,
        requestHash: `${tag}-submit-hash`,
      },
    });
    await prismaA.participantSettlementResultRevision.create({
      data: {
        settlementVersionId: version.id,
        participationIdentityId: identity.id,
        revision: 0,
        resultCode: 'present',
        recognizedServiceHours: '1',
        calculatedServiceHours: '1',
        recognizedContributionPoints: points,
        calculatedContributionPoints: points,
        statusCode: 'draft',
      },
    });
    const batch = await prismaA.ledgerPostingBatch.create({
      data: {
        settlementRunId: run.id,
        settlementVersionId: version.id,
        batchRevision: 1,
        statusCode: 'preparing',
        requestKey: `${tag}-prepare`,
        requestHash: `${tag}-prepare-hash`,
        totalCount: 1,
        preparedByUserId: adminUserId,
      },
    });
    const { jobId } = await preparationA.ensurePrepareJob(batch.id);
    const items = await prismaA.activityBatchJobItem.findMany({
      where: { jobId },
      orderBy: { itemKey: 'asc' },
      select: { id: true },
    });
    expect(items).toHaveLength(1);
    for (const item of items) await preparationA.prepareChunk(jobId, item.id);
    await preparationA.finalize(jobId);
    return { activityId: activity.id, identityId: identity.id, batchId: batch.id, tag };
  }

  async function giveApprovedContribution(memberId: string, points: string, checkInAt: Date) {
    const fixture = await createReadyContribution(memberId, points, checkInAt);
    const posted = await postingA.commitBatch(
      { postingBatchId: fixture.batchId, operationKey: `${fixture.tag}-commit` },
      admin,
      META,
    );
    expect(posted.batchStatus).toBe('committed');
    return fixture;
  }

  async function createApplication(
    cycleId: string,
    memberId: string,
    statusCode: string,
    gates: readonly string[],
  ): Promise<string> {
    const row = await prismaA.teamJoinApplication.create({
      data: {
        cycleId,
        memberId,
        statusCode,
        targetOrganizationIds: [],
        gateMarks: passedGates(gates),
      },
      select: { id: true },
    });
    return row.id;
  }

  async function readApplication(
    id: string,
  ): Promise<{ statusCode: string; eliminationStage: string | null }> {
    return prismaA.teamJoinApplication.findUniqueOrThrow({
      where: { id },
      select: { statusCode: true, eliminationStage: true },
    });
  }

  /**
   * §DoD 全库不变量:任何 `approved` 申请,其队员在该轮 cutoff 前的封顶贡献值都必须 ≥5。
   * 这正是 evaluate × 更正提交那条 write skew 的落地形态——留下的行光看状态合法，
   * 只有把状态和贡献值放在一起算才看得出来。
   */
  async function assertEveryApprovedApplicationSatisfiesContribution(): Promise<void> {
    const approved = await prismaA.teamJoinApplication.findMany({
      where: { deletedAt: null, statusCode: 'approved' },
      select: { id: true, memberId: true, cycle: { select: { year: true } } },
    });
    const offenders: string[] = [];
    for (const row of approved) {
      const contribution = await computeContribution(
        prismaA,
        row.memberId,
        row.cycle.year,
        appA.get(ActivityWorkflowGate),
        LedgerQueryService,
      );
      if (!contribution.satisfied) {
        offenders.push(
          `${row.id} (member=${row.memberId}, points=${contribution.points.toString()})`,
        );
      }
    }
    expect(offenders).toEqual([]);
  }

  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    applicationsB = appB.get(TeamJoinApplicationsService);
    postingA = appA.get(LedgerPostingService);
    preparationA = appA.get(LedgerPreparationService);
    correctionA = appA.get(CorrectionApplicationService);
    enrollmentA = appA.get(TeamJoinEnrollmentService);

    const reviewer = await prismaA.user.create({
      data: {
        username: 'm1-reviewer',
        passwordHash: TEST_PASSWORD_HASH,
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true, username: true },
    });
    correctionReviewer = {
      id: reviewer.id,
      username: reviewer.username,
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
    const adminRow = await prismaA.user.create({
      data: {
        username: 'm1-super-admin',
        passwordHash: TEST_PASSWORD_HASH,
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true, username: true },
    });
    adminUserId = adminRow.id;
    admin = {
      id: adminRow.id,
      username: adminRow.username,
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };

    organizationId = (
      await prismaA.organization.create({
        data: { name: 'M1 Org', nodeTypeCode: 'm1-node', status: 'ACTIVE' },
        select: { id: true },
      })
    ).id;
    ownerMemberId = (
      await prismaA.member.create({
        data: {
          memberNo: 'M1-OWNER',
          ...memberIdentityData('M1 负责人'),
          status: MemberStatus.ACTIVE,
          gradeCode: 'level-2',
        },
        select: { id: true },
      })
    ).id;

    // final join 写 gradeCode='level-1',依赖 member_grade 字典(resetDb 已 truncate)。
    const gradeType = await prismaA.dictType.create({
      data: { code: 'member_grade', label: '队员级别' },
      select: { id: true },
    });
    await prismaA.dictItem.create({
      data: { typeId: gradeType.id, code: 'level-1', label: '级别 1' },
    });
  });

  afterAll(async () => {
    try {
      await Promise.all([appA?.close(), appB?.close()]);
    } finally {
      if (previousWorkflowGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousWorkflowGate;
    }
  });

  it('两个 app 确实是两条独立连接(否则下面的锁等待全是自欺)', async () => {
    expect(prismaA).not.toBe(prismaB);
    const [[a], [b]] = await Promise.all([
      prismaA.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
      prismaB.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
    ]);
    expect(a?.pid).not.toBe(b?.pid);
  });

  it(
    '① 结构位:evaluate 必须在 member 线性化键内读贡献聚合(键被占住时它得等)',
    async () => {
      const memberId = await makeMember();
      const cycleId = await makeCycle();
      await giveApprovedContribution(memberId, '3.00', DAY_A);
      await giveApprovedContribution(memberId, '2.00', DAY_B);
      const applicationId = await createApplication(
        cycleId,
        memberId,
        'pending_evaluation',
        GENERAL_GATES,
      );

      const barrier = holdMemberAdvisoryLock(memberId);
      await barrier.ready;

      const evaluating = applicationsB.evaluate(
        applicationId,
        { approved: true },
        admin,
        META,
        new Date(),
      );
      evaluating.catch(() => undefined);

      // 修复前:evaluate 从不碰 member 维度的共同键 —— 这里等不到任何 advisory waiter,直接红。
      let observed = 0;
      try {
        observed = await untilParkedOrSettled(evaluating, countAdvisoryWaiters, 1);
      } finally {
        barrier.release();
        await barrier.done;
      }
      await evaluating;
      expect(observed).toBeGreaterThanOrEqual(1);
      expect((await readApplication(applicationId)).statusCode).toBe('approved');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    '② 结构位:markGate 必须在 member 线性化键内读贡献聚合(键被占住时它得等)',
    async () => {
      const memberId = await makeMember();
      const cycleId = await makeCycle();
      await giveApprovedContribution(memberId, '3.00', DAY_A);
      await giveApprovedContribution(memberId, '2.00', DAY_B);
      const applicationId = await createApplication(
        cycleId,
        memberId,
        'joining',
        GENERAL_GATES.slice(0, GENERAL_GATES.length - 1),
      );

      const barrier = holdMemberAdvisoryLock(memberId);
      await barrier.ready;

      const marking = applicationsB.markGate(
        applicationId,
        { gateCode: LAST_GATE, passed: true, completionDate: new Date().toISOString() },
        admin,
        META,
        new Date(),
      );
      marking.catch(() => undefined);

      let observed = 0;
      try {
        observed = await untilParkedOrSettled(marking, countAdvisoryWaiters, 1);
      } finally {
        barrier.release();
        await barrier.done;
      }
      await marking;
      expect(observed).toBeGreaterThanOrEqual(1);
      // 8 门槛齐 + 贡献值 5 ⇒ 自动推进。
      expect((await readApplication(applicationId)).statusCode).toBe('pending_evaluation');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    '③ 行为位:evaluate(true) × 更正提交 —— 等待冲回后不得以旧分数批准申请',
    async () => {
      const memberId = await makeMember();
      const cycleId = await makeCycle();
      await giveApprovedContribution(memberId, '3.00', DAY_A);
      const corrected = await giveApprovedContribution(memberId, '2.00', DAY_B);
      const originalEntries = await prismaA.participationLedgerEntry.findMany({
        where: { postingBatchId: corrected.batchId },
        orderBy: { id: 'asc' },
      });
      expect(originalEntries).toHaveLength(2);
      const submitted = await correctionA.submit(
        {
          activityId: corrected.activityId,
          participationIdentityId: corrected.identityId,
          requestTypeCode: 'points',
          requestedChangeJson: {
            schemaVersion: CORRECTION_CHANGE_SCHEMA_VERSION,
            results: [
              {
                participationIdentityId: corrected.identityId,
                resultCode: 'present',
                recognizedServiceHours: '1',
                recognizedContributionPoints: '0',
                adjustmentReason: '复核贡献值',
                lateFlag: false,
                earlyLeaveFlag: false,
              },
            ],
            segments: [],
          },
          reason: '复核贡献值',
          operationKey: `${corrected.tag}-correction`,
          requestHash: `${corrected.tag}-correction-hash`,
        },
        admin,
        META,
      );
      const reviewed = await correctionA.review(
        { correctionRequestId: submitted.correctionRequestId, actionCode: 'approve' },
        correctionReviewer,
        META,
      );
      expect(reviewed.outcome).toBe('reviewed');
      const correctionInput = {
        correctionRequestId: submitted.correctionRequestId,
        operationKey: `${corrected.tag}-apply`,
        requestHash: `${corrected.tag}-apply-hash`,
      };
      // prepare 自己也写 audit，却不取 member 键；必须先完成，再只围住真实 commit。
      await correctionA.prepare(correctionInput, correctionReviewer, META);
      const applicationId = await createApplication(
        cycleId,
        memberId,
        'pending_evaluation',
        GENERAL_GATES,
      );
      // 前提自证:此刻确实满足 5 分,否则下面证明的是一个不成立的前提。
      expect(
        (
          await computeContribution(
            prismaA,
            memberId,
            CYCLE_YEAR,
            appA.get(ActivityWorkflowGate),
            LedgerQueryService,
          )
        ).points.toString(),
      ).toBe('5');

      // 更正先出发，被钉在已持 member 键、冲回/重记尚未对另一连接可见的位置。
      const barrier = holdAuditLogInserts();
      await barrier.ready;
      const correcting = correctionA.commit(correctionInput, correctionReviewer, META);
      correcting.catch(() => undefined);
      const correctionWaiters = await untilParkedOrSettled(correcting, countAnyLockWaiters, 1);

      const evaluating = applicationsB.evaluate(
        applicationId,
        { approved: true },
        admin,
        META,
        new Date(),
      );
      evaluating.catch(() => undefined);
      try {
        expect(correctionWaiters).toBeGreaterThanOrEqual(1);
        // evaluate 应卡在更正持有的 member 键上(第 2 个 waiter)。
        // 缺键时它读到「仍是 5 分」并写 approved，只在 audit 表锁上等待——
        // 同样是第 2 个 waiter,所以这里不做结构断言,判据全在下面的结果上。
        expect(
          await untilParkedOrSettled(evaluating, countAnyLockWaiters, 2),
        ).toBeGreaterThanOrEqual(2);
      } finally {
        barrier.release();
        await barrier.done;
      }
      const [correctionResult, evaluateResult] = await Promise.allSettled([correcting, evaluating]);
      expect(correctionResult.status).toBe('fulfilled');
      await expect(
        prismaA.participationLedgerEntry.findMany({
          where: { postingBatchId: corrected.batchId },
          orderBy: { id: 'asc' },
        }),
      ).resolves.toEqual(originalEntries);

      // 撤回后总分 3 < 5。修复前 evaluate 基于「撤回尚未提交」的快照通过,留下 approved 欠贡献行。
      expect(
        (
          await computeContribution(
            prismaA,
            memberId,
            CYCLE_YEAR,
            appA.get(ActivityWorkflowGate),
            LedgerQueryService,
          )
        ).points.toString(),
      ).toBe('3');
      expect(evaluateResult.status).toBe('rejected');
      const reason = evaluateResult.status === 'rejected' ? evaluateResult.reason : undefined;
      expect(reason).toBeInstanceOf(BizException);
      expect((reason as BizException).biz).toBe(BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
      expect((await readApplication(applicationId)).statusCode).toBe('pending_evaluation');
      await assertEveryApprovedApplicationSatisfiesContribution();
    },
    CASE_TIMEOUT_MS,
  );

  it(
    '④ 行为位:markGate(末次) × 账本提交 —— 等待入账后不得把达标申请按回 joining',
    async () => {
      const memberId = await makeMember();
      const cycleId = await makeCycle();
      await giveApprovedContribution(memberId, '3.00', DAY_A);
      await giveApprovedContribution(memberId, '1.00', DAY_B);
      const pending = await createReadyContribution(memberId, '1.00', DAY_C);
      const applicationId = await createApplication(
        cycleId,
        memberId,
        'joining',
        GENERAL_GATES.slice(0, GENERAL_GATES.length - 1),
      );
      expect(
        (
          await computeContribution(
            prismaA,
            memberId,
            CYCLE_YEAR,
            appA.get(ActivityWorkflowGate),
            LedgerQueryService,
          )
        ).points.toString(),
      ).toBe('4');

      // 统一提交先出发，被钉在已持 member 键、批次仍未对另一连接可见的位置。
      const barrier = holdAuditLogInserts();
      await barrier.ready;
      const posting = postingA.commitBatch(
        { postingBatchId: pending.batchId, operationKey: `${pending.tag}-commit` },
        admin,
        META,
      );
      posting.catch(() => undefined);
      const postingWaiters = await untilParkedOrSettled(posting, countAnyLockWaiters, 1);

      const marking = applicationsB.markGate(
        applicationId,
        { gateCode: LAST_GATE, passed: true, completionDate: new Date().toISOString() },
        admin,
        META,
        new Date(),
      );
      marking.catch(() => undefined);
      try {
        expect(postingWaiters).toBeGreaterThanOrEqual(1);
        expect(await untilParkedOrSettled(marking, countAnyLockWaiters, 2)).toBeGreaterThanOrEqual(
          2,
        );
      } finally {
        barrier.release();
        await barrier.done;
      }
      const [postResult, markResult] = await Promise.allSettled([posting, marking]);
      expect(postResult.status).toBe('fulfilled');
      expect(markResult.status).toBe('fulfilled');
      await expect(
        prismaA.ledgerPostingBatch.findUniqueOrThrow({
          where: { id: pending.batchId },
          select: { statusCode: true },
        }),
      ).resolves.toEqual({ statusCode: 'committed' });

      expect(
        (
          await computeContribution(
            prismaA,
            memberId,
            CYCLE_YEAR,
            appA.get(ActivityWorkflowGate),
            LedgerQueryService,
          )
        ).points.toString(),
      ).toBe('5');
      // 修复前:markGate 读到尚未提交的 4 分 → nextStatus=joining,门槛全齐却卡住。
      expect((await readApplication(applicationId)).statusCode).toBe('pending_evaluation');
    },
    CASE_TIMEOUT_MS,
  );

  it.each([
    ['markGate', 'markGate'],
    ['evaluate', 'evaluate'],
  ])(
    '⑤ 死锁位:final join 持键争同人 sibling 行锁时,%s 必须也是 member-first(反序即 40P01)',
    async (_label, entry) => {
      const memberId = await makeMember();
      const targetOrg = (
        await prismaA.organization.create({
          data: {
            name: `M1 目标部门 ${memberId.slice(0, 6)}`,
            nodeTypeCode: 'm1-node',
            status: 'ACTIVE',
          },
          select: { id: true },
        })
      ).id;
      await giveApprovedContribution(memberId, '3.00', DAY_A);
      await giveApprovedContribution(memberId, '2.00', DAY_B);

      const joinCycleId = await makeCycle();
      const approvedId = await prismaA.teamJoinApplication
        .create({
          data: {
            cycleId: joinCycleId,
            memberId,
            statusCode: 'approved',
            targetOrganizationIds: [targetOrg],
            gateMarks: passedGates(GENERAL_GATES),
            evaluatedByUserId: adminUserId,
            evaluatedAt: new Date(),
          },
          select: { id: true },
        })
        .then((row) => row.id);
      // 同一队员名下的另一条 live 申请 —— final join 步骤 9 会**反向**回来锁它。
      const siblingCycleId = await makeCycle();
      const siblingId = await createApplication(
        siblingCycleId,
        memberId,
        entry === 'evaluate' ? 'pending_evaluation' : 'joining',
        entry === 'evaluate' ? GENERAL_GATES : GENERAL_GATES.slice(0, GENERAL_GATES.length - 1),
      );

      // 占住 Member 行锁 = 把 final join 钉在「已持 member 键 + 已锁 approved 申请行、
      // 尚未走到步骤 9 的 sibling 行锁」的位置上。
      const barrier = holdMemberRowLock(memberId);
      await barrier.ready;
      const joining = enrollmentA.join(
        approvedId,
        { organizationId: targetOrg },
        admin,
        META,
        new Date(),
      );
      joining.catch(() => undefined);
      await untilParkedOrSettled(joining, countAnyLockWaiters, 1);

      // 反序实现会在这里先抢到 sibling 的行锁、再去等 member 键 → 与 join 互等 → 40P01。
      // member-first 实现则空手在键上排队,join 步骤 9 畅通无阻。
      const contending =
        entry === 'evaluate'
          ? applicationsB.evaluate(siblingId, { approved: false }, admin, META, new Date())
          : applicationsB.markGate(
              siblingId,
              { gateCode: LAST_GATE, passed: true, completionDate: new Date().toISOString() },
              admin,
              META,
              new Date(),
            );
      contending.catch(() => undefined);
      try {
        await untilParkedOrSettled(contending, countAnyLockWaiters, 2);
      } finally {
        barrier.release();
        await barrier.done;
      }
      const [joinResult, contendResult] = await Promise.allSettled([joining, contending]);

      for (const result of [joinResult, contendResult]) {
        if (result.status === 'rejected') {
          // 断言直接吃原始错误串:死锁时 diff 里能看见是哪一对锁,不必再复现一次。
          expect(String(result.reason)).not.toMatch(/40P01|deadlock detected/i);
        }
      }
      expect(joinResult.status).toBe('fulfilled');
      // sibling 被入队事实顶掉(B-F5 级联),此后任何门槛写入都必须 28240。
      expect(contendResult.status).toBe('rejected');
      const contendReason = contendResult.status === 'rejected' ? contendResult.reason : undefined;
      expect(contendReason).toBeInstanceOf(BizException);
      expect((contendReason as BizException).biz).toBe(BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);

      const sibling = await readApplication(siblingId);
      expect(sibling.statusCode).toBe('rejected');
      expect(sibling.eliminationStage).toBe('already-enrolled');
      expect(
        await prismaA.teamJoinApplication.count({
          where: { memberId, deletedAt: null, statusCode: { in: LIVE_APPLICATION_STATUSES } },
        }),
      ).toBe(0);
      await assertEveryApprovedApplicationSatisfiesContribution();
    },
    CASE_TIMEOUT_MS,
  );
});
