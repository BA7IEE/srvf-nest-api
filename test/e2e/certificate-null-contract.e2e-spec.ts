import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// 第四轮跨模型评审 P1 —— 证书域 **null 契约**的真 HTTP e2e。
//
// 缺陷的机制:`@IsOptional()` 对 `null` 与 `undefined` **都**跳过后续校验,
// 而 service 判「传没传」用的是 `=== undefined` / `!== undefined` / `??`。
// 语义错位 ⇒ 显式 `null` 穿过契约层抵达 service,产生三种后果:
//
//   ① 静默写错事实 —— `issuedAt: null` → `new Date(null)` = **1970-01-01**,
//      作为正式审核事实落库并照常参与资质门槛派生;
//   ② 500 而非 400 —— `certNumberMode: null` 进 Prisma 非空列写入异常;
//   ③ 200 且什么都没改 —— `?? before.x` 把 null 当「没传」吞掉。
//
// 本 spec 的断言分三段,缺一不可:
//   A. **该 400 的必须 400**(9 条,含 1970 那条);
//   B. **400 之后系统毫发无损**(状态 / version / thresholdMarks / 审计 / 无 1970 行)——
//      只断言状态码会放过「先写坏再报错」的实现;
//   C. **真可空的字段仍然可清空**(5 条正向)—— 防矫枉过正,证明这一刀砍的是
//      「可省略被误当可清空」,不是把所有 null 一律打死。
//
// ⚠️ 反向断言的寿命只到它锁住的事实还成立那一刻。C 段那 5 条一旦哪天业务上
// 真的不再允许清空,必须来翻面,而不是删掉了事。

const ADMIN_RECRUITMENT = '/api/admin/v1/recruitment';
const STANDARDS = '/api/admin/v1/certificate-standards';
const POLICIES = '/api/admin/v1/certificate-recognition-policies';

const ALL_CODES = [
  'certificate-standard.read.record',
  'certificate-standard.create.record',
  'certificate-standard.update.record',
  'certificate-recognition-policy.read.record',
  'certificate-recognition-policy.create.record',
  'certificate-recognition-policy.update.record',
  'certificate.read.record',
  'certificate.create.record',
  'certificate.update.record',
  'recruitment-application.read.record',
  'recruitment-application.read.sensitive',
  'recruitment-application.review.certificate',
] as const;

// 1970-01-01 的 UTC 毫秒。`new Date(null)` 落在这里 —— 库里出现这个值
// 就等于那条缺陷复活了,所以每段 null 用例之后都查一次全表。
const EPOCH_START = new Date('1970-01-01T00:00:00.000Z');
const EPOCH_END = new Date('1970-01-02T00:00:00.000Z');

