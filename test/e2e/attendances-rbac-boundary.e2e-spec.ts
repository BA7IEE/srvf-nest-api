import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { seedParticipationReadState } from '../fixtures/contribution-ledger.fixture';
import { RETIRED_ATTENDANCE_ROUTES } from '../fixtures/retired-attendance-contract';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 保留原四类主体矩阵：SA、ADMIN+biz-admin、无绑定 ADMIN、USER。
// 旧建单/编辑/删除验证退役后的全角色拒绝及事实不变；读取和两级审核迁到原生接口。
// 原 reject 的相关能力是新版 return，不把旧 Sheet ID/动作码当成新版别名。
describe('退役后结算与账本 RBAC 边界', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let saAuth: string;
  let finalSaAuth: string;
  let admBizAuth: string;
  let admDefaultAuth: string;
  let userAuth: string;
  let saUserId: string;
  let creatorUserId: string;
  let organizationId: string;
  let memberId: string;
  let sequence = 0;
  const previousWorkflowGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  const startAt = new Date('2020-03-01T01:00:00.000Z');
  const endAt = new Date('2020-03-01T05:00:00.000Z');
  const reviewBase = '/api/admin/v1/attendance-settlements';

  async function createActivity() {
    return prisma.activity.create({
      data: {
        title: `ATRB native ${++sequence}`,
        activityTypeCode: 'atrb-type',
        organizationId,
        startAt,
        endAt,
        location: '边界演示',
        statusCode: 'published',
      },
    });
  }

  // 已提交的空人口输入，与原生审核 HTTP / scoped-authz 套件一致；
  // 一审、终审与退回都调用真实 HTTP，不伪造审核结果或修改不可变提交人。
  async function createSubmittedSettlement(createdByUserId = creatorUserId) {
    const activity = await createActivity();
    const seal = await prisma.evidenceSeal.create({
      data: {
        activityId: activity.id,
        sealRevision: 1,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        allWindowsClosedAt: endAt,
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: 0,
        populationCountBySession: {},
        contentHash: `atrb-seal-${activity.id}`,
        statusCode: 'active',
        sealedByUserId: createdByUserId,
        sealedAt: endAt,
      },
    });
    const run = await prisma.attendanceSettlementRun.create({
      data: {
        activityId: activity.id,
        statusCode: 'pending_first_review',
        currentSubmittedVersion: 1,
      },
    });
    const version = await prisma.attendanceSettlementVersion.create({
      data: {
        settlementRunId: run.id,
        version: 1,
        evidenceSealId: seal.id,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: `atrb-version-${activity.id}`,
        personCount: 0,
        sessionParticipationCount: 0,
        serviceSegmentCount: 0,
        createdByUserId,
        submittedAt: endAt,
        statusCode: 'submitted',
        operationKey: `atrb-submit-${activity.id}`,
        requestHash: `atrb-submit-hash-${activity.id}`,
      },
    });
    return {
      activityId: activity.id,
      versionId: version.id,
      expectation: {
        evidenceSealId: seal.id,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: version.contentHash,
      },
    };
  }

  async function reviewState(versionId: string) {
    const version = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    return {
      version,
      run: await prisma.attendanceSettlementRun.findUniqueOrThrow({
        where: { id: version.settlementRunId },
      }),
      actions: await prisma.settlementReviewAction.findMany({
        where: { settlementVersionId: versionId },
        orderBy: { id: 'asc' },
      }),
      batches: await prisma.ledgerPostingBatch.findMany({
        where: { settlementVersionId: versionId },
        orderBy: { id: 'asc' },
      }),
      auditCount: await prisma.auditLog.count(),
      intentCount: await prisma.notificationOutboxIntent.count(),
    };
  }

  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    const sa = await createTestUser(app, { username: 'atrb-su', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'atrb-final-su', role: Role.SUPER_ADMIN });
    const biz = await createTestUser(app, { username: 'atrb-biz', role: Role.ADMIN });
    await createTestUser(app, { username: 'atrb-default', role: Role.ADMIN });
    await createTestUser(app, { username: 'atrb-user', role: Role.USER });
    const creator = await createTestUser(app, { username: 'atrb-creator', role: Role.USER });
    saUserId = sa.id;
    creatorUserId = creator.id;
    const seed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, biz.id, seed.bizAdminRoleId, {
      includeLegacyActivityActions: false,
    });
    saAuth = (await loginAs(app, sa.username)).authHeader;
    finalSaAuth = (await loginAs(app, 'atrb-final-su')).authHeader;
    admBizAuth = (await loginAs(app, biz.username)).authHeader;
    admDefaultAuth = (await loginAs(app, 'atrb-default')).authHeader;
    userAuth = (await loginAs(app, 'atrb-user')).authHeader;
    const organization = await prisma.organization.create({
      data: { name: 'ATRB root', nodeTypeCode: 'atrb-root' },
    });
    organizationId = organization.id;
    const member = await prisma.member.create({
      data: { memberNo: 'atrb-member', ...memberIdentityData('ATRB 队员') },
    });
    memberId = member.id;
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (previousWorkflowGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousWorkflowGate;
    }
  });

  it('旧建单/编辑/删除及审核不能由任一角色复活，也不改变已有记录', async () => {
    const activity = await createActivity();
    const sheet = await prisma.attendanceSheet.create({
      data: { activityId: activity.id, submitterUserId: creatorUserId, statusCode: 'pending' },
    });
    const auditCount = await prisma.auditLog.count();
    const intentCount = await prisma.notificationOutboxIntent.count();
    const sheetCount = await prisma.attendanceSheet.count();
    const recordCount = await prisma.attendanceRecord.count();
    const routes = RETIRED_ATTENDANCE_ROUTES.filter(
      ([method, path]) => method !== 'get' && path.startsWith('/api/admin/'),
    );
    for (const auth of [saAuth, admBizAuth, admDefaultAuth, userAuth]) {
      for (const [method, path] of routes) {
        await request(httpServer(app))
          [method](path.replace('{activityId}', activity.id).replace('{id}', sheet.id))
          .set('Authorization', auth)
          .send({})
          .expect(404);
      }
    }
    await expect(
      prisma.attendanceSheet.findUniqueOrThrow({ where: { id: sheet.id } }),
    ).resolves.toEqual(sheet);
    expect(await prisma.attendanceSheet.count()).toBe(sheetCount);
    expect(await prisma.attendanceRecord.count()).toBe(recordCount);
    expect(await prisma.auditLog.count()).toBe(auditCount);
    expect(await prisma.notificationOutboxIntent.count()).toBe(intentCount);
  });

  it('结算列表与审核详情：SA/biz-admin 可读，裸 ADMIN/USER 不可读', async () => {
    const fixture = await createSubmittedSettlement();
    for (const path of [reviewBase, `${reviewBase}/${fixture.versionId}/review-detail`]) {
      for (const auth of [saAuth, admBizAuth]) {
        const response = await request(httpServer(app)).get(path).set('Authorization', auth);
        expect(response.status).toBe(200);
        if (path.includes('review-detail')) {
          expect(response.body.data.version.id).toBe(fixture.versionId);
        } else {
          expect(response.body.data.total).toBe(1);
          expect(response.body.data.items).toEqual([
            expect.objectContaining({ settlementVersionId: fixture.versionId }),
          ]);
        }
      }
      for (const auth of [admDefaultAuth, userAuth]) {
        expectBizError(
          await request(httpServer(app)).get(path).set('Authorization', auth),
          BizCode.RBAC_FORBIDDEN,
        );
      }
    }
  });

  it('活动/队员账本：保留四主体读权限，未 committed 输入不可见', async () => {
    const activity = await createActivity();
    const pending = await createActivity();
    for (const [activityId, batchStatus] of [
      [activity.id, 'committed'],
      [pending.id, 'preparing'],
    ] as const) {
      await seedParticipationReadState(prisma, {
        activityId,
        actorUserId: creatorUserId,
        batchStatus,
        participants: [
          {
            memberId,
            resultCode: 'present',
            serviceHours: '1',
            creditedPoints: '1',
          },
        ],
      });
    }
    for (const path of [
      `/api/admin/v1/activities/${activity.id}/participation-ledger`,
      `/api/admin/v1/members/${memberId}/participation-ledger`,
    ]) {
      for (const auth of [saAuth, admBizAuth]) {
        const response = await request(httpServer(app)).get(path).set('Authorization', auth);
        expect(response.status).toBe(200);
        expect(response.body.data.total).toBe(2);
        expect(response.body.data.items).toEqual([
          expect.objectContaining({ activityId: activity.id, memberId }),
          expect.objectContaining({ activityId: activity.id, memberId }),
        ]);
      }
      for (const auth of [admDefaultAuth, userAuth]) {
        expectBizError(
          await request(httpServer(app)).get(path).set('Authorization', auth),
          BizCode.RBAC_FORBIDDEN,
        );
      }
    }
  });

  it.each([
    ['first', 'approve', 'pending_final_review'],
    ['first', 'return', 'drafting'],
    ['final', 'approve', 'posting'],
    ['final', 'return', 'drafting'],
  ] as const)('%s-%s：三类普通主体零写，独立 SA 通过', async (stage, action, statusCode) => {
    const fixture = await createSubmittedSettlement();
    if (stage === 'final') {
      await request(httpServer(app))
        .post(`${reviewBase}/${fixture.versionId}/first-approve`)
        .set('Authorization', saAuth)
        .send({ operationKey: `first-${fixture.versionId}`, ...fixture.expectation })
        .expect(200);
    }
    const before = await reviewState(fixture.versionId);
    const payload = {
      operationKey: `${stage}-${action}-${fixture.versionId}`,
      ...fixture.expectation,
      ...(action === 'return' ? { note: '补充现场证据' } : {}),
    };
    const path = `${reviewBase}/${fixture.versionId}/${stage}-${action}`;
    for (const auth of [admBizAuth, admDefaultAuth, userAuth]) {
      expectBizError(
        await request(httpServer(app)).post(path).set('Authorization', auth).send(payload),
        BizCode.RBAC_FORBIDDEN,
      );
      expect(await reviewState(fixture.versionId)).toEqual(before);
    }
    const response = await request(httpServer(app))
      .post(path)
      .set('Authorization', stage === 'first' ? saAuth : finalSaAuth)
      .send(payload);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      stageCode: stage,
      actionCode: action,
      runStatusAfter: statusCode,
    });
    const after = await reviewState(fixture.versionId);
    expect(after.run.statusCode).toBe(statusCode);
    expect(after.actions).toHaveLength(before.actions.length + 1);
    expect(after.actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ stageCode: stage, actionCode: action })]),
    );
    expect(after.version.statusCode).toBe(
      action === 'return' ? 'returned' : stage === 'final' ? 'approved' : 'submitted',
    );
    expect(after.batches).toHaveLength(stage === 'final' && action === 'approve' ? 1 : 0);
    expect(after.auditCount).toBeGreaterThan(before.auditCount);
  });

  it('SA 不能自审，拒绝不产生状态、审核、批次、审计或通知变化', async () => {
    const fixture = await createSubmittedSettlement(saUserId);
    const before = await reviewState(fixture.versionId);
    expectBizError(
      await request(httpServer(app))
        .post(`${reviewBase}/${fixture.versionId}/first-approve`)
        .set('Authorization', saAuth)
        .send({ operationKey: `self-${fixture.versionId}`, ...fixture.expectation }),
      BizCode.SETTLEMENT_SELF_FIRST_REVIEW_FORBIDDEN,
    );
    expect(await reviewState(fixture.versionId)).toEqual(before);
  });

  it('SA 不能兼任两级审核，已有一审事实整行保留', async () => {
    const fixture = await createSubmittedSettlement();
    await request(httpServer(app))
      .post(`${reviewBase}/${fixture.versionId}/first-approve`)
      .set('Authorization', saAuth)
      .send({ operationKey: `first-${fixture.versionId}`, ...fixture.expectation })
      .expect(200);
    const before = await reviewState(fixture.versionId);
    expectBizError(
      await request(httpServer(app))
        .post(`${reviewBase}/${fixture.versionId}/final-approve`)
        .set('Authorization', saAuth)
        .send({ operationKey: `same-${fixture.versionId}`, ...fixture.expectation }),
      BizCode.SETTLEMENT_SAME_REVIEWER_FORBIDDEN,
    );
    expect(await reviewState(fixture.versionId)).toEqual(before);
  });
});
