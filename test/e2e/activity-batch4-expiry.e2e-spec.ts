import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  BindingScopeType,
  BindingStatus,
  MemberStatus,
  PrincipalType,
  Role,
} from '@prisma/client';
import request from 'supertest';

import { PrismaService } from '../../src/database/prisma.service';
import { ActivityBatchWorker } from '../../src/modules/activities/activity-batch.worker';
import { StorageConsistencyWorkerModule } from '../../src/modules/attachments/storage-consistency-worker.module';
import { NotificationOutboxWorkerModule } from '../../src/modules/notifications/notification-outbox-worker.module';
import { loginAs } from '../fixtures/auth.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const FUTURE_START = new Date('2099-12-15T08:00:00.000Z');
const FUTURE_END = new Date('2099-12-15T12:00:00.000Z');
const PAST_START = new Date('2020-01-01T08:00:00.000Z');
const PAST_END = new Date('2020-01-01T12:00:00.000Z');

interface AppActor {
  id: string;
  memberId: string;
  authHeader: string;
}

interface Scenario {
  activityId: string;
  sessionId: string;
  positionId: string;
}

describe('activity batch4 expiry', () => {
  let app: INestApplication;
  let notificationContext: INestApplicationContext;
  let storageContext: INestApplicationContext;
  let prisma: PrismaService;
  let notificationPrisma: PrismaService;
  let storagePrisma: PrismaService;
  let notificationWorker: ActivityBatchWorker;
  let storageWorker: ActivityBatchWorker;
  let manager: AppActor;
  let activityOwnerRoleId: string;
  let sequence = 0;

  beforeAll(async () => {
    jest.setTimeout(90_000);
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    activityOwnerRoleId = (await seedActivityResponsibilitySystemRoles(app))['activity-owner'];
    manager = await createActor('expiry-manager', Role.USER);

    // 这两个 context 就是生产中已经存在的两个 worker 入口；本刀不能另建 cron 或进程。
    notificationContext = await NestFactory.createApplicationContext(
      NotificationOutboxWorkerModule,
      { logger: false },
    );
    storageContext = await NestFactory.createApplicationContext(StorageConsistencyWorkerModule, {
      logger: false,
    });
    notificationWorker = notificationContext.get(ActivityBatchWorker);
    storageWorker = storageContext.get(ActivityBatchWorker);
    notificationPrisma = notificationContext.get(PrismaService);
    storagePrisma = storageContext.get(PrismaService);
  });

  afterAll(async () => {
    await Promise.all([storageContext.close(), notificationContext.close(), app.close()]);
  });

  async function createActor(label: string, role: Role): Promise<AppActor> {
    const suffix = `${label}-${++sequence}`;
    // Login DTO caps usernames at 32 characters; memberNo/displayName retain the descriptive label.
    const user = await createTestUser(app, { username: `b4e-${sequence}`, role });
    const member = await prisma.member.create({
      data: {
        memberNo: `B4-${suffix.toUpperCase()}`,
        displayName: `Batch4 ${label}`,
        gradeCode: 'L1',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    return { id: user.id, memberId: member.id, authHeader: (await loginAs(app, user.username)).authHeader };
  }

  async function createScenario(
    allocationModeCode: 'first_come' | 'qualification_rank',
  ): Promise<Scenario> {
    const index = ++sequence;
    const organization = await prisma.organization.create({
      data: { name: `Batch4 Expiry Team ${index}`, nodeTypeCode: 'batch4-expiry-team' },
      select: { id: true },
    });
    const activity = await prisma.activity.create({
      data: {
        title: `Batch4 Expiry Activity ${index}`,
        activityTypeCode: 'training',
        organizationId: organization.id,
        startAt: FUTURE_START,
        endAt: FUTURE_END,
        registrationDeadline: new Date('2099-12-14T23:59:59.000Z'),
        location: 'Expiry Field',
        statusCode: 'published',
        publishedAt: new Date(),
        isPublicRegistration: true,
        capacity: 1,
        allocationModeCode,
      },
      select: { id: true },
    });
    const session = await prisma.activitySession.create({
      data: {
        activityId: activity.id,
        code: `expiry-session-${index}`,
        name: `Expiry Session ${index}`,
        startAt: FUTURE_START,
        endAt: FUTURE_END,
        locationText: 'Expiry Field',
        capacity: 1,
        checkInOpenAt: new Date(FUTURE_START.getTime() - 30 * 60_000),
        checkInCloseAt: new Date(FUTURE_START.getTime() + 30 * 60_000),
        checkOutOpenAt: new Date(FUTURE_END.getTime() - 60 * 60_000),
        checkOutCloseAt: new Date(FUTURE_END.getTime() + 30 * 60_000),
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
        code: `expiry-position-${index}`,
        name: `Expiry Position ${index}`,
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
        note: `batch4 expiry fixture ${index}`,
      },
    });
    return { activityId: activity.id, sessionId: session.id, positionId: position.id };
  }

  async function submit(scenario: Scenario, actor: AppActor, operationKey: string) {
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

  async function moveActivityStartToPast(scenario: Scenario): Promise<void> {
    // 真实报名／邀请均已走 HTTP；此处只把测试时钟推进到活动已经开始的客观事实。
    await prisma.$transaction(async (tx) => {
      await tx.activity.update({
        where: { id: scenario.activityId },
        data: { startAt: PAST_START, endAt: PAST_END },
      });
      await tx.activitySession.update({
        where: { id: scenario.sessionId },
        data: {
          startAt: PAST_START,
          endAt: PAST_END,
          checkInOpenAt: new Date(PAST_START.getTime() - 30 * 60_000),
          checkInCloseAt: new Date(PAST_START.getTime() + 30 * 60_000),
          checkOutOpenAt: new Date(PAST_END.getTime() - 60 * 60_000),
          checkOutCloseAt: new Date(PAST_END.getTime() + 30 * 60_000),
        },
      });
    });
  }

  it('proves expiry workers use independent PostgreSQL pools', async () => {
    expect(notificationPrisma).not.toBe(storagePrisma);
    const [[left], [right]] = await Promise.all([
      notificationPrisma.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
      storagePrisma.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
    ]);
    expect(left?.pid).not.toBe(right?.pid);
  });

  it('red-first: activity start expires a canonical pending identity and a pending invitation', async () => {
    const scenario = await createScenario('qualification_rank');
    const applicant = await createActor('expiry-pending-applicant', Role.USER);
    const invitee = await createActor('expiry-invitee', Role.USER);
    const submitted = await submit(scenario, applicant, `expiry-pending-submit-${sequence}`);
    expect(submitted.status).toBe(201);
    const registrationId = submitted.body.data.registrationId as string;

    const createdInvitation = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${scenario.activityId}/invitations`)
      .set('Authorization', manager.authHeader)
      .send({
        memberId: invitee.memberId,
        sessionId: scenario.sessionId,
        positionId: scenario.positionId,
        expiresAt: '2099-12-31T23:59:59.000Z',
      });
    expect(createdInvitation.status).toBe(201);
    const invitationId = createdInvitation.body.data.invitationId as string;

    await moveActivityStartToPast(scenario);
    const rounds = await notificationWorker.drainUntilIdle(4);
    expect(rounds.some((round) => round.jobClaimed)).toBe(true);

    const [identity, revision, header, invitation] = await Promise.all([
      prisma.activityParticipationIdentity.findFirstOrThrow({
        where: { registrationId, sessionId: scenario.sessionId },
        select: {
          currentRevision: true,
          currentStatusCode: true,
          currentPositionId: true,
          capacityReservationId: true,
          populationIncluded: true,
        },
      }),
      prisma.activityParticipationRevision.findFirstOrThrow({
        where: { identity: { registrationId }, revision: 2 },
        select: {
          statusCode: true,
          positionId: true,
          sourceCode: true,
          createdByUserId: true,
        },
      }),
      prisma.activityRegistration.findUniqueOrThrow({
        where: { id: registrationId },
        select: { statusCode: true, statusSummaryCode: true },
      }),
      prisma.activityInvitation.findUniqueOrThrow({
        where: { id: invitationId },
        select: { statusCode: true, respondedAt: true },
      }),
    ]);
    expect(identity).toEqual({
      currentRevision: 2,
      currentStatusCode: 'review_expired',
      currentPositionId: null,
      capacityReservationId: null,
      populationIncluded: false,
    });
    expect(revision).toEqual({
      statusCode: 'review_expired',
      positionId: null,
      sourceCode: 'system',
      createdByUserId: null,
    });
    expect(header).toEqual({ statusCode: 'reject', statusSummaryCode: 'expired' });
    expect(invitation).toEqual({ statusCode: 'expired', respondedAt: null });
  });

  it('red-first: activity start expires only the first_come waitlist and preserves an occupied pass', async () => {
    const scenario = await createScenario('first_come');
    const accepted = await createActor('expiry-first-come-accepted', Role.USER);
    const waitlisted = await createActor('expiry-first-come-waitlisted', Role.USER);
    const acceptedSubmission = await submit(
      scenario,
      accepted,
      `expiry-first-come-accepted-${sequence}`,
    );
    const waitlistedSubmission = await submit(
      scenario,
      waitlisted,
      `expiry-first-come-waitlisted-${sequence}`,
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
        select: { currentStatusCode: true, capacityReservationId: true, populationIncluded: true },
      }),
    ).resolves.toEqual({
      currentStatusCode: 'waitlisted',
      capacityReservationId: null,
      populationIncluded: false,
    });

    await moveActivityStartToPast(scenario);
    const rounds = await storageWorker.drainUntilIdle(4);
    expect(rounds.some((round) => round.jobClaimed)).toBe(true);

    const [acceptedIdentity, waitlistedIdentity, waitlistedRevision, activeReservations, header] =
      await Promise.all([
        prisma.activityParticipationIdentity.findFirstOrThrow({
          where: { registrationId: acceptedRegistrationId },
          select: { currentStatusCode: true, capacityReservationId: true, populationIncluded: true },
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
          select: { statusCode: true, sourceCode: true },
        }),
        prisma.capacityReservation.count({
          where: { identity: { registrationId: acceptedRegistrationId }, status: 'active' },
        }),
        prisma.activityRegistration.findUniqueOrThrow({
          where: { id: waitlistedRegistrationId },
          select: { statusCode: true, statusSummaryCode: true },
        }),
      ]);
    expect(acceptedIdentity).toEqual({
      currentStatusCode: 'pass',
      capacityReservationId: expect.any(String),
      populationIncluded: true,
    });
    expect(waitlistedIdentity).toEqual({
      currentRevision: 3,
      currentStatusCode: 'waitlist_expired',
      currentPositionId: null,
      capacityReservationId: null,
      populationIncluded: false,
    });
    expect(waitlistedRevision).toEqual({ statusCode: 'waitlist_expired', sourceCode: 'system' });
    expect(activeReservations).toBe(3);
    expect(header).toEqual({ statusCode: 'reject', statusSummaryCode: 'expired' });
  });

  it('red-first: two worker pools serialize the same due reconciliation job and do not append twice', async () => {
    const scenario = await createScenario('qualification_rank');
    const applicant = await createActor('expiry-concurrent-applicant', Role.USER);
    const submitted = await submit(scenario, applicant, `expiry-concurrent-submit-${sequence}`);
    expect(submitted.status).toBe(201);
    const registrationId = submitted.body.data.registrationId as string;
    await moveActivityStartToPast(scenario);

    const rounds = await Promise.all([notificationWorker.drainOnce(), storageWorker.drainOnce()]);
    expect(rounds.filter((round) => round.jobClaimed).length).toBe(1);
    await storageWorker.drainUntilIdle(3);

    await expect(
      prisma.activityParticipationRevision.count({ where: { identity: { registrationId } } }),
    ).resolves.toBe(2);
    await expect(
      prisma.activityBatchJob.findMany({
        where: { activityId: scenario.activityId, jobTypeCode: 'reconciliation' },
        select: { statusCode: true },
      }),
    ).resolves.toEqual([{ statusCode: 'succeeded' }]);
  });
});
