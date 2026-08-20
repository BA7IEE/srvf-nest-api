import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import {
  CapacityReservationService,
  type CapacityReservationReserveResult,
} from '../../src/modules/activity-registrations/capacity-reservation.service';
import { ActivityCapacityBucketProjector } from '../../src/modules/activities/activity-capacity-bucket-projector';
import { assertTestDatabaseUrl } from '../setup/test-db';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

const FAR = {
  start: new Date('2099-12-01T08:00:00.000Z'),
  end: new Date('2099-12-01T12:00:00.000Z'),
  checkInOpen: new Date('2099-12-01T07:30:00.000Z'),
  checkInClose: new Date('2099-12-01T09:00:00.000Z'),
  checkOutOpen: new Date('2099-12-01T11:00:00.000Z'),
  checkOutClose: new Date('2099-12-01T12:30:00.000Z'),
};

interface FixtureSession {
  id: string;
  positions: Array<{ id: string }>;
}

interface CapacityFixture {
  activityId: string;
  sequence: number;
  sessions: FixtureSession[];
}

interface FixtureMember {
  memberId: string;
  identities: Array<{ id: string; sessionId: string }>;
}

interface CreateFixtureOptions {
  activityCapacity?: number | null;
  sessionCapacities?: Array<number | null>;
  positionCapacitiesBySession?: Array<Array<number | null>>;
  projectBuckets?: boolean;
}

