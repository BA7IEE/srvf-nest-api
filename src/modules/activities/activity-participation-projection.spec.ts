import {
  projectParticipation,
  projectParticipationDurations,
} from './activity-participation-projection';

const identity = (overrides: Record<string, unknown> = {}) => ({
  activityId: 'a1',
  identityId: 'i1',
  sessionId: 's1',
  memberId: 'm1',
  resultCode: null as string | null,
  populationIncluded: true,
  revisions: [{ revision: 1, statusCode: 'pass', sourceCode: 'self' }],
  ...overrides,
});

describe('v1.1 participation member projection', () => {
  it('counts a posted present result even if no value is supplied; several sessions count once', () => {
    expect(
      projectParticipation([
        identity({ resultCode: 'present' }),
        identity({ identityId: 'i2', sessionId: 's2', resultCode: 'absent' }),
      ]),
    ).toEqual([
      {
        activityId: 'a1',
        memberId: 'm1',
        outcome: 'attended',
        origin: 'registered',
        identityIds: ['i1', 'i2'],
      },
    ]);
  });

  it('does not turn an unposted session into an absence, even beside a posted absence', () => {
    expect(
      projectParticipation([
        identity({ resultCode: 'absent' }),
        identity({ identityId: 'i2', sessionId: 's2', resultCode: null }),
      ])[0].outcome,
    ).toBe('pending');
    expect(projectParticipation([identity({ resultCode: 'absent' })])[0].outcome).toBe('no-show');
  });

  it('does not count an excluded unposted identity as pending or drop a posted result after exclusion', () => {
    expect(projectParticipation([identity({ populationIncluded: false })])[0].outcome).toBe(
      'excluded',
    );
    expect(
      projectParticipation([identity({ populationIncluded: false, resultCode: 'present' })])[0]
        .outcome,
    ).toBe('attended');
    expect(
      projectParticipation([
        identity({ resultCode: 'absent' }),
        identity({ identityId: 'i2', sessionId: 's2', populationIncluded: false }),
      ])[0].outcome,
    ).toBe('no-show');
  });

  it.each([
    'leave',
    'early_departure_zero',
    'exempt',
    'cancelled',
    'not_selected',
    'waitlist_expired',
    'review_expired',
    'invitation_expired',
  ])('keeps the formal %s result separate from attendance and absence', (resultCode) => {
    expect(projectParticipation([identity({ resultCode })])[0].outcome).toBe('other');
  });

  it('derives admission sources from pass revisions, including onsite reuse of a rejected identity', () => {
    expect(
      projectParticipation([
        identity({
          revisions: [
            { revision: 2, statusCode: 'cancelled', sourceCode: 'admin' },
            { revision: 1, statusCode: 'pass', sourceCode: 'onsite' },
          ],
        }),
      ])[0].origin,
    ).toBe('onsite');
    expect(
      projectParticipation([
        identity({
          revisions: [
            { revision: 1, statusCode: 'rejected', sourceCode: 'self' },
            { revision: 2, statusCode: 'pass', sourceCode: 'onsite' },
          ],
        }),
      ])[0].origin,
    ).toBe('onsite');
    expect(
      projectParticipation([
        identity({
          revisions: [
            { revision: 1, statusCode: 'pass', sourceCode: 'self' },
            { revision: 2, statusCode: 'pass', sourceCode: 'onsite' },
          ],
        }),
      ])[0].origin,
    ).toBe('mixed');
  });

  it('reports a mixture or unknown origin instead of inventing onsite status', () => {
    expect(
      projectParticipation([
        identity({ revisions: [{ revision: 1, statusCode: 'pass', sourceCode: 'onsite' }] }),
        identity({
          identityId: 'i2',
          sessionId: 's2',
          revisions: [{ revision: 1, statusCode: 'pass', sourceCode: 'self' }],
        }),
      ])[0].origin,
    ).toBe('mixed');
    expect(projectParticipation([identity({ revisions: [] })])[0].origin).toBe('unknown');
    expect(
      projectParticipation([
        identity({ revisions: [{ revision: 1, statusCode: 'pass', sourceCode: 'onsite' }] }),
        identity({ identityId: 'i2', sessionId: 's2', revisions: [] }),
      ])[0].origin,
    ).toBe('unknown');
  });

  it('keeps separate activities distinct and rejects duplicate identities, sessions or unknown results', () => {
    expect(
      projectParticipation([
        identity({ resultCode: 'present' }),
        identity({ activityId: 'a2', identityId: 'i2', resultCode: 'absent' }),
      ]).map((item) => item.activityId),
    ).toEqual(['a1', 'a2']);
    expect(() => projectParticipation([identity(), identity()])).toThrow();
    expect(() => projectParticipation([identity(), identity({ identityId: 'i2' })])).toThrow();
    expect(() => projectParticipation([identity({ resultCode: 'invented' })])).toThrow();
  });
});

describe('v1.1 member duration histogram', () => {
  it('keeps known zero, exact boundaries and missing source distinct', () => {
    expect(
      projectParticipationDurations([0, 7199, 7200, 14399, 14400, 28799, 28800, null]),
    ).toEqual({
      histogram: { under2Hours: 2, from2To4Hours: 2, from4To8Hours: 2, atLeast8Hours: 1 },
      missingCount: 1,
    });
  });
  it.each([-1, 0.5, NaN, Infinity])('rejects invalid seconds %s', (seconds) => {
    expect(() => projectParticipationDurations([seconds])).toThrow();
  });
});
