import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// V2 第一阶段批次 3A activities 模块 DTO 集合。
// 详见 docs:
//   - 批次3_API前评审.md v0.2 §5.1
//   - 批次3_API前评审决议表.md v1.0 §1.7 / §1.11 / §1.12 / §1.13
//   - 批次3_schema草案_activities_attendances.md v0.5
//
// **绝对禁止**入参字段(全部由全局 ValidationPipe + forbidNonWhitelisted 兜底):
// - id / createdAt / updatedAt / deletedAt(系统字段)
// - statusCode(状态机内部;由 publish / cancel 动作接口写入)
// - publishedBy / publishedAt / cancelledBy / cancelledAt / cancelReason(audit;
//   cancelReason 仅通过 CancelActivityDto 进入 cancel 接口)
//
// Q-A13 决议:registrationSchema 仅 @IsObject(),不做动态表单引擎(R19)。
// Q-A12 决议:cancelled Activity 拒绝修改,由 service 层抛 ACTIVITY_STATUS_INVALID。
// Q-A11 决议:complete 接口不实装,statusCode='completed' 由字典占位。

// ============ 出参 ============

export class ActivityResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '活动标题', example: '梧桐山轮值演练' })
  title!: string;

  @ApiProperty({ description: '活动类型字典 code(typeCode=activity_type;2 级树)' })
  activityTypeCode!: string;

  @ApiProperty({ description: '承办组织节点 Organization.id(NOT NULL;禁根节点)' })
  organizationId!: string;

  @ApiProperty({ description: '开始时间(ISO 8601)' })
  startAt!: Date;

  @ApiProperty({ description: '结束时间(ISO 8601)' })
  endAt!: Date;

  @ApiProperty({ description: '活动地点(自由文本)' })
  location!: string;

  @ApiPropertyOptional({
    description: '列表展示短说明 / 摘要(详情正文走 content;Q-D14 v1.4 可空)',
    nullable: true,
  })
  description!: string | null;

  @ApiPropertyOptional({
    description: '名额上限(NULL = 不限名额)',
    nullable: true,
  })
  capacity!: number | null;

  @ApiPropertyOptional({
    description: '性别限制字典 code(typeCode=gender_requirement;NULL = 无限制)',
    nullable: true,
  })
  genderRequirementCode!: string | null;

  @ApiPropertyOptional({
    description: '报名截止时间(ISO 8601;NULL = 不限)',
    nullable: true,
  })
  registrationDeadline!: Date | null;

  @ApiPropertyOptional({
    description: '报名补充说明',
    nullable: true,
  })
  registrationNotes!: string | null;

  @ApiProperty({
    description: '活动状态字典 code(activity_status:draft / published / cancelled / completed)',
  })
  statusCode!: string;

  @ApiPropertyOptional({
    description: '发布人 User.id(发布前为 null)',
    nullable: true,
  })
  publishedBy!: string | null;

  @ApiPropertyOptional({ description: '发布时间', nullable: true })
  publishedAt!: Date | null;

  @ApiPropertyOptional({
    description: '取消人 User.id(取消前为 null)',
    nullable: true,
  })
  cancelledBy!: string | null;

  @ApiPropertyOptional({ description: '取消时间', nullable: true })
  cancelledAt!: Date | null;

  @ApiPropertyOptional({ description: '取消原因', nullable: true })
  cancelReason!: string | null;

  @ApiProperty({ description: '是否公开报名(默认 true)' })
  isPublicRegistration!: boolean;

  @ApiPropertyOptional({
    description: '报名表自定义字段 schema(Json;Q-A13 不做嵌套校验)',
    nullable: true,
    type: 'object',
    additionalProperties: true,
  })
  registrationSchema!: Record<string, unknown> | null;

  @ApiPropertyOptional({ description: '封面图片 URL(预留)', nullable: true })
  coverImageUrl!: string | null;

  @ApiPropertyOptional({
    description: '相册图片 URL 数组(Json)',
    nullable: true,
    type: 'array',
    items: { type: 'string' },
  })
  galleryImageUrls!: string[] | null;

  @ApiPropertyOptional({
    description: '正文内容(Json;前端约定结构,后端不解析)',
    nullable: true,
    type: 'object',
    additionalProperties: true,
  })
  content!: Record<string, unknown> | null;

  @ApiPropertyOptional({
    description: '经度(WGS84;Decimal(10,7);序列化为 string)',
    nullable: true,
    type: 'string',
  })
  locationLongitude!: string | null;

  @ApiPropertyOptional({
    description: '纬度(WGS84;Decimal(10,7);序列化为 string)',
    nullable: true,
    type: 'string',
  })
  locationLatitude!: string | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// 列表精简版:不返 content / galleryImageUrls / registrationSchema(评审稿 §5.1)。
