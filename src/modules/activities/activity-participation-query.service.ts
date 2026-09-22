import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import type { ResourceRef } from '../authz/authz.types';
import { ACTIVITY_REGISTRATION_STATUS } from '../activity-registrations/activity-registration-state-machine';
import { ActivityFeedbacksQueryService } from '../activity-feedbacks/activity-feedbacks-query.service';
import { ATTENDANCE_SHEET_STATUS } from '../attendances/attendances.dto';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { LedgerQueryService } from './ledger-query.service';
import { decimalToHundredths, hundredthsToDecimal } from './ledger-day-allocation';
import { RbacService } from '../permissions/rbac.service';
import {
  ActivityParticipationSummaryDto,
  ActivityReconciliationDto,
} from './activity-participation.dto';
import {
  buildActivityParticipationMetrics,
  buildOfficialDurationHistogram,
} from './activity-participation-metrics';
import { toMemberLabelFields } from '../../common/identity/member-label.util';
import {
  ParticipationTimeTruthQueryService,
  eligibleSecondsToServiceHours,
  sumOfficialEligibleSeconds,
} from './participation-time-truth-query.service';

/**
 * 「活动 × 队员」小计 → 活动两轴总计。**整数分累加**,不用浮点 ——
 * 逐队员字符串直接 `Number` 相加会在末位漂出 `5.000000000000001`。
 */
function foldActivityTotals(
  byMember: ReadonlyMap<string, { serviceHours: string; creditedPoints: string }>,
): { totalServiceHours: string; totalContributionPoints: string } {
  let serviceHundredths = 0;
  let creditedHundredths = 0;
  for (const totals of byMember.values()) {
    serviceHundredths += decimalToHundredths(totals.serviceHours);
    creditedHundredths += decimalToHundredths(totals.creditedPoints);
  }
  return {
    totalServiceHours: hundredthsToDecimal(serviceHundredths).toString(),
    totalContributionPoints: hundredthsToDecimal(creditedHundredths).toString(),
  };
}

const PARTICIPATION_READ_ACTIONS = [
  'attendance.read.sheet',
  'activity-registration.read.record',
] as const;

