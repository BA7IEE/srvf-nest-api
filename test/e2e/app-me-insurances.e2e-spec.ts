import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 保险模块 T2 App /api/app/v1/me/insurances 自助 CRUD e2e(2026-06-13)。
// 沿冻结评审稿 docs/archive/reviews/insurance-module-review.md §8 测试计划:
//   - 自助 CRUD 全链(create / list 分页 / update / softDelete)
//   - **self-scope 防越权(防 IDOR)**:B 改 / 删 A 的记录 → 26001 不泄露存在性(E-14);
//     无 member 用户 → 40300;member INACTIVE / 软删 → 40300;未登录 → 40100
//   - 26010 日期跨字段校验(create + update 终态)
//   - 软删后 list 不可见;再操作同 id → 26001
//   - audit:member-insurance.{create,update,delete}.self 落 audit_logs(评审稿 §3.5)
//   - App 字段集恰好 6 项,不返 memberId / deletedAt / updatedAt(字段集纪律)

interface ResBody {
  code: number;
  message: string;
  data: Record<string, unknown>;
}

// AppMyInsuranceDto 恰好 6 项(评审稿 §3.2 端点 1-4;不含 memberId)
const APP_INSURANCE_KEYS = [
  'coverageEnd',
  'coverageStart',
  'createdAt',
  'id',
  'insurerName',
  'policyNumber',
].sort();

const FORBIDDEN_KEYS = ['memberId', 'deletedAt', 'updatedAt', 'member'];

