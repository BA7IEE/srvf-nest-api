import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, BindingStatus, MemberStatus, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';

import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

/**
 * ADV-015「未授权人员用**其他活动**的场次、任务、报名和结算编号访问」。
 *
 * 🔴 立项证据(本刀实测):这四条轴此前**没有一条**被这样打过。全仓既有的跨活动用例
 *    要么是 DB 复合外键(「岗位挂到别的活动的场次上」23503),要么是**自己活动**上的
 *    锚点校验;唯一的越权读面判据在 `activity-batch6-batch-job-read-surface`,
 *    只覆盖**任务**这一轴。场次 / 报名 / 结算三轴零判据。
 *
 * 对手模型取**最刁的那一种**:攻击者不是路人,而是**另一个活动的合法负责人** ——
 * 他在路径里放**自己活动的 activityId**(所以活动级判权必然放行),只把子资源编号
 * 换成受害活动的。这样翻面的只可能是「子资源编号有没有被锚回该活动」这一件事,
 * 而不是活动级判权。路人那一侧同时也打一遍,作为对照。
 *
 * 判据形状沿本仓既有范式:
 *   · 不泄露存在性的判据**不是「都返 404/20xxx」,而是响应体与「编号根本不存在」逐字节相同**;
 *   · 每一轴都先钉**两边非空**(受害者自己读得到 / 写得动),否则拒绝可能只是因为资源不存在;
 *   · 写面另比**集合**而不是计数,证明一条新事实都没落地。
 */