describe('batch4 capacity reservation kernel', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: CapacityReservationService;
  let projector: ActivityCapacityBucketProjector;
  let sequence = 0;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    service = app.get(CapacityReservationService);
    projector = app.get(ActivityCapacityBucketProjector);
  });

  afterAll(async () => {
    await app.close();
  });

  async function createFixture(options: CreateFixtureOptions = {}): Promise<CapacityFixture> {
    const fixtureSequence = ++sequence;
    const activityCapacity = options.activityCapacity === undefined ? 3 : options.activityCapacity;
    const sessionCapacities = options.sessionCapacities ?? [3];
    const positionCapacitiesBySession =
      options.positionCapacitiesBySession ?? sessionCapacities.map(() => [3]);
    const projectBuckets = options.projectBuckets ?? true;
    const organization = await prisma.organization.create({
      data: {
        name: `capacity-reservation-org-${fixtureSequence}`,
        nodeTypeCode: 'capacity-reservation-team',
      },
      select: { id: true },
    });
    const activity = await prisma.activity.create({
      data: {
        title: `Capacity Reservation ${fixtureSequence}`,
        activityTypeCode: 'capacity-reservation',
        organizationId: organization.id,
        startAt: FAR.start,
        endAt: FAR.end,
        location: 'capacity reservation fixture',
        statusCode: 'published',
        capacity: activityCapacity,
      },
      select: { id: true },
    });
    const sessions: FixtureSession[] = [];
    for (const [sessionIndex, capacity] of sessionCapacities.entries()) {
      const session = await prisma.activitySession.create({
        data: {
          activityId: activity.id,
          code: `capacity-reservation-session-${fixtureSequence}-${sessionIndex}`,
          name: `Capacity Reservation Session ${fixtureSequence}-${sessionIndex}`,
          startAt: FAR.start,
          endAt: FAR.end,
          locationText: 'capacity reservation fixture',
          capacity,
          checkInOpenAt: FAR.checkInOpen,
          checkInCloseAt: FAR.checkInClose,
          checkOutOpenAt: FAR.checkOutOpen,
          checkOutCloseAt: FAR.checkOutClose,
          locationRequired: false,
          locationPolicySourceCode: 'system',
          statusCode: 'scheduled',
        },
        select: { id: true },
      });
      const positions: Array<{ id: string }> = [];
      for (const [positionIndex, positionCapacity] of (
        positionCapacitiesBySession[sessionIndex] ?? []
      ).entries()) {
        const position = await prisma.activitySessionPosition.create({
          data: {
            activityId: activity.id,
            sessionId: session.id,
            code: `capacity-reservation-position-${fixtureSequence}-${sessionIndex}-${positionIndex}`,
            name: `Capacity Reservation Position ${fixtureSequence}-${sessionIndex}-${positionIndex}`,
            attendanceRoleCode: 'volunteer',
            capacity: positionCapacity,
          },
          select: { id: true },
        });
        positions.push(position);
      }
      sessions.push({ ...session, positions });
    }
    if (projectBuckets) {
      await prisma.activityCapacityBucket.createMany({
        data: [
          {
            activityId: activity.id,
            scopeTypeCode: 'activity_person',
            scopeId: activity.id,
            capacity: activityCapacity,
          },
          ...sessions.map((session, sessionIndex) => ({
            activityId: activity.id,
            scopeTypeCode: 'session_participation',
            scopeId: session.id,
            capacity: sessionCapacities[sessionIndex],
          })),
          ...sessions.flatMap((session, sessionIndex) =>
            session.positions.map((position, positionIndex) => ({
              activityId: activity.id,
              scopeTypeCode: 'position_participation',
              scopeId: position.id,
              capacity: positionCapacitiesBySession[sessionIndex]?.[positionIndex] ?? null,
            })),
          ),
        ],
      });
    }
    return { activityId: activity.id, sequence: fixtureSequence, sessions };
  }

  async function createMember(
    fixture: CapacityFixture,
    suffix: string,
    sessionIndexes = fixture.sessions.map((_, index) => index),
  ): Promise<FixtureMember> {
    const member = await prisma.member.create({
      data: {
        memberNo: `capacity-reservation-member-${fixture.sequence}-${suffix}`,
        ...memberIdentityData(`Capacity Reservation Member ${fixture.sequence}-${suffix}`),
      },
      select: { id: true },
    });
    const registration = await prisma.activityRegistration.create({
      data: { activityId: fixture.activityId, memberId: member.id, statusCode: 'pending' },
      select: { id: true },
    });
    const identities: Array<{ id: string; sessionId: string }> = [];
    for (const sessionIndex of sessionIndexes) {
      const session = fixture.sessions[sessionIndex];
      if (!session) throw new Error(`fixture session ${sessionIndex} is missing`);
      const identity = await prisma.activityParticipationIdentity.create({
        data: {
          activityId: fixture.activityId,
          sessionId: session.id,
          registrationId: registration.id,
          memberId: member.id,
          currentStatusCode: 'pending',
        },
        select: { id: true, sessionId: true },
      });
      identities.push(identity);
    }
    return { memberId: member.id, identities };
  }

  function identityFor(member: FixtureMember, session: FixtureSession): string {
    const identity = member.identities.find((candidate) => candidate.sessionId === session.id);
    if (!identity) throw new Error(`member does not have an identity for session ${session.id}`);
    return identity.id;
  }

  function reserve(input: {
    activityId: string;
    memberId: string;
    selections: Array<{ identityId: string; positionId?: string }>;
  }) {
    return prisma.$transaction((tx) => service.reserveInTransactionTrusted(tx, input));
  }

  function release(input: {
    activityId: string;
    memberId: string;
    identityIds: string[];
    releaseReason: string;
  }) {
    return prisma.$transaction((tx) => service.releaseInTransactionTrusted(tx, input));
  }

  async function bucketFacts(activityId: string) {
    return prisma.activityCapacityBucket.findMany({
      where: { activityId },
      select: {
        id: true,
        scopeTypeCode: true,
        scopeId: true,
        capacity: true,
        occupied: true,
        version: true,
        updatedAt: true,
      },
      orderBy: [{ scopeTypeCode: 'asc' }, { scopeId: 'asc' }, { id: 'asc' }],
    });
  }

  async function bucketFor(activityId: string, scopeTypeCode: string, scopeId: string) {
    return prisma.activityCapacityBucket.findUniqueOrThrow({
      where: { scopeTypeCode_scopeId: { scopeTypeCode, scopeId } },
      select: { id: true, activityId: true, occupied: true, version: true, updatedAt: true },
    });
  }

  async function capacityOperationFacts(activityId: string, identityIds: readonly string[]) {
    const [buckets, reservations, identities, auditCount, outboxCount] = await Promise.all([
      bucketFacts(activityId),
      prisma.capacityReservation.findMany({
        where: { identity: { activityId } },
        select: {
          id: true,
          identityId: true,
          bucketId: true,
          reservationType: true,
          memberId: true,
          activityId: true,
          status: true,
          releasedAt: true,
          releaseReason: true,
          updatedAt: true,
        },
        orderBy: { id: 'asc' },
      }),
      prisma.activityParticipationIdentity.findMany({
        where: { id: { in: [...identityIds] } },
        select: {
          id: true,
          currentRevision: true,
          currentStatusCode: true,
          currentPositionId: true,
          capacityReservationId: true,
          populationIncluded: true,
          version: true,
          updatedAt: true,
        },
        orderBy: { id: 'asc' },
      }),
      prisma.auditLog.count(),
      prisma.notificationOutboxIntent.count(),
    ]);
    return { buckets, reservations, identities, auditCount, outboxCount };
  }

  async function expectReconciliationFailure(operation: Promise<unknown>): Promise<void> {
    await expect(operation).rejects.toEqual(
      new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED),
    );
  }

  it('chains projected buckets into one member three-session reservation with one activity-person fact', async () => {
    const fixture = await createFixture({
      activityCapacity: 3,
      sessionCapacities: [3, 3, 3],
      positionCapacitiesBySession: [[3], [], []],
      projectBuckets: false,
    });
    await prisma.$transaction((tx) => projector.apply(tx, fixture.activityId));
    const member = await createMember(fixture, 'three-layer');

    const result = await reserve({
      activityId: fixture.activityId,
      memberId: member.memberId,
      selections: [
        { identityId: identityFor(member, fixture.sessions[2]) },
        {
          identityId: identityFor(member, fixture.sessions[0]),
          positionId: fixture.sessions[0].positions[0].id,
        },
        { identityId: identityFor(member, fixture.sessions[1]) },
      ],
    });

    expect(result).toMatchObject({ outcome: 'reserved' });
    if (result.outcome !== 'reserved') throw new Error('reservation unexpectedly unavailable');
    expect(result.identities).toHaveLength(3);
    const buckets = await bucketFacts(fixture.activityId);
    expect(buckets).toHaveLength(5);
    expect(buckets.map((bucket) => bucket.occupied)).toEqual([1, 1, 1, 1, 1]);
    expect(buckets.map((bucket) => bucket.version)).toEqual([1, 1, 1, 1, 1]);

    const reservations = await prisma.capacityReservation.findMany({
      where: { identity: { activityId: fixture.activityId }, status: 'active' },
      select: { identityId: true, reservationType: true, memberId: true, activityId: true },
      orderBy: [{ reservationType: 'asc' }, { identityId: 'asc' }],
    });
    expect(reservations).toHaveLength(5);
    const activityPerson = reservations.filter(
      (reservation) => reservation.reservationType === 'activity_person',
    );
    expect(activityPerson).toEqual([
      {
        identityId: [...member.identities.map((identity) => identity.id)].sort()[0],
        reservationType: 'activity_person',
        memberId: member.memberId,
        activityId: fixture.activityId,
      },
    ]);
    for (const bucket of buckets) {
      await expect(
        prisma.capacityReservation.count({ where: { bucketId: bucket.id, status: 'active' } }),
      ).resolves.toBe(bucket.occupied);
    }
  });

  it('counts 100 members across three sessions as 100 people and 300 attendance instances', async () => {
    const fixture = await createFixture({
      activityCapacity: 100,
      sessionCapacities: [100, 100, 100],
      positionCapacitiesBySession: [[], [], []],
    });
    for (let memberIndex = 0; memberIndex < 100; memberIndex += 1) {
      const member = await createMember(fixture, `hundred-${memberIndex}`);
      await reserve({
        activityId: fixture.activityId,
        memberId: member.memberId,
        selections: fixture.sessions.map((session) => ({
          identityId: identityFor(member, session),
        })),
      });
    }

    const buckets = await bucketFacts(fixture.activityId);
    const activityBucket = buckets.find((bucket) => bucket.scopeTypeCode === 'activity_person');
    const sessionBuckets = buckets.filter(
      (bucket) => bucket.scopeTypeCode === 'session_participation',
    );
    expect(activityBucket).toMatchObject({ occupied: 100, version: 100 });
    expect(sessionBuckets.map((bucket) => bucket.occupied)).toEqual([100, 100, 100]);
    expect(sessionBuckets.reduce((total, bucket) => total + bucket.occupied, 0)).toBe(300);
    await expect(
      prisma.capacityReservation.count({
        where: {
          status: 'active',
          reservationType: 'activity_person',
          identity: { activityId: fixture.activityId },
        },
      }),
    ).resolves.toBe(100);
    await expect(
      prisma.capacityReservation.count({
        where: {
          status: 'active',
          reservationType: 'session_participation',
          identity: { activityId: fixture.activityId },
        },
      }),
    ).resolves.toBe(300);
  });

  it('uses two independent pools to admit exactly one of 100 concurrent attempts for the last seat', async () => {
    const fixture = await createFixture({
      activityCapacity: 100,
      sessionCapacities: [1],
      positionCapacitiesBySession: [[]],
    });
    const members: FixtureMember[] = [];
    for (let memberIndex = 0; memberIndex < 100; memberIndex += 1) {
      members.push(await createMember(fixture, `concurrent-${memberIndex}`));
    }

    const databaseUrl = process.env.DATABASE_URL ?? '';
    assertTestDatabaseUrl(databaseUrl);
    const pooledUrl = new URL(databaseUrl);
    pooledUrl.searchParams.set('connection_limit', '8');
    pooledUrl.searchParams.set('pool_timeout', '60');
    const prismaA = new PrismaClient({ datasourceUrl: pooledUrl.toString() });
    const prismaB = new PrismaClient({ datasourceUrl: pooledUrl.toString() });
    await Promise.all([prismaA.$connect(), prismaB.$connect()]);
    type Attempt =
      | { ok: true; result: CapacityReservationReserveResult }
      | { ok: false; error: unknown };
    try {
      const attempts = await Promise.all(
        members.map(async (member, index): Promise<Attempt> => {
          const client = index % 2 === 0 ? prismaA : prismaB;
          try {
            const result = await client.$transaction(
              (tx) =>
                service.reserveInTransactionTrusted(tx, {
                  activityId: fixture.activityId,
                  memberId: member.memberId,
                  selections: [{ identityId: identityFor(member, fixture.sessions[0]) }],
                }),
              { maxWait: 60_000, timeout: 60_000 },
            );
            return { ok: true, result };
          } catch (error) {
            return { ok: false, error };
          }
        }),
      );
      const errors = attempts.filter(
        (attempt): attempt is { ok: false; error: unknown } => !attempt.ok,
      );
      const successful = attempts.filter(
        (attempt): attempt is { ok: true; result: CapacityReservationReserveResult } => attempt.ok,
      );
      expect(errors).toEqual([]);
      expect(successful.filter((attempt) => attempt.result.outcome === 'reserved')).toHaveLength(1);
      expect(
        successful.filter((attempt) => attempt.result.outcome === 'capacity_unavailable'),
      ).toHaveLength(99);
    } finally {
      await Promise.all([prismaA.$disconnect(), prismaB.$disconnect()]);
    }

    await expect(
      bucketFor(fixture.activityId, 'activity_person', fixture.activityId),
    ).resolves.toMatchObject({ occupied: 1, version: 1 });
    await expect(
      bucketFor(fixture.activityId, 'session_participation', fixture.sessions[0].id),
    ).resolves.toMatchObject({ occupied: 1, version: 1 });
    await expect(
      prisma.capacityReservation.count({
        where: { status: 'active', identity: { activityId: fixture.activityId } },
      }),
    ).resolves.toBe(2);
  }, 120_000);

  it('returns capacity_unavailable without a partial activity or session reservation when the position is full', async () => {
    const fixture = await createFixture({
      activityCapacity: 2,
      sessionCapacities: [2],
      positionCapacitiesBySession: [[1]],
    });
    const first = await createMember(fixture, 'position-first');
    const second = await createMember(fixture, 'position-second');
    await reserve({
      activityId: fixture.activityId,
      memberId: first.memberId,
      selections: [
        {
          identityId: identityFor(first, fixture.sessions[0]),
          positionId: fixture.sessions[0].positions[0].id,
        },
      ],
    });
    const beforeBuckets = await bucketFacts(fixture.activityId);
    const beforeReservationCount = await prisma.capacityReservation.count({
      where: { identity: { activityId: fixture.activityId } },
    });

    await expect(
      reserve({
        activityId: fixture.activityId,
        memberId: second.memberId,
        selections: [
          {
            identityId: identityFor(second, fixture.sessions[0]),
            positionId: fixture.sessions[0].positions[0].id,
          },
        ],
      }),
    ).resolves.toEqual({
      outcome: 'capacity_unavailable',
      scopeTypeCode: 'position_participation',
      scopeId: fixture.sessions[0].positions[0].id,
    });
    await expect(bucketFacts(fixture.activityId)).resolves.toEqual(beforeBuckets);
    await expect(
      prisma.capacityReservation.count({ where: { identity: { activityId: fixture.activityId } } }),
    ).resolves.toBe(beforeReservationCount);
  });

  it('treats null capacity as unlimited while keeping occupied facts reconciled', async () => {
    const fixture = await createFixture({
      activityCapacity: null,
      sessionCapacities: [null],
      positionCapacitiesBySession: [[null]],
    });
    for (const suffix of ['unlimited-a', 'unlimited-b']) {
      const member = await createMember(fixture, suffix);
      await reserve({
        activityId: fixture.activityId,
        memberId: member.memberId,
        selections: [
          {
            identityId: identityFor(member, fixture.sessions[0]),
            positionId: fixture.sessions[0].positions[0].id,
          },
        ],
      });
    }
    const buckets = await bucketFacts(fixture.activityId);
    expect(
      buckets.map((bucket) => ({ capacity: bucket.capacity, occupied: bucket.occupied })),
    ).toEqual([
      { capacity: null, occupied: 2 },
      { capacity: null, occupied: 2 },
      { capacity: null, occupied: 2 },
    ]);
  });

  it('returns the same ids and leaves reservation, occupied, version, and updatedAt unchanged on exact replay', async () => {
    const fixture = await createFixture();
    const member = await createMember(fixture, 'replay');
    const input = {
      activityId: fixture.activityId,
      memberId: member.memberId,
      selections: [
        {
          identityId: identityFor(member, fixture.sessions[0]),
          positionId: fixture.sessions[0].positions[0].id,
        },
      ],
    };
    const first = await reserve(input);
    const beforeBuckets = await bucketFacts(fixture.activityId);
    const beforeReservations = await prisma.capacityReservation.findMany({
      where: { identity: { activityId: fixture.activityId } },
      select: { id: true, status: true, updatedAt: true },
      orderBy: { id: 'asc' },
    });

    await expect(reserve(input)).resolves.toEqual(first);
    await expect(bucketFacts(fixture.activityId)).resolves.toEqual(beforeBuckets);
    await expect(
      prisma.capacityReservation.findMany({
        where: { identity: { activityId: fixture.activityId } },
        select: { id: true, status: true, updatedAt: true },
        orderBy: { id: 'asc' },
      }),
    ).resolves.toEqual(beforeReservations);
  });

  it('rejects a second position for one identity without changing its active facts', async () => {
    const fixture = await createFixture({ positionCapacitiesBySession: [[3, 3]] });
    const member = await createMember(fixture, 'different-position');
    const identityId = identityFor(member, fixture.sessions[0]);
    await reserve({
      activityId: fixture.activityId,
      memberId: member.memberId,
      selections: [{ identityId, positionId: fixture.sessions[0].positions[0].id }],
    });
    const beforeBuckets = await bucketFacts(fixture.activityId);
    const beforeReservations = await prisma.capacityReservation.findMany({
      where: { identityId },
      select: { id: true, bucketId: true, status: true, updatedAt: true },
      orderBy: { id: 'asc' },
    });

    await expectReconciliationFailure(
      reserve({
        activityId: fixture.activityId,
        memberId: member.memberId,
        selections: [{ identityId, positionId: fixture.sessions[0].positions[1].id }],
      }),
    );
    await expect(bucketFacts(fixture.activityId)).resolves.toEqual(beforeBuckets);
    await expect(
      prisma.capacityReservation.findMany({
        where: { identityId },
        select: { id: true, bucketId: true, status: true, updatedAt: true },
        orderBy: { id: 'asc' },
      }),
    ).resolves.toEqual(beforeReservations);
  });

  it('keeps activity-person occupied through a partial release and releases it with the last session', async () => {
    const fixture = await createFixture({
      activityCapacity: 2,
      sessionCapacities: [2, 2],
      positionCapacitiesBySession: [[2], []],
    });
    const member = await createMember(fixture, 'partial-release');
    const firstIdentityId = identityFor(member, fixture.sessions[0]);
    const secondIdentityId = identityFor(member, fixture.sessions[1]);
    await reserve({
      activityId: fixture.activityId,
      memberId: member.memberId,
      selections: [
        { identityId: firstIdentityId, positionId: fixture.sessions[0].positions[0].id },
        { identityId: secondIdentityId },
      ],
    });

    await expect(
      release({
        activityId: fixture.activityId,
        memberId: member.memberId,
        identityIds: [firstIdentityId],
        releaseReason: 'partial release control',
      }),
    ).resolves.toMatchObject({ outcome: 'released', releasedReservationIds: expect.any(Array) });
    await expect(
      bucketFor(fixture.activityId, 'activity_person', fixture.activityId),
    ).resolves.toMatchObject({ occupied: 1, version: 1 });
    await expect(
      bucketFor(fixture.activityId, 'session_participation', fixture.sessions[0].id),
    ).resolves.toMatchObject({ occupied: 0, version: 2 });
    await expect(
      bucketFor(fixture.activityId, 'position_participation', fixture.sessions[0].positions[0].id),
    ).resolves.toMatchObject({ occupied: 0, version: 2 });
    await expect(
      bucketFor(fixture.activityId, 'session_participation', fixture.sessions[1].id),
    ).resolves.toMatchObject({ occupied: 1, version: 1 });
    await expect(
      prisma.capacityReservation.count({
        where: { status: 'active', identity: { activityId: fixture.activityId } },
      }),
    ).resolves.toBe(2);

    await expect(
      release({
        activityId: fixture.activityId,
        memberId: member.memberId,
        identityIds: [secondIdentityId],
        releaseReason: 'last session release control',
      }),
    ).resolves.toMatchObject({ outcome: 'released', releasedReservationIds: expect.any(Array) });
    await expect(bucketFacts(fixture.activityId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scopeTypeCode: 'activity_person', occupied: 0, version: 2 }),
        expect.objectContaining({
          scopeTypeCode: 'session_participation',
          scopeId: fixture.sessions[0].id,
          occupied: 0,
          version: 2,
        }),
        expect.objectContaining({
          scopeTypeCode: 'session_participation',
          scopeId: fixture.sessions[1].id,
          occupied: 0,
          version: 2,
        }),
      ]),
    );
  });

  it('makes release replay a no-op and re-reserve preserves released history', async () => {
    const fixture = await createFixture();
    const member = await createMember(fixture, 'release-replay');
    const identityId = identityFor(member, fixture.sessions[0]);
    const input = {
      activityId: fixture.activityId,
      memberId: member.memberId,
      selections: [{ identityId, positionId: fixture.sessions[0].positions[0].id }],
    };
    await reserve(input);
    await release({
      activityId: fixture.activityId,
      memberId: member.memberId,
      identityIds: [identityId],
      releaseReason: 'release replay control',
    });
    const afterReleaseBuckets = await bucketFacts(fixture.activityId);
    const afterReleaseReservations = await prisma.capacityReservation.findMany({
      where: { identityId },
      select: { id: true, status: true, releasedAt: true, releaseReason: true, updatedAt: true },
      orderBy: { id: 'asc' },
    });

    await expect(
      release({
        activityId: fixture.activityId,
        memberId: member.memberId,
        identityIds: [identityId],
        releaseReason: 'repeat release must not write',
      }),
    ).resolves.toEqual({ outcome: 'released', releasedReservationIds: [] });
    await expect(bucketFacts(fixture.activityId)).resolves.toEqual(afterReleaseBuckets);
    await expect(
      prisma.capacityReservation.findMany({
        where: { identityId },
        select: { id: true, status: true, releasedAt: true, releaseReason: true, updatedAt: true },
        orderBy: { id: 'asc' },
      }),
    ).resolves.toEqual(afterReleaseReservations);

    await expect(reserve(input)).resolves.toMatchObject({ outcome: 'reserved' });
    await expect(
      prisma.capacityReservation.count({ where: { identityId, status: 'active' } }),
    ).resolves.toBe(3);
    await expect(
      prisma.capacityReservation.count({ where: { identityId, status: 'released' } }),
    ).resolves.toBe(3);
  });

  it('fails closed before a partial release when another active member session bucket is drifted', async () => {
    const fixture = await createFixture({
      activityCapacity: 3,
      sessionCapacities: [3, 3],
      positionCapacitiesBySession: [[], []],
    });
    const member = await createMember(fixture, 'context-reconciliation');
    const firstIdentityId = identityFor(member, fixture.sessions[0]);
    const secondIdentityId = identityFor(member, fixture.sessions[1]);
    await reserve({
      activityId: fixture.activityId,
      memberId: member.memberId,
      selections: [{ identityId: firstIdentityId }, { identityId: secondIdentityId }],
    });
    const nonRequestedSessionBucket = await bucketFor(
      fixture.activityId,
      'session_participation',
      fixture.sessions[1].id,
    );
    await prisma.activityCapacityBucket.update({
      where: { id: nonRequestedSessionBucket.id },
      data: { occupied: 2, version: { increment: 1 } },
    });
    const before = await capacityOperationFacts(
      fixture.activityId,
      member.identities.map((identity) => identity.id),
    );

    await expectReconciliationFailure(
      release({
        activityId: fixture.activityId,
        memberId: member.memberId,
        identityIds: [firstIdentityId],
        releaseReason: 'complete context reconciliation control',
      }),
    );
    await expect(
      capacityOperationFacts(
        fixture.activityId,
        member.identities.map((identity) => identity.id),
      ),
    ).resolves.toEqual(before);
  });

  it('rejects cancelled or soft-deleted target sessions before reservation DML', async () => {
    const cases = [
      ['cancelled', { statusCode: 'cancelled' }],
      ['soft-deleted', { deletedAt: new Date() }],
    ] as const;
    for (const [suffix, sessionChange] of cases) {
      const fixture = await createFixture({ positionCapacitiesBySession: [[]] });
      const historicalMember = await createMember(fixture, `historical-${suffix}`);
      const historicalIdentityId = identityFor(historicalMember, fixture.sessions[0]);
      await reserve({
        activityId: fixture.activityId,
        memberId: historicalMember.memberId,
        selections: [{ identityId: historicalIdentityId }],
      });
      await prisma.activitySession.update({
        where: { id: fixture.sessions[0].id },
        data: sessionChange,
      });
      await expect(
        release({
          activityId: fixture.activityId,
          memberId: historicalMember.memberId,
          identityIds: [historicalIdentityId],
          releaseReason: `historical ${suffix} cleanup`,
        }),
      ).resolves.toMatchObject({ outcome: 'released' });

      const blockedMember = await createMember(fixture, `non-live-${suffix}`);
      const blockedIdentityId = identityFor(blockedMember, fixture.sessions[0]);
      const before = await capacityOperationFacts(fixture.activityId, [
        historicalIdentityId,
        blockedIdentityId,
      ]);

      await expectReconciliationFailure(
        reserve({
          activityId: fixture.activityId,
          memberId: blockedMember.memberId,
          selections: [{ identityId: blockedIdentityId }],
        }),
      );
      await expect(
        capacityOperationFacts(fixture.activityId, [historicalIdentityId, blockedIdentityId]),
      ).resolves.toEqual(before);
    }
  });

  it('fails closed on occupied drift without changing identity, audit, outbox, or candidate facts', async () => {
    const fixture = await createFixture();
    const member = await createMember(fixture, 'drift');
    const identityId = identityFor(member, fixture.sessions[0]);
    const activityBucket = await bucketFor(
      fixture.activityId,
      'activity_person',
      fixture.activityId,
    );
    await prisma.activityCapacityBucket.update({
      where: { id: activityBucket.id },
      data: { occupied: 1 },
    });
    const beforeBuckets = await bucketFacts(fixture.activityId);
    const beforeIdentity = await prisma.activityParticipationIdentity.findUniqueOrThrow({
      where: { id: identityId },
      select: {
        currentRevision: true,
        currentStatusCode: true,
        currentPositionId: true,
        capacityReservationId: true,
        populationIncluded: true,
        version: true,
      },
    });
    const beforeCounts = await Promise.all([
      prisma.capacityReservation.count({ where: { identity: { activityId: fixture.activityId } } }),
      prisma.auditLog.count(),
      prisma.notificationOutboxIntent.count(),
      prisma.activityAllocationCandidate.count(),
    ]);

    await expectReconciliationFailure(
      reserve({
        activityId: fixture.activityId,
        memberId: member.memberId,
        selections: [{ identityId, positionId: fixture.sessions[0].positions[0].id }],
      }),
    );
    await expect(bucketFacts(fixture.activityId)).resolves.toEqual(beforeBuckets);
    await expect(
      prisma.activityParticipationIdentity.findUniqueOrThrow({
        where: { id: identityId },
        select: {
          currentRevision: true,
          currentStatusCode: true,
          currentPositionId: true,
          capacityReservationId: true,
          populationIncluded: true,
          version: true,
        },
      }),
    ).resolves.toEqual(beforeIdentity);
    await expect(
      Promise.all([
        prisma.capacityReservation.count({
          where: { identity: { activityId: fixture.activityId } },
        }),
        prisma.auditLog.count(),
        prisma.notificationOutboxIntent.count(),
        prisma.activityAllocationCandidate.count(),
      ]),
    ).resolves.toEqual(beforeCounts);
  });

  it('fails closed on a bucket anchored to another activity before creating reservations', async () => {
    const fixture = await createFixture({ positionCapacitiesBySession: [[]] });
    const member = await createMember(fixture, 'wrong-anchor');
    const otherActivity = await prisma.activity.create({
      data: {
        title: `Capacity Reservation Other ${fixture.sequence}`,
        activityTypeCode: 'capacity-reservation',
        organizationId: (
          await prisma.activity.findUniqueOrThrow({
            where: { id: fixture.activityId },
            select: { organizationId: true },
          })
        ).organizationId,
        startAt: FAR.start,
        endAt: FAR.end,
        location: 'capacity reservation wrong anchor fixture',
        statusCode: 'published',
        capacity: 3,
      },
      select: { id: true },
    });
    const activityBucket = await bucketFor(
      fixture.activityId,
      'activity_person',
      fixture.activityId,
    );
    await prisma.activityCapacityBucket.update({
      where: { id: activityBucket.id },
      data: { activityId: otherActivity.id },
    });
    const beforeBuckets = await bucketFacts(otherActivity.id);

    await expectReconciliationFailure(
      reserve({
        activityId: fixture.activityId,
        memberId: member.memberId,
        selections: [{ identityId: identityFor(member, fixture.sessions[0]) }],
      }),
    );
    await expect(
      prisma.capacityReservation.count({ where: { identity: { activityId: fixture.activityId } } }),
    ).resolves.toBe(0);
    await expect(bucketFacts(otherActivity.id)).resolves.toEqual(beforeBuckets);
  });

  it('fails closed on an active session reservation without its required activity-person pair', async () => {
    const fixture = await createFixture({ positionCapacitiesBySession: [[]] });
    const member = await createMember(fixture, 'missing-pair');
    const identityId = identityFor(member, fixture.sessions[0]);
    const sessionBucket = await bucketFor(
      fixture.activityId,
      'session_participation',
      fixture.sessions[0].id,
    );
    await prisma.capacityReservation.create({
      data: {
        identityId,
        bucketId: sessionBucket.id,
        reservationType: 'session_participation',
        status: 'active',
      },
    });
    await prisma.activityCapacityBucket.update({
      where: { id: sessionBucket.id },
      data: { occupied: 1, version: { increment: 1 } },
    });
    const beforeBuckets = await bucketFacts(fixture.activityId);
    const beforeReservations = await prisma.capacityReservation.findMany({
      where: { identity: { activityId: fixture.activityId } },
      select: { id: true, bucketId: true, status: true, updatedAt: true },
      orderBy: { id: 'asc' },
    });

    await expectReconciliationFailure(
      reserve({
        activityId: fixture.activityId,
        memberId: member.memberId,
        selections: [{ identityId }],
      }),
    );
    await expect(bucketFacts(fixture.activityId)).resolves.toEqual(beforeBuckets);
    await expect(
      prisma.capacityReservation.findMany({
        where: { identity: { activityId: fixture.activityId } },
        select: { id: true, bucketId: true, status: true, updatedAt: true },
        orderBy: { id: 'asc' },
      }),
    ).resolves.toEqual(beforeReservations);
  });
});