describe('证书域 null 契约(第四轮评审 P1)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: string;

  let memberId: string;
  let cycleId: string;
  // ALLOWLIST / EXPLICIT_OPTIONAL / OPTIONAL —— 审核用(三项都「可传可不传」,
  // 保证 400 一定来自 null 契约,而不是撞上别的必填规则)。
  let allowlistStandardId: string;
  let allowlistIssuerId: string;
  // FREE_TEXT / EXPLICIT_OPTIONAL / OPTIONAL —— 建证用(C 段三条正向清空)。
  let freeTextStandardId: string;
  let draftPolicyId: string; // DRAFT,PATCH 的靶子

  async function createUserWithCodes(username: string, codes: readonly string[]): Promise<string> {
    await createTestUser(app, { username, role: Role.ADMIN });
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
      where: { code: { in: [...codes] } },
      select: { id: true },
    });
    const role = await prisma.rbacRole.create({
      data: { code: `null-contract-${username}`, displayName: username },
      select: { id: true },
    });
    await prisma.rolePermission.createMany({
      data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })),
      skipDuplicates: true,
    });
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

  let appSeq = 0;
  let policySeq = 0;
  async function createAppRow(): Promise<string> {
    appSeq += 1;
    const row = await prisma.recruitmentApplication.create({
      data: {
        cycleId,
        statusCode: 'verified',
        documentTypeCode: 'mainland_id',
        isForeigner: false,
        realName: '张三',
        idCardNumber: `NC${String(appSeq).padStart(6, '0')}`,
        birthDate: new Date('1990-03-07T00:00:00.000Z'),
        genderCode: 'male',
        phone: `1390000${String(8000 + appSeq).slice(-4)}`,
        detailedAddress: '深圳市南山区某街道 1 号',
        openid: `dev-openid-nc-${appSeq}`,
      },
      select: { id: true },
    });
    return row.id;
  }

  async function createClaim(applicationId: string): Promise<{ id: string; version: number }> {
    return prisma.recruitmentCertificateClaim.create({
      data: {
        applicationId,
        status: 'SUBMITTED',
        categoryHintCode: 'first_aid',
        rawCertificateName: '红十字急救员证',
        imageKeys: ['recruitment/claims/a.jpg'],
      },
      select: { id: true, version: true },
    });
  }

  /** 建一条 Certificate(FREE_TEXT 规则),返回 id。 */
  async function createCertificate(over: Record<string, unknown> = {}): Promise<request.Response> {
    return request(httpServer(app))
      .post(`/api/admin/v1/members/${memberId}/certificates`)
      .set('Authorization', auth)
      .send({
        standardId: freeTextStandardId,
        issuingOrg: '深圳市某培训中心',
        issuedAt: '2024-01-01',
        ...over,
      });
  }

  /**
   * 发请求**之前**的现场快照。基线必须是实测值而不是猜的常量 ——
   * 新建报名的 `thresholdMarks` 是 null 不是 `{}`,写死 `{}` 会让反向断言
   * 因为「基线错了」而红,把真正要守的东西淹掉。
   */
  async function snapshotBefore(
    claimId: string,
    applicationId: string,
  ): Promise<{ status: string; version: number; thresholdMarks: unknown }> {
    const claim = await prisma.recruitmentCertificateClaim.findUniqueOrThrow({
      where: { id: claimId },
      select: { status: true, version: true },
    });
    const application = await prisma.recruitmentApplication.findUniqueOrThrow({
      where: { id: applicationId },
      select: { thresholdMarks: true },
    });
    return {
      status: claim.status,
      version: claim.version,
      thresholdMarks: application.thresholdMarks,
    };
  }

  /**
   * 反向数据断言:一次被拒的写入之后,系统必须**毫发无损**。
   * 只断言状态码会放过「先写坏再报错」的实现 —— 那正是 1970 那条缺陷的形态
   * (它压根没报错,直接写成功了)。
   */
  async function expectClaimUntouched(
    claimId: string,
    applicationId: string,
    before: { status: string; version: number; thresholdMarks: unknown },
  ): Promise<void> {
    const row = await prisma.recruitmentCertificateClaim.findUniqueOrThrow({
      where: { id: claimId },
      select: {
        status: true,
        version: true,
        standardId: true,
        issuedAt: true,
        reviewedAt: true,
        reviewNote: true,
      },
    });
    expect(row.status).toBe(before.status);
    expect(row.version).toBe(before.version);
    // 审核结论一格都不许落
    expect(row.standardId).toBeNull();
    expect(row.issuedAt).toBeNull();
    expect(row.reviewedAt).toBeNull();
    expect(row.reviewNote).toBeNull();

    const application = await prisma.recruitmentApplication.findUniqueOrThrow({
      where: { id: applicationId },
      select: { thresholdMarks: true },
    });
    expect(application.thresholdMarks).toEqual(before.thresholdMarks);

    const reviewAudits = await prisma.auditLog.count({
      where: { event: 'recruitment-certificate-claim.review', resourceId: claimId },
    });
    expect(reviewAudits).toBe(0);

    await expectNoEpochDates();
  }

  /** 全表扫:库里任何地方都不许出现 1970-01-01 的 issuedAt。 */
  async function expectNoEpochDates(): Promise<void> {
    const claimEpoch = await prisma.recruitmentCertificateClaim.count({
      where: { issuedAt: { gte: EPOCH_START, lt: EPOCH_END } },
    });
    expect(claimEpoch).toBe(0);
    const certEpoch = await prisma.certificate.count({
      where: { issuedAt: { gte: EPOCH_START, lt: EPOCH_END } },
    });
    expect(certEpoch).toBe(0);
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    auth = await createUserWithCodes('null-contract-admin', ALL_CODES);

    memberId = (
      await prisma.member.create({
        data: { memberNo: 'nc-m-1', ...memberIdentityData('Null 契约测试队员') },
        select: { id: true },
      })
    ).id;

    cycleId = (
      await prisma.recruitmentCycle.create({
        data: { year: 2026, name: '2026 年度招新', statusCode: 'open' },
        select: { id: true },
      })
    ).id;

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
      ],
    });
    await prisma.dictItem.create({ data: { typeId: subType.id, code: 'nc-l2', label: '二级' } });

    // ① ALLOWLIST / EXPLICIT_OPTIONAL / OPTIONAL —— Claim 审核用
    const allowlist = await prisma.certificateStandard.create({
      data: {
        code: 'nc-first-aid',
        name: '红十字急救员证',
        kind: 'CREDENTIAL',
        status: 'ACTIVE',
        categoryCode: 'first_aid',
        sortOrder: 10,
      },
      select: { id: true },
    });
    allowlistStandardId = allowlist.id;
    const allowlistPolicy = await prisma.certificateRecognitionPolicy.create({
      data: {
        standardId: allowlistStandardId,
        version: 1,
        status: 'ACTIVE',
        issuerPolicy: 'ALLOWLIST',
        validityMode: 'EXPLICIT_OPTIONAL',
        certNumberMode: 'OPTIONAL',
      },
      select: { id: true },
    });
    allowlistIssuerId = (
      await prisma.certificateRecognitionIssuer.create({
        data: {
          policyId: allowlistPolicy.id,
          name: '深圳市红十字会',
          normalizedName: '深圳市红十字会',
        },
        select: { id: true },
      })
    ).id;

    // ② FREE_TEXT / EXPLICIT_OPTIONAL / OPTIONAL —— 建证用
    const freeText = await prisma.certificateStandard.create({
      data: {
        code: 'nc-free-text',
        name: '自由机构证书',
        kind: 'CREDENTIAL',
        status: 'ACTIVE',
        categoryCode: 'bsafe',
        sortOrder: 20,
      },
      select: { id: true },
    });
    freeTextStandardId = freeText.id;
    await prisma.certificateRecognitionPolicy.create({
      data: {
        standardId: freeTextStandardId,
        version: 1,
        status: 'ACTIVE',
        issuerPolicy: 'FREE_TEXT',
        validityMode: 'EXPLICIT_OPTIONAL',
        certNumberMode: 'OPTIONAL',
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.recruitmentCertificateClaim.deleteMany({});
    await prisma.certificate.deleteMany({});
    await prisma.auditLog.deleteMany({});

    // 每个用例一份新鲜 DRAFT Policy 当 PATCH 靶子(PATCH 只认 DRAFT)。
    // version 用单调计数器而不是随机数:(standardId, version) 是 unique,
    // 随机数在同一 suite 内必然撞(实测撞了)。
    policySeq += 1;
    const draft = await prisma.certificateRecognitionPolicy.create({
      data: {
        standardId: allowlistStandardId,
        version: 1000 + policySeq,
        status: 'DRAFT',
        issuerPolicy: 'FREE_TEXT',
        validityMode: 'FIXED_MONTHS',
        validityMonths: 12,
        certNumberMode: 'OPTIONAL',
      },
      select: { id: true },
    });
    draftPolicyId = draft.id;
  });

  // ══════════════════════════════════════════════════════════════════════
  // A 段 · 该 400 的必须 400
  // ══════════════════════════════════════════════════════════════════════

  describe('A · Claim 审核:审核结论字段不接受 null', () => {
    it('APPROVE + standardId:null → 400(不是 18010「标准不存在」那种误导性错误码)', async () => {
      const applicationId = await createAppRow();
      const claim = await createClaim(applicationId);
      const before = await snapshotBefore(claim.id, applicationId);

      const res = await request(httpServer(app))
        .post(`${ADMIN_RECRUITMENT}/certificate-claims/${claim.id}/review`)
        .set('Authorization', auth)
        .send({
          decision: 'APPROVE',
          version: claim.version,
          standardId: null,
          issuedAt: '2026-01-31',
        });

      expect(res.status).toBe(400);
      await expectClaimUntouched(claim.id, applicationId, before);
    });

    // ★ 这一条就是 1970-01-01 那条。修复前:400 → 实际 200,
    //   且 claim.issuedAt 落成 1970-01-01,还照常派生 redCross/bsafe 门槛。
    it('APPROVE + issuedAt:null → 400,且库里不出现 1970-01-01', async () => {
      const applicationId = await createAppRow();
      const claim = await createClaim(applicationId);
      const before = await snapshotBefore(claim.id, applicationId);

      const res = await request(httpServer(app))
        .post(`${ADMIN_RECRUITMENT}/certificate-claims/${claim.id}/review`)
        .set('Authorization', auth)
        .send({
          decision: 'APPROVE',
          version: claim.version,
          standardId: allowlistStandardId,
          recognitionIssuerId: allowlistIssuerId,
          issuedAt: null,
        });

      expect(res.status).toBe(400);
      await expectClaimUntouched(claim.id, applicationId, before);
    });

    it('REJECT + note:null → 400(不许落一条「已驳回但没有驳回理由」的记录)', async () => {
      const applicationId = await createAppRow();
      const claim = await createClaim(applicationId);
      const before = await snapshotBefore(claim.id, applicationId);

      const res = await request(httpServer(app))
        .post(`${ADMIN_RECRUITMENT}/certificate-claims/${claim.id}/review`)
        .set('Authorization', auth)
        .send({ decision: 'REJECT', version: claim.version, note: null });

      expect(res.status).toBe(400);
      await expectClaimUntouched(claim.id, applicationId, before);
    });

    it('NEEDS_INFO + note:null → 400(申请人进度页要看的就是这段说明)', async () => {
      const applicationId = await createAppRow();
      const claim = await createClaim(applicationId);
      const before = await snapshotBefore(claim.id, applicationId);

      const res = await request(httpServer(app))
        .post(`${ADMIN_RECRUITMENT}/certificate-claims/${claim.id}/review`)
        .set('Authorization', auth)
        .send({ decision: 'NEEDS_INFO', version: claim.version, note: null });

      expect(res.status).toBe(400);
      await expectClaimUntouched(claim.id, applicationId, before);
    });

    // 正向对照:同一条路径传合法值必须照常 200 —— 证明上面四条 400 不是
    // 因为把整个端点堵死了。
    it('对照:APPROVE 传合法值仍 200,issuedAt 是传入那天(不是 1970)', async () => {
      const applicationId = await createAppRow();
      const claim = await createClaim(applicationId);

      const res = await request(httpServer(app))
        .post(`${ADMIN_RECRUITMENT}/certificate-claims/${claim.id}/review`)
        .set('Authorization', auth)
        .send({
          decision: 'APPROVE',
          version: claim.version,
          standardId: allowlistStandardId,
          recognitionIssuerId: allowlistIssuerId,
          issuedAt: '2026-01-31',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('APPROVED');
      expect(res.body.data.issuedAt).toBe('2026-01-31T00:00:00.000Z');
      await expectNoEpochDates();
    });
  });

  describe('A · Policy PATCH:五个可选字段一个都不接受 null', () => {
    // 修复前 issuerPolicy / certNumberMode 走的是「`?? locked.x` 先当没传算出合法
    // 最终态,再 `!== undefined` 判成传了」→ `data.x = null` 进 Prisma 非空列 → **500**。
    //
    // `validityMode` 是同一形状但**恰好**没炸:`assertValidityCombination(FIXED_MONTHS, null)`
    // 顺手把它拒成了 18015。那不是为 null 设的闸,只是撞上了 —— 所以它一并收口,
    // 不留「靠别的规则恰好挡住」的字段。修复前实测:issuerPolicy 500 / certNumberMode 500
    // / validityMode 400(偶然)。
    //
    // 对照组的 body 必须逐字段给,不能共用一个值:靶子 DRAFT 是 FREE_TEXT + 0 机构,
    // 单发 `issuerPolicy: ALLOWLIST` 会被「ALLOWLIST 至少 1 个机构」正当拒成 400,
    // 那样对照组测的就是另一件事了。
    for (const [field, okBody] of [
      ['issuerPolicy', { issuerPolicy: 'ALLOWLIST', issuers: [{ name: '对照组机构' }] }],
      ['validityMode', { validityMode: 'PERMANENT' }],
      ['certNumberMode', { certNumberMode: 'REQUIRED' }],
    ] as const) {
      it(`${field}:null → 400`, async () => {
        const res = await request(httpServer(app))
          .patch(`${POLICIES}/${draftPolicyId}`)
          .set('Authorization', auth)
          .send({ [field]: null });
        expect(res.status).toBe(400);

        // 对照:同字段传合法值必须 200 —— 证明 400 来自 null 本身,
        // 不是因为把整个字段/端点堵死了。
        const ok = await request(httpServer(app))
          .patch(`${POLICIES}/${draftPolicyId}`)
          .set('Authorization', auth)
          .send(okBody);
        expect(ok.status).toBe(200);
      });
    }

    it('issuers:null → 400(修复前被 `?? []` 折成空数组,把 DRAFT 机构集合静默清光)', async () => {
      await prisma.certificateRecognitionIssuer.create({
        data: { policyId: draftPolicyId, name: '某机构', normalizedName: '某机构' },
      });
      await request(httpServer(app))
        .patch(`${POLICIES}/${draftPolicyId}`)
        .set('Authorization', auth)
        .send({ issuerPolicy: 'ALLOWLIST' })
        .expect(200);

      const res = await request(httpServer(app))
        .patch(`${POLICIES}/${draftPolicyId}`)
        .set('Authorization', auth)
        .send({ issuers: null });
      expect(res.status).toBe(400);

      // 反向数据断言:机构集合必须还在。
      const remaining = await prisma.certificateRecognitionIssuer.count({
        where: { policyId: draftPolicyId, deletedAt: null },
      });
      expect(remaining).toBe(1);
    });

    // 分类结论:`validityMonths` 是**仅可省略**,不是可清空 ——
    // 它的 null 由 validityMode 派生,不由客户端直接指定(DTO 里那句
    // 「本 DTO 不接受 null」以前只是一句话,现在有执行位了)。
    it('validityMonths:null → 400(清空由改 validityMode 表达)', async () => {
      const res = await request(httpServer(app))
        .patch(`${POLICIES}/${draftPolicyId}`)
        .set('Authorization', auth)
        .send({ validityMonths: null });
      expect(res.status).toBe(400);

      const row = await prisma.certificateRecognitionPolicy.findUniqueOrThrow({
        where: { id: draftPolicyId },
        select: { validityMonths: true, validityMode: true },
      });
      expect(row.validityMonths).toBe(12);
      expect(row.validityMode).toBe('FIXED_MONTHS');
    });

    it('对照:改 validityMode 会把 validityMonths 一起归零(这才是清空的正确路径)', async () => {
      const res = await request(httpServer(app))
        .patch(`${POLICIES}/${draftPolicyId}`)
        .set('Authorization', auth)
        .send({ validityMode: 'PERMANENT' });
      expect(res.status).toBe(200);

      const row = await prisma.certificateRecognitionPolicy.findUniqueOrThrow({
        where: { id: draftPolicyId },
        select: { validityMonths: true, validityMode: true },
      });
      expect(row.validityMode).toBe('PERMANENT');
      expect(row.validityMonths).toBeNull();
    });
  });

  describe('A · Certificate PATCH:standardId 不接受 null', () => {
    it('standardId:null → 400(库内 NOT NULL,没有「清空标准」这个动作)', async () => {
      const created = await createCertificate();
      expect(created.status).toBe(201);
      const certificateId = created.body.data.id as string;

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/certificates/${certificateId}`)
        .set('Authorization', auth)
        .send({ standardId: null });
      expect(res.status).toBe(400);

      const row = await prisma.certificate.findUniqueOrThrow({
        where: { id: certificateId },
        select: { standardId: true, issuedAt: true },
      });
      expect(row.standardId).toBe(freeTextStandardId);
      expect(row.issuedAt).toEqual(new Date('2024-01-01T00:00:00.000Z'));
      await expectNoEpochDates();
    });

    it('issuedAt:null → 400,且不落成 1970-01-01', async () => {
      const created = await createCertificate();
      expect(created.status).toBe(201);
      const certificateId = created.body.data.id as string;

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/certificates/${certificateId}`)
        .set('Authorization', auth)
        .send({ issuedAt: null });
      expect(res.status).toBe(400);

      const row = await prisma.certificate.findUniqueOrThrow({
        where: { id: certificateId },
        select: { issuedAt: true },
      });
      expect(row.issuedAt).toEqual(new Date('2024-01-01T00:00:00.000Z'));
      await expectNoEpochDates();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // C 段 · 真可空的字段仍然可清空(防矫枉过正)
  // ══════════════════════════════════════════════════════════════════════

  describe('C · 正向:契约上真可 null 的字段,null 必须仍然被接受并真的清空', () => {
    it('Certificate.expiredAt:null → 200 并清成终身有效', async () => {
      const created = await createCertificate({ expiredAt: '2102-01-01' });
      expect(created.status).toBe(201);
      const certificateId = created.body.data.id as string;

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/certificates/${certificateId}`)
        .set('Authorization', auth)
        .send({ expiredAt: null });
      expect(res.status).toBe(200);

      const row = await prisma.certificate.findUniqueOrThrow({
        where: { id: certificateId },
        select: { expiredAt: true },
      });
      expect(row.expiredAt).toBeNull();
    });

    it('Certificate.certNumber:null → 200 并真的清空(OPTIONAL 规则下可改回无编号)', async () => {
      const created = await createCertificate({ certNumber: 'NC-0001' });
      expect(created.status).toBe(201);
      const certificateId = created.body.data.id as string;

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/certificates/${certificateId}`)
        .set('Authorization', auth)
        .send({ certNumber: null });
      expect(res.status).toBe(200);

      const row = await prisma.certificate.findUniqueOrThrow({
        where: { id: certificateId },
        select: { certNumber: true },
      });
      expect(row.certNumber).toBeNull();
    });

    it('Certificate.recognitionIssuerId:null → 200(FREE_TEXT 规则下换成自由机构名)', async () => {
      const created = await createCertificate();
      expect(created.status).toBe(201);
      const certificateId = created.body.data.id as string;

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/certificates/${certificateId}`)
        .set('Authorization', auth)
        .send({ recognitionIssuerId: null, issuingOrg: '换了个培训中心' });
      expect(res.status).toBe(200);

      const row = await prisma.certificate.findUniqueOrThrow({
        where: { id: certificateId },
        select: { recognitionIssuerId: true, issuingOrg: true },
      });
      expect(row.recognitionIssuerId).toBeNull();
      expect(row.issuingOrg).toBe('换了个培训中心');
    });

    it('DRAFT Standard.levelCode:null → 200 并真的清空', async () => {
      const created = await request(httpServer(app))
        .post(STANDARDS)
        .set('Authorization', auth)
        .send({
          code: `nc-lvl-${Math.random().toString(36).slice(2, 10)}`,
          name: '带等级的草稿标准',
          kind: 'CREDENTIAL',
          categoryCode: 'first_aid',
          levelCode: 'nc-l2',
        });
      expect(created.status).toBe(201);
      const id = created.body.data.id as string;

      const res = await request(httpServer(app))
        .patch(`${STANDARDS}/${id}`)
        .set('Authorization', auth)
        .send({ levelCode: null });
      expect(res.status).toBe(200);
      expect(res.body.data.levelCode).toBeNull();
    });

    it('DRAFT Standard.parentId:null → 200 并摘到根', async () => {
      const parent = await request(httpServer(app))
        .post(STANDARDS)
        .set('Authorization', auth)
        .send({
          code: `nc-fam-${Math.random().toString(36).slice(2, 10)}`,
          name: '证书族',
          kind: 'FAMILY',
          categoryCode: 'first_aid',
        });
      expect(parent.status).toBe(201);
      // 父级必须先 ACTIVE:挂到 DRAFT 目录节点下会造出「子已 ACTIVE、父还 DRAFT」
      // 的悬空树,service 拿 18034 拒(与本刀无关,是既有规则)。
      await request(httpServer(app))
        .patch(`${STANDARDS}/${parent.body.data.id as string}/status`)
        .set('Authorization', auth)
        .send({ status: 'ACTIVE' })
        .expect(200);

      const child = await request(httpServer(app))
        .post(STANDARDS)
        .set('Authorization', auth)
        .send({
          code: `nc-child-${Math.random().toString(36).slice(2, 10)}`,
          name: '挂在族下的标准',
          kind: 'CREDENTIAL',
          categoryCode: 'first_aid',
          parentId: parent.body.data.id as string,
        });
      expect(child.status).toBe(201);

      const res = await request(httpServer(app))
        .patch(`${STANDARDS}/${child.body.data.id as string}`)
        .set('Authorization', auth)
        .send({ parentId: null });
      expect(res.status).toBe(200);
      expect(res.body.data.parentId).toBeNull();
    });
  });
});
