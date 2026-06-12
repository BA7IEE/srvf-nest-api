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

// 微信小程序登录 T2 e2e:wechat-settings 三端点(冻结评审稿
// docs/archive/reviews/wechat-mini-login-review.md §3.2 ①-③ / §10;镜像 sms-settings e2e 范式)。
//
// 覆盖:RBAC 正反(R 模式 30100;reset 仅 SA)/ upsert 语义 / 凭证永不回显(密文也不回显)
// / credentialStatus 三态(missing → configured → invalid)。
// production-like 禁 DEV_STUB 的写入校验在 test env 不可达(isProductionLike=false),
// 该分支由 wechat-settings.service 实现 + smoke 环境兜底,不在本组造假环境(沿 sms 同款声明)。
//
// 权限码:沿 rbac.fixture 范式,spec 自行 seed 本模块 3 条 wechat-setting 码并按评审稿 §3.4 绑定
// (reset.credentials 不绑 ops-admin;fixture 共享清单不动,镜像 sms-settings spec 自带码范式)。

const SETTINGS_PATH = '/api/system/v1/wechat-settings';
const RESET_PATH = '/api/system/v1/wechat-settings/reset-credentials';

const WECHAT_PERMISSIONS = [
  {
    code: 'wechat-setting.read.singleton',
    module: 'wechat-setting',
    action: 'read',
    resourceType: 'singleton',
  },
  {
    code: 'wechat-setting.update.singleton',
    module: 'wechat-setting',
    action: 'update',
    resourceType: 'singleton',
  },
  {
    code: 'wechat-setting.reset.credentials',
    module: 'wechat-setting',
    action: 'reset',
    resourceType: 'credentials',
  },
] as const;

// 评审稿 §3.4:reset.credentials 不绑 ops-admin
async function seedWechatPermissions(app: INestApplication, opsAdminRoleId: string): Promise<void> {
  const prisma = app.get(PrismaService);
  for (const p of WECHAT_PERMISSIONS) {
    const perm = await prisma.permission.upsert({
      where: { code: p.code },
      update: {},
      create: { code: p.code, module: p.module, action: p.action, resourceType: p.resourceType },
      select: { id: true, code: true },
    });
    if (perm.code !== 'wechat-setting.reset.credentials') {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: opsAdminRoleId, permissionId: perm.id } },
        update: {},
        create: { roleId: opsAdminRoleId, permissionId: perm.id },
      });
    }
  }
}

