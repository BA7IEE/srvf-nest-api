import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient, PrincipalType } from '@prisma/client';
import { writeSync } from 'node:fs';
import request, { type Response } from 'supertest';
import appConfig from '../../src/config/app.config';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityBatchWorker } from '../../src/modules/activities/activity-batch.worker';
import { ActivityBatchWorkerModule } from '../../src/modules/activities/activity-batch-worker.module';
import { NotificationOutboxWorkerModule } from '../../src/modules/notifications/notification-outbox-worker.module';
import { BizCode, type BizCodeEntry } from '../../src/common/exceptions/biz-code.constant';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { ActivityTimeSettlementService } from '../../src/modules/activities/activity-time-settlement.service';
import {
  closeE13Fixture,
  createE4Fixture,
  createE4Source,
  e4Actor,
  E4_META,
  E13_APP,
  E13_ADMIN,
  installE4ValidationDatabase,
  prepareE4Time,
  submitE4Time,
  postE4Ledger,
  prepareE4Ledger,
  type E4Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import { httpServer } from '../helpers/http-server';
import { assertConnectedTestDatabase } from '../setup/test-db';
import { createTestApp } from '../setup/test-app';

let pending = 0;
let resourcesClosed = true;
let unknown = false;
let workerClosed = true;
const auxiliaryClients = new Set<PrismaClient>();
let f: E4Fixture | undefined;
const previous = {
  ACTIVITY_E4_CONTRIBUTION_SETTLEMENT_MODE: process.env.ACTIVITY_E4_CONTRIBUTION_SETTLEMENT_MODE,
  ACTIVITY_V11_WORKFLOW_ENABLED: process.env.ACTIVITY_V11_WORKFLOW_ENABLED,
  ACTIVITY_WORKFLOW_READONLY: process.env.ACTIVITY_WORKFLOW_READONLY,
};
async function owned(work: () => Promise<void>) {
  pending++;
  try {
    await work();
  } finally {
    pending--;
  }
}
function fixture() {
  if (!f) throw new Error('E5 matrix fixture unavailable');
  return f;
}
function ok(response: Response, status = 200) {
  expect({ status: response.status, code: response.body.code as unknown }).toEqual({
    status,
    code: 0,
  });
}
function rejected(response: Response, biz: BizCodeEntry) {
  expect({ status: response.status, code: response.body.code as unknown }).toEqual({
    status: biz.httpStatus,
    code: biz.code,
  });
  expect(response.body.data).toBeNull();
}
function assertMode(app: INestApplication, mode: 'active' | 'off') {
  expect(app.get<ReturnType<typeof appConfig>>(appConfig.KEY).contributionSettlementMode).toBe(
    mode,
  );
  writeSync(2, `E5_MATRIX actualApplicationMode=${mode}\n`);
}
async function restart(mode: 'active' | 'off', readonly = false) {
  const current = fixture();
  await closeE13Fixture(current);
  f = undefined;
  process.env.ACTIVITY_E4_CONTRIBUTION_SETTLEMENT_MODE = mode;
  process.env.ACTIVITY_WORKFLOW_READONLY = String(readonly);
  const app = await createTestApp(); // Same legal database; deliberately no fixture reset.
  f = { ...current, app, db: app.get(PrismaService) };
  await assertConnectedTestDatabase(f.db);
  assertMode(app, mode);
}
installE4ValidationDatabase({
  settlementMode: 'active',
  boundMigrationProcesses: true,
  assertReadyToFinalize: () => {
    if (unknown || pending || !resourcesClosed || !workerClosed || auxiliaryClients.size)
      throw new Error('E5 matrix resource terminal UNKNOWN; DROP refused');
  },
});

describe('E5 active supplemental matrix: existing historical fixtures, no fresh publication rerun', () => {
  beforeEach(
    () =>
      owned(async () => {
        if (unknown || pending !== 1 || !resourcesClosed || !workerClosed || auxiliaryClients.size)
          throw new Error('E5 matrix previous resource terminal UNKNOWN');
        process.env.ACTIVITY_E4_CONTRIBUTION_SETTLEMENT_MODE = 'active';
        process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
        process.env.ACTIVITY_WORKFLOW_READONLY = 'false';
        resourcesClosed = false;
        f = await createE4Fixture();
        assertMode(f.app, 'active');
        await assertConnectedTestDatabase(f.db);
      }),
    120_000,
  );
  afterEach(async () => {
    if (pending) {
      unknown = true;
      throw new Error('E5 matrix body pending; close refused');
    }
    if (!f) {
      unknown = true;
      throw new Error('E5 matrix initialization terminal UNKNOWN');
    }
    await closeE13Fixture(f);
    f = undefined;
    resourcesClosed = true;
  }, 120_000);
  afterAll(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it(
    'keeps two physical sessions separate and distributes one award per unit across Beijing days',
    () =>
      owned(async () => {
        const current = fixture();
        const source = await createE4Source(current, {
          startsAt: new Date('2020-03-01T15:30:00.000Z'),
          endsAt: new Date('2020-03-01T16:30:00.000Z'),
          additionalSession: {
            startsAt: new Date('2020-03-02T02:00:00.000Z'),
            endsAt: new Date('2020-03-02T03:00:00.000Z'),
          },
          definition: {
            defaultResult: { recognizedPoints: '1.01', explanationCode: 'fixed_once_per_unit' },
            roleRules: [],
          },
        });
        expect(source.additional?.sessionId).not.toBe(source.sessionId);
        expect(source.additional?.identityId).not.toBe(source.identity.id);
        const submitted = await submitE4Time(current, source, await prepareE4Time(current, source));
        const root = await current.db.activitySettlementContributionRevision.findFirstOrThrow({
          where: { settlementVersionId: submitted.settlementVersionId, kindCode: 'submitted' },
        });
        const evaluations = await current.db.participantContributionEvaluation.findMany({
          where: { contributionRevisionId: root.id },
          orderBy: { sessionId: 'asc' },
        });
        expect(root.evaluationCount).toBe(2);
        expect(root.recognizedPointsTotal.toFixed(2)).toBe('2.02');
        expect(evaluations).toHaveLength(2);
        expect(new Set(evaluations.map((row) => row.sessionId)).size).toBe(2);
        expect(new Set(evaluations.map((row) => row.evaluationUnitKey)).size).toBe(2);
        for (const row of evaluations) {
          expect(row.memberId).toBe(current.creator.memberId);
          expect(row.ruleSnapshotId).toBe(source.snapshot.id);
          expect(row.recognizedPoints.toFixed(2)).toBe('1.01');
          expect(row.durationSeconds).toBe(3600);
        }
        expect(
          evaluations.find((row) => row.sessionId === source.sessionId)?.beijingDayPointsJson,
        ).toEqual([
          { ledgerDate: '2020-03-01', recognizedPoints: '0.51' },
          { ledgerDate: '2020-03-02', recognizedPoints: '0.50' },
        ]);
        expect(
          evaluations.find((row) => row.sessionId === source.additional?.sessionId)
            ?.beijingDayPointsJson,
        ).toEqual([{ ledgerDate: '2020-03-02', recognizedPoints: '1.01' }]);
        await current.db.$queryRaw`SELECT e4_assert_complete(${root.id})::TEXT`;
        const posted = await postE4Ledger(current, submitted);
        const entries = await current.db.participationLedgerEntry.findMany({
          where: { postingBatchId: posted.batchId, entryTypeCode: 'contribution_credit' },
          orderBy: [{ ledgerDate: 'asc' }, { participationIdentityId: 'asc' }],
        });
        expect(entries).toHaveLength(3);
        const totals = new Map<string, number>();
        for (const row of entries) {
          expect(row.memberId).toBe(current.creator.memberId);
          expect(row.creditedPointsDelta.toFixed(2)).toBe(row.recognizedPointsDelta.toFixed(2));
          const day = row.ledgerDate.toISOString().slice(0, 10);
          totals.set(
            day,
            (totals.get(day) ?? 0) + Math.round(Number(row.creditedPointsDelta) * 100),
          );
        }
        expect([...totals]).toEqual([
          ['2020-03-01', 51],
          ['2020-03-02', 151],
        ]);
        const days = await current.db.memberContributionDayState.findMany({
          where: { memberId: current.creator.memberId },
          orderBy: { ledgerDate: 'asc' },
        });
        expect(
          days.map((row) => [
            row.ledgerDate.toISOString().slice(0, 10),
            row.committedCreditedPoints.toFixed(2),
            row.version,
          ]),
        ).toEqual([
          ['2020-03-01', '0.51', 1],
          ['2020-03-02', '1.51', 1],
        ]);
        expect(
          await current.db.participantContributionEvaluation.findMany({
            where: { contributionRevisionId: root.id },
            orderBy: { sessionId: 'asc' },
          }),
        ).toEqual(evaluations);
        await current.db
          .$queryRaw`SELECT e4_assert_ledger_complete(${root.id},${posted.batchId})::TEXT`;
      }),
    120_000,
  );

  it(
    'restarts active to off to active, preserves proof and replay, and completes the original native run once',
    () =>
      owned(async () => {
        let current = fixture();
        const source = await createE4Source(current);
        const command = {
          expectedDraftVersion: source.expectation.expectedDraftVersion,
          expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,
          operationKey: current.key('restart_prepare'),
          expectedTimeRevision: 0,
        };
        const prepared = await current.app
          .get(ActivityTimeSettlementService)
          .prepare(source.activityId, command, e4Actor(current.creator, true), E4_META);
        const roots = await current.db.activitySettlementContributionRevision.findMany({
          orderBy: { id: 'asc' },
        });
        const evaluations = await current.db.participantContributionEvaluation.findMany({
          orderBy: { id: 'asc' },
        });
        const nativeFacts = async () => ({
          roots: await fixture().db.activitySettlementContributionRevision.findMany({
            orderBy: { id: 'asc' },
          }),
          evaluations: await fixture().db.participantContributionEvaluation.findMany({
            orderBy: { id: 'asc' },
          }),
          time: await fixture().db.activitySettlementTimeRevision.findMany({
            orderBy: { id: 'asc' },
          }),
          buckets: await fixture().db.participantSettlementTimeBucket.findMany({
            orderBy: { id: 'asc' },
          }),
          sources: await fixture().db.participantSettlementTimeBucketSource.findMany({
            orderBy: { id: 'asc' },
          }),
          receipts: await fixture().db.activitySettlementTimeCommandReceipt.findMany({
            orderBy: { id: 'asc' },
          }),
          versions: await fixture().db.attendanceSettlementVersion.findMany({
            orderBy: { id: 'asc' },
          }),
          run: await fixture().db.attendanceSettlementRun.findMany({ orderBy: { id: 'asc' } }),
        });
        const nativeBefore = await nativeFacts();
        const rulesUrl = '/api/system/v1/contribution-rules';
        const rule = {
          activityTypeCode: 'event_support',
          attendanceRoleCode: 'service',
          pointsBelow: 0.25,
          remark: 'E5 recovery fixture',
        };
        rejected(
          await request(httpServer(current.app))
            .post(rulesUrl)
            .set('Authorization', current.creator.auth)
            .send(rule),
          BizCode.CONTRIBUTION_RULE_READONLY,
        );
        await restart('off');
        current = fixture();
        const proofRead = await request(httpServer(current.app))
          .get(`${E13_APP}/${source.activityId}/time-settlement`)
          .set('Authorization', current.creator.auth);
        ok(proofRead);
        expect(proofRead.body.data.contributionProof).toMatchObject({
          regimeCode: 'policy_v1',
          revisionId: roots[0].id,
          recognizedPointsTotal: '1.00',
          pending: false,
        });
        const replay = await current.app
          .get(ActivityTimeSettlementService)
          .prepare(source.activityId, command, e4Actor(current.creator, true), E4_META);
        expect(replay).toEqual(prepared);
        rejected(
          await request(httpServer(current.app))
            .post(`${E13_APP}/${source.activityId}/time-settlement/prepare`)
            .set('Authorization', current.creator.auth)
            .send({ ...command, operationKey: current.key('off_new'), expectedTimeRevision: 1 }),
          BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY,
        );
        expect(
          await current.db.activitySettlementContributionRevision.findMany({
            orderBy: { id: 'asc' },
          }),
        ).toEqual(roots);
        expect(
          await current.db.participantContributionEvaluation.findMany({ orderBy: { id: 'asc' } }),
        ).toEqual(evaluations);
        expect(await nativeFacts()).toEqual(nativeBefore);
        expect(await current.db.participationLedgerEntry.count()).toBe(0);
        const created = await request(httpServer(current.app))
          .post(rulesUrl)
          .set('Authorization', current.creator.auth)
          .send(rule);
        ok(created, 201);
        const ruleId = (created.body.data as { id: string }).id;
        ok(
          await request(httpServer(current.app))
            .patch(`${rulesUrl}/${ruleId}`)
            .set('Authorization', current.creator.auth)
            .send({ pointsBelow: 0.3 }),
        );
        const removed = await request(httpServer(current.app))
          .delete(`${rulesUrl}/${ruleId}`)
          .set('Authorization', current.creator.auth);
        expect(removed.status).toBe(204);
        const legacyRows = await current.db.contributionRule.findMany({ orderBy: { id: 'asc' } });
        await restart('active', true);
        current = fixture();
        rejected(
          await request(httpServer(current.app))
            .post(`${E13_APP}/${source.activityId}/time-settlement/submit`)
            .set('Authorization', current.creator.auth)
            .send({
              expectedDraftVersion: source.expectation.expectedDraftVersion,
              expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,
              operationKey: current.key('readonly_submit'),
              timeRevisionId: prepared.timeRevisionId,
              expectedBucketContentHash: prepared.bucketContentHash,
            }),
          BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE,
        );
        await restart('active');
        current = fixture();
        rejected(
          await request(httpServer(current.app))
            .post(rulesUrl)
            .set('Authorization', current.creator.auth)
            .send(rule),
          BizCode.CONTRIBUTION_RULE_READONLY,
        );
        expect(await current.db.contributionRule.findMany({ orderBy: { id: 'asc' } })).toEqual(
          legacyRows,
        );
        const submitted = await submitE4Time(current, source, prepared);
        const posted = await postE4Ledger(current, submitted);
        const credits = await current.db.participationLedgerEntry.findMany({
          where: { postingBatchId: posted.batchId, entryTypeCode: 'contribution_credit' },
        });
        expect(credits).toHaveLength(1);
        expect(credits[0].creditedPointsDelta.toFixed(2)).toBe('1.00');
        expect(
          await current.db.activitySettlementContributionRevision.findMany({
            where: { id: { in: roots.map((row) => row.id) } },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(roots);
        expect(
          await current.db.participantContributionEvaluation.findMany({
            where: { id: { in: evaluations.map((row) => row.id) } },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(evaluations);
        expect(
          (
            await current.db.attendanceSettlementVersion.findUniqueOrThrow({
              where: { id: submitted.settlementVersionId },
            })
          ).contributionRegimeCode,
        ).toBe('policy_v1');
        expect(
          await current.app
            .get(ActivityTimeSettlementService)
            .prepare(source.activityId, command, e4Actor(current.creator, true), E4_META),
        ).toEqual(prepared);
        const days = await current.db.memberContributionDayState.findMany();
        const outbox = await current.db.notificationOutboxIntent.count();
        expect(
          (
            await current.app
              .get(LedgerPostingService)
              .commitBatch(posted.commitCommand, e4Actor(current.finalReviewer), E4_META)
          ).replayed,
        ).toBe(true);
        expect(await current.db.memberContributionDayState.findMany()).toEqual(days);
        expect(await current.db.notificationOutboxIntent.count()).toBe(outbox);
        expect(
          await current.db.participationLedgerEntry.findMany({
            where: { postingBatchId: posted.batchId, entryTypeCode: 'contribution_credit' },
          }),
        ).toEqual(credits);
      }),
    120_000,
  );

  it(
    'rechecks reviewer bindings after an observed Activity lock wait and writes no review or notification',
    () =>
      owned(async () => {
        const current = fixture();
        const source = await createE4Source(current);
        const submitted = await submitE4Time(current, source, await prepareE4Time(current, source));
        const version = await current.db.attendanceSettlementVersion.findUniqueOrThrow({
          where: { id: submitted.settlementVersionId },
        });
        const before = {
          version,
          reviews: await current.db.settlementReviewAction.count(),
          notifications: await current.db.notificationOutboxIntent.count(),
          audits: await current.db.auditLog.count(),
        };
        const lockDb = new PrismaClient();
        auxiliaryClients.add(lockDb);
        const failures: unknown[] = [];
        try {
          await lockDb.$connect();
          await assertConnectedTestDatabase(lockDb);
          let release!: () => void;
          let ready!: (pid: number) => void;
          const held = new Promise<number>((resolve) => {
            ready = resolve;
          });
          const released = new Promise<void>((resolve) => {
            release = resolve;
          });
          const blocker = lockDb.$transaction(
            async (tx) => {
              await tx.$queryRaw`SELECT id FROM "Activity" WHERE id=${source.activityId} FOR UPDATE`;
              const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
              ready(row.pid);
              await released;
            },
            { timeout: 20_000 },
          );
          let response: Promise<Response> | undefined;
          try {
            const pid = await Promise.race([
              held,
              blocker.then(() => {
                throw new Error('E5 review blocker ended before ready');
              }),
            ]);
            response = request(httpServer(current.app))
              .post(`${E13_ADMIN}/attendance-settlements/${version.id}/first-approve`)
              .set('Authorization', current.reviewer.auth)
              .send({
                operationKey: current.key('blocked_review'),
                evidenceSealId: version.evidenceSealId,
                evidenceRevision: version.evidenceRevision,
                populationRevision: version.populationRevision,
                workflowRevision: version.workflowRevision,
                contentHash: version.contentHash,
              })
              .then((result) => result);
            let settled = false;
            void response.then(
              () => {
                settled = true;
              },
              () => {
                settled = true;
              },
            );
            const deadline = performance.now() + 5_000;
            let waiting = false;
            while (performance.now() < deadline) {
              if (settled) throw new Error('Review settled before actual Activity lock wait');
              const [row] = await current.db.$queryRaw<
                { count: number }[]
              >`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND ${pid}::int=ANY(pg_blocking_pids(pid)) AND query LIKE '%FOR UPDATE%'`;
              if (row.count === 1) {
                waiting = true;
                break;
              }
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
            expect(waiting).toBe(true);
            const revoked = await current.db.roleBinding.updateMany({
              where: {
                principalType: PrincipalType.USER,
                principalId: current.reviewer.id,
                deletedAt: null,
              },
              data: { deletedAt: new Date() },
            });
            expect(revoked.count).toBeGreaterThan(0);
            release();
            await blocker;
            rejected(await response, BizCode.RBAC_FORBIDDEN);
            expect(await current.db.settlementReviewAction.count()).toBe(before.reviews);
            expect(await current.db.notificationOutboxIntent.count()).toBe(before.notifications);
            expect(await current.db.auditLog.count()).toBe(before.audits);
            expect(
              await current.db.attendanceSettlementVersion.findUniqueOrThrow({
                where: { id: version.id },
              }),
            ).toEqual(before.version);
          } catch (cause) {
            failures.push(cause);
          } finally {
            release();
            const outcomes = await Promise.allSettled([blocker, response]);
            failures.push(
              ...outcomes.flatMap((result) =>
                result.status === 'rejected' ? [result.reason as unknown] : [],
              ),
            );
          }
        } catch (cause) {
          failures.push(cause);
        } finally {
          try {
            await lockDb.$disconnect();
            auxiliaryClients.delete(lockDb);
          } catch (cause) {
            unknown = true;
            failures.push(cause);
          }
        }
        if (failures.length) throw new AggregateError(failures, 'E5 review barrier failed');
      }),
    120_000,
  );
  it(
    'resumes the original ready batch after off with the deployed worker and commits exactly once',
    () =>
      owned(async () => {
        let current = fixture();
        const source = await createE4Source(current);
        const submitted = await submitE4Time(current, source, await prepareE4Time(current, source));
        const prepared = await prepareE4Ledger(current, submitted);
        const batchBefore = await current.db.ledgerPostingBatch.findUniqueOrThrow({
          where: { id: prepared.batchId },
        });
        expect(batchBefore.statusCode).toBe('ready');
        const entriesBefore = await current.db.participationLedgerEntry.findMany({
          orderBy: { id: 'asc' },
        });
        const roots = await current.db.activitySettlementContributionRevision.findMany({
          orderBy: { id: 'asc' },
        });
        const evaluations = await current.db.participantContributionEvaluation.findMany({
          orderBy: { id: 'asc' },
        });
        const jobs = await current.db.activityBatchJob.findMany({
          where: { postingBatchId: prepared.batchId },
          orderBy: { id: 'asc' },
        });
        await restart('off');
        current = fixture();
        await expect(
          current.app
            .get(LedgerPostingService)
            .commitBatch(prepared.commitCommand, e4Actor(current.finalReviewer), E4_META),
        ).rejects.toMatchObject({ biz: BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY });
        expect(
          await current.db.ledgerPostingBatch.findUniqueOrThrow({
            where: { id: prepared.batchId },
          }),
        ).toEqual(batchBefore);
        expect(
          await current.db.activityBatchJob.findMany({
            where: { postingBatchId: prepared.batchId },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(jobs);
        expect(
          await current.db.participationLedgerEntry.findMany({ orderBy: { id: 'asc' } }),
        ).toEqual(entriesBefore);
        expect(
          await current.db.participationLedgerEntry.count({
            where: { postingBatch: { statusCode: 'committed' } },
          }),
        ).toBe(0);
        await restart('active');
        current = fixture();
        let context: INestApplicationContext | undefined;
        workerClosed = false;
        const failures: unknown[] = [];
        try {
          context = await NestFactory.createApplicationContext(NotificationOutboxWorkerModule, {
            logger: false,
            abortOnError: false,
          });
          expect(
            context.get<ReturnType<typeof appConfig>>(appConfig.KEY).contributionSettlementMode,
          ).toBe('active');
          const independent = context.get(PrismaService);
          await assertConnectedTestDatabase(independent);
          const [httpIdentity] = await current.db.$queryRaw<
            { name: string }[]
          >`SELECT current_database() AS name`;
          const [workerIdentity] = await independent.$queryRaw<
            { name: string }[]
          >`SELECT current_database() AS name`;
          expect(workerIdentity).toEqual(httpIdentity);
          expect(independent).not.toBe(current.db);
          const worker = context
            .select(ActivityBatchWorkerModule)
            .get(ActivityBatchWorker, { strict: true });
          expect(await worker.drainOnce()).toMatchObject({
            itemsFailed: 0,
            commitAttempted: true,
            commitErrorCode: null,
            batchStatus: 'committed',
          });
          const credits = await independent.participationLedgerEntry.findMany({
            where: { postingBatchId: prepared.batchId, entryTypeCode: 'contribution_credit' },
            orderBy: { id: 'asc' },
          });
          expect(credits).toHaveLength(1);
          expect(credits[0].creditedPointsDelta.toFixed(2)).toBe('1.00');
          const days = await independent.memberContributionDayState.findMany();
          expect(days.map((row) => [row.committedCreditedPoints.toFixed(2), row.version])).toEqual([
            ['1.00', 1],
          ]);
          const outbox = await independent.notificationOutboxIntent.count();
          expect(await worker.drainOnce()).toMatchObject({
            itemsFailed: 0,
            commitAttempted: false,
          });
          expect(
            await independent.participationLedgerEntry.findMany({
              where: { postingBatchId: prepared.batchId, entryTypeCode: 'contribution_credit' },
              orderBy: { id: 'asc' },
            }),
          ).toEqual(credits);
          expect(await independent.memberContributionDayState.findMany()).toEqual(days);
          expect(await independent.notificationOutboxIntent.count()).toBe(outbox);
          expect(
            await independent.activitySettlementContributionRevision.findMany({
              orderBy: { id: 'asc' },
            }),
          ).toEqual(roots);
          expect(
            await independent.participantContributionEvaluation.findMany({
              orderBy: { id: 'asc' },
            }),
          ).toEqual(evaluations);
        } catch (cause) {
          failures.push(cause);
        } finally {
          if (context) {
            try {
              await context.close();
              workerClosed = true;
            } catch (cause) {
              unknown = true;
              failures.push(cause);
            }
          } else {
            unknown = true;
          }
        }
        if (failures.length) throw new AggregateError(failures, 'E5 worker recovery failed');
      }),
    120_000,
  );
});
