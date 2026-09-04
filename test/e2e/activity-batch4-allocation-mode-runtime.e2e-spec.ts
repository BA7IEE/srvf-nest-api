import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

const ALLOCATION_MODE_INCONSISTENT = 20152;
const ALLOCATION_MODES = ['first_come', 'qualification_rank', 'lottery'] as const;

describe('batch4 allocation mode runtime', () => {
  let app: INestApplication;
  let peerApp: INestApplication;
  let prisma: PrismaService;
  let peerPrisma: PrismaService;
  let creatorAuth: string;
  let reviewerAuth: string;
  let organizationId: string;
  let activityTypeCode: string;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    peerApp = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    peerPrisma = peerApp.get(PrismaService);

    const creator = await createTestUser(app, {
      username: 'batch4-allocation-creator',
      role: Role.SUPER_ADMIN,
    });
    const reviewer = await createTestUser(app, {
      username: 'batch4-allocation-reviewer',
      role: Role.USER,
    });
    const creatorMember = await prisma.member.create({
      data: {
        memberNo: 'batch4-allocation-creator-member',
        ...memberIdentityData('分配方式发起人'),
        gradeCode: 'level-3',
      },
      select: { id: true },
    });
    const reviewerMember = await prisma.member.create({
      data: {
        memberNo: 'batch4-allocation-reviewer-member',
        ...memberIdentityData('分配方式审核人'),
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
      data: { name: '第 4 批分配方式根组织', nodeTypeCode: 'batch4-allocation-root' },
      select: { id: true },
    });
    const organization = await prisma.organization.create({
      data: {
        name: '第 4 批分配方式执行组织',
        nodeTypeCode: 'batch4-allocation-team',
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
    activityTypeCode = 'batch4-allocation-type';
    await prisma.dictItem.create({
      data: { typeId: activityType.id, code: activityTypeCode, label: '分配方式活动' },
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
      data: { code: 'batch4-allocation-reviewer', displayName: '分配方式审核人' },
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
    await Promise.all([app.close(), peerApp.close()]);
    if (previousGate === undefined) {
      delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousGate;
    }
  });

  function createPayload(title: string, allocationModeCode?: string) {
    return {
      title,
      activityTypeCode,
      organizationId,
      startAt: '2099-11-01T01:00:00.000Z',
      endAt: '2099-11-01T05:00:00.000Z',
      registrationDeadline: '2099-10-31T12:00:00.000Z',
      location: '深圳',
      ...(allocationModeCode === undefined ? {} : { allocationModeCode }),
    };
  }

  async function createDraft(
    allocationModeCode?: (typeof ALLOCATION_MODES)[number],
  ): Promise<string> {
    sequence += 1;
    const response = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', creatorAuth)
      .send(createPayload(`分配方式草稿 ${sequence}`, allocationModeCode));
    expect(response.status).toBe(201);
    return response.body.data.id as string;
  }

  async function createLiveSession(activityId: string): Promise<string> {
    const response = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions`)
      .set('Authorization', creatorAuth)
      .send({
        code: `batch4-allocation-session-${sequence}`,
        name: '分配方式发布场次',
        startAt: '2099-11-01T01:00:00.000Z',
        endAt: '2099-11-01T05:00:00.000Z',
        locationText: '深圳会场',
        checkInOpenAt: '2099-11-01T00:30:00.000Z',
        checkInCloseAt: '2099-11-01T02:00:00.000Z',
        checkOutOpenAt: '2099-11-01T03:00:00.000Z',
        checkOutCloseAt: '2099-11-01T05:00:00.000Z',
        locationRequired: false,
      });
    expect(response.status).toBe(201);
    return response.body.data.sessionId as string;
  }

  async function seedMismatchedBatch(
    activityId: string,
    sessionId: string,
    statusCode: 'preparing' | 'committed' | 'voided' = 'preparing',
  ): Promise<void> {
    await prisma.activityAllocationBatch.create({
      data: {
        activityId,
        sessionId,
        modeCode: 'lottery',
        candidateSnapshotHash: 'a'.repeat(64),
        algorithmVersionCode: 'allocation-v1',
        randomCommitment: 'b'.repeat(64),
        ...(statusCode === 'committed' ? { randomSeedReveal: 'c'.repeat(64) } : {}),
        statusCode,
        ...(statusCode === 'committed'
          ? { committedAt: new Date('2099-01-01T00:00:00.000Z') }
          : {}),
        // D86 的 voided shape 对历史模式夹具同样要求受控的作废事实。
        ...(statusCode === 'voided'
          ? {
              voidReason: 'D86 allocation-mode fixture void',
              voidedAt: new Date('2099-01-01T00:00:00.000Z'),
            }
          : {}),
        operationKey: `batch4-allocation-fixture-${sequence}`,
      },
    });
  }

  async function protectedWriteState(activityId: string) {
    const [activity, reviews, ruleSnapshots, batches, buckets, auditCount, outboxCount] =
      await Promise.all([
        prisma.activity.findUniqueOrThrow({
          where: { id: activityId },
          select: {
            title: true,
            allocationModeCode: true,
            statusCode: true,
            workflowRevision: true,
            currentPopulationRevision: true,
          },
        }),
        prisma.activityPublishReview.findMany({
          where: { activityId },
          orderBy: { requestVersion: 'asc' },
          select: { id: true, requestVersion: true, status: true, snapshot: true },
        }),
        prisma.activityRuleSnapshot.findMany({
          where: { activityId },
          orderBy: { workflowRevision: 'asc' },
          select: { id: true, workflowRevision: true, snapshotHash: true, createdByReviewId: true },
        }),
        prisma.activityAllocationBatch.findMany({
          where: { activityId },
          orderBy: { id: 'asc' },
          select: { id: true, modeCode: true, statusCode: true, operationKey: true },
        }),
        prisma.activityCapacityBucket.findMany({
          where: { activityId },
          orderBy: { id: 'asc' },
          select: {
            id: true,
            scopeTypeCode: true,
            scopeId: true,
            capacity: true,
            occupied: true,
            version: true,
          },
        }),
        prisma.auditLog.count({ where: { resourceId: activityId } }),
        prisma.notificationOutboxIntent.count({ where: { aggregateId: activityId } }),
      ]);
    return { activity, reviews, ruleSnapshots, batches, buckets, auditCount, outboxCount };
  }

  async function waitForActivityRootLockWaiters(expected: number): Promise<void> {
    const deadline = Date.now() + 8_000;
    let observed = 0;
    while (Date.now() < deadline) {
      const [row] = await peerPrisma.$queryRaw<Array<{ waitingCount: number }>>`
        SELECT count(*)::int AS "waitingCount"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query LIKE '%Activity%'
          AND query LIKE '%FOR UPDATE%'
      `;
      observed = row?.waitingCount ?? 0;
      if (observed >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`expected ${expected} Activity root-lock waiter(s), observed ${observed}`);
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
    const done = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Activity" WHERE id = ${activityId} FOR UPDATE
        `;
        markAcquired();
        await gate;
      },
      { maxWait: 60_000, timeout: 60_000 },
    );
    return { acquired, release, done };
  }

  it('rejects missing or out-of-set allocationModeCode without Activity or audit writes', async () => {
    sequence += 1;
    const before = await Promise.all([prisma.activity.count(), prisma.auditLog.count()]);
    const admin = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', creatorAuth)
      .send(createPayload(`缺少分配方式 Admin ${sequence}`));
    expect(admin.status).toBe(400);

    const appManaged = await request(httpServer(app))
      .post('/api/app/v1/my/managed-activities')
      .set('Authorization', creatorAuth)
      .send(createPayload(`缺少分配方式 App ${sequence}`));
    expect(appManaged.status).toBe(400);

    const invalid = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', creatorAuth)
      .send(createPayload(`非法分配方式 ${sequence}`, 'not-an-allocation-mode'));
    expect(invalid.status).toBe(400);
    const nullMode = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', creatorAuth)
      .send({ ...createPayload(`空分配方式 ${sequence}`, 'first_come'), allocationModeCode: null });
    expect(nullMode.status).toBe(400);
    const appInvalid = await request(httpServer(app))
      .post('/api/app/v1/my/managed-activities')
      .set('Authorization', creatorAuth)
      .send(createPayload(`App 非法分配方式 ${sequence}`, 'not-an-allocation-mode'));
    expect(appInvalid.status).toBe(400);
    await expect(Promise.all([prisma.activity.count(), prisma.auditLog.count()])).resolves.toEqual(
      before,
    );
  });

  it.each(ALLOCATION_MODES)(
    'persists and returns explicit %s through both create surfaces',
    async (mode) => {
      const adminActivityId = await createDraft(mode);
      await expect(
        prisma.activity.findUniqueOrThrow({
          where: { id: adminActivityId },
          select: { allocationModeCode: true },
        }),
      ).resolves.toEqual({ allocationModeCode: mode });
      const adminDetail = await request(httpServer(app))
        .get(`/api/admin/v1/activities/${adminActivityId}`)
        .set('Authorization', creatorAuth);
      expect(adminDetail.status).toBe(200);
      expect(adminDetail.body.data.allocationModeCode).toBe(mode);

      sequence += 1;
      const appCreated = await request(httpServer(app))
        .post('/api/app/v1/my/managed-activities')
        .set('Authorization', creatorAuth)
        .send(createPayload(`三值 App ${sequence}`, mode));
      expect(appCreated.status).toBe(201);
      expect(appCreated.body.data.activity.allocationModeCode).toBe(mode);
      const appActivityId = appCreated.body.data.activity.id as string;
      await expect(
        prisma.activity.findUniqueOrThrow({
          where: { id: appActivityId },
          select: { allocationModeCode: true },
        }),
      ).resolves.toEqual({ allocationModeCode: mode });
      const appDetail = await request(httpServer(app))
        .get(`/api/app/v1/my/managed-activities/${appActivityId}`)
        .set('Authorization', creatorAuth);
      expect(appDetail.status).toBe(200);
      expect(appDetail.body.data.activity.allocationModeCode).toBe(mode);
    },
  );

  it('allows Admin and App draft PATCH to change allocationModeCode and records it in audit snapshots', async () => {
    const adminActivityId = await createDraft('first_come');
    const adminPatched = await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${adminActivityId}`)
      .set('Authorization', creatorAuth)
      .send({ allocationModeCode: 'qualification_rank' });
    expect(adminPatched.status).toBe(200);
    expect(adminPatched.body.data.allocationModeCode).toBe('qualification_rank');
    const adminAudit = await prisma.auditLog.findFirstOrThrow({
      where: { resourceId: adminActivityId },
      orderBy: { createdAt: 'desc' },
      select: { context: true },
    });
    const adminContext = adminAudit.context as {
      before: { allocationModeCode: string };
      after: { allocationModeCode: string };
    };
    expect(adminContext.before.allocationModeCode).toBe('first_come');
    expect(adminContext.after.allocationModeCode).toBe('qualification_rank');

    sequence += 1;
    const appCreated = await request(httpServer(app))
      .post('/api/app/v1/my/managed-activities')
      .set('Authorization', creatorAuth)
      .send(createPayload(`App 草稿修改分配方式 ${sequence}`, 'qualification_rank'));
    expect(appCreated.status).toBe(201);
    const appActivityId = appCreated.body.data.activity.id as string;
    const appPatched = await request(httpServer(app))
      .patch(`/api/app/v1/my/managed-activities/${appActivityId}`)
      .set('Authorization', creatorAuth)
      .send({ allocationModeCode: 'lottery' });
    expect(appPatched.status).toBe(200);
    expect(appPatched.body.data.activity.allocationModeCode).toBe('lottery');
  });

  it('freezes a newly submitted proposal as schemaVersion 6', async () => {
    const activityId = await createDraft('qualification_rank');
    await createLiveSession(activityId);
    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/publish-reviews`)
      .set('Authorization', creatorAuth)
      .send({ operationKey: `batch4-allocation-v4-${sequence}`, confirmation: true });
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.snapshot).toEqual(
      expect.objectContaining({
        schemaVersion: 6,
        activity: expect.objectContaining({ allocationModeCode: 'qualification_rank' }),
        base: expect.objectContaining({
          activity: expect.objectContaining({ allocationModeCode: 'qualification_rank' }),
        }),
      }),
    );
  });

  it.each(['preparing', 'committed', 'voided'] as const)(
    'fails closed before draft PATCH when a %s historical batch mode differs',
    async (statusCode) => {
      const activityId = await createDraft('first_come');
      const sessionId = await createLiveSession(activityId);
      await seedMismatchedBatch(activityId, sessionId, statusCode);
      const before = await protectedWriteState(activityId);
      const patched = await request(httpServer(app))
        .patch(`/api/admin/v1/activities/${activityId}`)
        .set('Authorization', creatorAuth)
        .send({ title: '不应越过父子模式闸' });
      expect(patched.status).toBe(409);
      expect(patched.body.code).toBe(ALLOCATION_MODE_INCONSISTENT);
      await expect(protectedWriteState(activityId)).resolves.toEqual(before);
    },
  );

  it('fails closed before initial submit when a preparing batch mode differs', async () => {
    const activityId = await createDraft('first_come');
    const sessionId = await createLiveSession(activityId);
    await seedMismatchedBatch(activityId, sessionId);
    const before = await protectedWriteState(activityId);
    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/publish-reviews`)
      .set('Authorization', creatorAuth)
      .send({ operationKey: `batch4-allocation-submit-${sequence}`, confirmation: true });
    expect(submitted.status).toBe(409);
    expect(submitted.body.code).toBe(ALLOCATION_MODE_INCONSISTENT);
    await expect(protectedWriteState(activityId)).resolves.toEqual(before);
  });

  it('fails closed before approval when a batch changes out of sync while review is pending', async () => {
    const activityId = await createDraft('first_come');
    const sessionId = await createLiveSession(activityId);
    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/publish-reviews`)
      .set('Authorization', creatorAuth)
      .send({ operationKey: `batch4-allocation-approve-submit-${sequence}`, confirmation: true });
    expect(submitted.status).toBe(200);
    await seedMismatchedBatch(activityId, sessionId);
    const before = await protectedWriteState(activityId);
    const approved = await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${submitted.body.data.id}/approve`)
      .set('Authorization', reviewerAuth)
      .send({
        requiresInsuranceConfirmed: true,
        operationKey: `batch4-allocation-approve-${sequence}`,
      });
    expect(approved.status).toBe(409);
    expect(approved.body.code).toBe(ALLOCATION_MODE_INCONSISTENT);
    await expect(protectedWriteState(activityId)).resolves.toEqual(before);
  });

  it('freezes and applies allocationModeCode through a v4 change review, including changeDiff', async () => {
    const activityId = await createDraft('first_come');
    await createLiveSession(activityId);
    const initial = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/publish-reviews`)
      .set('Authorization', creatorAuth)
      .send({ operationKey: `batch4-allocation-change-initial-${sequence}`, confirmation: true });
    expect(initial.status).toBe(200);
    await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${initial.body.data.id}/approve`)
      .set('Authorization', reviewerAuth)
      .send({
        requiresInsuranceConfirmed: true,
        operationKey: `batch4-allocation-change-initial-approve-${sequence}`,
      })
      .expect(200);

    const publishedPatch = await request(httpServer(app))
      .patch(`/api/app/v1/my/managed-activities/${activityId}`)
      .set('Authorization', creatorAuth)
      .send({ allocationModeCode: 'lottery' });
    expect(publishedPatch.status).toBe(409);
    expect(publishedPatch.body.code).toBe(BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED.code);

    const change = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/change-reviews`)
      .set('Authorization', creatorAuth)
      .send({
        operationKey: `batch4-allocation-change-${sequence}`,
        confirmation: true,
        activityPatch: { allocationModeCode: 'lottery' },
        sessions: { create: [], update: [], cancel: [] },
        positions: { create: [], update: [], cancel: [] },
      });
    expect(change.status).toBe(200);
    expect(change.body.data.snapshot).toEqual(
      expect.objectContaining({
        schemaVersion: 6,
        activity: expect.objectContaining({ allocationModeCode: 'lottery' }),
        base: expect.objectContaining({
          activity: expect.objectContaining({ allocationModeCode: 'first_come' }),
        }),
      }),
    );
    const reviewDetail = await request(httpServer(app))
      .get(`/api/admin/v1/activity-publish-reviews/${change.body.data.id}`)
      .set('Authorization', reviewerAuth)
      .expect(200);
    expect(reviewDetail.body.data.changeDiff.activityFields).toEqual(
      expect.arrayContaining(['allocationModeCode']),
    );

    await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${change.body.data.id}/approve`)
      .set('Authorization', reviewerAuth)
      .send({
        requiresInsuranceConfirmed: true,
        operationKey: `batch4-allocation-change-approve-${sequence}`,
      })
      .expect(200);
    await expect(
      prisma.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: { statusCode: true, allocationModeCode: true },
      }),
    ).resolves.toEqual({ statusCode: 'published', allocationModeCode: 'lottery' });
  });

  it('returns 20144 with zero protected writes when a pending v4 mode drifts through a bypass', async () => {
    const activityId = await createDraft('qualification_rank');
    await createLiveSession(activityId);
    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/publish-reviews`)
      .set('Authorization', creatorAuth)
      .send({ operationKey: `batch4-allocation-stale-submit-${sequence}`, confirmation: true });
    expect(submitted.status).toBe(200);
    await prisma.activity.update({
      where: { id: activityId },
      data: { allocationModeCode: 'lottery' },
    });
    const before = await protectedWriteState(activityId);
    const approved = await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${submitted.body.data.id}/approve`)
      .set('Authorization', reviewerAuth)
      .send({
        requiresInsuranceConfirmed: true,
        operationKey: `batch4-allocation-stale-approve-${sequence}`,
      });
    expect(approved.status).toBe(409);
    expect(approved.body.code).toBe(
      BizCode.ACTIVITY_PUBLISH_REVIEW_EXPECTED_SNAPSHOT_MISMATCH.code,
    );
    await expect(protectedWriteState(activityId)).resolves.toEqual(before);
  });

  it('keeps a historical v1 initial snapshot mode-free and preserves the current Activity mode on approval', async () => {
    const activityId = await createDraft('first_come');
    await createLiveSession(activityId);
    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/submit-publish-review`)
      .set('Authorization', creatorAuth)
      .send({});
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.snapshot).toEqual(expect.objectContaining({ schemaVersion: 1 }));
    expect(submitted.body.data.snapshot.activity).not.toHaveProperty('allocationModeCode');

    await prisma.activity.update({
      where: { id: activityId },
      data: { allocationModeCode: 'lottery' },
    });
    await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${submitted.body.data.id}/approve`)
      .set('Authorization', reviewerAuth)
      .send({ requiresInsuranceConfirmed: true })
      .expect(200);
    await expect(
      prisma.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: { statusCode: true, allocationModeCode: true },
      }),
    ).resolves.toEqual({ statusCode: 'published', allocationModeCode: 'lottery' });
  });

  it('carries an explicit mode through the legacy v1 change-review path instead of dropping it', async () => {
    const activityId = await createDraft('first_come');
    await createLiveSession(activityId);
    const initial = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/submit-publish-review`)
      .set('Authorization', creatorAuth)
      .send({});
    expect(initial.status).toBe(200);
    await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${initial.body.data.id}/approve`)
      .set('Authorization', reviewerAuth)
      .send({ requiresInsuranceConfirmed: true })
      .expect(200);

    const changed = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/submit-change-review`)
      .set('Authorization', creatorAuth)
      .send({ activity: { allocationModeCode: 'lottery' } });
    expect(changed.status).toBe(200);
    expect(changed.body.data.snapshot).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        activity: expect.objectContaining({ allocationModeCode: 'lottery' }),
      }),
    );
    await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${changed.body.data.id}/approve`)
      .set('Authorization', reviewerAuth)
      .send({ requiresInsuranceConfirmed: true })
      .expect(200);
    await expect(
      prisma.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: { allocationModeCode: true },
      }),
    ).resolves.toEqual({ allocationModeCode: 'lottery' });
  });

  it('serializes two independent Prisma pools so PATCH and initial submit cannot mix parent mode with a stale snapshot', async () => {
    expect(peerPrisma).not.toBe(prisma);

    const updateWinsActivityId = await createDraft('first_come');
    await createLiveSession(updateWinsActivityId);
    const updateWinsGate = holdActivityRootLock(updateWinsActivityId);
    await updateWinsGate.acquired;
    const patchFirst = request(httpServer(app))
      .patch(`/api/admin/v1/activities/${updateWinsActivityId}`)
      .set('Authorization', creatorAuth)
      .send({ allocationModeCode: 'lottery' })
      .then((response) => response);
    await waitForActivityRootLockWaiters(1);
    const submitSecond = request(httpServer(peerApp))
      .post(`/api/app/v1/my/managed-activities/${updateWinsActivityId}/publish-reviews`)
      .set('Authorization', creatorAuth)
      .send({ operationKey: `batch4-allocation-race-update-first-${sequence}`, confirmation: true })
      .then((response) => response);
    await waitForActivityRootLockWaiters(2);
    updateWinsGate.release();
    await updateWinsGate.done;
    const [patched, submitted] = await Promise.all([patchFirst, submitSecond]);
    expect(patched.status).toBe(200);
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.snapshot.activity.allocationModeCode).toBe('lottery');
    await expect(
      prisma.activity.findUniqueOrThrow({
        where: { id: updateWinsActivityId },
        select: { allocationModeCode: true },
      }),
    ).resolves.toEqual({ allocationModeCode: 'lottery' });

    const submitWinsActivityId = await createDraft('first_come');
    await createLiveSession(submitWinsActivityId);
    const submitWinsGate = holdActivityRootLock(submitWinsActivityId);
    await submitWinsGate.acquired;
    const submitFirst = request(httpServer(peerApp))
      .post(`/api/app/v1/my/managed-activities/${submitWinsActivityId}/publish-reviews`)
      .set('Authorization', creatorAuth)
      .send({ operationKey: `batch4-allocation-race-submit-first-${sequence}`, confirmation: true })
      .then((response) => response);
    await waitForActivityRootLockWaiters(1);
    const patchSecond = request(httpServer(app))
      .patch(`/api/admin/v1/activities/${submitWinsActivityId}`)
      .set('Authorization', creatorAuth)
      .send({ allocationModeCode: 'lottery' })
      .then((response) => response);
    await waitForActivityRootLockWaiters(2);
    submitWinsGate.release();
    await submitWinsGate.done;
    const [submittedFirst, patchedSecond] = await Promise.all([submitFirst, patchSecond]);
    expect(submittedFirst.status).toBe(200);
    expect(submittedFirst.body.data.snapshot.activity.allocationModeCode).toBe('first_come');
    expect(patchedSecond.status).toBe(409);
    expect(patchedSecond.body.code).toBe(BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING.code);
    await expect(
      prisma.activity.findUniqueOrThrow({
        where: { id: submitWinsActivityId },
        select: { allocationModeCode: true },
      }),
    ).resolves.toEqual({ allocationModeCode: 'first_come' });
  }, 90_000);

  it('adds allocationMode to the public App detail without widening its list projection', async () => {
    sequence += 1;
    const activity = await prisma.activity.create({
      data: {
        title: `公开详情分配方式 ${sequence}`,
        activityTypeCode,
        organizationId,
        startAt: new Date('2099-11-01T01:00:00.000Z'),
        endAt: new Date('2099-11-01T05:00:00.000Z'),
        location: '深圳',
        statusCode: 'published',
        allocationModeCode: 'lottery',
      },
      select: { id: true },
    });
    const detail = await request(httpServer(app))
      .get(`/api/app/v1/activities/${activity.id}`)
      .set('Authorization', creatorAuth);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toEqual(expect.objectContaining({ allocationMode: 'lottery' }));
    const list = await request(httpServer(app))
      .get('/api/app/v1/activities/available')
      .set('Authorization', creatorAuth);
    expect(list.status).toBe(200);
    const item = (list.body.data.items as Array<{ id: string }>).find(
      (row) => row.id === activity.id,
    );
    expect(item).toBeDefined();
    expect(item).not.toHaveProperty('allocationMode');
  });
});
