import {
  firstUnavailableCapacityTarget,
  isCapacityReservationNoop,
  normalizeCapacityReservationIdentityIds,
  normalizeCapacityReservationSelections,
  planCapacityReservationDeltas,
  sortCapacityReservationTargets,
} from './capacity-reservation.service';

describe('capacity reservation planning helpers', () => {
  it('deduplicates exact choices, orders identities, and rejects conflicting positions', () => {
    expect(
      normalizeCapacityReservationSelections([
        { identityId: 'identity-b', positionId: 'position-b' },
        { identityId: 'identity-a' },
        { identityId: 'identity-b', positionId: 'position-b' },
      ]),
    ).toEqual([
      { identityId: 'identity-a', positionId: null },
      { identityId: 'identity-b', positionId: 'position-b' },
    ]);
    expect(
      normalizeCapacityReservationSelections([
        { identityId: 'identity-a', positionId: 'position-a' },
        { identityId: 'identity-a', positionId: 'position-b' },
      ]),
    ).toBeNull();
  });

  it('normalizes release ids and lock targets in stable order', () => {
    expect(
      normalizeCapacityReservationIdentityIds(['identity-c', 'identity-a', 'identity-c']),
    ).toEqual(['identity-a', 'identity-c']);
    expect(
      sortCapacityReservationTargets([
        { scopeTypeCode: 'session_participation', scopeId: 'session-b' },
        { scopeTypeCode: 'activity_person', scopeId: 'activity-a' },
        { scopeTypeCode: 'session_participation', scopeId: 'session-a' },
      ]),
    ).toEqual([
      { scopeTypeCode: 'activity_person', scopeId: 'activity-a' },
      { scopeTypeCode: 'session_participation', scopeId: 'session-a' },
      { scopeTypeCode: 'session_participation', scopeId: 'session-b' },
    ]);
  });

  it('collapses bucket deltas so one changed bucket has one CAS version advance', () => {
    expect(
      planCapacityReservationDeltas([
        {
          target: { scopeTypeCode: 'session_participation', scopeId: 'session-a' },
          delta: 1,
        },
        {
          target: { scopeTypeCode: 'position_participation', scopeId: 'position-a' },
          delta: 1,
        },
        {
          target: { scopeTypeCode: 'session_participation', scopeId: 'session-a' },
          delta: 1,
        },
      ]),
    ).toEqual([
      {
        target: { scopeTypeCode: 'position_participation', scopeId: 'position-a' },
        delta: 1,
      },
      {
        target: { scopeTypeCode: 'session_participation', scopeId: 'session-a' },
        delta: 2,
      },
    ]);
  });

  it('selects the first unavailable finite scope in stable bucket order', () => {
    expect(
      firstUnavailableCapacityTarget(
        [
          {
            id: 'bucket-session',
            scopeTypeCode: 'session_participation',
            scopeId: 'session-a',
            capacity: 1,
            occupied: 1,
          },
          {
            id: 'bucket-position',
            scopeTypeCode: 'position_participation',
            scopeId: 'position-a',
            capacity: 1,
            occupied: 1,
          },
          {
            id: 'bucket-unlimited',
            scopeTypeCode: 'activity_person',
            scopeId: 'activity-a',
            capacity: null,
            occupied: 100,
          },
        ],
        [
          {
            target: { scopeTypeCode: 'session_participation', scopeId: 'session-a' },
            delta: 1,
          },
          {
            target: { scopeTypeCode: 'position_participation', scopeId: 'position-a' },
            delta: 1,
          },
          {
            target: { scopeTypeCode: 'activity_person', scopeId: 'activity-a' },
            delta: 1,
          },
        ],
      ),
    ).toEqual({ scopeTypeCode: 'position_participation', scopeId: 'position-a' });
    expect(isCapacityReservationNoop(0)).toBe(true);
    expect(isCapacityReservationNoop(1)).toBe(false);
  });
});
