import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { PrismaClient, Role, UserStatus, type Prisma } from '@prisma/client';
import appConfig from '../../src/config/app.config';
import { ActivityWorkflowGate } from '../../src/common/activity-workflow/activity-workflow.gate';
import { PrismaService } from '../../src/database/prisma.service';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { JwtStrategy } from '../../src/modules/auth/strategies/jwt.strategy';
import type { Server, IncomingMessage } from 'node:http';
import { AuthzService } from '../../src/modules/authz/authz.service';
import { ActivityTimeCorrectionCommandService } from '../../src/modules/activities/activity-time-correction-command.service';
import { CorrectionApplicationService } from '../../src/modules/activities/correction-application.service';
import { ActivityTimeSettlementService } from '../../src/modules/activities/activity-time-settlement.service';
import { ActivityTimeSettlementQueryService } from '../../src/modules/activities/activity-time-settlement-query.service';
import { ActivityContributionSettlementService } from '../../src/modules/activities/activity-contribution-settlement.service';
import { ActivityContributionSettlementQueryService } from '../../src/modules/activities/activity-contribution-settlement-query.service';
import { ActivityTimeSettlementAccessService } from '../../src/modules/activities/activity-time-settlement-access.service';
import { ActivityTimeSettlementAuditRecorder } from '../../src/modules/activities/activity-time-settlement-audit-recorder';
import { installR5MainPrepareProfile } from './r5-main-prepare-profile';
import { probeR5MainFunctionStatsReadOnly } from './r5-main-function-stats';
import { readR5E4RowDomainReadiness } from './r5-e4-row-domain-readiness';
import {
  assertR5BackendBoundary,
  readR5OwnedBackend,
  type R5BackendPolicy,
} from './r5-setmat-backend-boundary';
import { R5_NATIVE_ONLY_SCOPE, verifyR5NativeOnlyEvidence } from './r5-setmat-native-only';
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
  nativeLaunchV3Allocation,
  assertNativeLaunchFrozenOracle,
  type NativeLaunchStage,
} from './native-launch-live.fixture';
import {
  installR5CallerTransactions,
  R5_SETMAT_CLUSTER,
  R5_SETMAT_DATABASE,
} from './r5-setmat-observation';
import { snapshotR5SetmatTables } from './r5-setmat-manifest';
import {
  verifyR5SeparatedFailure,
  R5_SEPARATED_SCOPE,
  type R5RollbackObservationPolicy,
} from './r5-setmat-separated-policy';
import {
  readR5PrepareStorageReadiness,
  assertR5PrepareStorageReadiness,
  assertR5NoPolicyBranch,
  assertR5ReadClosureCatalog,
  readR5FixedActorAssignments,
  readR5ZeroAssignmentReadiness,
} from './r5-setmat-preparation-readiness';
import { validateR5SetmatOwnedConfig, type R5SetmatOwnedConfig } from './r5-setmat-owned-fixture';
import {
  capacityClock,
  capacityConfig,
  capacityHash,
  type CapacityConfig,
} from './r5-setmat-capacity.protocol';
import {
  createR5CapacityLiveSource,
  recognizeR5CapacityCommittedSources,
} from './r5-setmat-capacity-source.fixture';
import { buildNativeCapacityCorrectionShape } from './native-capacity-change-shape';
import { capacityTerminalReceipt, capacityDiagnostics } from './r5-setmat-capacity.measurement';
import { writeR5DurableReceipt } from './r5-setmat-durable-receipt';
import {
  R5_COMPONENT_ORIGIN,
  readR5PreparedContinuation,
  verifyR5ComponentOrigin,
} from './r5-setmat-component-continuation';

