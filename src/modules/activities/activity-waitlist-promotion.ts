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
  activityPositionId: true,
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

interface ActivityWaitlistPromotionBaseArgs {
  activityId: string;
  maxPromotions: number | null;
  actorUserId: string;
  actorRoleSnap: Role;
  auditMeta: AuditMeta;
  tx: PrismaTx;
  auditLogs: Pick<AuditLogsService, 'log'>;
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
    select: { title: true, statusCode: true, capacity: true },
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
    const lockedCandidate = await args.tx.activityRegistration.findFirst({
      where: notDeletedWhere({ id: candidate.id }),
      select: waitlistAuditSelect,
    });
    if (!lockedCandidate) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    }

    const updated = await args.tx.activityRegistration.update({
      where: { id: lockedCandidate.id },
      data: { statusCode: transition.nextStatusCode },
      select: waitlistAuditSelect,
    });

    await args.auditLogs.log({
      event: 'registration.review',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: 'activity_registration',
      resourceId: lockedCandidate.id,
      meta: args.auditMeta,
      before: toAuditSnapshot(lockedCandidate),
      after: toAuditSnapshot(updated),
      extra: {
        operation: 'review',
        action: 'promote',
        priorStatusCode: lockedCandidate.statusCode,
        nextStatusCode: transition.nextStatusCode,
        activityId: args.activityId,
        targetMemberId: lockedCandidate.memberId,
      },
      tx: args.tx,
    });

    promoted.push({ registrationId: lockedCandidate.id, memberId: lockedCandidate.memberId });
  }

  return { activityTitle: activity.title, promoted };
}

