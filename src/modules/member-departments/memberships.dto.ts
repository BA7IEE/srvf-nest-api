import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MembershipStatus, MembershipType } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString, Length, MaxLength } from 'class-validator';

// 终态 scoped-authz PR2(2026-07-01;冻结稿 §3.1 / §7.1):memberships 组织归属 CRUD DTO 集合。
// 出参显式列字段(永不含 deletedAt 软删内部状态);入参严格白名单。
// 旧 member-departments DTO(MemberDepartmentResponseDto / SetMemberDepartmentDto)保留一版不动。
//
// 与旧单部门 DTO 的差异:memberships 面显式承载 membershipType / status / 任期(startedAt/endedAt)/ reason,
// 支持主(PRIMARY)/兼(SECONDARY)/临时(TEMPORARY)/支援(SUPPORT)多条并存 + 历史留痕。

// ============ 出参 ============

export class MembershipResponseDto {
  @ApiProperty({ description: '主键(cuid 代理键)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '队员外键(指向 members.id)' })
  memberId!: string;

  @ApiProperty({ description: '组织节点外键(指向 organizations.id)' })
  organizationId!: string;

  @ApiProperty({
    description: '归属类型(PRIMARY 主 / SECONDARY 兼 / TEMPORARY 临时 / SUPPORT 支援)',
    enum: MembershipType,
    example: MembershipType.PRIMARY,
  })
  membershipType!: MembershipType;

  @ApiProperty({
    description: '归属状态(ACTIVE 在任 / ENDED 已结束 / SUSPENDED 暂停)',
    enum: MembershipStatus,
    example: MembershipStatus.ACTIVE,
  })
  status!: MembershipStatus;

  @ApiProperty({ description: '任期起(归属生效时间)' })
  startedAt!: Date;

  @ApiPropertyOptional({ description: '任期止(为空表示仍在任)', nullable: true })
  endedAt!: Date | null;

  @ApiPropertyOptional({ description: '编入 / 调出原因(自由短串)', nullable: true })
  reason!: string | null;

  @ApiPropertyOptional({ description: '创建人 userId', nullable: true })
  createdByUserId!: string | null;

  @ApiPropertyOptional({ description: '结束人 userId', nullable: true })
  endedByUserId!: string | null;

  @ApiProperty({ description: '记录创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// ============ 入参 ============

// POST /api/admin/v1/members/:memberId/memberships 入参。
// 严格白名单:**禁止** memberId(由路径参数提供)/ id / status / deletedAt / 时间戳 / *ByUserId。
export class CreateMembershipDto {
  @ApiProperty({
    description: '目标组织节点 id(必须存在且 status=ACTIVE)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  organizationId!: string;

  @ApiProperty({
    description: '归属类型(指定;PRIMARY 至多一条 active,其余可并存多条)',
    enum: MembershipType,
    example: MembershipType.SECONDARY,
  })
  @IsEnum(MembershipType)
  membershipType!: MembershipType;

  @ApiPropertyOptional({ description: '编入原因(自由短串,≤200)', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

// PATCH /api/admin/v1/members/:memberId/memberships/:id 入参:改类型 / 任期 / 原因(全可选,至少一项)。
// 不改 status(结束走 DELETE);不改 memberId / organizationId(换组织 = 结束旧 + 新建)。
export class UpdateMembershipDto {
  @ApiPropertyOptional({ description: '归属类型', enum: MembershipType })
  @IsOptional()
  @IsEnum(MembershipType)
  membershipType?: MembershipType;

  @ApiPropertyOptional({ description: '任期起(ISO 8601)' })
  @IsOptional()
  @IsDateString()
  startedAt?: string;

  @ApiPropertyOptional({ description: '任期止(ISO 8601)' })
  @IsOptional()
  @IsDateString()
  endedAt?: string;

  @ApiPropertyOptional({ description: '原因(自由短串,≤200)', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
