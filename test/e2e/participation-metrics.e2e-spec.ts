import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { seedParticipationReadState } from '../fixtures/contribution-ledger.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// 审计刀 5 F1–F4：三条核心口径锁 + admin/App scope 边界。
describe('participation metrics F1-F4', () => {
  const previousWorkflowGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let bareUserAuth: string;
  let memberUserAuth: string;
  let activityId: string;
  let draftActivityId: string;
  let memberAId: string;
  let memberBId: string;
  let memberDId: string;

  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const superAdmin = await createTestUser(app, {
      username: 'pmx-super-admin',
      role: Role.SUPER_ADMIN,
    });
    await createTestUser(app, { username: 'pmx-bare-user', role: Role.USER });

    const org = await prisma.organization.create({
      data: { name: 'PMX Org', nodeTypeCode: 'team' },
      select: { id: true },
    });
    const members = await Promise.all(
      [
        ['pmx-a', 'Pending Evidence'],
        ['pmx-b', 'No Show'],
        ['pmx-c', 'Temporary'],
        ['pmx-d', 'Approved Participant'],
        ['pmx-e', 'Pending Registration'],
        ['pmx-f', 'Rejected Registration'],
        ['pmx-g', 'Cancelled Registration'],
        ['pmx-h', 'Waitlisted Registration'],
      ].map(([memberNo, realName]) =>
        prisma.member.create({
          data: { memberNo, ...memberIdentityData(realName) },
          select: { id: true, memberNo: true },
        }),
      ),
    );
    [memberAId, memberBId, , memberDId] = members.map((member) => member.id);

    const memberUser = await createTestUser(app, {
      username: 'pmx-member-user',
      role: Role.USER,
    });
    await prisma.user.update({
      where: { id: memberUser.id },
      data: { memberId: memberDId },
    });

    const activity = await prisma.activity.create({
      data: {
        title: 'PMX Completed Activity',
        activityTypeCode: 'pmx-type',
        organizationId: org.id,
        startAt: new Date('2026-07-10T01:00:00.000Z'),
        endAt: new Date('2026-07-10T09:00:00.000Z'),
        location: 'PMX',
        statusCode: 'completed',
      },
      select: { id: true },
    });
    activityId = activity.id;
    draftActivityId = (
      await prisma.activity.create({
        data: {
          title: 'PMX Draft Activity',
          activityTypeCode: 'pmx-type',
          organizationId: org.id,
          startAt: new Date('2099-08-10T01:00:00.000Z'),
          endAt: new Date('2099-08-10T09:00:00.000Z'),
          location: 'PMX',
          statusCode: 'draft',
        },
        select: { id: true },
      })
    ).id;

    await prisma.activityRegistration.createMany({
      data: [
        { activityId, memberId: memberAId, statusCode: 'pass' },
        { activityId, memberId: memberBId, statusCode: 'pass' },
        { activityId, memberId: memberDId, statusCode: 'pass' },
        { activityId, memberId: members[4].id, statusCode: 'pending' },
        { activityId, memberId: members[5].id, statusCode: 'reject' },
        { activityId, memberId: members[6].id, statusCode: 'cancelled' },
        { activityId, memberId: members[7].id, statusCode: 'waitlisted' },
      ],
    });
    const [pendingSheet, approvedSheet] = await Promise.all([
      prisma.attendanceSheet.create({
        data: {
          activityId,
          submitterUserId: superAdmin.id,
          statusCode: 'pending',
        },
        select: { id: true },
      }),
      prisma.attendanceSheet.create({
        data: {
          activityId,
          submitterUserId: superAdmin.id,
          statusCode: 'approved',
        },
        select: { id: true },
      }),
    ]);

    await prisma.attendanceRecord.createMany({
      data: [
        // 旧 pending 记录保留作反例，不能代替新版正式结果。
        {
          sheetId: pendingSheet.id,
          memberId: memberAId,
          roleCode: 'member',
          checkInAt: new Date('2026-07-10T01:00:00.000Z'),
          checkOutAt: new Date('2026-07-10T07:00:00.000Z'),
          serviceHours: '6',
          attendanceStatusCode: 'present',
          contributionPoints: '9',
        },
        // 旧临时参加记录；新版来源由下方不可变 onsite 修订给出。
        {
          sheetId: approvedSheet.id,
          memberId: members[2].id,
          roleCode: 'member',
          checkInAt: new Date('2026-07-10T01:00:00.000Z'),
          checkOutAt: new Date('2026-07-10T02:30:00.000Z'),
          serviceHours: '1.5',
          attendanceStatusCode: 'present',
          contributionPoints: '0.5',
        },
        // 同 member、同北京日两条 2 分：活动原始贡献=4，生涯封顶贡献=3。
        {
          sheetId: approvedSheet.id,
          memberId: memberDId,
          roleCode: 'member',
          checkInAt: new Date('2026-07-10T02:00:00.000Z'),
          checkOutAt: new Date('2026-07-10T04:30:00.000Z'),
          serviceHours: '2.5',
          attendanceStatusCode: 'present',
          contributionPoints: '2',
        },
        {
          sheetId: approvedSheet.id,
          memberId: memberDId,
          roleCode: 'member',
          checkInAt: new Date('2026-07-10T05:00:00.000Z'),
          checkOutAt: new Date('2026-07-10T08:00:00.000Z'),
          serviceHours: '3',
          attendanceStatusCode: 'present',
          contributionPoints: '2',
        },
        // 软删 approved record 不参与任何口径。
        {
          sheetId: approvedSheet.id,
          memberId: memberDId,
          roleCode: 'member',
          checkInAt: new Date('2026-07-11T01:00:00.000Z'),
          checkOutAt: new Date('2026-07-11T10:00:00.000Z'),
          serviceHours: '9',
          attendanceStatusCode: 'present',
          contributionPoints: '9',
          deletedAt: new Date('2026-07-12T00:00:00.000Z'),
        },
      ],
    });

    await seedParticipationReadState(prisma, {
      activityId,
      actorUserId: superAdmin.id,
      participants: [
        { memberId: memberAId, resultCode: null, serviceHours: '0', creditedPoints: '0' },
        { memberId: memberBId, resultCode: 'absent', serviceHours: '0', creditedPoints: '0' },
        {
          memberId: members[2].id,
          sourceCode: 'onsite',
          resultCode: 'present',
          serviceHours: '1.5',
          creditedPoints: '0.5',
        },
        {
          memberId: memberDId,
          resultCode: 'present',
          serviceHours: '2.5',
          creditedPoints: '2',
          startAt: new Date('2026-07-10T02:00:00.000Z'),
        },
        {
          memberId: memberDId,
          resultCode: 'present',
          serviceHours: '3',
          recognizedPoints: '2',
          creditedPoints: '1',
          startAt: new Date('2026-07-10T05:00:00.000Z'),
        },
      ],
    });

    superAdminAuth = (await loginAs(app, 'pmx-super-admin')).authHeader;
    bareUserAuth = (await loginAs(app, 'pmx-bare-user')).authHeader;
    memberUserAuth = (await loginAs(app, 'pmx-member-user')).authHeader;
  });

  afterAll(async () => {
    try {
      await app.close();
    } finally {
      if (previousWorkflowGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousWorkflowGate;
    }
  });

  it('F1: 未决身份既非到场也非缺席，来源取不可变修订，时长只读已入账净额', async () => {
    const res = await request(httpServer(app))
      .get(`/api/admin/v1/activities/${activityId}/reconciliation`)
      .set('Authorization', superAdminAuth);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      passRegistrationCount: 3,
      attendedCount: 2,
      noShowCount: 1,
      pendingCount: 1,
    });
    const pendingEvidence = res.body.data.registeredParticipants.find(
      (item: { memberId: string }) => item.memberId === memberAId,
    );
    expect(pendingEvidence).toMatchObject({
      outcome: 'pending',
      origin: 'registered',
      recordCount: 0,
      postedResultCount: 0,
      totalServiceHours: null,
    });
    expect(pendingEvidence).not.toHaveProperty('approvedRecordCount');
    const noShow = res.body.data.registeredParticipants.find(
      (item: { memberId: string }) => item.memberId === memberBId,
    );
    expect(noShow).toMatchObject({ outcome: 'no-show', recordCount: 0 });
    expect(res.body.data.temporaryParticipants).toHaveLength(1);
    expect(res.body.data.temporaryParticipants[0]).toMatchObject({
      outcome: 'attended',
      origin: 'onsite',
      recordCount: 1,
      totalServiceHours: '1.5',
    });
  });

  it('F1 boundary: 非 completed 复用 ACTIVITY_STATUS_INVALID(409)', async () => {
    const res = await request(httpServer(app))
      .get(`/api/admin/v1/activities/${draftActivityId}/reconciliation`)
      .set('Authorization', superAdminAuth);
    expectBizError(res, BizCode.ACTIVITY_STATUS_INVALID);
  });

  it('F1/F2 authz: 两项读权限任一缺失即 30100；未登录 40100', async () => {
    const denied = await request(httpServer(app))
      .get(`/api/admin/v1/activities/${activityId}/participation-summary`)
      .set('Authorization', bareUserAuth);
    expectBizError(denied, BizCode.RBAC_FORBIDDEN);

    const unauthenticated = await request(httpServer(app)).get(
      `/api/admin/v1/activities/${activityId}/reconciliation`,
    );
    expectBizError(unauthenticated, BizCode.UNAUTHORIZED);
  });

  it('F2: 永久报名头与参与来源分开，正式结果定人数，净额和逐人时长直方图自洽', async () => {
    const res = await request(httpServer(app))
      .get(`/api/admin/v1/activities/${activityId}/participation-summary`)
      .set('Authorization', superAdminAuth);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      activityId,
      activityStatusCode: 'completed',
      registrationCounts: {
        total: 8,
        pending: 2,
        pass: 3,
        reject: 1,
        cancelled: 1,
        waitlisted: 1,
      },
      attendeeCount: 2,
      registeredAttendeeCount: 1,
      temporaryAttendeeCount: 1,
      mixedOriginAttendeeCount: 0,
      unknownOriginAttendeeCount: 0,
      noShowCount: 1,
      pendingCount: 1,
      pendingSessionCount: 1,
      otherResultCount: 0,
      attendanceRate: 0.6667,
      totalServiceHours: '7',
      totalContributionPoints: '3.5',
      durationHistogram: {
        under2Hours: 1,
        from2To4Hours: 0,
        from4To8Hours: 1,
        atLeast8Hours: 0,
      },
      durationUnknownCount: 0,
      feedback: { count: 0, avgRating: null },
    });
    const counts = res.body.data.registrationCounts as Record<string, number>;
    expect(
      counts.pending + counts.pass + counts.reject + counts.cancelled + counts.waitlisted,
    ).toBe(counts.total);
  });

  it('F3: 个人累计正式净额，按身份×北京日计数，贡献值与 contribution-summary 等值', async () => {
    const [participation, contribution] = await Promise.all([
      request(httpServer(app))
        .get(`/api/admin/v1/members/${memberDId}/participation-summary`)
        .set('Authorization', superAdminAuth),
      request(httpServer(app))
        .get(`/api/admin/v1/members/${memberDId}/contribution-summary`)
        .set('Authorization', superAdminAuth),
    ]);

    expect(participation.status).toBe(200);
    expect(participation.body.data).toEqual({
      memberId: memberDId,
      totalServiceHours: '5.5',
      activityCount: 1,
      recordCount: 2,
      contributionPoints: '3',
      ledgerTotals: {
        committedServiceHours: '5.5',
        committedContributionPoints: '3',
        inFlightServiceHours: '0',
        inFlightContributionPoints: '0',
      },
    });
    expect(contribution.status).toBe(200);
    expect(participation.body.data.contributionPoints).toBe(
      contribution.body.data.contributionPoints,
    );
  });

  it('F4: App participation-summary 恒本人且 DTO 只含正向四字段 + 账本两轴', async () => {
    const res = await request(httpServer(app))
      .get('/api/app/v1/my/participation-summary')
      .set('Authorization', memberUserAuth);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      totalServiceHours: '5.5',
      activityCount: 1,
      recordCount: 2,
      contributionPoints: '3',
      ledgerTotals: {
        committedServiceHours: '5.5',
        committedContributionPoints: '3',
        inFlightServiceHours: '0',
        inFlightContributionPoints: '0',
      },
    });
    expect(res.body.data).not.toHaveProperty('memberId');
    expect(res.body.data).not.toHaveProperty('noShowCount');
  });
});
