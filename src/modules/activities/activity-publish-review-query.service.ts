import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import {
  ActivityPublishReviewResponseDto,
  ListActivityPublishReviewsQueryDto,
} from './activity-publish-review.dto';
import {
  ActivityPublishReviewPresenter,
  activityPublishReviewViewSelect,
} from './activity-publish-review-presenter';

@Injectable()
export class ActivityPublishReviewQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly presenter: ActivityPublishReviewPresenter,
  ) {}

  async list(
    query: ListActivityPublishReviewsQueryDto,
    user: CurrentUserPayload,
  ): Promise<PageResultDto<ActivityPublishReviewResponseDto>> {
    const scope = await this.authz.getVisibleOrganizationScope(
      user,
      'activity-review.read.request',
    );
    if (!scope.hasPermission) throw new BizException(BizCode.RBAC_FORBIDDEN);

    let requestedOrgIds: string[] | undefined;
    if (query.organizationId) {
      requestedOrgIds = query.includeDescendants
        ? (
            await this.prisma.organizationClosure.findMany({
              where: { ancestorId: query.organizationId },
              select: { descendantId: true },
            })
          ).map((row) => row.descendantId)
        : [query.organizationId];
    }
    const visibleOrgIds = scope.global
      ? requestedOrgIds
      : requestedOrgIds
        ? requestedOrgIds.filter((id) => scope.organizationIds.includes(id))
        : scope.organizationIds;

    const where: Prisma.ActivityPublishReviewWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.requestType ? { requestType: query.requestType } : {}),
      ...(query.submittedFrom || query.submittedTo
        ? {
            submittedAt: {
              ...(query.submittedFrom ? { gte: new Date(query.submittedFrom) } : {}),
              ...(query.submittedTo ? { lte: new Date(query.submittedTo) } : {}),
            },
          }
        : {}),
      activity: {
        ...(visibleOrgIds ? { organizationId: { in: visibleOrgIds } } : {}),
        ...(query.activityQ ? { title: { contains: query.activityQ, mode: 'insensitive' } } : {}),
        ...(query.initiatorQ
          ? {
              initiator: {
                OR: [
                  { displayName: { contains: query.initiatorQ, mode: 'insensitive' } },
                  { memberNo: { contains: query.initiatorQ, mode: 'insensitive' } },
                ],
              },
            }
          : {}),
      },
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.activityPublishReview.findMany({
        where,
        select: activityPublishReviewViewSelect,
        orderBy: { submittedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.activityPublishReview.count({ where }),
    ]);
    return {
      items: rows.map((row) => this.presenter.toDto(row)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async findOne(id: string, user: CurrentUserPayload): Promise<ActivityPublishReviewResponseDto> {
    const decision = await this.authz.explain(user, 'activity-review.read.request', {
      type: 'activity_publish_review',
      id,
    });
    if (!decision.allow) {
      throw new BizException(
        decision.reason === 'resource_not_found'
          ? BizCode.ACTIVITY_PUBLISH_REVIEW_NOT_FOUND
          : BizCode.RBAC_FORBIDDEN,
      );
    }
    const row = await this.prisma.activityPublishReview.findUnique({
      where: { id },
      select: activityPublishReviewViewSelect,
    });
    if (!row) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_NOT_FOUND);
    const affectedMembers = await this.prisma.activityParticipationIdentity.findMany({
      where: { activityId: row.activityId, populationIncluded: true },
      distinct: ['memberId'],
      select: { memberId: true },
    });
    return {
      ...this.presenter.toDto(row),
      changeDiff: this.changeDiff(row.snapshot),
      affectedMemberCount: affectedMembers.length,
    };
  }

  private changeDiff(snapshot: Prisma.JsonValue): Record<string, unknown> {
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return { kind: 'unparseable' };
    }
    const record = snapshot as Record<string, unknown>;
    // v3 adds Form, v4 adds allocation mode, and v5 adds typed qualification RuleSets. All
    // proposal generations retain the same Activity/Session diff envelope.
    if (
      (record.schemaVersion !== 2 &&
        record.schemaVersion !== 3 &&
        record.schemaVersion !== 4 &&
        record.schemaVersion !== 5) ||
      !this.isRecord(record.base)
    ) {
      return { kind: 'legacy', requestSchemaVersion: record.schemaVersion ?? null };
    }
    const base = record.base;
    const activity = this.isRecord(record.activity) ? record.activity : {};
    const baseActivity = this.isRecord(base.activity) ? base.activity : {};
    return {
      kind: record.schemaVersion === 5 ? 'proposal-v5' : 'proposal-v2',
      activityFields: Object.keys(activity)
        .filter((key) => JSON.stringify(activity[key]) !== JSON.stringify(baseActivity[key]))
        .sort(),
      sessions: this.collectionDiff(
        Array.isArray(base.sessions) ? base.sessions : [],
        Array.isArray(record.sessions) ? record.sessions : [],
        'sessionId',
      ),
      ...(record.schemaVersion === 5
        ? {
            qualificationRuleSets: this.qualificationRuleSetDiff(
              base.qualificationRuleSets,
              record.qualificationRuleSets,
            ),
          }
        : {}),
    };
  }

  /** Safe administrative summary: scopes and change kind, never evaluator input facts. */
  private qualificationRuleSetDiff(before: unknown, after: unknown): Record<string, unknown> {
    const rows = (value: unknown): Record<string, unknown>[] => {
      if (!this.isRecord(value) || !Array.isArray(value.ruleSets)) return [];
      return value.ruleSets.filter(this.isRecord);
    };
    const scope = (row: Record<string, unknown>): Record<string, unknown> | null =>
      this.isRecord(row.scope)
        ? {
            sessionId: row.scope.sessionId ?? null,
            positionId: row.scope.positionId ?? null,
          }
        : null;
    const key = (row: Record<string, unknown>): string | null => {
      const value = scope(row);
      return value === null ? null : JSON.stringify([value.sessionId, value.positionId]);
    };
    const beforeByScope = new Map(
      rows(before).flatMap((row) => {
        const identity = key(row);
        return identity === null ? [] : [[identity, row] as const];
      }),
    );
    const afterByScope = new Map(
      rows(after).flatMap((row) => {
        const identity = key(row);
        return identity === null ? [] : [[identity, row] as const];
      }),
    );
    return {
      create: [...afterByScope.entries()]
        .filter(([identity]) => !beforeByScope.has(identity))
        .map(([, row]) => scope(row)),
      update: [...afterByScope.entries()]
        .filter(([identity, row]) => {
          const previous = beforeByScope.get(identity);
          return previous !== undefined && JSON.stringify(previous.rules) !== JSON.stringify(row.rules);
        })
        .map(([, row]) => scope(row)),
      cancel: [...beforeByScope.entries()]
        .filter(([identity]) => !afterByScope.has(identity))
        .map(([, row]) => scope(row)),
    };
  }

  private collectionDiff(
    before: unknown[],
    after: unknown[],
    idKey: 'sessionId' | 'positionId',
  ): Record<string, unknown> {
    const beforeById = new Map(
      before
        .filter(this.isRecord)
        .map((item) => [String(item[idKey] ?? item.clientRef ?? item.code), item]),
    );
    return {
      create: after
        .filter(this.isRecord)
        .filter((item) => !beforeById.has(String(item[idKey] ?? item.clientRef ?? item.code)))
        .map((item) => ({ id: item[idKey] ?? item.clientRef ?? item.code, code: item.code })),
      update: after.filter(this.isRecord).flatMap((item) => {
        const id = String(item[idKey] ?? item.clientRef ?? item.code);
        const previous = beforeById.get(id);
        if (!previous) return [];
        const changedFields = Object.keys(item)
          .filter((key) => key !== 'positions')
          .filter((key) => JSON.stringify(item[key]) !== JSON.stringify(previous[key]))
          .sort();
        const result: Record<string, unknown> = { id, changedFields };
        if (idKey === 'sessionId') {
          result.positions = this.collectionDiff(
            Array.isArray(previous.positions) ? previous.positions : [],
            Array.isArray(item.positions) ? item.positions : [],
            'positionId',
          );
        }
        return [result];
      }),
      cancel: after
        .filter(this.isRecord)
        .filter((item) => item.cancelled === true || item.statusCode === 'cancelled')
        .map((item) => ({ id: item[idKey] ?? item.clientRef ?? item.code, code: item.code })),
    };
  }

  private isRecord(this: void, value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
}
