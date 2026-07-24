import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
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

// query boolean 从 GET query string 解析:原始值是字符串 'true'/'false',@Type(() => Boolean)
// 会用 `Boolean(value)` 转换 —— 任何非空字符串(含 'false')都会变 true,是已知陷阱,
// 故显式判等而非用 @Type(沿 F1/A1 members.dto.ts / A6 activities.dto.ts 同名 helper 惯例,
// 本仓约定按 DTO 文件各自持有一份,不抽共享)。
const parseQueryBoolean = ({ value }: { value: unknown }): unknown =>
  value === true || value === 'true' ? true : value === false || value === 'false' ? false : value;

// V2 第一阶段批次 3B attendances 模块 DTO 集合。
// 详见 docs:
//   - 批次3_API前评审决议表.md v1.0 §1.8 / §1.9 / §1.14
//   - 批次3_schema草案_activities_attendances.md v0.5 §6-§7 / §16 / §19
//
// **绝对禁止**入参字段(全部由全局 ValidationPipe + forbidNonWhitelisted 兜底):
// - id / createdAt / updatedAt / deletedAt(系统字段)
// - statusCode(状态机内部;由 submit / approve / reject / final-approve / final-reject 路径写入)
// - submitterUserId / submittedAt(audit;submit 接口由 service 注入 currentUser.id + now)
// - reviewerUserId / reviewedAt / reviewNote(state machine;通过 approve / reject 写入,
//   且 reviewNote 仅通过 ApproveAttendanceSheetDto / RejectAttendanceSheetDto)
// - finalReviewerUserId / finalReviewedAt(批次 4-B;由 final-approve / final-reject service 注入;
//   finalReviewNote 仅通过 FinalApproveAttendanceSheetDto / FinalRejectAttendanceSheetDto)
// - previousSnapshot(R28 / R27:后端事务内自动生成;前端不上传)
// - version(D41:服务端版本号;前端不上传)

// ============ AttendanceSheet 状态机闭集(v0.61.0 升级为 6 态)============
//
// 单一来源:DTO 层 export,service.ts / e2e / 未来运营后台均 import,**禁止**手写字符串。
// 与字典 `attendance_sheet_status` 6 项闭集保持一致。
//
// 6 态语义:
//   pending              录入员提交 / APD 一级未审
//   pending_final_review APD 一级已通过,等终审(批次 4-B 新增中间态)
//   returned             一审或终审退回修改，records 保留，重提后重新进入一审
//   approved             终审通过(批次 4-B 起语义升级为"贡献值正式生效";非"APD 一级已通过")
//   rejected             APD 一级驳回
//   final_rejected       终审驳回(批次 4-B 新增终态;records 跟随软删)
//
// 注:终审业务角色为"APD 部门部长 / 副部长",但当前实装权限仍沿用管理权限
// (ADMIN / SUPER_ADMIN),细分终审权限将在后续批次实现。
export const ATTENDANCE_SHEET_STATUS = {
  PENDING: 'pending',
  PENDING_FINAL_REVIEW: 'pending_final_review',
  RETURNED: 'returned',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  FINAL_REJECTED: 'final_rejected',
} as const;

// OpenAPI `enum` 元数据;与字典 `attendance_sheet_status` 6 项闭集 1:1 对应。
// 注:DTO 字段层类型保留 `string`,与 Prisma `AttendanceSheet.statusCode: String` 对齐;
// 收紧到 union 会导致 service / Prisma row → DTO 序列化处全是 type assertion 噪声。
export const ATTENDANCE_SHEET_STATUS_VALUES: readonly string[] = [
  ATTENDANCE_SHEET_STATUS.PENDING,
  ATTENDANCE_SHEET_STATUS.PENDING_FINAL_REVIEW,
  ATTENDANCE_SHEET_STATUS.RETURNED,
  ATTENDANCE_SHEET_STATUS.APPROVED,
  ATTENDANCE_SHEET_STATUS.REJECTED,
  ATTENDANCE_SHEET_STATUS.FINAL_REJECTED,
];

