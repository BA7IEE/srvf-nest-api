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

  @ApiProperty({ description: '该月参与人次（逐活动 distinct 到场 member 人数之和）' })
  participationCount!: number;

  @ApiProperty({ description: '该月所有活动 approved record serviceHours 合计', type: String })
  totalServiceHours!: string;

  @ApiProperty({
    description: 'completed 活动加权到场率=sum(有记录 pass)/sum(pass)，0–1，四位小数',
  })
  averageAttendanceRate!: number;

  @ApiProperty({ description: 'completed 活动缺席率=sum(no-show)/sum(pass)，0–1，四位小数' })
  noShowRate!: number;

  @ApiProperty({
    description: 'approved record 按 serviceHours 固定四桶分布',
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
