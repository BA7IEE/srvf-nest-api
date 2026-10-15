/** Immutable E4 evidence stays at 137; explicit scalar/reference/evaluation successors stay pinned. */
export const E4_MIGRATION_137 = '20261003000000_activity_contribution_settlement';
export const E4_MIGRATION_138 = '20261012000000_activity_canonical_json_scalar_fast_path';
export const E4_MIGRATION_139 =
  '20261012010000_activity_contribution_reference_canonical_fast_path';

export const E4_MIGRATION_140 =
  '20261012020000_activity_contribution_evaluation_canonical_fast_path';

export const E4_MIGRATION_141 = '20261012030000_activity_time_bucket_canonical_fast_path';

export const E4_MIGRATION_142 = '20261012040000_activity_canonical_json_unit_fast_path';

export const E4_MIGRATION_143 = '20261013000000_activity_contribution_assert_source_reuse';
export const E4_MIGRATION_144 = '20261015000000_activity_contribution_source_bucket_lateral';

export const E4_MIGRATION_145 = '20261015010000_activity_contribution_evaluation_join_key';

export function e4HistoricalMigrationPrefix(names: readonly string[]): string[] {
  const ordered = [...names].sort();
  if (
    ordered.length !== 145 ||
    ordered[136] !== E4_MIGRATION_137 ||
    ordered[137] !== E4_MIGRATION_138 ||
    ordered[138] !== E4_MIGRATION_139 ||
    ordered[139] !== E4_MIGRATION_140 ||
    ordered[140] !== E4_MIGRATION_141 ||
    ordered[141] !== E4_MIGRATION_142 ||
    ordered[142] !== E4_MIGRATION_143 ||
    ordered[143] !== E4_MIGRATION_144 ||
    ordered[144] !== E4_MIGRATION_145
  )
    throw new Error(
      'E4 fixed 137 prefix or explicit 138/139/140/141/142/143/144/145 successors changed',
    );
  return ordered.slice(0, 137);
}
