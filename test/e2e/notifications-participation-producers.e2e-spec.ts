import type { INestApplication } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { Role, UserStatus } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import appConfig from '../../src/config/app.config';
import { PrismaService } from '../../src/database/prisma.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { ActivitiesService } from '../../src/modules/activities/activities.service';
import { ActivityRegistrationsService } from '../../src/modules/activity-registrations/activity-registrations.service';
import { AttendancesService } from '../../src/modules/attendances/attendances.service';
import { NotificationDispatcher } from '../../src/modules/notifications/notification-dispatcher';
import { NotificationOutboxHandlers } from '../../src/modules/notifications/notification-outbox.handlers';
import { NotificationOutboxService } from '../../src/modules/notifications/notification-outbox.service';
import { NotificationOutboxWorker } from '../../src/modules/notifications/notification-outbox.worker';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 统一通知 S4 + durable outbox L1:
//   ① 报名审批、候补递补、自助取消在业务事务内 enqueue，worker commit 后执行 Effect；
//   ② 活动取消(cancel)→ 遍历已报名者(pending + pass)逐人;
//   ③ 考勤终审通过(finalApprove)→ 逐 record 本人(含贡献值)。
//
// L1 断言业务 + audit + intent 原子性、worker retry/idempotency、gate owner 真值；L2/L4 尚未
// 收口的活动取消与考勤路径继续锁定 commit 后 best-effort 行为。
//
// schema / 端点 / RBAC / BizCode 零新增:复用 S3 dispatchTargeted + 既有 notification_type 字典 'activity-reminder'。

const APP_NOTIFS = '/api/app/v1/notifications';
const AUDIT_META: AuditMeta = {
  requestId: 's4-producers-req-00000000000001',
  ip: '127.0.0.1',
  ua: 'jest/30 notifications-participation-producers',
};

interface Member {
  userId: string;
  memberId: string;
  auth: string;
}

