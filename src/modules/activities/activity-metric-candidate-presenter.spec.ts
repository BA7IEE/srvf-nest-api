import { presentMetricCandidate } from './activity-metric-candidate-presenter';

describe('presentMetricCandidate', () => {
  it('returns only the declared safe candidate projection', () => {
    const values = [
      {
        metricDefinitionId: 'definition-1',
        definitionHash: 'definition-hash',
        value: '1.250000',
        valueHash: 'value-hash',
        ruleCode: 'actual_participation_hours_v1' as const,
        evaluatorVersion: 1,
        unitCode: 'hours' as const,
        scale: 6,
      },
    ];

    const result = presentMetricCandidate(
      {
        schemaVersion: 1,
        candidateId: 'candidate-1',
        activityId: 'activity-1',
        revision: 2,
        metricSetVersionId: 'set-version-1',
        metricSetDefinitionHash: 'set-hash',
        createdStatusCode: 'candidate',
        sourceCode: 'system',
        valueCount: 1,
        sourceCount: 3,
        createdAt: '2026-09-08T00:00:00.000Z',
      },
      'fresh',
      true,
      values,
    );

    expect(result).toEqual({
      schemaVersion: 1,
      candidateId: 'candidate-1',
      activityId: 'activity-1',
      revision: 2,
      metricSetVersionId: 'set-version-1',
      metricSetDefinitionHash: 'set-hash',
      createdStatusCode: 'candidate',
      sourceCode: 'system',
      valueCount: 1,
      sourceCount: 3,
      createdAt: '2026-09-08T00:00:00.000Z',
      freshness: 'fresh',
      reproducible: true,
      values,
    });
    expect(result.values).not.toBe(values);
    expect(Object.keys(result.values[0]).sort()).toEqual([
      'definitionHash',
      'evaluatorVersion',
      'metricDefinitionId',
      'ruleCode',
      'scale',
      'unitCode',
      'value',
      'valueHash',
    ]);
  });
});
