import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityRegistrationsService } from '../../src/modules/activity-registrations/activity-registrations.service';
import { AppMyRegistrationsService } from '../../src/modules/activity-registrations/app-my-registrations.service';
import { ActivitiesService } from '../../src/modules/activities/activities.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { AppActivityCheckInsService } from '../../src/modules/attendances/app-activity-check-ins.service';
import { MetaService } from '../../src/modules/meta/meta.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const AUDIT_META: AuditMeta = {
  requestId: 'waitlist-e2e-req-000000000001',
  ip: '127.0.0.1',
  ua: 'jest/activity-registration-waitlist',
};

describe('activity registration waitlist', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let registrations: ActivityRegistrationsService;
  let appRegistrations: AppMyRegistrationsService;
  let activities: ActivitiesService;
  let dashboard: MetaService;
  let appCheckIns: AppActivityCheckInsService;
  let organizationId: string;
  let admin: CurrentUserPayload;
  let sequence = 0;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    registrations = app.get(ActivityRegistrationsService);
    appRegistrations = app.get(AppMyRegistrationsService);
    activities = app.get(ActivitiesService);
    dashboard = app.get(MetaService);
    appCheckIns = app.get(AppActivityCheckInsService);

    const adminUser = await createTestUser(app, {
      username: 'waitlist-super-admin',
      role: Role.SUPER_ADMIN,
    });
    admin = {
      id: adminUser.id,
      username: adminUser.username,
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };

    const root = await prisma.organization.create({
      data: { name: 'Waitlist Root', nodeTypeCode: 'root' },
      select: { id: true },
    });
    organizationId = (
      await prisma.organization.create({
        data: { name: 'Waitlist Child', nodeTypeCode: 'team', parentId: root.id },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  async function createMember(label: string): Promise<string> {
    sequence += 1;
    return (
      await prisma.member.create({
        data: {
          memberNo: `waitlist-${label}-${sequence}`,
          displayName: `Waitlist ${label} ${sequence}`,
        },
        select: { id: true },
      })
    ).id;
  }

  async function createMemberUser(label: string): Promise<{
    memberId: string;
    user: CurrentUserPayload;
  }> {
    const memberId = await createMember(label);
    const user = await createTestUser(app, {
      username: `waitlist-${label}-${sequence}`,
      role: Role.USER,
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId } });
    return {
      memberId,
      user: {
        id: user.id,
        username: user.username,
        role: Role.USER,
        status: UserStatus.ACTIVE,
        memberId,
      },
    };
  }

  async function createActivity(capacity: number | null, title: string): Promise<string> {
    sequence += 1;
    return (
      await prisma.activity.create({
        data: {
          title: `${title}-${sequence}`,
          activityTypeCode: 'waitlist-e2e-type',
          organizationId,
          startAt: new Date('2099-07-15T08:00:00.000Z'),
          endAt: new Date('2099-07-15T12:00:00.000Z'),
          location: 'Waitlist E2E',
          statusCode: 'published',
          isPublicRegistration: true,
          capacity,
        },
        select: { id: true },
      })
    ).id;
  }

  async function seedRegistration(
    activityId: string,
    memberId: string,
    statusCode: string,
    registeredAt?: Date,
  ) {
    return prisma.activityRegistration.create({
      data: {
        activityId,
        memberId,
        statusCode,
        ...(registeredAt ? { registeredAt } : {}),
      },
    });
  }

  it('满员 Admin/self/App 创建均进候补；App 详情/列表与 Admin 列表返回全局 FIFO 排位，候补占防重槽', async () => {
    const activityId = await createActivity(1, 'create-and-read');
    await seedRegistration(activityId, await createMember('pass'), 'pass');
    const adminMember = await createMember('admin-create');
    const self = await createMemberUser('self-create');
    const appSelf = await createMemberUser('app-create');

    const first = await registrations.create(
      activityId,
      { memberId: adminMember },
      admin,
      AUDIT_META,
    );
    const second = await registrations.createMy(activityId, {}, self.user, AUDIT_META);
    const third = await appRegistrations.createMyForApp(appSelf.user, { activityId }, AUDIT_META);

    expect([first.statusCode, second.statusCode, third.statusCode]).toEqual([
      'waitlisted',
      'waitlisted',
      'waitlisted',
    ]);
    expect(third.waitlistPosition).toBe(3);

    const detail = await appRegistrations.findMyForApp(third.id, appSelf.user);
    expect(detail.waitlistPosition).toBe(3);
    const appList = await appRegistrations.listMyForApp({ page: 1, pageSize: 20 }, appSelf.user);
    expect(appList.items).toEqual([
      expect.objectContaining({ id: third.id, statusCode: 'waitlisted', waitlistPosition: 3 }),
    ]);

    const adminList = await registrations.list(
      activityId,
      { page: 1, pageSize: 20, statusCode: 'waitlisted' },
      admin,
    );
    expect(new Map(adminList.items.map((item) => [item.id, item.waitlistPosition]))).toEqual(
      new Map([
        [first.id, 1],
        [second.id, 2],
        [third.id, 3],
      ]),
    );

    await expect(
      registrations.create(activityId, { memberId: adminMember }, admin, AUDIT_META),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_REGISTRATION_ALREADY_EXISTS });

    const summary = await dashboard.dashboardSummary(admin);
    expect(summary.registrations?.waitlisted).toBe(
      await prisma.activityRegistration.count({ where: { statusCode: 'waitlisted' } }),
    );
  });

  it('取消 pass 同事务只递补 FIFO 队首，写 promote audit，commit 后通知本人', async () => {
    const activityId = await createActivity(1, 'cancel-promote');
    const pass = await seedRegistration(activityId, await createMember('cancel-pass'), 'pass');
    const firstMemberId = await createMember('queue-first');
    const secondMemberId = await createMember('queue-second');
    const tiedRegisteredAt = new Date('2026-07-15T01:00:00.000Z');
    const first = await seedRegistration(activityId, firstMemberId, 'waitlisted', tiedRegisteredAt);
    const second = await seedRegistration(
      activityId,
      secondMemberId,
      'waitlisted',
      tiedRegisteredAt,
    );
    const [fifoHead, fifoTail] = [first, second].sort((a, b) => a.id.localeCompare(b.id));
    const fifoHeadMemberId = fifoHead.id === first.id ? firstMemberId : secondMemberId;

    await registrations.cancelAdmin(activityId, pass.id, {}, admin, AUDIT_META);

    expect(
      await prisma.activityRegistration.findMany({
        where: { id: { in: [first.id, second.id] } },
        select: { id: true, statusCode: true },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(
      [
        { id: fifoHead.id, statusCode: 'pending' },
        { id: fifoTail.id, statusCode: 'waitlisted' },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { resourceId: fifoHead.id, event: 'registration.review' },
    });
    expect(audit.context).toMatchObject({
      before: { statusCode: 'waitlisted' },
      after: { statusCode: 'pending' },
      extra: { action: 'promote', priorStatusCode: 'waitlisted', nextStatusCode: 'pending' },
    });
    expect(
      await prisma.notification.findFirst({
        where: { recipientMemberId: fifoHeadMemberId, title: '候补已递补' },
        select: { body: true, notificationTypeCode: true, channels: true },
      }),
    ).toEqual({
      body: expect.stringContaining('进入待审核'),
      notificationTypeCode: 'registration-result',
      channels: ['in-app'],
    });
  });

  it('取消 pending 或 waitlisted 不触发递补', async () => {
    const activityId = await createActivity(1, 'cancel-without-promotion');
    const pass = await seedRegistration(activityId, await createMember('no-promote-pass'), 'pass');
    const pending = await seedRegistration(
      activityId,
      await createMember('no-promote-pending'),
      'pending',
    );
    const self = await createMemberUser('no-promote-waitlisted');
    const selfWaitlisted = await seedRegistration(activityId, self.memberId, 'waitlisted');
    const queueTail = await seedRegistration(
      activityId,
      await createMember('no-promote-tail'),
      'waitlisted',
    );

    await registrations.cancelAdmin(activityId, pending.id, {}, admin, AUDIT_META);
    await registrations.cancelMy(selfWaitlisted.id, {}, self.user, AUDIT_META);

    expect(
      await prisma.activityRegistration.findMany({
        where: { id: { in: [pass.id, pending.id, selfWaitlisted.id, queueTail.id] } },
        select: { id: true, statusCode: true },
      }),
    ).toEqual(
      expect.arrayContaining([
        { id: pass.id, statusCode: 'pass' },
        { id: pending.id, statusCode: 'cancelled' },
        { id: selfWaitlisted.id, statusCode: 'cancelled' },
        { id: queueTail.id, statusCode: 'waitlisted' },
      ]),
    );
    expect(
      await prisma.auditLog.count({
        where: { resourceId: queueTail.id, event: 'registration.review' },
      }),
    ).toBe(0);
  });

  it('capacity 调大递补 delta、改 null 递补全部；缩容不递补', async () => {
    const activityId = await createActivity(1, 'capacity-promote');
    await seedRegistration(activityId, await createMember('capacity-pass'), 'pass');
    const queue = await Promise.all(
      [1, 2, 3].map(async (n) =>
        seedRegistration(
          activityId,
          await createMember(`capacity-q${n}`),
          'waitlisted',
          new Date(`2026-07-15T0${n}:00:00.000Z`),
        ),
      ),
    );

    await activities.update(activityId, { capacity: 3 }, admin, AUDIT_META);
    expect(
      await prisma.activityRegistration.findMany({
        where: { id: { in: queue.map((item) => item.id) } },
        select: { id: true, statusCode: true },
        orderBy: { registeredAt: 'asc' },
      }),
    ).toEqual([
      { id: queue[0].id, statusCode: 'pending' },
      { id: queue[1].id, statusCode: 'pending' },
      { id: queue[2].id, statusCode: 'waitlisted' },
    ]);

    await activities.update(activityId, { capacity: null }, admin, AUDIT_META);
    expect(
      await prisma.activityRegistration.findUniqueOrThrow({
        where: { id: queue[2].id },
        select: { statusCode: true },
      }),
    ).toEqual({ statusCode: 'pending' });

    const shrinkActivityId = await createActivity(3, 'capacity-shrink');
    await seedRegistration(shrinkActivityId, await createMember('shrink-pass'), 'pass');
    const waiting = await seedRegistration(
      shrinkActivityId,
      await createMember('shrink-wait'),
      'waitlisted',
    );
    await activities.update(shrinkActivityId, { capacity: 2 }, admin, AUDIT_META);
    expect(
      await prisma.activityRegistration.findUniqueOrThrow({
        where: { id: waiting.id },
        select: { statusCode: true },
      }),
    ).toEqual({ statusCode: 'waitlisted' });
  });

  it('并发同值 capacity 调大只按净增名额递补（delta 基线取锁后重读）', async () => {
    const activityId = await createActivity(1, 'concurrent-capacity');
    await seedRegistration(activityId, await createMember('cap-race-pass'), 'pass');
    const queue = await Promise.all(
      [1, 2, 3, 4].map(async (n) =>
        seedRegistration(
          activityId,
          await createMember(`cap-race-q${n}`),
          'waitlisted',
          new Date(`2026-07-15T0${n}:00:00.000Z`),
        ),
      ),
    );

    // 双击 / 重试:两个事务携同一 dto.capacity=3 并发。净增名额 = 3-1 = 2,故全程只应递补 2 名。
    // delta 基线若沿用取锁前的陈旧 capacity,两个事务会各自算出 delta=2 → 误递补 4 名。
    const results = await Promise.allSettled([
      activities.update(activityId, { capacity: 3 }, admin, AUDIT_META),
      activities.update(activityId, { capacity: 3 }, admin, AUDIT_META),
    ]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);

    expect(
      await prisma.activityRegistration.findMany({
        where: { id: { in: queue.map((item) => item.id) } },
        select: { id: true, statusCode: true },
        orderBy: { registeredAt: 'asc' },
      }),
    ).toEqual([
      { id: queue[0].id, statusCode: 'pending' },
      { id: queue[1].id, statusCode: 'pending' },
      { id: queue[2].id, statusCode: 'waitlisted' },
      { id: queue[3].id, statusCode: 'waitlisted' },
    ]);
  });

  it('并发取消两个 pass 由 Activity 行锁串行化，两个不同候补各递补一次', async () => {
    const activityId = await createActivity(2, 'concurrent-cancel');
    const pass1 = await seedRegistration(activityId, await createMember('race-pass1'), 'pass');
    const pass2 = await seedRegistration(activityId, await createMember('race-pass2'), 'pass');
    const wait1 = await seedRegistration(
      activityId,
      await createMember('race-wait1'),
      'waitlisted',
      new Date('2026-07-15T01:00:00.000Z'),
    );
    const wait2 = await seedRegistration(
      activityId,
      await createMember('race-wait2'),
      'waitlisted',
      new Date('2026-07-15T02:00:00.000Z'),
    );

    const results = await Promise.allSettled([
      registrations.cancelAdmin(activityId, pass1.id, {}, admin, AUDIT_META),
      registrations.cancelAdmin(activityId, pass2.id, {}, admin, AUDIT_META),
    ]);
    expect(results).toEqual([
      expect.objectContaining({ status: 'fulfilled' }),
      expect.objectContaining({ status: 'fulfilled' }),
    ]);

    const promoted = await prisma.activityRegistration.findMany({
      where: { id: { in: [wait1.id, wait2.id] } },
      select: { id: true, statusCode: true },
    });
    expect(promoted).toEqual(
      expect.arrayContaining([
        { id: wait1.id, statusCode: 'pending' },
        { id: wait2.id, statusCode: 'pending' },
      ]),
    );
    const promoteAudits = await prisma.auditLog.findMany({
      where: { resourceId: { in: [wait1.id, wait2.id] }, event: 'registration.review' },
      select: { resourceId: true, context: true },
    });
    expect(promoteAudits).toHaveLength(2);
    expect(new Set(promoteAudits.map((item) => item.resourceId)).size).toBe(2);
  });

  it('活动取消联动 pending+waitlisted→cancelled；waitlisted 仍不能签到', async () => {
    const activityId = await createActivity(3, 'activity-cancel');
    const pending = await seedRegistration(
      activityId,
      await createMember('activity-pending'),
      'pending',
    );
    const waitlisted = await seedRegistration(
      activityId,
      await createMember('activity-waitlisted'),
      'waitlisted',
    );
    const pass = await seedRegistration(activityId, await createMember('activity-pass'), 'pass');

    await activities.cancel(activityId, {}, admin, AUDIT_META);
    expect(
      await prisma.activityRegistration.findMany({
        where: { id: { in: [pending.id, waitlisted.id, pass.id] } },
        select: { id: true, statusCode: true },
      }),
    ).toEqual(
      expect.arrayContaining([
        { id: pending.id, statusCode: 'cancelled' },
        { id: waitlisted.id, statusCode: 'cancelled' },
        { id: pass.id, statusCode: 'pass' },
      ]),
    );

    const checkInActivityId = await createActivity(1, 'waitlisted-check-in');
    const checkInUser = await createMemberUser('check-in');
    await seedRegistration(checkInActivityId, checkInUser.memberId, 'waitlisted');
    await expect(
      appCheckIns.checkIn(
        checkInActivityId,
        { longitude: 114.1, latitude: 22.5 },
        checkInUser.user,
      ),
    ).rejects.toMatchObject({ biz: BizCode.ATTENDANCE_REGISTRATION_INVALID });
  });
});
