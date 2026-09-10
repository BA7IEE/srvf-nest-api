import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { ActivityMetricConfiguration } from '../../activity-metric-definition';

export class AppActivityOutcomeReportQueryDto {
  @ApiProperty({
    description: '逐个有权的活动ID，重复项拒绝，不做跨活动求和',
    type: 'array',
    items: { type: 'string', minLength: 1, maxLength: 64 },
    minItems: 1,
    maxItems: 20,
    uniqueItems: true,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(64, { each: true })
  activityIds!: string[];
}
export class AppActivityOutcomeReportEmptyQueryDto {}

export class AppActivityOutcomeReportDefinitionDto {
  @ApiProperty({ description: '定义格式版本', enum: [1] }) schemaVersion!: 1;
  @ApiProperty({ description: '历史指标代码' }) code!: string;
  @ApiProperty({ description: '历史定义版本', minimum: 1 }) version!: number;
  @ApiProperty({ description: '历史指标名称' }) name!: string;
  @ApiProperty({
    description: '非敏感指标的封闭配置；不提供自由文本型',
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['kindCode', 'unit', 'minimum', 'maximum'],
        properties: {
          kindCode: { type: 'string', enum: ['non_negative_integer'] },
          unit: { type: 'string' },
          minimum: { type: 'integer', minimum: 0 },
          maximum: { type: 'integer', minimum: 0 },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['kindCode', 'unit', 'scale', 'minimum', 'maximum'],
        properties: {
          kindCode: { type: 'string', enum: ['non_negative_decimal'] },
          unit: { type: 'string' },
          scale: { type: 'integer', minimum: 0, maximum: 6 },
          minimum: { type: 'string' },
          maximum: { type: 'string' },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['kindCode', 'unit'],
        properties: {
          kindCode: { type: 'string', enum: ['boolean'] },
          unit: { type: 'string', nullable: true, enum: [null] },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['kindCode', 'unit', 'options'],
        properties: {
          kindCode: { type: 'string', enum: ['single_choice'] },
          unit: { type: 'string', nullable: true, enum: [null] },
          options: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['code', 'label'],
              properties: {
                code: { type: 'string' },
                label: { type: 'string' },
              },
            },
          },
        },
      },
    ],
  })
  configuration!: Exclude<ActivityMetricConfiguration, { kindCode: 'short_text' }>;
}

export class AppActivityOutcomeReportMetricDto {
  @ApiProperty({ description: '正式成果值修订ID' }) valueRevisionId!: string;
  @ApiProperty({ description: '历史指标定义ID' }) metricDefinitionId!: string;
  @ApiProperty({ description: '历史指标定义hash', pattern: '^[0-9a-f]{64}$' })
  definitionHash!: string;
  @ApiProperty({
    description: '保留版本的非敏感定义',
    type: () => AppActivityOutcomeReportDefinitionDto,
  })
  definition!: AppActivityOutcomeReportDefinitionDto;
  @ApiProperty({
    description: '经历史定义验证的值，小数保持规范字符串',
    oneOf: [
      { type: 'integer', minimum: 0 },
      { type: 'string', maxLength: 64 },
      { type: 'boolean' },
    ],
  })
  value!: string | number | boolean;
  @ApiProperty({ description: '已人工确认的值来源', enum: ['manual', 'system'] }) sourceCode!:
    | 'manual'
    | 'system';
}
export class AppActivityOutcomeReportConfirmedDto {
  @ApiProperty({ description: '现行正式成果修订ID' }) outcomeRevisionId!: string;
  @ApiProperty({ description: '正式修订号', minimum: 1 }) revision!: number;
  @ApiProperty({ description: '正式成果的历史指标集版本ID' }) metricSetVersionId!: string;
  @ApiProperty({ description: '历史指标集hash', pattern: '^[0-9a-f]{64}$' })
  metricSetDefinitionHash!: string;
  @ApiProperty({ description: '正式确认时间', type: String, format: 'date-time' })
  confirmedAt!: string;
  @ApiProperty({
    description: '正式值，按指标定义ID排序，不跨活动合计',
    type: () => [AppActivityOutcomeReportMetricDto],
    minItems: 1,
    maxItems: 100,
  })
  metrics!: AppActivityOutcomeReportMetricDto[];
}
@ApiExtraModels(AppActivityOutcomeReportConfirmedDto)
export class AppActivityOutcomeReportDto {
  @ApiProperty({ description: '当前有权活动ID' }) activityId!: string;
  @ApiProperty({ description: '当前活动状态' }) activityStatusCode!: string;
  @ApiProperty({
    description: '当前指标选择状态，不覆盖历史定义',
    enum: ['unconfigured', 'not_required', 'required'],
  })
  metricRequirementCode!: 'unconfigured' | 'not_required' | 'required';
  @ApiProperty({ description: '当前指标选择修订号', minimum: 0 }) metricSelectionRevision!: number;
  @ApiProperty({
    description: '是否有现行正式成果，未确认不等于零值',
    enum: ['confirmed', 'not_confirmed'],
  })
  formalStatus!: 'confirmed' | 'not_confirmed';
  @ApiProperty({
    description: '现行正式成果；无正式头为null',
    oneOf: [
      { $ref: getSchemaPath(AppActivityOutcomeReportConfirmedDto) },
      { type: 'object', nullable: true, enum: [null] },
    ],
  })
  currentConfirmed!: AppActivityOutcomeReportConfirmedDto | null;
}
export class AppActivityOutcomeReportBatchDto {
  @ApiProperty({
    description: '请求集合的完整报告，按活动ID排序；无权则整批拒绝',
    type: () => [AppActivityOutcomeReportDto],
    minItems: 1,
    maxItems: 20,
  })
  items!: AppActivityOutcomeReportDto[];
}
