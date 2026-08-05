import { Prisma } from '@prisma/client';

import { splitSpanByBeijingDay } from '../../common/datetime/date-only.util';
import { GLOBAL_DAILY_CONTRIBUTION_CAP } from '../team-join/team-join.constants';

// ===== 活动改造 v1.1 第 2 批第五刀:北京日拆分 + 日上限分配(纯函数)=====
//
// 🔴 **这一段是账本里"谁拿到分、谁被截掉"的全部算术。** 它错了不会报错 ——
//    会安静地产出一个看起来正常的账本。所以它被抽成**没有 DB、没有时钟、没有随机**
//    的纯函数,由 `ledger-day-allocation.spec.ts` 逐条钉住。
//
// ## 三件事,分成三个函数
//
//   ① `splitRecognizedIntoDays` —— 把一个人在一个场次上的**认定值**(recognized)
//      按北京自然日拆开(§3.21 / §5.12 ③)。
//   ② `allocateDailyCredit`   —— 在一个 (member, ledgerDate) 上按稳定服务顺序
//      分配日上限,算出 credited / cappedOut(§5.12 ⑤ + §3.24)。
//   ③ `dayTotalWithinCap`     —— 生效时的最终判定(§3.24 末句「日合计必须 0..3」)。
//
// ## 为什么拆的是「认定值」而不是「实际时长」
//
// §3.20 允许负责人把**认定**值调得与**计算**值不同(`adjustmentReason` 必填)。
// 账本记的是认定值。所以本模块拿服务段只当**权重**(哪一天占多少比例),
// 被分配的总量恒是 `recognizedServiceHours` / `recognizedContributionPoints`。
// ⇒ 逐日求和**恒等于**认定总量(最大余额法保证,见下),不会因为四舍五入丢分。
//
// ## 精度:全程整数「分」(hundredths),不碰浮点
//
// 四个金额列都是 `numeric(5,2)`。若用浮点做比例分配,`0.1 + 0.2 !== 0.3` 这类误差
// 会直接变成账面上的一分钱差额,而且只在某些数据上出现 —— 正是本刀最怕的
// "看起来正常的账"。故本模块内部一律用 `Math.round(value * 100)` 换算成整数分,
// 加减比较全在整数域完成,只在出口除回 100。
//
// ## 舍入:最大余额法(largest remainder),不是逐项四舍五入
//
// 逐项四舍五入的和**不等于**总量(3 天平分 1.00 分 ⇒ 0.33×3 = 0.99,丢 1 分)。
// 最大余额法先按整数分下取整,再把剩下的余数**按小数部分从大到小**逐个补 1 分,
// 平局时按输入顺序(已经是稳定序)—— 逐日求和恒等于总量,且完全确定性。

/** §3.24「日合计必须 0..3」的上限。复用全仓既有常量,❌ 不在本模块另立第二个 3。 */
export const LEDGER_DAILY_CREDIT_CAP_HUNDREDTHS = decimalToHundredths(
  GLOBAL_DAILY_CONTRIBUTION_CAP,
);

/** 一段服务时间。`endAt === null` = 开放段 —— 本模块直接忽略(没有签退就没有时长)。 */
export interface LedgerServiceSpan {
  readonly startAt: Date;
  readonly endAt: Date | null;
}

export interface LedgerDaySplitInput {
  readonly spans: readonly LedgerServiceSpan[];
  /** 认定服务时长(小时,2 位小数)。 */
  readonly recognizedServiceHours: number;
  /** 认定贡献值(2 位小数)。 */
  readonly recognizedContributionPoints: number;
  /** §3.21 `stableOrderKey`:同起点时的确定性 tiebreaker,由调用方给出。 */
  readonly stableOrderKey: string;
}

export interface LedgerDaySplitRow {
  readonly ledgerDate: Date;
  readonly serviceHours: number;
  readonly recognizedPoints: number;
  /** 该日服务的最早起点(§3.21 `sequenceStartAt`,日内排序第一键)。 */
  readonly sequenceStartAt: Date;
  readonly stableOrderKey: string;
}

/**
 * 拆分结果。
 *
 * `no_service_day` = **有非零认定值却一天都归不上**(一条闭合服务段都没有)。
 * 这时**不许**猜一个日期:随手挂到活动日/场次日等于发明一个从未发生过的服务事实,
 * 而且会直接改变该队员当日的上限分配。调用方必须拒绝(20078)。
 */
