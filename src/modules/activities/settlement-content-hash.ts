import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';

// ===== 活动改造 v1.1 第 2 批第三刀:canonical contentHash(合同 §5.10 ⑤)=====
//
// 🔴 **这个 hash 是 §5.11 一审/终审比对的唯一依据 —— 它不稳定就等于没有比对。**
//    "不稳定"有三种死法,本文件逐条用结构挡住:
//
//   ① **书写顺序漂**:`JSON.stringify` 按属性**插入顺序**输出 ⇒ 同样的事实,只要
//      有人把字面量里两行调个个儿,hash 就变。⇒ 本文件递归**排序 key** 后再序列化,
//      对象的书写顺序在结构上不可能影响结果。
//      (第二刀 `SettlementDraftService.computeContentHash` 用的是 stringify 直出,
//       靠"字段顺序写死在字面量里"这条**人工纪律**保稳定;本刀不继承那条纪律。)
//
//   ② **浮点漂**:`0.1 + 0.2` 这类值一旦进 hash,同样的账在不同求和顺序下得到不同
//      文本。⇒ 本文件的载荷类型把**所有小数列声明成 `string`**(见
//      `SettlementContentItem`),调用方只能经 {@link decimalToCanonicalString}
//      把 `Decimal(5,2)` 转成定标度文本。TypeScript 直接挡住 `Number(decimal)`。
//      `canonicalizeNumber` 另外拒绝非有限值与非整数,`number` 只用于计数。
//
//   ③ **时区/时刻漂**:任何时间字段进 hash,都会让"内容完全相同的两次提交"得到不同
//      hash。⇒ 本 hash **一个时间字段都不含**(见 `SettlementContentPayload`)。
//      提交时刻、创建时刻是**元数据不是内容**,它们落在版本行的列上,不进 hash。
//      于是"时区口径"这个问题在结构上不存在,而不是靠约定统一。
//
// ## 与第二刀 hash 的关系
//
// 两个 hash **各算各的、互不引用**:第二刀的 hash 是 working draft 的**内容寻址键**
// (输入没变就不重开一版),含 `suggestedResultCode` / `pendingReasons` 这些**不落库**
// 的中间量;本刀的 hash 是**已固化版本的指纹**,只覆盖真正被冻结、且审核看得见的事实。
// 拿第二刀的 hash 当审核依据会把"建议值"也算进去 —— 那不是审核对象。

/** 载荷里允许出现的值。**没有 `Date`,也没有小数 `number`** —— 见文件头 ②③。 */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/**
 * `Decimal(5,2)` 的标度,与 DB 列定义同源:`recognizedServiceHours` 等四列
 * 都是 `Decimal(5,2)`。
 */
export const SETTLEMENT_DECIMAL_SCALE = 2;

/**
 * `Decimal(5,2)` → 定标度文本。**小数进 hash 的唯一通路。**
 *
 * `1.5` / `1.50` / `Decimal('1.5')` 归一到同一个 `"1.50"` ⇒ 读回来的精度表示差异
 * 不会让 hash 漂。
 */
export function decimalToCanonicalString(value: Prisma.Decimal | number | string): string {
  // ⚠️ 这里的 Number() 只作用于**已经从 DB 读回的定标度值**,不参与任何算术 ——
  //    真正要禁的是"先用浮点算,再进 hash",那条路被载荷类型挡在门外。
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (typeof numeric === 'number' && !Number.isFinite(numeric)) {
    throw new TypeError('settlement contentHash: 小数字段不是有限值');
  }
  return numeric.toFixed(SETTLEMENT_DECIMAL_SCALE);
}

function canonicalizeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError('settlement contentHash: 数字字段不是有限值');
  }
  // 计数类字段必须是整数。小数一律走 decimalToCanonicalString 变成 string ——
  // 走到这里说明有人绕过了载荷类型,fail-closed 而不是默默算一个会漂的 hash。
  if (!Number.isInteger(value)) {
    throw new TypeError('settlement contentHash: 小数必须先经 decimalToCanonicalString 转文本');
  }
  return String(value);
}

/**
 * canonical 序列化:**对象 key 递归排序**后输出。
 *
 * 判据(见配套 spec):同一份事实,无论字面量里字段怎么排、对象怎么嵌套,
 * 得到的文本逐字节相同 —— 这正是"canonical 而不是 stringify 直出"的可观测差别。
 */
export function canonicalize(value: CanonicalValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return canonicalizeNumber(value);
  if (Array.isArray(value)) {
    // 数组**保序**:顺序在数组里是语义(items 由调用方按 identityId 稳定排序)。
    // `Array.isArray` 对 readonly 数组只窄化到 `any[]`,显式重标类型免掉 unsafe-argument。
    const items: readonly CanonicalValue[] = value;
    return `[${items.map((item) => canonicalize(item)).join(',')}]`;
  }
  const record = value as { readonly [key: string]: CanonicalValue };
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

/** 被冻结的逐人结果。四个金额列是 `string`(定标度文本),不是 `number` —— 见文件头 ②。 */
export interface SettlementContentItem {
  readonly participationIdentityId: string;
  readonly resultCode: string;
  readonly lateFlag: boolean;
  readonly earlyLeaveFlag: boolean;
  /** `exceptionFlagsJson` 原样进 hash(canonicalize 会递归排 key);无则 null。 */
  readonly exceptionFlags: CanonicalValue;
  readonly recognizedServiceHours: string;
  readonly recognizedContributionPoints: string;
  readonly calculatedServiceHours: string;
  readonly calculatedContributionPoints: string;
  readonly adjustmentReason: string | null;
}

/**
 * 被冻结的版本内容。**没有任何时间字段**(见文件头 ③)。
 *
 * `schemaVersion` 是给 §5.11 的:日后若增删被 hash 的字段,老版本的 hash 不会被
 * 新算法"重算成另一个值"—— 比对时先比 schemaVersion,不同就不是同一把尺子。
 */
export interface SettlementContentPayload {
  readonly schemaVersion: number;
  readonly activityId: string;
  readonly settlementRunId: string;
  readonly evidenceSealId: string;
  readonly sealRevision: number;
  readonly evidenceRevision: number;
  readonly populationRevision: number;
  readonly workflowRevision: number;
  readonly personCount: number;
  readonly sessionParticipationCount: number;
  readonly serviceSegmentCount: number;
  readonly items: readonly SettlementContentItem[];
}

export const SETTLEMENT_CONTENT_SCHEMA_VERSION = 1;

export function buildSettlementContentCanonicalText(payload: SettlementContentPayload): string {
  // 这里刻意把 payload 整个交给 canonicalize:字段的**书写顺序无关紧要**,
  // 因为 canonicalize 会排序 —— 所以本函数没有"顺序纪律"要维护。
  return canonicalize(payload as unknown as CanonicalValue);
}

export function computeSettlementContentHash(payload: SettlementContentPayload): string {
  return createHash('sha256')
    .update(buildSettlementContentCanonicalText(payload), 'utf8')
    .digest('hex');
}
