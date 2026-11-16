import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MemberStatus, Role } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ActivityWorkflowGate } from '../../src/common/activity-workflow/activity-workflow.gate';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import appConfig, { type AppConfig } from '../../src/config/app.config';
import type { JwtConfig } from '../../src/config/jwt.config';
import { PrismaService } from '../../src/database/prisma.service';
import { LedgerQueryService } from '../../src/modules/activities/ledger-query.service';
import { AttendancePunchCommandService } from '../../src/modules/attendances/attendance-punch-command.service';
import {
  digestAttendanceQrToken,
  signAttendanceQrToken,
} from '../../src/modules/attendances/attendance-qr-token';
import { computeContribution } from '../../src/modules/team-join/team-join-progress';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// Preserve the former GPS suite's admission, geometry, time, replay, race and
// privacy obligations on the existing native session protocol. Native contracts
// differ explicitly: signed QR + eventKey, session windows, 30-minute segments,
// immutable events and audited writes. Old 36-second/header/CAS semantics are
// not aliases. Rejected writes and self reads still have no derived effects.
const START = new Date('2020-03-01T01:00:00Z');
const time = (minutes: number) => new Date(START.getTime() + minutes * 60_000);
const LOCATION = { longitude: 114, latitude: 22, accuracy: 5.5 };
const RECEIPT_KEYS = [
  'eventId',
  'eventTypeCode',
  'occurredAt',
  'segmentStatusCode',
  'serverTime',
  'distanceMeters',
  'geoVerified',
  'lowAccuracy',
  'nextAllowedAction',
].sort();
const STATE_KEYS = [
  'isPresent',
  'checkInAt',
  'checkOutAllowedAt',
  'distanceMeters',
  'geoVerified',
  'lowAccuracy',
  'serverTime',
  'nextAllowedAction',
].sort();
type Action = 'check_in' | 'check_out';
interface Actor {
  memberId: string | null;
  userId: string;
  auth: string;
}
interface Scene {
  activityId: string;
  sessionId: string;
  registrationId: string;
  identityId: string;
  tokens: Record<Action, string>;
  credentials: Record<Action, string>;
}

