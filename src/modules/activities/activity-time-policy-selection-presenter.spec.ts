import {
  activityTimePolicySelectionHash,
  createActivityTimePolicySelectionDocument,
} from './activity-time-policy-selection';
import {
  presentActivityTimePolicySelection,
  presentActivityTimePolicySelectionItem,
  readStoredActivityTimePolicySelection,
} from './activity-time-policy-selection-presenter';

const pointer = {
  policyId: 'policy-one',
  versionId: 'version-one',
  definitionHash: 'a'.repeat(64),
};
const template = { layerCode: 'template' as const, sessionId: null, positionId: null };
const activity = { layerCode: 'activity' as const, sessionId: null, positionId: null };
const session = { layerCode: 'session' as const, sessionId: 'session-one', positionId: null };

function fixture() {
  const document = createActivityTimePolicySelectionDocument([
    { scope: template, selection: { mode: 'explicit' as const, pointer } },
    { scope: activity, selection: { mode: 'inherit' as const, pointer: null } },
    {
      scope: session,
      selection: {
        mode: 'explicit' as const,
        pointer: { ...pointer, versionId: 'version-two' },
      },
    },
  ]);
  return {
    document,
    stored: {
      selectionJson: document,
      selectionHash: activityTimePolicySelectionHash(document),
      itemCount: Object.keys(document.items).length,
    },
  };
}

describe('D1-3 time policy selection presenter', () => {
  it('proves stored JSON, hash and item count form one immutable closure', () => {
    const { document, stored } = fixture();
    expect(readStoredActivityTimePolicySelection(stored)).toEqual(document);
    expect(() =>
      readStoredActivityTimePolicySelection({ ...stored, selectionHash: 'b'.repeat(64) }),
    ).toThrow('inconsistent');
    expect(() => readStoredActivityTimePolicySelection({ ...stored, itemCount: 2 })).toThrow(
      'inconsistent',
    );
  });

  it('only presents manifest-backed page items and a resolved target summary', () => {
    const { document } = fixture();
    const response = presentActivityTimePolicySelection({
      activityId: 'activity-one',
      selectionRevisionId: 'revision-one',
      revision: 3,
      selectionHash: activityTimePolicySelectionHash(document),
      createdAt: new Date('2026-09-11T00:00:00.000Z'),
      document,
      pageItems: [
        {
          layerCode: 'activity',
          sessionId: null,
          positionId: null,
          mode: 'inherit',
          policyId: null,
          versionId: null,
          definitionHash: null,
        },
        {
          layerCode: 'session',
          sessionId: 'session-one',
          positionId: null,
          mode: 'explicit',
          policyId: pointer.policyId,
          versionId: 'version-two',
          definitionHash: pointer.definitionHash,
        },
      ],
      total: 3,
      page: 1,
      pageSize: 2,
      targets: [
        { sessionId: 'session-one', positionIds: ['position-one'] },
        { sessionId: 'session-two', positionIds: [] },
      ],
    });

    expect(response).toEqual({
      activityId: 'activity-one',
      selectionRevisionId: 'revision-one',
      revision: 3,
      selectionHash: activityTimePolicySelectionHash(document),
      createdAt: '2026-09-11T00:00:00.000Z',
      items: [
        { scope: activity, selection: { mode: 'inherit', pointer: null } },
        {
          scope: session,
          selection: {
            mode: 'explicit',
            pointer: { ...pointer, versionId: 'version-two' },
          },
        },
      ],
      total: 3,
      page: 1,
      pageSize: 2,
      resolutionSummary: { targetCount: 4, resolvedTargetCount: 4, unresolvedTargetCount: 0 },
    });
  });

  it('rejects a row that cannot be the exact immutable manifest item', () => {
    const { document } = fixture();
    expect(() =>
      presentActivityTimePolicySelection({
        activityId: 'activity-one',
        selectionRevisionId: 'revision-one',
        revision: 1,
        selectionHash: activityTimePolicySelectionHash(document),
        createdAt: new Date(0),
        document,
        pageItems: [
          {
            layerCode: 'session',
            sessionId: 'session-one',
            positionId: null,
            mode: 'explicit',
            policyId: pointer.policyId,
            versionId: 'other-version',
            definitionHash: pointer.definitionHash,
          },
        ],
        total: 3,
        page: 1,
        pageSize: 20,
        targets: [{ sessionId: 'session-one', positionIds: [] }],
      }),
    ).toThrow('differs');
  });

  it('does not turn a malformed physical row into a selectable pointer', () => {
    expect(() =>
      presentActivityTimePolicySelectionItem({
        layerCode: 'activity',
        sessionId: null,
        positionId: null,
        mode: 'explicit',
        policyId: pointer.policyId,
        versionId: null,
        definitionHash: pointer.definitionHash,
      }),
    ).toThrow(TypeError);
  });
});
