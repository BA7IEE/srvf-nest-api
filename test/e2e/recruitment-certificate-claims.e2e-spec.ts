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

// 证书标准库 PR-4a-1 e2e(冻结稿 §8.2 / §8.3 / §11.2 / §13.3 / §13.4 / §15.4 / §15.5 / §17)。
//
// 覆盖 6 个新端点:招新证书申报管理端 5 + 公开证书标准选项 1。
//
// PR-4a-1 落地时本刀是纯新增(不派生门槛、不停写旧 JSON),文件末尾那条曾是**反向**断言。
// PR-4a-2 接线后它已翻面:审核通过 → 派生门槛写入,撤回 → 聚合后清除。
// 反向断言的寿命只到它锁住的事实还成立那一刻,过期不翻面就是假绿。
//
// 判权用码全部复用既有 3 码,零新增:
//   recruitment-application.read.record     读列表 / 详情
//   recruitment-application.read.sensitive  完整编号 / 审核人 / 备注 / 证据图 URL
//   recruitment-application.review.certificate  审核 / 撤回审核

const CLAIM_STATUS = {
  SUBMITTED: 'SUBMITTED',
  NEEDS_INFO: 'NEEDS_INFO',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  PROMOTED: 'PROMOTED',
  WITHDRAWN: 'WITHDRAWN',
} as const;

const ADMIN = '/api/admin/v1/recruitment';
const PUBLIC_STANDARDS = '/api/open/v1/recruitment/certificate-standards';

// §13.3 出参字段闭集。多一个字段就是公开面扩面,所以用**精确 key 集合**断言,
// 不用 objectContaining —— 后者放行任何新增字段。
const PUBLIC_OPTION_KEYS = [
  'id',
  'code',
  'name',
  'categoryCode',
  'levelCode',
  'currentlyRecognized',
].sort();

