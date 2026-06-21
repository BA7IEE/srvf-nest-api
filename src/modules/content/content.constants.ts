// CMS 内容发布模块(第 28 模块)T2(2026-06-21):content 业务常量 + 纯函数 helper。
//
// 沿冻结评审稿 docs/archive/reviews/content-module-review.md(下称「评审稿」)§2/§3/§5/§6/§8。
// 状态机为 String 常量(无 enum,沿 recruitment 范式);可见档 / owner 类型 / DTO 上限集中此处。

// ===== 状态(String;admin 动作立即生效无 cron;评审稿 §3)=====
export const CONTENT_STATUS_DRAFT = 'draft';
export const CONTENT_STATUS_PUBLISHED = 'published';
export const CONTENT_STATUS_ARCHIVED = 'archived';
export const CONTENT_STATUSES = [
  CONTENT_STATUS_DRAFT,
  CONTENT_STATUS_PUBLISHED,
  CONTENT_STATUS_ARCHIVED,
] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

// ===== 可见档(每篇选一;评审稿 §4)=====
export const CONTENT_VISIBILITY_PUBLIC = 'public';
export const CONTENT_VISIBILITY_MEMBER = 'member';
export const CONTENT_VISIBILITY_FORMAL_MEMBER = 'formal_member';
export const CONTENT_VISIBILITY_DEPARTMENT = 'department';
export const CONTENT_VISIBILITY_MANAGEMENT = 'management';
export const CONTENT_VISIBILITIES = [
  CONTENT_VISIBILITY_PUBLIC,
  CONTENT_VISIBILITY_MEMBER,
  CONTENT_VISIBILITY_FORMAL_MEMBER,
  CONTENT_VISIBILITY_DEPARTMENT,
  CONTENT_VISIBILITY_MANAGEMENT,
] as const;
export type ContentVisibility = (typeof CONTENT_VISIBILITIES)[number];

// ===== 内容类型字典(评审稿 §7;contentTypeCode ∈ content_type 字典 ACTIVE item)=====
export const CONTENT_TYPE_DICT_CODE = 'content_type';

// ===== 附件 owner 类型(kebab;两者 ownerId = content.id;评审稿 §5.1)=====
// content-image:封面 + 正文图;content-file:文件附件。均经 AttachmentsService 走写路径 RBAC。
export const CONTENT_OWNER_TYPE_IMAGE = 'content-image';
export const CONTENT_OWNER_TYPE_FILE = 'content-file';

// 附件 kind(DTO 入参 image|file → ownerType 映射;评审稿 §8 端点 9)
export const CONTENT_ATTACHMENT_KINDS = ['image', 'file'] as const;
export type ContentAttachmentKind = (typeof CONTENT_ATTACHMENT_KINDS)[number];

export function ownerTypeForKind(kind: ContentAttachmentKind): string {
  return kind === 'image' ? CONTENT_OWNER_TYPE_IMAGE : CONTENT_OWNER_TYPE_FILE;
}

// ===== DTO 上限(评审稿 §2/§6)=====
export const CONTENT_TITLE_MAX = 200;
export const CONTENT_SUMMARY_MAX = 500;
export const CONTENT_BODY_MAX = 50000;
export const CONTENT_KEYWORD_MAX = 64;
export const CONTENT_TAG_MAX_LENGTH = 32;
export const CONTENT_TAGS_MAX_SIZE = 16;
export const CONTENT_TYPE_CODE_MAX = 64;
export const CONTENT_VISIBILITY_CODE_MAX = 32;
// 列表分页上限(评审稿 §6;比通用 100 更紧,公开读取面防滥取)
export const CONTENT_PAGE_SIZE_MAX = 50;

// ===== 正文图占位读时改写(评审稿 §5.5;wrinkle A)=====
// 占位形态:`![alt](attachment:<attachmentId>)`;只改写**属于本文章**的 content-image 附件 id,
// 外来 / 未知 id 原样保留(渲染坏图,零越权)。
//
// 安全:不消毒 HTML / 不解析 Markdown(服务端只做 token 替换;渲染安全交前端,评审稿 §0)。
const ATTACHMENT_PLACEHOLDER_RE = /attachment:([a-z0-9]+)/gi;

/**
 * 把 body 内 `attachment:<id>` 占位替换为签名 URL。
 * - idToUrlMap 仅含本文章 content-image 附件的 id→signedUrl(调用方从 listOwnerAttachmentsTrusted 构造);
 * - map 未命中的 id(外来 / 已删 / 非本文章)原样保留 → 零越权;
 * - url 为 null(Provider 不可用)时亦原样保留(不写出 'null' 字面)。
 */
export function rewriteBody(body: string, idToUrlMap: ReadonlyMap<string, string | null>): string {
  return body.replace(ATTACHMENT_PLACEHOLDER_RE, (full, id: string) => {
    const url = idToUrlMap.get(id);
    return url ? url : full;
  });
}
