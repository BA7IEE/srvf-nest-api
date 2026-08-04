import { Injectable } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

// 提交不可变 SettlementVersion(合同 §5.10 ⑨)的 audit 组装。
//
// ⚠️ **不新增 AuditLogEvent**:沿本模块既有 `activity.publish` 伞事件 + `extra.operation`
//    区分的范式(activities/CLAUDE.md「不改 audit event 名」红线;第一/二刀同处置)。
//
// extra 闭集(只放机器判定的输入与结论,不放人名、不放逐人明细):
//   operation / 版本前后指针 / seal 与三个 revision / 三个计数 / contentHash /
//   幂等键 / replayed 标志。
//
// `replayed=true` 表示这次调用是**同 key 同 payload 的重放**:没有产生新版本,
// 但仍然留一条 audit —— "谁在什么时候又点了一次提交"是运维要能查到的事实。
@Injectable()
export class SettlementSubmitAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}

  async log(args: {
    activityId: string;
    settlementRunId: string;
    settlementVersionId: string;
    settlementVersion: number;
    priorVersionId: string | null;
    draftVersionId: string | null;
    evidenceSealId: string;
    sealRevision: number;
    evidenceRevision: number;
    populationRevision: number;
    workflowRevision: number;
    personCount: number;
    sessionParticipationCount: number;
    serviceSegmentCount: number;
    resultRowCount: number;
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
        operation: 'settlement-submit',
        settlementRunId: args.settlementRunId,
        settlementVersionId: args.settlementVersionId,
        settlementVersion: args.settlementVersion,
        priorVersionId: args.priorVersionId,
        draftVersionId: args.draftVersionId,
        evidenceSealId: args.evidenceSealId,
        sealRevision: args.sealRevision,
        evidenceRevision: args.evidenceRevision,
        populationRevision: args.populationRevision,
        workflowRevision: args.workflowRevision,
        personCount: args.personCount,
        sessionParticipationCount: args.sessionParticipationCount,
        serviceSegmentCount: args.serviceSegmentCount,
        resultRowCount: args.resultRowCount,
        contentHash: args.contentHash,
        operationKey: args.operationKey,
        requestHash: args.requestHash,
        replayed: args.replayed,
      },
      tx: args.tx,
    });
  }
}
