import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';
import { AdminActivityMetricCommandResponseDto } from './activity-metric-command.dto';
export class AdminMetricChoiceOptionDto {
  @ApiProperty({ maxLength: 64 })
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z][a-z0-9_]*$/)
  code!: string;
  @ApiProperty({ minLength: 1, maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  label!: string;
}
export class AdminMetricIntegerConfigurationDto {
  @ApiProperty({ enum: ['non_negative_integer'] })
  @Equals('non_negative_integer')
  kindCode!: 'non_negative_integer';
  @ApiProperty({ minLength: 1, maxLength: 32 })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  unit!: string;
  @ApiProperty({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  minimum!: number;
  @ApiProperty({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  maximum!: number;
}
export class AdminMetricDecimalConfigurationDto {
  @ApiProperty({ enum: ['non_negative_decimal'] })
  @Equals('non_negative_decimal')
  kindCode!: 'non_negative_decimal';
  @ApiProperty({ minLength: 1, maxLength: 32 })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  unit!: string;
  @ApiProperty({ minimum: 0, maximum: 6 })
  @IsInt()
  @Min(0)
  @Max(6)
  scale!: number;
  @ApiProperty({ description: '与 scale 一致的非负规范十进制字符串' })
  @IsString()
  @MaxLength(64)
  minimum!: string;
  @ApiProperty({ description: '与 scale 一致的非负规范十进制字符串' })
  @IsString()
  @MaxLength(64)
  maximum!: string;
}
export class AdminMetricBooleanConfigurationDto {
  @ApiProperty({ enum: ['boolean'] })
  @Equals('boolean')
  kindCode!: 'boolean';
  @ApiProperty({ type: String, nullable: true, enum: [null] })
  @Equals(null)
  unit!: null;
}
export class AdminMetricTextConfigurationDto {
  @ApiProperty({ enum: ['short_text'] })
  @Equals('short_text')
  kindCode!: 'short_text';
  @ApiProperty({ type: String, nullable: true, enum: [null] })
  @Equals(null)
  unit!: null;
  @ApiProperty({ minimum: 1, maximum: 500 })
  @IsInt()
  @Min(1)
  @Max(500)
  maxLength!: number;
}
export class AdminMetricChoiceConfigurationDto {
  @ApiProperty({ enum: ['single_choice'] })
  @Equals('single_choice')
  kindCode!: 'single_choice';
  @ApiProperty({ type: String, nullable: true, enum: [null] })
  @Equals(null)
  unit!: null;
  @ApiProperty({ type: [AdminMetricChoiceOptionDto], minItems: 1, maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AdminMetricChoiceOptionDto)
  options!: AdminMetricChoiceOptionDto[];
}

@ApiExtraModels(
  AdminMetricIntegerConfigurationDto,
  AdminMetricDecimalConfigurationDto,
  AdminMetricBooleanConfigurationDto,
  AdminMetricTextConfigurationDto,
  AdminMetricChoiceConfigurationDto,
)
export class AdminMetricDefinitionV1Dto {
  @ApiProperty({ enum: [1] })
  @Equals(1)
  schemaVersion!: 1;
  @ApiProperty({ maxLength: 64, pattern: '^[a-z][a-z0-9_]*$' })
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z][a-z0-9_]*$/)
  code!: string;
  @ApiProperty({ minimum: 1, maximum: 2147483647 })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  version!: number;
  @ApiProperty({ minLength: 1, maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;
  @ApiProperty({
    oneOf: [
      { $ref: getSchemaPath(AdminMetricIntegerConfigurationDto) },
      { $ref: getSchemaPath(AdminMetricDecimalConfigurationDto) },
      { $ref: getSchemaPath(AdminMetricBooleanConfigurationDto) },
      { $ref: getSchemaPath(AdminMetricTextConfigurationDto) },
      { $ref: getSchemaPath(AdminMetricChoiceConfigurationDto) },
    ],
    discriminator: { propertyName: 'kindCode' },
  })
  @ValidateNested()
  @Type(() => Object, {
    discriminator: {
      property: 'kindCode',
      subTypes: [
        { name: 'non_negative_integer', value: AdminMetricIntegerConfigurationDto },
        { name: 'non_negative_decimal', value: AdminMetricDecimalConfigurationDto },
        { name: 'boolean', value: AdminMetricBooleanConfigurationDto },
        { name: 'short_text', value: AdminMetricTextConfigurationDto },
        { name: 'single_choice', value: AdminMetricChoiceConfigurationDto },
      ],
    },
    keepDiscriminatorProperty: true,
  })
  configuration!:
    | AdminMetricIntegerConfigurationDto
    | AdminMetricDecimalConfigurationDto
    | AdminMetricBooleanConfigurationDto
    | AdminMetricTextConfigurationDto
    | AdminMetricChoiceConfigurationDto;
}
export class AdminCreateActivityMetricDefinitionDto {
  @ApiProperty({ minLength: 1, maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/^\S(?:[\s\S]*\S)?$/)
  operationKey!: string;

  @ApiProperty({ type: AdminMetricDefinitionV1Dto })
  @ValidateNested()
  @Type(() => AdminMetricDefinitionV1Dto)
  definition!: AdminMetricDefinitionV1Dto;
}
export class AdminUpdateActivityMetricDefinitionDto extends AdminCreateActivityMetricDefinitionDto {
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  expectedDefinitionHash!: string;
}
export class AdminListActivityMetricDefinitionsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ maxLength: 64 })
  @OmittableOnly()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z][a-z0-9_]*$/)
  code?: string;
  @ApiPropertyOptional({ enum: ['draft', 'active', 'retired'] })
  @OmittableOnly()
  @IsIn(['draft', 'active', 'retired'])
  statusCode?: 'draft' | 'active' | 'retired';

  @ApiPropertyOptional({
    enum: [
      'non_negative_integer',
      'non_negative_decimal',
      'boolean',
      'short_text',
      'single_choice',
    ],
  })
  @OmittableOnly()
  @IsIn(['non_negative_integer', 'non_negative_decimal', 'boolean', 'short_text', 'single_choice'])
  kindCode?: string;
}
export class AdminActivityMetricDefinitionResponseDto extends AdminActivityMetricCommandResponseDto {
  @ApiProperty({ type: AdminMetricDefinitionV1Dto }) definition!: AdminMetricDefinitionV1Dto;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) activatedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) retiredAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: Date;
}
