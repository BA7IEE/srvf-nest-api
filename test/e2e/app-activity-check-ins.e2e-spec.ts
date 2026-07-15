import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

interface SuccessBody {
  code: number;
  message: string;
  data: Record<string, unknown>;
}

const APP_RESPONSE_KEYS = [
  'id',
  'activityId',
  'registrationId',
  'checkInAt',
  'checkOutAt',
  'checkInDistance',
  'checkOutDistance',
  'geoVerified',
  'outOfRange',
  'createdAt',
  'updatedAt',
].sort();

const RAW_OR_DENIED_KEYS = [
  'memberId',
  'checkInLongitude',
  'checkInLatitude',
  'checkInAccuracy',
  'checkOutLongitude',
  'checkOutLatitude',
  'checkOutAccuracy',
  'deletedAt',
];

describe('App activity GPS self check-in (F2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let organizationId: string;
  let activityTypeCode: string;
  let main: { memberId: string; authHeader: string };
  let seq = 0;

  const next = (): string => `f2${++seq}`;
  const location = { longitude: 114, latitude: 22, accuracy: 5.5 };
  const checkInPath = (activityId: string): string =>
    `/api/app/v1/my/activities/${activityId}/check-in`;
  const checkOutPath = (activityId: string): string =>
    `/api/app/v1/my/activities/${activityId}/check-out`;
  const statusPath = (activityId: string): string =>
    `/api/app/v1/my/activities/${activityId}/check-in`;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const nodeType = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeType.id, code: 'f2-checkin-node', label: '活动节点' },
    });
    organizationId = (
      await prisma.organization.create({
        data: { name: 'F2 Check-in Org', nodeTypeCode: 'f2-checkin-node' },
        select: { id: true },
      })
    ).id;

    const activityType = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    activityTypeCode = (
      await prisma.dictItem.create({
        data: { typeId: activityType.id, code: 'f2-checkin', label: '签到测试' },
        select: { code: true },
      })
    ).code;

    main = await setupLinkedUser('f2checkinmain', 'F2-MAIN');
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function freezeSystemTime(now: Date): void {
    // 只伪造 Date；HTTP/Prisma/Node 调度计时器保持真实，避免 supertest transport 被 fake timer 挂起。
    jest.useFakeTimers({
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    jest.setSystemTime(now);
  }

  async function setupLinkedUser(
    username: string,
    memberNo: string,
    role: Role = Role.USER,
  ): Promise<{ memberId: string; authHeader: string }> {
    const user = await createTestUser(app, { username, role });
    const member = await prisma.member.create({
      data: { memberNo, displayName: username, status: MemberStatus.ACTIVE },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    const { authHeader } = await loginAs(app, username);
    return { memberId: member.id, authHeader };
  }

  async function setupUnlinkedUser(username: string): Promise<{ authHeader: string }> {
    await createTestUser(app, { username });
    return loginAs(app, username);
  }

  async function createActivity(
    opts: {
      statusCode?: 'draft' | 'published' | 'completed' | 'cancelled';
      startAt?: Date;
      endAt?: Date;
      longitude?: string | null;
      latitude?: string | null;
      deletedAt?: Date | null;
    } = {},
  ): Promise<{ id: string }> {
    const now = Date.now();
    const statusCode = opts.statusCode ?? 'published';
    return prisma.activity.create({
      data: {
        title: `F2 GPS ${next()}`,
        activityTypeCode,
        organizationId,
        startAt: opts.startAt ?? new Date(now - 60 * 60_000),
        endAt: opts.endAt ?? new Date(now + 60 * 60_000),
        location: 'F2 geofence',
        statusCode,
        publishedAt: statusCode === 'published' ? new Date(now - 60_000) : null,
        cancelledAt: statusCode === 'cancelled' ? new Date(now - 30_000) : null,
        cancelReason: statusCode === 'cancelled' ? 'test cancel' : null,
        locationLongitude: opts.longitude === undefined ? '114.0000000' : opts.longitude,
        locationLatitude: opts.latitude === undefined ? '22.0000000' : opts.latitude,
        deletedAt: opts.deletedAt ?? null,
      },
      select: { id: true },
    });
  }

  async function createRegistration(
    activityId: string,
    memberId: string,
    statusCode: 'pending' | 'pass' | 'reject' | 'cancelled' = 'pass',
  ): Promise<{ id: string }> {
    return prisma.activityRegistration.create({
      data: {
        activityId,
        memberId,
        statusCode,
        reviewedAt: statusCode === 'pass' || statusCode === 'reject' ? new Date() : null,
        cancelledAt: statusCode === 'cancelled' ? new Date() : null,
      },
      select: { id: true },
    });
  }

  async function seedEvidence(
    activityId: string,
    memberId: string,
    registrationId: string,
    opts: { checkInAt?: Date; checkOutAt?: Date | null } = {},
  ) {
    return prisma.activityCheckIn.create({
      data: {
        activityId,
        memberId,
        registrationId,
        checkInAt: opts.checkInAt ?? new Date(Date.now() - 60_000),
        checkOutAt: opts.checkOutAt ?? null,
        checkInLongitude: '114.0000000',
        checkInLatitude: '22.0000000',
        checkInAccuracy: '5.50',
        checkInDistance: '0.00',
        geoVerified: true,
        outOfRange: false,
      },
    });
  }

  const post = (path: string, body: object, authHeader?: string) => {
    const pending = request(httpServer(app)).post(path).send(body);
    return authHeader ? pending.set('Authorization', authHeader) : pending;
  };

  const get = (path: string, authHeader?: string) => {
    const pending = request(httpServer(app)).get(path);
    return authHeader ? pending.set('Authorization', authHeader) : pending;
  };

  function expectSafeSuccess(body: SuccessBody): Record<string, unknown> {
    expect(body.code).toBe(0);
    expect(body.message).toBe('ok');
    expect(Object.keys(body.data).sort()).toEqual(APP_RESPONSE_KEYS);
    for (const key of RAW_OR_DENIED_KEYS) expect(body.data).not.toHaveProperty(key);
    return body.data;
  }

  it.each([
    ['POST check-in', 'post', '/api/app/v1/my/activities/cmissing000000/check-in'],
    ['POST check-out', 'post', '/api/app/v1/my/activities/cmissing000000/check-out'],
    ['GET status', 'get', '/api/app/v1/my/activities/cmissing000000/check-in'],
  ] as const)('%s 未登录先返回 UNAUTHORIZED', async (_label, method, path) => {
    const res = method === 'post' ? await post(path, location) : await get(path);
    expectBizError(res, BizCode.UNAUTHORIZED);
  });

  it('未关联 / inactive / 软删 Member 均返回 FORBIDDEN，linked ADMIN 仍是本人视角', async () => {
    const activity = await createActivity();
    const unlinked = await setupUnlinkedUser(`unlinked${next()}`);
    expectBizError(
      await post(checkInPath(activity.id), location, unlinked.authHeader),
      BizCode.FORBIDDEN,
    );

    const inactive = await setupLinkedUser(`inactive${next()}`, `F2-I-${next()}`);
    await prisma.member.update({
      where: { id: inactive.memberId },
      data: { status: MemberStatus.INACTIVE },
    });
    expectBizError(
      await post(checkInPath(activity.id), location, inactive.authHeader),
      BizCode.FORBIDDEN,
    );

    const deleted = await setupLinkedUser(`deleted${next()}`, `F2-D-${next()}`);
    await prisma.member.update({
      where: { id: deleted.memberId },
      data: { deletedAt: new Date() },
    });
    expectBizError(
      await post(checkInPath(activity.id), location, deleted.authHeader),
      BizCode.FORBIDDEN,
    );

    const admin = await setupLinkedUser(`admin${next()}`, `F2-A-${next()}`, Role.ADMIN);
    const adminActivity = await createActivity();
    const adminRegistration = await createRegistration(adminActivity.id, admin.memberId);
    const adminResult = await post(checkInPath(adminActivity.id), location, admin.authHeader);
    expect(adminResult.status).toBe(200);
    expect(expectSafeSuccess(adminResult.body as SuccessBody).registrationId).toBe(
      adminRegistration.id,
    );
  });

  it.each([
    ['缺 longitude', { latitude: 22 }],
    ['缺 latitude', { longitude: 114 }],
    ['longitude 越界', { longitude: 180.1, latitude: 22 }],
    ['latitude 小数超过 7 位', { longitude: 114, latitude: 22.12345678 }],
    ['accuracy 为负', { longitude: 114, latitude: 22, accuracy: -0.01 }],
    ['accuracy 小数超过 2 位', { longitude: 114, latitude: 22, accuracy: 1.234 }],
    ['accuracy 越界', { longitude: 114, latitude: 22, accuracy: 100_000_000 }],
    ['夹带 memberId', { longitude: 114, latitude: 22, memberId: 'other' }],
  ])('%s 由严格 DTO 返回 BAD_REQUEST', async (_label, body) => {
    const activity = await createActivity();
    await createRegistration(activity.id, main.memberId);
    expectBizError(
      await post(checkInPath(activity.id), body, main.authHeader),
      BizCode.BAD_REQUEST,
      {
        strictMessage: false,
      },
    );
  });

  it('DTO 接受经纬度闭区间端点与 accuracy 最大值，短 activityId 仍为 400', async () => {
    const activity = await createActivity();
    await createRegistration(activity.id, main.memberId);
    expect(
      (
        await post(
          checkInPath(activity.id),
          { longitude: 180, latitude: -90, accuracy: 99_999_999.99 },
          main.authHeader,
        )
      ).status,
    ).toBe(200);
    expectBizError(
      await post('/api/app/v1/my/activities/short/check-in', location, main.authHeader),
      BizCode.BAD_REQUEST,
      { strictMessage: false },
    );
  });

  it.each(['pending', 'reject', 'cancelled'] as const)(
    '%s 报名不能签到或签退，统一 ATTENDANCE_REGISTRATION_INVALID',
    async (statusCode) => {
      const activity = await createActivity();
      await createRegistration(activity.id, main.memberId, statusCode);
      expectBizError(
        await post(checkInPath(activity.id), location, main.authHeader),
        BizCode.ATTENDANCE_REGISTRATION_INVALID,
      );
      expectBizError(
        await post(checkOutPath(activity.id), location, main.authHeader),
        BizCode.ATTENDANCE_REGISTRATION_INVALID,
      );
    },
  );

  it('无报名同样拒绝，活动不存在或软删则更早返回 ACTIVITY_NOT_FOUND', async () => {
    const activity = await createActivity();
    expectBizError(
      await post(checkInPath(activity.id), location, main.authHeader),
      BizCode.ATTENDANCE_REGISTRATION_INVALID,
    );
    expectBizError(
      await post(checkInPath('cmissing000000'), location, main.authHeader),
      BizCode.ACTIVITY_NOT_FOUND,
    );
    const deleted = await createActivity({ deletedAt: new Date() });
    expectBizError(
      await post(checkInPath(deleted.id), location, main.authHeader),
      BizCode.ACTIVITY_NOT_FOUND,
    );
  });

  it('软删 pass registration 对写为 22076、对 GET 为 22002', async () => {
    const activity = await createActivity();
    const registration = await createRegistration(activity.id, main.memberId);
    await prisma.activityRegistration.update({
      where: { id: registration.id },
      data: { deletedAt: new Date() },
    });
    expectBizError(
      await post(checkInPath(activity.id), location, main.authHeader),
      BizCode.ATTENDANCE_REGISTRATION_INVALID,
    );
    expectBizError(
      await get(statusPath(activity.id), main.authHeader),
      BizCode.ACTIVITY_CHECK_IN_NOT_FOUND,
    );
  });

  it.each([
    ['draft', BizCode.ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN],
    ['cancelled', BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN],
    ['completed', BizCode.ACTIVITY_STATUS_INVALID],
  ] as const)('%s 新签到按冻结状态矩阵拒绝', async (statusCode, biz) => {
    const activity = await createActivity({ statusCode });
    await createRegistration(activity.id, main.memberId);
    expectBizError(await post(checkInPath(activity.id), location, main.authHeader), biz);
  });

  it.each([
    ['draft', BizCode.ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN],
    ['cancelled', BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN],
  ] as const)('%s 即使已有证据也不能用幂等绕过签退状态闸', async (statusCode, biz) => {
    const activity = await createActivity({ statusCode });
    const registration = await createRegistration(activity.id, main.memberId);
    await seedEvidence(activity.id, main.memberId, registration.id, {
      checkOutAt: new Date(Date.now() - 10_000),
    });
    expectBizError(await post(checkOutPath(activity.id), location, main.authHeader), biz);
  });

  it('状态与当前 pass 闸严格先于幂等 winner', async () => {
    const cancelled = await createActivity();
    const cancelledRegistration = await createRegistration(cancelled.id, main.memberId);
    await seedEvidence(cancelled.id, main.memberId, cancelledRegistration.id);
    await prisma.activity.update({
      where: { id: cancelled.id },
      data: { statusCode: 'cancelled', cancelledAt: new Date(), cancelReason: 'race test' },
    });
    expectBizError(
      await post(checkInPath(cancelled.id), location, main.authHeader),
      BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN,
    );

    const noPass = await createActivity();
    const noPassRegistration = await createRegistration(noPass.id, main.memberId);
    await seedEvidence(noPass.id, main.memberId, noPassRegistration.id);
    await prisma.activityRegistration.update({
      where: { id: noPassRegistration.id },
      data: { statusCode: 'cancelled', cancelledAt: new Date() },
    });
    expectBizError(
      await post(checkInPath(noPass.id), location, main.authHeader),
      BizCode.ATTENDANCE_REGISTRATION_INVALID,
    );

    const completed = await createActivity({ statusCode: 'completed' });
    const completedRegistration = await createRegistration(completed.id, main.memberId);
    await seedEvidence(completed.id, main.memberId, completedRegistration.id);
    expectBizError(
      await post(checkInPath(completed.id), location, main.authHeader),
      BizCode.ACTIVITY_STATUS_INVALID,
    );
  });

  it('published 可签到；completed 已签到可首次签退', async () => {
    const published = await createActivity();
    await createRegistration(published.id, main.memberId);
    const checkIn = await post(checkInPath(published.id), location, main.authHeader);
    expect(checkIn.status).toBe(200);
    expectSafeSuccess(checkIn.body as SuccessBody);

    const completed = await createActivity({ statusCode: 'completed' });
    const registration = await createRegistration(completed.id, main.memberId);
    await seedEvidence(completed.id, main.memberId, registration.id, {
      checkInAt: new Date(Date.now() - 60_000),
    });
    const checkOut = await post(checkOutPath(completed.id), location, main.authHeader);
    expect(checkOut.status).toBe(200);
    expect(expectSafeSuccess(checkOut.body as SuccessBody).checkOutAt).not.toBeNull();
  });

  it('签到时间窗前后硬拒，并在 endAt-36s 边界两侧表现稳定', async () => {
    const now = Date.now();
    const before = await createActivity({
      startAt: new Date(now + 3 * 60 * 60_000),
      endAt: new Date(now + 4 * 60 * 60_000),
    });
    await createRegistration(before.id, main.memberId);
    expectBizError(
      await post(checkInPath(before.id), location, main.authHeader),
      BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW,
    );

    const after = await createActivity({
      startAt: new Date(now - 4 * 60 * 60_000),
      endAt: new Date(now - 3 * 60 * 60_000),
    });
    await createRegistration(after.id, main.memberId);
    expectBizError(
      await post(checkInPath(after.id), location, main.authHeader),
      BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW,
    );

    const tooLateForFallback = await createActivity({ endAt: new Date(Date.now() + 35_000) });
    await createRegistration(tooLateForFallback.id, main.memberId);
    expectBizError(
      await post(checkInPath(tooLateForFallback.id), location, main.authHeader),
      BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW,
    );

    const justInside = await createActivity({ endAt: new Date(Date.now() + 41_000) });
    await createRegistration(justInside.id, main.memberId);
    expect((await post(checkInPath(justInside.id), location, main.authHeader)).status).toBe(200);
  });

  it('首次签退同时执行总时间窗与 checkInAt+36s floor', async () => {
    const afterWindow = await createActivity({
      startAt: new Date(Date.now() - 4 * 60 * 60_000),
      endAt: new Date(Date.now() - 3 * 60 * 60_000),
    });
    const afterReg = await createRegistration(afterWindow.id, main.memberId);
    await seedEvidence(afterWindow.id, main.memberId, afterReg.id, {
      checkInAt: new Date(Date.now() - 4 * 60 * 60_000),
    });
    expectBizError(
      await post(checkOutPath(afterWindow.id), location, main.authHeader),
      BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW,
    );

    const short = await createActivity();
    const shortReg = await createRegistration(short.id, main.memberId);
    await seedEvidence(short.id, main.memberId, shortReg.id, {
      checkInAt: new Date(Date.now() - 35_000),
    });
    expectBizError(
      await post(checkOutPath(short.id), location, main.authHeader),
      BizCode.ATTENDANCE_SERVICE_HOURS_INVALID,
    );

    const enough = await createActivity();
    const enoughReg = await createRegistration(enough.id, main.memberId);
    await seedEvidence(enough.id, main.memberId, enoughReg.id, {
      checkInAt: new Date(Date.now() - 40_000),
    });
    expect((await post(checkOutPath(enough.id), location, main.authHeader)).status).toBe(200);
  });

  it('固定 authoritative now 精确锁定 endAt-36s、endAt+tolerance 与 36s floor 边界', async () => {
    const fixed = new Date();
    freezeSystemTime(fixed);

    const checkInExact = await createActivity({
      startAt: new Date(fixed.getTime() - 60_000),
      endAt: new Date(fixed.getTime() + 36_000),
    });
    await createRegistration(checkInExact.id, main.memberId);
    expect((await post(checkInPath(checkInExact.id), location, main.authHeader)).status).toBe(200);

    const checkInOneMsLate = await createActivity({
      startAt: new Date(fixed.getTime() - 60_000),
      endAt: new Date(fixed.getTime() + 35_999),
    });
    await createRegistration(checkInOneMsLate.id, main.memberId);
    expectBizError(
      await post(checkInPath(checkInOneMsLate.id), location, main.authHeader),
      BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW,
    );

    const checkOutExactEnd = await createActivity({
      startAt: new Date(fixed.getTime() - 3 * 60 * 60_000),
      endAt: new Date(fixed.getTime() - 2 * 60 * 60_000),
    });
    const exactEndRegistration = await createRegistration(checkOutExactEnd.id, main.memberId);
    await seedEvidence(checkOutExactEnd.id, main.memberId, exactEndRegistration.id, {
      checkInAt: new Date(fixed.getTime() - 60_000),
    });
    expect((await post(checkOutPath(checkOutExactEnd.id), location, main.authHeader)).status).toBe(
      200,
    );

    const checkOutOneMsLate = await createActivity({
      startAt: new Date(fixed.getTime() - 3 * 60 * 60_000),
      endAt: new Date(fixed.getTime() - 2 * 60 * 60_000 - 1),
    });
    const lateRegistration = await createRegistration(checkOutOneMsLate.id, main.memberId);
    await seedEvidence(checkOutOneMsLate.id, main.memberId, lateRegistration.id, {
      checkInAt: new Date(fixed.getTime() - 60_000),
    });
    expectBizError(
      await post(checkOutPath(checkOutOneMsLate.id), location, main.authHeader),
      BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW,
    );

    const floorExact = await createActivity();
    const floorExactRegistration = await createRegistration(floorExact.id, main.memberId);
    await seedEvidence(floorExact.id, main.memberId, floorExactRegistration.id, {
      checkInAt: new Date(fixed.getTime() - 36_000),
    });
    expect((await post(checkOutPath(floorExact.id), location, main.authHeader)).status).toBe(200);

    const floorOneMsShort = await createActivity();
    const floorShortRegistration = await createRegistration(floorOneMsShort.id, main.memberId);
    await seedEvidence(floorOneMsShort.id, main.memberId, floorShortRegistration.id, {
      checkInAt: new Date(fixed.getTime() - 35_999),
    });
    expectBizError(
      await post(checkOutPath(floorOneMsShort.id), location, main.authHeader),
      BizCode.ATTENDANCE_SERVICE_HOURS_INVALID,
    );
  });

  it('时间窗只约束首次写：已完成同动作在窗口外仍幂等 200', async () => {
    const checkedIn = await createActivity();
    const checkedInRegistration = await createRegistration(checkedIn.id, main.memberId);
    await seedEvidence(checkedIn.id, main.memberId, checkedInRegistration.id);
    await prisma.activity.update({
      where: { id: checkedIn.id },
      data: {
        startAt: new Date(Date.now() - 4 * 60 * 60_000),
        endAt: new Date(Date.now() - 3 * 60 * 60_000),
      },
    });
    expect((await post(checkInPath(checkedIn.id), location, main.authHeader)).status).toBe(200);

    const checkedOut = await createActivity({ statusCode: 'completed' });
    const checkedOutRegistration = await createRegistration(checkedOut.id, main.memberId);
    await seedEvidence(checkedOut.id, main.memberId, checkedOutRegistration.id, {
      checkInAt: new Date(Date.now() - 4 * 60 * 60_000),
      checkOutAt: new Date(Date.now() - 3 * 60 * 60_000),
    });
    await prisma.activity.update({
      where: { id: checkedOut.id },
      data: {
        startAt: new Date(Date.now() - 5 * 60 * 60_000),
        endAt: new Date(Date.now() - 4 * 60 * 60_000),
      },
    });
    expect((await post(checkOutPath(checkedOut.id), location, main.authHeader)).status).toBe(200);
  });

  it.each([
    ['无坐标', null, null],
    ['只有经度', '114.0000000', null],
    ['历史非法经度', '181.0000000', '22.0000000'],
  ] as const)('%s 宽进为 unverified，且仍保存客户端原始证据', async (_label, lon, lat) => {
    const activity = await createActivity({ longitude: lon, latitude: lat });
    const registration = await createRegistration(activity.id, main.memberId);
    const res = await post(checkInPath(activity.id), location, main.authHeader);
    expect(res.status).toBe(200);
    expect(expectSafeSuccess(res.body as SuccessBody)).toMatchObject({
      registrationId: registration.id,
      checkInDistance: null,
      geoVerified: false,
      outOfRange: false,
    });
    const stored = await prisma.activityCheckIn.findFirstOrThrow({
      where: { registrationId: registration.id },
    });
    expect(stored.checkInLongitude?.toString()).toBe('114');
    expect(stored.checkInLatitude?.toString()).toBe('22');
    expect(stored.checkInAccuracy?.toString()).toBe('5.5');
  });

  it('Haversine 生产调用点覆盖同点、500m 原始边界两侧与超距宽进', async () => {
    const same = await createActivity({ longitude: '0', latitude: '0' });
    await createRegistration(same.id, main.memberId);
    const sameData = expectSafeSuccess(
      (await post(checkInPath(same.id), { longitude: 0, latitude: 0 }, main.authHeader))
        .body as SuccessBody,
    );
    expect(sameData).toMatchObject({
      checkInDistance: '0',
      geoVerified: true,
      outOfRange: false,
    });

    const within = await createActivity({ longitude: '0', latitude: '0' });
    await createRegistration(within.id, main.memberId);
    const withinData = expectSafeSuccess(
      (await post(checkInPath(within.id), { longitude: 0, latitude: 0.0044966 }, main.authHeader))
        .body as SuccessBody,
    );
    expect(withinData.checkInDistance).toBe('500');
    expect(withinData.outOfRange).toBe(false);

    const outside = await createActivity({ longitude: '0', latitude: '0' });
    await createRegistration(outside.id, main.memberId);
    const outsideData = expectSafeSuccess(
      (
        await post(
          checkInPath(outside.id),
          { longitude: 0, latitude: 0.0044967, accuracy: 999.99 },
          main.authHeader,
        )
      ).body as SuccessBody,
    );
    expect(outsideData.checkInDistance).toBe('500.01');
    expect(outsideData.outOfRange).toBe(true);
  });

  it('重复签到和签退均返回首次 winner，后续位置不得覆盖 snapshot', async () => {
    const activity = await createActivity();
    const registration = await createRegistration(activity.id, main.memberId);
    const first = await post(checkInPath(activity.id), location, main.authHeader);
    const retry = await post(
      checkInPath(activity.id),
      { longitude: -10, latitude: -10, accuracy: 99 },
      main.authHeader,
    );
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    const firstData = expectSafeSuccess(first.body as SuccessBody);
    const retryData = expectSafeSuccess(retry.body as SuccessBody);
    expect(retryData.id).toBe(firstData.id);
    expect(firstData).toMatchObject({ geoVerified: true, outOfRange: false });

    await prisma.activityCheckIn.update({
      where: { id: firstData.id as string },
      data: { checkInAt: new Date(Date.now() - 60_000) },
    });
    const outFirst = await post(checkOutPath(activity.id), location, main.authHeader);
    const outRetry = await post(
      checkOutPath(activity.id),
      { longitude: -20, latitude: -20, accuracy: 88 },
      main.authHeader,
    );
    const outFirstData = expectSafeSuccess(outFirst.body as SuccessBody);
    const outRetryData = expectSafeSuccess(outRetry.body as SuccessBody);
    expect(outRetryData.id).toBe(outFirstData.id);
    expect(outRetryData.checkOutAt).toBe(outFirstData.checkOutAt);
    expect(outRetryData).toMatchObject({ geoVerified: true, outOfRange: false });

    const stored = await prisma.activityCheckIn.findFirstOrThrow({
      where: { registrationId: registration.id },
    });
    expect(stored.checkInLongitude?.toString()).toBe('114');
    expect(stored.checkOutLongitude?.toString()).toBe('114');
    expect(stored.geoVerified).toBe(true);
    expect(stored.outOfRange).toBe(false);
  });

  it('8 路并发 check-in 全 200、同 winner，DB live row=1', async () => {
    const activity = await createActivity();
    const registration = await createRegistration(activity.id, main.memberId);
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        post(
          checkInPath(activity.id),
          { longitude: 114 + index / 1000, latitude: 22, accuracy: index },
          main.authHeader,
        ),
      ),
    );
    expect(responses.every((res) => res.status === 200)).toBe(true);
    const ids = new Set(
      responses.map((res) => expectSafeSuccess(res.body as SuccessBody).id as string),
    );
    expect(ids.size).toBe(1);
    expect(
      await prisma.activityCheckIn.count({
        where: { registrationId: registration.id, deletedAt: null },
      }),
    ).toBe(1);
  });

  it('并发 check-out 只有一个 CAS winner，全部重读同一首次签退', async () => {
    const activity = await createActivity();
    const registration = await createRegistration(activity.id, main.memberId);
    await seedEvidence(activity.id, main.memberId, registration.id, {
      checkInAt: new Date(Date.now() - 60_000),
    });
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        post(
          checkOutPath(activity.id),
          { longitude: 114 + index / 1000, latitude: 22 },
          main.authHeader,
        ),
      ),
    );
    expect(responses.every((res) => res.status === 200)).toBe(true);
    const data = responses.map((res) => expectSafeSuccess(res.body as SuccessBody));
    expect(new Set(data.map((item) => item.id)).size).toBe(1);
    expect(new Set(data.map((item) => item.checkOutAt)).size).toBe(1);
    expect(
      (
        await prisma.activityCheckIn.findFirstOrThrow({
          where: { registrationId: registration.id },
        })
      ).checkOutAt,
    ).not.toBeNull();
  });

  it('GET 仅返回本人当前 pass registration 行；无行和他人行均 22002', async () => {
    const activity = await createActivity();
    const mine = await createRegistration(activity.id, main.memberId);
    expectBizError(
      await get(statusPath(activity.id), main.authHeader),
      BizCode.ACTIVITY_CHECK_IN_NOT_FOUND,
    );

    const other = await setupLinkedUser(`other${next()}`, `F2-O-${next()}`);
    const otherRegistration = await createRegistration(activity.id, other.memberId);
    await seedEvidence(activity.id, other.memberId, otherRegistration.id);
    expectBizError(
      await get(statusPath(activity.id), main.authHeader),
      BizCode.ACTIVITY_CHECK_IN_NOT_FOUND,
    );

    await seedEvidence(activity.id, main.memberId, mine.id);
    const res = await get(statusPath(activity.id), main.authHeader);
    expect(res.status).toBe(200);
    expect(expectSafeSuccess(res.body as SuccessBody).registrationId).toBe(mine.id);
  });

  it('GET 不做 Activity 状态闸，但取消旧报名后旧行出局，新 pass 可另建一行', async () => {
    const activity = await createActivity({ statusCode: 'draft' });
    const oldRegistration = await createRegistration(activity.id, main.memberId);
    const oldEvidence = await seedEvidence(activity.id, main.memberId, oldRegistration.id);
    expect((await get(statusPath(activity.id), main.authHeader)).status).toBe(200);

    await prisma.activityRegistration.update({
      where: { id: oldRegistration.id },
      data: { statusCode: 'cancelled', cancelledAt: new Date() },
    });
    expectBizError(
      await get(statusPath(activity.id), main.authHeader),
      BizCode.ACTIVITY_CHECK_IN_NOT_FOUND,
    );

    const current = await createRegistration(activity.id, main.memberId);
    await prisma.activity.update({
      where: { id: activity.id },
      data: { statusCode: 'published', publishedAt: new Date() },
    });
    const created = await post(checkInPath(activity.id), location, main.authHeader);
    expect(created.status).toBe(200);
    const currentData = expectSafeSuccess(created.body as SuccessBody);
    expect(currentData.registrationId).toBe(current.id);
    expect(currentData.id).not.toBe(oldEvidence.id);
    expect(await prisma.activityCheckIn.count({ where: { activityId: activity.id } })).toBe(2);
  });

  it.each(['draft', 'published', 'completed', 'cancelled'] as const)(
    'GET 在 Activity %s 状态下均只按当前 pass + 当前行返回 200',
    async (statusCode) => {
      const activity = await createActivity({ statusCode });
      const registration = await createRegistration(activity.id, main.memberId);
      await seedEvidence(activity.id, main.memberId, registration.id);

      const res = await get(statusPath(activity.id), main.authHeader);
      expect(res.status).toBe(200);
      expect(expectSafeSuccess(res.body as SuccessBody).registrationId).toBe(registration.id);
    },
  );

  it('签退前无签到返回 22078；打卡写入不产生 AuditLog 且 raw GPS 只在 DB', async () => {
    const activity = await createActivity();
    const registration = await createRegistration(activity.id, main.memberId);
    expectBizError(
      await post(checkOutPath(activity.id), location, main.authHeader),
      BizCode.ACTIVITY_CHECK_OUT_REQUIRES_CHECK_IN,
    );

    const beforeAudit = await prisma.auditLog.count();
    const checkIn = await post(
      checkInPath(activity.id),
      { longitude: 113.1234567, latitude: 23.7654321, accuracy: 12.34 },
      main.authHeader,
    );
    const checkInData = expectSafeSuccess(checkIn.body as SuccessBody);
    await prisma.activityCheckIn.update({
      where: { id: checkInData.id as string },
      data: { checkInAt: new Date(Date.now() - 60_000) },
    });
    const checkOut = await post(
      checkOutPath(activity.id),
      { longitude: 112.1111111, latitude: 24.2222222, accuracy: 56.78 },
      main.authHeader,
    );
    expectSafeSuccess(checkOut.body as SuccessBody);
    expect(await prisma.auditLog.count()).toBe(beforeAudit);

    const stored = await prisma.activityCheckIn.findFirstOrThrow({
      where: { registrationId: registration.id },
    });
    expect(stored.checkInLongitude?.toString()).toBe('113.1234567');
    expect(stored.checkInLatitude?.toString()).toBe('23.7654321');
    expect(stored.checkInAccuracy?.toString()).toBe('12.34');
    expect(stored.checkOutLongitude?.toString()).toBe('112.1111111');
    expect(stored.checkOutLatitude?.toString()).toBe('24.2222222');
    expect(stored.checkOutAccuracy?.toString()).toBe('56.78');
  });
});