// 父容量释放/扩容时的跨岗位递补：优先指定岗位（pass 取消保持既有同岗语义），
// 无同岗候补时按全活动 FIFO fallback。岗位 child headroom 在本次调用内逐条扣减，
// 避免 pending 不计 pass 导致同一轮循环透支岗位名额。
export async function promoteActivityWaitlistAcrossPositions(
  args: ActivityWaitlistPromotionBaseArgs & {
    preferredActivityPositionId?: string | null;
    previousActivityCapacity?: number | null;
  },
): Promise<ActivityWaitlistPromotionResult> {
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
    select: { title: true, statusCode: true, capacity: true },
  });
  if (!activity) {
    throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
  }

  const promoted: ActivityWaitlistPromotionResult['promoted'] = [];
  if (activity.statusCode !== 'published' || args.maxPromotions === 0) {
    return { activityTitle: activity.title, promoted };
  }

  const [activityPositions, passCounts, nullPositionWaitlistCount] = await Promise.all([
    args.tx.activityPosition.findMany({
      where: { activityId: args.activityId, deletedAt: null },
      select: { id: true, capacity: true },
    }),
    args.tx.activityRegistration.groupBy({
      by: ['activityPositionId'],
      where: notDeletedWhere({
        activityId: args.activityId,
        statusCode: ACTIVITY_REGISTRATION_STATUS.PASS,
      }),
      _count: { _all: true },
    }),
    args.tx.activityRegistration.count({
      where: notDeletedWhere({
        activityId: args.activityId,
        activityPositionId: null,
        statusCode: ACTIVITY_REGISTRATION_STATUS.WAITLISTED,
      }),
    }),
  ]);
  const passCountByActivityPositionId = new Map(
    passCounts.map((row) => [row.activityPositionId, row._count._all]),
  );
  const activityPassCount = passCounts.reduce((total, row) => total + row._count._all, 0);
  const remainingByActivityPositionId = new Map<string | null, number | null>();
  // 历史无岗位队列没有 child cap，仍只受调用方传入的父容量 promotion budget。
  remainingByActivityPositionId.set(null, null);
  for (const activityPosition of activityPositions) {
    remainingByActivityPositionId.set(
      activityPosition.id,
      activityPosition.capacity === null
        ? null
        : Math.max(
            activityPosition.capacity -
              (passCountByActivityPositionId.get(activityPosition.id) ?? 0),
            0,
          ),
    );
  }

  const finiteActivityPositionHeadroom = activityPositions.reduce(
    (total, activityPosition) =>
      total + (remainingByActivityPositionId.get(activityPosition.id) ?? 0),
    0,
  );
  const activityPositionHeadroom =
    nullPositionWaitlistCount > 0 ||
    activityPositions.some((activityPosition) => activityPosition.capacity === null)
      ? null
      : finiteActivityPositionHeadroom;
  const effectiveHeadroom = (activityCapacity: number | null): number | null => {
    const globalHeadroom =
      activityCapacity === null ? null : Math.max(activityCapacity - activityPassCount, 0);
    if (globalHeadroom === null) return activityPositionHeadroom;
    if (activityPositionHeadroom === null) return globalHeadroom;
    return Math.min(globalHeadroom, activityPositionHeadroom);
  };
  const currentEffectiveHeadroom = effectiveHeadroom(activity.capacity);
  const incrementalHeadroom =
    args.previousActivityCapacity === undefined
      ? currentEffectiveHeadroom
      : (() => {
          const previousEffectiveHeadroom = effectiveHeadroom(args.previousActivityCapacity);
          if (currentEffectiveHeadroom === null) return null;
          if (previousEffectiveHeadroom === null) return 0;
          return Math.max(currentEffectiveHeadroom - previousEffectiveHeadroom, 0);
        })();
  const promotionLimit =
    incrementalHeadroom === null
      ? args.maxPromotions
      : args.maxPromotions === null
        ? incrementalHeadroom
        : Math.min(args.maxPromotions, incrementalHeadroom);
  if (promotionLimit === 0) {
    return { activityTitle: activity.title, promoted };
  }

  const hasRemaining = (activityPositionId: string | null): boolean => {
    const remaining = remainingByActivityPositionId.get(activityPositionId);
    return remaining === null || (remaining !== undefined && remaining > 0);
  };
  const consumeRemaining = (activityPositionId: string | null): void => {
    const remaining = remainingByActivityPositionId.get(activityPositionId);
    if (typeof remaining === 'number') {
      remainingByActivityPositionId.set(activityPositionId, Math.max(remaining - 1, 0));
    }
  };

  let tryPreferred = args.preferredActivityPositionId !== undefined;
  while (promotionLimit === null || promoted.length < promotionLimit) {
    let candidate: WaitlistAuditRow | null = null;
    if (tryPreferred) {
      const preferredActivityPositionId = args.preferredActivityPositionId ?? null;
      if (hasRemaining(preferredActivityPositionId)) {
        candidate = await args.tx.activityRegistration.findFirst({
          where: notDeletedWhere({
            activityId: args.activityId,
            activityPositionId: preferredActivityPositionId,
            statusCode: ACTIVITY_REGISTRATION_STATUS.WAITLISTED,
          }),
          select: waitlistAuditSelect,
          orderBy: [{ registeredAt: 'asc' }, { id: 'asc' }],
        });
      }
      if (candidate === null) tryPreferred = false;
    }

    if (candidate === null) {
      const eligibleActivityPositionIds = [...remainingByActivityPositionId.entries()]
        .filter(
          (entry): entry is [string, number | null] =>
            entry[0] !== null && (entry[1] === null || entry[1] > 0),
        )
        .map(([activityPositionId]) => activityPositionId);
      candidate = await args.tx.activityRegistration.findFirst({
        where: {
          activityId: args.activityId,
          statusCode: ACTIVITY_REGISTRATION_STATUS.WAITLISTED,
          deletedAt: null,
          OR: [
            { activityPositionId: null },
            ...(eligibleActivityPositionIds.length === 0
              ? []
              : [{ activityPositionId: { in: eligibleActivityPositionIds } }]),
          ],
        },
        select: waitlistAuditSelect,
        orderBy: [{ registeredAt: 'asc' }, { id: 'asc' }],
      });
    }
    if (candidate === null) break;

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
      if (err instanceof BizException && err.biz === BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID) {
        continue;
      }
      throw err;
    }
    const lockedCandidate = await args.tx.activityRegistration.findFirst({
      where: notDeletedWhere({ id: candidate.id }),
      select: waitlistAuditSelect,
    });
    if (!lockedCandidate) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    }

    const updated = await args.tx.activityRegistration.update({
      where: { id: lockedCandidate.id },
      data: { statusCode: transition.nextStatusCode },
      select: waitlistAuditSelect,
    });
    await args.auditLogs.log({
      event: 'registration.review',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: 'activity_registration',
      resourceId: lockedCandidate.id,
      meta: args.auditMeta,
      before: toAuditSnapshot(lockedCandidate),
      after: toAuditSnapshot(updated),
      extra: {
        operation: 'review',
        action: 'promote',
        priorStatusCode: lockedCandidate.statusCode,
        nextStatusCode: transition.nextStatusCode,
        activityId: args.activityId,
        targetMemberId: lockedCandidate.memberId,
      },
      tx: args.tx,
    });
    consumeRemaining(lockedCandidate.activityPositionId);
    promoted.push({
      registrationId: lockedCandidate.id,
      memberId: lockedCandidate.memberId,
    });
  }

  return { activityTitle: activity.title, promoted };
}
