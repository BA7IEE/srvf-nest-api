import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { currentMigrationInventory, MILESTONE_MIGRATION } from './migration-inventory';

export type TestTableProfile = 'current' | 'current155' | 'pre155';
export interface FixtureTruncateTrigger {
  readonly table: string;
  readonly trigger: string;
}
export interface CurrentTestTablePolicy {
  readonly table: string;
  readonly sourceMigration: string;
  readonly profiles: readonly ['current'];
  readonly rollback: 'all-rows-and-columns';
  readonly cleanup: {
    readonly cascadeFrom: string;
    readonly truncateTrigger: string;
  };
}

// Additive only: the frozen manifest and historical profiles never grow here.
export const CURRENT_TEST_TABLE_POLICIES: readonly CurrentTestTablePolicy[] = Object.freeze([
  Object.freeze({
    table: 'TeamJoinContributionMilestone',
    sourceMigration: MILESTONE_MIGRATION.name,
    profiles: Object.freeze(['current'] as const),
    rollback: 'all-rows-and-columns' as const,
    cleanup: Object.freeze({
      cascadeFrom: 'team_join_applications',
      truncateTrigger: 'team_join_milestone_no_truncate',
    }),
  }),
]);

export function frozenTestTableManifest() {
  const bytes = readFileSync(resolve(__dirname, 'r5-setmat-table-manifest.json'));
  if (
    createHash('sha256').update(bytes).digest('hex') !==
    '763ed265939d4a5e4e6e2ea218559f1458a8c25e265ca9d70b9bd3c5a97a1742'
  )
    throw new Error('R5_CURRENT_TABLE_MANIFEST_CHANGED');
  return JSON.parse(bytes.toString('utf8')) as {
    tables: string[];
    sourceSchemaSha256: string;
  };
}

function fields(value: unknown, keys: string): value is Record<string, unknown> {
  return (
    value !== null && typeof value === 'object' && Object.keys(value).sort().join(',') === keys
  );
}
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);

/** Validate explicit declarations, not a catalog-discovered cleanup plan. */
export function assertCurrentTestTablePolicies(policies: readonly unknown[]): void {
  if (!Array.isArray(policies) || policies.length === 0)
    throw new Error('TEST_TABLE_POLICY_INVALID');
  const frozen = frozenTestTableManifest().tables;
  const migrations = currentMigrationInventory().names;
  const seen = new Set<string>();
  for (const policy of policies as readonly unknown[]) {
    if (
      !fields(policy, 'cleanup,profiles,rollback,sourceMigration,table') ||
      !identifier(policy.table) ||
      frozen.includes(policy.table) ||
      seen.has(policy.table) ||
      typeof policy.sourceMigration !== 'string' ||
      !migrations.includes(policy.sourceMigration) ||
      !Array.isArray(policy.profiles) ||
      policy.profiles.length !== 1 ||
      policy.profiles[0] !== 'current' ||
      policy.rollback !== 'all-rows-and-columns' ||
      !fields(policy.cleanup, 'cascadeFrom,truncateTrigger') ||
      !identifier(policy.cleanup.cascadeFrom) ||
      policy.cleanup.cascadeFrom === '_prisma_migrations' ||
      !frozen.includes(policy.cleanup.cascadeFrom) ||
      !identifier(policy.cleanup.truncateTrigger)
    )
      throw new Error('TEST_TABLE_POLICY_INVALID');
    seen.add(policy.table);
  }
}

/** Migration bookkeeping is included here; business fingerprints exclude it explicitly. */
export function testTableNames(profile: TestTableProfile = 'current'): string[] {
  const names = frozenTestTableManifest().tables;
  if (profile === 'current155') return [...names].sort();
  if (profile === 'pre155')
    return names
      .filter((name) => !['CorrectionWritePhase', 'CorrectionApprovedInputItem'].includes(name))
      .sort();
  if (profile !== 'current') throw new Error('R5_TABLE_PROFILE_REFUSED');
  assertCurrentTestTablePolicies(CURRENT_TEST_TABLE_POLICIES);
  return [...names, ...CURRENT_TEST_TABLE_POLICIES.map(({ table }) => table)].sort();
}

export function assertTestTableManifest(
  actual: readonly string[],
  profile: TestTableProfile = 'current',
): void {
  assert.equal(new Set(actual).size, actual.length, 'duplicate table names are invalid');
  assert.deepEqual([...actual].sort(), testTableNames(profile));
}

/** This validates the fixed descriptor; it never authorizes caller-supplied identifiers. */
export function assertFixtureTruncateTriggers(triggers: readonly unknown[]): void {
  const names = new Set([
    ...frozenTestTableManifest().tables,
    ...CURRENT_TEST_TABLE_POLICIES.map(({ table }) => table),
  ]);
  if (!Array.isArray(triggers) || triggers.length === 0)
    throw new Error('FIXTURE_TRIGGER_POLICY_INVALID');
  const tables = new Set<string>();
  const triggerNames = new Set<string>();
  for (const pair of triggers as readonly unknown[]) {
    if (
      !fields(pair, 'table,trigger') ||
      !identifier(pair.table) ||
      pair.table === '_prisma_migrations' ||
      !names.has(pair.table) ||
      !identifier(pair.trigger) ||
      tables.has(pair.table) ||
      triggerNames.has(pair.trigger)
    )
      throw new Error('FIXTURE_TRIGGER_POLICY_INVALID');
    tables.add(pair.table);
    triggerNames.add(pair.trigger);
  }
  for (const { table, cleanup } of CURRENT_TEST_TABLE_POLICIES) {
    if (
      !triggers.some(
        (pair) =>
          fields(pair, 'table,trigger') &&
          pair.table === table &&
          pair.trigger === cleanup.truncateTrigger,
      )
    )
      throw new Error('FIXTURE_TRIGGER_POLICY_MISSING');
  }
}
