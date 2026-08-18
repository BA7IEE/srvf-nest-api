import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { GLOBAL_DAILY_CONTRIBUTION_CAP } from '../team-join/team-join.constants';
import { ActivityClosureAuditRecorder } from './activity-closure-audit-recorder';
import {
  buildClosureChecksJson,
  collectClosureGaps,
  computeClosureChecksHash,
  summarizeClosureChecks,
  type ActivityClosureCheckCounts,
  type ActivityClosureCheckSummary,
  type ActivityClosureChecksJson,
  type ActivityClosureGap,
  type ActivityClosureTotals,
} from './activity-closure-checks';
import { ActivityClosureNotificationProducer } from './activity-closure-notification-producer';
import { freezeResponsibility } from './activity-recipient-freeze';

// ===== 活动改造 v1.1 第 2 批第六刀:机器关账(合同 §5.15 + §3.26)=====
//
// 🔴🔴 **关账是"这场活动的账算完了"的唯一权威。** 合同 §1.2 把它从「负责人**声明**」
//    改成**机器检查**:八类判定全过,才追加一张不可变 `ActivitySettlementClosureRevision`。
//    此后统计、评价资格、入队进度全部读它。它的失败模式不是报错,是**悄悄关掉一场
//    没算完的活动** —— 因此本文件每一处判定都走拒绝,没有一处走"警告后放行"。
//
// ## ⭐ 本刀**不动**旧关账路径(goal 背景红线,不是遗漏)
//
// 合同 §1.2 还要求「删除 `declareAttendanceComplete` 的关账权威地位」「
// `activity-closure-policy.ts` 改为读最新有效 ClosureRevision」——**那是既有行为 +
// 既有 e2e 断言的变更**,本仓铁律:改既有 e2e 断言 = 改行为契约 ⇒ 停下报告。
// ⇒ 本刀只**新建**本服务,与旧路径并存;旧路径退场另立一刀并单独拍板
// (已登记在 `NEXT_TASKS` P1-28「已知行为契约冲突」)。
// ❌ 本刀不删旧路径、不改 `activity-closure-policy.ts`、不改
//    `app-managed-activities.service.ts`、不改任何既有 e2e 断言。
//
// ## 锁序(§5.15 ① + §10.1;与前五刀同序,不得倒置)
//
//   ① `Activity` `FOR UPDATE` —— §5.15 ① 明写它在最前。
//   ② `AttendanceSettlementRun` `FOR UPDATE` —— **因为本刀要写它**
//      (`statusCode='closed'` + `currentClosureRevision`)。只读不写的
//      `AttendanceSettlementVersion` / `LedgerPostingBatch` **不加锁**:AC-063
//      要的「关账与终审、更正并发时按活动锁串行」由 ① 提供 —— 那三刀也都先取
//      Activity 行锁,①一把就把它们全串起来了,多取两把只会凭空多两条死锁边。
//
// 🔴 **不取 member advisory lock**(goal DoD 2):关账只**读**账、不写任何队员维度事实
//    (不写分录、不动 day-state、不碰 segment)。取了只会凭空多一条死锁边
//    (沿 concurrency-review-m1-m6「audit 外键是看不见的死锁边」与前五刀同一判断)。
//
// ## 🔴 「任一失败不写半张 closure」是靠什么成立的(§5.15 ⑫)
//
// **结构上**:十二步里**全部八类检查都排在第一次写入之前**。检查不通过时本方法
// 走的是 `return { outcome:'blocked' }` —— 那条路径上一条 `INSERT`/`UPDATE` 都没有,
// 事务里只有 `SELECT`。不是"写了再回滚",是**根本没开始写**。
// 写入段(closure → 两个指针 → intent → audit)全在同一个 Prisma 交互事务里,
// 中途任一步抛出即整体回滚(判据:e2e 让 audit 抛错,断言 closure 零行 / 指针未动 /
// intent 零条)。
//
// ## 为什么失败是**返回**缺口清单而不是抛异常
//
// §5.15 ⑫ 逐字要求「返回**结构化缺口码和数量**」,业务 §9.2 举的例子是「必须清楚提示
// 30 个队员×场次尚未处理」。一次尝试可能同时缺好几类,而维护者看不懂代码 ——
// 只抛第一个码等于把排查成本原样推给他。且本仓 `BizException` 只能携带一个
// `BizCodeEntry`(`biz.exception.ts` 也不在本刀写集内),抛异常在结构上就装不下这份清单。
// ⇒ 缺口走返回值(判别联合,调用方漏判会编译不过);**真正的异常态**
// (活动不存在 / 幂等键撞 / 并发撞 partial unique)仍然抛 —— 那些不是"缺口"。
//
// ## 与合同的偏离,逐条(报告里另有完整列表)
//
// 1. **幂等键无处安放**:§5.15 ② 要求按 `operationKey + requestHash` 防重,而 §3.26 的
//    字段表**没有给这两列**(合同内部不一致,已作为新 finding 上报)。本刀零 schema ⇒
//    幂等键存进 `checksJson.idempotency`,去重域是 **(activityId, operationKey)**。
//    ⚠️ 诚实说明:正确性来自**① 的 Activity 行锁**(所有关账写入都先取它,故同一活动
//    的两次关账必然串行),**不是** DB unique —— 与第三/四/五刀靠单列 unique 兜底
//    的幂等**不同级**。跨活动同 key 不冲突(锁是按活动的,广域去重没有执法位)。
// 2. **§5.15 ③ 拆成两类缺口码**:业务 §9.2 把"已结束/已终止"与"已封场"列为两道硬检查。
// 3. **「进入 archive waiting」零新列**:§3.1 只给了 `Activity.archiveWaitingDays`,
//    全仓没有 archive 状态列。⇒ 归档等待是**派生态**:存在 active closure 且
//    `now < closedAt + archiveWaitingDays 天`。本方法把 `archiveWaitingUntil` 算出来
//    返回并写进 audit,**不新增列、不新增状态机**。
//    🔴 修订说明 §4:「7 天只是便于发现问题的等待期,**不是合法更正的最终截止日**」⇒
//    本文件里没有任何一处拿 `archiveWaitingUntil` 做拒绝判据(判据见 e2e:
//    `archiveWaitingDays=0` 的活动在等待期早已过去之后,重新关账照样成功)。
// 4. **评价开放 intent 只发一条**(给当前 active owner),不在关账事务里做逐人 fan-out:
//    §3.27 定义了 `notification_expand` 作业类型,逐人展开正是它的职责。
//    ⚠️ 且本刀**刻意不创建**那条 job —— 本刀第 ③ 类检查会把"未完成 job"算作缺口,
//    而第 ⑧ 刀之前没有 worker 注册它 ⇒ 关账自己造出的 job 会把**更正后重新关账**
//    永久堵死。这条已作为第 ⑧ 刀的必读约束写进报告。
// 5. **人工复核计数今天在结构上恒为 0**:真源表 `OfflinePunchReviewItem` 至今没有定义
//    (AMENDMENTS-v1.1.1 §3 裁定补齐字段表是第 6 批开工硬门)。闸已接上、有判据钉住,
//    第 6 批建表时只需把计数查询填进去 —— 与第一刀封场同一处置,**不假装已经守住**。
//
// ## 本刀不做的事
//
// ❌ 零端点 / 零 DTO / 零权限码(整条结算流程的对外入口统一留到第 ⑧ 刀);判权在调用方。
// ❌ 零 schema;❌ 零 Punch 写路径;❌ 不新增 cron / Redis / queue。
// ❌ 不写 `ParticipationLedgerEntry` / `MemberContributionDayState` / segment ——
//    关账**只读账**。账是第五刀记的,关账只是给它盖章。

