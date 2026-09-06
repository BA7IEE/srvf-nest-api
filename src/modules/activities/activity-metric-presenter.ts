import type {
  ActivityMetricDefinition,
  ActivityMetricSetItem,
  ActivityMetricSetVersion,
} from '@prisma/client';
import { parseActivityMetricDefinition } from './activity-metric-definition';
import { parseActivityMetricSetDefinition } from './activity-metric-set-definition';
import { parseMetricReceipt } from './activity-metric-command';

export type MetricSetRow = ActivityMetricSetVersion & {
  items: (ActivityMetricSetItem & { metricDefinition: ActivityMetricDefinition })[];
};

export function metricDefinitionDocument(row: ActivityMetricDefinition) {
  return parseActivityMetricDefinition({
    schemaVersion: row.schemaVersion,
    code: row.code,
    version: row.version,
    name: row.name,
    configuration: row.configurationJson,
  });
}

export function metricSetDocument(row: MetricSetRow) {
  return parseActivityMetricSetDefinition({
    schemaVersion: row.schemaVersion,
    code: row.code,
    version: row.version,
    name: row.name,
    items: row.items.map((item) => ({
      key: item.key,
      sortOrder: item.sortOrder,
      required: item.required,
      metricDefinitionId: item.metricDefinitionId,
      definitionHash: item.metricDefinition.definitionHash,
    })),
  });
}

export function metricCommandResult(row: ActivityMetricDefinition | ActivityMetricSetVersion) {
  return parseMetricReceipt({
    id: row.id,
    code: row.code,
    version: row.version,
    schemaVersion: row.schemaVersion,
    statusCode: row.statusCode,
    definitionHash: row.definitionHash,
  });
}

export function presentMetricDefinition(row: ActivityMetricDefinition) {
  return {
    ...metricCommandResult(row),
    definition: metricDefinitionDocument(row),
    activatedAt: row.activatedAt,
    retiredAt: row.retiredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function presentMetricSet(row: MetricSetRow) {
  return {
    ...metricCommandResult(row),
    definition: metricSetDocument(row),
    activatedAt: row.activatedAt,
    retiredAt: row.retiredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
