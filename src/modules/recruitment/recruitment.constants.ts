// 招新一期(招新前段)T3(2026-06-18):recruitment 业务模块常量 + 纯函数 helper
//
// 沿冻结评审稿 docs/archive/reviews/recruitment-phase1-review.md(下称"评审稿")。

import { createHash, randomBytes } from 'node:crypto';

import { maskIdCard } from '../realname/realname.constants';

// ===== 轮次状态(String;后台开关)=====
export const CYCLE_STATUS_OPEN = 'open';
export const CYCLE_STATUS_CLOSED = 'closed';

// ===== 报名状态机(String,镜像 activity_registrations.statusCode;评审稿 D-R-4 + 二期 M-2/E-R2-1)=====
// OCR 改造(2026-06-22 分叉④):报名 submit 改为「OCR 前置 + 单事务建终态」,新报名一建即是
// verified 或 manual_review,**不再产生 pending_verification 在途态**(FM-A 卡死类整类消失)。
// APP_STATUS_PENDING 常量保留仅为历史兼容/防御,**报名主流程不再写入**(评审稿 §3.1/§4)。
export const APP_STATUS_PENDING = 'pending_verification'; // 退役:OCR 改造后报名不再产生(历史兼容)
export const APP_STATUS_VERIFIED = 'verified'; // 核验通过(临时编号已发;二期 = 门槛跟踪中)
export const APP_STATUS_MANUAL = 'manual_review'; // 人工待核(非大陆证件等)
export const APP_STATUS_REJECTED = 'rejected'; // 未通过
// 招新二期(后段;评审稿 M-2 / E-R2-1):+3 字符串态,无 migration
export const APP_STATUS_PENDING_EVALUATION = 'pending_evaluation'; // 待综合评定(5 门槛全完成自动推进)
export const APP_STATUS_PUBLICITY = 'publicity'; // 公示中(综合评定通过)
export const APP_STATUS_PROMOTED = 'promoted'; // 已发永久编号(建 User+Member;终态)
// 招新可用性收口 F6(2026-07-11;评审稿 §3 R4):申请人自助撤销终态(允许下轮及同轮重报;
// partial unique 排除集 rejected → rejected+withdrawn 已随第 43 migration 重建)。
export const APP_STATUS_WITHDRAWN = 'withdrawn'; // 已自助撤销(终态;非淘汰,不写 eliminationStage)

// ===== 核验结果记账(verifyOutcome;String,零 migration;OCR 改造分叉⑥加细分值)=====
export const VERIFY_OUTCOME_MATCHED = 'matched'; // 大陆 OCR 匹配+清晰+无防伪告警 → verified
export const VERIFY_OUTCOME_MISMATCH = 'mismatch'; // 姓名/证件号与 OCR 不一致 → manual_review
export const VERIFY_OUTCOME_MANUAL = 'manual'; // 非 OCR 类型(台胞证/外国人永居/其余)+ 护照/回乡证人工
export const VERIFY_OUTCOME_SKIPPED = 'skipped';
// OCR 改造(2026-06-22 分叉⑥)新增:进人工的细分原因(便于 admin 复核 / 审计区分)
export const VERIFY_OUTCOME_FORGERY_WARNING = 'forgery_warning'; // 防伪告警(篡改/复印/遮挡)
export const VERIFY_OUTCOME_OCR_UNCLEAR = 'ocr_unclear'; // 证件照不清晰 / OCR 读不出
export const VERIFY_OUTCOME_OCR_ERROR = 'ocr_error'; // OCR 上游失败/通道未配(分叉③ 转人工不外抛)
export const VERIFY_OUTCOME_CATEGORY_MISMATCH = 'category_mismatch'; // 回乡证类别非来往内地

