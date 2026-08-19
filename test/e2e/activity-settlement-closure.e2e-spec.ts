import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityClosureAuditRecorder } from '../../src/modules/activities/activity-closure-audit-recorder';
import type {
  ActivityClosureGapCode,
  ActivityClosureChecksJson,
} from '../../src/modules/activities/activity-closure-checks';
import {
  ActivityClosureService,
  type ActivityClosureOutcome,
} from '../../src/modules/activities/activity-closure.service';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// ===== 活动改造 v1.1 第 2 批第六刀:机器关账(合同 §5.15 + §3.26)=====
//
// 🔴🔴 **关账是"这场活动的账算完了"的唯一权威**(合同 §1.2 把它从负责人**声明**
//    改成**机器检查**)。它的失败模式不是报错,是**悄悄关掉一场没算完的活动** ——
//    此后统计、评价资格、入队进度全读这张 closure,而维护者看不懂代码、发现不了。
//
// ⭐ 本 spec 的组织方式就是 goal 要的那张**红集矩阵**:
//    ② 先证明基线八类全过(正对照 —— 没有它,后面每一条红都可能只是夹具本身坏了);
//    ③ 八类逐条**只拨一项**,断言 `gaps` 恰好等于 `[那一类]`。
//       ⇒ 「红集互不重叠」不是事后统计出来的,是**每条用例自己断言的**。
//    ④ 🔴 零部分写入:前七类过、第八类失败 ⇒ closure 零行 / 两个指针未动 / intent 零条。
//    ⑤ 幂等三态 + 并发串行(AC-063)。
//    ⑥ checksJson 无人员明细(§3.26)+ intent 同事务回滚 + 归档等待不是截止日。
//
// 夹具**跑真实的第五刀**(准备 → 统一生效)而不是手写账本:关账要读的正是第五刀
// 产出的形态,手搓一份等于让本刀去核对一个从没在生产出现过的世界。
//
// 时间口径:全部用 2020 年的固定过去时刻(沿前五刀 spec;不耦合墙钟,无定时炸弹)。

/** 北京 2020-03-01 09:00 → 13:00(= UTC 01:00 → 05:00),整块落在北京 03-01。 */
const SESSION_START = new Date('2020-03-01T01:00:00.000Z');
const SESSION_END = new Date('2020-03-01T05:00:00.000Z');
const SEAL_AT = new Date('2020-03-01T09:00:00.000Z');
const LEDGER_DATE = '2020-03-01';

interface ClosureFixture {
  activityId: string;
  sessionId: string;
  runId: string;
  versionId: string;
  batchId: string;
  sealId: string;
  ownerMemberId: string;
  memberIds: string[];
  registrationIds: string[];
  identityIds: string[];
  resultRevisionIds: string[];
  tag: string;
}

