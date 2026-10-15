import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  mkdtempSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  readE4DiagnosticStageReceipt,
  e4DiagnosticErrorCategory,
} from './e4-diagnostic-limits-client';
import ts from 'typescript';
import type { PrismaClient } from '@prisma/client';
import type { E4Fixture, createE4Source } from './activity-contribution-policy.fixture';
import { runInNewContext } from 'node:vm';
import {
  E4_DIAGNOSTIC_PLAN,
  frozenE4OracleSource,
  frozenOrdinaryOracleSource,
  verifyDiagnosticMigrationSource,
  verifyDiagnosticDatabase,
  createDiagnosticE4Source,
  diagnosticOracleClient,
  oracleStageWrappers,
  canonicalCostQueries,
  compactCanonicalCostPlan,
  compactCanonicalActualPlan,
  CANONICAL_JIT_ORDER,
  assertCanonicalComparison,
  firstCanonical32Client,
  diagnosticPopulation,
  requireDiagnosticEnvironment,
  sharedGuardStatement,
  sharedGuardProbeSql,
  compactSharedGuardNotice,
  joinKeyCandidateSource,
  joinKeyProbeSql,
  compactJoinKeyEvidence,
  compactJoinKeyPositiveEvidence,
  compactJoinKeyFailure,
  JOIN_KEY_ORDER,
  joinKeyOracleGate,
  JOIN_KEY_CALIBRATION_ORDER,
  compactJoinKeyCalibrationEvidence,
  joinKeyCalibrationGate,
  calibrationCleanupSql,
  joinKeyDiagnosticNotices,
  E4_METADATA_FIELDS,
  E4_METADATA_CASE_DIGEST,
  metadataCanonicalExpression,
  metadataCanonicalCandidateSource,
  metadataCanonicalCases,
  metadataCanonicalEquivalenceSql,
  compactMetadataCanonicalEvidence,
  compactMetadataPriorityEvidence,
  compactMetadataProgress,
  E4_FIXED_METADATA_CANDIDATE,
  FIXED_METADATA_MAX_ORDER,
  compactFixedMetadataMaximumEvidence,
  completeFixedMetadataPostOracle,
  nativePlanCategory,
  compactNativePrepareLog,
  validateNativeCapability,
  nativePrepareCompleteness,
  nativePlanFailureCategory,
  SOURCE_JOIN_BASELINE_SHA,
  sourceJoinFunction,
  sourceJoinSessionSql,
  compactSourceJoinEvidence,
  compactSourceJoinPlans,
  validateSourceJoinCalibration,
  SOURCE_JOIN_REUSABLE_SMALL,
  SOURCE_JOIN_INPUTS,
  SOURCE_STATISTICS_ORDER,
  SOURCE_STATISTICS_SETTINGS,
  sourceJoinStatsDigestSql,
  compactSourceStatisticsEvidence,
  installRealStatistics,
  realStatisticsAnalyzeCommands,
  realStatisticsSnapshotSql,
  realStatisticsCapabilitySql,
  validateRealStatisticsCapability,
  writeRealStatisticsArtifact,
  retainRealStatisticsArtifact,
  assessColdBucketCandidate,
  E4_REAL_SOURCE_C,
  verifyRealSourceDatabase,
  verifyRealSourceMigrationSource,
  diagnosticTransactionMs,
  readDiagnosticChildReport,
  observePrepareFailureFacts,
} from '../diagnostics/e4-prepare-cost.diagnostic-spec';
const head = 'a'.repeat(40);
const env: NodeJS.ProcessEnv = {
  SRVF_E4_DIAGNOSTIC_PURPOSE: 'DIAGNOSTIC_ONLY',
  APP_ENV: 'test',
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'BA7IEE/srvf-nest-api',
  GITHUB_REF: 'refs/heads/codex/activity-os-r5-e4-github-validation',
  GITHUB_SHA: head,
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_RUN_ID: '123',
  SRVF_E4_GITHUB_ISOLATED: '1',
  SRVF_TEST_RUN_SCOPE: 'app_test_w98',
  SRVF_E4_W98: '1',
  SRVF_E4_DIAGNOSTIC_SCENARIO: 'maximum',
};
describe('E4 prepare cost closed driver (offline; no lifecycle registered)', () => {
  it('retains independent prepare rollback counts and marks a failed observation UNKNOWN without throwing', async () => {
    const zero = {
      roots: 0,
      evaluations: 0,
      timeRoots: 0,
      buckets: 0,
      sources: 0,
      receipts: 0,
      audits: 0,
    };
    const statements = jest.fn(async () => 0);
    const query = (facts: object) => ({
      $transaction: jest.fn(async (work: (tx: object) => Promise<unknown>) =>
        work({ $executeRaw: statements, $queryRaw: jest.fn(async () => [facts]) }),
      ) as unknown as PrismaClient['$transaction'],
    });
    await expect(
      observePrepareFailureFacts(query(zero), 'private-activity', 'private-operation'),
    ).resolves.toMatchObject({ status: 'OBSERVED_SEVEN_ZERO', facts: zero });
    await expect(
      observePrepareFailureFacts(
        query({ ...zero, roots: 1 }),
        'private-activity',
        'private-operation',
      ),
    ).resolves.toMatchObject({ status: 'REMAINS' });
    const failed = {
      $transaction: jest.fn(async () => {
        throw new Error('private observer failure');
      }) as unknown as PrismaClient['$transaction'],
    };
    await expect(
      observePrepareFailureFacts(failed, 'private-activity', 'private-operation'),
    ).resolves.toMatchObject({ status: 'UNKNOWN', observer: true });
    expect(statements).toHaveBeenCalled();
  });
  it.each(['COMPLETE', 'FAILED'] as const)(
    'retains the serialized real C%s child report at30s and refuses90s',
    (status) => {
      const root = mkdtempSync(resolve(tmpdir(), 'e4-real-c-child-'));
      const realEnv = { SRVF_E4_REAL_SOURCE_C: '1' };
      try {
        const data = {
          ...E4_DIAGNOSTIC_PLAN,
          head,
          run: '123',
          scenario: 'maximum',
          transactionMs: 30000,
          status,
          stages: [{ stage: 'PREPARE', outcome: status }],
          realSourceCandidate: E4_REAL_SOURCE_C,
        };
        const file = resolve(root, 'child.json');
        writeFileSync(file, JSON.stringify(data));
        expect(readDiagnosticChildReport(root, head, '123', 'maximum', realEnv)).toEqual(data);
        expect(readDiagnosticChildReport(root, head, '123', 'maximum', {})).toBeUndefined();
        writeFileSync(file, JSON.stringify({ ...data, transactionMs: 90000 }));
        expect(readDiagnosticChildReport(root, head, '123', 'maximum', realEnv)).toBeUndefined();
        expect(diagnosticTransactionMs(realEnv)).toBe(30000);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it('allows current144 controls only in explicit isolated worker databases without widening legacy W98 checks', () => {
    expect(
      sourceJoinSessionSql(
        'a'.repeat(24),
        true,
        false,
        'C',
        E4_REAL_SOURCE_C.sourceFunctionMd5,
        'app_test_w1',
      ),
    ).toContain("current_database()<>'app_test_w1'");
    expect(() =>
      sourceJoinSessionSql(
        'a'.repeat(24),
        true,
        false,
        'C',
        E4_REAL_SOURCE_C.sourceFunctionMd5,
        'production',
      ),
    ).toThrow();
    expect(() =>
      sourceJoinSessionSql('a'.repeat(24), true, false, 'C', undefined, 'app_test_w1'),
    ).toThrow();
  });
  it.each(['ordinary-1', 'ordinary-500', 'maximum'])(
    'admits real C full-chain%s only without diagnostic competitors',
    (scenario) => {
      const real = { ...env, SRVF_E4_REAL_SOURCE_C: '1', SRVF_E4_DIAGNOSTIC_SCENARIO: scenario };
      expect(() => requireDiagnosticEnvironment(real, head)).not.toThrow();
      for (const key of [
        'SRVF_E4_REAL_STATISTICS',
        'SRVF_E4_SOURCE_JOIN_C',
        'SRVF_E4_NATIVE_PREPARE_PLAN',
        'SRVF_E4_JOIN_KEY_ONCE',
        'SRVF_E4_CANONICAL_FIRST32',
      ])
        expect(() => requireDiagnosticEnvironment({ ...real, [key]: '1' }, head)).toThrow();
      expect(() =>
        requireDiagnosticEnvironment(
          { ...real, SRVF_E4_DIAGNOSTIC_SCENARIO: 'ordinary-100' },
          head,
        ),
      ).toThrow();
    },
  );
  it('pins144 in addition to143 and rejects a disabled native guard or changed installed source', async () => {
    expect(() => verifyRealSourceMigrationSource()).not.toThrow();
    const correct = {
      count: 144,
      prior_checksum: E4_DIAGNOSTIC_PLAN.migration143Sha256,
      checksum: E4_REAL_SOURCE_C.migrationSha256,
      complete_pin: E4_DIAGNOSTIC_PLAN.completeFunctionMd5,
      source_pin: E4_REAL_SOURCE_C.sourceFunctionMd5,
      statement_guard: true,
      deferred_guard: true,
    };
    const query = (value: object) => ({
      $queryRaw: jest.fn(async () => [value]) as unknown as PrismaClient['$queryRaw'],
    });
    await expect(verifyRealSourceDatabase(query(correct))).resolves.toBeUndefined();
    for (const change of [
      { count: 143 },
      { prior_checksum: '0'.repeat(64) },
      { checksum: '0'.repeat(64) },
      { source_pin: 'd8934c5bf29f8b16f820ba6cd950698b' },
      { complete_pin: '0'.repeat(32) },
      { statement_guard: false },
      { deferred_guard: false },
    ])
      await expect(verifyRealSourceDatabase(query({ ...correct, ...change }))).rejects.toThrow();
  });
  it.each(['COMPLETE', 'FAILED'] as const)(
    'retains a real %s child artifact through parent hash validation and actual workflow chunks',
    (status) => {
      const root = mkdtempSync(resolve(tmpdir(), 'e4-sidecar-roundtrip-')),
        origin = resolve(root, 'child'),
        destination = resolve(root, 'parent');
      mkdirSync(origin);
      mkdirSync(destination);
      try {
        const artifact = {
          head,
          run: '123',
          scenario: 'maximum',
          purpose: 'DIAGNOSTIC_ONLY',
          businessFixtureExecuted: false,
          realStatistics: {
            status: status === 'COMPLETE' ? 'COMPLETE' : 'INCOMPLETE',
            restored: true,
            wallMs: 1.234,
            intentionalToolFailure: status === 'FAILED',
          },
        };
        const source = readFileSync(
          resolve(__dirname, '../diagnostics/e4-prepare-cost.diagnostic-spec.ts'),
          'utf8',
        );
        const ast = ts.createSourceFile(
          'driver.ts',
          source,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        );
        const declarations = ast.statements.filter(
          (n): n is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(n) &&
            !!n.name &&
            ['writeBounded', 'writeRealStatisticsArtifact'].includes(n.name.text),
        );
        expect(declarations).toHaveLength(2);
        const writer = ts.transpileModule(declarations.map((n) => n.getText(ast)).join('\n'), {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText;
        const code = `const {readFileSync,writeFileSync}=require('node:fs');const {join}=require('node:path');const {createHash}=require('node:crypto');${writer}\nconst value=JSON.parse(process.argv[2]);const ref=writeRealStatisticsArtifact(process.argv[1],value);process.stdout.write(JSON.stringify({...ref,status:value.realStatistics.status,restored:true}));process.exitCode=Number(process.argv[3]);`;
        const child = spawnSync(
          process.execPath,
          ['-e', code, origin, JSON.stringify(artifact), status === 'COMPLETE' ? '0' : '3'],
          {
            env: {
              ...process.env,
              TS_NODE_PROJECT: resolve(__dirname, '../tsconfig.test.json'),
              SRVF_E4_DIAGNOSTIC_CHILD: '',
            },
            encoding: 'utf8',
            timeout: 20000,
            maxBuffer: 4096,
          },
        );
        expect(child.status).toBe(status === 'COMPLETE' ? 0 : 3);
        const ref = JSON.parse(child.stdout) as {
          file: string;
          sha256: string;
          status: string;
          restored: boolean;
        };
        retainRealStatisticsArtifact(origin, destination, ref, { head, run: '123', status });
        expect(
          createHash('sha256')
            .update(readFileSync(resolve(destination, ref.file)))
            .digest('hex'),
        ).toBe(ref.sha256);
        const result = {
          head,
          run: '123',
          scenario: 'maximum',
          purpose: 'DIAGNOSTIC_ONLY',
          coverage: 'FULL_SETTLEMENT',
          status,
          realStatistics: ref,
        };
        writeFileSync(resolve(destination, 'result.json'), JSON.stringify(result));
        const workflow = readFileSync(
          resolve(__dirname, '../../.github/workflows/activity-os-r5-e4-validation.yml'),
          'utf8',
        );
        const script = workflow.match(
          /- name: Summarize closed shared-guard evidence[\s\S]*?node <<'NODE'\n([\s\S]*?)\n\s+NODE/u,
        )?.[1];
        expect(script).toBeDefined();
        const mapped = (path: string) => resolve(destination, path.split('/').pop()!);
        let output = '';
        const stopped = new Error('STOP');
        try {
          runInNewContext(script!, {
            require: () => ({
              existsSync: (p: string) => existsSync(mapped(p)),
              statSync: (p: string) => statSync(mapped(p)),
              readFileSync: (p: string) => readFileSync(mapped(p), 'utf8'),
            }),
            process: {
              env: {
                SRVF_E4_REAL_STATISTICS: '1',
                GITHUB_SHA: head,
                GITHUB_RUN_ID: '123',
                SRVF_E4_DIAGNOSTIC_SCENARIO: 'maximum',
              },
              stdout: {
                write: (s: string) => {
                  output += s;
                },
              },
              exit: () => {
                throw stopped;
              },
            },
          });
        } catch (error) {
          if (error !== stopped) throw error;
        }
        const chunks = output
          .split('\n')
          .filter((l) => l.startsWith('E4_NATIVE_PLAN_CHUNK '))
          .map(
            (l) =>
              JSON.parse(l.slice('E4_NATIVE_PLAN_CHUNK '.length)) as {
                artifact: string;
                index: number;
                data: string;
              },
          );
        const recover = (name: string) =>
          JSON.parse(
            chunks
              .filter((c) => c.artifact === name)
              .sort((a, b) => a.index - b.index)
              .map((c) => c.data)
              .join(''),
          ) as unknown;
        expect(recover('result.json')).toEqual(result);
        expect(recover(ref.file)).toEqual(artifact);
        expect(
          createHash('sha256')
            .update(JSON.stringify(recover(ref.file), null, 2) + '\n')
            .digest('hex'),
        ).toBe(ref.sha256);
        expect(() =>
          retainRealStatisticsArtifact(
            origin,
            destination,
            { ...ref, sha256: '0'.repeat(64) },
            { head, run: '123', status },
          ),
        ).toThrow('hash refused');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30000,
  );
  it('changes only the original time-branch source JOIN into a narrow bucket-only lateral lookup', () => {
    const a = sourceJoinFunction(),
      c = sourceJoinFunction(true, 'C');
    const join =
      'JOIN "ParticipantSettlementTimeBucketSource" bs ON bs."bucketId"=b.id AND bs."activityId"=b."activityId" AND bs."timeRevisionId"=b."timeRevisionId"';
    const replacement = c.match(/JOIN LATERAL \([\s\S]*?\n {2}\) bs ON[^\n]+/u)?.[0];
    expect(replacement).toBeDefined();
    expect(c.replace(replacement!, join)).toBe(a);
    expect(replacement).toContain('WHERE bs0."bucketId"=b.id\n    OFFSET 0');
    expect(replacement?.split('WHERE ')[1].split('OFFSET 0')[0].trim()).toBe('bs0."bucketId"=b.id');
    expect(replacement).not.toMatch(/SELECT \*|DISTINCT|LIMIT|GROUP BY|ORDER BY|coalesce/iu);
    expect(c).not.toContain('time_source_edges AS MATERIALIZED');
    const sql = sourceJoinSessionSql('a'.repeat(24), true, false, 'C');
    for (const name of [
      'WRONG_ACTIVITY',
      'WRONG_TIME_REVISION',
      'NULL_ACTIVITY',
      'NULL_TIME_REVISION',
    ])
      expect(sql).toContain(name);
    expect(sql).not.toMatch(/^ANALYZE\b/gmu);
    expect(sql).toContain("'analyzedTables',0");
    expect(sql).not.toMatch(/SET(?: LOCAL)? (?:jit|work_mem|enable_\w+|plan_cache_mode)=/iu);
    expect(() => sourceJoinSessionSql('a'.repeat(24), false, true, 'C')).toThrow();
    expect(() =>
      requireDiagnosticEnvironment(
        {
          ...env,
          SRVF_E4_SOURCE_JOIN: 'statistics-500',
          SRVF_E4_SOURCE_JOIN_C: '1',
          SRVF_E4_DIAGNOSTIC_SCENARIO: 'ordinary-500',
        },
        head,
      ),
    ).toThrow();
  });
  it('rejects product scans, missing bucket Index Cond, unexercised baselines and unclear complete-guard gains', () => {
    const scan = {
      type: 'Index Scan',
      index: 'pstbs_bucket_allocation_key',
      bucketIdIndexCond: true,
      loops: 2000,
      rowsPerLoop: 1,
      rowsFilteredPerLoop: 0,
      hasFilter: false,
      rowsRecheckedPerLoop: 0,
    };
    const base = {
      ...scan,
      index: 'pstbs_revision_idx',
      bucketIdIndexCond: false,
      rowsFilteredPerLoop: 1999,
      hasFilter: true,
    };
    const plans = [
      { variant: 'BASELINE', probes: [base] },
      { variant: 'CANDIDATE', probes: [scan] },
      { variant: 'CANDIDATE', probes: [scan] },
      { variant: 'BASELINE', probes: [base] },
    ];
    const timings = plans.map((p, i) => ({
      phase: 'LATENCY',
      variant: p.variant,
      wallMs: [4000, 2700, 2600, 4100][i],
    }));
    expect(assessColdBucketCandidate(plans, timings)).toMatchObject({
      decision: 'PROCEED_TO_REAL_PATH_REVIEW',
      candidateScanWork: [2000, 2000],
      baselineScanWork: [4000000, 4000000],
    });
    for (const bad of [
      {
        ...scan,
        type: 'Seq Scan',
        index: 'OTHER',
        bucketIdIndexCond: false,
        rowsFilteredPerLoop: 1999,
        hasFilter: true,
      },
      { ...scan, bucketIdIndexCond: false },
      { ...scan, loops: 1250000, rowsPerLoop: 0 },
    ])
      expect(
        assessColdBucketCandidate(
          plans.map((p) => (p.variant === 'CANDIDATE' ? { ...p, probes: [bad] } : p)),
          timings,
        ).decision,
      ).toBe('REJECTED');
    expect(
      assessColdBucketCandidate(
        plans,
        timings.map((t) => ({ ...t, wallMs: 3000 })),
      ).decision,
    ).toBe('REJECTED');
    expect(
      assessColdBucketCandidate(
        plans.map((p) => ({ ...p, probes: [scan] })),
        timings,
      ).decision,
    ).toBe('REJECTED');
  });
  it('hashes the exact bounded statistics artifact bytes, including pretty formatting and trailing newline', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'e4-real-statistics-bytes-'));
    try {
      const artifact = {
        head,
        run: '123',
        scenario: 'maximum',
        purpose: 'DIAGNOSTIC_ONLY',
        realStatistics: { status: 'INCOMPLETE', wallMs: 1.234 },
      };
      const ref = writeRealStatisticsArtifact(directory, artifact);
      const raw = readFileSync(resolve(directory, ref.file));
      expect(ref.sha256).toBe(createHash('sha256').update(raw).digest('hex'));
      expect(ref.sha256).not.toBe(
        createHash('sha256')
          .update(JSON.stringify(artifact) + '\n')
          .digest('hex'),
      );
      expect(JSON.parse(raw.toString())).toEqual(artifact);
      expect(raw.toString().endsWith('\n')).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const realStatisticsHarness = () => {
    let stage: 'SOURCE_BUILD' | 'PREPARE' | 'SUBMIT' = 'SOURCE_BUILD',
      serial = 1,
      transaction = '1',
      mode = 'auto';
    const analyzed = new Set<string>(),
      events: string[] = [];
    const counts = () =>
      stage === 'SOURCE_BUILD'
        ? [0, 0, 10000, 50000, 2000]
        : stage === 'PREPARE'
          ? [8000, 40000, 10000, 50000, 2000]
          : [16000, 80000, 10000, 50000, 4000];
    const tx = {
      async $queryRawUnsafe(query: string) {
        expect(query).toBe(realStatisticsSnapshotSql());
        events.push('SNAPSHOT');
        return [
          {
            database: 'app_test_w98',
            local: false,
            writable: true,
            server: 160015,
            pid: 42,
            transaction,
            statisticsDigest: serial.toString(16).padStart(32, '0'),
            settingsDigest: (mode === 'auto' ? 'a' : 'c').repeat(32),
            workMemKb: 4096,
            jitEnabled: true,
            planCacheMode: mode,
            statistics: SOURCE_JOIN_INPUTS.map(([table], i) => ({
              table,
              rows: counts()[i],
              tuples: analyzed.has(table) ? counts()[i] : -1,
              statsColumns: analyzed.has(table) ? 2 : 0,
            })),
          },
        ];
      },
      async $executeRawUnsafe(query: string) {
        const name = query.match(/^ANALYZE public\."([A-Za-z]+)"$/u)?.[1];
        if (!name || !SOURCE_JOIN_INPUTS.some(([n]) => n === name))
          throw new Error('unexpected SQL');
        events.push('ANALYZE:' + name);
        analyzed.add(name);
        serial++;
        return 0;
      },
    };
    const target = {
      async prepareTimeInTx(received: typeof tx, ...args: unknown[]) {
        expect(this).toBe(target);
        expect(received).toBe(tx);
        events.push('PREPARE_ORIGINAL');
        mode = 'force_custom_plan';
        await target.insertEvaluations(received);
        return args;
      },
      async copySubmittedTimeInTx(received: typeof tx, ...args: unknown[]) {
        expect(this).toBe(target);
        expect(received).toBe(tx);
        events.push('SUBMIT_ORIGINAL');
        await target.copyEvaluations(received);
        return args;
      },
      async insertEvaluations(received: typeof tx) {
        expect(received).toBe(tx);
        events.push('INSERT_ORIGINAL');
      },
      async copyEvaluations(received: typeof tx) {
        expect(received).toBe(tx);
        events.push('COPY_ORIGINAL');
      },
    };
    const audit = {
      async log(received: typeof tx, ...args: unknown[]) {
        expect(this).toBe(audit);
        expect(received).toBe(tx);
        events.push('AUDIT_ORIGINAL');
        return args;
      },
    };
    return {
      tx,
      target,
      audit,
      events,
      drift: () => {
        serial++;
      },
      stage: (next: typeof stage) => {
        stage = next;
        transaction = String(Number(transaction) + 1);
        mode = 'auto';
      },
    };
  };
  it('rejects mixed modes and preserves the real maximum singleton, original30 and full-chain wiring', () => {
    expect(() =>
      requireDiagnosticEnvironment({ ...env, SRVF_E4_REAL_STATISTICS: '1' }, head),
    ).not.toThrow();
    for (const override of [
      { SRVF_E4_DIAGNOSTIC_SCENARIO: 'ordinary-500' },
      { SRVF_E4_REAL_STATISTICS: 'true' },
      { SRVF_E4_CANONICAL_FIRST32: '1' },
      { SRVF_E4_SOURCE_JOIN: 'statistics-500' },
      { SRVF_E4_NATIVE_PREPARE_PLAN: '1' },
    ])
      expect(() =>
        requireDiagnosticEnvironment({ ...env, SRVF_E4_REAL_STATISTICS: '1', ...override }, head),
      ).toThrow();
    const source = readFileSync(
      resolve(__dirname, '../diagnostics/e4-prepare-cost.diagnostic-spec.ts'),
      'utf8',
    );
    expect(source).toMatch(
      /maximum && !realStatistics && !realSource\s*\? installE4DiagnosticLimits/u,
    );
    expect(source).toContain('transactionMs: diagnosticTransactionMs()');
    expect(diagnosticTransactionMs({ SRVF_E4_REAL_STATISTICS: '1' })).toBe(30000);
    expect(diagnosticTransactionMs({})).toBe(90000);
    expect(source).toContain('statisticsControl.complete()');
    const workflow = readFileSync(
      resolve(__dirname, '../../.github/workflows/activity-os-r5-e4-validation.yml'),
      'utf8',
    );
    expect(workflow).toContain('inputs.real_statistics_maximum && \'["maximum"]\'');
    expect(workflow).toContain('--real-statistics-capability');
    expect(workflow).toContain("realStatistics || realSource ? 'FULL_SETTLEMENT'");
  });
  it('refreshes only the three committed source tables and five real-transaction inputs without any settings change', () => {
    expect(realStatisticsAnalyzeCommands('SOURCE_BUILD')).toEqual(
      SOURCE_JOIN_INPUTS.slice(2).map(([n]) => `ANALYZE public."${n}"`),
    );
    for (const stage of ['PREPARE', 'SUBMIT'] as const)
      expect(realStatisticsAnalyzeCommands(stage)).toEqual(
        SOURCE_JOIN_INPUTS.map(([n]) => `ANALYZE public."${n}"`),
      );
    expect(realStatisticsSnapshotSql()).toContain('txid_current()::TEXT');
    expect(realStatisticsSnapshotSql()).not.toContain('inet_server_addr');
    expect(realStatisticsSnapshotSql()).not.toMatch(/set_config|SET LOCAL|ALTER|UPDATE|INSERT/iu);
  });
  it('runs each original method once on the same tx, keeps both guard checkpoints, and restores every original', async () => {
    const h = realStatisticsHarness(),
      originals = [
        Reflect.get(h.target, 'prepareTimeInTx'),
        Reflect.get(h.target, 'copySubmittedTimeInTx'),
        Reflect.get(h.target, 'insertEvaluations'),
        Reflect.get(h.target, 'copyEvaluations'),
        Reflect.get(h.audit, 'log'),
      ];
    const controller = installRealStatistics(h.target, h.audit);
    await controller.source(h.tx);
    h.stage('PREPARE');
    const args = [{ original: 'time' }, 'policy_v1'];
    expect(await h.target.prepareTimeInTx(h.tx, ...args)).toEqual(args);
    await h.audit.log(h.tx, {}, {}, 'prepare_time_settlement');
    h.stage('SUBMIT');
    expect(await h.target.copySubmittedTimeInTx(h.tx, ...args)).toEqual(args);
    await h.audit.log(h.tx, {}, {}, 'submit_time_settlement');
    controller.complete();
    controller.restore();
    const proof = controller.snapshot();
    expect(proof).toMatchObject({
      status: 'COMPLETE',
      restored: true,
      prepareBudgetMs: 30000,
      inTransactionAnalyzeIncluded: true,
      conditionalOnly: true,
    });
    expect(proof.stages.map((s) => [s.stage, s.commands])).toEqual([
      ['SOURCE_BUILD', 3],
      ['PREPARE', 5],
      ['SUBMIT', 5],
    ]);
    expect(proof.checks).toHaveLength(6);
    expect(h.events.filter((e) => e === 'INSERT_ORIGINAL')).toHaveLength(1);
    expect(h.events.filter((e) => e === 'COPY_ORIGINAL')).toHaveLength(1);
    expect(
      h.events.slice(
        h.events.indexOf('PREPARE_ORIGINAL') - 5,
        h.events.indexOf('PREPARE_ORIGINAL'),
      ),
    ).toContain('SNAPSHOT');
    expect([
      Reflect.get(h.target, 'prepareTimeInTx'),
      Reflect.get(h.target, 'copySubmittedTimeInTx'),
      Reflect.get(h.target, 'insertEvaluations'),
      Reflect.get(h.target, 'copyEvaluations'),
      Reflect.get(h.audit, 'log'),
    ]).toEqual(originals);
    expect(JSON.stringify(proof)).not.toMatch(/"pid"|"transaction"/u);
  });
  it('refuses a statistics drift inside the actual INSERT guard and preserves the failure', async () => {
    const h = realStatisticsHarness();
    h.target.insertEvaluations = async (received) => {
      expect(received).toBe(h.tx);
      h.drift();
    };
    const controller = installRealStatistics(h.target, h.audit);
    h.stage('PREPARE');
    await expect(h.target.prepareTimeInTx(h.tx)).rejects.toThrow(
      'E4 real statistics drift refused',
    );
    expect(() => controller.complete()).toThrow();
    controller.restore();
    expect(controller.snapshot().restored).toBe(true);
  });
  it('does not swallow an original SQLSTATE failure or invoke later guards, and restores on the failed path', async () => {
    const h = realStatisticsHarness(),
      failure = Object.assign(new Error('controlled'), { code: '23514' });
    h.target.insertEvaluations = async () => {
      throw failure;
    };
    const controller = installRealStatistics(h.target, h.audit);
    h.stage('PREPARE');
    await expect(h.target.prepareTimeInTx(h.tx)).rejects.toBe(failure);
    expect(controller.snapshot().checks.map((c) => c.point)).toEqual(['BEFORE_INSERT_GUARD']);
    controller.restore();
    expect(controller.snapshot()).toMatchObject({ status: 'INCOMPLETE', restored: true });
  });
  it('proves own uncommitted rows with five tiny temporary tables and a rolled-back native constraint failure', () => {
    const sql = realStatisticsCapabilitySql();
    expect(sql.match(/^ANALYZE pg_temp\./gmu)).toHaveLength(5);
    expect(sql.match(/CREATE TEMP TABLE "Participant/gu)).toHaveLength(5);
    expect(sql).toContain("VALUES ('one',1),('two',2),('three',3)");
    expect(sql).toContain('txid_current()::TEXT<>(SELECT transaction');
    expect(sql).toContain('EXCEPTION WHEN check_violation');
    expect(sql).not.toMatch(/ANALYZE public\.|COMMIT;|CREATE TABLE public/iu);
    const receipt = {
      head,
      run: '123',
      status: 'COMPLETE',
      server: 16,
      sameTransaction: true,
      tables: 5,
      rowsPerTable: 3,
      statisticsVisible: true,
      negativeSqlstate: '23514',
      negativeRolledBack: true,
      businessFixtureExecuted: false,
    };
    expect(
      validateRealStatisticsCapability({ ...receipt, private: 'CANARY' }, head, '123'),
    ).toEqual(receipt);
    for (const change of [
      { head: 'b'.repeat(40) },
      { sameTransaction: false },
      { rowsPerTable: 0 },
      { statisticsVisible: false },
      { negativeRolledBack: false },
      { businessFixtureExecuted: true },
    ])
      expect(() =>
        validateRealStatisticsCapability({ ...receipt, ...change }, head, '123'),
      ).toThrow();
  });
  const calibrationNotice = () => {
    let raw =
      'NOTICE: E4_JOIN_KEY_METADATA_EQUIVALENCE ' +
      JSON.stringify({
        cases: 37,
        bytesEqual: true,
        hashesEqual: true,
        publicHelpers: true,
        caseDigest: E4_METADATA_CASE_DIGEST,
        candidateSha256: createHash('sha256')
          .update(metadataCanonicalCandidateSource())
          .digest('hex'),
        canonicalBodyMd5: '4efaa26893651a9afa11825b772ee0b9',
        historicalCanonicalBodyMd5: 'ced7d8a0b439351a09db28dca7356760',
        dayBodyMd5: 'fb1c94691765f89a5c4f55d55fec92ea',
      }) +
      '\n' +
      JOIN_KEY_CALIBRATION_ORDER.map(
        ([phase, variant], index) =>
          'NOTICE: E4_JOIN_KEY_SAMPLE ' +
          JSON.stringify({
            index,
            phase,
            variant,
            wallMs: 1,
            returned: true,
            completeDocumentAndRootGuard: true,
            sameBackend: true,
            readonly: true,
            workMemKb: 4096,
            jitEnabled: true,
            planCacheMode: 'force_custom_plan',
          }) +
          '\n',
      ).join('');
    for (const kind of ['MISSING', 'EXTRA', 'TAMPERED'])
      for (const variant of ['BASELINE', 'CANDIDATE'])
        raw +=
          'NOTICE: E4_JOIN_KEY_NEGATIVE ' +
          JSON.stringify({
            kind,
            variant,
            sqlstate: '23514',
            constraint: 'e4_evaluation_guard',
            affected: 1,
            rolledBack: true,
            allShadowRowsRestored: true,
            markerRestored: true,
          }) +
          '\n';
    for (const [kind, constraint, mutations] of [
      ['SOURCE_EVALUATION_ROOT', 'e4_source_guard', 3],
      ['EVALUATION_ROOT', 'e4_evaluation_guard', 2],
      ['ROOT', 'e4_complete_guard', 1],
    ])
      for (const variant of ['BASELINE', 'CANDIDATE'])
        raw +=
          'NOTICE: E4_JOIN_KEY_METADATA_PRIORITY ' +
          JSON.stringify({
            kind,
            variant,
            sqlstate: '23514',
            constraint,
            mutations,
            allShadowRowsRestored: true,
            markerRestored: true,
          }) +
          '\n';
    return (
      raw +
      'NOTICE: E4_JOIN_KEY_COMPLETE ' +
      JSON.stringify({
        catalogUnchanged: true,
        guardsUnchanged: true,
        sameBackend: true,
        publicEvaluationCount: 4,
      }) +
      '\n'
    );
  };
  it('calibrates the same complete SQL, typed shadow and six mutations at four units without maximum plans', () => {
    const sql = joinKeyProbeSql('synthetic_root', 'app_test_w98', 4);
    expect(sql).toContain('expected x FULL JOIN actual a USING (key)');
    expect(sql).toContain('contribution root count/hash/total mismatch');
    expect(sql).toContain(
      'e4_evaluation_document(ROW(e.*)::public."ParticipantContributionEvaluation")',
    );
    expect(sql).toContain('count(*) FROM pg_temp.e4_probe_evaluations)<>4');
    expect(sql.match(/E4_JOIN_KEY_NEGATIVE_BEGIN /gu)).toHaveLength(6);
    expect(sql.match(/E4_JOIN_KEY_SAMPLE /gu)).toHaveLength(4);
    expect(sql).not.toContain("'ACTUAL_PLAN'");
    expect(() => compactJoinKeyEvidence(calibrationNotice())).toThrow();
    const result = compactJoinKeyCalibrationEvidence(calibrationNotice());
    expect(result.status).toBe('COMPLETE');
    expect(result.controls).toHaveLength(4);
    expect(result.cases).toHaveLength(6);
    expect(result.priorityCases).toHaveLength(6);
    expect(result.metadataCanonical?.cases).toBe(37);
    expect(JSON.stringify(result)).not.toMatch(/wallMs|LATENCY|ACTUAL_PLAN|Query Text/u);
  });
  it('changes only the canonical metadata expression in the additional small candidate', () => {
    const original = joinKeyCandidateSource();
    const candidate = metadataCanonicalCandidateSource();
    const before = original.match(
      /\(SELECT '\{' \|\| string_agg\(to_jsonb\(field_name\)[\s\S]*?\) field\)/u,
    )?.[0];
    expect(before).toBeDefined();
    expect(candidate.replace(metadataCanonicalExpression(), before!)).toBe(original);
    expect(candidate).toContain('expected x FULL JOIN actual a USING (key)');
    expect(candidate.slice(candidate.indexOf('  WITH documents AS MATERIALIZED ('))).toBe(
      original.slice(original.indexOf('  WITH documents AS MATERIALIZED (')),
    );
    expect(candidate).toContain('PERFORM e4_assert_frozen_selection(root)');
    expect(candidate).not.toContain('field_name COLLATE');
    expect(candidate).toContain("THEN astr_canonical_json(metadata->'beijingDayPointsJson')");
    const metadata = original.slice(
      original.indexOf("jsonb_build_object('participationIdentityId',identity_id"),
      original.indexOf('AS metadata\n  FROM selected'),
    );
    for (const key of E4_METADATA_FIELDS) expect(metadata).toContain("'" + key + "',");
    expect(E4_METADATA_FIELDS).toHaveLength(19);
  });
  it('covers every nullable field, PostgreSQL numeric spelling, escaped Unicode and actual Beijing boundary day calculations', () => {
    const cases = metadataCanonicalCases();
    expect(cases).toHaveLength(37);
    expect(new Set(cases.map((value) => value.label)).size).toBe(37);
    for (const key of E4_METADATA_FIELDS)
      expect(cases.some((value) => value.label === `null_${key}`)).toBe(true);
    expect(cases.find((value) => value.label === 'numeric_precision')!.metadata).toContain(
      '123456789012345678901234567890.123456789',
    );
    expect(cases.filter((value) => value.dayRefs !== null)).toHaveLength(6);
    const standalone = metadataCanonicalEquivalenceSql();
    expect(standalone).toContain('CREATE FUNCTION pg_temp.e4_metadata_canonical(');
    expect(standalone).toContain('pg_temp.e4_metadata_canonical(item)');
    expect(standalone).toContain('CREATE FUNCTION pg_temp.e4_metadata_current(');
    expect(standalone).toContain('pg_temp.e4_metadata_current(item)');
    expect(standalone).toContain(
      "convert_to(r.original,'UTF8') IS DISTINCT FROM convert_to(r.historical,'UTF8')",
    );
    expect(standalone).toContain('pg_temp.e4_metadata_day_points(');
    expect(standalone).not.toMatch(
      /CREATE (?:OR REPLACE )?FUNCTION public\.|INSERT INTO public\.|UPDATE public\./u,
    );
    expect(standalone).toContain("SET LOCAL statement_timeout='5s'");
    expect(standalone).toContain(
      "convert_to(r.original,'UTF8') IS DISTINCT FROM convert_to(r.candidate,'UTF8')",
    );
    const publicSql = metadataCanonicalEquivalenceSql(true);
    expect(publicSql).toContain('BEGIN READ ONLY');
    expect(publicSql).not.toContain('CREATE ');
    expect(publicSql).toContain('public.e4_day_points(');
  });
  it('refuses any byte/hash failure, changed case digest, helper body or candidate source binding', () => {
    expect(compactMetadataCanonicalEvidence(calibrationNotice(), true).cases).toBe(37);
    for (const raw of [
      calibrationNotice().replace('"bytesEqual":true', '"bytesEqual":false'),
      calibrationNotice().replace('"hashesEqual":true', '"hashesEqual":false'),
      calibrationNotice().replace('"cases":37', '"cases":36'),
      calibrationNotice().replace(E4_METADATA_CASE_DIGEST, '0'.repeat(64)),
      calibrationNotice().replace('ced7d8a0b439351a09db28dca7356760', '0'.repeat(32)),
      calibrationNotice().replace(
        createHash('sha256').update(metadataCanonicalCandidateSource()).digest('hex'),
        '0'.repeat(64),
      ),
    ])
      expect(() => compactMetadataCanonicalEvidence(raw, true)).toThrow();
    expect(() => compactMetadataCanonicalEvidence(calibrationNotice(), false)).toThrow();
  });
  it('requires exact source before evaluation before root priority and actual shadow/marker restoration', () => {
    expect(compactMetadataPriorityEvidence(calibrationNotice())).toHaveLength(6);
    for (const raw of [
      calibrationNotice().replace('"mutations":3', '"mutations":2'),
      calibrationNotice().replace(
        '"constraint":"e4_source_guard"',
        '"constraint":"e4_complete_guard"',
      ),
      calibrationNotice().replace('"allShadowRowsRestored":true', '"allShadowRowsRestored":false'),
      calibrationNotice().replace('"markerRestored":true', '"markerRestored":false'),
    ])
      expect(() => compactJoinKeyCalibrationEvidence(raw)).toThrow();
    const sql = joinKeyProbeSql('synthetic_root', 'app_test_w98', 4);
    expect(sql).toContain(
      'CREATE TEMP TABLE e4_probe_sources AS SELECT * FROM public.e4_source_rows',
    );
    expect(sql).toContain('SELECT * FROM pg_temp.e4_probe_sources');
    expect(sql).toContain('changed:=changed+affected');
    expect(sql).toContain('E4 metadata priority rollback refused');
    expect(sql).toContain("'roots',(SELECT jsonb_agg(to_jsonb(r)");
    expect(sql).toContain(
      "'sources',(SELECT md5(string_agg(fingerprint,',' ORDER BY fingerprint COLLATE \"C\"))",
    );
    expect(sql).toContain("sha256(convert_to(to_jsonb(s)::TEXT,'UTF8'))");
    expect(joinKeyProbeSql('synthetic_root', 'app_test_w98')).not.toContain(
      'E4_JOIN_KEY_METADATA_',
    );
  });
  it('retains current helper identities and exact native priority failure without arbitrary notice fields', () => {
    const raw =
      'NOTICE:  00000: E4_JOIN_KEY_METADATA_HELPERS {"canonicalBodyMd5":"4efaa26893651a9afa11825b772ee0b9","dayBodyMd5":"fb1c94691765f89a5c4f55d55fec92ea","private":"withheld"}\n' +
      'NOTICE: E4_JOIN_KEY_METADATA_PRIORITY_BEGIN EVALUATION_ROOT CANDIDATE\n' +
      'NOTICE: E4_JOIN_KEY_METADATA_PRIORITY_UNEXPECTED {"sqlstate":"42702","constraintMatches":false,"messageMatches":false,"private":"withheld"}\n';
    expect(compactMetadataProgress(raw)).toEqual({
      helperIdentity: {
        canonicalBodyMd5: '4efaa26893651a9afa11825b772ee0b9',
        dayBodyMd5: 'fb1c94691765f89a5c4f55d55fec92ea',
      },
      lastPriority: { kind: 'EVALUATION_ROOT', variant: 'CANDIDATE' },
      unexpected: { sqlstate: '42702', constraintMatches: false, messageMatches: false },
    });
    expect(compactMetadataProgress('NOTICE: E4_JOIN_KEY_METADATA_HELPERS {malformed}')).toEqual({
      helperIdentity: null,
      lastPriority: null,
      unexpected: null,
    });
    expect(JSON.stringify(compactMetadataProgress(raw))).not.toContain('withheld');
  });
  it('retains only the validated small prefix and refuses incomplete or cross-shape completion', () => {
    const prefix = calibrationNotice().split('NOTICE: E4_JOIN_KEY_NEGATIVE ')[0];
    expect(compactJoinKeyCalibrationEvidence(prefix, false).status).toBe('PARTIAL');
    expect(() => compactJoinKeyCalibrationEvidence(prefix)).toThrow();
    for (const raw of [
      calibrationNotice().replace('"sameBackend":true', '"sameBackend":false'),
      calibrationNotice().replace('"sqlstate":"23514"', '"sqlstate":"23505"'),
      calibrationNotice().replace('"publicEvaluationCount":4', '"publicEvaluationCount":8000'),
    ])
      expect(() => compactJoinKeyCalibrationEvidence(raw)).toThrow();
  });
  it('accepts PostgreSQL verbose success NOTICE prefixes without stripping native ERROR states', () => {
    const verbose = calibrationNotice().replaceAll(
      'NOTICE: E4_JOIN_KEY_',
      'NOTICE:  00000: E4_JOIN_KEY_',
    );
    expect(compactJoinKeyCalibrationEvidence(verbose).cases).toHaveLength(6);
    expect(compactJoinKeyCalibrationEvidence(verbose).controls).toHaveLength(4);
    expect(joinKeyDiagnosticNotices(verbose)).toBe(calibrationNotice());
    expect(joinKeyDiagnosticNotices('ERROR:  42702: withheld\n')).toBe('ERROR:  42702: withheld\n');
    expect(() => compactJoinKeyCalibrationEvidence(verbose.replace('00000:', '23514:'))).toThrow();
  });
  it('admits only the complete independently frozen ordinary-one shape and forbids maximum flags', () => {
    const calibration = {
      ...env,
      SRVF_E4_DIAGNOSTIC_SCENARIO: 'ordinary-1',
      SRVF_E4_JOIN_KEY_CALIBRATION: '1',
    };
    expect(() => requireDiagnosticEnvironment(calibration, head)).not.toThrow();
    for (const change of [
      { SRVF_E4_DIAGNOSTIC_SCENARIO: 'maximum' },
      { SRVF_E4_JOIN_KEY_CALIBRATION: '2' },
      { SRVF_E4_JOIN_KEY_ONCE: '1' },
      { SRVF_E4_CANONICAL_FIRST32: '1' },
      { SRVF_E4_SHARED_GUARD_ONCE: '1' },
      { SRVF_E4_CANONICAL_COST_ONLY: '1' },
    ])
      expect(() => requireDiagnosticEnvironment({ ...calibration, ...change }, head)).toThrow();
    const proof = {
      scenario: 'ordinary-1' as const,
      coverage: 'SMALL_JOIN_KEY_CALIBRATION_ONLY',
      oracle: 'COMPLETE',
      scenarioShape: { identities: 1, segments: 1, slices: 5, units: 4 },
      facts: {
        roots: 1,
        evaluations: 4,
        timeRoots: 1,
        buckets: 4,
        sources: 4,
        receipts: 1,
        audits: 1,
      },
    };
    expect(joinKeyCalibrationGate(proof, 4)).toBe('SMALL_COMPLETE_FROZEN_ORACLE');
    expect(() => joinKeyCalibrationGate({ ...proof, oracle: 'NOT_RUN' }, 4)).toThrow();
    expect(() => joinKeyCalibrationGate(proof, 8000)).toThrow();
    expect(() =>
      joinKeyCalibrationGate({ ...proof, facts: { ...proof.facts, sources: 0 } }, 4),
    ).toThrow();
  });
  it('selects exactly ordinary-one for explicit small dispatch while preserving existing maximum selection', () => {
    const workflow = readFileSync(
      resolve(__dirname, '../../.github/workflows/activity-os-r5-e4-validation.yml'),
      'utf8',
    );
    const expression = workflow.match(/scenario: \$\{\{ (fromJSON\([^\n]+) \}\}/u)?.[1];
    expect(expression).toBeDefined();
    const select = (
      small: boolean,
      message: string,
      maximum = false,
      native = false,
      sourceJoin = 'off',
    ) =>
      runInNewContext(expression!, {
        inputs: {
          small_metadata_calibration: small,
          fixed_metadata_maximum: maximum,
          native_prepare_plan_500: native,
          source_join_comparison: sourceJoin,
        },
        github: { event: { head_commit: { message } } },
        contains: (value: string, token: string) => value.includes(token),
        fromJSON: JSON.parse,
      }) as string[];
    expect(select(true, '')).toEqual(['ordinary-1']);
    expect(select(true, '[e4-join-key-once]')).toEqual(['ordinary-1']);
    expect(select(false, '[e4-join-key-calibration-once]')).toEqual(['ordinary-1']);
    expect(select(false, '[e4-join-key-once]')).toEqual(['maximum']);
    expect(select(false, '', true)).toEqual(['maximum']);
    expect(select(false, '', false, true)).toEqual(['ordinary-500']);
    expect(select(true, '[e4-join-key-once]', true, true)).toEqual(['ordinary-500']);
    expect(select(false, '', false, false, 'small')).toEqual(['ordinary-1']);
    expect(select(false, '', false, false, 'ordinary-500')).toEqual(['ordinary-500']);
    expect(select(false, '', false, false, 'statistics-500')).toEqual(['ordinary-500']);
    expect(workflow).toContain(
      "github.event_name == 'workflow_dispatch' && inputs.expected_sha == github.sha",
    );
  });
  it('changes only the time-revision join boundary and preserves correction, windows, JSON and ordering byte-identically', () => {
    const original = sourceJoinFunction(),
      candidate = sourceJoinFunction(true);
    expect(createHash('sha256').update(original).digest('hex')).toBe(SOURCE_JOIN_BASELINE_SHA);
    expect(candidate.slice(candidate.indexOf('  UNION ALL\n'))).toBe(
      original.slice(original.indexOf('  UNION ALL\n')),
    );
    expect(candidate.slice(0, candidate.indexOf('), time_source_edges'))).toBe(
      original.slice(0, original.indexOf('), raw_sources')),
    );
    expect(candidate).toContain('time_source_edges AS MATERIALIZED');
    const edges = candidate
      .split('time_source_edges AS MATERIALIZED (')[1]
      .split('), raw_sources AS MATERIALIZED (')[0];
    expect(edges).not.toContain('ParticipantTimeAllocationSlice');
    expect(edges).not.toMatch(/DISTINCT|GROUP BY|LIMIT|ORDER BY|COALESCE/iu);
    for (const clause of [
      'bs."bucketId"=b.id',
      'a.id=bs."allocationRevisionId"',
      'a."sourceSegmentRevision"=bs."sourceSegmentRevision"',
      'rr."participationIdentityId"=a."participationIdentityId"',
    ])
      expect(edges).toContain(clause);
    expect(candidate).toContain(
      's."allocationRevisionId"=e.allocation_id AND s."activityId"=e.activity_id AND s."categoryCode"=e.category_code',
    );
  });
  it('uses complete143 for source comparisons without metadata/key rewrites or plan/JIT overrides', () => {
    const sql = joinKeyProbeSql('a'.repeat(24), 'app_test_w98', 2000, false, true);
    expect(sql).toContain('SELECT * FROM pg_temp.e4_sj_rows(root.id)');
    expect(sql).not.toContain('E4_JOIN_KEY_METADATA_EQUIVALENCE');
    expect(sql).not.toContain("SET LOCAL plan_cache_mode='force_custom_plan'");
    expect(sql).not.toMatch(/SET(?: LOCAL)? (?:jit|work_mem|enable_\w+)=/iu);
    expect(sql.match(/RAISE LOG 'E4_SOURCE_JOIN_PLAN_BEGIN/gu)).toHaveLength(4);
    expect(sql.match(/SET auto_explain.log_min_duration='0' AS \$\$/gu)).toHaveLength(2);
    expect(sql).toContain('SELECT * FROM pg_temp.e4_sj_original(root.id)');
    const session = sourceJoinSessionSql('a'.repeat(24), false);
    expect(session).toContain('CREATE TEMP TABLE e4_sj_session AS SELECT');
    expect(session).toContain('FROM pg_temp.e4_sj_session s;\nDO $$ BEGIN');
    expect(session).not.toContain('DO $ BEGIN');
    expect(sql).toContain('EXCEPT ALL');
    expect(sql).toContain('allShadowRowsRestored');
    expect(() => joinKeyProbeSql('a'.repeat(24), 'app_test_w98', 8000, false, true)).toThrow();
    expect(() => joinKeyProbeSql('a'.repeat(24), 'app_test_w98', 2000)).toThrow();
    const small = joinKeyProbeSql('a'.repeat(24), 'app_test_w98', 4, false, true);
    for (const label of [
      'REVERSED_INPUT',
      'DUPLICATE_EDGE',
      'NULL_LINK',
      'MISSING_EDGE',
      'NULL_MEMBER',
    ])
      expect(small).toContain(label);
    expect(small).toContain('ORDER BY id COLLATE "C" DESC');
    expect(small).toContain('E4 source join controlled rollback');
  });
  it('admits source comparison only at its exact shape without competing variables', () => {
    for (const [mode, scenario] of [
      ['small', 'ordinary-1'],
      ['ordinary-500', 'ordinary-500'],
      ['statistics-500', 'ordinary-500'],
    ]) {
      const scoped = { ...env, SRVF_E4_SOURCE_JOIN: mode, SRVF_E4_DIAGNOSTIC_SCENARIO: scenario };
      expect(() => requireDiagnosticEnvironment(scoped, head)).not.toThrow();
      for (const change of [
        { SRVF_E4_DIAGNOSTIC_SCENARIO: 'maximum' },
        { SRVF_E4_NATIVE_PREPARE_PLAN: '1' },
        { SRVF_E4_JOIN_KEY_ONCE: '1' },
        { SRVF_E4_CANONICAL_FIRST32: '1' },
        { SRVF_E4_CANONICAL_JIT_ABBA: '1' },
      ])
        expect(() => requireDiagnosticEnvironment({ ...scoped, ...change }, head)).toThrow();
    }
  });
  it('binds a verified small receipt to the same candidate, current run and HEAD', () => {
    const proof = {
      head,
      forRun: '124',
      smallRun: '123',
      status: 'VERIFIED_SMALL',
      candidateSha256: createHash('sha256').update(sourceJoinFunction(true)).digest('hex'),
      resultSha256: 'b'.repeat(64),
    };
    expect(
      validateSourceJoinCalibration({ ...proof, secret: 'PRIVATE_CANARY' }, head, '124'),
    ).toEqual(proof);
    const cProof = {
      ...proof,
      candidateSha256: createHash('sha256').update(sourceJoinFunction(true, 'C')).digest('hex'),
    };
    expect(validateSourceJoinCalibration(cProof, head, '124', false, 'C')).toEqual(cProof);
    expect(() => validateSourceJoinCalibration(proof, head, '124', false, 'C')).toThrow();
    expect(() => validateSourceJoinCalibration(cProof, head, '124')).toThrow();
    for (const change of [
      { head: 'c'.repeat(40) },
      { forRun: '123' },
      { smallRun: '124' },
      { candidateSha256: 'a'.repeat(64) },
      { resultSha256: 'unknown' },
      { status: 'COMPLETE' },
    ])
      expect(() => validateSourceJoinCalibration({ ...proof, ...change }, head, '124')).toThrow();
  });
  it('reuses only the pinned small proof when both SQL definitions and original143 identity are unchanged', () => {
    const proof = {
      head,
      forRun: '124',
      smallRun: SOURCE_JOIN_REUSABLE_SMALL.run,
      status: 'VERIFIED_SMALL',
      candidateSha256: SOURCE_JOIN_REUSABLE_SMALL.candidateSha256,
      resultSha256: SOURCE_JOIN_REUSABLE_SMALL.resultSha256,
      calibrationHead: SOURCE_JOIN_REUSABLE_SMALL.head,
      sourceFunctionSha256: SOURCE_JOIN_BASELINE_SHA,
      completeFunctionMd5: E4_DIAGNOSTIC_PLAN.completeFunctionMd5,
    };
    expect(validateSourceJoinCalibration(proof, head, '124', true)).toMatchObject({
      head,
      calibrationHead: SOURCE_JOIN_REUSABLE_SMALL.head,
      reuseCondition: 'UNCHANGED_SOURCE_SQL_AND_ORIGINAL143',
    });
    for (const change of [
      { calibrationHead: head },
      { smallRun: '123' },
      { resultSha256: 'b'.repeat(64) },
      { sourceFunctionSha256: 'c'.repeat(64) },
      { completeFunctionMd5: 'a'.repeat(32) },
    ])
      expect(() =>
        validateSourceJoinCalibration({ ...proof, ...change }, head, '124', true),
      ).toThrow();
  });
  it('records actual initial statistics before A, then places exactly five test-only ANALYZE commands before analyzed ABBA', () => {
    const sql = sourceJoinSessionSql('a'.repeat(24), false, true);
    const commands = sql.match(/^ANALYZE public\."[A-Za-z]+";$/gmu);
    expect(commands).toEqual(SOURCE_JOIN_INPUTS.map(([name]) => `ANALYZE public."${name}";`));
    const position = sql.indexOf(commands![0]);
    expect(position).toBeGreaterThan(sql.indexOf("RAISE LOG 'E4_SOURCE_JOIN_PLAN_END 0'"));
    expect(position).toBeLessThan(sql.indexOf("RAISE LOG 'E4_SOURCE_JOIN_PLAN_BEGIN 1'"));
    expect(sql).toContain("current_database()<>'app_test_w98' OR inet_server_addr() IS NOT NULL");
    expect(sql).toContain('E4 source statistics test-only scope refused');
    expect(sql).toContain("'stage','PRE_ANALYZE'");
    expect(sql).not.toContain('cold unavailable');
    expect(
      sql.match(/UPDATE pg_temp.e4_probe_metadata SET source_stats=stats_digest/gu),
    ).toHaveLength(2);
    expect(
      sql.indexOf('UPDATE pg_temp.e4_probe_metadata SET source_stats=stats_digest'),
    ).toBeLessThan(sql.indexOf("RAISE LOG 'E4_SOURCE_JOIN_PLAN_BEGIN 0'"));
    expect(sql).not.toMatch(
      /SET(?: LOCAL)? (?:jit|work_mem|enable_\w+|default_statistics_target)=/iu,
    );
    expect(sourceJoinSessionSql('a'.repeat(24), false)).not.toMatch(/^ANALYZE public/mu);
    expect(() => sourceJoinSessionSql('a'.repeat(24), true, true)).toThrow();
    expect(() => joinKeyProbeSql('a'.repeat(24), 'postgres', 2000, false, true, true)).toThrow();
    const digest = sourceJoinStatsDigestSql(true);
    expect(digest).toContain('FROM pg_statistic');
    expect(digest).toContain('s.stavalues1::TEXT');
    expect(digest).not.toContain('last_analyze');
    expect(createHash('sha256').update(sourceJoinFunction(true)).digest('hex')).toBe(
      SOURCE_JOIN_REUSABLE_SMALL.candidateSha256,
    );
  });
  it('admits native plans only for ordinary500 without any alternate budget or candidate mode', () => {
    const native = {
      ...env,
      SRVF_E4_DIAGNOSTIC_SCENARIO: 'ordinary-500',
      SRVF_E4_NATIVE_PREPARE_PLAN: '1',
    };
    expect(() => requireDiagnosticEnvironment(native, head)).not.toThrow();
    for (const change of [
      { SRVF_E4_NATIVE_PREPARE_PLAN: '2' },
      { SRVF_E4_DIAGNOSTIC_SCENARIO: 'maximum' },
      { SRVF_E4_DIAGNOSTIC_SCENARIO: 'ordinary-1' },
      ...[
        'SRVF_E4_CANONICAL_COST_ONLY',
        'SRVF_E4_CANONICAL_JIT_ABBA',
        'SRVF_E4_CANONICAL_MEMORY_PAIR',
        'SRVF_E4_CANONICAL_FIRST32',
        'SRVF_E4_JOIN_KEY_ONCE',
        'SRVF_E4_JOIN_KEY_CALIBRATION',
        'SRVF_E4_SHARED_GUARD_ONCE',
        'SRVF_E4_FIXED_METADATA_MAX_ONCE',
      ].map((key) => ({ [key]: '1' })),
    ])
      expect(() => requireDiagnosticEnvironment({ ...native, ...change }, head)).toThrow();
  });
  const nativeLog = (
    query: string,
    context = '',
    triggers: unknown[] = [],
    pid = 42,
    overrides = {},
  ) =>
    `2026-10-14 12:00:00.000 UTC [${pid}] LOG:  duration: 120.5 ms  plan:\n` +
    JSON.stringify({
      'Query Text': query,
      Parameters: 'PRIVATE_CANARY',
      Settings: { secret: 'PRIVATE_CANARY' },
      JIT: {
        Functions: 8,
        Timing: { Generation: 1, Inlining: 2, Optimization: 3, Emission: 4, Total: 10 },
        Options: 'PRIVATE_CANARY',
      },
      Plan: {
        'Node Type': 'ModifyTable',
        'Relation Name': 'ParticipantContributionEvaluation',
        'Actual Rows': 2000,
        'Actual Loops': 1,
        'Plan Rows': 20,
        'Actual Total Time': 12.5,
        'Temp Read Blocks': 10,
        'Temp Written Blocks': 15,
        'Shared Hit Blocks': 30,
        Filter: 'PRIVATE_CANARY',
        Output: ['PRIVATE_CANARY'],
        Plans: [
          {
            'Node Type': 'Seq Scan',
            'Relation Name': 'PRIVATE_CANARY',
            'Index Name': 'PRIVATE_CANARY',
            'Actual Rows': 2000,
            'Actual Loops': 2,
            'Actual Total Time': 4.5,
          },
        ],
      },
      Triggers: triggers,
      ...overrides,
    }) +
    '\n' +
    (context
      ? `2026-10-14 12:00:00.001 UTC [${pid}] CONTEXT:  PL/pgSQL function ${context}() line 3 at PERFORM\n`
      : '');
  const nativeTrigger = (name: string, time: number | undefined = 90) => ({
    'Trigger Name': name,
    'Constraint Name': 'PRIVATE_CANARY',
    Relation: 'ParticipantContributionEvaluation',
    Time: time,
    Calls: 1,
  });
  it('projects numeric PG16 plans and trusted names without expressions, values, parameters or arbitrary identifiers', () => {
    const raw =
      nativeLog(
        'INSERT INTO "public"."ParticipantContributionEvaluation" VALUES (\'PRIVATE_CANARY\')',
        '',
        [
          nativeTrigger('e4_evaluation_set_guard'),
          nativeTrigger('RI_ConstraintTrigger_c_12345', 1.5),
        ],
      ) + nativeLog('SELECT private_data', '', [], 999);
    const result = compactNativePrepareLog(raw, 42);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY');
    expect(JSON.stringify(result)).not.toContain('private_data');
    expect(result.malformed).toBe(0);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      kind: 'EVAL_INSERT',
      durationMs: 120.5,
      site: 'EVAL_INSERT',
    });
    expect(result.records[0].nodes[0].slice(5, 13)).toEqual([2000, 1, 20, 12.5, 10, 15, 30, null]);
    expect(result.records[0].nodes[1].slice(0, 4)).toEqual([
      0,
      result.dictionary.indexOf('Seq Scan'),
      0,
      0,
    ]);
    expect(result.records[0].triggers[1][0]).toBe(result.dictionary.indexOf('FOREIGN_KEY'));
    expect(result.records[0].jit).toEqual([8, 1, 2, 3, 4, 10]);
    expect(
      nativePlanCategory('INSERT INTO "public"."ActivitySettlementTimeCommandReceipt" VALUES ($1)'),
    ).toBe('RECEIPT');
    expect(
      nativePlanCategory(
        'SET CONSTRAINTS public.astr_parent_complete_guard, public.e4_revision_complete_guard IMMEDIATE;',
      ),
    ).toBe('BARRIER');
    expect(nativePlanCategory("SELECT 'ParticipantContributionEvaluation'")).toBe('OTHER');
  });
  it('retains only the closed bucketId Index Cond fact and never the actual predicate text', () => {
    const query = (condition: string) =>
      nativeLog('SELECT private_source', 'e4_sj_rows', [], 42, {
        Plan: {
          'Node Type': 'Index Scan',
          'Relation Name': 'ParticipantSettlementTimeBucketSource',
          'Index Name': 'pstbs_bucket_allocation_key',
          'Actual Rows': 1,
          'Actual Loops': 2000,
          'Plan Rows': 1,
          'Index Cond': condition,
          Filter: 'PRIVATE_CANARY',
          'Rows Removed by Filter': 0,
        },
      });
    const proof = compactNativePrepareLog(query('(bs0."bucketId" = b.id)'), 42, false, true);
    expect(proof.records[0].nodes[0][proof.nodeColumns.indexOf('bucketIdIndexCond')]).toBe(1);
    expect(proof.records[0].nodes[0][proof.nodeColumns.indexOf('hasFilter')]).toBe(1);
    const rejected = compactNativePrepareLog(
      query('(bs0."bucketId" = \'PRIVATE_CANARY\')'),
      42,
      false,
      true,
    );
    expect(rejected.records[0].nodes[0][rejected.nodeColumns.indexOf('bucketIdIndexCond')]).toBe(0);
    expect(JSON.stringify(proof) + JSON.stringify(rejected)).not.toContain('PRIVATE_CANARY');
    expect(JSON.stringify(proof)).not.toContain('Index Cond');
  });
  it('requires both complete-function/shared plans, original statement events and actual trigger timing', () => {
    const evalSql = 'INSERT INTO "ParticipantContributionEvaluation" VALUES ($1)';
    const receiptSql = 'INSERT INTO "ActivitySettlementTimeCommandReceipt" VALUES ($1)';
    let raw =
      nativeLog(evalSql, '', [
        nativeTrigger('e4_evaluation_set_guard'),
        nativeTrigger('RI_ConstraintTrigger_c_12345', 1),
      ]) + nativeLog(receiptSql, '', [nativeTrigger('astcr_receipt_complete_guard')]);
    for (const context of ['e4_evaluation_set_guard', 'e4_revision_complete_guard']) {
      raw += nativeLog('SELECT e4_assert_complete(root_id,FALSE)', context);
      raw += nativeLog(sharedGuardStatement(), context);
    }
    const plans = compactNativePrepareLog(raw, 42);
    const events = {
      EVAL_INSERT: { calls: 1, durationMs: 1, largestMs: 1 },
      RECEIPT: { calls: 1, durationMs: 1, largestMs: 1 },
      BARRIER: { calls: 1, durationMs: 1, largestMs: 1 },
      BUCKETS: { calls: 0, durationMs: 0, largestMs: 0 },
      SOURCES: { calls: 0, durationMs: 0, largestMs: 0 },
      OTHER: { calls: 0, durationMs: 0, largestMs: 0 },
    };
    expect(nativePrepareCompleteness(plans, events, true, 0)).toEqual({
      status: 'COMPLETE',
      missing: [],
    });
    expect(plans.records.filter((p) => p.kind === 'E4_SHARED').map((p) => p.site)).toEqual([
      'EVAL_INSERT',
      'BARRIER',
    ]);
    for (const [changed, completed, invalid] of [
      [{ ...plans, records: plans.records.slice(1) }, true, 0],
      [{ ...plans, malformed: 1 }, true, 0],
      [plans, false, 0],
      [plans, true, 1],
    ] as const)
      expect(nativePrepareCompleteness(changed, events, completed, invalid).status).toBe(
        'INCOMPLETE',
      );
    // Undefined Time is missing, never a measured zero.
    const missingTime = compactNativePrepareLog(
      nativeLog(evalSql, '', [{ 'Trigger Name': 'e4_evaluation_set_guard', Calls: 1 }]),
      42,
    );
    expect(missingTime.records[0].triggers[0][3]).toBeNull();
    expect(
      nativePrepareCompleteness(
        { ...plans, records: [missingTime.records[0], ...plans.records.slice(1)] },
        events,
        true,
        0,
      ).missing,
    ).toContain('EVAL_INSERT_PLAN_OR_TRIGGER');
  });
  it('fails closed on malformed/truncated/oversized or invalid numeric plan data', () => {
    expect(
      compactNativePrepareLog('2026-10-14 12:00:00 UTC [42] LOG: duration: 1 ms plan:\n{', 42)
        .malformed,
    ).toBe(1);
    expect(() => compactNativePrepareLog('x'.repeat(2097153), 42)).toThrow(/bound/u);
    expect(() =>
      compactNativePrepareLog(
        nativeLog('SELECT 1', '', [], 42, { Plan: { 'Actual Rows': -1 } }),
        42,
      ),
    ).toThrow(/metric/u);
    expect(() => compactNativePrepareLog(nativeLog('SELECT 1').repeat(65), 42)).toThrow(/bound/u);
    expect(nativePlanFailureCategory(new Error('E4 native effective settings refused'))).toBe(
      'SESSION_IDENTITY_OR_SETTINGS',
    );
    expect(nativePlanFailureCategory(new Error('PRIVATE_CANARY'))).toBe('UNCLASSIFIED');
  });
  it('binds the temporary capability receipt to exact head/run/PG16 and strips untrusted extras', () => {
    const proof = {
      head,
      run: '123',
      status: 'COMPLETE',
      server: 16,
      triggerTiming: true,
      foreignKeyTiming: true,
      functionLocalSourcePlan: true,
      nested: true,
      redacted: true,
      cluster: 'b'.repeat(64),
    };
    expect(validateNativeCapability({ ...proof, secret: 'PRIVATE_CANARY' }, head, '123')).toEqual(
      proof,
    );
    for (const change of [
      { head: 'c'.repeat(40) },
      { run: '124' },
      { server: 15 },
      { triggerTiming: false },
      { foreignKeyTiming: false },
      { functionLocalSourcePlan: false },
      { nested: false },
      { redacted: false },
      { cluster: 'unknown' },
      { status: 'FAILED' },
    ])
      expect(() => validateNativeCapability({ ...proof, ...change }, head, '123')).toThrow();
  });
  it('retains the full native artifact as numbered log chunks and never mistakes capability success for prepare success', () => {
    const workflow = readFileSync(
      resolve(__dirname, '../../.github/workflows/activity-os-r5-e4-validation.yml'),
      'utf8',
    );
    const script = workflow.match(
      /- name: Summarize closed shared-guard evidence[\s\S]*?node <<'NODE'\n([\s\S]*?)\n\s+NODE/u,
    )?.[1];
    expect(script).toBeDefined();
    const receipt = {
      head,
      run: '123',
      purpose: 'DIAGNOSTIC_ONLY',
      coverage: 'PREPARE_NATIVE_PLAN_ONLY',
      scenario: 'ordinary-500',
      status: 'COMPLETE',
      nativePreparePlan: { status: 'COMPLETE', plans: { nodes: Array<number>(5000).fill(12345) } },
    };
    const execute = (value: unknown, hasResult: boolean) => {
      let output = '';
      const stopped = new Error('TEST_PROCESS_EXIT');
      try {
        runInNewContext(script!, {
          require: () => ({
            existsSync: (file: string) => !file.endsWith('/result.json') || hasResult,
            statSync: () => ({ size: Buffer.byteLength(JSON.stringify(value)) }),
            readFileSync: () => JSON.stringify(value),
          }),
          process: {
            env: {
              SRVF_E4_NATIVE_PREPARE_PLAN: '1',
              GITHUB_SHA: head,
              GITHUB_RUN_ID: '123',
              SRVF_E4_DIAGNOSTIC_SCENARIO: 'ordinary-500',
            },
            stdout: {
              write: (text: string) => {
                output += text;
              },
            },
            exit: () => {
              throw stopped;
            },
          },
        });
      } catch (error) {
        if (error !== stopped) throw error;
      }
      const chunks = output
        .split('\n')
        .filter((line) => line.startsWith('E4_NATIVE_PLAN_CHUNK '))
        .map(
          (line) =>
            JSON.parse(line.slice('E4_NATIVE_PLAN_CHUNK '.length)) as {
              artifact: string;
              index: number;
              total: number;
              data: string;
            },
        )
        .filter((chunk) => chunk.artifact === 'result.json');
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
      expect(chunks.every((c) => c.total === chunks.length && c.data.length <= 12000)).toBe(true);
      return JSON.parse(chunks.map((c) => c.data).join('')) as {
        status: string;
        nativePreparePlan: { status: string };
      };
    };
    expect(execute(receipt, true)).toEqual(receipt);
    expect(
      execute({ head, run: '123', status: 'COMPLETE', temporaryOnly: true }, false),
    ).toMatchObject({ status: 'INCOMPLETE', nativePreparePlan: { status: 'NOT_CAPTURED' } });
    expect(() => execute({ ...receipt, head: 'c'.repeat(40) }, true)).toThrow();
  });
  it('requires complete source bag cases, native negatives, error priorities and unchanged settings', () => {
    let raw = calibrationNotice().replaceAll(
      '"planCacheMode":"force_custom_plan"',
      '"planCacheMode":"auto"',
    );
    raw = raw.replace(
      /(NOTICE: E4_JOIN_KEY_SAMPLE )(\{[^\n]+\})/gu,
      (_whole, prefix: string, value: string) =>
        prefix +
        JSON.stringify({
          ...(JSON.parse(value) as object),
          statisticsUnchanged: true,
          statisticsDigest: 'd'.repeat(32),
        }),
    );
    const cases = [
      ['PUBLIC', 5],
      ['REVERSED_INPUT', 5],
      ['DUPLICATE_EDGE', 6],
      ['NULL_LINK', 4],
      ['MISSING_EDGE', 4],
      ['NULL_MEMBER', 5],
    ] as const;
    const eq = cases
      .map(
        ([name, rows], i) =>
          'NOTICE: E4_SOURCE_JOIN_EQ ' +
          JSON.stringify({
            case: name,
            rows,
            bagEqual: true,
            hashEqual: true,
            mutation: i >= 2,
            rolledBack: i >= 2,
          }) +
          '\n',
      )
      .join('');
    raw += eq;
    const proof = compactSourceJoinEvidence(raw, true);
    const verbose = raw.replaceAll('NOTICE: E4_', 'NOTICE:  00000: E4_');
    expect(compactSourceJoinEvidence(verbose, true)).toEqual(proof);
    expect(joinKeyDiagnosticNotices(verbose + '\nERROR: 23514: native failure')).toContain(
      'ERROR: 23514: native failure',
    );
    expect(() =>
      compactSourceJoinEvidence(
        verbose.replace('00000: E4_SOURCE_JOIN_EQ', '23514: E4_SOURCE_JOIN_EQ'),
        true,
      ),
    ).toThrow();
    expect(proof.equivalence).toHaveLength(6);
    expect(proof.negatives).toHaveLength(6);
    expect(proof.priorities).toHaveLength(6);
    expect(proof.settings).toEqual({
      workMemKb: 4096,
      jitEnabled: true,
      planCacheMode: 'auto',
      statisticsUnchanged: true,
      statisticsDigest: 'd'.repeat(32),
    });
    expect(() => compactSourceJoinEvidence(raw.replace(eq, ''), true)).toThrow();
    expect(() =>
      compactSourceJoinEvidence(
        raw.replace('"case":"DUPLICATE_EDGE","rows":6', '"case":"DUPLICATE_EDGE","rows":5'),
        true,
      ),
    ).toThrow();
    expect(() =>
      compactSourceJoinEvidence(
        raw.replace('"statisticsUnchanged":true', '"statisticsUnchanged":false'),
        true,
      ),
    ).toThrow();
    expect(() =>
      compactSourceJoinEvidence(
        raw.replaceAll('"planCacheMode":"auto"', '"planCacheMode":"force_custom_plan"'),
        true,
      ),
    ).toThrow();
  });
  const statisticsNotice = (initial: 'NONE' | 'PARTIAL' | 'PRESENT' = 'NONE') => {
    const values = Object.fromEntries(
      SOURCE_STATISTICS_SETTINGS.map((name) => [
        name,
        name === 'work_mem'
          ? '4096'
          : name === 'jit'
            ? 'on'
            : name === 'plan_cache_mode'
              ? 'auto'
              : name.startsWith('enable_')
                ? 'on'
                : '100',
      ]),
    );
    const digest = createHash('md5')
      .update(
        [...SOURCE_STATISTICS_SETTINGS]
          .sort()
          .map((name) => name + '=' + values[name])
          .join(','),
      )
      .digest('hex');
    const notice = (tag: string, value: unknown) =>
      'NOTICE: ' + tag + ' ' + JSON.stringify(value) + '\n';
    let raw = calibrationNotice()
      .replace(/^NOTICE: E4_JOIN_KEY_SAMPLE \{[^\n]+\}\n/gmu, '')
      .replace('"publicEvaluationCount":4', '"publicEvaluationCount":2000');
    raw += notice('E4_SOURCE_JOIN_EQ', {
      case: 'PUBLIC',
      rows: 2500,
      bagEqual: true,
      hashEqual: true,
      mutation: false,
      rolledBack: false,
    });
    for (const [index, [phase, variant]] of SOURCE_STATISTICS_ORDER.entries())
      raw += notice('E4_JOIN_KEY_SAMPLE', {
        index,
        phase,
        variant,
        wallMs: 100,
        returned: true,
        completeDocumentAndRootGuard: true,
        sameBackend: true,
        readonly: true,
        workMemKb: 4096,
        jitEnabled: true,
        planCacheMode: 'auto',
        statisticsDigest: (phase === 'PRE_ANALYZE' ? 'c' : 'a').repeat(32),
        statisticsUnchanged: true,
        settingsDigest: digest,
      });
    const counts = [2000, 2000, 500, 2500, 500];
    for (const stage of ['PRE_ANALYZE', 'ANALYZED'])
      raw += notice('E4_SOURCE_JOIN_STATS', {
        stage,
        database: 'app_test_w98',
        statisticsDigest: (stage === 'PRE_ANALYZE' ? 'c' : 'a').repeat(32),
        dataUnchanged: true,
        settingsDigest: digest,
        statistics: SOURCE_JOIN_INPUTS.map(([table], i) => {
          const present =
            stage === 'ANALYZED' || initial === 'PRESENT' || (initial === 'PARTIAL' && i >= 2);
          return {
            table,
            tuples: present ? counts[i] : -1,
            pages: present ? 1 : 0,
            statsColumns: present ? 1 : 0,
            rows: counts[i],
            analyzed: stage === 'ANALYZED',
            autoanalyzed: stage === 'PRE_ANALYZE' && present,
            private: 'PRIVATE_CANARY',
          };
        }),
      });
    raw +=
      notice('E4_SOURCE_JOIN_SETTINGS', values) +
      notice('E4_SOURCE_JOIN_STATS_COMPLETE', {
        dataUnchanged: true,
        settingsUnchanged: true,
        database: 'app_test_w98',
        analyzedTables: 5,
      });
    return raw;
  };
  it('requires all ten C bag/hash cases, original negatives/priority and stable unmodified statistics without ANALYZE', () => {
    const counts = [4, 4, 1, 5, 1];
    let settingsDigest = '';
    let raw =
      statisticsNotice('PARTIAL')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          if (
            line.startsWith('NOTICE: E4_JOIN_KEY_SAMPLE ') ||
            line.startsWith('NOTICE: E4_SOURCE_JOIN_EQ ')
          )
            return '';
          if (line.startsWith('NOTICE: E4_SOURCE_JOIN_STATS ')) {
            const r = JSON.parse(line.slice('NOTICE: E4_SOURCE_JOIN_STATS '.length)) as {
              stage: string;
              settingsDigest: string;
              statistics: { rows: number; tuples: number }[];
            };
            if (r.stage !== 'PRE_ANALYZE') return '';
            settingsDigest = r.settingsDigest;
            r.statistics.forEach((s, i) => {
              s.rows = counts[i];
              if (s.tuples >= 0) s.tuples = counts[i];
            });
            return 'NOTICE: E4_SOURCE_JOIN_STATS ' + JSON.stringify(r);
          }
          return line
            .replace('"publicEvaluationCount":2000', '"publicEvaluationCount":4')
            .replace('"analyzedTables":5', '"analyzedTables":0');
        })
        .filter(Boolean)
        .join('\n') + '\n';
    for (const [index, [phase, variant]] of JOIN_KEY_CALIBRATION_ORDER.entries())
      raw +=
        'NOTICE: E4_JOIN_KEY_SAMPLE ' +
        JSON.stringify({
          index,
          phase,
          variant,
          wallMs: 1,
          returned: true,
          completeDocumentAndRootGuard: true,
          sameBackend: true,
          readonly: true,
          workMemKb: 4096,
          jitEnabled: true,
          planCacheMode: 'auto',
          statisticsUnchanged: true,
          statisticsDigest: 'c'.repeat(32),
          settingsDigest,
        }) +
        '\n';
    for (const [i, name] of [
      'PUBLIC',
      'REVERSED_INPUT',
      'DUPLICATE_EDGE',
      'NULL_LINK',
      'MISSING_EDGE',
      'NULL_MEMBER',
      'WRONG_ACTIVITY',
      'WRONG_TIME_REVISION',
      'NULL_ACTIVITY',
      'NULL_TIME_REVISION',
    ].entries())
      raw +=
        'NOTICE: E4_SOURCE_JOIN_EQ ' +
        JSON.stringify({
          case: name,
          rows: i === 2 ? 6 : i < 2 || i === 5 ? 5 : 4,
          bagEqual: true,
          hashEqual: true,
          mutation: i >= 2,
          rolledBack: i >= 2,
        }) +
        '\n';
    const proof = compactSourceJoinEvidence(raw, true, false, 'C');
    expect(proof.equivalence).toHaveLength(10);
    expect(proof.negatives).toHaveLength(6);
    expect(proof.priorities).toHaveLength(6);
    expect(proof.statisticsExperiment).toMatchObject({
      intervention: 'NO_MANUAL_ANALYZE',
      initialStatistics: 'PARTIAL',
      businessDataUnchanged: true,
    });
    const partial = raw.replace(/^NOTICE: E4_SOURCE_JOIN_STATS_COMPLETE .*\n/gmu, '');
    expect(compactSourceStatisticsEvidence(partial, false, false)).toMatchObject({
      status: 'INITIAL_SNAPSHOT_ONLY',
      businessDataUnchanged: null,
    });
    expect(() =>
      compactSourceJoinEvidence(
        raw.replace(/NOTICE: E4_SOURCE_JOIN_EQ \{"case":"WRONG_ACTIVITY"[^\n]+\n/u, ''),
        true,
        false,
        'C',
      ),
    ).toThrow();
    expect(() =>
      compactSourceJoinEvidence(
        raw.replace(
          '"statisticsDigest":"' + 'c'.repeat(32),
          '"statisticsDigest":"' + 'b'.repeat(32),
        ),
        true,
        false,
        'C',
      ),
    ).toThrow();
  });
  it.each(['NONE', 'PARTIAL', 'PRESENT'] as const)(
    'records %s initial statistics without requiring cold relations',
    (initial) => {
      const evidence = compactSourceJoinEvidence(statisticsNotice(initial), false, true);
      expect(evidence.statisticsExperiment).toMatchObject({
        initialStatistics: initial,
        statisticsChanged: true,
        conditionalOnly: true,
        snapshots: [{ stage: 'PRE_ANALYZE' }, { stage: 'ANALYZED' }],
      });
      expect(evidence.timings[0].phase).toBe('PRE_ANALYZE');
      const before = evidence.statisticsExperiment!.snapshots[0].statistics;
      expect(before.filter((s) => s.statsColumns > 0)).toHaveLength(
        initial === 'NONE' ? 0 : initial === 'PARTIAL' ? 3 : 5,
      );
    },
  );
  it('labels unchanged statistics after explicit ANALYZE without inventing a missing-statistics effect', () => {
    const raw = statisticsNotice('PRESENT').replaceAll('c'.repeat(32), 'a'.repeat(32));
    expect(compactSourceJoinEvidence(raw, false, true).statisticsExperiment).toMatchObject({
      initialStatistics: 'PRESENT',
      statisticsChanged: false,
      conditionalOnly: true,
    });
  });
  it('rejects statistics drift within each observed phase, including a partially analyzed initial state', () => {
    const raw = statisticsNotice('PARTIAL');
    for (const digest of ['c', 'a'])
      expect(() =>
        compactSourceJoinEvidence(
          raw.replace(
            '"statisticsDigest":"' + digest.repeat(32),
            '"statisticsDigest":"' + 'b'.repeat(32),
          ),
          false,
          true,
        ),
      ).toThrow('E4 source join sample/settings refused');
    expect(sourceJoinSessionSql('a'.repeat(24), false, true)).toContain(
      'E4 source join statistics changed during sample',
    );
  });
  it('requires five visible analyzed relations, unchanged data/settings and condition labels, including verbose notices', () => {
    const raw = statisticsNotice(),
      proof = compactSourceJoinEvidence(raw, false, true);
    expect(proof.timings.map((s) => [s.phase, s.variant])).toEqual(SOURCE_STATISTICS_ORDER);
    expect(proof.statisticsExperiment).toMatchObject({
      status: 'COMPLETE',
      conditionalOnly: true,
      coldGuarantee: 'NOT_ESTABLISHED_BY_ANALYZED_RESULTS',
    });
    expect(JSON.stringify(proof)).not.toContain('PRIVATE_CANARY');
    expect(
      compactSourceJoinEvidence(raw.replaceAll('NOTICE: E4_', 'NOTICE:  00000: E4_'), false, true),
    ).toEqual(proof);
    for (const changed of [
      raw.replace('"dataUnchanged":true', '"dataUnchanged":false'),
      raw.replaceAll('"database":"app_test_w98"', '"database":"postgres"'),
      raw.replace(
        '"statisticsDigest":"' + 'a'.repeat(32) + '"',
        '"statisticsDigest":"' + 'b'.repeat(32) + '"',
      ),
      raw.replace('"settingsUnchanged":true', '"settingsUnchanged":false'),
    ])
      expect(() => compactSourceJoinEvidence(changed, false, true)).toThrow();
    expect(() =>
      compactSourceStatisticsEvidence(
        raw.replace(
          '"tuples":2000,"pages":1,"statsColumns":1',
          '"tuples":-1,"pages":0,"statsColumns":0',
        ),
      ),
    ).toThrow();
    expect(() => compactSourceJoinEvidence(raw, true, true)).toThrow();
  });
  it('retains five pre/analyzed plans with per-scan filtering instead of treating fewer calls as less total work', () => {
    let raw = '';
    for (const [index, [phase, variant]] of SOURCE_STATISTICS_ORDER.entries()) {
      if (phase === 'SHADOW_CONTROL') continue;
      const fn = variant === 'BASELINE' ? 'e4_sj_original' : 'e4_sj_rows';
      raw += `2026-10-14 12:00:00 UTC [42] LOG: E4_SOURCE_JOIN_PLAN_BEGIN ${index}\n`;
      raw += nativeLog('SELECT source query', fn, [], 42, {
        Plan: {
          'Node Type': 'Nested Loop',
          'Actual Rows': 2500,
          'Actual Loops': 1,
          'Plan Rows': 1,
          Plans: [
            {
              'Node Type': 'Index Scan',
              'Relation Name': 'ParticipantSettlementTimeBucketSource',
              'Actual Rows': 1,
              'Actual Loops': 2000,
              'Plan Rows': 1,
              'Rows Removed by Filter': 1999,
            },
          ],
        },
      });
      raw += nativeLog(
        sharedGuardStatement().replace(
          'SELECT * FROM e4_source_rows(root.id)',
          `SELECT * FROM pg_temp.${fn}(root.id)`,
        ),
        'e4_join_candidate',
      );
      raw += nativeLog(
        variant === 'BASELINE'
          ? 'SELECT pg_temp.e4_sj_complete_baseline(root_id,FALSE)'
          : 'SELECT pg_temp.e4_join_candidate(root_id,FALSE)',
      );
      raw += `2026-10-14 12:00:00 UTC [42] LOG: E4_SOURCE_JOIN_PLAN_END ${index}\n`;
    }
    const plans = compactSourceJoinPlans(raw, 42, false, true, true);
    expect(plans).toHaveLength(5);
    expect(plans.map((p) => p.statisticsStage)).toEqual([
      'PRE_ANALYZE',
      'ANALYZED',
      'ANALYZED',
      'ANALYZED',
      'ANALYZED',
    ]);
    expect(plans[2].probes[0]).toMatchObject({ loops: 2000, rowsFilteredPerLoop: 1999 });
  });
  it('binds source plans to ordered same-PID markers and preserves actual probe counts for each variant', () => {
    let raw = '';
    for (const [index, variant] of ['BASELINE', 'CANDIDATE'].entries()) {
      raw += `2026-10-14 12:00:00 UTC [42] LOG: E4_SOURCE_JOIN_PLAN_BEGIN ${index}\n`;
      raw += nativeLog(
        'SELECT source query',
        variant === 'BASELINE' ? 'e4_sj_original' : 'e4_sj_rows',
        [],
        42,
        {
          Plan: {
            'Node Type': 'Nested Loop',
            'Actual Rows': 5,
            'Actual Loops': 1,
            'Plan Rows': 1,
            Plans: [
              {
                'Node Type': 'Index Scan',
                'Relation Name': 'ParticipantSettlementTimeBucketSource',
                'Index Name': 'pstbs_bucket_allocation_key',
                'Actual Rows': 1,
                'Actual Loops': variant === 'BASELINE' ? 100 : 2,
                'Plan Rows': 1,
              },
            ],
          },
        },
      );
      raw += nativeLog(
        variant === 'BASELINE'
          ? sharedGuardStatement().replace(
              'SELECT * FROM e4_source_rows(root.id)',
              'SELECT * FROM pg_temp.e4_sj_original(root.id)',
            )
          : sharedGuardStatement().replace(
              'SELECT * FROM e4_source_rows(root.id)',
              'SELECT * FROM pg_temp.e4_sj_rows(root.id)',
            ),
        'e4_join_candidate',
      );
      raw += nativeLog(
        variant === 'BASELINE'
          ? 'SELECT pg_temp.e4_sj_complete_baseline(root_id,FALSE)'
          : 'SELECT pg_temp.e4_join_candidate(root_id,FALSE)',
      );
      raw += `2026-10-14 12:00:00 UTC [42] LOG: E4_SOURCE_JOIN_PLAN_END ${index}\n`;
    }
    const result = compactSourceJoinPlans(raw, 42, true);
    expect(result.map((r) => [r.variant, r.sourceProbeLoops, r.sourceRows])).toEqual([
      ['BASELINE', 100, 5],
      ['CANDIDATE', 2, 5],
    ]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY');
    expect(() => compactSourceJoinPlans(raw, 43, true)).toThrow();
    const partial = raw.slice(
      0,
      raw.indexOf('2026-10-14 12:00:00 UTC [42] LOG: E4_SOURCE_JOIN_PLAN_BEGIN 1'),
    );
    expect(compactSourceJoinPlans(partial, 42, true, false)).toHaveLength(1);
    expect(() => compactSourceJoinPlans(partial, 42, true)).toThrow();
  });
  it('admits the fixed maximum only with original maximum/oracle flags and no competing mode', () => {
    const maximum = {
      ...env,
      SRVF_E4_FIXED_METADATA_MAX_ONCE: '1',
      SRVF_E4_JOIN_KEY_ONCE: '1',
      SRVF_E4_CANONICAL_FIRST32: '1',
    };
    expect(() => requireDiagnosticEnvironment(maximum, head)).not.toThrow();
    for (const change of [
      { SRVF_E4_FIXED_METADATA_MAX_ONCE: '2' },
      { SRVF_E4_DIAGNOSTIC_SCENARIO: 'ordinary-1' },
      { SRVF_E4_JOIN_KEY_ONCE: '' },
      { SRVF_E4_CANONICAL_FIRST32: '' },
      { SRVF_E4_JOIN_KEY_CALIBRATION: '1' },
      { SRVF_E4_SHARED_GUARD_ONCE: '1' },
      { SRVF_E4_CANONICAL_COST_ONLY: '1' },
      { SRVF_E4_CANONICAL_JIT_ABBA: '1' },
      { SRVF_E4_CANONICAL_MEMORY_PAIR: '1' },
    ])
      expect(() => requireDiagnosticEnvironment({ ...maximum, ...change }, head)).toThrow();
  });
  it('covers the actual metadata input types and preserves canonical non-NULL references without changing the fixed20cb SQL', () => {
    const sql = metadataCanonicalCandidateSource();
    expect(createHash('sha256').update(sql).digest('hex')).toBe(
      E4_FIXED_METADATA_CANDIDATE.sqlSha256,
    );
    expect(E4_FIXED_METADATA_CANDIDATE.sourceHead).toBe('20cbaf6d22429db19a1378d2c4bbf39889162f60');
    const migration = readFileSync(
      resolve(
        __dirname,
        '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',
      ),
      'utf8',
    );
    for (const field of E4_METADATA_FIELDS.filter(
      (value) =>
        !['calculatedPoints', 'recognizedPoints', 'mode', 'beijingDayPointsJson'].includes(value),
    )) {
      expect(migration).toContain(
        `"${field}" ${['durationSeconds', 'evaluatorVersion'].includes(field) ? 'INTEGER' : 'TEXT'} NOT NULL`,
      );
      expect(metadataCanonicalExpression()).toContain(`(metadata->'${field}')::TEXT`);
    }
    expect(sql).toContain(
      "'calculatedPoints',result->>'recognizedPoints','recognizedPoints',result->>'recognizedPoints'",
    );
    expect(sql).toContain("'mode','policy'");
    expect(sql).toContain(
      "'[' || string_agg(coalesce(source_canonical,'null'),',' ORDER BY source_canonical COLLATE \"C\") || ']' AS refs_canonical",
    );
    expect(metadataCanonicalExpression()).toContain(
      "THEN astr_canonical_json(metadata->'beijingDayPointsJson')",
    );
  });
  const maximumMetadataNotice = () => {
    const samples = FIXED_METADATA_MAX_ORDER.map(
      ([phase, variant], index) =>
        'NOTICE: E4_JOIN_KEY_SAMPLE ' +
        JSON.stringify({
          index,
          phase,
          variant,
          wallMs: 12000,
          returned: true,
          completeDocumentAndRootGuard: true,
          sameBackend: true,
          readonly: true,
          workMemKb: 4096,
          jitEnabled: true,
          planCacheMode: 'force_custom_plan',
        }) +
        '\n',
    ).join('');
    return calibrationNotice()
      .replace(/NOTICE: E4_JOIN_KEY_SAMPLE \{[^\n]+\}\n/gu, '')
      .replace('NOTICE: E4_JOIN_KEY_NEGATIVE ', samples + 'NOTICE: E4_JOIN_KEY_NEGATIVE ')
      .replace('"publicEvaluationCount":4', '"publicEvaluationCount":8000');
  };
  it('runs fixed metadata ABBA and both shadow controls before all negatives/priorities inside unchanged limits', () => {
    const sql = joinKeyProbeSql('synthetic_root', 'app_test_w98', 8000, true);
    expect(sql.match(/E4_JOIN_KEY_SAMPLE /gu)).toHaveLength(6);
    expect(sql).not.toContain("'ACTUAL_PLAN'");
    expect(sql).toContain(metadataCanonicalExpression());
    expect(sql).toContain('SELECT * FROM pg_temp.e4_probe_sources');
    expect(sql).toContain('count(*) FROM pg_temp.e4_probe_evaluations)<>8000');
    expect(sql).toContain('E4_JOIN_KEY_METADATA_PRIORITY_BEGIN ROOT CANDIDATE');
    expect(sql.indexOf('E4_JOIN_KEY_SAMPLE ')).toBeLessThan(
      sql.indexOf('E4_JOIN_KEY_NEGATIVE_BEGIN '),
    );
    expect(() => joinKeyProbeSql('synthetic_root', 'app_test_w98', 4, true)).toThrow();
    const result = compactFixedMetadataMaximumEvidence(maximumMetadataNotice());
    expect(result.timings).toHaveLength(6);
    expect(result.cases).toHaveLength(6);
    expect(result.priorityCases).toHaveLength(6);
    expect(result.metadataCanonical?.cases).toBe(37);
    expect(result.processMs).toBe(240000);
    expect(result.statementMs).toBe(30000);
    for (const raw of [
      maximumMetadataNotice().replace('"wallMs":12000', '"wallMs":30001'),
      maximumMetadataNotice().replace('"sameBackend":true', '"sameBackend":false'),
      maximumMetadataNotice().replace('"publicEvaluationCount":8000', '"publicEvaluationCount":4'),
      maximumMetadataNotice().replace(
        '"constraint":"e4_source_guard"',
        '"constraint":"e4_complete_guard"',
      ),
      maximumMetadataNotice().replace(E4_METADATA_CASE_DIGEST, '0'.repeat(64)),
    ])
      expect(() => compactFixedMetadataMaximumEvidence(raw)).toThrow();
    const prefix = maximumMetadataNotice().split('NOTICE: E4_JOIN_KEY_NEGATIVE ')[0];
    expect(compactFixedMetadataMaximumEvidence(prefix, false).status).toBe('PARTIAL');
    expect(() => compactFixedMetadataMaximumEvidence(prefix)).toThrow();
  });
  it.each([false, true])(
    'preserves the pre-oracle and records one separate post-oracle, failed=%s, without retry',
    async (failed) => {
      const first = {
        purpose: 'ISOLATED_FIRST_CANONICAL_NOT_PRODUCTION' as const,
        attempts: 1 as const,
        transactionMs: 30000 as const,
        workMemKb: 32768 as const,
        jit: 'DEFAULT_UNCHANGED' as const,
        wallMs: 29000,
        outcome: 'RETURNED' as const,
        fullComparisonValidated: true,
      };
      const report: Parameters<typeof completeFixedMetadataPostOracle>[0] = {
        oracle: 'COMPLETE',
        firstCanonical32: first,
      };
      const post = { ...first, wallMs: 28000 };
      const failure = new Error('controlled post oracle failure');
      const verify = jest.fn(async () => {
        expect(report.oracle).toBe('NOT_RUN');
        report.firstCanonical32 = post;
        if (failed) throw failure;
      });
      const result = completeFixedMetadataPostOracle(report, verify);
      if (failed) await expect(result).rejects.toBe(failure);
      else await expect(result).resolves.toBeUndefined();
      expect(verify).toHaveBeenCalledTimes(1);
      expect(report.firstCanonical32).toBe(first);
      expect(report.metadataPostOracle).toEqual({
        status: failed ? 'FAILED' : 'COMPLETE',
        firstCanonical32: post,
      });
      expect(report.oracle).toBe(failed ? 'NOT_RUN' : 'COMPLETE');
      const driver = readFileSync(
        resolve(__dirname, '../diagnostics/e4-prepare-cost.diagnostic-spec.ts'),
        'utf8',
      );
      expect(driver).toContain("process.env.SRVF_E4_FIXED_METADATA_MAX_ONCE !== '1' &&");
    },
  );
  it('observes cleanup with a positive instrument and the exact existing lease key through read-only SQL', () => {
    const sql = calibrationCleanupSql();
    expect(sql).toContain('BEGIN READ ONLY');
    expect(sql).toContain('pid=pg_backend_pid() AND datname=current_database()');
    expect(sql).toContain("datname='app_test_w98'");
    expect(sql).toContain('SRVF:test:D3:app_test_w98');
    expect(sql).not.toMatch(/DROP|CREATE|pg_terminate_backend|pg_cancel_backend/u);
  });
  const guardNode = (cte: string, rows: number) => ({
    'Node Type': 'CTE Scan',
    'CTE Name': cte,
    'Plan Rows': 1000,
    'Plan Width': 256,
    'Actual Rows': rows,
    'Actual Loops': 1,
    'Actual Startup Time': 1,
    'Actual Total Time': 2,
    'Temp Read Blocks': 7,
    'Temp Written Blocks': 11,
    Filter: 'private fixture identifier and SQL expression',
  });
  const guardDocument = () => ({
    'Query Text': sharedGuardStatement(),
    Plan: {
      ...guardNode('pairs', 8000),
      Plans: [guardNode('assertion_sources', 50000), guardNode('groups', 8000)],
    },
  });
  const notice = (document: unknown) =>
    `NOTICE:  duration: 1234.5 ms  plan:\n${JSON.stringify(document, null, 2)}\n`;
  const comparisonNotice = () => {
    let raw = '';
    for (const [index, [phase, variant]] of JOIN_KEY_ORDER.entries()) {
      raw += `NOTICE: E4_JOIN_KEY_BEGIN ${index}\n`;
      if (phase === 'ACTUAL_PLAN')
        raw += notice({ ...guardDocument(), 'Query Text': sharedGuardStatement(variant) });
      raw +=
        'NOTICE: E4_JOIN_KEY_SAMPLE ' +
        JSON.stringify({
          index,
          phase,
          variant,
          wallMs: 1200,
          returned: true,
          completeDocumentAndRootGuard: true,
          sameBackend: true,
          readonly: true,
          workMemKb: 4096,
          jitEnabled: true,
          planCacheMode: 'force_custom_plan',
        }) +
        '\n';
    }
    for (const kind of ['MISSING', 'EXTRA', 'TAMPERED'])
      for (const variant of ['BASELINE', 'CANDIDATE'])
        raw +=
          'NOTICE: E4_JOIN_KEY_NEGATIVE ' +
          JSON.stringify({
            kind,
            variant,
            sqlstate: '23514',
            constraint: 'e4_evaluation_guard',
            affected: 1,
            rolledBack: true,
            allShadowRowsRestored: true,
            markerRestored: true,
          }) +
          '\n';
    raw +=
      'NOTICE: E4_JOIN_KEY_COMPLETE ' +
      JSON.stringify({
        catalogUnchanged: true,
        guardsUnchanged: true,
        sameBackend: true,
        publicEvaluationCount: 8000,
      }) +
      '\n';
    return raw;
  };
  it('constructs exactly the three key-carry edits with an unchanged complete evaluation expression', () => {
    const path = resolve(
      __dirname,
      '../../prisma/migrations/20261013000000_activity_contribution_assert_source_reuse/migration.sql',
    );
    const original = readFileSync(path, 'utf8'),
      candidate = joinKeyCandidateSource();
    const restored = candidate
      .replace(
        'expected_documents(unit_canonical,evaluation_key,evaluation)',
        'expected_documents(unit_canonical,evaluation)',
      )
      .replace("SELECT unit,metadata->>'evaluationUnitKey',metadata ||", 'SELECT unit,metadata ||')
      .replace(
        'SELECT evaluation_key AS key,evaluation',
        "SELECT evaluation->>'evaluationUnitKey' AS key,evaluation",
      );
    expect(restored).toBe(original);
    expect(candidate).toContain('expected x FULL JOIN actual a USING (key)');
    expect(candidate).toContain('x.evaluation IS DISTINCT FROM');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });
  it('uses only temporary candidate/shadow objects, real SQL mutations and exception rollback with original production catalog checks', () => {
    const sql = joinKeyProbeSql('synthetic_root', 'app_test_w98');
    expect(sql.match(/CREATE FUNCTION pg_temp\./gu)).toHaveLength(3);
    expect(sql).not.toMatch(
      /CREATE OR REPLACE FUNCTION|DISABLE TRIGGER|session_replication_role|(?:UPDATE|INSERT INTO|DELETE FROM) public\./u,
    );
    expect(sql.match(/PERFORM public\.e4_assert_complete\(root_id,FALSE\)/gu)).toHaveLength(3);
    expect(sql.match(/PERFORM pg_temp\.e4_join_candidate\(root_id,FALSE\)/gu)).toHaveLength(3);
    expect(sql).toContain('GET STACKED DIAGNOSTICS');
    expect(sql).toContain("state<>'23514' OR guard<>'e4_evaluation_guard'");
    expect(sql).toContain('DELETE FROM pg_temp.e4_probe_evaluations');
    expect(sql).toContain('INSERT INTO pg_temp.e4_probe_evaluations');
    expect(sql).toContain('UPDATE pg_temp.e4_probe_evaluations');
    expect(sql).toContain('before_hash');
    expect(sql).toContain('e4_probe_marks');
    expect(sql).toContain('E4 join key public catalog changed');
    expect(sql).toContain(
      'e4_evaluation_document(ROW(e.*)::public."ParticipantContributionEvaluation")',
    );
    expect(sql).not.toContain('e4_evaluation_document(jsonb_populate_record');
    expect(sql).toContain(
      '(SELECT * FROM pg_temp.e4_probe_evaluations ORDER BY id COLLATE "C" LIMIT 1) e',
    );
    expect(sql).toContain('CROSS JOIN LATERAL jsonb_populate_record');
    expect(() => joinKeyProbeSql('root', 'app_test')).toThrow();
  });
  it('requires fixed ABBA, both actual plans, two valid shadow controls and all six native-error rollback cases', () => {
    const result = compactJoinKeyEvidence(comparisonNotice());
    expect(result.timings).toHaveLength(8);
    expect(result.plans.map((p) => p.variant)).toEqual(['BASELINE', 'CANDIDATE']);
    expect(result.cases).toHaveLength(6);
    expect(result.cases.every((c) => c.rolledBack)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Query Text|Filter|root\.id|private/u);
  });
  it('reuses the notice repair for maximum ABBA, both actual plans and six strict native rollback receipts', () => {
    const verbose = comparisonNotice().replaceAll(
      'NOTICE: E4_JOIN_KEY_',
      'NOTICE:  00000: E4_JOIN_KEY_',
    );
    const result = compactJoinKeyEvidence(joinKeyDiagnosticNotices(verbose));
    expect(result.status).toBe('COMPLETE');
    expect(result.timings).toHaveLength(8);
    expect(result.plans).toHaveLength(2);
    expect(result.cases).toHaveLength(6);
  });
  it('retains validated positive plans and completed negative prefix while refusing incomplete acceptance', () => {
    const raw = comparisonNotice().split('NOTICE: E4_JOIN_KEY_NEGATIVE ')[0];
    expect(compactJoinKeyPositiveEvidence(raw).status).toBe('PARTIAL');
    expect(() => compactJoinKeyEvidence(raw)).toThrow();
    const failure = compactJoinKeyFailure(
      raw +
        'NOTICE: E4_JOIN_KEY_NEGATIVE_STEP EXTRA BASELINE GUARD\n' +
        'NOTICE: E4_JOIN_KEY_UNEXPECTED {"kind":"EXTRA","variant":"BASELINE","state":"57014","constraintMatches":false,"messageMatches":false,"message":"private SQL"}\n' +
        'ERROR: E4 join key negative outcome refused\n',
    );
    expect(failure.classification).toBe('STATEMENT_TIMEOUT');
    expect(failure.lastNegativeStep).toEqual({ kind: 'EXTRA', variant: 'BASELINE', step: 'GUARD' });
    expect(failure.partialEvidence?.plans).toHaveLength(2);
    expect(failure.partialEvidence?.cases).toHaveLength(0);
    expect(failure.partialEvidence?.status).toBe('PARTIAL');
    expect(JSON.stringify(failure)).not.toMatch(/private SQL|Query Text|catalogUnchanged/u);
    const prefix =
      comparisonNotice().split('NOTICE: E4_JOIN_KEY_NEGATIVE ')[0] +
      comparisonNotice()
        .split('NOTICE: E4_JOIN_KEY_NEGATIVE ')
        .slice(1, 3)
        .map((v) => 'NOTICE: E4_JOIN_KEY_NEGATIVE ' + v)
        .join('');
    expect(compactJoinKeyFailure(prefix).partialEvidence?.cases).toHaveLength(2);
    expect(() => compactJoinKeyEvidence(prefix)).toThrow();
  });
  it('does not retain incomplete or unsafe positive evidence after a failed process', () => {
    for (const raw of [
      comparisonNotice().replace('"sameBackend":true', '"sameBackend":false'),
      comparisonNotice().replace('"workMemKb":4096', '"workMemKb":32768'),
      comparisonNotice().split('NOTICE: E4_JOIN_KEY_BEGIN 5')[0],
    ])
      expect(compactJoinKeyFailure(raw).partialEvidence).toBeNull();
    expect(
      compactJoinKeyFailure('ERROR: column reference "id" is ambiguous\n').classification,
    ).toBe('AMBIGUOUS_ID');
    expect(
      compactJoinKeyFailure('ERROR: canceling statement due to statement timeout\n').classification,
    ).toBe('STATEMENT_TIMEOUT');
    const unsafe = compactJoinKeyFailure(
      'NOTICE: E4_JOIN_KEY_UNEXPECTED {"kind":"secret","variant":"BASELINE","state":"private","constraintMatches":false,"messageMatches":false}\n',
    );
    expect(unsafe.unexpected).toBeNull();
    expect(JSON.stringify(unsafe)).not.toContain('secret');
    expect(
      compactJoinKeyFailure('NOTICE: E4_JOIN_KEY_UNEXPECTED {invalid}\n').unexpected,
    ).toBeNull();
    const driver = readFileSync(
      resolve(__dirname, '../diagnostics/e4-prepare-cost.diagnostic-spec.ts'),
      'utf8',
    );
    const probe = driver.slice(
      driver.indexOf('async function probeJoinKeyCandidate('),
      driver.indexOf('async function joinKeyPostFailureOracle('),
    );
    expect(probe.indexOf('ownedBackendGone: true')).toBeLessThan(
      probe.indexOf('compactJoinKeyFailure(stderr)'),
    );
  });
  it.each([
    ['wrong sqlstate', '"sqlstate":"23514"', '"sqlstate":"P0001"'],
    ['wrong constraint', '"constraint":"e4_evaluation_guard"', '"constraint":"e4_complete_guard"'],
    ['missing rollback', '"rolledBack":true', '"rolledBack":false'],
    ['lost rows', '"allShadowRowsRestored":true', '"allShadowRowsRestored":false'],
    ['lost marker', '"markerRestored":true', '"markerRestored":false'],
    ['changed backend', '"sameBackend":true', '"sameBackend":false'],
    ['changed memory', '"workMemKb":4096', '"workMemKb":32768'],
    ['failed control', '"returned":true', '"returned":false'],
  ])('refuses %s in candidate receipts', (_label, before, after) => {
    expect(() => compactJoinKeyEvidence(comparisonNotice().replace(before, after))).toThrow();
  });
  it('refuses a candidate execution outside maximum/first oracle or combined with the earlier single-plan mode', () => {
    const approved = { ...env, SRVF_E4_JOIN_KEY_ONCE: '1', SRVF_E4_CANONICAL_FIRST32: '1' };
    expect(() => requireDiagnosticEnvironment(approved, head)).not.toThrow();
    for (const change of [
      { SRVF_E4_DIAGNOSTIC_SCENARIO: 'ordinary-500' },
      { SRVF_E4_CANONICAL_FIRST32: '' },
      { SRVF_E4_SHARED_GUARD_ONCE: '1' },
      { SRVF_E4_JOIN_KEY_ONCE: 'true' },
    ])
      expect(() => requireDiagnosticEnvironment({ ...approved, ...change }, head)).toThrow();
  });
  it('captures the pinned actual nested statement with hierarchy, node timing and physical metrics only', () => {
    const result = compactSharedGuardNotice(notice(guardDocument()));
    expect(result.durationMs).toBe(1234.5);
    expect(result.nodes).toHaveLength(3);
    expect(result.nodes[1]).toMatchObject({
      parent: 0,
      rows: 50000,
      loops: 1,
      totalMs: 2,
      tempWritten: 11,
    });
    const json = JSON.stringify(result);
    expect(json).not.toMatch(/private|Query Text|Filter|root\.id|INTO source_invalid/u);
    expect(result.timing).toBe('NODE_AVERAGES_PER_LOOP_INCLUSIVE_DO_NOT_SUM');
  });
  it('matches PostgreSQL SPI removal of the PLpgSQL INTO clause without accepting changed SQL', () => {
    const document = guardDocument();
    document['Query Text'] = document['Query Text'].replace(
      'INTO source_invalid,evaluation_mismatch',
      ' ',
    );
    expect(() => compactSharedGuardNotice(notice(document))).not.toThrow();
    document['Query Text'] = document['Query Text'].replace('FULL JOIN actual', 'LEFT JOIN actual');
    expect(() => compactSharedGuardNotice(notice(document))).toThrow('missing or repeated');
  });
  it('refuses missing, duplicate, truncated, estimated-only and partial-dataset receipts', () => {
    const document = guardDocument();
    expect(() => compactSharedGuardNotice('')).toThrow();
    expect(() => compactSharedGuardNotice(notice(document).repeat(2))).toThrow();
    expect(() => compactSharedGuardNotice(notice(document).slice(0, -5))).toThrow();
    const estimated = { ...document, Plan: { 'Node Type': 'Result', 'Plan Rows': 1 } };
    expect(() => compactSharedGuardNotice(notice(estimated))).toThrow('actual timing');
    document.Plan.Plans[0]['Actual Rows'] = 49999;
    expect(() => compactSharedGuardNotice(notice(document))).toThrow('full dataset');
  });
  it('refuses shared profiling without maximum, the complete first oracle or exact opt-in', () => {
    const approved = { ...env, SRVF_E4_SHARED_GUARD_ONCE: '1', SRVF_E4_CANONICAL_FIRST32: '1' };
    expect(() => requireDiagnosticEnvironment(approved, head)).not.toThrow();
    for (const change of [
      { SRVF_E4_DIAGNOSTIC_SCENARIO: 'ordinary-500' },
      { SRVF_E4_CANONICAL_FIRST32: '' },
      { SRVF_E4_SHARED_GUARD_ONCE: 'true' },
      { SRVF_E4_CANONICAL_COST_ONLY: '1' },
    ])
      expect(() => requireDiagnosticEnvironment({ ...approved, ...change }, head)).toThrow();
  });
  it('profiles exactly one actual function call read-only at original settings and30s with quoted psql binding', () => {
    const sql = sharedGuardProbeSql('synthetic_root', 'app_test_w98');
    expect(sql.match(/SELECT public\.e4_assert_complete/gu)).toHaveLength(1);
    expect(sql).toContain("SELECT public.e4_assert_complete(:'root_id',FALSE)");
    expect(sql).toContain('BEGIN READ ONLY');
    expect(sql).toContain('ROLLBACK;');
    expect(sql).toContain("SET LOCAL statement_timeout='30s'");
    expect(sql).toContain("SET LOCAL plan_cache_mode='force_custom_plan'");
    expect(sql).not.toMatch(
      /SET(?: LOCAL)? (?:work_mem|jit)|CREATE|ALTER|INSERT|UPDATE|DELETE|synthetic_root/u,
    );
    expect(() => sharedGuardProbeSql("root'; DROP TABLE x", 'app_test_w98')).toThrow();
    expect(() => sharedGuardProbeSql('root', 'app_test')).toThrow();
  });
  it.each([true, false])(
    'sets only transaction-local32MB while keeping the effective default JIT=%s and original30s',
    async (jitEnabled) => {
      const statements: string[] = [];
      const tx = {
        $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
          statements.push(strings.join(''));
          return 1;
        }),
        $queryRaw: jest.fn(async () => [{ readonly: true, workMemKb: 32768, jitEnabled }]),
      };
      const original = jest.fn<Promise<unknown>, unknown[]>(async (...args) =>
        Reflect.apply(args[0] as (...a: unknown[]) => unknown, undefined, [tx]),
      );
      const client = { $transaction: original };
      const evidence: Parameters<typeof firstCanonical32Client>[1] = {
        substage: 'ORACLE_CANONICAL_DOCUMENT',
      };
      const adapted = firstCanonical32Client(client, evidence);
      const value = {
        oldCount: 8000,
        candidateCount: 8000,
        storedCount: 8000,
        candidateDifferences: 0,
        storedDifferences: 0,
        rootMatches: true,
      };
      const callback = jest.fn(async () => value);
      const options = Object.freeze({ timeout: 30000, maxWait: 2000 });
      const result = adapted.$transaction(callback, options);
      expect(result).toBe(original.mock.results[0].value);
      await expect(result).resolves.toBe(value);
      expect(original.mock.contexts[0]).toBe(client);
      expect(original.mock.calls[0][1]).toBe(options);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(tx);
      expect(statements).toEqual(["SET LOCAL work_mem='32MB'"]);
      expect(evidence.firstCanonical32).toMatchObject({
        attempts: 1,
        transactionMs: 30000,
        workMemKb: 32768,
        jit: 'DEFAULT_UNCHANGED',
        outcome: 'RETURNED',
        effective: { readonly: true, workMemKb: 32768, jitEnabled },
      });
      expect(evidence.firstCanonical32?.fullComparisonValidated).toBeUndefined();
      expect(() => adapted.$transaction(callback, options)).toThrow();
    },
  );
  it('leaves Day and Root callbacks and budgets untouched and refuses a changed canonical budget', () => {
    const original = jest.fn<Promise<void>, unknown[]>(async () => undefined);
    const client = { $transaction: original };
    const evidence: Parameters<typeof firstCanonical32Client>[1] = {
      substage: 'ORACLE_DAY_POINTS',
    };
    const adapted = firstCanonical32Client(client, evidence);
    const callback = () => Promise.resolve();
    const options = { timeout: 60000 };
    expect(adapted.$transaction(callback, options)).toBe(original.mock.results[0].value);
    expect(original).toHaveBeenCalledWith(callback, options);
    expect(evidence.firstCanonical32).toBeUndefined();
    evidence.substage = 'ORACLE_CANONICAL_DOCUMENT';
    expect(() => adapted.$transaction(callback, { timeout: 60000 })).toThrow();
    expect(original).toHaveBeenCalledTimes(1);
  });
  it('refuses first32 combined with cost/warm-up probes or a nonmaximum case', () => {
    expect(() =>
      requireDiagnosticEnvironment({ ...env, SRVF_E4_CANONICAL_FIRST32: '1' }, head),
    ).not.toThrow();
    for (const change of [
      { SRVF_E4_CANONICAL_COST_ONLY: '1' },
      { SRVF_E4_CANONICAL_JIT_ABBA: '1' },
      { SRVF_E4_CANONICAL_MEMORY_PAIR: '1' },
      { SRVF_E4_DIAGNOSTIC_SCENARIO: 'ordinary-500' },
    ])
      expect(() =>
        requireDiagnosticEnvironment({ ...env, SRVF_E4_CANONICAL_FIRST32: '1', ...change }, head),
      ).toThrow();
  });
  const timeoutError = {
    className: 'PrismaClientKnownRequestError',
    category: 'P2028' as const,
    message: 'Transaction expired: timeout 30000 ms, elapsed 30079 ms',
    timing: { timeoutMs: 30000, elapsedMs: 30079 },
    controlledRollback: false,
  };
  const retainedTimeout = {
    oracle: 'NOT_RUN',
    errorSubstage: 'ORACLE_CANONICAL_DOCUMENT',
    error: timeoutError,
    firstCanonical32: {
      outcome: 'REJECTED' as const,
      transactionMs: 30000 as const,
      workMemKb: 32768 as const,
      error: timeoutError,
    },
  };
  it('keeps a known first canonical timeout separate from independent candidate verification', () => {
    expect(joinKeyOracleGate(retainedTimeout)).toBe('FIRST_CANONICAL_TIMEOUT_RETAINED');
    expect(retainedTimeout.oracle).toBe('NOT_RUN');
    expect(retainedTimeout.firstCanonical32.outcome).toBe('REJECTED');
    expect(
      joinKeyOracleGate({
        oracle: 'COMPLETE',
        firstCanonical32: {
          outcome: 'RETURNED',
          transactionMs: 30000,
          workMemKb: 32768,
          fullComparisonValidated: true,
        },
      }),
    ).toBe('FIRST_ORACLE_COMPLETE');
  });
  it.each(['ORACLE_DAY_POINTS', 'ORACLE_ROOT_HASH', 'PREPARE'])(
    'refuses independent sampling after a failure at %s',
    (errorSubstage) => {
      expect(() => joinKeyOracleGate({ ...retainedTimeout, errorSubstage })).toThrow();
    },
  );
  it('refuses unknown timeout evidence, assertion failures, mismatched adapters and an unvalidated complete flag', () => {
    expect(() =>
      joinKeyOracleGate({
        ...retainedTimeout,
        error: { ...timeoutError, category: 'ASSERTION_FAILED' },
      }),
    ).toThrow();
    expect(() =>
      joinKeyOracleGate({ ...retainedTimeout, error: { ...timeoutError, timing: null } }),
    ).toThrow();
    expect(() => joinKeyOracleGate({ ...retainedTimeout, firstCanonical32: undefined })).toThrow();
    expect(() => joinKeyOracleGate({ oracle: 'COMPLETE' })).toThrow();
  });
  it('isolates the memory pair from JIT ordering and refuses unbounded or combined modes', () => {
    expect(() =>
      requireDiagnosticEnvironment(
        { ...env, SRVF_E4_CANONICAL_COST_ONLY: '1', SRVF_E4_CANONICAL_MEMORY_PAIR: '1' },
        head,
      ),
    ).not.toThrow();
    expect(() =>
      requireDiagnosticEnvironment({ ...env, SRVF_E4_CANONICAL_MEMORY_PAIR: '1' }, head),
    ).toThrow();
    expect(() =>
      requireDiagnosticEnvironment(
        {
          ...env,
          SRVF_E4_CANONICAL_COST_ONLY: '1',
          SRVF_E4_CANONICAL_MEMORY_PAIR: '1',
          SRVF_E4_CANONICAL_JIT_ABBA: '1',
        },
        head,
      ),
    ).toThrow();
    expect(() =>
      requireDiagnosticEnvironment(
        { ...env, SRVF_E4_CANONICAL_COST_ONLY: '1', SRVF_E4_CANONICAL_MEMORY_PAIR: 'again' },
        head,
      ),
    ).toThrow();
  });
  it('retains actual sort/disk/temp metrics without keys, expressions or data values', () => {
    const plan = compactCanonicalActualPlan(
      [
        {
          Plan: {
            'Node Type': 'Sort',
            'Plan Rows': 8000,
            'Plan Width': 32,
            'Total Cost': 100,
            'Actual Rows': 8000,
            'Actual Loops': 1,
            'Sort Method': 'external merge',
            'Sort Space Type': 'Disk',
            'Sort Space Used': 31000,
            'Temp Read Blocks': 100,
            'Temp Written Blocks': 200,
            'Sort Key': ['private-member'],
          },
          'Execution Time': 1000,
        },
      ],
      true,
    );
    expect(plan.selected[0]).toMatchObject({
      type: 'Sort',
      actualRows: 8000,
      loops: 1,
      sortMethod: 'external merge',
      sortSpaceType: 'Disk',
      sortSpace: 31000,
      tempRead: 100,
      tempWritten: 200,
    });
    expect(JSON.stringify(plan)).not.toMatch(/private-member|Sort Key/u);
  });
  it('uses a fixed ON/OFF then OFF/ON sequence without increasing either30s budget', () => {
    expect(CANONICAL_JIT_ORDER).toEqual([
      ['ON_OFF', 'on'],
      ['ON_OFF', 'off'],
      ['OFF_ON', 'off'],
      ['OFF_ON', 'on'],
    ]);
    expect(() =>
      requireDiagnosticEnvironment(
        { ...env, SRVF_E4_CANONICAL_COST_ONLY: '1', SRVF_E4_CANONICAL_JIT_ABBA: '1' },
        head,
      ),
    ).not.toThrow();
    expect(() =>
      requireDiagnosticEnvironment({ ...env, SRVF_E4_CANONICAL_JIT_ABBA: '1' }, head),
    ).toThrow();
  });
  it.each([
    { oldCount: 7999 },
    { candidateCount: 8001 },
    { storedCount: 7999 },
    { candidateDifferences: 1 },
    { storedDifferences: 1 },
    { rootMatches: false },
  ])(
    'keeps the full frozen comparison assertions for missing, extra, changed and hash-mismatching rows:%p',
    (change) => {
      const original = {
        oldCount: 8000,
        candidateCount: 8000,
        storedCount: 8000,
        candidateDifferences: 0,
        storedDifferences: 0,
        rootMatches: true,
      };
      expect(() => assertCanonicalComparison(original, 8000)).not.toThrow();
      expect(() => assertCanonicalComparison({ ...original, ...change }, 8000)).toThrow();
    },
  );
  it('separates actual policy-band rows/loops from estimates without exporting predicates or values', () => {
    const actual = compactCanonicalActualPlan([
      {
        Plan: {
          'Node Type': 'Nested Loop',
          'Subplan Name': 'CTE policy_bands',
          'Plan Rows': 200000000,
          'Plan Width': 136,
          'Total Cost': 123,
          'Actual Rows': 4,
          'Actual Loops': 1,
          'Temp Read Blocks': 0,
          'Temp Written Blocks': 0,
          Filter: 'private-member',
        },
        'Execution Time': 10,
        'Planning Time': 1,
      },
    ]);
    expect(actual.selected).toEqual([
      {
        type: 'Nested Loop',
        cte: 'policy_bands',
        estimatedRows: 200000000,
        actualRows: 4,
        loops: 1,
        tempRead: 0,
        tempWritten: 0,
      },
    ]);
    expect(JSON.stringify(actual)).not.toContain('private-member');
    expect(actual.mode).toBe('ACTUAL_ANALYZE_BUFFERS_TIMING_OFF');
  });
  it('forces every full canonical document and key in separate read-only cost projections with bound identities', () => {
    const id = 'PRIVATE_ROOT_ID_FOR_OFFLINE';
    const queries = canonicalCostQueries(id, 'time_revision');
    for (const query of [queries.old, queries.candidate, queries.stored]) {
      expect(query.sql).toContain('pg_column_size(evaluation)');
      expect(query.sql).toContain('octet_length(unit_canonical)');
      expect(query.sql).toContain('MATERIALIZED');
      expect(query.sql).not.toContain(id);
      expect(query.values).toContain(id);
      expect(query.sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/u);
    }
    expect(queries.comparison.sql).toContain('FULL JOIN candidate');
    expect(queries.comparison.sql).toContain('FULL JOIN stored');
    expect(queries.comparison.sql).toContain('rootMatches');
    expect(queries.comparison.sql).not.toContain(id);
    expect(queries.comparison.values).toContain('time_revision');
  });
  it('exports only estimated numeric/operator plan fields, excluding SQL, filters and business values', () => {
    const value = [
      {
        Plan: {
          'Node Type': 'Hash Join',
          'Plan Rows': 8000,
          'Plan Width': 32,
          'Total Cost': 12.5,
          Filter: 'secret-member',
          Output: ['private-id'],
          Plans: [
            {
              'Node Type': 'Function Scan',
              'Plan Rows': 1000,
              'Plan Width': 64,
              'Total Cost': 5,
              'Function Name': 'private-name',
            },
          ],
        },
      },
    ];
    const compact = compactCanonicalCostPlan(value);
    expect(compact).toMatchObject({
      mode: 'ESTIMATED_ONLY_NO_ANALYZE',
      costUnits: 'OPTIMIZER_UNITS_NOT_MILLISECONDS',
      nodes: [
        { type: 'Hash Join', rows: 8000, width: 32, totalCost: 12.5 },
        { type: 'Function Scan', rows: 1000, width: 64, totalCost: 5 },
      ],
    });
    expect(JSON.stringify(compact)).not.toMatch(/secret|private|Filter|Output|Function Name/u);
  });
  it('permits cost-only mode solely for the closed maximum case', () => {
    expect(() =>
      requireDiagnosticEnvironment({ ...env, SRVF_E4_CANONICAL_COST_ONLY: '1' }, head),
    ).not.toThrow();
    expect(() =>
      requireDiagnosticEnvironment(
        { ...env, SRVF_E4_DIAGNOSTIC_SCENARIO: 'ordinary-500', SRVF_E4_CANONICAL_COST_ONLY: '1' },
        head,
      ),
    ).toThrow();
    expect(() =>
      requireDiagnosticEnvironment({ ...env, SRVF_E4_CANONICAL_COST_ONLY: 'again' }, head),
    ).toThrow();
  });
  it('distinguishes source denominator,60s day,30s root and canonical steps without changing frozen function results', async () => {
    const steps: string[] = [];
    const code = `async function assertFixedE4RootOracle(){return 1;} async function assertE4SliceSourceDenominators(){return 2;} async function assertFixedE4DayOracle(){await assertE4SliceSourceDenominators();return 3;} async function assertFixedE4Oracle(){await assertFixedE4DayOracle();await assertFixedE4RootOracle();return 4;}`;
    const run = runInNewContext(code + oracleStageWrappers(true) + '\nassertFixedE4Oracle;', {
      oracleStep: (step: string) => steps.push(step),
    }) as () => Promise<number>;
    await expect(run()).resolves.toBe(4);
    expect(steps).toEqual([
      'ORACLE_DAY_POINTS',
      'ORACLE_SOURCE_DENOMINATORS',
      'ORACLE_DAY_POINTS',
      'ORACLE_ROOT_AGGREGATE',
      'ORACLE_CANONICAL_DOCUMENT',
    ]);
  });
  it('preserves the exact original oracle Promise, callback, receiver and explicit budget on failure', async () => {
    const error = Object.assign(
      new Error(
        'The timeout for this transaction was 30000 ms, however 31812 ms passed since the start of the transaction.',
      ),
      { code: 'P2028' },
    );
    const promise = Promise.reject(error);
    const original = jest.fn<Promise<never>, unknown[]>(() => promise);
    const client = { $transaction: original };
    const evidence: Parameters<typeof diagnosticOracleClient>[1] = {
      substage: 'ORACLE_ROOT_AGGREGATE',
    };
    const observed = diagnosticOracleClient(client, evidence);
    const callback = () => Promise.resolve();
    const options = Object.freeze({ timeout: 30000, maxWait: 2000 });
    expect(observed.$transaction(callback, options)).toBe(promise);
    await expect(promise).rejects.toBe(error);
    expect(original.mock.contexts[0]).toBe(client);
    expect(original).toHaveBeenCalledWith(callback, options);
    expect(client.$transaction).toBe(original);
    expect(evidence.oracleTransactions).toHaveLength(1);
    expect(evidence.oracleTransactions![0]).toMatchObject({
      substage: 'ORACLE_ROOT_AGGREGATE',
      timeoutMs: 30000,
      outcome: 'REJECTED',
      error: { timing: { timeoutMs: 30000, elapsedMs: 31812 } },
    });
  });
  it.each([1, 100, 500] as const)(
    'builds ordinary population%s through the existing synchronous fixture path',
    async (identities) => {
      const boundary = new Error('offline source-entry boundary');
      const source = jest.fn(
        async (_fixture: E4Fixture, options: Parameters<typeof createE4Source>[1]) => {
          expect(options).toMatchObject({ batch: false });
          expect(options?.manualSlices).toHaveLength(5);
          throw boundary;
        },
      );
      await expect(createDiagnosticE4Source({} as E4Fixture, identities, source)).rejects.toBe(
        boundary,
      );
      expect(source).toHaveBeenCalledTimes(1);
    },
  );
  it('queries the actual two-argument143 catalog identity despite the defaulted boolean', async () => {
    const migration = readFileSync(
      resolve(
        __dirname,
        '../../prisma/migrations/20261013000000_activity_contribution_assert_source_reuse/migration.sql',
      ),
      'utf8',
    );
    const declaration = migration.match(
      /CREATE OR REPLACE FUNCTION e4_assert_complete\(([^)]+)\)/u,
    );
    expect(declaration).not.toBeNull();
    const argumentTypes = declaration![1]
      .split(',')
      .map((argument) => argument.trim().split(/\s+/u)[1].toLowerCase());
    expect(argumentTypes).toEqual(['text', 'boolean']);
    expect(declaration![1]).toContain('BOOLEAN DEFAULT TRUE');
    const actualIdentity = `public.e4_assert_complete(${argumentTypes.join(',')})`;
    const query = jest.fn(async (strings: TemplateStringsArray) => {
      const identities = [...strings.join('').matchAll(/'([^']+)'::regprocedure/gu)].map(
        (match) => match[1],
      );
      if (identities.length !== 1 || identities[0] !== actualIdentity)
        throw Object.assign(new Error('synthetic catalog identity missing'), { code: 'P2010' });
      return [
        {
          count: 143,
          checksum: E4_DIAGNOSTIC_PLAN.migration143Sha256,
          pin: E4_DIAGNOSTIC_PLAN.completeFunctionMd5,
          enabled: 'O',
        },
      ];
    });
    await expect(
      verifyDiagnosticDatabase({ $queryRaw: query as unknown as PrismaClient['$queryRaw'] }),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
  });
  it.each([
    { count: 142 },
    { checksum: '0'.repeat(64) },
    { pin: '21fe9ecf6df989a3f8fa5878df40b93c' },
    { enabled: 'D' },
  ])('still refuses a stale or disabled installed143 catalog:%p', async (change) => {
    const query = jest.fn(async () => [
      {
        count: 143,
        checksum: E4_DIAGNOSTIC_PLAN.migration143Sha256,
        pin: E4_DIAGNOSTIC_PLAN.completeFunctionMd5,
        enabled: 'O',
        ...change,
      },
    ]);
    await expect(
      verifyDiagnosticDatabase({ $queryRaw: query as unknown as PrismaClient['$queryRaw'] }),
    ).rejects.toThrow();
  });
  it.each(['GUARD', 'FIXTURE_BOOTSTRAP'] as const)(
    'keeps a bounded%s receipt after a real child startup failure, without child.json or raw errors',
    (stage) => {
      const directory = mkdtempSync(resolve(tmpdir(), 'srvf-e4-prepare-cost-offline-'));
      try {
        const script =
          "const {stageReceipt}=require('./test/diagnostics/e4-prepare-cost.diagnostic-spec'); const receipt=stageReceipt(process.argv[1],'a'.repeat(40),'123'); receipt.start(process.argv[2],()=>{throw new Error('SELECT secret; postgresql://synthetic:password@invalid.example/private');},process.argv[2]==='GUARD'?'REFUSED':'INITIALIZATION_FAILED');";
        const child = spawnSync(
          process.execPath,
          [
            '-r',
            require.resolve('ts-node/register/transpile-only'),
            '-e',
            script,
            directory,
            stage,
          ],
          {
            cwd: resolve(__dirname, '../..'),
            env: { ...process.env, TS_NODE_PROJECT: resolve(__dirname, '../tsconfig.test.json') },
            stdio: 'ignore',
            timeout: 15000,
          },
        );
        expect(child.error).toBeUndefined();
        expect(child.status).toBe(1);
        expect(child.signal).toBeNull();
        expect(existsSync(resolve(directory, 'child.json'))).toBe(false);
        const raw = readFileSync(resolve(directory, 'stage.json'));
        expect(raw.length).toBeLessThanOrEqual(4096);
        const result = readE4DiagnosticStageReceipt(
          JSON.parse(raw.toString()),
          head,
          '123',
          child.status,
        );
        expect(result).toMatchObject({
          receiptStatus: 'FAILED',
          lastStage: stage,
          lastOutcome: 'FAILED',
          failureStage: stage,
          errorCategory: stage === 'GUARD' ? 'REFUSED' : 'INITIALIZATION_FAILED',
        });
        expect(JSON.stringify(result)).not.toMatch(
          /SELECT|postgresql|password|invalid\.example|stack/iu,
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    20000,
  );
  it('rejects unbound/oversized stage receipts and does not export extra fields or arbitrary error codes', () => {
    const event = {
      stage: 'FIXTURE_BOOTSTRAP',
      outcome: 'ENTER',
      errorCategory: 'NONE',
      stack: 'private',
    };
    const value = {
      schema: 'e4-prepare-stage/v1',
      head,
      run: '123',
      events: [event],
      environment: 'private',
    };
    expect(readE4DiagnosticStageReceipt(value, head, '123', 1)).toMatchObject({
      receiptStatus: 'FAILED',
      errorCategory: 'INITIALIZATION_FAILED',
    });
    expect(JSON.stringify(readE4DiagnosticStageReceipt(value, head, '123', 1))).not.toContain(
      'private',
    );
    expect(
      readE4DiagnosticStageReceipt({ ...value, head: 'b'.repeat(40) }, head, '123', 1)
        .receiptStatus,
    ).toBe('UNKNOWN');
    expect(
      readE4DiagnosticStageReceipt({ ...value, events: Array(41).fill(event) }, head, '123', 1)
        .receiptStatus,
    ).toBe('UNKNOWN');
    expect(
      e4DiagnosticErrorCategory({ code: 'credential', message: 'private', stack: 'private' }),
    ).toBe('UNKNOWN');
    expect(e4DiagnosticErrorCategory({ code: 'P2028', message: 'private' })).toBe('P2028');
  });
  it('requires exact purpose/head/attempt/repository/scope and refuses retained or function modes', () => {
    expect(() => requireDiagnosticEnvironment(env, head)).not.toThrow();
    for (const change of [
      { SRVF_E4_DIAGNOSTIC_PURPOSE: 'FORMAL' },
      { GITHUB_SHA: 'b'.repeat(40) },
      { GITHUB_RUN_ATTEMPT: '2' },
      { SRVF_E4_DIAGNOSTIC_SCENARIO: 'unbounded' },
      { SRVF_E4_DIAGNOSTIC_SCENARIO: '' },
      { GITHUB_REPOSITORY: 'elsewhere/repo' },
      { GITHUB_ACTIONS: 'false' },
      { APP_ENV: 'production' },
      { SRVF_TEST_RUN_SCOPE: 'app_test_w1' },
      { SRVF_E4_N1_LIFECYCLE: 'install-retain' },
      { SRVF_E4_GUARD_FUNCTION_DIAGNOSTIC: '1' },
      { SRVF_E4_GUARD_PLAN_DIAGNOSTIC: '1' },
    ])
      expect(() => requireDiagnosticEnvironment({ ...env, ...change }, head)).toThrow();
  });
  it('extracts every complete frozen oracle function as data without registering the old E2E', () => {
    const source = frozenE4OracleSource();
    const ast = ts.createSourceFile('oracle.ts', source, ts.ScriptTarget.Latest, true);
    expect(
      ast.statements.map((node) =>
        ts.isFunctionDeclaration(node) ? node.name?.text : 'unexpected',
      ),
    ).toEqual([
      'fixedE4RootAggregateSql',
      'assertFixedE4RootOracle',
      'assertE4SliceSourceDenominators',
      'assertFixedE4DayOracle',
      'assertFixedE4Oracle',
    ]);
    expect(source).toContain('FULL JOIN');
    expect(source).toContain('assertFixedE4DayOracle');
    expect(source).not.toMatch(/\b(?:describe|beforeAll|afterAll|it)\(/u);
    expect(() => frozenE4OracleSource(source)).toThrow('frozen oracle');
  });
  it('binds current143 before any database work and freezes both complete oracle sources', () => {
    expect(() => verifyDiagnosticMigrationSource()).not.toThrow();
    expect(() => verifyDiagnosticMigrationSource(Buffer.from('old migration'))).toThrow(
      'current143',
    );
    const ordinary = frozenOrdinaryOracleSource();
    expect(ordinary).toContain('FULL JOIN');
    expect(ordinary).toContain('sourceSetHash');
    expect(ordinary).toContain('evaluationSetHash');
    expect(ordinary).not.toMatch(/\b(?:describe|beforeAll|afterAll|it)\(/u);
    expect(() => frozenOrdinaryOracleSource(ordinary)).toThrow('frozen oracle');
    expect(E4_DIAGNOSTIC_PLAN.scenarios.map(diagnosticPopulation)).toEqual([
      1, 100, 500, 2000, 1, 1,
    ]);
    expect(E4_DIAGNOSTIC_PLAN.completeFunctionMd5).toBe('ade4d2af9aa0baf8400a79fc6b62c797');
    expect(E4_DIAGNOSTIC_PLAN.internalSqlPlan).toBe('NOT_RUN');
  });
  it('is excluded by the unchanged default E2E collection regex', () => {
    const config = readFileSync(resolve(__dirname, '../jest-e2e.config.ts'), 'utf8');
    expect(config).toContain("testRegex: '.*\\\\.e2e-spec\\\\.ts$'");
    expect(/.*\.e2e-spec\.ts$/u.test('test/diagnostics/e4-prepare-cost.diagnostic-spec.ts')).toBe(
      false,
    );
    expect(E4_DIAGNOSTIC_PLAN.acceptance).toBe('NOT_AN_ACCEPTANCE_RESULT');
  });
});
