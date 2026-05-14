import { ApiProperty } from '@nestjs/swagger';

// V2.x C-6 RBAC 实施 PR #6:RBAC me/permissions 出参 DTO。
// 沿 D7 v1.1 §5.2.6 `MyPermissionsResponseDto` + §5.3 详解。
//
// **本 PR 仅承载端点 15**(`GET /api/v2/rbac/me/permissions`);
// 端点 16 `POST /api/v2/rbac/reload` 留 PR #7,DTO 暂不在本文件落地。
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
