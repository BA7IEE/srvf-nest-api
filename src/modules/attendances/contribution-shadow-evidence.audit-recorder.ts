import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

export type ShadowEvidenceReadOperation =
  | 'windows'
  | 'summary'
  | 'candidates'
  | 'candidate'
  | 'comparisons';

@Injectable()
export class ContributionShadowEvidenceAuditRecorder {
  constructor(private readonly audit: AuditLogsService) {}

  record(
    tx: Prisma.TransactionClient,
    user: CurrentUserPayload,
    meta: AuditMeta,
    operation: ShadowEvidenceReadOperation,
    target: { windowId?: string; auditLogId?: string; attemptId?: string },
    count: number,
  ) {
    return this.audit.log({
      tx,
      event: 'activity.contribution-shadow.evidence-read',
      actorUserId: user.id,
      actorRoleSnap: user.role,
      resourceType: 'contribution_shadow_evidence',
      resourceId: target.windowId ?? null,
      meta,
      extra: { operation, ...target, count },
    });
  }
}
