import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import { BizCode, type BizCodeEntry } from '../../src/common/exceptions/biz-code.constant';
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

// attendances status guards characterization tests(StateMachine 抽离前置之一)。
//
// 目标:在抽 `StateMachine` 前显式锁定 `attendances.service.ts` 三个公共写入入口的
// 状态护栏与状态副作用现状行为(零行为变化的搬家前置):
//
//   submit(activityId, dto, currentUser, auditMeta):
//     - Activity.statusCode === 'cancelled' → 拒(ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN)
//     - Activity.statusCode === 'published' → submit 成功，Activity 保持 published(D2-a)
//     - Activity.statusCode === 'completed' → 当前实装仅 cancelled 拒,completed 仍接受 submit;
//       Activity 不再 update(已是 completed,published 判定不命中)
//
//   edit(id, dto, currentUser, auditMeta):
//     - pending                 → 成功(version+1;旧 records 软删 + 新 records 创建)
//     - pending_final_review    → ATTENDANCE_SHEET_STATUS_INVALID
//     - approved                → ATTENDANCE_SHEET_APPROVED_NOT_EDITABLE
//     - rejected                → ATTENDANCE_SHEET_REJECTED_NOT_EDITABLE
//     - final_rejected          → ATTENDANCE_SHEET_FINAL_REJECTED_NOT_EDITABLE
//
//   softDelete(id, currentUser, auditMeta):
//     - pending                 → 成功;Sheet.deletedAt 与全部 records.deletedAt 同事务设置(cascade)
//     - pending_final_review    → ATTENDANCE_SHEET_STATUS_INVALID
//     - approved                → ATTENDANCE_SHEET_APPROVED_NOT_EDITABLE
//     - rejected                → ATTENDANCE_SHEET_REJECTED_NOT_EDITABLE
//     - final_rejected          → ATTENDANCE_SHEET_FINAL_REJECTED_NOT_EDITABLE
//
// 注意 BizCode 在 edit/softDelete 路径上**因来源状态而异**(非统一 STATUS_INVALID);本 spec 通过
// it.each([status, biz]) 表覆盖,**显式锁定每个状态映射的当前 BizCode**(不假设统一)。
//
// 沿 `attendances-state-transition.e2e-spec.ts` / `attendances-time-overlap.e2e-spec.ts`
// / `attendances-contribution-prefill.e2e-spec.ts` 范式:
//   - createTestApp + resetDb + 真实 PrismaService(test database)
//   - service-level e2e:绕过 HTTP / Guard / RolesGuard,直接调 service 方法
//   - per-test `isolateFixtures()` 清 sheets / records / activities / audit_logs(保留 user/member/org/dict)
//   - submit cases 用 service.submit 驱动;edit/softDelete 状态护栏直接 prisma seed Sheet
//     至任意起始状态(包括非 pending 的 4 种),供护栏路径校验
//   - 时间统一 UTC fixed 字面量,避免时区干扰
//
// 本 PR 范围:
//   ❌ 不改 attendances.service.ts
//   ❌ 不抽 StateMachine / TimeOverlapPolicy / ContributionCalculator / AuditRecorder
//   ❌ 不拆 controller / DTO / schema / migration / OpenAPI snapshot
//   ✅ 只新增本测试文件

type SheetStatus = 'pending' | 'pending_final_review' | 'approved' | 'rejected' | 'final_rejected';
type ActivityStatus = 'draft' | 'published' | 'completed' | 'cancelled';

const AUDIT_META: AuditMeta = {
  requestId: 'sg-test-req-0000000000000000001',
  ip: '127.0.0.1',
  ua: 'jest/30 attendances-status-guards',
};

const ACTIVITY_TYPE_DEMO = 'sg-demo';
const ROLE_MEMBER = 'member';
const ATTENDANCE_STATUS_PRESENT = 'present';

interface SeedContext {
  prisma: PrismaService;
  service: AttendancesService;
  submitterUserId: string;
  submitterPayload: CurrentUserPayload;
  memberId: string;
  organizationId: string;
}