describe('App /api/app/v1/me/insurances(保险 T2 自助 CRUD)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let seq = 0;
  const nextSeq = (): string => `${++seq}-${Math.random().toString(36).slice(2, 6)}`;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  // ============== helpers ==============

  async function setupLinkedUser(opts: {
    username: string;
    role?: Role;
    memberStatus?: MemberStatus;
    memberDeleted?: boolean;
  }): Promise<{ userId: string; memberId: string; authHeader: string }> {
    const user = await createTestUser(app, {
      username: opts.username,
      role: opts.role ?? Role.USER,
    });
    const member = await prisma.member.create({
      data: {
        memberNo: `INS-${nextSeq()}`,
        displayName: 'Ins Tester',
        status: opts.memberStatus ?? MemberStatus.ACTIVE,
        deletedAt: opts.memberDeleted === true ? new Date() : null,
      },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    const { authHeader } = await loginAs(app, opts.username);
    return { userId: user.id, memberId: member.id, authHeader };
  }

  function createInsurance(authHeader: string, body: Record<string, unknown>): request.Test {
    return request(httpServer(app))
      .post('/api/app/v1/me/insurances')
      .set('Authorization', authHeader)
      .send(body);
  }

  const validBody = (): Record<string, unknown> => ({
    insurerName: '平安保险',
    policyNumber: `PN-${nextSeq()}`,
    coverageStart: '2026-01-01',
    coverageEnd: '2026-12-31',
  });

  // ============== 准入与防越权 ==============

  it('未登录 → 40100', async () => {
    const res = await request(httpServer(app)).get('/api/app/v1/me/insurances');
    expectBizError(res, BizCode.UNAUTHORIZED);
  });

  it('无 member 关联用户 → 40300(GET 与 POST 一致)', async () => {
    await createTestUser(app, { username: 'ins-unlinked', role: Role.USER });
    const { authHeader } = await loginAs(app, 'ins-unlinked');

    const resGet = await request(httpServer(app))
      .get('/api/app/v1/me/insurances')
      .set('Authorization', authHeader);
    expectBizError(resGet, BizCode.FORBIDDEN);

    const resPost = await createInsurance(authHeader, validBody());
    expectBizError(resPost, BizCode.FORBIDDEN);
  });

  it('member INACTIVE → 40300;member 软删 → 40300(canUseApp 准入)', async () => {
    const inactive = await setupLinkedUser({
      username: 'ins-inactive',
      memberStatus: MemberStatus.INACTIVE,
    });
    const resInactive = await request(httpServer(app))
      .get('/api/app/v1/me/insurances')
      .set('Authorization', inactive.authHeader);
    expectBizError(resInactive, BizCode.FORBIDDEN);

    const deleted = await setupLinkedUser({ username: 'ins-deleted', memberDeleted: true });
    const resDeleted = await request(httpServer(app))
      .get('/api/app/v1/me/insurances')
      .set('Authorization', deleted.authHeader);
    expectBizError(resDeleted, BizCode.FORBIDDEN);
  });

  it('防 IDOR:B 改 / 删 A 的记录 → 26001(不泄露存在性);A 自己仍可改', async () => {
    const a = await setupLinkedUser({ username: 'ins-owner-a' });
    const b = await setupLinkedUser({ username: 'ins-attacker-b' });

    const created = await createInsurance(a.authHeader, validBody()).expect(201);
    const insuranceId = (created.body as ResBody).data.id as string;

    const resPatch = await request(httpServer(app))
      .patch(`/api/app/v1/me/insurances/${insuranceId}`)
      .set('Authorization', b.authHeader)
      .send({ insurerName: 'hacked' });
    expectBizError(resPatch, BizCode.MEMBER_INSURANCE_NOT_FOUND);

    const resDelete = await request(httpServer(app))
      .delete(`/api/app/v1/me/insurances/${insuranceId}`)
      .set('Authorization', b.authHeader);
    expectBizError(resDelete, BizCode.MEMBER_INSURANCE_NOT_FOUND);

    // 记录未被破坏,A 本人仍可正常更新
    const resOwner = await request(httpServer(app))
      .patch(`/api/app/v1/me/insurances/${insuranceId}`)
      .set('Authorization', a.authHeader)
      .send({ insurerName: '人保财险' })
      .expect(200);
    expect((resOwner.body as ResBody).data.insurerName).toBe('人保财险');
  });

  // ============== create ==============

  it('create 成功:字段集恰好 6 项,无 memberId 等禁返字段;audit create.self 落库', async () => {
    const me = await setupLinkedUser({ username: 'ins-create-ok' });
    const res = await createInsurance(me.authHeader, validBody()).expect(201);
    const body = res.body as ResBody;
    expect(body.code).toBe(0);
    expect(Object.keys(body.data).sort()).toEqual(APP_INSURANCE_KEYS);
    for (const k of FORBIDDEN_KEYS) {
      expect(body.data).not.toHaveProperty(k);
    }

    const audit = await prisma.auditLog.findFirst({
      where: { event: 'member-insurance.create.self', resourceId: body.data.id as string },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorUserId).toBe(me.userId);
    expect(audit!.resourceType).toBe('member-insurance');
    const ctx = audit!.context as { extra?: { memberId?: string } };
    expect(ctx.extra?.memberId).toBe(me.memberId);
  });

  it('create 不带 coverageStart → 成功且 coverageStart=null(起保可选)', async () => {
    const me = await setupLinkedUser({ username: 'ins-create-nostart' });
    const body = validBody();
    delete body.coverageStart;
    const res = await createInsurance(me.authHeader, body).expect(201);
    expect((res.body as ResBody).data.coverageStart).toBeNull();
  });

  it('create coverageStart > coverageEnd → 26010', async () => {
    const me = await setupLinkedUser({ username: 'ins-create-baddate' });
    const res = await createInsurance(me.authHeader, {
      ...validBody(),
      coverageStart: '2027-01-01',
      coverageEnd: '2026-12-31',
    });
    expectBizError(res, BizCode.INSURANCE_COVERAGE_DATE_RANGE_INVALID);
  });

  it('create 夹带 memberId → 400(DTO 白名单 + forbidNonWhitelisted)', async () => {
    const me = await setupLinkedUser({ username: 'ins-create-whitelist' });
    const res = await createInsurance(me.authHeader, {
      ...validBody(),
      memberId: 'someone-else',
    });
    // BAD_REQUEST 透传 ValidationPipe 字段细节,跳过严格 message 断言(helper 既有口径)
    expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    expect(String(res.body.message)).toContain('memberId');
  });

  // ============== list ==============

  it('list 仅本人 + 分页;他人记录不可见(self-scope)', async () => {
    const a = await setupLinkedUser({ username: 'ins-list-a' });
    const b = await setupLinkedUser({ username: 'ins-list-b' });

    await createInsurance(a.authHeader, validBody()).expect(201);
    await createInsurance(a.authHeader, validBody()).expect(201);
    await createInsurance(b.authHeader, validBody()).expect(201);

    const res = await request(httpServer(app))
      .get('/api/app/v1/me/insurances?page=1&pageSize=1')
      .set('Authorization', a.authHeader)
      .expect(200);
    const data = (res.body as ResBody).data as unknown as {
      items: Array<Record<string, unknown>>;
      total: number;
      page: number;
      pageSize: number;
    };
    expect(data.total).toBe(2); // 仅 A 的两条;B 的不计入
    expect(data.items).toHaveLength(1); // pageSize=1 分页生效
    expect(data.page).toBe(1);
    expect(Object.keys(data.items[0]).sort()).toEqual(APP_INSURANCE_KEYS);
  });

  // ============== update ==============

  it('update 本人成功(audit update.self 含 before/after);终态 start > end → 26010', async () => {
    const me = await setupLinkedUser({ username: 'ins-update-ok' });
    const created = await createInsurance(me.authHeader, validBody()).expect(201);
    const id = (created.body as ResBody).data.id as string;

    const res = await request(httpServer(app))
      .patch(`/api/app/v1/me/insurances/${id}`)
      .set('Authorization', me.authHeader)
      .send({ coverageEnd: '2027-06-30' })
      .expect(200);
    expect(String((res.body as ResBody).data.coverageEnd)).toContain('2027-06-30');

    const audit = await prisma.auditLog.findFirst({
      where: { event: 'member-insurance.update.self', resourceId: id },
    });
    expect(audit).not.toBeNull();
    const ctx = audit!.context as {
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
    };
    expect(String(ctx.before?.coverageEnd)).toContain('2026-12-31');
    expect(String(ctx.after?.coverageEnd)).toContain('2027-06-30');

    // 只改 coverageStart 也不能造成终态 start > end
    const bad = await request(httpServer(app))
      .patch(`/api/app/v1/me/insurances/${id}`)
      .set('Authorization', me.authHeader)
      .send({ coverageStart: '2027-12-31' });
    expectBizError(bad, BizCode.INSURANCE_COVERAGE_DATE_RANGE_INVALID);
  });

  // ============== softDelete ==============

  it('delete 本人成功(audit delete.self);软删后 list 不可见,再操作同 id → 26001', async () => {
    const me = await setupLinkedUser({ username: 'ins-delete-ok' });
    const created = await createInsurance(me.authHeader, validBody()).expect(201);
    const id = (created.body as ResBody).data.id as string;

    await request(httpServer(app))
      .delete(`/api/app/v1/me/insurances/${id}`)
      .set('Authorization', me.authHeader)
      .expect(200);

    const audit = await prisma.auditLog.findFirst({
      where: { event: 'member-insurance.delete.self', resourceId: id },
    });
    expect(audit).not.toBeNull();

    // DB 软删而非物理删
    const row = await prisma.memberInsurance.findUnique({ where: { id } });
    expect(row).not.toBeNull();
    expect(row!.deletedAt).not.toBeNull();

    const list = await request(httpServer(app))
      .get('/api/app/v1/me/insurances')
      .set('Authorization', me.authHeader)
      .expect(200);
    const data = (list.body as ResBody).data as unknown as { total: number };
    expect(data.total).toBe(0);

    const again = await request(httpServer(app))
      .delete(`/api/app/v1/me/insurances/${id}`)
      .set('Authorization', me.authHeader);
    expectBizError(again, BizCode.MEMBER_INSURANCE_NOT_FOUND);
  });

  // ============== admin-as-member(linked-member self perspective)==============

  it('ADMIN 兼队员走本人视角(可建可查自己的;不因角色扩大可见范围)', async () => {
    const adminMe = await setupLinkedUser({ username: 'ins-admin-linked', role: Role.ADMIN });
    const other = await setupLinkedUser({ username: 'ins-admin-other' });
    await createInsurance(other.authHeader, validBody()).expect(201);

    await createInsurance(adminMe.authHeader, validBody()).expect(201);
    const res = await request(httpServer(app))
      .get('/api/app/v1/me/insurances')
      .set('Authorization', adminMe.authHeader)
      .expect(200);
    const data = (res.body as ResBody).data as unknown as { total: number };
    expect(data.total).toBe(1); // 仅自己的一条;other 的不可见(无 role 短路)
  });
});
