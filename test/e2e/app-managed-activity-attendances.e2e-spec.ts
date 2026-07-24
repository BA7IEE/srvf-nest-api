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

describe('App managed activity attendances', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let organizationId: string;
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

    const nodeType = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeType.id, code: 'managed-attendance-team', label: '考勤团队' },
    });
    const rootId = (
      await prisma.organization.create({
        data: { name: 'Managed Attendance Root', nodeTypeCode: 'managed-attendance-team' },
        select: { id: true },
      })
    ).id;
    organizationId = (
      await prisma.organization.create({
        data: {
          name: 'Managed Attendance Team',
          nodeTypeCode: 'managed-attendance-team',
          parentId: rootId,
        },
        select: { id: true },
      })
    ).id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: rootId, descendantId: rootId, depth: 0 },
        { ancestorId: rootId, descendantId: organizationId, depth: 1 },
        { ancestorId: organizationId, descendantId: organizationId, depth: 0 },
      ],
    });
    for (const [typeCode, code, label] of [
      ['activity_type', 'managed-attendance-training', '考勤训练'],
      ['attendance_role', 'member', '队员'],
      ['attendance_status', 'present', '出席'],
    ] as const) {
      const type = await prisma.dictType.create({
        data: { code: typeCode, label: typeCode },
        select: { id: true },
      });
      await prisma.dictItem.create({ data: { typeId: type.id, code, label } });
    }
  });

  afterAll(async () => {
    await app.close();
    if (previousGate === undefined) delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousGate;
  });

  async function memberUser(label: string, globalAdmin = false) {
    const n = ++sequence;
    const member = await prisma.member.create({
      data: {
        memberNo: `managed-att-${label}-${n}`,
        displayName: `Managed Attendance ${label} ${n}`,
        gradeCode: 'level-3',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    const user = await createTestUser(app, { username: `mat-${n}`, role: Role.USER });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    await prisma.memberOrganizationMembership.create({
      data: { memberId: member.id, organizationId },
    });
    if (globalAdmin) await grantBizAdminToUser(app, user.id, bizAdminRoleId);
    return {
      memberId: member.id,
      userId: user.id,
      auth: (await loginAs(app, user.username)).authHeader,
    };
  }

  it('exposes all 8 routes only to active attendance responsibility and revokes immediately', async () => {
    const owner = await memberUser('owner', true);
    const attendanceCollaborator = await memberUser('attendance');
    const registrationCollaborator = await memberUser('registration');
    const globalAdmin = await memberUser('global-admin', true);
    const participant = await memberUser('participant');

    const created = await request(httpServer(app))
      .post('/api/app/v1/my/managed-activities')
      .set('Authorization', owner.auth)
      .send({
        title: 'Managed attendance activity',
        activityTypeCode: 'managed-attendance-training',
        organizationId,
        startAt: '2099-11-01T01:00:00.000Z',
        endAt: '2099-11-01T05:00:00.000Z',
        registrationDeadline: '2099-10-31T12:00:00.000Z',
        location: '深圳',
        capacity: 50,
      });
    if (created.status !== 201) throw new Error(JSON.stringify(created.body));
    const activityId = created.body.data.activity.id as string;
    await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/direct-publish`)
      .set('Authorization', owner.auth)
      .expect(200);
    await prisma.activity.update({
      where: { id: activityId },
      data: {
        startAt: new Date('2026-07-20T01:00:00.000Z'),
        endAt: new Date('2026-07-20T05:00:00.000Z'),
        registrationDeadline: new Date('2026-07-19T12:00:00.000Z'),
      },
    });

    const attendanceAssignment = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/collaborators`)
      .set('Authorization', owner.auth)
      .send({
        memberId: attendanceCollaborator.memberId,
        canManageRegistrations: false,
        canManageAttendance: true,
        reason: '负责考勤',
      })
      .expect(201);
    const attendanceAssignmentId = attendanceAssignment.body.data.id as string;
    await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/collaborators`)
      .set('Authorization', owner.auth)
      .send({
        memberId: registrationCollaborator.memberId,
        canManageRegistrations: true,
        canManageAttendance: false,
        reason: '只负责报名',
      })
      .expect(201);

    const registration = await prisma.activityRegistration.create({
      data: {
        activityId,
        memberId: participant.memberId,
        statusCode: 'pass',
        reviewedBy: owner.userId,
        reviewedAt: new Date(),
      },
      select: { id: true },
    });
    await prisma.activityCheckIn.create({
      data: {
        activityId,
        memberId: participant.memberId,
        registrationId: registration.id,
        checkInAt: new Date('2026-07-20T01:00:00.000Z'),
        checkOutAt: new Date('2026-07-20T03:00:00.000Z'),
        geoVerified: true,
        outOfRange: false,
        checkInDistance: 12,
        checkOutDistance: 15,
      },
    });

    const checkIns = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${activityId}/check-ins`)
      .set('Authorization', attendanceCollaborator.auth)
      .expect(200);
    expect(checkIns.body.data.items).toHaveLength(1);
    expect(checkIns.body.data.items[0]).not.toHaveProperty('checkInLongitude');

    const draft = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${activityId}/attendance-sheet-draft`)
      .set('Authorization', owner.auth)
      .expect(200);
    expect(draft.body.data.records).toHaveLength(1);

    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/attendance-sheets`)
      .set('Authorization', attendanceCollaborator.auth)
      .send({ records: draft.body.data.records });
    if (submitted.status !== 201) throw new Error(JSON.stringify(submitted.body));
    const sheetId = submitted.body.data.id as string;
    expect(submitted.body.data).toMatchObject({
      activityId,
      statusCode: 'pending',
      lastSubmittedByUserId: attendanceCollaborator.userId,
    });

    const list = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${activityId}/attendance-sheets`)
      .set('Authorization', owner.auth)
      .expect(200);
    expect(list.body.data.total).toBe(1);

    const detail = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${activityId}/attendance-sheets/${sheetId}`)
      .set('Authorization', owner.auth)
      .expect(200);
    expect(detail.body.data.records).toHaveLength(1);
    expect(detail.body.data).not.toHaveProperty('activity');

    const edited = await request(httpServer(app))
      .patch(`/api/app/v1/my/managed-activities/${activityId}/attendance-sheets/${sheetId}`)
      .set('Authorization', owner.auth)
      .send({})
      .expect(200);
    expect(edited.body.data.version).toBe(2);

    await prisma.attendanceSheet.update({
      where: { id: sheetId },
      data: {
        statusCode: 'returned',
        returnedByUserId: globalAdmin.userId,
        returnedAt: new Date(),
        returnNote: '补充说明',
        returnedFromStageCode: 'first',
      },
    });
    const resubmitted = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/attendance-sheets/${sheetId}/resubmit`)
      .set('Authorization', owner.auth)
      .send({})
      .expect(200);
    expect(resubmitted.body.data).toMatchObject({
      statusCode: 'pending',
      version: 3,
      lastSubmittedByUserId: owner.userId,
      returnedByUserId: null,
      returnNote: null,
    });

    const secondSheet = await prisma.attendanceSheet.create({
      data: {
        activityId,
        submitterUserId: owner.userId,
        lastSubmittedByUserId: owner.userId,
        statusCode: 'pending',
      },
      select: { id: true },
    });
    await request(httpServer(app))
      .delete(`/api/app/v1/my/managed-activities/${activityId}/attendance-sheets/${secondSheet.id}`)
      .set('Authorization', owner.auth)
      .expect(200);

    for (const auth of [registrationCollaborator.auth, globalAdmin.auth]) {
      expectBizError(
        await request(httpServer(app))
          .get(`/api/app/v1/my/managed-activities/${activityId}/attendance-sheets`)
          .set('Authorization', auth),
        BizCode.RBAC_FORBIDDEN,
      );
    }

    await request(httpServer(app))
      .delete(
        `/api/app/v1/my/managed-activities/${activityId}/collaborators/${attendanceAssignmentId}`,
      )
      .set('Authorization', owner.auth)
      .expect(200);
    expectBizError(
      await request(httpServer(app))
        .get(`/api/app/v1/my/managed-activities/${activityId}/attendance-sheets`)
        .set('Authorization', attendanceCollaborator.auth),
      BizCode.RBAC_FORBIDDEN,
    );
  }, 60_000);
});
