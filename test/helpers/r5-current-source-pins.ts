import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { r5CiMigrationSources } from './r5-ci-source-binding';

/** Expected definitions come from frozen migration bytes, never the installed catalog. */
export function r5CurrentE4SourcePins() {
  const migrations = r5CiMigrationSources();
  const source = migrations.find(
    (migration) => migration.name === '20261031223000_r5_correction_set_materialization',
  );
  if (!source || migrations.length !== 155) throw new Error('R5_CURRENT_MIGRATION_SET_CHANGED');
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
  return { count: migrations.length, pin: createHash('md5').update(matches[0][2]).digest('hex') };
}

/** Complete frozen physical table set; the migration ledger is the only exclusion. */
export function r5CurrentBusinessTableNames(profile: 'current155' | 'pre155' = 'current155') {
  const bytes = readFileSync(resolve(__dirname, 'r5-setmat-table-manifest.json'));
  if (
    createHash('sha256').update(bytes).digest('hex') !==
    '763ed265939d4a5e4e6e2ea218559f1458a8c25e265ca9d70b9bd3c5a97a1742'
  )
    throw new Error('R5_CURRENT_TABLE_MANIFEST_CHANGED');
  const manifest = JSON.parse(bytes.toString('utf8')) as { tables: string[] };
  const names = manifest.tables.filter((name) => name !== '_prisma_migrations').sort();
  if (profile === 'current155') return names;
  if (profile !== 'pre155') throw new Error('R5_TABLE_PROFILE_REFUSED');
  r5CurrentE4SourcePins(); // qualify the migration that introduces exactly these tables
  return names.filter(
    (name) => !['CorrectionWritePhase', 'CorrectionApprovedInputItem'].includes(name),
  );
}
