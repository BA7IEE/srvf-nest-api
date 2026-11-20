import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface MigrationSource {
  readonly name: string;
  readonly sha256: string;
}

interface FrozenSourceCatalog {
  readonly migrations: readonly MigrationSource[];
  readonly catalogs: { readonly base: unknown; readonly supplemental: unknown };
}

export interface MigrationInventory {
  readonly migrations: readonly MigrationSource[];
  readonly names: readonly string[];
  readonly count: number;
}

const checkoutRoot = resolve(__dirname, '../..');
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');

export const MILESTONE_MIGRATION = Object.freeze({
  name: '20261117190000_team_join_contribution_milestones',
  sha256: '5c2aae1c4e6d83d8a06989761c52c77c6efaab3bdbec73d9e7b6a79bbaffb39d',
});
const SETTLEMENT_GUARD_MIGRATION = Object.freeze({
  name: '20261120073000_settlement_deferred_correction_guard',
  sha256: '38867d6ba7ebf72a2ca652c064bdbe8ffc674fba8c3b56d292d806cba1183d82',
});
const successors: readonly MigrationSource[] = Object.freeze([
  MILESTONE_MIGRATION,
  SETTLEMENT_GUARD_MIGRATION,
]);

// This large fixture is runtime data, not a giant inferred TypeScript literal.
// Pin all bytes before parsing; no fields or checks are omitted at runtime.
export function readFrozenMigrationCatalog(): FrozenSourceCatalog {
  const bytes = readFileSync(resolve(__dirname, '../fixtures/r5-ci-source-catalog.json'));
  if (sha(bytes) !== '341f429157b559913cb9ff22ff09e2ff820589b038d9f5f8243dd030677cbaa6')
    throw new Error('R5_CI_SOURCE_CATALOG_BYTES_CHANGED');
  return JSON.parse(bytes.toString('utf8')) as FrozenSourceCatalog;
}

export function reviewedMigrationSources(): readonly MigrationSource[] {
  return [...readFrozenMigrationCatalog().migrations, ...successors];
}

function isMigrationSource(source: unknown): source is MigrationSource {
  return (
    source !== null &&
    typeof source === 'object' &&
    Object.keys(source).sort().join(',') === 'name,sha256' &&
    'name' in source &&
    typeof source.name === 'string' &&
    /^[0-9]{14}_[a-z0-9_]+$/.test(source.name) &&
    'sha256' in source &&
    typeof source.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(source.sha256)
  );
}

export function verifyMigrationInventory(
  checkout: string,
  reviewed: readonly MigrationSource[],
): MigrationInventory {
  const rows: readonly unknown[] = reviewed;
  if (!Array.isArray(reviewed) || reviewed.length === 0)
    throw new Error('MIGRATION_INVENTORY_INVALID');
  const sources: MigrationSource[] = [];
  for (const source of rows) {
    if (
      !isMigrationSource(source) ||
      (sources.length > 0 && sources[sources.length - 1].name >= source.name)
    )
      throw new Error('MIGRATION_INVENTORY_INVALID');
    sources.push(source);
  }

  const directory = resolve(checkout, 'prisma/migrations');
  if (!lstatSync(directory).isDirectory()) throw new Error('MIGRATION_SOURCE_DIRECTORY_INVALID');
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink()))
    throw new Error('MIGRATION_SOURCE_SYMLINK_REFUSED');
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (names.length !== sources.length || names.some((name, index) => name !== sources[index].name))
    throw new Error('MIGRATION_SOURCE_SET_CHANGED');
  for (const source of sources) {
    const path = resolve(directory, source.name, 'migration.sql');
    if (!lstatSync(path).isFile()) throw new Error('MIGRATION_SOURCE_FILE_INVALID');
    if (sha(readFileSync(path)) !== source.sha256)
      throw new Error('MIGRATION_SOURCE_CHECKSUM_CHANGED');
  }
  const migrations = Object.freeze(sources.map((source) => Object.freeze({ ...source })));
  return Object.freeze({ migrations, names: Object.freeze(names), count: migrations.length });
}

export function currentMigrationInventory(checkout = checkoutRoot): MigrationInventory {
  return verifyMigrationInventory(checkout, reviewedMigrationSources());
}

export function historicalMigrationSources(
  inventory: MigrationInventory,
  end: string,
): readonly MigrationSource[] {
  const index = inventory.names.indexOf(end);
  if (index < 0) throw new Error('MIGRATION_HISTORICAL_ENDPOINT_MISSING');
  return Object.freeze(inventory.migrations.slice(0, index + 1));
}

if (require.main === module)
  process.stdout.write(JSON.stringify(currentMigrationInventory(process.argv[2] ?? checkoutRoot)));
