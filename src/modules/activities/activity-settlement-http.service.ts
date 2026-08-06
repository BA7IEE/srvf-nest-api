import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuthzService } from '../authz/authz.service';
import { RbacService } from '../permissions/rbac.service';
import { ActivityClosureService } from './activity-closure.service';
import { SettlementDraftDispatchService } from './settlement-draft-dispatch.service';
import {
  SettlementDraftService,
  type SettlementDraftItemUpdateInput,
  type SettlementDraftItemUpdateResult,
} from './settlement-draft.service';
import type { SettlementReviewExpectation } from './settlement-review-comparison';
import type { SettlementReviewStage } from './settlement-review-separation';
import {
  SettlementReviewService,
  type SettlementReviewActionCode,
} from './settlement-review.service';
import { SettlementSubmitService } from './settlement-submit.service';
import { canonicalize } from './settlement-content-hash';

// 第 2 批第 ⑧b 刀唯一的 HTTP 接线层：Controller 只做 JWT / DTO / audit meta，本 service
// 统一做端点 action 码的 Authz 判定和 canonical requestHash，再调用已交付的服务链。
//
// ⚠️ 本刀**没有**入口层 ActionConstraint。ACTION_CONSTRAINTS 是 authz 红区内的硬编码 Map，
// 已按维护者决策移到第 ⑩ 刀；当前防线只有这里的端点 RBAC + 第四刀 service 的锁后人员隔离。
export const ACTIVITY_SETTLEMENT_ACTION = {
  generate: 'activity.settlement-generate.record',
  updateDraft: 'activity.settlement-update-draft.record',
  submit: 'activity.settlement-submit.record',
  firstReview: 'activity.settlement-first-review.record',
  finalReview: 'activity.settlement-final-review.record',
  close: 'activity.settlement-close.record',
  // ⑨b 审核/账本读面复用既有考勤读码；不新开权限码，也不把 read 偷挂到写码上。
  attendanceRead: 'attendance.read.sheet',
} as const;

export interface SettlementHttpSubmitCommand {
  operationKey: string;
  expectedDraftVersion: number;
  evidenceSealId: string;
  confirmation: boolean;
}

export interface SettlementHttpCloseCommand {
  operationKey: string;
  expectedSettlementVersionId: string;
  expectedPostingBatchId: string;
}

export interface SettlementHttpReviewCommand {
  operationKey: string;
  expectation: SettlementReviewExpectation;
  note?: string;
}

export interface SettlementHttpGenerateResult {
  outcome: 'draft' | 'job';
  activityId: string;
  settlementRunId: string | null;
  settlementVersionId: string | null;
  settlementVersion: number | null;
  personCount: number | null;
  sessionParticipationCount: number | null;
  jobId: string | null;
  statusCode: string | null;
  total: number | null;
  replayed: boolean;
}

export interface SettlementHttpSubmitResult {
  activityId: string;
  settlementRunId: string;
  settlementVersionId: string;
  settlementVersion: number;
  priorVersionId: string | null;
  draftVersionId: string | null;
  evidenceSealId: string;
  evidenceRevision: number;
  populationRevision: number;
  workflowRevision: number;
  sealRevision: number;
  personCount: number;
  sessionParticipationCount: number;
  serviceSegmentCount: number;
  resultRowCount: number;
  contentHash: string;
  replayed: boolean;
}

export interface SettlementHttpCloseGap {
  gapCode: string;
  bizCode: number;
  message: string;
  count: number;
}

export interface SettlementHttpCloseCheck {
  gapCode: string;
  bizCode: number;
  passed: boolean;
  count: number;
}

export interface SettlementHttpCloseResult {
  outcome: 'closed' | 'blocked';
  activityId: string;
  settlementRunId: string | null;
  closureRevisionId: string | null;
  revision: number | null;
  settlementVersionId: string | null;
  postingBatchId: string | null;
  closedAt: Date | null;
  archiveWaitingUntil: Date | null;
  checks: SettlementHttpCloseCheck[];
  gaps: SettlementHttpCloseGap[];
  replayed: boolean | null;
}

export interface SettlementHttpItemsQuery {
  page: number;
  pageSize: number;
  session?: string;
  result?: string;
  q?: string;
}

export interface SettlementHttpGap {
  gapCode: string;
  count: number;
}

export interface SettlementHttpVersionPointer {
  id: string;
  version: number;
  statusCode: string;
  evidenceSealId: string;
  submittedAt: Date | null;
}

