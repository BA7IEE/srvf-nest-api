import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role, UserStatus } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// Phase 2 P2-6 App /api/app/v1/my/attendance-records e2e。
// 沿 docs/app-api-p2-6-attendance-records-review.md §10.2 13 类用例:
//   1. 字段集恰好 14 / 不含 sensitive
//   2. 派生 activity* 字段(join Activity)
//   3. 仅 approved sheet(pending / rejected / final_rejected / pending_final_review 不返)
//   4. 软删 record / sheet 不返
//   5. ?activityId= filter / ?activityId= 不存在 → empty
//   6. query 边界(pageSize=101 / unknown query / page<1 → 400)
//   7. scope-self(USER A 看不到 USER B)
//   8. admin-as-member(linked admin 走 self perspective,看不到他人)
//   9. admin-without-member / Member.INACTIVE / Member 软删 → 403 FORBIDDEN
//   10. User.DISABLED → 401(JwtStrategy)
//   11. empty list + 分页 + 排序(checkInAt desc)
//   12. 未登录 → 401
// 注:旧 v2 队员考勤记录路径已在 API surface 迁移(Route B)中删除,行为改由本 App 套件覆盖。
//
// 准入沿评审稿 §8.1 + §8.2 + D-P2-6-12 / D-P2-6-13:
//   - canUseApp=false 统一 FORBIDDEN=40300(不沿 D-P2-3-1 admin-without-member 例外)
//   - admin-as-member 走 linked-member self perspective(禁 role 短路)
//
// 数据范围沿 §4 过滤铁律:Sheet.statusCode='approved' AND Sheet.deletedAt=null AND
// Record.memberId=currentUser.memberId AND Record.deletedAt=null(由既有 listMyRecords
// 锁定;本 e2e 反向断言)。

interface ResBody {
  code: number;
  message: string;
  data: Record<string, unknown>;
}

// AppMyAttendanceRecordDto 字段集恰好 14 项(沿评审稿 §5.1)
const APP_MY_ATT_KEYS = [
  'id',
  'activityId',
  'activityTitle',
  'activityStartAt',
  'activityEndAt',
  'activityCoverImageUrl',
  'roleCode',
  'checkInAt',
  'checkOutAt',
  'serviceHours',
  'attendanceStatusCode',
  'note',
  'contributionPoints',
  'createdAt',
].sort();

// 禁返字段(沿评审稿 §5.2 + §5.3):sheetId / memberId / member 嵌套 / registrationId /
// updatedAt / L2 字段 / Sheet admin 字段 / L3 Credential。
const FORBIDDEN_KEYS = [
  'sheetId',
  'memberId',
  'member',
  'registrationId',
  'updatedAt',
  // L2 / L3
  'passwordHash',
  'refreshToken',
  'tokenHash',
  // Sheet admin
  'submitterUserId',
  'reviewerUserId',
  'reviewNote',
  'finalReviewerUserId',
  'finalReviewNote',
  'previousSnapshot',
  'version',
  // audit context
  'requestId',
  'ip',
  'ua',
  // Activity 高敏 / housekeeping(派生不应携带)
  'description',
  'capacity',
  'deletedAt',
];

