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

// 保险模块 T3 报名门槛 e2e(2026-06-13)。
// 沿冻结评审稿 docs/archive/reviews/insurance-module-review.md §4 / §8 goal 5 场景:
//   ① 开关关(default false)→ 不校验,无保险也报名成功(**既有 report 流零回归证据**)
//   ② 开 + 自购有效 → 通过
//   ③ 开 + 队保单覆盖 → 通过
//   ④ 开 + 无保险 → 26030
//   ⑤ 开 + 过期自购 → 26030
// 边界(E-11/E-12):
//   - coverageEnd = 活动结束日当天 → 通过(到期≥活动日期含等号,北京日粒度)
//   - coverageStart > 活动开始日 → 拒(起保校验)
//   - 队保单软删 → 拒(覆盖行不级联但 join p.deletedAt IS NULL 失效,E-4)
//   - **双路径同拦截**:admin 代报名(POST admin/v1/activities/:id/registrations)与
//     App 自助(POST app/v1/my/registrations,薄壳经 createMy)同语义(C015 无旁路)
//   - 快照:门槛只在 create 时校验;报名成功后保险删除不回溯(报名仍 pending)

interface ResBody {
  code: number;
  message: string;
  data: Record<string, unknown>;
}

// 活动期(北京时间 7/1 16:00 - 20:00;归一活动日 = 2026-07-01)
const ACT_START = new Date('2026-07-01T08:00:00.000Z');
const ACT_END = new Date('2026-07-01T12:00:00.000Z');

