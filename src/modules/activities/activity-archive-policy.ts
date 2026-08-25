import { Injectable } from '@nestjs/common';

import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';

/*
 * 活动归档的**两套开工条件**(合同 §6.6 + AC-004 / AC-064;维护者 2026-08-25 拍板)。
 *
 * 拍板原文:「**同一个标记,两套开工条件**」——
 *   | 归档谁       | 条件                                              |
 *   | 草稿         | 长期无人处理                                       |
 *   | 办完的活动    | 结算已关账 **且** 过了 `archiveWaitingDays`         |
 *
 * ## 🔴 两套条件为什么在结构上不可能互相越界
 *
 * 走哪条路**只由 `statusCode` 决定**,且两条分支各自只读自己那一半事实:
 *   - 草稿路径(`statusCode === 'draft'`)**一个字都不读** `activeClosure`;
 *   - 结算路径(其余可归档态)**一个字都不读** `updatedAt`。
 * ⇒「拿草稿的条件去放行一个已办完的活动」在这里不是靠测试兜住的,是**取不到那个入参**。
 *   判据(activity-archive-policy.spec.ts)因此能给出两条交叉反向:
 *   已办完 + 陈旧 30 天 + 无 closure ⇒ 拒 20156;草稿 + 有 closure + 等待期已过 ⇒ 拒 20155。
 *
 * ## 职责边界(沿本仓 Policy 类惯例:纯决策)
 *
 * - ✅ 给定事实 → 返回 decision(allowed + reasonCode | biz)
 * - ❌ 不查库 / 不写库 / 不抛异常 / 不取 now()(now 由调用方从**同事务** `now()` 传入 ——
 *      取本机墙钟会让重放算出另一个答案)
 * - ❌ 不判「这个态能不能归档」—— 那是 ActivityStateMachine 的边,本类只判**量**
 *
 * ## 草稿阈值 30 天:依据与它的不确定性
 *
 * 🔴 **合同没给这个数**(§6.6 只写「长期无人处理草稿…支持后台人工归档」,零阈值),
 *    维护者的三问拍板里也没有它 ⇒ 本刀取 30 天是**提议值,待裁**,已在交付报告里单列。
 * 依据三条:
 *   ① 活动筹备周期以周计。取 7 天(= 现成的 `archiveWaitingDays` 默认值)会把
 *      正常在筹备中、两周没动的草稿判成「无人处理」—— 那是可证伪的误报。
 *   ② 30 天是仓内已有的量级(评价自最新关账开放 **30 天**),不新造一个数量级。
 *   ③ 归档**可撤销**(本刀同时交付 unarchive)⇒ 阈值取偏的代价是可逆的,不必过度保守。
 * 🔴 **刻意不落成 DB 列**:合同没定义它、维护者没拍板,落列就是「先占位以后再用」;
 *    改一个常量比改一列 + 一条 migration 便宜得多,而它现在最可能被改。
 *
 * ## 「无人处理」的锚为什么是 updatedAt
 *
 * `Activity.updatedAt` 是 Prisma `@updatedAt`,任何一次写(改标题、加场次经由活动行、
 * 提交发布审核回写)都会推它。⇒ 它恰好是「最后一次有人碰过这个草稿」。
 * ⚠️ 反面:纯读不推它,所以「有人看过但没改」不算处理 —— 这与「无人**处理**」的字面一致。
 *
 * 🔴 **归档与撤销归档这两个动作自己也会推它**(它们都走 `activity.update`)。
 *    首跑 e2e 时这一条推翻了「撤销后可以立刻再归档」的原始假设 —— 而**当前行为是对的**:
 *    撤销归档就是一次真实的人为处理(有人把草稿从抽屉里拿了回来),时钟理应在那一刻重置。
 *    否则「长期无人处理」会退化成一次性条件:归过一次以后,任何时候都能随手再归一次。
 *    ⇒ 归 → 撤 → 立刻再归 = **拒 20155**,要等它重新放满阈值。
 *    判据:`activity-archive-action.e2e-spec.ts`「撤销归档本身也算「有人处理了」」(两侧都钉)。
 */

