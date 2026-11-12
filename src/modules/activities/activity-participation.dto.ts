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

export class ActivityReconciliationSessionResultDto {
  @ApiProperty({ description: '参与身份 id' })
  identityId!: string;

  @ApiProperty({ description: '场次 id' })
  sessionId!: string;

  @ApiProperty({ description: '当前参与身份状态' })
  currentStatusCode!: string;

  @ApiProperty({ description: '是否属于当前应结算人口' })
  populationIncluded!: boolean;

  @ApiProperty({ description: '当前正式结算结果；尚未入账时为 null', type: String, nullable: true })
  resultCode!: string | null;

  @ApiProperty({ description: '当前正式版本的参与身份×北京日记账日行数，合法零值仍计入' })
  ledgerDayCount!: number;
}

export class ActivityReconciliationParticipantDto {
  @ApiProperty({ description: '永久报名头 id' })
  registrationId!: string;

  @ApiProperty({ description: '队员 id' })
  memberId!: string;

  @ApiProperty({ description: '队员编号' })
  memberNo!: string;

  @ApiProperty({ description: '队员真实姓名', example: '张三' })
  realName!: string;

  @ApiProperty({ description: '队员外号(队内称呼)', nullable: true, type: String })
  nickname!: string | null;

  @ApiProperty({ description: '统一展示标签 `编号 · 姓名(外号)`', example: 'M-0001 · 张三(老张)' })
  label!: string;

  @ApiProperty({
    description: '成员级正式结果；未决和其他结果不伪装成缺席',
    enum: ['attended', 'no-show', 'pending', 'other'],
  })
  outcome!: 'attended' | 'no-show' | 'pending' | 'other';

  @ApiProperty({
    description: '通过修订中的来源证据',
    enum: ['registered', 'onsite', 'mixed', 'unknown'],
  })
  origin!: 'registered' | 'onsite' | 'mixed' | 'unknown';

  @ApiProperty({ description: '当前正式版本的身份×北京日账本日行数，不是旧 Sheet 记录数' })
  recordCount!: number;

  @ApiProperty({ description: '当前正式版本中有 committed 结果的场次身份数' })
  postedResultCount!: number;

  @ApiProperty({
    description: '正式 eligible 时长或已入账工时净额；缺少来源时为 null',
    type: String,
    nullable: true,
  })
  totalServiceHours!: string | null;

  @ApiProperty({
    description: '逐场次身份和正式结果',
    type: [ActivityReconciliationSessionResultDto],
  })
  sessions!: ActivityReconciliationSessionResultDto[];
}

/** Kept as distinct schema names for existing generated-client discovery. */
export class ActivityReconciliationRegisteredParticipantDto extends ActivityReconciliationParticipantDto {}
export class ActivityReconciliationTemporaryParticipantDto extends ActivityReconciliationParticipantDto {}

export class ActivityReconciliationDto {
  @ApiProperty({ description: '活动 id' })
  activityId!: string;

  @ApiProperty({ description: '活动状态 code；本端点仅 completed 可调用', example: 'completed' })
  activityStatusCode!: string;

  @ApiProperty({ description: '未软删且状态为 pass 的报名头数，不等同场次身份人数' })
  passRegistrationCount!: number;

  @ApiProperty({ description: '当前正式结果为到场的去重成员数' })
  attendedCount!: number;

  @ApiProperty({ description: '当前正式结果全部缺席且无待定场次的成员数' })
  noShowCount!: number;

  @ApiProperty({ description: '成员级待定人数，含通过报名尚无身份' })
  pendingCount!: number;

  @ApiProperty({ description: '仅有请假、早退零值等其他正式结果的人数' })
  otherResultCount!: number;

  @ApiProperty({
    description: '普通通过修订来源的参与成员',
    type: [ActivityReconciliationRegisteredParticipantDto],
  })
  registeredParticipants!: ActivityReconciliationRegisteredParticipantDto[];

  @ApiProperty({
    description: '现场通过修订来源的参与成员，不推断此前没有报名',
    type: [ActivityReconciliationTemporaryParticipantDto],
  })
  temporaryParticipants!: ActivityReconciliationTemporaryParticipantDto[];

  @ApiProperty({
    description: '来源混合或未知的参与成员',
    type: [ActivityReconciliationParticipantDto],
  })
  unclassifiedParticipants!: ActivityReconciliationParticipantDto[];
}
