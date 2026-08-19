import { createHash } from 'node:crypto';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ContributionCalculator } from '../attendances/contribution-calculator';
import { SettlementDraftAuditRecorder } from './settlement-draft-audit-recorder';
import {
  rebuildServiceSegments,
  type ProjectedSegment,
  type ProjectorPunchEvent,
} from './settlement-segment-projector';

// ===== 活动改造 v1.1 第 2 批第二刀:结算草稿生成(合同 §5.9)=====
//
// 🔴 **这一刀的错不会报错。** 段算多算少、把待定当缺勤、无规则填 0 —— 每一种都会
//    安静地产出一个"看起来正常"的结果,然后进账本、进贡献值、进关账。
//    因此本文件的每一处"算不出来"都走**拒绝或待定**,没有一处走默认值。
//
// ## 输入与输出
//
// 输入:一张 **active** `EvidenceSeal`(§5.9 首句)。三种不满足各有具名码。
// 输出:
//   1. `ParticipantServiceSegmentRevision`(statusCode='draft')—— 由打卡事件链重建;
//   2. `AttendanceSettlementVersion`(statusCode='draft')+
//      `ParticipantSettlementResultRevision`(statusCode='draft')—— 逐人草稿项。
//
// ## 🔴 与合同的偏离(一处,必须读):待定项在库里表现为「没有行」
//
// §5.9 要求「无 event 者默认待负责人选择,**不自动认定 absent**」,§5.10 ④ 要求提交时
// 拦掉「**未决结果**」—— 即 working draft 里存在"未决"这个态。
// 但 §3.20 的 `resultCode` 是 **NOT NULL 十值闭集**(DB 上有 CHECK),
// 十个值全是**认定**(present / leave / absent / …),**没有一个表示"尚未认定"**。
// ⇒ 任何写进去的行都是一次认定。
//
// 两条路只能选一条:
//   (a) 写一行 `resultCode='absent'` + 一个"其实还没定"的标记;
//   (b) **不写行**,靠"人口里有他、结果表里没有他"表达未决。
//
// 本实现取 (b),理由是唯一的:(a) 会让任何**没读那个标记**的下游代码把一个人
// 静默判成缺勤,而数据库上**没有任何执行位**强迫下游读那个标记 —— 这正是本刀
// 要防的那类错。(b) 在结构上不可能被误读成 absent。
//
// (b) 的机器执行位是完备的,不是"靠自觉":
//   - `AttendanceSettlementVersion.sessionParticipationCount` 落的是**人口的身份数**,
//     即应有的草稿项数;第三刀提交时 §5.10 ④「working items 数量 = population」
//     一比就红,未决项不可能混过提交;
//   - 「未决」与「不在人口」可区分:未决 = `populationIncluded=true` 且无结果行,
//     不在人口 = `populationIncluded=false`(压根不进这个集合)。
//
// ⚠️ 代价(已在报告里列为待拍板项):系统给出的**建议值**目前只在本服务的返回值里
//    (`SettlementDraftItem.suggestedResultCode`),**不落库** —— 落库需要一个
//    不是 `resultCode` 的列,而 §3.20 没给。合同 §5.9 的原话是「系统**可**建议」,
//    故不落库不违约;若第三批读面需要它可查,需合同方补一个字段(新 finding)。
//
// ## 建议 ≠ 认定(goal DoD 4)
//
// `resultCode`(认定)与 `suggestedResultCode`(建议)是**两个字段**,并且互斥填充:
// `decision='pending'` 时 `resultCode` 恒 null、只有建议;
// `decision='machine_determined'` 时 `suggestedResultCode` 恒 null。
// 结构上不存在"把建议值当结果用"的路径。
//
// ## 锁序(§10.1)
//
// ① `Activity` 行锁 → ② `AttendanceSettlementRun` 行锁。**只有这两把**。
// ❌ 不取 member advisory lock:本刀不写任何队员维度的钱(账本分录、日上限归第五刀),
//    取了只会凭空多一条死锁边(沿第一刀与 concurrency-review-m1-m6 的同一判断)。
//
// ## 本刀不做的事
//
// ❌ 零 Punch 写路径(合同硬约束:本批完成前不开放新 Punch 写入口)——
//    本文件对 `AttendancePunchEvent` **只读**。
// ❌ 零端点 / 零 DTO / 零权限码(消费方在第三刀);判权在调用方。
// ❌ 不实现 worker / `ActivityBatchJob`(§5.9 的大规模路径归第五刀),超阈值明确拒绝。

type PrismaTx = Prisma.TransactionClient;

// §5.9:「500 人以内可同步生成 working draft;更大规模创建 ActivityBatchJob」。
// 取值 500 逐字来自合同;它是**同步路径的准入上限**,不是业务上限。
export const SETTLEMENT_DRAFT_SYNC_MAX_POPULATION = 500;

// 无岗位时的考勤角色,沿本仓 attendances 既有口径(考勤草稿「无岗位为 member」)。
// ⚠️ 这不是本刀发明的默认值:贡献规则的查找维度是
//    `activityTypeCode × attendanceRoleCode`,而 `member` 是仓内既有的那个基准角色。
const DEFAULT_ATTENDANCE_ROLE_CODE = 'member';

// 待定原因(不进 DB,只在返回值里;见文件头偏离说明)。
const PENDING_NO_PUNCH_EVENT = 'no_punch_event';
const PENDING_OPEN_SEGMENT = 'open_segment';
const PENDING_PUNCH_CHAIN_CONFLICT = 'punch_chain_conflict';

