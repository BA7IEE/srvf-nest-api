import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDefined,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import type { ActivityMetricConfiguration } from '../../activity-metric-definition';

export class AppActivityOutcomeParamsDto {
  @ApiProperty({ description: '活动 ID', minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  activityId!: string;
}
export class AppActivityOutcomeDetailParamsDto extends AppActivityOutcomeParamsDto {
  @ApiProperty({ description: '同一活动的成果修订 ID', minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  outcomeRevisionId!: string;
}
export class AppActivityOutcomeValueInputDto {
  @ApiProperty({ description: '精确指标定义 ID', minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  metricDefinitionId!: string;
  @ApiProperty({
    description: '按精确定义校验的非敏感值；小数用规范字符串，选项用代码',
    oneOf: [
      { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      { type: 'string', minLength: 1, maxLength: 64 },
      { type: 'boolean' },
    ],
  })
  @IsDefined()
  value!: string | number | boolean;
  @ApiPropertyOptional({
    description: '本活动附件 ID，顺序保留；省略等价于空数组',
    type: [String],
    maxItems: 20,
    uniqueItems: true,
  })
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(64, { each: true })
  evidenceAttachmentIds: string[] = [];
}
export class AppRecordActivityOutcomeDto {
  @ApiProperty({ description: '重试复用的操作键，不允许首尾空白', minLength: 1, maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/^\S(?:[\s\S]*\S)?$/)
  operationKey!: string;
  @ApiProperty({ description: '最新成果 revision；首次为 0', minimum: 0, maximum: 2147483646 })
  @IsInt()
  @Min(0)
  @Max(2147483646)
  expectedRevision!: number;
  @ApiProperty({ description: '当前精确指标集版本 ID', minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  metricSetVersionId!: string;
  @ApiProperty({ description: '当前精确指标集 hash', pattern: '^[0-9a-f]{64}$' })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  metricSetDefinitionHash!: string;
  @ApiProperty({
    description: '完整成果草稿快照；指标 ID 不重复，不要求已填完所有必填指标',
    type: () => [AppActivityOutcomeValueInputDto],
    minItems: 1,
    maxItems: 100,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AppActivityOutcomeValueInputDto)
  values!: AppActivityOutcomeValueInputDto[];
}
export class AppActivityOutcomeResultDto {
  @ApiProperty({ description: '安全回执版本', enum: [1] }) schemaVersion!: 1;
  @ApiProperty({ description: '活动 ID' }) activityId!: string;
  @ApiProperty({ description: '本次创建的成果修订 ID' }) outcomeRevisionId!: string;
  @ApiProperty({ description: '本次创建的修订号', minimum: 1 }) revision!: number;
  @ApiProperty({ description: '本次采用的精确指标集版本 ID' }) metricSetVersionId!: string;
  @ApiProperty({ description: '本次采用的精确指标集 hash', pattern: '^[0-9a-f]{64}$' })
  metricSetDefinitionHash!: string;
  @ApiProperty({ description: '创建事实，不代表重放时的当前状态', enum: ['draft'] })
  createdStatusCode!: 'draft';
  @ApiProperty({ description: '创建来源', enum: ['manual'] }) sourceCode!: 'manual';
  @ApiProperty({ description: '成果值数量', minimum: 1, maximum: 100 }) valueCount!: number;
  @ApiProperty({ description: '证据引用数量', minimum: 0, maximum: 2000 }) evidenceCount!: number;
  @ApiProperty({ description: '原始创建时间', type: String, format: 'date-time' })
  createdAt!: string;
}
export class AppActivityOutcomeSummaryDto {
  @ApiProperty({ description: '成果修订 ID' }) outcomeRevisionId!: string;
  @ApiProperty({ description: '活动 ID' }) activityId!: string;
  @ApiProperty({ description: '成果修订号', minimum: 1 }) revision!: number;
  @ApiProperty({ description: '历史精确指标集版本 ID' }) metricSetVersionId!: string;
  @ApiProperty({ description: '历史精确指标集 hash', pattern: '^[0-9a-f]{64}$' })
  metricSetDefinitionHash!: string;
  @ApiProperty({
    description: '当前修订状态；草稿不代表正式完成',
    enum: ['draft', 'confirmed', 'superseded'],
  })
  statusCode!: string;
  @ApiProperty({ description: '被替代的前一修订 ID', type: String, nullable: true })
  priorRevisionId!: string | null;
  @ApiProperty({ description: '创建时间', type: String, format: 'date-time' }) createdAt!: string;
}
export class AppActivityOutcomeDefinitionDto {
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
export class AppActivityOutcomeEvidenceDto {
  @ApiProperty({ description: '附件 ID，不包含存储凭证或 URL' }) attachmentId!: string;
  @ApiProperty({ description: '证据顺序', minimum: 0 }) sortOrder!: number;
}
export class AppActivityOutcomeValueDto {
  @ApiProperty({ description: '成果值修订 ID' }) valueRevisionId!: string;
  @ApiProperty({ description: '精确指标定义 ID' }) metricDefinitionId!: string;
  @ApiProperty({ description: '该修订对应的历史定义', type: () => AppActivityOutcomeDefinitionDto })
  definition!: AppActivityOutcomeDefinitionDto;
  @ApiProperty({
    description: '经历史定义和 hash 核验的值',
    oneOf: [
      { type: 'integer', minimum: 0 },
      { type: 'string', maxLength: 64 },
      { type: 'boolean' },
    ],
  })
  value!: string | number | boolean;
  @ApiProperty({
    description: '持久化来源类别，不返回内部来源引用；本接口仅创建 manual',
    enum: ['manual', 'system', 'import', 'ai_suggested_confirmed'],
  })
  sourceCode!: string;
  @ApiProperty({
    description: '有序证据引用',
    type: () => [AppActivityOutcomeEvidenceDto],
    maxItems: 20,
  })
  evidence!: AppActivityOutcomeEvidenceDto[];
}
export class AppActivityOutcomeDetailDto extends AppActivityOutcomeSummaryDto {
  @ApiProperty({
    description: '当前修订的完整成果值快照，不合并其他修订',
    type: () => [AppActivityOutcomeValueDto],
    maxItems: 100,
  })
  values!: AppActivityOutcomeValueDto[];
}
