import { Injectable } from '@nestjs/common';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PaginationQueryDto } from '../../common/dto/pagination.dto';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { ListAdminMemberParticipationLedgerQueryDto } from './dto/admin/admin-settlement-read.dto';
import { LedgerQueryService } from './ledger-query.service';
import { ParticipationReadAuditRecorder } from './participation-read-audit-recorder';
import {
  ParticipationTimeProofQueryService,
  type ParticipationTimeProofQuery,
} from './participation-time-proof-query.service';

/** Admin HTTP 编排：查询层完成判权和读取后，审计成功才交还响应。共享查询端口保持只读。 */
@Injectable()
export class AdminParticipationReadService {
  constructor(
    private readonly ledger: LedgerQueryService,
    private readonly timeProof: ParticipationTimeProofQueryService,
    private readonly audit: ParticipationReadAuditRecorder,
  ) {}

  async listForMember(
    memberId: string,
    query: ListAdminMemberParticipationLedgerQueryDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    const page = await this.ledger.listForAdminMember(memberId, query, currentUser);
    await this.audit.log({
      currentUser,
      resourceType: 'member',
      resourceId: memberId,
      operation: 'participation-ledger',
      count: page.items.length,
      filterFields: this.dateFilterFields(query),
      auditMeta,
    });
    return page;
  }

  async listForActivity(
    activityId: string,
    query: PaginationQueryDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    const page = await this.ledger.listForAdminActivity(activityId, query, currentUser);
    await this.audit.log({
      currentUser,
      resourceType: 'activity',
      resourceId: activityId,
      operation: 'participation-ledger',
      count: page.items.length,
      filterFields: [],
      auditMeta,
    });
    return page;
  }

  async proofForMember(
    memberId: string,
    query: ParticipationTimeProofQuery,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    const proof = await this.timeProof.forAdminMember(memberId, query, currentUser);
    await this.audit.log({
      currentUser,
      resourceType: 'member',
      resourceId: memberId,
      operation: 'participation-time-proof',
      count: proof.items.length,
      filterFields: this.dateFilterFields(query),
      auditMeta,
    });
    return proof;
  }

  private dateFilterFields(query: {
    dateFrom?: string;
    dateTo?: string;
  }): Array<'dateFrom' | 'dateTo'> {
    return (['dateFrom', 'dateTo'] as const).filter((field) => query[field] !== undefined);
  }
}
