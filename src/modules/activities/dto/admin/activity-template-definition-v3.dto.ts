import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
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
  Equals,
  IsNumber,
  ArrayMinSize,
} from 'class-validator';
import { OmittableOnly } from '../../../../common/decorators/omittable-only.decorator';
import { AdminActivityMetricSelectionInputDto } from './activity-metric-selection.dto';
import {
  REGISTRATION_FORM_FIELD_TYPES,
  REGISTRATION_FORM_FIELD_VISIBILITIES,
  REGISTRATION_FORM_GOVERNANCE_PURPOSE_CODES,
  REGISTRATION_FORM_DATA_CLASS_CODES,
  REGISTRATION_FORM_RETENTION_POLICY_CODES,
  REGISTRATION_FORM_MASKING_POLICY_CODES,
} from '../../registration-form-definition';

export class AdminTemplateActivityDefinitionDto {
  @ApiProperty({
    description: '明确分配方式',
    enum: ['first_come', 'qualification_rank', 'lottery'],
  })
  @IsIn(['first_come', 'qualification_rank', 'lottery'])
  allocationModeCode!: 'first_come' | 'qualification_rank' | 'lottery';
  @ApiPropertyOptional({ description: '活动说明', type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;
  @ApiPropertyOptional({ description: '活动容量', type: Number, nullable: true, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  capacity?: number | null;
  @ApiPropertyOptional({
    description: '性别要求字典码',
    type: String,
    nullable: true,
    minLength: 1,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  genderRequirementCode?: string | null;
  @ApiPropertyOptional({ description: '报名说明', type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  registrationNotes?: string | null;
  @ApiPropertyOptional({ description: '公开报名' })
  @OmittableOnly()
  @IsBoolean()
  isPublicRegistration?: boolean;
  @ApiPropertyOptional({ description: '要求保险' })
  @OmittableOnly()
  @IsBoolean()
  requiresInsurance?: boolean;
  @ApiPropertyOptional({
    description: '报名方式',
    type: String,
    nullable: true,
    enum: ['open_apply', 'invitation_only', 'admin_only', 'paused'],
  })
  @IsOptional()
  @IsIn(['open_apply', 'invitation_only', 'admin_only', 'paused'])
  registrationModeCode?: 'open_apply' | 'invitation_only' | 'admin_only' | 'paused' | null;
  @ApiPropertyOptional({
    description: '可见性',
    type: String,
    nullable: true,
    enum: ['internal', 'invitation'],
  })
  @IsOptional()
  @IsIn(['internal', 'invitation'])
  visibilityCode?: 'internal' | 'invitation' | null;
  @ApiPropertyOptional({ description: '默认定位要求', type: Boolean, nullable: true })
  @IsOptional()
  @IsBoolean()
  defaultLocationRequired?: boolean | null;
  @ApiPropertyOptional({ description: '默认签到半径', type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  defaultCheckInRadiusMeters?: number | null;
  @ApiPropertyOptional({ description: '归档等待天数', minimum: 0, maximum: 365 })
  @OmittableOnly()
  @IsInt()
  @Min(0)
  @Max(365)
  archiveWaitingDays?: number;
}

export class AdminTemplatePositionDefinitionDto {
  @ApiProperty({ description: '岗位 code', minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code!: string;
  @ApiProperty({ description: '岗位名称', minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;
  @ApiProperty({ description: '考勤角色字典码', minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  attendanceRoleCode!: string;
  @ApiPropertyOptional({ description: '岗位容量', type: Number, nullable: true, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  capacity?: number | null;
  @ApiPropertyOptional({
    description: '相对活动开始的分钟偏移，与结束同空同有',
    type: Number,
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  startOffsetMinutes?: number | null;
  @ApiPropertyOptional({ description: '相对活动开始的结束分钟偏移', type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  endOffsetMinutes?: number | null;
  @ApiPropertyOptional({
    description: '性别要求字典码',
    type: String,
    nullable: true,
    minLength: 1,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  genderRequirementCode?: string | null;
  @ApiPropertyOptional({
    description: '当前蓝图不含坐标，只允许 false/null',
    type: Boolean,
    nullable: true,
    enum: [false, null],
  })
  @IsOptional()
  @Equals(false)
  locationRequired?: false | null;
  @ApiPropertyOptional({
    description: '当前蓝图仅允许空半径',
    type: Number,
    nullable: true,
    enum: [null],
  })
  @IsOptional()
  @Equals(null)
  radiusMeters?: null;
  @ApiPropertyOptional({
    description: '岗位说明',
    type: String,
    nullable: true,
    minLength: 1,
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description?: string | null;
  @ApiPropertyOptional({
    description: '装备说明',
    type: String,
    nullable: true,
    minLength: 1,
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  equipmentNotes?: string | null;
  @ApiPropertyOptional({ description: '排序；省略沿既有解析器默认 0', type: Number })
  @OmittableOnly()
  @IsInt()
  sortOrder?: number;
}

export class AdminTemplateSessionDefinitionDto {
  @ApiProperty({ description: '场次 code', minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code!: string;
  @ApiProperty({ description: '场次名称', minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;
  @ApiProperty({ description: '相对活动开始的起始分钟偏移' }) @IsInt() startOffsetMinutes!: number;
  @ApiProperty({ description: '相对活动开始的结束分钟偏移' }) @IsInt() endOffsetMinutes!: number;
  @ApiProperty({ description: '场次文字地点', minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  locationText!: string;
  @ApiPropertyOptional({ description: '场次容量', type: Number, nullable: true, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  capacity?: number | null;
  @ApiProperty({ description: '签到开放，相对场次开始分钟数' })
  @IsInt()
  checkInOpenOffsetMinutes!: number;
  @ApiProperty({ description: '签到关闭，相对场次开始分钟数' })
  @IsInt()
  checkInCloseOffsetMinutes!: number;
  @ApiProperty({ description: '签退开放，相对场次结束分钟数' })
  @IsInt()
  checkOutOpenOffsetMinutes!: number;
  @ApiProperty({ description: '签退关闭，相对场次结束分钟数' })
  @IsInt()
  checkOutCloseOffsetMinutes!: number;
  @ApiPropertyOptional({
    description: '准备时段，相对场次开始分钟数',
    type: Number,
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  preparationStartOffsetMinutes?: number | null;
  @ApiPropertyOptional({ description: '当前蓝图不含坐标，仅 false', enum: [false], type: Boolean })
  @OmittableOnly()
  @Equals(false)
  locationRequired?: false;
  @ApiPropertyOptional({
    description: '当前蓝图仅允许空半径',
    type: Number,
    nullable: true,
    enum: [null],
  })
  @IsOptional()
  @Equals(null)
  radiusMeters?: null;
  @ApiPropertyOptional({ description: '迟到宽限分钟数；省略沿解析器默认 15' })
  @OmittableOnly()
  @IsInt()
  lateGraceMinutes?: number;
  @ApiPropertyOptional({ description: '早退阈值分钟数；省略沿解析器默认 15' })
  @OmittableOnly()
  @IsInt()
  earlyLeaveThresholdMinutes?: number;
  @ApiPropertyOptional({ description: '排序；省略沿解析器默认 0' })
  @OmittableOnly()
  @IsInt()
  sortOrder?: number;
  @ApiProperty({
    description: '完整岗位集合，允许空',
    type: () => [AdminTemplatePositionDefinitionDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdminTemplatePositionDefinitionDto)
  positions!: AdminTemplatePositionDefinitionDto[];
}

export class AdminTemplateFormChoiceDto {
  @ApiProperty({ description: '选项值', minLength: 1, maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  value!: string;
  @ApiProperty({ description: '选项文字', minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label!: string;
}
export class AdminTemplateFormGovernanceDto {
  @ApiProperty({ description: '明确用途', enum: REGISTRATION_FORM_GOVERNANCE_PURPOSE_CODES })
  @IsIn(REGISTRATION_FORM_GOVERNANCE_PURPOSE_CODES)
  purposeCode!: string;
  @ApiProperty({
    description: '数据分级；敏感题目仍不可未经逐题审批使用',
    enum: REGISTRATION_FORM_DATA_CLASS_CODES,
  })
  @IsIn(REGISTRATION_FORM_DATA_CLASS_CODES)
  dataClassCode!: string;
  @ApiProperty({ description: '保存规则', enum: REGISTRATION_FORM_RETENTION_POLICY_CODES })
  @IsIn(REGISTRATION_FORM_RETENTION_POLICY_CODES)
  retentionPolicyCode!: string;
  @ApiProperty({ description: '掩码规则', enum: REGISTRATION_FORM_MASKING_POLICY_CODES })
  @IsIn(REGISTRATION_FORM_MASKING_POLICY_CODES)
  maskingPolicyCode!: string;
  @ApiProperty({ description: '不启用档案预填', type: String, nullable: true, enum: [null] })
  @Equals(null)
  prefillSourceCode!: null;
}
export class AdminTemplateFormFieldDto {
  @ApiProperty({ description: '题目 code', minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  fieldCode!: string;
  @ApiProperty({ description: '既有八种题型', enum: REGISTRATION_FORM_FIELD_TYPES })
  @IsIn(REGISTRATION_FORM_FIELD_TYPES)
  typeCode!: string;
  @ApiProperty({ description: '题目文字', minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label!: string;
  @ApiPropertyOptional({ description: '帮助文字', type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  helpText?: string | null;
  @ApiProperty({ description: '是否必填' }) @IsBoolean() required!: boolean;
  @ApiProperty({ description: '可见性', enum: REGISTRATION_FORM_FIELD_VISIBILITIES })
  @IsIn(REGISTRATION_FORM_FIELD_VISIBILITIES)
  visibilityCode!: string;
  @ApiProperty({ description: '模板表单禁止导出', enum: [false], type: Boolean })
  @Equals(false)
  exportable!: false;
  @ApiProperty({ description: '排序', minimum: 0 }) @IsInt() @Min(0) sortOrder!: number;
  @ApiPropertyOptional({
    description: '数值下界；仍受既有模板 canonical 数值规则约束',
    type: Number,
    nullable: true,
  })
  @IsOptional()
  @IsNumber()
  minValue?: number | null;
  @ApiPropertyOptional({ description: '数值上界', type: Number, nullable: true })
  @IsOptional()
  @IsNumber()
  maxValue?: number | null;
  @ApiPropertyOptional({ description: '文本最短长度', type: Number, nullable: true, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  minLength?: number | null;
  @ApiPropertyOptional({ description: '文本最长长度', type: Number, nullable: true, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxLength?: number | null;
  @ApiPropertyOptional({ description: '最多选择数量', type: Number, nullable: true, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxSelections?: number | null;
  @ApiPropertyOptional({
    description: '完整选项',
    type: () => [AdminTemplateFormChoiceDto],
    nullable: true,
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdminTemplateFormChoiceDto)
  options?: AdminTemplateFormChoiceDto[] | null;
  @ApiProperty({
    description: '完整治理合同，不允许 legacy 缺省',
    type: () => AdminTemplateFormGovernanceDto,
  })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminTemplateFormGovernanceDto)
  governance!: AdminTemplateFormGovernanceDto;
}
export class AdminTemplateRegistrationFormDto {
  @ApiProperty({
    description: '完整题目集合',
    type: () => [AdminTemplateFormFieldDto],
    minItems: 1,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AdminTemplateFormFieldDto)
  fields!: AdminTemplateFormFieldDto[];
}

export class AdminActivityTemplateDefinitionV1Dto {
  @ApiProperty({ description: '完整活动蓝图', type: () => AdminTemplateActivityDefinitionDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminTemplateActivityDefinitionDto)
  activity!: AdminTemplateActivityDefinitionDto;
  @ApiProperty({
    description: '完整场次蓝图，允许空',
    type: () => [AdminTemplateSessionDefinitionDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdminTemplateSessionDefinitionDto)
  sessions!: AdminTemplateSessionDefinitionDto[];
}
export class AdminActivityTemplateDefinitionV2Dto extends AdminActivityTemplateDefinitionV1Dto {
  @ApiProperty({
    description: '完整 governed 表单；显式 null 表示不建自定义表单',
    type: () => AdminTemplateRegistrationFormDto,
    nullable: true,
  })
  @ValidateIf((_, value: unknown) => value !== null)
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminTemplateRegistrationFormDto)
  registrationForm!: AdminTemplateRegistrationFormDto | null;
}
export class AdminActivityTemplateDefinitionV3Dto extends AdminActivityTemplateDefinitionV2Dto {
  @ApiProperty({ description: '显式指标选择', type: () => AdminActivityMetricSelectionInputDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => AdminActivityMetricSelectionInputDto)
  metricSelection!: AdminActivityMetricSelectionInputDto;
}
