import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityRegistrationsService } from '../../src/modules/activity-registrations/activity-registrations.service';
import { AppMyRegistrationsService } from '../../src/modules/activity-registrations/app-my-registrations.service';
import { ActivitiesService } from '../../src/modules/activities/activities.service';
import { ActivityPositionsService } from '../../src/modules/activities/activity-positions.service';
import { AppActivitiesService } from '../../src/modules/activities/app-activities.service';
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
  let activityPositions: ActivityPositionsService;
  let appActivities: AppActivitiesService;
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
    activityPositions = app.get(ActivityPositionsService);
    appActivities = app.get(AppActivitiesService);
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
    activityPositionId?: string,
  ) {
    return prisma.activityRegistration.create({
      data: {
        activityId,
        memberId,
        statusCode,
        ...(activityPositionId ? { activityPositionId } : {}),
        ...(registeredAt ? { registeredAt } : {}),
      },
    });
  }

  async function createActivityPosition(
    activityId: string,
    capacity: number | null,
    label: string,
    genderRequirementCode: string | null = null,
  ): Promise<string> {
    sequence += 1;
    return (
      await prisma.activityPosition.create({
        data: {
          activityId,
          name: `${label}-${sequence}`,
          attendanceRoleCode: 'member',
          capacity,
          genderRequirementCode,
        },
        select: { id: true },
      })
    ).id;
  }

  async function createMemberProfile(
    memberId: string,
    genderCode: 'male' | 'female',
  ): Promise<void> {
    sequence += 1;
    await prisma.memberProfile.create({
      data: {
        memberId,
        realName: '岗位性别闸测试',
        genderCode,
        birthDate: new Date('1990-01-01T00:00:00.000Z'),
        documentTypeCode: 'id_card',
        documentNumber: `position-gender-${sequence}`,
        mobile: `139${String(sequence).padStart(8, '0')}`,
        joinedDate: new Date('2020-01-01T00:00:00.000Z'),
        joinSourceCode: 'recommend',
        privacyConsentSigned: true,
      },
    });
  }

  it('有岗位活动三路报名均写 activityPositionId；未选岗位 21035；跨岗位仍受一人一活动 21002', async () => {
    const activityId = await createActivity(99, 'three-create-paths');
    const activityPositionAId = await createActivityPosition(activityId, null, '岗位-A');
    const activityPositionBId = await createActivityPosition(activityId, null, '岗位-B');
    const adminMemberId = await createMember('position-admin');
    const self = await createMemberUser('position-self');
    const appSelf = await createMemberUser('position-app');

    await expect(
      registrations.create(activityId, { memberId: adminMemberId }, admin, AUDIT_META),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_POSITION_REQUIRED });

    const adminCreated = await registrations.create(
      activityId,
      { memberId: adminMemberId, activityPositionId: activityPositionAId },
      admin,
      AUDIT_META,
    );
    const selfCreated = await registrations.createMy(
      activityId,
      { activityPositionId: activityPositionAId },
      self.user,
      AUDIT_META,
    );
    const appCreated = await appRegistrations.createMyForApp(
      appSelf.user,
      { activityId, activityPositionId: activityPositionBId },
      AUDIT_META,
    );

    expect(
      await prisma.activityRegistration.findMany({
        where: { id: { in: [adminCreated.id, selfCreated.id, appCreated.id] } },
        select: { id: true, activityPositionId: true },
      }),
    ).toEqual(
      expect.arrayContaining([
        { id: adminCreated.id, activityPositionId: activityPositionAId },
        { id: selfCreated.id, activityPositionId: activityPositionAId },
        { id: appCreated.id, activityPositionId: activityPositionBId },
      ]),
    );

    await expect(
      registrations.create(
        activityId,
        { memberId: adminMemberId, activityPositionId: activityPositionBId },
        admin,
        AUDIT_META,
      ),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_REGISTRATION_ALREADY_EXISTS });

    const adminList = await registrations.list(activityId, { page: 1, pageSize: 20 }, admin);
    expect(adminList.items.find((item) => item.id === adminCreated.id)?.activityPosition).toEqual({
      activityPositionId: activityPositionAId,
      name: expect.stringContaining('岗位-A'),
    });
  });

  it('活动性别闸先判、岗位性别闸叠加，二者均通过才创建', async () => {
    const activityId = await createActivity(99, 'position-gender-gates');
    await prisma.activity.update({
      where: { id: activityId },
      data: { genderRequirementCode: 'female' },
    });
    const maleActivityPositionId = await createActivityPosition(
      activityId,
      null,
      '仅男性岗位',
      'male',
    );
    const femaleActivityPositionId = await createActivityPosition(
      activityId,
      null,
      '仅女性岗位',
      'female',
    );
    const maleMemberId = await createMember('position-gender-male');
    const femaleForMaleActivityPositionId = await createMember('position-gender-position-fail');
    const femaleMemberId = await createMember('position-gender-pass');
    await createMemberProfile(maleMemberId, 'male');
    await createMemberProfile(femaleForMaleActivityPositionId, 'female');
    await createMemberProfile(femaleMemberId, 'female');

    await expect(
      registrations.create(
        activityId,
        { memberId: maleMemberId, activityPositionId: femaleActivityPositionId },
        admin,
        AUDIT_META,
      ),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_REGISTRATION_GENDER_MISMATCH });
    await expect(
      registrations.create(
        activityId,
        {
          memberId: femaleForMaleActivityPositionId,
          activityPositionId: maleActivityPositionId,
        },
        admin,
        AUDIT_META,
      ),
    ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_REGISTRATION_GENDER_MISMATCH });
    await expect(
      registrations.create(
        activityId,
        { memberId: femaleMemberId, activityPositionId: femaleActivityPositionId },
        admin,
        AUDIT_META,
      ),
    ).resolves.toMatchObject({ statusCode: 'pending' });
  });

  it('岗位满员按岗位分别排位；App 岗位余量为 0 仍 canRegister；Activity capacity 读侧派生岗位和', async () => {
    const activityId = await createActivity(99, 'position-capacity-read');
    const activityPositionAId = await createActivityPosition(activityId, 1, '读侧-A');
    const activityPositionBId = await createActivityPosition(activityId, 2, '读侧-B');
    await seedRegistration(
      activityId,
      await createMember('position-pass-a'),
      'pass',
      undefined,
      activityPositionAId,
    );
    await seedRegistration(
      activityId,
      await createMember('position-pass-b1'),
      'pass',
      undefined,
      activityPositionBId,
    );
    await seedRegistration(
      activityId,
      await createMember('position-pass-b2'),
      'pass',
      undefined,
      activityPositionBId,
    );
    const tiedAt = new Date('2026-07-16T01:00:00.000Z');
    const waitA1 = await seedRegistration(
      activityId,
      await createMember('position-wait-a1'),
      'waitlisted',
      tiedAt,
      activityPositionAId,
    );
    const waitA2 = await seedRegistration(
      activityId,
      await createMember('position-wait-a2'),
      'waitlisted',
      new Date('2026-07-16T02:00:00.000Z'),
      activityPositionAId,
    );
    const waitB1 = await seedRegistration(
      activityId,
      await createMember('position-wait-b1'),
      'waitlisted',
      tiedAt,
      activityPositionBId,
    );

    const adminList = await registrations.list(
      activityId,
      { page: 1, pageSize: 20, statusCode: 'waitlisted' },
      admin,
    );
    const waitlistById = new Map(adminList.items.map((item) => [item.id, item.waitlistPosition]));
    expect(waitlistById.get(waitA1.id)).toBe(1);
    expect(waitlistById.get(waitA2.id)).toBe(2);
    expect(waitlistById.get(waitB1.id)).toBe(1);

    const browsingMemberId = await createMember('position-browser');
    const appPositionItems = await appActivities.listPositionsForMember(
      activityId,
      browsingMemberId,
    );
    expect(appPositionItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activityPositionId: activityPositionAId,
          remainingCapacity: 0,
          canRegister: true,
        }),
        expect.objectContaining({
          activityPositionId: activityPositionBId,
          remainingCapacity: 0,
          canRegister: true,
        }),
      ]),
    );
    const activityDetail = await appActivities.findVisibleByIdForMember(
      activityId,
      browsingMemberId,
    );
    expect(activityDetail.capacity).toBe(3);
  });

  it('同岗位 pass 取消只递补同岗队首，跨岗位候补保持不动', async () => {
    const activityId = await createActivity(99, 'position-cancel-scope');
    const activityPositionAId = await createActivityPosition(activityId, 1, '取消-A');
    const activityPositionBId = await createActivityPosition(activityId, 1, '取消-B');
    const passA = await seedRegistration(
      activityId,
      await createMember('position-cancel-pass-a'),
      'pass',
      undefined,
      activityPositionAId,
    );
    const waitA = await seedRegistration(
      activityId,
      await createMember('position-cancel-wait-a'),
      'waitlisted',
      new Date('2026-07-16T01:00:00.000Z'),
      activityPositionAId,
    );
    const waitB = await seedRegistration(
      activityId,
      await createMember('position-cancel-wait-b'),
      'waitlisted',
      new Date('2026-07-16T00:00:00.000Z'),
      activityPositionBId,
    );

    await registrations.cancelAdmin(activityId, passA.id, {}, admin, AUDIT_META);

    expect(
      await prisma.activityRegistration.findMany({
        where: { id: { in: [waitA.id, waitB.id] } },
        select: { id: true, statusCode: true },
      }),
    ).toEqual(
      expect.arrayContaining([
        { id: waitA.id, statusCode: 'pending' },
        { id: waitB.id, statusCode: 'waitlisted' },
      ]),
    );
  });

  it('同岗位并发 approve 由 Activity 锁串行化，pass 不超过岗位 capacity', async () => {
    const activityId = await createActivity(99, 'position-concurrent-approve');
    const activityPositionId = await createActivityPosition(activityId, 1, '并发审批');
    const pending = await Promise.all(
      [1, 2].map(async (n) =>
        seedRegistration(
          activityId,
          await createMember(`position-approve-${n}`),
          'pending',
          undefined,
          activityPositionId,
        ),
      ),
    );

    const results = await Promise.allSettled(
      pending.map((registration) =>
        registrations.approve(activityId, registration.id, {}, admin, AUDIT_META),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      await prisma.activityRegistration.count({
        where: { activityId, activityPositionId, statusCode: 'pass', deletedAt: null },
      }),
    ).toBe(1);
  });

  it('同岗位并发取消两个 pass 不会双递补同一候补', async () => {
    const activityId = await createActivity(99, 'position-concurrent-cancel');
    const activityPositionId = await createActivityPosition(activityId, 2, '并发取消');
    const pass = await Promise.all(
      [1, 2].map(async (n) =>
        seedRegistration(
          activityId,
          await createMember(`position-cancel-pass-${n}`),
          'pass',
          undefined,
          activityPositionId,
        ),
      ),
    );
    const waiting = await seedRegistration(
      activityId,
      await createMember('position-cancel-single-wait'),
      'waitlisted',
      undefined,
      activityPositionId,
    );

    const results = await Promise.allSettled(
      pass.map((registration) =>
        registrations.cancelAdmin(activityId, registration.id, {}, admin, AUDIT_META),
      ),
    );
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(
      await prisma.activityRegistration.findUniqueOrThrow({
        where: { id: waiting.id },
        select: { statusCode: true },
      }),
    ).toEqual({ statusCode: 'pending' });
    expect(
      await prisma.auditLog.count({
        where: {
          resourceId: waiting.id,
          event: 'registration.review',
          context: { path: ['extra', 'action'], equals: 'promote' },
        },
      }),
    ).toBe(1);
  });

  it('岗位 capacity 并发同值调大只按锁后真实 delta 递补；Activity capacity update 不递补', async () => {
    const activityId = await createActivity(1, 'position-concurrent-capacity');
    const activityPositionId = await createActivityPosition(activityId, 1, '并发扩容');
    await seedRegistration(
      activityId,
      await createMember('position-capacity-pass'),
      'pass',
      undefined,
      activityPositionId,
    );
    const queue = await Promise.all(
      [1, 2, 3, 4].map(async (n) =>
        seedRegistration(
          activityId,
          await createMember(`position-capacity-q${n}`),
          'waitlisted',
          new Date(`2026-07-16T0${n}:00:00.000Z`),
          activityPositionId,
        ),
      ),
    );

    await Promise.allSettled([
      activityPositions.update(activityId, activityPositionId, { capacity: 3 }, admin, AUDIT_META),
      activityPositions.update(activityId, activityPositionId, { capacity: 3 }, admin, AUDIT_META),
    ]);
    expect(
      await prisma.activityRegistration.count({
        where: { id: { in: queue.map((item) => item.id) }, statusCode: 'pending' },
      }),
    ).toBe(2);

    await activities.update(activityId, { capacity: 99 }, admin, AUDIT_META);
    expect(
      await prisma.activityRegistration.count({
        where: { id: { in: queue.map((item) => item.id) }, statusCode: 'pending' },
      }),
    ).toBe(2);
    expect((await activities.findOne(activityId, admin)).capacity).toBe(3);
  });

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
