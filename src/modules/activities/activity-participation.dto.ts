import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { ActivityFeedbackAggregateDto } from '../activity-feedbacks/activity-feedback.dto';

export class ActivityParticipationIdParamDto {
  @ApiProperty({
    description: '活动 id',
    example: 'cl9z3a8b00000abcd1234efgh',
  })
  @IsString()
  @Length(8, 64)
  activityId!: string;
}

export class DurationHistogramDto {
  @ApiProperty({ description: '已知时长落在 [0,2) 小时的观测数；具体单位见调用接口' })
  under2Hours!: number;

  @ApiProperty({ description: '已知时长落在 [2,4) 小时的观测数；具体单位见调用接口' })
  from2To4Hours!: number;

  @ApiProperty({ description: '已知时长落在 [4,8) 小时的观测数；具体单位见调用接口' })
  from4To8Hours!: number;

  @ApiProperty({ description: '已知时长落在 [8,∞) 小时的观测数；具体单位见调用接口' })
  atLeast8Hours!: number;
}

export class ActivityRegistrationCountsDto {
  @ApiProperty({ description: '未软删报名总数' })
  total!: number;

  @ApiProperty({ description: 'pending 报名数' })
  pending!: number;

  @ApiProperty({ description: 'pass 报名数' })
  pass!: number;

  @ApiProperty({ description: 'reject 报名数' })
  reject!: number;

  @ApiProperty({ description: 'cancelled 报名数' })
  cancelled!: number;

  @ApiProperty({ description: 'waitlisted 报名数' })
  waitlisted!: number;
}

export class ActivityParticipationSummaryDto {
  @ApiProperty({ description: '活动 id' })
  activityId!: string;

  @ApiProperty({ description: '活动状态 code' })
  activityStatusCode!: string;

  @ApiProperty({ description: '按报名状态统计', type: ActivityRegistrationCountsDto })
  registrationCounts!: ActivityRegistrationCountsDto;

  @ApiProperty({ description: '当前已入账版本有 present 结果的去重成员数；合法零值仍计入' })
  attendeeCount!: number;

  @ApiProperty({ description: '已到场且有普通报名通过记录、无现场通过记录的成员数' })
  registeredAttendeeCount!: number;

  @ApiProperty({ description: '已到场且有现场通过记录、无普通报名通过记录的成员数' })
  temporaryAttendeeCount!: number;

  @ApiProperty({ description: '已入账结果均为 absent 且无待定场次的成员数' })
  noShowCount!: number;

  @ApiProperty({
    description: '仍有未决参与场次或通过报名尚无身份的成员数；已有正式到场者不重复计入',
  })
  pendingCount!: number;

  @ApiProperty({ description: '未决的应结算场次身份数，包括同一成员已在其他场次到场的情况' })
  pendingSessionCount!: number;

  @ApiProperty({ description: '仅有请假、早退零值等其他正式结果的成员数' })
  otherResultCount!: number;

  @ApiProperty({ description: '已到场但同时存在普通和现场通过记录的成员数' })
  mixedOriginAttendeeCount!: number;

  @ApiProperty({ description: '已到场但来源记录不足或存在未知来源的成员数' })
  unknownOriginAttendeeCount!: number;

  @ApiProperty({
    description: '正式到场人数/(正式到场人数+正式缺席人数)，无已判定人数时为 null',
    nullable: true,
    type: Number,
  })
  attendanceRate!: number | null;

  @ApiProperty({
    description:
      '正式时长收据存在时为 eligible 时长，否则为已入账正负工时净额；存在未明时长时为 null',
    type: String,
    nullable: true,
  })
  totalServiceHours!: string | null;

  @ApiProperty({
    description: '该活动已入账 credited 贡献的正负净额',
    type: String,
  })
  totalContributionPoints!: string;

  @ApiProperty({
    description: '有明确时长的正式到场成员按活动×成员去重后固定四桶分布',
    type: DurationHistogramDto,
  })
  durationHistogram!: DurationHistogramDto;

  @ApiProperty({ description: '正式到场但缺少可验证时长来源的成员数，未计入时长直方图' })
  durationUnknownCount!: number;

  @ApiProperty({
    description: '该活动未软删评价数与两位平均星级',
    type: ActivityFeedbackAggregateDto,
  })
  feedback!: ActivityFeedbackAggregateDto;
}

export class ActivityReconciliationRegisteredParticipantDto {
  @ApiProperty({ description: '报名 id' })
  registrationId!: string;

  @ApiProperty({ description: '队员 id' })
  memberId!: string;

  @ApiProperty({ description: '队员编号' })
  memberNo!: string;

  @ApiProperty({ description: '队员真实姓名', example: '张三' })
  realName!: string;

  @ApiProperty({ description: '队员外号(队内称呼)', nullable: true, type: String })
  nickname!: string | null;

  @ApiProperty({
    description: '统一展示标签 `编号 · 姓名(外号)`;外号为空时不带括号',
    example: 'M-0001 · 张三(老张)',
  })
  label!: string;

  @ApiProperty({ description: '核对结果', enum: ['attended', 'no-show'] })
  outcome!: 'attended' | 'no-show';

  @ApiProperty({ description: '该活动全部未软删考勤记录数（不论 Sheet 状态）' })
  recordCount!: number;

  @ApiProperty({ description: '其中 approved Sheet 记录数' })
  approvedRecordCount!: number;

  @ApiProperty({ description: 'approved Sheet 内 serviceHours 小计', type: String })
  totalServiceHours!: string;
}

export class ActivityReconciliationTemporaryParticipantDto {
  @ApiProperty({ description: '队员 id' })
  memberId!: string;

  @ApiProperty({ description: '队员编号' })
  memberNo!: string;

  @ApiProperty({ description: '队员真实姓名', example: '张三' })
  realName!: string;

  @ApiProperty({ description: '队员外号(队内称呼)', nullable: true, type: String })
  nickname!: string | null;

  @ApiProperty({
    description: '统一展示标签 `编号 · 姓名(外号)`;外号为空时不带括号',
    example: 'M-0001 · 张三(老张)',
  })
  label!: string;

  @ApiProperty({ description: '核对结果', enum: ['temporary'] })
  outcome!: 'temporary';

  @ApiProperty({ description: '该活动全部未软删考勤记录数（不论 Sheet 状态）' })
  recordCount!: number;

  @ApiProperty({ description: '其中 approved Sheet 记录数' })
  approvedRecordCount!: number;

  @ApiProperty({ description: 'approved Sheet 内 serviceHours 小计', type: String })
  totalServiceHours!: string;
}

export class ActivityReconciliationDto {
  @ApiProperty({ description: '活动 id' })
  activityId!: string;

  @ApiProperty({ description: '活动状态 code；本端点仅 completed 可调用', example: 'completed' })
  activityStatusCode!: string;

  @ApiProperty({ description: 'pass 报名人数' })
  passRegistrationCount!: number;

  @ApiProperty({ description: 'pass 报名且有任意状态 Sheet 考勤记录的人数' })
  attendedCount!: number;

  @ApiProperty({ description: 'pass 报名且零未软删考勤记录的人数' })
  noShowCount!: number;

  @ApiProperty({
    description: 'pass 报名逐人核对结果',
    type: [ActivityReconciliationRegisteredParticipantDto],
  })
  registeredParticipants!: ActivityReconciliationRegisteredParticipantDto[];

  @ApiProperty({
    description: '无任何未软删报名但有考勤记录的临时参加名单',
    type: [ActivityReconciliationTemporaryParticipantDto],
  })
  temporaryParticipants!: ActivityReconciliationTemporaryParticipantDto[];
}
