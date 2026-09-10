import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertTestDatabaseUrl, dropWorkerDatabase } from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';

const migration = '20260908000000_correction_pending_segment_lifecycle';
// Raw SQL replay intentionally has no Prisma migration history. Restore this
// worker after both suites so subsequent specs can safely run migrate deploy.
afterAll(() => {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  const worker = process.env.JEST_WORKER_ID;
  if (!worker) throw new Error('Dedicated worker required');
  dropWorkerDatabase(worker);
  execFileSync(
    'docker',
    ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', deriveTestDbName()],
    { stdio: 'pipe' },
  );
  try {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: process.env,
      stdio: 'pipe',
    });
  } catch {
    throw new Error(
      'Segment migration test worker restoration failed (connection details suppressed)',
    );
  }
}, 120000);

function sql(input: string) {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      'u-nest-api-postgres',
      'psql',
      '--no-psqlrc',
      '-q',
      '-tA',
      '-U',
      'postgres',
      '-d',
      deriveTestDbName(),
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}

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
describe('pending segment nonempty legacy upgrade', () => {
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
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    const worker = process.env.JEST_WORKER_ID;
    if (!worker) throw new Error('Dedicated worker required');
    dropWorkerDatabase(worker);
    execFileSync(
      'docker',
      ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', deriveTestDbName()],
      { stdio: 'pipe' },
    );
    for (const name of readdirSync('prisma/migrations').sort()) {
      if (name === 'migration_lock.toml' || name >= migration) continue;
      sql(readFileSync(join('prisma/migrations', name, 'migration.sql'), 'utf8'));
    }
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
  }, 120000);

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

  it('preserves old applications without backfill and rejects nonempty missing receipts', async () => {
    const cases = [];
    for (const nonempty of [false, true]) {
      const f = await createSettledActivity({ memberCount: 1 });
      const requestedChangeJson = {
        schemaVersion: 1,
        results: [
          {
            participationIdentityId: f.identityIds[0],
            resultCode: 'present',
            recognizedServiceHours: '4.00',
            recognizedContributionPoints: '1.50',
            adjustmentReason: 'fixture',
            lateFlag: false,
            earlyLeaveFlag: false,
          },
        ],
        segments: nonempty
          ? [
              {
                participationIdentityId: f.identityIds[0],
                segmentKey: 'seg-0',
                checkInAt: SESSION_START.toISOString(),
                checkOutAt: SESSION_END.toISOString(),
                resultCode: 'valid',
                serviceHours: '4.00',
              },
            ]
          : [],
      };
      const submitted = await correction.submit(
        {
          activityId: f.activityId,
          participationIdentityId: f.identityIds[0],
          requestTypeCode: 'points',
          reason: 'legacy fixture',
          requestedChangeJson,
          operationKey: f.tag + '-legacy-request',
          requestHash: f.tag + '-legacy-hash',
        },
        submitter,
        auditMeta,
      );
      await correction.review(
        { correctionRequestId: submitted.correctionRequestId, actionCode: 'approve' },
        reviewer,
        auditMeta,
      );
      const application = await prisma.correctionApplication.create({
        data: {
          correctionRequestId: submitted.correctionRequestId,
          newSettlementVersionId: f.versionId,
          newPostingBatchId: f.batchId,
          newResultRevisionIds: f.resultRevisionIds,
          statusCode: 'committed',
        },
      });
      cases.push({
        f,
        application,
        nonempty,
        before: await snapshot(f),
        input: {
          correctionRequestId: submitted.correctionRequestId,
          operationKey: f.tag + '-legacy-replay',
          requestHash: f.tag + '-legacy-replay-hash',
        },
      });
    }
    sql(readFileSync(join('prisma/migrations', migration, 'migration.sql'), 'utf8'));
    expect(await prisma.correctionSegmentPreparationReceipt.count()).toBe(0);
    for (const item of cases) {
      expect(
        await prisma.correctionApplication.findUniqueOrThrow({
          where: { id: item.application.id },
        }),
      ).toEqual(item.application);
      if (item.nonempty) {
        await expect(correction.prepare(item.input, reviewer, auditMeta)).rejects.toMatchObject({
          biz: { code: BizCode.CORRECTION_CHANGE_SET_INVALID.code },
        });
      } else {
        expect(
          (await correction.prepare(item.input, reviewer, auditMeta)).pendingSegmentRevisionCount,
        ).toBe(0);
        expect((await correction.commit(item.input, reviewer, auditMeta)).replayed).toBe(true);
      }
      expect(await snapshot(item.f)).toEqual(item.before);
    }
    expect(await prisma.correctionSegmentPreparationReceipt.count()).toBe(0);
  }, 30000);
});

describe('pending segment migration cold SQL replay and database invariants', () => {
  beforeAll(() => {
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    const worker = process.env.JEST_WORKER_ID;
    if (!worker) throw new Error('Dedicated worker required');
    dropWorkerDatabase(worker);
    execFileSync(
      'docker',
      ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', deriveTestDbName()],
      { stdio: 'pipe' },
    );
    // Existing migrations are replayed unchanged, in repository order.
    for (const name of readdirSync(join(process.cwd(), 'prisma/migrations')).sort()) {
      if (name === 'migration_lock.toml') continue;
      sql(readFileSync(join(process.cwd(), 'prisma/migrations', name, 'migration.sql'), 'utf8'));
    }
  }, 120000);

  it('creates all three tables on a cold database', () => {
    expect(
      sql(`SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN
      ('CorrectionPendingSegmentRevision','CorrectionSegmentPreparationReceipt','CorrectionSegmentCleanupReceipt')`),
    ).toBe('3');
    expect(readdirSync('prisma/migrations').filter((x) => x !== 'migration_lock.toml')).toContain(
      migration,
    );
  });

  it('retains the current segment partial unique index', () => {
    const definition = sql(`SELECT indexdef FROM pg_indexes WHERE schemaname='public'
      AND indexname='participant_service_segment_current_unique'`);
    expect(definition).toContain('UNIQUE INDEX');
    expect(definition).toContain('"participationIdentityId", "segmentKey"');
    expect(definition).toContain("'superseded'");
  });

  it('requires receipts at transaction end for every new application', () => {
    expect(
      sql(`SELECT tgdeferrable AND tginitdeferred AND tgenabled='O'
      FROM pg_trigger WHERE tgrelid='"CorrectionApplication"'::regclass
      AND tgname='correction_application_preparation_receipt_required'`),
    ).toBe('t');
  });

  it('does not elevate cleanup execution privileges', () => {
    expect(
      sql(`SELECT prosecdef FROM pg_proc WHERE oid=
      'cleanup_correction_pending_segment(text,text)'::regprocedure`),
    ).toBe('f');
  });
});
