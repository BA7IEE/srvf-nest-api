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

// SMS 基础设施 T3 e2e 第 1 组:sms-settings 三端点 + send-logs 列表(评审稿 §10)。
//
// 覆盖:RBAC 正反(R 模式 30100;reset 仅 SA)/ upsert 语义 / 凭证永不回显(密文也不回显)
// / credentialStatus 三态 / send-logs 掩码与过滤分页。
// production-like 禁 DEV_STUB 的写入校验在 test env 不可达(isProductionLike=false),
// 该分支由 sms-settings.service 的 E-15 实现 + smoke 环境兜底,不在本组造假环境。
//
// 权限码:沿 rbac.fixture 范式,spec 自行 seed 本模块 4 条 sms 码并按评审稿 E-3 绑定
// (reset.credentials 不绑 ops-admin;fixture 共享清单不动,镜像 attachments spec 自带码范式)。

const SETTINGS_PATH = '/api/system/v1/sms-settings';
const RESET_PATH = '/api/system/v1/sms-settings/reset-credentials';
const LOGS_PATH = '/api/system/v1/sms-send-logs';

const SMS_PERMISSIONS = [
  {
    code: 'sms-setting.read.singleton',
    module: 'sms-setting',
    action: 'read',
    resourceType: 'singleton',
  },
  {
    code: 'sms-setting.update.singleton',
    module: 'sms-setting',
    action: 'update',
    resourceType: 'singleton',
  },
  {
    code: 'sms-setting.reset.credentials',
    module: 'sms-setting',
    action: 'reset',
    resourceType: 'credentials',
  },
  { code: 'sms-send-log.read.list', module: 'sms-send-log', action: 'read', resourceType: 'list' },
] as const;

// 评审稿 E-3:reset.credentials 不绑 ops-admin
async function seedSmsPermissions(app: INestApplication, opsAdminRoleId: string): Promise<void> {
  const prisma = app.get(PrismaService);
  for (const p of SMS_PERMISSIONS) {
    const perm = await prisma.permission.upsert({
      where: { code: p.code },
      update: {},
      create: { code: p.code, module: p.module, action: p.action, resourceType: p.resourceType },
      select: { id: true, code: true },
    });
    if (perm.code !== 'sms-setting.reset.credentials') {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: opsAdminRoleId, permissionId: perm.id } },
        update: {},
        create: { roleId: opsAdminRoleId, permissionId: perm.id },
      });
    }
  }
}

