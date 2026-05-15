import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AttachmentAccessLevel } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// V2.x C-7 attachments 实施 PR #6b(2026-05-15):attachments 主模块 DTO 集合。
// 沿 D7-attachments v1.0 §5.4 + 用户 PR #6b 14 项 Q 拍板。
//
// **入参 DTO 字段白名单铁律**(纵深防御;沿 baseline §4.2 / v1 §11):
// - CreateAttachmentDto:严禁 id / uploadedBy / uploadedAt / originalUploaderName /
//   createdAt / updatedAt(forbidNonWhitelisted 兜底拦截)
// - UpdateAttachmentDto:仅允许 description / accessLevel / tags / expireAt 四字段;
//   严禁 key / originalName / mime / size / ownerType / ownerId / checksum / etag /
//   uploadedBy / originalUploaderName / id / createdAt / updatedAt
//
// **不出参 checksum / etag**(Q6 v1.0 锁):AttachmentResponseDto 不暴露内部字段。
// **accessUrl: null 占位**(Q14 v1.0 锁 / 沿 D7 §5.5):Provider 接通前恒返 null;
//   该字段不进 select(非 DB 字段),由 Service 层 toResponseDto 附加。

// ============ 共用上限常量 ============

// 单条 tag 最长 64 字符(沿 baseline 字符长度约束)
const TAG_MAX_LENGTH = 64;
// tags 数组最大 20 条(沿 D7 v1.0 §5.4.1)
const TAGS_MAX_SIZE = 20;
// description 最大 500 字符(沿 D7 v1.0 §5.4.1)
const DESCRIPTION_MAX_LENGTH = 500;
// key 最大 256 字符(沿 D7 v1.0 §5.4.1)
const KEY_MAX_LENGTH = 256;
// originalName 最大 255 字符(沿 D7 v1.0 §5.4.1)
const ORIGINAL_NAME_MAX_LENGTH = 255;
// mime 最大 128 字符(沿 D7 v1.0 §5.4.1)
const MIME_MAX_LENGTH = 128;
// ownerType 最大 64 字符(沿 attachment_type_config.code 上限)
const OWNER_TYPE_MAX_LENGTH = 64;

// ============ 出参 ============

export class AttachmentResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: 'Provider 侧文件唯一引用', example: 'attachments/2026/05/abc.jpg' })
  key!: string;

  @ApiProperty({ description: '原始文件名', example: 'idcard-front.jpg' })
  originalName!: string;

  @ApiProperty({ description: 'MIME 类型', example: 'image/jpeg' })
  mime!: string;

  @ApiProperty({ description: '文件大小(字节)', example: 524288 })
  size!: number;

  @ApiProperty({ description: '上传者 User.id' })
  uploadedBy!: string;

  @ApiProperty({ description: '上传时间(ISO8601)' })
  uploadedAt!: Date;

  @ApiProperty({
    description: '归属业务对象类型(走 attachment_type_configs 白名单)',
    example: 'member',
  })
  ownerType!: string;

  @ApiProperty({ description: '归属对象 cuid' })
  ownerId!: string;

  @ApiPropertyOptional({ description: '用户备注', nullable: true })
  description?: string | null;

  @ApiPropertyOptional({
    description: '访问级别(hint + 索引;实际权限走 RBAC;沿 D7 §6.5)',
    enum: AttachmentAccessLevel,
    nullable: true,
  })
  accessLevel?: AttachmentAccessLevel | null;

  @ApiProperty({ description: '标签数组(PG 原生 String[])', type: [String], example: [] })
  tags!: string[];

  @ApiPropertyOptional({ description: '原始上传者人名(冗余存)', nullable: true })
  originalUploaderName?: string | null;

  @ApiPropertyOptional({ description: '附件本身有效期', nullable: true })
  expireAt?: Date | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;

  // Q14 v1.0 + PR #90:由 storage Provider 生成的签名短链;Provider 不可用时降级为 null
  @ApiPropertyOptional({
    description: '签名访问短链(由 storage Provider 生成;Provider 不可用时降级为 null)',
    nullable: true,
  })
  accessUrl?: string | null;
}

