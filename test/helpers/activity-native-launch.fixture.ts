import { strict as assert } from 'node:assert';
import type { Prisma } from '@prisma/client';
import type { E4Fixture } from './activity-contribution-policy.fixture';
import type { TimePolicyDefinition } from '../../src/modules/activities/activity-time-policy-definition';
import { memberIdentityData } from './member-identity.fixture';

/** Raw observations only: never synthesizes publication, seal, settlement or ledger state. */
export function nativeLaunchRawInput(
  source: {
    activityId: string;
    sessionId: string;
    positionId: string;
    startsAt: Date;
    endsAt: Date;
  },
  creator: { id: string; memberId: string },
  population: number,
  key: (kind: string) => string,
  receivedAt: Date,
) {
  assert(Number.isInteger(population) && population >= 1 && population <= 500);
  assert(source.startsAt.getTime() < source.endsAt.getTime());
  assert(receivedAt.getTime() >= source.endsAt.getTime());
  const people = Array.from({ length: population }, (_, index) => ({
    memberId: index === 0 ? creator.memberId : key('member'),
    registrationId: key('registration'),
    identityId: key('identity'),
    checkInId: key('punch'),
    checkOutId: key('punch'),
  }));
  const members: Prisma.MemberCreateManyInput[] = people.slice(1).map((person) => ({
    id: person.memberId,
    memberNo: person.memberId,
    ...memberIdentityData('Isolated native launch fixture'),
  }));
  const registrations: Prisma.ActivityRegistrationCreateManyInput[] = people.map((person) => ({
    id: person.registrationId,
    activityId: source.activityId,
    memberId: person.memberId,
    statusCode: 'pass',
  }));
  const identities: Prisma.ActivityParticipationIdentityCreateManyInput[] = people.map(
    (person) => ({
      id: person.identityId,
      activityId: source.activityId,
      sessionId: source.sessionId,
      registrationId: person.registrationId,
      memberId: person.memberId,
      currentStatusCode: 'pass',
      currentPositionId: source.positionId,
      populationIncluded: true,
    }),
  );
  const events: Prisma.AttendancePunchEventCreateManyInput[] = people.flatMap((person) =>
    [
      { eventTypeCode: 'check_in', occurredAt: source.startsAt, id: person.checkInId },
      { eventTypeCode: 'check_out', occurredAt: source.endsAt, id: person.checkOutId },
    ].map((observation) => ({
      ...observation,
      activityId: source.activityId,
      sessionId: source.sessionId,
      positionId: source.positionId,
      participationIdentityId: person.identityId,
      memberId: person.memberId,
      sourceCode: 'self_qr',
      receivedAt,
      operatorUserId: creator.id,
      eventKey: key('event'),
      requestHash: 'b'.repeat(64),
      evidenceRevision: 0,
    })),
  );
  const segments: Prisma.ParticipantServiceSegmentRevisionCreateManyInput[] = people.map(
    (person) => ({
      participationIdentityId: person.identityId,
      segmentKey: '0001',
      revision: 1,
      sourceCheckInEventId: person.checkInId,
      sourceCloseEventId: person.checkOutId,
      resultCode: 'valid',
      statusCode: 'draft',
      checkInAt: source.startsAt,
      checkOutAt: source.endsAt,
      serviceHours: (source.endsAt.getTime() - source.startsAt.getTime()) / 3_600_000,
      lateFlag: false,
      earlyLeaveFlag: false,
    }),
  );
  assertNativeLaunchProjection({ identities, events, segments });
  return { people, members, registrations, identities, events, segments };
}

/** Detect the original 20043 defect before sending the real seal command. */
export function assertNativeLaunchProjection(input: {
  identities: readonly Pick<Prisma.ActivityParticipationIdentityCreateManyInput, 'id'>[];
  events: readonly Pick<
    Prisma.AttendancePunchEventCreateManyInput,
    'id' | 'eventTypeCode' | 'participationIdentityId' | 'occurredAt'
  >[];
  segments: readonly Pick<
    Prisma.ParticipantServiceSegmentRevisionCreateManyInput,
    | 'participationIdentityId'
    | 'resultCode'
    | 'statusCode'
    | 'sourceCheckInEventId'
    | 'sourceCloseEventId'
    | 'checkInAt'
    | 'checkOutAt'
  >[];
}) {
  assert.equal(input.events.length, input.identities.length * 2);
  assert.equal(input.segments.length, input.identities.length);
  const events = new Map(input.events.map((event) => [event.id, event]));
  assert.equal(events.size, input.events.length);
  const identities = new Set(input.identities.map((identity) => identity.id));
  assert.equal(identities.size, input.identities.length);
  const projected = new Set<string>();
  const used = new Set<string>();
  for (const segment of input.segments) {
    assert(identities.has(segment.participationIdentityId));
    assert(!projected.has(segment.participationIdentityId));
    projected.add(segment.participationIdentityId);
    assert.equal(segment.resultCode, 'valid');
    assert.equal(segment.statusCode, 'draft');
    assert(segment.sourceCheckInEventId && segment.sourceCloseEventId);
    for (const [eventId, kind, instant] of [
      [segment.sourceCheckInEventId, 'check_in', segment.checkInAt],
      [segment.sourceCloseEventId, 'check_out', segment.checkOutAt],
    ] as const) {
      const event = events.get(eventId);
      assert(event);
      assert.equal(event.eventTypeCode, kind);
      assert.equal(event.participationIdentityId, segment.participationIdentityId);
      assert(instant !== null && instant !== undefined);
      assert.equal(new Date(event.occurredAt).getTime(), new Date(instant).getTime());
      assert(!used.has(eventId));
      used.add(eventId);
    }
  }
  assert.equal(used.size, events.size);
}

