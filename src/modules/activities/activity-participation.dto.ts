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
  @ApiProperty({ description: 'approved record 时长落在 [0,2) 小时的记录数' })
  under2Hours!: number;

  @ApiProperty({ description: 'approved record 时长落在 [2,4) 小时的记录数' })
  from2To4Hours!: number;

  @ApiProperty({ description: 'approved record 时长落在 [4,8) 小时的记录数' })
  from4To8Hours!: number;

  @ApiProperty({ description: 'approved record 时长落在 [8,∞) 小时的记录数' })
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
}

export class ActivityParticipationSummaryDto {
  @ApiProperty({ description: '活动 id' })
  activityId!: string;

  @ApiProperty({ description: '活动状态 code' })
  activityStatusCode!: string;

  @ApiProperty({ description: '按报名状态统计', type: ActivityRegistrationCountsDto })
  registrationCounts!: ActivityRegistrationCountsDto;

  @ApiProperty({ description: '有任意未软删考勤记录的 distinct member 人数' })
  attendeeCount!: number;

  @ApiProperty({ description: 'pass 报名且有任意状态 Sheet 考勤记录的人数' })
  registeredAttendeeCount!: number;

  @ApiProperty({ description: '无任何未软删报名但有考勤记录的临时参加人数' })
  temporaryAttendeeCount!: number;

  @ApiProperty({ description: 'completed 活动中 pass 报名且零考勤记录的人数；其他活动恒 0' })
  noShowCount!: number;

  @ApiProperty({ description: '到场率=有记录 pass 人数/pass 人数，0–1，四位小数' })
  attendanceRate!: number;

  @ApiProperty({ description: 'approved Sheet 内未软删记录 serviceHours 合计', type: String })
  totalServiceHours!: string;

  @ApiProperty({
    description: '该活动 approved Sheet 内未软删记录 contributionPoints 原始合计',
    type: String,
  })
  totalContributionPoints!: string;

  @ApiProperty({
    description: 'approved record 按 serviceHours 固定四桶分布',
    type: DurationHistogramDto,
  })
  durationHistogram!: DurationHistogramDto;

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

  @ApiProperty({ description: '队员显示名' })
  displayName!: string;

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

  @ApiProperty({ description: '队员显示名' })
  displayName!: string;

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
