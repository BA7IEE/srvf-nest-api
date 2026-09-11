import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsDefined,
  IsObject,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AdminActivityTimePolicySelectionValueDto } from './activity-time-policy-selection.dto';
import { AdminActivityTemplateDefinitionV3Dto } from './activity-template-definition-v3.dto';

export class AdminTemplateTimePolicySessionOverrideDto {
  @ApiProperty({ pattern: '^[a-z][a-z0-9_]*$', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sessionCode!: string;

  @ApiProperty({ type: () => AdminActivityTimePolicySelectionValueDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminActivityTimePolicySelectionValueDto)
  selection!: AdminActivityTimePolicySelectionValueDto;
}

export class AdminTemplateTimePolicyPositionOverrideDto extends AdminTemplateTimePolicySessionOverrideDto {
  @ApiProperty({ pattern: '^[a-z][a-z0-9_]*$', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  positionCode!: string;
}

export class AdminTemplateTimePolicySelectionDto {
  @ApiProperty({ type: () => AdminActivityTimePolicySelectionValueDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminActivityTimePolicySelectionValueDto)
  default!: AdminActivityTimePolicySelectionValueDto;

  @ApiProperty({ type: () => [AdminTemplateTimePolicySessionOverrideDto] })
  @IsArray()
  @ArrayUnique((value: AdminTemplateTimePolicySessionOverrideDto) => value.sessionCode)
  @ValidateNested({ each: true })
  @Type(() => AdminTemplateTimePolicySessionOverrideDto)
  sessionOverrides!: AdminTemplateTimePolicySessionOverrideDto[];

  @ApiProperty({ type: () => [AdminTemplateTimePolicyPositionOverrideDto] })
  @IsArray()
  @ArrayUnique(
    (value: AdminTemplateTimePolicyPositionOverrideDto) =>
      `${value.sessionCode}\u0000${value.positionCode}`,
  )
  @ValidateNested({ each: true })
  @Type(() => AdminTemplateTimePolicyPositionOverrideDto)
  positionOverrides!: AdminTemplateTimePolicyPositionOverrideDto[];
}

/** V4 adds only the code-addressed immutable time-policy selection branch to the V3 grammar. */
export class AdminActivityTemplateDefinitionV4Dto extends AdminActivityTemplateDefinitionV3Dto {
  @ApiProperty({ type: () => AdminTemplateTimePolicySelectionDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminTemplateTimePolicySelectionDto)
  timePolicySelection!: AdminTemplateTimePolicySelectionDto;
}
