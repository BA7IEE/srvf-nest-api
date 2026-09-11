import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { timePolicyVersionDocument } from './activity-time-policy-presenter';
import {
  ActivityTimePolicySelectionAccess,
  type ActivityTimePolicySelectionSurface,
} from './activity-time-policy-selection-access';
import {
  presentActivityTimePolicySelection,
  readStoredActivityTimePolicySelection,
} from './activity-time-policy-selection-presenter';

export interface ActivityTimePolicySelectionPageQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly revision?: number;
}

export interface ActivityTimePolicyOptionsQuery {
  readonly organizationId: string;
  readonly plannedFrom: Date;
  readonly plannedUntil: Date;
  readonly page: number;
  readonly pageSize: number;
}

function assertPage(page: number, pageSize: number): void {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100 ||
    !Number.isSafeInteger((page - 1) * pageSize)
  ) {
    throw new BizException(BizCode.BAD_REQUEST);
  }
}

@Injectable()
export class ActivityTimePolicySelectionQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityTimePolicySelectionAccess,
  ) {}

  async get(
    activityId: string,
    query: ActivityTimePolicySelectionPageQuery,
    user: CurrentUserPayload,
    surface: ActivityTimePolicySelectionSurface,
  ) {
    assertPage(query.page, query.pageSize);
    if (
      query.revision !== undefined &&
      (!Number.isSafeInteger(query.revision) || query.revision < 1 || query.revision > 2147483647)
    ) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    return this.prisma.$transaction(
      async (tx) => {
        const { activity } = await this.access.authorize(
          tx,
          user,
          surface,
          activityId,
          'activity.time-policy.read',
        );
        const pointer = await tx.activity.findFirst({
          where: { id: activity.id, deletedAt: null },
          select: {
            timePolicySelectionRevision: true,
            currentTimePolicySelectionRevisionId: true,
          },
        });
        if (!pointer)
          throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
        const requestedRevision = query.revision ?? pointer.timePolicySelectionRevision;
        if (requestedRevision === 0) {
          await this.access.authorize(tx, user, surface, activityId, 'activity.time-policy.read');
          return {
            activityId,
            selectionRevisionId: null,
            revision: 0,
            selectionHash: null,
            createdAt: null,
            items: [],
            total: 0,
            page: query.page,
            pageSize: query.pageSize,
            resolutionSummary: { targetCount: 0, resolvedTargetCount: 0, unresolvedTargetCount: 0 },
          };
        }
        const revision = await tx.activityTimePolicySelectionRevision.findFirst({
          where: { activityId, revision: requestedRevision },
          select: {
            id: true,
            revision: true,
            selectionHash: true,
            selectionJson: true,
            itemCount: true,
            createdAt: true,
          },
        });
        if (!revision)
          throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
        const [total, pageItems, sessions, positions] = await Promise.all([
          tx.activityTimePolicySelectionItem.count({
            where: { selectionRevisionId: revision.id, activityId },
          }),
          tx.activityTimePolicySelectionItem.findMany({
            where: { selectionRevisionId: revision.id, activityId },
            select: {
              layerCode: true,
              sessionId: true,
              positionId: true,
              mode: true,
              policyId: true,
              versionId: true,
              definitionHash: true,
            },
            orderBy: [{ layerCode: 'asc' }, { sessionId: 'asc' }, { positionId: 'asc' }],
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize,
          }),
          tx.activitySession.findMany({
            where: { activityId },
            select: { id: true },
            orderBy: { id: 'asc' },
          }),
          tx.activitySessionPosition.findMany({
            where: { activityId },
            select: { id: true, sessionId: true },
            orderBy: { id: 'asc' },
          }),
        ]);
        try {
          const document = readStoredActivityTimePolicySelection(revision);
          if (total !== revision.itemCount)
            throw new TypeError('selection item count differs from immutable revision');
          const targets = sessions.map((session) => ({
            sessionId: session.id,
            positionIds: positions
              .filter((position) => position.sessionId === session.id)
              .map((position) => position.id),
          }));
          const result = presentActivityTimePolicySelection({
            activityId,
            selectionRevisionId: revision.id,
            revision: revision.revision,
            selectionHash: revision.selectionHash,
            createdAt: revision.createdAt,
            document,
            pageItems,
            total,
            page: query.page,
            pageSize: query.pageSize,
            targets,
          });
          await this.access.authorize(tx, user, surface, activityId, 'activity.time-policy.read');
          return result;
        } catch (error) {
          if (error instanceof TypeError)
            throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_REFERENCE_UNAVAILABLE);
          throw error;
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async options(query: ActivityTimePolicyOptionsQuery, user: CurrentUserPayload) {
    assertPage(query.page, query.pageSize);
    if (
      !Number.isFinite(query.plannedFrom.getTime()) ||
      !Number.isFinite(query.plannedUntil.getTime()) ||
      query.plannedUntil <= query.plannedFrom
    ) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    return this.prisma.$transaction(
      async (tx) => {
        await this.access.authorizeOptions(tx, user, query.organizationId);
        const where = {
          statusCode: 'active',
          schemaVersion: 1,
          evaluatorVersion: 1,
          effectiveFrom: { lte: query.plannedFrom },
          OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: query.plannedUntil } }],
        } satisfies Prisma.TimePolicyVersionWhereInput;
        const [total, rows] = await Promise.all([
          tx.timePolicyVersion.count({ where }),
          tx.timePolicyVersion.findMany({
            where,
            include: { policy: { select: { code: true, name: true } } },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize,
          }),
        ]);
        const items = rows.map((row) => {
          try {
            if (timePolicyVersionDocument(row).definitionHash !== row.definitionHash) {
              throw new TypeError('stored policy version hash differs');
            }
            return {
              policyId: row.policyId,
              versionId: row.id,
              definitionHash: row.definitionHash,
              policyCode: row.policy.code,
              policyName: row.policy.name,
              effectiveFrom: row.effectiveFrom.toISOString(),
              effectiveUntil: row.effectiveUntil?.toISOString() ?? null,
            };
          } catch {
            throw new BizException(BizCode.ACTIVITY_TIME_POLICY_SELECTION_POLICY_UNAVAILABLE);
          }
        });
        await this.access.authorizeOptions(tx, user, query.organizationId);
        return { items, total, page: query.page, pageSize: query.pageSize };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
