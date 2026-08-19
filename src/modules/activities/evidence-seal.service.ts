import { createHash } from 'node:crypto';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { EvidenceSealAuditRecorder } from './evidence-seal-audit-recorder';

// ===== 活动改造 v1.1 第 2 批第一刀:证据封场(合同 §5.8 / §3.17 / §4.6)=====
//
// 合同 §5.8 末句是本文件存在的全部理由:
//   「seal 不是"负责人承诺",没有所有条件不能写。」
// 旧世界里 `app-managed-activities.service#declareAttendanceComplete` 由负责人
// **声明**考勤完成、不逐人核验(合同 §2 明确要删它的关账权威地位)。这里把那句
// 声明换成八步机器判定:每一条不满足都以**具名 BizCode** 拒绝,而不是记一笔"已声明"。
//
// 锁序(§5.3 / goal DoD 5):`Activity` 行锁在最前,且**本刀只取这一把**。
// ❌ 不取 member advisory lock —— 封场不写任何队员维度事实(不写 segment、不写账本),
//    取了只会凭空多一条死锁边(见 concurrency-review-m1-m6「audit 外键是看不见的死锁边」)。
//
// 本刀**零端点**:消费方是第 2 批第二刀(结算草稿 / 提交)。判权在调用方,本服务不判 ——
// 新权限码归第二刀,这里不预留。
//
// ⚠️ 与合同的偏离,逐条:
// 1. §5.8 ⑤ 说「读取 ActivityEvidenceState 的 evidence/population/**workflow** revision」,
//    但 §3.17 的 ActivityEvidenceState 字段表只有 evidenceRevision / populationRevision /
//    version,**没有 workflowRevision**;workflowRevision 的真源是 §3.1 的 `Activity`
//    (§4.2「approved 时 ProposalApplier 在 Activity 锁内 …… 递增 workflowRevision」)。
//    故本实现从**已加锁的 Activity 行**读它。这是合同内部不一致,不是本实现的选择。
// 2. §5.8 ④ 的「待人工复核数量」以 `OfflinePunchReviewItem.pending`
//    为唯一真源；封场与关账均在 Activity 聚合锁内重读实时计数。
// 3. §5.8 没有给「已存在吻合版本的 active seal」这一形态的处置。本实现拒绝它
//    (`EVIDENCE_SEAL_ALREADY_ACTIVE`),依据是 §3.17 的逆命题:「新证据或人口变化会递增
//    state revision,使旧 seal 失配」⇒ 版本没变时旧 seal 仍然有效,没有可封的新事实。
//    这条同时是 goal DoD 4「两个并发 seal 只能成功一个」的收场码。
// 4. `allWindowsClosedAt` 在**零 live 场次**时取 authoritative now:此时「所有窗口都已关闭」
//    真空成立,而该列 NOT NULL 必须有值。不发明新的拒绝理由去堵这个形态。

type PrismaTx = Prisma.TransactionClient;

// 步骤 ②:一条 live 场次的签退义务。
interface SessionDeadline {
  sessionId: string;
  statusCode: string;
  // §3.2:场次提前终止后的**真实**签退截止;为空时回落计划签退窗口关闭时刻。
  effectiveCheckOutDeadline: Date;
}

interface EvidenceRevisions {
  evidenceRevision: number;
  populationRevision: number;
}

interface PopulationSummary {
  populationCountDistinct: number;
  // key = sessionId,已按 key 排序(进 contentHash 必须是 canonical 形状)。
  populationCountBySession: Record<string, number>;
}

export interface EvidenceSealResult {
  sealId: string;
  activityId: string;
  sealRevision: number;
  evidenceRevision: number;
  populationRevision: number;
  workflowRevision: number;
  allWindowsClosedAt: Date;
  openSegmentCount: number;
  manualReviewPendingCount: number;
  populationCountDistinct: number;
  populationCountBySession: Record<string, number>;
  contentHash: string;
  sealedAt: Date;
  supersededSealCount: number;
}

export type EvidenceSealAuthorizer = (tx: Prisma.TransactionClient) => Promise<void>;

