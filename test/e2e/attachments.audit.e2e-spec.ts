import type { INestApplication } from '@nestjs/common';
import { AttachmentAccessLevel, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { truncateAuditLogsTestOnly } from '../helpers/audit-logs-cleanup';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2.x C-7 attachments 实施 PR #6c(2026-05-15):attachments 主模块 audit_logs 集成 e2e。
//
// 沿 D7-attachments v1.0 §7.1 / §7.2 + 用户 PR #6c 8 项 Q 拍板:
// - 仅 2 个写端点接 audit:POST create → 'attachment.upload' / DELETE delete → 'attachment.delete'
// - 不审计 PATCH metadata(Q7 v0.2 锁;本 spec case 14 验证)
// - 不审计失败操作(沿 D6 F6 fail-fast;本 spec case 8-13 验证 RBAC / mime / size / PII / not_found)
// - 同事务 fail-fast(沿 D7 §7.2;case 1 / 5 验证 audit + 主表写入一致性)
// - extra.scope:'self' | 'other' | null(activity 粗粒度为 null;Q4)
// - extra.deletedByPath:'owner' | 'admin'(按 currentUser.id === uploadedBy 判定;Q5)
// - audit context 必含 requestId / ip / ua 三字段(沿 D6 §12)
//
// **本 spec 不覆盖**(沿 PR #6c 边界):
// - 配置三表 attachment.config.change(留 PR #6d)
// - PATCH metadata audit(Q7 v0.2 锁:不审计)
// - GET / list / by-owner / me/uploaded audit(R4:read 不审计)

const SUPER_USERNAME = 'attach-audit-su';
const SELF_USERNAME = 'attach-audit-self';
const OTHER_USERNAME = 'attach-audit-other';

const MEMBER_ROLE_PERMISSION_CODES = [
  'attachment.upload.member.self',
  'attachment.view.member.self',
  'attachment.update.member.self',
  'attachment.delete.member.self',
  'attachment.upload.certificate.self',
  'attachment.view.certificate.self',
  'attachment.update.certificate.self',
  'attachment.delete.certificate.self',
  'attachment.view.activity',
] as const;

const ATTACHMENT_PERMISSION_CODES = [
  ...MEMBER_ROLE_PERMISSION_CODES,
  'attachment.upload.member.other',
  'attachment.view.member.other',
  'attachment.update.member.other',
  'attachment.delete.member.other',
  'attachment.upload.certificate.other',
  'attachment.view.certificate.other',
  'attachment.update.certificate.other',
  'attachment.delete.certificate.other',
  'attachment.upload.activity',
  'attachment.update.activity',
  'attachment.delete.activity',
] as const;

describe('attachments audit_logs 集成', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let superAuth: string;
  let selfAuth: string;
  let superId: string;

  let memberA: { id: string };
  let memberB: { id: string };
  let typeConfigMemberId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    // ============ User / Member 绑定 ============
    const superUser = await createTestUser(app, {
      username: SUPER_USERNAME,
      role: Role.SUPER_ADMIN,
    });
    superId = superUser.id;
    const selfUser = await createTestUser(app, { username: SELF_USERNAME });
    const otherUser = await createTestUser(app, { username: OTHER_USERNAME });

    memberA = await prisma.member.create({
      data: { memberNo: 'MA-AUDIT', displayName: 'MemberA' },
      select: { id: true },
    });
    memberB = await prisma.member.create({
      data: { memberNo: 'MB-AUDIT', displayName: 'MemberB' },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: selfUser.id }, data: { memberId: memberA.id } });
    await prisma.user.update({ where: { id: otherUser.id }, data: { memberId: memberB.id } });

    // ============ TypeConfig(member;ownerTable='member' 进 audit extra) ============
    const tcMember = await prisma.attachmentTypeConfig.create({
      data: {
        code: 'member',
        displayName: '队员证件照',
        ownerTable: 'member',
        defaultMaxSizeBytes: 5_242_880,
        defaultMimeWhitelist: ['image/jpeg', 'image/png'],
      },
      select: { id: true },
    });
    typeConfigMemberId = tcMember.id;

    // ============ RBAC seed:20 条 permission + member 角色 + 9 条 RolePermission ============
    for (const code of ATTACHMENT_PERMISSION_CODES) {
      const [m, a, r, scope] = code.split('.');
      await prisma.permission.upsert({
        where: { code },
        update: {},
        create: {
          code,
          module: m,
          action: a,
          resourceType: r,
          description: scope ? `${a} ${r}.${scope}` : `${a} ${r}`,
        },
      });
    }
    const memberRole = await prisma.rbacRole.upsert({
      where: { code: 'member' },
      update: {},
      create: { code: 'member', displayName: '队员', description: 'USER 内置角色 placeholder' },
      select: { id: true },
    });
    const memberRolePerms = await prisma.permission.findMany({
      where: { code: { in: [...MEMBER_ROLE_PERMISSION_CODES] } },
      select: { id: true, code: true },
    });
    for (const perm of memberRolePerms) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: memberRole.id, permissionId: perm.id } },
        update: {},
        create: { roleId: memberRole.id, permissionId: perm.id },
      });
    }
    for (const u of [selfUser, otherUser]) {
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId: u.id, roleId: memberRole.id } },
        update: {},
        create: { userId: u.id, roleId: memberRole.id },
      });
    }

    superAuth = (await loginAs(app, SUPER_USERNAME)).authHeader;
    selfAuth = (await loginAs(app, SELF_USERNAME)).authHeader;
    // otherUser 仅作为 memberB 绑定 fixture,不需要 token
    void otherUser;
  });

  afterAll(async () => {
    await app.close();
  });

  // 每个 it 前清空 audit_logs + attachments,保证落库断言隔离。
  beforeEach(async () => {
    await truncateAuditLogsTestOnly(app);
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "attachments" RESTART IDENTITY CASCADE');
  });

  // ============ Helpers ============

  const buildBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    key: `attachments/2026/05/${Math.random().toString(36).slice(2)}.jpg`,
    originalName: 'test.jpg',
    mime: 'image/jpeg',
    size: 100_000,
    ownerType: 'member',
    ownerId: memberA.id,
    ...overrides,
  });

  // ============ upload 成功路径 ============

  describe('POST /api/v2/attachments → attachment.upload', () => {
    it('case 1: upload 成功 → attachment.upload audit 落库 1 条(基本字段)', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachments')
        .set('Authorization', superAuth)
        .send(
          buildBody({
            description: 'a desc',
            tags: ['t1'],
            accessLevel: AttachmentAccessLevel.INTERNAL,
          }),
        );
      expect(res.status).toBe(201);
      const created = res.body.data;

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      const log = logs[0];
      expect(log.event).toBe('attachment.upload');
      expect(log.resourceType).toBe('attachment');
      expect(log.resourceId).toBe(created.id);
      expect(log.actorUserId).toBe(superId);
      expect(log.actorRoleSnap).toBe(Role.SUPER_ADMIN);
      expect(log.success).toBe(true);
    });

    it('case 2: upload audit after snapshot 完整字段(含 originalUploaderName;不含 accessUrl / checksum / etag)', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachments')
        .set('Authorization', superAuth)
        .send(
          buildBody({
            description: 'desc-after',
            tags: ['ta', 'tb'],
            accessLevel: AttachmentAccessLevel.SENSITIVE,
          }),
        );
      expect(res.status).toBe(201);

      const log = (await prisma.auditLog.findFirst())!;
      const ctx = log.context as Record<string, unknown>;
      const after = ctx.after as Record<string, unknown>;
      expect(after).toBeDefined();
      expect(after.key).toBe(res.body.data.key);
      expect(after.originalName).toBe('test.jpg');
      expect(after.mime).toBe('image/jpeg');
      expect(after.size).toBe(100_000);
      expect(after.uploadedBy).toBe(superId);
      expect(after.ownerType).toBe('member');
      expect(after.ownerId).toBe(memberA.id);
      expect(after.description).toBe('desc-after');
      expect(after.accessLevel).toBe(AttachmentAccessLevel.SENSITIVE);
      expect(after.tags).toEqual(['ta', 'tb']);
      expect(after.originalUploaderName).toBe(SUPER_USERNAME);
      expect(typeof after.uploadedAt).toBe('string'); // ISO8601 toISOString
      expect(after.expireAt).toBeNull();
      // 不含 accessUrl(非 DB 字段)/ checksum / etag(Q6 v1.0 不出参)
      expect(after).not.toHaveProperty('accessUrl');
      expect(after).not.toHaveProperty('checksum');
      expect(after).not.toHaveProperty('etag');
      // 不含 id / createdAt / updatedAt(audit_logs 自带 resourceId / createdAt)
      expect(after).not.toHaveProperty('id');
      expect(after).not.toHaveProperty('createdAt');
      expect(after).not.toHaveProperty('updatedAt');
      // 不含 before(create 场景)
      expect(ctx.before).toBeUndefined();
    });

    it('case 3: upload audit extra 包含 operation / attachmentType / ownerType / ownerId / mime / size / scope / ownerTable', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachments')
        .set('Authorization', selfAuth)
        .send(buildBody({ mime: 'image/png', size: 200_000 }));
      expect(res.status).toBe(201);

      const log = (await prisma.auditLog.findFirst())!;
      const ctx = log.context as Record<string, unknown>;
      const extra = ctx.extra as Record<string, unknown>;
      expect(extra).toEqual({
        operation: 'upload',
        attachmentType: 'member',
        ownerType: 'member',
        ownerId: memberA.id,
        mime: 'image/png',
        size: 200_000,
        scope: 'self', // selfUser.memberId === memberA.id
        ownerTable: 'member',
      });
    });

    it('case 4: upload audit context 含 requestId / ip / ua 三字段(沿 D6 §12)', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachments')
        .set('Authorization', superAuth)
        .set('User-Agent', 'attach-audit-spec/1.0')
        .send(buildBody());
      expect(res.status).toBe(201);

      const log = (await prisma.auditLog.findFirst())!;
      const ctx = log.context as Record<string, unknown>;
      expect(typeof ctx.requestId).toBe('string');
      expect((ctx.requestId as string).length).toBeGreaterThan(0);
      // ip / ua 字段必存在(可为 null;e2e 环境通常非 null)
      expect(ctx).toHaveProperty('ip');
      expect(ctx).toHaveProperty('ua');
      expect(ctx.ua).toBe('attach-audit-spec/1.0');
    });

    it('case 3b: scope=other 场景(SUPER_ADMIN 上传 memberB 附件;user.memberId=null → other)', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachments')
        .set('Authorization', superAuth)
        .send(buildBody({ ownerId: memberB.id }));
      expect(res.status).toBe(201);

      const log = (await prisma.auditLog.findFirst())!;
      const extra = (log.context as Record<string, unknown>).extra as Record<string, unknown>;
      expect(extra.scope).toBe('other');
      expect(extra.ownerId).toBe(memberB.id);
    });
  });

  // ============ delete 成功路径 ============

  describe('DELETE /api/v2/attachments/:id → attachment.delete', () => {
    it('case 5: delete 成功 → attachment.delete audit 落库 1 条(基本字段)', async () => {
      // 先 upload(会产生 1 条 upload audit)
      const upload = await request(httpServer(app))
        .post('/api/v2/attachments')
        .set('Authorization', superAuth)
        .send(buildBody());
      expect(upload.status).toBe(201);
      const attId: string = upload.body.data.id;
      await truncateAuditLogsTestOnly(app); // 清掉 upload audit,只留 delete

      const del = await request(httpServer(app))
        .delete(`/api/v2/attachments/${attId}`)
        .set('Authorization', superAuth);
      expect(del.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      const log = logs[0];
      expect(log.event).toBe('attachment.delete');
      expect(log.resourceType).toBe('attachment');
      expect(log.resourceId).toBe(attId);
      expect(log.actorUserId).toBe(superId);
      expect(log.actorRoleSnap).toBe(Role.SUPER_ADMIN);
      expect(log.success).toBe(true);
    });

    it('case 6: delete audit before snapshot 完整字段(物理删后留快照便于追溯)', async () => {
      const upload = await request(httpServer(app))
        .post('/api/v2/attachments')
        .set('Authorization', superAuth)
        .send(buildBody({ description: 'delete-before', tags: ['del'] }));
      const attId: string = upload.body.data.id;
      const uploadedKey = upload.body.data.key;
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .delete(`/api/v2/attachments/${attId}`)
        .set('Authorization', superAuth);

      const log = (await prisma.auditLog.findFirst())!;
      const ctx = log.context as Record<string, unknown>;
      const before = ctx.before as Record<string, unknown>;
      expect(before).toBeDefined();
      expect(before.key).toBe(uploadedKey);
      expect(before.ownerType).toBe('member');
      expect(before.ownerId).toBe(memberA.id);
      expect(before.description).toBe('delete-before');
      expect(before.tags).toEqual(['del']);
      expect(before.originalUploaderName).toBe(SUPER_USERNAME);
      // delete 不含 after(物理删后无 after)
      expect(ctx.after).toBeUndefined();
      // 同 case 2:不含 accessUrl / checksum / etag / id / 时间戳
      expect(before).not.toHaveProperty('accessUrl');
      expect(before).not.toHaveProperty('checksum');
      expect(before).not.toHaveProperty('id');
    });

    it('case 7a: delete extra deletedByPath=owner(currentUser = uploadedBy)', async () => {
      // selfUser 上传(memberA);selfUser 再删
      const upload = await request(httpServer(app))
        .post('/api/v2/attachments')
        .set('Authorization', selfAuth)
        .send(buildBody());
      const attId: string = upload.body.data.id;
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .delete(`/api/v2/attachments/${attId}`)
        .set('Authorization', selfAuth);

      const log = (await prisma.auditLog.findFirst())!;
      const extra = (log.context as Record<string, unknown>).extra as Record<string, unknown>;
      expect(extra).toMatchObject({
        operation: 'delete',
        attachmentType: 'member',
        ownerType: 'member',
        ownerId: memberA.id,
        mime: 'image/jpeg',
        scope: 'self',
        deletedByPath: 'owner', // selfId === uploadedBy
      });
    });

    it('case 7b: delete extra deletedByPath=admin(SUPER_ADMIN 删别人上传的)', async () => {
      // selfUser 上传(uploadedBy = selfId);SUPER_ADMIN 删
      const upload = await request(httpServer(app))
        .post('/api/v2/attachments')
        .set('Authorization', selfAuth)
        .send(buildBody());
      const attId: string = upload.body.data.id;
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .delete(`/api/v2/attachments/${attId}`)
        .set('Authorization', superAuth);

      const log = (await prisma.auditLog.findFirst())!;
      const extra = (log.context as Record<string, unknown>).extra as Record<string, unknown>;
      expect(extra.deletedByPath).toBe('admin'); // superId !== uploadedBy(selfId)
      expect(extra.scope).toBe('other'); // SUPER_ADMIN.memberId=null,scope 退化 other
    });
  });

  // ============ 失败操作不审计(沿 D6 F6 fail-fast)============

  describe('失败操作不落 audit(沿 D6 F6 fail-fast)', () => {
    it('case 8: upload RBAC 拒绝(30100)→ 无 audit', async () => {
      // selfUser(member 角色)上传 memberB 附件:无 .other 权限 → 30100
      const res = await request(httpServer(app))
        .post('/api/v2/attachments')
        .set('Authorization', selfAuth)
        .send(buildBody({ ownerId: memberB.id }));
      expectBizError(res, BizCode.RBAC_FORBIDDEN);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(0);
    });

    it('case 9: upload MIME 拒绝(13033;系统级黑名单)→ 无 audit', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachments')
        .set('Authorization', superAuth)
        .send(buildBody({ mime: 'application/zip' }));
      expectBizError(res, BizCode.ATTACHMENT_SYSTEM_MIME_BLOCKED);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(0);
    });

    it('case 10: upload size 拒绝(13013)→ 无 audit', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachments')
        .set('Authorization', superAuth)
        .send(buildBody({ size: 100_000_000 }));
      expectBizError(res, BizCode.ATTACHMENT_SIZE_EXCEEDED);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(0);
    });

    it('case 11: upload PII 拒绝(13015;身份证号)→ 无 audit', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachments')
        .set('Authorization', superAuth)
        .send(buildBody({ description: '身份证 11010119900101123X' }));
      expectBizError(res, BizCode.ATTACHMENT_PII_DETECTED);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(0);
    });

    it('case 12: delete RBAC 拒绝(30100)→ 无 audit', async () => {
      // superAdmin 先上传 memberB 附件(短路通过);selfUser 删:无 .other 权限 → 30100
      const upload = await request(httpServer(app))
        .post('/api/v2/attachments')
        .set('Authorization', superAuth)
        .send(buildBody({ ownerId: memberB.id }));
      const attId: string = upload.body.data.id;
      await truncateAuditLogsTestOnly(app);

      const del = await request(httpServer(app))
        .delete(`/api/v2/attachments/${attId}`)
        .set('Authorization', selfAuth);
      expectBizError(del, BizCode.RBAC_FORBIDDEN);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(0);
    });

    it('case 13: delete 不存在(13001)→ 无 audit', async () => {
      const res = await request(httpServer(app))
        .delete('/api/v2/attachments/cl9z3a8b00000abcd1234efgh')
        .set('Authorization', superAuth);
      expectBizError(res, BizCode.ATTACHMENT_NOT_FOUND);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(0);
    });
  });

  // ============ PATCH metadata 不审计(沿 Q7 v0.2 锁)============

  describe('PATCH metadata 不审计(沿 D7 §7.1 / Q7 v0.2 锁)', () => {
    it('case 14: PATCH 成功更新 description / tags / accessLevel / expireAt → 无 audit', async () => {
      const upload = await request(httpServer(app))
        .post('/api/v2/attachments')
        .set('Authorization', superAuth)
        .send(buildBody());
      const attId: string = upload.body.data.id;
      await truncateAuditLogsTestOnly(app); // 清掉 upload audit

      const patch = await request(httpServer(app))
        .patch(`/api/v2/attachments/${attId}`)
        .set('Authorization', superAuth)
        .send({
          description: 'updated metadata',
          tags: ['new', 'tags'],
          accessLevel: AttachmentAccessLevel.PUBLIC,
          expireAt: '2027-01-01T00:00:00.000Z',
        });
      expect(patch.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(0); // PATCH metadata 不审计
    });
  });

  // ============ 同事务 fail-fast 一致性 ============

  describe('同事务 fail-fast(沿 D7 §7.2)', () => {
    it('case 15: upload 成功 → attachment + audit 同事务可见(count 都 = 1)', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/attachments')
        .set('Authorization', superAuth)
        .send(buildBody());
      expect(res.status).toBe(201);

      const attachmentCount = await prisma.attachment.count();
      const auditCount = await prisma.auditLog.count({ where: { event: 'attachment.upload' } });
      expect(attachmentCount).toBe(1);
      expect(auditCount).toBe(1);
    });

    it('case 16: delete 成功 → attachment 物理删除,且 audit attachment.delete 落库', async () => {
      // 别用 typeConfigMemberId,直接用 superAuth 上传
      const upload = await request(httpServer(app))
        .post('/api/v2/attachments')
        .set('Authorization', superAuth)
        .send(buildBody());
      const attId: string = upload.body.data.id;
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .delete(`/api/v2/attachments/${attId}`)
        .set('Authorization', superAuth);

      // 物理删:Attachment row 不存在
      const stillThere = await prisma.attachment.findUnique({ where: { id: attId } });
      expect(stillThere).toBeNull();
      // audit 落 1 条
      const deleteAudits = await prisma.auditLog.findMany({
        where: { event: 'attachment.delete' },
      });
      expect(deleteAudits).toHaveLength(1);
      expect(deleteAudits[0].resourceId).toBe(attId);
    });
  });

  // 引用 typeConfigMemberId 抑制 lint 未用变量(它在 beforeAll 中被 schema seed 间接使用)。
  it('typeConfigMemberId 已 seed', () => {
    expect(typeConfigMemberId).toBeTruthy();
  });
});