describe('App /api/app/v1/my/attendance-records (P2-6)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  // 用户 + member 矩阵
  let userAAuth: string; // USER + memberA(ACTIVE)
  let userBAuth: string; // USER + memberB(ACTIVE,他人)
  let userNoMemAuth: string; // USER + 无 member
  let userInactiveMemAuth: string; // USER + memberInactive(MemberStatus.INACTIVE)
  let userDeletedMemAuth: string; // USER + memberDeleted(deletedAt != null)
  let adminWithMemberAuth: string; // ADMIN + memberAdmin(ACTIVE)
  let adminNoMemAuth: string; // ADMIN + 无 member

  let memberAId: string;
  let memberBId: string;
  let memberInactiveId: string;
  let memberDeletedId: string;
  let memberAdminId: string;

  let activity1Id: string; // 主活动(memberA 多 records)
  let activity2Id: string; // 第二活动(memberA + memberB)
  let activity3Id: string; // 第三活动(用于 ?activityId= filter 验证)

  // approved sheet 内的 records(memberA),应可在 App 列表中查到
  let approvedRecord1Id: string; // activity1 早(checkInAt 早)
  let approvedRecord2Id: string; // activity1 晚(checkInAt 晚 → orderBy desc 第一个)
  let approvedRecord3Id: string; // activity2
  let approvedRecord4Id: string; // activity3
  let approvedRecord5Id: string; // activity1 — 之后会被软删,验证 record 软删过滤

  // pending sheet 内的 records(memberA),应不返
  let pendingSheetId: string;

  // rejected(一级)sheet 内的 records,应不返
  let rejectedSheetId: string;

  // pending_final_review sheet 内的 records,应不返
  let pendingFinalReviewSheetId: string;

  // final_rejected sheet 内的 records,应不返
  let finalRejectedSheetId: string;

  // approved sheet 之后被软删,sheet.deletedAt != null,应不返
  let softDeletedSheetId: string;

  // memberB 在 activity2 的 approved record,scope-self 应不返给 userA
  let memberBApprovedRecordId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    // ============ Users ============
    await createTestUser(app, { username: 'p26-su', role: Role.SUPER_ADMIN });
    // PR9:第二 SUPER_ADMIN 专职 final-approve(p26-su 是 submitter+一级审;自审 22074 对 SA
    // 亦拒、同人 22075 默认拒 —— 单人无法再走完 submit→approve→final 全程)
    await createTestUser(app, { username: 'p26-su-final', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'p26-user-a', role: Role.USER });
    await createTestUser(app, { username: 'p26-user-b', role: Role.USER });
    await createTestUser(app, { username: 'p26-user-no-mem', role: Role.USER });
    await createTestUser(app, { username: 'p26-user-inactive-mem', role: Role.USER });
    await createTestUser(app, { username: 'p26-user-deleted-mem', role: Role.USER });
    await createTestUser(app, { username: 'p26-admin-with-mem', role: Role.ADMIN });
    await createTestUser(app, { username: 'p26-admin-no-mem', role: Role.ADMIN });

    // ============ Members ============
    const ma = await prisma.member.create({
      data: { memberNo: 'p26-m-a', displayName: 'Member A', status: MemberStatus.ACTIVE },
      select: { id: true },
    });
    memberAId = ma.id;
    const mb = await prisma.member.create({
      data: { memberNo: 'p26-m-b', displayName: 'Member B', status: MemberStatus.ACTIVE },
      select: { id: true },
    });
    memberBId = mb.id;
    const minactive = await prisma.member.create({
      data: {
        memberNo: 'p26-m-inactive',
        displayName: 'Inactive Member',
        status: MemberStatus.INACTIVE,
      },
      select: { id: true },
    });
    memberInactiveId = minactive.id;
    const mdeleted = await prisma.member.create({
      data: {
        memberNo: 'p26-m-deleted',
        displayName: 'Deleted Member',
        status: MemberStatus.ACTIVE,
        deletedAt: new Date(),
      },
      select: { id: true },
    });
    memberDeletedId = mdeleted.id;
    const madmin = await prisma.member.create({
      data: { memberNo: 'p26-m-admin', displayName: 'Admin Member', status: MemberStatus.ACTIVE },
      select: { id: true },
    });
    memberAdminId = madmin.id;

    // ============ Link users → members ============
    await prisma.user.update({
      where: { username: 'p26-user-a' },
      data: { memberId: memberAId },
    });
    await prisma.user.update({
      where: { username: 'p26-user-b' },
      data: { memberId: memberBId },
    });
    await prisma.user.update({
      where: { username: 'p26-user-inactive-mem' },
      data: { memberId: memberInactiveId },
    });
    await prisma.user.update({
      where: { username: 'p26-user-deleted-mem' },
      data: { memberId: memberDeletedId },
    });
    await prisma.user.update({
      where: { username: 'p26-admin-with-mem' },
      data: { memberId: memberAdminId },
    });

    // ============ Login ============
    const superAdminAuth = (await loginAs(app, 'p26-su')).authHeader;
    const finalReviewerAuth = (await loginAs(app, 'p26-su-final')).authHeader;
    userAAuth = (await loginAs(app, 'p26-user-a')).authHeader;
    userBAuth = (await loginAs(app, 'p26-user-b')).authHeader;
    userNoMemAuth = (await loginAs(app, 'p26-user-no-mem')).authHeader;
    userInactiveMemAuth = (await loginAs(app, 'p26-user-inactive-mem')).authHeader;
    userDeletedMemAuth = (await loginAs(app, 'p26-user-deleted-mem')).authHeader;
    adminWithMemberAuth = (await loginAs(app, 'p26-admin-with-mem')).authHeader;
    adminNoMemAuth = (await loginAs(app, 'p26-admin-no-mem')).authHeader;

    // ============ Dictionaries ============
    const nodeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'p26-root', label: '根' },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'p26-child', label: '子' },
    });
    const rootOrg = await prisma.organization.create({
      data: { name: 'P26 Root', nodeTypeCode: 'p26-root', parentId: null },
      select: { id: true },
    });
    const childOrg = await prisma.organization.create({
      data: { name: 'P26 Child', nodeTypeCode: 'p26-child', parentId: rootOrg.id },
      select: { id: true },
    });

    const actTypeDict = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    const ti = await prisma.dictItem.create({
      data: { typeId: actTypeDict.id, code: 'p26-demo', label: '演示' },
      select: { code: true },
    });

    const roleDict = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    for (const code of ['member', 'instructor', 'coach']) {
      await prisma.dictItem.create({
        data: { typeId: roleDict.id, code, label: code },
      });
    }
    const statDict = await prisma.dictType.create({
      data: { code: 'attendance_status', label: '考勤状态' },
      select: { id: true },
    });
    for (const code of ['present', 'late', 'early_leave']) {
      await prisma.dictItem.create({
        data: { typeId: statDict.id, code, label: code },
      });
    }

    // ============ Activities ============
    const a1 = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', superAdminAuth)
      .send({
        title: 'P26 Activity 1',
        activityTypeCode: ti.code,
        organizationId: childOrg.id,
        startAt: '2099-06-01T08:00:00.000Z',
        endAt: '2099-06-01T18:00:00.000Z',
        location: '梧桐山',
        coverImageUrl: 'https://example.com/cover-1.png',
      });
    activity1Id = a1.body.data.id;
    await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activity1Id}/publish`)
      .set('Authorization', superAdminAuth)
      .send({ requiresInsuranceConfirmed: true });

    const a2 = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', superAdminAuth)
      .send({
        title: 'P26 Activity 2',
        activityTypeCode: ti.code,
        organizationId: childOrg.id,
        startAt: '2099-06-02T08:00:00.000Z',
        endAt: '2099-06-02T18:00:00.000Z',
        location: '七娘山',
      });
    activity2Id = a2.body.data.id;
    await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activity2Id}/publish`)
      .set('Authorization', superAdminAuth)
      .send({ requiresInsuranceConfirmed: true });

    const a3 = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', superAdminAuth)
      .send({
        title: 'P26 Activity 3',
        activityTypeCode: ti.code,
        organizationId: childOrg.id,
        startAt: '2099-06-03T08:00:00.000Z',
        endAt: '2099-06-03T18:00:00.000Z',
        location: '南山',
      });
    activity3Id = a3.body.data.id;
    await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activity3Id}/publish`)
      .set('Authorization', superAdminAuth)
      .send({ requiresInsuranceConfirmed: true });

    // ============ Sheets seed via admin path ============
    // 1) activity1:approved sheet with 3 records (memberA × 2 + 一个之后软删)
    const approvedSheet1Res = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activity1Id}/attendance-sheets`)
      .set('Authorization', superAdminAuth)
      .send({
        records: [
          {
            memberId: memberAId,
            roleCode: 'member',
            checkInAt: '2099-06-01T08:00:00.000Z',
            checkOutAt: '2099-06-01T10:00:00.000Z',
            attendanceStatusCode: 'present',
            note: 'Record 1 — early',
            contributionPoints: 1.0,
          },
          {
            memberId: memberAId,
            roleCode: 'instructor',
            checkInAt: '2099-06-01T14:00:00.000Z',
            checkOutAt: '2099-06-01T18:00:00.000Z',
            attendanceStatusCode: 'present',
            note: 'Record 2 — late slot',
            contributionPoints: 2.5,
          },
          {
            memberId: memberAId,
            roleCode: 'member',
            checkInAt: '2099-06-01T11:00:00.000Z',
            checkOutAt: '2099-06-01T13:00:00.000Z',
            attendanceStatusCode: 'present',
            contributionPoints: 0.5,
          },
        ],
      });
    const approvedSheet1Id = approvedSheet1Res.body.data.id as string;

    // 2) activity2:memberA 1 record + memberB 1 record (验 scope-self + admin-as-member)
    const approvedSheet2Res = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activity2Id}/attendance-sheets`)
      .set('Authorization', superAdminAuth)
      .send({
        records: [
          {
            memberId: memberAId,
            roleCode: 'member',
            checkInAt: '2099-06-02T08:00:00.000Z',
            checkOutAt: '2099-06-02T18:00:00.000Z',
            attendanceStatusCode: 'present',
            contributionPoints: 3.0,
          },
          {
            memberId: memberBId,
            roleCode: 'member',
            checkInAt: '2099-06-02T08:00:00.000Z',
            checkOutAt: '2099-06-02T18:00:00.000Z',
            attendanceStatusCode: 'present',
            contributionPoints: 3.0,
          },
        ],
      });
    const approvedSheet2Id = approvedSheet2Res.body.data.id as string;

    // 3) activity3:memberA 1 record(用于 filter)
    const approvedSheet3Res = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activity3Id}/attendance-sheets`)
      .set('Authorization', superAdminAuth)
      .send({
        records: [
          {
            memberId: memberAId,
            roleCode: 'member',
            checkInAt: '2099-06-03T08:00:00.000Z',
            checkOutAt: '2099-06-03T18:00:00.000Z',
            attendanceStatusCode: 'present',
            contributionPoints: 2.0,
          },
        ],
      });
    const approvedSheet3Id = approvedSheet3Res.body.data.id as string;

    // ============ Approve 1/2/3 全部到 approved 终态 ============
    // PR9:终审换第二 SUPER_ADMIN(自审/同人约束;fixture 语义不变 —— 单据到 approved 终态)
    for (const sid of [approvedSheet1Id, approvedSheet2Id, approvedSheet3Id]) {
      await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${sid}/approve`)
        .set('Authorization', superAdminAuth)
        .send({});
      await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${sid}/final-approve`)
        .set('Authorization', finalReviewerAuth)
        .send({});
    }

    // 抓取 approved record ids 供 case 7 record 软删使用
    const recsActivity1 = await prisma.attendanceRecord.findMany({
      where: { sheetId: approvedSheet1Id, memberId: memberAId, deletedAt: null },
      orderBy: { checkInAt: 'asc' },
      select: { id: true, checkInAt: true },
    });
    // checkInAt 升序 → 顺序为 record1(08:00), record5(11:00 — 之后软删), record2(14:00)
    approvedRecord1Id = recsActivity1[0].id;
    approvedRecord5Id = recsActivity1[1].id;
    approvedRecord2Id = recsActivity1[2].id;
    const recsActivity2A = await prisma.attendanceRecord.findFirst({
      where: { sheetId: approvedSheet2Id, memberId: memberAId, deletedAt: null },
      select: { id: true },
    });
    approvedRecord3Id = recsActivity2A!.id;
    const recsActivity3 = await prisma.attendanceRecord.findFirst({
      where: { sheetId: approvedSheet3Id, memberId: memberAId, deletedAt: null },
      select: { id: true },
    });
    approvedRecord4Id = recsActivity3!.id;
    const recsActivity2B = await prisma.attendanceRecord.findFirst({
      where: { sheetId: approvedSheet2Id, memberId: memberBId, deletedAt: null },
      select: { id: true },
    });
    memberBApprovedRecordId = recsActivity2B!.id;

    // ============ Non-approved sheets(应不返)============
    // pending sheet(memberA)
    const pendingRes = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activity1Id}/attendance-sheets`)
      .set('Authorization', superAdminAuth)
      .send({
        records: [
          {
            memberId: memberAId,
            roleCode: 'member',
            checkInAt: '2099-06-01T06:00:00.000Z',
            checkOutAt: '2099-06-01T07:00:00.000Z',
            attendanceStatusCode: 'present',
            contributionPoints: 1.0,
          },
        ],
      });
    pendingSheetId = pendingRes.body.data.id as string;

    // rejected(一级)sheet
    const rejRes = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activity1Id}/attendance-sheets`)
      .set('Authorization', superAdminAuth)
      .send({
        records: [
          {
            memberId: memberAId,
            roleCode: 'member',
            checkInAt: '2099-06-01T07:00:00.000Z',
            checkOutAt: '2099-06-01T08:00:00.000Z',
            attendanceStatusCode: 'present',
            contributionPoints: 1.0,
          },
        ],
      });
    rejectedSheetId = rejRes.body.data.id as string;
    await request(httpServer(app))
      .patch(`/api/admin/v1/attendance-sheets/${rejectedSheetId}/reject`)
      .set('Authorization', superAdminAuth)
      .send({ reviewNote: 'rejected for test' });

    // pending_final_review sheet(只 approve 一级,不 final-approve)
    const pfRes = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activity1Id}/attendance-sheets`)
      .set('Authorization', superAdminAuth)
      .send({
        records: [
          {
            memberId: memberAId,
            roleCode: 'member',
            checkInAt: '2099-06-01T10:00:00.000Z',
            checkOutAt: '2099-06-01T11:00:00.000Z',
            attendanceStatusCode: 'present',
            contributionPoints: 1.0,
          },
        ],
      });
    pendingFinalReviewSheetId = pfRes.body.data.id as string;
    await request(httpServer(app))
      .patch(`/api/admin/v1/attendance-sheets/${pendingFinalReviewSheetId}/approve`)
      .set('Authorization', superAdminAuth)
      .send({});

    // final_rejected sheet(一级 approve,终审 reject)
    const frRes = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activity1Id}/attendance-sheets`)
      .set('Authorization', superAdminAuth)
      .send({
        records: [
          {
            memberId: memberAId,
            roleCode: 'member',
            checkInAt: '2099-06-01T13:00:00.000Z',
            checkOutAt: '2099-06-01T14:00:00.000Z',
            attendanceStatusCode: 'present',
            contributionPoints: 1.0,
          },
        ],
      });
    finalRejectedSheetId = frRes.body.data.id as string;
    await request(httpServer(app))
      .patch(`/api/admin/v1/attendance-sheets/${finalRejectedSheetId}/approve`)
      .set('Authorization', superAdminAuth)
      .send({});
    await request(httpServer(app))
      .patch(`/api/admin/v1/attendance-sheets/${finalRejectedSheetId}/final-reject`)
      .set('Authorization', superAdminAuth)
      .send({ finalReviewNote: 'final rejected for test' });

    // ============ approved 后 sheet 软删(用 prisma 直写,模拟意外软删场景 — Sheet 模型 onDelete 不影响 records;
    // service 通过 sheet.deletedAt=null 过滤,本测验证此过滤生效)============
    const softRes = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activity1Id}/attendance-sheets`)
      .set('Authorization', superAdminAuth)
      .send({
        records: [
          {
            memberId: memberAId,
            roleCode: 'member',
            checkInAt: '2099-06-01T18:00:00.000Z',
            checkOutAt: '2099-06-01T19:00:00.000Z',
            attendanceStatusCode: 'present',
            contributionPoints: 1.5,
          },
        ],
      });
    softDeletedSheetId = softRes.body.data.id as string;
    await request(httpServer(app))
      .patch(`/api/admin/v1/attendance-sheets/${softDeletedSheetId}/approve`)
      .set('Authorization', superAdminAuth)
      .send({});
    await request(httpServer(app))
      .patch(`/api/admin/v1/attendance-sheets/${softDeletedSheetId}/final-approve`)
      .set('Authorization', superAdminAuth)
      .send({});
    // 直接软删 sheet(模拟运维误操作 / 业务侧未提供 admin 接口)
    await prisma.attendanceSheet.update({
      where: { id: softDeletedSheetId },
      data: { deletedAt: new Date() },
    });

    // ============ Record 软删(approvedRecord5Id)============
    await prisma.attendanceRecord.update({
      where: { id: approvedRecord5Id },
      data: { deletedAt: new Date() },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ Test class 1: 字段集恰好 14 + 无 sensitive ============

  describe('字段集 / sensitive 字段', () => {
    it('200 + Object.keys === 14 + 字段名集合恰好等于 §5.1 表', async () => {
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records')
        .set('Authorization', userAAuth);
      expect(res.status).toBe(200);
      const body = res.body as ResBody;
      expect(body.code).toBe(0);
      const items = body.data.items as Array<Record<string, unknown>>;
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(Object.keys(item).sort()).toEqual(APP_MY_ATT_KEYS);
        expect(Object.keys(item).length).toBe(14);
      }
    });

    it('不含 sheetId / memberId / member / registrationId / updatedAt / passwordHash 等', async () => {
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records')
        .set('Authorization', userAAuth);
      const items = (res.body as ResBody).data.items as Array<Record<string, unknown>>;
      for (const item of items) {
        for (const key of FORBIDDEN_KEYS) {
          expect(item).not.toHaveProperty(key);
        }
      }
    });
  });

  // ============ Test class 2: 派生 activity* 字段 ============

  describe('派生 activity* 字段', () => {
    it('activityTitle / activityStartAt / activityEndAt / activityCoverImageUrl 来自 Activity', async () => {
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records?activityId=' + activity1Id)
        .set('Authorization', userAAuth);
      const items = (res.body as ResBody).data.items as Array<Record<string, unknown>>;
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.activityId).toBe(activity1Id);
        expect(item.activityTitle).toBe('P26 Activity 1');
        expect(item.activityStartAt).toBe('2099-06-01T08:00:00.000Z');
        expect(item.activityEndAt).toBe('2099-06-01T18:00:00.000Z');
        expect(item.activityCoverImageUrl).toBe('https://example.com/cover-1.png');
      }
    });

    it('coverImageUrl 可 null(activity2 未设 cover)', async () => {
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records?activityId=' + activity2Id)
        .set('Authorization', userAAuth);
      const items = (res.body as ResBody).data.items as Array<Record<string, unknown>>;
      expect(items.length).toBe(1);
      expect(items[0].activityCoverImageUrl).toBeNull();
    });
  });

  // ============ Test class 3: 仅 approved sheet ============

  describe('仅 approved sheet', () => {
    it('memberA 列表中 record id 集合仅含 approved sheet 的 records', async () => {
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records?pageSize=100')
        .set('Authorization', userAAuth);
      const items = (res.body as ResBody).data.items as Array<Record<string, unknown>>;
      const recordIds = items.map((i) => i.id);
      expect(recordIds).toEqual(
        expect.arrayContaining([
          approvedRecord1Id,
          approvedRecord2Id,
          approvedRecord3Id,
          approvedRecord4Id,
        ]),
      );
      // 软删过滤(record5 已软删)
      expect(recordIds).not.toContain(approvedRecord5Id);
    });

    it('pending sheet 的 records 不返', async () => {
      const pendingRecords = await prisma.attendanceRecord.findMany({
        where: { sheetId: pendingSheetId, deletedAt: null },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records?pageSize=100')
        .set('Authorization', userAAuth);
      const ids = ((res.body as ResBody).data.items as Array<Record<string, unknown>>).map(
        (i) => i.id,
      );
      for (const r of pendingRecords) expect(ids).not.toContain(r.id);
    });

    it('rejected(一级)/ pending_final_review / final_rejected sheet 的 records 不返', async () => {
      const otherRecords = await prisma.attendanceRecord.findMany({
        where: {
          sheetId: { in: [rejectedSheetId, pendingFinalReviewSheetId, finalRejectedSheetId] },
          deletedAt: null,
        },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records?pageSize=100')
        .set('Authorization', userAAuth);
      const ids = ((res.body as ResBody).data.items as Array<Record<string, unknown>>).map(
        (i) => i.id,
      );
      for (const r of otherRecords) expect(ids).not.toContain(r.id);
    });
  });

  // ============ Test class 4: 软删 record / sheet 过滤 ============

  describe('软删过滤', () => {
    it('approved sheet 但 sheet.deletedAt!=null → 整 sheet records 不返', async () => {
      const softRecords = await prisma.attendanceRecord.findMany({
        where: { sheetId: softDeletedSheetId, deletedAt: null },
        select: { id: true },
      });
      expect(softRecords.length).toBe(1); // sanity: record 本身没软删
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records?pageSize=100')
        .set('Authorization', userAAuth);
      const ids = ((res.body as ResBody).data.items as Array<Record<string, unknown>>).map(
        (i) => i.id,
      );
      for (const r of softRecords) expect(ids).not.toContain(r.id);
    });

    it('record.deletedAt!=null → 该 record 不返(sheet 仍 approved)', async () => {
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records?pageSize=100')
        .set('Authorization', userAAuth);
      const ids = ((res.body as ResBody).data.items as Array<Record<string, unknown>>).map(
        (i) => i.id,
      );
      expect(ids).not.toContain(approvedRecord5Id);
    });
  });

  // ============ Test class 5: ?activityId= filter ============

  describe('activityId filter', () => {
    it('?activityId=activity1Id 仅返该活动 records', async () => {
      const res = await request(httpServer(app))
        .get(`/api/app/v1/my/attendance-records?activityId=${activity1Id}&pageSize=100`)
        .set('Authorization', userAAuth);
      const items = (res.body as ResBody).data.items as Array<Record<string, unknown>>;
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) expect(item.activityId).toBe(activity1Id);
    });

    it('?activityId=不存在 → items=[] / total=0', async () => {
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records?activityId=ckxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
        .set('Authorization', userAAuth);
      expect(res.status).toBe(200);
      const data = (res.body as ResBody).data;
      expect(data.items).toEqual([]);
      expect(data.total).toBe(0);
    });
  });

  // ============ Test class 6: query 边界 ============

  describe('query 边界', () => {
    it('pageSize=101 → 400', async () => {
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records?pageSize=101')
        .set('Authorization', userAAuth);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('page=0 → 400', async () => {
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records?page=0')
        .set('Authorization', userAAuth);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('未声明 query 字段(?sheetId=...) → 400(forbidNonWhitelisted)', async () => {
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records?sheetId=xxx')
        .set('Authorization', userAAuth);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('未声明 query 字段(?memberId=...) → 400(forbidNonWhitelisted)', async () => {
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records?memberId=xxx')
        .set('Authorization', userAAuth);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });

  // ============ Test class 7: scope-self ============

  describe('scope-self', () => {
    it('USER A 不能看到 USER B 的 records(memberBApprovedRecord 不出现在 A 列表)', async () => {
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records?pageSize=100')
        .set('Authorization', userAAuth);
      const ids = ((res.body as ResBody).data.items as Array<Record<string, unknown>>).map(
        (i) => i.id,
      );
      expect(ids).not.toContain(memberBApprovedRecordId);
    });

    it('USER B 列表仅含本人 record', async () => {
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records?pageSize=100')
        .set('Authorization', userBAuth);
      const ids = ((res.body as ResBody).data.items as Array<Record<string, unknown>>).map(
        (i) => i.id,
      );
      expect(ids).toEqual([memberBApprovedRecordId]);
    });
  });

  // ============ Test class 8: admin-as-member ============

  describe('admin-as-member', () => {
    it('ADMIN(linked member ACTIVE)走 self perspective:只看到本人 memberAdmin 的 records', async () => {
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records?pageSize=100')
        .set('Authorization', adminWithMemberAuth);
      expect(res.status).toBe(200);
      const items = (res.body as ResBody).data.items as Array<Record<string, unknown>>;
      // memberAdmin 没造 approved record → empty
      expect(items).toEqual([]);
    });

    it('ADMIN 不因 role 看到 memberA / memberB 的 records', async () => {
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records?pageSize=100')
        .set('Authorization', adminWithMemberAuth);
      const ids = ((res.body as ResBody).data.items as Array<Record<string, unknown>>).map(
        (i) => i.id,
      );
      expect(ids).not.toContain(approvedRecord1Id);
      expect(ids).not.toContain(memberBApprovedRecordId);
    });
  });

  // ============ Test class 9: admin-without-member / Member.INACTIVE / Member 软删 ============

  describe('canUseApp=false → 403 FORBIDDEN(不沿 D-P2-3-1 例外)', () => {
    it('admin-without-member → 403', async () => {
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records')
        .set('Authorization', adminNoMemAuth);
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER + no member → 403', async () => {
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records')
        .set('Authorization', userNoMemAuth);
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER + Member.INACTIVE → 403', async () => {
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records')
        .set('Authorization', userInactiveMemAuth);
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER + Member 软删 → 403', async () => {
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records')
        .set('Authorization', userDeletedMemAuth);
      expectBizError(res, BizCode.FORBIDDEN);
    });
  });

  // ============ Test class 10: User.DISABLED → 401(JwtStrategy) ============

  describe('User.DISABLED → 401', () => {
    it('用户被禁用后,旧 access token 调用应返 401', async () => {
      // 直接通过 prisma 禁用 user(模拟管理员操作)
      await prisma.user.update({
        where: { username: 'p26-user-b' },
        data: { status: UserStatus.DISABLED },
      });
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records')
        .set('Authorization', userBAuth);
      expectBizError(res, BizCode.UNAUTHORIZED);

      // 还原
      await prisma.user.update({
        where: { username: 'p26-user-b' },
        data: { status: UserStatus.ACTIVE },
      });
    });
  });

  // ============ Test class 11: empty-list + 分页 + 排序 ============

  describe('empty-list / 分页 / 排序', () => {
    it('memberAdmin 无 approved record → items=[] / total=0', async () => {
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records?pageSize=100')
        .set('Authorization', adminWithMemberAuth);
      expect(res.status).toBe(200);
      const data = (res.body as ResBody).data;
      expect(data.items).toEqual([]);
      expect(data.total).toBe(0);
    });

    it('分页:pageSize=1 + page=1 / page=2 边界正确', async () => {
      const page1 = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records?pageSize=1&page=1')
        .set('Authorization', userAAuth);
      const page2 = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records?pageSize=1&page=2')
        .set('Authorization', userAAuth);
      expect(page1.status).toBe(200);
      expect(page2.status).toBe(200);
      const d1 = (page1.body as ResBody).data;
      const d2 = (page2.body as ResBody).data;
      expect(d1.page).toBe(1);
      expect(d2.page).toBe(2);
      expect(d1.pageSize).toBe(1);
      expect(d2.pageSize).toBe(1);
      expect(d1.total).toBe(d2.total);
      expect((d1.items as Array<unknown>).length).toBe(1);
      expect((d2.items as Array<unknown>).length).toBe(1);
      // 不同页 record id 不同
      const id1 = (d1.items as Array<{ id: string }>)[0].id;
      const id2 = (d2.items as Array<{ id: string }>)[0].id;
      expect(id1).not.toBe(id2);
    });

    it('排序:orderBy checkInAt desc — 第一条是 activity3(2099-06-03)', async () => {
      const res = await request(httpServer(app))
        .get('/api/app/v1/my/attendance-records?pageSize=100')
        .set('Authorization', userAAuth);
      const items = (res.body as ResBody).data.items as Array<Record<string, unknown>>;
      expect(items.length).toBeGreaterThanOrEqual(4);
      // checkInAt 单调降:活动 3(06-03)→ 活动 2(06-02)→ 活动 1 record2(14:00)→ activity1 record1(08:00)
      const checkIns = items.map((i) => new Date(i.checkInAt as string).getTime());
      for (let i = 1; i < checkIns.length; i += 1) {
        expect(checkIns[i - 1]).toBeGreaterThanOrEqual(checkIns[i]);
      }
    });
  });

  // ============ Test class 12: 未登录 → 401 ============

  describe('未登录', () => {
    it('GET /api/app/v1/my/attendance-records 不带 Authorization → 401', async () => {
      const res = await request(httpServer(app)).get('/api/app/v1/my/attendance-records');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });
  });
});
