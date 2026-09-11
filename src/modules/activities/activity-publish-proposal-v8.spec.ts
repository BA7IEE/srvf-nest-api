import {
  assertActivityPublishProposalV8TimePolicyTransition,
  parseActivityPublishProposalV8TimePolicyFields,
  sameActivityPublishProposalV8TimePolicyFields,
} from './activity-publish-proposal-v8';
import {
  activityTimePolicySelectionHash,
  activityTimePolicySelectionScopeKey,
  createActivityTimePolicySelectionDocument,
} from './activity-time-policy-selection';

const pointer = { policyId: 'policy', versionId: 'version', definitionHash: 'a'.repeat(64) };
const activity = { layerCode: 'activity' as const, sessionId: null, positionId: null };
const selection = createActivityTimePolicySelectionDocument([
  { scope: activity, selection: { mode: 'explicit', pointer } },
]);
const nextSelection = createActivityTimePolicySelectionDocument([
  {
    scope: activity,
    selection: {
      mode: 'explicit' as const,
      pointer: { ...pointer, definitionHash: 'c'.repeat(64) },
    },
  },
]);
function fields(revision: number, selected = selection) {
  const selectedPointer = Object.values(selected.items)[0].selection.pointer!;
  return {
    timePolicyPointers: {
      schemaVersion: 1,
      selectionRevision: revision,
      proposalSelectionHash: activityTimePolicySelectionHash(selected),
      selection: selected,
      resolved: [
        {
          scope: activity,
          pointer: selectedPointer,
          evaluatorVersion: 1,
          sourceScope: activity,
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          effectiveUntil: null,
        },
      ],
      referenceKinds: {
        [activityTimePolicySelectionScopeKey(activity)]: {
          sessionRefKind: null,
          positionRefKind: null,
        },
      },
    },
  } as const;
}

describe('D1-3 proposal V8 time policy fields', () => {
  it('keeps the complete selection and safe resolved pointer facts in a strict envelope', () => {
    expect(parseActivityPublishProposalV8TimePolicyFields(fields(1))).toEqual(fields(1));
    expect(parseActivityPublishProposalV8TimePolicyFields({ timePolicyPointers: null })).toEqual({
      timePolicyPointers: null,
    });
  });

  it('preserves explicit clientRef kinds for targets created by the same change review', () => {
    const session = { layerCode: 'session' as const, sessionId: 'new-session', positionId: null };
    const position = {
      layerCode: 'position' as const,
      sessionId: 'new-session',
      positionId: 'new-position',
    };
    const clientRefSelection = createActivityTimePolicySelectionDocument([
      { scope: activity, selection: { mode: 'explicit', pointer } },
      { scope: position, selection: { mode: 'explicit', pointer } },
    ]);
    const value = {
      timePolicyPointers: {
        schemaVersion: 1,
        selectionRevision: 2,
        proposalSelectionHash: activityTimePolicySelectionHash(clientRefSelection),
        selection: clientRefSelection,
        resolved: [
          {
            scope: activity,
            pointer,
            evaluatorVersion: 1,
            sourceScope: activity,
            effectiveFrom: '2026-01-01T00:00:00.000Z',
            effectiveUntil: null,
          },
          {
            scope: position,
            pointer,
            evaluatorVersion: 1,
            sourceScope: position,
            effectiveFrom: '2026-01-01T00:00:00.000Z',
            effectiveUntil: null,
          },
          {
            scope: session,
            pointer,
            evaluatorVersion: 1,
            sourceScope: activity,
            effectiveFrom: '2026-01-01T00:00:00.000Z',
            effectiveUntil: null,
          },
        ],
        referenceKinds: {
          [activityTimePolicySelectionScopeKey(activity)]: {
            sessionRefKind: null,
            positionRefKind: null,
          },
          [activityTimePolicySelectionScopeKey(session)]: {
            sessionRefKind: 'clientRef',
            positionRefKind: null,
          },
          [activityTimePolicySelectionScopeKey(position)]: {
            sessionRefKind: 'clientRef',
            positionRefKind: 'clientRef',
          },
        },
      },
    } as const;

    expect(parseActivityPublishProposalV8TimePolicyFields(value)).toEqual(value);
    expect(() =>
      parseActivityPublishProposalV8TimePolicyFields({
        timePolicyPointers: {
          ...value.timePolicyPointers,
          referenceKinds: {
            [activityTimePolicySelectionScopeKey(activity)]: {
              sessionRefKind: null,
              positionRefKind: null,
            },
          },
        },
      }),
    ).toThrow('reference kinds');
  });

  it.each([
    { timePolicyPointers: { ...fields(1).timePolicyPointers, extra: true } },
    { timePolicyPointers: { ...fields(1).timePolicyPointers, selectionRevision: 0 } },
    {
      timePolicyPointers: {
        ...fields(1).timePolicyPointers,
        resolved: [
          ...fields(1).timePolicyPointers.resolved,
          ...fields(1).timePolicyPointers.resolved,
        ],
      },
    },
    {
      timePolicyPointers: {
        ...fields(1).timePolicyPointers,
        resolved: [{ ...fields(1).timePolicyPointers.resolved[0], evaluatorVersion: 2 }],
      },
    },
  ])('rejects incomplete or ambiguous V8 fields %#', (value) =>
    expect(() => parseActivityPublishProposalV8TimePolicyFields(value)).toThrow(),
  );

  it('allows only retained selection or a one-step semantic advance', () => {
    expect(assertActivityPublishProposalV8TimePolicyTransition(fields(1), fields(1))).toBe(false);
    expect(sameActivityPublishProposalV8TimePolicyFields(fields(1), fields(1))).toBe(true);
    expect(
      assertActivityPublishProposalV8TimePolicyTransition({ timePolicyPointers: null }, fields(1)),
    ).toBe(true);
    expect(
      assertActivityPublishProposalV8TimePolicyTransition(fields(1), fields(2, nextSelection)),
    ).toBe(true);
    expect(() =>
      assertActivityPublishProposalV8TimePolicyTransition(fields(1), { timePolicyPointers: null }),
    ).toThrow('clear');
    expect(() => assertActivityPublishProposalV8TimePolicyTransition(fields(1), fields(3))).toThrow(
      'transition',
    );
  });
});
