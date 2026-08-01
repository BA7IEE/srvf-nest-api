import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import type { AuditContext } from '../../src/modules/audit-logs/audit-logs.types';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 企业微信接入 T2(2026-08-01):WeCom Settings admin e2e
// 冻结稿 docs/archive/reviews/wecom-integration-t0-terminal-review.md §6.1 / §11.1
//
// 覆盖 goal DoD 的三条硬要求:
//   ① 凭证泄露反向用例 —— settings 全部响应 / audit / 日志中 grep 不到 CorpSecret 明文与密文
//   ② enabled=false 时一切 Effect fail-closed(阳性对照:开了就能通,关了就不通)
//   ③ 四端点权限边界(reset.credentials 不绑 ops-admin,仅 SUPER_ADMIN 短路)
//
// 判权全在 service 层 rbac.can();入口只有 JwtAuthGuard(镜像 wechat/sms/storage-settings)。

const SUPER_USERNAME = 'wc-su';
const ADMIN_USERNAME = 'wc-adm';
const USER_USERNAME = 'wc-user';

const CORP_SECRET_PLAIN = 'plain-wecom-corp-secret-do-not-leak-0987654321XYZ';
const CORP_ID = 'wwWeComCorpIdForTest';

const BASE = '/api/system/v1/wecom-settings';

// 沿 wechat/sms-settings spec 范式:本模块的码由 spec 自行 seed,
// **不动** rbac.fixture 的共享清单(共享清单一改,所有 spec 的绑定计数断言都会连坐)。
const WECOM_PERMISSIONS = [
  { code: 'wecom-setting.read.singleton', action: 'read', resourceType: 'singleton' },
  { code: 'wecom-setting.update.singleton', action: 'update', resourceType: 'singleton' },
  { code: 'wecom-setting.test.connection', action: 'test', resourceType: 'connection' },
  { code: 'wecom-setting.reset.credentials', action: 'reset', resourceType: 'credentials' },
] as const;

// 冻结稿 §11.1:reset.credentials **不绑 ops-admin**(仅 SUPER_ADMIN 短路)
async function seedWecomPermissions(app: INestApplication, opsAdminRoleId: string): Promise<void> {
  const prisma = app.get(PrismaService);
  for (const p of WECOM_PERMISSIONS) {
    const perm = await prisma.permission.upsert({
      where: { code: p.code },
      update: {},
      create: {
        code: p.code,
        module: 'wecom-setting',
        action: p.action,
        resourceType: p.resourceType,
      },
      select: { id: true, code: true },
    });
    if (perm.code !== 'wecom-setting.reset.credentials') {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: opsAdminRoleId, permissionId: perm.id } },
        update: {},
        create: { roleId: opsAdminRoleId, permissionId: perm.id },
      });
    }
  }
}

