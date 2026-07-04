import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ACTION_STATE_REASON_VALUES } from '../../src/modules/authz/authz.dto';
import type { ActionStateReason } from '../../src/modules/authz/action-state-checks';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// F3/C3「authz/action-state/batch」e2e(2026-07-04;冻结路线图 admin-api-fe-integration-roadmap.md
// §4 C3 + D8)。覆盖:判权门 / 判定对象=调用者本人 / allowed = authz ∧ 状态机只读
// (state_forbidden 各资源型代表例:「考勤已终审→不可再终审」「活动已取消→不可再取消」「报名已过审→不可再批」)
// / deny 原样归因(no_permission / resource_not_found)/ 未注册 action 走 authz-only /
// 入参校验(>200 / type ∉ 11 类 / action 非法 → 400)/ reason 枚举完备双向锁
// (ACTION_STATE_REASON_VALUES = authz 11 值 ∪ state_forbidden 入 OpenAPI 契约)。
// 判权语义零新增:authz 部分(含自审/同人约束)由 AuthzService.explain 原样承载,其矩阵锁在
// authz-explain / authz-three-source e2e;此处只锁组合闸自身行为。

const BATCH_PATH = '/api/admin/v1/authz/action-state/batch';
const NONEXISTENT_ID = 'cl0nexistsheet0000000000x';

const ACTION_STATE_CODE = 'authz.action-state.decision';

async function seedActionStateCodeAndBind(
  prisma: PrismaService,
  opsAdminRoleId: string,
): Promise<void> {
  const perm = await prisma.permission.upsert({
    where: { code: ACTION_STATE_CODE },
    update: {},
    create: {
      code: ACTION_STATE_CODE,
      module: 'authz',
      action: 'action-state',
      resourceType: 'decision',
    },
    select: { id: true },
  });
  await prisma.rolePermission.createMany({
    data: [{ roleId: opsAdminRoleId, permissionId: perm.id }],
    skipDuplicates: true,
  });
}

// reason 完备性 Record 锁(镜像 authz-explain e2e 范式):联合类型每个值必须出现在数组里,
// 数组每个值必须属于联合 —— 任一方向漂移,编译立即红。
const REASON_COMPLETENESS: Record<ActionStateReason, true> = {
  super_admin_pass: true,
  matched: true,
  no_permission: true,
  out_of_scope: true,
  out_of_supervised_scope: true,
  expired_grant: true,
  inactive_org: true,
  self_approval_forbidden: true,
  same_reviewer_forbidden: true,
  sensitive_denied: true,
  resource_not_found: true,
  state_forbidden: true,
};

