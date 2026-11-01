import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { PrismaClient, Role, UserStatus, type Attachment, type Prisma } from '@prisma/client';
import appConfig from '../../src/config/app.config';
import { ActivityWorkflowGate } from '../../src/common/activity-workflow/activity-workflow.gate';
import { PrismaService } from '../../src/database/prisma.service';
import { AuthzService } from '../../src/modules/authz/authz.service';
import { ActivityTimeCorrectionCommandService } from '../../src/modules/activities/activity-time-correction-command.service';
import { ActivityTimeAllocationService } from '../../src/modules/activities/activity-time-allocation.service';
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
  createNativeLaunchLiveSource,
  nativeLaunchV3Allocation,
  assertNativeLaunchFrozenOracle,
  type NativeLaunchStage,
} from './native-launch-live.fixture';
import {
  installR5CallerTransactions,
  R5_SETMAT_CALLER,
  R5_SETMAT_CLUSTER,
  R5_SETMAT_DATABASE,
} from './r5-setmat-observation';
import { snapshotR5SetmatTables } from './r5-setmat-manifest';
import { memberIdentityData } from './member-identity.fixture';
import {
  readR5PrepareStorageReadiness,
  assertR5PrepareStorageReadiness,
  assertR5NoPolicyBranch,
  assertR5ReadClosureCatalog,
  readR5FixedActorAssignments,
  readR5ZeroAssignmentReadiness,
} from './r5-setmat-preparation-readiness';
import type { R5SetmatFixtureFactory } from './r5-setmat-concurrency-barrier';

export interface R5SetmatOwnedConfig {
  schema: 'srvf-r5-setmat-safety/v1';
  databaseOid: number;
  creatorUserId: string;
  reviewerUserId: string;
  finalReviewerUserId: string;
  organizationId: string;
  expectedCatalogPath: string;
  expectedCatalogSha256: string;
  boundPreflightBodySha256: string;
  catalogQueryPath: string;
  catalogQuerySha256: string;
  outputDirectory: string;
}

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function validateR5SetmatOwnedConfig(value: R5SetmatOwnedConfig) {
  assert.equal(value.schema, 'srvf-r5-setmat-safety/v1');
  assert(
    Number.isSafeInteger(value.databaseOid) &&
      value.databaseOid > 0 &&
      value.databaseOid <= 4294967295,
  );
  assert(![1971161, 1713092].includes(value.databaseOid));
  for (const name of [
    'creatorUserId',
    'reviewerUserId',
    'finalReviewerUserId',
    'organizationId',
  ] as const)
    assert(typeof value[name] === 'string' && value[name].length > 0);
  assert.equal(
    new Set([value.creatorUserId, value.reviewerUserId, value.finalReviewerUserId]).size,
    3,
  );
  for (const name of ['expectedCatalogPath', 'catalogQueryPath', 'outputDirectory'] as const)
    assert(typeof value[name] === 'string' && isAbsolute(value[name]));
  for (const name of [
    'expectedCatalogSha256',
    'boundPreflightBodySha256',
    'catalogQuerySha256',
  ] as const)
    assert(/^[a-f0-9]{64}$/.test(value[name]));
  return value;
}

/** Six append-only, one-person publications. Existing identities and roles are
 * resolved by exact IDs supplied by the original-machine executor. No reset,
 * permission seed, grant, existing-request prepare or database lifecycle action.
 */
