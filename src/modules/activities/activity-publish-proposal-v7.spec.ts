import {
  activitySelectionFromV7MetricFields,
  assertActivityPublishProposalV7MetricTransition,
  metricFieldsFromActivitySelection,
  nextActivityPublishProposalV7MetricRevision,
  parseActivityPublishProposalV7MetricFields,
  sameActivityPublishProposalV7MetricFields,
  type ActivityPublishProposalV7MetricFields,
} from './activity-publish-proposal-v7';

const POINTER = {
  id: 'metric-set-v1',
  code: 'completion_rate',
  version: 1,
  schemaVersion: 1 as const,
  definitionHash: 'a'.repeat(64),
};

function required(revision: number): ActivityPublishProposalV7MetricFields {
  return {
    metricRequirementCode: 'required',
    metricSetPointer: { ...POINTER },
    metricSelectionRevision: revision,
  };
}

describe('Activity publish proposal V7 metric fields', () => {
  it('round-trips only the three allowed persistent shapes without metric definitions or values', () => {
    const unconfigured = parseActivityPublishProposalV7MetricFields({
      metricRequirementCode: null,
      metricSetPointer: null,
      metricSelectionRevision: 0,
    });
    const notRequired = parseActivityPublishProposalV7MetricFields({
      metricRequirementCode: 'not_required',
      metricSetPointer: null,
      metricSelectionRevision: 3,
    });
    const selected = parseActivityPublishProposalV7MetricFields(required(4));

    expect(activitySelectionFromV7MetricFields(unconfigured)).toBeNull();
    expect(activitySelectionFromV7MetricFields(notRequired)).toEqual({
      metricRequirementCode: 'not_required',
      metricSetPointer: null,
    });
    expect(activitySelectionFromV7MetricFields(selected)).toEqual({
      metricRequirementCode: 'required',
      metricSetPointer: POINTER,
    });
    expect(
      metricFieldsFromActivitySelection(activitySelectionFromV7MetricFields(selected), 4),
    ).toEqual(selected);
    expect(JSON.stringify(selected)).not.toContain('definitionJson');
    expect(JSON.stringify(selected)).not.toContain('metricValue');
  });

  it('rejects null commands, partial pointers, unknown keys and non-canonical revision shapes', () => {
    const invalid = [
      null,
      {},
      { metricRequirementCode: null, metricSetPointer: null, metricSelectionRevision: 1 },
      { metricRequirementCode: 'not_required', metricSetPointer: null, metricSelectionRevision: 0 },
      { metricRequirementCode: 'required', metricSetPointer: null, metricSelectionRevision: 1 },
      {
        metricRequirementCode: 'required',
        metricSetPointer: { ...POINTER, definitionHash: 'not-a-hash' },
        metricSelectionRevision: 1,
      },
      { ...required(1), extra: true },
    ];

    for (const value of invalid) {
      expect(() => parseActivityPublishProposalV7MetricFields(value)).toThrow(TypeError);
    }
  });

  it('permits only a retained selection or a real one-step selection change', () => {
    const base = required(4);
    const retained = required(4);
    const changed = {
      metricRequirementCode: 'not_required' as const,
      metricSetPointer: null,
      metricSelectionRevision: 5,
    };

    expect(assertActivityPublishProposalV7MetricTransition(base, retained)).toBe(false);
    expect(sameActivityPublishProposalV7MetricFields(base, retained)).toBe(true);
    expect(assertActivityPublishProposalV7MetricTransition(base, changed)).toBe(true);
    expect(() => assertActivityPublishProposalV7MetricTransition(base, required(5))).toThrow(
      'without selection change',
    );
    expect(() =>
      assertActivityPublishProposalV7MetricTransition(base, {
        ...changed,
        metricSelectionRevision: 6,
      }),
    ).toThrow('invalid metric selection revision transition');
  });

  it('keeps revision overflow fail-closed while allowing only retained or explicit migration out of old unconfigured rows', () => {
    expect(nextActivityPublishProposalV7MetricRevision(0)).toBe(1);
    expect(() => nextActivityPublishProposalV7MetricRevision(2147483647)).toThrow(TypeError);
    const historical = {
      metricRequirementCode: null,
      metricSetPointer: null,
      metricSelectionRevision: 0,
    } as const;
    expect(assertActivityPublishProposalV7MetricTransition(historical, historical)).toBe(false);
    expect(assertActivityPublishProposalV7MetricTransition(historical, required(1))).toBe(true);
    expect(() => assertActivityPublishProposalV7MetricTransition(required(1), historical)).toThrow(
      'clear to unconfigured',
    );
  });
});