export interface SettlementHttpWorkbenchResult {
  activityId: string;
  run: {
    id: string;
    statusCode: string;
    currentDraftVersion: number | null;
    currentSubmittedVersion: number | null;
    currentPostedVersion: number | null;
    currentClosureRevision: number | null;
  } | null;
  seal: {
    id: string;
    sealRevision: number;
    statusCode: string;
    evidenceRevision: number;
    populationRevision: number;
    workflowRevision: number;
    manualReviewPendingCount: number;
  } | null;
  draft: SettlementHttpVersionPointer | null;
  submitted: SettlementHttpVersionPointer | null;
  posted: SettlementHttpVersionPointer | null;
  closure: {
    id: string;
    revision: number;
    statusCode: string;
    settlementVersionId: string;
    postingBatchId: string;
    closedAt: Date;
  } | null;
  gaps: SettlementHttpGap[];
}

export interface SettlementHttpItem {
  identityId: string;
  decisionCode: 'pending' | 'determined';
  session: { id: string; code: string; name: string };
  member: { id: string; memberNo: string; displayName: string };
  resultCode: string | null;
  recognizedServiceHours: number | null;
  recognizedContributionPoints: number | null;
  calculatedServiceHours: number | null;
  calculatedContributionPoints: number | null;
  adjustmentReason: string | null;
  lateFlag: boolean | null;
  earlyLeaveFlag: boolean | null;
}

