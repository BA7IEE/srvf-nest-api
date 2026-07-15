import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivitiesService } from '../../src/modules/activities/activities.service';
import type { CreateActivityDto } from '../../src/modules/activities/activities.dto';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// activities state transitions characterization tests
// (god-service 拆分前置锁;沿 attendances / activity-registrations state-transition 范式)。
//
// 目标:在抽 `ActivityStateMachine` / `ActivityAuditRecorder` 之前,显式锁定
// `activities.service.ts` 当前状态机 + Q-A12 守卫 + softDelete D3 + 事务回滚的全部 invariant。
// 本 PR 严格 test-only(沿 docs/api-surface-policy.md §8 P1 禁止事项 +
// docs/architecture-boundary.md §8 deferred);**不**改 src/**,**不**抽任何 class。
//
// 测试策略选择(沿 activity-registrations-state-transition spec 范式):
//   - 选 service-level e2e(`test/e2e/*.e2e-spec.ts`)而非 unit spec:
//     * 项目 unit jest 配置无 DB,无法实测 `$transaction` / partial unique / audit 写入;
//     * `createTestApp()` + `app.get(ActivitiesService)` 直接调用 service 方法,
//       **绕过 HTTP / JwtAuthGuard / RolesGuard**,纯锁 service 层行为。
//   - 直接 Prisma seed 各起始状态(draft / published / cancelled / completed),
//     避免为造状态绕完整业务流程(create + publish + cancel 多步);
//     `completed` 状态在生产路径上仅由 activities 模块 `complete` action 推进；
//     attendances audit 中的 `activityPushedToCompleted` 仅作兼容字段且恒为 false。
//     本 spec 仅锁 `activities.service.ts` 自己持有的 3 条迁移 + Q-A12 守卫 + softDelete D3。
//   - audit failure rollback case 用 jest.spyOn(auditLogs, 'log').mockRejectedValueOnce 触发
//     auditLogs.log 抛错,断言 service throw + DB 无落库 + audit 不存在
//     (沿 activity-registrations-state-transition spec F1 范式)。
//
// 覆盖矩阵:
//   A. publish:draft → published 成功(audit `operation=publish` / `priorStatusCode=draft` /
//                                   `nextStatusCode=published`)+ 3 个 wrong source state
//   B. cancel:仅 draft / published → cancelled 成功；completed / cancelled 拒绝
//   C. update:draft / published 常规更新；completed / cancelled 仅允许展示字段白名单
//   D. softDelete:draft / published / cancelled 可删(D3:删除 ≠ 取消;statusCode 不被改写)
//   E. create:invalid dict / root organization / start≥end 三类失败 → 无 activity 行 / 无 audit
//   F. Audit failure rollback(create 路径)

type ActivityStatus = 'draft' | 'published' | 'cancelled' | 'completed';

const AUDIT_META: AuditMeta = {
  requestId: 'act-state-req-0000000000000001',
  ip: '127.0.0.1',
  ua: 'jest/30 activities-state-transition',
};

const ACTIVITY_RESOURCE_TYPE = 'activity';
const ACTIVITY_EVENT = 'activity.publish';

interface SeedContext {
  prisma: PrismaService;
  service: ActivitiesService;
  auditLogs: AuditLogsService;
  adminUserId: string;
  adminPayload: CurrentUserPayload;
  rootOrgId: string;
  childOrgId: string;
  activityTypeCode: string;
}

