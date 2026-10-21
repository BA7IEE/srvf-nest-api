import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  e4HistoricalMigrationPrefix,
  E4_MIGRATION_151,
} from '../../../test/helpers/e4-migration-prefix';

const root = resolve(__dirname, '../../../prisma/migrations');
const original = readFileSync(
  resolve(root, '20261012030000_activity_time_bucket_canonical_fast_path/migration.sql'),
  'utf8',
);
const migration = readFileSync(resolve(root, E4_MIGRATION_151, 'migration.sql'), 'utf8');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('bucket hash grouped forward migration scope', () => {
  it('pins exactly one SQL/STABLE function replacement without data, privilege or setting changes', () => {
    expect(sha256(migration)).toBe(
      '7b027fe0764525f7bc23500fd99d01ee363cc21b40c6654e492e4db35e502b54',
    );
    const statement = migration.replace(/^--.*$/gmu, '').trim();
    expect(statement).toMatch(
      /^CREATE OR REPLACE FUNCTION astr_bucket_content_hash\(revision_id TEXT\) RETURNS TEXT LANGUAGE sql STABLE AS \$\$/u,
    );
    expect(statement.split('$$')).toHaveLength(3);
    expect(statement.split('$$')[2].trim()).toBe(';');
    expect(statement).not.toMatch(
      /\b(?:GRANT|REVOKE|SECURITY|STRICT|PARALLEL|COST|ALTER|DROP|SET|INSERT|UPDATE|DELETE|TRUNCATE)\b/iu,
    );
  });

  it('does not expand invoker column privileges through a wildcard projection', () => {
    const columns = (sql: string) =>
      [...new Set([...sql.matchAll(/\bb\."([A-Za-z]+)"/gu)].map((m) => m[1]))].sort();
    expect(migration).not.toMatch(/\bb\.\*/u);
    expect(columns(migration)).toEqual(columns(original));
    expect(columns(migration)).toHaveLength(12); // Original11 fields plus the existing revision predicate.
    expect(migration).toContain('GROUP BY b.id');
    expect(original).toContain('WHERE "bucketId" = b.id');
  });

  it('keeps141 immutable and explicitly closes the historical prefix over151', () => {
    expect(sha256(original)).toBe(
      'd10d495eb1e2bc9447f491fb7960eba0c58b8bfb3ab990803e57f676431658a4',
    );
    const names = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(names).toHaveLength(151);
    expect(names[150]).toBe(E4_MIGRATION_151);
    expect(e4HistoricalMigrationPrefix(names)).toHaveLength(137);
    const unknown = [...names];
    unknown[150] = '20261020202600_unknown';
    expect(() => e4HistoricalMigrationPrefix(unknown)).toThrow('successors changed');
  });
});
