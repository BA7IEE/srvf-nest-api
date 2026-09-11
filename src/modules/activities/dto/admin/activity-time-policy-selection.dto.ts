import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';

export class AdminActivityTimePolicyPointerDto {
  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  policyId!: string;

  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  versionId!: string;

  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  definitionHash!: string;
}

export class AdminActivityTimePolicySelectionScopeDto {
  @ApiProperty({ enum: ['activity', 'session', 'position'] })
  @IsIn(['activity', 'session', 'position'])
  layerCode!: 'activity' | 'session' | 'position';

  @ApiProperty({ nullable: true, minLength: 1, maxLength: 64 })
  @ValidateIf((_, value: unknown) => value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sessionId!: string | null;

  @ApiProperty({ nullable: true, minLength: 1, maxLength: 64 })
  @ValidateIf((_, value: unknown) => value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  positionId!: string | null;
}

export class AdminActivityTimePolicySelectionValueDto {
  @ApiProperty({ enum: ['inherit', 'explicit'] })
  @IsIn(['inherit', 'explicit'])
  mode!: 'inherit' | 'explicit';

  @ApiProperty({ type: () => AdminActivityTimePolicyPointerDto, nullable: true })
  @ValidateIf((_, value: unknown) => value !== null)
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminActivityTimePolicyPointerDto)
  pointer!: AdminActivityTimePolicyPointerDto | null;
}

export class AdminActivityTimePolicySelectionChangeDto {
  @ApiProperty({ type: () => AdminActivityTimePolicySelectionScopeDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminActivityTimePolicySelectionScopeDto)
  scope!: AdminActivityTimePolicySelectionScopeDto;

  @ApiProperty({ type: () => AdminActivityTimePolicySelectionValueDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminActivityTimePolicySelectionValueDto)
  selection!: AdminActivityTimePolicySelectionValueDto;
}

export class AdminPatchActivityTimePolicySelectionDto {
  @ApiProperty({ minLength: 8, maxLength: 128, description: '重试复用的操作键，不允许首尾空白' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^\S(?:[\s\S]*\S)?$/)
  operationKey!: string;

  @ApiProperty({ minimum: 0, maximum: 2147483646 })
  @IsInt()
  @Min(0)
  @Max(2147483646)
  expectedRevision!: number;

  @ApiProperty({
    type: () => [AdminActivityTimePolicySelectionChangeDto],
    minItems: 1,
    maxItems: 100,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AdminActivityTimePolicySelectionChangeDto)
  changes!: AdminActivityTimePolicySelectionChangeDto[];
}

export class AdminActivityTimePolicySelectionQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 2147483647 })
  @OmittableOnly()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  revision?: number;
}

export class AdminActivityTimePolicySelectionResultDto {
  @ApiProperty() activityId!: string;
  @ApiProperty() selectionRevisionId!: string;
  @ApiProperty({ minimum: 1 }) revision!: number;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' }) selectionHash!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

export class AdminActivityTimePolicySelectionItemDto {
  @ApiProperty({ type: () => AdminActivityTimePolicySelectionScopeDto })
  scope!: AdminActivityTimePolicySelectionScopeDto;
  @ApiProperty({ type: () => AdminActivityTimePolicySelectionValueDto })
  selection!: AdminActivityTimePolicySelectionValueDto;
}

export class AdminActivityTimePolicySelectionResponseDto {
  @ApiProperty() activityId!: string;
  @ApiProperty({ type: String, nullable: true }) selectionRevisionId!: string | null;
  @ApiProperty({ minimum: 0 }) revision!: number;
  @ApiProperty({ type: String, nullable: true }) selectionHash!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) createdAt!: string | null;
  @ApiProperty({ type: () => [AdminActivityTimePolicySelectionItemDto] })
  items!: AdminActivityTimePolicySelectionItemDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty({ type: Object }) resolutionSummary!: Record<string, number>;
}
