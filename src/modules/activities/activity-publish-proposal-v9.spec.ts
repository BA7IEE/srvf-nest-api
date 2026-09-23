import {
  assertActivityPublishProposalV9ContributionPolicyTransition,
  parseActivityPublishProposalV9ContributionPolicyFields,
  parseActivityRuleSnapshotV9ContributionPolicyPointers,
  sameActivityPublishProposalV9ContributionPolicyFields,
} from './activity-publish-proposal-v9';
import {
  activityContributionPolicySelectionHash,
  activityContributionPolicySelectionScopeKey,
  createActivityContributionPolicySelectionDocument,
} from './activity-contribution-policy-selection';

const pointer = {
  policyId: 'policy-one',
  versionId: 'version-one',
  definitionHash: 'a'.repeat(64),
  evaluatorVersion: 1,
};
const activity = { layerCode: 'activity' as const, sessionId: null, positionId: null };
const selection = createActivityContributionPolicySelectionDocument([
  { scope: activity, selection: { mode: 'explicit', pointer } },
]);

function fields(revision: number, selected = selection) {
  const selectedPointer = Object.values(selected.items)[0].selection.pointer!;
  return {
    contributionPolicyPointers: {
      schemaVersion: 1,
      selectionRevision: revision,
      proposalSelectionHash: activityContributionPolicySelectionHash(selected),
      selection: selected,
      resolved: [
        {
          scope: activity,
          pointer: selectedPointer,
          sourceLayerCode: 'activity',
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          effectiveUntil: null,
        },
      ],
      referenceKinds: {
        [activityContributionPolicySelectionScopeKey(activity)]: {
          sessionRefKind: null,
          positionRefKind: null,
        },
      },
    },
  } as const;
}

describe('E1-3 proposal V9 contribution policy fields', () => {
  it('parses the complete frozen selection and exact scope reference kinds', () => {
    expect(parseActivityPublishProposalV9ContributionPolicyFields(fields(1))).toEqual(fields(1));
    expect(
      parseActivityPublishProposalV9ContributionPolicyFields({
        contributionPolicyPointers: null,
      }),
    ).toEqual({ contributionPolicyPointers: null });
  });

  it('supports a position clientRef without adding a session selection layer', () => {
    const position = {
      layerCode: 'position' as const,
      sessionId: 'new-session',
      positionId: 'new-position',
    };
    const document = createActivityContributionPolicySelectionDocument([
      { scope: activity, selection: { mode: 'explicit', pointer } },
      { scope: position, selection: { mode: 'explicit', pointer } },
    ]);
    const value = {
      contributionPolicyPointers: {
        ...fields(1, document).contributionPolicyPointers,
        resolved: [
          ...fields(1, document).contributionPolicyPointers.resolved,
          {
            scope: position,
            pointer,
            sourceLayerCode: 'position',
            effectiveFrom: '2026-01-01T00:00:00.000Z',
            effectiveUntil: null,
          },
        ],
        referenceKinds: {
          [activityContributionPolicySelectionScopeKey(activity)]: {
            sessionRefKind: null,
            positionRefKind: null,
          },
          [activityContributionPolicySelectionScopeKey(position)]: {
            sessionRefKind: 'clientRef',
            positionRefKind: 'clientRef',
          },
        },
      },
    } as const;
    expect(parseActivityPublishProposalV9ContributionPolicyFields(value)).toEqual(value);
  });

  it('allows retention or a single revision advance and forbids clearing', () => {
    expect(assertActivityPublishProposalV9ContributionPolicyTransition(fields(1), fields(1))).toBe(
      false,
    );
    expect(sameActivityPublishProposalV9ContributionPolicyFields(fields(1), fields(1))).toBe(true);
    expect(
      assertActivityPublishProposalV9ContributionPolicyTransition(
        { contributionPolicyPointers: null },
        fields(1),
      ),
    ).toBe(true);
    expect(() =>
      assertActivityPublishProposalV9ContributionPolicyTransition(fields(1), {
        contributionPolicyPointers: null,
      }),
    ).toThrow('clear');
    expect(() =>
      assertActivityPublishProposalV9ContributionPolicyTransition(fields(1), fields(3)),
    ).toThrow('revision');
  });

  it('binds RuleSnapshot physical identity to the same canonical selection hash', () => {
    const proposal = fields(1).contributionPolicyPointers;
    expect(
      parseActivityRuleSnapshotV9ContributionPolicyPointers({
        ...proposal,
        selectionRevisionId: 'revision-one',
        selectionHash: proposal.proposalSelectionHash,
      }),
    ).toMatchObject({ selectionRevisionId: 'revision-one', selectionRevision: 1 });
    expect(() =>
      parseActivityRuleSnapshotV9ContributionPolicyPointers({
        ...proposal,
        selectionRevisionId: 'revision-one',
        selectionHash: 'b'.repeat(64),
      }),
    ).toThrow('snapshot selection hash');
  });
});
