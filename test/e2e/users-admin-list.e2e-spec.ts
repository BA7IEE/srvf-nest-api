import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { httpServer } from '../helpers/http-server';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 14.6.1 admin-list spec(10 用例)
// 覆盖:分页参数、排序(createdAt desc)、角色可见范围、软删过滤
//
// P0-F PR-3B(2026-05-18):GET /api/admin/v1/users 走 rbac.can('user.read.account')。
// ADMIN 必须 grant ops-admin 才能进 service;USER → 30100 RBAC_FORBIDDEN(沿评审稿 §9)。
// service 内 canViewUser 仍生效(ADMIN 列表只见 USER 角色,不因 RBAC 通过而扩大范围)。
const EXPECTED_PAGE_KEYS = ['items', 'page', 'pageSize', 'total'].sort();

describe('GET /api/admin/v1/users(管理列表)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let opsAdminRoleId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    ({ opsAdminRoleId } = await seedRbacPermissionsAndOpsAdmin(app));
  });

  afterAll(async () => {
    await app.close();
  });

  describe('分页参数', () => {
    it('SUPER_ADMIN 默认调用 → 200,字段集 = items/total/page=1/pageSize=20', async () => {
      await createTestUser(app, { username: 'listdefault1', role: Role.SUPER_ADMIN });
      const { authHeader } = await loginAs(app, 'listdefault1');

      const res = await request(httpServer(app))
        .get('/api/admin/v1/users')
        .set('Authorization', authHeader);

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
        .get('/api/admin/v1/users?page=2&pageSize=5')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.page).toBe(2);
      expect(res.body.data.pageSize).toBe(5);
    });

    it('pageSize=101(超 @Max(100))→ BAD_REQUEST', async () => {
      await createTestUser(app, { username: 'listmax1', role: Role.SUPER_ADMIN });
      const { authHeader } = await loginAs(app, 'listmax1');

      const res = await request(httpServer(app))
        .get('/api/admin/v1/users?pageSize=101')
        .set('Authorization', authHeader);

      expect(res.status).toBe(BizCode.BAD_REQUEST.httpStatus);
      expect(res.body.code).toBe(BizCode.BAD_REQUEST.code);
      expect(res.body.message).toContain('pageSize');
    });

    it('page=0(违反 @Min(1)) → BAD_REQUEST', async () => {
      await createTestUser(app, { username: 'listmin1', role: Role.SUPER_ADMIN });
      const { authHeader } = await loginAs(app, 'listmin1');

      const res = await request(httpServer(app))
        .get('/api/admin/v1/users?page=0')
        .set('Authorization', authHeader);

      expect(res.status).toBe(BizCode.BAD_REQUEST.httpStatus);
      expect(res.body.message).toContain('page');
    });

    it('pageSize=-1(违反 @Min(1)) → BAD_REQUEST', async () => {
      await createTestUser(app, { username: 'listneg1', role: Role.SUPER_ADMIN });
      const { authHeader } = await loginAs(app, 'listneg1');

      const res = await request(httpServer(app))
        .get('/api/admin/v1/users?pageSize=-1')
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
        .get('/api/admin/v1/users?pageSize=10')
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
        .get('/api/admin/v1/users?pageSize=100')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      const items: Array<{ username: string; role: Role }> = res.body.data.items;
      const visibleSet = new Set(items.map((u) => u.username));
      expect(visibleSet.has('visiblesuper1')).toBe(true);
      expect(visibleSet.has('visibleadmin1')).toBe(true);
      expect(visibleSet.has('visibleuser1')).toBe(true);
    });

    it('ADMIN+ops-admin 只看到 USER(SUPER_ADMIN/ADMIN 不可见;canViewUser 收窄,不因 RBAC 通过扩大范围)', async () => {
      await createTestUser(app, { username: 'admvisuper1', role: Role.SUPER_ADMIN });
      const admin = await createTestUser(app, { username: 'admviadmin1', role: Role.ADMIN });
      await createTestUser(app, { username: 'admviuser1', role: Role.USER });
      // P0-F PR-3B:ADMIN 需 grant ops-admin 才能调 GET /api/admin/v1/users(走 rbac.can)
      await grantOpsAdminToUser(app, admin.id, opsAdminRoleId);

      const { authHeader } = await loginAs(app, 'admviadmin1');
      const res = await request(httpServer(app))
        .get('/api/admin/v1/users?pageSize=100')
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

    it('USER 调用 → RBAC_FORBIDDEN(30100;P0-F PR-3B 入口走 rbac.can,USER 无 user.read.account)', async () => {
      await createTestUser(app, { username: 'plainuser1', role: Role.USER });
      const { authHeader } = await loginAs(app, 'plainuser1');

      const res = await request(httpServer(app))
        .get('/api/admin/v1/users')
        .set('Authorization', authHeader);

      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('ADMIN 默认(未 grant ops-admin)调用 → RBAC_FORBIDDEN(30100;P0-F PR-3B 入口判权)', async () => {
      await createTestUser(app, { username: 'admindefaultlist1', role: Role.ADMIN });
      const { authHeader } = await loginAs(app, 'admindefaultlist1');

      const res = await request(httpServer(app))
        .get('/api/admin/v1/users')
        .set('Authorization', authHeader);

      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  describe('F1/A2 list 增强(q/role/status/memberId)+ GET /options', () => {
    let opsCallerAuth: string;
    let markedUserId: string;

    beforeAll(async () => {
      const opsCaller = await createTestUser(app, { username: 'f1useropslist', role: Role.ADMIN });
      await grantOpsAdminToUser(app, opsCaller.id, opsAdminRoleId);
      opsCallerAuth = (await loginAs(app, 'f1useropslist')).authHeader;

      const marked = await createTestUser(app, {
        username: 'f1uniquenamexyz',
        role: Role.USER,
        nickname: 'F1唯一昵称ABC',
      });
      markedUserId = marked.id;
    });

    it('q 跨字段模糊命中 username + nickname', async () => {
      const byUsername = await request(httpServer(app))
        .get('/api/admin/v1/users')
        .query({ q: 'f1uniquenamexyz' })
        .set('Authorization', opsCallerAuth);
      expect(byUsername.status).toBe(200);
      expect((byUsername.body.data.items as Array<{ id: string }>).map((i) => i.id)).toEqual([
        markedUserId,
      ]);

      const byNickname = await request(httpServer(app))
        .get('/api/admin/v1/users')
        .query({ q: '唯一昵称ABC' })
        .set('Authorization', opsCallerAuth);
      expect((byNickname.body.data.items as Array<{ id: string }>).map((i) => i.id)).toEqual([
        markedUserId,
      ]);
    });

    it('status 过滤生效', async () => {
      await request(httpServer(app))
        .patch(`/api/admin/v1/users/${markedUserId}/status`)
        .set('Authorization', opsCallerAuth)
        .send({ status: 'DISABLED' });

      const res = await request(httpServer(app))
        .get('/api/admin/v1/users')
        .query({ status: 'DISABLED' })
        .set('Authorization', opsCallerAuth);
      expect(res.status).toBe(200);
      const ids = (res.body.data.items as Array<{ id: string }>).map((i) => i.id);
      expect(ids).toContain(markedUserId);
      for (const item of res.body.data.items as Array<{ status: string }>) {
        expect(item.status).toBe('DISABLED');
      }
    });

    it('role 过滤与 canViewUser 可见性求交:ADMIN+ops-admin 传 role=SUPER_ADMIN → 空结果非报错', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/users')
        .query({ role: 'SUPER_ADMIN' })
        .set('Authorization', opsCallerAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
    });

    it('memberId 过滤生效', async () => {
      const member = await prisma.member.create({
        data: { memberNo: 'f1useropt-mem-1', displayName: 'F1用户选择器队员' },
      });
      const linked = await createTestUser(app, { username: 'f1memberlinked', role: Role.USER });
      await prisma.user.update({ where: { id: linked.id }, data: { memberId: member.id } });

      const res = await request(httpServer(app))
        .get('/api/admin/v1/users')
        .query({ memberId: member.id })
        .set('Authorization', opsCallerAuth);
      expect(res.status).toBe(200);
      expect((res.body.data.items as Array<{ id: string }>).map((i) => i.id)).toEqual([linked.id]);

      // 队员账号闭环 v1(2026-07-07):list 出参 additive 暴露 memberId + member 摘要
      const item = (
        res.body.data.items as Array<{
          id: string;
          memberId: string | null;
          member: { memberNo: string; displayName: string } | null;
        }>
      )[0];
      expect(item.memberId).toBe(member.id);
      expect(item.member).toEqual({ memberNo: member.memberNo, displayName: member.displayName });
    });

    it('list 未绑定队员的用户 → memberId/member 为 null(而非缺省 key)', async () => {
      await createTestUser(app, { username: 'f1nomember1', role: Role.USER });
      const res = await request(httpServer(app))
        .get('/api/admin/v1/users')
        .query({ q: 'f1nomember1' })
        .set('Authorization', opsCallerAuth);
      expect(res.status).toBe(200);
      const item = (res.body.data.items as Array<{ memberId: unknown; member: unknown }>)[0];
      expect(item.memberId).toBeNull();
      expect(item.member).toBeNull();
    });

    it('GET /options → 200,items 含 {id,label,username},label=nickname||username', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/users/options')
        .query({ q: 'f1uniquenamexyz' })
        .set('Authorization', opsCallerAuth);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data as object).sort()).toEqual(['items']);
      expect(res.body.data.items).toEqual([
        { id: markedUserId, label: 'F1唯一昵称ABC', username: 'f1uniquenamexyz' },
      ]);
    });

    it('/options 的 canViewUser 可见性裁剪保留:ADMIN+ops-admin 看不到 SUPER_ADMIN/ADMIN 账号', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/users/options')
        .query({ q: 'f1useropslist' })
        .set('Authorization', opsCallerAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
    });

    it('USER 调用 /options → RBAC_FORBIDDEN(复用 user.read.account,D2 不新增码)', async () => {
      await createTestUser(app, { username: 'f1useroptplain', role: Role.USER });
      const { authHeader } = await loginAs(app, 'f1useroptplain');
      const res = await request(httpServer(app))
        .get('/api/admin/v1/users/options')
        .set('Authorization', authHeader);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
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
        .get('/api/admin/v1/users?pageSize=100')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      const items: Array<{ username: string }> = res.body.data.items;
      expect(items.find((u) => u.username === 'softdeluser1')).toBeUndefined();
    });
  });
});
