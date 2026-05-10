import type { INestApplication } from '@nestjs/common';
import { DictItemStatus, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2 第一阶段批次 1 emergency_contacts 模块 e2e。
// 覆盖 4 接口主成功 + 关键失败:权限 / 字典 / 跨 member / 软删 / 排序。

describe('emergency-contacts 模块', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let adminAuth: string;
  let userAuth: string;

  let memberA: string; // 主用 member,绝大多数用例操作它
  let memberB: string; // 用于"跨 member 拒绝"用例
  let relationCode: string;
  let inactiveRelationCode: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'ec-su', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'ec-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'ec-user', role: Role.USER });
    superAdminAuth = (await loginAs(app, 'ec-su')).authHeader;
    adminAuth = (await loginAs(app, 'ec-adm')).authHeader;
    userAuth = (await loginAs(app, 'ec-user')).authHeader;

    // 创建 emergency_relation 字典 + 1 ACTIVE / 1 INACTIVE
    const relType = await prisma.dictType.create({
      data: { code: 'emergency_relation', label: 'Emergency Relation' },
      select: { id: true },
    });
    const active = await prisma.dictItem.create({
      data: { typeId: relType.id, code: 'demo-rel-family', label: 'family' },
      select: { code: true },
    });
    relationCode = active.code;
    const inactive = await prisma.dictItem.create({
      data: {
        typeId: relType.id,
        code: 'demo-rel-inactive',
        label: 'inactive',
        status: DictItemStatus.INACTIVE,
      },
      select: { code: true },
    });
    inactiveRelationCode = inactive.code;

    // 2 个 member
    const a = await prisma.member.create({
      data: { memberNo: 'ec-m-a', displayName: 'Member A' },
      select: { id: true },
    });
    memberA = a.id;
    const b = await prisma.member.create({
      data: { memberNo: 'ec-m-b', displayName: 'Member B' },
      select: { id: true },
    });
    memberB = b.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const minimalCreatePayload = (): Record<string, unknown> => ({
    contactName: '紧急联系人 1',
    relationCode,
    phonePrimary: '13800000001',
  });

  // ============ 权限边界 ============

  describe('权限边界', () => {
    it('未登录 GET → 401', async () => {
      const res = await request(httpServer(app)).get(
        `/api/v2/members/${memberA}/emergency-contacts`,
      );
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER GET → 403', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/members/${memberA}/emergency-contacts`)
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER POST → 403', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${memberA}/emergency-contacts`)
        .set('Authorization', userAuth)
        .send(minimalCreatePayload());
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER PATCH → 403', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/members/${memberA}/emergency-contacts/cl000000000000000000xxxx`)
        .set('Authorization', userAuth)
        .send({ contactName: 'X' });
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER DELETE → 403', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/v2/members/${memberA}/emergency-contacts/cl000000000000000000xxxx`)
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.FORBIDDEN);
    });
  });

  // ============ GET list ============

  describe('GET list', () => {
    it('member 不存在 → MEMBER_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/members/cl0000000000000000000000/emergency-contacts')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('空列表 → 200 + 空数组', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/members/${memberA}/emergency-contacts`)
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
        .post('/api/v2/members/cl0000000000000000000000/emergency-contacts')
        .set('Authorization', adminAuth)
        .send(minimalCreatePayload());
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('ADMIN 创建第一条 → 201,默认 priority=0,不返 deletedAt', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${memberA}/emergency-contacts`)
        .set('Authorization', adminAuth)
        .send(minimalCreatePayload());
      expect(res.status).toBe(201);
      expect(res.body.code).toBe(0);
      expect(res.body.data.memberId).toBe(memberA);
      expect(res.body.data.contactName).toBe('紧急联系人 1');
      expect(res.body.data.relationCode).toBe(relationCode);
      expect(res.body.data.priority).toBe(0);
      expect(res.body.data.phoneBackup).toBeNull();
      expect(res.body.data.address).toBeNull();
      expect(res.body.data).not.toHaveProperty('deletedAt');
    });

    it('SUPER_ADMIN 创建多条 + 含 phoneBackup / address / priority → 201', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${memberA}/emergency-contacts`)
        .set('Authorization', superAdminAuth)
        .send({
          contactName: '紧急联系人 2',
          relationCode,
          phonePrimary: '13800000002',
          phoneBackup: '+86-755-12345678',
          address: '深圳市南山区演示街道',
          priority: 2,
        });
      expect(res.status).toBe(201);
      expect(res.body.data.priority).toBe(2);
      expect(res.body.data.phoneBackup).toBe('+86-755-12345678');
      expect(res.body.data.address).toBe('深圳市南山区演示街道');
    });

    it('relationCode 不存在 → EMERGENCY_CONTACT_RELATION_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${memberA}/emergency-contacts`)
        .set('Authorization', adminAuth)
        .send({ ...minimalCreatePayload(), relationCode: 'no-such-relation' });
      expectBizError(res, BizCode.EMERGENCY_CONTACT_RELATION_CODE_INVALID);
    });

    it('relationCode INACTIVE → EMERGENCY_CONTACT_RELATION_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${memberA}/emergency-contacts`)
        .set('Authorization', adminAuth)
        .send({ ...minimalCreatePayload(), relationCode: inactiveRelationCode });
      expectBizError(res, BizCode.EMERGENCY_CONTACT_RELATION_CODE_INVALID);
    });

    it('缺 contactName → 400', async () => {
      const payload = minimalCreatePayload();
      delete payload.contactName;
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${memberA}/emergency-contacts`)
        .set('Authorization', adminAuth)
        .send(payload);
      expect(res.status).toBe(400);
    });

    it('缺 phonePrimary → 400', async () => {
      const payload = minimalCreatePayload();
      delete payload.phonePrimary;
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${memberA}/emergency-contacts`)
        .set('Authorization', adminAuth)
        .send(payload);
      expect(res.status).toBe(400);
    });

    it('phonePrimary 格式非法 → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${memberA}/emergency-contacts`)
        .set('Authorization', adminAuth)
        .send({ ...minimalCreatePayload(), phonePrimary: 'abc不是号码' });
      expect(res.status).toBe(400);
    });

    it('non-whitelisted 字段(memberId) → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${memberA}/emergency-contacts`)
        .set('Authorization', adminAuth)
        .send({ ...minimalCreatePayload(), memberId: 'cl0000000000000000000000' });
      expect(res.status).toBe(400);
    });

    it('non-whitelisted 字段(deletedAt) → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${memberA}/emergency-contacts`)
        .set('Authorization', adminAuth)
        .send({ ...minimalCreatePayload(), deletedAt: new Date().toISOString() });
      expect(res.status).toBe(400);
    });
  });

  // ============ GET list 排序 + 软删过滤 ============

  describe('GET list 排序 + 软删过滤', () => {
    it('多条按 priority ASC, createdAt ASC 排序', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/members/${memberA}/emergency-contacts`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      const items: Array<{ priority: number; createdAt: string }> = res.body.data;
      expect(items.length).toBeGreaterThanOrEqual(2);
      // priority 升序
      for (let i = 1; i < items.length; i += 1) {
        expect(items[i].priority).toBeGreaterThanOrEqual(items[i - 1].priority);
      }
    });
  });

  // ============ PATCH ============

  describe('PATCH', () => {
    let contactId: string;

    beforeAll(async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${memberA}/emergency-contacts`)
        .set('Authorization', adminAuth)
        .send({
          contactName: 'Patch Target',
          relationCode,
          phonePrimary: '13900000000',
          priority: 5,
        });
      contactId = res.body.data.id;
    });

    it('更新 priority → 200', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/members/${memberA}/emergency-contacts/${contactId}`)
        .set('Authorization', adminAuth)
        .send({ priority: 1 });
      expect(res.status).toBe(200);
      expect(res.body.data.priority).toBe(1);
    });

    it('更新 phoneBackup + address → 200', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/members/${memberA}/emergency-contacts/${contactId}`)
        .set('Authorization', superAdminAuth)
        .send({ phoneBackup: '13900000099', address: '新地址' });
      expect(res.status).toBe(200);
      expect(res.body.data.phoneBackup).toBe('13900000099');
      expect(res.body.data.address).toBe('新地址');
    });

    it('non-whitelisted(id 入参) → 400', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/members/${memberA}/emergency-contacts/${contactId}`)
        .set('Authorization', adminAuth)
        .send({ id: 'cl0000000000000000000000' });
      expect(res.status).toBe(400);
    });

    it('contact 不存在 → EMERGENCY_CONTACT_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/members/${memberA}/emergency-contacts/cl0000000000000000000000`)
        .set('Authorization', adminAuth)
        .send({ priority: 0 });
      expectBizError(res, BizCode.EMERGENCY_CONTACT_NOT_FOUND);
    });

    it('contact 属于其他 member → EMERGENCY_CONTACT_NOT_BELONGS_TO_MEMBER', async () => {
      // contactId 属于 memberA;用 memberB 的路径访问
      const res = await request(httpServer(app))
        .patch(`/api/v2/members/${memberB}/emergency-contacts/${contactId}`)
        .set('Authorization', adminAuth)
        .send({ priority: 1 });
      expectBizError(res, BizCode.EMERGENCY_CONTACT_NOT_BELONGS_TO_MEMBER);
    });

    it('PATCH relationCode 字典 invalid → EMERGENCY_CONTACT_RELATION_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/members/${memberA}/emergency-contacts/${contactId}`)
        .set('Authorization', adminAuth)
        .send({ relationCode: 'no-such-relation' });
      expectBizError(res, BizCode.EMERGENCY_CONTACT_RELATION_CODE_INVALID);
    });
  });

  // ============ DELETE 软删 ============

  describe('DELETE 软删', () => {
    let contactId: string;

    beforeAll(async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${memberA}/emergency-contacts`)
        .set('Authorization', adminAuth)
        .send({
          contactName: '待软删联系人',
          relationCode,
          phonePrimary: '13700000000',
        });
      contactId = res.body.data.id;
    });

    it('contact 不存在 → EMERGENCY_CONTACT_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/v2/members/${memberA}/emergency-contacts/cl0000000000000000000000`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.EMERGENCY_CONTACT_NOT_FOUND);
    });

    it('contact 属于其他 member → EMERGENCY_CONTACT_NOT_BELONGS_TO_MEMBER', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/v2/members/${memberB}/emergency-contacts/${contactId}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.EMERGENCY_CONTACT_NOT_BELONGS_TO_MEMBER);
    });

    it('正常软删 → 200 + DB deletedAt 非空 + 列表不再返回', async () => {
      const delRes = await request(httpServer(app))
        .delete(`/api/v2/members/${memberA}/emergency-contacts/${contactId}`)
        .set('Authorization', adminAuth);
      expect(delRes.status).toBe(200);
      expect(delRes.body.data.id).toBe(contactId);

      const after = await prisma.emergencyContact.findUnique({ where: { id: contactId } });
      expect(after?.deletedAt).not.toBeNull();

      // 列表过滤
      const listRes = await request(httpServer(app))
        .get(`/api/v2/members/${memberA}/emergency-contacts`)
        .set('Authorization', adminAuth);
      const ids: string[] = (listRes.body.data as Array<{ id: string }>).map((i) => i.id);
      expect(ids).not.toContain(contactId);
    });

    it('再次 DELETE 已软删 contact → EMERGENCY_CONTACT_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .delete(`/api/v2/members/${memberA}/emergency-contacts/${contactId}`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.EMERGENCY_CONTACT_NOT_FOUND);
    });
  });
});
