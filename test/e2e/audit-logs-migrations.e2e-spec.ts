import type { INestApplication } from '@nestjs/common';
import { DictItemStatus, Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
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
      .post(`/api/v2/members/${memberId}/emergency-contacts`)
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
      .post(`/api/v2/members/${memberId}/certificates`)
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
      .post('/api/v2/contribution-rules')
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
        .patch(`/api/v2/members/${memberId}/emergency-contacts/${c.id}`)
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
        .delete(`/api/v2/members/${memberId}/emergency-contacts/${c.id}`)
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
        .patch(`/api/v2/members/${memberId}/certificates/${c.id}`)
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
        .delete(`/api/v2/members/${memberId}/certificates/${c.id}`)
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
        .patch(`/api/v2/members/${memberId}/certificates/${c.id}/verify`)
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
        .patch(`/api/v2/members/${memberId}/certificates/${c.id}/reject`)
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
        .patch(`/api/v2/members/${memberId}/emergency-contacts/${c.id}`)
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
        .delete(`/api/v2/members/${memberId}/emergency-contacts/${c.id}`)
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
        .patch(`/api/v2/members/${memberId}/certificates/${c.id}/verify`)
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
        .patch(`/api/v2/members/${memberId}/certificates/${c.id}/reject`)
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
        .patch(`/api/v2/members/${memberId}/emergency-contacts/${c.id}`)
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
        .delete(`/api/v2/members/${memberId}/emergency-contacts/${c.id}`)
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
        .post(`/api/v2/members/${memberId}/emergency-contacts`)
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
        .patch(`/api/v2/members/${memberId}/certificates/${c.id}/verify`)
        .set('Authorization', adminAuth)
        .send({ verifyNote: 'OK' })
        .expect(200);

      await truncateAuditLogsTestOnly(app); // 清掉前两条 audit

      // 再 verify → CERTIFICATE_INVALID_STATE_TRANSITION (409)
      const res = await request(httpServer(app))
        .patch(`/api/v2/members/${memberId}/certificates/${c.id}/verify`)
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
        .get(`/api/v2/members/${memberId}/emergency-contacts`)
        .set('Authorization', adminAuth)
        .expect(200);
      const after = await prisma.auditLog.count();
      expect(after).toBe(before);
    });

    it('GET certificates list:audit_logs 无新记录', async () => {
      const before = await prisma.auditLog.count();
      await request(httpServer(app))
        .get(`/api/v2/members/${memberId}/certificates`)
        .set('Authorization', adminAuth)
        .expect(200);
      const after = await prisma.auditLog.count();
      expect(after).toBe(before);
    });

    it('GET certificates qualification-flag:audit_logs 无新记录', async () => {
      const before = await prisma.auditLog.count();
      await request(httpServer(app))
        .get(`/api/v2/members/${memberId}/certificates/qualification-flag`)
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
        .get(`/api/v2/members/${memberId}/certificates/${c.id}`)
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
        .patch(`/api/v2/contribution-rules/${r.id}`)
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
        .delete(`/api/v2/contribution-rules/${r.id}`)
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
        .patch(`/api/v2/contribution-rules/${r.id}`)
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
      expect(ctx.extra.changedFields).toEqual(
        expect.arrayContaining(['pointsBelow', 'remark']),
      );
    });

    it('delete:context 含 before 完整,不含 after;extra.priorStatus=ACTIVE', async () => {
      const r = await createRule({ remark: 'pre-delete' });
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .delete(`/api/v2/contribution-rules/${r.id}`)
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
        .post('/api/v2/contribution-rules')
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
        .get('/api/v2/contribution-rules')
        .set('Authorization', adminAuth)
        .expect(200);
      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('GET detail:audit_logs 无新记录(未迁移 read 路径)', async () => {
      const r = await createRule();
      await truncateAuditLogsTestOnly(app);
      await request(httpServer(app))
        .get(`/api/v2/contribution-rules/${r.id}`)
        .set('Authorization', adminAuth)
        .expect(200);
      expect(await prisma.auditLog.count()).toBe(0);
    });
  });
});
