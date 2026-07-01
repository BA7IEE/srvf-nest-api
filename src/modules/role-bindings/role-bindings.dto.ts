import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BindingScopeType, BindingStatus, PrincipalType } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString, Length, MaxLength } from 'class-validator';

// 终态 scoped-authz PR6(2026-07-01;冻结稿 §3.6 / §7.5):带 scope 的角色绑定(role-bindings)CRUD + 查询 DTO 集合。
// 出参显式列字段(永不含 deletedAt);入参严格白名单(全局 ValidationPipe forbidNonWhitelisted 兜底)。
// **🔴 scoped 绑定入库即止,RbacService 只读 scopeType=GLOBAL、绝不判 scoped**(判权是 PR8 AuthzService)。
// principalId 多态无 FK;scopeType↔scope 字段一致性 / principalType↔principalId 一致性由 service 校验。

// ============ 出参:角色绑定记录 ============

export class RoleBindingResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({
    description: '主体类型(USER / MEMBER / POSITION_ASSIGNMENT / SYSTEM)',
    enum: PrincipalType,
    example: PrincipalType.USER,
  })
  principalType!: PrincipalType;

  @ApiPropertyOptional({
    description: '主体 id(多态,随 principalType 指 user/member/position_assignment;SYSTEM 时可空)',
    nullable: true,
  })
  principalId!: string | null;

  @ApiProperty({ description: '角色外键(指向 roles.id)' })
  roleId!: string;

  @ApiProperty({
    description:
      'scope 类型(GLOBAL 全局 / ORGANIZATION 单组织 / ORGANIZATION_TREE 组织子树 / ACTIVITY 活动 / RESOURCE 资源 / SELF 本人)',
    enum: BindingScopeType,
    example: BindingScopeType.GLOBAL,
  })
  scopeType!: BindingScopeType;

  @ApiPropertyOptional({
    description: 'scope 组织 id(ORGANIZATION / ORGANIZATION_TREE 时有值)',
    nullable: true,
  })
  scopeOrgId!: string | null;

  @ApiPropertyOptional({ description: 'scope 活动 id(ACTIVITY 时有值)', nullable: true })
  scopeActivityId!: string | null;

  @ApiPropertyOptional({
    description: 'scope 资源类型(RESOURCE 时有值,如 attendance_sheet)',
    nullable: true,
  })
  scopeResourceType!: string | null;

  @ApiPropertyOptional({ description: 'scope 资源 id(RESOURCE 时有值)', nullable: true })
  scopeResourceId!: string | null;

  @ApiProperty({
    description: '绑定状态(ACTIVE 生效 / ENDED 已结束 / SUSPENDED 挂起)',
    enum: BindingStatus,
    example: BindingStatus.ACTIVE,
  })
  status!: BindingStatus;

  @ApiProperty({ description: '任期起' })
  startedAt!: Date;

  @ApiPropertyOptional({
    description: '任期止(为空表示无期限;过期不授权由 PR8 判)',
    nullable: true,
  })
  endedAt!: Date | null;

  @ApiPropertyOptional({ description: '创建人 userId', nullable: true })
  createdByUserId!: string | null;

  @ApiPropertyOptional({ description: '备注', nullable: true })
  note!: string | null;

  @ApiProperty({ description: '记录创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// ============ 入参:列出角色绑定(GET /role-bindings)过滤 ============

// 全部可空过滤条件(principalType × principalId × role × scopeType × status);默认返回全部未软删绑定。
export class ListRoleBindingsQueryDto {
  @ApiPropertyOptional({ description: '按主体类型过滤', enum: PrincipalType })
  @IsOptional()
  @IsEnum(PrincipalType)
  principalType?: PrincipalType;

  @ApiPropertyOptional({ description: '按主体 id 过滤', minLength: 1, maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  principalId?: string;

  @ApiPropertyOptional({ description: '按角色 id 过滤', minLength: 8, maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  roleId?: string;

  @ApiPropertyOptional({ description: '按 scope 类型过滤', enum: BindingScopeType })
  @IsOptional()
  @IsEnum(BindingScopeType)
  scopeType?: BindingScopeType;

  @ApiPropertyOptional({ description: '按绑定状态过滤', enum: BindingStatus })
  @IsOptional()
  @IsEnum(BindingStatus)
  status?: BindingStatus;
}

// ============ 入参:建角色绑定(POST /role-bindings) ============

// 严格白名单:**禁止** id / createdByUserId / 时间戳(除任期)/ deletedAt。
// scope 字段与 scopeType 的一致性、principalId 与 principalType 的一致性、被引用实体存在性均由 service 校验。
export class CreateRoleBindingDto {
  @ApiProperty({
    description: '主体类型(USER / MEMBER / POSITION_ASSIGNMENT / SYSTEM)',
    enum: PrincipalType,
    example: PrincipalType.USER,
  })
  @IsEnum(PrincipalType)
  principalType!: PrincipalType;

  @ApiPropertyOptional({
    description: '主体 id(非 SYSTEM 必填;多态,随 principalType 指 user/member/position_assignment)',
    minLength: 1,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  principalId?: string;

  @ApiProperty({ description: '角色 id(RbacRole.id;须存在且未软删)', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  roleId!: string;

  @ApiProperty({
    description:
      'scope 类型(GLOBAL / ORGANIZATION / ORGANIZATION_TREE / ACTIVITY / RESOURCE / SELF)',
    enum: BindingScopeType,
    example: BindingScopeType.GLOBAL,
  })
  @IsEnum(BindingScopeType)
  scopeType!: BindingScopeType;

  @ApiPropertyOptional({
    description: 'scope 组织 id(ORGANIZATION / ORGANIZATION_TREE 必填,须存在)',
    minLength: 8,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  scopeOrgId?: string;

  @ApiPropertyOptional({
    description: 'scope 活动 id(ACTIVITY 必填,须存在)',
    minLength: 8,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  scopeActivityId?: string;

  @ApiPropertyOptional({
    description: 'scope 资源类型(RESOURCE 必填,如 attendance_sheet)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  scopeResourceType?: string;

  @ApiPropertyOptional({ description: 'scope 资源 id(RESOURCE 必填)', minLength: 1, maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  scopeResourceId?: string;

  @ApiPropertyOptional({
    description: '任期起(ISO 8601;可空,默认建立时刻)',
    example: '2026-07-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  startedAt?: string;

  @ApiPropertyOptional({
    description: '任期止(ISO 8601;可空;有值须晚于任期起;过期不授权由 PR8 判)',
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

// ============ 入参:改角色绑定(PATCH /role-bindings/:id) ============

// 只改状态 / 任期 / note;**不可改** principalType / principalId / roleId / scope(绑定身份不变,换绑定=软删旧建新)。
export class UpdateRoleBindingDto {
  @ApiPropertyOptional({
    description: '绑定状态(ACTIVE 生效 / ENDED 已结束 / SUSPENDED 挂起)',
    enum: BindingStatus,
  })
  @IsOptional()
  @IsEnum(BindingStatus)
  status?: BindingStatus;

  @ApiPropertyOptional({ description: '任期起(ISO 8601)', example: '2026-07-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  startedAt?: string;

  @ApiPropertyOptional({
    description: '任期止(ISO 8601;有值须晚于任期起)',
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
