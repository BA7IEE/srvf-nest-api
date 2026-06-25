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

// 统一通知模块 S1 站内信渠道(第 28 模块 notifications 扩 controller)admin e2e
// (冻结评审稿 unified-notification-dispatcher-review.md §5 / member-notification-review.md §6 + §2⑩ audit)。
//
// 覆盖:RBAC 边界(无 biz-admin → 30100 / 无 auth → 401)+ CRUD + 状态机各分支(含非法跃迁 31030)
// + 类型校验(31010)+ department 可见档需活跃 org(31012)+ readCount 回显 + 统一形状列(broadcast/admin/in-app)
// + audit(create / publish 伞事件 extra.operation)。
//
// reset-db 已清 notifications / DictItem / DictType / RBAC 4 表;biz-admin fixture 不含 notification.* 5 码,
// 故 beforeAll 自行 seed(notification_type 字典 + 5 权限码绑 biz-admin)。

const ADMIN_NOTIFICATIONS = '/api/admin/v1/notifications';

const NOTIFICATION_PERMISSION_CODES = [
  {
    code: 'notification.read.record',
    module: 'notification',
    action: 'read',
    resourceType: 'record',
  },
  {
    code: 'notification.create.record',
    module: 'notification',
    action: 'create',
    resourceType: 'record',
  },
  {
    code: 'notification.update.record',
    module: 'notification',
    action: 'update',
    resourceType: 'record',
  },
  {
    code: 'notification.delete.record',
    module: 'notification',
    action: 'delete',
    resourceType: 'record',
  },
  {
    code: 'notification.publish.record',
    module: 'notification',
    action: 'publish',
    resourceType: 'record',
  },
] as const;

