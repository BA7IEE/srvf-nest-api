import { fingerprintActivityMetricDefinition } from './activity-metric-definition';
import { fingerprintActivityMetricSetDefinition } from './activity-metric-set-definition';
import { fingerprintActivityOutcomeValue } from './activity-outcome-value';
import { presentActivityOutcomeDetail, type OutcomeDetailRow } from './activity-outcome-presenter';

function fixture(): OutcomeDetailRow {
  const definition = {
    schemaVersion: 1,
    code: 'served',
    version: 1,
    name: '服务人数',
    configuration: { kindCode: 'non_negative_integer', unit: '人', minimum: 0, maximum: 100 },
  };
  const definitionHash = fingerprintActivityMetricDefinition(definition).definitionHash;
  const set = {
    schemaVersion: 1,
    code: 'set',
    version: 1,
    name: '成果指标',
    items: [
      { key: 'served', sortOrder: 0, required: true, metricDefinitionId: 'metric', definitionHash },
    ],
  };
  const setHash = fingerprintActivityMetricSetDefinition(set).definitionHash;
  const createdAt = new Date('2026-09-07T00:00:00.000Z');
  return {
    id: 'outcome',
    activityId: 'activity',
    revision: 1,
    metricSetVersionId: 'historical-set',
    metricSetDefinitionHash: setHash,
    statusCode: 'superseded',
    priorRevisionId: null,
    createdByUserId: 'private-creator',
    createdAt,
    metricSetVersion: {
      id: 'historical-set',
      ...set,
      definitionHash: setHash,
      statusCode: 'retired',
      items: [
        {
          ...set.items[0],
          metricDefinition: {
            id: 'metric',
            ...definition,
            configurationJson: definition.configuration,
            definitionHash,
            statusCode: 'retired',
          },
        },
      ],
    },
    values: [
      {
        id: 'value',
        outcomeRevisionId: 'outcome',
        activityId: 'activity',
        setVersionId: 'historical-set',
        metricDefinitionId: 'metric',
        valueJson: 12,
        valueHash: fingerprintActivityOutcomeValue(definition, definitionHash, 12).valueHash,
        sourceCode: 'manual',
        sourceReference: 'internal-reference',
        calculatedByRuleVersion: 'internal-rule',
        confirmedByUserId: null,
        confirmedAt: null,
        createdAt,
        evidence: [
          {
            id: 'link',
            valueRevisionId: 'value',
            outcomeRevisionId: 'outcome',
            activityId: 'activity',
            setVersionId: 'historical-set',
            attachmentId: 'attachment',
            sortOrder: 0,
            createdAt,
          },
        ],
      },
    ],
  } as unknown as OutcomeDetailRow;
}

describe('C2 outcome safe historical presenter', () => {
  it('interprets retired historical definitions and emits a closed whitelist', () => {
    const row = fixture();
    const before = JSON.stringify(row);
    const result = presentActivityOutcomeDetail(row);
    expect(result.statusCode).toBe('superseded');
    expect(result.metricSetVersionId).toBe('historical-set');
    expect(result.values[0].value).toBe(12);
    expect(Object.keys(result).sort()).toEqual([
      'activityId',
      'createdAt',
      'metricSetDefinitionHash',
      'metricSetVersionId',
      'outcomeRevisionId',
      'priorRevisionId',
      'revision',
      'statusCode',
      'values',
    ]);
    expect(Object.keys(result.values[0]).sort()).toEqual([
      'definition',
      'evidence',
      'metricDefinitionId',
      'sourceCode',
      'value',
      'valueRevisionId',
    ]);
    expect(result.values[0].evidence).toEqual([{ attachmentId: 'attachment', sortOrder: 0 }]);
    expect(JSON.stringify(row)).toBe(before);
  });
  it.each(['metricSetVersionId', 'metricSetDefinitionHash'] as const)(
    'rejects a changed historical %s',
    (field) => {
      const row = fixture();
      row[field] = 'wrong';
      expect(() => presentActivityOutcomeDetail(row)).toThrow(TypeError);
    },
  );
  it.each([
    'outcomeRevisionId',
    'activityId',
    'setVersionId',
    'metricDefinitionId',
    'valueHash',
  ] as const)('rejects a broken value %s', (field) => {
    const row = fixture();
    row.values[0][field] = 'wrong';
    expect(() => presentActivityOutcomeDetail(row)).toThrow(TypeError);
  });
  it.each(['valueRevisionId', 'outcomeRevisionId', 'activityId', 'setVersionId'] as const)(
    'rejects a broken evidence %s',
    (field) => {
      const row = fixture();
      row.values[0].evidence[0][field] = 'wrong';
      expect(() => presentActivityOutcomeDetail(row)).toThrow(TypeError);
    },
  );
  it('rejects tampered values instead of emitting raw stored JSON', () => {
    const row = fixture();
    row.values[0].valueJson = { unexpected: 'content' };
    expect(() => presentActivityOutcomeDetail(row)).toThrow(TypeError);
  });
  it('rejects an unactivated historical definition', () => {
    const row = fixture();
    row.metricSetVersion.items[0].metricDefinition.statusCode = 'draft';
    expect(() => presentActivityOutcomeDetail(row)).toThrow(TypeError);
  });
});
