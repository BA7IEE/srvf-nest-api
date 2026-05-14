import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';

// V2.x C-6 RBAC 实施 PR #6 + PR #7:RBAC 端点 15 + 16 共用 DTO 集中点。
// 沿 D7 v1.1 §5.2.5 ReloadRbacDto + §5.2.6 MyPermissionsResponseDto + §5.3 + §5.4 详解。
//
// **PR #6 端点 15**(`GET /api/v2/rbac/me/permissions`):MyPermissionsResponseDto + EffectiveRoleDto
// **PR #7 端点 16**(`POST /api/v2/rbac/reload`):ReloadRbacDto + ReloadRbacResponseDto
//
// **`permissions` 字段语义**(沿用户拍板方案 B):
// - 普通角色 / ADMIN / USER:返回 user_roles → role_permissions → permissions 聚合后的 code 集
// - **SUPER_ADMIN**:返回 DB 中 `Permission.code` 全集(短路语义实体化,前端按 string 集合判定)
// - 任一情况均为 string[],**不**用 `["*"]` 通配符,**不**返回空数组(SUPER_ADMIN 也会有内容)
//
// **`effectiveRoles` 字段语义**:
// - 仅查 user_roles → RbacRole(deletedAt=null)聚合
// - SUPER_ADMIN 不特判 — 若 SUPER_ADMIN 未持任何 RBAC 角色,本字段返空数组(SUPER_ADMIN 的"系统级身份"通过 v1 `user.role` 表达,不在 effectiveRoles 里复述)

// 当前用户持有的 RBAC 业务角色摘要(沿 D7 §5.2.6 嵌套结构;不复用 RbacRoleResponseDto
// 避免对外暴露 id / description / createdAt / updatedAt 等无关字段)
export class EffectiveRoleDto {
  @ApiProperty({ description: '角色 code(RbacRole.code)', example: 'apd-chief' })
  code!: string;

  @ApiProperty({ description: '角色显示名', example: '部门部长' })
  displayName!: string;
}

export class MyPermissionsResponseDto {
  @ApiProperty({
    description:
      '当前用户的有效权限点 code 集合(沿 D7 v1.1 §5.3)。' +
      'SUPER_ADMIN 返回 Permission.code 全集(短路语义实体化);其它角色返回聚合后的并集。',
    type: [String],
    example: ['rbac.role.read', 'attachment.upload.cert'],
  })
  permissions!: string[];

  @ApiProperty({
    description: '当前用户持有的 RBAC 业务角色(已排除软删角色;SUPER_ADMIN 未持任何角色时为空数组)',
    type: [EffectiveRoleDto],
  })
  effectiveRoles!: EffectiveRoleDto[];
}

// ============ PR #7 端点 16 reload ============
//
// 沿 D7 v1.1 §5.2.5 / §5.4 / F4(v1.0 锁定):
// - scope 三档:'all'(默认)/ 'user'(配 userId)/ 'role'(配 roleId)
// - userId / roleId 在 DTO 层标 @IsOptional;**Service 层做组合校验**:
//     scope='user' 必须有 userId、scope='role' 必须有 roleId,否则 BAD_REQUEST(40000)
// - userId / roleId 不存在 → Service 静默成功(reload 是"清缓存"语义,与 v1 §10
//     信息泄漏防御一致)
// - 沿用户拍板:本 PR 权限入口为 `@Roles(SUPER_ADMIN, ADMIN)`,**不接 `rbac.can()`**;
//   D7 §5.4 中标的 `rbac.config.reload` 权限点,留 PR #8 seed + 后续 PR 接业务判权时一并接入。

export const RELOAD_RBAC_SCOPES = ['all', 'user', 'role'] as const;
export type ReloadRbacScope = (typeof RELOAD_RBAC_SCOPES)[number];

export class ReloadRbacDto {
  @ApiPropertyOptional({
    description: 'reload 范围;默认 all',
    enum: RELOAD_RBAC_SCOPES,
    example: 'all',
  })
  @IsOptional()
  @IsIn(RELOAD_RBAC_SCOPES)
  scope?: ReloadRbacScope;

  @ApiPropertyOptional({
    description: 'scope=user 时必传:目标用户 id(cuid)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  userId?: string;

  @ApiPropertyOptional({
    description: 'scope=role 时必传:目标 RbacRole.id(cuid)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  roleId?: string;
}

// 出参(沿用户拍板方案 A):固定 `{ reloaded: true }`;为未来扩展字段预留单对象包装。
export class ReloadRbacResponseDto {
  @ApiProperty({
    description:
      'reload 是否成功;reload 是"尽力清缓存"语义,DB 故障由后端 logger 暴露给运维,本字段对外恒为 true',
    example: true,
  })
  reloaded!: true;
}
