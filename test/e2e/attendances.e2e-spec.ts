import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// Slow-4 T3(2026-06-11,评审稿 §8 / D-S4-4):管理端 10 端点入口切到 service 层 rbac.can(),
// 失败统一 RBAC_FORBIDDEN(30100)。`adminAuth` 在 beforeAll 全局 grant biz-admin,
// 业务断言零修改;细粒度判权矩阵另见 attendances-rbac-boundary.e2e-spec.ts。
//
// V2 第一阶段批次 3B attendances 模块 e2e。
// 覆盖 9 接口主成功 + 关键失败:
// - 权限边界 / DTO 白名单
// - 状态机 3 态(submit pending / approve approved / reject rejected)
// - 时间不重叠(R16 / Q-S15;同 memberId × [start, end) 左闭右开;跨 Sheet / 跨 Activity 全局)
// - serviceHours 自动计算 + 手填 + <=0 + > 跨度(D14 / D45 / D51 / D46)
// - registrationId 跨表 R23(registration.activityId === sheet.activityId)
// - approved / rejected 不可改 / 不可删(22040 / 22041)
// - previousSnapshot 后端自动生成 + version+1(R28 / Q-S16)
// - contributionPoints approved 前必填(R31 / 22072)
// - cancelled Activity 拒 submit(20122)
// - 队员端 /me/attendance-records:仅 approved Sheet 内 records(Q-A14)
// - USER 越权 → 不在结果集

