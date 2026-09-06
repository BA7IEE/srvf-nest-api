import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type {
  TemplateVersionCommandResult,
  TemplateVersionOperation,
} from './activity-template-version-command';
@Injectable()
export class ActivityTemplateVersionAuditRecorder {
  constructor(private readonly audit: AuditLogsService) {}
  async log(
    tx: Prisma.TransactionClient,
    actor: CurrentUserPayload,
    meta: AuditMeta,
    operation: TemplateVersionOperation,
    result: TemplateVersionCommandResult,
    before: { statusCode: string; definitionHash: string | null } | null,
  ) {
    await this.audit.log({
      event: 'activity.template-version.command',
      actorUserId: actor.id,
      actorRoleSnap: actor.role,
      resourceType: 'activity-template-version',
      resourceId: result.id,
      tx,
      meta,
      extra: {
        operation,
        source: 'admin',
        beforeStatus: before?.statusCode ?? null,
        beforeHash: before?.definitionHash ?? null,
        afterStatus: result.statusCode,
        afterHash: result.definitionHash,
        version: result.version,
      },
    });
  }
}
