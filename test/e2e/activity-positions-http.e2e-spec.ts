import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const HOUR_MS = 60 * 60 * 1000;

// 活动岗位 6 个新端点的 HTTP 层闭环(元核验缺口补测):鉴权接线(401/30100/login-only 读)、
// ValidationPipe 与路由参数绑定、越窗/重名/禁删守卫经真实请求触发、App 可见性与余量、
// 报名 body 经 HTTP 携带 activityPositionId(含「有岗位活动必须选岗」21035)。
// 行为语义(分流/递补/并发)已由 activity-registration-waitlist / activity-position-attendance
// 两个 spec 背书,本文件只补 HTTP 高度,不重复行为矩阵。
describe('activity positions HTTP surface', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAuth: string;
  let userAuth: string;
  let userMemberId: string;
  let occupierMemberId: string;
  let organizationId: string;
  let publishedActivityId: string;
  let draftActivityId: string;
  let frontCommandPositionId: string;

  const adminPositionsPath = (activityId: string): string =>
    `/api/admin/v1/activities/${activityId}/positions`;
  const appPositionsPath = (activityId: string): string =>
    `/api/app/v1/activities/${activityId}/positions`;

  let activityStartAt: Date;
  let activityEndAt: Date;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'pos-http-super-admin', role: Role.SUPER_ADMIN });
    adminAuth = (await loginAs(app, 'pos-http-super-admin')).authHeader;

    const member = await prisma.member.create({
      data: { memberNo: 'pos-http-user', displayName: '岗位HTTP队员' },
      select: { id: true },
    });
    userMemberId = member.id;
    const user = await createTestUser(app, { username: 'pos-http-user', role: Role.USER });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    userAuth = (await loginAs(app, 'pos-http-user')).authHeader;

    occupierMemberId = (
      await prisma.member.create({
        data: { memberNo: 'pos-http-occupier', displayName: '占位队员' },
        select: { id: true },
      })
    ).id;

    organizationId = (
      await prisma.organization.create({
        data: { name: 'Activity Positions HTTP Org', nodeTypeCode: 'team' },
        select: { id: true },
      })
    ).id;

    // attendance_role 字典(service 对 attendanceRoleCode 做字典校验;resetDb 已清空字典表)。
    const roleDict = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    for (const [code, label] of [
      ['member', '队员'],
      ['front_command', '前指'],
    ] as const) {
      await prisma.dictItem.create({ data: { typeId: roleDict.id, code, label } });
    }

    const now = Date.now();
    activityStartAt = new Date(now - HOUR_MS);
    activityEndAt = new Date(now + 4 * HOUR_MS);
    publishedActivityId = (
      await prisma.activity.create({
        data: {
          title: '岗位HTTP主活动',
          activityTypeCode: 'pos-http-type',
          organizationId,
          startAt: activityStartAt,
          endAt: activityEndAt,
          location: '岗位HTTP测试地点',
          statusCode: 'published',
        },
        select: { id: true },
      })
    ).id;
    draftActivityId = (
      await prisma.activity.create({
        data: {
          title: '岗位HTTP草稿活动',
          activityTypeCode: 'pos-http-type',
          organizationId,
          startAt: activityStartAt,
          endAt: activityEndAt,
          location: '岗位HTTP测试地点',
          statusCode: 'draft',
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('未登录:admin 建岗与 App 岗位列表均 401', async () => {
    const adminRes = await request(httpServer(app))
      .post(adminPositionsPath(publishedActivityId))
      .send({ name: '未登录岗', attendanceRoleCode: 'member' });
    expectBizError(adminRes, BizCode.UNAUTHORIZED);

    const appRes = await request(httpServer(app)).get(appPositionsPath(publishedActivityId));
    expectBizError(appRes, BizCode.UNAUTHORIZED);
  });

  it('USER 写被拒 30100;admin HTTP 创建→详情→列表→更新全链可用', async () => {
    const forbidden = await request(httpServer(app))
      .post(adminPositionsPath(publishedActivityId))
      .set('Authorization', userAuth)
      .send({ name: '越权岗', attendanceRoleCode: 'member' });
    expectBizError(forbidden, BizCode.RBAC_FORBIDDEN);

    const created = await request(httpServer(app))
      .post(adminPositionsPath(publishedActivityId))
      .set('Authorization', adminAuth)
      .send({
        name: '前指岗',
        attendanceRoleCode: 'front_command',
        capacity: 2,
        startAt: new Date(activityStartAt.getTime() + HOUR_MS).toISOString(),
        endAt: new Date(activityEndAt.getTime() - HOUR_MS).toISOString(),
      });
    expect(created.status).toBeLessThan(300);
    expect(created.body.data).toMatchObject({
      name: '前指岗',
      attendanceRoleCode: 'front_command',
      capacity: 2,
    });
    frontCommandPositionId = created.body.data.activityPositionId;
    expect(frontCommandPositionId).toEqual(expect.any(String));

    const detail = await request(httpServer(app))
      .get(`${adminPositionsPath(publishedActivityId)}/${frontCommandPositionId}`)
      .set('Authorization', adminAuth);
    expect(detail.body.data).toMatchObject({
      activityPositionId: frontCommandPositionId,
      name: '前指岗',
    });

    const updated = await request(httpServer(app))
      .patch(`${adminPositionsPath(publishedActivityId)}/${frontCommandPositionId}`)
      .set('Authorization', adminAuth)
      .send({ description: '现场指挥联络' });
    expect(updated.body.data).toMatchObject({ description: '现场指挥联络' });

    // 读复用活动 login-only 口径:普通 USER 走 admin 读端点应放行(修正 3 定稿)。
    const listAsUser = await request(httpServer(app))
      .get(adminPositionsPath(publishedActivityId))
      .set('Authorization', userAuth);
    expect(listAsUser.status).toBe(200);
    expect(listAsUser.body.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: '前指岗' })]),
    );
  });

  it('时段越出活动窗与同活动重名均被 HTTP 拒绝', async () => {
    const outOfWindow = await request(httpServer(app))
      .post(adminPositionsPath(publishedActivityId))
      .set('Authorization', adminAuth)
      .send({
        name: '越窗岗',
        attendanceRoleCode: 'member',
        startAt: new Date(activityStartAt.getTime() + HOUR_MS).toISOString(),
        endAt: new Date(activityEndAt.getTime() + HOUR_MS).toISOString(),
      });
    expectBizError(outOfWindow, BizCode.ACTIVITY_POSITION_TIME_RANGE_INVALID);

    const duplicated = await request(httpServer(app))
      .post(adminPositionsPath(publishedActivityId))
      .set('Authorization', adminAuth)
      .send({ name: '前指岗', attendanceRoleCode: 'member' });
    expectBizError(duplicated, BizCode.ACTIVITY_POSITION_NAME_ALREADY_EXISTS);
  });

  it('有活跃报名的岗位禁删;无报名岗位可删且删后详情 404', async () => {
    await prisma.activityRegistration.create({
      data: {
        activityId: publishedActivityId,
        memberId: occupierMemberId,
        statusCode: 'pass',
        activityPositionId: frontCommandPositionId,
      },
    });
    const blocked = await request(httpServer(app))
      .delete(`${adminPositionsPath(publishedActivityId)}/${frontCommandPositionId}`)
      .set('Authorization', adminAuth);
    expectBizError(blocked, BizCode.ACTIVITY_POSITION_HAS_ACTIVE_REGISTRATIONS);

    const disposable = await request(httpServer(app))
      .post(adminPositionsPath(publishedActivityId))
      .set('Authorization', adminAuth)
      .send({ name: '机动岗', attendanceRoleCode: 'member' });
    const disposableId = disposable.body.data.activityPositionId;

    const removed = await request(httpServer(app))
      .delete(`${adminPositionsPath(publishedActivityId)}/${disposableId}`)
      .set('Authorization', adminAuth);
    expect(removed.status).toBeLessThan(300);

    const gone = await request(httpServer(app))
      .get(`${adminPositionsPath(publishedActivityId)}/${disposableId}`)
      .set('Authorization', adminAuth);
    expectBizError(gone, BizCode.ACTIVITY_POSITION_NOT_FOUND);
  });

  it('App 岗位列表:published 返回余量与 canRegister,draft 404 防枚举', async () => {
    const res = await request(httpServer(app))
      .get(appPositionsPath(publishedActivityId))
      .set('Authorization', userAuth);
    expect(res.status).toBe(200);
    const frontCommand = res.body.data.find(
      (item: { activityPositionId: string }) => item.activityPositionId === frontCommandPositionId,
    );
    // capacity 2、已 1 条 pass → 余量 1,仍可报。
    expect(frontCommand).toMatchObject({
      name: '前指岗',
      capacity: 2,
      remainingCapacity: 1,
      canRegister: true,
    });

    const draft = await request(httpServer(app))
      .get(appPositionsPath(draftActivityId))
      .set('Authorization', userAuth);
    expectBizError(draft, BizCode.ACTIVITY_NOT_FOUND);
  });

  it('App HTTP 报名:有岗位活动必须选岗(21035),携 activityPositionId 则落 pending', async () => {
    const missingPosition = await request(httpServer(app))
      .post('/api/app/v1/my/registrations')
      .set('Authorization', userAuth)
      .send({ activityId: publishedActivityId });
    expectBizError(missingPosition, BizCode.ACTIVITY_POSITION_REQUIRED);

    const registered = await request(httpServer(app))
      .post('/api/app/v1/my/registrations')
      .set('Authorization', userAuth)
      .send({ activityId: publishedActivityId, activityPositionId: frontCommandPositionId });
    expect(registered.status).toBeLessThan(300);
    expect(registered.body.data).toMatchObject({
      activityId: publishedActivityId,
      statusCode: 'pending',
    });
    const stored = await prisma.activityRegistration.findFirst({
      where: { activityId: publishedActivityId, memberId: userMemberId, deletedAt: null },
      select: { activityPositionId: true, statusCode: true },
    });
    expect(stored).toEqual({
      activityPositionId: frontCommandPositionId,
      statusCode: 'pending',
    });
  });
});
