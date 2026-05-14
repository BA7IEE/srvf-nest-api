import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, MaxLength, MinLength } from 'class-validator';

// V2.x C-6 RBAC 实施 PR #5:UserRole 模块 DTO。
// 沿 D7 v1.1 §5.2.4(AssignUserRoleDto)+ §5.2.6(UserRoleResponseDto)+ 用户拍板。
//
// **POST 入参**:沿 D7 §5.2.4 锁定 `roleCode: string`(单个 code,非数组;与 RolePermission
// 批量授权不同 — 单次单角色,简化语义,重复分配明确报 30006 而非幂等)。
//
// **出参字段集**:沿 D7 §5.2.6 锁定 `id` / `roleId` / `roleCode` / `roleDisplayName` /
// `createdAt` / `createdByUserId`(扁平化设计,前端一次拿到角色基础信息无需二次查 role)。

// ============ 出参 ============

export class UserRoleResponseDto {
  @ApiProperty({ description: '主键(UserRole.id;cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({ description: '角色 id(RbacRole.id;cuid)' })
  roleId!: string;

  @ApiProperty({ description: '角色 code(扁平化;沿 D7 §5.2.6)', example: 'apd-chief' })
  roleCode!: string;

  @ApiProperty({ description: '角色显示名(扁平化;沿 D7 §5.2.6)', example: '部门部长' })
  roleDisplayName!: string;

  @ApiProperty({ description: '关系创建时间' })
  createdAt!: Date;

  @ApiProperty({
    description: '分配人 User.id(沿 D11 audit 字段;可空表示历史 seed 或 createdBy SetNull)',
    nullable: true,
    type: String,
  })
  createdByUserId!: string | null;
}

// ============ 入参 ============

export class AssignUserRoleDto {
  @ApiProperty({
    description: '角色 code(沿 D7 §5.2.4 锁定 roleCode;不用 roleId — Service 内部 code→id 转换)',
    example: 'apd-chief',
    minLength: 1,
    maxLength: 33,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(33)
  roleCode!: string;
}

// DELETE 路径双 cuid 校验(沿 PR #4 RevokeRolePermissionParamDto 范式)。
export class RevokeUserRoleParamDto {
  @ApiProperty({
    description: '用户 id(User.id;cuid)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64, { message: 'userId 必须是 8-64 位字符串' })
  userId!: string;

  @ApiProperty({
    description: '角色 id(RbacRole.id;cuid;**非** roleCode)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64, { message: 'roleId 必须是 8-64 位字符串' })
  roleId!: string;
}

// GET / POST 路径单 cuid 校验(:userId)。
// 不复用 IdParamDto(其字段是 `id`;路径参数是 `:userId`,DTO 字段必须与路径参数对齐)。
export class UserIdParamDto {
  @ApiProperty({
    description: '用户 id(User.id;cuid)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64, { message: 'userId 必须是 8-64 位字符串' })
  userId!: string;
}