export async function withR5CapacityFixture<T>(
  capacity: CapacityConfig,
  run: (fixture: R5CapacityFixture) => Promise<T>,
  mainPrepareOnly?: {
    finish: (
      receipt: TimeSettlementReceiptResult,
      profile: MainPrepareProfileSnapshot,
    ) => T | Promise<T>;
  },
): Promise<T> {
  capacityConfig(capacity);
  const backendPolicy: R5BackendPolicy = 'STRICT_ALL';
  if (capacity.continuation || capacity.separatedComponent || capacity.nativeOnly) {
    assert(!mainPrepareOnly, 'continuation never prepares');
    const evidence =
      capacity.nativeOnly?.originalEvidenceDirectory ??
      capacity.separatedComponent?.originalEvidenceDirectory ??
      capacity.continuation?.retainedEvidenceDirectory;
    assert(evidence);
    verifyR5ComponentOrigin(evidence);
    if (capacity.separatedComponent)
      verifyR5SeparatedFailure(capacity.separatedComponent.failedEvidenceDirectory);
  }
  if (capacity.nativeOnly) verifyR5NativeOnlyEvidence(capacity.nativeOnly.evidenceDirectory);
  const config: R5SetmatOwnedConfig = validateR5SetmatOwnedConfig(capacity.base);
  assert(isAbsolute(capacity.outputDirectory));
  const fixedActors = {
    creator: config.creatorUserId,
    A: config.reviewerUserId,
    B: config.finalReviewerUserId,
  };
  const catalogBytes = readFileSync(config.expectedCatalogPath),
    queryBytes = readFileSync(config.catalogQueryPath);
  assert.equal(capacityHash(catalogBytes), config.expectedCatalogSha256);
  assert.equal(capacityHash(queryBytes), config.catalogQuerySha256);
  assert.equal(
    queryBytes.toString(),
    readFileSync(resolve(__dirname, 'r5-setmat-catalog-query.sql'), 'utf8'),
  );
  const expectedCatalog: unknown = JSON.parse(catalogBytes.toString());
  assertR5ReadClosureCatalog(expectedCatalog);
  const catalogQuery = queryBytes.toString();
  mkdirSync(capacity.outputDirectory, { recursive: false });
  let sequenceReceipt = 0,
    uncertain = false,
    setupComplete = false,
    mainDiagnosticSettled = false,
    writesMayHaveStarted = false;
  const persist = (value: unknown) => {
    const path = join(
      capacity.outputDirectory,
      `receipt-${String(++sequenceReceipt).padStart(4, '0')}.json`,
    );
    return writeR5DurableReceipt(path, value);
  };
  let currentPhase = 'PRECONDITIONS';
  let originalFailure = false;
  let primaryError: unknown;
  let cleanupFailed = false;
  let cleanupError: unknown;
  let completedValue!: T;
  const requests = new WeakSet<object>();
  const diagnostic = capacityDiagnostics(
    persist,
    () => currentPhase,
    () => [process.env.DATABASE_URL ?? '', process.env.JWT_SECRET ?? ''],
  );
  let restoreFilter: (() => void) | undefined;
  const traceRequest = (request: IncomingMessage) => {
    requests.add(request);
  };
  persist({
    kind: 'single-use-capacity-attempt',
    mode: capacity.mode,
    window: capacity.window,
    oldWindowClosed: true,
  });
  const observer = new PrismaClient({ transactionOptions: { timeout: 30000, maxWait: 2000 } });
  let app: Awaited<ReturnType<typeof createTestApp>> | undefined;
  let routing: ReturnType<typeof installR5CallerTransactions> | undefined;
  let held = false,
    leasePid: number | undefined;
  const existingUrl = process.env.DATABASE_URL;
  assert(existingUrl);
  const leaseUrl = new URL(existingUrl);
  leaseUrl.pathname = '/postgres';
  leaseUrl.searchParams.set('connection_limit', '1');
  const lease = new PrismaClient({ datasourceUrl: leaseUrl.toString() });
  const leaseKey = 'SRVF:test:D3:app_test_w98';
  const acquireLease = async () => {
    capacityClock(capacity, Date.now(), 120000);
    const rows = await lease.$queryRaw<
      { cluster: string; pid: number; database: string; locked: boolean }[]
    >`
      SELECT (SELECT system_identifier::text FROM pg_control_system()) AS cluster,pg_backend_pid() AS pid,
        current_database()::text AS database,pg_try_advisory_lock(hashtextextended(${leaseKey},0)) AS locked`;
    // Record a successful acquisition even if an identity assertion fails.
    held = rows[0]?.locked === true;
    leasePid = rows[0]?.pid;
    persist({ kind: 'capacity-lease', rows });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cluster, R5_SETMAT_CLUSTER);
    assert.equal(rows[0].database, 'postgres');
    assert.equal(held, true, 'original experiment lease unavailable');
  };
  const phaseStarted = performance.now();
  const checkpoint = () => {
    capacityClock(capacity, Date.now(), 5000);
    assert(
      performance.now() - phaseStarted + 5000 < 600000,
      'phase600s includes owned exit reserve5s',
    );
  };
  const stage: NativeLaunchStage = async <V>(label: string, work: () => Promise<V>): Promise<V> => {
    const start = performance.now();
    const previous = currentPhase;
    currentPhase = label;
    let rejected = false;
    let failure: unknown;
    let value!: V;
    try {
      persist({
        kind: 'fixture-stage-start',
        label,
        wallTime: new Date().toISOString(),
        phaseElapsedMs: start - phaseStarted,
      });
      checkpoint();
      capacityClock(capacity, Date.now(), 125000);
      assert(
        performance.now() - phaseStarted + 125000 < 600000,
        'reserve native120s and owned exit5s before next setup stage',
      );
      value = await diagnostic.run(label, work);
      diagnostic.assertHealthy();
    } catch (error) {
      rejected = true;
      failure = error;
      diagnostic.emit({ event: 'STAGE_REJECTED', label, error: diagnostic.error(error) });
    }
    try {
      persist({
        kind: 'fixture-stage',
        label,
        elapsedMs: performance.now() - start,
        phaseElapsedMs: performance.now() - phaseStarted,
      });
      checkpoint();
    } catch (cause) {
      diagnostic.emit({
        event: 'STAGE_FINALIZER_REJECTED',
        label,
        error: diagnostic.error(cause),
      });
      if (!rejected) {
        rejected = true;
        failure = cause;
      }
    } finally {
      currentPhase = previous;
    }
    if (rejected) throw failure;
    return value;
  };
  try {
    restoreFilter = diagnostic.filter(AllExceptionsFilter.prototype, (host) =>
      requests.has(host.switchToHttp().getRequest<object>()),
    );
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
    await acquireLease();
    if (capacity.continuation || capacity.separatedComponent || capacity.nativeOnly) {
      assert(leasePid);
      await assertR5BackendBoundary(
        observer,
        undefined,
        leasePid,
        backendPolicy,
        persist,
        'BEFORE_APPLICATION',
      );
    }
    if (capacity.separatedComponent || capacity.nativeOnly) {
      const originSnapshot = await stage('SEPARATED_HISTORICAL_FULL_MANIFEST_BEFORE_LOGIN', () =>
        snapshotR5SetmatTables(observer),
      );
      persist({ kind: 'SEPARATED_HISTORICAL_FULL_MANIFEST', snapshot: originSnapshot });
      assert.equal(
        originSnapshot.hash,
        capacity.nativeOnly
          ? R5_NATIVE_ONLY_SCOPE.historicalFullManifestHash
          : R5_SEPARATED_SCOPE.failedFullManifestHash,
        'exact failed-comparison rollback state required before any new login writes',
      );
    }
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
    assert.equal(
      await observer.activityBatchJob.count({
        where: { statusCode: { in: ['pending', 'processing'] } },
      }),
      0,
      'retained queued jobs forbid capacity fixture startup',
    );
    const storageReadiness = await readR5PrepareStorageReadiness(observer);
    persist({ kind: 'prepare-storage-readiness-before-fixture-writes', proof: storageReadiness });
    assertR5PrepareStorageReadiness(storageReadiness);
    const assignmentReadiness = await readR5ZeroAssignmentReadiness(observer, fixedActors);
    persist({
      kind: 'zero-assignment-readiness-before-fixture-writes',
      facts: assignmentReadiness,
    });
    assertR5NoPolicyBranch(assignmentReadiness);
    writesMayHaveStarted = true;
    app = await stage('TEST_APP_CONSTRUCTION', createTestApp);
    (app.getHttpServer() as Server).prependListener('request', traceRequest);
    const db = app.get(PrismaService);
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
    const prefix = 'r5_capacity_' + randomBytes(6).toString('hex');
    let sequence = 0;
    const loginStartedAt = new Date();
    const f: E4Fixture = {
      app,
      db,
      organizationId: config.organizationId,
      key: (label) => `${prefix}_${label}_${++sequence}`,
      creator: {
        id: creator.id,
        memberId: creator.memberId,
        auth: (await stage('CREATOR_REAL_LOGIN', () => loginAs(app!, creator.username))).authHeader,
      },
      reviewer: {
        id: a.id,
        memberId: a.memberId,
        auth: (await stage('A_REAL_LOGIN', () => loginAs(app!, a.username))).authHeader,
      },
      finalReviewer: {
        id: b.id,
        memberId: b.memberId,
        auth: (await stage('B_REAL_LOGIN', () => loginAs(app!, b.username))).authHeader,
      },
    };

    if (capacity.separatedComponent || capacity.nativeOnly) {
      const loginFence = await db.$queryRaw<{ count: number; settled: number }[]>`
        SELECT count(*)::int AS count,
          count(*) FILTER(WHERE "lastLoginAt">=${loginStartedAt})::int AS settled
        FROM public."User" WHERE id IN(${creator.id},${a.id},${b.id})`;
      assert.deepEqual(
        loginFence,
        [{ count: 3, settled: 3 }],
        'all original login updates must be visible before the new comparison baseline',
      );
      persist({
        kind: 'SEPARATED_REAL_LOGINS_SETTLED',
        loginFence,
        historicalFullManifestWasCheckedBeforeLogin: true,
        authenticationWritesRetained: true,
      });
    }
    const beforeBody = async (tx: Prisma.TransactionClient) => {
      const facts = await readR5FixedActorAssignments(tx, fixedActors);
      persist({ kind: 'zero-assignment-in-transaction', facts });
      assertR5NoPolicyBranch(facts);
    };
    routing = installR5CallerTransactions(db, config.databaseOid, beforeBody, persist);
    const route = routing;
    let lastObservation: unknown;
    const observe = async <V>(
      label: string,
      operation: () => Promise<V>,
      rollbackPolicy?: R5RollbackObservationPolicy,
    ) => {
      if (rollbackPolicy) {
        assert(capacity.separatedComponent || capacity.nativeOnly);
        assert.equal(
          rollbackPolicy.authorizationReference,
          (capacity.nativeOnly?.authorization ?? capacity.separatedComponent!.authorization)
            .reference,
        );
      }
      checkpoint();
      let attempt: Awaited<ReturnType<typeof route.observe<V>>>;
      try {
        attempt = await route.observe(
          observer,
          label,
          operation,
          (value) => {
            lastObservation = value;
            return persist(value);
          },
          rollbackPolicy,
        );
      } catch (error) {
        // A missing final durable receipt is not evidence that the transaction
        // rolled back; retain ownership for the independent closeout protocol.
        uncertain = true;
        throw error;
      }
      if (attempt.client.status === 'rejected')
        diagnostic.emit({
          event: 'OBSERVED_NATIVE_REJECTION',
          label,
          error: diagnostic.error(attempt.client.reason),
        });
      if (attempt.databaseOutcome === 'UNKNOWN' || !attempt.observationComplete) uncertain = true;
      checkpoint();
      return attempt;
    };
    const committed = async <V>(label: string, operation: () => Promise<V>, budget: number) => {
      const attempt = await observe(label, operation);
      assert.equal(
        attempt.databaseOutcome,
        'COMMITTED',
        'independent server COMMIT proof required',
      );
      assert.equal(attempt.observationComplete, true);
      assert.equal(attempt.configuredTimeoutMs, budget);
      if (attempt.client.status === 'rejected') throw attempt.client.reason;
      assert(
        capacityTerminalReceipt(lastObservation, 'commit').transactionPromiseElapsedMs <= budget,
        'native transaction budget includes settlement',
      );
      return attempt.client.value;
    };
    const corrections = app.get(CorrectionApplicationService);
    const human = app.get(ActivityTimeCorrectionCommandService);
    if (mainPrepareOnly) {
      const readiness = await stage('FUNCTION_STATS_READONLY_PREFLIGHT', () =>
        observer.$transaction(
          async (tx) => {
            await tx.$executeRaw`SET TRANSACTION READ ONLY`;
            await tx.$executeRaw`SET LOCAL statement_timeout='2s'`;
            return await probeR5MainFunctionStatsReadOnly(tx);
          },
          { timeout: 3000, maxWait: 1000 },
        ),
      );
      persist(readiness);
    }
    if (capacity.continuation || capacity.separatedComponent || capacity.nativeOnly) {
      const retained = await stage('EXACT_COMMITTED_PREPARE_READONLY', () =>
        readR5PreparedContinuation(observer, config),
      );
      persist(retained.summary);
      await assertNativeLaunchFrozenOracle(observer, retained.root, 8000, stage);
      await verifyCatalog();
      checkpoint();
      setupComplete = true;
      capacityClock(capacity, Date.now(), 125000);
      assert(
        performance.now() - phaseStarted + 125000 < 600000,
        'reserve component120s and owned exit5s inside new continuation phase600s',
      );
      const o = R5_COMPONENT_ORIGIN;
      completedValue = await run({
        db,
        observer,
        corrections,
        human,
        stage,
        persist,
        observe,
        getLastObservation: () => lastObservation,
        checkpoint,
        verifyCatalog,
        commit: () =>
          human.commit(
            o.activityId,
            o.requestId,
            {
              operationKey: o.operationKey,
              expectedBaseSettlementVersionId: retained.baseSettlementVersionId,
              correctionApplicationId: o.applicationId,
              postingBatchId: o.postingBatchId,
            },
            e4Actor(f.finalReviewer),
            E4_META,
          ),
        delta: 1000,
        activityId: o.activityId,
        applicationId: o.applicationId,
        postingBatchId: o.postingBatchId,
        root: retained.root,
        runId: capacity.window.id,
        snapshot: () => snapshotR5SetmatTables(observer),
        assertRetainedState: async () => {
          const current = await readR5PreparedContinuation(observer, config);
          assert.deepEqual(current.summary, retained.summary);
          const xids = await observer.$queryRaw<
            { xid: string; status: string | null }[]
          >`SELECT xid,pg_xact_status(xid::xid8) AS status FROM (VALUES ('158897'),('158922')) AS x(xid) ORDER BY xid`;
          assert.deepEqual(xids, [
            { xid: '158897', status: 'committed' },
            { xid: '158922', status: 'aborted' },
          ]);
          if (capacity.nativeOnly) {
            const diagnostic = await observer.$queryRaw<
              { status: string | null }[]
            >`SELECT pg_xact_status('158936'::xid8) AS status`;
            assert.deepEqual(diagnostic, [{ status: 'aborted' }]);
            persist({ kind: 'NATIVE_ONLY_DIAGNOSTIC_XID_RECHECK', diagnostic });
          }
          persist({ kind: 'SEPARATED_RETAINED_STATE', summary: current.summary, xids });
        },
        assertExclusiveBoundary: async () => {
          assert(held && leasePid);
          await assertR5BackendBoundary(
            observer,
            await readR5OwnedBackend(db),
            leasePid,
            backendPolicy,
            persist,
            'MEASUREMENT_BOUNDARY',
          );
        },
      });
      const after = await stage('RETAINED_PREPARE_AFTER_COMPONENT_READONLY', () =>
        readR5PreparedContinuation(observer, config),
      );
      assert.deepEqual(
        after.summary,
        retained.summary,
        'retained prepared inputs/ledger/results must remain exactly unchanged',
      );
      persist({ kind: 'CONTINUATION_RETAINED_INPUTS_UNCHANGED', summary: after.summary });
      await verifyCatalog();
      checkpoint();
    } else {
      const source = await createR5CapacityLiveSource(f, stage, (response, entry) =>
        diagnostic.http(response, entry),
      );
      persist({
        kind: 'NEW-capacity-source',
        activityId: source.activityId,
        participants: 2000,
        sourceCount: source.segments.length,
        allParticipantsNew: true,
      });
      completedValue = await (async (): Promise<T> => {
        let profile: ReturnType<typeof installR5MainPrepareProfile> | undefined;
        let sampling = false;
        let sampleTask: Promise<void> | undefined;
        let sampleCount = 0;
        let sampleQueryMs = 0;
        let sampleFailure: unknown;
        const stopSampling = async () => {
          sampling = false;
          await sampleTask;
        };
        if (mainPrepareOnly) {
          profile = installR5MainPrepareProfile(
            {
              prisma: db,
              timeSettlement: app.get(ActivityTimeSettlementService),
              timeQueries: app.get(ActivityTimeSettlementQueryService),
              contributions: app.get(ActivityContributionSettlementService),
              contributionQueries: app.get(ActivityContributionSettlementQueryService),
              access: app.get(ActivityTimeSettlementAccessService),
              audit: app.get(ActivityTimeSettlementAuditRecorder),
            },
            {
              activityId: source.activityId,
              collectNativeFunctionStats: true,
              persist,
              onIdentity: (identity) => {
                persist({ kind: 'MAIN_PREPARE_RUNTIME_IDENTITY', identity });
                sampling = true;
                sampleTask = (async () => {
                  while (sampling && sampleCount < 70) {
                    const started = performance.now();
                    const rows = await observer.$transaction(
                      async (tx) => {
                        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
                        await tx.$executeRaw`SET LOCAL statement_timeout='2s'`;
                        return await tx.$queryRaw<{ evidence: Record<string, unknown> }[]>`
                        SELECT jsonb_build_object('kind','MAIN_PREPARE_EXACT_PID_SAMPLE',
                          'at',clock_timestamp(),'database',current_database(),
                          'databaseOid',(SELECT oid::int FROM pg_database WHERE datname=current_database()),
                          'requestedPid',${identity.pid}::int,'present',a.pid IS NOT NULL,
                          'pid',a.pid,'state',a.state,'backendXid',a.backend_xid::text,
                          'queryId',a.query_id::text,'waitType',a.wait_event_type,'waitEvent',a.wait_event,
                          'queryAgeMs',extract(epoch FROM (clock_timestamp()-a.query_start))*1000,
                          'xactAgeMs',extract(epoch FROM (clock_timestamp()-a.xact_start))*1000,
                          'querySha256',encode(sha256(convert_to(coalesce(a.query,''),'UTF8')),'hex'),
                          'isCommit',btrim(a.query)='COMMIT','isRollback',btrim(a.query)='ROLLBACK',
                          'blockers',(SELECT coalesce(jsonb_agg(b.pid ORDER BY b.pid),'[]'::jsonb)
                            FROM pg_stat_activity b WHERE b.datid=a.datid AND b.pid=ANY(pg_blocking_pids(a.pid)))) AS evidence
                        FROM (SELECT ${identity.pid}::int AS pid) wanted
                        LEFT JOIN pg_stat_activity a ON a.datid=1998913 AND a.pid=wanted.pid
                      `;
                      },
                      { timeout: 3000, maxWait: 1000 },
                    );
                    assert.equal(rows.length, 1);
                    sampleCount++;
                    sampleQueryMs += performance.now() - started;
                    diagnostic.emit(rows[0].evidence);
                    if (sampling) await new Promise<void>((resolve) => setTimeout(resolve, 1000));
                  }
                })().catch((error: unknown) => {
                  sampleFailure = error;
                  diagnostic.emit({
                    event: 'MAIN_PID_SAMPLE_REJECTED',
                    error: diagnostic.error(error),
                  });
                });
              },
              observeOutcome: async (identity) => {
                await stopSampling();
                return await observer.$transaction(
                  async (tx) => {
                    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
                    await tx.$executeRaw`SET LOCAL statement_timeout='2s'`;
                    const rows = await tx.$queryRaw<{ evidence: unknown }[]>`
            SELECT jsonb_build_object('database',current_database(),
              'databaseOid',(SELECT oid::int FROM pg_database WHERE datname=current_database()),
              'cluster',(SELECT system_identifier::text FROM pg_control_system()),
              'observerPid',pg_backend_pid(),'xid',${identity.xid}::text,
              'status',pg_xact_status(${identity.xid}::xid8)) AS evidence
          `;
                    assert.equal(rows.length, 1);
                    return rows[0].evidence;
                  },
                  { timeout: 3000, maxWait: 1000 },
                );
              },
            },
          );
        }
        let preparedTime!: TimeSettlementReceiptResult;
        let mainRejected = false;
        let mainError: unknown;
        try {
          preparedTime = await stage<TimeSettlementReceiptResult>('MAIN_PREPARE', () =>
            source.post('/time-settlement/prepare', source.prepare),
          );
        } catch (error) {
          mainRejected = true;
          mainError = error;
        }
        await stopSampling();
        if (mainPrepareOnly) {
          diagnostic.emit({
            kind: 'MAIN_PREPARE_SAMPLE_SUMMARY',
            samples: sampleCount,
            queryWallMs: sampleQueryMs,
            maxSamples: 70,
            minimumIntervalMs: 1000,
            failed: sampleFailure !== undefined,
            logicalClientSpansAreNotPhysicalSqlCounts: true,
          });
        }
        const mainSnapshot = profile?.snapshot();
        mainDiagnosticSettled = mainPrepareOnly !== undefined && mainSnapshot?.complete === true;
        if (profile) {
          diagnostic.emit({ kind: 'MAIN_PREPARE_PROFILE_COMPLETENESS', profile: mainSnapshot });
          try {
            profile.restore();
          } catch (error) {
            diagnostic.emit({
              event: 'MAIN_PROFILE_RESTORE_REJECTED',
              error: diagnostic.error(error),
            });
            if (!mainRejected) {
              mainRejected = true;
              mainError = error;
            }
          }
        }
        if (mainRejected) throw mainError;
        if (mainPrepareOnly) {
          assert(
            mainSnapshot?.complete,
            'MAIN_PREPARE diagnostic incomplete; no next business operation',
          );
          assert.equal(
            mainSnapshot?.nativeFunctionStats?.complete,
            true,
            'native function-statistics coverage incomplete',
          );
          assert.equal(sampleFailure, undefined, 'exact-PID sampling incomplete');
          assert.equal(
            (mainSnapshot.independentServer as { status?: unknown } | undefined)?.status,
            'committed',
            'successful MAIN_PREPARE must have an independently committed transaction',
          );
          const mainRoot = await observer.activitySettlementContributionRevision.findFirstOrThrow({
            where: {
              activityId: source.activityId,
              timeRevisionId: preparedTime.timeRevisionId,
              kindCode: 'draft',
            },
          });
          const frozenOracle = await assertNativeLaunchFrozenOracle(
            observer,
            mainRoot,
            8000,
            stage,
          );
          persist({
            kind: 'MAIN_PREPARE_FROZEN_ORACLE_PASS',
            rootId: mainRoot.id,
            expectedEvaluationCount: 8000,
            frozenOracle,
            source: 'unchanged frozen canonical/root/day oracle',
          });
          diagnostic.assertHealthy();
          persist({
            kind: 'MAIN_PREPARE_ONLY_STOP',
            nativeMainSucceeded: true,
            mainSubmitExecuted: false,
            ledgerExecuted: false,
            correctionExecuted: false,
          });
          return await mainPrepareOnly.finish(preparedTime, mainSnapshot);
        }
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
              { correctionRequestId: unchangedRequest.correctionRequestId, actionCode: 'approve' },
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
        const allocations = await recognizeR5CapacityCommittedSources(f, source, stage);
        assert.equal(allocations.length, 10000);
        const bySource = new Map(allocations.map((row) => [row.sourceSegmentId, row]));
        assert.equal(bySource.size, 10000);
        const attachment = await db.$transaction(async (tx) => {
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
        });
        const delta = capacity.mode === 'component1000' ? 1000 : 10000;
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
          new Set(
            roots.map((row) => JSON.stringify([row.participationIdentityId, row.categoryCode])),
          ).size,
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
        await verifyCatalog();
        checkpoint();
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
        // Entire fresh fixture plus measurement stays in this phase600s.
        capacityClock(capacity, Date.now(), 125000);
        assert(
          performance.now() - phaseStarted + 125000 < 600000,
          'reserve measurement120s and owned exit5s inside same600s phase',
        );
        setupComplete = true;
        const commit = () =>
          human.commit(
            source.activityId,
            request.requestId,
            {
              operationKey,
              expectedBaseSettlementVersionId: request.baseSettlementVersionId,
              correctionApplicationId: prepared.applicationId,
              postingBatchId: prepared.postingBatchId,
            },
            e4Actor(f.finalReviewer),
            E4_META,
          );
        const value = await run({
          db,
          observer,
          corrections,
          human,
          stage,
          persist,
          observe,
          getLastObservation: () => lastObservation,
          checkpoint,
          verifyCatalog,
          commit,
          delta,
          activityId: source.activityId,
          applicationId: prepared.applicationId,
          postingBatchId: prepared.postingBatchId,
          root,
          runId: prefix,
          snapshot: () => snapshotR5SetmatTables(observer),
        });
        checkpoint();
        await verifyCatalog();
        return value;
      })();
    }
  } catch (error) {
    originalFailure = true;
    primaryError = error;
    // Setup contains native multi-transaction source work. A failure there
    // must not be represented as a proven rollback of unobserved transactions.
    if (!setupComplete && writesMayHaveStarted && !mainDiagnosticSettled) uncertain = true;
    diagnostic.emit({
      kind: 'capacity-stopped',
      databaseOutcome: uncertain
        ? 'UNKNOWN'
        : writesMayHaveStarted
          ? 'SEE_INDIVIDUAL_RECEIPTS'
          : 'NO_NEW_FIXTURE_WRITES',
      errorType: error instanceof Error ? error.name : typeof error,
      error: diagnostic.error(error),
      automaticRetry: false,
    });
  } finally {
    try {
      if (uncertain) {
        diagnostic.emit({
          kind: 'UNKNOWN-resources-retained',
          leasePid,
          automaticTeardown: false,
          next: 'inspect exact recorded XIDs; no replay or cancel',
        });
      } else {
        routing?.restore();
        await app?.close();
        if (held) {
          assert(leasePid);
          await assertR5BackendBoundary(
            observer,
            undefined,
            leasePid,
            backendPolicy,
            persist,
            'FINAL_BEFORE_UNLOCK',
          );
        } else {
          await assertR5BackendBoundary(
            observer,
            undefined,
            undefined,
            'STRICT_ALL',
            persist,
            'FINAL_BEFORE_LEASE_WAS_ACQUIRED',
          );
        }
        if (held) {
          const unlocked = await lease.$queryRaw<
            { pid: number; unlocked: boolean }[]
          >`SELECT pg_backend_pid() AS pid,pg_advisory_unlock(hashtextextended(${leaseKey},0)) AS unlocked`;
          assert.deepEqual(unlocked, [{ pid: leasePid, unlocked: true }]);
          persist({ kind: 'capacity-lease-released', unlocked });
        }
        await observer.$disconnect();
        await lease.$disconnect();
      }
    } catch (cause) {
      diagnostic.emit({ event: 'RESOURCE_FINALIZER_REJECTED', error: diagnostic.error(cause) });
      cleanupFailed = true;
      cleanupError = cause;
    } finally {
      try {
        if (app) (app.getHttpServer() as Server).removeListener('request', traceRequest);
        restoreFilter?.();
      } catch (cause) {
        diagnostic.emit({ event: 'DIAGNOSTIC_RESTORE_REJECTED', error: diagnostic.error(cause) });
        if (!cleanupFailed) {
          cleanupFailed = true;
          cleanupError = cause;
        }
      }
    }
  }
  if (originalFailure) throw primaryError;
  if (cleanupFailed) throw cleanupError;
  diagnostic.assertHealthy();
  return completedValue;
}

