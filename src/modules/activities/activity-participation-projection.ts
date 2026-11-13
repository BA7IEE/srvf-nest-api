import {
  buildOfficialDurationHistogram,
  type DurationHistogramMetric,
} from './activity-participation-metrics';

/** A committed result for the current posted version, or null while this identity is undecided. */
export interface ParticipationIdentityFact {
  activityId: string;
  identityId: string;
  sessionId: string;
  memberId: string;
  resultCode: string | null;
  /** Current unsettled population; posted results remain relevant even when this later changes. */
  populationIncluded: boolean;
  /** Application-append-only participation revisions, including status at each revision. */
  revisions: readonly { revision: number; statusCode: string; sourceCode: string }[];
}

export interface MemberParticipationProjection {
  activityId: string;
  memberId: string;
  outcome: 'attended' | 'no-show' | 'pending' | 'other' | 'excluded';
  origin: 'registered' | 'onsite' | 'mixed' | 'unknown';
  identityIds: string[];
}

const OTHER_RESULTS = new Set([
  'leave',
  'cancelled',
  'not_selected',
  'waitlist_expired',
  'review_expired',
  'invitation_expired',
  'exempt',
  'early_departure_zero',
]);

function identityOrigin(
  revisions: ParticipationIdentityFact['revisions'],
): 'onsite' | 'registered' | 'mixed' | 'unknown' {
  if (revisions.length === 0) return 'unknown';
  const seen = new Set<number>();
  let maxRevision = 0;
  let onsitePass = false;
  let registeredPass = false;
  let unknownPass = false;
  for (const revision of revisions) {
    if (
      !Number.isSafeInteger(revision.revision) ||
      revision.revision <= 0 ||
      seen.has(revision.revision)
    ) {
      throw new TypeError('invalid participation revision sequence');
    }
    seen.add(revision.revision);
    maxRevision = Math.max(maxRevision, revision.revision);
    if (revision.statusCode !== 'pass') continue;
    if (revision.sourceCode === 'onsite') onsitePass = true;
    else if (['self', 'admin', 'invitation'].includes(revision.sourceCode)) registeredPass = true;
    else unknownPass = true;
  }
  if (maxRevision !== revisions.length) throw new TypeError('incomplete participation revisions');
  if (unknownPass) return 'unknown';
  if (onsitePass && registeredPass) return 'mixed';
  if (onsitePass) return 'onsite';
  if (registeredPass) return 'registered';
  return 'unknown';
}

/**
 * Project one person per activity; do not infer a result from hours, points, a punch,
 * missing data, or a different activity. All facts must be read from one snapshot.
 */
export function projectParticipation(
  facts: readonly ParticipationIdentityFact[],
): MemberParticipationProjection[] {
  const groups = new Map<string, ParticipationIdentityFact[]>();
  const seenIdentities = new Set<string>();
  const seenSessions = new Set<string>();
  for (const fact of facts) {
    const sessionKey = JSON.stringify([fact.activityId, fact.memberId, fact.sessionId]);
    if (seenIdentities.has(fact.identityId) || seenSessions.has(sessionKey)) {
      throw new TypeError('duplicate participation identity or activity-member-session');
    }
    if (
      fact.resultCode !== null &&
      fact.resultCode !== 'present' &&
      fact.resultCode !== 'absent' &&
      !OTHER_RESULTS.has(fact.resultCode)
    ) {
      throw new TypeError('unknown settlement result');
    }
    seenIdentities.add(fact.identityId);
    seenSessions.add(sessionKey);
    const key = JSON.stringify([fact.activityId, fact.memberId]);
    const group = groups.get(key) ?? [];
    group.push(fact);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const relevant = group.filter((row) => row.resultCode !== null || row.populationIncluded);
      const results = relevant.map((row) => row.resultCode);
      const outcome: MemberParticipationProjection['outcome'] =
        results.length === 0
          ? 'excluded'
          : results.includes('present')
            ? 'attended'
            : results.includes(null)
              ? 'pending'
              : results.every((code) => code === 'absent')
                ? 'no-show'
                : 'other';
      const origins = new Set(relevant.map((row) => identityOrigin(row.revisions)));
      const origin: MemberParticipationProjection['origin'] =
        origins.size === 0 || origins.has('unknown')
          ? 'unknown'
          : origins.has('mixed') || origins.size > 1
            ? 'mixed'
            : origins.has('onsite')
              ? 'onsite'
              : 'registered';
      return {
        activityId: group[0].activityId,
        memberId: group[0].memberId,
        outcome,
        origin,
        identityIds: group.map((row) => row.identityId).sort(),
      };
    })
    .sort(
      (left, right) =>
        left.activityId.localeCompare(right.activityId) ||
        left.memberId.localeCompare(right.memberId),
    );
}

/** Missing duration is reported separately; a known zero belongs in the first bucket. */
export function projectParticipationDurations(seconds: readonly (number | null)[]): {
  histogram: DurationHistogramMetric;
  missingCount: number;
} {
  const known = seconds.filter((value): value is number => value !== null);
  return {
    histogram: buildOfficialDurationHistogram(
      known.map((eligibleSeconds) => ({ eligibleSeconds })),
    ),
    missingCount: seconds.length - known.length,
  };
}
