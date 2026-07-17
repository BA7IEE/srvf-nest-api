import type { INestApplication } from '@nestjs/common';
import { DictItemStatus, OrganizationStatus, Role } from '@prisma/client';
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

// V2 Step 4 organizations 模块 e2e。
// 覆盖 7 接口主成功 + 关键失败:权限边界 / 字典校验 / parent 不存在 / 单根上限 /
// last-root 保护 / 引用拒删 / tree 嵌套 / PATCH 拒 parentId & status。
//
// P0-F PR-2A(2026-05-18):入口切到 service 层 rbac.can();失败统一 RBAC_FORBIDDEN(30100)。
// `adminAuth` 在 beforeAll 全局 grant ops-admin(沿 dict e2e 范式);单独建 `adminDefaultAuth`
// 做"ADMIN 默认 30100"反向断言。D3=A:org softDelete 从 v1 仅 SA 放宽至 ops-admin 可调。

describe('organizations 模块', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let adminAuth: string;
  let adminDefaultAuth: string;
  let userAuth: string;
  let adminUserId: string;
  let opsAdminRoleId: string;

  let activeNodeTypeCode: string;
  let inactiveNodeTypeCode: string;
  let wrongTypeItemCode: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'org-su', role: Role.SUPER_ADMIN });
    const admin = await createTestUser(app, { username: 'org-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'org-adm-default', role: Role.ADMIN });
    await createTestUser(app, { username: 'org-user', role: Role.USER });
    superAdminAuth = (await loginAs(app, 'org-su')).authHeader;
    adminAuth = (await loginAs(app, 'org-adm')).authHeader;
    adminDefaultAuth = (await loginAs(app, 'org-adm-default')).authHeader;
    userAuth = (await loginAs(app, 'org-user')).authHeader;

    // P0-F PR-2A:seed 33 条 RBAC + ops-admin;给 org-adm 全局 grant ops-admin
    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    await grantOpsAdminToUser(app, admin.id, seed.opsAdminRoleId);
    adminUserId = admin.id;
    opsAdminRoleId = seed.opsAdminRoleId;

    // 准备 node_type 字典 + 1 ACTIVE / 1 INACTIVE item(供 nodeTypeCode 校验测试)
    const nodeType = await prisma.dictType.create({
      data: { code: 'node_type', label: 'Node Type' },
      select: { id: true },
    });

    const activeItem = await prisma.dictItem.create({
      data: { typeId: nodeType.id, code: 'org-type-active', label: 'Active' },
      select: { code: true },
    });
    activeNodeTypeCode = activeItem.code;

    const inactiveItem = await prisma.dictItem.create({
      data: {
        typeId: nodeType.id,
        code: 'org-type-inactive',
        label: 'Inactive',
        status: DictItemStatus.INACTIVE,
      },
      select: { code: true },
    });
    inactiveNodeTypeCode = inactiveItem.code;

    // 准备一个**错误 type**(member_grade)下的 item,测试 nodeTypeCode 跨 type 拒绝
    const wrongType = await prisma.dictType.create({
      data: { code: 'member_grade', label: 'Member Grade' },
    });
    const wrongItem = await prisma.dictItem.create({
      data: { typeId: wrongType.id, code: 'wrong-type-item', label: 'Wrong' },
      select: { code: true },
    });
    wrongTypeItemCode = wrongItem.code;
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ 权限边界 ============

  describe('权限边界', () => {
    it('未登录 GET → 401', async () => {
      const res = await request(httpServer(app)).get('/api/admin/v1/organizations');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER GET → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/organizations')
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER POST → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/organizations')
        .set('Authorization', userAuth)
        .send({ name: 'x', nodeTypeCode: activeNodeTypeCode });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    // P0-F PR-2A:ADMIN 默认无 ops-admin → 30100(v1 ADMIN 全权变收紧,显式反向断言)
    it('ADMIN 默认无 ops-admin → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/organizations')
        .set('Authorization', adminDefaultAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    // P0-F PR-2A D3=A:ADMIN+ops-admin DELETE root 触发 LAST_ROOT_PROTECTED(权限放行,业务护栏拦下;
    // 反向证明:权限层不再是 v1 SA-only 拦截点,业务层仍在守护)
    it('ADMIN+ops-admin DELETE root → LAST_ROOT_PROTECTED(D3=A 权限放行 + 业务护栏兜底)', async () => {
      const root = await prisma.organization.create({
        data: { name: 'pb-adm-del', nodeTypeCode: activeNodeTypeCode },
      });
      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/organizations/${root.id}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.LAST_ROOT_ORGANIZATION_PROTECTED);
      // 清理:跳过 LAST_ROOT_PROTECTED 走直接 DB 软删
      await prisma.organization.update({
        where: { id: root.id },
        data: { deletedAt: new Date() },
      });
    });
  });

  // ============ CRUD 主路径 + 单根上限 ============

  describe('CRUD 主路径 + 单根上限', () => {
    let rootId: string;
    let childId: string;

    it('SUPER_ADMIN 创建根节点 → 201', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/organizations')
        .set('Authorization', superAdminAuth)
        .send({ name: 'Demo Root', nodeTypeCode: activeNodeTypeCode });
      expect(res.status).toBe(201);
      expect(res.body.code).toBe(0);
      expect(res.body.data.name).toBe('Demo Root');
      expect(res.body.data.parentId).toBeNull();
      expect(res.body.data.status).toBe(OrganizationStatus.ACTIVE);
      expect(res.body.data.nodeTypeCode).toBe(activeNodeTypeCode);
      expect(res.body.data).not.toHaveProperty('deletedAt');
      rootId = res.body.data.id;
    });

    it('创建第二个根 → ORGANIZATION_ROOT_ALREADY_EXISTS', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/organizations')
        .set('Authorization', superAdminAuth)
        .send({ name: 'Another Root', nodeTypeCode: activeNodeTypeCode });
      expectBizError(res, BizCode.ORGANIZATION_ROOT_ALREADY_EXISTS);
    });

    it('ADMIN 创建子节点 → 201', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/organizations')
        .set('Authorization', adminAuth)
        .send({
          name: 'Child 1',
          parentId: rootId,
          nodeTypeCode: activeNodeTypeCode,
          sortOrder: 5,
        });
      expect(res.status).toBe(201);
      expect(res.body.data.parentId).toBe(rootId);
      expect(res.body.data.sortOrder).toBe(5);
      childId = res.body.data.id;
    });

    it('parent 不存在 → ORGANIZATION_PARENT_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/organizations')
        .set('Authorization', superAdminAuth)
        .send({
          name: 'orphan',
          parentId: 'cl0000000000000000000000',
          nodeTypeCode: activeNodeTypeCode,
        });
      expectBizError(res, BizCode.ORGANIZATION_PARENT_NOT_FOUND);
    });

    it('nodeTypeCode 不存在 → ORGANIZATION_NODE_TYPE_INVALID', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/organizations')
        .set('Authorization', superAdminAuth)
        .send({
          name: 'invalid',
          parentId: rootId,
          nodeTypeCode: 'no-such-code',
        });
      expectBizError(res, BizCode.ORGANIZATION_NODE_TYPE_INVALID);
    });

    it('nodeTypeCode 在错误 type 下 → ORGANIZATION_NODE_TYPE_INVALID', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/organizations')
        .set('Authorization', superAdminAuth)
        .send({
          name: 'wrong type',
          parentId: rootId,
          nodeTypeCode: wrongTypeItemCode,
        });
      expectBizError(res, BizCode.ORGANIZATION_NODE_TYPE_INVALID);
    });

    it('nodeTypeCode 是 INACTIVE → ORGANIZATION_NODE_TYPE_INVALID', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/organizations')
        .set('Authorization', superAdminAuth)
        .send({
          name: 'inactive code',
          parentId: rootId,
          nodeTypeCode: inactiveNodeTypeCode,
        });
      expectBizError(res, BizCode.ORGANIZATION_NODE_TYPE_INVALID);
    });

    it('GET 列表分页', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/organizations?page=1&pageSize=10')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('items');
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.pageSize).toBe(10);
    });

    it('GET 列表 parentId=null 过滤(根节点)', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/organizations?parentId=null')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      for (const item of res.body.data.items) {
        expect(item.parentId).toBeNull();
      }
    });

    it('GET 列表 parentId=<id> 过滤(子节点)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/organizations?parentId=${rootId}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      for (const item of res.body.data.items) {
        expect(item.parentId).toBe(rootId);
      }
    });

    it('GET tree 嵌套结构', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/organizations/tree')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      const root = res.body.data.find((n: { id: string }) => n.id === rootId);
      expect(root).toBeDefined();
      expect(root.parentId).toBeNull();
      expect(Array.isArray(root.children)).toBe(true);
      const childInTree = root.children.find((c: { id: string }) => c.id === childId);
      expect(childInTree).toBeDefined();
    });

    it('GET 详情 → 200', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/organizations/${rootId}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(rootId);
    });

    it('GET 详情 NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/organizations/cl0000000000000000000000')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ORGANIZATION_NOT_FOUND);
    });

    it('PATCH 更新 name / sortOrder', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/organizations/${childId}`)
        .set('Authorization', superAdminAuth)
        .send({ name: 'Renamed Child', sortOrder: 99 });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Renamed Child');
      expect(res.body.data.sortOrder).toBe(99);
    });

    it('PATCH 更新 nodeTypeCode 校验失败 → ORGANIZATION_NODE_TYPE_INVALID', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/organizations/${childId}`)
        .set('Authorization', superAdminAuth)
        .send({ nodeTypeCode: 'no-such-code' });
      expectBizError(res, BizCode.ORGANIZATION_NODE_TYPE_INVALID);
    });

    it('PATCH 拒绝 parentId(forbidNonWhitelisted)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/organizations/${childId}`)
        .set('Authorization', superAdminAuth)
        .send({ parentId: 'cl0000000000000000000000' });
      expect(res.status).toBe(400);
    });

    it('PATCH 拒绝 status(forbidNonWhitelisted)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/organizations/${childId}`)
        .set('Authorization', superAdminAuth)
        .send({ status: 'INACTIVE' });
      expect(res.status).toBe(400);
    });

    it('PATCH /:id/status 启停子节点', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/organizations/${childId}/status`)
        .set('Authorization', superAdminAuth)
        .send({ status: OrganizationStatus.INACTIVE });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(OrganizationStatus.INACTIVE);
    });

    it('PATCH /:id/status INACTIVE 唯一活跃根 → LAST_ROOT_ORGANIZATION_PROTECTED', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/organizations/${rootId}/status`)
        .set('Authorization', superAdminAuth)
        .send({ status: OrganizationStatus.INACTIVE });
      expectBizError(res, BizCode.LAST_ROOT_ORGANIZATION_PROTECTED);
    });

    it('DELETE 有子节点 → ORGANIZATION_HAS_CHILDREN', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/organizations/${rootId}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.ORGANIZATION_HAS_CHILDREN);
    });

    it('DELETE 子节点 → 200(无子节点 / 无成员归属)', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/organizations/${childId}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      const after = await prisma.organization.findUnique({ where: { id: childId } });
      expect(after?.deletedAt).not.toBeNull();
      expect(after?.status).toBe(OrganizationStatus.INACTIVE);
    });

    it('DELETE 唯一活跃根(无子节点)→ LAST_ROOT_ORGANIZATION_PROTECTED', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/organizations/${rootId}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.LAST_ROOT_ORGANIZATION_PROTECTED);
    });
  });

  // ============ 单根上限的软删后再创建语义 ============

  describe('单根上限:软删后仍占位(决策 3 修订)', () => {
    beforeAll(async () => {
      // 清空 Organization 后单独跑这一组
      await prisma.$executeRawUnsafe('TRUNCATE TABLE "Organization" RESTART IDENTITY CASCADE');
    });

    it('创建根 + 直接 DB 软删 + 再创建根 → 仍 ROOT_ALREADY_EXISTS(决策 3 修订)', async () => {
      // 注:无法通过 API DELETE(被 LAST_ROOT 拦),所以走直接 DB 设值。
      // 但本测试目的:验证 service 端 assertNoExistingRoot 用 deletedAt=null 而非
      // 'deletedAt=null AND status=ACTIVE',不会因 status=INACTIVE 而放过。
      const root = await prisma.organization.create({
        data: { name: 'Iso Root 1', nodeTypeCode: activeNodeTypeCode },
      });

      // 改成 INACTIVE (deletedAt 仍 null) → 仍占位
      await prisma.organization.update({
        where: { id: root.id },
        data: { status: OrganizationStatus.INACTIVE },
      });

      const res = await request(httpServer(app))
        .post('/api/admin/v1/organizations')
        .set('Authorization', superAdminAuth)
        .send({ name: 'Replacement', nodeTypeCode: activeNodeTypeCode });
      expectBizError(res, BizCode.ORGANIZATION_ROOT_ALREADY_EXISTS);

      // 清场:DB 软删旧根
      await prisma.organization.update({
        where: { id: root.id },
        data: { deletedAt: new Date() },
      });
    });

    it('软删旧根后 → 允许创建新根(deletedAt 非 null 不占位)', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/organizations')
        .set('Authorization', superAdminAuth)
        .send({ name: 'New Root After Soft-Delete', nodeTypeCode: activeNodeTypeCode });
      expect(res.status).toBe(201);
      expect(res.body.data.parentId).toBeNull();
    });
  });

  // ============ code 缩写字段(可空 + 唯一)============

  describe('code 缩写字段(可空 + 唯一)', () => {
    let rootId: string;
    let childWithCodeId: string;

    beforeAll(async () => {
      // 自包含:清空 Organization 后建一个**不带 code** 的根(回归:不传 code 仍可建)
      await prisma.$executeRawUnsafe('TRUNCATE TABLE "Organization" RESTART IDENTITY CASCADE');
      const res = await request(httpServer(app))
        .post('/api/admin/v1/organizations')
        .set('Authorization', superAdminAuth)
        .send({ name: 'Code Root', nodeTypeCode: activeNodeTypeCode });
      rootId = res.body.data.id;
    });

    it('不传 code 建根 → 响应含 code 字段且为 null(回归)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/organizations/${rootId}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('code');
      expect(res.body.data.code).toBeNull();
    });

    it('建带 code 的子节点 → 201,响应含 code', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/organizations')
        .set('Authorization', superAdminAuth)
        .send({
          name: 'Mountain',
          parentId: rootId,
          nodeTypeCode: activeNodeTypeCode,
          code: 'SMRT',
        });
      expect(res.status).toBe(201);
      expect(res.body.data.code).toBe('SMRT');
      childWithCodeId = res.body.data.id;
    });

    it('撞 code → ORGANIZATION_CODE_ALREADY_EXISTS', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/organizations')
        .set('Authorization', superAdminAuth)
        .send({ name: 'Dup', parentId: rootId, nodeTypeCode: activeNodeTypeCode, code: 'SMRT' });
      expectBizError(res, BizCode.ORGANIZATION_CODE_ALREADY_EXISTS);
    });

    it('非法 code 格式(小写)→ 400(DTO @Matches)', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/organizations')
        .set('Authorization', superAdminAuth)
        .send({ name: 'Bad', parentId: rootId, nodeTypeCode: activeNodeTypeCode, code: 'smrt' });
      expect(res.status).toBe(400);
    });

    it('不传 code 建子节点 → 201,code 为 null(多 NULL 不撞唯一)', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/organizations')
        .set('Authorization', superAdminAuth)
        .send({ name: 'NoCode Child', parentId: rootId, nodeTypeCode: activeNodeTypeCode });
      expect(res.status).toBe(201);
      expect(res.body.data.code).toBeNull();
    });

    it('PATCH 更新 code → 200,响应 code 更新', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/organizations/${childWithCodeId}`)
        .set('Authorization', superAdminAuth)
        .send({ code: 'SMRT2' });
      expect(res.status).toBe(200);
      expect(res.body.data.code).toBe('SMRT2');
    });

    it('PATCH code 设回自身当前值 → 200(排除自身不算冲突)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/organizations/${childWithCodeId}`)
        .set('Authorization', superAdminAuth)
        .send({ code: 'SMRT2' });
      expect(res.status).toBe(200);
      expect(res.body.data.code).toBe('SMRT2');
    });

    it('PATCH code 撞他节点已有 → ORGANIZATION_CODE_ALREADY_EXISTS', async () => {
      const other = await request(httpServer(app))
        .post('/api/admin/v1/organizations')
        .set('Authorization', superAdminAuth)
        .send({ name: 'Water', parentId: rootId, nodeTypeCode: activeNodeTypeCode, code: 'SWRT' });
      expect(other.status).toBe(201);
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/organizations/${childWithCodeId}`)
        .set('Authorization', superAdminAuth)
        .send({ code: 'SWRT' });
      expectBizError(res, BizCode.ORGANIZATION_CODE_ALREADY_EXISTS);
    });

    it('软删后 code 仍占位 → 撞 ORGANIZATION_CODE_ALREADY_EXISTS(全局 @unique 含软删历史)', async () => {
      const node = await request(httpServer(app))
        .post('/api/admin/v1/organizations')
        .set('Authorization', superAdminAuth)
        .send({ name: 'High', parentId: rootId, nodeTypeCode: activeNodeTypeCode, code: 'STRT' });
      expect(node.status).toBe(201);
      // 直接 DB 软删(API DELETE 会被业务护栏拦;此处只测 code 占位语义)
      await prisma.organization.update({
        where: { id: node.body.data.id },
        data: { deletedAt: new Date() },
      });
      const res = await request(httpServer(app))
        .post('/api/admin/v1/organizations')
        .set('Authorization', superAdminAuth)
        .send({
          name: 'High Again',
          parentId: rootId,
          nodeTypeCode: activeNodeTypeCode,
          code: 'STRT',
        });
      expectBizError(res, BizCode.ORGANIZATION_CODE_ALREADY_EXISTS);
    });
  });

  // ============ 终态 scoped-authz PR1:closure + reparent(org.move.node)============
  // 冻结稿 §3.8/§8.3/§11 PR1。覆盖:create 维护 closure / reparent 三分支(成功·环·受限根)/
  // 目标父不存在 / 同父幂等 / 深层子树重算 / 权限边界 / node_type group 建组节点 / 两 additive 列读写。
  describe('closure + reparent(org.move.node)', () => {
    let groupNodeTypeCode: string;
    let rootId: string;

    // 通过 API 建节点(维护 closure);返回新 id。
    const createNode = async (name: string, parentId?: string, nodeTypeCode?: string) => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/organizations')
        .set('Authorization', superAdminAuth)
        .send({ name, parentId, nodeTypeCode: nodeTypeCode ?? activeNodeTypeCode });
      expect(res.status).toBe(201);
      return res.body.data.id as string;
    };

    // 查某节点祖先集(closure descendantId=id)→ Map<ancestorId, depth>。
    const ancestorsOf = async (id: string): Promise<Map<string, number>> => {
      const rows = await prisma.organizationClosure.findMany({
        where: { descendantId: id },
        select: { ancestorId: true, depth: true },
      });
      return new Map(rows.map((r) => [r.ancestorId, r.depth]));
    };

    beforeAll(async () => {
      // 自包含:清空 Organization(级联清 organization_closure),重建单根 + 'group' 节点类别 item。
      await prisma.$executeRawUnsafe('TRUNCATE TABLE "Organization" RESTART IDENTITY CASCADE');
      const nodeType = await prisma.dictType.findUniqueOrThrow({
        where: { code: 'node_type' },
        select: { id: true },
      });
      const groupItem = await prisma.dictItem.create({
        data: { typeId: nodeType.id, code: 'group', label: '组 / 工作组' },
        select: { code: true },
      });
      groupNodeTypeCode = groupItem.code;
      rootId = await createNode('Closure Root');
    });

    it('create 维护 closure:建根 → 仅自身 depth-0 行', async () => {
      const anc = await ancestorsOf(rootId);
      expect(anc.get(rootId)).toBe(0);
      expect(anc.size).toBe(1);
    });

    it('create 维护 closure:三代(根→部→子)祖先链正确', async () => {
      const dept = await createNode('C-Dept', rootId);
      const child = await createNode('C-Child', dept);
      // 部:自身@0 + 根@1
      const deptAnc = await ancestorsOf(dept);
      expect(deptAnc.get(dept)).toBe(0);
      expect(deptAnc.get(rootId)).toBe(1);
      expect(deptAnc.size).toBe(2);
      // 子:自身@0 + 部@1 + 根@2
      const childAnc = await ancestorsOf(child);
      expect(childAnc.get(child)).toBe(0);
      expect(childAnc.get(dept)).toBe(1);
      expect(childAnc.get(rootId)).toBe(2);
      expect(childAnc.size).toBe(3);
    });

    it('reparent 成功:叶子改挂到另一部下 → 200 + closure 重算(旧祖先边删、新祖先边入)', async () => {
      const deptA = await createNode('R-DeptA', rootId);
      const deptB = await createNode('R-DeptB', rootId);
      const leaf = await createNode('R-Leaf', deptA);
      // 移动前:leaf 祖先 = {leaf@0, deptA@1, root@2}
      expect(await ancestorsOf(leaf)).toEqual(
        new Map([
          [leaf, 0],
          [deptA, 1],
          [rootId, 2],
        ]),
      );
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/organizations/${leaf}/move`)
        .set('Authorization', superAdminAuth)
        .send({ parentId: deptB });
      expect(res.status).toBe(201);
      expect(res.body.data.parentId).toBe(deptB);
      // 移动后:leaf 祖先 = {leaf@0, deptB@1, root@2}(deptA 边已删)
      expect(await ancestorsOf(leaf)).toEqual(
        new Map([
          [leaf, 0],
          [deptB, 1],
          [rootId, 2],
        ]),
      );
    });

    it('reparent 深层子树:移动带子的部 → 子树全体祖先链重算', async () => {
      const deptA = await createNode('D-DeptA', rootId);
      const deptB = await createNode('D-DeptB', rootId);
      const sub = await createNode('D-Sub', deptA); // deptA 的子
      const leaf = await createNode('D-Leaf', sub); // deptA 的孙
      // 把 deptA 整棵移到 deptB 下:root→deptB→deptA→sub→leaf
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/organizations/${deptA}/move`)
        .set('Authorization', superAdminAuth)
        .send({ parentId: deptB });
      expect(res.status).toBe(201);
      // deptA 祖先 = {deptA@0, deptB@1, root@2}
      expect(await ancestorsOf(deptA)).toEqual(
        new Map([
          [deptA, 0],
          [deptB, 1],
          [rootId, 2],
        ]),
      );
      // 孙 leaf 祖先链整体 +1:{leaf@0, sub@1, deptA@2, deptB@3, root@4}
      expect(await ancestorsOf(leaf)).toEqual(
        new Map([
          [leaf, 0],
          [sub, 1],
          [deptA, 2],
          [deptB, 3],
          [rootId, 4],
        ]),
      );
    });

    it('reparent 环:目标父 = 自身后代 → ORGANIZATION_PARENT_CYCLE', async () => {
      const deptA = await createNode('CY-DeptA', rootId);
      const sub = await createNode('CY-Sub', deptA);
      // 把 deptA 挂到它自己的后代 sub 下 → 成环
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/organizations/${deptA}/move`)
        .set('Authorization', superAdminAuth)
        .send({ parentId: sub });
      expectBizError(res, BizCode.ORGANIZATION_PARENT_CYCLE);
    });

    it('reparent 环:目标父 = 自身 → ORGANIZATION_PARENT_CYCLE', async () => {
      const dept = await createNode('CY-Self', rootId);
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/organizations/${dept}/move`)
        .set('Authorization', superAdminAuth)
        .send({ parentId: dept });
      expectBizError(res, BizCode.ORGANIZATION_PARENT_CYCLE);
    });

    it('reparent 受限:改根节点父级 → ORGANIZATION_PARENT_CHANGE_FORBIDDEN', async () => {
      const dept = await createNode('F-Dept', rootId);
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/organizations/${rootId}/move`)
        .set('Authorization', superAdminAuth)
        .send({ parentId: dept });
      expectBizError(res, BizCode.ORGANIZATION_PARENT_CHANGE_FORBIDDEN);
    });

    it('reparent 目标父不存在 → ORGANIZATION_PARENT_NOT_FOUND', async () => {
      const dept = await createNode('PN-Dept', rootId);
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/organizations/${dept}/move`)
        .set('Authorization', superAdminAuth)
        .send({ parentId: 'cl0000000000000000000000' });
      expectBizError(res, BizCode.ORGANIZATION_PARENT_NOT_FOUND);
    });

    it('reparent 同父 → 幂等 200,parentId 不变,closure 不漂', async () => {
      const deptA = await createNode('ID-DeptA', rootId);
      const leaf = await createNode('ID-Leaf', deptA);
      const before = await ancestorsOf(leaf);
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/organizations/${leaf}/move`)
        .set('Authorization', superAdminAuth)
        .send({ parentId: deptA });
      expect(res.status).toBe(201);
      expect(res.body.data.parentId).toBe(deptA);
      expect(await ancestorsOf(leaf)).toEqual(before);
    });

    it('reparent 目标节点不存在 → ORGANIZATION_NOT_FOUND', async () => {
      const dept = await createNode('NF-Dept', rootId);
      const res = await request(httpServer(app))
        .post('/api/admin/v1/organizations/cl0000000000000000000000/move')
        .set('Authorization', superAdminAuth)
        .send({ parentId: dept });
      expectBizError(res, BizCode.ORGANIZATION_NOT_FOUND);
    });

    it('reparent 缺 parentId → 400(DTO 必填)', async () => {
      const dept = await createNode('BR-Dept', rootId);
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/organizations/${dept}/move`)
        .set('Authorization', superAdminAuth)
        .send({});
      expect(res.status).toBe(400);
    });

    it('权限边界:USER move → 30100 RBAC_FORBIDDEN', async () => {
      const dept = await createNode('RB-Dept', rootId);
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/organizations/${dept}/move`)
        .set('Authorization', userAuth)
        .send({ parentId: rootId });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('权限边界:ADMIN 默认无 ops-admin move → 30100 RBAC_FORBIDDEN', async () => {
      const dept = await createNode('RB2-Dept', rootId);
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/organizations/${dept}/move`)
        .set('Authorization', adminDefaultAuth)
        .send({ parentId: rootId });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('node_type group:可建组节点(nodeTypeCode=group)→ 201', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/organizations')
        .set('Authorization', superAdminAuth)
        .send({ name: 'G-Group', parentId: rootId, nodeTypeCode: groupNodeTypeCode });
      expect(res.status).toBe(201);
      expect(res.body.data.nodeTypeCode).toBe('group');
    });

    it('两 additive 列可读写(schema-only;经 prisma 写入 provisional / 组功能后读回)', async () => {
      const id = await createNode('AC-Node', rootId, groupNodeTypeCode);
      // 新建节点两列默认 null
      const fresh = await prisma.organization.findUniqueOrThrow({
        where: { id },
        select: { establishmentStatusCode: true, groupFunctionCode: true },
      });
      expect(fresh.establishmentStatusCode).toBeNull();
      expect(fresh.groupFunctionCode).toBeNull();
      // 写入后读回(冻结稿 §3.0.1 R1 provisional 筹备组 / R3 组功能留口)
      await prisma.organization.update({
        where: { id },
        data: { establishmentStatusCode: 'provisional', groupFunctionCode: 'training' },
      });
      const after = await prisma.organization.findUniqueOrThrow({
        where: { id },
        select: { establishmentStatusCode: true, groupFunctionCode: true },
      });
      expect(after.establishmentStatusCode).toBe('provisional');
      expect(after.groupFunctionCode).toBe('training');
    });

    it('closure 无悬挂 / 无重复:built tree 全部边可回溯到存活节点(PK 兜底防重)', async () => {
      // 任意时刻 closure 每条边的 ancestor / descendant 都指向存在的 Organization 行。
      const orphan = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM organization_closure c
         WHERE NOT EXISTS (SELECT 1 FROM "Organization" o WHERE o.id=c."ancestorId")
            OR NOT EXISTS (SELECT 1 FROM "Organization" o WHERE o.id=c."descendantId")`,
      );
      expect(Number(orphan[0].n)).toBe(0);
    });
  });

  // ============ F1/A3 选择器(admin-api-fe-integration-roadmap.md §4 A3)============

  describe('GET /options + /tree-options 选择器', () => {
    let rootId: string;
    let childId: string;

    const createNode = async (name: string, parentId?: string, code?: string) => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/organizations')
        .set('Authorization', superAdminAuth)
        .send({ name, parentId, nodeTypeCode: activeNodeTypeCode, code });
      expect(res.status).toBe(201);
      return res.body.data.id as string;
    };

    beforeAll(async () => {
      // 自包含(沿"closure + reparent"块范式):清空 Organization 重建单根 + 一个子节点。
      await prisma.$executeRawUnsafe('TRUNCATE TABLE "Organization" RESTART IDENTITY CASCADE');
      // CASCADE 会截断引用 Organization 的整张 RoleBinding；DB-per-request 下需重建本组的 GLOBAL grant。
      await grantOpsAdminToUser(app, adminUserId, opsAdminRoleId);
      rootId = await createNode('F1选择器根', undefined, 'F1ROOT');
      childId = await createNode('F1选择器子节点唯一名XYZ', rootId, 'F1CHILDXYZ');
    });

    it('GET /options → 200,items 含 {id,label,code,nodeTypeCode,parentId}', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/organizations/options')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data as object).sort()).toEqual(['items']);
      const item = (res.body.data.items as Array<Record<string, unknown>>).find(
        (i) => i.id === childId,
      );
      expect(item).toEqual({
        id: childId,
        label: 'F1选择器子节点唯一名XYZ',
        code: 'F1CHILDXYZ',
        nodeTypeCode: activeNodeTypeCode,
        parentId: rootId,
      });
    });

    it('/options 的 q 跨字段模糊命中 name + code', async () => {
      const byName = await request(httpServer(app))
        .get('/api/admin/v1/organizations/options')
        .query({ q: '唯一名XYZ' })
        .set('Authorization', adminAuth);
      expect((byName.body.data.items as Array<{ id: string }>).map((i) => i.id)).toEqual([childId]);

      const byCode = await request(httpServer(app))
        .get('/api/admin/v1/organizations/options')
        .query({ q: 'F1CHILDXYZ' })
        .set('Authorization', adminAuth);
      expect((byCode.body.data.items as Array<{ id: string }>).map((i) => i.id)).toEqual([childId]);
    });

    it('list 增强:q 命中 + nameContains / codeContains 精确子串', async () => {
      const q = await request(httpServer(app))
        .get('/api/admin/v1/organizations')
        .query({ q: '唯一名XYZ' })
        .set('Authorization', adminAuth);
      expect((q.body.data.items as Array<{ id: string }>).map((i) => i.id)).toEqual([childId]);

      const nameContains = await request(httpServer(app))
        .get('/api/admin/v1/organizations')
        .query({ nameContains: '唯一名XYZ' })
        .set('Authorization', adminAuth);
      expect((nameContains.body.data.items as Array<{ id: string }>).map((i) => i.id)).toEqual([
        childId,
      ]);

      const codeContains = await request(httpServer(app))
        .get('/api/admin/v1/organizations')
        .query({ codeContains: 'CHILDXYZ' })
        .set('Authorization', adminAuth);
      expect((codeContains.body.data.items as Array<{ id: string }>).map((i) => i.id)).toEqual([
        childId,
      ]);
    });

    it('GET /tree-options → 200,树形 {id,label,code,children} 含子节点', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/organizations/tree-options')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      const root = (
        res.body.data as Array<{ id: string; label: string; code: string; children: unknown[] }>
      ).find((n) => n.id === rootId);
      expect(root).toMatchObject({ id: rootId, label: 'F1选择器根', code: 'F1ROOT' });
      expect(root?.children).toEqual([
        expect.objectContaining({
          id: childId,
          label: 'F1选择器子节点唯一名XYZ',
          code: 'F1CHILDXYZ',
        }),
      ]);
    });

    it('USER 调用 /options 或 /tree-options → RBAC_FORBIDDEN(复用 org.read.node,D2 不新增码)', async () => {
      const optionsRes = await request(httpServer(app))
        .get('/api/admin/v1/organizations/options')
        .set('Authorization', userAuth);
      expectBizError(optionsRes, BizCode.RBAC_FORBIDDEN);

      const treeOptionsRes = await request(httpServer(app))
        .get('/api/admin/v1/organizations/tree-options')
        .set('Authorization', userAuth);
      expectBizError(treeOptionsRes, BizCode.RBAC_FORBIDDEN);
    });
  });
});