export type LedgerDaySplitOutcome =
  | { readonly kind: 'split'; readonly rows: readonly LedgerDaySplitRow[] }
  | { readonly kind: 'no_service_day' };

export function splitRecognizedIntoDays(input: LedgerDaySplitInput): LedgerDaySplitOutcome {
  const hoursHundredths = toHundredths(input.recognizedServiceHours);
  const pointsHundredths = toHundredths(input.recognizedContributionPoints);

  // 权重 = 每个北京自然日实际占用的毫秒数(开放段没有时长,不参与)。
  const millisecondsByDate = new Map<number, number>();
  const earliestStartByDate = new Map<number, number>();
  for (const span of input.spans) {
    if (span.endAt === null) continue;
    for (const slice of splitSpanByBeijingDay(span.startAt, span.endAt)) {
      const key = slice.ledgerDate.getTime();
      millisecondsByDate.set(key, (millisecondsByDate.get(key) ?? 0) + slice.milliseconds);
      const previousStart = earliestStartByDate.get(key);
      const sliceStart = slice.startAt.getTime();
      if (previousStart === undefined || sliceStart < previousStart) {
        earliestStartByDate.set(key, sliceStart);
      }
    }
  }

  if (millisecondsByDate.size === 0) {
    // 零认定值 + 零服务日是**合法**形态(缺勤 / 请假 / early_departure_zero):
    // 它就是"这个人这一场没有账可入",不写任何分录。
    if (hoursHundredths === 0 && pointsHundredths === 0) return { kind: 'split', rows: [] };
    return { kind: 'no_service_day' };
  }

  // 稳定序:按 ledgerDate 升序。分配顺序必须确定性,否则最大余额法的平局处置会漂。
  const dates = [...millisecondsByDate.keys()].sort((a, b) => a - b);
  const weights = dates.map((key) => millisecondsByDate.get(key) ?? 0);

  const hoursByDay = distributeByWeight(hoursHundredths, weights);
  const pointsByDay = distributeByWeight(pointsHundredths, weights);

  return {
    kind: 'split',
    rows: dates.map((key, index) => ({
      ledgerDate: new Date(key),
      serviceHours: fromHundredths(hoursByDay[index]),
      recognizedPoints: fromHundredths(pointsByDay[index]),
      // 权重非零 ⇒ earliestStartByDate 必有值(两个 Map 同时写入)。
      sequenceStartAt: new Date(earliestStartByDate.get(key) as number),
      stableOrderKey: input.stableOrderKey,
    })),
  };
}

/** 参与日上限分配的一行(同一 member 同一 ledgerDate 内的一条服务日记录)。 */
export interface LedgerDayCapCandidate {
  readonly recognizedPoints: number;
  readonly sequenceStartAt: Date;
  readonly stableOrderKey: string;
}

export interface LedgerDayCapAllocation {
  readonly creditedPoints: number;
  readonly cappedOutPoints: number;
}

/**
 * §5.12 ⑤ + §3.24:在一个 (member, ledgerDate) 上按**稳定服务顺序**分配日上限。
 *
 * `priorCreditedPoints` = 该 member 该日**已 committed**的贡献值合计(基线)。
 * 先到的服务先拿额度,额度用完之后的认定值全部进 `cappedOutPoints`。
 *
 * 🔴 恒等式 `recognized = credited + cappedOut` 对每一行成立 ——
 *    这正是 DB 上 `participation_ledger_entry_balance_check` 的那条 CHECK,
 *    应用层与数据库两处同一口径(见 `ledger-day-allocation.spec.ts` ③)。
 *
 * ⚠️ 返回顺序**与入参顺序一致**(不是分配顺序):调用方按索引取回自己那一行。
 *    分配顺序在函数内部按 (sequenceStartAt, stableOrderKey) 排定,与入参书写顺序无关
 *    —— 否则同一批数据换个读取顺序就会换一份账。
 */
