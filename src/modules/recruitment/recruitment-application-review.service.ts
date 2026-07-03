import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import {
  APP_STATUS_PENDING_EVALUATION,
  APP_STATUS_PUBLICITY,
  APP_STATUS_REJECTED,
  APP_STATUS_VERIFIED,
  ELIM_STAGE_EVALUATION,
  ELIM_STAGE_THRESHOLD_TIMEOUT,
  type ThresholdCode,
  type ThresholdMarks,
  allThresholdsComplete,
} from './recruitment.constants';
import { resolveBatchMatches } from './recruitment-batch-matching';
import { toAdminApplicationDto } from './recruitment-applications.presenter';
import type {
  BatchMarkThresholdDto,
  BatchMarkThresholdResultDto,
  BatchMarkThresholdRowResultDto,
  EvaluateRecruitmentApplicationDto,
  MarkThresholdDto,
  RecruitmentApplicationAdminDto,
} from './recruitment.dto';

// 招新报名 admin 评审写动作 service(god-service 拆分 2026-06-28)。
// 从 RecruitmentApplicationsService 抽出**核验之后**的 admin 评审工作流:门槛标记 / 批量标门槛 / 综合评定淘汰。
// 仍为 application service(持有各自写事务,沿 architecture-boundary §4「事务归属不下放」);状态机判定 +
// audit 仍内联(规模未达 StateMachine/AuditRecorder 抽离触发线,本次纯搬家,不改判定语义/事件名/BizCode)。
// 注:发临时编号的两条路径(submit / resolveManual,含 FM-C 容量原子兜底)留 RecruitmentApplicationsService;
// 本 service 三动作均不发号(markThreshold→pending_evaluation/verified、evaluate→publicity/rejected)。

const AUDIT_RESOURCE_TYPE = 'recruitment_application'; // 与 RecruitmentApplicationsService 同一资源类型(审计行为锁)

