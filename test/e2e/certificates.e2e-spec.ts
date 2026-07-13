import type { INestApplication } from '@nestjs/common';
import { DictItemStatus, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2 第一阶段批次 2 certificates 模块 e2e。
// 覆盖 8 接口主成功 + 关键失败:权限 / 字典 / 状态机 / 跨 member / 软删 / 排序 / qualification-flag /
// 字段白名单 / 拒绝后重新提交。预计 50+ 用例(沿 batch 1 emergency-contacts.e2e 风格)。
//
// Slow-4 T2(2026-06-11,评审稿 §8 / D-S4-4):入口切到 service 层 rbac.can();
// 失败统一 RBAC_FORBIDDEN(30100)。`adminAuth` / `adminWithMemberAuth` 两个 ADMIN 测试用户
// 在 beforeAll 全局 grant biz-admin,业务断言零修改;
// 细粒度判权矩阵另见 certificates-rbac-boundary.e2e-spec.ts。

describe('certificates 模块', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let adminAuth: string;
  let userAuth: string;
  let adminWithMemberAuth: string;

  let memberA: string; // 主用 member
  let memberB: string; // 跨 member 测试
  let adminMemberId: string; // ADMIN 绑定的 member,用于测 verifiedBy=memberId 路径
  let activeCertTypeCode: string;
  let inactiveCertTypeCode: string;
  let activeCertSubTypeCode: string;
  let secondActiveCertTypeCode: string; // 用于 supersededBy / 多类型测试

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    // 4 用户:su / adm(无 memberId)/ user / adm-with-member(有 memberId)
    await createTestUser(app, { username: 'cert-su', role: Role.SUPER_ADMIN });
    const admin = await createTestUser(app, { username: 'cert-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'cert-user', role: Role.USER });
    const admin2 = await createTestUser(app, { username: 'cert-adm2', role: Role.ADMIN });
    superAdminAuth = (await loginAs(app, 'cert-su')).authHeader;
    adminAuth = (await loginAs(app, 'cert-adm')).authHeader;
    userAuth = (await loginAs(app, 'cert-user')).authHeader;
    adminWithMemberAuth = (await loginAs(app, 'cert-adm2')).authHeader;

    // Slow-4 T2:seed 36 条业务面码 + biz-admin;给两个 ADMIN 测试用户全局 grant(沿 org e2e 范式)
    const bizSeed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, admin.id, bizSeed.bizAdminRoleId);
    await grantBizAdminToUser(app, admin2.id, bizSeed.bizAdminRoleId);

    // 3 个 member:A 主、B 跨、admMember 用于绑定 ADMIN 测 verifiedBy
    const a = await prisma.member.create({
      data: { memberNo: 'cert-m-a', displayName: 'Member A' },
      select: { id: true },
    });
    memberA = a.id;
    const b = await prisma.member.create({
      data: { memberNo: 'cert-m-b', displayName: 'Member B' },
      select: { id: true },
    });
    memberB = b.id;
    const admMember = await prisma.member.create({
      data: { memberNo: 'cert-m-adm', displayName: 'Admin Member' },
      select: { id: true },
    });
    adminMemberId = admMember.id;
    // 绑定 cert-adm2 的 user.memberId(测试 verifiedBy 写入路径)
    await prisma.user.update({
      where: { username: 'cert-adm2' },
      data: { memberId: adminMemberId },
    });

    // cert_type 字典(active + inactive)
    const certTypeDict = await prisma.dictType.create({
      data: { code: 'cert_type', label: '证书大类' },
      select: { id: true },
    });
    const certTypeActive = await prisma.dictItem.create({
      data: { typeId: certTypeDict.id, code: 'first_aid', label: '救护员' },
      select: { code: true },
    });
    activeCertTypeCode = certTypeActive.code;
    const certTypeSecond = await prisma.dictItem.create({
      data: { typeId: certTypeDict.id, code: 'bsafe', label: 'BSAFE' },
      select: { code: true },
    });
    secondActiveCertTypeCode = certTypeSecond.code;
    const certTypeInactive = await prisma.dictItem.create({
      data: {
        typeId: certTypeDict.id,
        code: 'cert-type-inactive',
        label: '已停用类型',
        status: DictItemStatus.INACTIVE,
      },
      select: { code: true },
    });
    inactiveCertTypeCode = certTypeInactive.code;

    // cert_sub_type 字典
    const certSubTypeDict = await prisma.dictType.create({
      data: { code: 'cert_sub_type', label: '证书等级' },
      select: { id: true },
    });
    const subTypeActive = await prisma.dictItem.create({
      data: { typeId: certSubTypeDict.id, code: 'first_aid_basic', label: '救护员基础' },
      select: { code: true },
    });
    activeCertSubTypeCode = subTypeActive.code;
  });

  afterAll(async () => {
    await app.close();
  });

  const baseCreatePayload = (override: Record<string, unknown> = {}): Record<string, unknown> => ({
    certTypeCode: activeCertTypeCode,
    issuingOrg: '演示颁发机构 A',
    issuedAt: '2024-01-01T00:00:00.000Z',
    ...override,
  });

  // ============ 权限边界 ============

  describe('权限边界', () => {
    it('未登录 GET list → 401', async () => {
      const res = await request(httpServer(app)).get(
        `/api/admin/v1/members/${memberA}/certificates`,
      );
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER GET list → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER POST → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', userAuth)
        .send(baseCreatePayload());
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER GET detail → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberA}/certificates/cl000000000000000000xxxx`)
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER PATCH → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/cl000000000000000000xxxx`)
        .set('Authorization', userAuth)
        .send({ issuingOrg: 'X' });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER DELETE → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/members/${memberA}/certificates/cl000000000000000000xxxx`)
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER PATCH /verify → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/cl000000000000000000xxxx/verify`)
        .set('Authorization', userAuth)
        .send({});
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER PATCH /reject → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/cl000000000000000000xxxx/reject`)
        .set('Authorization', userAuth)
        .send({ verifyNote: 'X' });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER GET /qualification-flag → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberA}/certificates/qualification-flag`)
        .query({ certTypeCode: activeCertTypeCode })
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  // ============ GET list 主路径 ============

  describe('GET list', () => {
    it('member 不存在 → MEMBER_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/members/cl0000000000000000000000/certificates')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('空列表 → 200 + 空数组', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(0);
    });
  });

  // ============ POST 主路径 ============

  describe('POST 主路径', () => {
    it('member 不存在 → MEMBER_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/members/cl0000000000000000000000/certificates')
        .set('Authorization', adminAuth)
        .send(baseCreatePayload());
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('ADMIN 创建仅必填 → 201,status=pending,isInternal=false,不返 deletedAt / attachmentKey', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload());
      expect(res.status).toBe(201);
      expect(res.body.code).toBe(0);
      expect(res.body.data.memberId).toBe(memberA);
      expect(res.body.data.certTypeCode).toBe(activeCertTypeCode);
      expect(res.body.data.certStatusCode).toBe('pending');
      expect(res.body.data.isInternal).toBe(false);
      expect(res.body.data.verifiedBy).toBeNull();
      expect(res.body.data.verifiedAt).toBeNull();
      expect(res.body.data.verifyNote).toBeNull();
      expect(res.body.data.expiredAt).toBeNull();
      expect(res.body.data.supersededByCertId).toBeNull();
      expect(res.body.data).not.toHaveProperty('deletedAt');
      expect(res.body.data).not.toHaveProperty('expireNotifyDueAt');
      // V2.x C-7 attachments PR #2:attachmentKey 字段已删除,出参不再包含
      expect(res.body.data).not.toHaveProperty('attachmentKey');
    });

    it('SUPER_ADMIN 创建完整字段 → 201', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', superAdminAuth)
        .send({
          certTypeCode: activeCertTypeCode,
          certSubTypeCode: activeCertSubTypeCode,
          issuingOrg: '演示颁发机构 B',
          certNumber: 'DEMO-CERT-002',
          issuedAt: '2023-06-01T00:00:00.000Z',
          expiredAt: '2030-06-01T00:00:00.000Z',
        });
      expect(res.status).toBe(201);
      expect(res.body.data.certSubTypeCode).toBe(activeCertSubTypeCode);
      expect(res.body.data.certNumber).toBe('DEMO-CERT-002');
      expect(res.body.data.expiredAt).toBe('2030-06-01T00:00:00.000Z');
    });

    it('cert_type 不存在 → CERTIFICATE_TYPE_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ certTypeCode: 'no-such-type' }));
      expectBizError(res, BizCode.CERTIFICATE_TYPE_CODE_INVALID);
    });

    it('cert_type INACTIVE → CERTIFICATE_TYPE_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ certTypeCode: inactiveCertTypeCode }));
      expectBizError(res, BizCode.CERTIFICATE_TYPE_CODE_INVALID);
    });

    it('cert_sub_type 不存在 → CERTIFICATE_SUB_TYPE_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ certSubTypeCode: 'no-such-sub' }));
      expectBizError(res, BizCode.CERTIFICATE_SUB_TYPE_CODE_INVALID);
    });

    it('缺 certTypeCode → 400', async () => {
      const payload = baseCreatePayload();
      delete payload.certTypeCode;
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(payload);
      expect(res.status).toBe(400);
    });

    it('缺 issuingOrg → 400', async () => {
      const payload = baseCreatePayload();
      delete payload.issuingOrg;
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(payload);
      expect(res.status).toBe(400);
    });

    it('缺 issuedAt → 400', async () => {
      const payload = baseCreatePayload();
      delete payload.issuedAt;
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(payload);
      expect(res.status).toBe(400);
    });

    it('non-whitelisted certStatusCode → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ certStatusCode: 'verified' }));
      expect(res.status).toBe(400);
    });

    it('non-whitelisted isInternal → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ isInternal: true }));
      expect(res.status).toBe(400);
    });

    it('non-whitelisted verifiedBy → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ verifiedBy: 'cl0000000000000000000000' }));
      expect(res.status).toBe(400);
    });

    it('non-whitelisted supersededByCertId → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ supersededByCertId: 'cl0000000000000000000000' }));
      expect(res.status).toBe(400);
    });

    // V2.x C-7 attachments PR #2:attachmentKey 字段已删除,原 `non-whitelisted attachmentKey → 400`
    // 测试整段删除(沿 D7 v1.0 §4.6;字段不再存在,白名单拒绝语义由其他禁字段如 supersededByCertId / verifiedBy 等覆盖)。

    it('non-whitelisted memberId → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ memberId: 'cl0000000000000000000000' }));
      expect(res.status).toBe(400);
    });

    it('non-whitelisted deletedAt → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ deletedAt: new Date().toISOString() }));
      expect(res.status).toBe(400);
    });
  });

  // ============ GET list 排序 + 列表精简 ============

  describe('GET list 排序 + 精简字段', () => {
    it('多条按 certStatusCode ASC, createdAt DESC 排序;列表项不含敏感字段', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      const items: Array<Record<string, unknown>> = res.body.data;
      expect(items.length).toBeGreaterThanOrEqual(2);
      // 列表项**不含** certNumber / verifyNote / verifiedBy / verifiedAt / supersededByCertId(草案 §13.1)
      // attachmentKey 字段已于 V2.x C-7 attachments PR #2 删除(沿 D7 v1.0 §4.6),全局不再返回
      for (const item of items) {
        expect(item).not.toHaveProperty('certNumber');
        expect(item).not.toHaveProperty('verifyNote');
        expect(item).not.toHaveProperty('verifiedBy');
        expect(item).not.toHaveProperty('verifiedAt');
        expect(item).not.toHaveProperty('attachmentKey');
        expect(item).not.toHaveProperty('supersededByCertId');
        expect(item).not.toHaveProperty('deletedAt');
      }
    });
  });

  // ============ GET detail ============

  describe('GET detail', () => {
    let certIdA: string;

    beforeAll(async () => {
      // 创建一条用于 detail 测试
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ certNumber: 'DETAIL-CERT-001' }));
      certIdA = res.body.data.id;
    });

    it('cert 不存在 → CERTIFICATE_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberA}/certificates/cl0000000000000000000000`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.CERTIFICATE_NOT_FOUND);
    });

    it('cert 跨 member → CERTIFICATE_NOT_BELONGS_TO_MEMBER', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberB}/certificates/${certIdA}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.CERTIFICATE_NOT_BELONGS_TO_MEMBER);
    });

    it('200 完整字段 + 不返 deletedAt / attachmentKey', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberA}/certificates/${certIdA}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(certIdA);
      expect(res.body.data.certNumber).toBe('DETAIL-CERT-001');
      expect(res.body.data).not.toHaveProperty('deletedAt');
      expect(res.body.data).not.toHaveProperty('expireNotifyDueAt');
      // V2.x C-7 attachments PR #2:attachmentKey 字段已删除
      expect(res.body.data).not.toHaveProperty('attachmentKey');
    });
  });

  // ============ PATCH 更新 ============

  describe('PATCH 更新', () => {
    let certIdA: string;

    beforeAll(async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ issuingOrg: '原机构', certNumber: 'PATCH-001' }));
      certIdA = res.body.data.id;
    });

    it('部分更新 issuingOrg / certNumber → 200', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${certIdA}`)
        .set('Authorization', adminAuth)
        .send({ issuingOrg: '新机构', certNumber: 'PATCH-001-UPDATED' });
      expect(res.status).toBe(200);
      expect(res.body.data.issuingOrg).toBe('新机构');
      expect(res.body.data.certNumber).toBe('PATCH-001-UPDATED');
    });

    it('finding #7:verified 核心字段编辑 → pending + 核验三字段清空,随后可重新 verify', async () => {
      const created = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ certNumber: 'RESET-VERIFIED-BEFORE' }));
      const certificateId = created.body.data.id as string;
      await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${certificateId}/verify`)
        .set('Authorization', adminWithMemberAuth)
        .send({ verifyNote: '首次核验通过' })
        .expect(200);

      const edited = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${certificateId}`)
        .set('Authorization', adminAuth)
        .send({ certNumber: 'RESET-VERIFIED-AFTER' })
        .expect(200);
      expect(edited.body.data.certStatusCode).toBe('pending');
      expect(edited.body.data.verifiedBy).toBeNull();
      expect(edited.body.data.verifiedAt).toBeNull();
      expect(edited.body.data.verifyNote).toBeNull();

      const reverified = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${certificateId}/verify`)
        .set('Authorization', adminWithMemberAuth)
        .send({ verifyNote: '核心字段修改后重审' })
        .expect(200);
      expect(reverified.body.data.certStatusCode).toBe('verified');
      expect(reverified.body.data.verifiedBy).toBe(adminMemberId);
    });

    it('finding #7:rejected 核心字段编辑 → pending + 核验三字段清空', async () => {
      const created = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ certNumber: 'RESET-REJECTED-BEFORE' }));
      const certificateId = created.body.data.id as string;
      await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${certificateId}/reject`)
        .set('Authorization', adminWithMemberAuth)
        .send({ verifyNote: '首次核验驳回' })
        .expect(200);

      const edited = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${certificateId}`)
        .set('Authorization', adminAuth)
        .send({ issuingOrg: '修正后的颁发机构' })
        .expect(200);
      expect(edited.body.data.certStatusCode).toBe('pending');
      expect(edited.body.data.verifiedBy).toBeNull();
      expect(edited.body.data.verifiedAt).toBeNull();
      expect(edited.body.data.verifyNote).toBeNull();
    });

    it('finding #7:pending 核心字段编辑保持 pending,不改变既有核验空值语义', async () => {
      const created = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ certNumber: 'RESET-PENDING-BEFORE' }));
      const certificateId = created.body.data.id as string;

      const edited = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${certificateId}`)
        .set('Authorization', adminAuth)
        .send({ certNumber: 'RESET-PENDING-AFTER' })
        .expect(200);
      expect(edited.body.data.certStatusCode).toBe('pending');
      expect(edited.body.data.verifiedBy).toBeNull();
      expect(edited.body.data.verifiedAt).toBeNull();
      expect(edited.body.data.verifyNote).toBeNull();
    });

    it('Q-A4:更新 issuedAt + expiredAt → 200', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${certIdA}`)
        .set('Authorization', superAdminAuth)
        .send({
          issuedAt: '2024-03-01T00:00:00.000Z',
          expiredAt: '2029-03-01T00:00:00.000Z',
        });
      expect(res.status).toBe(200);
      expect(res.body.data.issuedAt).toBe('2024-03-01T00:00:00.000Z');
      expect(res.body.data.expiredAt).toBe('2029-03-01T00:00:00.000Z');
    });

    it('PATCH cert_type 字典 invalid → CERTIFICATE_TYPE_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${certIdA}`)
        .set('Authorization', adminAuth)
        .send({ certTypeCode: 'no-such-type' });
      expectBizError(res, BizCode.CERTIFICATE_TYPE_CODE_INVALID);
    });

    it('non-whitelisted certStatusCode → 400', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${certIdA}`)
        .set('Authorization', adminAuth)
        .send({ certStatusCode: 'verified' });
      expect(res.status).toBe(400);
    });

    it('non-whitelisted verifyNote → 400', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${certIdA}`)
        .set('Authorization', adminAuth)
        .send({ verifyNote: '尝试通过 PATCH 写核验备注' });
      expect(res.status).toBe(400);
    });

    it('non-whitelisted isInternal → 400', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${certIdA}`)
        .set('Authorization', adminAuth)
        .send({ isInternal: true });
      expect(res.status).toBe(400);
    });

    it('cert 不存在 → CERTIFICATE_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/cl0000000000000000000000`)
        .set('Authorization', adminAuth)
        .send({ issuingOrg: 'X' });
      expectBizError(res, BizCode.CERTIFICATE_NOT_FOUND);
    });

    it('cert 跨 member → CERTIFICATE_NOT_BELONGS_TO_MEMBER', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberB}/certificates/${certIdA}`)
        .set('Authorization', adminAuth)
        .send({ issuingOrg: 'X' });
      expectBizError(res, BizCode.CERTIFICATE_NOT_BELONGS_TO_MEMBER);
    });
  });

  // ============ DELETE 软删 ============

  describe('DELETE 软删', () => {
    let certIdA: string;

    beforeAll(async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ certNumber: 'DEL-001' }));
      certIdA = res.body.data.id;
    });

    it('cert 不存在 → CERTIFICATE_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/members/${memberA}/certificates/cl0000000000000000000000`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.CERTIFICATE_NOT_FOUND);
    });

    it('跨 member → CERTIFICATE_NOT_BELONGS_TO_MEMBER', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/members/${memberB}/certificates/${certIdA}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.CERTIFICATE_NOT_BELONGS_TO_MEMBER);
    });

    it('正常软删 → 200 + DB.deletedAt 非空 + 列表过滤 + 详情 NOT_FOUND', async () => {
      const delRes = await request(httpServer(app))
        .delete(`/api/admin/v1/members/${memberA}/certificates/${certIdA}`)
        .set('Authorization', adminAuth);
      expect(delRes.status).toBe(200);
      expect(delRes.body.data.id).toBe(certIdA);

      const dbRow = await prisma.certificate.findUnique({ where: { id: certIdA } });
      expect(dbRow?.deletedAt).not.toBeNull();

      const listRes = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth);
      const ids: string[] = (listRes.body.data as Array<{ id: string }>).map((i) => i.id);
      expect(ids).not.toContain(certIdA);

      const detailRes = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberA}/certificates/${certIdA}`)
        .set('Authorization', adminAuth);
      expectBizError(detailRes, BizCode.CERTIFICATE_NOT_FOUND);
    });

    it('再次 DELETE 已软删 cert → CERTIFICATE_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/members/${memberA}/certificates/${certIdA}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.CERTIFICATE_NOT_FOUND);
    });
  });

  // ============ verify 动作 ============

  describe('PATCH /verify', () => {
    let pendingCertId: string;
    let alreadyVerifiedCertId: string;
    let alreadyRejectedCertId: string;

    beforeAll(async () => {
      const r1 = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ certNumber: 'VER-PEND' }));
      pendingCertId = r1.body.data.id;

      const r2 = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ certNumber: 'VER-ALREADY' }));
      alreadyVerifiedCertId = r2.body.data.id;
      // 先 verify 一次
      await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${alreadyVerifiedCertId}/verify`)
        .set('Authorization', superAdminAuth)
        .send({});

      const r3 = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ certNumber: 'VER-REJ' }));
      alreadyRejectedCertId = r3.body.data.id;
      await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${alreadyRejectedCertId}/reject`)
        .set('Authorization', adminAuth)
        .send({ verifyNote: '材料不符' });
    });

    it('SUPER_ADMIN(无 memberId)verify → verified, verifiedBy=null(Q-I2)', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${pendingCertId}/verify`)
        .set('Authorization', superAdminAuth)
        .send({ verifyNote: '材料齐全' });
      expect(res.status).toBe(200);
      expect(res.body.data.certStatusCode).toBe('verified');
      expect(res.body.data.verifiedBy).toBeNull();
      expect(res.body.data.verifyNote).toBe('材料齐全');
      expect(res.body.data.verifiedAt).not.toBeNull();
    });

    it('ADMIN(已绑 memberId)verify → verifiedBy=user.memberId(Q-I2)', async () => {
      // 创建新的 pending 用于本用例
      const r = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ certNumber: 'VER-BOUND' }));
      const id = r.body.data.id;

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${id}/verify`)
        .set('Authorization', adminWithMemberAuth)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.data.certStatusCode).toBe('verified');
      expect(res.body.data.verifiedBy).toBe(adminMemberId);
      expect(res.body.data.verifyNote).toBeNull();
    });

    it('finding #6:同一 pending 并发 verify || reject → 恰一方成功,败者 INVALID_STATE_TRANSITION', async () => {
      const created = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ certNumber: 'CERT-VERIFY-RACE' }));
      const certificateId = created.body.data.id as string;

      const results = await Promise.all([
        request(httpServer(app))
          .patch(`/api/admin/v1/members/${memberA}/certificates/${certificateId}/verify`)
          .set('Authorization', adminWithMemberAuth)
          .send({ verifyNote: 'race verify' }),
        request(httpServer(app))
          .patch(`/api/admin/v1/members/${memberA}/certificates/${certificateId}/reject`)
          .set('Authorization', adminWithMemberAuth)
          .send({ verifyNote: 'race reject' }),
      ]);

      expect(results.filter((result) => result.status === 200)).toHaveLength(1);
      const loser = results.find((result) => result.status !== 200);
      expect(loser).toBeDefined();
      expectBizError(loser!, BizCode.CERTIFICATE_INVALID_STATE_TRANSITION);
      const row = await prisma.certificate.findUniqueOrThrow({
        where: { id: certificateId },
        select: { certStatusCode: true },
      });
      expect(['verified', 'rejected']).toContain(row.certStatusCode);
      expect(await prisma.auditLog.count({ where: { resourceId: certificateId } })).toBe(2);
    });

    it('已 verified 再 verify → CERTIFICATE_INVALID_STATE_TRANSITION', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${alreadyVerifiedCertId}/verify`)
        .set('Authorization', adminAuth)
        .send({});
      expectBizError(res, BizCode.CERTIFICATE_INVALID_STATE_TRANSITION);
    });

    it('已 rejected 再 verify → CERTIFICATE_INVALID_STATE_TRANSITION', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${alreadyRejectedCertId}/verify`)
        .set('Authorization', adminAuth)
        .send({});
      expectBizError(res, BizCode.CERTIFICATE_INVALID_STATE_TRANSITION);
    });

    it('verify non-whitelisted issuedAt → 400', async () => {
      const r = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ certNumber: 'VER-NW' }));
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${r.body.data.id}/verify`)
        .set('Authorization', adminAuth)
        .send({ issuedAt: '2025-01-01T00:00:00.000Z' });
      expect(res.status).toBe(400);
    });

    it('verify non-whitelisted certStatusCode → 400', async () => {
      const r = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ certNumber: 'VER-NW2' }));
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${r.body.data.id}/verify`)
        .set('Authorization', adminAuth)
        .send({ certStatusCode: 'expired' });
      expect(res.status).toBe(400);
    });

    it('verify cert 跨 member → CERTIFICATE_NOT_BELONGS_TO_MEMBER', async () => {
      const r = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ certNumber: 'VER-CROSS' }));
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberB}/certificates/${r.body.data.id}/verify`)
        .set('Authorization', adminAuth)
        .send({});
      expectBizError(res, BizCode.CERTIFICATE_NOT_BELONGS_TO_MEMBER);
    });
  });

  // ============ reject 动作 ============

  describe('PATCH /reject', () => {
    it('pending → rejected,verifyNote 必填', async () => {
      const r = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ certNumber: 'REJ-001' }));
      const id = r.body.data.id;

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${id}/reject`)
        .set('Authorization', adminAuth)
        .send({ verifyNote: '颁发机构未授权' });
      expect(res.status).toBe(200);
      expect(res.body.data.certStatusCode).toBe('rejected');
      expect(res.body.data.verifyNote).toBe('颁发机构未授权');
      expect(res.body.data.verifiedAt).not.toBeNull();
    });

    it('reject 缺 verifyNote → 400', async () => {
      const r = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ certNumber: 'REJ-002' }));
      const id = r.body.data.id;

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${id}/reject`)
        .set('Authorization', adminAuth)
        .send({});
      expect(res.status).toBe(400);
    });

    it('reject 已 rejected → CERTIFICATE_INVALID_STATE_TRANSITION', async () => {
      const r = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ certNumber: 'REJ-003' }));
      const id = r.body.data.id;
      await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${id}/reject`)
        .set('Authorization', adminAuth)
        .send({ verifyNote: '第一次拒绝' });
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${id}/reject`)
        .set('Authorization', adminAuth)
        .send({ verifyNote: '第二次拒绝' });
      expectBizError(res, BizCode.CERTIFICATE_INVALID_STATE_TRANSITION);
    });

    it('reject 已 verified → CERTIFICATE_INVALID_STATE_TRANSITION', async () => {
      const r = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ certNumber: 'REJ-004' }));
      const id = r.body.data.id;
      await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${id}/verify`)
        .set('Authorization', adminAuth)
        .send({});
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${id}/reject`)
        .set('Authorization', adminAuth)
        .send({ verifyNote: '反悔拒绝' });
      expectBizError(res, BizCode.CERTIFICATE_INVALID_STATE_TRANSITION);
    });
  });

  // ============ 拒绝后重新提交 = 新建记录 ============

  describe('拒绝后重新提交', () => {
    it('reject C1 → softDelete C1 → POST 新 cert C2 → 201;新记录是 pending', async () => {
      // C1 创建 + 拒绝 + 软删
      const r1 = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(
          baseCreatePayload({ certNumber: 'RESUB-C1', certTypeCode: secondActiveCertTypeCode }),
        );
      const c1Id = r1.body.data.id;
      await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${c1Id}/reject`)
        .set('Authorization', adminAuth)
        .send({ verifyNote: '材料缺失' });
      await request(httpServer(app))
        .delete(`/api/admin/v1/members/${memberA}/certificates/${c1Id}`)
        .set('Authorization', adminAuth);

      // C2 重新提交(新记录,pending)
      const r2 = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(
          baseCreatePayload({ certNumber: 'RESUB-C2', certTypeCode: secondActiveCertTypeCode }),
        );
      expect(r2.status).toBe(201);
      expect(r2.body.data.id).not.toBe(c1Id);
      expect(r2.body.data.certStatusCode).toBe('pending');
      expect(r2.body.data.verifyNote).toBeNull();
    });
  });

  // ============ qualification-flag ============

  describe('GET /qualification-flag', () => {
    let qfMember: string; // 独立 member 避免污染前面的测试

    beforeAll(async () => {
      const m = await prisma.member.create({
        data: { memberNo: 'cert-m-qf', displayName: 'QF Member' },
        select: { id: true },
      });
      qfMember = m.id;
    });

    it('member 不存在 → MEMBER_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/members/cl0000000000000000000000/certificates/qualification-flag')
        .query({ certTypeCode: activeCertTypeCode })
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('certTypeCode query 缺失 → 400', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${qfMember}/certificates/qualification-flag`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(400);
    });

    it('certTypeCode 字典 invalid → CERTIFICATE_TYPE_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${qfMember}/certificates/qualification-flag`)
        .query({ certTypeCode: 'no-such-type' })
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.CERTIFICATE_TYPE_CODE_INVALID);
    });

    it('无证书 → qualified=false', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${qfMember}/certificates/qualification-flag`)
        .query({ certTypeCode: activeCertTypeCode })
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        memberId: qfMember,
        certTypeCode: activeCertTypeCode,
        qualified: false,
      });
    });

    it('verified + 无 expiry + 未软删 → qualified=true', async () => {
      const r = await request(httpServer(app))
        .post(`/api/admin/v1/members/${qfMember}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ certNumber: 'QF-VER' }));
      await request(httpServer(app))
        .patch(`/api/admin/v1/members/${qfMember}/certificates/${r.body.data.id}/verify`)
        .set('Authorization', adminAuth)
        .send({});

      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${qfMember}/certificates/qualification-flag`)
        .query({ certTypeCode: activeCertTypeCode })
        .set('Authorization', adminAuth);
      expect(res.body.data.qualified).toBe(true);
    });

    it('verified + 未来 expiry → qualified=true', async () => {
      // 创建独立 member 隔离
      const m = await prisma.member.create({
        data: { memberNo: 'cert-m-qf-fe', displayName: 'QF FE' },
        select: { id: true },
      });
      const r = await request(httpServer(app))
        .post(`/api/admin/v1/members/${m.id}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ expiredAt: '2099-01-01T00:00:00.000Z' }));
      await request(httpServer(app))
        .patch(`/api/admin/v1/members/${m.id}/certificates/${r.body.data.id}/verify`)
        .set('Authorization', adminAuth)
        .send({});

      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${m.id}/certificates/qualification-flag`)
        .query({ certTypeCode: activeCertTypeCode })
        .set('Authorization', adminAuth);
      expect(res.body.data.qualified).toBe(true);
    });

    it('verified + 已过期 → qualified=false', async () => {
      const m = await prisma.member.create({
        data: { memberNo: 'cert-m-qf-pe', displayName: 'QF PE' },
        select: { id: true },
      });
      // 直接在 DB 创建已过期 + verified 记录,绕过状态机限制
      await prisma.certificate.create({
        data: {
          memberId: m.id,
          certTypeCode: activeCertTypeCode,
          issuingOrg: 'Demo Past',
          issuedAt: new Date('2010-01-01T00:00:00.000Z'),
          expiredAt: new Date('2015-01-01T00:00:00.000Z'),
          certStatusCode: 'verified',
          isInternal: false,
        },
      });

      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${m.id}/certificates/qualification-flag`)
        .query({ certTypeCode: activeCertTypeCode })
        .set('Authorization', adminAuth);
      expect(res.body.data.qualified).toBe(false);
    });

    it('pending only → qualified=false', async () => {
      const m = await prisma.member.create({
        data: { memberNo: 'cert-m-qf-pd', displayName: 'QF PD' },
        select: { id: true },
      });
      await request(httpServer(app))
        .post(`/api/admin/v1/members/${m.id}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload());

      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${m.id}/certificates/qualification-flag`)
        .query({ certTypeCode: activeCertTypeCode })
        .set('Authorization', adminAuth);
      expect(res.body.data.qualified).toBe(false);
    });

    it('rejected only → qualified=false', async () => {
      const m = await prisma.member.create({
        data: { memberNo: 'cert-m-qf-rj', displayName: 'QF RJ' },
        select: { id: true },
      });
      const r = await request(httpServer(app))
        .post(`/api/admin/v1/members/${m.id}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload());
      await request(httpServer(app))
        .patch(`/api/admin/v1/members/${m.id}/certificates/${r.body.data.id}/reject`)
        .set('Authorization', adminAuth)
        .send({ verifyNote: '不通过' });

      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${m.id}/certificates/qualification-flag`)
        .query({ certTypeCode: activeCertTypeCode })
        .set('Authorization', adminAuth);
      expect(res.body.data.qualified).toBe(false);
    });

    it('verified 但已软删 → qualified=false', async () => {
      const m = await prisma.member.create({
        data: { memberNo: 'cert-m-qf-sd', displayName: 'QF SD' },
        select: { id: true },
      });
      const r = await request(httpServer(app))
        .post(`/api/admin/v1/members/${m.id}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload());
      await request(httpServer(app))
        .patch(`/api/admin/v1/members/${m.id}/certificates/${r.body.data.id}/verify`)
        .set('Authorization', adminAuth)
        .send({});
      await request(httpServer(app))
        .delete(`/api/admin/v1/members/${m.id}/certificates/${r.body.data.id}`)
        .set('Authorization', adminAuth);

      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${m.id}/certificates/qualification-flag`)
        .query({ certTypeCode: activeCertTypeCode })
        .set('Authorization', adminAuth);
      expect(res.body.data.qualified).toBe(false);
    });

    it('响应仅 3 字段(memberId / certTypeCode / qualified)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${qfMember}/certificates/qualification-flag`)
        .query({ certTypeCode: activeCertTypeCode })
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      const dataKeys = Object.keys(res.body.data as Record<string, unknown>).sort();
      expect(dataKeys).toEqual(['certTypeCode', 'memberId', 'qualified']);
    });
  });
});
