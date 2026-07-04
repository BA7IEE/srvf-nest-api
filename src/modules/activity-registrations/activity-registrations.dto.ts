import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// query boolean 从 GET query string 解析:原始值是字符串 'true'/'false',@Type(() => Boolean)
// 会用 `Boolean(value)` 转换 —— 任何非空字符串(含 'false')都会变 true,是已知陷阱,
// 故显式判等而非用 @Type(沿 F1/A1 members.dto.ts / A6 activities.dto.ts 同名 helper 惯例,
// 本仓约定按 DTO 文件各自持有一份,不抽共享)。
const parseQueryBoolean = ({ value }: { value: unknown }): unknown =>
  value === true || value === 'true' ? true : value === false || value === 'false' ? false : value;

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

// F2/B1(路线图 §4;D6 拍板)expand 展开子对象 —— 独立 admin-surface class,不 extends / Pick /
// Omit 任何既有 DTO(沿本文件既有隔离惯例)。仅 `?expand=member` 命中时出现在响应里。
export class AdminRegistrationExpandedMemberDto {
  @ApiProperty({ description: '队员主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '队员业务编号' })
  memberNo!: string;

  @ApiProperty({ description: '队员显示名' })
  displayName!: string;

  @ApiPropertyOptional({ description: '等级字典 code', nullable: true })
  gradeCode!: string | null;
}

// F2/B1(路线图 §4;D6 拍板)expand 展开子对象。仅 `?expand=activity` 命中时出现在响应里。
export class AdminRegistrationExpandedActivityDto {
  @ApiProperty({ description: '活动主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '活动标题' })
  title!: string;

  @ApiProperty({ description: '活动开始时间' })
  startAt!: Date;

  @ApiProperty({ description: '承办组织节点 id' })
  organizationId!: string;
}

// 跨轴只读列表项(2026-06-23 队员 360 / 跨活动审批面):在 ActivityRegistrationListItemDto
// 字段基础上追加 activityTitle —— 跨活动 / 跨队员横扫时,item 脱离 :activityId 路径段,
// 必须自带活动上下文(activityId 已有 + title)供前端展示。独立 admin-surface class,
// **不** extends / Pick / Omit ActivityRegistrationListItemDto(沿 §2.1 / §0 不跨 surface 派生;
// 同 surface 也保持物理隔离,避免列表项字段集隐式耦合)。
// F2/B1(路线图 §4;D6 拍板):+可选 member / activity(expand 命中时才出现;默认响应形状不变)。
export class AdminRegistrationListItemDto {
  @ApiProperty({ description: '主键' })
  id!: string;

  @ApiProperty({ description: '活动外键' })
  activityId!: string;

  @ApiPropertyOptional({ description: '活动标题(跨轴上下文;软删活动仍可读)', nullable: true })
  activityTitle!: string | null;

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

  @ApiPropertyOptional({
    description: '队员摘要(仅 ?expand 含 member 时返回;默认省略)',
    type: () => AdminRegistrationExpandedMemberDto,
  })
  member?: AdminRegistrationExpandedMemberDto;

  @ApiPropertyOptional({
    description: '活动摘要(仅 ?expand 含 activity 时返回;默认省略)',
    type: () => AdminRegistrationExpandedActivityDto,
  })
  activity?: AdminRegistrationExpandedActivityDto;
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
// F2/B1(admin-api-fe-integration-roadmap.md §4 B1;D1/D6/D7 拍板):+可选 q(全局跨轴横扫
// admin/v1/registrations 命中 memberNo+memberDisplayName+activityTitle)/ memberQ(仅命中队员
// 字段)/ activityQ(仅命中活动标题)/ memberId / activityId(精确过滤)/ organizationId(经
// activity→org)/ includeDescendants(配合 organizationId 展开后代)/ dateFrom+dateTo(按
// registeredAt 区间)/ expand(member,activity 逗号白名单)。**本 DTO 同时被嵌套路径
// `activities/:activityId/registrations`(list)与 `members/:memberId/registrations`
// (listForMemberAdmin)复用**——新字段在这两个端点上溢出但不生效(仅 listAllForAdmin/B1 消费),
// 沿路线图 §"嵌套轴共享 list DTO 可接受溢出" 拍板,OpenAPI 描述已如实注明。旧字段/响应形状不变
// (additive)。
export class ListRegistrationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按报名状态过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  statusCode?: string;

  @ApiPropertyOptional({
    description:
      '模糊搜索(仅 admin/v1/registrations 全局横扫生效;命中 memberNo+memberDisplayName+activityTitle;contains + insensitive)',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({
    description: '模糊搜索(仅命中队员 memberNo+displayName;仅 admin/v1/registrations 全局横扫生效)',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  memberQ?: string;

  @ApiPropertyOptional({
    description: '模糊搜索(仅命中活动 title;仅 admin/v1/registrations 全局横扫生效)',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  activityQ?: string;

  @ApiPropertyOptional({
    description: '按队员精确过滤(仅 admin/v1/registrations 全局横扫生效)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  memberId?: string;

  @ApiPropertyOptional({
    description: '按活动精确过滤(仅 admin/v1/registrations 全局横扫生效)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  activityId?: string;

  @ApiPropertyOptional({
    description: '按承办组织过滤(经活动 organizationId;仅 admin/v1/registrations 全局横扫生效)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  organizationId?: string;

  @ApiPropertyOptional({
    description: '配合 organizationId:是否展开其全部后代组织(默认 false)',
    default: false,
  })
  @IsOptional()
  @Transform(parseQueryBoolean)
  @IsBoolean()
  includeDescendants?: boolean;

  @ApiPropertyOptional({ description: '按 registeredAt 区间过滤(起,ISO8601,含边界)' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: '按 registeredAt 区间过滤(止,ISO8601,含边界)' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({
    description:
      '按需展开关联字段(逗号分隔白名单:member,activity;默认不展开,响应形状不变;仅 admin/v1/registrations 全局横扫生效)',
    example: 'member,activity',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  expand?: string;
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
