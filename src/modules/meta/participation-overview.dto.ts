import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';
import { DurationHistogramDto } from '../activities/activity-participation.dto';

const parseQueryBoolean = ({ value }: { value: unknown }): unknown =>
  value === true || value === 'true' ? true : value === false || value === 'false' ? false : value;

export class ParticipationOverviewQueryDto {
  @ApiPropertyOptional({ description: '按 Activity.startAt 过滤起点（ISO 8601，含边界）' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: '按 Activity.startAt 过滤终点（ISO 8601，含边界）' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({ description: '按活动承办组织过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  organizationId?: string;

  @ApiPropertyOptional({
    description: '配合 organizationId：是否含全部后代组织（默认 false）',
    default: false,
  })
  @IsOptional()
  @Transform(parseQueryBoolean)
  @IsBoolean()
  includeDescendants?: boolean;

  @ApiPropertyOptional({ description: '按活动类型字典 code 过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  activityTypeCode?: string;
}

export class ParticipationOverviewMonthDto {
  @ApiProperty({ description: 'Activity.startAt 的 UTC 月份（YYYY-MM）', example: '2026-07' })
  month!: string;

  @ApiProperty({ description: '该月活动数' })
  activityCount!: number;

  @ApiProperty({ description: '该月 completed 活动数' })
  completedActivityCount!: number;

  @ApiProperty({ description: '该月正式到场人次（逐活动去重后求和；合法零值仍计入）' })
  participationCount!: number;

  @ApiProperty({ description: '普通报名通过、无现场通过记录的正式到场人次' })
  registeredParticipationCount!: number;

  @ApiProperty({ description: '现场通过、无普通报名通过记录的正式到场人次' })
  temporaryParticipationCount!: number;

  @ApiProperty({ description: '同时有普通和现场通过记录的正式到场人次' })
  mixedOriginParticipationCount!: number;

  @ApiProperty({ description: '来源记录不足或存在未知来源的正式到场人次' })
  unknownOriginParticipationCount!: number;

  @ApiProperty({
    description: '该月正式时长或入账工时净额；存在到场成员时长未知时为 null',
    type: String,
    nullable: true,
  })
  totalServiceHours!: string | null;

  @ApiProperty({ description: '该月未决参与人次（逐活动去重后求和）' })
  pendingCount!: number;

  @ApiProperty({ description: '该月未决应结算场次身份数，含成员其他场次已到场的情况' })
  pendingSessionCount!: number;

  @ApiProperty({ description: '该月请假、早退零值等其他正式结果人次' })
  otherResultCount!: number;

  @ApiProperty({ description: '该月正式到场但时长来源未知的人次，未计入直方图' })
  durationUnknownCount!: number;

  @ApiProperty({
    description: 'completed 活动正式到场人次/(正式到场+缺席人次)，无已判定人次时为 null',
    nullable: true,
    type: Number,
  })
  averageAttendanceRate!: number | null;

  @ApiProperty({
    description: 'completed 活动正式缺席人次/(正式到场+缺席人次)，无已判定人次时为 null',
    nullable: true,
    type: Number,
  })
  noShowRate!: number | null;

  @ApiProperty({
    description: '有明确时长的正式到场成员按活动×成员计入固定四桶',
    type: DurationHistogramDto,
  })
  durationHistogram!: DurationHistogramDto;
}

export class ParticipationOverviewResponseDto {
  @ApiProperty({
    description: '按月升序的参与总览；无可见组织/无命中活动时为空数组',
    type: [ParticipationOverviewMonthDto],
  })
  months!: ParticipationOverviewMonthDto[];
}
