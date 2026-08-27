import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { beijingDateOnly } from '../../common/datetime/date-only.util';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { runMemberLinearizedTransaction } from '../../common/prisma/member-advisory-lock.util';
import { PrismaService } from '../../database/prisma.service';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ATTENDANCE_SHEET_STATUS } from '../attendances/attendances.dto';
import { LedgerPostingService, type LedgerCommitResult } from './ledger-posting.service';
import {
  LEDGER_BASELINE_PAYLOAD_KEY,
  LEDGER_PREPARE_JOB_TYPE,
  ledgerBaselineDigest,
  ledgerBaselineKey,
  ledgerBaselineValue,
  toDateOnlyText,
  type LedgerDayStateBaseline,
} from './ledger-preparation.service';
import { allocateDailyCredit, decimalToHundredths, fromHundredths } from './ledger-day-allocation';
import {
  computeSettlementContentHash,
  decimalToCanonicalString,
  SETTLEMENT_CONTENT_SCHEMA_VERSION,
  type SettlementContentItem,
} from './settlement-content-hash';

/**
 * 存量考勤账本化转换刀(P1-28 第 7 批② A 案,2026-08-27 维护者拍板;施工依据
 * `docs/ai-harness/LEGACY_LEDGER_CONVERSION_DRAFT.md`,签收记录见其 §0.1)。
 *
 * 做一件事:把「旧考勤链已终审(approved)」的存量,合成为 v1.1 事实链并提交**真**
 * `LedgerPostingBatch` —— 使 §16.3 开闸后的 committed 读面里,老队员的数字不归零。
 *
 * ── 执行窗口(判闸位 `assertLegacyLedgerConversionAllowed`,20159)───────────
 * 唯一放行态 = 只读维护窗(停旧写之后、开闸之前)。本服务**不提供 HTTP 入口**,
 * 唯一调用方是 `scripts/legacy-ledger-conversion.ts`(维护者 SOP 执行)与 e2e 判据。
 *
 * ── 每活动一棵事实链(全部同事务,顺序 = FK 依赖序)────────────────────────
 *   EvidenceSeal(合成,证据集为空,D3)→ SettlementRun(posting,直建)→
 *   SettlementVersion(number 1,approved,直建)→ resultRevision('draft',
 *   recognized=calculated=旧值,commit 协议统一翻 committed)→
 *   D2 报名头(仅缺头者;§3.6 sourceCode 闭集内取 'admin',不自行扩 CHECK,
 *   名单由本服务返回值点名、SOP 导出留档)→ identity(D1 场次映射:checkInAt 落窗,
 *   零窗兜底最早 scheduled 场并逐条上报)→ day 行 + 分录(与第五刀/第七刀同一形状,
 *   credited 走既有 `allocateDailyCredit`,日封顶 3)→ prepare job(baseline 原格式)→
 *   批次 ready → `commitConvertedBatchWithin`(复用第五刀协议体:day-state、run posted、
 *   审计照写;唯一差异 = 不发 settlement-posted 通知,理由见该方法头注)。
 *
 * ── 幂等(D5)─────────────────────────────────────────────────────────────
 * `requestKey = legacy-conversion:<activityId>` 单列 unique:重跑命中即返回
 * `already-converted`,不写第二遍。分录侧另有 entryKey 单列 unique 兜底。
 *
 * ── 不做(见施工依据「禁止域」)───────────────────────────────────────────
 * 不改 AttendanceRecord / AttendanceSheet 任何既有列;不触碰 team-join;
 * 已有 v1.1 run 的活动一律 `skipped-new-chain-history`,不与运行时结算链混合。
 */

/** D1 场次映射结果:checkInAt 不落在任何 live 场次时间窗内 ⇒ 兜底到最早场并点名。 */
export interface FallbackSessionMapping {
  readonly memberId: string;
  readonly recordId: string;
  readonly checkInAt: Date;
  readonly sessionId: string;
}

interface ConvertedDayRow {
  readonly resultRevisionId: string;
  readonly sessionId: string;
  readonly identityId: string;
  readonly memberId: string;
  readonly ledgerDate: string;
  readonly serviceHours: Prisma.Decimal;
  readonly recognizedPoints: Prisma.Decimal;
  creditedPoints: Prisma.Decimal;
  cappedOutPoints: Prisma.Decimal;
  readonly sequenceStartAt: Date;
  readonly stableOrderKey: string;
}

