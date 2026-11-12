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
import { RbacService } from '../permissions/rbac.service';
import {
  ActivityParticipationSummaryDto,
  ActivityReconciliationDto,
} from './activity-participation.dto';
import { readPostedParticipationFactsInTx } from './activity-participation-projection-query';
import { buildV11ParticipationMetrics } from './activity-participation-v11-metrics';
import { toMemberLabelFields } from '../../common/identity/member-label.util';
import {
  ParticipationTimeTruthQueryService,
  eligibleSecondsToServiceHours,
} from './participation-time-truth-query.service';

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
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const ref: ResourceRef = { type: 'activity', id: activityId };
    for (const action of PARTICIPATION_READ_ACTIONS) {
      const decision =
        tx === undefined
          ? await this.authz.explain(currentUser, action, ref)
          : await this.authz.explain(currentUser, action, ref, tx);
      if (decision.allow) continue;
      if (
        decision.reason === 'resource_not_found' &&
        (tx === undefined
          ? await this.rbac.can(currentUser, action)
          : await this.rbac.can(currentUser, action, undefined, tx))
      ) {
        continue;
      }
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  private async findActivityOrThrow(
    activityId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ id: string; statusCode: string }> {
    const activity = await (tx ?? this.prisma).activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: { id: true, statusCode: true },
    });
    if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return activity;
  }

  private assertV11ReadAvailable(): void {
    if (this.activityWorkflowGate.participationReadSource() !== 'committed-ledger') {
      throw new BizException(BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED);
    }
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
    this.assertV11ReadAvailable();

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

    // 本读面仍有旧考勤人数口径，待迁移；关闸时不再回退旧的结算工时。
    const committedByMember =
      officialTime === null ? await this.loadCommittedTotalsByMember(activityId) : null;
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
      return {
        // 计数两项留在 approved 口径 —— 见 loadCommittedTotalsByMember 的注释(悬案 D1)。
        recordCount: memberRecords.length,
        approvedRecordCount: approved.length,
        totalServiceHours:
          officialByMember !== null
            ? (officialByMember.get(memberId) ?? '0')
            : (committedByMember?.get(memberId)?.serviceHours ?? '0'),
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
    return this.prisma.$transaction(
      async (tx) => {
        await this.assertCanReadActivity(currentUser, activityId, tx);
        const activity = await this.findActivityOrThrow(activityId, tx);
        this.assertV11ReadAvailable();
        const [registrations, facts, feedback, officialTime, ledgerRows] = await Promise.all([
          tx.activityRegistration.findMany({
            where: { activityId, deletedAt: null },
            select: { id: true, memberId: true, statusCode: true },
          }),
          readPostedParticipationFactsInTx(tx, [activityId]),
          this.feedbacks.aggregateForActivity(activityId, tx),
          this.participationTimeTruth.readOfficialTotalsInTx(tx, { activityIds: [activityId] }),
          this.ledgerQuery.sumCommittedByMemberForActivities([activityId], tx),
        ]);
        return {
          activityId,
          activityStatusCode: activity.statusCode,
          ...buildV11ParticipationMetrics({
            registrations,
            facts,
            ledgerRows,
            officialRows: officialTime?.totals ?? null,
          }),
          feedback,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
