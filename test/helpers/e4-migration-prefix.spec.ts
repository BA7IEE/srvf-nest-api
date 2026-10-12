import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  e4HistoricalMigrationPrefix,
  E4_MIGRATION_137,
  E4_MIGRATION_138,
  E4_MIGRATION_139,
  E4_MIGRATION_140,
  E4_MIGRATION_141,
} from './e4-migration-prefix';

const CURRENT_MIGRATION_COUNT = 141;

describe('fixed E4 historical migration prefix', () => {
  const names = readdirSync(resolve(__dirname, '../../prisma/migrations'), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  it('retains exactly 137 historical migrations and separately pins the new successor', () => {
    expect(names).toHaveLength(CURRENT_MIGRATION_COUNT);
    const prefix = e4HistoricalMigrationPrefix([...names].reverse());
    expect(prefix).toHaveLength(137);
    expect(prefix[136]).toBe(E4_MIGRATION_137);
    expect([...names].sort()[137]).toBe(E4_MIGRATION_138);
    expect([...names].sort()[138]).toBe(E4_MIGRATION_139);
    expect([...names].sort()[139]).toBe(E4_MIGRATION_140);
    expect(prefix).not.toContain(E4_MIGRATION_138);
    expect(prefix).not.toContain(E4_MIGRATION_139);
    expect(prefix).not.toContain(E4_MIGRATION_140);
    expect([...names].sort()[140]).toBe(E4_MIGRATION_141);
    expect(prefix).not.toContain(E4_MIGRATION_141);
  });

  it.each([
    'missing baseline',
    'missing successor',
    'unknown scalar successor',
    'unknown reference successor',
    'unknown evaluation successor',
    'unknown bucket successor',
    'extra migration',
  ])('rejects %s without silently widening the historical proof', (kind) => {
    const changed = [...names].sort();
    if (kind === 'missing baseline') changed.splice(0, 1);
    if (kind === 'missing successor') changed.pop();
    if (kind === 'unknown scalar successor') changed[137] = '20261012000000_unknown';
    if (kind === 'unknown reference successor') changed[138] = '20261012010000_unknown';
    if (kind === 'unknown evaluation successor') changed[139] = '20261012020000_unknown';
    if (kind === 'unknown bucket successor') changed[140] = '20261012030000_unknown';
    if (kind === 'extra migration') changed.push('20261013000000_unknown');
    expect(() => e4HistoricalMigrationPrefix(changed)).toThrow(
      'E4 fixed 137 prefix or explicit 138/139/140/141 successors changed',
    );
  });
});