type PrismaTx = Prisma.TransactionClient;

export interface ActivityClosureInput {
  /** §5.15 ②。同 key 同 payload ⇒ 返回同一张 closure;同 key 不同 payload ⇒ 20098。 */
  operationKey: string;
  /** 与 `operationKey` 成对,决定"是重放还是撞键"。 */
  requestHash: string;
  /** §6.14 HTTP 版本锚点;缺省保持既有内部调用的关账语义。 */
  expectedSettlementVersionId?: string;
  /** §6.14 HTTP 账本批次锚点;缺省保持既有内部调用的关账语义。 */
  expectedPostingBatchId?: string;
}

export interface ActivityClosureResult {
  closureRevisionId: string;
  activityId: string;
  /** §3.26 `(activityId, revision)` unique;首次关账 = 1,更正后重新关账追加。 */
  revision: number;
  settlementRunId: string;
  settlementVersionId: string;
  postingBatchId: string;
  evidenceSealId: string;
  evidenceRevision: number;
  populationRevision: number;
  workflowRevision: number;
  personCount: number;
  sessionParticipationCount: number;
  resultCountsJson: Readonly<Record<string, number>>;
  serviceHours: string;
  contributionPoints: string;
  checksHash: string;
  closedAt: Date;
  /** §5.15 ⑪ 的「进入 archive waiting」—— 派生态,见文件头偏离说明 ③。 */
  archiveWaitingDays: number;
  archiveWaitingUntil: Date;
  /** 八类检查的逐类摘要(全部 `passed: true` —— 否则走不到这里)。 */
  checks: readonly ActivityClosureCheckSummary[];
  /** true = 同 key 同 payload 的重放,没有产生第二张 closure。 */
  replayed: boolean;
}

export interface ActivityClosureBlocked {
  activityId: string;
  /** §5.15 ⑫「结构化缺口码和数量」。恒非空。 */
  gaps: readonly ActivityClosureGap[];
  /** 八类全量摘要(含通过的)—— 关账页要显示"12 道检查"的全貌,不是只显示红的。 */
  checks: readonly ActivityClosureCheckSummary[];
}

/**
 * 判别联合:调用方**必须**先判 `outcome` 才能拿到 `closure` —— 漏判编译不过。
 * 这是"缺口不能被当成成功"的类型层执行位。
 */
export type ActivityClosureOutcome =
  | ({ outcome: 'closed' } & { closure: ActivityClosureResult })
  | ({ outcome: 'blocked' } & ActivityClosureBlocked);

/**
 * 关账事务的显式预算。
 *
 * 本事务里**没有一步与人数相关**:全部计数都是聚合 SQL(返回一行),写入是 1 条 INSERT
 * + 2 条单行 UPDATE + 1 条 intent + 1 条 audit。取 20s 是为了在**并发排队**下跑得完 ——
 * 关账要和终审、账本生效抢同一把 Activity 行锁,Prisma 默认 5s 里还包含等锁时间。
 */
export const ACTIVITY_CLOSURE_TX_TIMEOUT_MS = 20_000;

/** §3.9 的参与身份闭集里,「算参加了」的三个终态。 */
const IDENTITY_PARTICIPATING = ['pass', 'attended', 'settled'];
/** 同一闭集里「还没定下来」的四个非终态(§9.2 ⑥「待审核、候补和未确认邀请已经收口」)。 */
const IDENTITY_UNRESOLVED = [
  'pending',
  'waitlisted',
  'cancellation_requested',
  'invitation_pending',
];
/** 同一闭集里「定下来了但没参加」的七个终态。与上面两组**三分且互不相交**。 */
const IDENTITY_EXCLUDED = [
  'not_selected',
  'rejected',
  'cancelled',
  'invitation_declined',
  'invitation_expired',
  'review_expired',
  'waitlist_expired',
];

/**
 * 报名的「还没定下来」两态。
 *
 * ⚠️ 只列这两个、不列"哪个值代表通过",是**刻意**的:本仓既有 service 写的是
 * `'pass'`(`activity-registrations.service.ts`),而第五刀 e2e 夹具写的是 `'approved'`,
 * `ActivityRegistration.statusCode` 上又没有 DB CHECK ⇒ "通过"这一侧的取值集是不确定的。
 * 故「参与类报名」用**补集**定义(见 SQL 里的 NOT IN 列表),两种写法都能被认出来。
 * 这条不确定性已作为 finding 上报,本刀不改既有 service、不加 CHECK。
 */
const REGISTRATION_UNRESOLVED = ['pending', 'waitlisted'];
/** 报名的「不参与」终态集合;补集即"参与类"。 */
const REGISTRATION_NON_PARTICIPATING = [
  ...REGISTRATION_UNRESOLVED,
  'cancelled',
  'rejected',
  'not_selected',
  'expired',
  'withdrawn',
];

/** 未完成作业 = 不在这两个终态里(failed / dead / partial_failed 一律算未完成 —— fail-closed)。 */
const JOB_FINISHED = ['succeeded', 'cancelled'];

/** §3.25 里「还没了结」的更正态(applied / rejected / voided 才算了结)。 */
const CORRECTION_OPEN = ['pending', 'returned', 'approved', 'applying'];

interface LockedActivity {
  title: string;
  statusCode: string;
  endAt: Date;
  terminatedAt: Date | null;
  workflowRevision: number;
  archiveWaitingDays: number;
  authoritativeNow: Date;
}

interface LockedRun {
  id: string;
  statusCode: string;
  currentPostedVersion: number | null;
}

