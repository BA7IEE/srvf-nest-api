import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  E4_MIGRATION_150,
  E4_MIGRATION_151,
  E4_MIGRATION_152,
  e4HistoricalMigrationPrefix,
} from '../../../test/helpers/e4-migration-prefix';

const root = resolve(__dirname, '../../../prisma/migrations');
const migration = readFileSync(resolve(root, E4_MIGRATION_152, 'migration.sql'), 'utf8');
const original = readFileSync(resolve(root, E4_MIGRATION_150, 'migration.sql'), 'utf8');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const body = (s: string) => s.split('$$')[1];

describe('source proof narrow forward migration scope', () => {
  it('replaces only the invoker complete-guard function and retains150 and151', () => {
    expect(sha(migration)).toBe('ae2b166f5a58b47b5938cde13fa3e9205d01bfa91e30096155aaab04582ed745');
    const sql = migration.replace(/^--.*$/gmu, '').trim();
    expect(sql).toMatch(
      /^CREATE OR REPLACE FUNCTION ctsp_assert_complete\(batch_id TEXT, require_bindings BOOLEAN\)\s+RETURNS VOID LANGUAGE plpgsql AS \$\$/u,
    );
    expect(sql.split('$$')).toHaveLength(3);
    expect(sql.split('$$')[2].trim()).toBe(';');
    expect(sql.replace(/'(?:[^']|'')*'/gu, "''")).not.toMatch(
      /\b(?:GRANT|REVOKE|SECURITY|STRICT|PARALLEL|COST|ALTER|DROP|SET|INSERT|UPDATE|DELETE|TRUNCATE)\b/iu,
    );
    expect(sha(original)).toBe('9451091106a43afff7419f6debca85bf29322bbaa19a34bb93924d51bbeff0f0');
    expect(sha(readFileSync(resolve(root, E4_MIGRATION_151, 'migration.sql'), 'utf8'))).toBe(
      '7b027fe0764525f7bc23500fd99d01ee363cc21b40c6654e492e4db35e502b54',
    );
  });
  it('retains all outer guard statements, errors, bindings and multisets exactly', () => {
    const oldBody = body(original);
    const actual = body(migration);
    const prefix = '    OR (SELECT coalesce(sum((source->>';
    const newPrefix = '    OR (CASE';
    const countsEnd = '\n      <> proof_row."expectedSliceCount"';
    const pendingStart = '  IF EXISTS (\n    SELECT 1 FROM "CorrectionPendingTimeAllocation" p';
    const newPendingStart = '  IF (CASE';
    const pendingEnd =
      "    RAISE EXCEPTION 'V3 correction proof omits an approved pending allocation'";
    const oldCount = oldBody.slice(oldBody.indexOf(prefix), oldBody.indexOf(countsEnd));
    const newCount = actual.slice(actual.indexOf(newPrefix), actual.indexOf(countsEnd));
    const oldPending = oldBody.slice(oldBody.indexOf(pendingStart), oldBody.indexOf(pendingEnd));
    const newPending = actual.slice(actual.indexOf(newPendingStart), actual.indexOf(pendingEnd));
    expect(oldCount.length).toBeGreaterThan(20);
    expect(newCount.length).toBeGreaterThan(oldCount.length);
    expect(oldPending.length).toBeGreaterThan(20);
    expect(newPending.length).toBeGreaterThan(oldPending.length);
    expect(actual.replace(newCount, oldCount).replace(newPending, oldPending)).toBe(oldBody);
    expect(actual.slice(actual.indexOf('  IF require_bindings THEN'))).toBe(
      oldBody.slice(oldBody.indexOf('  IF require_bindings THEN')),
    );
  });
  it('pins152 as one successor while rejecting an unknown migration', () => {
    const names = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(names).toHaveLength(152);
    expect(names[151]).toBe(E4_MIGRATION_152);
    expect(e4HistoricalMigrationPrefix(names)).toHaveLength(137);
    const bad = [...names];
    bad[151] = '20261021061000_unknown';
    expect(() => e4HistoricalMigrationPrefix(bad)).toThrow('successors changed');
  });
});
