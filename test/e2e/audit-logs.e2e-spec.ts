import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { truncateAuditLogsTestOnly } from '../helpers/audit-logs-cleanup';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2 第一阶段批次 6 audit_logs PR #1 e2e。
// 覆盖 D6 v1.1 §12 矩阵中 PR #1 范围内的项(8 处迁移 hook / 同事务回滚 / 打码生效 /
// 未迁移不入库等留 PR #2 实装)。
//
// PR #1 没业务 service 调用方,所以本 spec 通过 app.get(AuditLogsService).log()
// 直接写入预设数据,验证查询接口、权限、AuditContext 锁形、不可改不可删、不审计自身。

describe('audit-logs 模块(PR #1 + P0-F PR-4B RBAC)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auditLogs: AuditLogsService;
  let superAdminAuth: string;
  let admin1Auth: string;
  let admin2Auth: string;
  let adminNoOpsAuth: string;
  let userAuth: string;

  let superAdminId: string;
  let admin1Id: string;
  let admin2Id: string;
  let userId: string;

  const META = {
    requestId: 'c1xqgkb0000001abcdef234567',
    ip: '127.0.0.1',
    ua: 'jest/30.x',
  };

  // 测试数据集 — beforeAll 落地后被多个测试块共享读取
  let logBySuper: string; // SUPER_ADMIN 操作的记录
  let logByAdmin1: string; // ADMIN1(自己)操作的记录
  let logByAdmin2: string; // ADMIN2(他人 admin)操作的记录
  let logByUser: string; // USER 操作的记录
  let logWithFullContext: string; // 带 before + after + extra 的记录

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    auditLogs = app.get(AuditLogsService);

    const su = await createTestUser(app, { username: 'al-su', role: Role.SUPER_ADMIN });
    const a1 = await createTestUser(app, { username: 'al-adm1', role: Role.ADMIN });
    const a2 = await createTestUser(app, { username: 'al-adm2', role: Role.ADMIN });
    // P0-F PR-4B:专用 ADMIN 用户,**不**绑 ops-admin,用于验证默认 ADMIN → 30100
    await createTestUser(app, { username: 'al-adm-no-ops', role: Role.ADMIN });
    const u = await createTestUser(app, { username: 'al-user', role: Role.USER });
    superAdminId = su.id;
    admin1Id = a1.id;
    admin2Id = a2.id;
    userId = u.id;
    superAdminAuth = (await loginAs(app, 'al-su')).authHeader;
    admin1Auth = (await loginAs(app, 'al-adm1')).authHeader;
    admin2Auth = (await loginAs(app, 'al-adm2')).authHeader;
    adminNoOpsAuth = (await loginAs(app, 'al-adm-no-ops')).authHeader;
    userAuth = (await loginAs(app, 'al-user')).authHeader;

    // P0-F PR-4B(2026-05-18):seed RBAC 56 条 permission + ops-admin 角色 + 54 条 RolePermission
    // (audit-log.read.entry 整条加入 ops-admin;沿评审稿 §4.2 / §6.2 / D2=B)。
    // 给 admin1 / admin2 grant ops-admin(用于 list where 注入 / detail 权限段保留行为);
    // **不** grant 给 adminNoOps(用于验证默认 ADMIN → 30100)。
    const { opsAdminRoleId } = await seedRbacPermissionsAndOpsAdmin(app);
    await grantOpsAdminToUser(app, admin1Id, opsAdminRoleId);
    await grantOpsAdminToUser(app, admin2Id, opsAdminRoleId);

    // P0-E PR-3:loginAs 现在写 'auth.login' audit(沿 P0-E 评审稿 §5.9 / D-8);
    // 本 spec 通过 AuditLogsService.log() 直接预设 5 条 audit 验证分页 / 过滤 /
    // 排序契约;loginAs 引入的 5 条 audit 污染 total/items,需 TRUNCATE 清理。
    // truncate 不破坏审计写入即不可改的红线(沿 audit-logs-cleanup.ts test-only 豁免)。
    await truncateAuditLogsTestOnly(app);

    // 通过 AuditLogsService.log() 写入 5 条预设审计记录
    await auditLogs.log({
      event: 'emergency-contact.write',
      actorUserId: superAdminId,
      actorRoleSnap: Role.SUPER_ADMIN,
      resourceType: 'emergency_contact',
      resourceId: 'ec-by-super',
      meta: META,
      extra: { operation: 'create' },
    });
    await auditLogs.log({
      event: 'emergency-contact.write',
      actorUserId: admin1Id,
      actorRoleSnap: Role.ADMIN,
      resourceType: 'emergency_contact',
      resourceId: 'ec-by-admin1',
      meta: META,
      extra: { operation: 'update' },
    });
    await auditLogs.log({
      event: 'certificate.create',
      actorUserId: admin2Id,
      actorRoleSnap: Role.ADMIN,
      resourceType: 'certificate',
      resourceId: 'cert-by-admin2',
      meta: META,
    });
    await auditLogs.log({
      event: 'certificate.update',
      actorUserId: userId,
      actorRoleSnap: Role.USER,
      resourceType: 'certificate',
      resourceId: 'cert-by-user',
      meta: META,
      before: { certStatusCode: 'pending' },
      after: { certStatusCode: 'verified' },
    });
    await auditLogs.log({
      event: 'certificate.verify',
      actorUserId: admin1Id,
      actorRoleSnap: Role.ADMIN,
      resourceType: 'certificate',
      resourceId: 'cert-full-ctx',
      meta: { requestId: META.requestId, ip: null, ua: null },
      before: { certStatusCode: 'pending', verifyNote: null },
      after: { certStatusCode: 'verified', verifyNote: '材料齐全' },
      extra: { verifierMemberId: 'mem-x' },
    });

    // 把 5 条记录的 id 抓出来,用于后续 detail 测试
    const rows = await prisma.auditLog.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, resourceId: true, actorUserId: true, actorRoleSnap: true },
    });
    logBySuper = rows.find((r) => r.resourceId === 'ec-by-super')!.id;
    logByAdmin1 = rows.find((r) => r.resourceId === 'ec-by-admin1')!.id;
    logByAdmin2 = rows.find((r) => r.resourceId === 'cert-by-admin2')!.id;
    logByUser = rows.find((r) => r.resourceId === 'cert-by-user')!.id;
    logWithFullContext = rows.find((r) => r.resourceId === 'cert-full-ctx')!.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ 权限边界 ============

  describe('权限边界(P0-F PR-4B RBAC)', () => {
    it('未登录 GET list → 401', async () => {
      const res = await request(httpServer(app)).get('/api/system/v1/audit-logs');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('未登录 GET detail → 401', async () => {
      const res = await request(httpServer(app)).get(`/api/system/v1/audit-logs/${logBySuper}`);
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER GET list → 30100 RBAC_FORBIDDEN(沿 P0-F PR-4B,USER 未持 audit-log.read.entry)', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/audit-logs')
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER GET detail → 30100 RBAC_FORBIDDEN(沿 P0-F PR-4B,USER 未持 audit-log.read.entry)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/system/v1/audit-logs/${logBySuper}`)
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('ADMIN 默认(未持 ops-admin)GET list → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/audit-logs')
        .set('Authorization', adminNoOpsAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('ADMIN 默认(未持 ops-admin)GET detail → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get(`/api/system/v1/audit-logs/${logBySuper}`)
        .set('Authorization', adminNoOpsAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  // ============ ADMIN+ops-admin 数据范围保留(P0-F PR-4B 关键反向验证) ============
  // 验证 RBAC 入口通过后,service 层数据范围仍生效(沿评审稿 §9.2)。
  // ADMIN+ops-admin 仍只能看自己 OR USER 操作的记录;越级查 SA / 其它 ADMIN → 14101。

  describe('ADMIN+ops-admin 数据范围保留(P0-F PR-4B)', () => {
    it('ADMIN+ops-admin GET list → 200,数据范围仍受 list ADMIN where 注入限制(自己 + USER 操作 = 3 条)', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/audit-logs')
        .set('Authorization', admin1Auth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      // ADMIN1 看到自己 2 条 + USER 1 条 = 3 条(沿 list where 注入段同款断言;数据范围不因 RBAC 通过而扩大)
      expect(res.body.data.total).toBe(3);
    });

    it('ADMIN+ops-admin GET findOne 自己操作的 → 200', async () => {
      const res = await request(httpServer(app))
        .get(`/api/system/v1/audit-logs/${logByAdmin1}`)
        .set('Authorization', admin1Auth);
      expect(res.status).toBe(200);
      expect(res.body.data.actorUserId).toBe(admin1Id);
    });

    it('ADMIN+ops-admin GET findOne USER 操作的 → 200', async () => {
      const res = await request(httpServer(app))
        .get(`/api/system/v1/audit-logs/${logByUser}`)
        .set('Authorization', admin1Auth);
      expect(res.status).toBe(200);
      expect(res.body.data.actorRoleSnap).toBe(Role.USER);
    });

    it('ADMIN+ops-admin GET findOne SA 操作的 → 14101(护栏保留,RBAC 通过 ≠ 数据范围放开)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/system/v1/audit-logs/${logBySuper}`)
        .set('Authorization', admin1Auth);
      expectBizError(res, BizCode.FORBIDDEN_AUDIT_LOG_READ);
    });

    it('ADMIN+ops-admin GET findOne 其它 ADMIN 操作的 → 14101(护栏保留)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/system/v1/audit-logs/${logByAdmin2}`)
        .set('Authorization', admin1Auth);
      expectBizError(res, BizCode.FORBIDDEN_AUDIT_LOG_READ);
    });
  });

  // ============ list where 注入(权限关键) ============

  describe('list where 注入', () => {
    it('SUPER_ADMIN 可看全部 5 条', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/audit-logs')
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.total).toBe(5);
      expect(res.body.data.items).toHaveLength(5);
    });

    it('ADMIN 仅看自己 OR USER 操作的记录:3 条(自己 × 2 + USER × 1)', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/audit-logs')
        .set('Authorization', admin1Auth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(3);
      const ids: string[] = res.body.data.items.map((i: { id: string }) => i.id);
      expect(ids.sort()).toEqual([logByAdmin1, logByUser, logWithFullContext].sort());
    });

    it('ADMIN 查另一个 ADMIN 操作的记录(actorUserId=other-admin)→ 0 条', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/audit-logs')
        .query({ actorUserId: admin2Id })
        .set('Authorization', admin1Auth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(0);
    });

    it('ADMIN2 视角:看到自己 1 条 + USER 操作 1 条,不见 ADMIN1 的 2 条', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/audit-logs')
        .set('Authorization', admin2Auth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(2);
      const ids: string[] = res.body.data.items.map((i: { id: string }) => i.id);
      expect(ids.sort()).toEqual([logByAdmin2, logByUser].sort());
    });
  });

  // ============ detail 权限矩阵 ============

  describe('detail 权限', () => {
    it('SUPER_ADMIN 看 SUPER_ADMIN 操作的记录 → 200', async () => {
      const res = await request(httpServer(app))
        .get(`/api/system/v1/audit-logs/${logBySuper}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(logBySuper);
      expect(res.body.data.actorRoleSnap).toBe(Role.SUPER_ADMIN);
    });

    it('SUPER_ADMIN 看 USER 操作的记录 → 200', async () => {
      const res = await request(httpServer(app))
        .get(`/api/system/v1/audit-logs/${logByUser}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.actorRoleSnap).toBe(Role.USER);
    });

    it('ADMIN1 看自己操作的记录 → 200', async () => {
      const res = await request(httpServer(app))
        .get(`/api/system/v1/audit-logs/${logByAdmin1}`)
        .set('Authorization', admin1Auth);
      expect(res.status).toBe(200);
      expect(res.body.data.actorUserId).toBe(admin1Id);
    });

    it('ADMIN1 看 USER 操作的记录 → 200', async () => {
      const res = await request(httpServer(app))
        .get(`/api/system/v1/audit-logs/${logByUser}`)
        .set('Authorization', admin1Auth);
      expect(res.status).toBe(200);
      expect(res.body.data.actorRoleSnap).toBe(Role.USER);
    });

    it('ADMIN1 越级查 SUPER_ADMIN 操作的记录 → 403 14101', async () => {
      const res = await request(httpServer(app))
        .get(`/api/system/v1/audit-logs/${logBySuper}`)
        .set('Authorization', admin1Auth);
      expectBizError(res, BizCode.FORBIDDEN_AUDIT_LOG_READ);
    });

    it('ADMIN1 看另一个 ADMIN(ADMIN2)操作的记录 → 403 14101', async () => {
      const res = await request(httpServer(app))
        .get(`/api/system/v1/audit-logs/${logByAdmin2}`)
        .set('Authorization', admin1Auth);
      expectBizError(res, BizCode.FORBIDDEN_AUDIT_LOG_READ);
    });

    it('不存在的 id → 404 14001', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/audit-logs/cl-non-existent-id-1234567890')
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.AUDIT_LOG_NOT_FOUND);
    });
  });

  // ============ list 过滤 + 排序 ============

  describe('list 过滤 + 排序', () => {
    it('resourceType=emergency_contact 仅返 emergency_contact 记录', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/audit-logs')
        .query({ resourceType: 'emergency_contact' })
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(2);
      const items = res.body.data.items as Array<{ resourceType: string }>;
      const types = new Set<string>(items.map((i) => i.resourceType));
      expect(types).toEqual(new Set(['emergency_contact']));
    });

    it('resourceId=cert-by-user 仅返该条', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/audit-logs')
        .query({ resourceId: 'cert-by-user' })
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].id).toBe(logByUser);
    });

    it('event=certificate.create 仅返 certificate.create 事件', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/audit-logs')
        .query({ event: 'certificate.create' })
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].event).toBe('certificate.create');
    });

    it('actorUserId=user 仅返该 user 操作的记录', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/audit-logs')
        .query({ actorUserId: userId })
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].id).toBe(logByUser);
    });

    it('startDate / endDate 时间窗过滤(全过滤掉 → 0)', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/audit-logs')
        .query({ startDate: '2000-01-01T00:00:00.000Z', endDate: '2000-12-31T23:59:59.999Z' })
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(0);
    });

    it('startDate 仅传起点(覆盖到全部记录)', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/audit-logs')
        .query({ startDate: '2020-01-01T00:00:00.000Z' })
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(5);
    });

    it('排序契约:createdAt desc + id desc(最新写入排第一)', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/audit-logs')
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      const items = res.body.data.items as Array<{ id: string; createdAt: string }>;
      for (let i = 1; i < items.length; i++) {
        const prev = items[i - 1];
        const cur = items[i];
        // 同 createdAt 用 id desc 兜底
        const cmp = prev.createdAt.localeCompare(cur.createdAt);
        if (cmp === 0) {
          expect(prev.id.localeCompare(cur.id)).toBeGreaterThanOrEqual(0);
        } else {
          expect(cmp).toBeGreaterThan(0);
        }
      }
    });
  });

  // ============ 分页 ============

  describe('分页', () => {
    it('pageSize=2,page=1 返前 2 条,total=5', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/audit-logs')
        .query({ page: 1, pageSize: 2 })
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(2);
      expect(res.body.data.total).toBe(5);
      expect(res.body.data.page).toBe(1);
      expect(res.body.data.pageSize).toBe(2);
    });

    it('pageSize=2,page=3 返最后 1 条', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/audit-logs')
        .query({ page: 3, pageSize: 2 })
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.total).toBe(5);
    });
  });

  // ============ 不可改不可删(controller 不开放写接口,框架返 404) ============

  describe('不可改不可删', () => {
    it('POST /api/system/v1/audit-logs/:id → 404(controller 未开放)', async () => {
      const res = await request(httpServer(app))
        .post(`/api/system/v1/audit-logs/${logBySuper}`)
        .set('Authorization', superAdminAuth)
        .send({});
      expect(res.status).toBe(404);
    });

    it('PATCH /api/system/v1/audit-logs/:id → 404', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/system/v1/audit-logs/${logBySuper}`)
        .set('Authorization', superAdminAuth)
        .send({});
      expect(res.status).toBe(404);
    });

    it('PUT /api/system/v1/audit-logs/:id → 404', async () => {
      const res = await request(httpServer(app))
        .put(`/api/system/v1/audit-logs/${logBySuper}`)
        .set('Authorization', superAdminAuth)
        .send({});
      expect(res.status).toBe(404);
    });

    it('DELETE /api/system/v1/audit-logs/:id → 404', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/system/v1/audit-logs/${logBySuper}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(404);
    });
  });

  // ============ AuditContext 锁形读出 ============

  describe('AuditContext 锁形', () => {
    it('detail 返回 context 必含 requestId / ip / ua 三字段', async () => {
      const res = await request(httpServer(app))
        .get(`/api/system/v1/audit-logs/${logBySuper}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      const ctx = res.body.data.context;
      expect(ctx.requestId).toBe(META.requestId);
      expect(ctx.ip).toBe(META.ip);
      expect(ctx.ua).toBe(META.ua);
    });

    it('ip / ua 写入 null:detail 读出字段存在但值为 null', async () => {
      const res = await request(httpServer(app))
        .get(`/api/system/v1/audit-logs/${logWithFullContext}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      const ctx = res.body.data.context;
      expect(ctx.requestId).toBe(META.requestId);
      expect(ctx.ip).toBeNull();
      expect(ctx.ua).toBeNull();
      // 字段必须存在(锁形;非 undefined 缺省)
      expect('ip' in ctx).toBe(true);
      expect('ua' in ctx).toBe(true);
    });

    it('before + after + extra 全部写入:detail 6 字段齐全', async () => {
      const res = await request(httpServer(app))
        .get(`/api/system/v1/audit-logs/${logWithFullContext}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      const ctx = res.body.data.context;
      expect(ctx.before).toEqual({ certStatusCode: 'pending', verifyNote: null });
      expect(ctx.after).toEqual({ certStatusCode: 'verified', verifyNote: '材料齐全' });
      expect(ctx.extra).toEqual({ verifierMemberId: 'mem-x' });
    });

    it('不带 before / after / extra 的记录:detail 仅 3 必填字段(无 key)', async () => {
      // logByAdmin2 仅传了 META,无 before/after/extra
      const res = await request(httpServer(app))
        .get(`/api/system/v1/audit-logs/${logByAdmin2}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      const ctx = res.body.data.context as Record<string, unknown>;
      expect(Object.keys(ctx).sort()).toEqual(['ip', 'requestId', 'ua'].sort());
    });

    it('仅 extra 的记录:detail 4 字段(3 必填 + extra)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/system/v1/audit-logs/${logBySuper}`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      const ctx = res.body.data.context as Record<string, unknown>;
      expect(Object.keys(ctx).sort()).toEqual(['extra', 'ip', 'requestId', 'ua'].sort());
      expect(ctx.extra).toEqual({ operation: 'create' });
    });
  });

  // ============ 不审计自身(F6) ============

  describe('不审计自身', () => {
    it('GET list 不写入新审计记录', async () => {
      const before = await prisma.auditLog.count();
      await request(httpServer(app))
        .get('/api/system/v1/audit-logs')
        .set('Authorization', superAdminAuth)
        .expect(200);
      const after = await prisma.auditLog.count();
      expect(after).toBe(before);
    });

    it('GET detail 不写入新审计记录', async () => {
      const before = await prisma.auditLog.count();
      await request(httpServer(app))
        .get(`/api/system/v1/audit-logs/${logBySuper}`)
        .set('Authorization', superAdminAuth)
        .expect(200);
      const after = await prisma.auditLog.count();
      expect(after).toBe(before);
    });
  });

  // ============ DTO 白名单(forbidNonWhitelisted 兜底) ============

  describe('DTO 白名单', () => {
    it('未声明字段 → 400 BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/audit-logs')
        .query({ nonExistent: 'foo' })
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(BizCode.BAD_REQUEST.code);
    });

    it('startDate 非 ISO 字符串 → 400 BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/audit-logs')
        .query({ startDate: 'not-a-date' })
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(BizCode.BAD_REQUEST.code);
    });
  });

  // ============ cleanup helper 防御 ============

  describe('cleanup helper', () => {
    it('truncateAuditLogsTestOnly 清空 audit_logs 表', async () => {
      // 单独跑此组,先确认有数据,truncate 后空
      const before = await prisma.auditLog.count();
      expect(before).toBeGreaterThan(0);

      await truncateAuditLogsTestOnly(app);
      const after = await prisma.auditLog.count();
      expect(after).toBe(0);

      // 后续测试不依赖审计数据,truncate 不破坏 spec 完整性;
      // 但如果以后有"事件隔离"等用例,需要在此后重新写入数据
    });
  });
});
