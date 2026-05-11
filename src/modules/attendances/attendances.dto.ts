import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// V2 第一阶段批次 3B attendances 模块 DTO 集合。
// 详见 docs:
//   - 批次3_API前评审决议表.md v1.0 §1.8 / §1.9 / §1.14
//   - 批次3_schema草案_activities_attendances.md v0.5 §6-§7 / §16 / §19
//
// **绝对禁止**入参字段(全部由全局 ValidationPipe + forbidNonWhitelisted 兜底):
// - id / createdAt / updatedAt / deletedAt(系统字段)
// - statusCode(状态机内部;由 submit / approve / reject 路径写入)
// - submitterUserId / submittedAt(audit;submit 接口由 service 注入 currentUser.id + now)
// - reviewerUserId / reviewedAt / reviewNote(state machine;通过 approve / reject 写入,
//   且 reviewNote 仅通过 ApproveAttendanceSheetDto / RejectAttendanceSheetDto)
// - previousSnapshot(R28 / R27:后端事务内自动生成;前端不上传)
// - version(D41:服务端版本号;前端不上传)

// ============ 入参:AttendanceRecord 嵌套 ============

// Sheet `submit` / `edit` 时嵌套使用;**不**作为独立 schema 路由暴露(Q-A9)。
export class AttendanceRecordInputDto {
  @ApiProperty({ description: '队员 Member.id(必填)', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  memberId!: string;

  @ApiProperty({
    description: '考勤角色字典 code(typeCode=attendance_role;7 项闭集)',
    maxLength: 64,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  roleCode!: string;

  @ApiProperty({ description: '签到时间(ISO 8601;必填)' })
  @IsDateString()
  checkInAt!: string;

  @ApiProperty({ description: '签退时间(ISO 8601;必填;> checkInAt)' })
  @IsDateString()
  checkOutAt!: string;

  @ApiPropertyOptional({
    description:
      '服务时长(小时;Decimal(5,2);未传 service 自动 (checkOutAt - checkInAt)/3600;> 0 且 ≤ 跨度)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  serviceHours?: number;

  @ApiProperty({
    description: '考勤明细状态字典 code(typeCode=attendance_status;present/late/early_leave)',
    maxLength: 64,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  attendanceStatusCode!: string;

  @ApiPropertyOptional({ description: '备注', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({
    description: '关联报名 ActivityRegistration.id(可空;有报名来源时关联;R23 跨表校验)',
    minLength: 8,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  registrationId?: string;

  @ApiPropertyOptional({
    description: '贡献值(Decimal(5,2);字段层可空;Sheet approve 前所有 records 必填,R31)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  contributionPoints?: number;
}

// ============ 入参:Create / Update Sheet ============

export class CreateAttendanceSheetDto {
  @ApiProperty({
    description: '考勤记录数组(嵌套创建;事务内一次性入库)',
    type: () => [AttendanceRecordInputDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AttendanceRecordInputDto)
  records!: AttendanceRecordInputDto[];
}

// 编辑 pending Sheet(D38:后端事务内生成 previousSnapshot + version+1;
// 旧 records 软删 + 新 records 创建);白名单严控。
export class UpdateAttendanceSheetDto {
  @ApiPropertyOptional({
    description: '新的考勤记录数组(若传则替换旧 records;旧 records 软删)',
    type: () => [AttendanceRecordInputDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AttendanceRecordInputDto)
  records?: AttendanceRecordInputDto[];
}

// ============ 入参:Approve / Reject ============

export class ApproveAttendanceSheetDto {
  @ApiPropertyOptional({ description: '审核备注(可选)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reviewNote?: string;
}

export class RejectAttendanceSheetDto {
  @ApiProperty({ description: '驳回理由(必填)', maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reviewNote!: string;
}

// ============ 列表 query ============

export class ListAttendanceSheetsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按 Sheet 状态过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  statusCode?: string;
}

export class MyAttendanceRecordsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '按活动 id 过滤(可选;仅返该活动下的 approved Sheet records)',
    minLength: 8,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  activityId?: string;
}

// ============ 路径参数 DTO ============

// 父资源 activityId 路径参数(POST/GET /activities/:activityId/attendance-sheets);
// 沿 batch 3A 范式,单独 DTO 走 ValidationPipe(避免和 IdParamDto 字段名冲突)。
export class ActivityIdParamDto {
  @ApiProperty({
    description: '父资源 Activity.id',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  activityId!: string;
}

// ============ 出参 ============

// Sheet 简化详情(不含 records 数组,沿 Q-A9 + 评审稿 §5.3)。
// 永不返 previousSnapshot(内部状态)/ deletedAt。
export class AttendanceSheetResponseDto {
  @ApiProperty({ description: '主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '所属活动 Activity.id' })
  activityId!: string;

  @ApiProperty({ description: '提交人 User.id' })
  submitterUserId!: string;

  @ApiProperty({ description: '提交时间' })
  submittedAt!: Date;

  @ApiProperty({
    description: '审核状态字典 code(attendance_sheet_status:pending/approved/rejected)',
  })
  statusCode!: string;

  @ApiPropertyOptional({ description: '审核人 User.id(pending 时 null)', nullable: true })
  reviewerUserId!: string | null;

  @ApiPropertyOptional({ description: '审核时间(pending 时 null)', nullable: true })
  reviewedAt!: Date | null;

  @ApiPropertyOptional({ description: '审核备注 / 驳回理由', nullable: true })
  reviewNote!: string | null;

  @ApiProperty({ description: '版本号(D41;pending 编辑时 +1)' })
  version!: number;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

export class AttendanceSheetListItemDto {
  @ApiProperty({ description: '主键' })
  id!: string;

  @ApiProperty({ description: '所属活动 Activity.id' })
  activityId!: string;

  @ApiProperty({ description: '提交人 User.id' })
  submitterUserId!: string;

  @ApiProperty({ description: '提交时间' })
  submittedAt!: Date;

  @ApiProperty({ description: '审核状态字典 code' })
  statusCode!: string;

  @ApiPropertyOptional({ description: '审核时间', nullable: true })
  reviewedAt!: Date | null;

  @ApiProperty({ description: '版本号' })
  version!: number;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;
}

// Member 嵌套摘要(用于 review-detail / my-records 列表)。
export class AttendanceMemberSummaryDto {
  @ApiProperty({ description: '队员 Member.id' })
  id!: string;

  @ApiProperty({ description: '队员编号' })
  memberNo!: string;

  @ApiProperty({ description: '显示名' })
  displayName!: string;
}

// AttendanceRecord 详情(Q-A9 不独立暴露路由;仅作为 review-detail 嵌套 + /me 列表项)。
export class AttendanceRecordResponseDto {
  @ApiProperty({ description: '主键' })
  id!: string;

  @ApiProperty({ description: '所属 Sheet.id' })
  sheetId!: string;

  @ApiProperty({ description: '队员 Member.id' })
  memberId!: string;

  @ApiPropertyOptional({ description: '队员嵌套摘要(review-detail / /me 列表显示用)' })
  member?: AttendanceMemberSummaryDto | null;

  @ApiProperty({ description: '考勤角色字典 code' })
  roleCode!: string;

  @ApiProperty({ description: '签到时间' })
  checkInAt!: Date;

  @ApiProperty({ description: '签退时间' })
  checkOutAt!: Date;

  @ApiProperty({
    description: '服务时长(Decimal(5,2);序列化为 string)',
    type: 'string',
  })
  serviceHours!: string;

  @ApiProperty({ description: '考勤明细状态字典 code(3 态闭集)' })
  attendanceStatusCode!: string;

  @ApiPropertyOptional({ description: '备注', nullable: true })
  note!: string | null;

  @ApiPropertyOptional({
    description: '关联报名记录 id(可空;临时参加 / 无报名时为 null)',
    nullable: true,
  })
  registrationId!: string | null;

  @ApiPropertyOptional({
    description: '贡献值(Decimal(5,2);序列化为 string;approve 前为 null)',
    nullable: true,
    type: 'string',
  })
  contributionPoints!: string | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// APD 审核完整视图(R25):Activity 摘要 + Sheet 详情 + Records 数组(含 Member 嵌套)。
// 注:Registration 嵌套留 service 层根据 records.registrationId 提供 join;
// 本批次不在 DTO 顶层暴露 registrations 数组(避免泄漏跨 member 信息;评审稿 §5.3)。
export class AttendanceSheetActivitySummaryDto {
  @ApiProperty({ description: 'Activity.id' })
  id!: string;

  @ApiProperty({ description: '活动标题' })
  title!: string;

  @ApiProperty({ description: '活动类型字典 code' })
  activityTypeCode!: string;

  @ApiProperty({ description: '承办组织节点 id' })
  organizationId!: string;

  @ApiProperty({ description: '活动开始时间' })
  startAt!: Date;

  @ApiProperty({ description: '活动结束时间' })
  endAt!: Date;

  @ApiProperty({ description: '活动地点' })
  location!: string;

  @ApiProperty({ description: '活动状态字典 code' })
  statusCode!: string;
}

export class AttendanceSheetReviewDetailDto {
  @ApiProperty({ description: 'Activity 摘要(8 字段;R25 完整视图)' })
  activity!: AttendanceSheetActivitySummaryDto;

  @ApiProperty({ description: 'Sheet 详情' })
  sheet!: AttendanceSheetResponseDto;

  @ApiProperty({
    description: 'Records 完整数组(含 Member 嵌套)',
    type: () => [AttendanceRecordResponseDto],
  })
  records!: AttendanceRecordResponseDto[];
}
