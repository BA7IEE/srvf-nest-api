import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import type {
  AttendanceRecordInputDto,
  CreateAttendanceSheetDto,
  UpdateAttendanceSheetDto,
} from '../../src/modules/attendances/attendances.dto';
import { AttendancesService } from '../../src/modules/attendances/attendances.service';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// attendances audit characterization tests(AuditRecorder 抽离前置)。
//
// 三抽完成后(PR #178 ContributionCalculator / PR #180 TimeOverlapPolicy / PR #183 StateMachine),
// `attendances.service.ts` 剩余最大单一职责是 audit assembly(~200/1270 LOC、
// 8 处 `auditLogs.log(...)` 调用、2 个 snapshot helper);但直接抽 `AuditRecorder` 会让
// 回归丢字段而 CI 仍绿,因为下列 3 个写入路径的 `extra` 字段当前**未被深锁**:
//   - submit / edit(records 分支 + no-records 分支)/ softDelete
// 同时,"audit 写失败 → 整个 $transaction 回滚"(D-S7 红线)也没有显式 case。
//
// 本 spec 只读评审报告 §8 结论的下一单:补 4 类 audit characterization,
// 锁定当前现状(零行为变化),作为 AuditRecorder 抽离的安全门禁。
//
// 覆盖:
//   A. submit:        extra = { operation, activityId, recordsCount, activityPushedToCompleted }
//                     - A1 published Activity → 成功 + Activity 保持 published + activityPushedToCompleted=false
//                     - A2 completed Activity → 成功 + Activity 仍 completed + activityPushedToCompleted=false
//   B. edit:          两条分支 extra 字段不同
//                     - B1 records 分支:  { operation: 'edit', oldRecordsCount, newRecordsCount, newVersion }
//                     - B2 no-records 分支: { operation: 'edit-no-records', recordsCount, newVersion }
//   C. softDelete:    extra = { operation: 'delete', priorStatusCode, recordsCount }
//   D. audit failure rollback: spy `AuditLogsService.log` 抛错
//                     → Sheet / Records 不落库 + Activity 状态不变 + 无 audit row
//
// 不覆盖(已深锁,沿规约第 15 条不重复):
//   - approve / reject(state-transition.e2e-spec.ts / reject-transition.e2e-spec.ts)
//   - finalApprove / finalReject(state-transition.e2e-spec.ts)
//
// 沿 attendances-status-guards / state-transition / reject-transition spec 范式:
//   - createTestApp + resetDb + 真实 PrismaService(test database)
//   - service-level e2e:绕过 HTTP / Guard / RolesGuard,直接调 service 方法
//   - per-test isolateFixtures() 清 sheets / records / activities / audit_logs;保留 user/member/org/dict
//   - 时间统一 UTC fixed 字面量,避免时区干扰
//
// 本 PR 范围(规约 §一):
//   ❌ 不改 attendances.service.ts
//   ❌ 不抽 AuditRecorder / ActivityCompletionPolicy / 任何 class
//   ❌ 不拆 controller / DTO / schema / migration / OpenAPI / package / CI
//   ✅ 只新增本测试文件

type SheetStatus = 'pending' | 'pending_final_review' | 'approved' | 'rejected' | 'final_rejected';
type ActivityStatus = 'published' | 'completed' | 'cancelled';

const AUDIT_META: AuditMeta = {
  requestId: 'audit-char-req-0000000000000001',
  ip: '127.0.0.1',
  ua: 'jest/30 attendances-audit-characterization',
};

const ACTIVITY_TYPE_DEMO = 'aud-demo';
const ROLE_MEMBER = 'member';
const ATTENDANCE_STATUS_PRESENT = 'present';
const AUDIT_RESOURCE_TYPE_ATTENDANCE_SHEET = 'attendance_sheet';

interface SeedContext {
  prisma: PrismaService;
  service: AttendancesService;
  auditLogs: AuditLogsService;
  submitterUserId: string;
  submitterPayload: CurrentUserPayload;
  memberId: string;
  organizationId: string;
}

// 安全的 audit context 形状(沿 audit-logs.types.AuditContext);per-case 用泛型 extra 约束字段。
interface ReadAuditContext<E extends Record<string, unknown> = Record<string, unknown>> {
  requestId: string;
  ip: string | null;
  ua: string | null;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  extra?: E;
}

