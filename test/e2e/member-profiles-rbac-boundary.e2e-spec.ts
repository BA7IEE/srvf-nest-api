import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
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

// Slow-4 T2(2026-06-11):member-profiles 模块 RBAC 权限边界 spec。
// 沿冻结评审稿 slow4-rbac-business-face-review.md §7 零行为漂移验收
// (① SA 短路 / ② ADMIN+biz-admin 照常 / ③ ADMIN 无 biz-admin 30100 / ④ USER 30100)。
// 业务行为细节由 member-profiles.e2e-spec.ts 锁定,本 spec 只锁判权矩阵。

describe('member-profiles RBAC 权限边界(Slow-4 T2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let saAuth: string;
  let admBizAuth: string;
  let admDefaultAuth: string;
  let userAuth: string;

  let memberA: string; // ② 创建 profile 用
  let memberB: string; // ① SA 创建 profile 用
  let genderCode: string;
  let documentTypeCode: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'mprb-su', role: Role.SUPER_ADMIN });
    const admBiz = await createTestUser(app, { username: 'mprb-adm-biz', role: Role.ADMIN });
    await createTestUser(app, { username: 'mprb-adm-default', role: Role.ADMIN });
    await createTestUser(app, { username: 'mprb-user', role: Role.USER });
    saAuth = (await loginAs(app, 'mprb-su')).authHeader;
    admBizAuth = (await loginAs(app, 'mprb-adm-biz')).authHeader;
    admDefaultAuth = (await loginAs(app, 'mprb-adm-default')).authHeader;
    userAuth = (await loginAs(app, 'mprb-user')).authHeader;

    const bizSeed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, admBiz.id, bizSeed.bizAdminRoleId);

    // create 必填字段中 genderCode / documentTypeCode 走字典校验(service 层)
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
    genderCode = await seedDict('gender', 'mprb-gender-male');
    documentTypeCode = await seedDict('document_type', 'mprb-doc-id');

    const a = await prisma.member.create({
      data: { memberNo: 'mprb-m-a', displayName: 'A' },
      select: { id: true },
    });
    memberA = a.id;
    const b = await prisma.member.create({
      data: { memberNo: 'mprb-m-b', displayName: 'B' },
      select: { id: true },
    });
    memberB = b.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const createPayload = (): Record<string, unknown> => ({
    realName: '边界张三',
    genderCode,
    birthDate: '1990-01-15T00:00:00.000Z',
    documentTypeCode,
    documentNumber: 'MPRB000000',
    mobile: '13800000009',
    email: 'mprb@example.com',
    joinedDate: '2020-06-01T00:00:00.000Z',
    joinSourceCode: 'mprb-join-demo',
    privacyConsentSigned: true,
  });

  describe('GET /profile(member-profile.read.record)', () => {
    it('①② 通过(无 profile 返 data null)/ ③④ 30100', async () => {
      const ok1 = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberA}/profile`)
        .set('Authorization', saAuth);
      expect(ok1.status).toBe(200);
      const ok2 = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberA}/profile`)
        .set('Authorization', admBizAuth);
      expect(ok2.status).toBe(200);
      const deny1 = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberA}/profile`)
        .set('Authorization', admDefaultAuth);
      expectBizError(deny1, BizCode.RBAC_FORBIDDEN);
      const deny2 = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberA}/profile`)
        .set('Authorization', userAuth);
      expectBizError(deny2, BizCode.RBAC_FORBIDDEN);
    });
  });

  describe('POST /profile(member-profile.create.record)', () => {
    it('③ ADMIN 无 biz-admin → 30100(合法 body)/ ④ USER → 30100', async () => {
      const deny1 = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/profile`)
        .set('Authorization', admDefaultAuth)
        .send(createPayload());
      expectBizError(deny1, BizCode.RBAC_FORBIDDEN);
      const deny2 = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/profile`)
        .set('Authorization', userAuth)
        .send(createPayload());
      expectBizError(deny2, BizCode.RBAC_FORBIDDEN);
    });
    it('② ADMIN+biz-admin → 201 / ① SA → 201', async () => {
      const ok2 = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/profile`)
        .set('Authorization', admBizAuth)
        .send(createPayload());
      expect(ok2.status).toBe(201);
      const ok1 = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberB}/profile`)
        .set('Authorization', saAuth)
        .send(createPayload());
      expect(ok1.status).toBe(201);
    });
  });

  describe('PATCH /profile(member-profile.update.record)', () => {
    it('①② 通过 / ③④ 30100', async () => {
      const ok1 = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/profile`)
        .set('Authorization', saAuth)
        .send({ realName: '边界李四' });
      expect(ok1.status).toBe(200);
      const ok2 = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/profile`)
        .set('Authorization', admBizAuth)
        .send({ realName: '边界王五' });
      expect(ok2.status).toBe(200);
      const deny1 = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/profile`)
        .set('Authorization', admDefaultAuth)
        .send({ realName: 'X' });
      expectBizError(deny1, BizCode.RBAC_FORBIDDEN);
      const deny2 = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/profile`)
        .set('Authorization', userAuth)
        .send({ realName: 'X' });
      expectBizError(deny2, BizCode.RBAC_FORBIDDEN);
    });
  });
});
