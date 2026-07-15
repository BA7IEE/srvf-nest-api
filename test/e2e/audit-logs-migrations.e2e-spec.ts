import type { INestApplication } from '@nestjs/common';
import { DictItemStatus, Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { truncateAuditLogsTestOnly } from '../helpers/audit-logs-cleanup';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2 第一阶段批次 6 PR #2 / PR #3 e2e:
// PR #2:验证 8 处 emergency-contacts / certificates 写操作迁移到 AuditLogsService.log()
// PR #3(第二波第一步):验证 3 处 contribution-rules 写操作迁移到 AuditLogsService.log()
// 的实际写库行为(D6 v1.1 §12 矩阵 / §8.4 未迁移清单)。
//
// 与 audit-logs.e2e-spec.ts(PR #1)互补:
// - PR #1 spec:通过 AuditLogsService.log() 直接造数据,测查询接口 + 权限 + 不审计自身
// - 本 spec :通过 HTTP 调用业务 controller,测迁移 hook 实际写入 audit_logs

describe('audit-logs 写入迁移', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAuth: string;
  let adminId: string;
  // 终态 scoped-authz PR9:第二身份专职终审(submit/一级审是 adminAuth —— 自审 22074 /
  // 同人 22075 约束后同一人不能终审到底);摘码微刀(2026-07-03):biz-admin 不再持终审两码,
  // 终审身份换 SUPER_ADMIN(SA 兜底通路;audit 断言本身零修改)。
  let finalAdminAuth: string;

  let memberId: string;
  let relationCode: string;
  let certTypeCode: string;

  // PR #3 fixtures
  let activityTypeCode: string;
  let roleCode: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const admin = await createTestUser(app, { username: 'al-mig-adm', role: Role.ADMIN });
    adminId = admin.id;
    adminAuth = (await loginAs(app, 'al-mig-adm')).authHeader;

    // P0-F PR-2A:contribution-rules 写操作入口已切到 rbac.can();ADMIN 默认无 ops-admin
    // 会被 30100 拦下,导致 audit log 不会写;此处给 adminId grant ops-admin(模拟运维 SOP)。
    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    await grantOpsAdminToUser(app, adminId, seed.opsAdminRoleId);

    // Slow-4 T2(2026-06-11,评审稿 §8):emergency-contacts / certificates 写操作
    // 也已切到 service 层 rbac.can(),ADMIN 测试用户统一补挂 biz-admin。
    const bizSeed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, adminId, bizSeed.bizAdminRoleId);

    // PR9 第二终审身份;摘码微刀(2026-07-03)后为 SUPER_ADMIN(见上方 finalAdminAuth 注释)
    await createTestUser(app, {
      username: 'al-mig-final-adm',
      role: Role.SUPER_ADMIN,
    });
    finalAdminAuth = (await loginAs(app, 'al-mig-final-adm')).authHeader;

    // emergency_relation 字典
    const relType = await prisma.dictType.create({
      data: { code: 'emergency_relation', label: 'Emergency Relation' },
      select: { id: true },
    });
    const relItem = await prisma.dictItem.create({
      data: {
        typeId: relType.id,
        code: 'demo-rel-family',
        label: 'family',
        status: DictItemStatus.ACTIVE,
      },
      select: { code: true },
    });
    relationCode = relItem.code;

    // cert_type 字典
    const certType = await prisma.dictType.create({
      data: { code: 'cert_type', label: 'Cert Type' },
      select: { id: true },
    });
    const certItem = await prisma.dictItem.create({
      data: {
        typeId: certType.id,
        code: 'demo-cert-rescue',
        label: 'Rescue',
        status: DictItemStatus.ACTIVE,
      },
      select: { code: true },
    });
    certTypeCode = certItem.code;

    // member
    const m = await prisma.member.create({
      data: { memberNo: 'al-mig-mem', displayName: 'Member For Migration Tests' },
      select: { id: true },
    });
    memberId = m.id;

    // PR #3 fixtures:activity_type 字典(contribution-rule.create / update / delete 校验依赖)
    const actType = await prisma.dictType.create({
      data: { code: 'activity_type', label: 'Activity Type' },
      select: { id: true },
    });
    const actItem = await prisma.dictItem.create({
      data: {
        typeId: actType.id,
        code: 'demo-act-search',
        label: 'Search',
        status: DictItemStatus.ACTIVE,
      },
      select: { code: true },
    });
    activityTypeCode = actItem.code;

    // PR #3 fixtures:attendance_role 字典
    const roleType = await prisma.dictType.create({
      data: { code: 'attendance_role', label: 'Attendance Role' },
      select: { id: true },
    });
    const roleItem = await prisma.dictItem.create({
      data: {
        typeId: roleType.id,
        code: 'demo-role-lead',
        label: 'Lead',
        status: DictItemStatus.ACTIVE,
      },
      select: { code: true },
    });
    roleCode = roleItem.code;
  });

  afterAll(async () => {
    await app.close();
  });

  // 每个测试块前清空 audit_logs,保证 count() 断言隔离。
  beforeEach(async () => {
    await truncateAuditLogsTestOnly(app);
  });

  // ============ Helpers ============

  // 创建一条 emergency_contact,返回 id;用于 update / softDelete 前置数据
  // NestJS POST 默认 201;controller 未声明 @HttpCode,沿默认。
  const createContact = async (
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; contactName: string; phonePrimary: string; address: string | null }> => {
    const res = await request(httpServer(app))
      .post(`/api/admin/v1/members/${memberId}/emergency-contacts`)
      .set('Authorization', adminAuth)
      .send({
        contactName: '张三',
        relationCode,
        phonePrimary: '13800001111',
        address: '广东省深圳市福田区莲花街道彩田路某号',
        ...overrides,
      });
    expect(res.status).toBe(201);
    return res.body.data;
  };

  // 创建一条 pending 状态 certificate,返回 id;用于 update / softDelete / verify / reject 前置
  const createCert = async (): Promise<{ id: string; certNumber: string | null }> => {
    const res = await request(httpServer(app))
      .post(`/api/admin/v1/members/${memberId}/certificates`)
      .set('Authorization', adminAuth)
      .send({
        certTypeCode,
        issuingOrg: 'Demo Issuing Org',
        certNumber: 'CN-2026-0001',
        issuedAt: '2026-01-01T00:00:00.000Z',
      });
    expect(res.status).toBe(201);
    return res.body.data;
  };

  // PR #3:创建一条 ACTIVE contribution-rule,返回 id;用于 update / softDelete 前置数据
  const createRule = async (
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; pointsBelow: number; remark: string | null; status: string }> => {
    const res = await request(httpServer(app))
      .post('/api/system/v1/contribution-rules')
      .set('Authorization', adminAuth)
      .send({
        activityTypeCode,
        attendanceRoleCode: roleCode,
        pointsBelow: 1.5,
        ...overrides,
      });
    expect(res.status).toBe(201);
    return res.body.data;
  };

  // ============ 8 处迁移 hook 触发 ============

  describe('迁移 hook 触发(8 处)', () => {
    it('POST emergency-contact 创建 → audit_logs 含 emergency-contact.write', async () => {
      // beforeEach 清表,这里只调一次写操作
      await createContact();
      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      const log = logs[0];
      expect(log.event).toBe('emergency-contact.write');
      expect(log.resourceType).toBe('emergency_contact');
      expect(log.resourceId).not.toBeNull();
      expect(log.actorUserId).toBe(adminId);
      expect(log.actorRoleSnap).toBe(Role.ADMIN);
      expect(log.success).toBe(true);
    });

    it('PATCH emergency-contact 更新 → audit_logs +1', async () => {
      const c = await createContact();
      await truncateAuditLogsTestOnly(app); // 清掉 create 留下的记录,只留 update

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/emergency-contacts/${c.id}`)
        .set('Authorization', adminAuth)
        .send({ priority: 1 });
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].event).toBe('emergency-contact.write');
      expect(logs[0].resourceId).toBe(c.id);
    });

    it('DELETE emergency-contact 软删 → audit_logs +1', async () => {
      const c = await createContact();
      await truncateAuditLogsTestOnly(app);

      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/members/${memberId}/emergency-contacts/${c.id}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].event).toBe('emergency-contact.write');
      expect(logs[0].resourceId).toBe(c.id);
    });

    it('POST certificate 创建 → audit_logs 含 certificate.create', async () => {
      const c = await createCert();
      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].event).toBe('certificate.create');
      expect(logs[0].resourceType).toBe('certificate');
      expect(logs[0].resourceId).toBe(c.id);
    });

    it('PATCH certificate 更新 → audit_logs +1 certificate.update', async () => {
      const c = await createCert();
      await truncateAuditLogsTestOnly(app);

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/certificates/${c.id}`)
        .set('Authorization', adminAuth)
        .send({ issuingOrg: 'Updated Issuing Org' });
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].event).toBe('certificate.update');
      expect(logs[0].resourceId).toBe(c.id);
    });

    it('DELETE certificate 软删 → audit_logs +1 certificate.delete', async () => {
      const c = await createCert();
      await truncateAuditLogsTestOnly(app);

      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/members/${memberId}/certificates/${c.id}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].event).toBe('certificate.delete');
    });

    it('PATCH certificate verify → audit_logs +1 certificate.verify', async () => {
      const c = await createCert();
      await truncateAuditLogsTestOnly(app);

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/certificates/${c.id}/verify`)
        .set('Authorization', adminAuth)
        .send({ verifyNote: 'OK' });
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].event).toBe('certificate.verify');
    });

    it('PATCH certificate reject → audit_logs +1 certificate.reject', async () => {
      const c = await createCert();
      await truncateAuditLogsTestOnly(app);

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/certificates/${c.id}/reject`)
        .set('Authorization', adminAuth)
        .send({ verifyNote: '材料不全' });
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].event).toBe('certificate.reject');
    });
  });

  // ============ before / after 结构 ============

  describe('before / after 结构', () => {
    it('emergency-contact create:context 含 after,不含 before', async () => {
      const c = await createContact();
      const log = (await prisma.auditLog.findFirst({ where: { resourceId: c.id } }))!;
      const ctx = log.context as Record<string, unknown>;
      expect(ctx.after).toBeDefined();
      expect(ctx.before).toBeUndefined();
    });

    it('emergency-contact update:context 同时含 before 与 after', async () => {
      const c = await createContact();
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/emergency-contacts/${c.id}`)
        .set('Authorization', adminAuth)
        .send({ priority: 2 })
        .expect(200);

      const log = (await prisma.auditLog.findFirst({ where: { resourceId: c.id } }))!;
      const ctx = log.context as Record<string, unknown>;
      expect(ctx.before).toBeDefined();
      expect(ctx.after).toBeDefined();
      // before.priority = 0 (default), after.priority = 2
      expect((ctx.after as { priority: number }).priority).toBe(2);
    });

    it('emergency-contact softDelete:context 含 before,不含 after', async () => {
      const c = await createContact();
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .delete(`/api/admin/v1/members/${memberId}/emergency-contacts/${c.id}`)
        .set('Authorization', adminAuth)
        .expect(200);

      const log = (await prisma.auditLog.findFirst({ where: { resourceId: c.id } }))!;
      const ctx = log.context as Record<string, unknown>;
      expect(ctx.before).toBeDefined();
      expect(ctx.after).toBeUndefined();
    });

    it('certificate verify:before.status + after.status + verifyNote', async () => {
      const c = await createCert();
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/certificates/${c.id}/verify`)
        .set('Authorization', adminAuth)
        .send({ verifyNote: '已核验' })
        .expect(200);

      const log = (await prisma.auditLog.findFirst({ where: { resourceId: c.id } }))!;
      const ctx = log.context as Record<string, unknown>;
      const before = ctx.before as { status: string };
      const after = ctx.after as { status: string; verifyNote: string };
      expect(before.status).toBe('pending');
      expect(after.status).toBe('verified');
      expect(after.verifyNote).toBe('已核验');
    });

    it('certificate reject:before.status=pending + after.status=rejected', async () => {
      const c = await createCert();
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/certificates/${c.id}/reject`)
        .set('Authorization', adminAuth)
        .send({ verifyNote: '材料不全' })
        .expect(200);

      const log = (await prisma.auditLog.findFirst({ where: { resourceId: c.id } }))!;
      const ctx = log.context as Record<string, unknown>;
      const before = ctx.before as { status: string };
      const after = ctx.after as { status: string; verifyNote: string };
      expect(before.status).toBe('pending');
      expect(after.status).toBe('rejected');
      expect(after.verifyNote).toBe('材料不全');
    });
  });

  // ============ 敏感字段打码 ============

  describe('敏感字段打码', () => {
    it('emergency-contact create:contactName / phonePrimary / address 已打码,relationCode 不打码', async () => {
      const c = await createContact({
        contactName: '欧阳静雯',
        phonePrimary: '13912345678',
        address: '广东省深圳市福田区莲花街道',
      });
      const log = (await prisma.auditLog.findFirst({ where: { resourceId: c.id } }))!;
      const after = (log.context as { after: Record<string, unknown> }).after;
      expect(after.contactName).toBe('欧***'); // maskName(4 字)= 首字符 + 3 个 *
      expect(after.phonePrimary).toBe('139****5678'); // maskPhone
      expect(after.address).toBe('广东省深圳市******'); // maskAddress 保留前 6
      expect(after.relationCode).toBe(relationCode); // 字典 code 不打码
    });

    it('emergency-contact update:before 与 after 的敏感字段都已打码', async () => {
      const c = await createContact({
        contactName: '张三',
        phonePrimary: '13800001111',
      });
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/emergency-contacts/${c.id}`)
        .set('Authorization', adminAuth)
        .send({ contactName: '李四五' })
        .expect(200);

      const log = (await prisma.auditLog.findFirst({ where: { resourceId: c.id } }))!;
      const ctx = log.context as {
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      };
      expect(ctx.before.contactName).toBe('张*'); // 原 "张三" → "张*"
      expect(ctx.before.phonePrimary).toBe('138****1111');
      expect(ctx.after.contactName).toBe('李**'); // 改后 "李四五" → "李**"
    });

    it('emergency-contact softDelete:before 敏感字段已打码', async () => {
      const c = await createContact({ contactName: '王二', phonePrimary: '13700007777' });
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .delete(`/api/admin/v1/members/${memberId}/emergency-contacts/${c.id}`)
        .set('Authorization', adminAuth)
        .expect(200);

      const log = (await prisma.auditLog.findFirst({ where: { resourceId: c.id } }))!;
      const before = (log.context as { before: Record<string, unknown> }).before;
      expect(before.contactName).toBe('王*');
      expect(before.phonePrimary).toBe('137****7777');
    });

    it('phoneBackup null:打码后仍 null(短路边界)', async () => {
      const c = await createContact({ phoneBackup: null }); // 未传 = undefined,打码后 null
      const log = (await prisma.auditLog.findFirst({ where: { resourceId: c.id } }))!;
      const after = (log.context as { after: Record<string, unknown> }).after;
      expect(after.phoneBackup).toBeNull();
    });

    it('certificate.certNumber:不在打码矩阵,原值入 audit', async () => {
      const c = await createCert();
      const log = (await prisma.auditLog.findFirst({ where: { resourceId: c.id } }))!;
      const after = (log.context as { after: Record<string, unknown> }).after;
      expect(after.certNumber).toBe('CN-2026-0001'); // 原值,无 mask
    });

    it('certificate.certTypeCode / issuingOrg:不在打码矩阵', async () => {
      const c = await createCert();
      const log = (await prisma.auditLog.findFirst({ where: { resourceId: c.id } }))!;
      const after = (log.context as { after: Record<string, unknown> }).after;
      expect(after.certTypeCode).toBe(certTypeCode);
      expect(after.issuingOrg).toBe('Demo Issuing Org');
    });
  });

  // ============ 同事务行为(业务前置校验失败 → audit 与业务都不入表) ============

  describe('同事务行为', () => {
    it('emergency-contact create relationCode invalid:audit_logs 不入表 + emergency_contact 不入表', async () => {
      const ecBefore = await prisma.emergencyContact.count();
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberId}/emergency-contacts`)
        .set('Authorization', adminAuth)
        .send({
          contactName: '张三',
          relationCode: 'non-existent-code',
          phonePrimary: '13800001111',
        });
      expect(res.status).toBe(400);

      const logs = await prisma.auditLog.count();
      const ecAfter = await prisma.emergencyContact.count();
      expect(logs).toBe(0);
      expect(ecAfter).toBe(ecBefore); // 业务也未入表
    });

    it('certificate verify 状态机非 pending:audit_logs 不入表 + cert 状态不变', async () => {
      const c = await createCert();
      // 先 verify 一次 → verified
      await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/certificates/${c.id}/verify`)
        .set('Authorization', adminAuth)
        .send({ verifyNote: 'OK' })
        .expect(200);

      await truncateAuditLogsTestOnly(app); // 清掉前两条 audit

      // 再 verify → CERTIFICATE_INVALID_STATE_TRANSITION (409)
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/certificates/${c.id}/verify`)
        .set('Authorization', adminAuth)
        .send({ verifyNote: 'OK 2' });
      expect(res.status).toBe(409);

      const logs = await prisma.auditLog.count();
      expect(logs).toBe(0);
    });
  });

  // ============ 未迁移路径不入库(read 类继续 pino-only) ============

  describe('未迁移路径不入库', () => {
    it('GET emergency-contacts list:audit_logs 无新记录', async () => {
      const before = await prisma.auditLog.count();
      await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberId}/emergency-contacts`)
        .set('Authorization', adminAuth)
        .expect(200);
      const after = await prisma.auditLog.count();
      expect(after).toBe(before);
    });

    it('GET certificates list:audit_logs 无新记录', async () => {
      const before = await prisma.auditLog.count();
      await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberId}/certificates`)
        .set('Authorization', adminAuth)
        .expect(200);
      const after = await prisma.auditLog.count();
      expect(after).toBe(before);
    });

    it('GET certificates qualification-flag:audit_logs 无新记录', async () => {
      const before = await prisma.auditLog.count();
      await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberId}/certificates/qualification-flag`)
        .query({ certTypeCode })
        .set('Authorization', adminAuth)
        .expect(200);
      const after = await prisma.auditLog.count();
      expect(after).toBe(before);
    });

    it('GET certificate detail:audit_logs 无新记录', async () => {
      const c = await createCert();
      await truncateAuditLogsTestOnly(app);
      await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberId}/certificates/${c.id}`)
        .set('Authorization', adminAuth)
        .expect(200);
      const logs = await prisma.auditLog.count();
      expect(logs).toBe(0);
    });
  });

  // ============ PR #3:contribution-rules 写操作迁移(第二波第一步) ============

  describe('contribution-rules 写操作迁移(PR #3)', () => {
    // 每个 it 前清贡献规则,避免 ACTIVE 唯一性冲突;外层 beforeEach 已清 audit_logs
    beforeEach(async () => {
      await prisma.contributionRule.deleteMany({});
    });

    it('POST 触发 → audit_logs +1 contribution-rule.create', async () => {
      const r = await createRule();
      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      const log = logs[0];
      expect(log.event).toBe('contribution-rule.create');
      expect(log.resourceType).toBe('contribution_rule');
      expect(log.resourceId).toBe(r.id);
      expect(log.actorUserId).toBe(adminId);
      expect(log.actorRoleSnap).toBe(Role.ADMIN);
      expect(log.success).toBe(true);
    });

    it('PATCH 触发 → audit_logs +1 contribution-rule.update', async () => {
      const r = await createRule();
      await truncateAuditLogsTestOnly(app); // 清掉 create 的 audit,仅看 update

      const res = await request(httpServer(app))
        .patch(`/api/system/v1/contribution-rules/${r.id}`)
        .set('Authorization', adminAuth)
        .send({ remark: 'updated remark' });
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].event).toBe('contribution-rule.update');
      expect(logs[0].resourceId).toBe(r.id);
    });

    it('DELETE 触发 → audit_logs +1 contribution-rule.delete (204)', async () => {
      const r = await createRule();
      await truncateAuditLogsTestOnly(app);

      const res = await request(httpServer(app))
        .delete(`/api/system/v1/contribution-rules/${r.id}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(204); // controller @HttpCode(NO_CONTENT)

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].event).toBe('contribution-rule.delete');
      expect(logs[0].resourceId).toBe(r.id);
    });

    it('context 锁形:requestId 非空字符串,ip / ua 字段存在', async () => {
      const r = await createRule();
      const log = (await prisma.auditLog.findFirst({ where: { resourceId: r.id } }))!;
      const ctx = log.context as Record<string, unknown>;
      expect(typeof ctx.requestId).toBe('string');
      expect((ctx.requestId as string).length).toBeGreaterThan(0);
      expect('ip' in ctx).toBe(true);
      expect('ua' in ctx).toBe(true);
    });

    it('create:context 含 after,不含 before;after 含完整 8 字段;extra.operation=create', async () => {
      const r = await createRule({ pointsBelow: 2.0, durationThreshold: 3, pointsAbove: 5 });
      const log = (await prisma.auditLog.findFirst({ where: { resourceId: r.id } }))!;
      const ctx = log.context as Record<string, unknown>;
      expect(ctx.before).toBeUndefined();
      expect(ctx.after).toBeDefined();
      const after = ctx.after as Record<string, unknown>;
      expect(after.activityTypeCode).toBe(activityTypeCode);
      expect(after.attendanceRoleCode).toBe(roleCode);
      expect(after.durationThreshold).toBe(3);
      expect(after.pointsBelow).toBe(2);
      expect(after.pointsAbove).toBe(5);
      expect(after.dailyCap).toBeNull();
      expect(after.status).toBe('ACTIVE');
      expect(after.remark).toBeNull();
      const extra = ctx.extra as { operation: string };
      expect(extra.operation).toBe('create');
    });

    it('update:context 同时含 before / after,extra.changedFields = Object.keys(dto)', async () => {
      const r = await createRule();
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .patch(`/api/system/v1/contribution-rules/${r.id}`)
        .set('Authorization', adminAuth)
        .send({ pointsBelow: 3, remark: 'rev' })
        .expect(200);

      const log = (await prisma.auditLog.findFirst({ where: { resourceId: r.id } }))!;
      const ctx = log.context as {
        before: Record<string, unknown>;
        after: Record<string, unknown>;
        extra: { operation: string; changedFields: string[] };
      };
      expect(ctx.before.pointsBelow).toBe(1.5);
      expect(ctx.before.remark).toBeNull();
      expect(ctx.after.pointsBelow).toBe(3);
      expect(ctx.after.remark).toBe('rev');
      expect(ctx.extra.operation).toBe('update');
      // changedFields = Object.keys(dto):ValidationPipe transform=true 后,
      // UpdateContributionRuleDto 所有 @IsOptional() 字段都会出现在 instance own keys
      // (值可能是 undefined)。本批次是"迁移"非"改语义",沿用 PR #3 之前 auditPlaceholder
      // 写下的 Object.keys(dto) 行为不变。e2e 仅断言"客户端实际传的字段"必在,不收紧总集。
      expect(ctx.extra.changedFields).toEqual(expect.arrayContaining(['pointsBelow', 'remark']));
    });

    it('delete:context 含 before 完整,不含 after;extra.priorStatus=ACTIVE', async () => {
      const r = await createRule({ remark: 'pre-delete' });
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .delete(`/api/system/v1/contribution-rules/${r.id}`)
        .set('Authorization', adminAuth)
        .expect(204);

      const log = (await prisma.auditLog.findFirst({ where: { resourceId: r.id } }))!;
      const ctx = log.context as {
        before: Record<string, unknown>;
        after?: unknown;
        extra: { operation: string; priorStatus: string };
      };
      expect(ctx.before.remark).toBe('pre-delete');
      expect(ctx.before.status).toBe('ACTIVE');
      expect(ctx.after).toBeUndefined();
      expect(ctx.extra.operation).toBe('softDelete');
      expect(ctx.extra.priorStatus).toBe('ACTIVE');
    });

    it('同事务回滚:activityTypeCode invalid → audit 不入表 + contribution_rule 不入表', async () => {
      const crBefore = await prisma.contributionRule.count();
      const auditBefore = await prisma.auditLog.count();

      const res = await request(httpServer(app))
        .post('/api/system/v1/contribution-rules')
        .set('Authorization', adminAuth)
        .send({
          activityTypeCode: 'non-existent-code',
          attendanceRoleCode: roleCode,
          pointsBelow: 1.5,
        });
      expect(res.status).toBe(400);

      expect(await prisma.contributionRule.count()).toBe(crBefore);
      expect(await prisma.auditLog.count()).toBe(auditBefore);
    });

    it('GET list:audit_logs 无新记录(未迁移 read 路径)', async () => {
      await createRule();
      await truncateAuditLogsTestOnly(app);
      await request(httpServer(app))
        .get('/api/system/v1/contribution-rules')
        .set('Authorization', adminAuth)
        .expect(200);
      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('GET detail:audit_logs 无新记录(未迁移 read 路径)', async () => {
      const r = await createRule();
      await truncateAuditLogsTestOnly(app);
      await request(httpServer(app))
        .get(`/api/system/v1/contribution-rules/${r.id}`)
        .set('Authorization', adminAuth)
        .expect(200);
      expect(await prisma.auditLog.count()).toBe(0);
    });
  });

  // ============ PR #4:activities 写操作迁移(第二波第二步) ============

  describe('activities 写操作迁移(PR #4)', () => {
    let childOrgId: string;

    // PR #4 fixtures:node_type 字典 + root / child organization(activity 必须挂非根节点)
    beforeAll(async () => {
      const nodeType = await prisma.dictType.create({
        data: { code: 'node_type', label: 'Node Type' },
        select: { id: true },
      });
      await prisma.dictItem.create({
        data: { typeId: nodeType.id, code: 'al-mig-root', label: 'Root' },
      });
      await prisma.dictItem.create({
        data: { typeId: nodeType.id, code: 'al-mig-child', label: 'Child' },
      });
      const rootOrg = await prisma.organization.create({
        data: { name: 'AL Mig Root', nodeTypeCode: 'al-mig-root', parentId: null },
        select: { id: true },
      });
      const childOrg = await prisma.organization.create({
        data: {
          name: 'AL Mig Child',
          nodeTypeCode: 'al-mig-child',
          parentId: rootOrg.id,
        },
        select: { id: true },
      });
      childOrgId = childOrg.id;
    });

    // 每个 it 前清 activity,避免相互干扰;外层 beforeEach 已清 audit_logs
    beforeEach(async () => {
      await prisma.activity.deleteMany({});
    });

    // 创建一条 draft 活动,返回 id;用于 update / publish / cancel / softDelete 前置数据
    const createActivity = async (
      overrides: Record<string, unknown> = {},
    ): Promise<{ id: string; statusCode: string }> => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/activities')
        .set('Authorization', adminAuth)
        .send({
          title: '梧桐山轮值演练',
          activityTypeCode,
          organizationId: childOrgId,
          startAt: '2099-06-01T08:00:00.000Z',
          endAt: '2099-06-01T12:00:00.000Z',
          location: '梧桐山',
          ...overrides,
        });
      expect(res.status).toBe(201);
      return res.body.data;
    };

    it('POST 触发 → audit_logs +1 activity.publish(operation=create)', async () => {
      const a = await createActivity();
      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      const log = logs[0];
      expect(log.event).toBe('activity.publish');
      expect(log.resourceType).toBe('activity');
      expect(log.resourceId).toBe(a.id);
      expect(log.actorUserId).toBe(adminId);
      expect(log.actorRoleSnap).toBe(Role.ADMIN);
      expect(log.success).toBe(true);
      const extra = (log.context as { extra: { operation: string; nextStatusCode: string } }).extra;
      expect(extra.operation).toBe('create');
      expect(extra.nextStatusCode).toBe('draft');
    });

    it('PATCH 触发 → audit_logs +1(operation=update,extra 含 priorStatusCode + changedFields)', async () => {
      const a = await createActivity();
      await truncateAuditLogsTestOnly(app); // 清 create 留下的 audit

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/activities/${a.id}`)
        .set('Authorization', adminAuth)
        .send({ title: '更新标题' });
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].event).toBe('activity.publish');
      expect(logs[0].resourceId).toBe(a.id);
      const extra = (
        logs[0].context as {
          extra: { operation: string; priorStatusCode: string; changedFields: string[] };
        }
      ).extra;
      expect(extra.operation).toBe('update');
      expect(extra.priorStatusCode).toBe('draft');
      // changedFields = Object.keys(dto):ValidationPipe transform=true 后,DTO 所有
      // @IsOptional() 字段都会出现在 instance own keys(值可能是 undefined)。沿 PR #3 范式,
      // 仅断言"客户端实际传的字段必在",不收紧总集。
      expect(extra.changedFields).toEqual(expect.arrayContaining(['title']));
    });

    it('DELETE 软删触发 → audit_logs +1(operation=softDelete,priorStatusCode=draft)', async () => {
      const a = await createActivity();
      await truncateAuditLogsTestOnly(app);

      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/activities/${a.id}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].event).toBe('activity.publish');
      expect(logs[0].resourceId).toBe(a.id);
      const extra = (logs[0].context as { extra: { operation: string; priorStatusCode: string } })
        .extra;
      expect(extra.operation).toBe('softDelete');
      expect(extra.priorStatusCode).toBe('draft');
    });

    it('PATCH /:id/publish 触发 → audit_logs +1(operation=publish,draft → published)', async () => {
      const a = await createActivity();
      await truncateAuditLogsTestOnly(app);

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/activities/${a.id}/publish`)
        .set('Authorization', adminAuth)
        .send({ requiresInsuranceConfirmed: true });
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].event).toBe('activity.publish');
      const extra = (
        logs[0].context as {
          extra: { operation: string; priorStatusCode: string; nextStatusCode: string };
        }
      ).extra;
      expect(extra.operation).toBe('publish');
      expect(extra.priorStatusCode).toBe('draft');
      expect(extra.nextStatusCode).toBe('published');
    });

    it('PATCH /:id/cancel 触发 → audit_logs +1(operation=cancel,nextStatusCode=cancelled,带 cancelReason)', async () => {
      const a = await createActivity();
      await truncateAuditLogsTestOnly(app);

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/activities/${a.id}/cancel`)
        .set('Authorization', adminAuth)
        .send({ cancelReason: '雨天延期' });
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].event).toBe('activity.publish');
      const extra = (
        logs[0].context as {
          extra: {
            operation: string;
            priorStatusCode: string;
            nextStatusCode: string;
            cancelReason: string;
          };
        }
      ).extra;
      expect(extra.operation).toBe('cancel');
      expect(extra.priorStatusCode).toBe('draft');
      expect(extra.nextStatusCode).toBe('cancelled');
      expect(extra.cancelReason).toBe('雨天延期');
    });

    it('context 锁形:requestId 非空字符串,ip / ua 字段存在', async () => {
      const a = await createActivity();
      const log = (await prisma.auditLog.findFirst({ where: { resourceId: a.id } }))!;
      const ctx = log.context as Record<string, unknown>;
      expect(typeof ctx.requestId).toBe('string');
      expect((ctx.requestId as string).length).toBeGreaterThan(0);
      expect('ip' in ctx).toBe(true);
      expect('ua' in ctx).toBe(true);
    });

    it('create:context 含 after,不含 before;after 含完整字段集', async () => {
      const a = await createActivity({ description: 'demo desc' });
      const log = (await prisma.auditLog.findFirst({ where: { resourceId: a.id } }))!;
      const ctx = log.context as Record<string, unknown>;
      expect(ctx.before).toBeUndefined();
      expect(ctx.after).toBeDefined();
      const after = ctx.after as Record<string, unknown>;
      expect(after.title).toBe('梧桐山轮值演练');
      expect(after.activityTypeCode).toBe(activityTypeCode);
      expect(after.organizationId).toBe(childOrgId);
      expect(after.location).toBe('梧桐山');
      expect(after.description).toBe('demo desc');
      expect(after.statusCode).toBe('draft');
      expect(after.publishedBy).toBeNull();
      expect(after.publishedAt).toBeNull();
      expect(after.cancelledBy).toBeNull();
      expect(after.cancelledAt).toBeNull();
      expect(after.cancelReason).toBeNull();
    });

    it('update:context 同时含 before 与 after,扣后 before.title 是原值', async () => {
      const a = await createActivity({ description: '原描述' });
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .patch(`/api/admin/v1/activities/${a.id}`)
        .set('Authorization', adminAuth)
        .send({ description: '新描述' })
        .expect(200);

      const log = (await prisma.auditLog.findFirst({ where: { resourceId: a.id } }))!;
      const ctx = log.context as {
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      };
      expect(ctx.before.description).toBe('原描述');
      expect(ctx.after.description).toBe('新描述');
      expect(ctx.before.statusCode).toBe('draft');
      expect(ctx.after.statusCode).toBe('draft');
    });

    it('softDelete:context 含 before,不含 after;before.statusCode=draft', async () => {
      const a = await createActivity();
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .delete(`/api/admin/v1/activities/${a.id}`)
        .set('Authorization', adminAuth)
        .expect(200);

      const log = (await prisma.auditLog.findFirst({ where: { resourceId: a.id } }))!;
      const ctx = log.context as { before: Record<string, unknown>; after?: unknown };
      expect(ctx.before).toBeDefined();
      expect(ctx.before.statusCode).toBe('draft');
      expect(ctx.after).toBeUndefined();
    });

    it('publish:after.publishedBy / publishedAt 已写入', async () => {
      const a = await createActivity();
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .patch(`/api/admin/v1/activities/${a.id}/publish`)
        .set('Authorization', adminAuth)
        .send({ requiresInsuranceConfirmed: true })
        .expect(200);

      const log = (await prisma.auditLog.findFirst({ where: { resourceId: a.id } }))!;
      const ctx = log.context as {
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      };
      expect(ctx.before.statusCode).toBe('draft');
      expect(ctx.before.publishedBy).toBeNull();
      expect(ctx.after.statusCode).toBe('published');
      expect(ctx.after.publishedBy).toBe(adminId);
      expect(ctx.after.publishedAt).not.toBeNull();
    });

    it('同事务回滚:activityTypeCode invalid → audit 不入表 + activity 不入表', async () => {
      const actBefore = await prisma.activity.count();
      const auditBefore = await prisma.auditLog.count();

      const res = await request(httpServer(app))
        .post('/api/admin/v1/activities')
        .set('Authorization', adminAuth)
        .send({
          title: '回滚测试',
          activityTypeCode: 'non-existent-code',
          organizationId: childOrgId,
          startAt: '2099-06-01T08:00:00.000Z',
          endAt: '2099-06-01T12:00:00.000Z',
          location: 'X',
        });
      expect(res.status).toBe(400);

      expect(await prisma.activity.count()).toBe(actBefore);
      expect(await prisma.auditLog.count()).toBe(auditBefore);
    });

    it('GET list:audit_logs 无新记录(未迁移 read 路径)', async () => {
      await createActivity();
      await truncateAuditLogsTestOnly(app);
      await request(httpServer(app))
        .get('/api/admin/v1/activities')
        .set('Authorization', adminAuth)
        .expect(200);
      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('GET detail:audit_logs 无新记录(未迁移 read 路径)', async () => {
      const a = await createActivity();
      await truncateAuditLogsTestOnly(app);
      await request(httpServer(app))
        .get(`/api/admin/v1/activities/${a.id}`)
        .set('Authorization', adminAuth)
        .expect(200);
      expect(await prisma.auditLog.count()).toBe(0);
    });
  });

  // ============ PR #5:activity-registrations 写操作迁移(第二波第三步) ============

  describe('activity-registrations 写操作迁移(PR #5)', () => {
    let regChildOrgId: string;
    let regMemberAdminTargetId: string; // ADMIN 代报名的目标 member(无绑 user)
    let userWithMemberAuth: string;
    let userWithMemberId: string;
    let userMemberId: string; // USER 绑定的 member

    // PR #5 fixtures:复用外层 activityTypeCode;新建 USER+绑 member、child org、target member
    beforeAll(async () => {
      const nodeType = await prisma.dictType.create({
        data: { code: 'reg-mig-node', label: 'Reg Mig Node' },
        select: { id: true },
      });
      await prisma.dictItem.create({
        data: { typeId: nodeType.id, code: 'reg-mig-root', label: 'Root' },
      });
      await prisma.dictItem.create({
        data: { typeId: nodeType.id, code: 'reg-mig-child', label: 'Child' },
      });
      const rootOrg = await prisma.organization.create({
        data: { name: 'Reg Mig Root', nodeTypeCode: 'reg-mig-root', parentId: null },
        select: { id: true },
      });
      const childOrg = await prisma.organization.create({
        data: {
          name: 'Reg Mig Child',
          nodeTypeCode: 'reg-mig-child',
          parentId: rootOrg.id,
        },
        select: { id: true },
      });
      regChildOrgId = childOrg.id;

      // ADMIN 代报名目标 member(无绑 user,纯被代报名)
      const targetMember = await prisma.member.create({
        data: { memberNo: 'reg-mig-target', displayName: 'Target Member' },
        select: { id: true },
      });
      regMemberAdminTargetId = targetMember.id;

      // USER + 绑 member(自助报名 / cancelMy 路径)
      const userMember = await prisma.member.create({
        data: { memberNo: 'reg-mig-user-mem', displayName: 'User Member' },
        select: { id: true },
      });
      userMemberId = userMember.id;
      const userWithMember = await createTestUser(app, {
        username: 'al-mig-user-mem',
        role: Role.USER,
      });
      userWithMemberId = userWithMember.id;
      await prisma.user.update({
        where: { id: userWithMember.id },
        data: { memberId: userMember.id },
      });
      userWithMemberAuth = (await loginAs(app, 'al-mig-user-mem')).authHeader;
    });

    // 每个 it 前清 registration / activity,避免相互干扰;外层 beforeEach 已清 audit_logs
    beforeEach(async () => {
      await prisma.activityRegistration.deleteMany({});
      await prisma.activity.deleteMany({});
    });

    // 创建 published 状态、公开报名的活动;返回 id
    const createPublishedActivity = async (
      overrides: { capacity?: number; isPublic?: boolean } = {},
    ): Promise<string> => {
      const created = await prisma.activity.create({
        data: {
          title: 'Reg Mig Activity',
          activityTypeCode,
          organizationId: regChildOrgId,
          startAt: new Date('2099-06-01T08:00:00.000Z'),
          endAt: new Date('2099-06-01T12:00:00.000Z'),
          location: 'Demo',
          statusCode: 'published',
          isPublicRegistration: overrides.isPublic ?? true,
          ...(overrides.capacity !== undefined ? { capacity: overrides.capacity } : {}),
        },
        select: { id: true },
      });
      return created.id;
    };

    it('ADMIN POST 代报名触发 → audit_logs +1 registration.create(viaPath=admin)', async () => {
      const actId = await createPublishedActivity();
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${actId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: regMemberAdminTargetId });
      expect(res.status).toBe(201);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      const log = logs[0];
      expect(log.event).toBe('registration.create');
      expect(log.resourceType).toBe('activity_registration');
      expect(log.resourceId).toBe(res.body.data.id);
      expect(log.actorUserId).toBe(adminId);
      expect(log.actorRoleSnap).toBe(Role.ADMIN);
      expect(log.success).toBe(true);
      const extra = (
        log.context as {
          extra: {
            operation: string;
            viaPath: string;
            activityId: string;
            targetMemberId: string;
          };
        }
      ).extra;
      expect(extra.operation).toBe('create');
      expect(extra.viaPath).toBe('admin');
      expect(extra.activityId).toBe(actId);
      expect(extra.targetMemberId).toBe(regMemberAdminTargetId);
    });

    it('USER POST 自助报名触发 → audit_logs +1 registration.create(viaPath=self,targetMemberId=USER 绑定的 member)', async () => {
      const actId = await createPublishedActivity();
      const res = await request(httpServer(app))
        .post('/api/app/v1/my/registrations')
        .set('Authorization', userWithMemberAuth)
        .send({ activityId: actId });
      expect(res.status).toBe(201);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      const log = logs[0];
      expect(log.event).toBe('registration.create');
      expect(log.actorUserId).toBe(userWithMemberId);
      expect(log.actorRoleSnap).toBe(Role.USER);
      const extra = (log.context as { extra: { viaPath: string; targetMemberId: string } }).extra;
      expect(extra.viaPath).toBe('self');
      expect(extra.targetMemberId).toBe(userMemberId);
    });

    it('PATCH approve 触发 → audit_logs +1 registration.review(action=approve,priorStatusCode=pending → pass)', async () => {
      const actId = await createPublishedActivity();
      const createRes = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${actId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: regMemberAdminTargetId });
      const regId: string = createRes.body.data.id;
      await truncateAuditLogsTestOnly(app);

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/activities/${actId}/registrations/${regId}/approve`)
        .set('Authorization', adminAuth)
        .send({});
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].event).toBe('registration.review');
      const extra = (
        logs[0].context as {
          extra: {
            operation: string;
            action: string;
            priorStatusCode: string;
            nextStatusCode: string;
          };
        }
      ).extra;
      expect(extra.operation).toBe('review');
      expect(extra.action).toBe('approve');
      expect(extra.priorStatusCode).toBe('pending');
      expect(extra.nextStatusCode).toBe('pass');
    });

    it('PATCH reject 触发 → audit_logs +1 registration.review(action=reject)', async () => {
      const actId = await createPublishedActivity();
      const createRes = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${actId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: regMemberAdminTargetId });
      const regId: string = createRes.body.data.id;
      await truncateAuditLogsTestOnly(app);

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/activities/${actId}/registrations/${regId}/reject`)
        .set('Authorization', adminAuth)
        .send({ reviewNote: '不符合条件' });
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].event).toBe('registration.review');
      const extra = (logs[0].context as { extra: { action: string; nextStatusCode: string } })
        .extra;
      expect(extra.action).toBe('reject');
      expect(extra.nextStatusCode).toBe('reject');
    });

    it('PATCH cancel(admin)触发 → audit_logs +1(action=cancel,cancelledByPath=admin,cancelReason)', async () => {
      const actId = await createPublishedActivity();
      const createRes = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${actId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: regMemberAdminTargetId });
      const regId: string = createRes.body.data.id;
      await truncateAuditLogsTestOnly(app);

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/activities/${actId}/registrations/${regId}/cancel`)
        .set('Authorization', adminAuth)
        .send({ cancelReason: '活动调整' });
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      const extra = (
        logs[0].context as {
          extra: {
            action: string;
            cancelledByPath: string;
            cancelReason: string;
            nextStatusCode: string;
          };
        }
      ).extra;
      expect(extra.action).toBe('cancel');
      expect(extra.cancelledByPath).toBe('admin');
      expect(extra.cancelReason).toBe('活动调整');
      expect(extra.nextStatusCode).toBe('cancelled');
    });

    it('PATCH cancelMy(self)触发 → audit_logs +1(cancelledByPath=self)', async () => {
      const actId = await createPublishedActivity();
      // USER 自助报名先建一个 registration
      const createRes = await request(httpServer(app))
        .post('/api/app/v1/my/registrations')
        .set('Authorization', userWithMemberAuth)
        .send({ activityId: actId });
      const regId: string = createRes.body.data.id;
      await truncateAuditLogsTestOnly(app);

      const res = await request(httpServer(app))
        .patch(`/api/app/v1/my/registrations/${regId}/cancel`)
        .set('Authorization', userWithMemberAuth)
        .send({ cancelReason: '临时有事' });
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].event).toBe('registration.review');
      expect(logs[0].actorUserId).toBe(userWithMemberId);
      expect(logs[0].actorRoleSnap).toBe(Role.USER);
      const extra = (
        logs[0].context as {
          extra: { action: string; cancelledByPath: string; cancelReason: string };
        }
      ).extra;
      expect(extra.action).toBe('cancel');
      expect(extra.cancelledByPath).toBe('self');
      expect(extra.cancelReason).toBe('临时有事');
    });

    it('context 锁形:requestId 非空字符串,ip / ua 字段存在', async () => {
      const actId = await createPublishedActivity();
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${actId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: regMemberAdminTargetId });
      expect(res.status).toBe(201);

      const log = (await prisma.auditLog.findFirst({ where: { resourceId: res.body.data.id } }))!;
      const ctx = log.context as Record<string, unknown>;
      expect(typeof ctx.requestId).toBe('string');
      expect((ctx.requestId as string).length).toBeGreaterThan(0);
      expect('ip' in ctx).toBe(true);
      expect('ua' in ctx).toBe(true);
    });

    it('create:context 含 after 不含 before;approve:同时含 before+after,statusCode 流转', async () => {
      const actId = await createPublishedActivity();
      // create 阶段
      const createRes = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${actId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: regMemberAdminTargetId });
      const regId: string = createRes.body.data.id;
      const createLog = (await prisma.auditLog.findFirst({ where: { resourceId: regId } }))!;
      const createCtx = createLog.context as Record<string, unknown>;
      expect(createCtx.before).toBeUndefined();
      expect(createCtx.after).toBeDefined();
      const createAfter = createCtx.after as { statusCode: string; memberId: string };
      expect(createAfter.statusCode).toBe('pending');
      expect(createAfter.memberId).toBe(regMemberAdminTargetId);

      await truncateAuditLogsTestOnly(app);

      // approve 阶段:before.statusCode=pending → after.statusCode=pass
      await request(httpServer(app))
        .patch(`/api/admin/v1/activities/${actId}/registrations/${regId}/approve`)
        .set('Authorization', adminAuth)
        .send({})
        .expect(200);
      const approveLog = (await prisma.auditLog.findFirst({ where: { resourceId: regId } }))!;
      const approveCtx = approveLog.context as {
        before: { statusCode: string };
        after: { statusCode: string; reviewedBy: string };
      };
      expect(approveCtx.before.statusCode).toBe('pending');
      expect(approveCtx.after.statusCode).toBe('pass');
      expect(approveCtx.after.reviewedBy).toBe(adminId);
    });

    it('同事务回滚:重复报名 → ACTIVITY_REGISTRATION_ALREADY_EXISTS → audit 不入表 + registration 不新增', async () => {
      const actId = await createPublishedActivity();
      // 先建一条 active registration
      await request(httpServer(app))
        .post(`/api/admin/v1/activities/${actId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: regMemberAdminTargetId })
        .expect(201);
      await truncateAuditLogsTestOnly(app);
      const regCountBefore = await prisma.activityRegistration.count();

      // 同 activity + 同 member 再报 → 21002
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${actId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: regMemberAdminTargetId });
      expect(res.status).toBe(409);

      expect(await prisma.activityRegistration.count()).toBe(regCountBefore);
      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('exportCsv 不入库(read/export 路径仍 pino-only,Q1=A)', async () => {
      const actId = await createPublishedActivity();
      await request(httpServer(app))
        .post(`/api/admin/v1/activities/${actId}/registrations`)
        .set('Authorization', adminAuth)
        .send({ memberId: regMemberAdminTargetId })
        .expect(201);
      await truncateAuditLogsTestOnly(app);

      const res = await request(httpServer(app))
        .get(`/api/admin/v1/activities/${actId}/registrations/export`)
        .query({ scope: 'all' })
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);

      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('GET list:audit_logs 无新记录(未迁移 read 路径)', async () => {
      const actId = await createPublishedActivity();
      await truncateAuditLogsTestOnly(app);
      await request(httpServer(app))
        .get(`/api/admin/v1/activities/${actId}/registrations`)
        .set('Authorization', adminAuth)
        .expect(200);
      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('GET detail(me):audit_logs 无新记录(未迁移 read 路径)', async () => {
      const actId = await createPublishedActivity();
      const createRes = await request(httpServer(app))
        .post('/api/app/v1/my/registrations')
        .set('Authorization', userWithMemberAuth)
        .send({ activityId: actId });
      const regId: string = createRes.body.data.id;
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .get(`/api/app/v1/my/registrations/${regId}`)
        .set('Authorization', userWithMemberAuth)
        .expect(200);
      expect(await prisma.auditLog.count()).toBe(0);
    });
  });

  // ============ PR #6:attendances 写操作迁移(第二波最后一批) ============

  describe('attendances 写操作迁移(PR #6)', () => {
    let attChildOrgId: string;
    let attMemberAId: string;
    let attMemberBId: string;
    let attRoleCode: string;
    let attStatusCode: string;

    // PR #6 fixtures:复用外层 activityTypeCode;新建 attendance_role / attendance_status 字典 +
    // child organization + 测试用 member。不复用 PR #4/PR #5 内的 organization(scope 隔离)。
    beforeAll(async () => {
      const nodeType = await prisma.dictType.create({
        data: { code: 'att-mig-node', label: 'Att Mig Node' },
        select: { id: true },
      });
      await prisma.dictItem.create({
        data: { typeId: nodeType.id, code: 'att-mig-root', label: 'Root' },
      });
      await prisma.dictItem.create({
        data: { typeId: nodeType.id, code: 'att-mig-child', label: 'Child' },
      });
      const rootOrg = await prisma.organization.create({
        data: { name: 'Att Mig Root', nodeTypeCode: 'att-mig-root', parentId: null },
        select: { id: true },
      });
      const childOrg = await prisma.organization.create({
        data: {
          name: 'Att Mig Child',
          nodeTypeCode: 'att-mig-child',
          parentId: rootOrg.id,
        },
        select: { id: true },
      });
      attChildOrgId = childOrg.id;

      // attendance_role 字典 dictType 已在外层 PR #3 fixtures 创建(共享 dictType),
      // 这里复用 typeId 并在其下新建独立 dictItem,避免 P2002 dictType.code 唯一冲突
      const roleType = await prisma.dictType.findUniqueOrThrow({
        where: { code: 'attendance_role' },
        select: { id: true },
      });
      const roleItem = await prisma.dictItem.create({
        data: { typeId: roleType.id, code: 'att-mig-member', label: 'Member' },
        select: { code: true },
      });
      attRoleCode = roleItem.code;

      // attendance_status 字典
      const statType = await prisma.dictType.create({
        data: { code: 'attendance_status', label: '考勤状态' },
        select: { id: true },
      });
      const statItem = await prisma.dictItem.create({
        data: { typeId: statType.id, code: 'att-mig-present', label: 'Present' },
        select: { code: true },
      });
      attStatusCode = statItem.code;

      // 2 个 member(防止 records 时间冲突时换 member)
      const ma = await prisma.member.create({
        data: { memberNo: 'att-mig-a', displayName: 'Att A' },
        select: { id: true },
      });
      attMemberAId = ma.id;
      const mb = await prisma.member.create({
        data: { memberNo: 'att-mig-b', displayName: 'Att B' },
        select: { id: true },
      });
      attMemberBId = mb.id;
    });

    // 每个 it 前清 attendance + activity(activityRegistration 先清,FK 顺序);
    // 外层 beforeEach 已清 audit_logs。
    beforeEach(async () => {
      await prisma.attendanceRecord.deleteMany({});
      await prisma.attendanceSheet.deleteMany({});
      // PR #5 测试留下的 ActivityRegistration 持有 activityId FK,必须先于 activity 清
      await prisma.activityRegistration.deleteMany({});
      await prisma.activity.deleteMany({});
    });

    // 创建 published Activity,返回 id。直接 Prisma 写库(避免触发 activities audit log)。
    const createActivity = async (overrides: { capacity?: number } = {}): Promise<string> => {
      const a = await prisma.activity.create({
        data: {
          title: 'Att Mig Activity',
          activityTypeCode,
          organizationId: attChildOrgId,
          startAt: new Date('2099-06-01T08:00:00.000Z'),
          endAt: new Date('2099-06-01T18:00:00.000Z'),
          location: 'Demo',
          statusCode: 'published',
          ...(overrides.capacity !== undefined ? { capacity: overrides.capacity } : {}),
        },
        select: { id: true },
      });
      return a.id;
    };

    // 标准 record payload(必填:memberId / roleCode / checkInAt / checkOutAt / attendanceStatusCode)
    const buildRecord = (
      memberId: string,
      checkInIso: string,
      checkOutIso: string,
      extras: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      memberId,
      roleCode: attRoleCode,
      checkInAt: checkInIso,
      checkOutAt: checkOutIso,
      attendanceStatusCode: attStatusCode,
      ...extras,
    });

    // 提交一个 pending Sheet,返回 sheetId。Records 默认 1 条 contributionPoints=1.0(approve 不抛 R31)
    const submitPendingSheet = async (
      actId: string,
      records: Record<string, unknown>[] = [
        buildRecord(attMemberAId, '2099-06-01T09:00:00.000Z', '2099-06-01T11:00:00.000Z', {
          contributionPoints: 1.0,
        }),
      ],
    ): Promise<string> => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${actId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({ records });
      expect(res.status).toBe(201);
      return res.body.data.id;
    };

    it('POST submit 触发 → audit_logs +1 attendance-sheet.submit', async () => {
      const actId = await createActivity();
      const sheetId = await submitPendingSheet(actId);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      const log = logs[0];
      expect(log.event).toBe('attendance-sheet.submit');
      expect(log.resourceType).toBe('attendance_sheet');
      expect(log.resourceId).toBe(sheetId);
      expect(log.actorUserId).toBe(adminId);
      expect(log.actorRoleSnap).toBe(Role.ADMIN);
      expect(log.success).toBe(true);
      const extra = (
        log.context as {
          extra: {
            operation: string;
            activityId: string;
            recordsCount: number;
            activityPushedToCompleted: boolean;
          };
        }
      ).extra;
      expect(extra.operation).toBe('submit');
      expect(extra.activityId).toBe(actId);
      expect(extra.recordsCount).toBe(1);
      expect(extra.activityPushedToCompleted).toBe(false); // D2-a:completed 仅由 activities.complete 推进
    });

    it('PATCH edit(主路径)触发 → audit_logs +1(operation=edit,version+1)', async () => {
      const actId = await createActivity();
      const sheetId = await submitPendingSheet(actId);
      await truncateAuditLogsTestOnly(app);

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${sheetId}`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            buildRecord(attMemberBId, '2099-06-01T10:00:00.000Z', '2099-06-01T12:00:00.000Z', {
              contributionPoints: 1.0,
            }),
          ],
        });
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].event).toBe('attendance-sheet.edit');
      const extra = (
        logs[0].context as {
          extra: {
            operation: string;
            oldRecordsCount: number;
            newRecordsCount: number;
            newVersion: number;
          };
        }
      ).extra;
      expect(extra.operation).toBe('edit');
      expect(extra.oldRecordsCount).toBe(1);
      expect(extra.newRecordsCount).toBe(1);
      expect(extra.newVersion).toBe(2);
    });

    it('PATCH edit(no-records 分支)触发 → audit_logs +1(operation=edit-no-records)', async () => {
      const actId = await createActivity();
      const sheetId = await submitPendingSheet(actId);
      await truncateAuditLogsTestOnly(app);

      // 不传 records → 走 edit-no-records 分支
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${sheetId}`)
        .set('Authorization', adminAuth)
        .send({});
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      const extra = (
        logs[0].context as {
          extra: { operation: string; recordsCount: number; newVersion: number };
        }
      ).extra;
      expect(extra.operation).toBe('edit-no-records');
      expect(extra.newVersion).toBe(2);
    });

    it('DELETE softDelete 触发 → audit_logs +1(operation=delete,priorStatusCode=pending)', async () => {
      const actId = await createActivity();
      const sheetId = await submitPendingSheet(actId);
      await truncateAuditLogsTestOnly(app);

      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/attendance-sheets/${sheetId}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].event).toBe('attendance-sheet.delete');
      const extra = (
        logs[0].context as {
          extra: { operation: string; priorStatusCode: string; recordsCount: number };
        }
      ).extra;
      expect(extra.operation).toBe('delete');
      expect(extra.priorStatusCode).toBe('pending');
      expect(extra.recordsCount).toBe(1);
    });

    it('PATCH approve 触发 → audit_logs +1(action=approve,pending → pending_final_review)', async () => {
      const actId = await createActivity();
      const sheetId = await submitPendingSheet(actId);
      await truncateAuditLogsTestOnly(app);

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${sheetId}/approve`)
        .set('Authorization', adminAuth)
        .send({});
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].event).toBe('attendance-sheet.review');
      const extra = (
        logs[0].context as {
          extra: {
            operation: string;
            action: string;
            priorStatusCode: string;
            nextStatusCode: string;
            recordsCount: number;
          };
        }
      ).extra;
      expect(extra.operation).toBe('review');
      expect(extra.action).toBe('approve');
      expect(extra.priorStatusCode).toBe('pending');
      expect(extra.nextStatusCode).toBe('pending_final_review');
      expect(extra.recordsCount).toBe(1);
    });

    it('PATCH reject 触发 → audit_logs +1(action=reject)', async () => {
      const actId = await createActivity();
      const sheetId = await submitPendingSheet(actId);
      await truncateAuditLogsTestOnly(app);

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${sheetId}/reject`)
        .set('Authorization', adminAuth)
        .send({ reviewNote: '材料不全' });
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      const extra = (logs[0].context as { extra: { action: string; nextStatusCode: string } })
        .extra;
      expect(extra.action).toBe('reject');
      expect(extra.nextStatusCode).toBe('rejected');
    });

    it('PATCH final-approve 触发 → audit_logs +1(action=final-approve,eventTriggered=true)', async () => {
      const actId = await createActivity();
      const sheetId = await submitPendingSheet(actId);
      // 先 approve 进入 pending_final_review
      await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${sheetId}/approve`)
        .set('Authorization', adminAuth)
        .send({})
        .expect(200);
      await truncateAuditLogsTestOnly(app);

      // PR9:终审换第二管理员(adminAuth 是 submitter+一级审,自审/同人约束下不可再终审)
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${sheetId}/final-approve`)
        .set('Authorization', finalAdminAuth)
        .send({});
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].event).toBe('attendance-sheet.final-review');
      const extra = (
        logs[0].context as {
          extra: {
            operation: string;
            action: string;
            nextStatusCode: string;
            eventTriggered: boolean;
          };
        }
      ).extra;
      expect(extra.operation).toBe('final-review');
      expect(extra.action).toBe('final-approve');
      expect(extra.nextStatusCode).toBe('approved');
      expect(extra.eventTriggered).toBe(true);
    });

    it('PATCH final-reject 触发 → audit_logs +1(action=final-reject,records 跟随软删)', async () => {
      const actId = await createActivity();
      const sheetId = await submitPendingSheet(actId);
      await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${sheetId}/approve`)
        .set('Authorization', adminAuth)
        .send({})
        .expect(200);
      await truncateAuditLogsTestOnly(app);

      // 摘码微刀:final-reject 亦须持权身份(adminAuth 的 biz-admin 已无终审码)
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${sheetId}/final-reject`)
        .set('Authorization', finalAdminAuth)
        .send({ finalReviewNote: '数据不准' });
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].event).toBe('attendance-sheet.final-review');
      const extra = (
        logs[0].context as {
          extra: {
            action: string;
            nextStatusCode: string;
            recordsCount: number;
            finalReviewNote: string;
          };
        }
      ).extra;
      expect(extra.action).toBe('final-reject');
      expect(extra.nextStatusCode).toBe('final_rejected');
      expect(extra.recordsCount).toBe(1);
      expect(extra.finalReviewNote).toBe('数据不准');
    });

    it('context 锁形:requestId 非空,ip / ua 字段存在', async () => {
      const actId = await createActivity();
      const sheetId = await submitPendingSheet(actId);

      const log = (await prisma.auditLog.findFirst({ where: { resourceId: sheetId } }))!;
      const ctx = log.context as Record<string, unknown>;
      expect(typeof ctx.requestId).toBe('string');
      expect((ctx.requestId as string).length).toBeGreaterThan(0);
      expect('ip' in ctx).toBe(true);
      expect('ua' in ctx).toBe(true);
    });

    it('submit:context 含 after(sheet+records),不含 before;after.sheet.statusCode=pending,after.records 长度匹配', async () => {
      const actId = await createActivity();
      const sheetId = await submitPendingSheet(actId);
      const log = (await prisma.auditLog.findFirst({ where: { resourceId: sheetId } }))!;
      const ctx = log.context as Record<string, unknown>;
      expect(ctx.before).toBeUndefined();
      expect(ctx.after).toBeDefined();
      const after = ctx.after as {
        sheet: { statusCode: string; version: number };
        records: unknown[];
      };
      expect(after.sheet.statusCode).toBe('pending');
      expect(after.sheet.version).toBe(1);
      expect(after.records).toHaveLength(1);
    });

    it('edit:context 同时含 before+after,before.sheet.version=1 / after.sheet.version=2', async () => {
      const actId = await createActivity();
      const sheetId = await submitPendingSheet(actId);
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${sheetId}`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            buildRecord(attMemberBId, '2099-06-01T10:00:00.000Z', '2099-06-01T12:00:00.000Z', {
              contributionPoints: 1.0,
            }),
          ],
        })
        .expect(200);

      const log = (await prisma.auditLog.findFirst({ where: { resourceId: sheetId } }))!;
      const ctx = log.context as {
        before: { sheet: { version: number; statusCode: string } };
        after: { sheet: { version: number; statusCode: string } };
      };
      expect(ctx.before.sheet.version).toBe(1);
      expect(ctx.after.sheet.version).toBe(2);
      expect(ctx.before.sheet.statusCode).toBe('pending');
      expect(ctx.after.sheet.statusCode).toBe('pending');
    });

    it('softDelete:context 含 before,不含 after;before.sheet.statusCode=pending', async () => {
      const actId = await createActivity();
      const sheetId = await submitPendingSheet(actId);
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .delete(`/api/admin/v1/attendance-sheets/${sheetId}`)
        .set('Authorization', adminAuth)
        .expect(200);

      const log = (await prisma.auditLog.findFirst({ where: { resourceId: sheetId } }))!;
      const ctx = log.context as {
        before: { sheet: { statusCode: string }; records: unknown[] };
        after?: unknown;
      };
      expect(ctx.before.sheet.statusCode).toBe('pending');
      expect(ctx.before.records).toHaveLength(1);
      expect(ctx.after).toBeUndefined();
    });

    it('finalReject:before 含 records / after 仅 sheet(records 已软删)', async () => {
      const actId = await createActivity();
      const sheetId = await submitPendingSheet(actId);
      await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${sheetId}/approve`)
        .set('Authorization', adminAuth)
        .send({})
        .expect(200);
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${sheetId}/final-reject`)
        .set('Authorization', finalAdminAuth)
        .send({ finalReviewNote: '数据不准' })
        .expect(200);

      const log = (await prisma.auditLog.findFirst({ where: { resourceId: sheetId } }))!;
      const ctx = log.context as {
        before: { sheet: { statusCode: string }; records: unknown[] };
        after: { sheet: { statusCode: string }; records?: unknown };
      };
      expect(ctx.before.sheet.statusCode).toBe('pending_final_review');
      expect(ctx.before.records).toHaveLength(1);
      expect(ctx.after.sheet.statusCode).toBe('final_rejected');
      expect(ctx.after.records).toBeUndefined();
    });

    it('同事务回滚:submit 字典 invalid → audit 不入表 + sheet 不入表', async () => {
      const actId = await createActivity();
      const sheetBefore = await prisma.attendanceSheet.count();
      const auditBefore = await prisma.auditLog.count();

      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${actId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            buildRecord(attMemberAId, '2099-06-01T09:00:00.000Z', '2099-06-01T11:00:00.000Z', {
              roleCode: 'invalid-role-code',
              contributionPoints: 1.0,
            }),
          ],
        });
      expect(res.status).toBe(400);

      expect(await prisma.attendanceSheet.count()).toBe(sheetBefore);
      expect(await prisma.auditLog.count()).toBe(auditBefore);
    });

    it('R31 失败回滚:approve 时 records.contributionPoints null → 22072 → audit 不入表 + 状态不变', async () => {
      const actId = await createActivity();
      // submit records 时 contributionPoints 显式 null(R31 校验在 approve)
      const sheetId = await submitPendingSheet(actId, [
        buildRecord(attMemberAId, '2099-06-01T09:00:00.000Z', '2099-06-01T11:00:00.000Z', {
          contributionPoints: null,
        }),
      ]);
      await truncateAuditLogsTestOnly(app);

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${sheetId}/approve`)
        .set('Authorization', adminAuth)
        .send({});
      expect(res.status).toBe(409); // ATTENDANCE_RECORD_CONTRIBUTION_POINTS_REQUIRED (22072, CONFLICT)

      // 状态保持 pending,audit 不入表
      const sheet = await prisma.attendanceSheet.findUnique({
        where: { id: sheetId },
        select: { statusCode: true },
      });
      expect(sheet?.statusCode).toBe('pending');
      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('GET list:audit_logs 无新记录(read.other 仍 pino-only)', async () => {
      const actId = await createActivity();
      await submitPendingSheet(actId);
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .get(`/api/admin/v1/activities/${actId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .expect(200);
      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('GET detail:audit_logs 无新记录(read.other 仍 pino-only)', async () => {
      const actId = await createActivity();
      const sheetId = await submitPendingSheet(actId);
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .get(`/api/admin/v1/attendance-sheets/${sheetId}`)
        .set('Authorization', adminAuth)
        .expect(200);
      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('GET review-detail:audit_logs 无新记录(read.other 仍 pino-only)', async () => {
      const actId = await createActivity();
      const sheetId = await submitPendingSheet(actId);
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .get(`/api/admin/v1/attendance-sheets/${sheetId}/review-detail`)
        .set('Authorization', adminAuth)
        .expect(200);
      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('finalApprove 与 attendance.recorded 业务事件并存(eventPlaceholder 不入 audit 表;两套机制 OK)', async () => {
      const actId = await createActivity();
      const sheetId = await submitPendingSheet(actId);
      await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${sheetId}/approve`)
        .set('Authorization', adminAuth)
        .send({})
        .expect(200);
      await truncateAuditLogsTestOnly(app);

      // PR9:终审换第二管理员(自审/同人约束)
      await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${sheetId}/final-approve`)
        .set('Authorization', finalAdminAuth)
        .send({})
        .expect(200);

      // audit_logs +1(finalApprove)且仅 1 条(business event 不入 audit 表)
      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].event).toBe('attendance-sheet.final-review');
      // eventTriggered=true 标识 attendance.recorded 已被业务事件机制触发(由 service 控制,
      // 不影响 audit_logs 表;两套机制独立并存)
      const extra = (logs[0].context as { extra: { eventTriggered: boolean } }).extra;
      expect(extra.eventTriggered).toBe(true);
    });
  });
});
