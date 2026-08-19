import { Injectable } from '@nestjs/common';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { SettlementNotificationProducer } from './settlement-notification-producer';
import { freezeResponsibility } from './activity-recipient-freeze';
import { SettlementSubmitAuditRecorder } from './settlement-submit-audit-recorder';
import {
  computeSettlementContentHash,
  decimalToCanonicalString,
  SETTLEMENT_CONTENT_SCHEMA_VERSION,
  type CanonicalValue,
  type SettlementContentItem,
} from './settlement-content-hash';
import {
  validateSettlementSubmission,
  type SettlementSubmissionFacts,
  type SettlementSubmissionRejection,
} from './settlement-submission-validator';

// ===== 活动改造 v1.1 第 2 批第三刀:提交不可变 SettlementVersion(合同 §5.10)=====
//
// 🔴 **提交是单向门。** 提交之后草稿不再算数;错的东西一旦被固化成不可变版本,
//    只能靠退回重来 —— 而退回是有成本的人工流程。因此本文件的每一处判据都走
//    **拒绝**,没有一处走"警告后放行"。宁可多拒,不可少拒。
//
// ## 锁序(§5.10 ①② / §10.1)
//
// ① `Activity` `FOR UPDATE` → ② `AttendanceSettlementRun` `FOR UPDATE`。**只有这两把**,
// 且**不得倒置**(与第一、二刀逐字同序 —— 反序即死锁边)。
// ❌ **不取 member advisory lock**:本刀不写任何队员维度的事实(账本分录、日上限归
//    第五刀),取了只会凭空多一条死锁边(沿 concurrency-review-m1-m6 的同一判断)。
//
// 这两把锁同时也是**幂等的正确性依据**:`AttendanceSettlementVersion.operationKey`
// 在 DB 上**只有普通 index、没有 unique**(§3.19 只给 `SettlementReviewAction` 点了
// unique operationKey,没给 Version)。所以"先查后写"的防重不是靠唯一约束兜底,
// 而是靠 run 行锁把同一条 run 上的并发提交**串行化**。见 `resolveIdempotency`。
//
// ## DoD 7:提交是**另开一版**,不是把草稿行翻状态
//
// §3.19 原话:「草稿可通过独立 draft working tables 编辑;点击提交时在事务中把当前
// 草稿**固化为** immutable SettlementVersion。审核永远引用 versionId,**不引用可变
// run 内容**。」——"固化为"是拷贝,不是改名:
//
//   - 若把草稿行 `statusCode` 就地翻成 `submitted`,被审核的那一行**就是**草稿路径
//     自己拥有的那一行 —— "审核对象不可被草稿路径触达"这句话就没有结构位了,只剩
//     run 状态闸这一道人为约定;
//   - 另开一版之后,提交版本的结果行是**物理上另一批行**(另一个 `settlementVersionId`),
//     第二刀的生成器只会写 `statusCode='draft'` 且挂在草稿版本下的行,**在结构上
//     够不到**已提交版本的任何一行。
//
// 草稿版本行本身**不动**(仍是 `draft`):它还是那个"可编辑的工作区"(§3.19 明写草稿
// 可编辑)。"提交后草稿不再是审核依据"的执行位是 `run.currentSubmittedVersion`
// 指向的**永远是提交版本**,加上 §5.11 只认 versionId。
//
// `priorVersionId` 串的是**提交链**(上一个已提交版本),不是"上一个草稿"——
// §5.10 末句「修改必须从 returned 状态创建新 version」关心的正是提交与提交之间的关系。
//
// ## DoD 6:批量写与人数无关
//
// 结果行的固化用**一条 `INSERT ... SELECT`**(见 `copyResultRows`):
// **实测 8192 行 ⇒ 1 条 SQL、2 个 bind 参数**(源版本 id、目标版本 id),
// 跟 1 个人还是 10 万人完全无关。
//
// ⚠️ 三种写法的实测读数(2026-08-05,PG16 + Prisma 6.19.3),不要凭印象:
//   - **手写逐行 `VALUES`**:确定性打穿。8192 行 × 4 列 = 32768 个参数即报
//     `too many bind variables in prepared statement, expected maximum of 32767`;
//     32000 个参数通过 ⇒ 上限逐字是 **32767**。本表 18 列 ⇒ 约 **1820 行**就崩。
//   - **Prisma `createMany`**:**不会**崩 —— 它按 bind 上限**自动分块**
//     (实测 8192 行 × 7 参数 ⇒ 拆成 **2 条** INSERT,32760 + 24584 个参数)。
//     ⚠️ 初版这里写的是"createMany 会在 1800 行确定性打穿",**是错的**,
//        由把 `copyResultRows` 换成 createMany 的变异 A/B 实测推翻(那一版 41 条
//        用例仍然全绿)。留此更正,免得后人照抄一个假前提。
//   - 仍然**不用** createMany 的真实理由是另一条:它的 SQL 条数是
//     `ceil(行数 × 每行参数 / 32767)`,即 **O(人数)**;而且要把全部结果行读进
//     应用进程再发回去(读一遍 + 写一遍,内存也是 O(人数))。
//     本仓的批量化判据是「**SQL 次数固定**」—— `INSERT ... SELECT` 恒 1 条、
//     零行经过应用进程,createMany 两条都不满足。
// ❌ 手写逐行 `VALUES` 更不行(上面第一条,确定性失败)。
//
// ## 本刀不做的事
//
// ❌ 零端点 / 零 DTO / 零权限码(整条结算流程的对外入口统一留到第 2 批收尾再开);
//    判权在调用方。
// ❌ 零 schema 变更;❌ 零 Punch 写路径;❌ 不重新封场(只复验第一刀写下的 seal)。

