import { Injectable } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';

import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { ActivityClosureCheckSummary } from './activity-closure-checks';

// 机器关账(合同 §5.15 ⑪)的 audit 组装。
//
// ⚠️ **不新增 AuditLogEvent**:沿本模块既有 `activity.publish` 伞事件 + `extra.operation`
//    区分的范式(activities/CLAUDE.md「不改 audit event 名」红线;前五刀同处置)。
//    `operation` 取 `settlement-closure`。
//
// extra 闭集(只放机器判定的输入与结论,**不放人名、不放逐人明细**):
//   operation / closure 指针与三个 revision / 五个摘要 / checksHash / 八类逐类通过与计数 /
//   幂等键 / replayed / 归档等待。
//
// 🔴 `archiveWaitingDays` 与 `archiveWaitingUntil` 一起进 extra 是有意的:全仓**没有**
//    archive 状态列(见 service 文件头偏离说明 ③),归档等待是派生态 ⇒ 运维要回答
//    "这场活动什么时候可以归档"时,除了自己算,还能直接从这条日志读到当时的结论。
@Injectable()
export class ActivityClosureAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}

  async log(args: {
    activityId: string;
    closureRevisionId: string;
    revision: number;
    settlementRunId: string;
    settlementVersionId: string;
    postingBatchId: string;
    evidenceSealId: string;
    evidenceRevision: number;
    populationRevision: number;
    workflowRevision: number;
    personCount: number;
    sessionParticipationCount: number;
    resultCountsJson: Readonly<Record<string, number>>;
    serviceHours: string;
    contributionPoints: string;
    checksHash: string;
    closedAt: Date;
    archiveWaitingDays: number;
    archiveWaitingUntil: Date;
    checks: readonly ActivityClosureCheckSummary[];
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
        operation: 'settlement-closure',
        closureRevisionId: args.closureRevisionId,
        revision: args.revision,
        settlementRunId: args.settlementRunId,
        settlementVersionId: args.settlementVersionId,
        postingBatchId: args.postingBatchId,
        evidenceSealId: args.evidenceSealId,
        evidenceRevision: args.evidenceRevision,
        populationRevision: args.populationRevision,
        workflowRevision: args.workflowRevision,
        personCount: args.personCount,
        sessionParticipationCount: args.sessionParticipationCount,
        resultCountsJson: args.resultCountsJson,
        serviceHours: args.serviceHours,
        contributionPoints: args.contributionPoints,
        checksHash: args.checksHash,
        closedAt: args.closedAt.toISOString(),
        archiveWaitingDays: args.archiveWaitingDays,
        archiveWaitingUntil: args.archiveWaitingUntil.toISOString(),
        // 只留「哪一类、通过没有、几个缺口」——`details` 已经在 checksJson 里,
        // 不在 audit 里复制第二份(两处真相源会漂移)。
        checks: args.checks.map((check) => ({
          gapCode: check.gapCode,
          passed: check.passed,
          count: check.count,
        })),
        operationKey: args.operationKey,
        requestHash: args.requestHash,
        replayed: args.replayed,
      },
      tx: args.tx,
    });
  }
}
