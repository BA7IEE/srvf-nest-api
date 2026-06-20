// 招新一期(招新前段)T3(2026-06-18):recruitment 业务模块常量 + 纯函数 helper
//
// 沿冻结评审稿 docs/archive/reviews/recruitment-phase1-review.md(下称"评审稿")。

import { maskIdCard } from '../realname/realname.constants';

// ===== 轮次状态(String;后台开关)=====
export const CYCLE_STATUS_OPEN = 'open';
export const CYCLE_STATUS_CLOSED = 'closed';

// ===== 报名状态机(String,镜像 activity_registrations.statusCode;评审稿 D-R-4 + 二期 M-2/E-R2-1)=====
export const APP_STATUS_PENDING = 'pending_verification'; // 待核验(大陆证件 create 初态)
export const APP_STATUS_VERIFIED = 'verified'; // 核验通过(临时编号已发;二期 = 门槛跟踪中)
export const APP_STATUS_MANUAL = 'manual_review'; // 人工待核(外籍等)
export const APP_STATUS_REJECTED = 'rejected'; // 未通过
// 招新二期(后段;评审稿 M-2 / E-R2-1):+3 字符串态,无 migration
export const APP_STATUS_PENDING_EVALUATION = 'pending_evaluation'; // 待综合评定(5 门槛全完成自动推进)
export const APP_STATUS_PUBLICITY = 'publicity'; // 公示中(综合评定通过)
export const APP_STATUS_PROMOTED = 'promoted'; // 已发永久编号(建 User+Member;终态)

// ===== 核验结果记账(verifyOutcome)=====
export const VERIFY_OUTCOME_MATCHED = 'matched';
export const VERIFY_OUTCOME_MISMATCH = 'mismatch';
export const VERIFY_OUTCOME_MANUAL = 'manual'; // 外籍跳过 provider
export const VERIFY_OUTCOME_SKIPPED = 'skipped';

// ===== 淘汰环节(eliminationStage;脱敏留存)=====
export const ELIM_STAGE_REALNAME = 'realname'; // 实名核验不一致
export const ELIM_STAGE_MANUAL = 'manual'; // 人工 resolve 不通过
// 招新二期(评审稿 E-R2-1):+2 值
export const ELIM_STAGE_EVALUATION = 'evaluation'; // 综合评定不通过
export const ELIM_STAGE_THRESHOLD_TIMEOUT = 'threshold-timeout'; // 门槛阶段人工淘汰/超期/退出

// =============================================================================
// 招新二期(后段)门槛 + 综合评定 + 永久编号 + 拼音排序(评审稿 M-2/M-3/M-4 + E-R2-2/4/6)
// =============================================================================

// ===== 门槛(M-3 / E-R2-2):5 项固定 code;thresholdMarks Json = { [code]: {at, by} } =====
export const THRESHOLD_CODES = ['patrol1', 'patrol2', 'training', 'redCross', 'bsafe'] as const;
export type ThresholdCode = (typeof THRESHOLD_CODES)[number];
export interface ThresholdMark {
  at: string; // ISO 完成时刻
  by: string; // 标记人 User.id
}
export type ThresholdMarks = Partial<Record<ThresholdCode, ThresholdMark>>;

export function isThresholdCode(code: string): code is ThresholdCode {
  return (THRESHOLD_CODES as ReadonlyArray<string>).includes(code);
}

/** 5 项门槛是否全部完成(标记存在即完成) */
export function allThresholdsComplete(marks: ThresholdMarks | null | undefined): boolean {
  if (!marks) return false;
  return THRESHOLD_CODES.every((c) => marks[c] != null);
}

// ===== 永久编号 {YY}{NNN}(D-R2-6 / M-4):2 位年 + 3 位流水;每年上限 999 =====
export const MEMBER_NO_MAX_SEQ = 999;

export function formatMemberNo(year: number, seq: number): string {
  return `${String(year % 100).padStart(2, '0')}${String(seq).padStart(3, '0')}`;
}

// ===== 拼音排序(wrinkle② / E-R2-4):Node 自带 full-ICU,零依赖、零 collation、零拼音列 =====
// Intl.Collator('zh-u-co-pinyin') 按拼音排序中文姓名(实测 node22/icu78 正确)。
const PINYIN_COLLATOR = new Intl.Collator('zh-u-co-pinyin');

