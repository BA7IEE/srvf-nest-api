import type { ContributionPolicyVersion, Prisma } from '@prisma/client';
import { fingerprintContributionPolicyVersion } from './activity-contribution-policy-definition';
import {
  presentContributionPolicy,
  presentContributionPolicyVersion,
  presentContributionPolicyVersionSummary,
} from './activity-contribution-policy-presenter';

const definition = {
  defaultResult: { recognizedPoints: '0.00', explanationCode: 'default_zero' },
  roleRules: [],
};
const date = new Date('2026-01-01T00:00:00.000Z');
const document = fingerprintContributionPolicyVersion({
  schemaVersion: 1,
  evaluatorVersion: 1,
  definition,
  effectiveFrom: date.toISOString(),
  effectiveUntil: null,
});
const row: ContributionPolicyVersion = {
  id: 'version',
  policyId: 'policy',
  version: 1,
  schemaVersion: 1,
  evaluatorVersion: 1,
  definitionHash: document.definitionHash,
  definitionJson: { ...document.definition } as unknown as Prisma.JsonValue,
  effectiveFrom: date,
  effectiveUntil: null,
  statusCode: 'retired',
  createdByUserId: 'creator',
  activatedByUserId: 'activator',
  retiredByUserId: 'retirer',
  activatedAt: date,
  retiredAt: date,
  createdAt: date,
  updatedAt: date,
};
describe('D1-2 explicit presenters', () => {
  it('returns only policy fields and UTC times', () => {
    expect(
      presentContributionPolicy({
        id: 'policy',
        code: 'policy',
        name: 'Policy',
        description: 'Description',
        createdAt: date,
        updatedAt: date,
      }),
    ).toEqual({
      id: 'policy',
      code: 'policy',
      name: 'Policy',
      description: 'Description',
      createdAt: date.toISOString(),
      updatedAt: date.toISOString(),
    });
  });
  it('keeps summaries small, but returns verified historical definition in details', () => {
    expect(presentContributionPolicyVersionSummary(row)).not.toHaveProperty('definitionJson');
    expect(presentContributionPolicyVersionSummary(row)).not.toHaveProperty('definition');
    expect(presentContributionPolicyVersionSummary(row)).not.toHaveProperty('createdByUserId');
    expect(presentContributionPolicyVersionSummary(row)).not.toHaveProperty('activatedByUserId');
    expect(presentContributionPolicyVersionSummary(row)).not.toHaveProperty('retiredByUserId');
    expect(presentContributionPolicyVersion(row).definition).toEqual(document.definition);
    expect(presentContributionPolicyVersion(row).statusCode).toBe('retired');
  });
  it('rejects mismatched stored hash instead of presenting corrupt data', () => {
    expect(() =>
      presentContributionPolicyVersion({ ...row, definitionHash: 'a'.repeat(64) }),
    ).toThrow();
  });
});
