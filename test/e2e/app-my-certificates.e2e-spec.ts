import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Prisma, Role, UserStatus } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// Phase 2 P2-7 App /api/app/v1/my/certificates e2e。
// 沿 docs/app-api-p2-7-my-certificates-review.md §10.2 15 类用例:
//   1. 未登录 → 401 UNAUTHORIZED
//   2. admin-without-member → 403 FORBIDDEN(**不**沿 D-P2-3-1 例外)
//   3. Member.status = INACTIVE → 403 FORBIDDEN
//   4. Member.deletedAt != null → 403 FORBIDDEN
//   5. admin-as-member 只看 linked member 自己(self perspective)
//   6. USER A 看不到 USER B 证书(scope-self)
//   7. 本人 pending / verified / expired / rejected 4 态全部可见(沿 顶层 §12.2.8)
//   8. 软删 cert(deletedAt != null)不可见(notDeletedWhere 等价)
//   9. ?certStatusCode=verified 仅返 verified;?certStatusCode=invalid → 400
//   10. ?certTypeCode 过滤 + 不存在 type → items=[] / total=0
//   11. ?memberId / ?verifiedBy / ?includeDeleted → 400 BAD_REQUEST(forbidNonWhitelisted)
//   12. 字段集白名单恰好 12;反向断言不含 memberId / verifiedBy / verifier /
//       supersededByCertId / updatedAt / deletedAt / passwordHash 等
//   13. pagination page/pageSize 边界(pageSize=101 / page=0 → 400 / page=2 翻页)
//   14. 默认 orderBy createdAt desc(seed 不同 createdAt,断言数组顺序)
//   15. legacy admin /v2/members/:memberId/certificates 8 endpoint 行为字面不变(path stability;
//       由 test/e2e/certificates.e2e-spec.ts 982 行既有覆盖 + 本 e2e 增 1 反向断言)
//
// 准入沿评审稿 §8.1 + §8.2 + D-P2-7-12 / D-P2-7-13:
//   - canUseApp=false 统一 FORBIDDEN=40300(不沿 D-P2-3-1 admin-without-member 例外)
//   - admin-as-member 走 linked-member self perspective(禁 role 短路)

interface ResBody {
  code: number;
  message: string;
  data: Record<string, unknown>;
}

// AppMyCertificateDto 字段集恰好 12 项(沿评审稿 §5.1)
const APP_MY_CERT_KEYS = [
  'id',
  'certTypeCode',
  'certSubTypeCode',
  'issuingOrg',
  'certNumber',
  'issuedAt',
  'expiredAt',
  'certStatusCode',
  'isInternal',
  'verifyNote',
  'verifiedAt',
  'createdAt',
].sort();

// 禁返字段(沿评审稿 §5.2 默认锁定 + §5.3 绝对禁止):
// memberId / verifiedBy / verifier / supersededByCertId / supersededBy / replacedCertificates /
// updatedAt / deletedAt / expireNotifyDueAt / L3 Credential / audit context / L2 Member 字段。
const FORBIDDEN_KEYS = [
  'memberId',
  'verifiedBy',
  'verifier',
  'supersededByCertId',
  'supersededBy',
  'replacedCertificates',
  'updatedAt',
  'deletedAt',
  'expireNotifyDueAt',
  // L3 Credential(永远禁返)
  'passwordHash',
  'refreshToken',
  'tokenHash',
  'accessToken',
  // audit context
  'requestId',
  'ip',
  'ua',
  'actorUserId',
  'actorRoleSnap',
  // Member 嵌套
  'member',
  'mobile',
  'documentNumber',
  'medicalNotes',
  'bloodTypeCode',
];

