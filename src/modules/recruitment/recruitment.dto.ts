import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { EMERGENCY_CONTACTS_MIN } from './recruitment.constants';

// 招新一期(招新前段)T3(2026-06-18):recruitment DTO 集合(评审稿 §3.2)。
//
// 公开报名 = multipart/form-data:`payload`(本文件 RecruitmentSubmitPayloadDto 的 JSON 串)+ `idCardImage`(文件);
// controller JSON.parse(payload) → plainToInstance + validate;敏感字段(身份证号/手机/姓名)仅入库不回显明文。
// 出参对外(公开 query)= self-scope 最小集;admin 出参含 PII(掩码策略见 service / §6)。

// 大陆手机号(沿 sms MAINLAND_PHONE 范式)
const MAINLAND_PHONE = /^1[3-9]\d{9}$/;
const NAME_MAX = 50;
const ADDR_MAX = 200;
const CODE_MAX = 64;

// ============ 公开报名提交(payload JSON)============

export class EmergencyContactInputDto {
  @ApiProperty({ description: '紧急联系人姓名' })
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX)
  name!: string;

  @ApiProperty({ description: '与本人关系(字典 emergency_relation)' })
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX)
  relation!: string;

  @ApiProperty({ description: '联系电话(大陆手机号)' })
  @IsString()
  @Matches(MAINLAND_PHONE, { message: '紧急联系人手机号格式不正确' })
  phone!: string;
}

