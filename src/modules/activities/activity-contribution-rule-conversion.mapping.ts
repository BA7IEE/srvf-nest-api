import { LEGACY_ACTIVITY_TYPE_MIGRATION_REGISTRY } from './activity-type-migration.registry';

/** The activity-type directory is an index, never an E1 contribution mapping approval. */
export const LEGACY_CONTRIBUTION_MAPPING_HOLDS = Object.freeze(
  LEGACY_ACTIVITY_TYPE_MIGRATION_REGISTRY.map((entry) => entry.legacyActivityTypeCode),
);

const heldTypes = new Set<string>(LEGACY_CONTRIBUTION_MAPPING_HOLDS);

export type LegacyContributionMappingDecision = 'hold' | 'unknown';

/** No real legacy type is signed for conversion in the first-layer E2 capability. */
export function getLegacyContributionMappingDecision(
  activityTypeCode: string,
): LegacyContributionMappingDecision {
  return heldTypes.has(activityTypeCode) ? 'hold' : 'unknown';
}

/** Fail closed even if a caller confuses a frozen directory selector with approval. */
export function assertLegacyContributionTypeSigned(activityTypeCode: string): never {
  const decision = getLegacyContributionMappingDecision(activityTypeCode);
  throw new TypeError(`Legacy contribution mapping ${decision}: ${activityTypeCode}`);
}
