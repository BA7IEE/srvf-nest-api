import assert from 'node:assert/strict';
import {
  R5_COMMITTED_PREPARE,
  readR5CommittedPrepare,
  readR5CommittedPrepareForOriginalJobRetry,
} from './r5-human-correction-prepared-source';
import {
  R5_RETAINED_CAPACITY1000_SOURCE,
  readR5RetainedCapacitySource,
} from './r5-human-correction-retained-source';
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus, type Prisma, type PrismaClient } from '@prisma/client';
import appConfig from '../../src/config/app.config';
import { ActivityWorkflowGate } from '../../src/common/activity-workflow/activity-workflow.gate';
import { PrismaService } from '../../src/database/prisma.service';
import { JwtStrategy } from '../../src/modules/auth/strategies/jwt.strategy';
import { AuthzService } from '../../src/modules/authz/authz.service';
import { ActivityTimeCorrectionCommandService } from '../../src/modules/activities/activity-time-correction-command.service';
import { CorrectionApplicationService } from '../../src/modules/activities/correction-application.service';
import type { TimeSettlementReceiptResult } from '../../src/modules/activities/activity-time-settlement-command';
import { createTestApp } from '../setup/test-app';
import { loginAs } from '../fixtures/auth.fixture';
import {
  e4Actor,
  E4_META,
  postE4Ledger,
  type E4Fixture,
} from './activity-contribution-policy.fixture';
import {
  assertNativeLaunchFrozenOracle,
  nativeLaunchV3Allocation,
  type NativeLaunchStage,
} from './native-launch-live.fixture';
import { buildNativeCapacityCorrectionShape } from './native-capacity-change-shape';
import { readR5E4RowDomainReadiness } from './r5-e4-row-domain-readiness';
import { readR5OwnedBackend } from './r5-setmat-backend-boundary';
import {
  createR5CapacityLiveSource,
  recognizeR5CapacityCommittedSources,
} from './r5-setmat-capacity-source.fixture';
import { capacityTerminalReceipt } from './r5-setmat-capacity.measurement';
import type { R5SetmatFixture } from './r5-setmat-concurrency-barrier';
import {
  installR5CallerTransactions,
  R5_SETMAT_CLUSTER,
  R5_SETMAT_DATABASE,
} from './r5-setmat-observation';
import { validateR5SetmatOwnedConfig, type R5SetmatOwnedConfig } from './r5-setmat-owned-fixture';
import {
  assertR5NoPolicyBranch,
  assertR5PrepareStorageReadiness,
  readR5FixedActorAssignments,
  readR5PrepareStorageReadiness,
  readR5ZeroAssignmentReadiness,
} from './r5-setmat-preparation-readiness';

export interface R5AsyncCapacity1000FixtureOptions {
  config: R5SetmatOwnedConfig;
  observer: PrismaClient;
  persist: (value: unknown) => string;
  stage: NativeLaunchStage;
  checkpoint: (reserve?: number) => void;
  verifyCatalog: () => Promise<void>;
  onApplication: (app: INestApplication) => void;
  retainedSource?: typeof R5_RETAINED_CAPACITY1000_SOURCE;
  preparedApplication?: typeof R5_COMMITTED_PREPARE;
  originalJobRetry?: boolean;
}

export type R5AsyncCapacity1000Fixture = Pick<
  R5SetmatFixture,
  | 'app'
  | 'observerDb'
  | 'b'
  | 'activityId'
  | 'requestId'
  | 'command'
  | 'verifyCandidate'
  | 'restoreObservation'
> & {
  preparationDb: PrismaService;
  expected: {
    sourceCount: 10000;
    delta: 1000;
    bindingCount: 10000;
    sliceCount: 50000;
    identities: 2000;
    oracleEvaluations: 8000;
  };
  proofId: string;
  preparedOracle: { rootId: string; proofId: string; evaluations: 8000 };
};