export type LegacyLedgerConversionOutcome =
  | {
      readonly status: 'converted';
      readonly activityId: string;
      readonly postingBatchId: string;
      readonly memberCount: number;
      readonly identityCount: number;
      readonly entryCount: number;
      readonly dayRowCount: number;
      readonly synthesizedRegistrationHeads: readonly string[];
      readonly fallbackSessionMappings: readonly FallbackSessionMapping[];
      readonly commit: LedgerCommitResult;
    }
  | {
      readonly status: 'already-converted' | 'nothing-to-convert' | 'skipped-new-chain-history';
      readonly activityId: string;
      readonly detail: string;
    };

const CONVERSION_REQUEST_KEY_PREFIX = 'legacy-conversion:';

function conversionRequestKey(activityId: string): string {
  return `${CONVERSION_REQUEST_KEY_PREFIX}${activityId}`;
}

@Injectable()
export class LegacyLedgerConversionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gate: ActivityWorkflowGate,
    private readonly ledgerPosting: LedgerPostingService,
  ) {}

  async convertActivity(args: {
    activityId: string;
    currentUser: CurrentUserPayload;
    auditMeta: AuditMeta;
  }): Promise<LegacyLedgerConversionOutcome> {
    this.gate.assertLegacyLedgerConversionAllowed();
    // 沿更正应用同款事务外壳:ReadCommitted + 有界锁等待 —— commit 协议内部会取
    // 恒串行闸与 member advisory 锁,脱离这层外壳它们就落在默认隔离级别上。
    return await runMemberLinearizedTransaction(this.prisma, async (tx) =>
      this.convertWithin(tx, args),
    );
  }

  private async convertWithin(
    tx: Prisma.TransactionClient,
    args: { activityId: string; currentUser: CurrentUserPayload; auditMeta: AuditMeta },
  ): Promise<LegacyLedgerConversionOutcome> {
    const { activityId, currentUser } = args;

    const existing = await tx.ledgerPostingBatch.findFirst({
      where: { requestKey: conversionRequestKey(activityId) },
      select: { id: true, statusCode: true },
    });
    if (existing !== null) {
      return {
        status: 'already-converted',
        activityId,
        detail: `批次 ${existing.id} 已存在(statusCode=${existing.statusCode}),幂等跳过`,
      };
    }

    const run = await tx.attendanceSettlementRun.findUnique({
      where: { activityId },
      select: { id: true },
    });
    if (run !== null) {
      return {
        status: 'skipped-new-chain-history',
        activityId,
        detail: `活动已有 v1.1 结算 run(${run.id});存量转换只服务无新链历史的活动`,
      };
    }

    const records = await tx.attendanceRecord.findMany({
      where: {
        ...notDeletedWhere({}),
        contributionPoints: { not: null },
        sheet: {
          deletedAt: null,
          activityId,
          statusCode: ATTENDANCE_SHEET_STATUS.APPROVED,
        },
      },
      select: {
        id: true,
        memberId: true,
        checkInAt: true,
        serviceHours: true,
        contributionPoints: true,
        registrationId: true,
        sheet: { select: { submittedAt: true } },
      },
      orderBy: { checkInAt: 'asc' },
    });
    if (records.length === 0) {
      return {
        status: 'nothing-to-convert',
        activityId,
        detail: '无 approved 且未软删、带贡献值的考勤记录',
      };
    }

    const sessions = await tx.activitySession.findMany({
      where: { activityId, deletedAt: null, statusCode: 'scheduled' },
      select: { id: true, startAt: true, endAt: true },
      orderBy: { startAt: 'asc' },
    });
    if (sessions.length === 0) {
      // 旧考勤必有场次承载(发布硬性要求 live session);真出现即数据形态异常,
      // fail-closed 而不是凭空造一个场次。
      throw new BizException(BizCode.LEDGER_COMMIT_BATCH_STATUS_INVALID);
    }

    // ===== D1:场次映射(checkInAt 落窗;零窗兜底最早场并点名)=====
    const fallbacks: FallbackSessionMapping[] = [];
    const mapped = records.map((record) => {
      const hit = sessions.find(
        (session) => record.checkInAt >= session.startAt && record.checkInAt < session.endAt,
      );
      const sessionId = hit?.id ?? sessions[0].id;
      if (hit === undefined) {
        fallbacks.push({
          memberId: record.memberId,
          recordId: record.id,
          checkInAt: record.checkInAt,
          sessionId,
        });
      }
      return { record, sessionId };
    });

    // ===== D2:缺报名头的补「历史转换」头(sourceCode 闭集内取 'admin')=====
    const headIdByMember = new Map<string, string>();
    const synthesizedHeads: string[] = [];
    for (const memberId of new Set(mapped.map((row) => row.record.memberId))) {
      const withRegistration = mapped.find(
        (row) => row.record.memberId === memberId && row.record.registrationId !== null,
      );
      if (withRegistration !== undefined) {
        headIdByMember.set(memberId, withRegistration.record.registrationId as string);
        continue;
      }
      const existingHead = await tx.activityRegistration.findFirst({
        where: { activityId, memberId },
        select: { id: true },
      });
      if (existingHead !== null) {
        headIdByMember.set(memberId, existingHead.id);
        continue;
      }
      const sheetSubmittedAt =
        mapped.find((row) => row.record.memberId === memberId)?.record.sheet.submittedAt ??
        new Date();
      const head = await tx.activityRegistration.create({
        data: {
          activityId,
          memberId,
          statusCode: 'pending',
          currentRevision: 0,
          currentFormVersionId: null,
          statusSummaryCode: 'active',
          sourceCode: 'admin',
          registeredAt: sheetSubmittedAt,
        },
        select: { id: true },
      });
      headIdByMember.set(memberId, head.id);
      synthesizedHeads.push(head.id);
    }

    // ===== identity:按 (member, mappedSession) 找或建(镜像 canonical 初始形状)=====
    const identityIdByMemberSession = new Map<string, string>();
    for (const { record, sessionId } of mapped) {
      const key = `${record.memberId}:${sessionId}`;
      if (identityIdByMemberSession.has(key)) continue;
      const existingIdentity = await tx.activityParticipationIdentity.findFirst({
        where: { activityId, sessionId, memberId: record.memberId },
        select: { id: true },
      });
      const identityId =
        existingIdentity?.id ??
        (
          await tx.activityParticipationIdentity.create({
            data: {
              activityId,
              sessionId,
              registrationId: headIdByMember.get(record.memberId) as string,
              memberId: record.memberId,
              currentRevision: 0,
              currentStatusCode: 'pending',
              currentPositionId: null,
              populationIncluded: false,
              version: 0,
            },
            select: { id: true },
          })
        ).id;
      identityIdByMemberSession.set(key, identityId);
    }

    // ===== 按 (identity, 北京日) 聚合旧值(recognized=calculated=原始和,不重算)=====
    interface DayBucket {
      readonly identityId: string;
      readonly sessionId: string;
      readonly memberId: string;
      readonly dayText: string;
      serviceHours: Prisma.Decimal;
      points: Prisma.Decimal;
      earliestCheckInAt: Date;
    }
    const buckets = new Map<string, DayBucket>();
    for (const { record, sessionId } of mapped) {
      const identityId = identityIdByMemberSession.get(`${record.memberId}:${sessionId}`) as string;
      const dayText = toDateOnlyText(beijingDateOnly(record.checkInAt));
      const key = `${identityId}:${dayText}`;
      const bucket = buckets.get(key);
      if (bucket === undefined) {
        buckets.set(key, {
          identityId,
          sessionId,
          memberId: record.memberId,
          dayText,
          serviceHours: record.serviceHours,
          points: record.contributionPoints as Prisma.Decimal,
          earliestCheckInAt: record.checkInAt,
        });
      } else {
        bucket.serviceHours = bucket.serviceHours.add(record.serviceHours);
        bucket.points = bucket.points.add(record.contributionPoints as Prisma.Decimal);
        if (record.checkInAt < bucket.earliestCheckInAt) {
          bucket.earliestCheckInAt = record.checkInAt;
        }
      }
    }

    const memberIds = [...new Set(mapped.map((row) => row.record.memberId))].sort();
    const identityIds = [...new Set([...identityIdByMemberSession.values()])].sort();
    const identityTotals = new Map<string, { hours: Prisma.Decimal; points: Prisma.Decimal }>();
    for (const bucket of buckets.values()) {
      const total = identityTotals.get(bucket.identityId);
      if (total === undefined) {
        identityTotals.set(bucket.identityId, {
          hours: bucket.serviceHours,
          points: bucket.points,
        });
      } else {
        total.hours = total.hours.add(bucket.serviceHours);
        total.points = total.points.add(bucket.points);
      }
    }

    // ===== D3:合成 EvidenceSeal(证据集为空;sealRevision 按 max+1)=====
    const sealMax = await tx.evidenceSeal.aggregate({
      where: { activityId },
      _max: { sealRevision: true },
    });
    const sealRevision = (sealMax._max.sealRevision ?? 0) + 1;
    const sessionCounts: Record<string, number> = {};
    for (const { sessionId } of mapped) {
      sessionCounts[sessionId] = (sessionCounts[sessionId] ?? 0) + 1;
    }
    const sealContentHash = createHash('sha256')
      .update(`legacy-conversion:${activityId}:${sealRevision}`, 'utf8')
      .digest('hex');
    const seal = await tx.evidenceSeal.create({
      data: {
        activityId,
        sealRevision,
        evidenceRevision: 1,
        populationRevision: 1,
        workflowRevision: 1,
        allWindowsClosedAt: new Date(),
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: memberIds.length,
        populationCountBySession: sessionCounts,
        contentHash: sealContentHash,
        statusCode: 'active',
        sealedByUserId: currentUser.id,
        sealedAt: new Date(),
      },
      select: { id: true },
    });

    // ===== run / version 直建(run 唯一性与 version 编号都已前置核过)=====
    const createdRun = await tx.attendanceSettlementRun.create({
      data: { activityId, statusCode: 'posting', currentSubmittedVersion: 1 },
      select: { id: true },
    });

    const items: SettlementContentItem[] = identityIds.map((identityId) => {
      const totals = identityTotals.get(identityId) ?? {
        hours: new Prisma.Decimal(0),
        points: new Prisma.Decimal(0),
      };
      return {
        participationIdentityId: identityId,
        resultCode: 'present',
        lateFlag: false,
        earlyLeaveFlag: false,
        exceptionFlags: null,
        recognizedServiceHours: decimalToCanonicalString(totals.hours),
        recognizedContributionPoints: decimalToCanonicalString(totals.points),
        calculatedServiceHours: decimalToCanonicalString(totals.hours),
        calculatedContributionPoints: decimalToCanonicalString(totals.points),
        adjustmentReason: null,
      } satisfies SettlementContentItem;
    });
    const contentHash = computeSettlementContentHash({
      schemaVersion: SETTLEMENT_CONTENT_SCHEMA_VERSION,
      activityId,
      settlementRunId: createdRun.id,
      evidenceSealId: seal.id,
      sealRevision,
      evidenceRevision: 1,
      populationRevision: 1,
      workflowRevision: 1,
      personCount: memberIds.length,
      sessionParticipationCount: identityIdByMemberSession.size,
      serviceSegmentCount: 0,
      items,
    });
    const version = await tx.attendanceSettlementVersion.create({
      data: {
        settlementRunId: createdRun.id,
        version: 1,
        evidenceSealId: seal.id,
        evidenceRevision: 1,
        populationRevision: 1,
        workflowRevision: 1,
        contentHash,
        personCount: memberIds.length,
        sessionParticipationCount: identityIdByMemberSession.size,
        serviceSegmentCount: 0,
        statusCode: 'approved',
        submittedAt: new Date(),
      },
      select: { id: true },
    });

    // ===== resultRevision('draft';commit 协议按版本统一翻 committed)=====
    const resultRevisionIdByIdentity = new Map<string, string>();
    for (const identityId of identityIds) {
      const totals = identityTotals.get(identityId) ?? {
        hours: new Prisma.Decimal(0),
        points: new Prisma.Decimal(0),
      };
      const revision = await tx.participantSettlementResultRevision.create({
        data: {
          settlementVersionId: version.id,
          participationIdentityId: identityId,
          revision: 1,
          resultCode: 'present',
          lateFlag: false,
          earlyLeaveFlag: false,
          recognizedServiceHours: totals.hours,
          recognizedContributionPoints: totals.points,
          calculatedServiceHours: totals.hours,
          calculatedContributionPoints: totals.points,
          statusCode: 'draft',
        },
        select: { id: true },
      });
      resultRevisionIdByIdentity.set(identityId, revision.id);
    }

    // ===== 批次直建(镜像更正刀;requestKey 单列 unique = 幂等锚)=====
    const requestHash = createHash('sha256')
      .update(`legacy-conversion:${activityId}:${contentHash}`, 'utf8')
      .digest('hex');
    const batch = await tx.ledgerPostingBatch.create({
      data: {
        settlementRunId: createdRun.id,
        settlementVersionId: version.id,
        batchRevision: 1,
        statusCode: 'preparing',
        requestKey: conversionRequestKey(activityId),
        requestHash,
        totalCount: identityIds.length,
        preparedByUserId: currentUser.id,
      },
      select: { id: true },
    });

    // ===== 日行 + 封顶分账:recognized=原始日和;credited 走既有 allocateDailyCredit
    //       (prior = 该 (member, day) 当前已 committed 的 credited,与更正刀同款)=====
    const dayRows: ConvertedDayRow[] = [...buckets.values()].map((bucket) => ({
      resultRevisionId: resultRevisionIdByIdentity.get(bucket.identityId) as string,
      sessionId: bucket.sessionId,
      identityId: bucket.identityId,
      memberId: bucket.memberId,
      ledgerDate: bucket.dayText,
      serviceHours: bucket.serviceHours,
      recognizedPoints: bucket.points,
      creditedPoints: new Prisma.Decimal(0),
      cappedOutPoints: new Prisma.Decimal(0),
      sequenceStartAt: bucket.earliestCheckInAt,
      stableOrderKey: `${bucket.memberId}:${bucket.dayText}:${bucket.identityId}`,
    }));

    const { baseline, priorCreditedByKey } = await this.readDayStateBaseline(tx, dayRows);
    const byMemberDate = new Map<string, ConvertedDayRow[]>();
    for (const row of dayRows) {
      const key = ledgerBaselineKey(row.memberId, row.ledgerDate);
      const list = byMemberDate.get(key);
      if (list === undefined) byMemberDate.set(key, [row]);
      else list.push(row);
    }
    for (const [key, list] of byMemberDate) {
      const priorHundredths = priorCreditedByKey.get(key) ?? 0;
      const allocations = allocateDailyCredit(
        list.map((row) => ({
          recognizedPoints: Number(row.recognizedPoints.toFixed(2)),
          sequenceStartAt: row.sequenceStartAt,
          stableOrderKey: row.stableOrderKey,
        })),
        fromHundredths(priorHundredths),
      );
      list.forEach((row, index) => {
        row.creditedPoints = new Prisma.Decimal(allocations[index].creditedPoints.toFixed(2));
        row.cappedOutPoints = new Prisma.Decimal(allocations[index].cappedOutPoints.toFixed(2));
      });
    }

    await this.writeDayRows(tx, dayRows);
    const entryCount = await this.writeEntries(tx, batch.id, activityId, requestHash, dayRows);

    // ===== prepare job + ready 翻转(沿用第五刀 baseline 通路,零第二份格式)=====
    const now = new Date();
    await tx.activityBatchJob.create({
      data: {
        jobTypeCode: LEDGER_PREPARE_JOB_TYPE,
        activityId,
        settlementVersionId: version.id,
        postingBatchId: batch.id,
        statusCode: 'succeeded',
        operationKey: `${LEDGER_PREPARE_JOB_TYPE}:${batch.id}`,
        requestHash,
        payloadVersion: 1,
        payload: {
          postingBatchId: batch.id,
          legacyConversion: true,
          [LEDGER_BASELINE_PAYLOAD_KEY]: baseline,
        },
        total: 1,
        succeeded: 1,
        createdByUserId: currentUser.id,
        availableAt: now,
        startedAt: now,
        completedAt: now,
      },
    });
    await tx.ledgerPostingBatch.update({
      where: { id: batch.id },
      data: {
        statusCode: 'ready',
        preparedAt: now,
        preparedCount: identityIds.length,
        baselineJsonHash: ledgerBaselineDigest(baseline),
        version: { increment: 1 },
      },
    });

    const commit = await this.ledgerPosting.commitConvertedBatchWithin(
      tx,
      activityId,
      {
        postingBatchId: batch.id,
        operationKey: `legacy-ledger-conversion:${activityId}`,
      },
      currentUser,
      args.auditMeta,
    );

    return {
      status: 'converted',
      activityId,
      postingBatchId: batch.id,
      memberCount: memberIds.length,
      identityCount: identityIds.length,
      entryCount,
      dayRowCount: dayRows.length,
      synthesizedRegistrationHeads: synthesizedHeads,
      fallbackSessionMappings: fallbacks,
      commit,
    };
  }

  /** 与更正刀 `readDayStateBaseline` 同款:该 (member, day) 当前 committed 基线。 */
  private async readDayStateBaseline(
    tx: Prisma.TransactionClient,
    dayRows: readonly ConvertedDayRow[],
  ): Promise<{ baseline: LedgerDayStateBaseline; priorCreditedByKey: Map<string, number> }> {
    const pairs = new Map<string, { memberId: string; ledgerDate: string }>();
    for (const row of dayRows) {
      pairs.set(ledgerBaselineKey(row.memberId, row.ledgerDate), {
        memberId: row.memberId,
        ledgerDate: row.ledgerDate,
      });
    }
    const baseline: LedgerDayStateBaseline = {};
    const priorCreditedByKey = new Map<string, number>();
    if (pairs.size === 0) return { baseline, priorCreditedByKey };
    const list = [...pairs.values()];
    const existing = await tx.$queryRaw<
      Array<{ memberId: string; ledgerDate: string; version: number; credited: string }>
    >`
      SELECT d."memberId", to_char(d."ledgerDate", 'YYYY-MM-DD') AS "ledgerDate",
             d."version" AS "version", d."committedCreditedPoints"::text AS "credited"
      FROM "MemberContributionDayState" d
      JOIN unnest(
        ${list.map((row) => row.memberId)}::text[],
        ${list.map((row) => row.ledgerDate)}::text[]
      ) AS t(member_id, ledger_date)
        ON d."memberId" = t.member_id AND to_char(d."ledgerDate", 'YYYY-MM-DD') = t.ledger_date
    `;
    for (const row of existing) {
      const key = ledgerBaselineKey(row.memberId, row.ledgerDate);
      const creditedHundredths = decimalToHundredths(row.credited);
      priorCreditedByKey.set(key, creditedHundredths);
      baseline[key] = ledgerBaselineValue(row.version, creditedHundredths);
    }
    // 生效侧判据(assertBaselineIntact)要求 baseline 覆盖本批**全部** (member, day) 键:
    // 尚无 day-state 行的键也必须给缺省 0:0 —— 与第五刀准备侧的形状一致。
    for (const key of pairs.keys()) {
      if (!Object.prototype.hasOwnProperty.call(baseline, key)) {
        baseline[key] = ledgerBaselineValue(0, 0);
      }
    }
    return { baseline, priorCreditedByKey };
  }

  /** 与更正刀 `writeReplacementDays` 同一形状(raw INSERT,unnest 批量)。 */
  private async writeDayRows(
    tx: Prisma.TransactionClient,
    rows: readonly ConvertedDayRow[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await tx.$executeRaw`
      INSERT INTO "ParticipantSettlementDay" (
        "id", "createdAt", "updatedAt", "resultRevisionId", "memberId", "ledgerDate",
        "serviceHours", "recognizedPoints", "creditedPoints", "cappedOutPoints",
        "sequenceStartAt", "stableOrderKey"
      )
      SELECT gen_random_uuid()::text, NOW(), NOW(),
             t.result_revision_id, t.member_id, t.ledger_date::date,
             t.service_hours::numeric, t.recognized_points::numeric,
             t.credited_points::numeric, t.capped_out_points::numeric,
             t.sequence_start_at::timestamptz, t.stable_order_key
      FROM unnest(
        ${rows.map((row) => row.resultRevisionId)}::text[],
        ${rows.map((row) => row.memberId)}::text[],
        ${rows.map((row) => row.ledgerDate)}::text[],
        ${rows.map((row) => row.serviceHours.toFixed(2))}::text[],
        ${rows.map((row) => row.recognizedPoints.toFixed(2))}::text[],
        ${rows.map((row) => row.creditedPoints.toFixed(2))}::text[],
        ${rows.map((row) => row.cappedOutPoints.toFixed(2))}::text[],
        ${rows.map((row) => row.sequenceStartAt.toISOString())}::text[],
        ${rows.map((row) => row.stableOrderKey)}::text[]
      ) AS t(result_revision_id, member_id, ledger_date, service_hours, recognized_points,
             credited_points, capped_out_points, sequence_start_at, stable_order_key)
    `;
  }

  /** 每个 (resultRevision, ledgerDate) 恰两条 credit 分录 —— 协议体 ⑧ 的前置形状。 */
  private async writeEntries(
    tx: Prisma.TransactionClient,
    batchId: string,
    activityId: string,
    requestHash: string,
    rows: readonly ConvertedDayRow[],
  ): Promise<number> {
    const entries = rows.flatMap((row) => [
      {
        ...row,
        entryTypeCode: 'service_credit',
        serviceHoursDelta: row.serviceHours,
        recognizedPointsDelta: new Prisma.Decimal(0),
        creditedPointsDelta: new Prisma.Decimal(0),
        cappedOutPointsDelta: new Prisma.Decimal(0),
      },
      {
        ...row,
        entryTypeCode: 'contribution_credit',
        serviceHoursDelta: new Prisma.Decimal(0),
        recognizedPointsDelta: row.recognizedPoints,
        creditedPointsDelta: row.creditedPoints,
        cappedOutPointsDelta: row.cappedOutPoints,
      },
    ]);
    if (entries.length === 0) return 0;
    const entryKeys = entries.map(
      (entry) => `${batchId}:${entry.resultRevisionId}:${entry.ledgerDate}:${entry.entryTypeCode}`,
    );
    return await tx.$executeRaw`
      INSERT INTO "ParticipationLedgerEntry" (
        "id", "createdAt", "postingBatchId", "entryKey", "operationKey", "requestHash",
        "memberId", "activityId", "sessionId", "participationIdentityId", "resultRevisionId",
        "ledgerDate", "entryTypeCode",
        "serviceHoursDelta", "recognizedPointsDelta", "creditedPointsDelta", "cappedOutPointsDelta"
      )
      SELECT gen_random_uuid()::text, NOW(), ${batchId}, t.entry_key,
             'ledger-prepare:' || t.entry_key, ${requestHash},
             t.member_id, ${activityId}, t.session_id, t.identity_id,
             t.result_revision_id, t.ledger_date::date, t.entry_type,
             t.service_hours::numeric, t.recognized_points::numeric,
             t.credited_points::numeric, t.capped_out_points::numeric
      FROM unnest(
        ${entryKeys}::text[],
        ${entries.map((entry) => entry.memberId)}::text[],
        ${entries.map((entry) => entry.sessionId)}::text[],
        ${entries.map((entry) => entry.identityId)}::text[],
        ${entries.map((entry) => entry.resultRevisionId)}::text[],
        ${entries.map((entry) => entry.ledgerDate)}::text[],
        ${entries.map((entry) => entry.entryTypeCode)}::text[],
        ${entries.map((entry) => entry.serviceHoursDelta.toFixed(2))}::text[],
        ${entries.map((entry) => entry.recognizedPointsDelta.toFixed(2))}::text[],
        ${entries.map((entry) => entry.creditedPointsDelta.toFixed(2))}::text[],
        ${entries.map((entry) => entry.cappedOutPointsDelta.toFixed(2))}::text[]
      ) AS t(entry_key, member_id, session_id, identity_id, result_revision_id, ledger_date,
             entry_type, service_hours, recognized_points, credited_points, capped_out_points)
      ON CONFLICT DO NOTHING
    `;
  }
}