export function allocateDailyCredit(
  candidates: readonly LedgerDayCapCandidate[],
  priorCreditedPoints: number,
): LedgerDayCapAllocation[] {
  const priorHundredths = toHundredths(priorCreditedPoints);
  // 基线本身可能已经等于(甚至因历史数据超过)上限 ⇒ 余额钳到 0,不出现负额度。
  let remaining = Math.max(0, LEDGER_DAILY_CREDIT_CAP_HUNDREDTHS - priorHundredths);

  const order = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => {
      const byStart = a.candidate.sequenceStartAt.getTime() - b.candidate.sequenceStartAt.getTime();
      if (byStart !== 0) return byStart;
      const byKey = a.candidate.stableOrderKey.localeCompare(b.candidate.stableOrderKey);
      if (byKey !== 0) return byKey;
      return a.index - b.index;
    });

  const result: LedgerDayCapAllocation[] = new Array<LedgerDayCapAllocation>(candidates.length);
  for (const { candidate, index } of order) {
    const recognized = toHundredths(candidate.recognizedPoints);
    // 认定值为负在 §3.20 的 CHECK 下不可能出现;真出现时不许它"回吐额度"。
    const credited = recognized <= 0 ? 0 : Math.min(recognized, remaining);
    remaining -= credited;
    result[index] = {
      creditedPoints: fromHundredths(credited),
      cappedOutPoints: fromHundredths(recognized - credited),
    };
  }
  return result;
}

/**
 * §3.24 末句的最终判定:生效后的日合计必须落在 0..3。
 *
 * 🔴 这是**跨行**不变量,第 1 批已实测「表级 CHECK 只看单行、trigger 求和在并发下骗人」
 *    ⇒ 刻意零 DB 执行位。调用方必须在 **member advisory lock 内、day-state `FOR UPDATE`
 *    之后**调用本函数(否则读到的 prior 是别人未提交的世界,判了等于没判)。
 */
export function dayTotalWithinCap(
  priorCreditedPoints: number,
  batchCreditedPoints: number,
): boolean {
  const total = toHundredths(priorCreditedPoints) + toHundredths(batchCreditedPoints);
  return total >= 0 && total <= LEDGER_DAILY_CREDIT_CAP_HUNDREDTHS;
}

/** 两位小数的金额 → 整数分。入口统一,免得比较时一半浮点一半整数。 */
export function toHundredths(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`账本金额必须是有限数,收到 ${String(value)}`);
  }
  return Math.round(value * 100);
}

export function fromHundredths(hundredths: number): number {
  return hundredths / 100;
}

/** `Prisma.Decimal` → 整数分。Decimal(5,2) 的取值范围内 `Number()` 无精度损失。 */
export function decimalToHundredths(value: Prisma.Decimal | number | string): number {
  return toHundredths(Number(value.toString()));
}

/** 整数分 → `Prisma.Decimal`,给写库用(避免把浮点直接交给驱动)。 */
export function hundredthsToDecimal(hundredths: number): Prisma.Decimal {
  return new Prisma.Decimal(hundredths).dividedBy(100);
}

/**
 * 最大余额法:把 `total`(整数分)按 `weights` 分配,**逐项求和恒等于 total**。
 *
 * 逐项四舍五入不满足这一条(3 天平分 1.00 分 ⇒ 0.33×3 = 0.99,丢 1 分),
 * 而账本上丢一分就是账不平。
 *
 * 平局(小数部分完全相同)按索引升序补 —— 输入已经是稳定序,故结果完全确定。
 */
export function distributeByWeight(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (weightSum <= 0) {
    // 权重全零(理论上不可达:调用方已排除零毫秒的日)。全给第一项,不丢也不造。
    const fallback = new Array<number>(weights.length).fill(0);
    fallback[0] = total;
    return fallback;
  }

  const exact = weights.map((weight) => (total * weight) / weightSum);
  const floored = exact.map((value) => Math.floor(value));
  // `Math.floor(x) <= x` ⇒ `sum(floored) <= total` ⇒ **remainder 恒 ≥ 0**,
  // 且 `remainder < weights.length`(每项最多欠 1 分)。负 total 也成立
  // (floor 往更负的方向取),所以下面的循环一定终止,且不需要"负步长"分支。
  let remainder = total - floored.reduce((sum, value) => sum + value, 0);

  const byRemainderDesc = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (let i = 0; remainder > 0; i += 1) {
    floored[byRemainderDesc[i].index] += 1;
    remainder -= 1;
  }
  return floored;
}
