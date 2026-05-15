// V2.x C-7 attachments 实施 PR #6b(2026-05-15):attachments 主模块 validation 辅助。
// 沿 D7-attachments v1.0 §6.5 / §6.6 / §9.4 + 用户 PR #6b Q1 / Q3 / Q4 拍板。
//
// 本文件集中:
// - ATTACHMENT_OWNER_TYPES TS enum(Q1:业务层代码防错;配置表是运行时权威源)
// - SYSTEM_MIME_BLOCKLIST 精确 + 通配前缀(Q3:D7 §6.6 黑名单)
// - PII 检测正则 + helper(Q4:身份证号 \d{17}[\dXx])

// ============ ownerType 业务层 TS enum(Q1 v1.0)============

// 沿 D7-attachments v1.0 启用场景 1-4(member / certificate / activity);
// 场景 5-6(培训资料 / 装备图)延后实装时,需同步追加 enum 与 attachment_type_configs seed。
//
// **Q1 双层校验语义**:
// - 业务层 enum 是**代码防错**(编译期已知;Service / DTO 引用此常量);
// - 配置表 attachment_type_configs.code 是**运行时权威源**(运营可启停 / 新增 type)
// - 校验顺序:**配置表先**(权威);**enum 兜底**(双保险)
export const ATTACHMENT_OWNER_TYPES = ['member', 'certificate', 'activity'] as const;
export type AttachmentOwnerType = (typeof ATTACHMENT_OWNER_TYPES)[number];

export function isKnownAttachmentOwnerType(value: string): value is AttachmentOwnerType {
  return (ATTACHMENT_OWNER_TYPES as readonly string[]).includes(value);
}

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