describe('ADV-015 跨活动编号越权(场次 / 任务 / 报名 / 结算四轴)', () => {
  const previousResponsibilityWorkflow = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
  const previousWorkflowGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;

  let app: INestApplication;
  let prisma: PrismaService;
  let activityOwnerRoleId: string;
  let sequence = 0;

  /** 受害活动 A 的负责人 / 攻击活动 B 的负责人 / 与两者都无关的路人。 */
  let victimAuth: string;
  let attackerAuth: string;
  let outsiderAuth: string;
  let victimMemberId: string;
  let victimUserId: string;
  let attackerMemberId: string;
  let attackerUserId: string;
  let applicantAuth: string;
  let applicantMemberId: string;

  interface Scenario {
    activityId: string;
    sessionId: string;
    positionId: string;
    ownerMemberId: string;
    ownerUserId: string;
  }

  /** 同形状但不存在的编号:本仓 cuid 长度 25,用它做「根本不存在」那一侧的对照。 */
  const ABSENT_ID = 'c'.repeat(25);

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    activityOwnerRoleId = (await seedActivityResponsibilitySystemRoles(app))['activity-owner'];

    const [victim, attacker, outsider, applicant] = await Promise.all([
      createTestUser(app, { username: 'adv015-victim', role: Role.USER }),
      createTestUser(app, { username: 'adv015-attacker', role: Role.USER }),
      createTestUser(app, { username: 'adv015-outsider', role: Role.USER }),
      createTestUser(app, { username: 'adv015-applicant', role: Role.USER }),
    ]);
    const members = await Promise.all(
      [
        ['ADV015-VICTIM', 'ADV015 Victim Owner'],
        ['ADV015-ATTACKER', 'ADV015 Attacker Owner'],
        ['ADV015-OUTSIDER', 'ADV015 Outsider'],
        ['ADV015-APPLICANT', 'ADV015 Applicant'],
      ].map(([memberNo, realName]) =>
        prisma.member.create({
          data: {
            memberNo,
            ...memberIdentityData(realName),
            gradeCode: 'L1',
            status: MemberStatus.ACTIVE,
          },
          select: { id: true },
        }),
      ),
    );
    const users = [victim, attacker, outsider, applicant];
    await Promise.all(
      users.map((user, index) =>
        prisma.user.update({ where: { id: user.id }, data: { memberId: members[index].id } }),
      ),
    );
    victimMemberId = members[0].id;
    victimUserId = victim.id;
    attackerMemberId = members[1].id;
    attackerUserId = attacker.id;
    applicantMemberId = members[3].id;

    // 攻击者拿到**全局**结算读码 —— 否则结算那一轴会在路由守卫上就被 30100 挡下,
    // 根本走不到「编号锚回活动」那一层,判据会变成守了别的东西。
    await grantGlobal(attacker.id, 'adv015-attacker-settlement', [
      'activity.settlement-generate.record',
    ]);
    // 受害者同样要有,才能构成「两边非空」的正对照。
    await grantGlobal(victim.id, 'adv015-victim-settlement', [
      'activity.settlement-generate.record',
    ]);

    [victimAuth, attackerAuth, outsiderAuth, applicantAuth] = await Promise.all([
      loginAs(app, victim.username).then(({ authHeader }) => authHeader),
      loginAs(app, attacker.username).then(({ authHeader }) => authHeader),
      loginAs(app, outsider.username).then(({ authHeader }) => authHeader),
      loginAs(app, applicant.username).then(({ authHeader }) => authHeader),
    ]);
  }, 180_000);

  afterAll(async () => {
    await app.close();
    if (previousResponsibilityWorkflow === undefined) {
      delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousResponsibilityWorkflow;
    }
    if (previousWorkflowGate === undefined) {
      delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousWorkflowGate;
    }
  });

  async function grantGlobal(userId: string, roleCode: string, codes: string[]): Promise<void> {
    await prisma.permission.createMany({
      data: codes.map((code) => {
        const [resourceType, action] = code.split('.');
        return { code, module: resourceType, action: action ?? 'manage', resourceType };
      }),
      skipDuplicates: true,
    });
    const role = await prisma.rbacRole.create({
      data: { code: roleCode, displayName: roleCode },
      select: { id: true },
    });
    const permissions = await prisma.permission.findMany({
      where: { code: { in: codes } },
      select: { id: true },
    });
    expect(permissions).toHaveLength(codes.length);
    await prisma.rolePermission.createMany({
      data: permissions.map((permission) => ({ roleId: role.id, permissionId: permission.id })),
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: userId,
        roleId: role.id,
        scopeType: BindingScopeType.GLOBAL,
        status: BindingStatus.ACTIVE,
        startedAt: new Date(Date.now() - 24 * 60 * 60_000),
      },
    });
  }

  async function createScenario(
    owner: { memberId: string; userId: string },
    options: { statusCode?: 'draft' | 'published' } = {},
  ): Promise<Scenario> {
    const index = ++sequence;
    const statusCode = options.statusCode ?? 'published';
    const now = new Date();
    const startAt = new Date(now.getTime() - 10 * 60_000);
    const endAt = new Date(now.getTime() + 2 * 60 * 60_000);
    const organization = await prisma.organization.create({
      data: { name: `ADV015 Team ${index}`, nodeTypeCode: 'adv015-team' },
      select: { id: true },
    });
    const activity = await prisma.activity.create({
      data: {
        title: `ADV015 Activity ${index}`,
        activityTypeCode: 'training',
        organizationId: organization.id,
        initiatorMemberId: owner.memberId,
        startAt,
        endAt,
        location: 'ADV015 Field',
        statusCode,
        publishedAt: statusCode === 'published' ? now : null,
        capacity: 4,
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
        submittedByUserId: owner.userId,
        reviewedByUserId: owner.userId,
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
        code: `adv015-session-${index}`,
        name: `ADV015 Session ${index}`,
        startAt,
        endAt,
        locationText: 'ADV015 Field',
        capacity: 4,
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
        code: `adv015-position-${index}`,
        name: `ADV015 Position ${index}`,
        attendanceRoleCode: 'volunteer',
        capacity: 4,
      },
      select: { id: true },
    });
    await prisma.activityCapacityBucket.createMany({
      data: [
        {
          activityId: activity.id,
          scopeTypeCode: 'activity_person',
          scopeId: activity.id,
          capacity: 4,
        },
        {
          activityId: activity.id,
          scopeTypeCode: 'session_participation',
          scopeId: session.id,
          capacity: 4,
        },
        {
          activityId: activity.id,
          scopeTypeCode: 'position_participation',
          scopeId: position.id,
          capacity: 4,
        },
      ],
    });
    await prisma.activityEvidenceState.create({ data: { activityId: activity.id } });
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: activity.id,
        memberId: owner.memberId,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: owner.userId,
        source: 'publish',
      },
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.MEMBER,
        principalId: owner.memberId,
        roleId: activityOwnerRoleId,
        scopeType: BindingScopeType.ACTIVITY,
        scopeActivityId: activity.id,
        status: BindingStatus.ACTIVE,
        note: `adv015 fixture ${index}`,
      },
    });
    return {
      activityId: activity.id,
      sessionId: session.id,
      positionId: position.id,
      ownerMemberId: owner.memberId,
      ownerUserId: owner.userId,
    };
  }

  /**
   * 两条 assert 合一:攻击者(另一活动的合法负责人)与路人,各自拿受害活动的子资源编号
   * 打自己有权的路径;两者都必须与「编号根本不存在」逐字节同码同文案。
   */
  async function expectIndistinguishableFromAbsent(
    buildPath: (subResourceId: string) => string,
    call: (path: string, auth: string) => request.Test,
  ): Promise<void> {
    for (const [label, auth] of [
      ['attacker', attackerAuth],
      ['outsider', outsiderAuth],
    ] as const) {
      const crossed = await call(buildPath(VICTIM_SUB_RESOURCE_ID), auth);
      const missing = await call(buildPath(ABSENT_ID), auth);
      expect({
        label,
        status: crossed.status,
        code: crossed.body.code,
        message: crossed.body.message,
      }).toEqual({
        label,
        status: missing.status,
        code: missing.body.code,
        message: missing.body.message,
      });
      // 顺带钉死:响应体里不得出现受害活动的任何编号(不能靠回显泄露)。
      expect(JSON.stringify(crossed.body)).not.toContain(VICTIM_SUB_RESOURCE_ID);
    }
  }

  /** `expectIndistinguishableFromAbsent` 每次调用前由各用例设置。 */
  let VICTIM_SUB_RESOURCE_ID = '';

  // =====================================================================================
  // 轴① 场次编号
  // =====================================================================================

  it('ADV-015 场次:拿别的活动的 sessionId 改场次 —— 与「场次不存在」同码同文案,且受害场次零变化', async () => {
    // ⚠️ 两个活动都必须是 **draft**:published 活动上的场次直改会先被**状态闸**转 20037,
    //    那样攻击者与「编号不存在」会因为同一个状态闸而同码 —— 判据看起来绿,
    //    守住的却是状态而不是编号锚定(本仓「闸被遮蔽 ⇒ 用例假绿」的同一形状)。
    //    draft 下发起人本人可直改,状态闸让开,翻面的才只剩「编号属不属于这个活动」。
    const victimScenario = await createScenario(
      { memberId: victimMemberId, userId: victimUserId },
      { statusCode: 'draft' },
    );
    const attackerScenario = await createScenario(
      { memberId: attackerMemberId, userId: attackerUserId },
      { statusCode: 'draft' },
    );
    const before = await prisma.activitySession.findUniqueOrThrow({
      where: { id: victimScenario.sessionId },
      select: { name: true, locationText: true, updatedAt: true },
    });

    VICTIM_SUB_RESOURCE_ID = victimScenario.sessionId;
    await expectIndistinguishableFromAbsent(
      (sessionId) =>
        `/api/app/v1/my/managed-activities/${attackerScenario.activityId}/sessions/${sessionId}`,
      (path, auth) =>
        request(httpServer(app))
          .patch(path)
          .set('Authorization', auth)
          .send({ name: 'ADV015 越权改名' }),
    );

    // 受害场次逐字段未动 —— 比字段真值,不只比「有没有报错」。
    await expect(
      prisma.activitySession.findUniqueOrThrow({
        where: { id: victimScenario.sessionId },
        select: { name: true, locationText: true, updatedAt: true },
      }),
    ).resolves.toEqual(before);

    // 另一边非空:受害活动自己的负责人改同一个场次是通的 ——
    // 证明拒绝的是「这个编号不属于你那个活动」,不是「这条路由本来就不能用」。
    const legit = await request(httpServer(app))
      .patch(
        `/api/app/v1/my/managed-activities/${victimScenario.activityId}/sessions/${victimScenario.sessionId}`,
      )
      .set('Authorization', victimAuth)
      .send({ name: 'ADV015 本人改名' });
    expect(legit.status).toBe(200);
  }, 120_000);

  // =====================================================================================
  // 轴② 任务编号
  // =====================================================================================

  it('ADV-015 任务:拿别的活动的 jobId 读批量任务 —— 与「任务不存在」同码同文案', async () => {
    const victimScenario = await createScenario({
      memberId: victimMemberId,
      userId: victimUserId,
    });
    const attackerScenario = await createScenario({
      memberId: attackerMemberId,
      userId: attackerUserId,
    });
    const job = await prisma.activityBatchJob.create({
      data: {
        activityId: victimScenario.activityId,
        sessionId: victimScenario.sessionId,
        jobTypeCode: 'bulk_proxy',
        statusCode: 'pending',
        operationKey: `adv015-job-${++sequence}`,
        total: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        // payload 必须过 `isOnsiteBulkPayload` —— 否则正对照那一侧会因为**载荷形状**
        // 落 400,而不是因为编号锚定;那样两侧同码就成了假绿。
        payload: {
          action: 'onsite_bulk_punch',
          actionCode: 'check_in',
          reason: 'ADV-015 夹具',
          actorUserId: victimUserId,
          actorMemberId: victimMemberId,
          location: { longitude: null, latitude: null, accuracy: null },
        },
        payloadVersion: 1,
        createdByUserId: victimUserId,
      },
      select: { id: true },
    });

    // 先钉两边非空:受害活动的负责人确实读得到这条任务。
    const legit = await request(httpServer(app))
      .get(
        `/api/app/v1/my/managed-activities/${victimScenario.activityId}/onsite/bulk-punch-jobs/${job.id}`,
      )
      .set('Authorization', victimAuth);
    expect(legit.status).toBe(200);

    VICTIM_SUB_RESOURCE_ID = job.id;
    await expectIndistinguishableFromAbsent(
      (jobId) =>
        `/api/app/v1/my/managed-activities/${attackerScenario.activityId}/onsite/bulk-punch-jobs/${jobId}`,
      (path, auth) => request(httpServer(app)).get(path).set('Authorization', auth),
    );
  }, 120_000);

  // =====================================================================================
  // 轴③ 报名编号
  // =====================================================================================

  it('ADV-015 报名:拿别的活动的 registrationId 审批 —— 同码同文案,且该报名状态零变化', async () => {
    const victimScenario = await createScenario({
      memberId: victimMemberId,
      userId: victimUserId,
    });
    const attackerScenario = await createScenario({
      memberId: attackerMemberId,
      userId: attackerUserId,
    });
    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/activities/${victimScenario.activityId}/registrations`)
      .set('Authorization', applicantAuth)
      .send({
        operationKey: `adv015-register-${++sequence}`,
        formVersion: null,
        answers: [],
        preferences: [
          { sessionId: victimScenario.sessionId, positionIds: [victimScenario.positionId] },
        ],
      });
    expect(submitted.status).toBe(201);
    const registration = await prisma.activityRegistration.findFirstOrThrow({
      where: { activityId: victimScenario.activityId, memberId: applicantMemberId },
      select: { id: true, statusCode: true },
    });

    VICTIM_SUB_RESOURCE_ID = registration.id;
    await expectIndistinguishableFromAbsent(
      (registrationId) =>
        `/api/app/v1/my/managed-activities/${attackerScenario.activityId}/registrations/${registrationId}/approve`,
      (path, auth) =>
        request(httpServer(app))
          .patch(path)
          .set('Authorization', auth)
          // approve 的 DTO 只收可选 reviewNote;多送一个字段会被白名单 ValidationPipe
          // 直接 400 —— 那样两侧「同码」是被 DTO 遮蔽出来的假绿(本刀变异实测踩到)。
          .send({ reviewNote: `ADV-015 越权审批 ${++sequence}` }),
    );

    await expect(
      prisma.activityRegistration.findUniqueOrThrow({
        where: { id: registration.id },
        select: { statusCode: true },
      }),
    ).resolves.toEqual({ statusCode: registration.statusCode });
  }, 120_000);

  // =====================================================================================
  // 轴④ 结算编号
  // =====================================================================================

  it('ADV-015 结算:拿别的活动的 versionId 读结算版本 —— 同码同文案(攻击者持全局结算码)', async () => {
    const victimScenario = await createScenario({
      memberId: victimMemberId,
      userId: victimUserId,
    });
    const attackerScenario = await createScenario({
      memberId: attackerMemberId,
      userId: attackerUserId,
    });
    const now = new Date();
    const seal = await prisma.evidenceSeal.create({
      data: {
        activityId: victimScenario.activityId,
        sealRevision: 1,
        evidenceRevision: 1,
        populationRevision: 1,
        workflowRevision: 0,
        allWindowsClosedAt: now,
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: 0,
        populationCountBySession: {},
        contentHash: 'b'.repeat(64),
        statusCode: 'active',
        sealedAt: now,
      },
      select: { id: true },
    });
    const run = await prisma.attendanceSettlementRun.create({
      data: { activityId: victimScenario.activityId, statusCode: 'drafting' },
      select: { id: true },
    });
    const version = await prisma.attendanceSettlementVersion.create({
      data: {
        settlementRunId: run.id,
        version: 1,
        evidenceSealId: seal.id,
        evidenceRevision: 1,
        populationRevision: 1,
        workflowRevision: 0,
        contentHash: 'c'.repeat(64),
        personCount: 0,
        sessionParticipationCount: 0,
        serviceSegmentCount: 0,
        statusCode: 'draft',
      },
      select: { id: true },
    });

    // 先钉两边非空:受害活动的负责人(同样持全局结算码)确实读得到这个版本。
    const legit = await request(httpServer(app))
      .get(
        `/api/app/v1/my/managed-activities/${victimScenario.activityId}/settlement/versions/${version.id}`,
      )
      .set('Authorization', victimAuth);
    expect(legit.status).toBe(200);
    expect(legit.body.data.version.id).toBe(version.id);

    VICTIM_SUB_RESOURCE_ID = version.id;
    await expectIndistinguishableFromAbsent(
      (versionId) =>
        `/api/app/v1/my/managed-activities/${attackerScenario.activityId}/settlement/versions/${versionId}`,
      (path, auth) => request(httpServer(app)).get(path).set('Authorization', auth),
    );
  }, 120_000);
});
