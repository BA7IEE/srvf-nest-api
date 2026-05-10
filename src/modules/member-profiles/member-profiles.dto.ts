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

// V2 第一阶段批次 1 member_profiles 模块 DTO 集合。
// 出参显式列字段(永不含 deletedAt 软删内部状态);入参严格白名单 + class-validator,
// 配合 forbidNonWhitelisted 兜底。详见 docs:批次1_API前评审... §3 / 草案 §4。
//
// **绝对禁止**字段(全部由 forbidNonWhitelisted 兜底):
// - id / memberId / createdAt / updatedAt / deletedAt(系统字段)
// - 任何未在 schema 中声明的字段
//
// 字段长度上限对齐草案 §6.1:
// - realName 64 / mobile / landline 32 / email 256 / qq 32 / wechat 64
// - documentNumber 64 / address 256 / residenceArea / workArea 64 / major 128
// - vehicleType 64 / eyesight 32 / otherSkills 2000 / volunteerNo 32
// - 字典 code 上限 64(与 dict_items.code 一致)
//
// 手机 / 座机弱校验 /^[0-9+\-() ]{6,32}$/ — 兼容 +86 / 港澳台 / 历史档案。
// 身份证号弱校验:仅长度 + 字符集,不写死 18 位身份证正则(兼容护照 / 港澳台通行证)。
// 日期字段(birthDate / joinedDate / privacyConsentSignedAt)用 @IsDateString,
// service 层按 00:00:00.000Z 规范化(B 路径,详见草案 §6)。

const PHONE_PATTERN = /^[0-9+\-() ]{6,32}$/;

