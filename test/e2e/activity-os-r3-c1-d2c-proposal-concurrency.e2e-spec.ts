import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, Prisma, PrincipalType, Role, UserStatus } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { parseMetricReceipt } from '../../src/modules/activities/activity-metric-command';
import type { ActivityMetricSetPointer } from '../../src/modules/activities/activity-metric-selection';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { httpServer } from '../helpers/http-server';
import { waitFor } from '../helpers/wait-for';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const APP = '/api/app/v1/my/managed-activities';
const ADMIN = '/api/admin/v1';
const DEFS = `${ADMIN}/activity-metric-definitions`;
const SETS = `${ADMIN}/activity-metric-sets`;

describe('C1 D2c V7 proposal lock waits', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let creatorAuth: string;
  let reviewerAuth: string;
  let creatorId: string;
  let organizationId: string;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
  const unique = (label: string): string => `c1-d2c-race-${label}-${++sequence}`;
  const metricCode = (label: string): string => `c1d2c_race_${label}_${++sequence}`;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    const creator = await createTestUser(app, {
      username: unique('creator'),
      role: Role.SUPER_ADMIN,
    });
    creatorId = creator.id;
    const reviewer = await createTestUser(app, { username: unique('reviewer'), role: Role.USER });
    const creatorMember = await prisma.member.create({
      data: {
        memberNo: unique('creator-member'),
        ...memberIdentityData('C1 D2c 并发发起人'),
        gradeCode: 'level-3',
      },
    });
    const reviewerMember = await prisma.member.create({
      data: {
        memberNo: unique('reviewer-member'),
        ...memberIdentityData('C1 D2c 并发审核人'),
        gradeCode: 'level-3',
      },
    });
    await prisma.user.update({ where: { id: creator.id }, data: { memberId: creatorMember.id } });
    await prisma.user.update({ where: { id: reviewer.id }, data: { memberId: reviewerMember.id } });
    const bizAdmin = await seedBizAdminPermissionsAndRole(app);
    await seedActivityResponsibilitySystemRoles(app);
    await grantBizAdminToUser(app, creator.id, bizAdmin.bizAdminRoleId);
    const root = await prisma.organization.create({
      data: { name: unique('root'), nodeTypeCode: unique('root-type') },
    });
    const organization = await prisma.organization.create({
      data: { name: unique('organization'), nodeTypeCode: unique('team-type'), parentId: root.id },
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
    const type = await prisma.dictType.create({
      data: { code: 'activity_type', label: 'C1 D2c 并发活动类型' },
    });
    await prisma.dictItem.create({
      data: { typeId: type.id, code: 'event_support', label: '活动保障' },
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
      data: { code: unique('reviewer-role'), displayName: 'C1 D2c 并发审核角色' },
    });
    const permissions = await prisma.permission.findMany({
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
      data: permissions.map((permission) => ({
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
    await app?.close();
    if (previousGate === undefined) delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousGate;
  });

  async function catalogue(): Promise<ActivityMetricSetPointer> {
    const definition = await request(httpServer(app))
      .post(DEFS)
      .set('Authorization', creatorAuth)
      .send({
        operationKey: unique('definition-create'),
        definition: {
          schemaVersion: 1,
          code: metricCode('definition'),
          version: 1,
          name: '并发指标定义',
          configuration: { kindCode: 'boolean', unit: null },
        },
      })
      .expect(201);
    const definitionReceipt = parseMetricReceipt(definition.body.data);
    await request(httpServer(app))
      .post(`${DEFS}/${definitionReceipt.id}/activate`)
      .set('Authorization', creatorAuth)
      .send({
        operationKey: unique('definition-activate'),
        expectedDefinitionHash: definitionReceipt.definitionHash,
      })
      .expect(200);
    const set = await request(httpServer(app))
      .post(SETS)
      .set('Authorization', creatorAuth)
      .send({
        operationKey: unique('set-create'),
        definition: {
          schemaVersion: 1,
          code: metricCode('set'),
          version: 1,
          name: '并发指标集',
          items: [
            {
              key: 'completed',
              sortOrder: 0,
              required: true,
              metricDefinitionId: definitionReceipt.id,
              definitionHash: definitionReceipt.definitionHash,
            },
          ],
        },
      })
      .expect(201);
    const setReceipt = parseMetricReceipt(set.body.data);
    await request(httpServer(app))
      .post(`${SETS}/${setReceipt.id}/activate`)
      .set('Authorization', creatorAuth)
      .send({
        operationKey: unique('set-activate'),
        expectedDefinitionHash: setReceipt.definitionHash,
      })
      .expect(200);
    return {
      id: setReceipt.id,
      code: setReceipt.code,
      version: setReceipt.version,
      schemaVersion: setReceipt.schemaVersion,
      definitionHash: setReceipt.definitionHash,
    };
  }

  async function createDraft(pointer: ActivityMetricSetPointer): Promise<string> {
    const created = await request(httpServer(app))
      .post(`${ADMIN}/activities`)
      .set('Authorization', creatorAuth)
      .send({
        title: unique('activity'),
        activityTypeCode: 'event_support',
        allocationModeCode: 'first_come',
        organizationId,
        startAt: '2099-09-01T08:00:00.000Z',
        endAt: '2099-09-01T10:00:00.000Z',
        registrationDeadline: '2099-08-31T12:00:00.000Z',
        location: 'C1 D2c 并发集合点',
        visibilityCode: 'internal',
        isPublicRegistration: true,
      })
      .expect(201);
    const activityId = created.body.data.id as string;
    await request(httpServer(app))
      .post(`${APP}/${activityId}/sessions`)
      .set('Authorization', creatorAuth)
      .send({
        code: unique('session'),
        name: '并发测试场次',
        startAt: '2099-09-01T08:00:00.000Z',
        endAt: '2099-09-01T10:00:00.000Z',
        locationText: 'C1 D2c 并发集合点',
        checkInOpenAt: '2099-09-01T07:30:00.000Z',
        checkInCloseAt: '2099-09-01T08:30:00.000Z',
        checkOutOpenAt: '2099-09-01T09:00:00.000Z',
        checkOutCloseAt: '2099-09-01T10:00:00.000Z',
        locationRequired: false,
      })
      .expect(201);
    await request(httpServer(app))
      .put(`${APP}/${activityId}/metric-selection`)
      .set('Authorization', creatorAuth)
      .send({
        operationKey: unique('selection'),
        expectedRevision: 0,
        metricSelection: { metricRequirementCode: 'required', metricSetPointer: pointer },
      })
      .expect(200);
    return activityId;
  }

  function submitInitial(activityId: string) {
    return request(httpServer(app))
      .post(`${APP}/${activityId}/publish-reviews`)
      .set('Authorization', creatorAuth)
      .send({ operationKey: unique('initial'), confirmation: true });
  }

  function approve(reviewId: string) {
    return request(httpServer(app))
      .post(`${ADMIN}/activity-publish-reviews/${reviewId}/approve`)
      .set('Authorization', reviewerAuth)
      .send({ requiresInsuranceConfirmed: true, operationKey: unique('approve') });
  }

  async function holdSet(
    id: string,
    beforeCommit: (tx: Prisma.TransactionClient) => Promise<unknown> = async () => undefined,
  ) {
    let signalReady!: (pid: number) => void;
    let signalRelease!: () => void;
    const ready = new Promise<number>((resolve) => {
      signalReady = resolve;
    });
    const released = new Promise<void>((resolve) => {
      signalRelease = resolve;
    });
    const held = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "ActivityMetricSetVersion" WHERE "id" = ${id} FOR UPDATE`,
        );
        const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        signalReady(backend.pid);
        await released;
        await beforeCommit(tx);
      },
      { timeout: 10000 },
    );
    const pid = await Promise.race([
      ready,
      held.then(() => {
        throw new Error('metric-set lock released before the contender started');
      }),
    ]);
    return {
      pid,
      release: async () => {
        signalRelease();
        await held;
      },
    };
  }

  async function waitForSetWaiter(pid: number) {
    await waitFor(
      async () => {
        const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
          WITH RECURSIVE waiters AS (
            SELECT a.pid, pg_blocking_pids(a.pid) AS blockers
            FROM pg_stat_activity AS a
            WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
          ), blocked_chain AS (
            SELECT pid FROM waiters WHERE ${pid} = ANY(blockers)
            UNION
            SELECT w.pid FROM waiters w JOIN blocked_chain b ON b.pid = ANY(w.blockers)
          ) SELECT count(*) FROM blocked_chain`;
        return row.count >= BigInt(1);
      },
      { timeoutMs: 2500, message: 'V7 catalogue share-lock waiter was not observed' },
    );
  }

  async function expectDraftSelectionUnchanged(
    activityId: string,
    pointer: ActivityMetricSetPointer,
  ) {
    expect(
      await prisma.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: {
          statusCode: true,
          metricRequirementCode: true,
          selectedMetricSetVersionId: true,
          selectedMetricSetDefinitionHash: true,
          metricSelectionRevision: true,
        },
      }),
    ).toEqual({
      statusCode: 'draft',
      metricRequirementCode: 'required',
      selectedMetricSetVersionId: pointer.id,
      selectedMetricSetDefinitionHash: pointer.definitionHash,
      metricSelectionRevision: 1,
    });
  }

  it('rejects submission without a review or partial Activity write when the selected set retires during its lock wait', async () => {
    const pointer = await catalogue();
    const activityId = await createDraft(pointer);
    const lock = await holdSet(pointer.id, (tx) =>
      tx.activityMetricSetVersion.update({
        where: { id: pointer.id },
        data: { statusCode: 'retired', retiredAt: new Date() },
      }),
    );
    const pending = submitInitial(activityId).then((response) => response);
    try {
      await waitForSetWaiter(lock.pid);
    } finally {
      await lock.release();
    }
    expectBizError(await pending, BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE);
    await expectDraftSelectionUnchanged(activityId, pointer);
    expect(await prisma.activityPublishReview.count({ where: { activityId } })).toBe(0);
  });

  it('rejects approval without changing the review or Activity when a new initial reference retires during its lock wait', async () => {
    const pointer = await catalogue();
    const activityId = await createDraft(pointer);
    const submitted = await submitInitial(activityId).expect(200);
    const reviewId = submitted.body.data.id as string;
    const lock = await holdSet(pointer.id, (tx) =>
      tx.activityMetricSetVersion.update({
        where: { id: pointer.id },
        data: { statusCode: 'retired', retiredAt: new Date() },
      }),
    );
    const pending = approve(reviewId).then((response) => response);
    try {
      await waitForSetWaiter(lock.pid);
    } finally {
      await lock.release();
    }
    expectBizError(await pending, BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE);
    await expectDraftSelectionUnchanged(activityId, pointer);
    expect(
      await prisma.activityPublishReview.findUniqueOrThrow({
        where: { id: reviewId },
        select: { status: true, reviewedByUserId: true, reviewedAt: true },
      }),
    ).toEqual({ status: 'pending', reviewedByUserId: null, reviewedAt: null });
  });

  it('rechecks the current submitter identity after the catalogue lock wait', async () => {
    const pointer = await catalogue();
    const activityId = await createDraft(pointer);
    const lock = await holdSet(pointer.id);
    const pending = submitInitial(activityId).then((response) => response);
    try {
      await waitForSetWaiter(lock.pid);
      await prisma.user.update({ where: { id: creatorId }, data: { status: UserStatus.DISABLED } });
    } finally {
      await lock.release();
    }
    try {
      expectBizError(await pending, BizCode.UNAUTHORIZED);
      await expectDraftSelectionUnchanged(activityId, pointer);
      expect(await prisma.activityPublishReview.count({ where: { activityId } })).toBe(0);
    } finally {
      await prisma.user.update({ where: { id: creatorId }, data: { status: UserStatus.ACTIVE } });
    }
  });
});
