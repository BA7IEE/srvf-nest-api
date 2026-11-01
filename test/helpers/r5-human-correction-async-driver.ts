import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statfsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import {
  assertR5AsyncInstalledConnection,
  assertR5AsyncRuntimeSource,
  captureR5AsyncSessionBirth,
  createR5AsyncTrustedHttpApp,
  readR5AsyncMemoryCredentials,
  R5_ASYNC_INSTALLED_IDENTITIES,
} from './r5-human-correction-async-runtime';
import type { HumanCorrectionInstalledConnection } from '../../src/modules/activities/human-correction-trusted-connection';
import type { INestApplicationContext } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  assertR5AsyncBindingReview,
  assertR5AsyncRuntimeManifest,
  assertR5AsyncCatalogPair,
  assertR5AsyncItemAcl,
  assertR5AsyncManifest,
  assertR5AsyncResources,
  assertR5AsyncSingleCommit,
  assertR5AsyncNativeReceipt,
  assertR5AsyncWindow,
  R5_ASYNC_SCOPE,
  R5_ASYNC_CAPACITY1000_SCOPE,
  R5_ASYNC_RETAINED_CAPACITY1000_SCOPE,
  R5_ASYNC_PREPARED_CAPACITY1000_SCOPE,
  R5_ASYNC_ORIGINAL_JOB_RETRY_SCOPE,
  R5_ASYNC_FIRST_LAUNCH_SCOPE,
  R5_ASYNC_FULL_CHAIN_SCOPE,
  R5_ASYNC_PREPARED240_SCOPE,
  R5_SNAPSHOT120_PUBLICATION_RESERVES,
  R5_ASYNC_CAPACITY1000_UNITS,
  r5AsyncHash,
  readR5AsyncPinnedJson,
  verifyR5AsyncSourceBinding,
  type R5AsyncAclRow,
  type R5AsyncManifest,
  type R5AsyncBindingReview,
  type R5AsyncExecutionScope,
} from './r5-human-correction-async';
import { writeR5DurableReceipt } from './r5-setmat-durable-receipt';
import { capacityDiagnostics, capacityTerminalReceipt } from './r5-setmat-capacity.measurement';
import {
  bootstrapR5FullChain,
  runR5NewFullChainRequests,
  R5_PREPARED240_PUBLICATION,
} from './r5-human-correction-full-chain';
import { observeR5BatchCommitUpdate } from './r5-native-method-observation';
import {
  R5_ORIGINAL_JOB,
  readR5OriginalJobInTx,
  retryR5OriginalJobThroughApi,
  assertR5OriginalJobFence,
} from './r5-human-correction-original-job';
import {
  classifyR5Backends,
  readR5OwnedBackend,
  type R5BoundaryReport,
  type R5OwnedBackend,
} from './r5-setmat-backend-boundary';
import type { R5ObservedAttempt, R5SetmatFixture } from './r5-setmat-concurrency-barrier';
import type { R5AsyncCapacity1000Fixture } from './r5-human-correction-async-capacity.fixture';

type AsyncFixture = Pick<
  R5SetmatFixture,
  | 'app'
  | 'observerDb'
  | 'b'
  | 'activityId'
  | 'requestId'
  | 'command'
  | 'verifyCandidate'
  | 'restoreObservation'
> & { callerDb?: PrismaClient };

/** Single fresh, one-person real HTTP acceptance + deployed worker graph.
 * Importing this file does not connect. The supplied manifest defaults to
 * unapproved, with unresolved source-qualified supplemental pins. No setup
 * reset/migration/seed/permissions, old prepared input, or automatic retry.
 */
export async function runR5HumanCorrectionAsyncSmoke(
  manifestPath: string,
  frozenSourceBindingSha256: string,
) {
  return await runAsyncPublication(manifestPath, frozenSourceBindingSha256, R5_ASYNC_SCOPE);
}

export async function runR5HumanCorrectionAsyncCapacity1000(
  manifestPath: string,
  frozenSourceBindingSha256: string,
) {
  const input = JSON.parse(readFileSync(manifestPath, 'utf8')) as R5AsyncManifest;
  return await runAsyncPublication(
    manifestPath,
    frozenSourceBindingSha256,
    input.schema === R5_ASYNC_PREPARED240_SCOPE.schema
      ? R5_ASYNC_PREPARED240_SCOPE
      : input.schema === R5_ASYNC_FULL_CHAIN_SCOPE.schema
        ? R5_ASYNC_FULL_CHAIN_SCOPE
        : input.schema === R5_ASYNC_FIRST_LAUNCH_SCOPE.schema
          ? R5_ASYNC_FIRST_LAUNCH_SCOPE
          : input.schema === R5_ASYNC_ORIGINAL_JOB_RETRY_SCOPE.schema
            ? R5_ASYNC_ORIGINAL_JOB_RETRY_SCOPE
            : input.schema === R5_ASYNC_PREPARED_CAPACITY1000_SCOPE.schema
              ? R5_ASYNC_PREPARED_CAPACITY1000_SCOPE
              : input.schema === R5_ASYNC_RETAINED_CAPACITY1000_SCOPE.schema
                ? R5_ASYNC_RETAINED_CAPACITY1000_SCOPE
                : R5_ASYNC_CAPACITY1000_SCOPE,
  );
}

