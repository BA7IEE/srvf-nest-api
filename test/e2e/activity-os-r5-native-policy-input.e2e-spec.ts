import { parseContributionPolicyDefinition } from '../../src/modules/activities/activity-contribution-policy-definition';
import {
  assertNativeContributionLaunchJson as launchJson,
  assertNativeContributionLaunchPolicies as launchPolicies,
  assertNativeContributionLaunchSpans as launchSpans,
} from '../../src/modules/activities/activity-contribution-launch-policy';
import { ContributionSettlementPolicyError } from '../../src/modules/activities/activity-contribution-settlement-policy';
import { nativeLaunchAdmissionPolicies } from '../helpers/native-launch-live.fixture';

// Offline counterexample inputs only; this suite does not prove a live admission or COMMIT.
describe('native launch minimal lawful counterexample inputs', () => {
  it('accepts the closed schema but rejects three bands with only one role/category', () => {
    const definition = nativeLaunchAdmissionPolicies().shape;
    expect(() => parseContributionPolicyDefinition(definition)).not.toThrow();
    expect(Buffer.byteLength(JSON.stringify(definition), 'utf8')).toBe(439);
    expect(definition.roleRules).toHaveLength(1);
    expect(definition.roleRules[0].categoryRules).toHaveLength(1);
    expect(definition.roleRules[0].categoryRules[0].durationBands).toHaveLength(3);
    expect(() => launchJson(definition, 'policyBytes')).not.toThrow();
    expect(() => launchPolicies([{ definitionJson: definition }])).toThrow(
      new ContributionSettlementPolicyError('scale_limit'),
    );
  });

  it('accepts four categories with sixteen bands each under the old closed schema, but exceeds8192 bytes', () => {
    const definition = nativeLaunchAdmissionPolicies().bytes;
    expect(() => parseContributionPolicyDefinition(definition)).not.toThrow();
    expect(Buffer.byteLength(JSON.stringify(definition), 'utf8')).toBe(9218);
    expect(definition.roleRules).toHaveLength(1);
    expect(definition.roleRules[0].categoryRules).toHaveLength(4);
    expect(
      definition.roleRules[0].categoryRules.every((row) => row.durationBands.length === 16),
    ).toBe(true);
    expect(() => launchJson(definition, 'policyBytes')).toThrow(
      new ContributionSettlementPolicyError('scale_limit'),
    );
    expect(() => launchPolicies([{ definitionJson: definition }])).toThrow(
      new ContributionSettlementPolicyError('scale_limit'),
    );
  });

  it('admits short manual slices but rejects the complete three-Beijing-day source span', () => {
    const startsAt = new Date('2020-03-01T08:00:00.000Z');
    const shortStart = new Date('2020-03-03T08:00:00.000Z');
    const endsAt = new Date(shortStart.getTime() + 20_000);
    expect(() => launchSpans([{ startsAt: shortStart, endsAt }])).not.toThrow();
    expect(() => launchSpans([{ startsAt, endsAt }])).toThrow(
      new ContributionSettlementPolicyError('scale_limit'),
    );
  });
});
