// 纯日期字段归一工具(2026-06-12 把关 P2 收口;原 member-profiles / certificates 私有副本合并)。
//
// 修复的缺陷:两处私有 normalizeDateOnly 按「输入瞬间的 UTC 日历日」归一
// (getUTCFullYear/Month/Date),而读取侧(生日批 utc8MonthDay)按固定 UTC+8 解释月日。
// 纯日期与 UTC 白天输入两侧凑巧一致;带偏移 datetime(北京日 ≠ UTC 日,
// 如 '1990-05-15T00:00:00+08:00' = UTC 05-14T16:00Z)旧实现归一到前一天,写入差一天。
//
// 为何固定 UTC+8:队伍仅深圳一地,与 birthday-greeting / sms-code 的 UTC8_OFFSET_MS
// 同口径;本 util 自带常量,不反向依赖那两处模块私有实现(它们语义独立、维持原地)。
//
// 语义:解析 ISO 8601 输入 → +8h 移到北京时间 → 取北京日历日 Y/M/D →
// 返回该日 UTC 午夜。存储格式不变,符合 schema 注释「00:00:00.000Z 规范化」
// (草案 §6 决议:不落 @db.Date,业务层统一规范化处理)。
// 北京日界的唯一 IANA 标识。业务模块需要展示或校验时区时从这里取值，不能另写一份。
export const BEIJING_TIME_ZONE = 'Asia/Shanghai' as const;

const UTC8_OFFSET_MS = 8 * 3600 * 1000;