@Injectable()
export class RecruitmentApplicationReviewService {
  private readonly logger = new Logger(RecruitmentApplicationReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  // ============ 招新二期:标/清门槛(M-3 / E-R2-2;幂等;末次完成自动推进 pending_evaluation)============
  async markThreshold(
    id: string,
    dto: MarkThresholdDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
    now: Date,
  ): Promise<RecruitmentApplicationAdminDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.mark.threshold');
    const canSensitive = await this.rbac.can(user, 'recruitment-application.read.sensitive');
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.recruitmentApplication.findFirst({ where: { id, deletedAt: null } });
      if (!row) {
        throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);
      }
      // 仅 verified / pending_evaluation 态可标(评定/公示/发号后门槛不可再动);他态 28041
      if (
        row.statusCode !== APP_STATUS_VERIFIED &&
        row.statusCode !== APP_STATUS_PENDING_EVALUATION
      ) {
        throw new BizException(BizCode.RECRUITMENT_APPLICATION_WRONG_STATE);
      }
      const marks: ThresholdMarks = { ...((row.thresholdMarks as ThresholdMarks | null) ?? {}) };
      const code = dto.thresholdCode as ThresholdCode; // DTO @IsIn 已校验 ∈ THRESHOLD_CODES
      if (dto.completed) {
        marks[code] = { at: now.toISOString(), by: user.id };
      } else {
        delete marks[code];
      }
      const allComplete = allThresholdsComplete(marks);
      // 单一真相源自动推进:全完成→pending_evaluation / 否→回退 verified(仅此二态切换)
      const nextStatus = allComplete ? APP_STATUS_PENDING_EVALUATION : APP_STATUS_VERIFIED;
      const updated = await tx.recruitmentApplication.update({
        where: { id },
        data: { thresholdMarks: marks as Prisma.InputJsonValue, statusCode: nextStatus },
      });
      await this.auditLogs.log({
        event: 'recruitment-application.mark-threshold',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: id,
        meta,
        before: { statusCode: row.statusCode },
        after: { statusCode: nextStatus },
        extra: { thresholdCode: code, completed: dto.completed, allComplete },
        tx,
      });
      return toAdminApplicationDto(updated, !canSensitive);
    });
  }

  // ============ 招新闭环优化 S6:批量标门槛(评审稿 §8.1;复用单行 markThreshold,零第二套)============
  // 入参 = 匹配键数组(临时编号 / 手机 / 姓名+手机;「签到记录导入」由前端解析为本数组)+ thresholdCode + completed。
  // **逐行复用单行 markThreshold**(各自独立事务 → 逐行幂等 + 逐行容错:某行匹配不上/状态非法不整批回滚;
  // per-row mark-threshold DB 审计 + 自动推进语义全由单行逻辑承载,本方法零重复)。批次汇总走 logger.log
  // (沿 promote 批量操作范式:per-row DB 审计 + 操作性汇总日志;不扩 locked AuditEvent union)。
  async batchMarkThreshold(
    dto: BatchMarkThresholdDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
    now: Date,
  ): Promise<BatchMarkThresholdResultDto> {
    // 入口快速失败(单行 markThreshold 内仍逐行复判,防御不破)。
    await this.assertCanOrThrow(user, 'recruitment-application.mark.threshold');

    // 候选集(限定 scope + 未软删;仅取匹配所需字段)。缺 cycleId 时跨全部未软删报名匹配
    // (手机/姓名多命中 → ambiguous 安全留人工,不误标)。
    const candidates = await this.prisma.recruitmentApplication.findMany({
      where: { deletedAt: null, ...(dto.cycleId ? { cycleId: dto.cycleId } : {}) },
      select: { id: true, tempNo: true, phone: true, realName: true },
    });
    const resolutions = resolveBatchMatches(dto.matches, candidates);

    const results: BatchMarkThresholdRowResultDto[] = [];
    let marked = 0;
    let unmatched = 0;
    let failed = 0;
    let autoAdvanced = 0;

    for (let i = 0; i < resolutions.length; i++) {
      const r = resolutions[i];
      if (r.status === 'unmatched') {
        unmatched += 1;
        results.push({
          index: i,
          status: 'unmatched',
          applicationId: null,
          matchedBy: null,
          unmatchedReason: r.reason,
          errorCode: null,
          statusCode: null,
          thresholdsComplete: null,
        });
        continue;
      }
      // 命中 → 复用单行 markThreshold(自有事务:逐行幂等 + 逐行容错 + 自动推进 + per-row 审计)。
      try {
        const updated = await this.markThreshold(
          r.applicationId,
          { thresholdCode: dto.thresholdCode, completed: dto.completed },
          user,
          meta,
          now,
        );
        marked += 1;
        const advanced = dto.completed && updated.statusCode === APP_STATUS_PENDING_EVALUATION;
        if (advanced) autoAdvanced += 1;
        results.push({
          index: i,
          status: 'marked',
          applicationId: r.applicationId,
          matchedBy: r.matchedBy,
          unmatchedReason: null,
          errorCode: null,
          statusCode: updated.statusCode,
          thresholdsComplete: updated.thresholdsComplete,
        });
      } catch (err) {
        // 逐行容错:单行业务失败(如 28041 状态非法)记 failed,批次继续(不整批回滚)。
        failed += 1;
        results.push({
          index: i,
          status: 'failed',
          applicationId: r.applicationId,
          matchedBy: r.matchedBy,
          unmatchedReason: null,
          errorCode: err instanceof BizException ? err.biz.code : null,
          statusCode: null,
          thresholdsComplete: null,
        });
      }
    }

    // 批次汇总(操作性日志;per-row 审计已由单行 markThreshold 落库)。
    this.logger.log(
      `recruitment batch-mark-threshold code=${dto.thresholdCode} completed=${dto.completed} ` +
        `total=${dto.matches.length} marked=${marked} unmatched=${unmatched} failed=${failed} ` +
        `autoAdvanced=${autoAdvanced} by=${user.id}`,
    );

    return { results, total: dto.matches.length, marked, unmatched, failed, autoAdvanced };
  }

  // ============ 招新二期:综合评定 / 淘汰(单一人工闸;D-R2-3 / 流程冻结 §4)============
  // pending_evaluation:通过→公示 / 不通过→未通过(evaluation);
  // verified:仅 approved=false 淘汰(门槛超期/退出,threshold-timeout);approved=true→28041(门槛未齐);
  // 其余态→28041。
  async evaluate(
    id: string,
    dto: EvaluateRecruitmentApplicationDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
    now: Date,
  ): Promise<RecruitmentApplicationAdminDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.evaluate.assessment');
    const canSensitive = await this.rbac.can(user, 'recruitment-application.read.sensitive');
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.recruitmentApplication.findFirst({ where: { id, deletedAt: null } });
      if (!row) {
        throw new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);
      }
      let nextStatus: string;
      let eliminationStage: string | null = null;
      if (row.statusCode === APP_STATUS_PENDING_EVALUATION) {
        if (dto.approved) {
          nextStatus = APP_STATUS_PUBLICITY;
        } else {
          nextStatus = APP_STATUS_REJECTED;
          eliminationStage = ELIM_STAGE_EVALUATION;
        }
      } else if (row.statusCode === APP_STATUS_VERIFIED) {
        if (dto.approved) {
          // 门槛未齐不可直接过评定(必须先全完成自动到 pending_evaluation)
          throw new BizException(BizCode.RECRUITMENT_APPLICATION_WRONG_STATE);
        }
        nextStatus = APP_STATUS_REJECTED;
        eliminationStage = ELIM_STAGE_THRESHOLD_TIMEOUT;
      } else {
        throw new BizException(BizCode.RECRUITMENT_APPLICATION_WRONG_STATE);
      }
      const updated = await tx.recruitmentApplication.update({
        where: { id },
        data: {
          statusCode: nextStatus,
          evaluatedByUserId: user.id,
          evaluatedAt: now,
          ...(dto.note !== undefined ? { evaluationNote: dto.note } : {}),
          ...(eliminationStage ? { eliminationStage } : {}),
        },
      });
      await this.auditLogs.log({
        event: 'recruitment-application.evaluate',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: id,
        meta,
        before: { statusCode: row.statusCode },
        after: { statusCode: nextStatus },
        extra: { approved: dto.approved, eliminationStage },
        tx,
      });
      return toAdminApplicationDto(updated, !canSensitive);
    });
  }

  // === helpers ===

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }
}
