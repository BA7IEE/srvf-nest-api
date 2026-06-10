import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { MedicalNoteItemDto, PHONE_PATTERN } from './member-profile.shared.dto';

// ============ 入参:Create ============

// NOT NULL 业务字段(对齐草案 §7 第一档):realName / genderCode / birthDate /
// documentTypeCode / documentNumber / mobile / email / joinedDate / joinSourceCode /
// privacyConsentSigned。其余字段可空(schema 兼容 3000+ 历史档案缺字段)。
export class CreateMemberProfileDto {
  // ===== 报名表必填基础信息(NOT NULL) =====

  @ApiProperty({ description: '真实姓名', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  realName!: string;

  @ApiProperty({ description: '性别字典 code(字典 gender)', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  genderCode!: string;

  @ApiProperty({ description: '出生日期(ISO 8601;业务层规范化为 00:00:00.000Z)' })
  @IsDateString()
  birthDate!: string;

  @ApiProperty({ description: '证件类型字典 code(字典 document_type)', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  documentTypeCode!: string;

  @ApiProperty({ description: '证件号(高敏感;弱校验,不锁 18 位身份证正则)', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  documentNumber!: string;

  @ApiProperty({ description: '本人手机(高敏感;弱校验)', maxLength: 32 })
  @IsString()
  @Matches(PHONE_PATTERN, { message: 'mobile 格式非法(仅允许数字 / + / - / () / 空格,长度 6-32)' })
  mobile!: string;

  @ApiProperty({ description: '邮箱', maxLength: 256 })
  @IsEmail()
  @MaxLength(256)
  email!: string;

  @ApiProperty({ description: '加入日期(ISO 8601)' })
  @IsDateString()
  joinedDate!: string;

  @ApiProperty({ description: '加入来源字典 code(候选字典 join_source)', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  joinSourceCode!: string;

  @ApiProperty({ description: '是否授权个人信息使用' })
  @IsBoolean()
  privacyConsentSigned!: boolean;

  // ===== 报名表选填 / 内部档案补充(可空) =====

  @ApiPropertyOptional({ description: '民族字典 code(候选字典 ethnicity)', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  ethnicityCode?: string;

  @ApiPropertyOptional({ description: '政治面貌字典 code(字典 political_status)', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  politicalStatusCode?: string;

  @ApiPropertyOptional({ description: '是否退伍军人' })
  @IsOptional()
  @IsBoolean()
  isVeteran?: boolean;

  @ApiPropertyOptional({ description: '婚姻状况字典 code(候选字典 marital_status)', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  maritalStatusCode?: string;

  @ApiPropertyOptional({ description: '学历字典 code(候选字典 education)', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  educationCode?: string;

  @ApiPropertyOptional({ description: '所学专业(自由文本)', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  major?: string;

  @ApiPropertyOptional({
    description: '工作性质字典 code(字典 work_nature;只存性质,不存单位)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  workNatureCode?: string;

  @ApiPropertyOptional({ description: '居住区行政区粒度', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  residenceArea?: string;

  @ApiPropertyOptional({ description: '工作区行政区粒度', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  workArea?: string;

  @ApiPropertyOptional({ description: '座机(选填;弱校验)', maxLength: 32 })
  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, { message: 'landline 格式非法' })
  landline?: string;

  @ApiPropertyOptional({ description: 'QQ', maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  qq?: string;

  @ApiPropertyOptional({ description: '微信', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  wechat?: string;

  // ===== 报名表必填医疗类(可空 schema,业务必填由后续 USER 自助校验) =====

  @ApiPropertyOptional({
    description: '身高 cm(高敏感医疗;弱合理性兜底)',
    minimum: 0,
    maximum: 999,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  heightCm?: number;

  @ApiPropertyOptional({
    description: '体重 kg(高敏感医疗;弱合理性兜底)',
    minimum: 0,
    maximum: 500,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(500)
  weightKg?: number;

  @ApiPropertyOptional({ description: '血型字典 code(字典 blood_type)', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  bloodTypeCode?: string;

  @ApiPropertyOptional({ description: '视力(自由文本)', maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  eyesight?: string;

  @ApiPropertyOptional({
    description: '过往病史 JSON 数组(高敏感医疗;元素 { categoryCode, note })',
    type: [MedicalNoteItemDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => MedicalNoteItemDto)
  medicalNotes?: MedicalNoteItemDto[];

  // ===== 能力特长(可空 schema) =====

  @ApiPropertyOptional({ description: '是否拥有车辆' })
  @IsOptional()
  @IsBoolean()
  hasVehicle?: boolean;

  @ApiPropertyOptional({ description: '车辆类型(hasVehicle=true 时填)', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  vehicleType?: string;

  @ApiPropertyOptional({
    description: '运动频率字典 code(候选字典 exercise_frequency)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  exerciseFrequencyCode?: string;

  @ApiPropertyOptional({
    description: '主运动项目字典 code(候选字典 exercise_sport)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  exerciseSportCode?: string;

  @ApiPropertyOptional({
    description: '运动方式 codes(字典 exercise_method;每元素 1-64 字符;数组上限 20)',
    type: [String],
    maxLength: 64,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(64, { each: true })
  exerciseMethods?: string[];

  @ApiPropertyOptional({
    description: '急救知识等级字典 code(候选字典 first_aid_knowledge)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  firstAidKnowledgeCode?: string;

  @ApiPropertyOptional({
    description: '急救技能 codes(字典 first_aid_skill)',
    type: [String],
    maxLength: 64,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(64, { each: true })
  firstAidSkills?: string[];

  @ApiPropertyOptional({ description: '其他特长(长文本)', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  otherSkills?: string;

  // ===== 内部档案补充(可空) =====

  @ApiPropertyOptional({ description: '是否签署无违法犯罪声明' })
  @IsOptional()
  @IsBoolean()
  noCriminalRecordSigned?: boolean;

  @ApiPropertyOptional({ description: '隐私授权时间(ISO 8601)' })
  @IsOptional()
  @IsDateString()
  privacyConsentSignedAt?: string;

  // ===== 外部记录字段 =====

  @ApiPropertyOptional({ description: '义工号(不参与登录 / 权限 / 身份识别)', maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  volunteerNo?: string;
}
