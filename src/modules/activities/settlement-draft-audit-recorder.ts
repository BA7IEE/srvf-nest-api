import { Injectable } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

// 结算草稿生成(合同 §5.9)的 audit 组装。
//
// ⚠️ **不新增 AuditLogEvent**:沿本模块既有 `activity.publish` 伞事件 + `extra.operation`
//    区分的范式(activities/CLAUDE.md「不改 audit event 名」红线;第一刀封场同处置)。
//
// extra 闭集(只放机器判定的输入与结论,不放人名、不放逐人明细):
//   operation / settlementVersionId / settlementVersion / evidenceSealId / sealRevision /
//   personCount / sessionParticipationCount / serviceSegmentCount /
//   决议数 / 待定数 / blocker 数 / 段的三种处置计数 / contentHash
@Injectable()
export class SettlementDraftAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}

  async log(args: {
    activityId: string;
    settlementVersionId: string;
    settlementVersion: number;
    evidenceSealId: string;
    sealRevision: number;
    personCount: number;
    sessionParticipationCount: number;
    serviceSegmentCount: number;
    determinedItemCount: number;
    pendingItemCount: number;
    blockedItemCount: number;
    segmentsCreated: number;
    segmentsSuperseded: number;
    segmentsUnchanged: number;
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
        operation: 'settlement-draft-generate',
        settlementVersionId: args.settlementVersionId,
        settlementVersion: args.settlementVersion,
        evidenceSealId: args.evidenceSealId,
        sealRevision: args.sealRevision,
        personCount: args.personCount,
        sessionParticipationCount: args.sessionParticipationCount,
        serviceSegmentCount: args.serviceSegmentCount,
        determinedItemCount: args.determinedItemCount,
        pendingItemCount: args.pendingItemCount,
        blockedItemCount: args.blockedItemCount,
        segmentsCreated: args.segmentsCreated,
        segmentsSuperseded: args.segmentsSuperseded,
        segmentsUnchanged: args.segmentsUnchanged,
        contentHash: args.contentHash,
      },
      tx: args.tx,
    });
  }
}
