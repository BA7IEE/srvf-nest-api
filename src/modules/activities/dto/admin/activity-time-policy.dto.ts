import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../../common/dto/pagination.dto';
import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';

const CATEGORIES = ['volunteer_service', 'training', 'organization', 'non_creditable'];

export class TimePolicyRoleMappingDto {
  @ApiProperty({ description: '出勤角色代码', minLength: 1, maxLength: 64 })
  @IsString()
  @Length(1, 64)
  attendanceRoleCode!: string;
  @ApiProperty({ description: '时间类别', enum: CATEGORIES })
  @IsIn(CATEGORIES)
  category!: string;
}
export class TimePolicySpecialIntervalDto {
  @ApiProperty({ description: '区间处理方式', enum: ['exclude', 'category', 'manual'] })
  @IsIn(['exclude', 'category', 'manual'])
  mode!: string;
  @ApiPropertyOptional({ description: '仅category模式必填；其余模式禁止', enum: CATEGORIES })
  @OmittableOnly()
  @IsIn(CATEGORIES)
  category?: string;
}
export class TimePolicySpecialIntervalsDto {
  @ApiProperty({ description: 'preparation区间规则', type: TimePolicySpecialIntervalDto })
  @ValidateNested()
  @Type(() => TimePolicySpecialIntervalDto)
  preparation!: TimePolicySpecialIntervalDto;
  @ApiProperty({ description: 'duty区间规则', type: TimePolicySpecialIntervalDto })
  @ValidateNested()
  @Type(() => TimePolicySpecialIntervalDto)
  duty!: TimePolicySpecialIntervalDto;
  @ApiProperty({ description: 'travel区间规则', type: TimePolicySpecialIntervalDto })
  @ValidateNested()
  @Type(() => TimePolicySpecialIntervalDto)
  travel!: TimePolicySpecialIntervalDto;
}
export class TimePolicyRoundingDto {
  @ApiProperty({ description: '取整模式', enum: ['floor'] })
  @IsIn(['floor'])
  mode!: string;
  @ApiProperty({ description: '取整量子秒数', minimum: 1, maximum: 3600 })
  @IsInt()
  @Min(1)
  @Max(3600)
  quantumSeconds!: number;
}
export class TimePolicyEvidenceDto {
  @ApiProperty({
    description: '全部要求的证据来源',
    type: [String],
    enum: ['punch_event', 'service_segment', 'attachment'],
    maxItems: 3,
  })
  @IsArray()
  @ArrayMaxSize(3)
  @IsIn(['punch_event', 'service_segment', 'attachment'], { each: true })
  requiredSources!: string[];
  @ApiProperty({ description: '要求人工认定' })
  @IsBoolean()
  requireManualRecognition!: boolean;
}
export class TimePolicyManualAdjustmentDto {
  @ApiProperty({ description: '是否允许人工调整' })
  @IsBoolean()
  enabled!: boolean;
  @ApiPropertyOptional({ description: 'enabled=true时必填且为true；false时禁止' })
  @OmittableOnly()
  @IsIn([true])
  reasonRequired?: boolean;
  @ApiPropertyOptional({ description: 'enabled=true时必填；false时禁止' })
  @OmittableOnly()
  @IsBoolean()
  evidenceRequired?: boolean;
}
export class TimePolicyDefinitionDto {
  @ApiProperty({ description: '默认类别', enum: CATEGORIES })
  @IsIn(CATEGORIES)
  defaultCategory!: string;
  @ApiProperty({
    description: '出勤角色映射；无重复角色代码',
    type: [TimePolicyRoleMappingDto],
    maxItems: 64,
  })
  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => TimePolicyRoleMappingDto)
  roleMappings!: TimePolicyRoleMappingDto[];
  @ApiProperty({ description: '是否允许按类别拆分' })
  @IsBoolean()
  allowSplit!: boolean;
  @ApiProperty({ description: 'specialIntervals规则', type: TimePolicySpecialIntervalsDto })
  @ValidateNested()
  @Type(() => TimePolicySpecialIntervalsDto)
  specialIntervals!: TimePolicySpecialIntervalsDto;
  @ApiProperty({ description: 'rounding规则', type: TimePolicyRoundingDto })
  @ValidateNested()
  @Type(() => TimePolicyRoundingDto)
  rounding!: TimePolicyRoundingDto;
  @ApiProperty({ description: 'evidence规则', type: TimePolicyEvidenceDto })
  @ValidateNested()
  @Type(() => TimePolicyEvidenceDto)
  evidence!: TimePolicyEvidenceDto;
  @ApiProperty({ description: 'manualAdjustment规则', type: TimePolicyManualAdjustmentDto })
  @ValidateNested()
  @Type(() => TimePolicyManualAdjustmentDto)
  manualAdjustment!: TimePolicyManualAdjustmentDto;
}
export class AdminListTimePoliciesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '精确政策代码', maxLength: 64 })
  @OmittableOnly()
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{0,63}$/u)
  code?: string;
}
export class AdminListTimePolicyVersionsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '版本状态', enum: ['draft', 'active', 'retired'] })
  @OmittableOnly()
  @IsIn(['draft', 'active', 'retired'])
  statusCode?: string;
}
export class TimePolicyVersionParamDto {
  @ApiProperty({ description: '政策ID', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  id!: string;
  @ApiProperty({ description: '版本ID', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  versionId!: string;
}
export class AdminTimePolicyResponseDto {
  @ApiProperty({ description: '政策ID' })
  id!: string;
  @ApiProperty({ description: '稳定代码' })
  code!: string;
  @ApiProperty({ description: '政策名称' })
  name!: string;
  @ApiProperty({ description: '创建时间' })
  createdAt!: string;
  @ApiProperty({ description: '更新时间' })
  updatedAt!: string;
}
export class AdminTimePolicyVersionSummaryDto {
  @ApiProperty({ description: '版本ID' })
  id!: string;
  @ApiProperty({ description: '政策ID' })
  policyId!: string;
  @ApiProperty({ description: '版本号' })
  version!: number;
  @ApiProperty({ description: '定义结构版本' })
  schemaVersion!: number;
  @ApiProperty({ description: '解释器版本' })
  evaluatorVersion!: number;
  @ApiProperty({ description: '版本语义摘要' })
  definitionHash!: string;
  @ApiProperty({ description: '生效开始' })
  effectiveFrom!: string;
  @ApiProperty({ description: '生效结束', type: String, nullable: true })
  effectiveUntil!: string | null;
  @ApiProperty({ description: '生命周期状态' })
  statusCode!: string;
  @ApiProperty({ description: '激活时间', type: String, nullable: true })
  activatedAt!: string | null;
  @ApiProperty({ description: '退役时间', type: String, nullable: true })
  retiredAt!: string | null;
  @ApiProperty({ description: '创建时间' })
  createdAt!: string;
  @ApiProperty({ description: '更新时间' })
  updatedAt!: string;
}
export class AdminTimePolicyVersionResponseDto extends AdminTimePolicyVersionSummaryDto {
  @ApiProperty({ description: '已校验的完整政策定义', type: TimePolicyDefinitionDto })
  definition!: TimePolicyDefinitionDto;
}