// 🔴 blocker:§5.9「贡献规则按 activityType×role×version 查找;**应计分无规则标 blocker**」
//    + 修订说明 §4「应计贡献的活动没有有效贡献规则时禁止终审」。
//
// ⚠️ 名字如实反映能观测到的事:复用的 `ContributionCalculator`(goal 指定必须复用,
//    且它是只读文件)对「无规则」与「有规则但给 0 分」**返回同一个 0**,不区分二者。
//    要区分就必须在活动模块另写一套规则查找 —— 那是 goal 明禁的。
//    故本刀按 fail-closed 取并集:**应计分的项只要算出 0 分就标 blocker**。
//    这严格蕴含合同要的「无规则必标」,代价是"规则确实给 0 分"的项也会被标住等人看
//    —— 宁可多拦一条,不可少拦一条。
const BLOCKER_ZERO_POINTS_WITHOUT_EFFECTIVE_RULE = 'contribution_points_zero_no_effective_rule';

export type SettlementDraftDecision = 'machine_determined' | 'pending';

export interface SettlementDraftItem {
  participationIdentityId: string;
  memberId: string;
  sessionId: string;
  // §5.9「以 ParticipationIdentity **current revision** 生成」—— 快照当刻的指针,
  // 不扫历史 revision 行。
  participationRevision: number;
  decision: SettlementDraftDecision;
  // 认定:decision='pending' 时恒 null(见文件头「建议 ≠ 认定」)。
  resultCode: string | null;
  // 建议:decision='machine_determined' 时恒 null。
  suggestedResultCode: string | null;
  pendingReasons: string[];
  blockers: string[];
  calculatedServiceHours: number;
  calculatedContributionPoints: number;
  lateFlag: boolean;
  earlyLeaveFlag: boolean;
  segmentCount: number;
}

export interface SettlementDraftResult {
  activityId: string;
  settlementRunId: string;
  settlementVersionId: string;
  settlementVersion: number;
  evidenceSealId: string;
  sealRevision: number;
  personCount: number;
  sessionParticipationCount: number;
  serviceSegmentCount: number;
  contentHash: string;
  items: SettlementDraftItem[];
  determinedItemCount: number;
  pendingItemCount: number;
  blockedItemCount: number;
  segmentsCreated: number;
  segmentsSuperseded: number;
  segmentsUnchanged: number;
}

// §3.20 的 `early_departure_zero` 是现场证据投影，不是负责人可凭空选出的结算结论。
// 负责人编辑 working draft 时可从其余九个业务结论中选择；已有早退项仍会原样读取并
// 可调整认定值，但 PATCH 不会伪造 `earlyLeaveFlag=true` 的现场事实。
export const SETTLEMENT_DRAFT_EDITABLE_RESULT_CODES = [
  'present',
  'leave',
  'absent',
  'cancelled',
  'not_selected',
  'waitlist_expired',
  'review_expired',
  'invitation_expired',
  'exempt',
] as const;

export interface SettlementDraftItemUpdateInput {
  activityId: string;
  participationIdentityId: string;
  expectedDraftVersion: number;
  resultCode: string;
  recognizedServiceHours: number;
  recognizedContributionPoints: number;
  reason: string;
}

export interface SettlementDraftItemUpdateResult {
  settlementVersionId: string;
  settlementVersion: number;
  participationIdentityId: string;
  resultCode: string;
  recognizedServiceHours: number;
  recognizedContributionPoints: number;
  calculatedServiceHours: number;
  calculatedContributionPoints: number;
  adjustmentReason: string | null;
  lateFlag: boolean;
  earlyLeaveFlag: boolean;
}

interface PopulationIdentity {
  id: string;
  memberId: string;
  sessionId: string;
  currentRevision: number;
  currentPositionId: string | null;
}

interface SessionThresholdRow {
  id: string;
  startAt: Date;
  endAt: Date;
  lateGraceMinutes: number;
  earlyLeaveThresholdMinutes: number;
}

interface ExistingSegmentRow {
  id: string;
  participationIdentityId: string;
  segmentKey: string;
  revision: number;
  statusCode: string;
  sourceCheckInEventId: string;
  sourceCloseEventId: string | null;
  resultCode: string;
  checkInAt: Date;
  checkOutAt: Date | null;
  serviceHours: Prisma.Decimal | null;
  lateFlag: boolean;
  earlyLeaveFlag: boolean;
  exceptionFlagsJson: Prisma.JsonValue | null;
}

// 段的 exceptionFlags 落库形状:空数组 ⇒ null(不落一个空壳 JSON)。
function segmentExceptionJson(flags: string[]): Prisma.InputJsonValue | null {
  return flags.length === 0 ? null : { flags: [...flags].sort() };
}

@Injectable()
export class SettlementDraftService {
  constructor(
    private readonly prisma: PrismaService,
    // goal 指定:贡献规则查找**复用** attendances 的既有实现(它带「重复 ACTIVE pair
    // fail-closed」不变量),❌ 不在活动模块写第二套。
    // ⚠️ 这里作为 **provider** 注入而不是 import AttendancesModule ——
    //    `AttendancesModule` 已经 import 了 `ActivitiesModule`,反向 import 会成环。
    //    `ContributionCalculator` 无构造依赖、无状态,同类第二个实例与第一个行为逐字相同。
    private readonly contributionCalculator: ContributionCalculator,
    private readonly audit: SettlementDraftAuditRecorder,
    // 活动 v1.1 cutover gate —— 新结算真相链的判闸依据(合同 §16.2 单轨)。
    private readonly activityWorkflowGate: ActivityWorkflowGate,
  ) {}