// ===== 招新四期 S4b(OCR 六分流;评审稿 §2.1/§2.2/§2.4;String,零 migration)=====
// 复核风险级(riskLevel;驱动后台人工队列三栏分流 §2.4;**申请人侧不暴露**,goal 三③隐私口径):
export const RISK_LEVEL_NORMAL = 'normal'; // 普通人工(mismatch 确认错 / 特殊证件)
export const RISK_LEVEL_HIGH = 'high'; // 高风险复核(防伪/疑似篡改)
export const RISK_LEVEL_SYSTEM = 'system'; // 系统异常(OCR 上游失败;§2.4 取此,顺修 §2.1 ocr_error 行 normal→system)
// 后台人工原因分类(manualReviewReason;派生归类自 verifyOutcome,供 admin 分组筛选 §2.2/§2.4):
export const MANUAL_REASON_OCR_MISMATCH_CONFIRMED = 'ocr_mismatch_confirmed'; // mismatch 三选一之③(applicantConfirmedOcrWrong)
export const MANUAL_REASON_FORGERY_SUSPECTED = 'forgery_suspected'; // 防伪重拍仍异常 → 高风险
export const MANUAL_REASON_SYSTEM_OCR_ERROR = 'system_ocr_error'; // 上游连续失败 → 系统异常
export const MANUAL_REASON_SPECIAL_DOCUMENT = 'special_document'; // 特殊证件/非 OCR 类型/生僻字多次失败
// 防伪 / 上游失败「连续达此次数才落记录进人工」(Q-P4-4「连续 2 次」;首次只提示重拍/重试,不落记录):
export const OCR_DEFER_MAX_ATTEMPTS = 2;

// ===== 淘汰环节(eliminationStage;脱敏留存)=====
// OCR 改造(2026-06-22 分叉④/⑤):mismatch 不再 rejected(改 manual_review,不误杀),
// ELIM_STAGE_REALNAME 报名主流程**不再写入**(常量保留仅历史兼容);淘汰仅经人工 resolve(ELIM_STAGE_MANUAL)。
export const ELIM_STAGE_REALNAME = 'realname'; // 退役:OCR 改造后不再写入(历史兼容)
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

/**
 * 是否可一键发号:资料齐备(realName/birthDate/genderCode + openid|phone 锚)即可。
 * v0.40.0 H5 手机通道发号:登录通道条件由「有 openid」放宽为「有 openid **或** 有已验证手机(phone)」——
 * 无 openid 但有已验证手机的 H5 申请人亦可一键发号(建 SMS 登录通道 User);微信路径(有 openid)逐字不变。
 */
export function isPromotable(app: {
  birthDate: Date | null;
  genderCode: string | null;
  openid: string | null;
  phone: string | null;
  realName: string | null;
}): boolean {
  return (
    app.birthDate != null &&
    app.genderCode != null &&
    (app.openid != null || app.phone != null) &&
    app.realName != null
  );
}

/** promote / 公示预览共享的发号判定项(isPromotable 字段集 + id;RecruitmentApplication 天然满足) */
export interface PromotionIssuanceItem {
  id: string;
  birthDate: Date | null;
  genderCode: string | null;
  openid: string | null;
  phone: string | null;
  realName: string | null;
}

/** 单项发号判定:willIssue=false 时 reason 给出跳过原因(promote skipped[].reason 同源) */
export interface PromotionIssuanceDecision<T> {
  app: T;
  willIssue: boolean;
  reason: string | null;
}

/**
 * 跳过原因(promote 与公示同源;判定顺序即优先级)。
 * v0.40.0 H5 手机通道发号三变:
 * - `missing-openid` → `missing-login-channel`(openid **与** phone 皆无时;⚠️ 字符串变更,missing-openid 停用);
 * - 新增 `phone-already-bound`(无 openid 走手机通道,但 phone 被既有 User 占用〔含软删〕,镜像 openid 语义);
 * - 新增 `duplicate-phone-in-batch`(无 openid 走手机通道,批内同 phone 仅发号序最先一行可发,镜像 openid 批内去重)。
 * 手机通道相关判定仅在 `app.openid == null` 时生效 —— 有 openid 的申请人走微信通道,phone 占用/去重不参与(行为锁)。
 */
