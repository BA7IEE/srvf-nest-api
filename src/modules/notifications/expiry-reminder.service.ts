import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_CHANNEL_WECHAT,
  NOTIFICATION_TYPE_ACTIVITY_REMINDER,
  NOTIFICATION_TYPE_EXPIRY_REMINDER,
} from './notification.constants';
import { NotificationDispatcher } from './notification-dispatcher';

const CERT_STATUS_VERIFIED = 'verified';
const CERT_STATUS_EXPIRED = 'expired';
const DAY_MS = 86_400_000;
const UTC8_OFFSET_MS = 8 * 3_600_000;

export interface ExpiryReminderRunSummary {
  activityReminderCandidates: number;
  activityRemindersDispatched: number;
  certificateReminderCandidates: number;
  certificateRemindersDispatched: number;
  certificateExpiryCandidates: number;
  certificatesExpired: number;
  certificateExpiryNotificationsDispatched: number;
  memberInsuranceCandidates: number;
  memberInsuranceNotificationsDispatched: number;
  teamPolicyCandidates: number;
  teamPolicyNotificationsDispatched: number;
  failed: number;
}

@Injectable()
export class ExpiryReminderService {
  private readonly logger = new Logger(ExpiryReminderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  // v0.47.0 解锁的第二个且唯一新增 cron。薄壳；测试与人工补跑只调用 runOnce()。
  @Cron('0 0 9 * * *', { name: 'expiry-reminder', timeZone: 'Asia/Shanghai' })
  async handleDailyCron(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error(`expiry reminder job failed errorClass=${errorClass(error)}`);
    }
  }

  async runOnce(now: Date = new Date()): Promise<ExpiryReminderRunSummary> {
    const summary = emptySummary();
    const today = toBeijingDateOnly(now);
    const certificateReminderEnd = addDateOnlyDays(today, 60);
    const insuranceReminderEnd = addDateOnlyDays(today, 30);
    const requestId = `cron:expiry-reminder:${formatDateOnly(today)}`;

    // 顺序锁：活动开场提醒 → 证书预提醒 → 证书到期翻态/审计 → 个人保险 → 队保单管理面广播。
    await this.remindUpcomingActivities(now, summary);
    await this.remindCertificates(today, certificateReminderEnd, now, summary);
    await this.expireCertificates(today, requestId, summary);
    await this.remindMemberInsurances(today, insuranceReminderEnd, now, summary);
    await this.remindTeamPolicies(today, insuranceReminderEnd, now, summary);

    this.logger.log(
      `expiry reminder job done certReminders=${summary.certificateRemindersDispatched} ` +
        `activityReminders=${summary.activityRemindersDispatched} ` +
        `certificatesExpired=${summary.certificatesExpired} ` +
        `memberInsurances=${summary.memberInsuranceNotificationsDispatched} ` +
        `teamPolicies=${summary.teamPolicyNotificationsDispatched} failed=${summary.failed}`,
    );
    return summary;
  }

  private async remindUpcomingActivities(
    now: Date,
    summary: ExpiryReminderRunSummary,
  ): Promise<void> {
    const reminderEnd = new Date(now.getTime() + DAY_MS);
    const rows = await this.prisma.activity.findMany({
      where: {
        deletedAt: null,
        statusCode: 'published',
        startAt: { gt: now, lte: reminderEnd },
        startReminderSentAt: null,
      },
      select: { id: true, title: true, startAt: true, location: true },
    });
    summary.activityReminderCandidates = rows.length;

    for (const row of rows) {
      try {
        const claimed = await this.prisma.activity.updateMany({
          where: {
            id: row.id,
            deletedAt: null,
            statusCode: 'published',
            startAt: { gt: now, lte: reminderEnd },
            startReminderSentAt: null,
          },
          data: { startReminderSentAt: now },
        });
        if (claimed.count !== 1) continue;

        const registrations = await this.prisma.activityRegistration.findMany({
          where: { activityId: row.id, statusCode: 'pass', deletedAt: null },
          select: { memberId: true },
        });
        for (const memberId of new Set(registrations.map((item) => item.memberId))) {
          try {
            await this.dispatcher.dispatchTargeted({
              recipientMemberId: memberId,
              notificationTypeCode: NOTIFICATION_TYPE_ACTIVITY_REMINDER,
              title: '活动即将开始',
              body: `您报名的「${row.title}」将于 ${row.startAt.toISOString()} 开始，地点 ${row.location}。`,
              channels: [NOTIFICATION_CHANNEL_IN_APP],
            });
            summary.activityRemindersDispatched += 1;
          } catch (error) {
            summary.failed += 1;
            this.logItemFailure('activity-reminder-recipient', `${row.id}:${memberId}`, error);
          }
        }
      } catch (error) {
        summary.failed += 1;
        this.logItemFailure('activity-reminder', row.id, error);
      }
    }
  }

