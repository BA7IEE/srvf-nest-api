import type { INestApplication } from '@nestjs/common';
import { AttachmentMimeConfigStatus, AttachmentTypeConfigStatus, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { truncateAuditLogsTestOnly } from '../helpers/audit-logs-cleanup';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2.x C-7 attachments 实施 PR #6d(2026-05-15):配置三表 audit_logs 集成 e2e。
//
// 沿 D7-attachments v1.0 §7.1 / §7.2 + 用户 PR #6d 8 项 Q 拍板:
// - 11 个写端点接 audit:type/mime/size × {create / update / delete} + type/mime updateStatus
// - 单事件 'attachment.config.change' + extra.configType ∈ {type, mime, sizeLimit} +
//   extra.operation ∈ {create, update, update-status, delete}
// - resourceType 按表区分:attachment_type_config / attachment_mime_config / attachment_size_limit_config(Q2)
// - snapshot 不含 id / 时间戳 / deletedAt(Q3)
// - update-status before/after 仅 status(Q4)
// - extra 含业务字段:type:code/ownerTable;mime:typeConfigId/mime;size:typeConfigId/maxSizeBytes(Q6)
// - 同事务 fail-fast(Q8):create 成功 + audit 成功一起提交;P2002 → BizException 不写 audit
//
// **本 spec 不覆盖**:
// - GET / list 读端点 audit(R4:read 不审计)
// - 失败操作 audit(F6 fail-fast;事务未开)
// - attachments 主模块 audit(已 PR #6c)

const SUPER_USERNAME = 'cfg-audit-su';
const ADMIN_USERNAME = 'cfg-audit-adm';
const USER_USERNAME = 'cfg-audit-user';

describe('attachment-configs audit_logs 集成', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let superAuth: string;
  let adminAuth: string;
  let userAuth: string;
  let superId: string;
  let adminId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const superUser = await createTestUser(app, {
      username: SUPER_USERNAME,
      role: Role.SUPER_ADMIN,
    });
    superId = superUser.id;
    const adminUser = await createTestUser(app, { username: ADMIN_USERNAME, role: Role.ADMIN });
    adminId = adminUser.id;
    await createTestUser(app, { username: USER_USERNAME, role: Role.USER });

    superAuth = (await loginAs(app, SUPER_USERNAME)).authHeader;
    adminAuth = (await loginAs(app, ADMIN_USERNAME)).authHeader;
    userAuth = (await loginAs(app, USER_USERNAME)).authHeader;

    // P0-F PR-2B(2026-05-18):入口切到 service 层 rbac.can();失败统一 RBAC_FORBIDDEN(30100)。
    // 写操作 audit 验证需 ADMIN 持 ops-admin;否则 30100 在 service 层拦截后 audit 不写。
    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    await grantOpsAdminToUser(app, adminId, seed.opsAdminRoleId);
  });

  afterAll(async () => {
    await app.close();
  });

  // 每个 it 前清空 audit_logs + 3 张 config 表,保证落库断言隔离。
  beforeEach(async () => {
    await truncateAuditLogsTestOnly(app);
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "attachment_mime_configs", "attachment_size_limit_configs", "attachment_type_configs" RESTART IDENTITY CASCADE',
    );
  });

  // ============ Helpers ============

  const createTypeConfigFixture = async (
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string }> => {
    const res = await request(httpServer(app))
      .post('/api/v2/attachment-type-configs')
      .set('Authorization', superAuth)
      .send({
        code: 'member',
        displayName: '队员证件照',
        ownerTable: 'member',
        defaultMaxSizeBytes: 5_242_880,
        defaultMimeWhitelist: ['image/jpeg'],
        ...overrides,
      });
    expect(res.status).toBe(201);
    return res.body.data;
  };

  const seedTypeConfig = async (code = 'member'): Promise<{ id: string }> => {
    // 直接走 prisma(不经 HTTP,不产生 audit);for update / delete / mime / size 前置 fixture
    return prisma.attachmentTypeConfig.create({
      data: {
        code,
        displayName: `${code} display`,
        ownerTable: code,
        defaultMaxSizeBytes: 5_242_880,
        defaultMimeWhitelist: ['image/jpeg'],
      },
      select: { id: true },
    });
  };

  const seedMimeConfig = async (
    typeConfigId: string,
    mime = 'image/png',
  ): Promise<{ id: string }> => {
    return prisma.attachmentMimeConfig.create({
      data: { typeConfigId, mime },
      select: { id: true },
    });
  };

  const seedSizeConfig = async (typeConfigId: string): Promise<{ id: string }> => {
    return prisma.attachmentSizeLimitConfig.create({
      data: { typeConfigId, maxSizeBytes: 10_000_000 },
      select: { id: true },
    });
  };

  // ============ TypeConfig CRUD audit ============

  describe('TypeConfig audit', () => {
    it('case 1: POST type-config → attachment.config.change/type/create audit', async () => {
      const tc = await createTypeConfigFixture();
      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      const log = logs[0];
      expect(log.event).toBe('attachment.config.change');
      expect(log.resourceType).toBe('attachment_type_config');
      expect(log.resourceId).toBe(tc.id);
      expect(log.actorUserId).toBe(superId);
      expect(log.actorRoleSnap).toBe(Role.SUPER_ADMIN);
      expect(log.success).toBe(true);
      const ctx = log.context as Record<string, unknown>;
      const extra = ctx.extra as Record<string, unknown>;
      expect(extra).toEqual({
        configType: 'type',
        operation: 'create',
        code: 'member',
        ownerTable: 'member',
      });
    });

    it('case 2: PATCH type-config → attachment.config.change/type/update audit', async () => {
      const tc = await seedTypeConfig('member');
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-type-configs/${tc.id}`)
        .set('Authorization', superAuth)
        .send({ displayName: 'updated name' });
      expect(res.status).toBe(200);
      const log = (await prisma.auditLog.findFirst())!;
      const ctx = log.context as Record<string, unknown>;
      expect((ctx.extra as Record<string, unknown>).operation).toBe('update');
      expect(ctx.before).toBeDefined();
      expect(ctx.after).toBeDefined();
      expect((ctx.before as Record<string, unknown>).displayName).toBe('member display');
      expect((ctx.after as Record<string, unknown>).displayName).toBe('updated name');
    });

    it('case 3: PATCH type-config/status → attachment.config.change/type/update-status audit', async () => {
      const tc = await seedTypeConfig('member');
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-type-configs/${tc.id}/status`)
        .set('Authorization', superAuth)
        .send({ status: AttachmentTypeConfigStatus.INACTIVE });
      expect(res.status).toBe(200);
      const log = (await prisma.auditLog.findFirst())!;
      const ctx = log.context as Record<string, unknown>;
      const extra = ctx.extra as Record<string, unknown>;
      expect(extra.operation).toBe('update-status');
      expect(extra.code).toBe('member');
      // PR #6d Q4:before / after 仅 status 字段
      expect(ctx.before).toEqual({ status: AttachmentTypeConfigStatus.ACTIVE });
      expect(ctx.after).toEqual({ status: AttachmentTypeConfigStatus.INACTIVE });
    });

    it('case 4: DELETE type-config → attachment.config.change/type/delete audit', async () => {
      const tc = await seedTypeConfig('member');
      const res = await request(httpServer(app))
        .delete(`/api/v2/attachment-type-configs/${tc.id}`)
        .set('Authorization', superAuth);
      expect(res.status).toBe(200);
      const log = (await prisma.auditLog.findFirst())!;
      expect(log.resourceId).toBe(tc.id); // PR #6d Q5:resourceId=existing.id
      const ctx = log.context as Record<string, unknown>;
      expect((ctx.extra as Record<string, unknown>).operation).toBe('delete');
      expect(ctx.before).toBeDefined();
      expect(ctx.after).toBeUndefined(); // delete 无 after
    });
  });

  // ============ MimeConfig CRUD audit ============

  describe('MimeConfig audit', () => {
    it('case 5: POST mime-config → attachment.config.change/mime/create audit', async () => {
      const tc = await seedTypeConfig('member');
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-mime-configs')
        .set('Authorization', superAuth)
        .send({ typeConfigId: tc.id, mime: 'image/webp' });
      expect(res.status).toBe(201);
      const log = (await prisma.auditLog.findFirst())!;
      expect(log.resourceType).toBe('attachment_mime_config');
      const ctx = log.context as Record<string, unknown>;
      expect(ctx.extra).toEqual({
        configType: 'mime',
        operation: 'create',
        typeConfigId: tc.id,
        mime: 'image/webp',
      });
    });

    it('case 6: PATCH mime-config → attachment.config.change/mime/update audit', async () => {
      const tc = await seedTypeConfig('member');
      const mc = await seedMimeConfig(tc.id, 'image/png');
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-mime-configs/${mc.id}`)
        .set('Authorization', superAuth)
        .send({ remark: 'updated remark' });
      expect(res.status).toBe(200);
      const log = (await prisma.auditLog.findFirst())!;
      const ctx = log.context as Record<string, unknown>;
      expect((ctx.extra as Record<string, unknown>).operation).toBe('update');
      expect((ctx.before as Record<string, unknown>).remark).toBeNull();
      expect((ctx.after as Record<string, unknown>).remark).toBe('updated remark');
    });

    it('case 7: PATCH mime-config/status → attachment.config.change/mime/update-status audit', async () => {
      const tc = await seedTypeConfig('member');
      const mc = await seedMimeConfig(tc.id, 'image/png');
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-mime-configs/${mc.id}/status`)
        .set('Authorization', superAuth)
        .send({ status: AttachmentMimeConfigStatus.INACTIVE });
      expect(res.status).toBe(200);
      const log = (await prisma.auditLog.findFirst())!;
      const ctx = log.context as Record<string, unknown>;
      const extra = ctx.extra as Record<string, unknown>;
      expect(extra.operation).toBe('update-status');
      expect(extra.mime).toBe('image/png');
      expect(ctx.before).toEqual({ status: AttachmentMimeConfigStatus.ACTIVE });
      expect(ctx.after).toEqual({ status: AttachmentMimeConfigStatus.INACTIVE });
    });

    it('case 8: DELETE mime-config → attachment.config.change/mime/delete audit', async () => {
      const tc = await seedTypeConfig('member');
      const mc = await seedMimeConfig(tc.id, 'image/png');
      const res = await request(httpServer(app))
        .delete(`/api/v2/attachment-mime-configs/${mc.id}`)
        .set('Authorization', superAuth);
      expect(res.status).toBe(200);
      const log = (await prisma.auditLog.findFirst())!;
      expect(log.resourceId).toBe(mc.id);
      const ctx = log.context as Record<string, unknown>;
      expect((ctx.extra as Record<string, unknown>).operation).toBe('delete');
      expect(ctx.before).toBeDefined();
      expect(ctx.after).toBeUndefined();
    });
  });

  // ============ SizeLimitConfig CRUD audit ============

  describe('SizeLimitConfig audit', () => {
    it('case 9: POST size-config → attachment.config.change/sizeLimit/create audit', async () => {
      const tc = await seedTypeConfig('member');
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-size-limit-configs')
        .set('Authorization', superAuth)
        .send({ typeConfigId: tc.id, maxSizeBytes: 20_000_000 });
      expect(res.status).toBe(201);
      const log = (await prisma.auditLog.findFirst())!;
      expect(log.resourceType).toBe('attachment_size_limit_config');
      const ctx = log.context as Record<string, unknown>;
      expect(ctx.extra).toEqual({
        configType: 'sizeLimit',
        operation: 'create',
        typeConfigId: tc.id,
        maxSizeBytes: 20_000_000,
      });
    });

    it('case 10: PATCH size-config → attachment.config.change/sizeLimit/update audit', async () => {
      const tc = await seedTypeConfig('member');
      const sc = await seedSizeConfig(tc.id);
      const res = await request(httpServer(app))
        .patch(`/api/v2/attachment-size-limit-configs/${sc.id}`)
        .set('Authorization', superAuth)
        .send({ maxSizeBytes: 30_000_000 });
      expect(res.status).toBe(200);
      const log = (await prisma.auditLog.findFirst())!;
      const ctx = log.context as Record<string, unknown>;
      const extra = ctx.extra as Record<string, unknown>;
      expect(extra.operation).toBe('update');
      expect((ctx.before as Record<string, unknown>).maxSizeBytes).toBe(10_000_000);
      expect((ctx.after as Record<string, unknown>).maxSizeBytes).toBe(30_000_000);
    });

    it('case 11: DELETE size-config → attachment.config.change/sizeLimit/delete audit', async () => {
      const tc = await seedTypeConfig('member');
      const sc = await seedSizeConfig(tc.id);
      const res = await request(httpServer(app))
        .delete(`/api/v2/attachment-size-limit-configs/${sc.id}`)
        .set('Authorization', superAuth);
      expect(res.status).toBe(200);
      const log = (await prisma.auditLog.findFirst())!;
      expect(log.resourceId).toBe(sc.id);
      const ctx = log.context as Record<string, unknown>;
      expect((ctx.extra as Record<string, unknown>).operation).toBe('delete');
      expect(ctx.before).toBeDefined();
      expect(ctx.after).toBeUndefined();
    });
  });

  // ============ Snapshot 字段完整性 ============

  describe('snapshot 字段完整性', () => {
    it('case 12: type snapshot 完整字段(不含 id / createdAt / updatedAt / deletedAt)', async () => {
      const tc = await createTypeConfigFixture();
      const log = (await prisma.auditLog.findFirst())!;
      const after = (log.context as Record<string, unknown>).after as Record<string, unknown>;
      expect(after).toEqual({
        code: 'member',
        displayName: '队员证件照',
        description: null,
        ownerTable: 'member',
        defaultMaxSizeBytes: 5_242_880,
        defaultMimeWhitelist: ['image/jpeg'],
        status: AttachmentTypeConfigStatus.ACTIVE,
      });
      expect(after).not.toHaveProperty('id');
      expect(after).not.toHaveProperty('createdAt');
      expect(after).not.toHaveProperty('updatedAt');
      expect(after).not.toHaveProperty('deletedAt');
      // 嵌套 typeConfig 摘要不进 audit snapshot(扁平化;type 表本身无此嵌套)
      expect(tc.id).toBeTruthy();
    });

    it('case 13: mime update before+after 字段完整', async () => {
      const tc = await seedTypeConfig('member');
      const mc = await seedMimeConfig(tc.id, 'image/png');
      await request(httpServer(app))
        .patch(`/api/v2/attachment-mime-configs/${mc.id}`)
        .set('Authorization', superAuth)
        .send({ remark: 'new remark' });
      const log = (await prisma.auditLog.findFirst())!;
      const ctx = log.context as Record<string, unknown>;
      const before = ctx.before as Record<string, unknown>;
      const after = ctx.after as Record<string, unknown>;
      expect(before).toEqual({
        typeConfigId: tc.id,
        mime: 'image/png',
        status: AttachmentMimeConfigStatus.ACTIVE,
        remark: null,
      });
      expect(after).toEqual({
        typeConfigId: tc.id,
        mime: 'image/png',
        status: AttachmentMimeConfigStatus.ACTIVE,
        remark: 'new remark',
      });
    });

    it('case 14: size delete before 字段完整', async () => {
      const tc = await seedTypeConfig('member');
      const sc = await seedSizeConfig(tc.id);
      await request(httpServer(app))
        .delete(`/api/v2/attachment-size-limit-configs/${sc.id}`)
        .set('Authorization', superAuth);
      const log = (await prisma.auditLog.findFirst())!;
      const before = (log.context as Record<string, unknown>).before as Record<string, unknown>;
      expect(before).toEqual({
        typeConfigId: tc.id,
        maxSizeBytes: 10_000_000,
        remark: null,
      });
    });
  });

  // ============ AuditMeta / actorRoleSnap ============

  describe('AuditMeta / actorRoleSnap', () => {
    it('case 15: audit context 含 requestId / ip / ua', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-type-configs')
        .set('Authorization', superAuth)
        .set('User-Agent', 'cfg-audit-spec/1.0')
        .send({ code: 'member', displayName: '队员', ownerTable: 'member' });
      expect(res.status).toBe(201);
      const log = (await prisma.auditLog.findFirst())!;
      const ctx = log.context as Record<string, unknown>;
      expect(typeof ctx.requestId).toBe('string');
      expect((ctx.requestId as string).length).toBeGreaterThan(0);
      expect(ctx).toHaveProperty('ip');
      expect(ctx).toHaveProperty('ua');
      expect(ctx.ua).toBe('cfg-audit-spec/1.0');
    });

    it('case 16: actorRoleSnap 反映 SUPER_ADMIN / ADMIN', async () => {
      // SUPER_ADMIN
      await createTypeConfigFixture({ code: 'member' });
      let log = (await prisma.auditLog.findFirst({ orderBy: { createdAt: 'desc' } }))!;
      expect(log.actorRoleSnap).toBe(Role.SUPER_ADMIN);
      expect(log.actorUserId).toBe(superId);

      // ADMIN
      await truncateAuditLogsTestOnly(app);
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-type-configs')
        .set('Authorization', adminAuth)
        .send({ code: 'certificate', displayName: 'cert', ownerTable: 'certificate' });
      expect(res.status).toBe(201);
      log = (await prisma.auditLog.findFirst())!;
      expect(log.actorRoleSnap).toBe(Role.ADMIN);
      expect(log.actorUserId).toBe(adminId);
    });
  });

  // ============ 失败操作不写 audit(F6 fail-fast)============

  describe('失败操作不写 audit(沿 D6 F6)', () => {
    it('case 17: unauthorized POST → 无 audit', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-type-configs')
        .send({ code: 'member', displayName: '队员', ownerTable: 'member' });
      expectBizError(res, BizCode.UNAUTHORIZED);
      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(0);
    });

    it('case 18: USER RBAC_FORBIDDEN POST → 无 audit(P0-F PR-2B:40300 → 30100)', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachment-type-configs')
        .set('Authorization', userAuth)
        .send({ code: 'member', displayName: '队员', ownerTable: 'member' });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(0);
    });

    it('case 19: duplicate code / duplicate mime / duplicate size → 无 audit', async () => {
      // type duplicate code (13021)
      await createTypeConfigFixture({ code: 'member' });
      await truncateAuditLogsTestOnly(app); // 清掉成功 audit
      const dupType = await request(httpServer(app))
        .post('/api/v2/attachment-type-configs')
        .set('Authorization', superAuth)
        .send({ code: 'member', displayName: 'dup', ownerTable: 'member' });
      expectBizError(dupType, BizCode.ATTACHMENT_TYPE_CONFIG_CODE_ALREADY_EXISTS);
      expect(await prisma.auditLog.count()).toBe(0);

      // mime duplicate (13024)
      const tcRow = await prisma.attachmentTypeConfig.findFirst({ where: { code: 'member' } });
      await seedMimeConfig(tcRow!.id, 'image/png');
      const dupMime = await request(httpServer(app))
        .post('/api/v2/attachment-mime-configs')
        .set('Authorization', superAuth)
        .send({ typeConfigId: tcRow!.id, mime: 'image/png' });
      expectBizError(dupMime, BizCode.ATTACHMENT_MIME_CONFIG_DUPLICATE);
      expect(await prisma.auditLog.count()).toBe(0);

      // size duplicate (13027)
      await seedSizeConfig(tcRow!.id);
      const dupSize = await request(httpServer(app))
        .post('/api/v2/attachment-size-limit-configs')
        .set('Authorization', superAuth)
        .send({ typeConfigId: tcRow!.id, maxSizeBytes: 99 });
      expectBizError(dupSize, BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_ALREADY_EXISTS);
      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('case 20: not_found → 无 audit', async () => {
      const notExistId = 'cl9z3a8b00000abcd1234efgh';
      const updType = await request(httpServer(app))
        .patch(`/api/v2/attachment-type-configs/${notExistId}`)
        .set('Authorization', superAuth)
        .send({ displayName: 'x' });
      expectBizError(updType, BizCode.ATTACHMENT_TYPE_CONFIG_NOT_FOUND);
      expect(await prisma.auditLog.count()).toBe(0);

      const updMime = await request(httpServer(app))
        .patch(`/api/v2/attachment-mime-configs/${notExistId}`)
        .set('Authorization', superAuth)
        .send({ remark: 'x' });
      expectBizError(updMime, BizCode.ATTACHMENT_MIME_CONFIG_NOT_FOUND);
      expect(await prisma.auditLog.count()).toBe(0);

      const updSize = await request(httpServer(app))
        .patch(`/api/v2/attachment-size-limit-configs/${notExistId}`)
        .set('Authorization', superAuth)
        .send({ maxSizeBytes: 100 });
      expectBizError(updSize, BizCode.ATTACHMENT_SIZE_LIMIT_CONFIG_NOT_FOUND);
      expect(await prisma.auditLog.count()).toBe(0);
    });
  });

  // ============ 同事务一致性 ============

  describe('同事务 fail-fast(沿 D7 §7.2 / Q8)', () => {
    it('case 21: type create 成功 → type config + audit count 都=1', async () => {
      await createTypeConfigFixture();
      const tcCount = await prisma.attachmentTypeConfig.count();
      const auditCount = await prisma.auditLog.count({
        where: { event: 'attachment.config.change' },
      });
      expect(tcCount).toBe(1);
      expect(auditCount).toBe(1);
    });
  });
});
