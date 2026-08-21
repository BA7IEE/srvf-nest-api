import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { SettlementDraftService } from '../../src/modules/activities/settlement-draft.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// ===== 活动改造 v1.1 第 2 批第二刀:结算草稿生成(合同 §5.9)=====
//
// 🔴 这一刀的错**不会报错** —— 段算多算少、把待定当缺勤、无规则填 0,每一种都会安静地
//    产出一个"看起来正常"的结果然后进账本。所以本 spec 的每条硬判据都写成
//    「**只由它对应的那一处实现触发**」:卸掉哪一处,就只有那一段红(红集不重叠)。
//
// 时间口径:全部用 2020 年的固定过去时刻。签退窗口必须已过才可能有 active seal,
// 而 2020 永远在过去 ⇒ 不存在墙钟耦合的定时炸弹(沿仓内 e2e-activity-fixture-time-bomb 教训)。

const SESSION_START = new Date('2020-03-01T00:00:00.000Z');
const SESSION_END = new Date('2020-03-01T04:00:00.000Z');

interface DraftFixture {
  activityId: string;
  activityTypeCode: string;
  sessionId: string;
  memberId: string;
  identityId: string;
}

describe('settlement draft generation (合同 §5.9)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: SettlementDraftService;
  let actor: CurrentUserPayload;
  let organizationId: string;
  let sequence = 0;

  const auditMeta = { requestId: 'settlement-draft-e2e', ip: null, ua: null };

  beforeAll(async () => {
    // 第 7 批第 ③ 刀 —— 活动 v1.1 单一 cutover gate(合同 §16.2)。本 spec 驱动的是
    // **结算真相链**(打卡 / 封场 / 结算 / 账本 / 关账 / 更正),那条链按定义只在闸开时存在;
    // 闸关(默认 = 今天的行为)时这些写入口一律回 20153。故此处显式置真,
    // **断言一字未改** —— 改的只是这个 spec 声明自己跑在哪一侧闸。
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    service = app.get(SettlementDraftService);

    const user = await createTestUser(app, {
      username: 'settlement-draft-actor',
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
      data: { name: '结算草稿测试组织', nodeTypeCode: 'settlement-draft-team' },
      select: { id: true },
    });
    organizationId = organization.id;
  });

  afterAll(async () => {
    delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    await app.close();
  });

  // 基线夹具:一个**已封场**、人口恰好一人一场次的活动。
  // 每条用例只在这份基线上动一处。
  async function createSealedActivity(
    options: {
      withSeal?: boolean;
      lateGraceMinutes?: number;
      earlyLeaveThresholdMinutes?: number;
    } = {},
  ): Promise<DraftFixture> {
    sequence += 1;
    const tag = `draft-${sequence}`;
    const activityTypeCode = `settlement-draft-type-${sequence}`;

    const activity = await prisma.activity.create({
      data: {
        title: `结算草稿活动 ${sequence}`,
        activityTypeCode,
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
        lateGraceMinutes: options.lateGraceMinutes ?? 15,
        earlyLeaveThresholdMinutes: options.earlyLeaveThresholdMinutes ?? 15,
      },
      select: { id: true },
    });

    const member = await prisma.member.create({
      data: {
        memberNo: `${tag}-m1`,
        ...memberIdentityData(`草稿队员 ${sequence}`),
        gradeCode: 'level-2',
      },
      select: { id: true },
    });
    const registration = await prisma.activityRegistration.create({
      data: { activityId: activity.id, memberId: member.id, statusCode: 'approved' },
      select: { id: true },
    });
    const identity = await prisma.activityParticipationIdentity.create({
      data: {
        activityId: activity.id,
        sessionId: session.id,
        registrationId: registration.id,
        memberId: member.id,
        currentStatusCode: 'pass',
        populationIncluded: true,
      },
      select: { id: true },
    });

    if (options.withSeal !== false) {
      await createSeal(activity.id);
    }

    return {
      activityId: activity.id,
      activityTypeCode,
      sessionId: session.id,
      memberId: member.id,
      identityId: identity.id,
    };
  }

  // 直接写 EvidenceSeal 行,不走 EvidenceSealService。
  // 理由:封场闸要求「零未投影事件」,而本刀的用例恰恰需要"有打卡事件、还没有段"的
  // 起始状态;而且 DoD 1 的三种拒绝形态(无章 / 只有失效章 / 章与版本不符)
  // 本来就只能靠直接构造 seal 行来造。
  async function createSeal(
    activityId: string,
    overrides: {
      statusCode?: string;
      evidenceRevision?: number;
      populationRevision?: number;
      workflowRevision?: number;
      sealRevision?: number;
    } = {},
  ): Promise<string> {
    const seal = await prisma.evidenceSeal.create({
      data: {
        activityId,
        sealRevision: overrides.sealRevision ?? 1,
        evidenceRevision: overrides.evidenceRevision ?? 0,
        populationRevision: overrides.populationRevision ?? 0,
        workflowRevision: overrides.workflowRevision ?? 0,
        allWindowsClosedAt: new Date('2020-03-01T08:00:00.000Z'),
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: 1,
        populationCountBySession: {},
        contentHash: `hash-${activityId}-${overrides.sealRevision ?? 1}`,
        statusCode: overrides.statusCode ?? 'active',
        sealedByUserId: actor.id,
        sealedAt: new Date('2020-03-01T09:00:00.000Z'),
      },
      select: { id: true },
    });
    return seal.id;
  }

  async function createPunchEvent(
    fixture: Pick<DraftFixture, 'activityId' | 'sessionId' | 'memberId'>,
    identityId: string,
    eventTypeCode: string,
    occurredAt: string,
    supersedesEventId: string | null = null,
  ): Promise<string> {
    sequence += 1;
    const event = await prisma.attendancePunchEvent.create({
      data: {
        activityId: fixture.activityId,
        sessionId: fixture.sessionId,
        participationIdentityId: identityId,
        memberId: fixture.memberId,
        eventTypeCode,
        sourceCode: 'staff_scan',
        occurredAt: new Date(occurredAt),
        receivedAt: new Date(occurredAt),
        operatorUserId: actor.id,
        eventKey: `draft-event-${sequence}`,
        requestHash: `hash-${sequence}`,
        evidenceRevision: 0,
        supersedesEventId,
        // §3.16:特殊闭合 / 作废 / 替代三类 reason 必填(DB 有 CHECK 兜底)。
        reason: ['early_departure_close', 'void', 'replace'].includes(eventTypeCode)
          ? '取证纠错'
          : null,
      },
      select: { id: true },
    });
    return event.id;
  }

  async function createContributionRule(
    activityTypeCode: string,
    attendanceRoleCode: string,
    pointsBelow: number,
  ): Promise<void> {
    await prisma.contributionRule.create({
      data: { activityTypeCode, attendanceRoleCode, pointsBelow, status: 'ACTIVE' },
    });
  }

  async function expectRefusal(
    activityId: string,
    expected: (typeof BizCode)[keyof typeof BizCode],
  ): Promise<void> {
    const error = await service.generate(activityId, actor, auditMeta).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(BizException);
    expect((error as BizException).biz).toBe(expected);
    // 拒绝必须是**干净拒绝**:一行草稿、一个段都不许落。
    await expect(
      prisma.attendanceSettlementVersion.count({
        where: { settlementRun: { activityId } },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.participantServiceSegmentRevision.count({
        where: { identity: { activityId } },
      }),
    ).resolves.toBe(0);
  }

  // =========================================================================
  // DoD 1:输入必须是 active EvidenceSeal —— 三种不满足,三个具名码
  // =========================================================================

  describe('DoD 1 —— 输入必须是 active EvidenceSeal', () => {
    it('从未封场 → SETTLEMENT_DRAFT_EVIDENCE_SEAL_MISSING', async () => {
      const fixture = await createSealedActivity({ withSeal: false });
      await expectRefusal(fixture.activityId, BizCode.SETTLEMENT_DRAFT_EVIDENCE_SEAL_MISSING);
    });

    it('封过但当前无 active(已 superseded)→ SETTLEMENT_DRAFT_EVIDENCE_SEAL_SUPERSEDED', async () => {
      const fixture = await createSealedActivity({ withSeal: false });
      await createSeal(fixture.activityId, { statusCode: 'superseded' });
      await expectRefusal(fixture.activityId, BizCode.SETTLEMENT_DRAFT_EVIDENCE_SEAL_SUPERSEDED);
    });

    it('active seal 与当前 evidence revision 不一致 → SETTLEMENT_DRAFT_EVIDENCE_SEAL_STALE', async () => {
      const fixture = await createSealedActivity();
      // 封场之后又来了新证据 ⇒ state 版本前进,旧章失配(§3.17)。
      await prisma.activityEvidenceState.create({
        data: { activityId: fixture.activityId, evidenceRevision: 1, populationRevision: 0 },
      });
      await expectRefusal(fixture.activityId, BizCode.SETTLEMENT_DRAFT_EVIDENCE_SEAL_STALE);
    });

    it('active seal 与当前 population revision 不一致 → 同样 STALE', async () => {
      const fixture = await createSealedActivity();
      await prisma.activityEvidenceState.create({
        data: { activityId: fixture.activityId, evidenceRevision: 0, populationRevision: 3 },
      });
      await expectRefusal(fixture.activityId, BizCode.SETTLEMENT_DRAFT_EVIDENCE_SEAL_STALE);
    });

    it('active seal 与当前 workflow revision 不一致 → 同样 STALE(真源是 Activity 行)', async () => {
      const fixture = await createSealedActivity();
      await prisma.activity.update({
        where: { id: fixture.activityId },
        data: { workflowRevision: 2 },
      });
      await expectRefusal(fixture.activityId, BizCode.SETTLEMENT_DRAFT_EVIDENCE_SEAL_STALE);
    });

    it('翻面:三个版本全部吻合 → 放行(证明闸守的是"是否一致"不是"沾边就拒")', async () => {
      const fixture = await createSealedActivity({ withSeal: false });
      await prisma.activity.update({
        where: { id: fixture.activityId },
        data: { workflowRevision: 2 },
      });
      await prisma.activityEvidenceState.create({
        data: { activityId: fixture.activityId, evidenceRevision: 5, populationRevision: 7 },
      });
      await createSeal(fixture.activityId, {
        evidenceRevision: 5,
        populationRevision: 7,
        workflowRevision: 2,
      });

      const result = await service.generate(fixture.activityId, actor, auditMeta);
      expect(result.sealRevision).toBe(1);
      expect(result.sessionParticipationCount).toBe(1);
    });

    it('活动不存在 / 已软删 → ACTIVITY_NOT_FOUND(锁不到行就不往下走)', async () => {
      const fixture = await createSealedActivity();
      await prisma.activity.update({
        where: { id: fixture.activityId },
        data: { deletedAt: new Date() },
      });
      await expectRefusal(fixture.activityId, BizCode.ACTIVITY_NOT_FOUND);
    });
  });

  // =========================================================================
  // DoD 2:人口来源 = current revision + populationIncluded
  // =========================================================================

  describe('DoD 2 —— 人口来源', () => {
    it('同一队员报了两个场次 → 两项(每队员 × 每场次一项)', async () => {
      const fixture = await createSealedActivity({ withSeal: false });
      sequence += 1;
      const session2 = await prisma.activitySession.create({
        data: {
          activityId: fixture.activityId,
          code: `draft-${sequence}-s2`,
          name: `draft-${sequence} 场次二`,
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
      const registration = await prisma.activityRegistration.findFirstOrThrow({
        where: { activityId: fixture.activityId },
        select: { id: true },
      });
      const identity2 = await prisma.activityParticipationIdentity.create({
        data: {
          activityId: fixture.activityId,
          sessionId: session2.id,
          registrationId: registration.id,
          memberId: fixture.memberId,
          currentStatusCode: 'pass',
          populationIncluded: true,
        },
        select: { id: true },
      });
      await createSeal(fixture.activityId);

      const result = await service.generate(fixture.activityId, actor, auditMeta);
      expect(result.items).toHaveLength(2);
      expect(result.sessionParticipationCount).toBe(2);
      // 人数按 memberId 去重 —— 一个人报两场仍是一个人。
      expect(result.personCount).toBe(1);
      expect(result.items.map((item) => item.participationIdentityId).sort()).toStrictEqual(
        [fixture.identityId, identity2.id].sort(),
      );
    });

    it('populationIncluded=false 的身份不进草稿', async () => {
      const fixture = await createSealedActivity({ withSeal: false });
      sequence += 1;
      const excludedMember = await prisma.member.create({
        data: {
          memberNo: `draft-${sequence}-excluded`,
          ...memberIdentityData('未入人口'),
          gradeCode: 'level-2',
        },
        select: { id: true },
      });
      const excludedRegistration = await prisma.activityRegistration.create({
        data: {
          activityId: fixture.activityId,
          memberId: excludedMember.id,
          statusCode: 'pending',
        },
        select: { id: true },
      });
      const excludedIdentity = await prisma.activityParticipationIdentity.create({
        data: {
          activityId: fixture.activityId,
          sessionId: fixture.sessionId,
          registrationId: excludedRegistration.id,
          memberId: excludedMember.id,
          currentStatusCode: 'waitlisted',
          populationIncluded: false,
        },
        select: { id: true },
      });
      await createSeal(fixture.activityId);

      const result = await service.generate(fixture.activityId, actor, auditMeta);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].participationIdentityId).toBe(fixture.identityId);
      expect(
        result.items.some((item) => item.participationIdentityId === excludedIdentity.id),
      ).toBe(false);
    });

    it('草稿项带 current revision 快照(读的是指针,不扫历史 revision 行)', async () => {
      const fixture = await createSealedActivity();
      await prisma.activityParticipationIdentity.update({
        where: { id: fixture.identityId },
        data: { currentRevision: 4 },
      });
      const result = await service.generate(fixture.activityId, actor, auditMeta);
      expect(result.items[0].participationRevision).toBe(4);
    });
  });

  // =========================================================================
  // ⭐ DoD 3:服务段从 PunchEvent 链重建 —— 三条硬判据
  // =========================================================================

  describe('DoD 3 ①⭐ 绝不用计划 endAt 补签退', () => {
    it('只有签到、签退窗口已过 → 段保持开放,且**没有任何**段的 checkOutAt 等于 session.endAt', async () => {
      const fixture = await createSealedActivity();
      await createPunchEvent(fixture, fixture.identityId, 'check_in', '2020-03-01T00:05:00.000Z');

      const result = await service.generate(fixture.activityId, actor, auditMeta);

      const segments = await prisma.participantServiceSegmentRevision.findMany({
        where: { participationIdentityId: fixture.identityId, statusCode: { not: 'superseded' } },
        select: {
          checkOutAt: true,
          serviceHours: true,
          sourceCloseEventId: true,
          resultCode: true,
        },
      });
      expect(segments).toHaveLength(1);
      // 🔴 原始断言:开放段的三列必须同时为 null。
      expect(segments[0].checkOutAt).toBeNull();
      expect(segments[0].serviceHours).toBeNull();
      expect(segments[0].sourceCloseEventId).toBeNull();
      expect(segments[0].resultCode).toBe('valid');

      // 🔴 全库巡检式的翻面断言:整张表里不许出现一个"签退时刻 = 计划结束时刻"的段。
      const fabricated = await prisma.participantServiceSegmentRevision.count({
        where: { identity: { activityId: fixture.activityId }, checkOutAt: SESSION_END },
      });
      expect(fabricated).toBe(0);

      // 该人因此**待定**,不是判 present 也不是判 absent。
      expect(result.items[0].decision).toBe('pending');
      expect(result.items[0].pendingReasons).toStrictEqual(['open_segment']);
      expect(result.items[0].resultCode).toBeNull();
      expect(result.items[0].calculatedServiceHours).toBe(0);
    });

    it('翻面:真有签退事件时才有时长(证明闸守的是"有没有闭合事实")', async () => {
      const fixture = await createSealedActivity();
      await createPunchEvent(fixture, fixture.identityId, 'check_in', '2020-03-01T00:05:00.000Z');
      await createPunchEvent(fixture, fixture.identityId, 'check_out', '2020-03-01T03:35:00.000Z');

      const result = await service.generate(fixture.activityId, actor, auditMeta);
      const segment = await prisma.participantServiceSegmentRevision.findFirstOrThrow({
        where: { participationIdentityId: fixture.identityId, statusCode: { not: 'superseded' } },
        select: { checkOutAt: true, serviceHours: true },
      });
      expect(segment.checkOutAt?.toISOString()).toBe('2020-03-01T03:35:00.000Z');
      expect(Number(segment.serviceHours)).toBe(3.5);
      expect(result.items[0].decision).toBe('machine_determined');
      expect(result.items[0].resultCode).toBe('present');
      expect(result.items[0].calculatedServiceHours).toBe(3.5);
    });
  });

  describe('DoD 3 ②⭐ void / replace 链必须解析', () => {
    it('同一组事件在有/无 void 时产出不同段(签退被作废 ⇒ 段回到开放态,新 revision,旧的 superseded)', async () => {
      const fixture = await createSealedActivity();
      await createPunchEvent(fixture, fixture.identityId, 'check_in', '2020-03-01T00:00:00.000Z');
      const checkOutId = await createPunchEvent(
        fixture,
        fixture.identityId,
        'check_out',
        '2020-03-01T03:00:00.000Z',
      );

      const before = await service.generate(fixture.activityId, actor, auditMeta);
      expect(before.items[0].calculatedServiceHours).toBe(3);
      expect(before.segmentsCreated).toBe(1);

      await createPunchEvent(
        fixture,
        fixture.identityId,
        'void',
        '2020-03-01T05:00:00.000Z',
        checkOutId,
      );
      const after = await service.generate(fixture.activityId, actor, auditMeta);

      expect(after.items[0].decision).toBe('pending');
      expect(after.items[0].calculatedServiceHours).toBe(0);
      expect(after.segmentsSuperseded).toBe(1);
      expect(after.segmentsCreated).toBe(1);

      const rows = await prisma.participantServiceSegmentRevision.findMany({
        where: { participationIdentityId: fixture.identityId },
        orderBy: { revision: 'asc' },
        select: { revision: true, statusCode: true, segmentKey: true, checkOutAt: true },
      });
      // §4.5「生成新的 segment revision,**不覆盖**旧 revision」。
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ revision: 0, statusCode: 'superseded', segmentKey: '0001' });
      expect(rows[1]).toMatchObject({ revision: 1, statusCode: 'draft', segmentKey: '0001' });
      expect(rows[0].checkOutAt?.toISOString()).toBe('2020-03-01T03:00:00.000Z');
      expect(rows[1].checkOutAt).toBeNull();
    });

    it('replace 顶掉签退 → 以替代者的时刻为准(时长跟着变)', async () => {
      const fixture = await createSealedActivity();
      await createPunchEvent(fixture, fixture.identityId, 'check_in', '2020-03-01T00:00:00.000Z');
      const checkOutId = await createPunchEvent(
        fixture,
        fixture.identityId,
        'check_out',
        '2020-03-01T03:00:00.000Z',
      );
      const replaceId = await createPunchEvent(
        fixture,
        fixture.identityId,
        'replace',
        '2020-03-01T02:00:00.000Z',
        checkOutId,
      );

      const result = await service.generate(fixture.activityId, actor, auditMeta);
      expect(result.items[0].calculatedServiceHours).toBe(2);
      const segment = await prisma.participantServiceSegmentRevision.findFirstOrThrow({
        where: { participationIdentityId: fixture.identityId, statusCode: { not: 'superseded' } },
        select: { sourceCloseEventId: true, checkOutAt: true },
      });
      expect(segment.sourceCloseEventId).toBe(replaceId);
      expect(segment.checkOutAt?.toISOString()).toBe('2020-03-01T02:00:00.000Z');
    });

    it('签到被 void → 段整条消失(旧段 superseded,不留替代行)', async () => {
      const fixture = await createSealedActivity();
      const checkInId = await createPunchEvent(
        fixture,
        fixture.identityId,
        'check_in',
        '2020-03-01T00:00:00.000Z',
      );
      await createPunchEvent(fixture, fixture.identityId, 'check_out', '2020-03-01T03:00:00.000Z');
      await service.generate(fixture.activityId, actor, auditMeta);

      await createPunchEvent(
        fixture,
        fixture.identityId,
        'void',
        '2020-03-01T05:00:00.000Z',
        checkInId,
      );
      const after = await service.generate(fixture.activityId, actor, auditMeta);

      expect(after.serviceSegmentCount).toBe(0);
      expect(after.segmentsSuperseded).toBe(1);
      expect(after.segmentsCreated).toBe(0);
      await expect(
        prisma.participantServiceSegmentRevision.count({
          where: { participationIdentityId: fixture.identityId, statusCode: { not: 'superseded' } },
        }),
      ).resolves.toBe(0);
      // 链只剩一条孤立签退 ⇒ 待定,不是判 present。
      expect(after.items[0].decision).toBe('pending');
      expect(after.items[0].pendingReasons).toContain('punch_chain_conflict');
    });
  });

  describe('DoD 3 ③⭐ early_departure_close ⇒ 0 时长 0 分', () => {
    it('早退闭合 → 段 early_departure_zero、0 时长;草稿项 0 时长 0 分且不算在场', async () => {
      const fixture = await createSealedActivity();
      // 规则给 5 分:证明 0 分来自"零结果"而不是"没有规则"。
      await createContributionRule(fixture.activityTypeCode, 'member', 5);
      await createPunchEvent(fixture, fixture.identityId, 'check_in', '2020-03-01T00:00:00.000Z');
      await createPunchEvent(
        fixture,
        fixture.identityId,
        'early_departure_close',
        '2020-03-01T03:00:00.000Z',
      );

      const result = await service.generate(fixture.activityId, actor, auditMeta);

      const segment = await prisma.participantServiceSegmentRevision.findFirstOrThrow({
        where: { participationIdentityId: fixture.identityId, statusCode: { not: 'superseded' } },
        select: { resultCode: true, serviceHours: true, checkOutAt: true },
      });
      expect(segment.resultCode).toBe('early_departure_zero');
      expect(Number(segment.serviceHours)).toBe(0);

      const item = result.items[0];
      expect(item.decision).toBe('machine_determined');
      expect(item.resultCode).toBe('early_departure_zero');
      expect(item.calculatedServiceHours).toBe(0);
      expect(item.calculatedContributionPoints).toBe(0);
      // 零结果不是"缺规则",不该被标 blocker。
      expect(item.blockers).toStrictEqual([]);

      const row = await prisma.participantSettlementResultRevision.findFirstOrThrow({
        where: { participationIdentityId: fixture.identityId },
        select: { resultCode: true, calculatedContributionPoints: true, exceptionFlagsJson: true },
      });
      expect(row.resultCode).toBe('early_departure_zero');
      expect(Number(row.calculatedContributionPoints)).toBe(0);
      expect(row.exceptionFlagsJson).toBeNull();
    });
  });

  // =========================================================================
  // ⭐ DoD 4:无 event 者不自动判 absent
  // =========================================================================

  describe('DoD 4 ⭐ 待定 ≠ absent,建议 ≠ 认定', () => {
    it('零 punch 的身份 → 待定态:认定为空、建议 absent,库里没有任何 absent 结果行', async () => {
      const fixture = await createSealedActivity();

      const result = await service.generate(fixture.activityId, actor, auditMeta);

      const item = result.items[0];
      expect(item.decision).toBe('pending');
      expect(item.pendingReasons).toStrictEqual(['no_punch_event']);
      // 🔴 「建议」与「认定」是两个字段,而且互斥填充。
      expect(item.suggestedResultCode).toBe('absent');
      expect(item.resultCode).toBeNull();

      // 🔴 库里绝不许出现一条 absent(或任何)结果行 —— 待定项不写认定。
      await expect(
        prisma.participantSettlementResultRevision.count({
          where: { participationIdentityId: fixture.identityId },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.participantSettlementResultRevision.count({
          where: { resultCode: 'absent', identity: { activityId: fixture.activityId } },
        }),
      ).resolves.toBe(0);

      // 未决的机器执行位:版本行上落着"应有几项",第三刀提交时一比就红(§5.10 ④)。
      expect(result.sessionParticipationCount).toBe(1);
      expect(result.determinedItemCount).toBe(0);
      expect(result.pendingItemCount).toBe(1);
      const version = await prisma.attendanceSettlementVersion.findFirstOrThrow({
        where: { settlementRun: { activityId: fixture.activityId } },
        select: { id: true, sessionParticipationCount: true },
      });
      expect(version.sessionParticipationCount).toBe(1);
      await expect(
        prisma.participantSettlementResultRevision.count({
          where: { settlementVersionId: version.id },
        }),
      ).resolves.toBe(0);
    });

    it('「待定」与「不在人口」可区分:待定 = populationIncluded 且无结果行', async () => {
      const fixture = await createSealedActivity();
      const result = await service.generate(fixture.activityId, actor, auditMeta);

      // 该身份在人口里(所以有草稿项),只是没有认定。
      expect(result.items.map((item) => item.participationIdentityId)).toStrictEqual([
        fixture.identityId,
      ]);
      const identity = await prisma.activityParticipationIdentity.findUniqueOrThrow({
        where: { id: fixture.identityId },
        select: { populationIncluded: true },
      });
      expect(identity.populationIncluded).toBe(true);
    });

    it('链冲突型待定不给建议(合同没给该形态的建议口径,系统不猜)', async () => {
      const fixture = await createSealedActivity();
      await createPunchEvent(fixture, fixture.identityId, 'check_out', '2020-03-01T03:00:00.000Z');

      const result = await service.generate(fixture.activityId, actor, auditMeta);
      expect(result.items[0].decision).toBe('pending');
      expect(result.items[0].pendingReasons).toStrictEqual([
        'punch_chain_conflict',
        'no_punch_event',
      ]);
      expect(result.items[0].suggestedResultCode).toBe('absent');
      expect(result.items[0].resultCode).toBeNull();
    });
  });

  // =========================================================================
  // DoD 5:迟到 / 早退按**冻结阈值**
  // =========================================================================

  describe('DoD 5 —— 迟到/早退取场次行上的冻结阈值', () => {
    async function runWithThresholds(
      lateGraceMinutes: number,
      earlyLeaveThresholdMinutes: number,
    ): Promise<{ lateFlag: boolean; earlyLeaveFlag: boolean }> {
      const fixture = await createSealedActivity({
        lateGraceMinutes,
        earlyLeaveThresholdMinutes,
      });
      // 迟到 20 分钟、早退 60 分钟。
      await createPunchEvent(fixture, fixture.identityId, 'check_in', '2020-03-01T00:20:00.000Z');
      await createPunchEvent(fixture, fixture.identityId, 'check_out', '2020-03-01T03:00:00.000Z');
      const result = await service.generate(fixture.activityId, actor, auditMeta);
      const segment = await prisma.participantServiceSegmentRevision.findFirstOrThrow({
        where: { participationIdentityId: fixture.identityId, statusCode: { not: 'superseded' } },
        select: { lateFlag: true, earlyLeaveFlag: true },
      });
      // 段上的标签与草稿项上的标签必须一致(项是段的聚合)。
      expect(result.items[0].lateFlag).toBe(segment.lateFlag);
      expect(result.items[0].earlyLeaveFlag).toBe(segment.earlyLeaveFlag);
      return segment;
    }

    // ⚠️ 阈值只能取 0..60(§3.2,DB 有 range CHECK)⇒ 翻面用 30/60:
    //    迟到 20 分钟 < 宽限 30 ⇒ 不迟到;签退 03:00 恰好等于 endAt−60min ⇒ 不早退
    //    (边界是**严格早于**)。同一组打卡事实,只换场次行上的两列。
    it('改场次上的阈值 → 标签跟着变(15/15 → 都命中;30/60 → 都不命中)', async () => {
      await expect(runWithThresholds(15, 15)).resolves.toStrictEqual({
        lateFlag: true,
        earlyLeaveFlag: true,
      });
      await expect(runWithThresholds(30, 60)).resolves.toStrictEqual({
        lateFlag: false,
        earlyLeaveFlag: false,
      });
    });
  });

  // =========================================================================
  // ⭐ DoD 6:应计分但无有效贡献规则 ⇒ 标 blocker,不是静默填 0
  // =========================================================================

  describe('DoD 6 ⭐ 无有效贡献规则 ⇒ blocker', () => {
    it('present 且算出 0 分 → 必须带 blocker 标记(绝不出现 0 分且无标记的项)', async () => {
      const fixture = await createSealedActivity();
      // 刻意**不**建贡献规则。
      await createPunchEvent(fixture, fixture.identityId, 'check_in', '2020-03-01T00:00:00.000Z');
      await createPunchEvent(fixture, fixture.identityId, 'check_out', '2020-03-01T03:00:00.000Z');

      const result = await service.generate(fixture.activityId, actor, auditMeta);

      const item = result.items[0];
      expect(item.resultCode).toBe('present');
      expect(item.calculatedContributionPoints).toBe(0);
      // 🔴 原始断言:0 分必须带标记。
      expect(item.blockers).toStrictEqual(['contribution_points_zero_no_effective_rule']);
      expect(result.blockedItemCount).toBe(1);

      const row = await prisma.participantSettlementResultRevision.findFirstOrThrow({
        where: { participationIdentityId: fixture.identityId },
        select: { calculatedContributionPoints: true, exceptionFlagsJson: true },
      });
      expect(Number(row.calculatedContributionPoints)).toBe(0);
      expect(row.exceptionFlagsJson).toStrictEqual({
        blockers: ['contribution_points_zero_no_effective_rule'],
      });
    });

    it('🔴 全库巡检:不存在「应计分 + 0 分 + 无标记」的结果行', async () => {
      const rows = await prisma.$queryRaw<Array<{ zeroPoint: number; unmarked: number }>>`
        SELECT
          count(*) FILTER (
            WHERE "resultCode" = 'present' AND "calculatedContributionPoints" = 0
          )::int AS "zeroPoint",
          count(*) FILTER (
            WHERE "resultCode" = 'present'
              AND "calculatedContributionPoints" = 0
              AND "exceptionFlagsJson" IS NULL
          )::int AS "unmarked"
        FROM "ParticipantSettlementResultRevision"
      `;
      // 正对照:上一条用例确实造出了"应计分且 0 分"的行 —— 否则这条巡检是空绿。
      expect(rows[0].zeroPoint).toBeGreaterThan(0);
      // 🔴 判据本体:这些行必须无一例外带着标记。
      expect(rows[0].unmarked).toBe(0);
    });

    it('翻面:有 ACTIVE 规则给正分 → 不标 blocker(证明标的是"算出 0"不是"沾边就标")', async () => {
      const fixture = await createSealedActivity();
      await createContributionRule(fixture.activityTypeCode, 'member', 1.5);
      await createPunchEvent(fixture, fixture.identityId, 'check_in', '2020-03-01T00:00:00.000Z');
      await createPunchEvent(fixture, fixture.identityId, 'check_out', '2020-03-01T03:00:00.000Z');

      const result = await service.generate(fixture.activityId, actor, auditMeta);
      expect(result.items[0].calculatedContributionPoints).toBe(1.5);
      expect(result.items[0].blockers).toStrictEqual([]);
      expect(result.blockedItemCount).toBe(0);

      const row = await prisma.participantSettlementResultRevision.findFirstOrThrow({
        where: { participationIdentityId: fixture.identityId },
        select: { calculatedContributionPoints: true, exceptionFlagsJson: true },
      });
      expect(Number(row.calculatedContributionPoints)).toBe(1.5);
      expect(row.exceptionFlagsJson).toBeNull();
    });

    it('规则查找按岗位的 attendanceRoleCode(不是永远按 member)', async () => {
      const fixture = await createSealedActivity();
      const position = await prisma.activitySessionPosition.create({
        data: {
          activityId: fixture.activityId,
          sessionId: fixture.sessionId,
          code: 'p-leader',
          name: '带队',
          attendanceRoleCode: 'leader',
        },
        select: { id: true },
      });
      await prisma.activityParticipationIdentity.update({
        where: { id: fixture.identityId },
        data: { currentPositionId: position.id },
      });
      // 只给 leader 建规则:若实现按 member 查就会算出 0 并被标 blocker。
      await createContributionRule(fixture.activityTypeCode, 'leader', 2.5);
      await createPunchEvent(fixture, fixture.identityId, 'check_in', '2020-03-01T00:00:00.000Z');
      await createPunchEvent(fixture, fixture.identityId, 'check_out', '2020-03-01T03:00:00.000Z');

      const result = await service.generate(fixture.activityId, actor, auditMeta);
      expect(result.items[0].calculatedContributionPoints).toBe(2.5);
      expect(result.items[0].blockers).toStrictEqual([]);
    });

    // ⚠️ **诚实标注**:原本想用「同 pair 两条 ACTIVE 规则 → 计算器 fail-closed 抛错」
    //    当复用证据,实测**造不出这个前置状态** —— 第 2026-07-18 号 migration 上有
    //    `contribution_rule_active_pair_unique`(同 pair 未软删 ACTIVE 唯一),
    //    第二条 ACTIVE 规则直接被 23505 拒。计算器里那条 fail-closed 是**防 schema 漂移**的
    //    第二道闸,当前 DB 状态下不可达 ⇒ 不写一条"看着在测其实测不到"的用例。
    //    「复用而不是另写一套查找」改用**结构判据**钉住,见
    //    `src/modules/activities/settlement-draft.service.spec.ts`。
    it('同 pair 第二条 ACTIVE 贡献规则会被 DB 直接拒(说明上面那条 fail-closed 分支不可达)', async () => {
      const fixture = await createSealedActivity();
      await createContributionRule(fixture.activityTypeCode, 'member', 1);
      await expect(createContributionRule(fixture.activityTypeCode, 'member', 9)).rejects.toThrow(
        /Unique constraint failed/,
      );
    });
  });

  // =========================================================================
  // DoD 7:同步路径 500 阈值
  // =========================================================================

  describe('DoD 7 —— 同步路径上限', () => {
    it('人口超过 500 → SETTLEMENT_DRAFT_POPULATION_TOO_LARGE(提示走批处理)', async () => {
      const fixture = await createSealedActivity({ withSeal: false });
      // 基线已有 1 个身份;再补 500 个 ⇒ 501 > 500。
      sequence += 1;
      const tag = `bulk-${sequence}`;
      const members = await prisma.$transaction(
        Array.from({ length: 500 }, (_unused, index) =>
          prisma.member.create({
            data: {
              memberNo: `${tag}-${index}`,
              ...memberIdentityData(`批量队员 ${index}`),
              gradeCode: 'level-2',
            },
            select: { id: true },
          }),
        ),
      );
      // ⚠️ 每人一张**自己的**报名头。原先这批身份共用一张头,而那张头只属于某一个
      // 队员 —— 复合锚点闭合后 registrationId + activityId + memberId 会直接拒掉,
      // 因为那正是「身份错挂他人报名头」的形态,此前只是被当作灌数据的捷径。
      // 生产路径本来就是一人一头。
      const registrations = await prisma.$transaction(
        members.map((member) =>
          prisma.activityRegistration.create({
            data: {
              activityId: fixture.activityId,
              memberId: member.id,
              statusCode: 'approved',
            },
            select: { id: true, memberId: true },
          }),
        ),
      );
      await prisma.activityParticipationIdentity.createMany({
        data: registrations.map((registration) => ({
          activityId: fixture.activityId,
          sessionId: fixture.sessionId,
          registrationId: registration.id,
          memberId: registration.memberId,
          currentStatusCode: 'pass',
          populationIncluded: true,
        })),
      });
      await createSeal(fixture.activityId);

      await expectRefusal(fixture.activityId, BizCode.SETTLEMENT_DRAFT_POPULATION_TOO_LARGE);
    });

    it('翻面:恰好 500 放行(阈值是 > 500 才拒,不是 >= 500)', async () => {
      const fixture = await createSealedActivity({ withSeal: false });
      sequence += 1;
      const tag = `bulk-edge-${sequence}`;
      const members = await prisma.$transaction(
        Array.from({ length: 499 }, (_unused, index) =>
          prisma.member.create({
            data: {
              memberNo: `${tag}-${index}`,
              ...memberIdentityData(`边界队员 ${index}`),
              gradeCode: 'level-2',
            },
            select: { id: true },
          }),
        ),
      );
      // ⚠️ 每人一张**自己的**报名头。原先这批身份共用一张头,而那张头只属于某一个
      // 队员 —— 复合锚点闭合后 registrationId + activityId + memberId 会直接拒掉,
      // 因为那正是「身份错挂他人报名头」的形态,此前只是被当作灌数据的捷径。
      // 生产路径本来就是一人一头。
      const registrations = await prisma.$transaction(
        members.map((member) =>
          prisma.activityRegistration.create({
            data: {
              activityId: fixture.activityId,
              memberId: member.id,
              statusCode: 'approved',
            },
            select: { id: true, memberId: true },
          }),
        ),
      );
      await prisma.activityParticipationIdentity.createMany({
        data: registrations.map((registration) => ({
          activityId: fixture.activityId,
          sessionId: fixture.sessionId,
          registrationId: registration.id,
          memberId: registration.memberId,
          currentStatusCode: 'pass',
          populationIncluded: true,
        })),
      });
      await createSeal(fixture.activityId);

      const result = await service.generate(fixture.activityId, actor, auditMeta);
      expect(result.sessionParticipationCount).toBe(500);
    });

    it('本刀零批处理:超阈值时不创建任何 ActivityBatchJob', async () => {
      await expect(prisma.activityBatchJob.count()).resolves.toBe(0);
    });
  });

  // =========================================================================
  // DoD 8:写入对象与重复生成的处置
  // =========================================================================

  describe('DoD 8 —— 写入对象 / 重复生成', () => {
    // ⚠️ 幂等**有两个独立的实现点**(段的内容比对 / 版本的 contentHash 比对),
    //    所以拆成两条用例 —— 合成一条的话,卸掉其中任何一个都红同一条,
    //    判据矩阵就分不出是哪一处坏了(初版实测两次变异红集完全重合)。
    async function generateTwice(): Promise<{
      fixture: DraftFixture;
      first: Awaited<ReturnType<typeof service.generate>>;
      second: Awaited<ReturnType<typeof service.generate>>;
    }> {
      const fixture = await createSealedActivity();
      await createContributionRule(fixture.activityTypeCode, 'member', 1);
      await createPunchEvent(fixture, fixture.identityId, 'check_in', '2020-03-01T00:00:00.000Z');
      await createPunchEvent(fixture, fixture.identityId, 'check_out', '2020-03-01T03:00:00.000Z');
      const first = await service.generate(fixture.activityId, actor, auditMeta);
      const second = await service.generate(fixture.activityId, actor, auditMeta);
      return { fixture, first, second };
    }

    it('重复生成 ①:输入没变 ⇒ 段一行不动(内容寻址比对,不新开 revision)', async () => {
      const { fixture, second } = await generateTwice();

      expect(second.segmentsCreated).toBe(0);
      expect(second.segmentsSuperseded).toBe(0);
      expect(second.segmentsUnchanged).toBe(1);
      await expect(
        prisma.participantServiceSegmentRevision.count({
          where: { participationIdentityId: fixture.identityId },
        }),
      ).resolves.toBe(1);
    });

    it('重复生成 ②:输入没变 ⇒ 草稿版本不新开、contentHash 不变、结果行不重复', async () => {
      const { fixture, first, second } = await generateTwice();

      expect(second.contentHash).toBe(first.contentHash);
      expect(second.settlementVersion).toBe(first.settlementVersion);
      expect(second.settlementVersionId).toBe(first.settlementVersionId);
      await expect(
        prisma.attendanceSettlementVersion.count({
          where: { settlementRun: { activityId: fixture.activityId } },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.participantSettlementResultRevision.count({
          where: { settlementVersionId: first.settlementVersionId },
        }),
      ).resolves.toBe(1);
    });

    it('重复生成 ③:输入变了 ⇒ 旧 draft 版本标 voided,另开 version+1(零删除)', async () => {
      const fixture = await createSealedActivity();
      await createContributionRule(fixture.activityTypeCode, 'member', 1);
      await createPunchEvent(fixture, fixture.identityId, 'check_in', '2020-03-01T00:00:00.000Z');
      const checkOutId = await createPunchEvent(
        fixture,
        fixture.identityId,
        'check_out',
        '2020-03-01T03:00:00.000Z',
      );
      const first = await service.generate(fixture.activityId, actor, auditMeta);

      await createPunchEvent(
        fixture,
        fixture.identityId,
        'void',
        '2020-03-01T05:00:00.000Z',
        checkOutId,
      );
      const second = await service.generate(fixture.activityId, actor, auditMeta);

      expect(second.settlementVersion).toBe(first.settlementVersion + 1);
      expect(second.contentHash).not.toBe(first.contentHash);

      const versions = await prisma.attendanceSettlementVersion.findMany({
        where: { settlementRun: { activityId: fixture.activityId } },
        orderBy: { version: 'asc' },
        select: { version: true, statusCode: true },
      });
      expect(versions).toStrictEqual([
        { version: 1, statusCode: 'voided' },
        { version: 2, statusCode: 'draft' },
      ]);
      // 🔴 零删除:旧版本的结果行原样保留,只是整版被作废。
      await expect(
        prisma.participantSettlementResultRevision.count({
          where: { settlementVersionId: first.settlementVersionId },
        }),
      ).resolves.toBe(1);
      // 新版本里该人已变待定 ⇒ 没有结果行(不是把旧的那条 present 留着不管)。
      await expect(
        prisma.participantSettlementResultRevision.count({
          where: { settlementVersionId: second.settlementVersionId },
        }),
      ).resolves.toBe(0);
    });

    it('写入对象齐全:draft 版本 + draft 结果行 + draft 段,run 进 drafting 并指向该版本', async () => {
      const fixture = await createSealedActivity();
      await createContributionRule(fixture.activityTypeCode, 'member', 1);
      await createPunchEvent(fixture, fixture.identityId, 'check_in', '2020-03-01T00:00:00.000Z');
      await createPunchEvent(fixture, fixture.identityId, 'check_out', '2020-03-01T03:00:00.000Z');

      const result = await service.generate(fixture.activityId, actor, auditMeta);

      const run = await prisma.attendanceSettlementRun.findUniqueOrThrow({
        where: { activityId: fixture.activityId },
        select: { statusCode: true, currentDraftVersion: true, version: true },
      });
      expect(run.statusCode).toBe('drafting');
      expect(run.currentDraftVersion).toBe(result.settlementVersion);
      expect(run.version).toBe(1);

      const version = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: result.settlementVersionId },
        select: {
          statusCode: true,
          evidenceSealId: true,
          personCount: true,
          sessionParticipationCount: true,
          serviceSegmentCount: true,
          submittedAt: true,
          createdByUserId: true,
        },
      });
      expect(version.statusCode).toBe('draft');
      expect(version.evidenceSealId).toBe(result.evidenceSealId);
      expect(version.personCount).toBe(1);
      expect(version.sessionParticipationCount).toBe(1);
      expect(version.serviceSegmentCount).toBe(1);
      expect(version.submittedAt).toBeNull();
      expect(version.createdByUserId).toBe(actor.id);

      const segment = await prisma.participantServiceSegmentRevision.findFirstOrThrow({
        where: { participationIdentityId: fixture.identityId },
        select: { statusCode: true, revision: true, effectiveBatchId: true },
      });
      expect(segment.statusCode).toBe('draft');
      expect(segment.revision).toBe(0);
      expect(segment.effectiveBatchId).toBeNull();

      const item = await prisma.participantSettlementResultRevision.findFirstOrThrow({
        where: { settlementVersionId: result.settlementVersionId },
        select: {
          statusCode: true,
          recognizedServiceHours: true,
          calculatedServiceHours: true,
          adjustmentReason: true,
        },
      });
      expect(item.statusCode).toBe('draft');
      // 草稿阶段"认定 = 计算" ⇒ §3.20 的 adjustmentReason 必填 CHECK 不触发。
      expect(Number(item.recognizedServiceHours)).toBe(Number(item.calculatedServiceHours));
      expect(item.adjustmentReason).toBeNull();
    });

    it('§3.18 partial unique 成立:任一 (identity, segmentKey) 至多一个非 superseded 当前修订', async () => {
      const rows = await prisma.participantServiceSegmentRevision.groupBy({
        by: ['participationIdentityId', 'segmentKey'],
        where: { statusCode: { not: 'superseded' } },
        _count: { _all: true },
      });
      expect(rows.every((row) => row._count._all === 1)).toBe(true);
    });

    it('结算已提交/审核中的 run 不许重新生成草稿 → SETTLEMENT_DRAFT_RUN_STATUS_INVALID', async () => {
      const fixture = await createSealedActivity();
      await prisma.attendanceSettlementRun.create({
        data: { activityId: fixture.activityId, statusCode: 'pending_first_review' },
      });
      const error = await service.generate(fixture.activityId, actor, auditMeta).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(BizException);
      expect((error as BizException).biz).toBe(BizCode.SETTLEMENT_DRAFT_RUN_STATUS_INVALID);
    });

    it('翻面:not_started 的 run 允许生成并被推进到 drafting', async () => {
      const fixture = await createSealedActivity();
      await prisma.attendanceSettlementRun.create({
        data: { activityId: fixture.activityId, statusCode: 'not_started' },
      });
      const result = await service.generate(fixture.activityId, actor, auditMeta);
      expect(result.settlementVersion).toBe(1);
      const run = await prisma.attendanceSettlementRun.findUniqueOrThrow({
        where: { activityId: fixture.activityId },
        select: { statusCode: true },
      });
      expect(run.statusCode).toBe('drafting');
    });
  });

  // =========================================================================
  // DoD 9 / 11:零 Punch 写路径、零新事件串
  // =========================================================================

  describe('DoD 9 / 11 —— 只读打卡事件、复用伞事件', () => {
    it('生成前后 AttendancePunchEvent 行数与内容逐字不变(本刀零 Punch 写路径)', async () => {
      const fixture = await createSealedActivity();
      await createPunchEvent(fixture, fixture.identityId, 'check_in', '2020-03-01T00:00:00.000Z');
      await createPunchEvent(fixture, fixture.identityId, 'check_out', '2020-03-01T03:00:00.000Z');

      const before = await prisma.attendancePunchEvent.findMany({
        where: { activityId: fixture.activityId },
        orderBy: { id: 'asc' },
      });
      await service.generate(fixture.activityId, actor, auditMeta);
      const after = await prisma.attendancePunchEvent.findMany({
        where: { activityId: fixture.activityId },
        orderBy: { id: 'asc' },
      });
      expect(after).toStrictEqual(before);
    });

    it('落 audit 且复用 activity.publish 伞事件 + extra.operation=settlement-draft-generate', async () => {
      const fixture = await createSealedActivity();
      const result = await service.generate(fixture.activityId, actor, auditMeta);

      const logs = await prisma.auditLog.findMany({
        where: { resourceType: 'activity', resourceId: fixture.activityId },
        select: { event: true, actorUserId: true, context: true },
      });
      expect(logs).toHaveLength(1);
      expect(logs[0].event).toBe('activity.publish');
      expect(logs[0].actorUserId).toBe(actor.id);
      const extra = (logs[0].context as { extra?: Record<string, unknown> }).extra ?? {};
      expect(extra.operation).toBe('settlement-draft-generate');
      expect(extra.settlementVersionId).toBe(result.settlementVersionId);
      expect(extra.contentHash).toBe(result.contentHash);
      expect(extra.pendingItemCount).toBe(1);
    });
  });
});
