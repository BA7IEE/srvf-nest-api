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

// 招新一期 · 实名核验通道 T2 e2e:realname-settings 三端点(冻结评审稿
// docs/archive/reviews/recruitment-phase1-review.md §3.2 端点 1-3 / §8;镜像 wechat/sms-settings e2e 范式)。
//
// 覆盖:RBAC 正反(R 模式 30100;reset 仅 SA)/ upsert 语义 / 凭证永不回显(密文也不回显)
// / credentialStatus 三态(missing → configured → invalid;两段凭证任一篡改即 invalid)。
// production-like 禁 DEV_STUB 的写入校验在 test env 不可达(isProductionLike=false),
// 该分支由 realname-settings.service 实现 + smoke 环境兜底(沿 wechat/sms 同款声明)。
//
// 权限码:T1 已 seed,但 resetDb 清空 RBAC 表 → 本 spec 自行 seed 本模块 3 条 realname-setting 码
// 并按评审稿 §3.4 绑定(reset.credentials 不绑 ops-admin;镜像 wechat-settings spec 自带码范式)。

const SETTINGS_PATH = '/api/system/v1/realname-settings';
const RESET_PATH = '/api/system/v1/realname-settings/reset-credentials';

const REALNAME_PERMISSIONS = [
  {
    code: 'realname-setting.read.singleton',
    module: 'realname-setting',
    action: 'read',
    resourceType: 'singleton',
  },
  {
    code: 'realname-setting.update.singleton',
    module: 'realname-setting',
    action: 'update',
    resourceType: 'singleton',
  },
  {
    code: 'realname-setting.reset.credentials',
    module: 'realname-setting',
    action: 'reset',
    resourceType: 'credentials',
  },
] as const;

// 评审稿 §3.4:reset.credentials 不绑 ops-admin
async function seedRealnamePermissions(
  app: INestApplication,
  opsAdminRoleId: string,
): Promise<void> {
  const prisma = app.get(PrismaService);
  for (const p of REALNAME_PERMISSIONS) {
    const perm = await prisma.permission.upsert({
      where: { code: p.code },
      update: {},
      create: { code: p.code, module: p.module, action: p.action, resourceType: p.resourceType },
      select: { id: true, code: true },
    });
    if (perm.code !== 'realname-setting.reset.credentials') {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: opsAdminRoleId, permissionId: perm.id } },
        update: {},
        create: { roleId: opsAdminRoleId, permissionId: perm.id },
      });
    }
  }
}

