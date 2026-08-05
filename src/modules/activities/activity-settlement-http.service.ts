import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuthzService } from '../authz/authz.service';
import { RbacService } from '../permissions/rbac.service';
import { ActivityClosureService } from './activity-closure.service';
import { SettlementDraftDispatchService } from './settlement-draft-dispatch.service';
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
  submit: 'activity.settlement-submit.record',
  firstReview: 'activity.settlement-first-review.record',
  finalReview: 'activity.settlement-final-review.record',
  close: 'activity.settlement-close.record',
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
