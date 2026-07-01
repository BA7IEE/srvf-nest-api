import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AssignmentStatus } from '@prisma/client';
import { IsBoolean, IsDateString, IsOptional, IsString, Length, MaxLength } from 'class-validator';

// 终态 scoped-authz PR4(2026-07-01;冻结稿 §3.4 / §7.3):任职(position-assignments)CRUD DTO 集合。
// 出参显式列字段(永不含 deletedAt);入参严格白名单(全局 ValidationPipe forbidNonWhitelisted 兜底)。
// organizationId 由组织轴路径参数 :orgId 提供,**不**进 body;status / *ByUserId / 时间戳(除任期)由 service 写。

// ============ 出参 ============

export class PositionAssignmentResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '组织节点外键(指向 organizations.id)' })
  organizationId!: string;

  @ApiProperty({ description: '职务定义外键(指向 organization_positions.id)' })
  positionId!: string;

  @ApiProperty({ description: '队员外键(指向 members.id)' })
  memberId!: string;

  @ApiProperty({
    description: '任职状态(ACTIVE 在任 / ENDED 已结束 / REVOKED 已撤销)',
    enum: AssignmentStatus,
    example: AssignmentStatus.ACTIVE,
  })
  status!: AssignmentStatus;

  @ApiProperty({ description: '任期起' })
  startedAt!: Date;

  @ApiPropertyOptional({ description: '任期止(为空表示仍在任)', nullable: true })
  endedAt!: Date | null;

  @ApiPropertyOptional({ description: '任命人 userId', nullable: true })
  appointedByUserId!: string | null;

  @ApiPropertyOptional({ description: '撤销人 userId', nullable: true })
  revokedByUserId!: string | null;

  @ApiPropertyOptional({
    description: '任命来源(announcement-2026 / manual / import)',
    nullable: true,
  })
  appointmentSource!: string | null;

  @ApiProperty({ description: '兼任标记(回填公告"（兼）";不影响授权)', example: false })
  isConcurrent!: boolean;

  @ApiPropertyOptional({ description: '备注', nullable: true })
  note!: string | null;

  @ApiProperty({ description: '记录创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// ============ 入参:任命(POST /organizations/:orgId/position-assignments) ============

// 严格白名单:**禁止** organizationId(由路径 :orgId 提供)/ id / status / *ByUserId / 时间戳(除任期)/ deletedAt。
export class CreatePositionAssignmentDto {
  @ApiProperty({
    description: '职务定义 id(必须存在;org 类别须有对应 active 职务规则)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  positionId!: string;

  @ApiProperty({
    description: '被任命队员 id(必须存在)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  memberId!: string;

  @ApiProperty({ description: '任期起(ISO 8601;必填)', example: '2026-07-01T00:00:00.000Z' })
  @IsDateString()
  startedAt!: string;

  @ApiPropertyOptional({
    description: '任期止(ISO 8601;可空;有值须晚于任期起)',
    example: '2027-06-30T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  endedAt?: string;

  @ApiPropertyOptional({
    description: '兼任标记(回填公告"（兼）";默认 false;不影响授权)',
  })
  @IsOptional()
  @IsBoolean()
  isConcurrent?: boolean;

  @ApiPropertyOptional({
    description: '任命来源(自由短串,如 manual / import / announcement-2026)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  appointmentSource?: string;

  @ApiPropertyOptional({ description: '备注(自由短串,≤200)', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
