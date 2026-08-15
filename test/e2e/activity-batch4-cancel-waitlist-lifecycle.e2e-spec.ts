import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, BindingStatus, MemberStatus, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const START_AT = new Date('2099-12-15T08:00:00.000Z');
const END_AT = new Date('2099-12-15T12:00:00.000Z');

interface Actor {
  id: string;
  memberId: string;
  authHeader: string;
}

interface Scenario {
  activityId: string;
  sessionId: string;
  positionId: string;
}

describe('activity batch4 whole-cancel canonical lifecycle', () => {
  let app: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;
  let prismaB: PrismaService;
  let manager: Actor;
  let activityOwnerRoleId: string;
  let sequence = 0;

  beforeAll(async () => {
    jest.setTimeout(90_000);
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    appB = await createTestApp();
    prismaB = appB.get(PrismaService);
    activityOwnerRoleId = (await seedActivityResponsibilitySystemRoles(app))['activity-owner'];
    manager = await createActor('manager');
  });

  afterAll(async () => {
    await Promise.all([appB.close(), app.close()]);
  });

  async function createActor(label: string): Promise<Actor> {
    const suffix = `${label}-${++sequence}`;
    const user = await createTestUser(app, { username: `b4c-${sequence}`, role: Role.USER });
    const member = await prisma.member.create({
      data: {
        memberNo: `B4-CANCEL-${suffix.toUpperCase()}`,
        displayName: `Batch4 cancel ${label}`,
        gradeCode: 'L1',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    return {
      id: user.id,
      memberId: member.id,
      authHeader: (await loginAs(app, user.username)).authHeader,
    };
  }

  async function createScenario(input?: { activityCapacity?: number }): Promise<Scenario> {
    const index = ++sequence;
    // 拓扑 fixture 可以直写；两位报名者和活动取消均必须经过生产 HTTP 路径。
    const organization = await prisma.organization.create({
      data: { name: `Batch4 cancel team ${index}`, nodeTypeCode: 'batch4-cancel-team' },
      select: { id: true },
    });
    const activity = await prisma.activity.create({
      data: {
        title: `Batch4 cancel activity ${index}`,
        activityTypeCode: 'training',
        organizationId: organization.id,
        startAt: START_AT,
        endAt: END_AT,
        registrationDeadline: new Date('2099-12-14T23:59:59.000Z'),
        location: 'Cancel field',
        statusCode: 'published',
        publishedAt: new Date(),
        isPublicRegistration: true,
        capacity: input?.activityCapacity ?? 1,
        allocationModeCode: 'first_come',
      },
      select: { id: true },
    });
    const session = await prisma.activitySession.create({
      data: {
        activityId: activity.id,
        code: `cancel-session-${index}`,
        name: `Cancel session ${index}`,
        startAt: START_AT,
        endAt: END_AT,
        locationText: 'Cancel field',
        capacity: 1,
        checkInOpenAt: new Date(START_AT.getTime() - 30 * 60_000),
        checkInCloseAt: new Date(START_AT.getTime() + 30 * 60_000),
        checkOutOpenAt: new Date(END_AT.getTime() - 60 * 60_000),
        checkOutCloseAt: new Date(END_AT.getTime() + 30 * 60_000),
        locationRequired: false,
        locationPolicySourceCode: 'activity',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });
    const position = await prisma.activitySessionPosition.create({
      data: {
        activityId: activity.id,
        sessionId: session.id,
        code: `cancel-position-${index}`,
        name: `Cancel position ${index}`,
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
          capacity: input?.activityCapacity ?? 1,
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
        memberId: manager.memberId,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: manager.id,
        source: 'publish',
      },
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.MEMBER,
        principalId: manager.memberId,
        roleId: activityOwnerRoleId,
        scopeType: BindingScopeType.ACTIVITY,
        scopeActivityId: activity.id,
        status: BindingStatus.ACTIVE,
        note: `batch4 cancel fixture ${index}`,
      },
    });
    return { activityId: activity.id, sessionId: session.id, positionId: position.id };
  }

  async function createLegacyScenario(): Promise<{ activityId: string }> {
    const index = ++sequence;
    const organization = await prisma.organization.create({
      data: {
        name: `Batch4 legacy cancel team ${index}`,
        nodeTypeCode: 'batch4-legacy-cancel-team',
      },
      select: { id: true },
    });
    const activity = await prisma.activity.create({
      data: {
        title: `Batch4 legacy cancel activity ${index}`,
        activityTypeCode: 'training',
        organizationId: organization.id,
        startAt: START_AT,
        endAt: END_AT,
        location: 'Legacy cancel field',
        statusCode: 'published',
        publishedAt: new Date(),
        isPublicRegistration: true,
        capacity: 1,
        allocationModeCode: 'first_come',
      },
      select: { id: true },
    });
    await prisma.activityEvidenceState.create({ data: { activityId: activity.id } });
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: activity.id,
        memberId: manager.memberId,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: manager.id,
        source: 'publish',
      },
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.MEMBER,
        principalId: manager.memberId,
        roleId: activityOwnerRoleId,
        scopeType: BindingScopeType.ACTIVITY,
        scopeActivityId: activity.id,
        status: BindingStatus.ACTIVE,
        note: `batch4 legacy cancel fixture ${index}`,
      },
    });
    return { activityId: activity.id };
  }

  async function createAdditionalSession(scenario: Scenario): Promise<{
    sessionId: string;
    positionId: string;
  }> {
    const index = ++sequence;
    const session = await prisma.activitySession.create({
      data: {
        activityId: scenario.activityId,
        code: `cancel-secondary-session-${index}`,
        name: `Cancel secondary session ${index}`,
        startAt: START_AT,
        endAt: END_AT,
        locationText: 'Cancel secondary field',
        capacity: 1,
        checkInOpenAt: new Date(START_AT.getTime() - 30 * 60_000),
        checkInCloseAt: new Date(START_AT.getTime() + 30 * 60_000),
        checkOutOpenAt: new Date(END_AT.getTime() - 60 * 60_000),
        checkOutCloseAt: new Date(END_AT.getTime() + 30 * 60_000),
        locationRequired: false,
        locationPolicySourceCode: 'activity',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });
    const position = await prisma.activitySessionPosition.create({
      data: {
        activityId: scenario.activityId,
        sessionId: session.id,
        code: `cancel-secondary-position-${index}`,
        name: `Cancel secondary position ${index}`,
        attendanceRoleCode: 'volunteer',
        capacity: 1,
      },
      select: { id: true },
    });
    await prisma.activityCapacityBucket.createMany({
      data: [
        {
          activityId: scenario.activityId,
          scopeTypeCode: 'session_participation',
          scopeId: session.id,
          capacity: 1,
        },
        {
          activityId: scenario.activityId,
          scopeTypeCode: 'position_participation',
          scopeId: position.id,
          capacity: 1,
        },
      ],
    });
    return { sessionId: session.id, positionId: position.id };
  }

  async function submit(scenario: Scenario, actor: Actor, operationKey: string) {
    return await request(httpServer(app))
      .post(`/api/app/v1/activities/${scenario.activityId}/registrations`)
      .set('Authorization', actor.authHeader)
      .send({
        operationKey,
        formVersion: null,
        answers: [],
        preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
      });
  }

  function cancelBody(operationKey: string) {
    return { reason: '取消整场活动', strongConfirmed: true, operationKey };
  }

  it('proves cancellation callers use independent PostgreSQL pools', async () => {
    expect(prisma).not.toBe(prismaB);
    const [[left], [right]] = await Promise.all([
      prisma.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
      prismaB.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
    ]);
    expect(left?.pid).not.toBe(right?.pid);
  });

  it('red-first: whole managed cancel closes canonical waitlisted identity but preserves pass capacity', async () => {
    const scenario = await createScenario();
    const accepted = await createActor('accepted');
    const waitlisted = await createActor('waitlisted');
    const acceptedSubmission = await submit(scenario, accepted, `cancel-accepted-${sequence}`);
    const waitlistedSubmission = await submit(
      scenario,
      waitlisted,
      `cancel-waitlisted-${sequence}`,
    );
    expect(acceptedSubmission.status).toBe(201);
    expect(waitlistedSubmission.status).toBe(201);
    const acceptedRegistrationId = acceptedSubmission.body.data.registrationId as string;
    const waitlistedRegistrationId = waitlistedSubmission.body.data.registrationId as string;

    await expect(
      prisma.activityParticipationIdentity.findFirstOrThrow({
        where: { registrationId: acceptedRegistrationId },
        select: { currentStatusCode: true, capacityReservationId: true, populationIncluded: true },
      }),
    ).resolves.toEqual({
      currentStatusCode: 'pass',
      capacityReservationId: expect.any(String),
      populationIncluded: true,
    });
    await expect(
      prisma.activityParticipationIdentity.findFirstOrThrow({
        where: { registrationId: waitlistedRegistrationId },
        select: { currentRevision: true, currentStatusCode: true, capacityReservationId: true },
      }),
    ).resolves.toEqual({
      currentRevision: 2,
      currentStatusCode: 'waitlisted',
      capacityReservationId: null,
    });

    const cancelled = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${scenario.activityId}/cancel`)
      .set('Authorization', manager.authHeader)
      .send(cancelBody(`cancel-whole-${sequence}`));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data).toMatchObject({
      activityId: scenario.activityId,
      statusCode: 'cancelled',
      reason: '取消整场活动',
    });

    const [activity, acceptedIdentity, waitlistedIdentity, waitlistedRevision, waitlistedHeader] =
      await Promise.all([
        prisma.activity.findUniqueOrThrow({
          where: { id: scenario.activityId },
          select: { statusCode: true },
        }),
        prisma.activityParticipationIdentity.findFirstOrThrow({
          where: { registrationId: acceptedRegistrationId },
          select: {
            currentStatusCode: true,
            capacityReservationId: true,
            populationIncluded: true,
          },
        }),
        prisma.activityParticipationIdentity.findFirstOrThrow({
          where: { registrationId: waitlistedRegistrationId },
          select: {
            currentRevision: true,
            currentStatusCode: true,
            currentPositionId: true,
            capacityReservationId: true,
            populationIncluded: true,
          },
        }),
        prisma.activityParticipationRevision.findFirstOrThrow({
          where: { identity: { registrationId: waitlistedRegistrationId }, revision: 3 },
          select: { statusCode: true, sourceCode: true, createdByUserId: true },
        }),
        prisma.activityRegistration.findUniqueOrThrow({
          where: { id: waitlistedRegistrationId },
          select: { statusCode: true, statusSummaryCode: true, currentRevision: true },
        }),
      ]);
    expect(activity).toEqual({ statusCode: 'cancelled' });
    expect(acceptedIdentity).toEqual({
      currentStatusCode: 'pass',
      capacityReservationId: expect.any(String),
      populationIncluded: true,
    });
    expect(waitlistedIdentity).toEqual({
      currentRevision: 3,
      currentStatusCode: 'cancelled',
      currentPositionId: null,
      capacityReservationId: null,
      populationIncluded: false,
    });
    expect(waitlistedRevision).toEqual({
      statusCode: 'cancelled',
      sourceCode: 'admin',
      createdByUserId: manager.id,
    });
    expect(waitlistedHeader).toEqual({
      statusCode: 'cancelled',
      statusSummaryCode: 'cancelled',
      currentRevision: 2,
    });
  });

  it('red-first: whole cancel closes only the unresolved identity of a mixed pass/waitlisted header', async () => {
    const scenario = await createScenario({ activityCapacity: 2 });
    const secondary = await createAdditionalSession(scenario);
    const first = await createActor('mixed-first');
    const mixed = await createActor('mixed-applicant');
    expect(await submit(scenario, first, `cancel-mixed-first-${sequence}`)).toMatchObject({
      status: 201,
    });
    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/activities/${scenario.activityId}/registrations`)
      .set('Authorization', mixed.authHeader)
      .send({
        operationKey: `cancel-mixed-submit-${sequence}`,
        formVersion: null,
        answers: [],
        preferences: [
          { sessionId: scenario.sessionId, positionIds: [scenario.positionId] },
          { sessionId: secondary.sessionId, positionIds: [secondary.positionId] },
        ],
      });
    expect(submitted.status).toBe(201);
    const registrationId = submitted.body.data.registrationId as string;

    const before = await prisma.activityParticipationIdentity.findMany({
      where: { registrationId },
      select: { sessionId: true, currentStatusCode: true },
    });
    expect(
      new Map(before.map((identity) => [identity.sessionId, identity.currentStatusCode])),
    ).toEqual(
      new Map([
        [scenario.sessionId, 'waitlisted'],
        [secondary.sessionId, 'pass'],
      ]),
    );

    const cancelled = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${scenario.activityId}/cancel`)
      .set('Authorization', manager.authHeader)
      .send(cancelBody(`cancel-mixed-whole-${sequence}`));
    expect(cancelled.status).toBe(200);

    const [identities, header, revision] = await Promise.all([
      prisma.activityParticipationIdentity.findMany({
        where: { registrationId },
        select: {
          sessionId: true,
          currentStatusCode: true,
          currentPositionId: true,
          capacityReservationId: true,
          populationIncluded: true,
        },
      }),
      prisma.activityRegistration.findUniqueOrThrow({
        where: { id: registrationId },
        select: {
          statusCode: true,
          statusSummaryCode: true,
          currentRevision: true,
          cancelledAt: true,
        },
      }),
      prisma.activityRegistrationRevision.findFirstOrThrow({
        where: { registrationId, revision: 2 },
        select: { sourceCode: true, reason: true },
      }),
    ]);
    const bySession = new Map(identities.map((identity) => [identity.sessionId, identity]));
    expect(bySession.get(scenario.sessionId)).toEqual({
      sessionId: scenario.sessionId,
      currentStatusCode: 'cancelled',
      currentPositionId: null,
      capacityReservationId: null,
      populationIncluded: false,
    });
    expect(bySession.get(secondary.sessionId)).toEqual({
      sessionId: secondary.sessionId,
      currentStatusCode: 'pass',
      currentPositionId: secondary.positionId,
      capacityReservationId: expect.any(String),
      populationIncluded: true,
    });
    expect(header).toEqual({
      statusCode: 'pass',
      statusSummaryCode: 'active',
      currentRevision: 2,
      cancelledAt: null,
    });
    expect(revision).toEqual({ sourceCode: 'admin', reason: '活动已取消' });
  });

  it('closes a revisioned no-identity legacy header without treating it as canonical', async () => {
    const { activityId } = await createLegacyScenario();
    const applicant = await createActor('legacy-header');
    const submitted = await request(httpServer(app))
      .post('/api/app/v1/my/registrations')
      .set('Authorization', applicant.authHeader)
      .send({ activityId });
    expect(submitted.status).toBe(201);
    const registrationId = submitted.body.data.id as string;

    await expect(
      prisma.activityRegistration.findUniqueOrThrow({
        where: { id: registrationId },
        select: {
          currentRevision: true,
          statusCode: true,
          participationIdentities: { select: { id: true } },
        },
      }),
    ).resolves.toEqual({
      currentRevision: 1,
      statusCode: 'pending',
      participationIdentities: [],
    });

    const cancelled = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/cancel`)
      .set('Authorization', manager.authHeader)
      .send(cancelBody(`cancel-legacy-whole-${sequence}`));
    expect(cancelled.status).toBe(200);

    await expect(
      prisma.activityRegistration.findUniqueOrThrow({
        where: { id: registrationId },
        select: {
          statusCode: true,
          statusSummaryCode: true,
          currentRevision: true,
          revisions: {
            select: { revision: true, sourceCode: true, reason: true },
            orderBy: { revision: 'asc' },
          },
          participationIdentities: { select: { id: true } },
        },
      }),
    ).resolves.toEqual({
      statusCode: 'cancelled',
      statusSummaryCode: 'cancelled',
      currentRevision: 2,
      revisions: [
        { revision: 1, sourceCode: 'self', reason: null },
        { revision: 2, sourceCode: 'admin', reason: '活动已取消' },
      ],
      participationIdentities: [],
    });
  });

  it('fails closed with zero lifecycle writes when an unresolved identity projection has drifted', async () => {
    const scenario = await createScenario();
    const accepted = await createActor('drift-accepted');
    const waitlisted = await createActor('drift-waitlisted');
    const acceptedSubmission = await submit(
      scenario,
      accepted,
      `cancel-drift-accepted-${sequence}`,
    );
    const waitlistedSubmission = await submit(
      scenario,
      waitlisted,
      `cancel-drift-waitlisted-${sequence}`,
    );
    expect(acceptedSubmission.status).toBe(201);
    expect(waitlistedSubmission.status).toBe(201);
    const registrationId = waitlistedSubmission.body.data.registrationId as string;
    const identity = await prisma.activityParticipationIdentity.findFirstOrThrow({
      where: { registrationId },
      select: { id: true },
    });
    // 对抗性 PostgreSQL mutation：它不是业务搭桥，只验证服务在已损坏 projection 前整事务零写。
    await prisma.activityParticipationIdentity.update({
      where: { id: identity.id },
      data: { populationIncluded: true },
    });
    const [revisionCountBefore, headerBefore] = await Promise.all([
      prisma.activityParticipationRevision.count({ where: { identityId: identity.id } }),
      prisma.activityRegistration.findUniqueOrThrow({
        where: { id: registrationId },
        select: { statusCode: true, currentRevision: true },
      }),
    ]);

    const failed = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${scenario.activityId}/cancel`)
      .set('Authorization', manager.authHeader)
      .send(cancelBody(`cancel-drift-whole-${sequence}`));
    expect(failed.status).toBe(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.httpStatus);
    expect(failed.body.code).toBe(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.code);

    const [activity, identityAfter, revisionCountAfter, headerAfter] = await Promise.all([
      prisma.activity.findUniqueOrThrow({
        where: { id: scenario.activityId },
        select: { statusCode: true },
      }),
      prisma.activityParticipationIdentity.findUniqueOrThrow({
        where: { id: identity.id },
        select: { currentRevision: true, currentStatusCode: true, populationIncluded: true },
      }),
      prisma.activityParticipationRevision.count({ where: { identityId: identity.id } }),
      prisma.activityRegistration.findUniqueOrThrow({
        where: { id: registrationId },
        select: { statusCode: true, currentRevision: true },
      }),
    ]);
    expect(activity).toEqual({ statusCode: 'published' });
    expect(identityAfter).toEqual({
      currentRevision: 2,
      currentStatusCode: 'waitlisted',
      populationIncluded: true,
    });
    expect(revisionCountAfter).toBe(revisionCountBefore);
    expect(headerAfter).toEqual(headerBefore);
  });

  it('fails closed with zero lifecycle writes when a preserved pass projection has drifted', async () => {
    const scenario = await createScenario();
    const accepted = await createActor('preserved-pass-drift-accepted');
    const waitlisted = await createActor('preserved-pass-drift-waitlisted');
    const acceptedSubmission = await submit(
      scenario,
      accepted,
      `cancel-preserved-pass-drift-accepted-${sequence}`,
    );
    const waitlistedSubmission = await submit(
      scenario,
      waitlisted,
      `cancel-preserved-pass-drift-waitlisted-${sequence}`,
    );
    expect(acceptedSubmission.status).toBe(201);
    expect(waitlistedSubmission.status).toBe(201);
    const acceptedRegistrationId = acceptedSubmission.body.data.registrationId as string;
    const waitlistedRegistrationId = waitlistedSubmission.body.data.registrationId as string;
    const acceptedIdentity = await prisma.activityParticipationIdentity.findFirstOrThrow({
      where: { registrationId: acceptedRegistrationId },
      select: { id: true },
    });
    // 对抗性 PostgreSQL mutation：保留 pass 的 population projection 若已漂移，整单取消
    // 不能只关闭另一头的候补而把已损坏的 active capacity fact 留在 cancelled activity。
    await prisma.activityParticipationIdentity.update({
      where: { id: acceptedIdentity.id },
      data: { populationIncluded: false },
    });
    const [activityBefore, acceptedHeaderBefore, waitlistedHeaderBefore, identityCountsBefore] =
      await Promise.all([
        prisma.activity.findUniqueOrThrow({
          where: { id: scenario.activityId },
          select: { statusCode: true },
        }),
        prisma.activityRegistration.findUniqueOrThrow({
          where: { id: acceptedRegistrationId },
          select: { statusCode: true, currentRevision: true },
        }),
        prisma.activityRegistration.findUniqueOrThrow({
          where: { id: waitlistedRegistrationId },
          select: { statusCode: true, currentRevision: true },
        }),
        Promise.all([
          prisma.activityParticipationRevision.count({
            where: { identityId: acceptedIdentity.id },
          }),
          prisma.activityRegistrationRevision.count({
            where: { registrationId: acceptedRegistrationId },
          }),
          prisma.activityRegistrationRevision.count({
            where: { registrationId: waitlistedRegistrationId },
          }),
        ]),
      ]);

    const failed = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${scenario.activityId}/cancel`)
      .set('Authorization', manager.authHeader)
      .send(cancelBody(`cancel-preserved-pass-drift-whole-${sequence}`));
    expect(failed.status).toBe(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.httpStatus);
    expect(failed.body.code).toBe(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.code);

    const [
      activityAfter,
      acceptedHeaderAfter,
      waitlistedHeaderAfter,
      acceptedIdentityAfter,
      identityCountsAfter,
    ] = await Promise.all([
      prisma.activity.findUniqueOrThrow({
        where: { id: scenario.activityId },
        select: { statusCode: true },
      }),
      prisma.activityRegistration.findUniqueOrThrow({
        where: { id: acceptedRegistrationId },
        select: { statusCode: true, currentRevision: true },
      }),
      prisma.activityRegistration.findUniqueOrThrow({
        where: { id: waitlistedRegistrationId },
        select: { statusCode: true, currentRevision: true },
      }),
      prisma.activityParticipationIdentity.findUniqueOrThrow({
        where: { id: acceptedIdentity.id },
        select: { currentStatusCode: true, populationIncluded: true },
      }),
      Promise.all([
        prisma.activityParticipationRevision.count({ where: { identityId: acceptedIdentity.id } }),
        prisma.activityRegistrationRevision.count({
          where: { registrationId: acceptedRegistrationId },
        }),
        prisma.activityRegistrationRevision.count({
          where: { registrationId: waitlistedRegistrationId },
        }),
      ]),
    ]);
    expect(activityAfter).toEqual(activityBefore);
    expect(acceptedHeaderAfter).toEqual(acceptedHeaderBefore);
    expect(waitlistedHeaderAfter).toEqual(waitlistedHeaderBefore);
    expect(acceptedIdentityAfter).toEqual({ currentStatusCode: 'pass', populationIncluded: false });
    expect(identityCountsAfter).toEqual(identityCountsBefore);
  });

  it('fails closed with zero lifecycle writes when a preserved pass position pointer has drifted', async () => {
    const scenario = await createScenario();
    const accepted = await createActor('pass-position-drift-accepted');
    const waitlisted = await createActor('pass-position-drift-waitlisted');
    const acceptedSubmission = await submit(
      scenario,
      accepted,
      `cancel-pass-position-drift-accepted-${sequence}`,
    );
    const waitlistedSubmission = await submit(
      scenario,
      waitlisted,
      `cancel-pass-position-drift-waitlisted-${sequence}`,
    );
    expect(acceptedSubmission.status).toBe(201);
    expect(waitlistedSubmission.status).toBe(201);
    const acceptedRegistrationId = acceptedSubmission.body.data.registrationId as string;
    const waitlistedRegistrationId = waitlistedSubmission.body.data.registrationId as string;
    const acceptedIdentity = await prisma.activityParticipationIdentity.findFirstOrThrow({
      where: { registrationId: acceptedRegistrationId },
      select: { id: true, currentRevision: true },
    });

    // 对抗性 PostgreSQL mutation：保留 session pointer 及 immutable status，仅摘掉 pass 的
    // current/revision position pointer；若仍有 active position reservation，整单取消必须零写。
    await prisma.$transaction([
      prisma.activityParticipationRevision.updateMany({
        where: { identityId: acceptedIdentity.id, revision: acceptedIdentity.currentRevision },
        data: { positionId: null },
      }),
      prisma.activityParticipationIdentity.update({
        where: { id: acceptedIdentity.id },
        data: { currentPositionId: null },
      }),
    ]);
    const [activityBefore, acceptedHeaderBefore, waitlistedHeaderBefore, revisionCountsBefore] =
      await Promise.all([
        prisma.activity.findUniqueOrThrow({
          where: { id: scenario.activityId },
          select: { statusCode: true },
        }),
        prisma.activityRegistration.findUniqueOrThrow({
          where: { id: acceptedRegistrationId },
          select: { statusCode: true, currentRevision: true },
        }),
        prisma.activityRegistration.findUniqueOrThrow({
          where: { id: waitlistedRegistrationId },
          select: { statusCode: true, currentRevision: true },
        }),
        Promise.all([
          prisma.activityParticipationRevision.count({
            where: { identityId: acceptedIdentity.id },
          }),
          prisma.activityRegistrationRevision.count({
            where: { registrationId: acceptedRegistrationId },
          }),
          prisma.activityRegistrationRevision.count({
            where: { registrationId: waitlistedRegistrationId },
          }),
        ]),
      ]);

    const failed = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${scenario.activityId}/cancel`)
      .set('Authorization', manager.authHeader)
      .send(cancelBody(`cancel-pass-position-drift-whole-${sequence}`));
    expect(failed.status).toBe(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.httpStatus);
    expect(failed.body.code).toBe(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.code);

    const [
      activityAfter,
      acceptedHeaderAfter,
      waitlistedHeaderAfter,
      acceptedIdentityAfter,
      revisionCountsAfter,
    ] = await Promise.all([
      prisma.activity.findUniqueOrThrow({
        where: { id: scenario.activityId },
        select: { statusCode: true },
      }),
      prisma.activityRegistration.findUniqueOrThrow({
        where: { id: acceptedRegistrationId },
        select: { statusCode: true, currentRevision: true },
      }),
      prisma.activityRegistration.findUniqueOrThrow({
        where: { id: waitlistedRegistrationId },
        select: { statusCode: true, currentRevision: true },
      }),
      prisma.activityParticipationIdentity.findUniqueOrThrow({
        where: { id: acceptedIdentity.id },
        select: {
          currentStatusCode: true,
          currentPositionId: true,
          capacityReservationId: true,
          populationIncluded: true,
        },
      }),
      Promise.all([
        prisma.activityParticipationRevision.count({ where: { identityId: acceptedIdentity.id } }),
        prisma.activityRegistrationRevision.count({
          where: { registrationId: acceptedRegistrationId },
        }),
        prisma.activityRegistrationRevision.count({
          where: { registrationId: waitlistedRegistrationId },
        }),
      ]),
    ]);
    expect(activityAfter).toEqual(activityBefore);
    expect(acceptedHeaderAfter).toEqual(acceptedHeaderBefore);
    expect(waitlistedHeaderAfter).toEqual(waitlistedHeaderBefore);
    expect(acceptedIdentityAfter).toEqual({
      currentStatusCode: 'pass',
      currentPositionId: null,
      capacityReservationId: expect.any(String),
      populationIncluded: true,
    });
    expect(revisionCountsAfter).toEqual(revisionCountsBefore);
  });

  it('fails closed with zero lifecycle writes when a preserved terminal projection has drifted', async () => {
    const scenario = await createScenario();
    const accepted = await createActor('terminal-drift-accepted');
    const terminal = await createActor('terminal-drift-terminal');
    const candidate = await createActor('terminal-drift-candidate');
    expect(
      await submit(scenario, accepted, `cancel-terminal-drift-accepted-${sequence}`),
    ).toMatchObject({ status: 201 });
    const terminalSubmission = await submit(
      scenario,
      terminal,
      `cancel-terminal-drift-terminal-${sequence}`,
    );
    const candidateSubmission = await submit(
      scenario,
      candidate,
      `cancel-terminal-drift-candidate-${sequence}`,
    );
    expect(terminalSubmission.status).toBe(201);
    expect(candidateSubmission.status).toBe(201);
    const terminalRegistrationId = terminalSubmission.body.data.registrationId as string;
    const candidateRegistrationId = candidateSubmission.body.data.registrationId as string;
    const terminalIdentity = await prisma.activityParticipationIdentity.findFirstOrThrow({
      where: { registrationId: terminalRegistrationId },
      select: { id: true, currentRevision: true },
    });

    // 对抗性 PostgreSQL mutation：保持 immutable revision/header status 一致，仅让一个已经
    // reject 的 identity 留下 population，从而验证整单取消不应忽略任何保留终态的 projection 漂移。
    await prisma.$transaction([
      prisma.activityParticipationRevision.updateMany({
        where: { identityId: terminalIdentity.id, revision: terminalIdentity.currentRevision },
        data: { statusCode: 'rejected' },
      }),
      prisma.activityParticipationIdentity.update({
        where: { id: terminalIdentity.id },
        data: { currentStatusCode: 'rejected', populationIncluded: true },
      }),
      prisma.activityRegistration.update({
        where: { id: terminalRegistrationId },
        data: { statusCode: 'reject', statusSummaryCode: 'not_selected' },
      }),
    ]);
    const [activityBefore, terminalHeaderBefore, candidateHeaderBefore, revisionCountsBefore] =
      await Promise.all([
        prisma.activity.findUniqueOrThrow({
          where: { id: scenario.activityId },
          select: { statusCode: true },
        }),
        prisma.activityRegistration.findUniqueOrThrow({
          where: { id: terminalRegistrationId },
          select: { statusCode: true, statusSummaryCode: true, currentRevision: true },
        }),
        prisma.activityRegistration.findUniqueOrThrow({
          where: { id: candidateRegistrationId },
          select: { statusCode: true, statusSummaryCode: true, currentRevision: true },
        }),
        Promise.all([
          prisma.activityParticipationRevision.count({
            where: { identityId: terminalIdentity.id },
          }),
          prisma.activityRegistrationRevision.count({
            where: { registrationId: terminalRegistrationId },
          }),
          prisma.activityRegistrationRevision.count({
            where: { registrationId: candidateRegistrationId },
          }),
        ]),
      ]);

    const failed = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${scenario.activityId}/cancel`)
      .set('Authorization', manager.authHeader)
      .send(cancelBody(`cancel-terminal-drift-whole-${sequence}`));
    expect(failed.status).toBe(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.httpStatus);
    expect(failed.body.code).toBe(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.code);

    const [
      activityAfter,
      terminalHeaderAfter,
      candidateHeaderAfter,
      terminalIdentityAfter,
      revisionCountsAfter,
    ] = await Promise.all([
      prisma.activity.findUniqueOrThrow({
        where: { id: scenario.activityId },
        select: { statusCode: true },
      }),
      prisma.activityRegistration.findUniqueOrThrow({
        where: { id: terminalRegistrationId },
        select: { statusCode: true, statusSummaryCode: true, currentRevision: true },
      }),
      prisma.activityRegistration.findUniqueOrThrow({
        where: { id: candidateRegistrationId },
        select: { statusCode: true, statusSummaryCode: true, currentRevision: true },
      }),
      prisma.activityParticipationIdentity.findUniqueOrThrow({
        where: { id: terminalIdentity.id },
        select: { currentStatusCode: true, populationIncluded: true },
      }),
      Promise.all([
        prisma.activityParticipationRevision.count({ where: { identityId: terminalIdentity.id } }),
        prisma.activityRegistrationRevision.count({
          where: { registrationId: terminalRegistrationId },
        }),
        prisma.activityRegistrationRevision.count({
          where: { registrationId: candidateRegistrationId },
        }),
      ]),
    ]);
    expect(activityAfter).toEqual(activityBefore);
    expect(terminalHeaderAfter).toEqual(terminalHeaderBefore);
    expect(candidateHeaderAfter).toEqual(candidateHeaderBefore);
    expect(terminalIdentityAfter).toEqual({
      currentStatusCode: 'rejected',
      populationIncluded: true,
    });
    expect(revisionCountsAfter).toEqual(revisionCountsBefore);
  });

  it('fails closed when an identity points at a missing current revision', async () => {
    const scenario = await createScenario();
    const accepted = await createActor('missing-revision-accepted');
    const waitlisted = await createActor('missing-revision-waitlisted');
    expect(
      await submit(scenario, accepted, `cancel-missing-revision-accepted-${sequence}`),
    ).toMatchObject({ status: 201 });
    const submitted = await submit(
      scenario,
      waitlisted,
      `cancel-missing-revision-waitlisted-${sequence}`,
    );
    expect(submitted.status).toBe(201);
    const registrationId = submitted.body.data.registrationId as string;
    const identity = await prisma.activityParticipationIdentity.findFirstOrThrow({
      where: { registrationId },
      select: { id: true, currentRevision: true },
    });
    // 对抗性 PostgreSQL mutation：current revision 指针丢失必须整事务 fail-closed，
    // 不能把仍有 permanent identity 的报名误判为旧 header-only bridge。
    await prisma.activityParticipationIdentity.update({
      where: { id: identity.id },
      data: { currentRevision: identity.currentRevision + 100 },
    });
    const [headerBefore, identityBefore, revisionCountBefore] = await Promise.all([
      prisma.activityRegistration.findUniqueOrThrow({
        where: { id: registrationId },
        select: { statusCode: true, currentRevision: true },
      }),
      prisma.activityParticipationIdentity.findUniqueOrThrow({
        where: { id: identity.id },
        select: { currentRevision: true, currentStatusCode: true },
      }),
      prisma.activityParticipationRevision.count({ where: { identityId: identity.id } }),
    ]);

    const failed = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${scenario.activityId}/cancel`)
      .set('Authorization', manager.authHeader)
      .send(cancelBody(`cancel-missing-revision-whole-${sequence}`));
    expect(failed.status).toBe(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.httpStatus);
    expect(failed.body.code).toBe(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.code);

    const [activityAfter, headerAfter, identityAfter, revisionCountAfter] = await Promise.all([
      prisma.activity.findUniqueOrThrow({
        where: { id: scenario.activityId },
        select: { statusCode: true },
      }),
      prisma.activityRegistration.findUniqueOrThrow({
        where: { id: registrationId },
        select: { statusCode: true, currentRevision: true },
      }),
      prisma.activityParticipationIdentity.findUniqueOrThrow({
        where: { id: identity.id },
        select: { currentRevision: true, currentStatusCode: true },
      }),
      prisma.activityParticipationRevision.count({ where: { identityId: identity.id } }),
    ]);
    expect(activityAfter).toEqual({ statusCode: 'published' });
    expect(headerAfter).toEqual(headerBefore);
    expect(identityAfter).toEqual(identityBefore);
    expect(revisionCountAfter).toBe(revisionCountBefore);
  });

  it('serializes a same-key managed cancel across two PostgreSQL pools and appends once', async () => {
    const scenario = await createScenario();
    const accepted = await createActor('concurrent-accepted');
    const waitlisted = await createActor('concurrent-waitlisted');
    const acceptedSubmission = await submit(
      scenario,
      accepted,
      `cancel-concurrent-accepted-${sequence}`,
    );
    const waitlistedSubmission = await submit(
      scenario,
      waitlisted,
      `cancel-concurrent-waitlisted-${sequence}`,
    );
    expect(acceptedSubmission.status).toBe(201);
    expect(waitlistedSubmission.status).toBe(201);
    const registrationId = waitlistedSubmission.body.data.registrationId as string;
    const identity = await prisma.activityParticipationIdentity.findFirstOrThrow({
      where: { registrationId },
      select: { id: true },
    });
    const body = cancelBody(`cancel-concurrent-whole-${sequence}`);

    const [left, right] = await Promise.all([
      request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${scenario.activityId}/cancel`)
        .set('Authorization', manager.authHeader)
        .send(body),
      request(httpServer(appB))
        .post(`/api/app/v1/my/managed-activities/${scenario.activityId}/cancel`)
        .set('Authorization', manager.authHeader)
        .send(body),
    ]);
    expect([left.status, right.status].sort((a, b) => a - b)).toEqual([200, 200]);
    await expect(
      prisma.activityParticipationRevision.count({ where: { identityId: identity.id } }),
    ).resolves.toBe(3);
    await expect(
      prisma.activityRegistrationRevision.count({ where: { registrationId } }),
    ).resolves.toBe(2);
  });
});
