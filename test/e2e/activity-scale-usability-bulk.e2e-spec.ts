import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, BindingStatus, MemberStatus, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { extractMethodSource } from '../helpers/source-span';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

/**
 * AC-068「500/2000/10000 人操作均不要求业务人员手工拆 200 人数组」。
 *
 * 交付的**不是**「把 500 改大」—— 合同追踪矩阵 I55 判定现有批量上限「当前合理,保留现有
 * 正确方向」,开发文档 §11.5 又明写 item 批次「不形成业务上限」。交付的是**第二种入口**:
 * 提交选择条件,服务端在 SQL 里把整场次展开成任务项。
 *
 * 三个资源问题的答法(2000 人档,读数见本 spec 末尾那条用例):
 *   - **事务预算**:入队恒 4 条语句(锁 + 判权 + 建 job + 一条 INSERT ... SELECT),
 *     不随人数增加往返次数。
 *   - **锁持有**:Activity 咨询锁只在这 4 条语句期间持有,不覆盖任何逐人业务写入。
 *   - **worker 领取**:一字未改 —— 逐 item 各起一个短事务,单项锁持有时长与总人数无关。
 */

const BULK_SELECTION_SCALE = 2000;
/**
 * 条件式入队的墙钟上界 = 本仓生产交互事务预算。刻意绑到预算本身而不是另写一个手写数字:
 * 判据要说的是「2000 人不撑爆事务预算」,不是「比某个数快」。
 */
const TX_BUDGET_MS = 5_000;
const LEGACY_ARRAY_MAX = 500;

interface Scenario {
  activityId: string;
  sessionId: string;
  positionId: string;
}

