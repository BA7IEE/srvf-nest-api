import type {
  ActivityOutcomeRevision,
  ActivityMetricValueRevision,
  ActivityMetricValueEvidence,
} from '@prisma/client';
import { metricDefinitionDocument, type MetricSetRow } from './activity-metric-presenter';
import { assertMetricSelectionReference } from './activity-metric-selection';
import { fingerprintActivityOutcomeValue } from './activity-outcome-value';

export type OutcomeDetailRow = ActivityOutcomeRevision & {
  metricSetVersion: MetricSetRow;
  values: (ActivityMetricValueRevision & { evidence: ActivityMetricValueEvidence[] })[];
};

/** Explicit whitelist: never spread a persistent row into a response. */
export function presentActivityOutcomeSummary(row: ActivityOutcomeRevision) {
  return {
    outcomeRevisionId: row.id,
    activityId: row.activityId,
    revision: row.revision,
    metricSetVersionId: row.metricSetVersionId,
    metricSetDefinitionHash: row.metricSetDefinitionHash,
    statusCode: row.statusCode,
    priorRevisionId: row.priorRevisionId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Interpret using this revision's immutable anchors, never today's selected set. */
export function presentActivityOutcomeDetail(row: OutcomeDetailRow) {
  const set = row.metricSetVersion;
  assertMetricSelectionReference(
    {
      metricRequirementCode: 'required',
      metricSetPointer: {
        id: row.metricSetVersionId,
        code: set.code,
        version: set.version,
        schemaVersion: 1,
        definitionHash: row.metricSetDefinitionHash,
      },
    },
    set,
    true,
  );
  if (row.values.length > 100) throw new TypeError('too many outcome values');
  const values = row.values.map((value) => {
    if (
      value.outcomeRevisionId !== row.id ||
      value.activityId !== row.activityId ||
      value.setVersionId !== row.metricSetVersionId
    )
      throw new TypeError('invalid outcome value anchor');
    const item = set.items.find(
      (candidate) => candidate.metricDefinitionId === value.metricDefinitionId,
    );
    if (!item) throw new TypeError('outcome metric missing from historical set');
    const definition = metricDefinitionDocument(item.metricDefinition);
    if (definition.configuration.kindCode === 'short_text')
      throw new TypeError('sensitive outcome kind is unavailable');
    const parsed = fingerprintActivityOutcomeValue(
      definition,
      item.metricDefinition.definitionHash,
      value.valueJson,
    );
    if (parsed.valueHash !== value.valueHash) throw new TypeError('outcome value hash mismatch');
    if (value.evidence.length > 20) throw new TypeError('too much outcome evidence');
    const evidence = [...value.evidence]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((link) => {
        if (
          link.valueRevisionId !== value.id ||
          link.outcomeRevisionId !== row.id ||
          link.activityId !== row.activityId ||
          link.setVersionId !== row.metricSetVersionId
        )
          throw new TypeError('invalid outcome evidence anchor');
        return { attachmentId: link.attachmentId, sortOrder: link.sortOrder };
      });
    return {
      valueRevisionId: value.id,
      metricDefinitionId: value.metricDefinitionId,
      definition,
      value: parsed.valueJson,
      sourceCode: value.sourceCode,
      evidence,
    };
  });
  values.sort((a, b) =>
    a.metricDefinitionId < b.metricDefinitionId
      ? -1
      : a.metricDefinitionId > b.metricDefinitionId
        ? 1
        : 0,
  );
  return { ...presentActivityOutcomeSummary(row), values };
}
