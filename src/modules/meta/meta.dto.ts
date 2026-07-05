import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

// F1/A7(路线图 §4 A7;D5 拍板):meta 模块(net-new)。跨资源批量 id→label 解析,
// 供前端选择器 / 详情页回显跨资源引用(如 audit-log 的 actorUserId、role-binding 的
// principalId)时批量取展示标签,避免逐资源单查。
//
// 防枚举铁律(D5/R13):type 白名单闭集;refs≤200(超限走 ArrayMaxSize → 通用 400,
// 不新增 BizCode,沿 authz/explain 的「格式错误无业务语义」范式);调用者对某 type 无
// 读权限、或 id 不存在/软删 → 静默省略该 id(不报错、不占位、不泄露存在性)。

export const RESOLVABLE_REF_TYPES = [
  'member',
  'user',
  'organization',
  'role',
  'position',
  'activity',
] as const;

export type ResolvableRefType = (typeof RESOLVABLE_REF_TYPES)[number];

const RESOLVE_LABELS_REFS_MAX = 200;

export class ResolveLabelRefDto {
  @ApiProperty({
    description: '资源类型(白名单闭集)',
    enum: RESOLVABLE_REF_TYPES,
    example: 'member',
  })
  @IsIn(RESOLVABLE_REF_TYPES)
  type!: string;

  @ApiProperty({ description: '资源主键 id', example: 'cl9z3a8b00000abcd1234efgh' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  id!: string;
}

export class ResolveLabelsDto {
  @ApiProperty({
    description: `批量待解析引用(≤${RESOLVE_LABELS_REFS_MAX} 条;单请求可混合多 type)`,
    type: [ResolveLabelRefDto],
  })
  @IsArray()
  @ArrayMaxSize(RESOLVE_LABELS_REFS_MAX)
  @ValidateNested({ each: true })
  @Type(() => ResolveLabelRefDto)
  refs!: ResolveLabelRefDto[];
}

// 出参形状按 D5 契约为 {[type]:{[id]:{label,...极少非敏感字段}}} —— 顶层 key 由请求内
// 涉及的 type 动态决定,Swagger 无法静态枚举字段,故本 DTO 刻意不声明具体属性(沿 D5
// "静默省略"语义:某 type 全部 id 都被过滤后,该 type key 本身也不出现)。
export class ResolveLabelsResponseDto {}

// GAP-003(handoff/admin-web.md §4;goal「GAP-003 收口」):工作台/首页待办汇总。三个
// 可省略块,与 resolve-labels 同源的静默省略哲学——block 级权限裁剪,无权限省略整块,
// 不报错(响应恒 200)。字段形状固定(不像 resolve-labels 那样按 type 动态出现),故
// 可正常声明具体属性。

export class DashboardRegistrationsSummaryDto {
  @ApiProperty({ description: '全局待审报名数(registration_status=pending,未软删)' })
  pending!: number;
}

export class DashboardAttendanceSheetsSummaryDto {
  @ApiProperty({ description: '待一级(APD)审核数(attendance_sheet_status=pending,未软删)' })
  pending!: number;

  @ApiProperty({
    description: '待终审数(attendance_sheet_status=pending_final_review,未软删)',
  })
  pendingFinalReview!: number;
}

export class DashboardActivitiesSummaryDto {
  @ApiProperty({ description: '进行中活动数(activity_status=published,未软删)' })
  published!: number;
}

export class DashboardSummaryResponseDto {
  @ApiPropertyOptional({
    type: DashboardRegistrationsSummaryDto,
    description: '报名待办(需 activity-registration.read.record;无权省略本块,非报错)',
  })
  registrations?: DashboardRegistrationsSummaryDto;

  @ApiPropertyOptional({
    type: DashboardAttendanceSheetsSummaryDto,
    description: '考勤待办(需 attendance.read.sheet;无权省略本块,非报错)',
  })
  attendanceSheets?: DashboardAttendanceSheetsSummaryDto;

  @ApiPropertyOptional({
    type: DashboardActivitiesSummaryDto,
    description: '活动概况(无码,同 activities list/detail 现状,任意已登录用户可见)',
  })
  activities?: DashboardActivitiesSummaryDto;
}
