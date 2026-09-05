import {
  fingerprintActivityMetricDefinition,
  fingerprintMetricEnvelope,
  metricArray,
  metricCode,
  metricInteger,
  metricObject,
  metricText,
  parseActivityMetricDefinition,
} from './activity-metric-definition';

export interface ActivityMetricSetDefinitionV1 {
  schemaVersion: 1;
  code: string;
  version: number;
  name: string;
  items: {
    key: string;
    sortOrder: number;
    required: boolean;
    metricDefinitionId: string;
    definitionHash: string;
  }[];
}

/** Empty draft sets can be fingerprinted, but the activation validator and DB reject them. */
export function parseActivityMetricSetDefinition(value: unknown): ActivityMetricSetDefinitionV1 {
  const v = metricObject(value, ['schemaVersion', 'code', 'version', 'name', 'items']);
  if (v.schemaVersion !== 1) throw new TypeError('unsupported metric set schema version');
  const items = metricArray(v.items, 100)
    .map((item) => {
      const i = metricObject(item, [
        'key',
        'sortOrder',
        'required',
        'metricDefinitionId',
        'definitionHash',
      ]);
      if (typeof i.required !== 'boolean') throw new TypeError('metric required must be boolean');
      const definitionHash = metricText(i.definitionHash, 64);
      if (!/^[0-9a-f]{64}$/.test(definitionHash)) throw new TypeError('invalid metric hash');
      return {
        key: metricCode(i.key),
        sortOrder: metricInteger(i.sortOrder, 0, 99),
        required: i.required,
        metricDefinitionId: metricText(i.metricDefinitionId, 64),
        definitionHash,
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);
  for (const values of [
    items.map((i) => i.key),
    items.map((i) => i.sortOrder),
    items.map((i) => i.metricDefinitionId),
  ]) {
    if (new Set<string | number>(values).size !== items.length)
      throw new TypeError('duplicate metric set item');
  }
  return {
    schemaVersion: 1,
    code: metricCode(v.code),
    version: metricInteger(v.version, 1, 2147483647),
    name: metricText(v.name, 100),
    items,
  };
}

export function fingerprintActivityMetricSetDefinition(value: unknown): {
  canonicalText: string;
  definitionHash: string;
} {
  return fingerprintMetricEnvelope('activity-metric-set', parseActivityMetricSetDefinition(value));
}

/** Future writer must call this after locking exact referenced rows, in its root transaction. */
export function assertActivityMetricSetActivation(
  value: unknown,
  expectedHash: string,
  definitions: readonly {
    id: string;
    statusCode: string;
    definitionHash: string;
    definition: unknown;
  }[],
): ActivityMetricSetDefinitionV1 {
  const set = parseActivityMetricSetDefinition(value);
  if (
    set.items.length === 0 ||
    fingerprintActivityMetricSetDefinition(set).definitionHash !== expectedHash
  ) {
    throw new TypeError('metric set is empty or hash mismatches');
  }
  const rows = new Map(definitions.map((d) => [d.id, d]));
  if (rows.size !== definitions.length || rows.size !== set.items.length)
    throw new TypeError('metric reference set mismatch');
  for (const item of set.items) {
    const row = rows.get(item.metricDefinitionId);
    if (
      !row ||
      row.statusCode !== 'active' ||
      row.definitionHash !== item.definitionHash ||
      fingerprintActivityMetricDefinition(parseActivityMetricDefinition(row.definition))
        .definitionHash !== row.definitionHash
    ) {
      throw new TypeError('metric definition is unavailable or hash mismatches');
    }
  }
  return set;
}
