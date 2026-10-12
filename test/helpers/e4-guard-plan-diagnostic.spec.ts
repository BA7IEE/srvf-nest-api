import fs from 'node:fs';
import { resolve } from 'node:path';
import { resolveE4ValidationScope } from './e4-d1-result-capture';
import {
  E4GuardPlanDiagnostic,
  guardPlanDiagnosticEnabled,
  projectGuardPlan,
  projectGuardPhysicalCounts,
  sourceGuardPlanSql,
} from './e4-guard-plan-diagnostic';

const CLOUD = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'BA7IEE/srvf-nest-api',
  GITHUB_REF: 'refs/heads/codex/activity-os-r5-e4-github-validation',
  SRVF_E4_GITHUB_ISOLATED: '1',
  SRVF_E4_GUARD_PLAN_DIAGNOSTIC: '1',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '123',
};
const node = {
  'Node Type': 'Seq Scan',
  'Relation Name': 'ParticipantTimeAllocationRevision',
  'Plan Rows': 1,
  'Plan Width': 24,
  'Startup Cost': 0,
  'Total Cost': 1,
  Filter: 'unrecorded parameters',
  Output: ['unrecorded source'],
};
const result = [{ 'QUERY PLAN': [{ Plan: node }] }];

describe('E4 guard planning diagnostic offline', () => {
  it('uses the independently pinned whole real body and parameterizes its exact predicate', () => {
    const migration = fs.readFileSync(
      resolve(
        __dirname,
        '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',
      ),
      'utf8',
    );
    const plan = sourceGuardPlanSql(migration);
    expect(plan.bodyMd5).toBe('21fe9ecf6df989a3f8fa5878df40b93c');
    expect(plan.sql.startsWith('EXPLAIN (FORMAT JSON) SELECT (EXISTS')).toBe(true);
    expect(plan.sql).not.toContain('ANALYZE');
    expect(plan.sql).not.toMatch(/\b(?:root|time_row)\./u);
    expect(plan.sql).toContain('bs."timeRevisionId"=$1');
    expect(plan.sql).toContain('a."ruleSnapshotId" <> $2');
    expect(plan.sql).toContain('a."ruleSnapshotHash" <> $3');
    expect(plan.sql).toContain('a."activityId" <> $4');
    expect(plan.sql).toContain('rr."settlementVersionId"=$5');
    expect(plan.sql).toContain('rr.id IS NULL');
    expect(plan.sql).toContain('b."recognizedSeconds" <> 0');
    expect(() =>
      sourceGuardPlanSql(migration.replace('contribution source population mismatch', 'tampered')),
    ).toThrow('GUARD_SOURCE_PIN');
  });
  it('uses the established dedicated D5 entry and exact cloud scope', () => {
    const workflow = fs.readFileSync(
      resolve(__dirname, '../../.github/workflows/activity-os-r5-e4-validation.yml'),
      'utf8',
    );
    const job = workflow.split('\n  guard-plan:\n')[1];
    const scope = /^ {6}SRVF_TEST_RUN_SCOPE: '([^']+)'$/mu.exec(job)?.[1];
    expect(scope).toBe('app_test_w98');
    expect(job).toMatch(/^ {6}SRVF_E4_W98: '1'$/mu);
    expect(resolveE4ValidationScope({ ...CLOUD, SRVF_TEST_RUN_SCOPE: scope }, true)).toBe(
      'app_test_w98',
    );
    expect(() =>
      resolveE4ValidationScope({ ...CLOUD, SRVF_TEST_RUN_SCOPE: 'app_test,app_test_w1' }, true),
    ).toThrow('E4 isolated GitHub scope refused');
    const configs = [
      ...workflow.matchAll(/const config = JSON.stringify\(\{[\s\S]*?^ {10}\}\);$/gmu),
    ].map((match) => match[0]);
    expect(configs).toHaveLength(2);
    expect(configs[0]).toBe(configs[1]);
    expect(configs[1]).not.toContain('globalSetup');
    const reporters = [
      ...workflow.matchAll(/const closedReporterSource = String.raw`[\s\S]*?^ {10}`;$/gmu),
    ].map((match) => match[0]);
    expect(reporters).toHaveLength(2);
    expect(reporters[0]).toBe(reporters[1]);
    expect(job).not.toContain("'--json', '--outputFile'");
    expect(job).toContain("originalCase: 'UNKNOWN'");
    expect(job).toContain("'--config', closedConfig");
  });
  it('requires actual physical populations and drops unrelated fields', () => {
    const physical = { sources: 40000, allocations: 10000, buckets: 8000, results: 2000 };
    expect(projectGuardPhysicalCounts([{ ...physical, private: 'unrecorded' }])).toEqual(physical);
    for (const invalid of [
      [],
      [null],
      [{ ...physical, sources: 50000 }],
      [{ ...physical, results: '2000' }],
    ])
      expect(() => projectGuardPhysicalCounts(invalid)).toThrow();
  });
  it('publishes only fixed roles, node types and estimated numeric fields', () => {
    const projected = projectGuardPlan(result);
    expect(projected).toEqual([
      {
        parent: null,
        type: 'Seq Scan',
        relation: 'ALLOCATIONS',
        rows: 1,
        width: 24,
        startupCost: 0,
        totalCost: 1,
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain('unrecorded');
    expect(
      projectGuardPlan([
        {
          'QUERY PLAN': [
            { Plan: { ...node, 'Relation Name': 'toString', 'Node Type': 'private-node' } },
          ],
        },
      ])[0],
    ).toMatchObject({ relation: 'OTHER', type: 'OTHER' });
  });
  it.each([NaN, Infinity, -1, '1', undefined])(
    'rejects untrustworthy numeric plan metadata: %s',
    (rows) => {
      expect(() =>
        projectGuardPlan([{ 'QUERY PLAN': [{ Plan: { ...node, 'Plan Rows': rows } }] }]),
      ).toThrow('GUARD_PLAN_NUMBER');
    },
  );
  it.each([
    null,
    [],
    [{ 'QUERY PLAN': [] }],
    [{ 'QUERY PLAN': [{ Plan: { ...node, Plans: 'invalid' } }] }],
  ])('rejects missing or malformed plan structure: %j', (value) => {
    expect(() => projectGuardPlan(value)).toThrow();
  });
  it('caps the entire tree instead of truncating or hiding excess nodes', () => {
    const wide = { ...node, Plans: Array.from({ length: 128 }, () => node) };
    expect(() => projectGuardPlan([{ 'QUERY PLAN': [{ Plan: wide }] }])).toThrow('GUARD_PLAN_NODE');
  });
  it('is disabled by default and refuses local or repeated cloud activation', () => {
    expect(guardPlanDiagnosticEnabled({})).toBe(false);
    expect(guardPlanDiagnosticEnabled(CLOUD)).toBe(true);
    expect(() => guardPlanDiagnosticEnabled({ ...CLOUD, GITHUB_ACTIONS: undefined })).toThrow();
    expect(() => guardPlanDiagnosticEnabled({ ...CLOUD, GITHUB_RUN_ATTEMPT: '2' })).toThrow();
    expect(() => guardPlanDiagnosticEnabled({ ...CLOUD, GITHUB_SHA: 'unrecorded' })).toThrow();
  });
  it('uses the caller transaction and untouched root parameters, then restores the exact method', async () => {
    const saved = Object.fromEntries(Object.keys(CLOUD).map((key) => [key, process.env[key]]));
    Object.assign(process.env, CLOUD);
    const error = new Error('unrecorded original error');
    const original = jest.fn().mockRejectedValue(error);
    const target = { insertEvaluations: original };
    const tx = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce([
          { sources: 40000, allocations: 10000, buckets: 8000, results: 2000 },
        ])
        .mockResolvedValueOnce(result),
    };
    const root = {
      kindCode: 'draft',
      sourceKindCode: 'time_revision',
      timeRevisionId: 'unrecorded-time',
      ruleSnapshotId: 'unrecorded-snapshot',
      ruleSnapshotHash: 'unrecorded-hash',
      activityId: 'unrecorded-activity',
      settlementVersionId: 'unrecorded-version',
    };
    const evaluations = Array.from({ length: 8000 }, (_, i) => ({
      sourceRefsJson: Array.from({ length: i < 2000 ? 7 : 6 }, () => ({})),
    }));
    const output = resolve(process.cwd(), 'tmp/e4-guard-plan-evidence/guard-plan.json');
    const writer = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    const diagnostic = new E4GuardPlanDiagnostic(target, output);
    try {
      await expect(
        Reflect.apply(target.insertEvaluations, target, [tx, root, evaluations]),
      ).rejects.toBe(error);
      expect(original).toHaveBeenCalledWith(tx, root, evaluations);
      expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
      const call = tx.$queryRawUnsafe.mock.calls[1] as unknown[];
      expect(call[0]).toContain('EXPLAIN (FORMAT JSON)');
      expect(tx.$queryRawUnsafe.mock.calls[0].slice(1)).toEqual(call.slice(1));
      expect(call.slice(1)).toEqual([
        root.timeRevisionId,
        root.ruleSnapshotId,
        root.ruleSnapshotHash,
        root.activityId,
        root.settlementVersionId,
      ]);
      diagnostic.restore();
      expect(target.insertEvaluations).toBe(original);
      diagnostic.emit();
      const written = writer.mock.calls[0][1] as string;
      expect(written).not.toContain('unrecorded');
      expect(JSON.parse(written)).toMatchObject({
        status: 'OBSERVED',
        kind: 'ESTIMATED_ONLY',
        acceptance: 'NOT_AN_ACCEPTANCE_RESULT',
        dataset: { evaluationUnits: 8000, sourceReferences: 50000 },
        physical: { sources: 40000, allocations: 10000, buckets: 8000, results: 2000 },
        mismatch: 'NOT_MEASURED',
        actualLoops: 'NOT_MEASURED',
      });
      expect(writer.mock.calls[0][2]).toMatchObject({ flag: 'wx', mode: 0o600 });
    } finally {
      diagnostic.restore();
      writer.mockRestore();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
