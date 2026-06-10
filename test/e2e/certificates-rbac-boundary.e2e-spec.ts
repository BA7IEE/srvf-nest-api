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

// Slow-4 T2(2026-06-11):certificates 模块 RBAC 权限边界 spec。
// 沿冻结评审稿 slow4-rbac-business-face-review.md §7 零行为漂移验收
// (① SA 短路 / ② ADMIN+biz-admin 照常 / ③ ADMIN 无 biz-admin 30100 / ④ USER 30100)。
// list / detail / qualification-flag 共用 certificate.read.record(D4=A 判例);
// verify / reject 独立码。业务行为细节由 certificates.e2e-spec.ts 锁定,本 spec 只锁判权矩阵。

describe('certificates RBAC 权限边界(Slow-4 T2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let saAuth: string;
  let admBizAuth: string;
  let admDefaultAuth: string;
  let userAuth: string;

  let memberA: string;
  let certTypeCode: string;
  let certId: string; // 预创建 pending 证书(read/update 用)

  const createPendingCert = async (): Promise<string> => {
    const c = await prisma.certificate.create({
      data: {
        memberId: memberA,
        certTypeCode,
        issuingOrg: '边界机构',
        issuedAt: new Date('2024-01-01T00:00:00.000Z'),
        certStatusCode: 'pending',
        isInternal: false,
      },
      select: { id: true },
    });
    return c.id;
  };

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'crtb-su', role: Role.SUPER_ADMIN });
    const admBiz = await createTestUser(app, { username: 'crtb-adm-biz', role: Role.ADMIN });
    await createTestUser(app, { username: 'crtb-adm-default', role: Role.ADMIN });
    await createTestUser(app, { username: 'crtb-user', role: Role.USER });
    saAuth = (await loginAs(app, 'crtb-su')).authHeader;
    admBizAuth = (await loginAs(app, 'crtb-adm-biz')).authHeader;
    admDefaultAuth = (await loginAs(app, 'crtb-adm-default')).authHeader;
    userAuth = (await loginAs(app, 'crtb-user')).authHeader;

    const bizSeed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, admBiz.id, bizSeed.bizAdminRoleId);

    const certTypeDict = await prisma.dictType.create({
      data: { code: 'cert_type', label: '证书大类' },
      select: { id: true },
    });
    const ct = await prisma.dictItem.create({
      data: { typeId: certTypeDict.id, code: 'crtb-first-aid', label: '救护员' },
      select: { code: true },
    });
    certTypeCode = ct.code;

    const a = await prisma.member.create({
      data: { memberNo: 'crtb-m-a', displayName: 'A' },
      select: { id: true },
    });
    memberA = a.id;
    certId = await createPendingCert();
  });

  afterAll(async () => {
    await app.close();
  });

  const base = (): string => `/api/admin/v1/members/${memberA}/certificates`;
  const createPayload = (): Record<string, unknown> => ({
    certTypeCode,
    issuingOrg: '边界机构',
    issuedAt: '2024-01-01T00:00:00.000Z',
  });

  describe('read 族:list / detail / qualification-flag(certificate.read.record 共用)', () => {
    it('list:①② 通过 / ③④ 30100', async () => {
      expect((await request(httpServer(app)).get(base()).set('Authorization', saAuth)).status).toBe(
        200,
      );
      expect(
        (await request(httpServer(app)).get(base()).set('Authorization', admBizAuth)).status,
      ).toBe(200);
      expectBizError(
        await request(httpServer(app)).get(base()).set('Authorization', admDefaultAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app)).get(base()).set('Authorization', userAuth),
        BizCode.RBAC_FORBIDDEN,
      );
    });
    it('detail:①② 通过 / ③④ 30100', async () => {
      const url = `${base()}/${certId}`;
      expect((await request(httpServer(app)).get(url).set('Authorization', saAuth)).status).toBe(
        200,
      );
      expect(
        (await request(httpServer(app)).get(url).set('Authorization', admBizAuth)).status,
      ).toBe(200);
      expectBizError(
        await request(httpServer(app)).get(url).set('Authorization', admDefaultAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app)).get(url).set('Authorization', userAuth),
        BizCode.RBAC_FORBIDDEN,
      );
    });
    it('qualification-flag:①② 通过 / ③④ 30100', async () => {
      const url = `${base()}/qualification-flag`;
      expect(
        (
          await request(httpServer(app))
            .get(url)
            .query({ certTypeCode })
            .set('Authorization', saAuth)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(httpServer(app))
            .get(url)
            .query({ certTypeCode })
            .set('Authorization', admBizAuth)
        ).status,
      ).toBe(200);
      expectBizError(
        await request(httpServer(app))
          .get(url)
          .query({ certTypeCode })
          .set('Authorization', admDefaultAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .get(url)
          .query({ certTypeCode })
          .set('Authorization', userAuth),
        BizCode.RBAC_FORBIDDEN,
      );
    });
  });

  describe('POST(certificate.create.record)', () => {
    it('①② 通过 / ③④ 30100(合法 body)', async () => {
      expect(
        (
          await request(httpServer(app))
            .post(base())
            .set('Authorization', saAuth)
            .send(createPayload())
        ).status,
      ).toBe(201);
      expect(
        (
          await request(httpServer(app))
            .post(base())
            .set('Authorization', admBizAuth)
            .send(createPayload())
        ).status,
      ).toBe(201);
      expectBizError(
        await request(httpServer(app))
          .post(base())
          .set('Authorization', admDefaultAuth)
          .send(createPayload()),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .post(base())
          .set('Authorization', userAuth)
          .send(createPayload()),
        BizCode.RBAC_FORBIDDEN,
      );
    });
  });

  describe('PATCH /:id(certificate.update.record)', () => {
    it('①② 通过 / ③④ 30100', async () => {
      const url = `${base()}/${certId}`;
      expect(
        (
          await request(httpServer(app))
            .patch(url)
            .set('Authorization', saAuth)
            .send({ issuingOrg: 'SA 修订' })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(httpServer(app))
            .patch(url)
            .set('Authorization', admBizAuth)
            .send({ issuingOrg: 'Biz 修订' })
        ).status,
      ).toBe(200);
      expectBizError(
        await request(httpServer(app))
          .patch(url)
          .set('Authorization', admDefaultAuth)
          .send({ issuingOrg: 'X' }),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(url)
          .set('Authorization', userAuth)
          .send({ issuingOrg: 'X' }),
        BizCode.RBAC_FORBIDDEN,
      );
    });
  });

  describe('verify / reject(certificate.verify.record / certificate.reject.record)', () => {
    it('verify:③④ 30100 / ② 通过 / ① 通过(各用独立 pending 证书)', async () => {
      const target = await createPendingCert();
      expectBizError(
        await request(httpServer(app))
          .patch(`${base()}/${target}/verify`)
          .set('Authorization', admDefaultAuth)
          .send({}),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`${base()}/${target}/verify`)
          .set('Authorization', userAuth)
          .send({}),
        BizCode.RBAC_FORBIDDEN,
      );
      expect(
        (
          await request(httpServer(app))
            .patch(`${base()}/${target}/verify`)
            .set('Authorization', admBizAuth)
            .send({})
        ).status,
      ).toBe(200);
      const target2 = await createPendingCert();
      expect(
        (
          await request(httpServer(app))
            .patch(`${base()}/${target2}/verify`)
            .set('Authorization', saAuth)
            .send({})
        ).status,
      ).toBe(200);
    });
    it('reject:③④ 30100 / ② 通过 / ① 通过(各用独立 pending 证书)', async () => {
      const target = await createPendingCert();
      expectBizError(
        await request(httpServer(app))
          .patch(`${base()}/${target}/reject`)
          .set('Authorization', admDefaultAuth)
          .send({ verifyNote: 'X' }),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`${base()}/${target}/reject`)
          .set('Authorization', userAuth)
          .send({ verifyNote: 'X' }),
        BizCode.RBAC_FORBIDDEN,
      );
      expect(
        (
          await request(httpServer(app))
            .patch(`${base()}/${target}/reject`)
            .set('Authorization', admBizAuth)
            .send({ verifyNote: '边界驳回' })
        ).status,
      ).toBe(200);
      const target2 = await createPendingCert();
      expect(
        (
          await request(httpServer(app))
            .patch(`${base()}/${target2}/reject`)
            .set('Authorization', saAuth)
            .send({ verifyNote: '边界驳回 SA' })
        ).status,
      ).toBe(200);
    });
  });

  describe('DELETE /:id(certificate.delete.record)', () => {
    it('③④ 30100(判权先于资源探测)/ ② 通过 / ① 通过', async () => {
      const fakeUrl = `${base()}/cl000000000000000000xxxx`;
      expectBizError(
        await request(httpServer(app)).delete(fakeUrl).set('Authorization', admDefaultAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app)).delete(fakeUrl).set('Authorization', userAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      const t1 = await createPendingCert();
      expect(
        (await request(httpServer(app)).delete(`${base()}/${t1}`).set('Authorization', admBizAuth))
          .status,
      ).toBe(200);
      const t2 = await createPendingCert();
      expect(
        (await request(httpServer(app)).delete(`${base()}/${t2}`).set('Authorization', saAuth))
          .status,
      ).toBe(200);
    });
  });
});
