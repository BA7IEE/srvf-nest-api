import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  lockMembersForWrite,
  runMemberLinearizedTransaction,
} from '../../common/prisma/member-advisory-lock.util';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { LedgerPostingAuditRecorder } from './ledger-posting-audit-recorder';
import {
  evaluateCorrectionPostingShape,
  type CorrectionPostingShapeViolation,
} from './correction-posting-shape';
import {
  ledgerCommitExceedsTotalBudget,
  ledgerCommitRequiredSlots,
  tryAcquireLedgerCommitSlots,
} from './ledger-commit-lock-budget';
import { dayTotalWithinCap, decimalToHundredths, fromHundredths } from './ledger-day-allocation';
import {
  LEDGER_PREPARE_JOB_TYPE,
  ledgerBaselineDigest,
  ledgerBaselineKey,
  ledgerBaselineValue,
  readBaselineFromPayload,
  type LedgerDayStateBaseline,
} from './ledger-preparation.service';
import { SettlementNotificationProducer } from './settlement-notification-producer';
import { freezeResponsibility } from './activity-recipient-freeze';

// ===== 活动改造 v1.1 第 2 批第五刀:§5.13 万人短事务统一生效 =====
//
// 🔴🔴 **这是整个改造里语义最像钱的一段代码。** 本方法返回成功的那一刻,
//    `ParticipationLedgerEntry` 就从"看不见的准备结果"变成队员贡献值的**真值**。
//    它的失败模式**不是报错,是账悄悄错了** —— 部分生效、日合计超限、基线漂移未察觉,
//    每一种都会产出一个看起来完全正常的账本,而维护者看不懂代码、发现不了。
//    因此本文件的每一处判定都走**拒绝**,没有一处走"警告后放行"。
//
// ## 锁序(§5.13 ②,不得倒置)
//
//   ① `Activity` → ② `AttendanceSettlementRun` → ③ `AttendanceSettlementVersion`
//   → ④ `LedgerPostingBatch`
//
// 与前四刀逐字同序,只在末尾**追加**第四把(本刀的并发单位是**批次**)。
// 之后才是队员维度:⑤ 恒串行闸 → ⑥ `lockMembersForWrite` → ⑦ day-state `FOR UPDATE`。
//
// ## ⑤ 恒串行闸放在 member 锁**之前**(顺序是语义的一部分)
//
// 闸的全部意义就是"在把一万把 advisory 锁拿下去之前先问问预算够不够"。
// 放在 `lockMembersForWrite` 之后 = 锁已经拿了,闸只能事后叹气。
// 闸用 `pg_try_advisory_xact_lock`(**非阻塞**)⇒ 它自己不可能出现在死锁环上:
// 一条永不等待的取锁边不构成环。见 `ledger-commit-lock-budget.ts` 文件头。
//
// ## ⑥ member 锁只用既有的那一把
//
// 🔴 调用现有 `lockMembersForWrite(tx, memberIds)`,**不新建 member+date advisory lock**
//    (合同 §0.4 死线 + §3.24 明写「持久化的日版本行,**不是**新的 advisory lock」)。
//    该 util 今日刚修好「排序键 = 锁键」(PR #910),本刀一个字都不改。
//    ⇒ (member, date) 的排他性来自 **member 锁**;day-state 行锁是纵深防御,不是主闸。
//
// ## ⑨ 三条判定的分工(卸掉任意一条,红集互不重叠)
//
//   ⭐ **baseline 记录完整性**(20085):job payload 里的基线明细与批次上的
//      `baselineJsonHash` 摘要必须吻合,且键集必须恰好等于本批次分录覆盖的
//      (member, date) 集合。守的是"准备结果被绕过应用层改动过"。
//   ⭐ **baseline 漂移**(20084):逐条比对准备时的 `(version, 日合计)` 与**此刻**的值。
//      任一变化 ⇒ 整批不 commit。守的是"准备之后世界变了"。
//   ⭐ **日合计 0..3**(20086):§3.24 末句。第 1 批已实测判定它是**跨行**不变量
//      (表级 CHECK 只看单行;trigger 求和在并发下骗人)⇒ 刻意零 DB 执行位,
//      **这里是全仓唯一挡住它的地方**。必须在 member 锁内、`FOR UPDATE` 之后判。
//
// ## 🔴 「零部分生效」是靠什么成立的
//
// 全部判定与全部写入在**同一个** `runMemberLinearizedTransaction` 里。任一判定抛出
// ⇒ Prisma 交互事务整体回滚 ⇒ 批次仍 `ready`、run 仍 `posting`、分录仍不可见、
// day-state 一行未动。**不存在"先写一半再检查"的路径** —— 本文件里没有任何
// 提前 commit 的分段事务(判据:e2e ⑤ 让最后一步抛错,断言全部回滚)。
//
// ## bind 参数上限(第 0 批实测 32767)
//
// 本文件所有与人数相关的读写都写成 `unnest(...)` 或"按 id 集合的父键过滤",
// bind 参数恒为**列数**、与人数无关。唯一例外是既有 `lockMembersForWrite`
// (每人 1 个参数的 `VALUES`)—— 它是只读文件,本刀不改;它给出的硬上限是
// **32767 人**,远高于本刀恒串行闸自己的 10000 人上限(20088 先拦住)。
//
// ## 本刀不做的事
//
// ❌ 零端点 / 零 DTO / 零权限码;❌ 零 schema;❌ 零 Punch 写路径。
// ❌ **不产生任何 reversal**(见文件末尾对 §3.23.5 的声明)。
// ❌ 不写 `SettlementReviewAction`:该表的 `stageCode` / `actionCode` 都是 DB 上的
//    二值闭集(`first|final` / `approve|return`),没有一个值表示"账本已生效";
//    硬塞一条 `final/approve` 还会与第四刀的终审决定重复,破坏 §3.19
//    「一版本一阶段只允许一个生效决定」。⇒ 只写 Audit + NotificationOutbox,
//    这是与 §5.13 ⑦ 的**显式偏离**,已在报告逐条列明。

