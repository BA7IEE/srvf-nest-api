import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityClosureService } from '../../src/modules/activities/activity-closure.service';
import {
  CorrectionApplicationService,
  type CorrectionSubmitInput,
} from '../../src/modules/activities/correction-application.service';
import { CorrectionAuditRecorder } from '../../src/modules/activities/correction-audit-recorder';
import { CORRECTION_CHANGE_SCHEMA_VERSION } from '../../src/modules/activities/correction-change-set';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { ActivityFeedbacksService } from '../../src/modules/activity-feedbacks/activity-feedbacks.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// ===== 活动改造 v1.1 第 2 批第七刀:更正应用(合同 §5.14 + §3.25)=====
//
// 🔴🔴 **更正是全仓唯一能改动"已生效账本"的通路。** 它的失败模式不是报错,
//    是**账悄悄错了**:冲错、冲两次、冲了没补、补了没冲 —— 每一种都会产出一个
//    看起来完全正常的账本,而维护者看不懂代码、发现不了。
//
// ⭐ 本 spec 的组织方式就是 goal 要的那张**红集矩阵**:
//    ② 先证明**整条链走得通**(正对照 —— 没有它,后面每一条红都可能只是夹具坏了),
//       并当场兑现 DoD 8「更正后重新关账能成功」;
//    ③ DoD 5 的四条 red-first:冲两次 / 只冲不补 / 只补不冲 / 正常配对通过;
//    ④ 🔴 第五刀那道 `*_reversal` 闸**只被放宽了适用范围**:普通批次仍被拒;
//    ⑤ DoD 4「旧行逐字未变」的逐列比对;
//    ⑥ DoD 6 更正批次 baseline 漂移 ⇒ 整批不生效且旧账一分未动;
//    ⑦ DoD 7 原子切换:让最后一步抛错 ⇒ 七项全回滚;
//    ⑧ DoD 9 准备失败不改变正式读面;
//    ⑨ DoD 1/2/3 提交唯一性 / 审核不碰账 + 人员隔离 / 基础版本变化置 voided。
//
// 夹具**跑真实的第五刀 + 第六刀**(准备 → 统一生效 → 机器关账)而不是手写账本:
// 更正要读的正是它们产出的形态,手搓一份等于让本刀去核对一个从没在生产出现过的世界。
//
// 时间口径:全部用 2020 年的固定过去时刻(沿前六刀 spec;不耦合墙钟,无定时炸弹)。

/** 北京 2020-03-01 09:00 → 13:00(= UTC 01:00 → 05:00),整块落在北京 03-01。 */
const SESSION_START = new Date('2020-03-01T01:00:00.000Z');
const SESSION_END = new Date('2020-03-01T05:00:00.000Z');
const SEAL_AT = new Date('2020-03-01T09:00:00.000Z');
const LEDGER_DATE = '2020-03-01';

interface CorrectionFixture {
  activityId: string;
  sessionId: string;
  runId: string;
  versionId: string;
  batchId: string;
  sealId: string;
  memberIds: string[];
  identityIds: string[];
  resultRevisionIds: string[];
  closureRevisionId: string;
  tag: string;
}

