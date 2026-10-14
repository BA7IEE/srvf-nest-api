import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
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
  diagnosticPopulation,
  requireDiagnosticEnvironment,
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
