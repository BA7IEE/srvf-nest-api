import type { TimePolicyVersion } from '@prisma/client';
import { fingerprintTimePolicyVersion } from './activity-time-policy-definition';
import {
  presentTimePolicy,
  presentTimePolicyVersion,
  presentTimePolicyVersionSummary,
} from './activity-time-policy-presenter';

const definition = {
  defaultCategory: 'volunteer_service',
  roleMappings: [],
  allowSplit: false,
  specialIntervals: {
    preparation: { mode: 'exclude' },
    duty: { mode: 'exclude' },
    travel: { mode: 'exclude' },
  },
  rounding: { mode: 'floor', quantumSeconds: 1 },
  evidence: { requiredSources: [], requireManualRecognition: false },
  manualAdjustment: { enabled: false },
};
const date = new Date('2026-01-01T00:00:00.000Z');
const document = fingerprintTimePolicyVersion({
  schemaVersion: 1,
  evaluatorVersion: 1,
  definition,
  effectiveFrom: date.toISOString(),
  effectiveUntil: null,
});
const row: TimePolicyVersion = {
  id: 'version',
  policyId: 'policy',
  version: 1,
  schemaVersion: 1,
  evaluatorVersion: 1,
  definitionHash: document.definitionHash,
  definitionJson: { ...document.definition },
  effectiveFrom: date,
  effectiveUntil: null,
  statusCode: 'retired',
  activatedAt: date,
  retiredAt: date,
  createdAt: date,
  updatedAt: date,
};
describe('D1-2 explicit presenters', () => {
  it('returns only policy fields and UTC times', () => {
    expect(
      presentTimePolicy({
        id: 'policy',
        code: 'policy',
        name: 'Policy',
        createdAt: date,
        updatedAt: date,
      }),
    ).toEqual({
      id: 'policy',
      code: 'policy',
      name: 'Policy',
      createdAt: date.toISOString(),
      updatedAt: date.toISOString(),
    });
  });
  it('keeps summaries small, but returns verified historical definition in details', () => {
    expect(presentTimePolicyVersionSummary(row)).not.toHaveProperty('definitionJson');
    expect(presentTimePolicyVersionSummary(row)).not.toHaveProperty('definition');
    expect(presentTimePolicyVersion(row).definition).toEqual(document.definition);
    expect(presentTimePolicyVersion(row).statusCode).toBe('retired');
  });
  it('rejects mismatched stored hash instead of presenting corrupt data', () => {
    expect(() => presentTimePolicyVersion({ ...row, definitionHash: 'a'.repeat(64) })).toThrow();
  });
});