export class ActivityListItemDto {
  @ApiProperty({ description: '主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '活动标题' })
  title!: string;

  @ApiProperty({ description: '活动类型字典 code' })
  activityTypeCode!: string;

  @ApiProperty({ description: '承办组织节点 id' })
  organizationId!: string;

  @ApiProperty({ description: '开始时间' })
  startAt!: Date;

  @ApiProperty({ description: '结束时间' })
  endAt!: Date;

  @ApiProperty({ description: '活动地点' })
  location!: string;

  @ApiPropertyOptional({ description: '短说明', nullable: true })
  description!: string | null;

  @ApiPropertyOptional({ description: '名额上限', nullable: true })
  capacity!: number | null;

  @ApiPropertyOptional({ description: '性别限制字典 code', nullable: true })
  genderRequirementCode!: string | null;

  @ApiPropertyOptional({ description: '报名截止时间', nullable: true })
  registrationDeadline!: Date | null;

  @ApiProperty({ description: '活动状态字典 code' })
  statusCode!: string;

  @ApiProperty({ description: '是否公开报名' })
  isPublicRegistration!: boolean;

  @ApiPropertyOptional({ description: '封面图片 URL', nullable: true })
  coverImageUrl!: string | null;

  @ApiPropertyOptional({
    description: '经度(序列化为 string)',
    nullable: true,
    type: 'string',
  })
  locationLongitude!: string | null;

  @ApiPropertyOptional({
    description: '纬度(序列化为 string)',
    nullable: true,
    type: 'string',
  })
  locationLatitude!: string | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// ============ 入参:Create ============

// 必填 6 字段:title / activityTypeCode / organizationId / startAt / endAt / location。
// description 可空(Q-D14 v1.4)。capacity 可空(NULL = 不限名额)。
// isPublicRegistration 不传走 Prisma default=true。
export class CreateActivityDto {
  @ApiProperty({ description: '活动标题(必填)', maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiProperty({
    description: '活动类型字典 code(必填;typeCode=activity_type)',
    maxLength: 64,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  activityTypeCode!: string;

  @ApiProperty({
    description: '承办组织节点 Organization.id(必填;不允许根节点)',
    maxLength: 64,
  })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  organizationId!: string;

  @ApiProperty({ description: '开始时间(ISO 8601;必填)' })
  @IsDateString()
  startAt!: string;

  @ApiProperty({ description: '结束时间(ISO 8601;必填;必须晚于 startAt)' })
  @IsDateString()
  endAt!: string;

  @ApiProperty({ description: '活动地点(必填)', maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  location!: string;

  @ApiPropertyOptional({ description: '短说明', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: '名额上限(NULL = 不限名额;>= 1)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  capacity?: number;

  @ApiPropertyOptional({
    description: '性别限制字典 code(typeCode=gender_requirement)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  genderRequirementCode?: string;

  @ApiPropertyOptional({ description: '报名截止时间(ISO 8601)' })
  @IsOptional()
  @IsDateString()
  registrationDeadline?: string;

  @ApiPropertyOptional({ description: '报名补充说明', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  registrationNotes?: string;

  @ApiPropertyOptional({ description: '是否公开报名(默认 true)' })
  @IsOptional()
  @IsBoolean()
  isPublicRegistration?: boolean;

  @ApiPropertyOptional({
    description: '报名表自定义字段 schema(Json;Q-A13 不做嵌套校验)',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  registrationSchema?: Record<string, unknown>;

  @ApiPropertyOptional({ description: '封面图片 URL', maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  coverImageUrl?: string;

  @ApiPropertyOptional({
    description: '相册图片 URL 数组',
    type: 'array',
    items: { type: 'string' },
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  galleryImageUrls?: string[];

  @ApiPropertyOptional({
    description: '正文内容(Json)',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  content?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: '经度(WGS84;Decimal(10,7);数字入参,后端规范化)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 7 })
  locationLongitude?: number;

  @ApiPropertyOptional({
    description: '纬度(WGS84;Decimal(10,7);数字入参,后端规范化)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 7 })
  locationLatitude?: number;
}

// ============ 入参:Update ============

// PATCH 语义:全字段 optional;**绝对禁止** statusCode / publishedBy / publishedAt /
//   cancelledBy / cancelledAt / cancelReason(forbidNonWhitelisted 兜底)。
// Q-A12:cancelled Activity 由 service 层拒绝修改。
export class UpdateActivityDto {
  @ApiPropertyOptional({ description: '活动标题', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ description: '活动类型字典 code', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  activityTypeCode?: string;

  @ApiPropertyOptional({
    description: '承办组织节点 id(不允许根节点)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  organizationId?: string;

  @ApiPropertyOptional({ description: '开始时间(ISO 8601)' })
  @IsOptional()
  @IsDateString()
  startAt?: string;

  @ApiPropertyOptional({ description: '结束时间(ISO 8601)' })
  @IsOptional()
  @IsDateString()
  endAt?: string;

  @ApiPropertyOptional({ description: '活动地点', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  location?: string;

  @ApiPropertyOptional({ description: '短说明', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: '名额上限', minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  capacity?: number;

  @ApiPropertyOptional({ description: '性别限制字典 code', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  genderRequirementCode?: string;

  @ApiPropertyOptional({ description: '报名截止时间' })
  @IsOptional()
  @IsDateString()
  registrationDeadline?: string;

  @ApiPropertyOptional({ description: '报名补充说明', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  registrationNotes?: string;

  @ApiPropertyOptional({ description: '是否公开报名' })
  @IsOptional()
  @IsBoolean()
  isPublicRegistration?: boolean;

  @ApiPropertyOptional({
    description: '报名表自定义字段 schema',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  registrationSchema?: Record<string, unknown>;

  @ApiPropertyOptional({ description: '封面图片 URL', maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  coverImageUrl?: string;

  @ApiPropertyOptional({
    description: '相册图片 URL 数组',
    type: 'array',
    items: { type: 'string' },
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  galleryImageUrls?: string[];

  @ApiPropertyOptional({
    description: '正文内容',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  content?: Record<string, unknown>;

  @ApiPropertyOptional({ description: '经度' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 7 })
  locationLongitude?: number;

  @ApiPropertyOptional({ description: '纬度' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 7 })
  locationLatitude?: number;
}

// ============ 入参:Cancel ============

// 取消接口 body:仅 cancelReason 可空(运营记录用)。
export class CancelActivityDto {
  @ApiPropertyOptional({ description: '取消原因(可选)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cancelReason?: string;
}

// ============ 列表 query ============

// 分页 + 多字段过滤;USER 角色 service 层强制忽略 statusCode(Q-A7)。
export class ListActivitiesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按活动状态过滤(USER 角色 service 层忽略)', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  statusCode?: string;

  @ApiPropertyOptional({ description: '按活动类型字典 code 过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  activityTypeCode?: string;

  @ApiPropertyOptional({ description: '按承办组织节点 id 过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  organizationId?: string;

  @ApiPropertyOptional({ description: '按是否公开报名过滤' })
  @IsOptional()
  @IsBoolean()
  isPublicRegistration?: boolean;
}
