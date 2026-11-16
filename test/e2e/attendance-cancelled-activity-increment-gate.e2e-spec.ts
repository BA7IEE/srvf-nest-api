import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import request from 'supertest';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { SettlementDraftService } from '../../src/modules/activities/settlement-draft.service';
import { SettlementReviewService } from '../../src/modules/activities/settlement-review.service';
import { SettlementSubmitService } from '../../src/modules/activities/settlement-submit.service';
import { createTestUser } from '../fixtures/users.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { createSettlementDraftFixture } from '../helpers/settlement-draft.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// A-R2「放行存量、掐断增量」迁入唯一的结算真相链。
// 仍用真实 PG 的三个独立用户；不恢复旧服务，不把审核/重放/原事实重提一并封死。
// 此文件验证状态闸；并发写的共同 Activity 根锁另有并发验收。
const META = { requestId: 'cancelled-settlement-increment', ip: null, ua: 'jest' };
type Fixture = Awaited<ReturnType<typeof createSettlementDraftFixture>>;

describe('已取消活动的结算增量闸(A-R2 · 方案乙)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let drafts: SettlementDraftService;
  let submissions: SettlementSubmitService;
  let reviews: SettlementReviewService;
  let submitter: CurrentUserPayload;
  let reviewer: CurrentUserPayload;
  let finalReviewer: CurrentUserPayload;
  let organizationId: string;
  let ownerMemberId: string;
  let participantMemberId: string;
  let submitterAuth: string;
  const cancelled: Fixture[] = [];
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    drafts = app.get(SettlementDraftService);
    submissions = app.get(SettlementSubmitService);
    reviews = app.get(SettlementReviewService);
    const actor = async (username: string): Promise<CurrentUserPayload> => {
      const row = await createTestUser(app, { username, role: Role.SUPER_ADMIN });
      return {
        id: row.id,
        username,
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
        memberId: null,
      };
    };
    submitter = await actor('cancelled-settlement-submitter');
    reviewer = await actor('cancelled-settlement-first');
    finalReviewer = await actor('cancelled-settlement-final');
    organizationId = (
      await prisma.organization.create({
        data: { name: '取消闸组织', nodeTypeCode: 'cancelled-settlement-node' },
      })
    ).id;
    const member = async (memberNo: string) =>
      (
        await prisma.member.create({
          data: {
            memberNo,
            ...memberIdentityData(memberNo),
            status: 'ACTIVE',
            gradeCode: 'level-2',
          },
        })
      ).id;
    ownerMemberId = await member('cancelled-settlement-owner');
    participantMemberId = await member('cancelled-settlement-participant');
    await prisma.user.update({
      where: { id: submitter.id },
      data: { memberId: ownerMemberId },
    });
    submitter.memberId = ownerMemberId;
    submitterAuth = (await loginAs(app, submitter.username)).authHeader;
  });

  afterAll(async () => {
    if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    await app?.close();
  });

  function fixture() {
    return createSettlementDraftFixture(prisma, {
      organizationId,
      ownerMemberId,
      participantMemberIds: [participantMemberId],
      actorUserId: submitter.id,
      activityTypeCode: 'cancelled-settlement-type',
    });
  }

  async function cancel(f: Fixture) {
    // 与原验收一样，直接置状态以隔离结算侧守卫，不用活动取消编排代替被测条件。
    await prisma.activity.update({
      where: { id: f.activityId },
      data: { statusCode: 'cancelled' },
    });
    cancelled.push(f);
  }

  function submit(f: Fixture, key = 'initial') {
    return submissions.submit(
      {
        activityId: f.activityId,
        operationKey: `${key}-${f.activityId}`,
        requestHash: `${key}-hash-${f.activityId}`,
        expectedDraftVersion: 1,
        expectedEvidenceSealId: f.sealId,
      },
      submitter,
      META,
    );
  }

  function update(f: Fixture) {
    return drafts.updateItem(
      {
        activityId: f.activityId,
        participationIdentityId: f.identityId,
        expectedDraftVersion: 1,
        resultCode: 'present',
        recognizedServiceHours: 3,
        recognizedContributionPoints: 0,
        reason: '人工调整',
      },
      submitter,
      META,
    );
  }

  async function review(
    f: Fixture,
    versionId: string,
    stage: 'first' | 'final',
    action: 'approve' | 'return',
  ) {
    const version = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    const input = {
      activityId: f.activityId,
      actionCode: action,
      operationKey: `${stage}-${action}-${versionId}`,
      requestHash: `${stage}-${action}-hash`,
      returnReason: action === 'return' ? '复核原有事实' : undefined,
      expectedSettlementVersionId: versionId,
      expectation: {
        evidenceSealId: version.evidenceSealId,
        evidenceRevision: version.evidenceRevision,
        populationRevision: version.populationRevision,
        workflowRevision: version.workflowRevision,
        contentHash: version.contentHash,
      },
    };
    return stage === 'first'
      ? reviews.firstReview(input, reviewer, META)
      : reviews.finalReview(input, finalReviewer, META);
  }

  async function snapshot(f: Fixture) {
    return {
      run: await prisma.attendanceSettlementRun.findUnique({ where: { id: f.runId } }),
      versions: await prisma.attendanceSettlementVersion.findMany({
        where: { settlementRunId: f.runId },
        orderBy: { version: 'asc' },
        include: { resultRevisions: { orderBy: { id: 'asc' } } },
      }),
      audits: await prisma.auditLog.count({ where: { resourceId: f.activityId } }),
      intents: await prisma.notificationOutboxIntent.count({
        where: { aggregateId: f.activityId },
      }),
    };
  }

  it('放行存量：取消前提交的不可变版本仍可初审、终审，原认定保留', async () => {
    const f = await fixture();
    const submitted = await submit(f);
    const rows = await prisma.participantSettlementResultRevision.findMany({
      where: { settlementVersionId: submitted.settlementVersionId },
    });
    await cancel(f);
    await review(f, submitted.settlementVersionId, 'first', 'approve');
    const approved = await review(f, submitted.settlementVersionId, 'final', 'approve');
    expect(approved.versionStatusAfter).toBe('approved');
    expect(approved.ledgerPostingBatchStatus).toBe('preparing');
    expect(rows).toHaveLength(1);
    expect(
      await prisma.participantSettlementResultRevision.findMany({
        where: { settlementVersionId: submitted.settlementVersionId },
      }),
    ).toEqual(rows);
  });

  it('掐断增量①：取消后首次提交拒绝，版本、指针、审计、通知均不写', async () => {
    const f = await fixture();
    await cancel(f);
    const before = await snapshot(f);
    await expect(submit(f)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN,
    });
    expect(await snapshot(f)).toEqual(before);
  });

  it('掐断增量②：取消后不能改写可编辑草稿，原版本与认定整体保留', async () => {
    const f = await fixture();
    const submitted = await submit(f);
    await review(f, submitted.settlementVersionId, 'first', 'return');
    await cancel(f);
    const before = await snapshot(f);
    await expect(update(f)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN,
    });
    expect(await snapshot(f)).toEqual(before);
  });

  it('掐断生成旁路：取消后不能重建草稿或服务段', async () => {
    const f = await fixture();
    await cancel(f);
    const before = await snapshot(f);
    await expect(drafts.generate(f.activityId, submitter, META)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN,
    });
    expect(await snapshot(f)).toEqual(before);
    expect(
      await prisma.participantServiceSegmentRevision.count({
        where: { participationIdentityId: f.identityId },
      }),
    ).toBe(0);
  });

  it('不扩大闸范围：completed 活动仍可认定已有草稿', async () => {
    const f = await fixture();
    await prisma.activity.update({
      where: { id: f.activityId },
      data: { statusCode: 'completed' },
    });
    await update(f);
    const row = await prisma.participantSettlementResultRevision.findFirstOrThrow({
      where: { settlementVersionId: f.draftId },
    });
    expect(row.recognizedServiceHours.toString()).toBe('3');
    expect(row.revision).toBe(1);
  });

  it('取消后同键提交仍可精确重放，不复制版本或通知意图', async () => {
    const f = await fixture();
    const original = await submit(f);
    await cancel(f);
    const before = await snapshot(f);
    expect(await submit(f)).toMatchObject({
      settlementVersionId: original.settlementVersionId,
      replayed: true,
    });
    const after = await snapshot(f);
    expect(after.versions).toEqual(before.versions);
    expect(after.run).toEqual(before.run);
    expect(after.intents).toBe(before.intents);
    expect(after.audits).toBe(before.audits + 1);
  });

  it('放行已有退回版本的原事实重提，不强迫修改已取消活动', async () => {
    const f = await fixture();
    const original = await submit(f);
    await review(f, original.settlementVersionId, 'first', 'return');
    await cancel(f);
    const resubmitted = await submit(f, 'resubmit');
    const version = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: resubmitted.settlementVersionId },
      include: { resultRevisions: true },
    });
    expect(version.priorVersionId).toBe(original.settlementVersionId);
    expect(version.statusCode).toBe('submitted');
    expect(version.resultRevisions).toHaveLength(1);
    expect(version.resultRevisions[0].recognizedServiceHours.toString()).toBe('2');
  });

  it('真实 App HTTP 将取消守卫映射为 20122/409，不返回数据或留下写入', async () => {
    const f = await fixture();
    await cancel(f);
    const before = await snapshot(f);
    const base = `/api/app/v1/my/managed-activities/${f.activityId}/settlement`;
    const generated = await request(httpServer(app))
      .post(`${base}/generate`)
      .set('Authorization', submitterAuth)
      .send({ operationKey: `generate-${f.activityId}` });
    expectBizError(generated, BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN);
    const edited = await request(httpServer(app))
      .patch(`${base}/items/${f.identityId}`)
      .set('Authorization', submitterAuth)
      .send({
        expectedDraftVersion: 1,
        resultCode: 'present',
        recognizedServiceHours: 3,
        recognizedContributionPoints: 0,
        reason: '已取消不应再改写',
      });
    expectBizError(edited, BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN);
    const submitted = await request(httpServer(app))
      .post(`${base}/submit`)
      .set('Authorization', submitterAuth)
      .send({
        operationKey: `submit-${f.activityId}`,
        expectedDraftVersion: 1,
        evidenceSealId: f.sealId,
        confirmation: true,
      });
    expectBizError(submitted, BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN);
    expect(await snapshot(f)).toEqual(before);
  });

  it('全库巡检：所有已取消活动的人口与认定均未增长', async () => {
    expect(cancelled.length).toBeGreaterThan(0);
    for (const f of cancelled) {
      const rows = await prisma.participantSettlementResultRevision.findMany({
        where: { settlementVersion: { settlementRunId: f.runId } },
      });
      expect(rows.length).toBeGreaterThan(0);
      expect([...new Set(rows.map((row) => row.participationIdentityId))]).toEqual([f.identityId]);
      for (const row of rows) {
        expect(row.recognizedServiceHours.toString()).toBe('2');
        expect(row.recognizedContributionPoints.toString()).toBe('0');
      }
    }
  });
});
