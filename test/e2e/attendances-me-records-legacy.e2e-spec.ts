import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// P1-B characterization tests(第五单)— Legacy `GET /api/v2/users/me/attendance-records` 行为锁定。
//
// 目标:为 P1-C step 4 物理拆 `attendances.controller.ts` 同文件 3 个 `@Controller` class
// 之前,显式锁定 Mobile Legacy 端点(`AttendanceRecordsMeController.listMyRecords`)的现状行为。
//
// 沿 docs/api-surface-policy.md §5 项 2 + §6 项 6 + §7 P1-B(第五单)。
//
// 目标端点(`AttendanceRecordsMeController.listMyRecords`):
//   GET /api/v2/users/me/attendance-records
//   - Query DTO: `MyAttendanceRecordsQueryDto extends PaginationQueryDto + activityId?: string (Length 8-64)`
//   - Service: `AttendancesService.listMyRecords(query, currentUser)`
//     - resolveUserMemberIdOrThrow(currentUser.id) → memberId(无绑定 → MEMBER_NOT_FOUND)
//     - where = { memberId, sheet: { statusCode: 'approved', deletedAt: null }, deletedAt: null }
//     - orderBy checkInAt desc
//   - Response: `PageResultDto<AttendanceRecordResponseDto>`(legacy 直返 memberId / sheetId
//     等字段;与 App DTO `AppMyAttendanceRecordDto` 字段集不等价)
//   - Roles: `USER, ADMIN, SUPER_ADMIN`(`JwtAuthGuard` + `RolesGuard`,不进 RBAC.can())
//
// 与既有 spec 的关系(本文件**只补缺口**,不重复覆盖):
//   - test/e2e/attendances.e2e-spec.ts(2066 LOC)L1263-1393 已锁:USER 未绑 member /
//     仅 approved Sheet records / activityId 过滤 / 不返他人 / member 摘要嵌套字段
//   - test/e2e/app-my-attendance-records.e2e-spec.ts(955 LOC)已锁 App API
//     `/api/app/v1/my/attendance-records` 全部 25+ 场景(含字段集严格 14 项 / 不返 memberId
//     等 sensitive 字段 / scope-self / canUseApp=false 403)
//   - 本文件补的 5 个 P1-B 缺口:
//     1. **完全未带 Authorization 头 → 401**(既有 spec 在 attendances.e2e:374 已覆盖,
//        本 spec 重复以保 P1-B 完整;**用 expectBizError 显式断 BizCode**)
//     2. **跨用户隔离的显式 record-id 反向断言**(既有 spec 用 memberId 反向,本 spec
//        加 record-id 反查 + JSON 序列化字符串子串反查)
//     3. **Query validation**(`page=0` / `pageSize=0` / `pageSize=101` / `page=abc` 与
//        `activityId` Length 校验;既有 spec 未显式覆盖 PaginationQueryDto 边界)
//     4. **L3 凭证字段非泄漏**(`passwordHash` / `refreshToken` / `tokenHash` /
//        `secretKey*` / `secretId*` / `storageSecret`;legacy 端点既有 spec 未做)
//     5. **与 App API 形态对比 framing**(legacy DTO 直返 `sheetId` / `memberId`;
//        App DTO 不返这两字段,沿 P2-6 D-P2-6-15)
//
// **未覆盖**(沿 §7 P1-B 范围限制,只补缺口不重复):
//   - 完整状态机覆盖(pending / pending_final_review / rejected / final_rejected sheet
//     的 records 不返)已在既有 `attendances.e2e-spec.ts:1263-1393` 与
//     `app-my-attendance-records.e2e-spec.ts:632-712` 完整覆盖
//   - MEMBER_NOT_FOUND USER 未绑 member 路径已在 `attendances.e2e-spec.ts:1331` 覆盖

const L3_FORBIDDEN_FIELDS = [
  'passwordHash',
  'refreshToken',
  'tokenHash',
  'secretKey',
  'secretKeyEncrypted',
  'secretId',
  'secretIdEncrypted',
  'storageSecret',
] as const;

function assertNoL3FieldLeak(data: Record<string, unknown> | undefined | null): void {
  for (const f of L3_FORBIDDEN_FIELDS) {
    expect(data).not.toHaveProperty(f);
  }
}