describe('recruitment certificate claims + public standard options(PR-4a-1)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let recordAuth: string; // read.record(无 sensitive、无 review)
  let sensitiveAuth: string; // read.record + read.sensitive
  let reviewerAuth: string; // 三码全持
  let plainAuth: string; // 无任何招新码

  let cycleId: string;
  let firstAidStandardId: string; // ACTIVE CREDENTIAL + ACTIVE Policy(FIXED_MONTHS/ALLOWLIST/REQUIRED)
  let firstAidIssuerId: string;
  let bsafePendingStandardId: string; // ACTIVE CREDENTIAL,**无** ACTIVE Policy(§11.2 待认定)

  async function createUserWithCodes(username: string, codes: string[]): Promise<string> {
    await createTestUser(app, { username, role: Role.USER });
    const u = await prisma.user.findUniqueOrThrow({ where: { username }, select: { id: true } });
    for (const code of codes) {
      const [moduleName, action, resourceType] = code.split('.');
      await prisma.permission.upsert({
        where: { code },
        update: {},
        create: { code, module: moduleName, action, resourceType },
      });
    }
    const perms = await prisma.permission.findMany({
      where: { code: { in: codes } },
      select: { id: true },
    });
    const role = await prisma.rbacRole.create({
      data: { code: `rcc-role-${username}`, displayName: username },
      select: { id: true },
    });
    if (perms.length > 0) {
      await prisma.rolePermission.createMany({
        data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })),
        skipDuplicates: true,
      });
    }
    await prisma.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: u.id,
        roleId: role.id,
        scopeType: 'GLOBAL',
        status: 'ACTIVE',
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
      },
    });
    return (await loginAs(app, username)).authHeader;
  }

  // 直插报名行(免 OCR / 去重链干扰;字段镜像 recruitment.e2e 的 createAppRow)。
  let appSeq = 0;
  async function createAppRow(over: Record<string, unknown> = {}): Promise<string> {
    appSeq += 1;
    const row = await prisma.recruitmentApplication.create({
      data: {
        cycleId,
        statusCode: 'verified',
        documentTypeCode: 'mainland_id',
        isForeigner: false,
        realName: '张三',
        idCardNumber: `RCC${String(appSeq).padStart(6, '0')}`,
        birthDate: new Date('1990-03-07T00:00:00.000Z'),
        genderCode: 'male',
        phone: `1390000${String(7000 + appSeq).slice(-4)}`,
        detailedAddress: '北京市朝阳区某街道 1 号',
        openid: `dev-openid-rcc-${appSeq}`,
        ...over,
      },
      select: { id: true },
    });
    return row.id;
  }

  async function createClaim(
    applicationId: string,
    over: Record<string, unknown> = {},
  ): Promise<{ id: string; version: number }> {
    return prisma.recruitmentCertificateClaim.create({
      data: {
        applicationId,
        status: CLAIM_STATUS.SUBMITTED,
        categoryHintCode: 'first_aid',
        rawCertificateName: '红十字急救员证',
        imageKeys: ['recruitment/claims/a.jpg', 'recruitment/claims/b.jpg'],
        certNumber: 'SZ-2026-000001',
        ...over,
      },
      select: { id: true, version: true },
    });
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    recordAuth = await createUserWithCodes('rcc-record', ['recruitment-application.read.record']);
    sensitiveAuth = await createUserWithCodes('rcc-sensitive', [
      'recruitment-application.read.record',
      'recruitment-application.read.sensitive',
    ]);
    reviewerAuth = await createUserWithCodes('rcc-reviewer', [
      'recruitment-application.read.record',
      'recruitment-application.read.sensitive',
      'recruitment-application.review.certificate',
    ]);
    plainAuth = await createUserWithCodes('rcc-plain', []);

    cycleId = (
      await prisma.recruitmentCycle.create({
        data: { year: 2026, name: '2026 年度招新', statusCode: 'open' },
        select: { id: true },
      })
    ).id;

    // 字典:招新两类 + 一个非招新类(证明 §13.3 的类别过滤真在过滤)。
    const certType = await prisma.dictType.create({
      data: { code: 'cert_type', label: '证书大类' },
      select: { id: true },
    });
    const subType = await prisma.dictType.create({
      data: { code: 'cert_sub_type', label: '证书子类型' },
      select: { id: true },
    });
    await prisma.dictItem.createMany({
      data: [
        { typeId: certType.id, code: 'first_aid', label: '急救' },
        { typeId: certType.id, code: 'bsafe', label: 'BSAFE' },
        { typeId: certType.id, code: 'rope', label: '绳索(非招新类别)' },
      ],
    });
    await prisma.dictItem.create({
      data: { typeId: subType.id, code: 'rcc-l2', label: '二级' },
    });

    // ① 急救:ACTIVE CREDENTIAL + ACTIVE Policy(ALLOWLIST / FIXED_MONTHS 24 / REQUIRED)
    const firstAid = await prisma.certificateStandard.create({
      data: {
        code: 'rcc-first-aid',
        name: '红十字急救员证',
        kind: 'CREDENTIAL',
        status: 'ACTIVE',
        categoryCode: 'first_aid',
        levelCode: 'rcc-l2',
        sortOrder: 10,
      },
      select: { id: true },
    });
    firstAidStandardId = firstAid.id;
    const policy = await prisma.certificateRecognitionPolicy.create({
      data: {
        standardId: firstAidStandardId,
        version: 1,
        status: 'ACTIVE',
        issuerPolicy: 'ALLOWLIST',
        validityMode: 'FIXED_MONTHS',
        validityMonths: 24,
        certNumberMode: 'REQUIRED',
      },
      select: { id: true },
    });
    firstAidIssuerId = (
      await prisma.certificateRecognitionIssuer.create({
        data: { policyId: policy.id, name: '深圳市红十字会', normalizedName: '深圳市红十字会' },
        select: { id: true },
      })
    ).id;

    // ② BSAFE:ACTIVE CREDENTIAL,**无** ACTIVE Policy —— §11.2「已收录、待认定」。
    bsafePendingStandardId = (
      await prisma.certificateStandard.create({
        data: {
          code: 'rcc-bsafe-pending',
          name: 'BSAFE 二级(暂无认定规则)',
          kind: 'CREDENTIAL',
          status: 'ACTIVE',
          categoryCode: 'bsafe',
          sortOrder: 20,
        },
        select: { id: true },
      })
    ).id;

    // ③ 三条不该出现在公开选项里的标准:DRAFT / FAMILY / 非招新类别。
    await prisma.certificateStandard.createMany({
      data: [
        {
          code: 'rcc-draft',
          name: '草稿标准',
          kind: 'CREDENTIAL',
          status: 'DRAFT',
          categoryCode: 'first_aid',
        },
        {
          code: 'rcc-family',
          name: '证书族(不可持有)',
          kind: 'FAMILY',
          status: 'ACTIVE',
          categoryCode: 'first_aid',
        },
        {
          code: 'rcc-rope',
          name: '绳索技术证(非招新类别)',
          kind: 'CREDENTIAL',
          status: 'ACTIVE',
          categoryCode: 'rope',
        },
      ],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.recruitmentCertificateClaim.deleteMany({});
    await prisma.auditLog.deleteMany({});
  });

  // ===== §13.3 公开证书标准选项 =====

  it('§13.3 公开选项:无 token 可读;只 ACTIVE+CREDENTIAL+招新类别;出参字段恰好 6 个', async () => {
    const res = await request(httpServer(app)).get(PUBLIC_STANDARDS);
    expect(res.status).toBe(200);

    const codes = (res.body.data.items as Array<{ code: string }>).map((i) => i.code);
    // DRAFT / FAMILY / 非招新类别三条都不在。
    expect(codes).toEqual(['rcc-first-aid', 'rcc-bsafe-pending']);

    for (const item of res.body.data.items as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(PUBLIC_OPTION_KEYS);
    }
  });

  it('§11.2 公开选项:有 ACTIVE 规则 → currentlyRecognized=true;已收录待认定 → false', async () => {
    const res = await request(httpServer(app)).get(PUBLIC_STANDARDS);
    const byCode = new Map(
      (res.body.data.items as Array<{ code: string; currentlyRecognized: boolean }>).map((i) => [
        i.code,
        i.currentlyRecognized,
      ]),
    );
    expect(byCode.get('rcc-first-aid')).toBe(true);
    expect(byCode.get('rcc-bsafe-pending')).toBe(false);
  });

  // ===== §13.4 判权边界 =====

  it('§13.4 判权:无招新码时 5 个管理端点全 403', async () => {
    const applicationId = await createAppRow();
    const claim = await createClaim(applicationId);
    const server = httpServer(app);

    expectBizError(
      await request(server)
        .get(`${ADMIN}/applications/${applicationId}/certificate-claims`)
        .set('Authorization', plainAuth),
      BizCode.RBAC_FORBIDDEN,
    );
    expectBizError(
      await request(server)
        .get(`${ADMIN}/certificate-claims/${claim.id}`)
        .set('Authorization', plainAuth),
      BizCode.RBAC_FORBIDDEN,
    );
    // 证据图要 read.sensitive —— 只持 read.record 也拒。
    expectBizError(
      await request(server)
        .get(`${ADMIN}/certificate-claims/${claim.id}/image-urls`)
        .set('Authorization', recordAuth),
      BizCode.RBAC_FORBIDDEN,
    );
    // 审核要 review.certificate —— 持 read.sensitive 也拒(读 ≠ 判)。
    expectBizError(
      await request(server)
        .post(`${ADMIN}/certificate-claims/${claim.id}/review`)
        .set('Authorization', sensitiveAuth)
        .send({ decision: 'REJECT', version: claim.version, note: '不清晰' }),
      BizCode.RBAC_FORBIDDEN,
    );
    expectBizError(
      await request(server)
        .post(`${ADMIN}/certificate-claims/${claim.id}/revoke-review`)
        .set('Authorization', sensitiveAuth)
        .send({ version: claim.version, note: '结论有误' }),
      BizCode.RBAC_FORBIDDEN,
    );
  });

  it('§15.4 敏感分级:read.record 只见掩码;read.sensitive 见明文;imageKeys 两档都不返', async () => {
    const applicationId = await createAppRow();
    const claim = await createClaim(applicationId, {
      reviewedByUserId: null,
      reviewNote: '需要补一张正面照',
    });

    const masked = await request(httpServer(app))
      .get(`${ADMIN}/certificate-claims/${claim.id}`)
      .set('Authorization', recordAuth);
    expect(masked.status).toBe(200);
    expect(masked.body.data.certNumberMasked).toBe('SZ****01');
    expect(masked.body.data.certNumberFull).toBeNull();
    expect(masked.body.data.reviewNote).toBeNull();
    expect(masked.body.data.reviewedByUserId).toBeNull();
    expect(masked.body.data.imageCount).toBe(2);
    expect(masked.body.data).not.toHaveProperty('imageKeys');

    const full = await request(httpServer(app))
      .get(`${ADMIN}/certificate-claims/${claim.id}`)
      .set('Authorization', sensitiveAuth);
    expect(full.status).toBe(200);
    expect(full.body.data.certNumberFull).toBe('SZ-2026-000001');
    expect(full.body.data.reviewNote).toBe('需要补一张正面照');
    // 明文档同样不返 key —— sensitive 解锁的是编号与备注,不是对象存储路径。
    expect(full.body.data).not.toHaveProperty('imageKeys');
  });

  it('§15.4 列表也走同一敏感出口(掩码档不泄明文编号)', async () => {
    const applicationId = await createAppRow();
    await createClaim(applicationId);
    const res = await request(httpServer(app))
      .get(`${ADMIN}/applications/${applicationId}/certificate-claims`)
      .set('Authorization', recordAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].certNumberFull).toBeNull();
    expect(res.body.data.items[0]).not.toHaveProperty('imageKeys');
    expect(JSON.stringify(res.body)).not.toContain('SZ-2026-000001');
  });

  it('§15.4 授权不只靠 claimId:报名软删后详情 404(不泄「claim 在但报名没了」)', async () => {
    const applicationId = await createAppRow();
    const claim = await createClaim(applicationId);
    await prisma.recruitmentApplication.update({
      where: { id: applicationId },
      data: { deletedAt: new Date() },
    });
    expectBizError(
      await request(httpServer(app))
        .get(`${ADMIN}/certificate-claims/${claim.id}`)
        .set('Authorization', sensitiveAuth),
      BizCode.RECRUITMENT_CERTIFICATE_CLAIM_NOT_FOUND,
    );
  });

  // ===== §15.5 证据图 =====

  it('§15.5 证据图:返 URL 条数=key 条数、不返 key、带 Cache-Control: no-store', async () => {
    const applicationId = await createAppRow();
    const claim = await createClaim(applicationId);
    const res = await request(httpServer(app))
      .get(`${ADMIN}/certificate-claims/${claim.id}/image-urls`)
      .set('Authorization', sensitiveAuth);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.urls).toHaveLength(2);
    expect(res.body.data.expiresAt).toEqual(expect.any(String));
    expect(res.body.data).not.toHaveProperty('imageKeys');
    expect(res.body.data).not.toHaveProperty('keys');

    // 审计只记条数,URL / key 一律不入(§15.6)。
    const log = await prisma.auditLog.findFirstOrThrow({
      where: { event: 'recruitment-application.read.other' },
      select: { context: true },
    });
    const extra = (log.context as { extra: Record<string, unknown> }).extra;
    expect(extra.count).toBe(2);
    expect(JSON.stringify(extra)).not.toContain('recruitment/claims/');
    expect(JSON.stringify(extra)).not.toContain('http');
  });

  // ===== 评审 findings F2(§15.5 / §15.9):证据授权按 status 分流 =====
  //
  // 上面那条只证明了「正常 Claim 能返两个 URL」。它对**不该出图的状态**一个字都没说,
  // 而修复前的实现恰恰是「查权限 → 签全部 key」,状态完全不参与判定。
  // 下面三条是反向断言,少了它们这条分流规则随时可以被删掉而全绿。

  it('§15.5 WITHDRAWN 申报不得签证据 URL —— 撤回不能只撤掉列表可见性', async () => {
    const applicationId = await createAppRow();
    const claim = await createClaim(applicationId, { status: CLAIM_STATUS.WITHDRAWN });
    expectBizError(
      await request(httpServer(app))
        .get(`${ADMIN}/certificate-claims/${claim.id}/image-urls`)
        .set('Authorization', sensitiveAuth),
      BizCode.RECRUITMENT_CERTIFICATE_CLAIM_STATE_INVALID,
    );
  });

  it('§15.9 PROMOTED 申报的证据只能经 Certificate scoped 端点读 —— Claim 端点拒签', async () => {
    const applicationId = await createAppRow();
    const policyId = (
      await prisma.certificateRecognitionPolicy.findFirstOrThrow({
        where: { standardId: firstAidStandardId, status: 'ACTIVE' },
        select: { id: true },
      })
    ).id;
    // PROMOTED 行须带齐标准化事实(DB 的 promoted 完整性 CHECK 拦着)。
    const claim = await createClaim(applicationId, {
      status: CLAIM_STATUS.PROMOTED,
      standardId: firstAidStandardId,
      recognitionPolicyId: policyId,
      recognitionIssuerId: firstAidIssuerId,
      issuingOrg: '深圳市红十字会',
      issuedAt: new Date('2026-01-31T00:00:00.000Z'),
      promotedAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    expectBizError(
      await request(httpServer(app))
        .get(`${ADMIN}/certificate-claims/${claim.id}/image-urls`)
        .set('Authorization', sensitiveAuth),
      BizCode.RECRUITMENT_CERTIFICATE_CLAIM_STATE_INVALID,
    );
  });

  it('REJECTED 仍在审核流内 → 必须能出图(申请人可从 REJECTED 重投,审核员要能回看)', async () => {
    const applicationId = await createAppRow();
    const claim = await createClaim(applicationId, { status: CLAIM_STATUS.REJECTED });
    const res = await request(httpServer(app))
      .get(`${ADMIN}/certificate-claims/${claim.id}/image-urls`)
      .set('Authorization', sensitiveAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.urls).toHaveLength(2);
  });

  // ===== §8.3 审核 =====

  it('§8.3 APPROVE:锁定 Standard/Policy/机构/编号,FIXED_MONTHS 由后端算到期日', async () => {
    const applicationId = await createAppRow();
    const claim = await createClaim(applicationId);
    const res = await request(httpServer(app))
      .post(`${ADMIN}/certificate-claims/${claim.id}/review`)
      .set('Authorization', reviewerAuth)
      .send({
        decision: 'APPROVE',
        version: claim.version,
        standardId: firstAidStandardId,
        recognitionIssuerId: firstAidIssuerId,
        certNumber: ' SZ-2026-000001 ',
        issuedAt: '2026-01-31',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe(CLAIM_STATUS.APPROVED);
    expect(res.body.data.standard.id).toBe(firstAidStandardId);
    expect(res.body.data.recognitionPolicyId).toEqual(expect.any(String));
    expect(res.body.data.recognitionIssuerId).toBe(firstAidIssuerId);
    // 机构名是**快照**,不是让客户端传的自由文本(§5.6)。
    expect(res.body.data.issuingOrg).toBe('深圳市红十字会');
    // 编号 trim 后入库。
    expect(res.body.data.certNumberFull).toBe('SZ-2026-000001');
    // 24 个自然月:2026-01-31 → 2028-01-31(月底夹取不越界)。
    expect(res.body.data.expiredAt).toBe('2028-01-31T00:00:00.000Z');
    expect(res.body.data.issuedAt).toBe('2026-01-31T00:00:00.000Z');
    // 审核本身也自增 version,让并发的申请人重传撞 CAS。
    expect(res.body.data.version).toBe(claim.version + 1);
  });

  it('§8.3 APPROVE 必须解析到具体 Standard:不传 standardId → 28061', async () => {
    const applicationId = await createAppRow();
    const claim = await createClaim(applicationId);
    expectBizError(
      await request(httpServer(app))
        .post(`${ADMIN}/certificate-claims/${claim.id}/review`)
        .set('Authorization', reviewerAuth)
        .send({ decision: 'APPROVE', version: claim.version, issuedAt: '2026-01-31' }),
      BizCode.RECRUITMENT_CERTIFICATE_STANDARD_REQUIRED,
    );
  });

  it('§11.2 已收录但无生效认定规则的标准不能过审 → 28062(不因申请人选了它就自动通过)', async () => {
    const applicationId = await createAppRow();
    const claim = await createClaim(applicationId, {
      // 申请人建议了这个待认定标准 —— 建议本身合法,但过审必须另有生效规则。
      suggestedStandardId: bsafePendingStandardId,
      categoryHintCode: 'bsafe',
    });
    expectBizError(
      await request(httpServer(app))
        .post(`${ADMIN}/certificate-claims/${claim.id}/review`)
        .set('Authorization', reviewerAuth)
        .send({
          decision: 'APPROVE',
          version: claim.version,
          standardId: bsafePendingStandardId,
          issuedAt: '2026-01-31',
        }),
      BizCode.RECRUITMENT_CERTIFICATE_POLICY_UNAVAILABLE,
    );
    // 失败必须整条不落痕:状态、锁定字段都不动。
    const row = await prisma.recruitmentCertificateClaim.findUniqueOrThrow({
      where: { id: claim.id },
      select: { status: true, standardId: true, reviewedAt: true, version: true },
    });
    expect(row.status).toBe(CLAIM_STATUS.SUBMITTED);
    expect(row.standardId).toBeNull();
    expect(row.reviewedAt).toBeNull();
    expect(row.version).toBe(claim.version);
  });

  it('§5.4 ALLOWLIST 机构必须属于本规则:传别的规则的 issuer → 18014', async () => {
    // 另建一个 Standard + ACTIVE Policy + issuer,拿它的 issuer 去审第一个 Standard。
    const other = await prisma.certificateStandard.create({
      data: {
        code: `rcc-other-${Date.now()}`,
        name: '另一标准',
        kind: 'CREDENTIAL',
        status: 'ACTIVE',
        categoryCode: 'first_aid',
      },
      select: { id: true },
    });
    const otherPolicy = await prisma.certificateRecognitionPolicy.create({
      data: {
        standardId: other.id,
        version: 1,
        status: 'ACTIVE',
        issuerPolicy: 'ALLOWLIST',
        validityMode: 'PERMANENT',
        certNumberMode: 'NONE',
      },
      select: { id: true },
    });
    const foreignIssuer = await prisma.certificateRecognitionIssuer.create({
      data: { policyId: otherPolicy.id, name: '别家机构', normalizedName: '别家机构' },
      select: { id: true },
    });

    const applicationId = await createAppRow();
    const claim = await createClaim(applicationId);
    expectBizError(
      await request(httpServer(app))
        .post(`${ADMIN}/certificate-claims/${claim.id}/review`)
        .set('Authorization', reviewerAuth)
        .send({
          decision: 'APPROVE',
          version: claim.version,
          standardId: firstAidStandardId,
          recognitionIssuerId: foreignIssuer.id,
          certNumber: 'SZ-X',
          issuedAt: '2026-01-31',
        }),
      BizCode.CERTIFICATE_ISSUER_NOT_ALLOWED,
    );
  });

  it('§10.4 FIXED_MONTHS 下客户端不得自带到期日(不静默忽略,直接拒)', async () => {
    const applicationId = await createAppRow();
    const claim = await createClaim(applicationId);
    expectBizError(
      await request(httpServer(app))
        .post(`${ADMIN}/certificate-claims/${claim.id}/review`)
        .set('Authorization', reviewerAuth)
        .send({
          decision: 'APPROVE',
          version: claim.version,
          standardId: firstAidStandardId,
          recognitionIssuerId: firstAidIssuerId,
          certNumber: 'SZ-Y',
          issuedAt: '2026-01-31',
          expiredAt: '2099-01-01',
        }),
      BizCode.CERTIFICATE_VALIDITY_INVALID,
    );
  });

  it('§5.3 REQUIRED 编号不可空;§10.3 发证日不可晚于今天', async () => {
    const applicationId = await createAppRow();
    const a = await createClaim(applicationId);
    expectBizError(
      await request(httpServer(app))
        .post(`${ADMIN}/certificate-claims/${a.id}/review`)
        .set('Authorization', reviewerAuth)
        .send({
          decision: 'APPROVE',
          version: a.version,
          standardId: firstAidStandardId,
          recognitionIssuerId: firstAidIssuerId,
          issuedAt: '2026-01-31',
        }),
      BizCode.CERTIFICATE_NUMBER_REQUIRED,
    );

    const b = await createClaim(applicationId);
    expectBizError(
      await request(httpServer(app))
        .post(`${ADMIN}/certificate-claims/${b.id}/review`)
        .set('Authorization', reviewerAuth)
        .send({
          decision: 'APPROVE',
          version: b.version,
          standardId: firstAidStandardId,
          recognitionIssuerId: firstAidIssuerId,
          certNumber: 'SZ-Z',
          issuedAt: '2099-01-01',
        }),
      BizCode.CERTIFICATE_ISSUED_AT_IN_FUTURE,
    );
  });

  it('§8.3 REJECT 清标准化结论且 note 必填;NEEDS_INFO 保留图片与原始事实', async () => {
    const applicationId = await createAppRow();

    // REJECT 缺 note → 40000
    const a = await createClaim(applicationId);
    expectBizError(
      await request(httpServer(app))
        .post(`${ADMIN}/certificate-claims/${a.id}/review`)
        .set('Authorization', reviewerAuth)
        .send({ decision: 'REJECT', version: a.version }),
      BizCode.BAD_REQUEST,
      { strictMessage: false },
    );

    // 先 APPROVE 再 REJECT 不可(APPROVED 只能去 PROMOTED/SUBMITTED/WITHDRAWN),
    // 所以这里直插一条带锁定字段的 SUBMITTED 行,验证 REJECT 会把它们清掉。
    const b = await createClaim(applicationId, {
      standardId: firstAidStandardId,
      recognitionIssuerId: firstAidIssuerId,
    });
    const rejected = await request(httpServer(app))
      .post(`${ADMIN}/certificate-claims/${b.id}/review`)
      .set('Authorization', reviewerAuth)
      .send({ decision: 'REJECT', version: b.version, note: '证书图不清晰' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.status).toBe(CLAIM_STATUS.REJECTED);
    expect(rejected.body.data.standard).toBeNull();
    expect(rejected.body.data.recognitionIssuerId).toBeNull();
    // 图不删 —— 申请人可能只是拍糊了,重传要能对照(§8.3)。
    expect(rejected.body.data.imageCount).toBe(2);

    const c = await createClaim(applicationId);
    const needsInfo = await request(httpServer(app))
      .post(`${ADMIN}/certificate-claims/${c.id}/review`)
      .set('Authorization', reviewerAuth)
      .send({ decision: 'NEEDS_INFO', version: c.version, note: '请补正面照' });
    expect(needsInfo.status).toBe(200);
    expect(needsInfo.body.data.status).toBe(CLAIM_STATUS.NEEDS_INFO);
    expect(needsInfo.body.data.imageCount).toBe(2);
    expect(needsInfo.body.data.standard).toBeNull();
  });

  it('§5.5 CAS:version 不匹配 → 28058(申请人重传与审核互防覆盖)', async () => {
    const applicationId = await createAppRow();
    const claim = await createClaim(applicationId);
    expectBizError(
      await request(httpServer(app))
        .post(`${ADMIN}/certificate-claims/${claim.id}/review`)
        .set('Authorization', reviewerAuth)
        .send({ decision: 'NEEDS_INFO', version: claim.version + 7, note: '补材料' }),
      BizCode.RECRUITMENT_CERTIFICATE_CLAIM_VERSION_CONFLICT,
    );
  });

  it('§8.2 终态不可再审:PROMOTED 与 WITHDRAWN 一律 28057', async () => {
    const applicationId = await createAppRow();
    // PROMOTED 行必须带齐标准化事实 —— DB 的 promoted_complete_check 拦着,
    // 造不出「已发号却没锁定规则」的行(这正是那条 CHECK 存在的意义)。
    const policyId = (
      await prisma.certificateRecognitionPolicy.findFirstOrThrow({
        where: { standardId: firstAidStandardId, status: 'ACTIVE' },
        select: { id: true },
      })
    ).id;
    for (const status of [CLAIM_STATUS.PROMOTED, CLAIM_STATUS.WITHDRAWN]) {
      const claim = await createClaim(applicationId, {
        status,
        standardId: firstAidStandardId,
        ...(status === CLAIM_STATUS.PROMOTED
          ? {
              recognitionPolicyId: policyId,
              recognitionIssuerId: firstAidIssuerId,
              issuingOrg: '深圳市红十字会',
              issuedAt: new Date('2026-01-31T00:00:00.000Z'),
              promotedAt: new Date('2026-02-01T00:00:00.000Z'),
            }
          : {}),
      });
      expectBizError(
        await request(httpServer(app))
          .post(`${ADMIN}/certificate-claims/${claim.id}/review`)
          .set('Authorization', reviewerAuth)
          .send({ decision: 'NEEDS_INFO', version: claim.version, note: '补材料' }),
        BizCode.RECRUITMENT_CERTIFICATE_CLAIM_STATE_INVALID,
      );
    }
  });

  // ===== §8.2 末段 撤回审核 =====

  it('§8.2 撤回审核:APPROVED → SUBMITTED 并清空锁定字段;非 APPROVED 撤回 → 28057', async () => {
    const applicationId = await createAppRow();
    const claim = await createClaim(applicationId);
    const approved = await request(httpServer(app))
      .post(`${ADMIN}/certificate-claims/${claim.id}/review`)
      .set('Authorization', reviewerAuth)
      .send({
        decision: 'APPROVE',
        version: claim.version,
        standardId: firstAidStandardId,
        recognitionIssuerId: firstAidIssuerId,
        certNumber: 'SZ-REV-1',
        issuedAt: '2026-01-31',
      });
    expect(approved.status).toBe(200);

    const revoked = await request(httpServer(app))
      .post(`${ADMIN}/certificate-claims/${claim.id}/revoke-review`)
      .set('Authorization', reviewerAuth)
      .send({ version: approved.body.data.version, note: '认错了机构' });
    expect(revoked.status).toBe(200);
    // 回 SUBMITTED 而非 NEEDS_INFO:撤回是「结论错了」,不是「材料不足」(§8.2 末段)。
    expect(revoked.body.data.status).toBe(CLAIM_STATUS.SUBMITTED);
    expect(revoked.body.data.standard).toBeNull();
    expect(revoked.body.data.recognitionPolicyId).toBeNull();
    expect(revoked.body.data.recognitionIssuerId).toBeNull();
    expect(revoked.body.data.reviewNote).toBe('认错了机构');

    // 已回 SUBMITTED,再撤一次就该拒。
    expectBizError(
      await request(httpServer(app))
        .post(`${ADMIN}/certificate-claims/${claim.id}/revoke-review`)
        .set('Authorization', reviewerAuth)
        .send({ version: revoked.body.data.version, note: '再撤一次' }),
      BizCode.RECRUITMENT_CERTIFICATE_CLAIM_STATE_INVALID,
    );
  });

  // ===== §17 审计闭集 =====

  it('§17 审核审计只含闭集字段:无完整编号 / imageKeys / 备注全文,但有 certNumberProvided', async () => {
    const applicationId = await createAppRow();
    const claim = await createClaim(applicationId);
    const res = await request(httpServer(app))
      .post(`${ADMIN}/certificate-claims/${claim.id}/review`)
      .set('Authorization', reviewerAuth)
      .send({
        decision: 'APPROVE',
        version: claim.version,
        standardId: firstAidStandardId,
        recognitionIssuerId: firstAidIssuerId,
        certNumber: 'SZ-AUDIT-0001',
        issuedAt: '2026-01-31',
        note: '与名单一致,通过',
      });
    expect(res.status).toBe(200);

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { event: 'recruitment-certificate-claim.review' },
      select: { context: true, resourceId: true, resourceType: true },
    });
    expect(log.resourceType).toBe('recruitment_certificate_claim');
    expect(log.resourceId).toBe(claim.id);

    const extra = (log.context as { extra: Record<string, unknown> }).extra;
    // 闭集:多一个 key 就要有拍板出处,所以精确比 key 集合。
    expect(Object.keys(extra).sort()).toEqual(
      [
        'operation',
        'applicationId',
        'decision',
        'standardId',
        'policyId',
        'issuerProvided',
        'imageCount',
        'certNumberProvided',
        'expiredAtProvided',
      ].sort(),
    );
    // 正向:布尔投影必须真的在(否则「不写明文」可以靠什么都不写来假装满足)。
    expect(extra.certNumberProvided).toBe(true);
    expect(extra.imageCount).toBe(2);

    const serialized = JSON.stringify(extra);
    expect(serialized).not.toContain('SZ-AUDIT-0001');
    expect(serialized).not.toContain('recruitment/claims/');
    expect(serialized).not.toContain('与名单一致');
  });

  it('§17 撤回审计记录被撤掉的是哪一版规则(事后复原判断依据)', async () => {
    const applicationId = await createAppRow();
    const claim = await createClaim(applicationId);
    const approved = await request(httpServer(app))
      .post(`${ADMIN}/certificate-claims/${claim.id}/review`)
      .set('Authorization', reviewerAuth)
      .send({
        decision: 'APPROVE',
        version: claim.version,
        standardId: firstAidStandardId,
        recognitionIssuerId: firstAidIssuerId,
        certNumber: 'SZ-REV-2',
        issuedAt: '2026-01-31',
      });
    await request(httpServer(app))
      .post(`${ADMIN}/certificate-claims/${claim.id}/revoke-review`)
      .set('Authorization', reviewerAuth)
      .send({ version: approved.body.data.version, note: '规则用错了' })
      .expect(200);

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { event: 'recruitment-certificate-claim.review-revoke' },
      select: { context: true },
    });
    const extra = (log.context as { extra: Record<string, unknown> }).extra;
    expect(extra.revokedStandardId).toBe(firstAidStandardId);
    expect(extra.revokedPolicyId).toEqual(expect.any(String));
    expect(JSON.stringify(extra)).not.toContain('SZ-REV-2');
  });

  // ===== §8.4 门槛派生(PR-4a-2 接线后)=====

  it('§8.4 审核通过 → 派生门槛写入 thresholdMarks;撤回审核 → 聚合后清除', async () => {
    const applicationId = await createAppRow();
    const claim = await createClaim(applicationId);

    // PR-4a-1 时这里断言的是**反向**的「审核不动门槛」——那是因为派生刻意还没接线。
    // 4a-2 接线后反向断言必须翻面,否则它就成了「锁住一个已经不成立的事实」的假绿。
    const approved = await request(httpServer(app))
      .post(`${ADMIN}/certificate-claims/${claim.id}/review`)
      .set('Authorization', reviewerAuth)
      .send({
        decision: 'APPROVE',
        version: claim.version,
        standardId: firstAidStandardId,
        recognitionIssuerId: firstAidIssuerId,
        certNumber: 'SZ-THRESH-1',
        issuedAt: '2026-01-31',
      });
    expect(approved.status).toBe(200);

    const afterApprove = await prisma.recruitmentApplication.findUniqueOrThrow({
      where: { id: applicationId },
      select: { thresholdMarks: true },
    });
    const marks = (afterApprove.thresholdMarks ?? {}) as Record<
      string,
      { at: string; by: string } | undefined
    >;
    // 急救类 Standard → redCross 门槛成立;bsafe 未过审 → 不成立。
    expect(marks.redCross?.by).toBe('system:certificate-claim-derived');
    expect(marks.bsafe).toBeUndefined();
    // 4a 时这里断言旧两个 JSON 列「仍在但恒 null」;PR-4b 已把它们整列 DROP,
    // 断言随之升级为「列不存在」—— 停写的终点是列没了,而不是永远写 null。
    await expect(
      prisma.$queryRaw`SELECT "certificateImages" FROM "recruitment_applications" LIMIT 1`,
    ).rejects.toThrow();

    // 撤回审核 → 该类别再无 APPROVED/PROMOTED Claim → 聚合清除该门槛。
    await request(httpServer(app))
      .post(`${ADMIN}/certificate-claims/${claim.id}/revoke-review`)
      .set('Authorization', reviewerAuth)
      .send({ version: approved.body.data.version, note: '结论有误' })
      .expect(200);
    const afterRevoke = await prisma.recruitmentApplication.findUniqueOrThrow({
      where: { id: applicationId },
      select: { thresholdMarks: true },
    });
    expect(
      ((afterRevoke.thresholdMarks ?? {}) as Record<string, unknown>).redCross,
    ).toBeUndefined();

    // 重算落审计(它是「为什么这份报名状态自己动了」的唯一线索)。
    const log = await prisma.auditLog.findFirstOrThrow({
      where: { event: 'recruitment-application.threshold-recompute' },
      select: { context: true, actorUserId: true },
    });
    const extra = (log.context as { extra: Record<string, unknown> }).extra;
    expect(Object.keys(extra).sort()).toEqual(
      ['operation', 'satisfiedCategories', 'evaluationCleared'].sort(),
    );
    expect(extra.satisfiedCategories).toEqual(['first_aid']);
  });
});