describe('统一通知模块(第 28 模块)admin e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAuth: string; // biz-admin(承载 ADMIN 业务权限)
  let userAuth: string; // 普通 USER(RBAC 边界)
  let orgActive: string;

  async function seedNotificationPrereqs(): Promise<void> {
    const dictType = await prisma.dictType.create({
      data: { code: 'notification_type', label: '通知类型', status: 'ACTIVE' },
      select: { id: true },
    });
    await prisma.dictItem.createMany({
      data: [
        { typeId: dictType.id, code: 'activity-reminder', label: '活动提醒', status: 'ACTIVE' },
        { typeId: dictType.id, code: 'recruitment', label: '招新公告', status: 'ACTIVE' },
        { typeId: dictType.id, code: 'emergency', label: '紧急召集', status: 'ACTIVE' },
        { typeId: dictType.id, code: 'general', label: '一般通知', status: 'ACTIVE' },
        // INACTIVE 项:验证 service 只认 ACTIVE(31010 路径)
        { typeId: dictType.id, code: 'archived_type', label: '停用类型', status: 'INACTIVE' },
      ],
    });
    const org = await prisma.organization.create({
      data: { name: '部门-通知', nodeTypeCode: 'demo-node', status: 'ACTIVE' },
      select: { id: true },
    });
    orgActive = org.id;
  }

  async function seedNotificationPermissionsToBizAdmin(roleId: string): Promise<void> {
    for (const p of NOTIFICATION_PERMISSION_CODES) {
      await prisma.permission.upsert({
        where: { code: p.code },
        update: {},
        create: { code: p.code, module: p.module, action: p.action, resourceType: p.resourceType },
      });
    }
    const seeded = await prisma.permission.findMany({
      where: { code: { in: NOTIFICATION_PERMISSION_CODES.map((p) => p.code) } },
      select: { id: true },
    });
    await prisma.rolePermission.createMany({
      data: seeded.map((p) => ({ roleId, permissionId: p.id })),
      skipDuplicates: true,
    });
  }

  function post(auth: string, body: Record<string, unknown>, path = ''): request.Test {
    return request(httpServer(app))
      .post(`${ADMIN_NOTIFICATIONS}${path}`)
      .set('Authorization', auth)
      .send(body);
  }

  async function createDraft(over: Record<string, unknown> = {}): Promise<string> {
    const res = await post(adminAuth, {
      title: '通知标题',
      body: '通知正文',
      notificationTypeCode: 'general',
      visibilityCode: 'member',
      ...over,
    });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);

    const { bizAdminRoleId } = await seedBizAdminPermissionsAndRole(app);
    await seedNotificationPermissionsToBizAdmin(bizAdminRoleId);
    await seedNotificationPrereqs();

    const adminUser = await createTestUser(app, { username: 'notif_admin', role: Role.ADMIN });
    await grantBizAdminToUser(app, adminUser.id, bizAdminRoleId);
    adminAuth = (await loginAs(app, 'notif_admin')).authHeader;

    await createTestUser(app, { username: 'notif_user', role: Role.USER });
    userAuth = (await loginAs(app, 'notif_user')).authHeader;
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ RBAC 边界 ============
  describe('RBAC 边界', () => {
    it('无 Authorization → 401', async () => {
      const res = await request(httpServer(app)).get(ADMIN_NOTIFICATIONS);
      expectBizError(res, BizCode.UNAUTHORIZED);
    });
    it('普通 USER(无 biz-admin)create → 30100', async () => {
      const res = await post(userAuth, {
        title: 't',
        body: 'b',
        notificationTypeCode: 'general',
        visibilityCode: 'member',
      });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
    it('普通 USER list → 30100', async () => {
      const res = await request(httpServer(app))
        .get(ADMIN_NOTIFICATIONS)
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  // ============ create + 校验 ============
  describe('create + 入参校验', () => {
    it('建草稿 → draft;统一形状列默认 broadcast/admin/[in-app];readCount=0', async () => {
      const res = await post(adminAuth, {
        title: '欢迎',
        body: '欢迎加入',
        notificationTypeCode: 'general',
        visibilityCode: 'member',
      });
      expect(res.status).toBe(201);
      const d = res.body.data;
      expect(d.statusCode).toBe('draft');
      expect(d.audienceType).toBe('broadcast');
      expect(d.sourceType).toBe('admin');
      expect(d.channels).toEqual(['in-app']);
      expect(d.readCount).toBe(0);
      expect(d.publishedAt).toBeNull();
      expect(d.authorUserId).toBeTruthy();
    });

    it('无效 / INACTIVE 通知类型 → 31010', async () => {
      expectBizError(
        await post(adminAuth, {
          title: 't',
          body: 'b',
          notificationTypeCode: 'no-such-type',
          visibilityCode: 'member',
        }),
        BizCode.NOTIFICATION_TYPE_INVALID,
      );
      expectBizError(
        await post(adminAuth, {
          title: 't',
          body: 'b',
          notificationTypeCode: 'archived_type',
          visibilityCode: 'member',
        }),
        BizCode.NOTIFICATION_TYPE_INVALID,
      );
    });

    it('非法可见档(DTO @IsIn 白名单)→ 400', async () => {
      const res = await post(adminAuth, {
        title: 't',
        body: 'b',
        notificationTypeCode: 'general',
        visibilityCode: 'public', // 通知去 public;非 4 档之一
      });
      // DTO @IsIn 拒绝 → 40000,message 为自定义校验文案「可见级无效」(非通用 message),故跳过严格 message 比对。
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('department 档 + 空 orgIds → 31012;+ 活跃 org → 成功', async () => {
      expectBizError(
        await post(adminAuth, {
          title: 't',
          body: 'b',
          notificationTypeCode: 'general',
          visibilityCode: 'department',
        }),
        BizCode.NOTIFICATION_VISIBLE_ORG_INVALID,
      );
      const ok = await post(adminAuth, {
        title: '部门通知',
        body: 'b',
        notificationTypeCode: 'general',
        visibilityCode: 'department',
        visibleOrganizationIds: [orgActive],
      });
      expect(ok.status).toBe(201);
      expect(ok.body.data.visibleOrganizationIds).toEqual([orgActive]);
    });
  });

  // ============ list / detail ============
  describe('list / detail', () => {
    it('list 按 status 过滤 + readCount 回显', async () => {
      await createDraft({ title: 'L-draft' });
      const res = await request(httpServer(app))
        .get(`${ADMIN_NOTIFICATIONS}?statusCode=draft&pageSize=50`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      const items = res.body.data.items as { statusCode: string; readCount: number }[];
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i) => i.statusCode === 'draft')).toBe(true);
      expect(items.every((i) => typeof i.readCount === 'number')).toBe(true);
    });

    it('detail 不存在 → 31001', async () => {
      expectBizError(
        await request(httpServer(app))
          .get(`${ADMIN_NOTIFICATIONS}/nonexistent-id`)
          .set('Authorization', adminAuth),
        BizCode.NOTIFICATION_NOT_FOUND,
      );
    });
  });

  // ============ update ============
  describe('update', () => {
    it('draft 可改;archived 冻结 → 31030', async () => {
      const id = await createDraft({ title: 'U-1' });
      const res = await request(httpServer(app))
        .patch(`${ADMIN_NOTIFICATIONS}/${id}`)
        .set('Authorization', adminAuth)
        .send({ title: 'U-1-改' });
      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe('U-1-改');

      // 推到 archived 后冻结
      await post(adminAuth, {}, `/${id}/publish`);
      await post(adminAuth, {}, `/${id}/archive`);
      const frozen = await request(httpServer(app))
        .patch(`${ADMIN_NOTIFICATIONS}/${id}`)
        .set('Authorization', adminAuth)
        .send({ title: '改不动' });
      expectBizError(frozen, BizCode.NOTIFICATION_INVALID_STATUS_TRANSITION);
    });
  });

  // ============ 状态机 ============
  describe('状态机 publish/unpublish/archive(立即生效无 cron;非法 → 31030)', () => {
    it('publish:draft → published,置 publishedAt', async () => {
      const id = await createDraft({ title: 'SM-pub' });
      const res = await post(adminAuth, {}, `/${id}/publish`);
      expect(res.status).toBe(200);
      expect(res.body.data.statusCode).toBe('published');
      expect(res.body.data.publishedAt).toBeTruthy();
    });

    it('unpublish:published → draft,保留 publishedAt', async () => {
      const id = await createDraft({ title: 'SM-unpub' });
      await post(adminAuth, {}, `/${id}/publish`);
      const res = await post(adminAuth, {}, `/${id}/unpublish`);
      expect(res.status).toBe(200);
      expect(res.body.data.statusCode).toBe('draft');
      expect(res.body.data.publishedAt).toBeTruthy(); // 保留
    });

    it('archive:published → archived(终态)', async () => {
      const id = await createDraft({ title: 'SM-arch' });
      await post(adminAuth, {}, `/${id}/publish`);
      const res = await post(adminAuth, {}, `/${id}/archive`);
      expect(res.status).toBe(200);
      expect(res.body.data.statusCode).toBe('archived');
    });

    it('非法跃迁 → 31030:archive(draft) / publish(published) / unpublish(draft) / archive(archived)', async () => {
      const draft = await createDraft({ title: 'SM-illegal' });
      expectBizError(
        await post(adminAuth, {}, `/${draft}/archive`),
        BizCode.NOTIFICATION_INVALID_STATUS_TRANSITION,
      );
      expectBizError(
        await post(adminAuth, {}, `/${draft}/unpublish`),
        BizCode.NOTIFICATION_INVALID_STATUS_TRANSITION,
      );
      await post(adminAuth, {}, `/${draft}/publish`);
      expectBizError(
        await post(adminAuth, {}, `/${draft}/publish`),
        BizCode.NOTIFICATION_INVALID_STATUS_TRANSITION,
      );
      await post(adminAuth, {}, `/${draft}/archive`);
      expectBizError(
        await post(adminAuth, {}, `/${draft}/archive`),
        BizCode.NOTIFICATION_INVALID_STATUS_TRANSITION,
      );
    });
  });

  // ============ delete(软删)============
  describe('delete(软删,任意态)', () => {
    it('软删后 detail → 31001', async () => {
      const id = await createDraft({ title: 'DEL-1' });
      const del = await request(httpServer(app))
        .delete(`${ADMIN_NOTIFICATIONS}/${id}`)
        .set('Authorization', adminAuth);
      expect(del.status).toBe(200);
      expectBizError(
        await request(httpServer(app))
          .get(`${ADMIN_NOTIFICATIONS}/${id}`)
          .set('Authorization', adminAuth),
        BizCode.NOTIFICATION_NOT_FOUND,
      );
    });
  });

  // ============ audit ============
  describe('audit(admin 写入 audit;publish 伞事件 extra.operation)', () => {
    it('create 写 notification.create;publish/archive 写 notification.publish + extra.operation', async () => {
      const id = await createDraft({ title: 'AUD-1' });
      await post(adminAuth, {}, `/${id}/publish`);
      await post(adminAuth, {}, `/${id}/archive`);

      const created = await prisma.auditLog.findFirst({
        where: { event: 'notification.create', resourceId: id },
      });
      expect(created).not.toBeNull();

      const publishEvents = await prisma.auditLog.findMany({
        where: { event: 'notification.publish', resourceId: id },
        select: { context: true },
      });
      const operations = publishEvents.map(
        (e) => (e.context as { extra?: { operation?: string } } | null)?.extra?.operation,
      );
      expect(operations).toContain('publish');
      expect(operations).toContain('archive');
    });
  });
});
