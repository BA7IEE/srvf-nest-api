import { LedgerQueryService } from '../../src/modules/activities/ledger-query.service';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { setImmediate as nextTurn } from 'node:timers/promises';
import request from 'supertest';

import { ActivityWorkflowGate } from '../../src/common/activity-workflow/activity-workflow.gate';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { lockMembersForWrite } from '../../src/common/prisma/member-advisory-lock.util';
import { PrismaService } from '../../src/database/prisma.service';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { LedgerReadyBatchCommitter } from '../../src/modules/activities/ledger-ready-batch-committer.service';
import { ContributionMilestoneRecorder } from '../../src/modules/activities/contribution-milestone-recorder';
import { CorrectionAuditRecorder } from '../../src/modules/activities/correction-audit-recorder';
import { NotificationOutboxWorker } from '../../src/modules/notifications/notification-outbox.worker';
import {
  LedgerPreparationService,
  readBaselineFromPayload,
  ledgerBaselineKey,
} from '../../src/modules/activities/ledger-preparation.service';
import { SettlementReviewService } from '../../src/modules/activities/settlement-review.service';
import { LegacyLedgerConversionService } from '../../src/modules/activities/legacy-ledger-conversion.service';
import type { TimeSettlementReceiptResult } from '../../src/modules/activities/activity-time-settlement-command';
import { ActivityTimeSettlementService } from '../../src/modules/activities/activity-time-settlement.service';
import {
  computeCappedContribution,
  computeCappedContributionBatch,
  computeContribution,
} from '../../src/modules/team-join/team-join-progress';
import { GENERAL_GATE_CODES } from '../../src/modules/team-join/team-join.constants';
import {
  E4_META,
  closeE13Fixture,
  createE4Fixture,
  createE4Source,
  e4Actor,
  installE4ValidationDatabase,
  postE4Ledger,
  prepareE4Ledger,
  prepareE4Time,
  submitE4Time,
  type E4Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import {
  approvedE4TimeCorrection,
  approvedE4ParticipantTimeCorrection,
} from '../helpers/activity-r5-correction-hash.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { createTestApp } from '../setup/test-app';
import { assertConnectedTestDatabase } from '../setup/test-db';
import {
  r5CiOwnerClient,
  humanCorrectionTestApp,
  humanCorrectionTestService,
} from '../helpers/r5-ci-authenticated-runtime';
import { r5CiAuthenticated } from '../setup/r5-ci-instance-scope';

const ADMIN_APPLICATIONS = '/api/admin/v1/team-join/applications';
const APP_APPLICATIONS = '/api/app/v1/me/team-join/applications';
const TWO_POINTS = {
  defaultResult: { recognizedPoints: '0.00', explanationCode: 'default_zero' },
  roleRules: [
    {
      attendanceRoleCode: 'service',
      categoryRules: [
        {
          timeCategoryCode: 'volunteer_service' as const,
          durationBands: [
            { maxSecondsInclusive: null, recognizedPoints: '2.00', explanationCode: 'adv010_two' },
          ],
        },
      ],
    },
  ],
};
const DURATION_POINTS = {
  ...TWO_POINTS,
  roleRules: [
    {
      attendanceRoleCode: 'service',
      categoryRules: [
        {
          timeCategoryCode: 'volunteer_service' as const,
          durationBands: [
            {
              maxSecondsInclusive: 1800,
              recognizedPoints: '1.00',
              explanationCode: 'a9_half_hour',
            },
            {
              maxSecondsInclusive: null,
              recognizedPoints: '2.00',
              explanationCode: 'a9_full_hour',
            },
          ],
        },
      ],
    },
  ],
};

type Candidate = {
  memberId: string;
  userId: string;
  auth: string;
  applicationId: string;
  targetId: string;
};

installE4ValidationDatabase({ settlementMode: 'active' });
describe('R5 ADV-010: real contribution posting and team-join progress', () => {
  let f: E4Fixture;
  const extraApps: INestApplication[] = [];
  const extraPools: PrismaClient[] = [];
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  const previousReadonly = process.env.ACTIVITY_WORKFLOW_READONLY;

  beforeEach(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    delete process.env.ACTIVITY_WORKFLOW_READONLY;
    f = await createE4Fixture();
  });
  afterEach(async () => {
    const cleanup = await Promise.allSettled([
      ...extraApps.splice(0).map((app) => app.close()),
      ...extraPools.splice(0).map((pool) => pool.$disconnect()),
      closeE13Fixture(f),
    ]);
    if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    if (previousReadonly === undefined) delete process.env.ACTIVITY_WORKFLOW_READONLY;
    else process.env.ACTIVITY_WORKFLOW_READONLY = previousReadonly;
    const failures = cleanup.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((r) => r.reason as unknown),
        'ADV-010 cleanup failed',
      );
  });

  async function candidate(): Promise<Candidate> {
    // A formal member remains the actual owner/initiator. The applicant is a separate volunteer.
    const user = await createTestUser(f.app, { username: f.key('candidate') });
    const member = await f.db.member.create({
      data: {
        ...memberIdentityData('ADV-010 volunteer'),
        memberNo: f.key('candidate_member'),
        gradeCode: 'volunteer',
      },
    });
    await f.db.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    const vol = await f.db.organization.create({
      data: {
        code: 'VOL',
        name: f.key('vol'),
        nodeTypeCode: 'volunteer',
        parentId: f.organizationId,
      },
    });
    await f.db.memberOrganizationMembership.create({
      data: { memberId: member.id, organizationId: vol.id, membershipType: 'PRIMARY' },
    });
    const target = await f.db.organization.create({
      data: { name: f.key('target'), nodeTypeCode: 'general-team', parentId: f.organizationId },
    });
    await f.db.teamJoinCycle.create({
      data: {
        year: 2026,
        name: f.key('cycle'),
        statusCode: 'open',
        openedAt: new Date(),
        openOrganizationIds: [target.id],
      },
    });
    const auth = (await loginAs(f.app, user.username)).authHeader;
    const response = await request(httpServer(f.app))
      .post(APP_APPLICATIONS)
      .set('Authorization', auth)
      .send({ targetOrganizationIds: [target.id] })
      .expect(201);
    expect(response.body.code).toBe(0);
    return {
      memberId: member.id,
      userId: user.id,
      auth,
      applicationId: response.body.data.id as string,
      targetId: target.id,
    };
  }

  async function sourceFor(
    who: Candidate,
    startsAt: Date,
    endsAt: Date,
    options: {
      definition?: NonNullable<Parameters<typeof createE4Source>[1]>['definition'];
      actualSeconds?: number;
    } = {},
  ) {
    let identityId = '';
    const checkoutAt =
      options.actualSeconds === undefined
        ? endsAt
        : new Date(startsAt.getTime() + options.actualSeconds * 1000);
    const source = await createE4Source(f, {
      definition: options.definition ?? TWO_POINTS,
      startsAt,
      endsAt,
      beforeSeal: async (draft) => {
        // Historical input fixture, before any seal or settlement. Effective ledger rows are never inserted here.
        const registration = await f.db.activityRegistration.create({
          data: { activityId: draft.activityId, memberId: who.memberId, statusCode: 'pass' },
        });
        const identity = await f.db.activityParticipationIdentity.create({
          data: {
            activityId: draft.activityId,
            sessionId: draft.sessionId,
            registrationId: registration.id,
            memberId: who.memberId,
            currentStatusCode: 'pass',
            populationIncluded: true,
            currentPositionId: draft.positionId,
          },
        });
        identityId = identity.id;
        const events: string[] = [];
        for (const [eventTypeCode, occurredAt] of [
          ['check_in', startsAt],
          ['check_out', checkoutAt],
        ] as const) {
          const event = await f.db.attendancePunchEvent.create({
            data: {
              activityId: draft.activityId,
              sessionId: draft.sessionId,
              positionId: draft.positionId,
              participationIdentityId: identity.id,
              memberId: who.memberId,
              eventTypeCode,
              sourceCode: 'self_qr',
              occurredAt,
              receivedAt: occurredAt,
              operatorUserId: who.userId,
              eventKey: f.key('punch'),
              requestHash: 'b'.repeat(64),
              evidenceRevision: 0,
            },
          });
          events.push(event.id);
        }
        await f.db.participantServiceSegmentRevision.create({
          data: {
            participationIdentityId: identity.id,
            segmentKey: '0001',
            revision: 1,
            sourceCheckInEventId: events[0],
            sourceCloseEventId: events[1],
            resultCode: 'valid',
            statusCode: 'draft',
            checkInAt: startsAt,
            checkOutAt: checkoutAt,
            serviceHours: (checkoutAt.getTime() - startsAt.getTime()) / 3_600_000,
            lateFlag: false,
            earlyLeaveFlag: false,
          },
        });
      },
    });
    const segment = await f.db.participantServiceSegmentRevision.findFirstOrThrow({
      where: { participationIdentityId: identityId, statusCode: 'draft' },
      orderBy: { revision: 'desc' },
    });
    await f.app.get(ActivityTimeSettlementService).allocate(
      source.activityId,
      {
        ...source.expectation,
        operationKey: f.key('volunteer_allocate'),
        sourceSegmentId: segment.id,
        expectedRevision: 0,
        recognitionModeCode: 'automatic',
        evidenceAttachmentIds: [],
      },
      e4Actor(f.creator, true),
      E4_META,
    );
    return { ...source, candidateIdentityId: identityId };
  }

  async function expectProgress(who: Candidate, points: string, app = f.app) {
    const admin = await request(httpServer(app))
      .get(`${ADMIN_APPLICATIONS}/${who.applicationId}`)
      .set('Authorization', f.creator.auth)
      .expect(200);
    const self = await request(httpServer(app))
      .get(`${APP_APPLICATIONS}/current`)
      .set('Authorization', who.auth)
      .expect(200);
    expect(admin.body.code).toBe(0);
    expect(self.body.code).toBe(0);
    expect(admin.body.data.contributionPoints).toBe(points);
    expect(self.body.data.contributionPoints).toBe(points);
  }

  async function expectMemberSummaries(who: Candidate, points: string) {
    for (const url of [
      `/api/admin/v1/members/${who.memberId}/contribution-summary`,
      `/api/admin/v1/members/${who.memberId}/participation-summary`,
      '/api/app/v1/my/participation-summary',
    ]) {
      const response = await request(httpServer(f.app))
        .get(url)
        .set('Authorization', url.includes('/app/') ? who.auth : f.creator.auth)
        .expect(200);
      expect(response.body.code).toBe(0);
      expect(response.body.data.contributionPoints).toBe(points);
    }
  }

  async function appWithState(enabled: boolean, readonly: boolean) {
    const oldGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    const oldReadonly = process.env.ACTIVITY_WORKFLOW_READONLY;
    try {
      process.env.ACTIVITY_V11_WORKFLOW_ENABLED = String(enabled);
      process.env.ACTIVITY_WORKFLOW_READONLY = String(readonly);
      const app = await createTestApp();
      extraApps.push(app);
      await assertConnectedTestDatabase(app.get(PrismaService));
      return app;
    } finally {
      if (oldGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = oldGate;
      if (oldReadonly === undefined) delete process.env.ACTIVITY_WORKFLOW_READONLY;
      else process.env.ACTIVITY_WORKFLOW_READONLY = oldReadonly;
    }
  }

  async function ordinaryConcurrencyApps() {
    const secondApp = await appWithState(true, false);
    if (!r5CiAuthenticated()) return { secondApp, observationDb: f.db, progressApp: secondApp };
    // This ordinary-ledger case never calls Human services. Release its unused
    // U/P scope before adding an independent reader: both single-connection
    // writer pools will be blocked, so neither can also observe their wait.
    if (!f.humanApp) throw new Error('ADV010 unused Human scope missing');
    await f.humanApp.close();
    f = { ...f, humanApp: undefined };
    const progressApp = await appWithState(true, false);
    return { secondApp, observationDb: progressApp.get(PrismaService), progressApp };
  }

  async function readyWithPreparingRead(
    submitted: TimeSettlementReceiptResult,
    during: () => Promise<void>,
  ) {
    const version = await f.db.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: submitted.settlementVersionId },
    });
    const expectation = {
      evidenceSealId: version.evidenceSealId,
      evidenceRevision: version.evidenceRevision,
      populationRevision: version.populationRevision,
      workflowRevision: version.workflowRevision,
      contentHash: version.contentHash,
    };
    const review = f.app.get(SettlementReviewService);
    await review.firstReview(
      {
        activityId: submitted.activityId,
        actionCode: 'approve',
        expectation,
        operationKey: f.key('first_review'),
        requestHash: 'c'.repeat(64),
      },
      e4Actor(f.reviewer),
      E4_META,
    );
    const final = await review.finalReview(
      {
        activityId: submitted.activityId,
        actionCode: 'approve',
        expectation,
        operationKey: f.key('final_review'),
        requestHash: 'd'.repeat(64),
      },
      e4Actor(f.finalReviewer),
      E4_META,
    );
    if (!final.ledgerPostingBatchId) throw new Error('ADV-010 requires the real preparation batch');
    const preparation = f.app.get(LedgerPreparationService);
    const job = await preparation.ensurePrepareJob(final.ledgerPostingBatchId);
    const items = await f.db.activityBatchJobItem.findMany({
      where: { jobId: job.jobId },
      orderBy: { itemKey: 'asc' },
    });
    for (const item of items) await preparation.prepareChunk(job.jobId, item.id);
    expect(
      (
        await f.db.ledgerPostingBatch.findUniqueOrThrow({
          where: { id: final.ledgerPostingBatchId },
        })
      ).statusCode,
    ).toBe('preparing');
    expect(
      await f.db.participationLedgerEntry.count({
        where: { postingBatchId: final.ledgerPostingBatchId },
      }),
    ).toBeGreaterThan(0);
    await during();
    expect((await preparation.finalize(job.jobId)).batchStatus).toBe('ready');
    return {
      batchId: final.ledgerPostingBatchId,
      commitCommand: { postingBatchId: final.ledgerPostingBatchId, operationKey: f.key('commit') },
    };
  }

  it('refreshes real admin and App progress after an actual native committed award', async () => {
    const who = await candidate();
    expect(
      (
        await f.db.teamJoinApplication.findUniqueOrThrow({
          where: { id: who.applicationId },
        })
      ).contributionNoticeProtocol,
    ).toBe(1);
    await expectProgress(who, '0');
    const source = await sourceFor(
      who,
      new Date('2020-03-01T08:00:00Z'),
      new Date('2020-03-01T09:00:00Z'),
    );
    const submitted = await submitE4Time(f, source, await prepareE4Time(f, source));
    const prepared = await readyWithPreparingRead(submitted, async () => expectProgress(who, '0'));
    await expectProgress(who, '0');
    const posting = f.app.get(LedgerPostingService);
    const committed = await posting.commitBatch(
      prepared.commitCommand,
      e4Actor(f.finalReviewer),
      E4_META,
    );
    expect(committed.batchStatus).toBe('committed');
    const entries = await f.db.participationLedgerEntry.aggregate({
      where: {
        memberId: who.memberId,
        postingBatchId: prepared.batchId,
        postingBatch: { statusCode: 'committed' },
      },
      _sum: { creditedPointsDelta: true },
    });
    expect(entries._sum.creditedPointsDelta?.toString()).toBe('2');
    await expectProgress(who, '2');
    await expectMemberSummaries(who, '2');
    const count = await f.db.participationLedgerEntry.count();
    expect(
      (await posting.commitBatch(prepared.commitCommand, e4Actor(f.finalReviewer), E4_META))
        .replayed,
    ).toBe(true);
    expect(await f.db.participationLedgerEntry.count()).toBe(count);

    // B is prepared after A commits: its real native award is 2 recognized / 1 credited.
    const second = await sourceFor(
      who,
      new Date('2020-03-01T10:00:00Z'),
      new Date('2020-03-01T11:00:00Z'),
    );
    const secondPosted = await postE4Ledger(
      f,
      await submitE4Time(f, second, await prepareE4Time(f, second)),
    );
    const capped = await f.db.participationLedgerEntry.aggregate({
      where: { postingBatchId: secondPosted.batchId, memberId: who.memberId },
      _sum: { recognizedPointsDelta: true, creditedPointsDelta: true },
    });
    expect(capped._sum.recognizedPointsDelta?.toString()).toBe('2');
    expect(capped._sum.creditedPointsDelta?.toString()).toBe('1');
    await expectProgress(who, '3');
    expect(
      await f.db.teamJoinContributionMilestone.count({
        where: { applicationId: who.applicationId },
      }),
    ).toBe(0);
    const third = await sourceFor(
      who,
      new Date('2020-03-02T08:00:00Z'),
      new Date('2020-03-02T09:00:00Z'),
    );
    const thirdReady = await prepareE4Ledger(
      f,
      await submitE4Time(f, third, await prepareE4Time(f, third)),
    );
    expect(
      await f.db.teamJoinContributionMilestone.count({
        where: { applicationId: who.applicationId },
      }),
    ).toBe(0);
    const autoCommitter = f.app.get(LedgerReadyBatchCommitter);
    await autoCommitter.commitReadyBatch(thirdReady.batchId);
    const milestone = await f.db.teamJoinContributionMilestone.findFirstOrThrow({
      where: { applicationId: who.applicationId },
    });
    expect(milestone.beforePoints.toString()).toBe('3');
    expect(milestone.afterPoints.toString()).toBe('5');
    expect(milestone.outcomeCode).toBe('notice_registered');
    expect((await autoCommitter.commitReadyBatch(thirdReady.batchId)).replayed).toBe(true);
    expect(
      await f.db.teamJoinContributionMilestone.findMany({
        where: { applicationId: who.applicationId },
      }),
    ).toEqual([milestone]);
    await expectProgress(who, '5');
    await expectMemberSummaries(who, '5');
    const batch = await computeCappedContributionBatch(
      f.db,
      [who.memberId, who.memberId, 'absent-member'],
      null,
      f.app.get(ActivityWorkflowGate),
      LedgerQueryService,
    );
    expect([...batch.values()].map((p) => p.toString())).toEqual(['5', '0']);

    const grades = await f.db.dictType.upsert({
      where: { code: 'member_grade' },
      create: { code: 'member_grade', label: '等级' },
      update: {},
    });
    await f.db.dictItem.upsert({
      where: { typeId_code: { typeId: grades.id, code: 'level-1' } },
      create: { typeId: grades.id, code: 'level-1', label: '一级' },
      update: {},
    });
    for (const gateCode of GENERAL_GATE_CODES) {
      await request(httpServer(f.app))
        .patch(`${ADMIN_APPLICATIONS}/${who.applicationId}/gates`)
        .set('Authorization', f.creator.auth)
        .send({ gateCode, passed: true, completionDate: new Date().toISOString() })
        .expect(200);
    }
    const evaluated = await request(httpServer(f.app))
      .post(`${ADMIN_APPLICATIONS}/${who.applicationId}/evaluate`)
      .set('Authorization', f.creator.auth)
      .send({ approved: true })
      .expect(200);
    expect(evaluated.body.data.statusCode).toBe('approved');
    const joined = await request(httpServer(f.app))
      .post(`${ADMIN_APPLICATIONS}/${who.applicationId}/join`)
      .set('Authorization', f.creator.auth)
      .send({ organizationId: who.targetId })
      .expect(200);
    expect(joined.body.data.statusCode).toBe('joined');
    expect((await f.db.member.findUniqueOrThrow({ where: { id: who.memberId } })).gradeCode).toBe(
      'level-1',
    );
  });

  it.each([false, true])(
    'ADV-010 real member-lock concurrency (A9 crossing=%s): recompute after waiting, one permanent intent',
    async (crossing) => {
      const who = await candidate();
      if (crossing) {
        for (const day of ['2020-02-27', '2020-02-28']) {
          const baseline = await sourceFor(
            who,
            new Date(`${day}T08:00:00Z`),
            new Date(`${day}T09:00:00Z`),
          );
          await postE4Ledger(f, await submitE4Time(f, baseline, await prepareE4Time(f, baseline)));
        }
        await expectProgress(who, '4');
      }
      const { secondApp, observationDb, progressApp } = await ordinaryConcurrencyApps();
      const a = await sourceFor(
        who,
        new Date('2020-03-01T08:00:00Z'),
        new Date('2020-03-01T09:00:00Z'),
      );
      const b = await sourceFor(
        who,
        new Date(crossing ? '2020-03-02T10:00:00Z' : '2020-03-01T10:00:00Z'),
        new Date(crossing ? '2020-03-02T11:00:00Z' : '2020-03-01T11:00:00Z'),
      );
      const ready = [];
      for (const source of [a, b])
        ready.push(
          await prepareE4Ledger(f, await submitE4Time(f, source, await prepareE4Time(f, source))),
        );
      for (const [index, batch] of ready.entries()) {
        const job = await f.db.activityBatchJob.findFirstOrThrow({
          where: { postingBatchId: batch.batchId },
        });
        expect(
          readBaselineFromPayload(job.payload)[
            ledgerBaselineKey(who.memberId, crossing && index === 1 ? '2020-03-02' : '2020-03-01')
          ],
        ).toBe('0:0');
      }
      const segments = await f.db.participantServiceSegmentRevision.findMany({
        where: {
          identity: { memberId: who.memberId, activityId: { in: [a.activityId, b.activityId] } },
          statusCode: 'draft',
        },
        orderBy: { checkInAt: 'asc' },
      });
      expect(segments.map((s) => [s.checkInAt.toISOString(), s.checkOutAt?.toISOString()])).toEqual(
        [
          ['2020-03-01T08:00:00.000Z', '2020-03-01T09:00:00.000Z'],
          crossing
            ? ['2020-03-02T10:00:00.000Z', '2020-03-02T11:00:00.000Z']
            : ['2020-03-01T10:00:00.000Z', '2020-03-01T11:00:00.000Z'],
        ],
      );
      const capturedBefore: string[] = [];
      for (const instance of [f.app, secondApp]) {
        const recorder = instance.get(ContributionMilestoneRecorder);
        const capture = recorder.captureBefore.bind(recorder);
        jest.spyOn(recorder, 'captureBefore').mockImplementation(async (...args) => {
          const snapshots = await capture(...args);
          capturedBefore.push(
            ...snapshots
              .filter((row) => row.memberId === who.memberId)
              .map((row) => row.beforePoints.toString()),
          );
          return snapshots;
        });
      }
      const lockDb = r5CiOwnerClient();
      extraPools.push(lockDb);
      await lockDb.$connect();
      await assertConnectedTestDatabase(lockDb);
      let release: () => void = () => undefined;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      let acquired!: (pid: number) => void;
      let acquireFailed!: (error: unknown) => void;
      const acquiredPid = new Promise<number>((resolve, reject) => {
        acquired = resolve;
        acquireFailed = reject;
      });
      const holding = lockDb.$transaction(
        async (tx) => {
          await lockMembersForWrite(tx, [f.creator.memberId, who.memberId]);
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          acquired(pid);
          await hold;
        },
        { timeout: 20_000 },
      );
      void holding.catch(acquireFailed);
      const holderPid = await acquiredPid;
      // Actual services immediately start both PostgreSQL transactions; no unconsumed HTTP request objects.
      const outcomes = Promise.allSettled(
        ready.map((batch, i) =>
          (i === 0 ? f.app : secondApp)
            .get(LedgerPostingService)
            .commitBatch(batch.commitCommand, e4Actor(f.finalReviewer), E4_META),
        ),
      );
      try {
        const deadline = performance.now() + 2_000;
        let waiters = 0;
        while (performance.now() < deadline && waiters !== 2) {
          const [{ count }] = await observationDb.$queryRaw<{ count: number }[]>`
          SELECT count(DISTINCT waiting.pid)::int AS count FROM pg_locks waiting
          JOIN pg_locks holder ON holder.locktype=waiting.locktype AND holder.database=waiting.database
            AND holder.classid=waiting.classid AND holder.objid=waiting.objid AND holder.objsubid=waiting.objsubid
          JOIN pg_stat_activity activity ON activity.pid=waiting.pid
          WHERE activity.datname=current_database() AND waiting.database=(SELECT oid FROM pg_database WHERE datname=current_database())
            AND waiting.locktype='advisory' AND waiting.objsubid=1 AND NOT waiting.granted
            AND holder.granted AND holder.pid=${holderPid} AND ${holderPid}=ANY(pg_blocking_pids(activity.pid))
        `;
          waiters = count;
          if (waiters !== 2) await nextTurn();
        }
        expect(waiters).toBe(2);
        expect(capturedBefore).toEqual([]);
        await expectProgress(who, crossing ? '4' : '0', progressApp);
      } finally {
        release();
        await Promise.allSettled([holding, outcomes]);
      }
      await holding;
      const results = await outcomes;
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(crossing ? 2 : 1);
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(failed).toHaveLength(crossing ? 0 : 1);
      if (!crossing) {
        expect(failed[0].reason).toMatchObject({
          biz: { code: BizCode.LEDGER_COMMIT_BASELINE_CHANGED.code },
        });
      }
      expect(BizCode.LEDGER_COMMIT_BASELINE_CHANGED.httpStatus).toBe(409);
      const batches = await f.db.ledgerPostingBatch.findMany({
        where: { id: { in: ready.map((r) => r.batchId) } },
      });
      expect(batches.map((r) => r.statusCode).sort()).toEqual(
        crossing ? ['committed', 'committed'] : ['committed', 'ready'],
      );
      const day = await f.db.memberContributionDayState.findFirstOrThrow({
        where: { memberId: who.memberId, ledgerDate: new Date('2020-03-01T00:00:00Z') },
      });
      expect(day.version).toBe(1);
      expect(day.committedCreditedPoints.toString()).toBe('2');
      await expectProgress(who, crossing ? '8' : '2');
      await expectMemberSummaries(who, crossing ? '8' : '2');
      const facts = await f.db.teamJoinContributionMilestone.findMany({
        where: { applicationId: who.applicationId },
      });
      expect(facts).toHaveLength(crossing ? 1 : 0);
      if (crossing) {
        expect(capturedBefore.sort()).toEqual(['4', '6']);
        expect(facts[0].beforePoints.toString()).toBe('4');
        expect(facts[0].afterPoints.toString()).toBe('6');
        expect(ready.map((batch) => batch.batchId)).toContain(facts[0].postingBatchId);
        expect(
          await f.db.notificationOutboxIntent.count({
            where: { eventKey: `team-join-contribution-met:${who.applicationId}:5` },
          }),
        ).toBe(1);
      }
    },
  );

  it.each([false, true])(
    'A9 Human V3 net 4→5→4→5: no resend after cleanup; new application independent=%s',
    async (newApplication) => {
      const who = await candidate();
      async function post(source: Awaited<ReturnType<typeof sourceFor>>) {
        const submitted = await submitE4Time(f, source, await prepareE4Time(f, source));
        await postE4Ledger(f, submitted);
        return submitted;
      }
      const baseline = await sourceFor(
        who,
        new Date('2020-02-28T08:00:00Z'),
        new Date('2020-02-28T09:00:00Z'),
        { definition: DURATION_POINTS },
      );
      const baselinePosted = await post(baseline);
      const capped = await sourceFor(
        who,
        new Date('2020-02-28T10:00:00Z'),
        new Date('2020-02-28T11:00:00Z'),
      );
      await post(capped);
      const changed = await sourceFor(
        who,
        new Date('2020-03-01T08:00:00Z'),
        new Date('2020-03-01T09:00:00Z'),
        { definition: DURATION_POINTS, actualSeconds: 1800 },
      );
      const changedPosted = await post(changed);
      await expectProgress(who, '4');
      const originalEntries = await f.db.participationLedgerEntry.findMany({
        where: { memberId: who.memberId, postingBatch: { statusCode: 'committed' } },
        orderBy: { id: 'asc' },
      });
      const positive = await approvedE4ParticipantTimeCorrection(
        f,
        changed,
        changedPosted.settlementVersionId,
        changed.candidateIdentityId,
        3600,
      );
      const prepared = await positive.correction.prepare(
        positive.input,
        e4Actor(f.finalReviewer),
        E4_META,
      );
      await expectProgress(who, '4');
      expect(
        await f.db.teamJoinContributionMilestone.count({
          where: { applicationId: who.applicationId },
        }),
      ).toBe(0);
      const unauthorized = await f.db.user.findUniqueOrThrow({
        where: { id: who.userId },
        select: { id: true, username: true, role: true, status: true, memberId: true },
      });
      await expect(
        positive.correction.commit(positive.input, unauthorized, E4_META),
      ).rejects.toMatchObject({ biz: { code: BizCode.FORBIDDEN.code } });
      if (!newApplication) {
        const audit = humanCorrectionTestService(f, CorrectionAuditRecorder);
        const write = audit.logCommit.bind(audit);
        const count = await f.db.auditLog.count();
        const failure = jest.spyOn(audit, 'logCommit').mockImplementationOnce(async (args) => {
          await write(args);
          expect(
            await args.tx.teamJoinContributionMilestone.count({
              where: { applicationId: who.applicationId },
            }),
          ).toBe(1);
          throw new Error('A9 Human audit failure after write');
        });
        await expect(
          positive.correction.commit(positive.input, e4Actor(f.finalReviewer), E4_META),
        ).rejects.toThrow('A9 Human audit failure after write');
        failure.mockRestore();
        expect(await f.db.auditLog.count()).toBe(count);
      }
      await expectProgress(who, '4');
      expect(
        await f.db.teamJoinContributionMilestone.count({
          where: { applicationId: who.applicationId },
        }),
      ).toBe(0);
      expect(
        await f.db.notificationOutboxIntent.count({
          where: { eventKey: `team-join-contribution-met:${who.applicationId}:5` },
        }),
      ).toBe(0);
      expect(
        (
          await f.db.ledgerPostingBatch.findUniqueOrThrow({
            where: { id: prepared.newPostingBatchId },
          })
        ).statusCode,
      ).toBe('ready');
      await positive.correction.commit(positive.input, e4Actor(f.finalReviewer), E4_META);
      await expectProgress(who, '5');
      const fact = await f.db.teamJoinContributionMilestone.findFirstOrThrow({
        where: { applicationId: who.applicationId },
      });
      expect(fact.outcomeCode).toBe('notice_registered');
      expect(fact.beforePoints.toString()).toBe('4');
      expect(fact.afterPoints.toString()).toBe('5');
      expect(fact.postingBatchId).toBe(prepared.newPostingBatchId);
      if (newApplication) {
        // This file runs only in the qualified SCRAM fixture. A SET ROLE from
        // an owner connection is not a substitute for U's real session_user.
        expect(r5CiAuthenticated()).toBe(true);
        const untrusted = humanCorrectionTestApp(f).get(PrismaService);
        await expect(
          untrusted.$transaction(async (tx) => {
            await tx.$executeRaw`SET LOCAL ROLE r5_boundary_caller_h7c6`;
            expect(
              await tx.$queryRaw`SELECT session_user::text AS login, current_user::text AS role`,
            ).toEqual([
              {
                login: 'r5_untrusted_caller_login_20261030_q1',
                role: 'r5_boundary_caller_h7c6',
              },
            ]);
            await tx.teamJoinContributionMilestone.create({
              data: { ...fact, id: f.key('forged_milestone') },
            });
          }),
        ).rejects.toThrow('untrusted milestone writer');
        await expect(
          untrusted.$transaction(async (tx) => {
            await tx.$executeRaw`SET LOCAL ROLE r5_boundary_caller_h7c6`;
            await tx.$executeRaw`
            UPDATE team_join_applications SET "contributionNoticeProtocol" = NULL
            WHERE id = ${who.applicationId}
          `;
          }),
        ).rejects.toThrow('immutable application contribution notice protocol');
      }
      const net = await f.db.participationLedgerEntry.findMany({
        where: { memberId: who.memberId, postingBatchId: prepared.newPostingBatchId },
      });
      expect(net.some((row) => row.creditedPointsDelta.isNegative())).toBe(true);
      expect(net.some((row) => row.creditedPointsDelta.isPositive())).toBe(true);
      expect(
        (await positive.correction.commit(positive.input, e4Actor(f.finalReviewer), E4_META))
          .replayed,
      ).toBe(true);
      const oldKey = `team-join-contribution-met:${who.applicationId}:5`;
      expect((await f.app.get(NotificationOutboxWorker).drainEventKey(oldKey)).succeeded).toBe(1);
      await f.db.notificationOutboxIntent.delete({ where: { eventKey: oldKey } });
      const negative = await approvedE4ParticipantTimeCorrection(
        f,
        baseline,
        baselinePosted.settlementVersionId,
        baseline.candidateIdentityId,
        1800,
      );
      await negative.correction.prepare(negative.input, e4Actor(f.finalReviewer), E4_META);
      await expectProgress(who, '5');
      await negative.correction.commit(negative.input, e4Actor(f.finalReviewer), E4_META);
      await expectProgress(who, '4');
      expect(
        await f.db.teamJoinContributionMilestone.findUnique({
          where: { id: fact.id },
        }),
      ).toEqual(fact);
      let activeApplicationId = who.applicationId;
      if (newApplication) {
        const rejected = await request(httpServer(f.app))
          .post(`${ADMIN_APPLICATIONS}/${who.applicationId}/evaluate`)
          .set('Authorization', f.creator.auth)
          .send({ approved: false })
          .expect(200);
        expect(rejected.body.code).toBe(0);
        const fresh = await request(httpServer(f.app))
          .post(APP_APPLICATIONS)
          .set('Authorization', who.auth)
          .send({ targetOrganizationIds: [who.targetId] })
          .expect(201);
        expect(fresh.body.code).toBe(0);
        activeApplicationId = fresh.body.data.id as string;
        expect(activeApplicationId).not.toBe(who.applicationId);
      }
      const recross = await sourceFor(
        who,
        new Date('2020-03-02T08:00:00Z'),
        new Date('2020-03-02T09:00:00Z'),
        { definition: DURATION_POINTS, actualSeconds: 1800 },
      );
      await post(recross);
      await expectProgress({ ...who, applicationId: activeApplicationId }, '5');
      expect(
        await f.db.teamJoinContributionMilestone.findUnique({
          where: { id: fact.id },
        }),
      ).toEqual(fact);
      expect(await f.db.notificationOutboxIntent.count({ where: { eventKey: oldKey } })).toBe(0);
      expect(
        await f.db.teamJoinContributionMilestone.count({
          where: { memberId: who.memberId },
        }),
      ).toBe(newApplication ? 2 : 1);
      if (newApplication) {
        const freshFact = await f.db.teamJoinContributionMilestone.findFirstOrThrow({
          where: { applicationId: activeApplicationId },
        });
        expect(freshFact.intentId).not.toBe(fact.intentId);
        expect(freshFact.beforePoints.toString()).toBe('4');
        expect(freshFact.afterPoints.toString()).toBe('5');
      }
      expect(
        await f.db.participationLedgerEntry.findMany({
          where: { id: { in: originalEntries.map((row) => row.id) } },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(originalEntries);
    },
  );

  it('keeps readonly on the same source and never adds or falls back to legacy approved scores', async () => {
    const who = await candidate();
    const source = await sourceFor(
      who,
      new Date('2020-03-01T08:00:00Z'),
      new Date('2020-03-01T09:00:00Z'),
    );
    const sheet = await f.db.attendanceSheet.create({
      data: {
        activityId: source.activityId,
        submitterUserId: f.creator.id,
        statusCode: 'approved',
      },
    });
    await f.db.attendanceRecord.create({
      data: {
        sheetId: sheet.id,
        memberId: who.memberId,
        roleCode: 'service',
        checkInAt: source.startsAt,
        checkOutAt: source.endsAt,
        serviceHours: '1',
        contributionPoints: '9',
        attendanceStatusCode: 'present',
      },
    });
    await expectProgress(who, '0');
    const off = await appWithState(false, false);
    await expectProgress(who, '3', off);
    await postE4Ledger(f, await submitE4Time(f, source, await prepareE4Time(f, source)));
    await expectProgress(who, '2');
    const readonly = await appWithState(true, true);
    await expectProgress(who, '2', readonly);
    await expectProgress(who, '3', off);
  });

  it('applies the exclusive Beijing cycle cutoff on real ledger DATE values on both sides of midnight', async () => {
    const who = await candidate();
    for (const [start, end] of [
      ['2020-03-31T15:00:00Z', '2020-03-31T16:00:00Z'],
      ['2020-03-31T16:00:00Z', '2020-03-31T17:00:00Z'],
    ]) {
      const source = await sourceFor(who, new Date(start), new Date(end));
      await postE4Ledger(f, await submitE4Time(f, source, await prepareE4Time(f, source)));
    }
    const gate = f.app.get(ActivityWorkflowGate);
    expect(
      (
        await computeCappedContribution(f.db, who.memberId, null, gate, LedgerQueryService)
      ).toString(),
    ).toBe('4');
    expect(
      (
        await computeContribution(f.db, who.memberId, 2020, gate, LedgerQueryService)
      ).points.toString(),
    ).toBe('2');
    expect(
      (
        await computeContribution(f.db, who.memberId, 2021, gate, LedgerQueryService)
      ).points.toString(),
    ).toBe('4');
  });

  it('reads real V3 correction reversal and replacement net credited points and stable replay', async () => {
    const correction = await approvedE4TimeCorrection(f);
    const gate = f.app.get(ActivityWorkflowGate);
    expect(
      (
        await computeCappedContribution(f.db, f.creator.memberId, null, gate, LedgerQueryService)
      ).toString(),
    ).toBe('1');
    const prepared = await correction.correction.prepare(
      correction.input,
      e4Actor(f.finalReviewer),
      E4_META,
    );
    expect(
      (
        await computeCappedContribution(f.db, f.creator.memberId, null, gate, LedgerQueryService)
      ).toString(),
    ).toBe('1');
    await correction.correction.commit(correction.input, e4Actor(f.finalReviewer), E4_META);
    expect(
      (
        await computeCappedContribution(f.db, f.creator.memberId, null, gate, LedgerQueryService)
      ).toString(),
    ).toBe('0.5');
    const rows = await f.db.participationLedgerEntry.findMany({
      where: { postingBatchId: prepared.newPostingBatchId, memberId: f.creator.memberId },
    });
    expect(rows.some((r) => r.creditedPointsDelta.isNegative())).toBe(true);
    const count = await f.db.participationLedgerEntry.count();
    expect(
      (await correction.correction.commit(correction.input, e4Actor(f.finalReviewer), E4_META))
        .replayed,
    ).toBe(true);
    expect(await f.db.participationLedgerEntry.count()).toBe(count);
    expect(
      (
        await computeCappedContribution(f.db, f.creator.memberId, null, gate, LedgerQueryService)
      ).toString(),
    ).toBe('0.5');
  });

  it('reconciles real legacy conversion per member for lifetime and cycle cutoff before changing source', async () => {
    const who = await candidate();
    const legacyIds: string[] = [];
    for (const [start, end] of [
      ['2020-03-31T08:00:00Z', '2020-03-31T09:00:00Z'],
      ['2020-03-31T10:00:00Z', '2020-03-31T11:00:00Z'],
      ['2020-03-31T16:00:00Z', '2020-03-31T17:00:00Z'],
    ]) {
      const startsAt = new Date(start),
        endsAt = new Date(end);
      const activity = await f.db.activity.create({
        data: {
          title: f.key('legacy'),
          activityTypeCode: 'event_support',
          organizationId: f.organizationId,
          startAt: startsAt,
          endAt: endsAt,
          location: 'test',
          statusCode: 'published',
          initiatorMemberId: f.creator.memberId,
          allocationModeCode: 'first_come',
        },
      });
      await f.db.activitySession.create({
        data: {
          activityId: activity.id,
          code: 'legacy',
          name: 'legacy',
          startAt: startsAt,
          endAt: endsAt,
          locationText: 'test',
          checkInOpenAt: startsAt,
          checkInCloseAt: endsAt,
          checkOutOpenAt: startsAt,
          checkOutCloseAt: endsAt,
          locationRequired: false,
          locationPolicySourceCode: 'session',
          statusCode: 'scheduled',
        },
      });
      const sheet = await f.db.attendanceSheet.create({
        data: {
          activityId: activity.id,
          submitterUserId: f.creator.id,
          statusCode: 'approved',
          submittedAt: startsAt,
        },
      });
      await f.db.attendanceRecord.create({
        data: {
          sheetId: sheet.id,
          memberId: who.memberId,
          roleCode: 'service',
          checkInAt: startsAt,
          checkOutAt: endsAt,
          serviceHours: '1',
          contributionPoints: '2',
          attendanceStatusCode: 'present',
        },
      });
      legacyIds.push(activity.id);
    }
    const readonly = await appWithState(false, true);
    const oldGate = readonly.get(ActivityWorkflowGate),
      newGate = f.app.get(ActivityWorkflowGate);
    const oldLifetime = await computeCappedContribution(
      f.db,
      who.memberId,
      null,
      oldGate,
      LedgerQueryService,
    );
    const oldCycle = await computeContribution(
      f.db,
      who.memberId,
      2020,
      oldGate,
      LedgerQueryService,
    );
    expect(oldLifetime.toString()).toBe('5');
    expect(oldCycle.points.toString()).toBe('3');
    for (const activityId of legacyIds) {
      const result = await readonly
        .get(LegacyLedgerConversionService)
        .convertActivity({ activityId, currentUser: e4Actor(f.creator, true), auditMeta: E4_META });
      expect(result.status).toBe('converted');
    }
    expect(
      (
        await computeCappedContribution(f.db, who.memberId, null, newGate, LedgerQueryService)
      ).toString(),
    ).toBe(oldLifetime.toString());
    expect(
      (
        await computeContribution(f.db, who.memberId, 2020, newGate, LedgerQueryService)
      ).points.toString(),
    ).toBe(oldCycle.points.toString());
    const count = await f.db.participationLedgerEntry.count();
    for (const activityId of legacyIds)
      expect(
        (
          await readonly.get(LegacyLedgerConversionService).convertActivity({
            activityId,
            currentUser: e4Actor(f.creator, true),
            auditMeta: E4_META,
          })
        ).status,
      ).toBe('already-converted');
    expect(await f.db.participationLedgerEntry.count()).toBe(count);
    await expectProgress(who, '5');
    // The application's 2026 cutoff includes all five converted points.
    // Conversion still is not a newly earned settlement or a reminder backfill.
    expect(
      await f.db.teamJoinContributionMilestone.count({
        where: { applicationId: who.applicationId },
      }),
    ).toBe(0);
    expect(
      await f.db.notificationOutboxIntent.count({
        where: { eventKey: `team-join-contribution-met:${who.applicationId}:5` },
      }),
    ).toBe(0);
  });
});
