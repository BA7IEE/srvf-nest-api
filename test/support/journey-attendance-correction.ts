import { randomUUID } from 'node:crypto';

import { Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { ActivityClosureService } from '../../src/modules/activities/activity-closure.service';
import {
  CorrectionApplicationService,
  type CorrectionSubmitInput,
} from '../../src/modules/activities/correction-application.service';
import { CORRECTION_CHANGE_SCHEMA_VERSION } from '../../src/modules/activities/correction-change-set';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { createTestUser } from '../fixtures/users.fixture';
import { journeyAdmin, journeyPrisma, type JourneyRuntime } from './journey-runtime';
import { memberIdentityData } from '../helpers/member-identity.fixture';

/** 北京 2020-03-01 09:00 → 13:00，固定过去时刻避免耦合墙钟。 */
const SESSION_START = new Date('2020-03-01T01:00:00.000Z');
const SESSION_END = new Date('2020-03-01T05:00:00.000Z');
const SEAL_AT = new Date('2020-03-01T09:00:00.000Z');
const AUDIT_META = { requestId: 'journey-attendance-correction', ip: null, ua: null };

interface SettledAttendanceFixture {
  readonly activityId: string;
  readonly identityId: string;
  readonly memberId: string;
  readonly tag: string;
}

async function createReviewer(runtime: JourneyRuntime): Promise<CurrentUserPayload> {
  const reviewer = await createTestUser(runtime.app, {
    username: 'journey-attendance-reviewer',
    role: Role.SUPER_ADMIN,
  });
  return {
    id: reviewer.id,
    username: reviewer.username,
    role: reviewer.role,
    status: UserStatus.ACTIVE,
    memberId: null,
  };
}

/**
 * 初始历史状态只在 support 中建模；账本和关账本身仍由真实第五、六刀写出。
 * 这使下面的更正面对的是生产会出现的已结算活动，而不是手写的 ledger 行。
 */
async function createSettledAttendance(runtime: JourneyRuntime): Promise<SettledAttendanceFixture> {
  const prisma = journeyPrisma(runtime);
  const submitter = journeyAdmin(runtime);
  const tag = `journey-attendance-${randomUUID()}`;
  // journey-direct-write: ambient — 组织树底座
  const organization = await prisma.organization.create({
    data: { name: `${tag} 组织`, nodeTypeCode: 'journey-attendance-team' },
    select: { id: true },
  });
  // journey-direct-write: ambient — 活动本体属发布链,不是「结算更正」这条被验链
  const activity = await prisma.activity.create({
    data: {
      title: `${tag} 活动`,
      activityTypeCode: 'journey-attendance',
      organizationId: organization.id,
      startAt: SESSION_START,
      endAt: SESSION_END,
      location: '深圳',
      statusCode: 'published',
    },
    select: { id: true },
  });
  // journey-direct-write: gate-unreachable — ActivitySession 写口在 app managed-activities 且 scopes=responsibility;ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED 默认关 ⇒ 无可达 API 路径
  const session = await prisma.activitySession.create({
    data: {
      activityId: activity.id,
      code: `${tag}-session`,
      name: `${tag} 场次`,
      startAt: SESSION_START,
      endAt: SESSION_END,
      locationText: '深圳',
      checkInOpenAt: new Date(SESSION_START.getTime() - 3_600_000),
      checkInCloseAt: new Date(SESSION_START.getTime() + 3_600_000),
      checkOutOpenAt: SESSION_START,
      checkOutCloseAt: new Date(SESSION_END.getTime() + 3_600_000),
      locationRequired: false,
      locationPolicySourceCode: 'session',
      statusCode: 'scheduled',
    },
    select: { id: true },
  });
  // journey-direct-write: ambient — 队员建档属招新链
  const member = await prisma.member.create({
    data: {
      memberNo: `${tag}-member`,
      ...memberIdentityData('考勤修正旅程队员'),
      gradeCode: 'level-2',
    },
    select: { id: true },
  });
  // journey-direct-write: ambient — 报名属报名链(另有 journey 验)
  const registration = await prisma.activityRegistration.create({
    data: { activityId: activity.id, memberId: member.id, statusCode: 'pass' },
    select: { id: true },
  });
  // journey-direct-write: ambient — 同 L88
  const owner = await prisma.member.create({
    data: {
      memberNo: `${tag}-owner`,
      ...memberIdentityData('考勤修正旅程负责人'),
      gradeCode: 'level-2',
    },
    select: { id: true },
  });
  // journey-direct-write: gate-unreachable — 责任闭环开关默认关,无可达 API 路径
  await prisma.activityResponsibilityAssignment.create({
    data: {
      activityId: activity.id,
      memberId: owner.id,
      responsibilityType: 'owner',
      canManageRegistrations: true,
      canManageAttendance: true,
      status: 'active',
      assignedByUserId: submitter.id,
      source: 'publish',
    },
  });
  // journey-direct-write: gate-unreachable — v1.1 结算真相链;ACTIVITY_V11_WORKFLOW_ENABLED 默认关
  const seal = await prisma.evidenceSeal.create({
    data: {
      activityId: activity.id,
      sealRevision: 1,
      evidenceRevision: 0,
      populationRevision: 0,
      workflowRevision: 0,
      allWindowsClosedAt: SEAL_AT,
      openSegmentCount: 0,
      manualReviewPendingCount: 0,
      populationCountDistinct: 1,
      populationCountBySession: {},
      contentHash: `${tag}-seal`,
      statusCode: 'active',
      sealedByUserId: submitter.id,
      sealedAt: SEAL_AT,
    },
    select: { id: true },
  });
  // journey-direct-write: gate-unreachable — 同上
  const run = await prisma.attendanceSettlementRun.create({
    data: {
      activityId: activity.id,
      statusCode: 'posting',
      currentDraftVersion: 1,
      currentSubmittedVersion: 1,
    },
    select: { id: true },
  });
  // journey-direct-write: gate-unreachable — 同上
  const version = await prisma.attendanceSettlementVersion.create({
    data: {
      settlementRunId: run.id,
      version: 1,
      evidenceSealId: seal.id,
      evidenceRevision: 0,
      populationRevision: 0,
      workflowRevision: 0,
      contentHash: `${tag}-content`,
      personCount: 1,
      sessionParticipationCount: 1,
      serviceSegmentCount: 1,
      createdByUserId: submitter.id,
      submittedAt: SEAL_AT,
      statusCode: 'approved',
      operationKey: `${tag}-submit`,
      requestHash: `${tag}-submit-hash`,
    },
    select: { id: true },
  });
  // journey-direct-write: gate-unreachable — 同上
  const identity = await prisma.activityParticipationIdentity.create({
    data: {
      activityId: activity.id,
      sessionId: session.id,
      registrationId: registration.id,
      memberId: member.id,
      currentStatusCode: 'pass',
      populationIncluded: true,
    },
    select: { id: true },
  });
  // journey-direct-write: gate-unreachable — 同上(新打卡链闸关时被 assertV11WriteAllowed 拒绝)
  const checkIn = await prisma.attendancePunchEvent.create({
    data: {
      activityId: activity.id,
      sessionId: session.id,
      participationIdentityId: identity.id,
      memberId: member.id,
      eventTypeCode: 'check_in',
      sourceCode: 'self_qr',
      occurredAt: SESSION_START,
      receivedAt: SESSION_START,
      operatorUserId: submitter.id,
      eventKey: `${tag}-check-in`,
      requestHash: `${tag}-check-in-hash`,
      evidenceRevision: 0,
    },
    select: { id: true },
  });
  // journey-direct-write: gate-unreachable — 同上
  await prisma.participantServiceSegmentRevision.create({
    data: {
      participationIdentityId: identity.id,
      segmentKey: 'segment-0',
      revision: 0,
      sourceCheckInEventId: checkIn.id,
      resultCode: 'valid',
      statusCode: 'draft',
      checkInAt: SESSION_START,
      checkOutAt: new Date(SESSION_START.getTime() + 2 * 3_600_000),
      serviceHours: 2,
    },
  });
  // journey-direct-write: gate-unreachable — 同上
  await prisma.participantSettlementResultRevision.create({
    data: {
      settlementVersionId: version.id,
      participationIdentityId: identity.id,
      revision: 0,
      resultCode: 'present',
      recognizedServiceHours: 4,
      recognizedContributionPoints: 1.2,
      calculatedServiceHours: 4,
      calculatedContributionPoints: 1.2,
      statusCode: 'draft',
    },
  });
  // journey-direct-write: gate-unreachable — 同上
  const batch = await prisma.ledgerPostingBatch.create({
    data: {
      settlementRunId: run.id,
      settlementVersionId: version.id,
      batchRevision: 1,
      statusCode: 'preparing',
      requestKey: `settlement-final-approve:${version.id}:${tag}`,
      requestHash: `${tag}-approve-hash`,
      totalCount: 1,
      preparedByUserId: submitter.id,
    },
    select: { id: true },
  });
  const preparation = runtime.app.get(LedgerPreparationService);
  const posting = runtime.app.get(LedgerPostingService);
  const closure = runtime.app.get(ActivityClosureService);
  const { jobId } = await preparation.ensurePrepareJob(batch.id);
  const items = await prisma.activityBatchJobItem.findMany({
    where: { jobId },
    select: { id: true },
    orderBy: { itemKey: 'asc' },
  });
  for (const item of items) await preparation.prepareChunk(jobId, item.id);
  await preparation.finalize(jobId);
  await posting.commitBatch(
    { postingBatchId: batch.id, operationKey: `${tag}-commit` },
    submitter,
    AUDIT_META,
  );
  const closed = await closure.close(
    activity.id,
    { operationKey: `${tag}-close`, requestHash: `${tag}-close-hash` },
    submitter,
    AUDIT_META,
  );
  if (closed.outcome !== 'closed') {
    throw new Error(`考勤修正旅程夹具无法完成首次关账: ${JSON.stringify(closed.gaps)}`);
  }
  return { activityId: activity.id, identityId: identity.id, memberId: member.id, tag };
}

function correctionInput(fixture: SettledAttendanceFixture, suffix: string): CorrectionSubmitInput {
  return {
    activityId: fixture.activityId,
    participationIdentityId: fixture.identityId,
    requestTypeCode: 'points',
    requestedChangeJson: {
      schemaVersion: CORRECTION_CHANGE_SCHEMA_VERSION,
      results: [
        {
          participationIdentityId: fixture.identityId,
          resultCode: 'present',
          recognizedServiceHours: '4.00',
          recognizedContributionPoints: '0.60',
          adjustmentReason: '现场考勤复核后更正贡献值',
          lateFlag: false,
          earlyLeaveFlag: false,
        },
      ],
      segments: [],
    },
    reason: '现场记录有误，认定贡献值需要更正',
    operationKey: `${fixture.tag}-correction-${suffix}`,
    requestHash: `${fixture.tag}-correction-hash-${suffix}`,
  };
}

async function bizCodeOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BizException) return error.biz.code;
    throw error;
  }
  throw new Error('变异探针预期被拒绝，但调用成功');
}

