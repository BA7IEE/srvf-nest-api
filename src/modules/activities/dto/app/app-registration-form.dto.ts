import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  ArrayMinSize,
  IsBoolean,
  IsDefined,
  Equals,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import {
  REGISTRATION_FORM_DATA_CLASS_CODES,
  REGISTRATION_FORM_FIELD_TYPES,
  REGISTRATION_FORM_FIELD_VISIBILITIES,
  REGISTRATION_FORM_GOVERNANCE_PURPOSE_CODES,
  REGISTRATION_FORM_MASKING_POLICY_CODES,
  REGISTRATION_FORM_RETENTION_POLICY_CODES,
} from '../../registration-form-definition';

export class RegistrationFormChoiceInputDto {
  @ApiProperty({ minLength: 1, maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  value!: string;

  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label!: string;
}

/** Wire input deliberately requires the structural field properties; constraints remain typed. */
export class RegistrationFormFieldInputDto {
  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  fieldCode!: string;

  @ApiProperty({ enum: REGISTRATION_FORM_FIELD_TYPES })
  @IsIn(REGISTRATION_FORM_FIELD_TYPES)
  typeCode!: (typeof REGISTRATION_FORM_FIELD_TYPES)[number];

  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label!: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 500, type: String })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  helpText?: string | null;

  @ApiProperty()
  @IsBoolean()
  required!: boolean;

  @ApiProperty({ enum: REGISTRATION_FORM_FIELD_VISIBILITIES })
  @IsIn(REGISTRATION_FORM_FIELD_VISIBILITIES)
  visibilityCode!: (typeof REGISTRATION_FORM_FIELD_VISIBILITIES)[number];

  @ApiProperty()
  @IsBoolean()
  exportable!: boolean;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  sortOrder!: number;

  @ApiPropertyOptional({ nullable: true, type: Number })
  @IsOptional()
  @IsNumber()
  minValue?: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  @IsOptional()
  @IsNumber()
  maxValue?: number | null;

  @ApiPropertyOptional({ nullable: true, minimum: 0, type: Number })
  @IsOptional()
  @IsInt()
  @Min(0)
  minLength?: number | null;

  @ApiPropertyOptional({ nullable: true, minimum: 0, type: Number })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxLength?: number | null;

  @ApiPropertyOptional({ nullable: true, minimum: 1, type: Number })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxSelections?: number | null;