type PrismaTx = Prisma.TransactionClient;

// 显式事务预算。Prisma 默认只有 **5s** —— 而本刀的事务里有一步是与人数相关的:
// 算 contentHash 要把被冻结的结果行读回来(bind 参数与人数无关,但**行数**与人数
// 相关)。实测 8192 人的提交在默认预算下必然超时(第一版就栽在这里)。
//
// ⚠️ 这不是"调大超时掩盖 bind 上限"——bind 上限已经用 `INSERT ... SELECT` 从结构上
//    解决(恒 2 个参数)。这里解决的是另一件事:**大规模结算的事务时间预算**。
//    两者是不同的失败模式,不能互相顶替。
//
// 取 120s 的依据:提交期间持有的是 `Activity` + `AttendanceSettlementRun` 两把**行锁**,
// 阻塞面只到这一个活动的结算流程(不碰队员、不碰账本);而一次万人结算提交如果被
// 预算顶死整批回滚,负责人除了重试没有别的办法 —— 宁可让它跑完。
export const SETTLEMENT_SUBMIT_TX_TIMEOUT_MS = 120_000;

/** 结果行的完整列清单。`INSERT ... SELECT` 与"读回来算 hash"共用同一份认知。 */
const RESULT_ROW_TARGET_COLUMNS = [
  'id',
  'createdAt',
  'updatedAt',
  'settlementVersionId',
  'participationIdentityId',
  'revision',
  'resultCode',
  'lateFlag',
  'earlyLeaveFlag',
  'exceptionFlagsJson',
  'recognizedServiceHours',
  'recognizedContributionPoints',
  'calculatedServiceHours',
  'calculatedContributionPoints',
  'adjustmentReason',
  'statusCode',
  'baseResultRevisionId',
  'correctionRequestId',
] as const;

export interface SettlementSubmitInput {
  activityId: string;
  /** §5.10 ⑥ 防重键。同 key 同 payload 重放返回同一版本;同 key 不同 payload 拒。 */
  operationKey: string;
  /** 提交内容的调用方摘要。与 `operationKey` 成对,决定"是重放还是撞键"。 */
  requestHash: string;
  /**
   * §6.14 HTTP 版本锚点。缺省时保持既有内部调用的提交语义;入口调用必须提供。
   * 真正比较落在事务内、Activity/Run 锁之后,不能由 Controller 锁外预查代替。
   */
  expectedDraftVersion?: number;
  /** §6.14 HTTP 看到的草稿封场凭证;缺省时保持既有内部调用语义。 */
  expectedEvidenceSealId?: string;
}

export interface SettlementSubmitResult {
  activityId: string;
  settlementRunId: string;
  settlementVersionId: string;
  settlementVersion: number;
  priorVersionId: string | null;
  /** 本次固化所依据的草稿版本。**重放路径为 null**(重放不重新依据草稿)。 */
  draftVersionId: string | null;
  evidenceSealId: string;
  sealRevision: number;
  personCount: number;
  sessionParticipationCount: number;
  serviceSegmentCount: number;
  resultRowCount: number;
  contentHash: string;
  /** true = 同 key 同 payload 的重放,没有产生第二条版本。 */
  replayed: boolean;
}

interface LockedActivity {
  title: string;
  workflowRevision: number;
}

interface LockedRun {
  id: string;
  statusCode: string;
  version: number;
}

interface DraftVersionRow {
  id: string;
  version: number;
  evidenceSealId: string;
  evidenceRevision: number;
  populationRevision: number;
  workflowRevision: number;
  personCount: number;
  sessionParticipationCount: number;
  serviceSegmentCount: number;
}

/** 五条判据 → 具名码。**一一对应,没有一条落到兜底码上**(那等于没具名)。 */
const REJECTION_TO_BIZ_CODE: Record<
  SettlementSubmissionRejection,
  (typeof BizCode)[keyof typeof BizCode]
