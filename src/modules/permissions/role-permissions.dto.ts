import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Length,
  MaxLength,
  Min,
} from 'class-validator';

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

// P1-32 PR 4a(2026-08-23):整集替换入参。
//
// **与 `AssignRolePermissionsDto` 的两处刻意差异**:
//   ① `@ArrayMinSize` **没有** —— 空数组是合法目标集(= 清空该角色的全部权限点)。
//      整集替换若不许传空,「把权限收干净」就只能靠逐条 DELETE,那正是本刀要收掉的多写入口。
//   ② `expectedRevision` **必填,不设默认值**。设成选填等于给调用方留一条
//      「不带版本号 = 无脑覆盖」的裸奔路 —— 那就是本仓反复吃亏的「一侧有闸、另一侧没有」形状
//      (E-B1 #1115 / E-B2 同族)。版本号从任一返回 `RbacRoleResponseDto` 的接口取。
export class ReplaceRolePermissionsDto {
  @ApiProperty({
    description:
      '目标权限点 code 全集(整集替换语义:提交后该角色的权限**恰好**是这些)。' +
      '传 `[]` = 清空全部权限点。与 POST 的增量语义不同,不在本数组里的既有权限点会被撤销。',
    type: [String],
    example: ['attachment.upload.cert', 'attachment.view.cert'],
    minItems: 0,
    maxItems: 100,
  })
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  permissionCodes!: string[];

  @ApiProperty({
    description:
      '客户端读到的权限集版本号(`RbacRoleResponseDto.permissionRevision`)。' +
      '与库中当前值不符 → 30111,整批拒绝、一个字节都不写。**必填**。',
    example: 3,
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  expectedRevision!: number;
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
