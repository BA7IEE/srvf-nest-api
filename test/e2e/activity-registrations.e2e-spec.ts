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

// V2 第一阶段批次 3A activity-registrations 模块 e2e。
// 覆盖管理端 6 + 队员端 4 = 10 接口主成功 + 关键失败:
// - 权限边界 / DTO 白名单(Q-A3 双路径)
// - 状态机 4 态(pending → pass/reject/cancelled;pass → cancelled)
// - capacity 校验(仅 pass 占名额,Q-D17;cancelled 释放)
// - partial unique(同 activity 同 member;取消后允许重报)
// - USER 越权访问他人 → 404(沿 §1.7 风格)
// - CSV export(Q-A6:format=csv 默认;scope=pass 默认 / scope=all 可选;XLSX → 400;
//   副作用 0:不写库 / 不落 export_logs / 不生成 AttendanceRecord)

describe('activity-registrations 模块', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let adminAuth: string;
  let userWithMemberAuth: string; // USER + 已绑 Member(自助报名场景)
  let userNoMemberAuth: string; // USER + 未绑 Member(MEMBER_NOT_FOUND 场景)
  let otherUserWithMemberAuth: string; // 另一个 USER,用于越权场景

  let memberAId: string; // 绑定 userWithMember
  let memberBId: string; // 绑定 otherUserWithMember
  let memberCId: string; // 自由用 Member(代报名)
  let memberDId: string; // capacity 满测试

  let childOrgId: string;
  let activityTypeCode: string;

  // 测试用活动 id 集合(每个测试段独立创建,避免相互干扰)。
  let openActivityId: string; // public + 不限名额(主测试用)
  let privateActivityId: string; // isPublicRegistration=false
  let cancelledActivityId: string; // 已取消
  let capacityActivityId: string; // capacity=1(满名额测试)
  let exportActivityId: string; // 用于 CSV 导出测试

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    // 4 个 user
    await createTestUser(app, { username: 'reg-su', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'reg-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'reg-user-with-mem', role: Role.USER });
    await createTestUser(app, { username: 'reg-user-no-mem', role: Role.USER });
    await createTestUser(app, { username: 'reg-user-other', role: Role.USER });
    superAdminAuth = (await loginAs(app, 'reg-su')).authHeader;
    adminAuth = (await loginAs(app, 'reg-adm')).authHeader;
    userWithMemberAuth = (await loginAs(app, 'reg-user-with-mem')).authHeader;
    userNoMemberAuth = (await loginAs(app, 'reg-user-no-mem')).authHeader;
    otherUserWithMemberAuth = (await loginAs(app, 'reg-user-other')).authHeader;

    // 4 个 member
    const ma = await prisma.member.create({
      data: { memberNo: 'reg-m-a', displayName: 'Member A' },
      select: { id: true },
    });
    memberAId = ma.id;
    const mb = await prisma.member.create({
      data: { memberNo: 'reg-m-b', displayName: 'Member B' },
      select: { id: true },
    });
    memberBId = mb.id;
    const mc = await prisma.member.create({
      data: { memberNo: 'reg-m-c', displayName: 'Member C' },
      select: { id: true },
    });
    memberCId = mc.id;
    const md = await prisma.member.create({
      data: { memberNo: 'reg-m-d', displayName: 'Member D' },
      select: { id: true },
    });
    memberDId = md.id;

    // 绑定 user.memberId
    await prisma.user.update({
      where: { username: 'reg-user-with-mem' },
      data: { memberId: memberAId },
    });
    await prisma.user.update({
      where: { username: 'reg-user-other' },
      data: { memberId: memberBId },
    });

    // node_type + organization(子节点,Activity 可挂)
    const nodeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'reg-root', label: '根' },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'reg-child', label: '子' },
    });
    const rootOrg = await prisma.organization.create({
      data: { name: 'Reg Root', nodeTypeCode: 'reg-root', parentId: null },
      select: { id: true },
    });
    const childOrg = await prisma.organization.create({
      data: { name: 'Reg Child', nodeTypeCode: 'reg-child', parentId: rootOrg.id },
      select: { id: true },
    });
    childOrgId = childOrg.id;

    // activity_type 字典
    const actTypeDict = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    const ti = await prisma.dictItem.create({
      data: { typeId: actTypeDict.id, code: 'reg-demo-type', label: '演示类型' },
      select: { code: true },
    });
    activityTypeCode = ti.code;

    // 造 5 个不同业务态的活动(降低耦合,各段测试独立)。
    openActivityId = await createActivityHelper({
      title: 'OPEN-PUB',
      isPublicRegistration: true,
      capacity: undefined,
      publish: true,
    });
    privateActivityId = await createActivityHelper({
      title: 'PRIVATE-PUB',
      isPublicRegistration: false,
      capacity: undefined,
      publish: true,
    });
    cancelledActivityId = await createActivityHelper({
      title: 'CANCEL-PUB',
      isPublicRegistration: true,
      capacity: undefined,
      publish: true,
      cancel: true,
    });
    capacityActivityId = await createActivityHelper({
      title: 'CAP-PUB',
      isPublicRegistration: true,
      capacity: 1,
      publish: true,
    });
    exportActivityId = await createActivityHelper({
      title: 'EXPORT-PUB',
      isPublicRegistration: true,
      capacity: undefined,
      publish: true,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ helpers ============

  async function createActivityHelper(opts: {
    title: string;
    isPublicRegistration: boolean;
    capacity: number | undefined;
    publish: boolean;
    cancel?: boolean;
  }): Promise<string> {
    const create = await request(httpServer(app))
      .post('/api/v2/activities')
      .set('Authorization', adminAuth)
      .send({
        title: opts.title,
        activityTypeCode,
        organizationId: childOrgId,
        startAt: '2026-06-01T08:00:00.000Z',
        endAt: '2026-06-01T12:00:00.000Z',
        location: '演示地点',
        isPublicRegistration: opts.isPublicRegistration,
        ...(opts.capacity !== undefined ? { capacity: opts.capacity } : {}),
      });
    const id: string = create.body.data.id as string;
    if (opts.publish) {
      await request(httpServer(app))
        .patch(`/api/v2/activities/${id}/publish`)
        .set('Authorization', adminAuth);
    }
    if (opts.cancel) {
      await request(httpServer(app))
        .patch(`/api/v2/activities/${id}/cancel`)
        .set('Authorization', adminAuth)
        .send({});
    }
    return id;
  }

  // ============ 权限边界 ============

  describe('权限边界', () => {
    it('未登录 GET admin list → 401', async () => {
      const res = await request(httpServer(app)).get(
        `/api/v2/activities/${openActivityId}/registrations`,
      );
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER GET admin list → 403', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/activities/${openActivityId}/registrations`)
        .set('Authorization', userWithMemberAuth);
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER POST 代报名路径 → 403', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${openActivityId}/registrations`)
        .set('Authorization', userWithMemberAuth)
        .send({ memberId: memberCId });
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER PATCH approve → 403', async () => {
      const res = await request(httpServer(app))
        .patch(
          `/api/v2/activities/${openActivityId}/registrations/cl000000000000000000xxxx/approve`,
        )
        .set('Authorization', userWithMemberAuth)
        .send({});
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER GET export → 403', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/activities/${openActivityId}/registrations/export`)
        .set('Authorization', userWithMemberAuth);
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER POST 自助路径 → 200(允许)', async () => {
      // 注:用 capacity 不限的活动 + 后续在该 describe 段不再依赖该报名记录
      const res = await request(httpServer(app))
        .post(`/api/v2/users/me/activities/${openActivityId}/registration`)
        .set('Authorization', otherUserWithMemberAuth)
        .send({});
      expect(res.status).toBe(201);
      expect(res.body.data.statusCode).toBe('pending');
      // 清理:取消该测试报名,避免影响后续段(otherMember B 在 openActivity 上的占位)
      const id: string = res.body.data.id;
      await request(httpServer(app))
        .patch(`/api/v2/users/me/registrations/${id}/cancel`)
        .set('Authorization', otherUserWithMemberAuth)
        .send({});
    });

    it('未登录 POST 自助 → 401', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/users/me/activities/${openActivityId}/registration`)
        .send({});
      expectBizError(res, BizCode.UNAUTHORIZED);
    });
  });

  // ============ ADMIN POST 代报名 ============

  describe('ADMIN POST 代报名', () => {
    it('正常 → 201,statusCode=pending,memberId 来自 body', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${openActivityId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: memberCId });
      expect(res.status).toBe(201);
      expect(res.body.data.activityId).toBe(openActivityId);
      expect(res.body.data.memberId).toBe(memberCId);
      expect(res.body.data.statusCode).toBe('pending');
      expect(res.body.data.reviewedAt).toBeNull();
      expect(res.body.data.cancelledAt).toBeNull();
      expect(res.body.data).not.toHaveProperty('deletedAt');
    });

    it('SUPER_ADMIN 代报名 + extras → 201', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${openActivityId}/registrations`)
        .set('Authorization', superAdminAuth)
        .send({ memberId: memberDId, extras: { tShirtSize: 'L' } });
      expect(res.status).toBe(201);
      expect(res.body.data.extras).toEqual({ tShirtSize: 'L' });
    });

    it('memberId 不存在 → MEMBER_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${openActivityId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: 'cl0000000000000000000000' });
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('activity 不存在 → ACTIVITY_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/activities/cl0000000000000000000000/registrations')
        .set('Authorization', adminAuth)
        .send({ memberId: memberCId });
      expectBizError(res, BizCode.ACTIVITY_NOT_FOUND);
    });

    it('activity isPublicRegistration=false → ACTIVITY_NOT_PUBLIC_REGISTRATION', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${privateActivityId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: memberCId });
      expectBizError(res, BizCode.ACTIVITY_NOT_PUBLIC_REGISTRATION);
    });

    it('activity cancelled → ACTIVITY_CANCELLED_REGISTRATION_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${cancelledActivityId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: memberCId });
      expectBizError(res, BizCode.ACTIVITY_CANCELLED_REGISTRATION_FORBIDDEN);
    });

    it('同一 member 同一活动二次报名 → ACTIVITY_REGISTRATION_ALREADY_EXISTS', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${openActivityId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: memberCId });
      expectBizError(res, BizCode.ACTIVITY_REGISTRATION_ALREADY_EXISTS);
    });

    it('缺 memberId → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${openActivityId}/registrations`)
        .set('Authorization', adminAuth)
        .send({});
      expect(res.status).toBe(400);
    });

    it('non-whitelisted statusCode → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${openActivityId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: memberCId, statusCode: 'pass' });
      expect(res.status).toBe(400);
    });

    it('non-whitelisted reviewedBy → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${openActivityId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: memberCId, reviewedBy: 'cl0000000000000000000000' });
      expect(res.status).toBe(400);
    });

    it('non-whitelisted cancelledByUserId → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${openActivityId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: memberCId, cancelledByUserId: 'cl0000000000000000000000' });
      expect(res.status).toBe(400);
    });
  });

  // ============ USER POST 自助报名 ============

  describe('USER POST 自助报名(Q-A3)', () => {
    let myRegId: string;

    it('USER 未绑 member → MEMBER_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/users/me/activities/${openActivityId}/registration`)
        .set('Authorization', userNoMemberAuth)
        .send({});
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('USER 自助报名:memberId 强制注入(忽略 body memberId 字段 → DTO 拒绝)', async () => {
      // 传 memberId 试图越权 → DTO 白名单拒绝 400
      const res = await request(httpServer(app))
        .post(`/api/v2/users/me/activities/${exportActivityId}/registration`)
        .set('Authorization', userWithMemberAuth)
        .send({ memberId: memberCId });
      expect(res.status).toBe(400);
    });

    it('USER 自助报名(无 body)→ 201,memberId=currentUser.memberId', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/users/me/activities/${exportActivityId}/registration`)
        .set('Authorization', userWithMemberAuth)
        .send({});
      expect(res.status).toBe(201);
      expect(res.body.data.memberId).toBe(memberAId);
      expect(res.body.data.statusCode).toBe('pending');
      myRegId = res.body.data.id;
    });

    it('USER 自助 + extras → 201', async () => {
      const id = await createActivityHelper({
        title: 'SELF-EXTRAS',
        isPublicRegistration: true,
        capacity: undefined,
        publish: true,
      });
      const res = await request(httpServer(app))
        .post(`/api/v2/users/me/activities/${id}/registration`)
        .set('Authorization', userWithMemberAuth)
        .send({ extras: { wantsAccommodation: true } });
      expect(res.status).toBe(201);
      expect(res.body.data.extras).toEqual({ wantsAccommodation: true });
    });

    it('USER 自助报名重复 → ACTIVITY_REGISTRATION_ALREADY_EXISTS', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/users/me/activities/${exportActivityId}/registration`)
        .set('Authorization', userWithMemberAuth)
        .send({});
      expectBizError(res, BizCode.ACTIVITY_REGISTRATION_ALREADY_EXISTS);
    });

    it('USER 自助报名 cancelled activity → ACTIVITY_CANCELLED_REGISTRATION_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/users/me/activities/${cancelledActivityId}/registration`)
        .set('Authorization', userWithMemberAuth)
        .send({});
      expectBizError(res, BizCode.ACTIVITY_CANCELLED_REGISTRATION_FORBIDDEN);
    });

    it('USER 自助:取消后允许重新报名(partial unique 释放,Q-D17)', async () => {
      const id = await createActivityHelper({
        title: 'SELF-RETRY',
        isPublicRegistration: true,
        capacity: undefined,
        publish: true,
      });
      // 第一次
      const r1 = await request(httpServer(app))
        .post(`/api/v2/users/me/activities/${id}/registration`)
        .set('Authorization', userWithMemberAuth)
        .send({});
      expect(r1.status).toBe(201);
      const reg1: string = r1.body.data.id;
      // 取消
      await request(httpServer(app))
        .patch(`/api/v2/users/me/registrations/${reg1}/cancel`)
        .set('Authorization', userWithMemberAuth)
        .send({});
      // 第二次报名应成功
      const r2 = await request(httpServer(app))
        .post(`/api/v2/users/me/activities/${id}/registration`)
        .set('Authorization', userWithMemberAuth)
        .send({});
      expect(r2.status).toBe(201);
      expect(r2.body.data.id).not.toBe(reg1);
    });

    // 记录:供其他 describe 使用 myRegId 的场景 — 显式声明使用
    it('myRegId 已就绪(标记)', () => {
      expect(myRegId).toBeTruthy();
    });
  });

  // ============ Capacity 校验(只 pass 占名额;cancelled 释放)============

  describe('Capacity 校验', () => {
    it('capacity=1 + pending 占位时,创建第二条 pending 仍允许', async () => {
      // 第一条 pending(memberC)
      const r1 = await request(httpServer(app))
        .post(`/api/v2/activities/${capacityActivityId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: memberCId });
      expect(r1.status).toBe(201);
      // 第二条 pending(memberD)— 应被允许(还没占名额)
      const r2 = await request(httpServer(app))
        .post(`/api/v2/activities/${capacityActivityId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: memberDId });
      expect(r2.status).toBe(201);
    });

    it('capacity=1 + 1 pass 时,approve 第二条 pending → ACTIVITY_CAPACITY_EXCEEDED', async () => {
      // 找出 memberC / memberD 的两条 pending
      const rows = await prisma.activityRegistration.findMany({
        where: { activityId: capacityActivityId, deletedAt: null },
        select: { id: true, memberId: true },
      });
      const regC = rows.find((r) => r.memberId === memberCId);
      const regD = rows.find((r) => r.memberId === memberDId);
      expect(regC).toBeTruthy();
      expect(regD).toBeTruthy();
      // approve C → 200(占满)
      const a1 = await request(httpServer(app))
        .patch(`/api/v2/activities/${capacityActivityId}/registrations/${regC!.id}/approve`)
        .set('Authorization', adminAuth)
        .send({});
      expect(a1.status).toBe(200);
      // approve D → 21032
      const a2 = await request(httpServer(app))
        .patch(`/api/v2/activities/${capacityActivityId}/registrations/${regD!.id}/approve`)
        .set('Authorization', adminAuth)
        .send({});
      expectBizError(a2, BizCode.ACTIVITY_CAPACITY_EXCEEDED);
    });

    it('cancel pass 释放名额后,可再次 approve', async () => {
      const rows = await prisma.activityRegistration.findMany({
        where: { activityId: capacityActivityId, deletedAt: null },
        select: { id: true, memberId: true, statusCode: true },
      });
      const regC = rows.find((r) => r.memberId === memberCId && r.statusCode === 'pass');
      const regD = rows.find((r) => r.memberId === memberDId);
      expect(regC).toBeTruthy();
      expect(regD).toBeTruthy();
      // 取消 C(释放名额)
      const c = await request(httpServer(app))
        .patch(`/api/v2/activities/${capacityActivityId}/registrations/${regC!.id}/cancel`)
        .set('Authorization', adminAuth)
        .send({});
      expect(c.status).toBe(200);
      expect(c.body.data.statusCode).toBe('cancelled');
      // 现在 approve D 应成功
      const a = await request(httpServer(app))
        .patch(`/api/v2/activities/${capacityActivityId}/registrations/${regD!.id}/approve`)
        .set('Authorization', adminAuth)
        .send({});
      expect(a.status).toBe(200);
      expect(a.body.data.statusCode).toBe('pass');
    });

    it('capacity 满时,POST 新报名直接拒绝(create 路径 ACTIVITY_CAPACITY_EXCEEDED)', async () => {
      // 造一个 capacity=1 的活动,1 pass + 第二个 member create → 21032
      const id = await createActivityHelper({
        title: 'CAP-FULL',
        isPublicRegistration: true,
        capacity: 1,
        publish: true,
      });
      const r1 = await request(httpServer(app))
        .post(`/api/v2/activities/${id}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: memberCId });
      expect(r1.status).toBe(201);
      await request(httpServer(app))
        .patch(`/api/v2/activities/${id}/registrations/${r1.body.data.id}/approve`)
        .set('Authorization', adminAuth)
        .send({});

      // memberD create → 21032
      const r2 = await request(httpServer(app))
        .post(`/api/v2/activities/${id}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: memberDId });
      expectBizError(r2, BizCode.ACTIVITY_CAPACITY_EXCEEDED);
    });
  });

  // ============ approve / reject / cancel 状态机 ============

  describe('approve 状态机', () => {
    let pendingRegId: string;
    let alreadyPassedRegId: string;

    beforeAll(async () => {
      const id = await createActivityHelper({
        title: 'APP-A',
        isPublicRegistration: true,
        capacity: undefined,
        publish: true,
      });
      const r1 = await request(httpServer(app))
        .post(`/api/v2/activities/${id}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: memberCId });
      pendingRegId = r1.body.data.id;

      const r2 = await request(httpServer(app))
        .post(`/api/v2/activities/${id}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: memberDId });
      alreadyPassedRegId = r2.body.data.id;
      await request(httpServer(app))
        .patch(`/api/v2/activities/${id}/registrations/${alreadyPassedRegId}/approve`)
        .set('Authorization', adminAuth)
        .send({});

      // 保留 activityId for next tests via closure
      approveActivityId = id;
    });

    let approveActivityId: string;

    it('approve pending → pass;写 reviewedBy/At', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${approveActivityId}/registrations/${pendingRegId}/approve`)
        .set('Authorization', adminAuth)
        .send({ reviewNote: '通过' });
      expect(res.status).toBe(200);
      expect(res.body.data.statusCode).toBe('pass');
      expect(res.body.data.reviewNote).toBe('通过');
      expect(res.body.data.reviewedBy).toBeTruthy();
      expect(res.body.data.reviewedAt).toBeTruthy();
    });

    it('再次 approve 已 pass → ACTIVITY_REGISTRATION_STATUS_INVALID', async () => {
      const res = await request(httpServer(app))
        .patch(
          `/api/v2/activities/${approveActivityId}/registrations/${alreadyPassedRegId}/approve`,
        )
        .set('Authorization', adminAuth)
        .send({});
      expectBizError(res, BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    });

    it('approve 不存在 id → ACTIVITY_REGISTRATION_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .patch(
          `/api/v2/activities/${approveActivityId}/registrations/cl0000000000000000000000/approve`,
        )
        .set('Authorization', adminAuth)
        .send({});
      expectBizError(res, BizCode.ACTIVITY_REGISTRATION_NOT_FOUND);
    });

    it('跨 activityId 访问 → 404(避免存在性泄漏)', async () => {
      // pendingRegId 实际属于 approveActivityId,用 openActivityId 当父路径 → 404
      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${openActivityId}/registrations/${pendingRegId}/approve`)
        .set('Authorization', adminAuth)
        .send({});
      expectBizError(res, BizCode.ACTIVITY_REGISTRATION_NOT_FOUND);
    });
  });

  describe('reject 状态机', () => {
    let pendingRegId: string;
    let passRegId: string;
    let activityId: string;

    beforeAll(async () => {
      activityId = await createActivityHelper({
        title: 'REJ-A',
        isPublicRegistration: true,
        capacity: undefined,
        publish: true,
      });
      const r1 = await request(httpServer(app))
        .post(`/api/v2/activities/${activityId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: memberCId });
      pendingRegId = r1.body.data.id;
      const r2 = await request(httpServer(app))
        .post(`/api/v2/activities/${activityId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: memberDId });
      passRegId = r2.body.data.id;
      await request(httpServer(app))
        .patch(`/api/v2/activities/${activityId}/registrations/${passRegId}/approve`)
        .set('Authorization', adminAuth)
        .send({});
    });

    it('reject pending → reject;reviewNote 必填(传)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${activityId}/registrations/${pendingRegId}/reject`)
        .set('Authorization', adminAuth)
        .send({ reviewNote: '资格不符' });
      expect(res.status).toBe(200);
      expect(res.body.data.statusCode).toBe('reject');
      expect(res.body.data.reviewNote).toBe('资格不符');
    });

    it('reject 缺 reviewNote → 400(必填)', async () => {
      const id = await createActivityHelper({
        title: 'REJ-B',
        isPublicRegistration: true,
        capacity: undefined,
        publish: true,
      });
      const r = await request(httpServer(app))
        .post(`/api/v2/activities/${id}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: memberCId });
      const regId: string = r.body.data.id;
      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${id}/registrations/${regId}/reject`)
        .set('Authorization', adminAuth)
        .send({});
      expect(res.status).toBe(400);
    });

    it('reject pass(非 pending)→ ACTIVITY_REGISTRATION_STATUS_INVALID', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${activityId}/registrations/${passRegId}/reject`)
        .set('Authorization', adminAuth)
        .send({ reviewNote: '试图驳回已通过' });
      expectBizError(res, BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    });
  });

  describe('cancel 状态机(管理员代取消)', () => {
    let pendingRegId: string;
    let passRegId: string;
    let cancelActivityId: string;

    beforeAll(async () => {
      cancelActivityId = await createActivityHelper({
        title: 'CXL-A',
        isPublicRegistration: true,
        capacity: undefined,
        publish: true,
      });
      const r1 = await request(httpServer(app))
        .post(`/api/v2/activities/${cancelActivityId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: memberCId });
      pendingRegId = r1.body.data.id;
      const r2 = await request(httpServer(app))
        .post(`/api/v2/activities/${cancelActivityId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: memberDId });
      passRegId = r2.body.data.id;
      await request(httpServer(app))
        .patch(`/api/v2/activities/${cancelActivityId}/registrations/${passRegId}/approve`)
        .set('Authorization', adminAuth)
        .send({});
    });

    it('cancel pending → cancelled;cancelReason 入库', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${cancelActivityId}/registrations/${pendingRegId}/cancel`)
        .set('Authorization', adminAuth)
        .send({ cancelReason: '队员请假' });
      expect(res.status).toBe(200);
      expect(res.body.data.statusCode).toBe('cancelled');
      expect(res.body.data.cancelReason).toBe('队员请假');
      expect(res.body.data.cancelledByUserId).toBeTruthy();
      expect(res.body.data.cancelledAt).toBeTruthy();
    });

    it('cancel pass → cancelled', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${cancelActivityId}/registrations/${passRegId}/cancel`)
        .set('Authorization', adminAuth)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.data.statusCode).toBe('cancelled');
      expect(res.body.data.cancelReason).toBeNull();
    });

    it('cancel 再次取消 cancelled → ACTIVITY_REGISTRATION_STATUS_INVALID', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${cancelActivityId}/registrations/${passRegId}/cancel`)
        .set('Authorization', adminAuth)
        .send({});
      expectBizError(res, BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    });

    it('cancel reject 态 → ACTIVITY_REGISTRATION_STATUS_INVALID', async () => {
      const id = await createActivityHelper({
        title: 'CXL-REJ',
        isPublicRegistration: true,
        capacity: undefined,
        publish: true,
      });
      const r = await request(httpServer(app))
        .post(`/api/v2/activities/${id}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: memberCId });
      await request(httpServer(app))
        .patch(`/api/v2/activities/${id}/registrations/${r.body.data.id}/reject`)
        .set('Authorization', adminAuth)
        .send({ reviewNote: '拒绝' });

      const res = await request(httpServer(app))
        .patch(`/api/v2/activities/${id}/registrations/${r.body.data.id}/cancel`)
        .set('Authorization', adminAuth)
        .send({});
      expectBizError(res, BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    });
  });

  // ============ ADMIN list ============

  describe('ADMIN GET list', () => {
    let listActivityId: string;

    beforeAll(async () => {
      listActivityId = await createActivityHelper({
        title: 'LIST-A',
        isPublicRegistration: true,
        capacity: undefined,
        publish: true,
      });
      // 造 3 条:pending / pass / cancelled
      const m1 = memberCId;
      const m2 = memberDId;
      const m3 = (
        await prisma.member.create({
          data: { memberNo: 'reg-m-list', displayName: 'List Member' },
          select: { id: true },
        })
      ).id;

      const r1 = await request(httpServer(app))
        .post(`/api/v2/activities/${listActivityId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: m1 });
      const r2 = await request(httpServer(app))
        .post(`/api/v2/activities/${listActivityId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: m2 });
      await request(httpServer(app))
        .patch(`/api/v2/activities/${listActivityId}/registrations/${r2.body.data.id}/approve`)
        .set('Authorization', adminAuth)
        .send({});

      const r3 = await request(httpServer(app))
        .post(`/api/v2/activities/${listActivityId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: m3 });
      await request(httpServer(app))
        .patch(`/api/v2/activities/${listActivityId}/registrations/${r3.body.data.id}/cancel`)
        .set('Authorization', adminAuth)
        .send({});

      void r1;
    });

    it('list 返回所有状态(含 cancelled)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/activities/${listActivityId}/registrations`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBeGreaterThanOrEqual(3);
      const statuses = (res.body.data.items as Array<{ statusCode: string }>).map(
        (i) => i.statusCode,
      );
      expect(statuses).toEqual(expect.arrayContaining(['pending', 'pass', 'cancelled']));
    });

    it('list + statusCode=pass 过滤', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/activities/${listActivityId}/registrations`)
        .query({ statusCode: 'pass' })
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      const statuses = (res.body.data.items as Array<{ statusCode: string }>).map(
        (i) => i.statusCode,
      );
      for (const s of statuses) expect(s).toBe('pass');
    });

    it('list 列表项含 memberNo / memberDisplayName 冗余字段', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/activities/${listActivityId}/registrations`)
        .set('Authorization', adminAuth);
      const first = res.body.data.items[0] as Record<string, unknown>;
      expect(first).toHaveProperty('memberNo');
      expect(first).toHaveProperty('memberDisplayName');
    });

    it('activity 不存在 → ACTIVITY_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/activities/cl0000000000000000000000/registrations')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ACTIVITY_NOT_FOUND);
    });
  });

  // ============ USER me 路径 ============

  describe('USER /me 路径', () => {
    let myActivityId: string;
    let myRegId: string;
    let otherRegId: string;

    beforeAll(async () => {
      myActivityId = await createActivityHelper({
        title: 'ME-A',
        isPublicRegistration: true,
        capacity: undefined,
        publish: true,
      });
      // userWithMember(memberA)报名
      const r1 = await request(httpServer(app))
        .post(`/api/v2/users/me/activities/${myActivityId}/registration`)
        .set('Authorization', userWithMemberAuth)
        .send({});
      myRegId = r1.body.data.id;
      // otherUser(memberB)报名(用于越权场景)
      const r2 = await request(httpServer(app))
        .post(`/api/v2/users/me/activities/${myActivityId}/registration`)
        .set('Authorization', otherUserWithMemberAuth)
        .send({});
      otherRegId = r2.body.data.id;
    });

    it('GET /me/registrations 仅返自己的', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/registrations')
        .set('Authorization', userWithMemberAuth);
      expect(res.status).toBe(200);
      const ids: string[] = (res.body.data.items as Array<{ id: string }>).map((i) => i.id);
      expect(ids).toContain(myRegId);
      expect(ids).not.toContain(otherRegId);
    });

    it('USER 未绑 member 调 /me/registrations → MEMBER_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/registrations')
        .set('Authorization', userNoMemberAuth);
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('GET /me/registrations/:id 自己的 → 200', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/users/me/registrations/${myRegId}`)
        .set('Authorization', userWithMemberAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(myRegId);
    });

    it('GET /me/registrations/:id 他人的 → 404(避免存在性泄漏)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/users/me/registrations/${otherRegId}`)
        .set('Authorization', userWithMemberAuth);
      expectBizError(res, BizCode.ACTIVITY_REGISTRATION_NOT_FOUND);
    });

    it('PATCH /me/registrations/:id/cancel 自己的 pending → cancelled', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/users/me/registrations/${myRegId}/cancel`)
        .set('Authorization', userWithMemberAuth)
        .send({ cancelReason: '临时有事' });
      expect(res.status).toBe(200);
      expect(res.body.data.statusCode).toBe('cancelled');
      expect(res.body.data.cancelReason).toBe('临时有事');
    });

    it('PATCH /me/registrations/:id/cancel 已 cancelled → ACTIVITY_REGISTRATION_STATUS_INVALID', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/users/me/registrations/${myRegId}/cancel`)
        .set('Authorization', userWithMemberAuth)
        .send({});
      expectBizError(res, BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    });

    it('PATCH /me/registrations/:id/cancel 他人的 → 404', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/users/me/registrations/${otherRegId}/cancel`)
        .set('Authorization', userWithMemberAuth)
        .send({});
      expectBizError(res, BizCode.ACTIVITY_REGISTRATION_NOT_FOUND);
    });
  });

  // ============ CSV export(Q-A6) ============

  describe('CSV export(Q-A6)', () => {
    let exActivityId: string;

    beforeAll(async () => {
      exActivityId = await createActivityHelper({
        title: 'EX-CSV',
        isPublicRegistration: true,
        capacity: undefined,
        publish: true,
      });
      // 造 3 条:1 pending / 1 pass / 1 cancelled
      const m1 = memberCId;
      const m2 = memberDId;
      const m3 = (
        await prisma.member.create({
          data: { memberNo: 'reg-m-csv', displayName: 'CSV Member' },
          select: { id: true },
        })
      ).id;

      await request(httpServer(app))
        .post(`/api/v2/activities/${exActivityId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: m1 });
      const r2 = await request(httpServer(app))
        .post(`/api/v2/activities/${exActivityId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: m2 });
      await request(httpServer(app))
        .patch(`/api/v2/activities/${exActivityId}/registrations/${r2.body.data.id}/approve`)
        .set('Authorization', adminAuth)
        .send({});
      const r3 = await request(httpServer(app))
        .post(`/api/v2/activities/${exActivityId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: m3 });
      await request(httpServer(app))
        .patch(`/api/v2/activities/${exActivityId}/registrations/${r3.body.data.id}/cancel`)
        .set('Authorization', adminAuth)
        .send({});
    });

    it('默认 format=csv + scope=pass → 200 + text/csv + 仅 pass 行', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/activities/${exActivityId}/registrations/export`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      const body = res.text;
      expect(body).toContain('registration_id,member_id');
      // pass 行计数:数据行(不含 header)
      const lines = body.split('\n').filter((l) => l.length > 0);
      expect(lines.length).toBe(2); // 1 header + 1 pass(BOM 不算行)
    });

    it('scope=all → 200 + 3 数据行(pending + pass + cancelled)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/activities/${exActivityId}/registrations/export`)
        .query({ scope: 'all' })
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      const lines = res.text.split('\n').filter((l) => l.length > 0);
      expect(lines.length).toBe(4); // 1 header + 3 data
    });

    it('format=xlsx → 400(Q-A6 第一版仅 CSV)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/activities/${exActivityId}/registrations/export`)
        .query({ format: 'xlsx' })
        .set('Authorization', adminAuth);
      expect(res.status).toBe(400);
    });

    it('scope=invalid → 400', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/activities/${exActivityId}/registrations/export`)
        .query({ scope: 'invalid' })
        .set('Authorization', adminAuth);
      expect(res.status).toBe(400);
    });

    it('USER 调 export → 403', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/activities/${exActivityId}/registrations/export`)
        .set('Authorization', userWithMemberAuth);
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('未登录调 export → 401', async () => {
      const res = await request(httpServer(app)).get(
        `/api/v2/activities/${exActivityId}/registrations/export`,
      );
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('activity 不存在 → ACTIVITY_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/activities/cl0000000000000000000000/registrations/export')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ACTIVITY_NOT_FOUND);
    });

    it('Q-A6 副作用 0:导出后 ActivityRegistration / AttendanceRecord 行数不变', async () => {
      const beforeReg = await prisma.activityRegistration.count();
      const beforeRec = await prisma.attendanceRecord.count();
      await request(httpServer(app))
        .get(`/api/v2/activities/${exActivityId}/registrations/export`)
        .query({ scope: 'all' })
        .set('Authorization', adminAuth);
      const afterReg = await prisma.activityRegistration.count();
      const afterRec = await prisma.attendanceRecord.count();
      expect(afterReg).toBe(beforeReg);
      expect(afterRec).toBe(beforeRec);
    });

    it('CSV 内含 UTF-8 BOM 前缀(让 Excel 自动识别中文)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/activities/${exActivityId}/registrations/export`)
        .set('Authorization', adminAuth);
      expect(res.text.charCodeAt(0)).toBe(0xfeff);
    });
  });
});
