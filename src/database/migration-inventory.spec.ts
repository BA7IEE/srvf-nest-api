import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  currentMigrationInventory,
  historicalMigrationSources,
  readFrozenMigrationCatalog,
  reviewedMigrationSources,
  verifyMigrationInventory,
  type MigrationSource,
} from '../../test/helpers/migration-inventory';
import { e4HistoricalMigrationPrefix } from '../../test/helpers/e4-migration-prefix';

const appended = {
  name: '20990101000000_registered_inventory_test',
  sha256: 'b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd',
};
const historicalEnd = '20261003000000_activity_contribution_settlement';
const frozenEnd = '20261031223000_r5_correction_set_materialization';

describe('reviewed migration inventory, without a database', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'srvf-migration-inventory-'));
    cpSync(resolve('prisma/migrations'), join(scratch, 'prisma/migrations'), {
      recursive: true,
    });
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it('qualifies the complete current set against the original byte-pinned historical catalog', () => {
    const current = currentMigrationInventory(scratch);
    const frozen = readFrozenMigrationCatalog().migrations;
    expect(frozen).toHaveLength(155);
    expect(historicalMigrationSources(current, frozenEnd)).toEqual(frozen);
    expect(historicalMigrationSources(current, historicalEnd)).toHaveLength(137);
    expect(current.migrations).toEqual(reviewedMigrationSources());
    expect(current.names).toEqual(current.migrations.map(({ name }) => name));
    expect(current.count).toBe(current.names.length);
    expect(Object.isFrozen(current.migrations)).toBe(true);
    expect(current.migrations.every(Object.isFrozen)).toBe(true);
    expect(() => historicalMigrationSources(current, '20990101000000_unknown')).toThrow();
  });

  it('accepts an explicitly registered append without changing either frozen historical prefix', () => {
    const before = currentMigrationInventory(scratch);
    const directory = join(scratch, 'prisma/migrations', appended.name);
    mkdirSync(directory);
    writeFileSync(join(directory, 'migration.sql'), 'SELECT 1;\n');
    const after = verifyMigrationInventory(scratch, [...reviewedMigrationSources(), appended]);
    expect(after.count).toBe(before.count + 1);
    expect(after.migrations.at(-1)).toEqual(appended);
    for (const end of [historicalEnd, frozenEnd])
      expect(historicalMigrationSources(after, end)).toEqual(
        historicalMigrationSources(before, end),
      );
    expect(e4HistoricalMigrationPrefix(after.names, after)).toEqual(
      e4HistoricalMigrationPrefix(before.names, before),
    );
    expect(() => currentMigrationInventory(scratch)).toThrow('MIGRATION_SOURCE_SET_CHANGED');
  });

  it.each([
    'unregistered append',
    'changed historical SQL',
    'changed successor SQL',
    'missing SQL',
    'missing directory',
    'renamed historical directory',
    'symlink SQL',
    'symlink directory',
  ])('rejects %s before exposing a current count', (kind) => {
    const sources = reviewedMigrationSources();
    const target = kind === 'changed successor SQL' ? sources.at(-1)! : sources[0];
    const directory = join(scratch, 'prisma/migrations', target.name);
    const sql = join(directory, 'migration.sql');
    if (kind === 'unregistered append')
      mkdirSync(join(scratch, 'prisma/migrations', appended.name));
    if (kind.startsWith('changed ')) writeFileSync(sql, 'SELECT 1;\n');
    if (kind === 'missing SQL') rmSync(sql);
    if (kind === 'missing directory') rmSync(directory, { recursive: true });
    if (kind === 'renamed historical directory')
      renameSync(directory, join(scratch, 'prisma/migrations', appended.name));
    if (kind === 'symlink SQL') {
      rmSync(sql);
      symlinkSync(resolve('prisma/migrations', target.name, 'migration.sql'), sql);
    }
    if (kind === 'symlink directory') {
      rmSync(directory, { recursive: true });
      symlinkSync(resolve('prisma/migrations', target.name), directory);
    }
    const error = kind.startsWith('changed ')
      ? 'MIGRATION_SOURCE_CHECKSUM_CHANGED'
      : kind === 'missing SQL'
        ? 'ENOENT'
        : kind === 'symlink SQL'
          ? 'MIGRATION_SOURCE_FILE_INVALID'
          : kind === 'symlink directory'
            ? 'MIGRATION_SOURCE_SYMLINK_REFUSED'
            : 'MIGRATION_SOURCE_SET_CHANGED';
    expect(() => currentMigrationInventory(scratch)).toThrow(error);
  });

  it.each([
    'empty',
    'duplicate',
    'out of order',
    'invalid checksum',
    'wrong checksum',
    'invalid name',
    'missing checksum',
    'extra field',
    'null entry',
  ])('rejects an independent reviewed list with %s', (kind) => {
    const sources: unknown[] = reviewedMigrationSources().map((source) => ({ ...source }));
    if (kind === 'empty') sources.length = 0;
    if (kind === 'duplicate') sources.splice(1, 0, sources[0]);
    if (kind === 'out of order') [sources[0], sources[1]] = [sources[1], sources[0]];
    if (kind === 'invalid checksum') sources[0] = { ...reviewedMigrationSources()[0], sha256: 'z' };
    if (kind === 'wrong checksum')
      sources[0] = { ...reviewedMigrationSources()[0], sha256: '0'.repeat(64) };
    if (kind === 'invalid name') sources[0] = { ...appended, name: '../outside' };
    if (kind === 'missing checksum') sources[0] = { name: reviewedMigrationSources()[0].name };
    if (kind === 'extra field') sources[0] = { ...reviewedMigrationSources()[0], ignored: true };
    if (kind === 'null entry') sources[0] = null;
    expect(() => verifyMigrationInventory(scratch, sources as MigrationSource[])).toThrow(
      kind === 'wrong checksum'
        ? 'MIGRATION_SOURCE_CHECKSUM_CHANGED'
        : 'MIGRATION_INVENTORY_INVALID',
    );
  });

  function python(code: string) {
    return spawnSync('python3', ['-B', '-c', code, scratch, resolve('test/helpers')], {
      encoding: 'utf8',
      timeout: 30_000,
    });
  }

  it('gives Python the identical validated sources and verifies the exact bytes before installation', () => {
    const result = python(`
import hashlib, json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[2])
from migration_inventory import verified_migration_sources, migration_install_sql
repo = Path(sys.argv[1])
print(json.dumps({'migrations': verified_migration_sources(repo),
                 'sqlSha256': hashlib.sha256(migration_install_sql(repo).encode()).hexdigest()}))
`);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const current = currentMigrationInventory(scratch);
    const sql = current.migrations
      .map(
        ({ name }) =>
          '\\echo ' +
          name +
          '\n' +
          readFileSync(join(scratch, 'prisma/migrations', name, 'migration.sql'), 'utf8'),
      )
      .join('\n');
    expect(JSON.parse(result.stdout)).toEqual({
      migrations: current.migrations,
      sqlSha256: createHash('sha256').update(sql).digest('hex'),
    });
  });

  it.each(['unregistered', 'changed'])(
    'refuses %s sources through the Python adapter too',
    (kind) => {
      if (kind === 'unregistered') mkdirSync(join(scratch, 'prisma/migrations', appended.name));
      else
        writeFileSync(
          join(scratch, 'prisma/migrations', reviewedMigrationSources()[0].name, 'migration.sql'),
          'SELECT 1;\n',
        );
      const result = python(`
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[2])
from migration_inventory import migration_install_sql
print(migration_install_sql(Path(sys.argv[1])))
`);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
    },
  );

  it('refuses a file changed after the shared validation but before Python builds SQL', () => {
    const result = python(`
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[2])
import migration_inventory as inventory
repo = Path(sys.argv[1])
original = inventory.verified_migration_sources
def changed(checkout):
    sources = original(checkout)
    (checkout / 'prisma/migrations' / sources[0]['name'] / 'migration.sql').write_text('SELECT 1;\\n')
    return sources
inventory.verified_migration_sources = changed
print(inventory.migration_install_sql(repo))
`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('MIGRATION_SOURCE_CHECKSUM_CHANGED');
    expect(result.stdout).toBe('');
  });
});
