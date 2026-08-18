import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Prisma, Role } from '@prisma/client';
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
  });

  async function createMember(label: string, role: Role = Role.USER) {
    sequence += 1;
    const member = await prisma.member.create({
      data: {
        memberNo: `b3-s3-${label}-${sequence}`,
        displayName: `B3 S3 ${label} ${sequence}`,
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
  const FACT_DELEGATES = new Set([
    'activityRegistration',
    'activityCheckIn',
    'attendanceSheet',
    'activityParticipationIdentity',
    'activityParticipationRevision',
    'attendancePunchEvent',
    'participantServiceSegmentRevision',
    'attendanceSettlementRun',
    'participationLedgerEntry',
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
