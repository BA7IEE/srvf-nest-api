import { Injectable } from '@nestjs/common';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

@Injectable()
export class SettlementReadAuditRecorder {
  constructor(private readonly audit: AuditLogsService) {}

  async record(
    user: CurrentUserPayload,
    resourceId: string,
    operation: 'settlement-list' | 'settlement-review-detail',
    count: number,
    filterFields: string[],
    meta: AuditMeta,
  ) {
    await this.audit.log({
      event: 'attendance-sheet.read.other',
      actorUserId: user.id,
      actorRoleSnap: user.role,
      resourceType: 'attendance_settlement_version',
      resourceId,
      extra: { operation, count, filterFields },
      meta,
    });
  }
}
