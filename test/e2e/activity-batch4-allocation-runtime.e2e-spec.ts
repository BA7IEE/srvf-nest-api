import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, BindingStatus, MemberStatus, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';

import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const FAR = {
  startAt: new Date('2099-12-15T08:00:00.000Z'),
  endAt: new Date('2099-12-15T12:00:00.000Z'),
  deadline: new Date('2099-12-14T23:59:59.000Z'),
};

describe('activity batch4 allocation runtime', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let managerAuth: string;
  let applicantAuth: string;
  let managerMemberId: string;
  let managerUserId: string;
  let activityOwnerRoleId: string;
  let sequence = 0;

  beforeAll(async () => {
    jest.setTimeout(90_000);
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    activityOwnerRoleId = (await seedActivityResponsibilitySystemRoles(app))['activity-owner'];

    const [manager, applicant] = await Promise.all([
      createTestUser(app, { username: 'batch4-allocation-manager', role: Role.USER }),
      createTestUser(app, { username: 'batch4-allocation-applicant', role: Role.USER }),
    ]);
    const [managerMember, applicantMember] = await Promise.all([
      prisma.member.create({
        data: {
          memberNo: 'B4-ALLOCATION-MANAGER',
          displayName: 'Batch4 Allocation Manager',
          gradeCode: 'L1',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      }),
      prisma.member.create({
        data: {
          memberNo: 'B4-ALLOCATION-APPLICANT',
          displayName: 'Batch4 Allocation Applicant',
          gradeCode: 'L1',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      }),
    ]);
    managerMemberId = managerMember.id;
    managerUserId = manager.id;
    await Promise.all([
      prisma.user.update({ where: { id: manager.id }, data: { memberId: managerMember.id } }),
      prisma.user.update({ where: { id: applicant.id }, data: { memberId: applicantMember.id } }),
    ]);
    managerAuth = (await loginAs(app, manager.username)).authHeader;
    applicantAuth = (await loginAs(app, applicant.username)).authHeader;
  });

  afterAll(async () => {
    await app.close();
  });

  const registrationPath = (activityId: string) =>
    `/api/app/v1/activities/${activityId}/registrations`;
  const allocationBatchesPath = (activityId: string) =>
    `/api/app/v1/my/managed-activities/${activityId}/allocation-batches`;

  async function createCandidateScenario(): Promise<{
    activityId: string;
    sessionId: string;
    positionId: string;
  }> {
    const index = ++sequence;
    const organization = await prisma.organization.create({
      data: { name: `Batch4 Allocation Team ${index}`, nodeTypeCode: 'batch4-allocation-team' },
      select: { id: true },
    });
    const activity = await prisma.activity.create({
      data: {
        title: `Batch4 Allocation Activity ${index}`,
        activityTypeCode: 'training',
        organizationId: organization.id,
        startAt: FAR.startAt,
        endAt: FAR.endAt,
        registrationDeadline: FAR.deadline,
        location: 'Allocation Field',
        statusCode: 'published',
        publishedAt: new Date(),
        isPublicRegistration: true,
        capacity: 1,
        allocationModeCode: 'qualification_rank',
      },
      select: { id: true },
    });
    const session = await prisma.activitySession.create({
      data: {
        activityId: activity.id,
        code: `allocation-session-${index}`,
        name: `Allocation Session ${index}`,
        startAt: FAR.startAt,
        endAt: FAR.endAt,
        locationText: 'Allocation Field',
        capacity: 1,
        checkInOpenAt: new Date(FAR.startAt.getTime() - 30 * 60_000),
        checkInCloseAt: new Date(FAR.startAt.getTime() + 30 * 60_000),
        checkOutOpenAt: new Date(FAR.endAt.getTime() - 60 * 60_000),
        checkOutCloseAt: new Date(FAR.endAt.getTime() + 30 * 60_000),
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
        code: `allocation-position-${index}`,
        name: `Allocation Position ${index}`,
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
        note: `batch4 allocation fixture ${index}`,
      },
    });
    return { activityId: activity.id, sessionId: session.id, positionId: position.id };
  }

  it('red-first: freezes a real submitted candidate through the managed allocation prepare HTTP route', async () => {
    const scenario = await createCandidateScenario();
    const submitted = await request(httpServer(app))
      .post(registrationPath(scenario.activityId))
      .set('Authorization', applicantAuth)
      .send({
        operationKey: 'batch4-allocation-submit-0001',
        formVersion: null,
        answers: [],
        preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
      });
    expect(submitted.status).toBe(201);

    // The candidate must be created by the canonical HTTP command before the deadline, then the
    // deadline configuration advances. This is fixture setup, not a substitute for a production
    // registration or allocation write path.
    await prisma.activity.update({
      where: { id: scenario.activityId },
      data: { registrationDeadline: new Date('2020-01-01T00:00:00.000Z') },
    });

    const prepared = await request(httpServer(app))
      .post(allocationBatchesPath(scenario.activityId))
      .set('Authorization', managerAuth)
      .send({
        operationKey: 'batch4-allocation-prepare-0001',
        sessionId: scenario.sessionId,
      });

    // Before this Goal the schema exists but the managed three-stage HTTP runtime does not.
    expect(prepared.status).toBe(201);
  });
});