export function createR5SetmatOwnedFixtureFactory(
  config: R5SetmatOwnedConfig,
): R5SetmatFixtureFactory {
  validateR5SetmatOwnedConfig(config);
  const fixedActors = {
    creator: config.creatorUserId,
    A: config.reviewerUserId,
    B: config.finalReviewerUserId,
  };
  const catalogBytes = readFileSync(config.expectedCatalogPath);
  const queryBytes = readFileSync(config.catalogQueryPath);
  assert.equal(hash(catalogBytes), config.expectedCatalogSha256);
  assert.equal(hash(queryBytes), config.catalogQuerySha256);
  assert.equal(
    queryBytes.toString(),
    readFileSync(resolve(__dirname, 'r5-setmat-catalog-query.sql'), 'utf8'),
  );
  const expectedCatalog: unknown = JSON.parse(catalogBytes.toString());
  assertR5ReadClosureCatalog(expectedCatalog);
  const catalogQuery = queryBytes.toString();
  mkdirSync(config.outputDirectory, { recursive: false });
  const runStarted = performance.now();
  let cases = 0;
  let failed = false;
  let uncertain = false;
  let receipt = 0;
  const persist = (value: unknown) => {
    const path = join(config.outputDirectory, `receipt-${String(++receipt).padStart(4, '0')}.json`);
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    return path;
  };

  return async () => {
    assert(!failed, 'an earlier fixture failure stops additional writes');
    assert(++cases <= 6, 'six fresh safety fixtures maximum');
    assert(performance.now() - runStarted < 600_000, 'safety stage600s elapsed');
    const observer = new PrismaClient({ transactionOptions: { timeout: 30_000, maxWait: 2_000 } });
    let app: Awaited<ReturnType<typeof createTestApp>> | undefined;
    let caller: PrismaClient | undefined;
    let applicationRole: ReturnType<typeof installR5CallerTransactions> | undefined;
    let secondRole: ReturnType<typeof installR5CallerTransactions> | undefined;
    try {
      // Verify the existing URL before application startup or fixture writes.
      const identities = await observer.$queryRaw<
        { cluster: string; database: string; oid: number; version: string }[]
      >`
        SELECT (SELECT system_identifier::text FROM pg_control_system()) AS cluster,
          current_database()::text AS database,
          (SELECT oid FROM pg_database WHERE datname=current_database())::int AS oid,
          current_setting('server_version_num') AS version
      `;
      assert.equal(identities.length, 1);
      assert.deepEqual(identities[0], {
        cluster: R5_SETMAT_CLUSTER,
        database: R5_SETMAT_DATABASE,
        oid: config.databaseOid,
        version: '160015',
      });
      const verifyCatalog = async () => {
        await observer.$transaction(
          async (tx) => {
            await tx.$executeRaw`SET TRANSACTION READ ONLY`;
            await tx.$executeRaw`SET LOCAL search_path=pg_catalog`;
            const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(catalogQuery);
            assert.equal(rows.length, 1);
            assert.deepEqual(Object.values(rows[0]), [expectedCatalog]);
            const body = await tx.$queryRaw<{ hash: string }[]>`
            SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') AS hash FROM pg_proc
            WHERE oid='public.r5_correction_boundary_preflight()'::regprocedure
          `;
            assert.equal(body[0]?.hash, config.boundPreflightBodySha256);
          },
          { timeout: 30_000, maxWait: 2_000 },
        );
        await observer.$transaction(
          async (tx) => {
            await tx.$executeRaw`SET LOCAL ROLE "r5_boundary_caller_h7c6"`;
            await tx.$executeRaw`SELECT public.r5_correction_boundary_preflight()`;
          },
          { timeout: 7_000, maxWait: 2_000 },
        );
      };
      await verifyCatalog();
      const storageReadiness = await readR5PrepareStorageReadiness(observer);
      persist({ kind: 'prepare-storage-readiness-before-fixture-writes', proof: storageReadiness });
      assertR5PrepareStorageReadiness(storageReadiness);
      const assignmentReadiness = await readR5ZeroAssignmentReadiness(observer, fixedActors);
      persist({
        kind: 'zero-assignment-readiness-before-fixture-writes',
        facts: assignmentReadiness,
      });
      assertR5NoPolicyBranch(assignmentReadiness);
      app = await createTestApp();
      const db = app.get(PrismaService);
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
      const [creator, a, b] = await Promise.all([
        resolveUser(config.creatorUserId),
        resolveUser(config.reviewerUserId),
        resolveUser(config.finalReviewerUserId),
      ]);
      assert.equal(creator.role, Role.SUPER_ADMIN);
      assert.equal(a.role, Role.USER);
      assert.equal(b.role, Role.USER);
      const authz = app.get(AuthzService);
      const permission = 'activity.settlement-final-review.record';
      assert.equal(
        (await authz.getExplicitVisibleOrganizationScope(a, permission, db)).hasPermission,
        false,
      );
      const bScope = await authz.getExplicitVisibleOrganizationScope(b, permission, db);
      assert(bScope.hasPermission && bScope.global);
      const prefix = 'r5_setmat_' + randomBytes(6).toString('hex');
      let sequence = 0;
      const f: E4Fixture = {
        app,
        db,
        organizationId: config.organizationId,
        key: (label) => `${prefix}_${label}_${++sequence}`,
        creator: {
          id: creator.id,
          memberId: creator.memberId,
          auth: (await loginAs(app, creator.username)).authHeader,
        },
        reviewer: {
          id: a.id,
          memberId: a.memberId,
          auth: (await loginAs(app, a.username)).authHeader,
        },
        finalReviewer: {
          id: b.id,
          memberId: b.memberId,
          auth: (await loginAs(app, b.username)).authHeader,
        },
      };
      const stage: NativeLaunchStage = async (label, work) => {
        assert(performance.now() - runStarted < 600_000, 'safety stage600s elapsed');
        const started = performance.now();
        try {
          return await work();
        } finally {
          persist({
            kind: 'fixture-stage',
            case: cases,
            label,
            elapsedMs: performance.now() - started,
            runElapsedMs: performance.now() - runStarted,
          });
        }
      };
      // Give this source its own participant so the retained fixture's prior
      // day totals cannot change the legitimate main-ledger control. Actor and
      // owner remain the actual existing creator; no user/role is rebound.
      const participant = await db.member.create({
        data: {
          memberNo: f.key('participant'),
          ...memberIdentityData('Independent setmat safety participant'),
        },
      });
      const source = await createNativeLaunchLiveSource(f, 1, stage, {
        participantMemberId: participant.id,
      });
      persist({
        kind: 'new-source',
        case: cases,
        activityId: source.activityId,
        participantMemberId: participant.id,
      });
      const preparedTime = await stage<TimeSettlementReceiptResult>('SMALL_MAIN_PREPARE', () =>
        source.post('/time-settlement/prepare', source.prepare),
      );
      const submitted = await stage<TimeSettlementReceiptResult>('SMALL_MAIN_SUBMIT', () =>
        source.post('/time-settlement/submit', {
          expectedDraftVersion: source.draft.version,
          expectedEvidenceSealId: source.expectation.expectedEvidenceSealId,
          operationKey: f.key('main_submit'),
          timeRevisionId: preparedTime.timeRevisionId,
          expectedBucketContentHash: preparedTime.bucketContentHash,
        }),
      );
      const posted = await stage('SMALL_MAIN_LEDGER_COMMIT', () => postE4Ledger(f, submitted));
      assert.equal(posted.committed.batchStatus, 'committed');
      const storedMain = await observer.ledgerPostingBatch.findUniqueOrThrow({
        where: { id: posted.batchId },
        select: { statusCode: true },
      });
      assert.equal(storedMain.statusCode, 'committed');
      const root = await observer.activitySettlementContributionRevision.findFirstOrThrow({
        where: { settlementVersionId: submitted.settlementVersionId, kindCode: 'submitted' },
      });
      await assertNativeLaunchFrozenOracle(observer, root, 4, stage);
      const segment = source.segments[0];
      assert.equal(source.segments.length, 1);
      const current = await db.participantTimeAllocationRevision.findFirstOrThrow({
        where: { sourceSegmentId: segment.id },
        orderBy: { revision: 'desc' },
      });
      const allocated = await stage('SMALL_CURRENT_BASE_RECOGNIZE', () =>
        app!.get(ActivityTimeAllocationService).recognize(
          source.activityId,
          {
            operationKey: f.key('current_allocation'),
            sourceSegmentId: segment.id,
            expectedRevision: current.revision,
            recognitionModeCode: 'automatic',
            evidenceAttachmentIds: [],
          },
          e4Actor(f.creator, true),
          E4_META,
        ),
      );
      const attachments: Attachment[] = [];
      for (const label of ['legitimate', 'late'])
        attachments.push(
          await db.$transaction(async (tx) => {
            const attachment = await tx.attachment.create({
              data: {
                key: f.key(label + '_evidence'),
                originalName: label + '.txt',
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
                key: attachment.key,
                state: 'available',
                source: 'attachment_signed_upload',
                providerType: 'LOCAL',
                localNamespace: 'r5-setmat-safety',
                expectedSize: 1n,
                actualSize: 1n,
                expectedMime: 'text/plain',
                resourceType: 'attachment',
                resourceId: attachment.id,
                verifiedAt: new Date(),
                presentAt: new Date(),
                lastProviderCheckedAt: new Date(),
              },
            });
            return attachment;
          }),
        );
      const manifest = await observer.participationTimeLedgerManifest.findUniqueOrThrow({
        where: { postingBatchId: posted.batchId },
      });
      const ledgerRoots = await observer.participationTimeLedgerEntry.findMany({
        where: { manifestId: manifest.id },
      });
      assert.equal(ledgerRoots.length, 4);
      // Install ordinary-caller routing before this NEW request's submit,
      // review and prepare. It remains active for the real HTTP commit tests.
      const beforeCorrectionBody = async (tx: Prisma.TransactionClient) => {
        const facts = await readR5FixedActorAssignments(tx, fixedActors);
        persist({ kind: 'zero-assignment-prerequisite-in-caller-transaction', facts });
        assertR5NoPolicyBranch(facts);
      };
      applicationRole = installR5CallerTransactions(db, config.databaseOid, beforeCorrectionBody);
      const human = app.get(ActivityTimeCorrectionCommandService);
      const endsAt = new Date(source.startsAt.getTime() + 20_000);
      const seconds: Record<string, number> = {
        volunteer_service: 8,
        training: 4,
        organization: 4,
        non_creditable: 4,
      };
      const request = await applicationRole.withinCaller(() =>
        stage('FRESH_HUMAN_SUBMIT', () =>
          human.submit(
            source.activityId,
            {
              participationIdentityId: segment.participationIdentityId,
              requestTypeCode: 'time',
              requestedChangeJson: {
                schemaVersion: 3,
                results: [],
                segments: [
                  {
                    participationIdentityId: segment.participationIdentityId,
                    segmentKey: segment.segmentKey,
                    checkInAt: source.startsAt.toISOString(),
                    checkOutAt: endsAt.toISOString(),
                    resultCode: 'valid',
                    serviceHours: '0.01',
                  },
                ],
                allocations: [
                  {
                    ...nativeLaunchV3Allocation({
                      participationIdentityId: segment.participationIdentityId,
                      segmentKey: segment.segmentKey,
                      baseSegmentRevisionId: segment.id,
                      baseAllocationRevisionId: allocated.allocationRevisionId,
                      startsAt: source.startsAt,
                      endsAt,
                    }),
                    evidenceAttachmentIds: [attachments[0].id],
                  },
                ],
                timeCorrection: {
                  baseSettlementVersionId: submitted.settlementVersionId,
                  baseTimeLedgerHash: manifest.contentHash,
                  reason: 'Independent small setmat safety source',
                  items: ledgerRoots.map((row) => ({
                    rootEntryId: row.id,
                    recognizedSeconds: seconds[row.categoryCode],
                  })),
                },
              },
              reason: 'Independent small setmat safety source',
              operationKey: f.key('fresh_request'),
            },
            e4Actor(f.creator, true),
            E4_META,
          ),
        ),
      );
      const reviewed = await applicationRole.withinCaller(() =>
        stage('FRESH_HUMAN_REVIEW', () =>
          human.review(
            source.activityId,
            request.requestId,
            { actionCode: 'approve', expectedRequestVersion: request.requestVersion },
            e4Actor(f.finalReviewer),
            E4_META,
          ),
        ),
      );
      assert.equal(reviewed.outcome, 'reviewed');
      const operationKey = f.key('fresh_prepare');
      persist({
        kind: 'new-reviewed-request-before-prepare',
        case: cases,
        activityId: source.activityId,
        requestId: request.requestId,
        operationKey,
        baseSettlementVersionId: request.baseSettlementVersionId,
      });
      // Observe the actual domain prepare transaction only. Human.prepare's
      // subsequent readPreparedHashes array query is separate readback, and
      // cannot be confused with the write transaction's COMMIT/ROLLBACK.
      const corrections = app.get(CorrectionApplicationService);
      const prepareOriginal = corrections.prepare.bind(corrections);
      const prepareRouting = applicationRole;
      const prepareObservation = jest
        .spyOn(corrections, 'prepare')
        .mockImplementation(async (...args) => {
          const attempt = await prepareRouting.observe(
            observer,
            'FIXTURE_HUMAN_PREPARE_ROOT',
            () => prepareOriginal(...args),
            persist,
          );
          if (attempt.databaseOutcome === 'UNKNOWN' || !attempt.observationComplete) failed = true;
          if (attempt.databaseOutcome === 'UNKNOWN') uncertain = true;
          if (attempt.client.status === 'rejected') throw attempt.client.reason;
          assert.equal(
            attempt.databaseOutcome,
            'COMMITTED',
            'prepare root needs independent server COMMIT proof',
          );
          assert.equal(attempt.observationComplete, true);
          return attempt.client.value;
        });
      const prepareFresh = () =>
        stage('FRESH_HUMAN_PREPARE', () =>
          human.prepare(
            source.activityId,
            request.requestId,
            { operationKey, expectedBaseSettlementVersionId: request.baseSettlementVersionId },
            e4Actor(f.finalReviewer),
            E4_META,
          ),
        );
      const prepared = await (async () => {
        try {
          return await prepareFresh();
        } finally {
          prepareObservation.mockRestore();
        }
      })();
      assert.equal(prepared.replayed, false);
      const pending = await db.correctionPendingTimeAllocation.findMany({
        where: { applicationId: prepared.applicationId },
      });
      assert.equal(pending.length, 1);
      assert.equal(
        await db.correctionPendingTimeAllocationEvidence.count({
          where: { pendingAllocationId: pending[0].id },
        }),
        1,
      );
      caller = new PrismaClient();
      secondRole = installR5CallerTransactions(caller, config.databaseOid, beforeCorrectionBody);
      const first = applicationRole;
      const second = secondRole;
      persist({
        kind: 'fresh-prepared-fixture',
        case: cases,
        activityId: source.activityId,
        requestId: request.requestId,
        applicationId: prepared.applicationId,
        postingBatchId: prepared.postingBatchId,
        sourceCount: 1,
        delta: 1,
        ordinaryCaller: R5_SETMAT_CALLER,
        reset: false,
        roleGrantOrMembershipChanges: false,
      });
      return {
        app,
        callerDb: caller,
        observerDb: observer,
        a: { id: a.id, username: a.username },
        b: { id: b.id, username: b.username },
        activityId: source.activityId,
        requestId: request.requestId,
        command: {
          operationKey,
          expectedBaseSettlementVersionId: request.baseSettlementVersionId,
          correctionApplicationId: prepared.applicationId,
          postingBatchId: prepared.postingBatchId,
        },
        lateEvidence: {
          id: randomUUID(),
          pendingAllocationId: pending[0].id,
          activityId: source.activityId,
          attachmentId: attachments[1].id,
          ordinal: 1,
        },
        verifyCandidate: verifyCatalog,
        observe: async (label, operation) => {
          const attempt = await (
            label === 'T2 ordinary caller child INSERT' ? second : first
          ).observe(observer, label, operation, persist);
          if (attempt.databaseOutcome === 'UNKNOWN' || !attempt.observationComplete) failed = true;
          if (attempt.databaseOutcome === 'UNKNOWN') uncertain = true;
          if (attempt.databaseOutcome !== 'UNKNOWN' && attempt.observationComplete) {
            try {
              const facts = await readR5ZeroAssignmentReadiness(observer, fixedActors);
              persist({ kind: 'zero-assignment-prerequisite-after-observed-attempt', facts });
              assertR5NoPolicyBranch(facts);
            } catch (error) {
              failed = true;
              throw error;
            }
          }
          return attempt;
        },
        snapshotBusinessState: () => snapshotR5SetmatTables(observer),
        recordCoverage: (branch) => {
          persist({ kind: 'coverage', case: cases, branch });
        },
        restoreObservation: () => {
          assert(
            !uncertain,
            'database outcome UNKNOWN: retain owned resources and inspect recorded XIDs before teardown',
          );
          first.restore();
          second.restore();
        },
      };
    } catch (error) {
      failed = true;
      persist({
        kind: 'fixture-failed',
        case: cases,
        name: error instanceof Error ? error.name : 'UNKNOWN',
      });
      if (uncertain) throw error;
      applicationRole?.restore();
      secondRole?.restore();
      const closed = await Promise.allSettled([
        app?.close(),
        caller?.$disconnect(),
        observer.$disconnect(),
      ]);
      if (closed.some((item) => item.status === 'rejected'))
        throw new AggregateError([error], 'R5 fixture failure; resource close incomplete');
      throw error;
    }
  };
}
