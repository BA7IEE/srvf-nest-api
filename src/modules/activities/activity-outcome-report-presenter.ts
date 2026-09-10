import type { OutcomeDetailRow } from './activity-outcome-presenter';
import { presentConfirmedActivityOutcome } from './activity-outcome-confirmed-presenter';
import type { AppActivityOutcomeReportDto } from './dto/app/app-activity-outcome-report.dto';

type ReportContext = {
  activityId: string;
  activityStatusCode: string;
  metricRequirementCode: 'unconfigured' | 'not_required' | 'required';
  metricSelectionRevision: number;
};

/** Validate the complete formal fact, then project only report fields. Never spread a DB row. */
export function presentActivityOutcomeReport(
  context: ReportContext,
  row: OutcomeDetailRow | null,
): AppActivityOutcomeReportDto {
  if (row && row.activityId !== context.activityId) throw new TypeError('report activity mismatch');
  const formal = row ? presentConfirmedActivityOutcome(row) : null;
  return {
    activityId: context.activityId,
    activityStatusCode: context.activityStatusCode,
    metricRequirementCode: context.metricRequirementCode,
    metricSelectionRevision: context.metricSelectionRevision,
    formalStatus: formal ? 'confirmed' : 'not_confirmed',
    currentConfirmed:
      formal && row
        ? {
            outcomeRevisionId: formal.outcomeRevisionId,
            revision: formal.revision,
            metricSetVersionId: formal.metricSetVersionId,
            metricSetDefinitionHash: formal.metricSetDefinitionHash,
            confirmedAt: formal.confirmedAt,
            metrics: formal.values.map((value) => {
              const configuration = value.definition.configuration;
              if (configuration.kindCode === 'short_text')
                throw new TypeError('sensitive report kind');
              const item = row.metricSetVersion.items.find(
                (entry) => entry.metricDefinitionId === value.metricDefinitionId,
              );
              if (!item || (value.sourceCode !== 'manual' && value.sourceCode !== 'system'))
                throw new TypeError('invalid report definition or source');
              return {
                valueRevisionId: value.valueRevisionId,
                metricDefinitionId: value.metricDefinitionId,
                definitionHash: item.metricDefinition.definitionHash,
                definition: {
                  schemaVersion: value.definition.schemaVersion,
                  code: value.definition.code,
                  version: value.definition.version,
                  name: value.definition.name,
                  configuration,
                },
                value: value.value,
                sourceCode: value.sourceCode,
              };
            }),
          }
        : null,
  };
}
