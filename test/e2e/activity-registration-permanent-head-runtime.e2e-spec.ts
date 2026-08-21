import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, BindingStatus, MemberStatus, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

const WINDOW = {
  startAt: new Date('2099-12-20T08:00:00.000Z'),
  endAt: new Date('2099-12-20T12:00:00.000Z'),
};

type Scenario = {
  activityId: string;
  sessionId: string;
  positionId: string;
};

describe('permanent ActivityRegistration runtime', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;
  let managerAuth: string;
  let managerMemberId: string;
  let managerUserId: string;
  let roleIds: Record<string, string>;
  let previousInsuranceGate: string | undefined;
  let sequence = 0;

  beforeAll(async () => {
    jest.setTimeout(120_000);
    previousInsuranceGate = process.env.INSURANCE_ENFORCEMENT_ENABLED;
    process.env.INSURANCE_ENFORCEMENT_ENABLED = 'true';
    appA = await createTestApp();
    await resetDb(appA);
    appB = await createTestApp();
    prisma = appA.get(PrismaService);
    roleIds = await seedActivityResponsibilitySystemRoles(appA);

    const manager = await createTestUser(appA, {
      username: 'permanent-registration-manager',
      role: Role.USER,
    });
    const member = await prisma.member.create({
      data: {
        memberNo: 'PERMANENT-REGISTRATION-MANAGER',
        ...memberIdentityData('Permanent Registration Manager'),
        gradeCode: 'L1',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: manager.id }, data: { memberId: member.id } });
    managerAuth = (await loginAs(appA, manager.username)).authHeader;
    managerMemberId = member.id;
    managerUserId = manager.id;
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close()]);
    if (previousInsuranceGate === undefined) delete process.env.INSURANCE_ENFORCEMENT_ENABLED;
    else process.env.INSURANCE_ENFORCEMENT_ENABLED = previousInsuranceGate;
  });

  async function createScenario(): Promise<Scenario> {
    const index = ++sequence;
    const organization = await prisma.organization.create({
      data: { name: `Permanent registration org ${index}`, nodeTypeCode: 'permanent-reg-org' },
      select: { id: true },
    });
    const activity = await prisma.activity.create({
      data: {
        title: `Permanent registration activity ${index}`,
        activityTypeCode: 'training',
        organizationId: organization.id,
        startAt: WINDOW.startAt,
        endAt: WINDOW.endAt,
        location: 'Permanent registration field',
        statusCode: 'published',
        publishedAt: new Date(),
        capacity: 10,
        requiresInsurance: true,
      },
      select: { id: true },
    });
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
        roleId: roleIds['activity-owner'],
        scopeType: BindingScopeType.ACTIVITY,
        scopeActivityId: activity.id,
        status: BindingStatus.ACTIVE,
        note: 'permanent registration runtime fixture',
      },
    });
    const session = await prisma.activitySession.create({
      data: {
        activityId: activity.id,
        code: `permanent-session-${index}`,
        name: `Permanent session ${index}`,
        startAt: WINDOW.startAt,
        endAt: WINDOW.endAt,
        locationText: 'Permanent registration field',
        capacity: 10,
        checkInOpenAt: new Date('2099-12-20T07:30:00.000Z'),
        checkInCloseAt: new Date('2099-12-20T08:30:00.000Z'),
        checkOutOpenAt: new Date('2099-12-20T11:00:00.000Z'),
        checkOutCloseAt: new Date('2099-12-20T12:30:00.000Z'),
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
        code: `permanent-position-${index}`,
        name: `Permanent position ${index}`,
        attendanceRoleCode: 'volunteer',
        capacity: 10,
      },
      select: { id: true },
    });
    await prisma.activityCapacityBucket.createMany({
      data: [
        {
          activityId: activity.id,
          scopeTypeCode: 'activity_person',
          scopeId: activity.id,
          capacity: 10,
        },
        {
          activityId: activity.id,
          scopeTypeCode: 'session_participation',
          scopeId: session.id,
          capacity: 10,
        },
        {
          activityId: activity.id,
          scopeTypeCode: 'position_participation',
          scopeId: position.id,
          capacity: 10,
        },
      ],
    });
    await prisma.activityEvidenceState.create({ data: { activityId: activity.id } });
    return { activityId: activity.id, sessionId: session.id, positionId: position.id };
  }

  async function createCoveredTarget(): Promise<string> {
    const index = ++sequence;
    const member = await prisma.member.create({
      data: {
        memberNo: `PERMANENT-TARGET-${index}`,
        ...memberIdentityData(`Permanent Target ${index}`),
        gradeCode: 'L1',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    await prisma.memberInsurance.create({
      data: {
        memberId: member.id,
        insurerName: 'Permanent Runtime Insurance',
        policyNumber: `PERMANENT-POLICY-${index}`,
        coverageStart: new Date('2099-01-01T00:00:00.000Z'),
        coverageEnd: new Date('2100-01-01T00:00:00.000Z'),
        reviewStatusCode: 'verified',
        reviewedByUserId: managerUserId,
        reviewedAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    return member.id;
  }

  async function createCoveredApplicant(): Promise<{ auth: string; memberId: string }> {
    const memberId = await createCoveredTarget();
    const user = await createTestUser(appA, {
      username: `perm-reg-applicant-${++sequence}`,
      role: Role.USER,
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId } });
    return { auth: (await loginAs(appA, user.username)).authHeader, memberId };
  }

  function onsite(
    app: INestApplication,
    scenario: Scenario,
    memberId: string,
    operationKey: string,
  ) {
    return request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${scenario.activityId}/onsite-participations`)
      .set('Authorization', managerAuth)
      .send({
        operationKey,
        memberId,
        sessionId: scenario.sessionId,
        positionId: scenario.positionId,
        reason: '永久头十轮验收',
      });
  }

  function cancel(
    app: INestApplication,
    scenario: Scenario,
    registrationId: string,
    round: number,
  ) {
    return request(httpServer(app))
      .patch(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/registrations/${registrationId}/cancel`,
      )
      .set('Authorization', managerAuth)
      .send({ cancelReason: `永久头取消第 ${round} 轮` });
  }

  function rejectManaged(
    app: INestApplication,
    scenario: Scenario,
    registrationId: string,
    reviewNote: string,
  ) {
    return request(httpServer(app))
      .patch(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/registrations/${registrationId}/reject`,
      )
      .set('Authorization', managerAuth)
      .send({ reviewNote });
  }

  function reopenManaged(app: INestApplication, scenario: Scenario, registrationId: string) {
    return request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/registrations/${registrationId}/reopen`,
      )
      .set('Authorization', managerAuth)
      .send();
  }

  function canonical(
    app: INestApplication,
    scenario: Scenario,
    auth: string,
    operationKey: string,
  ) {
    return request(httpServer(app))
      .post(`/api/app/v1/activities/${scenario.activityId}/registrations`)
      .set('Authorization', auth)
      .send({
        operationKey,
        formVersion: null,
        answers: [],
        preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
      });
  }

  it('reuses one permanent head and identity through ten cancel/reapply rounds', async () => {
    const scenario = await createScenario();
    const memberId = await createCoveredTarget();
    const first = await onsite(appA, scenario, memberId, 'permanent-runtime-onsite-00');
    expect(first.status).toBe(201);
    const registrationId = first.body.data.registrationId as string;
    const identityId = first.body.data.participationIdentityId as string;

    for (let round = 1; round <= 10; round += 1) {
      const cancelled = await cancel(appA, scenario, registrationId, round);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.data).toMatchObject({ registrationId, statusCode: 'cancelled' });
      const cancelledIdentity = await prisma.activityParticipationIdentity.findUniqueOrThrow({
        where: { id: identityId },
        select: { capacityReservationId: true, populationIncluded: true },
      });
      expect(cancelledIdentity).toEqual({
        capacityReservationId: null,
        populationIncluded: false,
      });
      expect(
        await prisma.capacityReservation.count({
          where: { identityId, status: 'active' },
        }),
      ).toBe(0);
      expect(
        await prisma.activityCapacityBucket.findMany({
          where: { activityId: scenario.activityId },
          orderBy: [{ scopeTypeCode: 'asc' }, { scopeId: 'asc' }],
          select: { occupied: true },
        }),
      ).toEqual([{ occupied: 0 }, { occupied: 0 }, { occupied: 0 }]);

      const reapplied = await onsite(
        appA,
        scenario,
        memberId,
        `permanent-runtime-onsite-${String(round).padStart(2, '0')}`,
      );
      expect(reapplied.status).toBe(201);
      expect(reapplied.body.data).toMatchObject({
        registrationId,
        participationIdentityId: identityId,
      });
    }

    const [header, identity, evidenceState, buckets] = await Promise.all([
      prisma.activityRegistration.findUniqueOrThrow({
        where: { id: registrationId },
        select: { currentRevision: true, statusCode: true },
      }),
      prisma.activityParticipationIdentity.findUniqueOrThrow({
        where: { id: identityId },
        select: {
          currentRevision: true,
          currentStatusCode: true,
          capacityReservationId: true,
          populationIncluded: true,
        },
      }),
      prisma.activityEvidenceState.findUniqueOrThrow({
        where: { activityId: scenario.activityId },
        select: { populationRevision: true },
      }),
      prisma.activityCapacityBucket.findMany({
        where: { activityId: scenario.activityId },
        orderBy: [{ scopeTypeCode: 'asc' }, { scopeId: 'asc' }],
        select: { occupied: true, version: true },
      }),
    ]);
    expect(await prisma.activityRegistration.count({ where: { id: registrationId } })).toBe(1);
    expect(await prisma.activityParticipationIdentity.count({ where: { id: identityId } })).toBe(1);
    expect(header).toEqual({ currentRevision: 21, statusCode: 'pending' });
    expect(identity).toMatchObject({
      currentRevision: 21,
      currentStatusCode: 'pass',
      populationIncluded: true,
    });
    expect(evidenceState.populationRevision).toBe(21);
    expect(await prisma.activityRegistrationRevision.count({ where: { registrationId } })).toBe(21);
    expect(await prisma.activityParticipationRevision.count({ where: { identityId } })).toBe(21);
    expect(
      await prisma.insuranceEligibilityEvidence.count({
        where: { activityRegistrationId: registrationId },
      }),
    ).toBe(11);
    expect(
      (
        await prisma.insuranceEligibilityEvidence.findMany({
          where: { activityRegistrationId: registrationId },
          orderBy: { createdAt: 'asc' },
          select: {
            activityRegistrationRevision: { select: { revision: true, sourceCode: true } },
          },
        })
      ).map((row) => row.activityRegistrationRevision),
    ).toEqual(
      Array.from({ length: 11 }, (_, index) => ({
        revision: index * 2 + 1,
        sourceCode: 'onsite',
      })),
    );
    expect(await prisma.capacityReservation.count({ where: { identityId } })).toBe(33);
    expect(
      await prisma.capacityReservation.count({ where: { identityId, status: 'active' } }),
    ).toBe(3);
    expect(buckets).toEqual([
      { occupied: 1, version: 21 },
      { occupied: 1, version: 21 },
      { occupied: 1, version: 21 },
    ]);
    const sessionReservation = await prisma.capacityReservation.findFirstOrThrow({
      where: {
        identityId,
        status: 'active',
        reservationType: 'session_participation',
      },
      select: { id: true },
    });
    expect(identity.capacityReservationId).toBe(sessionReservation.id);
  });

  it('closes onsite reject/reopen projections and reuses the same head and identity', async () => {
    const scenario = await createScenario();
    const memberId = await createCoveredTarget();
    const first = await onsite(appA, scenario, memberId, 'permanent-runtime-reject-first');
    expect(first.status).toBe(201);
    const registrationId = first.body.data.registrationId as string;
    const identityId = first.body.data.participationIdentityId as string;

    const rejected = await rejectManaged(appA, scenario, registrationId, '现场记录核验不通过');
    expect(rejected.status).toBe(200);
    expect(rejected.body.data).toMatchObject({ registrationId, statusCode: 'reject' });
    await expect(
      prisma.activityRegistration.findUniqueOrThrow({
        where: { id: registrationId },
        select: { statusSummaryCode: true },
      }),
    ).resolves.toEqual({ statusSummaryCode: 'not_selected' });
    await expect(
      prisma.activityParticipationIdentity.findUniqueOrThrow({
        where: { id: identityId },
        select: {
          currentRevision: true,
          currentStatusCode: true,
          currentPositionId: true,
          capacityReservationId: true,
          populationIncluded: true,
        },
      }),
    ).resolves.toEqual({
      currentRevision: 2,
      currentStatusCode: 'rejected',
      currentPositionId: null,
      capacityReservationId: null,
      populationIncluded: false,
    });
    expect(
      await prisma.capacityReservation.count({ where: { identityId, status: 'active' } }),
    ).toBe(0);
    expect(
      await prisma.activityCapacityBucket.findMany({
        where: { activityId: scenario.activityId },
        orderBy: [{ scopeTypeCode: 'asc' }, { scopeId: 'asc' }],
        select: { occupied: true },
      }),
    ).toEqual([{ occupied: 0 }, { occupied: 0 }, { occupied: 0 }]);
    await expect(
      prisma.activityEvidenceState.findUniqueOrThrow({
        where: { activityId: scenario.activityId },
        select: { populationRevision: true },
      }),
    ).resolves.toEqual({ populationRevision: 2 });

    const reapplied = await onsite(appA, scenario, memberId, 'permanent-runtime-reject-reapply');
    expect(reapplied.status).toBe(201);
    expect(reapplied.body.data).toMatchObject({
      registrationId,
      participationIdentityId: identityId,
    });

    expect((await rejectManaged(appA, scenario, registrationId, '重开链先拒绝')).status).toBe(200);
    const reopened = await reopenManaged(appA, scenario, registrationId);
    expect(reopened.status).toBe(200);
    expect(reopened.body.data).toMatchObject({ registrationId, statusCode: 'pending' });
    await expect(
      prisma.activityRegistration.findUniqueOrThrow({
        where: { id: registrationId },
        select: { statusSummaryCode: true },
      }),
    ).resolves.toEqual({ statusSummaryCode: 'active' });
    await expect(
      prisma.activityParticipationIdentity.findUniqueOrThrow({
        where: { id: identityId },
        select: {
          currentRevision: true,
          currentStatusCode: true,
          currentPositionId: true,
          capacityReservationId: true,
          populationIncluded: true,
        },
      }),
    ).resolves.toEqual({
      currentRevision: 5,
      currentStatusCode: 'pending',
      currentPositionId: null,
      capacityReservationId: null,
      populationIncluded: false,
    });
    expect(await prisma.activityRegistrationRevision.count({ where: { registrationId } })).toBe(2);
    expect(
      await prisma.insuranceEligibilityEvidence.count({
        where: { activityRegistrationId: registrationId },
      }),
    ).toBe(2);

    const afterReopen = await onsite(appA, scenario, memberId, 'permanent-runtime-reopen-reapply');
    expect(afterReopen.status).toBe(201);
    expect(afterReopen.body.data).toMatchObject({
      registrationId,
      participationIdentityId: identityId,
    });
  });

  it('rolls back reopen when a rejected identity still projects a position', async () => {
    const scenario = await createScenario();
    const applicant = await createCoveredApplicant();
    const first = await onsite(
      appA,
      scenario,
      applicant.memberId,
      'permanent-runtime-reopen-drift-first',
    );
    expect(first.status).toBe(201);
    const registrationId = first.body.data.registrationId as string;
    const identityId = first.body.data.participationIdentityId as string;
    expect(
      (await rejectManaged(appA, scenario, registrationId, '构造重开漂移前的真实拒绝态')).status,
    ).toBe(200);
    await prisma.activityParticipationIdentity.update({
      where: { id: identityId },
      data: { currentPositionId: scenario.positionId },
    });

    const facts = () =>
      Promise.all([
        prisma.activityRegistration.findUniqueOrThrow({
          where: { id: registrationId },
          select: {
            statusCode: true,
            currentRevision: true,
            reviewedBy: true,
            reviewedAt: true,
            reviewNote: true,
          },
        }),
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
        prisma.activityRegistrationRevision.count({ where: { registrationId } }),
        prisma.activityParticipationRevision.count({ where: { identityId } }),
        prisma.insuranceEligibilityEvidence.count({
          where: { activityRegistrationId: registrationId },
        }),
        prisma.capacityReservation.findMany({
          where: { identityId },
          orderBy: { id: 'asc' },
          select: { id: true, status: true, releasedAt: true, releaseReason: true },
        }),
        prisma.activityCapacityBucket.findMany({
          where: { activityId: scenario.activityId },
          orderBy: [{ scopeTypeCode: 'asc' }, { scopeId: 'asc' }],
          select: { occupied: true, version: true },
        }),
        prisma.activityEvidenceState.findUniqueOrThrow({
          where: { activityId: scenario.activityId },
          select: { populationRevision: true, version: true },
        }),
        prisma.auditLog.count({
          where: { resourceId: registrationId, event: 'registration.review' },
        }),
        prisma.notificationOutboxIntent.count({
          where: { aggregateType: 'activity_registration', aggregateId: registrationId },
        }),
      ]);
    const before = await facts();

    const reopened = await reopenManaged(appA, scenario, registrationId);
    expectBizError(reopened, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    await expect(facts()).resolves.toEqual(before);

    const onsiteOverwrite = await onsite(
      appA,
      scenario,
      applicant.memberId,
      'permanent-runtime-rejected-drift-onsite',
    );
    expectBizError(onsiteOverwrite, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    await expect(facts()).resolves.toEqual(before);

    const canonicalOverwrite = await canonical(
      appA,
      scenario,
      applicant.auth,
      'permanent-runtime-rejected-drift-canonical',
    );
    expectBizError(canonicalOverwrite, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    await expect(facts()).resolves.toEqual(before);
  });

  it('fails closed when a pass identity loses only its population projection', async () => {
    const scenario = await createScenario();
    const applicant = await createCoveredApplicant();
    const first = await onsite(
      appA,
      scenario,
      applicant.memberId,
      'permanent-runtime-pass-population-drift-first',
    );
    expect(first.status).toBe(201);
    const registrationId = first.body.data.registrationId as string;
    const identityId = first.body.data.participationIdentityId as string;
    await prisma.activityParticipationIdentity.update({
      where: { id: identityId },
      data: { populationIncluded: false },
    });

    const facts = () =>
      Promise.all([
        prisma.activityRegistration.findUniqueOrThrow({
          where: { id: registrationId },
          select: {
            statusCode: true,
            statusSummaryCode: true,
            currentRevision: true,
            reviewedAt: true,
          },
        }),
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
        prisma.activityRegistrationRevision.count({ where: { registrationId } }),
        prisma.activityParticipationRevision.count({ where: { identityId } }),
        prisma.insuranceEligibilityEvidence.count({
          where: { activityRegistrationId: registrationId },
        }),
        prisma.capacityReservation.findMany({
          where: { identityId },
          orderBy: { id: 'asc' },
          select: { id: true, status: true, releasedAt: true, releaseReason: true },
        }),
        prisma.activityCapacityBucket.findMany({
          where: { activityId: scenario.activityId },
          orderBy: [{ scopeTypeCode: 'asc' }, { scopeId: 'asc' }],
          select: { occupied: true, version: true },
        }),
        prisma.activityEvidenceState.findUniqueOrThrow({
          where: { activityId: scenario.activityId },
          select: { populationRevision: true, version: true },
        }),
        prisma.auditLog.count({ where: { resourceId: registrationId } }),
        prisma.notificationOutboxIntent.count({
          where: { aggregateType: 'activity_registration', aggregateId: registrationId },
        }),
      ]);
    const before = await facts();

    const cancelled = await cancel(appA, scenario, registrationId, 1);
    expectBizError(cancelled, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    await expect(facts()).resolves.toEqual(before);

    const onsiteRetry = await onsite(
      appA,
      scenario,
      applicant.memberId,
      'permanent-runtime-pass-population-drift-onsite',
    );
    expectBizError(onsiteRetry, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    await expect(facts()).resolves.toEqual(before);

    const canonicalRetry = await canonical(
      appA,
      scenario,
      applicant.auth,
      'permanent-runtime-pass-population-drift-canonical',
    );
    expectBizError(canonicalRetry, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    await expect(facts()).resolves.toEqual(before);
  });

  it.each(['attended', 'settled'] as const)(
    'blocks a new onsite session when a non-target %s identity is outside the population',
    async (terminalStatus) => {
      const scenario = await createScenario();
      const memberId = await createCoveredTarget();
      const registration = await prisma.activityRegistration.create({
        data: {
          activityId: scenario.activityId,
          memberId,
          statusCode: 'cancelled',
          statusSummaryCode: 'cancelled',
          sourceCode: 'admin',
        },
        select: { id: true },
      });
      const identity = await prisma.activityParticipationIdentity.create({
        data: {
          activityId: scenario.activityId,
          sessionId: scenario.sessionId,
          registrationId: registration.id,
          memberId,
          currentRevision: 1,
          currentStatusCode: terminalStatus,
          populationIncluded: false,
        },
        select: { id: true },
      });
      await prisma.activityParticipationRevision.create({
        data: {
          identityId: identity.id,
          revision: 1,
          statusCode: terminalStatus,
          effectiveAt: new Date(),
          createdByUserId: managerUserId,
          sourceCode: 'admin',
        },
      });
      const secondSession = await prisma.activitySession.create({
        data: {
          activityId: scenario.activityId,
          code: `terminal-drift-session-${terminalStatus}-${++sequence}`,
          name: `Terminal drift session ${terminalStatus}`,
          startAt: WINDOW.startAt,
          endAt: WINDOW.endAt,
          locationText: 'Permanent registration field',
          capacity: 10,
          checkInOpenAt: new Date('2099-12-20T07:30:00.000Z'),
          checkInCloseAt: new Date('2099-12-20T08:30:00.000Z'),
          checkOutOpenAt: new Date('2099-12-20T11:00:00.000Z'),
          checkOutCloseAt: new Date('2099-12-20T12:30:00.000Z'),
          locationRequired: false,
          locationPolicySourceCode: 'session',
          statusCode: 'scheduled',
        },
        select: { id: true },
      });
      const secondPosition = await prisma.activitySessionPosition.create({
        data: {
          activityId: scenario.activityId,
          sessionId: secondSession.id,
          code: `terminal-drift-position-${terminalStatus}-${sequence}`,
          name: `Terminal drift position ${terminalStatus}`,
          attendanceRoleCode: 'volunteer',
          capacity: 10,
        },
        select: { id: true },
      });
      await prisma.activityCapacityBucket.createMany({
        data: [
          {
            activityId: scenario.activityId,
            scopeTypeCode: 'session_participation',
            scopeId: secondSession.id,
            capacity: 10,
          },
          {
            activityId: scenario.activityId,
            scopeTypeCode: 'position_participation',
            scopeId: secondPosition.id,
            capacity: 10,
          },
        ],
      });
      const secondScenario = {
        activityId: scenario.activityId,
        sessionId: secondSession.id,
        positionId: secondPosition.id,
      };
      const facts = () =>
        Promise.all([
          prisma.activityRegistration.findUniqueOrThrow({
            where: { id: registration.id },
            select: { statusCode: true, currentRevision: true, statusSummaryCode: true },
          }),
          prisma.activityParticipationIdentity.findUniqueOrThrow({
            where: { id: identity.id },
            select: {
              currentRevision: true,
              currentStatusCode: true,
              populationIncluded: true,
              capacityReservationId: true,
            },
          }),
          prisma.activityRegistrationRevision.count({ where: { registrationId: registration.id } }),
          prisma.activityParticipationRevision.count({ where: { identityId: identity.id } }),
          prisma.capacityReservation.count({ where: { identityId: identity.id } }),
          prisma.activityCapacityBucket.findMany({
            where: { activityId: scenario.activityId },
            orderBy: [{ scopeTypeCode: 'asc' }, { scopeId: 'asc' }],
            select: { occupied: true, version: true },
          }),
          prisma.auditLog.count({ where: { resourceId: registration.id } }),
          prisma.notificationOutboxIntent.count({
            where: { aggregateType: 'activity_registration', aggregateId: registration.id },
          }),
        ]);
      const before = await facts();

      const response = await onsite(
        appA,
        secondScenario,
        memberId,
        `permanent-runtime-${terminalStatus}-population-drift`,
      );
      expectBizError(response, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
      await expect(facts()).resolves.toEqual(before);
    },
  );

  it('finds an active session reservation even when its bucket scope type is corrupted', async () => {
    const scenario = await createScenario();
    const applicant = await createCoveredApplicant();
    const first = await onsite(
      appA,
      scenario,
      applicant.memberId,
      'permanent-runtime-wrong-scope-first',
    );
    expect(first.status).toBe(201);
    const registrationId = first.body.data.registrationId as string;
    const identityId = first.body.data.participationIdentityId as string;
    expect(
      (await rejectManaged(appA, scenario, registrationId, '构造错误容量桶 scope 前的真实拒绝态'))
        .status,
    ).toBe(200);
    const releasedSession = await prisma.capacityReservation.findFirstOrThrow({
      where: { identityId, reservationType: 'session_participation', status: 'released' },
      select: { id: true, bucketId: true },
    });
    await prisma.activityCapacityBucket.update({
      where: { id: releasedSession.bucketId },
      data: { scopeTypeCode: 'reserve_group', occupied: 1, version: { increment: 1 } },
    });
    await prisma.capacityReservation.update({
      where: { id: releasedSession.id },
      data: { status: 'active', releasedAt: null, releaseReason: null },
    });
    const before = await Promise.all([
      prisma.activityRegistrationRevision.count({ where: { registrationId } }),
      prisma.activityParticipationRevision.count({ where: { identityId } }),
      prisma.insuranceEligibilityEvidence.count({
        where: { activityRegistrationId: registrationId },
      }),
      prisma.auditLog.count({ where: { resourceId: registrationId } }),
      prisma.notificationOutboxIntent.count({
        where: { aggregateType: 'activity_registration', aggregateId: registrationId },
      }),
    ]);

    const response = await canonical(
      appA,
      scenario,
      applicant.auth,
      'permanent-runtime-wrong-scope-canonical',
    );
    expectBizError(response, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    await expect(
      Promise.all([
        prisma.activityRegistrationRevision.count({ where: { registrationId } }),
        prisma.activityParticipationRevision.count({ where: { identityId } }),
        prisma.insuranceEligibilityEvidence.count({
          where: { activityRegistrationId: registrationId },
        }),
        prisma.auditLog.count({ where: { resourceId: registrationId } }),
        prisma.notificationOutboxIntent.count({
          where: { aggregateType: 'activity_registration', aggregateId: registrationId },
        }),
      ]),
    ).resolves.toEqual(before);
  });

  it.each(['activity_person', 'position_participation'] as const)(
    'fails closed on an orphan active %s reservation after a coherent rejection',
    async (reservationType) => {
      const scenario = await createScenario();
      const applicant = await createCoveredApplicant();
      const first = await onsite(
        appA,
        scenario,
        applicant.memberId,
        `permanent-runtime-orphan-${reservationType}-first`,
      );
      expect(first.status).toBe(201);
      const registrationId = first.body.data.registrationId as string;
      const identityId = first.body.data.participationIdentityId as string;
      expect(
        (await rejectManaged(appA, scenario, registrationId, '构造孤儿容量占位前的真实拒绝态'))
          .status,
      ).toBe(200);
      const released = await prisma.capacityReservation.findFirstOrThrow({
        where: { identityId, reservationType, status: 'released' },
        select: { id: true, bucketId: true },
      });
      await prisma.activityCapacityBucket.update({
        where: { id: released.bucketId },
        data: { occupied: 1, version: { increment: 1 } },
      });
      await prisma.capacityReservation.update({
        where: { id: released.id },
        data: { status: 'active', releasedAt: null, releaseReason: null },
      });

      const facts = () =>
        Promise.all([
          prisma.activityRegistration.findUniqueOrThrow({
            where: { id: registrationId },
            select: { statusCode: true, currentRevision: true, reviewedAt: true },
          }),
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
          prisma.activityRegistrationRevision.count({ where: { registrationId } }),
          prisma.activityParticipationRevision.count({ where: { identityId } }),
          prisma.insuranceEligibilityEvidence.count({
            where: { activityRegistrationId: registrationId },
          }),
          prisma.capacityReservation.findMany({
            where: { identityId },
            orderBy: { id: 'asc' },
            select: { id: true, status: true, releasedAt: true, releaseReason: true },
          }),
          prisma.activityCapacityBucket.findMany({
            where: { activityId: scenario.activityId },
            orderBy: [{ scopeTypeCode: 'asc' }, { scopeId: 'asc' }],
            select: { occupied: true, version: true },
          }),
          prisma.activityEvidenceState.findUniqueOrThrow({
            where: { activityId: scenario.activityId },
            select: { populationRevision: true, version: true },
          }),
          prisma.auditLog.count({ where: { resourceId: registrationId } }),
          prisma.notificationOutboxIntent.count({
            where: { aggregateType: 'activity_registration', aggregateId: registrationId },
          }),
        ]);
      const before = await facts();

      const reopened = await reopenManaged(appA, scenario, registrationId);
      expectBizError(reopened, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
      await expect(facts()).resolves.toEqual(before);

      const onsiteRetry = await onsite(
        appA,
        scenario,
        applicant.memberId,
        `permanent-runtime-orphan-${reservationType}-onsite`,
      );
      expectBizError(onsiteRetry, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
      await expect(facts()).resolves.toEqual(before);

      const canonicalRetry = await canonical(
        appA,
        scenario,
        applicant.auth,
        `permanent-runtime-orphan-${reservationType}-canonical`,
      );
      expectBizError(canonicalRetry, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
      await expect(facts()).resolves.toEqual(before);
    },
  );

  it.each(['canonical', 'onsite'] as const)(
    'clears stale legacy current fields when %s reuses a cancelled permanent head',
    async (entry) => {
      const scenario = await createScenario();
      const applicant = await createCoveredApplicant();
      const legacyPosition = await prisma.activityPosition.create({
        data: {
          activityId: scenario.activityId,
          name: `Legacy position ${entry}`,
          attendanceRoleCode: 'member',
          capacity: 10,
        },
        select: { id: true },
      });
      const legacyRegisteredAt = new Date('2026-01-01T00:00:00.000Z');
      const legacyHead = await prisma.activityRegistration.create({
        data: {
          activityId: scenario.activityId,
          activityPositionId: legacyPosition.id,
          memberId: applicant.memberId,
          statusCode: 'cancelled',
          registeredAt: legacyRegisteredAt,
          extras: { legacy: true },
          cancelledAt: legacyRegisteredAt,
          cancelReason: 'legacy history',
          currentRevision: 0,
          statusSummaryCode: 'cancelled',
          sourceCode: 'admin',
        },
        select: { id: true },
      });

      const response =
        entry === 'canonical'
          ? await canonical(appA, scenario, applicant.auth, 'permanent-runtime-legacy-to-canonical')
          : await onsite(appA, scenario, applicant.memberId, 'permanent-runtime-legacy-to-onsite');
      expect(response.status).toBe(201);
      expect(response.body.data.registrationId).toBe(legacyHead.id);

      const current = await prisma.activityRegistration.findUniqueOrThrow({
        where: { id: legacyHead.id },
        select: {
          activityPositionId: true,
          registeredAt: true,
          extras: true,
          statusCode: true,
          statusSummaryCode: true,
          sourceCode: true,
        },
      });
      expect(current).toMatchObject({
        activityPositionId: null,
        extras: null,
        statusCode: entry === 'canonical' ? 'pass' : 'pending',
        statusSummaryCode: 'active',
        sourceCode: entry === 'canonical' ? 'self' : 'onsite',
      });
      expect(current.registeredAt.getTime()).toBeGreaterThan(legacyRegisteredAt.getTime());
      expect(
        await prisma.activityRegistration.count({
          where: { activityId: scenario.activityId, memberId: applicant.memberId },
        }),
      ).toBe(1);
      expect(
        await prisma.activityParticipationIdentity.count({
          where: { activityId: scenario.activityId, memberId: applicant.memberId },
        }),
      ).toBe(1);
    },
  );

  it.each(['canonical', 'onsite'] as const)(
    'fails closed when %s finds an activity-person anchor on a foreign identity before identity creation',
    async (entry) => {
      const scenario = await createScenario();
      const applicant = await createCoveredApplicant();
      const targetHead = await prisma.activityRegistration.create({
        data: {
          activityId: scenario.activityId,
          memberId: applicant.memberId,
          statusCode: 'cancelled',
          statusSummaryCode: 'cancelled',
          sourceCode: 'admin',
        },
        select: { id: true },
      });
      const foreignMemberId = await createCoveredTarget();
      const foreignHead = await prisma.activityRegistration.create({
        data: {
          activityId: scenario.activityId,
          memberId: foreignMemberId,
          statusCode: 'cancelled',
          statusSummaryCode: 'cancelled',
          sourceCode: 'admin',
        },
        select: { id: true },
      });
      const foreignIdentity = await prisma.activityParticipationIdentity.create({
        data: {
          activityId: scenario.activityId,
          sessionId: scenario.sessionId,
          registrationId: foreignHead.id,
          memberId: foreignMemberId,
          currentStatusCode: 'rejected',
        },
        select: { id: true },
      });
      const activityBucket = await prisma.activityCapacityBucket.findFirstOrThrow({
        where: {
          activityId: scenario.activityId,
          scopeTypeCode: 'activity_person',
          scopeId: scenario.activityId,
        },
        select: { id: true },
      });
      await prisma.$transaction([
        prisma.activityCapacityBucket.update({
          where: { id: activityBucket.id },
          data: { occupied: 1, version: { increment: 1 } },
        }),
        prisma.capacityReservation.create({
          data: {
            identityId: foreignIdentity.id,
            bucketId: activityBucket.id,
            reservationType: 'activity_person',
            memberId: applicant.memberId,
            activityId: scenario.activityId,
            status: 'active',
          },
        }),
      ]);

      const facts = () =>
        Promise.all([
          prisma.activityRegistration.findUniqueOrThrow({
            where: { id: targetHead.id },
            select: { statusCode: true, currentRevision: true, statusSummaryCode: true },
          }),
          prisma.activityParticipationIdentity.count({
            where: { activityId: scenario.activityId, memberId: applicant.memberId },
          }),
          prisma.activityRegistrationRevision.count({
            where: { registrationId: targetHead.id },
          }),
          prisma.insuranceEligibilityEvidence.count({
            where: { activityRegistrationId: targetHead.id },
          }),
          prisma.capacityReservation.findMany({
            where: { memberId: applicant.memberId, activityId: scenario.activityId },
            orderBy: { id: 'asc' },
            select: { id: true, identityId: true, status: true },
          }),
          prisma.activityCapacityBucket.findUniqueOrThrow({
            where: { id: activityBucket.id },
            select: { occupied: true, version: true },
          }),
          prisma.auditLog.count({ where: { resourceId: targetHead.id } }),
          prisma.notificationOutboxIntent.count({
            where: { aggregateType: 'activity_registration', aggregateId: targetHead.id },
          }),
        ]);
      const before = await facts();

      const response =
        entry === 'canonical'
          ? await canonical(
              appA,
              scenario,
              applicant.auth,
              'permanent-runtime-foreign-anchor-canonical',
            )
          : await onsite(
              appA,
              scenario,
              applicant.memberId,
              'permanent-runtime-foreign-anchor-onsite',
            );
      expectBizError(response, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
      await expect(facts()).resolves.toEqual(before);
    },
  );

  // 复合锚点闭合(第六轮评审 A-2 + B-03)之后,「队员身份挂在别人的报名头上」这个前提
  // **在数据库层面已不可能存在**:identity 指回报名头的外键是
  // [registrationId, activityId, memberId] → [id, activityId, memberId],而
  // ActivityRegistration 的 (activityId, memberId) 唯一 ⇒ 一个队员在一个活动里至多一张头,
  // identity 只能挂在自己那张上。
  //
  // 原用例先直插一行"错挂他人头"的 identity,再断言 canonical 创建以 20147 零写收场。
  // 那个前提现在**构造不出来**,用例遂改为钉住「数据库在这一步就拒掉」这件事本身。
  // ⚠️ service 侧原有的判断**刻意保留不动**(本刀不改 service 校验)—— 数据库闭合后
  // 它由"唯一防线"降级为纵深冗余,是否删除另行判断。
  it('cannot even construct a foreign-head identity — the database rejects it (23503)', async () => {
    const scenario = await createScenario();
    const applicant = await createCoveredApplicant();
    const foreignMemberId = await createCoveredTarget();
    const foreignHead = await prisma.activityRegistration.create({
      data: {
        activityId: scenario.activityId,
        memberId: foreignMemberId,
        statusCode: 'cancelled',
        statusSummaryCode: 'cancelled',
        sourceCode: 'admin',
      },
      select: { id: true },
    });

    // 别人的头 + 本人的 memberId ⇒ 复合外键当场拒,并点名到具体约束。
    await expect(
      prisma.activityParticipationIdentity.create({
        data: {
          activityId: scenario.activityId,
          sessionId: scenario.sessionId,
          registrationId: foreignHead.id,
          memberId: applicant.memberId,
          currentRevision: 1,
          currentStatusCode: 'cancelled',
          populationIncluded: false,
        },
        select: { id: true },
      }),
    ).rejects.toThrow(/ActivityParticipationIdentity_registrationId_activityId_me_fkey/);

    // 反向对照:同一张头配**它自己的**队员就放行 —— 证明这条外键不是恒拒。
    const ownIdentity = await prisma.activityParticipationIdentity.create({
      data: {
        activityId: scenario.activityId,
        sessionId: scenario.sessionId,
        registrationId: foreignHead.id,
        memberId: foreignMemberId,
        currentRevision: 1,
        currentStatusCode: 'cancelled',
        populationIncluded: false,
      },
      select: { id: true },
    });
    expect(ownIdentity.id).toBeTruthy();

    // 零写核对:被拒的那次没有留下任何本人身份行。
    await expect(
      prisma.activityParticipationIdentity.count({
        where: { activityId: scenario.activityId, memberId: applicant.memberId },
      }),
    ).resolves.toBe(0);
  });

  it('collapses twenty concurrent exact onsite retries to one receipt and one revision', async () => {
    const scenario = await createScenario();
    const memberId = await createCoveredTarget();
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        onsite(index % 2 === 0 ? appA : appB, scenario, memberId, 'permanent-runtime-replay-20'),
      ),
    );
    expect(responses.every((response) => response.status === 201)).toBe(true);
    const receipts = new Set(responses.map((response) => JSON.stringify(response.body.data)));
    expect(receipts.size).toBe(1);
    const registrationId = responses[0].body.data.registrationId as string;
    expect(await prisma.activityRegistrationRevision.count({ where: { registrationId } })).toBe(1);
    expect(
      await prisma.insuranceEligibilityEvidence.count({
        where: { activityRegistrationId: registrationId },
      }),
    ).toBe(1);
  });

  it('serializes two different new keys for one cancelled identity to exactly one winner', async () => {
    const scenario = await createScenario();
    const memberId = await createCoveredTarget();
    const first = await onsite(appA, scenario, memberId, 'permanent-runtime-race-first');
    expect(first.status).toBe(201);
    const registrationId = first.body.data.registrationId as string;
    expect((await cancel(appA, scenario, registrationId, 1)).status).toBe(200);

    const [left, right] = await Promise.all([
      onsite(appA, scenario, memberId, 'permanent-runtime-race-left'),
      onsite(appB, scenario, memberId, 'permanent-runtime-race-right'),
    ]);
    expect([left.status, right.status].sort()).toEqual([201, 409]);
    const loser = left.status === 409 ? left : right;
    expectBizError(loser, BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    expect(await prisma.activityRegistrationRevision.count({ where: { registrationId } })).toBe(3);
    expect(await prisma.activityRegistration.count({ where: { id: registrationId } })).toBe(1);
  });

  it('returns 20147 when a pass identity pointer diverges from its active session reservation', async () => {
    const scenario = await createScenario();
    const memberId = await createCoveredTarget();
    const first = await onsite(appA, scenario, memberId, 'permanent-runtime-pointer-first');
    expect(first.status).toBe(201);
    const registrationId = first.body.data.registrationId as string;
    const identityId = first.body.data.participationIdentityId as string;
    await prisma.activityParticipationIdentity.update({
      where: { id: identityId },
      data: { capacityReservationId: null },
    });
    const before = {
      registrationRevisions: await prisma.activityRegistrationRevision.count({
        where: { registrationId },
      }),
      participationRevisions: await prisma.activityParticipationRevision.count({
        where: { identityId },
      }),
      reservations: await prisma.capacityReservation.count({ where: { identityId } }),
    };

    const response = await onsite(
      appA,
      scenario,
      memberId,
      'permanent-runtime-pointer-drift-new-key',
    );
    expectBizError(response, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    await expect(
      Promise.all([
        prisma.activityRegistrationRevision.count({ where: { registrationId } }),
        prisma.activityParticipationRevision.count({ where: { identityId } }),
        prisma.capacityReservation.count({ where: { identityId } }),
      ]),
    ).resolves.toEqual([
      before.registrationRevisions,
      before.participationRevisions,
      before.reservations,
    ]);
  });

  it('distinguishes a final pass projection from pointer drift and impossible cancelled occupancy', async () => {
    const scenario = await createScenario();
    const applicant = await createCoveredApplicant();
    const first = await onsite(
      appA,
      scenario,
      applicant.memberId,
      'permanent-runtime-canonical-pointer-first',
    );
    expect(first.status).toBe(201);
    const registrationId = first.body.data.registrationId as string;
    const identityId = first.body.data.participationIdentityId as string;
    const sessionReservation = await prisma.capacityReservation.findFirstOrThrow({
      where: { identityId, status: 'active', reservationType: 'session_participation' },
      select: { id: true },
    });
    const before = await Promise.all([
      prisma.activityRegistrationRevision.count({ where: { registrationId } }),
      prisma.activityParticipationRevision.count({ where: { identityId } }),
      prisma.capacityReservation.count({ where: { identityId } }),
    ]);

    const correctFinal = await canonical(
      appA,
      scenario,
      applicant.auth,
      'permanent-runtime-canonical-pass-correct-pointer',
    );
    expectBizError(correctFinal, BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    await expect(
      Promise.all([
        prisma.activityRegistrationRevision.count({ where: { registrationId } }),
        prisma.activityParticipationRevision.count({ where: { identityId } }),
        prisma.capacityReservation.count({ where: { identityId } }),
      ]),
    ).resolves.toEqual(before);

    await prisma.activityParticipationIdentity.update({
      where: { id: identityId },
      data: { capacityReservationId: null },
    });
    const drifted = await canonical(
      appA,
      scenario,
      applicant.auth,
      'permanent-runtime-canonical-pass-drifted-pointer',
    );
    expectBizError(drifted, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);

    const identity = await prisma.activityParticipationIdentity.findUniqueOrThrow({
      where: { id: identityId },
      select: { currentRevision: true },
    });
    await prisma.activityParticipationRevision.create({
      data: {
        identityId,
        revision: identity.currentRevision + 1,
        statusCode: 'cancelled',
        effectiveAt: new Date(),
        sourceCode: 'admin',
      },
    });
    await prisma.activityParticipationIdentity.update({
      where: { id: identityId },
      data: {
        currentRevision: { increment: 1 },
        currentStatusCode: 'cancelled',
        currentPositionId: null,
        capacityReservationId: sessionReservation.id,
        populationIncluded: false,
      },
    });
    const impossibleCancelled = await canonical(
      appA,
      scenario,
      applicant.auth,
      'permanent-runtime-canonical-cancelled-active-pointer',
    );
    expectBizError(impossibleCancelled, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  });

  it('keeps dual-pool cancel and reapply free of partial writes and server errors', async () => {
    const scenario = await createScenario();
    const memberId = await createCoveredTarget();
    const first = await onsite(appA, scenario, memberId, 'permanent-runtime-cross-pool-first');
    expect(first.status).toBe(201);
    const registrationId = first.body.data.registrationId as string;

    const [cancelled, reapplied] = await Promise.all([
      cancel(appA, scenario, registrationId, 1),
      onsite(appB, scenario, memberId, 'permanent-runtime-cross-pool-reapply'),
    ]);
    expect(cancelled.status).toBe(200);
    expect([201, 409]).toContain(reapplied.status);
    if (reapplied.status === 409) {
      expectBizError(reapplied, BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    }
    expect([cancelled, reapplied].every((response) => response.status < 500)).toBe(true);

    const headers = await prisma.activityRegistration.findMany({
      where: { activityId: scenario.activityId, memberId },
      select: { id: true, currentRevision: true },
    });
    const identities = await prisma.activityParticipationIdentity.findMany({
      where: { activityId: scenario.activityId, memberId },
      select: { id: true, currentRevision: true, capacityReservationId: true },
    });
    expect(headers).toHaveLength(1);
    expect(identities).toHaveLength(1);
    expect(headers[0].currentRevision).toBe(identities[0].currentRevision);
  });
});
