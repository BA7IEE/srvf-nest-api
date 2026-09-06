import { metricInteger, metricObject } from './activity-metric-definition';
import {
  parseActivityMetricSelection,
  type ActivityMetricSelection,
  type ActivityMetricSetPointer,
} from './activity-metric-selection';

/**
 * V7 freezes the Activity-owned metric-selection fact without duplicating any catalogue
 * definition, metric label, or result value.  `null/0` is the legacy unconfigured shape; new
 * V7 submissions reject it, but the parser keeps the representation explicit for fail-closed
 * historical inspection.
 */
export interface ActivityPublishProposalV7MetricFields {
  readonly metricRequirementCode: 'not_required' | 'required' | null;
  readonly metricSetPointer: ActivityMetricSetPointer | null;
  readonly metricSelectionRevision: number;
}

export function metricFieldsFromActivitySelection(
  selection: ActivityMetricSelection | null,
  revision: number,
): ActivityPublishProposalV7MetricFields {
  const parsedRevision = metricInteger(revision, 0, 2147483647);
  if (selection === null) {
    if (parsedRevision !== 0) throw new TypeError('unconfigured metric selection has revision');
    return {
      metricRequirementCode: null,
      metricSetPointer: null,
      metricSelectionRevision: 0,
    };
  }
  if (parsedRevision < 1) throw new TypeError('configured metric selection lacks revision');
  return {
    metricRequirementCode: selection.metricRequirementCode,
    metricSetPointer:
      selection.metricSetPointer === null ? null : { ...selection.metricSetPointer },
    metricSelectionRevision: parsedRevision,
  };
}

export function parseActivityPublishProposalV7MetricFields(
  value: unknown,
): ActivityPublishProposalV7MetricFields {
  const row = metricObject(value, [
    'metricRequirementCode',
    'metricSetPointer',
    'metricSelectionRevision',
  ]);
  const revision = metricInteger(row.metricSelectionRevision, 0, 2147483647);
  if (row.metricRequirementCode === null && row.metricSetPointer === null && revision === 0) {
    return {
      metricRequirementCode: null,
      metricSetPointer: null,
      metricSelectionRevision: 0,
    };
  }
  const selection = parseActivityMetricSelection({
    metricRequirementCode: row.metricRequirementCode,
    metricSetPointer: row.metricSetPointer,
  });
  return metricFieldsFromActivitySelection(selection, revision);
}

export function activitySelectionFromV7MetricFields(
  fields: ActivityPublishProposalV7MetricFields,
): ActivityMetricSelection | null {
  const parsed = parseActivityPublishProposalV7MetricFields(fields);
  if (parsed.metricRequirementCode === null) return null;
  return parseActivityMetricSelection({
    metricRequirementCode: parsed.metricRequirementCode,
    metricSetPointer: parsed.metricSetPointer,
  });
}

export function sameActivityPublishProposalV7MetricFields(
  left: ActivityPublishProposalV7MetricFields,
  right: ActivityPublishProposalV7MetricFields,
): boolean {
  const parsedLeft = parseActivityPublishProposalV7MetricFields(left);
  const parsedRight = parseActivityPublishProposalV7MetricFields(right);
  return (
    parsedLeft.metricRequirementCode === parsedRight.metricRequirementCode &&
    parsedLeft.metricSelectionRevision === parsedRight.metricSelectionRevision &&
    sameActivityPublishProposalV7MetricSelection(parsedLeft, parsedRight)
  );
}

/** Pointer equality without revision: used to reject a synthetic no-op selection write. */
export function sameActivityPublishProposalV7MetricSelection(
  left: ActivityPublishProposalV7MetricFields,
  right: ActivityPublishProposalV7MetricFields,
): boolean {
  const parsedLeft = parseActivityPublishProposalV7MetricFields(left);
  const parsedRight = parseActivityPublishProposalV7MetricFields(right);
  return (
    parsedLeft.metricRequirementCode === parsedRight.metricRequirementCode &&
    parsedLeft.metricSetPointer?.id === parsedRight.metricSetPointer?.id &&
    parsedLeft.metricSetPointer?.code === parsedRight.metricSetPointer?.code &&
    parsedLeft.metricSetPointer?.version === parsedRight.metricSetPointer?.version &&
    parsedLeft.metricSetPointer?.schemaVersion === parsedRight.metricSetPointer?.schemaVersion &&
    parsedLeft.metricSetPointer?.definitionHash === parsedRight.metricSetPointer?.definitionHash
  );
}

/** Advance only for a real metric-selection change; an explicit unchanged selection is retained. */
export function nextActivityPublishProposalV7MetricRevision(revision: number): number {
  const current = metricInteger(revision, 0, 2147483647);
  if (current === 2147483647) throw new TypeError('metric selection revision overflow');
  return metricInteger(current + 1, 1, 2147483647);
}

/**
 * V7 permits retaining a historical unconfigured row, but never writing *to* it. An old
 * published Activity can therefore make an unrelated V7 change while its selection stays
 * untouched, or explicitly move from revision 0 to a configured selection at revision 1.
 */
export function assertActivityPublishProposalV7MetricTransition(
  base: ActivityPublishProposalV7MetricFields,
  target: ActivityPublishProposalV7MetricFields,
): boolean {
  const parsedBase = parseActivityPublishProposalV7MetricFields(base);
  const parsedTarget = parseActivityPublishProposalV7MetricFields(target);
  if (parsedTarget.metricRequirementCode === null) {
    if (
      parsedBase.metricRequirementCode === null &&
      sameActivityPublishProposalV7MetricFields(parsedBase, parsedTarget)
    ) {
      return false;
    }
    throw new TypeError('new V7 proposal cannot clear to unconfigured metric selection');
  }
  if (parsedBase.metricRequirementCode === null) {
    if (parsedTarget.metricSelectionRevision !== 1) {
      throw new TypeError('unconfigured metric selection must advance to revision one');
    }
    return true;
  }
  if (parsedTarget.metricSelectionRevision === parsedBase.metricSelectionRevision) {
    if (!sameActivityPublishProposalV7MetricFields(parsedBase, parsedTarget)) {
      throw new TypeError('retained metric selection changed without revision');
    }
    return false;
  }
  if (parsedTarget.metricSelectionRevision !== parsedBase.metricSelectionRevision + 1) {
    throw new TypeError('invalid metric selection revision transition');
  }
  if (sameActivityPublishProposalV7MetricSelection(parsedBase, parsedTarget)) {
    throw new TypeError('metric selection revision advanced without selection change');
  }
  return true;
}
