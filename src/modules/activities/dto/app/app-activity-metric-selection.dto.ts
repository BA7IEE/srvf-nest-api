import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Equals,
  IsDefined,
  IsIn,
  IsInt,
  IsObject,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class AppActivityMetricSetPointerDto {
  @ApiProperty({ description: '精确指标集版本 ID', minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  id!: string;
  @ApiProperty({ description: '指标集稳定编码', maxLength: 64, pattern: '^[a-z][a-z0-9_]*$' })
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z][a-z0-9_]*$/)
  code!: string;
  @ApiProperty({ description: '显式版本号', minimum: 1, maximum: 2147483647 })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  version!: number;
  @ApiProperty({ description: '指标集定义 schema 版本', enum: [1] })
  @Equals(1)
  schemaVersion!: 1;
  @ApiProperty({ description: '精确版本内容 hash', pattern: '^[0-9a-f]{64}$' })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  definitionHash!: string;
}

/** App-only value. Pair semantics are also validated by the domain parser before any write. */
export class AppActivityMetricSelectionInputDto {
  @ApiProperty({
    description: '显式要求指标，或明确不要求；不接受 unconfigured',
    enum: ['not_required', 'required'],
  })
  @IsIn(['not_required', 'required'])
  metricRequirementCode!: 'not_required' | 'required';
  @ApiProperty({
    description: 'required 必须给精确指针；not_required 必须显式 null',
    type: () => AppActivityMetricSetPointerDto,
    nullable: true,
  })
  @ValidateIf((_, value: unknown) => value !== null)
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AppActivityMetricSetPointerDto)
  metricSetPointer!: AppActivityMetricSetPointerDto | null;
}

export class AppSelectActivityMetricSetDto {
  @ApiProperty({
    description: '客户端操作键；重试复用，不允许首尾空白',
    minLength: 1,
    maxLength: 128,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/^\S(?:[\s\S]*\S)?$/)
  operationKey!: string;
  @ApiProperty({
    description: '读取到的当前选择 revision；首次配置为 0',
    minimum: 0,
    maximum: 2147483647,
  })
  @IsInt()
  @Min(0)
  @Max(2147483647)
  expectedRevision!: number;
  @ApiProperty({
    description: '完整替换的指标选择',
    type: () => AppActivityMetricSelectionInputDto,
  })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AppActivityMetricSelectionInputDto)
  metricSelection!: AppActivityMetricSelectionInputDto;
}

export class AppActivityMetricSelectionResultDto {
  @ApiProperty({ description: 'Activity ID' }) activityId!: string;
  @ApiProperty({ description: '本次成功命令记录的选择', enum: ['not_required', 'required'] })
  metricRequirementCode!: 'not_required' | 'required';
  @ApiProperty({
    description: '本次命令冻结的精确指针',
    type: () => AppActivityMetricSetPointerDto,
    nullable: true,
  })
  metricSetPointer!: AppActivityMetricSetPointerDto | null;
  @ApiProperty({
    description: '本次命令记录的 revision；重放不递增',
    minimum: 1,
    maximum: 2147483647,
  })
  metricSelectionRevision!: number;
}

export class AppActivityMetricSelectionResponseDto {
  @ApiProperty({ description: 'Activity ID' }) activityId!: string;
  @ApiProperty({
    description: '实时选择状态；旧活动保留 unconfigured',
    enum: ['unconfigured', 'not_required', 'required'],
  })
  metricRequirementCode!: 'unconfigured' | 'not_required' | 'required';
  @ApiProperty({
    description: '历史精确指针；退役不抹去解释',
    type: () => AppActivityMetricSetPointerDto,
    nullable: true,
  })
  metricSetPointer!: AppActivityMetricSetPointerDto | null;
  @ApiProperty({ description: '当前选择 revision', minimum: 0, maximum: 2147483647 })
  metricSelectionRevision!: number;
  @ApiProperty({ description: '历史集版本名称；未选集时为空', type: String, nullable: true })
  metricSetName!: string | null;
  @ApiProperty({ description: '此选择目前是否可用于新选择；不代表已完成指标或可发布' })
  selectable!: boolean;
}
