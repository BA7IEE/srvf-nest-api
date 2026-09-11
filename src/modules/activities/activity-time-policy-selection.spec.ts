import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  activityTimePolicySelectionHash,
  activityTimePolicySelectionScopeKey,
  applyActivityTimePolicySelectionChanges,
  createActivityTimePolicySelectionDocument,
  emptyActivityTimePolicySelectionDocument,
  parseActivityTimePolicySelectionDocument,
  parseActivityTimePolicySelectionReceipt,
  parseActivityTimePolicySelectionScope,
  parseActivityTimePolicySelectionValue,
  resolveActivityTimePolicySelection,
} from './activity-time-policy-selection';

const POINTER = {
  policyId: 'policy-one',
  versionId: 'version-one',
  definitionHash: 'a'.repeat(64),
};
const activity = { layerCode: 'activity' as const, sessionId: null, positionId: null };
const session = { layerCode: 'session' as const, sessionId: 'session-one', positionId: null };
const position = {
  layerCode: 'position' as const,
  sessionId: 'session-one',
  positionId: 'position-one',
};
const explicit = { mode: 'explicit' as const, pointer: POINTER };
const inherit = { mode: 'inherit' as const, pointer: null };

describe('D1-3 activity time policy selection grammar', () => {
  it('requires exact four-level scope shapes and exact selection values', () => {
    expect(parseActivityTimePolicySelectionScope(activity)).toEqual(activity);
    expect(parseActivityTimePolicySelectionScope(session)).toEqual(session);
    expect(parseActivityTimePolicySelectionScope(position)).toEqual(position);
    expect(parseActivityTimePolicySelectionValue(explicit)).toEqual(explicit);
    expect(parseActivityTimePolicySelectionValue(inherit)).toEqual(inherit);
    for (const value of [
      { layerCode: 'session', sessionId: null, positionId: null },
      { layerCode: 'position', sessionId: 'session-one', positionId: null },
      { layerCode: 'activity', sessionId: 'session-one', positionId: null },
      { layerCode: 'unknown', sessionId: null, positionId: null },
    ]) {
      expect(() => parseActivityTimePolicySelectionScope(value)).toThrow(TypeError);
    }
    for (const value of [
      { mode: 'inherit', pointer: POINTER },
      { mode: 'explicit', pointer: null },
      { mode: 'explicit', pointer: { ...POINTER, definitionHash: 'A'.repeat(64) } },
      { mode: 'inherit', pointer: null, extra: true },
    ]) {
      expect(() => parseActivityTimePolicySelectionValue(value)).toThrow(TypeError);
    }
  });

  it('canonicalizes scope-keyed documents independent of item input order', () => {
    const first = createActivityTimePolicySelectionDocument([
      { scope: activity, selection: inherit },
      { scope: session, selection: explicit },
    ]);
    const second = createActivityTimePolicySelectionDocument([
      { scope: session, selection: explicit },
      { scope: activity, selection: inherit },
    ]);
    expect(activityTimePolicySelectionHash(first)).toBe(activityTimePolicySelectionHash(second));
    expect(Object.keys(first.items)).toEqual(Object.keys(second.items));
    expect(first.items[activityTimePolicySelectionScopeKey(activity)]).toEqual({
      scope: activity,
      selection: inherit,
    });
  });

  it('rejects duplicate/mismatched keyed item manifests and a missing activity root', () => {
    expect(() =>
      createActivityTimePolicySelectionDocument([
        { scope: activity, selection: inherit },
        { scope: activity, selection: explicit },
      ]),
    ).toThrow('duplicate');
    expect(() =>
      createActivityTimePolicySelectionDocument([{ scope: session, selection: explicit }]),
    ).toThrow('activity root');
    expect(() =>
      parseActivityTimePolicySelectionDocument({
        schemaVersion: 1,
        items: { wrong: { scope: activity, selection: inherit } },
      }),
    ).toThrow('key');
  });

  it('retains activity inherit but removes session/position inherit overrides in a new revision', () => {
    const configured = createActivityTimePolicySelectionDocument([
      { scope: activity, selection: explicit },
      { scope: session, selection: explicit },
      { scope: position, selection: explicit },
    ]);
    const next = applyActivityTimePolicySelectionChanges(configured, [
      { scope: activity, selection: inherit },
      { scope: session, selection: inherit },
      { scope: position, selection: inherit },
    ]);
    expect(next.items[activityTimePolicySelectionScopeKey(activity)]).toEqual({
      scope: activity,
      selection: inherit,
    });
    expect(next.items[activityTimePolicySelectionScopeKey(session)]).toBeUndefined();
    expect(next.items[activityTimePolicySelectionScopeKey(position)]).toBeUndefined();
  });

  it('resolves only the nearest explicit pointer and never invents a default', () => {
    const document = createActivityTimePolicySelectionDocument([
      {
        scope: { layerCode: 'template', sessionId: null, positionId: null },
        selection: explicit,
      },
      { scope: activity, selection: inherit },
      { scope: session, selection: { mode: 'explicit', pointer: { ...POINTER, versionId: 'v2' } } },
      { scope: position, selection: inherit },
    ]);
    const rows = resolveActivityTimePolicySelection(document, [
      { sessionId: 'session-one', positionIds: ['position-one'] },
      { sessionId: 'session-two', positionIds: [] },
    ]);
    expect(rows).toEqual([
      {
        scope: activity,
        pointer: POINTER,
        sourceScope: { layerCode: 'template', sessionId: null, positionId: null },
      },
      {
        scope: session,
        pointer: { ...POINTER, versionId: 'v2' },
        sourceScope: session,
      },
      {
        scope: position,
        pointer: { ...POINTER, versionId: 'v2' },
        sourceScope: session,
      },
      {
        scope: { layerCode: 'session', sessionId: 'session-two', positionId: null },
        pointer: POINTER,
        sourceScope: { layerCode: 'template', sessionId: null, positionId: null },
      },
    ]);
    expect(
      resolveActivityTimePolicySelection(emptyActivityTimePolicySelectionDocument(), []),
    ).toEqual([{ scope: activity, pointer: null, sourceScope: null }]);
  });

  it('rejects unknown target IDs instead of silently dropping overrides', () => {
    const document = createActivityTimePolicySelectionDocument([
      { scope: activity, selection: inherit },
      { scope: session, selection: explicit },
    ]);
    expect(() => resolveActivityTimePolicySelection(document, [])).toThrow('unknown session');
  });

  it('keeps replay receipts closed, activity-bound and free of operation identities', () => {
    const receipt = {
      activityId: 'activity-one',
      selectionRevisionId: 'revision-one',
      revision: 1,
      selectionHash: 'b'.repeat(64),
      createdAt: '2026-09-11T00:00:00.000Z',
    };
    expect(parseActivityTimePolicySelectionReceipt(receipt, 'activity-one')).toEqual(receipt);
    for (const value of [
      { ...receipt, activityId: 'other' },
      { ...receipt, actorUserId: 'leak' },
      { ...receipt, selectionHash: 'B'.repeat(64) },
      { ...receipt, createdAt: '2026-09-11' },
    ]) {
      try {
        parseActivityTimePolicySelectionReceipt(value, 'activity-one');
        throw new Error('invalid receipt was accepted');
      } catch (error) {
        expect(error).toMatchObject({
          biz: BizCode.ACTIVITY_TIME_POLICY_SELECTION_RECEIPT_INVALID,
        });
      }
    }
  });
});
