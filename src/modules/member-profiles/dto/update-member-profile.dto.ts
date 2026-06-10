import { ApiPropertyOptional } from '@nestjs/swagger';
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

// ============ 入参:Update ============

// PATCH 语义:全字段 optional;**绝对禁止** id / memberId / createdAt / updatedAt /
// deletedAt 等系统字段(由 forbidNonWhitelisted 兜底)。
export class UpdateMemberProfileDto {
  @ApiPropertyOptional({ description: '真实姓名', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  realName?: string;

  @ApiPropertyOptional({ description: '性别字典 code', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  genderCode?: string;

  @ApiPropertyOptional({ description: '出生日期(ISO 8601)' })
  @IsOptional()
  @IsDateString()
  birthDate?: string;

  @ApiPropertyOptional({ description: '证件类型字典 code', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  documentTypeCode?: string;

  @ApiPropertyOptional({ description: '证件号(高敏感)', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  documentNumber?: string;

  @ApiPropertyOptional({ description: '民族字典 code', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  ethnicityCode?: string;

  @ApiPropertyOptional({ description: '政治面貌字典 code', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  politicalStatusCode?: string;

  @ApiPropertyOptional({ description: '是否退伍军人' })
  @IsOptional()
  @IsBoolean()
  isVeteran?: boolean;

  @ApiPropertyOptional({ description: '婚姻状况字典 code', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  maritalStatusCode?: string;

  @ApiPropertyOptional({ description: '学历字典 code', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  educationCode?: string;

  @ApiPropertyOptional({ description: '所学专业', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  major?: string;

  @ApiPropertyOptional({ description: '工作性质字典 code', maxLength: 64 })
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

  @ApiPropertyOptional({ description: '本人手机(高敏感)', maxLength: 32 })
  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, { message: 'mobile 格式非法' })
  mobile?: string;

  @ApiPropertyOptional({ description: '座机', maxLength: 32 })
  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, { message: 'landline 格式非法' })
  landline?: string;

  @ApiPropertyOptional({ description: '邮箱', maxLength: 256 })
  @IsOptional()
  @IsEmail()
  @MaxLength(256)
  email?: string;

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

  @ApiPropertyOptional({ description: '身高 cm', minimum: 0, maximum: 999 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  heightCm?: number;

  @ApiPropertyOptional({ description: '体重 kg', minimum: 0, maximum: 500 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(500)
  weightKg?: number;

  @ApiPropertyOptional({ description: '血型字典 code', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  bloodTypeCode?: string;

  @ApiPropertyOptional({ description: '视力', maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  eyesight?: string;

  @ApiPropertyOptional({
    description: '过往病史 JSON 数组(整体替换式更新)',
    type: [MedicalNoteItemDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => MedicalNoteItemDto)
  medicalNotes?: MedicalNoteItemDto[];

  @ApiPropertyOptional({ description: '是否拥有车辆' })
  @IsOptional()
  @IsBoolean()
  hasVehicle?: boolean;

  @ApiPropertyOptional({ description: '车辆类型', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  vehicleType?: string;

  @ApiPropertyOptional({ description: '运动频率字典 code', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  exerciseFrequencyCode?: string;

  @ApiPropertyOptional({ description: '主运动项目字典 code', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  exerciseSportCode?: string;

  @ApiPropertyOptional({
    description: '运动方式 codes(整体替换)',
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

  @ApiPropertyOptional({ description: '急救知识等级字典 code', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  firstAidKnowledgeCode?: string;

  @ApiPropertyOptional({
    description: '急救技能 codes(整体替换)',
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

  @ApiPropertyOptional({ description: '其他特长', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  otherSkills?: string;

  @ApiPropertyOptional({ description: '加入日期(ISO 8601)' })
  @IsOptional()
  @IsDateString()
  joinedDate?: string;

  @ApiPropertyOptional({ description: '加入来源字典 code', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  joinSourceCode?: string;

  @ApiPropertyOptional({ description: '是否签署无违法犯罪声明' })
  @IsOptional()
  @IsBoolean()
  noCriminalRecordSigned?: boolean;

  @ApiPropertyOptional({ description: '是否授权个人信息使用' })
  @IsOptional()
  @IsBoolean()
  privacyConsentSigned?: boolean;

  @ApiPropertyOptional({ description: '隐私授权时间(ISO 8601)' })
  @IsOptional()
  @IsDateString()
  privacyConsentSignedAt?: string;

  @ApiPropertyOptional({ description: '义工号', maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  volunteerNo?: string;
}
