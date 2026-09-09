import { presentEndingWorkbench } from './activity-ending-workbench-presenter';

describe('C4 ending workbench projection', () => {
  const base = {
    activityId: 'activity',
    activityStatusCode: 'completed',
    metricRequirementCode: 'required' as const,
    metricSelectionRevision: 1,
    selectedMetricSetVersionId: 'set',
    currentConfirmed: null,
    pendingDraft: null,
  };
  it('does not replace missing formal facts with zero values', () => {
    expect(presentEndingWorkbench(base)).toEqual({
      ...base,
      notices: [{ code: 'formal_outcome_missing', target: 'outcome_history' }],
    });
  });
  it('does not demand formal values when explicitly not required', () => {
    expect(
      presentEndingWorkbench({ ...base, metricRequirementCode: 'not_required' }).notices,
    ).toEqual([]);
  });
  it('keeps unconfigured separate from not required', () => {
    expect(
      presentEndingWorkbench({ ...base, metricRequirementCode: 'unconfigured' }).notices,
    ).toEqual([{ code: 'metric_selection_unconfigured', target: 'metric_selection' }]);
  });
  it('orders missing formal and initial draft notices deterministically', () => {
    expect(
      presentEndingWorkbench({
        ...base,
        pendingDraft: {
          id: 'draft',
          revision: 1,
          kind: 'initial',
          baseConfirmedRevision: null,
        },
      }).notices.map((n) => n.code),
    ).toEqual(['formal_outcome_missing', 'initial_draft_pending']);
  });
  it('keeps the formal version visible during correction without returning extra fields', () => {
    const formal = {
      id: 'formal',
      revision: 2,
      metricSetVersionId: 'old-set',
      confirmedAt: '2026-09-09T00:00:00.000Z',
      valueCount: 1,
      privateField: 'not for response',
    };
    const result = presentEndingWorkbench({
      ...base,
      currentConfirmed: formal,
      pendingDraft: {
        id: 'draft',
        revision: 3,
        kind: 'correction',
        baseConfirmedRevision: 2,
      },
    });
    expect(result.currentConfirmed).toEqual({
      id: 'formal',
      revision: 2,
      metricSetVersionId: 'old-set',
      confirmedAt: formal.confirmedAt,
      valueCount: 1,
    });
    expect(result.notices).toEqual([{ code: 'correction_pending', target: 'outcome_history' }]);
    expect(Object.keys(result).sort()).toEqual(
      [
        'activityId',
        'activityStatusCode',
        'currentConfirmed',
        'metricRequirementCode',
        'metricSelectionRevision',
        'notices',
        'pendingDraft',
        'selectedMetricSetVersionId',
      ].sort(),
    );
  });
});
