import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  activityContributionPolicySelectionHash,
  applyActivityContributionPolicySelectionChanges,
  createActivityContributionPolicySelectionDocument,
  emptyActivityContributionPolicySelectionDocument,
  parseActivityContributionPolicySelectionDocument,
  parseActivityContributionPolicySelectionReceipt,
  resolveActivityContributionPolicySelection,
  type ActivityContributionPolicyPointer,
} from './activity-contribution-policy-selection';

const pointer = (suffix: string): ActivityContributionPolicyPointer => ({
  policyId: `policy-${suffix}`,
  versionId: `version-${suffix}`,
  definitionHash: suffix.repeat(64).slice(0, 64),
  evaluatorVersion: 1,
});

const root = { layerCode: 'activity' as const, sessionId: null, positionId: null };
const position = {
  layerCode: 'position' as const,
  sessionId: 'session-1',
  positionId: 'position-1',
};
const targets = [
  {
    sessionId: 'session-1',
    sessionCode: 'morning',
    positionId: 'position-1',
    positionCode: 'leader',
  },
];

describe('activity contribution-policy selection', () => {
  it('builds a stable canonical full revision', () => {
    const first = createActivityContributionPolicySelectionDocument([
      { scope: position, selection: { mode: 'explicit', pointer: pointer('b') } },
      { scope: root, selection: { mode: 'explicit', pointer: pointer('a') } },
    ]);
    const second = createActivityContributionPolicySelectionDocument([
      { scope: root, selection: { mode: 'explicit', pointer: pointer('a') } },
      { scope: position, selection: { mode: 'explicit', pointer: pointer('b') } },
    ]);
    expect(first).toEqual(second);
    expect(activityContributionPolicySelectionHash(first)).toHaveLength(64);
    expect(parseActivityContributionPolicySelectionDocument(first)).toEqual(first);
  });

  it('rejects session layers, partial pointers, duplicate scopes and missing root', () => {
    expect(() =>
      createActivityContributionPolicySelectionDocument([
        {
          scope: { layerCode: 'session' as never, sessionId: 's', positionId: null },
          selection: { mode: 'inherit', pointer: null },
        },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      parseActivityContributionPolicySelectionDocument({
        schemaVersion: 1,
        items: {
          'activity:-:-': {
            scope: root,
            selection: {
              mode: 'explicit',
              pointer: {
                policyId: 'p',
                versionId: 'v',
                definitionHash: 'a'.repeat(64),
              },
            },
          },
        },
      }),
    ).toThrow(TypeError);
    expect(() =>
      createActivityContributionPolicySelectionDocument([
        { scope: root, selection: { mode: 'inherit', pointer: null } },
        { scope: root, selection: { mode: 'inherit', pointer: null } },
      ]),
    ).toThrow(TypeError);
    expect(() => createActivityContributionPolicySelectionDocument([])).toThrow(TypeError);
  });

  it('resolves template, activity and position layers without field merging', () => {
    const document = emptyActivityContributionPolicySelectionDocument();
    const template = {
      activityDefault: { mode: 'explicit' as const, pointer: pointer('a') },
      positionOverrides: [
        { sessionCode: 'morning', positionCode: 'leader', pointer: pointer('b') },
      ],
    };
    expect(resolveActivityContributionPolicySelection(document, template, targets)).toEqual([
      { scope: root, pointer: pointer('a'), sourceLayerCode: 'template' },
      { scope: position, pointer: pointer('b'), sourceLayerCode: 'template' },
    ]);

    const activityOverride = applyActivityContributionPolicySelectionChanges(document, [
      { scope: root, selection: { mode: 'explicit', pointer: pointer('c') } },
    ]);
    expect(resolveActivityContributionPolicySelection(activityOverride, template, targets)).toEqual(
      [
        { scope: root, pointer: pointer('c'), sourceLayerCode: 'activity' },
        { scope: position, pointer: pointer('c'), sourceLayerCode: 'activity' },
      ],
    );

    const positionOverride = applyActivityContributionPolicySelectionChanges(activityOverride, [
      { scope: position, selection: { mode: 'explicit', pointer: pointer('d') } },
    ]);
    expect(
      resolveActivityContributionPolicySelection(positionOverride, template, targets)[1],
    ).toEqual({ scope: position, pointer: pointer('d'), sourceLayerCode: 'position' });
  });

  it('uses position inherit as removal while retaining history in prior document', () => {
    const before = createActivityContributionPolicySelectionDocument([
      { scope: root, selection: { mode: 'inherit', pointer: null } },
      { scope: position, selection: { mode: 'explicit', pointer: pointer('b') } },
    ]);
    const after = applyActivityContributionPolicySelectionChanges(before, [
      { scope: position, selection: { mode: 'inherit', pointer: null } },
    ]);
    expect(Object.keys(before.items)).toHaveLength(2);
    expect(Object.keys(after.items)).toHaveLength(1);
  });

  it('rejects unknown target references in both activity and template layers', () => {
    const withUnknown = createActivityContributionPolicySelectionDocument([
      { scope: root, selection: { mode: 'inherit', pointer: null } },
      {
        scope: { ...position, positionId: 'missing' },
        selection: { mode: 'explicit', pointer: pointer('a') },
      },
    ]);
    expect(() => resolveActivityContributionPolicySelection(withUnknown, null, targets)).toThrow(
      TypeError,
    );
    expect(() =>
      resolveActivityContributionPolicySelection(
        emptyActivityContributionPolicySelectionDocument(),
        {
          activityDefault: { mode: 'inherit', pointer: null },
          positionOverrides: [
            { sessionCode: 'missing', positionCode: 'missing', pointer: pointer('a') },
          ],
        },
        targets,
      ),
    ).toThrow(TypeError);
  });

  it('parses only the closed replay receipt and maps malformed data to the dedicated BizCode', () => {
    const value = {
      activityId: 'activity-1',
      selectionRevisionId: 'revision-1',
      revision: 1,
      selectionHash: 'a'.repeat(64),
      createdAt: '2026-09-23T12:00:00.000Z',
    };
    expect(parseActivityContributionPolicySelectionReceipt(value, 'activity-1')).toEqual(value);
    try {
      parseActivityContributionPolicySelectionReceipt(
        { ...value, evaluatorVersion: 1 },
        'activity-1',
      );
      throw new Error('expected receipt rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(BizException);
      expect((error as BizException).biz.code).toBe(
        BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_RECEIPT_INVALID.code,
      );
    }
  });
});
