import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Role } from '@prisma/client';
import { writeSync } from 'node:fs';
import request, { type Response } from 'supertest';
import appConfig from '../../src/config/app.config';
import { BizCode, type BizCodeEntry } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityBatchWorker } from '../../src/modules/activities/activity-batch.worker';
import { ActivityBatchWorkerModule } from '../../src/modules/activities/activity-batch-worker.module';
import { ActivityPublishReviewService } from '../../src/modules/activities/activity-publish-review.service';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { historicalAttendanceRoleFromRuleSnapshot } from '../../src/modules/activities/activity-time-allocation-policy';
import { NotificationOutboxWorkerModule } from '../../src/modules/notifications/notification-outbox-worker.module';
import {
  closeE13Fixture,
  createE4Fixture,
  createE13ActivePolicy,
  explicitContributionPolicyChange,
  installE4ValidationDatabase,
  selectE13MetricNotRequired,
  E13_APP,
  E13_ADMIN,
  type E4Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import {
  createD13ActivePolicy,
  explicitTimePolicyChange,
} from '../helpers/activity-time-policy.fixture';
import { httpServer } from '../helpers/http-server';
import { assertConnectedTestDatabase } from '../setup/test-db';
import {
  observeE5Commit,
  safeCommitError,
  readE5CommitProvenance,
} from '../helpers/e5-commit-probe';

// Normal CI uses its assigned worker. A local run must use the existing leased W98 lifecycle:
// SRVF_E4_W98=1 SRVF_TEST_RUN_SCOPE=app_test_w98 pnpm exec jest --config test/jest-unit.config.ts
//   --testRegex 'activity-os-r5-e5-active-entry[.]e2e-spec[.]ts$'
//   --setupFiles ./test/setup/setup-files.ts --runInBand --runTestsByPath <this file>
const diagnostic = process.env.SRVF_E5_COMMIT_DIAGNOSTIC === '1';
if (
  process.env.APP_ENV !== 'test' ||
  (process.env.SRVF_E4_N1_LIFECYCLE && !diagnostic) ||
  process.env.SRVF_E4_DIAGNOSTIC_CHILD ||
  (diagnostic &&
    (process.env.SRVF_E4_W98 !== '1' || process.env.SRVF_E4_N1_LIFECYCLE !== 'install-retain')) ||
  (process.env.SRVF_E4_W98 === '1' && process.env.SRVF_TEST_RUN_SCOPE !== 'app_test_w98')
)
  throw new Error('E5 entry test requires an assigned test database and the normal lifecycle');

let pending = 0;
let unknown = false;
let appClosed = true;
let workerClosed = true;
let setupReady = false;
let fixture: E4Fixture | undefined;
let workerContext: INestApplicationContext | undefined;
let worker: ActivityBatchWorker;
const previous = {
  ACTIVITY_E4_CONTRIBUTION_SETTLEMENT_MODE: process.env.ACTIVITY_E4_CONTRIBUTION_SETTLEMENT_MODE,
  ACTIVITY_V11_WORKFLOW_ENABLED: process.env.ACTIVITY_V11_WORKFLOW_ENABLED,
  ACTIVITY_WORKFLOW_READONLY: process.env.ACTIVITY_WORKFLOW_READONLY,
  ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED: process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED,
};
async function owned(work: () => Promise<void>) {
  pending++;
  try {
    await work();
  } finally {
    pending--;
  }
}
async function stage<T>(name: string, work: () => Promise<T>): Promise<T> {
  // Direct stderr is delivered at the actual stage, not deferred by BufferedConsole.
  const started = performance.now();
  writeSync(
    2,
    `E5_ENTRY ${JSON.stringify({ stage: name, outcome: 'ENTER', utc: new Date().toISOString() })}\n`,
  );
  const result = await work();
  writeSync(
    2,
    `E5_ENTRY ${JSON.stringify({ stage: name, outcome: 'COMPLETE', durationMs: performance.now() - started })}\n`,
  );
  return result;
}
function data(response: Response, status = 200): Record<string, unknown> {
  if (response.status !== status || response.body.code !== 0) {
    const code = typeof response.body.code === 'number' ? response.body.code : 'UNKNOWN';
    throw new Error(`E5 entry HTTP status=${response.status} bizCode=${code}`);
  }
  expect(response.status).toBe(status);
  expect(response.body.code).toBe(0);
  expect(response.body.data).toEqual(expect.any(Object));
  return response.body.data as Record<string, unknown>;
}
function id(value: unknown): string {
  expect(typeof value).toBe('string');
  if (typeof value !== 'string') throw new Error('Expected an HTTP identifier');
  return value;
}
function error(response: Response, biz: BizCodeEntry) {
  expect(response.status).toBe(biz.httpStatus);
  expect(response.body.code).toBe(biz.code);
  expect(response.body.data).toBeNull();
}

async function createPublishedSource(f: E4Fixture) {
  const server = httpServer(f.app);
  const post = (url: string, auth: string, body: object = {}) =>
    request(server).post(url).set('Authorization', auth).send(body);
  const now = Date.now();
  // Allocation resolves only snapshots created before check-in. Use a real, bounded short
  // session after approval rather than backdating publication or future-dating observations.
  // If the next 51 seconds cross a Beijing midnight, put the whole source after that boundary.
  const nextBeijingDay =
    (Math.floor((now + 8 * 3_600_000) / 86_400_000) + 1) * 86_400_000 - 8 * 3_600_000;
  const startsAt = new Date(
    now + 51_000 >= nextBeijingDay ? Math.max(nextBeijingDay + 1_000, now + 15_000) : now + 15_000,
  );
  const endsAt = new Date(startsAt.getTime() + 36_000);
  const activity = data(
    await post(`${E13_ADMIN}/activities`, f.creator.auth, {
      title: f.key('active_entry'),
      activityTypeCode: 'event_support',
      allocationModeCode: 'first_come',
      organizationId: f.organizationId,
      startAt: new Date(now - 1_000).toISOString(),
      endAt: new Date(endsAt.getTime() + 500).toISOString(),
      location: 'E5 entry fixture',
      visibilityCode: 'internal',
      isPublicRegistration: true,
    }),
    201,
  );
  const activityId = id(activity.id);
  // The legacy Admin creation API has no initiating-member field (same E1-3 fixture boundary).
  await f.db.activity.update({
    where: { id: activityId },
    data: { initiatorMemberId: f.creator.memberId },
  });
  const appUrl = `${E13_APP}/${activityId}`;
  const session = data(
    await post(`${appUrl}/sessions`, f.creator.auth, {
      code: f.key('session'),
      name: 'Completed session',
      startAt: startsAt.toISOString(),
      endAt: endsAt.toISOString(),
      locationText: 'E5 entry fixture',
      checkInOpenAt: new Date(startsAt.getTime() - 500).toISOString(),
      checkInCloseAt: new Date(startsAt.getTime() + 500).toISOString(),
      checkOutOpenAt: new Date(endsAt.getTime() - 500).toISOString(),
      checkOutCloseAt: new Date(endsAt.getTime() + 500).toISOString(),
      locationRequired: false,
    }),
    201,
  );
  const sessionId = id(session.sessionId);
  const position = data(
    await post(`${appUrl}/sessions/${sessionId}/positions`, f.creator.auth, {
      code: f.key('position'),
      name: 'Service',
      attendanceRoleCode: 'service',
      capacity: 1,
      startAt: startsAt.toISOString(),
      endAt: endsAt.toISOString(),
    }),
    201,
  );
  const positionId = id(position.positionId);
  const window = {
    effectiveFrom: '1900-01-01T00:00:00.000Z',
    effectiveUntil: '2101-01-01T00:00:00.000Z',
  };
  const contribution = await createE13ActivePolicy(f, undefined, window);
  const time = await createD13ActivePolicy(f, undefined, window);
  await selectE13MetricNotRequired(f, activityId);
  let selectedContributionId: string | undefined;
  let selectedContributionHash: string | undefined;
  let selectedTimeId: string | undefined;
  for (const [path, change] of [
    [
      'contribution-policy-selection',
      explicitContributionPolicyChange(contribution, {
        layerCode: 'activity',
        sessionId: null,
        positionId: null,
      }),
    ],
    [
      'time-policy-selection',
      explicitTimePolicyChange(time, {
        layerCode: 'activity',
        sessionId: null,
        positionId: null,
      }),
    ],
  ] as const) {
    const selected = data(
      await request(server)
        .patch(`${appUrl}/${path}`)
        .set('Authorization', f.creator.auth)
        .send({
          operationKey: f.key(path),
          expectedRevision: 0,
          changes: [change],
        }),
    );
    if (path === 'contribution-policy-selection') {
      selectedContributionId = id(selected.selectionRevisionId);
      selectedContributionHash = id(selected.selectionHash);
    } else {
      selectedTimeId = id(selected.selectionRevisionId);
    }
  }
  const snapshot = await stage('PUBLISH_HTTP', async () => {
    const submitted = data(
      await post(`${appUrl}/publish-reviews`, f.creator.auth, {
        operationKey: f.key('publish'),
        confirmation: true,
      }),
    );
    const reviewId = id(submitted.id);
    expect(submitted.snapshot).toMatchObject({ schemaVersion: 9 });
    const publisher = f.app.get(ActivityPublishReviewService);
    const approve = publisher.approve.bind(publisher);
    // Observe and rethrow the original service error: a non-production 500 must retain
    // its safe class/code without logging SQL, request bodies or credentials.
    const observed = jest.spyOn(publisher, 'approve').mockImplementation(async (...args) => {
      const started = performance.now();
      try {
        return await approve(...args);
      } catch (cause) {
        try {
          const detail =
            cause !== null && typeof cause === 'object' ? (cause as Record<string, unknown>) : {};
          const message = typeof detail.message === 'string' ? detail.message : '';
          writeSync(
            2,
            `E5_ENTRY_ERROR ${JSON.stringify({
              stage: 'PUBLISH_APPROVAL',
              utc: new Date().toISOString(),
              durationMs: performance.now() - started,
              errorClass:
                typeof detail.name === 'string' &&
                [
                  'PrismaClientKnownRequestError',
                  'PrismaClientUnknownRequestError',
                  'PrismaClientValidationError',
                  'BizException',
                  'Error',
                  'TypeError',
                  'RangeError',
                ].includes(detail.name)
                  ? detail.name
                  : 'Unknown',
              prismaCode:
                typeof detail.code === 'string' && /^P[0-9]{4}$/.test(detail.code)
                  ? detail.code
                  : null,
              sqlState:
                detail.meta !== null &&
                typeof detail.meta === 'object' &&
                typeof Reflect.get(detail.meta, 'code') === 'string' &&
                /^[0-9A-Z]{5}$/.test(Reflect.get(detail.meta, 'code') as string)
                  ? Reflect.get(detail.meta, 'code')
                  : null,
              locations:
                typeof detail.stack === 'string'
                  ? (
                      detail.stack.match(
                        /src\/modules\/activities\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\.ts:[0-9]{1,6}:[0-9]{1,5}/g,
                      ) ?? []
                    ).slice(0, 1)
                  : [],
              transactionClosed:
                /transaction (?:already closed|is no longer valid|has expired)/i.test(message),
              transactionTimeoutMs:
                message.match(/timeout for this transaction was ([0-9]{1,9}) ms/i)?.[1] ?? null,
              transactionElapsedMs: message.match(/however ([0-9]{1,9}) ms passed/i)?.[1] ?? null,
            })}\n`,
          );
        } catch {
          // Evidence output is best-effort; it must never replace the original error.
        }
        throw cause;
      }
    });
    try {
      data(
        await post(`${E13_ADMIN}/activity-publish-reviews/${reviewId}/approve`, f.reviewer.auth, {
          requiresInsuranceConfirmed: true,
          operationKey: f.key('approve_publish'),
        }),
      );
    } finally {
      observed.mockRestore();
    }
    const actual = await f.db.activityRuleSnapshot.findFirstOrThrow({
      where: { activityId, createdByReviewId: reviewId },
    });
    expect(actual.workflowRevision).toBe(1);
    expect(actual.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(actual.timePolicySelectionRevisionId).toBe(selectedTimeId);
    expect(
      historicalAttendanceRoleFromRuleSnapshot(actual.resolvedConfig, sessionId, positionId),
    ).toBe('service');
    const policy = await f.db.activityContributionPolicySelectionRevision.findUniqueOrThrow({
      where: { id: actual.contributionPolicySelectionRevisionId! },
    });
    expect(actual.contributionPolicySelectionRevisionId).toBe(selectedContributionId);
    expect(policy.selectionHash).toBe(selectedContributionHash);
    expect(policy.originCode).toBe('select');
    expect(policy.publishReviewId).toBeNull();
    expect((await f.db.activity.findUniqueOrThrow({ where: { id: activityId } })).statusCode).toBe(
      'published',
    );
    expect(
      await f.db.activityResponsibilityAssignment.count({
        where: { activityId, memberId: f.creator.memberId, status: 'active' },
      }),
    ).toBe(1);
    return actual;
  });
  expect(snapshot.createdAt.getTime()).toBeLessThan(startsAt.getTime());
  await stage('REAL_SOURCE_WINDOW', async () => {
    while (Date.now() <= endsAt.getTime() + 500) {
      const remaining = endsAt.getTime() + 501 - Date.now();
      if (remaining > 90_000) throw new Error('E5 real source window exceeded its bound');
      await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 20_000)));
    }
    expect(Date.now()).toBeGreaterThan(endsAt.getTime() + 500);
  });

  return { activityId, appUrl, sessionId, positionId, startsAt, endsAt, contribution, snapshot };
}
let publishedSource: Awaited<ReturnType<typeof createPublishedSource>> | undefined;

