import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BindingScopeType, BindingStatus, MemberStatus, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';

import { PrismaService } from '../../src/database/prisma.service';
import type { JwtConfig } from '../../src/config/jwt.config';
import { ActivityBatchWorker } from '../../src/modules/activities/activity-batch.worker';
import { signAttendanceMemberCredential } from '../../src/modules/attendances/attendance-member-credential-token';
import { LocalStorageProvider } from '../../src/modules/storage/providers/local.provider';
import { loginAs } from '../fixtures/auth.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

type Scenario = { activityId: string; sessionId: string; positionId: string };

describe('activity batch6 staff/import/offline runtime', () => {
  const previousResponsibilityWorkflow = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
  let app: INestApplication;
  let peerApp: INestApplication;
  let prisma: PrismaService;
  let peerPrisma: PrismaService;
  let managerAuth: string;
  let managerPeerAuth: string;
  let applicantAuth: string;
  let otherApplicantAuth: string;
  let operatorAuth: string;
  let adminAuth: string;
  let managerMemberId: string;
  let managerUserId: string;
  let applicantMemberId: string;
  let applicantUserId: string;
  let otherApplicantMemberId: string;
  let operatorMemberId: string;
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

    const [manager, applicant, otherApplicant, operator, admin] = await Promise.all([
      createTestUser(app, { username: 'batch6-onsite-manager', role: Role.USER }),
      createTestUser(app, { username: 'batch6-onsite-applicant', role: Role.USER }),
      createTestUser(app, { username: 'batch6-onsite-other-applicant', role: Role.USER }),
      createTestUser(app, { username: 'batch6-onsite-operator', role: Role.USER }),
      createTestUser(app, { username: 'batch6-onsite-admin', role: Role.SUPER_ADMIN }),
    ]);
    const [managerMember, applicantMember, otherApplicantMember, operatorMember, adminMember] =
      await Promise.all([
        prisma.member.create({
          data: {
            memberNo: 'B6-ONSITE-MANAGER',
            displayName: 'Batch6 Onsite Manager',
            gradeCode: 'L1',
            status: MemberStatus.ACTIVE,
          },
          select: { id: true },
        }),
        prisma.member.create({
          data: {
            memberNo: 'B6-ONSITE-APPLICANT',
            displayName: 'Batch6 Onsite Applicant',
            gradeCode: 'L1',
            status: MemberStatus.ACTIVE,
          },
          select: { id: true },
        }),
        prisma.member.create({
          data: {
            memberNo: 'B6-ONSITE-OTHER-APPLICANT',
            displayName: 'Batch6 Onsite Other Applicant',
            gradeCode: 'L1',
            status: MemberStatus.ACTIVE,
          },
          select: { id: true },
        }),
        prisma.member.create({
          data: {
            memberNo: 'B6-ONSITE-OPERATOR',
            displayName: 'Batch6 Onsite Operator',
            gradeCode: 'L1',
            status: MemberStatus.ACTIVE,
          },
          select: { id: true },
        }),
        prisma.member.create({
          data: {
            memberNo: 'B6-ONSITE-ADMIN',
            displayName: 'Batch6 Onsite Admin',
            gradeCode: 'L1',
            status: MemberStatus.ACTIVE,
          },
          select: { id: true },
        }),
      ]);
    managerMemberId = managerMember.id;
    managerUserId = manager.id;
    applicantMemberId = applicantMember.id;
    applicantUserId = applicant.id;
    otherApplicantMemberId = otherApplicantMember.id;
    operatorMemberId = operatorMember.id;
    await Promise.all([
      prisma.user.update({ where: { id: manager.id }, data: { memberId: managerMember.id } }),
      prisma.user.update({ where: { id: applicant.id }, data: { memberId: applicantMember.id } }),
      prisma.user.update({
        where: { id: otherApplicant.id },
        data: { memberId: otherApplicantMember.id },
      }),
      prisma.user.update({ where: { id: operator.id }, data: { memberId: operatorMember.id } }),
      prisma.user.update({ where: { id: admin.id }, data: { memberId: adminMember.id } }),
    ]);
    [managerAuth, managerPeerAuth, applicantAuth, otherApplicantAuth, operatorAuth, adminAuth] =
      await Promise.all([
        loginAs(app, manager.username).then(({ authHeader }) => authHeader),
        loginAs(peerApp, manager.username).then(({ authHeader }) => authHeader),
        loginAs(app, applicant.username).then(({ authHeader }) => authHeader),
        loginAs(app, otherApplicant.username).then(({ authHeader }) => authHeader),
        loginAs(app, operator.username).then(({ authHeader }) => authHeader),
        loginAs(app, admin.username).then(({ authHeader }) => authHeader),
      ]);
  }, 90_000);

  afterAll(async () => {
    delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    await Promise.all([app.close(), peerApp.close()]);
    if (previousResponsibilityWorkflow === undefined) {
      delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousResponsibilityWorkflow;
    }
  });

  async function createScenario(input: { capacity?: number } = {}): Promise<Scenario> {
    const index = ++sequence;
    const capacity = input.capacity ?? 1;
    const now = new Date();
    const startAt = new Date(now.getTime() - 10 * 60_000);
    const endAt = new Date(now.getTime() + 2 * 60 * 60_000);
    const organization = await prisma.organization.create({
      data: {
        name: `Batch6 Onsite Team ${index}`,
        nodeTypeCode: 'batch6-onsite-team',
      },
      select: { id: true },
    });
    const activity = await prisma.activity.create({
      data: {
        title: `Batch6 Onsite Activity ${index}`,
        activityTypeCode: 'training',
        organizationId: organization.id,
        startAt,
        endAt,
        location: 'Batch6 Onsite Field',
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
        snapshotHash: 'a'.repeat(64),
        createdByReviewId: publishReview.id,
      },
    });
    const session = await prisma.activitySession.create({
      data: {
        activityId: activity.id,
        code: `batch6-onsite-session-${index}`,
        name: `Batch6 Onsite Session ${index}`,
        startAt,
        endAt,
        locationText: 'Batch6 Onsite Field',
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
        code: `batch6-onsite-position-${index}`,
        name: `Batch6 Onsite Position ${index}`,
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
        note: `batch6 onsite fixture ${index}`,
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
        operationKey: `batch6-onsite-register-${++sequence}`,
        formVersion: null,
        answers: [],
        preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
      });
    expect(submitted.status).toBe(201);
    return prisma.activityParticipationIdentity
      .findFirstOrThrow({
        where: {
          activityId: scenario.activityId,
          sessionId: scenario.sessionId,
          memberId: input.memberId,
        },
        select: { id: true },
      })
      .then((identity) => identity.id);
  }

  async function submitApplicant(scenario: Scenario): Promise<string> {
    return submitMember(scenario, { auth: applicantAuth, memberId: applicantMemberId });
  }

  it('proves B6 uses two Nest applications with independent PostgreSQL pools', async () => {
    expect(app.getHttpServer()).not.toBe(peerApp.getHttpServer());
    expect(prisma).not.toBe(peerPrisma);
    const [[left], [right]] = await Promise.all([
      prisma.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
      peerPrisma.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
    ]);
    expect(left?.pid).toBeDefined();
    expect(right?.pid).toBeDefined();
    expect(left?.pid).not.toBe(right?.pid);
  });

  it('red-first: an App member can render only a protected short-lived credential SVG', async () => {
    const rendered = await request(httpServer(app))
      .post('/api/app/v1/my/attendance-member-credential/render')
      .set('Authorization', applicantAuth);

    expect(rendered.status).toBe(201);
    expect(rendered.headers['cache-control']).toBe('no-store');
    expect(rendered.headers['content-type']).toMatch(/^image\/svg\+xml/u);
    const svg = Buffer.isBuffer(rendered.body)
      ? rendered.body.toString('utf8')
      : (rendered.text ?? '');
    expect(svg).toContain('<svg');
    expect(svg).not.toContain('memberId');
    expect(svg).not.toContain('token');
  });

  it('red-first: staff scan manual confirmation writes the unified append-only punch chain', async () => {
    const scenario = await createScenario();
    const participationIdentityId = await submitApplicant(scenario);

    const scanned = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/${scenario.sessionId}` +
          '/staff-scan',
      )
      .set('Authorization', managerAuth)
      .send({
        actionCode: 'check_in',
        eventKey: `batch6-staff-scan-${++sequence}`,
        manualConfirmation: {
          participationIdentityId,
          reason: '可信成员码不可用时的现场人工确认',
        },
      });

    expect(scanned.status).toBe(201);
    expect(scanned.body.data).toMatchObject({
      eventTypeCode: 'check_in',
      segmentStatusCode: 'open',
    });
    await expect(
      prisma.attendancePunchEvent.findFirstOrThrow({
        where: { eventKey: `batch6-staff-scan-${sequence}` },
        select: {
          participationIdentityId: true,
          sourceCode: true,
          eventTypeCode: true,
          operatorUserId: true,
        },
      }),
    ).resolves.toEqual({
      participationIdentityId,
      sourceCode: 'staff_scan',
      eventTypeCode: 'check_in',
      operatorUserId: managerUserId,
    });
  });

  it('red-first: staff scan accepts only a signed short-lived member credential, never a raw member ID', async () => {
    const scenario = await createScenario();
    const participationIdentityId = await submitApplicant(scenario);
    const jwt = app.get(ConfigService).get<JwtConfig>('jwt');
    if (!jwt) throw new Error('jwt config is required for the real scan credential');
    const now = new Date();
    const memberCredential = signAttendanceMemberCredential(
      {
        userId: applicantUserId,
        memberId: applicantMemberId,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
        nonce: 'batch6-staff-scan-credential-nonce',
      },
      jwt.secret,
    );

    const scanned = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/${scenario.sessionId}` +
          '/staff-scan',
      )
      .set('Authorization', managerAuth)
      .send({
        actionCode: 'check_in',
        eventKey: `batch6-staff-credential-${++sequence}`,
        memberCredential,
      });

    expect(scanned.status).toBe(201);
    await expect(
      prisma.attendancePunchEvent.findFirstOrThrow({
        where: { eventKey: `batch6-staff-credential-${sequence}` },
        select: { participationIdentityId: true, sourceCode: true },
      }),
    ).resolves.toEqual({ participationIdentityId, sourceCode: 'staff_scan' });
  });

  it('red-first: a responsibility holder can proxy-punch one selected identity with an explicit reason', async () => {
    const scenario = await createScenario();
    const participationIdentityId = await submitApplicant(scenario);

    const punched = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/${scenario.sessionId}` +
          '/proxy-punch',
      )
      .set('Authorization', managerAuth)
      .send({
        actionCode: 'check_in',
        eventKey: `batch6-proxy-punch-${++sequence}`,
        participationIdentityId,
        reason: '现场纸质名单与本人确认后由负责人代签',
      });

    expect(punched.status).toBe(201);
    await expect(
      prisma.attendancePunchEvent.findFirstOrThrow({
        where: { eventKey: `batch6-proxy-punch-${sequence}` },
        select: { participationIdentityId: true, sourceCode: true, reason: true },
      }),
    ).resolves.toEqual({
      participationIdentityId,
      sourceCode: 'proxy',
      reason: '现场纸质名单与本人确认后由负责人代签',
    });
  });

  it('red-first: bulk punch freezes a canonical selected-identity set into a replayable worker job', async () => {
    const scenario = await createScenario();
    const participationIdentityId = await submitApplicant(scenario);
    const operationKey = `batch6-bulk-${++sequence}`;
    const body = {
      operationKey,
      actionCode: 'check_in',
      reason: '集中现场签到',
      participationIdentityIds: [participationIdentityId, participationIdentityId],
    };

    const created = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/${scenario.sessionId}` +
          '/bulk-punch-jobs',
      )
      .set('Authorization', managerAuth)
      .send(body);

    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      statusCode: 'pending',
      total: 1,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      replayed: false,
    });
    const jobId = created.body.data.jobId as string;
    await expect(
      prisma.activityBatchJob.findUniqueOrThrow({
        where: { id: jobId },
        select: {
          jobTypeCode: true,
          activityId: true,
          sessionId: true,
          total: true,
          payload: true,
          items: { select: { itemKey: true, resourceId: true, statusCode: true } },
        },
      }),
    ).resolves.toMatchObject({
      jobTypeCode: 'bulk_proxy',
      activityId: scenario.activityId,
      sessionId: scenario.sessionId,
      total: 1,
      payload: { action: 'onsite_bulk_punch', actionCode: 'check_in' },
      items: [
        {
          itemKey: `identity:${participationIdentityId}`,
          resourceId: participationIdentityId,
          statusCode: 'pending',
        },
      ],
    });

    const replayed = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/${scenario.sessionId}` +
          '/bulk-punch-jobs',
      )
      .set('Authorization', managerAuth)
      .send(body);
    expect(replayed.status).toBe(201);
    expect(replayed.body.data).toMatchObject({ jobId, replayed: true });

    const changed = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/${scenario.sessionId}` +
          '/bulk-punch-jobs',
      )
      .set('Authorization', managerAuth)
      .send({ ...body, actionCode: 'check_out' });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe(22088);

    const worker = app.get(ActivityBatchWorker);
    await expect(worker.drainOnce()).resolves.toMatchObject({
      jobClaimed: true,
      jobId,
      itemsProcessed: 1,
      itemsSkipped: 0,
      itemsFailed: 0,
    });
    await expect(
      prisma.activityBatchJob.findUniqueOrThrow({
        where: { id: jobId },
        select: {
          statusCode: true,
          succeeded: true,
          failed: true,
          skipped: true,
          items: {
            select: {
              id: true,
              statusCode: true,
              resultReference: true,
              punchEvents: { select: { sourceCode: true, eventKey: true } },
            },
          },
        },
      }),
    ).resolves.toMatchObject({
      statusCode: 'succeeded',
      succeeded: 1,
      failed: 0,
      skipped: 0,
      items: [
        {
          statusCode: 'succeeded',
          resultReference: expect.any(String),
          punchEvents: [
            {
              sourceCode: 'bulk',
              eventKey: expect.stringMatching(/^attendance-bulk:/u),
            },
          ],
        },
      ],
    });
  });

  it('serializes one bulk worker lease across two PostgreSQL pools and appends exactly one event', async () => {
    const scenario = await createScenario();
    const participationIdentityId = await submitApplicant(scenario);
    const created = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/${scenario.sessionId}` +
          '/bulk-punch-jobs',
      )
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch6-bulk-dual-worker-${++sequence}`,
        actionCode: 'check_in',
        reason: '双进程租约竞争',
        participationIdentityIds: [participationIdentityId],
      });
    expect(created.status).toBe(201);
    const jobId = created.body.data.jobId as string;

    const [left, right] = await Promise.all([
      app.get(ActivityBatchWorker).drainOnce(),
      peerApp.get(ActivityBatchWorker).drainOnce(),
    ]);
    expect([left, right].filter((result) => result.jobId === jobId)).toHaveLength(1);
    await expect(
      peerPrisma.attendancePunchEvent.count({
        where: { activityId: scenario.activityId, sourceCode: 'bulk' },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.activityBatchJob.findUniqueOrThrow({
        where: { id: jobId },
        select: { statusCode: true, succeeded: true, failed: true, skipped: true },
      }),
    ).resolves.toEqual({ statusCode: 'succeeded', succeeded: 1, failed: 0, skipped: 0 });
  });

  it('keeps a bulk job partial when one item hits an existing open segment and commits the other item', async () => {
    const scenario = await createScenario({ capacity: 2 });
    const participationIdentityId = await submitApplicant(scenario);
    const otherParticipationIdentityId = await submitMember(scenario, {
      auth: otherApplicantAuth,
      memberId: otherApplicantMemberId,
    });
    const alreadyOpen = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/${scenario.sessionId}` +
          '/proxy-punch',
      )
      .set('Authorization', managerAuth)
      .send({
        actionCode: 'check_in',
        eventKey: `batch6-partial-preopened-${++sequence}`,
        participationIdentityId,
        reason: '构造已开放服务段的真实现场代签',
      });
    expect(alreadyOpen.status).toBe(201);

    const created = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/${scenario.sessionId}` +
          '/bulk-punch-jobs',
      )
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch6-bulk-partial-${++sequence}`,
        actionCode: 'check_in',
        reason: '同一现场批次允许逐项部分成功',
        participationIdentityIds: [participationIdentityId, otherParticipationIdentityId],
      });
    expect(created.status).toBe(201);
    const jobId = created.body.data.jobId as string;

    await expect(peerApp.get(ActivityBatchWorker).drainOnce()).resolves.toMatchObject({
      jobClaimed: true,
      jobId,
      itemsProcessed: 1,
      itemsSkipped: 0,
      itemsFailed: 1,
    });
    await expect(
      prisma.activityBatchJob.findUniqueOrThrow({
        where: { id: jobId },
        select: {
          statusCode: true,
          succeeded: true,
          failed: true,
          skipped: true,
          items: { select: { statusCode: true, punchEvents: { select: { sourceCode: true } } } },
        },
      }),
    ).resolves.toMatchObject({
      statusCode: 'partial_failed',
      succeeded: 1,
      failed: 1,
      skipped: 0,
      items: expect.arrayContaining([
        { statusCode: 'succeeded', punchEvents: [{ sourceCode: 'bulk' }] },
        { statusCode: 'failed', punchEvents: [] },
      ]),
    });
  });

  it('rechecks a revoked collaborator through the worker and skips every pending bulk item without PunchEvent', async () => {
    const scenario = await createScenario({ capacity: 3 });
    const participationIdentityId = await submitApplicant(scenario);
    const otherParticipationIdentityId = await submitMember(scenario, {
      auth: otherApplicantAuth,
      memberId: otherApplicantMemberId,
    });
    await submitMember(scenario, { auth: operatorAuth, memberId: operatorMemberId });
    const collaborator = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${scenario.activityId}/responsibilities/collaborators`)
      .set('Authorization', adminAuth)
      .send({
        memberId: operatorMemberId,
        canManageRegistrations: false,
        canManageAttendance: true,
        reason: '验证批任务运行前撤销现场职责',
      });
    expect(collaborator.body.code).toBe(0);
    expect(collaborator.status).toBe(201);

    const created = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/${scenario.sessionId}` +
          '/bulk-punch-jobs',
      )
      .set('Authorization', operatorAuth)
      .send({
        operationKey: `batch6-bulk-revoked-${++sequence}`,
        actionCode: 'check_in',
        reason: '应在 worker 中重新确认当前职责',
        participationIdentityIds: [participationIdentityId, otherParticipationIdentityId],
      });
    expect(created.status).toBe(201);
    const jobId = created.body.data.jobId as string;

    const revoked = await request(httpServer(peerApp))
      .delete(
        `/api/admin/v1/activities/${scenario.activityId}/responsibilities/collaborators/` +
          `${collaborator.body.data.id as string}`,
      )
      .set('Authorization', adminAuth);
    expect(revoked.status).toBe(200);

    await expect(peerApp.get(ActivityBatchWorker).drainOnce()).resolves.toMatchObject({
      jobClaimed: true,
      jobId,
      itemsProcessed: 0,
      itemsSkipped: 2,
      itemsFailed: 0,
    });
    await expect(
      prisma.activityBatchJob.findUniqueOrThrow({
        where: { id: jobId },
        select: {
          statusCode: true,
          succeeded: true,
          failed: true,
          skipped: true,
          items: {
            select: {
              statusCode: true,
              lastErrorCode: true,
              punchEvents: { select: { id: true } },
            },
          },
        },
      }),
    ).resolves.toMatchObject({
      statusCode: 'failed',
      succeeded: 0,
      failed: 0,
      skipped: 2,
      items: [
        { statusCode: 'skipped', lastErrorCode: 'BizException:30100', punchEvents: [] },
        { statusCode: 'skipped', lastErrorCode: 'BizException:30100', punchEvents: [] },
      ],
    });
    await expect(
      peerPrisma.attendancePunchEvent.count({ where: { activityId: scenario.activityId } }),
    ).resolves.toBe(0);
  });

  it('red-first: bulk operationKey accepts only the approved 1-96 stable-key alphabet', async () => {
    const scenario = await createScenario();
    const participationIdentityId = await submitApplicant(scenario);
    const base = {
      actionCode: 'check_in',
      reason: '集中现场签到',
      participationIdentityIds: [participationIdentityId],
    };

    for (const operationKey of [`batch6.invalid.${++sequence}`, 'x'.repeat(97)]) {
      const response = await request(httpServer(app))
        .post(
          `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/${scenario.sessionId}` +
            '/bulk-punch-jobs',
        )
        .set('Authorization', managerAuth)
        .send({ ...base, operationKey });

      expect(response.status).toBe(400);
    }
  });

  it('red-first: a responsibility holder can create a pinned CSV import preview', async () => {
    const scenario = await createScenario();
    const participationIdentityId = await submitApplicant(scenario);
    const operationKey = `batch6-import-preview-${++sequence}`;
    const csv = [
      'participationIdentityId,actionCode,occurredAt,longitude,latitude,accuracy',
      `${participationIdentityId},check_in,${new Date().toISOString()},,,`,
    ].join('\n');

    const response = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/${scenario.sessionId}` +
          '/import-previews',
      )
      .set('Authorization', managerAuth)
      .field('operationKey', operationKey)
      .field('reason', '现场纸质签到表导入预览')
      .attach('file', Buffer.from(csv, 'utf8'), {
        filename: 'batch6-onsite.csv',
        contentType: 'text/csv',
      });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      statusCode: 'succeeded',
      total: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
      replayed: false,
    });
    await expect(
      prisma.activityBatchJob.findUniqueOrThrow({
        where: { id: response.body.data.jobId as string },
        select: {
          jobTypeCode: true,
          activityId: true,
          sessionId: true,
          statusCode: true,
          total: true,
          payload: true,
          items: { select: { itemKey: true, statusCode: true } },
        },
      }),
    ).resolves.toMatchObject({
      jobTypeCode: 'import_preview',
      activityId: scenario.activityId,
      sessionId: scenario.sessionId,
      statusCode: 'succeeded',
      total: 1,
      payload: { action: 'onsite_import_preview', parserVersion: 'attendance-import-csv/v1' },
      items: [{ itemKey: 'line:2', statusCode: 'succeeded' }],
    });

    const replayed = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/${scenario.sessionId}` +
          '/import-previews',
      )
      .set('Authorization', managerAuth)
      .field('operationKey', operationKey)
      .field('reason', '现场纸质签到表导入预览')
      .attach('file', Buffer.from(csv, 'utf8'), {
        filename: 'batch6-onsite.csv',
        contentType: 'text/csv',
      });
    expect(replayed.status).toBe(201);
    expect(replayed.body.data).toMatchObject({
      jobId: response.body.data.jobId,
      replayed: true,
    });

    const read = await request(httpServer(app))
      .get(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/import-previews/` +
          `${response.body.data.jobId}?page=1&pageSize=20`,
      )
      .set('Authorization', managerAuth);
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({
      jobId: response.body.data.jobId,
      fileDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      parserVersion: 'attendance-import-csv/v1',
      previewHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      items: {
        total: 1,
        page: 1,
        pageSize: 20,
        items: [{ line: 2, statusCode: 'succeeded' }],
      },
    });
    expect(JSON.stringify(read.body.data)).not.toContain('batch6-onsite.csv');

    const changed = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/${scenario.sessionId}` +
          '/import-previews',
      )
      .set('Authorization', managerAuth)
      .field('operationKey', operationKey)
      .field('reason', '现场纸质签到表导入预览')
      .attach('file', Buffer.from(`${csv}\n`, 'utf8'), {
        filename: 'batch6-onsite.csv',
        contentType: 'text/csv',
      });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe(22088);
  });

  it('serializes an exact same-key import preview across two HTTP applications and PostgreSQL pools', async () => {
    const scenario = await createScenario();
    const participationIdentityId = await submitApplicant(scenario);
    const operationKey = `batch6-import-dual-pool-${++sequence}`;
    const csv = [
      'participationIdentityId,actionCode,occurredAt,longitude,latitude,accuracy',
      `${participationIdentityId},check_in,${new Date().toISOString()},,,`,
    ].join('\n');
    const submitPreview = (target: INestApplication, auth: string) =>
      request(httpServer(target))
        .post(
          `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/${scenario.sessionId}` +
            '/import-previews',
        )
        .set('Authorization', auth)
        .field('operationKey', operationKey)
        .field('reason', '双 PostgreSQL 连接的同键导入预览')
        .attach('file', Buffer.from(csv, 'utf8'), {
          filename: 'batch6-dual-pool.csv',
          contentType: 'text/csv',
        });

    const [left, right] = await Promise.all([
      submitPreview(app, managerAuth),
      submitPreview(peerApp, managerPeerAuth),
    ]);
    expect([left.status, right.status].sort((a, b) => a - b)).toEqual([201, 201]);
    expect(left.body.data.jobId).toBe(right.body.data.jobId);
    expect([left.body.data.replayed, right.body.data.replayed].sort()).toEqual([false, true]);
    await expect(
      prisma.activityBatchJob.count({
        where: {
          activityId: scenario.activityId,
          jobTypeCode: 'import_preview',
          operationKey: `b6:import-preview:${scenario.activityId}:${operationKey}`,
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.attachment.count({
        where: { ownerType: 'attendance-import-preview', ownerId: left.body.data.jobId as string },
      }),
    ).resolves.toBe(1);
  });

  it('red-first: execute binds the approved preview digest and queues no direct PunchEvent', async () => {
    const scenario = await createScenario();
    const participationIdentityId = await submitApplicant(scenario);
    const importedAt = new Date().toISOString();
    const preview = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/${scenario.sessionId}` +
          '/import-previews',
      )
      .set('Authorization', managerAuth)
      .field('operationKey', `batch6-import-execute-preview-${++sequence}`)
      .field('reason', '冻结后执行纸质签到表')
      .attach(
        'file',
        Buffer.from(
          [
            'participationIdentityId,actionCode,occurredAt,longitude,latitude,accuracy',
            `${participationIdentityId},check_in,${importedAt},,,`,
          ].join('\n'),
          'utf8',
        ),
        { filename: 'batch6-execute.csv', contentType: 'text/csv' },
      );
    expect(preview.status).toBe(201);

    const previewId = preview.body.data.jobId as string;
    const summary = await request(httpServer(app))
      .get(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/import-previews/${previewId}` +
          '?page=1&pageSize=20',
      )
      .set('Authorization', managerAuth);
    expect(summary.status).toBe(200);

    const before = await prisma.attendancePunchEvent.count({
      where: { activityId: scenario.activityId },
    });
    const execute = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/import-previews/${previewId}/execute`,
      )
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch6-import-execute-${++sequence}`,
        fileDigest: summary.body.data.fileDigest,
        parserVersion: summary.body.data.parserVersion,
        previewHash: summary.body.data.previewHash,
      });

    expect(execute.status).toBe(201);
    expect(execute.body.data).toMatchObject({
      statusCode: 'pending',
      total: 1,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      replayed: false,
    });
    const executeJobId = execute.body.data.jobId as string;
    const replayed = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/import-previews/${previewId}/execute`,
      )
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch6-import-execute-${sequence}`,
        fileDigest: summary.body.data.fileDigest,
        parserVersion: summary.body.data.parserVersion,
        previewHash: summary.body.data.previewHash,
      });
    expect(replayed.status).toBe(201);
    expect(replayed.body.data).toMatchObject({ jobId: executeJobId, replayed: true });
    const conflict = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/import-previews/${previewId}/execute`,
      )
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch6-import-execute-${sequence}`,
        fileDigest: summary.body.data.fileDigest,
        parserVersion: summary.body.data.parserVersion,
        previewHash: '0'.repeat(64),
      });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe(22088);
    await expect(
      prisma.attendancePunchEvent.count({ where: { activityId: scenario.activityId } }),
    ).resolves.toBe(before);

    const worker = app.get(ActivityBatchWorker);
    await expect(worker.drainOnce()).resolves.toMatchObject({
      jobClaimed: true,
      jobId: executeJobId,
      itemsProcessed: 1,
      itemsSkipped: 0,
      itemsFailed: 0,
    });
    await expect(
      prisma.activityBatchJob.findUniqueOrThrow({
        where: { id: executeJobId },
        select: {
          statusCode: true,
          succeeded: true,
          failed: true,
          skipped: true,
          items: {
            select: {
              statusCode: true,
              resultReference: true,
              punchEvents: {
                select: {
                  sourceCode: true,
                  occurredAt: true,
                  importJobItemId: true,
                  eventKey: true,
                },
              },
            },
          },
        },
      }),
    ).resolves.toMatchObject({
      statusCode: 'succeeded',
      succeeded: 1,
      failed: 0,
      skipped: 0,
      items: [
        {
          statusCode: 'succeeded',
          resultReference: expect.any(String),
          punchEvents: [
            {
              sourceCode: 'import',
              occurredAt: new Date(importedAt),
              importJobItemId: expect.any(String),
              eventKey: expect.stringMatching(/^attendance-import:/u),
            },
          ],
        },
      ],
    });
  });

  it('mutation: replacing the pinned CSV fails both execute boundaries with 22100 and zero PunchEvent', async () => {
    const scenario = await createScenario();
    const participationIdentityId = await submitApplicant(scenario);
    const originalCsv = [
      'participationIdentityId,actionCode,occurredAt,longitude,latitude,accuracy',
      `${participationIdentityId},check_in,${new Date().toISOString()},,,`,
    ].join('\n');
    const changedIdentityId = `${participationIdentityId.slice(0, -1)}${
      participationIdentityId.endsWith('a') ? 'b' : 'a'
    }`;
    const replacedCsv = originalCsv.replace(participationIdentityId, changedIdentityId);
    expect(replacedCsv).not.toBe(originalCsv);
    expect(Buffer.byteLength(replacedCsv, 'utf8')).toBe(Buffer.byteLength(originalCsv, 'utf8'));

    async function createPinnedPreview(operationKey: string): Promise<{
      previewId: string;
      fileDigest: string;
      parserVersion: string;
      previewHash: string;
    }> {
      const preview = await request(httpServer(app))
        .post(
          `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/${scenario.sessionId}` +
            '/import-previews',
        )
        .set('Authorization', managerAuth)
        .field('operationKey', operationKey)
        .field('reason', '验证预览后的文件替换')
        .attach('file', Buffer.from(originalCsv, 'utf8'), {
          filename: 'batch6-adv014.csv',
          contentType: 'text/csv',
        });
      expect(preview.status).toBe(201);
      const previewId = preview.body.data.jobId as string;
      const summary = await request(httpServer(app))
        .get(
          `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/import-previews/${previewId}` +
            '?page=1&pageSize=20',
        )
        .set('Authorization', managerAuth);
      expect(summary.status).toBe(200);
      return { previewId, ...summary.body.data };
    }

    async function replacePinnedObject(previewId: string): Promise<void> {
      const attachment = await prisma.attachment.findFirstOrThrow({
        where: { ownerType: 'attendance-import-preview', ownerId: previewId },
        select: { key: true },
      });
      // 这是 ADV-014 的唯一对手面：真实已绑定对象在 provider 层被同长度内容替换；
      // 不改 Attachment/Job/事件表，随后仍只经 HTTP + worker 验证零业务写。
      await app.get(LocalStorageProvider).putObject({
        key: attachment.key,
        body: Buffer.from(replacedCsv, 'utf8'),
        contentType: 'text/csv',
      });
    }

    const beforeExecute = await createPinnedPreview(`batch6-adv014-before-${++sequence}`);
    await replacePinnedObject(beforeExecute.previewId);
    const beforeCount = await prisma.attendancePunchEvent.count({
      where: { activityId: scenario.activityId },
    });
    const rejected = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/import-previews/` +
          `${beforeExecute.previewId}/execute`,
      )
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch6-adv014-execute-${++sequence}`,
        fileDigest: beforeExecute.fileDigest,
        parserVersion: beforeExecute.parserVersion,
        previewHash: beforeExecute.previewHash,
      });
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe(22100);
    await expect(
      prisma.attendancePunchEvent.count({ where: { activityId: scenario.activityId } }),
    ).resolves.toBe(beforeCount);
    await expect(
      prisma.activityBatchJob.count({
        where: { activityId: scenario.activityId, jobTypeCode: 'import_execute' },
      }),
    ).resolves.toBe(0);

    const beforeWorker = await createPinnedPreview(`batch6-adv014-worker-${++sequence}`);
    const queued = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/import-previews/` +
          `${beforeWorker.previewId}/execute`,
      )
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch6-adv014-worker-execute-${++sequence}`,
        fileDigest: beforeWorker.fileDigest,
        parserVersion: beforeWorker.parserVersion,
        previewHash: beforeWorker.previewHash,
      });
    expect(queued.status).toBe(201);
    const executeJobId = queued.body.data.jobId as string;
    await replacePinnedObject(beforeWorker.previewId);
    const worker = app.get(ActivityBatchWorker);
    await expect(worker.drainOnce()).resolves.toMatchObject({
      jobClaimed: true,
      jobId: executeJobId,
      itemsProcessed: 0,
      itemsSkipped: 0,
      itemsFailed: 1,
    });
    await expect(
      prisma.activityBatchJob.findUniqueOrThrow({
        where: { id: executeJobId },
        select: {
          statusCode: true,
          succeeded: true,
          failed: true,
          items: { select: { statusCode: true, lastErrorCode: true } },
        },
      }),
    ).resolves.toMatchObject({
      statusCode: 'failed',
      succeeded: 0,
      failed: 1,
      items: [{ statusCode: 'failed', lastErrorCode: 'BizException:22100' }],
    });
    await expect(
      prisma.attendancePunchEvent.count({ where: { activityId: scenario.activityId } }),
    ).resolves.toBe(beforeCount);
  });

  // ===================================================================================
  // AC-044:「导入执行必须匹配**预览任务号、文件摘要和解析版本**;预览后替换文件时执行拒绝」
  //
  // 立项证据(本刀实测):替换文件那半边已由上面的 ADV-014 用例守住,但**三项匹配**里
  // 只有 fileDigest 被真的试错过 —— 既有用例每一处都原样回传 `summary.body.data.parserVersion`,
  // 全仓没有任何一条用例送过**不匹配的解析版本或不匹配的预览任务号**。
  // 三项各自绑一条,红集互不覆盖。
  // ===================================================================================

  /** 建一个已冻结的预览,返回执行时必须逐项匹配的三元组。 */
  async function createPinnedPreviewFor(
    scenario: Scenario,
    csv: string,
    label: string,
  ): Promise<{
    previewId: string;
    fileDigest: string;
    parserVersion: string;
    previewHash: string;
  }> {
    const preview = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/${scenario.sessionId}` +
          '/import-previews',
      )
      .set('Authorization', managerAuth)
      .field('operationKey', `batch7-ac044-${label}-${++sequence}`)
      .field('reason', 'AC-044 三项匹配判据')
      .attach('file', Buffer.from(csv, 'utf8'), {
        filename: `batch7-ac044-${label}.csv`,
        contentType: 'text/csv',
      });
    expect(preview.status).toBe(201);
    const previewId = preview.body.data.jobId as string;
    const summary = await request(httpServer(app))
      .get(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/import-previews/${previewId}` +
          '?page=1&pageSize=20',
      )
      .set('Authorization', managerAuth);
    expect(summary.status).toBe(200);
    return {
      previewId,
      fileDigest: summary.body.data.fileDigest as string,
      parserVersion: summary.body.data.parserVersion as string,
      previewHash: summary.body.data.previewHash as string,
    };
  }

  function executePreview(
    scenario: Scenario,
    previewId: string,
    body: Record<string, string>,
  ): request.Test {
    return request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/import-previews/` +
          `${previewId}/execute`,
      )
      .set('Authorization', managerAuth)
      .send(body);
  }

  /** 「零业务写」的统一判据:既没有 PunchEvent,也没有排出 import_execute 任务。 */
  async function expectNoImportSideEffects(scenario: Scenario, punchBefore: number): Promise<void> {
    await expect(
      prisma.attendancePunchEvent.count({ where: { activityId: scenario.activityId } }),
    ).resolves.toBe(punchBefore);
    await expect(
      prisma.activityBatchJob.count({
        where: { activityId: scenario.activityId, jobTypeCode: 'import_execute' },
      }),
    ).resolves.toBe(0);
  }

  it('AC-044 ①预览任务号:拿 A 预览的摘要去执行 B 预览 → 22100 且零业务写', async () => {
    const scenario = await createScenario();
    const participationIdentityId = await submitApplicant(scenario);
    const header = 'participationIdentityId,actionCode,occurredAt,longitude,latitude,accuracy';
    // 两个预览**内容不同** ⇒ 摘要必然不同;否则「拿错任务号」在数据上无从分辨。
    const previewA = await createPinnedPreviewFor(
      scenario,
      [header, `${participationIdentityId},check_in,${new Date().toISOString()},,,`].join('\n'),
      'task-a',
    );
    const previewB = await createPinnedPreviewFor(
      scenario,
      [
        header,
        `${participationIdentityId},check_in,${new Date(Date.now() - 60_000).toISOString()},,,`,
      ].join('\n'),
      'task-b',
    );
    // 先钉两边非空且确实不同 —— 否则下面的 22100 可能只是因为两个预览恰好一样。
    expect(previewA.previewId).not.toBe(previewB.previewId);
    expect(previewA.fileDigest).not.toBe(previewB.fileDigest);

    const punchBefore = await prisma.attendancePunchEvent.count({
      where: { activityId: scenario.activityId },
    });
    const crossed = await executePreview(scenario, previewB.previewId, {
      operationKey: `batch7-ac044-cross-${++sequence}`,
      fileDigest: previewA.fileDigest,
      parserVersion: previewA.parserVersion,
      previewHash: previewA.previewHash,
    });
    expect(crossed.status).toBe(409);
    expect(crossed.body.code).toBe(22100);
    await expectNoImportSideEffects(scenario, punchBefore);

    // 另一边非空:同一个 B 预览配**自己的**三元组照常放行 ——
    // 证明拒绝的是「任务号与摘要不对应」,不是「这个预览坏了」。
    const matched = await executePreview(scenario, previewB.previewId, {
      operationKey: `batch7-ac044-cross-ok-${++sequence}`,
      fileDigest: previewB.fileDigest,
      parserVersion: previewB.parserVersion,
      previewHash: previewB.previewHash,
    });
    expect(matched.status).toBe(201);
  });

  it('AC-044 ②文件摘要:摘要对不上 → 22100 且零业务写', async () => {
    const scenario = await createScenario();
    const participationIdentityId = await submitApplicant(scenario);
    const preview = await createPinnedPreviewFor(
      scenario,
      [
        'participationIdentityId,actionCode,occurredAt,longitude,latitude,accuracy',
        `${participationIdentityId},check_in,${new Date().toISOString()},,,`,
      ].join('\n'),
      'digest',
    );
    const punchBefore = await prisma.attendancePunchEvent.count({
      where: { activityId: scenario.activityId },
    });
    // 合法 sha256 形状但不是这份文件的摘要 —— 绕开入参形状校验,直取匹配那一层。
    const foreignDigest = 'a'.repeat(64);
    expect(foreignDigest).not.toBe(preview.fileDigest);
    const rejected = await executePreview(scenario, preview.previewId, {
      operationKey: `batch7-ac044-digest-${++sequence}`,
      fileDigest: foreignDigest,
      parserVersion: preview.parserVersion,
      previewHash: preview.previewHash,
    });
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe(22100);
    await expectNoImportSideEffects(scenario, punchBefore);
  });

  it('AC-044 ③解析版本:客户端谎报与预览由旧解析器冻结,两条边界都 400 fail-closed 且零业务写', async () => {
    const scenario = await createScenario();
    const participationIdentityId = await submitApplicant(scenario);
    const preview = await createPinnedPreviewFor(
      scenario,
      [
        'participationIdentityId,actionCode,occurredAt,longitude,latitude,accuracy',
        `${participationIdentityId},check_in,${new Date().toISOString()},,,`,
      ].join('\n'),
      'parser',
    );
    const punchBefore = await prisma.attendancePunchEvent.count({
      where: { activityId: scenario.activityId },
    });
    const staleParserVersion = 'attendance-import-csv/v0';
    expect(preview.parserVersion).not.toBe(staleParserVersion);

    // 第一层:客户端送一个非当前解析版本 —— 入参闸直接 400,连匹配那层都到不了。
    const liedVersion = await executePreview(scenario, preview.previewId, {
      operationKey: `batch7-ac044-parser-lie-${++sequence}`,
      fileDigest: preview.fileDigest,
      parserVersion: staleParserVersion,
      previewHash: preview.previewHash,
    });
    expect(liedVersion.status).toBe(400);
    await expectNoImportSideEffects(scenario, punchBefore);

    // 第二层:**预览本身**是旧解析器冻结的(模拟解析器升级后旧预览还留在库里),
    // 客户端如实送当前版本 ⇒ 仍然一条都写不进去。这一层是第一层永远够不到的那一格:
    // 第一层只看客户端说了什么,看不见**已冻结预览**里存的是什么版本。
    //
    // ⚠️ 实测口径(本刀实跑,勿按「应该是 22100」想当然改断言):
    //    这里落 **400** 而不是 22100 —— `isPreviewPayload` 把
    //    `parserVersion === ATTENDANCE_IMPORT_CSV_PARSER_VERSION` 写进了 payload 形状守卫,
    //    旧版本预览直接不再被认作合法预览,先于
    //    `payload.parserVersion !== input.parserVersion → 22100` 那一支被拦下。
    //    也就是说该 22100 分支**当前按构造不可达**(两侧都已各自恒等于同一个常量)。
    //    合同 AC-044 只要求「执行必须匹配解析版本」,未指定错误码;两层都 fail-closed
    //    即满足。若将来把版本闸放宽成「多版本共存」,那条 22100 才会活过来,
    //    届时本用例会因为 400≠409 当场红 —— 这正是要的:放宽必须被看见。
    const previewJob = await prisma.activityBatchJob.findUniqueOrThrow({
      where: { id: preview.previewId },
      select: { payload: true },
    });
    await prisma.activityBatchJob.update({
      where: { id: preview.previewId },
      data: {
        payload: {
          ...(previewJob.payload as Record<string, unknown>),
          parserVersion: staleParserVersion,
        },
      },
    });
    const staleFrozen = await executePreview(scenario, preview.previewId, {
      operationKey: `batch7-ac044-parser-stale-${++sequence}`,
      fileDigest: preview.fileDigest,
      parserVersion: preview.parserVersion,
      previewHash: preview.previewHash,
    });
    expect(staleFrozen.status).toBe(400);
    await expectNoImportSideEffects(scenario, punchBefore);
  });
});
