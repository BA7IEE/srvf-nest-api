import type { INestApplication } from '@nestjs/common';
import {
  AssignmentStatus,
  BindingScopeType,
  BindingStatus,
  PrincipalType,
  Role,
  UserStatus,
} from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 终态 scoped-authz PR6「RoleBinding」e2e(2026-07-01;冻结稿 §3.6 / §7.5 / §4.3 / §10.6 + goal DoD §4/§5/§6)。
// 覆盖:RBAC 边界 / CRUD 全流程 / scoped 各型建库 / 校验各拒 / 防重(P2002)/
//   **🔴 DoD#6 scoped 绑定零判权影响(RbacService 只读 GLOBAL)** / 行为锁:GLOBAL 绑定即时生效 + 撤销即时收回。
//
// 本仓 rbac.fixture 的 RBAC_PERMISSIONS 未含 role-binding.*(沿 PR4/PR5 惯例不改共享 fixture,其 count 被 rbac 元 e2e 依赖);
// 本 spec 在 beforeAll 内联 seed 4 码 + 绑 ops-admin(判权走 service 层 rbac.can,0 @Roles)。

const RB_CODES = [
  'role-binding.read.record',
  'role-binding.create.record',
  'role-binding.update.record',
  'role-binding.delete.record',
] as const;

async function seedRoleBindingCodesAndBind(
  prisma: PrismaService,
  opsAdminRoleId: string,
): Promise<void> {
  for (const code of RB_CODES) {
    const [module, action, resourceType] = code.split('.');
    await prisma.permission.upsert({
      where: { code },
      update: {},
      create: { code, module, action, resourceType },
    });
  }
  const perms = await prisma.permission.findMany({
    where: { code: { in: [...RB_CODES] } },
    select: { id: true },
  });
  await prisma.rolePermission.createMany({
    data: perms.map((p) => ({ roleId: opsAdminRoleId, permissionId: p.id })),
    skipDuplicates: true,
  });
}

