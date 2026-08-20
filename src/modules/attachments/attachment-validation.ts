// V2.x C-7 attachments 实施 PR #6b(2026-05-15):attachments 主模块 validation 辅助。
// 沿 D7-attachments v1.0 §6.5 / §6.6 / §9.4 + 用户 PR #6b Q1 / Q3 / Q4 拍板。
//
// 本文件集中:
// - ATTACHMENT_OWNER_TYPES TS enum(Q1:业务层代码防错;配置表是运行时权威源)
// - SYSTEM_MIME_BLOCKLIST 精确 + 通配前缀(Q3:D7 §6.6 黑名单)
// - PII 检测正则 + helper(Q4:身份证号 \d{17}[\dXx])

// ============ ownerType 业务层 TS enum(Q1 v1.0)============

// 沿 D7-attachments v1.0 启用 member / certificate / activity;
// CMS 内容模块(2026-06-21)追加 content-image / content-file(评审稿 §5.1;两 owner 均指向 contents 表)。
// 其余场景(培训资料 / 装备图)延后实装时,同步追加 enum 与 attachment_type_configs seed。
//
// **Q1 双层校验语义**:
// - 业务层 enum 是**代码防错**(编译期已知;Service / DTO 引用此常量);
// - 配置表 attachment_type_configs.code 是**运行时权威源**(运营可启停 / 新增 type)
// - 校验顺序:**配置表先**(权威);**enum 兜底**(双保险)
export const ATTACHMENT_OWNER_TYPES = [
  'member',
  'certificate',
  'activity',
  'content-image',
  'content-file',
  // Internal-only owner. It is deliberately known to the trusted facade but fail-closed on every
  // generic Admin attachment endpoint.
  'registration-upload-session',
  // Final immutable registration-answer owner. It has no generic read/write surface either.
  'registration-form-answer',
  // B6 CSV preview source. It is anchored to ActivityBatchJob and can only be read by the
  // attendance import parser facade; generic attachment surfaces reject it.
  'attendance-import-preview',
  // issue #1055 T1. 账号头像与队员标准照:两者都带 generic API 无从知晓的领域不变量
  // (「必须是本人的」/「一个 Member 至多一张 ACTIVE」/「替换要版本化」),
  // 因此同样是 internal-only,只能走各自的专用 facade(issue §12)。
  'user-avatar',
  'member-official-portrait',
] as const;
export type AttachmentOwnerType = (typeof ATTACHMENT_OWNER_TYPES)[number];

export function isKnownAttachmentOwnerType(value: string): value is AttachmentOwnerType {
  return (ATTACHMENT_OWNER_TYPES as readonly string[]).includes(value);
}

// ============ internal-only owner 集合(唯一真相)============

/**
 * 视觉身份两个 owner(issue #1055)。它是 internal-only 集合的**子集**,单独列出来是因为
 * 「可信 facade 允许读哪些 owner」必须比「哪些 owner 不走通用接口」更窄 ——
 * facade 的受控查询若按整个 internal-only 集合放行,就等于顺手把
 * `registration-form-answer`(报名答案的最终附件)也开给了 users / members 模块。
 */
export const VISUAL_IDENTITY_ATTACHMENT_OWNER_TYPES = [
  'user-avatar',
  'member-official-portrait',
] as const satisfies readonly AttachmentOwnerType[];

export function isVisualIdentityAttachmentOwner(ownerType: string): boolean {
  return (VISUAL_IDENTITY_ATTACHMENT_OWNER_TYPES as readonly string[]).includes(ownerType);
}

/**
 * 这些 ownerType 在**每一个 generic Attachment 端点上都 fail-closed**:
 * 建 / 改 / 删 / 取详情一律拒绝,list 默认排除,显式按它筛则返回空页。只有各自的可信 facade 能碰。
 *
 * ⚠️ 本常量是**为了消灭一类缺陷而存在的**,不是顺手抽的工具:
 * 在此之前这份名单以三份手抄副本存在 —— `isInternalRegistrationAttachmentOwner()` 里一个三路 `||`,
 * 外加 `attachments.service.ts` 里两个内联 `notIn` 数组。新增一个 internal owner 要同时改三处,
 * **漏掉任何一处都是静默敞口**(漏 predicate = 写路径洞开;漏 notIn = 内部附件泄进通用列表),
 * 而三处都不会因为漏改而编译失败或测试变红。现在三处都读这一份。
 *
 * `satisfies` 不是装饰:它让「往这里写一个不存在的 ownerType」变成编译错误 ——
 * 否则拼错一个字符的后果是「这条永远匹配不上」,同样静默。
 */
export const INTERNAL_ONLY_ATTACHMENT_OWNER_TYPES = [
  'registration-upload-session',
  'registration-form-answer',
  'attendance-import-preview',
  // 视觉身份两个 owner 由上面的子集常量提供,**不在这里重列** ——
  // 重列就会有两份名单,而它们迟早不一致。
  ...VISUAL_IDENTITY_ATTACHMENT_OWNER_TYPES,
] as const satisfies readonly AttachmentOwnerType[];

// ============ 系统级 MIME 黑名单(Q3 v1.0;沿 D7 §6.6)============

// 精确匹配的黑名单 MIME(可执行 / 压缩包 / 高危类型)
const SYSTEM_MIME_BLOCKLIST_EXACT: ReadonlySet<string> = new Set([
  'application/x-msdownload',
  'application/x-executable',
  'application/x-dosexec',
  'application/x-sh',
  'application/x-bat',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-rar-compressed',
  'image/svg+xml',
  'text/html',
  'application/xhtml+xml',
]);

// 通配前缀黑名单(`video/*` 完整禁;沿 D7 §6.6 注释"走独立多媒体管理评审")
const SYSTEM_MIME_BLOCKLIST_PREFIX: ReadonlyArray<string> = ['video/'];

// 检查 mime 是否命中系统级黑名单(精确或通配前缀)。
// 即使后台运营在 attachment_mime_configs 把它配为 ACTIVE 也不允许通过(沿 D7 §6.6
// "永久禁"语义 — Service 层显式兜底 + e2e 验证)。
export function isMimeBlocked(mime: string): boolean {
  if (SYSTEM_MIME_BLOCKLIST_EXACT.has(mime)) return true;
  for (const prefix of SYSTEM_MIME_BLOCKLIST_PREFIX) {
    if (mime.startsWith(prefix)) return true;
  }
  return false;
}

// ============ PII 检测(Q4 v1.0;沿 D7 §9.4)============

// 身份证号正则:18 位中国大陆身份证(17 位数字 + 1 位 数字 / X / x);
// **不**调用 OCR;**不**入库身份证号字符串;仅检测元数据字段中是否含身份证号文本。
const ID_CARD_REGEX = /\d{17}[\dXx]/;

// 检测附件元数据是否含身份证号 PII(originalName / description / tags 三字段)。
// 命中任一字段即返 true,Service 层抛 13015 ATTACHMENT_PII_DETECTED 拒绝。
export interface PiiCheckInput {
  originalName?: string;
  description?: string | null;
  tags?: readonly string[];
}

export function detectPii(input: PiiCheckInput): boolean {
  if (input.originalName !== undefined && ID_CARD_REGEX.test(input.originalName)) {
    return true;
  }
  if (
    input.description !== undefined &&
    input.description !== null &&
    ID_CARD_REGEX.test(input.description)
  ) {
    return true;
  }
  if (input.tags !== undefined && input.tags.some((t) => ID_CARD_REGEX.test(t))) {
    return true;
  }
  return false;
}
