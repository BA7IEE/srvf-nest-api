/** The immutable E4 evidence targets migration 137, even after 138 is appended. */
export const E4_MIGRATION_137 = '20261003000000_activity_contribution_settlement';
export const E4_MIGRATION_138 = '20261012000000_activity_canonical_json_scalar_fast_path';

export function e4HistoricalMigrationPrefix(names: readonly string[]): string[] {
  const ordered = [...names].sort();
  if (
    ordered.length !== 138 ||
    ordered[136] !== E4_MIGRATION_137 ||
    ordered[137] !== E4_MIGRATION_138
  )
    throw new Error('E4 fixed 137 prefix or explicit 138 successor changed');
  return ordered.slice(0, 137);
}
