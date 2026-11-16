import { Injectable } from '@nestjs/common';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';

/** 沿用考勤敏感读取事件；只记录资源锚点、读面、返回数量和过滤字段名。 */
@Injectable()
export class ParticipationReadAuditRecorder {
  constructor(private readonly auditLogs: AuditLogsService) {}

  async log(args: {
    currentUser: CurrentUserPayload;
    resourceType: 'activity' | 'member' | 'attendance_settlement_version';
    resourceId: string;
    operation: 'participation-ledger' | 'participation-time-proof' | 'settlement-review-detail';
    count: number;
    filterFields: Array<'dateFrom' | 'dateTo'>;
    auditMeta: AuditMeta;
  }): Promise<void> {
    await this.auditLogs.log({
      event: 'attendance-sheet.read.other',
      actorUserId: args.currentUser.id,
      actorRoleSnap: args.currentUser.role,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      meta: args.auditMeta,
      extra: {
        operation: args.operation,
        count: args.count,
        filterFields: args.filterFields,
      },
    });
  }
}
