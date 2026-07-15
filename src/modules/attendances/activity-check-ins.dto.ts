import { ApiProperty } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// Admin 打卡证据列表只使用统一 page/pageSize 分页，不扩展任何筛选字段。
export class ListActivityCheckInsQueryDto extends PaginationQueryDto {}

export class AdminActivityCheckInMemberDto {
  @ApiProperty({ description: '队员 Member.id' })
  id!: string;

  @ApiProperty({ description: '队员业务编号' })
  memberNo!: string;

  @ApiProperty({ description: '队员显示名' })
  displayName!: string;
}

// Admin 证据复核安全视图。原始坐标、定位精度与顶层 memberId 永不返回。
export class AdminActivityCheckInListItemDto {
  @ApiProperty({ description: '打卡证据主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '活动 Activity.id' })
  activityId!: string;

  @ApiProperty({ description: '打卡所属 ActivityRegistration.id' })
  registrationId!: string;

  @ApiProperty({ description: '队员最小摘要', type: () => AdminActivityCheckInMemberDto })
  member!: AdminActivityCheckInMemberDto;

  @ApiProperty({ description: '服务端签到时间(ISO 8601)' })
  checkInAt!: Date;

  @ApiProperty({ description: '服务端首次签退时间(ISO 8601)', nullable: true, type: Date })
  checkOutAt!: Date | null;

  @ApiProperty({
    description: '签到点到活动坐标距离(米；Decimal 字符串)',
    nullable: true,
    type: String,
  })
  checkInDistance!: string | null;

  @ApiProperty({
    description: '签退点到活动坐标距离(米；Decimal 字符串)',
    nullable: true,
    type: String,
  })
  checkOutDistance!: string | null;

  @ApiProperty({ description: '签到时活动坐标是否完整有效并完成 geofence 计算' })
  geoVerified!: boolean;

  @ApiProperty({ description: '签到时未舍入距离是否严格大于配置半径' })
  outOfRange!: boolean;

  @ApiProperty({ description: '证据创建时间(ISO 8601)' })
  createdAt!: Date;

  @ApiProperty({ description: '证据最近更新时间(ISO 8601)' })
  updatedAt!: Date;
}

// 与既有 AttendanceRecordInputDto 运行时同形的独立 Admin 草稿 DTO；刻意不返回
// contributionPoints，让既有 Sheet submit 继续执行 ContributionRule 预填。
export class AttendanceSheetDraftRecordDto {
  @ApiProperty({ description: '队员 Member.id' })
  memberId!: string;

  @ApiProperty({ description: '考勤角色字典 code；草稿固定为 member', example: 'member' })
  roleCode!: 'member';

  @ApiProperty({ description: '签到时间(ISO 8601)' })
  checkInAt!: Date;

  @ApiProperty({ description: '签退时间(ISO 8601；忘签退时固定回退到 Activity.endAt)' })
  checkOutAt!: Date;

  @ApiProperty({
    description: '服务时长(小时；JSON number；按既有考勤算法保留最多 2 位小数)',
    type: Number,
  })
  serviceHours!: number;

  @ApiProperty({ description: '考勤状态字典 code；草稿固定为 present', example: 'present' })
  attendanceStatusCode!: 'present';

  @ApiProperty({ description: '关联报名 ActivityRegistration.id' })
  registrationId!: string;
}

export class AttendanceSheetDraftFlagDto {
  @ApiProperty({ description: '关联报名 ActivityRegistration.id' })
  registrationId!: string;

  @ApiProperty({ description: '队员 Member.id' })
  memberId!: string;

  @ApiProperty({ description: '是否因缺少首次签退而使用 Activity.endAt 回退' })
  noCheckOut!: boolean;

  @ApiProperty({ description: '签到时未舍入距离是否严格大于当时配置半径' })
  outOfRange!: boolean;

  @ApiProperty({ description: '签到时是否因活动坐标缺失或非法而未完成 geofence 校验' })
  unverified!: boolean;
}

export class AttendanceSheetDraftAbsentRegistrationDto {
  @ApiProperty({ description: '当前审核通过报名 ActivityRegistration.id' })
  registrationId!: string;

  @ApiProperty({ description: '队员 Member.id' })
  memberId!: string;

  @ApiProperty({ description: '队员业务编号' })
  memberNo!: string;

  @ApiProperty({ description: '队员显示名' })
  displayName!: string;
}

export class AttendanceSheetDraftDto {
  @ApiProperty({ description: '活动 Activity.id' })
  activityId!: string;

  @ApiProperty({
    description: '可编辑后提交到既有 attendance-sheets 的考勤记录草稿',
    type: () => [AttendanceSheetDraftRecordDto],
  })
  records!: AttendanceSheetDraftRecordDto[];

  @ApiProperty({
    description: '与 records 通过 registrationId + memberId 稳定关联的证据告警',
    type: () => [AttendanceSheetDraftFlagDto],
  })
  flags!: AttendanceSheetDraftFlagDto[];

  @ApiProperty({
    description: '当前仍审核通过但没有打卡证据的报名；不伪造成 AttendanceRecord',
    type: () => [AttendanceSheetDraftAbsentRegistrationDto],
  })
  absentRegistrations!: AttendanceSheetDraftAbsentRegistrationDto[];
}
