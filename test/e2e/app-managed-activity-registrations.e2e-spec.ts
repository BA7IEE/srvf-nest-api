import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

describe('App managed activity registrations', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let organizationId: string;
  let activityTypeCode: string;
  let bizAdminRoleId: string;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    await seedActivityResponsibilitySystemRoles(app);
    bizAdminRoleId = (await seedBizAdminPermissionsAndRole(app)).bizAdminRoleId;

    const root = await prisma.organization.create({
      data: { name: 'Managed Registration Root', nodeTypeCode: 'managed-registration-root' },
      select: { id: true },
    });
    const organization = await prisma.organization.create({
      data: {
        name: 'Managed Registration Team',
        nodeTypeCode: 'managed-registration-team',
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
    const activityType = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    activityTypeCode = 'managed-registration-training';
    await prisma.dictItem.create({
      data: { typeId: activityType.id, code: activityTypeCode, label: '报名责任训练' },
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

  async function createMember(
    label: string,
    grantBizAdmin = false,
  ): Promise<{ memberId: string; userId: string; auth: string }> {
    const currentSequence = ++sequence;
    const member = await prisma.member.create({
      data: {
        memberNo: `managed-registration-${label}-${currentSequence}`,
        displayName: `Managed Registration ${label} ${currentSequence}`,
        gradeCode: 'level-3',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    const user = await createTestUser(app, {
      username: `mar-${currentSequence}`,
      role: Role.USER,
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    await prisma.memberOrganizationMembership.create({
      data: { memberId: member.id, organizationId },
    });
    if (grantBizAdmin) {
      await grantBizAdminToUser(app, user.id, bizAdminRoleId);
    }
    return {
      memberId: member.id,
      userId: user.id,
      auth: (await loginAs(app, user.username)).authHeader,
    };
  }

  async function createRegistration(
    activityId: string,
    label: string,
    statusCode: 'pending' | 'reject' = 'pending',
  ): Promise<string> {
    const member = await createMember(`registration-${label}`);
    const registration = await prisma.activityRegistration.create({
      data: {
        activityId,
        memberId: member.memberId,
        statusCode,
        ...(statusCode === 'reject' ? { reviewedAt: new Date(), reviewNote: '初始拒绝' } : {}),
      },
      select: { id: true },
    });
    return registration.id;
  }

  async function createPublishedManagedActivity(
    ownerAuth: string,
  ): Promise<{ activityId: string }> {
    const created = await request(httpServer(app))
      .post('/api/app/v1/my/managed-activities')
      .set('Authorization', ownerAuth)
      .send({
        title: 'Managed registration activity',
        activityTypeCode,
        organizationId,
        startAt: '2099-11-01T01:00:00.000Z',
        endAt: '2099-11-01T05:00:00.000Z',
        registrationDeadline: '2099-10-31T12:00:00.000Z',
        location: '深圳',
        capacity: 50,
      });
    expect(created.status).toBe(201);
    const activityId = created.body.data.activity.id as string;
    await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/direct-publish`)
      .set('Authorization', ownerAuth)
      .expect(200);
    return { activityId };
  }

  it('reuses single and bulk workflows while enforcing responsibility scope over global role grants', async () => {
    const owner = await createMember('owner', true);
    const registrationCollaborator = await createMember('registration-collaborator');
    const attendanceCollaborator = await createMember('attendance-collaborator');
    const unrelatedGlobalAdmin = await createMember('unrelated-global-admin', true);
    const { activityId } = await createPublishedManagedActivity(owner.auth);

    const registrationAssignment = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/collaborators`)
      .set('Authorization', owner.auth)
      .send({
        memberId: registrationCollaborator.memberId,
        canManageRegistrations: true,
        canManageAttendance: false,
        reason: '负责报名',
      });
    expect(registrationAssignment.status).toBe(201);
    const registrationAssignmentId = registrationAssignment.body.data.id as string;
    await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/collaborators`)
      .set('Authorization', owner.auth)
      .send({
        memberId: attendanceCollaborator.memberId,
        canManageRegistrations: false,
        canManageAttendance: true,
        reason: '只负责考勤',
      })
      .expect(201);

    const approveId = await createRegistration(activityId, 'approve');
    const rejectId = await createRegistration(activityId, 'reject');
    const cancelId = await createRegistration(activityId, 'cancel');
    const bulkApproveIds = await Promise.all([
      createRegistration(activityId, 'bulk-approve-a'),
      createRegistration(activityId, 'bulk-approve-b'),
    ]);
    const bulkRejectIds = await Promise.all([
      createRegistration(activityId, 'bulk-reject-a'),
      createRegistration(activityId, 'bulk-reject-b'),
    ]);

    const list = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${activityId}/registrations?page=1&pageSize=20`)
      .set('Authorization', registrationCollaborator.auth);
    expect(list.status).toBe(200);
    expect(list.body.data.total).toBe(7);
    expect(list.body.data.items[0]).toEqual(
      expect.objectContaining({
        registrationId: expect.any(String),
        activityId,
        member: expect.objectContaining({ id: expect.any(String) }),
      }),
    );
    expect(list.body.data.items[0]).not.toHaveProperty('reviewedBy');
    expect(list.body.data.items[0]).not.toHaveProperty('cancelledByUserId');

    const approved = await request(httpServer(app))
      .patch(`/api/app/v1/my/managed-activities/${activityId}/registrations/${approveId}/approve`)
      .set('Authorization', registrationCollaborator.auth)
      .send({ reviewNote: '协办通过' });
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({
      registrationId: approveId,
      statusCode: 'pass',
      reviewNote: '协办通过',
    });
    expect(approved.body.data).not.toHaveProperty('reviewedBy');

    const rejected = await request(httpServer(app))
      .patch(`/api/app/v1/my/managed-activities/${activityId}/registrations/${rejectId}/reject`)
      .set('Authorization', registrationCollaborator.auth)
      .send({ reviewNote: '资料不完整' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.statusCode).toBe('reject');
    const reopened = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/registrations/${rejectId}/reopen`)
      .set('Authorization', registrationCollaborator.auth);
    expect(reopened.status).toBe(200);
    expect(reopened.body.data).toMatchObject({
      registrationId: rejectId,
      statusCode: 'pending',
      reviewNote: null,
    });

    const cancelled = await request(httpServer(app))
      .patch(`/api/app/v1/my/managed-activities/${activityId}/registrations/${cancelId}/cancel`)
      .set('Authorization', owner.auth)
      .send({ cancelReason: '活动安排调整' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data).toMatchObject({
      registrationId: cancelId,
      statusCode: 'cancelled',
      cancelReason: '活动安排调整',
    });

    const bulkApproved = await request(httpServer(app))
      .patch(`/api/app/v1/my/managed-activities/${activityId}/registrations/bulk-approve`)
      .set('Authorization', registrationCollaborator.auth)
      .send({ ids: bulkApproveIds, reviewNote: '批量通过' });
    expect(bulkApproved.status).toBe(200);
    expect(bulkApproved.body.data).toEqual({ succeeded: bulkApproveIds, failed: [] });

    const bulkRejected = await request(httpServer(app))
      .patch(`/api/app/v1/my/managed-activities/${activityId}/registrations/bulk-reject`)
      .set('Authorization', registrationCollaborator.auth)
      .send({ ids: bulkRejectIds, reviewNote: '批量拒绝' });
    expect(bulkRejected.status).toBe(200);
    expect(bulkRejected.body.data).toEqual({ succeeded: bulkRejectIds, failed: [] });

    expectBizError(
      await request(httpServer(app))
        .get(`/api/app/v1/my/managed-activities/${activityId}/registrations`)
        .set('Authorization', attendanceCollaborator.auth),
      BizCode.RBAC_FORBIDDEN,
    );
    expectBizError(
      await request(httpServer(app))
        .get(`/api/app/v1/my/managed-activities/${activityId}/registrations`)
        .set('Authorization', unrelatedGlobalAdmin.auth),
      BizCode.RBAC_FORBIDDEN,
    );

    await request(httpServer(app))
      .delete(
        `/api/app/v1/my/managed-activities/${activityId}/collaborators/${registrationAssignmentId}`,
      )
      .set('Authorization', owner.auth)
      .expect(200);
    expectBizError(
      await request(httpServer(app))
        .get(`/api/app/v1/my/managed-activities/${activityId}/registrations`)
        .set('Authorization', registrationCollaborator.auth),
      BizCode.RBAC_FORBIDDEN,
    );
    await expect(
      prisma.roleBinding.count({
        where: {
          principalId: registrationCollaborator.memberId,
          scopeActivityId: activityId,
          status: 'ACTIVE',
          deletedAt: null,
        },
      }),
    ).resolves.toBe(0);
  });
});
