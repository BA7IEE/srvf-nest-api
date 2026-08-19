import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { SettlementDraftService } from '../../src/modules/activities/settlement-draft.service';
import { SettlementSubmitAuditRecorder } from '../../src/modules/activities/settlement-submit-audit-recorder';
import { SettlementSubmitService } from '../../src/modules/activities/settlement-submit.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// ===== 活动改造 v1.1 第 2 批第三刀:提交不可变 SettlementVersion(合同 §5.10)=====
//
// 🔴 **提交是单向门。** 固化之后只能退回重来,而退回是人工成本 —— 与其让一个错的
//    版本进入审核,不如让提交在校验上红出来。本 spec 的每条判据都写成
//    「**只由它对应的那一处实现触发**」:卸掉哪一处,就只有那一段红(红集不重叠)。
//
// ⭐ 全 spec 最重要的两条在「§5.10 ④」那一段:`PENDING_RESULT` 与 `ITEM_COUNT_MISMATCH`。
//    第二刀把「未决」表达成**不写结果行**,那个设计成立的唯一前提就是这两条闸。
//    它们被刻意造成**互不重叠**:各自的夹具只踩自己那一条(见每条上方的注释)。
//
// 时间口径:全部用 2020 年的固定过去时刻(沿第二刀 spec;不耦合墙钟,无定时炸弹)。

const SESSION_START = new Date('2020-03-01T00:00:00.000Z');
const SESSION_END = new Date('2020-03-01T04:00:00.000Z');
const SEAL_AT = new Date('2020-03-01T09:00:00.000Z');

/**
 * DoD 6 的规模档位。取 8192 是因为它就是 PG bind 上限的临界点:
 * 实测 8192 行 × 4 列 = 32768 个参数即报 `expected maximum of 32767`(32000 通过)。
 *
 * ⚠️ 本用例**不**证明"别的写法会崩"—— Prisma `createMany` 会自动分块,实测在
 *    这个规模上照样绿(变异 A/B 实测,见 settlement-submit.service.ts 文件头)。
 *    它证明的是本刀这条 `INSERT ... SELECT` 在真实规模上跑得通;而"SQL 条数与
 *    人数无关"那一半由文件头的实测读数(1 条 SQL / 2 个 bind 参数)承担。
 */
const SCALE_ROW_COUNT = 8_192;

interface SubmitFixture {
  activityId: string;
  sessionId: string;
  runId: string;
  draftVersionId: string;
  sealId: string;
  /** 进入人口的身份 id(升序稳定)。 */
  identityIds: string[];
  /** 有结果行的身份 id。 */
  resultIdentityIds: string[];
  ownerMemberId: string;
}

