import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

describe('Activity position attendance wiring (F4)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAuth: string;
  let appAuth: string;
  let activityId: string;
  let activityPositionId: string;
  let registrationId: string;
  let memberId: string;
  let now: Date;
  let activityPositionEndAt: Date;

  const checkInPath = (): string => `/api/app/v1/my/activities/${activityId}/check-in`;
  const draftPath = (): string => `/api/admin/v1/activities/${activityId}/attendance-sheet-draft`;
  const sheetsPath = (): string => `/api/admin/v1/activities/${activityId}/attendance-sheets`;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const admin = await createTestUser(app, {
      username: 'activitypositionf4admin',
      role: Role.SUPER_ADMIN,
    });
    adminAuth = (await loginAs(app, admin.username)).authHeader;

    const appUser = await createTestUser(app, { username: 'activitypositionf4app' });
    const member = await prisma.member.create({
      data: {
        memberNo: 'ACTIVITY-POSITION-F4',
        displayName: '岗位考勤队员',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    memberId = member.id;
    await prisma.user.update({ where: { id: appUser.id }, data: { memberId } });
    appAuth = (await loginAs(app, appUser.username)).authHeader;

    const attendanceRole = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    await prisma.dictItem.createMany({
      data: [
        { typeId: attendanceRole.id, code: 'member', label: '队员' },
        { typeId: attendanceRole.id, code: 'instructor', label: '教练' },
      ],
    });
    const attendanceStatus = await prisma.dictType.create({
      data: { code: 'attendance_status', label: '考勤状态' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: attendanceStatus.id, code: 'present', label: '出勤' },
    });

    const organization = await prisma.organization.create({
      data: { name: '活动岗位 F4 组织', nodeTypeCode: 'team' },
      select: { id: true },
    });
    now = new Date();
    activityId = (
      await prisma.activity.create({
        data: {
          title: '活动岗位 F4 考勤活动',
          activityTypeCode: 'activity-position-f4',
          organizationId: organization.id,
          startAt: new Date(now.getTime() - 24 * 3_600_000),
          endAt: new Date(now.getTime() + 24 * 3_600_000),
          location: '活动岗位 F4 场地',
          statusCode: 'published',
          isPublicRegistration: true,
          publishedAt: new Date(now.getTime() - 60_000),
        },
        select: { id: true },
      })
    ).id;
    activityPositionEndAt = new Date(now.getTime() + 3_600_000);
    activityPositionId = (
      await prisma.activityPosition.create({
        data: {
          activityId,
          name: '岗位考勤教练',
          attendanceRoleCode: 'instructor',
          startAt: new Date(now.getTime() - 3_600_000),
          endAt: activityPositionEndAt,
        },
        select: { id: true },
      })
    ).id;
    registrationId = (
      await prisma.activityRegistration.create({
        data: {
          activityId,
          activityPositionId,
          memberId,
          statusCode: 'pass',
          reviewedAt: now,
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('活动窗内但岗位窗外拒绝签到，岗位窗内可签到', async () => {
    await prisma.activityPosition.update({
      where: { id: activityPositionId },
      data: {
        startAt: new Date(now.getTime() + 5 * 3_600_000),
        endAt: new Date(now.getTime() + 6 * 3_600_000),
      },
    });

    expectBizError(
      await request(httpServer(app))
        .post(checkInPath())
        .set('Authorization', appAuth)
        .send({ longitude: 114, latitude: 22 }),
      BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW,
    );

    await prisma.activityPosition.update({
      where: { id: activityPositionId },
      data: {
        startAt: new Date(now.getTime() - 3_600_000),
        endAt: activityPositionEndAt,
      },
    });
    const success = await request(httpServer(app))
      .post(checkInPath())
      .set('Authorization', appAuth)
      .send({ longitude: 114, latitude: 22 });

    expect(success.status).toBe(200);
    expect(success.body.data.registrationId).toBe(registrationId);
  });

  it('考勤记录虽在活动窗内但超出岗位窗加既有容差时拒绝', async () => {
    const response = await request(httpServer(app))
      .post(sheetsPath())
      .set('Authorization', adminAuth)
      .send({
        records: [
          {
            memberId,
            roleCode: 'instructor',
            checkInAt: new Date(now.getTime() - 10 * 3_600_000).toISOString(),
            checkOutAt: new Date(now.getTime() - 9 * 3_600_000).toISOString(),
            attendanceStatusCode: 'present',
            registrationId,
          },
        ],
      });

    expectBizError(response, BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW);
  });

  it('草稿带出岗位角色与岗位 endAt，提交后按既有岗位角色规则预填贡献值', async () => {
    await prisma.contributionRule.create({
      data: {
        activityTypeCode: 'activity-position-f4',
        attendanceRoleCode: 'instructor',
        durationThreshold: null,
        pointsBelow: '2.50',
        pointsAbove: null,
        dailyCap: null,
      },
    });

    const draft = await request(httpServer(app)).get(draftPath()).set('Authorization', adminAuth);
    expect(draft.status).toBe(200);
    expect(draft.body.data.records).toHaveLength(1);
    expect(draft.body.data.records[0]).toMatchObject({
      memberId,
      registrationId,
      roleCode: 'instructor',
      checkOutAt: activityPositionEndAt.toISOString(),
    });

    const submitted = await request(httpServer(app))
      .post(sheetsPath())
      .set('Authorization', adminAuth)
      .send({ records: draft.body.data.records });
    expect(submitted.status).toBe(201);

    const record = await prisma.attendanceRecord.findFirstOrThrow({
      where: { sheetId: submitted.body.data.id, registrationId },
      select: { roleCode: true, contributionPoints: true },
    });
    expect(record.roleCode).toBe('instructor');
    expect(record.contributionPoints?.toString()).toBe('2.5');
  });
});
