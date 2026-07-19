import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Prisma, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import { ActivityRegistrationAuditRecorder } from '../../src/modules/activity-registrations/activity-registration-audit-recorder';
import { ActivityAuditRecorder } from '../../src/modules/activities/activity-audit-recorder';
import { InsuranceRequirementService } from '../../src/modules/insurances/insurance-requirement.service';
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

// 活动期(北京时间 7/1 16:00 - 20:00;归一活动日 = 2099-07-01)
const ACT_START = new Date('2099-07-01T08:00:00.000Z');
const ACT_END = new Date('2099-07-01T12:00:00.000Z');

describe('报名保险门槛(保险 T3;requiresInsurance gate)', () => {
  let app: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;
  let prismaB: PrismaService;

  let adminAuth: string; // biz-admin(代报名路径)
  let activityTypeCode: string;
  let childOrgId: string;
  let reviewerUserId: string;
  let previousGate: string | undefined;

  let seq = 0;
  const nextSeq = (): string => `${++seq}-${Math.random().toString(36).slice(2, 6)}`;

  beforeAll(async () => {
    previousGate = process.env.INSURANCE_ENFORCEMENT_ENABLED;
    process.env.INSURANCE_ENFORCEMENT_ENABLED = 'true';
    app = await createTestApp();
    appB = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    prismaB = appB.get(PrismaService);

    const { bizAdminRoleId } = await seedBizAdminPermissionsAndRole(app);
    const adminUser = await createTestUser(app, { username: 'gate-admin', role: Role.ADMIN });
    reviewerUserId = adminUser.id;
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
    await Promise.all([app.close(), appB.close()]);
    if (previousGate === undefined) delete process.env.INSURANCE_ENFORCEMENT_ENABLED;
    else process.env.INSURANCE_ENFORCEMENT_ENABLED = previousGate;
  });

  // ============== helpers ==============

  async function createPublishedActivity(
    requiresInsurance: boolean,
    genderRequirementCode: string | null = null,
  ): Promise<{ id: string }> {
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
        genderRequirementCode,
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

  async function createMemberProfile(
    memberId: string,
    genderCode: 'male' | 'female',
  ): Promise<void> {
    await prisma.memberProfile.create({
      data: {
        memberId,
        realName: '性别闸测试',
        genderCode,
        birthDate: new Date('1990-01-01T00:00:00.000Z'),
        documentTypeCode: 'id_card',
        documentNumber: `gender-gate-${nextSeq()}`,
        mobile: `138${String(seq).padStart(8, '0')}`,
        joinedDate: new Date('2020-01-01T00:00:00.000Z'),
        joinSourceCode: 'recommend',
        privacyConsentSigned: true,
      },
    });
  }

  // 自购保险直写 DB(门槛读 DB;记录形态已由 T2 app-me-insurances spec 锁定)
  async function giveSelfInsurance(
    memberId: string,
    opts: {
      coverageStart?: string | null;
      coverageEnd: string;
      reviewStatusCode?: 'pending' | 'verified' | 'rejected';
    },
  ): Promise<{ id: string }> {
    const reviewStatusCode = opts.reviewStatusCode ?? 'verified';
    return prisma.memberInsurance.create({
      data: {
        memberId,
        insurerName: '平安保险',
        policyNumber: `GATE-PN-${nextSeq()}`,
        coverageStart: opts.coverageStart ? new Date(opts.coverageStart) : null,
        coverageEnd: new Date(opts.coverageEnd),
        reviewStatusCode,
        reviewedByUserId: reviewStatusCode === 'pending' ? null : reviewerUserId,
        reviewedAt: reviewStatusCode === 'pending' ? null : new Date('2099-06-01T01:02:03.000Z'),
      },
      select: { id: true },
    });
  }

  async function givePolicyCoverage(
    memberId: string,
    opts: { coverageStart: string; coverageEnd: string; policyDeleted?: boolean },
  ): Promise<{ policyId: string; coverageId: string }> {
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
    const coverage = await prisma.teamInsuranceCoverage.create({
      data: { policyId: policy.id, memberId },
      select: { id: true },
    });
    return { policyId: policy.id, coverageId: coverage.id };
  }

  function registerSelf(
    authHeader: string,
    activityId: string,
    targetApp: INestApplication = app,
  ): request.Test {
    return request(httpServer(targetApp))
      .post('/api/app/v1/my/registrations')
      .set('Authorization', authHeader)
      .send({ activityId });
  }

  function registerAdmin(
    activityId: string,
    memberId: string,
    targetApp: INestApplication = app,
  ): request.Test {
    return request(httpServer(targetApp))
      .post(`/api/admin/v1/activities/${activityId}/registrations`)
      .set('Authorization', adminAuth)
      .send({ memberId });
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
    const source = await giveSelfInsurance(me.memberId, {
      coverageStart: '2099-01-01',
      coverageEnd: '2099-12-31',
    });
    const act = await createPublishedActivity(true);

    const res = await registerSelf(me.authHeader, act.id).expect(201);
    expect((res.body as ResBody).data.statusCode).toBe('pending');
    const registrationId = (res.body as ResBody).data.id as string;
    const evidence = await prisma.insuranceEligibilityEvidence.findMany({
      where: { activityRegistrationId: registrationId },
    });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      sourceKind: 'member_insurance',
      memberInsuranceId: source.id,
      teamInsuranceCoverageId: null,
      ownerKind: 'activity_registration',
      activityRegistrationId: registrationId,
      teamJoinApplicationId: null,
      sourceRevision: 0,
      sourceReviewedByUserId: reviewerUserId,
    });
    expect(evidence[0].sourceReviewedAt?.toISOString()).toBe('2099-06-01T01:02:03.000Z');
    expect(evidence[0].requiredFrom?.toISOString()).toBe('2099-07-01T00:00:00.000Z');
    expect(evidence[0].requiredThrough?.toISOString()).toBe('2099-07-01T00:00:00.000Z');
    expect(evidence[0].sourceCoverageStart?.toISOString()).toBe('2099-01-01T00:00:00.000Z');
    expect(evidence[0].sourceCoverageEnd?.toISOString()).toBe('2099-12-31T00:00:00.000Z');
    expect(JSON.stringify(evidence[0])).not.toMatch(
      /insurer|policyNumber|note|reason|image|attachment|key|url/i,
    );
  });

  it.each(['pending', 'rejected'] as const)(
    '②c %s 自购保险不能满足 requiresInsurance，拒 26030 且无 evidence',
    async (reviewStatusCode) => {
      const me = await setupLinkedUser(`gate-self-${reviewStatusCode}`);
      await giveSelfInsurance(me.memberId, {
        coverageStart: '2099-01-01',
        coverageEnd: '2099-12-31',
        reviewStatusCode,
      });
      const act = await createPublishedActivity(true);
      const res = await registerSelf(me.authHeader, act.id);
      expectBizError(res, BizCode.INSURANCE_REQUIRED);
      expect(
        await prisma.insuranceEligibilityEvidence.count({
          where: { activityRegistration: { activityId: act.id, memberId: me.memberId } },
        }),
      ).toBe(0);
    },
  );

  it('②b 自购无起保日(coverageStart=null)且到期覆盖 → 通过(起保可选不参与校验)', async () => {
    const me = await setupLinkedUser('gate-self-nostart');
    await giveSelfInsurance(me.memberId, { coverageStart: null, coverageEnd: '2099-12-31' });
    const act = await createPublishedActivity(true);
    await registerSelf(me.authHeader, act.id).expect(201);
  });

  // ============== ③ 开 + 队保单覆盖 → 通过 ==============

  it('③ 开 + 队保单覆盖名单内(保单期覆盖活动)→ 报名成功;admin 代报名同语义', async () => {
    const me = await setupLinkedUser('gate-policy-ok');
    const source = await givePolicyCoverage(me.memberId, {
      coverageStart: '2099-01-01',
      coverageEnd: '2099-12-31',
    });
    const act = await createPublishedActivity(true);

    const selfRes = await registerSelf(me.authHeader, act.id).expect(201);
    const selfRegistrationId = (selfRes.body as ResBody).data.id as string;

    // admin 代报名路径同样通过(另一活动避免重复报名约束)
    const act2 = await createPublishedActivity(true);
    const adminRes = await registerAdmin(act2.id, me.memberId).expect(201);
    const adminRegistrationId = (adminRes.body as ResBody).data.id as string;

    for (const registrationId of [selfRegistrationId, adminRegistrationId]) {
      const evidence = await prisma.insuranceEligibilityEvidence.findMany({
        where: { activityRegistrationId: registrationId },
      });
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({
        sourceKind: 'team_insurance_coverage',
        memberInsuranceId: null,
        teamInsuranceCoverageId: source.coverageId,
        ownerKind: 'activity_registration',
        activityRegistrationId: registrationId,
        teamJoinApplicationId: null,
        sourceRevision: null,
        sourceReviewedByUserId: null,
        sourceReviewedAt: null,
      });
    }
  });

  it('来源选择固定 verified self 优先，并逐列执行 self 稳定排序', async () => {
    const me = await setupLinkedUser('gate-source-order-self');
    await givePolicyCoverage(me.memberId, {
      coverageStart: '2090-01-01',
      coverageEnd: '2100-12-31',
    });
    const common = {
      memberId: me.memberId,
      insurerName: '排序保险',
      coverageEnd: new Date('2099-12-31T00:00:00.000Z'),
      reviewStatusCode: 'verified',
      reviewedByUserId: reviewerUserId,
    } as const;
    await prisma.memberInsurance.createMany({
      data: [
        {
          ...common,
          id: 'self-order-z-start',
          policyNumber: 'z-start',
          coverageStart: new Date('2099-05-01T00:00:00.000Z'),
          reviewedAt: new Date('2099-06-10T00:00:00.000Z'),
        },
        {
          ...common,
          id: 'self-order-z-review',
          policyNumber: 'z-review',
          coverageStart: new Date('2099-06-01T00:00:00.000Z'),
          reviewedAt: new Date('2099-06-10T00:00:00.000Z'),
        },
        {
          ...common,
          id: 'self-order-b-id',
          policyNumber: 'b-id',
          coverageStart: new Date('2099-06-01T00:00:00.000Z'),
          reviewedAt: new Date('2099-06-20T00:00:00.000Z'),
        },
        {
          ...common,
          id: 'self-order-a-id',
          policyNumber: 'a-id',
          coverageStart: new Date('2099-06-01T00:00:00.000Z'),
          reviewedAt: new Date('2099-06-20T00:00:00.000Z'),
        },
      ],
    });
    const act = await createPublishedActivity(true);
    const res = await registerSelf(me.authHeader, act.id).expect(201);
    const evidence = await prisma.insuranceEligibilityEvidence.findFirstOrThrow({
      where: { activityRegistrationId: (res.body as ResBody).data.id as string },
    });
    expect(evidence.sourceKind).toBe('member_insurance');
    expect(evidence.memberInsuranceId).toBe('self-order-a-id');
  });

  it('team source 稳定排序 policy coverageEnd/start/id（coverage.id 为最终稳定项）', async () => {
    const me = await setupLinkedUser('gate-source-order-team');
    const policies = [
      ['team-order-z-start', '2090-01-01'],
      ['team-order-z-id', '2098-01-01'],
      ['team-order-a-id', '2098-01-01'],
    ] as const;
    for (const [id, coverageStart] of policies) {
      await prisma.teamInsurancePolicy.create({
        data: {
          id,
          insurerName: '排序队保',
          policyNumber: id,
          coverageStart: new Date(`${coverageStart}T00:00:00.000Z`),
          coverageEnd: new Date('2100-12-31T00:00:00.000Z'),
        },
      });
    }
    await prisma.teamInsuranceCoverage.createMany({
      data: [
        { id: 'team-coverage-a', policyId: 'team-order-a-id', memberId: me.memberId },
        { id: 'team-coverage-other', policyId: 'team-order-z-id', memberId: me.memberId },
      ],
    });
    const act = await createPublishedActivity(true);
    const res = await registerSelf(me.authHeader, act.id).expect(201);
    const evidence = await prisma.insuranceEligibilityEvidence.findFirstOrThrow({
      where: { activityRegistrationId: (res.body as ResBody).data.id as string },
    });
    expect(evidence.teamInsuranceCoverageId).toBe('team-coverage-a');
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

  it('两 Nest/两 pool barrier:add 按 Policy→Coverage→Member 等待 Activity source，无 40P01', async () => {
    const covered = await setupLinkedUser('gate-lock-add-covered');
    const target = await setupLinkedUser('gate-lock-add-target');
    const source = await givePolicyCoverage(covered.memberId, {
      coverageStart: '2099-01-01',
      coverageEnd: '2099-12-31',
    });
    const act = await createPublishedActivity(true);
    const requirement = app.get(InsuranceRequirementService);
    const original = requirement.createActivityRegistrationEvidence.bind(requirement);
    let release!: () => void;
    let reached!: (pid: number) => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reachedPromise = new Promise<number>((resolve) => {
      reached = resolve;
    });
    const barrier = jest
      .spyOn(requirement, 'createActivityRegistrationEvidence')
      .mockImplementation(async (...args) => {
        const rows = await args[3].$queryRaw<Array<{ pid: number }>>(
          Prisma.sql`SELECT pg_backend_pid() AS pid`,
        );
        reached(rows[0].pid);
        await releasePromise;
        return original(...args);
      });

    try {
      const registration = registerSelf(covered.authHeader, act.id).then((res) => res);
      const blockerPid = await withTimeout(reachedPromise, 'activity evidence barrier');
      const add = request(httpServer(appB))
        .post(`/api/admin/v1/team-insurance-policies/${source.policyId}/members`)
        .set('Authorization', adminAuth)
        .send({ memberId: target.memberId })
        .then((res) => res);
      await waitForBlockedQuery(blockerPid, '%FROM "team_insurance_policies"%FOR UPDATE%');
      release();
      const [registrationRes, addRes] = await Promise.all([registration, add]);
      expect(registrationRes.status).toBe(201);
      expect(addRes.status).toBe(201);
      expect(addRes.body.code).toBe(0);
    } finally {
      release();
      barrier.mockRestore();
    }
    expect(
      await prismaB.teamInsuranceCoverage.count({
        where: { policyId: source.policyId, memberId: target.memberId, deletedAt: null },
      }),
    ).toBe(1);
  });

  it('两 Nest/两 pool barrier:remove 等待 Activity source，快照提交后移除且无 40P01', async () => {
    const me = await setupLinkedUser('gate-lock-remove-covered');
    const source = await givePolicyCoverage(me.memberId, {
      coverageStart: '2099-01-01',
      coverageEnd: '2099-12-31',
    });
    const act = await createPublishedActivity(true);
    const requirement = app.get(InsuranceRequirementService);
    const original = requirement.createActivityRegistrationEvidence.bind(requirement);
    let release!: () => void;
    let reached!: (pid: number) => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reachedPromise = new Promise<number>((resolve) => {
      reached = resolve;
    });
    const barrier = jest
      .spyOn(requirement, 'createActivityRegistrationEvidence')
      .mockImplementation(async (...args) => {
        const rows = await args[3].$queryRaw<Array<{ pid: number }>>(
          Prisma.sql`SELECT pg_backend_pid() AS pid`,
        );
        reached(rows[0].pid);
        await releasePromise;
        return original(...args);
      });

    try {
      const registration = registerSelf(me.authHeader, act.id).then((res) => res);
      const blockerPid = await withTimeout(reachedPromise, 'activity remove barrier');
      const removal = request(httpServer(appB))
        .delete(`/api/admin/v1/team-insurance-policies/${source.policyId}/members/${me.memberId}`)
        .set('Authorization', adminAuth)
        .then((res) => res);
      await waitForBlockedQuery(blockerPid, '%FROM "team_insurance_policies"%FOR UPDATE%');
      release();
      const [registrationRes, removeRes] = await Promise.all([registration, removal]);
      expect(registrationRes.status).toBe(201);
      expect(removeRes.status).toBe(200);
    } finally {
      release();
      barrier.mockRestore();
    }
    expect(
      await prisma.insuranceEligibilityEvidence.count({
        where: { teamInsuranceCoverageId: source.coverageId },
      }),
    ).toBe(1);
    expect(
      await prisma.teamInsuranceCoverage.findUniqueOrThrow({ where: { id: source.coverageId } }),
    ).toMatchObject({ deletedAt: expect.any(Date) });
  });

  it('两 Nest/两 pool barrier:activity flag update 先提交 true，报名锁后重读并拒 26030', async () => {
    const me = await setupLinkedUser('gate-lock-activity-flag');
    const act = await createPublishedActivity(false);
    const recorder = appB.get(ActivityAuditRecorder);
    const original = recorder.logUpdate.bind(recorder);
    let release!: () => void;
    let reached!: (pid: number) => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reachedPromise = new Promise<number>((resolve) => {
      reached = resolve;
    });
    const barrier = jest.spyOn(recorder, 'logUpdate').mockImplementation(async (...args) => {
      const rows = await args[0].tx.$queryRaw<Array<{ pid: number }>>(
        Prisma.sql`SELECT pg_backend_pid() AS pid`,
      );
      reached(rows[0].pid);
      await releasePromise;
      return original(...args);
    });
    const update = request(httpServer(appB))
      .patch(`/api/admin/v1/activities/${act.id}`)
      .set('Authorization', adminAuth)
      .send({ requiresInsurance: true })
      .then((res) => res);
    const blockerPid = await withTimeout(reachedPromise, 'activity flag update barrier');
    const registration = registerSelf(me.authHeader, act.id).then((res) => res);
    try {
      await waitForBlockedQuery(blockerPid, '%FROM "Activity"%FOR UPDATE%');
      release();
      const [updateRes, registrationRes] = await Promise.all([update, registration]);
      expect(updateRes.status).toBe(200);
      expect(registrationRes.status).toBe(BizCode.INSURANCE_REQUIRED.httpStatus);
      expect(registrationRes.body.code).toBe(BizCode.INSURANCE_REQUIRED.code);
    } finally {
      release();
      await Promise.allSettled([update, registration]);
      barrier.mockRestore();
    }
    expect(
      await prisma.activityRegistration.count({
        where: { activityId: act.id, memberId: me.memberId },
      }),
    ).toBe(0);
  });

  it('两 Nest/两 pool barrier:同 owner 双报名串行，恰一 registration/evidence', async () => {
    const me = await setupLinkedUser('gate-lock-duplicate-owner');
    await giveSelfInsurance(me.memberId, {
      coverageStart: '2099-01-01',
      coverageEnd: '2099-12-31',
    });
    const act = await createPublishedActivity(true);
    const requirement = app.get(InsuranceRequirementService);
    const original = requirement.createActivityRegistrationEvidence.bind(requirement);
    let release!: () => void;
    let reached!: (pid: number) => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reachedPromise = new Promise<number>((resolve) => {
      reached = resolve;
    });
    const barrier = jest
      .spyOn(requirement, 'createActivityRegistrationEvidence')
      .mockImplementation(async (...args) => {
        const rows = await args[3].$queryRaw<Array<{ pid: number }>>(
          Prisma.sql`SELECT pg_backend_pid() AS pid`,
        );
        reached(rows[0].pid);
        await releasePromise;
        return original(...args);
      });

    try {
      const selfRegistration = registerSelf(me.authHeader, act.id).then((res) => res);
      const blockerPid = await withTimeout(reachedPromise, 'duplicate owner barrier');
      const adminRegistration = registerAdmin(act.id, me.memberId, appB).then((res) => res);
      await waitForBlockedQuery(blockerPid, '%FROM "Activity"%FOR UPDATE%');
      release();
      const [winner, loser] = await Promise.all([selfRegistration, adminRegistration]);
      expect(winner.status).toBe(201);
      expect(loser.status).toBe(BizCode.ACTIVITY_REGISTRATION_ALREADY_EXISTS.httpStatus);
      expect(loser.body.code).toBe(BizCode.ACTIVITY_REGISTRATION_ALREADY_EXISTS.code);
    } finally {
      release();
      barrier.mockRestore();
    }

    const registrations = await prisma.activityRegistration.findMany({
      where: { activityId: act.id, memberId: me.memberId },
      select: { id: true },
    });
    expect(registrations).toHaveLength(1);
    expect(
      await prisma.insuranceEligibilityEvidence.count({
        where: { activityRegistrationId: registrations[0].id },
      }),
    ).toBe(1);
  });

  it('两 Nest/两 pool barrier:App self edit 先持 source 锁，报名等待后按新 pending 事实 26030', async () => {
    const me = await setupLinkedUser('gate-lock-stale-source');
    const source = await giveSelfInsurance(me.memberId, {
      coverageStart: '2099-01-01',
      coverageEnd: '2099-12-31',
    });
    const act = await createPublishedActivity(true);
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
    const barrier = jest.spyOn(auditLogsB, 'log').mockImplementation(async (...args) => {
      const input = args[0];
      if (
        input.event === 'member-insurance.update.self' &&
        input.resourceId === source.id &&
        input.tx
      ) {
        const rows = await input.tx.$queryRaw<Array<{ pid: number }>>(
          Prisma.sql`SELECT pg_backend_pid() AS pid`,
        );
        reached(rows[0].pid);
        await releasePromise;
      }
      return originalLog(...args);
    });
    const edit = request(httpServer(appB))
      .patch(`/api/app/v1/me/insurances/${source.id}`)
      .set('Authorization', me.authHeader)
      .send({ insurerName: '并发编辑后 pending', expectedVersion: 0 })
      .then((res) => res);
    const blockerPid = await withTimeout(reachedPromise, 'self edit audit barrier');
    const registration = registerSelf(me.authHeader, act.id).then((res) => res);
    try {
      await waitForBlockedQuery(blockerPid, '%FROM "member_insurances"%FOR SHARE%');
      release();
      const [editRes, registrationRes] = await Promise.all([edit, registration]);
      expect(editRes.status).toBe(200);
      expect(registrationRes.status).toBe(BizCode.INSURANCE_REQUIRED.httpStatus);
      expect(registrationRes.body.code).toBe(BizCode.INSURANCE_REQUIRED.code);
    } finally {
      release();
      await Promise.allSettled([edit, registration]);
      barrier.mockRestore();
    }
    expect(
      await prisma.activityRegistration.count({
        where: { activityId: act.id, memberId: me.memberId },
      }),
    ).toBe(0);
    expect(
      await prisma.insuranceEligibilityEvidence.count({
        where: { memberInsuranceId: source.id },
      }),
    ).toBe(0);
  });

  it('evidence PostgreSQL 写失败使报名根事务全回滚', async () => {
    const me = await setupLinkedUser('gate-evidence-failure');
    const source = await giveSelfInsurance(me.memberId, {
      coverageStart: '2099-01-01',
      coverageEnd: '2099-12-31',
    });
    const act = await createPublishedActivity(true);
    const sentinelId = `evidence-failure-${nextSeq()}`;
    const sourceSnapshot = await prisma.memberInsurance.findUniqueOrThrow({
      where: { id: source.id },
      select: {
        version: true,
        reviewedByUserId: true,
        reviewedAt: true,
        coverageStart: true,
        coverageEnd: true,
      },
    });
    const sentinelActivity = await createPublishedActivity(false);
    const sentinelOwner = await prisma.activityRegistration.create({
      data: {
        activityId: sentinelActivity.id,
        memberId: me.memberId,
        statusCode: 'pending',
      },
      select: { id: true },
    });
    await prisma.insuranceEligibilityEvidence.create({
      data: {
        id: sentinelId,
        sourceKind: 'member_insurance',
        memberInsuranceId: source.id,
        ownerKind: 'activity_registration',
        activityRegistrationId: sentinelOwner.id,
        sourceRevision: sourceSnapshot.version,
        sourceReviewedByUserId: sourceSnapshot.reviewedByUserId,
        sourceReviewedAt: sourceSnapshot.reviewedAt,
        requiredFrom: new Date('2099-07-01T00:00:00.000Z'),
        requiredThrough: new Date('2099-07-01T00:00:00.000Z'),
        sourceCoverageStart: sourceSnapshot.coverageStart,
        sourceCoverageEnd: sourceSnapshot.coverageEnd,
      },
    });

    const requirement = app.get(InsuranceRequirementService);
    const failure = jest
      .spyOn(requirement, 'createActivityRegistrationEvidence')
      .mockImplementation(async (registrationId, _memberId, decision, tx) => {
        if (!decision) throw new Error('insurance decision unexpectedly missing');
        const decisionSource = decision.source;
        await tx.insuranceEligibilityEvidence.create({
          data: {
            id: sentinelId,
            sourceKind: decisionSource.kind,
            memberInsuranceId:
              decisionSource.kind === 'member_insurance' ? decisionSource.memberInsuranceId : null,
            teamInsuranceCoverageId:
              decisionSource.kind === 'team_insurance_coverage'
                ? decisionSource.teamInsuranceCoverageId
                : null,
            ownerKind: 'activity_registration',
            activityRegistrationId: registrationId,
            teamJoinApplicationId: null,
            sourceRevision: decisionSource.sourceRevision,
            sourceReviewedByUserId: decisionSource.sourceReviewedByUserId,
            sourceReviewedAt: decisionSource.sourceReviewedAt,
            requiredFrom: decision.requiredFrom,
            requiredThrough: decision.requiredThrough,
            sourceCoverageStart: decisionSource.coverageStart,
            sourceCoverageEnd: decisionSource.coverageEnd,
          },
        });
      });
    try {
      await registerSelf(me.authHeader, act.id).expect(500);
    } finally {
      failure.mockRestore();
    }

    expect(
      await prisma.activityRegistration.count({
        where: { activityId: act.id, memberId: me.memberId },
      }),
    ).toBe(0);
    expect(
      await prisma.insuranceEligibilityEvidence.count({
        where: { activityRegistration: { activityId: act.id, memberId: me.memberId } },
      }),
    ).toBe(0);
    expect(await prisma.insuranceEligibilityEvidence.count({ where: { id: sentinelId } })).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: {
          event: 'registration.create',
          context: { path: ['extra', 'memberId'], equals: me.memberId },
        },
      }),
    ).toBe(0);
  });

  it('registration audit 失败回滚 registration 与已写 evidence', async () => {
    const me = await setupLinkedUser('gate-audit-failure');
    await giveSelfInsurance(me.memberId, {
      coverageStart: '2099-01-01',
      coverageEnd: '2099-12-31',
    });
    const act = await createPublishedActivity(true);
    const auditCountBefore = await prisma.auditLog.count({
      where: { event: 'registration.create', resourceType: 'activity_registration' },
    });
    const recorder = app.get(ActivityRegistrationAuditRecorder);
    const failure = jest
      .spyOn(recorder, 'logCreate')
      .mockRejectedValueOnce(new Error('audit boom'));
    try {
      await registerSelf(me.authHeader, act.id).expect(500);
    } finally {
      failure.mockRestore();
    }
    expect(
      await prisma.activityRegistration.count({
        where: { activityId: act.id, memberId: me.memberId },
      }),
    ).toBe(0);
    expect(
      await prisma.insuranceEligibilityEvidence.count({
        where: { memberInsurance: { memberId: me.memberId } },
      }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { event: 'registration.create', resourceType: 'activity_registration' },
      }),
    ).toBe(auditCountBefore);
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
      coverageStart: '2099-01-01',
      coverageEnd: '2099-06-01', // 活动 2099-07-01,已过期
    });
    const act = await createPublishedActivity(true);

    const res = await registerSelf(me.authHeader, act.id);
    expectBizError(res, BizCode.INSURANCE_REQUIRED);
  });

  // ============== 边界 ==============

  it('边界:coverageEnd = 活动结束日当天 → 通过(到期≥活动日期含等号,北京日粒度)', async () => {
    const me = await setupLinkedUser('gate-boundary-eq');
    await giveSelfInsurance(me.memberId, {
      coverageStart: '2099-01-01',
      coverageEnd: '2099-07-01', // = 活动归一日
    });
    const act = await createPublishedActivity(true);
    await registerSelf(me.authHeader, act.id).expect(201);
  });

  it('边界:coverageStart > 活动开始日(起保太晚)→ 26030', async () => {
    const me = await setupLinkedUser('gate-boundary-late');
    await giveSelfInsurance(me.memberId, {
      coverageStart: '2099-07-02', // 晚于活动开始日 2099-07-01
      coverageEnd: '2099-12-31',
    });
    const act = await createPublishedActivity(true);

    const res = await registerSelf(me.authHeader, act.id);
    expectBizError(res, BizCode.INSURANCE_REQUIRED);
  });

  it('边界:队保单已软删 → 覆盖失效 → 26030(E-4 不级联但 join 失效)', async () => {
    const me = await setupLinkedUser('gate-policy-deleted');
    await givePolicyCoverage(me.memberId, {
      coverageStart: '2099-01-01',
      coverageEnd: '2099-12-31',
      policyDeleted: true,
    });
    const act = await createPublishedActivity(true);

    const res = await registerSelf(me.authHeader, act.id);
    expectBizError(res, BizCode.INSURANCE_REQUIRED);
  });

  it('快照:报名成功后删除保险不回溯(报名仍 pending;E-12)', async () => {
    const me = await setupLinkedUser('gate-snapshot');
    const source = await giveSelfInsurance(me.memberId, {
      coverageStart: '2099-01-01',
      coverageEnd: '2099-12-31',
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
    expect(
      await prisma.insuranceEligibilityEvidence.count({
        where: { activityRegistrationId: regId, memberInsuranceId: source.id },
      }),
    ).toBe(1);

    const nextAct = await createPublishedActivity(true);
    expectBizError(await registerSelf(me.authHeader, nextAct.id), BizCode.INSURANCE_REQUIRED);
    expect(
      await prisma.activityRegistration.count({
        where: { activityId: nextAct.id, memberId: me.memberId },
      }),
    ).toBe(0);
    expect(
      await prisma.insuranceEligibilityEvidence.count({
        where: { memberInsuranceId: source.id },
      }),
    ).toBe(1);
  });

  describe('性别报名闸', () => {
    it('限定性别但无 MemberProfile → admin 代报名拒 21034', async () => {
      const me = await setupLinkedUser('gender-no-profile');
      const act = await createPublishedActivity(false, 'male');
      const res = await registerAdmin(act.id, me.memberId);
      expectBizError(res, BizCode.ACTIVITY_REGISTRATION_GENDER_MISMATCH);
    });

    it('MemberProfile 性别不匹配 → App 自助报名拒 21034', async () => {
      const me = await setupLinkedUser('gender-mismatch');
      await createMemberProfile(me.memberId, 'male');
      const act = await createPublishedActivity(false, 'female');
      const res = await registerSelf(me.authHeader, act.id);
      expectBizError(res, BizCode.ACTIVITY_REGISTRATION_GENDER_MISMATCH);
    });

    it('MemberProfile 性别匹配 → admin 代报名成功', async () => {
      const me = await setupLinkedUser('gender-match');
      await createMemberProfile(me.memberId, 'male');
      const act = await createPublishedActivity(false, 'male');
      await registerAdmin(act.id, me.memberId).expect(201);
    });
  });
});
