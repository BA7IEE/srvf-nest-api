import type { INestApplication } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import appConfig from '../../src/config/app.config';
import { PrismaService } from '../../src/database/prisma.service';
import {
  deriveSmsCodePepperKey,
  hashSmsVerificationCode,
} from '../../src/modules/sms/sms-code-hash.util';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser, TEST_PASSWORD } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// SMS 基础设施 T3 e2e 第 2 组:绑定 → 换绑 → admin 清除 → 重绑全链(评审稿 §10)。
//
// 通道:DEV_STUB(test env 合法;固定码 888888,评审稿 E-29)。
// 本组聚焦业务语义,IP throttler 配额经 env 调大避免干扰(限流专测在 sms-throttle 组);
// 同号 60s 间隔为 DB 层常量,本组用"改 createdAt 回拨"绕过(不动业务代码)。

// 必须在 createTestApp 之前生效(app.config factory 注册时读取)
process.env.SMS_SEND_THROTTLE_LIMIT = '100';
process.env.SMS_VERIFY_THROTTLE_LIMIT = '100';
process.env.PASSWORD_CHANGE_THROTTLE_LIMIT = '100';

const SEND_PATH = '/api/app/v1/me/phone/send-code';
const BIND_PATH = '/api/app/v1/me/phone';
const FIXED_CODE = '888888';
const PHONE_A = '13811112222';
const PHONE_B = '13833334444';
const PHONE_C = '13855556666';

