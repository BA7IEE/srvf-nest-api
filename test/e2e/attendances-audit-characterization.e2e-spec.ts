import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../../src/database/prisma.service';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 原 A1/A2 的提交生命周期、B1/B2 的认定/记录保留和 D1 的审计失败整笔回滚，
// 已迁入 activity-settlement-submit.e2e-spec.ts 的真实新链命令。
// 本文件保留退役写面的边界：旧写入不再产生成功审计，也不能改写旧历史或新版事实。
const START = new Date('2020-03-01T00:00:00.000Z');
const END = new Date('2020-03-01T04:00:00.000Z');

describe('退役考勤写入的审计与历史保留边界', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: string;
  let activityId: string;
  let sheetId: string;
  let nativeVersionId: string;
  let memberId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    const user = await createTestUser(app, {
      username: 'retired-audit-admin',
      role: Role.SUPER_ADMIN,
    });
    auth = (await loginAs(app, user.username)).authHeader;
    const org = await prisma.organization.create({
      data: { name: '退役审计历史', nodeTypeCode: 'retired-audit-team' },
    });
    const member = await prisma.member.create({
      data: {
        memberNo: 'retired-audit-history',
        ...memberIdentityData('退役审计历史队员'),
        gradeCode: 'level-2',
      },
    });
    memberId = member.id;
    const activity = await prisma.activity.create({
      data: {
        title: '退役写入不可改写历史',
        activityTypeCode: 'retired-audit-type',
        organizationId: org.id,
        startAt: START,
        endAt: END,
        location: '深圳',
        statusCode: 'published',
      },
    });
    activityId = activity.id;
    const sheet = await prisma.attendanceSheet.create({
      data: { activityId, submitterUserId: user.id, statusCode: 'pending', version: 1 },
    });
    sheetId = sheet.id;
    for (let index = 0; index < 3; index += 1) {
      await prisma.attendanceRecord.create({
        data: {
          sheetId,
          memberId,
          roleCode: 'member',
          attendanceStatusCode: 'present',
          checkInAt: new Date(START.getTime() + index * 6 * 3600_000),
          checkOutAt: new Date(END.getTime() + index * 6 * 3600_000),
          serviceHours: 4,
          contributionPoints: 1,
        },
      });
    }
    const seal = await prisma.evidenceSeal.create({
      data: {
        activityId,
        sealRevision: 1,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        allWindowsClosedAt: END,
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: 0,
        populationCountBySession: {},
        contentHash: 'retired-audit-seal',
        statusCode: 'active',
        sealedByUserId: user.id,
        sealedAt: END,
      },
    });
    const run = await prisma.attendanceSettlementRun.create({
      data: { activityId, statusCode: 'drafting', currentDraftVersion: 1 },
    });
    const version = await prisma.attendanceSettlementVersion.create({
      data: {
        settlementRunId: run.id,
        version: 1,
        evidenceSealId: seal.id,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        personCount: 0,
        sessionParticipationCount: 0,
        serviceSegmentCount: 0,
        contentHash: 'retired-audit-native-draft',
        statusCode: 'draft',
        createdByUserId: user.id,
      },
    });
    nativeVersionId = version.id;
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    if (app) await app.close();
  });

  async function snapshot() {
    return {
      activity: await prisma.activity.findUniqueOrThrow({ where: { id: activityId } }),
      sheet: await prisma.attendanceSheet.findUniqueOrThrow({
        where: { id: sheetId },
        include: { records: { orderBy: { id: 'asc' } } },
      }),
      native: await prisma.attendanceSettlementRun.findUniqueOrThrow({
        where: { activityId },
        include: {
          versions: {
            orderBy: { version: 'asc' },
            include: { resultRevisions: { orderBy: { id: 'asc' } } },
          },
        },
      }),
      audit: await prisma.auditLog.findMany({ orderBy: { id: 'asc' } }),
      intents: await prisma.notificationOutboxIntent.findMany({ orderBy: { id: 'asc' } }),
      batches: await prisma.ledgerPostingBatch.findMany({ orderBy: { id: 'asc' } }),
    };
  }

  it.each(['submit', 'edit-records', 'edit-empty', 'delete', 'native-id'] as const)(
    '%s 不恢复旧写入，不产生审计或改写历史',
    async (operation) => {
      const before = await snapshot();
      expect(before.sheet.records).toHaveLength(3);
      const audit = jest.spyOn(app.get(AuditLogsService), 'log');
      const record = {
        memberId,
        roleCode: 'member',
        attendanceStatusCode: 'present',
        checkInAt: START.toISOString(),
        checkOutAt: END.toISOString(),
      };
      if (operation === 'submit') {
        await request(httpServer(app))
          .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
          .set('Authorization', auth)
          .send({ records: [record] })
          .expect(404);
      } else if (operation === 'edit-records' || operation === 'edit-empty') {
        await request(httpServer(app))
          .patch(`/api/admin/v1/attendance-sheets/${sheetId}`)
          .set('Authorization', auth)
          .send(operation === 'edit-records' ? { records: [record] } : {})
          .expect(404);
      } else {
        await request(httpServer(app))
          .delete(
            `/api/admin/v1/attendance-sheets/${operation === 'native-id' ? nativeVersionId : sheetId}`,
          )
          .set('Authorization', auth)
          .expect(404);
      }
      expect(audit).not.toHaveBeenCalled();
      await expect(snapshot()).resolves.toEqual(before);
    },
  );
});