describe('App /api/app/v1/my/certificates (P2-7)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  // 用户 + member 矩阵
  let userAAuth: string; // USER + memberA(ACTIVE)
  let userBAuth: string; // USER + memberB(ACTIVE,他人)
  let userNoMemAuth: string; // USER + 无 member
  let userInactiveMemAuth: string; // USER + memberInactive(MemberStatus.INACTIVE)
  let userDeletedMemAuth: string; // USER + memberDeleted(deletedAt != null)
  let adminWithMemberAuth: string; // ADMIN + memberAdmin(ACTIVE)
  let adminNoMemAuth: string; // ADMIN + 无 member

  let memberAId: string;
  let memberBId: string;
  let memberInactiveId: string;
  let memberDeletedId: string;
  let memberAdminId: string;

  // memberA 名下证书 id(用于 4 态 + 软删 + 时间顺序断言)
  let certPendingId: string;
  let certVerifiedId: string;
  let certExpiredId: string;
  let certRejectedId: string;
  let certSoftDeletedId: string;
  let certVerifiedSecondTypeId: string; // 用于 certTypeCode filter

  // memberB 名下证书(scope-self 反向断言)
  let memberBCertId: string;

  // memberAdmin 名下证书(admin-as-member self perspective 验证)
  let memberAdminCertId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    // ============ Users ============
    await createTestUser(app, { username: 'p27-user-a', role: Role.USER });
    await createTestUser(app, { username: 'p27-user-b', role: Role.USER });
    await createTestUser(app, { username: 'p27-user-no-mem', role: Role.USER });
    await createTestUser(app, { username: 'p27-user-inactive-mem', role: Role.USER });
    await createTestUser(app, { username: 'p27-user-deleted-mem', role: Role.USER });
    await createTestUser(app, { username: 'p27-admin-with-mem', role: Role.ADMIN });
    await createTestUser(app, { username: 'p27-admin-no-mem', role: Role.ADMIN });

    // ============ Members ============
    const ma = await prisma.member.create({
      data: { memberNo: 'p27-m-a', displayName: 'Member A', status: MemberStatus.ACTIVE },
      select: { id: true },
    });
    memberAId = ma.id;
    const mb = await prisma.member.create({
      data: { memberNo: 'p27-m-b', displayName: 'Member B', status: MemberStatus.ACTIVE },
      select: { id: true },
    });
    memberBId = mb.id;
    const minactive = await prisma.member.create({
      data: {
        memberNo: 'p27-m-inactive',
        displayName: 'Inactive Member',
        status: MemberStatus.INACTIVE,
      },
      select: { id: true },
    });
    memberInactiveId = minactive.id;
    const mdeleted = await prisma.member.create({
      data: {
        memberNo: 'p27-m-deleted',
        displayName: 'Deleted Member',
        status: MemberStatus.ACTIVE,
        deletedAt: new Date(),
      },
      select: { id: true },
    });
    memberDeletedId = mdeleted.id;
    const madmin = await prisma.member.create({
      data: { memberNo: 'p27-m-admin', displayName: 'Admin Member', status: MemberStatus.ACTIVE },
      select: { id: true },
    });
    memberAdminId = madmin.id;

    // ============ Link users → members ============
    await prisma.user.update({
      where: { username: 'p27-user-a' },
      data: { memberId: memberAId },
    });
    await prisma.user.update({
      where: { username: 'p27-user-b' },
      data: { memberId: memberBId },
    });
    await prisma.user.update({
      where: { username: 'p27-user-inactive-mem' },
      data: { memberId: memberInactiveId },
    });
    await prisma.user.update({
      where: { username: 'p27-user-deleted-mem' },
      data: { memberId: memberDeletedId },
    });
    await prisma.user.update({
      where: { username: 'p27-admin-with-mem' },
      data: { memberId: memberAdminId },
    });

    // ============ Login ============
    userAAuth = (await loginAs(app, 'p27-user-a')).authHeader;
    userBAuth = (await loginAs(app, 'p27-user-b')).authHeader;
    userNoMemAuth = (await loginAs(app, 'p27-user-no-mem')).authHeader;
    userInactiveMemAuth = (await loginAs(app, 'p27-user-inactive-mem')).authHeader;
    userDeletedMemAuth = (await loginAs(app, 'p27-user-deleted-mem')).authHeader;
    adminWithMemberAuth = (await loginAs(app, 'p27-admin-with-mem')).authHeader;
    adminNoMemAuth = (await loginAs(app, 'p27-admin-no-mem')).authHeader;

    // ============ Certificates seed via direct DB(沿 certificates.e2e-spec.ts:891 范式;
    // 绕过 admin POST → verify / reject 状态机,直接构造 4 态 + 软删 row,e2e 关注 App 读路径)。
    // createdAt 通过 Prisma 默认 now() 自动写入;在不同时刻 create 让 desc 排序可断言。
    //
    // memberA 名下 6 张 cert(4 态 + 软删 + 第二大类):
    //   - certPending  (pending)
    //   - certVerified (verified;主大类 first_aid;最早 createdAt → desc 列表最后)
    //   - certExpired  (expired)
    //   - certRejected (rejected)
    //   - certSoftDeleted(verified + deletedAt;不应可见)
    //   - certVerifiedSecondType (verified + 第二大类 bsafe;用于 certTypeCode filter)
    // memberB 名下 1 张(scope-self 反向断言)
    // memberAdmin 名下 1 张(admin-as-member self perspective 验证)

    const baseCert = (
      override: Partial<Prisma.CertificateUncheckedCreateInput>,
    ): Prisma.CertificateUncheckedCreateInput => ({
      memberId: memberAId,
      certTypeCode: 'first_aid',
      issuingOrg: '深圳市红十字会',
      issuedAt: new Date('2024-01-01T00:00:00.000Z'),
      certStatusCode: 'pending',
      isInternal: false,
      ...override,
    });

    // createdAt order(刻意拉开 ms 间隔,desc 排序方便断言):
    //   verified < verifiedSecondType < pending < expired < rejected
    //   → desc 顺序:rejected, expired, pending, verifiedSecondType, verified
    const cv = await prisma.certificate.create({
      data: baseCert({
        certStatusCode: 'verified',
        certNumber: 'A-VERIFIED-001',
        issuedAt: new Date('2024-02-01T00:00:00.000Z'),
        verifiedAt: new Date('2024-03-01T00:00:00.000Z'),
        verifyNote: '审核通过',
        createdAt: new Date('2024-03-01T00:00:00.000Z'),
      }),
      select: { id: true },
    });
    certVerifiedId = cv.id;

    const cvSecond = await prisma.certificate.create({
      data: baseCert({
        certTypeCode: 'bsafe',
        certStatusCode: 'verified',
        certNumber: 'A-BSAFE-001',
        issuedAt: new Date('2024-04-01T00:00:00.000Z'),
        verifiedAt: new Date('2024-04-15T00:00:00.000Z'),
        verifyNote: 'BSAFE 通过',
        createdAt: new Date('2024-04-15T00:00:00.000Z'),
      }),
      select: { id: true },
    });
    certVerifiedSecondTypeId = cvSecond.id;

    const cp = await prisma.certificate.create({
      data: baseCert({
        certStatusCode: 'pending',
        createdAt: new Date('2024-05-01T00:00:00.000Z'),
      }),
      select: { id: true },
    });
    certPendingId = cp.id;

    const ce = await prisma.certificate.create({
      data: baseCert({
        certStatusCode: 'expired',
        certNumber: 'A-EXPIRED-001',
        issuedAt: new Date('2020-01-01T00:00:00.000Z'),
        expiredAt: new Date('2023-01-01T00:00:00.000Z'),
        verifiedAt: new Date('2020-02-01T00:00:00.000Z'),
        verifyNote: '已过期',
        createdAt: new Date('2024-06-01T00:00:00.000Z'),
      }),
      select: { id: true },
    });
    certExpiredId = ce.id;

    const cr = await prisma.certificate.create({
      data: baseCert({
        certStatusCode: 'rejected',
        verifiedAt: new Date('2024-07-01T00:00:00.000Z'),
        verifyNote: '证书图片不清晰',
        createdAt: new Date('2024-07-01T00:00:00.000Z'),
      }),
      select: { id: true },
    });
    certRejectedId = cr.id;

    const csd = await prisma.certificate.create({
      data: baseCert({
        certStatusCode: 'verified',
        certNumber: 'A-DELETED-001',
        verifiedAt: new Date('2024-08-01T00:00:00.000Z'),
        deletedAt: new Date('2024-08-15T00:00:00.000Z'),
        createdAt: new Date('2024-08-01T00:00:00.000Z'),
      }),
      select: { id: true },
    });
    certSoftDeletedId = csd.id;

    const cb = await prisma.certificate.create({
      data: {
        memberId: memberBId,
        certTypeCode: 'first_aid',
        issuingOrg: '深圳市红十字会',
        issuedAt: new Date('2024-01-01T00:00:00.000Z'),
        certStatusCode: 'verified',
        isInternal: false,
        certNumber: 'B-VERIFIED-001',
        verifiedAt: new Date('2024-03-01T00:00:00.000Z'),
        verifyNote: 'memberB 证书',
      },
      select: { id: true },
    });
    memberBCertId = cb.id;

    const cAdminMember = await prisma.certificate.create({
      data: {
        memberId: memberAdminId,
        certTypeCode: 'first_aid',
        issuingOrg: '深圳市红十字会',
        issuedAt: new Date('2024-01-01T00:00:00.000Z'),
        certStatusCode: 'verified',
        isInternal: true,
        certNumber: 'ADMIN-VERIFIED-001',
        verifiedAt: new Date('2024-03-01T00:00:00.000Z'),
        verifyNote: 'admin 自己的证书',
      },
      select: { id: true },
    });
    memberAdminCertId = cAdminMember.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ 1. 鉴权 ============

  it('1. 未登录 → 401 UNAUTHORIZED', async () => {
    const res = await request(httpServer(app)).get('/api/app/v1/my/certificates');
    // passport 默认行为:无 Authorization 头 → 401 Unauthorized,message 由 passport
    // 透传,因此关闭 strictMessage(沿 P2-6 用例 1)。
    expectBizError(res, BizCode.UNAUTHORIZED, { strictMessage: false });
  });

  // ============ 2-4. 准入 ============

  it('2. admin-without-member(无 memberId)→ 403 FORBIDDEN', async () => {
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .set('Authorization', adminNoMemAuth);
    expectBizError(res, BizCode.FORBIDDEN);
  });

  it('2b. USER 无 memberId → 403 FORBIDDEN', async () => {
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .set('Authorization', userNoMemAuth);
    expectBizError(res, BizCode.FORBIDDEN);
  });

  it('3. Member.status = INACTIVE → 403 FORBIDDEN', async () => {
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .set('Authorization', userInactiveMemAuth);
    expectBizError(res, BizCode.FORBIDDEN);
  });

  it('4. Member.deletedAt != null → 403 FORBIDDEN', async () => {
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .set('Authorization', userDeletedMemAuth);
    expectBizError(res, BizCode.FORBIDDEN);
  });

  // ============ 5. admin-as-member 走 linked-member self perspective ============

  it('5. admin-as-member 只看 linked member 自己的证书', async () => {
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .set('Authorization', adminWithMemberAuth);
    expect(res.status).toBe(200);
    const body = res.body as ResBody;
    const items = body.data.items as Array<{ id: string }>;
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(memberAdminCertId);
    // 反向断言:**绝不**包含 memberA / memberB 的证书
    const ids = items.map((it) => it.id);
    expect(ids).not.toContain(certVerifiedId);
    expect(ids).not.toContain(memberBCertId);
  });

  // ============ 6. scope-self(USER A 看不到 USER B)============

  it('6. USER A 看不到 USER B 的证书', async () => {
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .set('Authorization', userAAuth);
    expect(res.status).toBe(200);
    const body = res.body as ResBody;
    const items = body.data.items as Array<{ id: string }>;
    const ids = items.map((it) => it.id);
    expect(ids).not.toContain(memberBCertId);
  });

  it('6b. USER B 只看到 memberB 名下证书', async () => {
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .set('Authorization', userBAuth);
    expect(res.status).toBe(200);
    const body = res.body as ResBody;
    const items = body.data.items as Array<{ id: string }>;
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(memberBCertId);
  });

  // ============ 7. 4 态全部可见 ============

  it('7. 本人 pending / verified / expired / rejected 4 态 row 全部可见', async () => {
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .set('Authorization', userAAuth);
    expect(res.status).toBe(200);
    const body = res.body as ResBody;
    const items = body.data.items as Array<{ id: string; certStatusCode: string }>;
    const ids = items.map((it) => it.id);

    // memberA 5 张 active cert(certSoftDeleted 不算 → §8 用例验证),含 4 态
    expect(ids).toContain(certPendingId);
    expect(ids).toContain(certVerifiedId);
    expect(ids).toContain(certExpiredId);
    expect(ids).toContain(certRejectedId);
    expect(ids).toContain(certVerifiedSecondTypeId);

    // 4 态闭集断言:返回的 statusCode 集合 ⊆ { pending / verified / expired / rejected }
    const statusCodes = new Set(items.map((it) => it.certStatusCode));
    for (const sc of statusCodes) {
      expect(['pending', 'verified', 'expired', 'rejected']).toContain(sc);
    }
    // 持久态铁律:即使 expired cert 的 expiredAt < now(),certStatusCode 仍是 expired 持久值,
    // 不被 service 实时映射或改写(沿 D-P2-7-6)。
    const expiredItem = items.find((it) => it.id === certExpiredId);
    expect(expiredItem?.certStatusCode).toBe('expired');
  });

  // ============ 8. 软删 cert 不可见 ============

  it('8. 软删 cert(deletedAt != null)不可见', async () => {
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .set('Authorization', userAAuth);
    expect(res.status).toBe(200);
    const body = res.body as ResBody;
    const items = body.data.items as Array<{ id: string }>;
    const ids = items.map((it) => it.id);
    expect(ids).not.toContain(certSoftDeletedId);
    // memberA 5 张可见(4 态 + 第二大类),不含 softDeleted 6th
    expect(body.data.total).toBe(5);
  });

  // ============ 9. certStatusCode filter ============

  it('9a. ?certStatusCode=verified 仅返 verified', async () => {
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .query({ certStatusCode: 'verified' })
      .set('Authorization', userAAuth);
    expect(res.status).toBe(200);
    const body = res.body as ResBody;
    const items = body.data.items as Array<{ id: string; certStatusCode: string }>;
    expect(items.length).toBe(2); // certVerified + certVerifiedSecondType
    for (const it of items) {
      expect(it.certStatusCode).toBe('verified');
    }
    const ids = items.map((it) => it.id);
    expect(ids).toContain(certVerifiedId);
    expect(ids).toContain(certVerifiedSecondTypeId);
  });

  it('9b. ?certStatusCode=invalid → 400 BAD_REQUEST(IsIn 校验失败)', async () => {
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .query({ certStatusCode: 'invalid-status' })
      .set('Authorization', userAAuth);
    expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
  });

  // ============ 10. certTypeCode filter ============

  it('10a. ?certTypeCode=first_aid 仅返该 type', async () => {
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .query({ certTypeCode: 'first_aid' })
      .set('Authorization', userAAuth);
    expect(res.status).toBe(200);
    const body = res.body as ResBody;
    const items = body.data.items as Array<{ id: string; certTypeCode: string }>;
    for (const it of items) {
      expect(it.certTypeCode).toBe('first_aid');
    }
    // memberA 5 张 active 中 4 张 first_aid + 1 张 bsafe → first_aid 应返 4
    expect(items.length).toBe(4);
  });

  it('10b. ?certTypeCode=nonexistent → items=[] / total=0', async () => {
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .query({ certTypeCode: 'nonexistent-type' })
      .set('Authorization', userAAuth);
    expect(res.status).toBe(200);
    const body = res.body as ResBody;
    expect(body.data.items).toEqual([]);
    expect(body.data.total).toBe(0);
  });

  // ============ 11. admin-only query → forbidNonWhitelisted 400 ============

  it.each([
    { name: 'memberId', query: { memberId: 'some-id' } },
    { name: 'verifiedBy', query: { verifiedBy: 'admin-id' } },
    { name: 'includeDeleted', query: { includeDeleted: 'true' } },
    { name: 'supersededByCertId', query: { supersededByCertId: 'some-id' } },
    { name: 'sortBy', query: { sortBy: 'expiredAt' } },
    { name: 'sortOrder', query: { sortOrder: 'asc' } },
    { name: 'isInternal', query: { isInternal: 'true' } },
  ])('11. 越界 query "$name" → 400 BAD_REQUEST(forbidNonWhitelisted)', async ({ query }) => {
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .query(query)
      .set('Authorization', userAAuth);
    expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
  });

  // ============ 12. 字段集白名单恰好 12 + 反向断言 ============

  it('12a. 字段集恰好 12 + 字段名集合等于 APP_MY_CERT_KEYS', async () => {
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .set('Authorization', userAAuth);
    expect(res.status).toBe(200);
    const body = res.body as ResBody;
    const items = body.data.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      const keys = Object.keys(it).sort();
      expect(keys).toEqual(APP_MY_CERT_KEYS);
      expect(keys.length).toBe(12);
    }
  });

  it('12b. 字段反向断言:不含 memberId / verifiedBy / verifier / supersededByCertId / updatedAt / deletedAt / L3 / audit', async () => {
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .set('Authorization', userAAuth);
    expect(res.status).toBe(200);
    const body = res.body as ResBody;
    const items = body.data.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      for (const forbidden of FORBIDDEN_KEYS) {
        expect(it).not.toHaveProperty(forbidden);
      }
    }
  });

  it('12c. certNumber / verifyNote / verifiedAt 对本人完整可见(L1 over self;沿 §5.1)', async () => {
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .query({ certStatusCode: 'verified' })
      .set('Authorization', userAAuth);
    expect(res.status).toBe(200);
    const body = res.body as ResBody;
    const items = body.data.items as Array<{
      id: string;
      certNumber: string | null;
      verifyNote: string | null;
      verifiedAt: string | null;
    }>;
    const cv = items.find((it) => it.id === certVerifiedId);
    expect(cv?.certNumber).toBe('A-VERIFIED-001');
    expect(cv?.verifyNote).toBe('审核通过');
    expect(cv?.verifiedAt).not.toBeNull();
  });

  // ============ 13. pagination 边界 ============

  it('13a. 默认 page=1 / pageSize=20', async () => {
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .set('Authorization', userAAuth);
    expect(res.status).toBe(200);
    const body = res.body as ResBody;
    expect(body.data.page).toBe(1);
    expect(body.data.pageSize).toBe(20);
    expect(body.data.total).toBe(5);
  });

  it('13b. pageSize=101 → 400 BAD_REQUEST', async () => {
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .query({ pageSize: 101 })
      .set('Authorization', userAAuth);
    expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
  });

  it('13c. page=0 → 400 BAD_REQUEST', async () => {
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .query({ page: 0 })
      .set('Authorization', userAAuth);
    expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
  });

  it('13d. page=2 / pageSize=3 翻页正确(total=5;第二页应剩 2 项)', async () => {
    const res1 = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .query({ page: 1, pageSize: 3 })
      .set('Authorization', userAAuth);
    expect(res1.status).toBe(200);
    const page1 = res1.body.data.items as Array<{ id: string }>;
    expect(page1.length).toBe(3);

    const res2 = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .query({ page: 2, pageSize: 3 })
      .set('Authorization', userAAuth);
    expect(res2.status).toBe(200);
    const page2 = res2.body.data.items as Array<{ id: string }>;
    expect(page2.length).toBe(2);

    // 两页不重叠
    const ids1 = new Set(page1.map((it) => it.id));
    for (const it of page2) {
      expect(ids1.has(it.id)).toBe(false);
    }
  });

  // ============ 14. 默认排序 createdAt desc ============

  it('14. 默认 orderBy createdAt desc(memberA 5 张 active cert,顺序固定)', async () => {
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .set('Authorization', userAAuth);
    expect(res.status).toBe(200);
    const body = res.body as ResBody;
    const items = body.data.items as Array<{ id: string; createdAt: string }>;
    // seed createdAt 升序:certVerified(2024-03-01)< certVerifiedSecondType(2024-04-15)<
    //                     certPending(2024-05-01)< certExpired(2024-06-01)< certRejected(2024-07-01)
    // → desc 顺序:rejected, expired, pending, verifiedSecondType, verified
    expect(items.map((it) => it.id)).toEqual([
      certRejectedId,
      certExpiredId,
      certPendingId,
      certVerifiedSecondTypeId,
      certVerifiedId,
    ]);
    // 时间戳 desc 不变式
    for (let i = 0; i < items.length - 1; i++) {
      expect(new Date(items[i].createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(items[i + 1].createdAt).getTime(),
      );
    }
  });

  // ============ 15. legacy admin path stability ============

  it('15. 旧 admin /v2/members/:memberId/certificates 仍可被 ADMIN 访问(path stability;沿 D-P2-7-15)', async () => {
    // 反向断言:本 P2-7 PR 不破坏旧 admin path 行为。
    // 完整路径 / 字段集 / 8 endpoint 由 test/e2e/certificates.e2e-spec.ts 982 行已覆盖;
    // 本用例仅做 smoke:旧 path 仍返 200 + admin DTO 含 memberId / updatedAt
    // (沿 certificates.controller.ts:60 @ApiWrappedArrayResponse,旧 path data 是裸数组,
    // 非 PageResultDto;App DTO 字段隔离不影响 admin)。
    const res = await request(httpServer(app))
      .get(`/api/v2/members/${memberAId}/certificates`)
      .set('Authorization', adminWithMemberAuth);
    expect(res.status).toBe(200);
    const body = res.body as { code: number; message: string; data: Array<Record<string, unknown>> };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    // admin DTO 含 memberId / updatedAt(确认 App DTO 字段隔离不影响 admin)
    for (const it of body.data) {
      expect(it).toHaveProperty('memberId');
      expect(it).toHaveProperty('updatedAt');
    }
  });

  // ============ 附加:User.DISABLED → 401(沿 JwtStrategy 每请求查库)============

  it('附. User.DISABLED 时,旧 access token 调用 → 401 UNAUTHORIZED', async () => {
    // 沿 P2-6 用例 10 范式:JwtStrategy.validate 每请求查库,DISABLED 用户即时失效。
    // 把 userA 改 DISABLED → 旧 access token 调 /my/certificates → 401。
    // 恢复 ACTIVE 留作后续用例可用(本 e2e 没有后续依赖 userAAuth 的用例了)。
    await prisma.user.update({
      where: { username: 'p27-user-a' },
      data: { status: UserStatus.DISABLED },
    });
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/certificates')
      .set('Authorization', userAAuth);
    expectBizError(res, BizCode.UNAUTHORIZED, { strictMessage: false });
    // 复位,避免污染潜在并行 / 后续断言
    await prisma.user.update({
      where: { username: 'p27-user-a' },
      data: { status: UserStatus.ACTIVE },
    });
  });
});
