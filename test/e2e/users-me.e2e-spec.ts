import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 14.5 users-me spec(17 用例,跨 4 块)。
// 重点:
// - GET /me 用字段集严格 array 断言,反向保护未来 service 偷加 passwordHash / deletedAt
// - PATCH /me 白名单 9 字段三件断言:HTTP 400 + BizCode.BAD_REQUEST + message 含字段名
// - PATCH /me 成功路径同时验证响应 + db 状态
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

// CLAUDE.md §11 明确禁止 PATCH /me 接受这些字段。样本值给"合理类型",
// 证明拒是因 forbidNonWhitelisted 而非类型校验。
const FORBIDDEN_FIELDS: Array<[string, unknown]> = [
  ['username', 'newname'],
  ['email', 'foo@example.com'],
  ['role', 'USER'],
  ['password', 'Passw0rd1!'],
  ['passwordHash', '$2a$10$abc'],
  ['status', 'ACTIVE'],
  ['deletedAt', null],
  ['id', 'cl0000000000000000000000'],
  ['lastLoginAt', '2026-01-01T00:00:00Z'],
];

describe('users /me 接口', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/users/me', () => {
    it('USER 登录 → 200,字段集严格 = 10 个 UserResponseDto 字段', async () => {
      await createTestUser(app, { username: 'getmeuser1', role: Role.USER });
      const { authHeader } = await loginAs(app, 'getmeuser1');

      const res = await request(httpServer(app))
        .get('/api/users/me')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.message).toBe('ok');

      // 字段集严格 array 断言:任何字段增删错都会挂——反向保护 dto 与 service 同步
      expect(Object.keys(res.body.data as object).sort()).toEqual(EXPECTED_USER_RESPONSE_KEYS);
      expect(res.body.data).not.toHaveProperty('passwordHash');
      expect(res.body.data).not.toHaveProperty('deletedAt');

      expect(res.body.data.username).toBe('getmeuser1');
      expect(res.body.data.role).toBe(Role.USER);
      expect(res.body.data.status).toBe('ACTIVE');
    });

    it('ADMIN 登录 → 200(任何登录角色都能读本人)', async () => {
      await createTestUser(app, { username: 'getmeadmin1', role: Role.ADMIN });
      const { authHeader } = await loginAs(app, 'getmeadmin1');

      const res = await request(httpServer(app))
        .get('/api/users/me')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe(Role.ADMIN);
    });

    it('SUPER_ADMIN 登录 → 200', async () => {
      await createTestUser(app, { username: 'getmesuper1', role: Role.SUPER_ADMIN });
      const { authHeader } = await loginAs(app, 'getmesuper1');

      const res = await request(httpServer(app))
        .get('/api/users/me')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe(Role.SUPER_ADMIN);
    });
  });

  describe('PATCH /api/users/me 成功路径', () => {
    it('改 nickname → 200,响应反映新值,db 同步', async () => {
      const user = await createTestUser(app, { username: 'patchnick1' });
      const { authHeader } = await loginAs(app, 'patchnick1');

      const res = await request(httpServer(app))
        .patch('/api/users/me')
        .set('Authorization', authHeader)
        .send({ nickname: 'Alice' });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.nickname).toBe('Alice');

      const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
      expect(dbUser?.nickname).toBe('Alice');
    });

    it('改 avatarKey → 200,响应反映新值,db 同步', async () => {
      const user = await createTestUser(app, { username: 'patchavatar1' });
      const { authHeader } = await loginAs(app, 'patchavatar1');

      const res = await request(httpServer(app))
        .patch('/api/users/me')
        .set('Authorization', authHeader)
        .send({ avatarKey: 'users/abc.png' });

      expect(res.status).toBe(200);
      expect(res.body.data.avatarKey).toBe('users/abc.png');

      const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
      expect(dbUser?.avatarKey).toBe('users/abc.png');
    });

    it('同时改 nickname + avatarKey → 200,响应 + db 都改', async () => {
      const user = await createTestUser(app, { username: 'patchboth1' });
      const { authHeader } = await loginAs(app, 'patchboth1');

      const res = await request(httpServer(app))
        .patch('/api/users/me')
        .set('Authorization', authHeader)
        .send({ nickname: 'Bob', avatarKey: 'users/bob.png' });

      expect(res.status).toBe(200);
      expect(res.body.data.nickname).toBe('Bob');
      expect(res.body.data.avatarKey).toBe('users/bob.png');

      const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
      expect(dbUser?.nickname).toBe('Bob');
      expect(dbUser?.avatarKey).toBe('users/bob.png');
    });
  });

  describe('PATCH /api/users/me 字段白名单(forbidNonWhitelisted)', () => {
    let authHeader: string;

    beforeAll(async () => {
      await createTestUser(app, { username: 'whitelistuser' });
      ({ authHeader } = await loginAs(app, 'whitelistuser'));
    });

    // 三件断言(用户要求):HTTP 400 + BizCode.BAD_REQUEST.code + message 含字段名
    it.each(FORBIDDEN_FIELDS)(
      'PATCH /me 传禁用字段 %s → 400 / BAD_REQUEST / message 含字段名',
      async (field, value) => {
        const res = await request(httpServer(app))
          .patch('/api/users/me')
          .set('Authorization', authHeader)
          .send({ [field]: value });

        expect(res.status).toBe(BizCode.BAD_REQUEST.httpStatus);
        expect(res.body.code).toBe(BizCode.BAD_REQUEST.code);
        expect(res.body.data).toBeNull();
        expect(res.body.message).toContain(field);
      },
    );
  });

  describe('PATCH /api/users/me 字段长度边界', () => {
    let authHeader: string;

    beforeAll(async () => {
      await createTestUser(app, { username: 'lengthuser' });
      ({ authHeader } = await loginAs(app, 'lengthuser'));
    });

    it('nickname 51 字符(超 @MaxLength(50)) → BAD_REQUEST,message 含 nickname', async () => {
      const res = await request(httpServer(app))
        .patch('/api/users/me')
        .set('Authorization', authHeader)
        .send({ nickname: 'a'.repeat(51) });

      expect(res.status).toBe(BizCode.BAD_REQUEST.httpStatus);
      expect(res.body.code).toBe(BizCode.BAD_REQUEST.code);
      expect(res.body.message).toContain('nickname');
    });

    it('avatarKey 256 字符(超 @MaxLength(255)) → BAD_REQUEST,message 含 avatarKey', async () => {
      const res = await request(httpServer(app))
        .patch('/api/users/me')
        .set('Authorization', authHeader)
        .send({ avatarKey: 'a'.repeat(256) });

      expect(res.status).toBe(BizCode.BAD_REQUEST.httpStatus);
      expect(res.body.code).toBe(BizCode.BAD_REQUEST.code);
      expect(res.body.message).toContain('avatarKey');
    });
  });
});
