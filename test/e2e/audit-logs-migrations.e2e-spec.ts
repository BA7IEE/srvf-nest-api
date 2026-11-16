import { withTimeLedgerFixtureCleanup } from '../setup/time-ledger-fixture-cleanup';
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
import { assertConnectedTestDatabase } from '../setup/test-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import appConfig, { type AppConfig } from '../../src/config/app.config';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { expectBizError } from '../helpers/biz-code.assert';
import { createSettlementDraftFixture } from '../helpers/settlement-draft.fixture';

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
  let attendanceSubmitterAuth: string;
  let attendanceSubmitterId: string;
  // 提交、一级审核与终审由三个不同用户执行；普通 ADMIN 需显式审核授权，
  // 终审另用 SUPER_ADMIN。审计迁移不改变默认角色权限或审核人员隔离。
  let finalAdminAuth: string;

  let memberId: string;
  let relationCode: string;
  let certTypeCode: string;
  let certStandardId: string;

  // PR #3 fixtures
  let activityTypeCode: string;
  let roleCode: string;

  async function truncateActivityRegistrations(): Promise<void> {
    await assertConnectedTestDatabase(prisma);
    await prisma.$transaction(
      (tx) =>
        withTimeLedgerFixtureCleanup(tx, async (tx) => {
          await tx.$executeRawUnsafe(
            'TRUNCATE TABLE "ActivityRegistration" RESTART IDENTITY CASCADE',
          );
        }),
      { timeout: 30_000 },
    );
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const admin = await createTestUser(app, { username: 'al-mig-adm', role: Role.ADMIN });
    adminId = admin.id;
    adminAuth = (await loginAs(app, 'al-mig-adm')).authHeader;
    const attendanceSubmitter = await createTestUser(app, {
      username: 'al-mig-att-submitter',
      role: Role.ADMIN,
    });
    attendanceSubmitterId = attendanceSubmitter.id;
    attendanceSubmitterAuth = (await loginAs(app, 'al-mig-att-submitter')).authHeader;

    // P0-F PR-2A:contribution-rules 写操作入口已切到 rbac.can();ADMIN 默认无 ops-admin
    // 会被 30100 拦下,导致 audit log 不会写;此处给 adminId grant ops-admin(模拟运维 SOP)。
    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    await grantOpsAdminToUser(app, adminId, seed.opsAdminRoleId);

    // Slow-4 T2(2026-06-11,评审稿 §8):emergency-contacts / certificates 写操作
    // 也已切到 service 层 rbac.can(),ADMIN 测试用户统一补挂 biz-admin。
    const bizSeed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, adminId, bizSeed.bizAdminRoleId);
    await grantBizAdminToUser(app, attendanceSubmitterId, bizSeed.bizAdminRoleId);

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

    // 证书标准库 PR-4a-3:建证入参改为 standardId(+ 按认定规则的机构入参)。
    // 最宽松的一条 ACTIVE Policy 即可 —— 本 spec 锁的是审计接线,不是认定规则。
    const certStandard = await prisma.certificateStandard.create({
      data: {
        code: 'audit-mig-std',
        name: '审计迁移用标准',
        kind: 'CREDENTIAL',
        status: 'ACTIVE',
        categoryCode: certTypeCode,
      },
      select: { id: true },
    });
    await prisma.certificateRecognitionPolicy.create({
      data: {
        standardId: certStandard.id,
        version: 1,
        status: 'ACTIVE',
        issuerPolicy: 'FREE_TEXT',
        validityMode: 'EXPLICIT_OPTIONAL',
        certNumberMode: 'OPTIONAL',
      },
    });
    certStandardId = certStandard.id;

    // member
    const m = await prisma.member.create({
      data: { memberNo: 'al-mig-mem', ...memberIdentityData('Member For Migration Tests') },
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
  // PR-1 §15.3:出参 certNumber 已拆为 certNumberMasked + certNumberFull(明文需 read.sensitive)。
  const createCert = async (): Promise<{
    id: string;
    certNumberMasked: string | null;
    certNumberFull: string | null;
  }> => {
    const res = await request(httpServer(app))
      .post(`/api/admin/v1/members/${memberId}/certificates`)
      .set('Authorization', adminAuth)
      .send({
        standardId: certStandardId,
        issuingOrg: 'Demo Issuing Org',
        certNumber: 'CN-2026-0001',
        issuedAt: '2026-01-01', // 冻结稿 §10.2:纯 YYYY-MM-DD
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
      const context = logs[0].context as { after: Record<string, unknown> };
      expect(context.after.certNumber).toBe('CN****01');
      expect(context.after.verifyNoteProvided).toBe(false);
      expect(context.after.verifyNoteChanged).toBe(false);
      expect(context.after).not.toHaveProperty('verifyNote');
      expect(JSON.stringify(context)).not.toContain('CN-2026-0001');
      // PR-1 §15.3:API 出参改名 certNumberFull(明文,需 read.sensitive);
      // audit snapshot 内仍是掩码后的 `certNumber` 键(上面那条断言),两者互不影响。
      expect(c.certNumberFull).toBe('CN-2026-0001');
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
      const context = logs[0].context as {
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      };
      expect(context.before.certNumber).toBe('CN****01');
      expect(context.after.certNumber).toBe('CN****01');
      expect(context.before).not.toHaveProperty('verifyNote');
      expect(context.after).not.toHaveProperty('verifyNote');
      expect(JSON.stringify(context)).not.toContain('CN-2026-0001');
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
      const context = logs[0].context as { before: Record<string, unknown> };
      expect(context.before.certNumber).toBe('CN****01');
      expect(context.before).not.toHaveProperty('verifyNote');
      expect(JSON.stringify(context)).not.toContain('CN-2026-0001');
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
      const context = logs[0].context as { after: Record<string, unknown> };
      expect(context.after).toMatchObject({
        status: 'verified',
        verifyNoteProvided: true,
        verifyNoteChanged: true,
      });
      expect(context.after).not.toHaveProperty('verifyNote');
      expect(JSON.stringify(context)).not.toContain('OK');
      expect(res.body.data.verifyNote).toBe('OK');
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
      const context = logs[0].context as { after: Record<string, unknown> };
      expect(context.after).toMatchObject({
        status: 'rejected',
        verifyNoteProvided: true,
        verifyNoteChanged: true,
      });
      expect(context.after).not.toHaveProperty('verifyNote');
      expect(JSON.stringify(context)).not.toContain('材料不全');
      expect(res.body.data.verifyNote).toBe('材料不全');
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

    it('certificate verify:before/after 保留状态与备注布尔摘要,不写自由文本', async () => {
      const c = await createCert();
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/certificates/${c.id}/verify`)
        .set('Authorization', adminAuth)
        .send({ verifyNote: '已核验' })
        .expect(200);

      const log = (await prisma.auditLog.findFirst({ where: { resourceId: c.id } }))!;
      const ctx = log.context as Record<string, unknown>;
      const before = ctx.before as Record<string, unknown>;
      const after = ctx.after as Record<string, unknown>;
      expect(before.status).toBe('pending');
      expect(before.verifyNoteProvided).toBe(false);
      expect(before.verifyNoteChanged).toBe(false);
      expect(after.status).toBe('verified');
      expect(after.verifyNoteProvided).toBe(true);
      expect(after.verifyNoteChanged).toBe(true);
      expect(after).not.toHaveProperty('verifyNote');
      expect(JSON.stringify(ctx)).not.toContain('已核验');
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
      const before = ctx.before as Record<string, unknown>;
      const after = ctx.after as Record<string, unknown>;
      expect(before.status).toBe('pending');
      expect(after.status).toBe('rejected');
      expect(after.verifyNoteProvided).toBe(true);
      expect(after.verifyNoteChanged).toBe(true);
      expect(after).not.toHaveProperty('verifyNote');
      expect(JSON.stringify(ctx)).not.toContain('材料不全');
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

    it('certificate.certNumber:仅掩码值入 audit', async () => {
      const c = await createCert();
      const log = (await prisma.auditLog.findFirst({ where: { resourceId: c.id } }))!;
      const after = (log.context as { after: Record<string, unknown> }).after;
      expect(after.certNumber).toBe('CN****01');
      expect(JSON.stringify(log.context)).not.toContain('CN-2026-0001');
    });

    it('certificate.standardId / issuingOrg:不在打码矩阵', async () => {
      const c = await createCert();
      const log = (await prisma.auditLog.findFirst({ where: { resourceId: c.id } }))!;
      const after = (log.context as { after: Record<string, unknown> }).after;
      // PR-4b:审计快照的类别副本 certTypeCode 已随列 DROP,改记 standardId 引用。
      // 正向断言新字段 + 反向断言旧字段不再出现(否则回退到记副本不会红)。
      expect(after.standardId).toBe(certStandardId);
      expect(after).not.toHaveProperty('certTypeCode');
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

  // ============ 敏感读取统一审计 ============

  describe('敏感读取统一审计', () => {
    it('GET emergency-contacts list:恰好写入 1 条 emergency-contact.read.other', async () => {
      await truncateAuditLogsTestOnly(app);
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberId}/emergency-contacts`)
        .set('Authorization', adminAuth)
        .set('User-Agent', 'audit-migrations-sensitive-read')
        .expect(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      const returnedCount = (res.body.data as unknown[]).length;

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        event: 'emergency-contact.read.other',
        actorUserId: adminId,
        actorRoleSnap: Role.ADMIN,
        resourceType: 'member',
        resourceId: memberId,
        success: true,
      });
      const context = logs[0].context as {
        requestId: string;
        ip: string | null;
        ua: string | null;
        extra: { operation: string; count: number; maskLevel: string };
      };
      expect(context).toEqual({
        requestId: expect.any(String),
        ip: expect.any(String),
        ua: 'audit-migrations-sensitive-read',
        extra: { operation: 'list', count: returnedCount, maskLevel: 'plain' },
      });
      expect(context.requestId.length).toBeGreaterThan(0);
      expect(JSON.stringify(context)).not.toMatch(
        /pii|name|phone|mobile|id.?card|policy|object.?key|signed.?url|url|token|credential/i,
      );
    });

    it('GET certificates list:恰好写入 1 条 certificate.read.other', async () => {
      await truncateAuditLogsTestOnly(app);
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberId}/certificates`)
        .set('Authorization', adminAuth)
        .set('User-Agent', 'audit-migrations-sensitive-read')
        .expect(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      const returnedCount = (res.body.data as unknown[]).length;

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        event: 'certificate.read.other',
        actorUserId: adminId,
        actorRoleSnap: Role.ADMIN,
        resourceType: 'member',
        resourceId: memberId,
        success: true,
      });
      const context = logs[0].context as {
        requestId: string;
        ip: string | null;
        ua: string | null;
        extra: { operation: string; count: number };
      };
      expect(context).toEqual({
        requestId: expect.any(String),
        ip: expect.any(String),
        ua: 'audit-migrations-sensitive-read',
        extra: { operation: 'list', count: returnedCount },
      });
      expect(context.requestId.length).toBeGreaterThan(0);
      expect(JSON.stringify(context)).not.toMatch(
        /pii|name|phone|mobile|id.?card|policy|object.?key|signed.?url|url|token|credential/i,
      );
    });

    it('GET certificates qualification-flag:恰好写入 1 条最小化 read audit', async () => {
      await truncateAuditLogsTestOnly(app);
      await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberId}/certificates/qualification-flag`)
        .query({ criterionType: 'category', criterionCode: certTypeCode })
        .set('Authorization', adminAuth)
        .set('User-Agent', 'audit-migrations-sensitive-read')
        .expect(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        event: 'certificate.read.qualification-flag',
        actorUserId: adminId,
        actorRoleSnap: Role.ADMIN,
        resourceType: 'member',
        resourceId: memberId,
        success: true,
      });
      const context = logs[0].context as {
        requestId: string;
        ip: string | null;
        ua: string | null;
        extra: { operation: string; filterFields: string[] };
      };
      expect(context).toEqual({
        requestId: expect.any(String),
        ip: expect.any(String),
        ua: 'audit-migrations-sensitive-read',
        extra: {
          operation: 'qualification-flag',
          filterFields: ['criterionType', 'criterionCode'],
        },
      });
      expect(context.requestId.length).toBeGreaterThan(0);
      const serializedContext = JSON.stringify(context);
      expect(serializedContext).not.toContain(certTypeCode);
      expect(serializedContext).not.toMatch(
        /qualified|pii|name|phone|mobile|id.?card|policy|object.?key|signed.?url|url|token|credential/i,
      );
    });

    it('GET certificate detail:恰好写入 1 条 certificate.read.other', async () => {
      const c = await createCert();
      await truncateAuditLogsTestOnly(app);
      await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberId}/certificates/${c.id}`)
        .set('Authorization', adminAuth)
        .set('User-Agent', 'audit-migrations-sensitive-read')
        .expect(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        event: 'certificate.read.other',
        actorUserId: adminId,
        actorRoleSnap: Role.ADMIN,
        resourceType: 'certificate',
        resourceId: c.id,
        success: true,
      });
      const context = logs[0].context as {
        requestId: string;
        ip: string | null;
        ua: string | null;
        extra: { operation: string; maskLevel: string };
      };
      expect(context).toEqual({
        requestId: expect.any(String),
        ip: expect.any(String),
        ua: 'audit-migrations-sensitive-read',
        // PR-1 §15.3:读审计增记本次给的是明文还是掩码(此处 adminAuth 持
        // certificate.read.sensitive 故为 plain);编号本身仍不入审计。
        extra: { operation: 'detail', maskLevel: 'plain' },
      });
      expect(context.requestId.length).toBeGreaterThan(0);
      expect(JSON.stringify(context)).not.toMatch(
        /pii|name|phone|mobile|id.?card|policy|object.?key|signed.?url|url|token|credential/i,
      );
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

    it('历史 dailyCap 只读保留:GET/PATCH 响应与审计快照保值,更新不将其列为 changedFields', async () => {
      const legacy = await prisma.contributionRule.create({
        data: {
          activityTypeCode,
          attendanceRoleCode: roleCode,
          pointsBelow: 1.5,
          dailyCap: 2,
        },
        select: { id: true },
      });

      const detail = await request(httpServer(app))
        .get(`/api/system/v1/contribution-rules/${legacy.id}`)
        .set('Authorization', adminAuth)
        .expect(200);
      expect(detail.body.data.dailyCap).toBe(2);

      const patched = await request(httpServer(app))
        .patch(`/api/system/v1/contribution-rules/${legacy.id}`)
        .set('Authorization', adminAuth)
        .send({ remark: 'legacy cap preserved' })
        .expect(200);
      expect(patched.body.data.dailyCap).toBe(2);

      const persisted = await prisma.contributionRule.findUniqueOrThrow({
        where: { id: legacy.id },
        select: { dailyCap: true },
      });
      expect(Number(persisted.dailyCap)).toBe(2);

      const log = (await prisma.auditLog.findFirst({ where: { resourceId: legacy.id } }))!;
      const ctx = log.context as {
        before: Record<string, unknown>;
        after: Record<string, unknown>;
        extra: { changedFields: string[] };
      };
      expect(ctx.before.dailyCap).toBe(2);
      expect(ctx.after.dailyCap).toBe(2);
      expect(ctx.extra.changedFields).toContain('remark');
      expect(ctx.extra.changedFields).not.toContain('dailyCap');
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
          allocationModeCode: 'first_come',
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
          allocationModeCode: 'first_come',
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
        data: { memberNo: 'reg-mig-target', ...memberIdentityData('Target Member') },
        select: { id: true },
      });
      regMemberAdminTargetId = targetMember.id;

      // USER + 绑 member(自助报名 / cancelMy 路径)
      const userMember = await prisma.member.create({
        data: { memberNo: 'reg-mig-user-mem', ...memberIdentityData('User Member') },
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
      await truncateActivityRegistrations();
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

    it('exportCsv:返回流前恰好写入 1 条 registration.review', async () => {
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
        .set('Authorization', adminAuth)
        .set('User-Agent', 'audit-migrations-registration-export');
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        event: 'registration.review',
        actorUserId: adminId,
        actorRoleSnap: Role.ADMIN,
        resourceType: 'activity',
        resourceId: actId,
        success: true,
      });
      const context = logs[0].context as {
        requestId: string;
        ip: string | null;
        ua: string | null;
        extra: { operation: string; filterFields: string[] };
      };
      expect(context).toEqual({
        requestId: expect.any(String),
        ip: expect.any(String),
        ua: 'audit-migrations-registration-export',
        extra: { operation: 'export', filterFields: ['scope'] },
      });
      expect(context.requestId.length).toBeGreaterThan(0);
      const serializedContext = JSON.stringify(context);
      expect(serializedContext).not.toContain('all');
      expect(serializedContext).not.toMatch(
        /pii|name|phone|mobile|id.?card|policy|object.?key|signed.?url|url|token|credential/i,
      );
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

  describe('新版结算审计与退役写面', () => {
    let attChildOrgId: string;
    let attMemberAId: string;
    let attMemberBId: string;
    let restoreGate: (() => void) | undefined;
    const fixtures = new Map<
      string,
      {
        runId: string;
        draftId: string;
        identityId: string;
        sealId: string;
      }
    >();

    async function grantNative(userId: string, actions: string[]) {
      const role = await prisma.rbacRole.create({
        data: { code: `audit-native-${userId}`, displayName: '审计验收显式授权' },
      });
      for (const action of actions) {
        const code = `activity.${action}.record`;
        const permission = await prisma.permission.upsert({
          where: { code },
          update: {},
          create: { code, module: 'activity', action, resourceType: 'record' },
        });
        await prisma.rolePermission.create({
          data: { roleId: role.id, permissionId: permission.id },
        });
      }
      await prisma.roleBinding.create({
        data: {
          principalType: 'USER',
          principalId: userId,
          roleId: role.id,
          scopeType: 'GLOBAL',
          status: 'ACTIVE',
        },
      });
    }

    function fixture(activityId: string) {
      const value = fixtures.get(activityId);
      if (!value) throw new Error('Missing native audit fixture');
      return value;
    }

    // 独立组织与两名成员；提交、初审、终审仍由三个不同的真实用户执行。
    beforeAll(async () => {
      // 本组使用真实切换闸的开启配置；不 mock 守卫，也不影响前面其他模块的验收。
      const workflow = app.get<AppConfig>(appConfig.KEY).activityV11Workflow;
      const previous = workflow.enabled;
      restoreGate = () => {
        workflow.enabled = previous;
      };
      workflow.enabled = true;
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

      // A 是负责人及提交者，B 是被认定的参加人员。
      const ma = await prisma.member.create({
        data: {
          memberNo: 'att-mig-a',
          ...memberIdentityData('Att A'),
          status: 'ACTIVE',
          gradeCode: 'level-2',
        },
        select: { id: true },
      });
      attMemberAId = ma.id;
      const mb = await prisma.member.create({
        data: { memberNo: 'att-mig-b', ...memberIdentityData('Att B') },
        select: { id: true },
      });
      attMemberBId = mb.id;
      await prisma.user.update({
        where: { id: attendanceSubmitterId },
        data: { memberId: attMemberAId },
      });
      await grantNative(attendanceSubmitterId, ['settlement-submit', 'settlement-update-draft']);
      await grantNative(adminId, ['settlement-first-review']);
    });

    // 每例独立活动，永久版本不做逐例删除；外层只清审计，worker 收尾回收隔离库。
    afterAll(() => {
      restoreGate?.();
    });

    // 直接构造合法 working draft；真正的提交/认定/审核均走 HTTP 与真实事务。
    const createActivity = async (overrides: { missingResult?: boolean } = {}): Promise<string> => {
      const created = await createSettlementDraftFixture(prisma, {
        organizationId: attChildOrgId,
        participantMemberIds: [attMemberBId],
        ownerMemberId: attMemberAId,
        actorUserId: attendanceSubmitterId,
        activityTypeCode,
        ...overrides,
      });
      fixtures.set(created.activityId, created);
      return created.activityId;
    };

    const appSettlement = (id: string) => `/api/app/v1/my/managed-activities/${id}/settlement`;

    async function submitVersion(activityId: string) {
      const response = await request(httpServer(app))
        .post(`${appSettlement(activityId)}/submit`)
        .set('Authorization', attendanceSubmitterAuth)
        .set('User-Agent', 'audit-native-migration')
        .send({
          operationKey: `submit-${activityId}`,
          expectedDraftVersion: 1,
          evidenceSealId: fixture(activityId).sealId,
          confirmation: true,
        });
      expect({ status: response.status, code: response.body.code }).toEqual({
        status: 200,
        code: 0,
      });
      return response.body.data.settlementVersionId as string;
    }

    async function updateDraft(activityId: string, overrides: Record<string, unknown> = {}) {
      return request(httpServer(app))
        .patch(`${appSettlement(activityId)}/items/${fixture(activityId).identityId}`)
        .set('Authorization', attendanceSubmitterAuth)
        .send({
          expectedDraftVersion: 1,
          resultCode: 'present',
          recognizedServiceHours: 3,
          recognizedContributionPoints: 1,
          reason: '不进入审计的人工原因',
          ...overrides,
        });
    }

    async function reviewVersion(
      versionId: string,
      stage: 'first' | 'final',
      action: 'approve' | 'return',
    ) {
      const version = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: versionId },
      });
      return request(httpServer(app))
        .post(`/api/admin/v1/attendance-settlements/${versionId}/${stage}-${action}`)
        .set('Authorization', stage === 'first' ? adminAuth : finalAdminAuth)
        .send({
          operationKey: `${stage}-${action}-${versionId}`,
          evidenceSealId: version.evidenceSealId,
          evidenceRevision: version.evidenceRevision,
          populationRevision: version.populationRevision,
          workflowRevision: version.workflowRevision,
          contentHash: version.contentHash,
          ...(action === 'return' ? { note: '数据需要复核，保留在业务事实中' } : {}),
        });
    }

    it('POST 新版 submit 触发一条审计且不代改活动生命周期', async () => {
      const actId = await createActivity();
      const versionId = await submitVersion(actId);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      const log = logs[0];
      expect(log.event).toBe('activity.publish');
      expect(log.resourceType).toBe('activity');
      expect(log.resourceId).toBe(actId);
      expect(log.actorUserId).toBe(attendanceSubmitterId);
      expect(log.actorRoleSnap).toBe(Role.ADMIN);
      expect(log.success).toBe(true);
      expect(log.context).toMatchObject({
        extra: {
          operation: 'settlement-submit',
          settlementVersionId: versionId,
          resultRowCount: 1,
        },
      });
      expect(await prisma.activity.findUnique({ where: { id: actId } })).toMatchObject({
        statusCode: 'published',
      });
    });

    it('PATCH 人工认定留下一条修订审计，身份和行数保持', async () => {
      const actId = await createActivity();
      const res = await updateDraft(actId);
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        event: 'activity.publish',
        actorUserId: attendanceSubmitterId,
        actorRoleSnap: Role.ADMIN,
        resourceType: 'activity',
        resourceId: actId,
        context: {
          before: { revision: 0 },
          after: { revision: 1 },
          extra: {
            operation: 'settlement-draft-item-update',
            participationIdentityId: fixture(actId).identityId,
          },
        },
      });
      const rows = await prisma.participantSettlementResultRevision.findMany({
        where: { settlementVersionId: fixture(actId).draftId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        participationIdentityId: fixture(actId).identityId,
        revision: 1,
      });
    });

    it('PATCH 仅原因变化仍审计修订，不改变认定数值或复制自由文本', async () => {
      const actId = await createActivity();
      const res = await updateDraft(actId, {
        recognizedServiceHours: 2,
        recognizedContributionPoints: 0,
      });
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].context).toMatchObject({
        before: { revision: 0, recognizedServiceHours: '2', recognizedContributionPoints: '0' },
        after: { revision: 1, recognizedServiceHours: '2', recognizedContributionPoints: '0' },
        extra: { operation: 'settlement-draft-item-update', adjustmentReasonChanged: true },
      });
      expect(JSON.stringify(logs[0].context)).not.toContain('不进入审计的人工原因');
    });

    it('退役 DELETE 不将新版版本当作旧单据删除，也不产生成功审计', async () => {
      const actId = await createActivity();
      const versionId = await submitVersion(actId);
      const before = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: versionId },
      });
      await truncateAuditLogsTestOnly(app);

      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/attendance-sheets/${versionId}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(404);
      expect(await prisma.auditLog.count()).toBe(0);
      expect(
        await prisma.attendanceSettlementVersion.findUnique({ where: { id: versionId } }),
      ).toEqual(before);
    });

    it('一审通过审计记录动作、前后运行状态与版本', async () => {
      const actId = await createActivity();
      const versionId = await submitVersion(actId);
      await truncateAuditLogsTestOnly(app);

      const res = await reviewVersion(versionId, 'first', 'approve');
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        event: 'activity.publish',
        actorUserId: adminId,
        actorRoleSnap: Role.ADMIN,
        context: {
          extra: {
            operation: 'settlement-first-review',
            actionCode: 'approve',
            settlementVersionId: versionId,
            runStatusBefore: 'pending_first_review',
            runStatusAfter: 'pending_final_review',
          },
        },
      });
    });

    it('一审退回记录审计与业务原因，原因不进入日志', async () => {
      const actId = await createActivity();
      const versionId = await submitVersion(actId);
      await truncateAuditLogsTestOnly(app);

      const res = await reviewVersion(versionId, 'first', 'return');
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].context).toMatchObject({
        extra: {
          operation: 'settlement-first-review',
          actionCode: 'return',
          versionStatusAfter: 'returned',
        },
      });
      expect(JSON.stringify(logs[0].context)).not.toContain('数据需要复核');
      expect(
        await prisma.attendanceSettlementVersion.findUnique({ where: { id: versionId } }),
      ).toMatchObject({ statusCode: 'returned', returnReason: '数据需要复核，保留在业务事实中' });
    });

    it('终审通过审计关联准备批次，尚未提前入账或关账', async () => {
      const actId = await createActivity();
      const versionId = await submitVersion(actId);
      expect((await reviewVersion(versionId, 'first', 'approve')).status).toBe(200);
      await truncateAuditLogsTestOnly(app);

      const res = await reviewVersion(versionId, 'final', 'approve');
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        event: 'activity.publish',
        actorRoleSnap: Role.SUPER_ADMIN,
        context: {
          extra: {
            operation: 'settlement-final-review',
            actionCode: 'approve',
            versionStatusAfter: 'approved',
            firstReviewerUserId: adminId,
            ledgerPostingBatchId: res.body.data.ledgerPostingBatchId,
            ledgerPostingBatchStatus: 'preparing',
          },
        },
      });
      expect(
        await prisma.ledgerPostingBatch.findUnique({
          where: { id: res.body.data.ledgerPostingBatchId },
        }),
      ).toMatchObject({ settlementVersionId: versionId, statusCode: 'preparing' });
      expect(
        await prisma.attendanceSettlementRun.findUnique({ where: { id: fixture(actId).runId } }),
      ).not.toMatchObject({ statusCode: 'posted' });
    });

    it('终审退回记录阶段与原因，保留版本的结果历史', async () => {
      const actId = await createActivity();
      const versionId = await submitVersion(actId);
      expect((await reviewVersion(versionId, 'first', 'approve')).status).toBe(200);
      const before = await prisma.participantSettlementResultRevision.findMany({
        where: { settlementVersionId: versionId },
      });
      await truncateAuditLogsTestOnly(app);

      const res = await reviewVersion(versionId, 'final', 'return');
      expect(res.status).toBe(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0].context).toMatchObject({
        extra: {
          operation: 'settlement-final-review',
          actionCode: 'return',
          versionStatusAfter: 'returned',
          firstReviewerUserId: adminId,
        },
      });
      expect(
        await prisma.participantSettlementResultRevision.findMany({
          where: { settlementVersionId: versionId },
        }),
      ).toEqual(before);
      expect(JSON.stringify(logs[0].context)).not.toContain('数据需要复核');
    });

    it('context 锁形:requestId 非空,ip / ua 字段存在', async () => {
      const actId = await createActivity();
      await submitVersion(actId);

      const log = (await prisma.auditLog.findFirst({ where: { resourceId: actId } }))!;
      const ctx = log.context as Record<string, unknown>;
      expect(typeof ctx.requestId).toBe('string');
      expect((ctx.requestId as string).length).toBeGreaterThan(0);
      expect('ip' in ctx).toBe(true);
      expect(ctx.ua).toBe('audit-native-migration');
    });

    it('提交审计指向可还原的不可变版本、草稿和结果数量，不复制整行', async () => {
      const actId = await createActivity();
      const versionId = await submitVersion(actId);
      const version = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: versionId },
        include: { resultRevisions: true },
      });
      const log = (await prisma.auditLog.findFirst({ where: { resourceId: actId } }))!;
      const ctx = log.context as Record<string, unknown>;
      expect(ctx.before).toBeUndefined();
      expect(ctx.after).toBeUndefined();
      expect(ctx.extra).toMatchObject({
        settlementVersionId: versionId,
        settlementVersion: version.version,
        draftVersionId: fixture(actId).draftId,
        contentHash: version.contentHash,
        resultRowCount: version.resultRevisions.length,
      });
      expect(version.resultRevisions).toHaveLength(1);
      expect(version.statusCode).toBe('submitted');
      expect(version.version).toBe(2);
      expect(JSON.stringify(ctx)).not.toContain(attMemberBId);
    });

    it('认定审计保留完整结果前后差异和修订号', async () => {
      const actId = await createActivity();
      expect((await updateDraft(actId)).status).toBe(200);

      const log = (await prisma.auditLog.findFirst({ where: { resourceId: actId } }))!;
      const ctx = log.context as Record<string, unknown>;
      expect(ctx.before).toEqual({
        revision: 0,
        resultCode: 'present',
        recognizedServiceHours: '2',
        recognizedContributionPoints: '0',
      });
      expect(ctx.after).toEqual({
        revision: 1,
        resultCode: 'present',
        recognizedServiceHours: '3',
        recognizedContributionPoints: '1',
      });
    });

    it('退役删除保留草稿、提交版本及全部结果历史', async () => {
      const actId = await createActivity();
      const versionId = await submitVersion(actId);
      const history = () =>
        prisma.attendanceSettlementVersion.findMany({
          where: { settlementRunId: fixture(actId).runId },
          orderBy: { version: 'asc' },
          include: { resultRevisions: true },
        });
      const before = await history();
      expect(before).toHaveLength(2);
      await truncateAuditLogsTestOnly(app);

      for (const id of [fixture(actId).draftId, versionId]) {
        await request(httpServer(app))
          .delete(`/api/admin/v1/attendance-sheets/${id}`)
          .set('Authorization', adminAuth)
          .expect(404);
      }
      expect(await history()).toEqual(before);
      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('终审退回审计可还原前后状态，历史指针及内容摘要保留', async () => {
      const actId = await createActivity();
      const versionId = await submitVersion(actId);
      expect((await reviewVersion(versionId, 'first', 'approve')).status).toBe(200);
      const before = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: versionId },
      });
      await truncateAuditLogsTestOnly(app);

      expect((await reviewVersion(versionId, 'final', 'return')).status).toBe(200);
      const log = (await prisma.auditLog.findFirst({ where: { resourceId: actId } }))!;
      expect(log.context).toMatchObject({
        extra: {
          runStatusBefore: 'pending_final_review',
          runStatusAfter: 'drafting',
          versionStatusAfter: 'returned',
          settlementVersionId: versionId,
          contentHash: before.contentHash,
        },
      });
      expect(
        await prisma.attendanceSettlementVersion.findUnique({ where: { id: versionId } }),
      ).toMatchObject({
        contentHash: before.contentHash,
        returnFromStage: 'final',
        statusCode: 'returned',
      });
      expect(
        await prisma.attendanceSettlementRun.findUnique({ where: { id: fixture(actId).runId } }),
      ).toMatchObject({ currentSubmittedVersion: before.version });
    });

    it('非法认定结果拒绝时草稿与审计均不改变', async () => {
      const actId = await createActivity();
      const rows = () =>
        prisma.participantSettlementResultRevision.findMany({
          where: { settlementVersionId: fixture(actId).draftId },
        });
      const before = await rows();
      const auditBefore = await prisma.auditLog.count();

      const res = await updateDraft(actId, { resultCode: 'invalid-result' });
      expect(res.status).toBe(400);
      expect(await rows()).toEqual(before);
      expect(await prisma.auditLog.count()).toBe(auditBefore);
    });

    it('未完成认定不能进入审核：提交拒绝且版本、指针、审计零写', async () => {
      const actId = await createActivity({ missingResult: true });
      // 新结果数值不可为 NULL；未计算完的人口在提交边界即拒绝，不能进入审核链。
      const runBefore = await prisma.attendanceSettlementRun.findUniqueOrThrow({
        where: { id: fixture(actId).runId },
      });
      const versionBefore = await prisma.attendanceSettlementVersion.findMany({
        where: { settlementRunId: runBefore.id },
      });
      const res = await request(httpServer(app))
        .post(`${appSettlement(actId)}/submit`)
        .set('Authorization', attendanceSubmitterAuth)
        .send({
          operationKey: `pending-${actId}`,
          expectedDraftVersion: 1,
          evidenceSealId: fixture(actId).sealId,
          confirmation: true,
        });
      expectBizError(res, BizCode.SETTLEMENT_SUBMIT_PENDING_RESULT);
      expect(
        await prisma.attendanceSettlementRun.findUnique({ where: { id: runBefore.id } }),
      ).toEqual(runBefore);
      expect(
        await prisma.attendanceSettlementVersion.findMany({
          where: { settlementRunId: runBefore.id },
        }),
      ).toEqual(versionBefore);
      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('GET 活动账本：一条读取审计，未入账版本不作为正式记录返回', async () => {
      const actId = await createActivity();
      await submitVersion(actId);
      await truncateAuditLogsTestOnly(app);

      const response = await request(httpServer(app))
        .get(`/api/admin/v1/activities/${actId}/participation-ledger`)
        .set('Authorization', adminAuth)
        .set('User-Agent', 'audit-migrations-attendance-read')
        .expect(200);
      expect(response.body.data.items).toEqual([]);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        event: 'attendance-sheet.read.other',
        actorUserId: adminId,
        actorRoleSnap: Role.ADMIN,
        resourceType: 'activity',
        resourceId: actId,
        success: true,
      });
      const context = logs[0].context as {
        requestId: string;
        ip: string | null;
        ua: string | null;
        extra: { operation: string; count: number; filterFields: string[] };
      };
      expect(context).toEqual({
        requestId: expect.any(String),
        ip: expect.any(String),
        ua: 'audit-migrations-attendance-read',
        extra: { operation: 'participation-ledger', count: 0, filterFields: [] },
      });
      expect(context.requestId.length).toBeGreaterThan(0);
      expect(JSON.stringify(context)).not.toMatch(
        /pii|name|phone|mobile|id.?card|policy|object.?key|signed.?url|url|token|credential/i,
      );
    });

    it('GET 队员账本：恰好一条审计且不含参与者明细', async () => {
      const actId = await createActivity();
      await submitVersion(actId);
      await truncateAuditLogsTestOnly(app);

      const response = await request(httpServer(app))
        .get(`/api/admin/v1/members/${attMemberBId}/participation-ledger`)
        .set('Authorization', adminAuth)
        .set('User-Agent', 'audit-migrations-attendance-read')
        .expect(200);
      expect(response.body.data.items).toEqual([]);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        event: 'attendance-sheet.read.other',
        actorUserId: adminId,
        actorRoleSnap: Role.ADMIN,
        resourceType: 'member',
        resourceId: attMemberBId,
        success: true,
      });
      const context = logs[0].context as {
        requestId: string;
        ip: string | null;
        ua: string | null;
        extra: { operation: string };
      };
      expect(context).toEqual({
        requestId: expect.any(String),
        ip: expect.any(String),
        ua: 'audit-migrations-attendance-read',
        extra: { operation: 'participation-ledger', count: 0, filterFields: [] },
      });
      expect(context.requestId.length).toBeGreaterThan(0);
      expect(JSON.stringify(context)).not.toMatch(
        /pii|name|phone|mobile|id.?card|policy|object.?key|signed.?url|url|token|credential/i,
      );
    });

    it('GET review-detail:恰好写入 1 条 attendance-sheet.read.other', async () => {
      const actId = await createActivity();
      const versionId = await submitVersion(actId);
      await truncateAuditLogsTestOnly(app);

      await request(httpServer(app))
        .get(`/api/admin/v1/attendance-settlements/${versionId}/review-detail`)
        .set('Authorization', adminAuth)
        .set('User-Agent', 'audit-migrations-attendance-read')
        .expect(200);

      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        event: 'attendance-sheet.read.other',
        actorUserId: adminId,
        actorRoleSnap: Role.ADMIN,
        resourceType: 'attendance_settlement_version',
        resourceId: versionId,
        success: true,
      });
      const context = logs[0].context as {
        requestId: string;
        ip: string | null;
        ua: string | null;
        extra: { operation: string; count: number };
      };
      expect(context).toEqual({
        requestId: expect.any(String),
        ip: expect.any(String),
        ua: 'audit-migrations-attendance-read',
        extra: { operation: 'settlement-review-detail', count: 1, filterFields: [] },
      });
      expect(context.requestId.length).toBeGreaterThan(0);
      expect(JSON.stringify(context)).not.toMatch(
        /pii|name|phone|mobile|id.?card|policy|object.?key|signed.?url|url|token|credential/i,
      );
    });

    it('终审审计与真实审核动作、准备批次并存，不用事件标志代替业务事实', async () => {
      const actId = await createActivity();
      const versionId = await submitVersion(actId);
      expect((await reviewVersion(versionId, 'first', 'approve')).status).toBe(200);
      await truncateAuditLogsTestOnly(app);

      const response = await reviewVersion(versionId, 'final', 'approve');
      expect(response.status).toBe(200);

      // 旧 attendance.recorded 退出；实际业务记录与审计同存，通知决策另行验收。
      const logs = await prisma.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        event: 'activity.publish',
        context: {
          extra: {
            operation: 'settlement-final-review',
            reviewActionId: response.body.data.reviewActionId,
            ledgerPostingBatchId: response.body.data.ledgerPostingBatchId,
          },
        },
      });
      expect(
        await prisma.settlementReviewAction.findUnique({
          where: { id: response.body.data.reviewActionId },
        }),
      ).toMatchObject({
        settlementVersionId: versionId,
        stageCode: 'final',
        actionCode: 'approve',
      });
      expect(
        await prisma.ledgerPostingBatch.findUnique({
          where: { id: response.body.data.ledgerPostingBatchId },
        }),
      ).toMatchObject({ settlementVersionId: versionId, statusCode: 'preparing' });
    });
  });
});
