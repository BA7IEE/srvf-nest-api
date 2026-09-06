import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { metricHash } from './activity-metric-command';
import { metricCode, metricInteger, metricObject, metricText } from './activity-metric-definition';
import { assertActivityMetricSetActivation } from './activity-metric-set-definition';
import {
  metricDefinitionDocument,
  metricSetDocument,
  type MetricSetRow,
} from './activity-metric-presenter';

export interface ActivityMetricSetPointer {
  id: string;
  code: string;
  version: number;
  schemaVersion: 1;
  definitionHash: string;
}
export type ActivityMetricSelection =
  | { metricRequirementCode: 'not_required'; metricSetPointer: null }
  | { metricRequirementCode: 'required'; metricSetPointer: ActivityMetricSetPointer };
export type ActivityMetricSelectionResult = ActivityMetricSelection & {
  activityId: string;
  metricSelectionRevision: number;
};
export interface ActivityMetricSelectionColumns {
  metricRequirementCode: string | null;
  selectedMetricSetVersionId: string | null;
  selectedMetricSetDefinitionHash: string | null;
  metricSelectionRevision: number;
}

export function parseActivityMetricSetPointer(value: unknown): ActivityMetricSetPointer {
  const v = metricObject(value, ['id', 'code', 'version', 'schemaVersion', 'definitionHash']);
  if (v.schemaVersion !== 1) throw new TypeError('unsupported metric pointer schema');
  return {
    id: metricText(v.id, 64),
    code: metricCode(v.code),
    version: metricInteger(v.version, 1, 2147483647),
    schemaVersion: 1,
    definitionHash: metricHash(v.definitionHash),
  };
}

/** Exact two-key input. Unconfigured exists only in old/default persistent rows. */
export function parseActivityMetricSelection(value: unknown): ActivityMetricSelection {
  const v = metricObject(value, ['metricRequirementCode', 'metricSetPointer']);
  if (v.metricRequirementCode === 'not_required' && v.metricSetPointer === null)
    return { metricRequirementCode: 'not_required', metricSetPointer: null };
  if (v.metricRequirementCode === 'required')
    return {
      metricRequirementCode: 'required',
      metricSetPointer: parseActivityMetricSetPointer(v.metricSetPointer),
    };
  throw new TypeError('invalid metric selection');
}

export function parseActivityMetricSelectionReceipt(
  value: unknown,
  activityId: string,
): ActivityMetricSelectionResult {
  try {
    const v = metricObject(value, [
      'activityId',
      'metricRequirementCode',
      'metricSetPointer',
      'metricSelectionRevision',
    ]);
    if (metricText(v.activityId, 64) !== activityId) throw new TypeError('wrong selection target');
    return {
      activityId,
      ...parseActivityMetricSelection({
        metricRequirementCode: v.metricRequirementCode,
        metricSetPointer: v.metricSetPointer,
      }),
      metricSelectionRevision: metricInteger(v.metricSelectionRevision, 1, 2147483647),
    };
  } catch (error) {
    if (error instanceof TypeError)
      throw new BizException(BizCode.ACTIVITY_METRIC_SELECTION_RECEIPT_INVALID);
    throw error;
  }
}

export function metricSelectionColumns(
  selection: ActivityMetricSelection,
  revision = 1,
): ActivityMetricSelectionColumns {
  return {
    metricRequirementCode: selection.metricRequirementCode,
    selectedMetricSetVersionId: selection.metricSetPointer?.id ?? null,
    selectedMetricSetDefinitionHash: selection.metricSetPointer?.definitionHash ?? null,
    metricSelectionRevision: metricInteger(revision, 1, 2147483647),
  };
}

/** Historical interpretation accepts retired catalogue rows without making them newly selectable. */
export function readActivityMetricSelection(
  row: ActivityMetricSelectionColumns,
  set: MetricSetRow | null,
): ActivityMetricSelection | null {
  const revision = metricInteger(row.metricSelectionRevision, 0, 2147483647);
  if (
    row.metricRequirementCode === null &&
    row.selectedMetricSetVersionId === null &&
    row.selectedMetricSetDefinitionHash === null &&
    revision === 0
  )
    return null;
  if (revision < 1) throw new TypeError('configured selection requires revision');
  if (
    row.metricRequirementCode === 'not_required' &&
    row.selectedMetricSetVersionId === null &&
    row.selectedMetricSetDefinitionHash === null
  )
    return { metricRequirementCode: 'not_required', metricSetPointer: null };
  if (
    row.metricRequirementCode !== 'required' ||
    !set ||
    row.selectedMetricSetVersionId !== set.id ||
    row.selectedMetricSetDefinitionHash !== set.definitionHash
  )
    throw new TypeError('broken selection anchor');
  const selection = parseActivityMetricSelection({
    metricRequirementCode: 'required',
    metricSetPointer: {
      id: set.id,
      code: set.code,
      version: set.version,
      schemaVersion: set.schemaVersion,
      definitionHash: set.definitionHash,
    },
  });
  assertMetricSelectionReference(selection, set, true);
  return selection;
}

export function assertMetricSelectionReference(
  selection: ActivityMetricSelection,
  row: MetricSetRow | null,
  historical = false,
): void {
  if (selection.metricRequirementCode === 'not_required') return;
  const p = selection.metricSetPointer;
  if (
    !row ||
    row.id !== p.id ||
    row.code !== p.code ||
    row.version !== p.version ||
    row.schemaVersion !== p.schemaVersion ||
    row.definitionHash !== p.definitionHash ||
    !(row.statusCode === 'active' || (historical && row.statusCode === 'retired'))
  )
    throw new TypeError('metric set unavailable');
  assertActivityMetricSetActivation(
    metricSetDocument(row),
    row.definitionHash,
    row.items.map(({ metricDefinition: d }) => {
      if (!(d.statusCode === 'active' || (historical && d.statusCode === 'retired')))
        throw new TypeError('metric definition unavailable');
      return {
        id: d.id,
        statusCode: 'active',
        definitionHash: d.definitionHash,
        definition: metricDefinitionDocument(d),
      };
    }),
  );
}
