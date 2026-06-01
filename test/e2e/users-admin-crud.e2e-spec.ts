import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { TEST_PASSWORD, createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 14.6.2 admin-crud spec(36 jest tests)
// 覆盖管理接口的基础路径:POST/GET/PATCH/PUT/DELETE 成功 + 字段校验 + 唯一约束。
// **不**覆盖:自我保护、最后 SUPER_ADMIN 保护、软删完整副作用、密码重置完整流程(留 14.7)。
//
// P0-F PR-3B(2026-05-18):users 8 个管理端点入口移除 @Roles,走 rbac.can()。
// SUPER_ADMIN 经 RbacService 短路通过(`user.role === SUPER_ADMIN`),无需 grant ops-admin。
// ADMIN 必须 grant ops-admin 才能调管理接口(D3=A 5 条 + D2=B password reset = 6 条绑定);
// `user.update.role` 不绑 ops-admin(D1=A)。
// 沿评审稿 docs/first-release-p0f-pr3-users-rbac-review.md §6.2 + §8。
const EXPECTED_USER_RESPONSE_KEYS = [
  'avatarKey',
  'createdAt',
  'email',
  'id',
  'lastLoginAt',
  'nickname',
  'role',
  'status',
  'updatedAt',
  'username',
].sort();

// PATCH /api/users/:id 禁字段(UpdateUserDto 仅允许 email/nickname/avatarKey)
// 7 字段 it.each:三件断言 HTTP 400 + BizCode.BAD_REQUEST + message 含字段名
const FORBIDDEN_PATCH_FIELDS: Array<[string, unknown]> = [
  ['username', 'newname'],
  ['role', 'USER'],
  ['password', 'Passw0rd1!'],
  ['passwordHash', '$2a$10$abc'],
  ['status', 'ACTIVE'],
  ['deletedAt', null],
  ['id', 'cl0000000000000000000000'],
];

describe('users 管理接口 CRUD 基础路径', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let opsAdminRoleId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    // P0-F PR-3B:seed RBAC permissions(55 条)+ ops-admin 角色(53 条绑定)。
    // ADMIN 用例需调 grantOpsAdminToUser(app, adminId, opsAdminRoleId) 才能进 service。
    ({ opsAdminRoleId } = await seedRbacPermissionsAndOpsAdmin(app));
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/users 创建成功', () => {
    it('SUPER_ADMIN 创建 USER → 200,UserResponseDto 字段集严格', async () => {
      await createTestUser(app, { username: 'crsuper1', role: Role.SUPER_ADMIN });
      const { authHeader } = await loginAs(app, 'crsuper1');

      const res = await request(httpServer(app))
        .post('/api/users')
        .set('Authorization', authHeader)
        .send({
          username: 'crnewuser1',
          password: TEST_PASSWORD,
          role: Role.USER,
        });

      // POST 默认 NestJS HTTP 201(Created),controller 未显式覆盖
      expect(res.status).toBe(201);
      expect(res.body.code).toBe(0);
      expect(Object.keys(res.body.data as object).sort()).toEqual(EXPECTED_USER_RESPONSE_KEYS);
      expect(res.body.data.username).toBe('crnewuser1');
      expect(res.body.data.role).toBe(Role.USER);
      expect(res.body.data).not.toHaveProperty('passwordHash');
      expect(res.body.data).not.toHaveProperty('deletedAt');
    });

    it('SUPER_ADMIN 创建 ADMIN → 200,role=ADMIN', async () => {
      await createTestUser(app, { username: 'crsuper2', role: Role.SUPER_ADMIN });
      const { authHeader } = await loginAs(app, 'crsuper2');

      const res = await request(httpServer(app))
        .post('/api/users')
        .set('Authorization', authHeader)
        .send({ username: 'crnewadm1', password: TEST_PASSWORD, role: Role.ADMIN });

      expect(res.status).toBe(201);
      expect(res.body.data.role).toBe(Role.ADMIN);
    });

    it('ADMIN 不传 role(默认 USER) → 200,role=USER', async () => {
      const admin = await createTestUser(app, { username: 'cradm1', role: Role.ADMIN });
      // P0-F PR-3B:ADMIN 需 grant ops-admin 才能进 service(否则 30100)
      await grantOpsAdminToUser(app, admin.id, opsAdminRoleId);
      const { authHeader } = await loginAs(app, 'cradm1');

      const res = await request(httpServer(app))
        .post('/api/users')
        .set('Authorization', authHeader)
        .send({ username: 'crnewuser2', password: TEST_PASSWORD });

      expect(res.status).toBe(201);
      expect(res.body.data.role).toBe(Role.USER);
    });
  });

  describe('POST /api/users role 透传安全', () => {
    it('SUPER_ADMIN 显式传 role=SUPER_ADMIN → FORBIDDEN_ROLE_OPERATION(业务 API 永禁创建 SUPER_ADMIN)', async () => {
      await createTestUser(app, { username: 'roletra1', role: Role.SUPER_ADMIN });
      const { authHeader } = await loginAs(app, 'roletra1');

      const res = await request(httpServer(app))
        .post('/api/users')
        .set('Authorization', authHeader)
        .send({
          username: 'crnewsuper1',
          password: TEST_PASSWORD,
          role: Role.SUPER_ADMIN,
        });

      expectBizError(res, BizCode.FORBIDDEN_ROLE_OPERATION);
    });

    it('ADMIN 传 role=ADMIN → FORBIDDEN_ROLE_OPERATION', async () => {
      const admin = await createTestUser(app, { username: 'roletra2', role: Role.ADMIN });
      // P0-F PR-3B:ADMIN+ops-admin 进入 service 后由 canCreateRole 拦(永禁 ADMIN 创建 ADMIN/SA)
      await grantOpsAdminToUser(app, admin.id, opsAdminRoleId);
      const { authHeader } = await loginAs(app, 'roletra2');

      const res = await request(httpServer(app))
        .post('/api/users')
        .set('Authorization', authHeader)
        .send({ username: 'crnewadm2', password: TEST_PASSWORD, role: Role.ADMIN });

      expectBizError(res, BizCode.FORBIDDEN_ROLE_OPERATION);
    });

    it('ADMIN 传 role=SUPER_ADMIN → FORBIDDEN_ROLE_OPERATION', async () => {
      const admin = await createTestUser(app, { username: 'roletra3', role: Role.ADMIN });
      await grantOpsAdminToUser(app, admin.id, opsAdminRoleId);
      const { authHeader } = await loginAs(app, 'roletra3');

      const res = await request(httpServer(app))
        .post('/api/users')
        .set('Authorization', authHeader)
        .send({
          username: 'crnewsuper2',
          password: TEST_PASSWORD,
          role: Role.SUPER_ADMIN,
        });

      expectBizError(res, BizCode.FORBIDDEN_ROLE_OPERATION);
    });
  });

  describe('POST /api/users 字段校验', () => {
    let authHeader: string;
    beforeAll(async () => {
      await createTestUser(app, { username: 'fieldsuper1', role: Role.SUPER_ADMIN });
      ({ authHeader } = await loginAs(app, 'fieldsuper1'));
    });

    it('缺 password → BAD_REQUEST,message 含 password', async () => {
      const res = await request(httpServer(app))
        .post('/api/users')
        .set('Authorization', authHeader)
        .send({ username: 'crmissp1' });

      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
      expect(res.body.message).toContain('password');
    });

    it('password 7 字符(< MinLength(8)) → BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .post('/api/users')
        .set('Authorization', authHeader)
        .send({ username: 'crshort1', password: 'Passw1!' });

      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
      expect(res.body.message).toContain('password');
    });

    it('password 纯字母无数字 → BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .post('/api/users')
        .set('Authorization', authHeader)
        .send({ username: 'crpureletter1', password: 'PasswordOnly' });

      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
      expect(res.body.message).toContain('password');
    });

    it('password 纯数字无字母 → BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .post('/api/users')
        .set('Authorization', authHeader)
        .send({ username: 'crpurenum1', password: '12345678' });

      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
      expect(res.body.message).toContain('password');
    });

    it('username 含非法字符 → BAD_REQUEST,message 含 username', async () => {
      const res = await request(httpServer(app))
        .post('/api/users')
        .set('Authorization', authHeader)
        .send({ username: 'bad!@#name', password: TEST_PASSWORD });

      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
      expect(res.body.message).toContain('username');
    });
  });

  describe('POST /api/users 唯一约束 + 归一化', () => {
    let authHeader: string;
    beforeAll(async () => {
      await createTestUser(app, { username: 'uniqsuper1', role: Role.SUPER_ADMIN });
      ({ authHeader } = await loginAs(app, 'uniqsuper1'));
    });

    it('重复 username → USERNAME_ALREADY_EXISTS(10002 / 409)', async () => {
      await createTestUser(app, { username: 'uniqdup1' });

      const res = await request(httpServer(app))
        .post('/api/users')
        .set('Authorization', authHeader)
        .send({ username: 'uniqdup1', password: TEST_PASSWORD });

      expectBizError(res, BizCode.USERNAME_ALREADY_EXISTS);
    });

    it('username 大小写归一化:已存 "uniqcase1",再传 "UniqCase1" → USERNAME_ALREADY_EXISTS', async () => {
      await createTestUser(app, { username: 'uniqcase1' });

      const res = await request(httpServer(app))
        .post('/api/users')
        .set('Authorization', authHeader)
        .send({ username: 'UniqCase1', password: TEST_PASSWORD });

      expectBizError(res, BizCode.USERNAME_ALREADY_EXISTS);
    });

    it('email 大小写归一化:已存 "a@b.com",再传 "A@B.COM" → EMAIL_ALREADY_EXISTS', async () => {
      await createTestUser(app, { username: 'uniqemail1', email: 'a@b.com' });

      const res = await request(httpServer(app))
        .post('/api/users')
        .set('Authorization', authHeader)
        .send({
          username: 'uniqemailtarget1',
          password: TEST_PASSWORD,
          email: 'A@B.COM',
        });

      expectBizError(res, BizCode.EMAIL_ALREADY_EXISTS);
    });

    it('email 空字符串 → 200,db 中 email === null(normalizeEmail 空字符串落 null)', async () => {
      const res = await request(httpServer(app))
        .post('/api/users')
        .set('Authorization', authHeader)
        .send({ username: 'uniqemailnull1', password: TEST_PASSWORD, email: '' });

      expect(res.status).toBe(201);
      const dbUser = await prisma.user.findUnique({ where: { id: res.body.data.id } });
      expect(dbUser?.email).toBeNull();
    });

    it('软删的用户 username 不复用:软删 "uniqreuse1" 后再 POST 同名 → USERNAME_ALREADY_EXISTS', async () => {
      const ghost = await createTestUser(app, { username: 'uniqreuse1' });
      await prisma.user.update({
        where: { id: ghost.id },
        data: { deletedAt: new Date() },
      });

      const res = await request(httpServer(app))
        .post('/api/users')
        .set('Authorization', authHeader)
        .send({ username: 'uniqreuse1', password: TEST_PASSWORD });

      expectBizError(res, BizCode.USERNAME_ALREADY_EXISTS);
    });
  });

  describe('GET /api/users/:id', () => {
    let authHeader: string;
    beforeAll(async () => {
      await createTestUser(app, { username: 'getidsuper1', role: Role.SUPER_ADMIN });
      ({ authHeader } = await loginAs(app, 'getidsuper1'));
    });

    it('SUPER_ADMIN GET 任意活跃用户 → 200,字段集严格', async () => {
      const target = await createTestUser(app, { username: 'getidtarget1' });

      const res = await request(httpServer(app))
        .get(`/api/users/${target.id}`)
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data as object).sort()).toEqual(EXPECTED_USER_RESPONSE_KEYS);
      expect(res.body.data.id).toBe(target.id);
    });

    it('GET 不存在 id → USER_NOT_FOUND(10001 / 404)', async () => {
      // 合法长度的 cuid 字符样本但 db 里没有此用户
      const fakeCuid = 'clxxx0000000000000000000';
      const res = await request(httpServer(app))
        .get(`/api/users/${fakeCuid}`)
        .set('Authorization', authHeader);

      expectBizError(res, BizCode.USER_NOT_FOUND);
    });

    it('GET 已软删 id → USER_NOT_FOUND(统一表现为不存在,不暴露软删存在)', async () => {
      const ghost = await createTestUser(app, { username: 'getidghost1' });
      await prisma.user.update({
        where: { id: ghost.id },
        data: { deletedAt: new Date() },
      });

      const res = await request(httpServer(app))
        .get(`/api/users/${ghost.id}`)
        .set('Authorization', authHeader);

      expectBizError(res, BizCode.USER_NOT_FOUND);
    });

    it('GET id 长度 < 8(IdParamDto @Length(8,64) 拒) → BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .get('/api/users/abc')
        .set('Authorization', authHeader);

      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
      expect(res.body.message).toContain('id');
    });
  });

  describe('PATCH /api/users/:id 改资料', () => {
    it('SUPER_ADMIN PATCH 改 nickname → 200,响应 + db 同步', async () => {
      await createTestUser(app, { username: 'patchidsuper1', role: Role.SUPER_ADMIN });
      const target = await createTestUser(app, { username: 'patchidtarget1' });
      const { authHeader } = await loginAs(app, 'patchidsuper1');

      const res = await request(httpServer(app))
        .patch(`/api/users/${target.id}`)
        .set('Authorization', authHeader)
        .send({ nickname: 'NewNickname' });

      expect(res.status).toBe(200);
      expect(res.body.data.nickname).toBe('NewNickname');

      const dbUser = await prisma.user.findUnique({ where: { id: target.id } });
      expect(dbUser?.nickname).toBe('NewNickname');
    });

    // it.each 7 个禁用字段:三件断言(HTTP 400 + BizCode + message 含字段名)
    describe('字段白名单(7 字段 it.each)', () => {
      let authHeader: string;
      let targetId: string;
      beforeAll(async () => {
        await createTestUser(app, { username: 'patchwlsuper1', role: Role.SUPER_ADMIN });
        ({ authHeader } = await loginAs(app, 'patchwlsuper1'));
        const target = await createTestUser(app, { username: 'patchwltarget1' });
        targetId = target.id;
      });

      it.each(FORBIDDEN_PATCH_FIELDS)(
        'PATCH /:id 传禁用字段 %s → 400 / BAD_REQUEST / message 含字段名',
        async (field, value) => {
          const res = await request(httpServer(app))
            .patch(`/api/users/${targetId}`)
            .set('Authorization', authHeader)
            .send({ [field]: value });

          expect(res.status).toBe(BizCode.BAD_REQUEST.httpStatus);
          expect(res.body.code).toBe(BizCode.BAD_REQUEST.code);
          expect(res.body.data).toBeNull();
          expect(res.body.message).toContain(field);
        },
      );
    });

    it('PATCH email 与已有用户冲突 → EMAIL_ALREADY_EXISTS', async () => {
      await createTestUser(app, { username: 'patchemailsuper1', role: Role.SUPER_ADMIN });
      await createTestUser(app, { username: 'patchemailowner1', email: 'taken@example.com' });
      const target = await createTestUser(app, { username: 'patchemailtarget1' });
      const { authHeader } = await loginAs(app, 'patchemailsuper1');

      const res = await request(httpServer(app))
        .patch(`/api/users/${target.id}`)
        .set('Authorization', authHeader)
        .send({ email: 'taken@example.com' });

      expectBizError(res, BizCode.EMAIL_ALREADY_EXISTS);
    });
  });

  describe('PUT/PATCH role/PATCH status/DELETE 基础调用', () => {
    it('PUT /:id/password 基础调用 → 200,db.passwordHash 改变(完整密码逻辑留 14.7)', async () => {
      await createTestUser(app, { username: 'pwsuper1', role: Role.SUPER_ADMIN });
      const target = await createTestUser(app, { username: 'pwtarget1' });
      const { authHeader } = await loginAs(app, 'pwsuper1');

      const before = await prisma.user.findUnique({ where: { id: target.id } });

      const res = await request(httpServer(app))
        .put(`/api/users/${target.id}/password`)
        .set('Authorization', authHeader)
        .send({ newPassword: 'NewPass123!' });

      expect(res.status).toBe(200);
      const after = await prisma.user.findUnique({ where: { id: target.id } });
      expect(after?.passwordHash).not.toBe(before?.passwordHash);
    });

    it('PATCH /:id/role 基础调用(SUPER_ADMIN 改 USER → ADMIN) → 200,db.role 改变', async () => {
      await createTestUser(app, { username: 'rolesuper1', role: Role.SUPER_ADMIN });
      const target = await createTestUser(app, { username: 'roletarget1', role: Role.USER });
      const { authHeader } = await loginAs(app, 'rolesuper1');

      const res = await request(httpServer(app))
        .patch(`/api/users/${target.id}/role`)
        .set('Authorization', authHeader)
        .send({ role: Role.ADMIN });

      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe(Role.ADMIN);

      const dbUser = await prisma.user.findUnique({ where: { id: target.id } });
      expect(dbUser?.role).toBe(Role.ADMIN);
    });

    it('PATCH /:id/status 基础调用(SUPER_ADMIN 改 USER → DISABLED) → 200,db.status 改变', async () => {
      await createTestUser(app, { username: 'statussuper1', role: Role.SUPER_ADMIN });
      const target = await createTestUser(app, { username: 'statustarget1' });
      const { authHeader } = await loginAs(app, 'statussuper1');

      const res = await request(httpServer(app))
        .patch(`/api/users/${target.id}/status`)
        .set('Authorization', authHeader)
        .send({ status: 'DISABLED' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('DISABLED');

      const dbUser = await prisma.user.findUnique({ where: { id: target.id } });
      expect(dbUser?.status).toBe('DISABLED');
    });

    it('DELETE /:id 基础调用(SUPER_ADMIN 软删 USER) → 200,db.deletedAt 非空 + status=DISABLED(完整软删副作用留 14.7)', async () => {
      await createTestUser(app, { username: 'delsuper1', role: Role.SUPER_ADMIN });
      const target = await createTestUser(app, { username: 'deltarget1' });
      const { authHeader } = await loginAs(app, 'delsuper1');

      const res = await request(httpServer(app))
        .delete(`/api/users/${target.id}`)
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);

      const dbUser = await prisma.user.findUnique({ where: { id: target.id } });
      expect(dbUser?.deletedAt).not.toBeNull();
      expect(dbUser?.status).toBe('DISABLED');
    });

    // P0-E PR-3:PATCH /:id/status → DISABLED 联动撤销目标 user 全部 refresh(沿评审稿 §7.3)。
    // ACTIVE → ACTIVE 不动 refresh(避免无意义清理;沿 D-PR3-2 用户拍板 §7.5)。
    // 本 PR **不**为 status 改动写 audit(沿 D-PR3-2)。
    it('PATCH /:id/status → DISABLED 后目标 user 全部 refresh 撤销 + revokedReason=admin-disable', async () => {
      await createTestUser(app, { username: 'disablesuper1', role: Role.SUPER_ADMIN });
      const target = await createTestUser(app, { username: 'disabletarget1' });
      const { authHeader } = await loginAs(app, 'disablesuper1');
      // target 自己 login 产生 refresh
      await request(httpServer(app))
        .post('/api/auth/v1/login')
        .send({ username: 'disabletarget1', password: TEST_PASSWORD });

      const before = await prisma.refreshToken.findMany({
        where: { userId: target.id, revokedAt: null },
      });
      expect(before.length).toBe(1);

      await request(httpServer(app))
        .patch(`/api/users/${target.id}/status`)
        .set('Authorization', authHeader)
        .send({ status: 'DISABLED' });

      const after = await prisma.refreshToken.findMany({ where: { userId: target.id } });
      for (const r of after) {
        expect(r.revokedAt).not.toBeNull();
        expect(r.revokedReason).toBe('admin-disable');
      }
    });
  });

  describe('PATCH /:id/role / PATCH /:id/status / PUT /:id/password DTO 校验', () => {
    let authHeader: string;
    let targetId: string;
    beforeAll(async () => {
      await createTestUser(app, { username: 'dtosuper1', role: Role.SUPER_ADMIN });
      ({ authHeader } = await loginAs(app, 'dtosuper1'));
      const target = await createTestUser(app, { username: 'dtotarget1' });
      targetId = target.id;
    });

    it('PATCH /:id/role { role: "INVALID_ROLE" } → BAD_REQUEST(@IsEnum 拒)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/users/${targetId}/role`)
        .set('Authorization', authHeader)
        .send({ role: 'INVALID_ROLE' });

      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
      expect(res.body.message).toContain('role');
    });

    it('PATCH /:id/status { status: "WEIRD" } → BAD_REQUEST(@IsEnum 拒)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/users/${targetId}/status`)
        .set('Authorization', authHeader)
        .send({ status: 'WEIRD' });

      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
      expect(res.body.message).toContain('status');
    });

    it('PUT /:id/password { newPassword: "short" } → BAD_REQUEST(MinLength(8) 拒)', async () => {
      const res = await request(httpServer(app))
        .put(`/api/users/${targetId}/password`)
        .set('Authorization', authHeader)
        .send({ newPassword: 'short' });

      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
      expect(res.body.message).toContain('newPassword');
    });
  });
});