describe('SMS Settings + Send Logs(T3 e2e 组 1)', () => {
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
    await seedSmsPermissions(app, opsAdminRoleId);

    const sa = await createTestUser(app, { username: 'sms_set_sa', role: Role.SUPER_ADMIN });
    const ops = await createTestUser(app, { username: 'sms_set_ops', role: Role.ADMIN });
    await grantOpsAdminToUser(app, ops.id, opsAdminRoleId);
    await createTestUser(app, { username: 'sms_set_admin', role: Role.ADMIN });
    await createTestUser(app, { username: 'sms_set_user', role: Role.USER });

    saHeader = (await loginAs(app, 'sms_set_sa')).authHeader;
    opsHeader = (await loginAs(app, 'sms_set_ops')).authHeader;
    plainAdminHeader = (await loginAs(app, 'sms_set_admin')).authHeader;
    userHeader = (await loginAs(app, 'sms_set_user')).authHeader;
    void sa;
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

    it('reset-credentials as ops-admin → 30100(码不绑 ops-admin,镜像 storage D2=A)', async () => {
      const res = await request(httpServer(app))
        .post(RESET_PATH)
        .set('Authorization', opsHeader)
        .send({ secretId: 'AKID-x', secretKey: 'sk-x' });
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
      // 凭证字段永不出现(密文也不回显)
      expect(data).not.toHaveProperty('secretId');
      expect(data).not.toHaveProperty('secretKey');
      expect(data).not.toHaveProperty('secretIdEncrypted');
      expect(data).not.toHaveProperty('secretKeyEncrypted');
      expect(data).not.toHaveProperty('credentials');
      expect(await prisma.smsSettings.count()).toBe(1);
    });

    it('PATCH 携带凭证字段 → 40000(forbidNonWhitelisted 白名单拒绝)', async () => {
      const res = await request(httpServer(app))
        .patch(SETTINGS_PATH)
        .set('Authorization', opsHeader)
        .send({ secretId: 'AKID-smuggle' });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('PATCH 更新运行参数(TENCENT_SMS + sdkAppId/signName/region/templateId)持久化', async () => {
      const res = await request(httpServer(app))
        .patch(SETTINGS_PATH)
        .set('Authorization', opsHeader)
        .send({
          providerType: 'TENCENT_SMS',
          sdkAppId: '1400000000',
          signName: '测试签名',
          region: 'ap-guangzhou',
          templateIdVerifyCode: '2000001',
        });
      expect(res.status).toBe(200);
      expect(res.body.data.providerType).toBe('TENCENT_SMS');
      expect(res.body.data.sdkAppId).toBe('1400000000');
      // singleton:仍只有 1 行
      expect(await prisma.smsSettings.count()).toBe(1);
    });

    it('reset-credentials as SA → 200;credentialStatus=configured;密文落库且非明文', async () => {
      const res = await request(httpServer(app))
        .post(RESET_PATH)
        .set('Authorization', saHeader)
        .send({ secretId: 'AKID-e2e-secret-id', secretKey: 'e2e-secret-key-value' });
      // 镜像 storage reset-credentials 现状:POST 无 @HttpCode → Nest 默认 201
      expect(res.status).toBe(201);
      const data = res.body.data as Record<string, unknown>;
      expect(data.credentialStatus).toBe('configured');
      expect(data.credentialConfigured).toBe(true);
      // 响应全文不含明文凭证(整体序列化断言,L3 红线)
      expect(JSON.stringify(res.body)).not.toContain('AKID-e2e-secret-id');
      expect(JSON.stringify(res.body)).not.toContain('e2e-secret-key-value');

      const row = await prisma.smsSettings.findFirstOrThrow();
      expect(row.secretIdEncrypted).not.toBeNull();
      expect(row.secretIdEncrypted).not.toContain('AKID-e2e-secret-id');
      expect(row.secretKeyEncrypted).not.toContain('e2e-secret-key-value');
    });

    it('GET 再读 → configured 且凭证字段仍不出现', async () => {
      const res = await request(httpServer(app)).get(SETTINGS_PATH).set('Authorization', opsHeader);
      expect(res.status).toBe(200);
      expect(res.body.data.credentialStatus).toBe('configured');
      expect(JSON.stringify(res.body)).not.toMatch(/secretIdEncrypted|secretKeyEncrypted/);
    });
  });

  describe('send-logs 列表', () => {
    beforeAll(async () => {
      await prisma.smsSendLog.createMany({
        data: [
          {
            phone: '13800001111',
            templateKey: 'verify-code',
            providerType: 'DEV_STUB',
            status: 'SENT',
          },
          {
            phone: '13900002222',
            templateKey: 'verify-code',
            providerType: 'TENCENT_SMS',
            status: 'FAILED',
            errCode: 'LimitExceeded',
            errMsg: 'provider limit',
          },
        ],
      });
    });

    it('无 token → 40100;USER → 30100', async () => {
      expectBizError(await request(httpServer(app)).get(LOGS_PATH), BizCode.UNAUTHORIZED);
      expectBizError(
        await request(httpServer(app)).get(LOGS_PATH).set('Authorization', userHeader),
        BizCode.RBAC_FORBIDDEN,
      );
    });

    it('ops-admin 可读;响应手机号一律掩码 138****1111', async () => {
      const res = await request(httpServer(app)).get(LOGS_PATH).set('Authorization', opsHeader);
      expect(res.status).toBe(200);
      const { items, total, page, pageSize } = res.body.data as {
        items: Array<Record<string, unknown>>;
        total: number;
        page: number;
        pageSize: number;
      };
      expect(total).toBe(2);
      expect(page).toBe(1);
      expect(pageSize).toBe(20);
      const phones = items.map((i) => i.phone);
      expect(phones).toContain('138****1111');
      expect(phones).toContain('139****2222');
      // 明文号码不出现在响应任何位置
      expect(JSON.stringify(res.body)).not.toContain('13800001111');
      expect(JSON.stringify(res.body)).not.toContain('13900002222');
    });

    it('status / phone(入参明文精确过滤)生效;响应仍掩码', async () => {
      const res = await request(httpServer(app))
        .get(`${LOGS_PATH}?status=FAILED&phone=13900002222`)
        .set('Authorization', opsHeader);
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0].status).toBe('FAILED');
      expect(res.body.data.items[0].phone).toBe('139****2222');
      expect(res.body.data.items[0].errCode).toBe('LimitExceeded');
    });

    it('phone 过滤入参格式非法 → 40000', async () => {
      const res = await request(httpServer(app))
        .get(`${LOGS_PATH}?phone=123`)
        .set('Authorization', opsHeader);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });
  });
});
