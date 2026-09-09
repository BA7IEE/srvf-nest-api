import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDefined,
  IsIn,
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
import { AppActivityOutcomeDetailDto } from './app-activity-outcome.dto';

export class AppOutcomeFinalizationAnchorsDto {
  @ApiProperty({ description: '重试复用的操作键', minLength: 1, maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/^\S(?:[\s\S]*\S)?$/)
  operationKey!: string;
  @ApiProperty({ description: '预期最新修订号，首次为 0', minimum: 0, maximum: 2147483647 })
  @IsInt()
  @Min(0)
  @Max(2147483647)
  expectedLatestRevision!: number;
  @ApiProperty({ description: '预期当前正式修订号，首次为 0', minimum: 0, maximum: 2147483647 })
  @IsInt()
  @Min(0)
  @Max(2147483647)
  expectedConfirmedRevision!: number;
}

export class AppOutcomeFinalizationSelectionDto {
  @ApiProperty({ description: '精确指标定义 ID', minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  metricDefinitionId!: string;
  @ApiProperty({ description: '选定的值来源', enum: ['manual', 'system'] })
  @IsIn(['manual', 'system'])
  sourceKind!: 'manual' | 'system';
  @ApiProperty({ description: '人工草稿值或系统候选值 ID', minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sourceValueId!: string;
  @ApiProperty({
    description: '本活动的有序证据附件 ID',
    type: [String],
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
  evidenceAttachmentIds!: string[];
}

export class AppOutcomeFinalizationSetDto extends AppOutcomeFinalizationAnchorsDto {
  @ApiProperty({ description: '当前精确指标集版本 ID', minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  metricSetVersionId!: string;
  @ApiProperty({ description: '当前指标集定义 hash', pattern: '^[0-9a-f]{64}$' })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  metricSetDefinitionHash!: string;
  @ApiPropertyOptional({
    description: '系统候选 ID；使用系统值时必填',
    type: String,
    nullable: true,
    minLength: 1,
    maxLength: 64,
  })
  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  candidateId?: string | null;
}

export class AppConfirmActivityOutcomeDto extends AppOutcomeFinalizationSetDto {
  @ApiPropertyOptional({
    description: '当前人工草稿 ID；使用人工值时必填',
    type: String,
    nullable: true,
    minLength: 1,
    maxLength: 64,
  })
  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  manualDraftId?: string | null;
  @ApiProperty({
    description: '完整确认选择；必须覆盖所有必填指标',
    type: () => [AppOutcomeFinalizationSelectionDto],
    minItems: 1,
    maxItems: 100,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AppOutcomeFinalizationSelectionDto)
  values!: AppOutcomeFinalizationSelectionDto[];
}

export class AppOutcomeCorrectionValueDto {
  @ApiProperty({ description: '精确指标定义 ID', minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  metricDefinitionId!: string;
  @ApiProperty({ description: '更正值来源', enum: ['manual', 'system'] })
  @IsIn(['manual', 'system'])
  sourceKind!: 'manual' | 'system';
  @ApiPropertyOptional({
    description: '人工更正值；人工来源必填，系统来源禁止',
    oneOf: [
      { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      { type: 'string', minLength: 1, maxLength: 64 },
      { type: 'boolean' },
    ],
  })
  @ValidateIf((row: AppOutcomeCorrectionValueDto) => row.sourceKind === 'manual')
  @IsDefined()
  declare value?: string | number | boolean;
  @ApiPropertyOptional({
    description: '系统候选值 ID；系统来源必填，人工来源禁止',
    minLength: 1,
    maxLength: 64,
  })
  @ValidateIf((row: AppOutcomeCorrectionValueDto) => row.sourceKind === 'system')
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  declare sourceValueId?: string;
  @ApiProperty({
    description: '本活动有序证据；准备更正时允许空数组',
    type: [String],
    maxItems: 20,
    uniqueItems: true,
  })
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(64, { each: true })
  evidenceAttachmentIds!: string[];
}

export class AppPrepareActivityOutcomeCorrectionDto extends AppOutcomeFinalizationSetDto {
  @ApiProperty({
    description: '完整替换草稿，不合并前一修订',
    type: () => [AppOutcomeCorrectionValueDto],
    minItems: 1,
    maxItems: 100,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AppOutcomeCorrectionValueDto)
  values!: AppOutcomeCorrectionValueDto[];
}

export class AppActivityOutcomeFinalizationResultDto {
  @ApiProperty({ description: '安全回执版本', enum: [1] }) schemaVersion!: 1;
  @ApiProperty({ description: '活动 ID' }) activityId!: string;
  @ApiProperty({ description: '命令目标成果修订 ID' }) outcomeRevisionId!: string;
  @ApiProperty({ description: '目标修订号', minimum: 1 }) revision!: number;
  @ApiProperty({
    description: '原始命令事实，不表示当前状态',
    enum: ['draft', 'confirmed', 'superseded'],
  })
  createdStatusCode!: string;
  @ApiProperty({ description: '成果值数量', minimum: 1, maximum: 100 }) valueCount!: number;
  @ApiProperty({ description: '证据数量', minimum: 0, maximum: 2000 }) evidenceCount!: number;
  @ApiProperty({ description: '原始命令时间', type: String, format: 'date-time' })
  createdAt!: string;
  @ApiProperty({
    description: '原始命令类别',
    enum: ['confirm_outcome', 'prepare_outcome_correction', 'cancel_outcome_correction'],
  })
  operationCode!: string;
}

export class AppActivityOutcomeConfirmedDto extends AppActivityOutcomeDetailDto {
  @ApiProperty({ description: '当前唯一正式成果', enum: [true] }) isCurrentConfirmed!: true;
  @ApiProperty({ description: '正式确认时间，不返回确认人身份', type: String, format: 'date-time' })
  confirmedAt!: string;
}
