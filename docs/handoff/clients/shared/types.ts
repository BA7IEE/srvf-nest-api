// 由 scripts/generate-fe-client.ts 生成,请勿手改。
// 真相源:后端 live /api/docs-json;本文件派生自 docs/handoff/openapi.json 快照。
// surface: shared —— 被两个及以上 surface 共用的类型(唯一定义处)
// contractVersion: 0.67.0
// generatorVersion: 1.0.0
// inputDigest: sha256:de35a90a0bee19af0ba1ecaa61d66b3d79c26e62e0b06f38beb3cc9aaf4ec734

/** 统一响应 envelope —— 全仓契约恒为 { code, message, data }。 */
export interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

/** 分页形状 —— 由 @ApiWrappedPageResponse 保证,items 元素类型逐接口指定。 */
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 传输层由消费方注入 —— 生成器不产生任何网络与凭证代码。五个 surface 共用同一份定义。 */
export interface FetchRequest {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

export type Fetcher = <T>(request: FetchRequest) => Promise<ApiEnvelope<T>>;

export interface ActivityPublishReviewResponseDto {
  "id": string;
  "activityId": string;
  "requestType": "initial" | "change";
  "requestVersion": number;
  "baseRevision": number;
  "status": "pending" | "approved" | "returned" | "withdrawn" | "cancelled";
  "snapshot": Record<string, unknown>;
  "directPublish": boolean;
  "audienceTagCodes"?: string[] | null;
  "submittedByUserId": string;
  "submittedAt": string;
  "reviewedByUserId": string | null;
  "reviewedAt": string | null;
  "reviewNote": string | null;
  "createdAt": string;
  "updatedAt": string;
  "activityTitle": string;
  "organizationId": string;
  "initiatorMemberId": string | null;
  "changeDiff"?: Record<string, unknown>;
  "affectedMemberCount"?: number;
}

export interface ContentAttachmentDto {
  "id": string;
  "kind": string;
  "mime": string;
  "originalName": string;
  "size": number;
  "url"?: string | null;
}

export interface ContentReadDetailDto {
  "id": string;
  "title": string;
  "summary"?: Record<string, unknown> | null;
  "body": string;
  "contentTypeCode": string;
  "visibilityCode": string;
  "tags": string[];
  "coverImageUrl"?: string | null;
  "attachments": ContentAttachmentDto[];
  "pinned": boolean;
  "viewCount": number;
  "publishedAt"?: Record<string, unknown> | null;
  "createdAt": string;
}

export interface ContentReadListItemDto {
  "id": string;
  "title": string;
  "summary"?: Record<string, unknown> | null;
  "contentTypeCode": string;
  "tags": string[];
  "coverImageUrl"?: string | null;
  "pinned": boolean;
  "viewCount": number;
  "publishedAt"?: Record<string, unknown> | null;
  "createdAt": string;
}

export interface PageResultDto {
  "items": unknown[][];
  "total": number;
  "page": number;
  "pageSize": number;
}

export interface UserLinkedMemberDto {
  "memberNo": string;
  "realName": string;
  "nickname"?: Record<string, unknown> | null;
  "label": string;
}

export interface UserResponseDto {
  "id": string;
  "username": string;
  "email"?: Record<string, unknown> | null;
  "nickname"?: Record<string, unknown> | null;
  "avatarKey"?: Record<string, unknown> | null;
  "role": "SUPER_ADMIN" | "ADMIN" | "USER";
  "status": "ACTIVE" | "DISABLED";
  "createdAt": string;
  "lastLoginAt"?: Record<string, unknown> | null;
  "updatedAt": string;
  "memberId"?: Record<string, unknown> | null;
  "member"?: UserLinkedMemberDto;
}