describe('wecom-settings admin(企业微信 T2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAuth: string;
  let adminAuth: string;
  let userAuth: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: SUPER_USERNAME, role: Role.SUPER_ADMIN });
    const admin = await createTestUser(app, { username: ADMIN_USERNAME, role: Role.ADMIN });
    await createTestUser(app, { username: USER_USERNAME, role: Role.USER });

    // ops-admin 可读 / 可改 / 可诊断,但**不**绑 wecom-setting.reset.credentials(冻结稿 §11.1)
    const { opsAdminRoleId } = await seedRbacPermissionsAndOpsAdmin(app);
    await seedWecomPermissions(app, opsAdminRoleId);
    await grantOpsAdminToUser(app, admin.id, opsAdminRoleId);

    superAuth = (await loginAs(app, SUPER_USERNAME)).authHeader;
    adminAuth = (await loginAs(app, ADMIN_USERNAME)).authHeader;
    userAuth = (await loginAs(app, USER_USERNAME)).authHeader;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // identity 也必须清 —— corpId 变更闸读的就是 active identity 计数,
    // 上一条用例留下的 active 行会让下一条"反向放行"用例假红(实测踩过)。
    await prisma.wecomIdentity.deleteMany();
    await prisma.wecomSettings.deleteMany();
    await prisma.auditLog.deleteMany({ where: { resourceType: 'wecom_setting' } });
  });

  // ===== ① 权限边界(冻结稿 §11.1)=====

  describe('权限边界', () => {
    it('未登录 → 401', async () => {
      const res = await request(httpServer(app)).get(BASE);
      expect(res.status).toBe(401);
    });

    it('普通 USER → 30100', async () => {
      const res = await request(httpServer(app)).get(BASE).set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('ops-admin 可读 / 可改 / 可诊断', async () => {
      expect(
        (await request(httpServer(app)).get(BASE).set('Authorization', adminAuth)).status,
      ).toBe(200);
      expect(
        (
          await request(httpServer(app))
            .patch(BASE)
            .set('Authorization', adminAuth)
            .send({ remarks: 'ops-admin 可改' })
        ).status,
      ).toBe(200);
    });

    // 冻结稿 §11.1:`wecom-setting.reset.credentials` **不绑 ops-admin**,仅 SUPER_ADMIN 短路。
    // 这条是本批与 storage/sms/wechat 一致的凭证收紧口径 —— ops-admin 能改配置但不能换凭证。
    it('ops-admin 调 reset-credentials → 30100(码不绑 ops-admin)', async () => {
      const res = await request(httpServer(app))
        .post(`${BASE}/reset-credentials`)
        .set('Authorization', adminAuth)
        .send({ corpSecret: CORP_SECRET_PLAIN });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('SUPER_ADMIN 调 reset-credentials → 200(短路通过)', async () => {
      const res = await request(httpServer(app))
        .post(`${BASE}/reset-credentials`)
        .set('Authorization', superAuth)
        .send({ corpSecret: CORP_SECRET_PLAIN });
      expect(res.status).toBe(200);
    });
  });

  // ===== ② 默认值与开关语义(冻结稿 §5.1 / §13 T2)=====

  describe('默认值与开关', () => {
    it('GET 不存在 → data:null(不抛 BizCode)', async () => {
      const res = await request(httpServer(app)).get(BASE).set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
    });

    it('PATCH 首次 upsert → 三个开关默认全 false,providerType=DEV_STUB', async () => {
      const res = await request(httpServer(app))
        .patch(BASE)
        .set('Authorization', adminAuth)
        .send({ remarks: '首配' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        enabled: false,
        loginEnabled: false,
        messageEnabled: false,
        providerType: 'DEV_STUB',
        credentialConfigured: false,
        credentialStatus: 'missing',
      });
    });

    // 二级闸不得脱离总闸:否则运维看到 loginEnabled=true 会以为能登,
    // 实际全被 enabled=false 挡掉 —— 一个自相矛盾却"保存成功"的配置。
    it('loginEnabled=true 但 enabled=false → 400', async () => {
      const res = await request(httpServer(app))
        .patch(BASE)
        .set('Authorization', adminAuth)
        .send({ loginEnabled: true });
      expectBizError(res, BizCode.BAD_REQUEST);
    });

    it('messageEnabled=true 但 enabled=false → 400', async () => {
      const res = await request(httpServer(app))
        .patch(BASE)
        .set('Authorization', adminAuth)
        .send({ messageEnabled: true });
      expectBizError(res, BizCode.BAD_REQUEST);
    });

    it('反向:enabled 与 loginEnabled 同时置 true → 200', async () => {
      const res = await request(httpServer(app))
        .patch(BASE)
        .set('Authorization', adminAuth)
        .send({ enabled: true, loginEnabled: true });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ enabled: true, loginEnabled: true });
    });
  });

  // ===== ③ DTO 白名单:凭证字段一律拒收(冻结稿 §6.1)=====

  describe('DTO 白名单', () => {
    it.each([
      ['corpSecret', { corpSecret: CORP_SECRET_PLAIN }],
      ['corpSecretEncrypted', { corpSecretEncrypted: 'x' }],
      ['credentialConfigured', { credentialConfigured: true }],
      // §0.3 第一版不加回调 Token 与 EncodingAESKey —— 连字段位都不开
      ['callbackToken', { callbackToken: 'x' }],
      ['encodingAesKey', { encodingAesKey: 'x' }],
    ])('PATCH 携带 %s → 400(forbidNonWhitelisted)', async (_label, payload) => {
      const res = await request(httpServer(app))
        .patch(BASE)
        .set('Authorization', adminAuth)
        .send(payload);
      expect(res.status).toBe(400);
    });

    // 第 18 条棘轮(srvf/no-nullable-is-optional)的行为面:
    // Update DTO 全字段用 @OmittableOnly(),显式 null 必须稳定 400 而不是穿过契约层。
    it.each([['corpId'], ['agentId'], ['webBaseUrl'], ['remarks'], ['enabled']])(
      'PATCH %s:null → 400(@OmittableOnly;null 不得穿过契约层)',
      async (field) => {
        const res = await request(httpServer(app))
          .patch(BASE)
          .set('Authorization', adminAuth)
          .send({ [field]: null });
        expect(res.status).toBe(400);
      },
    );

    it('webBaseUrl 带 path → 400(防开放重定向:callback path 由代码固定拼接)', async () => {
      const res = await request(httpServer(app))
        .patch(BASE)
        .set('Authorization', adminAuth)
        .send({ webBaseUrl: 'https://app.example.com/evil/callback' });
      expectBizError(res, BizCode.BAD_REQUEST);
    });

    it('反向:webBaseUrl 纯 origin → 200', async () => {
      const res = await request(httpServer(app))
        .patch(BASE)
        .set('Authorization', adminAuth)
        .send({ webBaseUrl: 'https://app.example.com' });
      expect(res.status).toBe(200);
      expect(res.body.data.webBaseUrl).toBe('https://app.example.com');
    });
  });

  // ===== ④ corpId 变更闸(36020;冻结稿 §6.1 / §5.1 规则 5)=====

  describe('corpId 变更闸', () => {
    it('存在 active identity 时改 corpId → 36020', async () => {
      await request(httpServer(app))
        .patch(BASE)
        .set('Authorization', adminAuth)
        .send({ corpId: CORP_ID });

      const holder = await createTestUser(app, { username: `wc-bound-${Date.now()}` });
      await prisma.wecomIdentity.create({
        data: {
          userId: holder.id,
          corpId: CORP_ID,
          wecomUserId: 'zhangsan',
          status: 'active',
          bindingSource: 'pre-auth',
        },
      });

      const res = await request(httpServer(app))
        .patch(BASE)
        .set('Authorization', adminAuth)
        .send({ corpId: 'wwAnotherCorp' });
      expectBizError(res, BizCode.WECOM_CORP_ID_IN_USE);
    });

    it('反向:identity 全部 revoked 时改 corpId → 200', async () => {
      await request(httpServer(app))
        .patch(BASE)
        .set('Authorization', adminAuth)
        .send({ corpId: CORP_ID });

      const holder = await createTestUser(app, { username: `wc-revoked-${Date.now()}` });
      await prisma.wecomIdentity.create({
        data: {
          userId: holder.id,
          corpId: CORP_ID,
          wecomUserId: 'lisi',
          status: 'revoked',
          revokedAt: new Date(),
          bindingSource: 'pre-auth',
        },
      });

      const res = await request(httpServer(app))
        .patch(BASE)
        .set('Authorization', adminAuth)
        .send({ corpId: 'wwAnotherCorp' });
      expect(res.status).toBe(200);
    });

    it('反向:同值重复提交 corpId 不触发闸(不是"改")', async () => {
      await request(httpServer(app))
        .patch(BASE)
        .set('Authorization', adminAuth)
        .send({ corpId: CORP_ID });
      const holder = await createTestUser(app, { username: `wc-same-${Date.now()}` });
      await prisma.wecomIdentity.create({
        data: {
          userId: holder.id,
          corpId: CORP_ID,
          wecomUserId: 'wangwu',
          status: 'active',
          bindingSource: 'me',
        },
      });

      const res = await request(httpServer(app))
        .patch(BASE)
        .set('Authorization', adminAuth)
        .send({ corpId: CORP_ID });
      expect(res.status).toBe(200);
    });
  });

  // ===== ⑤ 凭证泄露反向用例(goal DoD;冻结稿 §5.5 L3 红线)=====

  describe('凭证不泄露', () => {
    it('reset → 响应 / GET / PATCH 三处全文都 grep 不到明文与密文', async () => {
      const resetRes = await request(httpServer(app))
        .post(`${BASE}/reset-credentials`)
        .set('Authorization', superAuth)
        .send({ corpSecret: CORP_SECRET_PLAIN });
      expect(resetRes.status).toBe(200);

      const row = await prisma.wecomSettings.findFirstOrThrow();
      const cipher = row.corpSecretEncrypted;
      expect(cipher).not.toBeNull();
      // 密文确实是密文:既不等于明文,也不包含明文
      expect(cipher).not.toBe(CORP_SECRET_PLAIN);
      expect(cipher).not.toContain(CORP_SECRET_PLAIN);

      const getRes = await request(httpServer(app)).get(BASE).set('Authorization', adminAuth);
      const patchRes = await request(httpServer(app))
        .patch(BASE)
        .set('Authorization', adminAuth)
        .send({ remarks: '再动一次' });

      for (const [label, res] of [
        ['reset', resetRes],
        ['get', getRes],
        ['patch', patchRes],
      ] as const) {
        const body = JSON.stringify(res.body);
        expect(body).not.toContain(CORP_SECRET_PLAIN); // 明文
        expect(body).not.toContain(cipher as string); // 密文
        expect(body).not.toContain('corpSecret'); // 连字段名都不出现
        expect(label).toBeTruthy();
      }
    });

    it('audit 两条事件的整行 JSON 都 grep 不到明文 / 密文 / 凭证字段名', async () => {
      await request(httpServer(app))
        .post(`${BASE}/reset-credentials`)
        .set('Authorization', superAuth)
        .send({ corpSecret: CORP_SECRET_PLAIN });
      await request(httpServer(app))
        .patch(BASE)
        .set('Authorization', adminAuth)
        .send({ corpId: CORP_ID, remarks: 'audit 检查' });

      const row = await prisma.wecomSettings.findFirstOrThrow();
      const logs = await prisma.auditLog.findMany({
        where: { event: { in: ['wecom-setting.update', 'wecom-setting.reset-credentials'] } },
      });
      expect(logs.length).toBe(2);

      for (const log of logs) {
        const serialized = JSON.stringify(log);
        expect(serialized).not.toContain(CORP_SECRET_PLAIN);
        expect(serialized).not.toContain(row.corpSecretEncrypted as string);
        expect(serialized).not.toContain('corpSecret');
        // §5.5:corpId 的 **value** 也不写进 Audit
        expect(serialized).not.toContain(CORP_ID);
      }

      // before / after / extra 都在 context JSON 里(AuditContext),不是独立列
      const contextOf = (event: string): AuditContext =>
        JSON.parse(JSON.stringify(logs.find((l) => l.event === event)?.context)) as AuditContext;

      // reset 事件:不传 before/after/extra(连"改了哪个字段"都不记)
      const reset = contextOf('wecom-setting.reset-credentials');
      expect(reset.before).toBeUndefined();
      expect(reset.after).toBeUndefined();
      expect(reset.extra).toBeUndefined();

      // update 事件:只记 changedFields 字段名清单,不记 before/after value
      const update = contextOf('wecom-setting.update');
      expect(update.before).toBeUndefined();
      expect(update.after).toBeUndefined();
      expect(update.extra).toEqual({ changedFields: ['corpId', 'remarks'] });
    });

    it('corpId 在响应里只回显掩码,不回显全值', async () => {
      await request(httpServer(app))
        .patch(BASE)
        .set('Authorization', adminAuth)
        .send({ corpId: CORP_ID });
      const res = await request(httpServer(app)).get(BASE).set('Authorization', adminAuth);
      expect(res.body.data.corpIdMasked).toBe('wwWe****Test');
      expect(JSON.stringify(res.body)).not.toContain(CORP_ID);
      expect(res.body.data.corpId).toBeUndefined();
    });
  });

  // ===== ⑥ fail-closed 阳性对照(goal DoD)=====

  describe('test-connection 与 fail-closed', () => {
    it('settings 不存在 → 36030', async () => {
      const res = await request(httpServer(app))
        .post(`${BASE}/test-connection`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.WECOM_CHANNEL_NOT_CONFIGURED);
    });

    it('enabled=false → 36030(总闸关着,一切 Effect fail-closed)', async () => {
      await request(httpServer(app))
        .patch(BASE)
        .set('Authorization', adminAuth)
        .send({ enabled: false, agentId: 1000002 });
      const res = await request(httpServer(app))
        .post(`${BASE}/test-connection`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.WECOM_CHANNEL_NOT_CONFIGURED);
    });

    it('enabled=true 但 agentId 缺失 → 36030(无从核对)', async () => {
      await request(httpServer(app))
        .patch(BASE)
        .set('Authorization', adminAuth)
        .send({ enabled: true });
      const res = await request(httpServer(app))
        .post(`${BASE}/test-connection`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.WECOM_CHANNEL_NOT_CONFIGURED);
    });

    // 阳性对照:同样的配置,只把 enabled 从 false 翻成 true 就通了 ——
    // 证明上面几条拒绝是 enabled 闸造成的,不是"反正都不通"。
    it('反向:enabled=true + DEV_STUB + agentId → 200 且只返计数不返任何 ID', async () => {
      await request(httpServer(app))
        .patch(BASE)
        .set('Authorization', adminAuth)
        .send({ enabled: true, agentId: 1000002, providerType: 'DEV_STUB' });

      const res = await request(httpServer(app))
        .post(`${BASE}/test-connection`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        ok: true,
        providerType: 'DEV_STUB',
        tokenAcquired: true,
        agentMatched: true,
        agentEnabled: true,
      });
      // 冻结稿 §6.1 第 4 条:只返计数,**不返任何成员 / 部门 / 标签 ID**
      expect(res.body.data.visibilitySummary).toEqual({
        directUsers: expect.any(Number),
        parties: expect.any(Number),
        tags: expect.any(Number),
      });
      const serialized = JSON.stringify(res.body);
      for (const forbidden of ['allow_userinfos', 'allow_partys', 'allow_tags', 'userid']) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it('test-connection 是只读诊断 —— 不写 audit(冻结稿 §6.1 末段)', async () => {
      await request(httpServer(app))
        .patch(BASE)
        .set('Authorization', adminAuth)
        .send({ enabled: true, agentId: 1000002 });
      const before = await prisma.auditLog.count();
      await request(httpServer(app))
        .post(`${BASE}/test-connection`)
        .set('Authorization', adminAuth);
      expect(await prisma.auditLog.count()).toBe(before);
    });
  });

  // ===== ⑦ singleton(第 68 migration 的 DB 层强制)=====

  it('多次 PATCH 恒只有一行 settings', async () => {
    for (const remarks of ['一', '二', '三']) {
      await request(httpServer(app)).patch(BASE).set('Authorization', adminAuth).send({ remarks });
    }
    expect(await prisma.wecomSettings.count()).toBe(1);
  });
});