installE4ValidationDatabase({
  // Explicit diagnostic only: close both contexts and release the existing lease after
  // the first failure; retain this one legal fixture for a bounded same-fixture repair.
  allowInstallRetain: diagnostic,
  boundMigrationProcesses: true,
  assertReadyToFinalize: () => {
    if (unknown || pending || !appClosed || !workerClosed)
      throw new Error('E5 entry work/resource terminal UNKNOWN; database finalizer refused');
  },
});

describe('E5 active: approved V9 publication through HTTP review and deployed worker posting', () => {
  beforeAll(
    () =>
      owned(async () => {
        process.env.ACTIVITY_E4_CONTRIBUTION_SETTLEMENT_MODE = 'active';
        process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
        process.env.ACTIVITY_WORKFLOW_READONLY = 'false';
        process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
        appClosed = false;
        fixture = await createE4Fixture();
        await assertConnectedTestDatabase(fixture.db);
        expect(
          fixture.app.get<ReturnType<typeof appConfig>>(appConfig.KEY).contributionSettlementMode,
        ).toBe('active');
        workerClosed = false;
        workerContext = await NestFactory.createApplicationContext(NotificationOutboxWorkerModule, {
          logger: false,
          abortOnError: false,
        });
        const graph = workerContext.select(ActivityBatchWorkerModule);
        worker = graph.get(ActivityBatchWorker, { strict: true });
        expect(
          workerContext.get<ReturnType<typeof appConfig>>(appConfig.KEY).contributionSettlementMode,
        ).toBe('active');
        const independent = workerContext.get(PrismaService);
        await assertConnectedTestDatabase(independent);
        expect(independent).not.toBe(fixture.db);
        const [httpDb] = await fixture.db.$queryRaw<
          { name: string }[]
        >`SELECT current_database() AS name`;
        const [workerDb] = await independent.$queryRaw<
          { name: string }[]
        >`SELECT current_database() AS name`;
        expect(workerDb.name).toBe(httpDb.name);
        setupReady = true;
      }),
    120_000,
  );

  beforeAll(() => {
    if (!setupReady || pending || unknown || !fixture || !workerContext)
      throw new Error('E5 entry app/worker setup is not terminal ready');
    const ready = fixture;
    return owned(async () => {
      publishedSource = await createPublishedSource(ready);
    });
  }, 120_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    try {
      if (pending) {
        unknown = true; // Jest timeout does not cancel an async body; never race it with DROP.
        throw new Error('E5 entry body still pending; close and DROP refused');
      }
      try {
        if (workerContext) {
          await workerContext.close();
          workerClosed = true;
        } else if (!workerClosed) throw new Error('Worker initialization close terminal UNKNOWN');
      } catch (cause) {
        errors.push(cause);
      }
      try {
        if (fixture) {
          await closeE13Fixture(fixture);
          appClosed = true;
        } else if (!appClosed) throw new Error('App initialization close terminal UNKNOWN');
      } catch (cause) {
        errors.push(cause);
      }
      if (errors.length) throw new AggregateError(errors, 'E5 entry resources did not close');
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 120_000);

  it(
    'freezes a real approval, rejects unauthorized/invalid/conflicting commands, and posts exactly once',
    () =>
      owned(async () => {
        if (!fixture || !workerContext || !publishedSource)
          throw new Error('E5 entry source unavailable');
        const f = fixture;
        const server = httpServer(f.app);
        const post = (url: string, auth: string, body: object = {}) =>
          request(server).post(url).set('Authorization', auth).send(body);
        const {
          activityId,
          appUrl,
          sessionId,
          positionId,
          startsAt,
          endsAt,
          contribution,
          snapshot,
        } = publishedSource;

        await stage('PARTICIPATION_FIXTURE', async () => {
          // Only raw participation observations are fixture data; every publish/settlement/proof/job/
          // review/ledger transition below is executed by the existing commands and worker.
          const registration = await f.db.activityRegistration.create({
            data: { activityId, memberId: f.creator.memberId, statusCode: 'pass' },
          });
          const identity = await f.db.activityParticipationIdentity.create({
            data: {
              activityId,
              sessionId,
              registrationId: registration.id,
              memberId: f.creator.memberId,
              currentStatusCode: 'pass',
              currentPositionId: positionId,
              populationIncluded: true,
            },
          });
          const events: string[] = [];
          for (const [eventTypeCode, occurredAt] of [
            ['check_in', startsAt],
            ['check_out', endsAt],
          ] as const) {
            const event = await f.db.attendancePunchEvent.create({
              data: {
                activityId,
                sessionId,
                positionId,
                participationIdentityId: identity.id,
                memberId: identity.memberId,
                eventTypeCode,
                sourceCode: 'self_qr',
                occurredAt,
                receivedAt: new Date(),
                operatorUserId: f.creator.id,
                eventKey: f.key(eventTypeCode),
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
              checkOutAt: endsAt,
              serviceHours: 0.01,
              lateFlag: false,
              earlyLeaveFlag: false,
            },
          });
        });
        const seal = data(await post(`${appUrl}/evidence-seals`, f.creator.auth));
        const dispatched = await stage('GENERATE_HTTP', async () =>
          data(
            await post(`${appUrl}/settlement/generate`, f.creator.auth, {
              operationKey: f.key('generate'),
            }),
          ),
        );
        // One identity uses the existing synchronous dispatcher path; ledger work is claimed
        // and auto-committed by the deployed worker below, without enlarging this fixture.
        expect(dispatched.outcome).toBe('draft');
        const draft = await f.db.attendanceSettlementVersion.findUniqueOrThrow({
          where: { id: id(dispatched.settlementVersionId) },
        });
        expect(draft.contributionRegimeCode).toBe('policy_v1');
        const source = await f.db.participantServiceSegmentRevision.findFirstOrThrow({
          where: { identity: { activityId }, statusCode: 'draft' },
          orderBy: { revision: 'desc' },
        });
        // Keep the existing JWT, but remove the SUPER_ADMIN shortcut before managed settlement HTTP.
        await f.db.user.update({ where: { id: f.creator.id }, data: { role: Role.USER } });
        const expectation = {
          expectedDraftVersion: draft.version,
          expectedEvidenceSealId: id(seal.sealId),
          expectedEvidenceRevision: seal.evidenceRevision,
          expectedPopulationRevision: seal.populationRevision,
          expectedWorkflowRevision: seal.workflowRevision,
        };
        const timeUrl = `${appUrl}/time-settlement`;
        data(
          await post(`${timeUrl}/allocations`, f.creator.auth, {
            ...expectation,
            operationKey: f.key('allocate'),
            sourceSegmentId: source.id,
            expectedRevision: 0,
            recognitionModeCode: 'automatic',
            evidenceAttachmentIds: [],
          }),
        );
        const prepare = {
          expectedDraftVersion: draft.version,
          expectedEvidenceSealId: id(seal.sealId),
          expectedTimeRevision: 0,
          operationKey: f.key('prepare'),
        };
        await stage('HTTP_BOUNDARIES', async () => {
          error(
            await request(server).post(`${timeUrl}/prepare`).send(prepare),
            BizCode.UNAUTHORIZED,
          );
          error(
            await post(`${timeUrl}/prepare`, 'Bearer invalid-e5-test-token', prepare),
            BizCode.UNAUTHORIZED,
          );
          error(
            await post(`${timeUrl}/prepare`, f.creator.auth, {
              ...prepare,
              expectedTimeRevision: -1,
            }),
            BizCode.BAD_REQUEST,
          );
        });
        const prepared = await stage('PREPARE_HTTP', async () =>
          data(await post(`${timeUrl}/prepare`, f.creator.auth, prepare)),
        );
        expect(data(await post(`${timeUrl}/prepare`, f.creator.auth, prepare))).toEqual(prepared);
        error(
          await post(`${timeUrl}/prepare`, f.creator.auth, { ...prepare, expectedTimeRevision: 1 }),
          BizCode.ACTIVITY_TIME_SETTLEMENT_COMMAND_CONFLICT,
        );
        const submit = {
          expectedDraftVersion: draft.version,
          expectedEvidenceSealId: id(seal.sealId),
          operationKey: f.key('submit'),
          timeRevisionId: id(prepared.timeRevisionId),
          expectedBucketContentHash: id(prepared.bucketContentHash),
        };
        const submitted = await stage('SUBMIT_HTTP', async () =>
          data(await post(`${timeUrl}/submit`, f.creator.auth, submit)),
        );
        expect(data(await post(`${timeUrl}/submit`, f.creator.auth, submit))).toEqual(submitted);
        const formalId = id(submitted.settlementVersionId);
        const formal = await f.db.attendanceSettlementVersion.findUniqueOrThrow({
          where: { id: formalId },
        });
        const command = {
          evidenceSealId: formal.evidenceSealId,
          evidenceRevision: formal.evidenceRevision,
          populationRevision: formal.populationRevision,
          workflowRevision: formal.workflowRevision,
          contentHash: formal.contentHash,
        };
        const reviewUrl = `${E13_ADMIN}/attendance-settlements/${formalId}`;
        const firstCommand = { ...command, operationKey: f.key('first') };
        const finalCommand = { ...command, operationKey: f.key('final') };
        await stage('ADMIN_HTTP_BOUNDARIES', async () => {
          for (const action of ['first-approve', 'final-approve']) {
            error(
              await request(server).post(`${reviewUrl}/${action}`).send(firstCommand),
              BizCode.UNAUTHORIZED,
            );
            error(
              await post(`${reviewUrl}/${action}`, f.reviewer.auth, {
                ...firstCommand,
                operationKey: '',
              }),
              BizCode.BAD_REQUEST,
            );
          }
          error(
            await post(`${reviewUrl}/first-approve`, f.finalReviewer.auth, firstCommand),
            BizCode.RBAC_FORBIDDEN,
          );
        });
        const first = await stage('FIRST_HTTP', async () =>
          data(await post(`${reviewUrl}/first-approve`, f.reviewer.auth, firstCommand)),
        );
        const firstReplay = data(
          await post(`${reviewUrl}/first-approve`, f.reviewer.auth, firstCommand),
        );
        expect(firstReplay.reviewActionId).toBe(first.reviewActionId);
        error(
          await post(`${reviewUrl}/first-approve`, f.reviewer.auth, {
            ...firstCommand,
            note: 'different payload',
          }),
          BizCode.SETTLEMENT_REVIEW_OPERATION_KEY_CONFLICT,
        );
        const final = await stage('FINAL_HTTP', async () =>
          data(await post(`${reviewUrl}/final-approve`, f.finalReviewer.auth, finalCommand)),
        );
        const finalReplay = data(
          await post(`${reviewUrl}/final-approve`, f.finalReviewer.auth, finalCommand),
        );
        expect(finalReplay.reviewActionId).toBe(final.reviewActionId);
        expect(finalReplay.ledgerPostingBatchId).toBe(final.ledgerPostingBatchId);
        expect(
          await f.db.settlementReviewAction.count({ where: { settlementVersionId: formalId } }),
        ).toBe(2);
        const batchId = id(final.ledgerPostingBatchId);
        const provenance = await readE5CommitProvenance(f.db, batchId);
        writeSync(2, `E5_COMMIT_PROVENANCE ${JSON.stringify(provenance)}\n`);
        const posting = workerContext
          .select(ActivityBatchWorkerModule)
          .get(LedgerPostingService, { strict: true });
        const emitProbe = (event: unknown) =>
          writeSync(2, `E5_COMMIT_PROBE ${JSON.stringify(event)}\n`);
        const probe = observeE5Commit(posting, workerContext.get(PrismaService), emitProbe);
        try {
          await stage('LEDGER_WORKER', async () => {
            let committed = false;
            for (let round = 0; round < 2 && !committed; round++) {
              let result;
              try {
                result = await worker.drainOnce();
              } catch (cause) {
                try {
                  emitProbe({ stage: 'worker.cleanup', error: safeCommitError(cause) });
                } catch {
                  /* preserve cause */
                }
                throw probe.hasFailure ? probe.failure : cause;
              } finally {
                probe.flush(emitProbe);
              }
              if (probe.hasFailure) {
                // End this round at the original first error, after the worker has safely
                // released its lease. Never consume a sequence of backoffs inside Jest.
                try {
                  writeSync(
                    2,
                    `E5_ENTRY_COMMIT_ERROR ${JSON.stringify(safeCommitError(probe.failure))}\n`,
                  );
                } catch {
                  /* preserve original error */
                }
                throw probe.failure;
              }
              expect(result.itemsFailed).toBe(0);
              expect(result.commitErrorCode).toBeNull();
              committed = result.batchStatus === 'committed';
            }
            expect(committed).toBe(true);
            expect(
              (await f.db.ledgerPostingBatch.findUniqueOrThrow({ where: { id: batchId } }))
                .statusCode,
            ).toBe('committed');
          });
        } finally {
          probe.restore();
          try {
            emitProbe({
              stage: 'observer.terminal',
              observerIoMs: probe.observerIoMs,
              restorationFailures: probe.restorationFailures,
            });
          } catch {
            /* diagnostic only */
          }
        }
        expect(probe.restorationFailures).toBe(0);
        const independent = workerContext.get(PrismaService);
        const roots = await independent.activitySettlementContributionRevision.findMany({
          where: { activityId },
          include: { evaluations: true },
        });
        expect(roots).toHaveLength(2);
        for (const root of roots) {
          expect(root.ruleSnapshotId).toBe(snapshot.id);
          expect(root.recognizedPointsTotal.toFixed(2)).toBe('0.50');
          expect(root.evaluations).toHaveLength(1);
          expect(root.evaluations[0]).toMatchObject({
            ruleSnapshotId: snapshot.id,
            policyId: contribution.policyId,
            policyVersionId: contribution.versionId,
            definitionHash: contribution.definitionHash,
            evaluatorVersion: contribution.evaluatorVersion,
          });
        }
        const credits = () =>
          independent.participationLedgerEntry.findMany({
            where: { postingBatchId: batchId, entryTypeCode: 'contribution_credit' },
          });
        const before = await credits();
        expect(before).toHaveLength(1);
        expect(before[0].creditedPointsDelta.toFixed(2)).toBe('0.50');
        // A further real queue round cannot duplicate the committed ledger (it may handle reconciliation).
        const repeated = await worker.drainOnce();
        expect(repeated.itemsFailed).toBe(0);
        expect(await credits()).toEqual(before);
        expect(
          await independent.activityBatchJob.count({
            where: { postingBatchId: batchId, jobTypeCode: 'settlement_prepare' },
          }),
        ).toBe(1);
        const detail = data(
          await request(server)
            .get(`${reviewUrl}/review-detail`)
            .set('Authorization', f.creator.auth),
        );
        expect(detail.contributionProof).toMatchObject({
          regimeCode: 'policy_v1',
          pending: false,
          recognizedPointsTotal: '0.50',
        });
        writeSync(
          2,
          `E5_ENTRY_RESULT ${JSON.stringify({
            active: true,
            publishedSnapshotFromHttpApproval: true,
            managedActorRole: 'USER',
            adminReviewsViaHttp: 2,
            nativeRoots: roots.length,
            nativeEvaluations: roots.reduce((sum, root) => sum + root.evaluations.length, 0),
            workerAutoCommitted: true,
            workerCommitRetries: 0,
            contributionCredits: before.length,
            creditedPoints: before[0].creditedPointsDelta.toFixed(2),
            exactReplaysAndConflicts: true,
          })}\n`,
        );
      }),
    120_000,
  );
});
