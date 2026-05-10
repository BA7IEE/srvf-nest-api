import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

// V2 第一阶段批次 1 emergency_contacts 模块 DTO 集合。
// 出参显式列字段(永不含 deletedAt 软删内部状态);入参严格白名单 + class-validator,
// 配合 forbidNonWhitelisted 兜底。详见 docs:批次1_API前评审... §3.3 / 草案 §5。
//
// **绝对禁止**字段(全部由 forbidNonWhitelisted 兜底):
// - id / memberId / createdAt / updatedAt / deletedAt
// - 任何未在 schema 中声明的字段
//
// 字段长度上限对齐草案 §6.1:
// - contactName 64 / phonePrimary / phoneBackup 32 / address 256

const PHONE_PATTERN = /^[0-9+\-() ]{6,32}$/;

// ============ 出参 ============

export class EmergencyContactResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '关联队员外键(指向 members.id;N:1)' })
  memberId!: string;

  @ApiProperty({ description: '联系人姓名(EC-2;高敏感)' })
  contactName!: string;

  @ApiProperty({ description: '关系字典 code(EC-3;字典 emergency_relation)' })
  relationCode!: string;

  @ApiProperty({ description: '联系人主电话(EC-4;高敏感)' })
  phonePrimary!: string;

  @ApiPropertyOptional({ description: '联系人备用电话(EC-5)', nullable: true })
  phoneBackup!: string | null;

  @ApiPropertyOptional({ description: '联系人地址(EC-6)', nullable: true })
  address!: string | null;

  @ApiProperty({ description: '优先级(EC-7;0 = 最高;允许并列)' })
  priority!: number;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// ============ 入参:Create ============

// EC-2 / EC-3 / EC-4 必填,其余可选;EC-7 priority 默认 0(草案 §5)。
export class CreateEmergencyContactDto {
  @ApiProperty({ description: '联系人姓名', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  contactName!: string;

  @ApiProperty({ description: '关系字典 code(字典 emergency_relation)', maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  relationCode!: string;

  @ApiProperty({ description: '联系人主电话(高敏感;弱校验)', maxLength: 32 })
  @IsString()
  @Matches(PHONE_PATTERN, {
    message: 'phonePrimary 格式非法(仅允许数字 / + / - / () / 空格,长度 6-32)',
  })
  phonePrimary!: string;

  @ApiPropertyOptional({ description: '联系人备用电话', maxLength: 32 })
  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, { message: 'phoneBackup 格式非法' })
  phoneBackup?: string;

  @ApiPropertyOptional({ description: '联系人地址', maxLength: 256 })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  address?: string;

  @ApiPropertyOptional({
    description: '优先级(0 = 最高;允许并列;默认 0)',
    minimum: 0,
    maximum: 99,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(99)
  priority?: number;
}

// ============ 入参:Update ============

// PATCH 语义:全字段 optional;**绝对禁止** id / memberId / 系统字段(forbidNonWhitelisted 兜底)。
export class UpdateEmergencyContactDto {
  @ApiPropertyOptional({ description: '联系人姓名', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  contactName?: string;

  @ApiPropertyOptional({ description: '关系字典 code', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  relationCode?: string;

  @ApiPropertyOptional({ description: '联系人主电话', maxLength: 32 })
  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, { message: 'phonePrimary 格式非法' })
  phonePrimary?: string;

  @ApiPropertyOptional({ description: '联系人备用电话', maxLength: 32 })
  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, { message: 'phoneBackup 格式非法' })
  phoneBackup?: string;

  @ApiPropertyOptional({ description: '联系人地址', maxLength: 256 })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  address?: string;

  @ApiPropertyOptional({ description: '优先级', minimum: 0, maximum: 99 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(99)
  priority?: number;
}
