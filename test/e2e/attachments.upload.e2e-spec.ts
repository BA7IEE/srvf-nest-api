import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { signUploadToken } from '../../src/modules/storage/upload-token.util';
import appConfig from '../../src/config/app.config';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2.x C-7.5 PR #10:upload-url + confirm-upload e2e(沿评审 §8 + Q-10-1 到 Q-10-15 拍板)
// 29 用例(15 upload-url + 14 confirm-upload;#29 = F10 #399 owner 软删窗口复校)

const SUPER_USERNAME = 'upl-su';
const SELF_USERNAME = 'upl-self';
const OTHER_USERNAME = 'upl-other';
const NO_MEMBER_USERNAME = 'upl-nomember';

const MEMBER_ROLE_PERMISSION_CODES = [
  'attachment.upload.member.self',
  'attachment.view.member.self',
  'attachment.upload.certificate.self',
  'attachment.view.certificate.self',
  'attachment.view.activity',
] as const;

const ATTACHMENT_PERMISSION_CODES = [
  ...MEMBER_ROLE_PERMISSION_CODES,
  'attachment.upload.member.other',
  'attachment.upload.certificate.other',
  'attachment.upload.activity',
] as const;

describe('attachments upload-url + confirm-upload', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let superAuth: string;
  let selfAuth: string;
  let otherAuth: string;

  let selfUserId: string;
  let memberA: { id: string };
  let memberB: { id: string };
  let activity: { id: string };
  let certificateA: { id: string };

  // 沿用 test/setup 的 .env.test;STORAGE_ENCRYPTION_KEY 可能留空 → 这里通过 sign 工具直接读 cfg
  let encryptionKey: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    // 1. 用户
    await createTestUser(app, { username: SUPER_USERNAME, role: Role.SUPER_ADMIN });
    const selfUser = await createTestUser(app, { username: SELF_USERNAME });
    const otherUser = await createTestUser(app, { username: OTHER_USERNAME });
    await createTestUser(app, { username: NO_MEMBER_USERNAME });
    selfUserId = selfUser.id;

    // 2. 业务对象
    const org = await prisma.organization.create({
      data: { name: 'TestOrg', nodeTypeCode: 'team', sortOrder: 0 },
      select: { id: true },
    });
    memberA = await prisma.member.create({
      data: { memberNo: 'UPL-A001', displayName: 'MemberA' },
      select: { id: true },
    });
    memberB = await prisma.member.create({
      data: { memberNo: 'UPL-B001', displayName: 'MemberB' },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: selfUser.id }, data: { memberId: memberA.id } });
    await prisma.user.update({ where: { id: otherUser.id }, data: { memberId: memberB.id } });
    activity = await prisma.activity.create({
      data: {
        title: 'TestActivity',
        activityTypeCode: 'training',
        organizationId: org.id,
        startAt: new Date('2026-06-01T09:00:00Z'),
        endAt: new Date('2026-06-01T18:00:00Z'),
        location: 'TestLocation',
        statusCode: 'published',
      },
      select: { id: true },
    });
    certificateA = await prisma.certificate.create({
      data: {
        memberId: memberA.id,
        certTypeCode: 'cpr',
        issuingOrg: 'TestOrg',
        issuedAt: new Date('2026-01-01'),
        certStatusCode: 'pending',
      },
      select: { id: true },
    });

    // 3. type config
    await prisma.attachmentTypeConfig.create({
      data: {
        code: 'member',
        displayName: '队员证件照',
        ownerTable: 'member',
        defaultMaxSizeBytes: 5_242_880,
        defaultMimeWhitelist: ['image/jpeg', 'image/png'],
      },
    });
    await prisma.attachmentTypeConfig.create({
      data: {
        code: 'certificate',
        displayName: '队员资质证件',
        ownerTable: 'certificate',
        defaultMaxSizeBytes: 5_242_880,
        defaultMimeWhitelist: ['image/jpeg', 'application/pdf'],
      },
    });
    await prisma.attachmentTypeConfig.create({
      data: {
        code: 'activity',
        displayName: '活动现场照',
        ownerTable: 'activity',
        defaultMaxSizeBytes: 10_485_760,
        defaultMimeWhitelist: ['image/jpeg'],
      },
    });

    // 4. RBAC seed
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
      create: {
        code: 'member',
        displayName: '队员',
        description: 'USER 内置角色 placeholder',
      },
      select: { id: true },
    });
    const perms = await prisma.permission.findMany({
      where: { code: { in: [...MEMBER_ROLE_PERMISSION_CODES] } },
      select: { id: true },
    });
    for (const perm of perms) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: memberRole.id, permissionId: perm.id } },
        update: {},
        create: { roleId: memberRole.id, permissionId: perm.id },
      });
    }
    for (const u of [selfUser, otherUser]) {
      // 终态 scoped-authz PR6:判权读源 = global RoleBinding,故授予角色写 RoleBinding(USER, GLOBAL, ACTIVE)。
      await prisma.roleBinding.create({
        data: {
          principalType: 'USER',
          principalId: u.id,
          roleId: memberRole.id,
          scopeType: 'GLOBAL',
          status: 'ACTIVE',
        },
      });
    }

    // 5. 登录拿 token
    superAuth = (await loginAs(app, SUPER_USERNAME)).authHeader;
    selfAuth = (await loginAs(app, SELF_USERNAME)).authHeader;
    otherAuth = (await loginAs(app, OTHER_USERNAME)).authHeader;
    await loginAs(app, NO_MEMBER_USERNAME); // 仅创建 token,本 spec 未直接断言无 member user 行为

    // 拿 STORAGE_ENCRYPTION_KEY(.env.test 中配置;若无则使用默认 dummy 32+ 字符)
    const cfg = app.get<{ storage: { encryptionKey: string } }>(appConfig.KEY);
    encryptionKey = cfg.storage.encryptionKey;
    // 测试期保证 encryptionKey 非空(否则 token sign 抛);兜底 dummy
    if (!encryptionKey) {
      encryptionKey = 'test-upload-token-secret-please-32-chars-long-abc';
    }
  });

  afterAll(async () => {
    await app.close();
  });

  const truncateAttachments = async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "attachments" RESTART IDENTITY CASCADE');
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "audit_logs" RESTART IDENTITY CASCADE');
  };

  const buildUploadUrlBody = (
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    ownerType: 'member',
    ownerId: memberA.id,
    originalName: 'photo.jpg',
    mime: 'image/jpeg',
    sizeBytes: 1024,
    ...overrides,
  });

  // ============================================================================
  // upload-url 端点(15 用例)
  // ============================================================================

  describe('POST /upload-url', () => {
    beforeAll(truncateAttachments);

    it('1. 未登录 → 40100', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/upload-url')
        .send(buildUploadUrlBody());
      expect(res.status).toBe(401);
      expect(res.body.code).toBe(BizCode.UNAUTHORIZED.code);
    });

    it('2. USER 无 RBAC member.other → 30100', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/upload-url')
        .set('Authorization', selfAuth)
        .send(buildUploadUrlBody({ ownerId: memberB.id }));
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('3. member self upload-url 成功 → 返 6 字段', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/upload-url')
        .set('Authorization', selfAuth)
        .send(buildUploadUrlBody());
      expect(res.status).toBe(201);
      const d = res.body.data;
      expect(typeof d.key).toBe('string');
      expect(d.key).toMatch(/^attachments\//);
      expect(typeof d.uploadUrl).toBe('string');
      expect(d.uploadMethod).toBe('PUT');
      expect(typeof d.uploadHeaders).toBe('object');
      expect(typeof d.expiresAt).toBe('string');
      expect(typeof d.uploadToken).toBe('string');
      expect(d.uploadToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    });

    it('4. certificate self upload-url 成功', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/upload-url')
        .set('Authorization', selfAuth)
        .send(
          buildUploadUrlBody({
            ownerType: 'certificate',
            ownerId: certificateA.id,
            originalName: 'cert.pdf',
            mime: 'application/pdf',
          }),
        );
      expect(res.status).toBe(201);
      expect(res.body.data.key).toMatch(/\.pdf$/);
    });

    it('5. activity upload-url 成功(粗粒度,无 scope)', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/upload-url')
        .set('Authorization', superAuth)
        .send(
          buildUploadUrlBody({
            ownerType: 'activity',
            ownerId: activity.id,
          }),
        );
      expect(res.status).toBe(201);
    });

    it('6. ownerType 不在 enum → 13010', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/upload-url')
        .set('Authorization', superAuth)
        .send(buildUploadUrlBody({ ownerType: 'unknown-owner' }));
      expectBizError(res, BizCode.ATTACHMENT_OWNER_TYPE_INVALID);
    });

    it('7. ownerType 配置 INACTIVE → 13010', async () => {
      // 先创建 INACTIVE typeConfig(覆盖之前的 ACTIVE 不影响因为 code 唯一);改用一个独立 INACTIVE code
      await prisma.attachmentTypeConfig.create({
        data: {
          code: 'inactivetype',
          displayName: 'Inactive',
          ownerTable: 'member',
          defaultMaxSizeBytes: 5_242_880,
          defaultMimeWhitelist: ['image/jpeg'],
          status: 'INACTIVE',
        },
      });
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/upload-url')
        .set('Authorization', superAuth)
        .send(buildUploadUrlBody({ ownerType: 'inactivetype' }));
      // ownerType enum 兜底先命中(沿 service: assertOwnerTypeAllowed 先 enum 再 config)
      // 'inactivetype' 不在 enum → 13010
      expectBizError(res, BizCode.ATTACHMENT_OWNER_TYPE_INVALID);
    });

    it('8. ownerId 不存在 → 13011', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/upload-url')
        .set('Authorization', superAuth)
        .send(buildUploadUrlBody({ ownerId: 'cl9zzz0000000000000nonexist' }));
      expectBizError(res, BizCode.ATTACHMENT_OWNER_NOT_FOUND);
    });

    it('9. mime 系统级黑名单(application/zip)→ 13033', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/upload-url')
        .set('Authorization', superAuth)
        .send(buildUploadUrlBody({ mime: 'application/zip' }));
      expectBizError(res, BizCode.ATTACHMENT_SYSTEM_MIME_BLOCKED);
    });

    it('10. mime 不在白名单(image/svg+xml 不在 member typeConfig)→ 13012', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/upload-url')
        .set('Authorization', superAuth)
        .send(buildUploadUrlBody({ mime: 'image/svg+xml' }));
      expectBizError(res, BizCode.ATTACHMENT_MIME_NOT_ALLOWED);
    });

    it('11. size 超过 typeConfig.defaultMaxSizeBytes → 13013', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/upload-url')
        .set('Authorization', superAuth)
        .send(buildUploadUrlBody({ sizeBytes: 10_000_000 }));
      expectBizError(res, BizCode.ATTACHMENT_SIZE_EXCEEDED);
    });

    it('12. originalName 含身份证号 → 13015', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/upload-url')
        .set('Authorization', superAuth)
        .send(buildUploadUrlBody({ originalName: '440101199001011234.jpg' }));
      expectBizError(res, BizCode.ATTACHMENT_PII_DETECTED);
    });

    it('13. sizeBytes=0 边界 → 成功', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/upload-url')
        .set('Authorization', selfAuth)
        .send(buildUploadUrlBody({ sizeBytes: 0 }));
      expect(res.status).toBe(201);
    });

    it('14. originalName 极长(255 字符)→ 成功', async () => {
      const longName = 'a'.repeat(251) + '.jpg';
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/upload-url')
        .set('Authorization', selfAuth)
        .send(buildUploadUrlBody({ originalName: longName }));
      expect(res.status).toBe(201);
    });

    it('15. upload-url 不写 audit_logs(查 audit_logs 表空)', async () => {
      await truncateAttachments();
      const beforeCount = await prisma.auditLog.count();
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/upload-url')
        .set('Authorization', selfAuth)
        .send(buildUploadUrlBody());
      expect(res.status).toBe(201);
      const afterCount = await prisma.auditLog.count();
      expect(afterCount).toBe(beforeCount);
    });
  });

  // ============================================================================
  // confirm-upload 端点(13 用例)
  // ============================================================================

  describe('POST /confirm-upload', () => {
    beforeEach(truncateAttachments);

    async function getValidToken(
      authHeader: string = selfAuth,
      overrides: Record<string, unknown> = {},
    ): Promise<{ token: string; key: string; bodyUsed: Record<string, unknown> }> {
      const body = buildUploadUrlBody(overrides);
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/upload-url')
        .set('Authorization', authHeader)
        .send(body);
      expect(res.status).toBe(201);
      return { token: res.body.data.uploadToken, key: res.body.data.key, bodyUsed: body };
    }

    // 工具:把 key 用 LocalProvider 实写到 tmp 目录,模拟 client 已上传完
    async function fakeUploadToLocal(key: string, sizeBytes: number = 1024): Promise<void> {
      const { promises: fs } = await import('node:fs');
      const path = await import('node:path');
      const localCfg = app.get<{ storage: { localRoot: string } }>(appConfig.KEY);
      const filePath = path.resolve(localCfg.storage.localRoot, key);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, Buffer.alloc(sizeBytes));
    }

    it('16. confirm 成功 → attachments 落库', async () => {
      const { token, key } = await getValidToken();
      await fakeUploadToLocal(key, 1024);

      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/confirm-upload')
        .set('Authorization', selfAuth)
        .send({ uploadToken: token });
      expect(res.status).toBe(201);
      expect(res.body.data.key).toBe(key);
      expect(res.body.data.uploadedBy).toBeTruthy();
      const count = await prisma.attachment.count({ where: { key } });
      expect(count).toBe(1);
    });

    it('17. confirm 成功 → audit attachment.upload 落库(含 uploadConfirmedAt + uploadVia:direct)', async () => {
      const { token, key } = await getValidToken();
      await fakeUploadToLocal(key, 1024);

      await request(httpServer(app))
        .post('/api/admin/v1/attachments/confirm-upload')
        .set('Authorization', selfAuth)
        .send({ uploadToken: token })
        .expect(201);

      const auditRow = await prisma.auditLog.findFirst({
        where: { event: 'attachment.upload' },
        orderBy: { createdAt: 'desc' },
      });
      expect(auditRow).not.toBeNull();
      // audit_logs.context 是 JSON 列,内含 { requestId, ip, ua, before?, after?, extra? }
      const context = auditRow!.context as { extra: Record<string, unknown> };
      const extra = context.extra;
      expect(extra.uploadVia).toBe('direct');
      expect(typeof extra.uploadConfirmedAt).toBe('string');
      expect(extra.operation).toBe('upload');
    });

    it('18. confirm 成功 → accessUrl 返字符串(LocalProvider /uploads/)', async () => {
      const { token, key } = await getValidToken();
      await fakeUploadToLocal(key, 1024);

      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/confirm-upload')
        .set('Authorization', selfAuth)
        .send({ uploadToken: token });
      expect(typeof res.body.data.accessUrl).toBe('string');
      expect(res.body.data.accessUrl).toMatch(/^\/uploads\//);
    });

    it('19. confirm token 篡改一字节 → 13001(信息泄漏防御)', async () => {
      const { token, key } = await getValidToken();
      await fakeUploadToLocal(key, 1024);
      const [a, b] = token.split('.');
      const buf = Buffer.from(b, 'base64url');
      buf[0] = buf[0] ^ 0xff;
      const tampered = `${a}.${buf.toString('base64url')}`;

      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/confirm-upload')
        .set('Authorization', selfAuth)
        .send({ uploadToken: tampered });
      expectBizError(res, BizCode.ATTACHMENT_NOT_FOUND);
    });

    it('20. confirm token 格式 malformed(无 `.`)→ 13001', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/confirm-upload')
        .set('Authorization', selfAuth)
        .send({ uploadToken: 'xxxxxxnotvalid' });
      expectBizError(res, BizCode.ATTACHMENT_NOT_FOUND);
    });

    it('21. confirm token 过期 → 13001', async () => {
      // 手工签发一个 exp=now-1 的 token(沿 signUploadToken 工具)
      const expiredToken = signUploadToken(
        {
          key: 'attachments/test/2026/05/15/expired.jpg',
          ownerType: 'member',
          ownerId: memberA.id,
          originalName: 'photo.jpg',
          mime: 'image/jpeg',
          sizeBytes: 1024,
          uploadedByUserId: selfUserId,
          iat: Math.floor(Date.now() / 1000) - 700,
          exp: Math.floor(Date.now() / 1000) - 1,
        },
        encryptionKey,
      );
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/confirm-upload')
        .set('Authorization', selfAuth)
        .send({ uploadToken: expiredToken });
      expectBizError(res, BizCode.ATTACHMENT_NOT_FOUND);
    });

    it('22. confirm uploadedByUserId !== user.id → 30100(A 申 token,B 用)', async () => {
      const { token, key } = await getValidToken(selfAuth);
      await fakeUploadToLocal(key, 1024);
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/confirm-upload')
        .set('Authorization', otherAuth)
        .send({ uploadToken: token });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('23. confirm headObject 不存在(client 没真传)→ 13001', async () => {
      const { token } = await getValidToken();
      // 不调 fakeUploadToLocal → LocalProvider headObject 返 exists=false
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/confirm-upload')
        .set('Authorization', selfAuth)
        .send({ uploadToken: token });
      expectBizError(res, BizCode.ATTACHMENT_NOT_FOUND);
    });

    it('24. confirm size 不一致(实际 > claims.sizeBytes)→ 13013', async () => {
      const { token, key } = await getValidToken(selfAuth, { sizeBytes: 1024 });
      await fakeUploadToLocal(key, 2048); // 实际 2048,与 claims 1024 不一致
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/confirm-upload')
        .set('Authorization', selfAuth)
        .send({ uploadToken: token });
      expectBizError(res, BizCode.ATTACHMENT_SIZE_EXCEEDED);
    });

    it('25. confirm 二次提交(同 token 撞 attachment.key UNIQUE)→ 13001(沿 Q-10-8)', async () => {
      const { token, key } = await getValidToken();
      await fakeUploadToLocal(key, 1024);
      await request(httpServer(app))
        .post('/api/admin/v1/attachments/confirm-upload')
        .set('Authorization', selfAuth)
        .send({ uploadToken: token })
        .expect(201);

      const res2 = await request(httpServer(app))
        .post('/api/admin/v1/attachments/confirm-upload')
        .set('Authorization', selfAuth)
        .send({ uploadToken: token });
      expectBizError(res2, BizCode.ATTACHMENT_NOT_FOUND);
    });

    it('26. confirm 含可选 checksum → 落库 attachment.checksum 非空', async () => {
      const { token, key } = await getValidToken();
      await fakeUploadToLocal(key, 1024);
      const checksum = 'a'.repeat(64);
      await request(httpServer(app))
        .post('/api/admin/v1/attachments/confirm-upload')
        .set('Authorization', selfAuth)
        .send({ uploadToken: token, checksum })
        .expect(201);

      const row = await prisma.attachment.findFirstOrThrow({
        where: { key },
        select: { checksum: true },
      });
      expect(row.checksum).toBe(checksum);
    });

    it('27. confirm 失败不写 audit(token 过期场景)', async () => {
      const beforeCount = await prisma.auditLog.count({ where: { event: 'attachment.upload' } });
      const expiredToken = signUploadToken(
        {
          key: 'attachments/test/2026/05/15/expired2.jpg',
          ownerType: 'member',
          ownerId: memberA.id,
          originalName: 'photo.jpg',
          mime: 'image/jpeg',
          sizeBytes: 1024,
          uploadedByUserId: selfUserId,
          iat: Math.floor(Date.now() / 1000) - 700,
          exp: Math.floor(Date.now() / 1000) - 1,
        },
        encryptionKey,
      );
      await request(httpServer(app))
        .post('/api/admin/v1/attachments/confirm-upload')
        .set('Authorization', selfAuth)
        .send({ uploadToken: expiredToken });
      const afterCount = await prisma.auditLog.count({ where: { event: 'attachment.upload' } });
      expect(afterCount).toBe(beforeCount);
    });

    it('28. confirm 后 accessUrl: string + etag 字段(LocalProvider etag undefined → 落库 null)', async () => {
      const { token, key } = await getValidToken();
      await fakeUploadToLocal(key, 1024);
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/confirm-upload')
        .set('Authorization', selfAuth)
        .send({ uploadToken: token })
        .expect(201);
      expect(typeof res.body.data.accessUrl).toBe('string');
      // etag/checksum 不在出参(沿 PR #76 Q6 v1.0);DB 内 LocalProvider headObject 不返 etag → null
      expect(res.body.data.etag).toBeUndefined();
      const row = await prisma.attachment.findFirstOrThrow({
        where: { key },
        select: { etag: true },
      });
      expect(row.etag).toBeNull();
    });

    it('29. confirm owner 软删窗口(F10 #399):token 签发后 owner 软删 → confirm 落库前复校 → 13011,不落悬空行', async () => {
      // 独立临时 member(不污染 memberA);superAuth 取 token(绕 RBAC),fakeUpload,再软删 owner
      const tmp = await prisma.member.create({
        data: { memberNo: 'UPL-TMP01', displayName: 'MemberTmp' },
        select: { id: true },
      });
      const { token, key } = await getValidToken(superAuth, { ownerId: tmp.id });
      await fakeUploadToLocal(key, 1024);
      await prisma.member.update({ where: { id: tmp.id }, data: { deletedAt: new Date() } });

      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/confirm-upload')
        .set('Authorization', superAuth)
        .send({ uploadToken: token });
      // F10:create()/createUploadUrl() 已 assertOwnerExists,confirm 现对齐 → owner 软删即拒、不落悬空行
      expectBizError(res, BizCode.ATTACHMENT_OWNER_NOT_FOUND);
      expect(await prisma.attachment.count({ where: { key } })).toBe(0);
    });
  });
});
