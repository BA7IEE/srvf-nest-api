import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, PrincipalType, Prisma, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

describe('Admin activity GPS check-in evidence and attendance draft (F3)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let globalAuth: string;
  let scopedAuth: string;
  let bareAuth: string;

  let activityId: string;
  let outsideActivityId: string;
  let globalUserId: string;
  let registrationAId: string;
  let registrationBId: string;
  let registrationCId: string;
  let absentRegistrationId: string;
  let cancelledRegistrationId: string;
  let deletedMemberRegistrationId: string;
  let outsideAbsentRegistrationId: string;
  let memberAId: string;
  let memberBId: string;
  let memberCId: string;
  let activityEndAt: Date;

  const collectionPath = (id = activityId): string => `/api/admin/v1/activities/${id}/check-ins`;
  const draftPath = (id = activityId): string =>
    `/api/admin/v1/activities/${id}/attendance-sheet-draft`;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const globalUser = await createTestUser(app, {
      username: 'acf3-global',
      role: Role.ADMIN,
    });
    globalUserId = globalUser.id;
    const scopedUser = await createTestUser(app, {
      username: 'acf3-scoped',
      role: Role.USER,
    });
    await createTestUser(app, { username: 'acf3-bare', role: Role.USER });

    const { bizAdminRoleId } = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, globalUser.id, bizAdminRoleId);

    const organization = await prisma.organization.create({
      data: { name: 'ACF3 组织', nodeTypeCode: 'team' },
      select: { id: true },
    });
    activityEndAt = new Date('2026-08-01T12:00:00.000Z');
    const activity = await prisma.activity.create({
      data: {
        title: 'ACF3 主活动',
        activityTypeCode: 'acf3-type',
        organizationId: organization.id,
        startAt: new Date('2026-08-01T08:00:00.000Z'),
        endAt: activityEndAt,
        location: 'ACF3 场地',
        statusCode: 'published',
        isPublicRegistration: true,
      },
      select: { id: true },
    });
    activityId = activity.id;
    outsideActivityId = (
      await prisma.activity.create({
        data: {
          title: 'ACF3 范围外活动',
          activityTypeCode: 'acf3-type',
          organizationId: organization.id,
          startAt: new Date('2026-08-02T08:00:00.000Z'),
          endAt: new Date('2026-08-02T12:00:00.000Z'),
          location: 'ACF3 范围外场地',
          statusCode: 'published',
          isPublicRegistration: true,
        },
        select: { id: true },
      })
    ).id;

    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: scopedUser.id,
        roleId: bizAdminRoleId,
        scopeType: BindingScopeType.ACTIVITY,
        scopeActivityId: activityId,
      },
    });

    const roleType = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: roleType.id, code: 'member', label: '队员' },
    });
    const statusType = await prisma.dictType.create({
      data: { code: 'attendance_status', label: '考勤状态' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: statusType.id, code: 'present', label: '出勤' },
    });

    const members = await Promise.all(
      [
        ['acf3-a', '完整签退'],
        ['acf3-b', '忘记签退'],
        ['acf3-c', '未验证定位'],
        ['acf3-d', '零打卡'],
        ['acf3-e', '取消报名证据'],
        ['acf3-f', '软删队员证据'],
        ['acf3-g', '范围外零打卡'],
      ].map(([memberNo, displayName]) =>
        prisma.member.create({
          data: { memberNo, displayName },
          select: { id: true },
        }),
      ),
    );
    [memberAId, memberBId, memberCId] = members.map((member) => member.id);

    const registrations = await Promise.all([
      prisma.activityRegistration.create({
        data: { activityId, memberId: members[0].id, statusCode: 'pass' },
        select: { id: true },
      }),
      prisma.activityRegistration.create({
        data: { activityId, memberId: members[1].id, statusCode: 'pass' },
        select: { id: true },
      }),
      prisma.activityRegistration.create({
        data: { activityId, memberId: members[2].id, statusCode: 'pass' },
        select: { id: true },
      }),
      prisma.activityRegistration.create({
        data: { activityId, memberId: members[3].id, statusCode: 'pass' },
        select: { id: true },
      }),
      prisma.activityRegistration.create({
        data: { activityId, memberId: members[4].id, statusCode: 'cancelled' },
        select: { id: true },
      }),
      prisma.activityRegistration.create({
        data: { activityId, memberId: members[5].id, statusCode: 'pass' },
        select: { id: true },
      }),
      prisma.activityRegistration.create({
        data: { activityId: outsideActivityId, memberId: members[6].id, statusCode: 'pass' },
        select: { id: true },
      }),
    ]);
    [
      registrationAId,
      registrationBId,
      registrationCId,
      absentRegistrationId,
      cancelledRegistrationId,
      deletedMemberRegistrationId,
      outsideAbsentRegistrationId,
    ] = registrations.map((registration) => registration.id);

    const evidenceTimes = [1, 2, 3, 4, 5].map(
      (minute) => new Date(`2026-07-15T00:0${minute}:00.000Z`),
    );
    await prisma.activityCheckIn.createMany({
      data: [
        {
          activityId,
          memberId: members[0].id,
          registrationId: registrationAId,
          checkInAt: new Date('2026-08-01T08:00:00.000Z'),
          checkOutAt: new Date('2026-08-01T09:30:00.000Z'),
          checkInLongitude: new Prisma.Decimal('114.1234567'),
          checkInLatitude: new Prisma.Decimal('22.1234567'),
          checkInAccuracy: new Prisma.Decimal('5.00'),
          checkInDistance: new Prisma.Decimal('12.30'),
          checkOutLongitude: new Prisma.Decimal('114.1234000'),
          checkOutLatitude: new Prisma.Decimal('22.1234000'),
          checkOutAccuracy: new Prisma.Decimal('6.00'),
          checkOutDistance: new Prisma.Decimal('18.40'),
          geoVerified: true,
          outOfRange: false,
          createdAt: evidenceTimes[0],
          updatedAt: evidenceTimes[0],
        },
        {
          activityId,
          memberId: members[1].id,
          registrationId: registrationBId,
          checkInAt: new Date('2026-08-01T09:00:00.000Z'),
          checkInLongitude: new Prisma.Decimal('114.2234567'),
          checkInLatitude: new Prisma.Decimal('22.2234567'),
          checkInAccuracy: new Prisma.Decimal('7.00'),
          checkInDistance: new Prisma.Decimal('600.00'),
          geoVerified: true,
          outOfRange: true,
          createdAt: evidenceTimes[1],
          updatedAt: evidenceTimes[1],
        },
        {
          activityId,
          memberId: members[2].id,
          registrationId: registrationCId,
          checkInAt: new Date('2026-08-01T10:00:00.000Z'),
          checkOutAt: new Date('2026-08-01T10:00:36.000Z'),
          checkInLongitude: new Prisma.Decimal('114.3234567'),
          checkInLatitude: new Prisma.Decimal('22.3234567'),
          checkInAccuracy: new Prisma.Decimal('8.00'),
          checkOutLongitude: new Prisma.Decimal('114.3234000'),
          checkOutLatitude: new Prisma.Decimal('22.3234000'),
          checkOutAccuracy: new Prisma.Decimal('8.00'),
          geoVerified: false,
          outOfRange: false,
          createdAt: evidenceTimes[2],
          updatedAt: evidenceTimes[2],
        },
        {
          activityId,
          memberId: members[4].id,
          registrationId: cancelledRegistrationId,
          checkInAt: new Date('2026-08-01T08:15:00.000Z'),
          checkOutAt: new Date('2026-08-01T08:45:00.000Z'),
          checkInDistance: new Prisma.Decimal('10.00'),
          checkOutDistance: new Prisma.Decimal('10.00'),
          geoVerified: true,
          outOfRange: false,
          createdAt: evidenceTimes[3],
          updatedAt: evidenceTimes[3],
        },
        {
          activityId,
          memberId: members[5].id,
          registrationId: deletedMemberRegistrationId,
          checkInAt: new Date('2026-08-01T11:00:00.000Z'),
          checkOutAt: new Date('2026-08-01T11:30:00.000Z'),
          checkInDistance: new Prisma.Decimal('15.00'),
          checkOutDistance: new Prisma.Decimal('15.00'),
          geoVerified: true,
          outOfRange: false,
          createdAt: evidenceTimes[4],
          updatedAt: evidenceTimes[4],
        },
      ],
    });
    await prisma.member.update({
      where: { id: members[5].id },
      data: { deletedAt: new Date('2026-07-15T01:00:00.000Z') },
    });

    globalAuth = (await loginAs(app, 'acf3-global')).authHeader;
    scopedAuth = (await loginAs(app, 'acf3-scoped')).authHeader;
    bareAuth = (await loginAs(app, 'acf3-bare')).authHeader;
  });

  afterAll(async () => {
    await app.close();
  });

  it('鉴权矩阵：未登录 401、无码 30100、ACTIVITY scoped 仅活动内可读、GLOBAL 保留真实 404', async () => {
    expectBizError(await request(httpServer(app)).get(collectionPath()), BizCode.UNAUTHORIZED);
    expectBizError(
      await request(httpServer(app)).get(collectionPath()).set('Authorization', bareAuth),
      BizCode.RBAC_FORBIDDEN,
    );

    expect(
      (await request(httpServer(app)).get(collectionPath()).set('Authorization', scopedAuth))
        .status,
    ).toBe(200);
    expect(
      (await request(httpServer(app)).get(draftPath()).set('Authorization', scopedAuth)).status,
    ).toBe(200);
    expectBizError(
      await request(httpServer(app))
        .get(collectionPath(outsideActivityId))
        .set('Authorization', scopedAuth),
      BizCode.RBAC_FORBIDDEN,
    );
    expectBizError(
      await request(httpServer(app))
        .get(draftPath(outsideActivityId))
        .set('Authorization', scopedAuth),
      BizCode.RBAC_FORBIDDEN,
    );

    const missingId = 'cl000000000000000000missing';
    expectBizError(
      await request(httpServer(app))
        .get(collectionPath(missingId))
        .set('Authorization', globalAuth),
      BizCode.ACTIVITY_NOT_FOUND,
    );
    expectBizError(
      await request(httpServer(app)).get(draftPath(missingId)).set('Authorization', scopedAuth),
      BizCode.RBAC_FORBIDDEN,
    );
  });

  it('证据列表固定分页与 createdAt desc，保留取消/软删成员历史且永不回显 raw GPS', async () => {
    const page = await request(httpServer(app))
      .get(`${collectionPath()}?page=1&pageSize=2`)
      .set('Authorization', globalAuth);
    expect(page.status).toBe(200);
    expect(page.body.data).toMatchObject({ total: 5, page: 1, pageSize: 2 });
    expect(
      page.body.data.items.map((item: { registrationId: string }) => item.registrationId),
    ).toEqual([deletedMemberRegistrationId, cancelledRegistrationId]);

    const expectedItemKeys = [
      'id',
      'activityId',
      'registrationId',
      'member',
      'checkInAt',
      'checkOutAt',
      'checkInDistance',
      'checkOutDistance',
      'geoVerified',
      'outOfRange',
      'createdAt',
      'updatedAt',
    ].sort();
    for (const item of page.body.data.items as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(expectedItemKeys);
      expect(Object.keys(item.member as Record<string, unknown>).sort()).toEqual([
        'displayName',
        'id',
        'memberNo',
      ]);
      expect(typeof item.checkInDistance).toBe('string');
    }

    const all = await request(httpServer(app))
      .get(`${collectionPath()}?page=1&pageSize=100`)
      .set('Authorization', globalAuth);
    expect(all.status).toBe(200);
    const ids = all.body.data.items.map((item: { registrationId: string }) => item.registrationId);
    expect(ids).toEqual([
      deletedMemberRegistrationId,
      cancelledRegistrationId,
      registrationCId,
      registrationBId,
      registrationAId,
    ]);
    const serialized = JSON.stringify(all.body.data);
    for (const forbidden of [
      'memberId',
      'checkInLongitude',
      'checkInLatitude',
      'checkInAccuracy',
      'checkOutLongitude',
      'checkOutLatitude',
      'checkOutAccuracy',
      'deletedAt',
    ]) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
  });

  it('只读草稿聚合完整/忘签退/越界/unverified/absent，取消与软删成员自然出局且零写', async () => {
    const before = await Promise.all([
      prisma.attendanceSheet.count(),
      prisma.attendanceRecord.count(),
    ]);
    const response = await request(httpServer(app))
      .get(draftPath())
      .set('Authorization', globalAuth);
    const after = await Promise.all([
      prisma.attendanceSheet.count(),
      prisma.attendanceRecord.count(),
    ]);

    expect(response.status).toBe(200);
    expect(after).toEqual(before);
    const data = response.body.data as {
      activityId: string;
      records: Array<Record<string, unknown>>;
      flags: Array<Record<string, unknown>>;
      absentRegistrations: Array<Record<string, unknown>>;
    };
    expect(Object.keys(data).sort()).toEqual([
      'absentRegistrations',
      'activityId',
      'flags',
      'records',
    ]);
    expect(data.activityId).toBe(activityId);
    expect(data.records.map((record) => record.registrationId as string)).toEqual([
      registrationAId,
      registrationBId,
      registrationCId,
    ]);
    expect(data.absentRegistrations).toEqual([
      {
        registrationId: absentRegistrationId,
        memberId: expect.any(String),
        memberNo: 'acf3-d',
        displayName: '零打卡',
      },
    ]);

    const recordsByRegistration = new Map<string, Record<string, unknown>>(
      data.records.map((record) => [record.registrationId as string, record]),
    );
    expect(recordsByRegistration.get(registrationAId)).toEqual({
      memberId: memberAId,
      roleCode: 'member',
      checkInAt: '2026-08-01T08:00:00.000Z',
      checkOutAt: '2026-08-01T09:30:00.000Z',
      serviceHours: 1.5,
      attendanceStatusCode: 'present',
      registrationId: registrationAId,
    });
    expect(recordsByRegistration.get(registrationBId)).toMatchObject({
      memberId: memberBId,
      checkOutAt: activityEndAt.toISOString(),
      serviceHours: 3,
    });
    expect(recordsByRegistration.get(registrationCId)).toMatchObject({
      memberId: memberCId,
      checkOutAt: '2026-08-01T10:00:36.000Z',
      serviceHours: 0.01,
    });
    for (const record of data.records) {
      expect(Object.keys(record).sort()).toEqual([
        'attendanceStatusCode',
        'checkInAt',
        'checkOutAt',
        'memberId',
        'registrationId',
        'roleCode',
        'serviceHours',
      ]);
      expect(typeof record.serviceHours).toBe('number');
      expect(record).not.toHaveProperty('contributionPoints');
    }

    const flagsByRegistration = new Map<string, Record<string, unknown>>(
      data.flags.map((flag) => [flag.registrationId as string, flag]),
    );
    expect(flagsByRegistration.get(registrationAId)).toMatchObject({
      noCheckOut: false,
      outOfRange: false,
      unverified: false,
    });
    expect(flagsByRegistration.get(registrationBId)).toMatchObject({
      noCheckOut: true,
      outOfRange: true,
      unverified: false,
    });
    expect(flagsByRegistration.get(registrationCId)).toMatchObject({
      noCheckOut: false,
      outOfRange: false,
      unverified: true,
    });
    expect(flagsByRegistration.has(cancelledRegistrationId)).toBe(false);
    expect(flagsByRegistration.has(deletedMemberRegistrationId)).toBe(false);

    const forgottenCheckout = await prisma.activityCheckIn.findFirstOrThrow({
      where: { registrationId: registrationBId, deletedAt: null },
      select: { checkOutAt: true },
    });
    expect(forgottenCheckout.checkOutAt).toBeNull();
  });

  it('零打卡活动仍返回 200 + 独立 absent 清单，不伪造 record', async () => {
    const response = await request(httpServer(app))
      .get(draftPath(outsideActivityId))
      .set('Authorization', globalAuth);
    expect(response.status).toBe(200);
    expect(response.body.data.records).toEqual([]);
    expect(response.body.data.flags).toEqual([]);
    expect(response.body.data.absentRegistrations).toEqual([
      expect.objectContaining({ registrationId: outsideAbsentRegistrationId }),
    ]);
  });

  it('draft.records 可原样 POST 既有 attendance-sheets 并生成 pending Sheet', async () => {
    const draft = await request(httpServer(app)).get(draftPath()).set('Authorization', globalAuth);
    expect(draft.status).toBe(200);

    const submitted = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
      .set('Authorization', globalAuth)
      .send({ records: draft.body.data.records });
    expect(submitted.status).toBe(201);
    expect(submitted.body.data).toMatchObject({
      activityId,
      submitterUserId: globalUserId,
      statusCode: 'pending',
    });

    const sheet = await prisma.attendanceSheet.findUniqueOrThrow({
      where: { id: submitted.body.data.id },
      select: {
        statusCode: true,
        records: {
          where: { deletedAt: null },
          select: {
            memberId: true,
            registrationId: true,
            serviceHours: true,
            contributionPoints: true,
          },
          orderBy: { checkInAt: 'asc' },
        },
      },
    });
    expect(sheet.statusCode).toBe('pending');
    expect(sheet.records.map((record) => record.registrationId)).toEqual([
      registrationAId,
      registrationBId,
      registrationCId,
    ]);
    expect(sheet.records.map((record) => record.serviceHours.toNumber())).toEqual([1.5, 3, 0.01]);
    expect(sheet.records.every((record) => record.contributionPoints === null)).toBe(true);
  });
});
