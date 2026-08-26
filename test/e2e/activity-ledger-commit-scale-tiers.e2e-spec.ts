import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import { decimalToHundredths } from '../../src/modules/activities/ledger-day-allocation';
import { LEDGER_PREPARE_MEMBER_CHUNK_SIZE } from '../../src/modules/activities/ledger-preparation.service';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import {
  LEDGER_COMMIT_SCALE_TIERS,
  LEDGER_COMMIT_SCALE_TIER_WAIVERS,
  scaleDayStateCountDefect,
  scaleEntryCountDefect,
  scaleLedgerTotalDefect,
  scaleMemberCountDefect,
  scaleNoDegradationDefects,
  scaleRanToCompletionDefect,
  scaleTerminalStatusDefect,
  scaleTierClosureDefects,
  scaleTierWaiverFieldDefects,
  type LedgerCommitScaleOutcome,
} from '../helpers/ledger-commit-scale-tiers';

// ===== 合同 §13.7 / §14 的**规模门**:账本统一生效链的 30 / 500 / 2000 三档 =====
//
// 复现命令(§14 要求「保存复现命令与读数」):
//   pnpm test:scale
// 单档排障时可以再收窄,但**三档一起跑才是判据** —— 「不退化」那一维要跨档比较。
//
// ──────────────────────────────────────────────────────────────────────────
// 🔴🔴 为什么这条链可以进 CI,而 `scripts/probe-member-lock-scale.ts` 不进(别读成破例)
//
// 那份探针的头注逐字写着:「读数与机器规格强相关,挂进 jest 会给 CI 引入**性能相关的
// 假红**(本仓已有『本机连跑榨干 → 假红』的事故在案)。故它是手动、可重复的探针,不进 CI。」
//
// ⭐ **那条判断是对的,且未被本文件放宽一个字。** 它反对的是拿**耗时**当判据。
// ⭐ 本文件判的是另一件事:**能不能跑完 + 数字对不对 + 规模变了结果变没变**。
//    这三样与机器快慢**无关** —— 慢十倍,答案一模一样。
//
// 🔴 一票否决线:本文件与 `test/helpers/ledger-commit-scale-tiers.ts` 里
//    **不许出现任何耗时阈值 / 超时断言 / `Date.now()` 差值比较**。
//    出现一个,上面那条区分就不成立,这条链存在的全部理由随之作废。
//    ⚠️ 下面的 `TIER_WATCHDOG_MS` **不是判据**,见它自己的注释。
// ──────────────────────────────────────────────────────────────────────────
//
// 选哪条链:合同点名的是「万人统一生效」那条(§5.13),即
// `LedgerPreparationService`(分块准备)→ `LedgerPostingService.commitBatch`(短事务统一生效)。
// 万人档已由维护者 2026-08-26 判定不做(登记见档位表的 `LEDGER_COMMIT_SCALE_TIER_WAIVERS`),
// 故这里跑的是**同一条链的小规模版本**,不是另换一条更好跑的链。
//
// ⭐ 2000 档不是「500 档再多一点」:`LEDGER_PREPARE_MEMBER_CHUNK_SIZE = 500` ⇒
//    30 / 500 档准备只有 **1 个 chunk**,2000 档是 **4 个**。跨过分块边界之后
//    每人拿到的东西还一不一样,正是「不退化」这一维要问的问题。
//
// ⚠️ 与既有 `activity-ledger-posting-scale.e2e-spec.ts`(8192 人)的分工:
//    那条判的是「每条语句的 bind 参数不随人数增长」,是**语句形状**判据;
//    本条判的是**结果数字**。两条互不顶替,故不合并。

/**
 * jest 看门狗 —— **不是判据**。
 *
 * 仓内每个用例都被 `test/jest-e2e.config.ts` 的 `testTimeout: 30000` 罩着,退订不了;
 * 而 2000 人夹具(6 张表)光建就不止 30 秒。故这里显式放大。
 *
 * 🔴 取值原则与「性能阈值」正好相反:**要大到永远不是下结论的那一格**。
 *    它存在的唯一意义是「进程挂死时别让 CI 空转」,不是「跑得慢就算失败」。
 *    本文件里**没有任何断言读取墙钟**;这个数变大变小都不会改变任何一条判决。
 */
const TIER_WATCHDOG_MS = 900_000;

/** 造夹具时每批写多少行(`createMany` 是多行 VALUES,自己也受 bind 上限约束)。沿 8192 档已验证的值。 */
const FIXTURE_CHUNK = 1_000;

