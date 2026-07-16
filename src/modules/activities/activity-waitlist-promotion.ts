import type { Prisma, Role } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { claimAtStatus } from '../../common/prisma/claim-at-status.util';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import {
  ACTIVITY_REGISTRATION_STATUS,
  decideActivityRegistrationTransition,
} from '../activity-registrations/activity-registration-state-machine';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

type PrismaTx = Prisma.TransactionClient;

const waitlistAuditSelect = {
  id: true,
  activityId: true,
  memberId: true,
  statusCode: true,
  registeredAt: true,
  reviewedBy: true,
  reviewedAt: true,
  reviewNote: true,
  extras: true,
  cancelledByUserId: true,
  cancelledAt: true,
  cancelReason: true,
} as const satisfies Prisma.ActivityRegistrationSelect;

type WaitlistAuditRow = Prisma.ActivityRegistrationGetPayload<{
  select: typeof waitlistAuditSelect;
}>;

export interface ActivityWaitlistPromotionResult {
  activityTitle: string;
  promoted: Array<{ registrationId: string; memberId: string }>;
}

function jsonAsObject(v: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  return v;
}

function toAuditSnapshot(row: WaitlistAuditRow): Record<string, unknown> {
  return {
    activityId: row.activityId,
    memberId: row.memberId,
    statusCode: row.statusCode,
    registeredAt: row.registeredAt,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    reviewNote: row.reviewNote,
    extras: jsonAsObject(row.extras),
    cancelledByUserId: row.cancelledByUserId,
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
  };
}

// 活动聚合内的候补递补引擎：调用方持有事务，本函数只在同一事务内锁 Activity、按 FIFO
// claim 候补行、写 waitlisted→pending 与 registration.review audit。保持纯函数入口，避免
// participation 兄弟模块之间引入 Service-to-Service 依赖；通知仍由调用方在 commit 后派发。
export async function promoteActivityWaitlist(args: {
  activityId: string;
  activityPositionId?: string | null;
  maxPromotions: number | null;
  actorUserId: string;
  actorRoleSnap: Role;
  auditMeta: AuditMeta;
  tx: PrismaTx;
  auditLogs: Pick<AuditLogsService, 'log'>;
}): Promise<ActivityWaitlistPromotionResult> {
  const locked = await args.tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "Activity"
    WHERE id = ${args.activityId} AND "deletedAt" IS NULL
    FOR UPDATE
  `;
  if (locked.length === 0) {
    throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
  }

  const activity = await args.tx.activity.findFirst({
    where: notDeletedWhere({ id: args.activityId }),
    select: { title: true, statusCode: true },
  });
  if (!activity) {
    throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
  }

  const promoted: ActivityWaitlistPromotionResult['promoted'] = [];
  if (activity.statusCode !== 'published' || args.maxPromotions === 0) {
    return { activityTitle: activity.title, promoted };
  }

  while (args.maxPromotions === null || promoted.length < args.maxPromotions) {
    const candidate = await args.tx.activityRegistration.findFirst({
      where: notDeletedWhere({
        activityId: args.activityId,
        activityPositionId: args.activityPositionId ?? null,
        statusCode: ACTIVITY_REGISTRATION_STATUS.WAITLISTED,
      }),
      select: waitlistAuditSelect,
      orderBy: [{ registeredAt: 'asc' }, { id: 'asc' }],
    });
    if (!candidate) break;

    const transition = decideActivityRegistrationTransition('promote', candidate.statusCode);
    if (!transition.allowed) {
      throw new BizException(transition.biz);
    }

    try {
      await claimAtStatus(args.tx, {
        target: 'activityRegistration',
        id: candidate.id,
        expectedStatus: ACTIVITY_REGISTRATION_STATUS.WAITLISTED,
        invalidStatusBiz: BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
      });
    } catch (err) {
      // 候补本人可能与递补同时取消，或管理员同时驳回。CAS 败者跳过并重新取队首，
      // 不允许该竞争回滚已成功的主业务事务（取消名额 / 调大容量）。
      if (err instanceof BizException && err.biz === BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID) {
        continue;
      }
      throw err;
    }

    const updated = await args.tx.activityRegistration.update({
      where: { id: candidate.id },
      data: { statusCode: transition.nextStatusCode },
      select: waitlistAuditSelect,
    });

    await args.auditLogs.log({
      event: 'registration.review',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: 'activity_registration',
      resourceId: candidate.id,
      meta: args.auditMeta,
      before: toAuditSnapshot(candidate),
      after: toAuditSnapshot(updated),
      extra: {
        operation: 'review',
        action: 'promote',
        priorStatusCode: candidate.statusCode,
        nextStatusCode: transition.nextStatusCode,
        activityId: args.activityId,
        targetMemberId: candidate.memberId,
      },
      tx: args.tx,
    });

    promoted.push({ registrationId: candidate.id, memberId: candidate.memberId });
  }

  return { activityTitle: activity.title, promoted };
}