// MP-21 medicalNotes 嵌套元素 DTO。Q-S01 决议:JSON 数组,元素 { categoryCode, note }。
export class MedicalNoteItemDto {
  @ApiProperty({
    description: '病史类别字典 code(候选字典 medical_condition_category;运营层后录入)',
    maxLength: 64,
    example: 'demo-medical-cat-1',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  categoryCode!: string;

  @ApiPropertyOptional({ description: '备注(自由文本)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ============ 出参 ============

export class MemberProfileResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '关联队员外键(指向 members.id;1:1)' })
  memberId!: string;

  @ApiProperty({ description: '真实姓名(MP-1)' })
  realName!: string;

  @ApiProperty({ description: '性别字典 code(MP-2;字典 gender)' })
  genderCode!: string;

  @ApiProperty({ description: '出生日期(MP-3;ISO 8601)' })
  birthDate!: Date;

  @ApiProperty({ description: '证件类型字典 code(MP-4;字典 document_type)' })
  documentTypeCode!: string;

  @ApiProperty({ description: '证件号(MP-5;高敏感)' })
  documentNumber!: string;

  @ApiPropertyOptional({ description: '民族字典 code(MP-6;候选字典 ethnicity)', nullable: true })
  ethnicityCode!: string | null;

  @ApiPropertyOptional({
    description: '政治面貌字典 code(MP-7;字典 political_status)',
    nullable: true,
  })
  politicalStatusCode!: string | null;

  @ApiPropertyOptional({ description: '是否退伍军人(MP-8)', nullable: true })
  isVeteran!: boolean | null;

  @ApiPropertyOptional({
    description: '婚姻状况字典 code(MP-9;候选字典 marital_status)',
    nullable: true,
  })
  maritalStatusCode!: string | null;

  @ApiPropertyOptional({ description: '学历字典 code(MP-10;候选字典 education)', nullable: true })
  educationCode!: string | null;

  @ApiPropertyOptional({ description: '所学专业(MP-11;自由文本)', nullable: true })
  major!: string | null;

  @ApiPropertyOptional({
    description: '工作性质字典 code(MP-12;字典 work_nature;只存性质,不存单位)',
    nullable: true,
  })
  workNatureCode!: string | null;

  @ApiPropertyOptional({ description: '居住区行政区粒度(MP-13)', nullable: true })
  residenceArea!: string | null;

  @ApiPropertyOptional({ description: '工作区行政区粒度(MP-14)', nullable: true })
  workArea!: string | null;

  @ApiProperty({ description: '本人手机(MP-15;高敏感)' })
  mobile!: string;

  @ApiPropertyOptional({ description: '座机(MP-16;选填)', nullable: true })
  landline!: string | null;

  @ApiProperty({ description: '邮箱(MP-17)' })
  email!: string;

  @ApiPropertyOptional({ description: 'QQ(MP-18a)', nullable: true })
  qq!: string | null;

  @ApiPropertyOptional({ description: '微信(MP-18b)', nullable: true })
  wechat!: string | null;

  @ApiPropertyOptional({ description: '身高 cm(MP-19a;高敏感医疗)', nullable: true })
  heightCm!: number | null;

  @ApiPropertyOptional({ description: '体重 kg(MP-19b;高敏感医疗)', nullable: true })
  weightKg!: number | null;

  @ApiPropertyOptional({
    description: '血型字典 code(MP-19c;字典 blood_type;高敏感医疗)',
    nullable: true,
  })
  bloodTypeCode!: string | null;

  @ApiPropertyOptional({ description: '视力(MP-20;选填)', nullable: true })
  eyesight!: string | null;

  @ApiPropertyOptional({
    description: '过往病史 JSON 数组(MP-21;高敏感医疗;元素 { categoryCode, note })',
    type: [MedicalNoteItemDto],
    nullable: true,
  })
  medicalNotes!: MedicalNoteItemDto[] | null;

  @ApiPropertyOptional({ description: '是否拥有车辆(MP-22a)', nullable: true })
  hasVehicle!: boolean | null;

  @ApiPropertyOptional({ description: '车辆类型(MP-22b;hasVehicle=true 时填)', nullable: true })
  vehicleType!: string | null;

  @ApiPropertyOptional({
    description: '运动频率字典 code(MP-23a;候选字典 exercise_frequency)',
    nullable: true,
  })
  exerciseFrequencyCode!: string | null;

  @ApiPropertyOptional({
    description: '主运动项目字典 code(MP-23b;候选字典 exercise_sport)',
    nullable: true,
  })
  exerciseSportCode!: string | null;

  @ApiProperty({
    description: '运动方式 codes(MP-23c;字典 exercise_method;PG String[])',
    type: [String],
  })
  exerciseMethods!: string[];

  @ApiPropertyOptional({
    description: '急救知识等级字典 code(MP-24;候选字典 first_aid_knowledge)',
    nullable: true,
  })
  firstAidKnowledgeCode!: string | null;

  @ApiProperty({
    description: '急救技能 codes(MP-25;字典 first_aid_skill;PG String[])',
    type: [String],
  })
  firstAidSkills!: string[];

  @ApiPropertyOptional({ description: '其他特长(MP-26;长文本)', nullable: true })
  otherSkills!: string | null;

  @ApiProperty({ description: '加入日期(MP-27;ISO 8601)' })
  joinedDate!: Date;

  @ApiProperty({ description: '加入来源字典 code(MP-28;候选字典 join_source)' })
  joinSourceCode!: string;

  @ApiPropertyOptional({ description: '是否签署无违法犯罪声明(MP-29)', nullable: true })
  noCriminalRecordSigned!: boolean | null;

  @ApiProperty({ description: '是否授权个人信息使用(MP-30a)' })
  privacyConsentSigned!: boolean;

  @ApiPropertyOptional({ description: '隐私授权时间(MP-30b)', nullable: true })
  privacyConsentSignedAt!: Date | null;

  @ApiPropertyOptional({
    description: '义工号(MP-31;外部记录;不参与登录 / 权限 / 身份识别)',
    nullable: true,
  })
  volunteerNo!: string | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

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
