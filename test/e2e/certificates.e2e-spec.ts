import type { INestApplication } from '@nestjs/common';
import { DictItemStatus, Prisma, Role } from '@prisma/client';
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

// V2 第一阶段批次 2 certificates 模块 e2e。
// 覆盖 8 接口主成功 + 关键失败:权限 / 字典 / 状态机 / 跨 member / 软删 / 排序 / qualification-flag /
// 字段白名单 / 拒绝后重新提交。预计 50+ 用例(沿 batch 1 emergency-contacts.e2e 风格)。
//
// Slow-4 T2(2026-06-11,评审稿 §8 / D-S4-4):入口切到 service 层 rbac.can();
// 失败统一 RBAC_FORBIDDEN(30100)。`adminAuth` / `adminWithMemberAuth` 两个 ADMIN 测试用户
// 在 beforeAll 全局 grant biz-admin,业务断言零修改;
// 细粒度判权矩阵另见 certificates-rbac-boundary.e2e-spec.ts。

const LOCK_OBSERVE_TIMEOUT_MS = 4_000;
const HTTP_TIMEOUT_MS = 8_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const BLOCKER_TIMEOUT_MS = 20_000;

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function settleAllWithTimeout(promises: Promise<unknown>[], label: string): Promise<void> {
  const results = await withTimeout(Promise.allSettled(promises), label, CLEANUP_TIMEOUT_MS);
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (rejected) throw rejected.reason;
}

function preservePrimaryFailure(primary: unknown, cleanup: unknown): void {
  if (primary instanceof Error) {
    Object.defineProperty(primary, 'cause', { value: cleanup, configurable: true });
  }
}

function throwFailure(failure: unknown): never {
  if (failure instanceof Error) throw failure;
  throw new Error('non-Error test failure', { cause: failure });
}