describe('AttendancesService audit characterization', () => {
  let app: INestApplication;
  let ctx: SeedContext;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);

    const prisma = app.get(PrismaService);
    const service = app.get(AttendancesService);
    const auditLogs = app.get(AuditLogsService);

    const submitter = await prisma.user.create({
      data: {
        username: 'att-aud-submitter',
        passwordHash: '$2a$10$dummy-hash-not-used-since-no-login-needed',
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
      data: { memberNo: 'att-aud-m-001', displayName: 'Aud Member' },
      select: { id: true },
    });

    // node_type dict + root org(Activity.organizationId FK,沿 Restrict)
    const nodeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'aud-root', label: '根' },
    });
    const rootOrg = await prisma.organization.create({
      data: { name: 'Aud Root Org', nodeTypeCode: 'aud-root', parentId: null },
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

    // attendance_role 字典(submit / edit 字典校验)
    const roleDict = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: roleDict.id, code: ROLE_MEMBER, label: 'member' },
    });

    // attendance_status 字典(submit / edit 字典校验)
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
      auditLogs,
      submitterUserId: submitter.id,
      submitterPayload: {
        id: submitter.id,
        username: 'att-aud-submitter',
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

  // 还原所有 D1 spy(其它 case 不 spy 也无副作用)
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // 每个 case 清:records → sheets → activities → audit_logs;保留 user / member / org / dict。
  async function isolateFixtures(): Promise<void> {
    await ctx.prisma.attendanceRecord.deleteMany({});
    await ctx.prisma.attendanceSheet.deleteMany({});
    await ctx.prisma.activity.deleteMany({});
    await ctx.prisma.auditLog.deleteMany({});
  }

  async function createActivity(statusCode: ActivityStatus): Promise<string> {
    const act = await ctx.prisma.activity.create({
      data: {
        title: `Aud Activity ${statusCode}`,
        activityTypeCode: ACTIVITY_TYPE_DEMO,
        organizationId: ctx.organizationId,
        // 跨度大,容纳任意 case 内 record 时段
        startAt: new Date('2026-03-01T00:00:00.000Z'),
        endAt: new Date('2026-03-31T23:59:59.000Z'),
        location: 'aud',
        statusCode,
        isPublicRegistration: true,
      },
      select: { id: true },
    });
    return act.id;
  }

  /**
   * 直接 prisma seed AttendanceSheet + N records(绕过 submit 状态机),
   * 用于初始化 edit / softDelete 的前置 Sheet。
   * 沿 attendances-status-guards / state-transition seedSheet 范式。
   */
  async function seedSheet(opts: {
    activityId: string;
    statusCode: SheetStatus;
    recordCount: number;
  }): Promise<string> {
    const sheet = await ctx.prisma.attendanceSheet.create({
      data: {
        activityId: opts.activityId,
        submitterUserId: ctx.submitterUserId,
        statusCode: opts.statusCode,
        version: 1,
      },
      select: { id: true },
    });
    for (let i = 0; i < opts.recordCount; i++) {
      // 每条 record 时段 4h,间隔 6h,避免 TimeOverlapPolicy 内部重叠
      const checkIn = new Date(
        new Date('2026-03-05T00:00:00.000Z').getTime() + i * 6 * 60 * 60 * 1000,
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
          contributionPoints: 1,
        },
      });
    }
    return sheet.id;
  }

  function buildSubmitDto(recordCount: number): CreateAttendanceSheetDto {
    const records: AttendanceRecordInputDto[] = [];
    for (let i = 0; i < recordCount; i++) {
      // 错开 6h:1-5 / 7-11 / 13-17 ...,避免 batch 内 / 跨 Sheet 重叠
      const startHour = 1 + i * 6;
      records.push({
        memberId: ctx.memberId,
        roleCode: ROLE_MEMBER,
        checkInAt: `2026-03-10T${String(startHour).padStart(2, '0')}:00:00.000Z`,
        checkOutAt: `2026-03-10T${String(startHour + 4).padStart(2, '0')}:00:00.000Z`,
        attendanceStatusCode: ATTENDANCE_STATUS_PRESENT,
        // 显式传值跳过 ContributionRule 预填路径(沿 D-A8 三态:number → 不预填、不覆盖)
        contributionPoints: 1,
      });
    }
    return { records };
  }

  function buildEditRecordsDto(recordCount: number): UpdateAttendanceSheetDto {
    const records: AttendanceRecordInputDto[] = [];
    for (let i = 0; i < recordCount; i++) {
      const startHour = 1 + i * 6;
      records.push({
        memberId: ctx.memberId,
        roleCode: ROLE_MEMBER,
        checkInAt: `2026-03-15T${String(startHour).padStart(2, '0')}:00:00.000Z`,
        checkOutAt: `2026-03-15T${String(startHour + 4).padStart(2, '0')}:00:00.000Z`,
        attendanceStatusCode: ATTENDANCE_STATUS_PRESENT,
        contributionPoints: 1,
      });
    }
    return { records };
  }

  // ============ A. submit audit extra ============
  describe('A. submit audit extra', () => {
    beforeEach(isolateFixtures);

    it('A1. published Activity → submit 成功 + audit extra.activityPushedToCompleted=false + Activity 保持 published', async () => {
      const activityId = await createActivity('published');

      const result = await ctx.service.submit(
        activityId,
        buildSubmitDto(2),
        ctx.submitterPayload,
        AUDIT_META,
      );

      // D2-a:首提不再推进活动；完结唯一入口是管理端 complete。
      const dbActivity = await ctx.prisma.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: { statusCode: true },
      });
      expect(dbActivity.statusCode).toBe('published');

      // 单条 audit
      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: 'attendance-sheet.submit' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];

      expect(a.resourceType).toBe(AUDIT_RESOURCE_TYPE_ATTENDANCE_SHEET);
      expect(a.resourceId).toBe(result.id);
      expect(a.actorUserId).toBe(ctx.submitterUserId);
      expect(a.actorRoleSnap).toBe(Role.ADMIN);
      expect(a.success).toBe(true);

      const c = a.context as unknown as ReadAuditContext<{
        operation?: string;
        activityId?: string;
        recordsCount?: number;
        activityPushedToCompleted?: boolean;
      }>;
      expect(c.requestId).toBe(AUDIT_META.requestId);
      expect(c.ip).toBe(AUDIT_META.ip);
      expect(c.ua).toBe(AUDIT_META.ua);

      // submit 路径不传 before(沿 auditLogs.log 调用未传 before;现状)
      expect(c.before).toBeUndefined();

      // after 含 sheet + records 完整快照(沿 toSheetAuditSnapshot 现状)
      expect(c.after).toBeDefined();
      const after = c.after as {
        sheet: { statusCode: string; version: number };
        records: Array<{ memberId: string; contributionPoints: string | null }>;
      };
      expect(after.sheet.statusCode).toBe('pending');
      expect(after.sheet.version).toBe(1);
      expect(after.records).toHaveLength(2);
      // contributionPoints 序列化为 string(Decimal.toString;沿 toSheetAuditSnapshot 现状)
      expect(after.records[0].contributionPoints).toBe('1');

      // extra:4 个字段(锁定形状)
      expect(c.extra).toEqual({
        operation: 'submit',
        activityId,
        recordsCount: 2,
        activityPushedToCompleted: false,
      });
    });

    it('A2. completed Activity → submit 成功 + audit extra.activityPushedToCompleted=false + Activity 仍 completed', async () => {
      const activityId = await createActivity('completed');

      const result = await ctx.service.submit(
        activityId,
        buildSubmitDto(1),
        ctx.submitterPayload,
        AUDIT_META,
      );

      const dbActivity = await ctx.prisma.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: { statusCode: true },
      });
      expect(dbActivity.statusCode).toBe('completed');

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: 'attendance-sheet.submit' },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].resourceId).toBe(result.id);

      const c = audits[0].context as unknown as ReadAuditContext<{
        operation?: string;
        activityId?: string;
        recordsCount?: number;
        activityPushedToCompleted?: boolean;
      }>;
      // D2-a 保留兼容字段，但 submit 不再写 Activity，因此对所有状态恒 false。
      expect(c.extra).toEqual({
        operation: 'submit',
        activityId,
        recordsCount: 1,
        activityPushedToCompleted: false,
      });
    });
  });

  // ============ B. edit audit extra (双分支) ============
  describe('B. edit audit extra (records / no-records 双分支)', () => {
    beforeEach(isolateFixtures);

    it('B1. records 分支:extra={operation:edit, oldRecordsCount, newRecordsCount, newVersion}', async () => {
      const activityId = await createActivity('completed');
      const sheetId = await seedSheet({
        activityId,
        statusCode: 'pending',
        recordCount: 2,
      });

      const dto = buildEditRecordsDto(1); // 替换 2 → 1 条
      const result = await ctx.service.edit(sheetId, dto, ctx.submitterPayload, AUDIT_META);

      // DB sheet:version=2;旧 records 软删;新 records 1 条 active
      expect(result.version).toBe(2);

      const activeRecs = await ctx.prisma.attendanceRecord.findMany({
        where: { sheetId, deletedAt: null },
      });
      expect(activeRecs).toHaveLength(1);
      const deletedRecs = await ctx.prisma.attendanceRecord.findMany({
        where: { sheetId, deletedAt: { not: null } },
      });
      expect(deletedRecs).toHaveLength(2);

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: 'attendance-sheet.edit' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      expect(a.resourceType).toBe(AUDIT_RESOURCE_TYPE_ATTENDANCE_SHEET);
      expect(a.resourceId).toBe(sheetId);
      expect(a.actorUserId).toBe(ctx.submitterUserId);
      expect(a.actorRoleSnap).toBe(Role.ADMIN);
      expect(a.success).toBe(true);

      const c = a.context as unknown as ReadAuditContext<{
        operation?: string;
        oldRecordsCount?: number;
        newRecordsCount?: number;
        newVersion?: number;
      }>;
      expect(c.requestId).toBe(AUDIT_META.requestId);

      // before 抓的是 edit 前的 sheet + 2 条旧 records(沿 service.ts:798 toSheetAuditSnapshot)
      expect(c.before).toBeDefined();
      const before = c.before as {
        sheet: { version: number; statusCode: string };
        records: Array<unknown>;
      };
      expect(before.sheet.version).toBe(1);
      expect(before.sheet.statusCode).toBe('pending');
      expect(before.records).toHaveLength(2);

      // after 抓的是 edit 后的 sheet + 1 条新 records
      expect(c.after).toBeDefined();
      const after = c.after as {
        sheet: { version: number; statusCode: string };
        records: Array<unknown>;
      };
      expect(after.sheet.version).toBe(2);
      expect(after.sheet.statusCode).toBe('pending');
      expect(after.records).toHaveLength(1);

      // extra:4 个字段(锁定形状,**无** recordsCount,与 no-records 分支区分)
      expect(c.extra).toEqual({
        operation: 'edit',
        oldRecordsCount: 2,
        newRecordsCount: 1,
        newVersion: 2,
      });
    });

    it('B2. no-records 分支:extra={operation:edit-no-records, recordsCount, newVersion};records 不变', async () => {
      const activityId = await createActivity('completed');
      const sheetId = await seedSheet({
        activityId,
        statusCode: 'pending',
        recordCount: 2,
      });

      // 显式不传 records 字段(DTO.records optional)
      const dto: UpdateAttendanceSheetDto = {};
      const result = await ctx.service.edit(sheetId, dto, ctx.submitterPayload, AUDIT_META);

      // DB sheet:version=2;records 全 2 条仍 active(no-records 分支不动 records)
      expect(result.version).toBe(2);
      const activeRecs = await ctx.prisma.attendanceRecord.findMany({
        where: { sheetId, deletedAt: null },
      });
      expect(activeRecs).toHaveLength(2);
      const deletedRecs = await ctx.prisma.attendanceRecord.findMany({
        where: { sheetId, deletedAt: { not: null } },
      });
      expect(deletedRecs).toHaveLength(0);

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: 'attendance-sheet.edit' },
      });
      expect(audits).toHaveLength(1);
      const c = audits[0].context as unknown as ReadAuditContext<{
        operation?: string;
        recordsCount?: number;
        newVersion?: number;
      }>;

      // before / after 都包含 records 数组 = 同样的 2 条(沿 service.ts:700-701 同源 currentRecords)
      expect(c.before).toBeDefined();
      expect(c.after).toBeDefined();
      const before = c.before as { sheet: { version: number }; records: Array<unknown> };
      const after = c.after as { sheet: { version: number }; records: Array<unknown> };
      expect(before.sheet.version).toBe(1);
      expect(before.records).toHaveLength(2);
      expect(after.sheet.version).toBe(2);
      expect(after.records).toHaveLength(2);

      // extra:3 个字段(锁定形状,**无** oldRecordsCount/newRecordsCount,与 records 分支区分)
      expect(c.extra).toEqual({
        operation: 'edit-no-records',
        recordsCount: 2,
        newVersion: 2,
      });
    });
  });

  // ============ C. softDelete audit extra ============
  describe('C. softDelete audit extra', () => {
    beforeEach(isolateFixtures);

    it('C1. pending Sheet softDelete → extra={operation:delete, priorStatusCode:pending, recordsCount:3};无 after', async () => {
      const activityId = await createActivity('completed');
      const sheetId = await seedSheet({
        activityId,
        statusCode: 'pending',
        recordCount: 3,
      });

      await ctx.service.softDelete(sheetId, ctx.submitterPayload, AUDIT_META);

      // DB:Sheet + 3 records 全部软删
      const sheet = await ctx.prisma.attendanceSheet.findUniqueOrThrow({
        where: { id: sheetId },
        select: { deletedAt: true },
      });
      expect(sheet.deletedAt).not.toBeNull();

      const allRecs = await ctx.prisma.attendanceRecord.findMany({
        where: { sheetId },
        select: { deletedAt: true },
      });
      expect(allRecs).toHaveLength(3);
      for (const r of allRecs) {
        expect(r.deletedAt).not.toBeNull();
      }

      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: 'attendance-sheet.delete' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      expect(a.resourceType).toBe(AUDIT_RESOURCE_TYPE_ATTENDANCE_SHEET);
      expect(a.resourceId).toBe(sheetId);
      expect(a.actorUserId).toBe(ctx.submitterUserId);
      expect(a.actorRoleSnap).toBe(Role.ADMIN);
      expect(a.success).toBe(true);

      const c = a.context as unknown as ReadAuditContext<{
        operation?: string;
        priorStatusCode?: string;
        recordsCount?: number;
      }>;

      // before 抓的是软删前的 sheet + 3 条 records 完整快照
      expect(c.before).toBeDefined();
      const before = c.before as {
        sheet: { statusCode: string };
        records: Array<unknown>;
      };
      expect(before.sheet.statusCode).toBe('pending');
      expect(before.records).toHaveLength(3);

      // softDelete 不传 after(沿 service.ts:924-938 auditLogs.log 调用未传 after;现状)
      expect(c.after).toBeUndefined();

      // extra:3 个字段(锁定形状)
      expect(c.extra).toEqual({
        operation: 'delete',
        priorStatusCode: 'pending',
        recordsCount: 3,
      });
    });
  });

  // ============ D. audit failure rollback ============
  describe('D. audit failure rollback', () => {
    beforeEach(isolateFixtures);

    it('D1. submit 路径 AuditLogsService.log 抛错 → 整个 $transaction 回滚:Sheet/Records/audit row 全部回滚，Activity 不变', async () => {
      const activityId = await createActivity('published');

      // spy:AttendancesService 通过 DI 注入的同一个 AuditLogsService 单例
      // (沿 health-ready.e2e-spec.ts:66 的 jest.spyOn(...).mockRejectedValue 范式)
      const logSpy = jest
        .spyOn(ctx.auditLogs, 'log')
        .mockRejectedValueOnce(new Error('simulated audit failure'));

      await expect(
        ctx.service.submit(activityId, buildSubmitDto(2), ctx.submitterPayload, AUDIT_META),
      ).rejects.toThrow('simulated audit failure');

      // spy 确实被调用了一次(submit 路径 audit log 是事务最后一步;
      // 如果 0 次说明逻辑路径没走到 audit 段,本断言失败提示需要重新评估前置步骤)
      expect(logSpy).toHaveBeenCalledTimes(1);

      // 事务回滚证据 1:无新 AttendanceSheet
      const sheets = await ctx.prisma.attendanceSheet.findMany({
        where: { activityId },
      });
      expect(sheets).toHaveLength(0);

      // 事务回滚证据 2:无新 AttendanceRecord(submit 内是 nested create,
      //   sheet 不在意味着 record 也不在;此处独立查更严格)
      const records = await ctx.prisma.attendanceRecord.findMany({});
      expect(records).toHaveLength(0);

      // 事务回滚证据 3:Activity 仍是 published(D2-a 下 submit 本就不写 Activity;
      //   沿 service.ts:494-500,push 在 audit.log 之前,但同一 $transaction 内一并回滚)
      const dbActivity = await ctx.prisma.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: { statusCode: true },
      });
      expect(dbActivity.statusCode).toBe('published');

      // 事务回滚证据 4:audit_logs 无 attendance-sheet.submit 落库
      //   (D-S7 红线:audit 写失败 → 整个事务回滚 → 业务事件随之回滚,由 DB 事务原子性保证)
      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: 'attendance-sheet.submit' },
      });
      expect(audits).toHaveLength(0);
    });
  });
});
