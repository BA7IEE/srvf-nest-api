import { Injectable } from '@nestjs/common';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PaginationQueryDto } from '../../common/dto/pagination.dto';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  ActivitySettlementHttpService,
  type SettlementReviewListQuery,
} from './activity-settlement-http.service';
import { SettlementReviewQueryService } from './settlement-review-query.service';
import { SettlementReadAuditRecorder } from './settlement-read-audit-recorder';
import { presentSettlementReviewResult } from './settlement-review-presenter';

/** HTTP sensitive reads: service authorization → exact-version query → audit → response. */
@Injectable()
export class AdminSettlementReadService {
  constructor(
    private readonly settlements: ActivitySettlementHttpService,
    private readonly query: SettlementReviewQueryService,
    private readonly audit: SettlementReadAuditRecorder,
  ) {}

  async list(query: SettlementReviewListQuery, user: CurrentUserPayload, meta: AuditMeta) {
    const page = await this.settlements.reviewWorkbench(query, user);
    const fields = (
      [
        'q',
        'activityQ',
        'activityId',
        'statusCode',
        'reviewStage',
        'organizationId',
        'includeDescendants',
        'dateFrom',
        'dateTo',
        'expand',
      ] as const
    ).filter((field) => query[field] !== undefined);
    await this.audit.record(user, 'collection', 'settlement-list', page.items.length, fields, meta);
    return page;
  }

  async reviewDetail(
    id: string,
    page: PaginationQueryDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ) {
    // Reuse the existing exact-resource permission check; no App owner grant,
    // extra member-read permission or approver-write permission is substituted.
    const detail = await this.settlements.reviewDetail(id, user);
    const rows = detail.version.statusCode === 'draft' ? null : await this.query.results(id, page);
    const results =
      rows === null
        ? null
        : {
            total: rows.total,
            page: rows.page,
            pageSize: rows.pageSize,
            items: rows.items.map((row) => ({
              ...presentSettlementReviewResult(row),
              timeResultState: rows.timeState,
              contributionResultState:
                rows.regimeCode === 'legacy'
                  ? 'legacy'
                  : rows.contributionReady
                    ? 'ready'
                    : 'pending',
              nativeCalculatedContributionPoints: rows.contributionReady
                ? (rows.nativePoints
                    .find(
                      (points) => points.participationIdentityId === row.participationIdentityId,
                    )
                    ?._sum.calculatedPoints?.toFixed(2) ?? '0.00')
                : null,
              nativeRecognizedContributionPoints: rows.contributionReady
                ? (rows.nativePoints
                    .find(
                      (points) => points.participationIdentityId === row.participationIdentityId,
                    )
                    ?._sum.recognizedPoints?.toFixed(2) ?? '0.00')
                : null,
              timeBuckets:
                rows.timeState === 'ready'
                  ? rows.timeBuckets
                      .filter(
                        (bucket) => bucket.participationIdentityId === row.participationIdentityId,
                      )
                      .map(({ categoryCode, calculatedSeconds, recognizedSeconds }) => ({
                        categoryCode,
                        calculatedSeconds,
                        recognizedSeconds,
                      }))
                  : null,
            })),
          };
    await this.audit.record(
      user,
      id,
      'settlement-review-detail',
      results?.items.length ?? 0,
      [],
      meta,
    );
    return { ...detail, results };
  }
}
