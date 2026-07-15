import { Prisma } from '@prisma/client';
import { ACTIVITY_REGISTRATION_STATUS } from '../activity-registrations/activity-registration-state-machine';
import { ATTENDANCE_SHEET_STATUS } from '../attendances/attendances.dto';

// 审计刀 5:活动参与度量的纯内存核算核。输入必须由调用方一次性批量取出，禁止在此查询。
// F2 与 meta overview 共用同一核，确保逐活动与跨活动聚合口径不会分叉。

export const DURATION_HISTOGRAM_BUCKETS = ['[0,2)', '[2,4)', '[4,8)', '[8,∞)'] as const;

export interface ParticipationRegistrationMetricRow {
  id: string;
  memberId: string;
  statusCode: string;
}

export interface ParticipationRecordMetricRow {
  memberId: string;
  serviceHours: Prisma.Decimal;
  contributionPoints: Prisma.Decimal | null;
  sheet: { statusCode: string };
}

export interface DurationHistogramMetric {
  under2Hours: number;
  from2To4Hours: number;
  from4To8Hours: number;
  atLeast8Hours: number;
}

export interface ActivityParticipationMetrics {
  registrationCounts: {
    total: number;
    pending: number;
    pass: number;
    reject: number;
    cancelled: number;
  };
  attendeeCount: number;
  registeredAttendeeCount: number;
  temporaryAttendeeCount: number;
  noShowCount: number;
  attendanceRate: number;
  totalServiceHours: Prisma.Decimal;
  totalContributionPoints: Prisma.Decimal;
  durationHistogram: DurationHistogramMetric;
}

export function buildActivityParticipationMetrics(
  activityStatusCode: string,
  registrations: readonly ParticipationRegistrationMetricRow[],
  records: readonly ParticipationRecordMetricRow[],
): ActivityParticipationMetrics {
  const registrationCounts = {
    total: registrations.length,
    pending: 0,
    pass: 0,
    reject: 0,
    cancelled: 0,
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
    }
  }

  const passMemberIds = new Set(
    registrations
      .filter((registration) => registration.statusCode === ACTIVITY_REGISTRATION_STATUS.PASS)
      .map((registration) => registration.memberId),
  );
  const registeredMemberIds = new Set(registrations.map((registration) => registration.memberId));
  // 任意状态 Sheet 的未软删 record 都是到场证据；pending 也绝不能被误判为 no-show。
  const attendeeMemberIds = new Set(records.map((record) => record.memberId));
  const registeredAttendeeCount = [...passMemberIds].filter((memberId) =>
    attendeeMemberIds.has(memberId),
  ).length;
  const temporaryAttendeeCount = [...attendeeMemberIds].filter(
    (memberId) => !registeredMemberIds.has(memberId),
  ).length;

  const approvedRecords = records.filter(
    (record) => record.sheet.statusCode === ATTENDANCE_SHEET_STATUS.APPROVED,
  );
  let totalServiceHours = new Prisma.Decimal(0);
  let totalContributionPoints = new Prisma.Decimal(0);
  const durationHistogram: DurationHistogramMetric = {
    under2Hours: 0,
    from2To4Hours: 0,
    from4To8Hours: 0,
    atLeast8Hours: 0,
  };
  for (const record of approvedRecords) {
    totalServiceHours = totalServiceHours.add(record.serviceHours);
    totalContributionPoints = totalContributionPoints.add(
      record.contributionPoints ?? new Prisma.Decimal(0),
    );
    const hours = record.serviceHours.toNumber();
    if (hours < 2) durationHistogram.under2Hours += 1;
    else if (hours < 4) durationHistogram.from2To4Hours += 1;
    else if (hours < 8) durationHistogram.from4To8Hours += 1;
    else durationHistogram.atLeast8Hours += 1;
  }

  return {
    registrationCounts,
    attendeeCount: attendeeMemberIds.size,
    registeredAttendeeCount,
    temporaryAttendeeCount,
    noShowCount:
      activityStatusCode === 'completed' ? passMemberIds.size - registeredAttendeeCount : 0,
    attendanceRate:
      passMemberIds.size === 0
        ? 0
        : Number((registeredAttendeeCount / passMemberIds.size).toFixed(4)),
    totalServiceHours,
    totalContributionPoints,
    durationHistogram,
  };
}
