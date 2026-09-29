import { LEGACY_ACTIVITY_TYPE_MIGRATION_REGISTRY } from './activity-type-migration.registry';
import {
  assertLegacyContributionTypeSigned,
  getLegacyContributionMappingDecision,
  LEGACY_CONTRIBUTION_MAPPING_HOLDS,
} from './activity-contribution-rule-conversion.mapping';

describe('E2 legacy contribution mapping gate', () => {
  it('holds every one of the 31 frozen real activity types', () => {
    expect(LEGACY_CONTRIBUTION_MAPPING_HOLDS).toHaveLength(31);
    expect(new Set(LEGACY_CONTRIBUTION_MAPPING_HOLDS).size).toBe(31);
    expect(LEGACY_CONTRIBUTION_MAPPING_HOLDS).toEqual(
      LEGACY_ACTIVITY_TYPE_MIGRATION_REGISTRY.map((entry) => entry.legacyActivityTypeCode),
    );
    for (const activityTypeCode of LEGACY_CONTRIBUTION_MAPPING_HOLDS) {
      expect(getLegacyContributionMappingDecision(activityTypeCode)).toBe('hold');
      expect(() => assertLegacyContributionTypeSigned(activityTypeCode)).toThrow('hold');
    }
  });

  it('also rejects unknown and synthetic types as unsigned in the production gate', () => {
    expect(getLegacyContributionMappingDecision('fixture_only')).toBe('unknown');
    expect(() => assertLegacyContributionTypeSigned('fixture_only')).toThrow('unknown');
  });
});
