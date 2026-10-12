/** Immutable E4 evidence stays at 137; scalar and reference upgrades pin 138 and 139. */
export const E4_MIGRATION_137 = '20261003000000_activity_contribution_settlement';
export const E4_MIGRATION_138 = '20261012000000_activity_canonical_json_scalar_fast_path';
export const E4_MIGRATION_139 =
  '20261012010000_activity_contribution_reference_canonical_fast_path';

export function e4HistoricalMigrationPrefix(names: readonly string[]): string[] {
  const ordered = [...names].sort();
  if (
    ordered.length !== 139 ||
    ordered[136] !== E4_MIGRATION_137 ||
    ordered[137] !== E4_MIGRATION_138 ||
    ordered[138] !== E4_MIGRATION_139
  )
    throw new Error('E4 fixed 137 prefix or explicit 138/139 successors changed');
  return ordered.slice(0, 137);
}
