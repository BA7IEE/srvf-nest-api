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

export function normalizeDateOnly(input: string): Date {
  const shifted = new Date(new Date(input).getTime() + UTC8_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}
