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
import { memberIdentityData } from '../helpers/member-identity.fixture';

describe('Activity batch4 invitation and visitor runtime', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let organizationId: string;
  let activityTypeCode: string;
  let activityOwnerRoleId: string;
  let sequence = 0;

  const FUTURE_START = new Date('2099-10-01T02:00:00.000Z');
  const FUTURE_END = new Date('2099-10-01T05:00:00.000Z');

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    activityOwnerRoleId = (await seedActivityResponsibilitySystemRoles(app))['activity-owner'];

    const root = await prisma.organization.create({
      data: { name: 'Invitation Visitor Root', nodeTypeCode: 'invitation-visitor-root' },
      select: { id: true },
    });
    const organization = await prisma.organization.create({
      data: {
        name: 'Invitation Visitor Team',
        nodeTypeCode: 'invitation-visitor-team',
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
    activityTypeCode = 'invitation-visitor-training';
    await prisma.dictItem.create({
      data: { typeId: activityType.id, code: activityTypeCode, label: '邀请访客训练' },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  async function createMember(
    label: string,
  ): Promise<{ memberId: string; userId: string; auth: string }> {
    sequence += 1;
    const member = await prisma.member.create({
      data: {
        memberNo: `invitation-visitor-${label}-${sequence}`,
        ...memberIdentityData(`Invitation Visitor ${label} ${sequence}`),
        gradeCode: 'level-3',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    const user = await createTestUser(app, {
      username: `inv-v-${label.slice(0, 12)}-${sequence}`,
      role: Role.USER,
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    await prisma.memberOrganizationMembership.create({
      data: { memberId: member.id, organizationId },
    });
    return {
      memberId: member.id,
      userId: user.id,
      auth: (await loginAs(app, user.username)).authHeader,
    };
  }

  async function createPublishedActivity(visibilityCode: 'internal' | 'invitation' = 'internal') {
    sequence += 1;
    return await prisma.activity.create({
      data: {
        title: `Invitation visitor ${sequence}`,
        activityTypeCode,
        organizationId,
        startAt: FUTURE_START,
        endAt: FUTURE_END,
        location: '深圳',
        statusCode: 'published',
        publishedAt: new Date('2020-01-01T00:00:00.000Z'),
        registrationModeCode: 'invitation_only',
        visibilityCode,
      },
      select: { id: true },
    });
  }

  async function createSession(activityId: string) {
    sequence += 1;
    return await prisma.activitySession.create({
      data: {
        activityId,
        code: `invitation-session-${sequence}`,
        name: `邀请场次 ${sequence}`,
        startAt: FUTURE_START,
        endAt: FUTURE_END,
        locationText: '深圳集合点',
        checkInOpenAt: new Date(FUTURE_START.getTime() - 30 * 60_000),
        checkInCloseAt: new Date(FUTURE_START.getTime() + 30 * 60_000),
        checkOutOpenAt: new Date(FUTURE_END.getTime() - 60 * 60_000),
        checkOutCloseAt: new Date(FUTURE_END.getTime() + 30 * 60_000),
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });
  }

  async function grantManagedRegistrationAccess(
    activityId: string,
    actor: Awaited<ReturnType<typeof createMember>>,
  ): Promise<void> {
    const assignment = await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId,
        memberId: actor.memberId,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: actor.userId,
        source: 'publish',
      },
      select: { id: true },
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.MEMBER,
        principalId: actor.memberId,
        roleId: activityOwnerRoleId,
        scopeType: BindingScopeType.ACTIVITY,
        scopeActivityId: activityId,
        status: BindingStatus.ACTIVE,
        note: `system:activity-responsibility:${assignment.id}`,
      },
    });
  }

  async function grantGlobalRegistrationAccess(
    actor: Awaited<ReturnType<typeof createMember>>,
  ): Promise<void> {
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.MEMBER,
        principalId: actor.memberId,
        roleId: activityOwnerRoleId,
        scopeType: BindingScopeType.GLOBAL,
        status: BindingStatus.ACTIVE,
        note: 'P1-28 global permission must not bypass activity responsibility',
      },
    });
  }

  async function grantNonRegistrationResponsibility(
    activityId: string,
    actor: Awaited<ReturnType<typeof createMember>>,
  ): Promise<void> {
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId,
        memberId: actor.memberId,
        responsibilityType: 'collaborator',
        canManageRegistrations: false,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: actor.userId,
        source: 'publish',
      },
    });
  }

  async function createSessionPosition(activityId: string, sessionId: string) {
    sequence += 1;
    return await prisma.activitySessionPosition.create({
      data: {
        activityId,
        sessionId,
        code: `invitation-position-${sequence}`,
        name: `邀请岗位 ${sequence}`,
        attendanceRoleCode: 'invitation-visitor-role',
        capacity: 10,
        locationRequired: false,
        sortOrder: sequence,
      },
      select: { id: true },
    });
  }

  async function externalParticipantSnapshot() {
    return {
      registrations: await prisma.activityRegistration.count(),
      identities: await prisma.activityParticipationIdentity.count(),
      revisions: await prisma.activityParticipationRevision.count(),
      reservations: await prisma.capacityReservation.count(),
      attendanceRecords: await prisma.attendanceRecord.count(),
      serviceSegmentRevisions: await prisma.participantServiceSegmentRevision.count(),
      settlementRuns: await prisma.attendanceSettlementRun.count(),
      settlementVersions: await prisma.attendanceSettlementVersion.count(),
      settlementResults: await prisma.participantSettlementResultRevision.count(),
      ledgerEntries: await prisma.participationLedgerEntry.count(),
      contributionDays: await prisma.memberContributionDayState.count(),
      batchJobs: await prisma.activityBatchJob.count(),
    };
  }

  it('red-first: the managed invitation create route is a real HTTP runtime surface', async () => {
    const manager = await createMember('red-manager');
    const invitee = await createMember('red-invitee');
    const activity = await createPublishedActivity();
    const session = await createSession(activity.id);
    await grantManagedRegistrationAccess(activity.id, manager);

    const response = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activity.id}/invitations`)
      .set('Authorization', manager.auth)
      .send({
        memberId: invitee.memberId,
        sessionId: session.id,
        expiresAt: '2099-10-02T00:00:00.000Z',
      });

    // 修复前预期为 HTTP 404：schema 已有，管理 runtime 尚不存在。
    expect(response.status).toBe(201);
  });

  it('red-first: an expired pending invitation never grants member activity detail visibility', async () => {
    const viewer = await createMember('red-expired-viewer');
    const activity = await createPublishedActivity('invitation');
    await prisma.activityInvitation.create({
      data: {
        activityId: activity.id,
        memberId: viewer.memberId,
        statusCode: 'pending',
        expiresAt: new Date('2020-01-01T00:00:00.000Z'),
      },
    });

    const response = await request(httpServer(app))
      .get(`/api/app/v1/activities/${activity.id}`)
      .set('Authorization', viewer.auth);

    // 修复前错误返回 200：现有 where 仅检查 pending|accepted，遗漏 expiresAt。
    expect(response.status).toBe(404);
  });

  it('red-first: an invited member has a real HTTP decline action', async () => {
    const invitee = await createMember('red-decline-invitee');
    const activity = await createPublishedActivity('invitation');
    const invitation = await prisma.activityInvitation.create({
      data: {
        activityId: activity.id,
        memberId: invitee.memberId,
        statusCode: 'pending',
        expiresAt: new Date('2099-10-02T00:00:00.000Z'),
      },
      select: { id: true },
    });

    const response = await request(httpServer(app))
      .post(`/api/app/v1/my/activity-invitations/${invitation.id}/decline`)
      .set('Authorization', invitee.auth)
      .send({ operationKey: 'red-first-decline', reason: '无法参加' });

    // 修复前预期为 HTTP 404：本人 decline runtime 尚不存在。
    expect(response.status).toBe(200);
  });

  it('requires both the existing activity-registration permission and live responsibility, then lists only the managed activity invitations', async () => {
    const manager = await createMember('managed-list-manager');
    const globalOnly = await createMember('managed-list-global-only');
    const invitee = await createMember('managed-list-invitee');
    const activity = await createPublishedActivity();
    await grantManagedRegistrationAccess(activity.id, manager);
    await grantGlobalRegistrationAccess(globalOnly);
    await grantNonRegistrationResponsibility(activity.id, globalOnly);
    const invitation = await prisma.activityInvitation.create({
      data: {
        activityId: activity.id,
        memberId: invitee.memberId,
        statusCode: 'pending',
        expiresAt: new Date('2099-10-02T00:00:00.000Z'),
      },
      select: { id: true },
    });

    const list = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${activity.id}/invitations?page=1&pageSize=10`)
      .set('Authorization', manager.auth);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual(
      expect.objectContaining({
        total: 1,
        page: 1,
        pageSize: 10,
        items: [
          expect.objectContaining({
            invitationId: invitation.id,
            activityId: activity.id,
            memberId: invitee.memberId,
            scope: 'activity',
            status: 'pending',
          }),
        ],
      }),
    );

    expectBizError(
      await request(httpServer(app))
        .get(`/api/app/v1/my/managed-activities/${activity.id}/invitations?page=1&pageSize=10`)
        .set('Authorization', globalOnly.auth),
      BizCode.RBAC_FORBIDDEN,
    );
  });

  it('expires an old pending row under the scope lock before re-inviting and rejects a still-live duplicate', async () => {
    const manager = await createMember('reinvite-manager');
    const invitee = await createMember('reinvite-invitee');
    const activity = await createPublishedActivity();
    const session = await createSession(activity.id);
    const position = await createSessionPosition(activity.id, session.id);
    await grantManagedRegistrationAccess(activity.id, manager);
    const old = await prisma.activityInvitation.create({
      data: {
        activityId: activity.id,
        memberId: invitee.memberId,
        sessionId: session.id,
        positionId: position.id,
        statusCode: 'pending',
        expiresAt: new Date('2020-01-01T00:00:00.000Z'),
      },
      select: { id: true },
    });

    const create = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activity.id}/invitations`)
      .set('Authorization', manager.auth)
      .send({
        memberId: invitee.memberId,
        sessionId: session.id,
        positionId: position.id,
        expiresAt: '2099-10-02T00:00:00.000Z',
      });
    expect(create.status).toBe(201);
    expect(create.body.data).toMatchObject({
      activityId: activity.id,
      memberId: invitee.memberId,
      sessionId: session.id,
      positionId: position.id,
      scope: 'position',
      status: 'pending',
    });
    const createdId = create.body.data.invitationId as string;
    await expect(
      prisma.activityInvitation.findUniqueOrThrow({
        where: { id: old.id },
        select: { statusCode: true },
      }),
    ).resolves.toEqual({ statusCode: 'expired' });
    const oldAudit = await prisma.auditLog.findFirst({
      where: { event: 'invitation.change', resourceId: old.id },
      select: { context: true },
    });
    expect(JSON.stringify(oldAudit?.context)).toContain('"operation":"expire"');

    expectBizError(
      await request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${activity.id}/invitations`)
        .set('Authorization', manager.auth)
        .send({
          memberId: invitee.memberId,
          sessionId: session.id,
          positionId: position.id,
          expiresAt: '2099-10-03T00:00:00.000Z',
        }),
      BizCode.ACTIVITY_INVITATION_ALREADY_PENDING,
    );
    expect(
      await prisma.activityInvitation.count({ where: { id: createdId, statusCode: 'pending' } }),
    ).toBe(1);
  });

  it('projects an expired pending invitation as expired in a single list read without mutating it', async () => {
    const manager = await createMember('projection-manager');
    const invitee = await createMember('projection-invitee');
    const activity = await createPublishedActivity();
    await grantManagedRegistrationAccess(activity.id, manager);
    const invitation = await prisma.activityInvitation.create({
      data: {
        activityId: activity.id,
        memberId: invitee.memberId,
        statusCode: 'pending',
        expiresAt: new Date('2020-01-01T00:00:00.000Z'),
      },
      select: { id: true },
    });

    const list = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${activity.id}/invitations?page=1&pageSize=10`)
      .set('Authorization', manager.auth);
    expect(list.status).toBe(200);
    expect(list.body.data.items).toContainEqual(
      expect.objectContaining({ invitationId: invitation.id, status: 'expired' }),
    );
    await expect(
      prisma.activityInvitation.findUniqueOrThrow({
        where: { id: invitation.id },
        select: { statusCode: true },
      }),
    ).resolves.toEqual({ statusCode: 'pending' });
  });

  it('rejects invalid expiry, inactive targets, and cross-activity scope anchors without exposing the foreign resource', async () => {
    const manager = await createMember('scope-manager');
    const invitee = await createMember('scope-invitee');
    const inactive = await createMember('scope-inactive');
    const activity = await createPublishedActivity();
    const foreignActivity = await createPublishedActivity();
    const foreignSession = await createSession(foreignActivity.id);
    await grantManagedRegistrationAccess(activity.id, manager);
    await prisma.member.update({
      where: { id: inactive.memberId },
      data: { status: MemberStatus.INACTIVE },
    });

    const endpoint = `/api/app/v1/my/managed-activities/${activity.id}/invitations`;
    expectBizError(
      await request(httpServer(app))
        .post(endpoint)
        .set('Authorization', manager.auth)
        .send({ memberId: invitee.memberId, expiresAt: '2020-01-01T00:00:00.000Z' }),
      BizCode.BAD_REQUEST,
    );
    expectBizError(
      await request(httpServer(app))
        .post(endpoint)
        .set('Authorization', manager.auth)
        .send({ memberId: inactive.memberId, expiresAt: '2099-10-02T00:00:00.000Z' }),
      BizCode.MEMBER_INACTIVE,
    );
    expectBizError(
      await request(httpServer(app)).post(endpoint).set('Authorization', manager.auth).send({
        memberId: invitee.memberId,
        sessionId: foreignSession.id,
        expiresAt: '2099-10-02T00:00:00.000Z',
      }),
      BizCode.ACTIVITY_INVITATION_NOT_FOUND,
    );
    expectBizError(
      await request(httpServer(app)).post(endpoint).set('Authorization', manager.auth).send({
        memberId: invitee.memberId,
        positionId: 'foreign-position-without-session',
        expiresAt: '2099-10-02T00:00:00.000Z',
      }),
      BizCode.BAD_REQUEST,
    );
  });

  it('allows revoking only an unexpired pending invitation and leaves the free-text reason out of audit', async () => {
    const manager = await createMember('revoke-manager');
    const invitee = await createMember('revoke-invitee');
    const activity = await createPublishedActivity();
    await grantManagedRegistrationAccess(activity.id, manager);
    const invitation = await prisma.activityInvitation.create({
      data: {
        activityId: activity.id,
        memberId: invitee.memberId,
        statusCode: 'pending',
        expiresAt: new Date('2099-10-02T00:00:00.000Z'),
      },
      select: { id: true },
    });

    const revoked = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activity.id}/invitations/${invitation.id}/revoke`)
      .set('Authorization', manager.auth)
      .send({ reason: '人员安排变化' });
    expect(revoked.status).toBe(200);
    expect(revoked.body.data).toMatchObject({ invitationId: invitation.id, status: 'revoked' });
    const stored = await prisma.activityInvitation.findUniqueOrThrow({
      where: { id: invitation.id },
      select: { statusCode: true, revokedAt: true, reason: true },
    });
    expect(stored).toEqual(
      expect.objectContaining({
        statusCode: 'revoked',
        revokedAt: expect.any(Date),
        reason: '人员安排变化',
      }),
    );
    const audit = await prisma.auditLog.findFirst({
      where: { event: 'invitation.change', resourceId: invitation.id },
      select: { context: true },
    });
    expect(JSON.stringify(audit?.context)).toContain('"operation":"revoke"');
    expect(JSON.stringify(audit?.context)).not.toContain('人员安排变化');

    expectBizError(
      await request(httpServer(app))
        .post(
          `/api/app/v1/my/managed-activities/${activity.id}/invitations/${invitation.id}/revoke`,
        )
        .set('Authorization', manager.auth)
        .send({ reason: '不得二次撤回' }),
      BizCode.ACTIVITY_INVITATION_STATUS_INVALID,
    );
  });

  it('locks decline to the invitee and makes operation-key replay deterministic without auditing the reason', async () => {
    const invitee = await createMember('decline-invitee');
    const outsider = await createMember('decline-outsider');
    const activity = await createPublishedActivity('invitation');
    const invitation = await prisma.activityInvitation.create({
      data: {
        activityId: activity.id,
        memberId: invitee.memberId,
        statusCode: 'pending',
        expiresAt: new Date('2099-10-02T00:00:00.000Z'),
      },
      select: { id: true },
    });
    const endpoint = `/api/app/v1/my/activity-invitations/${invitation.id}/decline`;

    expectBizError(
      await request(httpServer(app))
        .post(endpoint)
        .set('Authorization', outsider.auth)
        .send({ operationKey: 'decline-outsider', reason: '外人不可操作' }),
      BizCode.ACTIVITY_INVITATION_NOT_FOUND,
    );

    const first = await request(httpServer(app))
      .post(endpoint)
      .set('Authorization', invitee.auth)
      .send({ operationKey: 'decline-replay-key', reason: '与既有安排冲突' });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ invitationId: invitation.id, status: 'declined' });
    const replay = await request(httpServer(app))
      .post(endpoint)
      .set('Authorization', invitee.auth)
      .send({ operationKey: 'decline-replay-key', reason: '与既有安排冲突' });
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);
    expectBizError(
      await request(httpServer(app))
        .post(endpoint)
        .set('Authorization', invitee.auth)
        .send({ operationKey: 'decline-replay-key', reason: '改了理由' }),
      BizCode.ACTIVITY_INVITATION_OPERATION_KEY_CONFLICT,
    );
    const audit = await prisma.auditLog.findFirst({
      where: { event: 'invitation.change', resourceId: invitation.id },
      select: { context: true },
    });
    expect(JSON.stringify(audit?.context)).toContain('"operation":"decline"');
    expect(JSON.stringify(audit?.context)).not.toContain('与既有安排冲突');
  });

  it('creates an external visitor in the visitor list only, keeps attendanceCode null, and rejects an uncontracted attendanceCode input', async () => {
    const manager = await createMember('visitor-manager');
    const referringMember = await createMember('visitor-referrer');
    const activity = await createPublishedActivity();
    const session = await createSession(activity.id);
    await grantManagedRegistrationAccess(activity.id, manager);
    const before = await externalParticipantSnapshot();

    const created = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activity.id}/visitors`)
      .set('Authorization', manager.auth)
      .send({
        sessionId: session.id,
        name: '外部访客姓名',
        organization: '外部协作单位',
        invitedByMemberId: referringMember.memberId,
        note: '仅用于访客名单',
      });
    expect(created.status).toBe(201);
    const visitorId = created.body.data.visitorId as string;
    expect(created.body.data).toMatchObject({
      visitorId,
      activityId: activity.id,
      sessionId: session.id,
      name: '外部访客姓名',
      organization: '外部协作单位',
      invitedByMemberId: referringMember.memberId,
      note: '仅用于访客名单',
    });
    expect(await externalParticipantSnapshot()).toEqual(before);
    await expect(
      prisma.activityVisitor.findUniqueOrThrow({
        where: { id: visitorId },
        select: { attendanceCode: true },
      }),
    ).resolves.toEqual({ attendanceCode: null });
    const audit = await prisma.auditLog.findFirst({
      where: { event: 'visitor.create', resourceId: visitorId },
      select: { context: true },
    });
    const auditJson = JSON.stringify(audit?.context);
    expect(auditJson).toContain('"operation":"create"');
    expect(auditJson).not.toContain('外部访客姓名');
    expect(auditJson).not.toContain('外部协作单位');
    expect(auditJson).not.toContain('仅用于访客名单');

    const list = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${activity.id}/visitors?page=1&pageSize=10`)
      .set('Authorization', manager.auth);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual(
      expect.objectContaining({
        total: 1,
        items: [expect.objectContaining({ visitorId, name: '外部访客姓名' })],
      }),
    );
    expect(list.body.data.items[0]).not.toHaveProperty('attendanceCode');

    const invalid = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activity.id}/visitors`)
      .set('Authorization', manager.auth)
      .send({ sessionId: session.id, name: '不得接收考勤码', attendanceCode: 'forbidden' });
    expectBizError(invalid, BizCode.BAD_REQUEST, { strictMessage: false });
  });

  it('rejects a cross-activity visitor session as a generic bad request without creating a visitor row', async () => {
    const manager = await createMember('visitor-cross-manager');
    const activity = await createPublishedActivity();
    const foreignActivity = await createPublishedActivity();
    const foreignSession = await createSession(foreignActivity.id);
    await grantManagedRegistrationAccess(activity.id, manager);

    const before = await prisma.activityVisitor.count();
    expectBizError(
      await request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${activity.id}/visitors`)
        .set('Authorization', manager.auth)
        .send({ sessionId: foreignSession.id, name: '跨活动不允许' }),
      BizCode.BAD_REQUEST,
    );
    expect(await prisma.activityVisitor.count()).toBe(before);
  });
});
