import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service';
import { ParticipationSegmentFacade } from '../../src/modules/attendances/participation-segment.facade';
import { createTestUser } from '../fixtures/users.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { loadTestEnv } from '../setup/load-env';
import { resetDb } from '../setup/reset-db';
import {
  assertConnectedTestDatabase,
  assertTestDatabaseUrl,
  dropWorkerDatabase,
  recreateWorkerDatabase,
} from '../setup/test-db';

const WORKER = 98;
const USE_DEDICATED_W98 = process.env.SRVF_D2_W98 === '1';
const SESSION_START = new Date('2099-01-01T01:00:00.000Z');
const SESSION_END = new Date('2099-01-01T05:00:00.000Z');

interface ActivityFixture {
  activityId: string;
  sessionId: string;
  historicPositionId: string;
  currentPositionId: string;
}

interface ParticipationFixture extends ActivityFixture {
  identityId: string;
  memberId: string;
  registrationId: string;
}

describe('D2 participation segment facade', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let facade: ParticipationSegmentFacade;
  let actorUserId: string;
  let organizationId: string;
  let sequence = 0;
  const originalEnvironment = {
    worker: process.env.JEST_WORKER_ID,
    databaseUrl: process.env.DATABASE_URL,
    storageRoot: process.env.STORAGE_LOCAL_ROOT,
  };

  const key = (label: string) => `d2-participation-${++sequence}-${label}`;

  beforeAll(async () => {
    // Direct local validation gets the maintenance-approved w98 clone. Normal
    // CI must use its already assigned worker: this shard includes legacy
    // migration replays that own w98 and rebuild it independently.
    if (USE_DEDICATED_W98) {
      process.env.JEST_WORKER_ID = String(WORKER);
      loadTestEnv();
      process.env.STORAGE_LOCAL_ROOT = `./tmp/storage-w${WORKER}`;
      assertTestDatabaseUrl(process.env.DATABASE_URL);
      recreateWorkerDatabase(WORKER);
    }
    assertTestDatabaseUrl(process.env.DATABASE_URL);

    const { createTestApp } = await import('../setup/test-app');
    app = await createTestApp();
    prisma = app.get(PrismaService);
    facade = app.get(ParticipationSegmentFacade);
    await assertConnectedTestDatabase(prisma);
  }, 120000);

  beforeEach(async () => {
    await resetDb(app);
    sequence = 0;
    actorUserId = (await createTestUser(app, { username: key('operator') })).id;
    organizationId = (
      await prisma.organization.create({
        data: { name: key('organization'), nodeTypeCode: 'team' },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (USE_DEDICATED_W98) {
        try {
          dropWorkerDatabase(WORKER);
        } finally {
          restoreEnvironment('JEST_WORKER_ID', originalEnvironment.worker);
          restoreEnvironment('DATABASE_URL', originalEnvironment.databaseUrl);
          restoreEnvironment('STORAGE_LOCAL_ROOT', originalEnvironment.storageRoot);
        }
      }
    }
  }, 120000);

  function restoreEnvironment(name: string, value: string | undefined) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  async function createActivity(label: string): Promise<ActivityFixture> {
    const activity = await prisma.activity.create({
      data: {
        title: key(`${label}-activity`),
        activityTypeCode: 'd2-participation-test',
        organizationId,
        startAt: SESSION_START,
        endAt: SESSION_END,
        location: '测试场地',
        statusCode: 'draft',
      },
      select: { id: true },
    });
    const session = await prisma.activitySession.create({
      data: {
        activityId: activity.id,
        code: key(`${label}-session`),
        name: key(`${label}-session-name`),
        startAt: SESSION_START,
        endAt: SESSION_END,
        locationText: '测试场地',
        checkInOpenAt: new Date(SESSION_START.getTime() - 60 * 60 * 1000),
        checkInCloseAt: new Date(SESSION_START.getTime() + 60 * 60 * 1000),
        checkOutOpenAt: SESSION_START,
        checkOutCloseAt: new Date(SESSION_END.getTime() + 60 * 60 * 1000),
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });
    const historicPosition = await prisma.activitySessionPosition.create({
      data: {
        activityId: activity.id,
        sessionId: session.id,
        code: key(`${label}-historic-position`),
        name: '历史签到岗位',
        attendanceRoleCode: 'member',
      },
      select: { id: true },
    });
    const currentPosition = await prisma.activitySessionPosition.create({
      data: {
        activityId: activity.id,
        sessionId: session.id,
        code: key(`${label}-current-position`),
        name: '当前岗位',
        attendanceRoleCode: 'member',
      },
      select: { id: true },
    });
    return {
      activityId: activity.id,
      sessionId: session.id,
      historicPositionId: historicPosition.id,
      currentPositionId: currentPosition.id,
    };
  }

  async function createSession(activityId: string, label: string) {
    return prisma.activitySession.create({
      data: {
        activityId,
        code: key(`${label}-session`),
        name: key(`${label}-session-name`),
        startAt: SESSION_START,
        endAt: SESSION_END,
        locationText: '测试场地',
        checkInOpenAt: new Date(SESSION_START.getTime() - 60 * 60 * 1000),
        checkInCloseAt: new Date(SESSION_START.getTime() + 60 * 60 * 1000),
        checkOutOpenAt: SESSION_START,
        checkOutCloseAt: new Date(SESSION_END.getTime() + 60 * 60 * 1000),
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });
  }

  async function createParticipation(
    activity: ActivityFixture,
    label: string,
    existing?: {
      memberId: string;
      registrationId: string;
      sessionId?: string;
      currentPositionId?: string | null;
    },
  ): Promise<ParticipationFixture> {
    const memberId =
      existing?.memberId ??
      (
        await prisma.member.create({
          data: {
            memberNo: key(`${label}-member`),
            ...memberIdentityData(key(`${label}-member-name`)),
            gradeCode: 'level-2',
          },
          select: { id: true },
        })
      ).id;
    const registrationId =
      existing?.registrationId ??
      (
        await prisma.activityRegistration.create({
          data: { activityId: activity.activityId, memberId, statusCode: 'pass' },
          select: { id: true },
        })
      ).id;
    const sessionId = existing?.sessionId ?? activity.sessionId;
    const currentPositionId =
      existing?.currentPositionId ??
      (sessionId === activity.sessionId ? activity.currentPositionId : null);
    const identity = await prisma.activityParticipationIdentity.create({
      data: {
        activityId: activity.activityId,
        sessionId,
        registrationId,
        memberId,
        currentPositionId,
        currentStatusCode: 'pass',
      },
      select: { id: true },
    });
    return { ...activity, sessionId, identityId: identity.id, memberId, registrationId };
  }

  async function createPunch(
    participation: ParticipationFixture,
    label: string,
    options: { eventTypeCode?: string; positionId?: string | null; occurredAt?: Date } = {},
  ) {
    const occurredAt = options.occurredAt ?? SESSION_START;
    return prisma.attendancePunchEvent.create({
      data: {
        activityId: participation.activityId,
        sessionId: participation.sessionId,
        participationIdentityId: participation.identityId,
        memberId: participation.memberId,
        eventTypeCode: options.eventTypeCode ?? 'check_in',
        sourceCode: 'self_qr',
        occurredAt,
        receivedAt: occurredAt,
        operatorUserId: actorUserId,
        eventKey: key(`${label}-event`),
        requestHash: key(`${label}-hash`),
        evidenceRevision: 0,
        ...(options.positionId === undefined ? {} : { positionId: options.positionId }),
      },
      select: { id: true },
    });
  }

  async function createSegment(
    participation: ParticipationFixture,
    input: {
      segmentKey: string;
      sourceCheckInEventId: string;
      sourceCloseEventId?: string | null;
      revision?: number;
      resultCode?: string;
      statusCode?: string;
      checkInAt?: Date;
      checkOutAt?: Date | null;
      lateFlag?: boolean;
      earlyLeaveFlag?: boolean;
    },
  ) {
    return prisma.participantServiceSegmentRevision.create({
      data: {
        participationIdentityId: participation.identityId,
        segmentKey: input.segmentKey,
        revision: input.revision ?? 1,
        sourceCheckInEventId: input.sourceCheckInEventId,
        sourceCloseEventId: input.sourceCloseEventId ?? null,
        resultCode: input.resultCode ?? 'valid',
        statusCode: input.statusCode ?? 'draft',
        checkInAt: input.checkInAt ?? SESSION_START,
        checkOutAt: input.checkOutAt ?? null,
        serviceHours: 99,
        lateFlag: input.lateFlag ?? false,
        earlyLeaveFlag: input.earlyLeaveFlag ?? false,
      },
      select: { id: true },
    });
  }

  function read(activityId: string) {
    return prisma.$transaction((tx) => facade.readActivityCurrentSegmentsTrusted(tx, activityId));
  }

  it('reads only current facts in stable order and keeps the historic check-in position', async () => {
    const activity = await createActivity('current');
    const first = await createParticipation(activity, 'first');
    const second = await createParticipation(activity, 'second');
    const firstCheckIn = await createPunch(first, 'first-check-in', {
      positionId: activity.historicPositionId,
    });
    const firstCheckOut = await createPunch(first, 'first-check-out', {
      eventTypeCode: 'check_out',
      positionId: null,
      occurredAt: new Date('2099-01-01T04:00:00.000Z'),
    });
    const old = await createSegment(first, {
      segmentKey: 'valid-current',
      sourceCheckInEventId: firstCheckIn.id,
      sourceCloseEventId: firstCheckOut.id,
      revision: 1,
      statusCode: 'superseded',
      checkOutAt: new Date('2099-01-01T04:00:00.000Z'),
    });
    const current = await createSegment(first, {
      segmentKey: 'valid-current',
      sourceCheckInEventId: firstCheckIn.id,
      sourceCloseEventId: firstCheckOut.id,
      revision: 2,
      statusCode: 'draft',
      checkOutAt: new Date('2099-01-01T04:00:00.000Z'),
    });
    const open = await createSegment(first, {
      segmentKey: 'open-early-zero',
      sourceCheckInEventId: firstCheckIn.id,
      resultCode: 'early_departure_zero',
      checkOutAt: null,
      earlyLeaveFlag: true,
    });
    const voided = await createSegment(first, {
      segmentKey: 'voided',
      sourceCheckInEventId: firstCheckIn.id,
      resultCode: 'voided',
    });
    const replaced = await createSegment(first, {
      segmentKey: 'replaced',
      sourceCheckInEventId: firstCheckIn.id,
      resultCode: 'replaced',
      statusCode: 'committed',
    });
    const secondCheckIn = await createPunch(second, 'second-check-in', {
      positionId: activity.historicPositionId,
    });
    const secondSegment = await createSegment(second, {
      segmentKey: 'second',
      sourceCheckInEventId: secondCheckIn.id,
    });

    const segments = await read(activity.activityId);

    expect(segments).toHaveLength(5);
    expect(segments.map((item) => item.id)).toEqual(
      expect.arrayContaining([current.id, open.id, voided.id, replaced.id, secondSegment.id]),
    );
    expect(segments.some((item) => item.id === old.id)).toBe(false);
    const order = segments.map(
      (item) =>
        `${item.participationIdentityId}\u0000${item.segmentKey}\u0000${String(item.revision).padStart(8, '0')}`,
    );
    expect(order).toEqual([...order].sort((left, right) => left.localeCompare(right)));
    const valid = segments.find((item) => item.id === current.id);
    if (!valid) throw new Error('current segment fixture was not returned');
    expect(valid).toMatchObject({
      activityId: activity.activityId,
      sessionId: activity.sessionId,
      participationIdentityId: first.identityId,
      memberId: first.memberId,
      sourcePositionId: activity.historicPositionId,
      resultCode: 'valid',
      statusCode: 'draft',
    });
    expect(valid.sourcePositionId).not.toBe(activity.currentPositionId);
    expect(valid).not.toHaveProperty('sourceCheckInEvent');
    expect(valid).not.toHaveProperty('serviceHours');
    expect(segments.find((item) => item.id === open.id)?.checkOutAt).toBeNull();
    expect(new Set(segments.map((item) => item.resultCode))).toEqual(
      new Set(['valid', 'early_departure_zero', 'voided', 'replaced']),
    );
  });

  it('fails closed for cross identity, activity, session, member and close-anchor facts', async () => {
    const identityActivity = await createActivity('identity');
    const identityTarget = await createParticipation(identityActivity, 'identity-target');
    const identityOther = await createParticipation(identityActivity, 'identity-other');
    const identityEvent = await createPunch(identityOther, 'identity-other');
    await createSegment(identityTarget, {
      segmentKey: 'bad-identity',
      sourceCheckInEventId: identityEvent.id,
    });
    await expect(read(identityActivity.activityId)).rejects.toThrow(TypeError);

    const activityTargetActivity = await createActivity('activity-target');
    const activityTarget = await createParticipation(activityTargetActivity, 'activity-target');
    const foreignActivity = await createActivity('activity-foreign');
    const foreignParticipation = await createParticipation(foreignActivity, 'activity-foreign');
    const foreignEvent = await createPunch(foreignParticipation, 'activity-foreign');
    await createSegment(activityTarget, {
      segmentKey: 'bad-activity',
      sourceCheckInEventId: foreignEvent.id,
    });
    await expect(read(activityTargetActivity.activityId)).rejects.toThrow(TypeError);

    const sessionActivity = await createActivity('session');
    const sessionTarget = await createParticipation(sessionActivity, 'session-target');
    const otherSession = await createSession(sessionActivity.activityId, 'session-foreign');
    const sessionOther = await createParticipation(sessionActivity, 'session-other', {
      memberId: sessionTarget.memberId,
      registrationId: sessionTarget.registrationId,
      sessionId: otherSession.id,
      currentPositionId: null,
    });
    const sessionEvent = await createPunch(sessionOther, 'session-other');
    await createSegment(sessionTarget, {
      segmentKey: 'bad-session',
      sourceCheckInEventId: sessionEvent.id,
    });
    await expect(read(sessionActivity.activityId)).rejects.toThrow(TypeError);

    const closeActivity = await createActivity('close');
    const closeTarget = await createParticipation(closeActivity, 'close-target');
    const closeOther = await createParticipation(closeActivity, 'close-other');
    const correctCheckIn = await createPunch(closeTarget, 'close-correct', {
      positionId: closeActivity.historicPositionId,
    });
    const wrongClose = await createPunch(closeOther, 'close-wrong', {
      eventTypeCode: 'check_out',
      positionId: null,
    });
    await createSegment(closeTarget, {
      segmentKey: 'bad-close-member',
      sourceCheckInEventId: correctCheckIn.id,
      sourceCloseEventId: wrongClose.id,
      checkOutAt: new Date('2099-01-01T04:00:00.000Z'),
    });
    await expect(read(closeActivity.activityId)).rejects.toThrow(TypeError);
  });

  it('sees same-transaction writes and leaves no persistent result after rollback', async () => {
    const activity = await createActivity('transaction');
    const participation = await createParticipation(activity, 'transaction');

    await expect(
      prisma.$transaction(async (tx) => {
        const checkIn = await tx.attendancePunchEvent.create({
          data: {
            activityId: participation.activityId,
            sessionId: participation.sessionId,
            positionId: participation.historicPositionId,
            participationIdentityId: participation.identityId,
            memberId: participation.memberId,
            eventTypeCode: 'check_in',
            sourceCode: 'self_qr',
            occurredAt: SESSION_START,
            receivedAt: SESSION_START,
            operatorUserId: actorUserId,
            eventKey: key('transaction-event'),
            requestHash: key('transaction-hash'),
            evidenceRevision: 0,
          },
        });
        const created = await tx.participantServiceSegmentRevision.create({
          data: {
            participationIdentityId: participation.identityId,
            segmentKey: 'transactional',
            revision: 1,
            sourceCheckInEventId: checkIn.id,
            resultCode: 'valid',
            statusCode: 'draft',
            checkInAt: SESSION_START,
            checkOutAt: null,
            serviceHours: 9,
          },
        });
        const visible = await facade.readActivityCurrentSegmentsTrusted(
          tx,
          participation.activityId,
        );
        expect(visible.map((item) => item.id)).toEqual([created.id]);
        throw new Error('rollback D2 transaction fixture');
      }),
    ).rejects.toThrow('rollback D2 transaction fixture');

    await expect(read(participation.activityId)).resolves.toEqual([]);
    await expect(
      prisma.participantServiceSegmentRevision.count({
        where: { participationIdentityId: participation.identityId },
      }),
    ).resolves.toBe(0);
  });
});
