import { presentActivityOutcomeDetail, type OutcomeDetailRow } from './activity-outcome-presenter';

/** Current formal facts only; historical definitions remain interpreted at their retained version. */
export function presentConfirmedActivityOutcome(row: OutcomeDetailRow) {
  if (row.statusCode !== 'confirmed' || row.values.length < 1)
    throw new TypeError('missing formal outcome');
  const detail = presentActivityOutcomeDetail(row);
  const definitions = new Set(row.values.map((value) => value.metricDefinitionId));
  if (
    definitions.size !== row.values.length ||
    row.metricSetVersion.items.some(
      (item) => item.required && !definitions.has(item.metricDefinitionId),
    )
  )
    throw new TypeError('incomplete formal outcome');
  const first = row.values[0];
  if (
    !first.confirmedByUserId ||
    !first.confirmedAt ||
    !Number.isFinite(first.confirmedAt.getTime())
  )
    throw new TypeError('missing confirmation metadata');
  const confirmedAt = first.confirmedAt.toISOString();
  for (const value of row.values) {
    if (
      value.confirmedByUserId !== first.confirmedByUserId ||
      value.confirmedAt?.toISOString() !== confirmedAt ||
      (value.sourceCode !== 'manual' && value.sourceCode !== 'system') ||
      !value.evidence.length ||
      new Set(value.evidence.map((link) => link.attachmentId)).size !== value.evidence.length ||
      new Set(value.evidence.map((link) => link.sortOrder)).size !== value.evidence.length
    )
      throw new TypeError('invalid formal outcome metadata or evidence');
  }
  return { ...detail, isCurrentConfirmed: true, confirmedAt };
}