export type AttendanceSheetStatusCode =
  (typeof ATTENDANCE_SHEET_STATUS)[keyof typeof ATTENDANCE_SHEET_STATUS];

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
}

// ============ 入参:Create / Update Sheet ============

export class CreateAttendanceSheetDto {
  @ApiProperty({
    description: '考勤记录数组(嵌套创建;事务内一次性入库)',
    type: () => [AttendanceRecordInputDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AttendanceRecordInputDto)
  records!: AttendanceRecordInputDto[];
}

// 编辑 pending/returned Sheet(D38:后端事务内生成 previousSnapshot + version+1;
// 旧 records 软删 + 新 records 创建);白名单严控。
export class UpdateAttendanceSheetDto {
  @ApiPropertyOptional({
    description: '新的考勤记录数组(若传则替换旧 records;旧 records 软删)',
    type: () => [AttendanceRecordInputDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AttendanceRecordInputDto)
  records?: AttendanceRecordInputDto[];
}

// ============ 入参:Approve / Reject(APD 一级)============

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

export class ReturnAttendanceSheetDto {
  @ApiProperty({ description: '退回修改原因', maxLength: 500 })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  returnNote!: string;
}

// 无业务字段；独立 DTO 让全局 forbidNonWhitelisted 拒绝客户端夹带状态或审核责任字段。
export class ResubmitAttendanceSheetDto {}

export class ReopenAttendanceSheetDto {
  @ApiProperty({ description: '撤回终审原因(必填,去除首尾空白后 1-500 字符)', maxLength: 500 })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

// ============ 入参:终审 final-approve / final-reject(批次 4-B 新增)============
// 详见 docs:
//   - 批次4_贡献值业务规则_API草案.md v1.0 D-A2
//   - 批次4_贡献值业务规则_schema草案评审决议表.md v1.0 D-S5
//
// 流程:APD 一级 approve(pending → pending_final_review)→ 终审
// final-approve(→ approved + 触发 attendance.recorded)/ final-reject(→ final_rejected)。
// 注:终审业务角色为"APD 部门部长 / 副部长",当前实装权限仍沿用管理权限
// (ADMIN / SUPER_ADMIN),细分终审权限将在后续批次实现。
// **绝对禁止**字段(沿 ApproveDto / RejectDto 风格):
// - finalReviewerUserId / finalReviewedAt / statusCode(由 service 注入)

export class FinalApproveAttendanceSheetDto {
  @ApiPropertyOptional({
    description: '终审备注(可选;沿 ApproveDto reviewNote 风格)',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  finalReviewNote?: string;
}

export class FinalRejectAttendanceSheetDto {
  @ApiProperty({
    description: '终审驳回理由(必填;沿 RejectDto reviewNote 风格;22046 校验)',
    maxLength: 500,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  finalReviewNote!: string;
}

// ============ 列表 query ============

// F2/B2(admin-api-fe-integration-roadmap.md §4 B2;D1/D6/D7 拍板,2026-07-04):+可选
// q(全局跨轴横扫 admin/v1/attendance-sheets 命中 activityTitle+submitter 的 username/nickname)/
// activityQ(仅命中活动标题)/ organizationId(经 activity→org)/ includeDescendants(配合
// organizationId 展开后代)/ dateFrom+dateTo(按 submittedAt 区间)/ expand(activity 逗号白名单)。
// **本 DTO 同时被嵌套路径 `activities/:activityId/attendance-sheets`(list)复用**——新字段在该
// 端点上溢出但不生效(仅 listAllSheetsForAdmin/B2 消费),沿路线图 §"嵌套轴共享 list DTO 可接受
// 溢出" 拍板。旧字段/响应形状不变(additive)。
export class ListAttendanceSheetsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按 Sheet 状态过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  statusCode?: string;

  @ApiPropertyOptional({
    description:
      '模糊搜索(仅 admin/v1/attendance-sheets 全局横扫生效;命中活动 title + 提交人 username/nickname;contains + insensitive)',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({
    description: '模糊搜索(仅命中活动 title;仅 admin/v1/attendance-sheets 全局横扫生效)',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  activityQ?: string;

  @ApiPropertyOptional({
    description: '按承办组织过滤(经活动 organizationId;仅 admin/v1/attendance-sheets 全局横扫生效)',
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

  @ApiPropertyOptional({ description: '按 submittedAt 区间过滤(起,ISO8601,含边界)' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: '按 submittedAt 区间过滤(止,ISO8601,含边界)' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({
    description:
      '按需展开关联字段(逗号分隔白名单:activity;默认不展开,响应形状不变;仅 admin/v1/attendance-sheets 全局横扫生效)',
    example: 'activity',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  expand?: string;
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
    description: '审核状态字典 code(attendance_sheet_status,6 态;**approved 语义为终审通过**)',
    enum: ATTENDANCE_SHEET_STATUS_VALUES,
  })
  statusCode!: string;

  @ApiPropertyOptional({ description: 'APD 一级审核人 User.id(pending 时 null)', nullable: true })
  reviewerUserId!: string | null;

  @ApiPropertyOptional({ description: 'APD 一级审核时间(pending 时 null)', nullable: true })
  reviewedAt!: Date | null;

  @ApiPropertyOptional({ description: 'APD 一级审核备注 / 驳回理由', nullable: true })
  reviewNote!: string | null;

  // 批次 4-B 新增:终审字段(D-S5);终审通过 / 驳回时由 service 填入。
  // 注:终审权限当前沿用管理权限(ADMIN / SUPER_ADMIN);细分终审权限将在后续批次实现。
  @ApiPropertyOptional({
    description: '终审人 User.id(pending / pending_final_review / rejected 时 null)',
    nullable: true,
  })
  finalReviewerUserId!: string | null;

  @ApiPropertyOptional({
    description: '终审时间(pending / pending_final_review / rejected 时 null)',
    nullable: true,
  })
  finalReviewedAt!: Date | null;

  @ApiPropertyOptional({
    description: '终审备注(终审驳回时必填;沿 reviewNote 风格)',
    nullable: true,
  })
  finalReviewNote!: string | null;

  @ApiProperty({
    description: '最近一次提交或重提人 User.id',
    nullable: true,
    type: String,
  })
  lastSubmittedByUserId!: string | null;

  @ApiProperty({
    description: '最近一次提交或重提时间',
    nullable: true,
    type: Date,
  })
  lastSubmittedAt!: Date | null;

  @ApiProperty({
    description: '最近退回操作人 User.id',
    nullable: true,
    type: String,
  })
  returnedByUserId!: string | null;

  @ApiProperty({
    description: '最近退回时间',
    nullable: true,
    type: Date,
  })
  returnedAt!: Date | null;

  @ApiProperty({
    description: '退回修改原因',
    nullable: true,
    type: String,
  })
  returnNote!: string | null;

  @ApiProperty({
    description: '退回阶段(first 或 final)',
    nullable: true,
    enum: ['first', 'final'],
  })
  returnedFromStageCode!: 'first' | 'final' | null;

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

// ============ 跨轴只读出参(2026-06-23 队员/审批跨轴只读查询 goal)============

// F2/B2(路线图 §4;D6 拍板)expand 展开子对象 —— 独立 admin-surface class,不 extends / Pick /
// Omit AttendanceSheetActivitySummaryDto(该 8 字段 class 是 review-detail 完整视图,D6 要求
// 更小的最小展开字段集,两者用途不同,沿本文件既有隔离惯例物理隔离)。仅 `?expand=activity`
// 命中时出现在响应里。
export class AdminAttendanceSheetExpandedActivityDto {
  @ApiProperty({ description: '活动主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '活动标题' })
  title!: string;

  @ApiProperty({ description: '活动开始时间' })
  startAt!: Date;

  @ApiProperty({ description: '承办组织节点 id' })
  organizationId!: string;
}

// 跨活动考勤单据列表项(审批工作台 Tier2):AttendanceSheetListItemDto 字段 + activityTitle。
// 跨活动横扫时 item 脱离 :activityId 路径段,自带活动上下文。独立 admin-surface class,
// **不** extends / Pick / Omit AttendanceSheetListItemDto(同 surface 也物理隔离)。
// F2/B2(路线图 §4;D6 拍板):+可选 activity(expand 命中时才出现;默认响应形状不变)。
export class AdminAttendanceSheetListItemDto {
  @ApiProperty({ description: '主键' })
  id!: string;

  @ApiProperty({ description: '所属活动 Activity.id' })
  activityId!: string;

  @ApiPropertyOptional({ description: '活动标题(跨轴上下文;软删活动仍可读)', nullable: true })
  activityTitle!: string | null;

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

  @ApiPropertyOptional({
    description: '活动摘要(仅 ?expand 含 activity 时返回;默认省略)',
    type: () => AdminAttendanceSheetExpandedActivityDto,
  })
  activity?: AdminAttendanceSheetExpandedActivityDto;
}

// 某队员考勤记录项(队员 360 Tier3):复用 attendance-presenter 的 record 字段集(admin 字段集,
// 含 member 嵌套 / Decimal→string)+ activityId / activityTitle 跨轴上下文。仅返 approved Sheet
// 内 records(镜像 app /me Q-A14:已生效记录;不暴露 pending / rejected)。独立 admin-surface class。
export class AdminMemberAttendanceRecordDto {
  @ApiProperty({ description: '主键' })
  id!: string;

  @ApiProperty({ description: '所属 Sheet.id' })
  sheetId!: string;

  @ApiProperty({ description: '所属活动 Activity.id(跨轴上下文)' })
  activityId!: string;

  @ApiPropertyOptional({ description: '活动标题(跨轴上下文;软删活动仍可读)', nullable: true })
  activityTitle!: string | null;

  @ApiProperty({ description: '队员 Member.id' })
  memberId!: string;

  @ApiPropertyOptional({ description: '队员嵌套摘要(admin 字段集;复用 presenter)' })
  member?: AttendanceMemberSummaryDto | null;

  @ApiProperty({ description: '考勤角色字典 code' })
  roleCode!: string;

  @ApiProperty({ description: '签到时间' })
  checkInAt!: Date;

  @ApiProperty({ description: '签退时间' })
  checkOutAt!: Date;

  @ApiProperty({ description: '服务时长(Decimal(5,2);序列化为 string)', type: 'string' })
  serviceHours!: string;

  @ApiProperty({ description: '考勤明细状态字典 code' })
  attendanceStatusCode!: string;

  @ApiPropertyOptional({ description: '备注', nullable: true })
  note!: string | null;

  @ApiPropertyOptional({ description: '关联报名记录 id(可空)', nullable: true })
  registrationId!: string | null;

  @ApiPropertyOptional({
    description: '贡献值(Decimal(5,2);序列化为 string)',
    nullable: true,
    type: 'string',
  })
  contributionPoints!: string | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// 某队员贡献值生涯累计汇总(队员 360 Tier3):实时算不落库,复用 team-join computeCappedContribution
// 封顶核(approved sheet + 全局每日封顶 3,生涯无 cutoff;**禁裸 SUM** 绕过封顶会算多)。
export class MemberContributionSummaryDto {
  @ApiProperty({ description: '队员 Member.id' })
  memberId!: string;

  @ApiProperty({
    description:
      '生涯累计贡献值 capped 总分(Decimal;序列化为 string;approved sheet + 北京日封顶 3)',
    type: 'string',
  })
  contributionPoints!: string;
}
