import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
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

export class AdminMetricSetItemDto {
  @ApiProperty({ maxLength: 64 })
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z][a-z0-9_]*$/)
  key!: string;

  @ApiProperty({ minimum: 0, maximum: 99 })
  @IsInt()
  @Min(0)
  @Max(99)
  sortOrder!: number;

  @ApiProperty({})
  @IsBoolean()
  required!: boolean;

  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  metricDefinitionId!: string;

  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  definitionHash!: string;
}
export class AdminMetricSetDefinitionV1Dto {
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

  @ApiProperty({ type: [AdminMetricSetItemDto], maxItems: 100 })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AdminMetricSetItemDto)
  items!: AdminMetricSetItemDto[];
}
export class AdminCreateActivityMetricSetDto {
  @ApiProperty({ minLength: 1, maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/^\S(?:[\s\S]*\S)?$/)
  operationKey!: string;

  @ApiProperty({ type: AdminMetricSetDefinitionV1Dto })
  @ValidateNested()
  @Type(() => AdminMetricSetDefinitionV1Dto)
  definition!: AdminMetricSetDefinitionV1Dto;
}
export class AdminUpdateActivityMetricSetDto extends AdminCreateActivityMetricSetDto {
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  expectedDefinitionHash!: string;
}
export class AdminListActivityMetricSetsQueryDto extends PaginationQueryDto {
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
}
export class AdminActivityMetricSetResponseDto extends AdminActivityMetricCommandResponseDto {
  @ApiProperty({ type: AdminMetricSetDefinitionV1Dto }) definition!: AdminMetricSetDefinitionV1Dto;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) activatedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) retiredAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: Date;
}