describe('ActivitiesService state transitions (characterization)', () => {
  let app: INestApplication;
  let ctx: SeedContext;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);

    const prisma = app.get(PrismaService);
    const service = app.get(ActivitiesService);
    const auditLogs = app.get(AuditLogsService);

    // Admin user(state-transition 全部走 ADMIN;无 self / RBAC 入参分支)
    const admin = await prisma.user.create({
      data: {
        username: 'act-state-admin',
        passwordHash: '$2a$10$dummy-hash-not-used-since-no-login-needed',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    });

    // Slow-4 T3(评审稿 §8 / D-S4-6):本 spec 直调 service(绕过 Guard),判权已下沉
    // service 层 rbac.can();给 ADMIN 测试用户 admin 补挂 biz-admin(零漂移:对应迁移前
    // @Roles(SUPER_ADMIN, ADMIN) 放行语义;断言零修改)。
    const bizSeed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, admin.id, bizSeed.bizAdminRoleId);

    // node_type 字典 + 根 / 子组织(根节点 parentId=null,activity 禁挂;沿 ARCHITECTURE R8 / D17)
    const nodeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'act-state-root', label: '根' },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'act-state-child', label: '子' },
    });
    const rootOrg = await prisma.organization.create({
      data: { name: 'Act State Root Org', nodeTypeCode: 'act-state-root', parentId: null },
      select: { id: true },
    });
    const childOrg = await prisma.organization.create({
      data: { name: 'Act State Child Org', nodeTypeCode: 'act-state-child', parentId: rootOrg.id },
      select: { id: true },
    });

    // activity_type 字典(create 路径校验需要 ACTIVE item)
    const actTypeDict = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    const actType = await prisma.dictItem.create({
      data: { typeId: actTypeDict.id, code: 'act-state-rotation', label: '演练' },
      select: { code: true },
    });

    ctx = {
      prisma,
      service,
      auditLogs,
      adminUserId: admin.id,
      adminPayload: {
        id: admin.id,
        username: 'act-state-admin',
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
        memberId: null,
      },
      rootOrgId: rootOrg.id,
      childOrgId: childOrg.id,
      activityTypeCode: actType.code,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // 每个 case 之间清:Activity + AuditLog;保留 User / Dict / Organization。
  async function isolateFixtures(): Promise<void> {
    await ctx.prisma.attendanceRecord.deleteMany({});
    await ctx.prisma.attendanceSheet.deleteMany({});
    await ctx.prisma.activityRegistration.deleteMany({});
    await ctx.prisma.activity.deleteMany({});
    await ctx.prisma.auditLog.deleteMany({});
  }

  // 直接 prisma seed 任意起始状态的 Activity(绕过 service 业务流)。
  // service 层的 4 种 statusCode 字面值 = DB 字符串列,Prisma 不做枚举校验,
  // 因此 'draft' / 'published' / 'cancelled' / 'completed' 都可直接 seed。
  async function seedActivity(opts: {
    statusCode: ActivityStatus;
    titleSuffix?: string;
  }): Promise<{ id: string; statusCode: ActivityStatus }> {
    const suffix = opts.titleSuffix ?? Math.random().toString(36).slice(2, 8);
    const row = await ctx.prisma.activity.create({
      data: {
        title: `Act State ${opts.statusCode} ${suffix}`,
        activityTypeCode: ctx.activityTypeCode,
        organizationId: ctx.childOrgId,
        startAt: new Date('2099-07-01T08:00:00.000Z'),
        endAt: new Date('2099-07-01T12:00:00.000Z'),
        location: '梧桐山',
        statusCode: opts.statusCode,
        // publishedBy/At + cancelledBy/At/Reason 在 seed 阶段不写;
        // 我们只锁状态机决策本身,不锁 seeded audit 时间字段
      },
      select: { id: true, statusCode: true },
    });
    return { id: row.id, statusCode: row.statusCode as ActivityStatus };
  }

  // 标准 CreateActivityDto(沿 activities.e2e-spec.ts baseCreatePayload 范式;
  // 必填 6 字段全部覆盖,可选字段保持默认未传)。
  function createDto(override: Partial<CreateActivityDto> = {}): CreateActivityDto {
    return {
      title: '审计形状测试活动',
      activityTypeCode: ctx.activityTypeCode,
      organizationId: ctx.childOrgId,
      startAt: '2099-07-01T08:00:00.000Z',
      endAt: '2099-07-01T12:00:00.000Z',
      location: '梧桐山',
      ...override,
    };
  }

  // ============ A. publish(draft → published) ============
  describe('A. publish (draft → published)', () => {
    beforeEach(isolateFixtures);

    it('A1. 成功:返 published + DB statusCode/publishedBy/publishedAt 落库 + audit activity.publish (operation=publish, priorStatusCode=draft, nextStatusCode=published)', async () => {
      const seed = await seedActivity({ statusCode: 'draft' });

      const result = await ctx.service.publish(
        seed.id,
        { requiresInsuranceConfirmed: true },
        ctx.adminPayload,
        AUDIT_META,
      );

      expect(result.statusCode).toBe('published');
      expect(result.publishedBy).toBe(ctx.adminUserId);
      expect(result.publishedAt).not.toBeNull();
      // 取消相关字段保持未触碰(沿 batch3 schema 设计:publish 不写 cancelled* 字段)
      expect(result.cancelledBy).toBeNull();
      expect(result.cancelledAt).toBeNull();
      expect(result.cancelReason).toBeNull();

      // DB 反向断言
      const db = await ctx.prisma.activity.findUniqueOrThrow({
        where: { id: seed.id },
        select: {
          statusCode: true,
          publishedBy: true,
          publishedAt: true,
          cancelledBy: true,
          cancelledAt: true,
          cancelReason: true,
        },
      });
      expect(db.statusCode).toBe('published');
      expect(db.publishedBy).toBe(ctx.adminUserId);
      expect(db.publishedAt).not.toBeNull();
      expect(db.cancelledBy).toBeNull();
      expect(db.cancelledAt).toBeNull();
      expect(db.cancelReason).toBeNull();

      // audit:1 条,event = activity.publish,extra.operation = publish
      const audits = await ctx.prisma.auditLog.findMany({
        where: { resourceId: seed.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      expect(a.event).toBe(ACTIVITY_EVENT);
      expect(a.resourceType).toBe(ACTIVITY_RESOURCE_TYPE);
      const c = a.context as {
        extra?: { operation?: string; priorStatusCode?: string; nextStatusCode?: string };
      };
      expect(c.extra?.operation).toBe('publish');
      expect(c.extra?.priorStatusCode).toBe('draft');
      expect(c.extra?.nextStatusCode).toBe('published');
    });

    it.each<ActivityStatus>(['published', 'cancelled', 'completed'])(
      'A2. wrong source %s → ACTIVITY_STATUS_INVALID,DB status 不变,无 audit',
      async (fromStatus) => {
        const seed = await seedActivity({ statusCode: fromStatus });

        await expect(
          ctx.service.publish(
            seed.id,
            { requiresInsuranceConfirmed: true },
            ctx.adminPayload,
            AUDIT_META,
          ),
        ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_STATUS_INVALID });

        const db = await ctx.prisma.activity.findUniqueOrThrow({
          where: { id: seed.id },
          select: { statusCode: true, publishedBy: true, publishedAt: true },
        });
        expect(db.statusCode).toBe(fromStatus);
        // publishedBy/At seed 阶段未写,publish 拒后也不应被写
        expect(db.publishedBy).toBeNull();
        expect(db.publishedAt).toBeNull();

        // 无 audit 写入
        const audits = await ctx.prisma.auditLog.findMany({
          where: { resourceId: seed.id },
        });
        expect(audits).toHaveLength(0);
      },
    );

    it('A3. 同一 draft 并发 publish 两次 → 恰一方成功,败者 ACTIVITY_STATUS_INVALID', async () => {
      const seed = await seedActivity({ statusCode: 'draft', titleSuffix: 'publish-race' });

      const results = await Promise.allSettled([
        ctx.service.publish(
          seed.id,
          { requiresInsuranceConfirmed: true },
          ctx.adminPayload,
          AUDIT_META,
        ),
        ctx.service.publish(
          seed.id,
          { requiresInsuranceConfirmed: true },
          ctx.adminPayload,
          AUDIT_META,
        ),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        status: 'rejected',
        reason: { biz: BizCode.ACTIVITY_STATUS_INVALID },
      });
      expect(
        await ctx.prisma.activity.findUniqueOrThrow({
          where: { id: seed.id },
          select: { statusCode: true },
        }),
      ).toEqual({ statusCode: 'published' });
      expect(await ctx.prisma.auditLog.count({ where: { resourceId: seed.id } })).toBe(1);
    });
  });

  // ============ B. cancel(仅 draft|published → cancelled) ============
  describe('B. cancel (only draft|published → cancelled)', () => {
    beforeEach(isolateFixtures);

    it.each<ActivityStatus>(['draft', 'published'])(
      'B1. %s → cancelled 成功 + cancelledBy/At/Reason 落库 + audit (operation=cancel)',
      async (fromStatus) => {
        const seed = await seedActivity({ statusCode: fromStatus });

        const result = await ctx.service.cancel(
          seed.id,
          { cancelReason: '雨天延期' },
          ctx.adminPayload,
          AUDIT_META,
        );

        expect(result.statusCode).toBe('cancelled');
        expect(result.cancelledBy).toBe(ctx.adminUserId);
        expect(result.cancelledAt).not.toBeNull();
        expect(result.cancelReason).toBe('雨天延期');

        const db = await ctx.prisma.activity.findUniqueOrThrow({
          where: { id: seed.id },
          select: {
            statusCode: true,
            cancelledBy: true,
            cancelledAt: true,
            cancelReason: true,
          },
        });
        expect(db.statusCode).toBe('cancelled');
        expect(db.cancelledBy).toBe(ctx.adminUserId);
        expect(db.cancelledAt).not.toBeNull();
        expect(db.cancelReason).toBe('雨天延期');

        const audits = await ctx.prisma.auditLog.findMany({
          where: { resourceId: seed.id },
        });
        expect(audits).toHaveLength(1);
        const c = audits[0].context as {
          extra?: { operation?: string; priorStatusCode?: string; nextStatusCode?: string };
        };
        expect(c.extra?.operation).toBe('cancel');
        expect(c.extra?.priorStatusCode).toBe(fromStatus);
        expect(c.extra?.nextStatusCode).toBe('cancelled');
      },
    );

    it.each<ActivityStatus>(['completed', 'cancelled'])(
      'B2. %s → cancel 拒绝 → ACTIVITY_STATUS_INVALID,DB 不变,无 audit',
      async (fromStatus) => {
        const seed = await seedActivity({ statusCode: fromStatus });

        await expect(
          ctx.service.cancel(seed.id, {}, ctx.adminPayload, AUDIT_META),
        ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_STATUS_INVALID });

        const db = await ctx.prisma.activity.findUniqueOrThrow({
          where: { id: seed.id },
          select: { statusCode: true, cancelledBy: true, cancelReason: true },
        });
        expect(db.statusCode).toBe(fromStatus);
        // seed 阶段未写 cancelledBy / cancelReason;cancel 拒后也不应被写
        expect(db.cancelledBy).toBeNull();
        expect(db.cancelReason).toBeNull();

        const audits = await ctx.prisma.auditLog.findMany({ where: { resourceId: seed.id } });
        expect(audits).toHaveLength(0);
      },
    );

    it('cancel 批量取消 pending、保留 pass，并在 audit 记录汇总数', async () => {
      const seed = await seedActivity({ statusCode: 'published' });
      const members = await Promise.all(
        ['pending', 'pass'].map((statusCode) =>
          ctx.prisma.member.create({
            data: {
              memberNo: `act-cancel-${statusCode}-${Math.random().toString(36).slice(2, 8)}`,
              displayName: `Cancel ${statusCode}`,
            },
          }),
        ),
      );
      await ctx.prisma.activityRegistration.createMany({
        data: [
          { activityId: seed.id, memberId: members[0].id, statusCode: 'pending' },
          { activityId: seed.id, memberId: members[1].id, statusCode: 'pass' },
        ],
      });

      await ctx.service.cancel(seed.id, { cancelReason: '天气原因' }, ctx.adminPayload, AUDIT_META);

      const rows = await ctx.prisma.activityRegistration.findMany({
        where: { activityId: seed.id },
        orderBy: { memberId: 'asc' },
      });
      const pending = rows.find((row) => row.memberId === members[0].id)!;
      const passed = rows.find((row) => row.memberId === members[1].id)!;
      expect(pending).toMatchObject({ statusCode: 'cancelled', cancelReason: '活动已取消' });
      expect(passed.statusCode).toBe('pass');
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { resourceId: seed.id },
      });
      expect((audit.context as { extra?: Record<string, unknown> }).extra).toMatchObject({
        pendingRegistrationsCancelled: 1,
      });
    });
  });

  // ============ C. update(终态仅展示字段可改) ============
  describe('C. update (terminal display-only whitelist)', () => {
    beforeEach(isolateFixtures);

    it.each<ActivityStatus>(['draft', 'published'])(
      'C1. %s 可 update 成功 + audit (operation=update, statusCode 不变)',
      async (fromStatus) => {
        const seed = await seedActivity({ statusCode: fromStatus });

        const result = await ctx.service.update(
          seed.id,
          { title: '更新后标题' },
          ctx.adminPayload,
          AUDIT_META,
        );

        expect(result.title).toBe('更新后标题');
        // update 不改 statusCode(沿 service 现状;statusCode 由 publish / cancel 接口写入)
        expect(result.statusCode).toBe(fromStatus);

        const db = await ctx.prisma.activity.findUniqueOrThrow({
          where: { id: seed.id },
          select: { title: true, statusCode: true },
        });
        expect(db.title).toBe('更新后标题');
        expect(db.statusCode).toBe(fromStatus);

        const audits = await ctx.prisma.auditLog.findMany({ where: { resourceId: seed.id } });
        expect(audits).toHaveLength(1);
        const c = audits[0].context as { extra?: { operation?: string; priorStatusCode?: string } };
        expect(c.extra?.operation).toBe('update');
        expect(c.extra?.priorStatusCode).toBe(fromStatus);
      },
    );

    it.each<ActivityStatus>(['completed', 'cancelled'])(
      'C2. %s → description 展示字段允许修改',
      async (fromStatus) => {
        const seed = await seedActivity({ statusCode: fromStatus });
        const result = await ctx.service.update(
          seed.id,
          { description: '终态展示说明更新' },
          ctx.adminPayload,
          AUDIT_META,
        );
        expect(result.description).toBe('终态展示说明更新');
        expect(result.statusCode).toBe(fromStatus);
      },
    );

    it.each<ActivityStatus>(['completed', 'cancelled'])(
      'C3. %s → factual 字段拒绝,DB 不变,无 audit',
      async (fromStatus) => {
        const seed = await seedActivity({ statusCode: fromStatus, titleSuffix: 'terminal-target' });
        const original = await ctx.prisma.activity.findUniqueOrThrow({
          where: { id: seed.id },
          select: { title: true, location: true },
        });

        await expect(
          ctx.service.update(
            seed.id,
            { title: '试图修改', location: '试图修改地点' },
            ctx.adminPayload,
            AUDIT_META,
          ),
        ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_STATUS_INVALID });

        const db = await ctx.prisma.activity.findUniqueOrThrow({
          where: { id: seed.id },
          select: { title: true, location: true, statusCode: true },
        });
        expect(db.title).toBe(original.title);
        expect(db.location).toBe(original.location);
        expect(db.statusCode).toBe(fromStatus);

        const audits = await ctx.prisma.auditLog.findMany({ where: { resourceId: seed.id } });
        expect(audits).toHaveLength(0);
      },
    );
  });

  // ============ D. softDelete(D3:删除 ≠ 取消;任意状态可软删) ============
  describe('D. softDelete (D3: delete ≠ cancel; any source state allowed)', () => {
    beforeEach(isolateFixtures);

    it.each<ActivityStatus>(['draft', 'published', 'cancelled'])(
      'D1. %s 可 softDelete:deletedAt 写入 + statusCode 不变 + cancelledBy 不被误写 + audit (operation=softDelete)',
      async (fromStatus) => {
        const seed = await seedActivity({ statusCode: fromStatus });

        await ctx.service.softDelete(seed.id, ctx.adminPayload, AUDIT_META);

        const db = await ctx.prisma.activity.findUniqueOrThrow({
          where: { id: seed.id },
          select: {
            statusCode: true,
            deletedAt: true,
            cancelledBy: true,
            cancelledAt: true,
            cancelReason: true,
          },
        });
        expect(db.deletedAt).not.toBeNull();
        // 关键不变量:softDelete 不把 statusCode 改写为 cancelled(D3:删除 ≠ 取消)
        expect(db.statusCode).toBe(fromStatus);
        // softDelete 不写 cancelled 三字段(若 seed 状态非 cancelled)
        if (fromStatus !== 'cancelled') {
          expect(db.cancelledBy).toBeNull();
          expect(db.cancelledAt).toBeNull();
          expect(db.cancelReason).toBeNull();
        }

        const audits = await ctx.prisma.auditLog.findMany({ where: { resourceId: seed.id } });
        expect(audits).toHaveLength(1);
        const a = audits[0];
        expect(a.event).toBe(ACTIVITY_EVENT);
        const c = a.context as { extra?: { operation?: string; priorStatusCode?: string } };
        expect(c.extra?.operation).toBe('softDelete');
        expect(c.extra?.priorStatusCode).toBe(fromStatus);
      },
    );

    it.each(['pending', 'pass'])('%s 报名存在 → softDelete 拒 20127', async (statusCode) => {
      const seed = await seedActivity({ statusCode: 'published' });
      const member = await ctx.prisma.member.create({
        data: {
          memberNo: `act-del-${statusCode}-${Math.random().toString(36).slice(2, 8)}`,
          displayName: 'Delete Guard Member',
        },
      });
      await ctx.prisma.activityRegistration.create({
        data: { activityId: seed.id, memberId: member.id, statusCode },
      });

      await expect(
        ctx.service.softDelete(seed.id, ctx.adminPayload, AUDIT_META),
      ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_PARTICIPATION_EXISTS_DELETE_FORBIDDEN });
    });

    it('reject/cancelled 报名不挡删，但任意未软删考勤单挡删', async () => {
      const seed = await seedActivity({ statusCode: 'published' });
      const members = await Promise.all(
        ['reject', 'cancelled'].map((statusCode) =>
          ctx.prisma.member.create({
            data: {
              memberNo: `act-del-${statusCode}-${Math.random().toString(36).slice(2, 8)}`,
              displayName: `Delete Guard ${statusCode}`,
            },
          }),
        ),
      );
      await ctx.prisma.activityRegistration.createMany({
        data: members.map((member, index) => ({
          activityId: seed.id,
          memberId: member.id,
          statusCode: index === 0 ? 'reject' : 'cancelled',
        })),
      });
      const sheet = await ctx.prisma.attendanceSheet.create({
        data: {
          activityId: seed.id,
          submitterUserId: ctx.adminUserId,
          statusCode: 'pending',
        },
      });
      await expect(
        ctx.service.softDelete(seed.id, ctx.adminPayload, AUDIT_META),
      ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_PARTICIPATION_EXISTS_DELETE_FORBIDDEN });

      await ctx.prisma.attendanceSheet.update({
        where: { id: sheet.id },
        data: { deletedAt: new Date() },
      });
      await expect(
        ctx.service.softDelete(seed.id, ctx.adminPayload, AUDIT_META),
      ).resolves.toMatchObject({ id: seed.id });
    });
  });

  // ============ E. create 失败:无 DB / 无 audit ============
  describe('E. create failure (invalid dict / root org / start>=end) → no DB / no audit', () => {
    beforeEach(isolateFixtures);

    it('E1. invalid activityTypeCode → ACTIVITY_TYPE_CODE_INVALID,无 activity 行 / 无 audit', async () => {
      const beforeCount = await ctx.prisma.activity.count();
      const beforeAuditCount = await ctx.prisma.auditLog.count({
        where: { event: ACTIVITY_EVENT },
      });

      await expect(
        ctx.service.create(
          createDto({ activityTypeCode: 'no-such-type' }),
          ctx.adminPayload,
          AUDIT_META,
        ),
      ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TYPE_CODE_INVALID });

      expect(await ctx.prisma.activity.count()).toBe(beforeCount);
      const afterAuditCount = await ctx.prisma.auditLog.count({
        where: { event: ACTIVITY_EVENT },
      });
      expect(afterAuditCount).toBe(beforeAuditCount);
    });

    it('E2. root organization (parentId=null) → ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN,无 activity 行 / 无 audit', async () => {
      const beforeCount = await ctx.prisma.activity.count();
      const beforeAuditCount = await ctx.prisma.auditLog.count({
        where: { event: ACTIVITY_EVENT },
      });

      await expect(
        ctx.service.create(
          createDto({ organizationId: ctx.rootOrgId }),
          ctx.adminPayload,
          AUDIT_META,
        ),
      ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN });

      expect(await ctx.prisma.activity.count()).toBe(beforeCount);
      expect(await ctx.prisma.auditLog.count({ where: { event: ACTIVITY_EVENT } })).toBe(
        beforeAuditCount,
      );
    });

    it('E3. startAt >= endAt → ACTIVITY_START_END_INVALID,无 activity 行 / 无 audit', async () => {
      const beforeCount = await ctx.prisma.activity.count();
      const beforeAuditCount = await ctx.prisma.auditLog.count({
        where: { event: ACTIVITY_EVENT },
      });

      await expect(
        ctx.service.create(
          createDto({
            startAt: '2026-07-01T12:00:00.000Z',
            endAt: '2026-07-01T12:00:00.000Z',
          }),
          ctx.adminPayload,
          AUDIT_META,
        ),
      ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_START_END_INVALID });

      expect(await ctx.prisma.activity.count()).toBe(beforeCount);
      expect(await ctx.prisma.auditLog.count({ where: { event: ACTIVITY_EVENT } })).toBe(
        beforeAuditCount,
      );
    });
  });

  // ============ F. Audit failure rollback ============
  describe('F. Audit failure rollback', () => {
    beforeEach(isolateFixtures);

    it('F1. create 路径 AuditLogsService.log 抛错 → $transaction 回滚:无新 activity + 无 audit (D-S7 红线)', async () => {
      const beforeCount = await ctx.prisma.activity.count();

      const logSpy = jest
        .spyOn(ctx.auditLogs, 'log')
        .mockRejectedValueOnce(new Error('simulated audit failure'));

      await expect(ctx.service.create(createDto(), ctx.adminPayload, AUDIT_META)).rejects.toThrow(
        'simulated audit failure',
      );

      expect(logSpy).toHaveBeenCalledTimes(1);

      // 回滚证据 1:无新 activity 行(tx.activity.create 已发起但 $transaction 回滚)
      const afterCount = await ctx.prisma.activity.count();
      expect(afterCount).toBe(beforeCount);

      // 回滚证据 2:无 audit 落库(本次唯一一次 log 调用被 mock reject,Prisma 不会真的写入)
      const audits = await ctx.prisma.auditLog.findMany({
        where: { event: ACTIVITY_EVENT },
      });
      expect(audits).toHaveLength(0);
    });
  });

  // ============ G. complete(v0.40.0 管理端手动完结;published → completed) ============
  describe('G. complete (published → completed)', () => {
    beforeEach(isolateFixtures);

    it('G1. 成功:published → completed + audit activity.publish (operation=complete, priorStatusCode=published, nextStatusCode=completed)', async () => {
      const seed = await seedActivity({ statusCode: 'published' });

      const result = await ctx.service.complete(seed.id, ctx.adminPayload, AUDIT_META);

      expect(result.statusCode).toBe('completed');

      const db = await ctx.prisma.activity.findUniqueOrThrow({
        where: { id: seed.id },
        select: { statusCode: true },
      });
      expect(db.statusCode).toBe('completed');

      const audits = await ctx.prisma.auditLog.findMany({
        where: { resourceId: seed.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits).toHaveLength(1);
      const a = audits[0];
      expect(a.event).toBe(ACTIVITY_EVENT);
      const c = a.context as {
        extra?: { operation?: string; priorStatusCode?: string; nextStatusCode?: string };
      };
      expect(c.extra?.operation).toBe('complete');
      expect(c.extra?.priorStatusCode).toBe('published');
      expect(c.extra?.nextStatusCode).toBe('completed');
    });

    it.each<ActivityStatus>(['draft', 'cancelled', 'completed'])(
      'G2. wrong source %s → ACTIVITY_STATUS_INVALID,DB status 不变,无 audit',
      async (fromStatus) => {
        const seed = await seedActivity({ statusCode: fromStatus });

        await expect(
          ctx.service.complete(seed.id, ctx.adminPayload, AUDIT_META),
        ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_STATUS_INVALID });

        const db = await ctx.prisma.activity.findUniqueOrThrow({
          where: { id: seed.id },
          select: { statusCode: true },
        });
        expect(db.statusCode).toBe(fromStatus);

        const audits = await ctx.prisma.auditLog.findMany({ where: { resourceId: seed.id } });
        expect(audits).toHaveLength(0);
      },
    );
  });
});
