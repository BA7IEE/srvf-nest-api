import type { INestApplication } from '@nestjs/common';
import { CertificateValidityMode, Role } from '@prisma/client';
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
import { memberIdentityData } from '../helpers/member-identity.fixture';

// 证书标准库 · 跨模型评审 findings F3:PATCH 三态语义 + 日期真实性 + verify 落点状态。
//
// 单独成文而不是塞进 certificates.e2e:这里要的是一张**矩阵**
// (validityMode × standardId 三态 × expiredAt 三态),
// 混进那个已经 1500 行的文件会让「哪一格没覆盖」根本看不出来。
//
// 三态语义(修复前两条都不成立):
//   字段不出现        → 保持库内现值      ← 修复前:传了同一个 standardId 就会被清成终身有效
//   字段出现且为 null → 清空              ← 修复前:`??` 把 null 当「没传」,清不掉
//   字段出现且有值    → 用新值

const CERT_STATUS = { PENDING: 'pending', VERIFIED: 'verified', EXPIRED: 'expired' } as const;

/** 按北京日历日偏移(与后端 date-only 口径同源,不用机器本地时区推日期)。 */
function beijingDayOffset(days: number): string {
  const d = new Date(Date.now() + 8 * 3_600_000);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('certificates PATCH 三态 + 日期真实性 + verify 落点(评审 findings F3)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAuth: string;
  let memberId: string;

  // 四种 validityMode 各一个 ACTIVE Standard + ACTIVE Policy。
  const std: Record<string, string> = {};
  let altExplicitOptionalStandardId: string; // 同 mode 的第二个标准,用于「异值」一格

  async function seedStandard(
    code: string,
    validityMode: CertificateValidityMode,
    validityMonths: number | null = null,
  ): Promise<string> {
    const s = await prisma.certificateStandard.create({
      data: {
        code,
        name: code,
        kind: 'CREDENTIAL',
        status: 'ACTIVE',
        categoryCode: 'first_aid',
      },
      select: { id: true },
    });
    await prisma.certificateRecognitionPolicy.create({
      data: {
        standardId: s.id,
        version: 1,
        status: 'ACTIVE',
        issuerPolicy: 'FREE_TEXT',
        validityMode,
        validityMonths,
        certNumberMode: 'OPTIONAL',
      },
    });
    return s.id;
  }

  async function createCert(body: Record<string, unknown>): Promise<string> {
    const res = await request(httpServer(app))
      .post(`/api/admin/v1/members/${memberId}/certificates`)
      .set('Authorization', adminAuth)
      .send(body);
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  }

  function patch(certId: string, body: Record<string, unknown>) {
    return request(httpServer(app))
      .patch(`/api/admin/v1/members/${memberId}/certificates/${certId}`)
      .set('Authorization', adminAuth)
      .send(body);
  }

  async function readCert(certId: string) {
    return prisma.certificate.findUniqueOrThrow({
      where: { id: certId },
      select: { expiredAt: true, certNumber: true, certStatusCode: true, standardId: true },
    });
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const admin = await createTestUser(app, { username: 'f3-adm', role: Role.ADMIN });
    adminAuth = (await loginAs(app, 'f3-adm')).authHeader;
    const bizSeed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, admin.id, bizSeed.bizAdminRoleId);

    memberId = (
      await prisma.member.create({
        data: { memberNo: 'f3-m-1', ...memberIdentityData('F3 Member') },
        select: { id: true },
      })
    ).id;

    const dictType = await prisma.dictType.create({
      data: { code: 'cert_type', label: '证书大类' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: dictType.id, code: 'first_aid', label: '救护员' },
    });

    std.EXPLICIT_OPTIONAL = await seedStandard(
      'f3-explicit-optional',
      CertificateValidityMode.EXPLICIT_OPTIONAL,
    );
    std.EXPLICIT_REQUIRED = await seedStandard(
      'f3-explicit-required',
      CertificateValidityMode.EXPLICIT_REQUIRED,
    );
    std.PERMANENT = await seedStandard('f3-permanent', CertificateValidityMode.PERMANENT);
    std.FIXED_MONTHS = await seedStandard(
      'f3-fixed-months',
      CertificateValidityMode.FIXED_MONTHS,
      24,
    );
    altExplicitOptionalStandardId = await seedStandard(
      'f3-explicit-optional-2',
      CertificateValidityMode.EXPLICIT_OPTIONAL,
    );
  });

  afterAll(async () => {
    await app.close();
  });

  // ===== ① expiredAt 三态 × standardId 三态(EXPLICIT_OPTIONAL:唯一四格全可达的 mode)=====
  //
  // 其余三种 mode 的 expiredAt 不是自由输入(PERMANENT / FIXED_MONTHS 不得传、
  // EXPLICIT_REQUIRED 不得为空),所以「三态」在它们身上只在**不传**那一列有意义 ——
  // 那一列由下面 ② 覆盖。把不可达的格子也写成用例只会得到一堆断言 400 的噪音。

  it('standardId 不传 + expiredAt 不传 → 到期日保持原值', async () => {
    const id = await createCert({
      standardId: std.EXPLICIT_OPTIONAL,
      issuingOrg: '深圳市红十字会',
      issuedAt: '2026-01-01',
      expiredAt: '2102-06-30',
    });
    expect((await patch(id, { issuingOrg: '深圳市急救中心' })).status).toBe(200);
    expect((await readCert(id)).expiredAt?.toISOString().slice(0, 10)).toBe('2102-06-30');
  });

  it('standardId 传**同值** + expiredAt 不传 → 到期日仍保持原值(修复前会被静默清成终身有效)', async () => {
    const id = await createCert({
      standardId: std.EXPLICIT_OPTIONAL,
      issuingOrg: '深圳市红十字会',
      issuedAt: '2026-01-01',
      expiredAt: '2102-06-30',
    });
    // 前端提交完整表单 = 带上原样的 standardId 但不带 expiredAt。
    // 修复前判据是 `dto.standardId !== undefined`(传没传)而不是「换没换」,
    // 于是这一格把一张有到期日的证书清成了终身有效。
    expect((await patch(id, { standardId: std.EXPLICIT_OPTIONAL })).status).toBe(200);
    expect((await readCert(id)).expiredAt?.toISOString().slice(0, 10)).toBe('2102-06-30');
  });

  it('expiredAt 传 null → 清成终身有效(修复前 `??` 把 null 当没传,清不掉)', async () => {
    const id = await createCert({
      standardId: std.EXPLICIT_OPTIONAL,
      issuingOrg: '深圳市红十字会',
      issuedAt: '2026-01-01',
      expiredAt: '2102-06-30',
    });
    expect((await patch(id, { expiredAt: null })).status).toBe(200);
    expect((await readCert(id)).expiredAt).toBeNull();
  });

  it('expiredAt 传新值 → 用新值', async () => {
    const id = await createCert({
      standardId: std.EXPLICIT_OPTIONAL,
      issuingOrg: '深圳市红十字会',
      issuedAt: '2026-01-01',
      expiredAt: '2102-06-30',
    });
    expect((await patch(id, { expiredAt: '2103-12-31' })).status).toBe(200);
    expect((await readCert(id)).expiredAt?.toISOString().slice(0, 10)).toBe('2103-12-31');
  });

  it('standardId 传**异值** + expiredAt 不传 → 换标准即换规则,旧到期日不再沿用', async () => {
    const id = await createCert({
      standardId: std.EXPLICIT_OPTIONAL,
      issuingOrg: '深圳市红十字会',
      issuedAt: '2026-01-01',
      expiredAt: '2102-06-30',
    });
    expect((await patch(id, { standardId: altExplicitOptionalStandardId })).status).toBe(200);
    const after = await readCert(id);
    expect(after.standardId).toBe(altExplicitOptionalStandardId);
    expect(after.expiredAt).toBeNull();
  });

  // ===== ② 四种 validityMode 在「只改无关字段」时都必须保持到期日 =====
  //
  // 这一组才是三态语义真正的回归网:修复前每一种 mode 只要请求体里出现 standardId
  // 就会走进「expiredAt 归 null」那一支,而 PERMANENT 之外的三种到期日都有实际含义。

  it.each([
    ['EXPLICIT_OPTIONAL', { expiredAt: '2102-06-30' }, '2102-06-30'],
    ['EXPLICIT_REQUIRED', { expiredAt: '2102-06-30' }, '2102-06-30'],
    // FIXED_MONTHS 由后端按 issuedAt + 24 个月算,客户端不得传。
    ['FIXED_MONTHS', {}, '2028-01-01'],
  ])('%s:只改机构 + 带同值 standardId → 到期日不动', async (mode, extra, expected) => {
    const id = await createCert({
      standardId: std[mode],
      issuingOrg: '深圳市红十字会',
      issuedAt: '2026-01-01',
      ...extra,
    });
    expect((await patch(id, { standardId: std[mode], issuingOrg: '深圳市急救中心' })).status).toBe(
      200,
    );
    expect((await readCert(id)).expiredAt?.toISOString().slice(0, 10)).toBe(expected);
  });

  it('PERMANENT:到期日恒 null,带同值 standardId 的 PATCH 不会凭空造出到期日', async () => {
    const id = await createCert({
      standardId: std.PERMANENT,
      issuingOrg: '深圳市红十字会',
      issuedAt: '2026-01-01',
    });
    expect(
      (await patch(id, { standardId: std.PERMANENT, issuingOrg: '深圳市急救中心' })).status,
    ).toBe(200);
    expect((await readCert(id)).expiredAt).toBeNull();
  });

  // ===== ③ certNumber 三态(OPTIONAL 规则要能改回无编号)=====

  it('certNumber 三态:不传保持 / null 清空 / 有值替换', async () => {
    const id = await createCert({
      standardId: std.EXPLICIT_OPTIONAL,
      issuingOrg: '深圳市红十字会',
      issuedAt: '2026-01-01',
      certNumber: 'SZ-0001',
    });
    expect((await patch(id, { issuingOrg: '深圳市急救中心' })).status).toBe(200);
    expect((await readCert(id)).certNumber).toBe('SZ-0001');

    expect((await patch(id, { certNumber: 'SZ-0002' })).status).toBe(200);
    expect((await readCert(id)).certNumber).toBe('SZ-0002');

    // 修复前这一格清不掉:`dto.certNumber ?? lockedBefore.certNumber` 把 null 当没传。
    expect((await patch(id, { certNumber: null })).status).toBe(200);
    expect((await readCert(id)).certNumber).toBeNull();
  });

  it('issuedAt 库内 NOT NULL → 显式传 null 稳定 400(不静默回落库内值)', async () => {
    const id = await createCert({
      standardId: std.EXPLICIT_OPTIONAL,
      issuingOrg: '深圳市红十字会',
      issuedAt: '2026-01-01',
    });
    expect((await patch(id, { issuedAt: null })).status).toBe(400);
  });

  // ===== ④ R6:真实值变化才回 pending =====

  it('已核验证书:整表单原样提交(值一个没变)→ 不打回 pending', async () => {
    const id = await createCert({
      standardId: std.EXPLICIT_OPTIONAL,
      issuingOrg: '深圳市红十字会',
      issuedAt: '2026-01-01',
      expiredAt: '2102-06-30',
      certNumber: 'SZ-1001',
    });
    await request(httpServer(app))
      .patch(`/api/admin/v1/members/${memberId}/certificates/${id}/verify`)
      .set('Authorization', adminAuth)
      .send({});
    expect((await readCert(id)).certStatusCode).toBe(CERT_STATUS.VERIFIED);

    // 管理端表单几乎都是「回填 + 整体提交」。修复前判据是「字段出现过」,
    // 于是这一次零变更的提交会把证书打回重审 —— 那不是边角情况而是常态。
    const res = await patch(id, {
      standardId: std.EXPLICIT_OPTIONAL,
      issuingOrg: '深圳市红十字会',
      issuedAt: '2026-01-01',
      expiredAt: '2102-06-30',
      certNumber: 'SZ-1001',
    });
    expect(res.status).toBe(200);
    expect((await readCert(id)).certStatusCode).toBe(CERT_STATUS.VERIFIED);
  });

  it('已核验证书:真的改了值 → 仍然打回 pending(反向断言,防止上一条把规则修没了)', async () => {
    const id = await createCert({
      standardId: std.EXPLICIT_OPTIONAL,
      issuingOrg: '深圳市红十字会',
      issuedAt: '2026-01-01',
      expiredAt: '2102-06-30',
    });
    await request(httpServer(app))
      .patch(`/api/admin/v1/members/${memberId}/certificates/${id}/verify`)
      .set('Authorization', adminAuth)
      .send({});
    expect((await patch(id, { expiredAt: '2103-01-01' })).status).toBe(200);
    expect((await readCert(id)).certStatusCode).toBe(CERT_STATUS.PENDING);
  });

  // ===== ⑤ V7:核验一张已过期的证书必须直接落 expired =====

  it('核验最后有效日已过的证书 → 直接 expired,不是 verified', async () => {
    const id = await createCert({
      standardId: std.EXPLICIT_OPTIONAL,
      issuingOrg: '深圳市红十字会',
      issuedAt: '2026-01-01',
      expiredAt: beijingDayOffset(-1), // 昨天到期
    });
    const res = await request(httpServer(app))
      .patch(`/api/admin/v1/members/${memberId}/certificates/${id}/verify`)
      .set('Authorization', adminAuth)
      .send({});
    expect(res.status).toBe(200);
    // 修复前写死 verified:到期扫描 cron 每天 09:00 才翻态,在那之前这张过期证书
    // 会一直被资质查询当作有效。
    expect((await readCert(id)).certStatusCode).toBe(CERT_STATUS.EXPIRED);
    expect(res.body.data.certStatusCode).toBe(CERT_STATUS.EXPIRED);
  });

  it('核验今天到期的证书 → 仍是 verified(最后有效日当天有效,边界不能错一天)', async () => {
    const id = await createCert({
      standardId: std.EXPLICIT_OPTIONAL,
      issuingOrg: '深圳市红十字会',
      issuedAt: '2026-01-01',
      expiredAt: beijingDayOffset(0),
    });
    await request(httpServer(app))
      .patch(`/api/admin/v1/members/${memberId}/certificates/${id}/verify`)
      .set('Authorization', adminAuth)
      .send({});
    expect((await readCert(id)).certStatusCode).toBe(CERT_STATUS.VERIFIED);
  });

  // ===== ⑥ V5:不存在的日期在**每个**证书日期入口稳定 400 =====

  const IMPOSSIBLE_DATES = [
    '2026-02-30', // 2 月没有 30 号
    '2027-02-29', // 平年没有 2/29
    '2026-04-31', // 小月没有 31 号
    '2026-13-01', // 没有 13 月
    '0000-01-01', // 零年
  ];

  it.each(IMPOSSIBLE_DATES)('建证 issuedAt=%s → 400', async (bad) => {
    const res = await request(httpServer(app))
      .post(`/api/admin/v1/members/${memberId}/certificates`)
      .set('Authorization', adminAuth)
      .send({ standardId: std.EXPLICIT_OPTIONAL, issuingOrg: '深圳市红十字会', issuedAt: bad });
    expect(res.status).toBe(400);
  });

  it.each(IMPOSSIBLE_DATES)('改证 expiredAt=%s → 400', async (bad) => {
    const id = await createCert({
      standardId: std.EXPLICIT_OPTIONAL,
      issuingOrg: '深圳市红十字会',
      issuedAt: '2026-01-01',
    });
    expect((await patch(id, { expiredAt: bad })).status).toBe(400);
  });

  it.each(IMPOSSIBLE_DATES)(
    '工作台过滤 issuedFrom=%s → 400(修复前该 DTO 零日历校验)',
    async (bad) => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/certificates')
        .query({ issuedFrom: bad })
        .set('Authorization', adminAuth);
      expect(res.status).toBe(400);
    },
  );

  // ===== ⑦ V8:工作台分页边界是**可执行**校验,不是只写在 Swagger 注解里 =====

  it.each([
    ['page=0', { page: 0 }],
    ['page=-5', { page: -5 }],
    ['pageSize=0', { pageSize: 0 }],
    ['pageSize=101(超上限)', { pageSize: 101 }],
    ['pageSize=100000', { pageSize: 100000 }],
  ])('工作台 %s → 400', async (_label, query) => {
    const res = await request(httpServer(app))
      .get('/api/admin/v1/certificates')
      .query(query)
      .set('Authorization', adminAuth);
    expect(res.status).toBe(400);
  });

  it('工作台 pageSize=100(恰好上限)→ 200(边界不能一刀切死)', async () => {
    const res = await request(httpServer(app))
      .get('/api/admin/v1/certificates')
      .query({ page: 1, pageSize: 100 })
      .set('Authorization', adminAuth);
    expect(res.status).toBe(200);
  });

  // ===== ⑧ 三态没有破坏既有的规则校验 =====

  it('PERMANENT 规则下传 expiredAt(非 null)仍拒 —— 三态不等于放开规则', async () => {
    const id = await createCert({
      standardId: std.PERMANENT,
      issuingOrg: '深圳市红十字会',
      issuedAt: '2026-01-01',
    });
    expectBizError(
      await patch(id, { expiredAt: '2102-01-01' }),
      BizCode.CERTIFICATE_VALIDITY_INVALID,
    );
  });

  it('EXPLICIT_REQUIRED 规则下把 expiredAt 传成 null → 拒(必填就是必填)', async () => {
    const id = await createCert({
      standardId: std.EXPLICIT_REQUIRED,
      issuingOrg: '深圳市红十字会',
      issuedAt: '2026-01-01',
      expiredAt: '2102-06-30',
    });
    expectBizError(await patch(id, { expiredAt: null }), BizCode.CERTIFICATE_VALIDITY_INVALID);
  });
});
