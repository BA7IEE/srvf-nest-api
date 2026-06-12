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

// 微信小程序登录 T3 e2e 组 C:me/wechat 查询/换绑 + admin 清除(冻结评审稿
// wechat-mini-login-review.md §4.4 / E-13/E-18/E-20;镜像 app-me-phone-bind 范式)。
//
// 通道:wechat DEV_STUB(openid = dev-openid-<code> 确定性);
// PUT me/wechat 无需短信(JWT 已证身份,D-W3),无限流装饰器(评审稿 E-17)。
// openid 纪律:响应仅掩码;audit 一律掩码;admin 清除幂等。

const ME_WECHAT_PATH = '/api/app/v1/me/wechat';

const WECHAT_CLEAR_PERMISSION = {
  code: 'user.wechat.clear',
  module: 'user',
  action: 'clear',
  resourceType: 'wechat',
} as const;

describe('App 微信绑定查询/换绑 + admin 清除(T3 e2e 组 C)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let u1Header: string;
  let u2Header: string;
  let opsHeader: string;
  let userHeader: string;
  let u1Id: string;
  let u2Id: string;

  function getWechat(header: string): Promise<request.Response> {
    return request(httpServer(app)).get(ME_WECHAT_PATH).set('Authorization', header);
  }

  function putWechat(header: string, code: string): Promise<request.Response> {
    return request(httpServer(app)).put(ME_WECHAT_PATH).set('Authorization', header).send({ code });
  }

  function adminClear(header: string, userId: string): Promise<request.Response> {
    return request(httpServer(app))
      .delete(`/api/admin/v1/users/${userId}/wechat`)
      .set('Authorization', header);
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);
    await prisma.wechatSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });

    const { opsAdminRoleId } = await seedRbacPermissionsAndOpsAdmin(app);
    // 本组自带 user.wechat.clear 码并绑 ops-admin(沿 wechat-settings spec 自带码范式)
    const perm = await prisma.permission.upsert({
      where: { code: WECHAT_CLEAR_PERMISSION.code },
      update: {},
      create: { ...WECHAT_CLEAR_PERMISSION },
      select: { id: true },
    });
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: opsAdminRoleId, permissionId: perm.id } },
      update: {},
      create: { roleId: opsAdminRoleId, permissionId: perm.id },
    });

    const u1 = await createTestUser(app, { username: 'mew_u1' });
    u1Id = u1.id;
    const u2 = await createTestUser(app, { username: 'mew_u2' });
    u2Id = u2.id;
    const ops = await createTestUser(app, { username: 'mew_ops', role: Role.ADMIN });
    await grantOpsAdminToUser(app, ops.id, opsAdminRoleId);
    await createTestUser(app, { username: 'mew_plain', role: Role.USER });

    u1Header = (await loginAs(app, 'mew_u1')).authHeader;
    u2Header = (await loginAs(app, 'mew_u2')).authHeader;
    opsHeader = (await loginAs(app, 'mew_ops')).authHeader;
    userHeader = (await loginAs(app, 'mew_plain')).authHeader;
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET 未绑定 → bound:false / openidMasked:null;无 token → 40100', async () => {
    const res = await getWechat(u1Header);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ bound: false, openidMasked: null });
    expectBizError(await request(httpServer(app)).get(ME_WECHAT_PATH), BizCode.UNAUTHORIZED);
  });

  it('PUT 首绑 → bound:true + openid 掩码回显(完整值不出现);audit wechat.bind.self(viaPath=me,掩码)', async () => {
    const res = await putWechat(u1Header, 'me-wx-1');
    expect(res.status).toBe(200);
    expect(res.body.data.bound).toBe(true);
    // 完整 openid(dev-openid-me-wx-1)不出现在响应任何位置
    expect(JSON.stringify(res.body)).not.toContain('dev-openid-me-wx-1');
    expect(res.body.data.openidMasked).toMatch(/^dev-\*{4}wx-1$/);

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: u1Id },
      select: { openid: true },
    });
    expect(row.openid).toBe('dev-openid-me-wx-1');

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { event: 'wechat.bind.self', actorUserId: u1Id },
    });
    const s = JSON.stringify(audit);
    expect(s).not.toContain('dev-openid-me-wx-1');
    expect(s).toContain('"viaPath":"me"');
  });

  it('PUT 同 openid 重复绑定 → 幂等 200,不新增 audit', async () => {
    const before = await prisma.auditLog.count({
      where: { event: { in: ['wechat.bind.self', 'wechat.rebind.self'] } },
    });
    const res = await putWechat(u1Header, 'me-wx-1');
    expect(res.status).toBe(200);
    expect(res.body.data.bound).toBe(true);
    const after = await prisma.auditLog.count({
      where: { event: { in: ['wechat.bind.self', 'wechat.rebind.self'] } },
    });
    expect(after).toBe(before);
  });

  it('PUT 他人已绑的 openid → 25002(含软删占用语义同 phone E-19)', async () => {
    const res = await putWechat(u2Header, 'me-wx-1');
    expectBizError(res, BizCode.WECHAT_ALREADY_BOUND);
  });

  it('PUT 换绑新 openid → wechat.rebind.self(before/after 掩码)', async () => {
    const res = await putWechat(u1Header, 'me-wx-1b');
    expect(res.status).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: u1Id },
      select: { openid: true },
    });
    expect(row.openid).toBe('dev-openid-me-wx-1b');
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { event: 'wechat.rebind.self', actorUserId: u1Id },
    });
    const s = JSON.stringify(audit);
    expect(s).not.toContain('dev-openid-me-wx-1b');
    expect(s).not.toContain('dev-openid-me-wx-1"'); // before 完整值同样掩码
  });

  it('admin 清除:ops-admin → 200 置空 + audit wechat.clear.by-admin(掩码);再清幂等不写 audit;USER 无码 → 30100', async () => {
    const res = await adminClear(opsHeader, u1Id);
    expect(res.status).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: u1Id },
      select: { openid: true },
    });
    expect(row.openid).toBeNull();
    const clearCount1 = await prisma.auditLog.count({ where: { event: 'wechat.clear.by-admin' } });
    expect(clearCount1).toBe(1);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { event: 'wechat.clear.by-admin' },
    });
    expect(JSON.stringify(audit)).not.toContain('dev-openid-me-wx-1b');

    // 幂等:目标已无 openid → 200 且不再写 audit
    const again = await adminClear(opsHeader, u1Id);
    expect(again.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { event: 'wechat.clear.by-admin' } })).toBe(1);

    // 清除后该 openid 可被他人绑定(占用释放)
    const rebind = await putWechat(u2Header, 'me-wx-1b');
    expect(rebind.status).toBe(200);

    // RBAC 反向:无码 USER → 30100
    expectBizError(await adminClear(userHeader, u2Id), BizCode.RBAC_FORBIDDEN);
  });

  it('UserResponseDto 不含 openid(userSafeSelect 不滥回显;admin 清除响应核验)', async () => {
    const res = await adminClear(opsHeader, u2Id);
    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('openid');
  });
});