describe('WeChat Settings(T2 e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let saHeader: string;
  let opsHeader: string;
  let plainAdminHeader: string;
  let userHeader: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);

    const { opsAdminRoleId } = await seedRbacPermissionsAndOpsAdmin(app);
    await seedWechatPermissions(app, opsAdminRoleId);

    await createTestUser(app, { username: 'wx_set_sa', role: Role.SUPER_ADMIN });
    const ops = await createTestUser(app, { username: 'wx_set_ops', role: Role.ADMIN });
    await grantOpsAdminToUser(app, ops.id, opsAdminRoleId);
    await createTestUser(app, { username: 'wx_set_admin', role: Role.ADMIN });
    await createTestUser(app, { username: 'wx_set_user', role: Role.USER });

    saHeader = (await loginAs(app, 'wx_set_sa')).authHeader;
    opsHeader = (await loginAs(app, 'wx_set_ops')).authHeader;
    plainAdminHeader = (await loginAs(app, 'wx_set_admin')).authHeader;
    userHeader = (await loginAs(app, 'wx_set_user')).authHeader;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('鉴权边界(R 模式)', () => {
    it('GET 无 token → 40100', async () => {
      const res = await request(httpServer(app)).get(SETTINGS_PATH);
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('GET as USER(无 rbac 码)→ 30100', async () => {
      const res = await request(httpServer(app))
        .get(SETTINGS_PATH)
        .set('Authorization', userHeader);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('PATCH as 裸 ADMIN(无 ops-admin)→ 30100', async () => {
      const res = await request(httpServer(app))
        .patch(SETTINGS_PATH)
        .set('Authorization', plainAdminHeader)
        .send({ enabled: true });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('reset-credentials as ops-admin → 30100(码不绑 ops-admin,镜像 storage/sms D2=A)', async () => {
      const res = await request(httpServer(app))
        .post(RESET_PATH)
        .set('Authorization', opsHeader)
        .send({ appSecret: 'smuggle-secret' });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  describe('settings CRUD 语义', () => {
    it('GET 空库 → 200 data=null(不抛码)', async () => {
      const res = await request(httpServer(app)).get(SETTINGS_PATH).set('Authorization', saHeader);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data).toBeNull();
    });

    it('PATCH 不存在则建 default(providerType=DEV_STUB;credentialStatus=missing)', async () => {
      const res = await request(httpServer(app))
        .patch(SETTINGS_PATH)
        .set('Authorization', opsHeader)
        .send({ enabled: true, remarks: 'e2e 初建' });
      expect(res.status).toBe(200);
      const data = res.body.data as Record<string, unknown>;
      expect(data.providerType).toBe('DEV_STUB');
      expect(data.enabled).toBe(true);
      expect(data.credentialStatus).toBe('missing');
      expect(data.credentialConfigured).toBe(false);
      // 凭证字段永不出现(密文也不回显;L3 红线)
      expect(data).not.toHaveProperty('appSecret');
      expect(data).not.toHaveProperty('appSecretEncrypted');
      expect(data).not.toHaveProperty('credentials');
    });

    it('PATCH 携带凭证字段 → 40000(forbidNonWhitelisted 白名单拒绝)', async () => {
      const res = await request(httpServer(app))
        .patch(SETTINGS_PATH)
        .set('Authorization', opsHeader)
        .send({ appSecret: 'smuggle' });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('PATCH 更新运行参数(WECHAT + appId)持久化;singleton 仍 1 行', async () => {
      const res = await request(httpServer(app))
        .patch(SETTINGS_PATH)
        .set('Authorization', opsHeader)
        .send({ providerType: 'WECHAT', appId: 'wx1234567890abcdef' });
      expect(res.status).toBe(200);
      expect(res.body.data.providerType).toBe('WECHAT');
      expect(res.body.data.appId).toBe('wx1234567890abcdef');
      expect(await prisma.wechatSettings.count()).toBe(1);
    });

    it('reset-credentials as SA → 201;credentialStatus=configured;密文落库且非明文', async () => {
      const res = await request(httpServer(app))
        .post(RESET_PATH)
        .set('Authorization', saHeader)
        .send({ appSecret: 'e2e-app-secret-value' });
      // 镜像 storage/sms reset-credentials 现状:POST 无 @HttpCode → Nest 默认 201
      expect(res.status).toBe(201);
      const data = res.body.data as Record<string, unknown>;
      expect(data.credentialStatus).toBe('configured');
      expect(data.credentialConfigured).toBe(true);
      // 响应全文不含明文凭证(整体序列化断言,L3 红线)
      expect(JSON.stringify(res.body)).not.toContain('e2e-app-secret-value');

      const row = await prisma.wechatSettings.findFirstOrThrow();
      expect(row.appSecretEncrypted).not.toBeNull();
      expect(row.appSecretEncrypted).not.toContain('e2e-app-secret-value');
    });

    it('GET 再读 → configured 且凭证字段仍不出现', async () => {
      const res = await request(httpServer(app)).get(SETTINGS_PATH).set('Authorization', opsHeader);
      expect(res.status).toBe(200);
      expect(res.body.data.credentialStatus).toBe('configured');
      expect(JSON.stringify(res.body)).not.toMatch(/appSecretEncrypted|appSecret/);
    });

    it('密文被篡改 → credentialStatus=invalid(三态合成;不抛错)', async () => {
      const row = await prisma.wechatSettings.findFirstOrThrow();
      await prisma.wechatSettings.update({
        where: { id: row.id },
        data: { appSecretEncrypted: 'bm90LXZhbGlkLWNpcGhlcnRleHQtcGF5bG9hZC0wMDAwMDA=' },
      });
      const res = await request(httpServer(app)).get(SETTINGS_PATH).set('Authorization', saHeader);
      expect(res.status).toBe(200);
      expect(res.body.data.credentialStatus).toBe('invalid');
      expect(res.body.data.credentialConfigured).toBe(true);
    });
  });
});
