import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  ArrayMinSize,
  IsBoolean,
  IsDefined,
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
  REGISTRATION_FORM_FIELD_TYPES,
  REGISTRATION_FORM_FIELD_VISIBILITIES,
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

export class RegistrationFormDefinitionInputDto {
  @ApiProperty({ type: () => [RegistrationFormFieldInputDto], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RegistrationFormFieldInputDto)
  fields!: RegistrationFormFieldInputDto[];
}

/** Explicit null is a command to remove the custom Form; omission is rejected. */
export class PutAppManagedRegistrationFormDto {
  @ApiProperty({ nullable: true, type: () => RegistrationFormDefinitionInputDto })
  @IsDefined()
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsObject()
  @ValidateNested()
  @Type(() => RegistrationFormDefinitionInputDto)
  form!: RegistrationFormDefinitionInputDto | null;
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
