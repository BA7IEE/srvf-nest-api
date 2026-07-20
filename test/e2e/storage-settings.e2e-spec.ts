import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2.x C-7.5 实施 PR #11:Storage Settings admin e2e(沿评审 §6.5 / §6.6 + Q-11 拍板)
// 30+ 用例;凭证不回显 / 加密落库 / credentialStatus 三态(missing / configured / invalid)/
// upsert / TTL 边界 / forbidNonWhitelisted 拒凭证字段 / live-read 生效 / IV 随机性
//
// P0-F PR-2B(2026-05-18):入口切到 service 层 rbac.can();失败统一 RBAC_FORBIDDEN(30100)。
// D2=A 凭证收紧:`storage-setting.reset.credentials` 不绑 ops-admin;ADMIN+ops-admin 调
// reset-credentials → 30100;仅 SUPER_ADMIN 短路通过(沿评审稿 §5.2 / §9.3 D2 特殊用例)。
// `adminAuth` 在 beforeAll 全局 grant ops-admin(可调 read / update;不可调 reset-credentials)。

const SUPER_USERNAME = 'st-su';
const ADMIN_USERNAME = 'st-adm';
const ADMIN_DEFAULT_USERNAME = 'st-adm-default';
const USER_USERNAME = 'st-user';

const SECRET_ID_PLAIN = 'AKIDtestsecretid000000000000000000ABC';
const SECRET_KEY_PLAIN = 'plain-secret-key-do-not-leak-1234567890ABC';

