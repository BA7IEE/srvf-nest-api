import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, BindingStatus, MemberStatus, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityResponsibilityAuditRecorder } from '../../src/modules/activities/activity-responsibility-audit-recorder';
import { OUTBOX_EVENT_TARGETED_NOTIFICATION } from '../../src/modules/notifications/notification.constants';
import { NotificationOutboxHandlers } from '../../src/modules/notifications/notification-outbox.handlers';
import { NotificationOutboxService } from '../../src/modules/notifications/notification-outbox.service';
import { NotificationOutboxWorker } from '../../src/modules/notifications/notification-outbox.worker';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

describe('activity responsibilities and system RoleBinding projection', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auditRecorder: ActivityResponsibilityAuditRecorder;
  let outbox: NotificationOutboxService;
  let outboxHandlers: NotificationOutboxHandlers;
  let outboxWorker: NotificationOutboxWorker;
  let adminAuth: string;
  let organizationId: string;
  let roleIds: Record<string, string>;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    auditRecorder = app.get(ActivityResponsibilityAuditRecorder);
    outbox = app.get(NotificationOutboxService);
    outboxHandlers = app.get(NotificationOutboxHandlers);
    outboxWorker = app.get(NotificationOutboxWorker);
    roleIds = await seedActivityResponsibilitySystemRoles(app);
    const admin = await createTestUser(app, {
      username: 'act-resp-super-admin',
      role: Role.SUPER_ADMIN,
    });
    adminAuth = (await loginAs(app, admin.username)).authHeader;
    const root = await prisma.organization.create({
      data: { name: '责任闭环根组织', nodeTypeCode: 'activity-responsibility-root' },
      select: { id: true },
    });
    const organization = await prisma.organization.create({
      data: {
        name: '责任闭环执行组织',
        nodeTypeCode: 'activity-responsibility-team',
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
  });

  afterAll(async () => {
    await app.close();
    if (previousGate === undefined) {
      delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousGate;
    }
  });

  async function createFormalMember(label: string): Promise<{
    memberId: string;
    userId: string;
    username: string;
  }> {
    sequence += 1;
    const member = await prisma.member.create({
      data: {
        memberNo: `responsibility-${label}-${sequence}`,
        displayName: `责任测试 ${label} ${sequence}`,
        gradeCode: `level-${(sequence % 7) + 1}`,
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    const username = `responsibility-${label}-${sequence}`;
    const user = await createTestUser(app, {
      username,
      role: Role.USER,
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { memberId: member.id },
    });
    await prisma.memberOrganizationMembership.create({
      data: { memberId: member.id, organizationId },
    });
    return { memberId: member.id, userId: user.id, username };
  }

  async function createLegacyActivity(statusCode: 'draft' | 'published' = 'published') {
    sequence += 1;
    return prisma.activity.create({
      data: {
        title: `责任闭环活动 ${sequence}`,
        activityTypeCode: 'activity-responsibility-e2e',
        organizationId,
        startAt: new Date('2099-11-01T01:00:00.000Z'),
        endAt: new Date('2099-11-01T05:00:00.000Z'),
        location: '深圳',
        statusCode,
      },
      select: { id: true, title: true },
    });
  }

  it('PR-L3 red: collaborator delegation persists a targeted intent before any Effect', async () => {
    const owner = await createFormalMember('l3-do');
    const collaborator = await createFormalMember('l3-dc');
    const activity = await createLegacyActivity();
    const claim = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activity.id}/responsibilities/claim`)
      .set('Authorization', adminAuth)
      .send({ ownerMemberId: owner.memberId, reason: 'L3 红测 owner' });
    expect(claim.status).toBe(200);

    const ownerAuth = (await loginAs(app, owner.username)).authHeader;
    const add = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activity.id}/responsibilities/collaborators`)
      .set('Authorization', ownerAuth)
      .send({
        memberId: collaborator.memberId,
        canManageRegistrations: true,
        canManageAttendance: true,
        reason: 'L3 红测委托',
      });
    expect(add.status).toBe(201);

    const assignmentId = add.body.data.id as string;
    await expect(
      prisma.notificationOutboxIntent.findMany({
        where: {
          eventKey: `responsibility-delegate:${assignmentId}`,
          eventType: OUTBOX_EVENT_TARGETED_NOTIFICATION,
          aggregateType: 'activity_responsibility_assignment',
          aggregateId: assignmentId,
          destinationType: 'member',
          destinationRef: collaborator.memberId,
          status: 'pending',
        },
      }),
    ).resolves.toHaveLength(1);
    await expect(
      prisma.notification.count({ where: { recipientMemberId: collaborator.memberId } }),
    ).resolves.toBe(0);
  });

  it('PR-L3 red: owner transfer rolls back assignments, grants and audit when intent enqueue fails', async () => {
    const owner = await createFormalMember('l3-to');
    const newOwner = await createFormalMember('l3-tn');
    const activity = await createLegacyActivity();
    const claim = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activity.id}/responsibilities/claim`)
      .set('Authorization', adminAuth)
      .send({ ownerMemberId: owner.memberId, reason: 'L3 红测移交 owner' });
    expect(claim.status).toBe(200);

    const ownerAuth = (await loginAs(app, owner.username)).authHeader;
    const auditCountBefore = await prisma.auditLog.count({
      where: { event: 'activity.publish', resourceId: activity.id },
    });
    const enqueueSpy = jest.spyOn(outbox, 'enqueue').mockRejectedValue(new Error('intent failed'));
    let transfer: request.Response;
    try {
      transfer = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activity.id}/responsibilities/transfer`)
        .set('Authorization', ownerAuth)
        .send({
          newOwnerMemberId: newOwner.memberId,
          reason: 'L3 红测强制 enqueue 失败',
          retainPreviousOwnerAsCollaborator: false,
        });
    } finally {
      enqueueSpy.mockRestore();
    }
    expect(transfer.status).toBe(500);
    await expect(
      prisma.activityResponsibilityAssignment.findMany({
        where: { activityId: activity.id, status: 'active' },
        select: { memberId: true, responsibilityType: true },
      }),
    ).resolves.toEqual([{ memberId: owner.memberId, responsibilityType: 'owner' }]);
    await expect(
      prisma.roleBinding.count({
        where: {
          principalId: newOwner.memberId,
          scopeActivityId: activity.id,
          status: BindingStatus.ACTIVE,
          deletedAt: null,
        },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.auditLog.count({
        where: { event: 'activity.publish', resourceId: activity.id },
      }),
    ).resolves.toBe(auditCountBefore);
  });

  it('rolls back collaborator assignment, grant and intent when audit persistence fails', async () => {
    const owner = await createFormalMember('l3-ao');
    const collaborator = await createFormalMember('l3-ac');
    const activity = await createLegacyActivity();
    const claim = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activity.id}/responsibilities/claim`)
      .set('Authorization', adminAuth)
      .send({ ownerMemberId: owner.memberId, reason: 'L3 audit rollback owner' });
    expect(claim.status).toBe(200);
    const ownerAuth = (await loginAs(app, owner.username)).authHeader;

    const auditSpy = jest
      .spyOn(auditRecorder, 'log')
      .mockRejectedValueOnce(new Error('audit failed'));
    try {
      await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activity.id}/responsibilities/collaborators`)
        .set('Authorization', ownerAuth)
        .send({
          memberId: collaborator.memberId,
          canManageRegistrations: true,
          canManageAttendance: false,
          reason: 'L3 audit rollback',
        })
        .expect(500);
    } finally {
      auditSpy.mockRestore();
    }
    await expect(
      prisma.activityResponsibilityAssignment.count({
        where: { activityId: activity.id, memberId: collaborator.memberId },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.roleBinding.count({
        where: {
          principalId: collaborator.memberId,
          scopeActivityId: activity.id,
          deletedAt: null,
        },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.notificationOutboxIntent.count({
        where: { destinationRef: collaborator.memberId },
      }),
    ).resolves.toBe(0);
  });

  it('claims legacy owner, projects collaborator capabilities, transfers and revokes immediately', async () => {
    const owner = await createFormalMember('owner');
    const collaborator = await createFormalMember('collaborator');
    const newOwner = await createFormalMember('new-owner');
    const publishReviewer = await createFormalMember('pubrev');
    const activity = await createLegacyActivity();
    await prisma.activity.update({
      where: { id: activity.id },
      data: {
        publishedBy: publishReviewer.userId,
        publishedAt: new Date('2026-07-27T00:00:00.000Z'),
      },
    });

    const claim = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activity.id}/responsibilities/claim`)
      .set('Authorization', adminAuth)
      .send({ ownerMemberId: owner.memberId, reason: '历史活动补录负责人' });
    expect(claim.status).toBe(200);
    expect(claim.body.data.memberId).toBe(owner.memberId);
    const ownerAuth = (await loginAs(app, owner.username)).authHeader;
    const ownerList = await request(httpServer(app))
      .get(`/api/admin/v1/activities/${activity.id}/responsibilities`)
      .set('Authorization', ownerAuth);
    expect(ownerList.status).toBe(200);
    expect(ownerList.body.data.owner.memberId).toBe(owner.memberId);
    await expect(
      prisma.roleBinding.findMany({
        where: {
          principalType: PrincipalType.MEMBER,
          principalId: owner.memberId,
          scopeType: BindingScopeType.ACTIVITY,
          scopeActivityId: activity.id,
          status: BindingStatus.ACTIVE,
          deletedAt: null,
        },
        select: { roleId: true, note: true },
      }),
    ).resolves.toEqual([
      {
        roleId: roleIds['activity-owner'],
        note: `system:activity-responsibility:${claim.body.data.id as string}`,
      },
    ]);

    const add = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activity.id}/responsibilities/collaborators`)
      .set('Authorization', ownerAuth)
      .send({
        memberId: collaborator.memberId,
        canManageRegistrations: true,
        canManageAttendance: true,
        reason: '共同执行',
      });
    expect(add.status).toBe(201);
    expect(
      await prisma.roleBinding.count({
        where: {
          principalType: PrincipalType.MEMBER,
          principalId: collaborator.memberId,
          scopeActivityId: activity.id,
          status: BindingStatus.ACTIVE,
          deletedAt: null,
        },
      }),
    ).toBe(2);
    const addIntent = await prisma.notificationOutboxIntent.findUniqueOrThrow({
      where: { eventKey: `responsibility-delegate:${add.body.data.id as string}` },
    });
    expect(addIntent).toMatchObject({
      aggregateType: 'activity_responsibility_assignment',
      aggregateId: add.body.data.id,
      destinationRef: collaborator.memberId,
      status: 'pending',
    });
    await expect(
      prisma.notification.count({ where: { recipientMemberId: collaborator.memberId } }),
    ).resolves.toBe(0);
    await expect(outboxWorker.drainEventKey(addIntent.eventKey)).resolves.toMatchObject({
      claimed: 1,
      succeeded: 1,
    });

    const end = await request(httpServer(app))
      .delete(
        `/api/admin/v1/activities/${activity.id}/responsibilities/collaborators/${
          add.body.data.id as string
        }`,
      )
      .set('Authorization', ownerAuth);
    expect(end.status).toBe(200);
    expect(end.body.data.status).toBe('ended');
    expect(
      await prisma.roleBinding.count({
        where: {
          principalId: collaborator.memberId,
          scopeActivityId: activity.id,
          status: BindingStatus.ACTIVE,
          deletedAt: null,
        },
      }),
    ).toBe(0);
    const endIntent = await prisma.notificationOutboxIntent.findFirstOrThrow({
      where: {
        aggregateId: add.body.data.id as string,
        eventKey: { startsWith: `responsibility-delegate-end:${add.body.data.id as string}:` },
      },
    });
    await expect(outboxWorker.drainEventKey(endIntent.eventKey)).resolves.toMatchObject({
      claimed: 1,
      succeeded: 1,
    });
    await expect(
      prisma.notification.findMany({
        where: { recipientMemberId: collaborator.memberId },
        orderBy: { createdAt: 'asc' },
        select: { title: true },
      }),
    ).resolves.toEqual([{ title: '你已被指定为活动协办人' }, { title: '活动协办职责已结束' }]);

    const transfer = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activity.id}/responsibilities/transfer`)
      .set('Authorization', ownerAuth)
      .send({
        newOwnerMemberId: newOwner.memberId,
        reason: '负责人交接',
        retainPreviousOwnerAsCollaborator: false,
      });
    expect(transfer.body.code).toBe(0);
    expect(transfer.status).toBe(200);
    expect(transfer.body.data.owner.memberId).toBe(newOwner.memberId);
    expect(
      await prisma.roleBinding.count({
        where: {
          principalId: owner.memberId,
          scopeActivityId: activity.id,
          status: BindingStatus.ACTIVE,
          deletedAt: null,
        },
      }),
    ).toBe(0);
    expect(
      await prisma.roleBinding.count({
        where: {
          principalId: newOwner.memberId,
          roleId: roleIds['activity-owner'],
          scopeActivityId: activity.id,
          status: BindingStatus.ACTIVE,
          deletedAt: null,
        },
      }),
    ).toBe(1);
    const newOwnerAssignmentId = transfer.body.data.owner.id as string;
    const transferIntents = await prisma.notificationOutboxIntent.findMany({
      where: {
        aggregateType: 'activity_responsibility_assignment',
        aggregateId: newOwnerAssignmentId,
        eventKey: { startsWith: `responsibility-transfer:${newOwnerAssignmentId}:` },
      },
      orderBy: { eventKey: 'asc' },
    });
    expect(transferIntents).toHaveLength(2);
    expect(transferIntents.map((intent) => intent.destinationRef).sort()).toEqual(
      [owner.memberId, newOwner.memberId].sort(),
    );
    expect(
      transferIntents.some((intent) => intent.destinationRef === publishReviewer.memberId),
    ).toBe(false);
    await expect(
      prisma.notification.count({
        where: { recipientMemberId: { in: [owner.memberId, newOwner.memberId] } },
      }),
    ).resolves.toBe(0);
    const previousOwnerIntent = transferIntents.find((intent) =>
      intent.eventKey.endsWith(':previous'),
    );
    const currentOwnerIntent = transferIntents.find((intent) =>
      intent.eventKey.endsWith(':current'),
    );
    if (!previousOwnerIntent || !currentOwnerIntent) {
      throw new Error('owner transfer intents are incomplete');
    }
    const dispatchSpy = jest
      .spyOn(outboxHandlers, 'execute')
      .mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(outboxWorker.drainEventKey(previousOwnerIntent.eventKey)).resolves.toMatchObject({
      claimed: 1,
      failed: 1,
    });
    await expect(
      prisma.activityResponsibilityAssignment.findFirstOrThrow({
        where: {
          id: newOwnerAssignmentId,
          status: 'active',
          memberId: newOwner.memberId,
        },
        select: { id: true },
      }),
    ).resolves.toEqual({ id: newOwnerAssignmentId });
    await expect(
      prisma.notificationOutboxIntent.findUniqueOrThrow({
        where: { eventKey: previousOwnerIntent.eventKey },
        select: { status: true, attempts: true },
      }),
    ).resolves.toEqual({ status: 'pending', attempts: 1 });
    await prisma.notificationOutboxIntent.update({
      where: { eventKey: previousOwnerIntent.eventKey },
      data: { availableAt: new Date(0) },
    });
    try {
      await expect(outboxWorker.drainEventKey(previousOwnerIntent.eventKey)).resolves.toMatchObject(
        {
          claimed: 1,
          succeeded: 1,
        },
      );
      await expect(outboxWorker.drainEventKey(currentOwnerIntent.eventKey)).resolves.toMatchObject({
        claimed: 1,
        succeeded: 1,
      });
    } finally {
      dispatchSpy.mockRestore();
    }
    await expect(
      prisma.notification.findMany({
        where: { recipientMemberId: { in: [owner.memberId, newOwner.memberId] } },
        select: { recipientMemberId: true, title: true },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { recipientMemberId: owner.memberId, title: '活动负责人已移交' },
        { recipientMemberId: newOwner.memberId, title: '你已成为活动负责人' },
      ]),
    );
  });

  it('rolls back the assignment if its deterministic RoleBinding cannot be projected', async () => {
    const owner = await createFormalMember('rollback-owner');
    const activity = await createLegacyActivity();
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.MEMBER,
        principalId: owner.memberId,
        roleId: roleIds['activity-owner'],
        scopeType: BindingScopeType.ACTIVITY,
        scopeActivityId: activity.id,
        status: BindingStatus.ACTIVE,
        note: 'conflicting-system-projection',
      },
    });
    const response = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activity.id}/responsibilities/claim`)
      .set('Authorization', adminAuth)
      .send({ ownerMemberId: owner.memberId, reason: '验证双写回滚' });
    expectBizError(response, BizCode.ACTIVITY_RESPONSIBILITY_ALREADY_EXISTS);
    expect(
      await prisma.activityResponsibilityAssignment.count({
        where: { activityId: activity.id },
      }),
    ).toBe(0);
  });

  it('member offboard blocks an active owner until responsibility is transferred', async () => {
    const owner = await createFormalMember('offboard-owner');
    const activity = await createLegacyActivity();
    const claim = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activity.id}/responsibilities/claim`)
      .set('Authorization', adminAuth)
      .send({ ownerMemberId: owner.memberId, reason: '离队联动测试' });
    expect(claim.status).toBe(200);

    const offboard = await request(httpServer(app))
      .post(`/api/admin/v1/members/${owner.memberId}/offboard`)
      .set('Authorization', adminAuth);
    expectBizError(offboard, BizCode.MEMBER_OFFBOARD_ACTIVITY_HANDOFF_REQUIRED);
    await expect(
      prisma.activityResponsibilityAssignment.findUniqueOrThrow({
        where: { id: claim.body.data.id as string },
        select: { status: true, endedAt: true, endedByUserId: true },
      }),
    ).resolves.toMatchObject({
      status: 'active',
      endedAt: null,
      endedByUserId: null,
    });
    expect(
      await prisma.roleBinding.count({
        where: {
          principalId: owner.memberId,
          scopeActivityId: activity.id,
          status: BindingStatus.ACTIVE,
          deletedAt: null,
        },
      }),
    ).toBe(1);
  });
});
