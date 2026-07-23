import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

describe('App managed activities core', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let organizationId: string;
  let activityTypeCode: string;
  let attendanceRoleCode: string;
  let reviewerAuth: string;
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
    const reviewer = await createTestUser(app, {
      username: 'managed-activities-reviewer',
      role: Role.SUPER_ADMIN,
    });
    reviewerAuth = (await loginAs(app, reviewer.username)).authHeader;

    const root = await prisma.organization.create({
      data: { name: 'Managed Activities Root', nodeTypeCode: 'managed-activities-root' },
      select: { id: true },
    });
    const organization = await prisma.organization.create({
      data: {
        name: 'Managed Activities Team',
        nodeTypeCode: 'managed-activities-team',
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
    activityTypeCode = 'managed-training';
    await prisma.dictItem.create({
      data: { typeId: activityType.id, code: activityTypeCode, label: '管理活动训练' },
    });
    const attendanceRole = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    attendanceRoleCode = 'managed-member';
    await prisma.dictItem.create({
      data: { typeId: attendanceRole.id, code: attendanceRoleCode, label: '活动成员' },
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
    gradeCode = 'level-3',
    grantPublish = false,
  ): Promise<{ memberId: string; userId: string; auth: string }> {
    sequence += 1;
    const member = await prisma.member.create({
      data: {
        memberNo: `managed-${label}-${sequence}`,
        displayName: `Managed ${label} ${sequence}`,
        gradeCode,
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    const user = await createTestUser(app, {
      username: `managed-${label}-${sequence}`,
      role: Role.USER,
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    await prisma.memberOrganizationMembership.create({
      data: { memberId: member.id, organizationId },
    });
    if (grantPublish) {
      await grantBizAdminToUser(app, user.id, bizAdminRoleId);
    }
    return {
      memberId: member.id,
      userId: user.id,
      auth: (await loginAs(app, user.username)).authHeader,
    };
  }

  function createPayload(title: string) {
    return {
      title,
      activityTypeCode,
      organizationId,
      startAt: '2099-10-01T01:00:00.000Z',
      endAt: '2099-10-01T05:00:00.000Z',
      registrationDeadline: '2099-09-30T12:00:00.000Z',
      location: '深圳',
      capacity: 20,
    };
  }

  it('keeps /my/activities separate and supports draft CRUD, positions and initial review withdrawal', async () => {
    const manager = await createMember('draft-manager');
    const options = await request(httpServer(app))
      .get('/api/app/v1/my/managed-activities/organization-options')
      .set('Authorization', manager.auth);
    expect(options.status).toBe(200);
    expect(options.body.data).toEqual([
      expect.objectContaining({
        organizationId,
        pathLabel: 'Managed Activities Root / Managed Activities Team',
        source: 'membership',
      }),
    ]);
    const capabilities = await request(httpServer(app))
      .get('/api/app/v1/me/capabilities')
      .set('Authorization', manager.auth);
    expect(capabilities.body.data.activities.canInitiateActivity).toBe(true);
    expect(capabilities.body.data.managed.canViewManagedActivities).toBe(true);

    const created = await request(httpServer(app))
      .post('/api/app/v1/my/managed-activities')
      .set('Authorization', manager.auth)
      .send(createPayload('Managed draft'));
    expect(created.status).toBe(201);
    const activityId = created.body.data.activity.id as string;
    expect(created.body.data.activity.statusCode).toBe('draft');

    const updated = await request(httpServer(app))
      .patch(`/api/app/v1/my/managed-activities/${activityId}`)
      .set('Authorization', manager.auth)
      .send({ title: 'Managed draft updated' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.activity.title).toBe('Managed draft updated');

    const position = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/positions`)
      .set('Authorization', manager.auth)
      .send({ name: '后勤', attendanceRoleCode, capacity: 10 });
    expect(position.status).toBe(201);
    expect(position.body.data.activityId).toBe(activityId);

    const managedList = await request(httpServer(app))
      .get('/api/app/v1/my/managed-activities')
      .set('Authorization', manager.auth);
    expect(managedList.status).toBe(200);
    expect(managedList.body.data.items).toEqual([
      expect.objectContaining({ activityId, relationship: 'initiator' }),
    ]);
    const participationList = await request(httpServer(app))
      .get('/api/app/v1/my/activities')
      .set('Authorization', manager.auth);
    expect(participationList.status).toBe(200);
    expect(participationList.body.data.items).toEqual([]);

    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/submit-publish-review`)
      .set('Authorization', manager.auth);
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.status).toBe('pending');
    const withdrawn = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/withdraw-publish-review`)
      .set('Authorization', manager.auth);
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.data.status).toBe('withdrawn');
  });

  it('direct publishes, projects owner, manages collaborators and transfers ownership', async () => {
    const owner = await createMember('owner', 'level-4', true);
    const collaborator = await createMember('collaborator');
    const newOwner = await createMember('new-owner');
    const created = await request(httpServer(app))
      .post('/api/app/v1/my/managed-activities')
      .set('Authorization', owner.auth)
      .send(createPayload('Managed direct publish'));
    const activityId = created.body.data.activity.id as string;
    const published = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/direct-publish`)
      .set('Authorization', owner.auth);
    expect(published.status).toBe(200);
    expect(published.body.data.activity.statusCode).toBe('published');
    expect(published.body.data.owner.id).toBe(owner.memberId);

    const added = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/collaborators`)
      .set('Authorization', owner.auth)
      .send({
        memberId: collaborator.memberId,
        canManageRegistrations: true,
        canManageAttendance: false,
        reason: '负责报名',
      });
    expect(added.status).toBe(201);
    const collaboratorList = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${activityId}/responsibilities`)
      .set('Authorization', collaborator.auth);
    expect(collaboratorList.status).toBe(200);
    expect(collaboratorList.body.data.collaborators).toEqual([
      expect.objectContaining({ memberId: collaborator.memberId }),
    ]);

    const transferred = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/transfer-owner`)
      .set('Authorization', owner.auth)
      .send({
        newOwnerMemberId: newOwner.memberId,
        reason: '交接',
        retainPreviousOwnerAsCollaborator: true,
      });
    expect(transferred.status).toBe(200);
    expect(transferred.body.data.owner.memberId).toBe(newOwner.memberId);

    const formerOwnerWrite = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/collaborators`)
      .set('Authorization', owner.auth)
      .send({
        memberId: collaborator.memberId,
        canManageRegistrations: true,
        canManageAttendance: true,
        reason: '原负责人不能凭全局覆盖权限写 App 负责人接口',
      });
    expectBizError(formerOwnerWrite, BizCode.RBAC_FORBIDDEN);
  });

  it('submits a complete published change proposal and applies Activity plus positions on approval', async () => {
    const owner = await createMember('change-owner', 'level-5', true);
    const created = await request(httpServer(app))
      .post('/api/app/v1/my/managed-activities')
      .set('Authorization', owner.auth)
      .send(createPayload('Before change'));
    const activityId = created.body.data.activity.id as string;
    const position = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/positions`)
      .set('Authorization', owner.auth)
      .send({ name: '原岗位', attendanceRoleCode, capacity: 5, sortOrder: 1 });
    const activityPositionId = position.body.data.activityPositionId as string;
    await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/direct-publish`)
      .set('Authorization', owner.auth)
      .expect(200);

    const directPatch = await request(httpServer(app))
      .patch(`/api/app/v1/my/managed-activities/${activityId}`)
      .set('Authorization', owner.auth)
      .send({ title: 'Must not apply directly' });
    expectBizError(directPatch, BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED);

    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/submit-change-review`)
      .set('Authorization', owner.auth)
      .send({
        activity: { title: 'After approved change', location: '广州' },
        positions: [
          {
            activityPositionId,
            name: '原岗位升级',
            attendanceRoleCode,
            capacity: 8,
            sortOrder: 1,
          },
          {
            clientRef: 'new-position-1',
            name: '新增岗位',
            attendanceRoleCode,
            capacity: 4,
            sortOrder: 2,
          },
        ],
      });
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.requestType).toBe('change');
    const reviewId = submitted.body.data.id as string;

    const approved = await request(httpServer(app))
      .post(`/api/admin/v1/activity-publish-reviews/${reviewId}/approve`)
      .set('Authorization', reviewerAuth)
      .send({ requiresInsuranceConfirmed: true, reviewNote: '同意变更' });
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('approved');
    const stored = await prisma.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: {
        title: true,
        location: true,
        workflowRevision: true,
        activityPositions: {
          where: { deletedAt: null },
          orderBy: { sortOrder: 'asc' },
          select: { name: true, capacity: true },
        },
      },
    });
    expect(stored).toEqual({
      title: 'After approved change',
      location: '广州',
      workflowRevision: 2,
      activityPositions: [
        { name: '原岗位升级', capacity: 8 },
        { name: '新增岗位', capacity: 4 },
      ],
    });
  });

  it('rejects non-formal members before exposing initiation options', async () => {
    const nonFormal = await createMember('non-formal', 'observer');
    const response = await request(httpServer(app))
      .get('/api/app/v1/my/managed-activities/organization-options')
      .set('Authorization', nonFormal.auth);
    expectBizError(response, BizCode.ACTIVITY_INITIATOR_NOT_FORMAL);
  });
});