export function promotionSkipReason(
  app: PromotionIssuanceItem,
  openidBound: boolean,
  duplicateOpenidInBatch: boolean,
  phoneBound: boolean,
  duplicatePhoneInBatch: boolean,
): string {
  if (openidBound) return 'openid-already-bound';
  if (phoneBound) return 'phone-already-bound';
  if (app.openid == null && app.phone == null) return 'missing-login-channel';
  if (duplicateOpenidInBatch) return 'duplicate-openid-in-batch';
  if (duplicatePhoneInBatch) return 'duplicate-phone-in-batch';
  if (app.birthDate == null || app.genderCode == null) return 'missing-derived-field';
  if (app.realName == null) return 'incomplete-data';
  return 'not-promotable';
}

/**
 * 发号资格判定(一键发号 promote 与公示预览 publicityList 共享,结构性保证「公示预览 = 实发」;#399 F9/F15)。
 * - sortedApps 须已按 comparePromotionOrder 排序(两处同序 → 批内去重 tie-break 一致);
 * - boundOpenids = 已被既有 User(含软删,沿 openid @unique 占用语义)占用的 openid 集;
 * - boundPhones = 已被既有 User(含软删,沿 phone @unique 占用语义)占用的 phone 集(v0.40.0 H5 手机通道);
 * - 批内同一 openid 仅发号序最先一行可发,其余记 'duplicate-openid-in-batch'(原先第二行入事务
 *   撞 User.openid @unique → P2002 → 整批回滚零发号;#399 F15)。
 * - **通道分流(v0.40.0 行为锁核心)**:`app.openid != null` 走微信通道(openid 占用/去重,逐字不变);
 *   `app.openid == null` 才走手机通道(phone 占用/去重)——有 openid 者 phone 相关判定一律不参与,
 *   保证微信路径 promote 行为逐字不动。同理批内去重:openid 通道进 seenOpenids、phone 通道进 seenPhones。
 */
export function decidePromotionIssuance<T extends PromotionIssuanceItem>(
  sortedApps: readonly T[],
  boundOpenids: ReadonlySet<string>,
  boundPhones: ReadonlySet<string>,
): PromotionIssuanceDecision<T>[] {
  const seenOpenids = new Set<string>();
  const seenPhones = new Set<string>();
  return sortedApps.map((app) => {
    // 手机通道仅在无 openid 时启用(有 openid = 微信通道,phone 占用/去重不参与)。
    const usesPhoneChannel = app.openid == null && app.phone != null;
    const openidBound = app.openid != null && boundOpenids.has(app.openid);
    const duplicateOpenidInBatch = app.openid != null && seenOpenids.has(app.openid);
    const phoneBound = usesPhoneChannel && boundPhones.has(app.phone as string);
    const duplicatePhoneInBatch = usesPhoneChannel && seenPhones.has(app.phone as string);
    const willIssue =
      isPromotable(app) &&
      !openidBound &&
      !duplicateOpenidInBatch &&
      !phoneBound &&
      !duplicatePhoneInBatch;
    if (willIssue) {
      if (app.openid != null) seenOpenids.add(app.openid);
      else if (app.phone != null) seenPhones.add(app.phone);
    }
    return {
      app,
      willIssue,
      reason: willIssue
        ? null
        : promotionSkipReason(
            app,
            openidBound,
            duplicateOpenidInBatch,
            phoneBound,
            duplicatePhoneInBatch,
          ),
    };
  });
}

// ===== 年龄门槛(评审稿 D-R-7 / E-R-12;从身份证号校验)=====
export const RECRUITMENT_MIN_AGE = 18;
export const RECRUITMENT_MAX_AGE = 60;
// 北京日界(UTC+8)固定偏移,沿 sms 自然日口径,不引 tz 依赖
const BEIJING_UTC_OFFSET_HOURS = 8;

// =============================================================================
// 招新可用性收口 F1(2026-07-11;评审稿 recruitment-usability-closeout-review.md §2.5/§6.1)
// =============================================================================

// 「同轮活跃报名」排除态集合(openid/phone/idCardNumber 三键去重共用;与 partial unique 的
// `statusCode NOT IN ('rejected','withdrawn')` 排除语义同源;F6/R4 起含 withdrawn)。
export const APP_INACTIVE_STATUS_CODES: ReadonlyArray<string> = [
  APP_STATUS_REJECTED,
  APP_STATUS_WITHDRAWN,
];

