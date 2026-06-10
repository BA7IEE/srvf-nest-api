import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
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

// Slow-4 T2(2026-06-11):members 模块 RBAC 权限边界 spec。
// 沿冻结评审稿 slow4-rbac-business-face-review.md §7 零行为漂移五类验收:
//   ① SUPER_ADMIN 全端点照常(judge() 短路)
//   ② 持 biz-admin 的 ADMIN 与迁移前行为一致(@Roles(SA,ADMIN) 放行语义)
//   ③ 未持 biz-admin 的 ADMIN → 30100(Slow-3 决议本体:身份与业务权限解耦)
//   ④ 裸 USER → 30100(迁移前 RolesGuard 40300,拒绝语义沿 RBAC 拒权码)
//   ⑤ DELETE:`member.delete.record` 不绑 biz-admin → ADMIN(即使持 biz-admin)仍拒,
//      仅 SUPER_ADMIN 短路通过(D1=A 镜像;allow/deny 矩阵与迁移前字节级等价)
// 业务行为细节(唯一性 / 字典 / 引用拒删)由 members.e2e-spec.ts 锁定,本 spec 只锁判权矩阵。

describe('members RBAC 权限边界(Slow-4 T2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let saAuth: string;
  let admBizAuth: string; // ADMIN + biz-admin
  let admDefaultAuth: string; // ADMIN 无 biz-admin
  let userAuth: string;

  let memberId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'mrb-su', role: Role.SUPER_ADMIN });
    const admBiz = await createTestUser(app, { username: 'mrb-adm-biz', role: Role.ADMIN });
    await createTestUser(app, { username: 'mrb-adm-default', role: Role.ADMIN });
    await createTestUser(app, { username: 'mrb-user', role: Role.USER });
    saAuth = (await loginAs(app, 'mrb-su')).authHeader;
    admBizAuth = (await loginAs(app, 'mrb-adm-biz')).authHeader;
    admDefaultAuth = (await loginAs(app, 'mrb-adm-default')).authHeader;
    userAuth = (await loginAs(app, 'mrb-user')).authHeader;

    const bizSeed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, admBiz.id, bizSeed.bizAdminRoleId);

    const m = await prisma.member.create({
      data: { memberNo: 'mrb-m-base', displayName: 'Boundary Base' },
      select: { id: true },
    });
    memberId = m.id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/admin/v1/members(member.read.record)', () => {
    it('① SUPER_ADMIN → 200', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/members')
        .set('Authorization', saAuth);
      expect(res.status).toBe(200);
    });
    it('② ADMIN+biz-admin → 200', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/members')
        .set('Authorization', admBizAuth);
      expect(res.status).toBe(200);
    });
    it('③ ADMIN 无 biz-admin → 30100', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/members')
        .set('Authorization', admDefaultAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
    it('④ USER → 30100', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/members')
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  describe('POST /api/admin/v1/members(member.create.record)', () => {
    it('① SUPER_ADMIN → 201', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/members')
        .set('Authorization', saAuth)
        .send({ memberNo: 'mrb-m-sa', displayName: 'SA Created' });
      expect(res.status).toBe(201);
    });
    it('② ADMIN+biz-admin → 201', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/members')
        .set('Authorization', admBizAuth)
        .send({ memberNo: 'mrb-m-biz', displayName: 'Biz Created' });
      expect(res.status).toBe(201);
    });
    it('③ ADMIN 无 biz-admin → 30100(合法 body,拒于判权而非校验)', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/members')
        .set('Authorization', admDefaultAuth)
        .send({ memberNo: 'mrb-m-x1', displayName: 'X' });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
    it('④ USER → 30100', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/members')
        .set('Authorization', userAuth)
        .send({ memberNo: 'mrb-m-x2', displayName: 'X' });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  describe('GET /api/admin/v1/members/:id(member.read.record)', () => {
    it('①② 通过 / ③④ 30100', async () => {
      const ok1 = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberId}`)
        .set('Authorization', saAuth);
      expect(ok1.status).toBe(200);
      const ok2 = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberId}`)
        .set('Authorization', admBizAuth);
      expect(ok2.status).toBe(200);
      const deny1 = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberId}`)
        .set('Authorization', admDefaultAuth);
      expectBizError(deny1, BizCode.RBAC_FORBIDDEN);
      const deny2 = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberId}`)
        .set('Authorization', userAuth);
      expectBizError(deny2, BizCode.RBAC_FORBIDDEN);
    });

    it('③ 判权先于资源探测:ADMIN 无 biz-admin 查不存在 id → 30100(非 404)', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/members/cl0000000000000000000000')
        .set('Authorization', admDefaultAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  describe('PATCH /api/admin/v1/members/:id(member.update.record)', () => {
    it('①② 通过 / ③④ 30100', async () => {
      const ok1 = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}`)
        .set('Authorization', saAuth)
        .send({ displayName: 'Renamed SA' });
      expect(ok1.status).toBe(200);
      const ok2 = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}`)
        .set('Authorization', admBizAuth)
        .send({ displayName: 'Renamed Biz' });
      expect(ok2.status).toBe(200);
      const deny1 = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}`)
        .set('Authorization', admDefaultAuth)
        .send({ displayName: 'X' });
      expectBizError(deny1, BizCode.RBAC_FORBIDDEN);
      const deny2 = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}`)
        .set('Authorization', userAuth)
        .send({ displayName: 'X' });
      expectBizError(deny2, BizCode.RBAC_FORBIDDEN);
    });
  });

  describe('PATCH /api/admin/v1/members/:id/status(member.update.status)', () => {
    it('①② 通过 / ③④ 30100', async () => {
      const ok1 = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/status`)
        .set('Authorization', saAuth)
        .send({ status: 'INACTIVE' });
      expect(ok1.status).toBe(200);
      const ok2 = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/status`)
        .set('Authorization', admBizAuth)
        .send({ status: 'ACTIVE' });
      expect(ok2.status).toBe(200);
      const deny1 = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/status`)
        .set('Authorization', admDefaultAuth)
        .send({ status: 'INACTIVE' });
      expectBizError(deny1, BizCode.RBAC_FORBIDDEN);
      const deny2 = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/status`)
        .set('Authorization', userAuth)
        .send({ status: 'INACTIVE' });
      expectBizError(deny2, BizCode.RBAC_FORBIDDEN);
    });
  });

  describe('DELETE /api/admin/v1/members/:id(member.delete.record;DoD-4 ⑤ 码不绑 biz-admin)', () => {
    it('⑤ ADMIN+biz-admin → 30100(持 biz-admin 也不放行;D1=A 镜像)', async () => {
      const m = await prisma.member.create({
        data: { memberNo: 'mrb-m-del-1', displayName: 'Del 1' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/members/${m.id}`)
        .set('Authorization', admBizAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
    it('③ ADMIN 无 biz-admin → 30100', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/members/${memberId}`)
        .set('Authorization', admDefaultAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
    it('④ USER → 30100', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/members/${memberId}`)
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
    it('① SUPER_ADMIN → 200(仍通,与迁移前一致)', async () => {
      const m = await prisma.member.create({
        data: { memberNo: 'mrb-m-del-2', displayName: 'Del 2' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/members/${m.id}`)
        .set('Authorization', saAuth);
      expect(res.status).toBe(200);
    });
  });
});
