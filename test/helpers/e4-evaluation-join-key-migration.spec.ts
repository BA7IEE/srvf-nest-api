import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import {
  E4_DIAGNOSTIC_PLAN,
  E4_REAL_SOURCE_C,
  E4_REAL_KEY_CARRY,
  JOIN_KEY_CALIBRATION_ORDER,
  JOIN_KEY_ORDER,
  joinKeyCandidateSource,
  realKeyCarryProbeSql,
  compactRealKeyCarryEvidence,
  sharedGuardStatement,
  requireDiagnosticEnvironment,
  verifyRealKeyCarryMigrationSource,
  verifyRealKeyCarryDatabase,
  probeRealKeyCarry,
  readDiagnosticChildReport,
} from '../diagnostics/e4-prepare-cost.diagnostic-spec';

function notices(units: 4 | 2000, duplicated = false) {
  const lines: string[] = [];
  const order = units === 4 ? JOIN_KEY_CALIBRATION_ORDER : JOIN_KEY_ORDER;
  for (const [index, [phase, variant]] of order.entries()) {
    lines.push(`NOTICE: E4_JOIN_KEY_BEGIN ${index}`);
    if (phase === 'ACTUAL_PLAN') {
      const node = (type: string, rows: number, loops = 1, more = {}) => ({
        'Node Type': type,
        'Actual Rows': rows,
        'Actual Loops': loops,
        'Actual Total Time': 1,
        ...more,
      });
      const canonical = () =>
        node('Aggregate', 1, 2000, {
          Plans: [node('Function Scan', 19, 2000, { 'Function Name': 'jsonb_each' })],
        });
      const plan = node('Result', 1, 1, {
        Plans: [
          node('CTE Scan', 2500, 1, { 'CTE Name': 'assertion_sources' }),
          node('CTE Scan', 2000, 1, { 'CTE Name': 'groups' }),
          node('CTE Scan', 2000, 1, { 'CTE Name': 'pairs' }),
          canonical(),
          ...(variant === 'BASELINE' || duplicated ? [canonical()] : []),
        ],
      });
      lines.push(
        'NOTICE: duration: 1000 ms plan:\n' +
          JSON.stringify({ 'Query Text': sharedGuardStatement(variant), Plan: plan }),
      );
    }
    lines.push(
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
        }),
    );
  }
  for (const kind of ['MISSING', 'EXTRA', 'TAMPERED'])
    for (const variant of ['BASELINE', 'CANDIDATE'])
      lines.push(
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
          }),
      );
  for (const [kind, constraint, mutations] of [
    ['SOURCE_EVALUATION_ROOT', 'e4_source_guard', 3],
    ['EVALUATION_ROOT', 'e4_evaluation_guard', 2],
    ['ROOT', 'e4_complete_guard', 1],
  ])
    for (const variant of ['BASELINE', 'CANDIDATE'])
      lines.push(
        'NOTICE: E4_JOIN_KEY_METADATA_PRIORITY ' +
          JSON.stringify({
            kind,
            variant,
            sqlstate: '23514',
            constraint,
            mutations,
            allShadowRowsRestored: true,
            markerRestored: true,
          }),
      );
  lines.push(
    'NOTICE: E4_JOIN_KEY_COMPLETE ' +
      JSON.stringify({
        catalogUnchanged: true,
        guardsUnchanged: true,
        sameBackend: true,
        publicEvaluationCount: units,
      }),
  );
  return lines.join('\n');
}
describe('E4 exact145 key-only migration and bounded evidence', () => {
  it('binds145 reports independently from144 and refuses wrong pins or oversized artifacts', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'e4-key145-report-'));
    const head = 'a'.repeat(40),
      run = '123';
    const env = { SRVF_E4_REAL_SOURCE_C: '1', SRVF_E4_REAL_KEY_CARRY: '1' };
    const data = {
      ...E4_DIAGNOSTIC_PLAN,
      transactionMs: 30000,
      head,
      run,
      scenario: 'ordinary-500',
      migration: 'VERIFIED_145',
      status: 'COMPLETE',
      completeFunctionMd5: E4_REAL_KEY_CARRY.completeFunctionMd5,
      realKeyCarryCandidate: E4_REAL_KEY_CARRY,
    };
    const file = resolve(directory, 'child.json');
    try {
      writeFileSync(file, JSON.stringify(data));
      expect(readDiagnosticChildReport(directory, head, run, 'ordinary-500', env)).toEqual(data);
      expect(
        readDiagnosticChildReport(directory, head, run, 'ordinary-500', {
          SRVF_E4_REAL_SOURCE_C: '1',
        }),
      ).toBeUndefined();
      writeFileSync(
        file,
        JSON.stringify({ ...data, completeFunctionMd5: E4_DIAGNOSTIC_PLAN.completeFunctionMd5 }),
      );
      expect(readDiagnosticChildReport(directory, head, run, 'ordinary-500', env)).toBeUndefined();
      const padded = { ...data, padding: '' };
      padded.padding = 'x'.repeat(65536 - Buffer.byteLength(JSON.stringify(padded)));
      writeFileSync(file, JSON.stringify(padded));
      expect(readDiagnosticChildReport(directory, head, run, 'ordinary-500', env)).toBeDefined();
      writeFileSync(file, JSON.stringify({ ...padded, padding: padded.padding + 'x' }));
      expect(readDiagnosticChildReport(directory, head, run, 'ordinary-500', env)).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
  it('changes exactly the three key-carry expressions and no historical SQL or guard', () => {
    verifyRealKeyCarryMigrationSource();
    const sql = readFileSync(
      resolve(__dirname, '../../prisma/migrations', E4_REAL_KEY_CARRY.migration, 'migration.sql'),
      'utf8',
    );
    expect(sql.slice(sql.indexOf('BEGIN;'))).toBe(
      joinKeyCandidateSource().slice(joinKeyCandidateSource().indexOf('BEGIN;')),
    );
    expect(createHash('sha256').update(sql).digest('hex')).toBe(E4_REAL_KEY_CARRY.migrationSha256);
    expect(sql).not.toMatch(/^(?:ANALYZE|ALTER|DROP|SET|CREATE (?:CONSTRAINT )?TRIGGER)\b/gmu);
  });
  it('runs both complete bodies with the current C helper and typed shadow rows, never the metadata fast path', () => {
    const sql = realKeyCarryProbeSql('a'.repeat(24), 'app_test_w1', 4);
    expect(sql).toContain('CREATE FUNCTION pg_temp.e4_key_baseline');
    expect(sql).toContain('PERFORM pg_temp.e4_key_baseline(root_id,FALSE)');
    expect(sql).toContain('SELECT * FROM public.e4_source_rows');
    expect(sql).toContain('CREATE TEMP TABLE e4_probe_roots');
    expect(sql).toContain(E4_REAL_KEY_CARRY.completeFunctionMd5);
    expect(sql).toContain(E4_REAL_SOURCE_C.sourceFunctionMd5);
    expect(sql).not.toContain('E4_METADATA_CANONICAL');
    expect(() => realKeyCarryProbeSql('a'.repeat(24), 'production', 4)).toThrow();
    expect(() => realKeyCarryProbeSql('a'.repeat(24), 'app_test_w1', 8000 as 4)).toThrow();
  });
  it('requires native C and refuses maximum before fixture construction', () => {
    expect(() =>
      requireDiagnosticEnvironment(
        {
          SRVF_E4_REAL_KEY_CARRY: '1',
          SRVF_E4_REAL_SOURCE_C: '1',
          SRVF_E4_DIAGNOSTIC_SCENARIO: 'maximum',
        },
        'a'.repeat(40),
      ),
    ).toThrow('small/500 scope');
    expect(() =>
      requireDiagnosticEnvironment(
        { SRVF_E4_REAL_KEY_CARRY: '1', SRVF_E4_DIAGNOSTIC_SCENARIO: 'ordinary-1' },
        'a'.repeat(40),
      ),
    ).toThrow('small/500 scope');
  });
  it('binds145 plus143/144 checksums and both enabled guards', async () => {
    const correct = {
      count: 145,
      prior_checksum: E4_DIAGNOSTIC_PLAN.migration143Sha256,
      source_checksum: E4_REAL_SOURCE_C.migrationSha256,
      checksum: E4_REAL_KEY_CARRY.migrationSha256,
      complete_pin: E4_REAL_KEY_CARRY.completeFunctionMd5,
      source_pin: E4_REAL_SOURCE_C.sourceFunctionMd5,
      statement_guard: true,
      deferred_guard: true,
    };
    const db = (value: object) => ({
      $queryRaw: jest.fn(async () => [value]) as unknown as PrismaClient['$queryRaw'],
    });
    await expect(verifyRealKeyCarryDatabase(db(correct))).resolves.toBeUndefined();
    for (const change of [
      { count: 144 },
      { prior_checksum: 'bad' },
      { source_checksum: 'bad' },
      { checksum: 'bad' },
      { complete_pin: E4_DIAGNOSTIC_PLAN.completeFunctionMd5 },
      { source_pin: 'bad' },
      { statement_guard: false },
      { deferred_guard: false },
    ])
      await expect(verifyRealKeyCarryDatabase(db({ ...correct, ...change }))).rejects.toThrow();
  });
  it('requires all six negatives, six priorities and complete rollback receipts', () => {
    expect(compactRealKeyCarryEvidence(notices(4), 4).status).toBe('COMPLETE');
    expect(() =>
      compactRealKeyCarryEvidence(
        notices(4).replace('"sqlstate":"23514"', '"sqlstate":"23505"'),
        4,
      ),
    ).toThrow();
    expect(() =>
      compactRealKeyCarryEvidence(
        notices(4).replace('"allShadowRowsRestored":true', '"allShadowRowsRestored":false'),
        4,
      ),
    ).toThrow();
    expect(() =>
      compactRealKeyCarryEvidence(
        notices(4).replace('E4_JOIN_KEY_METADATA_PRIORITY', 'MISSING_PRIORITY'),
        4,
      ),
    ).toThrow();
  });
  it('accepts full500 plans only when repeated canonicalization actually falls4000 to2000', () => {
    expect(compactRealKeyCarryEvidence(notices(2000), 2000).repeatedCanonicalization).toBe(
      'OBSERVED_4000_TO_2000',
    );
    expect(
      compactRealKeyCarryEvidence(notices(2000).replaceAll('NOTICE:', 'NOTICE: 00000:'), 2000)
        .repeatedCanonicalization,
    ).toBe('OBSERVED_4000_TO_2000');
    expect(() => compactRealKeyCarryEvidence(notices(2000, true), 2000)).toThrow();
    expect(() =>
      compactRealKeyCarryEvidence(
        notices(2000).replace('"Actual Rows":2500', '"Actual Rows":2499'),
        2000,
      ),
    ).toThrow();
  });
  it('retains the primary process failure when independent owned-backend cleanup also fails', async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://fixture@localhost/app_test_w1';
    try {
      const db = {
        activitySettlementContributionRevision: {
          findUniqueOrThrow: jest.fn(async () => ({ kindCode: 'draft' })),
        },
        $queryRaw: jest.fn(async () => {
          throw new Error('cleanup failed');
        }),
      } as unknown as PrismaClient;
      const report = { oracle: 'COMPLETE', head: 'a'.repeat(40), run: '123' } as Parameters<
        typeof probeRealKeyCarry
      >[1];
      const run = jest.fn(() => ({
        status: 3,
        stdout: '',
        stderr: 'ERROR: 23505: isolated fixture error',
      })) as unknown as typeof import('node:child_process').spawnSync;
      await expect(
        probeRealKeyCarry(
          db,
          report,
          { revisionId: 'a'.repeat(24), sourceKindCode: 'time_revision', units: 4 },
          run,
        ),
      ).rejects.toThrow('bounded comparison process failed');
      expect(report.substage).toBe('KEY145_COMPARISON_PROCESS');
      expect(report.keyCarryComparison).toMatchObject({
        status: 'FAILED',
        exitCode: 3,
        cleanup: { status: 'UNKNOWN' },
      });
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
});
