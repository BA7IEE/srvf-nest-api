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

export class AppActivityContributionPolicyPointerDto {
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
  @ApiProperty({ minimum: 1, maximum: 2147483647 })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  evaluatorVersion!: number;
}

export class AppActivityContributionPolicySelectionScopeDto {
  @ApiProperty({ enum: ['activity', 'position'] })
  @IsIn(['activity', 'position'])
  layerCode!: 'activity' | 'position';
  @ApiProperty({ type: String, nullable: true, minLength: 1, maxLength: 64 })
  @ValidateIf((_, value: unknown) => value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sessionId!: string | null;
  @ApiProperty({ type: String, nullable: true, minLength: 1, maxLength: 64 })
  @ValidateIf((_, value: unknown) => value !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  positionId!: string | null;
}

export class AppActivityContributionPolicySelectionValueDto {
  @ApiProperty({ enum: ['inherit', 'explicit'] })
  @IsIn(['inherit', 'explicit'])
  mode!: 'inherit' | 'explicit';
  @ApiProperty({ type: () => AppActivityContributionPolicyPointerDto, nullable: true })
  @ValidateIf((_, value: unknown) => value !== null)
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AppActivityContributionPolicyPointerDto)
  pointer!: AppActivityContributionPolicyPointerDto | null;
}

export class AppActivityContributionPolicySelectionChangeDto {
  @ApiProperty({ type: () => AppActivityContributionPolicySelectionScopeDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AppActivityContributionPolicySelectionScopeDto)
  scope!: AppActivityContributionPolicySelectionScopeDto;
  @ApiProperty({ type: () => AppActivityContributionPolicySelectionValueDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AppActivityContributionPolicySelectionValueDto)
  selection!: AppActivityContributionPolicySelectionValueDto;
}

export class AppPatchActivityContributionPolicySelectionDto {
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
    type: () => [AppActivityContributionPolicySelectionChangeDto],
    minItems: 1,
    maxItems: 10001,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10001)
  @ValidateNested({ each: true })
  @Type(() => AppActivityContributionPolicySelectionChangeDto)
  changes!: AppActivityContributionPolicySelectionChangeDto[];
}

export class AppActivityContributionPolicySelectionQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 2147483647 })
  @OmittableOnly()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  revision?: number;
}

export class AppActivityContributionPolicyOptionsQueryDto extends PaginationQueryDto {
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

export class AppActivityContributionPolicySelectionResultDto {
  @ApiProperty() activityId!: string;
  @ApiProperty() selectionRevisionId!: string;
  @ApiProperty({ minimum: 1 }) revision!: number;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' }) selectionHash!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

export class AppActivityContributionPolicySelectionItemDto {
  @ApiProperty({ type: () => AppActivityContributionPolicySelectionScopeDto })
  scope!: AppActivityContributionPolicySelectionScopeDto;
  @ApiProperty({ type: () => AppActivityContributionPolicySelectionValueDto })
  selection!: AppActivityContributionPolicySelectionValueDto;
}

export class AppActivityContributionPolicySelectionResponseDto {
  @ApiProperty() activityId!: string;
  @ApiProperty({ type: String, nullable: true }) selectionRevisionId!: string | null;
  @ApiProperty({ minimum: 0 }) revision!: number;
  @ApiProperty({ type: String, nullable: true }) selectionHash!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) createdAt!: string | null;
  @ApiProperty({ type: () => [AppActivityContributionPolicySelectionItemDto] })
  items!: AppActivityContributionPolicySelectionItemDto[];
  @ApiProperty({ type: [Object] }) resolved!: object[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty({ type: Object }) resolutionSummary!: Record<string, number>;
}

export class AppActivityContributionPolicyOptionDto {
  @ApiProperty() policyId!: string;
  @ApiProperty() versionId!: string;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' }) definitionHash!: string;
  @ApiProperty({ minimum: 1 }) evaluatorVersion!: number;
  @ApiProperty() policyCode!: string;
  @ApiProperty() policyName!: string;
  @ApiProperty({ type: String, format: 'date-time' }) effectiveFrom!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) effectiveUntil!:
    | string
    | null;
}
