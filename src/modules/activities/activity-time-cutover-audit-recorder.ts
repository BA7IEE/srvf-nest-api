import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { ActivityTimeCutoverReceiptResult } from './activity-time-cutover-command';

@Injectable()
export class ActivityTimeCutoverAuditRecorder {
  constructor(private readonly audit: AuditLogsService) {}

  async log(
    tx: Prisma.TransactionClient,
    actor: CurrentUserPayload,
    meta: AuditMeta,
    result: ActivityTimeCutoverReceiptResult,
  ): Promise<void> {
    await this.audit.log({
      event: 'activity.time-cutover.command',
      actorUserId: actor.id,
      actorRoleSnap: actor.role,
      resourceType: 'activity-time-cutover',
      resourceId: result.id,
      tx,
      meta,
      extra: {
        operationCode: 'execute',
        receiptId: result.id,
        deployedMainSha: result.deployedMainSha,
        evidenceBundleHash: result.evidenceBundleHash,
        result: 'committed',
        replayed: false,
      },
    });
  }
}
