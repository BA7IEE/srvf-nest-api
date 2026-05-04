import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 14.6.1 admin-list spec(10 用例)
// 覆盖:分页参数、排序(createdAt desc)、角色可见范围、软删过滤
const EXPECTED_PAGE_KEYS = ['items', 'page', 'pageSize', 'total'].sort();

describe('GET /api/users(管理列表)', () => {
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

  describe('分页参数', () => {
    it('SUPER_ADMIN 默认调用 → 200,字段集 = items/total/page=1/pageSize=20', async () => {
      await createTestUser(app, { username: 'listdefault1', role: Role.SUPER_ADMIN });
      const { authHeader } = await loginAs(app, 'listdefault1');

      const res = await request(httpServer(app)).get('/api/users').set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(Object.keys(res.body.data as object).sort()).toEqual(EXPECTED_PAGE_KEYS);
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.pageSize).toBe(20);
      expect(Array.isArray(res.body.data.items)).toBe(true);
      expect(typeof res.body.data.total).toBe('number');
    });

    it('自定义 page=2&pageSize=5 → 200,page=2 / pageSize=5', async () => {
      await createTestUser(app, { username: 'listcustom1', role: Role.SUPER_ADMIN });
      const { authHeader } = await loginAs(app, 'listcustom1');

      const res = await request(httpServer(app))
        .get('/api/users?page=2&pageSize=5')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.page).toBe(2);
      expect(res.body.data.pageSize).toBe(5);
    });

    it('pageSize=101(超 @Max(100))→ BAD_REQUEST', async () => {
      await createTestUser(app, { username: 'listmax1', role: Role.SUPER_ADMIN });
      const { authHeader } = await loginAs(app, 'listmax1');

      const res = await request(httpServer(app))
        .get('/api/users?pageSize=101')
        .set('Authorization', authHeader);

      expect(res.status).toBe(BizCode.BAD_REQUEST.httpStatus);
      expect(res.body.code).toBe(BizCode.BAD_REQUEST.code);
      expect(res.body.message).toContain('pageSize');
    });

    it('page=0(违反 @Min(1)) → BAD_REQUEST', async () => {
      await createTestUser(app, { username: 'listmin1', role: Role.SUPER_ADMIN });
      const { authHeader } = await loginAs(app, 'listmin1');

      const res = await request(httpServer(app))
        .get('/api/users?page=0')
        .set('Authorization', authHeader);

      expect(res.status).toBe(BizCode.BAD_REQUEST.httpStatus);
      expect(res.body.message).toContain('page');
    });

    it('pageSize=-1(违反 @Min(1)) → BAD_REQUEST', async () => {
      await createTestUser(app, { username: 'listneg1', role: Role.SUPER_ADMIN });
      const { authHeader } = await loginAs(app, 'listneg1');

      const res = await request(httpServer(app))
        .get('/api/users?pageSize=-1')
        .set('Authorization', authHeader);

      expect(res.status).toBe(BizCode.BAD_REQUEST.httpStatus);
      expect(res.body.message).toContain('pageSize');
    });
  });

  describe('排序(orderBy createdAt desc)', () => {
    it('3 个递增创建的用户,列表第 1 项是最晚创建的', async () => {
      await createTestUser(app, { username: 'sortop1', role: Role.SUPER_ADMIN });
      const { authHeader } = await loginAs(app, 'sortop1');

      // 顺序造 3 个 USER,每次 sleep 5ms 保证 createdAt 有可识别差异
      // (Prisma @default(now()) ms 精度,too-fast 的连续 create 可能落同一 ms)
      await createTestUser(app, { username: 'sortuser1' });
      await new Promise((r) => setTimeout(r, 5));
      await createTestUser(app, { username: 'sortuser2' });
      await new Promise((r) => setTimeout(r, 5));
      await createTestUser(app, { username: 'sortuser3' });

      const res = await request(httpServer(app))
        .get('/api/users?pageSize=10')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      // 过滤出本用例造的三个 USER,验证倒序:sortuser3 在 sortuser2 前,sortuser2 在 sortuser1 前
      const sortUsers = res.body.data.items.filter((u: { username: string }) =>
        u.username.startsWith('sortuser'),
      );
      expect(sortUsers.map((u: { username: string }) => u.username)).toEqual([
        'sortuser3',
        'sortuser2',
        'sortuser1',
      ]);
    });
  });

  describe('角色可见范围', () => {
    it('SUPER_ADMIN 看到 SUPER_ADMIN + ADMIN + USER 三种角色用户', async () => {
      await createTestUser(app, { username: 'visiblesuper1', role: Role.SUPER_ADMIN });
      await createTestUser(app, { username: 'visibleadmin1', role: Role.ADMIN });
      await createTestUser(app, { username: 'visibleuser1', role: Role.USER });

      const { authHeader } = await loginAs(app, 'visiblesuper1');
      const res = await request(httpServer(app))
        .get('/api/users?pageSize=100')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      const items: Array<{ username: string; role: Role }> = res.body.data.items;
      const visibleSet = new Set(items.map((u) => u.username));
      expect(visibleSet.has('visiblesuper1')).toBe(true);
      expect(visibleSet.has('visibleadmin1')).toBe(true);
      expect(visibleSet.has('visibleuser1')).toBe(true);
    });

    it('ADMIN 只看到 USER(SUPER_ADMIN/ADMIN 不可见)', async () => {
      await createTestUser(app, { username: 'admvisuper1', role: Role.SUPER_ADMIN });
      await createTestUser(app, { username: 'admviadmin1', role: Role.ADMIN });
      await createTestUser(app, { username: 'admviuser1', role: Role.USER });

      const { authHeader } = await loginAs(app, 'admviadmin1');
      const res = await request(httpServer(app))
        .get('/api/users?pageSize=100')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      const items: Array<{ username: string; role: Role }> = res.body.data.items;
      // service 层 where.role = USER,所有返回项必为 USER
      for (const u of items) {
        expect(u.role).toBe(Role.USER);
      }
      const visibleSet = new Set(items.map((u) => u.username));
      expect(visibleSet.has('admviuser1')).toBe(true);
      expect(visibleSet.has('admviadmin1')).toBe(false);
      expect(visibleSet.has('admvisuper1')).toBe(false);
    });

    it('USER 调用 → FORBIDDEN(40300,Guard 层拒)', async () => {
      await createTestUser(app, { username: 'plainuser1', role: Role.USER });
      const { authHeader } = await loginAs(app, 'plainuser1');

      const res = await request(httpServer(app)).get('/api/users').set('Authorization', authHeader);

      expectBizError(res, BizCode.FORBIDDEN);
    });
  });

  describe('软删过滤', () => {
    it('软删的用户不出现在列表(notDeletedWhere 生效)', async () => {
      await createTestUser(app, { username: 'softdelop1', role: Role.SUPER_ADMIN });
      const softDeletedUser = await createTestUser(app, { username: 'softdeluser1' });

      // 直接 prisma 设 deletedAt(14.6 不走 DELETE 接口完整测试)
      await prisma.user.update({
        where: { id: softDeletedUser.id },
        data: { deletedAt: new Date() },
      });

      const { authHeader } = await loginAs(app, 'softdelop1');
      const res = await request(httpServer(app))
        .get('/api/users?pageSize=100')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      const items: Array<{ username: string }> = res.body.data.items;
      expect(items.find((u) => u.username === 'softdeluser1')).toBeUndefined();
    });
  });
});
