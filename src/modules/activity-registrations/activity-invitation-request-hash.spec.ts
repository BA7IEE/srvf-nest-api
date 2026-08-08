import { hashActivityInvitationDecline } from './activity-invitation-request-hash';

describe('hashActivityInvitationDecline', () => {
  const base = {
    actorUserId: 'user-1',
    memberId: 'member-1',
    invitationId: 'invitation-1',
    reason: null,
  };

  it('uses a stable canonical SHA-256 fingerprint for the same payload', () => {
    const first = hashActivityInvitationDecline(base);
    const second = hashActivityInvitationDecline({
      reason: null,
      invitationId: 'invitation-1',
      memberId: 'member-1',
      actorUserId: 'user-1',
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['actor', { ...base, actorUserId: 'user-2' }],
    ['member', { ...base, memberId: 'member-2' }],
    ['invitation', { ...base, invitationId: 'invitation-2' }],
    ['reason', { ...base, reason: '不能参加' }],
  ])('changes when the %s payload component changes', (_name, changed) => {
    expect(hashActivityInvitationDecline(changed)).not.toBe(hashActivityInvitationDecline(base));
  });
});