/** 草稿被判为「长期无人处理」的阈值(天)。见文件头「30 天:依据与它的不确定性」。 */
export const STALE_DRAFT_ARCHIVE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 归档留痕里的 `archiveReasonCode`:事后能回答「这条为什么准归档」。 */
export type ActivityArchiveReasonCode = 'stale_draft' | 'settled';

export interface ActivityArchiveClosureFacts {
  /** 最新一张**生效** closure 的关账时刻。 */
  readonly closedAt: Date;
}

export interface ActivityArchiveInput {
  readonly statusCode: string;
  /** 草稿路径的「无人处理」锚。结算路径**不读**它。 */
  readonly updatedAt: Date;
  /** 权威 now:调用方从与行锁同一事务的 `SELECT now()` 取,不用本机墙钟。 */
  readonly now: Date;
  /** 合同 §3.1 的现成列 `Activity.archiveWaitingDays`(默认 7,0..365)。 */
  readonly archiveWaitingDays: number;
  /** 最新生效 closure;`null` = 从未关账。草稿路径**不读**它。 */
  readonly activeClosure: ActivityArchiveClosureFacts | null;
}

export type ActivityArchiveDecision =
  | { allowed: true; reasonCode: ActivityArchiveReasonCode }
  | { allowed: false; biz: BizCodeEntry };

/**
 * 「这是一份长期无人处理的草稿吗」—— AC-004 的**工作台提示**与归档闸共用的**同一个**判据。
 *
 * 🔴 共用不是为了省几行:两处各写一遍必然漂移,而漂移的形态恰恰是最坏的那种 ——
 *    工作台亮着「可归档」,点下去被 20155 拒;或者反过来,能归档却不提示,
 *    于是这条 AC 的「提示」半格永远没人发现是坏的。
 */
export function isStaleDraft(statusCode: string, updatedAt: Date, now: Date): boolean {
  if (statusCode !== 'draft') return false;
  return now.getTime() - updatedAt.getTime() >= STALE_DRAFT_ARCHIVE_DAYS * DAY_MS;
}

@Injectable()
export class ActivityArchivePolicy {
  decide(input: ActivityArchiveInput): ActivityArchiveDecision {
    if (input.statusCode === 'draft') return this.decideStaleDraft(input);
    return this.decideSettled(input);
  }

  /**
   * 草稿路径:`now - updatedAt >= STALE_DRAFT_ARCHIVE_DAYS`。
   * 边界含端点(恰好第 30 天准归档)—— 与结算路径的等待期同一取向,不让两条路各有一套边界习惯。
   */
  private decideStaleDraft(input: ActivityArchiveInput): ActivityArchiveDecision {
    if (!isStaleDraft(input.statusCode, input.updatedAt, input.now)) {
      return { allowed: false, biz: BizCode.ACTIVITY_ARCHIVE_DRAFT_NOT_STALE };
    }
    return { allowed: true, reasonCode: 'stale_draft' };
  }

  /**
   * 结算路径:① 存在生效 closure;② `now >= closedAt + archiveWaitingDays 天`。
   *
   * ⚠️ 两格**分开判、各给各的码**:合并成一个「不满足结算归档条件」会让运营分不清
   * 「账还没关」和「关了但还要等几天」—— 前者要去关账,后者只能等。
   * ⚠️ `archiveWaitingDays = 0` 时第二格恒真(closedAt 当刻即可归档),这是合同允许的配置,
   * 不特判成「至少等一天」。
   */
  private decideSettled(input: ActivityArchiveInput): ActivityArchiveDecision {
    if (input.activeClosure === null) {
      return { allowed: false, biz: BizCode.ACTIVITY_ARCHIVE_NOT_CLOSED };
    }
    const waitingUntilMs =
      input.activeClosure.closedAt.getTime() + input.archiveWaitingDays * DAY_MS;
    if (input.now.getTime() < waitingUntilMs) {
      return { allowed: false, biz: BizCode.ACTIVITY_ARCHIVE_WAITING_PERIOD_NOT_ELAPSED };
    }
    return { allowed: true, reasonCode: 'settled' };
  }
}
