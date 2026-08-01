import { MemberStatus, type Prisma, type Role } from '@prisma/client';
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
import { lockAndReadLiveMemberLifecycle } from '../members/member-lifecycle-lock';

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

/**
 * 两个剩余量取交集(`null` = 不限)。**全仓唯一**的容量收敛算法 —— 无论谁要算「本次最多能递补
 * 几个」,都必须落到这一个函数上;否则「父预算 ∩ 本岗余量 ∩ 调用方上限」会被复制成第二套,
 * 而两套迟早在 `null` 的语义上分叉(不限 vs 0)。
 */
function intersectHeadroom(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
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
// participation 兄弟模块之间引入 Service-to-Service 依赖；通知由调用方在同一 transaction 内 enqueue。
//
// **全仓唯一的候补出队循环**：候补只可能从 `activityPositionId` 这一条队列里取人。跨岗位取人
// 在本仓不存在实现（B-D2 拍板，2026-08-01），新增调用方也无从绕开。
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
  const skippedRegistrationIds = new Set<string>();
  if (activity.statusCode !== 'published' || args.maxPromotions === 0) {
    return { activityTitle: activity.title, promoted };
  }

  while (args.maxPromotions === null || promoted.length < args.maxPromotions) {
    const candidate = await args.tx.activityRegistration.findFirst({
      where: notDeletedWhere({
        activityId: args.activityId,
        activityPositionId: args.activityPositionId ?? null,
        statusCode: ACTIVITY_REGISTRATION_STATUS.WAITLISTED,
        ...(skippedRegistrationIds.size > 0 ? { id: { notIn: [...skippedRegistrationIds] } } : {}),
      }),
      select: waitlistAuditSelect,
      orderBy: [{ registeredAt: 'asc' }, { id: 'asc' }],
    });
    if (!candidate) break;

    const transition = decideActivityRegistrationTransition('promote', candidate.statusCode);
    if (!transition.allowed) {
      throw new BizException(transition.biz);
    }

    // Activity → Member → Registration. The lifecycle row stays locked until the caller's tx
    // commits, so offboard cannot interleave after ACTIVE was re-read. Invalid heads remain
    // waitlisted and are excluded only from this promotion pass, allowing the next FIFO member.
    const member = await lockAndReadLiveMemberLifecycle(args.tx, candidate.memberId);
    if (!member || member.status !== MemberStatus.ACTIVE) {
      skippedRegistrationIds.add(candidate.id);
      continue;
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

// 名额释放/扩容时的**本岗**递补：与 `promoteActivityWaitlist` 出队的是同一条队列、走的是同一个
// 循环，唯一区别是本次可递补人数由本函数按「父活动剩余量 ∩ 本岗剩余量」算出，而不是由调用方传入。
// 岗位释放/扩容的调用方拿不到可靠的全局 pass 基线，让它自己算等于把容量不变量复制一份。
//
// B-D2（维护者 2026-08-01 拍板）：**没有跨岗位 fallback**。岗位是技能绑定的，A 岗释放/扩容只递补
// 候补 A 岗的人；A 岗队列空就空着等管理员手动安排，绝不把 B 岗候补拉过来顶名额。
// `activityPositionId: null` 是历史无岗位队列（报名在先、建岗位在后即可达，见
// `resolveActivityPositionForCreate` 只在报名当刻按 live 岗位判 21035），它同样只被「无岗位报名
// 被取消」与「无 live 岗位活动的父容量扩容」两类事件递补，不会被任何岗位事件顺手带走。
export async function promoteActivityWaitlistWithinCapacity(
  args: ActivityWaitlistPromotionBaseArgs & {
    activityPositionId: string | null;
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
  if (activity.statusCode !== 'published' || args.maxPromotions === 0) {
    return { activityTitle: activity.title, promoted: [] };
  }

  // 三个基线都必须在上面的 Activity 聚合锁之后读：父容量按全活动 pass 计，本岗容量只看目标队列。
  const [activityPassCount, activityPositionPassCount, targetActivityPosition] = await Promise.all([
    args.tx.activityRegistration.count({
      where: notDeletedWhere({
        activityId: args.activityId,
        statusCode: ACTIVITY_REGISTRATION_STATUS.PASS,
      }),
    }),
    args.tx.activityRegistration.count({
      where: notDeletedWhere({
        activityId: args.activityId,
        activityPositionId: args.activityPositionId,
        statusCode: ACTIVITY_REGISTRATION_STATUS.PASS,
      }),
    }),
    args.activityPositionId === null
      ? Promise.resolve(null)
      : args.tx.activityPosition.findFirst({
          where: { id: args.activityPositionId, activityId: args.activityId, deletedAt: null },
          select: { capacity: true },
        }),
  ]);

  // 岗位已在本事务可见范围内被软删（或根本不属于本活动）：没有可递补的名额，不去动任何队列。
  if (args.activityPositionId !== null && targetActivityPosition === null) {
    return { activityTitle: activity.title, promoted: [] };
  }

  // 历史无岗位队列（null）没有 child cap，只受父容量约束；null 表示不限。
  const activityHeadroom =
    activity.capacity === null ? null : Math.max(activity.capacity - activityPassCount, 0);
  const activityPositionHeadroom =
    targetActivityPosition === null || targetActivityPosition.capacity === null
      ? null
      : Math.max(targetActivityPosition.capacity - activityPositionPassCount, 0);
  const capacityHeadroom = intersectHeadroom(activityHeadroom, activityPositionHeadroom);
  const promotionLimit = intersectHeadroom(capacityHeadroom, args.maxPromotions);

  return promoteActivityWaitlist({
    activityId: args.activityId,
    activityPositionId: args.activityPositionId,
    maxPromotions: promotionLimit,
    actorUserId: args.actorUserId,
    actorRoleSnap: args.actorRoleSnap,
    auditMeta: args.auditMeta,
    tx: args.tx,
    auditLogs: args.auditLogs,
  });
}

// 一次事务里放开**多条**队列时的递补入口:多条队列**共享同一份父活动预算**。
//
// 为什么必须是批量入口而不是「调用方 for 循环调单岗版」(2026-08-01 整批评审 P1):
// 递补写的是 `waitlisted → pending`,**不是 `pass`** —— 所以父活动的 pass 基线在整个批次里
// 一动不动。逐岗调 `promoteActivityWaitlistWithinCapacity` 时,每一岗都会把**同一个**父剩余量
// 重新算一遍并完整领走,N 个岗位就把父容量花了 N 次:各岗自己的 headroom 之和只要超过父
// headroom,合计递补数就会突破活动容量。单岗调用看不出问题,只有多岗组合才暴露。
//
// 记账口径:预算按**实际 promoted 数**扣减,不是按发出去的额度扣。某岗队列空、或候选人
// 因 member 非 ACTIVE 被跳过时,没用掉的份额必须留给下一条队列 —— 否则「有人没排上」会
// 变成「名额被凭空作废」。
//
// 队列顺序由调用方给定且必须**稳定**(不受请求体书写顺序影响):预算不够分时,顺序决定谁被
// 递补,不稳定的顺序会让同一份提案两次执行递补到不同的人。
//
// B-D2 隔离不变:本函数只是给 `promoteActivityWaitlist`(全仓唯一出队循环)分预算,
// 一条队列的额度用不完**不会**流向另一条队列去取人 —— 流动的是父容量的剩余额度,不是候选人。
export async function promoteActivityWaitlistsWithinSharedCapacity(args: {
  activityId: string;
  /** 本次被放开的队列,按稳定岗位序;`null` = 历史无岗位队列。重复项按首次出现计一次。 */
  orderedPositionIds: ReadonlyArray<string | null>;
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
  // 去重但保序:同一条队列在一次调用里只该分到一份预算,重复列出不等于多领一次。
  const queues = [...new Set(args.orderedPositionIds)];
  if (activity.statusCode !== 'published' || queues.length === 0) {
    return { activityTitle: activity.title, promoted };
  }

  // 父容量基线在聚合锁之后读,且**整批只读一次** —— 本轮已经发出去多少由下面的
  // remainingActivityHeadroom 记账,不靠重读 pass 数。
  // ⚠️ 这条记账**不依赖**「promote 写 pending 不写 pass」这个当前事实:预算按实际递补数扣减,
  // 每条队列又只被访问一次,所以哪天迁移目标改成 pass,记账仍然是对的(不留只写在注释里的不变量)。
  const activityPassCount = await args.tx.activityRegistration.count({
    where: notDeletedWhere({
      activityId: args.activityId,
      statusCode: ACTIVITY_REGISTRATION_STATUS.PASS,
    }),
  });
  let remainingActivityHeadroom =
    activity.capacity === null ? null : Math.max(activity.capacity - activityPassCount, 0);

  for (const activityPositionId of queues) {
    // 父预算已用尽:后面的队列一个都不该动(`null` = 不限,永远不等于 0)。
    if (remainingActivityHeadroom === 0) break;

    const targetActivityPosition =
      activityPositionId === null
        ? null
        : await args.tx.activityPosition.findFirst({
            where: { id: activityPositionId, activityId: args.activityId, deletedAt: null },
            select: { capacity: true },
          });
    // 岗位已在本事务可见范围内被软删(或根本不属于本活动):跳过,不占用任何预算。
    if (activityPositionId !== null && targetActivityPosition === null) continue;

    const activityPositionPassCount = await args.tx.activityRegistration.count({
      where: notDeletedWhere({
        activityId: args.activityId,
        activityPositionId,
        statusCode: ACTIVITY_REGISTRATION_STATUS.PASS,
      }),
    });
    // 历史无岗位队列(null)没有 child cap,只受父容量约束。
    const activityPositionHeadroom =
      targetActivityPosition === null || targetActivityPosition.capacity === null
        ? null
        : Math.max(targetActivityPosition.capacity - activityPositionPassCount, 0);

    const result = await promoteActivityWaitlist({
      activityId: args.activityId,
      activityPositionId,
      maxPromotions: intersectHeadroom(remainingActivityHeadroom, activityPositionHeadroom),
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      auditMeta: args.auditMeta,
      tx: args.tx,
      auditLogs: args.auditLogs,
    });
    promoted.push(...result.promoted);
    if (remainingActivityHeadroom !== null) {
      remainingActivityHeadroom -= result.promoted.length;
    }
  }

  return { activityTitle: activity.title, promoted };
}
