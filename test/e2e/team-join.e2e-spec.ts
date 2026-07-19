import type { INestApplication } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { normalizeDateOnly } from '../../src/common/datetime/date-only.util';
import { PrismaService } from '../../src/database/prisma.service';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import { InsuranceRequirementService } from '../../src/modules/insurances/insurance-requirement.service';
import { NotificationOutboxService } from '../../src/modules/notifications/notification-outbox.service';
import { NotificationOutboxWorker } from '../../src/modules/notifications/notification-outbox.worker';
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
  let appB: INestApplication;
  let prisma: PrismaService;
  let prismaB: PrismaService;
  let adminAuth: string; // SUPER_ADMIN(rbac.can 短路)
  let userAuth: string; // 普通 USER(RBAC 边界)
  let adminUserId: string; // attendance sheet submitterUserId
  let previousGate: string | undefined;
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

  async function openCycle(openedAt: Date = new Date()): Promise<string> {
    // 十项收口刀B:DB 级「至多一个 open 轮」partial unique 落地——夹具先关旧 open 再开新
    // (此前夹具可堆多个 open 轮,靠"最新创建"侥幸;现与生产语义一致)。
    await prisma.teamJoinCycle.updateMany({
      where: { statusCode: 'open' },
      data: { statusCode: 'closed', closedAt: new Date() },
    });
    const c = await prisma.teamJoinCycle.create({
      data: { year: CYCLE_YEAR, name: '2026 年度入队', statusCode: 'open', openedAt },
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

  // 直接给 member 插入若干考勤记录(同一 org/activity/sheet;默认 approved)。
  // 活动闭环硬化(2026-06-21):全局每日封顶按 checkInAt 北京日分组,故贡献值夹具需显式控制每条 checkInAt。
  async function insertContributionRecords(
    memberId: string,
    recs: Array<{ points: string; checkInAt: Date }>,
    opts: { sheetStatus?: string } = {},
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
    for (const r of recs) {
      await prisma.attendanceRecord.create({
        data: {
          sheetId: sheet.id,
          memberId,
          roleCode: 'member',
          checkInAt: r.checkInAt,
          checkOutAt: new Date(r.checkInAt.getTime() + 4 * 3600_000),
          serviceHours: '4.00',
          attendanceStatusCode: 'present',
          contributionPoints: r.points,
        },
      });
    }
  }

  // 把目标总分按「每北京日 ≤ 全局封顶 3」拆成多条(分为单位精确拆,避免浮点误差)。
  function splitAcrossDays(points: string): string[] {
    let cents = Math.round(Number(points) * 100);
    const DAILY_CAP_CENTS = 300;
    const out: string[] = [];
    while (cents > 0) {
      const take = Math.min(cents, DAILY_CAP_CENTS);
      out.push((take / 100).toFixed(2));
      cents -= take;
    }
    if (out.length === 0) out.push('0.00'); // points '0' 也至少落一条记录
    return out;
  }

  // 给 member 加贡献值,使「全局每日封顶后的汇总总分」恰为 points。
  // 活动闭环硬化(2026-06-21;上限于 v0.48.0 调整为 3):把 points 摊到多个不同北京日(每日 ≤ 3,
  // 各日不触顶 → 封顶后汇总 = points)。单条大分值已不现实(任何单北京日最多计 3);锚在
  // opts.checkInAt(默认 BEFORE_CUTOFF)往前逐日推,各条占一个独立北京日。after-cutoff / 非 approved
  // 记录由 cutoff / status 过滤排除,其日序与 before-cutoff approved 记录重叠也不进汇总。
  async function addContribution(
    memberId: string,
    points: string,
    opts: { checkInAt?: Date; sheetStatus?: string } = {},
  ): Promise<void> {
    const base = opts.checkInAt ?? BEFORE_CUTOFF;
    const recs = splitAcrossDays(points).map((p, i) => ({
      points: p,
      checkInAt: new Date(base.getTime() - i * 86_400_000),
    }));
    await insertContributionRecords(
      memberId,
      recs,
      opts.sheetStatus !== undefined ? { sheetStatus: opts.sheetStatus } : {},
    );
  }

  // 标全 8 通用 gate 通过(完成日 = now,均满足);返回最后一次(已断言 200)响应。
  async function markAllGeneralPassed(appId: string): Promise<request.Response> {
    let last!: request.Response;
    for (const g of GENERAL_GATES) {
      last = await markGate(appId, g).expect(200);
    }
    return last;
  }

  let t4OrgSeq = 0;
  async function makeOrg(
    nodeTypeCode = 'demo-node-type-1',
    status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE',
  ): Promise<string> {
    t4OrgSeq += 1;
    const org = await prisma.organization.create({
      data: { name: `部门${t4OrgSeq}`, nodeTypeCode, status },
    });
    return org.id;
  }

  function joinVia(
    targetApp: INestApplication,
    appId: string,
    organizationId: string,
    auth = adminAuth,
  ): request.Test {
    return request(httpServer(targetApp))
      .post(`${ADMIN_APPS}/${appId}/join`)
      .set('Authorization', auth)
      .send({ organizationId });
  }

  function join(appId: string, organizationId: string, auth = adminAuth): request.Test {
    return joinVia(app, appId, organizationId, auth);
  }

  async function waitForBlockedQuery(blockerPid: number, queryPattern: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const rows = await prisma.$queryRaw<Array<{ pid: number }>>(Prisma.sql`
        SELECT pid
        FROM pg_stat_activity
        WHERE CAST(${blockerPid} AS integer) = ANY(pg_blocking_pids(pid))
          AND query LIKE ${queryPattern}
      `);
      if (rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`未观察到 PostgreSQL blocked query: ${queryPattern}`);
  }

  async function readBackendIdentity(client: PrismaService): Promise<{
    pid: number;
    databaseName: string;
  }> {
    const rows = await client.$queryRaw<Array<{ pid: number; databaseName: string }>>(Prisma.sql`
      SELECT pg_backend_pid() AS pid, current_database() AS "databaseName"
    `);
    return rows[0];
  }

  async function waitForBlockedQueryCount(
    queryPattern: string,
    expectedCount: number,
  ): Promise<Array<{ pid: number; blockers: number[] }>> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const rows = await prisma.$queryRaw<Array<{ pid: number; blockers: number[] }>>(Prisma.sql`
        SELECT pid, pg_blocking_pids(pid) AS blockers
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND cardinality(pg_blocking_pids(pid)) > 0
          AND query LIKE ${queryPattern}
        ORDER BY pid ASC
      `);
      if (rows.length >= expectedCount) return rows;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`未观察到 ${expectedCount} 条 PostgreSQL blocked query: ${queryPattern}`);
  }

  async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timeout`)), 5_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // 直建一条「approved」入队申请(8 通用 gate 全过 + 候选部门),用于 T4 一键入队测试。
  // contribution 默认 5，可由 opts 精确覆盖；fixture 直接创建 approved，不表达历史上曾达标。
  // gateMarks 可注入(过期等);默认全过(完成日 = now)。
  async function setupApproved(opts: {
    targets: string[];
    contribution?: string;
    gateMarks?: Record<string, unknown>;
    evaluationExtendedUntil?: Date;
    cycleStatus?: 'open' | 'closed';
    requiresInsurance?: boolean;
  }): Promise<{ appId: string; memberId: string; cycleId: string }> {
    // 十项收口刀B:DB 级「至多一个 open 轮」partial unique 落地——夹具先关旧 open 再开新
    // (此前夹具可堆多个 open 轮,靠"最新创建"侥幸;现与生产语义一致)。
    await prisma.teamJoinCycle.updateMany({
      where: { statusCode: 'open' },
      data: { statusCode: 'closed', closedAt: new Date() },
    });
    const cycle = await prisma.teamJoinCycle.create({
      data: {
        year: CYCLE_YEAR,
        name: '2026 年度入队',
        statusCode: opts.cycleStatus ?? 'open',
        openedAt: new Date(),
        requiresInsurance: opts.requiresInsurance ?? false,
      },
    });
    const memberId = await createMember();
    await addContribution(memberId, opts.contribution ?? '5.00');
    const nowIso = new Date().toISOString();
    const marks =
      opts.gateMarks ??
      Object.fromEntries(
        GENERAL_GATES.map((g) => [
          g,
          { at: nowIso, by: adminUserId, passed: true, completionDate: nowIso },
        ]),
      );
    const a = await prisma.teamJoinApplication.create({
      data: {
        cycleId: cycle.id,
        memberId,
        statusCode: 'approved',
        targetOrganizationIds: opts.targets,
        gateMarks: marks as Prisma.InputJsonValue,
        evaluatedByUserId: adminUserId,
        evaluatedAt: new Date(),
        ...(opts.evaluationExtendedUntil
          ? { evaluationExtendedUntil: opts.evaluationExtendedUntil }
          : {}),
      },
    });
    return { appId: a.id, memberId, cycleId: cycle.id };
  }

  async function giveVerifiedSelfInsurance(memberId: string) {
    return prisma.memberInsurance.create({
      data: {
        memberId,
        insurerName: '入队自购保险',
        policyNumber: `TJ-SELF-${memberId}`,
        coverageStart: new Date('2020-01-01T00:00:00.000Z'),
        coverageEnd: new Date('2099-12-31T00:00:00.000Z'),
        reviewStatusCode: 'verified',
        version: 4,
        reviewedByUserId: adminUserId,
        reviewedAt: new Date('2026-07-01T01:02:03.000Z'),
      },
    });
  }

  async function giveTeamInsurance(memberId: string) {
    const policy = await prisma.teamInsurancePolicy.create({
      data: {
        insurerName: '入队队保',
        policyNumber: `TJ-TEAM-${memberId}`,
        coverageStart: new Date('2020-01-01T00:00:00.000Z'),
        coverageEnd: new Date('2099-12-31T00:00:00.000Z'),
      },
    });
    const coverage = await prisma.teamInsuranceCoverage.create({
      data: { policyId: policy.id, memberId },
    });
    return { policy, coverage };
  }

  beforeAll(async () => {
    previousGate = process.env.INSURANCE_ENFORCEMENT_ENABLED;
    process.env.INSURANCE_ENFORCEMENT_ENABLED = 'true';
    app = await createTestApp();
    appB = await createTestApp();
    prisma = app.get(PrismaService);
    prismaB = appB.get(PrismaService);
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
    // 一键入队设 gradeCode='level-1' 依赖 member_grade 字典(resetDb 已 truncate dicts,此处补 seed)
    const gradeType = await prisma.dictType.create({
      data: { code: 'member_grade', label: '队员级别' },
    });
    await prisma.dictItem.create({
      data: { typeId: gradeType.id, code: 'level-1', label: '级别 1' },
    });
  });

  afterAll(async () => {
    await Promise.all([app.close(), appB.close()]);
    if (previousGate === undefined) delete process.env.INSURANCE_ENFORCEMENT_ENABLED;
    else process.env.INSURANCE_ENFORCEMENT_ENABLED = previousGate;
  });

  beforeEach(async () => {
    await prisma.attendanceRecord.deleteMany({});
    await prisma.attendanceSheet.deleteMany({});
    await prisma.activity.deleteMany({});
    await prisma.insuranceEligibilityEvidence.deleteMany({});
    await prisma.teamJoinApplication.deleteMany({});
    await prisma.memberOrganizationMembership.deleteMany({}); // T4 一键入队建的归属(FK 顺序:先于 org/member)
    await prisma.teamJoinCycle.deleteMany({});
    await prisma.organization.deleteMany({});
    // 统一通知 S3:入队定向通知(recipientMemberId FK→Member Restrict)须先于 member 清。
    await prisma.notificationDelivery.deleteMany({});
    await prisma.notificationRead.deleteMany({});
    await prisma.notification.deleteMany({});
    await prisma.notificationOutboxIntent.deleteMany({});
    await prisma.teamInsuranceCoverage.deleteMany({});
    await prisma.teamInsurancePolicy.deleteMany({});
    await prisma.memberInsurance.deleteMany({});
    await prisma.member.deleteMany({});
    await prisma.auditLog.deleteMany({
      where: { resourceType: { in: ['team_join_cycle', 'team_join_application'] } },
    });
  });

  // ===== 入队轮 CRUD + 至多一个 open =====
  it('① 入队轮 create(closed)→ PATCH open → detail open;第二个轮开 open → 28231(十项收口刀B 专码)', async () => {
    const created = await request(httpServer(app))
      .post(ADMIN_CYCLES)
      .set('Authorization', adminAuth)
      .send({ year: CYCLE_YEAR, name: '2026 年度入队' })
      .expect(201);
    expect(created.body.data.statusCode).toBe('closed');
    expect(created.body.data.requiresInsurance).toBe(false);
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
    expect(detail.body.data.requiresInsurance).toBe(false);

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
    // 十项收口刀B:由通用 40000 升专码(并发穿透另有 team_join_cycles_single_open_unique P2002 兜底同码)
    expectBizError(res, BizCode.TEAM_JOIN_CYCLE_OPEN_CONFLICT);
  });

  it('② 入队轮详情不存在 → TEAM_JOIN_CYCLE_NOT_FOUND', async () => {
    const res = await request(httpServer(app))
      .get(`${ADMIN_CYCLES}/nonexistent-id`)
      .set('Authorization', adminAuth);
    expectBizError(res, BizCode.TEAM_JOIN_CYCLE_NOT_FOUND);
  });

  it('H 入队轮配置:创建/更新回显保险、开放部门与候选上限;审计同步保险开关', async () => {
    const active = await prisma.organization.create({
      data: { name: '开放部门', nodeTypeCode: 'demo-node-type-1', status: 'ACTIVE' },
    });
    const inactive = await prisma.organization.create({
      data: { name: '停用部门', nodeTypeCode: 'demo-node-type-1', status: 'INACTIVE' },
    });
    const created = await request(httpServer(app))
      .post(ADMIN_CYCLES)
      .set('Authorization', adminAuth)
      .send({
        year: CYCLE_YEAR,
        name: '配置化入队轮',
        openOrganizationIds: [active.id, active.id],
        maxTargetOrgs: 2,
        requiresInsurance: true,
      })
      .expect(201);
    expect(created.body.data.openOrganizationIds).toEqual([active.id]);
    expect(created.body.data.maxTargetOrgs).toBe(2);
    expect(created.body.data.requiresInsurance).toBe(true);

    const overLimit = await request(httpServer(app))
      .patch(`${ADMIN_CYCLES}/${created.body.data.id}`)
      .set('Authorization', adminAuth)
      .send({ maxTargetOrgs: 3 });
    expectBizError(overLimit, BizCode.BAD_REQUEST, { strictMessage: false });

    const cleared = await request(httpServer(app))
      .patch(`${ADMIN_CYCLES}/${created.body.data.id}`)
      .set('Authorization', adminAuth)
      .send({ openOrganizationIds: [], maxTargetOrgs: null, requiresInsurance: false })
      .expect(200);
    expect(cleared.body.data.openOrganizationIds).toBeNull();
    expect(cleared.body.data.maxTargetOrgs).toBeNull();
    expect(cleared.body.data.requiresInsurance).toBe(false);

    const audits = await prisma.auditLog.findMany({
      where: {
        resourceType: 'team_join_cycle',
        resourceId: created.body.data.id as string,
        event: { in: ['team-join-cycle.create', 'team-join-cycle.update'] },
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits).toHaveLength(2);
    expect(audits[0].context).toMatchObject({ after: { requiresInsurance: true } });
    expect(audits[1].context).toMatchObject({
      before: { requiresInsurance: true },
      after: { requiresInsurance: false },
    });

    expectBizError(
      await request(httpServer(app))
        .patch(`${ADMIN_CYCLES}/${created.body.data.id}`)
        .set('Authorization', adminAuth)
        .send({ openOrganizationIds: [inactive.id] }),
      BizCode.ORGANIZATION_INACTIVE,
    );
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

  it('刀A4 markGate 并发标不同项 → 行锁后两项均保留,JSON 不丢更新', async () => {
    const cycleId = await openCycle();
    const memberId = await createMember();
    const appId = await createApplication(cycleId, memberId);
    const completionDate = new Date(Date.now() - 86_400_000).toISOString();
    const [a, b] = await Promise.all([
      markGate(appId, 'fitness', { completionDate }),
      markGate(appId, 'psych', { completionDate }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const row = await prisma.teamJoinApplication.findUniqueOrThrow({ where: { id: appId } });
    expect(Object.keys(row.gateMarks as Record<string, unknown>).sort()).toEqual([
      'fitness',
      'psych',
    ]);
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

  it('⑥b【全局每日封顶】同一北京日多条记录 → 当日封顶 3;跨日再累加', async () => {
    const cycleId = await openCycle();
    const memberId = await createMember();
    const appId = await createApplication(cycleId, memberId);

    // dayA 同一北京日 3 条 × 2.0 = 6.0 → 当日封顶 3;dayB 另一北京日 1 条 × 1.0(不触顶)。
    const dayA = BEFORE_CUTOFF;
    const dayB = new Date(BEFORE_CUTOFF.getTime() - 86_400_000);
    await insertContributionRecords(memberId, [
      { points: '2.00', checkInAt: dayA },
      { points: '2.00', checkInAt: dayA },
      { points: '2.00', checkInAt: dayA },
      { points: '1.00', checkInAt: dayB },
    ]);

    const detail = await request(httpServer(app))
      .get(`${ADMIN_APPS}/${appId}`)
      .set('Authorization', adminAuth)
      .expect(200);
    // 旧直接 SUM = 7.0;新按北京日封顶:min(6.0,3)=3 + 1.0 = 4。
    expect(detail.body.data.contributionPoints).toBe('4');
    expect(detail.body.data.contributionSatisfied).toBe(false);
  });

  // ===== 十项收口刀A:gate 完成日不得晚于今天(28243)=====
  it('刀A markGate 完成日在未来(明天)→ 28243;完成日=今天 → 200(允许"今天"拒"明天")', async () => {
    const cycleId = await openCycle();
    const memberId = await createMember();
    const appId = await createApplication(cycleId, memberId);
    // 此前未来日期会立即判满足并可当场自动推进(years 类还把有效期虚推更远)
    const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString();
    const res = await markGate(appId, 'fitness', { completionDate: tomorrow });
    expectBizError(res, BizCode.TEAM_JOIN_GATE_COMPLETION_IN_FUTURE);
    await markGate(appId, 'fitness', { completionDate: new Date().toISOString() }).expect(200);
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

  it('⑧b【bug HIGH】入队轮开启当天(白天)date-only 完成的本轮 gate → 同北京日算本轮有效', async () => {
    // 轮次开启 = 2026-06-19 06:00 UTC(北京 14:00);gate 完成日 date-only '2026-06-19'(= UTC 00:00,精确时刻早于 openedAt)。
    // 修复前:00:00 UTC < 06:00 UTC openedAt → 误判「本轮之前」失效;修复后:同北京日 → 满足。
    const cycleId = await openCycle(new Date('2026-06-19T06:00:00Z'));
    const memberId = await createMember();
    const appId = await createApplication(cycleId, memberId);
    await markGate(appId, 'fitness', { completionDate: '2026-06-19' }).expect(200);
    const detail = await request(httpServer(app))
      .get(`${ADMIN_APPS}/${appId}`)
      .set('Authorization', adminAuth)
      .expect(200);
    const fitness = detail.body.data.gates.find((x: { code: string }) => x.code === 'fitness');
    expect(fitness.satisfied).toBe(true);
  });

  it('⑬b【bug MED】pending_evaluation 期间 gate 过期 → evaluate approve 重校验被拒(WRONG_STATE)', async () => {
    const cycleId = await openCycle();
    const memberId = await createMember();
    await addContribution(memberId, '5.00');
    const nowIso = new Date().toISOString();
    const expired = new Date(Date.now() - 3 * 365 * 24 * 3600_000).toISOString(); // military(2年)过期
    const marks: Record<string, unknown> = {};
    for (const g of GENERAL_GATES) {
      marks[g] = {
        at: nowIso,
        by: adminUserId,
        passed: true,
        completionDate: g === 'military' ? expired : nowIso,
      };
    }
    // 直建 pending_evaluation 态 + 含过期 military 的 gateMarks(模拟评估期间 years gate 过期)
    const appId = await createApplication(cycleId, memberId, {
      statusCode: 'pending_evaluation',
      gateMarks: marks,
    });
    expectBizError(await evaluate(appId, true), BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
    // 未误 approve,仍 pending_evaluation(旧态保留,admin 重标 gate 自愈)
    const detail = await request(httpServer(app))
      .get(`${ADMIN_APPS}/${appId}`)
      .set('Authorization', adminAuth)
      .expect(200);
    expect(detail.body.data.statusCode).toBe('pending_evaluation');
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

  it('finding #6:同一 pending_evaluation 并发 approve || reject → 恰一方成功,败者 WRONG_STATE', async () => {
    const cycleId = await openCycle();
    const memberId = await createMember();
    await addContribution(memberId, '5.00');
    const appId = await createApplication(cycleId, memberId);
    await markAllGeneralPassed(appId);

    const results = await Promise.all([evaluate(appId, true), evaluate(appId, false)]);

    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    const loser = results.find((result) => result.status !== 200);
    expect(loser).toBeDefined();
    expectBizError(loser!, BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
    const row = await prisma.teamJoinApplication.findUniqueOrThrow({
      where: { id: appId },
      select: { statusCode: true },
    });
    expect(['approved', 'rejected']).toContain(row.statusCode);
    expect(
      await prisma.auditLog.count({
        where: { resourceType: 'team_join_application', resourceId: appId },
      }),
    ).toBe(9);
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

  // ===== T4 一键入队(志愿者 → 队员)=====
  it('⑰【T4】approved → joined;两层身份转换(前无部门无级别 → 后 level-1 + 部门)+ audit join', async () => {
    const org = await makeOrg();
    const { appId, memberId } = await setupApproved({ targets: [org] });
    const before = await prisma.member.findUnique({
      where: { id: memberId },
      select: { gradeCode: true },
    });
    expect(before?.gradeCode).toBeNull();
    const beforeDept = await prisma.memberOrganizationMembership.count({
      where: { memberId, deletedAt: null },
    });
    expect(beforeDept).toBe(0);

    const insuranceRequirement = app.get(InsuranceRequirementService);
    const insuranceQuery = jest.spyOn(insuranceRequirement, 'requireForTeamJoin');
    const res = await join(appId, org).expect(200);
    expect(insuranceQuery).not.toHaveBeenCalled();
    insuranceQuery.mockRestore();
    expect(res.body.data.statusCode).toBe('joined');
    expect(res.body.data.selectedOrganizationId).toBe(org);
    expect(res.body.data.joinedAt).not.toBeNull();

    const after = await prisma.member.findUnique({
      where: { id: memberId },
      select: { gradeCode: true },
    });
    expect(after?.gradeCode).toBe('level-1');
    const dept = await prisma.memberOrganizationMembership.findFirst({
      where: { memberId, deletedAt: null },
    });
    expect(dept?.organizationId).toBe(org);
    const auditCount = await prisma.auditLog.count({
      where: { event: 'team-join-application.join' },
    });
    expect(auditCount).toBe(1);
    expect(
      await prisma.insuranceEligibilityEvidence.count({
        where: { teamJoinApplicationId: appId },
      }),
    ).toBe(0);
  });

  it('⑰-ins-1 requiresInsurance=true 且无来源 → 26031，final join 副作用全为零', async () => {
    const org = await makeOrg();
    const { appId, memberId } = await setupApproved({
      targets: [org],
      requiresInsurance: true,
    });
    expect(
      await prisma.insuranceEligibilityEvidence.count({
        where: { teamJoinApplicationId: appId },
      }),
    ).toBe(0);

    expectBizError(await join(appId, org), BizCode.TEAM_JOIN_INSURANCE_REQUIRED);
    expect(
      await prisma.teamJoinApplication.findUniqueOrThrow({ where: { id: appId } }),
    ).toMatchObject({ statusCode: 'approved', selectedOrganizationId: null, joinedAt: null });
    expect(await prisma.member.findUniqueOrThrow({ where: { id: memberId } })).toMatchObject({
      gradeCode: null,
    });
    expect(
      await prisma.memberOrganizationMembership.count({ where: { memberId, deletedAt: null } }),
    ).toBe(0);
    expect(
      await prisma.insuranceEligibilityEvidence.count({
        where: { teamJoinApplicationId: appId },
      }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { event: 'team-join-application.join', resourceId: appId },
      }),
    ).toBe(0);
    expect(await prisma.notificationOutboxIntent.count({ where: { aggregateId: appId } })).toBe(0);
  });

  it('⑰-ins-2 verified self → final join 成功并生成唯一、最小 owner evidence', async () => {
    const org = await makeOrg();
    const { appId, memberId } = await setupApproved({
      targets: [org],
      requiresInsurance: true,
    });
    const source = await giveVerifiedSelfInsurance(memberId);
    expect(
      await prisma.insuranceEligibilityEvidence.count({
        where: { teamJoinApplicationId: appId },
      }),
    ).toBe(0);

    const res = await join(appId, org).expect(200);
    const requiredDay = normalizeDateOnly(new Date(res.body.data.joinedAt as string).toISOString());
    const evidence = await prisma.insuranceEligibilityEvidence.findMany({
      where: { teamJoinApplicationId: appId },
    });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      sourceKind: 'member_insurance',
      memberInsuranceId: source.id,
      teamInsuranceCoverageId: null,
      ownerKind: 'team_join_application',
      activityRegistrationId: null,
      teamJoinApplicationId: appId,
      sourceRevision: 4,
      sourceReviewedByUserId: adminUserId,
      sourceCoverageStart: new Date('2020-01-01T00:00:00.000Z'),
      sourceCoverageEnd: new Date('2099-12-31T00:00:00.000Z'),
    });
    expect(evidence[0].sourceReviewedAt?.toISOString()).toBe('2026-07-01T01:02:03.000Z');
    expect(evidence[0].requiredFrom?.getTime()).toBe(requiredDay.getTime());
    expect(evidence[0].requiredThrough?.getTime()).toBe(requiredDay.getTime());
    expect(JSON.stringify(evidence[0])).not.toMatch(
      /insurer|policyNumber|note|reason|image|attachment|key|url/i,
    );
  });

  it('⑰-ins-3 live team Policy+Coverage → final join 成功并生成 team evidence', async () => {
    const org = await makeOrg();
    const { appId, memberId } = await setupApproved({
      targets: [org],
      requiresInsurance: true,
    });
    const { coverage } = await giveTeamInsurance(memberId);
    const res = await join(appId, org).expect(200);
    const requiredDay = normalizeDateOnly(new Date(res.body.data.joinedAt as string).toISOString());
    const evidence = await prisma.insuranceEligibilityEvidence.findMany({
      where: { teamJoinApplicationId: appId },
    });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      sourceKind: 'team_insurance_coverage',
      memberInsuranceId: null,
      teamInsuranceCoverageId: coverage.id,
      ownerKind: 'team_join_application',
      activityRegistrationId: null,
      teamJoinApplicationId: appId,
      sourceRevision: null,
      sourceReviewedByUserId: null,
      sourceReviewedAt: null,
      sourceCoverageStart: new Date('2020-01-01T00:00:00.000Z'),
      sourceCoverageEnd: new Date('2099-12-31T00:00:00.000Z'),
    });
    expect(evidence[0].requiredFrom?.getTime()).toBe(requiredDay.getTime());
    expect(evidence[0].requiredThrough?.getTime()).toBe(requiredDay.getTime());
  });

  it.each(['rejected', 'deleted'] as const)(
    '⑰-ins-4 verified self 在 final join 前变为 %s → 26031，不消费旧资格',
    async (mutation) => {
      const org = await makeOrg();
      const { appId, memberId } = await setupApproved({
        targets: [org],
        requiresInsurance: true,
      });
      const source = await giveVerifiedSelfInsurance(memberId);
      await prisma.memberInsurance.update({
        where: { id: source.id },
        data:
          mutation === 'rejected'
            ? { reviewStatusCode: 'rejected', version: { increment: 1 } }
            : { deletedAt: new Date(), version: { increment: 1 } },
      });

      expectBizError(await join(appId, org), BizCode.TEAM_JOIN_INSURANCE_REQUIRED);
      expect(
        await prisma.teamJoinApplication.findUniqueOrThrow({ where: { id: appId } }),
      ).toMatchObject({ statusCode: 'approved', joinedAt: null });
      expect(
        await prisma.insuranceEligibilityEvidence.count({
          where: { teamJoinApplicationId: appId },
        }),
      ).toBe(0);
    },
  );

  it('⑰-ins-5 wrong-member preexisting evidence 不能穿透 final join，业务写全部回滚', async () => {
    const org = await makeOrg();
    const { appId, memberId } = await setupApproved({
      targets: [org],
      requiresInsurance: true,
    });
    await giveVerifiedSelfInsurance(memberId);
    const otherMemberId = await createMember();
    const wrongSource = await giveVerifiedSelfInsurance(otherMemberId);
    await prisma.insuranceEligibilityEvidence.create({
      data: {
        sourceKind: 'member_insurance',
        memberInsuranceId: wrongSource.id,
        ownerKind: 'team_join_application',
        teamJoinApplicationId: appId,
        sourceRevision: wrongSource.version,
        sourceReviewedByUserId: wrongSource.reviewedByUserId,
        sourceReviewedAt: wrongSource.reviewedAt,
        requiredFrom: new Date(),
        requiredThrough: new Date(),
        sourceCoverageStart: wrongSource.coverageStart,
        sourceCoverageEnd: wrongSource.coverageEnd,
      },
    });

    expectBizError(await join(appId, org), BizCode.TEAM_JOIN_INSURANCE_REQUIRED);
    expect(
      await prisma.teamJoinApplication.findUniqueOrThrow({ where: { id: appId } }),
    ).toMatchObject({ statusCode: 'approved', selectedOrganizationId: null, joinedAt: null });
    expect(
      await prisma.memberOrganizationMembership.count({ where: { memberId, deletedAt: null } }),
    ).toBe(0);
    expect(
      await prisma.insuranceEligibilityEvidence.count({
        where: { teamJoinApplicationId: appId },
      }),
    ).toBe(1);
  });

  it('并发夹具自证:两 Nest server/Prisma pool 独立且共用同一派生 app_test_* PostgreSQL', async () => {
    expect(app.getHttpServer()).not.toBe(appB.getHttpServer());
    expect(prisma).not.toBe(prismaB);
    const [identityA, identityB] = await Promise.all([
      readBackendIdentity(prisma),
      readBackendIdentity(prismaB),
    ]);
    expect(identityA.pid).not.toBe(identityB.pid);
    expect(identityA.databaseName).toBe(identityB.databaseName);
    expect(identityA.databaseName).toMatch(/^app_test(?:_|$)/);
  });

  it('两 Nest/两 pool barrier:cycle flag update 锁 Application→Cycle 后提交 true，Final join 重读并拒 26031', async () => {
    const org = await makeOrg();
    const { appId, memberId, cycleId } = await setupApproved({
      targets: [org],
      requiresInsurance: false,
    });
    const auditLogsB = appB.get(AuditLogsService);
    const originalLog = auditLogsB.log.bind(auditLogsB);
    let release!: () => void;
    let reached!: (pid: number) => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reachedPromise = new Promise<number>((resolve) => {
      reached = resolve;
    });
    const barrier = jest.spyOn(auditLogsB, 'log').mockImplementation(async (input) => {
      if (input.event === 'team-join-cycle.update' && input.resourceId === cycleId && input.tx) {
        const rows = await input.tx.$queryRaw<Array<{ pid: number }>>(
          Prisma.sql`SELECT pg_backend_pid() AS pid`,
        );
        reached(rows[0].pid);
        await releasePromise;
      }
      return originalLog(input);
    });
    const update = request(httpServer(appB))
      .patch(`${ADMIN_CYCLES}/${cycleId}`)
      .set('Authorization', adminAuth)
      .send({ requiresInsurance: true })
      .then((res) => res);
    let joining: Promise<request.Response> | undefined;

    try {
      const blockerPid = await withTimeout(reachedPromise, 'cycle flag audit barrier');
      joining = join(appId, org).then((res) => res);
      await waitForBlockedQuery(blockerPid, '%FROM "team_join_applications"%FOR UPDATE%');
      release();
      const [updateRes, joinRes] = await Promise.all([update, joining]);
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.requiresInsurance).toBe(true);
      expectBizError(joinRes, BizCode.TEAM_JOIN_INSURANCE_REQUIRED);
    } finally {
      release();
      await Promise.allSettled([update, ...(joining === undefined ? [] : [joining])]);
      barrier.mockRestore();
    }

    expect(await prisma.teamJoinCycle.findUniqueOrThrow({ where: { id: cycleId } })).toMatchObject({
      requiresInsurance: true,
    });
    expect(
      await prisma.teamJoinApplication.findUniqueOrThrow({ where: { id: appId } }),
    ).toMatchObject({ statusCode: 'approved', joinedAt: null });
    expect(
      await prisma.memberOrganizationMembership.count({ where: { memberId, deletedAt: null } }),
    ).toBe(0);
    expect(
      await prisma.insuranceEligibilityEvidence.count({
        where: { teamJoinApplicationId: appId },
      }),
    ).toBe(0);
  });

  it('两 Nest/两 pool barrier:review↔Final join self source，review NOWAIT 快速 26011 且无死锁', async () => {
    const org = await makeOrg();
    const { appId, memberId } = await setupApproved({
      targets: [org],
      requiresInsurance: true,
    });
    const source = await giveVerifiedSelfInsurance(memberId);
    let releaseMember!: () => void;
    let memberLocked!: (pid: number) => void;
    const releaseMemberPromise = new Promise<void>((resolve) => {
      releaseMember = resolve;
    });
    const memberLockedPromise = new Promise<number>((resolve) => {
      memberLocked = resolve;
    });
    const holder = prismaB.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "Member"
        WHERE "id" = ${memberId}
        FOR UPDATE
      `);
      const rows = await tx.$queryRaw<Array<{ pid: number }>>(
        Prisma.sql`SELECT pg_backend_pid() AS pid`,
      );
      memberLocked(rows[0].pid);
      await releaseMemberPromise;
    });
    let reviewPromise: Promise<request.Response> | undefined;
    let joinPromise: Promise<request.Response> | undefined;

    try {
      const holderPid = await withTimeout(memberLockedPromise, 'external Member lock');
      reviewPromise = request(httpServer(appB))
        .post(`/api/admin/v1/members/${memberId}/insurances/${source.id}/review`)
        .set('Authorization', adminAuth)
        .send({ decision: 'rejected', expectedVersion: 4 })
        .then((res) => res);
      await waitForBlockedQuery(holderPid, '%FROM "Member"%FOR UPDATE%');

      // review 已先进入 Member 锁队列；Final join 随后持 self source FOR SHARE 后等待 Member。
      // 释放外部锁后 review 先拿 Member，再对 source 使用 NOWAIT 快速 26011；若改为等待锁，
      // 将与持 source 等 Member 的 Final join 形成死锁。
      joinPromise = join(appId, org).then((res) => res);
      const waiters = await waitForBlockedQueryCount('%FROM "Member"%FOR UPDATE%', 2);
      expect(new Set(waiters.map((row) => row.pid)).size).toBeGreaterThanOrEqual(2);
      expect(waiters.every((row) => row.blockers.length > 0)).toBe(true);
      releaseMember();
      const [reviewRes, joinRes] = await Promise.all([
        withTimeout(reviewPromise, 'review NOWAIT result'),
        withTimeout(joinPromise, 'Final join result'),
      ]);
      expectBizError(reviewRes, BizCode.MEMBER_INSURANCE_VERSION_CONFLICT);
      expect(joinRes.status).toBe(200);
    } finally {
      releaseMember();
      await Promise.allSettled([
        holder,
        ...(reviewPromise === undefined ? [] : [reviewPromise]),
        ...(joinPromise === undefined ? [] : [joinPromise]),
      ]);
    }

    expect(
      await prisma.memberInsurance.findUniqueOrThrow({ where: { id: source.id } }),
    ).toMatchObject({ reviewStatusCode: 'verified', version: 4 });
    expect(
      await prisma.insuranceEligibilityEvidence.count({
        where: { teamJoinApplicationId: appId, memberInsuranceId: source.id },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { event: 'member-insurance.review', resourceId: source.id },
      }),
    ).toBe(0);
  });

  it('Final join audit 失败回滚 membership/member/application/evidence/outbox', async () => {
    const org = await makeOrg();
    const { appId, memberId } = await setupApproved({
      targets: [org],
      requiresInsurance: true,
    });
    await giveVerifiedSelfInsurance(memberId);
    const auditLogs = app.get(AuditLogsService);
    const originalLog = auditLogs.log.bind(auditLogs);
    const failure = jest.spyOn(auditLogs, 'log').mockImplementation(async (input) => {
      if (input.event === 'team-join-application.join' && input.resourceId === appId) {
        throw new Error('simulated final join audit failure');
      }
      return originalLog(input);
    });
    try {
      await join(appId, org).expect(500);
    } finally {
      failure.mockRestore();
    }

    expect(
      await prisma.teamJoinApplication.findUniqueOrThrow({ where: { id: appId } }),
    ).toMatchObject({ statusCode: 'approved', selectedOrganizationId: null, joinedAt: null });
    expect(await prisma.member.findUniqueOrThrow({ where: { id: memberId } })).toMatchObject({
      gradeCode: null,
    });
    expect(
      await prisma.memberOrganizationMembership.count({ where: { memberId, deletedAt: null } }),
    ).toBe(0);
    expect(
      await prisma.insuranceEligibilityEvidence.count({
        where: { teamJoinApplicationId: appId },
      }),
    ).toBe(0);
    expect(await prisma.notificationOutboxIntent.count({ where: { aggregateId: appId } })).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { event: 'team-join-application.join', resourceId: appId },
      }),
    ).toBe(0);
  });

  it('两 Nest/两 pool barrier:remove 按 Policy→Coverage→Member 等待 Final join，无 40P01', async () => {
    const org = await makeOrg();
    const { appId, memberId } = await setupApproved({
      targets: [org],
      requiresInsurance: true,
    });
    const { policy, coverage } = await giveTeamInsurance(memberId);
    const requirement = app.get(InsuranceRequirementService);
    const original = requirement.createTeamJoinApplicationEvidence.bind(requirement);
    let release!: () => void;
    let reached!: (pid: number) => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reachedPromise = new Promise<number>((resolve) => {
      reached = resolve;
    });
    const barrier = jest
      .spyOn(requirement, 'createTeamJoinApplicationEvidence')
      .mockImplementation(async (...args) => {
        const rows = await args[3].$queryRaw<Array<{ pid: number }>>(
          Prisma.sql`SELECT pg_backend_pid() AS pid`,
        );
        reached(rows[0].pid);
        await releasePromise;
        return original(...args);
      });

    try {
      const joining = join(appId, org).then((res) => res);
      const blockerPid = await withTimeout(reachedPromise, 'final join evidence barrier');
      const removal = request(httpServer(appB))
        .delete(`/api/admin/v1/team-insurance-policies/${policy.id}/members/${memberId}`)
        .set('Authorization', adminAuth)
        .then((res) => res);
      await waitForBlockedQuery(blockerPid, '%FROM "team_insurance_policies"%FOR UPDATE%');
      release();
      const [joinRes, removeRes] = await Promise.all([joining, removal]);
      expect(joinRes.status).toBe(200);
      expect(removeRes.status).toBe(200);
      expect(removeRes.body.code).toBe(0);
    } finally {
      release();
      barrier.mockRestore();
    }
    expect(
      await prismaB.insuranceEligibilityEvidence.count({
        where: { teamJoinApplicationId: appId, teamInsuranceCoverageId: coverage.id },
      }),
    ).toBe(1);
    expect(
      await prismaB.teamInsuranceCoverage.findUniqueOrThrow({ where: { id: coverage.id } }),
    ).toMatchObject({ deletedAt: expect.any(Date) });
  });

  it('两 Nest/两 pool barrier:同 Team Join owner 双请求仅一条 evidence/归属/outbox', async () => {
    const org = await makeOrg();
    const { appId, memberId } = await setupApproved({
      targets: [org],
      requiresInsurance: true,
    });
    await giveVerifiedSelfInsurance(memberId);
    const requirement = app.get(InsuranceRequirementService);
    const original = requirement.createTeamJoinApplicationEvidence.bind(requirement);
    let release!: () => void;
    let reached!: (pid: number) => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reachedPromise = new Promise<number>((resolve) => {
      reached = resolve;
    });
    const barrier = jest
      .spyOn(requirement, 'createTeamJoinApplicationEvidence')
      .mockImplementation(async (...args) => {
        const rows = await args[3].$queryRaw<Array<{ pid: number }>>(
          Prisma.sql`SELECT pg_backend_pid() AS pid`,
        );
        reached(rows[0].pid);
        await releasePromise;
        return original(...args);
      });

    try {
      const winner = join(appId, org).then((res) => res);
      const blockerPid = await withTimeout(reachedPromise, 'team join duplicate barrier');
      const loser = joinVia(appB, appId, org).then((res) => res);
      await waitForBlockedQuery(blockerPid, '%FROM "team_join_applications"%FOR UPDATE%');
      release();
      const [winnerRes, loserRes] = await Promise.all([winner, loser]);
      expect(winnerRes.status).toBe(200);
      expect(loserRes.status).toBe(BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE.httpStatus);
      expect(loserRes.body.code).toBe(BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE.code);
    } finally {
      release();
      barrier.mockRestore();
    }

    expect(
      await prismaB.insuranceEligibilityEvidence.count({
        where: { teamJoinApplicationId: appId },
      }),
    ).toBe(1);
    expect(
      await prismaB.memberOrganizationMembership.count({
        where: { memberId, status: 'ACTIVE', deletedAt: null },
      }),
    ).toBe(1);
    expect(await prismaB.notificationOutboxIntent.count({ where: { aggregateId: appId } })).toBe(1);
  });

  it('⑰a【T4】最终入队实时贡献复核拒绝 4.99 → 28241，且业务副作用为零', async () => {
    // 杀死 mutation:删除最终入队时的 computeContribution 实时复核后，本例会错误 joined。
    const org = await makeOrg();
    const { appId, memberId } = await setupApproved({ targets: [org], contribution: '4.99' });

    const before = await Promise.all([
      prisma.teamJoinApplication.findUniqueOrThrow({
        where: { id: appId },
        select: {
          statusCode: true,
          selectedOrganizationId: true,
          joinedAt: true,
          updatedAt: true,
        },
      }),
      prisma.member.findUniqueOrThrow({
        where: { id: memberId },
        select: { gradeCode: true },
      }),
      prisma.memberOrganizationMembership.count({ where: { memberId, deletedAt: null } }),
      prisma.auditLog.count({
        where: {
          event: 'team-join-application.join',
          resourceType: 'team_join_application',
          resourceId: appId,
        },
      }),
      prisma.notification.count({ where: { recipientMemberId: memberId } }),
    ]);
    expect(before[0]).toMatchObject({
      statusCode: 'approved',
      selectedOrganizationId: null,
      joinedAt: null,
    });
    expect(before[1].gradeCode).toBeNull();
    expect(before[2]).toBe(0);

    expectBizError(await join(appId, org), BizCode.TEAM_JOIN_GATES_NOT_SATISFIED);

    const after = await Promise.all([
      prisma.teamJoinApplication.findUniqueOrThrow({
        where: { id: appId },
        select: {
          statusCode: true,
          selectedOrganizationId: true,
          joinedAt: true,
          updatedAt: true,
        },
      }),
      prisma.member.findUniqueOrThrow({
        where: { id: memberId },
        select: { gradeCode: true },
      }),
      prisma.memberOrganizationMembership.count({ where: { memberId, deletedAt: null } }),
      prisma.auditLog.count({
        where: {
          event: 'team-join-application.join',
          resourceType: 'team_join_application',
          resourceId: appId,
        },
      }),
      prisma.notification.count({ where: { recipientMemberId: memberId } }),
    ]);
    expect(after).toEqual(before);
  });

  // ===== 统一通知 S3(评审稿 §6.4 / 招新 §9.1):入队 → 定向通知(仅站内)=====

  it('⑰c【outbox】入队成功与 targeted@1 intent 同次 commit', async () => {
    const org = await makeOrg();
    const orgRow = await prisma.organization.findUniqueOrThrow({ where: { id: org } });
    const { appId, memberId } = await setupApproved({ targets: [org] });

    await join(appId, org).expect(200);

    const intents = await prisma.notificationOutboxIntent.findMany({
      where: { destinationRef: memberId },
    });
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      eventKey: `team-join-enrollment:${appId}`,
      eventType: 'notification.targeted',
      payloadVersion: 1,
      aggregateType: 'team_join_application',
      status: 'pending',
    });
    expect(intents[0].payload).toMatchObject({ channels: ['in-app'] });
    const payload = intents[0].payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      'body',
      'channels',
      'notificationTypeCode',
      'recipientMemberId',
      'title',
    ]);
    expect(JSON.stringify(payload)).toContain(orgRow.name);

    // 重复 join 被状态机拒绝，稳定 event identity 只留一条 intent；worker 多跑仍只一条 Effect。
    expectBizError(await join(appId, org), BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
    expect(
      await prisma.notificationOutboxIntent.count({ where: { destinationRef: memberId } }),
    ).toBe(1);
    const worker = app.get(NotificationOutboxWorker);
    expect(await worker.drainOnce()).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await worker.drainOnce()).toMatchObject({ claimed: 0 });
    expect(await prisma.notification.count({ where: { recipientMemberId: memberId } })).toBe(1);
  });

  it('⑰d【outbox mutation】enqueue 失败→入队业务与 intent 同时回滚', async () => {
    const org = await makeOrg();
    const { appId, memberId } = await setupApproved({ targets: [org] });

    const outbox = app.get(NotificationOutboxService);
    const spy = jest.spyOn(outbox, 'enqueue').mockRejectedValue(new Error('enqueue boom'));
    try {
      await join(appId, org).expect(500);
      const after = await prisma.member.findUniqueOrThrow({
        where: { id: memberId },
        select: { gradeCode: true },
      });
      expect(after.gradeCode).not.toBe('level-1');
      const active = await prisma.memberOrganizationMembership.findMany({
        where: { memberId, deletedAt: null },
      });
      expect(active).toHaveLength(0);
      expect(
        await prisma.notificationOutboxIntent.count({ where: { destinationRef: memberId } }),
      ).toBe(0);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('⑰b【T4·S5】新志愿者入队:结束 VOL 任期 + 建目标 → 恰 1 条当前有效目标部门 + level-1', async () => {
    const target = await makeOrg(); // 目标部门(候选,非 VOL)
    const { appId, memberId } = await setupApproved({ targets: [target] });
    // 转「新志愿者」状态(S5 后 promote 的产物形态):gradeCode='volunteer' + 1 条 VOL 归口部门
    const volOrg = await prisma.organization.create({
      data: { name: '志愿者', code: 'VOL', nodeTypeCode: 'volunteer', status: 'ACTIVE' },
    });
    await prisma.member.update({ where: { id: memberId }, data: { gradeCode: 'volunteer' } });
    const volDept = await prisma.memberOrganizationMembership.create({
      data: { memberId, organizationId: volOrg.id },
    });

    const res = await join(appId, target).expect(200);
    expect(res.body.data.statusCode).toBe('joined');
    expect(res.body.data.selectedOrganizationId).toBe(target);

    // 入队后:gradeCode 升 level-1
    const after = await prisma.member.findUniqueOrThrow({
      where: { id: memberId },
      select: { gradeCode: true },
    });
    expect(after.gradeCode).toBe('level-1');
    // 守 PRIMARY 单槽:恰 1 条 ACTIVE 且为目标部门(VOL 已结束,绝无两条 ACTIVE)
    const active = await prisma.memberOrganizationMembership.findMany({
      where: { memberId, deletedAt: null, status: 'ACTIVE' },
    });
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      organizationId: target,
      membershipType: 'PRIMARY',
      status: 'ACTIVE',
      endedAt: null,
    });
    expect(active[0].startedAt.toISOString()).toBe(
      new Date(res.body.data.joinedAt as string).toISOString(),
    );
    // VOL 任期走统一状态机结束，保留 ENDED 历史且不再制造 ACTIVE 软删痕。
    const vol = await prisma.memberOrganizationMembership.findUniqueOrThrow({
      where: { id: volDept.id },
    });
    expect(vol.deletedAt).toBeNull();
    expect(vol.status).toBe('ENDED');
    expect(vol.endedAt).not.toBeNull();
    expect(vol.endedByUserId).toBe(adminUserId);
  });

  it('⑱【T4】幂等:已 joined 重跑 → WRONG_STATE,不重复设部门/级别', async () => {
    const org = await makeOrg();
    const { appId, memberId } = await setupApproved({ targets: [org] });
    await join(appId, org).expect(200);
    expectBizError(await join(appId, org), BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
    const depts = await prisma.memberOrganizationMembership.count({
      where: { memberId, deletedAt: null },
    });
    expect(depts).toBe(1);
  });

  it('⑲【T4】非 approved 态(joining)入队 → WRONG_STATE', async () => {
    const org = await makeOrg();
    const cycleId = await openCycle();
    const memberId = await createMember();
    const appId = await createApplication(cycleId, memberId, {
      targetOrganizationIds: [org],
      statusCode: 'joining',
    });
    expectBizError(await join(appId, org), BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
  });

  it('⑳【T4】选定部门不在候选/不存在/INACTIVE → 28242;失败 member 不变(原子)', async () => {
    const orgA = await makeOrg();
    const orgOther = await makeOrg();
    const { appId, memberId } = await setupApproved({ targets: [orgA] });
    expectBizError(await join(appId, orgOther), BizCode.TEAM_JOIN_DEPARTMENT_NOT_ELIGIBLE);
    expectBizError(await join(appId, 'no-such-org'), BizCode.TEAM_JOIN_DEPARTMENT_NOT_ELIGIBLE);
    const inactiveCand = await makeOrg('demo-node-type-1', 'INACTIVE');
    const s2 = await setupApproved({ targets: [inactiveCand] });
    expectBizError(await join(s2.appId, inactiveCand), BizCode.TEAM_JOIN_DEPARTMENT_NOT_ELIGIBLE);
    // 失败后 member 仍无级别/部门(原子,无半建态)
    const m = await prisma.member.findUnique({
      where: { id: memberId },
      select: { gradeCode: true },
    });
    expect(m?.gradeCode).toBeNull();
    expect(
      await prisma.memberOrganizationMembership.count({ where: { memberId, deletedAt: null } }),
    ).toBe(0);
  });

  it('⑳b【T4】一键入队复查本轮开放清单:收窄拒绝、加回放行、空清单全开放', async () => {
    const narrowedOrg = await makeOrg();
    const allowedOrg = await makeOrg();
    const narrowed = await setupApproved({ targets: [narrowedOrg] });
    await prisma.teamJoinCycle.update({
      where: { id: narrowed.cycleId },
      data: { openOrganizationIds: [allowedOrg] },
    });
    expectBizError(
      await join(narrowed.appId, narrowedOrg),
      BizCode.TEAM_JOIN_DEPARTMENT_NOT_ELIGIBLE,
    );
    await prisma.teamJoinCycle.update({
      where: { id: narrowed.cycleId },
      data: { openOrganizationIds: [narrowedOrg] },
    });
    await join(narrowed.appId, narrowedOrg).expect(200);

    const openOrg = await makeOrg();
    const openToAll = await setupApproved({ targets: [openOrg] });
    await prisma.teamJoinCycle.update({
      where: { id: openToAll.cycleId },
      data: { openOrganizationIds: [] },
    });
    await join(openToAll.appId, openOrg).expect(200);
  });

  it('㉑【T4】选专业队:缺对应 team-* gate → 28242;补 gate → joined', async () => {
    const proOrg = await makeOrg('professional-water'); // 水队 → 需 team-water gate
    const { appId } = await setupApproved({ targets: [proOrg] }); // 仅 8 通用,无 team-water
    expectBizError(await join(appId, proOrg), BizCode.TEAM_JOIN_DEPARTMENT_NOT_ELIGIBLE);

    const nowIso = new Date().toISOString();
    const withTeam = Object.fromEntries(
      [...GENERAL_GATES, 'team-water'].map((g) => [
        g,
        { at: nowIso, by: adminUserId, passed: true, completionDate: nowIso },
      ]),
    );
    const proOrg2 = await makeOrg('professional-water');
    const s2 = await setupApproved({ targets: [proOrg2], gateMarks: withTeam });
    const res = await join(s2.appId, proOrg2).expect(200);
    expect(res.body.data.statusCode).toBe('joined');
    expect(res.body.data.selectedOrganizationId).toBe(proOrg2);
  });

  it('㉒【T4】approved 后通用 gate 过期(military 3年前)→ 入队 28241(兜底重校验)', async () => {
    const org = await makeOrg();
    const nowIso = new Date().toISOString();
    const expired = new Date(Date.now() - 3 * 365 * 24 * 3600_000).toISOString();
    const marks = Object.fromEntries(
      GENERAL_GATES.map((g) => [
        g,
        {
          at: nowIso,
          by: adminUserId,
          passed: true,
          completionDate: g === 'military' ? expired : nowIso,
        },
      ]),
    );
    const { appId } = await setupApproved({ targets: [org], gateMarks: marks });
    expectBizError(await join(appId, org), BizCode.TEAM_JOIN_GATES_NOT_SATISFIED);
  });

  it('㉓【T4】approved 资格不随闭轮失效:无延长期与有延长期均可 joined', async () => {
    const org = await makeOrg();
    const s1 = await setupApproved({ targets: [org], cycleStatus: 'closed' });
    const r1 = await join(s1.appId, org).expect(200);
    expect(r1.body.data.statusCode).toBe('joined');

    const org2 = await makeOrg();
    const nextYear = new Date(Date.now() + 365 * 24 * 3600_000);
    const s2 = await setupApproved({
      targets: [org2],
      cycleStatus: 'closed',
      evaluationExtendedUntil: nextYear,
    });
    const res = await join(s2.appId, org2).expect(200);
    expect(res.body.data.statusCode).toBe('joined');
  });

  it('㉔【T4】USER 一键入队 → RBAC_FORBIDDEN', async () => {
    const org = await makeOrg();
    const { appId } = await setupApproved({ targets: [org] });
    expectBizError(await join(appId, org, userAuth), BizCode.RBAC_FORBIDDEN);
  });

  it('㉕【T4】member 已有级别(已入队)→ 28210', async () => {
    const org = await makeOrg();
    const { appId, memberId } = await setupApproved({ targets: [org] });
    await prisma.member.update({ where: { id: memberId }, data: { gradeCode: 'level-1' } });
    expectBizError(await join(appId, org), BizCode.TEAM_JOIN_MEMBER_ALREADY_ENROLLED);
  });
});