// 把任意瞬间映射到「它所处的北京日历日」的 UTC 午夜。
//
// 证书标准库 PR-1(冻结稿 §10)新增:`normalizeDateOnly` 只收字符串,而
// 「今天」「cron 日界」这类比较基准天生是 Date。此前各调用点各自私有一份同逻辑
// (如 expiry-reminder 的 toBeijingDateOnly),现统一收在本 util —— 冻结稿 §19
// 明令「不复制第二套日期算法」。`normalizeDateOnly` 转为薄壳委托,行为不变。
export function beijingDateOnly(instant: Date): Date {
  const shifted = new Date(instant.getTime() + UTC8_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

export function normalizeDateOnly(input: string): Date {
  return beijingDateOnly(new Date(input));
}

// 纯日期的**严格**解析:形状 + 日历真实性都不过就返回 null,绝不返回一个「看起来
// 合法但不是调用方本意」的 Date。给 service 层当第二道防御用(DTO 是第一道)。
//
// 存在的理由(第四轮评审 P1,实测):`new Date(x)` 对一大票非字符串输入会给出
// **完全合法**的 1970-01-01 而不是 Invalid Date ——
//   new Date(null)  = 1970-01-01T00:00:00.000Z
//   new Date(true)  = 1970-01-01T00:00:00.001Z
//   new Date([])    = 1970-01-01T00:00:00.000Z
// 于是任何「先 new Date 再判 NaN」的写法都拦不住它们,1970-01-01 会作为一条
// 正式业务事实落库。必须在 new Date **之前**做正向类型 + 形状检查。
//
// 入参声明成 `unknown` 是刻意的:这道闸的全部意义就是「TS 类型说是 string,
// 但运行时未必」。声明成 string 会让 `typeof` 那行被 TS 判成恒真而失去意义。
const DATE_ONLY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDateOnlyStrict(input: unknown): Date | null {
  if (typeof input !== 'string' || !DATE_ONLY_SHAPE.test(input)) return null;
  // 形状对了仍可能是不存在的日历日(2026-02-30 / 2026-13-01)——
  // 那种 `new Date` 给 Invalid Date,NaN 会一路传到 beijingDateOnly 的结果里。
  const normalized = beijingDateOnly(new Date(input));
  return Number.isNaN(normalized.getTime()) ? null : normalized;
}

// 冻结稿 §10.4 FIXED_MONTHS:从发证日按**自然月**推进 N 个月,目标月无该日则
// 夹取到目标月最后一天;返回值即「最后有效日」(§10.1 expiredAt 语义)。
//
// 为何不用 `30 天 × 月数`(冻结稿显式禁止):按天数算会让 2 月发的证书比 1 月发的
// 短命,且跨闰年漂移。示例:2024-02-29 + 12 月 = 2025-02-28;2026-01-31 + 1 月 = 2026-02-28。
//
// 入参约定:`from` 必须已是 date-only 归一值(UTC 午夜),由调用方保证;
// 本函数只做日历运算,不重复归一,避免二次移位。
export function addMonthsClamped(from: Date, months: number): Date {
  const targetMonthIndex = from.getUTCMonth() + months;
  const targetYear = from.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  // Date.UTC(y, m + 1, 0) = 目标月最后一天(day 0 回退到上个月末)。
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(from.getUTCDate(), lastDayOfTargetMonth);
  return new Date(Date.UTC(targetYear, targetMonth, day));
}

// ===== 活动改造 v1.1 第 2 批第一刀:北京日拆分(合同 §3.21)=====
//
// §3.21 原话要求「业务转换统一调用 `BeijingCalendarService`」,并明禁散落的
// 本地化时间格式化与字符串切割。本仓**不新建**那个类 —— 它要求的日界口径与本文件的
// `beijingDateOnly` 是同一件事,再包一层就是冻结稿 §19 明禁的「第二套日期算法」。
// 合同点名的是**单一入口**这个性质,不是类名;所需新能力一律加在本文件内,
// `beijingDateOnly` 仍是全仓唯一的日界实现。
//
// 为什么固定 +8 而不查时区库:中国大陆 1991 年后无夏令时,与本文件既有口径
// (以及 sms / birthday-greeting 的 UTC8_OFFSET_MS)同源;引 tz 依赖反而制造分叉。

const DAY_MS = 24 * 3600 * 1000;

// 一个服务段被北京日界切开后的一片。
// `ledgerDate` 直接就是 §3.21 `ParticipantSettlementDay.ledgerDate` 的取值
// (该列是 `@db.Date`,Prisma 侧以 UTC 午夜 Date 表达)。
export interface BeijingDaySlice {
  ledgerDate: Date;
  startAt: Date;
  endAt: Date;
  milliseconds: number;
}

// 北京日 `ledgerDate` 实际覆盖的 UTC 区间 `[startAt, endAt)`。
// 北京 00:00 = 该日 UTC 午夜 − 8h(即前一日 16:00Z)。
export function beijingDayBoundsUtc(ledgerDate: Date): { startAt: Date; endAt: Date } {
  const startAt = new Date(ledgerDate.getTime() - UTC8_OFFSET_MS);
  return { startAt, endAt: new Date(startAt.getTime() + DAY_MS) };
}

// 把 `[startAt, endAt)` 按北京日界切成有序、无缝、不重叠的多片。
//
// 用途(§3.21):一段跨越北京日界的服务时长必须按**日**入账,
// 否则 `MemberContributionDayState` 的「日合计 0..3」根本无从判定。
//
// 约定:
// - 半开区间 —— 恰好落在日界上的瞬间归**后**一日,不会产生零长度片;
// - `endAt <= startAt` 返回空数组(不抛),调用方按「无服务时长」处理;
// - 入参必须是有效 Date,非法值直接抛 —— 沿 `parseDateOnlyStrict` 的同一立场:
//   宁可炸,也不返回一个「看起来合法但不是调用方本意」的结果。
//
// ⚠️ 消费方在第 2 批后续刀(结算草稿 / 账本准备),本刀零调用方是预期状态。
export function splitSpanByBeijingDay(startAt: Date, endAt: Date): BeijingDaySlice[] {
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
    throw new RangeError('splitSpanByBeijingDay 收到无效 Date');
  }
  if (endAt.getTime() <= startAt.getTime()) return [];

  const slices: BeijingDaySlice[] = [];
  let cursor = startAt;
  while (cursor.getTime() < endAt.getTime()) {
    const ledgerDate = beijingDateOnly(cursor);
    const bounds = beijingDayBoundsUtc(ledgerDate);
    const sliceEnd = bounds.endAt.getTime() < endAt.getTime() ? bounds.endAt : endAt;
    slices.push({
      ledgerDate,
      startAt: cursor,
      endAt: sliceEnd,
      milliseconds: sliceEnd.getTime() - cursor.getTime(),
    });
    cursor = sliceEnd;
  }
  return slices;
}
