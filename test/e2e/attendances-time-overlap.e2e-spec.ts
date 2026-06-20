import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { AttendancesService } from '../../src/modules/attendances/attendances.service';
import type {
  AttendanceRecordInputDto,
  CreateAttendanceSheetDto,
  UpdateAttendanceSheetDto,
} from '../../src/modules/attendances/attendances.dto';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// attendances time-overlap characterization tests(R16 / Q-S15;TimeOverlapPolicy 抽离前置)。
//
// 目标:在抽 `TimeOverlapPolicy` 之前显式锁定 `attendances.service.ts` 两个时间重叠
// 私有校验方法的现状行为:
//   - assertNoInternalOverlap(records): 同 batch 内、按 memberId 隔离的 [start, end) 重叠
//   - assertNoTimeOverlap(memberId, checkInAt, checkOutAt, excludeSheetId, tx):
//     跨 Sheet / 跨 Activity 全局重叠;edit 路径透传 excludeSheetId 排除当前 Sheet 旧 records
//
// 两个方法均为 `private`,本 spec 通过公共入口 `AttendancesService.submit(...)` 与
// `AttendancesService.edit(...)` 间接驱动;失败路径断 `BizException.biz` ===
// `BizCode.ATTENDANCE_TIME_OVERLAP`,并从 DB 反查确认事务整体回滚(无 Sheet / Records 落库
// 或 edit 前状态保持)。
//
// 沿 `attendances-contribution-prefill.e2e-spec.ts` / `attendances-state-transition.e2e-spec.ts`
// 范式:
//   - createTestApp + resetDb + 真实 PrismaService(test database)
//   - service-level e2e:绕过 HTTP / Guard / RolesGuard,直接调 service 方法
//   - per-test `isolateFixtures()` 清 sheets / records / audit_logs(保留 user/member/org/dict)
//   - 跨 Sheet case 用预创 activityA / activityB(不需要每次重建;Activity completed 后仍允许 submit)
//   - 时间统一 UTC fixed 字面量,避免时区干扰
//
// 本 PR 范围:
//   ❌ 不改 attendances.service.ts
//   ❌ 不抽 TimeOverlapPolicy / StateMachine / AuditRecorder / ContributionCalculator
//   ❌ 不拆 controller / DTO / schema / migration / OpenAPI snapshot
//   ✅ 只新增本测试文件

const AUDIT_META: AuditMeta = {
  requestId: 'tovr-test-req-0000000000000001',
  ip: '127.0.0.1',
  ua: 'jest/30 attendances-time-overlap',
};

const ACTIVITY_TYPE_DEMO = 'tovr-demo';
const ROLE_MEMBER = 'member';
const ATTENDANCE_STATUS_PRESENT = 'present';

interface SeedContext {
  prisma: PrismaService;
  service: AttendancesService;
  submitterUserId: string;
  submitterPayload: CurrentUserPayload;
  memberAId: string;
  memberBId: string;
  organizationId: string;
  activityAId: string;
  activityBId: string;
}

