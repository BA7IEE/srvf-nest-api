import {
  fingerprintActivityMetricDefinition,
  fingerprintMetricEnvelope,
} from './activity-metric-definition';
import {
  replayRetainedMetricCandidate,
  type RetainedMetricCandidate,
} from './activity-metric-candidate-replay';
import {
  evaluateActivityMetricRule,
  fingerprintMetricCandidateSources,
  normalizeMetricCandidateSources,
  resolveActivityMetricRuleBinding,
} from './activity-metric-rule';

describe('C3 retained candidate pure replay', () => {
  function fixture(): RetainedMetricCandidate {
    const now = new Date('2025-01-02T00:00:00.000Z');
    const document = {
      schemaVersion: 1,
      code: 'people',
      version: 1,
      name: '人数',
      configuration: { kindCode: 'non_negative_integer', unit: '人', minimum: 0, maximum: 2000 },
    };
    const definitionHash = fingerprintActivityMetricDefinition(document).definitionHash;
    const binding = {
      id: 'binding',
      createdAt: now,
      createdByUserId: 'actor',
      ...resolveActivityMetricRuleBinding(
        'definition',
        document,
        definitionHash,
        'actual_participant_count_v1',
        1,
      ),
      definition: {
        id: 'definition',
        code: document.code,
        version: 1,
        name: document.name,
        kindCode: 'non_negative_integer',
        unit: '人',
        schemaVersion: 1,
        configurationJson: document.configuration,
        definitionHash,
        statusCode: 'active',
        activatedAt: now,
        retiredAt: null,
        createdAt: now,
        updatedAt: now,
      },
    };
    const inputs = normalizeMetricCandidateSources([
      {
        sourceRevisionId: 'source',
        identityId: 'identity',
        sessionId: 'session',
        memberId: 'private-member',
        checkInAt: new Date('2025-01-01T00:00:00.000Z'),
        checkOutAt: new Date('2025-01-01T01:00:00.000Z'),
        resultCode: 'valid',
      },
    ]);
    const digest = fingerprintMetricCandidateSources('activity', inputs);
    const value = evaluateActivityMetricRule(
      'definition',
      document,
      definitionHash,
      binding.ruleCode,
      1,
      inputs,
    );
    return {
      id: 'candidate',
      schemaVersion: 1,
      activityId: 'activity',
      candidateRevision: 1,
      priorCandidateId: null,
      metricSetVersionId: 'set',
      metricSetDefinitionHash: 'a'.repeat(64),
      expectedOutcomeRevision: 0,
      sourceMode: 'participation_segments',
      providerVersion: 1,
      sourceDigest: digest.sourceDigest,
      bindingsDigest: fingerprintMetricEnvelope('activity-metric-candidate-bindings-v1', [
        { id: binding.id, bindingHash: binding.bindingHash },
      ]).definitionHash,
      valueCount: 1,
      sourceCount: 1,
      createdAt: now,
      createdByUserId: 'actor',
      values: [
        {
          id: 'value',
          candidateId: 'candidate',
          activityId: 'activity',
          setVersionId: 'set',
          definitionId: 'definition',
          definitionHash,
          bindingId: binding.id,
          binding,
          valueJson: value.valueJson,
          valueHash: value.valueHash,
        },
      ],
      sources: inputs.map((row, i) => ({
        ...row,
        id: `source-${i}`,
        candidateId: 'candidate',
        activityId: 'activity',
        checkInAt: new Date(row.checkInAt),
        checkOutAt: new Date(row.checkOutAt),
        sourceFingerprint: digest.sourceFingerprints[i],
      })),
    };
  }

  it('replays retained facts without changing them or returning source identities', () => {
    const candidate = fixture();
    const before = structuredClone(candidate);
    const result = replayRetainedMetricCandidate(candidate);
    expect(result.reproducible).toBe(true);
    expect(result.values).toHaveLength(1);
    expect(result.values[0].value).toBe(1);
    expect(candidate).toEqual(before);
    for (const field of [
      'identityId',
      'sourceRevisionId',
      'sessionId',
      'memberGroupOrdinal',
      'checkInAt',
      'createdByUserId',
    ])
      expect(JSON.stringify(result)).not.toContain(field);
  });

  const corruptions: [string, (candidate: RetainedMetricCandidate) => void][] = [
    [
      'missing values',
      (c) => {
        c.values = [];
      },
    ],
    [
      'missing sources',
      (c) => {
        c.sources = [];
      },
    ],
    [
      'source mode',
      (c) => {
        c.sourceMode = 'unknown';
      },
    ],
    [
      'provider version',
      (c) => {
        c.providerVersion = 2;
      },
    ],
    [
      'source result',
      (c) => {
        c.sources[0].resultCode = 'invalid';
      },
    ],
    [
      'source identity',
      (c) => {
        c.sources[0].identityId = 'other';
      },
    ],
    [
      'source time',
      (c) => {
        c.sources[0].checkOutAt = new Date('2025-01-01T02:00:00.000Z');
      },
    ],
    [
      'source fingerprint',
      (c) => {
        c.sources[0].sourceFingerprint = 'f'.repeat(64);
      },
    ],
    [
      'source digest',
      (c) => {
        c.sourceDigest = 'f'.repeat(64);
      },
    ],
    [
      'bindings digest',
      (c) => {
        c.bindingsDigest = 'f'.repeat(64);
      },
    ],
    [
      'rule digest',
      (c) => {
        c.values[0].binding.ruleDigest = 'f'.repeat(64);
      },
    ],
    [
      'definition hash',
      (c) => {
        c.values[0].definitionHash = 'f'.repeat(64);
      },
    ],
    [
      'value hash',
      (c) => {
        c.values[0].valueHash = 'f'.repeat(64);
      },
    ],
    [
      'value',
      (c) => {
        c.values[0].valueJson = 2;
      },
    ],
  ];
  it.each(corruptions)('rejects corrupted %s instead of returning zero', (_name, corrupt) => {
    const candidate = fixture();
    corrupt(candidate);
    expect(replayRetainedMetricCandidate(candidate)).toEqual({ reproducible: false, values: [] });
  });
});
