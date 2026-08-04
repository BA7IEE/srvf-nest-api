import { Injectable } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

// 证据封场(合同 §5.8 ⑧「写 immutable EvidenceSeal 和 audit」)的 audit 组装。
//
// ⚠️ **不新增 AuditLogEvent**:沿本模块既有 `activity.publish` 伞事件 + `extra.operation`
//    区分的范式(见 activities/CLAUDE.md「不改 audit event 名」红线)。
//    封场是活动生命周期上的一次写,归属与 publish / cancel / complete 同一资源同一伞。
//
// extra 闭集(只放机器判定的输入与结论,不放人名、不放明细行):
//   operation / sealId / sealRevision / evidenceRevision / populationRevision /
//   workflowRevision / populationCountDistinct / openSegmentCount /
//   manualReviewPendingCount / supersededSealCount / contentHash
@Injectable()
export class EvidenceSealAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}

  async log(args: {
    activityId: string;
    sealId: string;
    sealRevision: number;
    evidenceRevision: number;
    populationRevision: number;
    workflowRevision: number;
    populationCountDistinct: number;
    openSegmentCount: number;
    manualReviewPendingCount: number;
    supersededSealCount: number;
    contentHash: string;
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
        operation: 'evidence-seal',
        sealId: args.sealId,
        sealRevision: args.sealRevision,
        evidenceRevision: args.evidenceRevision,
        populationRevision: args.populationRevision,
        workflowRevision: args.workflowRevision,
        populationCountDistinct: args.populationCountDistinct,
        openSegmentCount: args.openSegmentCount,
        manualReviewPendingCount: args.manualReviewPendingCount,
        supersededSealCount: args.supersededSealCount,
        contentHash: args.contentHash,
      },
      tx: args.tx,
    });
  }
}
