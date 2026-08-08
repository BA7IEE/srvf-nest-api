import { hashOnsiteParticipationRequest } from './onsite-participation-request-hash';

describe('hashOnsiteParticipationRequest', () => {
  const base = {
    actorUserId: 'user-1',
    activityId: 'activity-1',
    memberId: 'member-1',
    sessionId: 'session-1',
    positionId: null,
    reason: '现场补录',
  };

  it('uses a stable SHA-256 hash and normalizes approval-reason whitespace', () => {
    expect(hashOnsiteParticipationRequest(base)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashOnsiteParticipationRequest({ ...base, reason: '  现场补录  ' })).toBe(
      hashOnsiteParticipationRequest(base),
    );
  });

  it.each([
    ['actor', { ...base, actorUserId: 'user-2' }],
    ['activity', { ...base, activityId: 'activity-2' }],
    ['member', { ...base, memberId: 'member-2' }],
    ['session', { ...base, sessionId: 'session-2' }],
    ['position', { ...base, positionId: 'position-1' }],
    ['reason', { ...base, reason: '改为现场补录' }],
  ])('changes when the %s payload component changes', (_name, changed) => {
    expect(hashOnsiteParticipationRequest(changed)).not.toBe(hashOnsiteParticipationRequest(base));
  });
});
