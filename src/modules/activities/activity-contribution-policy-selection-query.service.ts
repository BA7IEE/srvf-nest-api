import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { contributionPolicyVersionDocument } from './activity-contribution-policy-presenter';
import {
  ActivityContributionPolicySelectionAccess,
  type ActivityContributionPolicySelectionSurface,
} from './activity-contribution-policy-selection-access';
import {
  presentActivityContributionPolicySelection,
  readStoredActivityContributionPolicySelection,
} from './activity-contribution-policy-selection-presenter';
import {
  activityTemplateContributionPolicyRuntimeSelection,
  parseActivityTemplateDefinitionV5,
} from './activity-template-definition-v5';
import type { ActivityContributionPolicyTemplateSelection } from './activity-contribution-policy-selection';

export interface ActivityContributionPolicySelectionPageQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly revision?: number;
}

export interface ActivityContributionPolicyOptionsQuery {
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

function templateSelection(
  template: {
    schemaVersion: number | null;
    definitionJson: Prisma.JsonValue | null;
    definitionHash: string | null;
  } | null,
  expectedHash: string | null,
): ActivityContributionPolicyTemplateSelection | null {
  if (!template && expectedHash === null) return null;
  if (
    !template ||
    template.schemaVersion !== 5 ||
    template.definitionJson === null ||
    template.definitionHash !== expectedHash
  ) {
    throw new TypeError('selection template anchor is unavailable');
  }
  return activityTemplateContributionPolicyRuntimeSelection(
    parseActivityTemplateDefinitionV5(template.definitionJson).contributionPolicySelection,
  );
}

@Injectable()
export class ActivityContributionPolicySelectionQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityContributionPolicySelectionAccess,
  ) {}

  async get(
    activityId: string,
    query: ActivityContributionPolicySelectionPageQuery,
    user: CurrentUserPayload,
    surface: ActivityContributionPolicySelectionSurface,
  ) {
    assertPage(query.page, query.pageSize);
    if (
      query.revision !== undefined &&
      (!Number.isSafeInteger(query.revision) ||
        query.revision < 1 ||
        query.revision > 2_147_483_647)
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
          'activity.contribution-policy.read',
        );
        const pointer = await tx.activity.findFirst({
          where: { id: activity.id, deletedAt: null },
          select: {
            contributionPolicySelectionRevision: true,
            currentContributionPolicySelectionRevisionId: true,
          },
        });
        if (!pointer) {
          throw new BizException(
            BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
          );
        }
        const requestedRevision = query.revision ?? pointer.contributionPolicySelectionRevision;
        if (requestedRevision === 0) {
          await this.access.authorize(
            tx,
            user,
            surface,
            activityId,
            'activity.contribution-policy.read',
          );
          return {
            activityId,
            selectionRevisionId: null,
            revision: 0,
            selectionHash: null,
            createdAt: null,
            items: [],
            resolved: [],
            total: 0,
            page: query.page,
            pageSize: query.pageSize,
            resolutionSummary: {
              targetCount: 0,
              resolvedTargetCount: 0,
              unresolvedTargetCount: 0,
            },
          };
        }
        const revision = await tx.activityContributionPolicySelectionRevision.findFirst({
          where: { activityId, revision: requestedRevision },
          select: {
            id: true,
            revision: true,
            selectionHash: true,
            selectionJson: true,
            itemCount: true,
            templateId: true,
            templateDefinitionHash: true,
            createdAt: true,
          },
        });
        if (!revision) {
          throw new BizException(
            BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
          );
        }
        const [total, pageItems, positions, template] = await Promise.all([
          tx.activityContributionPolicySelectionItem.count({
            where: { selectionRevisionId: revision.id, activityId },
          }),
          tx.activityContributionPolicySelectionItem.findMany({
            where: { selectionRevisionId: revision.id, activityId },
            select: {
              layerCode: true,
              sessionId: true,
              positionId: true,
              mode: true,
              policyId: true,
              versionId: true,
              definitionHash: true,
              evaluatorVersion: true,
            },
            orderBy: [{ layerCode: 'asc' }, { sessionId: 'asc' }, { positionId: 'asc' }],
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize,
          }),
          tx.activitySessionPosition.findMany({
            where: { activityId, deletedAt: null, session: { deletedAt: null } },
            select: {
              id: true,
              code: true,
              sessionId: true,
              session: { select: { code: true } },
            },
            orderBy: [{ sessionId: 'asc' }, { id: 'asc' }],
          }),
          revision.templateId
            ? tx.activityTemplate.findFirst({
                where: {
                  id: revision.templateId,
                  definitionHash: revision.templateDefinitionHash,
                },
                select: { schemaVersion: true, definitionJson: true, definitionHash: true },
              })
            : Promise.resolve(null),
        ]);
        try {
          const document = readStoredActivityContributionPolicySelection(revision);
          if (total !== revision.itemCount) {
            throw new TypeError('selection item count differs from immutable revision');
          }
          const result = presentActivityContributionPolicySelection({
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
            templateSelection: templateSelection(template, revision.templateDefinitionHash),
            targets: positions.map((position) => ({
              sessionId: position.sessionId,
              sessionCode: position.session.code,
              positionId: position.id,
              positionCode: position.code,
            })),
          });
          await this.access.authorize(
            tx,
            user,
            surface,
            activityId,
            'activity.contribution-policy.read',
          );
          return result;
        } catch (error) {
          if (error instanceof TypeError) {
            throw new BizException(
              BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_REFERENCE_UNAVAILABLE,
            );
          }
          throw error;
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async options(query: ActivityContributionPolicyOptionsQuery, user: CurrentUserPayload) {
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
        } satisfies Prisma.ContributionPolicyVersionWhereInput;
        const [total, rows] = await Promise.all([
          tx.contributionPolicyVersion.count({ where }),
          tx.contributionPolicyVersion.findMany({
            where,
            include: { policy: { select: { code: true, name: true } } },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize,
          }),
        ]);
        const items = rows.map((row) => {
          try {
            if (contributionPolicyVersionDocument(row).definitionHash !== row.definitionHash) {
              throw new TypeError('stored policy version hash differs');
            }
            return {
              policyId: row.policyId,
              versionId: row.id,
              definitionHash: row.definitionHash,
              evaluatorVersion: row.evaluatorVersion,
              policyCode: row.policy.code,
              policyName: row.policy.name,
              effectiveFrom: row.effectiveFrom.toISOString(),
              effectiveUntil: row.effectiveUntil?.toISOString() ?? null,
            };
          } catch {
            throw new BizException(
              BizCode.ACTIVITY_CONTRIBUTION_POLICY_SELECTION_POLICY_UNAVAILABLE,
            );
          }
        });
        await this.access.authorizeOptions(tx, user, query.organizationId);
        return { items, total, page: query.page, pageSize: query.pageSize };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
