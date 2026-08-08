import { createHash } from 'node:crypto';

export type OnsiteParticipationRequestHashInput = {
  actorUserId: string;
  activityId: string;
  memberId: string;
  sessionId: string;
  positionId: string | null;
  reason: string;
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
 * The operation key is stored separately.  This digest establishes whether the request it names
 * is the same managed onsite conversion; the approval reason deliberately uses its normalized
 * storage value so surrounding whitespace cannot create a second fact.
 */
export function hashOnsiteParticipationRequest(input: OnsiteParticipationRequestHashInput): string {
  return createHash('sha256')
    .update(
      canonicalize({
        activityId: input.activityId,
        actorUserId: input.actorUserId,
        memberId: input.memberId,
        positionId: input.positionId,
        reason: input.reason.trim(),
        sessionId: input.sessionId,
      }),
    )
    .digest('hex');
}
