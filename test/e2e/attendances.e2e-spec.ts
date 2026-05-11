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
  let userWithMemberAuth: string;
  let userNoMemberAuth: string;
  let otherUserWithMemberAuth: string;

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

    // 5 用户
    await createTestUser(app, { username: 'att-su', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'att-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'att-user-with-mem', role: Role.USER });
    await createTestUser(app, { username: 'att-user-no-mem', role: Role.USER });
    await createTestUser(app, { username: 'att-user-other', role: Role.USER });
    superAdminAuth = (await loginAs(app, 'att-su')).authHeader;
    adminAuth = (await loginAs(app, 'att-adm')).authHeader;
    userWithMemberAuth = (await loginAs(app, 'att-user-with-mem')).authHeader;
    userNoMemberAuth = (await loginAs(app, 'att-user-no-mem')).authHeader;
    otherUserWithMemberAuth = (await loginAs(app, 'att-user-other')).authHeader;

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
    await prisma.user.update({
      where: { username: 'att-user-other' },
      data: { memberId: otherMemberId },
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
      .post('/api/v2/activities')
      .set('Authorization', adminAuth)
      .send({
        title: 'ATT-MAIN',
        activityTypeCode: ti.code,
        organizationId: childOrg.id,
        startAt: '2026-06-01T08:00:00.000Z',
        endAt: '2026-06-01T18:00:00.000Z',
        location: '演示',
      });
    activityId = actCreate.body.data.id;
    await request(httpServer(app))
      .patch(`/api/v2/activities/${activityId}/publish`)
      .set('Authorization', adminAuth);

    // 已取消活动
    const actCancel = await request(httpServer(app))
      .post('/api/v2/activities')
      .set('Authorization', adminAuth)
      .send({
        title: 'ATT-CANCEL',
        activityTypeCode: ti.code,
        organizationId: childOrg.id,
        startAt: '2026-06-01T08:00:00.000Z',
        endAt: '2026-06-01T18:00:00.000Z',
        location: '演示',
      });
    activityCancelledId = actCancel.body.data.id;
    await request(httpServer(app))
      .patch(`/api/v2/activities/${activityCancelledId}/publish`)
      .set('Authorization', adminAuth);
    await request(httpServer(app))
      .patch(`/api/v2/activities/${activityCancelledId}/cancel`)
      .set('Authorization', adminAuth)
      .send({});

    // 另一活动(用于跨 activity 时间冲突 + R23 mismatch)
    const actOther = await request(httpServer(app))
      .post('/api/v2/activities')
      .set('Authorization', adminAuth)
      .send({
        title: 'ATT-OTHER',
        activityTypeCode: ti.code,
        organizationId: childOrg.id,
        startAt: '2026-06-02T08:00:00.000Z',
        endAt: '2026-06-02T18:00:00.000Z',
        location: '演示',
      });
    activityOtherId = actOther.body.data.id;
    await request(httpServer(app))
      .patch(`/api/v2/activities/${activityOtherId}/publish`)
      .set('Authorization', adminAuth);

    // 报名 memberA 到 activityId(R23 正向)
    const reg1 = await request(httpServer(app))
      .post(`/api/v2/activities/${activityId}/registrations`)
      .set('Authorization', adminAuth)
      .send({ memberId: memberAId });
    registrationAId = reg1.body.data.id;

    // 报名 memberA 到 activityOtherId(R23 反向:registration.activityId !== sheet.activityId)
    const reg2 = await request(httpServer(app))
      .post(`/api/v2/activities/${activityOtherId}/registrations`)
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
    checkInAt: '2026-06-01T08:00:00.000Z',
    checkOutAt: '2026-06-01T12:00:00.000Z',
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
      .post(`/api/v2/activities/${actId}/attendance-sheets`)
      .set('Authorization', adminAuth)
      .send({ records });
    if (res.status !== 201) {
      throw new Error(`createPendingSheet failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.data.id as string;
  }

  // ============ 权限边界 ============

  describe('权限边界', () => {
    it('未登录 POST submit → 401', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${activityId}/attendance-sheets`)
        .send({ records: [baseRecord()] });
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER POST submit → 403', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${activityId}/attendance-sheets`)
        .set('Authorization', userWithMemberAuth)
        .send({ records: [baseRecord()] });
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER GET list → 403', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/activities/${activityId}/attendance-sheets`)
        .set('Authorization', userWithMemberAuth);
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER GET detail → 403', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/attendance-sheets/cl000000000000000000xxxx`)
        .set('Authorization', userWithMemberAuth);
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER GET review-detail → 403', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/attendance-sheets/cl000000000000000000xxxx/review-detail`)
        .set('Authorization', userWithMemberAuth);
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER PATCH edit → 403', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/cl000000000000000000xxxx`)
        .set('Authorization', userWithMemberAuth)
        .send({});
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER DELETE → 403', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/v2/attendance-sheets/cl000000000000000000xxxx`)
        .set('Authorization', userWithMemberAuth);
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER PATCH approve → 403', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/cl000000000000000000xxxx/approve`)
        .set('Authorization', userWithMemberAuth)
        .send({});
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER PATCH reject → 403', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/cl000000000000000000xxxx/reject`)
        .set('Authorization', userWithMemberAuth)
        .send({ reviewNote: 'x' });
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('未登录 GET /me/attendance-records → 401', async () => {
      const res = await request(httpServer(app)).get('/api/v2/users/me/attendance-records');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER GET /me/attendance-records → 200(允许;USER 路径)', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/attendance-records')
        .set('Authorization', userWithMemberAuth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
    });
  });

  // ============ POST submit 主成功 ============

  describe('POST submit 主路径', () => {
    it('正常提交单 record → 201,statusCode=pending,version=1', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberBId,
              checkInAt: '2026-06-01T09:00:00.000Z',
              checkOutAt: '2026-06-01T11:00:00.000Z',
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
        .post(`/api/v2/activities/${activityOtherId}/attendance-sheets`)
        .set('Authorization', superAdminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberCId,
              checkInAt: '2026-06-02T09:00:00.000Z',
              checkOutAt: '2026-06-02T11:00:00.000Z',
            }),
            baseRecord({
              memberId: memberBId,
              checkInAt: '2026-06-02T13:00:00.000Z',
              checkOutAt: '2026-06-02T15:00:00.000Z',
            }),
          ],
        });
      expect(res.status).toBe(201);
    });

    it('提交时不传 serviceHours → 后端自动 (checkOut-checkIn)/3600', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2026-06-01T10:00:00.000Z',
          checkOutAt: '2026-06-01T13:30:00.000Z',
        }),
      ]);
      const records = await prisma.attendanceRecord.findMany({ where: { sheetId: id } });
      expect(records[0].serviceHours.toString()).toBe('3.5');
    });

    it('提交时手填 serviceHours < 跨度 → 接受(D46 吃饭休息允许)', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: otherMemberId,
          checkInAt: '2026-06-01T14:00:00.000Z',
          checkOutAt: '2026-06-01T17:00:00.000Z',
          serviceHours: 2.5,
        }),
      ]);
      const records = await prisma.attendanceRecord.findMany({ where: { sheetId: id } });
      expect(records[0].serviceHours.toString()).toBe('2.5');
    });

    it('提交带 registrationId(R23 正向:同活动)→ 201', async () => {
      // memberA 在 activityId 已有 registration registrationAId(R23 正向)
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberAId,
              checkInAt: '2026-06-01T15:00:00.000Z',
              checkOutAt: '2026-06-01T17:30:00.000Z',
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
        .post('/api/v2/activities/cl0000000000000000000000/attendance-sheets')
        .set('Authorization', adminAuth)
        .send({ records: [baseRecord({ memberId: memberCId })] });
      expectBizError(res, BizCode.ACTIVITY_NOT_FOUND);
    });

    it('activity cancelled → ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN(20122)', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${activityCancelledId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({ records: [baseRecord({ memberId: memberCId })] });
      expectBizError(res, BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN);
    });

    it('member 不存在 → MEMBER_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [baseRecord({ memberId: 'cl0000000000000000000000' })],
        });
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('roleCode 不存在 → ATTENDANCE_ROLE_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [baseRecord({ memberId: memberCId, roleCode: 'no-such-role' })],
        });
      expectBizError(res, BizCode.ATTENDANCE_ROLE_CODE_INVALID);
    });

    it('attendanceStatusCode 不存在 → ATTENDANCE_STATUS_CODE_INVALID(absent/leave 自动失败)', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [baseRecord({ memberId: memberCId, attendanceStatusCode: 'absent' })],
        });
      expectBizError(res, BizCode.ATTENDANCE_STATUS_CODE_INVALID);
    });

    it('checkOutAt <= checkInAt → CHECK_OUT_BEFORE_CHECK_IN', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberCId,
              checkInAt: '2026-06-01T10:00:00.000Z',
              checkOutAt: '2026-06-01T10:00:00.000Z',
            }),
          ],
        });
      expectBizError(res, BizCode.CHECK_OUT_BEFORE_CHECK_IN);
    });

    it('serviceHours <= 0 → ATTENDANCE_SERVICE_HOURS_INVALID', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberCId,
              checkInAt: '2026-06-01T12:00:00.000Z',
              checkOutAt: '2026-06-01T13:00:00.000Z',
              serviceHours: 0,
            }),
          ],
        });
      // DTO 层 @Min(0.01) 直接 400
      expect(res.status).toBe(400);
    });

    it('serviceHours > 跨度 → ATTENDANCE_SERVICE_HOURS_EXCEEDS_SPAN', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberCId,
              checkInAt: '2026-06-01T13:00:00.000Z',
              checkOutAt: '2026-06-01T14:00:00.000Z',
              serviceHours: 5,
            }),
          ],
        });
      expectBizError(res, BizCode.ATTENDANCE_SERVICE_HOURS_EXCEEDS_SPAN);
    });

    it('R23 跨表:registrationId 不属于本活动 → ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH', async () => {
      // memberA 在 activityOtherId 有 reg,但 sheet 父活动是 activityId
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberAId,
              checkInAt: '2026-06-01T16:00:00.000Z',
              checkOutAt: '2026-06-01T17:00:00.000Z',
              registrationId: registrationOtherActivityId,
            }),
          ],
        });
      expectBizError(res, BizCode.ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH);
    });

    it('R23 跨表:registrationId 不存在 → MISMATCH', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberAId,
              checkInAt: '2026-06-03T10:00:00.000Z',
              checkOutAt: '2026-06-03T12:00:00.000Z',
              registrationId: 'cl0000000000000000000000',
            }),
          ],
        });
      expectBizError(res, BizCode.ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH);
    });

    it('空 records 数组 → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({ records: [] });
      expect(res.status).toBe(400);
    });

    it('non-whitelisted statusCode → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          statusCode: 'approved',
          records: [baseRecord({ memberId: memberCId })],
        });
      expect(res.status).toBe(400);
    });

    it('non-whitelisted version → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          version: 99,
          records: [baseRecord({ memberId: memberCId })],
        });
      expect(res.status).toBe(400);
    });

    it('non-whitelisted previousSnapshot → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          previousSnapshot: { fake: true },
          records: [baseRecord({ memberId: memberCId })],
        });
      expect(res.status).toBe(400);
    });

    it('non-whitelisted submitterUserId → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${activityId}/attendance-sheets`)
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
          checkInAt: '2026-06-05T08:00:00.000Z',
          checkOutAt: '2026-06-05T10:00:00.000Z',
        }),
      ]);
    });

    it('完全重叠 → 22060', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: overlapMember,
              checkInAt: '2026-06-05T08:00:00.000Z',
              checkOutAt: '2026-06-05T10:00:00.000Z',
            }),
          ],
        });
      expectBizError(res, BizCode.ATTENDANCE_TIME_OVERLAP);
    });

    it('部分重叠 → 22060', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: overlapMember,
              checkInAt: '2026-06-05T09:00:00.000Z',
              checkOutAt: '2026-06-05T11:00:00.000Z',
            }),
          ],
        });
      expectBizError(res, BizCode.ATTENDANCE_TIME_OVERLAP);
    });

    it('Q-S15 左闭右开:紧邻 endAt = startAt 允许', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: overlapMember,
              checkInAt: '2026-06-05T10:00:00.000Z',
              checkOutAt: '2026-06-05T12:00:00.000Z',
            }),
          ],
        });
      expect(res.status).toBe(201);
    });

    it('跨 Sheet 跨 Activity 全局校验:不同 activity 但同 memberId 时间重叠 → 22060', async () => {
      // 在 activityOtherId 给 overlapMember 提交同时段 → 应被拒
      const res = await request(httpServer(app))
        .post(`/api/v2/activities/${activityOtherId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: overlapMember,
              checkInAt: '2026-06-05T09:30:00.000Z',
              checkOutAt: '2026-06-05T10:30:00.000Z',
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
        .post(`/api/v2/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: otherM,
              checkInAt: '2026-06-06T08:00:00.000Z',
              checkOutAt: '2026-06-06T10:00:00.000Z',
            }),
            baseRecord({
              memberId: otherM,
              checkInAt: '2026-06-06T09:00:00.000Z',
              checkOutAt: '2026-06-06T11:00:00.000Z',
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
          checkInAt: '2026-06-10T08:00:00.000Z',
          checkOutAt: '2026-06-10T10:00:00.000Z',
        }),
      ]);
    });

    it('GET list:activity 不存在 → ACTIVITY_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/activities/cl0000000000000000000000/attendance-sheets')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ACTIVITY_NOT_FOUND);
    });

    it('GET list 主路径:分页返回 + statusCode=pending 过滤', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/activities/${activityId}/attendance-sheets`)
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
        .get('/api/v2/attendance-sheets/cl0000000000000000000000')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ATTENDANCE_SHEET_NOT_FOUND);
    });

    it('GET detail:不返 records 数组(Sheet 简化)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/attendance-sheets/${createdId}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(createdId);
      expect(res.body.data).not.toHaveProperty('records');
      expect(res.body.data).not.toHaveProperty('previousSnapshot');
      expect(res.body.data).not.toHaveProperty('deletedAt');
    });

    it('GET review-detail:Activity 摘要 + Sheet + Records 完整(R25)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/attendance-sheets/${createdId}/review-detail`)
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
        .get('/api/v2/attendance-sheets/cl0000000000000000000000/review-detail')
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
          checkInAt: '2026-06-15T08:00:00.000Z',
          checkOutAt: '2026-06-15T10:00:00.000Z',
        }),
      ]);

      // approved Sheet:先创建,填 contributionPoints,再 approve
      approvedId = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2026-06-15T11:00:00.000Z',
          checkOutAt: '2026-06-15T12:00:00.000Z',
        }),
      ]);
      await fillContributionPoints(approvedId);
      await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${approvedId}/approve`)
        .set('Authorization', adminAuth)
        .send({});

      // rejected Sheet
      rejectedId = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2026-06-15T13:00:00.000Z',
          checkOutAt: '2026-06-15T14:00:00.000Z',
        }),
      ]);
      await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${rejectedId}/reject`)
        .set('Authorization', adminAuth)
        .send({ reviewNote: 'fixture reject' });
    });

    it('edit pending Sheet(替换 records)→ 200,version+1,previousSnapshot 后端写入', async () => {
      const before = await prisma.attendanceSheet.findUnique({ where: { id: pendingId } });
      expect(before?.version).toBe(1);
      expect(before?.previousSnapshot).toBeNull();

      const res = await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${pendingId}`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberCId,
              checkInAt: '2026-06-15T08:30:00.000Z',
              checkOutAt: '2026-06-15T09:30:00.000Z',
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
      expect(activeRecords[0].checkInAt.toISOString()).toBe('2026-06-15T08:30:00.000Z');
      const allRecords = await prisma.attendanceRecord.findMany({
        where: { sheetId: pendingId },
      });
      expect(allRecords.length).toBe(2); // 1 旧软删 + 1 新
    });

    it('edit approved Sheet → 22040 ATTENDANCE_SHEET_APPROVED_NOT_EDITABLE', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${approvedId}`)
        .set('Authorization', adminAuth)
        .send({ records: [baseRecord({ memberId: memberCId })] });
      expectBizError(res, BizCode.ATTENDANCE_SHEET_APPROVED_NOT_EDITABLE);
    });

    it('edit rejected Sheet → 22041 ATTENDANCE_SHEET_REJECTED_NOT_EDITABLE', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${rejectedId}`)
        .set('Authorization', adminAuth)
        .send({ records: [baseRecord({ memberId: memberCId })] });
      expectBizError(res, BizCode.ATTENDANCE_SHEET_REJECTED_NOT_EDITABLE);
    });

    it('edit Sheet 不存在 → 22001', async () => {
      const res = await request(httpServer(app))
        .patch('/api/v2/attendance-sheets/cl0000000000000000000000')
        .set('Authorization', adminAuth)
        .send({});
      expectBizError(res, BizCode.ATTENDANCE_SHEET_NOT_FOUND);
    });

    it('edit:non-whitelisted statusCode → 400', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2026-06-16T08:00:00.000Z',
          checkOutAt: '2026-06-16T09:00:00.000Z',
        }),
      ]);
      const res = await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${id}`)
        .set('Authorization', adminAuth)
        .send({ statusCode: 'approved' });
      expect(res.status).toBe(400);
    });

    it('edit:non-whitelisted version → 400', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2026-06-16T10:00:00.000Z',
          checkOutAt: '2026-06-16T11:00:00.000Z',
        }),
      ]);
      const res = await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${id}`)
        .set('Authorization', adminAuth)
        .send({ version: 99 });
      expect(res.status).toBe(400);
    });

    it('edit:non-whitelisted previousSnapshot → 400', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2026-06-16T12:00:00.000Z',
          checkOutAt: '2026-06-16T13:00:00.000Z',
        }),
      ]);
      const res = await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${id}`)
        .set('Authorization', adminAuth)
        .send({ previousSnapshot: { fake: true } });
      expect(res.status).toBe(400);
    });

    it('edit:non-whitelisted reviewNote(应走 approve / reject)→ 400', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2026-06-16T14:00:00.000Z',
          checkOutAt: '2026-06-16T15:00:00.000Z',
        }),
      ]);
      const res = await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${id}`)
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
          checkInAt: '2026-06-20T08:00:00.000Z',
          checkOutAt: '2026-06-20T10:00:00.000Z',
        }),
      ]);
      const del = await request(httpServer(app))
        .delete(`/api/v2/attendance-sheets/${id}`)
        .set('Authorization', adminAuth);
      expect(del.status).toBe(200);

      const sheet = await prisma.attendanceSheet.findUnique({ where: { id } });
      expect(sheet?.deletedAt).not.toBeNull();
      const records = await prisma.attendanceRecord.findMany({ where: { sheetId: id } });
      expect(records.every((r) => r.deletedAt !== null)).toBe(true);

      // 软删后 detail 不可见
      const detail = await request(httpServer(app))
        .get(`/api/v2/attendance-sheets/${id}`)
        .set('Authorization', adminAuth);
      expectBizError(detail, BizCode.ATTENDANCE_SHEET_NOT_FOUND);
    });

    it('软删 approved Sheet → 22040', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2026-06-20T11:00:00.000Z',
          checkOutAt: '2026-06-20T12:00:00.000Z',
        }),
      ]);
      await fillContributionPoints(id);
      await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${id}/approve`)
        .set('Authorization', adminAuth)
        .send({});

      const res = await request(httpServer(app))
        .delete(`/api/v2/attendance-sheets/${id}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ATTENDANCE_SHEET_APPROVED_NOT_EDITABLE);
    });

    it('软删 rejected Sheet → 22041', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2026-06-20T13:00:00.000Z',
          checkOutAt: '2026-06-20T14:00:00.000Z',
        }),
      ]);
      await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${id}/reject`)
        .set('Authorization', adminAuth)
        .send({ reviewNote: 'cleanup' });

      const res = await request(httpServer(app))
        .delete(`/api/v2/attendance-sheets/${id}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ATTENDANCE_SHEET_REJECTED_NOT_EDITABLE);
    });

    it('软删不存在 Sheet → 22001', async () => {
      const res = await request(httpServer(app))
        .delete('/api/v2/attendance-sheets/cl0000000000000000000000')
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
          checkInAt: '2026-06-25T08:00:00.000Z',
          checkOutAt: '2026-06-25T10:00:00.000Z',
        }),
      ]);
      const res = await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${id}/approve`)
        .set('Authorization', adminAuth)
        .send({});
      expectBizError(res, BizCode.ATTENDANCE_RECORD_CONTRIBUTION_POINTS_REQUIRED);
    });

    it('approve pending Sheet:全部 records contribution 填后 → 200 + statusCode=approved', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2026-06-25T11:00:00.000Z',
          checkOutAt: '2026-06-25T13:00:00.000Z',
        }),
      ]);
      await fillContributionPoints(id, 2);

      const res = await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${id}/approve`)
        .set('Authorization', adminAuth)
        .send({ reviewNote: 'looks good' });
      expect(res.status).toBe(200);
      expect(res.body.data.statusCode).toBe('approved');
      expect(res.body.data.reviewerUserId).toBeTruthy();
      expect(res.body.data.reviewedAt).toBeTruthy();
      expect(res.body.data.reviewNote).toBe('looks good');
    });

    it('approve 再次 → 22030(已 approved 非 pending)', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2026-06-25T14:00:00.000Z',
          checkOutAt: '2026-06-25T15:00:00.000Z',
        }),
      ]);
      await fillContributionPoints(id);
      await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${id}/approve`)
        .set('Authorization', adminAuth)
        .send({});
      const res2 = await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${id}/approve`)
        .set('Authorization', adminAuth)
        .send({});
      expectBizError(res2, BizCode.ATTENDANCE_SHEET_STATUS_INVALID);
    });

    it('approve rejected Sheet → 22030', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2026-06-25T16:00:00.000Z',
          checkOutAt: '2026-06-25T17:00:00.000Z',
        }),
      ]);
      await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${id}/reject`)
        .set('Authorization', adminAuth)
        .send({ reviewNote: 'reject me' });
      const res = await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${id}/approve`)
        .set('Authorization', adminAuth)
        .send({});
      expectBizError(res, BizCode.ATTENDANCE_SHEET_STATUS_INVALID);
    });

    it('approve 不存在 → 22001', async () => {
      const res = await request(httpServer(app))
        .patch('/api/v2/attendance-sheets/cl0000000000000000000000/approve')
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
          checkInAt: '2026-06-26T08:00:00.000Z',
          checkOutAt: '2026-06-26T09:00:00.000Z',
        }),
      ]);
      const res = await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${id}/reject`)
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
          checkInAt: '2026-06-26T10:00:00.000Z',
          checkOutAt: '2026-06-26T11:00:00.000Z',
        }),
      ]);
      const res = await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${id}/reject`)
        .set('Authorization', adminAuth)
        .send({});
      expect(res.status).toBe(400);
    });

    it('reject approved Sheet → 22030', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2026-06-26T12:00:00.000Z',
          checkOutAt: '2026-06-26T13:00:00.000Z',
        }),
      ]);
      await fillContributionPoints(id);
      await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${id}/approve`)
        .set('Authorization', adminAuth)
        .send({});
      const res = await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${id}/reject`)
        .set('Authorization', adminAuth)
        .send({ reviewNote: '试图驳回已通过' });
      expectBizError(res, BizCode.ATTENDANCE_SHEET_STATUS_INVALID);
    });

    it('reject 不存在 → 22001', async () => {
      const res = await request(httpServer(app))
        .patch('/api/v2/attendance-sheets/cl0000000000000000000000/reject')
        .set('Authorization', adminAuth)
        .send({ reviewNote: 'x' });
      expectBizError(res, BizCode.ATTENDANCE_SHEET_NOT_FOUND);
    });
  });

  // ============ /me/attendance-records(Q-A14) ============

  describe('GET /me/attendance-records', () => {
    let approvedSheetId: string;
    let pendingSheetId: string;
    let rejectedSheetId: string;

    beforeAll(async () => {
      // memberA(绑定 userWithMember)在多个 Sheet 内有记录;只有 approved 应可见。
      // 用 activityOtherId 来避开 activityId 主测试段的时间冲突
      pendingSheetId = await createPendingSheet(activityOtherId, [
        baseRecord({
          memberId: memberAId,
          checkInAt: '2026-07-01T08:00:00.000Z',
          checkOutAt: '2026-07-01T09:00:00.000Z',
        }),
      ]);
      approvedSheetId = await createPendingSheet(activityOtherId, [
        baseRecord({
          memberId: memberAId,
          checkInAt: '2026-07-01T09:00:00.000Z',
          checkOutAt: '2026-07-01T10:00:00.000Z',
        }),
      ]);
      await fillContributionPoints(approvedSheetId, 1.5);
      await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${approvedSheetId}/approve`)
        .set('Authorization', adminAuth)
        .send({});

      rejectedSheetId = await createPendingSheet(activityOtherId, [
        baseRecord({
          memberId: memberAId,
          checkInAt: '2026-07-01T10:00:00.000Z',
          checkOutAt: '2026-07-01T11:00:00.000Z',
        }),
      ]);
      await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${rejectedSheetId}/reject`)
        .set('Authorization', adminAuth)
        .send({ reviewNote: 'reject for /me test' });
    });

    it('USER 未绑 member → MEMBER_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/attendance-records')
        .set('Authorization', userNoMemberAuth);
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('USER 绑 member:只见 approved Sheet 内自己的 record(Q-A14)', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/attendance-records')
        .set('Authorization', userWithMemberAuth);
      expect(res.status).toBe(200);
      const sheetIds = (res.body.data.items as Array<{ sheetId: string }>).map((i) => i.sheetId);
      expect(sheetIds).toContain(approvedSheetId);
      expect(sheetIds).not.toContain(pendingSheetId);
      expect(sheetIds).not.toContain(rejectedSheetId);
    });

    it('USER 绑 member:每个 record 含 member 摘要 + Decimal 序列化为 string', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/attendance-records')
        .set('Authorization', userWithMemberAuth);
      const item = (res.body.data.items as Array<Record<string, unknown>>)[0];
      expect(item.memberId).toBe(memberAId);
      expect(item).toHaveProperty('member');
      const member = item.member as Record<string, unknown>;
      expect(member.memberNo).toBeTruthy();
      expect(member.displayName).toBeTruthy();
      expect(typeof item.serviceHours).toBe('string');
    });

    it('USER 绑 member:activityId 过滤生效', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/attendance-records')
        .query({ activityId: activityOtherId })
        .set('Authorization', userWithMemberAuth);
      expect(res.status).toBe(200);
      // 全部返回的都是 activityOtherId 下的 approved records
      const items = res.body.data.items as Array<{ sheetId: string }>;
      for (const item of items) {
        // sheetId 应该指向已 approve 的 sheet,且其 activityId 是 activityOtherId
        expect(item.sheetId).toBe(approvedSheetId);
      }
    });

    it('USER 绑 member:不返他人的 records(otherUserWithMember 看不到 memberA 的)', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/attendance-records')
        .set('Authorization', otherUserWithMemberAuth);
      expect(res.status).toBe(200);
      const memberIds = (res.body.data.items as Array<{ memberId: string }>).map((i) => i.memberId);
      for (const m of memberIds) {
        expect(m).toBe(otherMemberId);
        expect(m).not.toBe(memberAId);
      }
    });
  });

  // ============ approved-only 事件 / 副作用 ============

  describe('Q-S13 approved-only:eventPlaceholder 仅 approve 触发', () => {
    // 副作用层面验证:eventPlaceholder 走 logger,e2e 无法直接断言 logger,
    // 通过"approve 路径 statusCode 正确转移 + reject/submit/edit/delete 不引起后续业务变化"间接覆盖。
    // 这里测一遍 reject 后 attendance.recorded 不应改变 sheet 状态(若误触发会写日志但不影响 DB)。
    it('reject 后 sheet 仍为 rejected;不触发 approved', async () => {
      const id = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: '2026-06-28T08:00:00.000Z',
          checkOutAt: '2026-06-28T09:00:00.000Z',
        }),
      ]);
      await request(httpServer(app))
        .patch(`/api/v2/attendance-sheets/${id}/reject`)
        .set('Authorization', adminAuth)
        .send({ reviewNote: 'no event' });
      const sheet = await prisma.attendanceSheet.findUnique({ where: { id } });
      expect(sheet?.statusCode).toBe('rejected');
    });
  });
});