@Injectable()
export class ActivityParticipationQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly rbac: RbacService,
    private readonly feedbacks: ActivityFeedbacksQueryService,
    private readonly ledgerQuery: LedgerQueryService,
    private readonly participationTimeTruth: ParticipationTimeTruthQueryService,
    // 活动 v1.1 cutover gate —— 统计读面取数源的判闸依据(合同 §16.2 单轨第三项)。
    private readonly activityWorkflowGate: ActivityWorkflowGate,
  ) {}

  private async readOfficialTime(activityId: string) {
    return this.prisma.$transaction(
      (tx) => this.participationTimeTruth.readOfficialTotalsInTx(tx, { activityIds: [activityId] }),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  private async assertCanReadActivity(
    currentUser: CurrentUserPayload,
    activityId: string,
  ): Promise<void> {
    const ref: ResourceRef = { type: 'activity', id: activityId };
    for (const action of PARTICIPATION_READ_ACTIONS) {
      const decision = await this.authz.explain(currentUser, action, ref);
      if (decision.allow) continue;
      if (decision.reason === 'resource_not_found' && (await this.rbac.can(currentUser, action))) {
        continue;
      }
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  private async findActivityOrThrow(
    activityId: string,
  ): Promise<{ id: string; statusCode: string }> {
    const activity = await this.prisma.activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: { id: true, statusCode: true },
    });
    if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return activity;
  }

  /**
   * 闸开后的取数:工时 / 贡献值来自**已 committed 的账本分录**(按队员折)。
   *
   * 🔴 **D8 receipt 之前，本闸只切「结算量」这一轴** —— 逐队员的服务时长与贡献值。
   *    名册与计数(谁到场 / recordCount / durationHistogram)在当时刻意不随闸切换:
   *    合同拍板的闸控范围是「结算真相链」,**不含 Session / Participation / Registration**
   *    (`docs/ai-harness/NEXT_TASKS.md` 第 7 批第 ③ 刀);而「参与活动数 / 记录条数在账本
   *    口径下如何定义」是**已登记的悬案 D1**,维护者明文「不在无数据时凭空发明语义」。
   *    D8-2 只在不可变 cutover receipt 存在后，把工时和直方图改接 exact-seconds
   *    truth selector；报名、到场、计数和贡献仍保留上述既有来源。
   */
  private async loadCommittedTotalsByMember(
    activityId: string,
  ): Promise<Map<string, { serviceHours: string; creditedPoints: string }>> {
    const rows = await this.ledgerQuery.sumCommittedByMemberForActivities([activityId]);
    return new Map(
      rows.map((row) => [
        row.memberId,
        { serviceHours: row.serviceHours, creditedPoints: row.creditedPoints },
      ]),
    );
  }

  async reconciliation(
    activityId: string,
    currentUser: CurrentUserPayload,
  ): Promise<ActivityReconciliationDto> {
    await this.assertCanReadActivity(currentUser, activityId);
    const activity = await this.findActivityOrThrow(activityId);
    if (activity.statusCode !== 'completed') {
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    }

    // 名册与 records 仍一次取全后内存 diff；D8-2 另走统一真相选择器判定 receipt。
    const [allRegistrations, records, officialTime] = await Promise.all([
      this.prisma.activityRegistration.findMany({
        where: {
          activityId,
          deletedAt: null,
        },
        select: {
          id: true,
          memberId: true,
          statusCode: true,
          member: { select: { memberNo: true, realName: true, nickname: true } },
        },
        orderBy: [{ registeredAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.attendanceRecord.findMany({
        where: { deletedAt: null, sheet: { activityId, deletedAt: null } },
        select: {
          memberId: true,
          serviceHours: true,
          sheet: { select: { statusCode: true } },
          member: { select: { memberNo: true, realName: true, nickname: true } },
        },
        orderBy: [{ memberId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.readOfficialTime(activityId),
    ]);
    const registrations = allRegistrations.filter(
      (registration) => registration.statusCode === ACTIVITY_REGISTRATION_STATUS.PASS,
    );

    const recordsByMember = new Map<string, typeof records>();
    for (const record of records) {
      const rows = recordsByMember.get(record.memberId) ?? [];
      rows.push(record);
      recordsByMember.set(record.memberId, rows);
    }
    const registeredMemberIds = new Set(
      allRegistrations.map((registration) => registration.memberId),
    );

    // 取数源由闸决定,不是两套并存(合同 §16.2 第三项)。闸关(默认)= 今天的行为。
    const committedByMember =
      officialTime === null &&
      this.activityWorkflowGate.participationReadSource() === 'committed-ledger'
        ? await this.loadCommittedTotalsByMember(activityId)
        : null;
    const officialByMember =
      officialTime === null
        ? null
        : new Map(
            officialTime.totals.map((row) => [
              row.memberId,
              eligibleSecondsToServiceHours(row.eligibleSeconds).toString(),
            ]),
          );

    const summarizeRecords = (memberId: string, memberRecords: typeof records) => {
      const approved = memberRecords.filter(
        (record) => record.sheet.statusCode === ATTENDANCE_SHEET_STATUS.APPROVED,
      );
      const hours = approved.reduce(
        (sum, record) => sum.add(record.serviceHours),
        new Prisma.Decimal(0),
      );
      return {
        // 计数两项留在 approved 口径 —— 见 loadCommittedTotalsByMember 的注释(悬案 D1)。
        recordCount: memberRecords.length,
        approvedRecordCount: approved.length,
        totalServiceHours:
          officialByMember !== null
            ? (officialByMember.get(memberId) ?? '0')
            : committedByMember === null
              ? hours.toString()
              : (committedByMember.get(memberId)?.serviceHours ?? '0'),
      };
    };

    const registeredParticipants = registrations.map((registration) => {
      const memberRecords = recordsByMember.get(registration.memberId) ?? [];
      return {
        registrationId: registration.id,
        memberId: registration.memberId,
        ...toMemberLabelFields(registration.member),
        outcome: memberRecords.length > 0 ? ('attended' as const) : ('no-show' as const),
        ...summarizeRecords(registration.memberId, memberRecords),
      };
    });

    const temporaryParticipants = [...recordsByMember.entries()]
      .filter(([memberId]) => !registeredMemberIds.has(memberId))
      .map(([memberId, memberRecords]) => ({
        memberId,
        ...toMemberLabelFields(memberRecords[0].member),
        outcome: 'temporary' as const,
        ...summarizeRecords(memberId, memberRecords),
      }));

    return {
      activityId,
      activityStatusCode: activity.statusCode,
      passRegistrationCount: registrations.length,
      attendedCount: registeredParticipants.filter((item) => item.outcome === 'attended').length,
      noShowCount: registeredParticipants.filter((item) => item.outcome === 'no-show').length,
      registeredParticipants,
      temporaryParticipants,
    };
  }

  async participationSummary(
    activityId: string,
    currentUser: CurrentUserPayload,
  ): Promise<ActivityParticipationSummaryDto> {
    await this.assertCanReadActivity(currentUser, activityId);
    const activity = await this.findActivityOrThrow(activityId);

    // 原有四路读取保持批量；D8-2 统一选择器另以固定查询数读取 official time，无 N+1。
    const [registrations, records, feedback, officialTime] = await Promise.all([
      this.prisma.activityRegistration.findMany({
        where: { activityId, deletedAt: null },
        select: { id: true, memberId: true, statusCode: true },
      }),
      this.prisma.attendanceRecord.findMany({
        where: { deletedAt: null, sheet: { activityId, deletedAt: null } },
        select: {
          memberId: true,
          serviceHours: true,
          contributionPoints: true,
          sheet: { select: { statusCode: true } },
        },
      }),
      this.feedbacks.aggregateForActivity(activityId),
      this.readOfficialTime(activityId),
    ]);
    const metrics = buildActivityParticipationMetrics(activity.statusCode, registrations, records);

    // 取数源由闸决定(合同 §16.2 第三项);范式与 participation-summary-query 同构。
    const preCutoverSettlement =
      this.activityWorkflowGate.participationReadSource() === 'committed-ledger'
        ? foldActivityTotals(await this.loadCommittedTotalsByMember(activityId))
        : {
            totalServiceHours: metrics.totalServiceHours.toString(),
            totalContributionPoints: metrics.totalContributionPoints.toString(),
          };
    const settlement =
      officialTime === null
        ? preCutoverSettlement
        : {
            ...preCutoverSettlement,
            totalServiceHours: eligibleSecondsToServiceHours(
              sumOfficialEligibleSeconds(officialTime.totals),
            ).toString(),
          };

    return {
      activityId,
      activityStatusCode: activity.statusCode,
      registrationCounts: metrics.registrationCounts,
      attendeeCount: metrics.attendeeCount,
      registeredAttendeeCount: metrics.registeredAttendeeCount,
      temporaryAttendeeCount: metrics.temporaryAttendeeCount,
      noShowCount: metrics.noShowCount,
      attendanceRate: metrics.attendanceRate,
      ...settlement,
      durationHistogram:
        officialTime === null
          ? metrics.durationHistogram
          : buildOfficialDurationHistogram(officialTime.totals),
      feedback,
    };
  }
}
