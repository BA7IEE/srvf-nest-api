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
