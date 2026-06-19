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

// 招新三期(入队:志愿者→队员)T2 admin 面 e2e(冻结评审稿 docs/archive/reviews/recruitment-phase3-review.md §7)。
// 覆盖:入队轮 CRUD + 至多一个 open / RBAC 边界 / 标 gate 全链 + 自动推进 / 贡献值两路 + 过滤 /
// gate 有效期(本轮/years/延长期)/ 综合评估两路 + 状态机各分支 / 详情 gate 实况 + 贡献值 / audit。
// admin = SUPER_ADMIN(rbac.can 短路通过);USER 验 RBAC 边界。T2 无 app 自助 create/一键入队,
// 入队申请由 fixture 直建。

const ADMIN_CYCLES = '/api/admin/v1/team-join/cycles';
const ADMIN_APPS = '/api/admin/v1/team-join/applications';

const CYCLE_YEAR = 2026;
// cutoff = 2026-04-01 00:00 +08:00 = 2026-03-31 16:00 UTC。before/after 用于贡献值窗口测试。
const BEFORE_CUTOFF = new Date('2026-01-15T00:00:00Z');
const AFTER_CUTOFF = new Date('2026-06-01T00:00:00Z');

const GENERAL_GATES = [
  'fitness',
  'first-aid-training',
  'military',
  'psych',
  'interview',
  'dept-assessment',
  'entry-exam',
  'intermediate-outdoor',
];