const SESSION_START = new Date('2020-03-01T01:00:00.000Z');
const SESSION_END = new Date('2020-03-01T05:00:00.000Z');
const SEAL_AT = new Date('2020-03-01T09:00:00.000Z');

/** 夹具喂给每个人的**输入**。期望值由它算出来,不是照抄观测值(照抄=自己证明自己)。 */
const PER_MEMBER_SERVICE_HOURS = 4;
const PER_MEMBER_CONTRIBUTION_POINTS = 1;
/** 每人贡献值(百分之一分)。1 分 < 日上限 3 分 ⇒ 不触发封顶,credited 恒等于 recognized。 */
const PER_MEMBER_CREDITED_HUNDREDTHS = PER_MEMBER_CONTRIBUTION_POINTS * 100;

/** 跨档比较用:各档跑完后的观测量。`null` = 那一档没跑完(缺档本身就是「退化」)。 */
const outcomeByTier = new Map<number, LedgerCommitScaleOutcome | null>();

describe('账本统一生效 —— 合同 §13.7 规模门(30 / 500 / 2000 三档;万人档已判定不做)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let preparation: LedgerPreparationService;
  let posting: LedgerPostingService;
  let actor: CurrentUserPayload;

  const auditMeta = { requestId: 'ledger-commit-scale-tiers', ip: null, ua: null };

  beforeAll(async () => {
    // 本 spec 驱动的是**结算真相链**,那条链按定义只在活动 v1.1 闸开时存在;
    // 闸关(默认)时这些写入口一律回 20153。故显式置真 —— 改的只是「跑在闸的哪一侧」,
    // 断言一字未改。
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    preparation = app.get(LedgerPreparationService);
    posting = app.get(LedgerPostingService);
    const user = await createTestUser(app, {
      username: 'ledger-scale-tiers-actor',
      role: Role.SUPER_ADMIN,
    });
    actor = {
      id: user.id,
      username: user.username,
      role: user.role,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
  }, TIER_WATCHDOG_MS);

  afterAll(async () => {
    delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    await app.close();
  });

  /** 建一档的完整夹具,跑完准备 + 生效,把观测量读回来。**全程不记时间。** */
  async function runTier(tier: number): Promise<LedgerCommitScaleOutcome> {
    const tag = `t${tier}`;
    const organization = await prisma.organization.create({
      data: { name: `账本规模组织 ${tag}`, nodeTypeCode: 'ledger-scale-team' },
      select: { id: true },
    });
    const activity = await prisma.activity.create({
      data: {
        title: `账本规模活动 ${tag}`,
        activityTypeCode: 'ledger-scale-type',
        organizationId: organization.id,
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
        code: `ledger-scale-${tag}`,
        name: `规模场次 ${tag}`,
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

    const memberIds = Array.from({ length: tier }, () => randomUUID());
    const registrationIds = memberIds.map(() => randomUUID());
    const identityIds = memberIds.map(() => randomUUID());
    const punchIds = memberIds.map(() => randomUUID());

    const inChunks = async <T>(
      rows: T[],
      write: (chunk: T[]) => Promise<unknown>,
    ): Promise<void> => {
      for (let index = 0; index < rows.length; index += FIXTURE_CHUNK) {
        await write(rows.slice(index, index + FIXTURE_CHUNK));
      }
    };

    await inChunks(
      memberIds.map((id, index) => ({
        id,
        memberNo: `scale-${tag}-m${index}`,
        ...memberIdentityData(`规模队员 ${tag}-${index}`),
        gradeCode: 'level-2',
      })),
      (chunk) => prisma.member.createMany({ data: chunk }),
    );
    await inChunks(
      registrationIds.map((id, index) => ({
        id,
        activityId: activity.id,
        memberId: memberIds[index],
        statusCode: 'approved',
      })),
      (chunk) => prisma.activityRegistration.createMany({ data: chunk }),
    );
    await inChunks(
      identityIds.map((id, index) => ({
        id,
        activityId: activity.id,
        sessionId: session.id,
        registrationId: registrationIds[index],
        memberId: memberIds[index],
        currentStatusCode: 'pass',
        populationIncluded: true,
      })),
      (chunk) => prisma.activityParticipationIdentity.createMany({ data: chunk }),
    );
    await inChunks(
      punchIds.map((id, index) => ({
        id,
        activityId: activity.id,
        sessionId: session.id,
        participationIdentityId: identityIds[index],
        memberId: memberIds[index],
        eventTypeCode: 'check_in',
        sourceCode: 'self_qr',
        occurredAt: SESSION_START,
        receivedAt: SESSION_START,
        operatorUserId: actor.id,
        eventKey: `scale-${tag}-in-${index}`,
        requestHash: `scale-${tag}-in-hash-${index}`,
        evidenceRevision: 0,
      })),
      (chunk) => prisma.attendancePunchEvent.createMany({ data: chunk }),
    );
    await inChunks(
      identityIds.map((identityId, index) => ({
        participationIdentityId: identityId,
        segmentKey: 'seg-0',
        revision: 0,
        sourceCheckInEventId: punchIds[index],
        resultCode: 'valid',
        statusCode: 'draft',
        checkInAt: SESSION_START,
        checkOutAt: SESSION_END,
        serviceHours: PER_MEMBER_SERVICE_HOURS,
      })),
      (chunk) => prisma.participantServiceSegmentRevision.createMany({ data: chunk }),
    );

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
        populationCountDistinct: tier,
        populationCountBySession: {},
        contentHash: `seal-scale-${tag}`,
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
        contentHash: `content-scale-${tag}`,
        personCount: tier,
        sessionParticipationCount: tier,
        serviceSegmentCount: tier,
        createdByUserId: actor.id,
        submittedAt: SEAL_AT,
        statusCode: 'approved',
        operationKey: `scale-${tag}-submit`,
        requestHash: `scale-${tag}-submit-hash`,
      },
      select: { id: true },
    });
    await inChunks(
      identityIds.map((identityId) => ({
        settlementVersionId: version.id,
        participationIdentityId: identityId,
        revision: 0,
        resultCode: 'present',
        recognizedServiceHours: PER_MEMBER_SERVICE_HOURS,
        recognizedContributionPoints: PER_MEMBER_CONTRIBUTION_POINTS,
        calculatedServiceHours: PER_MEMBER_SERVICE_HOURS,
        calculatedContributionPoints: PER_MEMBER_CONTRIBUTION_POINTS,
        statusCode: 'draft',
      })),
      (chunk) => prisma.participantSettlementResultRevision.createMany({ data: chunk }),
    );
    const batch = await prisma.ledgerPostingBatch.create({
      data: {
        settlementRunId: run.id,
        settlementVersionId: version.id,
        batchRevision: 1,
        statusCode: 'preparing',
        requestKey: `settlement-final-approve:scale-${tag}`,
        requestHash: `scale-${tag}-approve-hash`,
        totalCount: tier,
        preparedByUserId: actor.id,
      },
      select: { id: true },
    });

    // ── 准备:分块跑完(2000 档在这里跨过 4 个 chunk)──
    const { jobId, itemCount } = await preparation.ensurePrepareJob(batch.id);
    const items = await prisma.activityBatchJobItem.findMany({
      where: { jobId },
      select: { id: true },
      orderBy: { itemKey: 'asc' },
    });
    for (const item of items) await preparation.prepareChunk(jobId, item.id);
    await preparation.finalize(jobId);

    // ── 生效:一次短事务 ──
    const result = await posting.commitBatch(
      { postingBatchId: batch.id, operationKey: `scale-${tag}-commit` },
      actor,
      auditMeta,
    );

    // ── 读观测量(全部是计数与金额;这里一个时间戳都不采)──
    const entryRowsInDb = await prisma.participationLedgerEntry.count({
      where: { postingBatchId: batch.id },
    });
    const distinctMemberRows = await prisma.participationLedgerEntry.findMany({
      where: { postingBatchId: batch.id },
      select: { memberId: true },
      distinct: ['memberId'],
    });
    const dayStateRowsInDb = await prisma.memberContributionDayState.count({
      where: { latestBatchId: batch.id },
    });
    const ledgerSum = await prisma.participationLedgerEntry.aggregate({
      where: { postingBatchId: batch.id },
      _sum: { creditedPointsDelta: true, serviceHoursDelta: true },
    });
    const dayStateSum = await prisma.memberContributionDayState.aggregate({
      where: { latestBatchId: batch.id },
      _sum: { committedCreditedPoints: true },
    });
    const typeRows = await prisma.participationLedgerEntry.groupBy({
      by: ['entryTypeCode'],
      where: { postingBatchId: batch.id },
    });

    return {
      prepareItemCount: itemCount,
      memberCount: result.memberCount,
      dayStateCount: result.dayStateCount,
      entryCount: result.entryCount,
      entryRowsInDb,
      distinctMembersInDb: distinctMemberRows.length,
      dayStateRowsInDb,
      ledgerCreditedHundredths: decimalToHundredths(ledgerSum._sum.creditedPointsDelta ?? 0),
      dayStateCreditedHundredths: decimalToHundredths(
        dayStateSum._sum.committedCreditedPoints ?? 0,
      ),
      ledgerServiceHundredths: decimalToHundredths(ledgerSum._sum.serviceHoursDelta ?? 0),
      entryTypeCodes: typeRows.map((r) => r.entryTypeCode),
      batchStatus: result.batchStatus,
      runStatus: result.runStatus,
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // 逐档:**每一维各自成 `it`**
  //
  // 🔴 jest 在一个 `it` 内首个失败即停 ⇒ 把六条断言塞进一个 `it` 时,做变异对拍
  //    只能观测到第一条,「判据有判别力」在结构上观测不到 —— 而基线全绿时完全看不出来。
  //    夹具与链路跑一次(`beforeAll`),六个维度各判各的。
  // ══════════════════════════════════════════════════════════════════════
  describe.each(LEDGER_COMMIT_SCALE_TIERS)('规模档 %i 人', (tier) => {
    let outcome: LedgerCommitScaleOutcome | null = null;
    let failure: unknown = null;

    beforeAll(async () => {
      // 刻意**不**在这里 throw:「能跑完」是被判的那一维,它得有自己的 `it`;
      // 在 hook 里抛出去会把这一维的判决藏进 jest 的 hook 失败里。
      try {
        outcome = await runTier(tier);
      } catch (error) {
        failure = error;
      }
      outcomeByTier.set(tier, outcome);
    }, TIER_WATCHDOG_MS);

    it('① 能跑完:准备与生效两段都没抛', () => {
      expect(scaleRanToCompletionDefect(failure)).toBeNull();
    });

    it('② 结算结果行数 = 人数(生效返回值与库里两个证人一致)', () => {
      expect(outcome).not.toBeNull();
      expect(scaleMemberCountDefect(tier, outcome as LedgerCommitScaleOutcome)).toBeNull();
    });

    it('③ 分录数 = 人数 × 2,且恰为 service_credit + contribution_credit 两类', () => {
      expect(outcome).not.toBeNull();
      expect(scaleEntryCountDefect(tier, outcome as LedgerCommitScaleOutcome)).toBeNull();
    });

    it('④ day-state 每人恰一行', () => {
      expect(outcome).not.toBeNull();
      expect(scaleDayStateCountDefect(tier, outcome as LedgerCommitScaleOutcome)).toBeNull();
    });

    it('⑤ 账本总额 = 各人之和(分录侧与 day-state 侧两条独立聚合相等,且 = 每人金额 × 人数)', () => {
      expect(outcome).not.toBeNull();
      expect(
        scaleLedgerTotalDefect(
          tier,
          PER_MEMBER_CREDITED_HUNDREDTHS,
          outcome as LedgerCommitScaleOutcome,
        ),
      ).toBeNull();
    });

    it('⑥ 终态:批次 committed、run posted', () => {
      expect(outcome).not.toBeNull();
      expect(scaleTerminalStatusDefect(outcome as LedgerCommitScaleOutcome)).toBeNull();
    });

    it('⑦ 准备分块数 = ceil(人数 / 500)(2000 档确实跨过了分块边界)', () => {
      expect(outcome).not.toBeNull();
      expect((outcome as LedgerCommitScaleOutcome).prepareItemCount).toBe(
        Math.ceil(tier / LEDGER_PREPARE_MEMBER_CHUNK_SIZE),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // 跨档:不退化 + 档位表闭合
  // ══════════════════════════════════════════════════════════════════════
  describe('跨档', () => {
    it('⑧ 不退化:每一档的「每人形状」与最小档逐字相等(判结果不同,不判变慢)', () => {
      // 读数留痕(§14 要求保存读数)—— 打印的是形状与计数,**没有耗时**。
      console.log(
        JSON.stringify({
          scaleTierReadout: LEDGER_COMMIT_SCALE_TIERS.map((tier) => ({
            tier,
            outcome: outcomeByTier.get(tier),
          })),
        }),
      );
      expect(scaleNoDegradationDefects(outcomeByTier)).toEqual([]);
    });

    it('⑨ 档位表闭合:真跑的三档 ∪ 已判定不做的一档 = 合同 §13.7 的四档', () => {
      expect(scaleTierClosureDefects()).toEqual([]);
    });

    it('⑩ 万人档豁免登记六要素完整(理由 / 拍板人 / 合法日期 / 残余)', () => {
      expect(LEDGER_COMMIT_SCALE_TIER_WAIVERS.map((w) => w.tier)).toEqual([10000]);
      expect(scaleTierWaiverFieldDefects()).toEqual([]);
    });
  });
});
