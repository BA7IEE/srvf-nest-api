import { Injectable } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

// 更正应用(合同 §5.14)的 audit 组装。
//
// ⚠️ **不新增 AuditLogEvent**:沿本模块既有 `activity.publish` 伞事件 + `extra.operation`
//    区分的范式(activities/CLAUDE.md「不改 audit event 名」红线;前六刀同处置)。
//    四个 `operation`:`correction-submit` / `correction-review` / `correction-void` /
//    `correction-prepare` / `correction-commit`。
//
// 🔴 **`logCommit` 是"原子切换"那条判据的落点**:它是 commit 事务里的**最后一步**。
//    e2e 让它抛错,断言七项全部回滚(旧结果仍 committed、旧 closure 仍 active、
//    `Activity.currentClosureRevision` 未清、申请仍 `applying`、批次仍 `ready`、
//    day-state 一行未动、账本零新分录可见)。
//
// extra 闭集(只放机器判定的输入与结论,**不放逐人明细**):
//   operation / 申请与应用指针 / 新旧版本与批次 / 三个规模数 / 切换读数 / 幂等键。
//   ⚠️ 刻意不放 `requestedChangeJson`:它含逐人明细,万人量级会把审计表撑爆,
//      而那份内容在 `AttendanceCorrectionRequest` 上本来就可查。只放**计数**。
@Injectable()
export class CorrectionAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}

  async logSubmit(args: {
    correctionRequestId: string;
    activityId: string;
    activityTitle: string;
    settlementRunId: string;
    baseSettlementVersionId: string;
    baseResultRevisionId: string | null;
    baseClosureRevision: number;
    statusCode: string;
    requestTypeCode: string;
    resultChangeCount: number;
    segmentChangeCount: number;
    operationKey: string;
    requestHash: string;
    replayed: boolean;
    actorUserId: string;
    actorRoleSnap: Role;
    auditMeta: AuditMeta;
    tx: Prisma.TransactionClient;
  }): Promise<void> {
    await this.write(args.activityId, args, {
      operation: 'correction-submit',
      correctionRequestId: args.correctionRequestId,
      activityTitle: args.activityTitle,
      settlementRunId: args.settlementRunId,
      baseSettlementVersionId: args.baseSettlementVersionId,
      baseResultRevisionId: args.baseResultRevisionId,
      baseClosureRevision: args.baseClosureRevision,
      requestTypeCode: args.requestTypeCode,
      statusCode: args.statusCode,
      resultChangeCount: args.resultChangeCount,
      segmentChangeCount: args.segmentChangeCount,
      operationKey: args.operationKey,
      requestHash: args.requestHash,
      replayed: args.replayed,
    });
  }

  async logReview(args: {
    correctionRequestId: string;
    activityId: string;
    actionCode: string;
    statusCode: string;
    runStatus: string;
    note: string | null;
    reviewedByUserId: string;
    replayed: boolean;
    actorUserId: string;
    actorRoleSnap: Role;
    auditMeta: AuditMeta;
    tx: Prisma.TransactionClient;
  }): Promise<void> {
    await this.write(args.activityId, args, {
      operation: 'correction-review',
      correctionRequestId: args.correctionRequestId,
      actionCode: args.actionCode,
      statusCode: args.statusCode,
      runStatus: args.runStatus,
      // 审核意见是人写的自由文本,可能含人员信息 ⇒ 只记**有没有**,不记内容。
      hasNote: args.note !== null,
      reviewedByUserId: args.reviewedByUserId,
      replayed: args.replayed,
    });
  }

  async logVoided(args: {
    correctionRequestId: string;
    activityId: string;
    baseSettlementVersionId: string;
    currentSettlementVersionId: string | null;
    baseClosureRevision: number;
    currentClosureRevision: number;
    actorUserId: string;
    actorRoleSnap: Role;
    auditMeta: AuditMeta;
    tx: Prisma.TransactionClient;
  }): Promise<void> {
    await this.write(args.activityId, args, {
      operation: 'correction-void',
      correctionRequestId: args.correctionRequestId,
      statusCode: 'voided',
      // 两组锚点都记下来:排查时一眼看出是版本被顶掉还是又关了一次账。
      baseSettlementVersionId: args.baseSettlementVersionId,
      currentSettlementVersionId: args.currentSettlementVersionId,
      baseClosureRevision: args.baseClosureRevision,
      currentClosureRevision: args.currentClosureRevision,
    });
  }

  async logPrepare(args: {
    correctionRequestId: string;
    correctionApplicationId: string;
    activityId: string;
    settlementRunId: string;
    baseSettlementVersionId: string;
    newSettlementVersionId: string;
    newSettlementVersion: number;
    newPostingBatchId: string;
    newResultRevisionIds: readonly string[];
    newSegmentRevisionCount: number;
    reversalEntryCount: number;
    replacementEntryCount: number;
    batchStatus: string;
    operationKey: string;
    requestHash: string;
    replayed: boolean;
    actorUserId: string;
    actorRoleSnap: Role;
    auditMeta: AuditMeta;
    tx: Prisma.TransactionClient;
  }): Promise<void> {
    await this.write(args.activityId, args, {
      operation: 'correction-prepare',
      correctionRequestId: args.correctionRequestId,
      correctionApplicationId: args.correctionApplicationId,
      settlementRunId: args.settlementRunId,
      baseSettlementVersionId: args.baseSettlementVersionId,
      newSettlementVersionId: args.newSettlementVersionId,
      newSettlementVersion: args.newSettlementVersion,
      newPostingBatchId: args.newPostingBatchId,
      // ⚠️ 只记**条数**,不记 id 列表(万人量级会把 extra 撑爆;
      //    真名单在 `CorrectionApplication.newResultRevisionIds` 上)。
      newResultRevisionCount: args.newResultRevisionIds.length,
      newSegmentRevisionCount: args.newSegmentRevisionCount,
      reversalEntryCount: args.reversalEntryCount,
      replacementEntryCount: args.replacementEntryCount,
      batchStatus: args.batchStatus,
      operationKey: args.operationKey,
      requestHash: args.requestHash,
      replayed: args.replayed,
    });
  }

  async logCommit(args: {
    correctionRequestId: string;
    correctionApplicationId: string;
    activityId: string;
    settlementRunId: string;
    ledger: {
      postingBatchId: string;
      settlementVersionId: string;
      settlementVersion: number;
      memberCount: number;
      dayStateCount: number;
      entryCount: number;
    };
    supersededResultRevisionCount: number;
    supersededSegmentRevisionCount: number;
    supersededClosureRevision: number | null;
    activityClosurePointerCleared: boolean;
    correctionStatus: string;
    applicationStatus: string;
    operationKey: string;
    requestHash: string;
    replayed: boolean;
    actorUserId: string;
    actorRoleSnap: Role;
    auditMeta: AuditMeta;
    tx: Prisma.TransactionClient;
  }): Promise<void> {
    await this.write(args.activityId, args, {
      operation: 'correction-commit',
      correctionRequestId: args.correctionRequestId,
      correctionApplicationId: args.correctionApplicationId,
      settlementRunId: args.settlementRunId,
      postingBatchId: args.ledger.postingBatchId,
      newSettlementVersionId: args.ledger.settlementVersionId,
      newSettlementVersion: args.ledger.settlementVersion,
      memberCount: args.ledger.memberCount,
      dayStateCount: args.ledger.dayStateCount,
      entryCount: args.ledger.entryCount,
      // §5.14 ⑥ 七项切换的读数 —— 排查时不必再去数表。
      supersededResultRevisionCount: args.supersededResultRevisionCount,
      supersededSegmentRevisionCount: args.supersededSegmentRevisionCount,
      supersededClosureRevision: args.supersededClosureRevision,
      activityClosurePointerCleared: args.activityClosurePointerCleared,
      correctionStatus: args.correctionStatus,
      applicationStatus: args.applicationStatus,
      operationKey: args.operationKey,
      requestHash: args.requestHash,
      replayed: args.replayed,
    });
  }

  private async write(
    activityId: string,
    actor: {
      actorUserId: string;
      actorRoleSnap: Role;
      auditMeta: AuditMeta;
      tx: Prisma.TransactionClient;
    },
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.auditLogs.log({
      event: 'activity.publish',
      actorUserId: actor.actorUserId,
      actorRoleSnap: actor.actorRoleSnap,
      resourceType: 'activity',
      resourceId: activityId,
      meta: actor.auditMeta,
      extra,
      tx: actor.tx,
    });
  }
}
