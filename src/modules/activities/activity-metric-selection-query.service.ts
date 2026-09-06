import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import {
  ActivityMetricSelectionAccess,
  type MetricSelectionSurface,
} from './activity-metric-selection-access';
import { presentActivityMetricSelection } from './activity-metric-selection-presenter';
import {
  assertMetricSelectionReference,
  parseActivityMetricSetPointer,
} from './activity-metric-selection';
import { ActivityTemplateDefinitionV1Error } from './activity-template-definition-v1';
import {
  globalTemplateFamilyWhere,
  parseStoredTemplateVersion,
  presentTemplateVersionSummary,
} from './activity-template-version-presenter';
import { canonicalizeRegistrationFormDefinitionForB3 } from './registration-form-definition';

interface OptionsQuery {
  organizationId: string;
  page: number;
  pageSize: number;
}
const CANDIDATE_LIMIT = 1000;
const OPTIONS_ORDER = [{ createdAt: 'desc' }, { id: 'desc' }] as const;
const SET_ITEMS = {
  items: { include: { metricDefinition: true }, orderBy: { sortOrder: 'asc' }, take: 101 },
} satisfies Prisma.ActivityMetricSetVersionInclude;

function assertCandidateLimit(rows: readonly unknown[]) {
  if (rows.length > CANDIDATE_LIMIT)
    throw new BizException(BizCode.ACTIVITY_OPTIONS_CANDIDATE_LIMIT_EXCEEDED);
}
function pageOf<T>(items: T[], query: OptionsQuery) {
  const skip = (query.page - 1) * query.pageSize;
  return {
    items: items.slice(skip, skip + query.pageSize),
    total: items.length,
    page: query.page,
    pageSize: query.pageSize,
  };
}
function unavailableDefinition(error: unknown) {
  return (
    error instanceof TypeError ||
    error instanceof ActivityTemplateDefinitionV1Error ||
    (error instanceof BizException && error.biz === BizCode.BAD_REQUEST)
  );
}

@Injectable()
export class ActivityMetricSelectionQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ActivityMetricSelectionAccess,
  ) {}

  metricSetOptions(query: OptionsQuery, user: CurrentUserPayload) {
    return this.prisma.$transaction(
      async (tx) => {
        await this.access.authorizeOptions(tx, user, query.organizationId);
        // Probe the limit before fetching potentially large definition closures. Never truncate.
        const candidates = await tx.activityMetricSetVersion.findMany({
          where: { statusCode: 'active', schemaVersion: 1 },
          select: { id: true },
          orderBy: [...OPTIONS_ORDER],
          take: CANDIDATE_LIMIT + 1,
        });
        assertCandidateLimit(candidates);
        if (candidates.length === 0) return pageOf([], query);
        const rows = await tx.activityMetricSetVersion.findMany({
          where: { id: { in: candidates.map((row) => row.id) } },
          include: SET_ITEMS,
          orderBy: [...OPTIONS_ORDER],
          take: CANDIDATE_LIMIT,
        });
        const items = rows.flatMap((row) => {
          try {
            const pointer = parseActivityMetricSetPointer({
              id: row.id,
              code: row.code,
              version: row.version,
              schemaVersion: row.schemaVersion,
              definitionHash: row.definitionHash,
            });
            assertMetricSelectionReference(
              { metricRequirementCode: 'required', metricSetPointer: pointer },
              row,
            );
            return [{ ...pointer, name: row.name }];
          } catch (error) {
            if (unavailableDefinition(error)) return [];
            throw error;
          }
        });
        return pageOf(items, query);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  templateVersionOptions(query: OptionsQuery, user: CurrentUserPayload) {
    return this.prisma.$transaction(
      async (tx) => {
        await this.access.authorizeOptions(tx, user, query.organizationId);
        const candidates = await tx.activityTemplate.findMany({
          where: {
            statusCode: 'active',
            schemaVersion: { in: [1, 2, 3] },
            family: globalTemplateFamilyWhere(),
          },
          select: { id: true },
          orderBy: [...OPTIONS_ORDER],
          take: CANDIDATE_LIMIT + 1,
        });
        assertCandidateLimit(candidates);
        if (candidates.length === 0) return pageOf([], query);
        const rows = await tx.activityTemplate.findMany({
          where: { id: { in: candidates.map((row) => row.id) } },
          include: { family: true },
          orderBy: [...OPTIONS_ORDER],
          take: CANDIDATE_LIMIT,
        });
        const parsed = rows.flatMap((row) => {
          try {
            // Effective dates are ordered metadata, not a current-clock availability gate.
            if (
              !row.effectiveFrom ||
              !Number.isFinite(row.effectiveFrom.getTime()) ||
              (row.effectiveTo !== null &&
                (!Number.isFinite(row.effectiveTo.getTime()) ||
                  row.effectiveTo <= row.effectiveFrom))
            )
              throw new TypeError('invalid template effective window');
            const definition = parseStoredTemplateVersion(row);
            if ('registrationForm' in definition && definition.registrationForm)
              canonicalizeRegistrationFormDefinitionForB3(definition.registrationForm);
            const selection = 'metricSelection' in definition ? definition.metricSelection : null;
            return [{ summary: presentTemplateVersionSummary(row), selection }];
          } catch (error) {
            if (unavailableDefinition(error)) return [];
            throw error;
          }
        });
        const setIds = [
          ...new Set(
            parsed.flatMap(({ selection }) =>
              selection?.metricRequirementCode === 'required'
                ? [selection.metricSetPointer.id]
                : [],
            ),
          ),
        ];
        // At most one pointer per template; one bounded query, no per-template database loop.
        const sets = setIds.length
          ? await tx.activityMetricSetVersion.findMany({
              where: { id: { in: setIds } },
              include: SET_ITEMS,
              take: CANDIDATE_LIMIT,
            })
          : [];
        const byId = new Map(sets.map((set) => [set.id, set]));
        const items = parsed.flatMap(({ summary, selection }) => {
          try {
            if (selection)
              assertMetricSelectionReference(
                selection,
                selection.metricSetPointer
                  ? (byId.get(selection.metricSetPointer.id) ?? null)
                  : null,
              );
            return [summary];
          } catch (error) {
            if (unavailableDefinition(error)) return [];
            throw error;
          }
        });
        return pageOf(items, query);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  get(activityId: string, user: CurrentUserPayload, surface: MetricSelectionSurface) {
    return this.prisma.$transaction(async (tx) => {
      const actor = await this.access.current(tx, user, surface);
      const row = await this.access.readable(tx, actor, surface, activityId);
      const set = row.selectedMetricSetVersionId
        ? await tx.activityMetricSetVersion.findFirst({
            where: { id: row.selectedMetricSetVersionId },
            include: {
              items: {
                include: { metricDefinition: true },
                orderBy: { sortOrder: 'asc' },
                take: 101,
              },
            },
          })
        : null;
      try {
        return presentActivityMetricSelection(row, set);
      } catch (error) {
        if (error instanceof TypeError)
          throw new BizException(BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE);
        throw error;
      }
    });
  }
}
