import {
  canonicalizeActivityTemplateDefinition,
  computeActivityTemplateDefinitionHash,
} from './activity-template-definition';
import {
  fingerprintTimePolicyVersion,
  parseTimePolicyDefinition,
  parseTimePolicyVersionReference,
} from './activity-time-policy-definition';

function definition() {
  return {
    defaultCategory: 'volunteer_service',
    roleMappings: [],
    allowSplit: false,
    specialIntervals: {
      preparation: { mode: 'exclude' },
      duty: { mode: 'category', category: 'organization' },
      travel: { mode: 'exclude' },
    },
    rounding: { mode: 'floor', quantumSeconds: 1 },
    evidence: { requiredSources: ['service_segment'], requireManualRecognition: false },
    manualAdjustment: { enabled: false },
  };
}
function version() {
  return {
    schemaVersion: 1,
    evaluatorVersion: 1,
    definition: definition(),
    effectiveFrom: '2099-09-10T00:00:00.000Z',
    effectiveUntil: null,
  };
}

describe('time policy definition v1', () => {
  it.each(['volunteer_service', 'training', 'organization', 'non_creditable'])(
    'accepts category %s',
    (defaultCategory) => {
      expect(parseTimePolicyDefinition({ ...definition(), defaultCategory }).defaultCategory).toBe(
        defaultCategory,
      );
    },
  );
  it('copies input without mutating its role or source ordering', () => {
    const input = {
      ...definition(),
      roleMappings: [
        { attendanceRoleCode: 'z', category: 'training' },
        { attendanceRoleCode: 'a', category: 'organization' },
      ],
      evidence: { requiredSources: ['attachment', 'punch_event'], requireManualRecognition: false },
    };
    const before = JSON.stringify(input);
    const result = parseTimePolicyDefinition(input);
    expect(result.roleMappings.map((r) => r.attendanceRoleCode)).toEqual(['a', 'z']);
    expect(result.evidence.requiredSources).toEqual(['punch_event', 'attachment']);
    expect(JSON.stringify(input)).toBe(before);
  });
  it('accepts 64 mappings and rejects 65', () => {
    const roleMappings = Array.from({ length: 64 }, (_, i) => ({
      attendanceRoleCode: `r${i}`,
      category: 'training',
    }));
    expect(parseTimePolicyDefinition({ ...definition(), roleMappings }).roleMappings).toHaveLength(
      64,
    );
    expect(() =>
      parseTimePolicyDefinition({
        ...definition(),
        roleMappings: [...roleMappings, { attendanceRoleCode: 'extra', category: 'training' }],
      }),
    ).toThrow();
  });
  it('requires explicit manual permission for manual intervals and evidence recognition', () => {
    const specialIntervals = { ...definition().specialIntervals, travel: { mode: 'manual' } };
    expect(() => parseTimePolicyDefinition({ ...definition(), specialIntervals })).toThrow();
    expect(
      parseTimePolicyDefinition({
        ...definition(),
        specialIntervals,
        manualAdjustment: { enabled: true, reasonRequired: true, evidenceRequired: false },
      }).specialIntervals.travel,
    ).toEqual({ mode: 'manual' });
    expect(() =>
      parseTimePolicyDefinition({
        ...definition(),
        evidence: { requiredSources: [], requireManualRecognition: true },
      }),
    ).toThrow();
  });
  it.each([0, -1, 1.5, 3601, NaN, Infinity])('rejects invalid quantum %s', (quantumSeconds) => {
    expect(() =>
      parseTimePolicyDefinition({ ...definition(), rounding: { mode: 'floor', quantumSeconds } }),
    ).toThrow();
  });
  it.each([1, 3600])('accepts quantum boundary %s', (quantumSeconds) => {
    expect(
      parseTimePolicyDefinition({ ...definition(), rounding: { mode: 'floor', quantumSeconds } })
        .rounding.quantumSeconds,
    ).toBe(quantumSeconds);
  });
  it.each([
    { defaultCategory: 'legacy_unclassified' },
    { allowSplit: null },
    { unknown: true },
    {
      roleMappings: [
        { attendanceRoleCode: 'a', category: 'training' },
        { attendanceRoleCode: 'a', category: 'organization' },
      ],
    },
    { roleMappings: [{ attendanceRoleCode: ' a', category: 'training' }] },
    { roleMappings: [{ attendanceRoleCode: 'a\n', category: 'training' }] },
    {
      evidence: { requiredSources: ['attachment', 'attachment'], requireManualRecognition: false },
    },
    { evidence: { requiredSources: ['unknown'], requireManualRecognition: false } },
    { manualAdjustment: { enabled: false, reasonRequired: true } },
    { manualAdjustment: { enabled: true, reasonRequired: false, evidenceRequired: true } },
  ])('rejects malformed definition %j', (patch) => {
    expect(() => parseTimePolicyDefinition({ ...definition(), ...patch })).toThrow();
  });
  it('rejects getters without invoking them, cycles and sparse arrays', () => {
    const getter = jest.fn();
    const input = definition();
    Object.defineProperty(input, 'defaultCategory', { get: getter, enumerable: true });
    expect(() => parseTimePolicyDefinition(input)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const cyclic: Record<string, unknown> = definition();
    cyclic.roleMappings = [cyclic];
    expect(() => parseTimePolicyDefinition(cyclic)).toThrow();
    expect(() =>
      parseTimePolicyDefinition({ ...definition(), roleMappings: new Array(2) }),
    ).toThrow();
    expect(() => parseTimePolicyDefinition(new Date())).toThrow();
  });
  it('accepts maximum valid multibyte mappings within canonical byte budget', () => {
    const roleMappings = Array.from({ length: 64 }, (_, i) => ({
      attendanceRoleCode: `${i}`.padEnd(64, '中'),
      category: 'organization',
    }));
    const input = { ...definition(), roleMappings };
    expect(Buffer.byteLength(canonicalizeActivityTemplateDefinition(input))).toBeLessThanOrEqual(
      32768,
    );
    expect(parseTimePolicyDefinition(input).roleMappings).toHaveLength(64);
    expect(() => parseTimePolicyDefinition({ ...input, extra: '中'.repeat(32768) })).toThrow();
  });
});

describe('time policy version fingerprint and reference', () => {
  it('reuses canonical hash with explicit envelope', () => {
    const result = fingerprintTimePolicyVersion(version());
    const { definitionHash, schemaVersion, ...envelope } = result;
    expect(definitionHash).toBe(
      computeActivityTemplateDefinitionHash({ schemaVersion, definition: envelope }),
    );
    expect(
      fingerprintTimePolicyVersion({ ...version(), effectiveFrom: '2099-09-11T00:00:00.000Z' })
        .definitionHash,
    ).not.toBe(definitionHash);
  });
  it('normalizes equivalent mapping/source permutations', () => {
    const a = {
      ...version(),
      definition: {
        ...definition(),
        roleMappings: [
          { attendanceRoleCode: 'z', category: 'training' },
          { attendanceRoleCode: 'a', category: 'organization' },
        ],
      },
    };
    const b = {
      ...a,
      definition: { ...a.definition, roleMappings: [...a.definition.roleMappings].reverse() },
    };
    expect(fingerprintTimePolicyVersion(a).definitionHash).toBe(
      fingerprintTimePolicyVersion(b).definitionHash,
    );
  });
  it.each([
    { schemaVersion: 2 },
    { evaluatorVersion: 2 },
    { effectiveFrom: '2099-02-30T00:00:00.000Z' },
    { effectiveFrom: '2099-09-10T00:00:00Z' },
    { effectiveFrom: '2099-09-10T08:00:00.000+08:00' },
    { effectiveUntil: '2099-09-10T00:00:00.000Z' },
    { effectiveUntil: '2099-09-09T00:00:00.000Z' },
    { policyId: 'not-in-hash-envelope' },
  ])('rejects invalid version envelope %j', (patch) => {
    expect(() => fingerprintTimePolicyVersion({ ...version(), ...patch })).toThrow();
  });
  it('validates exact references and hashes', () => {
    const ref = { policyId: 'policy', versionId: 'version', definitionHash: 'a'.repeat(64) };
    expect(parseTimePolicyVersionReference(ref)).toEqual(ref);
    expect(() =>
      parseTimePolicyVersionReference({ ...ref, definitionHash: 'A'.repeat(64) }),
    ).toThrow();
    expect(() => parseTimePolicyVersionReference({ ...ref, versionId: '' })).toThrow();
    expect(() => parseTimePolicyVersionReference({ ...ref, latest: true })).toThrow();
  });
});
