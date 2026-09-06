import type { ActivityMetricDefinition } from '@prisma/client';
import { fingerprintActivityMetricDefinition } from './activity-metric-definition';
import { fingerprintActivityMetricSetDefinition } from './activity-metric-set-definition';
import type { MetricSetRow } from './activity-metric-presenter';
import { metricSelectionColumns } from './activity-metric-selection';
import { presentActivityMetricSelection } from './activity-metric-selection-presenter';

function fixture() {
  const configuration = { kindCode: 'boolean', unit: null };
  const definition: ActivityMetricDefinition = {
    id: 'definition',
    code: 'finished',
    version: 1,
    name: '完成',
    kindCode: 'boolean',
    unit: null,
    configurationJson: configuration,
    schemaVersion: 1,
    definitionHash: fingerprintActivityMetricDefinition({
      schemaVersion: 1,
      code: 'finished',
      version: 1,
      name: '完成',
      configuration,
    }).definitionHash,
    statusCode: 'active',
    activatedAt: new Date(0),
    retiredAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const item = {
    key: 'finished',
    sortOrder: 0,
    required: true,
    metricDefinitionId: definition.id,
    definitionHash: definition.definitionHash,
  };
  const set: MetricSetRow = {
    id: 'set',
    code: 'completion',
    version: 1,
    schemaVersion: 1,
    name: '完成情况',
    statusCode: 'active',
    definitionHash: fingerprintActivityMetricSetDefinition({
      schemaVersion: 1,
      code: 'completion',
      version: 1,
      name: '完成情况',
      items: [item],
    }).definitionHash,
    activatedAt: new Date(0),
    retiredAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    items: [
      {
        id: 'item',
        createdAt: new Date(0),
        setVersionId: 'set',
        key: item.key,
        sortOrder: 0,
        required: true,
        metricDefinitionId: definition.id,
        metricDefinition: definition,
      },
    ],
  };
  const pointer = {
    id: set.id,
    code: set.code,
    version: set.version,
    schemaVersion: 1 as const,
    definitionHash: set.definitionHash,
  };
  const row = {
    id: 'activity',
    ...metricSelectionColumns({ metricRequirementCode: 'required', metricSetPointer: pointer }, 4),
  };
  return { row, set, pointer, definition };
}

describe('C1 D2b metric selection presenter', () => {
  it('returns exactly six safe fields and an exact five-field pointer', () => {
    const { row, set, pointer } = fixture();
    const expandedRow = { ...row, operationKey: 'internal', definitionJson: { internal: true } };
    expect(presentActivityMetricSelection(expandedRow, set)).toEqual({
      activityId: 'activity',
      metricRequirementCode: 'required',
      metricSetPointer: pointer,
      metricSelectionRevision: 4,
      metricSetName: '完成情况',
      selectable: true,
    });
  });

  it.each(['set', 'definition', 'both'] as const)(
    'preserves a retired %s as historical, but not newly selectable',
    (target) => {
      const { row, set, definition, pointer } = fixture();
      if (target !== 'definition') set.statusCode = 'retired';
      if (target !== 'set') definition.statusCode = 'retired';
      expect(presentActivityMetricSelection(row, set)).toEqual({
        activityId: 'activity',
        metricRequirementCode: 'required',
        metricSetPointer: pointer,
        metricSelectionRevision: 4,
        metricSetName: '完成情况',
        selectable: false,
      });
    },
  );

  it.each(['set', 'definition'] as const)(
    'never interprets a draft %s as a valid historical selection',
    (target) => {
      const { row, set, definition } = fixture();
      if (target === 'set') set.statusCode = 'draft';
      else definition.statusCode = 'draft';
      expect(() => presentActivityMetricSelection(row, set)).toThrow(TypeError);
    },
  );

  it.each([
    'missing',
    'wrong-id',
    'wrong-hash',
    'tampered-set',
    'tampered-definition',
    'missing-item',
  ] as const)('rejects broken historical closure: %s', (target) => {
    const { row, set, definition } = fixture();
    if (target === 'wrong-id') row.selectedMetricSetVersionId = 'other';
    if (target === 'wrong-hash') row.selectedMetricSetDefinitionHash = 'f'.repeat(64);
    if (target === 'tampered-set') set.name = 'changed';
    if (target === 'tampered-definition')
      definition.configurationJson = { kindCode: 'boolean', unit: 'changed' };
    if (target === 'missing-item') set.items = [];
    expect(() => presentActivityMetricSelection(row, target === 'missing' ? null : set)).toThrow(
      TypeError,
    );
  });

  it('keeps unconfigured distinct from an explicit not_required decision', () => {
    expect(
      presentActivityMetricSelection(
        {
          id: 'old',
          metricRequirementCode: null,
          selectedMetricSetVersionId: null,
          selectedMetricSetDefinitionHash: null,
          metricSelectionRevision: 0,
        },
        null,
      ),
    ).toEqual({
      activityId: 'old',
      metricRequirementCode: 'unconfigured',
      metricSetPointer: null,
      metricSelectionRevision: 0,
      metricSetName: null,
      selectable: false,
    });
    expect(
      presentActivityMetricSelection(
        {
          id: 'explicit',
          ...metricSelectionColumns({
            metricRequirementCode: 'not_required',
            metricSetPointer: null,
          }),
        },
        null,
      ),
    ).toEqual({
      activityId: 'explicit',
      metricRequirementCode: 'not_required',
      metricSetPointer: null,
      metricSelectionRevision: 1,
      metricSetName: null,
      selectable: true,
    });
  });
});