describe('Legacy attendances/me attendance-records endpoint (P1-B characterization)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let userAAuth: string;
  let userBAuth: string;
  let memberAId: string;
  let memberBId: string;
  let activity1Id: string;
  let activity2Id: string;

  // userA 的 approved Sheet 内的 record ids(用于跨用户反向断言 + activityId 过滤)
  let approvedRecAct1Id: string;
  let approvedRecAct2Id: string;
  // userA 的非 approved Sheet 内的 record ids(应**不**出现在响应中)
  let pendingRecId: string;
  let rejectedRecId: string;
  // userB 的 approved Sheet 内的 record id(跨用户反向断言用)
  let userBRecId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    // 2 users
    await createTestUser(app, { username: 'p1batt-a', role: Role.USER });
    await createTestUser(app, { username: 'p1batt-b', role: Role.USER });

    // 2 members
    const ma = await prisma.member.create({
      data: { memberNo: 'p1b-att-m-a', displayName: 'Att Member A' },
      select: { id: true },
    });
    memberAId = ma.id;
    const mb = await prisma.member.create({
      data: { memberNo: 'p1b-att-m-b', displayName: 'Att Member B' },
      select: { id: true },
    });
    memberBId = mb.id;

    // 链接 user.memberId
    await prisma.user.update({ where: { username: 'p1batt-a' }, data: { memberId: memberAId } });
    await prisma.user.update({ where: { username: 'p1batt-b' }, data: { memberId: memberBId } });

    userAAuth = (await loginAs(app, 'p1batt-a')).authHeader;
    userBAuth = (await loginAs(app, 'p1batt-b')).authHeader;

    // 必要 dict + org(Activity.organizationId 是 FK)
    const nodeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'p1b-att-root', label: '根' },
    });
    const rootOrg = await prisma.organization.create({
      data: { name: 'P1B Att Root', nodeTypeCode: 'p1b-att-root', parentId: null },
      select: { id: true },
    });

    // 2 activities(同 user 不同 activity → activityId 过滤 + 分页测试)
    const act1 = await prisma.activity.create({
      data: {
        title: 'P1B Att Activity 1',
        activityTypeCode: 'p1b-att-type',
        organizationId: rootOrg.id,
        startAt: new Date('2026-06-01T08:00:00.000Z'),
        endAt: new Date('2026-06-01T12:00:00.000Z'),
        location: '演示地点 1',
        statusCode: 'completed',
        isPublicRegistration: true,
      },
      select: { id: true },
    });
    activity1Id = act1.id;
    const act2 = await prisma.activity.create({
      data: {
        title: 'P1B Att Activity 2',
        activityTypeCode: 'p1b-att-type',
        organizationId: rootOrg.id,
        startAt: new Date('2026-06-02T08:00:00.000Z'),
        endAt: new Date('2026-06-02T12:00:00.000Z'),
        location: '演示地点 2',
        statusCode: 'completed',
        isPublicRegistration: true,
      },
      select: { id: true },
    });
    activity2Id = act2.id;

    // 一次性查 userA / userB id,后续 sheet seed 复用(避免重复 await)
    const userARow = await prisma.user.findFirstOrThrow({
      where: { username: 'p1batt-a' },
      select: { id: true },
    });
    const userBRow = await prisma.user.findFirstOrThrow({
      where: { username: 'p1batt-b' },
      select: { id: true },
    });
    const userAId = userARow.id;
    const userBId = userBRow.id;

    // Sheet × 4 + Record × 5(prisma 直接 seed,绕过状态机)
    // userA approved sheet on act1 + 1 record
    const sheetApprAct1 = await prisma.attendanceSheet.create({
      data: {
        activityId: activity1Id,
        submitterUserId: userAId,
        statusCode: 'approved',
        version: 1,
      },
      select: { id: true },
    });
    const rec1 = await prisma.attendanceRecord.create({
      data: {
        sheetId: sheetApprAct1.id,
        memberId: memberAId,
        roleCode: 'p1b-att-role',
        checkInAt: new Date('2026-06-01T08:00:00.000Z'),
        checkOutAt: new Date('2026-06-01T12:00:00.000Z'),
        serviceHours: 4,
        attendanceStatusCode: 'normal',
        contributionPoints: 1,
      },
      select: { id: true },
    });
    approvedRecAct1Id = rec1.id;

    // userA approved sheet on act2 + 1 record
    const sheetApprAct2 = await prisma.attendanceSheet.create({
      data: {
        activityId: activity2Id,
        submitterUserId: userAId,
        statusCode: 'approved',
        version: 1,
      },
      select: { id: true },
    });
    const rec2 = await prisma.attendanceRecord.create({
      data: {
        sheetId: sheetApprAct2.id,
        memberId: memberAId,
        roleCode: 'p1b-att-role',
        checkInAt: new Date('2026-06-02T08:00:00.000Z'),
        checkOutAt: new Date('2026-06-02T12:00:00.000Z'),
        serviceHours: 4,
        attendanceStatusCode: 'normal',
        contributionPoints: 1,
      },
      select: { id: true },
    });
    approvedRecAct2Id = rec2.id;

    // userA pending sheet on act1 + 1 record(不应被列表返回)
    const sheetPending = await prisma.attendanceSheet.create({
      data: {
        activityId: activity1Id,
        submitterUserId: userAId,
        statusCode: 'pending',
        version: 1,
      },
      select: { id: true },
    });
    const recPending = await prisma.attendanceRecord.create({
      data: {
        sheetId: sheetPending.id,
        memberId: memberAId,
        roleCode: 'p1b-att-role',
        // 与 approved sheet1 不冲突(R16 时间不重叠校验):换不同日期
        checkInAt: new Date('2026-06-03T08:00:00.000Z'),
        checkOutAt: new Date('2026-06-03T12:00:00.000Z'),
        serviceHours: 4,
        attendanceStatusCode: 'normal',
        contributionPoints: 1,
      },
      select: { id: true },
    });
    pendingRecId = recPending.id;

    // userA rejected sheet on act1 + 1 record(不应被列表返回)
    const sheetRejected = await prisma.attendanceSheet.create({
      data: {
        activityId: activity1Id,
        submitterUserId: userAId,
        statusCode: 'rejected',
        version: 1,
      },
      select: { id: true },
    });
    const recRejected = await prisma.attendanceRecord.create({
      data: {
        sheetId: sheetRejected.id,
        memberId: memberAId,
        roleCode: 'p1b-att-role',
        checkInAt: new Date('2026-06-04T08:00:00.000Z'),
        checkOutAt: new Date('2026-06-04T12:00:00.000Z'),
        serviceHours: 4,
        attendanceStatusCode: 'normal',
        contributionPoints: 1,
      },
      select: { id: true },
    });
    rejectedRecId = recRejected.id;

    // userB approved sheet on act1 + 1 record(跨用户反向断言)
    const sheetUserB = await prisma.attendanceSheet.create({
      data: {
        activityId: activity1Id,
        submitterUserId: userBId,
        statusCode: 'approved',
        version: 1,
      },
      select: { id: true },
    });
    const recUserB = await prisma.attendanceRecord.create({
      data: {
        sheetId: sheetUserB.id,
        memberId: memberBId,
        roleCode: 'p1b-att-role',
        checkInAt: new Date('2026-06-01T08:00:00.000Z'),
        checkOutAt: new Date('2026-06-01T12:00:00.000Z'),
        serviceHours: 4,
        attendanceStatusCode: 'normal',
        contributionPoints: 1,
      },
      select: { id: true },
    });
    userBRecId = recUserB.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ A. 未登录 ============
  describe('A. 未登录 → UNAUTHORIZED', () => {
    it('GET /api/v2/users/me/attendance-records 无 header → 40100', async () => {
      const res = await request(httpServer(app)).get('/api/v2/users/me/attendance-records');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('GET /api/v2/users/me/attendance-records 错 Bearer → 40100', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/attendance-records')
        .set('Authorization', 'Bearer not-a-real-jwt');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });
  });

  // ============ B. 跨用户隔离(显式 record-id 反向断言) ============
  describe('B. memberId 自动过滤 → 跨用户隔离', () => {
    it('userA → 200,只见 userA 自己 approved Sheet 内的 2 条 records;**不见 userB 的 record**', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/attendance-records')
        .set('Authorization', userAAuth);

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.message).toBe('ok');
      expect(res.body.data.total).toBe(2);
      expect(res.body.data.items).toHaveLength(2);

      // 正向断言:每条 memberId === memberAId
      for (const item of res.body.data.items as Array<{ memberId: string }>) {
        expect(item.memberId).toBe(memberAId);
      }

      // 反向断言:record-id 反查 userB 的 record 不在列表
      const recIds = (res.body.data.items as Array<{ id: string }>).map((i) => i.id);
      expect(recIds).toEqual(expect.arrayContaining([approvedRecAct1Id, approvedRecAct2Id]));
      expect(recIds).not.toContain(userBRecId);

      // 序列化反向兜底:整体响应字符串不得包含 userB record id
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(userBRecId);
    });

    it('userB → 200,只见 userB 自己 approved Sheet 内的 1 条 record;**不见 userA 的 record**', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/attendance-records')
        .set('Authorization', userBAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].memberId).toBe(memberBId);
      expect(res.body.data.items[0].id).toBe(userBRecId);

      const recIds = (res.body.data.items as Array<{ id: string }>).map((i) => i.id);
      expect(recIds).not.toContain(approvedRecAct1Id);
      expect(recIds).not.toContain(approvedRecAct2Id);
    });
  });

  // ============ C. 仅 approved Sheet 内 records ============
  describe('C. Sheet status 过滤(仅 approved)', () => {
    it('userA → 不见 pending sheet 内 record', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/attendance-records')
        .set('Authorization', userAAuth);

      expect(res.status).toBe(200);
      const recIds = (res.body.data.items as Array<{ id: string }>).map((i) => i.id);
      expect(recIds).not.toContain(pendingRecId);
    });

    it('userA → 不见 rejected sheet 内 record', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/attendance-records')
        .set('Authorization', userAAuth);

      expect(res.status).toBe(200);
      const recIds = (res.body.data.items as Array<{ id: string }>).map((i) => i.id);
      expect(recIds).not.toContain(rejectedRecId);
    });
  });

  // ============ D. 分页 ============
  describe('D. 分页 page / pageSize / total / items', () => {
    it('默认参数 → 200,page=1,pageSize=20,userA total=2,items=2', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/attendance-records')
        .set('Authorization', userAAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.pageSize).toBe(20);
      expect(res.body.data.total).toBe(2);
      expect(res.body.data.items).toHaveLength(2);
    });

    it('pageSize=1 → 200,page=1 取 1 条,total=2', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/attendance-records?pageSize=1')
        .set('Authorization', userAAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.pageSize).toBe(1);
      expect(res.body.data.total).toBe(2);
      expect(res.body.data.items).toHaveLength(1);
    });

    it('page=2&pageSize=1 → 200,取剩余 1 条,total 稳定', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/attendance-records?page=2&pageSize=1')
        .set('Authorization', userAAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.page).toBe(2);
      expect(res.body.data.pageSize).toBe(1);
      expect(res.body.data.total).toBe(2);
      expect(res.body.data.items).toHaveLength(1);
    });
  });

  // ============ E. Query validation ============
  describe('E. Query validation(PaginationQueryDto Min/Max + activityId Length)', () => {
    it('page=0(< Min(1)) → BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/attendance-records?page=0')
        .set('Authorization', userAAuth);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('pageSize=0(< Min(1)) → BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/attendance-records?pageSize=0')
        .set('Authorization', userAAuth);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('pageSize=101(> Max(100)) → BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/attendance-records?pageSize=101')
        .set('Authorization', userAAuth);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('page=abc(非数字) → BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/attendance-records?page=abc')
        .set('Authorization', userAAuth);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('activityId 过短(<8) → BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/attendance-records?activityId=abc')
        .set('Authorization', userAAuth);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });

  // ============ F. activityId 过滤 ============
  describe('F. activityId 过滤', () => {
    it('指定 activity1 → 200,只返该 activity 下的 record', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/users/me/attendance-records?activityId=${activity1Id}`)
        .set('Authorization', userAAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].id).toBe(approvedRecAct1Id);
    });

    it('指定 activity2 → 200,只返该 activity 下的 record', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/users/me/attendance-records?activityId=${activity2Id}`)
        .set('Authorization', userAAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].id).toBe(approvedRecAct2Id);
    });
  });

  // ============ G. L3 凭证字段非泄漏 ============
  describe('G. response items 不得泄漏 L3 凭证字段', () => {
    it('每个 item 不含 passwordHash / refreshToken / tokenHash / secretKey* / secretId* / storageSecret', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/attendance-records')
        .set('Authorization', userAAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBeGreaterThan(0);
      for (const item of res.body.data.items as Array<Record<string, unknown>>) {
        assertNoL3FieldLeak(item);
        // 嵌套 member 摘要也做反向兜底
        if (item.member !== null && typeof item.member === 'object') {
          assertNoL3FieldLeak(item.member as Record<string, unknown>);
        }
      }

      // 序列化反向兜底:整体响应字符串不得包含任何 L3 字段名子串
      const serialized = JSON.stringify(res.body);
      for (const f of L3_FORBIDDEN_FIELDS) {
        expect(serialized).not.toContain(`"${f}"`);
      }
    });
  });

  // ============ H. P1-B framing:Legacy ≠ App API alias ============
  describe('H. P1-B framing:Legacy `/v2/users/me/attendance-records` 非 App API alias', () => {
    it('legacy 端点存在且返回 AttendanceRecordResponseDto 形态(直返 sheetId / memberId 等 v2 admin-like 字段)', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/users/me/attendance-records')
        .set('Authorization', userAAuth);

      expect(res.status).toBe(200);
      // legacy 端点直返 AttendanceRecordResponseDto:
      // 含 sheetId / memberId / member 嵌套(沿 attendances.dto.ts §L366);
      // App API `AppMyAttendanceRecordDto` **不返** sheetId 与 memberId(沿 P2-6 §5.1 + D-P2-6-15)
      const item = res.body.data.items[0];
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('sheetId'); // legacy 返,App API 不返
      expect(item).toHaveProperty('memberId'); // legacy 返,App API 不返
      expect(item).toHaveProperty('roleCode');
      expect(item).toHaveProperty('checkInAt');
      expect(item).toHaveProperty('checkOutAt');
      expect(item).toHaveProperty('serviceHours');
      expect(item).toHaveProperty('attendanceStatusCode');
    });
  });
});
