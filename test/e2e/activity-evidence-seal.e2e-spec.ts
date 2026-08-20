import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { EvidenceSealService } from '../../src/modules/activities/evidence-seal.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// ===== 活动改造 v1.1 第 2 批第一刀:证据封场(合同 §5.8)=====
//
// 本 spec 的全部意义是把合同那句话变成可执行判据:
//   「seal 不是"负责人承诺",没有所有条件不能写。」
// ⇒ 每一条拒绝理由**一个具名 BizCode、一条独立用例**,并且每条用例都设计成
//   **只由它对应的那一个条件触发** —— 拆掉哪一道闸,就只有那一条红。
//
// 每条拒绝理由旁边都配一条**翻面的放行用例**(终止截止已过 / superseded 段 /
// voided 段 / 已审结的变更 / 版本真变了),证明闸守的是它声称的那个条件,
// 而不是"沾边就拒"的粗判据。

const PAST = new Date('2020-03-01T00:00:00.000Z');
const FUTURE = new Date('2099-09-01T00:00:00.000Z');

interface SealFixture {
  activityId: string;
  sessionId: string;
  memberId: string;
  identityId: string;
}

describe('evidence seal (合同 §5.8)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: EvidenceSealService;
  let actor: CurrentUserPayload;
  let organizationId: string;
  let sequence = 0;

  const auditMeta = { requestId: 'evidence-seal-e2e', ip: null, ua: null };

  beforeAll(async () => {
    // 第 7 批第 ③ 刀 —— 活动 v1.1 单一 cutover gate(合同 §16.2)。本 spec 驱动的是
    // **结算真相链**(打卡 / 封场 / 结算 / 账本 / 关账 / 更正),那条链按定义只在闸开时存在;
    // 闸关(默认 = 今天的行为)时这些写入口一律回 20153。故此处显式置真,
    // **断言一字未改** —— 改的只是这个 spec 声明自己跑在哪一侧闸。
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    service = app.get(EvidenceSealService);

    const user = await createTestUser(app, {
      username: 'evidence-seal-actor',
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
      data: { name: '封场测试组织', nodeTypeCode: 'evidence-seal-team' },
      select: { id: true },
    });
    organizationId = organization.id;
  });

  afterAll(async () => {
    delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    await app.close();
  });

  // 基线夹具:**恰好满足全部封场条件**的一个活动。
  // 每条拒绝用例只在这份基线上动**一处**,红集才可能不重叠。
  async function createSealableActivity(
    sessionOverrides: {
      checkOutCloseAt?: Date;
      statusCode?: string;
      terminationCheckOutDeadline?: Date | null;
    } = {},
  ): Promise<SealFixture> {
    sequence += 1;
    const tag = `seal-${sequence}`;

    const activity = await prisma.activity.create({
      data: {
        title: `封场活动 ${sequence}`,
        activityTypeCode: 'evidence-seal-type',
        organizationId,
        startAt: PAST,
        endAt: new Date(PAST.getTime() + 4 * 3600_000),
        location: '深圳',
        statusCode: 'published',
      },
      select: { id: true },
    });

    const checkOutCloseAt =
      sessionOverrides.checkOutCloseAt ?? new Date('2020-03-01T08:00:00.000Z');
    const session = await prisma.activitySession.create({
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
        checkOutCloseAt,
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: sessionOverrides.statusCode ?? 'scheduled',
        terminationCheckOutDeadline: sessionOverrides.terminationCheckOutDeadline ?? null,
      },
      select: { id: true },
    });

    const member = await prisma.member.create({
      data: {
        memberNo: `${tag}-m1`,
        ...memberIdentityData(`封场队员 ${sequence}`),
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

    return {
      activityId: activity.id,
      sessionId: session.id,
      memberId: member.id,
      identityId: identity.id,
    };
  }

  async function createPunchEvent(
    fixture: SealFixture,
    overrides: { eventTypeCode?: string; supersedesEventId?: string; reason?: string } = {},
  ): Promise<string> {
    sequence += 1;
    const event = await prisma.attendancePunchEvent.create({
      data: {
        activityId: fixture.activityId,
        sessionId: fixture.sessionId,
        participationIdentityId: fixture.identityId,
        memberId: fixture.memberId,
        eventTypeCode: overrides.eventTypeCode ?? 'check_in',
        sourceCode: 'staff_scan',
        occurredAt: PAST,
        receivedAt: PAST,
        operatorUserId: actor.id,
        eventKey: `seal-event-${sequence}`,
        requestHash: `hash-${sequence}`,
        evidenceRevision: 0,
        supersedesEventId: overrides.supersedesEventId ?? null,
        reason: overrides.reason ?? null,
      },
      select: { id: true },
    });
    return event.id;
  }

  async function createSegment(
    fixture: SealFixture,
    checkInEventId: string,
    overrides: {
      segmentKey?: string;
      revision?: number;
      statusCode?: string;
      resultCode?: string;
      checkOutAt?: Date | null;
      closeEventId?: string | null;
    } = {},
  ): Promise<string> {
    sequence += 1;
    const segment = await prisma.participantServiceSegmentRevision.create({
      data: {
        participationIdentityId: fixture.identityId,
        segmentKey: overrides.segmentKey ?? `seg-${sequence}`,
        revision: overrides.revision ?? 0,
        sourceCheckInEventId: checkInEventId,
        sourceCloseEventId: overrides.closeEventId ?? null,
        resultCode: overrides.resultCode ?? 'valid',
        statusCode: overrides.statusCode ?? 'draft',
        checkInAt: PAST,
        checkOutAt: overrides.checkOutAt ?? null,
      },
      select: { id: true },
    });
    return segment.id;
  }

  async function expectRefusal(
    activityId: string,
    expected: (typeof BizCode)[keyof typeof BizCode],
  ) {
    const error = await service.seal(activityId, actor, auditMeta).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(BizException);
    expect((error as BizException).biz).toBe(expected);
    // 拒绝必须是**干净拒绝**:一行 seal 都不许落。
    await expect(prisma.evidenceSeal.count({ where: { activityId } })).resolves.toBe(0);
  }

  // ===== 正面:八步全过 =====

  it('① 全部条件满足 → 写出 immutable EvidenceSeal(sealRevision 从 1 起)', async () => {
    const fixture = await createSealableActivity();

    const result = await service.seal(fixture.activityId, actor, auditMeta);

    expect(result.sealRevision).toBe(1);
    expect(result.openSegmentCount).toBe(0);
    expect(result.manualReviewPendingCount).toBe(0);
    expect(result.populationCountDistinct).toBe(1);
    expect(result.populationCountBySession).toStrictEqual({ [fixture.sessionId]: 1 });
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.supersededSealCount).toBe(0);

    const row = await prisma.evidenceSeal.findUniqueOrThrow({
      where: { activityId_sealRevision: { activityId: fixture.activityId, sealRevision: 1 } },
      select: {
        statusCode: true,
        evidenceRevision: true,
        populationRevision: true,
        workflowRevision: true,
        allWindowsClosedAt: true,
        sealedByUserId: true,
        populationCountBySession: true,
      },
    });
    expect(row.statusCode).toBe('active');
    expect(row.evidenceRevision).toBe(0);
    expect(row.populationRevision).toBe(0);
    expect(row.workflowRevision).toBe(0);
    expect(row.sealedByUserId).toBe(actor.id);
    // §5.8 ③:allWindowsClosedAt = 全部有效 checkout deadline 的最大值。
    expect(row.allWindowsClosedAt.toISOString()).toBe('2020-03-01T08:00:00.000Z');
    expect(row.populationCountBySession).toStrictEqual({ [fixture.sessionId]: 1 });
  });

  it('① 附:落 audit 且复用 activity.publish 伞事件 + extra.operation=evidence-seal(零新事件串)', async () => {
    const fixture = await createSealableActivity();
    const result = await service.seal(fixture.activityId, actor, auditMeta);

    const logs = await prisma.auditLog.findMany({
      where: { resourceType: 'activity', resourceId: fixture.activityId },
      select: { event: true, actorUserId: true, context: true },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].event).toBe('activity.publish');
    expect(logs[0].actorUserId).toBe(actor.id);
    const extra = (logs[0].context as { extra?: Record<string, unknown> }).extra ?? {};
    expect(extra.operation).toBe('evidence-seal');
    expect(extra.sealId).toBe(result.sealId);
    expect(extra.contentHash).toBe(result.contentHash);
  });

  it('① 附:population 只数 populationIncluded=true,distinct 按 memberId 去重', async () => {
    const fixture = await createSealableActivity();
    sequence += 1;
    // 第二个场次 + 同一个人 → distinct 仍是 1,by-session 两条各 1。
    const session2 = await prisma.activitySession.create({
      data: {
        activityId: fixture.activityId,
        code: `seal-${sequence}-s2`,
        name: `seal-${sequence} 场次二`,
        startAt: PAST,
        endAt: new Date(PAST.getTime() + 4 * 3600_000),
        locationText: '深圳',
        checkInOpenAt: new Date(PAST.getTime() - 3600_000),
        checkInCloseAt: new Date(PAST.getTime() + 3600_000),
        checkOutOpenAt: new Date(PAST.getTime() + 2 * 3600_000),
        checkOutCloseAt: new Date('2020-03-01T07:00:00.000Z'),
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
    await prisma.activityParticipationIdentity.create({
      data: {
        activityId: fixture.activityId,
        sessionId: session2.id,
        registrationId: registration.id,
        memberId: fixture.memberId,
        currentStatusCode: 'pass',
        populationIncluded: true,
      },
    });
    // 第三条:同活动另一人但 populationIncluded=false → 两个计数都不该动。
    sequence += 1;
    const excludedMember = await prisma.member.create({
      data: {
        memberNo: `seal-${sequence}-excluded`,
        ...memberIdentityData('未入人口'),
        gradeCode: 'level-2',
      },
      select: { id: true },
    });
    const excludedRegistration = await prisma.activityRegistration.create({
      data: { activityId: fixture.activityId, memberId: excludedMember.id, statusCode: 'pending' },
      select: { id: true },
    });
    await prisma.activityParticipationIdentity.create({
      data: {
        activityId: fixture.activityId,
        sessionId: fixture.sessionId,
        registrationId: excludedRegistration.id,
        memberId: excludedMember.id,
        currentStatusCode: 'waitlisted',
        populationIncluded: false,
      },
    });

    const result = await service.seal(fixture.activityId, actor, auditMeta);
    expect(result.populationCountDistinct).toBe(1);
    expect(result.populationCountBySession).toStrictEqual({
      [fixture.sessionId]: 1,
      [session2.id]: 1,
    });
  });

  it('① 附:活动不存在 / 已软删 → ACTIVITY_NOT_FOUND(锁不到行就不往下走)', async () => {
    const fixture = await createSealableActivity();
    await prisma.activity.update({
      where: { id: fixture.activityId },
      data: { deletedAt: new Date() },
    });
    await expectRefusal(fixture.activityId, BizCode.ACTIVITY_NOT_FOUND);
  });

  // ===== ③ 签退窗口 =====

  it('③ 仍有场次签退窗口未过 → EVIDENCE_SEAL_CHECKOUT_WINDOW_OPEN', async () => {
    const fixture = await createSealableActivity({ checkOutCloseAt: FUTURE });
    await expectRefusal(fixture.activityId, BizCode.EVIDENCE_SEAL_CHECKOUT_WINDOW_OPEN);
  });

  it('③ 翻面:terminationCheckOutDeadline 覆盖计划窗口 —— 未来的终止截止照样拒', async () => {
    const fixture = await createSealableActivity({
      checkOutCloseAt: new Date('2020-03-01T08:00:00.000Z'),
      statusCode: 'terminated',
      terminationCheckOutDeadline: FUTURE,
    });
    await expectRefusal(fixture.activityId, BizCode.EVIDENCE_SEAL_CHECKOUT_WINDOW_OPEN);
  });

  it('③ 翻面:计划窗口在未来但终止截止已过 → 放行(证明读的是有效截止不是计划截止)', async () => {
    const fixture = await createSealableActivity({
      checkOutCloseAt: FUTURE,
      statusCode: 'terminated',
      terminationCheckOutDeadline: new Date('2020-03-01T09:00:00.000Z'),
    });
    const result = await service.seal(fixture.activityId, actor, auditMeta);
    expect(result.allWindowsClosedAt.toISOString()).toBe('2020-03-01T09:00:00.000Z');
  });

  it('③ 翻面:已取消场次不产生签退义务 → 未来窗口也放行', async () => {
    const fixture = await createSealableActivity({
      checkOutCloseAt: FUTURE,
      statusCode: 'cancelled',
    });
    const result = await service.seal(fixture.activityId, actor, auditMeta);
    expect(result.sealRevision).toBe(1);
  });

  // ===== ④ 开放服务段 =====

  it('④ 存在开放服务段(已签到未闭合)→ EVIDENCE_SEAL_OPEN_SEGMENT_EXISTS', async () => {
    const fixture = await createSealableActivity();
    const checkInEventId = await createPunchEvent(fixture);
    await createSegment(fixture, checkInEventId, { checkOutAt: null });
    await expectRefusal(fixture.activityId, BizCode.EVIDENCE_SEAL_OPEN_SEGMENT_EXISTS);
  });

  it('④ 翻面:superseded 的开放段已被后继 revision 顶掉 → 放行', async () => {
    const fixture = await createSealableActivity();
    const checkInEventId = await createPunchEvent(fixture);
    const closeEventId = await createPunchEvent(fixture, { eventTypeCode: 'check_out' });
    // rev 0 = 当时的开放段,已 superseded;rev 1 = 当前已闭合段(同 segmentKey)。
    await createSegment(fixture, checkInEventId, {
      segmentKey: 'seg-superseded',
      revision: 0,
      statusCode: 'superseded',
      checkOutAt: null,
    });
    await createSegment(fixture, checkInEventId, {
      segmentKey: 'seg-superseded',
      revision: 1,
      statusCode: 'draft',
      checkOutAt: new Date('2020-03-01T04:00:00.000Z'),
      closeEventId,
    });
    const result = await service.seal(fixture.activityId, actor, auditMeta);
    expect(result.openSegmentCount).toBe(0);
  });

  it('④ 翻面:voided 的未闭合段没有待闭合义务 → 放行', async () => {
    const fixture = await createSealableActivity();
    const checkInEventId = await createPunchEvent(fixture);
    await createSegment(fixture, checkInEventId, { resultCode: 'voided', checkOutAt: null });
    const result = await service.seal(fixture.activityId, actor, auditMeta);
    expect(result.openSegmentCount).toBe(0);
  });

  // ===== ④ 待人工复核 =====
  //
  // 🔴 真源表 OfflinePunchReviewItem 至今**没有定义**(AMENDMENTS-v1.1.1 §3:第 6 批开工硬门,
  //    并明禁从 §5.7 散文推导表结构)⇒ 计数查询无表可查,今天结构上恒 0。
  //    本用例钉住的是**闸本身**:计数一旦非零就必须拒。第 6 批把计数填上后本用例不用改。
  //    ⚠️ 这一条是全 spec 唯一靠 spy 制造前置状态的 —— 已在报告里显式标注为局部判据。
  it('④ 存在待人工复核项 → EVIDENCE_SEAL_MANUAL_REVIEW_PENDING(闸已接,真源表待第 6 批)', async () => {
    const fixture = await createSealableActivity();
    const spy = jest
      .spyOn(
        service as unknown as { countPendingManualReviewItems: () => Promise<number> },
        'countPendingManualReviewItems',
      )
      .mockResolvedValue(1);
    try {
      await expectRefusal(fixture.activityId, BizCode.EVIDENCE_SEAL_MANUAL_REVIEW_PENDING);
    } finally {
      spy.mockRestore();
    }
  });

  // ===== ④ 未处理 event effect =====

  it('④ 打卡事件尚未投影成服务段 → EVIDENCE_SEAL_UNPROCESSED_EVENT_EFFECT', async () => {
    const fixture = await createSealableActivity();
    await createPunchEvent(fixture);
    await expectRefusal(fixture.activityId, BizCode.EVIDENCE_SEAL_UNPROCESSED_EVENT_EFFECT);
  });

  it('④ void 事件的目标段还没被顶掉 → 同样是未处理的 event effect', async () => {
    const fixture = await createSealableActivity();
    const checkInEventId = await createPunchEvent(fixture);
    const closeEventId = await createPunchEvent(fixture, { eventTypeCode: 'check_out' });
    await createSegment(fixture, checkInEventId, {
      checkOutAt: new Date('2020-03-01T04:00:00.000Z'),
      closeEventId,
    });
    // void 已落库,但那条段仍是非 superseded 的当前段 ⇒ 投影没做完。
    await createPunchEvent(fixture, {
      eventTypeCode: 'void',
      supersedesEventId: checkInEventId,
      reason: '误签到',
    });
    await expectRefusal(fixture.activityId, BizCode.EVIDENCE_SEAL_UNPROCESSED_EVENT_EFFECT);
  });

  // ===== ⑦ pending change review =====

  it('⑦ 存在 pending 的变更审核 → EVIDENCE_SEAL_CHANGE_REVIEW_PENDING', async () => {
    const fixture = await createSealableActivity();
    await prisma.activityPublishReview.create({
      data: {
        activityId: fixture.activityId,
        requestType: 'change',
        requestVersion: 1,
        baseRevision: 0,
        status: 'pending',
        snapshot: {},
        submittedByUserId: actor.id,
      },
    });
    await expectRefusal(fixture.activityId, BizCode.EVIDENCE_SEAL_CHANGE_REVIEW_PENDING);
  });

  it('⑦ 翻面:已审结(approved)的变更审核不再阻断 → 放行', async () => {
    const fixture = await createSealableActivity();
    await prisma.activityPublishReview.create({
      data: {
        activityId: fixture.activityId,
        requestType: 'change',
        requestVersion: 1,
        baseRevision: 0,
        status: 'approved',
        snapshot: {},
        submittedByUserId: actor.id,
      },
    });
    const result = await service.seal(fixture.activityId, actor, auditMeta);
    expect(result.sealRevision).toBe(1);
  });

  // ===== ⑦ 版本在本事务内变化 =====
  //
  // 构造:在 ⑤ 读版本之后、⑦ 复读之前,由**另一条连接**(不走 Activity 锁序的写入方)
  // 改掉 ActivityEvidenceState。这正是 §5.8 ⑦ 要防的形态 —— 本事务持有的是
  // Activity 行锁,它挡不住直接写 EvidenceState 的路径。
  it('⑦ evidence/population revision 在本事务内被改 → EVIDENCE_SEAL_REVISION_CHANGED', async () => {
    const fixture = await createSealableActivity();
    await prisma.activityEvidenceState.create({
      data: { activityId: fixture.activityId, evidenceRevision: 0, populationRevision: 0 },
    });

    const rogue = app.get(PrismaService);
    const spy = jest
      .spyOn(
        service as unknown as {
          computePopulationSummary: (...args: unknown[]) => Promise<unknown>;
        },
        'computePopulationSummary',
      )
      .mockImplementation(async (...args: unknown[]) => {
        // 先让"绕过锁序的写入方"提交,再放行原本的第 ⑥ 步。
        await rogue.activityEvidenceState.update({
          where: { activityId: fixture.activityId },
          data: { evidenceRevision: { increment: 1 } },
        });
        spy.mockRestore();
        return await (
          service as unknown as {
            computePopulationSummary: (...args: unknown[]) => Promise<unknown>;
          }
        ).computePopulationSummary(...args);
      });

    try {
      await expectRefusal(fixture.activityId, BizCode.EVIDENCE_SEAL_REVISION_CHANGED);
    } finally {
      spy.mockRestore();
    }
  });

  // ===== 已有吻合版本的 active seal =====

  it('⑧ 版本未变时重复封场 → EVIDENCE_SEAL_ALREADY_ACTIVE(不产生第二张章)', async () => {
    const fixture = await createSealableActivity();
    await service.seal(fixture.activityId, actor, auditMeta);

    const error = await service.seal(fixture.activityId, actor, auditMeta).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(BizException);
    expect((error as BizException).biz).toBe(BizCode.EVIDENCE_SEAL_ALREADY_ACTIVE);
    await expect(
      prisma.evidenceSeal.count({ where: { activityId: fixture.activityId } }),
    ).resolves.toBe(1);
  });

  it('⑧ 翻面:版本真变了 → 允许再封,新章 active、旧章 superseded(§4.6 投影)', async () => {
    const fixture = await createSealableActivity();
    const first = await service.seal(fixture.activityId, actor, auditMeta);

    await prisma.activityEvidenceState.create({
      data: { activityId: fixture.activityId, evidenceRevision: 0, populationRevision: 1 },
    });

    const second = await service.seal(fixture.activityId, actor, auditMeta);
    expect(second.sealRevision).toBe(2);
    expect(second.populationRevision).toBe(1);
    expect(second.supersededSealCount).toBe(1);
    expect(second.contentHash).not.toBe(first.contentHash);

    const rows = await prisma.evidenceSeal.findMany({
      where: { activityId: fixture.activityId },
      orderBy: { sealRevision: 'asc' },
      select: { sealRevision: true, statusCode: true, contentHash: true },
    });
    expect(rows.map((row) => [row.sealRevision, row.statusCode])).toStrictEqual([
      [1, 'superseded'],
      [2, 'active'],
    ]);
    // 「不可变」= 内容不可变:旧章的 contentHash 一字未动,只有投影用的 statusCode 变了。
    expect(rows[0].contentHash).toBe(first.contentHash);
  });
});