/** 发号/公示排序的可比较项:realName 拼音 → createdAt → id(稳定全序,确定性可复现) */
export interface PromotionOrderItem {
  realName: string | null;
  createdAt: Date;
  id: string;
}

export function comparePromotionOrder(a: PromotionOrderItem, b: PromotionOrderItem): number {
  // realName 为空(理论上 publicity 态不应空)排最后,保证确定性
  const an = a.realName ?? '';
  const bn = b.realName ?? '';
  if (an !== bn) {
    const byPinyin = PINYIN_COLLATOR.compare(an, bn);
    if (byPinyin !== 0) return byPinyin;
  }
  const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
  if (byCreated !== 0) return byCreated;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 是否可一键发号(M-1:仅大陆可派生 birthDate+genderCode + 有 openid;外籍/缺字段走 admin 手动建档)*/
export function isPromotable(app: {
  isForeigner: boolean;
  birthDate: Date | null;
  genderCode: string | null;
  openid: string | null;
  realName: string | null;
}): boolean {
  return (
    !app.isForeigner &&
    app.birthDate != null &&
    app.genderCode != null &&
    app.openid != null &&
    app.realName != null
  );
}

/** promote / 公示预览共享的发号判定项(isPromotable 字段集 + id;RecruitmentApplication 天然满足) */
export interface PromotionIssuanceItem {
  id: string;
  isForeigner: boolean;
  birthDate: Date | null;
  genderCode: string | null;
  openid: string | null;
  realName: string | null;
}

/** 单项发号判定:willIssue=false 时 reason 给出跳过原因(promote skipped[].reason 同源) */
export interface PromotionIssuanceDecision<T> {
  app: T;
  willIssue: boolean;
  reason: string | null;
}

/** 跳过原因(promote 与公示同源;判定顺序即优先级) */
export function promotionSkipReason(
  app: PromotionIssuanceItem,
  openidBound: boolean,
  duplicateOpenidInBatch: boolean,
): string {
  if (app.isForeigner) return 'foreign-manual-build';
  if (openidBound) return 'openid-already-bound';
  if (app.openid == null) return 'missing-openid';
  if (duplicateOpenidInBatch) return 'duplicate-openid-in-batch';
  if (app.birthDate == null || app.genderCode == null) return 'missing-derived-field';
  if (app.realName == null) return 'incomplete-data';
  return 'not-promotable';
}

/**
 * 发号资格判定(一键发号 promote 与公示预览 publicityList 共享,结构性保证「公示预览 = 实发」;#399 F9/F15)。
 * - sortedApps 须已按 comparePromotionOrder 排序(两处同序 → 批内去重 tie-break 一致);
 * - boundOpenids = 已被既有 User(含软删,沿 openid @unique 占用语义)占用的 openid 集;
 * - 批内同一 openid 仅发号序最先一行可发,其余记 'duplicate-openid-in-batch'(原先第二行入事务
 *   撞 User.openid @unique → P2002 → 整批回滚零发号;#399 F15)。
 */
export function decidePromotionIssuance<T extends PromotionIssuanceItem>(
  sortedApps: readonly T[],
  boundOpenids: ReadonlySet<string>,
): PromotionIssuanceDecision<T>[] {
  const seenOpenids = new Set<string>();
  return sortedApps.map((app) => {
    const openidBound = app.openid != null && boundOpenids.has(app.openid);
    const duplicateOpenidInBatch = app.openid != null && seenOpenids.has(app.openid);
    const willIssue = isPromotable(app) && !openidBound && !duplicateOpenidInBatch;
    if (willIssue && app.openid != null) seenOpenids.add(app.openid);
    return {
      app,
      willIssue,
      reason: willIssue ? null : promotionSkipReason(app, openidBound, duplicateOpenidInBatch),
    };
  });
}

// ===== 年龄门槛(评审稿 D-R-7 / E-R-12;从身份证号校验)=====
export const RECRUITMENT_MIN_AGE = 18;
export const RECRUITMENT_MAX_AGE = 60;
// 北京日界(UTC+8)固定偏移,沿 sms 自然日口径,不引 tz 依赖
const BEIJING_UTC_OFFSET_HOURS = 8;

// ===== 证件类型(documentTypeCode;判外籍/人工)=====
// 大陆二代身份证走腾讯云二要素核验;其余(港澳台 / 护照 / 外国人永居)走人工待核。
export const DOC_TYPE_MAINLAND_ID = 'mainland_id';

export function isForeignDocument(documentTypeCode: string): boolean {
  return documentTypeCode !== DOC_TYPE_MAINLAND_ID;
}

// ===== 临时编号格式 T{year}{seq:04d}(评审稿 D-R-5 / E-R-9)=====
export function formatTempNo(year: number, seq: number): string {
  return `T${year}${String(seq).padStart(4, '0')}`;
}

// =============================================================================
// 中国大陆二代身份证号(18 位)校验 + 派生(本仓无既有 helper,评审稿 E-R-12 自写)
// =============================================================================

// 18 位:前 17 位数字 + 第 18 位校验位(数字或 X)。格式由 DTO @Matches 先挡,
// 本组函数在 service 层做校验位 + 生日 + 年龄业务校验(沿评审稿 §4 步骤 1/3)。
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK_CODES = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

/** 18 位二代身份证号格式 + 校验位是否合法(校验位算法 GB 11643-1999) */
export function isValidChineseId(idCardNumber: string): boolean {
  const s = idCardNumber.trim().toUpperCase();
  if (!/^\d{17}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += Number(s[i]) * ID_WEIGHTS[i];
  }
  return ID_CHECK_CODES[sum % 11] === s[17];
}

/** 从身份证号提取生日(第 7-14 位 YYYYMMDD;归一到 00:00:00.000Z,沿 MemberProfile.birthDate 范式) */
export function extractBirthDate(idCardNumber: string): Date | null {
  const s = idCardNumber.trim();
  const y = Number(s.slice(6, 10));
  const m = Number(s.slice(10, 12));
  const d = Number(s.slice(12, 14));
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  // 反向校验(防 2 月 30 日等被 Date 滚动)
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return date;
}

/** 性别(身份证第 17 位:奇=male / 偶=female;评审稿脱敏字段 genderCode) */
export function extractGenderCode(idCardNumber: string): string {
  const seq = Number(idCardNumber.trim()[16]);
  return seq % 2 === 1 ? 'male' : 'female';
}

/** 周岁(以北京日界"今天"为基准;now 由调用方注入便于测试) */
export function computeAge(birthDate: Date, now: Date): number {
  const beijingNow = new Date(now.getTime() + BEIJING_UTC_OFFSET_HOURS * 3600_000);
  let age = beijingNow.getUTCFullYear() - birthDate.getUTCFullYear();
  const mDiff = beijingNow.getUTCMonth() - birthDate.getUTCMonth();
  if (mDiff < 0 || (mDiff === 0 && beijingNow.getUTCDate() < birthDate.getUTCDate())) {
    age -= 1;
  }
  return age;
}

/** 年龄段(脱敏留存:ageGroup;提交时从生日派生,survive 留存清理) */
export function ageGroupOf(age: number): string {
  if (age < 18) return 'under-18';
  if (age <= 25) return '18-25';
  if (age <= 35) return '26-35';
  if (age <= 45) return '36-45';
  if (age <= 60) return '46-60';
  return 'over-60';
}

// ===== 证件照(评审稿分叉③A / E-R-15 / 配套②)=====
// multipart 收图 → StorageProvider.putObject → key(写 recruitment_applications.idCardImageKey);
// storage key 前缀按轮次 + 申请,便于运维/留存定位;不进 Attachment 多态表。
export const ID_CARD_IMAGE_KEY_PREFIX = 'recruitment/id-card';
export const ID_CARD_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5MB 上限(证件照足够)
export const ID_CARD_IMAGE_ALLOWED_MIME: ReadonlyArray<string> = ['image/jpeg', 'image/png'];
// admin 取图 signed-URL TTL(配套②;短 TTL)
export const ID_CARD_IMAGE_SIGNED_URL_TTL_SECONDS = 300;

// ===== 紧急联系人(评审稿 D-R + E-R-13;JSON 数组,≥2)=====
export const EMERGENCY_CONTACTS_MIN = 2;

// 复用 realname 的身份证号掩码(audit / 日志;评审稿配套③)
export { maskIdCard };
