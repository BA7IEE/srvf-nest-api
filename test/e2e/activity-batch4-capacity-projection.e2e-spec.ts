import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

describe('batch4 activity capacity bucket projection', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let creatorAuth: string;
  let reviewerAuth: string;
  let organizationId: string;
  let activityTypeCode: string;
  let attendanceRoleCode: string;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const creator = await createTestUser(app, {
      username: 'batch4-capacity-creator',
      role: Role.SUPER_ADMIN,
    });
    const reviewer = await createTestUser(app, {
      username: 'batch4-capacity-reviewer',
      role: Role.USER,
    });
    const creatorMember = await prisma.member.create({
      data: {
        memberNo: 'batch4-capacity-creator-member',
        ...memberIdentityData('容量投影发起人'),
        gradeCode: 'level-3',
      },
      select: { id: true },
    });
    const reviewerMember = await prisma.member.create({
      data: {
        memberNo: 'batch4-capacity-reviewer-member',
        ...memberIdentityData('容量投影审核人'),
        gradeCode: 'level-3',
      },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: creator.id }, data: { memberId: creatorMember.id } });
    await prisma.user.update({ where: { id: reviewer.id }, data: { memberId: reviewerMember.id } });

    const bizAdmin = await seedBizAdminPermissionsAndRole(app);
    await seedActivityResponsibilitySystemRoles(app);
    await grantBizAdminToUser(app, creator.id, bizAdmin.bizAdminRoleId);

    const root = await prisma.organization.create({
      data: { name: '第 4 批容量投影根组织', nodeTypeCode: 'batch4-capacity-root' },
      select: { id: true },
    });
    const organization = await prisma.organization.create({
      data: {
        name: '第 4 批容量投影执行组织',
        nodeTypeCode: 'batch4-capacity-team',
        parentId: root.id,
      },
      select: { id: true },
    });
    organizationId = organization.id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: root.id, descendantId: root.id, depth: 0 },
        { ancestorId: root.id, descendantId: organization.id, depth: 1 },
        { ancestorId: organization.id, descendantId: organization.id, depth: 0 },
      ],
    });
    await prisma.memberOrganizationMembership.create({
      data: { memberId: creatorMember.id, organizationId },
    });

    const activityType = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    activityTypeCode = 'batch4-capacity-type';
    await prisma.dictItem.create({
      data: { typeId: activityType.id, code: activityTypeCode, label: '容量投影活动' },
    });
    const attendanceRole = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    attendanceRoleCode = 'batch4-capacity-attendee';
    await prisma.dictItem.create({
      data: { typeId: attendanceRole.id, code: attendanceRoleCode, label: '容量投影参与者' },
    });

    await prisma.permission.createMany({
      data: [
        {
          code: 'activity-review.read.request',
          module: 'activity-review',
          action: 'read',
          resourceType: 'request',
        },
        {
          code: 'activity-review.return.request',
          module: 'activity-review',
          action: 'return',
          resourceType: 'request',
        },
      ],
      skipDuplicates: true,
    });
    const reviewerRole = await prisma.rbacRole.create({
      data: { code: 'batch4-capacity-reviewer', displayName: '第 4 批容量投影审核人' },
      select: { id: true },
    });
    const reviewerPermissions = await prisma.permission.findMany({
      where: {
        code: {
          in: [
            'activity-review.read.request',
            'activity-review.return.request',
            'activity.publish.record',
          ],
        },
      },
      select: { id: true },
    });
    await prisma.rolePermission.createMany({
      data: reviewerPermissions.map((permission) => ({
        roleId: reviewerRole.id,
        permissionId: permission.id,
      })),
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: reviewer.id,
        roleId: reviewerRole.id,
        scopeType: BindingScopeType.ORGANIZATION,
        scopeOrgId: organizationId,
      },
    });

    creatorAuth = (await loginAs(app, creator.username)).authHeader;
    reviewerAuth = (await loginAs(app, reviewer.username)).authHeader;
  });

  afterAll(async () => {
    await app.close();
    if (previousGate === undefined) {
      delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousGate;
    }
  });

  async function createLiveSession(
    activityId: string,
    suffix: string,
    capacity: number | null,
  ): Promise<string> {
    const session = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions`)
      .set('Authorization', creatorAuth)
      .send({
        code: `s-${sequence}-${suffix}`,
        name: `容量投影场次 ${suffix}`,
        startAt: '2099-08-01T01:00:00.000Z',
        endAt: '2099-08-01T05:00:00.000Z',
        locationText: '深圳会场',
        capacity,
        checkInOpenAt: '2099-08-01T00:30:00.000Z',
        checkInCloseAt: '2099-08-01T02:00:00.000Z',
        checkOutOpenAt: '2099-08-01T03:00:00.000Z',
        checkOutCloseAt: '2099-08-01T05:00:00.000Z',
        locationRequired: false,
      })
      .expect(201);
    return session.body.data.sessionId as string;
  }

  async function createPosition(
    activityId: string,
    sessionId: string,
    suffix: string,
    capacity: number | null,
  ): Promise<string> {
    const position = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}/positions`)
      .set('Authorization', creatorAuth)
      .send({
        code: `p-${sequence}-${suffix}`,
        name: `容量投影岗位 ${suffix}`,
        attendanceRoleCode,
        capacity,
        startAt: '2099-08-01T01:30:00.000Z',
        endAt: '2099-08-01T04:30:00.000Z',
      })
      .expect(201);
    return position.body.data.positionId as string;
  }

  async function createDraftWithCapacityTargets(
    options: {
      activityCapacity?: number | null;
      sessionCapacity?: number | null;
      positionCapacity?: number | null;
      includePosition?: boolean;
    } = {},
  ): Promise<{
    activityId: string;
    sessionId: string;
    positionId: string | null;
  }> {
    const {
      activityCapacity = 3,
      sessionCapacity = 3,
      positionCapacity = 3,
      includePosition = true,
    } = options;
    sequence += 1;
    const activity = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', creatorAuth)
      .send({
        title: `第 4 批容量投影活动 ${sequence}`,
        activityTypeCode,
        organizationId,
        startAt: '2099-08-01T01:00:00.000Z',
        endAt: '2099-08-01T05:00:00.000Z',
        registrationDeadline: '2099-07-31T12:00:00.000Z',
        location: '深圳',
        allocationModeCode: 'first_come',
        capacity: activityCapacity,
      })
      .expect(201);
    const activityId = activity.body.data.id as string;
    const sessionId = await createLiveSession(activityId, 'main', sessionCapacity);
    const positionId = includePosition
      ? await createPosition(activityId, sessionId, 'main', positionCapacity)
      : null;
    return { activityId, sessionId, positionId };
  }

  function approveReview(reviewId: string, suffix: string, reviewNote?: string) {
    return request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${reviewId}/approve`)
      .set('Authorization', reviewerAuth)
      .send({
        requiresInsuranceConfirmed: true,
        operationKey: `batch4-capacity-approve-${suffix}`,
        ...(reviewNote === undefined ? {} : { reviewNote }),
      });
  }

  async function approveInitial(activityId: string, suffix: string): Promise<string> {
    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/publish-reviews`)
      .set('Authorization', creatorAuth)
      .send({ operationKey: `batch4-capacity-initial-${suffix}`, confirmation: true })
      .expect(200);
    await approveReview(submitted.body.data.id as string, suffix).expect(200);
    return submitted.body.data.id as string;
  }

  async function submitChange(
    activityId: string,
    suffix: string,
    change: {
      activityPatch?: Record<string, unknown>;
      sessions?: { create?: unknown[]; update?: unknown[]; cancel?: unknown[] };
      positions?: { create?: unknown[]; update?: unknown[]; cancel?: unknown[] };
    },
  ): Promise<string> {
    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/change-reviews`)
      .set('Authorization', creatorAuth)
      .send({
        operationKey: `batch4-capacity-change-${suffix}`,
        confirmation: true,
        activityPatch: change.activityPatch ?? {},
        sessions: {
          create: change.sessions?.create ?? [],
          update: change.sessions?.update ?? [],
          cancel: change.sessions?.cancel ?? [],
        },
        positions: {
          create: change.positions?.create ?? [],
          update: change.positions?.update ?? [],
          cancel: change.positions?.cancel ?? [],
        },
      })
      .expect(200);
    return submitted.body.data.id as string;
  }

  function sessionCreatePayload(clientRef: string, suffix: string, capacity: number | null) {
    return {
      clientRef,
      code: `proposal-session-${sequence}-${suffix}`,
      name: `提案新增场次 ${suffix}`,
      startAt: '2099-08-01T01:00:00.000Z',
      endAt: '2099-08-01T05:00:00.000Z',
      locationText: '深圳提案会场',
      capacity,
      checkInOpenAt: '2099-08-01T00:30:00.000Z',
      checkInCloseAt: '2099-08-01T02:00:00.000Z',
      checkOutOpenAt: '2099-08-01T03:00:00.000Z',
      checkOutCloseAt: '2099-08-01T05:00:00.000Z',
      locationRequired: false,
    };
  }

  function positionCreatePayload(sessionId: string, suffix: string, capacity: number | null) {
    return {
      sessionId,
      code: `proposal-position-${sequence}-${suffix}`,
      name: `提案新增岗位 ${suffix}`,
      attendanceRoleCode,
      capacity,
      startAt: '2099-08-01T01:30:00.000Z',
      endAt: '2099-08-01T04:30:00.000Z',
    };
  }

  async function findBucket(activityId: string, scopeTypeCode: string, scopeId: string) {
    return prisma.activityCapacityBucket.findFirstOrThrow({
      where: { activityId, scopeTypeCode, scopeId },
      select: { id: true, capacity: true, occupied: true, version: true, updatedAt: true },
    });
  }

  async function seedActiveOccupancy(input: {
    activityId: string;
    sessionId: string;
    positionId?: string | null;
    bucketId: string;
    reservationType: 'activity_person' | 'session_participation' | 'position_participation';
    count: number;
  }): Promise<void> {
    for (let index = 0; index < input.count; index += 1) {
      const suffix = `${sequence}-${input.reservationType}-${index}`;
      const member = await prisma.member.create({
        data: {
          memberNo: `batch4-capacity-member-${suffix}`,
          ...memberIdentityData(`容量占用队员 ${suffix}`),
          gradeCode: 'level-3',
        },
        select: { id: true },
      });
      const registration = await prisma.activityRegistration.create({
        data: { activityId: input.activityId, memberId: member.id, statusCode: 'approved' },
        select: { id: true },
      });
      const identity = await prisma.activityParticipationIdentity.create({
        data: {
          activityId: input.activityId,
          sessionId: input.sessionId,
          registrationId: registration.id,
          memberId: member.id,
          currentStatusCode: 'pass',
          currentPositionId: input.positionId ?? null,
        },
        select: { id: true },
      });
      await prisma.capacityReservation.create({
        data: {
          identityId: identity.id,
          bucketId: input.bucketId,
          reservationType: input.reservationType,
          status: 'active',
          ...(input.reservationType === 'activity_person'
            ? { memberId: member.id, activityId: input.activityId }
            : {}),
        },
      });
    }
    await prisma.activityCapacityBucket.update({
      where: { id: input.bucketId },
      data: { occupied: input.count },
    });
  }

  it('red-first: initial v3 approval projects exactly the activity, scheduled-session, and live-position buckets', async () => {
    const { activityId, sessionId, positionId } = await createDraftWithCapacityTargets();
    if (!positionId) throw new Error('fixture position must exist');

    await approveInitial(activityId, 'initial-projection');

    await expect(
      prisma.activityCapacityBucket.findMany({
        where: { activityId },
        select: {
          scopeTypeCode: true,
          scopeId: true,
          capacity: true,
          occupied: true,
          version: true,
        },
        orderBy: [{ scopeTypeCode: 'asc' }, { scopeId: 'asc' }],
      }),
    ).resolves.toEqual([
      {
        scopeTypeCode: 'activity_person',
        scopeId: activityId,
        capacity: 3,
        occupied: 0,
        version: 0,
      },
      {
        scopeTypeCode: 'position_participation',
        scopeId: positionId,
        capacity: 3,
        occupied: 0,
        version: 0,
      },
      {
        scopeTypeCode: 'session_participation',
        scopeId: sessionId,
        capacity: 3,
        occupied: 0,
        version: 0,
      },
    ]);
  });

  it('projects no target bucket for cancelled sessions or soft-deleted positions', async () => {
    const { activityId, sessionId } = await createDraftWithCapacityTargets({
      activityCapacity: 10,
      sessionCapacity: 10,
      positionCapacity: 3,
    });
    const cancelledSessionId = await createLiveSession(activityId, 'cancelled', 10);
    const cancelledPositionId = await createPosition(
      activityId,
      cancelledSessionId,
      'cancelled',
      3,
    );
    const deletedPositionId = await createPosition(activityId, sessionId, 'deleted', 3);
    await prisma.activitySession.update({
      where: { id: cancelledSessionId },
      data: { statusCode: 'cancelled' },
    });
    await prisma.activitySessionPosition.update({
      where: { id: deletedPositionId },
      data: { deletedAt: new Date('2099-07-01T00:00:00.000Z') },
    });

    await approveInitial(activityId, 'skip-non-targets');

    const buckets = await prisma.activityCapacityBucket.findMany({
      where: { activityId },
      select: { scopeTypeCode: true, scopeId: true },
    });
    expect(buckets).toHaveLength(3);
    expect(buckets).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scopeTypeCode: 'session_participation',
          scopeId: cancelledSessionId,
        }),
        expect.objectContaining({
          scopeTypeCode: 'position_participation',
          scopeId: cancelledPositionId,
        }),
        expect.objectContaining({
          scopeTypeCode: 'position_participation',
          scopeId: deletedPositionId,
        }),
      ]),
    );
  });

  it('adds target buckets, changes only changed capacities once, and keeps replay or no-op from advancing versions', async () => {
    const { activityId, sessionId, positionId } = await createDraftWithCapacityTargets({
      activityCapacity: 10,
      sessionCapacity: 4,
      positionCapacity: 3,
    });
    if (!positionId) throw new Error('fixture position must exist');
    await approveInitial(activityId, 'change-project-initial');

    const clientRef = `batch4-capacity-new-session-${sequence}`;
    const newSession = sessionCreatePayload(clientRef, 'change-project', 2);
    const newPosition = positionCreatePayload(clientRef, 'change-project', 2);
    const changeReviewId = await submitChange(activityId, 'change-project', {
      activityPatch: { title: '容量桶变更投影' },
      sessions: {
        create: [newSession],
        update: [{ sessionId, capacity: 5 }],
      },
      positions: {
        create: [newPosition],
        update: [{ sessionId, positionId, capacity: 4 }],
      },
    });
    await approveReview(changeReviewId, 'change-project').expect(200);

    const createdSession = await prisma.activitySession.findFirstOrThrow({
      where: { activityId, code: newSession.code, deletedAt: null },
      select: { id: true },
    });
    const createdPosition = await prisma.activitySessionPosition.findFirstOrThrow({
      where: { activityId, code: newPosition.code, deletedAt: null },
      select: { id: true },
    });
    await expect(
      Promise.all([
        findBucket(activityId, 'activity_person', activityId),
        findBucket(activityId, 'session_participation', sessionId),
        findBucket(activityId, 'position_participation', positionId),
        findBucket(activityId, 'session_participation', createdSession.id),
        findBucket(activityId, 'position_participation', createdPosition.id),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ capacity: 10, occupied: 0, version: 0 }),
      expect.objectContaining({ capacity: 5, occupied: 0, version: 1 }),
      expect.objectContaining({ capacity: 4, occupied: 0, version: 1 }),
      expect.objectContaining({ capacity: 2, occupied: 0, version: 0 }),
      expect.objectContaining({ capacity: 2, occupied: 0, version: 0 }),
    ]);

    const beforeNoOp = await prisma.activityCapacityBucket.findMany({
      where: { activityId },
      select: { id: true, version: true, updatedAt: true },
      orderBy: { id: 'asc' },
    });
    const noOpReviewId = await submitChange(activityId, 'change-project-no-op', {
      activityPatch: { title: '容量桶 no-op 变更' },
    });
    await approveReview(noOpReviewId, 'change-project-no-op').expect(200);
    await expect(
      prisma.activityCapacityBucket.findMany({
        where: { activityId },
        select: { id: true, version: true, updatedAt: true },
        orderBy: { id: 'asc' },
      }),
    ).resolves.toEqual(beforeNoOp);

    const beforeReplay = await prisma.activityCapacityBucket.findMany({
      where: { activityId },
      select: { id: true, version: true, updatedAt: true },
      orderBy: { id: 'asc' },
    });
    await approveReview(changeReviewId, 'change-project').expect(200);
    const conflict = await approveReview(changeReviewId, 'change-project', 'different payload');
    expectBizError(conflict, BizCode.ACTIVITY_PUBLISH_REVIEW_OPERATION_KEY_CONFLICT);
    await expect(
      prisma.activityCapacityBucket.findMany({
        where: { activityId },
        select: { id: true, version: true, updatedAt: true },
        orderBy: { id: 'asc' },
      }),
    ).resolves.toEqual(beforeReplay);
  });

  it('allows activity-person occupancy at its current capacity and rejects an activity capacity reduction below it', async () => {
    const { activityId, sessionId } = await createDraftWithCapacityTargets({
      activityCapacity: 2,
      sessionCapacity: 1,
      includePosition: false,
    });
    await approveInitial(activityId, 'activity-guard-initial');
    const bucket = await findBucket(activityId, 'activity_person', activityId);
    await seedActiveOccupancy({
      activityId,
      sessionId,
      bucketId: bucket.id,
      reservationType: 'activity_person',
      count: 2,
    });

    const allowedReviewId = await submitChange(activityId, 'activity-guard-allowed', {
      activityPatch: { title: '活动人数正对照' },
    });
    await approveReview(allowedReviewId, 'activity-guard-allowed').expect(200);
    await expect(findBucket(activityId, 'activity_person', activityId)).resolves.toEqual(
      expect.objectContaining({ capacity: 2, occupied: 2, version: 0 }),
    );

    const rejectedReviewId = await submitChange(activityId, 'activity-guard-reject', {
      activityPatch: { capacity: 1 },
    });
    const rejected = await approveReview(rejectedReviewId, 'activity-guard-reject');
    expectBizError(rejected, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    await expect(
      prisma.activityPublishReview.findUniqueOrThrow({
        where: { id: rejectedReviewId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: 'pending' });
    await expect(findBucket(activityId, 'activity_person', activityId)).resolves.toEqual(
      expect.objectContaining({ capacity: 2, occupied: 2, version: 0 }),
    );
  });

  it('allows session participation occupancy at its current capacity and rejects a session capacity reduction below it', async () => {
    const { activityId, sessionId } = await createDraftWithCapacityTargets({
      activityCapacity: 3,
      sessionCapacity: 2,
      includePosition: false,
    });
    await approveInitial(activityId, 'session-guard-initial');
    const bucket = await findBucket(activityId, 'session_participation', sessionId);
    await seedActiveOccupancy({
      activityId,
      sessionId,
      bucketId: bucket.id,
      reservationType: 'session_participation',
      count: 2,
    });

    const allowedReviewId = await submitChange(activityId, 'session-guard-allowed', {
      activityPatch: { title: '场次人数正对照' },
    });
    await approveReview(allowedReviewId, 'session-guard-allowed').expect(200);
    await expect(findBucket(activityId, 'session_participation', sessionId)).resolves.toEqual(
      expect.objectContaining({ capacity: 2, occupied: 2, version: 0 }),
    );

    const rejectedReviewId = await submitChange(activityId, 'session-guard-reject', {
      sessions: { update: [{ sessionId, capacity: 1 }] },
    });
    const rejected = await approveReview(rejectedReviewId, 'session-guard-reject');
    expectBizError(rejected, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    await expect(findBucket(activityId, 'session_participation', sessionId)).resolves.toEqual(
      expect.objectContaining({ capacity: 2, occupied: 2, version: 0 }),
    );
  });

  it('allows position participation occupancy at its current capacity and rejects a position capacity reduction below it', async () => {
    const { activityId, sessionId, positionId } = await createDraftWithCapacityTargets({
      activityCapacity: 3,
      sessionCapacity: 3,
      positionCapacity: 2,
    });
    if (!positionId) throw new Error('fixture position must exist');
    await approveInitial(activityId, 'position-guard-initial');
    const bucket = await findBucket(activityId, 'position_participation', positionId);
    await seedActiveOccupancy({
      activityId,
      sessionId,
      positionId,
      bucketId: bucket.id,
      reservationType: 'position_participation',
      count: 2,
    });

    const allowedReviewId = await submitChange(activityId, 'position-guard-allowed', {
      activityPatch: { title: '岗位人数正对照' },
    });
    await approveReview(allowedReviewId, 'position-guard-allowed').expect(200);
    await expect(findBucket(activityId, 'position_participation', positionId)).resolves.toEqual(
      expect.objectContaining({ capacity: 2, occupied: 2, version: 0 }),
    );

    const rejectedReviewId = await submitChange(activityId, 'position-guard-reject', {
      positions: { update: [{ sessionId, positionId, capacity: 1 }] },
    });
    const rejected = await approveReview(rejectedReviewId, 'position-guard-reject');
    expectBizError(rejected, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    await expect(findBucket(activityId, 'position_participation', positionId)).resolves.toEqual(
      expect.objectContaining({ capacity: 2, occupied: 2, version: 0 }),
    );
  });

  it('projects null capacities as unlimited without changing occupancy semantics', async () => {
    const { activityId, sessionId, positionId } = await createDraftWithCapacityTargets({
      activityCapacity: null,
      sessionCapacity: null,
      positionCapacity: null,
    });
    if (!positionId) throw new Error('fixture position must exist');

    await approveInitial(activityId, 'null-capacity');

    await expect(
      Promise.all([
        findBucket(activityId, 'activity_person', activityId),
        findBucket(activityId, 'session_participation', sessionId),
        findBucket(activityId, 'position_participation', positionId),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ capacity: null, occupied: 0, version: 0 }),
      expect.objectContaining({ capacity: null, occupied: 0, version: 0 }),
      expect.objectContaining({ capacity: null, occupied: 0, version: 0 }),
    ]);
  });

  it('fails closed on occupied-versus-active-reservation drift and rolls back every prior approve write', async () => {
    const { activityId, sessionId, positionId } = await createDraftWithCapacityTargets();
    if (!positionId) throw new Error('fixture position must exist');
    await approveInitial(activityId, 'drift-initial');
    const bucket = await findBucket(activityId, 'activity_person', activityId);
    await prisma.activityCapacityBucket.update({ where: { id: bucket.id }, data: { occupied: 1 } });

    const rejectedReviewId = await submitChange(activityId, 'drift-reject', {
      activityPatch: { title: '这次审核必须整体回滚' },
    });
    const before = await Promise.all([
      prisma.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: {
          title: true,
          workflowRevision: true,
          currentPopulationRevision: true,
          capacity: true,
        },
      }),
      prisma.activitySession.findUniqueOrThrow({
        where: { id: sessionId },
        select: { capacity: true, workflowRevision: true, statusCode: true },
      }),
      prisma.activitySessionPosition.findUniqueOrThrow({
        where: { id: positionId },
        select: { capacity: true, deletedAt: true },
      }),
      findBucket(activityId, 'activity_person', activityId),
      prisma.activityRuleSnapshot.count({ where: { activityId } }),
      prisma.auditLog.count({ where: { resourceId: activityId } }),
      prisma.notificationOutboxIntent.count({ where: { aggregateId: activityId } }),
      prisma.activityPublishReview.findUniqueOrThrow({
        where: { id: rejectedReviewId },
        select: { status: true },
      }),
    ]);

    const rejected = await approveReview(rejectedReviewId, 'drift-reject');
    expectBizError(rejected, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);

    await expect(
      Promise.all([
        prisma.activity.findUniqueOrThrow({
          where: { id: activityId },
          select: {
            title: true,
            workflowRevision: true,
            currentPopulationRevision: true,
            capacity: true,
          },
        }),
        prisma.activitySession.findUniqueOrThrow({
          where: { id: sessionId },
          select: { capacity: true, workflowRevision: true, statusCode: true },
        }),
        prisma.activitySessionPosition.findUniqueOrThrow({
          where: { id: positionId },
          select: { capacity: true, deletedAt: true },
        }),
        findBucket(activityId, 'activity_person', activityId),
        prisma.activityRuleSnapshot.count({ where: { activityId } }),
        prisma.auditLog.count({ where: { resourceId: activityId } }),
        prisma.notificationOutboxIntent.count({ where: { aggregateId: activityId } }),
        prisma.activityPublishReview.findUniqueOrThrow({
          where: { id: rejectedReviewId },
          select: { status: true },
        }),
      ]),
    ).resolves.toEqual(before);
  });

  it('rejects cancellation of a session whose retained historical bucket still has occupancy', async () => {
    const { activityId, sessionId } = await createDraftWithCapacityTargets({
      activityCapacity: 10,
      sessionCapacity: 4,
      positionCapacity: 3,
    });
    await createLiveSession(activityId, 'remaining', 4);
    await approveInitial(activityId, 'cancel-session-initial');
    const bucket = await findBucket(activityId, 'session_participation', sessionId);
    await seedActiveOccupancy({
      activityId,
      sessionId,
      bucketId: bucket.id,
      reservationType: 'session_participation',
      count: 1,
    });

    const rejectedReviewId = await submitChange(activityId, 'cancel-session-reject', {
      sessions: { cancel: [{ sessionId }] },
    });
    const rejected = await approveReview(rejectedReviewId, 'cancel-session-reject');
    expectBizError(rejected, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    await expect(
      prisma.activitySession.findUniqueOrThrow({
        where: { id: sessionId },
        select: { statusCode: true },
      }),
    ).resolves.toEqual({ statusCode: 'scheduled' });
  });

  it('rejects soft deletion of a position whose retained historical bucket still has occupancy', async () => {
    const { activityId, sessionId, positionId } = await createDraftWithCapacityTargets({
      activityCapacity: 10,
      sessionCapacity: 10,
      positionCapacity: 3,
    });
    if (!positionId) throw new Error('fixture position must exist');
    await createPosition(activityId, sessionId, 'remaining', 3);
    await approveInitial(activityId, 'cancel-position-initial');
    const bucket = await findBucket(activityId, 'position_participation', positionId);
    await seedActiveOccupancy({
      activityId,
      sessionId,
      positionId,
      bucketId: bucket.id,
      reservationType: 'position_participation',
      count: 1,
    });

    const rejectedReviewId = await submitChange(activityId, 'cancel-position-reject', {
      positions: { cancel: [{ sessionId, positionId }] },
    });
    const rejected = await approveReview(rejectedReviewId, 'cancel-position-reject');
    expectBizError(rejected, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    await expect(
      prisma.activitySessionPosition.findUniqueOrThrow({
        where: { id: positionId },
        select: { deletedAt: true },
      }),
    ).resolves.toEqual({ deletedAt: null });
  });

  it('keeps zero-occupancy cancelled-scope buckets as immutable history without deleting or versioning them', async () => {
    const { activityId, sessionId, positionId } = await createDraftWithCapacityTargets({
      activityCapacity: 10,
      sessionCapacity: 4,
      positionCapacity: 3,
    });
    if (!positionId) throw new Error('fixture position must exist');
    await createLiveSession(activityId, 'remaining', 4);
    await approveInitial(activityId, 'cancel-zero-history-initial');
    const before = await Promise.all([
      findBucket(activityId, 'session_participation', sessionId),
      findBucket(activityId, 'position_participation', positionId),
    ]);

    const reviewId = await submitChange(activityId, 'cancel-zero-history', {
      sessions: { cancel: [{ sessionId }] },
    });
    await approveReview(reviewId, 'cancel-zero-history').expect(200);

    await expect(
      Promise.all([
        findBucket(activityId, 'session_participation', sessionId),
        findBucket(activityId, 'position_participation', positionId),
      ]),
    ).resolves.toEqual(before);
  });
});
