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

export class AdminActivityContributionPolicyPointerDto {
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

export class AdminActivityContributionPolicySelectionScopeDto {
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

export class AdminActivityContributionPolicySelectionValueDto {
  @ApiProperty({ enum: ['inherit', 'explicit'] })
  @IsIn(['inherit', 'explicit'])
  mode!: 'inherit' | 'explicit';

  @ApiProperty({ type: () => AdminActivityContributionPolicyPointerDto, nullable: true })
  @ValidateIf((_, value: unknown) => value !== null)
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminActivityContributionPolicyPointerDto)
  pointer!: AdminActivityContributionPolicyPointerDto | null;
}

export class AdminActivityContributionPolicySelectionChangeDto {
  @ApiProperty({ type: () => AdminActivityContributionPolicySelectionScopeDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminActivityContributionPolicySelectionScopeDto)
  scope!: AdminActivityContributionPolicySelectionScopeDto;

  @ApiProperty({ type: () => AdminActivityContributionPolicySelectionValueDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminActivityContributionPolicySelectionValueDto)
  selection!: AdminActivityContributionPolicySelectionValueDto;
}

export class AdminPatchActivityContributionPolicySelectionDto {
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
    type: () => [AdminActivityContributionPolicySelectionChangeDto],
    minItems: 1,
    maxItems: 10001,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10001)
  @ValidateNested({ each: true })
  @Type(() => AdminActivityContributionPolicySelectionChangeDto)
  changes!: AdminActivityContributionPolicySelectionChangeDto[];
}

export class AdminActivityContributionPolicySelectionQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 2147483647 })
  @OmittableOnly()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  revision?: number;
}

export class AdminActivityContributionPolicySelectionResultDto {
  @ApiProperty() activityId!: string;
  @ApiProperty() selectionRevisionId!: string;
  @ApiProperty({ minimum: 1 }) revision!: number;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' }) selectionHash!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

export class AdminActivityContributionPolicySelectionItemDto {
  @ApiProperty({ type: () => AdminActivityContributionPolicySelectionScopeDto })
  scope!: AdminActivityContributionPolicySelectionScopeDto;
  @ApiProperty({ type: () => AdminActivityContributionPolicySelectionValueDto })
  selection!: AdminActivityContributionPolicySelectionValueDto;
}

export class AdminActivityContributionPolicySelectionResponseDto {
  @ApiProperty() activityId!: string;
  @ApiProperty({ type: String, nullable: true }) selectionRevisionId!: string | null;
  @ApiProperty({ minimum: 0 }) revision!: number;
  @ApiProperty({ type: String, nullable: true }) selectionHash!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) createdAt!: string | null;
  @ApiProperty({ type: () => [AdminActivityContributionPolicySelectionItemDto] })
  items!: AdminActivityContributionPolicySelectionItemDto[];
  @ApiProperty({ type: [Object] }) resolved!: object[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty({ type: Object }) resolutionSummary!: Record<string, number>;
}