  // ===== ① Activity FOR UPDATE(§10.1 锁序第一层)=====
  private async lockActivity(
    tx: PrismaTx,
    activityId: string,
  ): Promise<{ activityTypeCode: string; workflowRevision: number }> {
    const rows = await tx.$queryRaw<Array<{ activityTypeCode: string; workflowRevision: number }>>`
      SELECT "activityTypeCode", "workflowRevision"
      FROM "Activity"
      WHERE id = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return row;
  }

  // ===== §5.9 首句:输入必须是 active EvidenceSeal,且与当前版本一致 =====
  //
  // 三个拒绝码对应三件不同的事:
  //   MISSING    —— 一次都没封过 ⇒ 先去封场;
  //   SUPERSEDED —— 封过但当前没有 active ⇒ 重新封场;
  //   STALE      —— 有 active,但它记的版本已不是现在的事实 ⇒ 先处理新证据再重新封场。
  private async requireActiveSeal(
    tx: PrismaTx,
    activityId: string,
    workflowRevision: number,
  ): Promise<{
    id: string;
    sealRevision: number;
    evidenceRevision: number;
    populationRevision: number;
  }> {
    const seal = await tx.evidenceSeal.findFirst({
      where: { activityId, statusCode: 'active' },
      orderBy: { sealRevision: 'desc' },
      select: {
        id: true,
        sealRevision: true,
        evidenceRevision: true,
        populationRevision: true,
        workflowRevision: true,
      },
    });
    if (seal === null) {
      const sealCount = await tx.evidenceSeal.count({ where: { activityId } });
      throw new BizException(
        sealCount === 0
          ? BizCode.SETTLEMENT_DRAFT_EVIDENCE_SEAL_MISSING
          : BizCode.SETTLEMENT_DRAFT_EVIDENCE_SEAL_SUPERSEDED,
      );
    }

    // 真源与第一刀一致:evidence / population 在 `ActivityEvidenceState`(行不存在 = 0/0),
    // workflow 在已加锁的 `Activity` 行上(§3.17 字段表没有 workflowRevision,
    // 见第一刀文件头偏离说明①)。
    const state = await tx.activityEvidenceState.findUnique({
      where: { activityId },
      select: { evidenceRevision: true, populationRevision: true },
    });
    const evidenceRevision = state?.evidenceRevision ?? 0;
    const populationRevision = state?.populationRevision ?? 0;
    if (
      seal.evidenceRevision !== evidenceRevision ||
      seal.populationRevision !== populationRevision ||
      seal.workflowRevision !== workflowRevision
    ) {
      throw new BizException(BizCode.SETTLEMENT_DRAFT_EVIDENCE_SEAL_STALE);
    }
    return seal;
  }

  // ===== ② AttendanceSettlementRun 行锁(§10.1 锁序第二层)=====
  //
  // §4.7:`drafting` 是唯一"正在编草稿"的状态;`not_started`(或还没有 run 行)是起点。
  // 其余状态一律拒 —— 版本已提交/审核中/已发布/已关账时重新生成 working draft,
  // 等于把审核依据从脚下抽走(§5.10 明写「提交后 working draft 不再是审核依据」)。
  private async lockOrCreateRun(
    tx: PrismaTx,
    activityId: string,
  ): Promise<{ id: string; statusCode: string; version: number }> {
    const rows = await tx.$queryRaw<Array<{ id: string; statusCode: string; version: number }>>`
      SELECT id, "statusCode", version
      FROM "AttendanceSettlementRun"
      WHERE "activityId" = ${activityId}
      FOR UPDATE
    `;
    const existing = rows[0];
    if (existing !== undefined) {
      if (existing.statusCode !== 'not_started' && existing.statusCode !== 'drafting') {
        throw new BizException(BizCode.SETTLEMENT_DRAFT_RUN_STATUS_INVALID);
      }
      return existing;
    }
    // 并发两个生成都会在 ① 的 Activity 行锁上串行,故这里不会撞 activityId unique。
    const created = await tx.attendanceSettlementRun.create({
      data: { activityId, statusCode: 'drafting' },
      select: { id: true, statusCode: true, version: true },
    });
    return created;
  }

  // ===== 第 ⑨a 刀：working draft 单项编辑 =====
  //
  // 锁序仍是 Activity → SettlementRun，且到此为止**不锁、不写**任何
  // AttendanceSettlementVersion。提交版的不可变性不是「更新后再补回去」的行为约定，
  // 而是本 PATCH 路径在结构上根本没有 Version 写调用。
  private async lockRunForDraftUpdate(
    tx: PrismaTx,
    activityId: string,
  ): Promise<{ id: string; statusCode: string; currentDraftVersion: number | null }> {
    const rows = await tx.$queryRaw<
      Array<{ id: string; statusCode: string; currentDraftVersion: number | null }>
    >`
      SELECT id, "statusCode", "currentDraftVersion"
      FROM "AttendanceSettlementRun"
      WHERE "activityId" = ${activityId}
      FOR UPDATE
    `;
    const run = rows[0];
    if (run === undefined)
      throw new BizException(BizCode.SETTLEMENT_DRAFT_UPDATE_RUN_STATUS_INVALID);
    return run;
  }

  async updateItem(
    input: SettlementDraftItemUpdateInput,
  ): Promise<SettlementDraftItemUpdateResult> {
    // 活动 v1.1 单一 cutover gate(合同 §16.2):闸未开时本实例仍按旧口径结算,
    // 新结算真相链禁止落库 —— 否则就是合同点名禁止的「新打卡＋旧结算」混合态。
    this.activityWorkflowGate.assertV11WriteAllowed();
    const reason = input.reason.trim();
    if (
      reason.length === 0 ||
      !SETTLEMENT_DRAFT_EDITABLE_RESULT_CODES.includes(
        input.resultCode as (typeof SETTLEMENT_DRAFT_EDITABLE_RESULT_CODES)[number],
      )
    ) {
      throw new BizException(BizCode.BAD_REQUEST);
    }

    return await this.prisma.$transaction(async (tx) => {
      // ①② 锁序固定。`closed` 是 `posted` 下游态，下面 `!== drafting` 一次覆盖，不会
      // 因枚举漏项留出关账后的编辑旁路。
      await this.lockActivity(tx, input.activityId);
      const run = await this.lockRunForDraftUpdate(tx, input.activityId);
      if (run.statusCode !== 'drafting') {
        throw new BizException(BizCode.SETTLEMENT_DRAFT_UPDATE_RUN_STATUS_INVALID);
      }
      if (run.currentDraftVersion !== input.expectedDraftVersion) {
        throw new BizException(BizCode.SETTLEMENT_DRAFT_UPDATE_EXPECTED_DRAFT_VERSION_MISMATCH);
      }

      const draft = await tx.attendanceSettlementVersion.findFirst({
        where: {
          settlementRunId: run.id,
          version: run.currentDraftVersion,
          statusCode: 'draft',
        },
        select: { id: true, version: true },
      });
      if (draft === null) throw new BizException(BizCode.SETTLEMENT_SUBMIT_DRAFT_MISSING);

      // 身份必须属于这场活动且在当前结算人口内；用 Activity_NOT_FOUND 隐去跨活动
      // identityId，避免负责人借本端点探测其它活动的参与身份。
      const identity = await tx.activityParticipationIdentity.findFirst({
        where: {
          id: input.participationIdentityId,
          activityId: input.activityId,
          populationIncluded: true,
        },
        select: { id: true },
      });
      if (identity === null) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);

      const existing = await tx.participantSettlementResultRevision.findUnique({
        where: {
          settlementVersionId_participationIdentityId: {
            settlementVersionId: draft.id,
            participationIdentityId: identity.id,
          },
        },
        select: {
          id: true,
          calculatedServiceHours: true,
          calculatedContributionPoints: true,
          lateFlag: true,
          earlyLeaveFlag: true,
        },
      });

      const result =
        existing === null
          ? await tx.participantSettlementResultRevision.create({
              data: {
                settlementVersionId: draft.id,
                participationIdentityId: identity.id,
                revision: 1,
                resultCode: input.resultCode,
                // 无结果行就是第二刀定义的「未决」。该形态没有可持久化的系统建议值；
                // 只能如实以零计算基线记录负责人认定，不能捏造一份不存在的机器计算。
                recognizedServiceHours: input.recognizedServiceHours,
                recognizedContributionPoints: input.recognizedContributionPoints,
                calculatedServiceHours: 0,
                calculatedContributionPoints: 0,
                adjustmentReason: reason,
                statusCode: 'draft',
              },
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
            })
          : await tx.participantSettlementResultRevision.update({
              where: { id: existing.id },
              data: {
                revision: { increment: 1 },
                resultCode: input.resultCode,
                recognizedServiceHours: input.recognizedServiceHours,
                recognizedContributionPoints: input.recognizedContributionPoints,
                adjustmentReason: reason,
              },
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
            });

      return {
        settlementVersionId: draft.id,
        settlementVersion: draft.version,
        participationIdentityId: identity.id,
        resultCode: result.resultCode,
        recognizedServiceHours: result.recognizedServiceHours.toNumber(),
        recognizedContributionPoints: result.recognizedContributionPoints.toNumber(),
        calculatedServiceHours: result.calculatedServiceHours.toNumber(),
        calculatedContributionPoints: result.calculatedContributionPoints.toNumber(),
        adjustmentReason: result.adjustmentReason,
        lateFlag: result.lateFlag,
        earlyLeaveFlag: result.earlyLeaveFlag,
      };
    });
  }

  // ===== §5.9:人口来源 = ParticipationIdentity current revision + populationIncluded =====
  private async readPopulation(tx: PrismaTx, activityId: string): Promise<PopulationIdentity[]> {
    return await tx.activityParticipationIdentity.findMany({
      where: { activityId, populationIncluded: true },
      select: {
        id: true,
        memberId: true,
        sessionId: true,
        currentRevision: true,
        currentPositionId: true,
      },
      // 稳定序:contentHash 与逐项写入顺序都必须可复现。
      orderBy: { id: 'asc' },
    });
  }

  // ===== §5.9 末句:同步路径的准入上限 =====
  //
  // 合同的字面是「500 **人**」。本实现拿**人数与草稿项数的较大者**比 500:
  // 草稿项是「每队员 × 每场次」一项,多场次活动的项数严格大于人数,而项数才是
  // 同步路径的真实开销。取较大者 = fail-closed,不会让 200 人 × 5 场次(1000 项)
  // 靠"人数没超"混进同步路径。
  private assertSyncPathAllowed(population: PopulationIdentity[]): void {
    const distinctMemberCount = new Set(population.map((row) => row.memberId)).size;
    if (Math.max(distinctMemberCount, population.length) > SETTLEMENT_DRAFT_SYNC_MAX_POPULATION) {
      throw new BizException(BizCode.SETTLEMENT_DRAFT_POPULATION_TOO_LARGE);
    }
  }

  private async readSessionThresholds(
    tx: PrismaTx,
    activityId: string,
  ): Promise<Map<string, SessionThresholdRow>> {
    const rows = await tx.activitySession.findMany({
      where: { activityId },
      select: {
        id: true,
        startAt: true,
        endAt: true,
        // §5.9「迟到／早退按**冻结**阈值计算成标签」——
        // 真源是**场次行上的这两列**(第 1 批已冻结);不读运行时配置、不读模板。
        lateGraceMinutes: true,
        earlyLeaveThresholdMinutes: true,
      },
    });
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async readPunchEventsByIdentity(
    tx: PrismaTx,
    activityId: string,
    identityIds: string[],
  ): Promise<Map<string, ProjectorPunchEvent[]>> {
    const byIdentity = new Map<string, ProjectorPunchEvent[]>();
    if (identityIds.length === 0) return byIdentity;
    // ⚠️ 只读。本刀对 AttendancePunchEvent 没有任何写路径(合同硬约束)。
    const rows = await tx.attendancePunchEvent.findMany({
      where: { activityId, participationIdentityId: { in: identityIds } },
      select: {
        id: true,
        participationIdentityId: true,
        eventTypeCode: true,
        occurredAt: true,
        supersedesEventId: true,
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
    for (const row of rows) {
      const bucket = byIdentity.get(row.participationIdentityId);
      const event: ProjectorPunchEvent = {
        id: row.id,
        eventTypeCode: row.eventTypeCode,
        occurredAt: row.occurredAt,
        supersedesEventId: row.supersedesEventId,
      };
      if (bucket === undefined) byIdentity.set(row.participationIdentityId, [event]);
      else bucket.push(event);
    }
    return byIdentity;
  }

  // ===== 段的落库:幂等 or 新 revision + 旧的标 superseded(goal DoD 8 二选一)=====
  //
  // 取的是**内容寻址**的混合口径,理由:
  //   - 输入没变 ⇒ 一行不动(**幂等**)。若每次生成都递增 revision,`contentHash` 会
  //     跟着漂,§5.10 / §5.11 的跨阶段比对就失去意义,revision 号也会毫无信息地膨胀。
  //   - 输入变了(void / replace 改了事实)⇒ **旧行标 superseded + 写 revision+1**,
  //     这正是 §4.5 的原话「相关 event 被 void／replace → 生成新的 segment revision,
  //     **不覆盖**旧 revision」。
  //   - 段消失了(签到被整条 void)⇒ 旧行标 superseded,不写新行。
  // §3.18 的 partial unique `(identityId, segmentKey) WHERE statusCode <> 'superseded'`
  // 保证了"至多一个当前修订";先降级后插入,顺序上不会撞。
  private async persistSegments(
    tx: PrismaTx,
    identityIds: string[],
    projectionByIdentity: Map<string, ProjectedSegment[]>,
  ): Promise<{ created: number; superseded: number; unchanged: number; currentCount: number }> {
    const existingRows: ExistingSegmentRow[] =
      identityIds.length === 0
        ? []
        : await tx.participantServiceSegmentRevision.findMany({
            where: { participationIdentityId: { in: identityIds } },
            select: {
              id: true,
              participationIdentityId: true,
              segmentKey: true,
              revision: true,
              statusCode: true,
              sourceCheckInEventId: true,
              sourceCloseEventId: true,
              resultCode: true,
              checkInAt: true,
              checkOutAt: true,
              serviceHours: true,
              lateFlag: true,
              earlyLeaveFlag: true,
              exceptionFlagsJson: true,
            },
          });

    // 🔴 防御:`committed` 段是正式生效的事实,§3.18 明写「正式生效后只能通过
    //    correction 创建后继 revision」。run 状态闸(only not_started/drafting)本已
    //    排除这种形态;这里再钉一道 —— 宁可拒绝,也不让重建路径去动一条已生效的段。
    if (existingRows.some((row) => row.statusCode === 'committed')) {
      throw new BizException(BizCode.SETTLEMENT_DRAFT_RUN_STATUS_INVALID);
    }

    const maxRevisionByKey = new Map<string, number>();
    const currentByKey = new Map<string, ExistingSegmentRow>();
    for (const row of existingRows) {
      const key = `${row.participationIdentityId}:${row.segmentKey}`;
      maxRevisionByKey.set(key, Math.max(maxRevisionByKey.get(key) ?? -1, row.revision));
      if (row.statusCode !== 'superseded') currentByKey.set(key, row);
    }

    let created = 0;
    let superseded = 0;
    let unchanged = 0;
    let currentCount = 0;

    const supersedeIds: string[] = [];
    const inserts: Prisma.ParticipantServiceSegmentRevisionUncheckedCreateInput[] = [];

    for (const identityId of identityIds) {
      const projected = projectionByIdentity.get(identityId) ?? [];
      const projectedKeys = new Set(projected.map((segment) => segment.segmentKey));

      for (const segment of projected) {
        const key = `${identityId}:${segment.segmentKey}`;
        const current = currentByKey.get(key);
        const exceptionFlagsJson = segmentExceptionJson(segment.exceptionFlags);
        if (current !== undefined && this.segmentMatches(current, segment, exceptionFlagsJson)) {
          unchanged += 1;
          currentCount += 1;
          continue;
        }
        if (current !== undefined) {
          supersedeIds.push(current.id);
          superseded += 1;
        }
        inserts.push({
          participationIdentityId: identityId,
          segmentKey: segment.segmentKey,
          revision: (maxRevisionByKey.get(key) ?? -1) + 1,
          sourceCheckInEventId: segment.sourceCheckInEventId,
          sourceCloseEventId: segment.sourceCloseEventId,
          resultCode: segment.resultCode,
          statusCode: 'draft',
          checkInAt: segment.checkInAt,
          checkOutAt: segment.checkOutAt,
          serviceHours: segment.serviceHours,
          lateFlag: segment.lateFlag,
          earlyLeaveFlag: segment.earlyLeaveFlag,
          exceptionFlagsJson: exceptionFlagsJson ?? Prisma.DbNull,
          baseRevisionId: current?.id ?? null,
        });
        created += 1;
        currentCount += 1;
      }

      // 这个 identity 下"当前还在、但新投影里已经没有"的段 ⇒ 降级,不写替代行。
      for (const [key, row] of currentByKey) {
        if (!key.startsWith(`${identityId}:`)) continue;
        if (projectedKeys.has(row.segmentKey)) continue;
        supersedeIds.push(row.id);
        superseded += 1;
      }
    }

    if (supersedeIds.length > 0) {
      await tx.participantServiceSegmentRevision.updateMany({
        where: { id: { in: supersedeIds } },
        data: { statusCode: 'superseded' },
      });
    }
    for (const data of inserts) {
      await tx.participantServiceSegmentRevision.create({ data });
    }
    return { created, superseded, unchanged, currentCount };
  }

  private segmentMatches(
    current: ExistingSegmentRow,
    segment: ProjectedSegment,
    exceptionFlagsJson: Prisma.InputJsonValue | null,
  ): boolean {
    const currentHours = current.serviceHours === null ? null : Number(current.serviceHours);
    return (
      current.statusCode === 'draft' &&
      current.sourceCheckInEventId === segment.sourceCheckInEventId &&
      current.sourceCloseEventId === segment.sourceCloseEventId &&
      current.resultCode === segment.resultCode &&
      current.checkInAt.getTime() === segment.checkInAt.getTime() &&
      (current.checkOutAt?.getTime() ?? null) === (segment.checkOutAt?.getTime() ?? null) &&
      currentHours === segment.serviceHours &&
      current.lateFlag === segment.lateFlag &&
      current.earlyLeaveFlag === segment.earlyLeaveFlag &&
      JSON.stringify(current.exceptionFlagsJson ?? null) === JSON.stringify(exceptionFlagsJson)
    );
  }

  // ===== 逐人草稿项:段 → 认定 / 待定 =====
  //
  // 判定表(§5.9 + §4.5),每一支都只由**观测到的事实**决定:
  //   链自相矛盾            ⇒ 待定(punch_chain_conflict)
  //   有开放段              ⇒ 待定(open_segment)—— 没有签退时刻就没有时长,不猜
  //   一条段都没有          ⇒ 待定(no_punch_event),建议 absent 但**不认定**
  //   有有效时长            ⇒ present
  //   只有 early_departure  ⇒ early_departure_zero(0 时长 0 分,不再算在场)
  private buildItem(
    identity: PopulationIdentity,
    segments: ProjectedSegment[],
    chainAnomalies: string[],
  ): SettlementDraftItem {
    const base = {
      participationIdentityId: identity.id,
      memberId: identity.memberId,
      sessionId: identity.sessionId,
      participationRevision: identity.currentRevision,
      lateFlag: segments.some((segment) => segment.lateFlag),
      earlyLeaveFlag: segments.some((segment) => segment.earlyLeaveFlag),
      segmentCount: segments.length,
    };

    const pendingReasons: string[] = [];
    if (chainAnomalies.length > 0) pendingReasons.push(PENDING_PUNCH_CHAIN_CONFLICT);
    if (segments.some((segment) => segment.checkOutAt === null)) {
      pendingReasons.push(PENDING_OPEN_SEGMENT);
    }
    if (segments.length === 0) pendingReasons.push(PENDING_NO_PUNCH_EVENT);

    if (pendingReasons.length > 0) {
      return {
        ...base,
        decision: 'pending',
        // 🔴 认定为空。**不**把下面那个建议值搬到这里来(goal DoD 4 第一红线)。
        resultCode: null,
        // 只有"一条现场事实都没有"这一种形态有明确建议;链冲突/开放段该怎么办
        // 合同没给,系统不猜(§5.9「系统**可**建议」是允许不是义务)。
        suggestedResultCode: pendingReasons.includes(PENDING_NO_PUNCH_EVENT) ? 'absent' : null,
        pendingReasons,
        blockers: [],
        calculatedServiceHours: 0,
        calculatedContributionPoints: 0,
      };
    }

    const serviceHours = segments.reduce((sum, segment) => sum + (segment.serviceHours ?? 0), 0);
    const hasValidSegment = segments.some((segment) => segment.resultCode === 'valid');
    return {
      ...base,
      decision: 'machine_determined',
      resultCode: hasValidSegment ? 'present' : 'early_departure_zero',
      suggestedResultCode: null,
      pendingReasons: [],
      blockers: [],
      calculatedServiceHours: Math.round(serviceHours * 100) / 100,
      // 贡献值在 applyContributionPoints 里统一算(要一次批量查规则)。
      calculatedContributionPoints: 0,
    };
  }

  // §5.9「贡献规则按 activityType×role 查找;应计分无规则标 blocker」。
  // 只有 `present` 参与查规则:`early_departure_zero` 是合同定死的 0 分零结果,
  // 不需要规则,也**不该**因此被标 blocker。
  private async applyContributionPoints(
    tx: PrismaTx,
    items: SettlementDraftItem[],
    roleByIdentityId: Map<string, string>,
    activityTypeCode: string,
  ): Promise<void> {
    const accruing = items.filter((item) => item.resultCode === 'present');
    if (accruing.length === 0) return;

    const prefilled = await this.contributionCalculator.applyContributionRulePrefill(
      accruing.map((item) => ({
        roleCode:
          roleByIdentityId.get(item.participationIdentityId) ?? DEFAULT_ATTENDANCE_ROLE_CODE,
        serviceHours: item.calculatedServiceHours,
      })),
      activityTypeCode,
      tx,
    );

    accruing.forEach((item, index) => {
      const points = prefilled[index].contributionPoints;
      item.calculatedContributionPoints = points;
      // 🔴 「0 分且无标记」是本刀明令不得出现的形态(见 BLOCKER_… 常量注释)。
      if (points === 0) item.blockers = [BLOCKER_ZERO_POINTS_WITHOUT_EFFECTIVE_RULE];
    });
  }

  private computeContentHash(input: {
    activityId: string;
    evidenceSealId: string;
    sealRevision: number;
    personCount: number;
    sessionParticipationCount: number;
    serviceSegmentCount: number;
    items: SettlementDraftItem[];
  }): string {
    // canonical:字段顺序写死在字面量里,items 已按 identityId 稳定排序 ⇒
    // 同样的事实必然得到同样的 hash(§5.10 / §5.11 要拿它跨阶段比对)。
    const canonical = JSON.stringify({
      activityId: input.activityId,
      evidenceSealId: input.evidenceSealId,
      sealRevision: input.sealRevision,
      personCount: input.personCount,
      sessionParticipationCount: input.sessionParticipationCount,
      serviceSegmentCount: input.serviceSegmentCount,
      items: input.items.map((item) => ({
        participationIdentityId: item.participationIdentityId,
        participationRevision: item.participationRevision,
        decision: item.decision,
        resultCode: item.resultCode,
        suggestedResultCode: item.suggestedResultCode,
        pendingReasons: item.pendingReasons,
        blockers: item.blockers,
        calculatedServiceHours: item.calculatedServiceHours,
        calculatedContributionPoints: item.calculatedContributionPoints,
        lateFlag: item.lateFlag,
        earlyLeaveFlag: item.earlyLeaveFlag,
        segmentCount: item.segmentCount,
      })),
    });
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }

  async generate(
    activityId: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<SettlementDraftResult> {
    // 活动 v1.1 单一 cutover gate(合同 §16.2):闸未开时本实例仍按旧口径结算,
    // 新结算真相链禁止落库 —— 否则就是合同点名禁止的「新打卡＋旧结算」混合态。
    this.activityWorkflowGate.assertV11WriteAllowed();
    return await this.prisma.$transaction(async (tx) => {
      const activity = await this.lockActivity(tx, activityId);
      const seal = await this.requireActiveSeal(tx, activityId, activity.workflowRevision);
      const run = await this.lockOrCreateRun(tx, activityId);

      const population = await this.readPopulation(tx, activityId);
      this.assertSyncPathAllowed(population);

      const sessions = await this.readSessionThresholds(tx, activityId);
      const identityIds = population.map((row) => row.id);
      const eventsByIdentity = await this.readPunchEventsByIdentity(tx, activityId, identityIds);

      // 岗位 → 考勤角色(贡献规则查找的第二个维度)。批量一次,不 N+1。
      const positionIds = [
        ...new Set(
          population
            .map((row) => row.currentPositionId)
            .filter((value): value is string => value !== null),
        ),
      ];
      const positions =
        positionIds.length === 0
          ? []
          : await tx.activitySessionPosition.findMany({
              where: { id: { in: positionIds } },
              select: { id: true, attendanceRoleCode: true },
            });
      const roleByPositionId = new Map(positions.map((row) => [row.id, row.attendanceRoleCode]));

      const projectionByIdentity = new Map<string, ProjectedSegment[]>();
      const items: SettlementDraftItem[] = [];
      const roleByIdentityId = new Map<string, string>();

      for (const identity of population) {
        const session = sessions.get(identity.sessionId);
        // 人口里的身份必然指向本活动的一个场次(复合 FK 保证);读不到只可能是
        // 数据被绕过应用层改坏 —— fail-closed,不拿默认阈值糊过去。
        if (session === undefined) throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);

        const projection = rebuildServiceSegments(eventsByIdentity.get(identity.id) ?? [], {
          sessionStartAt: session.startAt,
          sessionEndAt: session.endAt,
          lateGraceMinutes: session.lateGraceMinutes,
          earlyLeaveThresholdMinutes: session.earlyLeaveThresholdMinutes,
        });
        projectionByIdentity.set(identity.id, projection.segments);
        items.push(this.buildItem(identity, projection.segments, projection.chainAnomalies));
        roleByIdentityId.set(
          identity.id,
          identity.currentPositionId === null
            ? DEFAULT_ATTENDANCE_ROLE_CODE
            : (roleByPositionId.get(identity.currentPositionId) ?? DEFAULT_ATTENDANCE_ROLE_CODE),
        );
      }

      await this.applyContributionPoints(tx, items, roleByIdentityId, activity.activityTypeCode);

      const segmentStats = await this.persistSegments(tx, identityIds, projectionByIdentity);

      const personCount = new Set(population.map((row) => row.memberId)).size;
      const sessionParticipationCount = population.length;
      const contentHash = this.computeContentHash({
        activityId,
        evidenceSealId: seal.id,
        sealRevision: seal.sealRevision,
        personCount,
        sessionParticipationCount,
        serviceSegmentCount: segmentStats.currentCount,
        items,
      });

      // ===== working draft 版本:内容寻址,**零删除** =====
      //
      // 与段的处置同一口径(goal DoD 8「幂等 or 新 revision + 旧的标 superseded」),
      // 两半都用上:
      //   - `contentHash` 与当前 draft 版本相同 ⇒ **一行不动**(幂等);
      //   - 不同 ⇒ 旧 draft 版本标 `voided`(§3.19 闭集里的终态),另开 version+1。
      //
      // ⚠️ **为什么不"就地重写"**:就地重写要先把旧草稿项删掉,而本仓铁律是
      //    「业务数据一律软删」,`ParticipantSettlementResultRevision` 连 `deletedAt`
      //    列都没有 ⇒ 硬删是唯一写法,而那正是 lint 拦下的形态(初版实测被拦)。
      //    退一步说,就地重写还会留下"某人上一轮被判 present、这一轮变待定"时那条
      //    **陈旧的认定行**没人清 —— 换成整版 `voided` 之后,"当前草稿"永远是
      //    一个内部自洽的快照,读面按 `statusCode='draft'` 一刀切干净。
      //
      // 版本号只在**内容真的变了**时才前进,所以它不会退化成"生成次数"。
      const existingDraft = await tx.attendanceSettlementVersion.findFirst({
        where: { settlementRunId: run.id, statusCode: 'draft' },
        orderBy: { version: 'desc' },
        select: { id: true, version: true, contentHash: true },
      });

      let settlementVersionId: string;
      let settlementVersion: number;
      if (existingDraft !== null && existingDraft.contentHash === contentHash) {
        settlementVersionId = existingDraft.id;
        settlementVersion = existingDraft.version;
      } else {
        if (existingDraft !== null) {
          await tx.attendanceSettlementVersion.update({
            where: { id: existingDraft.id },
            data: { statusCode: 'voided' },
          });
        }
        const maxVersion = await tx.attendanceSettlementVersion.aggregate({
          where: { settlementRunId: run.id },
          _max: { version: true },
        });
        settlementVersion = (maxVersion._max.version ?? 0) + 1;
        const created = await tx.attendanceSettlementVersion.create({
          data: {
            settlementRunId: run.id,
            version: settlementVersion,
            evidenceSealId: seal.id,
            evidenceRevision: seal.evidenceRevision,
            populationRevision: seal.populationRevision,
            workflowRevision: activity.workflowRevision,
            contentHash,
            personCount,
            sessionParticipationCount,
            serviceSegmentCount: segmentStats.currentCount,
            createdByUserId: currentUser.id,
            statusCode: 'draft',
          },
          select: { id: true },
        });
        settlementVersionId = created.id;

        // 🔴 只为**已认定**的项写结果行。待定项刻意不写(见文件头偏离说明)——
        //    `sessionParticipationCount` 已经把"应有多少项"落在版本行上,
        //    第三刀提交时按 §5.10 ④ 一比就红。
        for (const item of items) {
          if (item.decision !== 'machine_determined' || item.resultCode === null) continue;
          await tx.participantSettlementResultRevision.create({
            data: {
              settlementVersionId,
              participationIdentityId: item.participationIdentityId,
              revision: 0,
              resultCode: item.resultCode,
              lateFlag: item.lateFlag,
              earlyLeaveFlag: item.earlyLeaveFlag,
              exceptionFlagsJson:
                item.blockers.length === 0
                  ? Prisma.DbNull
                  : { blockers: [...item.blockers].sort() },
              // 草稿阶段"认定值 = 计算值"(负责人还没调过);两者相等 ⇒
              // §3.20 的 adjustmentReason 必填 CHECK 不触发。
              recognizedServiceHours: item.calculatedServiceHours,
              recognizedContributionPoints: item.calculatedContributionPoints,
              calculatedServiceHours: item.calculatedServiceHours,
              calculatedContributionPoints: item.calculatedContributionPoints,
              statusCode: 'draft',
            },
          });
        }
      }

      await tx.attendanceSettlementRun.update({
        where: { id: run.id },
        data: {
          statusCode: 'drafting',
          currentDraftVersion: settlementVersion,
          version: { increment: 1 },
        },
      });

      const determinedItemCount = items.filter(
        (item) => item.decision === 'machine_determined',
      ).length;
      const pendingItemCount = items.length - determinedItemCount;
      const blockedItemCount = items.filter((item) => item.blockers.length > 0).length;

      await this.audit.log({
        activityId,
        settlementVersionId,
        settlementVersion,
        evidenceSealId: seal.id,
        sealRevision: seal.sealRevision,
        personCount,
        sessionParticipationCount,
        serviceSegmentCount: segmentStats.currentCount,
        determinedItemCount,
        pendingItemCount,
        blockedItemCount,
        segmentsCreated: segmentStats.created,
        segmentsSuperseded: segmentStats.superseded,
        segmentsUnchanged: segmentStats.unchanged,
        contentHash,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        auditMeta,
        tx,
      });

      return {
        activityId,
        settlementRunId: run.id,
        settlementVersionId,
        settlementVersion,
        evidenceSealId: seal.id,
        sealRevision: seal.sealRevision,
        personCount,
        sessionParticipationCount,
        serviceSegmentCount: segmentStats.currentCount,
        contentHash,
        items,
        determinedItemCount,
        pendingItemCount,
        blockedItemCount,
        segmentsCreated: segmentStats.created,
        segmentsSuperseded: segmentStats.superseded,
        segmentsUnchanged: segmentStats.unchanged,
      };
    });
  }
}