describe('AttendancesService status guards (characterization)', () => {
  let app: INestApplication;
  let ctx: SeedContext;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);

    const prisma = app.get(PrismaService);
    const service = app.get(AttendancesService);

    const submitter = await prisma.user.create({
      data: {
        username: 'att-sg-submitter',
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

    const member = await prisma.member.create({
      data: { memberNo: 'att-sg-m-001', displayName: 'SG Member' },
      select: { id: true },
    });

    // node_type dict + root org(Activity.organizationId FK,沿 Restrict)
    const nodeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'sg-root', label: '根' },
    });
    const rootOrg = await prisma.organization.create({
      data: { name: 'SG Root Org', nodeTypeCode: 'sg-root', parentId: null },
      select: { id: true },
    });

    // activity_type 字典(activityTypeCode 是字符串,不做 FK 校验;dict 项仅作语义记录)
    const actTypeDict = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: actTypeDict.id, code: ACTIVITY_TYPE_DEMO, label: 'demo' },
    });

    // attendance_role 字典(1 项即可)
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

    ctx = {
      prisma,
      service,
      submitterUserId: submitter.id,
      submitterPayload: {
        id: submitter.id,
        username: 'att-sg-submitter',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
        memberId: null,
      },
      memberId: member.id,
      organizationId: rootOrg.id,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  // 每个 case 清:records → sheets → activities → audit_logs;
  // 保留:user / member / org / dict(共享 seed)。
  async function isolateFixtures(): Promise<void> {
    await ctx.prisma.attendanceRecord.deleteMany({});
    await ctx.prisma.attendanceSheet.deleteMany({});
    await ctx.prisma.activity.deleteMany({});
    await ctx.prisma.auditLog.deleteMany({});
  }

  // ============ helpers ============

  async function createActivity(statusCode: ActivityStatus): Promise<string> {
    const act = await ctx.prisma.activity.create({
      data: {
        title: `SG Activity ${statusCode}`,
        activityTypeCode: ACTIVITY_TYPE_DEMO,
        organizationId: ctx.organizationId,
        // 跨度 10h:足以容纳任意 0 < serviceHours ≤ 10 的 case
        startAt: new Date('2026-02-01T00:00:00.000Z'),
        endAt: new Date('2026-02-01T23:59:59.000Z'),
        location: 'sg',
        statusCode,
        isPublicRegistration: true,
      },
      select: { id: true },
    });
    return act.id;
  }

  /**
   * 直接 prisma seed AttendanceSheet + N records(绕过 submit 状态机);
   * 用于初始化任意起始 Sheet 状态(包括非 pending 的 4 种),供 edit / softDelete 状态护栏校验。
   * 沿 attendances-state-transition.e2e-spec.ts seedSheet 范式。
   */
  async function seedSheet(opts: {
    activityId: string;
    statusCode: SheetStatus;
    recordCount?: number;
    /** 不同 case 间错峰避免时间冲突(time-overlap 校验全局 by memberId,这里为安全) */
    checkInOffsetHours?: number;
  }): Promise<string> {
    const recordCount = opts.recordCount ?? 1;
    const offsetHours = opts.checkInOffsetHours ?? 0;
    const sheet = await ctx.prisma.attendanceSheet.create({
      data: {
        activityId: opts.activityId,
        submitterUserId: ctx.submitterUserId,
        statusCode: opts.statusCode,
        version: 1,
      },
      select: { id: true },
    });
    for (let i = 0; i < recordCount; i++) {
      const checkIn = new Date(
        new Date('2026-02-01T00:00:00.000Z').getTime() + (offsetHours + i * 6) * 60 * 60 * 1000,
      );
      const checkOut = new Date(checkIn.getTime() + 4 * 60 * 60 * 1000);
      await ctx.prisma.attendanceRecord.create({
        data: {
          sheetId: sheet.id,
          memberId: ctx.memberId,
          roleCode: ROLE_MEMBER,
          checkInAt: checkIn,
          checkOutAt: checkOut,
          serviceHours: 4,
          attendanceStatusCode: ATTENDANCE_STATUS_PRESENT,
          contributionPoints: 1, // 任意非 null,因为本 spec 不测 approve R31 校验
        },
      });
    }
    return sheet.id;
  }

  function buildSubmitDto(opts?: {
    checkInAt?: string;
    checkOutAt?: string;
  }): CreateAttendanceSheetDto {
    const record: AttendanceRecordInputDto = {
      memberId: ctx.memberId,
      roleCode: ROLE_MEMBER,
      checkInAt: opts?.checkInAt ?? '2026-02-01T08:00:00.000Z',
      checkOutAt: opts?.checkOutAt ?? '2026-02-01T12:00:00.000Z',
      attendanceStatusCode: ATTENDANCE_STATUS_PRESENT,
    };
    return { records: [record] };
  }

  function buildEditDto(opts?: {
    checkInAt?: string;
    checkOutAt?: string;
  }): UpdateAttendanceSheetDto {
    const record: AttendanceRecordInputDto = {
      memberId: ctx.memberId,
      roleCode: ROLE_MEMBER,
      checkInAt: opts?.checkInAt ?? '2026-02-01T13:00:00.000Z',
      checkOutAt: opts?.checkOutAt ?? '2026-02-01T17:00:00.000Z',
      attendanceStatusCode: ATTENDANCE_STATUS_PRESENT,
      contributionPoints: 1, // edit 不要求重填,但显式传值避免被预填污染断言
    };
    return { records: [record] };
  }

  async function getActiveRecords(
    sheetId: string,
  ): Promise<Array<{ checkInAt: Date; deletedAt: Date | null }>> {
    return ctx.prisma.attendanceRecord.findMany({
      where: { sheetId, deletedAt: null },
      select: { checkInAt: true, deletedAt: true },
      orderBy: { checkInAt: 'asc' },
    });
  }

  async function getAllRecords(
    sheetId: string,
  ): Promise<Array<{ checkInAt: Date; deletedAt: Date | null }>> {
    return ctx.prisma.attendanceRecord.findMany({
      where: { sheetId },
      select: { checkInAt: true, deletedAt: true },
      orderBy: { checkInAt: 'asc' },
    });
  }

  async function getSheetState(sheetId: string): Promise<{
    statusCode: string;
    version: number;
    deletedAt: Date | null;
  }> {
    return ctx.prisma.attendanceSheet.findUniqueOrThrow({
      where: { id: sheetId },
      select: { statusCode: true, version: true, deletedAt: true },
    });
  }

  async function getActivityStatus(activityId: string): Promise<string> {
    const a = await ctx.prisma.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: { statusCode: true },
    });
    return a.statusCode;
  }

  // ============ Group A. submit(...) Activity 状态副作用 ============

  describe('A. submit Activity status side effects', () => {
    beforeEach(isolateFixtures);

    it('Case A1:submit published Activity → submit 成功 + Sheet pending + Activity 保持 published', async () => {
      const activityId = await createActivity('published');

      const submitted = await ctx.service.submit(
        activityId,
        buildSubmitDto(),
        ctx.submitterPayload,
        AUDIT_META,
      );

      // Sheet 创建成功 + statusCode = pending
      expect(submitted.statusCode).toBe('pending');
      const sheet = await getSheetState(submitted.id);
      expect(sheet.statusCode).toBe('pending');
      expect(sheet.deletedAt).toBeNull();

      // D2-a:completed 纯手动，首提考勤不再推进活动。
      expect(await getActivityStatus(activityId)).toBe('published');

      // audit log:存在 attendance-sheet.submit(沿 D-S7;不过度断字段)
      const audits = await ctx.prisma.auditLog.findMany({
        where: { resourceId: submitted.id, event: 'attendance-sheet.submit' },
      });
      expect(audits.length).toBeGreaterThanOrEqual(1);
    });

    it('Case A2:submit completed Activity → 当前实装仍允许(只拒 cancelled);Activity 仍 completed', async () => {
      // 现状锁定:findActivityForSubmissionFull 只在 cancelled 时抛 ACTIVITY_CANCELLED_*;
      // completed 状态不在拒绝集合内,因此 submit 成功;Activity 已是 completed,
      // completed 允许补录，且 D2-a 下 submit 不写 Activity 状态。
      const activityId = await createActivity('completed');

      const submitted = await ctx.service.submit(
        activityId,
        buildSubmitDto(),
        ctx.submitterPayload,
        AUDIT_META,
      );

      expect(submitted.statusCode).toBe('pending');
      expect(await getActivityStatus(activityId)).toBe('completed');
    });

    it('Case A3:submit draft Activity → ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN', async () => {
      const activityId = await createActivity('draft');
      await expect(
        ctx.service.submit(activityId, buildSubmitDto(), ctx.submitterPayload, AUDIT_META),
      ).rejects.toMatchObject({
        biz: BizCode.ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN,
      });
      expect(await getActivityStatus(activityId)).toBe('draft');
    });

    it('Case A3:submit cancelled Activity → ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN;无 Sheet/Records;Activity 仍 cancelled', async () => {
      const activityId = await createActivity('cancelled');

      await expect(
        ctx.service.submit(activityId, buildSubmitDto(), ctx.submitterPayload, AUDIT_META),
      ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN });

      // 事务整体回滚:无 Sheet / Records
      expect(await ctx.prisma.attendanceSheet.count()).toBe(0);
      expect(await ctx.prisma.attendanceRecord.count()).toBe(0);
      // Activity 不变
      expect(await getActivityStatus(activityId)).toBe('cancelled');
    });
  });

  // ============ Group B. edit(...) Sheet 状态护栏 ============

  describe('B. edit Sheet status guards (pending-only)', () => {
    beforeEach(isolateFixtures);

    it('Case B1:edit pending → 成功;version+1;旧 records 软删 + 新 records 创建', async () => {
      // 用 completed Activity 直接 seed pending Sheet，锁定 completed 补录语义。
      const activityId = await createActivity('completed');
      const sheetId = await seedSheet({
        activityId,
        statusCode: 'pending',
        recordCount: 1,
      });
      const before = await getSheetState(sheetId);
      expect(before.version).toBe(1);
      expect(before.statusCode).toBe('pending');

      const result = await ctx.service.edit(
        sheetId,
        buildEditDto(),
        ctx.submitterPayload,
        AUDIT_META,
      );

      // version +1,statusCode 仍 pending
      expect(result.statusCode).toBe('pending');
      expect(result.version).toBe(2);
      const after = await getSheetState(sheetId);
      expect(after.statusCode).toBe('pending');
      expect(after.version).toBe(2);
      expect(after.deletedAt).toBeNull();

      // 旧 records 软删 + 新 records 创建(D38)
      const all = await getAllRecords(sheetId);
      expect(all).toHaveLength(2);
      const softDeleted = all.filter((r) => r.deletedAt !== null);
      const active = all.filter((r) => r.deletedAt === null);
      expect(softDeleted).toHaveLength(1);
      expect(active).toHaveLength(1);
      // 新 active record 对应 buildEditDto 的活动窗内时间
      expect(active[0].checkInAt.toISOString()).toBe('2026-02-01T13:00:00.000Z');
    });

    // it.each 显式表:status → 当前 BizCode(BizCode 因来源状态而异,沿 service.ts:673-690)
    it.each<{ status: SheetStatus; biz: BizCodeEntry }>([
      {
        status: 'pending_final_review',
        biz: BizCode.ATTENDANCE_SHEET_STATUS_INVALID,
      },
      {
        status: 'approved',
        biz: BizCode.ATTENDANCE_SHEET_APPROVED_NOT_EDITABLE,
      },
      {
        status: 'rejected',
        biz: BizCode.ATTENDANCE_SHEET_REJECTED_NOT_EDITABLE,
      },
      {
        status: 'final_rejected',
        biz: BizCode.ATTENDANCE_SHEET_FINAL_REJECTED_NOT_EDITABLE,
      },
    ])('Case B2-B5(from $status):edit 拒;DB 状态/版本/records 不变', async ({ status, biz }) => {
      const activityId = await createActivity('completed');
      const sheetId = await seedSheet({
        activityId,
        statusCode: status,
        recordCount: 1,
      });
      const before = await getSheetState(sheetId);
      expect(before.version).toBe(1);
      expect(before.statusCode).toBe(status);

      await expect(
        ctx.service.edit(sheetId, buildEditDto(), ctx.submitterPayload, AUDIT_META),
      ).rejects.toMatchObject({ biz });

      // 事务整体回滚:Sheet version / statusCode / deletedAt 不变
      const after = await getSheetState(sheetId);
      expect(after.version).toBe(1);
      expect(after.statusCode).toBe(status);
      expect(after.deletedAt).toBeNull();

      // 原 record 仍 active,无新 record 创建
      const all = await getAllRecords(sheetId);
      expect(all).toHaveLength(1);
      expect(all[0].deletedAt).toBeNull();
    });
  });

  // ============ Group C. softDelete(...) Sheet 状态护栏 ============

  describe('C. softDelete Sheet status guards (pending-only) + cascade soft-delete', () => {
    beforeEach(isolateFixtures);

    it('Case C1:softDelete pending → 成功;Sheet.deletedAt 非 null + 2 条 records 全部级联软删', async () => {
      const activityId = await createActivity('completed');
      const sheetId = await seedSheet({
        activityId,
        statusCode: 'pending',
        recordCount: 2,
      });
      const before = await getSheetState(sheetId);
      expect(before.statusCode).toBe('pending');
      expect(before.deletedAt).toBeNull();
      const activeBefore = await getActiveRecords(sheetId);
      expect(activeBefore).toHaveLength(2);

      await ctx.service.softDelete(sheetId, ctx.submitterPayload, AUDIT_META);

      // Sheet.deletedAt 设置;statusCode 不变(软删主体,不改业务状态)
      const after = await getSheetState(sheetId);
      expect(after.deletedAt).not.toBeNull();
      expect(after.statusCode).toBe('pending');

      // 所有 records 级联软删(R20:同事务批量 update)
      const all = await getAllRecords(sheetId);
      expect(all).toHaveLength(2);
      expect(all.every((r) => r.deletedAt !== null)).toBe(true);

      // audit log:存在 attendance-sheet.delete(沿 PR #6 D2;不过度断字段)
      const audits = await ctx.prisma.auditLog.findMany({
        where: { resourceId: sheetId, event: 'attendance-sheet.delete' },
      });
      expect(audits.length).toBeGreaterThanOrEqual(1);
    });

    // it.each 显式表:status → 当前 BizCode(softDelete 沿 edit 范式,BizCode 因状态而异)
    it.each<{ status: SheetStatus; biz: BizCodeEntry }>([
      {
        status: 'pending_final_review',
        biz: BizCode.ATTENDANCE_SHEET_STATUS_INVALID,
      },
      {
        status: 'approved',
        biz: BizCode.ATTENDANCE_SHEET_APPROVED_NOT_EDITABLE,
      },
      {
        status: 'rejected',
        biz: BizCode.ATTENDANCE_SHEET_REJECTED_NOT_EDITABLE,
      },
      {
        status: 'final_rejected',
        biz: BizCode.ATTENDANCE_SHEET_FINAL_REJECTED_NOT_EDITABLE,
      },
    ])(
      'Case C2-C5(from $status):softDelete 拒;Sheet.deletedAt 仍 null;records 全部仍 active',
      async ({ status, biz }) => {
        const activityId = await createActivity('completed');
        const sheetId = await seedSheet({
          activityId,
          statusCode: status,
          recordCount: 2,
        });

        await expect(
          ctx.service.softDelete(sheetId, ctx.submitterPayload, AUDIT_META),
        ).rejects.toMatchObject({ biz });

        // 事务整体回滚:Sheet.deletedAt 仍 null;statusCode 不变
        const after = await getSheetState(sheetId);
        expect(after.deletedAt).toBeNull();
        expect(after.statusCode).toBe(status);

        // 所有 records 仍 active(护栏在级联软删之前抛错,事务回滚)
        const all = await getAllRecords(sheetId);
        expect(all).toHaveLength(2);
        expect(all.every((r) => r.deletedAt === null)).toBe(true);
      },
    );
  });
});
