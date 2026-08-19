import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, BindingStatus, MemberStatus, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';

import { PrismaService } from '../../src/database/prisma.service';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { ActivityBatchWorker } from '../../src/modules/activities/activity-batch.worker';
import { loginAs } from '../fixtures/auth.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

type Scenario = { activityId: string; sessionId: string; positionId: string };

const BASE = '/api/app/v1/my/activity-batch-jobs';

/**
 * 合同 §6.13 后台任务统一读面 + §9.9 界面口径的五条不变量。
 *
 * 每条都是 red-first + 变异 A/B(变异点写在各自的 `mutation:` 注释里,
 * 落在实现行而不是测试行 —— 削弱断言不改数据的变异证明不了任何事)。
 *
 * 另含合同 ADV-003 / ADV-023 两条对抗测试的真用例:
 *   - ADV-003「现场权限撤销与代签并发」——撤的是**现场权限**(责任分配),
 *     并发的对象是**代签**(proxy-punch)。不是「撤离线包 × 上传」那一条。
 *   - ADV-023「批量代签…运行一半时撤销操作者权限」——要求任务**已经跑掉一半**
 *     (真有 item 提交了副作用)之后再撤权,不是开跑前就没权限。
 */
describe('activity batch6 后台任务读面(§6.13)与撤权对抗', () => {
  const previousResponsibilityWorkflow = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
  let app: INestApplication;
  let peerApp: INestApplication;
  let prisma: PrismaService;
  let peerPrisma: PrismaService;
  let ownerAuth: string;
  let collaboratorAuth: string;
  let outsiderAuth: string;
  let adminAuth: string;
  let adminPeerAuth: string;
  let applicantAuth: string;
  let otherApplicantAuth: string;
  let ownerMemberId: string;
  let ownerUserId: string;
  let collaboratorMemberId: string;
  let applicantMemberId: string;
  let otherApplicantMemberId: string;
  let activityOwnerRoleId: string;
  let sequence = 0;

  beforeAll(async () => {
    // 第 7 批第 ③ 刀 —— 活动 v1.1 单一 cutover gate(合同 §16.2)。本 spec 驱动的是
    // **结算真相链**(打卡 / 封场 / 结算 / 账本 / 关账 / 更正),那条链按定义只在闸开时存在;
    // 闸关(默认 = 今天的行为)时这些写入口一律回 20153。故此处显式置真,
    // **断言一字未改** —— 改的只是这个 spec 声明自己跑在哪一侧闸。
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    peerApp = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    peerPrisma = peerApp.get(PrismaService);
    activityOwnerRoleId = (await seedActivityResponsibilitySystemRoles(app))['activity-owner'];

    const [owner, collaborator, outsider, admin, applicant, otherApplicant] = await Promise.all([
      createTestUser(app, { username: 'b6-jobs-owner', role: Role.USER }),
      createTestUser(app, { username: 'b6-jobs-collaborator', role: Role.USER }),
      createTestUser(app, { username: 'b6-jobs-outsider', role: Role.USER }),
      createTestUser(app, { username: 'b6-jobs-admin', role: Role.SUPER_ADMIN }),
      createTestUser(app, { username: 'b6-jobs-applicant', role: Role.USER }),
      createTestUser(app, { username: 'b6-jobs-other-applicant', role: Role.USER }),
    ]);
    const members = await Promise.all(
      [
        ['B6-JOBS-OWNER', 'Batch6 Jobs Owner'],
        ['B6-JOBS-COLLABORATOR', 'Batch6 Jobs Collaborator'],
        ['B6-JOBS-OUTSIDER', 'Batch6 Jobs Outsider'],
        ['B6-JOBS-ADMIN', 'Batch6 Jobs Admin'],
        ['B6-JOBS-APPLICANT', 'Batch6 Jobs Applicant'],
        ['B6-JOBS-OTHER-APPLICANT', 'Batch6 Jobs Other Applicant'],
      ].map(([memberNo, displayName]) =>
        prisma.member.create({
          data: { memberNo, displayName, gradeCode: 'L1', status: MemberStatus.ACTIVE },
          select: { id: true },
        }),
      ),
    );
    const users = [owner, collaborator, outsider, admin, applicant, otherApplicant];
    await Promise.all(
      users.map((user, index) =>
        prisma.user.update({ where: { id: user.id }, data: { memberId: members[index].id } }),
      ),
    );
    ownerMemberId = members[0].id;
    ownerUserId = owner.id;
    collaboratorMemberId = members[1].id;
    applicantMemberId = members[4].id;
    otherApplicantMemberId = members[5].id;

    [
      ownerAuth,
      collaboratorAuth,
      outsiderAuth,
      adminAuth,
      adminPeerAuth,
      applicantAuth,
      otherApplicantAuth,
    ] = await Promise.all([
      loginAs(app, owner.username).then(({ authHeader }) => authHeader),
      loginAs(app, collaborator.username).then(({ authHeader }) => authHeader),
      loginAs(app, outsider.username).then(({ authHeader }) => authHeader),
      loginAs(app, admin.username).then(({ authHeader }) => authHeader),
      loginAs(peerApp, admin.username).then(({ authHeader }) => authHeader),
      loginAs(app, applicant.username).then(({ authHeader }) => authHeader),
      loginAs(app, otherApplicant.username).then(({ authHeader }) => authHeader),
    ]);
  }, 120_000);

  afterAll(async () => {
    delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    await Promise.all([app.close(), peerApp.close()]);
    if (previousResponsibilityWorkflow === undefined) {
      delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousResponsibilityWorkflow;
    }
  });

  async function createScenario(capacity = 4): Promise<Scenario> {
    const index = ++sequence;
    const now = new Date();
    const startAt = new Date(now.getTime() - 10 * 60_000);
    const endAt = new Date(now.getTime() + 2 * 60 * 60_000);
    const organization = await prisma.organization.create({
      data: { name: `B6 Jobs Team ${index}`, nodeTypeCode: 'b6-jobs-team' },
      select: { id: true },
    });
    const activity = await prisma.activity.create({
      data: {
        title: `B6 Jobs Activity ${index}`,
        activityTypeCode: 'training',
        organizationId: organization.id,
        initiatorMemberId: ownerMemberId,
        startAt,
        endAt,
        location: 'B6 Jobs Field',
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
        submittedByUserId: ownerUserId,
        reviewedByUserId: ownerUserId,
        reviewedAt: now,
      },
      select: { id: true },
    });
    await prisma.activityRuleSnapshot.create({
      data: {
        activityId: activity.id,
        workflowRevision: 0,
        resolvedConfig: {},
        snapshotHash: 'a'.repeat(64),
        createdByReviewId: publishReview.id,
      },
    });
    const session = await prisma.activitySession.create({
      data: {
        activityId: activity.id,
        code: `b6-jobs-session-${index}`,
        name: `B6 Jobs Session ${index}`,
        startAt,
        endAt,
        locationText: 'B6 Jobs Field',
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
        code: `b6-jobs-position-${index}`,
        name: `B6 Jobs Position ${index}`,
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
        memberId: ownerMemberId,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: ownerUserId,
        source: 'publish',
      },
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.MEMBER,
        principalId: ownerMemberId,
        roleId: activityOwnerRoleId,
        scopeType: BindingScopeType.ACTIVITY,
        scopeActivityId: activity.id,
        status: BindingStatus.ACTIVE,
        note: `b6 jobs fixture ${index}`,
      },
    });
    return { activityId: activity.id, sessionId: session.id, positionId: position.id };
  }

  async function submitMember(
    scenario: Scenario,
    input: { auth: string; memberId: string },
  ): Promise<string> {
    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/activities/${scenario.activityId}/registrations`)
      .set('Authorization', input.auth)
      .send({
        operationKey: `b6-jobs-register-${++sequence}`,
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
   * 授予协办(带 canManageAttendance),返回 assignmentId 以便随后撤销。
   *
   * ⚠️ 协办资格(20035)要求本人在该活动有 `pass` 报名或在活动组织内有 ACTIVE 归属 ——
   *    所以这里先把协办人本人报进活动,再授权。
   */
  async function grantCollaborator(scenario: Scenario, reason: string): Promise<string> {
    await submitMember(scenario, { auth: collaboratorAuth, memberId: collaboratorMemberId });
    const created = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${scenario.activityId}/responsibilities/collaborators`)
      .set('Authorization', adminAuth)
      .send({
        memberId: collaboratorMemberId,
        canManageRegistrations: false,
        canManageAttendance: true,
        reason,
      });
    if (created.status !== 201) {
      throw new Error(
        `collaborator grant failed: ${created.status} ${JSON.stringify(created.body)}`,
      );
    }
    return created.body.data.id as string;
  }

  async function revokeCollaborator(scenario: Scenario, assignmentId: string): Promise<void> {
    const revoked = await request(httpServer(app))
      .delete(
        `/api/admin/v1/activities/${scenario.activityId}/responsibilities/collaborators/${assignmentId}`,
      )
      .set('Authorization', adminAuth);
    expect(revoked.status).toBe(200);
  }

  async function proxyPunch(
    target: INestApplication,
    auth: string,
    scenario: Scenario,
    participationIdentityId: string,
    reason: string,
  ) {
    return request(httpServer(target))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/${scenario.sessionId}` +
          '/proxy-punch',
      )
      .set('Authorization', auth)
      .send({
        actionCode: 'check_in',
        eventKey: `b6-jobs-proxy-${++sequence}`,
        participationIdentityId,
        reason,
      });
  }

  /** 排干所有可领任务 —— 断言只落在被测 job 自己的行上,不依赖某一轮领到了谁。 */
  async function drainAll(): Promise<void> {
    await peerApp.get(ActivityBatchWorker).drainUntilIdle();
  }

  async function createBulkJob(
    auth: string,
    scenario: Scenario,
    participationIdentityIds: string[],
    reason: string,
  ): Promise<string> {
    const created = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/${scenario.sessionId}` +
          '/bulk-punch-jobs',
      )
      .set('Authorization', auth)
      .send({
        operationKey: `b6-jobs-bulk-${++sequence}`,
        actionCode: 'check_in',
        reason,
        participationIdentityIds,
      });
    expect(created.status).toBe(201);
    return created.body.data.jobId as string;
  }

  /**
   * 造出 `partial_failed`(1 成功 + 1 失败)的真实 job:先给其中一人开一段现场服务段,
   * 该项在 worker 里撞 open segment 而失败,另一项正常提交。
   */
  async function createPartiallyFailedJob(
    auth: string,
    scenario: Scenario,
  ): Promise<{ jobId: string; blockedIdentityId: string; okIdentityId: string }> {
    const blockedIdentityId = await submitMember(scenario, {
      auth: applicantAuth,
      memberId: applicantMemberId,
    });
    const okIdentityId = await submitMember(scenario, {
      auth: otherApplicantAuth,
      memberId: otherApplicantMemberId,
    });
    const preOpened = await proxyPunch(
      app,
      ownerAuth,
      scenario,
      blockedIdentityId,
      '构造已开放服务段以制造逐项失败',
    );
    expect(preOpened.status).toBe(201);
    await drainAll();
    const jobId = await createBulkJob(
      auth,
      scenario,
      [blockedIdentityId, okIdentityId],
      '构造一半成功一半失败的批任务',
    );
    await drainAll();
    await expect(
      prisma.activityBatchJob.findUniqueOrThrow({
        where: { id: jobId },
        select: { statusCode: true, succeeded: true, failed: true, skipped: true },
      }),
    ).resolves.toEqual({ statusCode: 'partial_failed', succeeded: 1, failed: 1, skipped: 0 });
    return { jobId, blockedIdentityId, okIdentityId };
  }

  // ===================================================================================
  // 不变量 1:知道 jobId 也看不到别人的任务(合同 §6.13 原文)
  // ===================================================================================

  it('不变量1:越权读一律 404,且与「jobId 根本不存在」逐字节同码同文案(不泄露存在性)', async () => {
    const scenario = await createScenario();
    const identityId = await submitMember(scenario, {
      auth: applicantAuth,
      memberId: applicantMemberId,
    });
    const jobId = await createBulkJob(ownerAuth, scenario, [identityId], '越权读面判据');

    // 先钉「两边非空」:范围内的人确实读得到,否则下面的 404 可能只是因为任务不存在。
    const ownerDetail = await request(httpServer(app))
      .get(`${BASE}/${jobId}`)
      .set('Authorization', ownerAuth);
    expect(ownerDetail.status).toBe(200);
    expect(ownerDetail.body.data.jobId).toBe(jobId);

    // mutation: 去掉 detail/listItems 的 `activity: scopedActivityWhere(memberId)`
    //          ⇒ outsider 拿到 200,本条当场红。
    // ⚠️ 写面(retry/cancel)的越权断言**故意**不放在这里,而在不变量 2 ——
    //    两条不变量走的是不同的实现位(读侧 where vs. 事务内 lockJobInScope),
    //    分开放才能让各自的变异有**独占**的红集,而不是互相盖住。
    const absentJobId = 'c'.repeat(25);
    for (const [method, path] of [
      ['get', `${BASE}/${jobId}`],
      ['get', `${BASE}/${jobId}/items`],
    ] as const) {
      const denied = await request(httpServer(app))
        [method](path)
        .set('Authorization', outsiderAuth);
      const missing = await request(httpServer(app))
        [method](path.replace(jobId, absentJobId))
        .set('Authorization', outsiderAuth);
      expect(denied.status).toBe(404);
      expect(denied.body.code).toBe(BizCode.NOT_FOUND.code);
      // 存在性不泄露的判据不是「都返 404」,是**两个响应体逐字节相同**。
      expect(denied.body.code).toBe(missing.body.code);
      expect(denied.body.message).toBe(missing.body.message);
      expect(denied.status).toBe(missing.status);
    }

    // 列表侧:越权者的分页里没有这条,而范围内的人有。
    const outsiderList = await request(httpServer(app))
      .get(`${BASE}?page=1&pageSize=100`)
      .set('Authorization', outsiderAuth);
    expect(outsiderList.status).toBe(200);
    expect(outsiderList.body.data.items.map((item: { jobId: string }) => item.jobId)).not.toContain(
      jobId,
    );
    const ownerList = await request(httpServer(app))
      .get(`${BASE}?page=1&pageSize=100`)
      .set('Authorization', ownerAuth);
    expect(ownerList.body.data.items.map((item: { jobId: string }) => item.jobId)).toContain(jobId);

    // 按越权活动过滤:返回空页而不是 404 —— 同样不泄露该活动是否存在。
    const filtered = await request(httpServer(app))
      .get(`${BASE}?page=1&pageSize=20&activityId=${scenario.activityId}`)
      .set('Authorization', outsiderAuth);
    expect(filtered.status).toBe(200);
    expect(filtered.body.data).toMatchObject({ items: [], total: 0 });
  }, 90_000);

  // ===================================================================================
  // 不变量 2:重试与取消重新判权(§9.9)——红集与不变量 1 不重叠:
  //   这里的主体是**任务创建人本人**,他在撤权前确实能操作,撤权后当场失效。
  // ===================================================================================

  it('不变量2:创建人被撤权后 retry/cancel 立即失效,而仍在范围内的负责人不受影响', async () => {
    const scenario = await createScenario();
    const assignmentId = await grantCollaborator(scenario, '现场协办,稍后撤权');
    const { jobId } = await createPartiallyFailedJob(collaboratorAuth, scenario);

    // 钉住「这确实是他建的」——否则下面的失效可能只是因为他本来就无关。
    await expect(
      prisma.activityBatchJob.findUniqueOrThrow({
        where: { id: jobId },
        select: { createdBy: { select: { memberId: true } } },
      }),
    ).resolves.toEqual({ createdBy: { memberId: collaboratorMemberId } });

    // 撤权**前**:创建人能读、能重试。
    const beforeDetail = await request(httpServer(app))
      .get(`${BASE}/${jobId}`)
      .set('Authorization', collaboratorAuth);
    expect(beforeDetail.status).toBe(200);
    expect(beforeDetail.body.data).toMatchObject({ retryFailedAllowed: true });

    await revokeCollaborator(scenario, assignmentId);

    // mutation: 在 lockJobInScope 里补一条 `|| job.createdByUserId === currentUserId` 的兜底
    //          ⇒ 「你当初建的」重新放行,本条当场红。
    const absentJobId = 'c'.repeat(25);
    for (const path of [`${BASE}/${jobId}/retry-failed`, `${BASE}/${jobId}/cancel`]) {
      // ① 被撤权的**创建人本人**:撤权前能重试,撤权后立即失效。
      const revokedCreator = await request(httpServer(app))
        .post(path)
        .set('Authorization', collaboratorAuth);
      expect({ path, status: revokedCreator.status, code: revokedCreator.body.code }).toEqual({
        path,
        status: 404,
        code: BizCode.NOT_FOUND.code,
      });
      // ② 与本活动无关的人走同一条写面:同码同文案,存在性同样不泄露。
      const outsider = await request(httpServer(app)).post(path).set('Authorization', outsiderAuth);
      const missing = await request(httpServer(app))
        .post(path.replace(jobId, absentJobId))
        .set('Authorization', outsiderAuth);
      expect(outsider.status).toBe(404);
      expect(outsider.body.code).toBe(missing.body.code);
      expect(outsider.body.message).toBe(missing.body.message);
    }

    // 另一边非空:同一个 job,仍在范围内的 owner 照常可读可重试 ——
    // 证明失效的是「这个人的权限」,不是「这个任务坏了」。
    const ownerRetry = await request(httpServer(app))
      .post(`${BASE}/${jobId}/retry-failed`)
      .set('Authorization', ownerAuth);
    expect(ownerRetry.status).toBe(201);
    expect(ownerRetry.body.data.statusCode).toBe('pending');
  }, 90_000);

  // ===================================================================================
  // 不变量 3:retry-failed 只重试失败项
  // ===================================================================================

  it('不变量3:retry-failed 只把失败项打回 pending,成功项计数与既有 PunchEvent 一律不动', async () => {
    const scenario = await createScenario();
    const { jobId, blockedIdentityId } = await createPartiallyFailedJob(ownerAuth, scenario);

    const succeededItemBefore = await prisma.activityBatchJobItem.findFirstOrThrow({
      where: { jobId, statusCode: 'succeeded' },
      select: { id: true, punchEvents: { select: { id: true } } },
    });
    const eventIdsBefore = await prisma.attendancePunchEvent.findMany({
      where: { activityId: scenario.activityId },
      select: { id: true },
      orderBy: { id: 'asc' },
    });

    const retried = await request(httpServer(app))
      .post(`${BASE}/${jobId}/retry-failed`)
      .set('Authorization', ownerAuth);
    expect(retried.status).toBe(201);

    // mutation: 把 `where: { jobId: job.id, statusCode: 'failed' }` 放宽成 `{ jobId: job.id }`
    //          ⇒ 成功项也被打回 pending,下面两条当场红。
    await expect(
      prisma.activityBatchJob.findUniqueOrThrow({
        where: { id: jobId },
        select: { statusCode: true, succeeded: true, failed: true, skipped: true },
      }),
    ).resolves.toEqual({ statusCode: 'pending', succeeded: 1, failed: 0, skipped: 0 });
    await expect(
      prisma.activityBatchJobItem.findUniqueOrThrow({
        where: { id: succeededItemBefore.id },
        select: { statusCode: true, punchEvents: { select: { id: true } } },
      }),
    ).resolves.toEqual({
      statusCode: 'succeeded',
      punchEvents: succeededItemBefore.punchEvents,
    });

    // 再跑一轮:失败项仍撞同一个 open segment 而再次失败,成功项**不得**被二次执行 ⇒
    // 全活动 PunchEvent 集合逐 id 不变(比集合不比计数)。
    await drainAll();
    await expect(
      prisma.activityBatchJob.findUniqueOrThrow({
        where: { id: jobId },
        select: { statusCode: true, succeeded: true, failed: true, skipped: true },
      }),
    ).resolves.toEqual({ statusCode: 'partial_failed', succeeded: 1, failed: 1, skipped: 0 });
    await expect(
      prisma.attendancePunchEvent.findMany({
        where: { activityId: scenario.activityId },
        select: { id: true },
        orderBy: { id: 'asc' },
      }),
    ).resolves.toEqual(eventIdsBefore);
    expect(eventIdsBefore.length).toBeGreaterThan(0);
    expect(blockedIdentityId).not.toBe('');
  }, 120_000);

  // ===================================================================================
  // 不变量 4:cancel 的终态语义
  // ===================================================================================

  it('不变量4:已完成的任务不可取消;进行中取消后 worker 不再领,逐项零副作用', async () => {
    const succeededScenario = await createScenario();
    const identityId = await submitMember(succeededScenario, {
      auth: applicantAuth,
      memberId: applicantMemberId,
    });
    await drainAll();
    const succeededJobId = await createBulkJob(
      ownerAuth,
      succeededScenario,
      [identityId],
      '跑到底的批任务不可取消',
    );
    await drainAll();
    await expect(
      prisma.activityBatchJob.findUniqueOrThrow({
        where: { id: succeededJobId },
        select: { statusCode: true, succeeded: true, failed: true, skipped: true },
      }),
    ).resolves.toEqual({ statusCode: 'succeeded', succeeded: 1, failed: 0, skipped: 0 });

    // mutation: 把 'succeeded' 加进 CANCELLABLE_JOB_STATUSES ⇒ 本条当场红。
    const rejected = await request(httpServer(app))
      .post(`${BASE}/${succeededJobId}/cancel`)
      .set('Authorization', ownerAuth);
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe(BizCode.ACTIVITY_STATUS_INVALID.code);
    await expect(
      prisma.activityBatchJob.findUniqueOrThrow({
        where: { id: succeededJobId },
        select: { statusCode: true },
      }),
    ).resolves.toEqual({ statusCode: 'succeeded' });

    // 进行中(pending,尚未被领)取消:worker 之后一轮都不再领它。
    const pendingScenario = await createScenario();
    const pendingIdentityId = await submitMember(pendingScenario, {
      auth: applicantAuth,
      memberId: applicantMemberId,
    });
    await drainAll();
    const pendingJobId = await createBulkJob(
      ownerAuth,
      pendingScenario,
      [pendingIdentityId],
      '未开跑即取消',
    );
    const cancelled = await request(httpServer(app))
      .post(`${BASE}/${pendingJobId}/cancel`)
      .set('Authorization', ownerAuth);
    expect(cancelled.status).toBe(201);
    expect(cancelled.body.data).toMatchObject({ statusCode: 'cancelled', cancelAllowed: false });

    // 排干所有可领任务后,被取消的这条仍原样躺着 —— 断言落在它自己的行上,
    // 不依赖 drainOnce 的返回值(同库里可能还有别的 spec 的任务)。
    await peerApp.get(ActivityBatchWorker).drainUntilIdle();
    await expect(
      prisma.activityBatchJob.findUniqueOrThrow({
        where: { id: pendingJobId },
        select: {
          statusCode: true,
          startedAt: true,
          succeeded: true,
          failed: true,
          skipped: true,
          items: { select: { statusCode: true } },
        },
      }),
    ).resolves.toEqual({
      statusCode: 'cancelled',
      startedAt: null,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      items: [{ statusCode: 'pending' }],
    });
    await expect(
      prisma.attendancePunchEvent.count({ where: { activityId: pendingScenario.activityId } }),
    ).resolves.toBe(0);

    // 二次取消:已取消是终态,不可再取消。
    const twice = await request(httpServer(app))
      .post(`${BASE}/${pendingJobId}/cancel`)
      .set('Authorization', ownerAuth);
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe(BizCode.ACTIVITY_STATUS_INVALID.code);
  }, 120_000);

  // ===================================================================================
  // 不变量 5:读面零敏感字段
  // ===================================================================================

  it('不变量5:三个读面都不含 token/签名/hash/凭证/坐标/内部 payload —— 按真值比,不只按键名', async () => {
    const scenario = await createScenario();
    const { jobId } = await createPartiallyFailedJob(ownerAuth, scenario);

    // 取真值当针:键名清单会漏掉改名后的同一份秘密,真值不会。
    const secrets = await prisma.activityBatchJob.findUniqueOrThrow({
      where: { id: jobId },
      select: {
        operationKey: true,
        requestHash: true,
        leaseOwner: true,
        payload: true,
        items: { select: { payloadHash: true, resourceId: true, resultReference: true } },
      },
    });

    const responses = await Promise.all([
      request(httpServer(app)).get(`${BASE}?page=1&pageSize=100`).set('Authorization', ownerAuth),
      request(httpServer(app)).get(`${BASE}/${jobId}`).set('Authorization', ownerAuth),
      request(httpServer(app))
        .get(`${BASE}/${jobId}/items?page=1&pageSize=100`)
        .set('Authorization', ownerAuth),
    ]);

    // mutation: 在 JOB_SELECT 里加 `payload: true` 并放进 presentJob 的返回 ⇒ 本条当场红。
    const forbiddenKeys = [
      'payload',
      'requestHash',
      'operationKey',
      'leaseOwner',
      'leaseExpiresAt',
      'availableAt',
      'payloadHash',
      'resultReference',
      'resourceId',
      'tokenDigest',
      'signatureDigest',
      'longitude',
      'latitude',
      'accuracy',
    ];
    const forbiddenValues = [
      secrets.operationKey,
      secrets.requestHash,
      secrets.leaseOwner,
      // ⚠️ 不放 `item.resourceId`:`itemKey` 就是 `identity:<participationIdentityId>`,
      //    这是「哪一位失败了」的唯一抓手,§9.9 的失败项分页离了它无法操作;
      //    而读者已持有该活动的责任范围,本就看得到这些参与人。
      ...secrets.items.flatMap((item) => [item.payloadHash, item.resultReference]),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    // 针必须非空,否则「没找到」是恒真的空断言。
    expect(forbiddenValues.length).toBeGreaterThan(0);

    for (const response of responses) {
      expect(response.status).toBe(200);
      const wire = JSON.stringify(response.body);
      expect({ keys: forbiddenKeys.filter((key) => collectKeys(response.body).has(key)) }).toEqual({
        keys: [],
      });
      expect({ values: forbiddenValues.filter((value) => wire.includes(value)) }).toEqual({
        values: [],
      });
    }

    // 正对照:读面确实回了 §9.9 点名的人话状态与计数(否则上面的「什么都没有」也成立)。
    expect(responses[1].body.data).toMatchObject({
      jobTypeCode: 'bulk_proxy',
      total: 2,
      succeeded: 1,
      failed: 1,
      activity: { id: scenario.activityId },
      createdBy: { memberId: ownerMemberId },
    });
    expect(typeof responses[1].body.data.leaseStateText).toBe('string');
    expect(responses[1].body.data.leaseStateText.length).toBeGreaterThan(0);
    expect(responses[1].body.data.retryStateText).toContain('1');
  }, 120_000);

  // ===================================================================================
  // ADV-003:现场权限撤销与代签并发
  // ===================================================================================

  it('ADV-003 现场权限撤销与代签并发:两个连接池上线性化,越权那一侧零 PunchEvent', async () => {
    const scenario = await createScenario();
    const assignmentId = await grantCollaborator(scenario, 'ADV-003 现场协办');
    const identityId = await submitMember(scenario, {
      auth: applicantAuth,
      memberId: applicantMemberId,
    });

    const [punched, revoked] = await Promise.all([
      proxyPunch(app, collaboratorAuth, scenario, identityId, 'ADV-003 并发代签'),
      request(httpServer(peerApp))
        .delete(
          `/api/admin/v1/activities/${scenario.activityId}/responsibilities/collaborators/${assignmentId}`,
        )
        .set('Authorization', adminPeerAuth),
    ]);
    expect(revoked.status).toBe(200);

    const events = await prisma.attendancePunchEvent.count({
      where: { activityId: scenario.activityId, sourceCode: 'proxy' },
    });
    if (punched.status === 201) {
      // 代签排在撤权之前 ⇒ 恰好一条正式事实。
      expect(events).toBe(1);
    } else {
      // 撤权先落地 ⇒ 代签必须是权限拒绝,且**一条都不许写**。
      expect(punched.status).toBe(403);
      expect(punched.body.code).toBe(BizCode.RBAC_FORBIDDEN.code);
      expect(events).toBe(0);
    }

    // 撤权已提交之后,再代签恒被拒 —— 与上面的竞态无关,是稳定后的终态。
    const afterRevoke = await proxyPunch(
      app,
      collaboratorAuth,
      scenario,
      identityId,
      'ADV-003 撤权后重试',
    );
    expect(afterRevoke.status).toBe(403);
    expect(afterRevoke.body.code).toBe(BizCode.RBAC_FORBIDDEN.code);
    await expect(
      prisma.attendancePunchEvent.count({
        where: { activityId: scenario.activityId, sourceCode: 'proxy' },
      }),
    ).resolves.toBe(events);
  }, 90_000);

  // ===================================================================================
  // ADV-023:批量代签任务**运行一半**时撤销操作者权限
  // ===================================================================================

  it('ADV-023 批量代签跑到一半再撤权:已提交项保留,剩余项 skipped 且零 PunchEvent', async () => {
    const scenario = await createScenario();
    const assignmentId = await grantCollaborator(scenario, 'ADV-023 现场协办');
    const { jobId, okIdentityId } = await createPartiallyFailedJob(collaboratorAuth, scenario);

    // 「运行一半」的判据:确实已经有 item 提交了副作用(不是开跑前就被拦)。
    const committed = await prisma.activityBatchJobItem.findFirstOrThrow({
      where: { jobId, statusCode: 'succeeded' },
      select: { id: true, punchEvents: { select: { id: true } } },
    });
    expect(committed.punchEvents).toHaveLength(1);
    const eventsAfterFirstHalf = await prisma.attendancePunchEvent.findMany({
      where: { activityId: scenario.activityId },
      select: { id: true },
      orderBy: { id: 'asc' },
    });

    // 仍在范围内的 owner 把失败项重新排队 —— 任务由此进入「还剩一半没跑」的状态。
    const requeued = await request(httpServer(app))
      .post(`${BASE}/${jobId}/retry-failed`)
      .set('Authorization', ownerAuth);
    expect(requeued.status).toBe(201);
    await expect(
      prisma.activityBatchJobItem.count({ where: { jobId, statusCode: 'pending' } }),
    ).resolves.toBe(1);

    // 此刻撤销**任务里记录的那个操作者**的现场权限。
    await revokeCollaborator(scenario, assignmentId);

    // worker 逐项重新判权 ⇒ 剩下的项一律 skipped,已提交的那项原样保留。
    await drainAll();
    await expect(
      prisma.activityBatchJob.findUniqueOrThrow({
        where: { id: jobId },
        select: { statusCode: true, succeeded: true, failed: true, skipped: true },
      }),
    ).resolves.toEqual({ statusCode: 'partial_failed', succeeded: 1, failed: 0, skipped: 1 });
    await expect(
      prisma.activityBatchJobItem.findUniqueOrThrow({
        where: { id: committed.id },
        select: { statusCode: true, punchEvents: { select: { id: true } } },
      }),
    ).resolves.toEqual({ statusCode: 'succeeded', punchEvents: committed.punchEvents });
    const skipped = await prisma.activityBatchJobItem.findFirstOrThrow({
      where: { jobId, statusCode: 'skipped' },
      select: { lastErrorCode: true, punchEvents: { select: { id: true } } },
    });
    expect(skipped).toEqual({
      lastErrorCode: `BizException:${BizCode.RBAC_FORBIDDEN.code}`,
      punchEvents: [],
    });
    // 撤权之后一条新事实都没有 —— 比集合不比计数。
    await expect(
      prisma.attendancePunchEvent.findMany({
        where: { activityId: scenario.activityId },
        select: { id: true },
        orderBy: { id: 'asc' },
      }),
    ).resolves.toEqual(eventsAfterFirstHalf);
    expect(okIdentityId).not.toBe('');
    expect(peerPrisma).not.toBe(prisma);
  }, 150_000);
});

/** 深度收集响应体里出现过的所有键名(数组元素也要下钻)。 */
function collectKeys(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, found);
    return found;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      found.add(key);
      collectKeys(child, found);
    }
  }
  return found;
}
