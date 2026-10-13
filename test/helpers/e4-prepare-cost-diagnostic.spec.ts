import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  readE4DiagnosticStageReceipt,
  e4DiagnosticErrorCategory,
} from './e4-diagnostic-limits-client';
import ts from 'typescript';
import {
  E4_DIAGNOSTIC_PLAN,
  frozenE4OracleSource,
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
};
describe('E4 prepare cost closed driver (offline; no lifecycle registered)', () => {
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
      readE4DiagnosticStageReceipt({ ...value, events: Array(17).fill(event) }, head, '123', 1)
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
  it('is excluded by the unchanged default E2E collection regex', () => {
    const config = readFileSync(resolve(__dirname, '../jest-e2e.config.ts'), 'utf8');
    expect(config).toContain("testRegex: '.*\\\\.e2e-spec\\\\.ts$'");
    expect(/.*\.e2e-spec\.ts$/u.test('test/diagnostics/e4-prepare-cost.diagnostic-spec.ts')).toBe(
      false,
    );
    expect(E4_DIAGNOSTIC_PLAN.acceptance).toBe('NOT_AN_ACCEPTANCE_RESULT');
  });
});
