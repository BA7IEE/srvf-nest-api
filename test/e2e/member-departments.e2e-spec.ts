import type { INestApplication } from '@nestjs/common';
import { MemberStatus, OrganizationStatus, Role } from '@prisma/client';
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

// V2 Step 6 member_departments 归属能力 e2e。
// 覆盖 3 接口主成功 + 关键失败:权限边界 / GET 无归属返 null / PUT 幂等 + 事务原子 /
// DELETE 解除 / 单归属约束(partial unique index DB 层兜底) / 软删后重新归属。
//
// P0-F PR-2A(2026-05-18):入口切到 service 层 rbac.can();失败统一 RBAC_FORBIDDEN(30100)。
// `adminAuth` 在 beforeAll 全局 grant ops-admin(沿 dict / org e2e 范式);单独建 `adminDefaultAuth`
// 做"ADMIN 默认 30100"反向断言。D4=A:member-department 使用 set.current / clear.current
// (沿 seed permission code 命名)。

describe('member-departments 归属能力', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let adminAuth: string;
  let adminDefaultAuth: string;
  let userAuth: string;

  let nodeTypeCode: string;
  let activeOrgIdA: string;
  let activeOrgIdB: string;
  let inactiveOrgId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'md-su', role: Role.SUPER_ADMIN });
    const admin = await createTestUser(app, { username: 'md-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'md-adm-default', role: Role.ADMIN });
    await createTestUser(app, { username: 'md-user', role: Role.USER });
    superAdminAuth = (await loginAs(app, 'md-su')).authHeader;
    adminAuth = (await loginAs(app, 'md-adm')).authHeader;
    adminDefaultAuth = (await loginAs(app, 'md-adm-default')).authHeader;
    userAuth = (await loginAs(app, 'md-user')).authHeader;

    // P0-F PR-2A:seed 33 条 RBAC + ops-admin;给 md-adm 全局 grant ops-admin
    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    await grantOpsAdminToUser(app, admin.id, seed.opsAdminRoleId);

    // 准备字典:node_type 用于 organizations
    const nodeType = await prisma.dictType.create({
      data: { code: 'node_type', label: 'Node Type' },
      select: { id: true },
    });
    const item = await prisma.dictItem.create({
      data: { typeId: nodeType.id, code: 'demo-md-nodetype-1', label: 'NT' },
      select: { code: true },
    });
    nodeTypeCode = item.code;

    // 准备 organizations:2 个 ACTIVE + 1 个 INACTIVE
    const orgA = await prisma.organization.create({
      data: { name: 'demo-md-orgA', nodeTypeCode },
      select: { id: true },
    });
    activeOrgIdA = orgA.id;
    const orgB = await prisma.organization.create({
      data: { name: 'demo-md-orgB', nodeTypeCode, parentId: orgA.id },
      select: { id: true },
    });
    activeOrgIdB = orgB.id;
    const orgInactive = await prisma.organization.create({
      data: {
        name: 'demo-md-orgINACTIVE',
        nodeTypeCode,
        parentId: orgA.id,
        status: OrganizationStatus.INACTIVE,
      },
      select: { id: true },
    });
    inactiveOrgId = orgInactive.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ 权限边界 ============

  describe('权限边界', () => {
    let memberId: string;

    beforeAll(async () => {
      const m = await prisma.member.create({
        data: { memberNo: 'demo-md-pb-1', displayName: 'PB' },
        select: { id: true },
      });
      memberId = m.id;
    });

    it('未登录 GET → 401', async () => {
      const res = await request(httpServer(app)).get(`/api/v2/members/${memberId}/department`);
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER GET → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/members/${memberId}/department`)
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER PUT → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .put(`/api/v2/members/${memberId}/department`)
        .set('Authorization', userAuth)
        .send({ organizationId: activeOrgIdA });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER DELETE → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/v2/members/${memberId}/department`)
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    // P0-F PR-2A:ADMIN 默认无 ops-admin → 30100(显式反向断言)
    it('ADMIN 默认无 ops-admin → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/members/${memberId}/department`)
        .set('Authorization', adminDefaultAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  // ============ GET 当前归属 ============

  describe('GET 当前归属', () => {
    let memberWithoutDept: string;
    let memberWithDept: string;
    let deptId: string;

    beforeAll(async () => {
      const m1 = await prisma.member.create({
        data: { memberNo: 'demo-md-get-1', displayName: 'NoDept' },
      });
      memberWithoutDept = m1.id;

      const m2 = await prisma.member.create({
        data: { memberNo: 'demo-md-get-2', displayName: 'WithDept' },
      });
      memberWithDept = m2.id;
      const dept = await prisma.memberDepartment.create({
        data: { memberId: m2.id, organizationId: activeOrgIdA },
      });
      deptId = dept.id;
    });

    it('member 不存在 → MEMBER_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/members/cl0000000000000000000000/department')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('member 无归属 → 200 + data: null', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/members/${memberWithoutDept}/department`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data).toBeNull();
    });

    it('member 有归属 → 200 + 数据', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/members/${memberWithDept}/department`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(deptId);
      expect(res.body.data.memberId).toBe(memberWithDept);
      expect(res.body.data.organizationId).toBe(activeOrgIdA);
      expect(res.body.data).not.toHaveProperty('deletedAt');
    });
  });

  // ============ PUT 幂等设置 ============

  describe('PUT 幂等设置', () => {
    let memberId: string;

    beforeAll(async () => {
      const m = await prisma.member.create({
        data: { memberNo: 'demo-md-put-1', displayName: 'Put' },
      });
      memberId = m.id;
    });

    it('member 不存在 → MEMBER_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .put('/api/v2/members/cl0000000000000000000000/department')
        .set('Authorization', superAdminAuth)
        .send({ organizationId: activeOrgIdA });
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('organization 不存在 → ORGANIZATION_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .put(`/api/v2/members/${memberId}/department`)
        .set('Authorization', superAdminAuth)
        .send({ organizationId: 'cl0000000000000000000000' });
      expectBizError(res, BizCode.ORGANIZATION_NOT_FOUND);
    });

    it('member INACTIVE → MEMBER_INACTIVE', async () => {
      const inactiveMember = await prisma.member.create({
        data: {
          memberNo: 'demo-md-put-i',
          displayName: 'I',
          status: MemberStatus.INACTIVE,
        },
      });
      const res = await request(httpServer(app))
        .put(`/api/v2/members/${inactiveMember.id}/department`)
        .set('Authorization', superAdminAuth)
        .send({ organizationId: activeOrgIdA });
      expectBizError(res, BizCode.MEMBER_INACTIVE);
    });

    it('organization INACTIVE → ORGANIZATION_INACTIVE', async () => {
      const res = await request(httpServer(app))
        .put(`/api/v2/members/${memberId}/department`)
        .set('Authorization', superAdminAuth)
        .send({ organizationId: inactiveOrgId });
      expectBizError(res, BizCode.ORGANIZATION_INACTIVE);
    });

    it('第一次设置 → 200 + 创建归属', async () => {
      const res = await request(httpServer(app))
        .put(`/api/v2/members/${memberId}/department`)
        .set('Authorization', adminAuth)
        .send({ organizationId: activeOrgIdA });
      expect(res.status).toBe(200);
      expect(res.body.data.memberId).toBe(memberId);
      expect(res.body.data.organizationId).toBe(activeOrgIdA);
      expect(res.body.data).not.toHaveProperty('deletedAt');

      // DB 验证
      const count = await prisma.memberDepartment.count({
        where: { memberId, deletedAt: null },
      });
      expect(count).toBe(1);
    });

    it('幂等:同 organizationId → 200 + 现归属(无副作用,id 不变)', async () => {
      const before = await prisma.memberDepartment.findFirst({
        where: { memberId, deletedAt: null },
      });
      expect(before).not.toBeNull();

      const res = await request(httpServer(app))
        .put(`/api/v2/members/${memberId}/department`)
        .set('Authorization', adminAuth)
        .send({ organizationId: activeOrgIdA });
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(before!.id); // id 不变
      expect(res.body.data.organizationId).toBe(activeOrgIdA);

      // DB 验证仅 1 条 active(决策 5:幂等无副作用,不软删旧)
      const activeCount = await prisma.memberDepartment.count({
        where: { memberId, deletedAt: null },
      });
      expect(activeCount).toBe(1);
      const afterTotal = await prisma.memberDepartment.count({ where: { memberId } });
      expect(afterTotal).toBe(1);
    });

    it('换部门:不同 organizationId → 200 + 软删旧 + 创建新(单事务原子)', async () => {
      const oldDept = await prisma.memberDepartment.findFirst({
        where: { memberId, deletedAt: null },
      });
      expect(oldDept).not.toBeNull();

      const res = await request(httpServer(app))
        .put(`/api/v2/members/${memberId}/department`)
        .set('Authorization', superAdminAuth)
        .send({ organizationId: activeOrgIdB });
      expect(res.status).toBe(200);
      expect(res.body.data.organizationId).toBe(activeOrgIdB);
      expect(res.body.data.id).not.toBe(oldDept!.id); // 新归属不同 id

      // DB 验证:旧归属 deletedAt 非空;新归属 active 仅 1 条
      const oldAfter = await prisma.memberDepartment.findUnique({
        where: { id: oldDept!.id },
      });
      expect(oldAfter?.deletedAt).not.toBeNull();
      expect(oldAfter?.organizationId).toBe(activeOrgIdA);

      const activeCount = await prisma.memberDepartment.count({
        where: { memberId, deletedAt: null },
      });
      expect(activeCount).toBe(1);
    });
  });

  // ============ DELETE 解除归属 ============

  describe('DELETE 解除归属', () => {
    it('member 不存在 → MEMBER_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .delete('/api/v2/members/cl0000000000000000000000/department')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('member 无归属 → MEMBER_DEPARTMENT_NOT_FOUND', async () => {
      const m = await prisma.member.create({
        data: { memberNo: 'demo-md-del-1', displayName: 'NoDept' },
      });
      const res = await request(httpServer(app))
        .delete(`/api/v2/members/${m.id}/department`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.MEMBER_DEPARTMENT_NOT_FOUND);
    });

    it('member 有归属 → 200 + DB 软删 + 之后 GET 返 null', async () => {
      const m = await prisma.member.create({
        data: { memberNo: 'demo-md-del-2', displayName: 'WithDept' },
      });
      const dept = await prisma.memberDepartment.create({
        data: { memberId: m.id, organizationId: activeOrgIdA },
      });

      const delRes = await request(httpServer(app))
        .delete(`/api/v2/members/${m.id}/department`)
        .set('Authorization', adminAuth);
      expect(delRes.status).toBe(200);
      expect(delRes.body.data.id).toBe(dept.id);

      const after = await prisma.memberDepartment.findUnique({ where: { id: dept.id } });
      expect(after?.deletedAt).not.toBeNull();

      // GET 返 null
      const getRes = await request(httpServer(app))
        .get(`/api/v2/members/${m.id}/department`)
        .set('Authorization', adminAuth);
      expect(getRes.status).toBe(200);
      expect(getRes.body.data).toBeNull();
    });
  });

  // ============ 单归属约束 + 软删后重新归属 ============

  describe('单归属约束 (partial unique index)', () => {
    it('DB 层:同 member 直接创建第二条 active 归属 → P2002', async () => {
      const m = await prisma.member.create({
        data: { memberNo: 'demo-md-uq-1', displayName: 'UQ' },
      });
      await prisma.memberDepartment.create({
        data: { memberId: m.id, organizationId: activeOrgIdA },
      });
      // 第二条 active(deletedAt=null)应被 partial unique index 拒绝
      await expect(
        prisma.memberDepartment.create({
          data: { memberId: m.id, organizationId: activeOrgIdB },
        }),
      ).rejects.toThrow(/Unique constraint/i);
    });

    it('软删旧归属后,再次 PUT 同 organizationId → 创建新归属(不撞 partial unique)', async () => {
      const m = await prisma.member.create({
        data: { memberNo: 'demo-md-resu-1', displayName: 'ReSU' },
      });
      // 创建 + 软删
      const old = await prisma.memberDepartment.create({
        data: { memberId: m.id, organizationId: activeOrgIdA },
      });
      await prisma.memberDepartment.update({
        where: { id: old.id },
        data: { deletedAt: new Date() },
      });

      // 再次 PUT 同 org → 应创建新归属(因为 partial unique index 仅约束 active)
      const res = await request(httpServer(app))
        .put(`/api/v2/members/${m.id}/department`)
        .set('Authorization', superAdminAuth)
        .send({ organizationId: activeOrgIdA });
      expect(res.status).toBe(200);
      expect(res.body.data.id).not.toBe(old.id);
      expect(res.body.data.organizationId).toBe(activeOrgIdA);
    });
  });
});
