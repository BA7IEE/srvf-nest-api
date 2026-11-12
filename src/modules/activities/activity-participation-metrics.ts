import { ACTIVITY_REGISTRATION_STATUS } from '../activity-registrations/activity-registration-state-machine';

// 审计刀 5:活动参与度量的纯内存核算核。输入必须由调用方一次性批量取出，禁止在此查询。
// F2 与 meta overview 共用同一核，确保逐活动与跨活动聚合口径不会分叉。

export const DURATION_HISTOGRAM_BUCKETS = ['[0,2)', '[2,4)', '[4,8)', '[8,∞)'] as const;

export interface ParticipationRegistrationMetricRow {
  id: string;
  memberId: string;
  statusCode: string;
}

export interface DurationHistogramMetric {
  under2Hours: number;
  from2To4Hours: number;
  from4To8Hours: number;
  atLeast8Hours: number;
}

export interface OfficialParticipationTimeMetricRow {
  eligibleSeconds: number;
}

/** D8-2: one exact-seconds observation per (activityId, memberId), including zero. */
export function buildOfficialDurationHistogram(
  rows: readonly OfficialParticipationTimeMetricRow[],
): DurationHistogramMetric {
  const result: DurationHistogramMetric = {
    under2Hours: 0,
    from2To4Hours: 0,
    from4To8Hours: 0,
    atLeast8Hours: 0,
  };
  for (const row of rows) {
    if (!Number.isSafeInteger(row.eligibleSeconds) || row.eligibleSeconds < 0) {
      throw new RangeError('invalid official participation time');
    }
    if (row.eligibleSeconds < 7_200) result.under2Hours += 1;
    else if (row.eligibleSeconds < 14_400) result.from2To4Hours += 1;
    else if (row.eligibleSeconds < 28_800) result.from4To8Hours += 1;
    else result.atLeast8Hours += 1;
  }
  return result;
}

export interface ParticipationRegistrationCounts {
  total: number;
  pending: number;
  pass: number;
  reject: number;
  cancelled: number;
  waitlisted: number;
}

export function buildRegistrationCounts(
  registrations: readonly ParticipationRegistrationMetricRow[],
): ParticipationRegistrationCounts {
  const registrationCounts = {
    total: registrations.length,
    pending: 0,
    pass: 0,
    reject: 0,
    cancelled: 0,
    waitlisted: 0,
  };
  for (const registration of registrations) {
    switch (registration.statusCode) {
      case ACTIVITY_REGISTRATION_STATUS.PENDING:
        registrationCounts.pending += 1;
        break;
      case ACTIVITY_REGISTRATION_STATUS.PASS:
        registrationCounts.pass += 1;
        break;
      case ACTIVITY_REGISTRATION_STATUS.REJECT:
        registrationCounts.reject += 1;
        break;
      case ACTIVITY_REGISTRATION_STATUS.CANCELLED:
        registrationCounts.cancelled += 1;
        break;
      case ACTIVITY_REGISTRATION_STATUS.WAITLISTED:
        registrationCounts.waitlisted += 1;
        break;
    }
  }
  return registrationCounts;
}