  @ApiPropertyOptional({ nullable: true, type: () => [RegistrationFormChoiceInputDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RegistrationFormChoiceInputDto)
  options?: RegistrationFormChoiceInputDto[] | null;
}

/**
 * 仅 managed / publish-review 受控面可见的 definition governance。prefill 在 B3 固定
 * 为 null；敏感题目虽保留 grammar，但实际 writer 会在 service 层 fail-closed，直到 B3-S。
 */
export class ManagedRegistrationFormFieldGovernanceInputDto {
  @ApiProperty({ enum: REGISTRATION_FORM_GOVERNANCE_PURPOSE_CODES })
  @IsIn(REGISTRATION_FORM_GOVERNANCE_PURPOSE_CODES)
  purposeCode!: (typeof REGISTRATION_FORM_GOVERNANCE_PURPOSE_CODES)[number];

  @ApiProperty({ enum: REGISTRATION_FORM_DATA_CLASS_CODES })
  @IsIn(REGISTRATION_FORM_DATA_CLASS_CODES)
  dataClassCode!: (typeof REGISTRATION_FORM_DATA_CLASS_CODES)[number];

  @ApiProperty({ enum: REGISTRATION_FORM_RETENTION_POLICY_CODES })
  @IsIn(REGISTRATION_FORM_RETENTION_POLICY_CODES)
  retentionPolicyCode!: (typeof REGISTRATION_FORM_RETENTION_POLICY_CODES)[number];

  @ApiProperty({ enum: REGISTRATION_FORM_MASKING_POLICY_CODES })
  @IsIn(REGISTRATION_FORM_MASKING_POLICY_CODES)
  maskingPolicyCode!: (typeof REGISTRATION_FORM_MASKING_POLICY_CODES)[number];

  @ApiProperty({ nullable: true, type: String, description: 'B3 固定为 NULL，禁止档案预填' })
  @Equals(null)
  prefillSourceCode!: null;
}

/**
 * Managed writer accepts exactly one definition-level shape: every Field has no governance, or
 * every Field carries the full object. The canonicalizer, rather than class-validator alone,
 * performs the cross-field all-or-none decision.
 */
export class ManagedRegistrationFormFieldInputDto extends RegistrationFormFieldInputDto {
  @ApiPropertyOptional({
    nullable: true,
    type: () => ManagedRegistrationFormFieldGovernanceInputDto,
    description: '完整治理对象；NULL 或省略仅可用于全表 legacy definition',
  })
  @IsOptional()
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsObject()
  @ValidateNested()
  @Type(() => ManagedRegistrationFormFieldGovernanceInputDto)
  governance?: ManagedRegistrationFormFieldGovernanceInputDto | null;
}

export class RegistrationFormDefinitionInputDto {
  @ApiProperty({ type: () => [RegistrationFormFieldInputDto], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RegistrationFormFieldInputDto)
  fields!: RegistrationFormFieldInputDto[];
}

export class ManagedRegistrationFormDefinitionInputDto {
  @ApiProperty({ type: () => [ManagedRegistrationFormFieldInputDto], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ManagedRegistrationFormFieldInputDto)
  fields!: ManagedRegistrationFormFieldInputDto[];
}

/** Explicit null is a command to remove the custom Form; omission is rejected. */
export class PutAppManagedRegistrationFormDto {
  @ApiProperty({ nullable: true, type: () => ManagedRegistrationFormDefinitionInputDto })
  @IsDefined()
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsObject()
  @ValidateNested()
  @Type(() => ManagedRegistrationFormDefinitionInputDto)
  form!: ManagedRegistrationFormDefinitionInputDto | null;
}

export class AppRegistrationFormChoiceDto {
  @ApiProperty()
  value!: string;

  @ApiProperty()
  label!: string;
}

/** Safe read DTO: no field/version row id, hash, workflow revision or timestamps. */
export class AppRegistrationFormFieldDto {
  @ApiProperty()
  fieldCode!: string;

  @ApiProperty({ enum: REGISTRATION_FORM_FIELD_TYPES })
  typeCode!: string;

  @ApiProperty()
  label!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  helpText!: string | null;

  @ApiProperty()
  required!: boolean;

  @ApiProperty({ enum: REGISTRATION_FORM_FIELD_VISIBILITIES })
  visibilityCode!: string;

  @ApiProperty()
  exportable!: boolean;

  @ApiProperty()
  sortOrder!: number;

  @ApiPropertyOptional({ nullable: true, type: String })
  minValue!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  maxValue!: string | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  minLength!: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  maxLength!: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  maxSelections!: number | null;

  @ApiPropertyOptional({ nullable: true, type: () => [AppRegistrationFormChoiceDto] })
  options!: AppRegistrationFormChoiceDto[] | null;
}

export class AppRegistrationFormDto {
  @ApiProperty({ minimum: 1 })
  version!: number;

  @ApiProperty({ type: () => [AppRegistrationFormFieldDto] })
  fields!: AppRegistrationFormFieldDto[];
}

export class AppManagedRegistrationFormFieldGovernanceDto {
  @ApiProperty({ enum: REGISTRATION_FORM_GOVERNANCE_PURPOSE_CODES })
  purposeCode!: string;

  @ApiProperty({ enum: REGISTRATION_FORM_DATA_CLASS_CODES })
  dataClassCode!: string;

  @ApiProperty({ enum: REGISTRATION_FORM_RETENTION_POLICY_CODES })
  retentionPolicyCode!: string;

  @ApiProperty({ enum: REGISTRATION_FORM_MASKING_POLICY_CODES })
  maskingPolicyCode!: string;

  @ApiProperty({ nullable: true, type: String, description: 'B3 固定为 NULL' })
  prefillSourceCode!: null;
}

/** Owner-only managed read model; public AppRegistrationFormDto deliberately excludes governance. */
export class AppManagedRegistrationFormFieldDto extends AppRegistrationFormFieldDto {
  @ApiPropertyOptional({
    type: () => AppManagedRegistrationFormFieldGovernanceDto,
  })
  governance?: AppManagedRegistrationFormFieldGovernanceDto;
}

export class AppManagedRegistrationFormDto {
  @ApiProperty({ minimum: 1 })
  version!: number;

  @ApiProperty({ type: () => [AppManagedRegistrationFormFieldDto] })
  fields!: AppManagedRegistrationFormFieldDto[];
}
