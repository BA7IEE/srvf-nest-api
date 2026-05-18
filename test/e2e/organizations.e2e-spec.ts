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
      const res = await request(httpServer(app)).get('/api/v2/organizations');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER GET → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/organizations')
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER POST → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/organizations')
        .set('Authorization', userAuth)
        .send({ name: 'x', nodeTypeCode: activeNodeTypeCode });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    // P0-F PR-2A:ADMIN 默认无 ops-admin → 30100(v1 ADMIN 全权变收紧,显式反向断言)
    it('ADMIN 默认无 ops-admin → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/organizations')
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
        .delete(`/api/v2/organizations/${root.id}`)
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
        .post('/api/v2/organizations')
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
        .post('/api/v2/organizations')
        .set('Authorization', superAdminAuth)
        .send({ name: 'Another Root', nodeTypeCode: activeNodeTypeCode });
      expectBizError(res, BizCode.ORGANIZATION_ROOT_ALREADY_EXISTS);
    });

    it('ADMIN 创建子节点 → 201', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/organizations')
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
        .post('/api/v2/organizations')
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
        .post('/api/v2/organizations')
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
        .post('/api/v2/organizations')
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
        .post('/api/v2/organizations')
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
        .get('/api/v2/organizations?page=1&pageSize=10')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('items');
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.pageSize).toBe(10);
    });

    it('GET 列表 parentId=null 过滤(根节点)', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/organizations?parentId=null')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      for (const item of res.body.data.items) {
        expect(item.parentId).toBeNull();
      }
    });

    it('GET 列表 parentId=<id> 过滤(子节点)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/organizations?parentId=${rootId}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      for (const item of res.body.data.items) {
        expect(item.parentId).toBe(rootId);
      }
    });

    it('GET tree 嵌套结构', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/organizations/tree')
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
        .get(`/api/v2/organizations/${rootId}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(rootId);
    });

    it('GET 详情 NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/organizations/cl0000000000000000000000')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ORGANIZATION_NOT_FOUND);
    });

    it('PATCH 更新 name / sortOrder', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/organizations/${childId}`)
        .set('Authorization', superAdminAuth)
        .send({ name: 'Renamed Child', sortOrder: 99 });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Renamed Child');
      expect(res.body.data.sortOrder).toBe(99);
    });

    it('PATCH 更新 nodeTypeCode 校验失败 → ORGANIZATION_NODE_TYPE_INVALID', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/organizations/${childId}`)
        .set('Authorization', superAdminAuth)
        .send({ nodeTypeCode: 'no-such-code' });
      expectBizError(res, BizCode.ORGANIZATION_NODE_TYPE_INVALID);
    });

    it('PATCH 拒绝 parentId(forbidNonWhitelisted)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/organizations/${childId}`)
        .set('Authorization', superAdminAuth)
        .send({ parentId: 'cl0000000000000000000000' });
      expect(res.status).toBe(400);
    });

    it('PATCH 拒绝 status(forbidNonWhitelisted)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/organizations/${childId}`)
        .set('Authorization', superAdminAuth)
        .send({ status: 'INACTIVE' });
      expect(res.status).toBe(400);
    });

    it('PATCH /:id/status 启停子节点', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/organizations/${childId}/status`)
        .set('Authorization', superAdminAuth)
        .send({ status: OrganizationStatus.INACTIVE });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(OrganizationStatus.INACTIVE);
    });

    it('PATCH /:id/status INACTIVE 唯一活跃根 → LAST_ROOT_ORGANIZATION_PROTECTED', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/organizations/${rootId}/status`)
        .set('Authorization', superAdminAuth)
        .send({ status: OrganizationStatus.INACTIVE });
      expectBizError(res, BizCode.LAST_ROOT_ORGANIZATION_PROTECTED);
    });

    it('DELETE 有子节点 → ORGANIZATION_HAS_CHILDREN', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/v2/organizations/${rootId}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.ORGANIZATION_HAS_CHILDREN);
    });

    it('DELETE 子节点 → 200(无子节点 / 无成员归属)', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/v2/organizations/${childId}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      const after = await prisma.organization.findUnique({ where: { id: childId } });
      expect(after?.deletedAt).not.toBeNull();
      expect(after?.status).toBe(OrganizationStatus.INACTIVE);
    });

    it('DELETE 唯一活跃根(无子节点)→ LAST_ROOT_ORGANIZATION_PROTECTED', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/v2/organizations/${rootId}`)
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
        .post('/api/v2/organizations')
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
        .post('/api/v2/organizations')
        .set('Authorization', superAdminAuth)
        .send({ name: 'New Root After Soft-Delete', nodeTypeCode: activeNodeTypeCode });
      expect(res.status).toBe(201);
      expect(res.body.data.parentId).toBeNull();
    });
  });
});