describe('settlement submit —— 提交不可变版本 (合同 §5.10)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: SettlementSubmitService;
  let draftService: SettlementDraftService;
  let auditRecorder: SettlementSubmitAuditRecorder;
  let actor: CurrentUserPayload;
  let organizationId: string;
  let sequence = 0;

  const auditMeta = { requestId: 'settlement-submit-e2e', ip: null, ua: null };

  beforeAll(async () => {
    // 第 7 批第 ③ 刀 —— 活动 v1.1 单一 cutover gate(合同 §16.2)。本 spec 驱动的是
    // **结算真相链**(打卡 / 封场 / 结算 / 账本 / 关账 / 更正),那条链按定义只在闸开时存在;
    // 闸关(默认 = 今天的行为)时这些写入口一律回 20153。故此处显式置真,
    // **断言一字未改** —— 改的只是这个 spec 声明自己跑在哪一侧闸。
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    service = app.get(SettlementSubmitService);
    draftService = app.get(SettlementDraftService);
    auditRecorder = app.get(SettlementSubmitAuditRecorder);

    const user = await createTestUser(app, {
      username: 'settlement-submit-actor',
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
      data: { name: '结算提交测试组织', nodeTypeCode: 'settlement-submit-team' },
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
  // 夹具:一个"随时可提交"的活动 —— 已封场、run=drafting、有 draft 版本与结果行。
  //
  // 直接构造草稿状态而不是每次都跑第二刀的生成器:
  //   ① 本刀的判据要造的形态里有一半是生成器**永远不会产出**的(多出人口外的结果行、
  //      带 blocker 的行、开放段),只能直接写;
  //   ② 直接写让每条用例只在同一份基线上**动一处**,红集才可能不重叠。
  // 与生成器的真实衔接另有一条端到端用例(见文末「与第二刀端到端」)。
  // =========================================================================
  async function createSubmittable(
    options: {
      /** 进入人口的人数。 */
      populationSize?: number;
      /** 额外写几条"结果行指向人口外身份"的行(制造基数/包含两侧的差异)。 */
      alienResultRows?: number;
      /** 少给前 N 个人口身份写结果行(制造未决)。 */
      missingResultsFor?: number;
      /** 给第一条结果行挂 blocker(第二刀标的「无有效贡献规则」)。 */
      withBlocker?: boolean;
      /** 给第一个人口身份挂一个没有签退时刻的当前服务段。 */
      withOpenSegment?: boolean;
      runStatusCode?: string;
      withDraftVersion?: boolean;
    } = {},
  ): Promise<SubmitFixture> {
    const populationSize = options.populationSize ?? 2;
    const alienResultRows = options.alienResultRows ?? 0;
    const missingResultsFor = options.missingResultsFor ?? 0;

    sequence += 1;
    const tag = `submit-${sequence}`;

    const activity = await prisma.activity.create({
      data: {
        title: `结算提交活动 ${sequence}`,
        activityTypeCode: `settlement-submit-type-${sequence}`,
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
        code: `${tag}-s1`,
        name: `${tag} 场次一`,
        startAt: SESSION_START,
        endAt: SESSION_END,
        locationText: '深圳',
        checkInOpenAt: new Date(SESSION_START.getTime() - 3600_000),
        checkInCloseAt: new Date(SESSION_START.getTime() + 3600_000),
        checkOutOpenAt: new Date(SESSION_START.getTime() + 2 * 3600_000),
        checkOutCloseAt: new Date('2020-03-01T08:00:00.000Z'),
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });

    // 人口内身份 + 人口外身份(后者用来造"结果行指向人口外的人"这种形态)。
    const identityIds = await createIdentities(activity.id, session.id, tag, populationSize, true);
    const alienIdentityIds = await createIdentities(
      activity.id,
      session.id,
      `${tag}-alien`,
      alienResultRows,
      false,
    );

    // 通知收件人:活动当前 active owner。
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
        // source 是 CHECK 闭集 ('publish'/'delegation'/'transfer'/'legacy-claim'/'admin')。
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
        allWindowsClosedAt: new Date('2020-03-01T08:00:00.000Z'),
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: populationSize,
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
        statusCode: options.runStatusCode ?? 'drafting',
        currentDraftVersion: 1,
      },
      select: { id: true },
    });

    let draftVersionId = '';
    let resultIdentityIds: string[] = [];
    if (options.withDraftVersion !== false) {
      const draft = await prisma.attendanceSettlementVersion.create({
        data: {
          settlementRunId: run.id,
          version: 1,
          evidenceSealId: seal.id,
          evidenceRevision: 0,
          populationRevision: 0,
          workflowRevision: 0,
          contentHash: `draft-hash-${tag}`,
          personCount: populationSize,
          sessionParticipationCount: populationSize,
          serviceSegmentCount: 0,
          createdByUserId: actor.id,
          statusCode: 'draft',
        },
        select: { id: true },
      });
      draftVersionId = draft.id;

      resultIdentityIds = [...identityIds.slice(missingResultsFor), ...alienIdentityIds];
      await prisma.participantSettlementResultRevision.createMany({
        data: resultIdentityIds.map((identityId, index) => ({
          settlementVersionId: draft.id,
          participationIdentityId: identityId,
          revision: 0,
          resultCode: 'present',
          lateFlag: false,
          earlyLeaveFlag: false,
          exceptionFlagsJson:
            options.withBlocker === true && index === 0
              ? { blockers: ['contribution_points_zero_no_effective_rule'] }
              : undefined,
          recognizedServiceHours: 4,
          recognizedContributionPoints: 1.5,
          calculatedServiceHours: 4,
          calculatedContributionPoints: 1.5,
          statusCode: 'draft',
        })),
      });
    }

    if (options.withOpenSegment === true) {
      await createOpenSegment(activity.id, session.id, identityIds[0], tag);
    }

    return {
      activityId: activity.id,
      sessionId: session.id,
      runId: run.id,
      draftVersionId,
      sealId: seal.id,
      identityIds,
      resultIdentityIds,
      ownerMemberId: ownerMember.id,
    };
  }

  async function createIdentities(
    activityId: string,
    sessionId: string,
    tag: string,
    count: number,
    populationIncluded: boolean,
  ): Promise<string[]> {
    if (count === 0) return [];
    const memberIds = Array.from({ length: count }, () => randomUUID());
    const registrationIds = Array.from({ length: count }, () => randomUUID());
    const identityIds = Array.from({ length: count }, () => randomUUID());

    // 分块写:夹具自己也不许撞 bind 上限(32767)。
    await chunkedCreateMany(
      memberIds.map((id, index) => ({
        id,
        memberNo: `${tag}-m${index}`,
        displayName: `${tag} 队员 ${index}`,
        gradeCode: 'level-2',
      })),
      (data) => prisma.member.createMany({ data }),
    );
    await chunkedCreateMany(
      registrationIds.map((id, index) => ({
        id,
        activityId,
        memberId: memberIds[index],
        statusCode: 'approved',
      })),
      (data) => prisma.activityRegistration.createMany({ data }),
    );
    await chunkedCreateMany(
      identityIds.map((id, index) => ({
        id,
        activityId,
        sessionId,
        registrationId: registrationIds[index],
        memberId: memberIds[index],
        currentStatusCode: 'pass',
        populationIncluded,
      })),
      (data) => prisma.activityParticipationIdentity.createMany({ data }),
    );
    return identityIds;
  }

  async function chunkedCreateMany<T>(
    rows: T[],
    write: (chunk: T[]) => Promise<unknown>,
  ): Promise<void> {
    const CHUNK = 1_000;
    for (let offset = 0; offset < rows.length; offset += CHUNK) {
      await write(rows.slice(offset, offset + CHUNK));
    }
  }

  async function createOpenSegment(
    activityId: string,
    sessionId: string,
    identityId: string,
    tag: string,
  ): Promise<void> {
    const event = await prisma.attendancePunchEvent.create({
      data: {
        activityId,
        sessionId,
        participationIdentityId: identityId,
        memberId: (
          await prisma.activityParticipationIdentity.findUniqueOrThrow({
            where: { id: identityId },
            select: { memberId: true },
          })
        ).memberId,
        eventTypeCode: 'check_in',
        sourceCode: 'staff_scan',
        occurredAt: SESSION_START,
        receivedAt: SESSION_START,
        operatorUserId: actor.id,
        eventKey: `${tag}-open-in`,
        requestHash: `${tag}-open-in-hash`,
        evidenceRevision: 0,
      },
      select: { id: true },
    });
    await prisma.participantServiceSegmentRevision.create({
      data: {
        participationIdentityId: identityId,
        segmentKey: `${tag}-open`,
        revision: 0,
        sourceCheckInEventId: event.id,
        sourceCloseEventId: null,
        // resultCode 是 CHECK 闭集 ('valid'/'early_departure_zero'/'voided'/'replaced'),
        // 没有"开放"这个取值 —— 开放段是靠 `checkOutAt IS NULL` 表达的,
        // 这也正是本刀判据读的那一列。
        resultCode: 'valid',
        statusCode: 'draft',
        checkInAt: SESSION_START,
        // 🔴 判据本身:没有签退时刻 ⇒ 开放段。
        checkOutAt: null,
        serviceHours: null,
        lateFlag: false,
        earlyLeaveFlag: false,
      },
    });
  }

  function submitInput(
    fixture: SubmitFixture,
    overrides: Partial<{ operationKey: string; requestHash: string }> = {},
  ) {
    return {
      activityId: fixture.activityId,
      operationKey: overrides.operationKey ?? `op-${fixture.activityId}`,
      requestHash: overrides.requestHash ?? 'payload-hash-1',
    };
  }

  /** 拒绝必须是**干净拒绝**:一条提交版本、一条新结果行、一条 intent 都不许留下。 */
  async function expectRefusal(
    fixture: SubmitFixture,
    expected: (typeof BizCode)[keyof typeof BizCode] | null,
  ): Promise<BizException> {
    const before = await prisma.participantSettlementResultRevision.count({
      where: { settlementVersion: { settlementRun: { activityId: fixture.activityId } } },
    });
    const error = await service.submit(submitInput(fixture), actor, auditMeta).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(BizException);
    if (expected !== null) expect((error as BizException).biz).toBe(expected);

    await expect(
      prisma.attendanceSettlementVersion.count({
        where: { settlementRun: { activityId: fixture.activityId }, statusCode: 'submitted' },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.participantSettlementResultRevision.count({
        where: { settlementVersion: { settlementRun: { activityId: fixture.activityId } } },
      }),
    ).resolves.toBe(before);
    await expect(
      prisma.notificationOutboxIntent.count({ where: { aggregateId: fixture.activityId } }),
    ).resolves.toBe(0);
    return error as BizException;
  }

  // =========================================================================
  // DoD 1 前置 —— run 形态与锁序
  // =========================================================================

  describe('前置闸 —— run 状态与草稿存在性', () => {
    it('没有 run 行 → SETTLEMENT_SUBMIT_RUN_STATUS_INVALID', async () => {
      const fixture = await createSubmittable();
      await prisma.participantSettlementResultRevision.deleteMany({
        where: { settlementVersionId: fixture.draftVersionId },
      });
      await prisma.attendanceSettlementVersion.deleteMany({
        where: { settlementRunId: fixture.runId },
      });
      await prisma.attendanceSettlementRun.delete({ where: { id: fixture.runId } });
      await expectRefusal(fixture, BizCode.SETTLEMENT_SUBMIT_RUN_STATUS_INVALID);
    });

    it.each(['not_started', 'submitted', 'pending_first_review', 'posted', 'closed'])(
      'run 状态为 %s → RUN_STATUS_INVALID(只有 drafting 能提交)',
      async (statusCode) => {
        const fixture = await createSubmittable({ runStatusCode: statusCode });
        await expectRefusal(fixture, BizCode.SETTLEMENT_SUBMIT_RUN_STATUS_INVALID);
      },
    );

    it('drafting 但没有草稿版本 → SETTLEMENT_SUBMIT_DRAFT_MISSING', async () => {
      const fixture = await createSubmittable({ withDraftVersion: false });
      await expectRefusal(fixture, BizCode.SETTLEMENT_SUBMIT_DRAFT_MISSING);
    });

    it('活动已软删 → ACTIVITY_NOT_FOUND(锁不到行就不往下走)', async () => {
      const fixture = await createSubmittable();
      await prisma.activity.update({
        where: { id: fixture.activityId },
        data: { deletedAt: new Date() },
      });
      await expectRefusal(fixture, BizCode.ACTIVITY_NOT_FOUND);
    });
  });

  // =========================================================================
  // DoD 2 —— EvidenceSeal 复验(只复验,不重新封场)
  // =========================================================================

  describe('DoD 2 —— EvidenceSeal 复验 (§5.10 ③)', () => {
    it('active seal 被标 superseded → EVIDENCE_SEAL_INACTIVE', async () => {
      const fixture = await createSubmittable();
      await prisma.evidenceSeal.update({
        where: { id: fixture.sealId },
        data: { statusCode: 'superseded' },
      });
      await expectRefusal(fixture, BizCode.SETTLEMENT_SUBMIT_EVIDENCE_SEAL_INACTIVE);
    });

    it('又封了一次场(当前 active seal ≠ 草稿引用的那张)→ EVIDENCE_SEAL_STALE', async () => {
      const fixture = await createSubmittable();
      await prisma.evidenceSeal.update({
        where: { id: fixture.sealId },
        data: { statusCode: 'superseded' },
      });
      await prisma.evidenceSeal.create({
        data: {
          activityId: fixture.activityId,
          sealRevision: 2,
          evidenceRevision: 0,
          populationRevision: 0,
          workflowRevision: 0,
          allWindowsClosedAt: new Date('2020-03-01T08:00:00.000Z'),
          openSegmentCount: 0,
          manualReviewPendingCount: 0,
          populationCountDistinct: 2,
          populationCountBySession: {},
          contentHash: 'seal-hash-2',
          statusCode: 'active',
          sealedByUserId: actor.id,
          sealedAt: SEAL_AT,
        },
      });
      await expectRefusal(fixture, BizCode.SETTLEMENT_SUBMIT_EVIDENCE_SEAL_STALE);
    });

    it.each([
      ['evidence', { evidenceRevision: 1, populationRevision: 0 }],
      ['population', { evidenceRevision: 0, populationRevision: 3 }],
    ])('封场后 %s revision 前进 → EVIDENCE_SEAL_STALE', async (_label, state) => {
      const fixture = await createSubmittable();
      await prisma.activityEvidenceState.create({
        data: { activityId: fixture.activityId, ...state },
      });
      await expectRefusal(fixture, BizCode.SETTLEMENT_SUBMIT_EVIDENCE_SEAL_STALE);
    });

    it('封场后 workflow revision 前进(真源是 Activity 行)→ EVIDENCE_SEAL_STALE', async () => {
      const fixture = await createSubmittable();
      await prisma.activity.update({
        where: { id: fixture.activityId },
        data: { workflowRevision: 2 },
      });
      await expectRefusal(fixture, BizCode.SETTLEMENT_SUBMIT_EVIDENCE_SEAL_STALE);
    });

    it('翻面:三个版本全部吻合 → 放行(闸守的是"是否一致"不是"沾边就拒")', async () => {
      const fixture = await createSubmittable();
      const result = await service.submit(submitInput(fixture), actor, auditMeta);
      expect(result.evidenceSealId).toBe(fixture.sealId);
      expect(result.sealRevision).toBe(1);
    });
  });

  // =========================================================================
  // ⭐ DoD 3 —— §5.10 ④ 五条校验
  //
  // 判据绑定的关键在这一段:`PENDING_RESULT` 与 `ITEM_COUNT_MISMATCH` 守的是同一件
  // 事的两侧,夹具被刻意造成**各踩一条**:
  //   - PENDING 的夹具:人口 2 人、缺 1 条结果行、另有 1 条人口外的行 ⇒ **行数=人口数**,
  //     基数式放行,只有包含式能红;
  //   - COUNT 的夹具:人口 1 人、结果行 2 条(1 条人口外)⇒ 每个人口身份都有行,
  //     包含式放行,只有基数式能红。
  // 卸掉任意一条,只有它自己那条用例会红。
  // =========================================================================

  describe('DoD 3 —— §5.10 ④ 五条校验 (⭐ 本刀最高风险项)', () => {
    it('⭐ 人口里有他、结果表里没有他(且行数恰好相等)→ SETTLEMENT_SUBMIT_PENDING_RESULT', async () => {
      const fixture = await createSubmittable({
        populationSize: 2,
        missingResultsFor: 1,
        alienResultRows: 1,
      });
      // 先证明这份夹具**基数是相等的** —— 否则本条会被基数式先抢答,判据就没绑对。
      const [populationCount, resultRowCount] = await Promise.all([
        prisma.activityParticipationIdentity.count({
          where: { activityId: fixture.activityId, populationIncluded: true },
        }),
        prisma.participantSettlementResultRevision.count({
          where: { settlementVersionId: fixture.draftVersionId },
        }),
      ]);
      expect(resultRowCount).toBe(populationCount);

      await expectRefusal(fixture, BizCode.SETTLEMENT_SUBMIT_PENDING_RESULT);
    });

    it('结果行数 ≠ 人口数(且没有人缺席)→ SETTLEMENT_SUBMIT_ITEM_COUNT_MISMATCH', async () => {
      const fixture = await createSubmittable({ populationSize: 1, alienResultRows: 1 });
      // 先证明**没有人缺席** —— 否则包含式会先抢答。
      const missing = await prisma.activityParticipationIdentity.count({
        where: {
          activityId: fixture.activityId,
          populationIncluded: true,
          settlementResultRevisions: { none: { settlementVersionId: fixture.draftVersionId } },
        },
      });
      expect(missing).toBe(0);

      await expectRefusal(fixture, BizCode.SETTLEMENT_SUBMIT_ITEM_COUNT_MISMATCH);
    });

    it('存在未闭合服务段 → SETTLEMENT_SUBMIT_OPEN_SEGMENT', async () => {
      const fixture = await createSubmittable({ withOpenSegment: true });
      await expectRefusal(fixture, BizCode.SETTLEMENT_SUBMIT_OPEN_SEGMENT);
    });

    it('superseded 的开放段不算数(翻面:闸守的是"当前"段)', async () => {
      const fixture = await createSubmittable({ withOpenSegment: true });
      await prisma.participantServiceSegmentRevision.updateMany({
        where: { participationIdentityId: fixture.identityIds[0] },
        data: { statusCode: 'superseded' },
      });
      const result = await service.submit(submitInput(fixture), actor, auditMeta);
      expect(result.replayed).toBe(false);
    });

    it('结果行带 blocker → SETTLEMENT_SUBMIT_MISSING_RULE(第二刀的 blocker 真正挡住提交)', async () => {
      const fixture = await createSubmittable({ withBlocker: true });
      await expectRefusal(fixture, BizCode.SETTLEMENT_SUBMIT_MISSING_RULE);
    });

    it('空 blockers 数组不算 blocker(翻面:闸守的是"有没有",不是"有没有这个字段")', async () => {
      const fixture = await createSubmittable();
      await prisma.participantSettlementResultRevision.updateMany({
        where: { settlementVersionId: fixture.draftVersionId },
        data: { exceptionFlagsJson: { blockers: [] } },
      });
      const result = await service.submit(submitInput(fixture), actor, auditMeta);
      expect(result.replayed).toBe(false);
    });

    it('重复 identity 在 DB 层就不可达 —— 本判据是防御位,red-first 证据在单测层', async () => {
      // 诚实记录:unique (settlementVersionId, participationIdentityId) 让"同一版本
      // 同一 identity 两条行"写不进去 ⇒ e2e 造不出 DUPLICATE_IDENTITY 的红。
      // 判据本身的 red-first 在 settlement-submission-validator.spec.ts。
      const fixture = await createSubmittable({ populationSize: 1 });
      await expect(
        prisma.participantSettlementResultRevision.create({
          data: {
            settlementVersionId: fixture.draftVersionId,
            participationIdentityId: fixture.identityIds[0],
            revision: 1,
            resultCode: 'present',
            recognizedServiceHours: 4,
            recognizedContributionPoints: 1.5,
            calculatedServiceHours: 4,
            calculatedContributionPoints: 1.5,
            statusCode: 'draft',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    // ⭐ 双闸证据:自然形态的未决(人口 2 人、只写 1 条结果行)会**同时**踩两条闸。
    // 本用例只断言"被拒 + 零副作用",不断言具体码 —— 于是卸掉任意**单**一条闸它仍绿,
    // 只有两条**都**卸掉才红。它是矩阵里独立的第三行,不污染前两条的红集。
    it('⭐ 自然未决(少写一条结果行)必被拒 —— 两条闸各自都能拦住', async () => {
      const fixture = await createSubmittable({ populationSize: 2, missingResultsFor: 1 });
      const error = await expectRefusal(fixture, null);
      expect([
        BizCode.SETTLEMENT_SUBMIT_PENDING_RESULT,
        BizCode.SETTLEMENT_SUBMIT_ITEM_COUNT_MISMATCH,
      ]).toContainEqual(error.biz);
    });
  });

  // =========================================================================
  // DoD 4 —— canonical contentHash(e2e 层;纯函数三条判据在单测)
  // =========================================================================

  describe('DoD 4 —— contentHash', () => {
    /** 把 run 复位成 drafting,让同一份草稿可以再提交一次。 */
    async function resetToDrafting(fixture: SubmitFixture): Promise<void> {
      await prisma.attendanceSettlementRun.update({
        where: { id: fixture.runId },
        data: { statusCode: 'drafting' },
      });
    }

    it('同一份草稿两次提交 ⇒ 同一个 contentHash(可复现)', async () => {
      const fixture = await createSubmittable();
      const first = await service.submit(submitInput(fixture), actor, auditMeta);
      await resetToDrafting(fixture);
      const second = await service.submit(
        submitInput(fixture, { operationKey: `op2-${fixture.activityId}` }),
        actor,
        auditMeta,
      );
      expect(second.settlementVersionId).not.toBe(first.settlementVersionId);
      expect(second.contentHash).toBe(first.contentHash);
    });

    it('改一条结果行的认定值 ⇒ contentHash 变', async () => {
      const fixture = await createSubmittable();
      const first = await service.submit(submitInput(fixture), actor, auditMeta);
      await resetToDrafting(fixture);
      await prisma.participantSettlementResultRevision.updateMany({
        where: {
          settlementVersionId: fixture.draftVersionId,
          participationIdentityId: fixture.identityIds[0],
        },
        // 认定 ≠ 计算 ⇒ §3.20 的 CHECK 要求 adjustmentReason 必填。
        data: { recognizedServiceHours: 3, adjustmentReason: '负责人调整' },
      });
      const second = await service.submit(
        submitInput(fixture, { operationKey: `op2-${fixture.activityId}` }),
        actor,
        auditMeta,
      );
      expect(second.contentHash).not.toBe(first.contentHash);
    });

    it('提交版本的 contentHash 与草稿版本的 contentHash 是两回事(覆盖面不同)', async () => {
      const fixture = await createSubmittable();
      const result = await service.submit(submitInput(fixture), actor, auditMeta);
      const draft = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: fixture.draftVersionId },
        select: { contentHash: true },
      });
      expect(result.contentHash).not.toBe(draft.contentHash);
      expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // =========================================================================
  // DoD 5 —— 幂等(operationKey + requestHash)
  // =========================================================================

  describe('DoD 5 —— 幂等 (§5.10 ⑥)', () => {
    it('同 key 同 payload 重放 ⇒ 返回同一个 version,不产生第二条', async () => {
      const fixture = await createSubmittable();
      const first = await service.submit(submitInput(fixture), actor, auditMeta);
      const replay = await service.submit(submitInput(fixture), actor, auditMeta);

      expect(replay.settlementVersionId).toBe(first.settlementVersionId);
      expect(replay.settlementVersion).toBe(first.settlementVersion);
      expect(replay.contentHash).toBe(first.contentHash);
      expect(replay.replayed).toBe(true);
      expect(first.replayed).toBe(false);

      await expect(
        prisma.attendanceSettlementVersion.count({
          where: { settlementRunId: fixture.runId, statusCode: 'submitted' },
        }),
      ).resolves.toBe(1);
      // 结果行也不许被复制第二遍。
      await expect(
        prisma.participantSettlementResultRevision.count({
          where: { settlementVersionId: first.settlementVersionId },
        }),
      ).resolves.toBe(fixture.identityIds.length);
    });

    it('同 key **不同** payload ⇒ SETTLEMENT_SUBMIT_OPERATION_KEY_CONFLICT', async () => {
      const fixture = await createSubmittable();
      await service.submit(submitInput(fixture), actor, auditMeta);
      await prisma.attendanceSettlementRun.update({
        where: { id: fixture.runId },
        data: { statusCode: 'drafting' },
      });

      const error = await service
        .submit(submitInput(fixture, { requestHash: 'payload-hash-DIFFERENT' }), actor, auditMeta)
        .then(
          () => null,
          (thrown: unknown) => thrown,
        );
      expect(error).toBeInstanceOf(BizException);
      expect((error as BizException).biz).toBe(BizCode.SETTLEMENT_SUBMIT_OPERATION_KEY_CONFLICT);
      await expect(
        prisma.attendanceSettlementVersion.count({
          where: { settlementRunId: fixture.runId, statusCode: 'submitted' },
        }),
      ).resolves.toBe(1);
    });

    it('同 key 用在**另一条 run** 上 ⇒ 同样拒(防重键不按 run 收窄)', async () => {
      const a = await createSubmittable();
      const b = await createSubmittable();
      await service.submit({ ...submitInput(a), operationKey: 'shared-op-key' }, actor, auditMeta);

      const error = await service
        .submit({ ...submitInput(b), operationKey: 'shared-op-key' }, actor, auditMeta)
        .then(
          () => null,
          (thrown: unknown) => thrown,
        );
      expect(error).toBeInstanceOf(BizException);
      expect((error as BizException).biz).toBe(BizCode.SETTLEMENT_SUBMIT_OPERATION_KEY_CONFLICT);
    });

    it('翻面:不同 key ⇒ 正常开新版本', async () => {
      const fixture = await createSubmittable();
      const first = await service.submit(submitInput(fixture), actor, auditMeta);
      await prisma.attendanceSettlementRun.update({
        where: { id: fixture.runId },
        data: { statusCode: 'drafting' },
      });
      const second = await service.submit(
        submitInput(fixture, { operationKey: `op2-${fixture.activityId}` }),
        actor,
        auditMeta,
      );
      expect(second.settlementVersionId).not.toBe(first.settlementVersionId);
      expect(second.settlementVersion).toBe(first.settlementVersion + 1);
      expect(second.replayed).toBe(false);
    });
  });

  // =========================================================================
  // DoD 6 —— 规模:批量写不得与人数相关
  // =========================================================================

  describe('DoD 6 —— 规模 (>8191 行)', () => {
    it(`${SCALE_ROW_COUNT} 条结果行的提交成功(手写逐行 VALUES 会在此确定性失败)`, async () => {
      const fixture = await createSubmittable({ populationSize: SCALE_ROW_COUNT });
      const result = await service.submit(submitInput(fixture), actor, auditMeta);

      expect(result.resultRowCount).toBe(SCALE_ROW_COUNT);
      await expect(
        prisma.participantSettlementResultRevision.count({
          where: { settlementVersionId: result.settlementVersionId },
        }),
      ).resolves.toBe(SCALE_ROW_COUNT);
      // 快照是**另一批行**:与草稿行 id 无交集,且每条都指回自己的草稿来源。
      await expect(
        prisma.participantSettlementResultRevision.count({
          where: { settlementVersionId: result.settlementVersionId, baseResultRevisionId: null },
        }),
      ).resolves.toBe(0);
    }, 180_000);
  });

  // =========================================================================
  // DoD 7 —— 不可变:提交是另开一版,草稿路径够不到它
  // =========================================================================

  describe('DoD 7 —— 不可变版本', () => {
    it('提交后:草稿版本仍在且仍是 draft,提交版本是另一行', async () => {
      const fixture = await createSubmittable();
      const result = await service.submit(submitInput(fixture), actor, auditMeta);

      expect(result.settlementVersionId).not.toBe(fixture.draftVersionId);
      const draft = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: fixture.draftVersionId },
        select: { statusCode: true },
      });
      expect(draft.statusCode).toBe('draft');

      const submitted = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: result.settlementVersionId },
        select: { statusCode: true, submittedAt: true, operationKey: true, requestHash: true },
      });
      expect(submitted.statusCode).toBe('submitted');
      expect(submitted.submittedAt).not.toBeNull();
      expect(submitted.operationKey).toBe(submitInput(fixture).operationKey);
      expect(submitted.requestHash).toBe('payload-hash-1');
    });

    it('提交版本的结果行是**另一批物理行**,并指回草稿来源', async () => {
      const fixture = await createSubmittable({ populationSize: 2 });
      const result = await service.submit(submitInput(fixture), actor, auditMeta);

      const draftRows = await prisma.participantSettlementResultRevision.findMany({
        where: { settlementVersionId: fixture.draftVersionId },
        select: { id: true, revision: true },
      });
      const submittedRows = await prisma.participantSettlementResultRevision.findMany({
        where: { settlementVersionId: result.settlementVersionId },
        select: { id: true, revision: true, baseResultRevisionId: true },
      });

      expect(submittedRows).toHaveLength(2);
      const draftIds = new Set(draftRows.map((row) => row.id));
      for (const row of submittedRows) {
        expect(draftIds.has(row.id)).toBe(false);
        expect(draftIds.has(row.baseResultRevisionId ?? '')).toBe(true);
        expect(row.revision).toBe(1);
      }
      // 草稿那两行一个字都没被动过。
      expect(draftRows.every((row) => row.revision === 0)).toBe(true);
    });

    it('run 指针指向提交版本,状态推进到 pending_first_review(= Review 待办)', async () => {
      const fixture = await createSubmittable();
      const result = await service.submit(submitInput(fixture), actor, auditMeta);
      const run = await prisma.attendanceSettlementRun.findUniqueOrThrow({
        where: { id: fixture.runId },
        select: { statusCode: true, currentSubmittedVersion: true, currentDraftVersion: true },
      });
      expect(run.statusCode).toBe('pending_first_review');
      expect(run.currentSubmittedVersion).toBe(result.settlementVersion);
      // 草稿指针没被抹掉 —— 草稿仍是那个可编辑的工作区。
      expect(run.currentDraftVersion).toBe(1);
    });

    it('提交后草稿路径够不到:再跑一次草稿生成被拒', async () => {
      const fixture = await createSubmittable();
      await service.submit(submitInput(fixture), actor, auditMeta);
      const error = await draftService.generate(fixture.activityId, actor, auditMeta).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(BizException);
      expect((error as BizException).biz).toBe(BizCode.SETTLEMENT_DRAFT_RUN_STATUS_INVALID);
    });

    it('重提:从 returned 回到 drafting 再提交 ⇒ priorVersionId 串起提交链', async () => {
      const fixture = await createSubmittable();
      const first = await service.submit(submitInput(fixture), actor, auditMeta);
      expect(first.priorVersionId).toBeNull();

      // §4.7:pending_first_review → returned → drafting。
      await prisma.attendanceSettlementVersion.update({
        where: { id: first.settlementVersionId },
        data: { statusCode: 'returned', returnFromStage: 'first', returnReason: '需要补认定' },
      });
      await prisma.attendanceSettlementRun.update({
        where: { id: fixture.runId },
        data: { statusCode: 'drafting' },
      });

      const second = await service.submit(
        submitInput(fixture, { operationKey: `op2-${fixture.activityId}` }),
        actor,
        auditMeta,
      );
      expect(second.priorVersionId).toBe(first.settlementVersionId);
      expect(second.settlementVersion).toBe(first.settlementVersion + 1);
    });
  });

  // =========================================================================
  // DoD 8 —— Review 待办 / Audit / 通知 intent(全部在同一事务内)
  // =========================================================================

  describe('DoD 8 —— 同事务副作用', () => {
    it('提交成功 ⇒ 通知 intent 与 audit 都落下', async () => {
      const fixture = await createSubmittable();
      const result = await service.submit(submitInput(fixture), actor, auditMeta);

      const intents = await prisma.notificationOutboxIntent.findMany({
        where: { aggregateId: fixture.activityId },
        select: { eventKey: true, destinationType: true, destinationRef: true },
      });
      expect(intents).toHaveLength(1);
      expect(intents[0].eventKey).toBe(`settlement-submit:${result.settlementVersionId}`);
      expect(intents[0].destinationType).toBe('member');
      expect(intents[0].destinationRef).toBe(fixture.ownerMemberId);

      // audit 的 extra 落在 `context.extra` 下(AuditLogsService 的既有形状)。
      const audits = await prisma.auditLog.findMany({
        where: { resourceId: fixture.activityId, event: 'activity.publish' },
        select: { context: true },
      });
      const submitAudit = audits
        .map((row) => (row.context as { extra?: { operation?: string } } | null)?.extra)
        .find((extra) => extra?.operation === 'settlement-submit');
      expect(submitAudit).toBeDefined();
      expect(submitAudit).toMatchObject({
        settlementVersionId: result.settlementVersionId,
        contentHash: result.contentHash,
        replayed: false,
      });
    });

    // 🔴 intent 在事务内的**执行位**:让提交在 enqueue **之后**炸掉。
    //    若 intent 是 commit 后直调 / 独立事务,它会活下来;在同一事务里,它必须一起回滚。
    it('enqueue 之后的步骤失败 ⇒ intent 与版本一起回滚(证明 intent 在事务内)', async () => {
      const fixture = await createSubmittable();
      jest.spyOn(auditRecorder, 'log').mockRejectedValueOnce(new Error('boom-after-enqueue'));

      await expect(service.submit(submitInput(fixture), actor, auditMeta)).rejects.toThrow(
        'boom-after-enqueue',
      );

      await expect(
        prisma.notificationOutboxIntent.count({ where: { aggregateId: fixture.activityId } }),
      ).resolves.toBe(0);
      await expect(
        prisma.attendanceSettlementVersion.count({
          where: { settlementRunId: fixture.runId, statusCode: 'submitted' },
        }),
      ).resolves.toBe(0);
      const run = await prisma.attendanceSettlementRun.findUniqueOrThrow({
        where: { id: fixture.runId },
        select: { statusCode: true },
      });
      expect(run.statusCode).toBe('drafting');
    });

    it('没有 active owner 时跳过通知,但**不拒绝提交**(有意的降级)', async () => {
      const fixture = await createSubmittable();
      await prisma.activityResponsibilityAssignment.updateMany({
        where: { activityId: fixture.activityId },
        data: { status: 'ended', endedAt: new Date() },
      });
      const result = await service.submit(submitInput(fixture), actor, auditMeta);
      expect(result.replayed).toBe(false);
      await expect(
        prisma.notificationOutboxIntent.count({ where: { aggregateId: fixture.activityId } }),
      ).resolves.toBe(0);
    });
  });

  // =========================================================================
  // 并发 —— run 行锁把同一条 run 上的并发提交串行化
  // =========================================================================

  describe('并发 —— 只可能有一个提交版本', () => {
    it('两个不同 operationKey 的并发提交 ⇒ 恰好一个成功', async () => {
      const fixture = await createSubmittable();
      const results = await Promise.allSettled([
        service.submit(
          submitInput(fixture, { operationKey: `race-a-${fixture.activityId}` }),
          actor,
          auditMeta,
        ),
        service.submit(
          submitInput(fixture, { operationKey: `race-b-${fixture.activityId}` }),
          actor,
          auditMeta,
        ),
      ]);

      const fulfilled = results.filter((row) => row.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);
      // 败者拿到的是具名业务码(run 已不在 drafting),不是裸 Prisma 异常。
      const rejected = results.find((row) => row.status === 'rejected');
      expect(rejected).toBeDefined();
      const reason: unknown = (rejected as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(BizException);
      expect((reason as BizException).biz).toBe(BizCode.SETTLEMENT_SUBMIT_RUN_STATUS_INVALID);

      await expect(
        prisma.attendanceSettlementVersion.count({
          where: { settlementRunId: fixture.runId, statusCode: 'submitted' },
        }),
      ).resolves.toBe(1);
    });
  });

  // =========================================================================
  // 与第二刀端到端 —— 真实生成器产出的草稿能被提交
  // =========================================================================

  describe('与第二刀端到端', () => {
    /** 一条完整的签到→签退链 ⇒ 生成器判 present(不是待定)。 */
    async function createFullPunchChain(fixture: SubmitFixture): Promise<void> {
      const memberId = (
        await prisma.activityParticipationIdentity.findUniqueOrThrow({
          where: { id: fixture.identityIds[0] },
          select: { memberId: true },
        })
      ).memberId;
      for (const [index, eventTypeCode] of ['check_in', 'check_out'].entries()) {
        await prisma.attendancePunchEvent.create({
          data: {
            activityId: fixture.activityId,
            sessionId: fixture.sessionId,
            participationIdentityId: fixture.identityIds[0],
            memberId,
            eventTypeCode,
            sourceCode: 'staff_scan',
            occurredAt: new Date(SESSION_START.getTime() + index * 4 * 3600_000),
            receivedAt: new Date(SESSION_START.getTime() + index * 4 * 3600_000),
            operatorUserId: actor.id,
            eventKey: `e2e-chain-${fixture.activityId}-${eventTypeCode}`,
            requestHash: `e2e-chain-hash-${fixture.activityId}-${eventTypeCode}`,
            evidenceRevision: 0,
          },
        });
      }
    }

    async function createRuleFor(fixture: SubmitFixture): Promise<void> {
      const activity = await prisma.activity.findUniqueOrThrow({
        where: { id: fixture.activityId },
        select: { activityTypeCode: true },
      });
      await prisma.contributionRule.create({
        data: {
          activityTypeCode: activity.activityTypeCode,
          attendanceRoleCode: 'member',
          pointsBelow: 1.5,
          status: 'ACTIVE',
        },
      });
    }

    it('生成器产出的草稿(全部已认定)可以直接提交', async () => {
      const fixture = await createSubmittable({ populationSize: 1, withDraftVersion: false });
      await createRuleFor(fixture);
      await createFullPunchChain(fixture);

      const draft = await draftService.generate(fixture.activityId, actor, auditMeta);
      expect(draft.pendingItemCount).toBe(0);
      expect(draft.blockedItemCount).toBe(0);

      const submitted = await service.submit(submitInput(fixture), actor, auditMeta);
      expect(submitted.draftVersionId).toBe(draft.settlementVersionId);
      expect(submitted.resultRowCount).toBe(1);
      expect(submitted.personCount).toBe(1);
    });

    // 🔴 这一条把本刀读 blocker 的那段 SQL **钉在第二刀真实写下的 JSON 形状上**。
    //
    //    `readSubmissionFacts` 判 blocker 用的是 `exceptionFlagsJson -> 'blockers'` 是不是
    //    非空数组 —— 这是对第二刀 `{ blockers: [...] }` 那个形状的**硬耦合**。
    //    上面那条 `结果行带 blocker → MISSING_RULE` 的用例是自己手写 JSON 的,
    //    第二刀哪天把键名改成别的,它照样绿,而生产上这道闸会**静默失效**。
    //    本条走真实生成器产出 blocker,是这个耦合唯一的执行位。
    it('生成器标出 blocker 时提交被拒 —— 把 blocker 的 JSON 形状钉在两刀之间', async () => {
      const fixture = await createSubmittable({ populationSize: 1, withDraftVersion: false });
      // 刻意**不建**贡献规则 ⇒ 应计分却算出 0 分 ⇒ 第二刀标 blocker。
      await createFullPunchChain(fixture);

      const draft = await draftService.generate(fixture.activityId, actor, auditMeta);
      expect(draft.pendingItemCount).toBe(0);
      expect(draft.blockedItemCount).toBe(1);
      // 先证明第二刀确实把 blocker 写进了那个键 —— 否则本条是空绿。
      const row = await prisma.participantSettlementResultRevision.findFirstOrThrow({
        where: { settlementVersionId: draft.settlementVersionId },
        select: { exceptionFlagsJson: true },
      });
      expect(row.exceptionFlagsJson).toMatchObject({ blockers: expect.any(Array) as unknown });

      const error = await service.submit(submitInput(fixture), actor, auditMeta).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(BizException);
      expect((error as BizException).biz).toBe(BizCode.SETTLEMENT_SUBMIT_MISSING_RULE);
    });

    it('生成器留下待定项时,提交被拒(第二刀"不写行表达未决"的闭环)', async () => {
      const fixture = await createSubmittable({ populationSize: 1, withDraftVersion: false });
      // 一个打卡事件都没有 ⇒ 生成器判待定 ⇒ 不写结果行。
      const draft = await draftService.generate(fixture.activityId, actor, auditMeta);
      expect(draft.pendingItemCount).toBe(1);
      await expect(
        prisma.participantSettlementResultRevision.count({
          where: { settlementVersionId: draft.settlementVersionId },
        }),
      ).resolves.toBe(0);

      const error = await service.submit(submitInput(fixture), actor, auditMeta).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(BizException);
      expect((error as BizException).biz).toBe(BizCode.SETTLEMENT_SUBMIT_PENDING_RESULT);
    });
  });
});
