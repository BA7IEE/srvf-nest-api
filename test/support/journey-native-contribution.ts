import { Role } from '@prisma/client';
import request from 'supertest';

import { ActivityBatchWorker } from '../../src/modules/activities/activity-batch.worker';
import { LedgerReadyBatchCommitter } from '../../src/modules/activities/ledger-ready-batch-committer.service';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { journeyPrisma, type JourneyRuntime } from './journey-runtime';

interface HistoricalSession {
  startAt: string;
  endAt: string;
  expectedPoints: number;
}

function requireStatus(response: request.Response, status: number, action: string): void {
  if (response.status !== status) {
    throw new Error(`${action}: HTTP ${response.status}, code=${response.body?.code}`);
  }
}

/**
 * 历史活动补录的真实生产链：专业活动创建/发布 → 现场参加 → CSV 预览/执行及 worker →
 * 证据封场 → 草稿/提交 → 两个独立审核人 → worker 准备及其统一提交原语。
 * 只把身份、组织和规则作为 ambient；不直插发布快照、参与身份、事件、结算或账本事实。
 */
export async function produceJourneyNativeContribution(
  runtime: JourneyRuntime,
  input: {
    organizationId: string;
    activityTypeCode: string;
    memberId: string;
    sessions: HistoricalSession[];
    firstAuth: string;
    finalAuth: string;
  },
): Promise<void> {
  const prisma = journeyPrisma(runtime);
  const server = httpServer(runtime.app);
  const worker = runtime.app.get(ActivityBatchWorker);

  await seedActivityResponsibilitySystemRoles(runtime.app);
  const ownerUser = await createTestUser(runtime.app, {
    username: 'journey-contribution-owner',
    role: Role.SUPER_ADMIN,
  });
  // journey-direct-write: ambient — 有效负责人身份与任职是补录动作的权限前置。
  const owner = await prisma.member.create({
    data: {
      memberNo: 'JOURNEY-CONTRIBUTION-OWNER',
      ...memberIdentityData('旅程贡献负责人'),
      gradeCode: 'level-1',
    },
  });
  // journey-direct-write: ambient — 同上。
  await prisma.user.update({ where: { id: ownerUser.id }, data: { memberId: owner.id } });
  // journey-direct-write: ambient — 同上。
  await prisma.memberOrganizationMembership.create({
    data: { memberId: owner.id, organizationId: input.organizationId },
  });
  const ownerAuth = (await loginAs(runtime.app, ownerUser.username)).authHeader;
  const created = await request(server)
    .post('/api/app/v1/my/managed-activities/professional')
    .set('Authorization', ownerAuth)
    .send({
      operationKey: 'journey-contribution-create',
      title: '旅程一贡献前置活动',
      organizationId: input.organizationId,
      activityTypeCode: input.activityTypeCode,
      startAt: input.sessions[0].startAt,
      endAt: new Date(Date.now() + 3_600_000).toISOString(),
      location: '旅程历史活动',
      allocationModeCode: 'first_come',
      metricSelection: { metricRequirementCode: 'not_required', metricSetPointer: null },
      isPublicRegistration: true,
      requiresInsurance: false,
      capacity: 10,
      sessions: input.sessions.map((window, index) => ({
        session: {
          code: `journey-contribution-${index}`,
          name: `历史场次 ${index + 1}`,
          startAt: window.startAt,
          endAt: window.endAt,
          locationText: '旅程历史活动',
          capacity: 10,
          checkInOpenAt: window.startAt,
          checkInCloseAt: window.endAt,
          checkOutOpenAt: window.startAt,
          checkOutCloseAt: window.endAt,
          locationRequired: false,
        },
        positions: [],
      })),
    });
  requireStatus(created, 201, '创建补录活动');
  const activityId = String(created.body.data.activity.activityId);
  const managed = `/api/app/v1/my/managed-activities/${activityId}`;
  const requested = await request(server)
    .post(`${managed}/publish-reviews`)
    .set('Authorization', ownerAuth)
    .send({ operationKey: 'journey-contribution-publish', confirmation: true });
  requireStatus(requested, 200, '提交发布审核');
  const published = await request(server)
    .post(`/api/admin/v1/activity-publish-reviews/${String(requested.body.data.id)}/approve`)
    .set('Authorization', runtime.adminAuth)
    .send({
      operationKey: 'journey-contribution-publish-approve',
      requiresInsuranceConfirmed: true,
    });
  requireStatus(published, 200, '发布补录活动及冻结规则');
  expect(published.body.data.status).toBe('approved');

  for (const [index, window] of input.sessions.entries()) {
    const session = await prisma.activitySession.findFirstOrThrow({
      where: { activityId, code: `journey-contribution-${index}` },
      select: { id: true },
    });
    const onsite = await request(server)
      .post(`${managed}/onsite-participations`)
      .set('Authorization', ownerAuth)
      .send({
        operationKey: `journey-onsite-${index}`,
        memberId: input.memberId,
        sessionId: session.id,
        reason: '补录已参加历史场次',
      });
    requireStatus(onsite, 201, '确认现场参加');
    expect(onsite.body.data.statusCode).toBe('pass');
    const identityId = String(onsite.body.data.participationIdentityId);

    for (const [actionCode, occurredAt] of [
      ['check_in', window.startAt],
      ['check_out', window.endAt],
    ] as const) {
      const key = `journey-import-${index}-${actionCode}`;
      const preview = await request(server)
        .post(`${managed}/onsite/sessions/${session.id}/import-previews`)
        .set('Authorization', ownerAuth)
        .field('operationKey', `${key}-preview`)
        .field('reason', '历史签到表补录')
        .attach(
          'file',
          Buffer.from(
            `participationIdentityId,actionCode,occurredAt,longitude,latitude,accuracy\n${identityId},${actionCode},${occurredAt},,,`,
            'utf8',
          ),
          { filename: `${key}.csv`, contentType: 'text/csv' },
        );
      requireStatus(preview, 201, '冻结导入预览');
      const previewId = String(preview.body.data.jobId);
      const summary = await request(server)
        .get(`${managed}/onsite/import-previews/${previewId}?page=1&pageSize=20`)
        .set('Authorization', ownerAuth);
      requireStatus(summary, 200, '读取冻结摘要');
      const executed = await request(server)
        .post(`${managed}/onsite/import-previews/${previewId}/execute`)
        .set('Authorization', ownerAuth)
        .send({
          operationKey: `${key}-execute`,
          fileDigest: summary.body.data.fileDigest,
          parserVersion: summary.body.data.parserVersion,
          previewHash: summary.body.data.previewHash,
        });
      requireStatus(executed, 201, '执行已确认导入');
      await worker.drainUntilIdle(10);
      expect(
        await prisma.activityBatchJob.findUniqueOrThrow({
          where: { id: String(executed.body.data.jobId) },
          select: { statusCode: true, succeeded: true, failed: true, skipped: true },
        }),
      ).toEqual({ statusCode: 'succeeded', succeeded: 1, failed: 0, skipped: 0 });
    }
  }
  expect(
    await prisma.attendancePunchEvent.count({
      where: { activityId, memberId: input.memberId },
    }),
  ).toBe(input.sessions.length * 2);

  // 补录结束后经真实变更审核收束活动时间，不直接改 endAt 或绕过“未结束不可送审”闸。
  const ending = await request(server)
    .post(`${managed}/submit-change-review`)
    .set('Authorization', ownerAuth)
    .send({ activity: { endAt: input.sessions[input.sessions.length - 1].endAt } });
  requireStatus(ending, 200, '提交活动结束时间变更');
  const ended = await request(server)
    .post(`/api/admin/v1/activity-publish-reviews/${String(ending.body.data.id)}/approve`)
    .set('Authorization', runtime.adminAuth)
    .send({
      operationKey: 'journey-contribution-end-approve',
      requiresInsuranceConfirmed: true,
    });
  requireStatus(ended, 200, '批准活动结束时间变更');

  const sealed = await request(server)
    .post(`${managed}/evidence-seals`)
    .set('Authorization', ownerAuth)
    .send();
  requireStatus(sealed, 200, '机器证据封场');
  const generated = await request(server)
    .post(`${managed}/settlement/generate`)
    .set('Authorization', ownerAuth)
    .send({ operationKey: 'journey-settlement-generate' });
  requireStatus(generated, 200, '生成原生结算草稿');
  expect(generated.body.data.outcome).toBe('draft');
  const draft = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
    where: { id: String(generated.body.data.settlementVersionId) },
  });
  const calculated = await prisma.participantSettlementResultRevision.findMany({
    where: { settlementVersionId: draft.id },
    select: { calculatedContributionPoints: true, calculatedServiceHours: true },
  });
  expect(calculated.map((row) => Number(row.calculatedContributionPoints)).sort()).toEqual(
    input.sessions.map((row) => row.expectedPoints).sort(),
  );
  const totalHours = input.sessions.reduce(
    (sum, row) => sum + (Date.parse(row.endAt) - Date.parse(row.startAt)) / 3_600_000,
    0,
  );
  expect(calculated.reduce((sum, row) => sum + Number(row.calculatedServiceHours), 0)).toBe(
    totalHours,
  );

  const submitted = await request(server)
    .post(`${managed}/settlement/submit`)
    .set('Authorization', ownerAuth)
    .send({
      operationKey: 'journey-settlement-submit',
      expectedDraftVersion: draft.version,
      evidenceSealId: draft.evidenceSealId,
      confirmation: true,
    });
  requireStatus(submitted, 200, '提交不可变结算版本');
  const version = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
    where: { id: String(submitted.body.data.settlementVersionId) },
  });
  for (const [stage, auth] of [
    ['first', input.firstAuth],
    ['final', input.finalAuth],
  ] as const) {
    const reviewed = await request(server)
      .post(`/api/admin/v1/attendance-settlements/${version.id}/${stage}-approve`)
      .set('Authorization', auth)
      .send({
        operationKey: `journey-settlement-${stage}`,
        evidenceSealId: version.evidenceSealId,
        evidenceRevision: version.evidenceRevision,
        populationRevision: version.populationRevision,
        workflowRevision: version.workflowRevision,
        contentHash: version.contentHash,
      });
    requireStatus(reviewed, 200, `${stage}结算审核`);
    expect(reviewed.body.data.runStatusAfter).toBe(
      stage === 'first' ? 'pending_final_review' : 'posting',
    );
    expect(reviewed.body.data.versionStatusAfter).toBe(
      stage === 'first' ? 'submitted' : 'approved',
    );
  }
  expect(await prisma.participationLedgerEntry.count({ where: { activityId } })).toBe(0);
  const reviews = await prisma.settlementReviewAction.findMany({
    where: { settlementVersionId: version.id, actionCode: 'approve' },
    select: { actorUserId: true },
  });
  expect(reviews).toHaveLength(2);
  expect(version.createdByUserId).toBe(ownerUser.id);
  expect(new Set([version.createdByUserId, ...reviews.map((row) => row.actorUserId)]).size).toBe(3);

  await worker.drainUntilIdle(10);
  const batch = await prisma.ledgerPostingBatch.findFirstOrThrow({
    where: { settlementVersionId: version.id },
    select: { id: true, statusCode: true },
  });
  expect(batch.statusCode).toBe('ready');
  // HTTP app 的 worker 只准备；直接调用真实 worker 同用的提交原语，不改 token/角色或批次状态。
  const committer = runtime.app.get(LedgerReadyBatchCommitter);
  expect((await committer.commitReadyBatch(batch.id)).batchStatus).toBe('committed');
  const entries = await prisma.participationLedgerEntry.findMany({
    where: { postingBatchId: batch.id, memberId: input.memberId },
  });
  expect(new Set(entries.map((row) => row.ledgerDate.toISOString().slice(0, 10))).size).toBe(2);
  expect(entries.reduce((sum, row) => sum + Number(row.creditedPointsDelta), 0)).toBe(
    input.sessions.reduce((sum, row) => sum + row.expectedPoints, 0),
  );
  expect(entries.reduce((sum, row) => sum + Number(row.serviceHoursDelta), 0)).toBe(totalHours);
  await committer.commitReadyBatch(batch.id);
  expect(await prisma.participationLedgerEntry.count({ where: { postingBatchId: batch.id } })).toBe(
    entries.length,
  );
}