export type MainPrepareProfileSnapshot = ReturnType<
  ReturnType<typeof installR5MainPrepareProfile>['snapshot']
>;

export interface R5CapacityFixture {
  db: PrismaService;
  observer: PrismaClient;
  corrections: CorrectionApplicationService;
  human: ActivityTimeCorrectionCommandService;
  stage: NativeLaunchStage;
  persist: (value: unknown) => string;
  observe: <T>(
    label: string,
    operation: () => Promise<T>,
    rollbackPolicy?: R5RollbackObservationPolicy,
  ) => Promise<import('./r5-setmat-concurrency-barrier').R5ObservedAttempt<T>>;
  getLastObservation: () => unknown;
  checkpoint: () => void;
  verifyCatalog: () => Promise<void>;
  commit: () => ReturnType<ActivityTimeCorrectionCommandService['commit']>;
  delta: 1000 | 10000;
  activityId: string;
  applicationId: string;
  postingBatchId: string;
  root: Awaited<
    ReturnType<PrismaClient['activitySettlementContributionRevision']['findFirstOrThrow']>
  >;
  runId: string;
  snapshot: () => ReturnType<typeof snapshotR5SetmatTables>;
  assertRetainedState?: () => Promise<void>;
  assertExclusiveBoundary?: () => Promise<void>;
}