interface RegistrationCreateTestHooks {
  resolveCreateStatusCode: (
    activityId: string,
    activityPositionId: string | null,
    activityCapacity: number | null,
    activityPositionCapacity: number | null,
    tx: Prisma.TransactionClient,
  ) => Promise<'pending' | 'waitlisted'>;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function observeBlockedByBackend(
  prisma: PrismaService,
  blockerPid: number,
  mutation: Promise<unknown>,
): Promise<'blocked' | 'settled'> {
  let settled = false;
  void mutation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (settled) return 'settled';
    const waiting = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND CAST(${blockerPid} AS integer) = ANY(pg_blocking_pids(pid))
        AND query LIKE '%"Activity"%'
      LIMIT 1
    `;
    if (waiting.length > 0) return 'blocked';
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for activity cancellation to block on registration tx');
}

describe('统一通知 S4 活动/考勤 producer 定向触发 e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let dispatcher: NotificationDispatcher;
  let outbox: NotificationOutboxService;
  let outboxHandlers: NotificationOutboxHandlers;
  let outboxWorker: NotificationOutboxWorker;
  let config: ConfigType<typeof appConfig>;
  let activities: ActivitiesService;
  let registrations: ActivityRegistrationsService;
  let attendances: AttendancesService;

  let adminPayload: CurrentUserPayload;
  // 摘码微刀(2026-07-03):biz-admin 不再持终审两码 → finalApprove 用独立 SUPER_ADMIN
  // 终审身份(SA 兜底通路;adminPayload 继续承担其余 producer 动作,语义不变)
  let finalReviewerPayload: CurrentUserPayload;
  // PR9:sheet submitter 独立 FK 用户 id(自审约束下 ≠ 终审人)
  let sheetSubmitterUserId: string;
  let alice: Member;
  let bob: Member;
  let orgId: string;

  async function makeMember(username: string): Promise<Member> {
    const user = await createTestUser(app, { username, role: Role.USER });
    const member = await prisma.member.create({
      data: { memberNo: `S4-${username}`, displayName: username, status: 'ACTIVE' },
      select: { id: true },
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { memberId: member.id, openid: `dev-openid-s4-${username}` },
    });
    const { authHeader } = await loginAs(app, username);
    return { userId: user.id, memberId: member.id, auth: authHeader };
  }

  function feedList(auth: string): request.Test {
    return request(httpServer(app)).get(APP_NOTIFS).set('Authorization', auth);
  }
  function feedDetail(auth: string, id: string): request.Test {
    return request(httpServer(app)).get(`${APP_NOTIFS}/${id}`).set('Authorization', auth);
  }
  async function feedIds(auth: string): Promise<string[]> {
    const res = await feedList(auth).expect(200);
    return (res.body.data.items as { id: string }[]).map((i) => i.id);
  }

  // 直接 prisma seed published Activity(绕过 service 校验链,沿 attendances-state-transition.e2e 范式)。
  async function seedActivity(title: string, capacity: number | null = null): Promise<string> {
    const activity = await prisma.activity.create({
      data: {
        title,
        activityTypeCode: 's4-type',
        organizationId: orgId,
        startAt: new Date('2026-08-01T08:00:00.000Z'),
        endAt: new Date('2026-08-01T12:00:00.000Z'),
        location: 'S4 演示',
        statusCode: 'published',
        isPublicRegistration: true,
        capacity,
      },
      select: { id: true },
    });
    return activity.id;
  }

  async function seedRegistration(
    activityId: string,
    memberId: string,
    statusCode: string,
  ): Promise<string> {
    const reg = await prisma.activityRegistration.create({
      data: { activityId, memberId, statusCode },
      select: { id: true },
    });
    return reg.id;
  }

  // pending_final_review 的 sheet + 每个 member 一条 record(绕过 submit 状态机)。
  // PR9:submitter 用独立 FK 用户(终审 authz 自审约束 22074 下 submitter 必须 ≠ 终审人;
  // 摘码微刀后本 spec 终审人固定 finalReviewerPayload〔SA〕)。
  async function seedSheetPendingFinal(activityId: string, memberIds: string[]): Promise<string> {
    const sheet = await prisma.attendanceSheet.create({
      data: {
        activityId,
        submitterUserId: sheetSubmitterUserId,
        statusCode: 'pending_final_review',
        version: 1,
      },
      select: { id: true },
    });
    for (let i = 0; i < memberIds.length; i++) {
      const checkIn = new Date(
        new Date('2026-08-01T08:00:00.000Z').getTime() + i * 6 * 60 * 60 * 1000,
      );
      const checkOut = new Date(checkIn.getTime() + 4 * 60 * 60 * 1000);
      await prisma.attendanceRecord.create({
        data: {
          sheetId: sheet.id,
          memberId: memberIds[i],
          roleCode: 's4-role',
          checkInAt: checkIn,
          checkOutAt: checkOut,
          serviceHours: 4,
          attendanceStatusCode: 'normal',
          contributionPoints: 1.5,
        },
      });
    }
    return sheet.id;
  }

  function directedOf(memberId: string) {
    return prisma.notification.findMany({ where: { recipientMemberId: memberId } });
  }

  async function drainTargetedIntent(aggregateId: string, memberId: string): Promise<string> {
    const intent = await prisma.notificationOutboxIntent.findFirstOrThrow({
      where: {
        aggregateType: 'activity_registration',
        aggregateId,
        destinationRef: memberId,
      },
    });
    expect(intent).toMatchObject({
      eventType: 'notification.targeted',
      payloadVersion: 1,
      status: 'pending',
      destinationType: 'member',
    });
    await outboxWorker.drainEventKey(intent.eventKey);
    expect(
      await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: intent.id } }),
    ).toMatchObject({ status: 'succeeded' });
    return intent.id;
  }

  async function drainActivityIntents(activityId: string): Promise<void> {
    const intents = await prisma.notificationOutboxIntent.findMany({
      where: { aggregateType: 'activity', aggregateId: activityId },
      orderBy: { createdAt: 'asc' },
    });
    for (const intent of intents) {
      expect(intent.status).toBe('pending');
      await outboxWorker.drainEventKey(intent.eventKey);
      expect(
        await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: intent.id } }),
      ).toMatchObject({ status: 'succeeded' });
    }
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    dispatcher = app.get(NotificationDispatcher);
    outbox = app.get(NotificationOutboxService);
    outboxHandlers = app.get(NotificationOutboxHandlers);
    outboxWorker = app.get(NotificationOutboxWorker);
    config = app.get(appConfig.KEY);
    activities = app.get(ActivitiesService);
    registrations = app.get(ActivityRegistrationsService);
    attendances = app.get(AttendancesService);
    await resetDb(app);

    // 活动域通知类型语义分离；activity-reminder 只留给开场提醒。
    const dictType = await prisma.dictType.create({
      data: { code: 'notification_type', label: '通知类型', status: 'ACTIVE' },
      select: { id: true },
    });
    await prisma.dictItem.createMany({
      data: [
        { typeId: dictType.id, code: 'activity-reminder', label: '活动提醒', status: 'ACTIVE' },
        { typeId: dictType.id, code: 'activity-changed', label: '活动变更', status: 'ACTIVE' },
        { typeId: dictType.id, code: 'registration-result', label: '报名结果', status: 'ACTIVE' },
        { typeId: dictType.id, code: 'attendance-result', label: '考勤结果', status: 'ACTIVE' },
      ],
    });

    // Activity.organizationId FK(Restrict)
    const org = await prisma.organization.create({
      data: { name: 'S4 Root Org', nodeTypeCode: 's4-root', parentId: null },
      select: { id: true },
    });
    orgId = org.id;

    // admin(service rbac.can 判权;补挂 biz-admin)
    const adminUser = await prisma.user.create({
      data: {
        username: 's4-admin',
        passwordHash: '$2a$10$dummy-hash-not-used-since-service-direct',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });
    const bizSeed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, adminUser.id, bizSeed.bizAdminRoleId);
    adminPayload = {
      id: adminUser.id,
      username: 's4-admin',
      role: Role.ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };

    // PR9:sheet submitter 独立 FK 用户(见 seedSheetPendingFinal 注释)
    const sheetSubmitter = await prisma.user.create({
      data: {
        username: 's4-submitter',
        passwordHash: '$2a$10$dummy-hash-not-used-since-service-direct',
        role: Role.USER,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });
    sheetSubmitterUserId = sheetSubmitter.id;

    // 摘码微刀(2026-07-03):独立 SA 终审身份(≠ submitter,避开 22074;sheet 无一级 reviewer)
    const finalReviewer = await prisma.user.create({
      data: {
        username: 's4-final-reviewer',
        passwordHash: '$2a$10$dummy-hash-not-used-since-service-direct',
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });
    finalReviewerPayload = {
      id: finalReviewer.id,
      username: 's4-final-reviewer',
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };

    alice = await makeMember('s4_alice');
    bob = await makeMember('s4_bob');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    config.activityResponsibilityWorkflow.enabled = false;
    // FK Restrict 顺序:孙/子表先删,父表后删;保留 member/user/org/dict。
    await prisma.notificationRead.deleteMany({});
    await prisma.notification.deleteMany({});
    await prisma.notificationOutboxIntent.deleteMany({});
    await prisma.activityResponsibilityAssignment.deleteMany({});
    await prisma.attendanceRecord.deleteMany({});
    await prisma.attendanceSheet.deleteMany({});
    await prisma.activityRegistration.deleteMany({});
    await prisma.activity.deleteMany({});
  });

  describe('活动发布/改期/自助退出通知', () => {
    it('PR-L2 red:公开活动 publish 与 audit 同事务写 broadcast intent，worker 前零 Notification', async () => {
      const activity = await prisma.activity.create({
        data: {
          title: 'durable 公开活动',
          activityTypeCode: 's4-type',
          organizationId: orgId,
          startAt: new Date('2099-08-01T08:00:00.000Z'),
          endAt: new Date('2099-08-01T12:00:00.000Z'),
          location: '梧桐山',
          statusCode: 'draft',
          isPublicRegistration: true,
        },
      });

      await activities.publish(
        activity.id,
        { requiresInsuranceConfirmed: true },
        adminPayload,
        AUDIT_META,
      );

      expect(
        await prisma.notificationOutboxIntent.findMany({
          where: { aggregateType: 'activity', aggregateId: activity.id },
          select: { eventType: true, status: true, destinationRef: true },
        }),
      ).toEqual([
        {
          eventType: 'notification.system-broadcast',
          status: 'pending',
          destinationRef: 'member',
        },
      ]);
      expect(await prisma.notification.count({})).toBe(0);
    });

    it('公开活动 publish → 一条 member broadcast/activity-published；非公开不广播', async () => {
      const makeDraft = (isPublicRegistration: boolean) =>
        prisma.activity.create({
          data: {
            title: isPublicRegistration ? '公开新活动' : '定向邀请活动',
            activityTypeCode: 's4-type',
            organizationId: orgId,
            startAt: new Date('2099-08-01T08:00:00.000Z'),
            endAt: new Date('2099-08-01T12:00:00.000Z'),
            location: '梧桐山',
            statusCode: 'draft',
            isPublicRegistration,
          },
        });
      const publicActivity = await makeDraft(true);
      const privateActivity = await makeDraft(false);

      await activities.publish(
        publicActivity.id,
        { requiresInsuranceConfirmed: true },
        adminPayload,
        AUDIT_META,
      );
      await activities.publish(
        privateActivity.id,
        { requiresInsuranceConfirmed: true },
        adminPayload,
        AUDIT_META,
      );

      expect(
        await prisma.notificationOutboxIntent.findMany({
          where: { aggregateType: 'activity', aggregateId: publicActivity.id },
          select: { eventType: true, destinationRef: true },
        }),
      ).toEqual([{ eventType: 'notification.system-broadcast', destinationRef: 'member' }]);
      expect(
        await prisma.notificationOutboxIntent.count({
          where: { aggregateType: 'activity', aggregateId: privateActivity.id },
        }),
      ).toBe(0);
      expect(await prisma.notification.count({})).toBe(0);
      await drainActivityIntents(publicActivity.id);
      const broadcasts = await prisma.notification.findMany({
        where: { audienceType: 'broadcast', sourceType: 'system' },
      });
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]).toMatchObject({
        notificationTypeCode: 'activity-published',
        title: '新活动已发布',
        recipientMemberId: null,
      });
      expect(await feedIds(alice.auth)).toContain(broadcasts[0].id);
      expect(await feedIds(bob.auth)).toContain(broadcasts[0].id);
    });

    it('start/end/location 变更 → pending+pass 收 activity-changed，body 含新旧值与保险提示', async () => {
      const activityId = await seedActivity('改期活动');
      await prisma.activity.update({
        where: { id: activityId },
        data: { requiresInsurance: true },
      });
      await seedRegistration(activityId, alice.memberId, 'pending');
      await seedRegistration(activityId, bob.memberId, 'pass');

      await activities.update(
        activityId,
        {
          startAt: '2026-08-02T08:00:00.000Z',
          endAt: '2026-08-02T12:00:00.000Z',
          location: '莲花山',
        },
        adminPayload,
        AUDIT_META,
      );

      expect(await prisma.notification.count({})).toBe(0);
      expect(
        await prisma.notificationOutboxIntent.count({
          where: { aggregateType: 'activity', aggregateId: activityId },
        }),
      ).toBe(2);
      await drainActivityIntents(activityId);
      const notifications = await prisma.notification.findMany({
        where: { notificationTypeCode: 'activity-changed' },
      });
      expect(notifications).toHaveLength(2);
      expect(new Set(notifications.map((item) => item.recipientMemberId))).toEqual(
        new Set([alice.memberId, bob.memberId]),
      );
      for (const notification of notifications) {
        expect(notification.body).toContain('2026-08-01T08:00:00.000Z');
        expect(notification.body).toContain('2026-08-02T08:00:00.000Z');
        expect(notification.body).toContain('S4 演示 → 莲花山');
        expect(notification.body).toContain('保险覆盖按原日期核验');
      }
    });

    it('gate=false 兼容：cancelMy → publishedBy 对应 member 经 outbox 收 activity-changed', async () => {
      const activityId = await seedActivity('自助退出活动');
      await prisma.activity.update({
        where: { id: activityId },
        data: { publishedBy: alice.userId },
      });
      const registrationId = await seedRegistration(activityId, bob.memberId, 'pending');
      const bobPayload = {
        id: bob.userId,
        username: 's4_bob',
        role: Role.USER,
        status: UserStatus.ACTIVE,
        memberId: bob.memberId,
      };

      await registrations.cancelMy(
        registrationId,
        { cancelReason: '临时有事' },
        bobPayload,
        AUDIT_META,
      );

      await drainTargetedIntent(registrationId, alice.memberId);
      const notification = await prisma.notification.findFirstOrThrow({
        where: { recipientMemberId: alice.memberId },
      });
      expect(notification).toMatchObject({
        notificationTypeCode: 'activity-changed',
        title: '队员取消活动报名',
      });
      expect(notification.body).toContain('临时有事');
      expect(
        await prisma.activityRegistration.findUniqueOrThrow({ where: { id: registrationId } }),
      ).toMatchObject({ statusCode: 'cancelled' });
    });

    it('gate=true：cancelMy 只通知 ACTIVE owner，不向 publishedBy fallback', async () => {
      config.activityResponsibilityWorkflow.enabled = true;
      const activityId = await seedActivity('责任模型自助退出');
      await prisma.activity.update({
        where: { id: activityId },
        data: { publishedBy: bob.userId },
      });
      await prisma.activityResponsibilityAssignment.create({
        data: {
          activityId,
          memberId: alice.memberId,
          responsibilityType: 'owner',
          canManageRegistrations: true,
          canManageAttendance: true,
          status: 'active',
          assignedByUserId: adminPayload.id,
          source: 'admin',
        },
      });
      const registrationId = await seedRegistration(activityId, bob.memberId, 'pending');

      await registrations.cancelMy(
        registrationId,
        {},
        {
          id: bob.userId,
          username: 's4_bob',
          role: Role.USER,
          status: UserStatus.ACTIVE,
          memberId: bob.memberId,
        },
        AUDIT_META,
      );

      await drainTargetedIntent(registrationId, alice.memberId);
      expect(await directedOf(alice.memberId)).toHaveLength(1);
      expect(await directedOf(bob.memberId)).toHaveLength(0);
      expect(
        await prisma.notificationOutboxIntent.count({
          where: { aggregateId: registrationId, destinationRef: bob.memberId },
        }),
      ).toBe(0);
    });
  });

  // ============ ① 报名审批结果(approve / reject)→ 报名本人 ============
  describe('报名审批结果定向通知(approve / reject → 报名本人;仅站内)', () => {
    it('PR-L1 red: approve 与 audit 同事务写 durable intent，worker 前零 Notification', async () => {
      const activityId = await seedActivity('原子审批活动');
      const regId = await seedRegistration(activityId, alice.memberId, 'pending');

      await registrations.approve(activityId, regId, {}, adminPayload, AUDIT_META);

      expect(
        await prisma.notificationOutboxIntent.findMany({
          where: { aggregateId: regId, destinationRef: alice.memberId },
          select: { eventType: true, status: true },
        }),
      ).toEqual([{ eventType: 'notification.targeted', status: 'pending' }]);
      expect(await directedOf(alice.memberId)).toHaveLength(0);
    });

    it('PR-L1 red: intent enqueue 失败使 approve + audit 整体回滚', async () => {
      const activityId = await seedActivity('intent 失败回滚活动');
      const regId = await seedRegistration(activityId, alice.memberId, 'pending');
      const spy = jest
        .spyOn(outbox, 'enqueue')
        .mockRejectedValue(new Error('intent insert failed'));
      try {
        await expect(
          registrations.approve(activityId, regId, {}, adminPayload, AUDIT_META),
        ).rejects.toThrow('intent insert failed');
        expect(
          await prisma.activityRegistration.findUniqueOrThrow({ where: { id: regId } }),
        ).toMatchObject({ statusCode: 'pending', reviewedAt: null });
        expect(
          await prisma.auditLog.count({
            where: { resourceId: regId, event: 'registration.review' },
          }),
        ).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('approve → alice 收一条 directed/system/registration-result/仅站内(含活动名);feed alice 可见、bob 404 防枚举', async () => {
      const activityId = await seedActivity('周末巡山');
      const regId = await seedRegistration(activityId, alice.memberId, 'pending');

      await registrations.approve(
        activityId,
        regId,
        { reviewNote: '材料齐全' },
        adminPayload,
        AUDIT_META,
      );

      await drainTargetedIntent(regId, alice.memberId);
      const notifs = await directedOf(alice.memberId);
      expect(notifs).toHaveLength(1);
      expect(notifs[0]).toMatchObject({
        audienceType: 'directed',
        sourceType: 'system',
        statusCode: 'published',
        notificationTypeCode: 'registration-result',
        authorUserId: null,
        recipientMemberId: alice.memberId,
      });
      expect(notifs[0].channels).toEqual(['in-app']); // S4 站内为主、微信 opt-in 延后
      expect(notifs[0].title).toBe('报名已通过');
      expect(notifs[0].body).toContain('周末巡山');

      // feed:alice 可见;bob list 不含 + detail 31001 防枚举
      expect(await feedIds(alice.auth)).toContain(notifs[0].id);
      expect(await feedIds(bob.auth)).not.toContain(notifs[0].id);
      expectBizError(await feedDetail(bob.auth, notifs[0].id), BizCode.NOTIFICATION_NOT_FOUND);
    });

    it('reject → alice 收「报名未通过」+ body 含活动名 + reviewNote 理由', async () => {
      const activityId = await seedActivity('夜间值守');
      const regId = await seedRegistration(activityId, alice.memberId, 'pending');

      await registrations.reject(
        activityId,
        regId,
        { reviewNote: '名额已满' },
        adminPayload,
        AUDIT_META,
      );

      await drainTargetedIntent(regId, alice.memberId);
      const notifs = await directedOf(alice.memberId);
      expect(notifs).toHaveLength(1);
      expect(notifs[0].title).toBe('报名未通过');
      expect(notifs[0].channels).toEqual(['in-app']);
      expect(notifs[0].body).toContain('夜间值守');
      expect(notifs[0].body).toContain('名额已满');
    });

    it('worker Effect 失败 → 业务保持已提交、intent 退避，重试后仅生成一条通知', async () => {
      const activityId = await seedActivity('应急集结');
      const regId = await seedRegistration(activityId, alice.memberId, 'pending');

      const res = await registrations.approve(activityId, regId, {}, adminPayload, AUDIT_META);
      expect(res.statusCode).toBe('pass');
      const intent = await prisma.notificationOutboxIntent.findFirstOrThrow({
        where: { aggregateId: regId, destinationRef: alice.memberId },
      });
      const spy = jest.spyOn(outboxHandlers, 'execute').mockRejectedValueOnce(new Error('boom'));
      try {
        await outboxWorker.drainEventKey(intent.eventKey);
        const reg = await prisma.activityRegistration.findUniqueOrThrow({ where: { id: regId } });
        expect(reg.statusCode).toBe('pass');
        expect(spy).toHaveBeenCalled();
        expect(await directedOf(alice.memberId)).toHaveLength(0);
        expect(
          await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: intent.id } }),
        ).toMatchObject({ status: 'pending', attempts: 1 });
      } finally {
        spy.mockRestore();
      }
      await prisma.notificationOutboxIntent.update({
        where: { id: intent.id },
        data: { availableAt: new Date(0) },
      });
      await outboxWorker.drainEventKey(intent.eventKey);
      expect(await directedOf(alice.memberId)).toHaveLength(1);
      expect(
        await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: intent.id } }),
      ).toMatchObject({ status: 'succeeded', attempts: 2 });
    });

    it('reject → reopen → approve 产生两个不同 review eventKey，均可各派发一次', async () => {
      const activityId = await seedActivity('重新审核活动');
      const regId = await seedRegistration(activityId, alice.memberId, 'pending');

      await registrations.reject(
        activityId,
        regId,
        { reviewNote: '首次驳回' },
        adminPayload,
        AUDIT_META,
      );
      await registrations.reopen(activityId, regId, adminPayload, AUDIT_META);
      await registrations.approve(activityId, regId, {}, adminPayload, AUDIT_META);

      const intents = await prisma.notificationOutboxIntent.findMany({
        where: { aggregateId: regId, destinationRef: alice.memberId },
        orderBy: { createdAt: 'asc' },
      });
      expect(intents).toHaveLength(2);
      expect(new Set(intents.map((intent) => intent.eventKey)).size).toBe(2);
      expect(intents.map((intent) => intent.eventKey)).toEqual([
        expect.stringMatching(/^registration-review:.+:1$/),
        expect.stringMatching(/^registration-review:.+:3$/),
      ]);
      expect(await directedOf(alice.memberId)).toHaveLength(0);
      for (const intent of intents) await outboxWorker.drainEventKey(intent.eventKey);
      expect(await directedOf(alice.memberId)).toHaveLength(2);
    });
  });

  // ============ ② 活动取消 → 遍历已报名者逐人(N 报名者各一条) ============
  describe('活动取消定向通知(cancel → 已报名者 fan-out;N 报名者各一条)', () => {
    it('PR-L2 red:取消 intent 写失败使 activity + registration + audit 整体回滚', async () => {
      const activityId = await seedActivity('取消 intent 回滚');
      const registrationId = await seedRegistration(activityId, alice.memberId, 'pending');
      const spy = jest
        .spyOn(outbox, 'enqueue')
        .mockRejectedValue(new Error('activity intent insert failed'));
      try {
        await expect(
          activities.cancel(activityId, { cancelReason: '故障注入' }, adminPayload, AUDIT_META),
        ).rejects.toThrow('activity intent insert failed');
        expect(
          await prisma.activity.findUniqueOrThrow({
            where: { id: activityId },
            select: { statusCode: true, cancelledAt: true },
          }),
        ).toEqual({ statusCode: 'published', cancelledAt: null });
        expect(
          await prisma.activityRegistration.findUniqueOrThrow({
            where: { id: registrationId },
            select: { statusCode: true, cancelledAt: true },
          }),
        ).toEqual({ statusCode: 'pending', cancelledAt: null });
        expect(
          await prisma.auditLog.count({
            where: { resourceId: activityId, event: 'activity.publish' },
          }),
        ).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('取消 → alice(pending)+ bob(pass)各收一条「活动已取消」(含活动名+原因);各自 feed 仅见本人', async () => {
      const activityId = await seedActivity('山地搜救演练');
      await seedRegistration(activityId, alice.memberId, 'pending');
      await seedRegistration(activityId, bob.memberId, 'pass');

      await activities.cancel(activityId, { cancelReason: '暴雨预警' }, adminPayload, AUDIT_META);

      expect(await prisma.notification.count({})).toBe(0);
      await drainActivityIntents(activityId);
      const aliceNotifs = await directedOf(alice.memberId);
      const bobNotifs = await directedOf(bob.memberId);
      expect(aliceNotifs).toHaveLength(1);
      expect(bobNotifs).toHaveLength(1);
      for (const n of [aliceNotifs[0], bobNotifs[0]]) {
        expect(n).toMatchObject({
          audienceType: 'directed',
          sourceType: 'system',
          notificationTypeCode: 'activity-changed',
          title: '活动已取消',
        });
        expect(n.channels).toEqual(['in-app']);
        expect(n.body).toContain('山地搜救演练');
        expect(n.body).toContain('暴雨预警');
      }
      // 各自 feed 仅见本人定向(交叉不可见)
      expect(await feedIds(alice.auth)).toEqual([aliceNotifs[0].id]);
      expect(await feedIds(bob.auth)).toEqual([bobNotifs[0].id]);
    });

    it('真并发:取消等待并发新报名提交后,联动取消的新报名者也收到取消通知', async () => {
      const activityId = await seedActivity('并发海岸巡查');
      const hooks = registrations as unknown as RegistrationCreateTestHooks;
      const originalResolve = hooks.resolveCreateStatusCode.bind(registrations);
      const createPaused = deferred<number>();
      const releaseCreate = deferred<void>();
      const resolveSpy = jest
        .spyOn(hooks, 'resolveCreateStatusCode')
        .mockImplementation(async (...args) => {
          const statusCode = await originalResolve(...args);
          const [backend] = await args[4].$queryRaw<Array<{ pid: number }>>`
            SELECT pg_backend_pid() AS pid
          `;
          createPaused.resolve(backend.pid);
          await releaseCreate.promise;
          return statusCode;
        });

      let createPromise: ReturnType<ActivityRegistrationsService['create']> | undefined;
      let cancelPromise: ReturnType<ActivitiesService['cancel']> | undefined;
      try {
        createPromise = registrations.create(
          activityId,
          { memberId: alice.memberId },
          adminPayload,
          AUDIT_META,
        );
        const blockerPid = await createPaused.promise;
        cancelPromise = activities.cancel(
          activityId,
          { cancelReason: '风浪升级' },
          adminPayload,
          AUDIT_META,
        );
        const observation = await observeBlockedByBackend(prisma, blockerPid, cancelPromise);
        releaseCreate.resolve();
        const [created, cancelled] = await Promise.all([createPromise, cancelPromise]);

        // 本测试杀死「Activity claim 前快照收件集」错误：旧实现会在 create 未提交时读到空集，
        // 随后虽联动取消新报名，却不会给该 member 派发活动取消通知。
        expect(observation).toBe('blocked');
        expect(created.statusCode).toBe('pending');
        expect(cancelled.statusCode).toBe('cancelled');
        expect(
          await prisma.activityRegistration.findFirstOrThrow({
            where: { activityId, memberId: alice.memberId, deletedAt: null },
            select: { statusCode: true },
          }),
        ).toEqual({ statusCode: 'cancelled' });
        await drainActivityIntents(activityId);
        expect(await directedOf(alice.memberId)).toEqual([
          expect.objectContaining({
            notificationTypeCode: 'activity-changed',
            title: '活动已取消',
          }),
        ]);
      } finally {
        releaseCreate.resolve();
        const pending: Promise<unknown>[] = [];
        if (createPromise !== undefined) pending.push(createPromise);
        if (cancelPromise !== undefined) pending.push(cancelPromise);
        await Promise.allSettled(pending);
        resolveSpy.mockRestore();
      }
    });

    it('已 reject / cancelled 报名者不在收件人列(只 pending + pass)', async () => {
      const activityId = await seedActivity('城市定向');
      await seedRegistration(activityId, alice.memberId, 'pass');
      await seedRegistration(activityId, bob.memberId, 'reject'); // 已出局,不通知

      await activities.cancel(activityId, { cancelReason: '场地不可用' }, adminPayload, AUDIT_META);

      await drainActivityIntents(activityId);
      expect(await directedOf(alice.memberId)).toHaveLength(1);
      expect(await directedOf(bob.memberId)).toHaveLength(0);
    });

    it('worker Effect 失败 → 取消保持已提交、intent 退避，重试后仅生成一条通知', async () => {
      const activityId = await seedActivity('夜训');
      await seedRegistration(activityId, alice.memberId, 'pass');

      const res = await activities.cancel(activityId, {}, adminPayload, AUDIT_META);
      expect(res.statusCode).toBe('cancelled');
      const intent = await prisma.notificationOutboxIntent.findFirstOrThrow({
        where: {
          aggregateType: 'activity',
          aggregateId: activityId,
          destinationRef: alice.memberId,
        },
      });
      const spy = jest.spyOn(outboxHandlers, 'execute').mockRejectedValueOnce(new Error('boom'));
      try {
        await outboxWorker.drainEventKey(intent.eventKey);
        const act = await prisma.activity.findUniqueOrThrow({ where: { id: activityId } });
        expect(act.statusCode).toBe('cancelled');
        expect(spy).toHaveBeenCalled();
        expect(await directedOf(alice.memberId)).toHaveLength(0);
        expect(
          await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: intent.id } }),
        ).toMatchObject({ status: 'pending', attempts: 1 });
      } finally {
        spy.mockRestore();
      }
      await prisma.notificationOutboxIntent.update({
        where: { id: intent.id },
        data: { availableAt: new Date(0) },
      });
      await outboxWorker.drainEventKey(intent.eventKey);
      expect(await directedOf(alice.memberId)).toHaveLength(1);
      expect(
        await prisma.notificationOutboxIntent.findUniqueOrThrow({ where: { id: intent.id } }),
      ).toMatchObject({ status: 'succeeded', attempts: 2 });
    });
  });

  // ============ ③ 考勤终审通过 → 逐 record 本人(含贡献值) ============
  describe('考勤结果/贡献值定向通知(finalApprove → 逐 record 本人;仅站内)', () => {
    it('finalApprove → alice + bob 各收一条「考勤结果已确认」(含活动名+贡献值);feed 仅见本人', async () => {
      const activityId = await seedActivity('汛期值守');
      const sheetId = await seedSheetPendingFinal(activityId, [alice.memberId, bob.memberId]);

      await attendances.finalApprove(
        sheetId,
        { finalReviewNote: 'ok' },
        finalReviewerPayload,
        AUDIT_META,
      );

      const aliceNotifs = await directedOf(alice.memberId);
      const bobNotifs = await directedOf(bob.memberId);
      expect(aliceNotifs).toHaveLength(1);
      expect(bobNotifs).toHaveLength(1);
      for (const n of [aliceNotifs[0], bobNotifs[0]]) {
        expect(n).toMatchObject({
          audienceType: 'directed',
          sourceType: 'system',
          notificationTypeCode: 'attendance-result',
          title: '考勤结果已确认',
        });
        expect(n.channels).toEqual(['in-app']);
        expect(n.body).toContain('汛期值守');
        expect(n.body).toContain('贡献值');
      }
      expect(await feedIds(alice.auth)).toEqual([aliceNotifs[0].id]);
      expect(await feedIds(bob.auth)).toEqual([bobNotifs[0].id]);
    });

    it('注入 dispatcher 抛错 → **终审仍成功**(sheet=approved 已 commit;贡献值行为锁未破)', async () => {
      const activityId = await seedActivity('防汛拉练');
      const sheetId = await seedSheetPendingFinal(activityId, [alice.memberId]);

      const spy = jest
        .spyOn(dispatcher, 'dispatchTargeted')
        .mockRejectedValue(new Error('dispatch boom'));
      try {
        const res = await attendances.finalApprove(
          sheetId,
          { finalReviewNote: 'ok' },
          finalReviewerPayload,
          AUDIT_META,
        );
        expect(res.statusCode).toBe('approved');
        const sheet = await prisma.attendanceSheet.findUniqueOrThrow({ where: { id: sheetId } });
        expect(sheet.statusCode).toBe('approved'); // 终审产物已 commit
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });
});