async function runAsyncPublication(
  manifestPath: string,
  frozenSourceBindingSha256: string,
  scope: R5AsyncExecutionScope,
) {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as R5AsyncManifest;
  assertR5AsyncManifest(m, Date.now(), scope); // Before imports that construct DB clients.
  const isCapacity = scope !== R5_ASYNC_SCOPE;
  const fullChain = scope === R5_ASYNC_FULL_CHAIN_SCOPE;
  const prepared240 = scope === R5_ASYNC_PREPARED240_SCOPE;
  const firstLaunch = scope === R5_ASYNC_FIRST_LAUNCH_SCOPE || fullChain || prepared240;
  const originalJobRetry =
    scope === R5_ASYNC_ORIGINAL_JOB_RETRY_SCOPE || scope === R5_ASYNC_FIRST_LAUNCH_SCOPE;
  assert(/^[a-f0-9]{64}$/.test(frozenSourceBindingSha256), 'source binding is not frozen');
  assert.equal(
    m.sourceBinding.sha256,
    frozenSourceBindingSha256,
    'manifest cannot replace the independently frozen entry-point source binding',
  );
  const pins = readR5AsyncPinnedJson<{ path: string; sha256: string }[]>(
    m.sourceBinding.path,
    m.sourceBinding.sha256,
  );
  verifyR5AsyncSourceBinding(m.checkout, pins);
  const bindingReview = JSON.parse(
    readFileSync(
      resolve(m.checkout, 'test/helpers/r5-human-correction-async-binding.draft.json'),
      'utf8',
    ),
  ) as R5AsyncBindingReview;
  assertR5AsyncBindingReview(m, bindingReview);
  const runtime = assertR5AsyncRuntimeManifest(m);
  const installed = readR5AsyncPinnedJson<HumanCorrectionInstalledConnection>(
    runtime.installedConnectionPath,
    runtime.installedConnectionSha256,
  );
  assertR5AsyncInstalledConnection(installed);
  assert.equal(installed.source.installedPreflightBodySha256, m.base.boundPreflightBodySha256);
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: m.checkout, encoding: 'utf8' }).trim(),
    R5_ASYNC_SCOPE.gitBase,
  );
  const control = readR5AsyncPinnedJson<{
    pid: number;
    startTicks: string;
    childPid: number;
    childStartTicks: string;
    phaseId: string;
    outputDirectory: string;
    fixtureOutputDirectory: string;
    deadline: string;
    sourceBindingSha256: string;
    hardDeadlineChildSupervision: boolean;
  }>(m.control.receiptPath, m.control.receiptSha256);
  assert.equal(control.pid, m.control.pid);
  assert.equal(control.phaseId, m.approval.phaseId);
  assert.equal(control.deadline, m.approval.phaseDeadline);
  assert.equal(control.sourceBindingSha256, m.sourceBinding.sha256);
  assert.equal(control.hardDeadlineChildSupervision, true);
  assert.equal(control.childPid, process.pid);
  assert.equal(control.outputDirectory, m.outputDirectory);
  assert.equal(control.fixtureOutputDirectory, m.base.outputDirectory);
  const proc = readFileSync(`/proc/${control.pid}/stat`, 'utf8');
  assert.equal(
    proc.slice(proc.lastIndexOf(')') + 2).split(' ')[19],
    control.startTicks,
    'external watchdog PID was reused',
  );
  const selfProc = readFileSync('/proc/self/stat', 'utf8');
  assert.equal(
    selfProc.slice(selfProc.lastIndexOf(')') + 2).split(' ')[19],
    control.childStartTicks,
  );
  const url = process.env.DATABASE_URL;
  assert(url, 'existing authorized original-environment connection is required');
  const credentials = readR5AsyncMemoryCredentials(runtime.credentialsFd, m.approval.phaseId);
  const callerUrl = credentials.pUrl;
  const baseUrl = new URL(url);
  baseUrl.searchParams.set('connection_limit', '1');
  const supplementalQuery = readFileSync(
    resolve(m.checkout, 'test/helpers/r5-setmat-async-job-catalog.sql'),
    'utf8',
  );
  assert.equal(r5AsyncHash(supplementalQuery), m.supplemental.querySha256);
  const baseExpected = readR5AsyncPinnedJson<Record<string, unknown>>(
    m.base.expectedCatalogPath,
    m.base.expectedCatalogSha256,
  );
  const extraExpected = readR5AsyncPinnedJson<Record<string, unknown>>(
    m.supplemental.expectedPath,
    m.supplemental.expectedSha256,
  );
  assertR5AsyncCatalogPair(baseExpected, extraExpected);
  assertR5AsyncRuntimeSource(installed, baseExpected, extraExpected);
  const oldQuery = readFileSync(m.base.catalogQueryPath, 'utf8');
  assert.equal(r5AsyncHash(oldQuery), m.base.catalogQuerySha256);
  assert.equal(
    oldQuery,
    readFileSync(resolve(m.checkout, 'test/helpers/r5-setmat-catalog-query.sql'), 'utf8'),
  );
  writeR5DurableReceipt(join(dirname(m.control.receiptPath), `${m.approval.phaseId}.claim.json`), {
    phaseId: m.approval.phaseId,
    sourceBindingSha256: m.sourceBinding.sha256,
    pid: process.pid,
    realCommitLimit: 1,
    automaticRetry: false,
    executionScope: scope.schema,
    originalJobId: originalJobRetry ? R5_ORIGINAL_JOB.jobId : null,
  });
  mkdirSync(m.outputDirectory, { recursive: false });
  let sequence = 0;
  const persist = (x: unknown) =>
    writeR5DurableReceipt(
      join(m.outputDirectory, `receipt-${String(++sequence).padStart(4, '0')}.json`),
      x,
    );
  const resources = () => {
    const d = statfsSync('/var/lib/docker');
    const r = {
      cpuMax: readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim(),
      memoryMaxBytes: readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(),
      memoryCurrentBytes: readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim(),
      diskAvailableBytes: d.bavail * d.bsize,
    };
    persist({ kind: 'ASYNC_RESOURCE_SAMPLE', ...r });
    assertR5AsyncResources(r);
  };
  const checkpoint = (reserve = 5_000) => {
    assertR5AsyncWindow(m, Date.now(), reserve, scope);
    process.kill(control.pid, 0); // Liveness only; never signals another process.
  };
  resources();
  checkpoint(prepared240 ? R5_SNAPSHOT120_PUBLICATION_RESERVES.entry : 125_000);
  persist({
    kind: 'ASYNC_SINGLE_USE_STAGE',
    phaseId: m.approval.phaseId,
    sourceBindingSha256: m.sourceBinding.sha256,
    approval: m.approval,
    scope,
    capacity: m.capacity ?? null,
    automaticRetry: false,
    oldPreparedNeverUsed: !m.continuation?.preparedPublication,
    originalFailedJobConsumedOnlyByExplicitRetry: originalJobRetry,
  });
  const { PrismaClient } = await import('@prisma/client');
  let observer = new PrismaClient({ datasourceUrl: baseUrl.toString() });
  const leaseUrl = new URL(baseUrl);
  leaseUrl.pathname = '/postgres';
  const lease = new PrismaClient({ datasourceUrl: leaseUrl.toString() });
  let fixture: AsyncFixture | undefined, workerContext: INestApplicationContext | undefined;
  let capacityFixture: R5AsyncCapacity1000Fixture | undefined;
  let fullChainBootstrap: Awaited<ReturnType<typeof bootstrapR5FullChain>> | undefined;
  let fullChainPrepareXid: string | undefined;
  let preparationApp: INestApplication | undefined,
    preparationAppRetired = false;
  let fixtureObservationRestored = false;
  let httpApp: INestApplication | undefined;
  let authorityBirth: R5OwnedBackend | undefined;
  let workerDb: import('../../src/database/prisma.service').PrismaService | undefined,
    leasePid: number | undefined,
    held = false;
  let writesStarted = false,
    uncertain = false,
    outcome: 'PASS' | 'FAIL' = 'FAIL';
  let primaryFailed = false,
    primaryError: unknown,
    closeoutFailed = false,
    closeoutError: unknown;
  let restoreNative: (() => void) | undefined, restoreRole: (() => void) | undefined;
  const originalUrl = process.env.DATABASE_URL;
  const attempts: R5ObservedAttempt<unknown>[] = [];
  let currentStage = 'PRECONDITIONS';
  const diagnostics = capacityDiagnostics(
    persist,
    () => currentStage,
    () => [url, credentials.pUrl, credentials.uUrl, ...credentials.redactions],
  );
  const stage = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    checkpoint();
    const started = performance.now();
    currentStage = label;
    diagnostics.emit({ kind: 'ASYNC_STAGE_START', label });
    diagnostics.assertHealthy();
    let failed = false,
      failure: unknown,
      value!: T;
    try {
      value = await diagnostics.run(label, work);
    } catch (error) {
      failed = true;
      failure = error;
    }
    diagnostics.emit({ kind: 'ASYNC_STAGE_END', label, elapsedMs: performance.now() - started });
    try {
      checkpoint();
    } catch (error) {
      diagnostics.emit({
        kind: 'ASYNC_STAGE_CHECKPOINT_FAILED',
        label,
        error: diagnostics.error(error),
      });
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
    if (failed) throw failure;
    diagnostics.assertHealthy();
    return value;
  };
  const verifyCatalog = () =>
    observer.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await tx.$executeRaw`SET LOCAL search_path=pg_catalog`;
        const first = await tx.$queryRawUnsafe<Record<string, unknown>[]>(oldQuery);
        const second = await tx.$queryRawUnsafe<Record<string, unknown>[]>(supplementalQuery);
        assert.equal(first.length, 1);
        assert.equal(second.length, 1);
        assert.deepEqual(Object.values(first[0]), [baseExpected]);
        assert.deepEqual(Object.values(second[0]), [extraExpected]);
        const body = await tx.$queryRaw<
          { hash: string }[]
        >`SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') AS hash
      FROM pg_proc WHERE oid='public.r5_correction_boundary_preflight()'::regprocedure`;
        assert.equal(body[0]?.hash, m.base.boundPreflightBodySha256);
      },
      { timeout: 30_000, maxWait: 2_000 },
    );
  const boundary = async (label: string, owned: R5OwnedBackend[]) => {
    assert(leasePid && held);
    const rows = await observer.$queryRaw<R5BoundaryReport[]>`WITH a AS MATERIALIZED (
      SELECT pid,datid::int AS "databaseOid",backend_type AS "backendType",backend_start::text AS "backendStart",
        leader_pid AS "leaderPid",state,xact_start::text AS "transactionStart",query_start::text AS "queryStart",
        state_change::text AS "stateChange",wait_event_type AS "waitType",wait_event AS "waitEvent"
      FROM pg_stat_activity WHERE datid IN(1713092,1971161,1998913))
      SELECT clock_timestamp()::text AS "observedAt",pg_backend_pid() AS "observerPid",
        coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY pid) FROM a),'[]'::jsonb) AS backends,
        (SELECT count(*)::int FROM pg_prepared_xacts WHERE database IN('app_test_r5_setmat_20261029_q1',
          'app_test_r5_native_capacity_20261027_b8a9cd_w1','app_test_r5_native_capacity_20261027_b8a9cd_w95')) AS prepared,
        EXISTS(SELECT 1 FROM pg_locks WHERE pid=${leasePid} AND locktype='advisory' AND granted
          AND database=(SELECT oid FROM pg_database WHERE datname='postgres') AND objsubid=1
          AND classid::bigint=((hashtextextended('SRVF:test:D3:app_test_w98',0)>>32)&4294967295)
          AND objid::bigint=(hashtextextended('SRVF:test:D3:app_test_w98',0)&4294967295)) AS "leaseHeld"`;
    persist({ kind: 'ASYNC_STRICT_ALL_SAMPLE', label, owned, rows });
    assert.equal(rows.length, 1);
    assert(classifyR5Backends(rows[0], owned, 'STRICT_ALL').pass);
  };
  const queues = async (ownedJobId?: string) => {
    const jobs = await observer.activityBatchJob.findMany({
      where: {
        jobTypeCode: 'human_correction_commit',
        id: ownedJobId ? { not: ownedJobId } : undefined,
        statusCode: { in: ['pending', 'processing'] },
      },
      select: { id: true, jobTypeCode: true, statusCode: true },
    });
    persist({ kind: 'ASYNC_HUMAN_QUEUE_ADMISSION', jobs });
    assert.equal(jobs.length, 0, 'another Human target exists; no old-job claim or replay');
  };
  try {
    const identity = await observer.$queryRaw<
      { cluster: string; database: string; oid: number; version: string }[]
    >`
      SELECT (SELECT system_identifier::text FROM pg_control_system()) AS cluster,
        current_database() AS database,(SELECT oid::bigint FROM pg_database WHERE datname=current_database())::int AS oid,
        current_setting('server_version_num') AS version`;
    assert.deepEqual(identity, [
      {
        cluster: R5_ASYNC_SCOPE.cluster,
        database: R5_ASYNC_SCOPE.database,
        oid: R5_ASYNC_SCOPE.databaseOid,
        version: R5_ASYNC_SCOPE.serverVersion,
      },
    ]);
    const lock = await lease.$queryRaw<{ cluster: string; pid: number; locked: boolean }[]>`
      SELECT (SELECT system_identifier::text FROM pg_control_system()) AS cluster,pg_backend_pid() AS pid,
        pg_try_advisory_lock(hashtextextended('SRVF:test:D3:app_test_w98',0)) AS locked`;
    held = lock[0]?.locked === true;
    leasePid = lock[0]?.pid;
    persist({ kind: 'ASYNC_LEASE', lock });
    assert.equal(lock.length, 1);
    assert.equal(lock[0].cluster, R5_ASYNC_SCOPE.cluster);
    assert(held);
    await boundary('BEFORE_FIXTURE', [await readR5OwnedBackend(observer)]);
    await verifyCatalog();
    if (isCapacity) {
      const { preflightR5AsyncCapacity1000Readback } =
        await import('./r5-human-correction-async-capacity');
      const plan = await stage('CAPACITY1000_READONLY_READBACK_PLAN', () =>
        preflightR5AsyncCapacity1000Readback(observer),
      );
      persist({ kind: 'ASYNC_CAPACITY1000_READBACK_PARSE_PLAN', plan, analyze: false });
    }
    const acl = await observer.$queryRaw<R5AsyncAclRow[]>`
      SELECT c.relname AS "table",a.attname AS "column",
        has_column_privilege(r.oid,c.oid,a.attnum,'SELECT') AS "select",
        has_column_privilege(r.oid,c.oid,a.attnum,'INSERT') AS "insert",
        has_column_privilege(r.oid,c.oid,a.attnum,'UPDATE') AS "update",
        has_table_privilege(r.oid,c.oid,'SELECT') AS "tableSelect",
        has_table_privilege(r.oid,c.oid,'INSERT') AS "tableInsert",
        has_table_privilege(r.oid,c.oid,'UPDATE') AS "tableUpdate",
        has_table_privilege(r.oid,c.oid,'DELETE') AS "tableDelete"
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      CROSS JOIN pg_roles r WHERE n.nspname='public' AND c.relname='ActivityBatchJobItem'
        AND r.rolname='r5_human_queue_login_20261030_q1' ORDER BY a.attnum`;
    persist({ kind: 'ASYNC_P_ITEM_EFFECTIVE_ACL', acl });
    assertR5AsyncItemAcl(acl);
    await queues();
    // Prove startup-role support and protected Human qualification before the
    // first fixture/login write. This temporary connection is closed before
    // the factory starts; it does not increase the three-backend peak.
    const admissionCaller = new PrismaClient({ datasourceUrl: callerUrl });
    try {
      const role = await admissionCaller.$queryRaw<
        { role: string; oid: number; superuser: string }[]
      >`
        SELECT current_user AS role,current_user::regrole::oid::bigint::int AS oid,
          current_setting('is_superuser') AS superuser`;
      persist({ kind: 'ASYNC_CALLER_BEFORE_ANY_FIXTURE_WRITE', role });
      assert.deepEqual(role, [
        { role: R5_ASYNC_SCOPE.caller, oid: R5_ASYNC_SCOPE.callerOid, superuser: 'off' },
      ]);
      await captureR5AsyncSessionBirth(admissionCaller, 'P', persist);
      const { createHumanCorrectionTrustedConnection } =
        await import('../../src/modules/activities/human-correction-trusted-connection');
      const connection = createHumanCorrectionTrustedConnection(
        admissionCaller as unknown as import('../../src/database/prisma.service').PrismaService,
        installed,
      );
      assert(connection);
      await admissionCaller.$transaction(
        async (tx) => {
          const { HumanCorrectionItemAuthority } =
            await import('../../src/modules/activities/human-correction-item-authority');
          await new HumanCorrectionItemAuthority(connection).assertCallerInTx(tx);
        },
        { timeout: 7_000, maxWait: 2_000 },
      );
      persist({
        kind: 'ASYNC_HUMAN_ONLY_SCOPE_ADMISSION',
        selection: 'trusted Human connection; family filtered atomically by production worker',
        unrelatedReconciliationScanRequired: false,
      });
    } finally {
      await admissionCaller.$disconnect();
    }
    const untrusted = new PrismaClient({ datasourceUrl: credentials.uUrl });
    try {
      await captureR5AsyncSessionBirth(untrusted, 'U', persist, observer);
      const u = await untrusted.$queryRaw<
        { session: string; current: string; oid: string; canSetP: boolean; itemWrite: boolean }[]
      >`
        SELECT session_user::text AS "session",current_user::text AS "current",
          (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=session_user) AS oid,
          pg_catalog.pg_has_role(session_user,${R5_ASYNC_INSTALLED_IDENTITIES.P.name},'SET') AS "canSetP",
          pg_catalog.has_any_column_privilege(current_user,'public."ActivityBatchJobItem"','INSERT,UPDATE') AS "itemWrite"`;
      persist({ kind: 'ASYNC_U_ACTUAL_AUTHORITY_NEGATIVE', rows: u });
      assert.deepEqual(u, [
        {
          session: R5_ASYNC_INSTALLED_IDENTITIES.U.name,
          current: R5_ASYNC_SCOPE.caller,
          oid: String(R5_ASYNC_INSTALLED_IDENTITIES.U.oid),
          canSetP: false,
          itemWrite: false,
        },
      ]);
    } finally {
      await untrusted.$disconnect();
    }
    const { readR5PreparedContinuation } = await import('./r5-setmat-component-continuation');
    const retainedBefore = await readR5PreparedContinuation(observer, m.base);
    process.env.DATABASE_URL = baseUrl.toString();
    checkpoint(prepared240 ? R5_SNAPSHOT120_PUBLICATION_RESERVES.entry : 125_000);
    writesStarted = true;
    if (fullChain || prepared240) {
      mkdirSync(m.base.outputDirectory, { recursive: false });
      fullChainBootstrap = await bootstrapR5FullChain({
        config: m.base,
        observer,
        persist,
        stage,
        verifyCatalog,
        ...(prepared240 ? { prepared240: m.prepared240 } : {}),
        onApplication: (app) => {
          preparationApp = app;
        },
      });
      fixture = fullChainBootstrap;
    } else if (isCapacity) {
      const { createR5AsyncCapacity1000Fixture } =
        await import('./r5-human-correction-async-capacity.fixture');
      mkdirSync(m.base.outputDirectory, { recursive: false });
      let preparationSequence = 0;
      const preparationPersist = (value: unknown) =>
        writeR5DurableReceipt(
          join(
            m.base.outputDirectory,
            `receipt-${String(++preparationSequence).padStart(4, '0')}.json`,
          ),
          value,
        );
      capacityFixture = await stage(
        m.continuation?.preparedPublication
          ? 'ONE_COMMITTED_PREPARE_PUBLICATION_FIXTURE'
          : m.continuation
            ? 'ONE_RETAINED_N10000_DELTA1000_PREPARED_FIXTURE'
            : 'ONE_FRESH_N10000_DELTA1000_PREPARED_FIXTURE',
        () =>
          createR5AsyncCapacity1000Fixture({
            config: m.base,
            observer,
            persist: preparationPersist,
            stage,
            checkpoint,
            verifyCatalog,
            retainedSource: m.continuation?.source,
            preparedApplication: m.continuation?.preparedPublication?.prepared,
            originalJobRetry,
            onApplication: (app) => {
              preparationApp = app;
            },
          }),
      );
      assert.equal(
        capacityFixture.observerDb,
        observer,
        'capacity must reuse the sole outer observer',
      );
      fixture = capacityFixture;
      const { assertR5AsyncFreshCapacityFixture } =
        await import('./r5-human-correction-async-capacity');
      assertR5AsyncFreshCapacityFixture(capacityFixture);
      persist({
        kind: m.continuation
          ? 'ASYNC_CAPACITY1000_RETAINED_PREPARATION_REFERENCE'
          : 'ASYNC_CAPACITY1000_FRESH_PREPARATION_REFERENCE',
        directory: m.base.outputDirectory,
        proofId: capacityFixture.proofId,
        units: capacityFixture.expected,
      });
    } else {
      const { createR5SetmatOwnedFixtureFactory } = await import('./r5-setmat-owned-fixture');
      await observer.$disconnect(); // Single-person factory returns its original observer.
      fixture = await stage(
        'ONE_FRESH_V3_PREPARED_FIXTURE',
        createR5SetmatOwnedFixtureFactory(m.base),
      );
      preparationApp = fixture.app;
    }
    const f = fixture;
    if (originalJobRetry) assert.equal(f.b.id, R5_ORIGINAL_JOB.payload.actorUserId);
    observer = f.observerDb;
    const { loginAs } = await import('../fixtures/auth.fixture');
    const auth = (await stage('FOURTH_REAL_LOGIN_B', () => loginAs(f.app, f.b.username)))
      .authHeader;
    // Fixture login/prepare observations stay intact; retire its administrator
    // graph before building the actual HTTP and worker graphs with one P client.
    f.restoreObservation();
    fixtureObservationRestored = true;
    await f.app.close();
    preparationAppRetired = true;
    await f.callerDb?.$disconnect();
    const { Test } = await import('@nestjs/testing');
    const { PrismaService } = await import('../../src/database/prisma.service');
    const { NotificationOutboxWorkerModule } =
      await import('../../src/modules/notifications/notification-outbox-worker.module');
    const { ActivityBatchWorkerModule } =
      await import('../../src/modules/activities/activity-batch-worker.module');
    const { ActivityBatchWorker } =
      await import('../../src/modules/activities/activity-batch.worker');
    const { CorrectionApplicationService } =
      await import('../../src/modules/activities/correction-application.service');
    const { installR5CallerTransactions } = await import('./r5-setmat-observation');
    let inNative = false;
    let nativeCorrelation: Record<string, unknown> | undefined;
    let restoreBatchUpdate: (() => void) | undefined;
    let methodObservationFailed = false;
    let queryCount = 0;
    workerDb = new PrismaService({
      datasourceUrl: callerUrl,
      log: [{ emit: 'event', level: 'query' }],
    });
    const queryEvents = workerDb as PrismaClient<Prisma.PrismaClientOptions, 'query'>;
    queryEvents.$on('query', (event) =>
      diagnostics.emit({
        kind: 'ASYNC_WORKER_PHYSICAL_SQL',
        sequence: ++queryCount,
        native: inNative,
        query: event.query,
        durationMs: event.duration,
        parametersCaptured: false,
        nativeContextAtDelivery: inNative ? nativeCorrelation : null,
        association: 'CLIENT_EVENT_DELIVERY_CONTEXT_NOT_SERVER_DISPATCH_PROOF',
      }),
    );
    authorityBirth = await captureR5AsyncSessionBirth(workerDb, 'P', persist);
    const workerIdentity = await workerDb.$queryRaw<
      { role: string; oid: number; superuser: string }[]
    >`
      SELECT current_user AS role,current_user::regrole::oid::bigint::int AS oid,
        current_setting('is_superuser') AS superuser`;
    persist({ kind: 'ASYNC_WORKER_STARTUP_IDENTITY', workerIdentity });
    assert.deepEqual(workerIdentity, [
      { role: R5_ASYNC_SCOPE.caller, oid: R5_ASYNC_SCOPE.callerOid, superuser: 'off' },
    ]);
    httpApp = await createR5AsyncTrustedHttpApp(workerDb, installed, {
      bulkCommit: firstLaunch,
      bulkPrepare: fullChain,
    });
    const { HUMAN_CORRECTION_BACKGROUND_BUDGET } =
      await import('../../src/modules/activities/human-correction-background-budget');
    const { HUMAN_CORRECTION_INSTALLED_CONNECTION } =
      await import('../../src/modules/activities/human-correction-trusted-connection');
    workerContext = await Test.createTestingModule({ imports: [NotificationOutboxWorkerModule] })
      .overrideProvider(HUMAN_CORRECTION_BACKGROUND_BUDGET)
      .useValue(Object.freeze({ bulkCommit: firstLaunch, bulkPrepare: fullChain }))
      .overrideProvider(PrismaService)
      .useValue(workerDb)
      .overrideProvider(HUMAN_CORRECTION_INSTALLED_CONNECTION)
      .useValue(installed)
      .compile();
    await workerContext.init(); // Real deployed graph; no worker/outbox run loops.
    const graph = workerContext.select(ActivityBatchWorkerModule);
    const worker = graph.get(ActivityBatchWorker, { strict: true });
    assert.equal(
      worker.executionScope,
      'human-correction',
      'real worker must use its protected Human scope',
    );
    const corrections = graph.get(CorrectionApplicationService, { strict: true });
    assert.equal(Reflect.get(corrections, 'prisma'), workerDb);
    assert.deepEqual(
      Reflect.get(corrections, 'backgroundBudget'),
      { bulkCommit: firstLaunch, bulkPrepare: fullChain },
      'actual worker service must receive the frozen candidate profile',
    );
    const metadataXids: {
      xid: string;
      role: string;
      roleOid: number;
      pid: number;
      session: string;
    }[] = [];
    const route = installR5CallerTransactions(
      workerDb,
      m.base.databaseOid,
      async (tx) => {
        if (inNative) {
          restoreBatchUpdate = observeR5BatchCommitUpdate(
            tx.ledgerPostingBatch,
            f.command.postingBatchId,
            () => ({ ...nativeCorrelation }),
            (event) => diagnostics.emit(event),
            (error) => diagnostics.error(error),
          );
          return;
        }
        const rows = await tx.$queryRaw<
          { xid: string; role: string; roleOid: number; pid: number; session: string }[]
        >`
        SELECT pg_current_xact_id()::text AS xid,current_user AS role,
          current_user::regrole::oid::bigint::int AS "roleOid",pg_backend_pid() AS pid,session_user::text AS session`;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].role, R5_ASYNC_SCOPE.caller);
        assert.equal(rows[0].roleOid, R5_ASYNC_SCOPE.callerOid);
        assert.equal(rows[0].session, R5_ASYNC_INSTALLED_IDENTITIES.P.name);
        assert(
          authorityBirth && rows[0].pid === authorityBirth.pid,
          'P session changed after actual birth capture',
        );
        metadataXids.push(rows[0]);
        persist({ kind: 'ASYNC_WORKER_METADATA_IDENTITY', identity: rows[0] });
      },
      (x) => {
        if (inNative && x.event === 'CALLBACK_IDENTITY')
          nativeCorrelation = { ...nativeCorrelation, identity: x.identity };
        persist(x);
      },
    );
    restoreRole = () => route.restore();
    const original = corrections.commit.bind(corrections);
    let nativeInvocations = 0;
    const native = jest.spyOn(corrections, 'commit').mockImplementation(async (...args) => {
      assert.equal(++nativeInvocations, 1, 'a second native invocation is forbidden');
      const fence = args[3]?.backgroundJob;
      if (originalJobRetry) assertR5OriginalJobFence(fence, args[1].id);
      nativeCorrelation = {
        phaseId: m.approval.phaseId,
        nativeAttempt: nativeInvocations,
        jobId: fence?.jobId,
        leaseGeneration: fence?.leaseGeneration,
        itemEpoch: fence?.itemEpoch,
        intentItemId: fence?.intentItemId,
        activityId: f.activityId,
        requestId: f.requestId,
        applicationId: f.command.correctionApplicationId,
        batchId: f.command.postingBatchId,
        actorUserId: args[1].id,
      };
      inNative = true;
      try {
        const attempt = await route.observe(
          observer,
          firstLaunch
            ? 'FIRST_LAUNCH_BACKGROUND60_REAL_COMMIT'
            : isCapacity
              ? 'ASYNC_CAPACITY1000_NATIVE15_REAL_COMMIT'
              : 'ASYNC_SINGLE_NATIVE15_REAL_COMMIT',
          () => original(...args),
          persist,
        );
        attempts.push(attempt);
        if (attempt.databaseOutcome === 'UNKNOWN' || !attempt.observationComplete) uncertain = true;
        if (attempt.client.status === 'rejected') {
          diagnostics.emit({
            kind: 'ASYNC_NATIVE_ORIGINAL_REJECTION',
            correlation: nativeCorrelation,
            error: diagnostics.error(attempt.client.reason),
            nativeEvidenceRef: attempt.evidenceRef,
            databaseOutcome: attempt.databaseOutcome,
            observationComplete: attempt.observationComplete,
            configuredTimeoutMs: attempt.configuredTimeoutMs,
            observedAt: 'AFTER_NATIVE_PROMISE_AND_INDEPENDENT_STATUS_BEFORE_RETHROW',
            originalErrorPreserved: true,
          });
          throw attempt.client.reason;
        }
        return attempt.client.value;
      } finally {
        try {
          restoreBatchUpdate?.();
          restoreBatchUpdate = undefined;
        } catch (error) {
          methodObservationFailed = true;
          diagnostics.emit({
            kind: 'ASYNC_NATIVE_METHOD_OBSERVATION_RESTORE_FAILED',
            error: diagnostics.error(error),
          });
        }
        inNative = false;
        nativeCorrelation = undefined;
      }
    });
    restoreNative = () => native.mockRestore();
    const request = (await import('supertest')).default;
    const httpServer = httpApp.getHttpServer() as Server;
    const metadataHttp = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
      const observed = await route.observe(observer, label, operation, persist);
      persist({
        kind: 'ASYNC_HTTP_METADATA_OUTCOME',
        label,
        databaseOutcome: observed.databaseOutcome,
        observationComplete: observed.observationComplete,
        evidenceRef: observed.evidenceRef,
      });
      assert.equal(observed.observationComplete, true);
      assert.equal(observed.databaseOutcome, 'COMMITTED');
      if (observed.client.status === 'rejected') throw observed.client.reason;
      return observed.client.value;
    };
    if (fullChain) {
      assert(fullChainBootstrap?.source);
      const { ActivitiesModule } = await import('../../src/modules/activities/activities.module');
      const { ActivityTimeCorrectionCommandService } =
        await import('../../src/modules/activities/activity-time-correction-command.service');
      const httpGraph = httpApp.select(ActivitiesModule);
      const httpCorrections = httpGraph.get(CorrectionApplicationService, { strict: true });
      const human = httpGraph.get(ActivityTimeCorrectionCommandService, { strict: true });
      assert.equal(Reflect.get(human, 'corrections'), httpCorrections);
      for (const service of [human, httpCorrections]) {
        assert.equal(Reflect.get(service, 'prisma'), workerDb);
        assert.deepEqual(Reflect.get(service, 'backgroundBudget'), {
          bulkCommit: true,
          bulkPrepare: true,
        });
      }
      let prepares = 0;
      const originalPrepare = httpCorrections.prepare.bind(httpCorrections);
      const prepareObservation = jest
        .spyOn(httpCorrections, 'prepare')
        .mockImplementation(async (...args) => {
          assert.equal(++prepares, 1, 'full-chain prepare may be invoked only once');
          assert.equal(args[3]?.human, true);
          assert.equal(args[3]?.backgroundBulkPrepare?.segmentCount, 1000);
          assert.equal(
            args[3]?.expectedBaseSettlementVersionId,
            f.command.expectedBaseSettlementVersionId,
          );
          const attempt = await route.observe(
            observer,
            'FULL_CHAIN_REAL_HUMAN_PREPARE240',
            () => originalPrepare(...args),
            persist,
          );
          if (attempt.databaseOutcome === 'UNKNOWN' || !attempt.observationComplete)
            uncertain = true;
          persist({
            kind: 'FULL_CHAIN_PREPARE_CLIENT_AND_DATABASE',
            databaseOutcome: attempt.databaseOutcome,
            observationComplete: attempt.observationComplete,
            configuredTimeoutMs: attempt.configuredTimeoutMs,
            evidenceRef: attempt.evidenceRef,
            client:
              attempt.client.status === 'rejected'
                ? { status: 'rejected', error: diagnostics.error(attempt.client.reason) }
                : { status: 'fulfilled', value: attempt.client.value },
            automaticRetry: false,
          });
          if (attempt.client.status === 'rejected') throw attempt.client.reason;
          assert.equal(attempt.observationComplete, true);
          assert.equal(attempt.databaseOutcome, 'COMMITTED');
          assert.equal(attempt.configuredTimeoutMs, 240000);
          const record = JSON.parse(readFileSync(attempt.evidenceRef, 'utf8')) as {
            transactions: { identity: { xid: string } }[];
          };
          const timing = capacityTerminalReceipt(record, 'commit');
          fullChainPrepareXid = record.transactions[0].identity.xid;
          persist({
            kind: 'FULL_CHAIN_PREPARE240_TERMINAL_TIMING',
            ...timing,
            xid: fullChainPrepareXid,
            diagnosticOverheadSubtracted: false,
            transactionBudgetMs: 240000,
          });
          assert(
            timing.transactionPromiseElapsedMs <= 240000,
            'prepare candidate budget includes real transaction settlement',
          );
          return attempt.client.value;
        });
      let prepared: Awaited<ReturnType<typeof runR5NewFullChainRequests>>;
      try {
        prepared = await runR5NewFullChainRequests({
          source: fullChainBootstrap.source,
          phaseId: m.approval.phaseId,
          reviewerUserId: f.b.id,
          checkpoint,
          persist,
          post: (label, path, actor, body, metadata) =>
            stage(label, () =>
              route.withinCaller(async () => {
                const operation = async () => {
                  const response = await request(httpServer)
                    .post(path)
                    .set(
                      'Authorization',
                      actor === 'creator' ? fullChainBootstrap!.creatorAuthorization : auth,
                    )
                    .send(body);
                  return {
                    status: response.status,
                    body: diagnostics.body(response.body) as {
                      code?: number;
                      data?: Record<string, unknown>;
                    },
                  };
                };
                return metadata ? await metadataHttp(label, operation) : await operation();
              }),
            ),
        });
      } finally {
        prepareObservation.mockRestore();
      }
      assert.equal(prepares, 1);
      f.requestId = prepared.requestId;
      f.command = prepared.command;
      // Tokens stay only in this live closure and are not written to receipts.
      fullChainBootstrap.creatorAuthorization = '';
      const proof = await observer.correctionTimeSourceProof.findUniqueOrThrow({
        where: { applicationId: f.command.correctionApplicationId },
      });
      assert(fullChainPrepareXid);
      const ledger = await observer.$queryRaw<
        { xmin: string; count: number }[]
      >`SELECT xmin::text AS xmin,count(*)::int AS count FROM "ParticipationLedgerEntry" WHERE "postingBatchId"=${f.command.postingBatchId} GROUP BY xmin::text`;
      assert.deepEqual(ledger, [{ xmin: fullChainPrepareXid, count: 8000 }]);
      persist({
        kind: 'FULL_CHAIN_PREWRITTEN_LEDGER_PREPARE_XID',
        rows: ledger,
        publicationXidIsSeparate: true,
      });
      assert.deepEqual(
        [
          proof.expectedSegmentCount,
          proof.expectedPendingCount,
          proof.expectedBindingCount,
          proof.expectedSliceCount,
        ],
        [10000, 1000, 10000, 50000],
      );
      const preparedRoot = await observer.activitySettlementContributionRevision.findFirstOrThrow({
        where: { settlementVersionId: prepared.settlementVersionId },
      });
      assert.equal(preparedRoot.correctionTimeSourceProofId, proof.id);
      assert.equal(preparedRoot.sourceKindCode, 'correction_time_proof');
      const { assertNativeLaunchFrozenOracle } = await import('./native-launch-live.fixture');
      await assertNativeLaunchFrozenOracle(observer, preparedRoot, 8000, stage);
      capacityFixture = {
        ...f,
        preparationDb: workerDb,
        expected: R5_ASYNC_CAPACITY1000_UNITS,
        proofId: proof.id,
        preparedOracle: { rootId: preparedRoot.id, proofId: proof.id, evaluations: 8000 },
      };
      const { assertR5AsyncFreshCapacityFixture } =
        await import('./r5-human-correction-async-capacity');
      assertR5AsyncFreshCapacityFixture(capacityFixture);
      persist({
        kind: 'FULL_CHAIN_NEW_PREPARE_COMPLETE',
        requestId: f.requestId,
        command: f.command,
        proofId: proof.id,
        rootId: preparedRoot.id,
        prepareInvocations: prepares,
        sourceSetupReplayed: false,
        priorSuccessReplayed: false,
      });
    }
    if (prepared240) {
      assert(fullChainBootstrap?.prepared);
      const q = fullChainBootstrap.prepared;
      assert.equal(f.b.id, R5_PREPARED240_PUBLICATION.actorUserId);
      fullChainPrepareXid = R5_PREPARED240_PUBLICATION.xid;
      const { assertNativeLaunchFrozenOracle } = await import('./native-launch-live.fixture');
      await assertNativeLaunchFrozenOracle(observer, q.root, 8000, stage);
      capacityFixture = {
        ...f,
        preparationDb: workerDb,
        expected: R5_ASYNC_CAPACITY1000_UNITS,
        proofId: q.proof.id,
        preparedOracle: { rootId: q.root.id, proofId: q.proof.id, evaluations: 8000 },
      };
      persist({
        kind: 'PREPARED240_BOUND_AND_FRESH_ORACLES_PASSED',
        rootId: q.root.id,
        proofId: q.proof.id,
        evidence: R5_PREPARED240_PUBLICATION.evidenceLibraryId,
        sourceHash: q.proof.sourceSetHash,
        prewrittenLedgerXid: fullChainPrepareXid,
        oldPrepare240PassPreserved: true,
        newRequestReviewPrepareInvocations: 0,
        currentOracleRerun: true,
      });
    }
    const { assertNativeLaunchFrozenOracle } = await import('./native-launch-live.fixture');
    const app = await observer.correctionApplication.findUniqueOrThrow({
      where: { id: f.command.correctionApplicationId },
    });
    const root = await observer.activitySettlementContributionRevision.findFirstOrThrow({
      where: { settlementVersionId: app.newSettlementVersionId },
    });
    if (capacityFixture) {
      // The fresh capacity factory just ran this exact oracle for this root.
      // Retain its same-attempt proof; do not rerun identical setup work here.
      assert.deepEqual(capacityFixture.preparedOracle, {
        rootId: root.id,
        proofId: capacityFixture.proofId,
        evaluations: 8000,
      });
      persist({
        kind: 'ASYNC_CAPACITY1000_CURRENT_PREPARED_ORACLE',
        ...capacityFixture.preparedOracle,
        historicalResultReused: false,
      });
    } else await assertNativeLaunchFrozenOracle(observer, root, 4, stage);
    await f.verifyCandidate();
    await verifyCatalog();
    await queues();
    resources();
    const { snapshotR5SetmatTables } = await import('./r5-setmat-manifest');
    if (prepared240) checkpoint(R5_SNAPSHOT120_PUBLICATION_RESERVES.baseline);
    const before = await stage('FULL_TABLE_BASELINE_AFTER_ALL_LOGINS', () =>
      snapshotR5SetmatTables(observer, (report) => persist(report), m.auxiliarySnapshot),
    );
    const capacityChecks = isCapacity
      ? await import('./r5-human-correction-async-capacity')
      : undefined;
    const capacityBefore =
      capacityChecks && capacityFixture
        ? await stage('CAPACITY1000_FROZEN_PREPARED_INPUT_AND_CENSUS', () =>
            capacityChecks.readR5AsyncCapacity1000Before(observer, capacityFixture!),
          )
        : undefined;
    const path = `/api/app/v1/my/managed-activities/${f.activityId}/time-corrections/${f.requestId}/commit-jobs`;
    checkpoint(
      prepared240 ? R5_SNAPSHOT120_PUBLICATION_RESERVES.accept : fullChain ? 85_000 : 25_000,
    );
    let jobId: unknown;
    if (originalJobRetry) {
      const qualify = async (mode: 'failed' | 'retry-pending') => {
        const facts = await observer.$transaction(
          async (tx) => {
            await tx.$executeRaw`SET TRANSACTION READ ONLY`;
            return await readR5OriginalJobInTx(tx, mode);
          },
          { isolationLevel: 'RepeatableRead', timeout: 30000, maxWait: 2000 },
        );
        persist({ kind: 'ASYNC_ORIGINAL_JOB_LIVE_QUALIFICATION', ...facts });
      };
      jobId = await stage('HTTP_ORIGINAL_JOB_EXPLICIT_RETRY', () =>
        retryR5OriginalJobThroughApi({
          detail: () =>
            metadataHttp(
              'ASYNC_ORIGINAL_JOB_AUTHENTICATED_DETAIL',
              async () =>
                await request(httpServer)
                  .get(`${path}/${R5_ORIGINAL_JOB.jobId}`)
                  .set('Authorization', auth),
            ),
          qualify: () => qualify('failed'),
          retry: () =>
            metadataHttp('ASYNC_ORIGINAL_JOB_EXPLICIT_RETRY_METADATA', async () => {
              const response = await request(httpServer)
                .post(`${path}/${R5_ORIGINAL_JOB.jobId}/retry`)
                .set('Authorization', auth);
              persist({
                kind: 'ASYNC_ORIGINAL_JOB_RETRY_RESPONSE',
                status: response.status,
                body: diagnostics.body(response.body),
                newAcceptance: false,
                prepareReplayed: false,
              });
              return response;
            }),
        }),
      );
      await qualify('retry-pending');
    } else {
      const accepted = await stage('HTTP_ACCEPT_ORDINARY_TRANSACTION', () =>
        metadataHttp(
          'ASYNC_HTTP_ACCEPT_METADATA',
          async () =>
            await request(httpServer).post(path).set('Authorization', auth).send(f.command),
        ),
      );
      persist({
        kind: 'ASYNC_HTTP_ACCEPT',
        status: accepted.status,
        code: accepted.body.code,
        data: accepted.body.data,
      });
      assert.equal(accepted.status, 201);
      assert.equal(accepted.body.code, 0);
      jobId = accepted.body.data?.jobId;
      assert.equal(accepted.body.data.applied, false);
      assert.equal(accepted.body.data.completedUnits, 0);
    }
    assert(typeof jobId === 'string' && jobId.length > 0);
    await queues(jobId);
    await verifyCatalog();
    assert(authorityBirth);
    const owned = [await readR5OwnedBackend(observer), authorityBirth];
    await boundary('BEFORE_REAL_WORKER_ROUND', owned);
    checkpoint(
      prepared240 ? R5_SNAPSHOT120_PUBLICATION_RESERVES.worker : fullChain ? 85_000 : 25_000,
    );
    const drained = await stage('ONE_REAL_WORKER_DRAIN', () =>
      route.withinCaller(() => worker.drainOnce()),
    );
    assert(metadataXids.length >= 2, 'claim and attempt-marker transactions must be observed');
    for (const identity of metadataXids) {
      const status = await observer.$queryRaw<{ status: string | null }[]>`
        SELECT pg_xact_status(${identity.xid}::xid8) AS status`;
      persist({ kind: 'ASYNC_WORKER_METADATA_SERVER_OUTCOME', identity, status });
      assert.deepEqual(status, [{ status: 'committed' }]);
    }
    persist({ kind: 'ASYNC_WORKER_RESULT', drained, nativeInvocations });
    assert.equal(methodObservationFailed, false, 'native method observation ownership failed');
    assert.equal(drained.jobId, jobId);
    assert.equal(drained.jobsEnqueued, 0);
    assert.equal(nativeInvocations, 1);
    assertR5AsyncSingleCommit(attempts, scope);
    const record = JSON.parse(readFileSync(attempts[0].evidenceRef, 'utf8')) as {
      transactions: { identity: { xid: string } }[];
      server: { status: string; observerPid: number; identity: { pid: number } }[];
    };
    assert.equal(record.transactions.length, 1);
    assert.equal(record.server.length, 1);
    assert.equal(record.server[0].status, 'committed');
    assert.notEqual(record.server[0].observerPid, record.server[0].identity.pid);
    const xid = record.transactions[0].identity.xid;
    const nativeTiming = assertR5AsyncNativeReceipt(record, scope);
    persist({
      kind: firstLaunch
        ? 'FIRST_LAUNCH_NATIVE60_FULL_TERMINAL_TIMING'
        : 'ASYNC_NATIVE15_FULL_TERMINAL_TIMING',
      ...nativeTiming,
      diagnosticOverheadSubtracted: false,
      configuredBudgetChangedDuringAttempt: false,
      historicalBudgetChanged: firstLaunch,
      expectedNativeBudgetMs: scope.nativeMs,
    });
    const finals = await observer.$queryRaw<{ object: string; state: string; xmin: string }[]>`
      SELECT 'application' AS object,"statusCode" AS state,xmin::text FROM "CorrectionApplication" WHERE id=${app.id}
      UNION ALL SELECT 'request',"statusCode",xmin::text FROM "AttendanceCorrectionRequest" WHERE id=${f.requestId}
      UNION ALL SELECT 'batch',"statusCode",xmin::text FROM "LedgerPostingBatch" WHERE id=${f.command.postingBatchId}
      UNION ALL SELECT 'job',"statusCode",xmin::text FROM "ActivityBatchJob" WHERE id=${jobId}
      UNION ALL SELECT 'item',"statusCode",xmin::text FROM "ActivityBatchJobItem" WHERE "jobId"=${jobId} AND "itemKey"='human-correction-commit:v2'`;
    persist({ kind: 'ASYNC_INDEPENDENT_ATOMIC_PUBLICATION', xid, finals });
    assert.deepEqual(finals.map((x) => [x.object, x.state]).sort(), [
      ['application', 'committed'],
      ['batch', 'committed'],
      ['item', 'succeeded'],
      ['job', 'succeeded'],
      ['request', 'applied'],
    ]);
    assert(finals.every((x) => x.xmin === xid));
    if (fullChain || prepared240) {
      const atomic = await observer.$queryRaw<{ object: string; xmin: string }[]>`
        SELECT context#>>'{extra,operation}' AS object,xmin::text FROM "audit_logs"
        WHERE "resourceType"='activity' AND "resourceId"=${f.activityId} AND event='activity.publish' AND success
          AND context#>>'{extra,postingBatchId}'=${f.command.postingBatchId}
          AND context#>>'{extra,operation}' IN('settlement-ledger-commit','correction-commit')
        UNION ALL SELECT 'outbox',xmin::text FROM "notification_outbox_intents"
        WHERE "eventKey"=${'settlement-ledger-commit:' + f.command.postingBatchId}`;
      assert.deepEqual(atomic.map((r) => r.object).sort(), [
        'correction-commit',
        'outbox',
        'settlement-ledger-commit',
      ]);
      assert(atomic.every((r) => r.xmin === xid));
      persist({
        kind: 'FULL_CHAIN_ATOMIC_TWO_AUDITS_ONE_OUTBOX',
        nativeXid: xid,
        prepareXid: fullChainPrepareXid,
        atomic,
      });
    }
    const protectedRows = await observer.activityBatchJobItem.findMany({
      where: { jobId, itemKey: 'human-correction-commit:v2' },
      select: {
        id: true,
        jobId: true,
        payloadHash: true,
        attempts: true,
        statusCode: true,
        resultReference: true,
      },
    });
    const jobPayload = await observer.activityBatchJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { payload: true },
    });
    const { humanCorrectionItemHash, parseHumanCorrectionJobPayload } =
      await import('../../src/modules/activities/human-correction-intent');
    assert.equal(protectedRows.length, 1);
    assert.equal(
      protectedRows[0].payloadHash,
      humanCorrectionItemHash(jobId, parseHumanCorrectionJobPayload(jobPayload.payload)),
    );
    assert.equal(protectedRows[0].attempts, originalJobRetry ? R5_ORIGINAL_JOB.itemEpoch + 1 : 1);
    assert.equal(protectedRows[0].statusCode, 'succeeded');
    assert.equal(protectedRows[0].resultReference, app.id);
    persist({ kind: 'ASYNC_PROTECTED_ITEM_TERMINAL', item: protectedRows[0], nativeXid: xid });
    if (capacityChecks && capacityFixture && capacityBefore) {
      const completeSet = await stage('CAPACITY1000_FULL_SET_SEALED_LEDGER_AUDIT', () =>
        capacityChecks.assertR5AsyncCapacity1000Published(
          observer,
          capacityFixture!,
          capacityBefore,
        ),
      );
      persist({
        kind: 'ASYNC_CAPACITY1000_MATERIALIZED_FACTS',
        completeSet,
        units: m.capacity,
        nativeXid: xid,
        referenceDifferential: 'NOT_EXERCISED_BY_POSITIVE_COMMIT',
        rollback: 'NOT_EXERCISED_BY_POSITIVE_COMMIT',
      });
    }
    const detail = await metadataHttp(
      'ASYNC_HTTP_DETAIL_METADATA',
      async () => await request(httpServer).get(`${path}/${jobId}`).set('Authorization', auth),
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.body.code, 0);
    assert.equal(detail.body.data.stage, 'applied');
    assert.equal(detail.body.data.applied, true);
    assert.equal(detail.body.data.completedUnits, 1);
    assert.equal(detail.body.data.totalUnits, 1);
    if (originalJobRetry) {
      // Read progress only: no second acceptance, retry or worker invocation.
      const stable = await metadataHttp(
        'ASYNC_ORIGINAL_JOB_COMMITTED_RESULT_RECHECK',
        async () => await request(httpServer).get(`${path}/${jobId}`).set('Authorization', auth),
      );
      assert.equal(stable.status, 200);
      assert.equal(stable.body.data.jobId, jobId);
      assert.equal(stable.body.data.applied, true);
    } else {
      const replay = await metadataHttp(
        'ASYNC_HTTP_IDEMPOTENT_ACCEPT_METADATA',
        async () => await request(httpServer).post(path).set('Authorization', auth).send(f.command),
      );
      assert.equal(replay.status, 201);
      assert.equal(replay.body.data.jobId, jobId);
    }
    assert.equal(nativeInvocations, 1);
    await assertNativeLaunchFrozenOracle(observer, root, scope.oracleEvaluations, stage);
    if (prepared240) checkpoint(R5_SNAPSHOT120_PUBLICATION_RESERVES.finalSnapshot);
    const after = await stage('FULL_TABLE_FINAL_CENSUS', () =>
      snapshotR5SetmatTables(observer, (report) => persist(report), m.auxiliarySnapshot),
    );
    persist({
      kind: 'ASYNC_FULL_CENSUS',
      before,
      after,
      note: 'real COMMIT changes rows; equality is not a rollback assertion',
    });
    assert.deepEqual(await readR5PreparedContinuation(observer, m.base), retainedBefore);
    await verifyCatalog();
    await boundary('AFTER_ORACLE_AND_REPLAY', owned);
    resources();
    if (capacityChecks) {
      persist({
        kind: 'ASYNC_CAPACITY1000_POSITIVE_CASE_BEFORE_CLOSEOUT',
        nativeXid: xid,
        nativeAttempts: attempts.length,
        oracleEvaluations: 8000,
        idempotentHttpReplayVerified: !originalJobRetry,
        originalJobRetryOnly: originalJobRetry,
        newHttpAcceptance: !originalJobRetry,
        priorNativeFailurePreserved: originalJobRetry,
        oldPreparedUnchanged: true,
        fullTableManifestCaptured: true,
        ...capacityChecks.R5_ASYNC_CAPACITY1000_EVIDENCE_BOUNDARY,
        ...(prepared240
          ? {
              positiveCase: 'PREPARE240_ALREADY_COMMITTED_PUBLICATION60_ONLY',
              prepareEvidence: R5_PREPARED240_PUBLICATION.evidenceLibraryId,
              prepareXid: fullChainPrepareXid,
              newRequestReviewPrepareInvocations: 0,
              priorFullChainFailurePreserved: true,
              combinedContinuousFullChainPass: false,
              auxiliarySnapshot: m.auxiliarySnapshot,
              auxiliarySnapshotsOutsideNativeTransaction: true,
            }
          : {}),
        ...(fullChain
          ? {
              positiveCase: 'NEW_LEGAL_REQUEST_FULL_CHAIN_PREPARE240_BACKGROUND60',
              prepareXid: fullChainPrepareXid,
              prepareAndNativeTransactionBudgets: [240000, 60000],
              sourceSetupReplayed: false,
              successfulPriorRequestOrTaskReplayed: false,
              sourceEvidence: m.fullChainSource?.evidenceLibraryId,
              independentHumanApprovals: 1,
              sourceSettlementTwoReviewProtocolUnchanged: true,
              old120And15FailuresPreserved: true,
              phaseIncludesNewRequestReviewPrepareCommitAndVerification: true,
            }
          : {}),
        ...(m.continuation
          ? {
              positiveCase: m.continuation.preparedPublication
                ? 'COMMITTED_PREPARE_PUBLICATION_ONLY_REAL_COMMIT'
                : 'RETAINED_FULL_ROOT_DELTA1000_REAL_COMMIT',
              priorPrepareClientFailurePreserved: m.continuation.preparedPublication
                ? true
                : undefined,
              prepareReplayed: false,
              sourceSetupExcludedMs: m.continuation.source.completedFixtureElapsedMs,
              sourceEvidence: m.continuation.source.evidenceLibraryId,
              originalFailedCampaignPreserved: true,
              originalFreshEndToEndCasePassed: false,
            }
          : {}),
        harnessCloseout: 'PENDING',
        independentOwnerResourceCloseout: 'REQUIRED',
      });
    }
    outcome = 'PASS';
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
    // A metadata Promise rejection is not independent proof of its rollback.
    // Retain the entire owned scope on any incomplete write-stage failure;
    // already observed native COMMITTED/ROLLED_BACK remains separately recorded.
    if (writesStarted) uncertain = true;
    diagnostics.emit({
      kind: 'ASYNC_STAGE_FAILURE',
      errorType: error instanceof Error ? error.name : typeof error,
      error: diagnostics.error(error),
      nativeAttempts: attempts.length,
      nativeOutcomes: attempts.map((x) => x.databaseOutcome),
      uncertain,
      automaticRetry: false,
    });
  } finally {
    diagnostics.emit({ kind: 'ASYNC_CLOSEOUT_BEGIN', outcome, uncertain, leasePid });
    try {
      diagnostics.assertHealthy();
    } catch (error) {
      uncertain = true;
      outcome = 'FAIL';
      closeoutFailed = true;
      closeoutError = error;
    }
    if (uncertain) {
      diagnostics.emit({
        kind: 'ASYNC_UNKNOWN_RESOURCES_RETAINED',
        leasePid,
        next: 'sole owner independently resolves recorded XIDs/PIDs before teardown; no replay',
      });
    } else
      try {
        restoreNative?.();
        restoreRole?.();
        if (fixture && !fixtureObservationRestored) {
          fixture.restoreObservation();
          fixtureObservationRestored = true;
        }
        await workerContext?.close();
        await httpApp?.close();
        await workerDb?.$disconnect();
        if (!preparationAppRetired) await (fixture?.app ?? preparationApp)?.close();
        await fixture?.callerDb?.$disconnect();
        if (held) {
          await boundary('FINAL_BEFORE_OWNED_UNLOCK', [await readR5OwnedBackend(observer)]);
          const unlock = await lease.$queryRaw<{ pid: number; unlocked: boolean }[]>`
          SELECT pg_backend_pid() AS pid,pg_advisory_unlock(hashtextextended('SRVF:test:D3:app_test_w98',0)) AS unlocked`;
          assert.deepEqual(unlock, [{ pid: leasePid, unlocked: true }]);
          persist({ kind: 'ASYNC_LEASE_RELEASED', unlock });
        }
        await observer.$disconnect();
        await lease.$disconnect();
        process.env.DATABASE_URL = originalUrl;
      } catch (error) {
        uncertain = true;
        outcome = 'FAIL';
        if (!closeoutFailed) {
          closeoutFailed = true;
          closeoutError = error;
        }
        diagnostics.emit({
          kind: 'ASYNC_CLOSEOUT_FAILED',
          error: diagnostics.error(error),
          next: 'inspect owned backends, lease and XIDs; never report resource closure',
        });
      }
    diagnostics.emit({
      kind: 'ASYNC_CLOSEOUT_END',
      outcome,
      uncertain,
      realCommitEvidence: attempts.map((x) => x.evidenceRef),
    });
  }
  if (primaryFailed) throw primaryError;
  if (closeoutFailed) throw closeoutError;
  diagnostics.assertHealthy();
  assert.equal(
    outcome,
    'PASS',
    'async smoke failed; immutable receipts retained, never retry this phase',
  );
}
