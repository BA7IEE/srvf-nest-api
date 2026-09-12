import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { ActivityTimeAllocationReceiptResult } from './activity-time-allocation-command';

@Injectable()
export class ActivityTimeAllocationAuditRecorder {
  constructor(private readonly audit: AuditLogsService) {}

  async log(
    tx: Prisma.TransactionClient,
    actor: CurrentUserPayload,
    meta: AuditMeta,
    result: ActivityTimeAllocationReceiptResult,
  ): Promise<void> {
    await this.audit.log({
      event: 'activity.time-allocation.command',
      actorUserId: actor.id,
      actorRoleSnap: actor.role,
      resourceType: 'activity',
      resourceId: result.activityId,
      tx,
      meta,
      extra: {
        allocationRevisionId: result.allocationRevisionId,
        revision: result.revision,
        sourceSegmentId: result.sourceSegmentId,
        sourceSegmentRevision: result.sourceSegmentRevision,
        recognitionModeCode: result.recognitionModeCode,
        sliceCount: result.sliceCount,
        evidenceCount: result.evidenceCount,
      },
    });
  }
}