export function nativeLaunchSlices(startsAt: Date, endsAt: Date, count = 5) {
  assert(count === 5 || count === 6);
  const duration = endsAt.getTime() - startsAt.getTime();
  assert(Number.isSafeInteger(duration) && duration >= count);
  const categories = [
    'volunteer_service',
    'training',
    'organization',
    'non_creditable',
    'volunteer_service',
    'volunteer_service',
  ];
  return Array.from({ length: count }, (_, ordinal) => ({
    categoryCode: categories[ordinal],
    startAt: new Date(startsAt.getTime() + Math.floor((duration * ordinal) / count)).toISOString(),
    endAt: new Date(
      startsAt.getTime() + Math.floor((duration * (ordinal + 1)) / count),
    ).toISOString(),
  }));
}

const LAUNCH_TIME_DEFINITION: TimePolicyDefinition = {
  defaultCategory: 'volunteer_service',
  roleMappings: [],
  allowSplit: true,
  specialIntervals: {
    preparation: { mode: 'exclude' },
    duty: { mode: 'exclude' },
    travel: { mode: 'exclude' },
  },
  rounding: { mode: 'floor', quantumSeconds: 1 },
  evidence: { requiredSources: [], requireManualRecognition: false },
  manualAdjustment: { enabled: true, reasonRequired: true, evidenceRequired: false },
};

