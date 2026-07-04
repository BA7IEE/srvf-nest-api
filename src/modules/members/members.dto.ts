import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MemberStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

// query boolean 从 GET query string 解析:原始值是字符串 'true'/'false',@Type(() => Boolean)
// 会用 `Boolean(value)` 转换 —— 任何非空字符串(含 'false')都会变 true,是已知陷阱,
// 故显式判等而非用 @Type。
const parseQueryBoolean = ({ value }: { value: unknown }): unknown =>
  value === true || value === 'true' ? true : value === false || value === 'false' ? false : value;

// V2 第一阶段 members 模块 DTO 集合。
// 出参显式列字段(永不含 deletedAt 软删内部状态);入参严格白名单 + class-validator,
// 配合 forbidNonWhitelisted 兜底。详见 docs/v2-api-contract.md §4 / docs/v2-data-model.md §5。
//
// **绝对禁止任何敏感字段**:身份证 / 紧急联系人 / 医疗 / 出生日期 / 住址 / 性别 /
// 联系方式 / 第三方账号 / 凭证(全部延后到 V2.x member_profiles)。
// **绝对禁止改 memberNo**:UpdateMemberDto 不含 memberNo 字段(memberNo 是稳定身份标识)。

// ============ 出参 ============

export class MemberResponseDto {
  @ApiProperty({
    description: '主键(cuid;独立,不复用 users.id)',
    example: 'cl9z3a8b00000abcd1234efgh',
  })
  id!: string;

  @ApiProperty({
    description: '队员业务唯一编号(全局唯一,包含软删不复用;非敏感、高价值业务标识)',
    example: 'M-0001',
  })
  memberNo!: string;

  @ApiProperty({ description: '称呼 / 显示名(业务可读)', example: 'Demo Member' })
  displayName!: string;

  @ApiPropertyOptional({
    description: '等级字典 code(隐含 type code = member_grade)',
    nullable: true,
  })
  gradeCode!: string | null;

  @ApiProperty({ description: '在队 / 离队状态', enum: MemberStatus })
  status!: MemberStatus;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// ============ 入参 ============

// memberNo 校验:DTO 层 @MinLength(1) + @MaxLength(32) + 字符集 [A-Za-z0-9-];
// service 层 trim() 保留原大小写(与 v1 username 的 toLowerCase() 不同 — 编号即身份)。
export class CreateMemberDto {
  @ApiProperty({
    description:
      'memberNo 业务唯一编号(必填;trim 后保存,保留大小写;字母 / 数字 / 连字符;长度 1-32)',
    example: 'M-0001',
    minLength: 1,
    maxLength: 32,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  @Matches(/^[A-Za-z0-9-]+$/, {
    message: 'memberNo 只允许字母 / 数字 / 连字符',
  })
  memberNo!: string;

  @ApiProperty({ description: '称呼 / 显示名', maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  displayName!: string;

  @ApiPropertyOptional({
    description: '等级字典 code(可选;若提供必须在 type=member_grade 字典中存在且 ACTIVE)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  gradeCode?: string;
}

// 仅允许 displayName / gradeCode;**绝对禁止**:
// - memberNo(稳定身份标识,本期不开发改编号接口)
// - status(走 PATCH /:id/status)
// - id / deletedAt
// - 任何敏感字段(由 forbidNonWhitelisted 兜底拒绝)
export class UpdateMemberDto {
  @ApiPropertyOptional({ description: '称呼 / 显示名', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  displayName?: string;

  @ApiPropertyOptional({ description: '等级字典 code', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  gradeCode?: string;
}

export class UpdateMemberStatusDto {
  @ApiProperty({
    description: '目标状态(ACTIVE / INACTIVE)',
    enum: MemberStatus,
    example: MemberStatus.INACTIVE,
  })
  @IsEnum(MemberStatus)
  status!: MemberStatus;
}

// 列表 query:支持 memberNo 精确查询(完整匹配,不做模糊 — 编号即身份)、
// gradeCode 过滤、status 过滤。
// F1/A1(路线图 §4;D1/D7 拍板):新增可选 q(模糊命中 displayName+memberNo)/
// organizationId(经 memberOrganizationMemberships 关联过滤)/ includeDescendants
// (配合 organizationId 展开后代组织,默认 false)。旧字段/响应形状不变(additive)。
export class ListMembersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'memberNo 精确查询(完整匹配)', maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  memberNo?: string;

  @ApiPropertyOptional({ description: 'gradeCode 过滤', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  gradeCode?: string;

  @ApiPropertyOptional({ description: '按状态过滤', enum: MemberStatus })
  @IsOptional()
  @IsEnum(MemberStatus)
  status?: MemberStatus;

  @ApiPropertyOptional({
    description: '模糊搜索(跨字段命中 displayName + memberNo;contains + insensitive)',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    description: '按组织归属过滤(经 active membership 关联;任意 membershipType 均计入)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  organizationId?: string;

  @ApiPropertyOptional({
    description: '配合 organizationId:是否展开其全部后代组织(默认 false)',
    default: false,
  })
  @IsOptional()
  @Transform(parseQueryBoolean)
  @IsBoolean()
  includeDescendants?: boolean;
}

// ============ F1/A1 选择器(路线图 §4;D2/D3 拍板)============

export class MemberOptionsQueryDto {
  @ApiPropertyOptional({
    description: '模糊搜索(跨字段命中 displayName + memberNo)',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ description: '按组织归属过滤(经 active membership 关联)', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  organizationId?: string;

  @ApiPropertyOptional({
    description: '配合 organizationId:是否展开其全部后代组织(默认 false)',
    default: false,
  })
  @IsOptional()
  @Transform(parseQueryBoolean)
  @IsBoolean()
  includeDescendants?: boolean;

  @ApiPropertyOptional({ description: '结果条数上限(默认 20,上限 100)', minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class MemberOptionItemDto {
  @ApiProperty({ description: '主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '展示标签(= displayName)' })
  label!: string;

  @ApiProperty({ description: '队员业务唯一编号' })
  memberNo!: string;

  @ApiPropertyOptional({ description: '等级字典 code', nullable: true })
  gradeCode!: string | null;
}

export class MemberOptionsResponseDto {
  @ApiProperty({ description: '结果列表(不分页,受 limit 截断)', type: () => [MemberOptionItemDto] })
  items!: MemberOptionItemDto[];
}
