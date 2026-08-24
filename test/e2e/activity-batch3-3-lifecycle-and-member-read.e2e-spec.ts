import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Prisma, Role, UserStatus } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// 第 3 批第三刀：生命周期命令、封场 HTTP 接线、队员读面。
//
// 这不是在既有 App detail 契约上另起一个 :activityId 路由；根列表是新增，详情是在
// 已有 published-only 防枚举语义上作受控增量。所有红集都用彼此独立的 fixture，避免
// 一个状态／时间闸意外遮住另一个闸。
describe('Activity batch3 slice3 lifecycle and member read surfaces', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let organizationId: string;
  let activityTypeCode: string;
  let attendanceRoleCode: string;
  let sequence = 0;

  const FUTURE_START = new Date('2099-10-01T02:00:00.000Z');
  const FUTURE_END = new Date('2099-10-01T05:00:00.000Z');
  const PAST_START = new Date('2020-03-01T02:00:00.000Z');
  const PAST_END = new Date('2020-03-01T05:00:00.000Z');

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    // 第 7 批第 ③ 刀 —— 活动 v1.1 单一 cutover gate(合同 §16.2)。本 spec 走生命周期
    // (cancel / terminate)链,而 ActivityLifecycleService 会调 EvidenceSealService.seal()
    // ——**封场属结算真相链、受闸**,故闸关时这条链回 503。跨文件调用,不是本 spec 直接打
    // 受闸端点,所以只看 spec 正文的路由字面量看不出来(CI 撞红后才发现)。断言一字未改。
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    await seedActivityResponsibilitySystemRoles(app);

    const root = await prisma.organization.create({
      data: { name: 'B3 Slice3 Root', nodeTypeCode: 'b3-slice3-root' },
      select: { id: true },
    });
    const organization = await prisma.organization.create({
      data: {
        name: 'B3 Slice3 Team',
        nodeTypeCode: 'b3-slice3-team',
        parentId: root.id,
      },
      select: { id: true },
    });
    organizationId = organization.id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: root.id, descendantId: root.id, depth: 0 },
        { ancestorId: root.id, descendantId: organization.id, depth: 1 },
        { ancestorId: organization.id, descendantId: organization.id, depth: 0 },
      ],
    });

    const activityType = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    activityTypeCode = 'b3-slice3-training';
    await prisma.dictItem.create({
      data: { typeId: activityType.id, code: activityTypeCode, label: '第三刀训练' },
    });
    const attendanceRole = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    attendanceRoleCode = 'b3-slice3-member';
    await prisma.dictItem.create({
      data: { typeId: attendanceRole.id, code: attendanceRoleCode, label: '第三刀队员' },
    });
  });

  afterAll(async () => {
    await app.close();
    delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  });

  async function createMember(label: string, role: Role = Role.USER) {
    sequence += 1;
    const member = await prisma.member.create({
      data: {
        memberNo: `b3-s3-${label}-${sequence}`,
        ...memberIdentityData(`B3 S3 ${label} ${sequence}`),
        gradeCode: 'level-3',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    const user = await createTestUser(app, {
      username: `b3-s3-${label.slice(0, 16)}-${sequence}`,
      role,
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    await prisma.memberOrganizationMembership.create({
      data: { memberId: member.id, organizationId },
    });
    return {
      memberId: member.id,
      userId: user.id,
      auth: (await loginAs(app, user.username)).authHeader,
    };
  }

  async function createActivity(
    options: {
      title?: string;
      statusCode?: string;
      startAt?: Date;
      endAt?: Date;
      initiatorMemberId?: string | null;
      registrationModeCode?: string | null;
      visibilityCode?: string | null;
      organizationOverrideId?: string;
    } = {},
  ) {
    sequence += 1;
    const statusCode = options.statusCode ?? 'draft';
    const startAt = options.startAt ?? FUTURE_START;
    const endAt = options.endAt ?? FUTURE_END;
    return await prisma.activity.create({
      data: {
        title: options.title ?? `B3 Slice3 ${sequence}`,
        activityTypeCode,
        organizationId: options.organizationOverrideId ?? organizationId,
        startAt,
        endAt,
        location: '深圳',
        description: '第三刀生命周期夹具',
        capacity: 20,
        statusCode,
        initiatorMemberId: options.initiatorMemberId ?? null,
        registrationModeCode: options.registrationModeCode ?? 'open_apply',
        visibilityCode: options.visibilityCode ?? 'internal',
        ...(statusCode === 'published'
          ? { publishedAt: new Date('2020-01-01T00:00:00.000Z') }
          : {}),
        ...(statusCode === 'cancelled'
          ? { cancelledAt: new Date('2020-01-01T00:00:00.000Z'), cancelReason: 'fixture' }
          : {}),
        ...(statusCode === 'terminated'
          ? {
              terminatedAt: new Date('2020-01-01T00:00:00.000Z'),
              terminationReason: 'fixture',
            }
          : {}),
      },
      select: { id: true },
    });
  }

  async function assignOwner(
    activityId: string,
    actor: Awaited<ReturnType<typeof createMember>>,
  ): Promise<void> {
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId,
        memberId: actor.memberId,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: actor.userId,
        source: 'publish',
      },
    });
  }

  async function createSession(
    activityId: string,
    options: {
      startAt?: Date;
      endAt?: Date;
      statusCode?: string;
      terminationCheckOutDeadline?: Date | null;
      deletedAt?: Date | null;
    } = {},
  ) {
    sequence += 1;
    const startAt = options.startAt ?? FUTURE_START;
    const endAt = options.endAt ?? FUTURE_END;
    return await prisma.activitySession.create({
      data: {
        activityId,
        code: `s-${sequence}`,
        name: `第三刀场次 ${sequence}`,
        startAt,
        endAt,
        locationText: '深圳集合点',
        capacity: 12,
        checkInOpenAt: new Date(startAt.getTime() - 30 * 60_000),
        checkInCloseAt: new Date(startAt.getTime() + 30 * 60_000),
        checkOutOpenAt: new Date(endAt.getTime() - 60 * 60_000),
        checkOutCloseAt: new Date(endAt.getTime() + 30 * 60_000),
        locationRequired: false,
        radiusMeters: null,
        locationPolicySourceCode: 'session',
        statusCode: options.statusCode ?? 'scheduled',
        terminationCheckOutDeadline: options.terminationCheckOutDeadline ?? null,
        deletedAt: options.deletedAt ?? null,
        sortOrder: sequence,
      },
      select: { id: true },
    });
  }

  async function createSessionPosition(
    activityId: string,
    sessionId: string,
    leaderMemberId: string | null = null,
  ) {
    sequence += 1;
    return await prisma.activitySessionPosition.create({
      data: {
        activityId,
        sessionId,
        code: `p-${sequence}`,
        name: `第三刀岗位 ${sequence}`,
        attendanceRoleCode,
        capacity: 4,
        startAt: FUTURE_START,
        endAt: FUTURE_END,
        locationRequired: false,
        radiusMeters: null,
        leaderMemberId,
        description: '配置复制应保留的岗位说明',
        equipmentNotes: '反光背心',
        sortOrder: sequence,
      },
      select: { id: true },
    });
  }

  const managedPath = (activityId: string, action: string) =>
    `/api/app/v1/my/managed-activities/${activityId}/${action}`;

  function cancel(
    activityId: string,
    auth: string,
    body: { reason?: string; strongConfirmed?: boolean; operationKey?: string },
  ) {
    return request(httpServer(app))
      .post(managedPath(activityId, 'cancel'))
      .set('Authorization', auth)
      .send(body);
  }

  function terminate(
    activityId: string,
    auth: string,
    body: { reason?: string; operationKey?: string },
  ) {
    return request(httpServer(app))
      .post(managedPath(activityId, 'terminate'))
      .set('Authorization', auth)
      .send(body);
  }

  async function databaseNow(): Promise<Date> {
    const rows = await prisma.$queryRaw<Array<{ authoritativeNow: Date }>>`
      SELECT now() AS "authoritativeNow"
    `;
    const authoritativeNow = rows[0]?.authoritativeNow;
    if (!authoritativeNow) {
      throw new Error('database clock query returned no value');
    }
    return authoritativeNow;
  }

  // ===== 1. cancel / terminate: 白名单时间闸 + 两套独立幂等三元组 =====

  it('red-first: exposes the new member directory root rather than shadowing the existing detail route', async () => {
    const viewer = await createMember('red-directory');
    const response = await request(httpServer(app))
      .get('/api/app/v1/activities?page=1&pageSize=10')
      .set('Authorization', viewer.auth);

    // 实现前这里是 HTTP 404；这条红测首先证明根列表是真新增 route。
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(
      expect.objectContaining({ items: expect.any(Array), page: 1, pageSize: 10 }),
    );
  });

  it('cancels only an unstarted draft/published activity, persists its own idempotency triple, and replays exactly', async () => {
    const initiator = await createMember('cancel-initiator');
    const activity = await createActivity({
      title: '未开始草稿取消',
      initiatorMemberId: initiator.memberId,
      startAt: FUTURE_START,
      endAt: FUTURE_END,
    });
    await createSession(activity.id, { startAt: FUTURE_START, endAt: FUTURE_END });

    expectBizError(
      await cancel(activity.id, initiator.auth, {
        reason: '未强确认不得取消',
        strongConfirmed: false,
        operationKey: 'b3-s3-cancel-needs-strong-confirmation',
      }),
      BizCode.BAD_REQUEST,
    );

    const first = await cancel(activity.id, initiator.auth, {
      reason: '台风预警',
      strongConfirmed: true,
      operationKey: 'b3-s3-cancel-replay-key',
    });
    expect(first.status).toBe(200);
    const replay = await cancel(activity.id, initiator.auth, {
      reason: '台风预警',
      strongConfirmed: true,
      operationKey: 'b3-s3-cancel-replay-key',
    });
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);

    await expect(
      prisma.activity.findUniqueOrThrow({
        where: { id: activity.id },
        select: {
          statusCode: true,
          cancelledAt: true,
          cancelledBy: true,
          cancelReason: true,
          cancelOperationKey: true,
          cancelRequestHash: true,
          terminateOperationKey: true,
          terminateRequestHash: true,
        },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        statusCode: 'cancelled',
        cancelledBy: initiator.userId,
        cancelReason: '台风预警',
        cancelOperationKey: 'b3-s3-cancel-replay-key',
        cancelRequestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        terminateOperationKey: null,
        terminateRequestHash: null,
      }),
    );

    // 同 key 异 payload 必须在终态闸之前冲突，不能被 cancelled 误吞成普通状态错误。
    const conflict = await cancel(activity.id, initiator.auth, {
      reason: '改了原因',
      strongConfirmed: true,
      operationKey: 'b3-s3-cancel-replay-key',
    });
    expectBizError(conflict, BizCode.ACTIVITY_LIFECYCLE_OPERATION_KEY_CONFLICT);

    // draft 与 published 都在状态白名单内；第二条只翻转起态，仍必须在首场前放行。
    const published = await createActivity({
      title: '未开始已发布取消',
      statusCode: 'published',
      initiatorMemberId: initiator.memberId,
      startAt: FUTURE_START,
      endAt: FUTURE_END,
    });
    await assignOwner(published.id, initiator);
    await createSession(published.id, { startAt: FUTURE_START, endAt: FUTURE_END });
    expect(
      (
        await cancel(published.id, initiator.auth, {
          reason: '发布后开场前取消',
          strongConfirmed: true,
          operationKey: 'b3-s3-cancel-published-before-start',
        })
      ).status,
    ).toBe(200);
  });

  it('keeps cancel and terminate time/status red sets disjoint and allows the two operation-key columns to be independent', async () => {
    const owner = await createMember('lifecycle-owner');
    const startedPublished = await createActivity({
      title: '已开始不能取消',
      statusCode: 'published',
      initiatorMemberId: owner.memberId,
      startAt: PAST_START,
      endAt: PAST_END,
    });
    await assignOwner(startedPublished.id, owner);
    await createSession(startedPublished.id, { startAt: PAST_START, endAt: PAST_END });
    expectBizError(
      await cancel(startedPublished.id, owner.auth, {
        reason: '已经开始',
        strongConfirmed: true,
        operationKey: 'b3-s3-cancel-started',
      }),
      BizCode.ACTIVITY_STATUS_INVALID,
    );

    const unstartedPublished = await createActivity({
      title: '未开始不能终止',
      statusCode: 'published',
      initiatorMemberId: owner.memberId,
      startAt: FUTURE_START,
      endAt: FUTURE_END,
    });
    await assignOwner(unstartedPublished.id, owner);
    await createSession(unstartedPublished.id, { startAt: FUTURE_START, endAt: FUTURE_END });
    expectBizError(
      await terminate(unstartedPublished.id, owner.auth, {
        reason: '还没开始',
        operationKey: 'b3-s3-terminate-unstarted',
      }),
      BizCode.ACTIVITY_STATUS_INVALID,
    );

    for (const statusCode of ['cancelled', 'terminated', 'completed']) {
      const terminal = await createActivity({
        title: `终态 ${statusCode}`,
        statusCode,
        initiatorMemberId: owner.memberId,
        startAt: PAST_START,
        endAt: PAST_END,
      });
      await assignOwner(terminal.id, owner);
      await createSession(terminal.id, { startAt: PAST_START, endAt: PAST_END });
      expectBizError(
        await cancel(terminal.id, owner.auth, {
          reason: '终态不能取消',
          strongConfirmed: true,
          operationKey: `b3-s3-cancel-terminal-${statusCode}`,
        }),
        BizCode.ACTIVITY_STATUS_INVALID,
      );
      expectBizError(
        await terminate(terminal.id, owner.auth, {
          reason: '终态不能终止',
          operationKey: `b3-s3-terminate-terminal-${statusCode}`,
        }),
        BizCode.ACTIVITY_STATUS_INVALID,
      );
    }

    const cancelActivity = await createActivity({
      title: '取消列独立',
      initiatorMemberId: owner.memberId,
      startAt: FUTURE_START,
      endAt: FUTURE_END,
    });
    await createSession(cancelActivity.id, { startAt: FUTURE_START, endAt: FUTURE_END });
    const terminateActivity = await createActivity({
      title: '终止列独立',
      statusCode: 'published',
      initiatorMemberId: owner.memberId,
      startAt: PAST_START,
      endAt: PAST_END,
    });
    await assignOwner(terminateActivity.id, owner);
    await createSession(terminateActivity.id, { startAt: PAST_START, endAt: PAST_END });

    const sharedKey = 'b3-s3-action-columns-are-independent';
    expect(
      (
        await cancel(cancelActivity.id, owner.auth, {
          reason: '取消独立列',
          strongConfirmed: true,
          operationKey: sharedKey,
        })
      ).status,
    ).toBe(200);
    const beforeTerminate = await databaseNow();
    const terminated = await terminate(terminateActivity.id, owner.auth, {
      reason: '提前收场',
      operationKey: sharedKey,
    });
    const afterTerminate = await databaseNow();
    expect(terminated.status).toBe(200);
    const terminatedRow = await prisma.activity.findUniqueOrThrow({
      where: { id: terminateActivity.id },
      select: {
        statusCode: true,
        terminatedAt: true,
        terminatedByUserId: true,
        terminationReason: true,
        terminateOperationKey: true,
        terminateRequestHash: true,
        cancelOperationKey: true,
      },
    });
    expect(terminatedRow).toEqual(
      expect.objectContaining({
        statusCode: 'terminated',
        terminatedByUserId: owner.userId,
        terminationReason: '提前收场',
        terminateOperationKey: sharedKey,
        terminateRequestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        cancelOperationKey: null,
      }),
    );
    expect(terminatedRow.terminatedAt).toBeInstanceOf(Date);
    expect(terminatedRow.terminatedAt!.getTime()).toBeGreaterThanOrEqual(beforeTerminate.getTime());
    expect(terminatedRow.terminatedAt!.getTime()).toBeLessThanOrEqual(afterTerminate.getTime());

    const terminateReplay = await terminate(terminateActivity.id, owner.auth, {
      reason: '提前收场',
      operationKey: sharedKey,
    });
    expect(terminateReplay.status).toBe(200);
    expect(terminateReplay.body.data).toEqual(terminated.body.data);
    const terminateConflict = await terminate(terminateActivity.id, owner.auth, {
      reason: '改了终止原因',
      operationKey: sharedKey,
    });
    expectBizError(terminateConflict, BizCode.ACTIVITY_LIFECYCLE_OPERATION_KEY_CONFLICT);
  });

  it('AC-015 persists a 30-minute termination checkout deadline and revokes only unfinished check-in QR credentials', async () => {
    const owner = await createMember('termination-window-owner');
    const now = await databaseNow();
    const activity = await createActivity({
      title: '提前终止后的三十分钟签退窗口',
      statusCode: 'published',
      initiatorMemberId: owner.memberId,
      startAt: new Date(now.getTime() - 2 * 60 * 60_000),
      endAt: new Date(now.getTime() + 4 * 60 * 60_000),
    });
    await assignOwner(activity.id, owner);
    const live = await createSession(activity.id, {
      startAt: new Date(now.getTime() - 60 * 60_000),
      endAt: new Date(now.getTime() + 2 * 60 * 60_000),
    });
    const future = await createSession(activity.id, {
      startAt: new Date(now.getTime() + 60 * 60_000),
      endAt: new Date(now.getTime() + 3 * 60 * 60_000),
    });
    const finished = await createSession(activity.id, {
      startAt: new Date(now.getTime() - 4 * 60 * 60_000),
      endAt: new Date(now.getTime() - 3 * 60 * 60_000),
    });
    const sessions = await prisma.activitySession.findMany({
      where: { id: { in: [live.id, future.id, finished.id] } },
      select: {
        id: true,
        checkInOpenAt: true,
        checkInCloseAt: true,
        checkOutOpenAt: true,
        checkOutCloseAt: true,
      },
    });
    await prisma.attendanceQrCredential.createMany({
      data: sessions.flatMap((session) =>
        (['check_in', 'check_out'] as const).map((actionCode) => ({
          activityId: activity.id,
          sessionId: session.id,
          actionCode,
          credentialVersion: 1,
          statusCode: 'active',
          tokenDigest: 'a'.repeat(64),
          signingKeyVersion: 0,
          validFrom: actionCode === 'check_in' ? session.checkInOpenAt : session.checkOutOpenAt,
          validUntil: actionCode === 'check_in' ? session.checkInCloseAt : session.checkOutCloseAt,
          issuedByUserId: owner.userId,
          issuedAt: now,
        })),
      ),
    });

    const response = await terminate(activity.id, owner.auth, {
      reason: '雷暴提前收场',
      operationKey: `b3-s3-termination-window-${++sequence}`,
    });
    expect(response.status).toBe(200);
    const terminatedAt = new Date(response.body.data.occurredAt as string);
    const expectedDeadline = new Date(terminatedAt.getTime() + 30 * 60_000);
    const sessionRows = await prisma.activitySession.findMany({
      where: { id: { in: [live.id, future.id, finished.id] } },
      select: { id: true, terminationCheckOutDeadline: true },
      orderBy: { id: 'asc' },
    });
    expect(
      sessionRows.find((session) => session.id === live.id)?.terminationCheckOutDeadline,
    ).toEqual(expectedDeadline);
    expect(
      sessionRows.find((session) => session.id === future.id)?.terminationCheckOutDeadline,
    ).toEqual(expectedDeadline);
    expect(
      sessionRows.find((session) => session.id === finished.id)?.terminationCheckOutDeadline,
    ).toBeNull();

    const credentialRows = await prisma.attendanceQrCredential.findMany({
      where: { activityId: activity.id },
      select: {
        sessionId: true,
        actionCode: true,
        statusCode: true,
        revokedAt: true,
        revokedByUserId: true,
      },
    });
    for (const sessionId of [live.id, future.id]) {
      expect(credentialRows).toContainEqual(
        expect.objectContaining({
          sessionId,
          actionCode: 'check_in',
          statusCode: 'revoked',
          revokedAt: terminatedAt,
          revokedByUserId: owner.userId,
        }),
      );
      expect(credentialRows).toContainEqual(
        expect.objectContaining({
          sessionId,
          actionCode: 'check_out',
          statusCode: 'active',
          revokedAt: null,
        }),
      );
    }
    expect(credentialRows).toContainEqual(
      expect.objectContaining({
        sessionId: finished.id,
        actionCode: 'check_in',
        statusCode: 'active',
      }),
    );
  });

  // ===== 1bis ⭐ AC-014(2026-08 验收补写)=====
  //
  // 合同原句:「活动存在**有效**现场事实时普通取消被拒绝,必须**改走提前终止并结算**。」
  //
  // 第 5 批已交付「有现场事实 ⇒ 普通取消被拒」并有 App / Admin 两个真用例;本条补的是余下三格:
  //   ①「**有效**」这个限定 —— 已被 void 掉的事实**不得**继续拦着取消。
  //      此前只有纯函数单测(`settlement-segment-projector.spec.ts` 的 `resolveEffectiveFacts`),
  //      **HTTP 层零证据**;而这正是最容易悄悄退化的一格:把 `resolveEffectiveFacts` 换成
  //      `punchEvents.length > 0` 会让功能"更严",没有任何既有用例会红。
  //   ②「必须改走提前终止」—— 此前 `/terminate` 只在**没有任何打卡**的活动上被测过,
  //      「取消被拒 → 同一条活动 terminate 成功」这条链全仓零覆盖。
  //   ③「并结算」—— 终止之后结算真相链能不能开始,此前无人验。
  //
  // ⚠️ 夹具必须让场次**在未来**:取消的时间闸(`now < firstSessionStart`)因此是开着的,
  //    20030 只可能来自事实闸。若图省事直接用过去的场次,拒绝码一模一样,
  //    但测到的是时间闸 —— 上层边界把下层边界遮住,断言看着还在、测的已不是同一件事。
  //    而 terminate 的时间闸恰恰相反(`now >= firstSessionStart`),两闸互斥,
  //    所以链的第二步之前要把这条活动的时刻整体挪到过去(DB `now()` 为准,改不了钟只能改数据)。
  it('AC-014 有效现场事实拦住普通取消；作废那条事实后可取消；同一条活动的正路是终止并进结算链', async () => {
    const owner = await createMember('ac014-owner');

    /** 建一条**未来**场次的已发布活动;`withPunch` 时连身份、打卡与已闭合服务段一起建。 */
    async function createFutureActivity(label: string, withPunch: boolean) {
      const activity = await createActivity({
        title: `AC-014 ${label}`,
        statusCode: 'published',
        initiatorMemberId: owner.memberId,
        startAt: FUTURE_START,
        endAt: FUTURE_END,
      });
      await assignOwner(activity.id, owner);
      const session = await createSession(activity.id, {
        startAt: FUTURE_START,
        endAt: FUTURE_END,
      });
      if (!withPunch) return { activityId: activity.id, sessionId: session.id, checkInId: null };
      // ⚠️ 打卡过的人必须是一份**自洽的 canonical 报名**:取消链会把这条活动上
      //    所有未软删的报名整份锁下来逐层对账(报名头 ↔ 报名修订 ↔ 身份 ↔ 身份修订 ↔
      //    容量桶 ↔ 预留),任何一层缺失都先 fail-closed 成 20147,把本条真正要测的
      //    「事实闸」整片遮住 —— 就是本 spec 反复吃过的「上层边界遮蔽下层边界」。
      //    所以这里按真实形状建齐,而不是塞一条最小报名行。
      const registration = await prisma.activityRegistration.create({
        data: {
          activityId: activity.id,
          memberId: owner.memberId,
          statusCode: 'pass',
          statusSummaryCode: 'active',
          currentRevision: 1,
        },
        select: { id: true },
      });
      await prisma.activityRegistrationRevision.create({
        data: {
          registrationId: registration.id,
          revision: 1,
          sourceCode: 'admin',
          submittedByUserId: owner.userId,
          submittedAt: PAST_START,
        },
      });
      const identity = await prisma.activityParticipationIdentity.create({
        data: {
          activityId: activity.id,
          sessionId: session.id,
          registrationId: registration.id,
          memberId: owner.memberId,
          currentRevision: 1,
          currentStatusCode: 'pass',
          populationIncluded: true,
        },
        select: { id: true },
      });
      await prisma.activityParticipationRevision.create({
        data: {
          identityId: identity.id,
          revision: 1,
          statusCode: 'pass',
          effectiveAt: PAST_START,
          createdByUserId: owner.userId,
          sourceCode: 'admin',
        },
      });
      sequence += 1;
      const checkIn = await prisma.attendancePunchEvent.create({
        data: {
          activityId: activity.id,
          sessionId: session.id,
          participationIdentityId: identity.id,
          memberId: owner.memberId,
          eventTypeCode: 'check_in',
          sourceCode: 'staff_scan',
          // ⚠️ 打卡时刻取**过去**:打卡事件在 DB 上是 append-only(触发器直接拒绝 UPDATE,
          //    实测报 `attendance punch event is append-only`),事后改不了。而**场次仍在未来**
          //    ⇒ 取消的时间闸依旧开着,②那条 20030 只可能来自事实闸。
          occurredAt: PAST_START,
          receivedAt: PAST_START,
          operatorUserId: owner.userId,
          eventKey: `ac014-in-${sequence}`,
          requestHash: `ac014-in-hash-${sequence}`,
          evidenceRevision: 0,
        },
        select: { id: true },
      });
      await prisma.participantServiceSegmentRevision.create({
        data: {
          participationIdentityId: identity.id,
          segmentKey: `ac014-segment-${sequence}`,
          revision: 0,
          sourceCheckInEventId: checkIn.id,
          resultCode: 'valid',
          statusCode: 'draft',
          checkInAt: PAST_START,
          checkOutAt: PAST_END,
        },
      });
      // ⚠️ 一个 `pass` 身份必须配一份**自洽**的容量事实,否则取消链会先在容量对账上
      //    fail-closed(20147),把本条真正要测的"事实闸"整片遮住 —— 那正是本 spec
      //    反复吃过的「上层边界遮蔽下层边界」。这里按三层预留的真实形状建齐:
      //    活动位一份(带 member/activity 锚)+ 场次位一份,桶的 occupied 与在册预留数相等。
      const activityBucket = await prisma.activityCapacityBucket.create({
        data: {
          activityId: activity.id,
          scopeTypeCode: 'activity_person',
          scopeId: activity.id,
          capacity: 20,
          occupied: 1,
          version: 1,
        },
        select: { id: true },
      });
      const sessionBucket = await prisma.activityCapacityBucket.create({
        data: {
          activityId: activity.id,
          scopeTypeCode: 'session_participation',
          scopeId: session.id,
          capacity: 12,
          occupied: 1,
          version: 1,
        },
        select: { id: true },
      });
      await prisma.capacityReservation.create({
        data: {
          identityId: identity.id,
          bucketId: activityBucket.id,
          reservationType: 'activity_person',
          memberId: owner.memberId,
          activityId: activity.id,
          status: 'active',
        },
      });
      const sessionReservation = await prisma.capacityReservation.create({
        data: {
          identityId: identity.id,
          bucketId: sessionBucket.id,
          reservationType: 'session_participation',
          status: 'active',
        },
        select: { id: true },
      });
      await prisma.activityParticipationIdentity.update({
        where: { id: identity.id },
        data: { capacityReservationId: sessionReservation.id },
      });
      return { activityId: activity.id, sessionId: session.id, checkInId: checkIn.id };
    }

    /** 200 或具名拒绝码 —— 直接断言状态码时,红了只看得到"409",看不出是哪道闸。 */
    const outcomeOf = (response: { status: number; body?: { code?: number } }): unknown =>
      response.status === 200 ? 200 : { 拒绝码: response.body?.code };

    const statusOf = async (activityId: string): Promise<string> =>
      (
        await prisma.activity.findUniqueOrThrow({
          where: { id: activityId },
          select: { statusCode: true },
        })
      ).statusCode;

    // ① 正向对照:同样形态、**零打卡** ⇒ 取消成功。
    //    没有这一格,下面那条 20030 可能来自任何别的闸(权限 / 状态机 / 时间)。
    const clean = await createFutureActivity('零打卡对照', false);
    expect(
      (
        await cancel(clean.activityId, owner.auth, {
          reason: '零现场事实,普通取消应当放行',
          strongConfirmed: true,
          operationKey: 'ac014-clean-cancel',
        })
      ).status,
    ).toBe(200);
    await expect(statusOf(clean.activityId)).resolves.toBe('cancelled');

    // ② 反向:有一条有效签到 ⇒ 普通取消被拒,且活动**零副作用**(仍是 published)。
    const withFact = await createFutureActivity('有有效现场事实', true);
    expectBizError(
      await cancel(withFact.activityId, owner.auth, {
        reason: '有现场事实还想普通取消',
        strongConfirmed: true,
        operationKey: 'ac014-fact-cancel',
      }),
      BizCode.ACTIVITY_STATUS_INVALID,
    );
    await expect(statusOf(withFact.activityId)).resolves.toBe('published');

    // ③ ⭐「**有效**」这个限定的 HTTP 证据:同样一条签到,补一条 void 指向它 ⇒ 取消放行。
    //    ⚠️ 被作废的是"有效性"不是"存在" —— 打卡行仍在库里(全仓禁硬删),
    //    所以同时回读事件行数,证明放行不是因为把证据删了。
    const voided = await createFutureActivity('事实已被作废', true);
    sequence += 1;
    await prisma.attendancePunchEvent.create({
      data: {
        activityId: voided.activityId,
        sessionId: voided.sessionId,
        participationIdentityId: (
          await prisma.attendancePunchEvent.findUniqueOrThrow({
            where: { id: voided.checkInId as string },
            select: { participationIdentityId: true },
          })
        ).participationIdentityId,
        memberId: owner.memberId,
        eventTypeCode: 'void',
        sourceCode: 'staff_scan',
        occurredAt: PAST_START,
        receivedAt: PAST_START,
        operatorUserId: owner.userId,
        reason: '误扫,作废这条签到',
        eventKey: `ac014-void-${sequence}`,
        requestHash: `ac014-void-hash-${sequence}`,
        supersedesEventId: voided.checkInId,
        evidenceRevision: 1,
      },
    });
    expect(
      outcomeOf(
        await cancel(voided.activityId, owner.auth, {
          reason: '现场事实已作废,普通取消应当放行',
          strongConfirmed: true,
          operationKey: 'ac014-voided-cancel',
        }),
      ),
    ).toStrictEqual(200);
    await expect(statusOf(voided.activityId)).resolves.toBe('cancelled');
    await expect(
      prisma.attendancePunchEvent.count({ where: { activityId: voided.activityId } }),
    ).resolves.toBe(2);

    // ④「必须改走提前终止」—— 回到 ② 那条**同一活动**。
    //    两个时间闸互斥且读 DB `now()`,故先把这条活动的时刻整体挪到过去。
    await prisma.activity.update({
      where: { id: withFact.activityId },
      data: { startAt: PAST_START, endAt: PAST_END },
    });
    await prisma.activitySession.update({
      where: { id: withFact.sessionId },
      data: {
        startAt: PAST_START,
        endAt: PAST_END,
        checkInOpenAt: new Date(PAST_START.getTime() - 30 * 60_000),
        checkInCloseAt: new Date(PAST_START.getTime() + 30 * 60_000),
        checkOutOpenAt: new Date(PAST_END.getTime() - 60 * 60_000),
        checkOutCloseAt: new Date(PAST_END.getTime() + 30 * 60_000),
      },
    });
    const terminated = await terminate(withFact.activityId, owner.auth, {
      reason: '有现场事实,按合同改走提前终止',
      operationKey: 'ac014-terminate',
    });
    expect(terminated.status).toBe(200);
    await expect(statusOf(withFact.activityId)).resolves.toBe('terminated');

    // ⑤「并结算」—— 终止之后结算真相链的第一步(封场)接受这条活动。
    //    ⚠️ 口径:这一格证明的是"终止之后结算能**开始**",不是整条结算链走通
    //    (那由 settlement 族 spec 覆盖)。终止会把签退截止设在 now+30min,
    //    先把它挪到过去,否则会撞上另一道具名闸 EVIDENCE_SEAL_CHECKOUT_WINDOW_OPEN。
    await prisma.activitySession.update({
      where: { id: withFact.sessionId },
      data: { terminationCheckOutDeadline: PAST_END },
    });
    const sealed = await request(httpServer(app))
      .post(managedPath(withFact.activityId, 'evidence-seals'))
      .set('Authorization', owner.auth)
      .send({});
    expect(sealed.status).toBe(200);
    expect(sealed.body.data).toEqual(
      expect.objectContaining({
        activityId: withFact.activityId,
        sealRevision: 1,
        openSegmentCount: 0,
      }),
    );
  });

  // ===== 2. clone：只能复制配置，事实表实际 delegate 写次数必须为零 =====

  const WRITE_METHODS = new Set([
    'create',
    'createMany',
    'delete',
    'deleteMany',
    'update',
    'updateMany',
    'upsert',
  ]);
  // ⭐ 2026-08 验收补写(AC-003):合同点名九类历史 ——
  //    报名 / 邀请 / 二维码 / 打卡 / 结算 / 账本 / 关闭 / 更正 / 通知。
  //    原集合 11 个 delegate **只覆盖其中四类**(报名 / 打卡 / 结算 / 账本各一张表),
  //    邀请 / 二维码 / 关闭 / 更正 / 通知**整整五类零观察**。
  //    ⚠️ 本次**只增不减**(11 → 24):被观察的面变宽 = 判据更严,既有断言一字未改。
  //    正对照(本 describe 末尾那条 `positive.factWrites === 1`)保证这个 spy 真的会响。
  const FACT_DELEGATES = new Set([
    // 报名
    'activityRegistration',
    'registrationUploadSession',
    'activityVisitor',
    // 邀请
    'activityInvitation',
    // 二维码
    'attendanceQrCredential',
    // 打卡
    'activityCheckIn',
    'attendanceSheet',
    'activityParticipationIdentity',
    'activityParticipationRevision',
    'attendancePunchEvent',
    'participantServiceSegmentRevision',
    // 结算
    'attendanceSettlementRun',
    'attendanceSettlementVersion',
    'participantSettlementResultRevision',
    // 账本
    'participationLedgerEntry',
    'ledgerPostingBatch',
    // 关闭
    'activitySettlementClosureRevision',
    // 更正
    'attendanceCorrectionRequest',
    'correctionApplication',
    // 通知
    'notification',
    'notificationDelivery',
    'notificationOutboxIntent',
    // 责任 / 封场(原集合已有)
    'activityResponsibilityAssignment',
    'evidenceSeal',
  ]);

  function observeCloneFactWrites(
    tx: Prisma.TransactionClient,
    onFactWrite: () => void,
  ): Prisma.TransactionClient {
    return new Proxy(tx, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof property !== 'string' || !FACT_DELEGATES.has(property)) {
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return new Proxy(value as object, {
          get(delegate, method, delegateReceiver) {
            const methodValue = Reflect.get(delegate, method, delegateReceiver);
            if (typeof method === 'string' && WRITE_METHODS.has(method)) {
              return (...args: unknown[]) => {
                onFactWrite();
                return Reflect.apply(
                  methodValue as (...callArgs: unknown[]) => unknown,
                  delegate,
                  args,
                );
              };
            }
            return typeof methodValue === 'function' ? methodValue.bind(delegate) : methodValue;
          },
        });
      },
    });
  }

  async function countCloneFactWrites<T>(operation: () => Promise<T>) {
    type TransactionInvoker = <Result>(
      callback: (tx: Prisma.TransactionClient) => Promise<Result>,
      options?: unknown,
    ) => Promise<Result>;
    const holder = prisma as unknown as { $transaction: TransactionInvoker };
    const original = holder.$transaction;
    const invokeOriginal = original.bind(prisma);
    let factWrites = 0;
    holder.$transaction = async <Result>(
      callback: (tx: Prisma.TransactionClient) => Promise<Result>,
      options?: unknown,
    ): Promise<Result> =>
      await invokeOriginal(
        async (tx) => callback(observeCloneFactWrites(tx, () => (factWrites += 1))),
        options,
      );
    try {
      return { result: await operation(), factWrites };
    } finally {
      holder.$transaction = original;
    }
  }

  it('clones only live Activity / ActivitySession / ActivitySessionPosition configuration into a new draft', async () => {
    const owner = await createMember('clone-owner');
    const source = await createActivity({
      title: '配置源活动',
      statusCode: 'published',
      initiatorMemberId: owner.memberId,
      registrationModeCode: 'invitation_only',
      visibilityCode: 'invitation',
    });
    await assignOwner(source.id, owner);
    const session = await createSession(source.id, {
      statusCode: 'terminated',
      terminationCheckOutDeadline: new Date('2099-10-01T06:00:00.000Z'),
    });
    await createSessionPosition(source.id, session.id, owner.memberId);
    const removedSession = await createSession(source.id, {
      deletedAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    await createSessionPosition(source.id, removedSession.id, owner.memberId);
    await prisma.activityRegistration.create({
      data: {
        activityId: source.id,
        memberId: owner.memberId,
        statusCode: 'approved',
      },
    });

    const observed = await countCloneFactWrites(
      async () =>
        await request(httpServer(app))
          .post(managedPath(source.id, 'clone'))
          .set('Authorization', owner.auth)
          .send({ title: '配置副本' }),
    );
    expect(observed.result.status).toBe(201);
    expect(observed.factWrites).toBe(0);
    const cloneId = observed.result.body.data.activityId as string;
    expect(cloneId).toEqual(expect.any(String));
    expect(cloneId).not.toBe(source.id);

    await expect(
      prisma.activity.findUniqueOrThrow({
        where: { id: cloneId },
        select: {
          title: true,
          statusCode: true,
          initiatorMemberId: true,
          registrationModeCode: true,
          visibilityCode: true,
          cancelOperationKey: true,
          cancelRequestHash: true,
          terminateOperationKey: true,
          terminateRequestHash: true,
        },
      }),
    ).resolves.toEqual({
      title: '配置副本',
      statusCode: 'draft',
      initiatorMemberId: owner.memberId,
      registrationModeCode: 'invitation_only',
      visibilityCode: 'invitation',
      cancelOperationKey: null,
      cancelRequestHash: null,
      terminateOperationKey: null,
      terminateRequestHash: null,
    });
    await expect(
      prisma.activitySession.findMany({
        where: { activityId: cloneId },
        select: { statusCode: true, terminationCheckOutDeadline: true },
      }),
    ).resolves.toEqual([{ statusCode: 'scheduled', terminationCheckOutDeadline: null }]);
    await expect(
      prisma.activitySessionPosition.findMany({
        where: { activityId: cloneId },
        select: { leaderMemberId: true, qualificationRuleSetId: true, description: true },
      }),
    ).resolves.toEqual([
      {
        leaderMemberId: null,
        qualificationRuleSetId: null,
        description: '配置复制应保留的岗位说明',
      },
    ]);
    await expect(
      prisma.activityRegistration.count({ where: { activityId: cloneId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.activityResponsibilityAssignment.count({ where: { activityId: cloneId } }),
    ).resolves.toBe(0);

    // #15 已登记而未建存储列：DTO 必须直接拒绝 operationKey，不能默默收下却无法重放。
    expectBizError(
      await request(httpServer(app))
        .post(managedPath(source.id, 'clone'))
        .set('Authorization', owner.auth)
        .send({ operationKey: 'b3-s3-clone-key-must-not-be-accepted' }),
      BizCode.BAD_REQUEST,
      { strictMessage: false },
    );

    // 正对照：spy 必须能真实捕捉到事实表 delegate 写，否则“零写”没有证明力。
    const positive = await countCloneFactWrites(
      async () =>
        await prisma.$transaction(async (tx) => {
          await tx.activityRegistration.updateMany({
            where: { activityId: 'b3-s3-fact-write-positive-control' },
            data: { statusCode: 'approved' },
          });
        }),
    );
    expect(positive.factWrites).toBe(1);
  });

  // ===== 2bis ⭐ AC-003(2026-08 验收补写)=====
  //
  // 合同原句:「复制旧活动只生成全新草稿,**绝不复制报名、邀请、二维码、打卡、结算、
  //           账本、关闭、更正和通知历史**。」
  //
  // 🔴 上面那条既有用例只在源活动上建了**一条报名**;九类里另外八类源侧一行都没有 ⇒
  //    "克隆件上是 0" 对它们而言是**恒真**的(什么都没有,当然复制不出来)。
  //    本条把九类历史在源活动上**逐类真的建出来**,再断言克隆件上逐类恰 0 ——
  //    这才是"绝不复制"的非恒真证据。
  //
  // 三层判据:
  //   ① 正向(判据非恒真)—— 源活动上九类逐类 ≥ 1 行,先断言这一格;
  //   ② 反向 —— 克隆件上九类逐类恰 0 行;
  //   ③ 结构 —— 整个 clone 事务里**事实表 delegate 写次数 = 0**(spy 面已扩到 18 个 delegate),
  //      它守的是"以后有人往 clone 里加一句 `tx.activityInvitation.createMany(...)`"这种改动;
  //      同一条里还钉住 spy 面自己不许塌(每个名字都必须是 Prisma client 上真实存在的 delegate)。
  it('AC-003 九类历史在源活动上逐类真实存在，克隆件上逐类恰零行且 clone 事务零事实写', async () => {
    const owner = await createMember('ac003-owner');
    const source = await createActivity({
      title: 'AC-003 九类历史源活动',
      statusCode: 'published',
      startAt: PAST_START,
      endAt: PAST_END,
      initiatorMemberId: owner.memberId,
    });
    await assignOwner(source.id, owner);
    const session = await createSession(source.id, { startAt: PAST_START, endAt: PAST_END });

    // ---- 报名 ----
    const registration = await prisma.activityRegistration.create({
      data: { activityId: source.id, memberId: owner.memberId, statusCode: 'approved' },
      select: { id: true },
    });
    // ---- 邀请 ----
    await prisma.activityInvitation.create({
      data: {
        activityId: source.id,
        memberId: owner.memberId,
        statusCode: 'pending',
        expiresAt: new Date('2099-12-31T00:00:00.000Z'),
      },
    });
    // ---- 二维码 ----
    await prisma.attendanceQrCredential.create({
      data: {
        activityId: source.id,
        sessionId: session.id,
        actionCode: 'check_in',
        credentialVersion: 1,
        statusCode: 'active',
        tokenDigest: 'ac003-token-digest',
        signingKeyVersion: 1,
        validFrom: PAST_START,
        validUntil: PAST_END,
        issuedAt: PAST_START,
      },
    });
    // ---- 打卡(身份 + 打卡事件)----
    const identity = await prisma.activityParticipationIdentity.create({
      data: {
        activityId: source.id,
        sessionId: session.id,
        registrationId: registration.id,
        memberId: owner.memberId,
        currentStatusCode: 'pass',
        populationIncluded: true,
      },
      select: { id: true },
    });
    await prisma.attendancePunchEvent.create({
      data: {
        activityId: source.id,
        sessionId: session.id,
        participationIdentityId: identity.id,
        memberId: owner.memberId,
        eventTypeCode: 'check_in',
        sourceCode: 'self_qr',
        occurredAt: PAST_START,
        receivedAt: PAST_START,
        operatorUserId: owner.userId,
        eventKey: 'ac003-in',
        requestHash: 'ac003-in-hash',
        evidenceRevision: 0,
      },
    });
    // ---- 结算(封场 → run → version → 结果行)----
    const seal = await prisma.evidenceSeal.create({
      data: {
        activityId: source.id,
        sealRevision: 1,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        allWindowsClosedAt: PAST_END,
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: 1,
        populationCountBySession: {},
        contentHash: 'ac003-seal-hash',
        statusCode: 'active',
        sealedByUserId: owner.userId,
        sealedAt: PAST_END,
      },
      select: { id: true },
    });
    const run = await prisma.attendanceSettlementRun.create({
      data: {
        activityId: source.id,
        statusCode: 'closed',
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
        contentHash: 'ac003-content-hash',
        personCount: 1,
        sessionParticipationCount: 1,
        serviceSegmentCount: 1,
        createdByUserId: owner.userId,
        submittedAt: PAST_END,
        statusCode: 'approved',
        operationKey: 'ac003-submit-key',
        requestHash: 'ac003-submit-hash',
      },
      select: { id: true },
    });
    const resultRevision = await prisma.participantSettlementResultRevision.create({
      data: {
        settlementVersionId: version.id,
        participationIdentityId: identity.id,
        revision: 0,
        resultCode: 'present',
        recognizedServiceHours: 2,
        recognizedContributionPoints: 1,
        calculatedServiceHours: 2,
        calculatedContributionPoints: 1,
        statusCode: 'committed',
      },
      select: { id: true },
    });
    // ---- 账本(批次 + 分录)----
    const batch = await prisma.ledgerPostingBatch.create({
      data: {
        settlementRunId: run.id,
        settlementVersionId: version.id,
        batchRevision: 1,
        statusCode: 'committed',
        requestKey: 'ac003-batch-key',
        requestHash: 'ac003-batch-hash',
        preparedCount: 1,
        totalCount: 1,
        preparedByUserId: owner.userId,
        committedByUserId: owner.userId,
        preparedAt: PAST_END,
        committedAt: PAST_END,
      },
      select: { id: true },
    });
    await prisma.participationLedgerEntry.create({
      data: {
        postingBatchId: batch.id,
        entryKey: 'ac003-entry',
        operationKey: 'ac003-entry-operation',
        memberId: owner.memberId,
        activityId: source.id,
        sessionId: session.id,
        participationIdentityId: identity.id,
        resultRevisionId: resultRevision.id,
        ledgerDate: new Date('2020-03-01T00:00:00.000Z'),
        entryTypeCode: 'service_credit',
        serviceHoursDelta: 2,
        recognizedPointsDelta: 0,
        creditedPointsDelta: 0,
        cappedOutPointsDelta: 0,
      },
    });
    // ---- 关闭 ----
    await prisma.activitySettlementClosureRevision.create({
      data: {
        activityId: source.id,
        revision: 1,
        settlementVersionId: version.id,
        postingBatchId: batch.id,
        evidenceSealId: seal.id,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        personCount: 1,
        sessionParticipationCount: 1,
        resultCountsJson: { present: 1 },
        serviceHours: 2,
        contributionPoints: 1,
        checksHash: 'ac003-checks-hash',
        checksJson: {},
        statusCode: 'active',
        closedByUserId: owner.userId,
        closedAt: PAST_END,
      },
    });
    // ---- 更正 ----
    await prisma.attendanceCorrectionRequest.create({
      data: {
        activityId: source.id,
        settlementRunId: run.id,
        participationIdentityId: identity.id,
        baseSettlementVersionId: version.id,
        baseResultRevisionId: resultRevision.id,
        baseClosureRevision: 1,
        requestTypeCode: 'points',
        requestedChangeJson: { schemaVersion: 1, results: [], segments: [] },
        reason: 'AC-003 夹具:源活动上要有一条更正历史',
        statusCode: 'rejected',
        submittedByUserId: owner.userId,
        submittedAt: PAST_END,
      },
    });
    // ---- 通知(活动锚在 outbox intent 的多态 aggregateId 上)----
    await prisma.notificationOutboxIntent.create({
      data: {
        eventKey: 'ac003-outbox-event',
        eventType: 'activity.closed',
        payloadVersion: 1,
        payload: {},
        aggregateType: 'activity',
        aggregateId: source.id,
        destinationType: 'member',
        destinationRef: owner.memberId,
      },
    });

    /** 九类历史在某个活动上的行数(通知走多态锚点,其余走 activityId 外键)。 */
    async function historyCounts(activityId: string): Promise<Record<string, number>> {
      const [
        registrations,
        invitations,
        qrCredentials,
        punches,
        settlementRuns,
        ledgerEntries,
        closures,
        corrections,
        notificationIntents,
      ] = await Promise.all([
        prisma.activityRegistration.count({ where: { activityId } }),
        prisma.activityInvitation.count({ where: { activityId } }),
        prisma.attendanceQrCredential.count({ where: { activityId } }),
        prisma.attendancePunchEvent.count({ where: { activityId } }),
        prisma.attendanceSettlementRun.count({ where: { activityId } }),
        prisma.participationLedgerEntry.count({ where: { activityId } }),
        prisma.activitySettlementClosureRevision.count({ where: { activityId } }),
        prisma.attendanceCorrectionRequest.count({ where: { activityId } }),
        prisma.notificationOutboxIntent.count({
          where: { aggregateType: 'activity', aggregateId: activityId },
        }),
      ]);
      return {
        报名: registrations,
        邀请: invitations,
        二维码: qrCredentials,
        打卡: punches,
        结算: settlementRuns,
        账本: ledgerEntries,
        关闭: closures,
        更正: corrections,
        通知: notificationIntents,
      };
    }

    // ① 正向:九类**逐类**在源活动上真的有 —— 没有这一格,下面的"逐类 0"是恒真的。
    expect(await historyCounts(source.id)).toStrictEqual({
      报名: 1,
      邀请: 1,
      二维码: 1,
      打卡: 1,
      结算: 1,
      账本: 1,
      关闭: 1,
      更正: 1,
      通知: 1,
    });

    // ③ 结构:spy 面自己不许塌 —— 集合里每个名字都必须是 Prisma client 上真实存在的
    //    delegate,写错一个字母就会静默变成"永远观察不到",而读数照样是 0。
    const missingDelegates = [...FACT_DELEGATES].filter(
      (name) => typeof (prisma as unknown as Record<string, unknown>)[name] !== 'object',
    );
    expect({ 集合里不是真实delegate的名字: missingDelegates }).toStrictEqual({
      集合里不是真实delegate的名字: [],
    });

    const observed = await countCloneFactWrites(
      async () =>
        await request(httpServer(app))
          .post(managedPath(source.id, 'clone'))
          .set('Authorization', owner.auth)
          .send({ title: 'AC-003 克隆件' }),
    );
    expect(observed.result.status).toBe(201);
    // clone 事务内对**任何**事实表 delegate 的写次数为零。
    expect(observed.factWrites).toBe(0);

    // ② 反向:克隆件上九类逐类恰 0 行,同时它确实是一份**全新草稿**(不是同一条活动)。
    const cloneId = observed.result.body.data.activityId as string;
    expect(cloneId).not.toBe(source.id);
    expect(await historyCounts(cloneId)).toStrictEqual({
      报名: 0,
      邀请: 0,
      二维码: 0,
      打卡: 0,
      结算: 0,
      账本: 0,
      关闭: 0,
      更正: 0,
      通知: 0,
    });
    await expect(
      prisma.activity.findUniqueOrThrow({
        where: { id: cloneId },
        select: { statusCode: true, currentClosureRevision: true, workflowRevision: true },
      }),
    ).resolves.toStrictEqual({
      statusCode: 'draft',
      currentClosureRevision: null,
      workflowRevision: 0,
    });
    // 源活动这九类一行都没被搬走(clone 是复制不是搬家)。
    expect(await historyCounts(source.id)).toStrictEqual({
      报名: 1,
      邀请: 1,
      二维码: 1,
      打卡: 1,
      结算: 1,
      账本: 1,
      关闭: 1,
      更正: 1,
      通知: 1,
    });
  });

  // ===== 3. evidence seal：HTTP 层无翻译、无重建，只透传已有 seal() 语义 =====

  async function createSealableActivity(owner: Awaited<ReturnType<typeof createMember>>) {
    const activity = await createActivity({
      title: '可封场活动',
      statusCode: 'published',
      initiatorMemberId: owner.memberId,
      startAt: PAST_START,
      endAt: PAST_END,
    });
    await assignOwner(activity.id, owner);
    const session = await createSession(activity.id, { startAt: PAST_START, endAt: PAST_END });
    const registration = await prisma.activityRegistration.create({
      data: { activityId: activity.id, memberId: owner.memberId, statusCode: 'approved' },
      select: { id: true },
    });
    const identity = await prisma.activityParticipationIdentity.create({
      data: {
        activityId: activity.id,
        sessionId: session.id,
        registrationId: registration.id,
        memberId: owner.memberId,
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
        memberId: owner.memberId,
        eventTypeCode: 'check_in',
        sourceCode: 'staff_scan',
        occurredAt: PAST_START,
        receivedAt: PAST_START,
        operatorUserId: owner.userId,
        eventKey: `b3-s3-seal-event-${sequence}`,
        requestHash: `b3-s3-seal-hash-${sequence}`,
        evidenceRevision: 0,
      },
      select: { id: true },
    });
    await prisma.participantServiceSegmentRevision.create({
      data: {
        participationIdentityId: identity.id,
        segmentKey: `b3-s3-seal-segment-${sequence}`,
        revision: 0,
        sourceCheckInEventId: checkIn.id,
        sourceCloseEventId: null,
        resultCode: 'valid',
        statusCode: 'draft',
        checkInAt: PAST_START,
        checkOutAt: PAST_END,
      },
    });
    return activity;
  }

  it('passes the existing evidence-seal result and named gap errors through the managed HTTP surface', async () => {
    const owner = await createMember('seal-owner');
    const success = await createSealableActivity(owner);
    const sealed = await request(httpServer(app))
      .post(managedPath(success.id, 'evidence-seals'))
      .set('Authorization', owner.auth)
      .send({});
    expect(sealed.status).toBe(200);
    expect(sealed.body.data).toEqual(
      expect.objectContaining({
        activityId: success.id,
        sealRevision: 1,
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: 1,
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );

    const gap = await createActivity({
      title: '封场缺口保持原码',
      statusCode: 'published',
      initiatorMemberId: owner.memberId,
      startAt: PAST_START,
      endAt: PAST_END,
    });
    await assignOwner(gap.id, owner);
    await createSession(gap.id, {
      startAt: PAST_START,
      endAt: PAST_END,
      statusCode: 'terminated',
      terminationCheckOutDeadline: FUTURE_START,
    });
    // 既有 service 对有效签退截止尚未来到的形态已有具名拒绝码；HTTP 不能吞掉或改写它。
    expectBizError(
      await request(httpServer(app))
        .post(managedPath(gap.id, 'evidence-seals'))
        .set('Authorization', owner.auth)
        .send({}),
      BizCode.EVIDENCE_SEAL_CHECKOUT_WINDOW_OPEN,
    );
  });

  // ===== 4. 队员目录/详情：published-only + invitation 防枚举 + batch4 form seam =====

  it('shows only published internal/invited activities and hides invitation misses and every terminal state as 404-style', async () => {
    const viewer = await createMember('member-directory');
    const internal = await createActivity({
      title: '内部可见目录项',
      statusCode: 'published',
      visibilityCode: 'internal',
      startAt: FUTURE_START,
      endAt: FUTURE_END,
    });
    const invited = await createActivity({
      title: '邀请可见目录项',
      statusCode: 'published',
      visibilityCode: 'invitation',
      startAt: FUTURE_START,
      endAt: FUTURE_END,
    });
    await prisma.activityInvitation.create({
      data: {
        activityId: invited.id,
        memberId: viewer.memberId,
        statusCode: 'pending',
        expiresAt: new Date('2099-12-31T00:00:00.000Z'),
      },
    });
    const invitationMiss = await createActivity({
      title: '无邀请不可见',
      statusCode: 'published',
      visibilityCode: 'invitation',
      startAt: FUTURE_START,
      endAt: FUTURE_END,
    });
    const hidden = await Promise.all(
      ['draft', 'cancelled', 'terminated', 'completed'].map(
        async (statusCode) =>
          await createActivity({
            title: `读面隐藏 ${statusCode}`,
            statusCode,
            startAt: FUTURE_START,
            endAt: FUTURE_END,
          }),
      ),
    );

    const list = await request(httpServer(app))
      .get('/api/app/v1/activities?page=1&pageSize=100')
      .set('Authorization', viewer.auth);
    expect(list.status).toBe(200);
    const ids = (list.body.data.items as Array<{ id: string }>).map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([internal.id, invited.id]));
    expect(ids).not.toContain(invitationMiss.id);
    for (const activity of hidden) expect(ids).not.toContain(activity.id);

    expectBizError(
      await request(httpServer(app))
        .get(`/api/app/v1/activities/${invitationMiss.id}`)
        .set('Authorization', viewer.auth),
      BizCode.ACTIVITY_NOT_FOUND,
    );
    for (const activity of hidden) {
      expectBizError(
        await request(httpServer(app))
          .get(`/api/app/v1/activities/${activity.id}`)
          .set('Authorization', viewer.auth),
        BizCode.ACTIVITY_NOT_FOUND,
      );
    }
  });

  // ===== 4bis ⭐ ADV-019(2026-08 验收补写)=====
  //
  // 合同原句:「正式队员、停用账号、非正式队员和未受邀人员的活动可见性**组合**。」
  //
  // 🔴 补的是两件事:
  //   ① **停用**这一轴此前在第 3 批新目录路由 `GET /api/app/v1/activities` 上零覆盖
  //      (既有 INACTIVE→403 只钉在旧的 `activities/available` 与 `activities/:id` 上,
  //       本 spec 里 `createMember()` 恒建 `MemberStatus.ACTIVE`,`UserStatus` 一次都没出现);
  //   ② 合同要的是「**组合**」,而此前没有任何用例同时跨两轴。
  //
  // ⚠️ 停用有**两条互不相同的路**,不许合并成一句"停用就是看不到":
  //      · `User.status = DISABLED` → `JwtStrategy` 每请求查库 ⇒ **401 UNAUTHORIZED**;
  //      · `Member.status = INACTIVE`(账号本身仍 ACTIVE)→ App 准入闭包 ⇒ **403 FORBIDDEN**。
  //    合并断言会让"401 退化成 403"这类真回归看不出来。
  //
  // 判据形状 = **一次读出六个人 × 两个活动的完整矩阵**(比集合,不比计数):
  //   正向格 —— 正式且受邀者两个都看得到(证明夹具与路由是活的,矩阵不是恒空);
  //   反向格 —— 未受邀者看不到邀请制那个,非正式者看不到内部那个;
  //   ⭐ 组合格 —— **非正式 × 受邀**:只看得到邀请制那个、看不到内部那个
  //               (两轴各自的结论叠加,不是其中任一轴单独能给出的);
  //   ⭐ 组合格 —— **停用 × (正式 + 受邀)**:另外两轴全满足,仍然被挡在门外,
  //               证明停用这一轴**压过**可见性计算,而不是"少看到几条"。
  it('ADV-019 正式/停用/非正式/未受邀四轴在新目录路由上的可见性组合矩阵', async () => {
    const internal = await createActivity({
      title: 'ADV-019 内部可见',
      statusCode: 'published',
      visibilityCode: 'internal',
      startAt: FUTURE_START,
      endAt: FUTURE_END,
    });
    const invitationOnly = await createActivity({
      title: 'ADV-019 邀请可见',
      statusCode: 'published',
      visibilityCode: 'invitation',
      startAt: FUTURE_START,
      endAt: FUTURE_END,
    });

    async function invite(memberId: string): Promise<void> {
      await prisma.activityInvitation.create({
        data: {
          activityId: invitationOnly.id,
          memberId,
          statusCode: 'pending',
          expiresAt: new Date('2099-12-31T00:00:00.000Z'),
        },
      });
    }

    const formalInvited = await createMember('adv019-formal-in');
    await invite(formalInvited.memberId);
    const formalUninvited = await createMember('adv019-formal-out');
    const nonFormalInvited = await createMember('adv019-volunteer-in');
    await prisma.member.update({
      where: { id: nonFormalInvited.memberId },
      data: { gradeCode: 'volunteer' },
    });
    await invite(nonFormalInvited.memberId);
    const nonFormalUninvited = await createMember('adv019-volunteer-out');
    await prisma.member.update({
      where: { id: nonFormalUninvited.memberId },
      data: { gradeCode: 'volunteer' },
    });
    // 停用两位:先照常建号并登好(拿到真 token),再分别停掉账号 / 停掉队员。
    // 顺序是有意的 —— 停用后再登录就登不上了,那样测的是登录闸而不是读面闸。
    const disabledAccount = await createMember('adv019-disabled-user');
    await invite(disabledAccount.memberId);
    await prisma.user.update({
      where: { id: disabledAccount.userId },
      data: { status: UserStatus.DISABLED },
    });
    const inactiveMember = await createMember('adv019-inactive-member');
    await invite(inactiveMember.memberId);
    await prisma.member.update({
      where: { id: inactiveMember.memberId },
      data: { status: MemberStatus.INACTIVE },
    });

    /** 目录读面:能读到就返回"看得见哪两个",读不到就返回具名拒绝码。 */
    async function directoryOutcome(auth: string): Promise<unknown> {
      const response = await request(httpServer(app))
        .get('/api/app/v1/activities?page=1&pageSize=100')
        .set('Authorization', auth);
      if (response.status !== 200) {
        return { 拒绝码: response.body?.code as number };
      }
      const ids = (response.body.data.items as Array<{ id: string }>).map((item) => item.id);
      return { 内部: ids.includes(internal.id), 邀请: ids.includes(invitationOnly.id) };
    }

    /** 详情读面:200 / 具名拒绝码。 */
    async function detailOutcome(auth: string, activityId: string): Promise<unknown> {
      const response = await request(httpServer(app))
        .get(`/api/app/v1/activities/${activityId}`)
        .set('Authorization', auth);
      return response.status === 200 ? 200 : { 拒绝码: response.body?.code as number };
    }

    expect({
      正式受邀: await directoryOutcome(formalInvited.auth),
      正式未受邀: await directoryOutcome(formalUninvited.auth),
      非正式受邀: await directoryOutcome(nonFormalInvited.auth),
      非正式未受邀: await directoryOutcome(nonFormalUninvited.auth),
      账号停用: await directoryOutcome(disabledAccount.auth),
      队员停用: await directoryOutcome(inactiveMember.auth),
    }).toStrictEqual({
      // 正向:两个都看得到 —— 没有这一格,底下所有 false 都可能只是夹具坏了。
      正式受邀: { 内部: true, 邀请: true },
      // 反向:未受邀 ⇒ 邀请制那个不进目录(内部那个照旧看得到)。
      正式未受邀: { 内部: true, 邀请: false },
      // ⭐ 组合:非正式 × 受邀 ⇒ 只剩邀请那条通路,内部活动对他关闭。
      非正式受邀: { 内部: false, 邀请: true },
      // 两轴都不满足 ⇒ 两个都看不到(而不是报错)。
      非正式未受邀: { 内部: false, 邀请: false },
      // ⭐ 组合:停用 × (正式 + 受邀) ⇒ 另两轴全满足仍被挡,且两条停用路**分码**。
      账号停用: { 拒绝码: BizCode.UNAUTHORIZED.code },
      队员停用: { 拒绝码: BizCode.FORBIDDEN.code },
    });

    // 详情路由上同一张矩阵再走一遍 —— 目录过滤与详情防枚举是**两处实现**,
    // 只测目录会让"列表里藏住了、知道 id 还能直接读"这种漏洞整片漏掉。
    expect({
      正式受邀_内部: await detailOutcome(formalInvited.auth, internal.id),
      正式受邀_邀请: await detailOutcome(formalInvited.auth, invitationOnly.id),
      正式未受邀_邀请: await detailOutcome(formalUninvited.auth, invitationOnly.id),
      非正式受邀_内部: await detailOutcome(nonFormalInvited.auth, internal.id),
      非正式受邀_邀请: await detailOutcome(nonFormalInvited.auth, invitationOnly.id),
      账号停用_内部: await detailOutcome(disabledAccount.auth, internal.id),
      队员停用_内部: await detailOutcome(inactiveMember.auth, internal.id),
    }).toStrictEqual({
      正式受邀_内部: 200,
      正式受邀_邀请: 200,
      // 防枚举:不是 403「你没权限看这条」,而是 404 式「这条不存在」。
      正式未受邀_邀请: { 拒绝码: BizCode.ACTIVITY_NOT_FOUND.code },
      非正式受邀_内部: { 拒绝码: BizCode.ACTIVITY_NOT_FOUND.code },
      非正式受邀_邀请: 200,
      账号停用_内部: { 拒绝码: BizCode.UNAUTHORIZED.code },
      队员停用_内部: { 拒绝码: BizCode.FORBIDDEN.code },
    });
  });

  it('AC-011 exposes ordinary activities only to formal members while preserving qualification reasons', async () => {
    const formal = await createMember('formal-visibility');
    const nonFormal = await createMember('non-formal-visibility');
    await prisma.member.update({
      where: { id: nonFormal.memberId },
      data: { gradeCode: 'volunteer' },
    });
    const activity = await createActivity({
      title: 'AC-011 正式会员可见活动',
      statusCode: 'published',
      visibilityCode: 'internal',
      startAt: FUTURE_START,
      endAt: FUTURE_END,
    });
    await prisma.activity.update({
      where: { id: activity.id },
      data: { isPublicRegistration: true },
    });
    const ruleSet = await prisma.activityQualificationRuleSet.create({
      data: {
        activityId: activity.id,
        version: 1,
        statusCode: 'draft',
        rules: {
          create: {
            ruleTypeCode: 'grade',
            enforcementCode: 'block',
            operator: 'in',
            valueJson: { codes: ['level-7'] },
            message: '需要 level-7 正式级别',
            sortOrder: 1,
          },
        },
      },
      select: { id: true },
    });
    await prisma.activityQualificationRuleSet.update({
      where: { id: ruleSet.id },
      data: { statusCode: 'active' },
    });

    const formalDirectory = await request(httpServer(app))
      .get(`/api/app/v1/activities?page=1&pageSize=10&q=${encodeURIComponent('AC-011')}`)
      .set('Authorization', formal.auth);
    expect(formalDirectory.status).toBe(200);
    expect(formalDirectory.body.data.items).toEqual([expect.objectContaining({ id: activity.id })]);
    const formalDetail = await request(httpServer(app))
      .get(`/api/app/v1/activities/${activity.id}`)
      .set('Authorization', formal.auth);
    expect(formalDetail.status).toBe(200);
    expect(formalDetail.body.data.qualification).toEqual({
      resultCode: 'fail',
      unmetRules: [
        expect.objectContaining({
          enforcementCode: 'block',
          resultCode: 'fail',
          message: '需要 level-7 正式级别',
        }),
      ],
    });

    const hiddenDirectory = await request(httpServer(app))
      .get(`/api/app/v1/activities?page=1&pageSize=10&q=${encodeURIComponent('AC-011')}`)
      .set('Authorization', nonFormal.auth);
    expect(hiddenDirectory.status).toBe(200);
    expect(hiddenDirectory.body.data.items).toEqual([]);
    const hiddenAvailable = await request(httpServer(app))
      .get('/api/app/v1/activities/available?page=1&pageSize=100')
      .set('Authorization', nonFormal.auth);
    expect(hiddenAvailable.status).toBe(200);
    expect(
      (hiddenAvailable.body.data.items as Array<{ id: string }>).map((item) => item.id),
    ).not.toContain(activity.id);
    expectBizError(
      await request(httpServer(app))
        .get(`/api/app/v1/activities/${activity.id}`)
        .set('Authorization', nonFormal.auth),
      BizCode.ACTIVITY_NOT_FOUND,
    );
    expectBizError(
      await request(httpServer(app))
        .get(`/api/app/v1/activities/${activity.id}/positions`)
        .set('Authorization', nonFormal.auth),
      BizCode.ACTIVITY_NOT_FOUND,
    );

    const invitedActivity = await createActivity({
      title: 'AC-011 非正式会员受邀可见',
      statusCode: 'published',
      registrationModeCode: 'invitation_only',
      visibilityCode: 'invitation',
      startAt: FUTURE_START,
      endAt: FUTURE_END,
    });
    await prisma.activityInvitation.create({
      data: {
        activityId: invitedActivity.id,
        memberId: nonFormal.memberId,
        statusCode: 'pending',
        expiresAt: new Date('2099-12-31T00:00:00.000Z'),
      },
    });
    const invitedDirectory = await request(httpServer(app))
      .get(`/api/app/v1/activities?page=1&pageSize=10&q=${encodeURIComponent('AC-011 非正式')}`)
      .set('Authorization', nonFormal.auth);
    expect(invitedDirectory.status).toBe(200);
    expect(invitedDirectory.body.data.items).toEqual([
      expect.objectContaining({ id: invitedActivity.id }),
    ]);
    await request(httpServer(app))
      .get(`/api/app/v1/activities/${invitedActivity.id}`)
      .set('Authorization', nonFormal.auth)
      .expect(200);
  });

  it('treats only unexpired pending invitations as visibility grants and exposes only the caller own invitation summaries', async () => {
    const viewer = await createMember('invitation-expiry-viewer');
    const other = await createMember('invitation-expiry-other');
    const expiredOnly = await createActivity({
      title: '过期 pending 不可见',
      statusCode: 'published',
      visibilityCode: 'invitation',
      startAt: FUTURE_START,
      endAt: FUTURE_END,
    });
    const accepted = await createActivity({
      title: 'accepted 保持可见',
      statusCode: 'published',
      visibilityCode: 'invitation',
      startAt: FUTURE_START,
      endAt: FUTURE_END,
    });
    const internal = await createActivity({
      title: '详情仅返本人邀请',
      statusCode: 'published',
      visibilityCode: 'internal',
      startAt: FUTURE_START,
      endAt: FUTURE_END,
    });
    const expiredAt = new Date('2020-01-01T00:00:00.000Z');
    await prisma.activityInvitation.createMany({
      data: [
        {
          activityId: expiredOnly.id,
          memberId: viewer.memberId,
          statusCode: 'pending',
          expiresAt: expiredAt,
        },
        {
          activityId: accepted.id,
          memberId: viewer.memberId,
          statusCode: 'accepted',
          expiresAt: expiredAt,
          respondedAt: new Date('2019-12-31T00:00:00.000Z'),
        },
        {
          activityId: internal.id,
          memberId: viewer.memberId,
          statusCode: 'pending',
          expiresAt: expiredAt,
        },
        {
          activityId: internal.id,
          memberId: other.memberId,
          statusCode: 'pending',
          expiresAt: new Date('2099-12-31T00:00:00.000Z'),
        },
      ],
    });

    const list = await request(httpServer(app))
      .get('/api/app/v1/activities?page=1&pageSize=100')
      .set('Authorization', viewer.auth);
    const ids = (list.body.data.items as Array<{ id: string }>).map((item) => item.id);
    expect(ids).not.toContain(expiredOnly.id);
    expect(ids).toContain(accepted.id);

    expectBizError(
      await request(httpServer(app))
        .get(`/api/app/v1/activities/${expiredOnly.id}`)
        .set('Authorization', viewer.auth),
      BizCode.ACTIVITY_NOT_FOUND,
    );

    const acceptedDetail = await request(httpServer(app))
      .get(`/api/app/v1/activities/${accepted.id}`)
      .set('Authorization', viewer.auth);
    expect(acceptedDetail.status).toBe(200);
    expect(acceptedDetail.body.data.myInvitations).toEqual([
      expect.objectContaining({
        scope: 'activity',
        status: 'accepted',
        expiresAt: expiredAt.toISOString(),
      }),
    ]);

    const internalDetail = await request(httpServer(app))
      .get(`/api/app/v1/activities/${internal.id}`)
      .set('Authorization', viewer.auth);
    expect(internalDetail.status).toBe(200);
    expect(internalDetail.body.data.myInvitations).toEqual([
      expect.objectContaining({
        scope: 'activity',
        status: 'expired',
        expiresAt: expiredAt.toISOString(),
      }),
    ]);
    expect(JSON.stringify(internalDetail.body.data.myInvitations)).not.toContain(other.memberId);
  });

  it('applies q/type/date/organization inside the same published-and-visible directory fence', async () => {
    const viewer = await createMember('directory-filters');
    const otherOrganization = await prisma.organization.create({
      data: {
        name: 'B3 Slice3 Filter Other Team',
        nodeTypeCode: 'b3-slice3-filter-team',
      },
      select: { id: true },
    });
    const target = await createActivity({
      title: '目录筛选靶点',
      statusCode: 'published',
      startAt: FUTURE_START,
      endAt: FUTURE_END,
    });
    await createActivity({
      title: '目录筛选靶点',
      statusCode: 'published',
      startAt: FUTURE_START,
      endAt: FUTURE_END,
      organizationOverrideId: otherOrganization.id,
    });
    await prisma.activity.create({
      data: {
        title: '目录筛选靶点',
        activityTypeCode: 'b3-slice3-other-type',
        organizationId,
        startAt: FUTURE_START,
        endAt: FUTURE_END,
        location: '深圳',
        statusCode: 'published',
        visibilityCode: 'internal',
      },
    });
    await createActivity({
      title: '目录筛选靶点',
      statusCode: 'published',
      startAt: PAST_START,
      endAt: PAST_END,
    });

    const response = await request(httpServer(app))
      .get(
        `/api/app/v1/activities?page=1&pageSize=100&q=${encodeURIComponent('目录筛选')}` +
          `&type=${activityTypeCode}&date=2099-10-01&organization=${organizationId}`,
      )
      .set('Authorization', viewer.auth);
    expect(response.status).toBe(200);
    expect((response.body.data.items as Array<{ id: string }>).map((item) => item.id)).toEqual([
      target.id,
    ]);
  });

  it('extends existing detail only additively with registrationMode, session-position projection, and the explicit null formVersion seam', async () => {
    const viewer = await createMember('detail-projection');
    const activity = await createActivity({
      title: '详情投影',
      statusCode: 'published',
      registrationModeCode: 'invitation_only',
      visibilityCode: 'internal',
      startAt: FUTURE_START,
      endAt: FUTURE_END,
    });
    const session = await createSession(activity.id, { startAt: FUTURE_START, endAt: FUTURE_END });
    const position = await createSessionPosition(activity.id, session.id);

    const detail = await request(httpServer(app))
      .get(`/api/app/v1/activities/${activity.id}`)
      .set('Authorization', viewer.auth);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toEqual(
      expect.objectContaining({
        id: activity.id,
        registrationMode: 'invitation_only',
        // 批 4 才有 RegistrationFormVersion 的真实绑定；本刀只能诚实恒 null。
        formVersion: null,
        sessions: [
          expect.objectContaining({
            id: session.id,
            positions: [expect.objectContaining({ id: position.id, attendanceRoleCode })],
          }),
        ],
      }),
    );
  });
});
