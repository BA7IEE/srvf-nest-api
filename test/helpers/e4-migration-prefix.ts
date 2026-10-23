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

export const E4_MIGRATION_146 = '20261015221000_activity_contribution_policy_band_planning';

export const E4_MIGRATION_147 =
  '20261018000000_activity_contribution_correction_source_hash_required';

export const E4_MIGRATION_148 = '20261019184200_activity_source_hash_envelope_fast_path';

export const E4_MIGRATION_149 = '20261020032500_activity_canonical_json_singleton_fast_paths';

export const E4_MIGRATION_150 = '20261020070354_activity_source_proof_array_length_count';

export const E4_MIGRATION_151 = '20261020202600_activity_bucket_hash_grouped_sources';

export const E4_MIGRATION_152 = '20261021061000_activity_source_proof_narrow_projection';

export function e4HistoricalMigrationPrefix(names: readonly string[]): string[] {
  const ordered = [...names].sort();
  if (
    ordered.length !== 152 ||
    ordered[136] !== E4_MIGRATION_137 ||
    ordered[137] !== E4_MIGRATION_138 ||
    ordered[138] !== E4_MIGRATION_139 ||
    ordered[139] !== E4_MIGRATION_140 ||
    ordered[140] !== E4_MIGRATION_141 ||
    ordered[141] !== E4_MIGRATION_142 ||
    ordered[142] !== E4_MIGRATION_143 ||
    ordered[143] !== E4_MIGRATION_144 ||
    ordered[144] !== E4_MIGRATION_145 ||
    ordered[145] !== E4_MIGRATION_146 ||
    ordered[146] !== E4_MIGRATION_147 ||
    ordered[147] !== E4_MIGRATION_148 ||
    ordered[148] !== E4_MIGRATION_149 ||
    ordered[149] !== E4_MIGRATION_150 ||
    ordered[150] !== E4_MIGRATION_151 ||
    ordered[151] !== E4_MIGRATION_152
  )
    throw new Error(
      'E4 fixed 137 prefix or explicit 138/139/140/141/142/143/144/145/146/147/148/149/150/151/152 successors changed',
    );
  return ordered.slice(0, 137);
}