describe('Realname Settings(T2 e2e)', () => {
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
    await seedRealnamePermissions(app, opsAdminRoleId);

    await createTestUser(app, { username: 'rn_set_sa', role: Role.SUPER_ADMIN });
    const ops = await createTestUser(app, { username: 'rn_set_ops', role: Role.ADMIN });
    await grantOpsAdminToUser(app, ops.id, opsAdminRoleId);
    await createTestUser(app, { username: 'rn_set_admin', role: Role.ADMIN });
    await createTestUser(app, { username: 'rn_set_user', role: Role.USER });

    saHeader = (await loginAs(app, 'rn_set_sa')).authHeader;
    opsHeader = (await loginAs(app, 'rn_set_ops')).authHeader;
    plainAdminHeader = (await loginAs(app, 'rn_set_admin')).authHeader;
    userHeader = (await loginAs(app, 'rn_set_user')).authHeader;
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

    it('reset-credentials as ops-admin → 30100(码不绑 ops-admin,镜像 storage/sms/wechat D2=A)', async () => {
      const res = await request(httpServer(app))
        .post(RESET_PATH)
        .set('Authorization', opsHeader)
        .send({ secretId: 'smuggle-id', secretKey: 'smuggle-key' });
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

    it('空表并发 PATCH 均成功且只创建一个 default singleton row', async () => {
      const sendPatch = () =>
        request(httpServer(app))
          .patch(SETTINGS_PATH)
          .set('Authorization', opsHeader)
          .send({ enabled: true, remarks: 'e2e 初建' });
      const [first, second] = await Promise.all([sendPatch(), sendPatch()]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const data = first.body.data as Record<string, unknown>;
      expect(data.providerType).toBe('DEV_STUB');
      expect(data.enabled).toBe(true);
      expect(data.credentialStatus).toBe('missing');
      expect(data.credentialConfigured).toBe(false);
      // 凭证字段永不出现(密文也不回显;L3 红线)
      expect(data).not.toHaveProperty('secretId');
      expect(data).not.toHaveProperty('secretKey');
      expect(data).not.toHaveProperty('secretIdEncrypted');
      expect(data).not.toHaveProperty('secretKeyEncrypted');
      expect(data).not.toHaveProperty('credentials');
      expect(await prisma.realnameVerificationSettings.count()).toBe(1);
    });

    it('PATCH 携带凭证字段 → 40000(forbidNonWhitelisted 白名单拒绝)', async () => {
      const res = await request(httpServer(app))
        .patch(SETTINGS_PATH)
        .set('Authorization', opsHeader)
        .send({ secretId: 'smuggle' });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('PATCH 更新运行参数(TENCENT_CLOUD + region)持久化;singleton 仍 1 行', async () => {
      const res = await request(httpServer(app))
        .patch(SETTINGS_PATH)
        .set('Authorization', opsHeader)
        .send({ providerType: 'TENCENT_CLOUD', region: 'ap-guangzhou' });
      expect(res.status).toBe(200);
      expect(res.body.data.providerType).toBe('TENCENT_CLOUD');
      expect(res.body.data.region).toBe('ap-guangzhou');
      expect(await prisma.realnameVerificationSettings.count()).toBe(1);
    });

    it('reset-credentials as SA → 201;credentialStatus=configured;两段密文落库且非明文', async () => {
      const res = await request(httpServer(app))
        .post(RESET_PATH)
        .set('Authorization', saHeader)
        .send({ secretId: 'e2e-secret-id-value', secretKey: 'e2e-secret-key-value' });
      // 镜像 storage/sms/wechat reset-credentials 现状:POST 无 @HttpCode → Nest 默认 201
      expect(res.status).toBe(201);
      const data = res.body.data as Record<string, unknown>;
      expect(data.credentialStatus).toBe('configured');
      expect(data.credentialConfigured).toBe(true);
      // 响应全文不含明文凭证(整体序列化断言,L3 红线)
      expect(JSON.stringify(res.body)).not.toContain('e2e-secret-id-value');
      expect(JSON.stringify(res.body)).not.toContain('e2e-secret-key-value');

      const row = await prisma.realnameVerificationSettings.findFirstOrThrow();
      expect(row.secretIdEncrypted).not.toBeNull();
      expect(row.secretKeyEncrypted).not.toBeNull();
      expect(row.secretIdEncrypted).not.toContain('e2e-secret-id-value');
      expect(row.secretKeyEncrypted).not.toContain('e2e-secret-key-value');
    });

    it('GET 再读 → configured 且凭证字段仍不出现', async () => {
      const res = await request(httpServer(app)).get(SETTINGS_PATH).set('Authorization', opsHeader);
      expect(res.status).toBe(200);
      expect(res.body.data.credentialStatus).toBe('configured');
      expect(JSON.stringify(res.body)).not.toMatch(
        /secretIdEncrypted|secretKeyEncrypted|secretKey/,
      );
    });

    it('密文被篡改 → credentialStatus=invalid(两段任一解密失败即 invalid;不抛错)', async () => {
      const row = await prisma.realnameVerificationSettings.findFirstOrThrow();
      await prisma.realnameVerificationSettings.update({
        where: { id: row.id },
        data: { secretIdEncrypted: 'bm90LXZhbGlkLWNpcGhlcnRleHQtcGF5bG9hZC0wMDAwMDA=' },
      });
      const res = await request(httpServer(app)).get(SETTINGS_PATH).set('Authorization', saHeader);
      expect(res.status).toBe(200);
      expect(res.body.data.credentialStatus).toBe('invalid');
      expect(res.body.data.credentialConfigured).toBe(true);
    });
  });
});
