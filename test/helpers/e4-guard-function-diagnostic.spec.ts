import fs from 'node:fs';
import { resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import {
  E4GuardFunctionDiagnostic,
  GUARD_FUNCTION_ROLES,
  guardFunctionCounters,
  guardFunctionDelta,
  guardFunctionDiagnosticEnabled,
} from './e4-guard-function-diagnostic';

const CLOUD = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'BA7IEE/srvf-nest-api',
  GITHUB_REF: 'refs/heads/codex/activity-os-r5-e4-github-validation',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_RUN_ID: '123',
  GITHUB_SHA: 'a'.repeat(40),
  SRVF_E4_GITHUB_ISOLATED: '1',
  SRVF_E4_W98: '1',
  SRVF_E4_GUARD_PLAN_DIAGNOSTIC: '0',
  SRVF_E4_GUARD_FUNCTION_DIAGNOSTIC: '1',
};
const baseline = GUARD_FUNCTION_ROLES.map((role) => ({ role, calls: '0', totalMs: 0, selfMs: 0 }));
const after = GUARD_FUNCTION_ROLES.map((role) => ({ role, calls: '1', totalMs: 10, selfMs: 5 }));
const evaluations = Array.from({ length: 8000 }, (_, i) => ({
  sourceRefsJson: Array.from({ length: i < 2000 ? 7 : 6 }, () => ({})),
}));
const root = { kindCode: 'draft', sourceKindCode: 'time_revision' };
function snapshot(counters: unknown = baseline, backend = 81, disabled = true) {
  return [{ backend, disabled, allowed: true, catalogMatches: true, counters }];
}

