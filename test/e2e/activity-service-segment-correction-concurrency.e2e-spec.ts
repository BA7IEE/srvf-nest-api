import { randomUUID } from 'node:crypto';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityClosureService } from '../../src/modules/activities/activity-closure.service';
import { CorrectionApplicationService } from '../../src/modules/activities/correction-application.service';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

const SESSION_START = new Date('2020-03-01T01:00:00.000Z');
const SESSION_END = new Date('2020-03-01T05:00:00.000Z');
const SEAL_AT = new Date('2020-03-01T09:00:00.000Z');
interface CorrectionFixture {
  activityId: string;
  sessionId: string;
  runId: string;
  versionId: string;
  batchId: string;
  sealId: string;
  memberIds: string[];
  identityIds: string[];
  resultRevisionIds: string[];
  closureRevisionId: string;
  tag: string;
}

// Independent fixture copied from the existing correction characterization.
// The old suite and its assertions remain unchanged.
describe('pending segment cleanup concurrency', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let preparation: LedgerPreparationService;
  let posting: LedgerPostingService;
  let closure: ActivityClosureService;
  let correction: CorrectionApplicationService;
  let submitter: CurrentUserPayload;
  let reviewer: CurrentUserPayload;
  let organizationId: string;
  let sequence = 0;
  const auditMeta = { requestId: 'segment-correction-conflict', ip: null, ua: null };

  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    preparation = app.get(LedgerPreparationService);
    posting = app.get(LedgerPostingService);
    closure = app.get(ActivityClosureService);
    correction = app.get(CorrectionApplicationService);
    const actors = [];
    for (const username of ['segment-submitter', 'segment-reviewer']) {
      const user = await createTestUser(app, { username, role: Role.SUPER_ADMIN });
      actors.push({
        id: user.id,
        username: user.username,
        role: user.role,
        status: UserStatus.ACTIVE,
        memberId: null,
      });
    }
    [submitter, reviewer] = actors;
    organizationId = (
      await prisma.organization.create({
        data: { name: 'Segment correction fixture', nodeTypeCode: 'activity-correction-team' },
      })
    ).id;
  });

  afterAll(async () => {
    delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    if (app) await app.close();
  });

  async function createSettledActivity(
    options: {
      memberCount?: number;
      recognizedPoints?: number;
      closeIt?: boolean;
      /**
       * 这些索引的队员基础结果写成 `absent`(认定时长 / 贡献值恒 0),
       * **但打卡与服务段照建** —— 人到了、签了到,结算时被判成缺席。
       * 这正是「更正把缺席改出勤」要修的那个形状(2026-08 验收补写 AC-060 / ADV-012)。
       * 默认空数组 ⇒ 既有全部调用方逐字保持原行为。
       */
      absentMemberIndexes?: readonly number[];
    } = {},
  ): Promise<CorrectionFixture> {
    const memberCount = options.memberCount ?? 2;
    const recognizedPoints = options.recognizedPoints ?? 1.2;
    const recognizedHours = 4;
    const absentMemberIndexes = new Set(options.absentMemberIndexes ?? []);
    sequence += 1;
    const tag = `correction-${sequence}`;

    const activity = await prisma.activity.create({
      data: {
        title: `更正活动 ${sequence}`,
        activityTypeCode: `activity-correction-type-${sequence}`,
        organizationId,
        startAt: SESSION_START,
        endAt: SESSION_END,
        location: '深圳',
        statusCode: 'published',
      },
      select: { id: true },
    });

    const session = await prisma.activitySession.create({
      data: {
        activityId: activity.id,
        code: `${tag}-s0`,
        name: `${tag} 场次`,
        startAt: SESSION_START,
        endAt: SESSION_END,
        locationText: '深圳',
        checkInOpenAt: new Date(SESSION_START.getTime() - 3600_000),
        checkInCloseAt: new Date(SESSION_START.getTime() + 3600_000),
        checkOutOpenAt: SESSION_START,
        checkOutCloseAt: new Date(SESSION_END.getTime() + 3600_000),
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });

    const memberIds = Array.from({ length: memberCount }, () => randomUUID());
    await prisma.member.createMany({
      data: memberIds.map((id, index) => ({
        id,
        memberNo: `${tag}-m${index}`,
        ...memberIdentityData(`${tag} 队员 ${index}`),
        gradeCode: 'level-2',
      })),
    });
    const registrationIds = memberIds.map(() => randomUUID());
    await prisma.activityRegistration.createMany({
      data: registrationIds.map((id, index) => ({
        id,
        activityId: activity.id,
        memberId: memberIds[index],
        statusCode: 'pass',
      })),
    });

    const ownerMember = await prisma.member.create({
      data: {
        memberNo: `${tag}-owner`,
        ...memberIdentityData(`${tag} 负责人`),
        gradeCode: 'level-2',
      },
      select: { id: true },
    });
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: activity.id,
        memberId: ownerMember.id,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: submitter.id,
        source: 'publish',
      },
    });

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
        populationCountDistinct: memberCount,
        populationCountBySession: {},
        contentHash: `seal-hash-${tag}`,
        statusCode: 'active',
        sealedByUserId: submitter.id,
        sealedAt: SEAL_AT,
      },
      select: { id: true },
    });

    const run = await prisma.attendanceSettlementRun.create({
      data: {
        activityId: activity.id,
        statusCode: 'posting',
        currentDraftVersion: 1,
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
        contentHash: `content-hash-${tag}`,
        personCount: memberCount,
        sessionParticipationCount: memberCount,
        serviceSegmentCount: memberCount,
        // ⭐ 提交人 = `submitter` —— §7.5 后半句「若更正由**原结算提交人**提出仍适用」
        //    那条 red-first 就靠它成立。
        createdByUserId: submitter.id,
        submittedAt: SEAL_AT,
        statusCode: 'approved',
        operationKey: `${tag}-submit-key`,
        requestHash: `${tag}-submit-hash`,
      },
      select: { id: true },
    });

    const identityIds: string[] = [];
    const resultRevisionIds: string[] = [];
    for (let index = 0; index < memberCount; index += 1) {
      const identity = await prisma.activityParticipationIdentity.create({
        data: {
          activityId: activity.id,
          sessionId: session.id,
          registrationId: registrationIds[index],
          memberId: memberIds[index],
          currentStatusCode: 'pass',
          populationIncluded: true,
        },
        select: { id: true },
      });
      identityIds.push(identity.id);

      const checkIn = await prisma.attendancePunchEvent.create({
        data: {
          activityId: activity.id,
          sessionId: session.id,
          participationIdentityId: identity.id,
          memberId: memberIds[index],
          eventTypeCode: 'check_in',
          sourceCode: 'self_qr',
          occurredAt: SESSION_START,
          receivedAt: SESSION_START,
          operatorUserId: submitter.id,
          eventKey: `${tag}-in-${index}`,
          requestHash: `${tag}-in-hash-${index}`,
          evidenceRevision: 0,
        },
        select: { id: true },
      });
      await prisma.participantServiceSegmentRevision.create({
        data: {
          participationIdentityId: identity.id,
          segmentKey: 'seg-0',
          revision: 0,
          sourceCheckInEventId: checkIn.id,
          resultCode: 'valid',
          statusCode: 'draft',
          checkInAt: SESSION_START,
          checkOutAt: new Date(SESSION_START.getTime() + 2 * 3600_000),
          serviceHours: 2,
        },
      });

      const isAbsent = absentMemberIndexes.has(index);
      const revision = await prisma.participantSettlementResultRevision.create({
        data: {
          settlementVersionId: version.id,
          participationIdentityId: identity.id,
          revision: 0,
          resultCode: isAbsent ? 'absent' : 'present',
          recognizedServiceHours: isAbsent ? 0 : recognizedHours,
          recognizedContributionPoints: isAbsent ? 0 : recognizedPoints,
          calculatedServiceHours: isAbsent ? 0 : recognizedHours,
          calculatedContributionPoints: isAbsent ? 0 : recognizedPoints,
          statusCode: 'draft',
        },
        select: { id: true },
      });
      resultRevisionIds.push(revision.id);
    }

    const batch = await prisma.ledgerPostingBatch.create({
      data: {
        settlementRunId: run.id,
        settlementVersionId: version.id,
        batchRevision: 1,
        statusCode: 'preparing',
        requestKey: `settlement-final-approve:${version.id}:${tag}`,
        requestHash: `${tag}-approve-hash`,
        totalCount: memberCount,
        preparedByUserId: submitter.id,
      },
      select: { id: true },
    });

    // 🔴 走**真实**的第五刀:分块准备 → 短事务统一生效。
    const { jobId } = await preparation.ensurePrepareJob(batch.id);
    const items = await prisma.activityBatchJobItem.findMany({
      where: { jobId },
      select: { id: true },
      orderBy: { itemKey: 'asc' },
    });
    for (const item of items) await preparation.prepareChunk(jobId, item.id);
    await preparation.finalize(jobId);
    await posting.commitBatch(
      { postingBatchId: batch.id, operationKey: `${tag}-commit-key` },
      submitter,
      auditMeta,
    );

    let closureRevisionId = '';
    if (options.closeIt !== false) {
      // 🔴 走**真实**的第六刀:机器关账。更正要顶掉的正是它写下的那张 closure。
      const outcome = await closure.close(
        activity.id,
        { operationKey: `${tag}-close-key`, requestHash: `${tag}-close-hash` },
        submitter,
        auditMeta,
      );
      if (outcome.outcome !== 'closed') {
        throw new Error(`夹具建立失败:首次关账被缺口挡下 ${JSON.stringify(outcome.gaps)}`);
      }
      closureRevisionId = outcome.closure.closureRevisionId;
    }

    return {
      activityId: activity.id,
      sessionId: session.id,
      runId: run.id,
      versionId: version.id,
      batchId: batch.id,
      sealId: seal.id,
      memberIds,
      identityIds,
      resultRevisionIds,
      closureRevisionId,
      tag,
    };
  }

  async function snapshot(f: CorrectionFixture) {
    return {
      segments: await prisma.participantServiceSegmentRevision.findMany({
        where: { participationIdentityId: { in: f.identityIds } },
        orderBy: { id: 'asc' },
      }),
      entries: await prisma.participationLedgerEntry.findMany({
        where: { activityId: f.activityId, postingBatch: { statusCode: 'committed' } },
        orderBy: { id: 'asc' },
      }),
      days: await prisma.memberContributionDayState.findMany({
        where: { memberId: { in: f.memberIds } },
        orderBy: [{ memberId: 'asc' }, { ledgerDate: 'asc' }],
      }),
      closure: await prisma.activitySettlementClosureRevision.findMany({
        where: { activityId: f.activityId, statusCode: 'active' },
        orderBy: { id: 'asc' },
      }),
    };
  }

  async function prepareSegment() {
    const f = await createSettledActivity({ memberCount: 1 });
    const submitted = await correction.submit(
      {
        activityId: f.activityId,
        participationIdentityId: f.identityIds[0],
        requestTypeCode: 'time',
        reason: 'Correct segment fixture',
        operationKey: f.tag + '-request',
        requestHash: f.tag + '-hash',
        requestedChangeJson: {
          schemaVersion: 1,
          results: [],
          segments: [
            {
              participationIdentityId: f.identityIds[0],
              segmentKey: 'seg-0',
              checkInAt: SESSION_START.toISOString(),
              checkOutAt: new Date(SESSION_START.getTime() + 3 * 3600_000).toISOString(),
              resultCode: 'valid',
              serviceHours: '3.00',
            },
          ],
        },
      },
      submitter,
      auditMeta,
    );
    await correction.review(
      { correctionRequestId: submitted.correctionRequestId, actionCode: 'approve' },
      reviewer,
      auditMeta,
    );
    const input = {
      correctionRequestId: submitted.correctionRequestId,
      operationKey: f.tag + '-apply',
      requestHash: f.tag + '-apply-hash',
    };
    const prepared = await correction.prepare(input, reviewer, auditMeta);
    return { f, input, prepared };
  }

  it('revalidates a revoked user after an actual Activity lock wait', async () => {
    const { f, input } = await prepareSegment();
    const before = await snapshot(f);
    const appB = await createTestApp();
    const dbB = appB.get(PrismaService);
    let release!: () => void;
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${f.activityId} FOR UPDATE`;
        locked();
        await gate;
      },
      { timeout: 15000 },
    );
    await acquired;
    const outcome = correction.commit(input, reviewer, auditMeta).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error: error as unknown }),
    );
    try {
      let waiting = 0;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const [row] = await dbB.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database()
            AND pid<>pg_backend_pid() AND wait_event_type='Lock'
            AND query LIKE '%Activity%' AND query LIKE '%FOR UPDATE%'
        `;
        waiting = row.n;
        if (waiting > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBeGreaterThan(0);
      await dbB.user.update({ where: { id: reviewer.id }, data: { status: UserStatus.DISABLED } });
      release();
      await blocker;
      expect((await outcome).error).toMatchObject({ biz: { code: BizCode.UNAUTHORIZED.code } });
      expect(await snapshot(f)).toEqual(before);
    } finally {
      release();
      await blocker;
      await outcome;
      await dbB.user.update({ where: { id: reviewer.id }, data: { status: UserStatus.ACTIVE } });
      await appB.close();
    }
  });

  it('two real connections serialize cleanup and commit/prepare replay behind the activity lock', async () => {
    const { f, input, prepared } = await prepareSegment();
    await correction.commit(input, reviewer, auditMeta);
    const before = await snapshot(f);
    const appB = await createTestApp();
    const dbB = appB.get(PrismaService);
    let release!: () => void;
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${f.activityId} FOR UPDATE`;
        locked();
        await gate;
      },
      { timeout: 15000 },
    );
    await acquired;
    const call = (db: PrismaService) =>
      db.$queryRaw<
        Array<{
          preparedSegmentCount: number;
          deletedSegmentCount: number;
          replayed: boolean;
        }>
      >`SELECT * FROM cleanup_correction_pending_segment(${prepared.correctionApplicationId},'fixture-concurrent')`;
    const first = call(prisma);
    const second = call(dbB);
    const running = Promise.all([first, second]);
    // Attach rejection handling immediately while inspecting actual lock waits.
    void running.catch(() => undefined);
    try {
      let waiting = 0;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const [row] = await dbB.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int n FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid()
            AND wait_event_type='Lock' AND query LIKE '%cleanup_correction_pending_segment%'
        `;
        waiting = row.n;
        if (waiting >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBeGreaterThanOrEqual(2);
      release();
      await blocker;
      const results = (await running).flat();
      expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
      expect(results.every((r) => r.deletedSegmentCount === 1)).toBe(true);
      expect(
        (await correction.prepare(input, reviewer, auditMeta)).pendingSegmentRevisionCount,
      ).toBe(1);
      expect(await snapshot(f)).toEqual(before);
    } finally {
      release();
      await blocker;
      await running.catch(() => undefined);
      await appB.close();
    }
  });
});