export interface SettlementHttpItemsResult {
  items: SettlementHttpItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SettlementHttpVersionDetailResult {
  version: SettlementHttpVersionPointer & {
    contentHash: string;
    evidenceRevision: number;
    populationRevision: number;
    workflowRevision: number;
    personCount: number;
    sessionParticipationCount: number;
    serviceSegmentCount: number;
    priorVersionId: string | null;
    returnFromStage: string | null;
    returnReason: string | null;
  };
  diff: {
    priorVersionId: string | null;
    addedItemCount: number;
    removedItemCount: number;
    changedItemCount: number;
  };
  sealRevisions: Array<{
    id: string;
    sealRevision: number;
    statusCode: string;
    evidenceRevision: number;
    populationRevision: number;
    workflowRevision: number;
    manualReviewPendingCount: number;
    sealedAt: Date;
  }>;
}

export interface SettlementHttpReviewDetailResult extends SettlementHttpVersionDetailResult {
  gaps: SettlementHttpGap[];
}

export interface SettlementHttpReviewListItem {
  settlementVersionId: string;
  activityId: string;
  activityTitle: string;
  version: number;
  statusCode: string;
  submittedAt: Date | null;
  postingBatchStatusCode: string | null;
}

export interface SettlementHttpPostingBatchResult {
  id: string;
  settlementVersionId: string;
  statusCode: string;
  preparedCount: number;
  totalCount: number;
  failureCount: number;
  effective: boolean;
  effectiveLabel: string;
  preparedAt: Date | null;
  committedAt: Date | null;
}

type SettlementVersionForDiff = {
  participationIdentityId: string;
  resultCode: string;
  lateFlag: boolean;
  earlyLeaveFlag: boolean;
  exceptionFlagsJson: Prisma.JsonValue | null;
  recognizedServiceHours: Prisma.Decimal;
  recognizedContributionPoints: Prisma.Decimal;
  calculatedServiceHours: Prisma.Decimal;
  calculatedContributionPoints: Prisma.Decimal;
  adjustmentReason: string | null;
};

function hasNonEmptyBlockers(exceptionFlagsJson: Prisma.JsonValue | null): boolean {
  if (exceptionFlagsJson === null || Array.isArray(exceptionFlagsJson)) return false;
  if (typeof exceptionFlagsJson !== 'object') return false;
  const blockers = exceptionFlagsJson.blockers;
  return Array.isArray(blockers) && blockers.length > 0;
}

/**
 * HTTP body 的键序不是业务语义；同一个 operationKey 的重试必须得到同一 requestHash。
 * 本批所有输入仅含 string / integer / boolean / null / object，正好落在既有
 * `canonicalize` 的受限值域内。数组若未来进入此处，仍按数组顺序保留其业务语义。
 */
export function buildActivitySettlementRequestHash(
  action: string,
  payload: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(canonicalize({ action, ...payload }), 'utf8')
    .digest('hex');
}

@Injectable()
export class ActivitySettlementHttpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly rbac: RbacService,
    private readonly drafts: SettlementDraftDispatchService,
    private readonly draftItems: SettlementDraftService,
    private readonly submitter: SettlementSubmitService,
    private readonly reviews: SettlementReviewService,
    private readonly closure: ActivityClosureService,
  ) {}

  async generate(
    activityId: string,
    operationKey: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<SettlementHttpGenerateResult> {
    await this.assertCanActivity(currentUser, ACTIVITY_SETTLEMENT_ACTION.generate, activityId);
    const result = await this.drafts.generate(
      {
        activityId,
        operationKey,
        requestHash: this.requestHash('settlement-generate', { activityId, operationKey }),
      },
      currentUser,
      auditMeta,
    );
    if (result.outcome === 'job') {
      return {
        outcome: 'job',
        activityId,
        settlementRunId: null,
        settlementVersionId: null,
        settlementVersion: null,
        personCount: null,
        sessionParticipationCount: null,
        jobId: result.jobId,
        statusCode: result.statusCode,
        total: result.total,
        replayed: result.replayed,
      };
    }
    const draft = await this.prisma.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: result.settlementVersionId },
      select: { version: true },
    });
    return {
      outcome: 'draft',
      activityId,
      settlementRunId: result.settlementRunId,
      settlementVersionId: result.settlementVersionId,
      settlementVersion: draft.version,
      personCount: result.personCount,
      sessionParticipationCount: result.sessionParticipationCount,
      jobId: null,
      statusCode: null,
      total: null,
      replayed: result.replayed,
    };
  }

  async workbench(
    activityId: string,
    currentUser: CurrentUserPayload,
  ): Promise<SettlementHttpWorkbenchResult> {
    // 读面沿 generate 的既有责任人可见范围：owner 与 attendance collaborator 都能看
    // 工作台；单独的 update-draft 码只守 PATCH，不把读面意外缩成新权限的副作用。
    await this.assertCanActivity(currentUser, ACTIVITY_SETTLEMENT_ACTION.generate, activityId);
    const activity = await this.prisma.activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: {
        workflowRevision: true,
        evidenceState: { select: { evidenceRevision: true, populationRevision: true } },
        settlementRun: {
          select: {
            id: true,
            statusCode: true,
            currentDraftVersion: true,
            currentSubmittedVersion: true,
            currentPostedVersion: true,
            currentClosureRevision: true,
          },
        },
      },
    });
    if (activity === null) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);

    const [seal, closure] = await Promise.all([
      this.prisma.evidenceSeal.findFirst({
        where: { activityId, statusCode: 'active' },
        orderBy: { sealRevision: 'desc' },
        select: {
          id: true,
          sealRevision: true,
          statusCode: true,
          evidenceRevision: true,
          populationRevision: true,
          workflowRevision: true,
          manualReviewPendingCount: true,
        },
      }),
      this.prisma.activitySettlementClosureRevision.findFirst({
        where: { activityId, statusCode: 'active' },
        orderBy: { revision: 'desc' },
        select: {
          id: true,
          revision: true,
          statusCode: true,
          settlementVersionId: true,
          postingBatchId: true,
          closedAt: true,
        },
      }),
    ]);
    const versions =
      activity.settlementRun === null
        ? []
        : await this.prisma.attendanceSettlementVersion.findMany({
            where: { settlementRunId: activity.settlementRun.id },
            select: {
              id: true,
              version: true,
              statusCode: true,
              evidenceSealId: true,
              evidenceRevision: true,
              populationRevision: true,
              workflowRevision: true,
              submittedAt: true,
            },
          });
    const versionAt = (version: number | null | undefined) =>
      version === null || version === undefined
        ? null
        : (versions.find((item) => item.version === version) ?? null);
    const draft = versionAt(activity.settlementRun?.currentDraftVersion);
    const submitted = versionAt(activity.settlementRun?.currentSubmittedVersion);
    const posted = versionAt(activity.settlementRun?.currentPostedVersion);
    const gaps: SettlementHttpGap[] = [];

    if (activity.settlementRun === null) {
      gaps.push({ gapCode: 'settlement_run_missing', count: 1 });
    }
    if (seal === null) {
      gaps.push({ gapCode: 'evidence_seal_missing', count: 1 });
    } else if (seal.manualReviewPendingCount > 0) {
      gaps.push({ gapCode: 'manual_review_pending', count: seal.manualReviewPendingCount });
    }
    if (draft === null) {
      gaps.push({ gapCode: 'draft_missing', count: 1 });
    } else {
      const liveEvidenceRevision = activity.evidenceState?.evidenceRevision ?? 0;
      const livePopulationRevision = activity.evidenceState?.populationRevision ?? 0;
      if (
        seal !== null &&
        (draft.evidenceSealId !== seal.id ||
          draft.evidenceRevision !== seal.evidenceRevision ||
          draft.populationRevision !== seal.populationRevision ||
          draft.workflowRevision !== seal.workflowRevision ||
          seal.evidenceRevision !== liveEvidenceRevision ||
          seal.populationRevision !== livePopulationRevision ||
          seal.workflowRevision !== activity.workflowRevision)
      ) {
        gaps.push({ gapCode: 'draft_version_stale', count: 1 });
      }
      const [pendingResultCount, openSegmentCount, resultRows] = await Promise.all([
        this.prisma.activityParticipationIdentity.count({
          where: {
            activityId,
            populationIncluded: true,
            settlementResultRevisions: { none: { settlementVersionId: draft.id } },
          },
        }),
        this.prisma.participantServiceSegmentRevision.count({
          where: {
            identity: { activityId, populationIncluded: true },
            statusCode: { not: 'superseded' },
            checkOutAt: null,
          },
        }),
        this.prisma.participantSettlementResultRevision.findMany({
          where: { settlementVersionId: draft.id },
          select: { exceptionFlagsJson: true },
        }),
      ]);
      if (pendingResultCount > 0) {
        gaps.push({ gapCode: 'pending_result', count: pendingResultCount });
      }
      if (openSegmentCount > 0) {
        gaps.push({ gapCode: 'open_segment', count: openSegmentCount });
      }
      const missingRuleCount = resultRows.filter((row) =>
        hasNonEmptyBlockers(row.exceptionFlagsJson),
      ).length;
      if (missingRuleCount > 0) {
        gaps.push({ gapCode: 'missing_contribution_rule', count: missingRuleCount });
      }
    }

    return {
      activityId,
      run: activity.settlementRun,
      seal,
      draft: draft === null ? null : this.toVersionPointer(draft),
      submitted: submitted === null ? null : this.toVersionPointer(submitted),
      posted: posted === null ? null : this.toVersionPointer(posted),
      closure,
      gaps,
    };
  }

  async items(
    activityId: string,
    query: SettlementHttpItemsQuery,
    currentUser: CurrentUserPayload,
  ): Promise<SettlementHttpItemsResult> {
    await this.assertCanActivity(currentUser, ACTIVITY_SETTLEMENT_ACTION.generate, activityId);
    const activity = await this.prisma.activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: { settlementRun: { select: { id: true, currentDraftVersion: true } } },
    });
    if (activity === null) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    const run = activity.settlementRun;
    if (run === null || run.currentDraftVersion === null) {
      return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
    }
    const draft = await this.prisma.attendanceSettlementVersion.findFirst({
      where: { settlementRunId: run.id, version: run.currentDraftVersion, statusCode: 'draft' },
      select: { id: true },
    });
    if (draft === null) {
      return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
    }

    const where: Prisma.ActivityParticipationIdentityWhereInput = {
      activityId,
      populationIncluded: true,
    };
    if (query.session !== undefined) where.sessionId = query.session;
    if (query.result !== undefined) {
      where.settlementResultRevisions = {
        some: { settlementVersionId: draft.id, resultCode: query.result },
      };
    }
    if (query.q !== undefined && query.q.length > 0) {
      where.member = {
        OR: [
          { memberNo: { contains: query.q, mode: 'insensitive' } },
          { displayName: { contains: query.q, mode: 'insensitive' } },
        ],
      };
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.activityParticipationIdentity.findMany({
        where,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy: [
          { session: { sortOrder: 'asc' } },
          { member: { memberNo: 'asc' } },
          { id: 'asc' },
        ],
        select: {
          id: true,
          session: { select: { id: true, code: true, name: true } },
          member: { select: { id: true, memberNo: true, displayName: true } },
          settlementResultRevisions: {
            where: { settlementVersionId: draft.id },
            select: {
              resultCode: true,
              recognizedServiceHours: true,
              recognizedContributionPoints: true,
              calculatedServiceHours: true,
              calculatedContributionPoints: true,
              adjustmentReason: true,
              lateFlag: true,
              earlyLeaveFlag: true,
            },
          },
        },
      }),
      this.prisma.activityParticipationIdentity.count({ where }),
    ]);

    return {
      items: rows.map((row) => {
        const result = row.settlementResultRevisions[0] ?? null;
        return {
          identityId: row.id,
          decisionCode: result === null ? 'pending' : 'determined',
          session: row.session,
          member: row.member,
          resultCode: result?.resultCode ?? null,
          recognizedServiceHours: result?.recognizedServiceHours.toNumber() ?? null,
          recognizedContributionPoints: result?.recognizedContributionPoints.toNumber() ?? null,
          calculatedServiceHours: result?.calculatedServiceHours.toNumber() ?? null,
          calculatedContributionPoints: result?.calculatedContributionPoints.toNumber() ?? null,
          adjustmentReason: result?.adjustmentReason ?? null,
          lateFlag: result?.lateFlag ?? null,
          earlyLeaveFlag: result?.earlyLeaveFlag ?? null,
        };
      }),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async updateDraftItem(
    input: SettlementDraftItemUpdateInput,
    currentUser: CurrentUserPayload,
  ): Promise<SettlementDraftItemUpdateResult & { identityId: string }> {
    await this.assertCanActivity(
      currentUser,
      ACTIVITY_SETTLEMENT_ACTION.updateDraft,
      input.activityId,
    );
    const result = await this.draftItems.updateItem(input);
    return { ...result, identityId: result.participationIdentityId };
  }

  async versionDetail(
    activityId: string,
    versionId: string,
    currentUser: CurrentUserPayload,
  ): Promise<SettlementHttpVersionDetailResult> {
    await this.assertCanActivity(currentUser, ACTIVITY_SETTLEMENT_ACTION.generate, activityId);
    return await this.loadVersionDetail(activityId, versionId);
  }

  /** 不带鉴权的 immutable projection；所有公开调用者必须先完成自己的 resource 判权。 */
  private async loadVersionDetail(
    activityId: string,
    versionId: string,
  ): Promise<SettlementHttpVersionDetailResult> {
    const version = await this.prisma.attendanceSettlementVersion.findFirst({
      where: {
        id: versionId,
        settlementRun: { activityId, activity: { deletedAt: null } },
      },
      select: {
        id: true,
        version: true,
        statusCode: true,
        evidenceSealId: true,
        evidenceRevision: true,
        populationRevision: true,
        workflowRevision: true,
        contentHash: true,
        personCount: true,
        sessionParticipationCount: true,
        serviceSegmentCount: true,
        submittedAt: true,
        priorVersionId: true,
        returnFromStage: true,
        returnReason: true,
        resultRevisions: {
          select: {
            participationIdentityId: true,
            resultCode: true,
            lateFlag: true,
            earlyLeaveFlag: true,
            exceptionFlagsJson: true,
            recognizedServiceHours: true,
            recognizedContributionPoints: true,
            calculatedServiceHours: true,
            calculatedContributionPoints: true,
            adjustmentReason: true,
          },
        },
      },
    });
    if (version === null) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    const [priorRows, sealRevisions] = await Promise.all([
      version.priorVersionId === null
        ? Promise.resolve([] as SettlementVersionForDiff[])
        : this.prisma.participantSettlementResultRevision.findMany({
            where: { settlementVersionId: version.priorVersionId },
            select: {
              participationIdentityId: true,
              resultCode: true,
              lateFlag: true,
              earlyLeaveFlag: true,
              exceptionFlagsJson: true,
              recognizedServiceHours: true,
              recognizedContributionPoints: true,
              calculatedServiceHours: true,
              calculatedContributionPoints: true,
              adjustmentReason: true,
            },
          }),
      this.prisma.evidenceSeal.findMany({
        where: { activityId },
        orderBy: { sealRevision: 'asc' },
        select: {
          id: true,
          sealRevision: true,
          statusCode: true,
          evidenceRevision: true,
          populationRevision: true,
          workflowRevision: true,
          manualReviewPendingCount: true,
          sealedAt: true,
        },
      }),
    ]);

    return {
      version: {
        ...this.toVersionPointer(version),
        contentHash: version.contentHash,
        evidenceRevision: version.evidenceRevision,
        populationRevision: version.populationRevision,
        workflowRevision: version.workflowRevision,
        personCount: version.personCount,
        sessionParticipationCount: version.sessionParticipationCount,
        serviceSegmentCount: version.serviceSegmentCount,
        priorVersionId: version.priorVersionId,
        returnFromStage: version.returnFromStage,
        returnReason: version.returnReason,
      },
      diff: this.diffVersionResults(version.priorVersionId, priorRows, version.resultRevisions),
      sealRevisions,
    };
  }

  /** 跨活动审核工作台：授权范围沿既有 attendance.read.sheet 的组织 scope 下推。 */
  async reviewWorkbench(
    query: { page: number; pageSize: number },
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<SettlementHttpReviewListItem>> {
    const scope = await this.authz.getVisibleOrganizationScope(
      currentUser,
      ACTIVITY_SETTLEMENT_ACTION.attendanceRead,
    );
    if (!scope.hasPermission) throw new BizException(BizCode.RBAC_FORBIDDEN);

    const visibleOrganizationIds = scope.global ? undefined : scope.organizationIds;
    const where: Prisma.AttendanceSettlementVersionWhereInput = {
      // draft 是负责人可变工作区，审核根只列 immutable submit/review/posting 历史。
      statusCode: { not: 'draft' },
      settlementRun: {
        activity: {
          deletedAt: null,
          ...(visibleOrganizationIds === undefined
            ? {}
            : { organizationId: { in: visibleOrganizationIds } }),
        },
      },
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.attendanceSettlementVersion.findMany({
        where,
        select: {
          id: true,
          version: true,
          statusCode: true,
          submittedAt: true,
          settlementRun: { select: { activity: { select: { id: true, title: true } } } },
          postingBatches: {
            select: { statusCode: true },
            orderBy: { batchRevision: 'desc' },
            take: 1,
          },
        },
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.attendanceSettlementVersion.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({
        settlementVersionId: row.id,
        activityId: row.settlementRun.activity.id,
        activityTitle: row.settlementRun.activity.title,
        version: row.version,
        statusCode: row.statusCode,
        submittedAt: row.submittedAt,
        postingBatchStatusCode: row.postingBatches[0]?.statusCode ?? null,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** 审核详情使用考勤读码，不复用负责人工作台的 generate 写码。 */
  async reviewDetail(
    settlementVersionId: string,
    currentUser: CurrentUserPayload,
  ): Promise<SettlementHttpReviewDetailResult> {
    const activityId = await this.resolveReviewActivityId(settlementVersionId);
    await this.assertCanActivity(
      currentUser,
      ACTIVITY_SETTLEMENT_ACTION.attendanceRead,
      activityId,
    );
    const [detail, gaps] = await Promise.all([
      this.loadVersionDetail(activityId, settlementVersionId),
      this.readReviewGaps(activityId),
    ]);
    return { ...detail, gaps };
  }

  /** 批次进度是事实投影；只有 committed 才能标为已正式生效。 */
  async postingBatch(
    settlementVersionId: string,
    currentUser: CurrentUserPayload,
  ): Promise<SettlementHttpPostingBatchResult> {
    const activityId = await this.resolveReviewActivityId(settlementVersionId);
    await this.assertCanActivity(
      currentUser,
      ACTIVITY_SETTLEMENT_ACTION.attendanceRead,
      activityId,
    );
    const batch = await this.prisma.ledgerPostingBatch.findFirst({
      where: { settlementVersionId },
      orderBy: { batchRevision: 'desc' },
      select: {
        id: true,
        settlementVersionId: true,
        statusCode: true,
        preparedCount: true,
        totalCount: true,
        failureCount: true,
        preparedAt: true,
        committedAt: true,
      },
    });
    if (batch === null) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    const effective = batch.statusCode === 'committed';
    return {
      ...batch,
      effective,
      effectiveLabel: effective ? '已正式生效' : '尚未正式生效',
    };
  }

  async resubmit(
    activityId: string,
    returnedVersionId: string,
    command: SettlementHttpSubmitCommand,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<SettlementHttpSubmitResult> {
    await this.assertCanActivity(currentUser, ACTIVITY_SETTLEMENT_ACTION.submit, activityId);
    const returned = await this.prisma.attendanceSettlementVersion.findFirst({
      where: {
        id: returnedVersionId,
        settlementRun: { activityId, activity: { deletedAt: null } },
      },
      select: { statusCode: true },
    });
    if (returned === null) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    if (returned.statusCode !== 'returned') {
      throw new BizException(BizCode.SETTLEMENT_RESUBMIT_VERSION_NOT_RETURNED);
    }
    return await this.submit(activityId, command, currentUser, auditMeta);
  }

  async submit(
    activityId: string,
    command: SettlementHttpSubmitCommand,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<SettlementHttpSubmitResult> {
    await this.assertCanActivity(currentUser, ACTIVITY_SETTLEMENT_ACTION.submit, activityId);
    const result = await this.submitter.submit(
      {
        activityId,
        operationKey: command.operationKey,
        requestHash: this.requestHash('settlement-submit', { activityId, ...command }),
        expectedDraftVersion: command.expectedDraftVersion,
        expectedEvidenceSealId: command.evidenceSealId,
      },
      currentUser,
      auditMeta,
    );
    const version = await this.prisma.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: result.settlementVersionId },
      select: { evidenceRevision: true, populationRevision: true, workflowRevision: true },
    });
    return {
      ...result,
      evidenceRevision: version.evidenceRevision,
      populationRevision: version.populationRevision,
      workflowRevision: version.workflowRevision,
    };
  }

  async review(
    settlementVersionId: string,
    stageCode: SettlementReviewStage,
    actionCode: SettlementReviewActionCode,
    command: SettlementHttpReviewCommand,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    const activityId = await this.resolveReviewActivityId(settlementVersionId);
    await this.assertCanActivity(
      currentUser,
      stageCode === 'first'
        ? ACTIVITY_SETTLEMENT_ACTION.firstReview
        : ACTIVITY_SETTLEMENT_ACTION.finalReview,
      activityId,
    );
    const input = {
      activityId,
      actionCode,
      operationKey: command.operationKey,
      requestHash: this.requestHash(`settlement-${stageCode}-${actionCode}`, {
        activityId,
        settlementVersionId,
        operationKey: command.operationKey,
        expectation: command.expectation,
        note: command.note ?? null,
      }),
      note: command.note,
      ...(actionCode === 'return' ? { returnReason: command.note } : {}),
      expectation: command.expectation,
      expectedSettlementVersionId: settlementVersionId,
    };
    return stageCode === 'first'
      ? await this.reviews.firstReview(input, currentUser, auditMeta)
      : await this.reviews.finalReview(input, currentUser, auditMeta);
  }

  async close(
    activityId: string,
    command: SettlementHttpCloseCommand,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<SettlementHttpCloseResult> {
    await this.assertCanActivity(currentUser, ACTIVITY_SETTLEMENT_ACTION.close, activityId);
    const outcome = await this.closure.close(
      activityId,
      {
        operationKey: command.operationKey,
        requestHash: this.requestHash('settlement-close', { activityId, ...command }),
        expectedSettlementVersionId: command.expectedSettlementVersionId,
        expectedPostingBatchId: command.expectedPostingBatchId,
      },
      currentUser,
      auditMeta,
    );
    if (outcome.outcome === 'blocked') {
      return {
        outcome: 'blocked',
        activityId,
        settlementRunId: null,
        closureRevisionId: null,
        revision: null,
        settlementVersionId: null,
        postingBatchId: null,
        closedAt: null,
        archiveWaitingUntil: null,
        checks: outcome.checks.map((check) => ({
          gapCode: check.gapCode,
          bizCode: check.bizCode,
          passed: check.passed,
          count: check.count,
        })),
        gaps: outcome.gaps.map((gap) => ({
          gapCode: gap.gapCode,
          bizCode: gap.bizCode,
          message: gap.message,
          count: gap.count,
        })),
        replayed: null,
      };
    }
    const { closure } = outcome;
    return {
      outcome: 'closed',
      activityId,
      settlementRunId: closure.settlementRunId,
      closureRevisionId: closure.closureRevisionId,
      revision: closure.revision,
      settlementVersionId: closure.settlementVersionId,
      postingBatchId: closure.postingBatchId,
      closedAt: closure.closedAt,
      archiveWaitingUntil: closure.archiveWaitingUntil,
      checks: closure.checks.map((check) => ({
        gapCode: check.gapCode,
        bizCode: check.bizCode,
        passed: check.passed,
        count: check.count,
      })),
      gaps: [],
      replayed: closure.replayed,
    };
  }

  private toVersionPointer(version: {
    id: string;
    version: number;
    statusCode: string;
    evidenceSealId: string;
    submittedAt: Date | null;
  }): SettlementHttpVersionPointer {
    return {
      id: version.id,
      version: version.version,
      statusCode: version.statusCode,
      evidenceSealId: version.evidenceSealId,
      submittedAt: version.submittedAt,
    };
  }

  private diffVersionResults(
    priorVersionId: string | null,
    priorRows: SettlementVersionForDiff[],
    currentRows: SettlementVersionForDiff[],
  ): SettlementHttpVersionDetailResult['diff'] {
    const priorByIdentity = new Map(
      priorRows.map((row) => [row.participationIdentityId, this.resultSignature(row)]),
    );
    const currentByIdentity = new Map(
      currentRows.map((row) => [row.participationIdentityId, this.resultSignature(row)]),
    );
    let addedItemCount = 0;
    let changedItemCount = 0;
    for (const [identityId, signature] of currentByIdentity) {
      const prior = priorByIdentity.get(identityId);
      if (prior === undefined) {
        addedItemCount += 1;
      } else if (prior !== signature) {
        changedItemCount += 1;
      }
    }
    let removedItemCount = 0;
    for (const identityId of priorByIdentity.keys()) {
      if (!currentByIdentity.has(identityId)) removedItemCount += 1;
    }
    return { priorVersionId, addedItemCount, removedItemCount, changedItemCount };
  }

  private resultSignature(row: SettlementVersionForDiff): string {
    return JSON.stringify({
      resultCode: row.resultCode,
      lateFlag: row.lateFlag,
      earlyLeaveFlag: row.earlyLeaveFlag,
      exceptionFlagsJson: row.exceptionFlagsJson,
      recognizedServiceHours: row.recognizedServiceHours.toFixed(2),
      recognizedContributionPoints: row.recognizedContributionPoints.toFixed(2),
      calculatedServiceHours: row.calculatedServiceHours.toFixed(2),
      calculatedContributionPoints: row.calculatedContributionPoints.toFixed(2),
      adjustmentReason: row.adjustmentReason,
    });
  }

  /**
   * 审核详情里的缺口与负责人工作台同一套事实口径，但不复用 workbench()：后者的
   * generate 写码是负责人权限，审核读面必须只要求 attendance.read.sheet。
   */
  private async readReviewGaps(activityId: string): Promise<SettlementHttpGap[]> {
    const activity = await this.prisma.activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: {
        workflowRevision: true,
        evidenceState: { select: { evidenceRevision: true, populationRevision: true } },
        settlementRun: { select: { id: true, currentDraftVersion: true } },
      },
    });
    if (activity === null) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);

    const [seal, draft] = await Promise.all([
      this.prisma.evidenceSeal.findFirst({
        where: { activityId, statusCode: 'active' },
        orderBy: { sealRevision: 'desc' },
        select: {
          id: true,
          evidenceRevision: true,
          populationRevision: true,
          workflowRevision: true,
          manualReviewPendingCount: true,
        },
      }),
      activity.settlementRun?.currentDraftVersion === null ||
      activity.settlementRun?.currentDraftVersion === undefined
        ? Promise.resolve(null)
        : this.prisma.attendanceSettlementVersion.findFirst({
            where: {
              settlementRunId: activity.settlementRun.id,
              version: activity.settlementRun.currentDraftVersion,
            },
            select: {
              id: true,
              evidenceSealId: true,
              evidenceRevision: true,
              populationRevision: true,
              workflowRevision: true,
            },
          }),
    ]);
    const gaps: SettlementHttpGap[] = [];
    if (activity.settlementRun === null) gaps.push({ gapCode: 'settlement_run_missing', count: 1 });
    if (seal === null) {
      gaps.push({ gapCode: 'evidence_seal_missing', count: 1 });
    } else if (seal.manualReviewPendingCount > 0) {
      gaps.push({ gapCode: 'manual_review_pending', count: seal.manualReviewPendingCount });
    }
    if (draft === null) {
      gaps.push({ gapCode: 'draft_missing', count: 1 });
      return gaps;
    }

    const liveEvidenceRevision = activity.evidenceState?.evidenceRevision ?? 0;
    const livePopulationRevision = activity.evidenceState?.populationRevision ?? 0;
    if (
      seal !== null &&
      (draft.evidenceSealId !== seal.id ||
        draft.evidenceRevision !== seal.evidenceRevision ||
        draft.populationRevision !== seal.populationRevision ||
        draft.workflowRevision !== seal.workflowRevision ||
        seal.evidenceRevision !== liveEvidenceRevision ||
        seal.populationRevision !== livePopulationRevision ||
        seal.workflowRevision !== activity.workflowRevision)
    ) {
      gaps.push({ gapCode: 'draft_version_stale', count: 1 });
    }
    const [pendingResultCount, openSegmentCount, resultRows] = await Promise.all([
      this.prisma.activityParticipationIdentity.count({
        where: {
          activityId,
          populationIncluded: true,
          settlementResultRevisions: { none: { settlementVersionId: draft.id } },
        },
      }),
      this.prisma.participantServiceSegmentRevision.count({
        where: {
          identity: { activityId, populationIncluded: true },
          statusCode: { not: 'superseded' },
          checkOutAt: null,
        },
      }),
      this.prisma.participantSettlementResultRevision.findMany({
        where: { settlementVersionId: draft.id },
        select: { exceptionFlagsJson: true },
      }),
    ]);
    if (pendingResultCount > 0) gaps.push({ gapCode: 'pending_result', count: pendingResultCount });
    if (openSegmentCount > 0) gaps.push({ gapCode: 'open_segment', count: openSegmentCount });
    const missingRuleCount = resultRows.filter((row) =>
      hasNonEmptyBlockers(row.exceptionFlagsJson),
    ).length;
    if (missingRuleCount > 0) {
      gaps.push({ gapCode: 'missing_contribution_rule', count: missingRuleCount });
    }
    return gaps;
  }

  private async resolveReviewActivityId(settlementVersionId: string): Promise<string> {
    const version = await this.prisma.attendanceSettlementVersion.findFirst({
      where: {
        id: settlementVersionId,
        settlementRun: { activity: { deletedAt: null } },
      },
      select: { settlementRun: { select: { activityId: true } } },
    });
    // 先解析版本才能取得 Activity resource ref；不给未授权调用者暴露版本是否存在。
    if (version === null) throw new BizException(BizCode.RBAC_FORBIDDEN);
    return version.settlementRun.activityId;
  }

  private async assertCanActivity(
    currentUser: CurrentUserPayload,
    action: string,
    activityId: string,
  ): Promise<void> {
    const decision = await this.authz.explain(currentUser, action, {
      type: 'activity',
      id: activityId,
    });
    if (decision.allow) return;
    // 资源解析失败时，沿既有 activity 写面回退 GLOBAL rbac.can：持码者可继续由业务
    // service 给真实资源错误，无码者始终拿 30100，避免用端点枚举活动。
    if (decision.reason === 'resource_not_found' && (await this.rbac.can(currentUser, action))) {
      return;
    }
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  private requestHash(action: string, payload: Record<string, unknown>): string {
    return buildActivitySettlementRequestHash(action, payload);
  }
}
