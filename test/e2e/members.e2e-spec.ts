import type { INestApplication } from '@nestjs/common';
import { DictItemStatus, MemberStatus, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2 Step 5 members 模块 e2e。
// 覆盖 6 接口主成功 + 关键失败:权限边界 / memberNo 唯一(包含软删) /
// gradeCode 字典校验 / PATCH 拒 memberNo+status / DELETE 引用拒删 / status 切换。
//
// Slow-4 T2(2026-06-11,评审稿 §8 / D-S4-4):入口切到 service 层 rbac.can();
// 失败统一 RBAC_FORBIDDEN(30100)。`adminAuth` 在 beforeAll 全局 grant biz-admin
// (对应迁移前 @Roles 放行语义,业务断言零修改);DELETE 码不绑 biz-admin
// (仅 SUPER_ADMIN 短路,D1=A 镜像)。细粒度判权矩阵另见 members-rbac-boundary.e2e-spec.ts。

describe('members 模块', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let adminAuth: string;
  let userAuth: string;
  let adminId: string;
  let bizAdminRoleId: string;

  let activeGradeCode: string;
  let inactiveGradeCode: string;
  let wrongTypeGradeCode: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'mem-su', role: Role.SUPER_ADMIN });
    const admin = await createTestUser(app, { username: 'mem-adm', role: Role.ADMIN });
    adminId = admin.id;
    await createTestUser(app, { username: 'mem-user', role: Role.USER });
    superAdminAuth = (await loginAs(app, 'mem-su')).authHeader;
    adminAuth = (await loginAs(app, 'mem-adm')).authHeader;
    userAuth = (await loginAs(app, 'mem-user')).authHeader;

    // Slow-4 T2:seed 36 条业务面码 + biz-admin;给 mem-adm 全局 grant(沿 org e2e 范式)
    const bizSeed = await seedBizAdminPermissionsAndRole(app);
    bizAdminRoleId = bizSeed.bizAdminRoleId;
    await grantBizAdminToUser(app, adminId, bizAdminRoleId);

    // 准备 member_grade 字典 + 1 ACTIVE / 1 INACTIVE
    const gradeType = await prisma.dictType.create({
      data: { code: 'member_grade', label: 'Member Grade' },
      select: { id: true },
    });
    const active = await prisma.dictItem.create({
      data: { typeId: gradeType.id, code: 'demo-grade-a', label: 'Active' },
      select: { code: true },
    });
    activeGradeCode = active.code;
    const inactive = await prisma.dictItem.create({
      data: {
        typeId: gradeType.id,
        code: 'demo-grade-i',
        label: 'Inactive',
        status: DictItemStatus.INACTIVE,
      },
      select: { code: true },
    });
    inactiveGradeCode = inactive.code;

    // 错误 type(node_type)下的 item,测试跨 type 拒绝
    const nodeType = await prisma.dictType.create({
      data: { code: 'node_type', label: 'Node Type' },
    });
    const wrong = await prisma.dictItem.create({
      data: { typeId: nodeType.id, code: 'demo-wrong-grade', label: 'Wrong' },
      select: { code: true },
    });
    wrongTypeGradeCode = wrong.code;
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ 权限边界 ============

  describe('权限边界', () => {
    it('未登录 GET → 401', async () => {
      const res = await request(httpServer(app)).get('/api/admin/v1/members');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER GET → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/members')
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER POST → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/members')
        .set('Authorization', userAuth)
        .send({ memberNo: 'demo-x1', displayName: 'X' });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    // DoD-4 ⑤:member.delete.record 不绑 biz-admin → ADMIN 即使持 biz-admin 仍 30100(D1=A 镜像)
    it('ADMIN(持 biz-admin)DELETE → 30100(码不绑,仅 SUPER_ADMIN 短路)', async () => {
      const member = await prisma.member.create({
        data: { memberNo: 'demo-pb-1', displayName: 'P' },
      });
      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/members/${member.id}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  // ============ CRUD 主路径 ============

  describe('CRUD 主路径', () => {
    let memberId: string;

    it('SUPER_ADMIN 创建 → 201,响应含 memberNo,不含 deletedAt', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/members')
        .set('Authorization', superAdminAuth)
        .send({
          memberNo: 'demo-m1',
          displayName: 'Demo Member 1',
          gradeCode: activeGradeCode,
        });
      expect(res.status).toBe(201);
      expect(res.body.code).toBe(0);
      expect(res.body.data.memberNo).toBe('demo-m1');
      expect(res.body.data.displayName).toBe('Demo Member 1');
      expect(res.body.data.gradeCode).toBe(activeGradeCode);
      expect(res.body.data.status).toBe(MemberStatus.ACTIVE);
      expect(res.body.data).not.toHaveProperty('deletedAt');
      memberId = res.body.data.id;
    });

    it('memberNo 含前后空格 → 400(DTO @Matches 拒绝;与 v1 username 行为一致)', async () => {
      // 注:contract §4.2 "trim 后保存" 描述的是 service 层防御性 trim,但
      // CreateMemberDto.memberNo @Matches(/^[A-Za-z0-9-]+$/) 不允许空格,
      // DTO 层会先拦截。这是有意的(沿用 v1 username 同模式),前后空格视为非法输入。
      const res = await request(httpServer(app))
        .post('/api/admin/v1/members')
        .set('Authorization', superAdminAuth)
        .send({
          memberNo: '  demo-Trim-Me  ',
          displayName: 'Trim',
        });
      expect(res.status).toBe(400);
    });

    it('memberNo 保留原大小写(不强制 lowercase)', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/members')
        .set('Authorization', superAdminAuth)
        .send({
          memberNo: 'demo-MixedCase-1',
          displayName: 'Mixed Case',
        });
      expect(res.status).toBe(201);
      expect(res.body.data.memberNo).toBe('demo-MixedCase-1');
    });

    it('ADMIN 创建(无 gradeCode) → 201', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/members')
        .set('Authorization', adminAuth)
        .send({ memberNo: 'demo-m2', displayName: 'Demo 2' });
      expect(res.status).toBe(201);
      expect(res.body.data.gradeCode).toBeNull();
    });

    it('memberNo 撞活跃记录 → MEMBER_NO_ALREADY_EXISTS', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/members')
        .set('Authorization', superAdminAuth)
        .send({ memberNo: 'demo-m1', displayName: 'Dup' });
      expectBizError(res, BizCode.MEMBER_NO_ALREADY_EXISTS);
    });

    it('memberNo 撞软删历史 → MEMBER_NO_ALREADY_EXISTS(全局唯一不复用)', async () => {
      // 先创建并直接 DB 软删一个 member,留下 memberNo
      await prisma.member.create({
        data: {
          memberNo: 'demo-soft-deleted',
          displayName: 'Old',
          deletedAt: new Date(),
        },
      });
      const res = await request(httpServer(app))
        .post('/api/admin/v1/members')
        .set('Authorization', superAdminAuth)
        .send({ memberNo: 'demo-soft-deleted', displayName: 'New' });
      expectBizError(res, BizCode.MEMBER_NO_ALREADY_EXISTS);
    });

    it('gradeCode 不存在 → MEMBER_GRADE_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/members')
        .set('Authorization', superAdminAuth)
        .send({
          memberNo: 'demo-m3',
          displayName: 'X',
          gradeCode: 'no-such-grade',
        });
      expectBizError(res, BizCode.MEMBER_GRADE_CODE_INVALID);
    });

    it('gradeCode 在错误 type 下 → MEMBER_GRADE_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/members')
        .set('Authorization', superAdminAuth)
        .send({
          memberNo: 'demo-m4',
          displayName: 'X',
          gradeCode: wrongTypeGradeCode,
        });
      expectBizError(res, BizCode.MEMBER_GRADE_CODE_INVALID);
    });

    it('gradeCode 是 INACTIVE → MEMBER_GRADE_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/members')
        .set('Authorization', superAdminAuth)
        .send({
          memberNo: 'demo-m5',
          displayName: 'X',
          gradeCode: inactiveGradeCode,
        });
      expectBizError(res, BizCode.MEMBER_GRADE_CODE_INVALID);
    });

    it('memberNo 含特殊字符 → 400(DTO 校验)', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/members')
        .set('Authorization', superAdminAuth)
        .send({ memberNo: 'demo m1', displayName: 'X' });
      expect(res.status).toBe(400);
    });

    it('memberNo 超长(33 字符) → 400', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/members')
        .set('Authorization', superAdminAuth)
        .send({ memberNo: 'a'.repeat(33), displayName: 'X' });
      expect(res.status).toBe(400);
    });

    it('GET 列表分页', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/members?page=1&pageSize=5')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('items');
      expect(res.body.data).toHaveProperty('total');
    });

    it('GET 列表 ?memberNo=<exact> 精确匹配', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/members?memberNo=demo-m1')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBe(1);
      expect(res.body.data.items[0].memberNo).toBe('demo-m1');
    });

    it('GET 列表 ?gradeCode 过滤', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members?gradeCode=${activeGradeCode}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      for (const item of res.body.data.items) {
        expect(item.gradeCode).toBe(activeGradeCode);
      }
    });

    it('GET 详情 → 含 memberNo,不含 deletedAt', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberId}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.memberNo).toBe('demo-m1');
      expect(res.body.data).not.toHaveProperty('deletedAt');
    });

    it('GET 详情 NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/members/cl0000000000000000000000')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('PATCH displayName / gradeCode → 200', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}`)
        .set('Authorization', superAdminAuth)
        .send({ displayName: 'Renamed' });
      expect(res.status).toBe(200);
      expect(res.body.data.displayName).toBe('Renamed');
    });

    it('PATCH 拒绝 memberNo(forbidNonWhitelisted)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}`)
        .set('Authorization', superAdminAuth)
        .send({ memberNo: 'CHANGED' });
      expect(res.status).toBe(400);
    });

    it('PATCH 拒绝 status(走 /status)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}`)
        .set('Authorization', superAdminAuth)
        .send({ status: 'INACTIVE' });
      expect(res.status).toBe(400);
    });

    it('PATCH 拒绝敏感字段示例(idCard / phone)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}`)
        .set('Authorization', superAdminAuth)
        .send({ idCard: '110101199001011234', phone: '13800000000' });
      expect(res.status).toBe(400);
    });

    it('PATCH /:id/status → 200', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/status`)
        .set('Authorization', superAdminAuth)
        .send({ status: MemberStatus.INACTIVE });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(MemberStatus.INACTIVE);
    });
  });

  // ============ DELETE 引用约束 ============

  describe('DELETE 引用约束', () => {
    it('有 v1 user 绑定 → MEMBER_HAS_LINKED_USER', async () => {
      // 创建新 member + 创建 user 并绑定
      const member = await prisma.member.create({
        data: { memberNo: 'demo-linked', displayName: 'Linked' },
      });
      await createTestUser(app, {
        username: 'linkeduser',
        role: Role.USER,
      });
      await prisma.user.update({
        where: { username: 'linkeduser' },
        data: { memberId: member.id },
      });

      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/members/${member.id}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.MEMBER_HAS_LINKED_USER);
    });

    it('有 active 部门归属 → MEMBER_HAS_ACTIVE_DEPARTMENT', async () => {
      // 创建 member + organization + member_department
      const member = await prisma.member.create({
        data: { memberNo: 'demo-deptm', displayName: 'D' },
      });
      const org = await prisma.organization.create({
        data: { name: 'demo-dept-org', nodeTypeCode: 'demo-wrong-grade' },
      });
      await prisma.memberOrganizationMembership.create({
        data: { memberId: member.id, organizationId: org.id },
      });

      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/members/${member.id}`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.MEMBER_HAS_ACTIVE_DEPARTMENT);
    });

    it('无引用 → 200,软删成功(deletedAt 设值,status=INACTIVE)', async () => {
      const member = await prisma.member.create({
        data: { memberNo: 'demo-clean', displayName: 'C' },
      });
      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/members/${member.id}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      const after = await prisma.member.findUnique({ where: { id: member.id } });
      expect(after?.deletedAt).not.toBeNull();
      expect(after?.status).toBe(MemberStatus.INACTIVE);
    });
  });

  // ============ F1/A1 搜索 & 选择器(admin-api-fe-integration-roadmap.md §4 A1)============

  describe('list 增强 + GET /options', () => {
    let rootOrgId: string;
    let childOrgId: string;
    let memberInChild: string;
    let memberOutside: string;

    const createOrg = async (name: string, parentId?: string) => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/organizations')
        .set('Authorization', superAdminAuth)
        .send({ name, parentId, nodeTypeCode: 'demo-wrong-grade' });
      expect(res.status).toBe(201);
      return res.body.data.id as string;
    };

    beforeAll(async () => {
      // 自包含:清空 Organization(级联清 memberships/closure),重建根+子两级(D7 includeDescendants 用)。
      // TRUNCATE ... CASCADE 会同时清空带 organizationId 外键的整张 RoleBinding 表，
      // 包括本 spec 的 GLOBAL biz-admin 绑定；重绑后再验证列表契约。
      await prisma.$executeRawUnsafe('TRUNCATE TABLE "Organization" RESTART IDENTITY CASCADE');
      await grantBizAdminToUser(app, adminId, bizAdminRoleId);
      rootOrgId = await createOrg('F1成员搜索根');
      childOrgId = await createOrg('F1成员搜索子', rootOrgId);

      const inChild = await prisma.member.create({
        data: { memberNo: 'f1opt-in-child', displayName: 'F1唯一姓名张三XYZ' },
        select: { id: true },
      });
      memberInChild = inChild.id;
      await prisma.memberOrganizationMembership.create({
        data: { memberId: memberInChild, organizationId: childOrgId },
      });

      const outside = await prisma.member.create({
        data: { memberNo: 'f1opt-outside', displayName: 'F1不在组织内' },
        select: { id: true },
      });
      memberOutside = outside.id;
    });

    it('list q 跨字段模糊命中 displayName + memberNo', async () => {
      const byName = await request(httpServer(app))
        .get('/api/admin/v1/members')
        .query({ q: '唯一姓名张三XYZ' })
        .set('Authorization', adminAuth);
      expect((byName.body.data.items as Array<{ id: string }>).map((i) => i.id)).toEqual([
        memberInChild,
      ]);

      const byMemberNo = await request(httpServer(app))
        .get('/api/admin/v1/members')
        .query({ q: 'f1opt-in-child' })
        .set('Authorization', adminAuth);
      expect((byMemberNo.body.data.items as Array<{ id: string }>).map((i) => i.id)).toEqual([
        memberInChild,
      ]);
    });

    it('list organizationId 过滤(经 active membership 关联),includeDescendants 展开后代', async () => {
      // 不带 includeDescendants:按 rootOrgId 过滤 → 无人(memberInChild 挂在 childOrgId,非 rootOrgId 本身)
      const rootOnly = await request(httpServer(app))
        .get('/api/admin/v1/members')
        .query({ organizationId: rootOrgId })
        .set('Authorization', adminAuth);
      expect((rootOnly.body.data.items as Array<{ id: string }>).map((i) => i.id)).not.toContain(
        memberInChild,
      );

      // includeDescendants=true:rootOrgId 展开含 childOrgId → 命中 memberInChild
      const withDescendants = await request(httpServer(app))
        .get('/api/admin/v1/members')
        .query({ organizationId: rootOrgId, includeDescendants: true })
        .set('Authorization', adminAuth);
      expect((withDescendants.body.data.items as Array<{ id: string }>).map((i) => i.id)).toContain(
        memberInChild,
      );
      expect(
        (withDescendants.body.data.items as Array<{ id: string }>).map((i) => i.id),
      ).not.toContain(memberOutside);

      // 直接按 childOrgId 过滤(无需 includeDescendants)也命中
      const childDirect = await request(httpServer(app))
        .get('/api/admin/v1/members')
        .query({ organizationId: childOrgId })
        .set('Authorization', adminAuth);
      expect((childDirect.body.data.items as Array<{ id: string }>).map((i) => i.id)).toEqual([
        memberInChild,
      ]);
    });

    it('GET /options → 200,items 含 {id,label,memberNo,gradeCode},label=displayName', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/members/options')
        .query({ q: '唯一姓名张三XYZ' })
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data as object).sort()).toEqual(['items']);
      expect(res.body.data.items).toEqual([
        {
          id: memberInChild,
          label: 'F1唯一姓名张三XYZ',
          memberNo: 'f1opt-in-child',
          gradeCode: null,
        },
      ]);
    });

    it('/options 同样支持 organizationId + includeDescendants', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/members/options')
        .query({ organizationId: rootOrgId, includeDescendants: true })
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      const ids = (res.body.data.items as Array<{ id: string }>).map((i) => i.id);
      expect(ids).toContain(memberInChild);
      expect(ids).not.toContain(memberOutside);
    });

    it('USER 调用 /options → RBAC_FORBIDDEN(复用 member.read.record,D2 不新增码)', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/members/options')
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });
});
