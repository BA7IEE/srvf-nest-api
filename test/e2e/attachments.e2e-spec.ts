import type { INestApplication } from '@nestjs/common';
import { AttachmentAccessLevel, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { isDerivedAttachmentKey } from '../../src/modules/attachments/attachment-key-format';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { conformingAttachmentKey } from '../helpers/attachment-key';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2.x C-7 attachments 实施 PR #6b(2026-05-15):attachments 主模块 e2e。
// 沿 D7-attachments v1.0 §5.1 / §6 + 用户 PR #6b 14 项 Q 拍板。
//
// 覆盖(用户 Step 2 拍板 e2e 28+ 用例):
// - 7 端点主成功路径(POST / GET list / GET by-owner / GET me/uploaded / GET :id / PATCH :id / DELETE :id)
// - 权限边界:UNAUTHORIZED(40100;无 token)/ RBAC_FORBIDDEN(30100;无权写)/
//   ATTACHMENT_NOT_FOUND(13001;读路径无权混不存在;Q13)
// - SUPER_ADMIN 短路通过(任何 .self/.other 操作)
// - .self / .other ownership 区分(member-owned attachment;currentUser.memberId 匹配则 self,否则 other)
// - certificate ownership:Service 层先查 Certificate.memberId 再判 self/other
// - activity 粗粒度判权(无 self/other 后缀)
// - ownerType 双层校验(13010):非法字符串 / enum 不在 / 配置表不在 / 配置表 INACTIVE
// - ownerId 真实性校验(13011):cuid 不存在 / 已软删
// - mime 白名单(13012):系统级黑名单(application/zip / video/*) / 非配置白名单
// - mime 白名单 hit:typeConfig.defaultMimeWhitelist 命中 / mime_config override 命中
// - size 上限校验(13013):exceeds size_limit_config / exceeds typeConfig.defaultMaxSizeBytes
// - PII 检测(13015):身份证号在 originalName / description / tags 任一字段
// - PATCH 字段白名单(forbidNonWhitelisted 拒绝 key / ownerType / ownerId / uploadedBy / id / 时间戳)
// - PATCH 4 允许字段(description / accessLevel / tags / expireAt)成功路径
// - DELETE 物理删:删后再查 → 13001
// - List total 按可见数量返(Q12 v1.0:不泄露不可见资源数)
// - List filter:ownerType / ownerId / uploadedBy / mime / accessLevel / tags(OR 语义)
// - by-owner ownerType + ownerId 必填校验(BAD_REQUEST)
// - me/uploaded:自动按 uploadedBy = currentUser.id 筛(不走 RBAC)
// - accessUrl 占位:Q14 v1.0 Provider 接通前恒返 null

const SUPER_USERNAME = 'attach-su';
const ADMIN_USERNAME = 'attach-adm';
const SELF_USERNAME = 'attach-self'; // 绑定 memberA 的 USER
const OTHER_USERNAME = 'attach-other'; // 绑定 memberB 的 USER(member 角色)
const NO_MEMBER_USERNAME = 'attach-nomember'; // 未绑定 member 的 USER

// 沿 D7-attachments v1.0 §6.1 + Q1 v1.0:member 角色绑定 9 条权限点。
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

// 20 条 attachment.* permission code(沿 D7-attachments v1.0 §6.1)
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

describe('attachments 主模块', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let superAuth: string;
  let adminAuth: string;
  let selfAuth: string;
  let otherAuth: string;
  let noMemberAuth: string;

  let memberA: { id: string };
  let memberB: { id: string };
  let activity: { id: string };
  let certificateA: { id: string }; // memberA 持有
  let typeConfigMember: { id: string };
  let typeConfigCertificate: { id: string };

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    // ============ 1. 创建 User ============
    await createTestUser(app, { username: SUPER_USERNAME, role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: ADMIN_USERNAME, role: Role.ADMIN });
    const selfUser = await createTestUser(app, { username: SELF_USERNAME });
    const otherUser = await createTestUser(app, { username: OTHER_USERNAME });
    await createTestUser(app, { username: NO_MEMBER_USERNAME });

    // ============ 2. 创建 Organization / Member / 绑定 user / Activity / Certificate ============
    const org = await prisma.organization.create({
      data: { name: 'TestOrg', nodeTypeCode: 'team', sortOrder: 0 },
      select: { id: true },
    });
    memberA = await prisma.member.create({
      data: { memberNo: 'M-A001', displayName: 'MemberA' },
      select: { id: true },
    });
    memberB = await prisma.member.create({
      data: { memberNo: 'M-B001', displayName: 'MemberB' },
      select: { id: true },
    });
    // 绑定 User.memberId
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

    // ============ 3. 创建 type config(member / certificate / activity)+ mime + size ============
    typeConfigMember = await prisma.attachmentTypeConfig.create({
      data: {
        code: 'member',
        displayName: '队员证件照',
        ownerTable: 'member',
        defaultMaxSizeBytes: 5_242_880,
        defaultMimeWhitelist: ['image/jpeg', 'image/png'],
      },
      select: { id: true },
    });
    typeConfigCertificate = await prisma.attachmentTypeConfig.create({
      data: {
        code: 'certificate',
        displayName: '队员资质证件',
        ownerTable: 'certificate',
        defaultMaxSizeBytes: 5_242_880,
        defaultMimeWhitelist: ['image/jpeg', 'application/pdf'],
      },
      select: { id: true },
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

    // ============ 4. 注入 RBAC seed(20 条 permission + member 角色 + 9 条 RolePermission) ============
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
    // 给 selfUser / otherUser 绑定 member 角色;noMemberUser 不绑
    for (const u of [selfUser, otherUser]) {
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId: u.id, roleId: memberRole.id } },
        update: {},
        create: { userId: u.id, roleId: memberRole.id },
      });
    }

    // ============ 5. 登录拿 token ============
    superAuth = (await loginAs(app, SUPER_USERNAME)).authHeader;
    adminAuth = (await loginAs(app, ADMIN_USERNAME)).authHeader;
    selfAuth = (await loginAs(app, SELF_USERNAME)).authHeader;
    otherAuth = (await loginAs(app, OTHER_USERNAME)).authHeader;
    noMemberAuth = (await loginAs(app, NO_MEMBER_USERNAME)).authHeader;
  });

  afterAll(async () => {
    await app.close();
  });

  // 每个 describe 块前清空 attachments 表(保留 type config / member / activity / cert fixtures)
  const truncateAttachments = async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "attachments" RESTART IDENTITY CASCADE');
  };

  // 帮助函数:构造一个合法的 POST body
  const buildBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    key: conformingAttachmentKey(), // F2:服务端派生格式合规 key(原任意 key 已被 13014 校验拒)
    originalName: 'test.jpg',
    mime: 'image/jpeg',
    size: 100_000,
    ownerType: 'member',
    ownerId: memberA.id,
    ...overrides,
  });

  // ============ 权限边界 ============

  describe('权限边界', () => {
    beforeAll(truncateAttachments);

    it('未登录 → 40100 UNAUTHORIZED', async () => {
      const res = await request(httpServer(app)).get('/api/admin/v1/attachments');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('SUPER_ADMIN 短路:可创建 member 类附件(无须 RBAC 权限点)', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', superAuth)
        .send(buildBody());
      expect(res.status).toBe(201);
      expect(res.body.data.ownerType).toBe('member');
      // PR #90:accessUrl 由 storage Provider 生成;e2e 走 LocalProvider(storage_settings DB 空 → Router fallback)
      // → 返 `/uploads/<key>?expires=<ts>` 字符串(沿 PR #88 LocalProvider.generateDownloadUrl)
      expect(typeof res.body.data.accessUrl).toBe('string');
      expect(res.body.data.accessUrl).toMatch(/^\/uploads\//);
    });

    it('ADMIN 无 attachment.upload.*:被拒 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', adminAuth)
        .send(buildBody());
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('member 角色用户上传本人(memberA)附件:.self 命中 → 成功', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', selfAuth)
        .send(buildBody());
      expect(res.status).toBe(201);
    });

    it('member 角色用户上传他人(memberB)附件:无 .other 权限 → 30100', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', selfAuth)
        .send(buildBody({ ownerId: memberB.id }));
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('无 memberId 绑定的 USER 上传本人附件:user.memberId=null,scope 退化为 other → 30100', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', noMemberAuth)
        .send(buildBody({ ownerId: memberA.id }));
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  // ============ POST create ============

  describe('POST /api/admin/v1/attachments', () => {
    beforeEach(truncateAttachments);

    it('member 上传 certificate 类附件:Service 层先查 cert.memberId → .self 命中', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', selfAuth)
        .send(
          buildBody({
            ownerType: 'certificate',
            ownerId: certificateA.id,
            mime: 'application/pdf',
          }),
        );
      expect(res.status).toBe(201);
      expect(res.body.data.ownerType).toBe('certificate');
    });

    it('other(memberB)上传 certificateA(memberA)附件:Service 层 cert.memberId=memberA ≠ user.memberId=B → other → 30100', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', otherAuth)
        .send(
          buildBody({
            ownerType: 'certificate',
            ownerId: certificateA.id,
            mime: 'application/pdf',
          }),
        );
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('activity 类附件:member 角色持 attachment.view.activity 但**无 upload** → 30100', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', selfAuth)
        .send(buildBody({ ownerType: 'activity', ownerId: activity.id }));
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('SUPER_ADMIN 上传 activity 附件:短路通过', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', superAuth)
        .send(buildBody({ ownerType: 'activity', ownerId: activity.id }));
      expect(res.status).toBe(201);
    });

    it('ownerType 非法字符串 → 13010 ATTACHMENT_OWNER_TYPE_INVALID', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', superAuth)
        .send(buildBody({ ownerType: 'nonexistent' }));
      expectBizError(res, BizCode.ATTACHMENT_OWNER_TYPE_INVALID);
    });

    it('ownerType 配置表已软删 → 13010', async () => {
      // 先软删 certificate type config
      await prisma.attachmentTypeConfig.update({
        where: { id: typeConfigCertificate.id },
        data: { deletedAt: new Date() },
      });
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', superAuth)
        .send(buildBody({ ownerType: 'certificate', ownerId: certificateA.id }));
      expectBizError(res, BizCode.ATTACHMENT_OWNER_TYPE_INVALID);
      // 还原
      await prisma.attachmentTypeConfig.update({
        where: { id: typeConfigCertificate.id },
        data: { deletedAt: null },
      });
    });

    it('ownerId 不存在的 cuid → 13011 ATTACHMENT_OWNER_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', superAuth)
        .send(buildBody({ ownerId: 'cl9z3a8b00000abcd1234efgh' }));
      expectBizError(res, BizCode.ATTACHMENT_OWNER_NOT_FOUND);
    });

    it('mime 系统级黑名单 application/zip → 13033', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', superAuth)
        .send(buildBody({ mime: 'application/zip' }));
      expectBizError(res, BizCode.ATTACHMENT_SYSTEM_MIME_BLOCKED);
    });

    it('mime 系统级黑名单通配 video/mp4 → 13033', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', superAuth)
        .send(buildBody({ mime: 'video/mp4' }));
      expectBizError(res, BizCode.ATTACHMENT_SYSTEM_MIME_BLOCKED);
    });

    it('mime 不在 typeConfig.defaultMimeWhitelist → 13012', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', superAuth)
        .send(buildBody({ mime: 'image/gif' }));
      expectBizError(res, BizCode.ATTACHMENT_MIME_NOT_ALLOWED);
    });

    it('mime 命中 attachment_mime_config override(ACTIVE) → 成功', async () => {
      const mimeConfig = await prisma.attachmentMimeConfig.create({
        data: { typeConfigId: typeConfigMember.id, mime: 'image/webp' },
      });
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', superAuth)
        .send(buildBody({ mime: 'image/webp' }));
      expect(res.status).toBe(201);
      await prisma.attachmentMimeConfig.delete({ where: { id: mimeConfig.id } });
    });

    it('size 超过 typeConfig.defaultMaxSizeBytes(5MB) → 13013', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', superAuth)
        .send(buildBody({ size: 10_000_000 }));
      expectBizError(res, BizCode.ATTACHMENT_SIZE_EXCEEDED);
    });

    it('size 超过 size_limit_config override → 13013', async () => {
      const sizeConfig = await prisma.attachmentSizeLimitConfig.create({
        data: { typeConfigId: typeConfigMember.id, maxSizeBytes: 1_000_000 },
      });
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', superAuth)
        .send(buildBody({ size: 2_000_000 }));
      expectBizError(res, BizCode.ATTACHMENT_SIZE_EXCEEDED);
      await prisma.attachmentSizeLimitConfig.delete({ where: { id: sizeConfig.id } });
    });

    it('PII 在 originalName(身份证号 18 位)→ 13015', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', superAuth)
        .send(buildBody({ originalName: '110101199001011234.jpg' }));
      expectBizError(res, BizCode.ATTACHMENT_PII_DETECTED);
    });

    it('PII 在 description → 13015', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', superAuth)
        .send(buildBody({ description: '身份证 11010119900101123X 已校对' }));
      expectBizError(res, BizCode.ATTACHMENT_PII_DETECTED);
    });

    it('PII 在 tags[*] → 13015', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', superAuth)
        .send(buildBody({ tags: ['ok', '110101199001011234'] }));
      expectBizError(res, BizCode.ATTACHMENT_PII_DETECTED);
    });

    it('DTO forbidNonWhitelisted 拒绝 uploadedBy / id → 40000', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', superAuth)
        .send({ ...buildBody(), uploadedBy: 'fake', id: 'fake' });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('成功路径返完整 DTO(含 accessUrl: string 走 LocalProvider;不含 checksum / etag)', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', superAuth)
        .send(
          buildBody({
            description: 'desc',
            tags: ['t1', 't2'],
            accessLevel: AttachmentAccessLevel.INTERNAL,
          }),
        );
      expect(res.status).toBe(201);
      const d = res.body.data;
      expect(d).toMatchObject({
        ownerType: 'member',
        ownerId: memberA.id,
        mime: 'image/jpeg',
        accessLevel: AttachmentAccessLevel.INTERNAL,
        tags: ['t1', 't2'],
        description: 'desc',
      });
      // PR #90:accessUrl 由 storage Provider 生成;e2e 走 LocalProvider → `/uploads/<key>?expires=<ts>`
      expect(typeof d.accessUrl).toBe('string');
      expect(d.accessUrl).toMatch(/^\/uploads\//);
      expect(d.checksum).toBeUndefined();
      expect(d.etag).toBeUndefined();
      expect(d.uploadedBy).toBeTruthy();
      expect(d.originalUploaderName).toBe(SUPER_USERNAME);
    });
  });

  // ============ F2(#399):create key 派生格式校验(13014)============
  // 模式 A create() 此前直收客户端 raw key → `resolveAccessUrl(key)` 可对命名空间外任意
  // COS 对象签 signed URL(IDOR)。走 B:key 必须匹配
  // attachments/<envPrefix>/yyyy/mm/dd/<base64url≥16>.<ext>(envPrefix=test),否则 13014。
  describe('POST /api/admin/v1/attachments — F2 key 派生格式校验', () => {
    it('合规派生 key → 201', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', superAuth)
        .send(buildBody({ key: conformingAttachmentKey() }));
      expect(res.status).toBe(201);
    });

    it.each([
      ['短任意 key(旧 "k1" 式)', 'k1'],
      ['命名空间外(非 attachments/)', 'other/test/2026/05/15/Ab1_cD2-eF3gH4iJ.jpg'],
      ['envPrefix 不符(prod)', 'attachments/prod/2026/05/15/Ab1_cD2-eF3gH4iJ.jpg'],
      ['缺 day 段', 'attachments/test/2026/05/Ab1_cD2-eF3gH4iJ.jpg'],
      ['随机段 <16 字符', 'attachments/test/2026/05/15/short.jpg'],
      ['路径穿越', 'attachments/test/2026/05/15/../../../etc/passwd.jpg'],
    ])('非法 key(%s)→ 13014,且不落库', async (_label, badKey) => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments')
        .set('Authorization', superAuth)
        .send(buildBody({ key: badKey }));
      expectBizError(res, BizCode.ATTACHMENT_KEY_INVALID);
      // 校验早于 tx → 不落库
      const row = await prisma.attachment.findFirst({ where: { key: badKey } });
      expect(row).toBeNull();
    });

    it('模式 B 不受影响:upload-url 返回的服务端派生 key 通过 F2 校验(生成器↔校验器一致)', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/attachments/upload-url')
        .set('Authorization', superAuth)
        .send({
          ownerType: 'member',
          ownerId: memberA.id,
          originalName: 'photo.jpg',
          mime: 'image/jpeg',
          sizeBytes: 1024,
        });
      expect(res.status).toBe(201);
      expect(isDerivedAttachmentKey(res.body.data.key as string, 'test')).toBe(true);
    });
  });

  // ============ GET list ============

  describe('GET /api/admin/v1/attachments', () => {
    let memberAtt: { id: string }; // memberA 附件
    let memberBAtt: { id: string }; // memberB 附件
    let certAtt: { id: string }; // memberA 的 certificate 附件
    let activityAtt: { id: string }; // activity 附件

    beforeAll(async () => {
      await truncateAttachments();
      memberAtt = await prisma.attachment.create({
        data: {
          key: conformingAttachmentKey(),
          originalName: 'a.jpg',
          mime: 'image/jpeg',
          size: 100,
          uploadedBy: (await prisma.user.findFirst({ where: { username: SUPER_USERNAME } }))!.id,
          ownerType: 'member',
          ownerId: memberA.id,
          tags: ['a', 'shared'],
        },
        select: { id: true },
      });
      memberBAtt = await prisma.attachment.create({
        data: {
          key: conformingAttachmentKey(),
          originalName: 'b.jpg',
          mime: 'image/jpeg',
          size: 100,
          uploadedBy: (await prisma.user.findFirst({ where: { username: SUPER_USERNAME } }))!.id,
          ownerType: 'member',
          ownerId: memberB.id,
          tags: ['b'],
        },
        select: { id: true },
      });
      certAtt = await prisma.attachment.create({
        data: {
          key: conformingAttachmentKey(),
          originalName: 'cert.pdf',
          mime: 'application/pdf',
          size: 100,
          uploadedBy: (await prisma.user.findFirst({ where: { username: SUPER_USERNAME } }))!.id,
          ownerType: 'certificate',
          ownerId: certificateA.id,
        },
        select: { id: true },
      });
      activityAtt = await prisma.attachment.create({
        data: {
          key: conformingAttachmentKey(),
          originalName: 'act.jpg',
          mime: 'image/jpeg',
          size: 100,
          uploadedBy: (await prisma.user.findFirst({ where: { username: SUPER_USERNAME } }))!.id,
          ownerType: 'activity',
          ownerId: activity.id,
        },
        select: { id: true },
      });
    });

    it('SUPER_ADMIN 看到全部 4 条', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attachments')
        .set('Authorization', superAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(4);
    });

    it('selfUser(memberA)只看到 .self 命中条 + activity.view 命中 = memberAtt + certAtt + activityAtt(3 条;Q12 v1.0 total 按可见数量)', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attachments')
        .set('Authorization', selfAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(3);
      const ids = (res.body.data.items as Array<{ id: string }>).map((i) => i.id);
      expect(ids).toContain(memberAtt.id);
      expect(ids).toContain(certAtt.id);
      expect(ids).toContain(activityAtt.id);
      expect(ids).not.toContain(memberBAtt.id);
    });

    it('list filter ownerType=activity:SUPER_ADMIN 仅看到 activityAtt', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attachments?ownerType=activity')
        .set('Authorization', superAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].id).toBe(activityAtt.id);
    });

    it('list filter mime=application/pdf:SUPER_ADMIN 仅看到 certAtt', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attachments?mime=application/pdf')
        .set('Authorization', superAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].id).toBe(certAtt.id);
    });

    it('list filter tags=shared:OR 语义命中 memberAtt', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attachments?tags=shared')
        .set('Authorization', superAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
    });

    it('list 分页 page=1&pageSize=2', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attachments?page=1&pageSize=2')
        .set('Authorization', superAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBe(2);
      expect(res.body.data.total).toBe(4);
    });
  });

  // ============ GET by-owner ============

  describe('GET /api/admin/v1/attachments/by-owner', () => {
    beforeAll(async () => {
      await truncateAttachments();
      // 给 memberA 创 2 条;memberB 创 1 条
      const superId = (await prisma.user.findFirst({ where: { username: SUPER_USERNAME } }))!.id;
      await prisma.attachment.createMany({
        data: [
          {
            key: conformingAttachmentKey(),
            originalName: 'a.jpg',
            mime: 'image/jpeg',
            size: 100,
            uploadedBy: superId,
            ownerType: 'member',
            ownerId: memberA.id,
          },
          {
            key: conformingAttachmentKey(),
            originalName: 'a2.jpg',
            mime: 'image/jpeg',
            size: 100,
            uploadedBy: superId,
            ownerType: 'member',
            ownerId: memberA.id,
          },
          {
            key: conformingAttachmentKey(),
            originalName: 'b.jpg',
            mime: 'image/jpeg',
            size: 100,
            uploadedBy: superId,
            ownerType: 'member',
            ownerId: memberB.id,
          },
        ],
      });
    });

    it('SUPER_ADMIN 查 memberA → 2 条', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/attachments/by-owner?ownerType=member&ownerId=${memberA.id}`)
        .set('Authorization', superAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(2);
    });

    it('selfUser 查 memberA → .self 命中 → 2 条', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/attachments/by-owner?ownerType=member&ownerId=${memberA.id}`)
        .set('Authorization', selfAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(2);
    });

    it('selfUser 查 memberB → .other 缺失 → total=0(Q12 v1.0)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/attachments/by-owner?ownerType=member&ownerId=${memberB.id}`)
        .set('Authorization', selfAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(0);
    });

    it('缺 ownerType → BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/attachments/by-owner?ownerId=${memberA.id}`)
        .set('Authorization', superAuth);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('ownerId 不存在 → 13011', async () => {
      const res = await request(httpServer(app))
        .get(
          '/api/admin/v1/attachments/by-owner?ownerType=member&ownerId=cl9z3a8b00000abcd1234efgh',
        )
        .set('Authorization', superAuth);
      expectBizError(res, BizCode.ATTACHMENT_OWNER_NOT_FOUND);
    });

    it('ownerType 非法 → 13010', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/attachments/by-owner?ownerType=invalid&ownerId=${memberA.id}`)
        .set('Authorization', superAuth);
      expectBizError(res, BizCode.ATTACHMENT_OWNER_TYPE_INVALID);
    });
  });

  // Route B Phase 4e(2026-06-01):legacy GET /api/admin/v1/attachments/me/uploaded(orphan)已删除
  // (无生产消费者,未建 app/v1 替代;`listMyUploaded` service 保留为未来 app/v1/my/attachments
  // building block)。沿 docs/api-surface-migration-plan.md §3.3。

  // ============ GET /:id ============

  describe('GET /api/admin/v1/attachments/:id', () => {
    let memberAtt: { id: string };
    let memberBAtt: { id: string };

    beforeAll(async () => {
      await truncateAttachments();
      const superId = (await prisma.user.findFirst({ where: { username: SUPER_USERNAME } }))!.id;
      memberAtt = await prisma.attachment.create({
        data: {
          key: conformingAttachmentKey(),
          originalName: 'a.jpg',
          mime: 'image/jpeg',
          size: 100,
          uploadedBy: superId,
          ownerType: 'member',
          ownerId: memberA.id,
        },
        select: { id: true },
      });
      memberBAtt = await prisma.attachment.create({
        data: {
          key: conformingAttachmentKey(),
          originalName: 'b.jpg',
          mime: 'image/jpeg',
          size: 100,
          uploadedBy: superId,
          ownerType: 'member',
          ownerId: memberB.id,
        },
        select: { id: true },
      });
    });

    it('SUPER_ADMIN 查任意附件 → 成功', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/attachments/${memberAtt.id}`)
        .set('Authorization', superAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(memberAtt.id);
    });

    it('selfUser 查本人附件 → 成功', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/attachments/${memberAtt.id}`)
        .set('Authorization', selfAuth);
      expect(res.status).toBe(200);
    });

    it('selfUser 查他人附件 → Q13 信息泄漏防御:返 13001', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/attachments/${memberBAtt.id}`)
        .set('Authorization', selfAuth);
      expectBizError(res, BizCode.ATTACHMENT_NOT_FOUND);
    });

    it('id 不存在 → 13001', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attachments/cl9z3a8b00000abcd1234efgh')
        .set('Authorization', superAuth);
      expectBizError(res, BizCode.ATTACHMENT_NOT_FOUND);
    });
  });

  // ============ PATCH /:id ============

  describe('PATCH /api/admin/v1/attachments/:id', () => {
    let memberAtt: { id: string };
    let memberBAtt: { id: string };

    beforeEach(async () => {
      await truncateAttachments();
      const superId = (await prisma.user.findFirst({ where: { username: SUPER_USERNAME } }))!.id;
      memberAtt = await prisma.attachment.create({
        data: {
          key: conformingAttachmentKey(),
          originalName: 'a.jpg',
          mime: 'image/jpeg',
          size: 100,
          uploadedBy: superId,
          ownerType: 'member',
          ownerId: memberA.id,
        },
        select: { id: true },
      });
      memberBAtt = await prisma.attachment.create({
        data: {
          key: conformingAttachmentKey(),
          originalName: 'b.jpg',
          mime: 'image/jpeg',
          size: 100,
          uploadedBy: superId,
          ownerType: 'member',
          ownerId: memberB.id,
        },
        select: { id: true },
      });
    });

    it('selfUser 更新本人附件(description / tags / accessLevel / expireAt)→ 成功', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attachments/${memberAtt.id}`)
        .set('Authorization', selfAuth)
        .send({
          description: 'updated',
          tags: ['t1'],
          accessLevel: AttachmentAccessLevel.PUBLIC,
          expireAt: '2027-01-01T00:00:00.000Z',
        });
      expect(res.status).toBe(200);
      expect(res.body.data.description).toBe('updated');
      expect(res.body.data.tags).toEqual(['t1']);
      expect(res.body.data.accessLevel).toBe(AttachmentAccessLevel.PUBLIC);
    });

    it('selfUser 更新他人附件 → 30100 RBAC_FORBIDDEN(写路径)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attachments/${memberBAtt.id}`)
        .set('Authorization', selfAuth)
        .send({ description: 'hack' });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('id 不存在 → 13001', async () => {
      const res = await request(httpServer(app))
        .patch('/api/admin/v1/attachments/cl9z3a8b00000abcd1234efgh')
        .set('Authorization', superAuth)
        .send({ description: 'x' });
      expectBizError(res, BizCode.ATTACHMENT_NOT_FOUND);
    });

    it('PATCH 拒绝 key / ownerType / ownerId / uploadedBy → 40000', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attachments/${memberAtt.id}`)
        .set('Authorization', superAuth)
        .send({ key: conformingAttachmentKey(), ownerType: 'activity' });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('PATCH description 命中身份证号 → 13015', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attachments/${memberAtt.id}`)
        .set('Authorization', superAuth)
        .send({ description: '110101199001011234' });
      expectBizError(res, BizCode.ATTACHMENT_PII_DETECTED);
    });
  });

  // ============ DELETE /:id ============

  describe('DELETE /api/admin/v1/attachments/:id', () => {
    let memberAtt: { id: string };
    let memberBAtt: { id: string };

    beforeEach(async () => {
      await truncateAttachments();
      const superId = (await prisma.user.findFirst({ where: { username: SUPER_USERNAME } }))!.id;
      memberAtt = await prisma.attachment.create({
        data: {
          key: conformingAttachmentKey(),
          originalName: 'a.jpg',
          mime: 'image/jpeg',
          size: 100,
          uploadedBy: superId,
          ownerType: 'member',
          ownerId: memberA.id,
        },
        select: { id: true },
      });
      memberBAtt = await prisma.attachment.create({
        data: {
          key: conformingAttachmentKey(),
          originalName: 'b.jpg',
          mime: 'image/jpeg',
          size: 100,
          uploadedBy: superId,
          ownerType: 'member',
          ownerId: memberB.id,
        },
        select: { id: true },
      });
    });

    it('selfUser 删本人附件 → 成功(物理删;Q11 v1.0)', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/attachments/${memberAtt.id}`)
        .set('Authorization', selfAuth);
      expect(res.status).toBe(200);
      // 物理删:再次 GET 返 13001
      const get = await request(httpServer(app))
        .get(`/api/admin/v1/attachments/${memberAtt.id}`)
        .set('Authorization', superAuth);
      expectBizError(get, BizCode.ATTACHMENT_NOT_FOUND);
    });

    it('selfUser 删他人附件 → 30100', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/attachments/${memberBAtt.id}`)
        .set('Authorization', selfAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('id 不存在 → 13001', async () => {
      const res = await request(httpServer(app))
        .delete('/api/admin/v1/attachments/cl9z3a8b00000abcd1234efgh')
        .set('Authorization', superAuth);
      expectBizError(res, BizCode.ATTACHMENT_NOT_FOUND);
    });

    it('未登录 → 40100', async () => {
      const res = await request(httpServer(app)).delete(
        `/api/admin/v1/attachments/${memberAtt.id}`,
      );
      expectBizError(res, BizCode.UNAUTHORIZED);
    });
  });
});