  private async remindCertificates(
    today: Date,
    reminderEnd: Date,
    claimedAt: Date,
    summary: ExpiryReminderRunSummary,
  ): Promise<void> {
    const rows = await this.prisma.certificate.findMany({
      where: {
        deletedAt: null,
        certStatusCode: CERT_STATUS_VERIFIED,
        expiredAt: { gt: today, lte: reminderEnd },
        expireNotifyDueAt: null,
      },
      select: { id: true, memberId: true, expiredAt: true },
    });
    summary.certificateReminderCandidates = rows.length;

    for (const row of rows) {
      try {
        const claimed = await this.prisma.certificate.updateMany({
          where: {
            id: row.id,
            deletedAt: null,
            certStatusCode: CERT_STATUS_VERIFIED,
            expiredAt: { gt: today, lte: reminderEnd },
            expireNotifyDueAt: null,
          },
          data: { expireNotifyDueAt: claimedAt },
        });
        if (claimed.count !== 1 || row.expiredAt === null) continue;

        await this.dispatcher.dispatchTargeted({
          recipientMemberId: row.memberId,
          notificationTypeCode: NOTIFICATION_TYPE_EXPIRY_REMINDER,
          title: '证书即将到期',
          body: `您的证书将于 ${formatDateOnly(row.expiredAt)} 到期，请及时办理续期。`,
          channels: [NOTIFICATION_CHANNEL_IN_APP, NOTIFICATION_CHANNEL_WECHAT],
        });
        summary.certificateRemindersDispatched += 1;
      } catch (error) {
        summary.failed += 1;
        this.logItemFailure('certificate-reminder', row.id, error);
      }
    }
  }

  private async expireCertificates(
    today: Date,
    requestId: string,
    summary: ExpiryReminderRunSummary,
  ): Promise<void> {
    const rows = await this.prisma.certificate.findMany({
      where: {
        deletedAt: null,
        certStatusCode: CERT_STATUS_VERIFIED,
        expiredAt: { lte: today },
      },
      select: { id: true },
    });
    summary.certificateExpiryCandidates = rows.length;

    for (const row of rows) {
      try {
        const transitioned = await this.prisma.$transaction(async (tx) => {
          const before = await tx.certificate.findFirst({
            where: {
              id: row.id,
              deletedAt: null,
              certStatusCode: CERT_STATUS_VERIFIED,
              expiredAt: { lte: today },
            },
            select: {
              id: true,
              memberId: true,
              certTypeCode: true,
              certStatusCode: true,
              expiredAt: true,
              verifiedBy: true,
              verifiedAt: true,
            },
          });
          if (!before || before.expiredAt === null) return null;

          const updated = await tx.certificate.updateMany({
            where: {
              id: before.id,
              deletedAt: null,
              certStatusCode: CERT_STATUS_VERIFIED,
              expiredAt: { lte: today },
            },
            data: { certStatusCode: CERT_STATUS_EXPIRED },
          });
          if (updated.count !== 1) return null;

          const after = { ...before, certStatusCode: CERT_STATUS_EXPIRED };
          await this.auditLogs.log({
            event: 'certificate.expire',
            actorUserId: null,
            actorRoleSnap: null,
            resourceType: 'certificate',
            resourceId: before.id,
            meta: { requestId, ip: null, ua: null },
            before: certificateAuditSnapshot(before),
            after: certificateAuditSnapshot(after),
            extra: { operation: 'expire', memberId: before.memberId },
            tx,
          });

          return { memberId: before.memberId, expiredAt: before.expiredAt };
        });
        if (!transitioned) continue;

        summary.certificatesExpired += 1;
        await this.dispatcher.dispatchTargeted({
          recipientMemberId: transitioned.memberId,
          notificationTypeCode: NOTIFICATION_TYPE_EXPIRY_REMINDER,
          title: '证书已到期',
          body: `您的证书已于 ${formatDateOnly(transitioned.expiredAt)} 到期。`,
          channels: [NOTIFICATION_CHANNEL_IN_APP, NOTIFICATION_CHANNEL_WECHAT],
        });
        summary.certificateExpiryNotificationsDispatched += 1;
      } catch (error) {
        summary.failed += 1;
        this.logItemFailure('certificate-expire', row.id, error);
      }
    }
  }

