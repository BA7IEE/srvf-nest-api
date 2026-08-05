import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role, UserStatus } from '@prisma/client';
import request from 'supertest';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// ===== 第 2 批第 ⑧b 刀:HTTP 判权与三方隔离 =====
//
// 本 spec 的成功/拒绝都从 HTTP 打入。它不复制 ⑧a 的完整 worker 闭环，只钉两件 ⑧b
// 新增的边界：端点 action 码拒绝、以及第四刀的锁后人员隔离确实穿过 Controller 生效。

const PAST_START = new Date('2020-03-01T01:00:00.000Z');
const PAST_END = new Date('2020-03-01T05:00:00.000Z');
const SEALED_AT = new Date('2020-03-01T09:00:00.000Z');

interface HttpActor extends CurrentUserPayload {
  authHeader: string;
}

interface SubmittedFixture {
  activityId: string;
  settlementVersionId: string;
  expectation: {
    evidenceSealId: string;
    evidenceRevision: number;
    populationRevision: number;
    workflowRevision: number;
    contentHash: string;
  };
}

describe('第 2 批第 ⑧b 刀 —— 结算 HTTP 判权与人员隔离', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let organizationId: string;
  let sequence = 0;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    const organization = await prisma.organization.create({
      data: { name: '第 ⑧b 刀 HTTP 边界组织', nodeTypeCode: 'activity-batch2-8b-http-team' },
      select: { id: true },
    });
    organizationId = organization.id;
  });

  afterAll(async () => {
    await app.close();
  });

  async function createActor(
    label: string,
    role: Role,
    withActiveMember = false,
  ): Promise<HttpActor> {
    sequence += 1;
    const username = `batch2-8b-${label}-${sequence}`;
    const user = await createTestUser(app, { username, role });
    let memberId: string | null = null;
    if (withActiveMember) {
      const member = await prisma.member.create({
        data: {
          memberNo: `${username}-member`,
          displayName: `${username} 队员`,
          gradeCode: 'level-2',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      });
      memberId = member.id;
      await prisma.user.update({ where: { id: user.id }, data: { memberId } });
    }
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      status: UserStatus.ACTIVE,
      memberId,
      authHeader: (await loginAs(app, username)).authHeader,
    };
  }

  async function createSubmittedFixture(submittedByUserId: string): Promise<SubmittedFixture> {
    sequence += 1;
    const tag = `batch2-8b-http-${sequence}`;
    const activity = await prisma.activity.create({
      data: {
        title: `第 ⑧b 刀 HTTP 活动 ${sequence}`,
        activityTypeCode: `${tag}-type`,
        organizationId,
        startAt: PAST_START,
        endAt: PAST_END,
        location: '深圳',
        statusCode: 'published',
      },
      select: { id: true },
    });
    const seal = await prisma.evidenceSeal.create({
      data: {
        activityId: activity.id,
        sealRevision: 1,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        allWindowsClosedAt: SEALED_AT,
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: 0,
        populationCountBySession: {},
        contentHash: `${tag}-seal-hash`,
        statusCode: 'active',
        sealedByUserId: submittedByUserId,
        sealedAt: SEALED_AT,
      },
      select: { id: true },
    });
    const run = await prisma.attendanceSettlementRun.create({
      data: {
        activityId: activity.id,
        statusCode: 'pending_first_review',
        currentSubmittedVersion: 1,
      },
      select: { id: true },
    });
    const version = await prisma.attendanceSettlementVersion.create({
      data: {
        settlementRunId: run.id,
        version: 1,
        evidenceSealId: seal.id,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: `${tag}-content-hash`,
        personCount: 0,
        sessionParticipationCount: 0,
        serviceSegmentCount: 0,
        createdByUserId: submittedByUserId,
        submittedAt: SEALED_AT,
        statusCode: 'submitted',
        operationKey: `${tag}-submit`,
        requestHash: `${tag}-submit-hash`,
      },
      select: { id: true, contentHash: true },
    });
    return {
      activityId: activity.id,
      settlementVersionId: version.id,
      expectation: {
        evidenceSealId: seal.id,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: version.contentHash,
      },
    };
  }

  it('无新 action 码的已关联队员在 App 与 Admin 端点均得到统一 RBAC 拒绝', async () => {
    const noPermission = await createActor('no-permission', Role.USER, true);
    const fixture = await createSubmittedFixture(noPermission.id);

    const generate = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${fixture.activityId}/settlement/generate`)
      .set('Authorization', noPermission.authHeader)
      .send({ operationKey: 'no-permission-generate' });
    expectBizError(generate, BizCode.RBAC_FORBIDDEN);

    const review = await request(httpServer(app))
      .post(`/api/admin/v1/attendance-settlements/${fixture.settlementVersionId}/first-approve`)
      .set('Authorization', noPermission.authHeader)
      .send({ operationKey: 'no-permission-review', ...fixture.expectation });
    expectBizError(review, BizCode.RBAC_FORBIDDEN);
  });

  it('提交人 / 一审人 / 终审人三方分离在 Admin HTTP 动作上均由锁后复判挡住', async () => {
    const submitter = await createActor('submitter', Role.SUPER_ADMIN);
    const firstReviewer = await createActor('first-reviewer', Role.SUPER_ADMIN);
    const finalReviewer = await createActor('final-reviewer', Role.SUPER_ADMIN);
    const fixture = await createSubmittedFixture(submitter.id);

    const selfFirst = await request(httpServer(app))
      .post(`/api/admin/v1/attendance-settlements/${fixture.settlementVersionId}/first-approve`)
      .set('Authorization', submitter.authHeader)
      .send({ operationKey: 'self-first-review', ...fixture.expectation });
    expectBizError(selfFirst, BizCode.SETTLEMENT_SELF_FIRST_REVIEW_FORBIDDEN);

    const firstApproved = await request(httpServer(app))
      .post(`/api/admin/v1/attendance-settlements/${fixture.settlementVersionId}/first-approve`)
      .set('Authorization', firstReviewer.authHeader)
      .send({ operationKey: 'separated-first-review', ...fixture.expectation });
    expect(firstApproved.status).toBe(200);
    expect(firstApproved.body.data).toMatchObject({
      stageCode: 'first',
      actionCode: 'approve',
      runStatusAfter: 'pending_final_review',
    });

    const selfFinal = await request(httpServer(app))
      .post(`/api/admin/v1/attendance-settlements/${fixture.settlementVersionId}/final-approve`)
      .set('Authorization', submitter.authHeader)
      .send({ operationKey: 'self-final-review', ...fixture.expectation });
    expectBizError(selfFinal, BizCode.SETTLEMENT_SELF_FINAL_REVIEW_FORBIDDEN);

    const sameReviewer = await request(httpServer(app))
      .post(`/api/admin/v1/attendance-settlements/${fixture.settlementVersionId}/final-approve`)
      .set('Authorization', firstReviewer.authHeader)
      .send({ operationKey: 'same-reviewer-final', ...fixture.expectation });
    expectBizError(sameReviewer, BizCode.SETTLEMENT_SAME_REVIEWER_FORBIDDEN);

    const finalApproved = await request(httpServer(app))
      .post(`/api/admin/v1/attendance-settlements/${fixture.settlementVersionId}/final-approve`)
      .set('Authorization', finalReviewer.authHeader)
      .send({ operationKey: 'separated-final-review', ...fixture.expectation });
    expect(finalApproved.status).toBe(200);
    expect(finalApproved.body.data).toMatchObject({
      stageCode: 'final',
      actionCode: 'approve',
      ledgerPostingBatchId: expect.any(String),
      ledgerPostingBatchStatus: 'preparing',
    });
  });
});
