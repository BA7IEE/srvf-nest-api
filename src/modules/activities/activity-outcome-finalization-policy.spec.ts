import {
  assertOutcomeFinalizationAnchors,
  nextFinalizedOutcomeRevision,
} from './activity-outcome-finalization-policy';

describe('C3-2 finalization revision anchors', () => {
  const confirmed = Object.freeze({ id: 'formal', revision: 2, statusCode: 'confirmed' });
  const draft = Object.freeze({ id: 'pending', revision: 3, statusCode: 'draft' });

  it.each(['completed', 'terminated'])(
    'accepts initial system-only confirmation in %s',
    (status) => {
      expect(() => assertOutcomeFinalizationAnchors(status, 0, 0, null, null)).not.toThrow();
    },
  );
  it.each(['draft', 'published', 'cancelled', 'archived', 'unknown'])(
    'rejects writes in %s',
    (status) => {
      expect(() => assertOutcomeFinalizationAnchors(status, 0, 0, null, null)).toThrow();
    },
  );
  it('keeps latest draft distinct from the current formal revision', () => {
    expect(() =>
      assertOutcomeFinalizationAnchors('completed', 3, 2, draft, confirmed),
    ).not.toThrow();
    expect(nextFinalizedOutcomeRevision(draft)).toEqual({
      revision: 4,
      priorRevisionId: 'pending',
    });
  });
  it('rejects a stale formal anchor even when latest matches', () => {
    expect(() => assertOutcomeFinalizationAnchors('completed', 3, 1, draft, confirmed)).toThrow();
  });
  it('rejects a stale latest anchor even when formal matches', () => {
    expect(() => assertOutcomeFinalizationAnchors('completed', 2, 2, draft, confirmed)).toThrow();
  });
  it('permits a retained cancelled head as the next revision predecessor', () => {
    const cancelled = { ...draft, statusCode: 'superseded' };
    expect(() =>
      assertOutcomeFinalizationAnchors('completed', 3, 2, cancelled, confirmed),
    ).not.toThrow();
    expect(nextFinalizedOutcomeRevision(cancelled)).toEqual({
      revision: 4,
      priorRevisionId: 'pending',
    });
  });
  it.each([-1, 0.5, NaN, Infinity, 2147483648])(
    'rejects invalid expected latest %s',
    (revision) => {
      expect(() =>
        assertOutcomeFinalizationAnchors('completed', revision, 0, null, null),
      ).toThrow();
    },
  );
  it.each([-1, 0.5, NaN, Infinity])('rejects invalid expected formal %s', (revision) => {
    expect(() => assertOutcomeFinalizationAnchors('completed', 0, revision, null, null)).toThrow();
  });
  it('does not allocate past the PostgreSQL integer limit', () => {
    const last = { ...confirmed, revision: 2147483647 };
    expect(() =>
      assertOutcomeFinalizationAnchors('completed', last.revision, last.revision, last, last),
    ).not.toThrow();
    expect(() => nextFinalizedOutcomeRevision(last)).toThrow();
  });
});
