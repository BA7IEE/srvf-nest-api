import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SupervisionScopeMode, SupervisionStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString, Length, MaxLength } from 'class-validator';

// 终态 scoped-authz PR5(2026-07-01;冻结稿 §3.5 / §7.4):分管(supervision-assignments)CRUD + 查询 DTO 集合。
// 出参显式列字段(永不含 deletedAt);入参严格白名单(全局 ValidationPipe forbidNonWhitelisted 兜底)。
// status / *ByUserId / 时间戳(除任期)由 service 写;supervisor/org 身份仅 create 传、PATCH 不可改(只改 scopeMode/任期/note)。

// 展示层「谁分管此组织」的覆盖来源(非 DB 字段;直接分管 vs 因祖先 TREE 分管而被覆盖)。
export type SupervisionCoverage = 'DIRECT' | 'INHERITED';

// ============ 出参:分管记录 ============

export class SupervisionAssignmentResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '分管人队员外键(指向 members.id)' })
  supervisorMemberId!: string;

  @ApiProperty({ description: '被分管组织外键(指向 organizations.id)' })
  organizationId!: string;

  @ApiProperty({
    description: '分管范围模式(EXACT 仅该节点 / TREE 含全部下级)',
    enum: SupervisionScopeMode,
    example: SupervisionScopeMode.TREE,
  })
  scopeMode!: SupervisionScopeMode;

  @ApiProperty({
    description: '分管状态(ACTIVE 在任 / ENDED 已结束 / REVOKED 已撤销)',
    enum: SupervisionStatus,
    example: SupervisionStatus.ACTIVE,
  })
  status!: SupervisionStatus;

  @ApiProperty({ description: '分管任期起' })
  startedAt!: Date;

  @ApiPropertyOptional({ description: '分管任期止(为空表示仍在任)', nullable: true })
  endedAt!: Date | null;

  @ApiPropertyOptional({ description: '指派人 userId', nullable: true })
  appointedByUserId!: string | null;

  @ApiPropertyOptional({ description: '撤销人 userId', nullable: true })
  revokedByUserId!: string | null;

  @ApiPropertyOptional({ description: '备注', nullable: true })
  note!: string | null;

  @ApiProperty({ description: '记录创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// ============ 出参:某分管人的分管范围(展开;GET /members/:memberId/supervision-scope) ============

// 一条 active 分管 → 一条 scope 项;TREE 经 organization_closure 展开为「该组织 + 全部后代」,EXACT 仅该节点。
// **展示/报表读 closure,绝非判权**。
export class SupervisionScopeEntryDto {
  @ApiProperty({ description: '来源分管记录 id' })
  supervisionAssignmentId!: string;

  @ApiProperty({ description: '被分管组织 id(scope 根)' })
  organizationId!: string;

  @ApiProperty({
    description: '范围模式(EXACT 仅该节点 / TREE 含全部下级)',
    enum: SupervisionScopeMode,
    example: SupervisionScopeMode.TREE,
  })
  scopeMode!: SupervisionScopeMode;

  @ApiProperty({
    description:
      '展开后覆盖的组织 id 集(EXACT=[organizationId];TREE=organizationId + 全部后代,含自身)',
    type: [String],
  })
  expandedOrganizationIds!: string[];
}

// ============ 出参:某组织被谁分管(GET /organizations/:orgId/supervisors) ============

// 直接分管(该组织本身有 active 分管)+ 继承分管(某祖先有 active TREE 分管而覆盖本组织)。
// **展示读 closure 祖先集,绝非判权**。
export class OrganizationSupervisorDto {
  @ApiProperty({
    description: '覆盖来源(DIRECT 直接分管本组织 / INHERITED 因祖先 TREE 分管而被覆盖)',
    enum: ['DIRECT', 'INHERITED'],
    example: 'DIRECT',
  })
  coverage!: SupervisionCoverage;

  @ApiProperty({ description: '分管记录', type: SupervisionAssignmentResponseDto })
  supervisionAssignment!: SupervisionAssignmentResponseDto;
}

// ============ 入参:建分管(POST /supervision-assignments) ============

// 严格白名单:**禁止** id / status / *ByUserId / 时间戳(除任期)/ deletedAt。
// scopeMode 可空(默认 TREE,沿 schema @default);**不校验 supervisor 是否持职务**(分管与职务正交)。
export class CreateSupervisionAssignmentDto {
  @ApiProperty({
    description: '分管人队员 id(必须存在且 active;不要求持任何职务)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  supervisorMemberId!: string;

  @ApiProperty({
    description: '被分管组织 id(必须存在且 active)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  organizationId!: string;

  @ApiPropertyOptional({
    description: '分管范围模式(默认 TREE 含全部下级;EXACT 仅该节点)',
    enum: SupervisionScopeMode,
    default: SupervisionScopeMode.TREE,
  })
  @IsOptional()
  @IsEnum(SupervisionScopeMode)
  scopeMode?: SupervisionScopeMode;

  @ApiProperty({ description: '分管任期起(ISO 8601;必填)', example: '2026-07-01T00:00:00.000Z' })
  @IsDateString()
  startedAt!: string;

  @ApiPropertyOptional({
    description: '分管任期止(ISO 8601;可空;有值须晚于任期起)',
    example: '2027-06-30T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  endedAt?: string;

  @ApiPropertyOptional({ description: '备注(自由短串,≤200)', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

// ============ 入参:改分管(PATCH /supervision-assignments/:id) ============

// 只改 scopeMode / 任期 / note;**不可改** supervisor / organization(正交身份不变,换分管人=撤旧建新)。
export class UpdateSupervisionAssignmentDto {
  @ApiPropertyOptional({
    description: '分管范围模式(EXACT 仅该节点 / TREE 含全部下级)',
    enum: SupervisionScopeMode,
  })
  @IsOptional()
  @IsEnum(SupervisionScopeMode)
  scopeMode?: SupervisionScopeMode;

  @ApiPropertyOptional({ description: '分管任期起(ISO 8601)', example: '2026-07-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  startedAt?: string;

  @ApiPropertyOptional({
    description: '分管任期止(ISO 8601;有值须晚于任期起)',
    example: '2027-06-30T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  endedAt?: string;

  @ApiPropertyOptional({ description: '备注(自由短串,≤200)', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
