import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsDefined,
  IsIn,
  IsObject,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  AdminActivityContributionPolicyPointerDto,
  AdminActivityContributionPolicySelectionValueDto,
} from './activity-contribution-policy-selection.dto';
import { AdminActivityTemplateDefinitionV4Dto } from './activity-template-definition-v4.dto';

export class AdminTemplateContributionPolicyExplicitSelectionDto {
  @ApiProperty({ enum: ['explicit'] })
  @IsIn(['explicit'])
  mode!: 'explicit';

  @ApiProperty({ type: () => AdminActivityContributionPolicyPointerDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminActivityContributionPolicyPointerDto)
  pointer!: AdminActivityContributionPolicyPointerDto;
}

export class AdminTemplateContributionPolicyPositionOverrideDto {
  @ApiProperty({ pattern: '^[a-z][a-z0-9_]*$', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[a-z][a-z0-9_]*$/)
  sessionCode!: string;

  @ApiProperty({ pattern: '^[a-z][a-z0-9_]*$', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[a-z][a-z0-9_]*$/)
  positionCode!: string;

  @ApiProperty({ type: () => AdminTemplateContributionPolicyExplicitSelectionDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminTemplateContributionPolicyExplicitSelectionDto)
  selection!: AdminTemplateContributionPolicyExplicitSelectionDto;
}

export class AdminTemplateContributionPolicySelectionDto {
  @ApiProperty({ type: () => AdminActivityContributionPolicySelectionValueDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminActivityContributionPolicySelectionValueDto)
  activityDefault!: AdminActivityContributionPolicySelectionValueDto;

  @ApiProperty({ type: () => [AdminTemplateContributionPolicyPositionOverrideDto] })
  @IsArray()
  @ArrayMaxSize(10_000)
  @ArrayUnique(
    (value: AdminTemplateContributionPolicyPositionOverrideDto) =>
      `${value.sessionCode}\u0000${value.positionCode}`,
  )
  @ValidateNested({ each: true })
  @Type(() => AdminTemplateContributionPolicyPositionOverrideDto)
  positionOverrides!: AdminTemplateContributionPolicyPositionOverrideDto[];
}

/** V5 adds only the code-addressed immutable contribution-policy selection branch to V4. */
export class AdminActivityTemplateDefinitionV5Dto extends AdminActivityTemplateDefinitionV4Dto {
  @ApiProperty({ type: () => AdminTemplateContributionPolicySelectionDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminTemplateContributionPolicySelectionDto)
  contributionPolicySelection!: AdminTemplateContributionPolicySelectionDto;
}
