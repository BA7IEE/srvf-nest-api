import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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

export const PHONE_PATTERN = /^[0-9+\-() ]{6,32}$/;

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