export class RecruitmentSubmitPayloadDto {
  @ApiProperty({ description: '微信 wx.login code(后端 code2session 换 openid)', maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  wechatCode!: string;

  @ApiProperty({ description: '真实姓名(实名核验二要素;高敏感)' })
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX)
  realName!: string;

  @ApiProperty({
    description:
      '证件号(大陆身份证 18 位 / 外籍证件号;高敏感;大陆证件校验位 + 年龄在 service 校验)',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  idCardNumber!: string;

  @ApiProperty({ description: '证件类型(mainland_id 走核验;其余走人工待核)' })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  documentTypeCode!: string;

  @ApiProperty({ description: '手机号(仅通知用途,非身份证据;大陆手机号)' })
  @IsString()
  @Matches(MAINLAND_PHONE, { message: '手机号格式不正确' })
  phone!: string;

  @ApiProperty({ description: '详细住址(高敏感;留存清)' })
  @IsString()
  @MinLength(1)
  @MaxLength(ADDR_MAX)
  detailedAddress!: string;

  @ApiProperty({ description: '城市到区(脱敏留存;前端区县选择器提供)' })
  @IsString()
  @MinLength(1)
  @MaxLength(CODE_MAX)
  cityDistrict!: string;

  @ApiProperty({ description: '来源渠道(脱敏留存)' })
  @IsString()
  @MinLength(1)
  @MaxLength(CODE_MAX)
  sourceChannel!: string;

  @ApiProperty({
    description: `紧急联系人(≥${EMERGENCY_CONTACTS_MIN};高敏感;留存清)`,
    type: [EmergencyContactInputDto],
  })
  @IsArray()
  @ArrayMinSize(EMERGENCY_CONTACTS_MIN, {
    message: `紧急联系人至少需要 ${EMERGENCY_CONTACTS_MIN} 位`,
  })
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => EmergencyContactInputDto)
  emergencyContacts!: EmergencyContactInputDto[];

  @ApiPropertyOptional({ description: '其余报名字段(Q7 精简后冻结,本期最小;高敏感;留存清)' })
  @IsOptional()
  @IsObject()
  profileExtra?: Record<string, unknown>;
}

// ============ 公开查询(凭新 wx.login code)============

export class RecruitmentQueryDto {
  @ApiProperty({ description: '微信 wx.login code(换 openid 查本人当前轮报名)', maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  wechatCode!: string;
}

// 公开出参:申请状态 + 临时编号 + 通知展示(self-scope 最小集;不回显他人/PII 明文)
export class RecruitmentApplicationPublicDto {
  @ApiProperty({ description: '报名状态(pending_verification/verified/manual_review/rejected)' })
  statusCode!: string;

  @ApiPropertyOptional({ description: '临时编号 T{year}{seq}(仅 verified 有值)', nullable: true })
  tempNo!: string | null;

  @ApiProperty({ description: '轮次名' })
  cycleName!: string;

  @ApiPropertyOptional({ description: '见面会信息(后填)', nullable: true })
  meetingInfo!: string | null;

  @ApiPropertyOptional({ description: 'QQ 群(后填)', nullable: true })
  qqGroup!: string | null;

  @ApiPropertyOptional({ description: '通知模板/各节点文案(后填)', nullable: true })
  notifyTemplate!: Record<string, unknown> | null;
}

// ============ admin 轮次 ============

export class CreateRecruitmentCycleDto {
  @ApiProperty({ description: '招新年份(临时编号 T{year} 的 year)' })
  @IsInt()
  @Min(2000)
  year!: number;

  @ApiProperty({ description: '轮次名(如「2026 年度招新」)' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ description: '容量上限(可临时增容;缺省不限)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  capacity?: number;
}

export class UpdateRecruitmentCycleDto {
  @ApiPropertyOptional({ description: '状态(open / closed;开新 open 轮要求当前无 open 轮)' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  statusCode?: string;

  @ApiPropertyOptional({ description: '容量上限(可临时增容)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  capacity?: number;

  @ApiPropertyOptional({ description: '见面会信息(后填)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  meetingInfo?: string;

  @ApiPropertyOptional({ description: 'QQ 群(后填)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  qqGroup?: string;

  @ApiPropertyOptional({ description: '通知模板(各节点文案;后填)' })
  @IsOptional()
  @IsObject()
  notifyTemplate?: Record<string, unknown>;
}

export class RecruitmentCycleResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() year!: number;
  @ApiProperty() name!: string;
  @ApiProperty() statusCode!: string;
  @ApiPropertyOptional({ nullable: true }) capacity!: number | null;
  @ApiProperty({ description: '已发临时编号数(tempNoSeq)' }) issuedCount!: number;
  @ApiPropertyOptional({ nullable: true }) meetingInfo!: string | null;
  @ApiPropertyOptional({ nullable: true }) qqGroup!: string | null;
  @ApiPropertyOptional({ nullable: true }) notifyTemplate!: Record<string, unknown> | null;
  @ApiPropertyOptional({ nullable: true }) openedAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) closedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}

// ============ admin 报名 ============

// admin 报名出参(含 PII;身份证号/手机详情可全显,沿 certificates 可见性;列表掩码由 service 控制)
export class RecruitmentApplicationAdminDto {
  @ApiProperty() id!: string;
  @ApiProperty() cycleId!: string;
  @ApiProperty() statusCode!: string;
  @ApiPropertyOptional({ nullable: true }) tempNo!: string | null;
  @ApiPropertyOptional({ nullable: true }) realName!: string | null;
  @ApiPropertyOptional({ description: '身份证号(列表掩码,详情可全显)', nullable: true })
  idCardNumber!: string | null;
  @ApiPropertyOptional({ nullable: true }) phone!: string | null;
  @ApiProperty() documentTypeCode!: string;
  @ApiProperty() isForeigner!: boolean;
  @ApiPropertyOptional({ nullable: true }) genderCode!: string | null;
  @ApiPropertyOptional({ nullable: true }) ageGroup!: string | null;
  @ApiPropertyOptional({ nullable: true }) cityDistrict!: string | null;
  @ApiPropertyOptional({ nullable: true }) verifyOutcome!: string | null;
  @ApiPropertyOptional({ nullable: true }) eliminationStage!: string | null;
  @ApiProperty({ description: '是否有证件照(取图走 :id/id-card-image-url)' })
  hasIdCardImage!: boolean;
  @ApiProperty() createdAt!: Date;
}

// 人工 resolve(分叉④A):通过 → 发临时编号;不通过 → rejected
export class ResolveRecruitmentApplicationDto {
  @ApiProperty({ description: 'true=人工核验通过(发临时编号);false=不通过(rejected)' })
  @IsBoolean()
  approved!: boolean;

  @ApiPropertyOptional({ description: '人工核验备注' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reviewNote?: string;
}

export class IdCardImageUrlResponseDto {
  @ApiProperty({ description: '证件照短 TTL signed-URL(L3;不入日志/snapshot)' })
  url!: string;

  @ApiProperty({ description: 'URL 过期时刻' })
  expiresAt!: Date;
}
