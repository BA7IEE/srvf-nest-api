import { ApiProperty } from '@nestjs/swagger';
import { Equals, IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import type { ActivityMetricRuleCode } from '../../activity-metric-rule';

export class AdminCreateActivityMetricRuleBindingDto {
  @ApiProperty({ enum: [1] })
  @Equals(1)
  schemaVersion!: 1;
  @ApiProperty({ description: '重试复用的操作键', minLength: 1, maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/^\S(?:[\s\S]*\S)?$/)
  operationKey!: string;
  @ApiProperty({ description: '精确指标定义 ID', minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  metricDefinitionId!: string;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  definitionHash!: string;
  @ApiProperty({ enum: ['actual_participant_count_v1', 'actual_participation_hours_v1'] })
  @IsIn(['actual_participant_count_v1', 'actual_participation_hours_v1'])
  ruleCode!: ActivityMetricRuleCode;
  @ApiProperty({ enum: [1] })
  @Equals(1)
  evaluatorVersion!: 1;
}

export class AdminActivityMetricRuleBindingResultDto {
  @ApiProperty({ enum: [1] }) schemaVersion!: 1;
  @ApiProperty() bindingId!: string;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' }) bindingHash!: string;
  @ApiProperty() metricDefinitionId!: string;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' }) definitionHash!: string;
  @ApiProperty({ enum: ['actual_participant_count_v1', 'actual_participation_hours_v1'] })
  ruleCode!: ActivityMetricRuleCode;
  @ApiProperty({ enum: [1] }) evaluatorVersion!: number;
  @ApiProperty({ enum: ['count', 'hours'] }) unitCode!: 'count' | 'hours';
  @ApiProperty({ minimum: 0, maximum: 6 }) scale!: number;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}
