import type { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
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
  let applicantMemberId: string;
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
    applicantMemberId = applicantMember.id;
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

  async function createCandidateScenario(input?: {
    allocationModeCode?: 'first_come' | 'qualification_rank' | 'lottery';
    capacity?: number;
  }): Promise<{
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
        capacity: input?.capacity ?? 1,
        allocationModeCode: input?.allocationModeCode ?? 'qualification_rank',
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
        capacity: input?.capacity ?? 1,
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
        capacity: input?.capacity ?? 1,
      },
      select: { id: true },
    });
    await prisma.activityCapacityBucket.createMany({
      data: [
        {
          activityId: activity.id,
          scopeTypeCode: 'activity_person',
          scopeId: activity.id,
          capacity: input?.capacity ?? 1,
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

  async function createActiveApplicant(label: string, gradeCode: string): Promise<{
    auth: string;
    memberId: string;
  }> {
    const user = await createTestUser(app, {
      username: `b4-${label}-${sequence}`,
      role: Role.USER,
    });
    const member = await prisma.member.create({
      data: {
        memberNo: `B4-${label.toUpperCase()}-${sequence}`,
        displayName: `Batch4 ${label}`,
        gradeCode,
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    return { auth: (await loginAs(app, user.username)).authHeader, memberId: member.id };
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

  it('red-first: first_come independently passes the first accepted session applicant and queues the next', async () => {
    const scenario = await createCandidateScenario({ allocationModeCode: 'first_come', capacity: 1 });
    const secondUser = await createTestUser(app, {
      username: `batch4-first-come-second-${sequence}`,
      role: Role.USER,
    });
    const secondMember = await prisma.member.create({
      data: {
        memberNo: `B4-FIRST-COME-SECOND-${sequence}`,
        displayName: 'Batch4 First Come Second',
        gradeCode: 'L1',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    await prisma.user.update({
      where: { id: secondUser.id },
      data: { memberId: secondMember.id },
    });
    const secondAuth = (await loginAs(app, secondUser.username)).authHeader;

    const command = {
      formVersion: null,
      answers: [],
      preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
    };
    const [first, second] = await Promise.all([
      request(httpServer(app))
        .post(registrationPath(scenario.activityId))
        .set('Authorization', applicantAuth)
        .send({ ...command, operationKey: `batch4-first-come-first-${sequence}` }),
      request(httpServer(app))
        .post(registrationPath(scenario.activityId))
        .set('Authorization', secondAuth)
        .send({ ...command, operationKey: `batch4-first-come-second-${sequence}` }),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const identities = await prisma.activityParticipationIdentity.findMany({
      where: { activityId: scenario.activityId, sessionId: scenario.sessionId },
      select: { currentStatusCode: true, currentPositionId: true, capacityReservationId: true },
      orderBy: { id: 'asc' },
    });
    expect(identities).toHaveLength(2);
    expect(identities.filter((identity) => identity.currentStatusCode === 'pass')).toHaveLength(1);
    expect(identities.filter((identity) => identity.currentStatusCode === 'waitlisted')).toHaveLength(1);
    expect(identities.find((identity) => identity.currentStatusCode === 'pass')?.currentPositionId).toBe(
      scenario.positionId,
    );
    expect(
      identities.find((identity) => identity.currentStatusCode === 'waitlisted')?.capacityReservationId,
    ).toBeNull();
  });

  it('freezes qualification_rank scores, replays prepare exactly, and commits capacity in score order', async () => {
    const scenario = await createCandidateScenario({
      allocationModeCode: 'qualification_rank',
      capacity: 1,
    });
    const secondUser = await createTestUser(app, {
      username: `batch4-rank-second-${sequence}`,
      role: Role.USER,
    });
    const secondMember = await prisma.member.create({
      data: {
        memberNo: `B4-RANK-SECOND-${sequence}`,
        displayName: 'Batch4 Rank Second',
        gradeCode: 'L2',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    await prisma.user.update({
      where: { id: secondUser.id },
      data: { memberId: secondMember.id },
    });
    const secondAuth = (await loginAs(app, secondUser.username)).authHeader;
    const ruleSet = await prisma.activityQualificationRuleSet.create({
      data: {
        activityId: scenario.activityId,
        version: 1,
        statusCode: 'draft',
        rules: {
          create: {
            ruleTypeCode: 'grade',
            enforcementCode: 'warn',
            operator: 'in',
            valueJson: { codes: ['L2'] },
            warnScore: 27,
            sortOrder: 1,
          },
        },
      },
      select: { id: true },
    });
    await prisma.activityQualificationRuleSet.update({
      where: { id: ruleSet.id },
      data: { statusCode: 'active' },
    });

    const command = {
      formVersion: null,
      answers: [],
      preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
    };
    const first = await request(httpServer(app))
      .post(registrationPath(scenario.activityId))
      .set('Authorization', applicantAuth)
      .send({ ...command, operationKey: `batch4-rank-first-${sequence}` });
    const second = await request(httpServer(app))
      .post(registrationPath(scenario.activityId))
      .set('Authorization', secondAuth)
      .send({ ...command, operationKey: `batch4-rank-second-${sequence}` });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    await prisma.activity.update({
      where: { id: scenario.activityId },
      data: { registrationDeadline: new Date('2020-01-01T00:00:00.000Z') },
    });

    const prepareBody = {
      operationKey: `batch4-rank-prepare-${sequence}`,
      sessionId: scenario.sessionId,
      positionId: scenario.positionId,
    };
    const prepared = await request(httpServer(app))
      .post(allocationBatchesPath(scenario.activityId))
      .set('Authorization', managerAuth)
      .send(prepareBody);
    expect(prepared.status).toBe(201);
    expect(prepared.body.data.batch.statusCode).toBe('preparing');
    expect(prepared.body.data.batch.randomSeedReveal).toBeNull();
    const preparedReplay = await request(httpServer(app))
      .post(allocationBatchesPath(scenario.activityId))
      .set('Authorization', managerAuth)
      .send(prepareBody);
    expect(preparedReplay.status).toBe(201);
    expect(preparedReplay.body.data.responseHash).toBe(prepared.body.data.responseHash);
    expect(preparedReplay.body.data.batch).toEqual(prepared.body.data.batch);

    const batchId = prepared.body.data.batch.batchId as string;
    const committed = await request(httpServer(app))
      .post(`${allocationBatchesPath(scenario.activityId)}/${batchId}/commit`)
      .set('Authorization', managerAuth)
      .send({ operationKey: `batch4-rank-commit-${sequence}` });
    expect(committed.status).toBe(200);
    expect(committed.body.data.batch.statusCode).toBe('committed');

    const [firstIdentity, secondIdentity] = await Promise.all([
      prisma.activityParticipationIdentity.findFirstOrThrow({
        where: { activityId: scenario.activityId, memberId: applicantMemberId },
        select: { id: true },
      }),
      prisma.activityParticipationIdentity.findFirstOrThrow({
        where: { activityId: scenario.activityId, memberId: secondMember.id },
        select: { id: true },
      }),
    ]);
    const byIdentity = new Map(
      committed.body.data.batch.candidates.map(
        (candidate: { participationIdentityId: string }) => [candidate.participationIdentityId, candidate],
      ),
    );
    expect(byIdentity.get(secondIdentity.id)).toEqual(
      expect.objectContaining({ qualificationScore: '100.0000', resultCode: 'allocated' }),
    );
    expect(byIdentity.get(firstIdentity.id)).toEqual(
      expect.objectContaining({ qualificationScore: '73.0000', resultCode: 'waitlisted', waitlistRank: 1 }),
    );
  });

  it('red-first: numbers session-level qualification waitlists independently for each original position', async () => {
    const scenario = await createCandidateScenario({ allocationModeCode: 'qualification_rank' });
    await prisma.activity.update({ where: { id: scenario.activityId }, data: { capacity: 2 } });
    await prisma.activitySession.update({ where: { id: scenario.sessionId }, data: { capacity: 2 } });
    await prisma.activityCapacityBucket.updateMany({
      where: {
        activityId: scenario.activityId,
        OR: [
          { scopeTypeCode: 'activity_person', scopeId: scenario.activityId },
          { scopeTypeCode: 'session_participation', scopeId: scenario.sessionId },
        ],
      },
      data: { capacity: 2 },
    });
    const secondPosition = await prisma.activitySessionPosition.create({
      data: {
        activityId: scenario.activityId,
        sessionId: scenario.sessionId,
        code: `allocation-position-secondary-${sequence}`,
        name: `Allocation Secondary Position ${sequence}`,
        attendanceRoleCode: 'volunteer',
        capacity: 1,
      },
      select: { id: true },
    });
    await prisma.activityCapacityBucket.create({
      data: {
        activityId: scenario.activityId,
        scopeTypeCode: 'position_participation',
        scopeId: secondPosition.id,
        capacity: 1,
      },
    });
    const ruleSet = await prisma.activityQualificationRuleSet.create({
      data: {
        activityId: scenario.activityId,
        version: 1,
        statusCode: 'draft',
        rules: {
          create: [
            {
              ruleTypeCode: 'grade',
              enforcementCode: 'warn',
              operator: 'in',
              valueJson: { codes: ['L4'] },
              warnScore: 10,
              sortOrder: 1,
            },
            {
              ruleTypeCode: 'grade',
              enforcementCode: 'warn',
              operator: 'in',
              valueJson: { codes: ['L3', 'L4'] },
              warnScore: 10,
              sortOrder: 2,
            },
            {
              ruleTypeCode: 'grade',
              enforcementCode: 'warn',
              operator: 'in',
              valueJson: { codes: ['L2', 'L3', 'L4'] },
              warnScore: 10,
              sortOrder: 3,
            },
          ],
        },
      },
      select: { id: true },
    });
    await prisma.activityQualificationRuleSet.update({
      where: { id: ruleSet.id },
      data: { statusCode: 'active' },
    });
    const [firstA, secondA, firstB, secondB] = await Promise.all([
      createActiveApplicant('queue-a-first', 'L4'),
      createActiveApplicant('queue-a-second', 'L3'),
      createActiveApplicant('queue-b-first', 'L2'),
      createActiveApplicant('queue-b-second', 'L1'),
    ]);
    const submits = [
      { applicant: firstA, positionId: scenario.positionId, key: 'a-first' },
      { applicant: secondA, positionId: scenario.positionId, key: 'a-second' },
      { applicant: firstB, positionId: secondPosition.id, key: 'b-first' },
      { applicant: secondB, positionId: secondPosition.id, key: 'b-second' },
    ];
    for (const submit of submits) {
      const response = await request(httpServer(app))
        .post(registrationPath(scenario.activityId))
        .set('Authorization', submit.applicant.auth)
        .send({
          operationKey: `batch4-position-queue-${submit.key}-${sequence}`,
          formVersion: null,
          answers: [],
          preferences: [{ sessionId: scenario.sessionId, positionIds: [submit.positionId] }],
        });
      expect(response.status).toBe(201);
    }
    await prisma.activity.update({
      where: { id: scenario.activityId },
      data: { registrationDeadline: new Date('2020-01-01T00:00:00.000Z') },
    });
    const prepared = await request(httpServer(app))
      .post(allocationBatchesPath(scenario.activityId))
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch4-position-queue-prepare-${sequence}`,
        sessionId: scenario.sessionId,
      });
    expect(prepared.status).toBe(201);
    const committed = await request(httpServer(app))
      .post(`${allocationBatchesPath(scenario.activityId)}/${prepared.body.data.batch.batchId}/commit`)
      .set('Authorization', managerAuth)
      .send({ operationKey: `batch4-position-queue-commit-${sequence}` });
    expect(committed.status).toBe(200);

    const identities = await prisma.activityParticipationIdentity.findMany({
      where: { activityId: scenario.activityId },
      select: { id: true, memberId: true },
    });
    const identityByMember = new Map(identities.map((identity) => [identity.memberId, identity.id]));
    const candidateByIdentity = new Map(
      committed.body.data.batch.candidates.map(
        (candidate: { participationIdentityId: string }) => [candidate.participationIdentityId, candidate],
      ),
    );
    expect(candidateByIdentity.get(identityByMember.get(secondA.memberId)!)).toEqual(
      expect.objectContaining({ qualificationScore: '90.0000', resultCode: 'waitlisted', waitlistRank: 1 }),
    );
    expect(candidateByIdentity.get(identityByMember.get(secondB.memberId)!)).toEqual(
      expect.objectContaining({ qualificationScore: '70.0000', resultCode: 'waitlisted', waitlistRank: 1 }),
    );
  });

  it('accepts a scoped invitation through the canonical command and first_come allocation chain', async () => {
    const scenario = await createCandidateScenario({ allocationModeCode: 'first_come', capacity: 1 });
    await prisma.activity.update({
      where: { id: scenario.activityId },
      data: { isPublicRegistration: false },
    });
    const created = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${scenario.activityId}/invitations`)
      .set('Authorization', managerAuth)
      .send({
        memberId: applicantMemberId,
        sessionId: scenario.sessionId,
        positionId: scenario.positionId,
        expiresAt: '2099-12-31T23:59:59.000Z',
      });
    expect(created.status).toBe(201);
    const invitationId = created.body.data.invitationId as string;
    const acceptance = {
      operationKey: `batch4-invitation-accept-${sequence}`,
      formVersion: null,
      answers: [],
      preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
    };
    const accepted = await request(httpServer(app))
      .post(`/api/app/v1/my/activity-invitations/${invitationId}/accept`)
      .set('Authorization', applicantAuth)
      .send(acceptance);
    expect(accepted.status).toBe(201);
    const acceptedReplay = await request(httpServer(app))
      .post(`/api/app/v1/my/activity-invitations/${invitationId}/accept`)
      .set('Authorization', applicantAuth)
      .send(acceptance);
    expect(acceptedReplay.status).toBe(201);
    expect(acceptedReplay.body.data).toEqual(accepted.body.data);

    const [invitation, identity] = await Promise.all([
      prisma.activityInvitation.findUniqueOrThrow({
        where: { id: invitationId },
        select: { statusCode: true, operationKey: true, requestHash: true, respondedAt: true },
      }),
      prisma.activityParticipationIdentity.findFirstOrThrow({
        where: { activityId: scenario.activityId, memberId: applicantMemberId },
        select: { currentStatusCode: true, currentPositionId: true, capacityReservationId: true },
      }),
    ]);
    expect(invitation).toEqual(
      expect.objectContaining({
        statusCode: 'accepted',
        operationKey: acceptance.operationKey,
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        respondedAt: expect.any(Date),
      }),
    );
    expect(identity).toEqual(
      expect.objectContaining({
        currentStatusCode: 'pass',
        currentPositionId: scenario.positionId,
        capacityReservationId: expect.any(String),
      }),
    );
  });

  it('keeps lottery seed concealed at prepare, verifies its commitment at commit, and replays commit exactly', async () => {
    const scenario = await createCandidateScenario({ allocationModeCode: 'lottery', capacity: 1 });
    const secondUser = await createTestUser(app, {
      username: `batch4-lottery-second-${sequence}`,
      role: Role.USER,
    });
    const secondMember = await prisma.member.create({
      data: {
        memberNo: `B4-LOTTERY-SECOND-${sequence}`,
        displayName: 'Batch4 Lottery Second',
        gradeCode: 'L1',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    await prisma.user.update({
      where: { id: secondUser.id },
      data: { memberId: secondMember.id },
    });
    const secondAuth = (await loginAs(app, secondUser.username)).authHeader;
    const command = {
      formVersion: null,
      answers: [],
      preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
    };
    const [first, second] = await Promise.all([
      request(httpServer(app))
        .post(registrationPath(scenario.activityId))
        .set('Authorization', applicantAuth)
        .send({ ...command, operationKey: `batch4-lottery-first-${sequence}` }),
      request(httpServer(app))
        .post(registrationPath(scenario.activityId))
        .set('Authorization', secondAuth)
        .send({ ...command, operationKey: `batch4-lottery-second-${sequence}` }),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    await prisma.activity.update({
      where: { id: scenario.activityId },
      data: { registrationDeadline: new Date('2020-01-01T00:00:00.000Z') },
    });

    const prepared = await request(httpServer(app))
      .post(allocationBatchesPath(scenario.activityId))
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch4-lottery-prepare-${sequence}`,
        sessionId: scenario.sessionId,
        positionId: scenario.positionId,
      });
    expect(prepared.status).toBe(201);
    expect(prepared.body.data.batch.randomSeedReveal).toBeNull();
    expect(
      prepared.body.data.batch.candidates.every(
        (candidate: { lotteryOrder: number | null }) => candidate.lotteryOrder === null,
      ),
    ).toBe(true);
    const batchId = prepared.body.data.batch.batchId as string;
    const beforeCommit = await prisma.activityAllocationBatch.findUniqueOrThrow({
      where: { id: batchId },
      select: { randomCommitment: true, randomSeedReveal: true },
    });
    expect(beforeCommit.randomCommitment).toMatch(/^[a-f0-9]{64}$/);
    expect(beforeCommit.randomSeedReveal).toBeNull();

    const commitBody = { operationKey: `batch4-lottery-commit-${sequence}` };
    const committed = await request(httpServer(app))
      .post(`${allocationBatchesPath(scenario.activityId)}/${batchId}/commit`)
      .set('Authorization', managerAuth)
      .send(commitBody);
    expect(committed.status).toBe(200);
    const reveal = committed.body.data.batch.randomSeedReveal as string;
    expect(reveal).toMatch(/^[a-f0-9]{64}$/);
    expect(createHash('sha256').update(reveal, 'utf8').digest('hex')).toBe(
      beforeCommit.randomCommitment,
    );
    expect(
      committed.body.data.batch.candidates
        .map((candidate: { lotteryOrder: number | null }) => candidate.lotteryOrder)
        .sort((left: number, right: number) => left - right),
    ).toEqual([1, 2]);
    expect(
      committed.body.data.batch.candidates.filter(
        (candidate: { resultCode: string | null }) => candidate.resultCode === 'allocated',
      ),
    ).toHaveLength(1);
    const commitReplay = await request(httpServer(app))
      .post(`${allocationBatchesPath(scenario.activityId)}/${batchId}/commit`)
      .set('Authorization', managerAuth)
      .send(commitBody);
    expect(commitReplay.status).toBe(200);
    expect(commitReplay.body.data).toEqual(committed.body.data);
  });
});
