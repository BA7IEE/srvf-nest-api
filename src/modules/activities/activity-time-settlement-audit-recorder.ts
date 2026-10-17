import { Injectable } from '@nestjs/common';
import type { ActivitySettlementContributionRevision, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { TimeSettlementReceiptResult } from './activity-time-settlement-command';

@Injectable()
export class ActivityTimeSettlementAuditRecorder {
  constructor(private readonly audit: AuditLogsService) {}

  async log(
    tx: Prisma.TransactionClient,
    actor: CurrentUserPayload,
    meta: AuditMeta,
    operationCode: 'prepare_time_settlement' | 'submit_time_settlement',
    result: TimeSettlementReceiptResult,
    replayed: boolean,
    contribution?: Pick<
      ActivitySettlementContributionRevision,
      'id' | 'regimeCode' | 'sourceSetHash' | 'evaluationSetHash'
    > | null,
  ): Promise<void> {
    await this.audit.log({
      event: 'activity.time-settlement.command',
      actorUserId: actor.id,
      actorRoleSnap: actor.role,
      resourceType: 'activity',
      resourceId: result.activityId,
      tx,
      meta,
      extra: {
        operationCode,
        timeRevisionId: result.timeRevisionId,
        settlementVersionId: result.settlementVersionId,
        revision: result.revision,
        kindCode: result.kindCode,
        bucketCount: result.bucketCount,
        sourceCount: result.sourceCount,
        replayed,
        ...(contribution
          ? {
              contributionRevisionId: contribution.id,
              contributionRegimeCode: contribution.regimeCode,
              contributionSourceSetHash: contribution.sourceSetHash,
              contributionEvaluationSetHash: contribution.evaluationSetHash,
            }
          : {}),
      },
    });
  }
}
