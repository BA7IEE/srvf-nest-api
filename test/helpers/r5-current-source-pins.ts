import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { currentMigrationInventory } from './migration-inventory';
import { testTableNames } from './test-table-policy';

/** Expected definitions come from frozen migration bytes, never the installed catalog. */
export function r5CurrentE4SourcePins() {
  const { migrations, count } = currentMigrationInventory();
  const source = migrations.find(
    (migration) => migration.name === '20261031223000_r5_correction_set_materialization',
  );
  if (!source) throw new Error('R5_CURRENT_MIGRATION_SET_CHANGED');
  const bytes = readFileSync(
    resolve(__dirname, '../../prisma/migrations', source.name, 'migration.sql'),
  );
  if (createHash('sha256').update(bytes).digest('hex') !== source.sha256)
    throw new Error('R5_CURRENT_E4_SOURCE_CHANGED');
  const matches = [
    ...bytes
      .toString('utf8')
      .matchAll(
        /^CREATE (?:OR REPLACE )?FUNCTION public\.e4_assert_complete\([^]*?\bAS (\$[A-Za-z0-9_]*\$)([^]*?)\1;/gmu,
      ),
  ];
  if (matches.length !== 1) throw new Error('R5_CURRENT_E4_DEFINITION_AMBIGUOUS');
  return { count, pin: createHash('md5').update(matches[0][2]).digest('hex') };
}

/** Business physical table set per approved profile; the migration ledger is excluded. */
export function r5CurrentBusinessTableNames(
  profile: 'current' | 'current155' | 'pre155' = 'current',
) {
  if (profile !== 'current155') r5CurrentE4SourcePins();
  return testTableNames(profile).filter((name) => name !== '_prisma_migrations');
}
