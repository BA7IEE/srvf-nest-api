import type { INestApplication } from '@nestjs/common';
import { DictItemStatus, DictTypeStatus, Role } from '@prisma/client';
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

// V2 Step 3 dictionaries 模块 e2e。
// 覆盖 13 接口主成功 + 关键失败路径(权限边界 / 唯一冲突 / 父级跨类型 / 引用拒删 / 树形)。
// 不覆盖:tree 深度极限 / 大批量分页 / 真实业务取值(留运营录入)。
//
// P0-F PR-2A(2026-05-18):入口切到 service 层 rbac.can();失败统一 RBAC_FORBIDDEN(30100)。
// `adminAuth` 在 beforeAll 全局 grant ops-admin(模拟运维上线 SOP),保留现有 ADMIN CRUD 用例;
// 单独建 `adminDefaultAuth`(未 grant)做"ADMIN 默认 30100"反向断言。
// D3=A:dict-type / dict-item softDelete 从 v1 仅 SA 放宽至 ops-admin 可调,沿评审稿 §6.1。

describe('dictionaries 模块', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let adminAuth: string;
  let adminDefaultAuth: string;
  let userAuth: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'dict-su', role: Role.SUPER_ADMIN });
    const admin = await createTestUser(app, { username: 'dict-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'dict-adm-default', role: Role.ADMIN });
    await createTestUser(app, { username: 'dict-user', role: Role.USER });

    superAdminAuth = (await loginAs(app, 'dict-su')).authHeader;
    adminAuth = (await loginAs(app, 'dict-adm')).authHeader;
    adminDefaultAuth = (await loginAs(app, 'dict-adm-default')).authHeader;
    userAuth = (await loginAs(app, 'dict-user')).authHeader;

    // P0-F PR-2A:seed 33 条 RBAC + ops-admin;给 dict-adm 全局 grant ops-admin
    // (sa 走短路,user / adminDefault 不 grant)
    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    await grantOpsAdminToUser(app, admin.id, seed.opsAdminRoleId);
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ 权限边界 ============

  describe('权限边界', () => {
    it('未登录 GET dict-types → 401', async () => {
      const res = await request(httpServer(app)).get('/api/system/v1/dict-types');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER 角色 GET dict-types → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/dict-types')
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER 角色 POST dict-types → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/dict-types')
        .set('Authorization', userAuth)
        .send({ code: 'p_user', label: 'x' });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    // P0-F PR-2A:ADMIN 默认无 ops-admin → 30100(v1 ADMIN 全权变收紧,显式反向断言)
    it('ADMIN 默认无 ops-admin → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/dict-types')
        .set('Authorization', adminDefaultAuth)
        .send({ code: 'p_adm_default', label: 'x' });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    // P0-F PR-2A D3=A:ADMIN+ops-admin 可调 dict-type softDelete(从 v1 仅 SA 放宽)
    it('ADMIN+ops-admin DELETE dict-type → 200(D3=A 放宽至 ops-admin)', async () => {
      const t = await prisma.dictType.create({
        data: { code: 'pb_adm_del_ok', label: 'x' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/dict-types/${t.id}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.id).toBe(t.id);
    });

    // P0-F PR-2A D3=A:ADMIN+ops-admin 可调 dict-item softDelete(从 v1 仅 SA 放宽)
    it('ADMIN+ops-admin DELETE dict-item → 200(D3=A 放宽至 ops-admin)', async () => {
      const t = await prisma.dictType.create({
        data: { code: 'pb_adm_di_ok', label: 'x' },
        select: { id: true },
      });
      const i = await prisma.dictItem.create({
        data: { typeId: t.id, code: 'pb-adm-di-i-ok', label: 'x' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/dict-items/${i.id}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.id).toBe(i.id);
    });
  });

  // ============ dict-types CRUD ============

  describe('dict-types CRUD', () => {
    it('SUPER_ADMIN 创建 dict-type → 201,字段集严格', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/dict-types')
        .set('Authorization', superAdminAuth)
        .send({ code: 'crd_t1', label: 'Create Test 1', sortOrder: 5 });

      expect(res.status).toBe(201);
      expect(res.body.code).toBe(0);
      expect(res.body.data.code).toBe('crd_t1');
      expect(res.body.data.label).toBe('Create Test 1');
      expect(res.body.data.sortOrder).toBe(5);
      expect(res.body.data.status).toBe(DictTypeStatus.ACTIVE);
      expect(res.body.data).not.toHaveProperty('deletedAt');
    });

    it('ADMIN 创建 dict-type → 201', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/dict-types')
        .set('Authorization', adminAuth)
        .send({ code: 'crd_t2', label: 'Admin Create' });
      expect(res.status).toBe(201);
      expect(res.body.data.sortOrder).toBe(0);
    });

    it('code 撞唯一 → DICT_TYPE_CODE_ALREADY_EXISTS', async () => {
      await request(httpServer(app))
        .post('/api/system/v1/dict-types')
        .set('Authorization', superAdminAuth)
        .send({ code: 'dup_t', label: 'first' });

      const res = await request(httpServer(app))
        .post('/api/system/v1/dict-types')
        .set('Authorization', superAdminAuth)
        .send({ code: 'dup_t', label: 'second' });

      expectBizError(res, BizCode.DICT_TYPE_CODE_ALREADY_EXISTS);
    });

    it('code 格式非法(含中横线 / 大写)→ 400', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/dict-types')
        .set('Authorization', superAdminAuth)
        .send({ code: 'Has-Dash', label: 'x' });
      expect(res.status).toBe(400);
    });

    it('GET 列表分页结构正确', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/dict-types?page=1&pageSize=5')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('items');
      expect(res.body.data).toHaveProperty('total');
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.pageSize).toBe(5);
      expect(Array.isArray(res.body.data.items)).toBe(true);
    });

    it('GET 列表 status 过滤', async () => {
      const t = await prisma.dictType.create({
        data: { code: 'flt_inactive', label: 'x', status: DictTypeStatus.INACTIVE },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .get('/api/system/v1/dict-types?status=INACTIVE')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      const codes: string[] = res.body.data.items.map((x: { code: string }) => x.code);
      expect(codes).toContain('flt_inactive');
      // 清理
      await prisma.dictType.delete({ where: { id: t.id } });
    });

    it('GET 详情 → 200', async () => {
      const t = await prisma.dictType.create({
        data: { code: 'fone_t', label: 'detail' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .get(`/api/system/v1/dict-types/${t.id}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.code).toBe('fone_t');
    });

    it('GET 详情 NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/dict-types/cl0000000000000000000000')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.DICT_TYPE_NOT_FOUND);
    });

    it('PATCH 更新 label / sortOrder', async () => {
      const t = await prisma.dictType.create({
        data: { code: 'upd_t1', label: 'orig', sortOrder: 0 },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .patch(`/api/system/v1/dict-types/${t.id}`)
        .set('Authorization', superAdminAuth)
        .send({ label: 'updated', sortOrder: 99 });
      expect(res.status).toBe(200);
      expect(res.body.data.label).toBe('updated');
      expect(res.body.data.sortOrder).toBe(99);
    });

    it('PATCH 拒绝 code 字段(forbidNonWhitelisted)', async () => {
      const t = await prisma.dictType.create({
        data: { code: 'upd_t2', label: 'orig' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .patch(`/api/system/v1/dict-types/${t.id}`)
        .set('Authorization', superAdminAuth)
        .send({ code: 'newcode' });
      expect(res.status).toBe(400);
    });

    it('PATCH /:id/status 启停', async () => {
      const t = await prisma.dictType.create({
        data: { code: 'sts_t1', label: 'orig' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .patch(`/api/system/v1/dict-types/${t.id}/status`)
        .set('Authorization', superAdminAuth)
        .send({ status: DictTypeStatus.INACTIVE });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(DictTypeStatus.INACTIVE);
    });

    it('DELETE 软删 → 200,deletedAt 设值', async () => {
      const t = await prisma.dictType.create({
        data: { code: 'del_t1', label: 'to delete' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/dict-types/${t.id}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      const after = await prisma.dictType.findUnique({ where: { id: t.id } });
      expect(after?.deletedAt).not.toBeNull();
      expect(after?.status).toBe(DictTypeStatus.INACTIVE);
    });

    it('DELETE 有 dict_items 引用 → DICT_TYPE_IN_USE', async () => {
      const t = await prisma.dictType.create({
        data: { code: 'in_use_t', label: 'parent' },
      });
      await prisma.dictItem.create({
        data: { typeId: t.id, code: 'in-use-item', label: 'child' },
      });
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/dict-types/${t.id}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.DICT_TYPE_IN_USE);
    });
  });

  // ============ dict-items CRUD + tree ============

  describe('dict-items CRUD + tree', () => {
    let typeId: string;

    beforeAll(async () => {
      const t = await prisma.dictType.create({
        data: { code: 'items_test_type', label: 'Items Test' },
        select: { id: true },
      });
      typeId = t.id;
    });

    it('POST 创建 dict-item → 201,parentId null', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/dict-items')
        .set('Authorization', superAdminAuth)
        .send({ typeId, code: 'item-1', label: 'Item 1' });
      expect(res.status).toBe(201);
      expect(res.body.data.typeId).toBe(typeId);
      expect(res.body.data.code).toBe('item-1');
      expect(res.body.data.parentId).toBeNull();
      expect(res.body.data).not.toHaveProperty('deletedAt');
    });

    it('POST 创建嵌套 item', async () => {
      const parent = await prisma.dictItem.create({
        data: { typeId, code: 'parent-item', label: 'Parent' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .post('/api/system/v1/dict-items')
        .set('Authorization', superAdminAuth)
        .send({ typeId, code: 'child-item', label: 'Child', parentId: parent.id });
      expect(res.status).toBe(201);
      expect(res.body.data.parentId).toBe(parent.id);
    });

    it('POST typeId 不存在 → DICT_TYPE_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/dict-items')
        .set('Authorization', superAdminAuth)
        .send({ typeId: 'cl0000000000000000000000', code: 'orphan', label: 'x' });
      expectBizError(res, BizCode.DICT_TYPE_NOT_FOUND);
    });

    it('POST parent 不存在 → DICT_ITEM_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/dict-items')
        .set('Authorization', superAdminAuth)
        .send({
          typeId,
          code: 'orphan-parent',
          label: 'x',
          parentId: 'cl0000000000000000000000',
        });
      expectBizError(res, BizCode.DICT_ITEM_NOT_FOUND);
    });

    it('POST 父级跨 type → DICT_ITEM_PARENT_TYPE_MISMATCH', async () => {
      const otherType = await prisma.dictType.create({
        data: { code: 'cross_type', label: 'Other' },
        select: { id: true },
      });
      const otherItem = await prisma.dictItem.create({
        data: { typeId: otherType.id, code: 'cross-i', label: 'O' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .post('/api/system/v1/dict-items')
        .set('Authorization', superAdminAuth)
        .send({
          typeId,
          code: 'cross-parent-test',
          label: 'cross',
          parentId: otherItem.id,
        });
      expectBizError(res, BizCode.DICT_ITEM_PARENT_TYPE_MISMATCH);
    });

    it('POST (typeId, code) 撞唯一 → DICT_ITEM_CODE_ALREADY_EXISTS', async () => {
      await request(httpServer(app))
        .post('/api/system/v1/dict-items')
        .set('Authorization', superAdminAuth)
        .send({ typeId, code: 'dup-item', label: 'first' });

      const res = await request(httpServer(app))
        .post('/api/system/v1/dict-items')
        .set('Authorization', superAdminAuth)
        .send({ typeId, code: 'dup-item', label: 'second' });
      expectBizError(res, BizCode.DICT_ITEM_CODE_ALREADY_EXISTS);
    });

    it('GET 列表 typeId 必填 → 400(参数校验)', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/dict-items')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(400);
    });

    it('GET 列表 typeId 不存在 → DICT_TYPE_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/dict-items?typeId=cl0000000000000000000000')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.DICT_TYPE_NOT_FOUND);
    });

    it('GET 列表 parentId 过滤', async () => {
      const subType = await prisma.dictType.create({
        data: { code: 'flt_p_type', label: 'x' },
        select: { id: true },
      });
      const root = await prisma.dictItem.create({
        data: { typeId: subType.id, code: 'flt-root', label: 'root' },
      });
      await prisma.dictItem.create({
        data: { typeId: subType.id, code: 'flt-c1', label: 'c1', parentId: root.id },
      });
      await prisma.dictItem.create({
        data: { typeId: subType.id, code: 'flt-c2', label: 'c2', parentId: root.id },
      });
      const res = await request(httpServer(app))
        .get(`/api/system/v1/dict-items?typeId=${subType.id}&parentId=${root.id}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(2);
    });

    it('GET tree 嵌套结构', async () => {
      const treeType = await prisma.dictType.create({
        data: { code: 'tree_type', label: 'Tree' },
      });
      const root = await prisma.dictItem.create({
        data: { typeId: treeType.id, code: 'tree-root', label: 'Root', sortOrder: 0 },
      });
      await prisma.dictItem.create({
        data: {
          typeId: treeType.id,
          code: 'tree-leaf',
          label: 'Leaf',
          parentId: root.id,
          sortOrder: 0,
        },
      });
      const res = await request(httpServer(app))
        .get(`/api/system/v1/dict-items/tree?typeId=${treeType.id}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].code).toBe('tree-root');
      expect(res.body.data[0].children).toHaveLength(1);
      expect(res.body.data[0].children[0].code).toBe('tree-leaf');
    });

    it('GET tree typeId 不存在 → DICT_TYPE_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/dict-items/tree?typeId=cl0000000000000000000000')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.DICT_TYPE_NOT_FOUND);
    });

    it('GET /:id NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/dict-items/cl0000000000000000000000')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.DICT_ITEM_NOT_FOUND);
    });

    it('PATCH 更新 label / sortOrder', async () => {
      const item = await prisma.dictItem.create({
        data: { typeId, code: 'upd-i1', label: 'orig', sortOrder: 0 },
      });
      const res = await request(httpServer(app))
        .patch(`/api/system/v1/dict-items/${item.id}`)
        .set('Authorization', superAdminAuth)
        .send({ label: 'updated', sortOrder: 99 });
      expect(res.status).toBe(200);
      expect(res.body.data.label).toBe('updated');
      expect(res.body.data.sortOrder).toBe(99);
    });

    it('PATCH 拒绝 typeId / code / parentId(forbidNonWhitelisted)', async () => {
      const item = await prisma.dictItem.create({
        data: { typeId, code: 'upd-i2', label: 'orig' },
      });
      const res = await request(httpServer(app))
        .patch(`/api/system/v1/dict-items/${item.id}`)
        .set('Authorization', superAdminAuth)
        .send({ code: 'newcode' });
      expect(res.status).toBe(400);
    });

    it('PATCH /:id/status 启停', async () => {
      const item = await prisma.dictItem.create({
        data: { typeId, code: 'sts-i1', label: 'orig' },
      });
      const res = await request(httpServer(app))
        .patch(`/api/system/v1/dict-items/${item.id}/status`)
        .set('Authorization', superAdminAuth)
        .send({ status: DictItemStatus.INACTIVE });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(DictItemStatus.INACTIVE);
    });

    it('DELETE 软删 dict-item → 200', async () => {
      const item = await prisma.dictItem.create({
        data: { typeId, code: 'del-me', label: 'del' },
      });
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/dict-items/${item.id}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      const after = await prisma.dictItem.findUnique({ where: { id: item.id } });
      expect(after?.deletedAt).not.toBeNull();
      expect(after?.status).toBe(DictItemStatus.INACTIVE);
    });

    it('DELETE 有子节点 → DICT_ITEM_IN_USE', async () => {
      const parent = await prisma.dictItem.create({
        data: { typeId, code: 'p-in-use', label: 'p' },
      });
      await prisma.dictItem.create({
        data: { typeId, code: 'c-of-parent', label: 'c', parentId: parent.id },
      });
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/dict-items/${parent.id}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.DICT_ITEM_IN_USE);
    });
  });

  // ============ W3 系统内置防误删守卫 ============
  // 2026-06-21 goal「字典内置」:seed 内置类型禁【类型】删;闭集 + 国标 + 队内内置类型下的项禁【项】删;
  // 占位 / 开放分类类型(node_type / content_type)的项 + 运营自建类型 / 项行为不变。
  // 守卫按 type.code 判定,故 e2e 直接以受保护 code 造 type/item 即可触发(无需跑 seed)。
  describe('系统内置防误删守卫 (W3)', () => {
    it('DELETE 系统内置类型(member_grade)→ DICT_TYPE_SYSTEM_PROTECTED', async () => {
      const t = await prisma.dictType.create({
        data: { code: 'member_grade', label: '队员级别' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/dict-types/${t.id}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.DICT_TYPE_SYSTEM_PROTECTED);
    });

    it('DELETE 占位内置类型(node_type)→ DICT_TYPE_SYSTEM_PROTECTED(类型受保护,即便其项不受保护)', async () => {
      const t = await prisma.dictType.create({
        data: { code: 'node_type', label: '节点类别' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/dict-types/${t.id}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.DICT_TYPE_SYSTEM_PROTECTED);
    });

    it('DELETE 闭集内置项(attendance_status / present)→ DICT_ITEM_SYSTEM_PROTECTED', async () => {
      const t = await prisma.dictType.create({
        data: { code: 'attendance_status', label: '考勤明细状态' },
        select: { id: true },
      });
      const i = await prisma.dictItem.create({
        data: { typeId: t.id, code: 'present', label: '已到场' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/dict-items/${i.id}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.DICT_ITEM_SYSTEM_PROTECTED);
    });

    it('DELETE 国标内置项(gender / male)→ DICT_ITEM_SYSTEM_PROTECTED', async () => {
      const t = await prisma.dictType.create({
        data: { code: 'gender', label: '性别' },
        select: { id: true },
      });
      const i = await prisma.dictItem.create({
        data: { typeId: t.id, code: 'male', label: '男' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/dict-items/${i.id}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.DICT_ITEM_SYSTEM_PROTECTED);
    });

    it('PATCH 受保护项 label / sortOrder → 200(守卫只封 delete,不封 update)', async () => {
      const t = await prisma.dictType.create({
        data: { code: 'blood_type', label: '血型' },
        select: { id: true },
      });
      const i = await prisma.dictItem.create({
        data: { typeId: t.id, code: 'a', label: 'A 型', sortOrder: 0 },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .patch(`/api/system/v1/dict-items/${i.id}`)
        .set('Authorization', superAdminAuth)
        .send({ label: 'A 型(改)', sortOrder: 9 });
      expect(res.status).toBe(200);
      expect(res.body.data.label).toBe('A 型(改)');
      expect(res.body.data.sortOrder).toBe(9);
    });

    it('PATCH /:id/status 受保护项启停 → 200', async () => {
      const t = await prisma.dictType.create({
        data: { code: 'political_status', label: '政治面貌' },
        select: { id: true },
      });
      const i = await prisma.dictItem.create({
        data: { typeId: t.id, code: 'masses', label: '群众' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .patch(`/api/system/v1/dict-items/${i.id}/status`)
        .set('Authorization', superAdminAuth)
        .send({ status: DictItemStatus.INACTIVE });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(DictItemStatus.INACTIVE);
    });

    it('DELETE 队内内置类型下的项(activity_type / rescue)→ DICT_ITEM_SYSTEM_PROTECTED', async () => {
      const t = await prisma.dictType.create({
        data: { code: 'activity_type', label: '活动类型' },
        select: { id: true },
      });
      const i = await prisma.dictItem.create({
        data: { typeId: t.id, code: 'rescue', label: '救援' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/dict-items/${i.id}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.DICT_ITEM_SYSTEM_PROTECTED);
    });

    it('DELETE 内置类型(notification_type)及其项 → 均 SYSTEM_PROTECTED(review #484 G2 补登记;同一 code 唯一约束,类型/项两断言合一测试)', async () => {
      const t = await prisma.dictType.create({
        data: { code: 'notification_type', label: '通知类型' },
        select: { id: true },
      });
      const i = await prisma.dictItem.create({
        data: { typeId: t.id, code: 'general', label: '一般通知' },
        select: { id: true },
      });
      const itemRes = await request(httpServer(app))
        .delete(`/api/system/v1/dict-items/${i.id}`)
        .set('Authorization', superAdminAuth);
      expectBizError(itemRes, BizCode.DICT_ITEM_SYSTEM_PROTECTED);

      const typeRes = await request(httpServer(app))
        .delete(`/api/system/v1/dict-types/${t.id}`)
        .set('Authorization', superAdminAuth);
      expectBizError(typeRes, BizCode.DICT_TYPE_SYSTEM_PROTECTED);
    });

    it('DELETE 开放分类类型下的项(content_type / announcement)→ 200(运营可维护)', async () => {
      const t = await prisma.dictType.create({
        data: { code: 'content_type', label: '内容类型' },
        select: { id: true },
      });
      const i = await prisma.dictItem.create({
        data: { typeId: t.id, code: 'announcement', label: '公告' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/dict-items/${i.id}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(i.id);
    });

    it('DELETE 运营自建类型 → 200(回归:非内置类型行为不变)', async () => {
      const t = await prisma.dictType.create({
        data: { code: 'ops_custom_w3', label: '运营自建' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/dict-types/${t.id}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(t.id);
    });

    it('DELETE 运营自建类型下的项 → 200(回归:非内置项行为不变)', async () => {
      const t = await prisma.dictType.create({
        data: { code: 'ops_custom_w3_items', label: '运营自建' },
        select: { id: true },
      });
      const i = await prisma.dictItem.create({
        data: { typeId: t.id, code: 'ops-item-1', label: 'x' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/dict-items/${i.id}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(i.id);
    });
  });
});
