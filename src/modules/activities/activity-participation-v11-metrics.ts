import { ACTIVITY_REGISTRATION_STATUS } from '../activity-registrations/activity-registration-state-machine';
import type { ActivityParticipationSummaryDto } from './activity-participation.dto';
import { decimalToHundredths, hundredthsToDecimal } from './ledger-day-allocation';
import {
  buildRegistrationCounts,
  type ParticipationRegistrationMetricRow,
} from './activity-participation-metrics';
import {
  projectParticipation,
  projectParticipationDurations,
  type ParticipationIdentityFact,
} from './activity-participation-projection';
import {
  eligibleSecondsToServiceHours,
  sumOfficialEligibleSeconds,
} from './participation-time-truth-query.service';

type V11Metrics = Omit<
  ActivityParticipationSummaryDto,
  'activityId' | 'activityStatusCode' | 'feedback'
>;

/** Same activity-level projection for the activity and monthly views; all inputs share a snapshot. */
export function buildV11ParticipationMetrics(args: {
  registrations: readonly ParticipationRegistrationMetricRow[];
  facts: readonly ParticipationIdentityFact[];
  ledgerRows: readonly { memberId: string; serviceHours: string; creditedPoints: string }[];
  /** null = no receipt; an empty array with a receipt is a known empty source, not a zero row. */
  officialRows: readonly { memberId: string; eligibleSeconds: number }[] | null;
}): V11Metrics {
  const members = projectParticipation(args.facts);
  const attended = members.filter((member) => member.outcome === 'attended');
  const noShowCount = members.filter((member) => member.outcome === 'no-show').length;
  const knownMemberIds = new Set(
    members.filter((member) => member.outcome !== 'excluded').map((member) => member.memberId),
  );
  const registrationOnly = new Set(
    args.registrations
      .filter(
        (registration) =>
          registration.statusCode === ACTIVITY_REGISTRATION_STATUS.PASS &&
          !knownMemberIds.has(registration.memberId),
      )
      .map((registration) => registration.memberId),
  );
  const ledgerByMember = new Map<string, { serviceHours: string; creditedPoints: string }>();
  let serviceHundredths = 0;
  let creditedHundredths = 0;
  for (const row of args.ledgerRows) {
    if (ledgerByMember.has(row.memberId)) throw new TypeError('duplicate member ledger totals');
    ledgerByMember.set(row.memberId, row);
    const hours = decimalToHundredths(row.serviceHours);
    const points = decimalToHundredths(row.creditedPoints);
    if (
      !Number.isSafeInteger(hours) ||
      !Number.isSafeInteger(points) ||
      !Number.isSafeInteger(serviceHundredths + hours) ||
      !Number.isSafeInteger(creditedHundredths + points)
    ) {
      throw new RangeError('participation totals exceed safe integer precision');
    }
    serviceHundredths += hours;
    creditedHundredths += points;
  }
  const officialByMember = new Map<string, number>();
  for (const row of args.officialRows ?? []) {
    if (officialByMember.has(row.memberId)) throw new TypeError('duplicate member official time');
    officialByMember.set(row.memberId, row.eligibleSeconds);
  }
  const durations = projectParticipationDurations(
    attended.map((member) => {
      if (args.officialRows !== null) return officialByMember.get(member.memberId) ?? null;
      const hours = ledgerByMember.get(member.memberId)?.serviceHours;
      return hours === undefined ? null : decimalToHundredths(hours) * 36;
    }),
  );
  const totalHours =
    args.officialRows === null
      ? hundredthsToDecimal(serviceHundredths).toString()
      : eligibleSecondsToServiceHours(sumOfficialEligibleSeconds(args.officialRows)).toString();
  const denominator = attended.length + noShowCount;
  return {
    registrationCounts: buildRegistrationCounts(args.registrations),
    attendeeCount: attended.length,
    registeredAttendeeCount: attended.filter((member) => member.origin === 'registered').length,
    temporaryAttendeeCount: attended.filter((member) => member.origin === 'onsite').length,
    mixedOriginAttendeeCount: attended.filter((member) => member.origin === 'mixed').length,
    unknownOriginAttendeeCount: attended.filter((member) => member.origin === 'unknown').length,
    noShowCount,
    pendingCount:
      members.filter((member) => member.outcome === 'pending').length + registrationOnly.size,
    pendingSessionCount: args.facts.filter(
      (fact) => fact.resultCode === null && fact.populationIncluded,
    ).length,
    otherResultCount: members.filter((member) => member.outcome === 'other').length,
    attendanceRate: denominator === 0 ? null : Number((attended.length / denominator).toFixed(4)),
    totalServiceHours: durations.missingCount === 0 ? totalHours : null,
    totalContributionPoints: hundredthsToDecimal(creditedHundredths).toString(),
    durationHistogram: durations.histogram,
    durationUnknownCount: durations.missingCount,
  };
}
