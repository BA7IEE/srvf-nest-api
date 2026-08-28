import { Prisma, type Role } from '@prisma/client';

import { reissueSessionQrCredentialsInTransactionTrusted } from '../attendances/attendance-qr-session-reissue';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

type PrismaTx = Prisma.TransactionClient;

/** AC-010 改期联动(P1-28 9a C 档;维护者 2026-08-28 拍板「作废旧二维码重签」)。 */
export interface ActivitySessionRescheduleEffectResult {
  rescheduledSessionCount: number;
  reissuedCredentialCount: number;
}

const EMPTY_RESULT: ActivitySessionRescheduleEffectResult = {
  rescheduledSessionCount: 0,
  reissuedCredentialCount: 0,
};

export interface ActivitySessionRescheduleEffectDeps {
  auditLogs: AuditLogsService;
}

/**
 * 单场次**改期**(时间窗变更经变更审核落地)的联动 —— 与场次取消联动
 * (`activity-session-cancellation-effects`)刻意成对、但各自管各自的格子:
 *
 * | 格子 | 取消联动 | 改期联动(本文件) |
 * |---|---|---|
 * | 报名/人员 | 退出该场次报名 | **不动**(改期不动名单) |
 * | 二维码 | 整体作废 | **作废 + 按新窗口重签**(拍板口径) |
 * | 通知 | 按场次名册通知 | **不动**(`enqueueScheduleChange` 的 activity-change 通知已在发布审核链上,改期含在内) |
 * | 结算人口 | population revision +1 | **不动**(人口集合没变) |
 * | 名额 | 容量桶投影 | **不动**(容量按 scheduled 场次现算) |
 *
 * ⭐ 与取消联动一样:**必须在 `applySessions` 落库之后调用** —— 重签冻结的是
 * 「当前」场次时间窗,取在 apply 之前会把旧窗口冻进新码。
 *
 * 审计:一次改期写**一条**聚合行(沿取消联动的处置,不按凭证数放大),
 * 事件名沿用 activity.publish 伞事件,动作在 extra.operation。
 */
export const activitySessionRescheduleEffects = {
  async applyInTransactionTrusted(
    deps: ActivitySessionRescheduleEffectDeps,
    tx: PrismaTx,
    input: {
      activityId: string;
      /** 本轮被改期(任一时间窗列变更)的场次 id 列表。 */
      rescheduledSessionIds: readonly string[];
      /** 稳定的批次键(审核 versionKey)。 */
      versionKey: string;
      at: Date;
      actorUserId: string;
      actorRoleSnap: Role;
      auditMeta: AuditMeta;
      jwtSecret: string;
    },
  ): Promise<ActivitySessionRescheduleEffectResult> {
    const rescheduledSessionIds = [...new Set(input.rescheduledSessionIds)].sort();
    if (rescheduledSessionIds.length === 0) return EMPTY_RESULT;

    const reissued = await reissueSessionQrCredentialsInTransactionTrusted(tx, {
      activityId: input.activityId,
      sessionIds: rescheduledSessionIds,
      issuedByUserId: input.actorUserId,
      issuedAt: input.at,
      jwtSecret: input.jwtSecret,
      versionKey: input.versionKey,
    });

    await deps.auditLogs.log({
      event: 'activity.publish',
      actorUserId: input.actorUserId,
      actorRoleSnap: input.actorRoleSnap,
      resourceType: 'activity',
      resourceId: input.activityId,
      meta: input.auditMeta,
      extra: {
        operation: 'activity-session-reschedule',
        sessionIds: rescheduledSessionIds,
        reissuedCredentialCount: reissued.length,
      },
      tx,
    });

    return {
      rescheduledSessionCount: rescheduledSessionIds.length,
      reissuedCredentialCount: reissued.length,
    };
  },
};
