import { presentConfirmedActivityOutcome } from './activity-outcome-confirmed-presenter';
import { fingerprintActivityMetricDefinition } from './activity-metric-definition';
import { fingerprintActivityMetricSetDefinition } from './activity-metric-set-definition';
import { fingerprintActivityOutcomeValue } from './activity-outcome-value';
import { type OutcomeDetailRow } from './activity-outcome-presenter';

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
    statusCode: 'confirmed',
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
        confirmedByUserId: 'confirmer',
        confirmedAt: createdAt,
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

describe('C3-2 current confirmed presenter', () => {
  it('returns the formal value interpreted from its retained retired definition', () => {
    const row = fixture();
    const before = JSON.stringify(row);
    const result = presentConfirmedActivityOutcome(row);
    expect(result.isCurrentConfirmed).toBe(true);
    expect(result.confirmedAt).toBe('2026-09-07T00:00:00.000Z');
    expect(result.values[0].value).toBe(12);
    expect(JSON.stringify(result)).not.toContain('private-creator');
    expect(JSON.stringify(result)).not.toContain('confirmer');
    expect(JSON.stringify(result)).not.toContain('internal-reference');
    expect(JSON.stringify(row)).toBe(before);
  });
  it.each(['draft', 'superseded'])('rejects %s as a current formal result', (statusCode) => {
    expect(() => presentConfirmedActivityOutcome({ ...fixture(), statusCode })).toThrow();
  });
  it('rejects empty formal results', () => {
    expect(() => presentConfirmedActivityOutcome({ ...fixture(), values: [] })).toThrow();
  });
  it('rejects missing evidence', () => {
    const row = fixture();
    row.values[0].evidence = [];
    expect(() => presentConfirmedActivityOutcome(row)).toThrow();
  });
  it('rejects missing confirmation identity', () => {
    const row = fixture();
    row.values[0].confirmedByUserId = null;
    expect(() => presentConfirmedActivityOutcome(row)).toThrow();
  });
  it('rejects missing confirmation time', () => {
    const row = fixture();
    row.values[0].confirmedAt = null;
    expect(() => presentConfirmedActivityOutcome(row)).toThrow();
  });
  it('recomputes the value hash before returning formal data', () => {
    const row = fixture();
    row.values[0].valueJson = 13;
    expect(() => presentConfirmedActivityOutcome(row)).toThrow();
  });
});