describe('activity scale usability: onsite bulk punch without manual splitting', () => {
  const previousResponsibilityWorkflow = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
  const previousV11Workflow = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  let app: INestApplication;
  let prisma: PrismaService;
  let managerAuth: string;
  let managerUserId: string;
  let managerMemberId: string;
  let applicantAuth: string;
  let applicantMemberId: string;
  let otherApplicantAuth: string;
  let otherApplicantMemberId: string;
  let activityOwnerRoleId: string;
  let sequence = 0;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    activityOwnerRoleId = (await seedActivityResponsibilitySystemRoles(app))['activity-owner'];

    const [manager, applicant, otherApplicant] = await Promise.all([
      createTestUser(app, { username: 'scale-bulk-manager', role: Role.USER }),
      createTestUser(app, { username: 'scale-bulk-applicant', role: Role.USER }),
      createTestUser(app, { username: 'scale-bulk-other-applicant', role: Role.USER }),
    ]);
    const [managerMember, applicantMember, otherApplicantMember] = await Promise.all([
      createMember('SCALE-BULK-MANAGER', 'Scale Bulk Manager'),
      createMember('SCALE-BULK-APPLICANT', 'Scale Bulk Applicant'),
      createMember('SCALE-BULK-OTHER', 'Scale Bulk Other'),
    ]);
    managerUserId = manager.id;
    managerMemberId = managerMember;
    applicantMemberId = applicantMember;
    otherApplicantMemberId = otherApplicantMember;
    await Promise.all([
      prisma.user.update({ where: { id: manager.id }, data: { memberId: managerMember } }),
      prisma.user.update({ where: { id: applicant.id }, data: { memberId: applicantMember } }),
      prisma.user.update({
        where: { id: otherApplicant.id },
        data: { memberId: otherApplicantMember },
      }),
    ]);
    [managerAuth, applicantAuth, otherApplicantAuth] = await Promise.all([
      loginAs(app, manager.username).then(({ authHeader }) => authHeader),
      loginAs(app, applicant.username).then(({ authHeader }) => authHeader),
      loginAs(app, otherApplicant.username).then(({ authHeader }) => authHeader),
    ]);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    restoreEnv('ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED', previousResponsibilityWorkflow);
    restoreEnv('ACTIVITY_V11_WORKFLOW_ENABLED', previousV11Workflow);
  });

  function restoreEnv(key: string, previous: string | undefined): void {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }

  async function createMember(memberNo: string, displayName: string): Promise<string> {
    const member = await prisma.member.create({
      data: { memberNo, displayName, gradeCode: 'L1', status: MemberStatus.ACTIVE },
      select: { id: true },
    });
    return member.id;
  }

  async function createScenario(capacity = 10_000): Promise<Scenario> {
    const index = ++sequence;
    const now = new Date();
    const startAt = new Date(now.getTime() - 10 * 60_000);
    const endAt = new Date(now.getTime() + 2 * 60 * 60_000);
    const organization = await prisma.organization.create({
      data: { name: `Scale Bulk Team ${index}`, nodeTypeCode: 'scale-bulk-team' },
      select: { id: true },
    });
    const activity = await prisma.activity.create({
      data: {
        title: `Scale Bulk Activity ${index}`,
        activityTypeCode: 'training',
        organizationId: organization.id,
        startAt,
        endAt,
        location: 'Scale Bulk Field',
        statusCode: 'published',
        publishedAt: now,
        capacity,
        isPublicRegistration: true,
        allocationModeCode: 'first_come',
        registrationDeadline: new Date(now.getTime() + 60 * 60_000),
      },
      select: { id: true },
    });
    const publishReview = await prisma.activityPublishReview.create({
      data: {
        activityId: activity.id,
        requestType: 'initial',
        requestVersion: 1,
        baseRevision: 0,
        status: 'approved',
        snapshot: {},
        directPublish: true,
        submittedByUserId: managerUserId,
        reviewedByUserId: managerUserId,
        reviewedAt: now,
      },
      select: { id: true },
    });
    await prisma.activityRuleSnapshot.create({
      data: {
        activityId: activity.id,
        workflowRevision: 0,
        resolvedConfig: {},
        snapshotHash: 'b'.repeat(64),
        createdByReviewId: publishReview.id,
      },
    });
    const session = await prisma.activitySession.create({
      data: {
        activityId: activity.id,
        code: `scale-bulk-session-${index}`,
        name: `Scale Bulk Session ${index}`,
        startAt,
        endAt,
        locationText: 'Scale Bulk Field',
        capacity,
        checkInOpenAt: new Date(now.getTime() - 30 * 60_000),
        checkInCloseAt: new Date(now.getTime() + 30 * 60_000),
        checkOutOpenAt: new Date(now.getTime() - 30 * 60_000),
        checkOutCloseAt: new Date(now.getTime() + 3 * 60 * 60_000),
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });
    const position = await prisma.activitySessionPosition.create({
      data: {
        activityId: activity.id,
        sessionId: session.id,
        code: `scale-bulk-position-${index}`,
        name: `Scale Bulk Position ${index}`,
        attendanceRoleCode: 'volunteer',
        capacity,
      },
      select: { id: true },
    });
    await prisma.activityCapacityBucket.createMany({
      data: [
        {
          activityId: activity.id,
          scopeTypeCode: 'activity_person',
          scopeId: activity.id,
          capacity,
        },
        {
          activityId: activity.id,
          scopeTypeCode: 'session_participation',
          scopeId: session.id,
          capacity,
        },
        {
          activityId: activity.id,
          scopeTypeCode: 'position_participation',
          scopeId: position.id,
          capacity,
        },
      ],
    });
    await prisma.activityEvidenceState.create({ data: { activityId: activity.id } });
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: activity.id,
        memberId: managerMemberId,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: managerUserId,
        source: 'publish',
      },
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.MEMBER,
        principalId: managerMemberId,
        roleId: activityOwnerRoleId,
        scopeType: BindingScopeType.ACTIVITY,
        scopeActivityId: activity.id,
        status: BindingStatus.ACTIVE,
        note: `scale bulk fixture ${index}`,
      },
    });
    return { activityId: activity.id, sessionId: session.id, positionId: position.id };
  }

  /** 真实报名链路(HTTP)—— 用来证明「条件展开」认的就是真链路造出来的那批身份。 */
  async function submitMember(
    scenario: Scenario,
    input: { auth: string; memberId: string },
  ): Promise<string> {
    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/activities/${scenario.activityId}/registrations`)
      .set('Authorization', input.auth)
      .send({
        operationKey: `scale-bulk-register-${++sequence}`,
        formVersion: null,
        answers: [],
        preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
      });
    expect(submitted.status).toBe(201);
    const identity = await prisma.activityParticipationIdentity.findFirstOrThrow({
      where: {
        activityId: scenario.activityId,
        sessionId: scenario.sessionId,
        memberId: input.memberId,
      },
      select: { id: true },
    });
    return identity.id;
  }

  /**
   * 规模夹具:只为「不变量 5 的资源读数」服务,**不**用来证明链路连通(那由上面的
   * HTTP 报名用例负责)。用 generate_series 直插,免得夹具本身先撞 bind 上限。
   */
  async function seedIdentitiesInBulk(scenario: Scenario, count: number): Promise<void> {
    const tag = `bulkscale${++sequence}`;
    await prisma.$executeRaw`
      INSERT INTO "Member" ("id", "createdAt", "updatedAt", "memberNo", "displayName", "status")
      SELECT gen_random_uuid()::text, NOW(), NOW(),
             ${tag} || '-' || lpad(g::text, 6, '0'),
             '规模夹具 ' || g::text, 'ACTIVE'
      FROM generate_series(1, ${count}::int) g
    `;
    await prisma.$executeRaw`
      INSERT INTO "ActivityRegistration" (
        "id", "createdAt", "updatedAt", "activityId", "memberId", "statusCode", "registeredAt"
      )
      SELECT gen_random_uuid()::text, NOW(), NOW(), ${scenario.activityId}, m."id", 'pass', NOW()
      FROM "Member" m
      WHERE m."memberNo" LIKE ${`${tag}-%`}
    `;
    await prisma.$executeRaw`
      INSERT INTO "ActivityParticipationIdentity" (
        "id", "createdAt", "updatedAt", "activityId", "sessionId", "registrationId",
        "memberId", "currentStatusCode", "currentPositionId"
      )
      SELECT gen_random_uuid()::text, NOW(), NOW(), ${scenario.activityId}, ${scenario.sessionId},
             r."id", r."memberId", 'pass', ${scenario.positionId}
      FROM "ActivityRegistration" r
      JOIN "Member" m ON m."id" = r."memberId"
      WHERE m."memberNo" LIKE ${`${tag}-%`}
    `;
  }

  function bulkUrl(scenario: Scenario): string {
    return (
      `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/${scenario.sessionId}` +
      '/bulk-punch-jobs'
    );
  }

  async function postBulk(
    scenario: Scenario,
    body: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(httpServer(app))
      .post(bulkUrl(scenario))
      .set('Authorization', managerAuth)
      .send(body);
  }

  // ==========================================================================
  // 条件式入队:整场次一次提交,不用手工拆
  // ==========================================================================

  it('red-first: selection=session-all 把整场次展开成任务项,业务人员一条请求都不用拆', async () => {
    const scenario = await createScenario();
    const first = await submitMember(scenario, {
      auth: applicantAuth,
      memberId: applicantMemberId,
    });
    const second = await submitMember(scenario, {
      auth: otherApplicantAuth,
      memberId: otherApplicantMemberId,
    });

    const created = await postBulk(scenario, {
      operationKey: `scale-bulk-selection-${++sequence}`,
      actionCode: 'check_in',
      reason: '整场次集中签到',
      selection: { mode: 'session-all' },
    });
    expect(created.status).toBe(201);
    expect(created.body.code).toBe(0);
    const jobId = created.body.data.jobId as string;
    expect(created.body.data.total).toBe(2);

    const job = await prisma.activityBatchJob.findUniqueOrThrow({
      where: { id: jobId },
      select: {
        jobTypeCode: true,
        activityId: true,
        sessionId: true,
        statusCode: true,
        total: true,
        items: {
          select: { itemKey: true, resourceId: true, statusCode: true, resourceType: true },
        },
      },
    });
    expect(job).toMatchObject({
      jobTypeCode: 'bulk_proxy',
      activityId: scenario.activityId,
      sessionId: scenario.sessionId,
      statusCode: 'pending',
      total: 2,
    });
    // 比集合不比计数;两边先钉非空。
    expect(job.items.length).toBeGreaterThan(0);
    expect(new Set(job.items.map((item) => item.resourceId))).toEqual(new Set([first, second]));
    expect(new Set(job.items.map((item) => item.itemKey))).toEqual(
      new Set([`identity:${first}`, `identity:${second}`]),
    );
    expect(job.items.every((item) => item.statusCode === 'pending')).toBe(true);
    expect(job.items.every((item) => item.resourceType === 'activity_participation_identity')).toBe(
      true,
    );
  }, 180_000);

  it('selection 只认路径上那一场次:别的场次/别的活动的参与身份一个都不进来', async () => {
    const target = await createScenario();
    const other = await createScenario();
    const targetIdentity = await submitMember(target, {
      auth: applicantAuth,
      memberId: applicantMemberId,
    });
    const otherIdentity = await submitMember(other, {
      auth: applicantAuth,
      memberId: applicantMemberId,
    });
    expect(targetIdentity).not.toBe(otherIdentity);

    const created = await postBulk(target, {
      operationKey: `scale-bulk-scope-${++sequence}`,
      actionCode: 'check_in',
      reason: '只签本场次',
      selection: { mode: 'session-all' },
    });
    expect(created.status).toBe(201);
    const items = await prisma.activityBatchJobItem.findMany({
      where: { jobId: created.body.data.jobId as string },
      select: { resourceId: true },
    });
    expect(items.length).toBeGreaterThan(0);
    expect(items.map((item) => item.resourceId)).toEqual([targetIdentity]);
    expect(items.map((item) => item.resourceId)).not.toContain(otherIdentity);
  }, 180_000);

  it('selection 的可选条件按 statusCodes / positionId 收窄,且收窄只会变少不会变多', async () => {
    const scenario = await createScenario();
    const identity = await submitMember(scenario, {
      auth: applicantAuth,
      memberId: applicantMemberId,
    });
    const status = await prisma.activityParticipationIdentity.findUniqueOrThrow({
      where: { id: identity },
      select: { currentStatusCode: true, currentPositionId: true },
    });

    const matching = await postBulk(scenario, {
      operationKey: `scale-bulk-narrow-hit-${++sequence}`,
      actionCode: 'check_in',
      reason: '按状态收窄',
      selection: { mode: 'session-all', statusCodes: [status.currentStatusCode] },
    });
    expect(matching.status).toBe(201);
    expect(matching.body.data.total).toBe(1);

    // 收窄到一个没人命中的状态 ⇒ 没有操作对象,与显式入口的 @ArrayMinSize(1) 同义。
    const missing = await postBulk(scenario, {
      operationKey: `scale-bulk-narrow-miss-${++sequence}`,
      actionCode: 'check_in',
      reason: '按状态收窄到空集',
      selection: { mode: 'session-all', statusCodes: ['cancelled'] },
    });
    expectBizError(missing, BizCode.BAD_REQUEST, { strictMessage: false });
    // 空集不得留下半个 job。
    await expect(
      prisma.activityBatchJob.count({
        where: { operationKey: { contains: 'scale-bulk-narrow-miss' } },
      }),
    ).resolves.toBe(0);
  }, 180_000);

  it('两个入口恰好二选一:都给 400,都不给 400', async () => {
    const scenario = await createScenario();
    const identity = await submitMember(scenario, {
      auth: applicantAuth,
      memberId: applicantMemberId,
    });

    const both = await postBulk(scenario, {
      operationKey: `scale-bulk-both-${++sequence}`,
      actionCode: 'check_in',
      reason: '两个都给',
      participationIdentityIds: [identity],
      selection: { mode: 'session-all' },
    });
    expectBizError(both, BizCode.BAD_REQUEST, { strictMessage: false });

    const neither = await postBulk(scenario, {
      operationKey: `scale-bulk-neither-${++sequence}`,
      actionCode: 'check_in',
      reason: '两个都不给',
    });
    expectBizError(neither, BizCode.BAD_REQUEST, { strictMessage: false });
  }, 180_000);

  it('既有 id 列表入口零漂移:行为、500 条上限与重放判定都与改造前一致', async () => {
    const scenario = await createScenario();
    const identity = await submitMember(scenario, {
      auth: applicantAuth,
      memberId: applicantMemberId,
    });
    const operationKey = `scale-bulk-legacy-${++sequence}`;
    const body = {
      operationKey,
      actionCode: 'check_in' as const,
      reason: '显式 id 列表',
      participationIdentityIds: [identity, identity],
    };

    const created = await postBulk(scenario, body);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ total: 1, replayed: false });

    // 同 operationKey 同内容 ⇒ 重放,不是冲突。requestHash 若被改动过,这里会变 20xxx 冲突。
    const replayed = await postBulk(scenario, body);
    expect(replayed.status).toBe(201);
    expect(replayed.body.data).toMatchObject({
      jobId: created.body.data.jobId,
      replayed: true,
    });

    // 500 条上限原样保留 —— AC-068 的答法不是把它改大。
    const overLimit = await postBulk(scenario, {
      operationKey: `scale-bulk-overlimit-${++sequence}`,
      actionCode: 'check_in',
      reason: '超过 500 条',
      participationIdentityIds: Array.from(
        { length: LEGACY_ARRAY_MAX + 1 },
        (_, i) => `identity-${String(i).padStart(10, '0')}`,
      ),
    });
    expectBizError(overLimit, BizCode.BAD_REQUEST, { strictMessage: false });
  }, 180_000);

  // ==========================================================================
  // 不变量 5:2000 人的资源实测读数
  // ==========================================================================

  it(`不变量 5 —— ${BULK_SELECTION_SCALE} 人一次条件式入队不撑爆事务预算(实测读数)`, async () => {
    const scenario = await createScenario();
    await seedIdentitiesInBulk(scenario, BULK_SELECTION_SCALE);
    await expect(
      prisma.activityParticipationIdentity.count({
        where: { activityId: scenario.activityId, sessionId: scenario.sessionId },
      }),
    ).resolves.toBe(BULK_SELECTION_SCALE);

    const startedAt = process.hrtime.bigint();
    const created = await postBulk(scenario, {
      operationKey: `scale-bulk-2000-${++sequence}`,
      actionCode: 'check_in',
      reason: `${BULK_SELECTION_SCALE} 人现场集中签到`,
      selection: { mode: 'session-all' },
    });
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    expect(created.status).toBe(201);
    expect(created.body.data.total).toBe(BULK_SELECTION_SCALE);
    const itemCount = await prisma.activityBatchJobItem.count({
      where: { jobId: created.body.data.jobId as string },
    });
    expect(itemCount).toBe(BULK_SELECTION_SCALE);

    // 读数落盘,供报告引用(不是估算)。
    console.info(
      `[不变量 5 实测] ${BULK_SELECTION_SCALE} 人条件式入队端到端 ${elapsedMs.toFixed(1)}ms ` +
        `(事务预算 ${TX_BUDGET_MS}ms);job items 落库 ${itemCount} 条`,
    );
    expect(elapsedMs).toBeLessThan(TX_BUDGET_MS);
  }, 300_000);

  // ==========================================================================
  // 结构判据:入队的绑定参数不随人数增长
  // ==========================================================================

  it('结构判据 —— 条件式入队走 INSERT ... SELECT,绑定参数与人数无关', () => {
    const source = readFileSync(
      join(__dirname, '../../src/modules/attendances/attendance-onsite-batch-job.service.ts'),
      'utf8',
    );
    const body = extractMethodSource(source, 'private async createItemsFromSelection(');

    // ---- 自证 ①:抽取器必须真的抽到方法体。参数表里的内联对象类型曾把天真版本骗停在
    // 签名处 —— 那时 `toContain` 恒假(看着像判据红了),而 `not.toContain` 恒真(判据变空)。
    expect(
      extractMethodSource(
        'class X { private async f(a: B & { c: string }): Promise<void> { return MARKER; } }',
        'private async f(',
      ),
    ).toContain('MARKER');

    // ---- 自证 ②:探测器对「先取回 id 再逐行写」的样本必须报阳 ----
    const positiveControl = `
      const rows = await tx.activityParticipationIdentity.findMany({ where, select: { id: true } });
      await tx.activityBatchJobItem.createMany({ data: rows.map((r) => ({ resourceId: r.id })) });
    `;
    expect(hasPerRowEnqueue(positiveControl)).toBe(true);
    expect(hasPerRowEnqueue('await tx.$executeRaw`INSERT INTO "X" SELECT 1`')).toBe(false);

    // ---- 再报数 ----
    expect(hasPerRowEnqueue(body)).toBe(false);
    expect(body).toContain('INSERT INTO "ActivityBatchJobItem"');
    expect(body).toContain('FROM "ActivityParticipationIdentity" i');
    // 场次边界必须钉在 SQL 里,而不是靠调用方自觉。
    expect(body).toContain('i."activityId" = ${input.activityId}');
    expect(body).toContain('i."sessionId" = ${input.sessionId}');
  });
});

/** 「先把 id 取回应用层,再按行数写库」的字面形状 —— 那正是 bind 上限与内存两条约束的违反形态。 */
function hasPerRowEnqueue(body: string): boolean {
  return /findMany\s*\(/u.test(body) || /createMany\s*\(/u.test(body);
}
