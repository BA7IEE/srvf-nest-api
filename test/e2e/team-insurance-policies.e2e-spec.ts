import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role } from '@prisma/client';
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

// 保险模块 T2 admin/v1/team-insurance-policies + members/:memberId/insurances e2e(2026-06-13)。
// 沿冻结评审稿 docs/archive/reviews/insurance-module-review.md §8 测试计划:
//   - 保单 CRUD(create / list 分页 / findOne / update / softDelete)+ 26010 / 26002
//   - 覆盖名单:单加 / 重复 26004 / 移除 / 移除不在名单 26003 / 移除后可重新加入
//     (partial unique 复活路径)
//   - **一键加幂等**:仅 ACTIVE 未软删队员入名单;首跑 addedCount=N,二跑 =0
//   - 保单软删**不级联**覆盖行(E-4;DB 亲核 coverage.deletedAt 仍 null)
//   - RBAC 边界(沿 *-rbac-boundary 范式):未持码 ADMIN → 30100 / USER → 30100 /
//     biz-admin → 通过 / SUPER_ADMIN 短路
//   - admin 查队员自购保险(member-insurance.read.other)+ MEMBER_NOT_FOUND
//   - audit:team-insurance-policy.{create,update,delete} + team-insurance-coverage.{add,remove}

interface ResBody {
  code: number;
  message: string;
  data: Record<string, unknown>;
}

