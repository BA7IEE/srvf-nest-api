import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityArchiveService } from '../../src/modules/activities/activity-archive.service';
import { ActivityAuditRecorder } from '../../src/modules/activities/activity-audit-recorder';
import { ActivityClosureAuditRecorder } from '../../src/modules/activities/activity-closure-audit-recorder';
import { ActivityClosureService } from '../../src/modules/activities/activity-closure.service';
import { CorrectionApplicationService } from '../../src/modules/activities/correction-application.service';
import { CorrectionAuditRecorder } from '../../src/modules/activities/correction-audit-recorder';
import { CORRECTION_CHANGE_SCHEMA_VERSION } from '../../src/modules/activities/correction-change-set';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { SettlementReviewAuditRecorder } from '../../src/modules/activities/settlement-review-audit-recorder';
import {
  SettlementReviewService,
  type SettlementReviewInput,
} from '../../src/modules/activities/settlement-review.service';
import { createTestUser } from '../fixtures/users.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// ===== 验收编号 AC-063(2026-08 补写)—— 关账的并发串行化 ======================
//
// 合同原句(业务方案 AC-063,逐字):
//   「关账与最后一次终审、最后一个更正并发时按活动锁串行，不漏检查、不重复关闭。」
//
// 这一句拆成**四格**,本 spec 逐格给判据:
//   ① 关账 × 最后一个更正 并发 ⇒ 按 **Activity 行锁**串行   → ② 号用例
//   ② 关账 × 最后一次终审 并发 ⇒ 按 **Activity 行锁**串行   → ④ 号用例
//   ③ **不漏检查** ⇒ 八类检查在**拿到锁之后**重跑,读的是赢家已提交的状态,
//      不是入口时刻的快照                                    → ② 与 ④
//   ④ **不重复关闭** ⇒ 任何交错顺序下 active closure 恒 ≤ 1  → ②③④
//
// 🔴 **能力早已在,缺的一直是判据**:`ActivityClosureService` 文件头点名
//    「AC-063 要的『关账与终审、更正并发时按活动锁串行』由 ① 提供」——
//    三条路径(关账 / 终审 / 更正)都以 `Activity FOR UPDATE` 开锁序第一层。
//    在本 spec 之前,全仓关于 AC-063 的唯一证据是 `activity-settlement-closure.e2e-spec.ts`
//    里那条 `Promise.all(两次 close)`:**单 app / 单 pool** ⇒ Node 单线程 + Prisma 交互事务
//    会把两条调用先后串行跑完,谁都不会真的排队 —— 那条用例在**没有任何锁**的实现上也会绿。
//
// ⭐ 真构造(沿 `activity-settlement-review-concurrency` 与更正 spec ⑪ 同一手法):
//    **两套 Nest / 两套 Prisma pool** + 让赢家的事务停在最后一步(spy 审计记录器)
//    攥住 Activity 行锁,再用 `pg_stat_activity` 的 `wait_event_type='Lock'`
//    **正面证明**关账真的堵在那一把锁上。屏障拿不到读数即抛 —— 不是"反正没成功"。
//
// ⚠️ **诚实标注(PR body 里也列了)**:③「不漏检查」在**更正**那一格能做成**判决翻转**
//    (入口时刻两类缺口非零 ⇒ 若在锁前判就必然 blocked;实际返回 closed ⇒ 只可能是锁后复判),
//    在**终审**那一格做不到:`AttendanceSettlementRun.statusCode` 是单值状态机,
//    「终审可受理」(pending_final_review)与「关账可放行」(posted / closed)**互斥** ——
//    终审在飞时,关账在任何交错顺序下都必然 blocked。
//    ⇒ ④ 用的是另一组读数:屏障(证明真的排队)+ 缺口清单只差被赢家挡住的那一类
//    + 零部分写入,并由紧随其后的**正对照**(同一夹具走完整条链之后关账成功)
//    证明它不是恒红。
//
// ⭐ **变异对拍读数(2026-08-25 本机实测,连库跑)**
//    #1182 实测过「这类竞态用例的独占红集往往为空」⇒ 本 spec 立项时就有「会不会是假闸」
//    这个问号,故连库许可一到手就先把它对拍掉。
//
//    变异 = 「八类检查在取锁**之后**重跑」这条不变量的等价否定:在 `close()` 里加一段
//    **取锁之前**的读数,把 `pendingWork.pendingCorrection` 与 `closure.activeClosure`
//    两类决定性计数换成那份锁前快照(**锁照取** ⇒ 屏障读数不变,单独隔离「锁后复判」这一维)。
//
//    | 用例 | 变异后 |
//    |---|---|
//    | ① 两套 pool 前提 | 绿(与被测维无关) |
//    | ② 关账 × 更正 锁后复判 | 🔴 **红** —— 关账被挡,缺口**恰是**预测的两条:`pending_work_exists`(`pendingCorrection: 1`)+ `closure_already_active`(`activeClosure: 1`) |
//    | ③ 两条关账真并发 | 🔴 **红** —— 败者不再是 `blocked`(两条都过了第 ⑧ 类,撞 DB partial unique 抛异常)|
//    | ④ 关账 × 终审 | 绿(该维度锁前锁后读数相同 —— 见上面的诚实标注)|
//
//    ⇒ 红集**精确**(2/4),不是"一改就全红";②的红**落在判决翻转那一行**而不是屏障上,
//      说明这条判据的判别力真的来自「锁后复判」,不是来自屏障顺带。还原后 4/4 复绿。
//
// 时间口径:全部用 2020 年的固定过去时刻(沿前六刀 spec;不耦合墙钟,无定时炸弹)。

/** 北京 2020-03-01 09:00 → 13:00(= UTC 01:00 → 05:00),整块落在北京 03-01。 */
const SESSION_START = new Date('2020-03-01T01:00:00.000Z');
const SESSION_END = new Date('2020-03-01T05:00:00.000Z');
const SEAL_AT = new Date('2020-03-01T09:00:00.000Z');

/** 夹具停在链条的哪一站。 */
type FixtureStage =
  /** run=pending_first_review、version=submitted、零批次 —— 终审那一格用。 */
  | 'submitted'
  /** 账已生效、run=posted、尚未关账 —— 「两条关账并发」用。 */
  | 'posted'
  /** 已关账一次(closure revision 1 active)—— 更正那一格用。 */
  | 'closed';

interface ClosureConcurrencyFixture {
  activityId: string;
  sessionId: string;
  runId: string;
  versionId: string;
  sealId: string;
  contentHash: string;
  memberIds: string[];
  identityIds: string[];
  tag: string;
}

