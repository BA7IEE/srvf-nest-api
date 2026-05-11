import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// V2 第一阶段批次 3A activity-registrations 模块 DTO 集合。
// 详见 docs:
//   - 批次3_API前评审决议表.md v1.0 §1.1 / §1.2 / §1.3 / §1.6 / §1.13 / §1.15
//   - 批次3_schema草案_activities_attendances.md v0.5(ActivityRegistration 15 字段位)
//
// **绝对禁止**入参字段:
// - id / createdAt / updatedAt / deletedAt(系统字段)
// - statusCode(状态机内部;由 approve / reject / cancel 动作接口写入)
// - registeredAt / reviewedBy / reviewedAt / reviewNote(audit)
// - cancelledByUserId / cancelledAt / cancelReason(audit;cancelReason 仅通过 CancelRegistrationDto)
// - **CreateMyRegistrationDto 禁 memberId**(Q-A3:USER 路径 service 强制 currentUser.member.id)

// ============ 出参 ============

export class ActivityRegistrationResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '活动外键(Activity.id)' })
  activityId!: string;

  @ApiProperty({ description: '队员外键(Member.id)' })
  memberId!: string;

  @ApiProperty({
    description: '报名状态字典 code(registration_status:pending / pass / reject / cancelled)',
  })
  statusCode!: string;

  @ApiProperty({ description: '报名时间' })
  registeredAt!: Date;

  @ApiPropertyOptional({ description: '审核人 User.id', nullable: true })
  reviewedBy!: string | null;

  @ApiPropertyOptional({ description: '审核时间', nullable: true })
  reviewedAt!: Date | null;

  @ApiPropertyOptional({ description: '审核备注 / 拒绝理由', nullable: true })
  reviewNote!: string | null;

  @ApiPropertyOptional({
    description: '扩展字段(Json;Q-A13 不做嵌套校验)',
    nullable: true,
    type: 'object',
    additionalProperties: true,
  })
  extras!: Record<string, unknown> | null;

  @ApiPropertyOptional({
    description: '取消操作 User.id(取消时写入)',
    nullable: true,
  })
  cancelledByUserId!: string | null;

  @ApiPropertyOptional({ description: '取消时间', nullable: true })
  cancelledAt!: Date | null;

  @ApiPropertyOptional({ description: '取消原因', nullable: true })
  cancelReason!: string | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// 列表精简版:可嵌套 Member 简要(memberNo / displayName)。
export class ActivityRegistrationListItemDto {
  @ApiProperty({ description: '主键' })
  id!: string;

  @ApiProperty({ description: '活动外键' })
  activityId!: string;

  @ApiProperty({ description: '队员外键' })
  memberId!: string;

  @ApiPropertyOptional({ description: '队员编号(冗余字段,便于前端展示)', nullable: true })
  memberNo!: string | null;

  @ApiPropertyOptional({ description: '队员显示名(冗余字段,便于前端展示)', nullable: true })
  memberDisplayName!: string | null;

  @ApiProperty({ description: '报名状态字典 code' })
  statusCode!: string;

  @ApiProperty({ description: '报名时间' })
  registeredAt!: Date;

  @ApiPropertyOptional({ description: '审核时间', nullable: true })
  reviewedAt!: Date | null;

  @ApiPropertyOptional({ description: '取消时间', nullable: true })
  cancelledAt!: Date | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;
}

// ============ 入参:Create(ADMIN 代报名) ============

// Q-A3 决议:ADMIN 路径必填 memberId;USER 走 CreateMyRegistrationDto。
export class CreateRegistrationDto {
  @ApiProperty({
    description: '目标队员 Member.id(ADMIN 代报名必填)',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  memberId!: string;

  @ApiPropertyOptional({
    description: '扩展字段(Json;Q-A13 不做嵌套校验)',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  extras?: Record<string, unknown>;
}

// ============ 入参:Create(USER 自助) ============

// Q-A3 决议:USER 路径 service 强制注入 currentUser.member.id;DTO 不接 memberId。
export class CreateMyRegistrationDto {
  @ApiPropertyOptional({
    description: '扩展字段(Json;Q-A13 不做嵌套校验)',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  extras?: Record<string, unknown>;
}

// ============ 入参:Approve ============

export class ApproveRegistrationDto {
  @ApiPropertyOptional({ description: '审核备注(可选)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reviewNote?: string;
}

// ============ 入参:Reject ============

export class RejectRegistrationDto {
  @ApiProperty({ description: '拒绝理由(必填)', maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reviewNote!: string;
}

// ============ 入参:Cancel ============

export class CancelRegistrationDto {
  @ApiPropertyOptional({ description: '取消原因(可选)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cancelReason?: string;
}

// ============ 列表 query ============

// 管理端列表:按 statusCode 过滤。
export class ListRegistrationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按报名状态过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  statusCode?: string;
}

// 队员端 /me 列表:按 statusCode 过滤(可选)。
export class ListMyRegistrationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按报名状态过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  statusCode?: string;
}

// ============ Export query ============

// Q-A6 决议:第一版仅 CSV;scope 默认 pass,可选 all。
export class ExportRegistrationsQueryDto {
  @ApiPropertyOptional({
    description: '导出格式(第一版仅 csv;传 xlsx 等 → 400)',
    enum: ['csv'],
    default: 'csv',
  })
  @IsOptional()
  @IsIn(['csv'], { message: 'format 必须是 csv(第一版不支持其他格式)' })
  format?: 'csv';

  @ApiPropertyOptional({
    description: '导出范围(默认 pass 仅返通过;all 返全部状态)',
    enum: ['pass', 'all'],
    default: 'pass',
  })
  @IsOptional()
  @IsIn(['pass', 'all'], { message: 'scope 必须是 pass 或 all' })
  scope?: 'pass' | 'all';
}

// ============ activityId 路径参数 DTO ============

// 嵌套子资源路径参数。沿 IdParamDto 但字段名为 activityId(避免与 id 冲突)。
export class ActivityIdParamDto {
  @ApiProperty({
    description: '父资源 Activity.id',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  activityId!: string;
}

// activityId + id 复合路径参数(管理端 approve / reject / cancel)。
export class ActivityRegistrationIdParamDto {
  @ApiProperty({
    description: '父资源 Activity.id',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  activityId!: string;

  @ApiProperty({
    description: '报名记录 id',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  id!: string;
}
