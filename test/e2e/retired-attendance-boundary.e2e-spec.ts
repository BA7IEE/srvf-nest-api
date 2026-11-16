import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { RETIRED_ATTENDANCE_ROUTES } from '../fixtures/retired-attendance-contract';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// OpenAPI 缺席还不够：真实路由不能借开关、账号角色或旧数据重新成为可调用入口。
describe.each(['false', 'true'])('旧考勤 HTTP 退役边界（v1.1=%s）', (enabled) => {
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAuth: string;
  let memberAuth: string;
  let params: Record<string, string>;

  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = enabled;
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    const admin = await createTestUser(app, {
      username: 'retirement-boundary-admin',
      role: Role.SUPER_ADMIN,
    });
    const user = await createTestUser(app, {
      username: 'retirement-boundary-member',
      role: Role.USER,
    });
    const member = await prisma.member.create({
      data: {
        memberNo: 'retirement-boundary-member',
        ...memberIdentityData('退役边界测试队员'),
      },
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    const organization = await prisma.organization.create({
      data: { name: '退役边界测试组织', nodeTypeCode: 'team' },
    });
    const activity = await prisma.activity.create({
      data: {
        title: '有真实旧数据的退役边界活动',
        activityTypeCode: 'retirement-boundary',
        organizationId: organization.id,
        startAt: new Date('2026-01-15T01:00:00.000Z'),
        endAt: new Date('2026-01-15T03:00:00.000Z'),
        location: '测试地点',
        statusCode: 'published',
      },
    });
    const registration = await prisma.activityRegistration.create({
      data: { activityId: activity.id, memberId: member.id, statusCode: 'pass' },
    });
    const sheet = await prisma.attendanceSheet.create({
      data: {
        activityId: activity.id,
        submitterUserId: admin.id,
        statusCode: 'pending',
        records: {
          create: {
            memberId: member.id,
            registrationId: registration.id,
            roleCode: 'member',
            checkInAt: activity.startAt,
            checkOutAt: activity.endAt,
            serviceHours: '2',
            contributionPoints: '2',
            attendanceStatusCode: 'present',
          },
        },
      },
    });
    await prisma.activityCheckIn.create({
      data: {
        activityId: activity.id,
        memberId: member.id,
        registrationId: registration.id,
        checkInAt: activity.startAt,
        geoVerified: false,
      },
    });
    params = { activityId: activity.id, id: sheet.id, sheetId: sheet.id, memberId: member.id };
    adminAuth = (await loginAs(app, 'retirement-boundary-admin')).authHeader;
    memberAuth = (await loginAs(app, 'retirement-boundary-member')).authHeader;
    // 正向对照：同一应用、账号和活动的保留接口仍能访问。
    await request(httpServer(app))
      .get(`/api/admin/v1/activities/${activity.id}`)
      .set('Authorization', adminAuth)
      .expect(200);
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    }
  });

  async function stateDigest(): Promise<string> {
    const state = await prisma.$transaction([
      prisma.activity.findMany({ orderBy: { id: 'asc' } }),
      prisma.activityRegistration.findMany({ orderBy: { id: 'asc' } }),
      prisma.attendanceSheet.findMany({ orderBy: { id: 'asc' } }),
      prisma.attendanceRecord.findMany({ orderBy: { id: 'asc' } }),
      prisma.activityCheckIn.findMany({ orderBy: { id: 'asc' } }),
      prisma.auditLog.count(),
      prisma.notificationOutboxIntent.count(),
      prisma.activityRegistrationRevision.count(),
      prisma.activityParticipationIdentity.count(),
      prisma.attendancePunchEvent.count(),
      prisma.attendanceSettlementRun.count(),
      prisma.participationLedgerEntry.count(),
    ]);
    // 失败时也只输出摘要，不把原始事实内容放进 Jest diff。
    return createHash('sha256').update(JSON.stringify(state)).digest('hex');
  }

  it.each(RETIRED_ATTENDANCE_ROUTES)(
    '%s %s：各身份均 404，业务状态不变',
    async (method, template) => {
      const path = template.replace(/\{(\w+)\}/g, (_match, name: string) => {
        const value = params[name];
        if (value === undefined) throw new Error(`未提供退役路由参数:${name}`);
        return value;
      });
      const before = await stateDigest();
      for (const auth of [undefined, adminAuth, memberAuth]) {
        let call = request(httpServer(app))[method](path);
        if (auth !== undefined) call = call.set('Authorization', auth);
        if (method === 'post' || method === 'patch') call = call.send({});
        await call.expect(404);
      }
      expect(await stateDigest()).toBe(before);
    },
  );
});