/** Same public E5 publication entry; sized at construction, with an actually activated time policy. */
export async function createNativeLaunchPublication(
  fixture: E4Fixture,
  population: number,
  stage: <T>(label: string, work: () => Promise<T>) => Promise<T>,
) {
  assert(Number.isInteger(population) && population >= 1 && population <= 500);
  const request = (await import('supertest')).default;
  const { httpServer } = await import('./http-server');
  const {
    E13_ADMIN,
    E13_APP,
    createE13ActivePolicy,
    explicitContributionPolicyChange,
    selectE13MetricNotRequired,
  } = await import('./activity-contribution-policy.fixture');
  const { createD13ActivePolicy, explicitTimePolicyChange } =
    await import('./activity-time-policy.fixture');
  const server = httpServer(fixture.app);
  const data = (response: { status: number; body: { code?: number; data?: unknown } }) => {
    assert(
      [200, 201].includes(response.status) && response.body.code === 0,
      'NATIVE_PUBLICATION_HTTP_' + response.status + '_' + response.body.code,
    );
    assert(response.body.data && typeof response.body.data === 'object');
    return response.body.data as Record<string, unknown>;
  };
  const id = (value: unknown) => {
    assert(typeof value === 'string' && value.length > 0);
    return value;
  };
  const post = (path: string, auth: string, body: object = {}) =>
    request(server).post(path).set('Authorization', auth).send(body);
  const now = Date.now();
  const nextDay = (Math.floor((now + 8 * 3_600_000) / 86_400_000) + 1) * 86_400_000 - 8 * 3_600_000;
  const startsAt = new Date(
    now + 51_000 >= nextDay ? Math.max(nextDay + 1_000, now + 15_000) : now + 15_000,
  );
  const endsAt = new Date(startsAt.getTime() + 36_000);
  const activity = data(
    await post(`${E13_ADMIN}/activities`, fixture.creator.auth, {
      title: fixture.key('native_launch'),
      activityTypeCode: 'event_support',
      allocationModeCode: 'first_come',
      organizationId: fixture.organizationId,
      startAt: new Date(now - 1_000).toISOString(),
      endAt: new Date(endsAt.getTime() + 500).toISOString(),
      location: 'Isolated native launch fixture',
      visibilityCode: 'internal',
      isPublicRegistration: true,
    }),
  );
  const activityId = id(activity.id);
  // Existing E5 boundary: legacy Admin create has no initiating-member field.
  await fixture.db.activity.update({
    where: { id: activityId },
    data: { initiatorMemberId: fixture.creator.memberId },
  });
  const appUrl = `${E13_APP}/${activityId}`;
  const session = data(
    await post(`${appUrl}/sessions`, fixture.creator.auth, {
      code: fixture.key('session'),
      name: 'Completed session',
      startAt: startsAt.toISOString(),
      endAt: endsAt.toISOString(),
      locationText: 'Isolated native launch fixture',
      checkInOpenAt: new Date(startsAt.getTime() - 500).toISOString(),
      checkInCloseAt: new Date(startsAt.getTime() + 500).toISOString(),
      checkOutOpenAt: new Date(endsAt.getTime() - 500).toISOString(),
      checkOutCloseAt: new Date(endsAt.getTime() + 500).toISOString(),
      locationRequired: false,
    }),
  );
  const sessionId = id(session.sessionId);
  const position = data(
    await post(`${appUrl}/sessions/${sessionId}/positions`, fixture.creator.auth, {
      code: fixture.key('position'),
      name: 'Service',
      attendanceRoleCode: 'service',
      capacity: population,
      startAt: startsAt.toISOString(),
      endAt: endsAt.toISOString(),
    }),
  );
  const positionId = id(position.positionId);
  const window = {
    effectiveFrom: '1900-01-01T00:00:00.000Z',
    effectiveUntil: '2101-01-01T00:00:00.000Z',
  };
  const contribution = await createE13ActivePolicy(fixture, undefined, window);
  const time = await createD13ActivePolicy(fixture, LAUNCH_TIME_DEFINITION, window);
  await selectE13MetricNotRequired(fixture, activityId);
  const selected: Record<string, unknown>[] = [];
  for (const [path, change] of [
    [
      'contribution-policy-selection',
      explicitContributionPolicyChange(contribution, {
        layerCode: 'activity',
        sessionId: null,
        positionId: null,
      }),
    ],
    [
      'time-policy-selection',
      explicitTimePolicyChange(time, { layerCode: 'activity', sessionId: null, positionId: null }),
    ],
  ] as const)
    selected.push(
      data(
        await request(server)
          .patch(`${appUrl}/${path}`)
          .set('Authorization', fixture.creator.auth)
          .send({ operationKey: fixture.key(path), expectedRevision: 0, changes: [change] }),
      ),
    );
  const snapshot = await stage('PUBLISH_HTTP', async () => {
    const submitted = data(
      await post(`${appUrl}/publish-reviews`, fixture.creator.auth, {
        operationKey: fixture.key('publish'),
        confirmation: true,
      }),
    );
    const reviewId = id(submitted.id);
    assert.equal((submitted.snapshot as { schemaVersion: number }).schemaVersion, 9);
    data(
      await post(
        `${E13_ADMIN}/activity-publish-reviews/${reviewId}/approve`,
        fixture.reviewer.auth,
        { requiresInsuranceConfirmed: true, operationKey: fixture.key('approve_publish') },
      ),
    );
    const frozen = await fixture.db.activityRuleSnapshot.findFirstOrThrow({
      where: { activityId, createdByReviewId: reviewId },
    });
    assert.equal(frozen.workflowRevision, 1);
    assert.match(frozen.snapshotHash, /^[0-9a-f]{64}$/);
    assert.equal(frozen.contributionPolicySelectionRevisionId, selected[0].selectionRevisionId);
    assert.equal(frozen.timePolicySelectionRevisionId, selected[1].selectionRevisionId);
    const policy = await fixture.db.activityContributionPolicySelectionRevision.findUniqueOrThrow({
      where: { id: frozen.contributionPolicySelectionRevisionId! },
    });
    assert.equal(policy.selectionHash, selected[0].selectionHash);
    assert.equal(policy.originCode, 'select');
    assert.equal(policy.publishReviewId, null);
    const { historicalAttendanceRoleFromRuleSnapshot } =
      await import('../../src/modules/activities/activity-time-allocation-policy');
    assert.equal(
      historicalAttendanceRoleFromRuleSnapshot(frozen.resolvedConfig, sessionId, positionId),
      'service',
    );
    assert.equal(
      (await fixture.db.activity.findUniqueOrThrow({ where: { id: activityId } })).statusCode,
      'published',
    );
    assert.equal(
      await fixture.db.activityResponsibilityAssignment.count({
        where: { activityId, memberId: fixture.creator.memberId, status: 'active' },
      }),
      1,
    );
    return frozen;
  });
  assert(snapshot.createdAt.getTime() < startsAt.getTime());
  await stage('REAL_SOURCE_WINDOW', async () => {
    while (Date.now() <= endsAt.getTime() + 500) {
      const delay = endsAt.getTime() + 501 - Date.now();
      assert(delay <= 90_000);
      await new Promise<void>((done) => setTimeout(done, Math.min(delay, 20_000)));
    }
  });
  return { activityId, appUrl, sessionId, positionId, startsAt, endsAt, contribution, snapshot };
}
