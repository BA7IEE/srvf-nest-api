import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  E4_MIGRATION_144,
  E4_MIGRATION_153,
  e4HistoricalMigrationPrefix,
} from '../../../test/helpers/e4-migration-prefix';

const root = resolve(__dirname, '../../../prisma/migrations');
const original = readFileSync(resolve(root, E4_MIGRATION_144, 'migration.sql'), 'utf8');
const candidate = readFileSync(resolve(root, E4_MIGRATION_153, 'migration.sql'), 'utf8');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const oldStart = '  JOIN "ParticipantTimeAllocationSlice" s ON';
const newStart = '  JOIN LATERAL (\n    SELECT s0.id,';
const end = '  WHERE r."sourceKindCode"=\'time_revision\' AND rr."resultCode"=\'present\'';

function joinBlock(sql: string, start: string) {
  expect(sql.split(start)).toHaveLength(2);
  expect(sql.split(end)).toHaveLength(2);
  return sql.slice(sql.indexOf(start), sql.indexOf(end));
}

describe('source153 parameterized reads forward migration', () => {
  it('adds153 while retaining historical144 and the fixed137 evidence prefix', () => {
    expect(sha(original)).toBe('ac47d7564ef20d3b5f82d9729d6e35ac04068729f2e73a288af6b606c726cb4e');
    expect(sha(candidate)).toBe('8be33faf3d4e5cc3f5036117684f620be83f9c9be49acc6c168f5bf894afd0df');
    const names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names).toHaveLength(153);
    expect(names[152]).toBe(E4_MIGRATION_153);
    expect(e4HistoricalMigrationPrefix(names)).toHaveLength(137);
  });

  it('recovers the entire144 SQL transaction after reversing exactly two joins', () => {
    const oldJoins = joinBlock(original, oldStart);
    const newJoins = joinBlock(candidate, newStart);
    const restored = candidate.replace(newJoins, oldJoins);
    expect(restored.slice(restored.indexOf('BEGIN;'))).toBe(
      original.slice(original.indexOf('BEGIN;')),
    );
    expect(newJoins.match(/JOIN LATERAL/g)).toHaveLength(2);
    expect(newJoins.match(/OFFSET 0/g)).toHaveLength(2);
    expect(newJoins).not.toMatch(/\b(?:DISTINCT|LIMIT|GROUP BY|LEFT JOIN|COALESCE)\b|SELECT\s+\*/u);
    expect(candidate.split('$$')).toHaveLength(3);
    expect(candidate.split('$$')[2]).toBe(';\n\nCOMMIT;\n');
  });

  it('retains the12 output columns, NULL handling, invoker attributes and all downstream weights', () => {
    const declaration = (sql: string) =>
      sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION'), sql.indexOf('$$'));
    expect(declaration(candidate)).toBe(declaration(original));
    expect(declaration(candidate)).toContain(
      'LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public',
    );
    expect(candidate.slice(candidate.indexOf(end))).toBe(original.slice(original.indexOf(end)));
    expect(sha(candidate.split('$$')[1])).toBe(
      '808041ba5f985a484b21bd834a1ede1cbf0a8c1766b9e850102ab6234c333343',
    );
  });

  it.each([
    's0."allocationRevisionId"=a.id',
    's0."activityId"=a."activityId"',
    's0."categoryCode"=b."categoryCode"',
    'rr0."settlementVersionId"=r."settlementVersionId"',
    'rr0."participationIdentityId"=a."participationIdentityId"',
    'rr0."resultCode"=\'present\'',
    's."allocationRevisionId"=a.id',
    's."activityId"=a."activityId"',
    's."categoryCode"=b."categoryCode"',
    'rr."settlementVersionId"=r."settlementVersionId"',
    'rr."participationIdentityId"=a."participationIdentityId"',
  ])('keeps the parameterized and outer equality %s', (predicate) => {
    const block = joinBlock(candidate, newStart);
    expect(block.split(predicate)).toHaveLength(2);
  });
});
