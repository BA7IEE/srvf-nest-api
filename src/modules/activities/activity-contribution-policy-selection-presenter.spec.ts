import {
  activityContributionPolicySelectionHash,
  createActivityContributionPolicySelectionDocument,
} from './activity-contribution-policy-selection';
import {
  presentActivityContributionPolicySelection,
  presentActivityContributionPolicySelectionItem,
  readStoredActivityContributionPolicySelection,
} from './activity-contribution-policy-selection-presenter';

const pointer = {
  policyId: 'policy-one',
  versionId: 'version-one',
  definitionHash: 'a'.repeat(64),
  evaluatorVersion: 1,
};
const activityScope = {
  layerCode: 'activity' as const,
  sessionId: null,
  positionId: null,
};

function fixture() {
  const document = createActivityContributionPolicySelectionDocument([
    { scope: activityScope, selection: { mode: 'explicit', pointer } },
  ]);
  return {
    document,
    stored: {
      selectionJson: document,
      selectionHash: activityContributionPolicySelectionHash(document),
      itemCount: 1,
    },
  };
}

describe('E1-3 contribution policy selection presenter', () => {
  it('proves the immutable JSON, hash and item count closure', () => {
    const { document, stored } = fixture();
    expect(readStoredActivityContributionPolicySelection(stored)).toEqual(document);
    expect(() =>
      readStoredActivityContributionPolicySelection({
        ...stored,
        selectionHash: 'b'.repeat(64),
      }),
    ).toThrow('inconsistent');
    expect(() =>
      readStoredActivityContributionPolicySelection({ ...stored, itemCount: 2 }),
    ).toThrow('inconsistent');
  });

  it('returns only manifest-backed items and a bounded resolution summary', () => {
    const { document, stored } = fixture();
    const response = presentActivityContributionPolicySelection({
      activityId: 'activity-one',
      selectionRevisionId: 'revision-one',
      revision: 1,
      selectionHash: stored.selectionHash,
      createdAt: new Date('2026-09-23T00:00:00.000Z'),
      document,
      pageItems: [
        {
          layerCode: 'activity',
          sessionId: null,
          positionId: null,
          mode: 'explicit',
          policyId: pointer.policyId,
          versionId: pointer.versionId,
          definitionHash: pointer.definitionHash,
          evaluatorVersion: pointer.evaluatorVersion,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      templateSelection: null,
      targets: [
        {
          sessionId: 'session-one',
          sessionCode: 'session_a',
          positionId: 'position-one',
          positionCode: 'position_a',
        },
      ],
    });
    expect(response.items).toEqual([
      { scope: activityScope, selection: { mode: 'explicit', pointer } },
    ]);
    expect(response.resolutionSummary).toEqual({
      targetCount: 2,
      resolvedTargetCount: 2,
      unresolvedTargetCount: 0,
    });
    expect(response.resolved.map((entry) => entry.sourceLayerCode)).toEqual([
      'activity',
      'activity',
    ]);
  });

  it('rejects malformed physical rows and rows that differ from the manifest', () => {
    expect(() =>
      presentActivityContributionPolicySelectionItem({
        layerCode: 'activity',
        sessionId: null,
        positionId: null,
        mode: 'explicit',
        policyId: pointer.policyId,
        versionId: null,
        definitionHash: pointer.definitionHash,
        evaluatorVersion: 1,
      }),
    ).toThrow(TypeError);
    const { document, stored } = fixture();
    expect(() =>
      presentActivityContributionPolicySelection({
        activityId: 'activity-one',
        selectionRevisionId: 'revision-one',
        revision: 1,
        selectionHash: stored.selectionHash,
        createdAt: new Date(0),
        document,
        pageItems: [
          {
            layerCode: 'activity',
            sessionId: null,
            positionId: null,
            mode: 'explicit',
            policyId: pointer.policyId,
            versionId: 'other-version',
            definitionHash: pointer.definitionHash,
            evaluatorVersion: 1,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
        templateSelection: null,
        targets: [],
      }),
    ).toThrow('differs');
  });
});