describe('attendances 模块', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let adminAuth: string;
  // 终态 scoped-authz PR9:第二身份专职终审 —— 自审禁止(submitter==终审人 → 22074)+
  // 同人默认禁止(一级 reviewer==终审人 → 22075)后,单人无法再走完 submit→approve→final 全程;
  // 摘码微刀(2026-07-03):biz-admin 不再持终审两码 → 终审人从 ADMIN+biz-admin 换成
  // SUPER_ADMIN(SA 兜底通路;仅换身份,业务断言零修改)。本 spec submit/一级审仍 adminAuth,
  // final-approve / final-reject 一律 finalAdminAuth(权限/约束矩阵见
  // attendances-final-review-authz.e2e-spec.ts + attendances-rbac-boundary.e2e-spec.ts)。
  let finalAdminAuth: string;
  let userWithMemberAuth: string;

  let memberAId: string;
  let memberBId: string;
  let memberCId: string;
  let otherMemberId: string;

  let activityId: string; // 主测试活动(published)
  let activityCancelledId: string; // 已取消活动
  let activityOtherId: string; // 另一活动(用于跨 activity 不重叠 + registration mismatch)

  let registrationAId: string; // memberA 在 activityId 的报名(用于 R23 正向)
  let registrationOtherActivityId: string; // memberA 在 activityOtherId 的报名(用于 R23 反向)

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    // 用户(权限边界只需 1 个已绑 member 的 USER)
    await createTestUser(app, { username: 'att-su', role: Role.SUPER_ADMIN });
    const admin = await createTestUser(app, { username: 'att-adm', role: Role.ADMIN });
    // PR9 第二身份专职终审;摘码微刀(2026-07-03)后为 SUPER_ADMIN(SA 兜底通路,见上方注释)
    await createTestUser(app, { username: 'att-final-adm', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'att-user-with-mem', role: Role.USER });
    superAdminAuth = (await loginAs(app, 'att-su')).authHeader;
    adminAuth = (await loginAs(app, 'att-adm')).authHeader;
    finalAdminAuth = (await loginAs(app, 'att-final-adm')).authHeader;
    userWithMemberAuth = (await loginAs(app, 'att-user-with-mem')).authHeader;

    // Slow-4 T3:seed 业务面码 + biz-admin;给 att-adm 全局 grant(沿 org e2e 范式;
    // att-final-adm 是 SA 走短路,不 grant —— biz-admin 已无终审两码,grant 也无用)
    const bizSeed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, admin.id, bizSeed.bizAdminRoleId);

    const ma = await prisma.member.create({
      data: { memberNo: 'att-m-a', displayName: 'Member A' },
      select: { id: true },
    });
    memberAId = ma.id;
    const mb = await prisma.member.create({
      data: { memberNo: 'att-m-b', displayName: 'Member B' },
      select: { id: true },
    });
    memberBId = mb.id;
    const mc = await prisma.member.create({
      data: { memberNo: 'att-m-c', displayName: 'Member C' },
      select: { id: true },
    });
    memberCId = mc.id;
    const mOther = await prisma.member.create({
      data: { memberNo: 'att-m-other', displayName: 'Other Member' },
      select: { id: true },
    });
    otherMemberId = mOther.id;

    await prisma.user.update({
      where: { username: 'att-user-with-mem' },
      data: { memberId: memberAId },
    });

    // 字典:node_type + activity_type + attendance_role + attendance_status
    const nodeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'att-root', label: '根' },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'att-child', label: '子' },
    });
    const rootOrg = await prisma.organization.create({
      data: { name: 'Att Root', nodeTypeCode: 'att-root', parentId: null },
      select: { id: true },
    });
    const childOrg = await prisma.organization.create({
      data: { name: 'Att Child', nodeTypeCode: 'att-child', parentId: rootOrg.id },
      select: { id: true },
    });

    const actTypeDict = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    const ti = await prisma.dictItem.create({
      data: { typeId: actTypeDict.id, code: 'att-demo', label: '演示' },
      select: { code: true },
    });

    // attendance_role 字典(7 项闭集)
    const roleDict = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    for (const code of [
      'member',
      'instructor',
      'assistant',
      'coach',
      'front_command',
      'back_command',
      'info',
    ]) {
      await prisma.dictItem.create({
        data: { typeId: roleDict.id, code, label: code },
      });
    }

    // attendance_status 字典(3 项闭集;absent/leave 故意不建)
    const statDict = await prisma.dictType.create({
      data: { code: 'attendance_status', label: '考勤状态' },
      select: { id: true },
    });
    for (const code of ['present', 'late', 'early_leave']) {
      await prisma.dictItem.create({
        data: { typeId: statDict.id, code, label: code },
      });
    }

    // 主活动(published)
    const actCreate = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', adminAuth)
      .send({
        title: 'ATT-MAIN',
        activityTypeCode: ti.code,
        organizationId: childOrg.id,
        startAt: '2099-06-01T08:00:00.000Z',
        endAt: '2099-06-01T18:00:00.000Z',
        location: '演示',
      });
    activityId = actCreate.body.data.id;
    await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityId}/publish`)
      .set('Authorization', adminAuth);

    // 已取消活动
    const actCancel = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', adminAuth)
      .send({
        title: 'ATT-CANCEL',
        activityTypeCode: ti.code,
        organizationId: childOrg.id,
        startAt: '2099-06-01T08:00:00.000Z',
        endAt: '2099-06-01T18:00:00.000Z',
        location: '演示',
      });
    activityCancelledId = actCancel.body.data.id;
    await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityCancelledId}/publish`)
      .set('Authorization', adminAuth);
    await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityCancelledId}/cancel`)
      .set('Authorization', adminAuth)
      .send({});

    // 另一活动(用于跨 activity 时间冲突 + R23 mismatch)
    const actOther = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', adminAuth)
      .send({
        title: 'ATT-OTHER',
        activityTypeCode: ti.code,
        organizationId: childOrg.id,
        startAt: '2099-06-02T08:00:00.000Z',
        endAt: '2099-06-02T18:00:00.000Z',
        location: '演示',
      });
    activityOtherId = actOther.body.data.id;
    await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityOtherId}/publish`)
      .set('Authorization', adminAuth);

    // 报名 memberA 到 activityId(R23 正向)
    const reg1 = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activityId}/registrations`)
      .set('Authorization', adminAuth)
      .send({ memberId: memberAId });
    registrationAId = reg1.body.data.id;

    // 报名 memberA 到 activityOtherId(R23 反向:registration.activityId !== sheet.activityId)
    const reg2 = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activityOtherId}/registrations`)
      .set('Authorization', adminAuth)
      .send({ memberId: memberAId });
    registrationOtherActivityId = reg2.body.data.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ helpers ============

  const baseRecord = (override: Record<string, unknown> = {}): Record<string, unknown> => ({
    memberId: memberAId,
    roleCode: 'member',
    checkInAt: '2099-06-01T08:00:00.000Z',
    checkOutAt: '2099-06-01T12:00:00.000Z',
    attendanceStatusCode: 'present',
    ...override,
  });

  // 在新建 sheet 后补 records contributionPoints(approve 前必填,R31)
  async function fillContributionPoints(sheetId: string, value = 1.0): Promise<void> {
    await prisma.attendanceRecord.updateMany({
      where: { sheetId, deletedAt: null },
      data: { contributionPoints: value },
    });
  }

  async function createPendingSheet(
    actId: string,
    records: Array<Record<string, unknown>>,
  ): Promise<string> {
    const res = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${actId}/attendance-sheets`)
      .set('Authorization', adminAuth)
      .send({ records });
    if (res.status !== 201) {
      throw new Error(`createPendingSheet failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.data.id as string;
  }

  // 批次 4-B helper:推到 pending_final_review(APD 一级 approve)。
  async function approveToPendingFinalReview(sheetId: string): Promise<void> {
    const res = await request(httpServer(app))
      .patch(`/api/admin/v1/attendance-sheets/${sheetId}/approve`)
      .set('Authorization', adminAuth)
      .send({});
    if (res.status !== 200) {
      throw new Error(
        `approveToPendingFinalReview failed: ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
  }

  // 批次 4-B helper:推到 approved 终态(APD 一级 approve + APD 部门部长 / 副部长 final-approve)。
  // 沿决议表 v1.0 D5 候选 B + D-S6:approved 语义升级为"终审通过"。
  // PR9:终审换 finalAdminAuth(submit/一级审是 adminAuth —— 自审 22074 / 同人 22075 约束生效后
  // 同一人不能再终审)。
  async function approveToTerminalApproved(sheetId: string): Promise<void> {
    await approveToPendingFinalReview(sheetId);
    const res = await request(httpServer(app))
      .patch(`/api/admin/v1/attendance-sheets/${sheetId}/final-approve`)
      .set('Authorization', finalAdminAuth)
      .send({});
    if (res.status !== 200) {
      throw new Error(
        `approveToTerminalApproved failed: ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
  }

  // 批次 4-B helper:推到 final_rejected 终态(一级 approve = adminAuth,final-reject =
  // finalAdminAuth —— 摘码微刀后 biz-admin 无终审码,终审一律走 SA 兜底身份)。
  async function approveThenFinalReject(
    sheetId: string,
    note = 'fixture final reject',
  ): Promise<void> {
    await approveToPendingFinalReview(sheetId);
    const res = await request(httpServer(app))
      .patch(`/api/admin/v1/attendance-sheets/${sheetId}/final-reject`)
      .set('Authorization', finalAdminAuth)
      .send({ finalReviewNote: note });
    if (res.status !== 200) {
      throw new Error(`approveThenFinalReject failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
  }

  // ============ 权限边界 ============

  describe('权限边界', () => {
    it('未登录 POST submit → 401', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .send({ records: [baseRecord()] });
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER POST submit → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', userWithMemberAuth)
        .send({ records: [baseRecord()] });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER GET list → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', userWithMemberAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER GET detail → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/attendance-sheets/cl000000000000000000xxxx`)
        .set('Authorization', userWithMemberAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER GET review-detail → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/attendance-sheets/cl000000000000000000xxxx/review-detail`)
        .set('Authorization', userWithMemberAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER PATCH edit → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/cl000000000000000000xxxx`)
        .set('Authorization', userWithMemberAuth)
        .send({});
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER DELETE → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/attendance-sheets/cl000000000000000000xxxx`)
        .set('Authorization', userWithMemberAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER PATCH approve → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/cl000000000000000000xxxx/approve`)
        .set('Authorization', userWithMemberAuth)
        .send({});
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER PATCH reject → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/cl000000000000000000xxxx/reject`)
        .set('Authorization', userWithMemberAuth)
        .send({ reviewNote: 'x' });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  // ============ POST submit 主成功 ============

  describe('POST submit 主路径', () => {
    it('正常提交单 record → 201,statusCode=pending,version=1', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberBId,
              checkInAt: '2099-06-01T09:00:00.000Z',
              checkOutAt: '2099-06-01T11:00:00.000Z',
            }),
          ],
        });
      expect(res.status).toBe(201);
      expect(res.body.data.activityId).toBe(activityId);
      expect(res.body.data.statusCode).toBe('pending');
      expect(res.body.data.version).toBe(1);
      expect(res.body.data.submittedAt).toBeTruthy();
      expect(res.body.data.submitterUserId).toBeTruthy();
      expect(res.body.data.reviewerUserId).toBeNull();
      expect(res.body.data.reviewedAt).toBeNull();
      expect(res.body.data.reviewNote).toBeNull();
      expect(res.body.data).not.toHaveProperty('deletedAt');
      expect(res.body.data).not.toHaveProperty('previousSnapshot');
    });

    it('提交多 records(memberA + memberC)→ 201', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityOtherId}/attendance-sheets`)
        .set('Authorization', superAdminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberCId,
              checkInAt: '2099-06-02T09:00:00.000Z',
              checkOutAt: '2099-06-02T11:00:00.000Z',
            }),
            baseRecord({
              memberId: memberBId,
              checkInAt: '2099-06-02T13:00:00.000Z',
              checkOutAt: '2099-06-02T15:00:00.000Z',
            }),
          ],
        });
      expect(res.status).toBe(201);
    });

    it('提交时不传 serviceHours → 后端自动 (checkOut-checkIn)/3600', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-01T10:00:00.000Z',
          checkOutAt: '2099-06-01T13:30:00.000Z',
        }),
      ]);
      const records = await prisma.attendanceRecord.findMany({ where: { sheetId: id } });
      expect(records[0].serviceHours.toString()).toBe('3.5');
    });

    it('提交时手填 serviceHours < 跨度 → 接受(D46 吃饭休息允许)', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: otherMemberId,
          checkInAt: '2099-06-01T14:00:00.000Z',
          checkOutAt: '2099-06-01T17:00:00.000Z',
          serviceHours: 2.5,
        }),
      ]);
      const records = await prisma.attendanceRecord.findMany({ where: { sheetId: id } });
      expect(records[0].serviceHours.toString()).toBe('2.5');
    });

    it('提交带 registrationId(R23 正向:同活动)→ 201', async () => {
      // memberA 在 activityId 已有 registration registrationAId(R23 正向)
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberAId,
              checkInAt: '2099-06-01T15:00:00.000Z',
              checkOutAt: '2099-06-01T17:30:00.000Z',
              registrationId: registrationAId,
            }),
          ],
        });
      expect(res.status).toBe(201);
    });
  });

  // ============ POST submit 关键失败 ============

  describe('POST submit 关键失败', () => {
    it('activity 不存在 → ACTIVITY_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/activities/cl0000000000000000000000/attendance-sheets')
        .set('Authorization', adminAuth)
        .send({ records: [baseRecord({ memberId: memberCId })] });
      expectBizError(res, BizCode.ACTIVITY_NOT_FOUND);
    });

    it('activity cancelled → ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN(20122)', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityCancelledId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({ records: [baseRecord({ memberId: memberCId })] });
      expectBizError(res, BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN);
    });

    it('member 不存在 → MEMBER_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [baseRecord({ memberId: 'cl0000000000000000000000' })],
        });
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('roleCode 不存在 → ATTENDANCE_ROLE_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [baseRecord({ memberId: memberCId, roleCode: 'no-such-role' })],
        });
      expectBizError(res, BizCode.ATTENDANCE_ROLE_CODE_INVALID);
    });

    it('attendanceStatusCode 不存在 → ATTENDANCE_STATUS_CODE_INVALID(absent/leave 自动失败)', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [baseRecord({ memberId: memberCId, attendanceStatusCode: 'absent' })],
        });
      expectBizError(res, BizCode.ATTENDANCE_STATUS_CODE_INVALID);
    });

    it('checkOutAt <= checkInAt → CHECK_OUT_BEFORE_CHECK_IN', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberCId,
              checkInAt: '2099-06-01T10:00:00.000Z',
              checkOutAt: '2099-06-01T10:00:00.000Z',
            }),
          ],
        });
      expectBizError(res, BizCode.CHECK_OUT_BEFORE_CHECK_IN);
    });

    it('serviceHours <= 0 → ATTENDANCE_SERVICE_HOURS_INVALID', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberCId,
              checkInAt: '2099-06-01T12:00:00.000Z',
              checkOutAt: '2099-06-01T13:00:00.000Z',
              serviceHours: 0,
            }),
          ],
        });
      // DTO 层 @Min(0.01) 直接 400
      expect(res.status).toBe(400);
    });

    it('serviceHours > 跨度 → ATTENDANCE_SERVICE_HOURS_EXCEEDS_SPAN', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberCId,
              checkInAt: '2099-06-01T13:00:00.000Z',
              checkOutAt: '2099-06-01T14:00:00.000Z',
              serviceHours: 5,
            }),
          ],
        });
      expectBizError(res, BizCode.ATTENDANCE_SERVICE_HOURS_EXCEEDS_SPAN);
    });

    it('R23 跨表:registrationId 不属于本活动 → ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH', async () => {
      // memberA 在 activityOtherId 有 reg,但 sheet 父活动是 activityId
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberAId,
              checkInAt: '2099-06-01T16:00:00.000Z',
              checkOutAt: '2099-06-01T17:00:00.000Z',
              registrationId: registrationOtherActivityId,
            }),
          ],
        });
      expectBizError(res, BizCode.ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH);
    });

    it('R23 跨表:registrationId 不存在 → MISMATCH', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberAId,
              checkInAt: '2099-06-03T10:00:00.000Z',
              checkOutAt: '2099-06-03T12:00:00.000Z',
              registrationId: 'cl0000000000000000000000',
            }),
          ],
        });
      expectBizError(res, BizCode.ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH);
    });

    it('空 records 数组 → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({ records: [] });
      expect(res.status).toBe(400);
    });

    it('non-whitelisted statusCode → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          statusCode: 'approved',
          records: [baseRecord({ memberId: memberCId })],
        });
      expect(res.status).toBe(400);
    });

    it('non-whitelisted version → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          version: 99,
          records: [baseRecord({ memberId: memberCId })],
        });
      expect(res.status).toBe(400);
    });

    it('non-whitelisted previousSnapshot → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          previousSnapshot: { fake: true },
          records: [baseRecord({ memberId: memberCId })],
        });
      expect(res.status).toBe(400);
    });

    it('non-whitelisted submitterUserId → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          submitterUserId: 'cl0000000000000000000000',
          records: [baseRecord({ memberId: memberCId })],
        });
      expect(res.status).toBe(400);
    });
  });

  // ============ 时间不重叠(R16 / Q-S15) ============

  describe('时间不重叠校验', () => {
    let overlapMember: string;

    beforeAll(async () => {
      // 单独 member 隔离本段干扰
      const m = await prisma.member.create({
        data: { memberNo: 'att-m-overlap', displayName: 'Overlap M' },
        select: { id: true },
      });
      overlapMember = m.id;
      // 先入第一段:08:00 - 10:00
      await createPendingSheet(activityId, [
        baseRecord({
          memberId: overlapMember,
          checkInAt: '2099-06-05T08:00:00.000Z',
          checkOutAt: '2099-06-05T10:00:00.000Z',
        }),
      ]);
    });

    it('完全重叠 → 22060', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: overlapMember,
              checkInAt: '2099-06-05T08:00:00.000Z',
              checkOutAt: '2099-06-05T10:00:00.000Z',
            }),
          ],
        });
      expectBizError(res, BizCode.ATTENDANCE_TIME_OVERLAP);
    });

    it('部分重叠 → 22060', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: overlapMember,
              checkInAt: '2099-06-05T09:00:00.000Z',
              checkOutAt: '2099-06-05T11:00:00.000Z',
            }),
          ],
        });
      expectBizError(res, BizCode.ATTENDANCE_TIME_OVERLAP);
    });

    it('Q-S15 左闭右开:紧邻 endAt = startAt 允许', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: overlapMember,
              checkInAt: '2099-06-05T10:00:00.000Z',
              checkOutAt: '2099-06-05T12:00:00.000Z',
            }),
          ],
        });
      expect(res.status).toBe(201);
    });

    it('跨 Sheet 跨 Activity 全局校验:不同 activity 但同 memberId 时间重叠 → 22060', async () => {
      // 在 activityOtherId 给 overlapMember 提交同时段 → 应被拒
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityOtherId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: overlapMember,
              checkInAt: '2099-06-05T09:30:00.000Z',
              checkOutAt: '2099-06-05T10:30:00.000Z',
            }),
          ],
        });
      expectBizError(res, BizCode.ATTENDANCE_TIME_OVERLAP);
    });

    it('数组内部重叠(同 batch 内同 memberId)→ 22060', async () => {
      const otherM = (
        await prisma.member.create({
          data: { memberNo: 'att-m-internal', displayName: 'Internal' },
          select: { id: true },
        })
      ).id;
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: otherM,
              checkInAt: '2099-06-06T08:00:00.000Z',
              checkOutAt: '2099-06-06T10:00:00.000Z',
            }),
            baseRecord({
              memberId: otherM,
              checkInAt: '2099-06-06T09:00:00.000Z',
              checkOutAt: '2099-06-06T11:00:00.000Z',
            }),
          ],
        });
      expectBizError(res, BizCode.ATTENDANCE_TIME_OVERLAP);
    });
  });

  // ============ GET list / detail ============

  describe('GET list / detail', () => {
    let createdId: string;

    beforeAll(async () => {
      createdId = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-10T08:00:00.000Z',
          checkOutAt: '2099-06-10T10:00:00.000Z',
        }),
      ]);
    });

    it('GET list:activity 不存在 → ACTIVITY_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/activities/cl0000000000000000000000/attendance-sheets')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ACTIVITY_NOT_FOUND);
    });

    it('GET list 主路径:分页返回 + statusCode=pending 过滤', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .query({ statusCode: 'pending' })
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      const statuses = (res.body.data.items as Array<{ statusCode: string }>).map(
        (i) => i.statusCode,
      );
      for (const s of statuses) expect(s).toBe('pending');
    });

    it('GET detail:不存在 → ATTENDANCE_SHEET_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attendance-sheets/cl0000000000000000000000')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ATTENDANCE_SHEET_NOT_FOUND);
    });

    it('GET detail:不返 records 数组(Sheet 简化)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/attendance-sheets/${createdId}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(createdId);
      expect(res.body.data).not.toHaveProperty('records');
      expect(res.body.data).not.toHaveProperty('previousSnapshot');
      expect(res.body.data).not.toHaveProperty('deletedAt');
    });

    it('GET review-detail:Activity 摘要 + Sheet + Records 完整(R25)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/attendance-sheets/${createdId}/review-detail`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.activity).toBeDefined();
      expect(res.body.data.activity.id).toBe(activityId);
      expect(res.body.data.activity.title).toBe('ATT-MAIN');
      expect(res.body.data.sheet).toBeDefined();
      expect(res.body.data.sheet.id).toBe(createdId);
      expect(Array.isArray(res.body.data.records)).toBe(true);
      expect(res.body.data.records.length).toBe(1);
      // record 嵌套含 member 摘要
      expect(res.body.data.records[0].member).toBeDefined();
      expect(res.body.data.records[0].member.memberNo).toBeTruthy();
      expect(res.body.data.records[0].member.displayName).toBeTruthy();
      // Decimal 序列化为 string
      expect(typeof res.body.data.records[0].serviceHours).toBe('string');
    });

    it('GET review-detail:不存在 → ATTENDANCE_SHEET_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attendance-sheets/cl0000000000000000000000/review-detail')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ATTENDANCE_SHEET_NOT_FOUND);
    });
  });

  // ============ PATCH edit ============

  describe('PATCH edit', () => {
    let pendingId: string;
    let approvedId: string;
    let rejectedId: string;

    beforeAll(async () => {
      pendingId = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-15T08:00:00.000Z',
          checkOutAt: '2099-06-15T10:00:00.000Z',
        }),
      ]);

      // approved Sheet(批次 4-B 升级:approve + finalApprove 才到 approved 终态):
      // create → fillContributionPoints → approveToTerminalApproved。
      approvedId = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-15T11:00:00.000Z',
          checkOutAt: '2099-06-15T12:00:00.000Z',
        }),
      ]);
      await fillContributionPoints(approvedId);
      await approveToTerminalApproved(approvedId);

      // rejected Sheet(APD 一级驳回)
      rejectedId = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-15T13:00:00.000Z',
          checkOutAt: '2099-06-15T14:00:00.000Z',
        }),
      ]);
      await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${rejectedId}/reject`)
        .set('Authorization', adminAuth)
        .send({ reviewNote: 'fixture reject' });
    });

    it('edit pending Sheet(替换 records)→ 200,version+1,previousSnapshot 后端写入', async () => {
      const before = await prisma.attendanceSheet.findUnique({ where: { id: pendingId } });
      expect(before?.version).toBe(1);
      expect(before?.previousSnapshot).toBeNull();

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${pendingId}`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberCId,
              checkInAt: '2099-06-15T08:30:00.000Z',
              checkOutAt: '2099-06-15T09:30:00.000Z',
            }),
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.data.version).toBe(2);

      const after = await prisma.attendanceSheet.findUnique({ where: { id: pendingId } });
      expect(after?.version).toBe(2);
      expect(after?.previousSnapshot).not.toBeNull();
      // snapshot 含 sheet + records 字段(Q-S16)
      const snap = after?.previousSnapshot as { sheet: unknown; records: unknown[] } | null;
      expect(snap?.sheet).toBeDefined();
      expect(Array.isArray(snap?.records)).toBe(true);
      expect(snap?.records.length).toBe(1);

      // 旧 records 软删,新 records 活跃 = 1
      const activeRecords = await prisma.attendanceRecord.findMany({
        where: { sheetId: pendingId, deletedAt: null },
      });
      expect(activeRecords.length).toBe(1);
      expect(activeRecords[0].checkInAt.toISOString()).toBe('2099-06-15T08:30:00.000Z');
      const allRecords = await prisma.attendanceRecord.findMany({
        where: { sheetId: pendingId },
      });
      expect(allRecords.length).toBe(2); // 1 旧软删 + 1 新
    });

    it('edit approved Sheet → 22040 ATTENDANCE_SHEET_APPROVED_NOT_EDITABLE', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${approvedId}`)
        .set('Authorization', adminAuth)
        .send({ records: [baseRecord({ memberId: memberCId })] });
      expectBizError(res, BizCode.ATTENDANCE_SHEET_APPROVED_NOT_EDITABLE);
    });

    it('edit rejected Sheet → 22041 ATTENDANCE_SHEET_REJECTED_NOT_EDITABLE', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${rejectedId}`)
        .set('Authorization', adminAuth)
        .send({ records: [baseRecord({ memberId: memberCId })] });
      expectBizError(res, BizCode.ATTENDANCE_SHEET_REJECTED_NOT_EDITABLE);
    });

    it('edit Sheet 不存在 → 22001', async () => {
      const res = await request(httpServer(app))
        .patch('/api/admin/v1/attendance-sheets/cl0000000000000000000000')
        .set('Authorization', adminAuth)
        .send({});
      expectBizError(res, BizCode.ATTENDANCE_SHEET_NOT_FOUND);
    });

    it('edit:non-whitelisted statusCode → 400', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-16T08:00:00.000Z',
          checkOutAt: '2099-06-16T09:00:00.000Z',
        }),
      ]);
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}`)
        .set('Authorization', adminAuth)
        .send({ statusCode: 'approved' });
      expect(res.status).toBe(400);
    });

    it('edit:non-whitelisted version → 400', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-16T10:00:00.000Z',
          checkOutAt: '2099-06-16T11:00:00.000Z',
        }),
      ]);
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}`)
        .set('Authorization', adminAuth)
        .send({ version: 99 });
      expect(res.status).toBe(400);
    });

    it('edit:non-whitelisted previousSnapshot → 400', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-16T12:00:00.000Z',
          checkOutAt: '2099-06-16T13:00:00.000Z',
        }),
      ]);
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}`)
        .set('Authorization', adminAuth)
        .send({ previousSnapshot: { fake: true } });
      expect(res.status).toBe(400);
    });

    it('edit:non-whitelisted reviewNote(应走 approve / reject)→ 400', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-16T14:00:00.000Z',
          checkOutAt: '2099-06-16T15:00:00.000Z',
        }),
      ]);
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}`)
        .set('Authorization', adminAuth)
        .send({ reviewNote: 'should be rejected' });
      expect(res.status).toBe(400);
    });
  });

  // ============ DELETE softDelete ============

  describe('DELETE softDelete', () => {
    it('软删 pending Sheet → 200 + DB.deletedAt 非空 + records 级联软删', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-20T08:00:00.000Z',
          checkOutAt: '2099-06-20T10:00:00.000Z',
        }),
      ]);
      const del = await request(httpServer(app))
        .delete(`/api/admin/v1/attendance-sheets/${id}`)
        .set('Authorization', adminAuth);
      expect(del.status).toBe(200);

      const sheet = await prisma.attendanceSheet.findUnique({ where: { id } });
      expect(sheet?.deletedAt).not.toBeNull();
      const records = await prisma.attendanceRecord.findMany({ where: { sheetId: id } });
      expect(records.every((r) => r.deletedAt !== null)).toBe(true);

      // 软删后 detail 不可见
      const detail = await request(httpServer(app))
        .get(`/api/admin/v1/attendance-sheets/${id}`)
        .set('Authorization', adminAuth);
      expectBizError(detail, BizCode.ATTENDANCE_SHEET_NOT_FOUND);
    });

    it('软删 approved(终审通过)Sheet → 22040(批次 4-B:approveToTerminalApproved 推到 approved 终态)', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-20T11:00:00.000Z',
          checkOutAt: '2099-06-20T12:00:00.000Z',
        }),
      ]);
      await fillContributionPoints(id);
      await approveToTerminalApproved(id);

      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/attendance-sheets/${id}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ATTENDANCE_SHEET_APPROVED_NOT_EDITABLE);
    });

    it('软删 rejected Sheet → 22041', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-20T13:00:00.000Z',
          checkOutAt: '2099-06-20T14:00:00.000Z',
        }),
      ]);
      await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}/reject`)
        .set('Authorization', adminAuth)
        .send({ reviewNote: 'cleanup' });

      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/attendance-sheets/${id}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ATTENDANCE_SHEET_REJECTED_NOT_EDITABLE);
    });

    it('软删不存在 Sheet → 22001', async () => {
      const res = await request(httpServer(app))
        .delete('/api/admin/v1/attendance-sheets/cl0000000000000000000000')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ATTENDANCE_SHEET_NOT_FOUND);
    });
  });

  // ============ PATCH approve ============

  describe('PATCH approve', () => {
    it('approve pending Sheet 但 contributionPoints 未填 → 22072', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-25T08:00:00.000Z',
          checkOutAt: '2099-06-25T10:00:00.000Z',
        }),
      ]);
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}/approve`)
        .set('Authorization', adminAuth)
        .send({});
      expectBizError(res, BizCode.ATTENDANCE_RECORD_CONTRIBUTION_POINTS_REQUIRED);
    });

    it('approve pending Sheet:全部 records contribution 填后 → 200 + statusCode=pending_final_review(批次 4-B 升级,沿 D-S6)', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-25T11:00:00.000Z',
          checkOutAt: '2099-06-25T13:00:00.000Z',
        }),
      ]);
      await fillContributionPoints(id, 2);

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}/approve`)
        .set('Authorization', adminAuth)
        .send({ reviewNote: 'looks good' });
      expect(res.status).toBe(200);
      // 批次 4-B(D-S6 + D-A1):APD 一级 approve 进 pending_final_review,不再终态
      expect(res.body.data.statusCode).toBe('pending_final_review');
      expect(res.body.data.reviewerUserId).toBeTruthy();
      expect(res.body.data.reviewedAt).toBeTruthy();
      expect(res.body.data.reviewNote).toBe('looks good');
      // 终审字段尚未填(只有 final-approve / final-reject 后才填)
      expect(res.body.data.finalReviewerUserId).toBeNull();
      expect(res.body.data.finalReviewedAt).toBeNull();
      expect(res.body.data.finalReviewNote).toBeNull();
    });

    it('approve 再次 → 22030(已 pending_final_review 非 pending,批次 4-B 升级语义)', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-25T14:00:00.000Z',
          checkOutAt: '2099-06-25T15:00:00.000Z',
        }),
      ]);
      await fillContributionPoints(id);
      await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}/approve`)
        .set('Authorization', adminAuth)
        .send({});
      const res2 = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}/approve`)
        .set('Authorization', adminAuth)
        .send({});
      expectBizError(res2, BizCode.ATTENDANCE_SHEET_STATUS_INVALID);
    });

    it('approve rejected Sheet → 22030', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-25T16:00:00.000Z',
          checkOutAt: '2099-06-25T17:00:00.000Z',
        }),
      ]);
      await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}/reject`)
        .set('Authorization', adminAuth)
        .send({ reviewNote: 'reject me' });
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}/approve`)
        .set('Authorization', adminAuth)
        .send({});
      expectBizError(res, BizCode.ATTENDANCE_SHEET_STATUS_INVALID);
    });

    it('approve 不存在 → 22001', async () => {
      const res = await request(httpServer(app))
        .patch('/api/admin/v1/attendance-sheets/cl0000000000000000000000/approve')
        .set('Authorization', adminAuth)
        .send({});
      expectBizError(res, BizCode.ATTENDANCE_SHEET_NOT_FOUND);
    });
  });

  // ============ PATCH reject ============

  describe('PATCH reject', () => {
    it('reject pending Sheet → 200,statusCode=rejected,reviewNote 入库', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-26T08:00:00.000Z',
          checkOutAt: '2099-06-26T09:00:00.000Z',
        }),
      ]);
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}/reject`)
        .set('Authorization', adminAuth)
        .send({ reviewNote: '数据有误' });
      expect(res.status).toBe(200);
      expect(res.body.data.statusCode).toBe('rejected');
      expect(res.body.data.reviewNote).toBe('数据有误');
    });

    it('reject 缺 reviewNote → 400', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-26T10:00:00.000Z',
          checkOutAt: '2099-06-26T11:00:00.000Z',
        }),
      ]);
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}/reject`)
        .set('Authorization', adminAuth)
        .send({});
      expect(res.status).toBe(400);
    });

    it('reject pending_final_review Sheet → 22030(批次 4-B:APD 一级 approve 后不能再 APD reject)', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-26T12:00:00.000Z',
          checkOutAt: '2099-06-26T13:00:00.000Z',
        }),
      ]);
      await fillContributionPoints(id);
      await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}/approve`)
        .set('Authorization', adminAuth)
        .send({});
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}/reject`)
        .set('Authorization', adminAuth)
        .send({ reviewNote: '试图驳回已 pending_final_review' });
      expectBizError(res, BizCode.ATTENDANCE_SHEET_STATUS_INVALID);
    });

    it('reject 不存在 → 22001', async () => {
      const res = await request(httpServer(app))
        .patch('/api/admin/v1/attendance-sheets/cl0000000000000000000000/reject')
        .set('Authorization', adminAuth)
        .send({ reviewNote: 'x' });
      expectBizError(res, BizCode.ATTENDANCE_SHEET_NOT_FOUND);
    });
  });

  // ============ approved-only 事件 / 副作用 ============

  describe('Q-S13 approved-only:eventPlaceholder 仅终审 approve 触发(批次 4-B 移到 final-approve)', () => {
    // 批次 4-B(沿 D-S7):attendance.recorded 触发位置从 APD approve 移到 final-approve。
    // 副作用层面验证:eventPlaceholder 走 logger,e2e 无法直接断言 logger;
    // 通过"approve / reject / final-reject 路径 statusCode 正确转移 + 不引起后续业务变化"间接覆盖。
    it('reject 后 sheet 仍为 rejected;不触发 approved', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-28T08:00:00.000Z',
          checkOutAt: '2099-06-28T09:00:00.000Z',
        }),
      ]);
      await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}/reject`)
        .set('Authorization', adminAuth)
        .send({ reviewNote: 'no event' });
      const sheet = await prisma.attendanceSheet.findUnique({ where: { id } });
      expect(sheet?.statusCode).toBe('rejected');
    });

    it('批次 4-B:APD approve 仅推到 pending_final_review,不触发 attendance.recorded(终态由 final-approve 触发)', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-28T10:00:00.000Z',
          checkOutAt: '2099-06-28T11:00:00.000Z',
        }),
      ]);
      await fillContributionPoints(id, 1);
      await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}/approve`)
        .set('Authorization', adminAuth)
        .send({});
      const sheet = await prisma.attendanceSheet.findUnique({ where: { id } });
      // 沿 D-S6 / D-A1:APD approve → pending_final_review,不到 approved 终态
      expect(sheet?.statusCode).toBe('pending_final_review');
      // /me/attendance-records 仅返 approved Sheet 内 records → 此 sheet 不可见
      // (间接验证 attendance.recorded 未触发完整入账;D-S7)
    });
  });

  // ============ 批次 4-B 新增:终审 final-approve / final-reject ============
  // 详见 docs:
  //   - 批次4_贡献值业务规则_API草案.md v1.0 D-A2 / D-A5
  //   - 批次4_贡献值业务规则_schema草案评审决议表.md v1.0 D-S5 / D-S7

  describe('PATCH final-approve / final-reject(批次 4-B 终审)', () => {
    let pendingFinalReviewId: string;
    let alreadyApprovedId: string;
    let alreadyFinalRejectedId: string;

    beforeAll(async () => {
      pendingFinalReviewId = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-29T08:00:00.000Z',
          checkOutAt: '2099-06-29T09:00:00.000Z',
        }),
      ]);
      await fillContributionPoints(pendingFinalReviewId, 1);
      await approveToPendingFinalReview(pendingFinalReviewId);

      alreadyApprovedId = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-29T09:30:00.000Z',
          checkOutAt: '2099-06-29T10:30:00.000Z',
        }),
      ]);
      await fillContributionPoints(alreadyApprovedId, 1);
      await approveToTerminalApproved(alreadyApprovedId);

      alreadyFinalRejectedId = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-29T11:00:00.000Z',
          checkOutAt: '2099-06-29T12:00:00.000Z',
        }),
      ]);
      await fillContributionPoints(alreadyFinalRejectedId, 1);
      await approveThenFinalReject(alreadyFinalRejectedId, 'fixture final reject');
    });

    it('final-approve pending_final_review Sheet → 200 + statusCode=approved + 写 finalReviewer*', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-29T13:00:00.000Z',
          checkOutAt: '2099-06-29T14:00:00.000Z',
        }),
      ]);
      await fillContributionPoints(id, 1.5);
      await approveToPendingFinalReview(id);

      // PR9:终审用第二管理员(submit/一级审是 adminAuth,自审/同人约束下不可自终审)
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}/final-approve`)
        .set('Authorization', finalAdminAuth)
        .send({ finalReviewNote: 'final ok' });
      expect(res.status).toBe(200);
      // 沿 D-S6:approved = 终审通过(贡献值正式生效)
      expect(res.body.data.statusCode).toBe('approved');
      expect(res.body.data.finalReviewerUserId).toBeTruthy();
      expect(res.body.data.finalReviewedAt).toBeTruthy();
      expect(res.body.data.finalReviewNote).toBe('final ok');
      // APD 一级 reviewer* 字段仍保留(从 approve 阶段写入)
      expect(res.body.data.reviewerUserId).toBeTruthy();
      expect(res.body.data.reviewedAt).toBeTruthy();
    });

    it('final-approve 后 sheet 在 /me/attendance-records 可见(终审通过即贡献值生效)', async () => {
      // 已在 beforeAll(/me describe)用 approveToTerminalApproved 验证;此处冗余确保 final-approve 入账
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${pendingFinalReviewId}/final-approve`)
        .set('Authorization', finalAdminAuth)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.data.statusCode).toBe('approved');
      // 注:不再断言 /me 可见(已由 /me describe 段覆盖)
    });

    it('final-approve 不传 finalReviewNote → 200(可选)', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-29T14:00:00.000Z',
          checkOutAt: '2099-06-29T15:00:00.000Z',
        }),
      ]);
      await fillContributionPoints(id, 1);
      await approveToPendingFinalReview(id);

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}/final-approve`)
        .set('Authorization', finalAdminAuth)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.data.finalReviewNote).toBeNull();
    });

    it('final-approve 状态非 pending_final_review → 22045', async () => {
      // 直接对 alreadyApprovedId(approved)再 final-approve
      // PR9:用 finalAdminAuth —— authz 约束先于状态机,adminAuth(=submitter)会先吃 22074,
      // 本用例要锁的是状态门 22045(约束矩阵另见 attendances-final-review-authz e2e)
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${alreadyApprovedId}/final-approve`)
        .set('Authorization', finalAdminAuth)
        .send({});
      expectBizError(res, BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID);
    });

    it('final-approve pending Sheet(未 approve 过)→ 22045', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-29T15:30:00.000Z',
          checkOutAt: '2099-06-29T16:00:00.000Z',
        }),
      ]);
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}/final-approve`)
        .set('Authorization', finalAdminAuth)
        .send({});
      expectBizError(res, BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID);
    });

    it('final-approve 状态为 final_rejected → 22045(状态机回归矩阵闭合;v0.6 契约小修复)', async () => {
      // alreadyFinalRejectedId 已 final_rejected(terminal 终态);再次调用 final-approve
      // 不应"复活"成 approved;统一抛 22045 ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID。
      // 补齐 final-approve 非法源态矩阵:approved / pending / final_rejected;
      // 与 final-reject 段的同向用例(`final-reject 状态非 pending_final_review → 22045`)对称,
      // 防止"终审驳回 → 改主意 → 终审通过"的悄默路径(沿 D-S5 / D-S6 终态不可逆)。
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${alreadyFinalRejectedId}/final-approve`)
        .set('Authorization', finalAdminAuth)
        .send({});
      expectBizError(res, BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID);
    });

    it('final-approve 不存在 → 22001(持权者;无码者是 30100 防枚举,见 rbac-boundary)', async () => {
      // 摘码微刀:adminAuth(biz-admin)已无终审码 → 会吃 30100;22001「先判码后查单」
      // 行为锁由持权的 finalAdminAuth(SA)承载。
      const res = await request(httpServer(app))
        .patch('/api/admin/v1/attendance-sheets/cl0000000000000000000000/final-approve')
        .set('Authorization', finalAdminAuth)
        .send({});
      expectBizError(res, BizCode.ATTENDANCE_SHEET_NOT_FOUND);
    });

    it('final-reject pending_final_review Sheet → 200 + statusCode=final_rejected + records 跟随软删', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-29T16:30:00.000Z',
          checkOutAt: '2099-06-29T17:30:00.000Z',
        }),
      ]);
      await fillContributionPoints(id, 1);
      await approveToPendingFinalReview(id);

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}/final-reject`)
        .set('Authorization', finalAdminAuth)
        .send({ finalReviewNote: '终审驳回理由' });
      expect(res.status).toBe(200);
      expect(res.body.data.statusCode).toBe('final_rejected');
      expect(res.body.data.finalReviewerUserId).toBeTruthy();
      expect(res.body.data.finalReviewedAt).toBeTruthy();
      expect(res.body.data.finalReviewNote).toBe('终审驳回理由');
      // records 跟随软删(沿 D8 主路径 + 业务规则文档 §2.3)
      const records = await prisma.attendanceRecord.findMany({ where: { sheetId: id } });
      expect(records.length).toBeGreaterThan(0);
      expect(records.every((r) => r.deletedAt !== null)).toBe(true);
    });

    it('final-reject 缺 finalReviewNote → 400(DTO 必填校验)', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-29T18:00:00.000Z',
          checkOutAt: '2099-06-29T18:30:00.000Z',
        }),
      ]);
      await fillContributionPoints(id, 1);
      await approveToPendingFinalReview(id);
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}/final-reject`)
        .set('Authorization', finalAdminAuth)
        .send({});
      expect(res.status).toBe(400);
    });

    it('final-reject 空白 finalReviewNote → 400(DTO @MinLength(1))', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-29T19:00:00.000Z',
          checkOutAt: '2099-06-29T19:30:00.000Z',
        }),
      ]);
      await fillContributionPoints(id, 1);
      await approveToPendingFinalReview(id);
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}/final-reject`)
        .set('Authorization', finalAdminAuth)
        .send({ finalReviewNote: '' });
      expect(res.status).toBe(400);
    });

    it('final-reject 状态非 pending_final_review → 22045', async () => {
      // alreadyFinalRejectedId 已 final_rejected,再 final-reject 抛 22045
      // (摘码微刀:须持权身份才到状态门;adminAuth 会先吃 30100)
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${alreadyFinalRejectedId}/final-reject`)
        .set('Authorization', finalAdminAuth)
        .send({ finalReviewNote: 'noop' });
      expectBizError(res, BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID);
    });

    it('final_rejected Sheet 不可 edit → 22043', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${alreadyFinalRejectedId}`)
        .set('Authorization', adminAuth)
        .send({ records: [baseRecord({ memberId: memberCId })] });
      expectBizError(res, BizCode.ATTENDANCE_SHEET_FINAL_REJECTED_NOT_EDITABLE);
    });

    it('final_rejected Sheet 不可 delete → 22043', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/attendance-sheets/${alreadyFinalRejectedId}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ATTENDANCE_SHEET_FINAL_REJECTED_NOT_EDITABLE);
    });

    it('pending_final_review Sheet 不可 edit → 22030(沿 §2.1 业务规则)', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-29T20:00:00.000Z',
          checkOutAt: '2099-06-29T20:30:00.000Z',
        }),
      ]);
      await fillContributionPoints(id, 1);
      await approveToPendingFinalReview(id);
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${id}`)
        .set('Authorization', adminAuth)
        .send({ records: [baseRecord({ memberId: memberCId })] });
      expectBizError(res, BizCode.ATTENDANCE_SHEET_STATUS_INVALID);
    });

    it('pending_final_review Sheet 不可 delete → 22030', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-06-29T21:00:00.000Z',
          checkOutAt: '2099-06-29T21:30:00.000Z',
        }),
      ]);
      await fillContributionPoints(id, 1);
      await approveToPendingFinalReview(id);
      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/attendance-sheets/${id}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ATTENDANCE_SHEET_STATUS_INVALID);
    });
  });

  // ============ 批次 4-B 新增:D14 ContributionRule 预填 ============
  // 沿 D-S4 / D-A8 / 业务规则文档 §4

  describe('D14 ContributionRule 预填(批次 4-B)', () => {
    it('ContributionRule 命中(同 activityType × roleCode):POST 时自动预填 contributionPoints', async () => {
      // 直接造一条 ACTIVE 规则:activityType=att-demo / role=member / >=6h 1.5 / <6h 0.5
      const rule = await prisma.contributionRule.create({
        data: {
          activityTypeCode: 'att-demo',
          attendanceRoleCode: 'member',
          durationThreshold: 6,
          pointsBelow: 0.5,
          pointsAbove: 1.5,
          dailyCap: null,
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      try {
        const id = await createPendingSheet(activityId, [
          baseRecord({
            memberId: memberCId,
            roleCode: 'member',
            checkInAt: '2026-07-02T08:00:00.000Z',
            checkOutAt: '2026-07-02T09:00:00.000Z', // 1h < 6h → 取 pointsBelow=0.5
            // 不传 contributionPoints → 期望被预填
          }),
        ]);
        const records = await prisma.attendanceRecord.findMany({
          where: { sheetId: id, deletedAt: null },
          select: { contributionPoints: true },
        });
        expect(records.length).toBe(1);
        expect(records[0].contributionPoints?.toString()).toBe('0.5');
      } finally {
        await prisma.contributionRule.delete({ where: { id: rule.id } });
      }
    });

    it('ContributionRule 命中:>=6h 取 pointsAbove(活动闭环硬化 2026-06-21:不再 per-record dailyCap 钳制 → 原始规则分)', async () => {
      const rule = await prisma.contributionRule.create({
        data: {
          activityTypeCode: 'att-demo',
          attendanceRoleCode: 'instructor',
          durationThreshold: 6,
          pointsBelow: 1,
          pointsAbove: 3,
          dailyCap: 1.5, // 列保留但 calculator 不再读;不再每条封顶
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      try {
        const id = await createPendingSheet(activityId, [
          baseRecord({
            memberId: memberCId,
            roleCode: 'instructor',
            checkInAt: '2026-07-02T10:00:00.000Z',
            checkOutAt: '2026-07-02T18:00:00.000Z', // 8h >= 6h → pointsAbove=3;dailyCap 不再每条封顶
          }),
        ]);
        const records = await prisma.attendanceRecord.findMany({
          where: { sheetId: id, deletedAt: null },
          select: { contributionPoints: true },
        });
        // 旧:MIN(3, dailyCap 1.5)=1.5;新:不每条封顶 → 原始规则分 3(全局每日封顶改落 team-join 汇总处)
        expect(records[0].contributionPoints?.toString()).toBe('3');
      } finally {
        await prisma.contributionRule.delete({ where: { id: rule.id } });
      }
    });

    it('ContributionRule 未命中:contributionPoints 保持 null(不抛错;沿 D-S11 22048 不开)', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          roleCode: 'coach', // 未配置规则
          checkInAt: '2026-07-02T20:00:00.000Z',
          checkOutAt: '2026-07-02T21:00:00.000Z',
        }),
      ]);
      const records = await prisma.attendanceRecord.findMany({
        where: { sheetId: id, deletedAt: null },
        select: { contributionPoints: true },
      });
      expect(records[0].contributionPoints).toBeNull();
    });

    it('调用方传 contributionPoints 时不覆盖(沿 D-A8)', async () => {
      const rule = await prisma.contributionRule.create({
        data: {
          activityTypeCode: 'att-demo',
          attendanceRoleCode: 'assistant',
          durationThreshold: null,
          pointsBelow: 99, // 异常大值,如果被预填会覆盖调用方传的 0.8
          pointsAbove: null,
          dailyCap: null,
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      try {
        const id = await createPendingSheet(activityId, [
          baseRecord({
            memberId: memberCId,
            roleCode: 'assistant',
            checkInAt: '2026-07-03T08:00:00.000Z',
            checkOutAt: '2026-07-03T09:00:00.000Z',
            contributionPoints: 0.8, // 调用方明确传值
          }),
        ]);
        const records = await prisma.attendanceRecord.findMany({
          where: { sheetId: id, deletedAt: null },
          select: { contributionPoints: true },
        });
        expect(records[0].contributionPoints?.toString()).toBe('0.8');
      } finally {
        await prisma.contributionRule.delete({ where: { id: rule.id } });
      }
    });

    it('调用方显式传 contributionPoints: null 时跳过预填(P2-1 三态语义;沿 PR #22)', async () => {
      // 命中规则,但调用方显式传 null → service 跳过预填,落库 null。
      // 与 "调用方传 contributionPoints 时不覆盖"(number 路径)成对覆盖三态语义。
      const rule = await prisma.contributionRule.create({
        data: {
          activityTypeCode: 'att-demo',
          attendanceRoleCode: 'back_command',
          durationThreshold: null,
          pointsBelow: 1.0, // 若被预填会覆盖 null
          pointsAbove: null,
          dailyCap: null,
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      try {
        const id = await createPendingSheet(activityId, [
          baseRecord({
            memberId: memberCId,
            roleCode: 'back_command',
            checkInAt: '2026-07-03T10:00:00.000Z',
            checkOutAt: '2026-07-03T11:00:00.000Z',
            contributionPoints: null, // 显式 null:强制清空 / 不预填
          }),
        ]);
        const records = await prisma.attendanceRecord.findMany({
          where: { sheetId: id, deletedAt: null },
          select: { contributionPoints: true },
        });
        expect(records[0].contributionPoints).toBeNull();
      } finally {
        await prisma.contributionRule.delete({ where: { id: rule.id } });
      }
    });

    it('NULL durationThreshold 多条 ACTIVE 规则 → 按 createdAt ASC 取首条', async () => {
      // 沿 §3.1 复核结论:NULL durationThreshold 在 partial unique 下不阻止多行 ACTIVE 并存(PG NULL 行为)。
      // service 兜底:按 createdAt ASC 取首条。
      const rule1 = await prisma.contributionRule.create({
        data: {
          activityTypeCode: 'att-demo',
          attendanceRoleCode: 'front_command',
          durationThreshold: null,
          pointsBelow: 1.0, // 首条
          pointsAbove: null,
          dailyCap: null,
          status: 'ACTIVE',
          createdAt: new Date('2026-01-01T00:00:00Z'), // 显式更早
        },
        select: { id: true },
      });
      const rule2 = await prisma.contributionRule.create({
        data: {
          activityTypeCode: 'att-demo',
          attendanceRoleCode: 'front_command',
          durationThreshold: null,
          pointsBelow: 0.3, // 次条(若被选中将失败)
          pointsAbove: null,
          dailyCap: null,
          status: 'ACTIVE',
          createdAt: new Date('2026-02-01T00:00:00Z'),
        },
        select: { id: true },
      });
      try {
        const id = await createPendingSheet(activityId, [
          baseRecord({
            memberId: memberCId,
            roleCode: 'front_command',
            checkInAt: '2026-07-04T08:00:00.000Z',
            checkOutAt: '2026-07-04T09:00:00.000Z',
          }),
        ]);
        const records = await prisma.attendanceRecord.findMany({
          where: { sheetId: id, deletedAt: null },
          select: { contributionPoints: true },
        });
        // 取首条(rule1,createdAt 更早,pointsBelow=1.0)
        expect(records[0].contributionPoints?.toString()).toBe('1');
      } finally {
        await prisma.contributionRule.delete({ where: { id: rule1.id } });
        await prisma.contributionRule.delete({ where: { id: rule2.id } });
      }
    });
  });

  // ============ 批次 4-B 新增:D11 Activity.completed 推动 ============
  // 沿 D-S10 / D-A7 / 业务规则文档 §3

  describe('D11 Activity.completed 推动(批次 4-B)', () => {
    it('首张 AttendanceSheet 创建 → Activity.statusCode 从 published 变为 completed', async () => {
      // 新建一个 published 状态的 activity(沿 fixture 风格)
      const ti = await prisma.dictItem.findFirstOrThrow({
        where: { code: 'att-demo' },
        select: { code: true },
      });
      const childOrg = await prisma.organization.findFirstOrThrow({
        where: { nodeTypeCode: 'att-child' },
        select: { id: true },
      });
      const act = await prisma.activity.create({
        data: {
          title: 'D11 推动测试',
          activityTypeCode: ti.code,
          organizationId: childOrg.id,
          startAt: new Date('2099-08-01T08:00:00.000Z'),
          endAt: new Date('2099-08-01T18:00:00.000Z'),
          location: '示例',
          statusCode: 'published',
        },
        select: { id: true },
      });

      await createPendingSheet(act.id, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-08-01T09:00:00.000Z',
          checkOutAt: '2099-08-01T10:00:00.000Z',
        }),
      ]);

      const after = await prisma.activity.findUnique({
        where: { id: act.id },
        select: { statusCode: true },
      });
      expect(after?.statusCode).toBe('completed');
    });

    it('多张 Sheet 幂等:第二张 Sheet 创建,Activity 仍 completed', async () => {
      const ti = await prisma.dictItem.findFirstOrThrow({
        where: { code: 'att-demo' },
        select: { code: true },
      });
      const childOrg = await prisma.organization.findFirstOrThrow({
        where: { nodeTypeCode: 'att-child' },
        select: { id: true },
      });
      const act = await prisma.activity.create({
        data: {
          title: 'D11 多 Sheet 幂等',
          activityTypeCode: ti.code,
          organizationId: childOrg.id,
          startAt: new Date('2099-08-02T08:00:00.000Z'),
          endAt: new Date('2099-08-02T18:00:00.000Z'),
          location: '示例',
          statusCode: 'published',
        },
        select: { id: true },
      });

      await createPendingSheet(act.id, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-08-02T09:00:00.000Z',
          checkOutAt: '2099-08-02T10:00:00.000Z',
        }),
      ]);
      // 第二张
      await createPendingSheet(act.id, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-08-02T11:00:00.000Z',
          checkOutAt: '2099-08-02T12:00:00.000Z',
        }),
      ]);
      const after = await prisma.activity.findUnique({
        where: { id: act.id },
        select: { statusCode: true },
      });
      expect(after?.statusCode).toBe('completed');
    });

    it('reject / final-reject 不回退 Activity.completed(状态机单向,沿 D11 / 业务规则文档 §3.3)', async () => {
      const ti = await prisma.dictItem.findFirstOrThrow({
        where: { code: 'att-demo' },
        select: { code: true },
      });
      const childOrg = await prisma.organization.findFirstOrThrow({
        where: { nodeTypeCode: 'att-child' },
        select: { id: true },
      });
      const act = await prisma.activity.create({
        data: {
          title: 'D11 不回退',
          activityTypeCode: ti.code,
          organizationId: childOrg.id,
          startAt: new Date('2099-08-03T08:00:00.000Z'),
          endAt: new Date('2099-08-03T18:00:00.000Z'),
          location: '示例',
          statusCode: 'published',
        },
        select: { id: true },
      });

      const sheetId = await createPendingSheet(act.id, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-08-03T09:00:00.000Z',
          checkOutAt: '2099-08-03T10:00:00.000Z',
        }),
      ]);
      // 此时 activity 已 completed
      await fillContributionPoints(sheetId, 1);
      await approveThenFinalReject(sheetId, '强行驳回');

      // Activity 仍 completed
      const after = await prisma.activity.findUnique({
        where: { id: act.id },
        select: { statusCode: true },
      });
      expect(after?.statusCode).toBe('completed');
    });

    it('Activity 已是 completed 时,POST Sheet 不报错(幂等)', async () => {
      const ti = await prisma.dictItem.findFirstOrThrow({
        where: { code: 'att-demo' },
        select: { code: true },
      });
      const childOrg = await prisma.organization.findFirstOrThrow({
        where: { nodeTypeCode: 'att-child' },
        select: { id: true },
      });
      const act = await prisma.activity.create({
        data: {
          title: 'D11 already completed',
          activityTypeCode: ti.code,
          organizationId: childOrg.id,
          startAt: new Date('2099-08-04T08:00:00.000Z'),
          endAt: new Date('2099-08-04T18:00:00.000Z'),
          location: '示例',
          statusCode: 'completed', // 直接 completed
        },
        select: { id: true },
      });

      const id = await createPendingSheet(act.id, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2099-08-04T09:00:00.000Z',
          checkOutAt: '2099-08-04T10:00:00.000Z',
        }),
      ]);
      expect(id).toBeTruthy();
      const after = await prisma.activity.findUnique({
        where: { id: act.id },
        select: { statusCode: true },
      });
      expect(after?.statusCode).toBe('completed');
    });
  });
});
