import { Injectable } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

// 一审 / 终审(合同 §5.11)的 audit 组装。
//
// ⚠️ **不新增 AuditLogEvent**:沿本模块既有 `activity.publish` 伞事件 + `extra.operation`
//    区分的范式(activities/CLAUDE.md「不改 audit event 名」红线;前三刀同处置)。
//    `operation` 取 `settlement-first-review` / `settlement-final-review`。
//
// extra 闭集(只放机器判定的输入与结论,不放人名、不放逐人明细):
//   operation / stage / action / 版本指针 / run 前后状态 / 一审人 / batch 指针 /
//   幂等键 / replayed 标志。
//
// 🔴 **`ledgerPostingBatchId` 与 `runStatusAfter` 一起进 extra 是有意的**:
//    「终审通过没有把 run 标 posted」这条红线,除了 e2e 断言之外,在**运维可查的
//    日志里**也留了正面证据 —— 事后审计不必去翻当时的 run 行。
@Injectable()
export class SettlementReviewAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}

  async log(args: {
    activityId: string;
    settlementRunId: string;
    settlementVersionId: string;
    settlementVersion: number;
    stageCode: 'first' | 'final';
    actionCode: 'approve' | 'return';
    reviewActionId: string;
    runStatusBefore: string;
    runStatusAfter: string;
    versionStatusAfter: string;
    /** 终审时的一审人;一审时为 null。 */
    firstReviewerUserId: string | null;
    /** 终审通过时创建/恢复的账本批次;其余情形 null。 */
    ledgerPostingBatchId: string | null;
    /** 终审通过时该批次的状态(必须是 `preparing`/`ready`,**不是** committed)。 */
    ledgerPostingBatchStatus: string | null;
    contentHash: string;
    operationKey: string;
    requestHash: string;
    replayed: boolean;
    actorUserId: string;
    actorRoleSnap: Role;
    auditMeta: AuditMeta;
    tx: Prisma.TransactionClient;
  }): Promise<void> {
    await this.auditLogs.log({
      event: 'activity.publish',
      actorUserId: args.actorUserId,
      actorRoleSnap: args.actorRoleSnap,
      resourceType: 'activity',
      resourceId: args.activityId,
      meta: args.auditMeta,
      extra: {
        operation:
          args.stageCode === 'first' ? 'settlement-first-review' : 'settlement-final-review',
        stageCode: args.stageCode,
        actionCode: args.actionCode,
        settlementRunId: args.settlementRunId,
        settlementVersionId: args.settlementVersionId,
        settlementVersion: args.settlementVersion,
        reviewActionId: args.reviewActionId,
        runStatusBefore: args.runStatusBefore,
        runStatusAfter: args.runStatusAfter,
        versionStatusAfter: args.versionStatusAfter,
        firstReviewerUserId: args.firstReviewerUserId,
        ledgerPostingBatchId: args.ledgerPostingBatchId,
        ledgerPostingBatchStatus: args.ledgerPostingBatchStatus,
        contentHash: args.contentHash,
        operationKey: args.operationKey,
        requestHash: args.requestHash,
        replayed: args.replayed,
      },
      tx: args.tx,
    });
  }
}