describe('App 手机号绑定全链(T3 e2e 组 2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let u1Header: string;
  let u2Header: string;
  let saHeader: string;
  let opsHeader: string;
  let u1Id: string;
  let u2Id: string;
  let smsCodePepperKey: Buffer;

  // 间隔回拨 helper:把某号最新 code 行的 createdAt 拨回 61s 前,绕开 60s 间隔
  async function rewindInterval(phone: string): Promise<void> {
    const latest = await prisma.smsVerificationCode.findFirst({
      where: { phone },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (latest) {
      await prisma.smsVerificationCode.update({
        where: { id: latest.id },
        data: { createdAt: new Date(Date.now() - 61_000) },
      });
    }
  }

  async function sendCode(header: string, phone: string): Promise<request.Response> {
    return request(httpServer(app)).post(SEND_PATH).set('Authorization', header).send({ phone });
  }

  async function bind(header: string, phone: string, code: string): Promise<request.Response> {
    const proof = await request(httpServer(app))
      .post('/api/auth/v1/step-up/password')
      .set('Authorization', header)
      .send({ action: 'PHONE_BIND', password: TEST_PASSWORD });
    expect(proof.status).toBe(200);
    return request(httpServer(app))
      .put(BIND_PATH)
      .set('Authorization', header)
      .send({ phone, code, stepUpToken: proof.body.data.stepUpToken });
  }

  beforeAll(async () => {
    app = await createTestApp();
    const cfg = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
    smsCodePepperKey = deriveSmsCodePepperKey(cfg.sms.encryptionKey);
    prisma = app.get(PrismaService);
    await resetDb(app);

    // DEV_STUB 通道(test env 合法)
    await prisma.smsSettings.create({
      data: { providerType: 'DEV_STUB', enabled: true },
    });

    const { opsAdminRoleId } = await seedRbacPermissionsAndOpsAdmin(app);
    // user.phone.clear 绑 ops-admin(评审稿 E-3;主 seed 之外 spec 自带,沿 attachments 范式)
    const perm = await prisma.permission.upsert({
      where: { code: 'user.phone.clear' },
      update: {},
      create: { code: 'user.phone.clear', module: 'user', action: 'clear', resourceType: 'phone' },
      select: { id: true },
    });
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: opsAdminRoleId, permissionId: perm.id } },
      update: {},
      create: { roleId: opsAdminRoleId, permissionId: perm.id },
    });

    const u1 = await createTestUser(app, { username: 'phone_u1' });
    const u2 = await createTestUser(app, { username: 'phone_u2' });
    const sa = await createTestUser(app, { username: 'phone_sa', role: Role.SUPER_ADMIN });
    const ops = await createTestUser(app, { username: 'phone_ops', role: Role.ADMIN });
    await grantOpsAdminToUser(app, ops.id, opsAdminRoleId);
    u1Id = u1.id;
    u2Id = u2.id;
    void sa;

    u1Header = (await loginAs(app, 'phone_u1')).authHeader;
    u2Header = (await loginAs(app, 'phone_u2')).authHeader;
    saHeader = (await loginAs(app, 'phone_sa')).authHeader;
    opsHeader = (await loginAs(app, 'phone_ops')).authHeader;
  });

  afterAll(async () => {
    await app.close();
    // 还原 env(runInBand 下各 spec 文件共享进程;sms-throttle 组自行设值,这里只做卫生还原)
    delete process.env.SMS_SEND_THROTTLE_LIMIT;
    delete process.env.SMS_VERIFY_THROTTLE_LIMIT;
    delete process.env.PASSWORD_CHANGE_THROTTLE_LIMIT;
  });

  describe('send-code 入参与准入', () => {
    it('无 token → 40100', async () => {
      const res = await request(httpServer(app)).post(SEND_PATH).send({ phone: PHONE_A });
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it.each([
      ['10 位', '1381111222'],
      ['带 +86', '+8613811112222'],
      ['含字母', '1381111222a'],
      ['12 开头非法段', '12811112222'],
    ])('phone 格式非法(%s)→ 40000', async (_label, phone) => {
      const res = await sendCode(u1Header, phone);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('正常发码 → 200 expiresInSeconds=300;明文码不入库(只存域分离 HMAC)+ send_log SENT 关联', async () => {
      const res = await sendCode(u1Header, PHONE_A);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ expiresInSeconds: 300 });
      // 响应不含码
      expect(JSON.stringify(res.body)).not.toContain(FIXED_CODE);

      const row = await prisma.smsVerificationCode.findFirstOrThrow({
        where: { phone: PHONE_A },
        orderBy: { createdAt: 'desc' },
      });
      expect(row.codeHash).toBe(
        hashSmsVerificationCode(
          { phone: PHONE_A, purpose: 'PHONE_BIND', code: FIXED_CODE },
          smsCodePepperKey,
        ),
      );
      expect(row.codeHash).not.toContain(FIXED_CODE);
      expect(row.userId).toBe(u1Id);
      expect(row.purpose).toBe('PHONE_BIND');

      const log = await prisma.smsSendLog.findFirstOrThrow({ where: { phone: PHONE_A } });
      expect(log.status).toBe('SENT');
      expect(log.providerType).toBe('DEV_STUB');
      expect(log.templateKey).toBe('verify-code');
      expect(log.codeId).toBe(row.id);
    });
  });

  describe('验码绑定 / 换绑 / 归属 / 占用', () => {
    it('错码 → 24010 统一码;attempts+1 落库', async () => {
      const res = await bind(u1Header, PHONE_A, '000000');
      expectBizError(res, BizCode.SMS_CODE_INVALID);
      const row = await prisma.smsVerificationCode.findFirstOrThrow({
        where: { phone: PHONE_A, consumedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      expect(row.attempts).toBe(1);
    });

    it('u2 持 u1 的活码验绑 → 24010(归属不符,统一码不细分)', async () => {
      const res = await bind(u2Header, PHONE_A, FIXED_CODE);
      expectBizError(res, BizCode.SMS_CODE_INVALID);
    });

    it('正确码 → 200 {phone, phoneVerifiedAt};User 落库;码已消费;audit phone.bind.self 掩码', async () => {
      const res = await bind(u1Header, PHONE_A, FIXED_CODE);
      expect(res.status).toBe(200);
      expect(res.body.data.phone).toBe(PHONE_A);
      expect(typeof res.body.data.phoneVerifiedAt).toBe('string');

      const user = await prisma.user.findUniqueOrThrow({ where: { id: u1Id } });
      expect(user.phone).toBe(PHONE_A);
      expect(user.phoneVerifiedAt).not.toBeNull();

      const code = await prisma.smsVerificationCode.findFirstOrThrow({
        where: { phone: PHONE_A },
        orderBy: { createdAt: 'desc' },
      });
      expect(code.consumedAt).not.toBeNull();

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { event: 'phone.bind.self', resourceId: u1Id },
      });
      const context = audit.context as { after?: { phone?: string }; extra?: { codeId?: string } };
      expect(context.after?.phone).toBe('138****2222');
      expect(context.extra?.codeId).toBe(code.id);
      // detail 不含完整号码与明文码 / codeHash
      const serialized = JSON.stringify(audit.context);
      expect(serialized).not.toContain(PHONE_A);
      expect(serialized).not.toContain(FIXED_CODE);
      expect(serialized).not.toContain(code.codeHash);
    });

    it('绑定成功后同目标重放 → 幂等 200，不撤 refresh、不写第二条变更 audit', async () => {
      const before = await prisma.auditLog.count({
        where: { event: { in: ['phone.bind.self', 'phone.rebind.self'] }, resourceId: u1Id },
      });
      const res = await bind(u1Header, PHONE_A, FIXED_CODE);
      expect(res.status).toBe(200);
      expect(res.body.data.phone).toBe(PHONE_A);
      expect(
        await prisma.auditLog.count({
          where: { event: { in: ['phone.bind.self', 'phone.rebind.self'] }, resourceId: u1Id },
        }),
      ).toBe(before);
    });

    it('send-code 已被他人绑定的号(u2 → PHONE_A)→ 24002', async () => {
      const res = await sendCode(u2Header, PHONE_A);
      expectBizError(res, BizCode.PHONE_ALREADY_BOUND);
    });

    it('send-code 自己已绑的同号(u1 → PHONE_A)→ 24002(不提供重新验证语义)', async () => {
      const res = await sendCode(u1Header, PHONE_A);
      expectBizError(res, BizCode.PHONE_ALREADY_BOUND);
    });

    it('换绑:u1 → PHONE_B 验绑成功;audit phone.rebind.self before/after 掩码;旧号释放', async () => {
      expect((await sendCode(u1Header, PHONE_B)).status).toBe(200);
      const res = await bind(u1Header, PHONE_B, FIXED_CODE);
      expect(res.status).toBe(200);
      expect(res.body.data.phone).toBe(PHONE_B);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { event: 'phone.rebind.self', resourceId: u1Id },
      });
      const context = audit.context as { before?: { phone?: string }; after?: { phone?: string } };
      expect(context.before?.phone).toBe('138****2222');
      expect(context.after?.phone).toBe('138****4444');

      // 旧号 PHONE_A 已释放:u2 可对其发码(先回拨,PHONE_A 最近一条码行仍在 60s 间隔内)
      await rewindInterval(PHONE_A);
      const res2 = await sendCode(u2Header, PHONE_A);
      expect(res2.status).toBe(200);
    });

    it('admin without member 也可绑定(E-5 账号级豁免):SA 自身发码+验绑成功', async () => {
      expect((await sendCode(saHeader, PHONE_C)).status).toBe(200);
      const res = await bind(saHeader, PHONE_C, FIXED_CODE);
      expect(res.status).toBe(200);
      expect(res.body.data.phone).toBe(PHONE_C);
    });
  });

  describe('admin 清除(⑦)', () => {
    it('USER 调清号 → 30100;ops-admin(绑 user.phone.clear)→ 200', async () => {
      expectBizError(
        await request(httpServer(app))
          .delete(`/api/admin/v1/users/${u1Id}/phone`)
          .set('Authorization', u2Header),
        BizCode.RBAC_FORBIDDEN,
      );

      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/users/${u1Id}/phone`)
        .set('Authorization', opsHeader);
      expect(res.status).toBe(200);
      // UserResponseDto 字段集不变(不含 phone;E-6),不出现 passwordHash
      expect(res.body.data).not.toHaveProperty('phone');
      expect(res.body.data).not.toHaveProperty('passwordHash');

      const user = await prisma.user.findUniqueOrThrow({ where: { id: u1Id } });
      expect(user.phone).toBeNull();
      expect(user.phoneVerifiedAt).toBeNull();

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { event: 'phone.clear.by-admin', resourceId: u1Id },
      });
      expect((audit.context as { before?: { phone?: string } }).before?.phone).toBe('138****4444');
    });

    it('幂等再清(目标无 phone)→ 200 且不写第二条 audit', async () => {
      const before = await prisma.auditLog.count({
        where: { event: 'phone.clear.by-admin', resourceId: u1Id },
      });
      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/users/${u1Id}/phone`)
        .set('Authorization', saHeader);
      expect(res.status).toBe(200);
      const after = await prisma.auditLog.count({
        where: { event: 'phone.clear.by-admin', resourceId: u1Id },
      });
      expect(after).toBe(before);
    });

    it('清除后该号可被他人重绑(占用释放)', async () => {
      await rewindInterval(PHONE_B);
      expect((await sendCode(u2Header, PHONE_B)).status).toBe(200);
      const res = await bind(u2Header, PHONE_B, FIXED_CODE);
      expect(res.status).toBe(200);
      expect(res.body.data.phone).toBe(PHONE_B);
    });

    it('目标不存在 / 已软删 → 统一 10001', async () => {
      const fake = 'clxxx0000000000000000000';
      expectBizError(
        await request(httpServer(app))
          .delete(`/api/admin/v1/users/${fake}/phone`)
          .set('Authorization', saHeader),
        BizCode.USER_NOT_FOUND,
      );

      // 软删占用:u3 绑 PHONE_C2 后软删,清号统一 10001 且号码不释放(E-7)
      const u3 = await createTestUser(app, { username: 'phone_u3' });
      const phoneC2 = '13877778888';
      await prisma.user.update({
        where: { id: u3.id },
        data: { phone: phoneC2, phoneVerifiedAt: new Date(), deletedAt: new Date() },
      });
      expectBizError(
        await request(httpServer(app))
          .delete(`/api/admin/v1/users/${u3.id}/phone`)
          .set('Authorization', saHeader),
        BizCode.USER_NOT_FOUND,
      );
      // 软删占用仍挡新绑定
      expectBizError(await sendCode(u2Header, phoneC2), BizCode.PHONE_ALREADY_BOUND);
    });
  });

  describe('绑定竞态拦截(占用复查;真 P2002 窗口由 service catch 兜底,unit 不可达 e2e 不强造)', () => {
    it('发码后号被他人占用,验绑时占用复查 → 24002(码未消费)', async () => {
      const phoneC3 = '13899990000';
      expect((await sendCode(u1Header, phoneC3)).status).toBe(200);
      // 模拟竞态:他人在验码窗口内占用该号(直改 DB 绕过 send-code 预检)
      await prisma.user.update({ where: { id: u2Id }, data: { phone: phoneC3 } });
      const res = await bind(u1Header, phoneC3, FIXED_CODE);
      expectBizError(res, BizCode.PHONE_ALREADY_BOUND);
      // 占用复查在验码之前,码未被消费
      const code = await prisma.smsVerificationCode.findFirstOrThrow({
        where: { phone: phoneC3 },
        orderBy: { createdAt: 'desc' },
      });
      expect(code.consumedAt).toBeNull();
    });
  });
});
