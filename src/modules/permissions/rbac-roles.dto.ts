import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { PermissionResponseDto } from './permissions.dto';
import {
  BINDING_MANAGEMENT_MODES,
  PERMISSION_MANAGEMENT_MODES,
  ROLE_KINDS,
} from './role-classification';
import type {
  BindingManagementMode,
  PermissionManagementMode,
  RoleKind,
} from './role-classification';

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

  @ApiProperty({
    description:
      '权限集版本号(P1-32 PR 4a;从 0 起,每次**成功且有实际变化**的权限集写入 +1)。' +
      '`PUT /api/system/v1/roles/{id}/permissions` 的 `expectedRevision` 用它做乐观并发校验:' +
      '取回本值 → 编辑 → 带着它提交;期间被别人改过就返 30111,不会覆盖对方的改动。' +
      '⚠️ 与 `updatedAt` 不是一回事:改角色显示名会动 `updatedAt`,**不**动本值;' +
      '权限集空转(目标集合与现状相同)两者都不动。',
    example: 3,
  })
  permissionRevision!: number;

  @ApiProperty({ description: '创建时间' })
  createdAt!: Date;

  @ApiProperty({ description: '更新时间' })
  updatedAt!: Date;

  // ===== P1-32 PR 2(2026-08-24):角色分类三字段(冻结稿 §6.1 / §6.3)=====
  //
  // 🔴 **additive** —— 上面的字段一个没删、没改类型、没改可空性;本段只往后**加**三个必填字段。
  //    契约语义门对「新增响应字段」判 ADD(见 scripts/contract-semantic-diff.ts 的 breaking 判定表:
  //    必填性只在**请求**侧算 breaking,响应侧新增恒 additive)⇒ 旧前端零影响。
  //
  // 🔴 **派生,不是 DB 列** —— 冻结稿 §6.3 标题逐字「不必立即给 Role 表增加 kind 字段」。
  //    值由 `classifyRole(code)` 从正在执法的谓词算出,`RbacRole` 表没有对应列,
  //    也就不存在「把 DB 里的 kind 改成 CUSTOM 来逃逸保护」这条路。详见 role-classification.ts。

  @ApiProperty({
    description:
      '角色类型。`SYSTEM` = 15 个内建角色之一(seed 维护,运行时删不掉、改不了名);`CUSTOM` = 管理员自建。',
    enum: [...ROLE_KINDS],
    example: 'CUSTOM',
  })
  kind!: RoleKind;

  @ApiProperty({
    description:
      '权限集由谁管。`RELEASE_MANAGED` = 随版本发布走 seed,运行时**任何人**(含 SUPER_ADMIN)加减权限都会被拒(30108);' +
      '`ADMIN_EDITABLE` = 管理员可在后台改。**前端据此把权限编辑器置灰** —— 这就是「系统角色只读状态可被前端识别」的落点。',
    enum: [...PERMISSION_MANAGEMENT_MODES],
    example: 'ADMIN_EDITABLE',
  })
  permissionManagementMode!: PermissionManagementMode;

  @ApiProperty({
    description:
      '角色绑定(谁持有这个角色)由谁管。`SYSTEM_ONLY` = 只能由系统投影器写,人工授予 / 撤销 / 续期一律拒;' +
      '`MANUAL_ALLOWED` = 允许人工绑定。`POLICY_DERIVED`(职务策略派生)**本期不会出现** —— 理由见 role-classification.ts。',
    enum: [...BINDING_MANAGEMENT_MODES],
    example: 'MANUAL_ALLOWED',
  })
  bindingManagementMode!: BindingManagementMode;
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
// (沿 baseline §4.2 + docs/reference/naming-dto-validation.md §11 纵深防御)。
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

// ============ F1/A4 选择器(路线图 §4;D2/D3/D4 拍板)============
//
// 落 system/v1/roles/options(D4:roles 属 System/RBAC 基础设施资源,不与 admin/v1 分裂 surface)。

export class RoleOptionsQueryDto {
  @ApiPropertyOptional({ description: '模糊搜索(跨字段命中 code + displayName)', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ description: '结果条数上限(默认 20,上限 100)', minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class RoleOptionItemDto {
  @ApiProperty({ description: '主键(cuid)' })
  id!: string;

  @ApiProperty({ description: '展示标签(= displayName)' })
  label!: string;

  @ApiProperty({ description: '角色 code' })
  code!: string;
}

export class RoleOptionsResponseDto {
  @ApiProperty({ description: '结果列表(不分页,受 limit 截断)', type: () => [RoleOptionItemDto] })
  items!: RoleOptionItemDto[];
}
