import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

import {
  CONTENT_ATTACHMENT_KINDS,
  CONTENT_BODY_MAX,
  CONTENT_KEYWORD_MAX,
  CONTENT_PAGE_SIZE_MAX,
  CONTENT_STATUSES,
  CONTENT_SUMMARY_MAX,
  CONTENT_TAG_MAX_LENGTH,
  CONTENT_TAGS_MAX_SIZE,
  CONTENT_TITLE_MAX,
  CONTENT_TYPE_CODE_MAX,
  CONTENT_VISIBILITIES,
  CONTENT_VISIBILITY_CODE_MAX,
} from './content.constants';

// CMS 内容发布模块(第 28 模块)T2(2026-06-21):content admin surface DTO 集合(评审稿 §2/§6/§8)。
// T3/T4(2026-06-21):追加 open/v1(公开)+ app/v1(会员)读取面 DTO(评审稿 §8 open/app)。
//
// 物理隔离铁律(沿 api-surface-policy §2.1 / Phase 0.7):各 surface DTO 独立 class,
// **禁止**继承 / Pick / Omit / Mapped Types 其它 surface DTO。admin 面 DTO 含 authorUserId /
// 全状态全可见档(管理视角);body 改写 + 附件签名 URL 详情时填充。
// **读取面(open + app 共用)DTO 永不暴露 authorUserId / visibleOrganizationIds**(L3 / 内部纪律,
// 评审稿 §8 / §5.7);visibilityCode 可回显(展示档位),但 org-id 列表对读者隐藏。

// ============ 入参 ============

export class CreateContentDto {
  @ApiProperty({ description: '标题', maxLength: CONTENT_TITLE_MAX })
  @IsString()
  @MinLength(1)
  @MaxLength(CONTENT_TITLE_MAX)
  title!: string;