describe('报名保险门槛(保险 T3;requiresInsurance gate)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let adminAuth: string; // biz-admin(代报名路径)
  let activityTypeCode: string;
  let childOrgId: string;

  let seq = 0;
  const nextSeq = (): string => `${++seq}-${Math.random().toString(36).slice(2, 6)}`;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const { bizAdminRoleId } = await seedBizAdminPermissionsAndRole(app);
    const adminUser = await createTestUser(app, { username: 'gate-admin', role: Role.ADMIN });
    await grantBizAdminToUser(app, adminUser.id, bizAdminRoleId);
    adminAuth = (await loginAs(app, 'gate-admin')).authHeader;

    const nodeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({ data: { typeId: nodeDict.id, code: 'gate-root', label: '根' } });
    const rootOrg = await prisma.organization.create({
      data: { name: 'Gate Root', nodeTypeCode: 'gate-root', parentId: null },
      select: { id: true },
    });
    childOrgId = rootOrg.id;

    const actTypeDict = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: actTypeDict.id, code: 'gate-training', label: '训练' },
    });
    activityTypeCode = 'gate-training';
  });

  afterAll(async () => {
    await app.close();
  });

  // ============== helpers ==============

  async function createPublishedActivity(requiresInsurance: boolean): Promise<{ id: string }> {
    return prisma.activity.create({
      data: {
        title: `Gate ${requiresInsurance ? 'on' : 'off'} ${nextSeq()}`,
        activityTypeCode,
        organizationId: childOrgId,
        startAt: ACT_START,
        endAt: ACT_END,
        location: '梧桐山',
        capacity: 30,
        statusCode: 'published',
        publishedAt: new Date(),
        isPublicRegistration: true,
        requiresInsurance,
      },
      select: { id: true },
    });
  }

  async function setupLinkedUser(
    username: string,
  ): Promise<{ memberId: string; authHeader: string }> {
    const user = await createTestUser(app, { username, role: Role.USER });
    const member = await prisma.member.create({
      data: {
        memberNo: `GATE-${nextSeq()}`,
        displayName: 'Gate Tester',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    const { authHeader } = await loginAs(app, username);
    return { memberId: member.id, authHeader };
  }

  // 自购保险直写 DB(门槛读 DB;记录形态已由 T2 app-me-insurances spec 锁定)
  async function giveSelfInsurance(
    memberId: string,
    opts: { coverageStart?: string | null; coverageEnd: string },
  ): Promise<void> {
    await prisma.memberInsurance.create({
      data: {
        memberId,
        insurerName: '平安保险',
        policyNumber: `GATE-PN-${nextSeq()}`,
        coverageStart: opts.coverageStart ? new Date(opts.coverageStart) : null,
        coverageEnd: new Date(opts.coverageEnd),
      },
    });
  }

  async function givePolicyCoverage(
    memberId: string,
    opts: { coverageStart: string; coverageEnd: string; policyDeleted?: boolean },
  ): Promise<void> {
    const policy = await prisma.teamInsurancePolicy.create({
      data: {
        insurerName: '太平洋保险',
        policyNumber: `GATE-TP-${nextSeq()}`,
        coverageStart: new Date(opts.coverageStart),
        coverageEnd: new Date(opts.coverageEnd),
        deletedAt: opts.policyDeleted === true ? new Date() : null,
      },
      select: { id: true },
    });
    await prisma.teamInsuranceCoverage.create({
      data: { policyId: policy.id, memberId },
    });
  }

  function registerSelf(authHeader: string, activityId: string): request.Test {
    return request(httpServer(app))
      .post('/api/app/v1/my/registrations')
      .set('Authorization', authHeader)
      .send({ activityId });
  }

  function registerAdmin(activityId: string, memberId: string): request.Test {
    return request(httpServer(app))
      .post(`/api/admin/v1/activities/${activityId}/registrations`)
      .set('Authorization', adminAuth)
      .send({ memberId });
  }

  // ============== ① 开关关 → 不校验(零回归证据)==============

  it('① requiresInsurance=false(default):无任何保险也报名成功——自助 + admin 代报名双路径', async () => {
    const me = await setupLinkedUser('gate-off-self');
    const other = await setupLinkedUser('gate-off-admin');
    const act = await createPublishedActivity(false);

    const res = await registerSelf(me.authHeader, act.id).expect(201);
    expect((res.body as ResBody).data.statusCode).toBe('pending');

    const resAdmin = await registerAdmin(act.id, other.memberId).expect(201);
    expect((resAdmin.body as ResBody).data.statusCode).toBe('pending');
  });

  // ============== ② 开 + 自购有效 → 通过 ==============

  it('② 开 + 自购有效(含起保覆盖)→ 报名成功', async () => {
    const me = await setupLinkedUser('gate-self-valid');
    await giveSelfInsurance(me.memberId, {
      coverageStart: '2026-01-01',
      coverageEnd: '2026-12-31',
    });
    const act = await createPublishedActivity(true);

    const res = await registerSelf(me.authHeader, act.id).expect(201);
    expect((res.body as ResBody).data.statusCode).toBe('pending');
  });

  it('②b 自购无起保日(coverageStart=null)且到期覆盖 → 通过(起保可选不参与校验)', async () => {
    const me = await setupLinkedUser('gate-self-nostart');
    await giveSelfInsurance(me.memberId, { coverageStart: null, coverageEnd: '2026-12-31' });
    const act = await createPublishedActivity(true);
    await registerSelf(me.authHeader, act.id).expect(201);
  });

  // ============== ③ 开 + 队保单覆盖 → 通过 ==============

  it('③ 开 + 队保单覆盖名单内(保单期覆盖活动)→ 报名成功;admin 代报名同语义', async () => {
    const me = await setupLinkedUser('gate-policy-ok');
    await givePolicyCoverage(me.memberId, {
      coverageStart: '2026-01-01',
      coverageEnd: '2026-12-31',
    });
    const act = await createPublishedActivity(true);

    await registerSelf(me.authHeader, act.id).expect(201);

    // admin 代报名路径同样通过(另一活动避免重复报名约束)
    const act2 = await createPublishedActivity(true);
    await registerAdmin(act2.id, me.memberId).expect(201);
  });

  // ============== ④ 开 + 无保险 → 26030 ==============

  it('④ 开 + 无任何保险 → 26030——自助 + admin 代报名双路径同拦截,且未产生报名记录', async () => {
    const me = await setupLinkedUser('gate-none');
    const act = await createPublishedActivity(true);

    const res = await registerSelf(me.authHeader, act.id);
    expectBizError(res, BizCode.INSURANCE_REQUIRED);

    const resAdmin = await registerAdmin(act.id, me.memberId);
    expectBizError(resAdmin, BizCode.INSURANCE_REQUIRED);

    const count = await prisma.activityRegistration.count({
      where: { activityId: act.id, memberId: me.memberId },
    });
    expect(count).toBe(0); // 事务内拦截,零落库
  });

  // ============== ⑤ 开 + 过期 → 26030 ==============

  it('⑤ 开 + 自购已过期(到期 < 活动日)→ 26030;过期与无保险同码不细分', async () => {
    const me = await setupLinkedUser('gate-expired');
    await giveSelfInsurance(me.memberId, {
      coverageStart: '2026-01-01',
      coverageEnd: '2026-06-01', // 活动 2026-07-01,已过期
    });
    const act = await createPublishedActivity(true);

    const res = await registerSelf(me.authHeader, act.id);
    expectBizError(res, BizCode.INSURANCE_REQUIRED);
  });

  // ============== 边界 ==============

  it('边界:coverageEnd = 活动结束日当天 → 通过(到期≥活动日期含等号,北京日粒度)', async () => {
    const me = await setupLinkedUser('gate-boundary-eq');
    await giveSelfInsurance(me.memberId, {
      coverageStart: '2026-01-01',
      coverageEnd: '2026-07-01', // = 活动归一日
    });
    const act = await createPublishedActivity(true);
    await registerSelf(me.authHeader, act.id).expect(201);
  });

  it('边界:coverageStart > 活动开始日(起保太晚)→ 26030', async () => {
    const me = await setupLinkedUser('gate-boundary-late');
    await giveSelfInsurance(me.memberId, {
      coverageStart: '2026-07-02', // 晚于活动开始日 07-01
      coverageEnd: '2026-12-31',
    });
    const act = await createPublishedActivity(true);

    const res = await registerSelf(me.authHeader, act.id);
    expectBizError(res, BizCode.INSURANCE_REQUIRED);
  });

  it('边界:队保单已软删 → 覆盖失效 → 26030(E-4 不级联但 join 失效)', async () => {
    const me = await setupLinkedUser('gate-policy-deleted');
    await givePolicyCoverage(me.memberId, {
      coverageStart: '2026-01-01',
      coverageEnd: '2026-12-31',
      policyDeleted: true,
    });
    const act = await createPublishedActivity(true);

    const res = await registerSelf(me.authHeader, act.id);
    expectBizError(res, BizCode.INSURANCE_REQUIRED);
  });

  it('快照:报名成功后删除保险不回溯(报名仍 pending;E-12)', async () => {
    const me = await setupLinkedUser('gate-snapshot');
    await giveSelfInsurance(me.memberId, {
      coverageStart: '2026-01-01',
      coverageEnd: '2026-12-31',
    });
    const act = await createPublishedActivity(true);
    const res = await registerSelf(me.authHeader, act.id).expect(201);
    const regId = (res.body as ResBody).data.id as string;

    // 保险随后软删 → 已有报名不受影响
    await prisma.memberInsurance.updateMany({
      where: { memberId: me.memberId },
      data: { deletedAt: new Date() },
    });
    const reg = await prisma.activityRegistration.findUnique({ where: { id: regId } });
    expect(reg).not.toBeNull();
    expect(reg!.statusCode).toBe('pending');
  });
});