  private async remindMemberInsurances(
    today: Date,
    reminderEnd: Date,
    claimedAt: Date,
    summary: ExpiryReminderRunSummary,
  ): Promise<void> {
    const rows = await this.prisma.memberInsurance.findMany({
      where: { deletedAt: null, coverageEnd: { lte: reminderEnd }, expireNotifiedAt: null },
      select: { id: true, memberId: true, coverageEnd: true },
    });
    summary.memberInsuranceCandidates = rows.length;

    for (const row of rows) {
      try {
        const claimed = await this.prisma.memberInsurance.updateMany({
          where: {
            id: row.id,
            deletedAt: null,
            coverageEnd: { lte: reminderEnd },
            expireNotifiedAt: null,
          },
          data: { expireNotifiedAt: claimedAt },
        });
        if (claimed.count !== 1) continue;

        const expired = row.coverageEnd < today;
        await this.dispatcher.dispatchTargeted({
          recipientMemberId: row.memberId,
          notificationTypeCode: NOTIFICATION_TYPE_EXPIRY_REMINDER,
          title: expired ? '个人保险已到期' : '个人保险即将到期',
          body: expired
            ? `您的个人保险已于 ${formatDateOnly(row.coverageEnd)} 到期，请及时续保。`
            : `您的个人保险将于 ${formatDateOnly(row.coverageEnd)} 到期，请及时续保。`,
          channels: [NOTIFICATION_CHANNEL_IN_APP, NOTIFICATION_CHANNEL_WECHAT],
        });
        summary.memberInsuranceNotificationsDispatched += 1;
      } catch (error) {
        summary.failed += 1;
        this.logItemFailure('member-insurance-reminder', row.id, error);
      }
    }
  }

  private async remindTeamPolicies(
    today: Date,
    reminderEnd: Date,
    claimedAt: Date,
    summary: ExpiryReminderRunSummary,
  ): Promise<void> {
    const rows = await this.prisma.teamInsurancePolicy.findMany({
      where: { deletedAt: null, coverageEnd: { lte: reminderEnd }, expireNotifiedAt: null },
      select: { id: true, coverageEnd: true },
    });
    summary.teamPolicyCandidates = rows.length;

    for (const row of rows) {
      try {
        const claimed = await this.prisma.teamInsurancePolicy.updateMany({
          where: {
            id: row.id,
            deletedAt: null,
            coverageEnd: { lte: reminderEnd },
            expireNotifiedAt: null,
          },
          data: { expireNotifiedAt: claimedAt },
        });
        if (claimed.count !== 1) continue;

        const expired = row.coverageEnd < today;
        await this.dispatcher.dispatchSystemBroadcast({
          notificationTypeCode: NOTIFICATION_TYPE_EXPIRY_REMINDER,
          title: expired ? '队保单已到期' : '队保单即将到期',
          body: expired
            ? `一张队保单已于 ${formatDateOnly(row.coverageEnd)} 到期，请管理人员及时处理。`
            : `一张队保单将于 ${formatDateOnly(row.coverageEnd)} 到期，请管理人员及时处理。`,
        });
        summary.teamPolicyNotificationsDispatched += 1;
      } catch (error) {
        summary.failed += 1;
        this.logItemFailure('team-insurance-policy-reminder', row.id, error);
      }
    }
  }

  private logItemFailure(stage: string, resourceId: string, error: unknown): void {
    // 不打印保单号 / 证书号 / openid / secret；仅保留资源 id、阶段与错误类。
    this.logger.warn(
      `expiry reminder item failed stage=${stage} resourceId=${resourceId} errorClass=${errorClass(error)}`,
    );
  }
}

function emptySummary(): ExpiryReminderRunSummary {
  return {
    activityReminderCandidates: 0,
    activityRemindersDispatched: 0,
    certificateReminderCandidates: 0,
    certificateRemindersDispatched: 0,
    certificateExpiryCandidates: 0,
    certificatesExpired: 0,
    certificateExpiryNotificationsDispatched: 0,
    memberInsuranceCandidates: 0,
    memberInsuranceNotificationsDispatched: 0,
    teamPolicyCandidates: 0,
    teamPolicyNotificationsDispatched: 0,
    failed: 0,
  };
}

function certificateAuditSnapshot(row: {
  certTypeCode: string;
  certStatusCode: string;
  expiredAt: Date | null;
  verifiedBy: string | null;
  verifiedAt: Date | null;
}): Record<string, unknown> {
  return {
    certTypeCode: row.certTypeCode,
    certStatusCode: row.certStatusCode,
    expiredAt: row.expiredAt?.toISOString() ?? null,
    verifiedBy: row.verifiedBy,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
  };
}

// 北京自然日映射为同 Y/M/D 的 UTC 午夜，和仓库 date-only 持久化口径一致。
export function toBeijingDateOnly(now: Date): Date {
  const shifted = new Date(now.getTime() + UTC8_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

export function addDateOnlyDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}
