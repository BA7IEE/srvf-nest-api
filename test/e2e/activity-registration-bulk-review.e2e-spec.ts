import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

describe('activity registration bulk approve/reject F6', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let bareUserAuth: string;
  let activityId: string;
  let registration1Id: string;
  let registration2Id: string;
  let registration3Id: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const superAdmin = await createTestUser(app, {
      username: 'bulk-review-super',
      role: Role.SUPER_ADMIN,
    });
    await createTestUser(app, { username: 'bulk-review-bare', role: Role.USER });
    const org = await prisma.organization.create({
      data: { name: 'Bulk Review Org', nodeTypeCode: 'team' },
      select: { id: true },
    });
    activityId = (
      await prisma.activity.create({
        data: {
          title: 'Bulk Review Activity',
          activityTypeCode: 'bulk-review-type',
          organizationId: org.id,
          startAt: new Date('2099-07-15T01:00:00.000Z'),
          endAt: new Date('2099-07-15T09:00:00.000Z'),
          registrationDeadline: new Date('2099-07-14T23:00:00.000Z'),
          location: 'Bulk Review',
          statusCode: 'published',
          capacity: 1,
          publishedBy: superAdmin.id,
          publishedAt: new Date(),
        },
        select: { id: true },
      })
    ).id;
    const members = await Promise.all(
      ['bulk-review-m1', 'bulk-review-m2', 'bulk-review-m3'].map((memberNo) =>
        prisma.member.create({
          data: { memberNo, displayName: memberNo },
          select: { id: true },
        }),
      ),
    );
    const registrations = await Promise.all(
      members.map((member) =>
        prisma.activityRegistration.create({
          data: { activityId, memberId: member.id, statusCode: 'pending' },
          select: { id: true },
        }),
      ),
    );
    [registration1Id, registration2Id, registration3Id] = registrations.map((row) => row.id);

    superAdminAuth = (await loginAs(app, 'bulk-review-super')).authHeader;
    bareUserAuth = (await loginAs(app, 'bulk-review-bare')).authHeader;
  });

  afterAll(async () => {
    await app.close();
  });

  const bulkPath = (action: 'bulk-approve' | 'bulk-reject') =>
    `/api/admin/v1/activities/${activityId}/registrations/${action}`;

  it('bulk-approve 字面路由逐条独立：首条成功，容量/不存在各自失败，audit 只落成功条', async () => {
    const missingId = 'clmissingregistration000001';
    const res = await request(httpServer(app))
      .patch(bulkPath('bulk-approve'))
      .set('Authorization', superAdminAuth)
      .send({ ids: [registration1Id, registration2Id, missingId], reviewNote: '批量通过' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      succeeded: [registration1Id],
      failed: [
        {
          id: registration2Id,
          code: BizCode.ACTIVITY_CAPACITY_EXCEEDED.code,
          message: BizCode.ACTIVITY_CAPACITY_EXCEEDED.message,
        },
        {
          id: missingId,
          code: BizCode.ACTIVITY_REGISTRATION_NOT_FOUND.code,
          message: BizCode.ACTIVITY_REGISTRATION_NOT_FOUND.message,
        },
      ],
    });
    const states = await prisma.activityRegistration.findMany({
      where: { id: { in: [registration1Id, registration2Id] } },
      select: { id: true, statusCode: true },
    });
    expect(new Map(states.map((row) => [row.id, row.statusCode]))).toEqual(
      new Map([
        [registration1Id, 'pass'],
        [registration2Id, 'pending'],
      ]),
    );
    expect(
      await prisma.auditLog.count({
        where: { event: 'registration.review', resourceId: registration1Id },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { event: 'registration.review', resourceId: registration2Id },
      }),
    ).toBe(0);
  });

  it('bulk-reject 部分成功且缺省备注落“批量驳回”，既有 pass 状态机失败不影响成功条', async () => {
    const res = await request(httpServer(app))
      .patch(bulkPath('bulk-reject'))
      .set('Authorization', superAdminAuth)
      .send({ ids: [registration2Id, registration1Id] });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      succeeded: [registration2Id],
      failed: [
        {
          id: registration1Id,
          code: BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID.code,
          message: BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID.message,
        },
      ],
    });
    const rejected = await prisma.activityRegistration.findUniqueOrThrow({
      where: { id: registration2Id },
      select: { statusCode: true, reviewNote: true },
    });
    expect(rejected).toEqual({ statusCode: 'reject', reviewNote: '批量驳回' });
    expect(
      await prisma.auditLog.count({
        where: { event: 'registration.review', resourceId: registration2Id },
      }),
    ).toBe(1);
  });

  it('每个 id 逐点判权：无权限条目进入 failed(30100)，其它状态零变化', async () => {
    const res = await request(httpServer(app))
      .patch(bulkPath('bulk-approve'))
      .set('Authorization', bareUserAuth)
      .send({ ids: [registration3Id] });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      succeeded: [],
      failed: [
        {
          id: registration3Id,
          code: BizCode.RBAC_FORBIDDEN.code,
          message: BizCode.RBAC_FORBIDDEN.message,
        },
      ],
    });
    expect(
      await prisma.activityRegistration.findUniqueOrThrow({
        where: { id: registration3Id },
        select: { statusCode: true },
      }),
    ).toEqual({ statusCode: 'pending' });
  });

  it('DTO 边界：ids 为空/重复/>100 均由 ValidationPipe 拒绝', async () => {
    const invalidBodies = [
      { ids: [] },
      { ids: [registration3Id, registration3Id] },
      {
        ids: Array.from(
          { length: 101 },
          (_, index) => `bulk-id-${index.toString().padStart(4, '0')}`,
        ),
      },
    ];
    for (const body of invalidBodies) {
      const res = await request(httpServer(app))
        .patch(bulkPath('bulk-approve'))
        .set('Authorization', superAdminAuth)
        .send(body);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    }
  });

  it('未登录由全局 JwtAuthGuard 返回 40100', async () => {
    const res = await request(httpServer(app))
      .patch(bulkPath('bulk-approve'))
      .send({ ids: [registration3Id] });
    expectBizError(res, BizCode.UNAUTHORIZED);
  });
});