describe('AttendancesService time overlap (characterization)', () => {
  let app: INestApplication;
  let ctx: SeedContext;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);

    const prisma = app.get(PrismaService);
    const service = app.get(AttendancesService);

    const submitter = await prisma.user.create({
      data: {
        username: 'att-tovr-submitter',
        passwordHash: '$2a$10$dummy-hash-not-used-no-login',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });

    // Slow-4 T3(评审稿 §8 / D-S4-6):本 spec 直调 service(绕过 Guard),判权已下沉
    // service 层 rbac.can();给 ADMIN 测试用户 submitter 补挂 biz-admin(零漂移:对应迁移前
    // @Roles(SUPER_ADMIN, ADMIN) 放行语义;断言零修改)。
    const bizSeed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, submitter.id, bizSeed.bizAdminRoleId);

    const memberA = await prisma.member.create({
      data: { memberNo: 'att-tovr-m-a', displayName: 'TOVR Member A' },
      select: { id: true },
    });
    const memberB = await prisma.member.create({
      data: { memberNo: 'att-tovr-m-b', displayName: 'TOVR Member B' },
      select: { id: true },
    });

    // node_type dict + root org(Activity.organizationId FK,沿 Restrict)
    const nodeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'tovr-root', label: '根' },
    });
    const rootOrg = await prisma.organization.create({
      data: { name: 'TOVR Root Org', nodeTypeCode: 'tovr-root', parentId: null },
      select: { id: true },
    });

    // activity_type 字典(activityTypeCode 是字符串,不做 FK 校验;dict 项仅用作语义记录)
    const actTypeDict = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: actTypeDict.id, code: ACTIVITY_TYPE_DEMO, label: 'demo' },
    });

    // attendance_role 字典(1 项:member 即可覆盖全部 case)
    const roleDict = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: roleDict.id, code: ROLE_MEMBER, label: 'member' },
    });

    // attendance_status 字典(1 项:present)
    const statDict = await prisma.dictType.create({
      data: { code: 'attendance_status', label: '考勤状态' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: statDict.id, code: ATTENDANCE_STATUS_PRESENT, label: 'present' },
    });

    // 预创 2 个 Activity(published):
    // - activityA / activityB 跨 Sheet case 共用;Activity 在首次 submit 后会从 published 推到
    //   completed(沿 D11),但 completed Activity 不被 submit 拒绝(只有 cancelled 拒),
    //   因此整套 spec 复用同一对 Activity 不会出问题。
    const activityA = await prisma.activity.create({
      data: {
        title: 'TOVR Activity A',
        activityTypeCode: ACTIVITY_TYPE_DEMO,
        organizationId: rootOrg.id,
        startAt: new Date('2026-01-01T00:00:00.000Z'),
        endAt: new Date('2026-01-01T23:59:59.000Z'),
        location: 'tovr',
        statusCode: 'published',
        isPublicRegistration: true,
      },
      select: { id: true },
    });
    const activityB = await prisma.activity.create({
      data: {
        title: 'TOVR Activity B',
        activityTypeCode: ACTIVITY_TYPE_DEMO,
        organizationId: rootOrg.id,
        startAt: new Date('2026-01-01T00:00:00.000Z'),
        endAt: new Date('2026-01-01T23:59:59.000Z'),
        location: 'tovr',
        statusCode: 'published',
        isPublicRegistration: true,
      },
      select: { id: true },
    });

    ctx = {
      prisma,
      service,
      submitterUserId: submitter.id,
      submitterPayload: {
        id: submitter.id,
        username: 'att-tovr-submitter',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
        memberId: null,
      },
      memberAId: memberA.id,
      memberBId: memberB.id,
      organizationId: rootOrg.id,
      activityAId: activityA.id,
      activityBId: activityB.id,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  // 每个 case 清:records → sheets → audit_logs;
  // 保留:user / member / org / dict / activity(共享 seed,Activity 可能为 completed,不影响后续 submit)。
  async function isolateFixtures(): Promise<void> {
    await ctx.prisma.attendanceRecord.deleteMany({});
    await ctx.prisma.attendanceSheet.deleteMany({});
    await ctx.prisma.auditLog.deleteMany({});
  }

  // ============ helpers ============

  interface RecordSeed {
    memberId: string;
    checkInAt: string;
    checkOutAt: string;
  }

  function buildRecord(seed: RecordSeed): AttendanceRecordInputDto {
    return {
      memberId: seed.memberId,
      roleCode: ROLE_MEMBER,
      checkInAt: seed.checkInAt,
      checkOutAt: seed.checkOutAt,
      attendanceStatusCode: ATTENDANCE_STATUS_PRESENT,
    };
  }

  async function submitSheet(activityId: string, records: RecordSeed[]): Promise<string> {
    const dto: CreateAttendanceSheetDto = { records: records.map(buildRecord) };
    const result = await ctx.service.submit(activityId, dto, ctx.submitterPayload, AUDIT_META);
    return result.id;
  }

  async function editSheet(
    sheetId: string,
    records: RecordSeed[],
  ): Promise<{ id: string; version: number }> {
    const dto: UpdateAttendanceSheetDto = { records: records.map(buildRecord) };
    const result = await ctx.service.edit(sheetId, dto, ctx.submitterPayload, AUDIT_META);
    return { id: result.id, version: result.version };
  }

  async function countActiveRecordsForSheet(sheetId: string): Promise<number> {
    return ctx.prisma.attendanceRecord.count({ where: { sheetId, deletedAt: null } });
  }

  async function getSheetVersion(sheetId: string): Promise<number> {
    const s = await ctx.prisma.attendanceSheet.findUniqueOrThrow({
      where: { id: sheetId },
      select: { version: true },
    });
    return s.version;
  }

  // ============ A. submit 内部重叠(assertNoInternalOverlap)============

  describe('A. submit internal overlap(同 batch + 同 memberId)', () => {
    beforeEach(isolateFixtures);

    it('Case 1:完全重叠 → 抛 ATTENDANCE_TIME_OVERLAP + DB 不创建 Sheet / Records', async () => {
      await expect(
        submitSheet(ctx.activityAId, [
          {
            memberId: ctx.memberAId,
            checkInAt: '2026-01-02T10:00:00.000Z',
            checkOutAt: '2026-01-02T12:00:00.000Z',
          },
          {
            memberId: ctx.memberAId,
            checkInAt: '2026-01-02T10:00:00.000Z',
            checkOutAt: '2026-01-02T12:00:00.000Z',
          },
        ]),
      ).rejects.toMatchObject({ biz: BizCode.ATTENDANCE_TIME_OVERLAP });

      // 事务整体回滚:无 Sheet / Records 落库
      expect(await ctx.prisma.attendanceSheet.count()).toBe(0);
      expect(await ctx.prisma.attendanceRecord.count()).toBe(0);
    });

    it('Case 2:部分重叠 → 抛 ATTENDANCE_TIME_OVERLAP + DB 不创建 Sheet / Records', async () => {
      await expect(
        submitSheet(ctx.activityAId, [
          {
            memberId: ctx.memberAId,
            checkInAt: '2026-01-02T10:00:00.000Z',
            checkOutAt: '2026-01-02T12:00:00.000Z',
          },
          {
            memberId: ctx.memberAId,
            checkInAt: '2026-01-02T11:00:00.000Z',
            checkOutAt: '2026-01-02T13:00:00.000Z',
          },
        ]),
      ).rejects.toMatchObject({ biz: BizCode.ATTENDANCE_TIME_OVERLAP });

      expect(await ctx.prisma.attendanceSheet.count()).toBe(0);
      expect(await ctx.prisma.attendanceRecord.count()).toBe(0);
    });

    it('Case 3:左闭右开边界(A.checkOut === B.checkIn)→ 允许;Sheet + 2 records 落库', async () => {
      const sheetId = await submitSheet(ctx.activityAId, [
        {
          memberId: ctx.memberAId,
          checkInAt: '2026-01-02T10:00:00.000Z',
          checkOutAt: '2026-01-02T12:00:00.000Z',
        },
        {
          memberId: ctx.memberAId,
          checkInAt: '2026-01-02T12:00:00.000Z',
          checkOutAt: '2026-01-02T14:00:00.000Z',
        },
      ]);

      expect(sheetId).toBeTruthy();
      expect(await countActiveRecordsForSheet(sheetId)).toBe(2);
    });

    it('Case 9:同 batch 不同 member 时段重叠 → 允许(internal overlap 按 memberId 隔离)', async () => {
      const sheetId = await submitSheet(ctx.activityAId, [
        {
          memberId: ctx.memberAId,
          checkInAt: '2026-01-02T10:00:00.000Z',
          checkOutAt: '2026-01-02T12:00:00.000Z',
        },
        {
          memberId: ctx.memberBId,
          checkInAt: '2026-01-02T10:00:00.000Z',
          checkOutAt: '2026-01-02T12:00:00.000Z',
        },
      ]);

      expect(sheetId).toBeTruthy();
      expect(await countActiveRecordsForSheet(sheetId)).toBe(2);
    });
  });

  // ============ B. submit 跨 Sheet 重叠(assertNoTimeOverlap;excludeSheetId === undefined)============

  describe('B. submit cross-sheet overlap(跨 Activity / 跨 Sheet 全局)', () => {
    beforeEach(isolateFixtures);

    it('Case 4:跨 Sheet 同 member 重叠 → 第二次 submit 抛 ATTENDANCE_TIME_OVERLAP + 不创建 Sheet B', async () => {
      // Sheet A 在 activityA(10:00-12:00)
      const sheetAId = await submitSheet(ctx.activityAId, [
        {
          memberId: ctx.memberAId,
          checkInAt: '2026-01-03T10:00:00.000Z',
          checkOutAt: '2026-01-03T12:00:00.000Z',
        },
      ]);
      expect(await countActiveRecordsForSheet(sheetAId)).toBe(1);

      // Sheet B 用 activityB(跨 Activity);同 memberA、11:00-13:00 与 Sheet A 重叠
      await expect(
        submitSheet(ctx.activityBId, [
          {
            memberId: ctx.memberAId,
            checkInAt: '2026-01-03T11:00:00.000Z',
            checkOutAt: '2026-01-03T13:00:00.000Z',
          },
        ]),
      ).rejects.toMatchObject({ biz: BizCode.ATTENDANCE_TIME_OVERLAP });

      // Sheet A 不受影响;无新增 Sheet
      expect(await ctx.prisma.attendanceSheet.count()).toBe(1);
      expect(await countActiveRecordsForSheet(sheetAId)).toBe(1);
    });

    it('Case 5:跨 Sheet 不同 member 时段重叠 → 第二次 submit 允许(校验按 memberId 隔离)', async () => {
      const sheetAId = await submitSheet(ctx.activityAId, [
        {
          memberId: ctx.memberAId,
          checkInAt: '2026-01-03T10:00:00.000Z',
          checkOutAt: '2026-01-03T12:00:00.000Z',
        },
      ]);
      expect(await countActiveRecordsForSheet(sheetAId)).toBe(1);

      const sheetBId = await submitSheet(ctx.activityBId, [
        {
          memberId: ctx.memberBId,
          checkInAt: '2026-01-03T11:00:00.000Z',
          checkOutAt: '2026-01-03T13:00:00.000Z',
        },
      ]);

      expect(sheetBId).toBeTruthy();
      expect(sheetBId).not.toBe(sheetAId);
      expect(await ctx.prisma.attendanceSheet.count()).toBe(2);
      expect(await countActiveRecordsForSheet(sheetBId)).toBe(1);
    });
  });

  // ============ C. edit 重叠(assertNoTimeOverlap;excludeSheetId === sheetId)============

  describe('C. edit overlap(excludeSheetId 透传当前 Sheet)', () => {
    beforeEach(isolateFixtures);

    it('Case 6:edit 自身 Sheet 时间错位重叠 → 允许(excludeSheetId 排除当前 Sheet 旧 records)', async () => {
      // 旧 records:memberA 10:00-12:00
      const sheetId = await submitSheet(ctx.activityAId, [
        {
          memberId: ctx.memberAId,
          checkInAt: '2026-01-04T10:00:00.000Z',
          checkOutAt: '2026-01-04T12:00:00.000Z',
        },
      ]);
      expect(await getSheetVersion(sheetId)).toBe(1);

      // 新 records:memberA 10:30-12:30(与旧 records 重叠,但 excludeSheetId 排除自身 → 应允许)
      const edited = await editSheet(sheetId, [
        {
          memberId: ctx.memberAId,
          checkInAt: '2026-01-04T10:30:00.000Z',
          checkOutAt: '2026-01-04T12:30:00.000Z',
        },
      ]);

      // version+1
      expect(edited.version).toBe(2);

      // 旧 records 软删 + 新 records 创建
      const allRecords = await ctx.prisma.attendanceRecord.findMany({
        where: { sheetId },
        select: { checkInAt: true, checkOutAt: true, deletedAt: true },
        orderBy: { createdAt: 'asc' },
      });
      expect(allRecords).toHaveLength(2);
      // 旧 records(10:00 / 12:00):deletedAt 非空
      const oldRec = allRecords.find(
        (r) => r.checkInAt.toISOString() === '2026-01-04T10:00:00.000Z',
      );
      expect(oldRec).toBeDefined();
      expect(oldRec!.deletedAt).not.toBeNull();
      // 新 records(10:30 / 12:30):deletedAt 为空
      const newRec = allRecords.find(
        (r) => r.checkInAt.toISOString() === '2026-01-04T10:30:00.000Z',
      );
      expect(newRec).toBeDefined();
      expect(newRec!.deletedAt).toBeNull();
    });

    it('Case 7:edit 与其它 Sheet 重叠 → 抛 ATTENDANCE_TIME_OVERLAP;Sheet B 原 records / version 不变', async () => {
      // Sheet A:memberA 10:00-12:00(永久占位,Case 7 用)
      const sheetAId = await submitSheet(ctx.activityAId, [
        {
          memberId: ctx.memberAId,
          checkInAt: '2026-01-05T10:00:00.000Z',
          checkOutAt: '2026-01-05T12:00:00.000Z',
        },
      ]);
      // Sheet B:memberA 13:00-15:00(与 Sheet A 不重叠,允许)
      const sheetBId = await submitSheet(ctx.activityBId, [
        {
          memberId: ctx.memberAId,
          checkInAt: '2026-01-05T13:00:00.000Z',
          checkOutAt: '2026-01-05T15:00:00.000Z',
        },
      ]);
      expect(await getSheetVersion(sheetBId)).toBe(1);

      // 尝试 edit Sheet B 到 11:00-14:00,与 Sheet A 的 10:00-12:00 重叠
      await expect(
        editSheet(sheetBId, [
          {
            memberId: ctx.memberAId,
            checkInAt: '2026-01-05T11:00:00.000Z',
            checkOutAt: '2026-01-05T14:00:00.000Z',
          },
        ]),
      ).rejects.toMatchObject({ biz: BizCode.ATTENDANCE_TIME_OVERLAP });

      // Sheet B version 不变(事务整体回滚)
      expect(await getSheetVersion(sheetBId)).toBe(1);

      // Sheet B 原 records 仍存活、内容不变
      const sheetBRecords = await ctx.prisma.attendanceRecord.findMany({
        where: { sheetId: sheetBId },
        select: { checkInAt: true, checkOutAt: true, deletedAt: true },
      });
      expect(sheetBRecords).toHaveLength(1);
      expect(sheetBRecords[0].deletedAt).toBeNull();
      expect(sheetBRecords[0].checkInAt.toISOString()).toBe('2026-01-05T13:00:00.000Z');
      expect(sheetBRecords[0].checkOutAt.toISOString()).toBe('2026-01-05T15:00:00.000Z');

      // Sheet A 不受影响
      expect(await countActiveRecordsForSheet(sheetAId)).toBe(1);
    });

    it('Case 8:edit 入参 records 内部重叠 → 抛 ATTENDANCE_TIME_OVERLAP;旧 records / version 不变', async () => {
      // Sheet A:memberA 08:00-09:00
      const sheetId = await submitSheet(ctx.activityAId, [
        {
          memberId: ctx.memberAId,
          checkInAt: '2026-01-06T08:00:00.000Z',
          checkOutAt: '2026-01-06T09:00:00.000Z',
        },
      ]);
      expect(await getSheetVersion(sheetId)).toBe(1);

      // 入参两条 records 同 memberA、10:00-12:00 与 11:00-13:00 → 内部重叠
      await expect(
        editSheet(sheetId, [
          {
            memberId: ctx.memberAId,
            checkInAt: '2026-01-06T10:00:00.000Z',
            checkOutAt: '2026-01-06T12:00:00.000Z',
          },
          {
            memberId: ctx.memberAId,
            checkInAt: '2026-01-06T11:00:00.000Z',
            checkOutAt: '2026-01-06T13:00:00.000Z',
          },
        ]),
      ).rejects.toMatchObject({ biz: BizCode.ATTENDANCE_TIME_OVERLAP });

      // Sheet version 不变
      expect(await getSheetVersion(sheetId)).toBe(1);

      // 旧 record(08:00-09:00)仍存活、未被软删;无新 records 入库
      const records = await ctx.prisma.attendanceRecord.findMany({
        where: { sheetId },
        select: { checkInAt: true, checkOutAt: true, deletedAt: true },
      });
      expect(records).toHaveLength(1);
      expect(records[0].deletedAt).toBeNull();
      expect(records[0].checkInAt.toISOString()).toBe('2026-01-06T08:00:00.000Z');
      expect(records[0].checkOutAt.toISOString()).toBe('2026-01-06T09:00:00.000Z');
    });
  });

  // ============ E. F4(#399):一级 reject 软删 records → 释放 overlap 窗口(死锁修复)============
  // 原先一级 rejected 的 records 不软删(deletedAt IS NULL)→ 永久占用 overlap 窗口,
  // 同 member 同窗无法重交(死锁)。F4 起 reject 软删 records,窗口释放,可重新提交。
  describe('E. F4:reject 软删 records 释放 overlap 窗口(死锁修复)', () => {
    beforeEach(isolateFixtures);

    it('reject sheet1 后同 member 同窗 sheet2 可重新提交(此前 ATTENDANCE_TIME_OVERLAP 死锁)', async () => {
      const window = {
        memberId: ctx.memberAId,
        checkInAt: '2026-01-07T10:00:00.000Z',
        checkOutAt: '2026-01-07T12:00:00.000Z',
      };

      // 1. 提交 sheet1(占用时间窗,pending)
      const sheet1 = await submitSheet(ctx.activityAId, [window]);
      expect(await countActiveRecordsForSheet(sheet1)).toBe(1);

      // 2. 死锁前提:同 member 同窗跨 Sheet 再提交 → ATTENDANCE_TIME_OVERLAP(窗口被占)
      await expect(submitSheet(ctx.activityBId, [window])).rejects.toMatchObject({
        biz: BizCode.ATTENDANCE_TIME_OVERLAP,
      });

      // 3. 一级 reject sheet1 → records 跟随软删(F4)
      await ctx.service.reject(
        sheet1,
        { reviewNote: '数据有误,驳回' },
        ctx.submitterPayload,
        AUDIT_META,
      );
      expect(await countActiveRecordsForSheet(sheet1)).toBe(0);

      // 4. 死锁解除:同 member 同窗重新提交 → 成功(窗口已释放)
      const sheet2 = await submitSheet(ctx.activityBId, [window]);
      expect(await countActiveRecordsForSheet(sheet2)).toBe(1);
      const s2 = await ctx.prisma.attendanceSheet.findUniqueOrThrow({
        where: { id: sheet2 },
        select: { statusCode: true },
      });
      expect(s2.statusCode).toBe('pending');
    });
  });
});
