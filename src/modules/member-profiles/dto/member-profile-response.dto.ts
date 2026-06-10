import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MedicalNoteItemDto } from './member-profile.shared.dto';

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