describe('role-bindings 带 scope 的角色绑定管理 + 行为锁边界', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAuth: string; // ops-admin 持有者
  let plainAdminAuth: string; // ADMIN 不持 ops-admin
  let userAuth: string;

  // 判权测试用角色(带可辨识的权限码,供 /me/permissions 断言 scoped 是否泄进判权)。
  let roleGlobalId: string; // 含 'rbtest.read.global'
  let roleScopedId: string; // 含 'rbtest.read.scoped'
  const CODE_GLOBAL = 'rbtest.read.global';
  const CODE_SCOPED = 'rbtest.read.scoped';

  let orgId: string;
  let activityId: string;
  let memberId: string;
  let positionAssignmentId: string;

  const startedAt = '2026-07-01T00:00:00.000Z';

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const admin = await createTestUser(app, { username: 'rb-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'rb-adm-plain', role: Role.ADMIN });
    await createTestUser(app, { username: 'rb-user', role: Role.USER });
    adminAuth = (await loginAs(app, 'rb-adm')).authHeader;
    plainAdminAuth = (await loginAs(app, 'rb-adm-plain')).authHeader;
    userAuth = (await loginAs(app, 'rb-user')).authHeader;

    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    await seedRoleBindingCodesAndBind(prisma, seed.opsAdminRoleId);
    await grantOpsAdminToUser(app, admin.id, seed.opsAdminRoleId);

    // 判权测试角色 + 权限码
    const permGlobal = await prisma.permission.create({
      data: { code: CODE_GLOBAL, module: 'rbtest', action: 'read', resourceType: 'global' },
      select: { id: true },
    });
    const permScoped = await prisma.permission.create({
      data: { code: CODE_SCOPED, module: 'rbtest', action: 'read', resourceType: 'scoped' },
      select: { id: true },
    });
    const roleGlobal = await prisma.rbacRole.create({
      data: { code: 'rb-e2e-role-global', displayName: 'RB 全局角色' },
      select: { id: true },
    });
    const roleScoped = await prisma.rbacRole.create({
      data: { code: 'rb-e2e-role-scoped', displayName: 'RB 范围角色' },
      select: { id: true },
    });
    roleGlobalId = roleGlobal.id;
    roleScopedId = roleScoped.id;
    await prisma.rolePermission.create({
      data: { roleId: roleGlobalId, permissionId: permGlobal.id },
    });
    await prisma.rolePermission.create({
      data: { roleId: roleScopedId, permissionId: permScoped.id },
    });

    // scope / principal 基线实体
    const org = await prisma.organization.create({
      data: { name: 'RB E2E Org', nodeTypeCode: 'rescue-team' },
      select: { id: true },
    });
    orgId = org.id;
    const activity = await prisma.activity.create({
      data: {
        title: 'RB E2E Activity',
        activityTypeCode: 'general',
        organizationId: orgId,
        startAt: new Date('2026-07-01T00:00:00.000Z'),
        endAt: new Date('2026-07-02T00:00:00.000Z'),
        location: 'test',
        statusCode: 'draft',
      },
      select: { id: true },
    });
    activityId = activity.id;
    const member = await prisma.member.create({
      data: { memberNo: 'rb-e2e-m1', displayName: 'RB 队员1' },
      select: { id: true },
    });
    memberId = member.id;
    const position = await prisma.organizationPosition.create({
      data: { code: 'rb-e2e-pos', name: '组长', categoryCode: 'LEADER' },
      select: { id: true },
    });
    const pa = await prisma.organizationPositionAssignment.create({
      data: {
        organizationId: orgId,
        positionId: position.id,
        memberId,
        startedAt: new Date(startedAt),
      },
      select: { id: true },
    });
    positionAssignmentId = pa.id;
  });

  afterAll(async () => {
    await app.close();
  });

  function post(auth: string, body: Record<string, unknown>) {
    return request(httpServer(app))
      .post('/api/admin/v1/role-bindings')
      .set('Authorization', auth)
      .send(body);
  }

  // ============ RBAC 边界 ============

  describe('RBAC 边界(判权单轨 service 层 rbac.can)', () => {
    it('未登录 → 401', async () => {
      const res = await request(httpServer(app)).get('/api/admin/v1/role-bindings');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/role-bindings')
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('ADMIN 不持 ops-admin → 30100', async () => {
      const res = await post(plainAdminAuth, {
        principalType: 'USER',
        principalId: memberId,
        roleId: roleGlobalId,
        scopeType: 'GLOBAL',
      });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  // ============ POST 建 + scoped 各型 ============

  describe('POST 建角色绑定(scoped 各型 + 各 principal 型)', () => {
    it('GLOBAL + USER 主体 → 201', async () => {
      const u = await createTestUser(app, { username: 'rb-global-user', role: Role.USER });
      const res = await post(adminAuth, {
        principalType: 'USER',
        principalId: u.id,
        roleId: roleGlobalId,
        scopeType: 'GLOBAL',
      });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        principalType: 'USER',
        principalId: u.id,
        roleId: roleGlobalId,
        scopeType: 'GLOBAL',
        status: 'ACTIVE',
      });
      expect(res.body.data.createdByUserId).toBeDefined();
    });

    it('ORGANIZATION + scopeOrgId → 201', async () => {
      const u = await createTestUser(app, { username: 'rb-org-user', role: Role.USER });
      const res = await post(adminAuth, {
        principalType: 'USER',
        principalId: u.id,
        roleId: roleScopedId,
        scopeType: 'ORGANIZATION',
        scopeOrgId: orgId,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.scopeType).toBe('ORGANIZATION');
      expect(res.body.data.scopeOrgId).toBe(orgId);
    });

    it('ORGANIZATION_TREE + scopeOrgId → 201', async () => {
      const u = await createTestUser(app, { username: 'rb-tree-user', role: Role.USER });
      const res = await post(adminAuth, {
        principalType: 'USER',
        principalId: u.id,
        roleId: roleScopedId,
        scopeType: 'ORGANIZATION_TREE',
        scopeOrgId: orgId,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.scopeType).toBe('ORGANIZATION_TREE');
    });

    it('ACTIVITY + scopeActivityId → 201', async () => {
      const res = await post(adminAuth, {
        principalType: 'MEMBER',
        principalId: memberId,
        roleId: roleScopedId,
        scopeType: 'ACTIVITY',
        scopeActivityId: activityId,
      });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        principalType: 'MEMBER',
        scopeType: 'ACTIVITY',
        scopeActivityId: activityId,
      });
    });

    it('RESOURCE + scopeResourceType/Id → 201', async () => {
      const res = await post(adminAuth, {
        principalType: 'POSITION_ASSIGNMENT',
        principalId: positionAssignmentId,
        roleId: roleScopedId,
        scopeType: 'RESOURCE',
        scopeResourceType: 'attendance_sheet',
        scopeResourceId: 'sheet-123',
      });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        principalType: 'POSITION_ASSIGNMENT',
        scopeType: 'RESOURCE',
        scopeResourceType: 'attendance_sheet',
        scopeResourceId: 'sheet-123',
      });
    });

    it('SELF + USER → 201', async () => {
      const u = await createTestUser(app, { username: 'rb-self-user', role: Role.USER });
      const res = await post(adminAuth, {
        principalType: 'USER',
        principalId: u.id,
        roleId: roleScopedId,
        scopeType: 'SELF',
      });
      expect(res.status).toBe(201);
      expect(res.body.data.scopeType).toBe('SELF');
    });

    it('SYSTEM 主体(principalId 为空)→ 201', async () => {
      const res = await post(adminAuth, {
        principalType: 'SYSTEM',
        roleId: roleScopedId,
        scopeType: 'GLOBAL',
      });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ principalType: 'SYSTEM', principalId: null });
    });
  });

  // ============ 校验各拒 ============

  describe('建校验', () => {
    it('GLOBAL 却带 scopeOrgId → SCOPE_INVALID', async () => {
      const res = await post(adminAuth, {
        principalType: 'SYSTEM',
        roleId: roleGlobalId,
        scopeType: 'GLOBAL',
        scopeOrgId: orgId,
      });
      expectBizError(res, BizCode.ROLE_BINDING_SCOPE_INVALID);
    });

    it('ORGANIZATION 缺 scopeOrgId → SCOPE_INVALID', async () => {
      const res = await post(adminAuth, {
        principalType: 'SYSTEM',
        roleId: roleGlobalId,
        scopeType: 'ORGANIZATION',
      });
      expectBizError(res, BizCode.ROLE_BINDING_SCOPE_INVALID);
    });

    it('RESOURCE 缺 scopeResourceId → SCOPE_INVALID', async () => {
      const res = await post(adminAuth, {
        principalType: 'SYSTEM',
        roleId: roleGlobalId,
        scopeType: 'RESOURCE',
        scopeResourceType: 'attendance_sheet',
      });
      expectBizError(res, BizCode.ROLE_BINDING_SCOPE_INVALID);
    });

    it('USER 主体缺 principalId → PRINCIPAL_INVALID', async () => {
      const res = await post(adminAuth, {
        principalType: 'USER',
        roleId: roleGlobalId,
        scopeType: 'GLOBAL',
      });
      expectBizError(res, BizCode.ROLE_BINDING_PRINCIPAL_INVALID);
    });

    it('SYSTEM 主体却带 principalId → PRINCIPAL_INVALID', async () => {
      const res = await post(adminAuth, {
        principalType: 'SYSTEM',
        principalId: memberId,
        roleId: roleGlobalId,
        scopeType: 'GLOBAL',
      });
      expectBizError(res, BizCode.ROLE_BINDING_PRINCIPAL_INVALID);
    });

    it('endedAt ≤ startedAt → TENURE_INVALID', async () => {
      const res = await post(adminAuth, {
        principalType: 'SYSTEM',
        roleId: roleGlobalId,
        scopeType: 'GLOBAL',
        startedAt,
        endedAt: startedAt,
      });
      expectBizError(res, BizCode.ROLE_BINDING_TENURE_INVALID);
    });

    it('roleId 不存在 → ROLE_NOT_FOUND', async () => {
      const res = await post(adminAuth, {
        principalType: 'SYSTEM',
        roleId: 'nonexistent000000000000000000',
        scopeType: 'GLOBAL',
      });
      expectBizError(res, BizCode.ROLE_NOT_FOUND);
    });

    it('USER principalId 不存在 → USER_NOT_FOUND', async () => {
      const res = await post(adminAuth, {
        principalType: 'USER',
        principalId: 'nonexistent000000000000000000',
        roleId: roleGlobalId,
        scopeType: 'GLOBAL',
      });
      expectBizError(res, BizCode.USER_NOT_FOUND);
    });

    it('ORGANIZATION scopeOrgId 不存在 → ORGANIZATION_NOT_FOUND', async () => {
      const res = await post(adminAuth, {
        principalType: 'SYSTEM',
        roleId: roleGlobalId,
        scopeType: 'ORGANIZATION',
        scopeOrgId: 'nonexistent000000000000000000',
      });
      expectBizError(res, BizCode.ORGANIZATION_NOT_FOUND);
    });

    it('ACTIVITY scopeActivityId 不存在 → ACTIVITY_NOT_FOUND', async () => {
      const res = await post(adminAuth, {
        principalType: 'SYSTEM',
        roleId: roleGlobalId,
        scopeType: 'ACTIVITY',
        scopeActivityId: 'nonexistent000000000000000000',
      });
      expectBizError(res, BizCode.ACTIVITY_NOT_FOUND);
    });

    it('全 scope 维度重复 active → ROLE_BINDING_ALREADY_EXISTS(partial unique NULLS NOT DISTINCT)', async () => {
      const u = await createTestUser(app, { username: 'rb-dup-user', role: Role.USER });
      const body = {
        principalType: 'USER',
        principalId: u.id,
        roleId: roleGlobalId,
        scopeType: 'GLOBAL',
      };
      const first = await post(adminAuth, body);
      expect(first.status).toBe(201);
      const dup = await post(adminAuth, body);
      expectBizError(dup, BizCode.ROLE_BINDING_ALREADY_EXISTS);
    });
  });

  // ============ GET 列 + 过滤 ============

  describe('GET 列 + 过滤', () => {
    it('按 principalType=SYSTEM 过滤 → 只返 SYSTEM 绑定', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/role-bindings?principalType=SYSTEM')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
      for (const b of res.body.data) expect(b.principalType).toBe('SYSTEM');
    });

    it('按 scopeType=RESOURCE 过滤 → 只返 RESOURCE 绑定', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/role-bindings?scopeType=RESOURCE')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      for (const b of res.body.data) expect(b.scopeType).toBe('RESOURCE');
    });
  });

  // ============ PATCH 改 + DELETE 软删 ============

  describe('PATCH 改 / DELETE 软删', () => {
    it('PATCH note/status → 200;DELETE → 200 status=ENDED,列表不再含', async () => {
      const u = await createTestUser(app, { username: 'rb-patch-user', role: Role.USER });
      const created = await post(adminAuth, {
        principalType: 'USER',
        principalId: u.id,
        roleId: roleScopedId,
        scopeType: 'ORGANIZATION',
        scopeOrgId: orgId,
      });
      const id = created.body.data.id as string;

      const patched = await request(httpServer(app))
        .patch(`/api/admin/v1/role-bindings/${id}`)
        .set('Authorization', adminAuth)
        .send({ note: '改一下', status: 'SUSPENDED' });
      expect(patched.status).toBe(200);
      expect(patched.body.data.note).toBe('改一下');
      expect(patched.body.data.status).toBe('SUSPENDED');

      const del = await request(httpServer(app))
        .delete(`/api/admin/v1/role-bindings/${id}`)
        .set('Authorization', adminAuth);
      expect(del.status).toBe(200);
      expect(del.body.data.status).toBe('ENDED');

      // 软删后列表不再含(deletedAt IS NULL 过滤)
      const list = await request(httpServer(app))
        .get(`/api/admin/v1/role-bindings?principalId=${u.id}`)
        .set('Authorization', adminAuth);
      expect(list.body.data.find((b: { id: string }) => b.id === id)).toBeUndefined();
    });

    it('PATCH 不存在 → NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .patch('/api/admin/v1/role-bindings/nonexistent000000000000000000')
        .set('Authorization', adminAuth)
        .send({ note: 'x' });
      expectBizError(res, BizCode.ROLE_BINDING_NOT_FOUND);
    });

    it('DELETE 不存在 → NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .delete('/api/admin/v1/role-bindings/nonexistent000000000000000000')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ROLE_BINDING_NOT_FOUND);
    });
  });

  // ============ 判权硬化批(review #484 G7/G13/G16)写路径边界收紧 ============

  describe('G7:PATCH 拒绝「status=ACTIVE + endedAt 已过期」自相矛盾组合', () => {
    it('触碰 endedAt(晚于 startedAt,但早于当前时间)、ACTIVE 未变 → TENURE_INVALID(34005,新守卫)', async () => {
      const u = await createTestUser(app, { username: 'rb-g7-a', role: Role.USER });
      const created = await post(adminAuth, {
        principalType: 'USER',
        principalId: u.id,
        roleId: roleScopedId,
        scopeType: 'SELF',
        startedAt: '2020-01-01T00:00:00.000Z',
      });
      expect(created.status).toBe(201);
      const id = created.body.data.id as string;

      // 2020-06-01 晚于 startedAt(过旧的相对顺序检查),但早于「现在」→ 只触发新守卫。
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/role-bindings/${id}`)
        .set('Authorization', adminAuth)
        .send({ endedAt: '2020-06-01T00:00:00.000Z' });
      expectBizError(res, BizCode.ROLE_BINDING_TENURE_INVALID);
    });

    it('触碰 status 但结果态非 ACTIVE(SUSPENDED)+ 过期 endedAt → 200(不拦非 ACTIVE 结果)', async () => {
      const u = await createTestUser(app, { username: 'rb-g7-b', role: Role.USER });
      const created = await post(adminAuth, {
        principalType: 'USER',
        principalId: u.id,
        roleId: roleScopedId,
        scopeType: 'SELF',
        startedAt: '2020-01-01T00:00:00.000Z',
      });
      expect(created.status).toBe(201);
      const id = created.body.data.id as string;

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/role-bindings/${id}`)
        .set('Authorization', adminAuth)
        .send({ status: 'SUSPENDED', endedAt: '2020-06-01T00:00:00.000Z' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('SUSPENDED');
    });

    it('纯 note PATCH 不触碰任期/状态字段,即便当前行已是 ACTIVE+过期态(历史遗留)→ 200', async () => {
      const freshRole = await prisma.rbacRole.create({
        data: { code: 'rb-g7-stale-role', displayName: 'RB G7 过期态测试角色' },
        select: { id: true },
      });
      // 直插模拟历史遗留的自相矛盾行(本守卫上线前可能产生,或未来仅因时间流逝产生;
      // 走 prisma 直插而非 API,不受 create() 的建时校验影响)。
      const stale = await prisma.roleBinding.create({
        data: {
          principalType: PrincipalType.SYSTEM,
          principalId: null,
          roleId: freshRole.id,
          scopeType: BindingScopeType.GLOBAL,
          status: BindingStatus.ACTIVE,
          startedAt: new Date('2020-01-01T00:00:00.000Z'),
          endedAt: new Date('2020-06-01T00:00:00.000Z'),
        },
        select: { id: true },
      });

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/role-bindings/${stale.id}`)
        .set('Authorization', adminAuth)
        .send({ note: '仅改备注' });
      expect(res.status).toBe(200);
      expect(res.body.data.note).toBe('仅改备注');
      expect(res.body.data.status).toBe('ACTIVE'); // 未被改动,矛盾态原样保留(不静默清空/纠正)
    });

    it('触碰 endedAt 设为未来(ACTIVE 未变)→ 200(合法路径不回归)', async () => {
      const u = await createTestUser(app, { username: 'rb-g7-d', role: Role.USER });
      const created = await post(adminAuth, {
        principalType: 'USER',
        principalId: u.id,
        roleId: roleScopedId,
        scopeType: 'SELF',
      });
      expect(created.status).toBe(201);
      const id = created.body.data.id as string;

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/role-bindings/${id}`)
        .set('Authorization', adminAuth)
        .send({ endedAt: '2099-01-01T00:00:00.000Z' });
      expect(res.status).toBe(200);
    });
  });

  describe('G13:建绑定拒绝已 REVOKED 的 POSITION_ASSIGNMENT 主体', () => {
    it('principalId 指向 REVOKED(未软删)任职 → POSITION_ASSIGNMENT_NOT_FOUND(32020)', async () => {
      const position = await prisma.organizationPosition.create({
        data: { code: 'rb-g13-pos', name: '副组长', categoryCode: 'LEADER' },
        select: { id: true },
      });
      const revokedPa = await prisma.organizationPositionAssignment.create({
        data: {
          organizationId: orgId,
          positionId: position.id,
          memberId,
          status: AssignmentStatus.REVOKED,
          startedAt: new Date(startedAt),
          endedAt: new Date(),
        },
        select: { id: true },
      });

      const res = await post(adminAuth, {
        principalType: 'POSITION_ASSIGNMENT',
        principalId: revokedPa.id,
        roleId: roleScopedId,
        scopeType: 'GLOBAL',
      });
      expectBizError(res, BizCode.POSITION_ASSIGNMENT_NOT_FOUND);
    });
  });

  describe('G16:建绑定拒绝 DISABLED 的 USER 主体', () => {
    it('principalId 指向 DISABLED(未软删)用户 → USER_NOT_FOUND(对齐 UserRolesService 口径)', async () => {
      const disabledUser = await createTestUser(app, {
        username: 'rb-g16-disabled',
        role: Role.USER,
        status: UserStatus.DISABLED,
      });

      const res = await post(adminAuth, {
        principalType: 'USER',
        principalId: disabledUser.id,
        roleId: roleScopedId,
        scopeType: 'GLOBAL',
      });
      expectBizError(res, BizCode.USER_NOT_FOUND);
    });
  });

  // ============ 🔴 DoD#6:scoped 绑定零判权影响 + 行为锁:GLOBAL 即时生效/收回 ============

  describe('🔴 scoped 绑定零判权影响(RbacService 只读 GLOBAL)+ GLOBAL 绑定即时生效', () => {
    it('GLOBAL 绑定即时授予 → /me/permissions 含该码;加 scoped 绑定后判权零变化;软删 GLOBAL 即时收回', async () => {
      const u = await createTestUser(app, { username: 'rb-judge-user', role: Role.USER });
      const uAuth = (await loginAs(app, 'rb-judge-user')).authHeader;

      // 0. 初始:无任何绑定 → 判权集不含两码
      const before = await request(httpServer(app))
        .get('/api/system/v1/rbac/me/permissions')
        .set('Authorization', uAuth);
      expect(before.status).toBe(200);
      expect(before.body.data.permissions).not.toContain(CODE_GLOBAL);
      expect(before.body.data.permissions).not.toContain(CODE_SCOPED);

      // 1. 建 GLOBAL 绑定(roleGlobal) → 即时生效(create 失效缓存)
      const globalBinding = await post(adminAuth, {
        principalType: 'USER',
        principalId: u.id,
        roleId: roleGlobalId,
        scopeType: 'GLOBAL',
      });
      expect(globalBinding.status).toBe(201);
      const globalBindingId = globalBinding.body.data.id as string;

      const afterGlobal = await request(httpServer(app))
        .get('/api/system/v1/rbac/me/permissions')
        .set('Authorization', uAuth);
      expect(afterGlobal.body.data.permissions).toContain(CODE_GLOBAL); // GLOBAL 生效
      expect(afterGlobal.body.data.permissions).not.toContain(CODE_SCOPED);

      // 2. 🔴 建 ORGANIZATION_TREE scoped 绑定(roleScoped) → 判权**零变化**(RbacService 忽略非 GLOBAL 行)
      const scopedBinding = await post(adminAuth, {
        principalType: 'USER',
        principalId: u.id,
        roleId: roleScopedId,
        scopeType: 'ORGANIZATION_TREE',
        scopeOrgId: orgId,
      });
      expect(scopedBinding.status).toBe(201);

      const afterScoped = await request(httpServer(app))
        .get('/api/system/v1/rbac/me/permissions')
        .set('Authorization', uAuth);
      // scoped 绑定入库(可查),但**绝不进判权**:判权集与加 scoped 前逐字一致
      expect(afterScoped.body.data.permissions).toContain(CODE_GLOBAL);
      expect(afterScoped.body.data.permissions).not.toContain(CODE_SCOPED); // 🔴 scoped 零判权影响

      // 确认 scoped 绑定确实入库(role-bindings 面可查)
      const scopedList = await request(httpServer(app))
        .get(`/api/admin/v1/role-bindings?principalId=${u.id}&scopeType=ORGANIZATION_TREE`)
        .set('Authorization', adminAuth);
      expect(scopedList.body.data.length).toBe(1);

      // 3. 软删 GLOBAL 绑定 → 即时收回(delete 失效缓存)
      const del = await request(httpServer(app))
        .delete(`/api/admin/v1/role-bindings/${globalBindingId}`)
        .set('Authorization', adminAuth);
      expect(del.status).toBe(200);

      const afterRevoke = await request(httpServer(app))
        .get('/api/system/v1/rbac/me/permissions')
        .set('Authorization', uAuth);
      expect(afterRevoke.body.data.permissions).not.toContain(CODE_GLOBAL); // GLOBAL 即时收回
      expect(afterRevoke.body.data.permissions).not.toContain(CODE_SCOPED);
    });
  });
});
