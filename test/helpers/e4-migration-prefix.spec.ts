import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  e4HistoricalMigrationPrefix,
  E4_MIGRATION_137,
  E4_MIGRATION_138,
  E4_MIGRATION_139,
  E4_MIGRATION_140,
  E4_MIGRATION_141,
  E4_MIGRATION_142,
  E4_MIGRATION_143,
  E4_MIGRATION_144,
  E4_MIGRATION_145,
  E4_MIGRATION_146,
  E4_MIGRATION_147,
  E4_MIGRATION_148,
  E4_MIGRATION_149,
  E4_MIGRATION_150,
  E4_MIGRATION_151,
  E4_MIGRATION_152,
} from './e4-migration-prefix';

const CURRENT_MIGRATION_COUNT = 152;

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
    expect([...names].sort()[141]).toBe(E4_MIGRATION_142);
    expect(prefix).not.toContain(E4_MIGRATION_142);
    expect([...names].sort()[142]).toBe(E4_MIGRATION_143);
    expect(prefix).not.toContain(E4_MIGRATION_143);
    expect([...names].sort()[143]).toBe(E4_MIGRATION_144);
    expect(prefix).not.toContain(E4_MIGRATION_144);
    expect([...names].sort()[144]).toBe(E4_MIGRATION_145);
    expect(prefix).not.toContain(E4_MIGRATION_145);
    expect([...names].sort()[145]).toBe(E4_MIGRATION_146);
    expect(prefix).not.toContain(E4_MIGRATION_146);
    expect([...names].sort()[146]).toBe(E4_MIGRATION_147);
    expect(prefix).not.toContain(E4_MIGRATION_147);
    expect([...names].sort()[147]).toBe(E4_MIGRATION_148);
    expect(prefix).not.toContain(E4_MIGRATION_148);
    expect([...names].sort()[148]).toBe(E4_MIGRATION_149);
    expect(prefix).not.toContain(E4_MIGRATION_149);
    expect([...names].sort()[149]).toBe(E4_MIGRATION_150);
    expect(prefix).not.toContain(E4_MIGRATION_150);
    expect([...names].sort()[150]).toBe(E4_MIGRATION_151);
    expect(prefix).not.toContain(E4_MIGRATION_151);
    expect([...names].sort()[151]).toBe(E4_MIGRATION_152);
    expect(prefix).not.toContain(E4_MIGRATION_152);
  });

  it.each([
    'missing baseline',
    'missing successor',
    'unknown scalar successor',
    'unknown reference successor',
    'unknown evaluation successor',
    'unknown bucket successor',
    'unknown unit helper successor',
    'unknown source reuse successor',
    'unknown source bucket successor',
    'unknown evaluation key successor',
    'unknown policy band successor',
    'unknown correction hash successor',
    'unknown source envelope successor',
    'unknown singleton successor',
    'unknown source count successor',
    'unknown grouped bucket successor',
    'unknown narrow projection successor',
    'extra migration',
  ])('rejects %s without silently widening the historical proof', (kind) => {
    const changed = [...names].sort();
    if (kind === 'missing baseline') changed.splice(0, 1);
    if (kind === 'missing successor') changed.pop();
    if (kind === 'unknown scalar successor') changed[137] = '20261012000000_unknown';
    if (kind === 'unknown reference successor') changed[138] = '20261012010000_unknown';
    if (kind === 'unknown evaluation successor') changed[139] = '20261012020000_unknown';
    if (kind === 'unknown bucket successor') changed[140] = '20261012030000_unknown';
    if (kind === 'unknown unit helper successor') changed[141] = '20261012040000_unknown';
    if (kind === 'unknown source reuse successor') changed[142] = '20261013000000_unknown';
    if (kind === 'unknown source bucket successor') changed[143] = '20261015000000_unknown';
    if (kind === 'unknown evaluation key successor') changed[144] = '20261015010000_unknown';
    if (kind === 'unknown policy band successor') changed[145] = '20261015221000_unknown';
    if (kind === 'unknown correction hash successor') changed[146] = '20261018000000_unknown';
    if (kind === 'unknown source envelope successor') changed[147] = '20261019184200_unknown';
    if (kind === 'unknown singleton successor') changed[148] = '20261020032500_unknown';
    if (kind === 'unknown source count successor') changed[149] = '20261020070354_unknown';
    if (kind === 'unknown grouped bucket successor') changed[150] = '20261020202600_unknown';
    if (kind === 'unknown narrow projection successor') changed[151] = '20261021061000_unknown';
    if (kind === 'extra migration') changed.push('20261013000000_unknown');
    expect(() => e4HistoricalMigrationPrefix(changed)).toThrow(
      'E4 fixed 137 prefix or explicit 138/139/140/141/142/143/144/145/146/147/148/149/150/151/152 successors changed',
    );
  });
});