describe('招新三期(入队)admin 面 e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAuth: string; // SUPER_ADMIN(rbac.can 短路)
  let userAuth: string; // 普通 USER(RBAC 边界)
  let adminUserId: string; // attendance sheet submitterUserId
  let memberSeq = 0;

  function markGate(
    appId: string,
    gateCode: string,
    over: { passed?: boolean; completionDate?: string; extendedUntil?: string } = {},
    auth = adminAuth,
  ): request.Test {
    return request(httpServer(app))
      .patch(`${ADMIN_APPS}/${appId}/gates`)
      .set('Authorization', auth)
      .send({
        gateCode,
        passed: over.passed ?? true,
        completionDate: over.completionDate ?? new Date().toISOString(),
        ...(over.extendedUntil ? { extendedUntil: over.extendedUntil } : {}),
      });
  }

  function evaluate(
    appId: string,
    approved: boolean,
    over: { note?: string; evaluationExtendedUntil?: string } = {},
  ): request.Test {
    return request(httpServer(app))
      .post(`${ADMIN_APPS}/${appId}/evaluate`)
      .set('Authorization', adminAuth)
      .send({ approved, ...over });
  }

  async function createMember(): Promise<string> {
    memberSeq += 1;
    const m = await prisma.member.create({
      data: {
        memberNo: `TJ${String(memberSeq).padStart(3, '0')}`,
        displayName: '志愿者',
        status: 'ACTIVE',
      },
    });
    return m.id;
  }

  async function openCycle(): Promise<string> {
    const c = await prisma.teamJoinCycle.create({
      data: { year: CYCLE_YEAR, name: '2026 年度入队', statusCode: 'open', openedAt: new Date() },
    });
    return c.id;
  }

  async function createApplication(
    cycleId: string,
    memberId: string,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const a = await prisma.teamJoinApplication.create({
      data: { cycleId, memberId, statusCode: 'joining', targetOrganizationIds: [], ...over },
    });
    return a.id;
  }

  // 给 member 加一条贡献值(建 org+activity+sheet+record);默认 approved sheet + before-cutoff。
  async function addContribution(
    memberId: string,
    points: string,
    opts: { checkInAt?: Date; sheetStatus?: string } = {},
  ): Promise<void> {
    const org = await prisma.organization.create({
      data: { name: '考勤测试部门', nodeTypeCode: 'demo-node-type-1' },
    });
    const activity = await prisma.activity.create({
      data: {
        title: '考勤测试活动',
        activityTypeCode: 'demo-act',
        organizationId: org.id,
        startAt: BEFORE_CUTOFF,
        endAt: BEFORE_CUTOFF,
        location: '深圳',
        statusCode: 'completed',
      },
    });
    const sheet = await prisma.attendanceSheet.create({
      data: {
        activityId: activity.id,
        submitterUserId: adminUserId,
        statusCode: opts.sheetStatus ?? 'approved',
      },
    });
    await prisma.attendanceRecord.create({
      data: {
        sheetId: sheet.id,
        memberId,
        roleCode: 'member',
        checkInAt: opts.checkInAt ?? BEFORE_CUTOFF,
        checkOutAt: new Date((opts.checkInAt ?? BEFORE_CUTOFF).getTime() + 4 * 3600_000),
        serviceHours: '4.00',
        attendanceStatusCode: 'present',
        contributionPoints: points,
      },
    });
  }

  // 标全 8 通用 gate 通过(完成日 = now,均满足);返回最后一次(已断言 200)响应。
  async function markAllGeneralPassed(appId: string): Promise<request.Response> {
    let last!: request.Response;
    for (const g of GENERAL_GATES) {
      last = await markGate(appId, g).expect(200);
    }
    return last;
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);
    await createTestUser(app, { username: 'tj_admin', role: Role.SUPER_ADMIN });
    adminAuth = (await loginAs(app, 'tj_admin')).authHeader;
    await createTestUser(app, { username: 'tj_user', role: Role.USER });
    userAuth = (await loginAs(app, 'tj_user')).authHeader;
    const adminUser = await prisma.user.findFirst({
      where: { username: 'tj_admin' },
      select: { id: true },
    });
    adminUserId = adminUser!.id;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.attendanceRecord.deleteMany({});
    await prisma.attendanceSheet.deleteMany({});
    await prisma.activity.deleteMany({});
    await prisma.teamJoinApplication.deleteMany({});
    await prisma.teamJoinCycle.deleteMany({});
    await prisma.organization.deleteMany({});
    await prisma.member.deleteMany({});
    await prisma.auditLog.deleteMany({
      where: { resourceType: { in: ['team_join_cycle', 'team_join_application'] } },
    });
  });

  // ===== 入队轮 CRUD + 至多一个 open =====
  it('① 入队轮 create(closed)→ PATCH open → detail open;第二个轮开 open → BAD_REQUEST', async () => {
    const created = await request(httpServer(app))
      .post(ADMIN_CYCLES)
      .set('Authorization', adminAuth)
      .send({ year: CYCLE_YEAR, name: '2026 年度入队' })
      .expect(201);
    expect(created.body.data.statusCode).toBe('closed');
    const id = created.body.data.id as string;

    const opened = await request(httpServer(app))
      .patch(`${ADMIN_CYCLES}/${id}`)
      .set('Authorization', adminAuth)
      .send({ statusCode: 'open' })
      .expect(200);
    expect(opened.body.data.statusCode).toBe('open');
    expect(opened.body.data.openedAt).not.toBeNull();

    const detail = await request(httpServer(app))
      .get(`${ADMIN_CYCLES}/${id}`)
      .set('Authorization', adminAuth)
      .expect(200);
    expect(detail.body.data.statusCode).toBe('open');

    // 第二个轮开 open → 至多一个 open 守
    const c2 = await request(httpServer(app))
      .post(ADMIN_CYCLES)
      .set('Authorization', adminAuth)
      .send({ year: 2027, name: '2027 年度入队' })
      .expect(201);
    const res = await request(httpServer(app))
      .patch(`${ADMIN_CYCLES}/${c2.body.data.id}`)
      .set('Authorization', adminAuth)
      .send({ statusCode: 'open' });
    expectBizError(res, BizCode.BAD_REQUEST);
  });

  it('② 入队轮详情不存在 → TEAM_JOIN_CYCLE_NOT_FOUND', async () => {
    const res = await request(httpServer(app))
      .get(`${ADMIN_CYCLES}/nonexistent-id`)
      .set('Authorization', adminAuth);
    expectBizError(res, BizCode.TEAM_JOIN_CYCLE_NOT_FOUND);
  });

  // ===== RBAC 边界 =====
  it('③ 普通 USER 标 gate → RBAC_FORBIDDEN', async () => {
    const cycleId = await openCycle();
    const memberId = await createMember();
    const appId = await createApplication(cycleId, memberId);
    const res = markGate(appId, 'fitness', {}, userAuth);
    expectBizError(await res, BizCode.RBAC_FORBIDDEN);
  });

  // ===== 标 gate 全链 + 自动推进 =====
  it('④ 8 通用 gate 全过 + 贡献值≥5 → 自动推进 pending_evaluation', async () => {
    const cycleId = await openCycle();
    const memberId = await createMember();
    await addContribution(memberId, '5.00'); // 恰好 ≥5
    const appId = await createApplication(cycleId, memberId);

    // 前 7 个不足以推进
    for (const g of GENERAL_GATES.slice(0, 7)) {
      const r = await markGate(appId, g).expect(200);
      expect(r.body.data.statusCode).toBe('joining');
    }
    // 第 8 个 + 贡献值齐 → 推进
    const last = await markGate(appId, GENERAL_GATES[7]).expect(200);
    expect(last.body.data.statusCode).toBe('pending_evaluation');
    expect(last.body.data.generalGatesSatisfied).toBe(true);
    expect(last.body.data.contributionSatisfied).toBe(true);
    expect(last.body.data.contributionPoints).toBe('5');
  });

  it('⑤ 8 通用全过但贡献值 <5 → 仍 joining(不推进)', async () => {
    const cycleId = await openCycle();
    const memberId = await createMember();
    await addContribution(memberId, '4.00'); // <5
    const appId = await createApplication(cycleId, memberId);
    const res = await markAllGeneralPassed(appId);
    expect(res.body.data.generalGatesSatisfied).toBe(true);
    expect(res.body.data.contributionSatisfied).toBe(false);
    expect(res.body.data.statusCode).toBe('joining');
  });

  it('⑥ 贡献值仅算 approved sheet + before-cutoff(after-cutoff/非 approved 不计)', async () => {
    const cycleId = await openCycle();
    const memberId = await createMember();
    await addContribution(memberId, '3.00'); // approved + before cutoff → 计
    await addContribution(memberId, '10.00', { checkInAt: AFTER_CUTOFF }); // after cutoff → 不计
    await addContribution(memberId, '10.00', { sheetStatus: 'pending' }); // 非 approved → 不计
    const appId = await createApplication(cycleId, memberId);
    const res = await markAllGeneralPassed(appId);
    const body = res.body.data;
    expect(body.contributionPoints).toBe('3'); // 仅 approved+before-cutoff 的 3
    expect(body.contributionSatisfied).toBe(false);
    expect(body.statusCode).toBe('joining');
  });

  // ===== gate 有效期 =====
  it('⑦ 本轮 gate 完成日早于 cycle.openedAt → 不满足(需重做)', async () => {
    const cycleId = await openCycle();
    const memberId = await createMember();
    await addContribution(memberId, '5.00');
    const appId = await createApplication(cycleId, memberId);
    // fitness(本轮)完成日 = 昨天(早于今天开的轮)→ 不满足
    const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString();
    await markGate(appId, 'fitness', { completionDate: yesterday }).expect(200);
    for (const g of GENERAL_GATES.slice(1)) await markGate(appId, g).expect(200);
    const detail = await request(httpServer(app))
      .get(`${ADMIN_APPS}/${appId}`)
      .set('Authorization', adminAuth)
      .expect(200);
    const fitness = detail.body.data.gates.find((x: { code: string }) => x.code === 'fitness');
    expect(fitness.satisfied).toBe(false);
    expect(detail.body.data.generalGatesSatisfied).toBe(false);
    expect(detail.body.data.statusCode).toBe('joining');
  });

  it('⑧ years gate 过期(military 2年,完成日 3 年前)→ 不满足', async () => {
    const cycleId = await openCycle();
    const memberId = await createMember();
    await addContribution(memberId, '5.00');
    const appId = await createApplication(cycleId, memberId);
    const threeYearsAgo = new Date(Date.now() - 3 * 365 * 24 * 3600_000).toISOString();
    await markGate(appId, 'military', { completionDate: threeYearsAgo }).expect(200);
    for (const g of GENERAL_GATES.filter((g) => g !== 'military'))
      await markGate(appId, g).expect(200);
    const detail = await request(httpServer(app))
      .get(`${ADMIN_APPS}/${appId}`)
      .set('Authorization', adminAuth)
      .expect(200);
    const mil = detail.body.data.gates.find((x: { code: string }) => x.code === 'military');
    expect(mil.satisfied).toBe(false);
    expect(detail.body.data.statusCode).toBe('joining');
  });

  it('⑨ dept-assessment 延长期(完成日早于本轮但 extendedUntil 未到)→ 满足', async () => {
    const cycleId = await openCycle();
    const memberId = await createMember();
    await addContribution(memberId, '5.00');
    const appId = await createApplication(cycleId, memberId);
    const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString();
    const nextYear = new Date(Date.now() + 365 * 24 * 3600_000).toISOString();
    // dept-assessment 完成日昨天(本轮规则会失效)+ extendedUntil 明年 → 延长期认
    await markGate(appId, 'dept-assessment', {
      completionDate: yesterday,
      extendedUntil: nextYear,
    }).expect(200);
    for (const g of GENERAL_GATES.filter((g) => g !== 'dept-assessment')) {
      await markGate(appId, g).expect(200);
    }
    const last = await request(httpServer(app))
      .get(`${ADMIN_APPS}/${appId}`)
      .set('Authorization', adminAuth)
      .expect(200);
    const da = last.body.data.gates.find((x: { code: string }) => x.code === 'dept-assessment');
    expect(da.satisfied).toBe(true);
    expect(da.extendedUntil).not.toBeNull();
    expect(last.body.data.generalGatesSatisfied).toBe(true);
    expect(last.body.data.statusCode).toBe('pending_evaluation');
  });

  it('⑩ 标 gate 幂等 + 清除回退(passed=false 使其不满足 → pending_evaluation 回退 joining)', async () => {
    const cycleId = await openCycle();
    const memberId = await createMember();
    await addContribution(memberId, '5.00');
    const appId = await createApplication(cycleId, memberId);
    await markAllGeneralPassed(appId);
    // 已 pending_evaluation;把 fitness 改 passed=false → 回退 joining
    const back = await markGate(appId, 'fitness', { passed: false }).expect(200);
    expect(back.body.data.statusCode).toBe('joining');
    // 再标回 passed=true → 重新推进
    const fwd = await markGate(appId, 'fitness', { passed: true }).expect(200);
    expect(fwd.body.data.statusCode).toBe('pending_evaluation');
  });

  // ===== 综合评估两路 + 状态机 =====
  it('⑪ pending_evaluation + approved → approved 待入队', async () => {
    const cycleId = await openCycle();
    const memberId = await createMember();
    await addContribution(memberId, '5.00');
    const appId = await createApplication(cycleId, memberId);
    await markAllGeneralPassed(appId);
    const res = await evaluate(appId, true, { note: '综合表现良好' }).expect(200);
    expect(res.body.data.statusCode).toBe('approved');
    expect(res.body.data.evaluationNote).toBe('综合表现良好');
    expect(res.body.data.evaluatedAt).not.toBeNull();
  });

  it('⑫ pending_evaluation + !approved → rejected(eliminationStage=evaluation)', async () => {
    const cycleId = await openCycle();
    const memberId = await createMember();
    await addContribution(memberId, '5.00');
    const appId = await createApplication(cycleId, memberId);
    await markAllGeneralPassed(appId);
    const res = await evaluate(appId, false).expect(200);
    expect(res.body.data.statusCode).toBe('rejected');
    expect(res.body.data.eliminationStage).toBe('evaluation');
  });

  it('⑬ joining + approved → WRONG_STATE(门槛未齐);joining + !approved → rejected(gate-timeout)', async () => {
    const cycleId = await openCycle();
    const memberId = await createMember();
    const appId = await createApplication(cycleId, memberId);
    expectBizError(await evaluate(appId, true), BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
    const res = await evaluate(appId, false).expect(200);
    expect(res.body.data.statusCode).toBe('rejected');
    expect(res.body.data.eliminationStage).toBe('gate-timeout');
  });

  it('⑭ 终态(rejected)再标 gate / 再评估 → WRONG_STATE', async () => {
    const cycleId = await openCycle();
    const memberId = await createMember();
    const appId = await createApplication(cycleId, memberId, { statusCode: 'rejected' });
    expectBizError(await markGate(appId, 'fitness'), BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
    expectBizError(await evaluate(appId, true), BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
  });

  // ===== 详情 / 列表 / audit =====
  it('⑮ 详情含 12 gate 实况 + 实时贡献值;列表贡献值为 null', async () => {
    const cycleId = await openCycle();
    const memberId = await createMember();
    await addContribution(memberId, '7.50');
    const appId = await createApplication(cycleId, memberId, {
      targetOrganizationIds: ['org-a', 'org-b'],
    });
    const detail = await request(httpServer(app))
      .get(`${ADMIN_APPS}/${appId}`)
      .set('Authorization', adminAuth)
      .expect(200);
    expect(detail.body.data.gates).toHaveLength(12); // 8 通用 + 4 专业队
    expect(
      detail.body.data.gates.filter((g: { professional: boolean }) => g.professional),
    ).toHaveLength(4);
    expect(detail.body.data.contributionPoints).toBe('7.5');
    expect(detail.body.data.contributionSatisfied).toBe(true);
    expect(detail.body.data.targetOrganizationIds).toEqual(['org-a', 'org-b']);

    const list = await request(httpServer(app))
      .get(`${ADMIN_APPS}?cycleId=${cycleId}`)
      .set('Authorization', adminAuth)
      .expect(200);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0].contributionPoints).toBeNull(); // 列表不算贡献值
  });

  it('⑯ audit:cycle.create / cycle.update / mark-gate / evaluate 各写一条', async () => {
    const cycleId = await openCycle();
    const memberId = await createMember();
    await addContribution(memberId, '5.00');
    const appId = await createApplication(cycleId, memberId);
    // create + update 各一条(轮次)
    const c = await request(httpServer(app))
      .post(ADMIN_CYCLES)
      .set('Authorization', adminAuth)
      .send({ year: 2028, name: '2028' })
      .expect(201);
    await request(httpServer(app))
      .patch(`${ADMIN_CYCLES}/${c.body.data.id}`)
      .set('Authorization', adminAuth)
      .send({ name: '2028 改名' })
      .expect(200);
    await markGate(appId, 'fitness').expect(200);
    await markAllGeneralPassed(appId);
    await evaluate(appId, true).expect(200);

    const events = await prisma.auditLog.groupBy({
      by: ['event'],
      where: { event: { startsWith: 'team-join' } },
      _count: { event: true },
    });
    const byEvent = Object.fromEntries(events.map((e) => [e.event, e._count.event]));
    expect(byEvent['team-join-cycle.create']).toBeGreaterThanOrEqual(1);
    expect(byEvent['team-join-cycle.update']).toBeGreaterThanOrEqual(1);
    expect(byEvent['team-join-application.mark-gate']).toBeGreaterThanOrEqual(1);
    expect(byEvent['team-join-application.evaluate']).toBeGreaterThanOrEqual(1);
  });
});