  @ApiPropertyOptional({ description: '摘要', maxLength: CONTENT_SUMMARY_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(CONTENT_SUMMARY_MAX)
  summary?: string;

  @ApiProperty({
    description: '正文 Markdown 原文(含 ![](attachment:<id>) 占位;服务端不解析/不消毒 HTML)',
    maxLength: CONTENT_BODY_MAX,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(CONTENT_BODY_MAX)
  body!: string;

  @ApiProperty({
    description: '内容类型(content_type 字典 ACTIVE item;失败 → 29010)',
    maxLength: CONTENT_TYPE_CODE_MAX,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(CONTENT_TYPE_CODE_MAX)
  contentTypeCode!: string;

  @ApiProperty({
    description: '可见档(每篇选一;失败 → 29011)',
    enum: CONTENT_VISIBILITIES as unknown as string[],
    maxLength: CONTENT_VISIBILITY_CODE_MAX,
  })
  @IsString()
  @IsIn(CONTENT_VISIBILITIES, { message: '可见级无效' })
  visibilityCode!: string;

  @ApiPropertyOptional({
    description:
      '可见部门 orgId 数组(仅 department 档必填且须全为活跃部门;非 department 档须空;失败 → 29012)',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  visibleOrganizationIds?: string[];

  @ApiPropertyOptional({
    description: '标签数组(读取面 hasSome 筛选)',
    type: [String],
    maxItems: CONTENT_TAGS_MAX_SIZE,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CONTENT_TAGS_MAX_SIZE)
  @IsString({ each: true })
  @MaxLength(CONTENT_TAG_MAX_LENGTH, { each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: '是否置顶', default: false })
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}

// 更新:全字段可选(沿 recruitment update 范式);archived 态被 service 冻结(29030)。
export class UpdateContentDto {
  @ApiPropertyOptional({ description: '标题', maxLength: CONTENT_TITLE_MAX })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(CONTENT_TITLE_MAX)
  title?: string;

  @ApiPropertyOptional({ description: '摘要(传 null 清空)', maxLength: CONTENT_SUMMARY_MAX })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(CONTENT_SUMMARY_MAX)
  summary?: string | null;

  @ApiPropertyOptional({ description: '正文 Markdown 原文', maxLength: CONTENT_BODY_MAX })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(CONTENT_BODY_MAX)
  body?: string;

  @ApiPropertyOptional({ description: '内容类型(content_type 字典 ACTIVE item)' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(CONTENT_TYPE_CODE_MAX)
  contentTypeCode?: string;

  @ApiPropertyOptional({
    description: '可见档(每篇选一)',
    enum: CONTENT_VISIBILITIES as unknown as string[],
  })
  @IsOptional()
  @IsString()
  @IsIn(CONTENT_VISIBILITIES, { message: '可见级无效' })
  visibilityCode?: string;

  @ApiPropertyOptional({
    description: '可见部门 orgId 数组(department 档必填活跃部门;非 department 档须空)',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  visibleOrganizationIds?: string[];

  @ApiPropertyOptional({
    description: '标签数组(覆盖式替换)',
    type: [String],
    maxItems: CONTENT_TAGS_MAX_SIZE,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CONTENT_TAGS_MAX_SIZE)
  @IsString({ each: true })
  @MaxLength(CONTENT_TAG_MAX_LENGTH, { each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: '是否置顶' })
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}

// 取附件上传 URL(kind=image|file;评审稿 §8 端点 9)。
export class ContentAttachmentUploadUrlDto {
  @ApiProperty({
    description: '附件种类(image=封面/正文图;file=文件附件)',
    enum: CONTENT_ATTACHMENT_KINDS,
  })
  @IsString()
  @IsIn(CONTENT_ATTACHMENT_KINDS, { message: '附件种类无效' })
  kind!: 'image' | 'file';

  @ApiProperty({ description: '原始文件名(PII 检测;入 token claims)', maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  originalName!: string;

  @ApiProperty({ description: 'MIME 类型(走 content-image/content-file 白名单)', maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  mime!: string;

  @ApiProperty({ description: '文件大小(字节;走 content-* 大小上限)', minimum: 0 })
  @IsInt()
  @Min(0)
  sizeBytes!: number;
}

// 确认上传(评审稿 §8 端点 10;透传 AttachmentsService.confirmUpload 的 1 必填 + 2 可选)。
export class ContentAttachmentConfirmDto {
  @ApiProperty({ description: 'upload-url 端点签发的 HMAC-SHA256 token' })
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  uploadToken!: string;

  @ApiPropertyOptional({ description: '客户端计算的 SHA-256 checksum(64 hex;可选)' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  checksum?: string;

  @ApiPropertyOptional({ description: 'Provider etag(可选;LocalProvider 可缺)' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  etag?: string;
}

// 设 / 清封面(评审稿 §8 端点 12;attachmentId=null 清封面)。
export class SetContentCoverDto {
  @ApiProperty({
    description: '封面对应 content-image 附件 id;传 null 清空封面',
    nullable: true,
    type: String,
  })
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MinLength(1)
  attachmentId!: string | null;
}

// ============ 列表入参(评审稿 §8 端点 2;admin 见全部状态/可见档)============

export class ListContentAdminQueryDto {
  @ApiPropertyOptional({ description: '页码', default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    description: `每页数量(上限 ${CONTENT_PAGE_SIZE_MAX})`,
    default: 20,
    minimum: 1,
    maximum: CONTENT_PAGE_SIZE_MAX,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CONTENT_PAGE_SIZE_MAX)
  pageSize: number = 20;

  @ApiPropertyOptional({ description: '按状态过滤(draft/published/archived)' })
  @IsOptional()
  @IsString()
  @IsIn(CONTENT_STATUSES)
  statusCode?: string;

  @ApiPropertyOptional({ description: '按内容类型过滤' })
  @IsOptional()
  @IsString()
  @MaxLength(CONTENT_TYPE_CODE_MAX)
  contentTypeCode?: string;

  @ApiPropertyOptional({ description: '按可见档过滤' })
  @IsOptional()
  @IsString()
  @IsIn(CONTENT_VISIBILITIES)
  visibilityCode?: string;

  @ApiPropertyOptional({ description: '关键词(标题 + 正文 ILIKE)', maxLength: CONTENT_KEYWORD_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(CONTENT_KEYWORD_MAX)
  keyword?: string;

  @ApiPropertyOptional({
    description: '按标签过滤(含任意 tag 即命中;支持 ?tags=a&tags=b 或单值)',
    type: [String],
    maxItems: CONTENT_TAGS_MAX_SIZE,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }): string[] =>
    Array.isArray(value) ? (value as string[]) : [String(value)],
  )
  @IsArray()
  @ArrayMaxSize(CONTENT_TAGS_MAX_SIZE)
  @IsString({ each: true })
  @MaxLength(CONTENT_TAG_MAX_LENGTH, { each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: '按置顶过滤' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' || value === true
      ? true
      : value === 'false' || value === false
        ? false
        : value,
  )
  @IsBoolean()
  pinned?: boolean;
}

// ============ 出参(admin 面;含 authorUserId 全字段)============

// 内容附件视图(content-image + content-file;评审稿 §8 端点 3)。
export class ContentAttachmentDto {
  @ApiProperty({ description: '附件 id' }) id!: string;
  @ApiProperty({ description: '种类(image=content-image / file=content-file)' }) kind!:
    | 'image'
    | 'file';
  @ApiProperty({ description: 'MIME 类型' }) mime!: string;
  @ApiProperty({ description: '原始文件名' }) originalName!: string;
  @ApiProperty({ description: '文件大小(字节)' }) size!: number;
  @ApiPropertyOptional({ description: '签名访问短链(Provider 不可用时降级 null)', nullable: true })
  url!: string | null;
}

// 列表 item(每行含 coverImageUrl + viewCount;评审稿 §8 端点 2)。
export class ContentAdminListItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional({ nullable: true }) summary!: string | null;
  @ApiProperty() contentTypeCode!: string;
  @ApiProperty() statusCode!: string;
  @ApiProperty() visibilityCode!: string;
  @ApiProperty({ type: [String] }) tags!: string[];
  @ApiPropertyOptional({ description: '封面缩略图签名 URL(coverImageKey 直签)', nullable: true })
  coverImageUrl!: string | null;
  @ApiProperty() pinned!: boolean;
  @ApiProperty({ description: '累计 PV' }) viewCount!: number;
  @ApiPropertyOptional({ nullable: true }) publishedAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) authorUserId!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

// 详情(body 已改写占位 + 附件列表 + coverImageUrl + viewCount〔不增〕;评审稿 §8 端点 3)。
export class ContentAdminDetailDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional({ nullable: true }) summary!: string | null;
  @ApiProperty({ description: '正文 Markdown(attachment:<id> 占位已改写为签名 URL)' })
  body!: string;
  @ApiProperty() contentTypeCode!: string;
  @ApiProperty() statusCode!: string;
  @ApiProperty() visibilityCode!: string;
  @ApiProperty({ type: [String] }) visibleOrganizationIds!: string[];
  @ApiProperty({ type: [String] }) tags!: string[];
  @ApiPropertyOptional({ description: '封面缩略图签名 URL', nullable: true })
  coverImageUrl!: string | null;
  @ApiPropertyOptional({ nullable: true }) coverAttachmentId!: string | null;
  @ApiProperty({
    type: [ContentAttachmentDto],
    description: '附件列表(content-image + content-file)',
  })
  attachments!: ContentAttachmentDto[];
  @ApiProperty() pinned!: boolean;
  @ApiProperty({ description: '累计 PV(admin 详情不自增)' }) viewCount!: number;
  @ApiPropertyOptional({ nullable: true }) publishedAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) authorUserId!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

// ============ 读取面入参(open + app 共用;评审稿 §6/§8;读者无 status/visibility 过滤)============

// 读者**无** statusCode / visibilityCode 过滤(可见性由 service 按 caller 上下文闸控,绝不让读者旁路);
// 仅 page / pageSize(≤50)/ keyword(标题+正文 ILIKE)/ tags(hasSome)/ contentTypeCode。
export class ListContentReadQueryDto {
  @ApiPropertyOptional({ description: '页码', default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    description: `每页数量(上限 ${CONTENT_PAGE_SIZE_MAX})`,
    default: 20,
    minimum: 1,
    maximum: CONTENT_PAGE_SIZE_MAX,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CONTENT_PAGE_SIZE_MAX)
  pageSize: number = 20;

  @ApiPropertyOptional({ description: '按内容类型过滤' })
  @IsOptional()
  @IsString()
  @MaxLength(CONTENT_TYPE_CODE_MAX)
  contentTypeCode?: string;

  @ApiPropertyOptional({ description: '关键词(标题 + 正文 ILIKE)', maxLength: CONTENT_KEYWORD_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(CONTENT_KEYWORD_MAX)
  keyword?: string;

  @ApiPropertyOptional({
    description: '按标签过滤(含任意 tag 即命中;支持 ?tags=a&tags=b 或单值)',
    type: [String],
    maxItems: CONTENT_TAGS_MAX_SIZE,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }): string[] =>
    Array.isArray(value) ? (value as string[]) : [String(value)],
  )
  @IsArray()
  @ArrayMaxSize(CONTENT_TAGS_MAX_SIZE)
  @IsString({ each: true })
  @MaxLength(CONTENT_TAG_MAX_LENGTH, { each: true })
  tags?: string[];
}

// ============ 读取面出参(open + app 共用;评审稿 §8 open/app)============
// **零敏感**:无 authorUserId / 无 statusCode(读者只见 published)/ 无 visibleOrganizationIds(L3 纪律);
// visibilityCode 回显展示档位;签名 URL(封面 / 正文图 / 附件)仅在可见级通过后填充(范围例外 a,§5.7)。

// 读取面列表 item(无 body;封面缩略图签名 URL + viewCount;评审稿 §8 open/app 列表)。
export class ContentReadListItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional({ nullable: true }) summary!: string | null;
  @ApiProperty() contentTypeCode!: string;
  @ApiProperty({ type: [String] }) tags!: string[];
  @ApiPropertyOptional({ description: '封面缩略图签名 URL(coverImageKey 直签)', nullable: true })
  coverImageUrl!: string | null;
  @ApiProperty() pinned!: boolean;
  @ApiProperty({ description: '累计 PV' }) viewCount!: number;
  @ApiPropertyOptional({ nullable: true }) publishedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}

// 读取面详情(body 已改写占位 + 附件列表 + coverImageUrl + viewCount〔已自增〕;评审稿 §8 open/app 详情)。
export class ContentReadDetailDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional({ nullable: true }) summary!: string | null;
  @ApiProperty({ description: '正文 Markdown(attachment:<id> 占位已改写为签名 URL)' })
  body!: string;
  @ApiProperty() contentTypeCode!: string;
  @ApiProperty({ description: '可见档(展示用;不回显可见部门 orgId 列表)' }) visibilityCode!: string;
  @ApiProperty({ type: [String] }) tags!: string[];
  @ApiPropertyOptional({ description: '封面缩略图签名 URL', nullable: true })
  coverImageUrl!: string | null;
  @ApiProperty({
    type: [ContentAttachmentDto],
    description: '附件列表(content-image + content-file;签名 URL 随文章可见级)',
  })
  attachments!: ContentAttachmentDto[];
  @ApiProperty() pinned!: boolean;
  @ApiProperty({ description: '累计 PV(详情已自增)' }) viewCount!: number;
  @ApiPropertyOptional({ nullable: true }) publishedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}
