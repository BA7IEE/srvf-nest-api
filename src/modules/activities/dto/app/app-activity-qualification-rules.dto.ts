import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';

export const APP_ACTIVITY_QUALIFICATION_RULE_TYPES = [
  'grade',
  'gender',
  'organization',
  'certificate',
  'training',
  'age',
  'insurance',
] as const;

export const APP_ACTIVITY_QUALIFICATION_ENFORCEMENTS = ['block', 'warn'] as const;

export const APP_ACTIVITY_QUALIFICATION_OPERATORS = [
  'in',
  'in_subtree',
  'has_any',
  'between',
  'covers_activity',
] as const;

export class AppActivityQualificationRuleScopeDto {
  @ApiProperty({ nullable: true, minLength: 8, maxLength: 64, type: String })
  @ValidateIf((_object, value: unknown) => value !== null && value !== undefined)
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  sessionId!: string | null;

  @ApiProperty({ nullable: true, minLength: 8, maxLength: 64, type: String })
  @ValidateIf((_object, value: unknown) => value !== null && value !== undefined)
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  positionId!: string | null;
}

/** #22 typed public wire: the storage-only valueJson field is deliberately absent. */
export class AppActivityQualificationRuleInputDto {
  @ApiProperty({ enum: APP_ACTIVITY_QUALIFICATION_RULE_TYPES })
  @IsIn(APP_ACTIVITY_QUALIFICATION_RULE_TYPES)
  ruleTypeCode!: (typeof APP_ACTIVITY_QUALIFICATION_RULE_TYPES)[number];

  @ApiProperty({ enum: APP_ACTIVITY_QUALIFICATION_ENFORCEMENTS })
  @IsIn(APP_ACTIVITY_QUALIFICATION_ENFORCEMENTS)
  enforcementCode!: (typeof APP_ACTIVITY_QUALIFICATION_ENFORCEMENTS)[number];

  @ApiProperty({ enum: APP_ACTIVITY_QUALIFICATION_OPERATORS })
  @IsIn(APP_ACTIVITY_QUALIFICATION_OPERATORS)
  operator!: (typeof APP_ACTIVITY_QUALIFICATION_OPERATORS)[number];

  @ApiPropertyOptional({ type: () => [String], minItems: 1, maxItems: 100 })
  @OmittableOnly()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(100, { each: true })
  codes?: string[];

  @ApiPropertyOptional({ type: () => [String], minItems: 1, maxItems: 100 })
  @OmittableOnly()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @MinLength(8, { each: true })
  @MaxLength(64, { each: true })
  organizationIds?: string[];

  @ApiPropertyOptional({ type: () => [String], minItems: 1, maxItems: 100 })
  @OmittableOnly()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @MinLength(8, { each: true })
  @MaxLength(64, { each: true })
  standardIds?: string[];

  @ApiPropertyOptional({ nullable: true, minimum: 0, type: Number })
  @IsOptional()
  @ValidateIf((_object, value: unknown) => value !== null && value !== undefined)
  @IsInt()
  @Min(0)
  minYears?: number | null;

  @ApiPropertyOptional({ nullable: true, minimum: 0, type: Number })
  @IsOptional()
  @ValidateIf((_object, value: unknown) => value !== null && value !== undefined)
  @IsInt()
  @Min(0)
  maxYears?: number | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 100, type: Number })
  @OmittableOnly()
  @IsInt()
  @Min(0)
  @Max(100)
  warnScore?: number;

  @ApiPropertyOptional({ nullable: true, minLength: 1, maxLength: 500, type: String })
  @IsOptional()
  @ValidateIf((_object, value: unknown) => value !== null && value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  message?: string | null;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  sortOrder!: number;
}

export class AppActivityQualificationRuleSetInputDto {
  @ApiProperty({ type: () => AppActivityQualificationRuleScopeDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AppActivityQualificationRuleScopeDto)
  scope!: AppActivityQualificationRuleScopeDto;

  @ApiProperty({ type: () => [AppActivityQualificationRuleInputDto], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AppActivityQualificationRuleInputDto)
  rules!: AppActivityQualificationRuleInputDto[];
}

/** Full replacement; an explicit empty array clears every draft scope. */
export class PutAppManagedActivityQualificationRulesDto {
  @ApiProperty({ type: () => [AppActivityQualificationRuleSetInputDto] })
  @IsDefined()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AppActivityQualificationRuleSetInputDto)
  ruleSets!: AppActivityQualificationRuleSetInputDto[];
}

export class AppActivityQualificationRuleDto {
  @ApiProperty({ enum: APP_ACTIVITY_QUALIFICATION_RULE_TYPES })
  ruleTypeCode!: string;

  @ApiProperty({ enum: APP_ACTIVITY_QUALIFICATION_ENFORCEMENTS })
  enforcementCode!: string;

  @ApiProperty({ enum: APP_ACTIVITY_QUALIFICATION_OPERATORS })
  operator!: string;

  @ApiPropertyOptional({ type: () => [String] })
  codes?: string[];

  @ApiPropertyOptional({ type: () => [String] })
  organizationIds?: string[];

  @ApiPropertyOptional({ type: () => [String] })
  standardIds?: string[];

  @ApiPropertyOptional({ nullable: true, type: Number })
  minYears?: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  maxYears?: number | null;

  @ApiProperty({ nullable: true, type: Number })
  warnScore!: number | null;

  @ApiProperty({ nullable: true, type: String })
  message!: string | null;

  @ApiProperty()
  sortOrder!: number;
}

export class AppActivityQualificationRuleSetDto {
  @ApiProperty({ type: () => AppActivityQualificationRuleScopeDto })
  scope!: AppActivityQualificationRuleScopeDto;

  @ApiProperty({ minimum: 1 })
  version!: number;

  @ApiProperty({ type: () => [AppActivityQualificationRuleDto] })
  rules!: AppActivityQualificationRuleDto[];
}

export class AppActivityQualificationRulesDto {
  @ApiProperty({ type: () => [AppActivityQualificationRuleSetDto] })
  ruleSets!: AppActivityQualificationRuleSetDto[];
}