@Injectable()
export class ActivityClosureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: ActivityClosureAuditRecorder,
    private readonly notifications: ActivityClosureNotificationProducer,
  ) {}

  /**
   * §5.15 `ActivityClosureService.close(activityId, operationKey)` —— 十二步。
   *
   * 成功 ⇒ `{ outcome:'closed', closure }`;任一类检查不过 ⇒ `{ outcome:'blocked', gaps }`
   * 且**一行都没写**。真正的异常态(活动不存在 / 幂等撞键 / 并发撞 active unique)抛
   * `BizException`。
   */
  async close(
    activityId: string,
    input: ActivityClosureInput,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityClosureOutcome> {
    return await this.prisma.$transaction(
      async (tx) => {
        // ===== ① Activity FOR UPDATE(§5.15 ①;全流程第一把,且 now() 与它同语句取)=====
        const activity = await this.lockActivityAndReadNow(tx, activityId);

        // ===== ② 幂等:operationKey + requestHash(§5.15 ②)=====
        //
        // 🔴 **必须排在所有状态闸与八类检查之前**。重放请求打过来时,活动早已被第一次
        //    关账推走(active closure 已存在)⇒ 先判第 ⑧ 类会把一次合法重放判成"已关账"。
        //    与第三 / 四刀同一处置。
        const replay = await this.findClosureByOperationKey(tx, activityId, input);
        if (replay !== null) return { outcome: 'closed', closure: replay };

        // ===== ③ 重读执行态 / 场次 / EvidenceState / active EvidenceSeal(§5.15 ③)=====
        const run = await this.lockRun(tx, activityId);
        const evidence = await this.readEvidenceFacts(tx, activityId, activity.workflowRevision);
        // `closed` 与 `posted` 同样有已生效的账(见 evaluateChecks 里 runNotPosted 的说明)。
        const postedVersion =
          run !== null &&
          (run.statusCode === 'posted' || run.statusCode === 'closed') &&
          run.currentPostedVersion !== null
            ? await this.readPostedVersion(tx, run)
            : null;

        // §6.14 HTTP 版本/批次锚点。Activity 锁、关账幂等判定与 run 重读均已完成;
        // 比对的是本事务内当前 posted 指针实际指向的版本和 committed batch，不能由
        // Controller 的锁外预查代替。缺省时两个分支均跳过，保留既有关账行为。
        if (
          input.expectedSettlementVersionId !== undefined &&
          postedVersion?.id !== input.expectedSettlementVersionId
        ) {
          throw new BizException(BizCode.ACTIVITY_CLOSURE_EXPECTED_SETTLEMENT_VERSION_MISMATCH);
        }
        if (
          input.expectedPostingBatchId !== undefined &&
          postedVersion?.committedBatchId !== input.expectedPostingBatchId
        ) {
          throw new BizException(BizCode.ACTIVITY_CLOSURE_EXPECTED_POSTING_BATCH_MISMATCH);
        }
        // 没有 posted 版本时用空串当版本锚点:`= ''` 是恒二值谓词,一行都匹配不上
        // ⇒ "全部人口都还没有结果"自然成立(§9.2 那句「30 个队员×场次尚未处理」)。
        // ❌ 不用 NULL —— `col = NULL` 恒 UNKNOWN,读代码的人得先想一遍三值逻辑。
        const versionAnchor = postedVersion?.id ?? '';

        // ===== ④–⑨ 八类检查:**全跑,不 fail-fast**(见文件头)=====
        const counts = await this.evaluateChecks(tx, {
          activityId,
          activity,
          evidence,
          run,
          postedVersion,
          versionAnchor,
        });
        const checks = summarizeClosureChecks(counts);
        const gaps = collectClosureGaps(counts);
        if (gaps.length > 0) {
          // 🔴 这条路径上**一条写语句都没执行过** —— 事务里到此为止全是 SELECT。
          //    "不写半张 closure"因此是结构性的,不是靠回滚兜底。
          return { outcome: 'blocked', activityId, gaps, checks };
        }

        // 走到这里 ⇒ 八类全过 ⇒ 下面这三个锚点必然存在(检查已排除 null 形态)。
        // 断言而非 `!`:哪天有人把某一类检查改松,这里会当场抛而不是写出一张
        // 指针为空的 closure。
        if (run === null || postedVersion === null || evidence.activeSeal === null) {
          throw new BizException(BizCode.ACTIVITY_CLOSURE_SETTLEMENT_INCOMPLETE);
        }

        // ===== ⑩ checksJson / checksHash 与摘要(§5.15 ⑩ + §3.26)=====
        const totals = await this.readTotals(tx, activityId, versionAnchor);
        const checksJson = buildClosureChecksJson({
          counts,
          totals,
          operationKey: input.operationKey,
          requestHash: input.requestHash,
        });
        const checksHash = computeClosureChecksHash(checksJson);

        // ===== ⑪ 写 closure + 两个指针 + archive waiting + audit + 评价开放 intent =====
        const revision = (await this.readMaxRevision(tx, activityId)) + 1;
        const closedAt = activity.authoritativeNow;
        const archiveWaitingUntil = new Date(
          closedAt.getTime() + activity.archiveWaitingDays * 24 * 3600_000,
        );

        const closureRevisionId = await this.insertClosure(tx, {
          activityId,
          revision,
          settlementVersionId: postedVersion.id,
          postingBatchId: postedVersion.committedBatchId,
          evidenceSealId: evidence.activeSeal.id,
          evidenceRevision: evidence.evidenceRevision,
          populationRevision: evidence.populationRevision,
          workflowRevision: activity.workflowRevision,
          totals,
          checksHash,
          checksJson,
          closedByUserId: currentUser.id,
          closedAt,
        });

        // §5.15 ⑪「更新 Activity／Run current closure 指针」。两者都是**快速指针**,
        // 真相在刚写下的那一行上(§3.19 / §3.1 都逐字这么说)。
        await tx.activity.update({
          where: { id: activityId },
          data: { currentClosureRevision: revision },
        });
        await tx.attendanceSettlementRun.update({
          where: { id: run.id },
          data: {
            statusCode: 'closed',
            currentClosureRevision: revision,
            version: { increment: 1 },
          },
        });

        const closure: ActivityClosureResult = {
          closureRevisionId,
          activityId,
          revision,
          settlementRunId: run.id,
          settlementVersionId: postedVersion.id,
          postingBatchId: postedVersion.committedBatchId,
          evidenceSealId: evidence.activeSeal.id,
          evidenceRevision: evidence.evidenceRevision,
          populationRevision: evidence.populationRevision,
          workflowRevision: activity.workflowRevision,
          personCount: totals.personCount,
          sessionParticipationCount: totals.sessionParticipationCount,
          resultCountsJson: totals.resultCountsJson,
          serviceHours: totals.serviceHours,
          contributionPoints: totals.contributionPoints,
          checksHash,
          closedAt,
          archiveWaitingDays: activity.archiveWaitingDays,
          archiveWaitingUntil,
          checks,
          replayed: false,
        };

        // 评价开放 intent —— **必须在本事务内**(本仓 Outbox 铁律)。
        await this.notifications.enqueueClosed(tx, {
          activityId,
          activityTitle: activity.title,
          closureRevision: revision,
          settlementVersion: postedVersion.version,
          personCount: totals.personCount,
          serviceHours: totals.serviceHours,
          contributionPoints: totals.contributionPoints,
          archiveWaitingUntil,
          cohort: await freezeResponsibility(tx, {
            cohortKey: `settlement-closure:${activityId}:${revision}`,
            aggregateType: 'activity',
            aggregateIds: [activityId],
            basisRef: [`closureRevision:${revision}`],
            memberIds: [await this.readOwnerMemberId(tx, activityId)],
            at: closedAt,
          }),
        });

        // audit 刻意放**最后一步**:它是 goal DoD 9「intent 与 closure 一起回滚」
        // 那条判据的落点(e2e 让它抛错,断言上面全部回滚)。
        await this.audit.log({
          ...closure,
          operationKey: input.operationKey,
          requestHash: input.requestHash,
          actorUserId: currentUser.id,
          actorRoleSnap: currentUser.role,
          auditMeta,
          tx,
        });

        return { outcome: 'closed', closure };
      },
      { timeout: ACTIVITY_CLOSURE_TX_TIMEOUT_MS },
    );
  }

  // ===== ① Activity FOR UPDATE + authoritative now ==========================
  //
  // `now()` 与行锁在**同一条语句**里取:PostgreSQL 的 `now()` = 事务开始时刻,全事务内
  // 恒定 —— 一个事务只有一个"现在",不受应用进程时钟漂移影响,也不会在十二步之间
  // 自己往前走(沿第一刀封场的同一立场)。
  private async lockActivityAndReadNow(tx: PrismaTx, activityId: string): Promise<LockedActivity> {
    const rows = await tx.$queryRaw<LockedActivity[]>`
      SELECT title, "statusCode", "endAt", "terminatedAt", "workflowRevision",
             "archiveWaitingDays", now() AS "authoritativeNow"
      FROM "Activity"
      WHERE id = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return row;
  }

  // ===== ② 幂等 ============================================================
  //
  // 去重域是 **(activityId, operationKey)** —— 见文件头偏离说明 ①:
  // §3.26 没有给幂等列,键存在 `checksJson.idempotency` 里,而**能保证这次查询看得见
  // 上一次写入的,只有 ① 的 Activity 行锁**,那把锁是按活动的。跨活动同 key 因此不冲突,
  // 这是与第三/四/五刀(单列 unique,全局去重)的**实质差别**,如实标注不粉饰。
  private async findClosureByOperationKey(
    tx: PrismaTx,
    activityId: string,
    input: ActivityClosureInput,
  ): Promise<ActivityClosureResult | null> {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        revision: number;
        settlementVersionId: string;
        postingBatchId: string;
        evidenceSealId: string;
        evidenceRevision: number;
        populationRevision: number;
        workflowRevision: number;
        personCount: number;
        sessionParticipationCount: number;
        resultCountsJson: Record<string, number>;
        serviceHours: string;
        contributionPoints: string;
        checksHash: string;
        checksJson: ActivityClosureChecksJson;
        closedAt: Date;
        archiveWaitingDays: number;
        settlementRunId: string;
        requestHash: string | null;
      }>
    >`
      SELECT c.id, c.revision, c."settlementVersionId", c."postingBatchId", c."evidenceSealId",
             c."evidenceRevision", c."populationRevision", c."workflowRevision",
             c."personCount", c."sessionParticipationCount", c."resultCountsJson",
             c."serviceHours"::text AS "serviceHours",
             c."contributionPoints"::text AS "contributionPoints",
             c."checksHash", c."checksJson", c."closedAt",
             a."archiveWaitingDays",
             r.id AS "settlementRunId",
             c."checksJson" -> 'idempotency' ->> 'requestHash' AS "requestHash"
      FROM "ActivitySettlementClosureRevision" c
      JOIN "Activity" a ON a.id = c."activityId"
      JOIN "AttendanceSettlementRun" r ON r."activityId" = c."activityId"
      WHERE c."activityId" = ${activityId}
        AND c."checksJson" -> 'idempotency' ->> 'operationKey' = ${input.operationKey}
      ORDER BY c.revision DESC
      LIMIT 1
    `;
    const existing = rows[0];
    if (existing === undefined) return null;
    // 同 key **不同 payload** ⇒ 撞键,不是重放(第 1 批实测:复合唯一恰好放行这种形态,
    // 所以这条判据必须是显式比对)。
    if (existing.requestHash !== input.requestHash) {
      throw new BizException(BizCode.ACTIVITY_CLOSURE_OPERATION_KEY_CONFLICT);
    }
    return {
      closureRevisionId: existing.id,
      activityId,
      revision: existing.revision,
      settlementRunId: existing.settlementRunId,
      settlementVersionId: existing.settlementVersionId,
      postingBatchId: existing.postingBatchId,
      evidenceSealId: existing.evidenceSealId,
      evidenceRevision: existing.evidenceRevision,
      populationRevision: existing.populationRevision,
      workflowRevision: existing.workflowRevision,
      personCount: existing.personCount,
      sessionParticipationCount: existing.sessionParticipationCount,
      resultCountsJson: existing.resultCountsJson,
      serviceHours: existing.serviceHours,
      contributionPoints: existing.contributionPoints,
      checksHash: existing.checksHash,
      closedAt: existing.closedAt,
      archiveWaitingDays: existing.archiveWaitingDays,
      archiveWaitingUntil: new Date(
        existing.closedAt.getTime() + existing.archiveWaitingDays * 24 * 3600_000,
      ),
      checks: existing.checksJson.checks,
      replayed: true,
    };
  }

  // ===== ② 锁序第二把:run(本刀要写它)==================================
  //
  // ⚠️ **只加锁、不判状态**:状态闸属第 ⑤ 类检查,必须与其它七类一起跑完再一次性
  //    交出缺口清单。run 行不存在(从没生成过草稿)⇒ null,由第 ⑤ 类记成 `runNotPosted`。
  private async lockRun(tx: PrismaTx, activityId: string): Promise<LockedRun | null> {
    const rows = await tx.$queryRaw<LockedRun[]>`
      SELECT id, "statusCode", "currentPostedVersion"
      FROM "AttendanceSettlementRun"
      WHERE "activityId" = ${activityId}
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  // ===== ③ EvidenceState + active EvidenceSeal ==============================
  //
  // 两个 revision 的真源是 `ActivityEvidenceState`(§3.17);`workflowRevision` 的真源是
  // **已加锁的 Activity 行**(§4.2)—— 与第一刀封场逐字同源,那里也记了这处合同不一致。
  // 行不存在 = 该活动至今没有任何证据/人口变化 ⇒ (0, 0),与 §3.1 两个 default 一致。
  private async readEvidenceFacts(
    tx: PrismaTx,
    activityId: string,
    workflowRevision: number,
  ): Promise<{
    evidenceRevision: number;
    populationRevision: number;
    activeSeal: {
      id: string;
      evidenceRevision: number;
      populationRevision: number;
      workflowRevision: number;
    } | null;
    sealStale: boolean;
  }> {
    const state = await tx.activityEvidenceState.findUnique({
      where: { activityId },
      select: { evidenceRevision: true, populationRevision: true },
    });
    const evidenceRevision = state?.evidenceRevision ?? 0;
    const populationRevision = state?.populationRevision ?? 0;
    const activeSeal = await tx.evidenceSeal.findFirst({
      where: { activityId, statusCode: 'active' },
      orderBy: { sealRevision: 'desc' },
      select: {
        id: true,
        evidenceRevision: true,
        populationRevision: true,
        workflowRevision: true,
      },
    });
    const sealStale =
      activeSeal !== null &&
      (activeSeal.evidenceRevision !== evidenceRevision ||
        activeSeal.populationRevision !== populationRevision ||
        activeSeal.workflowRevision !== workflowRevision);
    return { evidenceRevision, populationRevision, activeSeal, sealStale };
  }

  /** run 指针指向的 posted 版本 + 它的 committed 批次(第 ⑦ 类要用批次号)。 */
  private async readPostedVersion(
    tx: PrismaTx,
    run: LockedRun,
  ): Promise<{ id: string; version: number; committedBatchId: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string; version: number; batchId: string | null }>>`
      SELECT v.id, v.version,
             (SELECT b.id FROM "LedgerPostingBatch" b
              WHERE b."settlementVersionId" = v.id AND b."statusCode" = 'committed'
              ORDER BY b."batchRevision" DESC LIMIT 1) AS "batchId"
      FROM "AttendanceSettlementVersion" v
      WHERE v."settlementRunId" = ${run.id} AND v.version = ${run.currentPostedVersion ?? -1}
    `;
    const row = rows[0];
    if (row === undefined || row.batchId === null) return null;
    return { id: row.id, version: row.version, committedBatchId: row.batchId };
  }

  // ===== ④–⑨ 八类计数 =====================================================

  private async evaluateChecks(
    tx: PrismaTx,
    ctx: {
      activityId: string;
      activity: LockedActivity;
      evidence: Awaited<ReturnType<ActivityClosureService['readEvidenceFacts']>>;
      run: LockedRun | null;
      postedVersion: { id: string; version: number; committedBatchId: string } | null;
      versionAnchor: string;
    },
  ): Promise<ActivityClosureCheckCounts> {
    const { activityId, activity, evidence, run, postedVersion, versionAnchor } = ctx;

    // ① 执行态(§5.15 ③ 前半 / §9.2 ①)。
    // 「自然结束」= authoritative now **严格晚于** endAt;「正式提前终止」= terminatedAt 有值。
    // 普通取消不伪造服务结算 ⇒ 单列一项,与"还没结束"分开计数(两者语义完全不同)。
    const ended =
      activity.terminatedAt !== null ||
      activity.authoritativeNow.getTime() > activity.endAt.getTime();
    const execution = {
      notEnded: ended ? 0 : 1,
      cancelled: activity.statusCode === 'cancelled' ? 1 : 0,
    };

    // ② 封场(§5.15 ③ 后半 / §9.2 ②)。
    const evidenceCounts = {
      missingActiveSeal: evidence.activeSeal === null ? 1 : 0,
      staleSeal: evidence.sealStale ? 1 : 0,
    };

    // ③④ 待办 + 参与终态:两类一条 SQL 取回(都是按 activityId 的独立聚合)。
    const [pending] = await tx.$queryRaw<
      Array<{
        pendingChangeReview: number;
        pendingCorrection: number;
        openSegment: number;
        unfinishedJob: number;
        nonTerminalRegistration: number;
        pendingInvitation: number;
        unresolvedIdentity: number;
        populationIdentityNotParticipating: number;
        participatingIdentityOutOfPopulation: number;
        participatingRegistrationWithoutIdentity: number;
      }>
    >`
      SELECT
        -- ⚠️ 物理表名是 activity_publish_reviews(全仓少数带 @@map 的表之一)——
        -- 写成 model 名会在运行期 42P01,而 typecheck 不会告诉你(裸 SQL)。
        (SELECT count(*) FROM "activity_publish_reviews" pr
          WHERE pr."activityId" = ${activityId} AND pr.status = 'pending')::int
          AS "pendingChangeReview",
        (SELECT count(*) FROM "AttendanceCorrectionRequest" cr
          WHERE cr."activityId" = ${activityId}
            AND cr."statusCode" = ANY(${CORRECTION_OPEN}::text[]))::int
          AS "pendingCorrection",
        -- §4.5 的 open 段 = 未被顶掉、未作废、且还没签退。三个谓词的列均 NOT NULL
        -- 或用 IS NULL 判定 ⇒ 恒二值,不存在三值逻辑塌陷。
        (SELECT count(*) FROM "ParticipantServiceSegmentRevision" s
           JOIN "ActivityParticipationIdentity" i ON i.id = s."participationIdentityId"
          WHERE i."activityId" = ${activityId}
            AND s."statusCode" <> 'superseded'
            AND s."resultCode" NOT IN ('voided', 'replaced')
            AND s."checkOutAt" IS NULL)::int
          AS "openSegment",
        (SELECT count(*) FROM "ActivityBatchJob" j
          WHERE j."activityId" = ${activityId}
            AND NOT (j."statusCode" = ANY(${JOB_FINISHED}::text[])))::int
          AS "unfinishedJob",
        (SELECT count(*) FROM "ActivityRegistration" r
          WHERE r."activityId" = ${activityId} AND r."deletedAt" IS NULL
            AND r."statusCode" = ANY(${REGISTRATION_UNRESOLVED}::text[]))::int
          AS "nonTerminalRegistration",
        (SELECT count(*) FROM "ActivityInvitation" inv
          WHERE inv."activityId" = ${activityId} AND inv."statusCode" = 'pending')::int
          AS "pendingInvitation",
        (SELECT count(*) FROM "ActivityParticipationIdentity" i
          WHERE i."activityId" = ${activityId}
            AND i."currentStatusCode" = ANY(${IDENTITY_UNRESOLVED}::text[]))::int
          AS "unresolvedIdentity",
        -- 「一一对应」的两侧。刻意与上一项**互斥**(这里只数已经终态、但不算参加的),
        -- 否则同一行会在同一类里被数两遍,count 就不再是"缺多少个"。
        (SELECT count(*) FROM "ActivityParticipationIdentity" i
          WHERE i."activityId" = ${activityId} AND i."populationIncluded" = true
            AND i."currentStatusCode" = ANY(${IDENTITY_EXCLUDED}::text[]))::int
          AS "populationIdentityNotParticipating",
        (SELECT count(*) FROM "ActivityParticipationIdentity" i
          WHERE i."activityId" = ${activityId} AND i."populationIncluded" = false
            AND i."currentStatusCode" = ANY(${IDENTITY_PARTICIPATING}::text[]))::int
          AS "participatingIdentityOutOfPopulation",
        -- 「参与类报名」用补集定义(见 REGISTRATION_NON_PARTICIPATING 的注释)。
        (SELECT count(*) FROM "ActivityRegistration" r
          WHERE r."activityId" = ${activityId} AND r."deletedAt" IS NULL
            AND NOT (r."statusCode" = ANY(${REGISTRATION_NON_PARTICIPATING}::text[]))
            AND NOT EXISTS (SELECT 1 FROM "ActivityParticipationIdentity" i
                             WHERE i."registrationId" = r.id))::int
          AS "participatingRegistrationWithoutIdentity"
    `;

    // ⑤ 结算覆盖(§5.15 ⑥ / §9.2 ⑦⑨)。
    const [settlementRows] = await tx.$queryRaw<
      Array<{
        populationWithoutResult: number;
        resultOutOfPopulation: number;
        uncommittedResult: number;
      }>
    >`
      SELECT
        -- ⭐ §9.2 那句「30 个队员×场次尚未处理」就是这一项。没有 posted 版本时
        -- versionAnchor = '' ⇒ 一行都匹配不上 ⇒ 整个人口都记在这里。
        (SELECT count(*) FROM "ActivityParticipationIdentity" i
          WHERE i."activityId" = ${activityId} AND i."populationIncluded" = true
            AND NOT EXISTS (SELECT 1 FROM "ParticipantSettlementResultRevision" rr
                             WHERE rr."participationIdentityId" = i.id
                               AND rr."settlementVersionId" = ${versionAnchor}))::int
          AS "populationWithoutResult",
        (SELECT count(*) FROM "ParticipantSettlementResultRevision" rr
           JOIN "ActivityParticipationIdentity" i ON i.id = rr."participationIdentityId"
          WHERE rr."settlementVersionId" = ${versionAnchor}
            AND i."populationIncluded" = false)::int
          AS "resultOutOfPopulation",
        (SELECT count(*) FROM "ParticipantSettlementResultRevision" rr
          WHERE rr."settlementVersionId" = ${versionAnchor}
            AND rr."statusCode" <> 'committed')::int
          AS "uncommittedResult"
    `;
    const settlement = {
      // ⚠️ `closed` **也算数**:§3.19 的九值链里它在 `posted` **下游**(账已经生效过一次,
      //    run 才可能走到 closed)。只认 `posted` 会有两个后果,都是错的:
      //    ① 更正后按 §5.14 重新关账时,run 还带着上一次关账留下的 `closed`,本类会诬告
      //       "结算未生效",把第 ⑧ 类才该管的事变成一堆假缺口;
      //    ② 并发败者收到的缺口清单会混进 settlement/ledger 两类噪声,而真正的原因
      //       只有一条"已有生效关闭版本"。
      //    「不许重复关闭」的执法位是第 ⑧ 类 + DB partial unique,不是这里。
      runNotPosted:
        run !== null && (run.statusCode === 'posted' || run.statusCode === 'closed') ? 0 : 1,
      postedVersionMissing: postedVersion === null ? 1 : 0,
      populationWithoutResult: settlementRows?.populationWithoutResult ?? 0,
      resultOutOfPopulation: settlementRows?.resultOutOfPopulation ?? 0,
      uncommittedResult: settlementRows?.uncommittedResult ?? 0,
    };

    // ⑥ 结果一致性(§5.15 ⑦ / §9.2 ⑧)。
    //
    // ⚠️ 「零时长结果」用 `resultCode <> 'present'` 的**补集**定义:§3.20 的十值闭集里
    //    只有 present 会带时长与贡献,其余九个(含 early_departure_zero / exempt)都必须为 0。
    //    补集写法在闭集日后扩展时**fail-closed**(新值默认必须为零),比枚举九个安全。
    const [consistency] = await tx.$queryRaw<
      Array<{
        presentWithoutSegment: number;
        zeroResultWithNonZeroTotals: number;
        flagMismatch: number;
        earlyDepartureFlagMissing: number;
      }>
    >`
      SELECT
        count(*) FILTER (
          WHERE rr."resultCode" = 'present'
            AND NOT EXISTS (
              SELECT 1 FROM "ParticipantServiceSegmentRevision" s
               WHERE s."participationIdentityId" = rr."participationIdentityId"
                 AND s."statusCode" <> 'superseded'
                 AND s."resultCode" = 'valid'
                 AND s."checkOutAt" IS NOT NULL)
        )::int AS "presentWithoutSegment",
        count(*) FILTER (
          WHERE rr."resultCode" <> 'present'
            AND (rr."recognizedServiceHours" <> 0 OR rr."recognizedContributionPoints" <> 0)
        )::int AS "zeroResultWithNonZeroTotals",
        count(*) FILTER (
          WHERE rr."lateFlag" <> EXISTS (
                  SELECT 1 FROM "ParticipantServiceSegmentRevision" s
                   WHERE s."participationIdentityId" = rr."participationIdentityId"
                     AND s."statusCode" <> 'superseded'
                     AND s."resultCode" NOT IN ('voided', 'replaced')
                     AND s."lateFlag" = true)
             OR rr."earlyLeaveFlag" <> EXISTS (
                  SELECT 1 FROM "ParticipantServiceSegmentRevision" s
                   WHERE s."participationIdentityId" = rr."participationIdentityId"
                     AND s."statusCode" <> 'superseded'
                     AND s."resultCode" NOT IN ('voided', 'replaced')
                     AND s."earlyLeaveFlag" = true)
        )::int AS "flagMismatch",
        count(*) FILTER (
          WHERE rr."resultCode" = 'early_departure_zero' AND rr."earlyLeaveFlag" = false
        )::int AS "earlyDepartureFlagMissing"
      FROM "ParticipantSettlementResultRevision" rr
      WHERE rr."settlementVersionId" = ${versionAnchor}
    `;

    // ⑦ 账本 / 日上限 / 重叠 / 对账(§5.15 ⑧ / §9.2 ⑨⑩⑪)。
    const dailyCap = new Prisma.Decimal(GLOBAL_DAILY_CONTRIBUTION_CAP).toFixed(2);
    const [ledgerRows] = await tx.$queryRaw<
      Array<{
        committedBatchCount: number;
        entriesInUncommittedBatch: number;
        resultWithoutLedgerEntry: number;
        dayCapExceeded: number;
        duplicatePosting: number;
        overlappingSegment: number;
        capacityReconciliationMismatch: number;
      }>
    >`
      SELECT
        (SELECT count(*) FROM "LedgerPostingBatch" b
          WHERE b."settlementVersionId" = ${versionAnchor} AND b."statusCode" = 'committed')::int
          AS "committedBatchCount",
        -- §3.22:准备中 / ready 的分录对所有正常读面不可见 ⇒ 还有这种分录 = 账没记完。
        (SELECT count(*) FROM "ParticipationLedgerEntry" e
           JOIN "LedgerPostingBatch" b ON b.id = e."postingBatchId"
          WHERE e."activityId" = ${activityId}
            AND b."statusCode" IN ('preparing', 'ready'))::int
          AS "entriesInUncommittedBatch",
        (SELECT count(*) FROM "ParticipantSettlementResultRevision" rr
          WHERE rr."settlementVersionId" = ${versionAnchor}
            AND (rr."recognizedServiceHours" > 0 OR rr."recognizedContributionPoints" > 0)
            AND NOT EXISTS (
              SELECT 1 FROM "ParticipationLedgerEntry" e
                JOIN "LedgerPostingBatch" b ON b.id = e."postingBatchId"
               WHERE e."resultRevisionId" = rr.id AND b."statusCode" = 'committed'))::int
          AS "resultWithoutLedgerEntry",
        -- §3.24 日合计 0..3 的**关账侧复核**。第五刀在 member 锁内已判过一次;
        -- 这里再读一次持久化日合计,守的是"生效之后又被别的路径改过"。
        (SELECT count(*) FROM (
            SELECT DISTINCT e."memberId", e."ledgerDate"
              FROM "ParticipationLedgerEntry" e
              JOIN "LedgerPostingBatch" b ON b.id = e."postingBatchId"
             WHERE e."activityId" = ${activityId} AND b."statusCode" = 'committed') t
           JOIN "MemberContributionDayState" d
             ON d."memberId" = t."memberId" AND d."ledgerDate" = t."ledgerDate"
          WHERE d."committedCreditedPoints" > ${dailyCap}::numeric)::int
          AS "dayCapExceeded",
        -- §9.2 ⑪「重复正式账」:同一 (结果版本, 北京日, 分录类型) 在**已生效**批次里
        -- 出现多于一条 ⇒ 双重入账。表上的 unique 只按单个批次收口,跨批次拦不住。
        (SELECT count(*) FROM (
            SELECT 1 FROM "ParticipationLedgerEntry" e
              JOIN "LedgerPostingBatch" b ON b.id = e."postingBatchId"
             WHERE e."activityId" = ${activityId} AND b."statusCode" = 'committed'
             GROUP BY e."resultRevisionId", e."ledgerDate", e."entryTypeCode"
            HAVING count(*) > 1) t)::int
          AS "duplicatePosting",
        -- §3.18「时间重叠校验在现有 member lock 内完成」⇒ DB 侧刻意零 exclusion
        -- constraint(第 1 批已用 e2e 钉死)。关账是最后一次把它数出来的机会。
        -- 用 c.id > a.id 让每一对只数一次;只数已闭合的段(开放段归第 ③ 类)。
        (SELECT count(*) FROM "ParticipantServiceSegmentRevision" a
           JOIN "ParticipantServiceSegmentRevision" c
             ON c."participationIdentityId" = a."participationIdentityId" AND c.id > a.id
           JOIN "ActivityParticipationIdentity" i ON i.id = a."participationIdentityId"
          WHERE i."activityId" = ${activityId}
            AND a."statusCode" <> 'superseded' AND a."resultCode" NOT IN ('voided', 'replaced')
            AND c."statusCode" <> 'superseded' AND c."resultCode" NOT IN ('voided', 'replaced')
            AND a."checkOutAt" IS NOT NULL AND c."checkOutAt" IS NOT NULL
            AND a."checkInAt" < c."checkOutAt" AND c."checkInAt" < a."checkOutAt")::int
          AS "overlappingSegment",
        -- §9.2 ⑪「名额对账异常」= 桶上的物化计数与真实 active 占位不符(§3.10)。
        (SELECT count(*) FROM "ActivityCapacityBucket" bu
          WHERE bu."activityId" = ${activityId}
            AND bu.occupied <> (SELECT count(*)::int FROM "CapacityReservation" res
                                 WHERE res."bucketId" = bu.id AND res.status = 'active'))::int
          AS "capacityReconciliationMismatch"
    `;
    const ledger = {
      // 恰好一个 committed 批次才算数:0 = 账没生效,>1 = 同一版本有两笔正式账。
      committedBatchMissing: ledgerRows?.committedBatchCount === 1 ? 0 : 1,
      entriesInUncommittedBatch: ledgerRows?.entriesInUncommittedBatch ?? 0,
      resultWithoutLedgerEntry: ledgerRows?.resultWithoutLedgerEntry ?? 0,
      dayCapExceeded: ledgerRows?.dayCapExceeded ?? 0,
      duplicatePosting: ledgerRows?.duplicatePosting ?? 0,
      overlappingSegment: ledgerRows?.overlappingSegment ?? 0,
      capacityReconciliationMismatch: ledgerRows?.capacityReconciliationMismatch ?? 0,
    };

    const manualReviewPending = await tx.offlinePunchReviewItem.count({
      where: { activityId, statusCode: 'pending' },
    });

    // ⑧ active closure(§5.15 ⑨)。
    const activeClosure = await tx.activitySettlementClosureRevision.count({
      where: { activityId, statusCode: 'active' },
    });

    return {
      execution,
      evidence: evidenceCounts,
      pendingWork: {
        pendingChangeReview: pending?.pendingChangeReview ?? 0,
        pendingCorrection: pending?.pendingCorrection ?? 0,
        manualReviewPending,
        openSegment: pending?.openSegment ?? 0,
        unfinishedJob: pending?.unfinishedJob ?? 0,
      },
      participation: {
        nonTerminalRegistration: pending?.nonTerminalRegistration ?? 0,
        pendingInvitation: pending?.pendingInvitation ?? 0,
        unresolvedIdentity: pending?.unresolvedIdentity ?? 0,
        populationIdentityNotParticipating: pending?.populationIdentityNotParticipating ?? 0,
        participatingIdentityOutOfPopulation: pending?.participatingIdentityOutOfPopulation ?? 0,
        participatingRegistrationWithoutIdentity:
          pending?.participatingRegistrationWithoutIdentity ?? 0,
      },
      settlement,
      resultConsistency: {
        presentWithoutSegment: consistency?.presentWithoutSegment ?? 0,
        zeroResultWithNonZeroTotals: consistency?.zeroResultWithNonZeroTotals ?? 0,
        flagMismatch: consistency?.flagMismatch ?? 0,
        earlyDepartureFlagMissing: consistency?.earlyDepartureFlagMissing ?? 0,
      },
      ledger,
      closure: { activeClosure },
    };
  }

  // ===== ⑩ 摘要(§3.26 的五个摘要列)======================================
  //
  // 🔴 全部是**计数与合计**,一条人员明细都没有(§3.26:「仅保存非敏感摘要和失败计数,
  //    不复制人员明细」)。金额取**已生效分录**的合计 —— 关账盖的就是那本账的章:
  //    `serviceHours` = Σ serviceHoursDelta,`contributionPoints` = Σ **credited**(实发,
  //    已扣日上限),不是 recognized(封顶前的认定值)。
  private async readTotals(
    tx: PrismaTx,
    activityId: string,
    versionAnchor: string,
  ): Promise<ActivityClosureTotals> {
    const [head] = await tx.$queryRaw<
      Array<{
        personCount: number;
        sessionParticipationCount: number;
        serviceHours: string;
        contributionPoints: string;
      }>
    >`
      SELECT
        (SELECT count(DISTINCT i."memberId") FROM "ActivityParticipationIdentity" i
          WHERE i."activityId" = ${activityId} AND i."populationIncluded" = true)::int
          AS "personCount",
        (SELECT count(*) FROM "ActivityParticipationIdentity" i
          WHERE i."activityId" = ${activityId} AND i."populationIncluded" = true)::int
          AS "sessionParticipationCount",
        (SELECT COALESCE(SUM(e."serviceHoursDelta"), 0) FROM "ParticipationLedgerEntry" e
           JOIN "LedgerPostingBatch" b ON b.id = e."postingBatchId"
          WHERE e."activityId" = ${activityId} AND b."statusCode" = 'committed')::text
          AS "serviceHours",
        (SELECT COALESCE(SUM(e."creditedPointsDelta"), 0) FROM "ParticipationLedgerEntry" e
           JOIN "LedgerPostingBatch" b ON b.id = e."postingBatchId"
          WHERE e."activityId" = ${activityId} AND b."statusCode" = 'committed')::text
          AS "contributionPoints"
    `;
    const resultRows = await tx.$queryRaw<Array<{ resultCode: string; count: number }>>`
      SELECT rr."resultCode", count(*)::int AS count
      FROM "ParticipantSettlementResultRevision" rr
      WHERE rr."settlementVersionId" = ${versionAnchor}
      GROUP BY rr."resultCode"
      ORDER BY rr."resultCode" ASC
    `;
    const resultCountsJson: Record<string, number> = {};
    for (const row of resultRows) resultCountsJson[row.resultCode] = row.count;
    return {
      personCount: head?.personCount ?? 0,
      sessionParticipationCount: head?.sessionParticipationCount ?? 0,
      resultCountsJson,
      // 归一到两位小数:§3.26 的两列是 numeric(12,2),SUM 出来的文本形态随分录条数
      // 变化(`0` / `8.00` / `8`),不归一会让 checksHash 在同样事实上漂移。
      serviceHours: new Prisma.Decimal(head?.serviceHours ?? '0').toFixed(2),
      contributionPoints: new Prisma.Decimal(head?.contributionPoints ?? '0').toFixed(2),
    };
  }

  private async readMaxRevision(tx: PrismaTx, activityId: string): Promise<number> {
    const max = await tx.activitySettlementClosureRevision.aggregate({
      where: { activityId },
      _max: { revision: true },
    });
    return max._max.revision ?? 0;
  }

  // ===== ⑪ 写不可变 closure ===============================================
  //
  // 🔴 goal DoD 6:P2002(撞 `activity_settlement_closure_active_unique`)必须翻成具名码,
  //    **不让 Prisma 异常裸奔成 500**。这条 partial unique 是"一活动至多一个 active
  //    closure"的 DB 兜底;第 ⑧ 类检查是它的锁后具名版本 —— 两者都要,因为检查发生在
  //    本事务内,而 partial unique 守的是"绕过本 service 直接写"的路径。
  private async insertClosure(
    tx: PrismaTx,
    data: {
      activityId: string;
      revision: number;
      settlementVersionId: string;
      postingBatchId: string;
      evidenceSealId: string;
      evidenceRevision: number;
      populationRevision: number;
      workflowRevision: number;
      totals: ActivityClosureTotals;
      checksHash: string;
      checksJson: ActivityClosureChecksJson;
      closedByUserId: string;
      closedAt: Date;
    },
  ): Promise<string> {
    try {
      const created = await tx.activitySettlementClosureRevision.create({
        data: {
          activityId: data.activityId,
          revision: data.revision,
          settlementVersionId: data.settlementVersionId,
          postingBatchId: data.postingBatchId,
          evidenceSealId: data.evidenceSealId,
          evidenceRevision: data.evidenceRevision,
          populationRevision: data.populationRevision,
          workflowRevision: data.workflowRevision,
          personCount: data.totals.personCount,
          sessionParticipationCount: data.totals.sessionParticipationCount,
          resultCountsJson: data.totals.resultCountsJson,
          serviceHours: data.totals.serviceHours,
          contributionPoints: data.totals.contributionPoints,
          checksHash: data.checksHash,
          checksJson: JSON.parse(JSON.stringify(data.checksJson)) as Prisma.InputJsonValue,
          statusCode: 'active',
          closedByUserId: data.closedByUserId,
          closedAt: data.closedAt,
        },
        select: { id: true },
      });
      return created.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BizException(BizCode.ACTIVITY_CLOSURE_ALREADY_ACTIVE);
      }
      throw error;
    }
  }

  /** 通知收件人:活动当前 active owner —— 与前五刀逐字同口径。 */
  private async readOwnerMemberId(tx: PrismaTx, activityId: string): Promise<string | null> {
    const owner = await tx.activityResponsibilityAssignment.findFirst({
      where: { activityId, responsibilityType: 'owner', status: 'active' },
      orderBy: { startedAt: 'desc' },
      select: { memberId: true },
    });
    return owner?.memberId ?? null;
  }
}
