import type { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  BindingScopeType,
  BindingStatus,
  MemberStatus,
  PrincipalType,
  Role,
  UserStatus,
} from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { createCandidateSnapshotHash } from '../../src/modules/activity-registrations/activity-allocation-request-hash';
import { loginAs } from '../fixtures/auth.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

const FAR = {
  startAt: new Date('2099-12-15T08:00:00.000Z'),
  endAt: new Date('2099-12-15T12:00:00.000Z'),
  deadline: new Date('2099-12-14T23:59:59.000Z'),
};

describe('activity batch4 allocation runtime', () => {
  let app: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;
  let prismaB: PrismaService;
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
    appB = await createTestApp();
    prisma = app.get(PrismaService);
    prismaB = appB.get(PrismaService);
    activityOwnerRoleId = (await seedActivityResponsibilitySystemRoles(app))['activity-owner'];

    const [manager, applicant] = await Promise.all([
      createTestUser(app, { username: 'batch4-allocation-manager', role: Role.USER }),
      createTestUser(app, { username: 'batch4-allocation-applicant', role: Role.USER }),
    ]);
    const [managerMember, applicantMember] = await Promise.all([
      prisma.member.create({
        data: {
          memberNo: 'B4-ALLOCATION-MANAGER',
          ...memberIdentityData('Batch4 Allocation Manager'),
          gradeCode: 'L1',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      }),
      prisma.member.create({
        data: {
          memberNo: 'B4-ALLOCATION-APPLICANT',
          ...memberIdentityData('Batch4 Allocation Applicant'),
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
    await Promise.all([app.close(), appB.close()]);
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

  async function createActiveApplicant(
    label: string,
    gradeCode: string,
  ): Promise<{
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
        ...memberIdentityData(`Batch4 ${label}`),
        gradeCode,
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    return { auth: (await loginAs(app, user.username)).authHeader, memberId: member.id };
  }

  async function waitForActivityRootLockWaiter(): Promise<void> {
    const deadline = Date.now() + 8_000;
    let observed = 0;
    while (Date.now() < deadline) {
      const [row] = await prisma.$queryRaw<Array<{ waitingCount: number }>>`
        SELECT count(*)::int AS "waitingCount"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query LIKE '%FROM "Activity"%FOR UPDATE%'
      `;
      observed = row?.waitingCount ?? 0;
      if (observed >= 1) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`expected an Activity root-lock waiter, observed ${observed}`);
  }

  /**
   * 等到有事务卡在 Member 生命周期行锁上 —— `lockMemberLifecycle` 就是这条 SQL。
   * 它是「递补事务已经选出队首、正等在锁后重验那一步」的可观测证据。
   */
  async function waitForMemberLifecycleLockWaiter(): Promise<boolean> {
    // ⚠️ 这个窗口必须**明显短于 Prisma 的 5s 交互事务预算**。窗口开太大时,重验缺失的那一版
    // 会在这里耗光事务预算、以 500 收场 —— 用例照样红,但红的是「事务超时」这个仪器假象,
    // 真症状(已离队的人被录取了)反而被盖住。有重验时等待只需毫秒级,2s 绰绰有余。
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const [row] = await prisma.$queryRaw<Array<{ waitingCount: number }>>`
        SELECT count(*)::int AS "waitingCount"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query LIKE '%FROM "Member"%FOR UPDATE%'
      `;
      if ((row?.waitingCount ?? 0) >= 1) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // 刻意**不抛** —— 重验缺失时压根不会有人等这把锁,抛在这里会让用例红在屏障上,
    // 把真正的症状(已离队的人被录取了)藏在后面。让它返回 false,先让行为断言说话。
    return false;
  }

  function identityOf(activityId: string, memberId: string) {
    return prisma.activityParticipationIdentity.findFirstOrThrow({
      where: { activityId, memberId },
      select: {
        currentStatusCode: true,
        currentPositionId: true,
        populationIncluded: true,
        capacityReservationId: true,
      },
    });
  }

  /**
   * first_come 单名额队列:holder 占住唯一名额,head / runnerUp 依次候补。
   * 队列次序由**服务器受理事实** `effectiveAt` 决定,这里显式写死以免依赖 HTTP 时钟抖动。
   */
  async function buildFirstComeQueue(label: string): Promise<{
    activityId: string;
    positionId: string;
    holderRegistrationId: string;
    head: { auth: string; memberId: string };
    runnerUp: { auth: string; memberId: string };
  }> {
    const scenario = await createCandidateScenario({
      allocationModeCode: 'first_come',
      capacity: 1,
    });
    const head = await createActiveApplicant(`${label}-head`, 'L1');
    const runnerUp = await createActiveApplicant(`${label}-runner`, 'L1');
    const body = {
      formVersion: null,
      answers: [],
      preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
    };
    const submit = async (auth: string, key: string) => {
      const response = await request(httpServer(app))
        .post(registrationPath(scenario.activityId))
        .set('Authorization', auth)
        .send({ ...body, operationKey: `${label}-${key}-${sequence}` });
      expect(response.status).toBe(201);
      return response.body.data.registrationId as string;
    };
    const holderRegistrationId = await submit(applicantAuth, 'holder');
    await submit(head.auth, 'head');
    await submit(runnerUp.auth, 'runner');

    const revisions = await prisma.activityParticipationRevision.findMany({
      where: {
        statusCode: 'waitlisted',
        identity: {
          activityId: scenario.activityId,
          memberId: { in: [head.memberId, runnerUp.memberId] },
        },
      },
      select: { id: true, identity: { select: { memberId: true } } },
    });
    const revisionByMember = new Map(revisions.map((r) => [r.identity.memberId, r.id]));
    await prisma.activityParticipationRevision.update({
      where: { id: revisionByMember.get(head.memberId)! },
      data: { effectiveAt: new Date('2025-01-01T00:00:00.000Z') },
    });
    await prisma.activityParticipationRevision.update({
      where: { id: revisionByMember.get(runnerUp.memberId)! },
      data: { effectiveAt: new Date('2025-01-02T00:00:00.000Z') },
    });

    // 起点也要钉住:head 现在确实是队首、且确实还是候补,后面的断言才有意义。
    expect(await identityOf(scenario.activityId, head.memberId)).toEqual(
      expect.objectContaining({ currentStatusCode: 'waitlisted', populationIncluded: false }),
    );
    return {
      activityId: scenario.activityId,
      positionId: scenario.positionId,
      holderRegistrationId,
      head,
      runnerUp,
    };
  }

  function holdActivityRootLock(activityId: string) {
    let markAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = prismaB.$transaction(
      async (tx) => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Activity" WHERE "id" = ${activityId} FOR UPDATE
        `;
        markAcquired();
        await gate;
      },
      { maxWait: 60_000, timeout: 60_000 },
    );
    return { acquired, release, done };
  }

  it('proves allocation concurrency uses two independent Prisma pools', async () => {
    expect(prisma).not.toBe(prismaB);
    const [[left], [right]] = await Promise.all([
      prisma.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
      prismaB.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
    ]);
    expect(left?.pid).not.toBe(right?.pid);
  });

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

  it('red-first: rereads D-5 after the Activity lock before preparing an allocation batch', async () => {
    const scenario = await createCandidateScenario({ allocationModeCode: 'qualification_rank' });
    const submitted = await request(httpServer(app))
      .post(registrationPath(scenario.activityId))
      .set('Authorization', applicantAuth)
      .send({
        operationKey: `batch4-allocation-d5-submit-${sequence}`,
        formVersion: null,
        answers: [],
        preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
      });
    expect(submitted.status).toBe(201);
    await prisma.activity.update({
      where: { id: scenario.activityId },
      data: { registrationDeadline: new Date('2020-01-01T00:00:00.000Z') },
    });

    const lock = holdActivityRootLock(scenario.activityId);
    await lock.acquired;
    let released = false;
    const prepared = request(httpServer(app))
      .post(allocationBatchesPath(scenario.activityId))
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch4-allocation-d5-prepare-${sequence}`,
        sessionId: scenario.sessionId,
      })
      .then((response) => response);
    try {
      await waitForActivityRootLockWaiter();
      await prisma.user.update({
        where: { id: managerUserId },
        data: { status: UserStatus.DISABLED },
      });
      lock.release();
      released = true;

      const response = await prepared;
      expect(response.status).toBe(403);
      expect(response.body.code).toBe(BizCode.FORBIDDEN.code);
    } finally {
      if (!released) lock.release();
      await lock.done;
      await prisma.user.update({
        where: { id: managerUserId },
        data: { status: UserStatus.ACTIVE },
      });
      await prepared.catch(() => undefined);
    }
  });

  it('red-first: first_come independently passes the first accepted session applicant and queues the next', async () => {
    const scenario = await createCandidateScenario({
      allocationModeCode: 'first_come',
      capacity: 1,
    });
    const secondUser = await createTestUser(app, {
      username: `batch4-first-come-second-${sequence}`,
      role: Role.USER,
    });
    const secondMember = await prisma.member.create({
      data: {
        memberNo: `B4-FIRST-COME-SECOND-${sequence}`,
        ...memberIdentityData('Batch4 First Come Second'),
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
      request(httpServer(appB))
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
    expect(
      identities.filter((identity) => identity.currentStatusCode === 'waitlisted'),
    ).toHaveLength(1);
    expect(
      identities.find((identity) => identity.currentStatusCode === 'pass')?.currentPositionId,
    ).toBe(scenario.positionId);
    expect(
      identities.find((identity) => identity.currentStatusCode === 'waitlisted')
        ?.capacityReservationId,
    ).toBeNull();
  });

  it('keeps first_come session capacity independent when one submitted session is already full', async () => {
    const scenario = await createCandidateScenario({
      allocationModeCode: 'first_come',
      capacity: 2,
    });
    const secondSession = await prisma.activitySession.create({
      data: {
        activityId: scenario.activityId,
        code: `allocation-first-come-second-session-${sequence}`,
        name: `Allocation First Come Second Session ${sequence}`,
        startAt: FAR.startAt,
        endAt: FAR.endAt,
        locationText: 'Allocation Field B',
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
    const secondPosition = await prisma.activitySessionPosition.create({
      data: {
        activityId: scenario.activityId,
        sessionId: secondSession.id,
        code: `allocation-first-come-second-position-${sequence}`,
        name: `Allocation First Come Second Position ${sequence}`,
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
          scopeId: secondSession.id,
          capacity: 1,
        },
        {
          activityId: scenario.activityId,
          scopeTypeCode: 'position_participation',
          scopeId: secondPosition.id,
          capacity: 1,
        },
      ],
    });
    const second = await createActiveApplicant('fc-independent', 'L1');
    const firstSubmission = await request(httpServer(app))
      .post(registrationPath(scenario.activityId))
      .set('Authorization', applicantAuth)
      .send({
        operationKey: `batch4-first-come-independent-first-${sequence}`,
        formVersion: null,
        answers: [],
        preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
      });
    expect(firstSubmission.status).toBe(201);
    const secondSubmission = await request(httpServer(app))
      .post(registrationPath(scenario.activityId))
      .set('Authorization', second.auth)
      .send({
        operationKey: `batch4-first-come-independent-second-${sequence}`,
        formVersion: null,
        answers: [],
        preferences: [
          { sessionId: scenario.sessionId, positionIds: [scenario.positionId] },
          { sessionId: secondSession.id, positionIds: [secondPosition.id] },
        ],
      });
    expect(secondSubmission.status).toBe(201);
    const secondIdentities = await prisma.activityParticipationIdentity.findMany({
      where: { registrationId: secondSubmission.body.data.registrationId as string },
      select: { sessionId: true, currentStatusCode: true, currentPositionId: true },
    });
    const bySession = new Map(secondIdentities.map((identity) => [identity.sessionId, identity]));
    expect(bySession.get(scenario.sessionId)).toEqual(
      expect.objectContaining({ currentStatusCode: 'waitlisted', currentPositionId: null }),
    );
    expect(bySession.get(secondSession.id)).toEqual(
      expect.objectContaining({ currentStatusCode: 'pass', currentPositionId: secondPosition.id }),
    );
    expect(
      await prisma.activityAllocationBatch.count({ where: { activityId: scenario.activityId } }),
    ).toBe(0);
  });

  it('uses first_come server acceptance facts rather than review timestamps for promotion order', async () => {
    const scenario = await createCandidateScenario({
      allocationModeCode: 'first_come',
      capacity: 1,
    });
    const second = await createActiveApplicant('fc-review-2', 'L1');
    const third = await createActiveApplicant('fc-review-3', 'L1');
    const submissionBody = {
      formVersion: null,
      answers: [],
      preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
    };
    const firstSubmitted = await request(httpServer(app))
      .post(registrationPath(scenario.activityId))
      .set('Authorization', applicantAuth)
      .send({ ...submissionBody, operationKey: `batch4-fc-review-first-${sequence}` });
    const secondSubmitted = await request(httpServer(app))
      .post(registrationPath(scenario.activityId))
      .set('Authorization', second.auth)
      .send({ ...submissionBody, operationKey: `batch4-fc-review-second-${sequence}` });
    const thirdSubmitted = await request(httpServer(app))
      .post(registrationPath(scenario.activityId))
      .set('Authorization', third.auth)
      .send({ ...submissionBody, operationKey: `batch4-fc-review-third-${sequence}` });
    expect(firstSubmitted.status).toBe(201);
    expect(secondSubmitted.status).toBe(201);
    expect(thirdSubmitted.status).toBe(201);
    const waitlistRevisions = await prisma.activityParticipationRevision.findMany({
      where: {
        identity: {
          activityId: scenario.activityId,
          memberId: { in: [second.memberId, third.memberId] },
        },
      },
      select: { id: true, identity: { select: { memberId: true } } },
    });
    const revisionByMember = new Map(
      waitlistRevisions.map((revision) => [revision.identity.memberId, revision.id]),
    );
    // These effectiveAt values are the controlled server-acceptance facts. The reverse review
    // timestamps model an unrelated later manager action which must not reorder the queue.
    await Promise.all([
      prisma.activityParticipationRevision.update({
        where: { id: revisionByMember.get(second.memberId)! },
        data: { effectiveAt: new Date('2025-01-01T00:00:00.000Z') },
      }),
      prisma.activityParticipationRevision.update({
        where: { id: revisionByMember.get(third.memberId)! },
        data: { effectiveAt: new Date('2025-01-02T00:00:00.000Z') },
      }),
      prisma.activityRegistration.update({
        where: { id: secondSubmitted.body.data.registrationId as string },
        data: { reviewedAt: new Date('2099-01-01T00:00:00.000Z') },
      }),
      prisma.activityRegistration.update({
        where: { id: thirdSubmitted.body.data.registrationId as string },
        data: { reviewedAt: new Date('2000-01-01T00:00:00.000Z') },
      }),
    ]);

    const cancelled = await request(httpServer(app))
      .patch(
        `/api/app/v1/my/registrations/${firstSubmitted.body.data.registrationId as string}/cancel`,
      )
      .set('Authorization', applicantAuth)
      .send({ cancelReason: 'free one first-come slot' });
    expect(cancelled.status).toBe(200);
    const after = await prisma.activityParticipationIdentity.findMany({
      where: { activityId: scenario.activityId },
      select: { memberId: true, currentStatusCode: true, currentPositionId: true },
    });
    const afterByMember = new Map(after.map((identity) => [identity.memberId, identity]));
    expect(afterByMember.get(second.memberId)).toEqual(
      expect.objectContaining({
        currentStatusCode: 'pass',
        currentPositionId: scenario.positionId,
      }),
    );
    expect(afterByMember.get(third.memberId)).toEqual(
      expect.objectContaining({ currentStatusCode: 'waitlisted', currentPositionId: null }),
    );
  });

  it('候补队首在被锁定选出之后才离队 ⇒ 递补跳过他,取消本身仍成功(锁后重验,不是锁前过滤)', async () => {
    // 第六轮评审 C-BLOCKER-1。这条用例的价值全在**时序**上:直接插一个已经非 ACTIVE 的
    // 候选只能证明「锁前过滤」有效,证明不了「锁后重验」—— 队首必须在递补事务**已经把他
    // 选出来并锁住**之后才转非 ACTIVE。屏障事务先握住队首的 Member 行,递补事务因此会卡在
    // 重验那一步;此刻它已经走过 `lockFirstComeWaitlistHead`,才由屏障提交离队。

    // ① 对照组:队首全程 ACTIVE —— 先钉住「这套夹具真的会递补」。
    //    没有这一半,下面的「没被录取」可能只是夹具坏了,而不是重验起了作用。
    const control = await buildFirstComeQueue('fc-recheck-control');
    const controlCancelled = await request(httpServer(app))
      .patch(`/api/app/v1/my/registrations/${control.holderRegistrationId}/cancel`)
      .set('Authorization', applicantAuth)
      .send({ cancelReason: 'control: free the only first-come slot' });
    expect(controlCancelled.status).toBe(200);
    expect(await identityOf(control.activityId, control.head.memberId)).toEqual(
      expect.objectContaining({
        currentStatusCode: 'pass',
        currentPositionId: control.positionId,
        populationIncluded: true,
      }),
    );

    // ② 被测组:同样的队列,唯一不同是队首在递补事务在途时离队。
    const subject = await buildFirstComeQueue('fc-recheck-subject');

    let markAcquired!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = prismaB.$transaction(
      async (tx) => {
        await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "Member" WHERE "id" = ${subject.head.memberId} FOR UPDATE
          `;
        markAcquired();
        await gate;
        // 走到这里时递补事务已经选出队首、正卡在 Member 行锁上 —— 现在才让他离队。
        await tx.$executeRaw`
            UPDATE "Member" SET "status" = 'INACTIVE' WHERE "id" = ${subject.head.memberId}
          `;
      },
      { maxWait: 60_000, timeout: 60_000 },
    );
    await acquired;

    const cancelling = request(httpServer(app))
      .patch(`/api/app/v1/my/registrations/${subject.holderRegistrationId}/cancel`)
      .set('Authorization', applicantAuth)
      .send({ cancelReason: 'subject: free the only first-come slot' })
      .then((response) => response);

    // 卡住的这一刻就是时序证据:递补事务已经过了队首选取,正等在**锁后**的那次重读上。
    const blockedOnRecheck = await waitForMemberLifecycleLockWaiter();
    release();
    await blocker;

    const cancelled = await cancelling;
    // 一个候选不合格不该炸掉整批取消 —— 取消必须照常成功。
    expect(cancelled.status).toBe(200);

    expect(
      await prisma.member.findUniqueOrThrow({
        where: { id: subject.head.memberId },
        select: { status: true },
      }),
    ).toEqual({ status: MemberStatus.INACTIVE });

    // 队首没有被录取:状态、岗位、人口投影三处都不能动。
    expect(await identityOf(subject.activityId, subject.head.memberId)).toEqual(
      expect.objectContaining({
        currentStatusCode: 'waitlisted',
        currentPositionId: null,
        populationIncluded: false,
        capacityReservationId: null,
      }),
    );
    expect(
      await prisma.activityParticipationRevision.count({
        where: {
          statusCode: 'pass',
          identity: { activityId: subject.activityId, memberId: subject.head.memberId },
        },
      }),
    ).toBe(0);

    // 本轮该名额空着等管理员安排 —— 与「跳过这个名额」的既有递补语义一致,
    // 不会顺位把下一个人拉上来(那属于改选人算法)。
    expect(await identityOf(subject.activityId, subject.runnerUp.memberId)).toEqual(
      expect.objectContaining({ currentStatusCode: 'waitlisted', currentPositionId: null }),
    );

    // 最后才断时序证据:上面的行为对了,也得是**锁后重验**换来的,不能是锁前过滤蒙对的。
    expect(blockedOnRecheck).toBe(true);
  }, 90_000);

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
        ...memberIdentityData('Batch4 Rank Second'),
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
          create: [
            {
              ruleTypeCode: 'grade',
              enforcementCode: 'warn',
              operator: 'in',
              valueJson: { codes: ['L2'] },
              warnScore: 20,
              sortOrder: 1,
            },
            {
              ruleTypeCode: 'grade',
              enforcementCode: 'warn',
              operator: 'in',
              valueJson: { codes: ['L2'] },
              warnScore: 7,
              sortOrder: 2,
            },
            {
              ruleTypeCode: 'grade',
              enforcementCode: 'warn',
              operator: 'in',
              valueJson: { codes: ['L2'] },
              warnScore: 0,
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
    const preparedConflict = await request(httpServer(app))
      .post(allocationBatchesPath(scenario.activityId))
      .set('Authorization', managerAuth)
      .send({ operationKey: prepareBody.operationKey, sessionId: scenario.sessionId });
    expect(preparedConflict.status).toBe(
      BizCode.ACTIVITY_REGISTRATION_OPERATION_KEY_CONFLICT.httpStatus,
    );
    expect(preparedConflict.body.code).toBe(
      BizCode.ACTIVITY_REGISTRATION_OPERATION_KEY_CONFLICT.code,
    );

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
    const committedCandidates = committed.body.data.batch.candidates as Array<{
      participationIdentityId: string;
    }>;
    const byIdentity = new Map(
      committedCandidates.map((candidate) => [candidate.participationIdentityId, candidate]),
    );
    expect(byIdentity.get(secondIdentity.id)).toEqual(
      expect.objectContaining({ qualificationScore: '100.0000', resultCode: 'allocated' }),
    );
    expect(byIdentity.get(firstIdentity.id)).toEqual(
      expect.objectContaining({
        qualificationScore: '73.0000',
        resultCode: 'waitlisted',
        waitlistRank: 1,
      }),
    );
    const frozenWarningExplanation = await prisma.activityAllocationCandidate.findFirstOrThrow({
      where: { allocationBatchId: batchId, participationIdentityId: firstIdentity.id },
      select: { explanation: true },
    });
    expect(frozenWarningExplanation.explanation).toEqual(
      expect.objectContaining({
        aggregateResultCode: 'warn',
        penalty: 27,
        qualificationScore: '73.0000',
        ruleSets: expect.arrayContaining([
          expect.objectContaining({
            rules: expect.arrayContaining([
              expect.objectContaining({ warnScore: 0, resultCode: 'warn' }),
            ]),
          }),
        ]),
      }),
    );
  });

  it('freezes fail candidates for audit but excludes them from rank allocation and waitlists', async () => {
    const scenario = await createCandidateScenario({ allocationModeCode: 'qualification_rank' });
    const passing = await createActiveApplicant('rank-fail-control', 'L2');
    const submissionBody = {
      formVersion: null,
      answers: [],
      preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
    };
    const [failedSubmission, passingSubmission] = await Promise.all([
      request(httpServer(app))
        .post(registrationPath(scenario.activityId))
        .set('Authorization', applicantAuth)
        .send({ ...submissionBody, operationKey: `batch4-rank-fail-submission-${sequence}` }),
      request(httpServer(app))
        .post(registrationPath(scenario.activityId))
        .set('Authorization', passing.auth)
        .send({ ...submissionBody, operationKey: `batch4-rank-pass-submission-${sequence}` }),
    ]);
    expect(failedSubmission.status).toBe(201);
    expect(passingSubmission.status).toBe(201);
    const ruleSet = await prisma.activityQualificationRuleSet.create({
      data: {
        activityId: scenario.activityId,
        version: 1,
        statusCode: 'draft',
        rules: {
          create: {
            ruleTypeCode: 'grade',
            enforcementCode: 'block',
            operator: 'in',
            valueJson: { codes: ['L2'] },
            warnScore: null,
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
    await prisma.activity.update({
      where: { id: scenario.activityId },
      data: { registrationDeadline: new Date('2020-01-01T00:00:00.000Z') },
    });
    const prepared = await request(httpServer(app))
      .post(allocationBatchesPath(scenario.activityId))
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch4-rank-fail-prepare-${sequence}`,
        sessionId: scenario.sessionId,
        positionId: scenario.positionId,
      });
    expect(prepared.status).toBe(201);
    const batchId = prepared.body.data.batch.batchId as string;
    expect(
      prepared.body.data.batch.candidates.some(
        (candidate: { qualificationResultCode: string }) =>
          candidate.qualificationResultCode === 'fail',
      ),
    ).toBe(true);
    const committed = await request(httpServer(app))
      .post(`${allocationBatchesPath(scenario.activityId)}/${batchId}/commit`)
      .set('Authorization', managerAuth)
      .send({ operationKey: `batch4-rank-fail-commit-${sequence}` });
    expect(committed.status).toBe(200);
    const identities = await prisma.activityParticipationIdentity.findMany({
      where: { activityId: scenario.activityId },
      select: { id: true, memberId: true, capacityReservationId: true, currentStatusCode: true },
    });
    const identityByMember = new Map(identities.map((identity) => [identity.memberId, identity]));
    const committedCandidates = committed.body.data.batch.candidates as Array<{
      participationIdentityId: string;
    }>;
    const candidateByIdentity = new Map(
      committedCandidates.map((candidate) => [candidate.participationIdentityId, candidate]),
    );
    const failedIdentity = identityByMember.get(applicantMemberId)!;
    const passingIdentity = identityByMember.get(passing.memberId)!;
    expect(candidateByIdentity.get(failedIdentity.id)).toEqual(
      expect.objectContaining({
        qualificationResultCode: 'fail',
        qualificationScore: null,
        resultCode: 'not_selected',
        waitlistRank: null,
        waitlistPositionId: null,
      }),
    );
    expect(failedIdentity).toEqual(
      expect.objectContaining({ currentStatusCode: 'not_selected', capacityReservationId: null }),
    );
    expect(candidateByIdentity.get(passingIdentity.id)).toEqual(
      expect.objectContaining({ qualificationResultCode: 'pass', resultCode: 'allocated' }),
    );
  });

  it('uses acceptedAt then UTF-8 participation identity to break equal rank scores', async () => {
    const scenario = await createCandidateScenario({ allocationModeCode: 'qualification_rank' });
    const second = await createActiveApplicant('rank-tiebreak', 'L1');
    const submissionBody = {
      formVersion: null,
      answers: [],
      preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
    };
    const [firstSubmission, secondSubmission] = await Promise.all([
      request(httpServer(app))
        .post(registrationPath(scenario.activityId))
        .set('Authorization', applicantAuth)
        .send({ ...submissionBody, operationKey: `batch4-rank-tiebreak-first-${sequence}` }),
      request(httpServer(app))
        .post(registrationPath(scenario.activityId))
        .set('Authorization', second.auth)
        .send({ ...submissionBody, operationKey: `batch4-rank-tiebreak-second-${sequence}` }),
    ]);
    expect(firstSubmission.status).toBe(201);
    expect(secondSubmission.status).toBe(201);
    const identities = await prisma.activityParticipationIdentity.findMany({
      where: { activityId: scenario.activityId },
      select: { id: true, registrationId: true },
    });
    expect(identities).toHaveLength(2);
    // Equalize the two immutable acceptance facts only to reach the documented secondary sort.
    // The winner must then be the bytewise-smallest permanent identity, never DB return order.
    await prisma.activityRegistrationRevision.updateMany({
      where: { registrationId: { in: identities.map((identity) => identity.registrationId) } },
      data: { submittedAt: new Date('2025-01-02T03:04:05.000Z') },
    });
    await prisma.activity.update({
      where: { id: scenario.activityId },
      data: { registrationDeadline: new Date('2020-01-01T00:00:00.000Z') },
    });
    const prepared = await request(httpServer(app))
      .post(allocationBatchesPath(scenario.activityId))
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch4-rank-tiebreak-prepare-${sequence}`,
        sessionId: scenario.sessionId,
        positionId: scenario.positionId,
      });
    expect(prepared.status).toBe(201);
    const batchId = prepared.body.data.batch.batchId as string;
    const committed = await request(httpServer(app))
      .post(`${allocationBatchesPath(scenario.activityId)}/${batchId}/commit`)
      .set('Authorization', managerAuth)
      .send({ operationKey: `batch4-rank-tiebreak-commit-${sequence}` });
    expect(committed.status).toBe(200);
    const expectedWinnerId = identities.map((identity) => identity.id).sort()[0];
    const allocated = committed.body.data.batch.candidates.find(
      (candidate: { resultCode: string | null }) => candidate.resultCode === 'allocated',
    );
    expect(allocated).toEqual(
      expect.objectContaining({
        participationIdentityId: expectedWinnerId,
        qualificationScore: '100.0000',
      }),
    );
  });

  it('red-first: requires a committed target batch to void before replacement prepare', async () => {
    const scenario = await createCandidateScenario({ allocationModeCode: 'qualification_rank' });
    const submitted = await request(httpServer(app))
      .post(registrationPath(scenario.activityId))
      .set('Authorization', applicantAuth)
      .send({
        operationKey: `batch4-reprepare-submit-${sequence}`,
        formVersion: null,
        answers: [],
        preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
      });
    expect(submitted.status).toBe(201);
    await prisma.activity.update({
      where: { id: scenario.activityId },
      data: { registrationDeadline: new Date('2020-01-01T00:00:00.000Z') },
    });

    const initialPrepareBody = {
      operationKey: `batch4-reprepare-initial-prepare-${sequence}`,
      sessionId: scenario.sessionId,
      positionId: scenario.positionId,
    };
    const prepared = await request(httpServer(app))
      .post(allocationBatchesPath(scenario.activityId))
      .set('Authorization', managerAuth)
      .send(initialPrepareBody);
    expect(prepared.status).toBe(201);
    const batchId = prepared.body.data.batch.batchId as string;
    const committed = await request(httpServer(app))
      .post(`${allocationBatchesPath(scenario.activityId)}/${batchId}/commit`)
      .set('Authorization', managerAuth)
      .send({ operationKey: `batch4-reprepare-commit-${sequence}` });
    expect(committed.status).toBe(200);

    const targetBatchCountBefore = await prisma.activityAllocationBatch.count({
      where: {
        activityId: scenario.activityId,
        sessionId: scenario.sessionId,
        positionId: scenario.positionId,
      },
    });
    const replacementBeforeVoid = await request(httpServer(app))
      .post(allocationBatchesPath(scenario.activityId))
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch4-reprepare-before-void-${sequence}`,
        sessionId: scenario.sessionId,
        positionId: scenario.positionId,
      });
    expect(replacementBeforeVoid.status).toBe(
      BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.httpStatus,
    );
    expect(replacementBeforeVoid.body.code).toBe(
      BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.code,
    );
    expect(
      await prisma.activityAllocationBatch.count({
        where: {
          activityId: scenario.activityId,
          sessionId: scenario.sessionId,
          positionId: scenario.positionId,
        },
      }),
    ).toBe(targetBatchCountBefore);

    const voidBody = {
      operationKey: `batch4-reprepare-void-${sequence}`,
      reason: 'prepare a replacement from the restored pending facts',
    };
    const voided = await request(httpServer(app))
      .post(`${allocationBatchesPath(scenario.activityId)}/${batchId}/void`)
      .set('Authorization', managerAuth)
      .send(voidBody);
    expect(voided.status).toBe(200);
    const voidReplay = await request(httpServer(app))
      .post(`${allocationBatchesPath(scenario.activityId)}/${batchId}/void`)
      .set('Authorization', managerAuth)
      .send(voidBody);
    expect(voidReplay.status).toBe(200);
    expect(voidReplay.body.data).toEqual(voided.body.data);

    // A receipt is an immutable response fact, not a live batch lookup.  Once void has moved the
    // batch on, replaying either earlier command must still return its original safe view.
    const prepareReplayAfterVoid = await request(httpServer(app))
      .post(allocationBatchesPath(scenario.activityId))
      .set('Authorization', managerAuth)
      .send(initialPrepareBody);
    expect(prepareReplayAfterVoid.status).toBe(201);
    expect(prepareReplayAfterVoid.body.data).toEqual(prepared.body.data);
    const commitReplayAfterVoid = await request(httpServer(app))
      .post(`${allocationBatchesPath(scenario.activityId)}/${batchId}/commit`)
      .set('Authorization', managerAuth)
      .send({ operationKey: `batch4-reprepare-commit-${sequence}` });
    expect(commitReplayAfterVoid.status).toBe(200);
    expect(commitReplayAfterVoid.body.data).toEqual(committed.body.data);

    const voidConflict = await request(httpServer(app))
      .post(`${allocationBatchesPath(scenario.activityId)}/${batchId}/void`)
      .set('Authorization', managerAuth)
      .send({ ...voidBody, reason: 'different reason must not replay' });
    expect(voidConflict.status).toBe(
      BizCode.ACTIVITY_REGISTRATION_OPERATION_KEY_CONFLICT.httpStatus,
    );
    expect(voidConflict.body.code).toBe(BizCode.ACTIVITY_REGISTRATION_OPERATION_KEY_CONFLICT.code);
    const replacementAfterVoid = await request(httpServer(app))
      .post(allocationBatchesPath(scenario.activityId))
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch4-reprepare-after-void-${sequence}`,
        sessionId: scenario.sessionId,
        positionId: scenario.positionId,
      });
    expect(replacementAfterVoid.status).toBe(201);
  });

  it('serializes distinct prepare keys and replays prepare and commit through independent pools', async () => {
    const scenario = await createCandidateScenario({ allocationModeCode: 'qualification_rank' });
    const submitted = await request(httpServer(app))
      .post(registrationPath(scenario.activityId))
      .set('Authorization', applicantAuth)
      .send({
        operationKey: `batch4-concurrent-submit-${sequence}`,
        formVersion: null,
        answers: [],
        preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
      });
    expect(submitted.status).toBe(201);
    await prisma.activity.update({
      where: { id: scenario.activityId },
      data: { registrationDeadline: new Date('2020-01-01T00:00:00.000Z') },
    });

    const samePrepareBody = {
      operationKey: `batch4-concurrent-prepare-${sequence}`,
      sessionId: scenario.sessionId,
      positionId: scenario.positionId,
    };
    const samePrepares = await Promise.all([
      request(httpServer(app))
        .post(allocationBatchesPath(scenario.activityId))
        .set('Authorization', managerAuth)
        .send(samePrepareBody),
      request(httpServer(appB))
        .post(allocationBatchesPath(scenario.activityId))
        .set('Authorization', managerAuth)
        .send(samePrepareBody),
    ]);
    expect(samePrepares.map((response) => response.status)).toEqual([201, 201]);
    expect(samePrepares[0].body.data).toEqual(samePrepares[1].body.data);
    const batchId = samePrepares[0].body.data.batch.batchId as string;

    const sameCommitBody = { operationKey: `batch4-concurrent-commit-${sequence}` };
    const commits = await Promise.all([
      request(httpServer(app))
        .post(`${allocationBatchesPath(scenario.activityId)}/${batchId}/commit`)
        .set('Authorization', managerAuth)
        .send(sameCommitBody),
      request(httpServer(appB))
        .post(`${allocationBatchesPath(scenario.activityId)}/${batchId}/commit`)
        .set('Authorization', managerAuth)
        .send(sameCommitBody),
    ]);
    expect(commits.map((response) => response.status)).toEqual([200, 200]);
    expect(commits[0].body.data).toEqual(commits[1].body.data);
    expect(
      await prisma.activityAllocationCommandReceipt.count({
        where: { allocationBatchId: batchId, commandCode: 'commit' },
      }),
    ).toBe(1);

    const distinctScenario = await createCandidateScenario({
      allocationModeCode: 'qualification_rank',
    });
    const distinctSubmitted = await request(httpServer(app))
      .post(registrationPath(distinctScenario.activityId))
      .set('Authorization', applicantAuth)
      .send({
        operationKey: `batch4-concurrent-distinct-submit-${sequence}`,
        formVersion: null,
        answers: [],
        preferences: [
          { sessionId: distinctScenario.sessionId, positionIds: [distinctScenario.positionId] },
        ],
      });
    expect(distinctSubmitted.status).toBe(201);
    await prisma.activity.update({
      where: { id: distinctScenario.activityId },
      data: { registrationDeadline: new Date('2020-01-01T00:00:00.000Z') },
    });
    const distinctPrepareBodies = ['left', 'right'].map((suffix) => ({
      operationKey: `batch4-concurrent-distinct-${suffix}-${sequence}`,
      sessionId: distinctScenario.sessionId,
      positionId: distinctScenario.positionId,
    }));
    const distinctPrepares = await Promise.all([
      request(httpServer(app))
        .post(allocationBatchesPath(distinctScenario.activityId))
        .set('Authorization', managerAuth)
        .send(distinctPrepareBodies[0]),
      request(httpServer(appB))
        .post(allocationBatchesPath(distinctScenario.activityId))
        .set('Authorization', managerAuth)
        .send(distinctPrepareBodies[1]),
    ]);
    expect(
      distinctPrepares.map((response) => response.status).sort((left, right) => left - right),
    ).toEqual([201, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.httpStatus]);
  });

  it('fails closed with zero commit writes when a frozen candidate cancels and reapplies', async () => {
    const scenario = await createCandidateScenario({ allocationModeCode: 'qualification_rank' });
    const submissionBody = {
      formVersion: null,
      answers: [],
      preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
    };
    const submitted = await request(httpServer(app))
      .post(registrationPath(scenario.activityId))
      .set('Authorization', applicantAuth)
      .send({ ...submissionBody, operationKey: `batch4-commit-drift-submit-${sequence}` });
    expect(submitted.status).toBe(201);
    const registrationId = submitted.body.data.registrationId as string;
    await prisma.activity.update({
      where: { id: scenario.activityId },
      data: { registrationDeadline: new Date('2020-01-01T00:00:00.000Z') },
    });
    const prepared = await request(httpServer(app))
      .post(allocationBatchesPath(scenario.activityId))
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch4-commit-drift-prepare-${sequence}`,
        sessionId: scenario.sessionId,
        positionId: scenario.positionId,
      });
    expect(prepared.status).toBe(201);
    const batchId = prepared.body.data.batch.batchId as string;

    // The post-freeze state change deliberately travels through the two real App commands. Moving
    // the deadline only makes this stale-batch drift reproducible; it does not create the facts.
    await prisma.activity.update({
      where: { id: scenario.activityId },
      data: { registrationDeadline: FAR.deadline },
    });
    const cancelled = await request(httpServer(app))
      .patch(`/api/app/v1/my/registrations/${registrationId}/cancel`)
      .set('Authorization', applicantAuth)
      .send({ cancelReason: 'change submitted registration after batch freeze' });
    expect(cancelled.status).toBe(200);
    const reapplied = await request(httpServer(app))
      .post(registrationPath(scenario.activityId))
      .set('Authorization', applicantAuth)
      .send({ ...submissionBody, operationKey: `batch4-commit-drift-reapply-${sequence}` });
    expect(reapplied.status).toBe(201);
    expect(reapplied.body.data.registrationId).toBe(registrationId);
    await prisma.activity.update({
      where: { id: scenario.activityId },
      data: { registrationDeadline: new Date('2020-01-01T00:00:00.000Z') },
    });

    const frozen = await prisma.activityAllocationCandidate.findFirstOrThrow({
      where: { allocationBatchId: batchId },
      select: { registrationRevisionId: true },
    });
    const currentRegistration = await prisma.activityRegistration.findUniqueOrThrow({
      where: { id: registrationId },
      select: { currentRevision: true, revisions: { select: { id: true, revision: true } } },
    });
    expect(
      currentRegistration.revisions.find(
        (revision) => revision.revision === currentRegistration.currentRevision,
      )?.id,
    ).not.toBe(frozen.registrationRevisionId);
    const before = await Promise.all([
      prisma.activityAllocationBatch.findUniqueOrThrow({
        where: { id: batchId },
        select: { statusCode: true, committedAt: true },
      }),
      prisma.activityAllocationCandidate.findMany({
        where: { allocationBatchId: batchId },
        select: { resultCode: true, waitlistRank: true, lotteryOrder: true },
      }),
      prisma.activityAllocationApplicationProjection.count({
        where: { allocationBatchId: batchId },
      }),
      prisma.capacityReservation.count({
        where: { activityId: scenario.activityId, status: 'active' },
      }),
    ]);

    const commit = await request(httpServer(app))
      .post(`${allocationBatchesPath(scenario.activityId)}/${batchId}/commit`)
      .set('Authorization', managerAuth)
      .send({ operationKey: `batch4-commit-drift-commit-${sequence}` });
    expect(commit.status).toBe(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.httpStatus);
    expect(commit.body.code).toBe(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.code);
    const after = await Promise.all([
      prisma.activityAllocationBatch.findUniqueOrThrow({
        where: { id: batchId },
        select: { statusCode: true, committedAt: true },
      }),
      prisma.activityAllocationCandidate.findMany({
        where: { allocationBatchId: batchId },
        select: { resultCode: true, waitlistRank: true, lotteryOrder: true },
      }),
      prisma.activityAllocationApplicationProjection.count({
        where: { allocationBatchId: batchId },
      }),
      prisma.capacityReservation.count({
        where: { activityId: scenario.activityId, status: 'active' },
      }),
    ]);
    expect(after).toEqual(before);
  });

  it('fails closed with zero commit writes when only a frozen registration revision drifts', async () => {
    const scenario = await createCandidateScenario({ allocationModeCode: 'qualification_rank' });
    const submissionBody = {
      formVersion: null,
      answers: [],
      preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
    };
    const submitted = await request(httpServer(app))
      .post(registrationPath(scenario.activityId))
      .set('Authorization', applicantAuth)
      .send({ ...submissionBody, operationKey: `batch4-revision-drift-submit-${sequence}` });
    expect(submitted.status).toBe(201);
    const registrationId = submitted.body.data.registrationId as string;
    await prisma.activity.update({
      where: { id: scenario.activityId },
      data: { registrationDeadline: new Date('2020-01-01T00:00:00.000Z') },
    });
    const prepared = await request(httpServer(app))
      .post(allocationBatchesPath(scenario.activityId))
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch4-revision-drift-prepare-${sequence}`,
        sessionId: scenario.sessionId,
        positionId: scenario.positionId,
      });
    expect(prepared.status).toBe(201);
    const batchId = prepared.body.data.batch.batchId as string;
    const frozen = await prisma.activityAllocationCandidate.findFirstOrThrow({
      where: { allocationBatchId: batchId },
      select: { registrationRevisionId: true, acceptedAt: true },
    });

    await prisma.activity.update({
      where: { id: scenario.activityId },
      data: { registrationDeadline: FAR.deadline },
    });
    const cancelled = await request(httpServer(app))
      .patch(`/api/app/v1/my/registrations/${registrationId}/cancel`)
      .set('Authorization', applicantAuth)
      .send({ cancelReason: 'advance the canonical registration revision after batch freeze' });
    expect(cancelled.status).toBe(200);
    const reapplied = await request(httpServer(app))
      .post(registrationPath(scenario.activityId))
      .set('Authorization', applicantAuth)
      .send({ ...submissionBody, operationKey: `batch4-revision-drift-reapply-${sequence}` });
    expect(reapplied.status).toBe(201);
    await prisma.activity.update({
      where: { id: scenario.activityId },
      data: { registrationDeadline: new Date('2020-01-01T00:00:00.000Z') },
    });
    const currentRegistration = await prisma.activityRegistration.findUniqueOrThrow({
      where: { id: registrationId },
      select: { currentRevision: true, revisions: { select: { id: true, revision: true } } },
    });
    const currentRevision = currentRegistration.revisions.find(
      (revision) => revision.revision === currentRegistration.currentRevision,
    );
    expect(currentRevision?.id).toBeDefined();
    expect(currentRevision?.id).not.toBe(frozen.registrationRevisionId);
    // The real commands above establish the live revision drift.  This fixture narrows it to the
    // revision anchor only, so acceptedAt cannot mask a missing revision comparison at commit.
    await prisma.activityRegistrationRevision.update({
      where: { id: currentRevision!.id },
      data: { submittedAt: frozen.acceptedAt },
    });
    const before = await Promise.all([
      prisma.activityAllocationBatch.findUniqueOrThrow({
        where: { id: batchId },
        select: { statusCode: true, committedAt: true },
      }),
      prisma.activityAllocationCandidate.findMany({
        where: { allocationBatchId: batchId },
        select: { resultCode: true, waitlistRank: true, lotteryOrder: true },
      }),
      prisma.activityAllocationApplicationProjection.count({
        where: { allocationBatchId: batchId },
      }),
      prisma.capacityReservation.count({
        where: { activityId: scenario.activityId, status: 'active' },
      }),
    ]);
    const commit = await request(httpServer(app))
      .post(`${allocationBatchesPath(scenario.activityId)}/${batchId}/commit`)
      .set('Authorization', managerAuth)
      .send({ operationKey: `batch4-revision-drift-commit-${sequence}` });
    expect(commit.status).toBe(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.httpStatus);
    expect(commit.body.code).toBe(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.code);
    const after = await Promise.all([
      prisma.activityAllocationBatch.findUniqueOrThrow({
        where: { id: batchId },
        select: { statusCode: true, committedAt: true },
      }),
      prisma.activityAllocationCandidate.findMany({
        where: { allocationBatchId: batchId },
        select: { resultCode: true, waitlistRank: true, lotteryOrder: true },
      }),
      prisma.activityAllocationApplicationProjection.count({
        where: { allocationBatchId: batchId },
      }),
      prisma.capacityReservation.count({
        where: { activityId: scenario.activityId, status: 'active' },
      }),
    ]);
    expect(after).toEqual(before);
  });

  it('fails closed with zero commit writes when a frozen qualification hash drifts', async () => {
    const scenario = await createCandidateScenario({ allocationModeCode: 'qualification_rank' });
    const submitted = await request(httpServer(app))
      .post(registrationPath(scenario.activityId))
      .set('Authorization', applicantAuth)
      .send({
        operationKey: `batch4-qualification-hash-drift-submit-${sequence}`,
        formVersion: null,
        answers: [],
        preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
      });
    expect(submitted.status).toBe(201);
    await prisma.activity.update({
      where: { id: scenario.activityId },
      data: { registrationDeadline: new Date('2020-01-01T00:00:00.000Z') },
    });
    const prepared = await request(httpServer(app))
      .post(allocationBatchesPath(scenario.activityId))
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch4-qualification-hash-drift-prepare-${sequence}`,
        sessionId: scenario.sessionId,
        positionId: scenario.positionId,
      });
    expect(prepared.status).toBe(201);
    const batchId = prepared.body.data.batch.batchId as string;
    const [batch, frozen] = await Promise.all([
      prisma.activityAllocationBatch.findUniqueOrThrow({
        where: { id: batchId },
        select: { algorithmVersionCode: true },
      }),
      prisma.activityAllocationCandidate.findFirstOrThrow({
        where: { allocationBatchId: batchId },
        select: {
          id: true,
          participationIdentityId: true,
          registrationId: true,
          registrationRevisionId: true,
          acceptedAt: true,
          qualificationSnapshotHash: true,
          qualificationScore: true,
          tieBreakKey: true,
        },
      }),
    ]);
    const driftedQualificationHash = 'f'.repeat(64);
    expect(frozen.qualificationSnapshotHash).not.toBe(driftedQualificationHash);
    const driftedCandidateSnapshotHash = createCandidateSnapshotHash({
      activityId: scenario.activityId,
      sessionId: scenario.sessionId,
      positionId: scenario.positionId,
      modeCode: 'qualification_rank',
      algorithmVersionCode: batch.algorithmVersionCode,
      candidates: [
        {
          participationIdentityId: frozen.participationIdentityId,
          registrationId: frozen.registrationId,
          registrationRevisionId: frozen.registrationRevisionId,
          acceptedAt: frozen.acceptedAt,
          qualificationSnapshotHash: driftedQualificationHash,
          qualificationScore: frozen.qualificationScore?.toFixed(4) ?? null,
          tieBreakKey: frozen.tieBreakKey,
        },
      ],
    });
    await prisma.$transaction([
      prisma.activityAllocationCandidate.update({
        where: { id: frozen.id },
        data: { qualificationSnapshotHash: driftedQualificationHash },
      }),
      prisma.activityAllocationBatch.update({
        where: { id: batchId },
        data: { candidateSnapshotHash: driftedCandidateSnapshotHash },
      }),
    ]);
    const before = await Promise.all([
      prisma.activityAllocationBatch.findUniqueOrThrow({
        where: { id: batchId },
        select: { statusCode: true, committedAt: true },
      }),
      prisma.activityAllocationCandidate.findMany({
        where: { allocationBatchId: batchId },
        select: { resultCode: true, waitlistRank: true, lotteryOrder: true },
      }),
      prisma.activityAllocationApplicationProjection.count({
        where: { allocationBatchId: batchId },
      }),
      prisma.capacityReservation.count({
        where: { activityId: scenario.activityId, status: 'active' },
      }),
    ]);
    const commit = await request(httpServer(app))
      .post(`${allocationBatchesPath(scenario.activityId)}/${batchId}/commit`)
      .set('Authorization', managerAuth)
      .send({ operationKey: `batch4-qualification-hash-drift-commit-${sequence}` });
    expect(commit.status).toBe(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.httpStatus);
    expect(commit.body.code).toBe(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.code);
    const after = await Promise.all([
      prisma.activityAllocationBatch.findUniqueOrThrow({
        where: { id: batchId },
        select: { statusCode: true, committedAt: true },
      }),
      prisma.activityAllocationCandidate.findMany({
        where: { allocationBatchId: batchId },
        select: { resultCode: true, waitlistRank: true, lotteryOrder: true },
      }),
      prisma.activityAllocationApplicationProjection.count({
        where: { allocationBatchId: batchId },
      }),
      prisma.capacityReservation.count({
        where: { activityId: scenario.activityId, status: 'active' },
      }),
    ]);
    expect(after).toEqual(before);
  });

  it('red-first: numbers session-level qualification waitlists independently for each original position', async () => {
    const scenario = await createCandidateScenario({ allocationModeCode: 'qualification_rank' });
    await prisma.activity.update({ where: { id: scenario.activityId }, data: { capacity: 2 } });
    await prisma.activitySession.update({
      where: { id: scenario.sessionId },
      data: { capacity: 2 },
    });
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
      .post(
        `${allocationBatchesPath(scenario.activityId)}/${prepared.body.data.batch.batchId}/commit`,
      )
      .set('Authorization', managerAuth)
      .send({ operationKey: `batch4-position-queue-commit-${sequence}` });
    expect(committed.status).toBe(200);
    const read = await request(httpServer(app))
      .get(`${allocationBatchesPath(scenario.activityId)}/${prepared.body.data.batch.batchId}`)
      .set('Authorization', managerAuth);
    expect(read.status).toBe(200);

    const identities = await prisma.activityParticipationIdentity.findMany({
      where: { activityId: scenario.activityId },
      select: { id: true, memberId: true },
    });
    const identityByMember = new Map(
      identities.map((identity) => [identity.memberId, identity.id]),
    );
    const committedCandidates = committed.body.data.batch.candidates as Array<{
      participationIdentityId: string;
    }>;
    const candidateByIdentity = new Map(
      committedCandidates.map((candidate) => [candidate.participationIdentityId, candidate]),
    );
    expect(candidateByIdentity.get(identityByMember.get(secondA.memberId)!)).toEqual(
      expect.objectContaining({
        qualificationScore: '90.0000',
        resultCode: 'waitlisted',
        waitlistRank: 1,
        waitlistPositionId: scenario.positionId,
      }),
    );
    expect(candidateByIdentity.get(identityByMember.get(secondB.memberId)!)).toEqual(
      expect.objectContaining({
        qualificationScore: '70.0000',
        resultCode: 'waitlisted',
        waitlistRank: 1,
        waitlistPositionId: secondPosition.id,
      }),
    );
    expect(
      read.body.data.candidates.find(
        (candidate: { participationIdentityId: string }) =>
          candidate.participationIdentityId === identityByMember.get(secondB.memberId),
      ),
    ).toEqual(expect.objectContaining({ waitlistPositionId: secondPosition.id, waitlistRank: 1 }));
  });

  it('uses only submitted preference fallthrough during initial session-level allocation', async () => {
    const scenario = await createCandidateScenario({
      allocationModeCode: 'qualification_rank',
      capacity: 2,
    });
    await prisma.activitySession.update({
      where: { id: scenario.sessionId },
      data: { capacity: 2 },
    });
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
    const fallbackPosition = await prisma.activitySessionPosition.create({
      data: {
        activityId: scenario.activityId,
        sessionId: scenario.sessionId,
        code: `allocation-fallback-position-${sequence}`,
        name: `Allocation Fallback Position ${sequence}`,
        attendanceRoleCode: 'volunteer',
        capacity: 1,
      },
      select: { id: true },
    });
    await prisma.activityCapacityBucket.create({
      data: {
        activityId: scenario.activityId,
        scopeTypeCode: 'position_participation',
        scopeId: fallbackPosition.id,
        capacity: 1,
      },
    });
    const first = await createActiveApplicant('fallback-first', 'L2');
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
            warnScore: 10,
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
    const firstSubmitted = await request(httpServer(app))
      .post(registrationPath(scenario.activityId))
      .set('Authorization', first.auth)
      .send({
        operationKey: `batch4-fallback-first-${sequence}`,
        formVersion: null,
        answers: [],
        preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
      });
    const secondSubmitted = await request(httpServer(app))
      .post(registrationPath(scenario.activityId))
      .set('Authorization', applicantAuth)
      .send({
        operationKey: `batch4-fallback-second-${sequence}`,
        formVersion: null,
        answers: [],
        preferences: [
          {
            sessionId: scenario.sessionId,
            positionIds: [scenario.positionId, fallbackPosition.id],
          },
        ],
      });
    expect(firstSubmitted.status).toBe(201);
    expect(secondSubmitted.status).toBe(201);
    await prisma.activity.update({
      where: { id: scenario.activityId },
      data: { registrationDeadline: new Date('2020-01-01T00:00:00.000Z') },
    });
    const prepared = await request(httpServer(app))
      .post(allocationBatchesPath(scenario.activityId))
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch4-fallback-prepare-${sequence}`,
        sessionId: scenario.sessionId,
      });
    expect(prepared.status).toBe(201);
    const committed = await request(httpServer(app))
      .post(
        `${allocationBatchesPath(scenario.activityId)}/${prepared.body.data.batch.batchId}/commit`,
      )
      .set('Authorization', managerAuth)
      .send({ operationKey: `batch4-fallback-commit-${sequence}` });
    expect(committed.status).toBe(200);
    const identity = await prisma.activityParticipationIdentity.findFirstOrThrow({
      where: { activityId: scenario.activityId, memberId: applicantMemberId },
      select: { currentStatusCode: true, currentPositionId: true },
    });
    expect(identity).toEqual(
      expect.objectContaining({
        currentStatusCode: 'pass',
        currentPositionId: fallbackPosition.id,
      }),
    );
  });

  it('promotes only the same persisted waitlist position after a committed allocation cancellation', async () => {
    const scenario = await createCandidateScenario({ allocationModeCode: 'qualification_rank' });
    await prisma.activity.update({ where: { id: scenario.activityId }, data: { capacity: 2 } });
    await prisma.activitySession.update({
      where: { id: scenario.sessionId },
      data: { capacity: 2 },
    });
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
        code: `allocation-promotion-secondary-${sequence}`,
        name: `Allocation Promotion Secondary ${sequence}`,
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
      createActiveApplicant('promotion-a-first', 'L4'),
      createActiveApplicant('promotion-a-second', 'L3'),
      createActiveApplicant('promotion-b-first', 'L2'),
      createActiveApplicant('promotion-b-second', 'L1'),
    ]);
    const submissions = [
      { applicant: firstA, positionId: scenario.positionId, key: 'a-first' },
      { applicant: secondA, positionId: scenario.positionId, key: 'a-second' },
      { applicant: firstB, positionId: secondPosition.id, key: 'b-first' },
      { applicant: secondB, positionId: secondPosition.id, key: 'b-second' },
    ];
    const registrationByMember = new Map<string, string>();
    for (const submission of submissions) {
      const submitted = await request(httpServer(app))
        .post(registrationPath(scenario.activityId))
        .set('Authorization', submission.applicant.auth)
        .send({
          operationKey: `batch4-promotion-${submission.key}-${sequence}`,
          formVersion: null,
          answers: [],
          preferences: [{ sessionId: scenario.sessionId, positionIds: [submission.positionId] }],
        });
      expect(submitted.status).toBe(201);
      registrationByMember.set(
        submission.applicant.memberId,
        submitted.body.data.registrationId as string,
      );
    }
    await prisma.activity.update({
      where: { id: scenario.activityId },
      data: { registrationDeadline: new Date('2020-01-01T00:00:00.000Z') },
    });
    const prepared = await request(httpServer(app))
      .post(allocationBatchesPath(scenario.activityId))
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch4-promotion-prepare-${sequence}`,
        sessionId: scenario.sessionId,
      });
    expect(prepared.status).toBe(201);
    const batchId = prepared.body.data.batch.batchId as string;
    const committed = await request(httpServer(app))
      .post(`${allocationBatchesPath(scenario.activityId)}/${batchId}/commit`)
      .set('Authorization', managerAuth)
      .send({ operationKey: `batch4-promotion-commit-${sequence}` });
    expect(committed.status).toBe(200);

    const identities = await prisma.activityParticipationIdentity.findMany({
      where: { activityId: scenario.activityId },
      select: { id: true, memberId: true },
    });
    const identityByMember = new Map(
      identities.map((identity) => [identity.memberId, identity.id]),
    );
    const candidates = await prisma.activityAllocationCandidate.findMany({
      where: { allocationBatchId: batchId },
      select: {
        participationIdentityId: true,
        resultCode: true,
        waitlistRank: true,
        waitlistPositionId: true,
      },
    });
    const candidateByIdentity = new Map(
      candidates.map((candidate) => [candidate.participationIdentityId, candidate]),
    );
    expect(candidateByIdentity.get(identityByMember.get(secondA.memberId)!)).toEqual(
      expect.objectContaining({
        resultCode: 'waitlisted',
        waitlistRank: 1,
        waitlistPositionId: scenario.positionId,
      }),
    );
    expect(candidateByIdentity.get(identityByMember.get(secondB.memberId)!)).toEqual(
      expect.objectContaining({
        resultCode: 'waitlisted',
        waitlistRank: 1,
        waitlistPositionId: secondPosition.id,
      }),
    );

    const cancelled = await request(httpServer(app))
      .patch(`/api/app/v1/my/registrations/${registrationByMember.get(firstA.memberId)!}/cancel`)
      .set('Authorization', firstA.auth)
      .send({ cancelReason: 'free A allocation slot' });
    expect(cancelled.status).toBe(200);

    const after = await prisma.activityParticipationIdentity.findMany({
      where: { activityId: scenario.activityId },
      select: { memberId: true, currentStatusCode: true, currentPositionId: true },
    });
    const afterByMember = new Map(after.map((identity) => [identity.memberId, identity]));
    expect(afterByMember.get(firstA.memberId)).toEqual(
      expect.objectContaining({ currentStatusCode: 'cancelled', currentPositionId: null }),
    );
    expect(afterByMember.get(secondA.memberId)).toEqual(
      expect.objectContaining({
        currentStatusCode: 'pass',
        currentPositionId: scenario.positionId,
      }),
    );
    expect(afterByMember.get(firstB.memberId)).toEqual(
      expect.objectContaining({ currentStatusCode: 'pass', currentPositionId: secondPosition.id }),
    );
    expect(afterByMember.get(secondB.memberId)).toEqual(
      expect.objectContaining({ currentStatusCode: 'waitlisted', currentPositionId: null }),
    );
  });

  it('red-first: void fails closed with zero writes when a committed candidate queue position drifts', async () => {
    const scenario = await createCandidateScenario({ allocationModeCode: 'qualification_rank' });
    const alternatePosition = await prisma.activitySessionPosition.create({
      data: {
        activityId: scenario.activityId,
        sessionId: scenario.sessionId,
        code: `allocation-void-drift-alternate-${sequence}`,
        name: `Allocation Void Drift Alternate ${sequence}`,
        attendanceRoleCode: 'volunteer',
        capacity: 1,
      },
      select: { id: true },
    });
    const second = await createActiveApplicant('void-drift-second', 'L2');
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
            valueJson: { codes: ['L1'] },
            warnScore: 10,
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
    const firstSubmitted = await request(httpServer(app))
      .post(registrationPath(scenario.activityId))
      .set('Authorization', applicantAuth)
      .send({ ...command, operationKey: `batch4-void-drift-first-${sequence}` });
    const secondSubmitted = await request(httpServer(app))
      .post(registrationPath(scenario.activityId))
      .set('Authorization', second.auth)
      .send({ ...command, operationKey: `batch4-void-drift-second-${sequence}` });
    expect(firstSubmitted.status).toBe(201);
    expect(secondSubmitted.status).toBe(201);
    await prisma.activity.update({
      where: { id: scenario.activityId },
      data: { registrationDeadline: new Date('2020-01-01T00:00:00.000Z') },
    });
    const prepared = await request(httpServer(app))
      .post(allocationBatchesPath(scenario.activityId))
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch4-void-drift-prepare-${sequence}`,
        sessionId: scenario.sessionId,
      });
    expect(prepared.status).toBe(201);
    const batchId = prepared.body.data.batch.batchId as string;
    const committed = await request(httpServer(app))
      .post(`${allocationBatchesPath(scenario.activityId)}/${batchId}/commit`)
      .set('Authorization', managerAuth)
      .send({ operationKey: `batch4-void-drift-commit-${sequence}` });
    expect(committed.status).toBe(200);

    const waitlistedIdentity = await prisma.activityParticipationIdentity.findFirstOrThrow({
      where: { activityId: scenario.activityId, memberId: second.memberId },
      select: { id: true, currentRevision: true, currentStatusCode: true },
    });
    expect(waitlistedIdentity.currentStatusCode).toBe('waitlisted');
    const waitlistedCandidate = await prisma.activityAllocationCandidate.findFirstOrThrow({
      where: { allocationBatchId: batchId, participationIdentityId: waitlistedIdentity.id },
      select: { id: true, waitlistPositionId: true, waitlistRank: true },
    });
    expect(waitlistedCandidate).toEqual(
      expect.objectContaining({ waitlistPositionId: scenario.positionId, waitlistRank: 1 }),
    );

    // This is an intentional downstream-drift fixture: it stays D87-FK-valid but no longer
    // agrees with the immutable current waitlist revision. The HTTP void must refuse to rewrite.
    await prisma.activityAllocationCandidate.update({
      where: { id: waitlistedCandidate.id },
      data: { waitlistPositionId: alternatePosition.id },
    });
    const before = await Promise.all([
      prisma.activityAllocationBatch.findUniqueOrThrow({
        where: { id: batchId },
        select: { statusCode: true, voidReason: true, voidedAt: true },
      }),
      prisma.activityParticipationRevision.count({ where: { identityId: waitlistedIdentity.id } }),
      prisma.capacityReservation.count({
        where: { identityId: waitlistedIdentity.id, status: 'active' },
      }),
    ]);

    const voided = await request(httpServer(app))
      .post(`${allocationBatchesPath(scenario.activityId)}/${batchId}/void`)
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch4-void-drift-void-${sequence}`,
        reason: 'must not overwrite drift',
      });
    expect(voided.status).toBe(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.httpStatus);
    expect(voided.body.code).toBe(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.code);

    const after = await Promise.all([
      prisma.activityAllocationBatch.findUniqueOrThrow({
        where: { id: batchId },
        select: { statusCode: true, voidReason: true, voidedAt: true },
      }),
      prisma.activityParticipationRevision.count({ where: { identityId: waitlistedIdentity.id } }),
      prisma.capacityReservation.count({
        where: { identityId: waitlistedIdentity.id, status: 'active' },
      }),
    ]);
    expect(after).toEqual(before);
  });

  it('fails closed with zero void writes when a committed capacity bucket drifts', async () => {
    const scenario = await createCandidateScenario({ allocationModeCode: 'qualification_rank' });
    const submitted = await request(httpServer(app))
      .post(registrationPath(scenario.activityId))
      .set('Authorization', applicantAuth)
      .send({
        operationKey: `batch4-void-bucket-drift-submit-${sequence}`,
        formVersion: null,
        answers: [],
        preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
      });
    expect(submitted.status).toBe(201);
    await prisma.activity.update({
      where: { id: scenario.activityId },
      data: { registrationDeadline: new Date('2020-01-01T00:00:00.000Z') },
    });
    const prepared = await request(httpServer(app))
      .post(allocationBatchesPath(scenario.activityId))
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch4-void-bucket-drift-prepare-${sequence}`,
        sessionId: scenario.sessionId,
        positionId: scenario.positionId,
      });
    expect(prepared.status).toBe(201);
    const batchId = prepared.body.data.batch.batchId as string;
    const committed = await request(httpServer(app))
      .post(`${allocationBatchesPath(scenario.activityId)}/${batchId}/commit`)
      .set('Authorization', managerAuth)
      .send({ operationKey: `batch4-void-bucket-drift-commit-${sequence}` });
    expect(committed.status).toBe(200);
    const projection = await prisma.activityAllocationApplicationProjection.findFirstOrThrow({
      where: { allocationBatchId: batchId },
      select: { positionBucketId: true, participationIdentityId: true },
    });
    expect(projection.positionBucketId).toEqual(expect.any(String));
    // This is an FK-valid downstream drift. Void must stop before releasing reservations or
    // appending a pending revision when the committed bucket no longer reconciles to live rows.
    await prisma.activityCapacityBucket.update({
      where: { id: projection.positionBucketId! },
      data: { occupied: 0 },
    });
    const before = await Promise.all([
      prisma.activityAllocationBatch.findUniqueOrThrow({
        where: { id: batchId },
        select: { statusCode: true, voidReason: true, voidedAt: true },
      }),
      prisma.activityParticipationRevision.count({
        where: { identityId: projection.participationIdentityId },
      }),
      prisma.capacityReservation.count({
        where: { identityId: projection.participationIdentityId, status: 'active' },
      }),
    ]);
    const voided = await request(httpServer(app))
      .post(`${allocationBatchesPath(scenario.activityId)}/${batchId}/void`)
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch4-void-bucket-drift-void-${sequence}`,
        reason: 'bucket counter no longer matches live reservations',
      });
    expect(voided.status).toBe(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.httpStatus);
    expect(voided.body.code).toBe(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.code);
    const after = await Promise.all([
      prisma.activityAllocationBatch.findUniqueOrThrow({
        where: { id: batchId },
        select: { statusCode: true, voidReason: true, voidedAt: true },
      }),
      prisma.activityParticipationRevision.count({
        where: { identityId: projection.participationIdentityId },
      }),
      prisma.capacityReservation.count({
        where: { identityId: projection.participationIdentityId, status: 'active' },
      }),
    ]);
    expect(after).toEqual(before);
  });

  it('accepts a scoped invitation through the canonical command and first_come allocation chain', async () => {
    const scenario = await createCandidateScenario({
      allocationModeCode: 'first_come',
      capacity: 1,
    });
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

  it.each(['qualification_rank', 'lottery'] as const)(
    'keeps invitation acceptance pending until a %s allocation batch is prepared',
    async (allocationModeCode) => {
      const scenario = await createCandidateScenario({ allocationModeCode });
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
      const accepted = await request(httpServer(app))
        .post(`/api/app/v1/my/activity-invitations/${invitationId}/accept`)
        .set('Authorization', applicantAuth)
        .send({
          operationKey: `batch4-invitation-${allocationModeCode}-accept-${sequence}`,
          formVersion: null,
          answers: [],
          preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
        });
      expect(accepted.status).toBe(201);
      const identity = await prisma.activityParticipationIdentity.findFirstOrThrow({
        where: { activityId: scenario.activityId, memberId: applicantMemberId },
        select: { currentStatusCode: true, currentPositionId: true, capacityReservationId: true },
      });
      expect(identity).toEqual({
        currentStatusCode: 'pending',
        currentPositionId: null,
        capacityReservationId: null,
      });
      expect(
        await prisma.activityAllocationBatch.count({ where: { activityId: scenario.activityId } }),
      ).toBe(0);
      await prisma.activity.update({
        where: { id: scenario.activityId },
        data: { registrationDeadline: new Date('2020-01-01T00:00:00.000Z') },
      });
      const prepared = await request(httpServer(app))
        .post(allocationBatchesPath(scenario.activityId))
        .set('Authorization', managerAuth)
        .send({
          operationKey: `batch4-invitation-${allocationModeCode}-prepare-${sequence}`,
          sessionId: scenario.sessionId,
          positionId: scenario.positionId,
        });
      expect(prepared.status).toBe(201);
      expect(prepared.body.data.batch.modeCode).toBe(allocationModeCode);
    },
  );

  it('keeps lottery seed concealed at prepare, verifies its commitment at commit, and replays commit exactly', async () => {
    const scenario = await createCandidateScenario({ allocationModeCode: 'lottery', capacity: 1 });
    const secondUser = await createTestUser(app, {
      username: `batch4-lottery-second-${sequence}`,
      role: Role.USER,
    });
    const secondMember = await prisma.member.create({
      data: {
        memberNo: `B4-LOTTERY-SECOND-${sequence}`,
        ...memberIdentityData('Batch4 Lottery Second'),
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

  it('fails closed with zero commit writes when a lottery commitment drifts after prepare', async () => {
    const scenario = await createCandidateScenario({ allocationModeCode: 'lottery', capacity: 1 });
    const submitted = await request(httpServer(app))
      .post(registrationPath(scenario.activityId))
      .set('Authorization', applicantAuth)
      .send({
        operationKey: `batch4-lottery-commitment-drift-submit-${sequence}`,
        formVersion: null,
        answers: [],
        preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
      });
    expect(submitted.status).toBe(201);
    await prisma.activity.update({
      where: { id: scenario.activityId },
      data: { registrationDeadline: new Date('2020-01-01T00:00:00.000Z') },
    });
    const prepared = await request(httpServer(app))
      .post(allocationBatchesPath(scenario.activityId))
      .set('Authorization', managerAuth)
      .send({
        operationKey: `batch4-lottery-commitment-drift-prepare-${sequence}`,
        sessionId: scenario.sessionId,
        positionId: scenario.positionId,
      });
    expect(prepared.status).toBe(201);
    const batchId = prepared.body.data.batch.batchId as string;
    await prisma.activityAllocationBatch.update({
      where: { id: batchId },
      data: {
        randomCommitment: createHash('sha256')
          .update(`wrong lottery commitment ${sequence}`, 'utf8')
          .digest('hex'),
      },
    });
    const before = await Promise.all([
      prisma.activityAllocationBatch.findUniqueOrThrow({
        where: { id: batchId },
        select: {
          statusCode: true,
          randomCommitment: true,
          randomSeedReveal: true,
          committedAt: true,
        },
      }),
      prisma.activityAllocationCandidate.findMany({
        where: { allocationBatchId: batchId },
        select: { resultCode: true, lotteryOrder: true, waitlistRank: true },
      }),
      prisma.activityAllocationApplicationProjection.count({
        where: { allocationBatchId: batchId },
      }),
      prisma.capacityReservation.count({
        where: { activityId: scenario.activityId, status: 'active' },
      }),
    ]);

    const commit = await request(httpServer(app))
      .post(`${allocationBatchesPath(scenario.activityId)}/${batchId}/commit`)
      .set('Authorization', managerAuth)
      .send({ operationKey: `batch4-lottery-commitment-drift-commit-${sequence}` });
    expect(commit.status).toBe(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.httpStatus);
    expect(commit.body.code).toBe(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED.code);
    const after = await Promise.all([
      prisma.activityAllocationBatch.findUniqueOrThrow({
        where: { id: batchId },
        select: {
          statusCode: true,
          randomCommitment: true,
          randomSeedReveal: true,
          committedAt: true,
        },
      }),
      prisma.activityAllocationCandidate.findMany({
        where: { allocationBatchId: batchId },
        select: { resultCode: true, lotteryOrder: true, waitlistRank: true },
      }),
      prisma.activityAllocationApplicationProjection.count({
        where: { allocationBatchId: batchId },
      }),
      prisma.capacityReservation.count({
        where: { activityId: scenario.activityId, status: 'active' },
      }),
    ]);
    expect(after).toEqual(before);
  });
});
