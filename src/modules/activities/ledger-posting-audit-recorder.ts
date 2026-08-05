import { Injectable } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

// 账本统一生效(合同 §5.13)的 audit 组装。
//
// ⚠️ **不新增 AuditLogEvent**:沿本模块既有 `activity.publish` 伞事件 + `extra.operation`
//    区分的范式(activities/CLAUDE.md「不改 audit event 名」红线;前四刀同处置)。
//    `operation` 取 `settlement-ledger-commit`。
//
// 🔴 **本 recorder 是"原子切换"那条判据的落点**:它是 `commitBatch` 事务里的**最后一步**。
//    e2e 让它抛错,断言批次仍 `ready`、run 仍 `posting`、分录仍不可见、day-state 一行未动
//    —— 也就是说,这一行写不进去,前面那一整批账就都不算数。
//
// extra 闭集(只放机器判定的输入与结论,**不放逐人明细**):
//   operation / 批次与版本指针 / 前后状态 / 三个规模数 / 基线摘要 / 幂等键 / replayed。
//   ⚠️ 刻意不放 memberId 列表:万人量级的 audit extra 会把审计表撑爆,而且那份名单
//      在 `ParticipationLedgerEntry` 上本来就是可查的(committed 之后)。
@Injectable()
export class LedgerPostingAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}

  async log(args: {
    activityId: string;
    settlementRunId: string;
    settlementVersionId: string;
    settlementVersion: number;
    postingBatchId: string;
    batchStatus: string;
    runStatus: string;
    memberCount: number;
    dayStateCount: number;
    entryCount: number;
    committedAt: Date | null;
    /** 准备时的 day-state 基线摘要(§3.22 `baselineJsonHash`)。 */
    baselineJsonHash: string | null;
    operationKey: string;
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
        operation: 'settlement-ledger-commit',
        settlementRunId: args.settlementRunId,
        settlementVersionId: args.settlementVersionId,
        settlementVersion: args.settlementVersion,
        postingBatchId: args.postingBatchId,
        batchStatus: args.batchStatus,
        runStatus: args.runStatus,
        memberCount: args.memberCount,
        dayStateCount: args.dayStateCount,
        entryCount: args.entryCount,
        committedAt: args.committedAt?.toISOString() ?? null,
        baselineJsonHash: args.baselineJsonHash,
        operationKey: args.operationKey,
        replayed: args.replayed,
      },
      tx: args.tx,
    });
  }
}
