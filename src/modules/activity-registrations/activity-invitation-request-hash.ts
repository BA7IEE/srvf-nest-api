import { createHash } from 'node:crypto';

export type ActivityInvitationDeclineHashInput = {
  actorUserId: string;
  memberId: string;
  invitationId: string;
  reason: string | null;
};

type CanonicalValue = null | string | { [key: string]: CanonicalValue };

function canonicalize(value: CanonicalValue): string {
  if (value === null || typeof value === 'string') return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(',')}}`;
}

/**
 * Decline is a self action with a per-invitation operation key.  Keep the fingerprint limited to
 * stable identifiers and the normalized optional reason; free text is never copied into audit.
 */
export function hashActivityInvitationDecline(input: ActivityInvitationDeclineHashInput): string {
  return createHash('sha256')
    .update(
      canonicalize({
        actorUserId: input.actorUserId,
        invitationId: input.invitationId,
        memberId: input.memberId,
        reason: input.reason,
      }),
    )
    .digest('hex');
}