function freeze(now: Date) {
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

describe('App native self punches — migrated GPS business acceptance', () => {
  let app: INestApplication;
  let appB: INestApplication;
  let db: PrismaService;
  let dbB: PrismaService;
  let organizationId: string;
  let main: Actor;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;

  async function actor(role: Role = Role.USER, linked = true): Promise<Actor> {
    const name = `gps-native-${++sequence}`;
    const user = await createTestUser(app, { username: name, role });
    const member = linked
      ? await db.member.create({
          data: {
            memberNo: name,
            ...memberIdentityData(name),
            status: MemberStatus.ACTIVE,
            gradeCode: 'level-2',
          },
        })
      : null;
    if (member) await db.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    return {
      userId: user.id,
      memberId: member?.id ?? null,
      auth: (await loginAs(app, name)).authHeader,
    };
  }
  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    appB = await createTestApp();
    db = app.get(PrismaService);
    dbB = appB.get(PrismaService);
    organizationId = (
      await db.organization.create({ data: { name: 'Native GPS', nodeTypeCode: 'team' } })
    ).id;
    main = await actor();
  });
  beforeEach(() => freeze(START));
  afterEach(() => jest.useRealTimers());
  afterAll(async () => {
    jest.useRealTimers();
    try {
      const results = await Promise.allSettled([app?.close(), appB?.close()]);
      expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    } finally {
      if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    }
  });

  async function addIdentity(input: Pick<Scene, 'activityId' | 'sessionId'>, memberId: string) {
    const registration = await db.activityRegistration.create({
      data: { activityId: input.activityId, memberId, statusCode: 'pass' },
    });
    const identity = await db.activityParticipationIdentity.create({
      data: {
        ...input,
        registrationId: registration.id,
        memberId,
        currentStatusCode: 'pass',
        populationIncluded: true,
      },
    });
    return { registrationId: registration.id, identityId: identity.id };
  }
  async function scene(subject = main): Promise<Scene> {
    const tag = `gps-native-scene-${++sequence}`;
    const activity = await db.activity.create({
      data: {
        title: tag,
        activityTypeCode: 'gps-native',
        organizationId,
        startAt: START,
        endAt: time(240),
        location: 'GPS',
        statusCode: 'published',
      },
    });
    const session = await db.activitySession.create({
      data: {
        activityId: activity.id,
        code: tag,
        name: tag,
        startAt: START,
        endAt: time(240),
        locationText: 'GPS',
        statusCode: 'scheduled',
        locationRequired: true,
        longitude: LOCATION.longitude,
        latitude: LOCATION.latitude,
        radiusMeters: 500,
        locationPolicySourceCode: 'session',
        accuracyWarningMeters: 100,
        checkInOpenAt: time(-30),
        checkInCloseAt: time(60),
        checkOutOpenAt: START,
        checkOutCloseAt: time(270),
      },
    });
    if (subject.memberId === null) throw new Error('Native punch scene needs a member');
    const anchor = { activityId: activity.id, sessionId: session.id };
    const identity = await addIdentity(anchor, subject.memberId);
    await db.activityEvidenceState.create({ data: { activityId: activity.id } });
    const tokens = {} as Record<Action, string>;
    const credentials = {} as Record<Action, string>;
    for (const actionCode of ['check_in', 'check_out'] as const) {
      const payload = {
        ...anchor,
        credentialId: randomUUID(),
        actionCode,
        credentialVersion: 1,
        // Broad fixture credential validity isolates session-window assertions.
        validFrom: time(-120),
        validUntil: time(480),
      };
      const secret = app.get(ConfigService).getOrThrow<JwtConfig>('jwt').secret;
      tokens[actionCode] = signAttendanceQrToken(payload, secret);
      credentials[actionCode] = payload.credentialId;
      await db.attendanceQrCredential.create({
        data: {
          id: payload.credentialId,
          ...anchor,
          actionCode,
          credentialVersion: 1,
          validFrom: payload.validFrom,
          validUntil: payload.validUntil,
          statusCode: 'active',
          tokenDigest: digestAttendanceQrToken(tokens[actionCode]),
          signingKeyVersion: 0,
          issuedByUserId: main.userId,
          issuedAt: time(-120),
        },
      });
    }
    return { ...anchor, ...identity, tokens, credentials };
  }
  const path = (input: Pick<Scene, 'activityId' | 'sessionId'>, action: Action) =>
    `/api/app/v1/activities/${input.activityId}/sessions/${input.sessionId}/punches/${action === 'check_in' ? 'check-in' : 'check-out'}`;
  const statePath = (input: Pick<Scene, 'activityId' | 'sessionId'>) =>
    `/api/app/v1/activities/${input.activityId}/sessions/${input.sessionId}/my-punch-state`;
  const body = (input: Scene, action: Action, overrides: Record<string, unknown> = {}) => ({
    ...LOCATION,
    qrToken: input.tokens[action],
    eventKey: `${input.activityId}:${action}`,
    ...overrides,
  });
  const punch = (
    input: Scene,
    action: Action = 'check_in',
    overrides: Record<string, unknown> = {},
    auth = main.auth,
    server = app,
  ) =>
    request(httpServer(server))
      .post(path(input, action))
      .set('Authorization', auth)
      .send(body(input, action, overrides));
  const state = (input: Scene, auth = main.auth) =>
    request(httpServer(app)).get(statePath(input)).set('Authorization', auth);
  async function footprint(input: Scene) {
    return {
      events: await db.attendancePunchEvent.findMany({
        where: { activityId: input.activityId },
        orderBy: { id: 'asc' },
      }),
      segments: await db.participantServiceSegmentRevision.findMany({
        where: { identity: { activityId: input.activityId } },
        orderBy: { id: 'asc' },
      }),
      evidence: await db.activityEvidenceState.findUnique({
        where: { activityId: input.activityId },
      }),
      audit: await db.auditLog.findMany({
        where: { resourceId: input.activityId },
        orderBy: { id: 'asc' },
      }),
      ledger: await db.participationLedgerEntry.count({ where: { activityId: input.activityId } }),
      sheets: await db.attendanceSheet.count({ where: { activityId: input.activityId } }),
      oldGps: await db.activityCheckIn.count({ where: { activityId: input.activityId } }),
      intents: await db.notificationOutboxIntent.count(),
    };
  }
  async function position(input: Scene, from: number, until: number) {
    const slot = await db.activitySessionPosition.create({
      data: {
        activityId: input.activityId,
        sessionId: input.sessionId,
        code: `gps-slot-${++sequence}`,
        name: `GPS slot ${sequence}`,
        attendanceRoleCode: 'member',
        startAt: time(from),
        endAt: time(until),
      },
    });
    await db.activityParticipationIdentity.update({
      where: { id: input.identityId },
      data: { currentPositionId: slot.id },
    });
    return slot;
  }
  async function rejectUnchanged(
    input: Scene,
    operation: PromiseLike<request.Response>,
    biz: (typeof BizCode)[keyof typeof BizCode],
  ) {
    const before = await footprint(input);
    expectBizError(await operation, biz, { strictMessage: false });
    expect(await footprint(input)).toEqual(before);
  }
  function safeReceipt(response: request.Response) {
    expect(response.status).toBe(201);
    expect(response.body.code).toBe(0);
    expect(Object.keys(response.body.data as Record<string, unknown>).sort()).toEqual(RECEIPT_KEYS);
    return response.body.data as Record<string, unknown>;
  }

  it.each(['check_in', 'check_out', 'state'] as const)(
    '%s requires login before business lookup',
    async (action) => {
      const input = { activityId: 'cmissingactivity0000', sessionId: 'cmissingsession0000' };
      const response =
        action === 'state'
          ? await request(httpServer(app)).get(statePath(input))
          : await request(httpServer(app)).post(path(input, action)).send({});
      expectBizError(response, BizCode.UNAUTHORIZED);
    },
  );

  it('unlinked/inactive/deleted members fail D5; a linked ADMIN can only punch for their own identity', async () => {
    const input = await scene();
    const unlinked = await actor(Role.USER, false);
    await rejectUnchanged(input, punch(input, 'check_in', {}, unlinked.auth), BizCode.FORBIDDEN);
    for (const change of [{ status: MemberStatus.INACTIVE }, { deletedAt: START }]) {
      const subject = await actor();
      await db.member.update({ where: { id: subject.memberId! }, data: change });
      await rejectUnchanged(input, punch(input, 'check_in', {}, subject.auth), BizCode.FORBIDDEN);
      await rejectUnchanged(input, state(input, subject.auth), BizCode.FORBIDDEN);
    }
    const admin = await actor(Role.ADMIN);
    await rejectUnchanged(
      input,
      punch(input, 'check_in', {}, admin.auth),
      BizCode.ATTENDANCE_REGISTRATION_INVALID,
    );
    const own = await scene(admin);
    const receipt = safeReceipt(await punch(own, 'check_in', {}, admin.auth));
    expect(
      (
        await db.attendancePunchEvent.findUniqueOrThrow({
          where: { id: receipt.eventId as string },
        })
      ).memberId,
    ).toBe(admin.memberId);
  });

  it.each([
    ['longitude range', { longitude: 180.1 }],
    ['latitude precision', { latitude: 22.12345678 }],
    ['negative accuracy', { accuracy: -0.01 }],
    ['accuracy precision', { accuracy: 1.234 }],
    ['accuracy range', { accuracy: 100_000_000 }],
    ['member override', { memberId: 'other' }],
    ['missing QR', { qrToken: undefined }],
    ['missing key', { eventKey: undefined }],
    ['null coordinate', { longitude: null }],
  ])('%s fails strict DTO validation without writes', async (_label, overrides) => {
    const input = await scene();
    await rejectUnchanged(input, punch(input, 'check_in', overrides), BizCode.BAD_REQUEST);
  });

  it('closed coordinate bounds and maximum accuracy are accepted without shrinking the radius', async () => {
    const input = await scene();
    await db.activitySession.update({
      where: { id: input.sessionId },
      data: { longitude: 180, latitude: -90 },
    });
    const result = safeReceipt(
      await punch(input, 'check_in', { longitude: 180, latitude: -90, accuracy: 99_999_999.99 }),
    );
    expect(result).toMatchObject({ distanceMeters: '0.00', geoVerified: true, lowAccuracy: true });
    expectBizError(
      await request(httpServer(app))
        .post(path({ ...input, activityId: 'short' }, 'check_in'))
        .set('Authorization', main.auth)
        .send(body(input, 'check_in')),
      BizCode.BAD_REQUEST,
      { strictMessage: false },
    );
  });

  it.each(['pending', 'waitlisted', 'rejected', 'cancelled'])(
    '%s native identity cannot start a segment',
    async (currentStatusCode) => {
      const input = await scene();
      await db.activityParticipationIdentity.update({
        where: { id: input.identityId },
        data: { currentStatusCode, populationIncluded: false },
      });
      await rejectUnchanged(input, punch(input), BizCode.ATTENDANCE_REGISTRATION_INVALID);
    },
  );

  it('missing native identity stays generic; a deleted activity cannot accept new facts', async () => {
    const input = await scene();
    const other = await actor();
    await rejectUnchanged(
      input,
      punch(input, 'check_in', {}, other.auth),
      BizCode.ATTENDANCE_REGISTRATION_INVALID,
    );
    await rejectUnchanged(input, state(input, other.auth), BizCode.ATTENDANCE_REGISTRATION_INVALID);
    await db.activity.update({ where: { id: input.activityId }, data: { deletedAt: START } });
    await rejectUnchanged(input, punch(input), BizCode.ACTIVITY_NOT_FOUND);
  });

  it('legacy GPS history cannot stand in for a native participation identity or an open segment', async () => {
    const input = await scene();
    await db.activityCheckIn.create({
      data: {
        activityId: input.activityId,
        registrationId: input.registrationId,
        memberId: main.memberId!,
        checkInAt: time(-60),
        geoVerified: true,
        outOfRange: false,
      },
    });
    await rejectUnchanged(
      input,
      punch(input, 'check_out'),
      BizCode.ATTENDANCE_PUNCH_CHECK_OUT_REQUIRES_OPEN_SEGMENT,
    );
    const before = await footprint(input);
    const read = await state(input);
    expect(read.status).toBe(200);
    expect(read.body.data.isPresent).toBe(false);
    expect(await footprint(input)).toEqual(before);
    safeReceipt(await punch(input));
    expect(await db.activityCheckIn.count({ where: { activityId: input.activityId } })).toBe(1);
  });

  it.each(['draft', 'completed', 'cancelled', 'terminated'])(
    '%s activity rejects a first check-in without side effects',
    async (statusCode) => {
      const input = await scene();
      await db.activity.update({ where: { id: input.activityId }, data: { statusCode } });
      await rejectUnchanged(input, punch(input), BizCode.ACTIVITY_STATUS_INVALID);
    },
  );

  it('closed activity status is checked before replay; the historical event cannot be overwritten', async () => {
    const input = await scene();
    safeReceipt(await punch(input));
    await db.activity.update({
      where: { id: input.activityId },
      data: { statusCode: 'completed' },
    });
    await rejectUnchanged(input, punch(input), BizCode.ACTIVITY_STATUS_INVALID);
  });

  it('published check-in can finish after termination within its explicit checkout deadline', async () => {
    const input = await scene();
    safeReceipt(await punch(input));
    await db.activity.update({
      where: { id: input.activityId },
      data: { statusCode: 'terminated' },
    });
    await db.activitySession.update({
      where: { id: input.sessionId },
      data: { terminationCheckOutDeadline: time(60) },
    });
    freeze(time(30));
    expect(safeReceipt(await punch(input, 'check_out')).segmentStatusCode).toBe('closed_valid');
  });

  it('self punches intersect the session window with the assigned position interval, including exact boundaries', async () => {
    const input = await scene();
    await position(input, 20, 90);
    await rejectUnchanged(input, punch(input), BizCode.ATTENDANCE_PUNCH_OUTSIDE_WINDOW);
    freeze(time(20));
    const first = safeReceipt(await punch(input));
    freeze(new Date(time(90).getTime() + 1));
    await rejectUnchanged(
      input,
      punch(input, 'check_out'),
      BizCode.ATTENDANCE_PUNCH_OUTSIDE_WINDOW,
    );
    const beforeReplay = await footprint(input);
    expect(safeReceipt(await punch(input))).toEqual(first);
    expect(await footprint(input)).toEqual(beforeReplay);
    freeze(time(90));
    expect(safeReceipt(await punch(input, 'check_out')).segmentStatusCode).toBe('closed_valid');
  });

  it('managed proxy punches enforce the same position intersection before any event, projection or audit write', async () => {
    const input = await scene();
    const slot = await position(input, 20, 90);
    await db.activityResponsibilityAssignment.create({
      data: {
        activityId: input.activityId,
        memberId: main.memberId!,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: main.userId,
        source: 'publish',
      },
    });
    const currentUser = await db.user.findUniqueOrThrow({
      where: { id: main.userId },
      select: { id: true, username: true, memberId: true, role: true, status: true },
    });
    const command = {
      activityId: input.activityId,
      sessionId: input.sessionId,
      participationIdentityId: input.identityId,
      memberCredential: null,
      actionCode: 'check_in' as const,
      sourceCode: 'proxy' as const,
      eventKey: `${input.activityId}:proxy`,
      reason: '岗位窗口验收',
      deviceId: null,
      ...LOCATION,
      currentUser,
      auditMeta: { requestId: 'native-position-window', ip: null, ua: null },
    };
    const service = app.get(AttendancePunchCommandService);
    const before = await footprint(input);
    await expect(service.managedPunch(command)).rejects.toMatchObject({
      biz: BizCode.ATTENDANCE_PUNCH_OUTSIDE_WINDOW,
    });
    expect(await footprint(input)).toEqual(before);
    freeze(time(20));
    const receipt = await service.managedPunch(command);
    expect(
      (await db.attendancePunchEvent.findUniqueOrThrow({ where: { id: receipt.eventId } }))
        .positionId,
    ).toBe(slot.id);
  });

  it('checkout uses the position captured by the open check-in, not a later identity assignment', async () => {
    const input = await scene();
    const original = await position(input, 20, 90);
    freeze(time(20));
    safeReceipt(await punch(input));
    await position(input, 120, 240);
    freeze(time(70));
    const receipt = safeReceipt(await punch(input, 'check_out'));
    expect(
      (
        await db.attendancePunchEvent.findUniqueOrThrow({
          where: { id: receipt.eventId as string },
        })
      ).positionId,
    ).toBe(original.id);
  });

  it('the explicit termination checkout deadline preserves closure even after the ordinary position end', async () => {
    const input = await scene();
    await position(input, 20, 60);
    freeze(time(20));
    safeReceipt(await punch(input));
    await db.activity.update({
      where: { id: input.activityId },
      data: { statusCode: 'terminated' },
    });
    await db.activitySession.update({
      where: { id: input.sessionId },
      data: { terminationCheckOutDeadline: time(80) },
    });
    freeze(time(70));
    expect(safeReceipt(await punch(input, 'check_out')).segmentStatusCode).toBe('closed_valid');
  });

  it.each([
    { label: 'before open', now: new Date(time(-30).getTime() - 1), accepted: false },
    { label: 'at open', now: time(-30), accepted: true },
    { label: 'at close', now: time(60), accepted: true },
    { label: 'after close', now: new Date(time(60).getTime() + 1), accepted: false },
  ])(
    'check-in $label uses the server clock and exact session boundary',
    async ({ now, accepted }) => {
      const input = await scene();
      freeze(now);
      if (accepted) expect(safeReceipt(await punch(input)).occurredAt).toBe(now.toISOString());
      else await rejectUnchanged(input, punch(input), BizCode.ATTENDANCE_PUNCH_OUTSIDE_WINDOW);
    },
  );

  it('checkout enforces its own window independently of an already-sufficient duration', async () => {
    const input = await scene();
    safeReceipt(await punch(input));
    await db.activitySession.update({
      where: { id: input.sessionId },
      data: { checkOutOpenAt: time(60), checkOutCloseAt: time(120) },
    });
    freeze(new Date(time(60).getTime() - 1));
    await rejectUnchanged(
      input,
      punch(input, 'check_out'),
      BizCode.ATTENDANCE_PUNCH_OUTSIDE_WINDOW,
    );
    freeze(new Date(time(120).getTime() + 1));
    await rejectUnchanged(
      input,
      punch(input, 'check_out'),
      BizCode.ATTENDANCE_PUNCH_OUTSIDE_WINDOW,
    );
    freeze(time(120));
    expect(safeReceipt(await punch(input, 'check_out')).occurredAt).toBe(time(120).toISOString());
  });

  it('29:59.999 rejects; exactly 30:00 closes a valid segment without altering the original check-in', async () => {
    const input = await scene();
    const first = safeReceipt(await punch(input));
    const stored = await db.attendancePunchEvent.findUniqueOrThrow({
      where: { id: first.eventId as string },
    });
    freeze(new Date(time(30).getTime() - 1));
    await rejectUnchanged(
      input,
      punch(input, 'check_out'),
      BizCode.ATTENDANCE_PUNCH_MIN_DURATION_NOT_REACHED,
    );
    freeze(time(30));
    expect(safeReceipt(await punch(input, 'check_out')).segmentStatusCode).toBe('closed_valid');
    expect(await db.attendancePunchEvent.findUniqueOrThrow({ where: { id: stored.id } })).toEqual(
      stored,
    );
  });

  it('exact replay outside the window returns the first immutable receipt with no new audit/evidence', async () => {
    const input = await scene();
    const first = safeReceipt(await punch(input));
    freeze(time(30));
    const last = safeReceipt(await punch(input, 'check_out'));
    const before = await footprint(input);
    freeze(time(300));
    expect(safeReceipt(await punch(input))).toEqual(first);
    expect(safeReceipt(await punch(input, 'check_out'))).toEqual(last);
    expect(await footprint(input)).toEqual(before);
  });

  it.each([
    { longitude: undefined, latitude: undefined },
    { longitude: undefined },
    { latitude: undefined },
  ])(
    'required location rejects incomplete coordinates %# without derived writes',
    async (overrides) => {
      const input = await scene();
      await rejectUnchanged(
        input,
        punch(input, 'check_in', overrides),
        BizCode.ATTENDANCE_PUNCH_LOCATION_REQUIRED,
      );
    },
  );

  it('Haversine accepts same-point/just-inside and rejects even a sub-rounding distance beyond 500m', async () => {
    const same = await scene();
    expect(safeReceipt(await punch(same)).distanceMeters).toBe('0.00');
    const inside = await scene();
    const accepted = safeReceipt(
      await punch(inside, 'check_in', { latitude: 22.0044966, accuracy: 99_999_999.99 }),
    );
    expect(Number(accepted.distanceMeters)).toBeLessThanOrEqual(500);
    const outside = await scene();
    // Valid seven-decimal coordinates; raw distance is just above 500m even
    // though a rounded storage/display value could read 500.
    await rejectUnchanged(
      outside,
      punch(outside, 'check_in', { longitude: 114.00001, latitude: 22.0044966, accuracy: 0 }),
      BizCode.ATTENDANCE_PUNCH_LOCATION_OUT_OF_RANGE,
    );
    await rejectUnchanged(
      outside,
      punch(outside, 'check_in', { latitude: 22.0044967, accuracy: 99_999_999.99 }),
      BizCode.ATTENDANCE_PUNCH_LOCATION_OUT_OF_RANGE,
    );
  });

  it.each([
    { data: { longitude: null }, constraint: 'activity_session_coordinate_pair_check' },
    { data: { latitude: null }, constraint: 'activity_session_coordinate_pair_check' },
    { data: { radiusMeters: null }, constraint: 'activity_session_location_policy_check' },
  ])(
    'incomplete required session configuration %# is rejected by PostgreSQL before it can affect punches',
    async ({ data, constraint }) => {
      const input = await scene();
      const original = await db.activitySession.findUniqueOrThrow({
        where: { id: input.sessionId },
      });
      const before = await footprint(input);
      await expect(
        db.activitySession.update({ where: { id: input.sessionId }, data }),
      ).rejects.toThrow(new RegExp(`23514.*violates check constraint.*${constraint}`));
      expect(
        await db.activitySession.findUniqueOrThrow({ where: { id: input.sessionId } }),
      ).toEqual(original);
      expect(await footprint(input)).toEqual(before);
    },
  );
  it('out-of-range session coordinates are rejected by the runtime policy without derived facts', async () => {
    const input = await scene();
    await db.activitySession.update({ where: { id: input.sessionId }, data: { longitude: 181 } });
    await rejectUnchanged(input, punch(input), BizCode.ATTENDANCE_PUNCH_LOCATION_OUT_OF_RANGE);
  });

  it('neither a rejected location nor an accepted punch supplies formal contribution credit', async () => {
    const input = await scene();
    await rejectUnchanged(
      input,
      punch(input, 'check_in', { longitude: 115 }),
      BizCode.ATTENDANCE_PUNCH_LOCATION_OUT_OF_RANGE,
    );
    safeReceipt(await punch(input));
    expect(
      await db.participationLedgerEntry.count({ where: { activityId: input.activityId } }),
    ).toBe(0);
    const contribution = await computeContribution(
      db,
      main.memberId!,
      2020,
      app.get(ActivityWorkflowGate),
      LedgerQueryService,
    );
    expect(contribution.points.toNumber()).toBe(0);
    expect(contribution.satisfied).toBe(false);
  });

  it('changed payload under a successful key is rejected, while a new key cannot duplicate an open check-in', async () => {
    const input = await scene();
    const first = safeReceipt(await punch(input));
    const before = await footprint(input);
    await rejectUnchanged(
      input,
      punch(input, 'check_in', { longitude: 115 }),
      BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT,
    );
    await rejectUnchanged(
      input,
      punch(input, 'check_in', { eventKey: `${input.activityId}:another` }),
      BizCode.ATTENDANCE_PUNCH_OPEN_SEGMENT_EXISTS,
    );
    expect(safeReceipt(await punch(input))).toEqual(first);
    expect(await footprint(input)).toEqual(before);
  });

  it('eight concurrent check-ins share one event, one segment and one audit', async () => {
    const input = await scene();
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        punch(input, 'check_in', {}, main.auth, i % 2 ? appB : app),
      ),
    );
    const receipts = responses.map(safeReceipt);
    expect(new Set(receipts.map((row) => row.eventId)).size).toBe(1);
    expect(await db.attendancePunchEvent.count({ where: { activityId: input.activityId } })).toBe(
      1,
    );
    expect(
      await db.participantServiceSegmentRevision.count({
        where: { participationIdentityId: input.identityId },
      }),
    ).toBe(1);
    expect(await db.auditLog.count({ where: { resourceId: input.activityId } })).toBe(1);
    expect(
      (
        await db.activityEvidenceState.findUniqueOrThrow({
          where: { activityId: input.activityId },
        })
      ).evidenceRevision,
    ).toBe(1);
  });

  async function waiter(
    blockerPid: number,
    pending: Promise<unknown>,
    table: string,
  ): Promise<number> {
    let finished = false;
    void pending.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    const deadline = performance.now() + 1_200;
    while (performance.now() < deadline) {
      if (finished) throw new Error('HTTP mutation finished before required database wait');
      const rows = await dbB.$queryRaw<Array<{ pid: number }>>`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND CAST(${blockerPid} AS integer) = ANY(pg_blocking_pids(pid))
          AND query LIKE ${`%FROM "${table}"%FOR UPDATE%`}
      `;
      if (rows[0]) return rows[0].pid;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`No native ${table} waiter observed`);
  }
  it('an illegal location holding Activity first cannot win the key against a valid queued request', async () => {
    const input = await scene();
    let release!: () => void;
    let acquired!: (pid: number) => void;
    let failed!: (error: unknown) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<number>((resolve, reject) => {
      acquired = resolve;
      failed = reject;
    });
    const blocker = dbB.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "AttendanceQrCredential" WHERE id = ${input.credentials.check_in} FOR UPDATE`;
        const [row] = await tx.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid()::int AS pid`;
        acquired(row.pid);
        await gate;
      },
      { timeout: 20_000 },
    );
    void blocker.catch(failed);
    const pending: Promise<request.Response>[] = [];
    try {
      const pid = await reached;
      const invalid = Promise.resolve(punch(input, 'check_in', { longitude: 115 }));
      pending.push(invalid);
      const invalidPid = await waiter(pid, invalid, 'AttendanceQrCredential');
      const valid = Promise.resolve(punch(input, 'check_in', {}, main.auth, appB));
      pending.push(valid);
      await waiter(invalidPid, valid, 'Activity');
      release();
      await blocker;
      expectBizError(await invalid, BizCode.ATTENDANCE_PUNCH_LOCATION_OUT_OF_RANGE);
      const receipt = safeReceipt(await valid);
      const rows = await db.attendancePunchEvent.findMany({
        where: { activityId: input.activityId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(receipt.eventId);
      expect(Number(rows[0].longitude)).toBe(LOCATION.longitude);
      expect(rows[0]).toMatchObject({ geoVerified: true, outOfRange: false });
      expect(await db.auditLog.count({ where: { resourceId: input.activityId } })).toBe(1);
    } finally {
      release();
      await Promise.allSettled([blocker, ...pending]);
    }
  }, 60_000);

  it('eight concurrent checkouts append one checkout and preserve the original check-in', async () => {
    const input = await scene();
    const first = safeReceipt(await punch(input));
    freeze(time(30));
    const receipts = (
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          punch(input, 'check_out', {}, main.auth, i % 2 ? appB : app),
        ),
      )
    ).map(safeReceipt);
    expect(new Set(receipts.map((row) => row.eventId)).size).toBe(1);
    expect(await db.attendancePunchEvent.count({ where: { activityId: input.activityId } })).toBe(
      2,
    );
    expect(
      await db.attendancePunchEvent.count({
        where: { id: first.eventId as string, eventTypeCode: 'check_in' },
      }),
    ).toBe(1);
    expect(await db.auditLog.count({ where: { resourceId: input.activityId } })).toBe(2);
    expect((await state(input)).body.data.isPresent).toBe(false);
  });

  it('self state is read-only and isolated across members and activities, including no-fact states', async () => {
    const input = await scene();
    safeReceipt(await punch(input));
    const other = await actor();
    await addIdentity(
      { activityId: input.activityId, sessionId: input.sessionId },
      other.memberId!,
    );
    const anotherActivity = await scene();
    const before = await footprint(input);
    const own = await state(input);
    expect(own.status).toBe(200);
    expect(Object.keys(own.body.data as Record<string, unknown>).sort()).toEqual(STATE_KEYS);
    expect(own.body.data).toMatchObject({
      isPresent: true,
      checkInAt: START.toISOString(),
      checkOutAllowedAt: time(30).toISOString(),
    });
    expect((await state(input, other.auth)).body.data).toMatchObject({
      isPresent: false,
      checkInAt: null,
    });
    expect((await state(anotherActivity)).body.data.isPresent).toBe(false);
    expect(await footprint(input)).toEqual(before);
    // This endpoint declares no query DTO: an ignored query parameter cannot
    // replace the member resolved from the authenticated principal.
    const attemptedOverride = await request(httpServer(app))
      .get(statePath(input))
      .query({ memberId: other.memberId })
      .set('Authorization', main.auth);
    expect(attemptedOverride.status).toBe(200);
    expect(attemptedOverride.body.data).toEqual(own.body.data);
    expect(await footprint(input)).toEqual(before);
  });

  it.each(['draft', 'published', 'completed', 'cancelled'])(
    'historical self state on %s is safe and read-only, not a write permission',
    async (statusCode) => {
      const input = await scene();
      safeReceipt(await punch(input));
      await db.activity.update({ where: { id: input.activityId }, data: { statusCode } });
      const before = await footprint(input);
      const read = await state(input);
      expect(read.status).toBe(200);
      expect(read.body.data.isPresent).toBe(true);
      expect(Object.keys(read.body.data as Record<string, unknown>).sort()).toEqual(STATE_KEYS);
      expect(await footprint(input)).toEqual(before);
    },
  );

  it('checkout without native check-in fails; accepted events audit safe anchors and keep raw GPS only in storage', async () => {
    const input = await scene();
    await rejectUnchanged(
      input,
      punch(input, 'check_out'),
      BizCode.ATTENDANCE_PUNCH_CHECK_OUT_REQUIRES_OPEN_SEGMENT,
    );
    const first = safeReceipt(
      await punch(input, 'check_in', {
        longitude: 114.0012345,
        latitude: 22.0012345,
        accuracy: 12.34,
      }),
    );
    freeze(time(30));
    const last = safeReceipt(
      await punch(input, 'check_out', {
        longitude: 113.9988889,
        latitude: 21.9997778,
        accuracy: 56.78,
      }),
    );
    const stored = await db.attendancePunchEvent.findMany({
      where: { id: { in: [first.eventId as string, last.eventId as string] } },
      orderBy: { occurredAt: 'asc' },
    });
    expect(
      stored.map((row) => [Number(row.longitude), Number(row.latitude), Number(row.accuracy)]),
    ).toEqual([
      [114.0012345, 22.0012345, 12.34],
      [113.9988889, 21.9997778, 56.78],
    ]);
    const audits = await db.auditLog.findMany({ where: { resourceId: input.activityId } });
    expect(audits).toHaveLength(2);
    for (const audit of audits) {
      const extra = (audit.context as { extra: Record<string, unknown> }).extra;
      expect(extra).toMatchObject({
        operation: 'attendance-punch.create',
        sourceCode: 'self_qr',
      });
      expect(Object.keys(extra).sort()).toEqual(
        [
          'operation',
          'sessionId',
          'participationIdentityId',
          'eventId',
          'eventTypeCode',
          'sourceCode',
          'evidenceRevision',
          'supersedesEventId',
        ].sort(),
      );
    }
    expect(await db.activityCheckIn.count({ where: { activityId: input.activityId } })).toBe(0);
    expect(await db.attendanceRecord.count()).toBe(0);
    expect(await db.participationLedgerEntry.count()).toBe(0);
  });

  it('the disabled workflow rejects a valid native write without facts, revisions, audit or notifications', async () => {
    const input = await scene();
    // Exercise the actual gate against this application's injected config.
    // Changing process.env after boot does not change the existing instance.
    const config = app.get<AppConfig>(appConfig.KEY);
    const enabled = config.activityV11Workflow.enabled;
    config.activityV11Workflow.enabled = false;
    try {
      await rejectUnchanged(input, punch(input), BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED);
    } finally {
      config.activityV11Workflow.enabled = enabled;
    }
  });
});