describe('storage-settings admin', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAuth: string;
  let adminAuth: string;
  let adminDefaultAuth: string;
  let userAuth: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: SUPER_USERNAME, role: Role.SUPER_ADMIN });
    const admin = await createTestUser(app, { username: ADMIN_USERNAME, role: Role.ADMIN });
    await createTestUser(app, { username: ADMIN_DEFAULT_USERNAME, role: Role.ADMIN });
    await createTestUser(app, { username: USER_USERNAME }); // role=USER 默认

    superAuth = (await loginAs(app, SUPER_USERNAME)).authHeader;
    adminAuth = (await loginAs(app, ADMIN_USERNAME)).authHeader;
    adminDefaultAuth = (await loginAs(app, ADMIN_DEFAULT_USERNAME)).authHeader;
    userAuth = (await loginAs(app, USER_USERNAME)).authHeader;

    // P0-F PR-2B:seed 48 条 RBAC + ops-admin;给 st-adm 全局 grant ops-admin
    // (D2=A:ops-admin **不**绑 storage-setting.reset.credentials;仅 SA 短路通过)
    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    await grantOpsAdminToUser(app, admin.id, seed.opsAdminRoleId);
  });

  afterAll(async () => {
    await app.close();
  });

  // 每个 describe 块前清空 storage_settings 表
  const truncate = async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "storage_settings" RESTART IDENTITY CASCADE');
  };

  // 工具:全文 grep response body 不含 secret 明文 / 密文(沿 §6.6.2)
  function assertNoSecret(body: unknown): void {
    const json = JSON.stringify(body);
    expect(json).not.toContain(SECRET_ID_PLAIN);
    expect(json).not.toContain(SECRET_KEY_PLAIN);
    expect(json).not.toContain('secretIdEncrypted');
    expect(json).not.toContain('secretKeyEncrypted');
    expect(json).not.toMatch(/"secretId"\s*:/);
    expect(json).not.toMatch(/"secretKey"\s*:/);
    expect(json).not.toMatch(/"credentials"\s*:/);
  }

  // ============ GET ============

  describe('GET /api/system/v1/storage-settings', () => {
    beforeEach(truncate);

    it('1. 未登录 → 401 (UNAUTHORIZED=40100)', async () => {
      const res = await request(httpServer(app)).get('/api/system/v1/storage-settings');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('2. USER → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/storage-settings')
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('2b. ADMIN 默认无 ops-admin → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/storage-settings')
        .set('Authorization', adminDefaultAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('3. ADMIN+ops-admin GET singleton row 不存在 → data=null', async () => {
      const res = await request(httpServer(app))
        .get('/api/system/v1/storage-settings')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data).toBeNull();
    });
  });

  // ============ PATCH ============

  describe('PATCH /api/system/v1/storage-settings', () => {
    beforeEach(truncate);

    it('4. 未登录 → 401 (UNAUTHORIZED=40100)', async () => {
      const res = await request(httpServer(app))
        .patch('/api/system/v1/storage-settings')
        .send({ enabled: true });
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('5. USER → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .patch('/api/system/v1/storage-settings')
        .set('Authorization', userAuth)
        .send({ enabled: true });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('5b. ADMIN 默认无 ops-admin PATCH → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .patch('/api/system/v1/storage-settings')
        .set('Authorization', adminDefaultAuth)
        .send({ enabled: true });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('6. 空表并发 PATCH 均成功且只创建一个 singleton row(providerType 缺省 LOCAL)', async () => {
      const sendPatch = () =>
        request(httpServer(app))
          .patch('/api/system/v1/storage-settings')
          .set('Authorization', adminAuth)
          .send({ enabled: true, bucket: 'srvf-test' });
      const [first, second] = await Promise.all([sendPatch(), sendPatch()]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const d = first.body.data;
      expect(d.providerType).toBe('LOCAL');
      expect(d.enabled).toBe(true);
      expect(d.bucket).toBe('srvf-test');
      expect(d.credentialStatus).toBe('missing');
      expect(d.credentialConfigured).toBe(false);
      assertNoSecret(first.body);
      assertNoSecret(second.body);
      expect(await prisma.storageSettings.count()).toBe(1);
    });

    it('7. PATCH 更新 enabled / bucket / region / envPrefix', async () => {
      // 先 upsert 一条
      await request(httpServer(app))
        .patch('/api/system/v1/storage-settings')
        .set('Authorization', adminAuth)
        .send({ enabled: false });
      const res = await request(httpServer(app))
        .patch('/api/system/v1/storage-settings')
        .set('Authorization', adminAuth)
        .send({
          enabled: true,
          bucket: 'srvf-bucket',
          region: 'ap-shanghai',
          envPrefix: 'prod',
        });
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.enabled).toBe(true);
      expect(d.bucket).toBe('srvf-bucket');
      expect(d.region).toBe('ap-shanghai');
      expect(d.envPrefix).toBe('prod');
    });

    it('8. PATCH TTL 下界(60 / 60)+ 上界(3600 / 1800)成功', async () => {
      const res1 = await request(httpServer(app))
        .patch('/api/system/v1/storage-settings')
        .set('Authorization', adminAuth)
        .send({ uploadUrlTtlSeconds: 60, downloadUrlTtlSeconds: 60 });
      expect(res1.status).toBe(200);
      expect(res1.body.data.uploadUrlTtlSeconds).toBe(60);
      expect(res1.body.data.downloadUrlTtlSeconds).toBe(60);

      const res2 = await request(httpServer(app))
        .patch('/api/system/v1/storage-settings')
        .set('Authorization', adminAuth)
        .send({ uploadUrlTtlSeconds: 3600, downloadUrlTtlSeconds: 1800 });
      expect(res2.status).toBe(200);
      expect(res2.body.data.uploadUrlTtlSeconds).toBe(3600);
      expect(res2.body.data.downloadUrlTtlSeconds).toBe(1800);
    });

    it('9. PATCH TTL 越界 → 40000', async () => {
      // upload TTL = 59(< 60)
      const r1 = await request(httpServer(app))
        .patch('/api/system/v1/storage-settings')
        .set('Authorization', adminAuth)
        .send({ uploadUrlTtlSeconds: 59 });
      expect(r1.status).toBe(400);
      // upload TTL = 3601(> 3600)
      const r2 = await request(httpServer(app))
        .patch('/api/system/v1/storage-settings')
        .set('Authorization', adminAuth)
        .send({ uploadUrlTtlSeconds: 3601 });
      expect(r2.status).toBe(400);
      // download TTL = 1801(> 1800)
      const r3 = await request(httpServer(app))
        .patch('/api/system/v1/storage-settings')
        .set('Authorization', adminAuth)
        .send({ downloadUrlTtlSeconds: 1801 });
      expect(r3.status).toBe(400);
    });

    it('10. PATCH 拒绝 secretId(forbidNonWhitelisted)', async () => {
      const res = await request(httpServer(app))
        .patch('/api/system/v1/storage-settings')
        .set('Authorization', adminAuth)
        .send({ enabled: true, secretId: SECRET_ID_PLAIN });
      expect(res.status).toBe(400);
    });

    it('11. PATCH 拒绝 secretKey', async () => {
      const res = await request(httpServer(app))
        .patch('/api/system/v1/storage-settings')
        .set('Authorization', adminAuth)
        .send({ enabled: true, secretKey: SECRET_KEY_PLAIN });
      expect(res.status).toBe(400);
    });

    it('12. PATCH 拒绝 secretIdEncrypted', async () => {
      const res = await request(httpServer(app))
        .patch('/api/system/v1/storage-settings')
        .set('Authorization', adminAuth)
        .send({ enabled: true, secretIdEncrypted: 'fake-cipher' });
      expect(res.status).toBe(400);
    });

    it('13. PATCH 拒绝 secretKeyEncrypted', async () => {
      const res = await request(httpServer(app))
        .patch('/api/system/v1/storage-settings')
        .set('Authorization', adminAuth)
        .send({ enabled: true, secretKeyEncrypted: 'fake-cipher' });
      expect(res.status).toBe(400);
    });

    it('14. PATCH maxObjectSizeBytes="123456" 成功;出参为 string', async () => {
      const res = await request(httpServer(app))
        .patch('/api/system/v1/storage-settings')
        .set('Authorization', adminAuth)
        .send({ maxObjectSizeBytes: '123456' });
      expect(res.status).toBe(200);
      expect(res.body.data.maxObjectSizeBytes).toBe('123456');
      expect(typeof res.body.data.maxObjectSizeBytes).toBe('string');
    });

    it('15. PATCH maxObjectSizeBytes 非数字 → 40000', async () => {
      const res = await request(httpServer(app))
        .patch('/api/system/v1/storage-settings')
        .set('Authorization', adminAuth)
        .send({ maxObjectSizeBytes: 'not-a-number' });
      expect(res.status).toBe(400);
    });

    it('16. PATCH allowedMimePolicyMode=OVERRIDE 成功', async () => {
      const res = await request(httpServer(app))
        .patch('/api/system/v1/storage-settings')
        .set('Authorization', adminAuth)
        .send({ allowedMimePolicyMode: 'OVERRIDE' });
      expect(res.status).toBe(200);
      expect(res.body.data.allowedMimePolicyMode).toBe('OVERRIDE');
    });
  });

  // ============ POST /reset-credentials ============

  describe('POST /api/system/v1/storage-settings/reset-credentials', () => {
    beforeEach(truncate);

    it('17. 未登录 → 401 (UNAUTHORIZED=40100)', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/storage-settings/reset-credentials')
        .send({ secretId: SECRET_ID_PLAIN, secretKey: SECRET_KEY_PLAIN });
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('18. USER → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/storage-settings/reset-credentials')
        .set('Authorization', userAuth)
        .send({ secretId: SECRET_ID_PLAIN, secretKey: SECRET_KEY_PLAIN });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    // P0-F PR-2B D2=A 凭证收紧验证(沿评审稿 §9.3):
    // `storage-setting.reset.credentials` 不绑 ops-admin;
    // ADMIN+ops-admin(adminAuth)调 reset-credentials → 30100;仅 SUPER_ADMIN 短路通过
    it('18a. D2=A:ADMIN+ops-admin 调 reset-credentials → 30100 RBAC_FORBIDDEN(凭证 SA-only)', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/storage-settings/reset-credentials')
        .set('Authorization', adminAuth) // 持 ops-admin,但 reset.credentials 不绑给 ops-admin
        .send({ secretId: SECRET_ID_PLAIN, secretKey: SECRET_KEY_PLAIN });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('18b. D2=A:ADMIN 默认无 ops-admin 调 reset-credentials → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/storage-settings/reset-credentials')
        .set('Authorization', adminDefaultAuth)
        .send({ secretId: SECRET_ID_PLAIN, secretKey: SECRET_KEY_PLAIN });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('19. SUPER_ADMIN reset 不存在时 upsert 创建 row + providerType=COS(D2=A 仅 SA 通过)', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/storage-settings/reset-credentials')
        .set('Authorization', superAuth)
        .send({ secretId: SECRET_ID_PLAIN, secretKey: SECRET_KEY_PLAIN });
      expect(res.status).toBe(201);
      const d = res.body.data;
      expect(d.providerType).toBe('COS');
      expect(d.credentialStatus).toBe('configured');
      expect(d.credentialConfigured).toBe(true);
      assertNoSecret(res.body);
    });

    it('20. SUPER_ADMIN reset 成功后 credentialStatus=configured', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/storage-settings/reset-credentials')
        .set('Authorization', superAuth)
        .send({ secretId: SECRET_ID_PLAIN, secretKey: SECRET_KEY_PLAIN });
      expect(res.body.data.credentialStatus).toBe('configured');
    });

    it('21. SUPER_ADMIN reset 成功后 credentialConfigured=true', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/storage-settings/reset-credentials')
        .set('Authorization', superAuth)
        .send({ secretId: SECRET_ID_PLAIN, secretKey: SECRET_KEY_PLAIN });
      expect(res.body.data.credentialConfigured).toBe(true);
    });

    it('22. SUPER_ADMIN reset 响应不含 secretId / secretKey / Encrypted / credentials', async () => {
      const res = await request(httpServer(app))
        .post('/api/system/v1/storage-settings/reset-credentials')
        .set('Authorization', superAuth)
        .send({ secretId: SECRET_ID_PLAIN, secretKey: SECRET_KEY_PLAIN });
      assertNoSecret(res.body);
    });

    it('23. SUPER_ADMIN reset 后 DB 中 secretIdEncrypted / secretKeyEncrypted 非 null', async () => {
      await request(httpServer(app))
        .post('/api/system/v1/storage-settings/reset-credentials')
        .set('Authorization', superAuth)
        .send({ secretId: SECRET_ID_PLAIN, secretKey: SECRET_KEY_PLAIN });
      const row = await prisma.storageSettings.findFirstOrThrow({
        select: { secretIdEncrypted: true, secretKeyEncrypted: true },
      });
      expect(row.secretIdEncrypted).not.toBeNull();
      expect(row.secretKeyEncrypted).not.toBeNull();
    });

    it('24. SUPER_ADMIN reset 后 DB 密文不等于明文', async () => {
      await request(httpServer(app))
        .post('/api/system/v1/storage-settings/reset-credentials')
        .set('Authorization', superAuth)
        .send({ secretId: SECRET_ID_PLAIN, secretKey: SECRET_KEY_PLAIN });
      const row = await prisma.storageSettings.findFirstOrThrow({
        select: { secretIdEncrypted: true, secretKeyEncrypted: true },
      });
      expect(row.secretIdEncrypted).not.toBe(SECRET_ID_PLAIN);
      expect(row.secretKeyEncrypted).not.toBe(SECRET_KEY_PLAIN);
    });

    it('25. SUPER_ADMIN reset 两次密文不同(IV 随机性)', async () => {
      await request(httpServer(app))
        .post('/api/system/v1/storage-settings/reset-credentials')
        .set('Authorization', superAuth)
        .send({ secretId: SECRET_ID_PLAIN, secretKey: SECRET_KEY_PLAIN });
      const row1 = await prisma.storageSettings.findFirstOrThrow({
        select: { id: true, secretIdEncrypted: true },
      });
      await request(httpServer(app))
        .post('/api/system/v1/storage-settings/reset-credentials')
        .set('Authorization', superAuth)
        .send({ secretId: SECRET_ID_PLAIN, secretKey: SECRET_KEY_PLAIN });
      const row2 = await prisma.storageSettings.findFirstOrThrow({
        where: { id: row1.id },
        select: { secretIdEncrypted: true },
      });
      expect(row2.secretIdEncrypted).not.toBe(row1.secretIdEncrypted);
    });
  });

  // ============ 边界 / 集成 ============

  describe('集成 / credentialStatus 三态 / invalidate', () => {
    beforeEach(truncate);

    it('26. GET reset 后 credentialStatus=configured', async () => {
      await request(httpServer(app))
        .post('/api/system/v1/storage-settings/reset-credentials')
        .set('Authorization', superAuth)
        .send({ secretId: SECRET_ID_PLAIN, secretKey: SECRET_KEY_PLAIN });
      const res = await request(httpServer(app))
        .get('/api/system/v1/storage-settings')
        .set('Authorization', adminAuth);
      expect(res.body.data.credentialStatus).toBe('configured');
      assertNoSecret(res.body);
    });

    it('27. 手工写坏密文后 GET credentialStatus=invalid', async () => {
      // 先 reset 创建一条配置(D2=A:reset 走 SA)
      await request(httpServer(app))
        .post('/api/system/v1/storage-settings/reset-credentials')
        .set('Authorization', superAuth)
        .send({ secretId: SECRET_ID_PLAIN, secretKey: SECRET_KEY_PLAIN });
      // 手工写入无效 base64(无法解密)→ credentialStatus=invalid；下一读取直见 DB 当前值
      await prisma.storageSettings.updateMany({
        data: { secretIdEncrypted: 'INVALID_CIPHER_xxxx', secretKeyEncrypted: 'INVALID_xxxx' },
      });
      const res = await request(httpServer(app))
        .get('/api/system/v1/storage-settings')
        .set('Authorization', adminAuth);
      expect(res.body.data.credentialStatus).toBe('invalid');
      assertNoSecret(res.body);
    });

    it('28. PATCH 提交后下一次 GET 直接返回新值', async () => {
      // 第一次 PATCH 设置 bucket=v1
      await request(httpServer(app))
        .patch('/api/system/v1/storage-settings')
        .set('Authorization', adminAuth)
        .send({ bucket: 'v1' });
      const res1 = await request(httpServer(app))
        .get('/api/system/v1/storage-settings')
        .set('Authorization', adminAuth);
      expect(res1.body.data.bucket).toBe('v1');

      // PATCH 改 bucket=v2;invalidate cache → 下一次 GET 拿到 v2
      await request(httpServer(app))
        .patch('/api/system/v1/storage-settings')
        .set('Authorization', adminAuth)
        .send({ bucket: 'v2' });
      const res2 = await request(httpServer(app))
        .get('/api/system/v1/storage-settings')
        .set('Authorization', adminAuth);
      expect(res2.body.data.bucket).toBe('v2');
    });

    it('29. reset 后 PATCH bucket 不影响 credentialStatus', async () => {
      // D2=A:reset 走 SA;PATCH 走 ADMIN+ops-admin
      await request(httpServer(app))
        .post('/api/system/v1/storage-settings/reset-credentials')
        .set('Authorization', superAuth)
        .send({ secretId: SECRET_ID_PLAIN, secretKey: SECRET_KEY_PLAIN });
      const res = await request(httpServer(app))
        .patch('/api/system/v1/storage-settings')
        .set('Authorization', adminAuth)
        .send({ bucket: 'new-bucket-after-reset' });
      expect(res.body.data.bucket).toBe('new-bucket-after-reset');
      expect(res.body.data.credentialStatus).toBe('configured');
      expect(res.body.data.credentialConfigured).toBe(true);
      assertNoSecret(res.body);
    });

    it('30. SUPER_ADMIN 也可访问全部接口(GET / PATCH / reset)', async () => {
      const r1 = await request(httpServer(app))
        .get('/api/system/v1/storage-settings')
        .set('Authorization', superAuth);
      expect(r1.status).toBe(200);
      const r2 = await request(httpServer(app))
        .patch('/api/system/v1/storage-settings')
        .set('Authorization', superAuth)
        .send({ bucket: 'super-bucket' });
      expect(r2.status).toBe(200);
      const r3 = await request(httpServer(app))
        .post('/api/system/v1/storage-settings/reset-credentials')
        .set('Authorization', superAuth)
        .send({ secretId: SECRET_ID_PLAIN, secretKey: SECRET_KEY_PLAIN });
      expect(r3.status).toBe(201);
      assertNoSecret(r3.body);
    });
  });
});
