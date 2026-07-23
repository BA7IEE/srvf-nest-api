import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, BindingStatus, MemberStatus, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
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

  it('claims legacy owner, projects collaborator capabilities, transfers and revokes immediately', async () => {
    const owner = await createFormalMember('owner');
    const collaborator = await createFormalMember('collaborator');
    const newOwner = await createFormalMember('new-owner');
    const activity = await createLegacyActivity();

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

  it('member offboard revokes active responsibility rows and their system bindings together', async () => {
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
    expect(offboard.status).toBe(200);
    await expect(
      prisma.activityResponsibilityAssignment.findUniqueOrThrow({
        where: { id: claim.body.data.id as string },
        select: { status: true, endedAt: true, endedByUserId: true },
      }),
    ).resolves.toMatchObject({
      status: 'revoked',
      endedAt: expect.any(Date),
      endedByUserId: expect.any(String),
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
    ).toBe(0);
  });
});