// 付费 OCR 按 IP 北京自然日封顶(E-U-1):计数键 = ip × dateKey;req.ip 缺省归一 'unknown' 桶
//(不可作为绕计通道)。dateKey 用固定 UTC+8 日界(沿 sms/stats 各模块级实现口径,不抽共享 util)。
export const OCR_COUNTER_UNKNOWN_IP = 'unknown';

/** 北京自然日 key(YYYY-MM-DD;固定 UTC+8 偏移,不引 tz 依赖)。 */
export function beijingDateKey(now: Date): string {
  const shifted = new Date(now.getTime() + BEIJING_UTC_OFFSET_HOURS * 3600_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ===== 证件类型(documentTypeCode;判非大陆证件 / OCR 自动放行资格)=====
// OCR 改造(2026-06-22):身份证 / 护照 / 回乡证走 OCR(isOcrDocument,见 realname.constants);
// **仅 mainland_id 可自动放行 verified**(OCR 匹配+防伪+清晰);护照/回乡证 OCR 后恒人工;其余不 OCR 人工。
export const DOC_TYPE_MAINLAND_ID = 'mainland_id';
export const MEMBER_PROFILE_DOC_TYPE_ID_CARD = 'id_card';

/** 是否大陆身份证(唯一可 OCR 自动放行发号的类型;评审稿 §3.6/分叉②) */
export function isMainlandId(documentTypeCode: string): boolean {
  return documentTypeCode === DOC_TYPE_MAINLAND_ID;
}

/** 是否使用非大陆证件(身份需人工核验;不代表国籍;= 非大陆身份证)。
 *  注:护照/回乡证既命中历史 DB 字段 isForeigner=true 又 isOcrDocument=true(OCR 识别 + 人工最终)。 */
export function isForeignDocument(documentTypeCode: string): boolean {
  return documentTypeCode !== DOC_TYPE_MAINLAND_ID;
}

/**
 * Recruitment owns OCR routing codes, while MemberProfile persists the canonical document_type
 * dictionary code. Keep the public recruitment contract (`mainland_id`) stable and translate only
 * at the promotion boundary so downstream profile CRUD can validate the persisted value.
 */
export function toMemberProfileDocumentTypeCode(documentTypeCode: string): string {
  return isMainlandId(documentTypeCode) ? MEMBER_PROFILE_DOC_TYPE_ID_CARD : documentTypeCode;
}

// 十项收口刀A(2026-07-11;拍板六值):documentTypeCode 白名单(submit DTO @IsIn)。
// 此前仅"非空字符串"校验,任意串(如 'abc')会被 isForeignDocument 判非大陆证件进普通人工队列,
// 且可经 F2 补录 + promote-single 一路写进 member_profiles.documentTypeCode 污染档案。
// 本白名单仍属于 recruitment/OCR 契约；promote 建档时经 toMemberProfileDocumentTypeCode()
// 映射到 member_profiles 的 document_type 字典真值。recognize 端点不挂白名单(未知类型已优雅
// 返 ocrSupported:false 且不烧钱,收紧无收益)。
export const RECRUITMENT_DOCUMENT_TYPE_CODES = [
  DOC_TYPE_MAINLAND_ID,
  'passport',
  'hk_macau_permit',
  'taiwan_permit',
  'foreigner_permit',
  'other',
] as const;

// 十项收口刀A:profileExtra 自由 JSON 的体积/键数上限(DTO @IsObject 只保证形;此前无任何
// 结构约束,仅靠 multipart fieldSize 隐式兜底)。submit 与 F2 admin 改资料共用同一判定。
export const PROFILE_EXTRA_MAX_BYTES = 4096;
export const PROFILE_EXTRA_MAX_KEYS = 20;

/** profileExtra 是否在体积(4KB)/顶层键数(20)限内(纯函数;超限调用方抛 40000)。 */
export function isProfileExtraWithinLimit(extra: Record<string, unknown>): boolean {
  if (Object.keys(extra).length > PROFILE_EXTRA_MAX_KEYS) return false;
  return Buffer.byteLength(JSON.stringify(extra), 'utf8') <= PROFILE_EXTRA_MAX_BYTES;
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
// OCR 鉴伪版充分利用(2026-06-29;评审稿 recruitment-ocr-anti-forgery-enrichment-review.md §3.1/E4):
// 主体框 / 头像裁剪图 storage key 前缀(镜像 idCardImageKey 形态:prefix + cycleId + uuid + ext;
// 裁剪图为腾讯返 base64 JPEG,ext 恒 jpg)。仅 mainland_id 鉴伪版 submit 路径写入。
export const ID_CARD_CROP_IMAGE_KEY_PREFIX = 'recruitment/id-card-crop';
export const ID_CARD_PORTRAIT_IMAGE_KEY_PREFIX = 'recruitment/id-card-portrait';
// 招新可用性收口 F5(2026-07-11;评审稿 §2.8 R5):申请人签名图(multipart 必填文件位 signatureImage;
// 校验镜像 idCardImage〔jpeg/png ≤5MB〕;promote 搬 member_profiles 长期留存,报名行清空)。
export const SIGNATURE_IMAGE_KEY_PREFIX = 'recruitment/signature';
// 招新可用性收口 F7(2026-07-11;评审稿 §2.9 R6):申请人证书图(公开上传,双通道凭证;
// category ∈ cert_type 既有码;每类 ≤3 张重传覆盖;promote 建 pending Certificate 搬 imageKeys)。
// 字面镜像 seed 稳定契约(cert_type 字典项 first_aid / bsafe;certificates.service CERT_STATUS_PENDING)。
export const CERTIFICATE_IMAGE_KEY_PREFIX = 'recruitment/certificate';
export const RECRUITMENT_CERT_CATEGORIES = ['first_aid', 'bsafe'] as const;
export type RecruitmentCertificateCategory = (typeof RECRUITMENT_CERT_CATEGORIES)[number];
export const CERTIFICATE_THRESHOLD_BY_CATEGORY: Record<
  RecruitmentCertificateCategory,
  ThresholdCode
> = {
  first_aid: 'redCross',
  bsafe: 'bsafe',
};

/** 由类别→门槛单一映射反查门槛对应证书类别；非证书门槛返回 null。 */
export function certificateCategoryForThreshold(
  code: ThresholdCode,
): RecruitmentCertificateCategory | null {
  return (
    RECRUITMENT_CERT_CATEGORIES.find(
      (category) => CERTIFICATE_THRESHOLD_BY_CATEGORY[category] === code,
    ) ?? null
  );
}
export const CERTIFICATE_IMAGES_MAX_PER_CATEGORY = 3;

// ===== 紧急联系人(评审稿 D-R + E-R-13;JSON 数组,≥2)=====
export const EMERGENCY_CONTACTS_MIN = 2;

// 复用 realname 的身份证号掩码(audit / 日志;评审稿配套③)
export { maskIdCard };

// =============================================================================
// 招新四期 S4a:H5 + 手机身份链(2026-06-24;评审稿 recruitment-phase4-loop-optimization-review.md §3)
// =============================================================================

// 报名前身份会话 TTL(§3.3「如 30min」):验码 → 发 token,token 30min 内一次性消费
export const RECRUITMENT_IDENTITY_SESSION_TTL_SECONDS = 30 * 60;

// 手机验证方式(application.phoneVerificationMethod / session.phoneVerificationMethod;§3.3)
export const PHONE_VERIFICATION_METHOD_SMS = 'sms'; // H5 短信验码
export const PHONE_VERIFICATION_METHOD_WECHAT = 'wechat'; // 小程序链(辅;本刀提交端不写,预留)

// 自助换手机换绑原因默认值(rebind-phone;无入参时;§3.4)
export const PHONE_CHANGE_REASON_SELF_REBIND = 'self-rebind';

// 报名前身份会话凭证(phoneVerificationToken):明文一次性返客户端,入库只存 sha256 hex
// (沿 refresh-token.util / sms codeHash 范式;§3.2 验后持久凭证净新建)。
// 32 字节 CSPRNG → 64 字符 hex 明文 token;禁 Math.random(沿 SMS E-29)。
export function generatePhoneVerificationToken(): string {
  return randomBytes(32).toString('hex');
}

/** token 入库前 sha256 hex(明文永不入库;查询/消费时同算比对) */
export function hashPhoneVerificationToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}