describe('更正应用 —— 冲回 / 补记 / 原子切换 / 重新关账 (合同 §5.14 + §3.25)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let preparation: LedgerPreparationService;
  let posting: LedgerPostingService;
  let closure: ActivityClosureService;
  let correction: CorrectionApplicationService;
  let auditRecorder: CorrectionAuditRecorder;
  /** ⑩ AC-060 / ADV-012 用:评价资格是**读时派生**的,只能走真实读面拿。 */
  let activityFeedbacks: ActivityFeedbacksService;
  /**
   * ⑪ ADV-011 用的**第二套 Nest / Prisma pool**。
   *
   * ⚠️ `Promise.all(两个 service 调用)` 是**假并发**:Node 单线程 + Prisma 交互事务,
   *    两条调用极可能先后串行走完,谁都不会真的排队 —— 那样的用例在**没有任何锁**的实现上
   *    也会绿(空绿)。真构造 = 两套 pool + 第三个事务当闸门,并用 `pg_stat_activity`
   *    **正面证明**两条提交真的堵在 Activity 行锁上。沿 `activity-settlement-review-concurrency` 的手法。
   */
  let appB: INestApplication;
  let prismaB: PrismaService;
  let correctionB: CorrectionApplicationService;

  /** 结算版本的提交人 = 更正申请的提交人(§7.5 后半句点名的那个人)。 */
  let submitter: CurrentUserPayload;
  /** 独立的审核人 —— §7.5 要求 request submitter != reviewer。 */
  let reviewer: CurrentUserPayload;
  let organizationId: string;
  let sequence = 0;

  const auditMeta = { requestId: 'activity-correction-e2e', ip: null, ua: null };

  beforeAll(async () => {
    // 第 7 批第 ③ 刀 —— 活动 v1.1 单一 cutover gate(合同 §16.2)。本 spec 驱动的是
    // **结算真相链**(打卡 / 封场 / 结算 / 账本 / 关账 / 更正),那条链按定义只在闸开时存在;
    // 闸关(默认 = 今天的行为)时这些写入口一律回 20153。故此处显式置真,
    // **断言一字未改** —— 改的只是这个 spec 声明自己跑在哪一侧闸。
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    preparation = app.get(LedgerPreparationService);
    posting = app.get(LedgerPostingService);
    closure = app.get(ActivityClosureService);
    correction = app.get(CorrectionApplicationService);
    auditRecorder = app.get(CorrectionAuditRecorder);
    activityFeedbacks = app.get(ActivityFeedbacksService);
    // ⚠️ `resetDb` 只在第一套上跑一次(两套共库);第二套只提供独立连接池。
    appB = await createTestApp();
    prismaB = appB.get(PrismaService);
    correctionB = appB.get(CorrectionApplicationService);

    submitter = await makeActor('correction-submitter');
    reviewer = await makeActor('correction-reviewer');

    const organization = await prisma.organization.create({
      data: { name: '更正应用测试组织', nodeTypeCode: 'activity-correction-team' },
      select: { id: true },
    });
    organizationId = organization.id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    await Promise.all([app.close(), appB.close()]);
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
  // 夹具:一场**真的走完第五刀 + 第六刀**的活动 —— 账已生效、run 已关账。
  // =========================================================================
  async function createSettledActivity(
    options: {
      memberCount?: number;
      recognizedPoints?: number;
      closeIt?: boolean;
      /**
       * 这些索引的队员基础结果写成 `absent`(认定时长 / 贡献值恒 0),
       * **但打卡与服务段照建** —— 人到了、签了到,结算时被判成缺席。
       * 这正是「更正把缺席改出勤」要修的那个形状(2026-08 验收补写 AC-060 / ADV-012)。
       * 默认空数组 ⇒ 既有全部调用方逐字保持原行为。
       */
      absentMemberIndexes?: readonly number[];
    } = {},
  ): Promise<CorrectionFixture> {
    const memberCount = options.memberCount ?? 2;
    const recognizedPoints = options.recognizedPoints ?? 1.2;
    const recognizedHours = 4;
    const absentMemberIndexes = new Set(options.absentMemberIndexes ?? []);
    sequence += 1;
    const tag = `correction-${sequence}`;

    const activity = await prisma.activity.create({
      data: {
        title: `更正活动 ${sequence}`,
        activityTypeCode: `activity-correction-type-${sequence}`,
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
    await prisma.member.createMany({
      data: memberIds.map((id, index) => ({
        id,
        memberNo: `${tag}-m${index}`,
        ...memberIdentityData(`${tag} 队员 ${index}`),
        gradeCode: 'level-2',
      })),
    });
    const registrationIds = memberIds.map(() => randomUUID());
    await prisma.activityRegistration.createMany({
      data: registrationIds.map((id, index) => ({
        id,
        activityId: activity.id,
        memberId: memberIds[index],
        statusCode: 'pass',
      })),
    });

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

    const run = await prisma.attendanceSettlementRun.create({
      data: {
        activityId: activity.id,
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
        sessionParticipationCount: memberCount,
        serviceSegmentCount: memberCount,
        // ⭐ 提交人 = `submitter` —— §7.5 后半句「若更正由**原结算提交人**提出仍适用」
        //    那条 red-first 就靠它成立。
        createdByUserId: submitter.id,
        submittedAt: SEAL_AT,
        statusCode: 'approved',
        operationKey: `${tag}-submit-key`,
        requestHash: `${tag}-submit-hash`,
      },
      select: { id: true },
    });

    const identityIds: string[] = [];
    const resultRevisionIds: string[] = [];
    for (let index = 0; index < memberCount; index += 1) {
      const identity = await prisma.activityParticipationIdentity.create({
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

      const checkIn = await prisma.attendancePunchEvent.create({
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
      await prisma.participantServiceSegmentRevision.create({
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

      const isAbsent = absentMemberIndexes.has(index);
      const revision = await prisma.participantSettlementResultRevision.create({
        data: {
          settlementVersionId: version.id,
          participationIdentityId: identity.id,
          revision: 0,
          resultCode: isAbsent ? 'absent' : 'present',
          recognizedServiceHours: isAbsent ? 0 : recognizedHours,
          recognizedContributionPoints: isAbsent ? 0 : recognizedPoints,
          calculatedServiceHours: isAbsent ? 0 : recognizedHours,
          calculatedContributionPoints: isAbsent ? 0 : recognizedPoints,
          statusCode: 'draft',
        },
        select: { id: true },
      });
      resultRevisionIds.push(revision.id);
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
        preparedByUserId: submitter.id,
      },
      select: { id: true },
    });

    // 🔴 走**真实**的第五刀:分块准备 → 短事务统一生效。
    const { jobId } = await preparation.ensurePrepareJob(batch.id);
    const items = await prisma.activityBatchJobItem.findMany({
      where: { jobId },
      select: { id: true },
      orderBy: { itemKey: 'asc' },
    });
    for (const item of items) await preparation.prepareChunk(jobId, item.id);
    await preparation.finalize(jobId);
    await posting.commitBatch(
      { postingBatchId: batch.id, operationKey: `${tag}-commit-key` },
      submitter,
      auditMeta,
    );

    let closureRevisionId = '';
    if (options.closeIt !== false) {
      // 🔴 走**真实**的第六刀:机器关账。更正要顶掉的正是它写下的那张 closure。
      const outcome = await closure.close(
        activity.id,
        { operationKey: `${tag}-close-key`, requestHash: `${tag}-close-hash` },
        submitter,
        auditMeta,
      );
      if (outcome.outcome !== 'closed') {
        throw new Error(`夹具建立失败:首次关账被缺口挡下 ${JSON.stringify(outcome.gaps)}`);
      }
      closureRevisionId = outcome.closure.closureRevisionId;
    }

    return {
      activityId: activity.id,
      sessionId: session.id,
      runId: run.id,
      versionId: version.id,
      batchId: batch.id,
      sealId: seal.id,
      memberIds,
      identityIds,
      resultRevisionIds,
      closureRevisionId,
      tag,
    };
  }

  // ===== 更正内容与流程的便捷入口 ==========================================

  /** 把第 0 个人的认定贡献值改成 `points`(时长不动)。 */
  function pointsChange(
    fixture: CorrectionFixture,
    points: string,
    hours = '4.00',
  ): Record<string, unknown> {
    return {
      schemaVersion: CORRECTION_CHANGE_SCHEMA_VERSION,
      results: [
        {
          participationIdentityId: fixture.identityIds[0],
          resultCode: 'present',
          recognizedServiceHours: hours,
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

  function submitInput(
    fixture: CorrectionFixture,
    change: Record<string, unknown>,
    suffix = '1',
  ): CorrectionSubmitInput {
    return {
      activityId: fixture.activityId,
      participationIdentityId: fixture.identityIds[0],
      requestTypeCode: 'points',
      requestedChangeJson: change,
      reason: '现场记录有误,认定贡献值需要更正',
      operationKey: `${fixture.tag}-correction-${suffix}`,
      requestHash: `${fixture.tag}-correction-hash-${suffix}`,
    };
  }

  /** 提交 + 由**另一个人**批准 ⇒ 返回申请 id(§7.5 的正对照路径)。 */
  async function submitAndApprove(
    fixture: CorrectionFixture,
    change: Record<string, unknown>,
    suffix = '1',
  ): Promise<string> {
    const submitted = await correction.submit(
      submitInput(fixture, change, suffix),
      submitter,
      auditMeta,
    );
    const reviewed = await correction.review(
      { correctionRequestId: submitted.correctionRequestId, actionCode: 'approve' },
      reviewer,
      auditMeta,
    );
    expect(reviewed.outcome).toBe('reviewed');
    return submitted.correctionRequestId;
  }

  function applyInput(fixture: CorrectionFixture, correctionRequestId: string, suffix = '1') {
    return {
      correctionRequestId,
      operationKey: `${fixture.tag}-apply-${suffix}`,
      requestHash: `${fixture.tag}-apply-hash-${suffix}`,
    };
  }

  // ===== 取证工具 =========================================================

  /** 已生效分录的整行快照(排序确定) —— DoD 4「旧行逐字未变」的比对基准。 */
  async function snapshotCommittedEntries(activityId: string): Promise<unknown[]> {
    return await prisma.$queryRaw`
      SELECT e.id, e."entryKey", e."operationKey", e."memberId", e."resultRevisionId",
             to_char(e."ledgerDate", 'YYYY-MM-DD') AS "ledgerDate", e."entryTypeCode",
             e."serviceHoursDelta"::text AS h, e."recognizedPointsDelta"::text AS r,
             e."creditedPointsDelta"::text AS c, e."cappedOutPointsDelta"::text AS o,
             e."reversesEntryId"
      FROM "ParticipationLedgerEntry" e
      JOIN "LedgerPostingBatch" b ON b.id = e."postingBatchId"
      WHERE e."activityId" = ${activityId} AND b."statusCode" = 'committed'
      ORDER BY e.id ASC
    `;
  }

  /** 结果行的**业务内容列**(刻意不含 statusCode / updatedAt —— 那两列允许被投影)。 */
  async function snapshotResultContent(settlementVersionId: string): Promise<unknown[]> {
    return await prisma.$queryRaw`
      SELECT id, "participationIdentityId", revision, "resultCode", "lateFlag", "earlyLeaveFlag",
             "recognizedServiceHours"::text AS rh, "recognizedContributionPoints"::text AS rp,
             "calculatedServiceHours"::text AS ch, "calculatedContributionPoints"::text AS cp,
             "adjustmentReason", "baseResultRevisionId", "correctionRequestId", "createdAt"
      FROM "ParticipantSettlementResultRevision"
      WHERE "settlementVersionId" = ${settlementVersionId}
      ORDER BY id ASC
    `;
  }

  async function dayStates(memberIds: readonly string[]): Promise<unknown[]> {
    return await prisma.$queryRaw`
      SELECT "memberId", to_char("ledgerDate", 'YYYY-MM-DD') AS "ledgerDate",
             version, "committedCreditedPoints"::text AS credited
      FROM "MemberContributionDayState"
      WHERE "memberId" = ANY(${[...memberIds]}::text[])
      ORDER BY "memberId" ASC, "ledgerDate" ASC
    `;
  }

  /** 正式读面的四个锚点 —— DoD 9 要断言"一行不差"的就是它们。 */
  async function officialSurface(fixture: CorrectionFixture): Promise<Record<string, unknown>> {
    const run = await prisma.attendanceSettlementRun.findUniqueOrThrow({
      where: { id: fixture.runId },
      select: { currentPostedVersion: true, currentClosureRevision: true },
    });
    const activity = await prisma.activity.findUniqueOrThrow({
      where: { id: fixture.activityId },
      select: { currentClosureRevision: true },
    });
    const activeClosure = await prisma.activitySettlementClosureRevision.findFirst({
      where: { activityId: fixture.activityId, statusCode: 'active' },
      select: { id: true, revision: true },
    });
    return {
      currentPostedVersion: run.currentPostedVersion,
      runClosureRevision: run.currentClosureRevision,
      activityClosureRevision: activity.currentClosureRevision,
      activeClosure,
      committedEntries: await snapshotCommittedEntries(fixture.activityId),
      dayStates: await dayStates(fixture.memberIds),
    };
  }

  async function expectBizCode(
    promise: Promise<unknown>,
    expected: { code: number },
  ): Promise<void> {
    await expect(promise).rejects.toBeInstanceOf(BizException);
    await promise.catch((error: unknown) => {
      expect((error as BizException).biz.code).toBe(expected.code);
    });
  }

  // =========================================================================
  // ② 正对照 —— 整条链走得通 + DoD 8「更正后重新关账能成功」
  // =========================================================================
  describe('② 整条链:提交 → 审核 → 准备 → 生效 → 重新关账', () => {
    it('🔴 更正把 1.20 改成 0.60 ⇒ 账净变 -0.60,且重新关账成功', async () => {
      const fixture = await createSettledActivity();
      const before = await dayStates([fixture.memberIds[0]]);
      expect(before).toEqual([
        { memberId: fixture.memberIds[0], ledgerDate: LEDGER_DATE, version: 1, credited: '1.20' },
      ]);

      const requestId = await submitAndApprove(fixture, pointsChange(fixture, '0.60'));
      const outcome = await correction.apply(applyInput(fixture, requestId), reviewer, auditMeta);

      // ⭐ 冲回 4 条(2 人 × 2 类)、补记 4 条 —— 全人口整份复制,未被改的人也重记一遍。
      expect(outcome.prepare.reversalEntryCount).toBe(4);
      expect(outcome.prepare.replacementEntryCount).toBe(4);
      expect(outcome.commit.correctionStatus).toBe('applied');
      expect(outcome.commit.applicationStatus).toBe('committed');

      // 🔴 **账的净变化**:第 0 个人 1.20 → 0.60(day-state 版本从 1 递增到 2);
      //    第 1 个人未被更正,冲回 -1.20 + 补记 +1.20 = 净 0,金额不变但版本照样递增。
      expect(await dayStates(fixture.memberIds)).toEqual(
        expect.arrayContaining([
          { memberId: fixture.memberIds[0], ledgerDate: LEDGER_DATE, version: 2, credited: '0.60' },
          { memberId: fixture.memberIds[1], ledgerDate: LEDGER_DATE, version: 2, credited: '1.20' },
        ]),
      );

      // ===== DoD 8:重新关账成功(第六刀「closed 与 posted 同权」的设计兑现)=====
      expect(outcome.reclose.outcome).toBe('closed');
      if (outcome.reclose.outcome !== 'closed') throw new Error('unreachable');
      expect(outcome.reclose.closure.revision).toBe(2);
      // 旧 closure 变 superseded 且指回本次更正;新 closure 是唯一 active。
      const closures = await prisma.activitySettlementClosureRevision.findMany({
        where: { activityId: fixture.activityId },
        select: { revision: true, statusCode: true, supersededByCorrectionId: true },
        orderBy: { revision: 'asc' },
      });
      expect(closures).toEqual([
        { revision: 1, statusCode: 'superseded', supersededByCorrectionId: requestId },
        { revision: 2, statusCode: 'active', supersededByCorrectionId: null },
      ]);
    });

    it('🔴 满额更正后仍是满额 —— 日上限基线必须扣掉本次冲回', async () => {
      // 这是本刀最隐蔽的一处:旧账当日已记满 3.00、更正后仍应是 3.00。
      // 若补记时不把冲回让出来的额度扣回去,余额会算成 0 ⇒ 补记全进 cappedOut,
      // 队员当天凭空少 3.00 分,而账面处处自洽。
      const fixture = await createSettledActivity({ memberCount: 1, recognizedPoints: 3 });
      expect(await dayStates(fixture.memberIds)).toEqual([
        { memberId: fixture.memberIds[0], ledgerDate: LEDGER_DATE, version: 1, credited: '3.00' },
      ]);

      const requestId = await submitAndApprove(fixture, pointsChange(fixture, '3.00', '6.00'));
      await correction.apply(applyInput(fixture, requestId), reviewer, auditMeta);

      expect(await dayStates(fixture.memberIds)).toEqual([
        { memberId: fixture.memberIds[0], ledgerDate: LEDGER_DATE, version: 2, credited: '3.00' },
      ]);
    });
  });

  // =========================================================================
  // ③ DoD 5 —— 冲回与补记的四条 red-first
  // =========================================================================
  describe('③ DoD 5:冲回 / 补记的配对判据', () => {
    it('④-a 正常配对 ⇒ 通过(正对照)', async () => {
      const fixture = await createSettledActivity();
      const requestId = await submitAndApprove(fixture, pointsChange(fixture, '0.60'));
      await correction.prepare(applyInput(fixture, requestId), reviewer, auditMeta);
      const committed = await correction.commit(
        applyInput(fixture, requestId),
        reviewer,
        auditMeta,
      );
      expect(committed.ledger.batchStatus).toBe('committed');
    });

    it('🔴 ④-b 同一条原分录被冲两次 ⇒ 20107 拒绝', async () => {
      const fixture = await createSettledActivity();
      // 先把其中一条已生效分录"占住"—— 模拟它此前已被别的 committed reversal 冲回。
      const original = await prisma.participationLedgerEntry.findFirstOrThrow({
        where: { activityId: fixture.activityId, entryTypeCode: 'contribution_credit' },
        select: { id: true },
      });
      await prisma.ledgerEntryReversalClaim.create({ data: { originalEntryId: original.id } });

      const requestId = await submitAndApprove(fixture, pointsChange(fixture, '0.60'));
      await expectBizCode(
        correction.prepare(applyInput(fixture, requestId), reviewer, auditMeta),
        BizCode.CORRECTION_REVERSAL_ALREADY_CLAIMED,
      );
    });

    it('🔴 ④-c 只冲不补(新版本有应记日行、批次没补分录)⇒ 20108 拒绝', async () => {
      const fixture = await createSettledActivity();
      const requestId = await submitAndApprove(fixture, pointsChange(fixture, '0.60'));
      const prepared = await correction.prepare(
        applyInput(fixture, requestId),
        reviewer,
        auditMeta,
      );
      // 造出"有一天该补却没补"的形态:给新版本多加一行 ParticipantSettlementDay。
      await prisma.participantSettlementDay.create({
        data: {
          resultRevisionId: prepared.newResultRevisionIds[0],
          memberId: fixture.memberIds[0],
          ledgerDate: new Date('2020-03-02T00:00:00.000Z'),
          serviceHours: 1,
          recognizedPoints: 0.5,
          creditedPoints: 0.5,
          cappedOutPoints: 0,
          sequenceStartAt: SESSION_START,
          stableOrderKey: 'extra',
        },
      });
      await expectBizCode(
        correction.commit(applyInput(fixture, requestId), reviewer, auditMeta),
        BizCode.CORRECTION_POSTING_REPLACEMENT_MISSING,
      );
    });

    it('🔴 ④-d 只补不冲(基础版本还有已生效分录没被冲回)⇒ 20109 拒绝', async () => {
      const fixture = await createSettledActivity();
      const requestId = await submitAndApprove(fixture, pointsChange(fixture, '0.60'));
      await correction.prepare(applyInput(fixture, requestId), reviewer, auditMeta);

      // 往**旧的已生效批次**里再插一条 credit 分录(append-only 允许 INSERT)——
      // 它属于基础版本、已生效、却没有被本次更正冲回。
      await prisma.participationLedgerEntry.create({
        data: {
          postingBatchId: fixture.batchId,
          entryKey: `${fixture.tag}-stray-entry`,
          operationKey: `${fixture.tag}-stray-op`,
          memberId: fixture.memberIds[0],
          activityId: fixture.activityId,
          sessionId: fixture.sessionId,
          participationIdentityId: fixture.identityIds[0],
          resultRevisionId: fixture.resultRevisionIds[0],
          ledgerDate: new Date('2020-03-03T00:00:00.000Z'),
          entryTypeCode: 'contribution_credit',
          serviceHoursDelta: 0,
          recognizedPointsDelta: 0.5,
          creditedPointsDelta: 0.5,
          cappedOutPointsDelta: 0,
        },
      });
      await expectBizCode(
        correction.commit(applyInput(fixture, requestId), reviewer, auditMeta),
        BizCode.CORRECTION_POSTING_REVERSAL_MISSING,
      );
    });

    it('🔴 ④-e 冲回金额不是原分录的相反数 ⇒ 20110 拒绝', async () => {
      const fixture = await createSettledActivity();
      const requestId = await submitAndApprove(fixture, pointsChange(fixture, '0.60'));
      const prepared = await correction.prepare(
        applyInput(fixture, requestId),
        reviewer,
        auditMeta,
      );
      // 在更正批次里补两条**成对但金额不足**的冲回(配对计数依然全对)。
      const original = await prisma.participationLedgerEntry.findFirstOrThrow({
        where: { postingBatchId: fixture.batchId, entryTypeCode: 'contribution_credit' },
        select: { id: true, resultRevisionId: true },
      });
      const strayDate = new Date('2020-03-04T00:00:00.000Z');
      for (const [type, index] of [
        ['service_reversal', 0],
        ['contribution_reversal', 1],
      ] as const) {
        await prisma.participationLedgerEntry.create({
          data: {
            postingBatchId: prepared.newPostingBatchId,
            entryKey: `${fixture.tag}-bad-reversal-${index}`,
            operationKey: `${fixture.tag}-bad-reversal-op-${index}`,
            memberId: fixture.memberIds[0],
            activityId: fixture.activityId,
            sessionId: fixture.sessionId,
            participationIdentityId: fixture.identityIds[0],
            resultRevisionId: original.resultRevisionId,
            ledgerDate: strayDate,
            entryTypeCode: type,
            // 原分录是 -0/-1.20;这里只冲 -0.10 ⇒ 金额对不上,而计数完全正确。
            serviceHoursDelta: 0,
            recognizedPointsDelta: type === 'contribution_reversal' ? -0.1 : 0,
            creditedPointsDelta: type === 'contribution_reversal' ? -0.1 : 0,
            cappedOutPointsDelta: 0,
            reversesEntryId: original.id,
          },
        });
      }
      await expectBizCode(
        correction.commit(applyInput(fixture, requestId), reviewer, auditMeta),
        BizCode.CORRECTION_POSTING_REVERSAL_AMOUNT_INVALID,
      );
    });
  });

  // =========================================================================
  // ④ 🔴 第五刀那道闸**只被放宽了适用范围** —— 普通批次仍被拒
  // =========================================================================
  describe('④ 普通结算批次里出现 reversal ⇒ 仍然 20089', () => {
    it('🔴 没有 CorrectionApplication 指向的批次,塞一条 reversal 就拒绝生效', async () => {
      // 造一场**只走到"终审通过、批次 preparing"**的活动,跑完准备停在 ready。
      const fixture = await createUnsettledReadyBatch();
      const credit = await prisma.participationLedgerEntry.findFirstOrThrow({
        where: { postingBatchId: fixture.batchId, entryTypeCode: 'contribution_credit' },
        select: { id: true, resultRevisionId: true },
      });
      await prisma.participationLedgerEntry.create({
        data: {
          postingBatchId: fixture.batchId,
          entryKey: `${fixture.tag}-plain-reversal`,
          operationKey: `${fixture.tag}-plain-reversal-op`,
          memberId: fixture.memberIds[0],
          activityId: fixture.activityId,
          sessionId: fixture.sessionId,
          participationIdentityId: fixture.identityIds[0],
          resultRevisionId: credit.resultRevisionId,
          ledgerDate: new Date(`${LEDGER_DATE}T00:00:00.000Z`),
          entryTypeCode: 'contribution_reversal',
          serviceHoursDelta: 0,
          recognizedPointsDelta: -0.1,
          creditedPointsDelta: -0.1,
          cappedOutPointsDelta: 0,
          reversesEntryId: credit.id,
        },
      });

      // 本批次没有任何 `CorrectionApplication` 指向它 ⇒ 走**原判据**,逐字不变。
      await expect(
        prisma.correctionApplication.count({ where: { newPostingBatchId: fixture.batchId } }),
      ).resolves.toBe(0);
      await expectBizCode(
        posting.commitBatch(
          { postingBatchId: fixture.batchId, operationKey: `${fixture.tag}-plain-commit` },
          submitter,
          auditMeta,
        ),
        BizCode.LEDGER_COMMIT_ENTRY_SET_MISMATCH,
      );
      // 零部分生效:批次仍 ready,一条分录都没生效。
      await expect(
        prisma.ledgerPostingBatch.findUniqueOrThrow({
          where: { id: fixture.batchId },
          select: { statusCode: true },
        }),
      ).resolves.toEqual({ statusCode: 'ready' });
    });
  });

  // =========================================================================
  // ⑤ DoD 4 —— 旧行逐字未变(只允许 superseded 投影)
  // =========================================================================
  describe('⑤ DoD 4:旧记录不更新不删除,只做 superseded 投影', () => {
    it('🔴 旧结果行内容逐列未变、旧分录整行未变、行数只增不减', async () => {
      const fixture = await createSettledActivity();
      const resultsBefore = await snapshotResultContent(fixture.versionId);
      const entriesBefore = await snapshotCommittedEntries(fixture.activityId);

      const requestId = await submitAndApprove(fixture, pointsChange(fixture, '0.60'));
      await correction.apply(applyInput(fixture, requestId), reviewer, auditMeta);

      // (a) 旧结果行的**业务内容列**逐字未变(statusCode 与 updatedAt 不在快照里 ——
      //     那正是 §3.25 允许的唯一投影)。
      expect(await snapshotResultContent(fixture.versionId)).toEqual(resultsBefore);
      // (b) 它们的 statusCode 确实被投影成了 superseded(不是"什么都没做")。
      const statuses = await prisma.participantSettlementResultRevision.findMany({
        where: { settlementVersionId: fixture.versionId },
        select: { statusCode: true },
      });
      expect(statuses.every((row) => row.statusCode === 'superseded')).toBe(true);
      // (c) 旧分录整行未变 —— append-only trigger 让它在物理上就不可能被改。
      const entriesAfter = (await snapshotCommittedEntries(fixture.activityId)) as Array<{
        id: string;
      }>;
      const beforeIds = new Set((entriesBefore as Array<{ id: string }>).map((row) => row.id));
      expect(entriesAfter.filter((row) => beforeIds.has(row.id))).toEqual(entriesBefore);
      // (d) 只增不减:冲回 4 + 补记 4。
      expect(entriesAfter).toHaveLength(entriesBefore.length + 8);
    });
  });

  // =========================================================================
  // ⑥ DoD 6 —— 更正批次 baseline 漂移 ⇒ 整批不生效、旧账一分未动
  // =========================================================================
  describe('⑥ DoD 6:复用第五刀的 baseline 比对与零部分生效', () => {
    it('🔴 准备之后 day-state 被别人推进 ⇒ 20084,且旧账一分未动、冲回也没发生', async () => {
      const fixture = await createSettledActivity();
      const requestId = await submitAndApprove(fixture, pointsChange(fixture, '0.60'));
      const prepared = await correction.prepare(
        applyInput(fixture, requestId),
        reviewer,
        auditMeta,
      );
      const surfaceBefore = await officialSurface(fixture);

      // 世界变了:另一条路径推进了同一 (member, date) 的 day-state 版本。
      await prisma.$executeRaw`
        UPDATE "MemberContributionDayState"
        SET version = version + 1
        WHERE "memberId" = ${fixture.memberIds[0]}
          AND "ledgerDate" = ${LEDGER_DATE}::date
      `;

      await expectBizCode(
        correction.commit(applyInput(fixture, requestId), reviewer, auditMeta),
        BizCode.LEDGER_COMMIT_BASELINE_CHANGED,
      );

      // 🔴 整批不生效:批次仍 ready,更正批次里**一条分录都没变成已生效**。
      await expect(
        prisma.ledgerPostingBatch.findUniqueOrThrow({
          where: { id: prepared.newPostingBatchId },
          select: { statusCode: true },
        }),
      ).resolves.toEqual({ statusCode: 'ready' });
      // 🔴 旧账一分未动 —— 冲回也没发生(已生效分录集合与漂移前逐字相同)。
      const surfaceAfter = await officialSurface(fixture);
      expect(surfaceAfter.committedEntries).toEqual(surfaceBefore.committedEntries);
      expect(surfaceAfter.activeClosure).toEqual(surfaceBefore.activeClosure);
      expect(surfaceAfter.currentPostedVersion).toBe(surfaceBefore.currentPostedVersion);
      // 只有那次人为推进的 version 变了,金额一分没动。
      const credited = (await dayStates(fixture.memberIds)) as Array<{ credited: string }>;
      expect(credited.map((row) => row.credited)).toEqual(['1.20', '1.20']);
      // 申请仍停在 applying(可重试),不是被吃掉。
      await expect(
        prisma.attendanceCorrectionRequest.findUniqueOrThrow({
          where: { id: requestId },
          select: { statusCode: true },
        }),
      ).resolves.toEqual({ statusCode: 'applying' });
    });
  });

  // =========================================================================
  // ⑦ DoD 7 —— 原子切换:最后一步抛错 ⇒ 七项全回滚
  // =========================================================================
  describe('⑦ DoD 7:§5.14 ⑥ 的七项切换全在同一事务', () => {
    it('🔴 让 audit(最后一步)抛错 ⇒ 账、版本、closure、指针、申请状态全部回滚', async () => {
      const fixture = await createSettledActivity();
      const requestId = await submitAndApprove(fixture, pointsChange(fixture, '0.60'));
      const prepared = await correction.prepare(
        applyInput(fixture, requestId),
        reviewer,
        auditMeta,
      );
      const surfaceBefore = await officialSurface(fixture);

      jest.spyOn(auditRecorder, 'logCommit').mockRejectedValue(new Error('注入:audit 写入失败'));

      await expect(
        correction.commit(applyInput(fixture, requestId), reviewer, auditMeta),
      ).rejects.toThrow('注入:audit 写入失败');

      // ① 账本:已生效分录集合逐字未变(冲回与补记都没生效)。
      const surfaceAfter = await officialSurface(fixture);
      expect(surfaceAfter.committedEntries).toEqual(surfaceBefore.committedEntries);
      // ② day-state 一行未动。
      expect(surfaceAfter.dayStates).toEqual(surfaceBefore.dayStates);
      // ③ 旧结果行仍是 committed(没被投影成 superseded)。
      const oldStatuses = await prisma.participantSettlementResultRevision.findMany({
        where: { settlementVersionId: fixture.versionId },
        select: { statusCode: true },
      });
      expect(oldStatuses.every((row) => row.statusCode === 'committed')).toBe(true);
      // ④ 旧 active closure 仍 active;⑤ Activity 指针未清。
      expect(surfaceAfter.activeClosure).toEqual(surfaceBefore.activeClosure);
      expect(surfaceAfter.activityClosureRevision).toBe(surfaceBefore.activityClosureRevision);
      // ⑥ 申请仍 applying、应用仍 preparing。
      await expect(
        prisma.attendanceCorrectionRequest.findUniqueOrThrow({
          where: { id: requestId },
          select: { statusCode: true },
        }),
      ).resolves.toEqual({ statusCode: 'applying' });
      await expect(
        prisma.correctionApplication.findFirstOrThrow({
          where: { correctionRequestId: requestId },
          select: { statusCode: true },
        }),
      ).resolves.toEqual({ statusCode: 'preparing' });
      // ⑦ 更正批次仍 ready。
      await expect(
        prisma.ledgerPostingBatch.findUniqueOrThrow({
          where: { id: prepared.newPostingBatchId },
          select: { statusCode: true },
        }),
      ).resolves.toEqual({ statusCode: 'ready' });
    });
  });

  // =========================================================================
  // ⑧ DoD 9 —— 准备失败不改变当前正式页面
  // =========================================================================
  describe('⑧ DoD 9:更正准备失败不改变正式读面', () => {
    it('🔴 准备阶段抛错 ⇒ 读面一行不差,连新版本都没留下', async () => {
      const fixture = await createSettledActivity();
      const requestId = await submitAndApprove(fixture, pointsChange(fixture, '0.60'));
      const surfaceBefore = await officialSurface(fixture);
      const versionsBefore = await prisma.attendanceSettlementVersion.count({
        where: { settlementRunId: fixture.runId },
      });

      jest.spyOn(auditRecorder, 'logPrepare').mockRejectedValue(new Error('注入:准备阶段失败'));

      await expect(
        correction.prepare(applyInput(fixture, requestId), reviewer, auditMeta),
      ).rejects.toThrow('注入:准备阶段失败');

      expect(await officialSurface(fixture)).toEqual(surfaceBefore);
      await expect(
        prisma.attendanceSettlementVersion.count({ where: { settlementRunId: fixture.runId } }),
      ).resolves.toBe(versionsBefore);
      await expect(
        prisma.correctionApplication.count({ where: { correctionRequestId: requestId } }),
      ).resolves.toBe(0);
      // 冲回 claim 也随事务回滚 —— 否则重试会被自己上一次的 claim 挡死。
      // ⚠️ 必须按**本夹具的活动**限定:同一 suite 里别的用例留下的 claim 不算数
      //    (全局 count 会把别人的行数当成本例的证据)。
      await expect(
        prisma.ledgerEntryReversalClaim.count({
          where: { originalEntry: { activityId: fixture.activityId } },
        }),
      ).resolves.toBe(0);
    });

    it('准备成功但尚未生效时,正式读面**仍是旧账**(只有 commit 才一起切换)', async () => {
      const fixture = await createSettledActivity();
      const requestId = await submitAndApprove(fixture, pointsChange(fixture, '0.60'));
      const surfaceBefore = await officialSurface(fixture);

      await correction.prepare(applyInput(fixture, requestId), reviewer, auditMeta);

      const surfaceAfter = await officialSurface(fixture);
      expect(surfaceAfter.committedEntries).toEqual(surfaceBefore.committedEntries);
      expect(surfaceAfter.dayStates).toEqual(surfaceBefore.dayStates);
      expect(surfaceAfter.activeClosure).toEqual(surfaceBefore.activeClosure);
      expect(surfaceAfter.currentPostedVersion).toBe(surfaceBefore.currentPostedVersion);
    });
  });

  // =========================================================================
  // ⑨ DoD 1 / 2 / 3 —— 提交唯一性、审核不碰账 + 人员隔离、基础版本变化置 voided
  // =========================================================================
  describe('⑨ 提交与审核', () => {
    it('DoD 1:同一 target 同时只允许一条进行中的申请 ⇒ 20101', async () => {
      const fixture = await createSettledActivity();
      await correction.submit(
        submitInput(fixture, pointsChange(fixture, '0.60'), '1'),
        submitter,
        auditMeta,
      );
      await expectBizCode(
        correction.submit(
          submitInput(fixture, pointsChange(fixture, '0.80'), '2'),
          submitter,
          auditMeta,
        ),
        BizCode.CORRECTION_TARGET_ALREADY_OPEN,
      );
    });

    it('DoD 1:同 key 同 payload ⇒ 重放同一条申请(不产生第二条)', async () => {
      const fixture = await createSettledActivity();
      const first = await correction.submit(
        submitInput(fixture, pointsChange(fixture, '0.60')),
        submitter,
        auditMeta,
      );
      const replay = await correction.submit(
        submitInput(fixture, pointsChange(fixture, '0.60')),
        submitter,
        auditMeta,
      );
      expect(replay.replayed).toBe(true);
      expect(replay.correctionRequestId).toBe(first.correctionRequestId);
      await expect(
        prisma.attendanceCorrectionRequest.count({ where: { activityId: fixture.activityId } }),
      ).resolves.toBe(1);
    });

    it('🔴 DoD 2 / §7.5:更正由**原结算提交人**提出,他自己审 ⇒ 20104 拒绝', async () => {
      // §7.5 后半句「若更正由原结算提交人提出**仍适用**」点名的正是这个形态:
      // 夹具里 `AttendanceSettlementVersion.createdByUserId` 就是 `submitter`。
      const fixture = await createSettledActivity();
      const submitted = await correction.submit(
        submitInput(fixture, pointsChange(fixture, '0.60')),
        submitter,
        auditMeta,
      );
      await expect(
        prisma.attendanceSettlementVersion.findUniqueOrThrow({
          where: { id: fixture.versionId },
          select: { createdByUserId: true },
        }),
      ).resolves.toEqual({ createdByUserId: submitter.id });

      await expectBizCode(
        correction.review(
          { correctionRequestId: submitted.correctionRequestId, actionCode: 'approve' },
          submitter,
          auditMeta,
        ),
        BizCode.CORRECTION_REVIEW_SELF_FORBIDDEN,
      );
      // 正对照:换一个人审就通过。
      const reviewed = await correction.review(
        { correctionRequestId: submitted.correctionRequestId, actionCode: 'approve' },
        reviewer,
        auditMeta,
      );
      expect(reviewed.outcome).toBe('reviewed');
    });

    it('🔴 DoD 2:审核动作本身**不碰账** —— 结果行 / 分录 / day-state 逐字未变', async () => {
      const fixture = await createSettledActivity();
      const submitted = await correction.submit(
        submitInput(fixture, pointsChange(fixture, '0.60')),
        submitter,
        auditMeta,
      );
      const surfaceBefore = await officialSurface(fixture);
      const resultsBefore = await snapshotResultContent(fixture.versionId);

      await correction.review(
        { correctionRequestId: submitted.correctionRequestId, actionCode: 'approve' },
        reviewer,
        auditMeta,
      );

      const surfaceAfter = await officialSurface(fixture);
      expect(surfaceAfter.committedEntries).toEqual(surfaceBefore.committedEntries);
      expect(surfaceAfter.dayStates).toEqual(surfaceBefore.dayStates);
      expect(surfaceAfter.activeClosure).toEqual(surfaceBefore.activeClosure);
      expect(await snapshotResultContent(fixture.versionId)).toEqual(resultsBefore);
      // 审核只碰申请行本身。
      await expect(
        prisma.attendanceCorrectionRequest.findUniqueOrThrow({
          where: { id: submitted.correctionRequestId },
          select: { statusCode: true, reviewedByUserId: true },
        }),
      ).resolves.toEqual({ statusCode: 'approved', reviewedByUserId: reviewer.id });
    });

    it('🔴 DoD 3:审核时基础版本已被顶掉 ⇒ 请求转 voided,不允许照旧批准', async () => {
      const fixture = await createSettledActivity();
      // 第一条更正走完 ⇒ 基础版本从 v1 换成 v2。
      const firstId = await submitAndApprove(fixture, pointsChange(fixture, '0.60'), '1');
      await correction.apply(applyInput(fixture, firstId, '1'), reviewer, auditMeta);

      // 第二条更正**手工造成锚定旧版本**的形态(模拟"提交后世界变了")。
      const stale = await prisma.attendanceCorrectionRequest.create({
        data: {
          activityId: fixture.activityId,
          settlementRunId: fixture.runId,
          participationIdentityId: fixture.identityIds[1],
          baseSettlementVersionId: fixture.versionId, // ← 已经不是当前生效版本
          baseClosureRevision: 1,
          requestTypeCode: 'points',
          requestedChangeJson: pointsChange(fixture, '0.30') as Prisma.InputJsonObject,
          reason: '基于旧版本的申请',
          statusCode: 'pending',
          submittedByUserId: submitter.id,
          submittedAt: SEAL_AT,
          operationKey: `${fixture.tag}-stale-key`,
          requestHash: `${fixture.tag}-stale-hash`,
        },
        select: { id: true },
      });

      const outcome = await correction.review(
        { correctionRequestId: stale.id, actionCode: 'approve' },
        reviewer,
        auditMeta,
      );
      expect(outcome.outcome).toBe('voided');
      if (outcome.outcome !== 'voided') throw new Error('unreachable');
      expect(outcome.baseSettlementVersionId).toBe(fixture.versionId);
      expect(outcome.currentSettlementVersionId).not.toBe(fixture.versionId);
      // 落库了:不是"判一次回滚一次",申请确实变成 voided。
      await expect(
        prisma.attendanceCorrectionRequest.findUniqueOrThrow({
          where: { id: stale.id },
          select: { statusCode: true },
        }),
      ).resolves.toEqual({ statusCode: 'voided' });
    });

    it('DoD 2:reject 之后 target 重新可用(run 交回 closed)', async () => {
      const fixture = await createSettledActivity();
      const submitted = await correction.submit(
        submitInput(fixture, pointsChange(fixture, '0.60'), '1'),
        submitter,
        auditMeta,
      );
      const reviewed = await correction.review(
        { correctionRequestId: submitted.correctionRequestId, actionCode: 'reject' },
        reviewer,
        auditMeta,
      );
      expect(reviewed.outcome).toBe('reviewed');
      if (reviewed.outcome !== 'reviewed') throw new Error('unreachable');
      expect(reviewed.runStatus).toBe('closed');
      // 同一 target 可以再提一条。
      const second = await correction.submit(
        submitInput(fixture, pointsChange(fixture, '0.80'), '2'),
        submitter,
        auditMeta,
      );
      expect(second.replayed).toBe(false);
    });
  });

  // =========================================================================
  // ⑩ ⭐ 验收编号 AC-060 / ADV-012(2026-08 补写)—— **结果码 flip 走真更正链**
  //
  //   AC-060「更正把缺席改出勤或出勤改缺席后,人员、时长、分数、评价资格和关闭版本一致变化。」
  //   ADV-012「更正把缺席改出勤后,人数、时长、分数、评价和关闭版本一起变化。」
  //
  // ⚠️ 本段之前,全仓**没有任何** e2e 把 `resultCode` 真的换过值:本 spec 与
  //    `test/support/journey-attendance-correction.ts` 的变更集都硬编码 `resultCode: 'present'`
  //    (`pointsChange()` 第 402 行),链走了很多遍,结果码一次都没动。
  //
  // 五格在**同一个夹具、同一次 apply 前后**各读一次(不是拼五条半覆盖):
  //   人员 → closure.resultCountsJson(按结果码分组)与 personCount
  //   时长 → closure.serviceHours(= 已生效分录 serviceHoursDelta 求和,净掉冲回)
  //   分数 → closure.contributionPoints + MemberContributionDayState 日合计
  //   评价资格 → ActivityFeedbacksService.getMine 的 canSubmit / eligibilityCorrected
  //   关闭版本 → closure revision 1 → 2,旧行转 superseded 且指回本次更正
  // 每条都带**未被更正的第二个人**作正对照 —— 他的五格必须原样不动,
  // 否则"一致变化"可能只是"整份账被推倒重来"。
  // =========================================================================
  describe('⭐ ⑩ AC-060 / ADV-012:结果码 flip 后人员/时长/分数/评价资格/关闭版本一致变化', () => {
    /** 把第 `index` 个人的结果码改成 `resultCode`;非 present 一律零认定值(闭集规则)。 */
    function resultCodeChange(
      fixture: CorrectionFixture,
      index: number,
      resultCode: 'present' | 'absent',
      hours = '4.00',
      points = '1.20',
    ): Record<string, unknown> {
      const zero = resultCode !== 'present';
      return {
        schemaVersion: CORRECTION_CHANGE_SCHEMA_VERSION,
        results: [
          {
            participationIdentityId: fixture.identityIds[index],
            resultCode,
            recognizedServiceHours: zero ? '0.00' : hours,
            recognizedContributionPoints: zero ? '0.00' : points,
            adjustmentReason: '负责人复核后更正结果码',
            lateFlag: false,
            earlyLeaveFlag: false,
          },
        ],
        segments: [],
      };
    }

    /** 读关闭版本上的三个汇总 + 当前 active revision。 */
    async function closureFacts(activityId: string): Promise<{
      revision: number;
      personCount: number;
      serviceHours: string;
      contributionPoints: string;
      resultCounts: unknown;
    }> {
      const row = await prisma.activitySettlementClosureRevision.findFirstOrThrow({
        where: { activityId, statusCode: 'active' },
        select: {
          revision: true,
          personCount: true,
          serviceHours: true,
          contributionPoints: true,
          resultCountsJson: true,
        },
      });
      return {
        revision: row.revision,
        personCount: row.personCount,
        serviceHours: row.serviceHours.toString(),
        contributionPoints: row.contributionPoints.toString(),
        resultCounts: row.resultCountsJson,
      };
    }

    /**
     * 给某个队员造一个能读评价面的 App 身份。
     * 评价资格是**读时派生**的(`hasSettlementEligibility` 现查已生效结果行 + 分录),
     * 所以必须真的走 `getMine`,不能在测试里重算一遍谓词 —— 重算等于把实现抄一遍,
     * 实现改了测试也跟着改,守不住任何东西。
     */
    async function appUserFor(memberId: string, label: string): Promise<CurrentUserPayload> {
      const user = await createTestUser(app, {
        username: `correction-feedback-${label}-${randomUUID().slice(0, 8)}`,
        role: Role.USER,
      });
      await prisma.user.update({ where: { id: user.id }, data: { memberId } });
      return {
        id: user.id,
        username: user.username,
        role: user.role,
        status: UserStatus.ACTIVE,
        memberId,
      };
    }

    /** 评价面只对 `completed` 活动开放(全仓无 complete 端点,字典占位;与评价 spec 同做法)。 */
    async function markCompleted(activityId: string): Promise<void> {
      await prisma.activity.update({
        where: { id: activityId },
        data: { statusCode: 'completed' },
      });
    }

    it('🔴 AC-060 出勤改缺席:五格一起变,未被更正的那位五格原样不动', async () => {
      const fixture = await createSettledActivity({ memberCount: 2 });
      await markCompleted(fixture.activityId);
      const [flipped, untouched] = fixture.memberIds;
      const flippedUser = await appUserFor(flipped, 'flip');
      const untouchedUser = await appUserFor(untouched, 'keep');

      // 两人都已提交过评价 —— `eligibilityCorrected` 只在"提交过、现在没资格了"时为真,
      // 没有这一行就永远读不到那一格。
      for (const memberId of [flipped, untouched]) {
        await prisma.activityFeedback.create({
          data: {
            activityId: fixture.activityId,
            memberId,
            rating: 5,
            comment: '很好',
          },
        });
      }

      const before = await closureFacts(fixture.activityId);
      expect(before.revision).toBe(1);
      expect(before.personCount).toBe(2);
      expect(before.resultCounts).toStrictEqual({ present: 2 });
      expect(Number(before.serviceHours)).toBe(8);
      expect(Number(before.contributionPoints)).toBe(2.4);
      await expect(
        activityFeedbacks.getMine(fixture.activityId, flippedUser),
      ).resolves.toMatchObject({
        canSubmit: true,
        feedback: expect.objectContaining({ eligibilityCorrected: false }),
      });

      const requestId = await submitAndApprove(
        fixture,
        resultCodeChange(fixture, 0, 'absent'),
        'flip-to-absent',
      );
      const outcome = await correction.apply(applyInput(fixture, requestId), reviewer, auditMeta);
      expect(outcome.commit.correctionStatus).toBe('applied');

      const after = await closureFacts(fixture.activityId);
      // ① 关闭版本:1 → 2,且旧行指回本次更正。
      expect(after.revision).toBe(2);
      await expect(
        prisma.activitySettlementClosureRevision.findMany({
          where: { activityId: fixture.activityId },
          select: { revision: true, statusCode: true, supersededByCorrectionId: true },
          orderBy: { revision: 'asc' },
        }),
      ).resolves.toStrictEqual([
        { revision: 1, statusCode: 'superseded', supersededByCorrectionId: requestId },
        { revision: 2, statusCode: 'active', supersededByCorrectionId: null },
      ]);
      // ② 人员:人口数不变(缺席的人**仍在人口里**),但结果码分布变了。
      expect(after.personCount).toBe(2);
      expect(after.resultCounts).toStrictEqual({ present: 1, absent: 1 });
      // ③ 时长 8.00 → 4.00;④ 分数 2.40 → 1.20(都只掉被改的那一位那份)。
      expect(Number(after.serviceHours)).toBe(4);
      expect(Number(after.contributionPoints)).toBe(1.2);
      expect(await dayStates([flipped])).toStrictEqual([
        { memberId: flipped, ledgerDate: LEDGER_DATE, version: 2, credited: '0.00' },
      ]);
      // ⑤ 评价资格:被改的那位从"可评价"变成"不可评价",历史评价原样保留(不静默删)。
      //
      // 🔴🔴 **这里少了一格,是实测查出来的缺陷,不是本用例偷懒 —— 逐字写在这里免得后来者以为覆盖全了。**
      //    `eligibilityCorrected`(「最新结算纠错是否已撤销本人的当前评价资格」)走真更正链时
      //    **恒为 false**,它只在手写夹具里才会变 true:
      //      · `wasEligibleBeforeLatestClosure()` 找旧 closure 上的结果行时带
      //        `statusCode: 'committed'` 这个条件(`activity-feedbacks.service.ts`);
      //      · 而真更正链在 commit 同事务里把**旧结果行一律投影成 `superseded`**
      //        (`correction-application.service.ts` 的 `SET "statusCode" = 'superseded'`,§5.14 ⑥ 要求的);
      //      ⇒ 两者对不上,那次查询在生产路径上永远查不到东西。
      //    既有 AC-065 用例读到 `eligibilityCorrected: true`,是因为它的夹具**手写**两版结果行、
      //    两版都留在 `committed`、旧 closure 只改 statusCode —— 那是真更正链从不产出的形态。
      //    ⇒ 本刀**不修**(AGENTS §2:调研中发现的问题不顺手修,先汇报),也**不把 false 断言进来**
      //      —— 断言 false 等于给缺陷发一张契约。已登记进 `NEXT_TASKS` P1-28 的验收分拣小节。
      await expect(
        activityFeedbacks.getMine(fixture.activityId, flippedUser),
      ).resolves.toMatchObject({
        canSubmit: false,
        feedback: expect.objectContaining({ rating: 5, comment: '很好' }),
      });

      // 🔴 正对照:未被更正的那位,分数原样、评价资格原样 ——
      //    证明上面五格的变化是"跟着那一个人走"的,不是整份账被推倒重来。
      expect(await dayStates([untouched])).toStrictEqual([
        { memberId: untouched, ledgerDate: LEDGER_DATE, version: 2, credited: '1.20' },
      ]);
      await expect(
        activityFeedbacks.getMine(fixture.activityId, untouchedUser),
      ).resolves.toMatchObject({
        canSubmit: true,
        feedback: expect.objectContaining({ eligibilityCorrected: false }),
      });
    });

    it('🔴 ADV-012 缺席改出勤:反方向五格一起变(人到了却被判缺席,是更正要修的原形)', async () => {
      // 基础形态:0 号**打了卡、有服务段**,但结算把他判成 absent(零认定值)。
      const fixture = await createSettledActivity({ memberCount: 2, absentMemberIndexes: [0] });
      await markCompleted(fixture.activityId);
      const [flipped, untouched] = fixture.memberIds;
      const flippedUser = await appUserFor(flipped, 'rev-flip');

      const before = await closureFacts(fixture.activityId);
      expect(before.revision).toBe(1);
      expect(before.resultCounts).toStrictEqual({ present: 1, absent: 1 });
      expect(Number(before.serviceHours)).toBe(4);
      expect(Number(before.contributionPoints)).toBe(1.2);
      // 缺席那位:零认定 ⇒ 日合计 0.00,评价资格没有。
      expect(await dayStates([flipped])).toStrictEqual([
        { memberId: flipped, ledgerDate: LEDGER_DATE, version: 1, credited: '0.00' },
      ]);
      await expect(
        activityFeedbacks.getMine(fixture.activityId, flippedUser),
      ).resolves.toMatchObject({ canSubmit: false });

      const requestId = await submitAndApprove(
        fixture,
        resultCodeChange(fixture, 0, 'present'),
        'flip-to-present',
      );
      const outcome = await correction.apply(applyInput(fixture, requestId), reviewer, auditMeta);
      expect(outcome.commit.correctionStatus).toBe('applied');

      const after = await closureFacts(fixture.activityId);
      expect(after.revision).toBe(2);
      // 人数(按结果码)/ 时长 / 分数 三格同向增加。
      expect(after.resultCounts).toStrictEqual({ present: 2 });
      expect(Number(after.serviceHours)).toBe(8);
      expect(Number(after.contributionPoints)).toBe(2.4);
      expect(await dayStates([flipped])).toStrictEqual([
        { memberId: flipped, ledgerDate: LEDGER_DATE, version: 2, credited: '1.20' },
      ]);
      // 评价资格从"没有"变成"有" —— 这一格只有走完真更正链才可能翻过来。
      await expect(
        activityFeedbacks.getMine(fixture.activityId, flippedUser),
      ).resolves.toMatchObject({ canSubmit: true, feedback: null });
      // 正对照:另一位一分未动。
      expect(await dayStates([untouched])).toStrictEqual([
        { memberId: untouched, ledgerDate: LEDGER_DATE, version: 2, credited: '1.20' },
      ]);
    });
  });

  // =========================================================================
  // ⑪ ⭐ 验收编号 ADV-011(2026-08 补写)—— **同一结算项同时申请两个更正**
  //
  //   ADV-011「同一结算项同时申请两个更正。」
  //
  // 此前的证据只有两层,**中间那层是空的**:
  //   · 串行层:⑨「同一 target 同时只允许一条进行中的申请 ⇒ 20101」是两次**先后**调用;
  //   · schema 层:partial unique `attendance_correction_request_open_unique`
  //     (`NULLS NOT DISTINCT`,只覆盖 pending/returned/approved/applying)。
  //   ⇒ **真并发**这一层全仓零覆盖:更正线在本刀之前是单实例的,写不出真竞态。
  //
  // 判据形状(三层,红集互不重叠):
  //   ① 前提 —— 两套实例确实是两套 pool(否则下面的"并发"是假的);
  //   ② 反向 —— 同一 target 两条真并发提交:恰 1 成功、败者具名 20101,
  //      且库里该 target 的申请行**恰 1 条**(不是"报了错但留下两行");
  //   ③ 正向对照 —— **不同 target** 的两条同样并发提交**双双成功**,
  //      证明串行化是按 target 收的,而不是"任意两条并发提交必然死一条"。
  // =========================================================================
  describe('⭐ ⑪ ADV-011:同一结算项两条真并发更正申请', () => {
    /**
     * 正面证明两条提交事务真的堵在 Activity 行锁上。
     *
     * `SELECT title FROM "Activity" … FOR UPDATE` 逐字认的是
     * `CorrectionApplicationService.lockActivity`(更正锁序第一层);
     * 闸门事务自己用的是 `SELECT id …`,不会把自己数进来。
     *
     * ⚠️ 轮询上限刻意压到 3s:提交走的是 Prisma 默认 5s 事务预算,
     *    等待超过预算会把"真症状"变成"超时假红"(仓内已有教训)。
     */
    async function waitForCorrectionLockWaiters(expected: number): Promise<void> {
      const deadline = Date.now() + 3_000;
      let observed = 0;
      while (Date.now() < deadline) {
        const [row] = await prismaB.$queryRaw<Array<{ waitingCount: number }>>`
          SELECT count(*)::int AS "waitingCount"
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'
            AND query LIKE '%SELECT title FROM "Activity"%'
            AND query LIKE '%FOR UPDATE%'
        `;
        observed = row?.waitingCount ?? 0;
        if (observed >= expected) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`期望至少 ${expected} 条更正提交堵在 Activity 行锁上,实际看到 ${observed}`);
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
      const done = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${activityId} FOR UPDATE`;
        signalReady();
        await gate;
      });
      await ready;
      return { release, done };
    }

    /**
     * 把两条提交夹在闸门两侧跑一遍,返回 `allSettled` 结果。
     * ⚠️ 屏障异常在 `allSettled` **之后**才抛,且放闸写在 `finally` 里 ——
     *    否则屏障超时会让闸门事务泄漏,后面所有用例跟着假红。
     */
    async function raceSubmits(
      activityId: string,
      inputs: readonly [CorrectionSubmitInput, CorrectionSubmitInput],
    ): Promise<PromiseSettledResult<unknown>[]> {
      const gate = await holdActivityLock(activityId);
      const a = correction.submit(inputs[0], submitter, auditMeta);
      const b = correctionB.submit(inputs[1], submitter, auditMeta);
      let barrierError: unknown;
      try {
        await waitForCorrectionLockWaiters(2);
      } catch (error) {
        barrierError = error;
      } finally {
        gate.release();
        await gate.done;
      }
      const results = await Promise.allSettled([a, b]);
      if (barrierError instanceof Error) throw barrierError;
      if (barrierError !== undefined) {
        throw new Error('屏障等待抛出了非 Error 值,无法转述');
      }
      return results;
    }

    it('两套 Nest 实例确实是两套 pool(本组判据的前提)', async () => {
      expect(prisma).not.toBe(prismaB);
      const [[backendA], [backendB]] = await Promise.all([
        prisma.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
        prismaB.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
      ]);
      expect(backendA?.pid).not.toBe(backendB?.pid);
    });

    it('🔴 同一 target 两条真并发申请 ⇒ 恰 1 条成功、败者 20101,库里恰 1 行', async () => {
      const fixture = await createSettledActivity({ memberCount: 2 });
      const results = await raceSubmits(fixture.activityId, [
        submitInput(fixture, pointsChange(fixture, '0.60'), 'race-a'),
        submitInput(fixture, pointsChange(fixture, '0.30'), 'race-b'),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      expect(rejected?.reason).toBeInstanceOf(BizException);
      expect((rejected?.reason as BizException).biz.code).toBe(
        BizCode.CORRECTION_TARGET_ALREADY_OPEN.code,
      );
      // 🔴 不只看"报了错":库里该 target 的申请行必须**恰 1 条**。
      await expect(
        prisma.attendanceCorrectionRequest.count({
          where: {
            activityId: fixture.activityId,
            participationIdentityId: fixture.identityIds[0],
          },
        }),
      ).resolves.toBe(1);
    });

    it('正对照:两条并发申请打在**不同** target 上 ⇒ 双双成功(串行化是按 target 收的)', async () => {
      const fixture = await createSettledActivity({ memberCount: 2 });
      const second = {
        ...submitInput(fixture, pointsChange(fixture, '0.30'), 'race-other'),
        participationIdentityId: fixture.identityIds[1],
      };
      const results = await raceSubmits(fixture.activityId, [
        submitInput(fixture, pointsChange(fixture, '0.60'), 'race-first'),
        second,
      ]);

      expect(results.map((result) => result.status)).toStrictEqual(['fulfilled', 'fulfilled']);
      await expect(
        prisma.attendanceCorrectionRequest.count({ where: { activityId: fixture.activityId } }),
      ).resolves.toBe(2);
    });
  });

  // ===== 只走到"准备完成、尚未生效"的夹具(第 ④ 组用)=======================
  async function createUnsettledReadyBatch(): Promise<CorrectionFixture> {
    sequence += 1;
    const tag = `plain-${sequence}`;
    const activity = await prisma.activity.create({
      data: {
        title: `普通批次活动 ${sequence}`,
        activityTypeCode: `activity-plain-type-${sequence}`,
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
    const memberId = randomUUID();
    await prisma.member.create({
      data: {
        id: memberId,
        memberNo: `${tag}-m0`,
        ...memberIdentityData(`${tag} 队员`),
        gradeCode: 'level-2',
      },
    });
    const registration = await prisma.activityRegistration.create({
      data: { activityId: activity.id, memberId, statusCode: 'pass' },
      select: { id: true },
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
        populationCountDistinct: 1,
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
        personCount: 1,
        sessionParticipationCount: 1,
        serviceSegmentCount: 1,
        createdByUserId: submitter.id,
        submittedAt: SEAL_AT,
        statusCode: 'approved',
      },
      select: { id: true },
    });
    const identity = await prisma.activityParticipationIdentity.create({
      data: {
        activityId: activity.id,
        sessionId: session.id,
        registrationId: registration.id,
        memberId,
        currentStatusCode: 'pass',
        populationIncluded: true,
      },
      select: { id: true },
    });
    const checkIn = await prisma.attendancePunchEvent.create({
      data: {
        activityId: activity.id,
        sessionId: session.id,
        participationIdentityId: identity.id,
        memberId,
        eventTypeCode: 'check_in',
        sourceCode: 'self_qr',
        occurredAt: SESSION_START,
        receivedAt: SESSION_START,
        operatorUserId: submitter.id,
        eventKey: `${tag}-in-0`,
        requestHash: `${tag}-in-hash-0`,
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
        checkInAt: SESSION_START,
        checkOutAt: new Date(SESSION_START.getTime() + 2 * 3600_000),
        serviceHours: 2,
      },
    });
    const revision = await prisma.participantSettlementResultRevision.create({
      data: {
        settlementVersionId: version.id,
        participationIdentityId: identity.id,
        revision: 0,
        resultCode: 'present',
        recognizedServiceHours: 4,
        recognizedContributionPoints: 1.2,
        calculatedServiceHours: 4,
        calculatedContributionPoints: 1.2,
        statusCode: 'draft',
      },
      select: { id: true },
    });
    const batch = await prisma.ledgerPostingBatch.create({
      data: {
        settlementRunId: run.id,
        settlementVersionId: version.id,
        batchRevision: 1,
        statusCode: 'preparing',
        requestKey: `settlement-final-approve:${version.id}:${tag}`,
        requestHash: `${tag}-approve-hash`,
        totalCount: 1,
        preparedByUserId: submitter.id,
      },
      select: { id: true },
    });
    const { jobId } = await preparation.ensurePrepareJob(batch.id);
    const items = await prisma.activityBatchJobItem.findMany({
      where: { jobId },
      select: { id: true },
      orderBy: { itemKey: 'asc' },
    });
    for (const item of items) await preparation.prepareChunk(jobId, item.id);
    await preparation.finalize(jobId);

    return {
      activityId: activity.id,
      sessionId: session.id,
      runId: run.id,
      versionId: version.id,
      batchId: batch.id,
      sealId: seal.id,
      memberIds: [memberId],
      identityIds: [identity.id],
      resultRevisionIds: [revision.id],
      closureRevisionId: '',
      tag,
    };
  }
});
