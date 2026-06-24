import { Injectable } from '@nestjs/common';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { RbacService } from '../permissions/rbac.service';
import {
  ELIM_STAGE_EVALUATION,
  THRESHOLD_CODES,
  type ThresholdCode,
  type ThresholdMarks,
  VERIFY_OUTCOME_FORGERY_WARNING,
  VERIFY_OUTCOME_OCR_ERROR,
  comparePromotionOrder,
  decidePromotionIssuance,
} from './recruitment.constants';
import type { RecruitmentCycleStatsDto } from './recruitment.dto';
import {
  STAGE_EVALUATION,
  STAGE_MANUAL,
  STAGE_PUBLICITY,
  STAGE_REJECTED,
  STAGE_THRESHOLD,
  STAGE_VOLUNTEER,
  THRESHOLD_NAMES,
  deriveRecruitmentStage,
} from './recruitment-progress-presenter';

// 招新闭环优化 S2(评审稿 §7 招新工作台;goal「招新闭环优化 S2」):管理端聚合只读 stats。
//
// **职责边界(QueryService;architecture-boundary §3.1)**:纯读聚合,零写、零状态机、零 schema。
// 判权走 R 模式(入口仅全局 JwtAuthGuard,本服务 rbac.can('recruitment-application.read.record');
// 本仓无 @RequirePermissions 装饰器,沿 list/detail/publicityList 同款,零新 RBAC 码)。
//
// **零漂移口径(DoD#2 / 评审稿 §7.1 line 365「待处理事项即各 stage 计数」)**:
// 各业务态计数复用 S1 `deriveRecruitmentStage`(单一 stage 派生纯函数),**不另立第二套 stage 判定**。
// `verified` 据 thresholdMarks 完成度拆 `threshold`(未齐)/`threshold_done`(齐),且「各门槛完成分布」
// 需折叠 thresholdMarks(JSON);二者均非 Prisma count/groupBy 可表达 —— 故采「该轮单次有界 fetch +
// 内存派生 tally」(评审稿 §7.1 明许「thresholdMarks 折叠限定在该轮 applications,招新规模可接受」)。
// 公示发号「可一键发号/需手动建档」复用 `decidePromotionIssuance`(与 publicityList / 实际 promote 同序同判,
// 结构性保证三处计数一致;不改其逻辑,仅计数)。
//
// **聚合成本**:每轮 1 次 applications.findMany(限定该轮 + 未软删,有界)+ 1 次 user.findMany
// (仅公示子集的 openid 占用判定;空集免查)。禁 N+1、禁跨轮全表扫描。

// 该轮聚合所需最小字段集(stage 派生 + 今日时间戳 + 待人工细分代理 + 评定淘汰 + 发号预判)。
const STATS_SELECT = {
  id: true,
  statusCode: true,
  thresholdMarks: true,
  tempNo: true,
  promotedMemberId: true,
  createdAt: true,
  verifiedAt: true,
  reviewedAt: true,
  verifyOutcome: true,
  eliminationStage: true,
  isForeigner: true,
  birthDate: true,
  genderCode: true,
  openid: true,
  realName: true,
} as const;

// 固定 UTC+8 日界(与 birthday-greeting / sms-code 私有 startOfDayUtc8 同口径;各模块级实现、
// 不抽共享 util —— AGENTS §2 grab-bag 禁令)。返回该北京自然日的 UTC 起点瞬间。
const UTC8_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 86_400_000;
function startOfBeijingDay(now: Date): Date {
  const shifted = now.getTime() + UTC8_OFFSET_MS;
  const dayStartShifted = Math.floor(shifted / DAY_MS) * DAY_MS;
  return new Date(dayStartShifted - UTC8_OFFSET_MS);
}

