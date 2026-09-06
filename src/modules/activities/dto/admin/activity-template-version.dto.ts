import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
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
  IsDefined,
} from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';
import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';
import { AdminActivityMetricSelectionInputDto } from './activity-metric-selection.dto';
import {
  AdminActivityTemplateDefinitionV1Dto,
  AdminActivityTemplateDefinitionV2Dto,
  AdminActivityTemplateDefinitionV3Dto,
} from './activity-template-definition-v3.dto';

export class AdminCreateActivityTemplateVersionDto {
  @ApiProperty({ description: '客户端幂等键；首尾不得空白', minLength: 1, maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/^\S(?:[\s\S]*\S)?$/)
  operationKey!: string;
  @ApiPropertyOptional({
    description: '已有全局 Family ID；与新建 Family 的 code/name/categoryCode 互斥',
    minLength: 1,
    maxLength: 64,
  })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  familyId?: string;
  @ApiPropertyOptional({
    description: '新建 Family code，版本沿用；提供 familyId 时禁止',
    minLength: 1,
    maxLength: 64,
  })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code?: string;
  @ApiPropertyOptional({ description: '新建 Family 名称', minLength: 1, maxLength: 100 })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;
  @ApiPropertyOptional({ description: '新建 Family 的分类字典码', minLength: 1, maxLength: 64 })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  categoryCode?: string;
  @ApiProperty({ description: '活动类型字典码', minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  activityTypeCode!: string;
  @ApiProperty({ description: '显式新版本号，不自动递增', minimum: 1, maximum: 2147483647 })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  version!: number;
  @ApiProperty({ description: '有效期元数据起点，不作为本机时间 Gate', format: 'date-time' })
  @IsDateString()
  effectiveFrom!: string;
  @ApiPropertyOptional({
    description: '有效期元数据终点；非空时必须晚于起点',
    nullable: true,
    type: String,
    format: 'date-time',
  })
  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @IsDateString()
  effectiveTo?: string | null;
  @ApiPropertyOptional({
    description: '完整 V3 定义；与复制来源形状互斥',
    type: () => AdminActivityTemplateDefinitionV3Dto,
  })
  @OmittableOnly()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminActivityTemplateDefinitionV3Dto)
  definition?: AdminActivityTemplateDefinitionV3Dto;
  @ApiPropertyOptional({
    description: '复制来源的精确 V1/V2/V3 版本；仅全局可见 Family',
    minLength: 1,
    maxLength: 64,
  })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  copyFromVersionId?: string;
  @ApiPropertyOptional({ description: '复制来源的当前 hash', pattern: '^[0-9a-f]{64}$' })
  @OmittableOnly()
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  expectedSourceDefinitionHash?: string;
  @ApiPropertyOptional({
    description: '复制形状必须显式提供的新指标选择',
    type: () => AdminActivityMetricSelectionInputDto,
  })
  @OmittableOnly()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminActivityMetricSelectionInputDto)
  metricSelection?: AdminActivityMetricSelectionInputDto;
}
export class AdminActivityTemplateVersionCommandDto {
  @ApiProperty({ description: '客户端幂等键', minLength: 1, maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/^\S(?:[\s\S]*\S)?$/)
  operationKey!: string;
  @ApiProperty({ description: '读取到的目标当前 hash', pattern: '^[0-9a-f]{64}$' })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  expectedDefinitionHash!: string;
}
export class AdminUpdateActivityTemplateVersionDto extends AdminActivityTemplateVersionCommandDto {
  @ApiProperty({
    description: '整份替换的 V3 定义，仅 draft 可写',
    type: () => AdminActivityTemplateDefinitionV3Dto,
  })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminActivityTemplateDefinitionV3Dto)
  definition!: AdminActivityTemplateDefinitionV3Dto;
}
export class AdminListActivityTemplateVersionsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Family ID 过滤', minLength: 1, maxLength: 64 })
  @OmittableOnly()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  familyId?: string;
  @ApiPropertyOptional({ description: '版本状态过滤', enum: ['draft', 'active', 'retired'] })
  @OmittableOnly()
  @IsIn(['draft', 'active', 'retired'])
  statusCode?: 'draft' | 'active' | 'retired';
  @ApiPropertyOptional({ description: 'schema 版本过滤', enum: [1, 2, 3] })
  @OmittableOnly()
  @Type(() => Number)
  @IsIn([1, 2, 3])
  schemaVersion?: number;
}
export class AdminActivityTemplateVersionCommandResultDto {
  @ApiProperty({ description: '精确模板 Version ID' }) id!: string;
  @ApiProperty({ description: '稳定模板 code' }) code!: string;
  @ApiProperty({ description: '显式 Version', minimum: 1, maximum: 2147483647 }) version!: number;
  @ApiProperty({ description: '新命令仅写 V3', enum: [3] }) schemaVersion!: 3;
  @ApiProperty({ description: '命令记录的状态', enum: ['draft', 'active', 'retired'] })
  statusCode!: string;
  @ApiProperty({ description: '命令记录的定义 hash', pattern: '^[0-9a-f]{64}$' })
  definitionHash!: string;
}
export class AdminActivityTemplateFamilySummaryDto {
  @ApiProperty({ description: 'Family ID' }) id!: string;
  @ApiProperty({ description: 'Family 稳定 code' }) code!: string;
  @ApiProperty({ description: 'Family 名称' }) name!: string;
  @ApiProperty({ description: 'Family 分类字典码' }) categoryCode!: string;
}
export class AdminActivityTemplateVersionSummaryDto {
  @ApiProperty({ description: 'Version ID' }) id!: string;
  @ApiProperty({ description: 'Version code' }) code!: string;
  @ApiProperty({ description: '版本名称' }) name!: string;
  @ApiProperty({ description: '显式版本号' }) version!: number;
  @ApiProperty({ description: '解释版本', enum: [1, 2, 3] }) schemaVersion!: number;
  @ApiProperty({ description: '定义 hash', pattern: '^[0-9a-f]{64}$' }) definitionHash!: string;
  @ApiProperty({ description: '版本状态', enum: ['draft', 'active', 'retired'] })
  statusCode!: string;
  @ApiProperty({ description: '活动类型字典码' }) activityTypeCode!: string;
  @ApiProperty({
    description: '可见全局 Family 摘要',
    type: () => AdminActivityTemplateFamilySummaryDto,
  })
  family!: AdminActivityTemplateFamilySummaryDto;
  @ApiProperty({ description: '有效期元数据起点', type: String, format: 'date-time' })
  effectiveFrom!: Date;
  @ApiProperty({
    description: '有效期元数据终点',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  effectiveTo!: Date | null;
  @ApiProperty({ description: '创建时间', type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ description: '更新时间', type: String, format: 'date-time' }) updatedAt!: Date;
}
@ApiExtraModels(
  AdminActivityTemplateDefinitionV1Dto,
  AdminActivityTemplateDefinitionV2Dto,
  AdminActivityTemplateDefinitionV3Dto,
)
export class AdminActivityTemplateVersionResponseDto extends AdminActivityTemplateVersionSummaryDto {
  @ApiProperty({
    description: '按 schemaVersion 解释；V1/V2 仅只读',
    oneOf: [
      { $ref: getSchemaPath(AdminActivityTemplateDefinitionV1Dto) },
      { $ref: getSchemaPath(AdminActivityTemplateDefinitionV2Dto) },
      { $ref: getSchemaPath(AdminActivityTemplateDefinitionV3Dto) },
    ],
  })
  definition!:
    | AdminActivityTemplateDefinitionV1Dto
    | AdminActivityTemplateDefinitionV2Dto
    | AdminActivityTemplateDefinitionV3Dto;
}
