import { assertOutcomeCandidateRevision } from './activity-outcome-candidate-validation';

describe('C3-2 candidate outcome revision relationship', () => {
  it('accepts direct confirmation at exactly the calculation revision', () => {
    expect(() => assertOutcomeCandidateRevision(3, { latestRevision: 3 })).not.toThrow();
  });
  it('rejects a direct candidate after any intervening revision', () => {
    expect(() => assertOutcomeCandidateRevision(3, { latestRevision: 4 })).toThrow();
  });
  it('allows only the current correction draft own version advance', () => {
    expect(() =>
      assertOutcomeCandidateRevision(3, {
        latestRevision: 4,
        prepared: { draftRevision: 4, priorRevision: 3, preparedAgainstRevision: 3 },
      }),
    ).not.toThrow();
  });
  it.each([
    { draftRevision: 4, priorRevision: 2, preparedAgainstRevision: 3 },
    { draftRevision: 4, priorRevision: 3, preparedAgainstRevision: 2 },
    { draftRevision: 3, priorRevision: 2, preparedAgainstRevision: 2 },
    { draftRevision: 4, priorRevision: NaN, preparedAgainstRevision: 3 },
  ])('rejects a forged or stale preparation relationship %j', (prepared) => {
    expect(() => assertOutcomeCandidateRevision(3, { latestRevision: 4, prepared })).toThrow();
  });
  it('rejects an external revision after draft preparation', () => {
    expect(() =>
      assertOutcomeCandidateRevision(3, {
        latestRevision: 5,
        prepared: { draftRevision: 4, priorRevision: 3, preparedAgainstRevision: 3 },
      }),
    ).toThrow();
  });
  it.each([-1, NaN, Infinity, 0.5, 2147483648])(
    'rejects invalid retained version %s',
    (revision) => {
      expect(() =>
        assertOutcomeCandidateRevision(revision, { latestRevision: revision }),
      ).toThrow();
    },
  );
});
