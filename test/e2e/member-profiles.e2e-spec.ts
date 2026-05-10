import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// V2 第一阶段批次 1 member_profiles 模块 e2e。
// 覆盖 3 接口主成功 + 关键失败:权限边界 / 1:1 unique / 字典 5 项校验 / 禁止白名单外字段。
//
// 注:reset-db 清空所有表(包括 dictionaries),每个 spec 必须自建字典(沿用 members.e2e-spec)。

describe('member-profiles 模块', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let adminAuth: string;
  let userAuth: string;

  let memberId: string;
  let memberWithoutProfileId: string;

  // 字典 codes
  let genderCode: string;
  let documentTypeCode: string;
  let politicalStatusCode: string;
  let bloodTypeCode: string;
  let workNatureCode: string;
  let inactiveGenderCode: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'mp-su', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'mp-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'mp-user', role: Role.USER });
    superAdminAuth = (await loginAs(app, 'mp-su')).authHeader;
    adminAuth = (await loginAs(app, 'mp-adm')).authHeader;
    userAuth = (await loginAs(app, 'mp-user')).authHeader;

    // 创建 5 个字典 type + 各 1 个 ACTIVE item。沿用批次 1 草案 §12.1 必开 6 个的命名,
    // 但本 spec 只需要 service 层用到的 5 个(emergency_relation 由 emergency-contacts.spec 自建)。
    const seedDict = async (typeCode: string, itemCode: string): Promise<string> => {
      const t = await prisma.dictType.create({
        data: { code: typeCode, label: `Demo ${typeCode}` },
        select: { id: true },
      });
      const i = await prisma.dictItem.create({
        data: { typeId: t.id, code: itemCode, label: `Demo ${itemCode}` },
        select: { code: true },
      });
      return i.code;
    };

    genderCode = await seedDict('gender', 'demo-gender-male');
    documentTypeCode = await seedDict('document_type', 'demo-doc-id');
    politicalStatusCode = await seedDict('political_status', 'demo-pol-mass');
    bloodTypeCode = await seedDict('blood_type', 'demo-blood-O');
    workNatureCode = await seedDict('work_nature', 'demo-work-fulltime');

    // 一个 INACTIVE gender item(用于"INACTIVE → 拒绝"用例)
    const genderType = await prisma.dictType.findUnique({
      where: { code: 'gender' },
      select: { id: true },
    });
    const inactiveItem = await prisma.dictItem.create({
      data: {
        typeId: genderType!.id,
        code: 'demo-gender-inactive',
        label: 'Inactive',
        status: 'INACTIVE',
      },
      select: { code: true },
    });
    inactiveGenderCode = inactiveItem.code;

    // 也加上 join_source(NOT NULL,但本 spec 不直接 assert,只在 create 时需要传一个有效字符串)。
    await seedDict('join_source', 'demo-join-recruit');

    // 创建 2 个 member:一个会创建 profile,一个不会
    const m1 = await prisma.member.create({
      data: { memberNo: 'mp-m-1', displayName: 'Demo Member 1' },
      select: { id: true },
    });
    memberId = m1.id;
    const m2 = await prisma.member.create({
      data: { memberNo: 'mp-m-2', displayName: 'Demo Member 2' },
      select: { id: true },
    });
    memberWithoutProfileId = m2.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // 最小创建 payload(NOT NULL 业务字段)。
  const minimalCreatePayload = (): Record<string, unknown> => ({
    realName: '演示张三',
    genderCode,
    birthDate: '1990-01-15T00:00:00.000Z',
    documentTypeCode,
    documentNumber: 'DEMO000000',
    mobile: '13800000001',
    email: 'demo@example.com',
    joinedDate: '2020-06-01T00:00:00.000Z',
    joinSourceCode: 'demo-join-recruit',
    privacyConsentSigned: true,
  });

  // ============ 权限边界 ============

  describe('权限边界', () => {
    it('未登录 GET → 401', async () => {
      const res = await request(httpServer(app)).get(`/api/v2/members/${memberId}/profile`);
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER GET → 403', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/members/${memberId}/profile`)
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER POST → 403', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${memberId}/profile`)
        .set('Authorization', userAuth)
        .send(minimalCreatePayload());
      expectBizError(res, BizCode.FORBIDDEN);
    });

    it('USER PATCH → 403', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/members/${memberId}/profile`)
        .set('Authorization', userAuth)
        .send({ realName: '新名字' });
      expectBizError(res, BizCode.FORBIDDEN);
    });
  });

  // ============ POST + GET 主路径 ============

  describe('POST + GET 主路径', () => {
    it('member 不存在 → MEMBER_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .post('/api/v2/members/cl0000000000000000000000/profile')
        .set('Authorization', adminAuth)
        .send(minimalCreatePayload());
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('ADMIN 创建(最小 NOT NULL 字段) → 201,响应不含 deletedAt', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${memberId}/profile`)
        .set('Authorization', adminAuth)
        .send(minimalCreatePayload());
      expect(res.status).toBe(201);
      expect(res.body.code).toBe(0);
      expect(res.body.data.memberId).toBe(memberId);
      expect(res.body.data.realName).toBe('演示张三');
      expect(res.body.data.privacyConsentSigned).toBe(true);
      expect(res.body.data).not.toHaveProperty('deletedAt');
      // 日期字段规范化为 UTC 00:00:00
      expect(res.body.data.birthDate).toMatch(/^1990-01-15T00:00:00\.000Z$/);
      expect(res.body.data.joinedDate).toMatch(/^2020-06-01T00:00:00\.000Z$/);
    });

    it('GET 已存在 profile → 200 + 完整字段(含 medicalNotes 默认 null + exerciseMethods 空数组)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/members/${memberId}/profile`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.memberId).toBe(memberId);
      expect(res.body.data.medicalNotes).toBeNull();
      expect(Array.isArray(res.body.data.exerciseMethods)).toBe(true);
      expect(res.body.data.exerciseMethods.length).toBe(0);
      expect(res.body.data.firstAidSkills.length).toBe(0);
      expect(res.body.data).not.toHaveProperty('deletedAt');
    });

    it('GET member 存在但未创建 profile → 200 + data: null', async () => {
      const res = await request(httpServer(app))
        .get(`/api/v2/members/${memberWithoutProfileId}/profile`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data).toBeNull();
    });

    it('GET member 不存在 → MEMBER_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/v2/members/cl0000000000000000000000/profile')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('POST 重复创建 → MEMBER_PROFILE_ALREADY_EXISTS', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${memberId}/profile`)
        .set('Authorization', adminAuth)
        .send(minimalCreatePayload());
      expectBizError(res, BizCode.MEMBER_PROFILE_ALREADY_EXISTS);
    });

    it('POST 含 medicalNotes JSON + exerciseMethods 数组 → 201 + 字段往返', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${memberWithoutProfileId}/profile`)
        .set('Authorization', adminAuth)
        .send({
          ...minimalCreatePayload(),
          medicalNotes: [
            { categoryCode: 'demo-medical-cat-1', note: '过敏史' },
            { categoryCode: 'demo-medical-cat-2' },
          ],
          exerciseMethods: ['demo-exer-run', 'demo-exer-swim'],
          firstAidSkills: ['demo-skill-cpr'],
        });
      expect(res.status).toBe(201);
      expect(res.body.data.medicalNotes).toHaveLength(2);
      expect(res.body.data.medicalNotes[0]).toEqual({
        categoryCode: 'demo-medical-cat-1',
        note: '过敏史',
      });
      expect(res.body.data.exerciseMethods).toEqual(['demo-exer-run', 'demo-exer-swim']);
      expect(res.body.data.firstAidSkills).toEqual(['demo-skill-cpr']);
    });
  });

  // ============ POST 校验 ============

  describe('POST DTO 校验', () => {
    let m3Id: string;

    beforeAll(async () => {
      const m = await prisma.member.create({
        data: { memberNo: 'mp-m-3', displayName: 'Demo 3' },
        select: { id: true },
      });
      m3Id = m.id;
    });

    it('缺 realName → 400', async () => {
      const payload = minimalCreatePayload();
      delete payload.realName;
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${m3Id}/profile`)
        .set('Authorization', adminAuth)
        .send(payload);
      expect(res.status).toBe(400);
    });

    it('non-whitelisted 字段(deletedAt) → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${m3Id}/profile`)
        .set('Authorization', adminAuth)
        .send({ ...minimalCreatePayload(), deletedAt: new Date().toISOString() });
      expect(res.status).toBe(400);
    });

    it('non-whitelisted 字段(memberId) → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${m3Id}/profile`)
        .set('Authorization', adminAuth)
        .send({ ...minimalCreatePayload(), memberId: 'cl0000000000000000000000' });
      expect(res.status).toBe(400);
    });

    it('genderCode 字典不存在 → MEMBER_PROFILE_GENDER_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${m3Id}/profile`)
        .set('Authorization', adminAuth)
        .send({ ...minimalCreatePayload(), genderCode: 'no-such-gender' });
      expectBizError(res, BizCode.MEMBER_PROFILE_GENDER_CODE_INVALID);
    });

    it('genderCode INACTIVE → MEMBER_PROFILE_GENDER_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${m3Id}/profile`)
        .set('Authorization', adminAuth)
        .send({ ...minimalCreatePayload(), genderCode: inactiveGenderCode });
      expectBizError(res, BizCode.MEMBER_PROFILE_GENDER_CODE_INVALID);
    });

    it('documentTypeCode 字典不存在 → MEMBER_PROFILE_DOCUMENT_TYPE_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${m3Id}/profile`)
        .set('Authorization', adminAuth)
        .send({ ...minimalCreatePayload(), documentTypeCode: 'no-such-doc' });
      expectBizError(res, BizCode.MEMBER_PROFILE_DOCUMENT_TYPE_CODE_INVALID);
    });

    it('email 格式非法 → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${m3Id}/profile`)
        .set('Authorization', adminAuth)
        .send({ ...minimalCreatePayload(), email: 'not-an-email' });
      expect(res.status).toBe(400);
    });

    it('mobile 格式非法 → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${m3Id}/profile`)
        .set('Authorization', adminAuth)
        .send({ ...minimalCreatePayload(), mobile: 'abc不是手机号' });
      expect(res.status).toBe(400);
    });

    it('birthDate 非 ISO 8601 → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/v2/members/${m3Id}/profile`)
        .set('Authorization', adminAuth)
        .send({ ...minimalCreatePayload(), birthDate: '1990/01/15' });
      expect(res.status).toBe(400);
    });
  });

  // ============ PATCH ============

  describe('PATCH', () => {
    let mPatchId: string;
    let mPatchNoProfileId: string;

    beforeAll(async () => {
      const a = await prisma.member.create({
        data: { memberNo: 'mp-m-patch', displayName: 'Patch Target' },
        select: { id: true },
      });
      mPatchId = a.id;
      // 先创一个 profile 用于 PATCH
      await request(httpServer(app))
        .post(`/api/v2/members/${mPatchId}/profile`)
        .set('Authorization', adminAuth)
        .send(minimalCreatePayload());

      const b = await prisma.member.create({
        data: { memberNo: 'mp-m-patch-empty', displayName: 'Patch Empty' },
        select: { id: true },
      });
      mPatchNoProfileId = b.id;
    });

    it('部分字段更新 → 200', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/members/${mPatchId}/profile`)
        .set('Authorization', superAdminAuth)
        .send({ realName: '新名字', volunteerNo: 'V123' });
      expect(res.status).toBe(200);
      expect(res.body.data.realName).toBe('新名字');
      expect(res.body.data.volunteerNo).toBe('V123');
    });

    it('medicalNotes 整体替换 → 200', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/members/${mPatchId}/profile`)
        .set('Authorization', adminAuth)
        .send({
          medicalNotes: [{ categoryCode: 'demo-medical-cat-x' }],
        });
      expect(res.status).toBe(200);
      expect(res.body.data.medicalNotes).toEqual([{ categoryCode: 'demo-medical-cat-x' }]);
    });

    it('non-whitelisted 字段(id) → 400', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/members/${mPatchId}/profile`)
        .set('Authorization', adminAuth)
        .send({ id: 'cl0000000000000000000000' });
      expect(res.status).toBe(400);
    });

    it('non-whitelisted 字段(createdAt) → 400', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/members/${mPatchId}/profile`)
        .set('Authorization', adminAuth)
        .send({ createdAt: new Date().toISOString() });
      expect(res.status).toBe(400);
    });

    it('PATCH profile 不存在 → MEMBER_PROFILE_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/members/${mPatchNoProfileId}/profile`)
        .set('Authorization', adminAuth)
        .send({ realName: 'X' });
      expectBizError(res, BizCode.MEMBER_PROFILE_NOT_FOUND);
    });

    it('PATCH bloodTypeCode 字典 invalid → MEMBER_PROFILE_BLOOD_TYPE_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/members/${mPatchId}/profile`)
        .set('Authorization', adminAuth)
        .send({ bloodTypeCode: 'no-such-blood' });
      expectBizError(res, BizCode.MEMBER_PROFILE_BLOOD_TYPE_CODE_INVALID);
    });

    it('PATCH workNatureCode 有效 → 200', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/members/${mPatchId}/profile`)
        .set('Authorization', adminAuth)
        .send({ workNatureCode });
      expect(res.status).toBe(200);
      expect(res.body.data.workNatureCode).toBe(workNatureCode);
    });

    it('PATCH politicalStatusCode 有效 + bloodTypeCode 有效 → 200', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/v2/members/${mPatchId}/profile`)
        .set('Authorization', adminAuth)
        .send({ politicalStatusCode, bloodTypeCode });
      expect(res.status).toBe(200);
      expect(res.body.data.politicalStatusCode).toBe(politicalStatusCode);
      expect(res.body.data.bloodTypeCode).toBe(bloodTypeCode);
    });

    it('PATCH member 不存在 → MEMBER_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .patch('/api/v2/members/cl0000000000000000000000/profile')
        .set('Authorization', adminAuth)
        .send({ realName: 'X' });
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });
  });
});
