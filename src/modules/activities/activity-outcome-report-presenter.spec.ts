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
      activatedAt: createdAt,
      retiredAt: createdAt,
      createdAt,
      updatedAt: createdAt,
      items: [
        {
          ...set.items[0],
          id: 'item',
          setVersionId: 'historical-set',
          createdAt,
          metricDefinition: {
            id: 'metric',
            activatedAt: createdAt,
            retiredAt: createdAt,
            createdAt,
            updatedAt: createdAt,
            ...definition,
            configurationJson: definition.configuration,
            kindCode: definition.configuration.kindCode,
            unit: definition.configuration.unit,
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
  };
}

import { presentActivityOutcomeReport } from './activity-outcome-report-presenter';

describe('C5 report projection', () => {
  const context = {
    activityId: 'activity',
    activityStatusCode: 'completed',
    metricRequirementCode: 'required' as const,
    metricSelectionRevision: 3,
  };
  it('retains historical definitions and hashes without evidence or identities', () => {
    const row = fixture();
    const before = JSON.stringify(row);
    const result = presentActivityOutcomeReport(context, row);
    expect(result.formalStatus).toBe('confirmed');
    expect(result.currentConfirmed?.metrics[0].definitionHash).toBe(
      row.metricSetVersion.items[0].metricDefinition.definitionHash,
    );
    expect(result.currentConfirmed?.metrics[0].value).toBe(12);
    expect(Object.keys(result.currentConfirmed!.metrics[0]).sort()).toEqual(
      [
        'valueRevisionId',
        'metricDefinitionId',
        'definitionHash',
        'definition',
        'value',
        'sourceCode',
      ].sort(),
    );
    for (const text of [
      'attachment',
      'confirmer',
      'private-creator',
      'internal-reference',
      'internal-rule',
    ])
      expect(JSON.stringify(result)).not.toContain(text);
    expect(JSON.stringify(row)).toBe(before);
  });
  it('returns null, not zero, when no formal result exists', () => {
    expect(presentActivityOutcomeReport(context, null)).toEqual({
      ...context,
      formalStatus: 'not_confirmed',
      currentConfirmed: null,
    });
  });
  it.each(['draft', 'superseded'])('rejects %s', (statusCode) => {
    const row = fixture();
    row.statusCode = statusCode;
    expect(() => presentActivityOutcomeReport(context, row)).toThrow();
  });
  it('rejects cross-activity data', () => {
    expect(() =>
      presentActivityOutcomeReport({ ...context, activityId: 'other' }, fixture()),
    ).toThrow();
  });
  it('does not hide corrupted evidence while stripping it from the response', () => {
    const row = fixture();
    row.values[0].evidence = [];
    expect(() => presentActivityOutcomeReport(context, row)).toThrow();
  });
  it('does not ignore a value hash mismatch', () => {
    const row = fixture();
    row.values[0].valueJson = 13;
    expect(() => presentActivityOutcomeReport(context, row)).toThrow();
  });
  it('preserves a valid numeric zero', () => {
    const row = fixture();
    const d = row.metricSetVersion.items[0].metricDefinition;
    const definition = {
      schemaVersion: d.schemaVersion,
      code: d.code,
      version: d.version,
      name: d.name,
      configuration: d.configurationJson,
    };
    row.values[0].valueJson = 0;
    row.values[0].valueHash = fingerprintActivityOutcomeValue(
      definition,
      d.definitionHash,
      0,
    ).valueHash;
    expect(presentActivityOutcomeReport(context, row).currentConfirmed?.metrics[0].value).toBe(0);
  });
});
