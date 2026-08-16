import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BindingScopeType, BindingStatus, MemberStatus, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import type { JwtConfig } from '../../src/config/jwt.config';
import { PrismaService } from '../../src/database/prisma.service';
import { AttendancePunchAuditRecorder } from '../../src/modules/attendances/attendance-punch-audit-recorder';
import { signAttendanceQrToken } from '../../src/modules/attendances/attendance-qr-token';
import { expectBizError } from '../helpers/biz-code.assert';
import { loginAs } from '../fixtures/auth.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

type Scenario = { activityId: string; sessionId: string; positionId: string };

describe('activity batch5 punch multi-instance concurrency', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let managerUsername: string;
  let managerMemberId: string;
  let managerUserId: string;
  let applicantUsername: string;
  let applicantMemberId: string;
  let applicantAuthA: string;
  let applicantAuthB: string;
  let otherApplicantUsername: string;
  let otherApplicantAuthA: string;
  let managerAuthA: string;
  let managerAuthB: string;
  let activityOwnerRoleId: string;
  let sequence = 0;

  beforeAll(async () => {
    jest.setTimeout(90_000);
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    activityOwnerRoleId = (await seedActivityResponsibilitySystemRoles(appA))['activity-owner'];

    const [manager, applicant, otherApplicant] = await Promise.all([
      createTestUser(appA, { username: 'b5-punch-conc-manager', role: Role.USER }),
      createTestUser(appA, { username: 'b5-punch-conc-applicant', role: Role.USER }),
      createTestUser(appA, { username: 'b5-punch-conc-other', role: Role.USER }),
    ]);
    const [managerMember, applicantMember, otherApplicantMember] = await Promise.all([
      prismaA.member.create({
        data: {
          memberNo: 'B5-PUNCH-CONC-MANAGER',
          displayName: 'Batch5 Punch Concurrency Manager',
          gradeCode: 'L1',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      }),
      prismaA.member.create({
        data: {
          memberNo: 'B5-PUNCH-CONC-APPLICANT',
          displayName: 'Batch5 Punch Concurrency Applicant',
          gradeCode: 'L1',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      }),
      prismaA.member.create({
        data: {
          memberNo: 'B5-PUNCH-CONC-OTHER',
          displayName: 'Batch5 Punch Concurrency Other Applicant',
          gradeCode: 'L1',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      }),
    ]);
    managerUsername = manager.username;
    managerMemberId = managerMember.id;
    managerUserId = manager.id;
    applicantUsername = applicant.username;
    applicantMemberId = applicantMember.id;
    otherApplicantUsername = otherApplicant.username;
    await Promise.all([
      prismaA.user.update({ where: { id: manager.id }, data: { memberId: managerMember.id } }),
      prismaA.user.update({ where: { id: applicant.id }, data: { memberId: applicantMember.id } }),
      prismaA.user.update({
        where: { id: otherApplicant.id },
        data: { memberId: otherApplicantMember.id },
      }),
    ]);
    [managerAuthA, applicantAuthA, managerAuthB, applicantAuthB, otherApplicantAuthA] = await Promise.all([
      loginAs(appA, managerUsername).then(({ authHeader }) => authHeader),
      loginAs(appA, applicantUsername).then(({ authHeader }) => authHeader),
      loginAs(appB, managerUsername).then(({ authHeader }) => authHeader),
      loginAs(appB, applicantUsername).then(({ authHeader }) => authHeader),
      loginAs(appA, otherApplicantUsername).then(({ authHeader }) => authHeader),
    ]);
  });
  afterAll(async () => {
    await Promise.all([appA.close(), appB.close()]);
  });

  function punchPath(scenario: Scenario): string {
    return `/api/app/v1/activities/${scenario.activityId}/sessions/${scenario.sessionId}/punches/check-in`;
  }

  function issuePath(scenario: Scenario): string {
    return (
      `/api/app/v1/my/managed-activities/${scenario.activityId}/sessions/${scenario.sessionId}` +
      '/qr-credentials/check-in/issue'
    );
  }

  async function createScenario(input?: { startOffsetMinutes?: number }): Promise<Scenario> {
    const index = ++sequence;
    const now = new Date();
    const startAt = new Date(now.getTime() + (input?.startOffsetMinutes ?? -10) * 60_000);
    const endAt = new Date(startAt.getTime() + 2 * 60 * 60_000);
    const organization = await prismaA.organization.create({
      data: { name: `Batch5 Punch Concurrency Team ${index}`, nodeTypeCode: 'batch5-punch-conc-team' },
      select: { id: true },
    });
    const activity = await prismaA.activity.create({
      data: {
        title: `Batch5 Punch Concurrency Activity ${index}`,
        activityTypeCode: 'training',
        organizationId: organization.id,
        startAt,
        endAt,
        location: 'Batch5 Punch Concurrency Field',
        statusCode: 'published',
        publishedAt: now,
        capacity: 1,
        isPublicRegistration: true,
        allocationModeCode: 'first_come',
        registrationDeadline: new Date(now.getTime() + 60 * 60_000),
      },
      select: { id: true },
    });
    const session = await prismaA.activitySession.create({
      data: {
        activityId: activity.id,
        code: `batch5-punch-concurrency-session-${index}`,
        name: `Batch5 Punch Concurrency Session ${index}`,
        startAt,
        endAt,
        locationText: 'Batch5 Punch Concurrency Field',
        capacity: 1,
        checkInOpenAt: new Date(now.getTime() - 5 * 60_000),
        checkInCloseAt: new Date(now.getTime() + 30 * 60_000),
        checkOutOpenAt: new Date(now.getTime() - 5 * 60_000),
        checkOutCloseAt: new Date(now.getTime() + 30 * 60_000),
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });
    const position = await prismaA.activitySessionPosition.create({
      data: {
        activityId: activity.id,
        sessionId: session.id,
        code: `batch5-punch-concurrency-position-${index}`,
        name: `Batch5 Punch Concurrency Position ${index}`,
        attendanceRoleCode: 'volunteer',
        capacity: 1,
      },
      select: { id: true },
    });
    await prismaA.activityCapacityBucket.createMany({
      data: [
        { activityId: activity.id, scopeTypeCode: 'activity_person', scopeId: activity.id, capacity: 1 },
        { activityId: activity.id, scopeTypeCode: 'session_participation', scopeId: session.id, capacity: 1 },
        {
          activityId: activity.id,
          scopeTypeCode: 'position_participation',
          scopeId: position.id,
          capacity: 1,
        },
      ],
    });
    await prismaA.activityEvidenceState.create({ data: { activityId: activity.id } });
    await prismaA.activityResponsibilityAssignment.create({
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
    await prismaA.roleBinding.create({
      data: {
        principalType: PrincipalType.MEMBER,
        principalId: managerMemberId,
        roleId: activityOwnerRoleId,
        scopeType: BindingScopeType.ACTIVITY,
        scopeActivityId: activity.id,
        status: BindingStatus.ACTIVE,
        note: `batch5 punch concurrency fixture ${index}`,
      },
    });
    return { activityId: activity.id, sessionId: session.id, positionId: position.id };
  }

  async function register(scenario: Scenario, auth = applicantAuthA): Promise<void> {
    const registered = await request(httpServer(appA))
      .post(`/api/app/v1/activities/${scenario.activityId}/registrations`)
      .set('Authorization', auth)
      .send({
        operationKey: `batch5-concurrency-register-${++sequence}`,
        formVersion: null,
        answers: [],
        preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
    });
    expect(registered.status).toBe(201);
  }

  async function issueToken(scenario: Scenario, action: 'check-in' | 'check-out'): Promise<string> {
    const issued = await request(httpServer(appA))
      .post(
        action === 'check-in'
          ? issuePath(scenario)
          : issuePath(scenario).replace('/check-in/issue', '/check-out/issue'),
      )
      .set('Authorization', managerAuthA)
      .send({ operationKey: `batch5-concurrency-issue-${++sequence}` });
    expect(issued.status).toBe(201);
    const credential = await prismaA.attendanceQrCredential.findUniqueOrThrow({
      where: { id: issued.body.data.credentialId as string },
      select: {
        id: true,
        activityId: true,
        sessionId: true,
        actionCode: true,
        credentialVersion: true,
        validFrom: true,
        validUntil: true,
      },
    });
    const config = appA.get(ConfigService).get<JwtConfig>('jwt');
    if (
      !config ||
      (credential.actionCode !== 'check_in' && credential.actionCode !== 'check_out')
    ) {
      throw new Error('B5 concurrency credential invalid');
    }
    return signAttendanceQrToken(
      {
        credentialId: credential.id,
        activityId: credential.activityId,
        sessionId: credential.sessionId,
        actionCode: credential.actionCode,
        credentialVersion: credential.credentialVersion,
        validFrom: credential.validFrom,
        validUntil: credential.validUntil,
      },
      config.secret,
    );
  }

  async function registerAndIssue(scenario: Scenario): Promise<string> {
    await register(scenario);
    return issueToken(scenario, 'check-in');
  }

  async function waitForLockWaiter(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const [row] = await prismaB.$queryRaw<Array<{ waitingCount: number }>>`
        SELECT count(*)::int AS "waitingCount"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
      `;
      if ((row?.waitingCount ?? 0) > 0) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('expected a PostgreSQL lock waiter before releasing the punch transaction');
  }

  it('proves two Nest apps hold independent PostgreSQL connections', async () => {
    expect(appA.getHttpServer()).not.toBe(appB.getHttpServer());
    expect(prismaA).not.toBe(prismaB);
    const [[a], [b]] = await Promise.all([
      prismaA.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
      prismaB.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
    ]);
    expect(a?.pid).toBeDefined();
    expect(b?.pid).toBeDefined();
    expect(a?.pid).not.toBe(b?.pid);
  });

  it('serializes exact same-key replay and rejects a changed request under the global event key', async () => {
    const scenario = await createScenario();
    const token = await registerAndIssue(scenario);
    const payload = { qrToken: token, eventKey: `batch5-concurrency-replay-${++sequence}` };
    const [left, right] = await Promise.all([
      request(httpServer(appA)).post(punchPath(scenario)).set('Authorization', applicantAuthA).send(payload),
      request(httpServer(appB)).post(punchPath(scenario)).set('Authorization', applicantAuthB).send(payload),
    ]);
    expect(left.status).toBe(201);
    expect(right.status).toBe(201);
    expect(right.body).toEqual(left.body);
    const remainingNinetyEightReplays = await Promise.all(
      Array.from({ length: 98 }, (_, index) =>
        request(httpServer(index % 2 === 0 ? appA : appB))
          .post(punchPath(scenario))
          .set('Authorization', index % 2 === 0 ? applicantAuthA : applicantAuthB)
          .send(payload),
      ),
    );
    expect(remainingNinetyEightReplays).toHaveLength(98);
    for (const replay of remainingNinetyEightReplays) {
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(left.body);
    }
    await expect(
      prismaA.attendancePunchEvent.count({ where: { activityId: scenario.activityId } }),
    ).resolves.toBe(1);
    await expect(
      prismaA.activityEvidenceState.findUniqueOrThrow({
        where: { activityId: scenario.activityId },
        select: { evidenceRevision: true },
      }),
    ).resolves.toEqual({ evidenceRevision: 1 });

    const changed = await request(httpServer(appB))
      .post(punchPath(scenario))
      .set('Authorization', applicantAuthB)
      .send({ ...payload, longitude: 116.397128, latitude: 39.916527, accuracy: 10 });
    expectBizError(changed, BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);
    await expect(
      prismaB.attendancePunchEvent.count({ where: { activityId: scenario.activityId } }),
    ).resolves.toBe(1);
  });

  it('serializes distinct keys to one open segment and makes QR revoke race resolve to zero or one append', async () => {
    const distinctScenario = await createScenario();
    const distinctToken = await registerAndIssue(distinctScenario);
    const [left, right] = await Promise.all([
      request(httpServer(appA))
        .post(punchPath(distinctScenario))
        .set('Authorization', applicantAuthA)
        .send({ qrToken: distinctToken, eventKey: `batch5-concurrency-distinct-left-${++sequence}` }),
      request(httpServer(appB))
        .post(punchPath(distinctScenario))
        .set('Authorization', applicantAuthB)
        .send({ qrToken: distinctToken, eventKey: `batch5-concurrency-distinct-right-${++sequence}` }),
    ]);
    expect([left.status, right.status].sort()).toEqual([
      201,
      BizCode.ATTENDANCE_PUNCH_OPEN_SEGMENT_EXISTS.httpStatus,
    ]);
    const rejected = left.status === 201 ? right : left;
    expectBizError(rejected, BizCode.ATTENDANCE_PUNCH_OPEN_SEGMENT_EXISTS);
    await expect(
      prismaA.attendancePunchEvent.count({ where: { activityId: distinctScenario.activityId } }),
    ).resolves.toBe(1);

    const raceScenario = await createScenario();
    const raceToken = await registerAndIssue(raceScenario);
    const credential = await prismaA.attendanceQrCredential.findFirstOrThrow({
      where: { activityId: raceScenario.activityId, sessionId: raceScenario.sessionId, actionCode: 'check_in' },
      select: { id: true },
    });
    const [punch, revoked] = await Promise.all([
      request(httpServer(appA))
        .post(punchPath(raceScenario))
        .set('Authorization', applicantAuthA)
        .send({ qrToken: raceToken, eventKey: `batch5-concurrency-revoke-race-punch-${++sequence}` }),
      request(httpServer(appB))
        .post(
          `/api/app/v1/my/managed-activities/${raceScenario.activityId}` +
            `/qr-credentials/${credential.id}/revoke`,
        )
        .set('Authorization', managerAuthB)
        .send({ operationKey: `batch5-concurrency-revoke-race-${++sequence}`, reason: '并发作废验证' }),
    ]);
    expect(revoked.status).toBe(200);
    if (punch.status === 201) {
      expect(punch.body.data).toMatchObject({ eventTypeCode: 'check_in', segmentStatusCode: 'open' });
    } else {
      expectBizError(punch, BizCode.ATTENDANCE_QR_REVOKED);
    }
    const [eventCount, revokedCredential] = await Promise.all([
      prismaB.attendancePunchEvent.count({ where: { activityId: raceScenario.activityId } }),
      prismaB.attendanceQrCredential.findUniqueOrThrow({
        where: { id: credential.id },
        select: { statusCode: true },
      }),
    ]);
    expect(eventCount).toBe(punch.status === 201 ? 1 : 0);
    expect(revokedCredential.statusCode).toBe('revoked');
  });

  it('rejects same event key when a valid request changes person, activity, action or source', async () => {
    const scenario = await createScenario();
    const checkInToken = await registerAndIssue(scenario);
    const checkOutToken = await issueToken(scenario, 'check-out');
    const eventKey = `batch5-concurrency-hash-shape-${++sequence}`;
    const created = await request(httpServer(appA))
      .post(punchPath(scenario))
      .set('Authorization', applicantAuthA)
      .send({ qrToken: checkInToken, eventKey });
    expect(created.status).toBe(201);

    await register(scenario, otherApplicantAuthA);
    const changedPerson = await request(httpServer(appA))
      .post(punchPath(scenario))
      .set('Authorization', otherApplicantAuthA)
      .send({ qrToken: checkInToken, eventKey });
    expectBizError(changedPerson, BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);

    const changedAction = await request(httpServer(appB))
      .post(
        `/api/app/v1/activities/${scenario.activityId}/sessions/${scenario.sessionId}/punches/check-out`,
      )
      .set('Authorization', applicantAuthB)
      .send({ qrToken: checkOutToken, eventKey });
    expectBizError(changedAction, BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);

    const identity = await prismaA.activityParticipationIdentity.findFirstOrThrow({
      where: {
        activityId: scenario.activityId,
        sessionId: scenario.sessionId,
        memberId: applicantMemberId,
      },
      select: { id: true },
    });
    const changedSource = await request(httpServer(appB))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/${scenario.sessionId}` +
          '/early-departure-close',
      )
      .set('Authorization', managerAuthB)
      .send({ participationIdentityId: identity.id, eventKey, reason: '来源冲突验证' });
    expectBizError(changedSource, BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);

    const otherScenario = await createScenario();
    const otherToken = await registerAndIssue(otherScenario);
    const changedActivity = await request(httpServer(appA))
      .post(punchPath(otherScenario))
      .set('Authorization', applicantAuthA)
      .send({ qrToken: otherToken, eventKey });
    expectBizError(changedActivity, BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);

    await expect(
      prismaB.attendancePunchEvent.count({ where: { eventKey } }),
    ).resolves.toBe(1);
  });

  it('red-first: activity cancellation waits behind the first punch and must not cancel once the punch commits', async () => {
    const scenario = await createScenario({ startOffsetMinutes: 10 });
    const token = await registerAndIssue(scenario);
    const audit = appA.get(AttendancePunchAuditRecorder);
    const originalLogPunch = audit.logPunch.bind(audit);
    let releasePunch!: () => void;
    let punchReached!: () => void;
    const releasePunchPromise = new Promise<void>((resolve) => {
      releasePunch = resolve;
    });
    const punchReachedPromise = new Promise<void>((resolve) => {
      punchReached = resolve;
    });
    const logSpy = jest.spyOn(audit, 'logPunch').mockImplementation(async (args) => {
      punchReached();
      await releasePunchPromise;
      return originalLogPunch(args);
    });

    try {
      const punch = request(httpServer(appA))
        .post(punchPath(scenario))
        .set('Authorization', applicantAuthA)
        .send({ qrToken: token, eventKey: `batch5-cancel-race-punch-${++sequence}` })
        .then((response) => response);
      await punchReachedPromise;
      const cancel = request(httpServer(appB))
        .post(`/api/app/v1/my/managed-activities/${scenario.activityId}/cancel`)
        .set('Authorization', managerAuthB)
        .send({
          reason: '与第一条现场签到并发取消',
          strongConfirmed: true,
          operationKey: `batch5-cancel-race-cancel-${++sequence}`,
        })
        .then((response) => response);
      await waitForLockWaiter();
      releasePunch();
      const [punchResponse, cancelResponse] = await Promise.all([punch, cancel]);
      expect(punchResponse.status).toBe(201);
      expectBizError(cancelResponse, BizCode.ACTIVITY_STATUS_INVALID);
      await expect(
        prismaA.activity.findUniqueOrThrow({
          where: { id: scenario.activityId },
          select: { statusCode: true },
        }),
      ).resolves.toEqual({ statusCode: 'published' });
    } finally {
      logSpy.mockRestore();
      releasePunch();
    }
  });
});