describe('Admin team-insurance-policies + member insurances(保险 T2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let saAuth: string; // SUPER_ADMIN(短路)
  let bizAdminAuth: string; // ADMIN + biz-admin(授权路径)
  let plainAdminAuth: string; // ADMIN 未持 biz-admin(30100 反向断言)
  let userAuth: string; // USER(30100)

  let seq = 0;
  const nextSeq = (): string => `${++seq}-${Math.random().toString(36).slice(2, 6)}`;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const { bizAdminRoleId } = await seedBizAdminPermissionsAndRole(app);

    await createTestUser(app, { username: 'tip-sa', role: Role.SUPER_ADMIN });
    const bizAdminUser = await createTestUser(app, { username: 'tip-bizadmin', role: Role.ADMIN });
    await grantBizAdminToUser(app, bizAdminUser.id, bizAdminRoleId);
    await createTestUser(app, { username: 'tip-plainadmin', role: Role.ADMIN });
    await createTestUser(app, { username: 'tip-user', role: Role.USER });

    saAuth = (await loginAs(app, 'tip-sa')).authHeader;
    bizAdminAuth = (await loginAs(app, 'tip-bizadmin')).authHeader;
    plainAdminAuth = (await loginAs(app, 'tip-plainadmin')).authHeader;
    userAuth = (await loginAs(app, 'tip-user')).authHeader;
  });

  afterAll(async () => {
    await app.close();
  });

  // ============== helpers ==============

  async function createMember(opts?: {
    status?: MemberStatus;
    deleted?: boolean;
  }): Promise<{ id: string; memberNo: string }> {
    return prisma.member.create({
      data: {
        memberNo: `TIP-${nextSeq()}`,
        displayName: 'Coverage Tester',
        status: opts?.status ?? MemberStatus.ACTIVE,
        deletedAt: opts?.deleted === true ? new Date() : null,
      },
      select: { id: true, memberNo: true },
    });
  }

  const validPolicy = (): Record<string, unknown> => ({
    insurerName: '太平洋保险',
    policyNumber: `TP-${nextSeq()}`,
    coverageStart: '2026-01-01',
    coverageEnd: '2026-12-31',
    note: '全年队级意外险',
  });

  async function createPolicy(auth: string = bizAdminAuth): Promise<string> {
    const res = await request(httpServer(app))
      .post('/api/admin/v1/team-insurance-policies')
      .set('Authorization', auth)
      .send(validPolicy())
      .expect(201);
    return (res.body as ResBody).data.id as string;
  }

  // ============== RBAC 边界(沿 *-rbac-boundary 范式)==============

  it('RBAC:未持码 ADMIN → 30100;USER → 30100;biz-admin → 200;SA 短路 → 200', async () => {
    const resPlain = await request(httpServer(app))
      .get('/api/admin/v1/team-insurance-policies')
      .set('Authorization', plainAdminAuth);
    expectBizError(resPlain, BizCode.RBAC_FORBIDDEN);

    const resUser = await request(httpServer(app))
      .get('/api/admin/v1/team-insurance-policies')
      .set('Authorization', userAuth);
    expectBizError(resUser, BizCode.RBAC_FORBIDDEN);

    await request(httpServer(app))
      .get('/api/admin/v1/team-insurance-policies')
      .set('Authorization', bizAdminAuth)
      .expect(200);

    await request(httpServer(app))
      .get('/api/admin/v1/team-insurance-policies')
      .set('Authorization', saAuth)
      .expect(200);
  });

  it('RBAC:写端点未持码 ADMIN → 30100(create / 单加 / 一键加 / 移除各自独立码)', async () => {
    const policyId = await createPolicy();
    const member = await createMember();

    const resCreate = await request(httpServer(app))
      .post('/api/admin/v1/team-insurance-policies')
      .set('Authorization', plainAdminAuth)
      .send(validPolicy());
    expectBizError(resCreate, BizCode.RBAC_FORBIDDEN);

    const resAdd = await request(httpServer(app))
      .post(`/api/admin/v1/team-insurance-policies/${policyId}/members`)
      .set('Authorization', plainAdminAuth)
      .send({ memberId: member.id });
    expectBizError(resAdd, BizCode.RBAC_FORBIDDEN);

    const resBulk = await request(httpServer(app))
      .post(`/api/admin/v1/team-insurance-policies/${policyId}/members/add-all-active`)
      .set('Authorization', plainAdminAuth);
    expectBizError(resBulk, BizCode.RBAC_FORBIDDEN);

    const resRemove = await request(httpServer(app))
      .delete(`/api/admin/v1/team-insurance-policies/${policyId}/members/${member.id}`)
      .set('Authorization', plainAdminAuth);
    expectBizError(resRemove, BizCode.RBAC_FORBIDDEN);
  });

  // ============== 保单 CRUD ==============

  it('create 成功(audit policy.create);start > end → 26010;findOne 不存在 → 26002', async () => {
    const res = await request(httpServer(app))
      .post('/api/admin/v1/team-insurance-policies')
      .set('Authorization', bizAdminAuth)
      .send(validPolicy())
      .expect(201);
    const body = res.body as ResBody;
    expect(body.code).toBe(0);
    expect(body.data.insurerName).toBe('太平洋保险');

    const audit = await prisma.auditLog.findFirst({
      where: { event: 'team-insurance-policy.create', resourceId: body.data.id as string },
    });
    expect(audit).not.toBeNull();
    expect(audit!.resourceType).toBe('team-insurance-policy');

    const badDate = await request(httpServer(app))
      .post('/api/admin/v1/team-insurance-policies')
      .set('Authorization', bizAdminAuth)
      .send({ ...validPolicy(), coverageStart: '2027-01-01', coverageEnd: '2026-01-01' });
    expectBizError(badDate, BizCode.INSURANCE_COVERAGE_DATE_RANGE_INVALID);

    const notFound = await request(httpServer(app))
      .get('/api/admin/v1/team-insurance-policies/cl000000000000000nothere')
      .set('Authorization', bizAdminAuth);
    expectBizError(notFound, BizCode.TEAM_INSURANCE_POLICY_NOT_FOUND);
  });

  it('update 成功(note 空串清空;audit before/after);软删后 findOne → 26002', async () => {
    const policyId = await createPolicy();

    const res = await request(httpServer(app))
      .patch(`/api/admin/v1/team-insurance-policies/${policyId}`)
      .set('Authorization', bizAdminAuth)
      .send({ insurerName: '人寿保险', note: '' })
      .expect(200);
    expect((res.body as ResBody).data.insurerName).toBe('人寿保险');
    expect((res.body as ResBody).data.note).toBeNull();

    const auditUpdate = await prisma.auditLog.findFirst({
      where: { event: 'team-insurance-policy.update', resourceId: policyId },
    });
    expect(auditUpdate).not.toBeNull();
    const ctx = auditUpdate!.context as { before?: Record<string, unknown> };
    expect(ctx.before?.insurerName).toBe('太平洋保险');

    // 只改 coverageStart 也不能造成终态 start > end(终态校验)
    const badDate = await request(httpServer(app))
      .patch(`/api/admin/v1/team-insurance-policies/${policyId}`)
      .set('Authorization', bizAdminAuth)
      .send({ coverageStart: '2027-06-01' });
    expectBizError(badDate, BizCode.INSURANCE_COVERAGE_DATE_RANGE_INVALID);

    await request(httpServer(app))
      .delete(`/api/admin/v1/team-insurance-policies/${policyId}`)
      .set('Authorization', bizAdminAuth)
      .expect(200);

    const afterDelete = await request(httpServer(app))
      .get(`/api/admin/v1/team-insurance-policies/${policyId}`)
      .set('Authorization', bizAdminAuth);
    expectBizError(afterDelete, BizCode.TEAM_INSURANCE_POLICY_NOT_FOUND);

    const auditDelete = await prisma.auditLog.findFirst({
      where: { event: 'team-insurance-policy.delete', resourceId: policyId },
    });
    expect(auditDelete).not.toBeNull();
  });

  // ============== 覆盖名单:单加 / 重复 / 移除 / 复活 ==============

  it('单加成功(名单含队员摘要;audit add mode=single);重复 → 26004;不存在 member → 15001', async () => {
    const policyId = await createPolicy();
    const member = await createMember();

    const res = await request(httpServer(app))
      .post(`/api/admin/v1/team-insurance-policies/${policyId}/members`)
      .set('Authorization', bizAdminAuth)
      .send({ memberId: member.id })
      .expect(201);
    const cov = (res.body as ResBody).data;
    expect(cov.memberId).toBe(member.id);
    expect(cov.memberNo).toBe(member.memberNo);
    expect(cov.memberDisplayName).toBe('Coverage Tester');

    const audit = await prisma.auditLog.findFirst({
      where: { event: 'team-insurance-coverage.add', resourceId: policyId },
    });
    expect(audit).not.toBeNull();
    const ctx = audit!.context as { extra?: { mode?: string; memberId?: string } };
    expect(ctx.extra?.mode).toBe('single');
    expect(ctx.extra?.memberId).toBe(member.id);

    const dup = await request(httpServer(app))
      .post(`/api/admin/v1/team-insurance-policies/${policyId}/members`)
      .set('Authorization', bizAdminAuth)
      .send({ memberId: member.id });
    expectBizError(dup, BizCode.TEAM_INSURANCE_COVERAGE_ALREADY_EXISTS);

    const ghost = await request(httpServer(app))
      .post(`/api/admin/v1/team-insurance-policies/${policyId}/members`)
      .set('Authorization', bizAdminAuth)
      .send({ memberId: 'cl000000000000000nothere' });
    expectBizError(ghost, BizCode.MEMBER_NOT_FOUND);

    // 名单列表可见
    const list = await request(httpServer(app))
      .get(`/api/admin/v1/team-insurance-policies/${policyId}/members`)
      .set('Authorization', bizAdminAuth)
      .expect(200);
    const data = (list.body as ResBody).data as unknown as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(data.total).toBe(1);
    expect(data.items[0].memberId).toBe(member.id);
  });

  it('移除成功(audit remove);再移除 → 26003;移除后可重新加入(partial unique 复活)', async () => {
    const policyId = await createPolicy();
    const member = await createMember();

    await request(httpServer(app))
      .post(`/api/admin/v1/team-insurance-policies/${policyId}/members`)
      .set('Authorization', bizAdminAuth)
      .send({ memberId: member.id })
      .expect(201);

    await request(httpServer(app))
      .delete(`/api/admin/v1/team-insurance-policies/${policyId}/members/${member.id}`)
      .set('Authorization', bizAdminAuth)
      .expect(200);

    const auditRemove = await prisma.auditLog.findFirst({
      where: { event: 'team-insurance-coverage.remove', resourceId: policyId },
    });
    expect(auditRemove).not.toBeNull();

    const again = await request(httpServer(app))
      .delete(`/api/admin/v1/team-insurance-policies/${policyId}/members/${member.id}`)
      .set('Authorization', bizAdminAuth);
    expectBizError(again, BizCode.TEAM_INSURANCE_COVERAGE_NOT_FOUND);

    // 软删后重新加入:partial unique (policyId, memberId) WHERE deletedAt IS NULL 允许
    await request(httpServer(app))
      .post(`/api/admin/v1/team-insurance-policies/${policyId}/members`)
      .set('Authorization', bizAdminAuth)
      .send({ memberId: member.id })
      .expect(201);
  });

  // ============== 一键加:幂等 + 选取边界 ==============

  it('add-all-active:仅 ACTIVE 未软删队员;已在名单跳过;二跑 addedCount=0(幂等)', async () => {
    // 隔离:本用例前清空 member 表影响面 —— 用独立保单 + 全新队员,统计只看本保单名单。
    const policyId = await createPolicy();

    const already = await createMember(); // 已在名单(单加)
    const freshA = await createMember(); // ACTIVE 未覆盖 → 应加入
    const freshB = await createMember(); // ACTIVE 未覆盖 → 应加入
    const inactive = await createMember({ status: MemberStatus.INACTIVE }); // 不入名单
    const softDeleted = await createMember({ deleted: true }); // 不入名单

    await request(httpServer(app))
      .post(`/api/admin/v1/team-insurance-policies/${policyId}/members`)
      .set('Authorization', bizAdminAuth)
      .send({ memberId: already.id })
      .expect(201);

    // 首跑:全库 ACTIVE 未软删且未覆盖的都会加入(含其它用例遗留的 ACTIVE 队员),
    // 断言聚焦集合语义:freshA/freshB 在名单,inactive/softDeleted 不在,already 不重复。
    const first = await request(httpServer(app))
      .post(`/api/admin/v1/team-insurance-policies/${policyId}/members/add-all-active`)
      .set('Authorization', bizAdminAuth)
      .expect(201);
    const firstCount = ((first.body as ResBody).data as { addedCount: number }).addedCount;
    expect(firstCount).toBeGreaterThanOrEqual(2);

    const rows = await prisma.teamInsuranceCoverage.findMany({
      where: { policyId, deletedAt: null },
      select: { memberId: true },
    });
    const coveredIds = new Set(rows.map((r) => r.memberId));
    expect(coveredIds.has(freshA.id)).toBe(true);
    expect(coveredIds.has(freshB.id)).toBe(true);
    expect(coveredIds.has(inactive.id)).toBe(false);
    expect(coveredIds.has(softDeleted.id)).toBe(false);
    // already 不重复:活跃行恰一条
    const alreadyRows = await prisma.teamInsuranceCoverage.count({
      where: { policyId, memberId: already.id, deletedAt: null },
    });
    expect(alreadyRows).toBe(1);

    // audit:mode=all-active + addedCount
    const audit = await prisma.auditLog.findFirst({
      where: { event: 'team-insurance-coverage.add', resourceId: policyId },
      orderBy: { createdAt: 'desc' },
    });
    const ctx = audit!.context as { extra?: { mode?: string; addedCount?: number } };
    expect(ctx.extra?.mode).toBe('all-active');
    expect(ctx.extra?.addedCount).toBe(firstCount);

    // 二跑:零新增(幂等证据)
    const second = await request(httpServer(app))
      .post(`/api/admin/v1/team-insurance-policies/${policyId}/members/add-all-active`)
      .set('Authorization', bizAdminAuth)
      .expect(201);
    expect(((second.body as ResBody).data as { addedCount: number }).addedCount).toBe(0);
  });

  // ============== 保单软删不级联覆盖行(E-4)==============

  it('保单软删后覆盖行 deletedAt 仍为 null(不级联;门槛查询 join 自然失效)', async () => {
    const policyId = await createPolicy();
    const member = await createMember();
    await request(httpServer(app))
      .post(`/api/admin/v1/team-insurance-policies/${policyId}/members`)
      .set('Authorization', bizAdminAuth)
      .send({ memberId: member.id })
      .expect(201);

    await request(httpServer(app))
      .delete(`/api/admin/v1/team-insurance-policies/${policyId}`)
      .set('Authorization', bizAdminAuth)
      .expect(200);

    const coverage = await prisma.teamInsuranceCoverage.findFirst({
      where: { policyId, memberId: member.id },
    });
    expect(coverage).not.toBeNull();
    expect(coverage!.deletedAt).toBeNull();
  });

  // ============== admin 查队员自购保险(member-insurance.read.other)==============

  it('admin 查队员保险:biz-admin → 数组;未持码 → 30100;member 不存在 → 15001', async () => {
    const member = await createMember();
    await prisma.memberInsurance.create({
      data: {
        memberId: member.id,
        insurerName: '平安保险',
        policyNumber: `PN-${nextSeq()}`,
        coverageEnd: new Date('2026-12-31T00:00:00.000Z'),
      },
    });
    // 软删行不可见
    await prisma.memberInsurance.create({
      data: {
        memberId: member.id,
        insurerName: '已删除的保险',
        policyNumber: `PN-${nextSeq()}`,
        coverageEnd: new Date('2026-12-31T00:00:00.000Z'),
        deletedAt: new Date(),
      },
    });

    const res = await request(httpServer(app))
      .get(`/api/admin/v1/members/${member.id}/insurances`)
      .set('Authorization', bizAdminAuth)
      .expect(200);
    const items = (res.body as ResBody).data as unknown as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].insurerName).toBe('平安保险');
    expect(items[0].memberId).toBe(member.id);

    const resPlain = await request(httpServer(app))
      .get(`/api/admin/v1/members/${member.id}/insurances`)
      .set('Authorization', plainAdminAuth);
    expectBizError(resPlain, BizCode.RBAC_FORBIDDEN);

    const ghost = await request(httpServer(app))
      .get('/api/admin/v1/members/cl000000000000000nothere/insurances')
      .set('Authorization', bizAdminAuth);
    expectBizError(ghost, BizCode.MEMBER_NOT_FOUND);
  });
});
