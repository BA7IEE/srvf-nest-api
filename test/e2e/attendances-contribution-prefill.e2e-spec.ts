import type { INestApplication } from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { AttendancesService } from '../../src/modules/attendances/attendances.service';
import type {
  AttendanceRecordInputDto,
  CreateAttendanceSheetDto,
} from '../../src/modules/attendances/attendances.dto';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// attendances D14 contribution prefill characterization tests(批次 4-B 抽 ContributionCalculator 前置)。
//
// 目标:在抽 `ContributionCalculator` 前显式锁定 `attendances.service.ts` 两个 prefill 私有方法的现状行为:
//   - applyContributionRulePrefill(records, activityTypeCode, tx) → 三态分发(undefined / null / number)
//   - computePrefilledPoints(activityTypeCode, attendanceRoleCode, serviceHours, tx) → 规则匹配 + cap 兜底
//
// 由于二者均为 `private`,本 spec 通过 **公共入口** `AttendancesService.submit(...)` 间接驱动,
// 从 DB 反查 `AttendanceRecord.contributionPoints` 落库值断言;不 mock、不 stub、不抽公共 helper。
//
// 沿 `attendances-state-transition.e2e-spec.ts` 范式:
//   - createTestApp + resetDb + 真实 PrismaService(test database)
//   - service-level e2e:绕过 HTTP / Guard / RolesGuard,直接调 `app.get(AttendancesService).submit(...)`
//   - per-test `isolateFixtures()` 清 sheets / records / rules / activities / audit_logs(保留共享 user/member/org/dict)
//   - 每个 case 自建 Activity，submit 后仍保持 published；不复用以隔离规则/记录夹具
//   - Decimal 比较用 `Number(...)`(0/1/1.5 等可直接和 number 字面量比较;null 单独判等)
//
// 本 PR 范围(沿 only-read review 报告 §10):
//   ❌ 不改 attendances.service.ts
//   ❌ 不抽 ContributionCalculator / StateMachine / Policy
//   ❌ 不拆 controller / DTO / schema / migration / OpenAPI snapshot
//   ✅ 只新增本测试文件

const AUDIT_META: AuditMeta = {
  requestId: 'pf-test-req-00000000000000000001',
  ip: '127.0.0.1',
  ua: 'jest/30 attendances-contribution-prefill',
};

const ACTIVITY_TYPE_DEMO = 'att-pf-demo';
const ACTIVITY_TYPE_OTHER = 'att-pf-other';
const ROLE_MEMBER = 'member';
const ROLE_COACH = 'coach';
const ROLE_INSTRUCTOR = 'instructor';
const ATTENDANCE_STATUS_PRESENT = 'present';

interface SeedContext {
  prisma: PrismaService;
  service: AttendancesService;
  submitterUserId: string;
  submitterPayload: CurrentUserPayload;
  memberId: string;
  organizationId: string;
}

