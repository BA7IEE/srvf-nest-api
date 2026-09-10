import type {
  AppActivityEndingWorkbenchDto,
  AppActivityEndingNoticeDto,
} from './dto/app/app-ending-workbench.dto';

type EndingFacts = Omit<AppActivityEndingWorkbenchDto, 'notices'>;

/** Only projects validated facts. No authorization, database access or executable capabilities. */
export function presentEndingWorkbench(facts: EndingFacts): AppActivityEndingWorkbenchDto {
  const notices: AppActivityEndingNoticeDto[] = [];
  if (facts.metricRequirementCode === 'unconfigured')
    notices.push({ code: 'metric_selection_unconfigured', target: 'metric_selection' });
  if (facts.metricRequirementCode === 'required' && !facts.currentConfirmed)
    notices.push({ code: 'formal_outcome_missing', target: 'outcome_history' });
  if (facts.pendingDraft)
    notices.push({
      code: facts.pendingDraft.kind === 'initial' ? 'initial_draft_pending' : 'correction_pending',
      target: 'outcome_history',
    });
  const formal = facts.currentConfirmed;
  const draft = facts.pendingDraft;
  return {
    activityId: facts.activityId,
    activityStatusCode: facts.activityStatusCode,
    metricRequirementCode: facts.metricRequirementCode,
    metricSelectionRevision: facts.metricSelectionRevision,
    selectedMetricSetVersionId: facts.selectedMetricSetVersionId,
    currentConfirmed: formal
      ? {
          id: formal.id,
          revision: formal.revision,
          metricSetVersionId: formal.metricSetVersionId,
          confirmedAt: formal.confirmedAt,
          valueCount: formal.valueCount,
        }
      : null,
    pendingDraft: draft
      ? {
          id: draft.id,
          revision: draft.revision,
          kind: draft.kind,
          baseConfirmedRevision: draft.baseConfirmedRevision,
        }
      : null,
    notices,
  };
}