// ============ 入参 ============

export class CreateAttachmentDto {
  @ApiProperty({
    description: 'Provider 侧文件唯一引用',
    maxLength: KEY_MAX_LENGTH,
    example: 'attachments/2026/05/abc.jpg',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(KEY_MAX_LENGTH)
  key!: string;

  @ApiProperty({
    description: '原始文件名',
    maxLength: ORIGINAL_NAME_MAX_LENGTH,
    example: 'idcard-front.jpg',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(ORIGINAL_NAME_MAX_LENGTH)
  originalName!: string;

  @ApiProperty({ description: 'MIME 类型', maxLength: MIME_MAX_LENGTH, example: 'image/jpeg' })
  @IsString()
  @MinLength(1)
  @MaxLength(MIME_MAX_LENGTH)
  mime!: string;

  @ApiProperty({ description: '文件大小(字节;非负)', minimum: 0, example: 524288 })
  @IsInt()
  @Min(0)
  size!: number;

  @ApiProperty({
    description:
      '归属业务对象类型(走 attachment_type_configs 白名单;失败 → 13010;沿 D7 §6.3 / Q1 v1.0)',
    maxLength: OWNER_TYPE_MAX_LENGTH,
    example: 'member',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(OWNER_TYPE_MAX_LENGTH)
  ownerType!: string;

  @ApiProperty({
    description: '归属对象 cuid(Service 层校验真实指向活跃业务行;失败 → 13011)',
    example: 'cl9z3a8b00000abcd1234efgh',
  })
  @IsString()
  @Length(8, 64)
  ownerId!: string;

  @ApiPropertyOptional({ description: '用户备注', maxLength: DESCRIPTION_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(DESCRIPTION_MAX_LENGTH)
  description?: string;

  @ApiPropertyOptional({
    description: '访问级别(hint + 索引;实际权限走 RBAC;沿 D7 §6.5)',
    enum: AttachmentAccessLevel,
  })
  @IsOptional()
  @IsEnum(AttachmentAccessLevel)
  accessLevel?: AttachmentAccessLevel;

  @ApiPropertyOptional({
    description: '标签数组(可选;最多 20 条;每条最长 64;不传默认 [])',
    type: [String],
    maxItems: TAGS_MAX_SIZE,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TAGS_MAX_SIZE)
  @IsString({ each: true })
  @MaxLength(TAG_MAX_LENGTH, { each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: '附件本身有效期(ISO8601;可选)' })
  @IsOptional()
  @IsISO8601()
  expireAt?: string;

  // **不接受**(沿 D7 §5.4.1 + v1 §11):id / uploadedBy / uploadedAt / originalUploaderName /
  //   createdAt / updatedAt / checksum / etag(checksum / etag Q6 v1.0 暂不接受入参;
  //   Provider 接通后由独立 PR 决议)— forbidNonWhitelisted 兜底拦截
}

// V2.x C-7.5 实施 PR #10:upload-url + confirm-upload DTO(沿评审 §8.3 / §8.4 + Q-10-5 / Q-10-6)
//
// upload-url 入参 5 字段(Q6 锁;Q-10-5):**不接受** description / accessLevel / tags / expireAt
//   - 沿评审 §8.4 Q10 锁:PATCH metadata 走独立 PATCH /:id;upload 路径仅承载文件元数据
//
// confirm-upload 入参 1 必填 + 1 可选(Q7 锁;Q-10-6):**仅 uploadToken + checksum?**
//   - 不接受 key(已在 token claims;客户端不可篡改)
//   - 不接受 ownerType / ownerId / originalName / mime / sizeBytes(同上)
//   - 不接受 description / accessLevel / tags / expireAt(沿 Q10 锁)
//   - 不接受任何凭证字段(沿 Q22 锁)

export class GenerateUploadUrlDto {
  @ApiProperty({ description: '附件归属业务对象类型', maxLength: OWNER_TYPE_MAX_LENGTH })
  @IsString()
  @MinLength(1)
  @MaxLength(OWNER_TYPE_MAX_LENGTH)
  ownerType!: string;

  @ApiProperty({ description: '附件归属业务对象 ID', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  ownerId!: string;

  @ApiProperty({
    description: '原始文件名(PII 检测;入 token claims;不进 Provider key)',
    maxLength: ORIGINAL_NAME_MAX_LENGTH,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(ORIGINAL_NAME_MAX_LENGTH)
  originalName!: string;

  @ApiProperty({
    description: 'MIME 类型(走 attachment_mime_configs 白名单)',
    maxLength: MIME_MAX_LENGTH,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(MIME_MAX_LENGTH)
  mime!: string;

  @ApiProperty({ description: '文件大小(字节;走 attachment_size_limit_configs 上限)' })
  @IsInt()
  @Min(0)
  sizeBytes!: number;

  // 🔒 Q6a 锁:不接受 key(由后端按 Q17 规范生成)
  // 🔒 Q6b 锁:不接受 attachmentId(沿 Q9 锁不落 pending row;confirm-upload 一次性落库)
  // 🔒 Q10 锁 + Q-10-5:不接受 description / accessLevel / tags / expireAt
  //   (PATCH metadata 走独立 PATCH /:id;upload 路径仅承载文件元数据)
}

export class UploadUrlResponseDto {
  @ApiProperty({
    description: 'Provider 侧文件唯一引用(后端按 Q17 生成)',
    maxLength: KEY_MAX_LENGTH,
  })
  key!: string;

  @ApiProperty({ description: 'signed upload URL(直传 Provider)' })
  uploadUrl!: string;

  @ApiProperty({
    description: '上传时必传的 HTTP headers(Provider 决定);LocalProvider 可返 {}',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  uploadHeaders!: Record<string, string>;

  @ApiProperty({
    description: '上传 HTTP 方法(沿 Q5c 联合保留;当前默认 PUT;POST 留 multipart 未来)',
    enum: ['PUT', 'POST'],
    default: 'PUT',
  })
  uploadMethod!: 'PUT' | 'POST';

  @ApiProperty({ description: 'signed URL 过期时间(ISO8601;默认 upload TTL = 600s)' })
  expiresAt!: Date;

  @ApiProperty({
    description:
      'HMAC-SHA256 签名 token;confirm-upload 必传;承载 key/ownerType/ownerId/originalName/mime/sizeBytes/uploadedByUserId/iat/exp claims',
  })
  uploadToken!: string;
}

export class ConfirmUploadDto {
  @ApiProperty({
    description:
      'upload-url 端点签发的 HMAC-SHA256 token;承载 key/ownerType/ownerId/originalName/mime/sizeBytes 等 claims',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  uploadToken!: string;

  @ApiPropertyOptional({
    description:
      '客户端计算的 SHA-256 checksum(64 hex);可选;若提供则存 Attachment.checksum;沿 D7-attachments Q6 内部字段语义',
    minLength: 64,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(64, 64)
  checksum?: string;

  // 🔒 Q9 锁:不接受 key(已在 token claims;客户端不可篡改)
  // 🔒 Q10 锁:不接受 ownerType / ownerId / originalName / mime / sizeBytes
  // 🔒 Q10 锁:不接受 description / accessLevel / tags / expireAt(走独立 PATCH /:id)
  // 🔒 Q22 锁:不接受任何凭证字段
}

// PATCH 仅允许 description / accessLevel / tags / expireAt 四字段
//(沿 D7 v1.0 §5.4.2 + Q5 v1.0 拍板:**禁止**改 key / originalName / mime / size /
//  ownerType / ownerId(关键归属信息不可改)/ checksum / etag / uploadedBy / id / 时间戳)。
export class UpdateAttachmentDto {
  @ApiPropertyOptional({ description: '用户备注(传 null 清空)', maxLength: DESCRIPTION_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(DESCRIPTION_MAX_LENGTH)
  description?: string | null;

  @ApiPropertyOptional({ description: '访问级别', enum: AttachmentAccessLevel })
  @IsOptional()
  @IsEnum(AttachmentAccessLevel)
  accessLevel?: AttachmentAccessLevel | null;

  @ApiPropertyOptional({
    description: '标签数组(覆盖式替换;不传不动;传 [] 清空)',
    type: [String],
    maxItems: TAGS_MAX_SIZE,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TAGS_MAX_SIZE)
  @IsString({ each: true })
  @MaxLength(TAG_MAX_LENGTH, { each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: '附件本身有效期(ISO8601;传 null 清空)' })
  @IsOptional()
  @IsISO8601()
  expireAt?: string | null;
}

// ============ 列表入参 ============

// GET /api/v2/attachments(管理后台列表;沿 D7 v1.0 §5.4.3)。
export class ListAttachmentsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '按 ownerType 过滤(精确匹配)',
    maxLength: OWNER_TYPE_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(OWNER_TYPE_MAX_LENGTH)
  ownerType?: string;

  @ApiPropertyOptional({ description: '按 ownerId 过滤(精确匹配)' })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  ownerId?: string;

  @ApiPropertyOptional({ description: '按 uploadedBy 过滤(精确匹配)' })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  uploadedBy?: string;

  @ApiPropertyOptional({ description: '按 MIME 过滤(精确匹配)', maxLength: MIME_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(MIME_MAX_LENGTH)
  mime?: string;

  @ApiPropertyOptional({
    description: '按访问级别过滤',
    enum: AttachmentAccessLevel,
  })
  @IsOptional()
  @IsEnum(AttachmentAccessLevel)
  accessLevel?: AttachmentAccessLevel;

  @ApiPropertyOptional({
    description:
      '按 tag 过滤(含任意 tag 即命中 OR 语义;沿 D7 v0.2 锁;支持单值 `?tags=foo` 或多值 `?tags=a&tags=b`)',
    type: [String],
    maxItems: TAGS_MAX_SIZE,
  })
  @IsOptional()
  // express qs parser:单值 query 解析为 string,多值解析为 string[];统一转 string[]
  @Transform(({ value }: { value: unknown }): string[] =>
    Array.isArray(value) ? (value as string[]) : [String(value)],
  )
  @IsArray()
  @ArrayMaxSize(TAGS_MAX_SIZE)
  @IsString({ each: true })
  @MaxLength(TAG_MAX_LENGTH, { each: true })
  tags?: string[];
}

// GET /api/v2/attachments/by-owner(业务模块常用入口;沿 D7 v1.0 §5.1 端点 6)。
// ownerType + ownerId **必填**。
export class ListAttachmentsByOwnerQueryDto extends PaginationQueryDto {
  @ApiProperty({
    description: '归属业务对象类型(必填)',
    maxLength: OWNER_TYPE_MAX_LENGTH,
    example: 'member',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(OWNER_TYPE_MAX_LENGTH)
  ownerType!: string;

  @ApiProperty({
    description: '归属对象 cuid(必填)',
    example: 'cl9z3a8b00000abcd1234efgh',
  })
  @IsString()
  @Length(8, 64)
  ownerId!: string;
}

// GET /api/v2/attachments/me/uploaded(本人上传列表;沿 D7 v1.0 §5.1 端点 7)。
// 仅分页;uploadedBy 自动按 currentUser.id 注入(不接受入参覆盖)。
// **直接复用 PaginationQueryDto**;controller 直接 @Query() query: PaginationQueryDto。

// IdParamDto 复用 common/dto/id-param.dto;本文件不重复定义。
// query 多值 tags 由 express 默认 parser 支持(`tags=a&tags=b` → string[]);
// class-transformer @Type 由父类 PaginationQueryDto 已应用。