describe('AC-063 关账并发 —— 与最后一次终审 / 最后一个更正按活动锁串行', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;

  let preparation: LedgerPreparationService;
  let posting: LedgerPostingService;
  let closureA: ActivityClosureService;
  /** 🔴 判据的主角:关账跑在**另一套** pool 上,才可能真的排队。 */
  let closureB: ActivityClosureService;
  let correctionA: CorrectionApplicationService;
  let reviewA: SettlementReviewService;
  let correctionAudit: CorrectionAuditRecorder;
  let reviewAudit: SettlementReviewAuditRecorder;
  /** ADV-022:归档也走同一把 Activity 行锁 ⇒ 与关账 / 更正天然可竞。 */
  let archiveB: ActivityArchiveService;
  let closureAudit: ActivityClosureAuditRecorder;
  let activityAuditB: ActivityAuditRecorder;

  /** 结算版本的提交人。§7.5 要求提交人 ≠ 审核人,更正也一样。 */
  let submitter: CurrentUserPayload;
  let reviewerFirst: CurrentUserPayload;
  let reviewerFinal: CurrentUserPayload;
  let organizationId: string;
  let sequence = 0;

  const auditMeta = { requestId: 'activity-closure-concurrency-e2e', ip: null, ua: null };

  beforeAll(async () => {
    // 活动 v1.1 单一 cutover gate(合同 §16.2):本 spec 驱动的是**结算真相链**,
    // 闸关(默认)时这些写入口一律回 20153。显式置真,断言一字未改。
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    appA = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    preparation = appA.get(LedgerPreparationService);
    posting = appA.get(LedgerPostingService);
    closureA = appA.get(ActivityClosureService);
    correctionA = appA.get(CorrectionApplicationService);
    reviewA = appA.get(SettlementReviewService);
    correctionAudit = appA.get(CorrectionAuditRecorder);
    reviewAudit = appA.get(SettlementReviewAuditRecorder);
    closureAudit = appA.get(ActivityClosureAuditRecorder);

    // ⚠️ `resetDb` 只在第一套上跑一次(两套共库);第二套只提供独立连接池。
    appB = await createTestApp();
    prismaB = appB.get(PrismaService);
    closureB = appB.get(ActivityClosureService);
    archiveB = appB.get(ActivityArchiveService);
    activityAuditB = appB.get(ActivityAuditRecorder);

    submitter = await makeActor('closure-conc-submitter');
    reviewerFirst = await makeActor('closure-conc-reviewer-first');
    reviewerFinal = await makeActor('closure-conc-reviewer-final');

    const organization = await prismaA.organization.create({
      data: { name: '关账并发测试组织', nodeTypeCode: 'closure-concurrency-team' },
      select: { id: true },
    });
    organizationId = organization.id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
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

  // =========================================================================
  // 屏障:正面证明关账事务真的堵在 Activity 行锁上
  //
  // `LIKE '%archiveWaitingDays%'` 逐字认的是 `ActivityClosureService.lockActivityAndReadNow`
  // —— 那条 `FOR UPDATE` 是全仓唯一 SELECT `archiveWaitingDays` 的取锁语句,
  // 不会把更正(`SELECT title FROM "Activity"`)或终审(`workflowRevision` 那条)数进来。
  //
  // ⚠️ 轮询上限压到 2.5s:更正 `commit` 走 `runMemberLinearizedTransaction`
  //    (预算 7s = 4s 锁等待 + 3s 干活),被 spy 停住期间还要减去屏障时间 ——
  //    等过头会把"真症状"变成"超时假红"(仓内已有教训)。
  // =========================================================================
  async function waitForClosureLockWaiters(expected: number): Promise<void> {
    const deadline = Date.now() + 2_500;
    let observed = 0;
    while (Date.now() < deadline) {
      const [row] = await prismaA.$queryRaw<Array<{ waitingCount: number }>>`
        SELECT count(*)::int AS "waitingCount"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query LIKE '%archiveWaitingDays%'
          AND query LIKE '%FOR UPDATE%'
      `;
      observed = row?.waitingCount ?? 0;
      if (observed >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`期望至少 ${expected} 条关账事务堵在 Activity 行锁上,实际看到 ${observed}`);
  }

  /**
   * ADV-022 用的两把屏障 —— 与关账那把**逐字认不同的取锁语句**,互相不会数错人:
   *   · 归档 / 生命周期:`ActivityAccessService.lockAndFindActivityOrThrow` 的
   *     `SELECT id FROM "Activity" … FOR UPDATE`(关账那条是 `SELECT title, "statusCode", …`,
   *     更正那条是 `SELECT title FROM "Activity"` —— 三条前缀两两不相交);
   *   · 更正:`CorrectionApplicationService.lockActivity` 的 `SELECT title FROM "Activity"`。
   *
   * ⚠️ 轮询上限同样压到 2.5s:被冻住的一方是 Prisma 交互事务(归档走默认 5000ms 预算),
   *    等过头会把"真症状"变成"超时假红"。
   */
  async function waitForRowLockWaiters(
    lockSqlNeedle: string,
    expected: number,
    label: string,
  ): Promise<void> {
    const deadline = Date.now() + 2_500;
    let observed = 0;
    while (Date.now() < deadline) {
      const [row] = await prismaA.$queryRaw<Array<{ waitingCount: number }>>`
        SELECT count(*)::int AS "waitingCount"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query LIKE ${`%${lockSqlNeedle}%`}
          AND query LIKE '%FOR UPDATE%'
      `;
      observed = row?.waitingCount ?? 0;
      if (observed >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`期望至少 ${expected} 条${label}事务堵在 Activity 行锁上,实际看到 ${observed}`);
  }

  const ARCHIVE_LOCK_SQL = 'SELECT id FROM "Activity"';
  const CORRECTION_LOCK_SQL = 'SELECT title FROM "Activity"';

  /** 归档被拒时的完整取证:六列一列都没写,活动状态原地不动。 */
  async function expectArchiveColumnsUntouched(activityId: string): Promise<void> {
    const row = await prismaA.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: {
        statusCode: true,
        archivedAt: true,
        archivedByUserId: true,
        archivedFromStatusCode: true,
        archiveReasonCode: true,
        archiveOperationKey: true,
      },
    });
    expect(row).toEqual({
      statusCode: 'published',
      archivedAt: null,
      archivedByUserId: null,
      archivedFromStatusCode: null,
      archiveReasonCode: null,
      archiveOperationKey: null,
    });
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

  /** 等某个被冻住的事务真的走到最后一步。 */
  async function waitUntilHeld(reached: () => number): Promise<void> {
    const deadline = Date.now() + 8_000;
    while (reached() === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (reached() === 0) throw new Error('赢家事务没有走到最后一步,屏障无法建立');
  }

  /** 当前处于 `active` 的关闭版本。 */
  async function activeClosures(
    activityId: string,
  ): Promise<Array<{ revision: number; statusCode: string }>> {
    return await prismaA.activitySettlementClosureRevision.findMany({
      where: { activityId, statusCode: 'active' },
      select: { revision: true, statusCode: true },
      orderBy: { revision: 'asc' },
    });
  }

  async function closureRevisionCount(activityId: string): Promise<number> {
    return await prismaA.activitySettlementClosureRevision.count({ where: { activityId } });
  }

  // =========================================================================
  // 夹具:一场真的走完打卡 → 封场 → 结算 →(可选)账本 →(可选)关账的活动
  //
  // 与既有关账 / 更正 spec 同形(那两份各自也有一份本地副本 —— 本仓 e2e 夹具的既定组织
  // 方式),只多一个 `stage` 参数,用来停在链条不同的站上。
  // =========================================================================
  async function createFixture(options: {
    stage: FixtureStage;
    memberCount?: number;
  }): Promise<ClosureConcurrencyFixture> {
    const memberCount = options.memberCount ?? 2;
    const recognizedHours = 4;
    const recognizedPoints = 1.2;
    sequence += 1;
    const tag = `closure-conc-${sequence}`;

    const activity = await prismaA.activity.create({
      data: {
        title: `关账并发活动 ${sequence}`,
        activityTypeCode: `closure-conc-type-${sequence}`,
        organizationId,
        startAt: SESSION_START,
        endAt: SESSION_END,
        location: '深圳',
        statusCode: 'published',
      },
      select: { id: true },
    });

    const session = await prismaA.activitySession.create({
      data: {
        activityId: activity.id,
        code: `${tag}-s0`,
        name: `${tag} 场次`,
        startAt: SESSION_START,
        endAt: SESSION_END,
        locationText: '深圳',
        checkInOpenAt: new Date(SESSION_START.getTime() - 3600_000),
        checkInCloseAt: new Date(SESSION_START.getTime() + 3600_000),
        checkOutOpenAt: SESSION_START,
        checkOutCloseAt: new Date(SESSION_END.getTime() + 3600_000),
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });

    const memberIds = Array.from({ length: memberCount }, () => randomUUID());
    await prismaA.member.createMany({
      data: memberIds.map((id, index) => ({
        id,
        memberNo: `${tag}-m${index}`,
        ...memberIdentityData(`${tag} 队员 ${index}`),
        gradeCode: 'level-2',
      })),
    });
    const registrationIds = memberIds.map(() => randomUUID());
    await prismaA.activityRegistration.createMany({
      data: registrationIds.map((id, index) => ({
        id,
        activityId: activity.id,
        memberId: memberIds[index],
        statusCode: 'pass',
      })),
    });

    const ownerMember = await prismaA.member.create({
      data: {
        memberNo: `${tag}-owner`,
        ...memberIdentityData(`${tag} 负责人`),
        gradeCode: 'level-2',
      },
      select: { id: true },
    });
    await prismaA.activityResponsibilityAssignment.create({
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

    const seal = await prismaA.evidenceSeal.create({
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
        sealedByUserId: submitter.id,
        sealedAt: SEAL_AT,
      },
      select: { id: true },
    });

    const stage = options.stage;
    const run = await prismaA.attendanceSettlementRun.create({
      data: {
        activityId: activity.id,
        // `submitted` 站停在一审之前;其余两站沿既有关账 / 更正夹具的 `posting`。
        statusCode: stage === 'submitted' ? 'pending_first_review' : 'posting',
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
        personCount: memberCount,
        sessionParticipationCount: memberCount,
        serviceSegmentCount: memberCount,
        createdByUserId: submitter.id,
        submittedAt: SEAL_AT,
        statusCode: stage === 'submitted' ? 'submitted' : 'approved',
        operationKey: `${tag}-submit-key`,
        requestHash: `${tag}-submit-hash`,
      },
      select: { id: true },
    });

    const identityIds: string[] = [];
    for (let index = 0; index < memberCount; index += 1) {
      const identity = await prismaA.activityParticipationIdentity.create({
        data: {
          activityId: activity.id,
          sessionId: session.id,
          registrationId: registrationIds[index],
          memberId: memberIds[index],
          currentStatusCode: 'pass',
          populationIncluded: true,
        },
        select: { id: true },
      });
      identityIds.push(identity.id);

      const checkIn = await prismaA.attendancePunchEvent.create({
        data: {
          activityId: activity.id,
          sessionId: session.id,
          participationIdentityId: identity.id,
          memberId: memberIds[index],
          eventTypeCode: 'check_in',
          sourceCode: 'self_qr',
          occurredAt: SESSION_START,
          receivedAt: SESSION_START,
          operatorUserId: submitter.id,
          eventKey: `${tag}-in-${index}`,
          requestHash: `${tag}-in-hash-${index}`,
          evidenceRevision: 0,
        },
        select: { id: true },
      });
      await prismaA.participantServiceSegmentRevision.create({
        data: {
          participationIdentityId: identity.id,
          segmentKey: 'seg-0',
          revision: 0,
          sourceCheckInEventId: checkIn.id,
          resultCode: 'valid',
          statusCode: 'draft',
          checkInAt: SESSION_START,
          checkOutAt: new Date(SESSION_START.getTime() + 2 * 3600_000),
          serviceHours: 2,
        },
      });
      await prismaA.participantSettlementResultRevision.create({
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
      });
    }

    const fixture: ClosureConcurrencyFixture = {
      activityId: activity.id,
      sessionId: session.id,
      runId: run.id,
      versionId: version.id,
      sealId: seal.id,
      contentHash,
      memberIds,
      identityIds,
      tag,
    };

    if (stage === 'submitted') return fixture;

    const batch = await prismaA.ledgerPostingBatch.create({
      data: {
        settlementRunId: run.id,
        settlementVersionId: version.id,
        batchRevision: 1,
        statusCode: 'preparing',
        requestKey: `settlement-final-approve:${version.id}:${tag}`,
        requestHash: `${tag}-approve-hash`,
        totalCount: memberCount,
        preparedByUserId: submitter.id,
      },
      select: { id: true },
    });
    await runLedger(batch.id, `${tag}-fixture`);

    if (stage === 'closed') {
      const outcome = await closureA.close(
        activity.id,
        { operationKey: `${tag}-close-key`, requestHash: `${tag}-close-hash` },
        submitter,
        auditMeta,
      );
      if (outcome.outcome !== 'closed') {
        throw new Error(`夹具建立失败:首次关账被缺口挡下 ${JSON.stringify(outcome.gaps)}`);
      }
    }
    return fixture;
  }

  /** 走**真实**的第五刀:分块准备 → 短事务统一生效(不手搓账本)。 */
  async function runLedger(batchId: string, keyTag: string): Promise<void> {
    const { jobId } = await preparation.ensurePrepareJob(batchId);
    const items = await prismaA.activityBatchJobItem.findMany({
      where: { jobId },
      select: { id: true },
      orderBy: { itemKey: 'asc' },
    });
    for (const item of items) await preparation.prepareChunk(jobId, item.id);
    await preparation.finalize(jobId);
    await posting.commitBatch(
      { postingBatchId: batchId, operationKey: `${keyTag}-commit-key` },
      submitter,
      auditMeta,
    );
  }

  function reviewInput(fixture: ClosureConcurrencyFixture, suffix: string): SettlementReviewInput {
    return {
      activityId: fixture.activityId,
      actionCode: 'approve',
      operationKey: `${fixture.tag}-review-${suffix}`,
      requestHash: `${fixture.tag}-review-hash-${suffix}`,
      expectation: {
        evidenceSealId: fixture.sealId,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: fixture.contentHash,
      },
    };
  }

  /** 把第 0 个人的认定贡献值改成 `points`(时长不动)。 */
  function pointsChange(
    fixture: ClosureConcurrencyFixture,
    points: string,
  ): Record<string, unknown> {
    return {
      schemaVersion: CORRECTION_CHANGE_SCHEMA_VERSION,
      results: [
        {
          participationIdentityId: fixture.identityIds[0],
          resultCode: 'present',
          recognizedServiceHours: '4.00',
          recognizedContributionPoints: points,
          // 认定 ≠ 计算 ⇒ `participant_settlement_result_adjustment_reason_check` 要求必填。
          adjustmentReason: '负责人复核后更正',
          lateFlag: false,
          earlyLeaveFlag: false,
        },
      ],
      segments: [],
    };
  }

  // =========================================================================
  // ① 前提:两套实例确实是两套 pool
  //
  // 没有这一条,下面所有"并发"都可能只是同一条连接上的先后调用 —— 判据整组失效。
  // =========================================================================
  it('两套 Nest 实例确实是两套 pool(本组判据的前提)', async () => {
    expect(prismaA).not.toBe(prismaB);
    expect(appA.getHttpServer()).not.toBe(appB.getHttpServer());
    const [[backendA], [backendB]] = await Promise.all([
      prismaA.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
      prismaB.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
    ]);
    expect(backendA?.pid).not.toBe(backendB?.pid);
  });

  // =========================================================================
  // ② ⭐ 关账 × 最后一个更正 —— **锁后复判**(合同句里的「不漏检查」)
  //
  // 构造:更正的 `commit` 事务停在最后一步(审计),此刻它已经
  //   · 把 closure revision 1 顶成 superseded、清掉 Activity 的关账指针,
  //   · 把更正申请推到终态,
  // 但**还没 commit** ⇒ 从事务外看,这两件事都还没发生。
  //
  // 🔴 判据的核心读数:关账**发起的那一刻**,入口世界里同时有
  //     `closure_already_active`(rev 1 还挂着 active)与
  //     `pending_work_exists`(更正申请还在 `applying`)两类缺口 ——
  //     **若八类检查在锁前跑,关账必然 blocked**。
  //   它实际返回 `closed` ⇒ 只可能是拿到 Activity 行锁**之后**重跑的检查。
  //   把 `evaluateChecks` 挪到 `lockActivityAndReadNow` 之前,这条用例当场变红。
  // =========================================================================
  it('⭐ 更正 commit 在关账等锁期间落地 ⇒ 关账按**锁后**状态复判并成功(不漏检查)', async () => {
    const fixture = await createFixture({ stage: 'closed' });

    const submitted = await correctionA.submit(
      {
        activityId: fixture.activityId,
        participationIdentityId: fixture.identityIds[0],
        requestTypeCode: 'points',
        requestedChangeJson: pointsChange(fixture, '0.60'),
        reason: '现场记录有误,认定贡献值需要更正',
        operationKey: `${fixture.tag}-correction-1`,
        requestHash: `${fixture.tag}-correction-hash-1`,
      },
      submitter,
      auditMeta,
    );
    const reviewed = await correctionA.review(
      { correctionRequestId: submitted.correctionRequestId, actionCode: 'approve' },
      reviewerFirst,
      auditMeta,
    );
    expect(reviewed.outcome).toBe('reviewed');
    const applyArgs = {
      correctionRequestId: submitted.correctionRequestId,
      operationKey: `${fixture.tag}-apply-1`,
      requestHash: `${fixture.tag}-apply-hash-1`,
    };
    await correctionA.prepare(applyArgs, submitter, auditMeta);

    // 更正 commit 停在最后一步(审计),握着 Activity 行锁。
    // ⚠️ 先 `passThrough` 再等闸:审计行必须真的写下去,否则冻住的就不是
    //    "完整事务差一步 commit",而是一个内容不同的事务。
    const passThrough = correctionAudit.logCommit.bind(correctionAudit);
    let releaseCommit!: () => void;
    const commitHeld = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const commitSpy = jest
      .spyOn(correctionAudit, 'logCommit')
      .mockImplementationOnce(async (args: Parameters<typeof passThrough>[0]) => {
        await passThrough(args);
        await commitHeld; // ← 事务停在这里,Activity 行锁没放
      });

    const commitPromise = correctionA.commit(applyArgs, submitter, auditMeta);
    let closePromise: ReturnType<ActivityClosureService['close']> | undefined;
    let barrierError: unknown;
    try {
      await waitUntilHeld(() => commitSpy.mock.calls.length);

      // 🔴 入口时刻的读数(**不在任何事务里**)—— 若在锁前判,这两类缺口都非零。
      expect(await activeClosures(fixture.activityId)).toEqual([
        { revision: 1, statusCode: 'active' },
      ]);
      await expect(
        prismaA.attendanceCorrectionRequest.count({
          where: { activityId: fixture.activityId, statusCode: 'applying' },
        }),
      ).resolves.toBe(1);

      // B 实例发起关账 —— 它只能堵在更正握着的 Activity 行锁上。
      closePromise = closureB.close(
        fixture.activityId,
        {
          operationKey: `${fixture.tag}-manual-close`,
          requestHash: `${fixture.tag}-manual-close-hash`,
        },
        submitter,
        auditMeta,
      );
      await waitForClosureLockWaiters(1);

      // 关账**已经在等锁**,而入口世界仍然是"有 active closure + 有进行中更正"。
      expect(await activeClosures(fixture.activityId)).toEqual([
        { revision: 1, statusCode: 'active' },
      ]);
    } catch (error) {
      barrierError = error;
    } finally {
      releaseCommit();
      await commitPromise;
    }
    if (barrierError !== undefined) {
      if (closePromise !== undefined) await closePromise.catch(() => undefined);
      if (barrierError instanceof Error) throw barrierError;
      throw new Error('屏障等待抛出了非 Error 值,无法转述');
    }
    if (closePromise === undefined) throw new Error('关账没有被发起');

    const outcome = await closePromise;
    // 🔴 正靶:锁后复判 ⇒ 两类缺口都已被赢家消掉 ⇒ 关账成功,并且是**新一版**。
    if (outcome.outcome !== 'closed') {
      throw new Error(`关账应在锁后复判时通过,实际被挡:${JSON.stringify(outcome.gaps)}`);
    }
    expect(outcome.closure.revision).toBe(2);
    expect(outcome.closure.replayed).toBe(false);

    // 🔴 不重复关闭:两条 revision 里恰好一条 active,且是新的那条。
    expect(await closureRevisionCount(fixture.activityId)).toBe(2);
    expect(await activeClosures(fixture.activityId)).toEqual([
      { revision: 2, statusCode: 'active' },
    ]);
  });

  // =========================================================================
  // ③ 关账 × 关账 真并发 —— 「不重复关闭」的最短路径
  //
  // ⚠️ 与 `activity-settlement-closure.e2e-spec.ts` 里那条同名意图的用例**不是重复**:
  //    那一条是单 app / 单 pool 的 `Promise.all`(两条调用会先后串行跑完);
  //    这一条是两套 pool + 闸门事务,并用 `pg_stat_activity` 正面证明**两条都在等锁**。
  // =========================================================================
  it('两条关账真并发(不同 key)⇒ 恰一条成功,败者 closure_already_active,库里恰一张 active', async () => {
    const fixture = await createFixture({ stage: 'posted' });
    const gate = await holdActivityLock(fixture.activityId);

    const a = closureA.close(
      fixture.activityId,
      { operationKey: `${fixture.tag}-race-a`, requestHash: `${fixture.tag}-race-a-hash` },
      submitter,
      auditMeta,
    );
    const b = closureB.close(
      fixture.activityId,
      { operationKey: `${fixture.tag}-race-b`, requestHash: `${fixture.tag}-race-b-hash` },
      submitter,
      auditMeta,
    );

    let barrierError: unknown;
    try {
      await waitForClosureLockWaiters(2);
    } catch (error) {
      barrierError = error;
    } finally {
      gate.release();
      await gate.done;
    }
    const results = await Promise.allSettled([a, b]);
    if (barrierError instanceof Error) throw barrierError;
    if (barrierError !== undefined) throw new Error('屏障等待抛出了非 Error 值,无法转述');

    const settled = results.map((result) =>
      result.status === 'fulfilled' ? result.value : undefined,
    );
    expect(settled.filter((value) => value?.outcome === 'closed')).toHaveLength(1);
    const loser = settled.find((value) => value?.outcome === 'blocked');
    if (loser === undefined || loser.outcome !== 'blocked') {
      throw new Error('应当恰好有一条被挡下');
    }
    // 🔴 败者收到的必须**只有**「已有生效关闭版本」这一条 —— 混进 settlement / ledger
    //    噪声就说明它读的不是赢家提交后的状态。
    expect(loser.gaps.map((gap) => gap.gapCode)).toEqual(['closure_already_active']);

    expect(await closureRevisionCount(fixture.activityId)).toBe(1);
    expect(await activeClosures(fixture.activityId)).toEqual([
      { revision: 1, statusCode: 'active' },
    ]);
  });

  // =========================================================================
  // ④ ⭐ 关账 × 最后一次终审 —— 按活动锁串行 + 零部分写入 + 正对照
  //
  // 构造:终审的事务停在最后一步(审计),此刻它已经写下审核动作行、把版本推到
  // `approved`、开出 `preparing` 批次、把 run 推到 `posting`,但**还没 commit**。
  // 关账在 B 实例发起 ⇒ 只能堵在终审握着的 Activity 行锁上(屏障正面证明)。
  //
  // ⚠️ **诚实标注**:这一格做不成"判决翻转"(见文件头)——`run.statusCode` 是单值状态机,
  //    「终审可受理」与「关账可放行」互斥,终审在飞时关账在任一交错顺序下都必然 blocked。
  //    ⇒ 本条的四组读数分别是:
  //      (a) 屏障 —— 关账**确实**排在 Activity 行锁后面(锁被挪走 / 挪到检查之后 ⇒ 读数归零 ⇒ 红);
  //      (b) 缺口清单**只有**结算未完成那一类,其余六类逐条不在里面
  //          —— 反面样本在被测那一维上单独不同:夹具在别的维度上全部合格;
  //      (c) 零部分写入 —— 关账一行都没写下,Activity 的关账指针仍是 null;
  //      (d) 正对照 —— 同一夹具把账走完之后关账**成功**,证明 (b) 不是恒红。
  // =========================================================================
  it('⭐ 终审 commit 在关账等锁期间落地 ⇒ 关账排在同一把 Activity 锁后,按锁后状态判缺口且零写入', async () => {
    const fixture = await createFixture({ stage: 'submitted' });
    await reviewA.firstReview(reviewInput(fixture, 'first'), reviewerFirst, auditMeta);

    const passThrough = reviewAudit.log.bind(reviewAudit);
    let releaseFinal!: () => void;
    const finalHeld = new Promise<void>((resolve) => {
      releaseFinal = resolve;
    });
    const reviewSpy = jest
      .spyOn(reviewAudit, 'log')
      .mockImplementationOnce(async (args: Parameters<typeof passThrough>[0]) => {
        await passThrough(args);
        await finalHeld; // ← 终审事务停在这里,Activity 行锁没放
      });

    const finalPromise = reviewA.finalReview(
      reviewInput(fixture, 'final'),
      reviewerFinal,
      auditMeta,
    );
    let closePromise: ReturnType<ActivityClosureService['close']> | undefined;
    let barrierError: unknown;
    try {
      await waitUntilHeld(() => reviewSpy.mock.calls.length);

      // 入口时刻的读数:终审的写入一件都还看不见。
      await expect(
        prismaA.attendanceSettlementRun.findUniqueOrThrow({
          where: { id: fixture.runId },
          select: { statusCode: true },
        }),
      ).resolves.toEqual({ statusCode: 'pending_final_review' });
      await expect(
        prismaA.ledgerPostingBatch.count({ where: { settlementRunId: fixture.runId } }),
      ).resolves.toBe(0);

      closePromise = closureB.close(
        fixture.activityId,
        {
          operationKey: `${fixture.tag}-close-vs-final`,
          requestHash: `${fixture.tag}-close-vs-final-hash`,
        },
        submitter,
        auditMeta,
      );
      // (a) 关账确实堵在终审握着的那把 Activity 行锁上。
      await waitForClosureLockWaiters(1);
    } catch (error) {
      barrierError = error;
    } finally {
      releaseFinal();
      await finalPromise;
    }
    if (barrierError !== undefined) {
      if (closePromise !== undefined) await closePromise.catch(() => undefined);
      if (barrierError instanceof Error) throw barrierError;
      throw new Error('屏障等待抛出了非 Error 值,无法转述');
    }
    if (closePromise === undefined) throw new Error('关账没有被发起');

    const outcome = await closePromise;
    if (outcome.outcome !== 'blocked') {
      throw new Error('终审刚落地、账还没生效,关账不允许通过');
    }
    const gapCodes = outcome.gaps.map((gap) => gap.gapCode);
    // (b) 只差"结算没生效"这一类;其余六类逐条不在缺口里 —— 夹具在别的维度上全部合格。
    expect(gapCodes).toContain('settlement_incomplete');
    expect(gapCodes).not.toContain('execution_not_ended');
    expect(gapCodes).not.toContain('evidence_not_sealed');
    expect(gapCodes).not.toContain('pending_work_exists');
    expect(gapCodes).not.toContain('participation_unresolved');
    expect(gapCodes).not.toContain('result_inconsistent');
    expect(gapCodes).not.toContain('closure_already_active');

    // (c) 零部分写入:关账被挡时事务里全是 SELECT。
    expect(await closureRevisionCount(fixture.activityId)).toBe(0);
    await expect(
      prismaA.activity.findUniqueOrThrow({
        where: { id: fixture.activityId },
        select: { currentClosureRevision: true },
      }),
    ).resolves.toEqual({ currentClosureRevision: null });

    // 终审自己的效果恰好落地一次(赢家没被败者影响)。
    await expect(
      prismaA.ledgerPostingBatch.count({ where: { settlementRunId: fixture.runId } }),
    ).resolves.toBe(1);
    await expect(
      prismaA.attendanceSettlementRun.findUniqueOrThrow({
        where: { id: fixture.runId },
        select: { statusCode: true },
      }),
    ).resolves.toEqual({ statusCode: 'posting' });

    // (d) 正对照:同一夹具把账走完 ⇒ 关账成功。证明上面的 blocked 不是"恒红"。
    const batch = await prismaA.ledgerPostingBatch.findFirstOrThrow({
      where: { settlementRunId: fixture.runId },
      select: { id: true },
    });
    await runLedger(batch.id, `${fixture.tag}-after-final`);
    const after = await closureA.close(
      fixture.activityId,
      {
        operationKey: `${fixture.tag}-close-after-final`,
        requestHash: `${fixture.tag}-close-after-final-hash`,
      },
      submitter,
      auditMeta,
    );
    if (after.outcome !== 'closed') {
      throw new Error(`正对照失败:账走完后关账仍被挡 ${JSON.stringify(after.gaps)}`);
    }
    expect(await activeClosures(fixture.activityId)).toEqual([
      { revision: 1, statusCode: 'active' },
    ]);
  });

  // =========================================================================
  // ⑤ ADV-022 —— 「更正提交或生效与关账、归档同时发生」(2026-08-26 补)
  //
  // 合同原句(对抗项 ADV-022,逐字):
  //   「更正提交或生效与关账、归档同时发生。」
  //
  // 这一句是一张 2×2 的表:{更正**提交**, 更正**生效**} × {关账, 归档}。逐格去向:
  //   | | 关账 | 归档 |
  //   |---|---|---|
  //   | 更正生效 | ✅ 已由上面 ② 号用例覆盖(更正 commit × 关账,判决翻转) | ⑤-a 本组 |
  //   | 更正提交 | ⑤-b 本组 | ⑤-c 本组 |
  //   另加 ⑤-d「归档 × 关账」—— 归档取的是与关账**同一把** Activity `FOR UPDATE`,
  //   这条接缝是 2026-08-25 归档刀新造出来的,此前全仓零并发用例。
  //
  // ⭐ 三条判决翻转(⑤-a / ⑤-b / ⑤-d)都按同一个形状构造:
  //    让**入口时刻**的世界给出与最终结论**相反**的答案 ——
  //    「若在取锁之前判,必然是 X;实际返回 ¬X ⇒ 只可能是拿到 Activity 行锁之后重判的」。
  //    这比「反正只有一个成功」强得多:后者在**完全没有锁**的实现上也常常是绿的。
  //
  // 🔴 屏障一律**正面数出锁等待者**(`pg_stat_activity.wait_event_type='Lock'`),
  //    数不到就抛 —— 「没成功」不等于「排过队」。
  //
  // 🔴 每一维各自成 `it`:jest 在一个 `it` 内首个失败即停,塞一起会让后面的断言
  //    从未被执行,而这在基线全绿时完全看不出来。
  // =========================================================================

  /** 把一条更正推到「已批准、已准备」——差最后一步 commit。 */
  async function prepareCorrection(
    fixture: ClosureConcurrencyFixture,
    suffix: string,
  ): Promise<{ correctionRequestId: string; operationKey: string; requestHash: string }> {
    const submitted = await correctionA.submit(
      {
        activityId: fixture.activityId,
        participationIdentityId: fixture.identityIds[0],
        requestTypeCode: 'points',
        requestedChangeJson: pointsChange(fixture, '0.60'),
        reason: '现场记录有误,认定贡献值需要更正',
        operationKey: `${fixture.tag}-correction-${suffix}`,
        requestHash: `${fixture.tag}-correction-hash-${suffix}`,
      },
      submitter,
      auditMeta,
    );
    const reviewed = await correctionA.review(
      { correctionRequestId: submitted.correctionRequestId, actionCode: 'approve' },
      reviewerFirst,
      auditMeta,
    );
    expect(reviewed.outcome).toBe('reviewed');
    const applyArgs = {
      correctionRequestId: submitted.correctionRequestId,
      operationKey: `${fixture.tag}-apply-${suffix}`,
      requestHash: `${fixture.tag}-apply-hash-${suffix}`,
    };
    await correctionA.prepare(applyArgs, submitter, auditMeta);
    return applyArgs;
  }

  /** 「等待期已经过去了吗」—— 拿 **DB 的** now() 与 active closure 的 closedAt 比,不用本机墙钟。 */
  async function archiveWaitingElapsed(activityId: string): Promise<boolean> {
    const [row] = await prismaA.$queryRaw<Array<{ elapsed: boolean }>>`
      SELECT (now() >= c."closedAt" + (a."archiveWaitingDays" || ' days')::interval) AS elapsed
      FROM "ActivitySettlementClosureRevision" c
      JOIN "Activity" a ON a.id = c."activityId"
      WHERE c."activityId" = ${activityId} AND c."statusCode" = 'active'
    `;
    if (row === undefined) throw new Error('取不到 active closure,前提不成立');
    return row.elapsed;
  }

  // ---------------------------------------------------------------------
  // ⑤-a 更正**生效** × 归档 —— 判决翻转:入口放行 → 锁后 20156
  // ---------------------------------------------------------------------
  it('⭐ ADV-022 更正 commit 在归档等锁期间落地 ⇒ 归档按锁后状态复判、被 20156 挡下且零写入', async () => {
    const fixture = await createFixture({ stage: 'closed' });
    // 等待期设 0 ⇒ 关账那一刻起就满足「过了等待期」。这样**入口世界里归档是放行的**,
    // 结论一旦翻成拒绝,就只可能来自锁后复判。
    await prismaA.activity.update({
      where: { id: fixture.activityId },
      data: { archiveWaitingDays: 0 },
    });
    const applyArgs = await prepareCorrection(fixture, 'archive-race');

    // 更正 commit 停在最后一步(审计),握着 Activity 行锁。
    // ⚠️ 先 `passThrough` 再等闸:审计行必须真的写下去,否则冻住的就不是
    //    "完整事务差一步 commit",而是一个内容不同的事务。
    const passThrough = correctionAudit.logCommit.bind(correctionAudit);
    let releaseCommit!: () => void;
    const commitHeld = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const commitSpy = jest
      .spyOn(correctionAudit, 'logCommit')
      .mockImplementationOnce(async (args: Parameters<typeof passThrough>[0]) => {
        await passThrough(args);
        await commitHeld; // ← 事务停在这里,Activity 行锁没放
      });

    const commitPromise = correctionA.commit(applyArgs, submitter, auditMeta);
    let archivePromise: ReturnType<ActivityArchiveService['archive']> | undefined;
    let barrierError: unknown;
    try {
      await waitUntilHeld(() => commitSpy.mock.calls.length);

      // 🔴 入口时刻的读数(**不在任何事务里**):active closure 还挂着、等待期已过
      //    ⇒ **若归档在锁前判,它必然放行**。
      expect(await activeClosures(fixture.activityId)).toEqual([
        { revision: 1, statusCode: 'active' },
      ]);
      await expect(archiveWaitingElapsed(fixture.activityId)).resolves.toBe(true);

      // B 实例发起归档 —— 它只能堵在更正握着的 Activity 行锁上。
      archivePromise = archiveB.archive(
        fixture.activityId,
        { operationKey: `${fixture.tag}-archive-vs-correction` },
        submitter,
        auditMeta,
      );
      await waitForRowLockWaiters(ARCHIVE_LOCK_SQL, 1, '归档');

      // 归档**已经在等锁**,而入口世界仍然是"有 active closure 且等待期已过"。
      expect(await activeClosures(fixture.activityId)).toEqual([
        { revision: 1, statusCode: 'active' },
      ]);
    } catch (error) {
      barrierError = error;
    } finally {
      releaseCommit();
      await commitPromise;
    }
    if (barrierError !== undefined) {
      if (archivePromise !== undefined) await archivePromise.catch(() => undefined);
      if (barrierError instanceof Error) throw barrierError;
      throw new Error('屏障等待抛出了非 Error 值,无法转述');
    }
    if (archivePromise === undefined) throw new Error('归档没有被发起');

    // 🔴 判决翻转:入口"放行" → 实际"未关账"。更正把 closure 顶成 superseded 之后,
    //    归档读到的 active closure 是 null ⇒ 具名码 20156(而不是 20157,更不是成功)。
    const rejected = archivePromise;
    await expect(rejected).rejects.toBeInstanceOf(BizException);
    await rejected.catch((error: unknown) => {
      expect((error as BizException).biz).toBe(BizCode.ACTIVITY_ARCHIVE_NOT_CLOSED);
    });

    // 零写入 + 赢家的效果确实落地了(不是"归档失败因为更正也失败了")。
    await expectArchiveColumnsUntouched(fixture.activityId);
    expect(await activeClosures(fixture.activityId)).toEqual([]);
    expect(await closureRevisionCount(fixture.activityId)).toBe(1);
  });

  // ---------------------------------------------------------------------
  // ⑤-b 更正**提交** × 关账 —— 判决翻转:入口八类全过 → 锁后 pending_work_exists
  // ---------------------------------------------------------------------
  it('⭐ ADV-022 更正 submit 在关账等锁期间落地 ⇒ 关账按锁后状态复判、被 pending_work_exists 挡下且零写入', async () => {
    const fixture = await createFixture({ stage: 'posted' });

    // 更正 submit 停在最后一步(审计),握着 Activity 行锁。
    const passThrough = correctionAudit.logSubmit.bind(correctionAudit);
    let releaseSubmit!: () => void;
    const submitHeld = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    const submitSpy = jest
      .spyOn(correctionAudit, 'logSubmit')
      .mockImplementationOnce(async (args: Parameters<typeof passThrough>[0]) => {
        await passThrough(args);
        await submitHeld; // ← 事务停在这里,Activity 行锁没放
      });

    const submitPromise = correctionA.submit(
      {
        activityId: fixture.activityId,
        participationIdentityId: fixture.identityIds[0],
        requestTypeCode: 'points',
        requestedChangeJson: pointsChange(fixture, '0.60'),
        reason: '现场记录有误,认定贡献值需要更正',
        operationKey: `${fixture.tag}-submit-vs-close`,
        requestHash: `${fixture.tag}-submit-vs-close-hash`,
      },
      submitter,
      auditMeta,
    );
    let closePromise: ReturnType<ActivityClosureService['close']> | undefined;
    let barrierError: unknown;
    try {
      await waitUntilHeld(() => submitSpy.mock.calls.length);

      // 🔴 入口时刻的读数:更正的写入一件都还看不见 —— run 还是 `posted`、
      //    一条开放更正都没有 ⇒ **若关账在锁前判,八类全过、必然成功**。
      await expect(
        prismaA.attendanceSettlementRun.findUniqueOrThrow({
          where: { id: fixture.runId },
          select: { statusCode: true },
        }),
      ).resolves.toEqual({ statusCode: 'posted' });
      await expect(
        prismaA.attendanceCorrectionRequest.count({ where: { activityId: fixture.activityId } }),
      ).resolves.toBe(0);
      expect(await activeClosures(fixture.activityId)).toEqual([]);

      closePromise = closureB.close(
        fixture.activityId,
        {
          operationKey: `${fixture.tag}-close-vs-submit`,
          requestHash: `${fixture.tag}-close-vs-submit-hash`,
        },
        submitter,
        auditMeta,
      );
      await waitForClosureLockWaiters(1);
    } catch (error) {
      barrierError = error;
    } finally {
      releaseSubmit();
      await submitPromise;
    }
    if (barrierError !== undefined) {
      if (closePromise !== undefined) await closePromise.catch(() => undefined);
      if (barrierError instanceof Error) throw barrierError;
      throw new Error('屏障等待抛出了非 Error 值,无法转述');
    }
    if (closePromise === undefined) throw new Error('关账没有被发起');

    const outcome = await closePromise;
    // 🔴 判决翻转:入口"八类全过" → 实际被挡,且缺口里**恰有**刚落地的那条开放更正。
    if (outcome.outcome !== 'blocked') {
      throw new Error('更正刚提交、还开着,关账不允许通过');
    }
    const pendingWorkGap = outcome.gaps.find((gap) => gap.gapCode === 'pending_work_exists');
    if (pendingWorkGap === undefined) {
      throw new Error(`缺口里没有 pending_work_exists:${JSON.stringify(outcome.gaps)}`);
    }
    expect(pendingWorkGap.details.pendingCorrection).toBe(1);

    // 零部分写入:关账被挡时事务里全是 SELECT。
    expect(await closureRevisionCount(fixture.activityId)).toBe(0);
    await expect(
      prismaA.activity.findUniqueOrThrow({
        where: { id: fixture.activityId },
        select: { currentClosureRevision: true },
      }),
    ).resolves.toEqual({ currentClosureRevision: null });

    // 正对照:把这条更正驳回(`rejected` 不再占住 target,run 交回常态)⇒ 关账成功。
    // 没有它,上面的 blocked 也可能只是"这个夹具本来就关不了账"。
    const openRequest = await prismaA.attendanceCorrectionRequest.findFirstOrThrow({
      where: { activityId: fixture.activityId },
      select: { id: true },
    });
    await correctionA.review(
      { correctionRequestId: openRequest.id, actionCode: 'reject' },
      reviewerFirst,
      auditMeta,
    );
    const after = await closureA.close(
      fixture.activityId,
      {
        operationKey: `${fixture.tag}-close-after-reject`,
        requestHash: `${fixture.tag}-close-after-reject-hash`,
      },
      submitter,
      auditMeta,
    );
    if (after.outcome !== 'closed') {
      throw new Error(`正对照失败:更正驳回后关账仍被挡 ${JSON.stringify(after.gaps)}`);
    }
    expect(await activeClosures(fixture.activityId)).toEqual([
      { revision: 1, statusCode: 'active' },
    ]);
  });

  // ---------------------------------------------------------------------
  // ⑤-c 更正**提交** × 归档 —— 归档赢了锁,合法更正仍然提得进来
  //
  // 这一格**不是**判决翻转(更正提交不看活动状态,归档也不看在飞的更正),
  // 读数是另外三组:①屏障(更正确实排在归档的锁后面)②归档赢家的效果落地
  // ③🔴 更正在活动已 `archived` 之后**照样提交成功** —— 这正是 AC-064 后半句
  //   「合法更正不因(等待期过去 / 已归档)而被永久禁止」在归档这一侧的读数。
  // ---------------------------------------------------------------------
  it('ADV-022 归档握锁时更正提交排队 ⇒ 归档落地后更正仍提交成功(合法更正不被归档禁掉)', async () => {
    const fixture = await createFixture({ stage: 'closed' });
    await prismaA.activity.update({
      where: { id: fixture.activityId },
      data: { archiveWaitingDays: 0 },
    });
    await expect(archiveWaitingElapsed(fixture.activityId)).resolves.toBe(true);

    // 归档(B 实例)停在最后一步(审计),握着 Activity 行锁。
    const passThrough = activityAuditB.logArchive.bind(activityAuditB);
    let releaseArchive!: () => void;
    const archiveHeld = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    const archiveSpy = jest
      .spyOn(activityAuditB, 'logArchive')
      .mockImplementationOnce(async (args: Parameters<typeof passThrough>[0]) => {
        await passThrough(args);
        await archiveHeld; // ← 归档事务停在这里,Activity 行锁没放
      });

    const archivePromise = archiveB.archive(
      fixture.activityId,
      { operationKey: `${fixture.tag}-archive-holds-lock` },
      submitter,
      auditMeta,
    );
    let submitPromise: ReturnType<CorrectionApplicationService['submit']> | undefined;
    let barrierError: unknown;
    try {
      await waitUntilHeld(() => archiveSpy.mock.calls.length);

      // 入口时刻:归档还没提交,活动从事务外看仍是 published。
      await expect(
        prismaA.activity.findUniqueOrThrow({
          where: { id: fixture.activityId },
          select: { statusCode: true },
        }),
      ).resolves.toEqual({ statusCode: 'published' });

      submitPromise = correctionA.submit(
        {
          activityId: fixture.activityId,
          participationIdentityId: fixture.identityIds[0],
          requestTypeCode: 'points',
          requestedChangeJson: pointsChange(fixture, '0.60'),
          reason: '归档之后发现认定贡献值仍需更正',
          operationKey: `${fixture.tag}-submit-after-archive`,
          requestHash: `${fixture.tag}-submit-after-archive-hash`,
        },
        submitter,
        auditMeta,
      );
      // 正面数出:更正提交确实堵在归档握着的那把 Activity 行锁上。
      await waitForRowLockWaiters(CORRECTION_LOCK_SQL, 1, '更正提交');
    } catch (error) {
      barrierError = error;
    } finally {
      releaseArchive();
      await archivePromise;
    }
    if (barrierError !== undefined) {
      if (submitPromise !== undefined) await submitPromise.catch(() => undefined);
      if (barrierError instanceof Error) throw barrierError;
      throw new Error('屏障等待抛出了非 Error 值,无法转述');
    }
    if (submitPromise === undefined) throw new Error('更正提交没有被发起');

    // 归档赢家的效果落地。
    await expect(
      prismaA.activity.findUniqueOrThrow({
        where: { id: fixture.activityId },
        select: { statusCode: true, archiveReasonCode: true },
      }),
    ).resolves.toEqual({ statusCode: 'archived', archiveReasonCode: 'settled' });

    // 🔴 而排在它后面的合法更正**照样成立** —— 归档不是"把账焊死"。
    const submitted = await submitPromise;
    expect(submitted.replayed).toBe(false);
    await expect(
      prismaA.attendanceCorrectionRequest.findUniqueOrThrow({
        where: { id: submitted.correctionRequestId },
        select: { activityId: true, statusCode: true },
      }),
    ).resolves.toEqual({ activityId: fixture.activityId, statusCode: 'pending' });
  });

  // ---------------------------------------------------------------------
  // ⑤-d 归档 × 关账 —— 判决翻转:入口 20156 → 锁后放行
  //
  // 归档取的是与关账**同一把** Activity `FOR UPDATE`,这条接缝是 2026-08-25 归档刀
  // 新造出来的,此前全仓零并发用例。构造与 ⑤-a 互为镜像:入口世界里归档是**被拒**的
  //(一张 active closure 都没有 ⇒ 20156),关账赢锁之后它却**放行** ——
  // 只可能是拿到行锁之后重读了 closure。
  // ---------------------------------------------------------------------
  it('⭐ ADV-022 关账在归档等锁期间落地 ⇒ 归档按锁后状态复判并放行(入口本该是 20156)', async () => {
    const fixture = await createFixture({ stage: 'posted' });
    await prismaA.activity.update({
      where: { id: fixture.activityId },
      data: { archiveWaitingDays: 0 },
    });

    // 关账(A 实例)停在最后一步(审计),握着 Activity 行锁。
    const passThrough = closureAudit.log.bind(closureAudit);
    let releaseClose!: () => void;
    const closeHeld = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const closeSpy = jest
      .spyOn(closureAudit, 'log')
      .mockImplementationOnce(async (args: Parameters<typeof passThrough>[0]) => {
        await passThrough(args);
        await closeHeld; // ← 关账事务停在这里,Activity 行锁没放
      });

    const closePromise = closureA.close(
      fixture.activityId,
      {
        operationKey: `${fixture.tag}-close-holds-lock`,
        requestHash: `${fixture.tag}-close-holds-lock-hash`,
      },
      submitter,
      auditMeta,
    );
    let archivePromise: ReturnType<ActivityArchiveService['archive']> | undefined;
    let barrierError: unknown;
    try {
      await waitUntilHeld(() => closeSpy.mock.calls.length);

      // 🔴 入口时刻的读数:一张 active closure 都还看不见
      //    ⇒ **若归档在锁前判,它必然被 20156 拒**。
      expect(await activeClosures(fixture.activityId)).toEqual([]);

      archivePromise = archiveB.archive(
        fixture.activityId,
        { operationKey: `${fixture.tag}-archive-vs-close` },
        submitter,
        auditMeta,
      );
      await waitForRowLockWaiters(ARCHIVE_LOCK_SQL, 1, '归档');

      expect(await activeClosures(fixture.activityId)).toEqual([]);
    } catch (error) {
      barrierError = error;
    } finally {
      releaseClose();
      await closePromise;
    }
    if (barrierError !== undefined) {
      if (archivePromise !== undefined) await archivePromise.catch(() => undefined);
      if (barrierError instanceof Error) throw barrierError;
      throw new Error('屏障等待抛出了非 Error 值,无法转述');
    }
    if (archivePromise === undefined) throw new Error('归档没有被发起');

    // 🔴 判决翻转:入口"20156" → 实际放行,且走的是**结算**那套开工条件。
    const result = await archivePromise;
    expect(result.statusCode).toBe('archived');
    expect(result.reasonCode).toBe('settled');
    expect(result.archivedFromStatusCode).toBe('published');

    // 关账赢家一张 active closure,归档没有把它动过一列。
    expect(await activeClosures(fixture.activityId)).toEqual([
      { revision: 1, statusCode: 'active' },
    ]);
    expect(await closureRevisionCount(fixture.activityId)).toBe(1);
  });
});