export interface AttendanceCorrectionJourneyResult {
  readonly duplicateOpenCorrectionCode: number;
  readonly creditedPoints: string;
  readonly dayStateVersion: number;
  readonly postedVersion: number | null;
  readonly activeClosureRevision: number | null;
  readonly recloseOutcome: string;
}

/** 金五条③：已结算考勤 → 提交 → 独立复核 → 冲回补记 → 重新关账。 */
export async function runAttendanceCorrectionJourney(
  runtime: JourneyRuntime,
): Promise<AttendanceCorrectionJourneyResult> {
  const prisma = journeyPrisma(runtime);
  const submitter = journeyAdmin(runtime);
  const reviewer = await createReviewer(runtime);
  const fixture = await createSettledAttendance(runtime);
  const correction = runtime.app.get(CorrectionApplicationService);
  const submitted = await correction.submit(
    correctionInput(fixture, 'first'),
    submitter,
    AUDIT_META,
  );
  const duplicateOpenCorrectionCode = await bizCodeOf(
    correction.submit(correctionInput(fixture, 'duplicate'), submitter, AUDIT_META),
  );
  const reviewed = await correction.review(
    { correctionRequestId: submitted.correctionRequestId, actionCode: 'approve' },
    reviewer,
    AUDIT_META,
  );
  if (reviewed.outcome !== 'reviewed') {
    throw new Error(`考勤修正旅程审核未完成: ${JSON.stringify(reviewed)}`);
  }
  const applied = await correction.apply(
    {
      correctionRequestId: submitted.correctionRequestId,
      operationKey: `${fixture.tag}-apply`,
      requestHash: `${fixture.tag}-apply-hash`,
    },
    reviewer,
    AUDIT_META,
  );
  const dayState = await prisma.memberContributionDayState.findFirst({
    where: { memberId: fixture.memberId },
    select: { committedCreditedPoints: true, version: true },
    orderBy: { version: 'desc' },
  });
  const run = await prisma.attendanceSettlementRun.findUnique({
    where: { activityId: fixture.activityId },
    select: { currentPostedVersion: true, currentClosureRevision: true },
  });
  return {
    duplicateOpenCorrectionCode,
    creditedPoints: dayState?.committedCreditedPoints.toString() ?? '',
    dayStateVersion: dayState?.version ?? 0,
    postedVersion: run?.currentPostedVersion ?? null,
    activeClosureRevision: run?.currentClosureRevision ?? null,
    recloseOutcome: applied.reclose.outcome,
  };
}
