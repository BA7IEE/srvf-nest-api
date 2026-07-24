import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
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

describe('attendance return and resubmit workflow', () => {
  let app: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;
  let activityId: string;
  let memberId: string;
  let submitterId: string;
  let reviewerId: string;
  let reviewerAuth: string;
  let saId: string;
  let saAuth: string;

  beforeAll(async () => {
    app = await createTestApp();
    appB = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    const bizRole = (await seedBizAdminPermissionsAndRole(app)).bizAdminRoleId;
    const firstReviewerRole = await prisma.rbacRole.create({
      data: {
        code: 'attendance-first-reviewer',
        displayName: '考勤一审员',
      },
      select: { id: true },
    });
    const firstReviewerPermissions = await prisma.permission.findMany({
      where: {
        code: {
          in: [
            'attendance.read.sheet',
            'attendance.approve.sheet',
            'attendance.reject.sheet',
            'attendance.return.sheet',
          ],
        },
      },
      select: { id: true },
    });
    await prisma.rolePermission.createMany({
      data: firstReviewerPermissions.map((permission) => ({
        roleId: firstReviewerRole.id,
        permissionId: permission.id,
      })),
    });
    const submitter = await createTestUser(app, {
      username: 'return-submitter',
      role: Role.ADMIN,
    });
    const reviewer = await createTestUser(app, {
      username: 'return-reviewer',
      role: Role.ADMIN,
    });
    const sa = await createTestUser(app, { username: 'return-sa', role: Role.SUPER_ADMIN });
    submitterId = submitter.id;
    reviewerId = reviewer.id;
    saId = sa.id;
    await grantBizAdminToUser(app, submitter.id, bizRole);
    await grantBizAdminToUser(app, reviewer.id, bizRole);
    await prisma.roleBinding.createMany({
      data: [submitter.id, reviewer.id].map((userId) => ({
        principalType: 'USER',
        principalId: userId,
        roleId: firstReviewerRole.id,
        scopeType: 'GLOBAL',
        status: 'ACTIVE',
      })),
    });
    reviewerAuth = (await loginAs(app, reviewer.username)).authHeader;
    saAuth = (await loginAs(app, sa.username)).authHeader;

    const org = await prisma.organization.create({
      data: { name: 'Return workflow org', nodeTypeCode: 'return-workflow-org' },
      select: { id: true },
    });
    activityId = (
      await prisma.activity.create({
        data: {
          title: 'Return workflow activity',
          activityTypeCode: 'return-workflow',
          organizationId: org.id,
          startAt: new Date('2026-07-20T01:00:00.000Z'),
          endAt: new Date('2026-07-20T05:00:00.000Z'),
          location: '深圳',
          statusCode: 'completed',
        },
        select: { id: true },
      })
    ).id;
    memberId = (
      await prisma.member.create({
        data: { memberNo: 'return-member', displayName: 'Return member' },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await appB.close();
    await app.close();
  });

  async function sheet(statusCode: string, reviewerUserId: string | null = null): Promise<string> {
    const created = await prisma.attendanceSheet.create({
      data: {
        activityId,
        submitterUserId: submitterId,
        lastSubmittedByUserId: submitterId,
        lastSubmittedAt: new Date(),
        statusCode,
        reviewerUserId,
        reviewedAt: reviewerUserId ? new Date() : null,
        records: {
          create: {
            memberId,
            roleCode: 'member',
            checkInAt: new Date('2026-07-20T01:00:00.000Z'),
            checkOutAt: new Date('2026-07-20T03:00:00.000Z'),
            serviceHours: 2,
            attendanceStatusCode: 'present',
            contributionPoints: 1,
          },
        },
      },
      select: { id: true },
    });
    return created.id;
  }

  it('first return preserves records and audit; SUPER_ADMIN resubmit clears review fields', async () => {
    const sheetId = await sheet('pending');
    const returned = await request(httpServer(app))
      .post(`/api/admin/v1/attendance-sheets/${sheetId}/return`)
      .set('Authorization', reviewerAuth)
      .send({ returnNote: ' 请补充签退说明 ' })
      .expect(200);
    expect(returned.body.data).toMatchObject({
      statusCode: 'returned',
      reviewerUserId: reviewerId,
      returnedByUserId: reviewerId,
      returnNote: '请补充签退说明',
      returnedFromStageCode: 'first',
    });
    await expect(
      prisma.attendanceRecord.count({ where: { sheetId, deletedAt: null } }),
    ).resolves.toBe(1);
    const reviewAudit = await prisma.auditLog.findFirstOrThrow({
      where: { resourceId: sheetId, event: 'attendance-sheet.review' },
      orderBy: { createdAt: 'desc' },
    });
    expect(reviewAudit.context).toMatchObject({ extra: { action: 'return' } });

    const resubmitted = await request(httpServer(app))
      .post(`/api/admin/v1/attendance-sheets/${sheetId}/resubmit`)
      .set('Authorization', saAuth)
      .send({})
      .expect(200);
    expect(resubmitted.body.data).toMatchObject({
      statusCode: 'pending',
      lastSubmittedByUserId: saId,
      reviewerUserId: null,
      returnedByUserId: null,
      returnNote: null,
      returnedFromStageCode: null,
      version: 2,
    });
    await expect(
      prisma.attendanceRecord.count({ where: { sheetId, deletedAt: null } }),
    ).resolves.toBe(1);
    expectBizError(
      await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${sheetId}/approve`)
        .set('Authorization', saAuth)
        .send({ reviewNote: 'recent resubmitter must not review' }),
      BizCode.ATTENDANCE_SELF_FIRST_REVIEW_FORBIDDEN,
    );
  });

  it('final return preserves records and writes final reviewer/return stage', async () => {
    const sheetId = await sheet('pending_final_review', reviewerId);
    const returned = await request(httpServer(app))
      .post(`/api/admin/v1/attendance-sheets/${sheetId}/final-return`)
      .set('Authorization', saAuth)
      .send({ returnNote: '终审要求修订' })
      .expect(200);
    expect(returned.body.data).toMatchObject({
      statusCode: 'returned',
      finalReviewerUserId: saId,
      returnedByUserId: saId,
      returnNote: '终审要求修订',
      returnedFromStageCode: 'final',
    });
    await expect(
      prisma.attendanceRecord.count({ where: { sheetId, deletedAt: null } }),
    ).resolves.toBe(1);
  });

  it('return actions retain self/same-reviewer constraints', async () => {
    const selfSheet = await sheet('pending');
    const submitterAuth = (await loginAs(app, 'return-submitter')).authHeader;
    expectBizError(
      await request(httpServer(app))
        .post(`/api/admin/v1/attendance-sheets/${selfSheet}/return`)
        .set('Authorization', submitterAuth)
        .send({ returnNote: '不得自审' }),
      BizCode.ATTENDANCE_SELF_FIRST_REVIEW_FORBIDDEN,
    );

    const sameReviewerSheet = await sheet('pending_final_review', saId);
    expectBizError(
      await request(httpServer(app))
        .post(`/api/admin/v1/attendance-sheets/${sameReviewerSheet}/final-return`)
        .set('Authorization', saAuth)
        .send({ returnNote: '不得同人终审' }),
      BizCode.ATTENDANCE_SAME_REVIEWER_FORBIDDEN,
    );
  });

  it('rejects a blank return note and resubmit outside returned status with stable BizCodes', async () => {
    const blankNoteSheet = await sheet('pending');
    expectBizError(
      await request(httpServer(app))
        .post(`/api/admin/v1/attendance-sheets/${blankNoteSheet}/return`)
        .set('Authorization', reviewerAuth)
        .send({ returnNote: '   ' }),
      BizCode.ATTENDANCE_RETURN_NOTE_REQUIRED,
    );

    const pendingSheet = await sheet('pending');
    expectBizError(
      await request(httpServer(app))
        .post(`/api/admin/v1/attendance-sheets/${pendingSheet}/resubmit`)
        .set('Authorization', saAuth)
        .send({}),
      BizCode.ATTENDANCE_SHEET_RESUBMIT_STATUS_INVALID,
    );
  });

  it('two Nest apps serialize approve-vs-return and final-approve-vs-final-return', async () => {
    const firstSheet = await sheet('pending');
    const firstResults = await Promise.all([
      request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${firstSheet}/approve`)
        .set('Authorization', reviewerAuth)
        .send({ reviewNote: 'approve race' }),
      request(httpServer(appB))
        .post(`/api/admin/v1/attendance-sheets/${firstSheet}/return`)
        .set('Authorization', reviewerAuth)
        .send({ returnNote: 'return race' }),
    ]);
    expect(firstResults.map((result) => result.status).sort()).toEqual([200, 409]);
    await expect(
      prisma.attendanceSheet.findUniqueOrThrow({
        where: { id: firstSheet },
        select: { statusCode: true },
      }),
    ).resolves.toMatchObject({
      statusCode: expect.stringMatching(/^(pending_final_review|returned)$/),
    });

    const finalSheet = await sheet('pending_final_review', reviewerId);
    const finalResults = await Promise.all([
      request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${finalSheet}/final-approve`)
        .set('Authorization', saAuth)
        .send({ finalReviewNote: 'approve race' }),
      request(httpServer(appB))
        .post(`/api/admin/v1/attendance-sheets/${finalSheet}/final-return`)
        .set('Authorization', saAuth)
        .send({ returnNote: 'return race' }),
    ]);
    expect(finalResults.map((result) => result.status).sort()).toEqual([200, 409]);
    await expect(
      prisma.attendanceSheet.findUniqueOrThrow({
        where: { id: finalSheet },
        select: { statusCode: true },
      }),
    ).resolves.toMatchObject({ statusCode: expect.stringMatching(/^(approved|returned)$/) });
  });
});
