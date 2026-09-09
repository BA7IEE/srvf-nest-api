import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { ActivityMetricRuleCode } from '../../activity-metric-rule';

export class AppActivityMetricCandidateParamsDto {
  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  activityId!: string;
}
export class AppActivityMetricCandidateDetailParamsDto extends AppActivityMetricCandidateParamsDto {
  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  candidateId!: string;
}
export class AppCalculateActivityMetricCandidateDto {
  @ApiProperty({ enum: [1] })
  @Equals(1)
  schemaVersion!: 1;
  @ApiProperty({ minLength: 1, maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/^\S(?:[\s\S]*\S)?$/)
  operationKey!: string;
  @ApiProperty({ minimum: 0, maximum: 2147483646 })
  @IsInt()
  @Min(0)
  @Max(2147483646)
  expectedCandidateRevision!: number;
  @ApiProperty({ minimum: 0, maximum: 2147483646 })
  @IsInt()
  @Min(0)
  @Max(2147483646)
  expectedOutcomeRevision!: number;
  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  metricSetVersionId!: string;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  metricSetDefinitionHash!: string;
  @ApiProperty({ type: [String], minItems: 1, maxItems: 100, uniqueItems: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(64, { each: true })
  bindingIds!: string[];
}
export class AppActivityMetricCandidateResultDto {
  @ApiProperty({ enum: [1] }) schemaVersion!: 1;
  @ApiProperty() candidateId!: string;
  @ApiProperty() activityId!: string;
  @ApiProperty({ minimum: 1 }) revision!: number;
  @ApiProperty() metricSetVersionId!: string;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' }) metricSetDefinitionHash!: string;
  @ApiProperty({ description: '原创建事实，不代表当前有效性', enum: ['candidate'] })
  createdStatusCode!: 'candidate';
  @ApiProperty({ enum: ['system'] }) sourceCode!: 'system';
  @ApiProperty({ minimum: 1, maximum: 100 }) valueCount!: number;
  @ApiProperty({ minimum: 0, maximum: 10000 }) sourceCount!: number;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}
export class AppActivityMetricCandidateValueDto {
  @ApiProperty() metricDefinitionId!: string;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' }) definitionHash!: string;
  @ApiProperty({
    oneOf: [
      { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      { type: 'string', pattern: '^(0|[1-9][0-9]*)(\\.[0-9]+)?$' },
    ],
  })
  value!: string | number;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' }) valueHash!: string;
  @ApiProperty({ enum: ['actual_participant_count_v1', 'actual_participation_hours_v1'] })
  ruleCode!: ActivityMetricRuleCode;
  @ApiProperty({ enum: [1] }) evaluatorVersion!: number;
  @ApiProperty({ enum: ['count', 'hours'] }) unitCode!: 'count' | 'hours';
  @ApiProperty({ minimum: 0, maximum: 6 }) scale!: number;
}
export class AppActivityMetricCandidateDetailDto extends AppActivityMetricCandidateResultDto {
  @ApiProperty({
    description: '读取时核验的即时状态，不写回历史',
    enum: ['fresh', 'stale', 'unavailable'],
  })
  freshness!: 'fresh' | 'stale' | 'unavailable';
  @ApiProperty({ description: '保留的历史输入与规则能否复算原值' }) reproducible!: boolean;
  @ApiProperty({ type: [AppActivityMetricCandidateValueDto], maxItems: 100 })
  values!: AppActivityMetricCandidateValueDto[];
}
