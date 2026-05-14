import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, Length, MaxLength } from 'class-validator';

// V2.x C-6 RBAC 实施 PR #4:RolePermission 模块入参 DTO。
// 沿 D7 v1.1 §5.2.3(AssignRolePermissionsDto)+ 用户拍板。
//
// **入参字段**:沿 D7 §5.2.3 锁定 `permissionCodes: string[]`(权限点 code 字符串数组,
// 不用 permissionIds);Service 内部用 code 查 permission.id 后批量写入。
//
// **幂等策略**(用户拍板):重复授权静默跳过,整体返成功(沿 prisma createMany skipDuplicates)。

export class AssignRolePermissionsDto {
  @ApiProperty({
    description:
      '权限点 code 数组(沿 D7 v1.1 §5.2.3;非 permissionIds;Service 内部按 code 查 permission.id 后批量写入);' +
      '重复授权幂等成功(已存在的 (roleId, permissionId) 关系静默跳过)',
    type: [String],
    example: ['attachment.upload.cert', 'attachment.view.cert'],
    minItems: 1,
    maxItems: 100,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  permissionCodes!: string[];
}

// DELETE 路径双 cuid 校验 — 沿 IdParamDto 范式,加一个字段 `permissionId`。
// 不复用 IdParamDto 是因为 NestJS @Param() 取整体时,DTO 字段必须与路径参数全集对齐;
// IdParamDto 只声明 `id` 一个字段,ValidationPipe forbidNonWhitelisted 会拒绝 `permissionId`。
export class RevokeRolePermissionParamDto {
  @ApiProperty({
    description: '角色 id(cuid 字符串)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64, { message: 'id 必须是 8-64 位字符串' })
  id!: string;

  @ApiProperty({
    description: '权限点 id(cuid 字符串;**非** code)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64, { message: 'permissionId 必须是 8-64 位字符串' })
  permissionId!: string;
}