describe('AttendancesService contribution prefill (characterization)', () => {
  let app: INestApplication;
  let ctx: SeedContext;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);

    const prisma = app.get(PrismaService);
    const service = app.get(AttendancesService);

    const submitter = await prisma.user.create({
      data: {
        username: 'att-pf-submitter',
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
      data: { memberNo: 'att-pf-m-001', displayName: 'PF Member' },
      select: { id: true },
    });

    // node_type dict + root org(Activity.organizationId FK,沿 Restrict)
    const nodeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'pf-root', label: '根' },
    });
    const rootOrg = await prisma.organization.create({
      data: { name: 'PF Root Org', nodeTypeCode: 'pf-root', parentId: null },
      select: { id: true },
    });

    // activity_type 字典(2 个 code:demo 用于命中,other 用于 case 11 不匹配)
    const actTypeDict = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: actTypeDict.id, code: ACTIVITY_TYPE_DEMO, label: 'demo' },
    });
    await prisma.dictItem.create({
      data: { typeId: actTypeDict.id, code: ACTIVITY_TYPE_OTHER, label: 'other' },
    });

    // attendance_role 字典(3 项:member / coach / instructor)
    const roleDict = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    for (const code of [ROLE_MEMBER, ROLE_COACH, ROLE_INSTRUCTOR]) {
      await prisma.dictItem.create({
        data: { typeId: roleDict.id, code, label: code },
      });
    }

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
        username: 'att-pf-submitter',
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

  // 每个 case 清:records → sheets → activities → contributionRules → audit_logs;
  // 保留:user / member / org / dictType / dictItem(共享 seed)。
  async function isolateFixtures(): Promise<void> {
    await ctx.prisma.attendanceRecord.deleteMany({});
    await ctx.prisma.attendanceSheet.deleteMany({});
    await ctx.prisma.activity.deleteMany({});
    await ctx.prisma.contributionRule.deleteMany({});
    await ctx.prisma.auditLog.deleteMany({});
  }

  // 每个 case 新建 Activity，避免跨 case 的规则/记录夹具互相污染。
  async function createActivity(activityTypeCode: string = ACTIVITY_TYPE_DEMO): Promise<string> {
    const act = await ctx.prisma.activity.create({
      data: {
        title: `PF Activity ${activityTypeCode}`,
        activityTypeCode,
        organizationId: ctx.organizationId,
        // 跨度 10h:足以容纳任意 0 < serviceHours ≤ 10 的 case
        startAt: new Date('2026-07-01T08:00:00.000Z'),
        endAt: new Date('2026-07-01T18:00:00.000Z'),
        location: 'pf',
        statusCode: 'published',
        isPublicRegistration: true,
      },
      select: { id: true },
    });
    return act.id;
  }

  interface CreateRuleArgs {
    activityTypeCode: string;
    attendanceRoleCode: string;
    durationThreshold: number | null;
    pointsBelow: number;
    pointsAbove: number | null;
    dailyCap: number | null;
    createdAt?: Date;
  }

  async function createRule(args: CreateRuleArgs): Promise<string> {
    const data: Prisma.ContributionRuleCreateInput = {
      activityTypeCode: args.activityTypeCode,
      attendanceRoleCode: args.attendanceRoleCode,
      durationThreshold: args.durationThreshold,
      pointsBelow: args.pointsBelow,
      pointsAbove: args.pointsAbove,
      dailyCap: args.dailyCap,
      status: 'ACTIVE',
    };
    if (args.createdAt !== undefined) {
      data.createdAt = args.createdAt;
    }
    const rule = await ctx.prisma.contributionRule.create({
      data,
      select: { id: true },
    });
    return rule.id;
  }

  interface SubmitOneArgs {
    activityId: string;
    roleCode?: string;
    serviceHours: number; // 显式传(便于覆盖 <= / > 档位的不同分支)
    contributionPoints?: number | null;
    // 时间:固定 checkIn=08:00,checkOut = checkIn + spanHours(默认 10h,与 activity 跨度等长);
    // submit 内会校验 serviceHours ≤ spanHours,因此 spanHours 默认设为 10h 覆盖所有 case。
    spanHours?: number;
  }

  async function submitOne(args: SubmitOneArgs): Promise<string> {
    const checkIn = new Date('2026-07-01T08:00:00.000Z');
    const span = args.spanHours ?? 10;
    const checkOut = new Date(checkIn.getTime() + span * 60 * 60 * 1000);
    // **三态构造**:undefined(omit key) / null(显式 null) / number;不能用 `?? undefined` 绕过。
    const recordInput: AttendanceRecordInputDto & { contributionPoints?: number | null } = {
      memberId: ctx.memberId,
      roleCode: args.roleCode ?? ROLE_MEMBER,
      checkInAt: checkIn.toISOString(),
      checkOutAt: checkOut.toISOString(),
      serviceHours: args.serviceHours,
      attendanceStatusCode: ATTENDANCE_STATUS_PRESENT,
    };
    if (args.contributionPoints !== undefined) {
      // 显式 null 或 number:写入 key
      recordInput.contributionPoints = args.contributionPoints;
    }
    const dto: CreateAttendanceSheetDto = { records: [recordInput] };
    const result = await ctx.service.submit(args.activityId, dto, ctx.submitterPayload, AUDIT_META);
    return result.id;
  }

  async function getOnlyRecord(sheetId: string): Promise<{
    contributionPoints: Prisma.Decimal | null;
  }> {
    const recs = await ctx.prisma.attendanceRecord.findMany({
      where: { sheetId, deletedAt: null },
      select: { contributionPoints: true },
    });
    expect(recs).toHaveLength(1);
    return recs[0];
  }

  function decimalToNumberOrNull(d: Prisma.Decimal | null): number | null {
    return d === null ? null : Number(d);
  }

  // ============ 8 个核心 case ============

  describe('核心 case', () => {
    beforeEach(isolateFixtures);

    it('Case 1:无匹配规则 → contributionPoints = 0', async () => {
      // 未创建任何 ContributionRule
      const activityId = await createActivity(ACTIVITY_TYPE_DEMO);

      const sheetId = await submitOne({
        activityId,
        roleCode: ROLE_MEMBER,
        serviceHours: 4,
        // 不传 contributionPoints → undefined → 走预填
      });

      const rec = await getOnlyRecord(sheetId);
      expect(decimalToNumberOrNull(rec.contributionPoints)).toBe(0);
    });

    it('Case 2:NULL 档位规则 → 取 pointsBelow(pointsAbove 不参与)', async () => {
      const activityId = await createActivity(ACTIVITY_TYPE_DEMO);
      await createRule({
        activityTypeCode: ACTIVITY_TYPE_DEMO,
        attendanceRoleCode: ROLE_MEMBER,
        durationThreshold: null,
        pointsBelow: 0.5,
        pointsAbove: null, // NULL 档位时不参与
        dailyCap: 3,
      });

      const sheetId = await submitOne({
        activityId,
        roleCode: ROLE_MEMBER,
        serviceHours: 6, // 任意合法值(NULL 档位忽略时长)
      });

      const rec = await getOnlyRecord(sheetId);
      expect(decimalToNumberOrNull(rec.contributionPoints)).toBe(0.5);
    });

    it('Case 3:有档位 + serviceHours <= durationThreshold → 取 pointsBelow', async () => {
      const activityId = await createActivity(ACTIVITY_TYPE_DEMO);
      await createRule({
        activityTypeCode: ACTIVITY_TYPE_DEMO,
        attendanceRoleCode: ROLE_MEMBER,
        durationThreshold: 4,
        pointsBelow: 0.5,
        pointsAbove: 1.0,
        dailyCap: 5, // 足够大,不命中
      });

      const sheetId = await submitOne({
        activityId,
        roleCode: ROLE_MEMBER,
        serviceHours: 4, // 等于阈值,走 <= 分支
      });

      const rec = await getOnlyRecord(sheetId);
      expect(decimalToNumberOrNull(rec.contributionPoints)).toBe(0.5);
    });

    it('Case 4:有档位 + serviceHours > durationThreshold → 取 pointsAbove', async () => {
      const activityId = await createActivity(ACTIVITY_TYPE_DEMO);
      await createRule({
        activityTypeCode: ACTIVITY_TYPE_DEMO,
        attendanceRoleCode: ROLE_MEMBER,
        durationThreshold: 4,
        pointsBelow: 0.5,
        pointsAbove: 1.0,
        dailyCap: 5, // 足够大,不命中
      });

      const sheetId = await submitOne({
        activityId,
        roleCode: ROLE_MEMBER,
        serviceHours: 5, // > 4,走 > 分支
      });

      const rec = await getOnlyRecord(sheetId);
      expect(decimalToNumberOrNull(rec.contributionPoints)).toBe(1.0);
    });

    it('Case 5:有档位 + pointsAbove = null + serviceHours > threshold → fallback pointsBelow', async () => {
      const activityId = await createActivity(ACTIVITY_TYPE_DEMO);
      await createRule({
        activityTypeCode: ACTIVITY_TYPE_DEMO,
        attendanceRoleCode: ROLE_MEMBER,
        durationThreshold: 4,
        pointsBelow: 0.5,
        pointsAbove: null, // > 分支 fallback 到 pointsBelow
        dailyCap: 5,
      });

      const sheetId = await submitOne({
        activityId,
        roleCode: ROLE_MEMBER,
        serviceHours: 5, // > 4
      });

      const rec = await getOnlyRecord(sheetId);
      expect(decimalToNumberOrNull(rec.contributionPoints)).toBe(0.5);
    });

    it('Case 6:dailyCap 不再每条封顶 → 预填 = 原始规则分(活动闭环硬化 2026-06-21)', async () => {
      const activityId = await createActivity(ACTIVITY_TYPE_DEMO);
      await createRule({
        activityTypeCode: ACTIVITY_TYPE_DEMO,
        attendanceRoleCode: ROLE_MEMBER,
        durationThreshold: 4,
        pointsBelow: 0.5,
        pointsAbove: 2.0,
        dailyCap: 1.2, // 旧:封顶 1.2;新:calculator 不再读 dailyCap,全局每日封顶改落 team-join 汇总处
      });

      const sheetId = await submitOne({
        activityId,
        roleCode: ROLE_MEMBER,
        serviceHours: 5,
      });

      const rec = await getOnlyRecord(sheetId);
      // candidate = 2.0;旧 MIN(2.0,1.2)=1.2,新不每条封顶 → 2.0
      expect(decimalToNumberOrNull(rec.contributionPoints)).toBe(2.0);
    });

    it('Case 7:dailyCap = null 也不再兜底默认值封顶 → 预填 = 原始规则分', async () => {
      const activityId = await createActivity(ACTIVITY_TYPE_DEMO);
      await createRule({
        activityTypeCode: ACTIVITY_TYPE_DEMO,
        attendanceRoleCode: ROLE_MEMBER,
        durationThreshold: 4,
        pointsBelow: 0.5,
        pointsAbove: 2.0,
        dailyCap: null,
      });

      const sheetId = await submitOne({
        activityId,
        roleCode: ROLE_MEMBER,
        serviceHours: 5,
      });

      const rec = await getOnlyRecord(sheetId);
      // candidate = 2.0;旧逻辑会按默认 cap 封顶,新逻辑不做每条封顶 → 2.0
      expect(decimalToNumberOrNull(rec.contributionPoints)).toBe(2.0);
    });

    it('Case 8:数据库拒绝同 pair 第二条 ACTIVE；合法单规则仍按原分值预填', async () => {
      const activityId = await createActivity(ACTIVITY_TYPE_DEMO);
      // D-RULE-1:durationThreshold 不再扩展 ACTIVE slot；第二条即使 threshold 不同也由 DB 拒绝。
      await createRule({
        activityTypeCode: ACTIVITY_TYPE_DEMO,
        attendanceRoleCode: ROLE_MEMBER,
        durationThreshold: null,
        pointsBelow: 0.4,
        pointsAbove: null,
        dailyCap: 3,
      });
      await expect(
        createRule({
          activityTypeCode: ACTIVITY_TYPE_DEMO,
          attendanceRoleCode: ROLE_MEMBER,
          durationThreshold: 4,
          pointsBelow: 0.9,
          pointsAbove: 1.2,
          dailyCap: 3,
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      const sheetId = await submitOne({
        activityId,
        roleCode: ROLE_MEMBER,
        serviceHours: 6,
      });

      const rec = await getOnlyRecord(sheetId);
      expect(decimalToNumberOrNull(rec.contributionPoints)).toBe(0.4);
    });
  });

  // ============ 3 个额外覆盖 case ============

  describe('额外覆盖(服务端权威重算 + 不误匹配)', () => {
    beforeEach(isolateFixtures);

    it('Case 9:绕过 HTTP DTO 传 null 也会被规则重算', async () => {
      const activityId = await createActivity(ACTIVITY_TYPE_DEMO);
      // service 直调绕过 ValidationPipe 时,旧字段也不能改写权威结果。
      await createRule({
        activityTypeCode: ACTIVITY_TYPE_DEMO,
        attendanceRoleCode: ROLE_MEMBER,
        durationThreshold: 4,
        pointsBelow: 0.5,
        pointsAbove: 1.0,
        dailyCap: 5,
      });

      const sheetId = await submitOne({
        activityId,
        roleCode: ROLE_MEMBER,
        serviceHours: 5,
        contributionPoints: null,
      });

      const rec = await getOnlyRecord(sheetId);
      expect(decimalToNumberOrNull(rec.contributionPoints)).toBe(1);
    });

    it('Case 10:绕过 HTTP DTO 传 number 也会被规则重算', async () => {
      const activityId = await createActivity(ACTIVITY_TYPE_DEMO);
      // 命中规则算出 1.0,旧手填 0.7 不能覆盖。
      await createRule({
        activityTypeCode: ACTIVITY_TYPE_DEMO,
        attendanceRoleCode: ROLE_MEMBER,
        durationThreshold: 4,
        pointsBelow: 0.5,
        pointsAbove: 1.0,
        dailyCap: 5,
      });

      const sheetId = await submitOne({
        activityId,
        roleCode: ROLE_MEMBER,
        serviceHours: 5,
        contributionPoints: 0.7,
      });

      const rec = await getOnlyRecord(sheetId);
      expect(decimalToNumberOrNull(rec.contributionPoints)).toBe(1);
    });

    it('Case 11:activityTypeCode / roleCode 不匹配 → 不误匹配规则 → 0', async () => {
      // 配规则:activityType=demo / role=member;但提交时 activityType=other / role=coach
      // 任一不匹配都应保持 null。本 case 同时改两个维度,保证规则查表 candidates 必为空。
      const activityIdOther = await createActivity(ACTIVITY_TYPE_OTHER);
      await createRule({
        activityTypeCode: ACTIVITY_TYPE_DEMO, // ≠ activity 的 activityTypeCode
        attendanceRoleCode: ROLE_MEMBER, // ≠ submit 时传的 ROLE_COACH
        durationThreshold: null,
        pointsBelow: 0.5,
        pointsAbove: null,
        dailyCap: 3,
      });

      const sheetId = await submitOne({
        activityId: activityIdOther,
        roleCode: ROLE_COACH,
        serviceHours: 4,
      });

      const rec = await getOnlyRecord(sheetId);
      expect(decimalToNumberOrNull(rec.contributionPoints)).toBe(0);
    });
  });
});