describe('F3/C3 authz/action-state/batch(批量业务态闸)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let saAuth: string; // SUPER_ADMIN(rbac 短路可调;authz 走 super_admin_pass + 状态层仍咬合)
  let opsAuth: string; // ADMIN + ops-admin(持 action-state 码;无 attendance 业务码 → no_permission)
  let plainAdminAuth: string;

  let submitterUserId: string; // 单据提交人(≠ 任何调用者;避免自审约束干扰状态层用例)
  let sheetPendingId: string;
  let sheetPendingFinalId: string;
  let activityPublishedId: string;
  let activityCancelledId: string;
  let regPendingId: string;
  let regPassId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'ast-sa', role: Role.SUPER_ADMIN });
    const admin = await createTestUser(app, { username: 'ast-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'ast-adm-plain', role: Role.ADMIN });
    const submitter = await createTestUser(app, { username: 'ast-submitter', role: Role.ADMIN });
    submitterUserId = submitter.id;
    saAuth = (await loginAs(app, 'ast-sa')).authHeader;
    opsAuth = (await loginAs(app, 'ast-adm')).authHeader;
    plainAdminAuth = (await loginAs(app, 'ast-adm-plain')).authHeader;

    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    await seedActionStateCodeAndBind(prisma, seed.opsAdminRoleId);
    await grantOpsAdminToUser(app, admin.id, seed.opsAdminRoleId);

    // participation 基线:org → activities(published / cancelled)→ sheets / registrations
    const org = await prisma.organization.create({
      data: { name: 'AST Org', nodeTypeCode: 'rescue-team' },
      select: { id: true },
    });
    const mkActivity = (title: string, statusCode: string) =>
      prisma.activity.create({
        data: {
          title,
          activityTypeCode: 'general',
          organizationId: org.id,
          startAt: new Date('2026-06-01T00:00:00.000Z'),
          endAt: new Date('2026-06-01T08:00:00.000Z'),
          location: 'AST',
          statusCode,
        },
        select: { id: true },
      });
    const actPublished = await mkActivity('AST 已发布活动', 'published');
    const actCancelled = await mkActivity('AST 已取消活动', 'cancelled');
    activityPublishedId = actPublished.id;
    activityCancelledId = actCancelled.id;

    const sheetPending = await prisma.attendanceSheet.create({
      data: { activityId: actPublished.id, submitterUserId, statusCode: 'pending' },
      select: { id: true },
    });
    const sheetPendingFinal = await prisma.attendanceSheet.create({
      data: { activityId: actPublished.id, submitterUserId, statusCode: 'pending_final_review' },
      select: { id: true },
    });
    sheetPendingId = sheetPending.id;
    sheetPendingFinalId = sheetPendingFinal.id;

    const member = await prisma.member.create({
      data: { memberNo: 'ast-m1', displayName: 'AST 队员甲' },
      select: { id: true },
    });
    const regPending = await prisma.activityRegistration.create({
      data: { activityId: actPublished.id, memberId: member.id, statusCode: 'pending' },
      select: { id: true },
    });
    regPendingId = regPending.id;
    const member2 = await prisma.member.create({
      data: { memberNo: 'ast-m2', displayName: 'AST 队员乙' },
      select: { id: true },
    });
    const regPass = await prisma.activityRegistration.create({
      data: { activityId: actPublished.id, memberId: member2.id, statusCode: 'pass' },
      select: { id: true },
    });
    regPassId = regPass.id;
  });

  afterAll(async () => {
    await app.close();
  });

  function postBatch(auth: string, items: Array<Record<string, unknown>>) {
    return request(httpServer(app)).post(BATCH_PATH).set('Authorization', auth).send({ items });
  }

  // ============ 判权门 ============

  describe('判权门(authz.action-state.decision)', () => {
    it('未登录 → 401;裸 ADMIN → 30100;SUPER_ADMIN 短路可调', async () => {
      expectBizError(
        await request(httpServer(app))
          .post(BATCH_PATH)
          .send({
            items: [
              {
                action: 'attendance.read.sheet',
                resourceType: 'attendance_sheet',
                resourceId: sheetPendingId,
              },
            ],
          }),
        BizCode.UNAUTHORIZED,
      );
      expectBizError(
        await postBatch(plainAdminAuth, [
          {
            action: 'attendance.read.sheet',
            resourceType: 'attendance_sheet',
            resourceId: sheetPendingId,
          },
        ]),
        BizCode.RBAC_FORBIDDEN,
      );
      const sa = await postBatch(saAuth, [
        {
          action: 'attendance.read.sheet',
          resourceType: 'attendance_sheet',
          resourceId: sheetPendingId,
        },
      ]);
      expect(sa.status).toBe(200);
    });
  });

  // ============ allowed = authz ∧ 状态机(SA 调用者:判权恒过 → 隔离状态层) ============

  describe('状态机只读复核(state_forbidden 各资源型;SA 调用者隔离状态层)', () => {
    it('attendance:pending_final_review 可终审;pending 不可终审(state_forbidden)但可一级审', async () => {
      const res = await postBatch(saAuth, [
        {
          action: 'attendance.final-approve.sheet',
          resourceType: 'attendance_sheet',
          resourceId: sheetPendingFinalId,
        },
        {
          action: 'attendance.final-approve.sheet',
          resourceType: 'attendance_sheet',
          resourceId: sheetPendingId,
        },
        {
          action: 'attendance.approve.sheet',
          resourceType: 'attendance_sheet',
          resourceId: sheetPendingId,
        },
      ]);
      expect(res.status).toBe(200);
      const items = res.body.data.items;
      expect(items[0]).toEqual({
        action: 'attendance.final-approve.sheet',
        resourceId: sheetPendingFinalId,
        allowed: true,
        reason: 'super_admin_pass',
      });
      expect(items[1]).toEqual({
        action: 'attendance.final-approve.sheet',
        resourceId: sheetPendingId,
        allowed: false,
        reason: 'state_forbidden',
      });
      expect(items[2]).toMatchObject({ allowed: true });
    });

    it('activity:「活动已取消 → 不可再 update/cancel」;published 可 cancel;draft 才可 publish', async () => {
      const res = await postBatch(saAuth, [
        {
          action: 'activity.cancel.record',
          resourceType: 'activity',
          resourceId: activityCancelledId,
        },
        {
          action: 'activity.update.record',
          resourceType: 'activity',
          resourceId: activityCancelledId,
        },
        {
          action: 'activity.cancel.record',
          resourceType: 'activity',
          resourceId: activityPublishedId,
        },
        {
          action: 'activity.publish.record',
          resourceType: 'activity',
          resourceId: activityPublishedId,
        },
      ]);
      const items = res.body.data.items;
      expect(items[0]).toMatchObject({ allowed: false, reason: 'state_forbidden' });
      expect(items[1]).toMatchObject({ allowed: false, reason: 'state_forbidden' });
      expect(items[2]).toMatchObject({ allowed: true });
      expect(items[3]).toMatchObject({ allowed: false, reason: 'state_forbidden' });
    });

    it('activity_registration:pending 可批;pass 不可再批(state_forbidden)但可 cancel', async () => {
      const res = await postBatch(saAuth, [
        {
          action: 'activity-registration.approve.record',
          resourceType: 'activity_registration',
          resourceId: regPendingId,
        },
        {
          action: 'activity-registration.approve.record',
          resourceType: 'activity_registration',
          resourceId: regPassId,
        },
        {
          action: 'activity-registration.cancel.record',
          resourceType: 'activity_registration',
          resourceId: regPassId,
        },
      ]);
      const items = res.body.data.items;
      expect(items[0]).toMatchObject({ allowed: true });
      expect(items[1]).toMatchObject({ allowed: false, reason: 'state_forbidden' });
      expect(items[2]).toMatchObject({ allowed: true });
    });

    it('未注册 action(attendance.read.sheet)零状态校验:approved 等任意态照常 allow', async () => {
      const res = await postBatch(saAuth, [
        {
          action: 'attendance.read.sheet',
          resourceType: 'attendance_sheet',
          resourceId: sheetPendingId,
        },
      ]);
      expect(res.body.data.items[0]).toMatchObject({ allowed: true, reason: 'super_admin_pass' });
    });
  });

  // ============ authz deny 原样归因(判权先于状态层) ============

  describe('authz deny 原样归因(11 值;状态层不掩盖判权结论)', () => {
    it('ops-admin 调用者无 attendance 业务码:pending_final_review 单据仍 no_permission(非 state_forbidden)', async () => {
      const res = await postBatch(opsAuth, [
        {
          action: 'attendance.final-approve.sheet',
          resourceType: 'attendance_sheet',
          resourceId: sheetPendingFinalId,
        },
      ]);
      expect(res.body.data.items[0]).toEqual({
        action: 'attendance.final-approve.sheet',
        resourceId: sheetPendingFinalId,
        allowed: false,
        reason: 'no_permission',
      });
    });

    it('资源不存在:非 SA → resource_not_found(200 数据);SA 短路不被解析失败掀翻(沿 PR8 §5.2 行为锁)', async () => {
      const nonSa = await postBatch(opsAuth, [
        {
          action: 'attendance.read.sheet',
          resourceType: 'attendance_sheet',
          resourceId: NONEXISTENT_ID,
        },
      ]);
      expect(nonSa.body.data.items[0]).toMatchObject({
        allowed: false,
        reason: 'resource_not_found',
      });

      // SA:explain 短路路径「资源仅为约束解析,解析失败不掀翻短路」→ super_admin_pass;
      // 状态层判不了(无 resource)不判 —— 本端点纯消费 explain,不为批量壳新增 fail-close 语义。
      const sa = await postBatch(saAuth, [
        {
          action: 'attendance.read.sheet',
          resourceType: 'attendance_sheet',
          resourceId: NONEXISTENT_ID,
        },
      ]);
      expect(sa.body.data.items[0]).toMatchObject({ allowed: true, reason: 'super_admin_pass' });
    });

    it('SA 自审约束穿透短路:自己提交的单据 final-approve → self_approval_forbidden(判权层否决,不进状态层)', async () => {
      const saUser = await prisma.user.findFirstOrThrow({
        where: { username: 'ast-sa' },
        select: { id: true },
      });
      const ownSheet = await prisma.attendanceSheet.create({
        data: {
          activityId: activityPublishedId,
          submitterUserId: saUser.id,
          statusCode: 'pending_final_review',
        },
        select: { id: true },
      });
      const res = await postBatch(saAuth, [
        {
          action: 'attendance.final-approve.sheet',
          resourceType: 'attendance_sheet',
          resourceId: ownSheet.id,
        },
      ]);
      expect(res.body.data.items[0]).toMatchObject({
        allowed: false,
        reason: 'self_approval_forbidden',
      });
    });
  });

  // ============ 入参校验 + 枚举契约 ============

  describe('入参校验与 reason 枚举契约', () => {
    it('>200 / 空 items / action 非法 / type ∉ 11 类 → 400', async () => {
      const tooMany = Array.from({ length: 201 }, () => ({
        action: 'attendance.read.sheet',
        resourceType: 'attendance_sheet',
        resourceId: sheetPendingId,
      }));
      const lax = { strictMessage: false } as const;
      expectBizError(await postBatch(saAuth, tooMany), BizCode.BAD_REQUEST, lax);
      expectBizError(await postBatch(saAuth, []), BizCode.BAD_REQUEST, lax);
      expectBizError(
        await postBatch(saAuth, [
          { action: 'BAD', resourceType: 'attendance_sheet', resourceId: sheetPendingId },
        ]),
        BizCode.BAD_REQUEST,
        lax,
      );
      expectBizError(
        await postBatch(saAuth, [
          { action: 'attendance.read.sheet', resourceType: 'bogus', resourceId: sheetPendingId },
        ]),
        BizCode.BAD_REQUEST,
        lax,
      );
    });

    it('reason 枚举 = authz 11 值 ∪ state_forbidden(双向:Record 完备锁 + 数组值集)', () => {
      expect(Object.keys(REASON_COMPLETENESS).sort()).toEqual(
        [...ACTION_STATE_REASON_VALUES].sort(),
      );
      expect(ACTION_STATE_REASON_VALUES).toHaveLength(12);
      expect(ACTION_STATE_REASON_VALUES).toContain('state_forbidden');
    });
  });
});
