import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
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

export class AppActivityTimePolicyPointerDto {
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

export class AppActivityTimePolicySelectionScopeDto {
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

export class AppActivityTimePolicySelectionValueDto {
  @ApiProperty({ enum: ['inherit', 'explicit'] })
  @IsIn(['inherit', 'explicit'])
  mode!: 'inherit' | 'explicit';
  @ApiProperty({ type: () => AppActivityTimePolicyPointerDto, nullable: true })
  @ValidateIf((_, value: unknown) => value !== null)
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AppActivityTimePolicyPointerDto)
  pointer!: AppActivityTimePolicyPointerDto | null;
}

export class AppActivityTimePolicySelectionChangeDto {
  @ApiProperty({ type: () => AppActivityTimePolicySelectionScopeDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AppActivityTimePolicySelectionScopeDto)
  scope!: AppActivityTimePolicySelectionScopeDto;
  @ApiProperty({ type: () => AppActivityTimePolicySelectionValueDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AppActivityTimePolicySelectionValueDto)
  selection!: AppActivityTimePolicySelectionValueDto;
}

export class AppPatchActivityTimePolicySelectionDto {
  @ApiProperty({ minLength: 8, maxLength: 128 })
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
    type: () => [AppActivityTimePolicySelectionChangeDto],
    minItems: 1,
    maxItems: 100,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AppActivityTimePolicySelectionChangeDto)
  changes!: AppActivityTimePolicySelectionChangeDto[];
}

export class AppActivityTimePolicySelectionQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 2147483647 })
  @OmittableOnly()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  revision?: number;
}

export class AppActivityTimePolicyOptionsQueryDto extends PaginationQueryDto {
  @ApiProperty({ minLength: 8, maxLength: 64 })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  organizationId!: string;
  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  plannedFrom!: string;
  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  plannedUntil!: string;
}

export class AppActivityTimePolicySelectionResultDto {
  @ApiProperty() activityId!: string;
  @ApiProperty() selectionRevisionId!: string;
  @ApiProperty({ minimum: 1 }) revision!: number;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' }) selectionHash!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

export class AppActivityTimePolicySelectionItemDto {
  @ApiProperty({ type: () => AppActivityTimePolicySelectionScopeDto })
  scope!: AppActivityTimePolicySelectionScopeDto;
  @ApiProperty({ type: () => AppActivityTimePolicySelectionValueDto })
  selection!: AppActivityTimePolicySelectionValueDto;
}

export class AppActivityTimePolicySelectionResponseDto {
  @ApiProperty() activityId!: string;
  @ApiProperty({ type: String, nullable: true }) selectionRevisionId!: string | null;
  @ApiProperty({ minimum: 0 }) revision!: number;
  @ApiProperty({ type: String, nullable: true }) selectionHash!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) createdAt!: string | null;
  @ApiProperty({ type: () => [AppActivityTimePolicySelectionItemDto] })
  items!: AppActivityTimePolicySelectionItemDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty({ type: Object }) resolutionSummary!: Record<string, number>;
}

export class AppActivityTimePolicyOptionDto {
  @ApiProperty() policyId!: string;
  @ApiProperty() versionId!: string;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' }) definitionHash!: string;
  @ApiProperty() policyCode!: string;
  @ApiProperty() policyName!: string;
  @ApiProperty({ type: String, format: 'date-time' }) effectiveFrom!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) effectiveUntil!:
    | string
    | null;
}