@Injectable()
export class RecruitmentStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  /**
   * 招新工作台聚合 stats(评审稿 §7.1 五组;答 handoff GAP-003「招新进度」)。
   * `now` 由调用方注入(controller 传 new Date();便于单测固定北京日界)。
   */
  async getCycleStats(
    cycleId: string,
    user: CurrentUserPayload,
    now: Date,
  ): Promise<RecruitmentCycleStatsDto> {
    await this.assertCanOrThrow(user, 'recruitment-application.read.record');

    const cycle = await this.prisma.recruitmentCycle.findFirst({
      where: { id: cycleId, deletedAt: null },
      select: { id: true, year: true },
    });
    if (!cycle) {
      throw new BizException(BizCode.RECRUITMENT_CYCLE_NOT_FOUND);
    }

    const apps = await this.prisma.recruitmentApplication.findMany({
      where: { cycleId, deletedAt: null },
      select: STATS_SELECT,
    });

    const dayStart = startOfBeijingDay(now);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    const inToday = (d: Date | null): boolean => d != null && d >= dayStart && d < dayEnd;

    // 今日数据
    let todayNewApplications = 0;
    let todayTempNoIssued = 0;
    let todayManualProcessed = 0;
    // 待处理 / 综合评定 / 公示发号(按 stage 计数;单一口径)
    let manualTotal = 0;
    let manualHigh = 0;
    let manualSystem = 0;
    let pendingEvaluation = 0;
    let inPublicity = 0;
    let promotedCount = 0;
    let evalEliminated = 0;
    // 门槛进度
    let thresholdTracking = 0;
    const thresholdCompleted: Record<ThresholdCode, number> = {
      patrol1: 0,
      patrol2: 0,
      training: 0,
      redCross: 0,
      bsafe: 0,
    };
    // 公示子集(留作 decidePromotionIssuance 预判)
    const publicityApps: (typeof apps)[number][] = [];

    for (const a of apps) {
      if (inToday(a.createdAt)) todayNewApplications += 1;
      if (inToday(a.verifiedAt)) todayTempNoIssued += 1;
      if (inToday(a.reviewedAt)) todayManualProcessed += 1;

      // 各门槛完成分布:真投影(标记存在即完成),折叠该轮全部行的 thresholdMarks。
      const marks = a.thresholdMarks as ThresholdMarks | null;
      if (marks) {
        for (const code of THRESHOLD_CODES) {
          if (marks[code] != null) thresholdCompleted[code] += 1;
        }
      }

      // 复用 S1 单一 stage 口径(零第二套判定)。
      const { stage } = deriveRecruitmentStage({
        statusCode: a.statusCode,
        thresholdMarks: marks,
        tempNo: a.tempNo,
        promotedMemberId: a.promotedMemberId,
      });
      switch (stage) {
        case STAGE_MANUAL:
          manualTotal += 1;
          // riskLevel 精确三栏待 S4;本切片用 verifyOutcome 代理(其余归 normal,见下方 manualNormal)。
          if (a.verifyOutcome === VERIFY_OUTCOME_OCR_ERROR) manualSystem += 1;
          else if (a.verifyOutcome === VERIFY_OUTCOME_FORGERY_WARNING) manualHigh += 1;
          break;
        case STAGE_THRESHOLD:
          thresholdTracking += 1;
          break;
        case STAGE_EVALUATION:
          pendingEvaluation += 1;
          break;
        case STAGE_PUBLICITY:
          inPublicity += 1;
          publicityApps.push(a);
          break;
        case STAGE_VOLUNTEER:
          promotedCount += 1;
          break;
        case STAGE_REJECTED:
          if (a.eliminationStage === ELIM_STAGE_EVALUATION) evalEliminated += 1;
          break;
        // STAGE_THRESHOLD_DONE 为瞬态(verified+门槛齐,markThreshold 末次完成即自动→pending_evaluation),
        // 几乎不持久;既非「门槛跟踪中」(未齐)亦非「待评定」(尚未推进),本切片不计入任何 pending 桶(防重复)。
      }
    }
    const manualNormal = manualTotal - manualHigh - manualSystem;

    // 可一键发号 / 需手动建档:与 publicityList / 实际 promote 同序(comparePromotionOrder)、
    // 同判(decidePromotionIssuance:isPromotable + openid 未被既有 User 占用 + 批内 openid 去重)。
    const publicityOpenids = publicityApps
      .map((a) => a.openid)
      .filter((o): o is string => o != null);
    const boundRows = publicityOpenids.length
      ? await this.prisma.user.findMany({
          where: { openid: { in: publicityOpenids } },
          select: { openid: true },
        })
      : [];
    const boundOpenids = new Set(
      boundRows.map((r) => r.openid).filter((o): o is string => o != null),
    );
    const sortedPublicity = [...publicityApps].sort(comparePromotionOrder);
    const decisions = decidePromotionIssuance(sortedPublicity, boundOpenids);
    const oneClickIssuable = decisions.filter((d) => d.willIssue).length;
    const needManualBuild = decisions.length - oneClickIssuable;

    return {
      cycleId: cycle.id,
      cycleYear: cycle.year,
      today: {
        newApplications: todayNewApplications,
        tempNoIssued: todayTempNoIssued,
        manualProcessed: todayManualProcessed,
      },
      pending: {
        manualTotal,
        manualNormal,
        manualHigh,
        manualSystem,
        pendingEvaluation,
        pendingIssuance: inPublicity,
      },
      threshold: {
        tracking: thresholdTracking,
        byThreshold: THRESHOLD_CODES.map((code) => ({
          code,
          name: THRESHOLD_NAMES[code],
          completedCount: thresholdCompleted[code],
        })),
      },
      evaluation: {
        pending: pendingEvaluation,
        passed: inPublicity,
        eliminated: evalEliminated,
      },
      issuance: {
        inPublicity,
        oneClickIssuable,
        needManualBuild,
        promoted: promotedCount,
      },
    };
  }

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }
}