/** Prepare one NEW N10000/delta1000 application through the existing business
 * chain. The outer async owner supplies the sole observer, lease, clock and
 * durable journal. It also owns every application/resource after onApplication,
 * including failures: this helper never closes, retries or replays anything.
 */
export async function createR5AsyncCapacity1000Fixture(
  options: R5AsyncCapacity1000FixtureOptions,
): Promise<R5AsyncCapacity1000Fixture> {
  const config = validateR5SetmatOwnedConfig(options.config);
  assert.equal(config.databaseOid, 1998913);
  if (options.retainedSource)
    assert.deepEqual(options.retainedSource, R5_RETAINED_CAPACITY1000_SOURCE);
  if (options.preparedApplication)
    assert.deepEqual(options.preparedApplication, R5_COMMITTED_PREPARE);
  if (options.originalJobRetry) assert(options.preparedApplication);
  const { observer, persist, checkpoint, verifyCatalog } = options;
  const fixedActors = {
    creator: config.creatorUserId,
    A: config.reviewerUserId,
    B: config.finalReviewerUserId,
  };
  let currentStage = 'PRECONDITIONS';
  let writesMayHaveStarted = false;
  let uncertain = false;
  const stage: NativeLaunchStage = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    checkpoint(125_000);
    currentStage = label;
    return await options.stage(label, async () => {
      checkpoint(125_000);
      const value = await work();
      checkpoint();
      return value;
    });
  };
  stage.observe = options.stage.observe;
  stage.snapshot = options.stage.snapshot;

  try {
    await stage('ASYNC_CAPACITY_TARGET_IDENTITY', async () => {
      const rows = await observer.$queryRaw<
        { cluster: string; database: string; oid: number; version: string }[]
      >`
        SELECT (SELECT system_identifier::text FROM pg_control_system()) AS cluster,
          current_database()::text AS database,
          (SELECT oid FROM pg_database WHERE datname=current_database())::int AS oid,
          current_setting('server_version_num') AS version`;
      assert.deepEqual(rows, [
        {
          cluster: R5_SETMAT_CLUSTER,
          database: R5_SETMAT_DATABASE,
          oid: config.databaseOid,
          version: '160015',
        },
      ]);
    });
    await stage('ASYNC_CAPACITY_CATALOG_BEFORE_FIXTURE', verifyCatalog);
    const rowDomainReadiness = await stage('E4_ROW_DOMAIN_READONLY_PREFLIGHT', () =>
      observer.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          await tx.$executeRaw`SET LOCAL statement_timeout='2s'`;
          return await readR5E4RowDomainReadiness(tx);
        },
        { timeout: 3000, maxWait: 1000 },
      ),
    );
    persist(rowDomainReadiness);
    await stage('ASYNC_CAPACITY_EXISTING_QUEUE_ADMISSION', async () => {
      assert.equal(
        await observer.activityBatchJob.count({
          where: { statusCode: { in: ['pending', 'processing'] } },
        }),
        0,
        'retained queued jobs forbid capacity fixture startup',
      );
    });
    const storageReadiness = await stage('ASYNC_CAPACITY_STORAGE_READINESS', () =>
      readR5PrepareStorageReadiness(observer),
    );
    persist({ kind: 'prepare-storage-readiness-before-fixture-writes', proof: storageReadiness });
    assertR5PrepareStorageReadiness(storageReadiness);
    const assignmentReadiness = await stage('ASYNC_CAPACITY_ZERO_ASSIGNMENT_READINESS', () =>
      readR5ZeroAssignmentReadiness(observer, fixedActors),
    );
    persist({
      kind: 'zero-assignment-readiness-before-fixture-writes',
      facts: assignmentReadiness,
    });
    assertR5NoPolicyBranch(assignmentReadiness);

    writesMayHaveStarted = true;
    const app = await stage('TEST_APP_CONSTRUCTION', async () => {
      const created = await createTestApp();
      options.onApplication(created);
      return created;
    });
    const db = app.get(PrismaService);
    await stage('ASYNC_CAPACITY_PREPARATION_BACKEND_BIRTH', async () => {
      const backend = await readR5OwnedBackend(db);
      persist({ kind: 'ASYNC_CAPACITY_PREPARATION_BACKEND_BIRTH', backend });
    });
    const jwt = app.get(JwtStrategy);
    const getRegistry: unknown = Reflect.get(jwt, 'getPassportInstance');
    assert(typeof getRegistry === 'function');
    const registry: unknown = Reflect.apply(getRegistry, jwt, []);
    assert(registry && typeof registry === 'object');
    const lookup: unknown = Reflect.get(registry, '_strategy');
    assert(typeof lookup === 'function');
    assert.equal(Reflect.apply(lookup, registry, ['jwt']), jwt);
    assert.equal(Reflect.get(jwt, 'prisma'), db);
    assert.equal(Reflect.get(app.get(CorrectionApplicationService), 'prisma'), db);
    assert.equal(Reflect.get(app.get(ActivityTimeCorrectionCommandService), 'prisma'), db);
    assert.notEqual(Reflect.get(db, '_engine'), Reflect.get(observer, '_engine'));
    assert(!jest.isMockFunction(Reflect.get(CorrectionApplicationService.prototype, 'prepare')));
    persist({
      kind: 'CAPACITY_ACTUAL_INSTANCE_WIRING',
      sameAuthHumanDomainClient: true,
      currentJwtIsOwn: true,
      independentObserverEngine: true,
      prototypePrepareIsNotJestMock: true,
      applicationCount: 1,
      poolSizeUnchanged: true,
    });
    const cfg = app.get<ReturnType<typeof appConfig>>(appConfig.KEY);
    assert.equal(cfg.env, 'test');
    assert.equal(cfg.contributionSettlementMode, 'active');
    assert.equal(cfg.activityResponsibilityWorkflow.enabled, true);
    assert.equal(app.get(ActivityWorkflowGate).isV11Enabled(), true);
    assert.equal(app.get(ActivityWorkflowGate).isReadonlyMaintenance(), false);
    const resolveUser = async (id: string) => {
      const user = await db.user.findUniqueOrThrow({
        where: { id },
        select: {
          id: true,
          username: true,
          memberId: true,
          status: true,
          deletedAt: true,
          role: true,
        },
      });
      assert.equal(user.status, UserStatus.ACTIVE);
      assert.equal(user.deletedAt, null);
      assert(user.memberId);
      return { ...user, memberId: user.memberId };
    };
    const [creator, a, b] = await stage('ASYNC_CAPACITY_FIXED_ACTORS', () =>
      Promise.all([
        resolveUser(config.creatorUserId),
        resolveUser(config.reviewerUserId),
        resolveUser(config.finalReviewerUserId),
      ]),
    );
    assert.equal(creator.role, Role.SUPER_ADMIN);
    assert.equal(a.role, Role.USER);
    assert.equal(b.role, Role.USER);
    const authz = app.get(AuthzService);
    const permission = 'activity.settlement-final-review.record';
    await stage('ASYNC_CAPACITY_FIXED_ACTOR_AUTHZ', async () => {
      assert.equal(
        (await authz.getExplicitVisibleOrganizationScope(a, permission, db)).hasPermission,
        false,
      );
      const bScope = await authz.getExplicitVisibleOrganizationScope(b, permission, db);
      assert(bScope.hasPermission && bScope.global);
    });
    const prefix = 'r5_async_capacity_' + randomBytes(6).toString('hex');
    let sequence = 0;
    const f: E4Fixture = {
      app,
      db,
      organizationId: config.organizationId,
      key: (label) => `${prefix}_${label}_${++sequence}`,
      creator: {
        id: creator.id,
        memberId: creator.memberId,
        auth: (await stage('CREATOR_REAL_LOGIN', () => loginAs(app, creator.username))).authHeader,
      },
      reviewer: {
        id: a.id,
        memberId: a.memberId,
        auth: (await stage('A_REAL_LOGIN', () => loginAs(app, a.username))).authHeader,
      },
      finalReviewer: {
        id: b.id,
        memberId: b.memberId,
        auth: (await stage('B_REAL_LOGIN', () => loginAs(app, b.username))).authHeader,
      },
    };
    const beforeBody = async (tx: Prisma.TransactionClient) => {
      const facts = await readR5FixedActorAssignments(tx, fixedActors);
      persist({ kind: 'zero-assignment-in-transaction', facts });
      assertR5NoPolicyBranch(facts);
    };
    const route = installR5CallerTransactions(db, config.databaseOid, beforeBody, persist);
    const committed = async <T>(
      label: string,
      operation: () => Promise<T>,
      budget: number,
    ): Promise<T> => {
      checkpoint(125_000);
      let receipt: unknown;
      let attempt: Awaited<ReturnType<typeof route.observe<T>>>;
      try {
        attempt = await route.observe(observer, label, operation, (value) => {
          receipt = value;
          return persist(value);
        });
      } catch (error) {
        uncertain = true;
        throw error;
      }
      if (attempt.databaseOutcome === 'UNKNOWN' || !attempt.observationComplete) uncertain = true;
      assert.equal(
        attempt.databaseOutcome,
        'COMMITTED',
        'independent server COMMIT proof required',
      );
      assert.equal(attempt.observationComplete, true);
      assert.equal(attempt.configuredTimeoutMs, budget);
      if (attempt.client.status === 'rejected') throw attempt.client.reason;
      assert(
        capacityTerminalReceipt(receipt, 'commit').transactionPromiseElapsedMs <= budget,
        'native transaction budget includes settlement',
      );
      checkpoint(125_000);
      return attempt.client.value;
    };
    const corrections = app.get(CorrectionApplicationService);
    const human = app.get(ActivityTimeCorrectionCommandService);
    if (options.preparedApplication) {
      const prepared = await (options.originalJobRetry
        ? readR5CommittedPrepareForOriginalJobRetry(observer, stage, persist)
        : readR5CommittedPrepare(observer, stage, persist));
      await verifyCatalog();
      checkpoint(125_000);
      return {
        app,
        preparationDb: db,
        observerDb: observer,
        b: { id: b.id, username: b.username },
        ...prepared,
        verifyCandidate: verifyCatalog,
        restoreObservation: () => route.restore(),
        expected: {
          sourceCount: 10000,
          delta: 1000,
          bindingCount: 10000,
          sliceCount: 50000,
          identities: 2000,
          oracleEvaluations: 8000,
        },
      };
    }
    const { source, posted, unchanged, results } = options.retainedSource
      ? await readR5RetainedCapacitySource(observer, stage, persist)
      : await (async () => {
          const source = await createR5CapacityLiveSource(f, stage);
          persist({
            kind: 'NEW-capacity-source',
            activityId: source.activityId,
            participants: 2000,
            sourceCount: source.segments.length,
            allParticipantsNew: true,
          });
          const preparedTime = await stage<TimeSettlementReceiptResult>('MAIN_PREPARE', () =>
            source.post('/time-settlement/prepare', source.prepare),
          );
          const submitted = await stage<TimeSettlementReceiptResult>('MAIN_SUBMIT', () =>
            source.post('/time-settlement/submit', {
              expectedDraftVersion: source.draft.version,
              expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,
              operationKey: f.key('main_submit'),
              timeRevisionId: preparedTime.timeRevisionId,
              expectedBucketContentHash: preparedTime.bucketContentHash,
            }),
          );
          const posted = await stage('MAIN_E4_COMMIT', () => postE4Ledger(f, submitted));
          assert.equal(posted.committed.batchStatus, 'committed');
          assert.equal(
            (await observer.ledgerPostingBatch.findUniqueOrThrow({ where: { id: posted.batchId } }))
              .statusCode,
            'committed',
          );
          persist({
            kind: 'main-outcome',
            postingBatchId: posted.batchId,
            databaseEvidence: 'COMMITTED_VISIBLE_BATCH_READBACK',
            exactXidObservation: false,
          });
          const mainRoot = await observer.activitySettlementContributionRevision.findFirstOrThrow({
            where: { settlementVersionId: submitted.settlementVersionId, kindCode: 'submitted' },
          });
          await assertNativeLaunchFrozenOracle(observer, mainRoot, 8000, stage);
          const original = await observer.participantSettlementResultRevision.findMany({
            where: { settlementVersionId: submitted.settlementVersionId },
          });
          assert.equal(original.length, 2000);
          const results = original.map((row) => ({
            participationIdentityId: row.participationIdentityId,
            resultCode: row.resultCode,
            lateFlag: !row.lateFlag,
            earlyLeaveFlag: row.earlyLeaveFlag,
            recognizedServiceHours: row.recognizedServiceHours.toFixed(2),
            recognizedContributionPoints: row.recognizedContributionPoints.toFixed(2),
            adjustmentReason: 'Fresh capacity approved fact correction',
          }));
          const unchangedRequest = await route.withinCaller(() =>
            stage('NEW_UNCHANGED_SUBMIT', () =>
              corrections.submit(
                {
                  activityId: source.activityId,
                  participationIdentityId: source.raw.people[0].identityId,
                  requestTypeCode: 'result',
                  requestedChangeJson: { schemaVersion: 1, results, segments: [] },
                  reason: 'Fresh capacity unchanged baseline',
                  operationKey: f.key('unchanged_request'),
                  requestHash: 'e'.repeat(64),
                },
                e4Actor(f.creator, true),
                E4_META,
              ),
            ),
          );
          const unchangedReview = await route.withinCaller(() =>
            stage('NEW_UNCHANGED_REVIEW', () =>
              corrections.review(
                {
                  correctionRequestId: unchangedRequest.correctionRequestId,
                  actionCode: 'approve',
                },
                e4Actor(f.finalReviewer),
                E4_META,
              ),
            ),
          );
          assert.equal(unchangedReview.outcome, 'reviewed');
          assert(unchangedReview.outcome === 'reviewed');
          assert.equal(unchangedReview.statusCode, 'approved');
          const unchangedCommand = {
            correctionRequestId: unchangedRequest.correctionRequestId,
            operationKey: f.key('unchanged_prepare'),
            requestHash: 'f'.repeat(64),
          };
          const unchanged = await stage('NEW_UNCHANGED_PREPARE', () =>
            committed(
              'UNCHANGED_PREPARE',
              () => corrections.prepare(unchangedCommand, e4Actor(f.finalReviewer), E4_META),
              120000,
            ),
          );
          await stage('NEW_UNCHANGED_COMMIT', () =>
            committed(
              'UNCHANGED_COMMIT',
              () => corrections.commit(unchangedCommand, e4Actor(f.finalReviewer), E4_META),
              7000,
            ),
          );
          const unchangedRoot =
            await observer.activitySettlementContributionRevision.findFirstOrThrow({
              where: { settlementVersionId: unchanged.newSettlementVersionId },
            });
          assert.equal(unchangedRoot.sourceKindCode, 'unchanged_time');
          await assertNativeLaunchFrozenOracle(observer, unchangedRoot, 8000, stage);
          return { source, posted, unchanged, results };
        })();
    const allocations = await recognizeR5CapacityCommittedSources(f, source, stage);
    assert.equal(allocations.length, 10000);
    const bySource = new Map(allocations.map((row) => [row.sourceSegmentId, row]));
    assert.equal(bySource.size, 10000);
    const attachment = await stage('NEW_CAPACITY_EVIDENCE', () =>
      db.$transaction(async (tx) => {
        const value = await tx.attachment.create({
          data: {
            key: f.key('evidence'),
            originalName: 'capacity.txt',
            mime: 'text/plain',
            size: 1,
            uploadedBy: creator.id,
            ownerType: 'activity',
            ownerId: source.activityId,
            tags: [],
          },
        });
        await tx.storageObject.create({
          data: {
            key: value.key,
            state: 'available',
            source: 'attachment_signed_upload',
            providerType: 'LOCAL',
            localNamespace: 'r5-setmat-capacity',
            expectedSize: 1n,
            actualSize: 1n,
            expectedMime: 'text/plain',
            resourceType: 'attachment',
            resourceId: value.id,
            verifiedAt: new Date(),
            presentAt: new Date(),
            lastProviderCheckedAt: new Date(),
          },
        });
        return value;
      }),
    );
    const delta = 1000;
    const shape = buildNativeCapacityCorrectionShape(source.segments, delta);
    persist({
      kind: 'NEW-capacity-approved-input-shape',
      ...shape.metrics,
      expected: shape.expected,
    });
    const manifest = await observer.participationTimeLedgerManifest.findUniqueOrThrow({
      where: { postingBatchId: posted.batchId },
    });
    const roots = await observer.participationTimeLedgerEntry.findMany({
      where: { manifestId: manifest.id },
    });
    assert.equal(roots.length, 8000);
    assert.equal(
      new Set(roots.map((row) => JSON.stringify([row.participationIdentityId, row.categoryCode])))
        .size,
      8000,
    );
    const change = {
      schemaVersion: 3,
      results: results.map((row) => ({ ...row, lateFlag: !row.lateFlag })),
      segments: shape.selected.map((row) => ({
        participationIdentityId: row.participationIdentityId,
        segmentKey: row.segmentKey,
        checkInAt: row.checkInAt.toISOString(),
        checkOutAt: new Date(row.checkOutAt!.getTime() - 1000).toISOString(),
        resultCode: 'valid',
        serviceHours: '0.01',
      })),
      allocations: shape.selected.map((row) => {
        const base = bySource.get(row.id);
        assert(base);
        return {
          ...nativeLaunchV3Allocation({
            participationIdentityId: row.participationIdentityId,
            segmentKey: row.segmentKey,
            baseSegmentRevisionId: row.id,
            baseAllocationRevisionId: base.id,
            startsAt: row.checkInAt,
            endsAt: new Date(row.checkOutAt!.getTime() - 1000),
          }),
          evidenceAttachmentIds: [attachment.id],
        };
      }),
      timeCorrection: {
        baseSettlementVersionId: unchanged.newSettlementVersionId,
        baseTimeLedgerHash: manifest.contentHash,
        reason: 'Fresh capacity changed facts',
        items: roots.map((row) => {
          const categories = shape.recognizedSecondsByIdentity.get(row.participationIdentityId);
          assert(categories);
          const recognizedSeconds = categories[row.categoryCode];
          assert(Number.isSafeInteger(recognizedSeconds) && recognizedSeconds >= 0);
          return { rootEntryId: row.id, recognizedSeconds };
        }),
      },
    };
    const request = await route.withinCaller(() =>
      stage('NEW_HUMAN_SUBMIT', () =>
        human.submit(
          source.activityId,
          {
            participationIdentityId: source.raw.people[0].identityId,
            requestTypeCode: 'time',
            requestedChangeJson: change,
            reason: 'Fresh capacity Human V3',
            operationKey: f.key('human_request'),
          },
          e4Actor(f.creator, true),
          E4_META,
        ),
      ),
    );
    persist({
      kind: 'NEW-human-request',
      activityId: source.activityId,
      requestId: request.requestId,
      priorRequestsNeverReplayed: true,
    });
    const reviewed = await route.withinCaller(() =>
      stage('NEW_HUMAN_REVIEW', () =>
        human.review(
          source.activityId,
          request.requestId,
          { actionCode: 'approve', expectedRequestVersion: request.requestVersion },
          e4Actor(f.finalReviewer),
          E4_META,
        ),
      ),
    );
    assert.equal(reviewed.statusCode, 'approved');
    const operationKey = f.key('human_prepare');
    persist({
      kind: 'NEW-human-before-prepare',
      requestId: request.requestId,
      operationKey,
      baseSettlementVersionId: request.baseSettlementVersionId,
    });
    const originalPrepare = corrections.prepare.bind(corrections);
    const prepareSpy = jest
      .spyOn(corrections, 'prepare')
      .mockImplementation((...args) =>
        committed('HUMAN_PREPARE_ROOT', () => originalPrepare(...args), 120000),
      );
    const prepared = await (async () => {
      try {
        return await stage('NEW_HUMAN_PREPARE', () =>
          human.prepare(
            source.activityId,
            request.requestId,
            { operationKey, expectedBaseSettlementVersionId: request.baseSettlementVersionId },
            e4Actor(f.finalReviewer),
            E4_META,
          ),
        );
      } finally {
        prepareSpy.mockRestore();
      }
    })();
    assert.equal(prepared.replayed, false);
    const proof = await observer.correctionTimeSourceProof.findUniqueOrThrow({
      where: { applicationId: prepared.applicationId },
    });
    assert.equal(proof.expectedSegmentCount, 10000);
    assert.equal(proof.expectedPendingCount, delta);
    assert.equal(proof.expectedBindingCount, 10000);
    assert.equal(proof.expectedSliceCount, 50000);
    assert.equal(
      await observer.correctionPendingTimeAllocation.count({
        where: { applicationId: prepared.applicationId },
      }),
      delta,
    );
    assert.equal(
      await observer.correctionPendingTimeAllocationEvidence.count({
        where: { pendingAllocation: { applicationId: prepared.applicationId } },
      }),
      delta,
    );
    const root = await observer.activitySettlementContributionRevision.findFirstOrThrow({
      where: { settlementVersionId: prepared.settlementVersionId },
    });
    assert.equal(root.sourceKindCode, 'correction_time_proof');
    assert.equal(root.correctionTimeSourceProofId, proof.id);
    await assertNativeLaunchFrozenOracle(observer, root, 8000, stage);
    await stage('ASYNC_CAPACITY_CATALOG_AFTER_PREPARE', verifyCatalog);
    checkpoint(125_000);
    persist({
      kind: 'NEW-capacity-prepared',
      activityId: source.activityId,
      requestId: request.requestId,
      applicationId: prepared.applicationId,
      postingBatchId: prepared.postingBatchId,
      proofId: proof.id,
      sourceCount: 10000,
      delta,
      bindingCount: 10000,
    });
    return {
      app,
      preparationDb: db,
      observerDb: observer,
      b: { id: b.id, username: b.username },
      activityId: source.activityId,
      requestId: request.requestId,
      command: {
        operationKey,
        expectedBaseSettlementVersionId: request.baseSettlementVersionId,
        correctionApplicationId: prepared.applicationId,
        postingBatchId: prepared.postingBatchId,
      },
      verifyCandidate: verifyCatalog,
      restoreObservation: () => {
        assert(!uncertain, 'UNKNOWN preparation outcome requires independent owner closeout');
        route.restore();
      },
      expected: {
        sourceCount: 10000,
        delta: 1000,
        bindingCount: 10000,
        sliceCount: 50000,
        identities: 2000,
        oracleEvaluations: 8000,
      },
      proofId: proof.id,
      preparedOracle: { rootId: root.id, proofId: proof.id, evaluations: 8000 },
    };
  } catch (error) {
    // Source setup contains several committed transactions. A later failure
    // cannot prove their rollback; the sole owner retains the reported app and
    // observer and resolves the individual XIDs/PIDs before any teardown.
    if (writesMayHaveStarted) uncertain = true;
    try {
      persist({
        kind: 'ASYNC_CAPACITY_FIXTURE_FAILURE',
        stage: currentStage,
        errorType: error instanceof Error ? error.name : typeof error,
        databaseOutcome: writesMayHaveStarted
          ? 'UNKNOWN_SEE_INDIVIDUAL_RECEIPTS'
          : 'NO_NEW_FIXTURE_WRITES',
        uncertain,
        automaticRetry: false,
        resourcesRetainedForSoleOwner: true,
      });
    } catch {
      // Preserve the original failure; the outer owner also records the stage.
    }
    throw error;
  }
}
