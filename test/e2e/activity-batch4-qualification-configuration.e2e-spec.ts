import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

describe('activity batch4 qualification configuration', () => {
  let app: INestApplication;
  let peerApp: INestApplication;
  let prisma: PrismaService;
  let peerPrisma: PrismaService;
  let managerAuth: string;
  let reviewerAuth: string;
  let organizationId: string;
  let activityTypeCode: string;
  let attendanceRoleCode: string;
  let sequence = 0;
  const previousResponsibilityWorkflow = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;

  const next = (prefix: string) => `${prefix}-${++sequence}`;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    peerApp = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    peerPrisma = peerApp.get(PrismaService);
    await seedActivityResponsibilitySystemRoles(app);

    const manager = await createTestUser(app, {
      username: 'b4-qcfg-manager',
      role: Role.SUPER_ADMIN,
    });
    const member = await prisma.member.create({
      data: {
        memberNo: 'batch4-qualification-config-manager-member',
        ...memberIdentityData('资格配置负责人'),
        gradeCode: 'level-3',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: manager.id }, data: { memberId: member.id } });
    const bizAdmin = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, manager.id, bizAdmin.bizAdminRoleId);
    const reviewer = await createTestUser(app, {
      username: 'b4-qcfg-reviewer',
      role: Role.SUPER_ADMIN,
    });
    reviewerAuth = (await loginAs(app, reviewer.username)).authHeader;

    const root = await prisma.organization.create({
      data: { name: '资格配置根组织', nodeTypeCode: 'qualification-config-root' },
      select: { id: true },
    });
    const organization = await prisma.organization.create({
      data: {
        name: '资格配置执行组织',
        nodeTypeCode: 'qualification-config-team',
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
      data: { memberId: member.id, organizationId },
    });

    const activityType = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    activityTypeCode = 'batch4-qualification-config';
    await prisma.dictItem.create({
      data: { typeId: activityType.id, code: activityTypeCode, label: '资格配置活动' },
    });
    const attendanceRole = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    attendanceRoleCode = 'b4-qcfg-attendee';
    await prisma.dictItem.create({
      data: { typeId: attendanceRole.id, code: attendanceRoleCode, label: '资格配置岗位' },
    });
    managerAuth = (await loginAs(app, manager.username)).authHeader;
  });

  afterAll(async () => {
    await Promise.all([app.close(), peerApp.close()]);
    if (previousResponsibilityWorkflow === undefined) {
      delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousResponsibilityWorkflow;
    }
  });

  async function createDraftActivity(): Promise<string> {
    const response = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', managerAuth)
      .send({
        title: next('资格配置草稿活动'),
        activityTypeCode,
        organizationId,
        startAt: '2199-08-01T01:00:00.000Z',
        endAt: '2199-08-01T05:00:00.000Z',
        registrationDeadline: '2199-07-31T12:00:00.000Z',
        location: '深圳',
        allocationModeCode: 'qualification_rank',
      });
    expect(response.status).toBe(201);
    return response.body.data.id as string;
  }

  async function createSessionAndPosition(activityId: string): Promise<{
    sessionId: string;
    positionId: string;
  }> {
    const session = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions`)
      .set('Authorization', managerAuth)
      .send({
        code: next('session'),
        name: '资格配置场次',
        startAt: '2199-08-01T01:00:00.000Z',
        endAt: '2199-08-01T05:00:00.000Z',
        locationText: '深圳会场',
        checkInOpenAt: '2199-08-01T00:30:00.000Z',
        checkInCloseAt: '2199-08-01T02:00:00.000Z',
        checkOutOpenAt: '2199-08-01T03:00:00.000Z',
        checkOutCloseAt: '2199-08-01T05:00:00.000Z',
        locationRequired: false,
      });
    expect(session.status).toBe(201);
    const sessionId = session.body.data.sessionId as string;
    const position = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}/positions`)
      .set('Authorization', managerAuth)
      .send({
        code: next('position'),
        name: '资格配置岗位',
        attendanceRoleCode,
        capacity: 3,
        startAt: '2199-08-01T01:30:00.000Z',
        endAt: '2199-08-01T04:30:00.000Z',
      });
    expect(position.status).toBe(201);
    return { sessionId, positionId: position.body.data.positionId as string };
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
    throw new Error(
      `expected ${expected} qualification Activity lock waiter(s), observed ${observed}`,
    );
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

  it('red-first: replaces a draft activity qualification configuration through the managed HTTP route', async () => {
    const activityId = await createDraftActivity();

    const response = await request(httpServer(app))
      .put(`/api/app/v1/my/managed-activities/${activityId}/qualification-rules`)
      .set('Authorization', managerAuth)
      .send({
        ruleSets: [
          {
            scope: { sessionId: null, positionId: null },
            rules: [
              {
                ruleTypeCode: 'grade',
                enforcementCode: 'block',
                operator: 'in',
                codes: ['L2', 'L1'],
                sortOrder: 10,
              },
              {
                ruleTypeCode: 'age',
                enforcementCode: 'warn',
                operator: 'between',
                minYears: 18,
                maxYears: null,
                warnScore: 20,
                sortOrder: 20,
              },
            ],
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      ruleSets: [
        {
          scope: { sessionId: null, positionId: null },
          version: 1,
          rules: [
            {
              ruleTypeCode: 'grade',
              enforcementCode: 'block',
              operator: 'in',
              codes: ['L1', 'L2'],
              warnScore: null,
              message: null,
              sortOrder: 10,
            },
            {
              ruleTypeCode: 'age',
              enforcementCode: 'warn',
              operator: 'between',
              minYears: 18,
              maxYears: null,
              warnScore: 20,
              message: null,
              sortOrder: 20,
            },
          ],
        },
      ],
    });
  });

  it('serializes two independent Prisma pools so competing full replacements create a deterministic v1 then v2 chain', async () => {
    expect(peerPrisma).not.toBe(prisma);
    const activityId = await createDraftActivity();
    const gate = holdActivityRootLock(activityId);
    await gate.acquired;
    const first = request(httpServer(app))
      .put(`/api/app/v1/my/managed-activities/${activityId}/qualification-rules`)
      .set('Authorization', managerAuth)
      .send({
        ruleSets: [
          {
            scope: { sessionId: null, positionId: null },
            rules: [
              {
                ruleTypeCode: 'grade',
                enforcementCode: 'block',
                operator: 'in',
                codes: ['L1'],
                sortOrder: 10,
              },
            ],
          },
        ],
      })
      .then((response) => response);
    await waitForActivityRootLockWaiters(1);
    const second = request(httpServer(peerApp))
      .put(`/api/app/v1/my/managed-activities/${activityId}/qualification-rules`)
      .set('Authorization', managerAuth)
      .send({
        ruleSets: [
          {
            scope: { sessionId: null, positionId: null },
            rules: [
              {
                ruleTypeCode: 'grade',
                enforcementCode: 'block',
                operator: 'in',
                codes: ['L2'],
                sortOrder: 10,
              },
            ],
          },
        ],
      })
      .then((response) => response);
    await waitForActivityRootLockWaiters(2);
    gate.release();
    await gate.done;
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    await expect(
      prisma.activityQualificationRuleSet.findMany({
        where: { activityId },
        select: { version: true, statusCode: true, rules: { select: { valueJson: true } } },
        orderBy: { version: 'asc' },
      }),
    ).resolves.toEqual([
      { version: 1, statusCode: 'retired', rules: [{ valueJson: { codes: ['L1'] } }] },
      { version: 2, statusCode: 'draft', rules: [{ valueJson: { codes: ['L2'] } }] },
    ]);
  }, 90_000);

  it('red-first: freezes activity, session, and position rule versions during initial publish approval', async () => {
    const activityId = await createDraftActivity();
    const { sessionId, positionId } = await createSessionAndPosition(activityId);
    const configured = await request(httpServer(app))
      .put(`/api/app/v1/my/managed-activities/${activityId}/qualification-rules`)
      .set('Authorization', managerAuth)
      .send({
        ruleSets: [
          {
            scope: { sessionId: null, positionId: null },
            rules: [
              {
                ruleTypeCode: 'grade',
                enforcementCode: 'block',
                operator: 'in',
                codes: ['L1'],
                sortOrder: 10,
              },
            ],
          },
          {
            scope: { sessionId, positionId: null },
            rules: [
              {
                ruleTypeCode: 'age',
                enforcementCode: 'warn',
                operator: 'between',
                minYears: 18,
                warnScore: 15,
                sortOrder: 10,
              },
            ],
          },
          {
            scope: { sessionId, positionId },
            rules: [
              {
                ruleTypeCode: 'insurance',
                enforcementCode: 'block',
                operator: 'covers_activity',
                sortOrder: 10,
              },
            ],
          },
        ],
      });
    expect(configured.status).toBe(200);

    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/publish-reviews`)
      .set('Authorization', managerAuth)
      .send({ operationKey: next('qualification-initial-submit'), confirmation: true });
    expect(submitted.status).toBe(200);
    await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${submitted.body.data.id}/approve`)
      .set('Authorization', reviewerAuth)
      .send({
        requiresInsuranceConfirmed: true,
        operationKey: next('qualification-initial-approve'),
      })
      .expect(200);

    const current = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${activityId}/qualification-rules`)
      .set('Authorization', managerAuth);
    expect(current.status).toBe(200);
    expect(current.body.data.ruleSets).toHaveLength(3);
    await expect(
      prisma.activityQualificationRuleSet.findMany({
        where: { activityId },
        select: { statusCode: true, sessionId: true, positionId: true },
        orderBy: [{ sessionId: 'asc' }, { positionId: 'asc' }],
      }),
    ).resolves.toEqual([
      { statusCode: 'active', sessionId, positionId },
      { statusCode: 'active', sessionId, positionId: null },
      { statusCode: 'active', sessionId: null, positionId: null },
    ]);
    await expect(
      prisma.activitySessionPosition.findUniqueOrThrow({
        where: { id: positionId },
        select: { qualificationRuleSetId: true },
      }),
    ).resolves.toEqual({ qualificationRuleSetId: expect.any(String) });
    const ruleSnapshot = await prisma.activityRuleSnapshot.findFirstOrThrow({
      where: { activityId },
      orderBy: { workflowRevision: 'desc' },
      select: { resolvedConfig: true },
    });
    const resolvedConfig = ruleSnapshot.resolvedConfig as {
      qualificationRuleSets?: Array<Record<string, unknown>>;
    };
    expect(resolvedConfig.qualificationRuleSets).toHaveLength(3);
    expect(resolvedConfig.qualificationRuleSets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: { sessionId, positionId },
          ruleSetVersionId: expect.any(String),
          version: 1,
          definitionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]),
    );
    expect(resolvedConfig.qualificationRuleSets?.every((ruleSet) => !('rules' in ruleSet))).toBe(
      true,
    );
  });

  it('requires explicit RuleSet cancellation and resolves a new-position clientRef only inside the approved V5 proposal', async () => {
    const activityId = await createDraftActivity();
    const { sessionId, positionId } = await createSessionAndPosition(activityId);
    await request(httpServer(app))
      .put(`/api/app/v1/my/managed-activities/${activityId}/qualification-rules`)
      .set('Authorization', managerAuth)
      .send({
        ruleSets: [
          {
            scope: { sessionId: null, positionId: null },
            rules: [
              {
                ruleTypeCode: 'grade',
                enforcementCode: 'block',
                operator: 'in',
                codes: ['L1'],
                sortOrder: 10,
              },
            ],
          },
          {
            scope: { sessionId, positionId: null },
            rules: [
              {
                ruleTypeCode: 'age',
                enforcementCode: 'warn',
                operator: 'between',
                minYears: 18,
                warnScore: 10,
                sortOrder: 10,
              },
            ],
          },
          {
            scope: { sessionId, positionId },
            rules: [
              {
                ruleTypeCode: 'insurance',
                enforcementCode: 'block',
                operator: 'covers_activity',
                sortOrder: 10,
              },
            ],
          },
        ],
      })
      .expect(200);
    const initial = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/publish-reviews`)
      .set('Authorization', managerAuth)
      .send({ operationKey: next('qualification-change-initial-submit'), confirmation: true })
      .expect(200);
    await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${initial.body.data.id}/approve`)
      .set('Authorization', reviewerAuth)
      .send({
        requiresInsuranceConfirmed: true,
        operationKey: next('qualification-change-initial-approve'),
      })
      .expect(200);

    const publishedPut = await request(httpServer(app))
      .put(`/api/app/v1/my/managed-activities/${activityId}/qualification-rules`)
      .set('Authorization', managerAuth)
      .send({ ruleSets: [] });
    expect(publishedPut.status).toBe(409);
    expect(publishedPut.body.code).toBe(BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED.code);

    const beforeMissingExplicitCancel = await Promise.all([
      prisma.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: { title: true, workflowRevision: true, currentPopulationRevision: true },
      }),
      prisma.activityQualificationRuleSet.findMany({
        where: { activityId },
        select: { id: true, statusCode: true, version: true },
        orderBy: { id: 'asc' },
      }),
      prisma.activityPublishReview.count({ where: { activityId } }),
      prisma.activityRuleSnapshot.count({ where: { activityId } }),
      prisma.auditLog.count({ where: { resourceId: activityId } }),
    ]);
    const missingExplicitCancel = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/change-reviews`)
      .set('Authorization', managerAuth)
      .send({
        operationKey: next('qualification-change-missing-cancel'),
        confirmation: true,
        activityPatch: { title: '没有显式取消资格规则的岗位取消' },
        sessions: { create: [], update: [], cancel: [] },
        positions: { create: [], update: [], cancel: [{ sessionId, positionId }] },
      });
    expect(missingExplicitCancel.status).toBe(409);
    expect(missingExplicitCancel.body.code).toBe(
      BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID.code,
    );
    const missingExplicitSessionCancel = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/change-reviews`)
      .set('Authorization', managerAuth)
      .send({
        operationKey: next('qualification-change-missing-session-cancel'),
        confirmation: true,
        activityPatch: { title: '没有显式取消资格规则的场次取消' },
        sessions: { create: [], update: [], cancel: [{ sessionId }] },
        positions: { create: [], update: [], cancel: [] },
      });
    expect(missingExplicitSessionCancel.status).toBe(409);
    expect(missingExplicitSessionCancel.body.code).toBe(
      BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID.code,
    );
    await expect(
      prisma.activitySessionPosition.findUniqueOrThrow({
        where: { id: positionId },
        select: { deletedAt: true, qualificationRuleSetId: true },
      }),
    ).resolves.toEqual({ deletedAt: null, qualificationRuleSetId: expect.any(String) });
    await expect(
      Promise.all([
        prisma.activity.findUniqueOrThrow({
          where: { id: activityId },
          select: { title: true, workflowRevision: true, currentPopulationRevision: true },
        }),
        prisma.activityQualificationRuleSet.findMany({
          where: { activityId },
          select: { id: true, statusCode: true, version: true },
          orderBy: { id: 'asc' },
        }),
        prisma.activityPublishReview.count({ where: { activityId } }),
        prisma.activityRuleSnapshot.count({ where: { activityId } }),
        prisma.auditLog.count({ where: { resourceId: activityId } }),
      ]),
    ).resolves.toEqual(beforeMissingExplicitCancel);

    const newPositionRef = next('qualification-new-position-ref');
    const newPositionCode = next('qualification-new-position-code');
    const proposal = {
      operationKey: next('qualification-change-submit'),
      confirmation: true,
      activityPatch: { title: '资格规则 V5 变更' },
      sessions: { create: [], update: [], cancel: [] },
      positions: {
        create: [
          {
            sessionId,
            clientRef: newPositionRef,
            code: newPositionCode,
            name: 'V5 新岗位',
            attendanceRoleCode,
            capacity: 2,
            startAt: '2199-08-01T01:30:00.000Z',
            endAt: '2199-08-01T04:30:00.000Z',
          },
        ],
        update: [],
        cancel: [{ sessionId, positionId }],
      },
      qualificationRuleSets: {
        create: [
          {
            scope: { sessionId, positionId: newPositionRef },
            rules: [
              {
                ruleTypeCode: 'certificate',
                enforcementCode: 'warn',
                operator: 'has_any',
                standardIds: ['qualification-standard-1'],
                warnScore: 25,
                sortOrder: 10,
              },
            ],
          },
        ],
        update: [
          {
            scope: { sessionId, positionId: null },
            rules: [
              {
                ruleTypeCode: 'age',
                enforcementCode: 'warn',
                operator: 'between',
                minYears: 21,
                warnScore: 15,
                sortOrder: 10,
              },
            ],
          },
        ],
        cancel: [{ scope: { sessionId, positionId } }],
      },
    };
    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/change-reviews`)
      .set('Authorization', managerAuth)
      .send(proposal);
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.snapshot).toMatchObject({
      schemaVersion: 6,
      qualificationRuleSets: {
        ruleSets: expect.arrayContaining([
          expect.objectContaining({
            scope: { sessionId, positionId: newPositionRef },
          }),
        ]),
      },
    });
    const replay = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/change-reviews`)
      .set('Authorization', managerAuth)
      .send(proposal);
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(submitted.body.data.id);
    const conflict = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/change-reviews`)
      .set('Authorization', managerAuth)
      .send({ ...proposal, activityPatch: { title: '同 key 不同 V5 目标' } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe(BizCode.ACTIVITY_PUBLISH_REVIEW_OPERATION_KEY_CONFLICT.code);

    await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${submitted.body.data.id}/approve`)
      .set('Authorization', reviewerAuth)
      .send({
        requiresInsuranceConfirmed: true,
        operationKey: next('qualification-change-approve'),
      })
      .expect(200);

    const newPosition = await prisma.activitySessionPosition.findFirstOrThrow({
      where: { activityId, code: newPositionCode, deletedAt: null },
      select: { id: true, qualificationRuleSetId: true },
    });
    expect(newPosition.qualificationRuleSetId).toEqual(expect.any(String));
    await expect(
      prisma.activitySessionPosition.findUniqueOrThrow({
        where: { id: positionId },
        select: { deletedAt: true, qualificationRuleSetId: true },
      }),
    ).resolves.toEqual({ deletedAt: expect.any(Date), qualificationRuleSetId: null });
    await expect(
      prisma.activityQualificationRuleSet.findMany({
        where: { activityId },
        select: { statusCode: true, sessionId: true, positionId: true },
        orderBy: [{ sessionId: 'asc' }, { positionId: 'asc' }, { version: 'asc' }],
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { statusCode: 'active', sessionId: null, positionId: null },
        { statusCode: 'retired', sessionId, positionId: null },
        { statusCode: 'active', sessionId, positionId: null },
        { statusCode: 'retired', sessionId, positionId },
        { statusCode: 'active', sessionId, positionId: newPosition.id },
      ]),
    );

    const cloned = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/clone`)
      .set('Authorization', managerAuth)
      .send({ title: '资格规则定义副本' });
    expect(cloned.status).toBe(201);
    const cloneId = cloned.body.data.activityId as string;
    const clonePosition = await prisma.activitySessionPosition.findFirstOrThrow({
      where: { activityId: cloneId, code: newPositionCode, deletedAt: null },
      select: { id: true, qualificationRuleSetId: true },
    });
    expect(clonePosition.qualificationRuleSetId).toBeNull();
    const cloneRules = await prisma.activityQualificationRuleSet.findMany({
      where: { activityId: cloneId },
      select: { statusCode: true, version: true, sessionId: true, positionId: true },
      orderBy: [{ sessionId: 'asc' }, { positionId: 'asc' }],
    });
    expect(cloneRules).toHaveLength(3);
    expect(cloneRules).toEqual(
      expect.arrayContaining([
        { statusCode: 'draft', version: 1, sessionId: null, positionId: null },
        expect.objectContaining({ statusCode: 'draft', version: 1, positionId: null }),
        expect.objectContaining({
          statusCode: 'draft',
          version: 1,
          positionId: clonePosition.id,
        }),
      ]),
    );
  });
});