type PrismaTx = Prisma.TransactionClient;

/**
 * 更正批次的三种配对违例 → 三个具名码(第七刀,§5.14 ④)。
 *
 * **一一对应,没有兜底码** —— 漏一种编译不过。三条各读自己那几个计数,
 * 卸掉任一条只有它对应的用例会红(红集矩阵见第七刀报告)。
 */
const CORRECTION_SHAPE_TO_BIZ_CODE: Record<
  CorrectionPostingShapeViolation,
  (typeof BizCode)[keyof typeof BizCode]
> = {
  replacement_missing: BizCode.CORRECTION_POSTING_REPLACEMENT_MISSING,
  reversal_missing: BizCode.CORRECTION_POSTING_REVERSAL_MISSING,
  reversal_amount_invalid: BizCode.CORRECTION_POSTING_REVERSAL_AMOUNT_INVALID,
};

export interface LedgerCommitInput {
  postingBatchId: string;
  /** 只进 audit 与 outbox eventKey;幂等锚点是 `postingBatchId` 本身(见 biz-code 段注释)。 */
  operationKey: string;
}

export interface LedgerCommitResult {
  postingBatchId: string;
  activityId: string;
  settlementRunId: string;
  settlementVersionId: string;
  settlementVersion: number;
  batchStatus: string;
  runStatus: string;
  /** 本批次覆盖的 distinct 队员数(= 恒串行闸的扣减依据)。 */
  memberCount: number;
  /** 本批次覆盖的 (member, ledgerDate) 对数。 */
  dayStateCount: number;
  entryCount: number;
  committedAt: Date | null;
  /** true = 该批次此前已生效,本次原样返回上一次的结论。 */
  replayed: boolean;
}

interface LockedBatch {
  id: string;
  statusCode: string;
  settlementRunId: string;
  settlementVersionId: string;
  totalCount: number;
  preparedCount: number;
  baselineJsonHash: string | null;
  committedAt: Date | null;
}

interface DayDelta {
  memberId: string;
  ledgerDate: string;
  creditedHundredths: number;
  entryCount: number;
}

interface CurrentDayState {
  version: number;
  creditedHundredths: number;
}

