import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { PermissionResponseDto } from './permissions.dto';

// V2.x C-6 RBAC 实施 PR #3:RbacRole 模块 DTO 集合。
// 沿 D7 v1.1 §5.2.2(CreateRoleDto)+ §5.2.6(RoleResponseDto)+ §4.1(RbacRole schema)。
//
// **code 格式校验铁律**(D7 v1.1 §5.2.2 + F7 v1.0 锁定):
// - 正则 `/^[a-z][a-z0-9-]{2,32}$/`:首字母小写 + [a-z0-9-];长度 3-33(@Matches 含首字母,@MinLength(3) 配合)
// - DTO 层只做基础字符串 + 长度校验(@IsString + @MinLength(3) + @MaxLength(33))
// - **不在 DTO 写 @Matches**(沿 permissions 30008 实装范式):
//   把格式校验留给 Service 层显式 regex 检查 + 抛 BizException(BizCode.INVALID_ROLE_CODE_FORMAT)(30009),
//   让本 BizCode 真正可触发并被 e2e 覆盖
//
// **PATCH 字段白名单**(纵深防御,沿 baseline §4.2):
// - UpdateRbacRoleDto 仅允许 displayName / description
// - 严禁 code(业务标识不可改;角色重命名走 DELETE+POST)/ id / createdAt / updatedAt / deletedAt

// ============ 出参 ============

export class RbacRoleResponseDto {
  @ApiProperty({ description: '主键(cuid)', example: 'cl9z3a8b00000abcd1234efgh' })
  id!: string;

  @ApiProperty({
    description: '角色 code(kebab-case,3-32 字符;沿 D7 v1.1 F7;详见 service regex 校验)',
    example: 'apd-chief',
  })
  code!: string;

  @ApiProperty({ description: '显示名(真实名走 .env.seed.local;F6 / R13)', example: '部门部长' })
  displayName!: string;

  @ApiPropertyOptional({ description: '角色用途说明(可空)' })
  description?: string | null;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;
}

// detail 接口额外含 permissions 数组(沿 D7 v1.1 §5.2.6)。
// 即使未分配任何权限(或 RolePermission CRUD 尚未实施),也返回稳定的空数组 [],
// 不返回 undefined,保证前端契约稳定(沿 V2 §3.1 PageResultDto 范式)。
export class RbacRoleDetailResponseDto extends RbacRoleResponseDto {
  @ApiProperty({
    description: '该角色已分配的权限点列表(为空时返 [];RolePermission CRUD 实装前永远空)',
    type: [PermissionResponseDto],
  })
  permissions!: PermissionResponseDto[];
}

// ============ 入参 ============

export class CreateRbacRoleDto {
  @ApiProperty({
    description:
      'code(kebab-case,3-32 字符;首字母小写 + [a-z0-9-];沿 D7 v1.1 F7;详见 service 层 regex 校验 / 失败抛 30009)',
    example: 'apd-chief',
    minLength: 3,
    maxLength: 33,
  })
  @IsString()
  @MinLength(1)
  // DTO 层 @MaxLength 设宽(>33),让所有 F7 范围外格式都到 Service regex 校验 + 抛 30009;
  // 若放 DTO @MaxLength(33),"太长"会被 DTO 走通用 BAD_REQUEST(40000),30009 不触发。
  @MaxLength(100)
  code!: string;

  @ApiProperty({ description: '显示名', example: '部门部长', maxLength: 50 })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  displayName!: string;

  @ApiPropertyOptional({ description: '描述(可空)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

// PATCH 仅允许 displayName / description;严禁 code / id / createdAt / updatedAt / deletedAt
// (沿 baseline §4.2 + CLAUDE.md §11 纵深防御)。
export class UpdateRbacRoleDto {
  @ApiPropertyOptional({ description: '显示名', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  displayName?: string;

  @ApiPropertyOptional({ description: '描述(可空)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class ListRbacRolesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按 code 模糊匹配(contains)', example: 'apd' })
  @IsOptional()
  @IsString()
  @MaxLength(33)
  code?: string;
}
