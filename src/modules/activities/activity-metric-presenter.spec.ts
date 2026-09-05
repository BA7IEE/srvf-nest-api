import type { ActivityMetricDefinition } from '@prisma/client';
import { fingerprintActivityMetricDefinition } from './activity-metric-definition';
import { presentMetricDefinition } from './activity-metric-presenter';
describe('metric presenter whitelist', () => {
  it('returns explicit version document without raw storage or relation fields', () => {
    const configuration = { kindCode: 'boolean', unit: null };
    const definition = { schemaVersion: 1, code: 'one', version: 1, name: '指标', configuration };
    const row: ActivityMetricDefinition = {
      id: 'metric_id',
      code: 'one',
      version: 1,
      name: '指标',
      kindCode: 'boolean',
      unit: null,
      configurationJson: configuration,
      schemaVersion: 1,
      definitionHash: fingerprintActivityMetricDefinition(definition).definitionHash,
      statusCode: 'draft',
      activatedAt: null,
      retiredAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const result = presentMetricDefinition(row);
    expect(result.definition).toEqual(definition);
    expect(Object.keys(result).sort()).toEqual(
      [
        'id',
        'code',
        'version',
        'schemaVersion',
        'statusCode',
        'definitionHash',
        'definition',
        'activatedAt',
        'retiredAt',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(result).not.toHaveProperty('configurationJson');
  });
});