describe('certificates 模块', () => {
  let app: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;
  let prismaB: PrismaService;
  let superAdminAuth: string;
  let adminAuth: string;
  let userAuth: string;
  let adminWithMemberAuth: string;

  let memberA: string; // 主用 member
  let memberB: string; // 跨 member 测试
  let adminMemberId: string; // ADMIN 绑定的 member,用于测 verifiedBy=memberId 路径
  let activeCertTypeCode: string;
  let primaryStandardId: string;
  let primaryPolicyId: string;
  let secondStandardId: string;
  let draftStandardId: string;
  let secondActiveCertTypeCode: string; // 用于 supersededBy / 多类型测试

  beforeAll(async () => {
    app = await createTestApp();
    appB = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    prismaB = appB.get(PrismaService);

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
      data: { memberNo: 'cert-m-a', ...memberIdentityData('Member A') },
      select: { id: true },
    });
    memberA = a.id;
    const b = await prisma.member.create({
      data: { memberNo: 'cert-m-b', ...memberIdentityData('Member B') },
      select: { id: true },
    });
    memberB = b.id;
    const admMember = await prisma.member.create({
      data: { memberNo: 'cert-m-adm', ...memberIdentityData('Admin Member') },
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
    // PR-4a-3:INACTIVE cert_type 不再参与建证入参校验(字典校验移到建 Standard 时),
    // 但 qualification-flag 的 category 判据仍走 cert_type 字典,该 fixture 行仍需存在 ——
    // 只是不再需要把 code 存进变量。
    void certTypeInactive;

    // cert_sub_type 字典
    const certSubTypeDict = await prisma.dictType.create({
      data: { code: 'cert_sub_type', label: '证书等级' },
      select: { id: true },
    });
    const subTypeActive = await prisma.dictItem.create({
      data: { typeId: certSubTypeDict.id, code: 'first_aid_basic', label: '救护员基础' },
      select: { code: true },
    });
    // PR-4a-3:certSubTypeCode 已从建证入参移除(等级是 Standard 的属性),
    // 该字典项 fixture 仍建 —— 它是 cert_sub_type 字典存在性的前置,但不再需要变量。
    void subTypeActive;

    // 证书标准库 PR-4a-3:建证入参从「字典 code」改为「Standard id」。
    // 两个 ACTIVE CREDENTIAL Standard(对应两个 ACTIVE cert_type),各带一条
    // 最宽松的 ACTIVE Policy(FREE_TEXT / EXPLICIT_OPTIONAL / OPTIONAL)——
    // 本 spec 锁的是 Certificate 实例的生命周期与判权,认定规则的各种组合
    // 由 certificate-standards.e2e-spec 覆盖,这里不重复。
    for (const [key, categoryCode] of [
      ['primary', activeCertTypeCode],
      ['second', secondActiveCertTypeCode],
    ] as const) {
      const std = await prisma.certificateStandard.create({
        data: {
          code: `cert-e2e-std-${key}`,
          name: `${categoryCode} 标准`,
          kind: 'CREDENTIAL',
          status: 'ACTIVE',
          categoryCode,
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
      if (key === 'primary') {
        primaryStandardId = std.id;
        primaryPolicyId = pol.id;
      } else secondStandardId = std.id;
    }
    // 一个 DRAFT Standard:用于「未启用标准不可建证」这一格。
    draftStandardId = (
      await prisma.certificateStandard.create({
        data: {
          code: 'cert-e2e-std-draft',
          name: '草稿标准',
          kind: 'CREDENTIAL',
          status: 'DRAFT',
          categoryCode: activeCertTypeCode,
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await settleAllWithTimeout([app.close(), appB.close()], 'certificate app shutdown');
  });

  const baseCreatePayload = (override: Record<string, unknown> = {}): Record<string, unknown> => ({
    // PR-4a-3:standardId 取代 certTypeCode;issuingOrg 仍传(默认规则是 FREE_TEXT)。
    standardId: primaryStandardId,
    issuingOrg: '演示颁发机构 A',
    // 冻结稿 §10.2:证书日期入参收紧为纯 YYYY-MM-DD(不再接受 ISO datetime)。
    issuedAt: '2024-01-01',
    ...override,
  });

  async function waitForCertificateWaiter(
    directBlockerPid: number,
    operation: Promise<request.Response>,
    excludedPids: number[] = [],
  ): Promise<{ pid: number; databaseName: string; blockingPids: number[] }> {
    let settled = false;
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const deadline = Date.now() + LOCK_OBSERVE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (settled) throw new Error('certificate operation settled before expected lock wait');
      const rows = await withTimeout(
        prismaB.$queryRaw<Array<{ pid: number; databaseName: string; blockingPids: number[] }>>(
          Prisma.sql`
            SELECT pid, datname AS "databaseName", pg_blocking_pids(pid) AS "blockingPids"
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND CAST(${directBlockerPid} AS integer) = ANY(pg_blocking_pids(pid))
              AND query LIKE '%FROM "Certificate"%FOR NO KEY UPDATE%'
              AND NOT (pid = ANY(${excludedPids}::integer[]))
            LIMIT 1
          `,
        ),
        'certificate lock observer query',
        LOCK_OBSERVE_TIMEOUT_MS,
      );
      if (rows[0]) return rows[0];
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`certificate direct waiter missing blocker=${directBlockerPid}`);
  }

  async function runCertificateLinearization(
    firstAction: 'verify' | 'reject',
    secondAction: 'verify' | 'reject',
  ): Promise<void> {
    const created = await request(httpServer(app))
      .post(`/api/admin/v1/members/${memberA}/certificates`)
      .set('Authorization', adminAuth)
      .send(baseCreatePayload({ certNumber: `LINEAR-${firstAction}-${Date.now()}` }))
      .expect(201);
    const certificateId = created.body.data.id as string;
    const poolIds = await Promise.all(
      [prisma, prismaB].map(async (client) => {
        const rows = await client.$queryRaw<
          Array<{ pid: number; databaseName: string }>
        >(Prisma.sql`
          SELECT pg_backend_pid() AS pid, current_database() AS "databaseName"
        `);
        return rows[0];
      }),
    );
    expect(poolIds[0].databaseName).toBe(poolIds[1].databaseName);
    expect(poolIds[0].pid).not.toBe(poolIds[1].pid);

    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    let root!: { pid: number; databaseName: string };
    let reached!: () => void;
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const blocker = prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ pid: number; databaseName: string }>>(Prisma.sql`
          SELECT pg_backend_pid() AS pid, current_database() AS "databaseName"
          FROM "Certificate"
          WHERE "id" = ${certificateId}
          FOR UPDATE
        `);
        root = rows[0];
        reached();
        await releasePromise;
      },
      { timeout: BLOCKER_TIMEOUT_MS },
    );
    const invoke = (targetApp: INestApplication, action: 'verify' | 'reject') =>
      Promise.resolve(
        request(httpServer(targetApp))
          .patch(`/api/admin/v1/members/${memberA}/certificates/${certificateId}/${action}`)
          .set('Authorization', adminWithMemberAuth)
          .send({ verifyNote: `linear ${action}` })
          .timeout({ deadline: HTTP_TIMEOUT_MS }),
      );
    let first: Promise<request.Response> | undefined;
    let second: Promise<request.Response> | undefined;
    let primaryFailure: unknown;
    let cleanupFailure: unknown;
    try {
      await withTimeout(reachedPromise, 'certificate root blocker', BLOCKER_TIMEOUT_MS);
      first = invoke(app, firstAction);
      const firstWaiter = await waitForCertificateWaiter(root.pid, first);
      expect(firstWaiter.databaseName).toBe(root.databaseName);
      expect(firstWaiter.blockingPids).toContain(root.pid);
      second = invoke(appB, secondAction);
      const secondWaiter = await waitForCertificateWaiter(firstWaiter.pid, second, [root.pid]);
      expect(secondWaiter.pid).not.toBe(firstWaiter.pid);
      expect(secondWaiter.databaseName).toBe(root.databaseName);
      expect(secondWaiter.blockingPids).toContain(firstWaiter.pid);

      release();
      const [winner, loser] = await withTimeout(
        Promise.all([first, second]),
        'certificate competing reviews',
        HTTP_TIMEOUT_MS,
      );
      expect(winner.status).toBe(200);
      expectBizError(loser, BizCode.CERTIFICATE_INVALID_STATE_TRANSITION);
      expect(JSON.stringify(loser.body)).not.toContain('40P01');
      expect(
        await prisma.certificate.findUniqueOrThrow({
          where: { id: certificateId },
          select: { certStatusCode: true },
        }),
      ).toEqual({ certStatusCode: firstAction === 'verify' ? 'verified' : 'rejected' });
      const audits = await prisma.auditLog.findMany({
        where: { resourceId: certificateId },
        select: { event: true },
      });
      expect(audits).toHaveLength(2);
      expect(audits.filter(({ event }) => event === `certificate.${firstAction}`)).toHaveLength(1);
      expect(audits.filter(({ event }) => event === `certificate.${secondAction}`)).toHaveLength(0);
    } catch (error) {
      primaryFailure = error;
    } finally {
      release();
      try {
        await settleAllWithTimeout(
          [blocker, ...(first ? [first] : []), ...(second ? [second] : [])],
          'certificate linearization cleanup',
        );
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
      }
    }
    if (primaryFailure !== undefined) {
      if (cleanupFailure !== undefined) preservePrimaryFailure(primaryFailure, cleanupFailure);
      throwFailure(primaryFailure);
    }
    if (cleanupFailure !== undefined) throwFailure(cleanupFailure);
  }

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
        .query({ criterionType: 'category', criterionCode: activeCertTypeCode })
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

    it('ADMIN 创建仅必填 → 201,status=pending,不返 deletedAt / attachmentKey', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload());
      expect(res.status).toBe(201);
      expect(res.body.code).toBe(0);
      expect(res.body.data.memberId).toBe(memberA);
      expect(res.body.data.certStatusCode).toBe('pending');
      // PR-4b:certTypeCode / certSubTypeCode / isInternal 已从出参移除(列已 DROP)。
      // 反向断言 —— 它们一旦重现就说明有人又在实例侧复制了 Standard 的属性。
      expect(res.body.data).not.toHaveProperty('certTypeCode');
      expect(res.body.data).not.toHaveProperty('certSubTypeCode');
      expect(res.body.data).not.toHaveProperty('isInternal');
      expect(res.body.data.standardId).toBe(primaryStandardId);
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

    it('SUPER_ADMIN 创建完整字段 → 201;standardId/policyId/sourceCode 落库', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', superAdminAuth)
        .send({
          standardId: primaryStandardId,
          issuingOrg: '演示颁发机构 B',
          certNumber: 'DEMO-CERT-002',
          issuedAt: '2023-06-01',
          expiredAt: '2102-06-01',
        });
      expect(res.status).toBe(201);
      expect(res.body.data.certNumberFull).toBe('DEMO-CERT-002');
      expect(res.body.data.expiredAt).toBe('2102-06-01T00:00:00.000Z');
      // §9.1 步骤 7:标准化四列进出参。
      expect(res.body.data.standardId).toBe(primaryStandardId);
      expect(res.body.data.recognitionPolicyId).toEqual(expect.any(String));
      expect(res.body.data.sourceCode).toBe('ADMIN');
      // FREE_TEXT 规则 → issuerId 为 null,机构名是自由文本。
      expect(res.body.data.recognitionIssuerId).toBeNull();
      // PR-4b:三个实例侧副本已 DROP 且从出参移除。反向断言它们不再出现 ——
      // 4a-3 时这里断言的是「仍在但恒 null」,4b 后必须翻成「彻底不在」。
      expect(res.body.data).not.toHaveProperty('certTypeCode');
      expect(res.body.data).not.toHaveProperty('certSubTypeCode');
      expect(res.body.data).not.toHaveProperty('isInternal');
    });

    // PR-4a-3:入参不再有两个字典 code,原三格「字典 code 不存在 / INACTIVE /
    // 子类型不存在」换成 Standard 维度的等价三格。字典校验本身没有消失 ——
    // 它移到了 Standard 建标准时(PR-3 的管理面),建证时不再重复猜。
    it('standardId 不存在 → CERTIFICATE_STANDARD_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ standardId: 'no-such-standard' }));
      expectBizError(res, BizCode.CERTIFICATE_STANDARD_NOT_FOUND);
    });

    it('standardId 未启用(DRAFT)→ CERTIFICATE_STANDARD_INACTIVE', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ standardId: draftStandardId }));
      expectBizError(res, BizCode.CERTIFICATE_STANDARD_INACTIVE);
    });

    it('FREE_TEXT 规则下不传 issuingOrg → CERTIFICATE_ISSUER_CONFIG_INVALID', async () => {
      const payload = baseCreatePayload();
      delete payload.issuingOrg;
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(payload);
      expectBizError(res, BizCode.CERTIFICATE_ISSUER_CONFIG_INVALID);
    });

    it('缺 standardId → 400', async () => {
      const payload = baseCreatePayload();
      delete payload.standardId;
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

  // ============ 证书标准库 PR-1 · 冻结稿 §10.2 / §10.3 日期契约 ============
  //
  // §10.2 日期只收纯 `YYYY-MM-DD`;§10.3 issuedAt <= today 且
  // (expiredAt IS NULL OR expiredAt >= issuedAt)。前者是 DTO 形状(400 通用校验),
  // 后者是业务语义(18018 / 18017)。
  describe('日期语义契约(§10.2 形状 + §10.3 业务)', () => {
    const dayOffsetFromToday = (days: number): string => {
      // 按北京日历日偏移,与后端 date-only 口径同源(避免用机器本地时区推日期)。
      const beijingNow = new Date(Date.now() + 8 * 3_600_000);
      beijingNow.setUTCDate(beijingNow.getUTCDate() + days);
      return beijingNow.toISOString().slice(0, 10);
    };

    it('§10.2 issuedAt 带时分秒 ISO datetime → 400(不再接受)', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ issuedAt: '2024-01-01T00:00:00.000Z' }));
      expect(res.status).toBe(400);
    });

    it('§10.2 issuedAt 带时区偏移 → 400(时区曾能悄悄改天)', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ issuedAt: '2024-01-01T00:00:00+08:00' }));
      expect(res.status).toBe(400);
    });

    it('§10.2 expiredAt 带时分秒 → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ expiredAt: '2102-06-01T00:00:00.000Z' }));
      expect(res.status).toBe(400);
    });

    it('§10.2 形状合法但日历不存在(2026-02-30)→ 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ issuedAt: '2026-02-30' }));
      expect(res.status).toBe(400);
    });

    it('§10.3 issuedAt = 明天 → 18018 CERTIFICATE_ISSUED_AT_IN_FUTURE', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ issuedAt: dayOffsetFromToday(1) }));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(18018);
    });

    it('§10.3 issuedAt = 今天 → 201(边界含当天)', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ issuedAt: dayOffsetFromToday(0) }));
      expect(res.status).toBe(201);
    });

    it('§10.3 expiredAt 早于 issuedAt → 18017 CERTIFICATE_DATE_RANGE_INVALID', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ issuedAt: '2024-01-01', expiredAt: '2023-12-31' }));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(18017);
    });

    it('§10.3 expiredAt = issuedAt → 201(当天发证当天到期仍有效一天)', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ issuedAt: '2024-01-01', expiredAt: '2024-01-01' }));
      expect(res.status).toBe(201);
    });

    it('§10.3 PATCH 只改 expiredAt 也与库内 issuedAt 比较 → 18017', async () => {
      const created = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ issuedAt: '2024-06-01' }));
      expect(created.status).toBe(201);

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${created.body.data.id}`)
        .set('Authorization', adminAuth)
        .send({ expiredAt: '2024-05-31' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(18017);
    });

    it('§9.2 PATCH 改 expiredAt → 清空 expireNotifyDueAt(重置到期提醒水印)', async () => {
      const created = await request(httpServer(app))
        .post(`/api/admin/v1/members/${memberA}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ issuedAt: '2024-06-01', expiredAt: '2102-06-01' }));
      expect(created.status).toBe(201);
      const certId = created.body.data.id as string;

      // 直接置一个已提醒水印,模拟 cron 已发过提醒。
      await prisma.certificate.update({
        where: { id: certId },
        data: { expireNotifyDueAt: new Date('2026-01-01T00:00:00.000Z') },
      });

      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${certId}`)
        .set('Authorization', adminAuth)
        .send({ expiredAt: '2103-06-01' });
      expect(res.status).toBe(200);

      const row = await prisma.certificate.findUniqueOrThrow({ where: { id: certId } });
      expect(row.expireNotifyDueAt).toBeNull();
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
      expect(res.body.data.certNumberFull).toBe('DETAIL-CERT-001');
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
      expect(res.body.data.certNumberFull).toBe('PATCH-001-UPDATED');
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
          issuedAt: '2024-03-01',
          expiredAt: '2101-03-01',
        });
      expect(res.status).toBe(200);
      expect(res.body.data.issuedAt).toBe('2024-03-01T00:00:00.000Z');
      expect(res.body.data.expiredAt).toBe('2101-03-01T00:00:00.000Z');
    });

    it('PATCH standardId 指向不存在的标准 → CERTIFICATE_STANDARD_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberA}/certificates/${certIdA}`)
        .set('Authorization', adminAuth)
        .send({ standardId: 'no-such-standard' });
      expectBizError(res, BizCode.CERTIFICATE_STANDARD_NOT_FOUND);
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
      expect(JSON.stringify(loser!.body)).not.toContain('40P01');
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
        .send({ issuedAt: '2025-01-01' });
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
        .send(baseCreatePayload({ certNumber: 'RESUB-C1', standardId: secondStandardId }));
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
        .send(baseCreatePayload({ certNumber: 'RESUB-C2', standardId: secondStandardId }));
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
        data: { memberNo: 'cert-m-qf', ...memberIdentityData('QF Member') },
        select: { id: true },
      });
      qfMember = m.id;
    });

    it('member 不存在 → MEMBER_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/members/cl0000000000000000000000/certificates/qualification-flag')
        .query({ criterionType: 'category', criterionCode: activeCertTypeCode })
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('判据 query 缺失 → 400(criterionType / criterionCode 都必填)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${qfMember}/certificates/qualification-flag`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(400);
    });

    it('category 判据 code 不在字典 → CERTIFICATE_TYPE_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${qfMember}/certificates/qualification-flag`)
        .query({ criterionType: 'category', criterionCode: 'no-such-type' })
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.CERTIFICATE_TYPE_CODE_INVALID);
    });

    it('无证书 → qualified=false', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${qfMember}/certificates/qualification-flag`)
        .query({ criterionType: 'category', criterionCode: activeCertTypeCode })
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        memberId: qfMember,
        criterionType: 'category',
        criterionCode: activeCertTypeCode,
        qualified: false,
        matchedCertificateId: null,
        expiredAt: null,
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
        .query({ criterionType: 'category', criterionCode: activeCertTypeCode })
        .set('Authorization', adminAuth);
      expect(res.body.data.qualified).toBe(true);
    });

    it('verified + 未来 expiry → qualified=true', async () => {
      // 创建独立 member 隔离
      const m = await prisma.member.create({
        data: { memberNo: 'cert-m-qf-fe', ...memberIdentityData('QF FE') },
        select: { id: true },
      });
      const r = await request(httpServer(app))
        .post(`/api/admin/v1/members/${m.id}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload({ expiredAt: '2099-01-01' }));
      await request(httpServer(app))
        .patch(`/api/admin/v1/members/${m.id}/certificates/${r.body.data.id}/verify`)
        .set('Authorization', adminAuth)
        .send({});

      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${m.id}/certificates/qualification-flag`)
        .query({ criterionType: 'category', criterionCode: activeCertTypeCode })
        .set('Authorization', adminAuth);
      expect(res.body.data.qualified).toBe(true);
    });

    it('verified + 已过期 → qualified=false', async () => {
      const m = await prisma.member.create({
        data: { memberNo: 'cert-m-qf-pe', ...memberIdentityData('QF PE') },
        select: { id: true },
      });
      // 直接在 DB 创建已过期 + verified 记录,绕过状态机限制
      await prisma.certificate.create({
        data: {
          memberId: m.id,
          // PR-4b:类别经 Standard;三列 NOT NULL 由主标准夹具给齐。
          standardId: primaryStandardId,
          recognitionPolicyId: primaryPolicyId,
          sourceCode: 'ADMIN',
          issuingOrg: 'Demo Past',
          issuedAt: new Date('2010-01-01T00:00:00.000Z'),
          expiredAt: new Date('2015-01-01T00:00:00.000Z'),
          certStatusCode: 'verified',
        },
      });

      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${m.id}/certificates/qualification-flag`)
        .query({ criterionType: 'category', criterionCode: activeCertTypeCode })
        .set('Authorization', adminAuth);
      expect(res.body.data.qualified).toBe(false);
    });

    it('pending only → qualified=false', async () => {
      const m = await prisma.member.create({
        data: { memberNo: 'cert-m-qf-pd', ...memberIdentityData('QF PD') },
        select: { id: true },
      });
      await request(httpServer(app))
        .post(`/api/admin/v1/members/${m.id}/certificates`)
        .set('Authorization', adminAuth)
        .send(baseCreatePayload());

      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${m.id}/certificates/qualification-flag`)
        .query({ criterionType: 'category', criterionCode: activeCertTypeCode })
        .set('Authorization', adminAuth);
      expect(res.body.data.qualified).toBe(false);
    });

    it('rejected only → qualified=false', async () => {
      const m = await prisma.member.create({
        data: { memberNo: 'cert-m-qf-rj', ...memberIdentityData('QF RJ') },
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
        .query({ criterionType: 'category', criterionCode: activeCertTypeCode })
        .set('Authorization', adminAuth);
      expect(res.body.data.qualified).toBe(false);
    });

    it('verified 但已软删 → qualified=false', async () => {
      const m = await prisma.member.create({
        data: { memberNo: 'cert-m-qf-sd', ...memberIdentityData('QF SD') },
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
        .query({ criterionType: 'category', criterionCode: activeCertTypeCode })
        .set('Authorization', adminAuth);
      expect(res.body.data.qualified).toBe(false);
    });

    it('响应恰好 5 字段(§12:两级判据回显 + 布尔 + 命中证书 + 到期日)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${qfMember}/certificates/qualification-flag`)
        .query({ criterionType: 'category', criterionCode: activeCertTypeCode })
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      const dataKeys = Object.keys(res.body.data as Record<string, unknown>).sort();
      expect(dataKeys).toEqual([
        'criterionCode',
        'criterionType',
        'expiredAt',
        'matchedCertificateId',
        'memberId',
        'qualified',
      ]);
    });

    // ===== 评审 findings F4(§12):standard 级判据 + 四级稳定排序 =====
    //
    // 修复前整节 §12 未实现:query 只收 `certTypeCode`(等价于 category 一级),
    // 出参只有三字段,全仓搜 `criterion` 零命中。

    /** 直插一张 verified 证书(绕状态机,用于精确摆布排序输入)。 */
    async function seedVerifiedCert(
      memberIdArg: string,
      opts: {
        issuedAt: string;
        expiredAt: string | null;
        standardId?: string;
        policyId?: string;
      },
    ): Promise<string> {
      const row = await prisma.certificate.create({
        data: {
          memberId: memberIdArg,
          // 复合 FK `(recognitionPolicyId, standardId)`:Policy 必须属于该 Standard。
          // 传自定义 standardId 时必须一并传它自己的 policyId,否则撞外键。
          standardId: opts.standardId ?? primaryStandardId,
          recognitionPolicyId: opts.policyId ?? primaryPolicyId,
          sourceCode: 'ADMIN',
          issuingOrg: 'QF Ordering',
          issuedAt: new Date(`${opts.issuedAt}T00:00:00.000Z`),
          expiredAt: opts.expiredAt ? new Date(`${opts.expiredAt}T00:00:00.000Z`) : null,
          certStatusCode: 'verified',
        },
        select: { id: true },
      });
      return row.id;
    }

    function qualify(memberIdArg: string, criterionType: string, criterionCode: string) {
      return request(httpServer(app))
        .get(`/api/admin/v1/members/${memberIdArg}/certificates/qualification-flag`)
        .query({ criterionType, criterionCode })
        .set('Authorization', adminAuth);
    }

    it('standard 级判据:按 Standard.code 匹配(不是 cuid —— §12 明令不用跨环境不稳定的 id)', async () => {
      const m = await prisma.member.create({
        data: { memberNo: 'cert-m-qf-std', ...memberIdentityData('QF Std') },
        select: { id: true },
      });
      const certId = await seedVerifiedCert(m.id, {
        issuedAt: '2026-01-01',
        expiredAt: '2099-01-01',
      });

      const res = await qualify(m.id, 'standard', 'cert-e2e-std-primary');
      expect(res.status).toBe(200);
      expect(res.body.data.qualified).toBe(true);
      expect(res.body.data.matchedCertificateId).toBe(certId);
      expect(res.body.data.criterionType).toBe('standard');

      // 反向:另一个标准的 code 不该命中同一张证书。
      const other = await qualify(m.id, 'standard', 'cert-e2e-std-second');
      expect(other.body.data.qualified).toBe(false);
      expect(other.body.data.matchedCertificateId).toBeNull();
    });

    it('standard 级判据:code 不存在 → CERTIFICATE_STANDARD_NOT_FOUND(不静默返 false)', async () => {
      // 拼错的 code 与「确实没有这张证」是两件事,而后者会被调用方
      // (岗位资格 / 活动门槛)当成「这个人不合格」写进业务结论。
      expectBizError(
        await qualify(qfMember, 'standard', 'no-such-standard-code'),
        BizCode.CERTIFICATE_STANDARD_NOT_FOUND,
      );
    });

    it('criterionType 只接受 category | standard(闭集)', async () => {
      expect((await qualify(qfMember, 'issuer', 'whatever')).status).toBe(400);
    });

    it('§12 四级稳定排序:永久有效优先 > expiredAt 较晚 > issuedAt 较晚 > id 字典序', async () => {
      const m = await prisma.member.create({
        data: { memberNo: 'cert-m-qf-order', ...memberIdentityData('QF Order') },
        select: { id: true },
      });
      // 三张都有效,但只有一张是永久有效 —— 它必须赢,哪怕另外两张发证更晚。
      await seedVerifiedCert(m.id, { issuedAt: '2026-06-01', expiredAt: '2099-01-01' });
      await seedVerifiedCert(m.id, { issuedAt: '2026-07-01', expiredAt: '2098-01-01' });
      const permanent = await seedVerifiedCert(m.id, { issuedAt: '2020-01-01', expiredAt: null });

      const res = await qualify(m.id, 'category', activeCertTypeCode);
      expect(res.body.data.matchedCertificateId).toBe(permanent);
      expect(res.body.data.expiredAt).toBeNull();
    });

    it('§12 排序第二级:都不是永久有效 → expiredAt 较晚的那张胜出', async () => {
      const m = await prisma.member.create({
        data: { memberNo: 'cert-m-qf-order2', ...memberIdentityData('QF Order2') },
        select: { id: true },
      });
      await seedVerifiedCert(m.id, { issuedAt: '2026-07-01', expiredAt: '2098-01-01' });
      const later = await seedVerifiedCert(m.id, {
        issuedAt: '2026-01-01',
        expiredAt: '2099-01-01',
      });

      const res = await qualify(m.id, 'category', activeCertTypeCode);
      // 注意 issuedAt 更早的那张赢了 —— 证明第二级(到期日)确实排在第三级之前。
      expect(res.body.data.matchedCertificateId).toBe(later);
      expect(res.body.data.expiredAt).toBe('2099-01-01T00:00:00.000Z');
    });

    it('§12 排序第四级:前三级全并列 → id 字典序最小的那张(结果必须完全确定)', async () => {
      const m = await prisma.member.create({
        data: { memberNo: 'cert-m-qf-order4', ...memberIdentityData('QF Order4') },
        select: { id: true },
      });
      const ids = [
        await seedVerifiedCert(m.id, { issuedAt: '2026-01-01', expiredAt: '2099-01-01' }),
        await seedVerifiedCert(m.id, { issuedAt: '2026-01-01', expiredAt: '2099-01-01' }),
        await seedVerifiedCert(m.id, { issuedAt: '2026-01-01', expiredAt: '2099-01-01' }),
      ];
      const smallest = [...ids].sort()[0];

      // 连查三次:少了 id 兜底,选中哪张取决于物理行序,同一次查询在不同时刻可能不同。
      for (let i = 0; i < 3; i++) {
        const res = await qualify(m.id, 'category', activeCertTypeCode);
        expect(res.body.data.matchedCertificateId).toBe(smallest);
      }
    });

    it('§12 历史证书不要求 Standard 当前 ACTIVE —— 停用标准不追溯作废存量持证人', async () => {
      const m = await prisma.member.create({
        data: { memberNo: 'cert-m-qf-inactive', ...memberIdentityData('QF Inactive') },
        select: { id: true },
      });
      const std = await prisma.certificateStandard.create({
        data: {
          code: 'cert-e2e-std-retired',
          name: '已停用标准',
          kind: 'CREDENTIAL',
          status: 'ACTIVE',
          categoryCode: activeCertTypeCode,
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
      const certId = await seedVerifiedCert(m.id, {
        issuedAt: '2026-01-01',
        expiredAt: '2099-01-01',
        standardId: std.id,
        policyId: pol.id,
      });
      // 事后停用该标准(「不再新发」),存量证书不受影响。
      await prisma.certificateStandard.update({
        where: { id: std.id },
        data: { status: 'INACTIVE' },
      });

      const res = await qualify(m.id, 'standard', 'cert-e2e-std-retired');
      expect(res.body.data.qualified).toBe(true);
      expect(res.body.data.matchedCertificateId).toBe(certId);
    });
  });

  describe('PostgreSQL certificate direct/soft blocker chain', () => {
    it('verify-first:root → verify waiter → reject soft waiter', async () => {
      await runCertificateLinearization('verify', 'reject');
    });

    it('reject-first:root → reject waiter → verify soft waiter', async () => {
      await runCertificateLinearization('reject', 'verify');
    });
  });
});
