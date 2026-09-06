import {
  assertMetricSelectionReference,
  readActivityMetricSelection,
  type ActivityMetricSelectionColumns,
} from './activity-metric-selection';
import type { MetricSetRow } from './activity-metric-presenter';

export function presentActivityMetricSelection(
  row: ActivityMetricSelectionColumns & { id: string },
  set: MetricSetRow | null,
) {
  const selection = readActivityMetricSelection(row, set);
  let selectable = false;
  if (selection) {
    try {
      assertMetricSelectionReference(selection, set);
      selectable = true;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }
  return {
    activityId: row.id,
    metricRequirementCode: selection?.metricRequirementCode ?? ('unconfigured' as const),
    metricSetPointer: selection?.metricSetPointer ?? null,
    metricSelectionRevision: row.metricSelectionRevision,
    metricSetName: selection?.metricSetPointer ? set!.name : null,
    selectable,
  };
}
