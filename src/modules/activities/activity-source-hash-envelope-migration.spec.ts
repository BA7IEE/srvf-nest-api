import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = resolve(
  __dirname,
  '../../../prisma/migrations/20261019184200_activity_source_hash_envelope_fast_path/migration.sql',
);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('source hash fixed-envelope migration scope', () => {
  it('pins one forward SQL/STABLE replacement and forbids unrelated DDL or privilege changes', () => {
    const sql = readFileSync(migration, 'utf8');
    expect(sha256(sql)).toBe('bbde4b75459953641dd80a57d83a924b9b7e5068432b54847f08f1ee9f90914d');
    const statement = sql.replace(/^--.*$/gmu, '').trim();
    expect(statement).toMatch(
      /^CREATE OR REPLACE FUNCTION astr_source_set_hash\(activity_id TEXT,draft_id TEXT\)\s+RETURNS TEXT LANGUAGE sql STABLE AS \$\$/u,
    );
    expect(statement.split('$$')).toHaveLength(3);
    expect(statement.split('$$')[2].trim()).toBe(';');
    expect(statement).not.toMatch(
      /\b(?:GRANT|REVOKE|SECURITY|STRICT|PARALLEL|COST|ALTER|DROP|SET|INSERT|UPDATE|DELETE|TRUNCATE)\b/iu,
    );
    expect([...statement.matchAll(/\bastr_[a-z_]+\s*\(/gu)].map(([call]) => call.trim())).toEqual([
      'astr_source_set_hash(',
      'astr_canonical_json(',
      'astr_source_set_document(',
    ]);
  });

  it('keeps the independent pre148 hash definition pinned for upgrade and rollback oracles', () => {
    const original = readFileSync(
      resolve(
        __dirname,
        '../../../prisma/migrations/20260913090000_activity_os_r4_d4_time_bucket_settlement/migration.sql',
      ),
      'utf8',
    );
    const definitions = [
      ...original.matchAll(/CREATE FUNCTION astr_source_set_hash\([\s\S]*?\n\$\$;/gu),
    ];
    expect(definitions).toHaveLength(1);
    expect(sha256(definitions[0][0])).toBe(
      '0ec20439da18fa1c544e2fe4db2e18d99c085e262b963723391b12bb72310f69',
    );
    expect(definitions[0][0]).toContain('RETURNS TEXT LANGUAGE sql STABLE AS $$');
    expect(definitions[0][0]).toContain('astr_source_set_document(activity_id, draft_id)');
  });
});
