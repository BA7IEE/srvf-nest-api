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
  let standardId: string;
  let policyId: string;
  let certId: string; // 预创建 pending 证书(read/update 用)

  const createPendingCert = async (): Promise<string> => {
    const c = await prisma.certificate.create({
      data: {
        memberId: memberA,
        // 证书标准库 PR-4a-3 / PR-4b:直插夹具必须带上 standardId + recognitionPolicyId
        // + sourceCode(4b 起三列 NOT NULL);certTypeCode 已 DROP ——
        // PATCH 的「沿已锁定 policyId 校验」拿不到 policyId 会以 18035 拒改。
        // 这不是夹具将就实现:§20.1 探针已证实库内零存量证书,所以「没有 policyId 的行」
        // 在真实部署里不存在,4b 会把该列收紧为 NOT NULL。
        standardId,
        recognitionPolicyId: policyId,
        sourceCode: 'ADMIN',
        issuingOrg: '边界机构',
        issuedAt: new Date('2024-01-01T00:00:00.000Z'),
        certStatusCode: 'pending',
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

    // 证书标准库 PR-4a-3:建证入参改为 standardId。本 spec 锁判权边界,
    // 用最宽松的一条 ACTIVE Policy(FREE_TEXT / EXPLICIT_OPTIONAL / OPTIONAL)即可。
    const std = await prisma.certificateStandard.create({
      data: {
        code: 'crtb-std',
        name: '判权边界用标准',
        kind: 'CREDENTIAL',
        status: 'ACTIVE',
        categoryCode: certTypeCode,
      },
      select: { id: true },
    });
    const pol = await prisma.certificateRecognitionPolicy.create({
      data: {
        standardId: std.id,
        version: 1,
        status: 'ACTIVE',
        issuerPolicy: 'FREE_TEXT',
        validityMode: 'EXPLICIT_OPTIONAL',
        certNumberMode: 'OPTIONAL',
      },
      select: { id: true },
    });
    standardId = std.id;
    policyId = pol.id;

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
    standardId,
    issuingOrg: '边界机构',
    issuedAt: '2024-01-01', // 冻结稿 §10.2:纯 YYYY-MM-DD
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

  // ============ 证书标准库 PR-1 · 冻结稿 §15.3 敏感分级(真实判权链) ============
  //
  // 关键区分:`certificate.read.sensitive` **不是**入口码 —— 缺它不是 403,而是
  // 同一次 200 响应里编号降级为掩码、审核备注与审核人 id 变 null。
  //
  // 这里必须用一个**只持 read.record、不持 sensitive** 的真实角色来证,不能靠 mock:
  // biz-admin 与 SUPER_ADMIN 都能看明文,只用它们测就永远测不到掩码那一侧。
  describe('§15.3 敏感分级:read.record 能读,明文另需 read.sensitive', () => {
    let narrowAuth: string;
    let sensitiveCertId: string;

    beforeAll(async () => {
      // 窄角色:全局只绑 certificate.read.record 一条码。
      const readOnlyPerm = await prisma.permission.findFirstOrThrow({
        where: { code: 'certificate.read.record' },
        select: { id: true },
      });
      const narrowRole = await prisma.rbacRole.create({
        data: { code: 'crtb-cert-read-only', displayName: '仅证书只读(无敏感)' },
        select: { id: true },
      });
      await prisma.rolePermission.create({
        data: { roleId: narrowRole.id, permissionId: readOnlyPerm.id },
      });
      const narrowUser = await createTestUser(app, {
        username: 'crtb-narrow',
        role: Role.USER,
      });
      await prisma.roleBinding.create({
        data: {
          principalType: 'USER',
          principalId: narrowUser.id,
          roleId: narrowRole.id,
          scopeType: 'GLOBAL',
          status: 'ACTIVE',
          startedAt: new Date('2024-01-01T00:00:00.000Z'),
        },
      });
      narrowAuth = (await loginAs(app, 'crtb-narrow')).authHeader;

      // 一张带完整敏感事实的证书:长编号(掩码后仍可辨形)+ 审核备注 + 审核人。
      const c = await prisma.certificate.create({
        data: {
          memberId: memberA,
          // PR-4b:certTypeCode 已 DROP;三列 NOT NULL 由夹具给齐。
          standardId,
          recognitionPolicyId: policyId,
          sourceCode: 'ADMIN',
          issuingOrg: '边界机构',
          certNumber: 'SZ-2026-SENSITIVE-0001',
          issuedAt: new Date('2024-01-01T00:00:00.000Z'),
          certStatusCode: 'verified',
          verifiedBy: null,
          verifyNote: '原件已核,备注仅敏感可见',
        },
        select: { id: true },
      });
      sensitiveCertId = c.id;
    });

    it('只持 read.record:200 但编号只给掩码,备注/审核人恒 null', async () => {
      const res = await request(httpServer(app))
        .get(`${base()}/${sensitiveCertId}`)
        .set('Authorization', narrowAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.certNumberMasked).toBe('SZ****01');
      expect(res.body.data.certNumberFull).toBeNull();
      expect(res.body.data.verifyNote).toBeNull();
      expect(res.body.data.verifiedBy).toBeNull();
      // 明文与 storage key 都不得出现在整个响应体的任何角落。
      expect(JSON.stringify(res.body)).not.toContain('SZ-2026-SENSITIVE-0001');
      expect(JSON.stringify(res.body)).not.toContain('原件已核');
      expect(res.body.data).not.toHaveProperty('imageKeys');
      expect(res.body.data).not.toHaveProperty('certNumber');
    });

    it('biz-admin(含 read.sensitive):同一张证书给明文编号与备注', async () => {
      const res = await request(httpServer(app))
        .get(`${base()}/${sensitiveCertId}`)
        .set('Authorization', admBizAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.certNumberFull).toBe('SZ-2026-SENSITIVE-0001');
      expect(res.body.data.certNumberMasked).toBe('SZ****01');
      expect(res.body.data.verifyNote).toBe('原件已核,备注仅敏感可见');
    });

    it('SUPER_ADMIN 短路:同样给明文', async () => {
      const res = await request(httpServer(app))
        .get(`${base()}/${sensitiveCertId}`)
        .set('Authorization', saAuth);

      expect(res.status).toBe(200);
      expect(res.body.data.certNumberFull).toBe('SZ-2026-SENSITIVE-0001');
    });

    it('列表恒不返编号任何形态(§15.2:连掩码字段也不在列表 select 里)', async () => {
      const res = await request(httpServer(app)).get(base()).set('Authorization', admBizAuth);

      expect(res.status).toBe(200);
      for (const item of res.body.data as Array<Record<string, unknown>>) {
        expect(item).not.toHaveProperty('certNumber');
        expect(item).not.toHaveProperty('certNumberFull');
        expect(item).not.toHaveProperty('verifyNote');
        expect(item).not.toHaveProperty('verifiedBy');
        expect(item).not.toHaveProperty('imageKeys');
      }
    });
  });
});