describe('E4 guard function diagnostic offline', () => {
  it('is cloud-only, dedicated, single-attempt and mutually exclusive with plan mode', () => {
    expect(guardFunctionDiagnosticEnabled({})).toBe(false);
    expect(guardFunctionDiagnosticEnabled(CLOUD)).toBe(true);
    for (const patch of [
      { GITHUB_ACTIONS: 'false' },
      { GITHUB_RUN_ATTEMPT: '2' },
      { SRVF_E4_W98: '0' },
      { SRVF_E4_GUARD_PLAN_DIAGNOSTIC: '1' },
    ])
      expect(() => guardFunctionDiagnosticEnabled({ ...CLOUD, ...patch })).toThrow();
  });
  it('keeps the original dedicated entry, closed reporter and one-shot function mode', () => {
    const workflow = fs.readFileSync(
      resolve(__dirname, '../../.github/workflows/activity-os-r5-e4-validation.yml'),
      'utf8',
    );
    const job = workflow.split('\n  guard-functions:\n')[1];
    expect(job).toContain("'[e4-guard-functions-once]'");
    expect(job).toMatch(/^ {6}SRVF_E4_GUARD_FUNCTION_DIAGNOSTIC: '1'$/mu);
    expect(job).not.toContain('SRVF_E4_GUARD_PLAN_DIAGNOSTIC');
    expect(job).toMatch(/^ {6}SRVF_TEST_RUN_SCOPE: 'app_test_w98'$/mu);
    const configs = [
      ...workflow.matchAll(/const config = JSON.stringify\(\{[\s\S]*?^ {10}\}\);$/gmu),
    ].map((match) => match[0]);
    expect(configs).toHaveLength(3);
    expect(configs[2]).toBe(configs[0]);
    const reporters = [
      ...workflow.matchAll(/const closedReporterSource = String.raw`[\s\S]*?^ {10}`;$/gmu),
    ].map((match) => match[0]);
    expect(reporters).toHaveLength(3);
    expect(reporters[2]).toBe(reporters[0]);
    expect(job).toContain("'functions.json'), 8192");
  });
  it('projects exactly the fixed roles and discards unrecorded values', () => {
    const projected = guardFunctionCounters(
      baseline.map((row) => ({ ...row, private: 'unrecorded' })),
    );
    expect(projected).toHaveLength(14);
    expect(projected.every((row) => row.calls === 0)).toBe(true);
    expect(JSON.stringify(projected)).not.toContain('unrecorded');
    expect(() => guardFunctionCounters([...baseline.slice(1), baseline[1]])).toThrow();
    expect(() =>
      guardFunctionCounters(baseline.map((row) => ({ ...row, role: 'toString' }))),
    ).toThrow();
  });
  it.each(['-1', '1e2', '5000001', 'NaN'])('rejects invalid calls %s', (calls) => {
    expect(() =>
      guardFunctionCounters([{ ...baseline[0], calls }, ...baseline.slice(1)]),
    ).toThrow();
  });
  it.each([NaN, Infinity, -1, 600001])('rejects invalid timing %s', (totalMs) => {
    expect(() =>
      guardFunctionCounters([{ ...baseline[0], totalMs }, ...baseline.slice(1)]),
    ).toThrow();
  });
  it('rejects reset counters and identifies nested totals without adding them', () => {
    const before = guardFunctionCounters(baseline),
      next = guardFunctionCounters(after);
    expect(guardFunctionDelta(before, next)[0]).toEqual({
      role: 'BUCKET_HASH',
      calls: 1,
      totalMs: 10,
      selfMs: 5,
    });
    expect(() => guardFunctionDelta(next, before)).toThrow('GUARD_COUNTER_RESET');
  });
  it.each([true, false])(
    'preserves the original failure and verifies the same backend: %s',
    async (sameBackend) => {
      const saved = Object.fromEntries(Object.keys(CLOUD).map((key) => [key, process.env[key]]));
      Object.assign(process.env, CLOUD);
      const error = new Error('unrecorded original failure');
      const original = jest.fn().mockRejectedValue(error);
      const target = { insertEvaluations: original };
      const tx = {
        $queryRawUnsafe: jest
          .fn()
          .mockResolvedValueOnce(snapshot())
          .mockResolvedValueOnce([{ enabled: true }]),
      };
      const post = {
        $executeRawUnsafe: jest.fn().mockResolvedValue(0),
        $queryRawUnsafe: jest.fn().mockResolvedValue(snapshot(after, sameBackend ? 81 : 82)),
      };
      const transaction = jest.fn(
        async (
          work: (client: typeof post) => Promise<unknown>,
          options?: { maxWait: number; timeout: number },
        ) => {
          expect(options).toEqual({ maxWait: 5000, timeout: 5000 });
          return work(post);
        },
      );
      const observer = { $transaction: transaction } as unknown as Pick<
        PrismaClient,
        '$transaction'
      >;
      const writer = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
      const diagnostic = new E4GuardFunctionDiagnostic(
        target,
        resolve(process.cwd(), 'tmp/e4-guard-functions-evidence/functions.json'),
      );
      try {
        await expect(
          Reflect.apply(target.insertEvaluations, target, [tx, root, evaluations]),
        ).rejects.toBe(error);
        expect(original).toHaveBeenCalledWith(tx, root, evaluations);
        expect(tx.$queryRawUnsafe.mock.calls[1][0]).toBe(
          "SELECT set_config('track_functions','all',true)='all' AS enabled",
        );
        diagnostic.restore();
        expect(target.insertEvaluations).toBe(original);
        await diagnostic.collect(observer);
        expect(post.$executeRawUnsafe.mock.calls.map((call) => call[0])).toEqual([
          'SET TRANSACTION READ ONLY',
          "SET LOCAL statement_timeout='5000ms'",
        ]);
        expect(diagnostic.emit()).toBe(true);
        const encoded = writer.mock.calls[0][1] as string;
        expect(encoded).not.toContain('unrecorded');
        expect(encoded).not.toContain('backend');
        const record = JSON.parse(encoded);
        expect(record).toMatchObject({
          schema: 'e4-guard-functions/v1',
          status: sameBackend ? 'OBSERVED' : 'UNKNOWN',
          sameBackend,
          settingRestored: sameBackend,
          dataset: { evaluationUnits: 8000, sourceReferences: 50000 },
          acceptance: 'NOT_AN_ACCEPTANCE_RESULT',
        });
        expect(writer.mock.calls[0][2]).toEqual({ mode: 0o600, flag: 'wx' });
      } finally {
        diagnostic.restore();
        writer.mockRestore();
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
  );
  it('stops before changing settings when the caller lacks an existing privilege', async () => {
    const saved = Object.fromEntries(Object.keys(CLOUD).map((key) => [key, process.env[key]]));
    Object.assign(process.env, CLOUD);
    const original = jest.fn();
    const target = { insertEvaluations: original };
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ ...snapshot()[0], allowed: false }]),
    };
    const diagnostic = new E4GuardFunctionDiagnostic(
      target,
      resolve(process.cwd(), 'tmp/e4-guard-functions-evidence/functions.json'),
    );
    try {
      await expect(
        Reflect.apply(target.insertEvaluations, target, [tx, root, evaluations]),
      ).rejects.toThrow('E4_GUARD_FUNCTION_UNKNOWN');
      expect(original).not.toHaveBeenCalled();
      expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    } finally {
      diagnostic.restore();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