describe('机器关账 —— 十二步 / 八类硬检查 (合同 §5.15 + §3.26)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let preparation: LedgerPreparationService;
  let posting: LedgerPostingService;
  let closure: ActivityClosureService;
  let auditRecorder: ActivityClosureAuditRecorder;

  let actor: CurrentUserPayload;
  let organizationId: string;
  let sequence = 0;

  const auditMeta = { requestId: 'activity-closure-e2e', ip: null, ua: null };

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
    auditRecorder = app.get(ActivityClosureAuditRecorder);

    const user = await createTestUser(app, {
      username: 'activity-closure-actor',
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
      data: { name: '机器关账测试组织', nodeTypeCode: 'activity-closure-team' },
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

  // =========================================================================
  // 夹具:一场**真的走完第五刀**的活动 —— 账已生效、run 已 posted。
  //
  // 只有 `settled: false` 时才停在"结算还没生效"那一步(第 ⑤ 类的红用它)。
  // =========================================================================
  async function createClosureFixture(
    options: {
      memberCount?: number;
      recognizedPoints?: number;
      recognizedHours?: number;
      /** false = 只造到"终审通过、批次 preparing",不跑准备与生效。 */
      settled?: boolean;
      /** 报名状态。缺省用生产 service 真正写的 `pass`。 */
      registrationStatus?: string;
      archiveWaitingDays?: number;
    } = {},
  ): Promise<ClosureFixture> {
    const memberCount = options.memberCount ?? 2;
    const recognizedPoints = options.recognizedPoints ?? 1.2;
    const recognizedHours = options.recognizedHours ?? 4;
    const settled = options.settled ?? true;
    sequence += 1;
    const tag = `closure-${sequence}`;

    const activity = await prisma.activity.create({
      data: {
        title: `关账活动 ${sequence}`,
        activityTypeCode: `activity-closure-type-${sequence}`,
        organizationId,
        startAt: SESSION_START,
        endAt: SESSION_END,
        location: '深圳',
        statusCode: 'published',
        ...(options.archiveWaitingDays === undefined
          ? {}
          : { archiveWaitingDays: options.archiveWaitingDays }),
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
        displayName: `${tag} 队员 ${index}`,
        gradeCode: 'level-2',
      })),
    });
    const registrationIds = memberIds.map(() => randomUUID());
    await prisma.activityRegistration.createMany({
      data: registrationIds.map((id, index) => ({
        id,
        activityId: activity.id,
        memberId: memberIds[index],
        // ⚠️ 生产 service 写的是 `pass`(第五刀 e2e 夹具写的是 `approved`,而该列
        //    没有 DB CHECK)—— 这处取值分叉已作为 finding 上报。本刀夹具用生产值。
        statusCode: options.registrationStatus ?? 'pass',
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
          operatorUserId: actor.id,
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

    const fixture: ClosureFixture = {
      activityId: activity.id,
      sessionId: session.id,
      runId: run.id,
      versionId: version.id,
      batchId: batch.id,
      sealId: seal.id,
      ownerMemberId: ownerMember.id,
      memberIds,
      registrationIds,
      identityIds,
      resultRevisionIds,
      tag,
    };

    if (settled) {
      // 🔴 走**真实**的第五刀:分块准备 → 短事务统一生效。
      //    关账要核对的正是它产出的形态,不手搓账本。
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
        actor,
        auditMeta,
      );
    }

    return fixture;
  }

  /** 造一个"计数自洽"的容量桶 —— 第 ⑦ 类的名额对账要有正对照才谈得上反对照。 */
  async function createConsistentCapacityBucket(fixture: ClosureFixture): Promise<string> {
    const bucket = await prisma.activityCapacityBucket.create({
      data: {
        activityId: fixture.activityId,
        scopeTypeCode: 'session_participation',
        scopeId: `${fixture.sessionId}:${fixture.tag}`,
        capacity: 10,
        occupied: fixture.identityIds.length,
      },
      select: { id: true },
    });
    for (const identityId of fixture.identityIds) {
      await prisma.capacityReservation.create({
        data: {
          identityId,
          bucketId: bucket.id,
          reservationType: 'session_participation',
          status: 'active',
        },
      });
    }
    return bucket.id;
  }

  function closeInput(fixture: ClosureFixture, suffix = '1') {
    return { operationKey: `${fixture.tag}-close-${suffix}`, requestHash: `${fixture.tag}-hash` };
  }

  async function runClose(fixture: ClosureFixture, suffix = '1'): Promise<ActivityClosureOutcome> {
    return await closure.close(fixture.activityId, closeInput(fixture, suffix), actor, auditMeta);
  }

  /** 断言:恰好这一类红,别的七类全绿 —— 这就是红集矩阵的一行。 */
  function expectOnlyGap(
    outcome: ActivityClosureOutcome,
    gapCode: ActivityClosureGapCode,
  ): Record<string, number> {
    if (outcome.outcome !== 'blocked') {
      throw new Error(`期望被缺口挡下,实际关账成功(${gapCode})`);
    }
    expect(outcome.gaps.map((gap) => gap.gapCode)).toEqual([gapCode]);
    expect(outcome.checks.filter((check) => !check.passed).map((check) => check.gapCode)).toEqual([
      gapCode,
    ]);
    // 返回体必须能看出"缺多少个"(§5.15 ⑫),不是一句笼统的失败。
    expect(outcome.gaps[0].count).toBeGreaterThan(0);
    expect(outcome.gaps[0].bizCode).toBeGreaterThan(0);
    return outcome.gaps[0].details;
  }

  /** 🔴 「一行都没写」的完整取证:closure 零行 / 两个指针未动 / intent 零条 / audit 零条。 */
  async function expectNothingWritten(
    fixture: ClosureFixture,
    expectedExistingClosures = 0,
  ): Promise<void> {
    await expect(
      prisma.activitySettlementClosureRevision.count({ where: { activityId: fixture.activityId } }),
    ).resolves.toBe(expectedExistingClosures);
    const activity = await prisma.activity.findUniqueOrThrow({
      where: { id: fixture.activityId },
      select: { currentClosureRevision: true },
    });
    expect(activity.currentClosureRevision).toBeNull();
    const run = await prisma.attendanceSettlementRun.findUniqueOrThrow({
      where: { id: fixture.runId },
      select: { currentClosureRevision: true, statusCode: true },
    });
    expect(run.currentClosureRevision).toBeNull();
    expect(run.statusCode).not.toBe('closed');
    await expect(
      prisma.notificationOutboxIntent.count({
        where: { eventKey: { startsWith: `settlement-closure:${fixture.activityId}:` } },
      }),
    ).resolves.toBe(0);
    await expect(countClosureAudits(fixture)).resolves.toBe(0);
  }

  async function countClosureAudits(fixture: ClosureFixture): Promise<number> {
    const audits = await prisma.auditLog.findMany({
      where: { resourceType: 'activity', resourceId: fixture.activityId },
      select: { context: true },
    });
    return audits.filter(
      (row) =>
        (row.context as { extra?: { operation?: string } } | null)?.extra?.operation ===
        'settlement-closure',
    ).length;
  }

  async function insertActiveClosure(fixture: ClosureFixture, revision = 9): Promise<string> {
    const created = await prisma.activitySettlementClosureRevision.create({
      data: {
        activityId: fixture.activityId,
        revision,
        settlementVersionId: fixture.versionId,
        postingBatchId: fixture.batchId,
        evidenceSealId: fixture.sealId,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        personCount: 0,
        sessionParticipationCount: 0,
        resultCountsJson: {},
        serviceHours: '0.00',
        contributionPoints: '0.00',
        checksHash: `pre-existing-${fixture.tag}`,
        checksJson: { schemaVersion: 1, checks: [] },
        statusCode: 'active',
        closedByUserId: actor.id,
        closedAt: SEAL_AT,
      },
      select: { id: true },
    });
    return created.id;
  }

  // =========================================================================
  // ② 正对照:八类全过 ⇒ 追加第 1 版 closure(没有它,后面每条红都可能只是夹具坏了)
  // =========================================================================
  describe('② 正对照:八类全过 ⇒ 关账成功(§5.15 ⑩⑪)', () => {
    it('写不可变 closure + 两个指针 + archive waiting + audit + 评价开放 intent', async () => {
      const fixture = await createClosureFixture({ memberCount: 2 });
      await createConsistentCapacityBucket(fixture);

      const outcome = await runClose(fixture);
      if (outcome.outcome !== 'closed') {
        throw new Error(`期望关账成功,实际缺口:${JSON.stringify(outcome.gaps)}`);
      }
      const result = outcome.closure;

      // 八类逐类留痕,全绿。
      expect(result.checks).toHaveLength(8);
      expect(result.checks.every((check) => check.passed)).toBe(true);
      expect(result.revision).toBe(1);
      expect(result.replayed).toBe(false);

      // §3.26 的不可变行。
      const row = await prisma.activitySettlementClosureRevision.findUniqueOrThrow({
        where: { id: result.closureRevisionId },
        select: {
          activityId: true,
          revision: true,
          statusCode: true,
          settlementVersionId: true,
          postingBatchId: true,
          evidenceSealId: true,
          personCount: true,
          sessionParticipationCount: true,
          resultCountsJson: true,
          serviceHours: true,
          contributionPoints: true,
          checksHash: true,
          closedByUserId: true,
        },
      });
      expect(row.statusCode).toBe('active');
      expect(row.settlementVersionId).toBe(fixture.versionId);
      expect(row.postingBatchId).toBe(fixture.batchId);
      expect(row.evidenceSealId).toBe(fixture.sealId);
      expect(row.personCount).toBe(2);
      expect(row.sessionParticipationCount).toBe(2);
      expect(row.resultCountsJson).toEqual({ present: 2 });
      // 金额取**已生效分录**的合计:2 人 × 4 小时 / 2 人 × 1.2 分。
      expect(Number(row.serviceHours)).toBe(8);
      expect(Number(row.contributionPoints)).toBe(2.4);
      expect(row.checksHash).toBe(result.checksHash);
      expect(row.closedByUserId).toBe(actor.id);

      // §5.15 ⑪ 两个 current closure 指针。
      await expect(
        prisma.activity.findUniqueOrThrow({
          where: { id: fixture.activityId },
          select: { currentClosureRevision: true },
        }),
      ).resolves.toEqual({ currentClosureRevision: 1 });
      const run = await prisma.attendanceSettlementRun.findUniqueOrThrow({
        where: { id: fixture.runId },
        select: { statusCode: true, currentClosureRevision: true },
      });
      expect(run).toEqual({ statusCode: 'closed', currentClosureRevision: 1 });

      // §5.15 ⑪ 归档等待(派生态:closedAt + archiveWaitingDays;默认 7)。
      expect(result.archiveWaitingDays).toBe(7);
      expect(result.archiveWaitingUntil.getTime() - result.closedAt.getTime()).toBe(
        7 * 24 * 3600_000,
      );

      // §5.15 ⑪ audit + 评价开放 intent(同事务)。
      await expect(countClosureAudits(fixture)).resolves.toBe(1);
      const intents = await prisma.notificationOutboxIntent.findMany({
        where: { eventKey: `settlement-closure:${fixture.activityId}:1` },
        select: { destinationRef: true, aggregateId: true },
      });
      expect(intents).toHaveLength(1);
      expect(intents[0].destinationRef).toBe(fixture.ownerMemberId);
      expect(intents[0].aggregateId).toBe(fixture.activityId);
    });
  });

  // =========================================================================
  // ③ ⭐⭐ 八类 red-first —— 每条只拨一项,断言 `gaps` 恰好等于那一类
  //    (这一整段就是 goal 要的红集矩阵:每一行自己断言了"互不重叠")
  // =========================================================================
  describe('⭐⭐ ③ 八类硬检查:逐类 red-first + 红集互不重叠', () => {
    it('① 活动还没结束 ⇒ 只有 execution_not_ended(§5.15 ③ / §9.2 ①)', async () => {
      const fixture = await createClosureFixture();
      await prisma.activity.update({
        where: { id: fixture.activityId },
        data: { endAt: new Date('2099-01-01T00:00:00.000Z') },
      });
      const details = expectOnlyGap(await runClose(fixture), 'execution_not_ended');
      expect(details).toEqual({ notEnded: 1, cancelled: 0 });
      await expectNothingWritten(fixture);
    });

    it('① 普通取消的活动 ⇒ 同类的另一项(不伪造服务结算)', async () => {
      const fixture = await createClosureFixture();
      await prisma.activity.update({
        where: { id: fixture.activityId },
        data: { statusCode: 'cancelled' },
      });
      const details = expectOnlyGap(await runClose(fixture), 'execution_not_ended');
      expect(details).toEqual({ notEnded: 0, cancelled: 1 });
    });

    it('① 正式提前终止的活动**照样可以关账**(反向正对照:不是"必须自然结束")', async () => {
      const fixture = await createClosureFixture();
      await prisma.activity.update({
        where: { id: fixture.activityId },
        data: {
          // 计划结束时刻推到未来 ⇒ 只剩"提前终止"这一条通路能让 ① 变绿。
          endAt: new Date('2099-01-01T00:00:00.000Z'),
          terminatedAt: SEAL_AT,
          terminatedByUserId: actor.id,
          terminationReason: '天气原因',
          statusCode: 'terminated',
        },
      });
      const outcome = await runClose(fixture);
      expect(outcome.outcome).toBe('closed');
    });

    it('② active seal 被顶掉 ⇒ 只有 evidence_not_sealed(§5.15 ③ / §9.2 ②)', async () => {
      const fixture = await createClosureFixture();
      await prisma.evidenceSeal.update({
        where: { id: fixture.sealId },
        data: { statusCode: 'superseded' },
      });
      const details = expectOnlyGap(await runClose(fixture), 'evidence_not_sealed');
      expect(details).toEqual({ missingActiveSeal: 1, staleSeal: 0 });
      await expectNothingWritten(fixture);
    });

    it('② 封场后证据版本又变了 ⇒ 同类的另一项(seal 失配)', async () => {
      const fixture = await createClosureFixture();
      await prisma.activityEvidenceState.create({
        data: { activityId: fixture.activityId, evidenceRevision: 3, populationRevision: 0 },
      });
      const details = expectOnlyGap(await runClose(fixture), 'evidence_not_sealed');
      expect(details).toEqual({ missingActiveSeal: 0, staleSeal: 1 });
    });

    it('③ 还有开放服务段 ⇒ 只有 pending_work_exists(§5.15 ④ / §9.2 ③)', async () => {
      const fixture = await createClosureFixture();
      const checkIn = await prisma.attendancePunchEvent.create({
        data: {
          activityId: fixture.activityId,
          sessionId: fixture.sessionId,
          participationIdentityId: fixture.identityIds[0],
          memberId: fixture.memberIds[0],
          eventTypeCode: 'check_in',
          sourceCode: 'self_qr',
          occurredAt: SESSION_START,
          receivedAt: SESSION_START,
          operatorUserId: actor.id,
          eventKey: `${fixture.tag}-open-in`,
          requestHash: `${fixture.tag}-open-hash`,
          evidenceRevision: 0,
        },
        select: { id: true },
      });
      // 已签到、尚未闭合 —— §4.5 的 open 段(三列刻意可空正是为了它)。
      await prisma.participantServiceSegmentRevision.create({
        data: {
          participationIdentityId: fixture.identityIds[0],
          segmentKey: 'seg-open',
          revision: 0,
          sourceCheckInEventId: checkIn.id,
          resultCode: 'valid',
          statusCode: 'draft',
          checkInAt: SESSION_START,
        },
      });
      const details = expectOnlyGap(await runClose(fixture), 'pending_work_exists');
      expect(details.openSegment).toBe(1);
      expect(details.pendingChangeReview).toBe(0);
      await expectNothingWritten(fixture);
    });

    // ⭐ 这一条同时是第 ⑧ 刀的警示:关账**自己**若造出一条 job,就会把更正后重新关账堵死。
    it('③ 还有未完成批量任务 ⇒ 同类的另一项(§9.2 ⑪)', async () => {
      const fixture = await createClosureFixture();
      await prisma.activityBatchJob.create({
        data: {
          jobTypeCode: 'export',
          activityId: fixture.activityId,
          statusCode: 'pending',
          operationKey: `${fixture.tag}-pending-job`,
          payloadVersion: 1,
          payload: {},
        },
      });
      const details = expectOnlyGap(await runClose(fixture), 'pending_work_exists');
      expect(details.unfinishedJob).toBe(1);
      expect(details.openSegment).toBe(0);
    });

    it('AC-061 待复核离线打卡 ⇒ 只有 pending_work_exists', async () => {
      const fixture = await createClosureFixture();
      const publishReview = await prisma.activityPublishReview.create({
        data: {
          activityId: fixture.activityId,
          requestType: 'initial',
          requestVersion: 1,
          baseRevision: 0,
          status: 'approved',
          snapshot: {},
          directPublish: true,
          submittedByUserId: actor.id,
          reviewedByUserId: actor.id,
          reviewedAt: SEAL_AT,
        },
        select: { id: true },
      });
      const ruleSnapshot = await prisma.activityRuleSnapshot.create({
        data: {
          activityId: fixture.activityId,
          workflowRevision: 0,
          resolvedConfig: {},
          snapshotHash: 'a'.repeat(64),
          createdByReviewId: publishReview.id,
        },
        select: { id: true },
      });
      const offlinePackage = await prisma.offlinePackage.create({
        data: {
          activityId: fixture.activityId,
          sessionId: fixture.sessionId,
          operatorUserId: actor.id,
          operatorMemberId: fixture.ownerMemberId,
          deviceId: `${fixture.tag}-device`,
          packageVersion: 1,
          packageKeyVersion: 0,
          statusCode: 'review_required',
          tokenDigest: 'b'.repeat(64),
          ruleSnapshotId: ruleSnapshot.id,
          ruleSnapshotHash: 'a'.repeat(64),
          workflowRevision: 0,
          participantSnapshotHash: 'c'.repeat(64),
          validFrom: SESSION_START,
          validUntil: SESSION_END,
          uploadUntil: new Date(SESSION_END.getTime() + 24 * 3600_000),
          sequenceStart: 1,
          nextExpectedSequence: 1,
          chainAnchorHash: 'd'.repeat(64),
          lastAcceptedHash: 'd'.repeat(64),
          issuedAt: SESSION_START,
          issueOperationKey: `${fixture.tag}-issue`,
          issueRequestHash: 'e'.repeat(64),
        },
        select: { id: true },
      });
      await prisma.offlinePunchReviewItem.create({
        data: {
          offlinePackageId: offlinePackage.id,
          activityId: fixture.activityId,
          sessionId: fixture.sessionId,
          sequence: 1,
          eventKey: `${fixture.tag}-offline-review`,
          statusCode: 'pending',
          anomalyCode: 'package_revoked',
          approvalPolicyCode: 'approvable',
          stagedByUserId: actor.id,
          stagedByMemberId: fixture.ownerMemberId,
          stagedAt: SEAL_AT,
        },
      });

      const details = expectOnlyGap(await runClose(fixture), 'pending_work_exists');
      expect(details.manualReviewPending).toBe(1);
      expect(details.openSegment).toBe(0);
      expect(details.pendingCorrection).toBe(0);
      await expectNothingWritten(fixture);
    });

    it('④ 还有候补身份 ⇒ 只有 participation_unresolved(§5.15 ⑤ / §9.2 ⑥)', async () => {
      const fixture = await createClosureFixture();
      await prisma.activityParticipationIdentity.update({
        where: { id: fixture.identityIds[0] },
        data: { currentStatusCode: 'waitlisted' },
      });
      const details = expectOnlyGap(await runClose(fixture), 'participation_unresolved');
      expect(details.unresolvedIdentity).toBe(1);
      // 「一一对应」的两项**没有**跟着一起红 —— 它们与"未收口"刻意互斥。
      expect(details.populationIdentityNotParticipating).toBe(0);
      expect(details.participatingIdentityOutOfPopulation).toBe(0);
      await expectNothingWritten(fixture);
    });

    it('④ 未确认邀请 ⇒ 同类的另一项', async () => {
      const fixture = await createClosureFixture();
      await prisma.activityInvitation.create({
        data: {
          activityId: fixture.activityId,
          memberId: fixture.memberIds[0],
          statusCode: 'pending',
          expiresAt: SEAL_AT,
          invitedByUserId: actor.id,
        },
      });
      const details = expectOnlyGap(await runClose(fixture), 'participation_unresolved');
      expect(details.pendingInvitation).toBe(1);
    });

    it('④ 状态说参加了、却不在应结算人口里 ⇒ 「一一对应」的另一侧', async () => {
      const fixture = await createClosureFixture();
      // ⚠️ **不能**直接把既有身份改成 populationIncluded=false:那个人已经有人员结果了,
      //    改完之后第 ⑤ 类的 `resultOutOfPopulation` 也会跟着红 —— 那是**真红**
      //    (结果挂在人口外的人身上确实是另一个问题),但用它当判据就等于两类同时动,
      //    红集矩阵这一行会失去意义。故另加一个"状态说参加了、却没进人口"的干净身份。
      const strayMemberId = randomUUID();
      await prisma.member.create({
        data: {
          id: strayMemberId,
          memberNo: `${fixture.tag}-stray`,
          displayName: `${fixture.tag} 漏网队员`,
          gradeCode: 'level-2',
        },
      });
      const strayRegistration = await prisma.activityRegistration.create({
        data: { activityId: fixture.activityId, memberId: strayMemberId, statusCode: 'pass' },
        select: { id: true },
      });
      await prisma.activityParticipationIdentity.create({
        data: {
          activityId: fixture.activityId,
          sessionId: fixture.sessionId,
          registrationId: strayRegistration.id,
          memberId: strayMemberId,
          currentStatusCode: 'pass',
          populationIncluded: false,
        },
      });

      const details = expectOnlyGap(await runClose(fixture), 'participation_unresolved');
      expect(details.participatingIdentityOutOfPopulation).toBe(1);
      expect(details.unresolvedIdentity).toBe(0);
      expect(details.participatingRegistrationWithoutIdentity).toBe(0);
    });

    it('⑤ 有人员结果还没 committed ⇒ 只有 settlement_incomplete(§5.15 ⑥)', async () => {
      const fixture = await createClosureFixture();
      await prisma.participantSettlementResultRevision.update({
        where: { id: fixture.resultRevisionIds[0] },
        data: { statusCode: 'draft' },
      });
      const details = expectOnlyGap(await runClose(fixture), 'settlement_incomplete');
      expect(details.uncommittedResult).toBe(1);
      expect(details.runNotPosted).toBe(0);
      await expectNothingWritten(fixture);
    });

    it('⑥ 结果标签与服务段不一致 ⇒ 只有 result_inconsistent(§5.15 ⑦)', async () => {
      const fixture = await createClosureFixture();
      // 结果说"迟到",而这个人名下没有任何一条迟到的服务段。
      await prisma.participantSettlementResultRevision.update({
        where: { id: fixture.resultRevisionIds[0] },
        data: { lateFlag: true },
      });
      const details = expectOnlyGap(await runClose(fixture), 'result_inconsistent');
      expect(details.flagMismatch).toBe(1);
      expect(details.presentWithoutSegment).toBe(0);
      await expectNothingWritten(fixture);
    });

    it('⑥ 零时长结果却带着时长与贡献 ⇒ 同类的另一项(§9.2 ⑧)', async () => {
      const fixture = await createClosureFixture();
      // 请假却记着 4 小时 / 1.2 分 —— 认定与结果自相矛盾。
      await prisma.participantSettlementResultRevision.update({
        where: { id: fixture.resultRevisionIds[0] },
        data: { resultCode: 'leave', adjustmentReason: null },
      });
      const details = expectOnlyGap(await runClose(fixture), 'result_inconsistent');
      expect(details.zeroResultWithNonZeroTotals).toBe(1);
    });

    it('⑦ 日合计被撑破 3 分 ⇒ 只有 ledger_incomplete(§5.15 ⑧ / §3.24)', async () => {
      const fixture = await createClosureFixture();
      await prisma.memberContributionDayState.update({
        where: {
          memberId_ledgerDate: {
            memberId: fixture.memberIds[0],
            ledgerDate: new Date(`${LEDGER_DATE}T00:00:00.000Z`),
          },
        },
        data: { committedCreditedPoints: '4.00' },
      });
      const details = expectOnlyGap(await runClose(fixture), 'ledger_incomplete');
      expect(details.dayCapExceeded).toBe(1);
      expect(details.committedBatchMissing).toBe(0);
      await expectNothingWritten(fixture);
    });

    it('⑦ 名额对账异常 ⇒ 同类的另一项(§9.2 ⑪)', async () => {
      const fixture = await createClosureFixture();
      const bucketId = await createConsistentCapacityBucket(fixture);
      // 正对照已在 ② 跑过(计数自洽时本项为 0);这里把物化计数拨歪。
      await prisma.activityCapacityBucket.update({
        where: { id: bucketId },
        data: { occupied: fixture.identityIds.length + 1 },
      });
      const details = expectOnlyGap(await runClose(fixture), 'ledger_incomplete');
      expect(details.capacityReconciliationMismatch).toBe(1);
    });

    it('⑧ 已有生效关闭版本 ⇒ 只有 closure_already_active(§5.15 ⑨)', async () => {
      const fixture = await createClosureFixture();
      await insertActiveClosure(fixture);
      const details = expectOnlyGap(await runClose(fixture), 'closure_already_active');
      expect(details).toEqual({ activeClosure: 1 });
    });

    it('AC-061 五种未完成事实一次返回完整结构化缺口且整事务零写', async () => {
      const fixture = await createClosureFixture();

      const checkIn = await prisma.attendancePunchEvent.create({
        data: {
          activityId: fixture.activityId,
          sessionId: fixture.sessionId,
          participationIdentityId: fixture.identityIds[0],
          memberId: fixture.memberIds[0],
          eventTypeCode: 'check_in',
          sourceCode: 'self_qr',
          occurredAt: SESSION_START,
          receivedAt: SESSION_START,
          operatorUserId: actor.id,
          eventKey: `${fixture.tag}-five-gaps-in`,
          requestHash: `${fixture.tag}-five-gaps-in-hash`,
          evidenceRevision: 0,
        },
        select: { id: true },
      });
      await prisma.participantServiceSegmentRevision.create({
        data: {
          participationIdentityId: fixture.identityIds[0],
          segmentKey: 'five-gaps-open',
          revision: 0,
          sourceCheckInEventId: checkIn.id,
          resultCode: 'valid',
          statusCode: 'draft',
          checkInAt: SESSION_START,
        },
      });

      await prisma.attendanceCorrectionRequest.create({
        data: {
          activityId: fixture.activityId,
          settlementRunId: fixture.runId,
          participationIdentityId: fixture.identityIds[0],
          baseSettlementVersionId: fixture.versionId,
          baseResultRevisionId: fixture.resultRevisionIds[0],
          baseClosureRevision: 0,
          requestTypeCode: 'service',
          requestedChangeJson: { reason: 'five-gap-red-set' },
          reason: '验收清算红集',
          statusCode: 'pending',
          submittedByUserId: actor.id,
          submittedAt: SEAL_AT,
        },
      });

      const missingMemberId = randomUUID();
      await prisma.member.create({
        data: {
          id: missingMemberId,
          memberNo: `${fixture.tag}-missing-result`,
          displayName: `${fixture.tag} 待结算成员`,
          gradeCode: 'level-2',
        },
      });
      const missingRegistration = await prisma.activityRegistration.create({
        data: {
          activityId: fixture.activityId,
          memberId: missingMemberId,
          statusCode: 'pass',
        },
        select: { id: true },
      });
      await prisma.activityParticipationIdentity.create({
        data: {
          activityId: fixture.activityId,
          sessionId: fixture.sessionId,
          registrationId: missingRegistration.id,
          memberId: missingMemberId,
          currentStatusCode: 'pass',
          populationIncluded: true,
        },
      });

      const pendingBatch = await prisma.ledgerPostingBatch.create({
        data: {
          settlementRunId: fixture.runId,
          settlementVersionId: fixture.versionId,
          batchRevision: 2,
          statusCode: 'ready',
          requestKey: `${fixture.tag}-five-gaps-batch`,
          requestHash: `${fixture.tag}-five-gaps-batch-hash`,
          preparedCount: 1,
          totalCount: 1,
          preparedAt: SEAL_AT,
          preparedByUserId: actor.id,
        },
        select: { id: true },
      });
      const committedEntry = await prisma.participationLedgerEntry.findFirstOrThrow({
        where: { postingBatchId: fixture.batchId },
        select: {
          memberId: true,
          activityId: true,
          sessionId: true,
          participationIdentityId: true,
          resultRevisionId: true,
          ledgerDate: true,
          entryTypeCode: true,
          serviceHoursDelta: true,
          recognizedPointsDelta: true,
          creditedPointsDelta: true,
          cappedOutPointsDelta: true,
          reversesEntryId: true,
        },
      });
      await prisma.participationLedgerEntry.create({
        data: {
          ...committedEntry,
          postingBatchId: pendingBatch.id,
          entryKey: `${fixture.tag}-five-gaps-entry`,
          operationKey: `${fixture.tag}-five-gaps-entry-operation`,
          requestHash: `${fixture.tag}-five-gaps-entry-hash`,
        },
      });

      await prisma.activityCapacityBucket.create({
        data: {
          activityId: fixture.activityId,
          scopeTypeCode: 'session_participation',
          scopeId: `${fixture.sessionId}:${fixture.tag}:five-gaps`,
          capacity: 10,
          occupied: 1,
        },
      });

      const outcome = await runClose(fixture);
      if (outcome.outcome !== 'blocked') throw new Error('五种缺口应阻止关账');
      expect(outcome.gaps.map((gap) => gap.gapCode)).toEqual([
        'pending_work_exists',
        'settlement_incomplete',
        'ledger_incomplete',
      ]);
      expect(outcome.gaps[0].details).toMatchObject({ pendingCorrection: 1, openSegment: 1 });
      expect(outcome.gaps[1].details).toMatchObject({ populationWithoutResult: 1 });
      expect(outcome.gaps[2].details).toMatchObject({
        entriesInUncommittedBatch: 1,
        capacityReconciliationMismatch: 1,
      });
      await expectNothingWritten(fixture);
    });
  });

  // =========================================================================
  // ④ 🔴🔴 零部分写入(§5.15 ⑫)——「前七类过、第八类失败」的逐条取证
  // =========================================================================
  describe('🔴 ④ 零部分写入:任一失败 ⇒ 不写半张 closure(§5.15 ⑫)', () => {
    it('前七类全过、只有第 ⑧ 类失败 ⇒ closure 零新增 / 指针未动 / intent 零条 / audit 零条', async () => {
      const fixture = await createClosureFixture({ memberCount: 2 });
      await createConsistentCapacityBucket(fixture);
      const preExistingId = await insertActiveClosure(fixture);

      const outcome = await runClose(fixture);
      // 前七类**确实都过了** —— 否则这条用例证明不了"卡在最后一类"。
      const passed = (outcome.outcome === 'blocked' ? outcome.checks : []).filter(
        (check) => check.passed,
      );
      expect(passed).toHaveLength(7);
      expectOnlyGap(outcome, 'closure_already_active');

      // 🔴 判据是**零部分写入**,不是"大部分没写":逐条。
      // (1) 没有产生第二张 closure —— 库里仍然只有那张预置的。
      const closures = await prisma.activitySettlementClosureRevision.findMany({
        where: { activityId: fixture.activityId },
        select: { id: true },
      });
      expect(closures.map((row) => row.id)).toEqual([preExistingId]);
      // (2)(3) Activity / Run 的 closure 指针未动。
      await expect(
        prisma.activity.findUniqueOrThrow({
          where: { id: fixture.activityId },
          select: { currentClosureRevision: true },
        }),
      ).resolves.toEqual({ currentClosureRevision: null });
      const run = await prisma.attendanceSettlementRun.findUniqueOrThrow({
        where: { id: fixture.runId },
        select: { statusCode: true, currentClosureRevision: true },
      });
      expect(run).toEqual({ statusCode: 'posted', currentClosureRevision: null });
      // (4) outbox intent 零条。
      await expect(
        prisma.notificationOutboxIntent.count({
          where: { eventKey: { startsWith: `settlement-closure:${fixture.activityId}:` } },
        }),
      ).resolves.toBe(0);
      // (5) audit 零条。
      await expect(countClosureAudits(fixture)).resolves.toBe(0);
    });

    // §9.2 的原句:「30 人报名通过、0 打卡、0 人员结果时……必须拒绝关闭,
    //   并清楚提示 30 个队员×场次尚未处理」——「30」必须真的出现在返回体里。
    it('⭐ 30 人通过、0 结果 ⇒ 拒绝,且缺口清单里带着那个「30」', async () => {
      const fixture = await createClosureFixture({ memberCount: 30, settled: false });
      // 结算一步都没走:把草稿结果行也删掉,造出"0 人员结果"。
      await prisma.participantSettlementResultRevision.deleteMany({
        where: { settlementVersionId: fixture.versionId },
      });

      const outcome = await runClose(fixture);
      if (outcome.outcome !== 'blocked') throw new Error('期望被缺口挡下');
      const settlement = outcome.gaps.find((gap) => gap.gapCode === 'settlement_incomplete');
      expect(settlement).toBeDefined();
      expect(settlement?.details.populationWithoutResult).toBe(30);
      expect(settlement?.bizCode).toBe(BizCode.ACTIVITY_CLOSURE_SETTLEMENT_INCOMPLETE.code);
      // 一次把所有缺口交出去,而不是只报第一个(合同 §6 的关账页要渲染这份清单)。
      expect(outcome.gaps.length).toBeGreaterThan(1);
      expect(outcome.checks).toHaveLength(8);
      await expectNothingWritten(fixture);
    });
  });

  // =========================================================================
  // ⑤ 幂等(§5.15 ②)+ 并发串行(AC-063)
  // =========================================================================
  describe('⑤ 幂等与并发', () => {
    it('同 key 同 payload ⇒ 返回同一张 closure,不产生第二张', async () => {
      const fixture = await createClosureFixture();
      const first = await runClose(fixture);
      if (first.outcome !== 'closed') throw new Error('首次关账应成功');

      const replay = await runClose(fixture);
      if (replay.outcome !== 'closed') throw new Error('重放应返回同一张 closure');
      expect(replay.closure.closureRevisionId).toBe(first.closure.closureRevisionId);
      expect(replay.closure.revision).toBe(1);
      expect(replay.closure.replayed).toBe(true);
      expect(replay.closure.checksHash).toBe(first.closure.checksHash);

      await expect(
        prisma.activitySettlementClosureRevision.count({
          where: { activityId: fixture.activityId },
        }),
      ).resolves.toBe(1);
      // 重放不再惊动收件人、不再写第二条 audit。
      await expect(countClosureAudits(fixture)).resolves.toBe(1);
      await expect(
        prisma.notificationOutboxIntent.count({
          where: { eventKey: { startsWith: `settlement-closure:${fixture.activityId}:` } },
        }),
      ).resolves.toBe(1);
    });

    it('同 key **不同 payload** ⇒ 20098 撞键(不是静默重放)', async () => {
      const fixture = await createClosureFixture();
      const first = await runClose(fixture);
      expect(first.outcome).toBe('closed');

      const promise = closure.close(
        fixture.activityId,
        { operationKey: `${fixture.tag}-close-1`, requestHash: 'another-payload' },
        actor,
        auditMeta,
      );
      await expect(promise).rejects.toBeInstanceOf(BizException);
      await promise.catch((error: unknown) => {
        expect((error as BizException).biz).toBe(BizCode.ACTIVITY_CLOSURE_OPERATION_KEY_CONFLICT);
      });
      await expect(
        prisma.activitySettlementClosureRevision.count({
          where: { activityId: fixture.activityId },
        }),
      ).resolves.toBe(1);
    });

    // AC-063:关账与并发操作按活动锁串行,不漏检查、不重复关闭。
    it('两次并发关账(不同 key)⇒ 恰好一个成功,另一个被第 ⑧ 类挡下', async () => {
      const fixture = await createClosureFixture();
      const [a, b] = await Promise.all([runClose(fixture, 'a'), runClose(fixture, 'b')]);
      const outcomes = [a, b];
      expect(outcomes.filter((row) => row.outcome === 'closed')).toHaveLength(1);
      const loser = outcomes.find((row) => row.outcome === 'blocked');
      if (loser === undefined || loser.outcome !== 'blocked') {
        throw new Error('应当恰好有一个被挡下');
      }
      expect(loser.gaps.map((gap) => gap.gapCode)).toEqual(['closure_already_active']);
      await expect(
        prisma.activitySettlementClosureRevision.count({
          where: { activityId: fixture.activityId },
        }),
      ).resolves.toBe(1);
    });

    // DoD 6 的兜底:P2002 必须翻成具名码,❌ 不让 Prisma 异常裸奔成 500。
    //
    // ⚠️ **诚实标注**:这条路径在当前锁协议下**走不到** —— closure 的 FK 指向 Activity,
    //    插入时要取该行的 `FOR KEY SHARE`,而本 service 全程持有它的 `FOR UPDATE`
    //    ⇒ 关账事务运行期间,没有第二个事务能插进来一张 closure。故此处用一个探针
    //    强行让版本号撞车(把"下一版号"打回 1),证明**翻译本身**是接上的,
    //    而不是假装存在一个活的并发窗口。
    it('P2002 撞唯一约束 ⇒ 翻成 20097 具名码,不裸奔成 500(防御位)', async () => {
      const fixture = await createClosureFixture();
      const first = await runClose(fixture, 'a');
      expect(first.outcome).toBe('closed');
      // 让第 ⑧ 类通过:旧版本让位(正是 §5.14 ⑥ 更正流程会做的事)。
      await prisma.activitySettlementClosureRevision.updateMany({
        where: { activityId: fixture.activityId },
        data: { statusCode: 'superseded', supersededAt: SEAL_AT },
      });

      const internals = closure as unknown as {
        readMaxRevision: (tx: unknown, activityId: string) => Promise<number>;
      };
      jest.spyOn(internals, 'readMaxRevision').mockResolvedValue(0);

      const promise = runClose(fixture, 'b');
      await expect(promise).rejects.toBeInstanceOf(BizException);
      await promise.catch((error: unknown) => {
        expect((error as BizException).biz).toBe(BizCode.ACTIVITY_CLOSURE_ALREADY_ACTIVE);
      });
    });
  });

  // =========================================================================
  // ⑥ §3.26 checksJson / 同事务 intent / 归档等待不是截止日
  // =========================================================================
  describe('⑥ checksJson、Outbox 铁律与归档等待', () => {
    // 🔴 §3.26:「仅保存非敏感摘要和失败计数,**不复制人员明细**」。
    it('checksJson 不含任何人员明细(字段名与本次样本值双向扫描)', async () => {
      const fixture = await createClosureFixture({ memberCount: 2 });
      const outcome = await runClose(fixture);
      if (outcome.outcome !== 'closed') throw new Error('关账应成功');

      const row = await prisma.activitySettlementClosureRevision.findUniqueOrThrow({
        where: { id: outcome.closure.closureRevisionId },
        select: { checksJson: true },
      });
      const serialized = JSON.stringify(row.checksJson);

      // (a) 字段名:任何逐人字段都不许出现。
      for (const forbidden of [
        'memberId',
        'memberNo',
        'displayName',
        'identityId',
        'participationIdentityId',
        'registrationId',
        'userId',
        'phone',
        'idCard',
        'latitude',
        'longitude',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
      // (b) 样本值:本次夹具**真实存在**的人员标识一个都不许出现
      //     (只扫字段名会漏掉"值被塞进数组"这种形态)。
      for (const value of [
        ...fixture.memberIds,
        ...fixture.identityIds,
        ...fixture.registrationIds,
        fixture.ownerMemberId,
        `${fixture.tag}-m0`,
        `${fixture.tag} 队员 0`,
      ]) {
        expect(serialized).not.toContain(value);
      }
      // (c) 该有的东西都在:八类摘要 + 失败计数 + 摘要总量。
      const checksJson = row.checksJson as unknown as ActivityClosureChecksJson;
      expect(checksJson.checks).toHaveLength(8);
      expect(checksJson.failedClassCount).toBe(0);
      expect(checksJson.failureCount).toBe(0);
      expect(checksJson.totals.resultCountsJson).toEqual({ present: 2 });
    });

    // 🔴 本仓 Outbox 铁律:intent 必须与业务写同事务。
    it('enqueue 之后的一步抛错 ⇒ intent 与 closure **一起**回滚', async () => {
      const fixture = await createClosureFixture();
      jest.spyOn(auditRecorder, 'log').mockRejectedValue(new Error('audit boom'));

      await expect(runClose(fixture)).rejects.toThrow('audit boom');

      await expectNothingWritten(fixture);
      // 反向正对照:去掉探针后同一场活动照样能关账 —— 证明上面红的是探针不是夹具。
      jest.restoreAllMocks();
      const outcome = await runClose(fixture, '2');
      expect(outcome.outcome).toBe('closed');
      await expect(
        prisma.notificationOutboxIntent.count({
          where: { eventKey: { startsWith: `settlement-closure:${fixture.activityId}:` } },
        }),
      ).resolves.toBe(1);
    });

    // 🔴 修订说明 §4:「7 天只是便于发现问题的等待期,**不是合法更正的最终截止日**」。
    it('归档等待期早已过去 ⇒ 让位后重新关账照样成功(不把门焊死)', async () => {
      const fixture = await createClosureFixture({ archiveWaitingDays: 0 });
      const first = await runClose(fixture, 'a');
      if (first.outcome !== 'closed') throw new Error('首次关账应成功');
      // 等待期 0 天 ⇒ 关账那一刻等待期就已经结束。
      expect(first.closure.archiveWaitingDays).toBe(0);
      expect(first.closure.archiveWaitingUntil).toEqual(first.closure.closedAt);

      // §5.14 ⑥:更正 commit 事务内把旧 active closure 投影成 superseded。
      await prisma.activitySettlementClosureRevision.updateMany({
        where: { activityId: fixture.activityId },
        data: { statusCode: 'superseded', supersededAt: SEAL_AT },
      });

      const second = await runClose(fixture, 'b');
      if (second.outcome !== 'closed') {
        throw new Error(`重新关账应成功,实际缺口:${JSON.stringify(second.gaps)}`);
      }
      // §9.3 的版本链:旧版本永久保留,新版本追加。
      expect(second.closure.revision).toBe(2);
      const rows = await prisma.activitySettlementClosureRevision.findMany({
        where: { activityId: fixture.activityId },
        select: { revision: true, statusCode: true },
        orderBy: { revision: 'asc' },
      });
      expect(rows).toEqual([
        { revision: 1, statusCode: 'superseded' },
        { revision: 2, statusCode: 'active' },
      ]);
      // 两版各自一条 intent(粒度带 revision ⇒ 重新关账不会被上一版挤掉)。
      await expect(
        prisma.notificationOutboxIntent.count({
          where: { eventKey: { startsWith: `settlement-closure:${fixture.activityId}:` } },
        }),
      ).resolves.toBe(2);
    });
  });
});