@Injectable()
export class LedgerPostingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: LedgerPostingAuditRecorder,
    private readonly notifications: SettlementNotificationProducer,
  ) {}

  async commitBatch(
    input: LedgerCommitInput,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<LedgerCommitResult> {
    // 锁序要求先锁 Activity,而 activityId 只能从批次读出来。这一次读**不加锁、不判定**,
    // 全部结论都在下面的事务里持锁重读之后才做。
    const anchor = await this.prisma.ledgerPostingBatch.findUnique({
      where: { id: input.postingBatchId },
      select: { settlementRun: { select: { activityId: true } } },
    });
    if (anchor === null) throw new BizException(BizCode.LEDGER_COMMIT_BATCH_STATUS_INVALID);
    const activityId = anchor.settlementRun.activityId;

    return await runMemberLinearizedTransaction(
      this.prisma,
      async (tx) => await this.commitBatchWithin(tx, activityId, input, currentUser, auditMeta),
    );
  }

  /**
   * ⭐ **第七刀(更正应用)复用点** —— 协议体本身,**在调用方的事务里**执行。
   *
   * 🔴 本方法的代码就是原来 `commitBatch` 事务体的**逐字内容**(第七刀只把它从
   *    lambda 抽成方法,一个判定、一条 SQL、一个顺序都没改)。抽出来的理由是硬的:
   *    §5.14 ⑥ 要求「旧 revisions superseded、新 revisions committed、旧 active closure
   *    superseded、`Activity.currentClosureRevision` 清空、correction → applied」
   *    **与本协议同一事务**,而 Prisma 的交互事务**无法从外部加入** ——
   *    先调 `commitBatch` 再另开事务做切换,中间崩溃就会留下"账已生效、旧版本还挂着
   *    current"的读面(同时看到两份真值)。
   *
   * ⚠️ 调用方必须自己开 `runMemberLinearizedTransaction`(本方法内会取 member advisory
   *    lock 与恒串行闸,它们都是**事务级**的,脱离交互事务没有意义)。
   *
   * 判据:第五刀既有 e2e 全绿 —— 那是"抽方法之后行为零变化"的正对照。
   */
  async commitBatchWithin(
    tx: PrismaTx,
    activityId: string,
    input: LedgerCommitInput,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<LedgerCommitResult> {
    {
      // ===== ①②③④ 固定锁序 =====
      const activity = await this.lockActivity(tx, activityId);
      const run = await this.lockRun(tx, activityId);
      const version = await this.lockVersion(tx, run.id);
      const batch = await this.lockBatch(tx, input.postingBatchId);

      // 幂等:批次已生效 ⇒ 原样返回上一次的结论(不是错误,也不再写第二遍)。
      if (batch.statusCode === 'committed') {
        return await this.replayResult(tx, activityId, run, version, batch);
      }

      // ===== 状态闸(三条各判各的)=====
      if (batch.statusCode !== 'ready') {
        throw new BizException(BizCode.LEDGER_COMMIT_BATCH_STATUS_INVALID);
      }
      if (batch.settlementVersionId !== version.id || batch.settlementRunId !== run.id) {
        throw new BizException(BizCode.LEDGER_COMMIT_BATCH_STATUS_INVALID);
      }
      // §5.11:终审通过把 run 推到 `posting`,`posted` 是本刀成功之后才有的状态。
      if (run.statusCode !== 'posting') {
        throw new BizException(BizCode.LEDGER_COMMIT_RUN_STATUS_INVALID);
      }
      if (version.statusCode !== 'approved') {
        throw new BizException(BizCode.LEDGER_COMMIT_VERSION_STATUS_INVALID);
      }
      // §3.22「一个 SettlementVersion 至多一个 committed posting batch」的锁后具名版本。
      await this.assertNoOtherCommittedBatch(tx, version.id, batch.id);

      // ===== 分录集合复核(§5.12 ⑧ 的生效侧复验)=====
      const deltas = await this.readBatchDayDeltas(tx, batch.id);
      await this.assertPreparedSetConsistent(tx, batch, version.id, deltas);

      const memberIds = [...new Set(deltas.map((row) => row.memberId))].sort();
      // AC-058:不能只锁有账本分录的人。零积分/零时长成员仍可能有一条即将正式生效的
      // 服务段;若漏锁,两个活动可同时通过 read-before-write。先把本活动全部待生效段的
      // memberId 纳入同一把既有 member lock,再在锁内重读其他活动的 committed 段。
      const segmentMemberIds = await this.readDraftSegmentMemberIds(tx, activityId);
      const lockedMemberIds = [...new Set([...memberIds, ...segmentMemberIds])].sort();

      // ===== ⑤ ⭐ 恒串行闸(维护者 2026-08-04 拍板)—— 必须在 member 锁之前 =====
      await this.acquireCommitBudget(tx, lockedMemberIds.length);

      // ===== ⑥ member advisory lock(既有 util,本刀不改)=====
      await lockMembersForWrite(tx, lockedMemberIds);
      await this.assertNoCrossActivitySegmentOverlap(tx, activityId);

      // ===== ⑦ day-state:缺行补齐 + 按 (memberId, ledgerDate) 排序 FOR UPDATE =====
      await this.createMissingDayStates(tx, deltas);
      const current = await this.lockDayStates(tx, deltas);

      // ===== ⑧ ⭐ baseline 比对(记录完整性 + 漂移),整批一致才继续 =====
      const baseline = await this.readPreparedBaseline(tx, batch);
      this.assertBaselineIntact(baseline, batch, deltas);
      this.assertBaselineUnchanged(baseline, deltas, current);

      // ===== ⑨ ⭐ 日合计 0..3(§3.24;member 锁内、FOR UPDATE 之后)=====
      this.assertDailyCapRespected(deltas, current);

      // ===== ⑩ 原子切换:以下全部在同一事务内 =====
      const now = new Date();
      await this.advanceDayStates(tx, batch.id, deltas);
      const entryCount = deltas.reduce((sum, row) => sum + row.entryCount, 0);

      await tx.ledgerPostingBatch.update({
        where: { id: batch.id },
        data: {
          statusCode: 'committed',
          committedAt: now,
          committedByUserId: currentUser.id,
          version: { increment: 1 },
        },
      });
      await tx.attendanceSettlementRun.update({
        where: { id: run.id },
        data: {
          statusCode: 'posted',
          currentPostedVersion: version.version,
          version: { increment: 1 },
        },
      });
      // §5.13 ⑦「result/segment revisions 改 committed」。
      // 两条都按**父键**过滤(1-2 个 bind),不列 id 集合 ⇒ 与人数无关。
      await tx.$executeRaw`
        UPDATE "ParticipantSettlementResultRevision"
        SET "statusCode" = 'committed', "updatedAt" = NOW()
        WHERE "settlementVersionId" = ${version.id} AND "statusCode" = 'draft'
      `;
      await tx.$executeRaw`
        UPDATE "ParticipantServiceSegmentRevision" AS s
        SET "statusCode" = 'committed', "effectiveBatchId" = ${batch.id}, "updatedAt" = NOW()
        FROM "ActivityParticipationIdentity" i
        WHERE s."participationIdentityId" = i.id
          AND i."activityId" = ${activityId}
          AND s."statusCode" = 'draft'
      `;

      const result: LedgerCommitResult = {
        postingBatchId: batch.id,
        activityId,
        settlementRunId: run.id,
        settlementVersionId: version.id,
        settlementVersion: version.version,
        batchStatus: 'committed',
        runStatus: 'posted',
        memberCount: memberIds.length,
        dayStateCount: deltas.length,
        entryCount,
        committedAt: now,
        replayed: false,
      };

      // ⑪ 通知 intent —— **必须在本事务内**(本仓 Outbox 铁律)。
      await this.notifications.enqueuePosted(tx, {
        activityId,
        activityTitle: activity.title,
        settlementVersionId: version.id,
        settlementVersion: version.version,
        postingBatchId: batch.id,
        memberCount: memberIds.length,
        cohort: await freezeResponsibility(tx, {
          cohortKey: `settlement-ledger-commit:${batch.id}`,
          aggregateType: 'activity',
          aggregateIds: [activityId],
          basisRef: [`postingBatch:${batch.id}`],
          memberIds: [await this.readOwnerMemberId(tx, activityId)],
          at: now,
        }),
      });

      // ⑫ audit —— 刻意放**最后一步**:它是 DoD「原子切换」那条判据的落点
      //    (e2e 让它抛错,断言上面全部回滚)。
      await this.audit.log({
        ...result,
        operationKey: input.operationKey,
        baselineJsonHash: batch.baselineJsonHash,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        auditMeta,
        tx,
      });

      return result;
    }
  }

  // ===== 锁序四把 =========================================================

  private async lockActivity(tx: PrismaTx, activityId: string): Promise<{ title: string }> {
    const rows = await tx.$queryRaw<Array<{ title: string }>>`
      SELECT title
      FROM "Activity"
      WHERE id = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return row;
  }

  private async lockRun(
    tx: PrismaTx,
    activityId: string,
  ): Promise<{ id: string; statusCode: string; currentSubmittedVersion: number | null }> {
    const rows = await tx.$queryRaw<
      Array<{ id: string; statusCode: string; currentSubmittedVersion: number | null }>
    >`
      SELECT id, "statusCode", "currentSubmittedVersion"
      FROM "AttendanceSettlementRun"
      WHERE "activityId" = ${activityId}
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) throw new BizException(BizCode.LEDGER_COMMIT_RUN_STATUS_INVALID);
    return row;
  }

  private async lockVersion(
    tx: PrismaTx,
    settlementRunId: string,
  ): Promise<{ id: string; version: number; statusCode: string }> {
    const rows = await tx.$queryRaw<Array<{ id: string; version: number; statusCode: string }>>`
      SELECT v.id, v.version, v."statusCode"
      FROM "AttendanceSettlementVersion" v
      JOIN "AttendanceSettlementRun" r
        ON r.id = v."settlementRunId" AND r."currentSubmittedVersion" = v.version
      WHERE v."settlementRunId" = ${settlementRunId}
      FOR UPDATE OF v
    `;
    const row = rows[0];
    if (row === undefined) throw new BizException(BizCode.LEDGER_COMMIT_VERSION_STATUS_INVALID);
    return row;
  }

  private async lockBatch(tx: PrismaTx, postingBatchId: string): Promise<LockedBatch> {
    const rows = await tx.$queryRaw<Array<LockedBatch>>`
      SELECT id, "statusCode", "settlementRunId", "settlementVersionId",
             "totalCount", "preparedCount", "baselineJsonHash", "committedAt"
      FROM "LedgerPostingBatch"
      WHERE id = ${postingBatchId}
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) throw new BizException(BizCode.LEDGER_COMMIT_BATCH_STATUS_INVALID);
    return row;
  }

  private async assertNoOtherCommittedBatch(
    tx: PrismaTx,
    settlementVersionId: string,
    batchId: string,
  ): Promise<void> {
    const other = await tx.ledgerPostingBatch.findFirst({
      where: { settlementVersionId, statusCode: 'committed', id: { not: batchId } },
      select: { id: true },
    });
    if (other !== null) throw new BizException(BizCode.LEDGER_COMMIT_VERSION_ALREADY_POSTED);
  }

  // ===== 分录集合 =========================================================

  /** 本次 commit 会从 draft 切到 committed 的所有闭合服务段成员,包含零分录成员。 */
  private async readDraftSegmentMemberIds(tx: PrismaTx, activityId: string): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ memberId: string }>>`
      SELECT DISTINCT i."memberId"
      FROM "ParticipantServiceSegmentRevision" s
      JOIN "ActivityParticipationIdentity" i ON i.id = s."participationIdentityId"
      WHERE i."activityId" = ${activityId}
        AND s."statusCode" = 'draft'
        AND s."resultCode" NOT IN ('voided', 'replaced')
        AND s."checkOutAt" IS NOT NULL
      ORDER BY i."memberId" ASC
    `;
    return rows.map((row) => row.memberId);
  }

  /**
   * AC-058:成员锁内比较“本活动待生效段”与“其他活动已生效段”。区间统一按
   * [checkInAt, checkOutAt) 左闭右开;同活动修订由既有 correction 流程处理,不在此误杀。
   */
  private async assertNoCrossActivitySegmentOverlap(
    tx: PrismaTx,
    activityId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ conflict: number }>>`
      SELECT 1 AS conflict
      FROM "ParticipantServiceSegmentRevision" candidate
      JOIN "ActivityParticipationIdentity" candidate_identity
        ON candidate_identity.id = candidate."participationIdentityId"
      JOIN "ActivityParticipationIdentity" existing_identity
        ON existing_identity."memberId" = candidate_identity."memberId"
       AND existing_identity."activityId" <> candidate_identity."activityId"
      JOIN "ParticipantServiceSegmentRevision" existing
        ON existing."participationIdentityId" = existing_identity.id
      WHERE candidate_identity."activityId" = ${activityId}
        AND candidate."statusCode" = 'draft'
        AND candidate."resultCode" NOT IN ('voided', 'replaced')
        AND candidate."checkOutAt" IS NOT NULL
        AND existing."statusCode" = 'committed'
        AND existing."resultCode" NOT IN ('voided', 'replaced')
        AND existing."checkOutAt" IS NOT NULL
        AND candidate."checkInAt" < existing."checkOutAt"
        AND existing."checkInAt" < candidate."checkOutAt"
      LIMIT 1
    `;
    if (rows.length > 0) throw new BizException(BizCode.ATTENDANCE_TIME_OVERLAP);
  }

  /**
   * 本批次分录按 (memberId, ledgerDate) 的聚合。
   *
   * 一条 SQL、**一个 bind 参数**,与人数无关。排序放在 SQL 里,让下游的锁顺序、
   * 基线比对顺序、错误信息顺序全部确定。
   */
  private async readBatchDayDeltas(tx: PrismaTx, postingBatchId: string): Promise<DayDelta[]> {
    const rows = await tx.$queryRaw<
      Array<{ memberId: string; ledgerDate: string; credited: string; entryCount: number }>
    >`
      SELECT e."memberId",
             to_char(e."ledgerDate", 'YYYY-MM-DD') AS "ledgerDate",
             SUM(e."creditedPointsDelta")::text AS credited,
             COUNT(*)::int AS "entryCount"
      FROM "ParticipationLedgerEntry" e
      WHERE e."postingBatchId" = ${postingBatchId}
      GROUP BY e."memberId", e."ledgerDate"
      ORDER BY e."memberId" ASC, e."ledgerDate" ASC
    `;
    return rows.map((row) => ({
      memberId: row.memberId,
      ledgerDate: row.ledgerDate,
      creditedHundredths: decimalToHundredths(row.credited),
      entryCount: row.entryCount,
    }));
  }

  /**
   * §5.12 ⑧ 的**生效侧复验**:准备结果的形状必须自洽。
   *
   * 三条,任一不成立就不生效:
   *   (a) 每个 (resultRevision, ledgerDate) 恰好两条分录(service_credit + contribution_credit);
   *   (b) 本刀**不产生** reversal ⇒ 批次里不许出现 `*_reversal` 分录;
   *   (c) 分录覆盖的 (resultRevision, ledgerDate) 对数 = 该版本的 `ParticipantSettlementDay` 行数。
   *
   * ⚠️ 刻意**不比** distinct 队员数与 `totalCount`:缺勤 / 请假 / 零时长的队员本来就
   *    一条分录都没有(那是正确形态),拿它们相等会把合法批次判死。
   */
  private async assertPreparedSetConsistent(
    tx: PrismaTx,
    batch: LockedBatch,
    settlementVersionId: string,
    deltas: readonly DayDelta[],
  ): Promise<void> {
    // ⭐⭐ 第七刀(更正应用,§5.14 ④)按场景**放宽**下面那条 `nonCreditCount !== 0`。
    //
    // 🔴 **放宽的是适用范围,不是判据本身**:
    //   - 批次被某条 `CorrectionApplication` 指向 ⇒ 走更正侧配对判据(见下方方法),
    //     它**比本判据更严**(冲回必须成对、等额、有 claim、把旧账冲干净);
    //   - 否则 ⇒ **逐字**走本判据,普通结算批次里出现任何 `*_reversal` 仍然 20089。
    //
    // 判别式取自 **DB 上的事实**(`CorrectionApplication` 行),不是调用方传进来的
    // flag —— flag 是"调用方说自己是更正",事实是"确实有一份更正申请把这条批次登记
    // 成了自己的产物"。前者任何调用点都能伪造,后者不行。
    // 判据:e2e「普通批次里塞一条 reversal 仍然被拒」那一条(卸掉判别式即变红)。
    if (await this.isCorrectionBatch(tx, batch.id)) {
      return await this.assertCorrectionSetConsistent(tx, batch, settlementVersionId);
    }

    const [shape] = await tx.$queryRaw<
      Array<{ entryCount: number; pairCount: number; nonCreditCount: number }>
    >`
      SELECT COUNT(*)::int AS "entryCount",
             COUNT(DISTINCT (e."resultRevisionId", e."ledgerDate"))::int AS "pairCount",
             COUNT(*) FILTER (
               WHERE e."entryTypeCode" NOT IN ('service_credit', 'contribution_credit')
             )::int AS "nonCreditCount"
      FROM "ParticipationLedgerEntry" e
      WHERE e."postingBatchId" = ${batch.id}
    `;
    const [dayRows] = await tx.$queryRaw<Array<{ dayCount: number }>>`
      SELECT COUNT(*)::int AS "dayCount"
      FROM "ParticipantSettlementDay" d
      JOIN "ParticipantSettlementResultRevision" rr ON rr.id = d."resultRevisionId"
      WHERE rr."settlementVersionId" = ${settlementVersionId}
    `;
    if (shape === undefined || dayRows === undefined) {
      throw new BizException(BizCode.LEDGER_COMMIT_ENTRY_SET_MISMATCH);
    }
    if (
      shape.nonCreditCount !== 0 ||
      shape.entryCount !== shape.pairCount * 2 ||
      shape.pairCount !== dayRows.dayCount ||
      shape.entryCount !== deltas.reduce((sum, row) => sum + row.entryCount, 0)
    ) {
      throw new BizException(BizCode.LEDGER_COMMIT_ENTRY_SET_MISMATCH);
    }
  }

  // ===== 更正批次的判别式与配对判据(第七刀,§5.14 ④ + §3.23.5)=============

  /** 事实判别:有没有一条 `CorrectionApplication` 把本批次登记成自己的产物。 */
  private async isCorrectionBatch(tx: PrismaTx, postingBatchId: string): Promise<boolean> {
    const application = await tx.correctionApplication.findFirst({
      where: { newPostingBatchId: postingBatchId },
      select: { id: true },
    });
    return application !== null;
  }

  /**
   * 更正批次的形状判据。判定本身是纯函数(`correction-posting-shape.ts`),
   * 本方法只负责把**事实计数**取回来 —— 让"判据"与"取数"分开,判据可被单测逐条钉住。
   *
   * 🔴 `settlementVersionId` 是**新**版本(批次挂在它下面);冲回侧的锚点是
   *    **基础版本** —— 由新版本任一结果行的 `baseResultRevisionId` 指回去解析,
   *    不靠调用方传:传进来的东西可以是错的,指针不会。
   */
  private async assertCorrectionSetConsistent(
    tx: PrismaTx,
    batch: LockedBatch,
    settlementVersionId: string,
  ): Promise<void> {
    const [facts] = await tx.$queryRaw<
      Array<{
        creditEntryCount: number;
        creditPairCount: number;
        settlementDayCount: number;
        reversalEntryCount: number;
        reversalPairCount: number;
        reversalClaimCount: number;
        unreversedOriginalCount: number;
        reversalOfUncommittedCount: number;
        mismatchedReversalAmountCount: number;
      }>
    >`
      WITH base AS (
        SELECT DISTINCT prior."settlementVersionId" AS id
        FROM "ParticipantSettlementResultRevision" rr
        JOIN "ParticipantSettlementResultRevision" prior ON prior.id = rr."baseResultRevisionId"
        WHERE rr."settlementVersionId" = ${settlementVersionId}
      ),
      mine AS (
        SELECT e.* FROM "ParticipationLedgerEntry" e WHERE e."postingBatchId" = ${batch.id}
      )
      SELECT
        (SELECT count(*) FROM mine
          WHERE "entryTypeCode" IN ('service_credit', 'contribution_credit'))::int
          AS "creditEntryCount",
        (SELECT count(DISTINCT ("resultRevisionId", "ledgerDate")) FROM mine
          WHERE "entryTypeCode" IN ('service_credit', 'contribution_credit'))::int
          AS "creditPairCount",
        (SELECT count(*) FROM "ParticipantSettlementDay" d
           JOIN "ParticipantSettlementResultRevision" rr ON rr.id = d."resultRevisionId"
          WHERE rr."settlementVersionId" = ${settlementVersionId})::int
          AS "settlementDayCount",
        (SELECT count(*) FROM mine
          WHERE "entryTypeCode" IN ('service_reversal', 'contribution_reversal'))::int
          AS "reversalEntryCount",
        (SELECT count(DISTINCT ("resultRevisionId", "ledgerDate")) FROM mine
          WHERE "entryTypeCode" IN ('service_reversal', 'contribution_reversal'))::int
          AS "reversalPairCount",
        (SELECT count(*) FROM mine
           JOIN "LedgerEntryReversalClaim" c ON c."originalEntryId" = mine."reversesEntryId"
          WHERE mine."entryTypeCode" IN ('service_reversal', 'contribution_reversal'))::int
          AS "reversalClaimCount",
        -- 🔴「只补不冲」的执行位:基础版本下已生效的 credit 分录,只要有一条没被本批次
        --    冲回,那笔钱就在队员账上留了两遍。
        (SELECT count(*) FROM "ParticipationLedgerEntry" o
           JOIN "LedgerPostingBatch" ob ON ob.id = o."postingBatchId"
           JOIN "ParticipantSettlementResultRevision" orr ON orr.id = o."resultRevisionId"
          WHERE orr."settlementVersionId" IN (SELECT id FROM base)
            AND ob."statusCode" = 'committed'
            AND o."entryTypeCode" IN ('service_credit', 'contribution_credit')
            AND NOT EXISTS (SELECT 1 FROM mine WHERE mine."reversesEntryId" = o.id))::int
          AS "unreversedOriginalCount",
        (SELECT count(*) FROM mine
           JOIN "ParticipationLedgerEntry" o ON o.id = mine."reversesEntryId"
           JOIN "LedgerPostingBatch" ob ON ob.id = o."postingBatchId"
          WHERE mine."entryTypeCode" IN ('service_reversal', 'contribution_reversal')
            AND ob."statusCode" <> 'committed')::int
          AS "reversalOfUncommittedCount",
        -- 🔴 四列逐列取反。光"有一条冲回"不够:冲 1.2 分的账只冲 0.2 分,配对计数
        --    完全正确,而队员账上凭空多出 1.0 分。
        (SELECT count(*) FROM mine
           JOIN "ParticipationLedgerEntry" o ON o.id = mine."reversesEntryId"
          WHERE mine."entryTypeCode" IN ('service_reversal', 'contribution_reversal')
            AND (mine."serviceHoursDelta" <> -o."serviceHoursDelta"
              OR mine."recognizedPointsDelta" <> -o."recognizedPointsDelta"
              OR mine."creditedPointsDelta" <> -o."creditedPointsDelta"
              OR mine."cappedOutPointsDelta" <> -o."cappedOutPointsDelta"))::int
          AS "mismatchedReversalAmountCount"
    `;
    if (facts === undefined) throw new BizException(BizCode.LEDGER_COMMIT_ENTRY_SET_MISMATCH);

    const violation = evaluateCorrectionPostingShape(facts);
    if (violation !== null) throw new BizException(CORRECTION_SHAPE_TO_BIZ_CODE[violation]);
  }

  // ===== ⑤ 恒串行闸 ======================================================

  private async acquireCommitBudget(tx: PrismaTx, memberCount: number): Promise<void> {
    // 这一场自己就超过预算总量 ⇒ 重试无用,先说清楚(与"此刻并发满了"分码)。
    if (ledgerCommitExceedsTotalBudget(memberCount)) {
      throw new BizException(BizCode.LEDGER_COMMIT_SCALE_EXCEEDS_LOCK_BUDGET);
    }
    const required = ledgerCommitRequiredSlots(memberCount);
    const acquired = await tryAcquireLedgerCommitSlots(tx, required);
    if (acquired < required) {
      // 已占到的槽随本事务回滚一起释放 —— 事务级 advisory 锁没有漏放这条路。
      throw new BizException(BizCode.LEDGER_COMMIT_LOCK_BUDGET_EXHAUSTED);
    }
  }

  // ===== ⑦ day-state ======================================================

  /**
   * 缺行补齐。`ORDER BY` 让 INSERT 按 (memberId, ledgerDate) 稳定顺序建行(§3.24)。
   *
   * ⚠️ 排他性其实已经由 ⑥ 的 member advisory lock 提供(同一队员的 day-state 只可能
   *    被持有该队员锁的事务碰),这里的定序是**纵深防御**,不是主闸 —— 如实标注,
   *    免得日后有人以为"去掉 member 锁也没事,反正 day-state 有行锁"。
   */
  private async createMissingDayStates(tx: PrismaTx, deltas: readonly DayDelta[]): Promise<void> {
    if (deltas.length === 0) return;
    await tx.$executeRaw`
      INSERT INTO "MemberContributionDayState" (
        "id", "createdAt", "updatedAt", "memberId", "ledgerDate", "version", "committedCreditedPoints"
      )
      SELECT gen_random_uuid()::text, NOW(), NOW(), t.member_id, t.ledger_date::date, 0, 0
      FROM unnest(
        ${deltas.map((row) => row.memberId)}::text[],
        ${deltas.map((row) => row.ledgerDate)}::text[]
      ) AS t(member_id, ledger_date)
      ORDER BY t.member_id, t.ledger_date
      ON CONFLICT ("memberId", "ledgerDate") DO NOTHING
    `;
  }

  private async lockDayStates(
    tx: PrismaTx,
    deltas: readonly DayDelta[],
  ): Promise<Map<string, CurrentDayState>> {
    const current = new Map<string, CurrentDayState>();
    if (deltas.length === 0) return current;
    const rows = await tx.$queryRaw<
      Array<{ memberId: string; ledgerDate: string; version: number; credited: string }>
    >`
      SELECT d."memberId",
             to_char(d."ledgerDate", 'YYYY-MM-DD') AS "ledgerDate",
             d.version,
             d."committedCreditedPoints"::text AS credited
      FROM "MemberContributionDayState" d
      JOIN unnest(
        ${deltas.map((row) => row.memberId)}::text[],
        ${deltas.map((row) => row.ledgerDate)}::text[]
      ) AS t(member_id, ledger_date)
        ON d."memberId" = t.member_id AND d."ledgerDate" = t.ledger_date::date
      ORDER BY d."memberId" ASC, d."ledgerDate" ASC
      FOR UPDATE OF d
    `;
    for (const row of rows) {
      current.set(ledgerBaselineKey(row.memberId, row.ledgerDate), {
        version: row.version,
        creditedHundredths: decimalToHundredths(row.credited),
      });
    }
    return current;
  }

  // ===== ⑧ baseline =======================================================

  private async readPreparedBaseline(
    tx: PrismaTx,
    batch: LockedBatch,
  ): Promise<LedgerDayStateBaseline> {
    const job = await tx.activityBatchJob.findUnique({
      where: { operationKey: `${LEDGER_PREPARE_JOB_TYPE}:${batch.id}` },
      select: { payload: true, statusCode: true },
    });
    // 批次是 `ready` 却找不到成功的准备任务 ⇒ 记录不自洽,不生效。
    if (job === null || job.statusCode !== 'succeeded') {
      throw new BizException(BizCode.LEDGER_COMMIT_BASELINE_DIGEST_MISMATCH);
    }
    return readBaselineFromPayload(job.payload);
  }

  /** 记录完整性:摘要吻合 + 键集恰好等于本批次覆盖的 (member, date) 集合。 */
  private assertBaselineIntact(
    baseline: LedgerDayStateBaseline,
    batch: LockedBatch,
    deltas: readonly DayDelta[],
  ): void {
    if (
      batch.baselineJsonHash === null ||
      ledgerBaselineDigest(baseline) !== batch.baselineJsonHash
    ) {
      throw new BizException(BizCode.LEDGER_COMMIT_BASELINE_DIGEST_MISMATCH);
    }
    const covered = new Set(deltas.map((row) => ledgerBaselineKey(row.memberId, row.ledgerDate)));
    if (Object.keys(baseline).length !== covered.size) {
      throw new BizException(BizCode.LEDGER_COMMIT_BASELINE_DIGEST_MISMATCH);
    }
    for (const key of covered) {
      if (!Object.prototype.hasOwnProperty.call(baseline, key)) {
        throw new BizException(BizCode.LEDGER_COMMIT_BASELINE_DIGEST_MISMATCH);
      }
    }
  }

  /**
   * ⭐ §5.13 ⑤⑥:逐条比对准备时的 `(version, 日合计)` 与**此刻**的值。
   *
   * 任一变化 ⇒ 抛出 ⇒ 整个事务回滚 ⇒ **一条分录都不会生效**。
   * 这里刻意不做"跳过变了的那几条、提交剩下的" —— 那正是合同 §5.13 ⑥ 明禁的部分 commit。
   */
  private assertBaselineUnchanged(
    baseline: LedgerDayStateBaseline,
    deltas: readonly DayDelta[],
    current: ReadonlyMap<string, CurrentDayState>,
  ): void {
    for (const delta of deltas) {
      const key = ledgerBaselineKey(delta.memberId, delta.ledgerDate);
      const now = current.get(key);
      if (now === undefined) throw new BizException(BizCode.LEDGER_COMMIT_BASELINE_CHANGED);
      if (baseline[key] !== ledgerBaselineValue(now.version, now.creditedHundredths)) {
        throw new BizException(BizCode.LEDGER_COMMIT_BASELINE_CHANGED);
      }
    }
  }

  // ===== ⑨ 日合计 0..3 ====================================================

  private assertDailyCapRespected(
    deltas: readonly DayDelta[],
    current: ReadonlyMap<string, CurrentDayState>,
  ): void {
    for (const delta of deltas) {
      const key = ledgerBaselineKey(delta.memberId, delta.ledgerDate);
      const prior = current.get(key)?.creditedHundredths ?? 0;
      if (!dayTotalWithinCap(fromHundredths(prior), fromHundredths(delta.creditedHundredths))) {
        throw new BizException(BizCode.LEDGER_COMMIT_DAILY_CAP_EXCEEDED);
      }
    }
  }

  // ===== ⑩ day-state 递增 + 日合计更新 ====================================

  private async advanceDayStates(
    tx: PrismaTx,
    postingBatchId: string,
    deltas: readonly DayDelta[],
  ): Promise<void> {
    if (deltas.length === 0) return;
    await tx.$executeRaw`
      UPDATE "MemberContributionDayState" AS d
      SET "version" = d."version" + 1,
          "committedCreditedPoints" = d."committedCreditedPoints" + t.delta::numeric,
          "latestBatchId" = ${postingBatchId},
          "updatedAt" = NOW()
      FROM unnest(
        ${deltas.map((row) => row.memberId)}::text[],
        ${deltas.map((row) => row.ledgerDate)}::text[],
        ${deltas.map((row) => fromHundredths(row.creditedHundredths).toFixed(2))}::text[]
      ) AS t(member_id, ledger_date, delta)
      WHERE d."memberId" = t.member_id AND d."ledgerDate" = t.ledger_date::date
    `;
  }

  // ===== 重放 =============================================================

  private async replayResult(
    tx: PrismaTx,
    activityId: string,
    run: { id: string; statusCode: string },
    version: { id: string; version: number },
    batch: LockedBatch,
  ): Promise<LedgerCommitResult> {
    const [row] = await tx.$queryRaw<
      Array<{ memberCount: number; dayCount: number; entryCount: number }>
    >`
      SELECT COUNT(DISTINCT e."memberId")::int AS "memberCount",
             COUNT(DISTINCT (e."memberId", e."ledgerDate"))::int AS "dayCount",
             COUNT(*)::int AS "entryCount"
      FROM "ParticipationLedgerEntry" e
      WHERE e."postingBatchId" = ${batch.id}
    `;
    return {
      postingBatchId: batch.id,
      activityId,
      settlementRunId: run.id,
      settlementVersionId: version.id,
      settlementVersion: version.version,
      batchStatus: batch.statusCode,
      runStatus: run.statusCode,
      memberCount: row?.memberCount ?? 0,
      dayStateCount: row?.dayCount ?? 0,
      entryCount: row?.entryCount ?? 0,
      committedAt: batch.committedAt,
      replayed: true,
    };
  }

  private async readOwnerMemberId(tx: PrismaTx, activityId: string): Promise<string | null> {
    const owner = await tx.activityResponsibilityAssignment.findFirst({
      where: { activityId, responsibilityType: 'owner', status: 'active' },
      orderBy: { startedAt: 'desc' },
      select: { memberId: true },
    });
    return owner?.memberId ?? null;
  }
}

// ===== §3.23.5 `LedgerEntryReversalClaim` 的显式声明(goal DoD 15)=============
//
// 🔴 **本刀不产生任何 reversal,因此不写一行 `LedgerEntryReversalClaim`。**
//
// 理由是结构性的,不是"暂时没做":
//   - reversal 的**唯一**来源是更正流程(§5.14 ④「先为受影响旧 entries 创建 reversal
//     claims 和负数 entries,再创建 replacement entries」),而更正归**第六刀**;
//   - 本刀的准备路径只写 `service_credit` / `contribution_credit` 两种分录
//     (见 `LedgerPreparationService.writeLedgerEntries`),生效路径**一条分录都不写**
//     (它只翻批次状态);
//   - 「至多一个 committed reversal 冲回一条原 entry」这条不变量因此在本刀没有可触发的路径。
//
// **不是靠自觉**:生效前的 `assertPreparedSetConsistent` 里有一条
// `nonCreditCount !== 0 ⇒ 20089` —— 批次里只要出现任何 `*_reversal` 分录就拒绝生效。
// 等第六刀真的要写 reversal 时,那条判据会**当场变红**,逼它在同一刀里把
// 「service 锁后检查 + `LedgerEntryReversalClaim` unique」一起做出来,
// 而不是悄悄绕过。执行位见 e2e ⑧。
//
// ===== 🟢 上面这条闸的后续:第七刀(更正应用)的兑现记录 =============================
//
// 预言应验了,但**顺延了一刀**:reversal 的唯一来源是更正(§5.14),而更正落在
// **第七刀**(第六刀是机器关账,它只读账)。第七刀开工即撞红本闸,处置**不是删掉它**,
// 而是按 goal 要求「按更正场景放宽适用范围」:
//
//   - `assertPreparedSetConsistent` 开头加一个**事实判别式**(本批次有没有被某条
//     `CorrectionApplication` 指向)。是 ⇒ 走 `assertCorrectionSetConsistent`;
//     否 ⇒ **逐字**走本判据。
//   - 更正侧那套判据**比本判据更严**,而不是更松:冲回必须成对(每个
//     `(旧 resultRevision, ledgerDate)` 恰好两条)、必须逐列等额取反、必须有
//     `LedgerEntryReversalClaim` 占住原分录、且必须把基础版本下**全部**已生效
//     credit 分录冲干净(`unreversedOriginalCount = 0`)。
//   - ⇒ **普通结算批次里出现 reversal 仍然 20089**,一个字没放松。
//     执行位:第七刀 e2e 的「普通批次仍被拒」那一条(它专门造一条不带
//     `CorrectionApplication` 的批次并塞进 reversal 分录,断言仍拿到 20089)。