> = {
  pending_result: BizCode.SETTLEMENT_SUBMIT_PENDING_RESULT,
  item_count_mismatch: BizCode.SETTLEMENT_SUBMIT_ITEM_COUNT_MISMATCH,
  duplicate_identity: BizCode.SETTLEMENT_SUBMIT_DUPLICATE_IDENTITY,
  open_segment: BizCode.SETTLEMENT_SUBMIT_OPEN_SEGMENT,
  missing_rule: BizCode.SETTLEMENT_SUBMIT_MISSING_RULE,
};

@Injectable()
export class SettlementSubmitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: SettlementSubmitAuditRecorder,
    private readonly notifications: SettlementNotificationProducer,
    // 活动 v1.1 cutover gate —— 新结算真相链的判闸依据(合同 §16.2 单轨)。
    private readonly activityWorkflowGate: ActivityWorkflowGate,
  ) {}

  // ===== ① Activity FOR UPDATE(§5.10 ①;锁序第一层)=====
  private async lockActivity(tx: PrismaTx, activityId: string): Promise<LockedActivity> {
    const rows = await tx.$queryRaw<Array<LockedActivity>>`
      SELECT title, "workflowRevision"
      FROM "Activity"
      WHERE id = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return row;
  }

  // ===== ② AttendanceSettlementRun FOR UPDATE(§5.10 ②;锁序第二层)=====
  //
  // ⚠️ 这里**只加锁、不判状态**。判状态在 `assertRunDrafting`,并且它必须排在幂等
  //    判定**之后** —— 见 `submit` 里那段注释:重放请求打过来时 run 早就不在
  //    `drafting` 了(第一次提交已经把它推到 `pending_first_review`),先判状态会把
  //    合法重放判成非法,幂等就名存实亡。
  private async lockRun(tx: PrismaTx, activityId: string): Promise<LockedRun> {
    const rows = await tx.$queryRaw<Array<LockedRun>>`
      SELECT id, "statusCode", version
      FROM "AttendanceSettlementRun"
      WHERE "activityId" = ${activityId}
      FOR UPDATE
    `;
    const run = rows[0];
    // 连 run 行都没有 ⇒ 从来没生成过草稿,没有任何可提交或可重放的东西。
    if (run === undefined) throw new BizException(BizCode.SETTLEMENT_SUBMIT_RUN_STATUS_INVALID);
    return run;
  }

  // §4.7 的链是 `not_started → drafting → submitted → …`:**只有 `drafting` 能提交**。
  // `not_started` 意味着还没生成过草稿;其余状态意味着已经有一个版本在审核/发布/关账
  // 流程里 —— 再提交一次就是把审核依据从审核人脚下换掉。
  private assertRunDrafting(run: LockedRun): void {
    if (run.statusCode !== 'drafting') {
      throw new BizException(BizCode.SETTLEMENT_SUBMIT_RUN_STATUS_INVALID);
    }
  }

  // ===== §5.10 ③:EvidenceSeal 复验(**只复验,不重新封场**)=====
  //
  // 两件事都要成立:
  //   (a) 草稿引用的那张 seal **此刻仍是 active** 的那一张;
  //   (b) 它记的 evidence / population / workflow revision **仍等于当前事实**。
  // 任一不成立,草稿就是按一份过期的现场快照算出来的账。
  private async recheckEvidenceSeal(
    tx: PrismaTx,
    activityId: string,
    draft: DraftVersionRow,
    workflowRevision: number,
  ): Promise<{ id: string; sealRevision: number }> {
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
    // 没有 active seal:封场被推翻了(或从未封场)⇒ 先去重新封场。
    if (seal === null) throw new BizException(BizCode.SETTLEMENT_SUBMIT_EVIDENCE_SEAL_INACTIVE);
    // 当前 active seal 已经不是草稿引用的那一张 ⇒ 草稿是按旧封场算的。
    if (seal.id !== draft.evidenceSealId) {
      throw new BizException(BizCode.SETTLEMENT_SUBMIT_EVIDENCE_SEAL_STALE);
    }

    // 真源与第一、二刀一致:evidence / population 在 `ActivityEvidenceState`
    // (行不存在 = 0/0),workflow 在已加锁的 `Activity` 行上。
    const state = await tx.activityEvidenceState.findUnique({
      where: { activityId },
      select: { evidenceRevision: true, populationRevision: true },
    });
    const evidenceRevision = state?.evidenceRevision ?? 0;
    const populationRevision = state?.populationRevision ?? 0;
    if (
      seal.evidenceRevision !== evidenceRevision ||
      seal.populationRevision !== populationRevision ||
      seal.workflowRevision !== workflowRevision ||
      // 草稿自己记的三个版本也必须与 seal 一致 —— 草稿生成之后 seal 被换过的形态。
      draft.evidenceRevision !== seal.evidenceRevision ||
      draft.populationRevision !== seal.populationRevision ||
      draft.workflowRevision !== seal.workflowRevision
    ) {
      throw new BizException(BizCode.SETTLEMENT_SUBMIT_EVIDENCE_SEAL_STALE);
    }
    return { id: seal.id, sealRevision: seal.sealRevision };
  }

  private async readDraftVersion(tx: PrismaTx, settlementRunId: string): Promise<DraftVersionRow> {
    const draft = await tx.attendanceSettlementVersion.findFirst({
      where: { settlementRunId, statusCode: 'draft' },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        evidenceSealId: true,
        evidenceRevision: true,
        populationRevision: true,
        workflowRevision: true,
        personCount: true,
        sessionParticipationCount: true,
        serviceSegmentCount: true,
      },
    });
    if (draft === null) throw new BizException(BizCode.SETTLEMENT_SUBMIT_DRAFT_MISSING);
    return draft;
  }

  // ===== §5.10 ④ 的五个事实(全部聚合,**与人数无关**)=====
  //
  // 五条判据各读**自己那一个计数**,彼此不共享中间量 —— 这是"逐条卸掉后红集互不
  // 重叠"的结构前提。判据本身在 `settlement-submission-validator.ts`(纯函数)。
  private async readSubmissionFacts(
    tx: PrismaTx,
    activityId: string,
    draftVersionId: string,
  ): Promise<SettlementSubmissionFacts> {
    const rows = await tx.$queryRaw<
      Array<{
        populationCount: bigint;
        resultRowCount: bigint;
        distinctResultIdentityCount: bigint;
        populationWithoutResultCount: bigint;
        openSegmentCount: bigint;
        blockedResultCount: bigint;
      }>
    >`
      SELECT
        (SELECT COUNT(*) FROM "ActivityParticipationIdentity" i
          WHERE i."activityId" = ${activityId} AND i."populationIncluded" = true
        ) AS "populationCount",
        (SELECT COUNT(*) FROM "ParticipantSettlementResultRevision" r
          WHERE r."settlementVersionId" = ${draftVersionId}
        ) AS "resultRowCount",
        (SELECT COUNT(DISTINCT r."participationIdentityId")
           FROM "ParticipantSettlementResultRevision" r
          WHERE r."settlementVersionId" = ${draftVersionId}
        ) AS "distinctResultIdentityCount",
        -- ⭐ 未决:人口里有他、结果表里没有他。第二刀「不写行表达未决」的执行位。
        (SELECT COUNT(*) FROM "ActivityParticipationIdentity" i
          WHERE i."activityId" = ${activityId} AND i."populationIncluded" = true
            AND NOT EXISTS (
              SELECT 1 FROM "ParticipantSettlementResultRevision" r
               WHERE r."settlementVersionId" = ${draftVersionId}
                 AND r."participationIdentityId" = i.id
            )
        ) AS "populationWithoutResultCount",
        -- 开放 segment:当前(非 superseded)且没有签退时刻的服务段。
        (SELECT COUNT(*) FROM "ParticipantServiceSegmentRevision" s
           JOIN "ActivityParticipationIdentity" i ON i.id = s."participationIdentityId"
          WHERE i."activityId" = ${activityId} AND i."populationIncluded" = true
            AND s."statusCode" <> 'superseded'
            AND s."checkOutAt" IS NULL
        ) AS "openSegmentCount",
        -- missing rule:第二刀把 blocker 写在 exceptionFlagsJson.blockers 数组里。
        -- 用 jsonb_array_length 判"非空数组";字段缺失/为 null 时该子句求值成 NULL,
        -- 被 WHERE 当作不满足 —— 这里是**放行方向**,与"有 blocker 才拦"同向,
        -- 不会因 NULL 静默漏拦。
        (SELECT COUNT(*) FROM "ParticipantSettlementResultRevision" r
          WHERE r."settlementVersionId" = ${draftVersionId}
            AND jsonb_typeof(r."exceptionFlagsJson" -> 'blockers') = 'array'
            AND jsonb_array_length(r."exceptionFlagsJson" -> 'blockers') > 0
        ) AS "blockedResultCount"
    `;
    const row = rows[0];
    /* istanbul ignore next -- 单行聚合恒返回一行;拿不到只可能是 SQL 被改坏 */
    if (row === undefined) throw new BizException(BizCode.SETTLEMENT_SUBMIT_RUN_STATUS_INVALID);
    return {
      populationCount: Number(row.populationCount),
      resultRowCount: Number(row.resultRowCount),
      distinctResultIdentityCount: Number(row.distinctResultIdentityCount),
      populationWithoutResultCount: Number(row.populationWithoutResultCount),
      openSegmentCount: Number(row.openSegmentCount),
      blockedResultCount: Number(row.blockedResultCount),
    };
  }

  // ===== §5.10 ⑤:canonical contentHash =====
  //
  // 只读**被冻结的那些列**:逐人结果 + 版本头。排序键固定为 identityId,
  // 与 canonical 序列化(递归排 key)一起保证"同样的事实 ⇒ 同一个 hash"。
  private async computeContentHash(
    tx: PrismaTx,
    input: {
      activityId: string;
      settlementRunId: string;
      draftVersionId: string;
      evidenceSealId: string;
      sealRevision: number;
      draft: DraftVersionRow;
    },
  ): Promise<string> {
    const rows = await tx.participantSettlementResultRevision.findMany({
      where: { settlementVersionId: input.draftVersionId },
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
      // 稳定序:hash 的可复现性依赖它(canonicalize 对**数组保序**)。
      orderBy: { participationIdentityId: 'asc' },
    });

    const items: SettlementContentItem[] = rows.map((row) => ({
      participationIdentityId: row.participationIdentityId,
      resultCode: row.resultCode,
      lateFlag: row.lateFlag,
      earlyLeaveFlag: row.earlyLeaveFlag,
      exceptionFlags: (row.exceptionFlagsJson ?? null) as CanonicalValue,
      // 🔴 四个小数列一律经 decimalToCanonicalString 变成定标度文本 ——
      //    `Number(decimal)` 那条路被 SettlementContentItem 的 string 类型挡在门外。
      recognizedServiceHours: decimalToCanonicalString(row.recognizedServiceHours),
      recognizedContributionPoints: decimalToCanonicalString(row.recognizedContributionPoints),
      calculatedServiceHours: decimalToCanonicalString(row.calculatedServiceHours),
      calculatedContributionPoints: decimalToCanonicalString(row.calculatedContributionPoints),
      adjustmentReason: row.adjustmentReason,
    }));

    return computeSettlementContentHash({
      schemaVersion: SETTLEMENT_CONTENT_SCHEMA_VERSION,
      activityId: input.activityId,
      settlementRunId: input.settlementRunId,
      evidenceSealId: input.evidenceSealId,
      sealRevision: input.sealRevision,
      evidenceRevision: input.draft.evidenceRevision,
      populationRevision: input.draft.populationRevision,
      workflowRevision: input.draft.workflowRevision,
      personCount: input.draft.personCount,
      sessionParticipationCount: input.draft.sessionParticipationCount,
      serviceSegmentCount: input.draft.serviceSegmentCount,
      items,
    });
  }

  // ===== §5.10 ⑥:operationKey + requestHash 防重 =====
  //
  // ⚠️ DB 上 `operationKey` **没有 unique**(§3.19 只给 ReviewAction 点了 unique)。
  //    防重的正确性来自 **run 行锁**:同一条 run 上的并发提交在 `lockRun` 处串行,
  //    所以"先查后写"之间不存在别的写者。
  //
  // ⚠️ 查询**不按 run 收窄**:同一个 operationKey 被用在**另一条 run** 上,同样算撞键。
  //    收窄成 `(runId, operationKey)` 就退化成第 1 批实测过的那个坑 ——
  //    复合唯一恰好放行"同 key 不同 payload"。宁可多拒。
  private async resolveIdempotency(
    tx: PrismaTx,
    input: { settlementRunId: string; operationKey: string; requestHash: string },
  ): Promise<{ id: string; version: number; priorVersionId: string | null } | null> {
    const existing = await tx.attendanceSettlementVersion.findFirst({
      where: { operationKey: input.operationKey },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        priorVersionId: true,
        requestHash: true,
        settlementRunId: true,
      },
    });
    if (existing === null) return null;
    if (
      existing.requestHash !== input.requestHash ||
      existing.settlementRunId !== input.settlementRunId
    ) {
      throw new BizException(BizCode.SETTLEMENT_SUBMIT_OPERATION_KEY_CONFLICT);
    }
    return {
      id: existing.id,
      version: existing.version,
      priorVersionId: existing.priorVersionId,
    };
  }

  // ===== §5.10 ⑦:结果行固化。**一条 SQL,bind 参数恒为 2** =====
  //
  // 见文件头「DoD 6」。`id` 由 DB 侧 `gen_random_uuid()` 生成:本表 `id` 的
  // `@default(cuid())` 是 **Prisma 应用层**默认值,列上没有 DB 默认 ⇒ 不经 Prisma 的
  // 插入必须自带值。id 只作主键、不承载语义,两种形状共存没有消费方依赖。
  //
  // `updatedAt` 同理(Prisma 的 `@updatedAt` 也是应用层的),显式给 `CURRENT_TIMESTAMP`。
  //
  // 列映射里两处**有意为之**:
  //   - `revision = src.revision + 1` 配合 `baseResultRevisionId = src.id`,
  //     把"提交版本的这条结果由草稿的那条固化而来"串成链(§3.20 的 revision 语义);
  //   - `statusCode` 原样拷贝(草稿行是 `draft`)。§3.20 的三值闭集
  //     `draft/committed/superseded` 讲的是**账本是否已入账**,不是审核阶段 ——
  //     审核阶段落在版本行的 `statusCode` 上。见报告「与合同的偏离」。
  private async copyResultRows(
    tx: PrismaTx,
    draftVersionId: string,
    targetVersionId: string,
  ): Promise<number> {
    const columns = Prisma.raw(RESULT_ROW_TARGET_COLUMNS.map((name) => `"${name}"`).join(', '));
    return await tx.$executeRaw`
      INSERT INTO "ParticipantSettlementResultRevision" (${columns})
      SELECT
        gen_random_uuid()::text,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP,
        ${targetVersionId},
        src."participationIdentityId",
        src."revision" + 1,
        src."resultCode",
        src."lateFlag",
        src."earlyLeaveFlag",
        src."exceptionFlagsJson",
        src."recognizedServiceHours",
        src."recognizedContributionPoints",
        src."calculatedServiceHours",
        src."calculatedContributionPoints",
        src."adjustmentReason",
        src."statusCode",
        src."id",
        src."correctionRequestId"
      FROM "ParticipantSettlementResultRevision" src
      WHERE src."settlementVersionId" = ${draftVersionId}
    `;
  }

  /** 活动当前 active owner 的 memberId(通知收件人;没有则 null)。 */
  private async readOwnerMemberId(tx: PrismaTx, activityId: string): Promise<string | null> {
    const owner = await tx.activityResponsibilityAssignment.findFirst({
      where: { activityId, responsibilityType: 'owner', status: 'active' },
      orderBy: { startedAt: 'desc' },
      select: { memberId: true },
    });
    return owner?.memberId ?? null;
  }

  async submit(
    input: SettlementSubmitInput,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<SettlementSubmitResult> {
    // 活动 v1.1 单一 cutover gate(合同 §16.2):闸未开时本实例仍按旧口径结算,
    // 新结算真相链禁止落库 —— 否则就是合同点名禁止的「新打卡＋旧结算」混合态。
    this.activityWorkflowGate.assertV11WriteAllowed();
    const { activityId, operationKey, requestHash } = input;
    return await this.prisma.$transaction(
      async (tx) => {
        // ①② 锁序固定,不得倒置。`lockRun` 只加锁不判状态 —— 状态判定见下。
        const activity = await this.lockActivity(tx, activityId);
        const run = await this.lockRun(tx, activityId);

        // ⑥ 幂等**排在状态闸之前**,这一点很容易写反:
        //    重放请求打过来时,run 早已被第一次提交推到 `pending_first_review`。
        //    先判"只有 drafting 能提交"就会把一次合法重放判成非法 —— 而重放正是
        //    幂等要保护的那种请求(客户端超时后原样重发)。
        //    重放也**不再跑五条校验**:它要的是"把上次那个版本原样返回",不是
        //    "拿现在的事实重验一遍"——现在的事实可能已经变了,那不影响
        //    "上次提交过什么"这个既成事实。
        const replay = await this.resolveIdempotency(tx, {
          settlementRunId: run.id,
          operationKey,
          requestHash,
        });
        if (replay !== null) {
          const replayed = await tx.attendanceSettlementVersion.findUniqueOrThrow({
            where: { id: replay.id },
            select: {
              contentHash: true,
              evidenceSealId: true,
              personCount: true,
              sessionParticipationCount: true,
              serviceSegmentCount: true,
              evidenceRevision: true,
              populationRevision: true,
              workflowRevision: true,
              evidenceSeal: { select: { sealRevision: true } },
            },
          });
          const resultRowCount = await tx.participantSettlementResultRevision.count({
            where: { settlementVersionId: replay.id },
          });
          // 重放路径**不要求**当前还存在草稿版本(退回/重生成后它可能已换过一版),
          // 所以这里是可空查询,不是 `readDraftVersion` 那条会抛 DRAFT_MISSING 的路。
          const currentDraft = await tx.attendanceSettlementVersion.findFirst({
            where: { settlementRunId: run.id, statusCode: 'draft' },
            orderBy: { version: 'desc' },
            select: { id: true },
          });
          await this.audit.log({
            activityId,
            settlementRunId: run.id,
            settlementVersionId: replay.id,
            settlementVersion: replay.version,
            priorVersionId: replay.priorVersionId,
            draftVersionId: currentDraft?.id ?? null,
            evidenceSealId: replayed.evidenceSealId,
            sealRevision: replayed.evidenceSeal.sealRevision,
            evidenceRevision: replayed.evidenceRevision,
            populationRevision: replayed.populationRevision,
            workflowRevision: replayed.workflowRevision,
            personCount: replayed.personCount,
            sessionParticipationCount: replayed.sessionParticipationCount,
            serviceSegmentCount: replayed.serviceSegmentCount,
            resultRowCount,
            contentHash: replayed.contentHash,
            operationKey,
            requestHash,
            replayed: true,
            actorUserId: currentUser.id,
            actorRoleSnap: currentUser.role,
            auditMeta,
            tx,
          });
          return {
            activityId,
            settlementRunId: run.id,
            settlementVersionId: replay.id,
            settlementVersion: replay.version,
            priorVersionId: replay.priorVersionId,
            draftVersionId: currentDraft?.id ?? null,
            evidenceSealId: replayed.evidenceSealId,
            sealRevision: replayed.evidenceSeal.sealRevision,
            personCount: replayed.personCount,
            sessionParticipationCount: replayed.sessionParticipationCount,
            serviceSegmentCount: replayed.serviceSegmentCount,
            resultRowCount,
            contentHash: replayed.contentHash,
            replayed: true,
          };
        }

        // 不是重放 ⇒ 这是一次**真正的新提交**,状态闸在这里落下。
        this.assertRunDrafting(run);
        const draft = await this.readDraftVersion(tx, run.id);

        // ③ EvidenceSeal 复验。
        const seal = await this.recheckEvidenceSeal(
          tx,
          activityId,
          draft,
          activity.workflowRevision,
        );

        // §6.14 HTTP 版本锚点。必须在既有 Activity → Run 锁和幂等重放之后,并且使用
        // 本事务刚读到的 draft / active seal 比对:Controller 锁外预查在这里不能替代。
        // 两项缺省时不进入分支，既有内部调用的语义与查询/写入序列保持不变。
        if (
          input.expectedDraftVersion !== undefined &&
          draft.version !== input.expectedDraftVersion
        ) {
          throw new BizException(BizCode.SETTLEMENT_SUBMIT_EXPECTED_DRAFT_VERSION_MISMATCH);
        }
        if (
          input.expectedEvidenceSealId !== undefined &&
          seal.id !== input.expectedEvidenceSealId
        ) {
          throw new BizException(BizCode.SETTLEMENT_SUBMIT_EXPECTED_EVIDENCE_SEAL_MISMATCH);
        }

        // ④ 五条校验。任一不过 ⇒ 具名码拒绝,整个事务回滚(零副作用)。
        const facts = await this.readSubmissionFacts(tx, activityId, draft.id);
        const rejection = validateSettlementSubmission(facts);
        if (rejection !== null) throw new BizException(REJECTION_TO_BIZ_CODE[rejection]);

        // ⑤ canonical contentHash。
        const contentHash = await this.computeContentHash(tx, {
          activityId,
          settlementRunId: run.id,
          draftVersionId: draft.id,
          evidenceSealId: seal.id,
          sealRevision: seal.sealRevision,
          draft,
        });

        // ⑦ 写不可变版本 + 结果行快照。
        //
        // `priorVersionId` 串**提交链**:上一个已提交/已退回/已批准的版本(不是草稿)。
        const priorSubmitted = await tx.attendanceSettlementVersion.findFirst({
          where: {
            settlementRunId: run.id,
            statusCode: { in: ['submitted', 'returned', 'approved'] },
          },
          orderBy: { version: 'desc' },
          select: { id: true },
        });
        const maxVersion = await tx.attendanceSettlementVersion.aggregate({
          where: { settlementRunId: run.id },
          _max: { version: true },
        });
        const settlementVersion = (maxVersion._max.version ?? 0) + 1;

        const created = await this.createSubmittedVersion(tx, {
          settlementRunId: run.id,
          version: settlementVersion,
          evidenceSealId: seal.id,
          draft,
          contentHash,
          createdByUserId: currentUser.id,
          priorVersionId: priorSubmitted?.id ?? null,
          operationKey,
          requestHash,
        });

        const resultRowCount = await this.copyResultRows(tx, draft.id, created.id);
        // 固化的行数必须与刚刚验过的项数逐一对上 —— 对不上说明"验的"和"写的"不是
        // 同一批事实(例如有并发绕过锁改了草稿)。fail-closed,不留一个半截版本。
        if (resultRowCount !== facts.resultRowCount) {
          throw new BizException(BizCode.SETTLEMENT_SUBMIT_ITEM_COUNT_MISMATCH);
        }

        // ⑧ 更新 run 指针与状态。
        //
        // 目标态取 `pending_first_review` 而不是 `submitted`:§5.10 ⑨ 要求同事务
        // 「写 Review 待办」,而合同没有给"待办"另立一张表 —— §3.19 明写 run 的
        // statusCode「是页面投影和流程根」,所以**一审待办就是这个状态本身**。
        // 停在 `submitted` 会让待办没有任何机器可见的落点。
        await tx.attendanceSettlementRun.update({
          where: { id: run.id },
          data: {
            statusCode: 'pending_first_review',
            currentSubmittedVersion: settlementVersion,
            version: { increment: 1 },
          },
        });

        // ⑨ 通知 intent —— **必须在本事务内**(本仓 Outbox 铁律)。
        await this.notifications.enqueueSubmitted(tx, {
          activityId,
          activityTitle: activity.title,
          settlementVersionId: created.id,
          settlementVersion,
          personCount: draft.personCount,
          cohort: await freezeResponsibility(tx, {
            cohortKey: `settlement-submit:${created.id}`,
            aggregateType: 'activity',
            aggregateIds: [activityId],
            basisRef: [`settlementVersion:${created.id}`],
            memberIds: [await this.readOwnerMemberId(tx, activityId)],
            // 列可空,但本路径上一步刚显式写过它;`?? new Date()` 只是类型收敛的兜底,
            // 实际取不到 null。冻结是否成立取决于 `cohortKey`(纯 versionId,确定性),
            // 不取决于这个时刻 —— 重放时快照是回读的,这里根本不会被用到。
            at: created.submittedAt ?? new Date(),
          }),
        });

        await this.audit.log({
          activityId,
          settlementRunId: run.id,
          settlementVersionId: created.id,
          settlementVersion,
          priorVersionId: priorSubmitted?.id ?? null,
          draftVersionId: draft.id,
          evidenceSealId: seal.id,
          sealRevision: seal.sealRevision,
          evidenceRevision: draft.evidenceRevision,
          populationRevision: draft.populationRevision,
          workflowRevision: draft.workflowRevision,
          personCount: draft.personCount,
          sessionParticipationCount: draft.sessionParticipationCount,
          serviceSegmentCount: draft.serviceSegmentCount,
          resultRowCount,
          contentHash,
          operationKey,
          requestHash,
          replayed: false,
          actorUserId: currentUser.id,
          actorRoleSnap: currentUser.role,
          auditMeta,
          tx,
        });

        return {
          activityId,
          settlementRunId: run.id,
          settlementVersionId: created.id,
          settlementVersion,
          priorVersionId: priorSubmitted?.id ?? null,
          draftVersionId: draft.id,
          evidenceSealId: seal.id,
          sealRevision: seal.sealRevision,
          personCount: draft.personCount,
          sessionParticipationCount: draft.sessionParticipationCount,
          serviceSegmentCount: draft.serviceSegmentCount,
          resultRowCount,
          contentHash,
          replayed: false,
        };
      },
      { timeout: SETTLEMENT_SUBMIT_TX_TIMEOUT_MS },
    );
  }

  // 版本行的写入单独成方法:P2002 在这里翻成具名业务码。
  //
  // ⚠️ 本表能撞的唯一约束只有 `(settlementRunId, version)`(operationKey 上没有
  //    unique)。持有 run 行锁时并发写不到同一个 version,所以这条**正常不可达** ——
  //    但"Prisma 异常裸奔成 500"是明令禁止的形态,兜底不能省。
  private async createSubmittedVersion(
    tx: PrismaTx,
    input: {
      settlementRunId: string;
      version: number;
      evidenceSealId: string;
      draft: DraftVersionRow;
      contentHash: string;
      createdByUserId: string;
      priorVersionId: string | null;
      operationKey: string;
      requestHash: string;
    },
    // `submittedAt` 一并回读:收件人冻结的「计算时刻」要与这一行**同源**,
    // 不能在 enqueue 处另取一次墙钟(#1075 时间权威统一)。纯加法 select,不改写入。
  ): Promise<{ id: string; submittedAt: Date | null }> {
    try {
      return await tx.attendanceSettlementVersion.create({
        data: {
          settlementRunId: input.settlementRunId,
          version: input.version,
          evidenceSealId: input.evidenceSealId,
          evidenceRevision: input.draft.evidenceRevision,
          populationRevision: input.draft.populationRevision,
          workflowRevision: input.draft.workflowRevision,
          contentHash: input.contentHash,
          personCount: input.draft.personCount,
          sessionParticipationCount: input.draft.sessionParticipationCount,
          serviceSegmentCount: input.draft.serviceSegmentCount,
          createdByUserId: input.createdByUserId,
          submittedAt: new Date(),
          statusCode: 'submitted',
          priorVersionId: input.priorVersionId,
          operationKey: input.operationKey,
          requestHash: input.requestHash,
        },
        select: { id: true, submittedAt: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BizException(BizCode.SETTLEMENT_SUBMIT_OPERATION_KEY_CONFLICT);
      }
      throw error;
    }
  }
}
