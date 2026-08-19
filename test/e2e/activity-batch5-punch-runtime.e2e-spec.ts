import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BindingScopeType, BindingStatus, MemberStatus, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import type { JwtConfig } from '../../src/config/jwt.config';
import { PrismaService } from '../../src/database/prisma.service';
import { signAttendanceQrToken } from '../../src/modules/attendances/attendance-qr-token';
import { expectBizError } from '../helpers/biz-code.assert';
import { loginAs } from '../fixtures/auth.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const FUTURE_START = new Date('2099-12-15T08:00:00.000Z');
const FUTURE_END = new Date('2099-12-15T12:00:00.000Z');

describe('activity batch5 punch runtime', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let managerAuth: string;
  let managerUsername: string;
  let managerMemberId: string;
  let managerUserId: string;
  let applicantAuth: string;
  let applicantUsername: string;
  let applicantMemberId: string;
  let activityOwnerRoleId: string;
  let sequence = 0;

  beforeAll(async () => {
    // 第 7 批第 ③ 刀 —— 活动 v1.1 单一 cutover gate(合同 §16.2)。本 spec 驱动的是
    // **结算真相链**(打卡 / 封场 / 结算 / 账本 / 关账 / 更正),那条链按定义只在闸开时存在;
    // 闸关(默认 = 今天的行为)时这些写入口一律回 20153。故此处显式置真,
    // **断言一字未改** —— 改的只是这个 spec 声明自己跑在哪一侧闸。
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    jest.setTimeout(90_000);
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    activityOwnerRoleId = (await seedActivityResponsibilitySystemRoles(app))['activity-owner'];

    const [manager, applicant] = await Promise.all([
      createTestUser(app, { username: 'batch5-punch-manager', role: Role.USER }),
      createTestUser(app, { username: 'batch5-punch-applicant', role: Role.USER }),
    ]);
    const [member, applicantMember] = await Promise.all([
      prisma.member.create({
        data: {
          memberNo: 'B5-PUNCH-MANAGER',
          displayName: 'Batch5 Punch Manager',
          gradeCode: 'L1',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      }),
      prisma.member.create({
        data: {
          memberNo: 'B5-PUNCH-APPLICANT',
          displayName: 'Batch5 Punch Applicant',
          gradeCode: 'L1',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      }),
    ]);
    managerMemberId = member.id;
    managerUserId = manager.id;
    applicantMemberId = applicantMember.id;
    managerUsername = manager.username;
    applicantUsername = applicant.username;
    await Promise.all([
      prisma.user.update({ where: { id: manager.id }, data: { memberId: member.id } }),
      prisma.user.update({ where: { id: applicant.id }, data: { memberId: applicantMember.id } }),
    ]);
    managerAuth = (await loginAs(app, manager.username)).authHeader;
    applicantAuth = (await loginAs(app, applicant.username)).authHeader;
  });

  afterAll(async () => {
    delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    await app.close();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function freezeSystemTime(now: Date): void {
    jest.useFakeTimers({
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    jest.setSystemTime(now);
  }

  async function createScenario(input?: {
    locationRequired?: boolean;
    longitude?: number | null;
    latitude?: number | null;
    radiusMeters?: number | null;
  }): Promise<{ activityId: string; sessionId: string; positionId: string }> {
    const index = ++sequence;
    const organization = await prisma.organization.create({
      data: { name: `Batch5 Punch Team ${index}`, nodeTypeCode: 'batch5-punch-team' },
      select: { id: true },
    });
    const activity = await prisma.activity.create({
      data: {
        title: `Batch5 Punch Activity ${index}`,
        activityTypeCode: 'training',
        organizationId: organization.id,
        startAt: FUTURE_START,
        endAt: FUTURE_END,
        location: 'Batch5 Punch Field',
        statusCode: 'published',
        publishedAt: new Date(),
        capacity: 1,
        isPublicRegistration: true,
        allocationModeCode: 'first_come',
        registrationDeadline: new Date('2099-12-14T23:59:59.000Z'),
      },
      select: { id: true },
    });
    const session = await prisma.activitySession.create({
      data: {
        activityId: activity.id,
        code: `batch5-punch-session-${index}`,
        name: `Batch5 Punch Session ${index}`,
        startAt: FUTURE_START,
        endAt: FUTURE_END,
        locationText: 'Batch5 Punch Field',
        capacity: 1,
        checkInOpenAt: new Date(FUTURE_START.getTime() - 30 * 60_000),
        checkInCloseAt: new Date(FUTURE_START.getTime() + 30 * 60_000),
        // Window overlap is contractual; it makes the 29:59 / 30:00 rule independently testable.
        checkOutOpenAt: FUTURE_START,
        checkOutCloseAt: new Date(FUTURE_END.getTime() + 30 * 60_000),
        longitude: input?.longitude ?? null,
        latitude: input?.latitude ?? null,
        locationRequired: input?.locationRequired ?? false,
        radiusMeters: input?.radiusMeters ?? null,
        accuracyWarningMeters: 100,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });
    const position = await prisma.activitySessionPosition.create({
      data: {
        activityId: activity.id,
        sessionId: session.id,
        code: `batch5-punch-position-${index}`,
        name: `Batch5 Punch Position ${index}`,
        attendanceRoleCode: 'volunteer',
        capacity: 1,
      },
      select: { id: true },
    });
    await prisma.activityCapacityBucket.createMany({
      data: [
        {
          activityId: activity.id,
          scopeTypeCode: 'activity_person',
          scopeId: activity.id,
          capacity: 1,
        },
        {
          activityId: activity.id,
          scopeTypeCode: 'session_participation',
          scopeId: session.id,
          capacity: 1,
        },
        {
          activityId: activity.id,
          scopeTypeCode: 'position_participation',
          scopeId: position.id,
          capacity: 1,
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
        note: `batch5 punch fixture ${index}`,
      },
    });
    return { activityId: activity.id, sessionId: session.id, positionId: position.id };
  }

  const qrIssuePath = (
    scenario: { activityId: string; sessionId: string },
    action: 'check-in' | 'check-out',
  ) =>
    `/api/app/v1/my/managed-activities/${scenario.activityId}/sessions/${scenario.sessionId}` +
    `/qr-credentials/${action}/issue`;

  const selfPunchPath = (
    scenario: { activityId: string; sessionId: string },
    action: 'check-in' | 'check-out',
  ) =>
    `/api/app/v1/activities/${scenario.activityId}/sessions/${scenario.sessionId}/punches/${action}`;

  const onsitePath = (scenario: { activityId: string }) =>
    `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite`;

  async function submitApplicant(scenario: {
    activityId: string;
    sessionId: string;
    positionId: string;
  }) {
    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/activities/${scenario.activityId}/registrations`)
      .set('Authorization', applicantAuth)
      .send({
        operationKey: `batch5-punch-register-${++sequence}`,
        formVersion: null,
        answers: [],
        preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
      });
    expect(submitted.status).toBe(201);
    return submitted;
  }

  async function issueCredential(
    scenario: { activityId: string; sessionId: string },
    action: 'check-in' | 'check-out',
    operationKey: string,
    auth = managerAuth,
  ) {
    const issued = await request(httpServer(app))
      .post(qrIssuePath(scenario, action))
      .set('Authorization', auth)
      .send({ operationKey });
    expect(issued.status).toBe(201);
    return issued;
  }

  async function tokenForCredential(credentialId: string): Promise<string> {
    const credential = await prisma.attendanceQrCredential.findUniqueOrThrow({
      where: { id: credentialId },
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
    const config = app.get(ConfigService).get<JwtConfig>('jwt');
    if (
      !config ||
      (credential.actionCode !== 'check_in' && credential.actionCode !== 'check_out')
    ) {
      throw new Error('B5 test credential cannot be signed');
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

  async function participationIdentityIdFor(scenario: { activityId: string; sessionId: string }) {
    const identity = await prisma.activityParticipationIdentity.findFirstOrThrow({
      where: {
        activityId: scenario.activityId,
        sessionId: scenario.sessionId,
        memberId: applicantMemberId,
      },
      select: { id: true },
    });
    return identity.id;
  }

  it('red-first: issues a managed check-in QR credential through the production HTTP route', async () => {
    const scenario = await createScenario();

    const issued = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/sessions/${scenario.sessionId}` +
          '/qr-credentials/check-in/issue',
      )
      .set('Authorization', managerAuth)
      .send({ operationKey: 'batch5-punch-issue-check-in-0001' });

    expect(issued.status).toBe(201);
    expect(issued.body.data).toEqual(
      expect.objectContaining({
        actionCode: 'check_in',
        credentialVersion: 1,
        statusCode: 'active',
      }),
    );
    expect(JSON.stringify(issued.body.data)).not.toContain('token');
  });

  it('rejects QR action, activity, session and time-window mismatches with zero punch writes', async () => {
    const scenario = await createScenario();
    const otherScenario = await createScenario();
    await submitApplicant(scenario);
    const issued = await issueCredential(
      scenario,
      'check-in',
      `batch5-mismatch-issue-${++sequence}`,
    );
    const token = await tokenForCredential(issued.body.data.credentialId as string);

    freezeSystemTime(new Date('2099-12-15T08:00:00.000Z'));
    const freshApplicantAuth = (await loginAs(app, applicantUsername)).authHeader;
    const wrongAction = await request(httpServer(app))
      .post(selfPunchPath(scenario, 'check-out'))
      .set('Authorization', freshApplicantAuth)
      .send({ qrToken: token, eventKey: `batch5-mismatch-action-${++sequence}` });
    expectBizError(wrongAction, BizCode.ATTENDANCE_QR_ACTION_MISMATCH);

    const wrongSession = await request(httpServer(app))
      .post(
        `/api/app/v1/activities/${scenario.activityId}/sessions/${otherScenario.sessionId}/punches/check-in`,
      )
      .set('Authorization', freshApplicantAuth)
      .send({ qrToken: token, eventKey: `batch5-mismatch-session-${++sequence}` });
    expectBizError(wrongSession, BizCode.ATTENDANCE_QR_NOT_FOUND);

    const wrongActivity = await request(httpServer(app))
      .post(selfPunchPath(otherScenario, 'check-in'))
      .set('Authorization', freshApplicantAuth)
      .send({ qrToken: token, eventKey: `batch5-mismatch-activity-${++sequence}` });
    expectBizError(wrongActivity, BizCode.ATTENDANCE_QR_NOT_FOUND);

    freezeSystemTime(new Date('2099-12-15T07:29:59.000Z'));
    const outsideWindow = await request(httpServer(app))
      .post(selfPunchPath(scenario, 'check-in'))
      .set('Authorization', (await loginAs(app, applicantUsername)).authHeader)
      .send({ qrToken: token, eventKey: `batch5-mismatch-window-${++sequence}` });
    expectBizError(outsideWindow, BizCode.ATTENDANCE_PUNCH_OUTSIDE_WINDOW);

    const [eventCount, evidence, otherEventCount] = await Promise.all([
      prisma.attendancePunchEvent.count({ where: { activityId: scenario.activityId } }),
      prisma.activityEvidenceState.findUniqueOrThrow({
        where: { activityId: scenario.activityId },
        select: { evidenceRevision: true },
      }),
      prisma.attendancePunchEvent.count({ where: { activityId: otherScenario.activityId } }),
    ]);
    expect(eventCount).toBe(0);
    expect(evidence.evidenceRevision).toBe(0);
    expect(otherEventCount).toBe(0);
  });

  it('uses real registration, QR signing, the 29:59/30:00 boundary, and segment projection end to end', async () => {
    const scenario = await createScenario();
    await submitApplicant(scenario);
    const [checkInIssued, checkOutIssued] = await Promise.all([
      issueCredential(scenario, 'check-in', `batch5-runtime-in-issue-${++sequence}`),
      issueCredential(scenario, 'check-out', `batch5-runtime-out-issue-${++sequence}`),
    ]);
    const [checkInToken, checkOutToken] = await Promise.all([
      tokenForCredential(checkInIssued.body.data.credentialId as string),
      tokenForCredential(checkOutIssued.body.data.credentialId as string),
    ]);

    freezeSystemTime(new Date('2099-12-15T08:00:00.000Z'));
    const checkIn = await request(httpServer(app))
      .post(selfPunchPath(scenario, 'check-in'))
      .set('Authorization', (await loginAs(app, applicantUsername)).authHeader)
      .send({ qrToken: checkInToken, eventKey: `batch5-runtime-check-in-${++sequence}` });
    expect(checkIn.status).toBe(201);
    expect(checkIn.body.data).toMatchObject({
      eventTypeCode: 'check_in',
      segmentStatusCode: 'open',
      nextAllowedAction: 'check_out',
      geoVerified: false,
    });
    expect(JSON.stringify(checkIn.body.data)).not.toContain('longitude');
    expect(JSON.stringify(checkIn.body.data)).not.toContain('latitude');

    const state = await request(httpServer(app))
      .get(
        `/api/app/v1/activities/${scenario.activityId}/sessions/${scenario.sessionId}/my-punch-state`,
      )
      .set('Authorization', (await loginAs(app, applicantUsername)).authHeader);
    expect(state.status).toBe(200);
    expect(state.body.data).toMatchObject({ isPresent: true, nextAllowedAction: 'check_out' });

    freezeSystemTime(new Date('2099-12-15T08:29:59.000Z'));
    const tooSoon = await request(httpServer(app))
      .post(selfPunchPath(scenario, 'check-out'))
      .set('Authorization', (await loginAs(app, applicantUsername)).authHeader)
      .send({ qrToken: checkOutToken, eventKey: `batch5-runtime-too-soon-${++sequence}` });
    expectBizError(tooSoon, BizCode.ATTENDANCE_PUNCH_MIN_DURATION_NOT_REACHED);
    await expect(
      prisma.attendancePunchEvent.count({ where: { activityId: scenario.activityId } }),
    ).resolves.toBe(1);

    freezeSystemTime(new Date('2099-12-15T08:30:00.000Z'));
    const checkOut = await request(httpServer(app))
      .post(selfPunchPath(scenario, 'check-out'))
      .set('Authorization', (await loginAs(app, applicantUsername)).authHeader)
      .send({ qrToken: checkOutToken, eventKey: `batch5-runtime-check-out-${++sequence}` });
    expect(checkOut.status).toBe(201);
    expect(checkOut.body.data).toMatchObject({
      eventTypeCode: 'check_out',
      segmentStatusCode: 'closed_valid',
      nextAllowedAction: 'check_in',
    });
    const [stateAfter, segments, evidence] = await Promise.all([
      request(httpServer(app))
        .get(
          `/api/app/v1/activities/${scenario.activityId}/sessions/${scenario.sessionId}/my-punch-state`,
        )
        .set('Authorization', (await loginAs(app, applicantUsername)).authHeader),
      prisma.participantServiceSegmentRevision.findMany({
        where: { identity: { activityId: scenario.activityId, memberId: applicantMemberId } },
        select: { statusCode: true, resultCode: true, checkOutAt: true, serviceHours: true },
        orderBy: { revision: 'asc' },
      }),
      prisma.activityEvidenceState.findUniqueOrThrow({
        where: { activityId: scenario.activityId },
        select: { evidenceRevision: true },
      }),
    ]);
    expect(stateAfter.body.data).toMatchObject({ isPresent: false, nextAllowedAction: 'check_in' });
    expect(segments).toEqual([
      expect.objectContaining({ statusCode: 'superseded', resultCode: 'valid', checkOutAt: null }),
      expect.objectContaining({
        statusCode: 'draft',
        resultCode: 'valid',
        serviceHours: expect.anything(),
      }),
    ]);
    expect(String(segments[1].serviceHours)).toBe('0.5');
    expect(evidence.evidenceRevision).toBe(2);
  });

  it('renders protected SVG and applies the frozen required-location policy without leaking coordinates', async () => {
    const scenario = await createScenario({
      locationRequired: true,
      longitude: 116.397128,
      latitude: 39.916527,
      radiusMeters: 100,
    });
    await submitApplicant(scenario);
    const issued = await issueCredential(
      scenario,
      'check-in',
      `batch5-location-issue-${++sequence}`,
    );
    const credentialId = issued.body.data.credentialId as string;
    const token = await tokenForCredential(credentialId);

    const rendered = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/qr-credentials/${credentialId}/render`,
      )
      .set('Authorization', managerAuth);
    expect(rendered.status).toBe(201);
    expect(rendered.headers['cache-control']).toBe('no-store');
    expect(rendered.headers['content-type']).toMatch(/^image\/svg\+xml/u);
    const renderedSvg = Buffer.isBuffer(rendered.body)
      ? rendered.body.toString('utf8')
      : (rendered.text ?? '');
    expect(renderedSvg).toContain('<svg');
    expect(renderedSvg).not.toContain(token);

    freezeSystemTime(new Date('2099-12-15T08:00:00.000Z'));
    const freshApplicantAuth = (await loginAs(app, applicantUsername)).authHeader;
    const absent = await request(httpServer(app))
      .post(selfPunchPath(scenario, 'check-in'))
      .set('Authorization', freshApplicantAuth)
      .send({ qrToken: token, eventKey: `batch5-location-absent-${++sequence}` });
    expectBizError(absent, BizCode.ATTENDANCE_PUNCH_LOCATION_REQUIRED);

    const outOfRange = await request(httpServer(app))
      .post(selfPunchPath(scenario, 'check-in'))
      .set('Authorization', freshApplicantAuth)
      .send({
        qrToken: token,
        eventKey: `batch5-location-out-of-range-${++sequence}`,
        longitude: 116.407128,
        latitude: 39.916527,
        accuracy: 1,
      });
    expectBizError(outOfRange, BizCode.ATTENDANCE_PUNCH_LOCATION_OUT_OF_RANGE);
    await expect(
      prisma.attendancePunchEvent.count({ where: { activityId: scenario.activityId } }),
    ).resolves.toBe(0);

    const accepted = await request(httpServer(app))
      .post(selfPunchPath(scenario, 'check-in'))
      .set('Authorization', freshApplicantAuth)
      .send({
        qrToken: token,
        eventKey: `batch5-location-exact-center-${++sequence}`,
        longitude: 116.397128,
        latitude: 39.916527,
        accuracy: 101,
      });
    expect(accepted.status).toBe(201);
    expect(accepted.body.data).toMatchObject({ geoVerified: true, lowAccuracy: true });
    expect(JSON.stringify(accepted.body.data)).not.toContain('longitude');
    expect(JSON.stringify(accepted.body.data)).not.toContain('latitude');
    await expect(
      prisma.attendancePunchEvent.findFirstOrThrow({
        where: { eventKey: `batch5-location-exact-center-${sequence}` },
        select: { geoVerified: true, lowAccuracy: true, longitude: true, latitude: true },
      }),
    ).resolves.toMatchObject({
      geoVerified: true,
      lowAccuracy: true,
      longitude: expect.anything(),
      latitude: expect.anything(),
    });
  });

  it('permits a 10-minute special close, then creates a second non-overlapping service segment', async () => {
    const scenario = await createScenario();
    await submitApplicant(scenario);
    const [checkInIssued, checkOutIssued] = await Promise.all([
      issueCredential(scenario, 'check-in', `batch5-reentry-in-issue-${++sequence}`),
      issueCredential(scenario, 'check-out', `batch5-reentry-out-issue-${++sequence}`),
    ]);
    const [checkInToken, checkOutToken] = await Promise.all([
      tokenForCredential(checkInIssued.body.data.credentialId as string),
      tokenForCredential(checkOutIssued.body.data.credentialId as string),
    ]);
    const identityId = await participationIdentityIdFor(scenario);

    freezeSystemTime(new Date('2099-12-15T08:00:00.000Z'));
    const firstCheckIn = await request(httpServer(app))
      .post(selfPunchPath(scenario, 'check-in'))
      .set('Authorization', (await loginAs(app, applicantUsername)).authHeader)
      .send({ qrToken: checkInToken, eventKey: `batch5-reentry-first-check-in-${++sequence}` });
    expect(firstCheckIn.status).toBe(201);

    freezeSystemTime(new Date('2099-12-15T08:10:00.000Z'));
    const earlyClose = await request(httpServer(app))
      .post(`${onsitePath(scenario)}/sessions/${scenario.sessionId}/early-departure-close`)
      .set('Authorization', (await loginAs(app, managerUsername)).authHeader)
      .send({
        participationIdentityId: identityId,
        reason: '十分钟现场特殊离场',
        eventKey: `batch5-reentry-early-close-${++sequence}`,
      });
    expect(earlyClose.status).toBe(201);
    expect(earlyClose.body.data).toMatchObject({
      eventTypeCode: 'early_departure_close',
      segmentStatusCode: 'closed_zero',
    });

    freezeSystemTime(new Date('2099-12-15T08:11:00.000Z'));
    const secondCheckIn = await request(httpServer(app))
      .post(selfPunchPath(scenario, 'check-in'))
      .set('Authorization', (await loginAs(app, applicantUsername)).authHeader)
      .send({ qrToken: checkInToken, eventKey: `batch5-reentry-second-check-in-${++sequence}` });
    expect(secondCheckIn.status).toBe(201);
    expect(secondCheckIn.body.data).toMatchObject({
      eventTypeCode: 'check_in',
      segmentStatusCode: 'open',
    });

    freezeSystemTime(new Date('2099-12-15T08:41:00.000Z'));
    const finalCheckOut = await request(httpServer(app))
      .post(selfPunchPath(scenario, 'check-out'))
      .set('Authorization', (await loginAs(app, applicantUsername)).authHeader)
      .send({ qrToken: checkOutToken, eventKey: `batch5-reentry-final-check-out-${++sequence}` });
    expect(finalCheckOut.status).toBe(201);

    const segments = await prisma.participantServiceSegmentRevision.findMany({
      where: { participationIdentityId: identityId, statusCode: { not: 'superseded' } },
      select: {
        segmentKey: true,
        resultCode: true,
        serviceHours: true,
        checkInAt: true,
        checkOutAt: true,
      },
      orderBy: { segmentKey: 'asc' },
    });
    expect(segments).toEqual([
      expect.objectContaining({ segmentKey: '0001', resultCode: 'early_departure_zero' }),
      expect.objectContaining({ segmentKey: '0002', resultCode: 'valid' }),
    ]);
    expect(String(segments[0]?.serviceHours)).toBe('0');
    expect(segments[0]?.checkOutAt?.getTime()).toBeGreaterThan(
      segments[0]?.checkInAt.getTime() ?? 0,
    );
    expect(segments[1]?.checkInAt.getTime()).toBeGreaterThanOrEqual(
      segments[0]?.checkOutAt?.getTime() ?? 0,
    );
  });

  it('AC-015 keeps normal checkout for 30 minutes after termination, then requires staff early-close', async () => {
    const withinWindow = await createScenario();
    await submitApplicant(withinWindow);
    const [withinCheckIn, withinCheckOut] = await Promise.all([
      issueCredential(withinWindow, 'check-in', `batch5-terminate-in-${++sequence}`),
      issueCredential(withinWindow, 'check-out', `batch5-terminate-out-${++sequence}`),
    ]);
    const [withinCheckInToken, withinCheckOutToken] = await Promise.all([
      tokenForCredential(withinCheckIn.body.data.credentialId as string),
      tokenForCredential(withinCheckOut.body.data.credentialId as string),
    ]);
    freezeSystemTime(new Date('2099-12-15T08:00:00.000Z'));
    await request(httpServer(app))
      .post(selfPunchPath(withinWindow, 'check-in'))
      .set('Authorization', (await loginAs(app, applicantUsername)).authHeader)
      .send({
        qrToken: withinCheckInToken,
        eventKey: `batch5-terminate-window-check-in-${++sequence}`,
      })
      .expect(201);
    const terminatedAt = new Date('2099-12-15T08:05:00.000Z');
    await prisma.activity.update({
      where: { id: withinWindow.activityId },
      data: {
        statusCode: 'terminated',
        terminatedAt,
        terminatedByUserId: managerUserId,
        terminationReason: '现场提前终止',
      },
    });
    await prisma.activitySession.update({
      where: { id: withinWindow.sessionId },
      data: { terminationCheckOutDeadline: new Date('2099-12-15T08:35:00.000Z') },
    });
    freezeSystemTime(new Date('2099-12-15T08:30:00.000Z'));
    const checkedOut = await request(httpServer(app))
      .post(selfPunchPath(withinWindow, 'check-out'))
      .set('Authorization', (await loginAs(app, applicantUsername)).authHeader)
      .send({
        qrToken: withinCheckOutToken,
        eventKey: `batch5-terminate-window-check-out-${++sequence}`,
      });
    expect(checkedOut.status).toBe(201);
    expect(checkedOut.body.data).toMatchObject({
      eventTypeCode: 'check_out',
      segmentStatusCode: 'closed_valid',
    });

    // 第一段把墙钟推进到 2099；先恢复真实时间再登录/报名第二个夹具，避免把测试 JWT
    // 自己判成过期。第二段业务时间仍在下方重新冻结，不改变任何验收断言。
    jest.useRealTimers();
    const expiredWindow = await createScenario();
    await submitApplicant(expiredWindow);
    const [expiredCheckIn, expiredCheckOut] = await Promise.all([
      issueCredential(expiredWindow, 'check-in', `batch5-terminate-expired-in-${++sequence}`),
      issueCredential(expiredWindow, 'check-out', `batch5-terminate-expired-out-${++sequence}`),
    ]);
    const [expiredCheckInToken, expiredCheckOutToken] = await Promise.all([
      tokenForCredential(expiredCheckIn.body.data.credentialId as string),
      tokenForCredential(expiredCheckOut.body.data.credentialId as string),
    ]);
    freezeSystemTime(new Date('2099-12-15T08:00:00.000Z'));
    await request(httpServer(app))
      .post(selfPunchPath(expiredWindow, 'check-in'))
      .set('Authorization', (await loginAs(app, applicantUsername)).authHeader)
      .send({
        qrToken: expiredCheckInToken,
        eventKey: `batch5-terminate-expired-check-in-${++sequence}`,
      })
      .expect(201);
    const expiredIdentityId = await participationIdentityIdFor(expiredWindow);
    await prisma.activity.update({
      where: { id: expiredWindow.activityId },
      data: {
        statusCode: 'terminated',
        terminatedAt,
        terminatedByUserId: managerUserId,
        terminationReason: '现场提前终止',
      },
    });
    await prisma.activitySession.update({
      where: { id: expiredWindow.sessionId },
      data: { terminationCheckOutDeadline: new Date('2099-12-15T08:20:00.000Z') },
    });
    freezeSystemTime(new Date('2099-12-15T08:21:00.000Z'));
    expectBizError(
      await request(httpServer(app))
        .post(selfPunchPath(expiredWindow, 'check-out'))
        .set('Authorization', (await loginAs(app, applicantUsername)).authHeader)
        .send({
          qrToken: expiredCheckOutToken,
          eventKey: `batch5-terminate-expired-self-out-${++sequence}`,
        }),
      BizCode.ATTENDANCE_PUNCH_OUTSIDE_WINDOW,
    );
    const staffClose = await request(httpServer(app))
      .post(
        `${onsitePath(expiredWindow)}/sessions/${expiredWindow.sessionId}/early-departure-close`,
      )
      .set('Authorization', (await loginAs(app, managerUsername)).authHeader)
      .send({
        participationIdentityId: expiredIdentityId,
        reason: '终止窗口结束后逐人清场',
        eventKey: `batch5-terminate-expired-staff-close-${++sequence}`,
      });
    expect(staffClose.status).toBe(201);
    expect(staffClose.body.data).toMatchObject({
      eventTypeCode: 'early_departure_close',
      segmentStatusCode: 'closed_zero',
    });
  });

  it('does not invent a checkout or service duration after the frozen checkout window has closed', async () => {
    const scenario = await createScenario();
    await submitApplicant(scenario);
    const issued = await issueCredential(
      scenario,
      'check-in',
      `batch5-open-segment-issue-${++sequence}`,
    );
    const token = await tokenForCredential(issued.body.data.credentialId as string);
    const identityId = await participationIdentityIdFor(scenario);

    freezeSystemTime(new Date('2099-12-15T08:00:00.000Z'));
    const checkIn = await request(httpServer(app))
      .post(selfPunchPath(scenario, 'check-in'))
      .set('Authorization', (await loginAs(app, applicantUsername)).authHeader)
      .send({ qrToken: token, eventKey: `batch5-open-segment-check-in-${++sequence}` });
    expect(checkIn.status).toBe(201);

    freezeSystemTime(new Date('2099-12-15T12:30:01.000Z'));
    const state = await request(httpServer(app))
      .get(
        `/api/app/v1/activities/${scenario.activityId}/sessions/${scenario.sessionId}/my-punch-state`,
      )
      .set('Authorization', (await loginAs(app, applicantUsername)).authHeader);
    expect(state.status).toBe(200);
    expect(state.body.data).toMatchObject({ isPresent: true, nextAllowedAction: 'check_out' });
    const segment = await prisma.participantServiceSegmentRevision.findFirstOrThrow({
      where: { participationIdentityId: identityId, statusCode: { not: 'superseded' } },
      select: { checkOutAt: true, serviceHours: true },
    });
    expect(segment).toEqual({ checkOutAt: null, serviceHours: null });
  });

  it('keeps the wrong check-in immutable after void and lets the corrected check-in become the active segment', async () => {
    const scenario = await createScenario();
    await submitApplicant(scenario);
    const issued = await issueCredential(
      scenario,
      'check-in',
      `batch5-void-in-issue-${++sequence}`,
    );
    const token = await tokenForCredential(issued.body.data.credentialId as string);
    const identityId = await participationIdentityIdFor(scenario);

    freezeSystemTime(new Date('2099-12-15T08:00:00.000Z'));
    const wrongCheckIn = await request(httpServer(app))
      .post(selfPunchPath(scenario, 'check-in'))
      .set('Authorization', (await loginAs(app, applicantUsername)).authHeader)
      .send({ qrToken: token, eventKey: `batch5-void-wrong-check-in-${++sequence}` });
    expect(wrongCheckIn.status).toBe(201);

    freezeSystemTime(new Date('2099-12-15T08:01:00.000Z'));
    const voided = await request(httpServer(app))
      .post(`${onsitePath(scenario)}/punch-events/${wrongCheckIn.body.data.eventId as string}/void`)
      .set('Authorization', (await loginAs(app, managerUsername)).authHeader)
      .send({ operationKey: `batch5-void-correction-${++sequence}`, reason: '误扫签到作废' });
    expect(voided.status).toBe(201);
    expect(voided.body.data).toMatchObject({ eventTypeCode: 'void' });

    freezeSystemTime(new Date('2099-12-15T08:02:00.000Z'));
    const correctedCheckIn = await request(httpServer(app))
      .post(selfPunchPath(scenario, 'check-in'))
      .set('Authorization', (await loginAs(app, applicantUsername)).authHeader)
      .send({ qrToken: token, eventKey: `batch5-void-corrected-check-in-${++sequence}` });
    expect(correctedCheckIn.status).toBe(201);

    const [events, currentSegment] = await Promise.all([
      prisma.attendancePunchEvent.findMany({
        where: { activityId: scenario.activityId },
        select: { id: true, eventTypeCode: true, supersedesEventId: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.participantServiceSegmentRevision.findFirstOrThrow({
        where: { participationIdentityId: identityId, statusCode: { not: 'superseded' } },
        select: { sourceCheckInEventId: true, checkOutAt: true },
      }),
    ]);
    expect(events.map((event) => event.eventTypeCode)).toEqual(['check_in', 'void', 'check_in']);
    expect(events[1]?.supersedesEventId).toBe(wrongCheckIn.body.data.eventId);
    expect(currentSegment).toEqual({
      sourceCheckInEventId: correctedCheckIn.body.data.eventId,
      checkOutAt: null,
    });
  });

  it('records managed early-close, void and replace as append-only corrections while allowing checkout after identity drift', async () => {
    const scenario = await createScenario();
    await submitApplicant(scenario);
    const [checkInIssued, checkOutIssued] = await Promise.all([
      issueCredential(scenario, 'check-in', `batch5-correction-in-issue-${++sequence}`),
      issueCredential(scenario, 'check-out', `batch5-correction-out-issue-${++sequence}`),
    ]);
    const [checkInToken, checkOutToken] = await Promise.all([
      tokenForCredential(checkInIssued.body.data.credentialId as string),
      tokenForCredential(checkOutIssued.body.data.credentialId as string),
    ]);
    const identityId = await participationIdentityIdFor(scenario);

    freezeSystemTime(new Date('2099-12-15T08:00:00.000Z'));
    const checkIn = await request(httpServer(app))
      .post(selfPunchPath(scenario, 'check-in'))
      .set('Authorization', (await loginAs(app, applicantUsername)).authHeader)
      .send({ qrToken: checkInToken, eventKey: `batch5-correction-check-in-${++sequence}` });
    expect(checkIn.status).toBe(201);

    // Downstream state can change after a valid check-in. The production checkout route must
    // still close the already-open segment; this fixture does not create the punch event itself.
    await prisma.activityParticipationIdentity.update({
      where: { id: identityId },
      data: { currentStatusCode: 'cancelled', populationIncluded: false },
    });

    freezeSystemTime(new Date('2099-12-15T08:10:00.000Z'));
    const earlyClosePayload = {
      participationIdentityId: identityId,
      reason: '需立即离场',
      eventKey: `batch5-correction-early-close-${++sequence}`,
    };
    const earlyClose = await request(httpServer(app))
      .post(`${onsitePath(scenario)}/sessions/${scenario.sessionId}/early-departure-close`)
      .set('Authorization', (await loginAs(app, managerUsername)).authHeader)
      .send(earlyClosePayload);
    expect(earlyClose.status).toBe(201);
    expect(earlyClose.body.data).toMatchObject({
      eventTypeCode: 'early_departure_close',
      segmentStatusCode: 'closed_zero',
    });

    const earlyCloseReplay = await request(httpServer(app))
      .post(`${onsitePath(scenario)}/sessions/${scenario.sessionId}/early-departure-close`)
      .set('Authorization', (await loginAs(app, managerUsername)).authHeader)
      .send(earlyClosePayload);
    expect(earlyCloseReplay.status).toBe(201);
    expect(earlyCloseReplay.body).toEqual(earlyClose.body);

    const earlyCloseConflict = await request(httpServer(app))
      .post(`${onsitePath(scenario)}/sessions/${scenario.sessionId}/early-departure-close`)
      .set('Authorization', (await loginAs(app, managerUsername)).authHeader)
      .send({ ...earlyClosePayload, reason: '改成另一条原因' });
    expectBizError(earlyCloseConflict, BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);

    freezeSystemTime(new Date('2099-12-15T08:06:00.000Z'));
    const voided = await request(httpServer(app))
      .post(`${onsitePath(scenario)}/punch-events/${earlyClose.body.data.eventId as string}/void`)
      .set('Authorization', (await loginAs(app, managerUsername)).authHeader)
      .send({ operationKey: `batch5-correction-void-${++sequence}`, reason: '原早退记录作废' });
    expect(voided.status).toBe(201);
    expect(voided.body.data).toMatchObject({ eventTypeCode: 'void', segmentStatusCode: 'open' });

    const voidAgain = await request(httpServer(app))
      .post(`${onsitePath(scenario)}/punch-events/${earlyClose.body.data.eventId as string}/void`)
      .set('Authorization', (await loginAs(app, managerUsername)).authHeader)
      .send({ operationKey: `batch5-correction-void-again-${++sequence}`, reason: '不得重复作废' });
    expectBizError(voidAgain, BizCode.ATTENDANCE_PUNCH_EVENT_ALREADY_VOIDED);

    freezeSystemTime(new Date('2099-12-15T08:30:00.000Z'));
    const checkOut = await request(httpServer(app))
      .post(selfPunchPath(scenario, 'check-out'))
      .set('Authorization', (await loginAs(app, applicantUsername)).authHeader)
      .send({ qrToken: checkOutToken, eventKey: `batch5-correction-check-out-${++sequence}` });
    expect(checkOut.status).toBe(201);
    expect(checkOut.body.data).toMatchObject({
      eventTypeCode: 'check_out',
      segmentStatusCode: 'closed_valid',
    });

    freezeSystemTime(new Date('2099-12-15T08:35:00.000Z'));
    const replaced = await request(httpServer(app))
      .post(`${onsitePath(scenario)}/punch-events/${checkOut.body.data.eventId as string}/replace`)
      .set('Authorization', (await loginAs(app, managerUsername)).authHeader)
      .send({
        operationKey: `batch5-correction-replace-${++sequence}`,
        reason: '以现场更正替代签退',
      });
    expect(replaced.status).toBe(201);
    expect(replaced.body.data).toMatchObject({
      eventTypeCode: 'replace',
      segmentStatusCode: 'closed_valid',
    });

    const [events, currentSegment, evidence] = await Promise.all([
      prisma.attendancePunchEvent.findMany({
        where: { activityId: scenario.activityId },
        select: { eventTypeCode: true, sourceCode: true, supersedesEventId: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.participantServiceSegmentRevision.findFirstOrThrow({
        where: { participationIdentityId: identityId, statusCode: { not: 'superseded' } },
        select: { sourceCloseEventId: true, resultCode: true, serviceHours: true },
      }),
      prisma.activityEvidenceState.findUniqueOrThrow({
        where: { activityId: scenario.activityId },
        select: { evidenceRevision: true },
      }),
    ]);
    expect(events.map((event) => event.eventTypeCode)).toEqual([
      'check_in',
      'early_departure_close',
      'void',
      'check_out',
      'replace',
    ]);
    expect(events.map((event) => event.sourceCode)).toEqual([
      'self_qr',
      'correction',
      'correction',
      'self_qr',
      'correction',
    ]);
    expect(currentSegment).toMatchObject({
      sourceCloseEventId: replaced.body.data.eventId,
      resultCode: 'valid',
      serviceHours: expect.anything(),
    });
    expect(evidence.evidenceRevision).toBe(5);
  });
});