@Injectable()
export class EvidenceSealService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: EvidenceSealAuditRecorder,
    // 活动 v1.1 cutover gate —— 新结算真相链的判闸依据(合同 §16.2 单轨)。
    private readonly activityWorkflowGate: ActivityWorkflowGate,
  ) {}

  // ===== §5.8 ① Activity FOR UPDATE(全流程唯一的锁,且在最前)=====
  //
  // `now()` 与行锁在**同一条语句**里取:PostgreSQL 的 `now()` = 事务开始时刻,
  // 全事务内恒定 —— 这就是 §5.8 ③ 所谓「authoritative now」:一个事务只有一个"现在",
  // 不受应用进程时钟漂移影响,也不会在八步之间自己往前走。
  private async lockActivityAndReadNow(
    tx: PrismaTx,
    activityId: string,
  ): Promise<{ workflowRevision: number; authoritativeNow: Date }> {
    const rows = await tx.$queryRaw<Array<{ workflowRevision: number; authoritativeNow: Date }>>`
      SELECT "workflowRevision", now() AS "authoritativeNow"
      FROM "Activity"
      WHERE id = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return row;
  }

  // ===== §5.8 ② 重读所有 live sessions 和 termination deadlines =====
  //
  // 「live」= 未软删(软删只发生在草稿期)且未取消。`terminated` 场次**仍然 live**:
  // 它照样产生现场事实,只是签退截止换成 `terminationCheckOutDeadline`(§3.2)。
  // 取消的场次没有签退义务,不参与 ③ 的判定。
  private async readLiveSessionDeadlines(
    tx: PrismaTx,
    activityId: string,
  ): Promise<SessionDeadline[]> {
    const rows = await tx.activitySession.findMany({
      where: { activityId, deletedAt: null, statusCode: { not: 'cancelled' } },
      select: {
        id: true,
        statusCode: true,
        checkOutCloseAt: true,
        terminationCheckOutDeadline: true,
      },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => ({
      sessionId: row.id,
      statusCode: row.statusCode,
      effectiveCheckOutDeadline: row.terminationCheckOutDeadline ?? row.checkOutCloseAt,
    }));
  }

  // ===== §5.8 ④ 之一:开放 segment 数量 =====
  //
  // §4.5 的「open」态在 §3.18 的表上是 `checkOutAt IS NULL`(第 1 批第三刀把
  // sourceCloseEventId / checkOutAt / serviceHours 三列改可空,正是为了表达这个形态)。
  // 排除条件两条,都不是装饰:
  //   - `statusCode <> 'superseded'`:被后继 revision 顶掉的旧行不再是"当前"段;
  //   - `resultCode NOT IN ('voided','replaced')`:被作废/替代的段没有待闭合的义务。
  // 两列均 NOT NULL ⇒ 谓词恒二值,不存在三值逻辑塌陷。
  private async countOpenSegments(tx: PrismaTx, activityId: string): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS "count"
      FROM "ParticipantServiceSegmentRevision" s
      JOIN "ActivityParticipationIdentity" i ON i.id = s."participationIdentityId"
      WHERE i."activityId" = ${activityId}
        AND s."statusCode" <> 'superseded'
        AND s."resultCode" NOT IN ('voided', 'replaced')
        AND s."checkOutAt" IS NULL
    `;
    return rows[0]?.count ?? 0;
  }

  // ===== §5.8 ④ 之二:待人工复核数量 =====
  //
  private countPendingManualReviewItems(tx: PrismaTx, activityId: string): Promise<number> {
    return tx.offlinePunchReviewItem.count({
      where: { activityId, statusCode: 'pending' },
    });
  }

  // ===== §5.8 ④ 之三:未处理的 event effect =====
  //
  // 「未处理」= 打卡事件已经落库,但它对服务段的影响还没被投影出来(§4.5)。两种形状:
  //   (a) 投影型事件(check_in / check_out / early_departure_close)没有任何**非 superseded**
  //       的 segment revision 引用它 —— 事件在那儿,段还没建;
  //   (b) void / replace 事件的目标事件**仍然**被非 superseded 的 segment 引用 ——
  //       §4.5「相关 event 被 void／replace → 生成新的 segment revision」尚未发生。
  // EXISTS / NOT EXISTS 恒二值;`supersedesEventId` 可空但 `= NULL` 只会让 EXISTS 取假,
  // 不会塌成 NULL(且 supersede shape CHECK 已保证 void/replace 行必有该值)。
  private async countUnprocessedEventEffects(tx: PrismaTx, activityId: string): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS "count"
      FROM "AttendancePunchEvent" e
      WHERE e."activityId" = ${activityId}
        AND (
          (
            e."eventTypeCode" IN ('check_in', 'check_out', 'early_departure_close')
            AND NOT EXISTS (
              SELECT 1 FROM "ParticipantServiceSegmentRevision" s
              WHERE s."statusCode" <> 'superseded'
                AND (s."sourceCheckInEventId" = e.id OR s."sourceCloseEventId" = e.id)
            )
          )
          OR (
            e."eventTypeCode" IN ('void', 'replace')
            AND EXISTS (
              SELECT 1 FROM "ParticipantServiceSegmentRevision" s
              WHERE s."statusCode" <> 'superseded'
                AND (
                  s."sourceCheckInEventId" = e."supersedesEventId"
                  OR s."sourceCloseEventId" = e."supersedesEventId"
                )
            )
          )
        )
    `;
    return rows[0]?.count ?? 0;
  }

  // ===== §5.8 ⑤ / ⑦:读 ActivityEvidenceState 的两个 revision =====
  //
  // 行不存在 = 该活动至今没有任何证据/人口变化 ⇒ (0, 0),与 §3.1 Activity 上两个
  // `current*Revision` 列的 default 一致。**不**在这里顺手建行:递增逻辑归产生事实的那些刀。
  private async readEvidenceRevisions(
    tx: PrismaTx,
    activityId: string,
  ): Promise<EvidenceRevisions> {
    const row = await tx.activityEvidenceState.findUnique({
      where: { activityId },
      select: { evidenceRevision: true, populationRevision: true },
    });
    return {
      evidenceRevision: row?.evidenceRevision ?? 0,
      populationRevision: row?.populationRevision ?? 0,
    };
  }

  // ===== §5.8 ⑥:population distinct 与 by-session 摘要 =====
  //
  // 口径 = §3.8 的 `populationIncluded`(「是否进入当前应结算人口;随状态原子更新」)。
  // distinct 按 **memberId** 去重(一个人报了三个场次仍是一个人);by-session 不去重
  // (它数的是人次:同一 session 内 (activityId, sessionId, memberId) 已由 unique 保证不重)。
  private async computePopulationSummary(
    tx: PrismaTx,
    activityId: string,
  ): Promise<PopulationSummary> {
    const distinctRows = await tx.$queryRaw<Array<{ count: number }>>`
      SELECT count(DISTINCT "memberId")::int AS "count"
      FROM "ActivityParticipationIdentity"
      WHERE "activityId" = ${activityId} AND "populationIncluded" = true
    `;
    const bySessionRows = await tx.activityParticipationIdentity.groupBy({
      by: ['sessionId'],
      where: { activityId, populationIncluded: true },
      _count: { _all: true },
    });
    const populationCountBySession: Record<string, number> = {};
    for (const row of [...bySessionRows].sort((a, b) => a.sessionId.localeCompare(b.sessionId))) {
      populationCountBySession[row.sessionId] = row._count._all;
    }
    return {
      populationCountDistinct: distinctRows[0]?.count ?? 0,
      populationCountBySession,
    };
  }

  // §3.17 `contentHash`:封场那一刻的全部机器判定输入 + 结论的 canonical 摘要。
  // key 顺序写死在字面量里、by-session 已排序 ⇒ 同样的事实必然得到同样的 hash
  // (§5.10 ③ 与 §5.11 都要拿它做跨阶段比对,漂移一位就等于封场失效)。
  private computeContentHash(input: {
    activityId: string;
    sealRevision: number;
    evidenceRevision: number;
    populationRevision: number;
    workflowRevision: number;
    allWindowsClosedAt: Date;
    openSegmentCount: number;
    manualReviewPendingCount: number;
    populationCountDistinct: number;
    populationCountBySession: Record<string, number>;
  }): string {
    const canonical = JSON.stringify({
      activityId: input.activityId,
      sealRevision: input.sealRevision,
      evidenceRevision: input.evidenceRevision,
      populationRevision: input.populationRevision,
      workflowRevision: input.workflowRevision,
      allWindowsClosedAt: input.allWindowsClosedAt.toISOString(),
      openSegmentCount: input.openSegmentCount,
      manualReviewPendingCount: input.manualReviewPendingCount,
      populationCountDistinct: input.populationCountDistinct,
      populationCountBySession: input.populationCountBySession,
    });
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }

  async seal(
    activityId: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
    authorize?: EvidenceSealAuthorizer,
  ): Promise<EvidenceSealResult> {
    // 活动 v1.1 单一 cutover gate(合同 §16.2):闸未开时本实例仍按旧口径结算,
    // 新结算真相链禁止落库 —— 否则就是合同点名禁止的「新打卡＋旧结算」混合态。
    this.activityWorkflowGate.assertV11WriteAllowed();
    return await this.prisma.$transaction(async (tx) => {
      // ① Activity FOR UPDATE + authoritative now。
      const { workflowRevision, authoritativeNow } = await this.lockActivityAndReadNow(
        tx,
        activityId,
      );
      // 既有 direct/service 调用不传 authorize，语义逐字不变；HTTP 接线把负责人锚
      // 放在同一把 Activity 锁里，避免先判后封的 TOCTOU 窗口。
      if (authorize) await authorize(tx);

      // ② 重读 live sessions 与 termination deadlines。
      const sessionDeadlines = await this.readLiveSessionDeadlines(tx, activityId);

      // ③ authoritative now 必须晚于所有有效 checkout deadline。
      // 严格「晚于」:恰好等于截止那一刻不算过 —— 窗口是闭区间,那一毫秒还能签退。
      const stillOpen = sessionDeadlines.some(
        (row) => row.effectiveCheckOutDeadline.getTime() >= authoritativeNow.getTime(),
      );
      if (stillOpen) throw new BizException(BizCode.EVIDENCE_SEAL_CHECKOUT_WINDOW_OPEN);

      const deadlines = sessionDeadlines.map((row) => row.effectiveCheckOutDeadline.getTime());
      // 零 live 场次时没有窗口可言(「都关了」真空成立),取 authoritative now ——
      // 该列 NOT NULL 必须有值,而这里不发明新的拒绝理由(见文件头偏离说明④)。
      const allWindowsClosedAt =
        deadlines.length === 0 ? authoritativeNow : new Date(Math.max(...deadlines));

      // ④ 开放 segment / 待人工复核 / 未处理 event effect。
      const openSegmentCount = await this.countOpenSegments(tx, activityId);
      if (openSegmentCount > 0) {
        throw new BizException(BizCode.EVIDENCE_SEAL_OPEN_SEGMENT_EXISTS);
      }

      const manualReviewPendingCount = await this.countPendingManualReviewItems(tx, activityId);
      if (manualReviewPendingCount > 0) {
        throw new BizException(BizCode.EVIDENCE_SEAL_MANUAL_REVIEW_PENDING);
      }

      const unprocessedEventEffectCount = await this.countUnprocessedEventEffects(tx, activityId);
      if (unprocessedEventEffectCount > 0) {
        throw new BizException(BizCode.EVIDENCE_SEAL_UNPROCESSED_EVENT_EFFECT);
      }

      // ⑤ 读 ActivityEvidenceState 的 evidence / population revision
      //    (workflow revision 见文件头偏离说明①,取自已加锁的 Activity 行)。
      const revisionsAtRead = await this.readEvidenceRevisions(tx, activityId);

      // ⑤-b 已有吻合版本的 active seal ⇒ 没有可封的新事实(见文件头偏离说明③)。
      // 放在昂贵的 ⑥ 之前 —— 也正是并发败者的收场点:①的行锁把两个 seal 串起来之后,
      // 后到者在这里读到的就是先到者刚写下的、三个版本号完全吻合的 active seal。
      const activeSeal = await tx.evidenceSeal.findFirst({
        where: { activityId, statusCode: 'active' },
        select: { evidenceRevision: true, populationRevision: true, workflowRevision: true },
      });
      if (
        activeSeal !== null &&
        activeSeal.evidenceRevision === revisionsAtRead.evidenceRevision &&
        activeSeal.populationRevision === revisionsAtRead.populationRevision &&
        activeSeal.workflowRevision === workflowRevision
      ) {
        throw new BizException(BizCode.EVIDENCE_SEAL_ALREADY_ACTIVE);
      }

      // ⑥ population distinct 与 by-session 摘要。
      const population = await this.computePopulationSummary(tx, activityId);

      // ⑦ pending change review + 版本在本事务内是否变化。
      const pendingChangeReviewCount = await tx.activityPublishReview.count({
        where: { activityId, status: 'pending' },
      });
      if (pendingChangeReviewCount > 0) {
        throw new BizException(BizCode.EVIDENCE_SEAL_CHANGE_REVIEW_PENDING);
      }

      // 复读 ⑤ 的两个 revision。**这一条不是仪式**:Activity 行锁保护不到
      // ActivityEvidenceState 那一行,绕过 §5.3 锁序直接写它的路径能在 ⑤ 与这里之间
      // 提交(READ COMMITTED 下本事务的每条语句都取新快照,故看得见)。
      // ⚠️ workflowRevision **刻意不复读**:它在**已加锁的 Activity 行**上,本事务持锁期间
      //    结构上不可能变 —— 复读它会是一条永远不会触发的假护栏。
      const revisionsAtCommit = await this.readEvidenceRevisions(tx, activityId);
      if (
        revisionsAtCommit.evidenceRevision !== revisionsAtRead.evidenceRevision ||
        revisionsAtCommit.populationRevision !== revisionsAtRead.populationRevision
      ) {
        throw new BizException(BizCode.EVIDENCE_SEAL_REVISION_CHANGED);
      }

      // ⑧ 写 immutable EvidenceSeal + audit;旧 active seal 同事务标 superseded。
      const maxRevision = await tx.evidenceSeal.aggregate({
        where: { activityId },
        _max: { sealRevision: true },
      });
      const sealRevision = (maxRevision._max.sealRevision ?? 0) + 1;
      const contentHash = this.computeContentHash({
        activityId,
        sealRevision,
        evidenceRevision: revisionsAtCommit.evidenceRevision,
        populationRevision: revisionsAtCommit.populationRevision,
        workflowRevision,
        allWindowsClosedAt,
        openSegmentCount,
        manualReviewPendingCount,
        populationCountDistinct: population.populationCountDistinct,
        populationCountBySession: population.populationCountBySession,
      });

      // §4.6「可在新 seal 写入时把旧 active 改 superseded 作为投影」——
      // 先降级再写入:即便日后补上「一活动至多一个 active seal」的 partial unique,
      // 这个顺序也不会撞。
      const superseded = await tx.evidenceSeal.updateMany({
        where: { activityId, statusCode: 'active' },
        data: { statusCode: 'superseded' },
      });

      const seal = await tx.evidenceSeal.create({
        data: {
          activityId,
          sealRevision,
          evidenceRevision: revisionsAtCommit.evidenceRevision,
          populationRevision: revisionsAtCommit.populationRevision,
          workflowRevision,
          allWindowsClosedAt,
          openSegmentCount,
          manualReviewPendingCount,
          populationCountDistinct: population.populationCountDistinct,
          populationCountBySession: population.populationCountBySession,
          contentHash,
          statusCode: 'active',
          sealedByUserId: currentUser.id,
          sealedAt: authoritativeNow,
        },
        select: { id: true, sealedAt: true },
      });

      await this.audit.log({
        activityId,
        sealId: seal.id,
        sealRevision,
        evidenceRevision: revisionsAtCommit.evidenceRevision,
        populationRevision: revisionsAtCommit.populationRevision,
        workflowRevision,
        populationCountDistinct: population.populationCountDistinct,
        openSegmentCount,
        manualReviewPendingCount,
        supersededSealCount: superseded.count,
        contentHash,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        auditMeta,
        tx,
      });

      return {
        sealId: seal.id,
        activityId,
        sealRevision,
        evidenceRevision: revisionsAtCommit.evidenceRevision,
        populationRevision: revisionsAtCommit.populationRevision,
        workflowRevision,
        allWindowsClosedAt,
        openSegmentCount,
        manualReviewPendingCount,
        populationCountDistinct: population.populationCountDistinct,
        populationCountBySession: population.populationCountBySession,
        contentHash,
        sealedAt: seal.sealedAt,
        supersededSealCount: superseded.count,
      };
    });
  }
}
